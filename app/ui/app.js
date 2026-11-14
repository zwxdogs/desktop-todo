/* 桌面待办 0.4.1 主窗口逻辑。
   与 todo.pyw (0.2.7) 逐函数对应，注释标注 Tk 源行号供 parity 审查。
   纯函数来自 md.js（blockEnd/canMove/moveBlock 为 0.4.0 拖动排序新增），撤销栈来自 undo.js。
   0.4.0 新增：拖动排序（Tk 0.2.7 没有，属 Tauri 侧扩展，两窗口各自窗口内）。
   0.4.1：页面不再滚动，#list 自己滚并挂自绘滚动条（scrollbar.js）；滚动位置改在 #list 上存取。
   入口是 ES module（import 需要真实 ESM；经典 script 会因 export 语法整体失效）。 */
'use strict';

import * as md from './md.js';
import { createList } from './list.js';
import { starterText, missingHint } from './starter.js';
import { attachScrollbar } from './scrollbar.js';
import { plusButton } from './plus.js';
import { readIdentity } from './identity.js';
import { createRowDrag, mainDropTarget, GRIP_SVG } from './rowdrag.js';
import { createMenu } from './rowmenu.js';
import { openRowEdit } from './rowedit.js';
import { connect, MAIN, requireHost } from './panelproto.js';

window.addEventListener('error', (ev) => {
  try {
    window.__TAURI__.core.invoke('log_line', {
      msg: `js error: ${ev.message} @${ev.filename}:${ev.lineno}:${ev.colno}`,
    });
  } catch (_) { /* ignore */ }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    window.__TAURI__.core.invoke('log_line', { msg: `js rejection: ${ev.reason}` });
  } catch (_) { /* ignore */ }
});

/* 宿主对象由 Tauri 的初始化脚本在页面脚本**之前**写好（withGlobalTauri），
   所以取一次就够：取不到是真的没注入，requireHost 当场抛错（#16，不再惰性重试）。 */
let HOST = null;
function host() {
  if (!HOST) HOST = requireHost();
  return HOST;
}
const invoke = (cmd, args) => host().core.invoke(cmd, args || {});

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const titleEl = $('title');
const menuEl = $('menu');
let mainScroll = null;   // 自绘滚动条（0.4.1；bindChrome 里挂到 listEl 上）

const S = {
  lines: [],       // 清单模块那份数组的镜像：每次重绘前由 render 钩子同步
  file: '',        // 最近一次从 Rust 命令采纳的路径：只原样转发给文件类命令，不自己拼
  title: '',       // 与 file 同时采纳的顶栏标题；装载成功后由 loadFile 落字（错误提示只是临时覆盖）
  lastSeen: null,
  docked: false,   // ADR 0004：false = 普通窗口（默认）；true = 固定在桌面（无任务栏图标）
  missingShown: false,
  loaded: false,   // 内存里的清单是否来自一次成功的读取；没装载成功就不许写盘（否则等于清空文件）
  edit: null,            // { index, input, handle }
  panelOpen: false,
  panelEditing: false,   // 面板窗口里有未提交编辑
  quitting: false,
};

/* 清单模块（list.js）：清单的唯一变更入口。八个意图在那边各有唯一实现，撤销栈、
   写盘合并窗口、面板锚点、行保真都在模块内部；这里只提供窗口自己的四件事：
   变更前收掉编辑框/面板、重绘、写盘、回执。换行符与 BOM 也由模块持有。 */
const list = createList({
  hooks: {
    before: listBefore,
    render: (lines) => { S.lines = lines; renderList(); },
    write: (text) => writeText(text),
    afterSave: (ok, n, err) => {
      if (ok) log(`saved ${n} lines`);
      else log(`save failed: ${err}`);
    },
    onSnapshot: hideToast,
  },
});

/* 界面心跳（ADR 0008）：Rust 侧看门狗靠它判断界面还活着，白屏就自动 reload 自救。
   定时器在模块顶层就开——boot 卡住也还在发，只有页面/进程真死才会断。 */
let uiReady = false;
setInterval(() => { invoke('heartbeat', { ready: uiReady }).catch(() => {}); }, 1000);

const ROWS = new Map();  // i -> { row, label, box }

const VIS = [];          // 可拖行（分组标题 / 待办）按文档顺序：[{ i, el }]

/* 行交互（#15）：指针、拖影、插入线、自动滚、落点求解、行菜单、内联编辑都收进共享模块，
   这里只剩主窗口的政策——哪一行能拖、能不能插进这个分组、落点怎么落回清单下标。 */
const drag = createRowDrag({
  container: listEl,
  token: () => S.lines,
  rows: () => VIS.map((v) => ({ key: v.i, el: v.el })),
  canStart: () => !S.missingShown,
  ghost: (key) => {
    const ln = S.lines[key];
    const [todos, , notes] = ln.kind === 'todo' ? md.subtreeStats(S.lines, key) : [0, 0, 0];
    return { text: ln.text || '（空）', count: todos + notes, header: ln.kind === 'header' };
  },
  resolve: (rows, y, from) => mainDropTarget(S.lines, rows, y, from),
  stale: (token) => S.lines !== token,
  onStart: () => closeEditor(),
  onDrop: (from, target) => {
    // 落点自带 slot：末端之后可能是没进 rows 的隐藏行，不能再用 rowKey 反推。
    if (list.move(from, target.slot)) log(`drag move ${from} -> ${target.slot}`);
  },
});

const menu = createMenu(menuEl);

/* ---------- 基础设施 ---------- */

function log(msg) { invoke('log_line', { msg: String(msg) }); }

/* 标题被 ellipsis 截断时，悬停由 title 属性给出完整文件名（Tk 用 winfo 无此需求，0.4.x 新增）。
   保存/新建失败时 setTitle('…失败!') 会连 tooltip 一起变成提示语——可接受的临时副作用，
   下一次装载成功会从 S.title 恢复（S.title 也只来自 Rust 命令回传）。 */
function setTitle(t) { titleEl.textContent = t; titleEl.title = t; }

/* 采纳 Rust 回传的文件身份（app_info / choose_file / new_md_file）。身份只在 Rust 侧产生
   （Shared.file）；这里存下的 file 只是最近一次回传的投影：原样转发给文件类命令，不自己
   拼路径、不派生标题（#12）。readIdentity 先把字段逐个验过，读不到就抛错（不再静默回退）。
   标题先不进界面——loadFile 读成功了才落字，免得新文件名配着旧文件的清单一起显示。 */
function adoptFile(raw) {
  const identity = readIdentity(raw);
  S.file = identity.file;
  S.title = identity.title;
}

async function statNow() {
  try {
    const st = await invoke('file_state', { file: S.file });   // null = 文件不存在
    return st ? `${st.mtime_ns}:${st.size}` : null;
  } catch (e) {
    log(`stat failed: ${e}`);
    return null;
  }
}

async function fileStateExists() {
  return (await statNow()) !== null;
}

/* Tk write_text(550-563)：Rust 侧负责 BOM/tmp/原子替换/只读警告；
   写成功后 JS 自记 lastSeen（Tk self.last_seen = stat_now()），否则 poll 误报外部变化并清撤销栈 */
async function writeText(content) {
  try {
    const ok = await invoke('write_md', { file: S.file, content, hasBom: list.hasBom() });
    if (ok) S.lastSeen = await statNow();
    return ok;
  } catch (e) {
    log(`write failed: ${e}`);
    return false;
  }
}

/* ---------- 变更前收尾 + 撤销（todo.pyw:1000-1023） ----------
   「变更前要不要收掉编辑框、关掉面板」只在这里决定一次。清单模块每次真变更之前
   都会带着变更描述回调过来，十二处入口不再各自判断。 */
function listBefore(change) {
  const pi = list.panelIndex();   // 面板盯着的那一行；模块是锚的唯一所有者
  if (change.kind === 'remove') {
    // 正在编辑的那行随删除一起消失：不提交，直接丢弃（todo.pyw:953-964）
    if (S.edit && S.edit.index >= change.index && S.edit.index < change.end) discardEditor();
    if (S.panelOpen && pi >= change.index && pi < change.end) closePanel();
  } else if (change.kind === 'deleteCompleted') {
    const covers = (k) => change.blocks.some((b) => b.i <= k && k < b.end);
    // 被删的那行不提交（丢字是用户要的），没被删的先落定，别把打的字丢了
    if (S.edit) { if (covers(S.edit.index)) discardEditor(); else closeEditor(); }
    if (S.panelOpen && pi >= 0 && covers(pi)) closePanel();
  }
}

async function undoNow() {
  hideToast();   // 回执只认「刚删完」那一刻：换了撤销目标就先收掉
  if (S.edit || S.panelEditing) return;
  if (await list.undo()) log(`undo (left ${list.undoSize()} snapshots)`);
  else log('undo save failed');
}

/* ---------- 文件装载（todo.pyw:565-602） ---------- */

/* 缺文件占位（0.4.0）：不再提「右键 → 更换文件…」（那条标题栏菜单已经整块删了），
   改成按顶栏图标的实际顺序报序号，用户照着点就行。序号每次现算，以后调按钮顺序
   这句话会自己跟着变，不会指错地方。0.4.2 起打开/新建合进同一枚下拉，
   starter.js 的 missingHint 只收一个序号，并说明动作在菜单里选。 */
function showMissing() {
  if (S.missingShown) return;
  S.missingShown = true;
  S.loaded = false;
  listEl.textContent = '';
  ROWS.clear();
  VIS.length = 0;
  const btnIdx = (id) => [...document.querySelectorAll('#hdr .hbtn')].indexOf($(id)) + 1;
  const div = document.createElement('div');
  div.className = 'missing';
  // 0.4.2 起打开/新建合在一枚下拉里，所以只报一个序号（starter.js 里说明菜单项）
  div.textContent = missingHint(btnIdx('btn-file'));
  listEl.appendChild(div);
  updateChrome();   // 没有清单可删、没有文件可显示：两枚按钮都得跟着置灰
}

async function loadFile() {
  // 外部改动重载：丢弃尚未落盘的旧内存状态（Tk load_file 同样直接重读，不回写）
  list.cancelSave();
  if (!(await fileStateExists())) {
    showMissing();
    log(`file missing: ${S.file}`);
    return;
  }
  let data;
  try {
    data = await invoke('read_md', { file: S.file });
  } catch (e) {
    // Rust：NotFound → "missing: ..."；其余 read/utf8 错误同样按缺失提示一次
    if (String(e).startsWith('missing')) {
      showMissing();
      log(`file missing: ${S.file}`);
    } else {
      log(`load error: ${e}`);
    }
    return;
  }
  S.loaded = true;
  setTitle(S.title);   // 装载成功 = 回到当前文件名（清掉上一次「新建失败!」之类的临时提示）
  // 整份替换：换行符、BOM、撤销栈都交给清单模块，替换本身不写盘（外部改动重载，Tk 同款）
  list.replaceAll({ lines: md.parseText(data.text), nl: data.nl, hasBom: data.has_bom });
  S.lastSeen = await statNow();
  log(`loaded ${list.lines().length} lines from ${S.file}`);
}

/* ---------- 渲染清单（todo.pyw:605-707） ---------- */

function boxSvg(checked) {
  // Tk draw_box(709-720)：选中=accent 方块+白色圆头折线；未选中=1px #C6CCD4 描边
  if (checked) {
    return '<svg viewBox="0 0 18 18" fill="none">' +
      '<rect x="2" y="2" width="14" height="14" fill="#4A8FE2" stroke="#4A8FE2"/>' +
      '<polyline points="5,9 8,12 13,5" stroke="#FFFFFF" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  }
  return '<svg viewBox="0 0 18 18" fill="none">' +
    '<rect x="2" y="2" width="14" height="14" fill="none" stroke="#C6CCD4" stroke-width="1"/></svg>';
}

function badgeCheckSvg() {
  // Tk _badge_check(786-791)：勾线 (1,9)→(4,12)→(9,5)，画布中心 y=9
  return '<svg class="badge-check" viewBox="0 0 10 18" fill="none">' +
    '<polyline points="1,9 4,12 9,5" stroke="currentColor" stroke-width="1" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function badgeNoteSvg() {
  // Tk _badge_note(793-802)：页框 (1,3)-(9,15) + 两横线 y=6/y=9
  return '<svg class="badge-note" viewBox="0 0 10 18" fill="none">' +
    '<rect x="1" y="3" width="8" height="12" stroke="currentColor" stroke-width="1"/>' +
    '<line x1="3" y1="6" x2="7" y2="6" stroke="currentColor" stroke-width="1"/>' +
    '<line x1="3" y1="9" x2="7" y2="9" stroke="currentColor" stroke-width="1"/></svg>';
}

function makeBadge(td, dn, nt) {
  const b = document.createElement('span');
  b.className = 'badge';
  if (td) {
    b.innerHTML += badgeCheckSvg() + `<span>${dn}/${td}</span>`;
  }
  if (td && nt) {
    const mid = document.createElement('span');
    mid.className = 'mid';
    b.appendChild(mid);
  }
  if (nt) {
    b.innerHTML += badgeNoteSvg() + `<span>${nt}</span>`;
  }
  return b;
}

function renderList(focusIdx) {
  drag.cleanup();           // 重画行之前先收掉拖动浮层（外部重载可能把行换掉）
  const sc = listEl;                   // 0.4.1：滚动容器是 #list（页面本身不再滚）
  const max0 = sc.scrollHeight - sc.clientHeight;
  const frac = max0 > 0 ? sc.scrollTop / max0 : 0;
  closeEditor();                       // 静默提交，不重渲染（todo.pyw:607）
  S.missingShown = false;
  listEl.textContent = '';
  ROWS.clear();
  VIS.length = 0;
  let i = 0;
  let shown = 0;                       // 真的画出来的行数（空行不算）——0 就是空清单
  while (i < S.lines.length) {
    const ln = S.lines[i];
    // 0.4.0：备注只在详情面板里出现；顶格备注行静默隐藏但原样留在文件里。
    if (ln.kind === 'note') { i += 1; continue; }
    buildRow(i, ln);
    if (ln.kind !== 'blank') shown += 1;
    if (ln.kind === 'todo') {
      i = md.subtreeEnd(S.lines, i);   // 待办的整个子块收进详情面板
    } else {
      i += 1;
    }
  }
  // 空清单上没有任何行可以悬停，加号无从发现：用一句灰字把第一步（加分组）指出来。
  if (!shown && S.loaded) addEmptyHint();
  sc.scrollTop = frac * (sc.scrollHeight - sc.clientHeight);
  if (mainScroll) mainScroll.refresh();  // 行数变了：拇指长度要重算（静默，不闪）
  updateChrome();   // 两枚顶栏按钮的置灰与条数跟着清单走
  refreshPanel(focusIdx);              // 主列表是清单渲染的唯一出口
}

function addEmptyHint() {
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.textContent = '右键空白处，添加分组';
  // 只有空行的清单里，上面的 .gap 已经把灰字往下挤了；扣回那段高度，让它在离顶 44px 处
  const gaps = S.lines.reduce((n, ln) => n + (ln.kind === 'blank' ? 1 : 0), 0);
  hint.style.marginTop = `${Math.max(8, 44 - gaps * 8)}px`;
  listEl.appendChild(hint);
}

function buildRow(i, ln) {
  if (ln.kind === 'blank') {
    const gap = document.createElement('div');
    gap.className = 'gap';
    bindBlankContext(gap);
    listEl.appendChild(gap);
    return;
  }
  let pad = 16 + Math.min(md.indentUnits(ln.indent) * 8, 160);   // todo.pyw:643
  const row = document.createElement('div');
  row.className = `row row-${ln.kind}`;
  bindBlankContext(row);               // 行内边距的空白也算空白处（todo.pyw:646）
  const info = { row, label: null, box: null };

  if (ln.kind === 'header') {
    row.style.setProperty('--pad', `${pad}px`);   // label 与编辑框共用缩进
    const lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = ln.text;
    lbl.addEventListener('dblclick', () => editRow(i));
    bindRowMenu(lbl, i);
    row.appendChild(lbl);
    info.label = lbl;
  } else {
    let badgeParts = null;
    if (ln.kind === 'todo') {
      const box = document.createElement('span');
      box.className = 'box';
      box.innerHTML = boxSvg(ln.checked);
      box.style.marginLeft = `${pad}px`;
      box.addEventListener('click', () => toggleLine(i));
      bindRowMenu(box, i);
      row.appendChild(box);
      info.box = box;
      const [td, dn, nt] = md.subtreeStats(S.lines, i);
      if (td || nt) badgeParts = [td, dn, nt];
    } else if (ln.kind === 'note') {
      pad += 16;
    }
    const lbl = document.createElement('div');
    lbl.className = 'label' + (ln.checked ? ' done' : '');
    lbl.textContent = ln.kind === 'note' ? '• ' + ln.text : ln.text;
    if (ln.kind !== 'todo') lbl.style.paddingLeft = `${pad}px`;
    // 双击待办=开详情面板（todo.pyw:700-704），其余行双击进入内联编辑
    lbl.addEventListener('dblclick', () => (ln.kind === 'todo' ? openPanel(i) : editRow(i)));
    bindRowMenu(lbl, i);
    row.appendChild(lbl);
    info.label = lbl;
    // Tk badge pack side=right：徽标在行右缘（todo.pyw:686），文字换行时避开它
    if (badgeParts) {
      const badge = makeBadge(...badgeParts);
      badge.addEventListener('click', () => openPanel(i));
      bindRowMenu(badge, i);
      row.appendChild(badge);
    }
  }
  row.dataset.i = String(i);
  listEl.appendChild(row);
  ROWS.set(i, info);
  if (ln.kind === 'header' || ln.kind === 'todo') {
    addHandle(row, i);                     // 0.4.0：拖动把手只在可拖的行上
    addPlus(row, i);                       // ADR 0007：加号同理只挂在能插待办的行上
    VIS.push({ i, el: row });
  }
}

function bindRowMenu(el, i) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menuRow(i, e.clientX, e.clientY);
  });
}

function bindBlankContext(el) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menuBlank(e.clientX, e.clientY);
  });
}

/* ---------- 编辑（todo.pyw:827-895） ---------- */

function toggleLine(i) {
  list.toggle(i);
}

function editRow(i) {
  if (S.missingShown) return;
  const info = ROWS.get(i);
  if (!info || !info.label) return;
  if (S.edit && S.edit.index === i) { S.edit.input.focus(); return; }
  if (S.edit) closeEditor();
  const ln = S.lines[i];
  if (!ln) return;
  const handle = openRowEdit({
    label: info.label,
    text: ln.text,
    done: ln.checked,
    onFinish: (v) => commitEdit(v),
    onCancel: () => cancelEdit(),
  });
  S.edit = { index: i, input: handle.input, handle };
}

/* 编辑框收拾干净：清状态、拆输入框、撤掉这一行的 editing 标记（DOM 由 rowedit.js 收） */
function dropEditor() {
  if (!S.edit) return;
  const entry = S.edit;
  S.edit = null;
  entry.handle.teardown();
}

/* 编辑框提交（todo.pyw:854-864）：值不做 trim，空文本照写 */
function commitEdit(value) {
  if (!S.edit) return;
  const index = S.edit.index;
  const v = value !== undefined ? value : S.edit.input.value;
  dropEditor();
  if (!(index >= 0 && index < list.lines().length)) { renderList(); return; }
  list.setText(index, v);   // 行已不在（外部重载过）由模块挡掉
}

function cancelEdit() {
  if (!S.edit) return;
  dropEditor();
  renderList();
}

/* 静默提交不重渲染（todo.pyw:879-890 close_editor） */
function closeEditor() {
  if (!S.edit) return;
  const { index, input } = S.edit;
  dropEditor();
  if (index >= 0 && index < list.lines().length) {
    try {
      list.setText(index, input.value, { quiet: true });
    } catch (e) { /*Tk 同款吞异常*/ }
  }
}

/* 正在编辑的行随删除一起消失：不提交，直接丢弃（todo.pyw:953-964） */
function discardEditor() {
  if (!S.edit) return;
  dropEditor();
}

/* 点击编辑框以外的地方即结束编辑（todo.pyw:912-925）
   捕获阶段：Tauri 注入的拖动区处理在 document 冒泡期 preventDefault + stopImmediatePropagation，
   冒泡监听收不到、preventDefault 还让输入框不 blur，点标题栏就提交不了（#4） */
document.addEventListener('mousedown', (e) => {
  const editing = S.edit || S.panelEditing;
  if (!editing) return;
  if (e.target && e.target.closest && e.target.closest('input')) return;
  // 加号自己会把正在编辑的那行提交掉（insertLine → renderList → closeEditor）：
  // 这里若也排一次提交，重画会把这个按钮换掉，click 就落不到它身上（ADR 0007）。
  if (e.target && e.target.closest && e.target.closest('.plus-add')) return;
  setTimeout(() => {
    if (S.edit) commitEdit();
    if (S.panelEditing) flushPanel();
  }, 0);
}, true);

/* ---------- 插入/删除/分组（todo.pyw:927-997） ---------- */

function insertLine(i, kind, indent, text, opts = {}) {
  const at = list.insert(i + 1, kind, indent, text);
  if (at < 0) return;
  if (opts.inPanel) {
    setTimeout(() => pushPanelData(at), 30);   // Tk after(30, p_edit(at))
  } else {
    setTimeout(() => editRow(at), 30);         // Tk after(30, edit_row(at))
  }
}

function deleteLine(i) {
  list.remove(i);   // 子块整块删、编辑框/面板收尾都在模块里
}

/* 清单可写：文件读进来过、且没停在「文件不见了」的缺失态 */
function listReady() {
  return S.loaded && !S.missingShown;
}

/* 批量删除已完成（用户拍板）：只看顶层待办自己的勾选，勾了就整块删。
   不弹确认框；删完在窗口底部给一条 3 秒的回执，点它就撤销整批（Q4 A）。
   整批只压一个快照：浮在半空的编辑先落定，之后才是这一批那一个 —— 回执点一下、
   或 Ctrl+Z 一次就退回去。编辑框与面板的收尾由 listBefore 统一处理。 */
async function deleteCompletedTodos() {
  if (!listReady()) return;
  await flushPanel();   // 详情面板里改了一半的先落回来
  const r = list.deleteCompleted();
  if (!r) return;
  showToast(`已删除 ${r.n} 条 · Ctrl+Z 撤销`,
    r.unfinished ? `其中 ${r.unfinished} 条待办下有未勾选的子待办` : '',
    undoNow);
  log(`cleared ${r.n} completed (${r.unfinished} with unfinished children)`);
}

/* ---------- 回执浮层 ----------
   这个应用原本没有「说一句话又自己消失」的位置；撤销也一直只藏在 Ctrl+Z 里。
   浮层只在批量删除后出现 3 秒，可点时点一下就是撤销。 */
const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(main, sub, onUndo) {
  if (!toastEl) return;
  toastEl.textContent = '';
  const head = document.createElement('div');
  head.textContent = main;
  toastEl.appendChild(head);
  if (sub) {
    const line = document.createElement('div');
    line.className = 'toast-sub';
    line.textContent = sub;
    toastEl.appendChild(line);
  }
  toastEl.classList.toggle('clickable', !!onUndo);
  toastEl.onclick = onUndo ? () => { hideToast(); onUndo(); } : null;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 3000);
}

function hideToast() {
  if (!toastEl) return;
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  toastEl.classList.remove('show');
  toastEl.onclick = null;
}

function insertGroup(i) {
  // todo.pyw:988-997
  const at = md.blockEnd(list.lines(), i);
  const pos = list.insert(at, 'header', '', '新分组');
  if (pos >= 0) setTimeout(() => editRow(pos), 30);
}

/* ---------- 行内加号（ADR 0007） ----------
   悬停在分组标题/待办上时，把手左边出现一个小加号；点它在条目下方插一条待办。
   落点由 md.todoBelow 算：分组标题跟组内第一条待办的缩进，待办插在整块之后不抢子项。 */

function addPlus(row, i) {
  const p = plusButton('在下方添加待办');
  p.addEventListener('click', (e) => {
    e.stopPropagation();
    const slot = md.todoBelow(S.lines, i);
    if (slot) insertLine(slot.after, 'todo', slot.indent, '新待办');
  });
  // 加号上的右键仍然是这一行的菜单（与右键行本体一致）
  p.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (drag.isOn()) { drag.cleanup(); return; }
    menu.hide();
    menuRow(i, e.clientX, e.clientY);
  });
  row.appendChild(p);
}

/* ---------- 拖动排序（0.4.0；0.4.2 收进 rowdrag.js） ----------
   起拖只认行右缘的小把手；指针捕获、浮层、插入线、自动滚、落点求解都在 rowdrag.js，
   这里只给把手接上主窗口的适配器（政策：能不能插进这个分组）。 */

function addHandle(row, i) {
  const h = document.createElement('span');
  h.className = 'drag-handle';
  h.innerHTML = GRIP_SVG;
  h.addEventListener('pointerdown', (e) => drag.start(e, h, i));
  // 把手上的右键仍然是这一行的菜单（不落到整行空白菜单）
  h.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (drag.isOn()) { drag.cleanup(); return; }
    menu.hide();
    menuRow(i, e.clientX, e.clientY);
  });
  row.appendChild(h);
}

/* ---------- 自绘菜单（右键菜单 + 顶栏文件下拉，todo.pyw:1041-1072, 1463-1486） ---------- */

/* 顶栏文件菜单（0.4.2）：「更换文件…」与「新建待办文件…」两枚常驻图标合并成一枚下拉。
   单击展开、再单击收起；锚在按钮左下角，溢出时由共享菜单夹回窗口内。
   两项都走原生对话框，所以文案带省略号。 */
function toggleFileMenu() {
  const btn = $('btn-file');
  if (menu.isOpen()) { menu.hide(); return; }
  const r = btn.getBoundingClientRect();
  menu.show([
    { label: '打开文件…', fn: chooseFile },
    { label: '新建文件…', fn: newFile },
  ], r.left, r.bottom + 2, { owner: btn });
}

function menuRow(i, x, y) {
  const ln = S.lines[i];
  const items = [];
  // ADR 0007：添加待办从菜单搬到行上的加号，这里只剩改结构/改名/改文字/删除。
  if (ln.kind === 'header') {
    items.push({ label: '在下方插入分组', fn: () => insertGroup(i) });
    items.push({ label: '重命名分组', fn: () => editRow(i) });
    items.push({ label: '删除分组标题', fn: () => deleteLine(i) });
  } else if (ln.kind === 'todo') {
    items.push({ label: '打开详情面板', fn: () => openPanel(i) });
    items.push({ label: '在下方插入分组', fn: () => insertGroup(i) });
    items.push('sep');
    items.push({ label: '编辑', fn: () => editRow(i) });
    items.push({ label: '删除', fn: () => deleteLine(i) });
  } else {
    // blank / other / note：主窗口不给它们开菜单（备注只活在详情面板里，见 renderList 的跳过）
    return;
  }
  menu.show(items, x, y);
}

function menuBlank(x, y) {
  // 空白处只剩这一项；退出交给顶栏的 ✕。文件缺失时没有可写的目标（加了会隐式建一个
  // 只有分组的新文件，绕过 ＋ 的示例内容），所以这一项置灰说明，而不是消失。
  menu.show([{
    label: '在末尾添加分组',
    disabled: S.missingShown || !S.loaded,
    fn: () => insertGroup(S.lines.length - 1),
  }], x, y);
}

/* 原“右键标题栏”菜单（更换文件… / 打开文件位置 / 退出）已整块删除：前两项现在在顶栏第一枚
   图标的「文件菜单」下拉里（0.4.2 合并），退出在顶栏 ✕。删而不是修的原因：Tauri 2 注入的
   window/scripts/drag.js 在 document 上注册冒泡期 mousedown，命中 data-tauri-drag-region 时
   preventDefault + stopImmediatePropagation + invoke start_dragging；它注册得比页面脚本早，
   所以这里冒泡期的“点菜单外面关掉”永远收不到 —— 菜单点开后点标题栏关不掉。
   0.4.2 的文件菜单下拉改用捕获期 pointerdown 绕开这条路径（见 bindChrome）。
   右键标题栏现在什么也不发生（全局 contextmenu preventDefault 兜掉 WebView2 默认菜单）。 */

/* ---------- 详情面板（todo.pyw:1074-1261；#16 起跨窗只走 panelproto.js） ----------
   这里只回答「面板的每个操作在清单上是什么」以及「面板该看到哪些行」。
   消息名、方向、字段、握手与落定都在协议模块里，两边共用同一张表。 */

/* 协议端：宿主对象与 log 从这里注入，收消息的处理函数在 boot 里一次装齐。 */
const panel = connect({ side: MAIN, getHost: host, log, flushTimeoutMs: 800 });

function openPanel(i) {
  list.setPanel(i);
  S.panelOpen = true;
  invoke('panel_open');
  panel.announce();   // 面板窗口比主窗口晚建：要用了就再喊一声 hello
  pushPanelData();
}

function closePanel() {
  if (!S.panelOpen) return;
  S.panelOpen = false;
  S.panelEditing = false;
  list.setPanel(-1);
  invoke('panel_close');
  panel.send('hide', {});
  log('panel closed');
}

/* 收起面板，但先把面板里未提交的编辑落回清单（#16 验收：关面板不丢字）。
   Tk close_panel 开头就是 _commit_edits，这里是它的跨窗口等价物。
   「面板里到底有没有没提交的字」由面板自己的 editing 通知维护：没有就直接收，
   有才走一趟落定（面板卡死时最多等一次告警，不会每次关面板都卡）。
   正在编辑的那行被删掉时走裸 closePanel —— 那时用户要的就是丢掉，与 Tk 同款。 */
async function closePanelSaving() {
  if (!S.panelOpen) return;
  if (S.panelEditing) await flushPanel();
  closePanel();
}

function refreshPanel(focusIdx) {
  if (!S.panelOpen) return;
  pushPanelData(focusIdx);
}

function pushPanelData(focusIdx) {
  if (!S.panelOpen) return;
  const i = list.panelIndex();   // 锚点是文字 + 缩进层级，模块每次改动后自己跟着走
  if (i < 0) {
    log('panel target gone -> close');
    closePanel();
    return;
  }
  const lines = list.lines();
  const [todos, notes] = md.panelParts(lines, i);
  panel.send('data', {
    title: lines[i].text,
    todos: todos.map((j) => ({ j, checked: lines[j].checked, text: lines[j].text })),
    notes: notes.map((j) => ({ j, text: lines[j].text })),
    focusIdx: focusIdx === undefined ? null : focusIdx,
  });
}

/* 面板编辑需先落定再动清单（Tk _commit_edits 的跨窗口等价物）。
   #16：等面板的显式回执，回执里带着它本来要提交的操作——照着落，不猜。
   回执没来（面板页卡住/没了）只留一条告警，不再用 400ms 墙钟假装提交成功。 */
async function flushPanel() {
  if (!S.panelOpen) return;
  if (!panel.peerReady()) return;   // 面板页还没握上手：没有它可以交的东西
  const ops = await panel.flush();
  if (ops === null) return;   // 只告警；此时面板的编辑仍留在它自己那儿
  for (const op of ops) applyPanelOp(op);
}

/* 面板发来的每一个操作的处理函数：表里一条，这里一条，没有第三种说法。
   落定回执里的操作也走这里，所以「直发」与「回执」落的是同一条路径。 */
const PANEL_HANDLERS = {
  toggle: (m) => toggleLine(m.j),
  // Tk p_edit commit(1323-1333)：改这一行文字，其余交给清单模块
  setText: (m) => list.setText(m.j, m.value),
  // 取消编辑：文字没变，重推一轮内容把输入框换回来
  discardEdit: () => refreshPanel(),
  remove: (m) => deleteLine(m.j),
  addTodo: () => pAddTodo(),
  addNote: () => pAddNote(),
  // ADR 0007：面板行上的加号——在该行下方插一条同类条目（缩进原样抄这一行）
  addBelow: (m) => pAddBelow(m.kind, m.j),
  move: (m) => {
    // 0.4.0：面板里拖动排序（只在同一栏内，跨栏不合法）。真搬行只在这里做。
    const to = m.where === 'before' ? m.anchor : md.blockEnd(list.lines(), m.anchor);
    if (list.move(m.from, to)) log(`panel drag move ${m.from} -> ${to}`);
  },
  rename: (m) => {
    // Tk p_rename commit(1379-1393)：锚点跟着改过的标题走（setText 的收尾会刷新锚）
    const i = list.panelIndex();
    if (i >= 0) list.setText(i, m.value);
  },
  discardRename: () => refreshPanel(),
  /* 面板自己请求收起：它在发这条之前已经 commitPending 把未定稿的编辑交出来了
     （setText / rename 先走一条），所以这里只收窗口，不再反向要一次落定。 */
  close: () => closePanel(),
  // 面板里有未提交的编辑：主窗口据此放过 Ctrl+Z 与退出前的收尾
  editing: (m) => { S.panelEditing = !!m.on; },
};

/* 一条已编码的面板操作按上面的处理函数落。 */
function applyPanelOp(op) {
  const fn = PANEL_HANDLERS[op.type];
  if (!fn) { log(`没有 ${op.type} 的处理函数`); return; }
  fn(op);
}

function pAddTodo() {
  // todo.pyw:1435-1443
  const i = list.panelIndex();
  const lines = list.lines();
  if (!(i >= 0 && i < lines.length)) return;
  const [todos] = md.panelParts(lines, i);
  const pos = todos.length ? todos[todos.length - 1] : i;
  insertLine(pos, 'todo', md.childIndent(lines[i]), '新待办', { inPanel: true });
}

function pAddNote() {
  // todo.pyw:1445-1452
  const i = list.panelIndex();
  const lines = list.lines();
  if (!(i >= 0 && i < lines.length)) return;
  const pos = md.subtreeEnd(lines, i) - 1;
  insertLine(pos, 'note', md.childIndent(lines[i]), '', { inPanel: true });
}

function pAddBelow(kind, j) {
  // ADR 0007：面板行上的加号。只挂在这一栏里看得见的行上，缩进原样抄它
  // （父待办换过缩进也不会串），备注插空文字直接进编辑。
  // 待办得像主窗口那样落在整棵子块之后：插在 j+1 会把它下面的行抢成自己的孩子。
  const lines = list.lines();
  if (!(j >= 0 && j < lines.length)) return;
  const ref = md.subtreeEnd(lines, j) - 1;
  insertLine(ref, kind, lines[j].indent, kind === 'todo' ? '新待办' : '', { inPanel: true });
}

/* ---------- 文件/窗口杂项（todo.pyw:1488-1538） ---------- */

/* 切到另一个文件（更换文件 / 新建共用）。身份只从命令回传的 {file,title} 采纳（#12）：
   「当前打开哪个文件」的唯一所有者在 Rust，这里不自己拼路径、也不猜标题；
   只负责重新装载并把它落进 config.json；详情面板还挂着旧文件的行，一并关掉。 */
async function switchToFile(identity) {
  adoptFile(identity);
  S.missingShown = false;
  await closePanelSaving();   // 面板里改了一半的先落回旧文件，再换
  await loadFile();
  invoke('save_config');
}

async function chooseFile() {
  const identity = await invoke('choose_file');
  if (identity) await switchToFile(identity);
}

/* ＋ 新建待办文件（0.4.0）：原生「另存为」挑位置，新路径写一份示例内容；
   指到已存在的文件则当"打开已有文件"处理，绝不覆盖。 */
async function newFile() {
  await flushPanel();    // 面板里改了一半的任务名先落回来，别丢
  // 再把还没落盘的改动写回去：切走之后 S.lines 马上就换成新文件的内容
  const pending = list.pending();
  list.cancelSave();
  closeEditor();
  if (pending && S.loaded && !S.missingShown) await writeText(list.text());
  let res;
  try {
    res = await invoke('new_md_file', { content: starterText('\r\n') });
  } catch (e) {
    log(`new file failed: ${e}`);
    setTitle('新建失败!');
    return;
  }
  if (!res) return;                                  // 对话框取消
  await switchToFile(res);
  log(res.created ? `created ${res.file}` : `existing file opened: ${res.file}`);
}

function toggleDock() {
  // ADR 0004：点亮 = 固定在桌面（桌面图标之上、任务栏与 Alt+Tab 里都没有）；
  // 未点亮 = 普通窗口（正常 z 序、任务栏有图标）。窗口样式与 config 都由 Rust 统一落，
  // 真相源是 Rust 的 Shared.docked——这里只报"要切到哪一态"，按钮等 dock-changed 回来再画。
  invoke('set_docked', { docked: !S.docked });
}

function updateDockButton() {
  // 点亮即"已固定"，title 说明当前模式
  const btn = $('btn-pin');
  btn.classList.toggle('lit', S.docked);
  btn.title = S.docked ? '固定在桌面' : '普通窗口';
}

/* ---------- 外部变化轮询（todo.pyw:1541-1574 的文件部分） ---------- */

async function pollTick() {
  try {
    // 维护（贴桌面/面板置顶/离屏救援/配置落盘）在 Rust 侧；路径显式带上，回来的就是它的 stat。
    // 响应回来时若当前文件已经换掉（切换命令先到），这一帧作废：不拿旧文件的 stat 误判新文件
    // （会把新文件显示成「缺失」或反复重载）；轮询也不私有地改身份（#12）。
    const file = S.file;
    const st = await invoke('poll_tick', { file });
    if (file === S.file) {
      const cur = st ? `${st.mtime_ns}:${st.size}` : null;
      if (!st) {
        if (!S.missingShown) {
          showMissing();
          log('file disappeared');
        }
        S.lastSeen = null;
      } else if (cur !== S.lastSeen) {
        S.lastSeen = cur;
        log('external change -> reload');
        await loadFile();
      }
    }
  } catch (e) {
    log(`poll error: ${e}`);
  }
  setTimeout(pollTick, 1000);
}

/* ---------- 退出（todo.pyw:1633-1650） ---------- */

async function exitApp() {
  if (S.quitting) return;
  S.quitting = true;
  try {
    await flushPanel();    // 面板里未提交的编辑先落回清单，再写盘退出（未提交的编辑不丢）
    closeEditor();
    closePanel();          // 编辑已落定，这里只是收起窗口
    list.cancelSave();
    // 没装载成功就绝不写盘（0.4.0 修）：以前无条件写，退出一次就"生"出一个空文件，
    // 下次启动看着像本来就有文件，示例内容和新建引导再也不会出现；
    // 读取失败（比如文件不是 UTF-8）时同理——内存里那份空清单不是文件的内容。
    if (S.loaded && !S.missingShown && await writeText(list.text())) {
      log(`saved ${list.lines().length} lines`);
    }
  } catch (e) { /* Tk on_close 同款吞异常 */ }
  log('exit');
  invoke('exit_app');   // Rust 写 config 后退出
}

/* ---------- 顶栏/把手绑定 ---------- */

/* 顶栏图标（内联单色 SVG，风格同 GRIP_SVG / boxSvg）：同一个 13px 画布、
   .5 坐标、1px 线，几枚才逐像素对齐。以前 ＋ 📌 ↻ ✕ 用字体字形（14pt / 9pt /
   13pt / 12pt），字号与基线各不相同，顶栏里横竖都错位。
   文件菜单 = 纯文档页（矩形 + 右上折角），不叠箭头也不叠加号 —— 13px 下多一笔会糊，
   而且菜单项自己说明是打开还是新建（0.4.2 合并）；
   打开文件位置 = 闭合文件夹（左边一个抬起的 tab），与资源管理器“在文件夹中显示”同义；
   📌 = 24 画布的图钉，借 24 画布现成路径，线宽 2 随 13/24 缩放成 ~1.1px，与其余 1px 线同重。 */
const ICON_FILE_SVG = '<svg viewBox="0 0 13 13" fill="none">'
  + '<path d="M2.5 1.5H7.5L10.5 4.5V11.5H2.5Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  + '<path d="M7.5 1.5V4.5H10.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  + '</svg>';
const ICON_FOLDER_SVG = '<svg viewBox="0 0 13 13" fill="none">'
  + '<path d="M1.5 10.5V2.5H5.5V3.5H11.5V10.5Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  + '</svg>';
const ICON_CLOSE_SVG = '<svg viewBox="0 0 13 13" fill="none">'
  + '<path d="M3.2 3.2L9.8 9.8M9.8 3.2L3.2 9.8" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>'
  + '</svg>';
const ICON_PIN_SVG = '<svg viewBox="0 0 24 24" fill="none">'
  + '<path d="M12 17v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  + '<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  + '</svg>';
/* 删除已完成 = 带盖的垃圾桶：13px 下只留「盖一条横线 + 把手 + 收口桶身」，
   桶身不与盖闭合（盖线自己封口），多加竖条纹会糊成一团。 */
const ICON_TRASH_SVG = '<svg viewBox="0 0 13 13" fill="none">'
  + '<path d="M2.5 3.5H10.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>'
  + '<path d="M5.5 3.5V2.5H7.5V3.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  + '<path d="M3.7 3.5L4.3 10.8H8.7L9.3 3.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  + '</svg>';

/* 顶部这两枚按钮的状态：有没有可删的、title 报几条；「打开文件位置」能不能用。
   renderList / showMissing 收尾各调一次，所以任何一次重画（装载、勾选、外部改动、撤销）
   之后它们都是新的。 */
function updateClearButton() {
  const btn = $('btn-clear-done');
  if (!btn) return;
  const n = listReady() ? md.completedScan(list.lines()).length : 0;
  btn.disabled = n === 0;
  btn.title = n > 0 ? `删除已完成（${n}）` : '删除已完成';
}

/* 「打开文件位置」在缺失态置灰（0.4.2）：那时 S.file 指的路径多半不存在，点了只会打开
   不存在的父目录、或者弹出「文件和目录都不存在」（Rust 的 open_file_location）。 */
function updateRevealButton() {
  const btn = $('btn-reveal');
  if (btn) btn.disabled = !listReady();
}

/* 顶部两枚会置灰的按钮一起刷：清单换了就都得跟着变。 */
function updateChrome() {
  updateClearButton();    // 「删除已完成」的置灰与条数
  updateRevealButton();   // 「打开文件位置」跟着“有没有文件可显示”走
}

function bindChrome() {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('btn-close', exitApp);
  on('btn-pin', toggleDock);
  // 0.4.2：文件入口合并成一枚下拉。缺文件时它永不置灰——
  // 「打开文件…」「新建文件…」两项就是缺失状态下全部的出路。
  on('btn-file', toggleFileMenu);
  on('btn-reveal', () => invoke('open_file_location', { file: S.file }));
  on('btn-clear-done', deleteCompletedTodos);
  // 图标只在 app.js 有一份定义：HTML 里只留空按钮。
  const ICONS = {
    'btn-file': ICON_FILE_SVG, 'btn-reveal': ICON_FOLDER_SVG,
    'btn-pin': ICON_PIN_SVG, 'btn-close': ICON_CLOSE_SVG,
    'btn-clear-done': ICON_TRASH_SVG,
  };
  for (const [id, svg] of Object.entries(ICONS)) $(id).innerHTML = svg;
  // Tk 按钮按下不夺焦点（Canvas 无焦点），防止空格键误触
  for (const id of ['btn-close', 'btn-pin', 'btn-file', 'btn-reveal', 'btn-clear-done']) {
    $(id).addEventListener('mousedown', (e) => e.preventDefault());
    $(id).addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  }
  // 右键标题栏什么也不发生：标题栏自己的 menuTitle 绑定已删，这条全局 preventDefault
  // 只负责吞掉 WebView2 默认菜单（与 panel.js 同款）；列表/行/把手的菜单各自 preventDefault。
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  // 缩放把手（todo.pyw:503-506）
  $('grip').addEventListener('mousedown', (e) => {
    if (e.button === 0) invoke('resize_start');
  });
  bindBlankContext($('grip'));
  // 自绘滚动条（0.4.1）：底部让开 22px，不压右下角的缩放把手
  mainScroll = attachScrollbar(listEl, { bottomInset: 22 });
  // 列表空白（含尾部 padding）
  listEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menuBlank(e.clientX, e.clientY);
  });
  // Ctrl+Z（todo.pyw:510, 1009-1023）
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (S.edit || S.panelEditing || !list.canUndo()) return;
      e.preventDefault();
      undoNow();
    } else if (e.key === 'Escape') {
      if (drag.isOn()) { e.preventDefault(); drag.cleanup(); return; }   // 0.4.0：Esc 取消拖动
      menu.hide();
    }
  });
  // 拖动中右键 = 取消（捕获阶段，顺手吞掉这一下的行菜单）
  document.addEventListener('contextmenu', (e) => {
    if (!drag.isOn()) return;
    e.preventDefault();
    e.stopPropagation();
    drag.cleanup();
  }, true);
  // 点窗口内别处关闭菜单（捕获期 + pointerdown）。用 pointerdown 而不是 mousedown：
  // 标题栏的拖动区（data-tauri-drag-region）上，Tauri 注入的 drag.js 会吞掉 mousedown
  // （见上个注释块），而 pointerdown 比它早，标题栏空白处也关得掉（0.4.2 用户要求）。
  // 落在菜单自己或菜单归属的那枚按钮上时不关：后者留给 click 去 toggle。
  window.addEventListener('pointerdown', (e) => {
    if (!menu.isOpen() || menuEl.contains(e.target)) return;
    if (menu.owns(e.target)) return;
    menu.hide();
  }, true);
  // 失焦（点到详情面板、别的程序）也收起：下拉菜单挂在那儿等人回来是错的
  window.addEventListener('blur', () => menu.hide());
}

/* ---------- 启动 ---------- */

async function boot() {
  // 先挂退出监听：后面任何一步抛错（后端命令失败、文件读不了）都不该连带把「退出」弄死（ADR 0008）
  await host().event.listen('app-exit-request', () => exitApp());
  const info = await invoke('app_info');
  adoptFile(info);   // 唯一所有者回传 {file,title}：前端不另存、不猜
  S.docked = !!info.docked;   // app_info 必带 docked，没有「读不到就猜 false」的余地
  updateDockButton();

  bindChrome();
  /* 面板协议：装齐收消息的处理函数，再向面板 hello（两窗同一套）。
     面板页比主窗口晚建，它自己也会 hello；谁先到都接得上（panelproto.js 的回喊）。 */
  await panel.start(PANEL_HANDLERS);
  await host().event.listen('dock-changed', (e) => {
    // 托盘菜单切模式时由 Rust 广播：按状态重算，别信本地翻转
    S.docked = !!e.payload;
    updateDockButton();
  });
  await host().event.listen('panel-close', async () => {
    // Rust 侧面板被系统关闭（Alt+F4 等）：先把面板里未定稿的编辑落回清单再清状态，
    // 不能因为窗口是被系统关掉的就把用户打的字丢了（#16 验收）。
    await closePanelSaving();
  });

  await loadFile();
  pollTick();   // Tk 启动时先跑一轮 poll 再进入循环
  // boot 走完 = 界面真起来了：告诉 Rust 看门狗别再按「加载超时」倒计时（ADR 0008）
  uiReady = true;
  invoke('heartbeat', { ready: true }).catch(() => {});
}

boot().catch((e) => log(`boot error: ${e}`));
