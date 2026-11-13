/* 桌面待办 0.4.0 主窗口逻辑。
   与 todo.pyw (0.2.7) 逐函数对应，注释标注 Tk 源行号供 parity 审查。
   纯函数来自 md.js（blockEnd/canMove/moveBlock 为 0.4.0 拖动排序新增），撤销栈来自 undo.js。
   0.4.0 新增：拖动排序（Tk 0.2.7 没有，属 Tauri 侧扩展，两窗口各自窗口内）。
   入口是 ES module（import 需要真实 ESM；经典 script 会因 export 语法整体失效）。 */
'use strict';

import * as md from './md.js';
import { createUndoStack } from './undo.js';

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

/* __TAURI__ 注入时机与 module 执行存在竞态：不在顶层缓存对象，全部惰性访问 */
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
const emitTo = (target, event, payload) => window.__TAURI__.event.emitTo(target, event, payload);

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const titleEl = $('title');
const menuEl = $('menu');

const S = {
  lines: [],
  file: '',
  nl: '\n',
  hasBom: false,   // Tk has_bom 存实例：最近一次读到的 BOM 状态，写回沿用
  lastSeen: null,
  docked: false,   // ADR 0004：false = 普通窗口（默认）；true = 固定在桌面（无任务栏图标）
  missingShown: false,
  edit: null,            // { index, input }
  panelOpen: false,
  panelTodo: -1,
  panelAnchor: null,     // [text, indentUnits]
  panelEditing: false,   // 面板窗口里有未提交编辑（Tk p_edit_entry 非空）
  saveTimer: null,
  commitWaiter: null,    // requestPanelCommit 的应答槽
  undoStack: createUndoStack(50),
  quitting: false,
};

const ROWS = new Map();  // i -> { row, label, box }
const VIS = [];          // 可拖行（分组标题 / 待办）按文档顺序：[{ i, el }]

/* 拖动排序状态（0.4.0）：pointer 自绘，不用 HTML5 DnD（WebView2 里不可靠）。 */
const EDGE_SCROLL = 24;  // 指针进到窗口上下这么多像素内就开始自动滚动
const EDGE_STEP = 12;    // 自动滚动每帧滚多少像素

const DND = {
  on: false,
  from: -1,
  slot: -1,
  lastY: 0,        // 上一次指针高度：自动滚动时靠它重算落点
  edge: 0,         // -1 上滚 / 1 下滚 / 0 不动
  pump: 0,         // requestAnimationFrame id
  lines: null,     // 起拖时的数组引用：轮询重载换了数组就放弃这次拖动
  ghost: null,
  line: null,
  srcEl: null,
  ghostH: 0,
};

/* ---------- 基础设施 ---------- */

function log(msg) { invoke('log_line', { msg: String(msg) }); }

/* 标题被 ellipsis 截断时，悬停由 title 属性给出完整文件名（Tk 用 winfo 无此需求，0.4.x 新增）。
   保存失败时 setTitle('保存失败!') 会连 tooltip 一起变成提示语——可接受的副作用。 */
function setTitle(t) { titleEl.textContent = t; titleEl.title = t; }

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
    const ok = await invoke('write_md', { file: S.file, content, hasBom: S.hasBom });
    if (ok) S.lastSeen = await statNow();
    return ok;
  } catch (e) {
    log(`write failed: ${e}`);
    return false;
  }
}

function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/* ---------- 撤销（todo.pyw:1000-1023） ---------- */

function pushUndo() { S.undoStack.push(md.serialize(S.lines)); }

async function undo() {
  if (S.edit || S.panelEditing || !S.undoStack.canUndo()) return;
  const snap = S.undoStack.undo();
  const ok = await writeText(snap);
  if (!ok) { log('undo save failed'); return; }
  S.lines = md.parseText(snap);
  renderList();
  log(`undo (left ${S.undoStack.size()} snapshots)`);
}

/* ---------- 保存调度（todo.pyw:1026-1038） ---------- */

function scheduleSave() {
  if (S.saveTimer) clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(doSave, 250);
}

function cancelSave() {
  if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; }
}

async function doSave() {
  S.saveTimer = null;
  try {
    if (await writeText(md.serialize(S.lines))) {
      log(`saved ${S.lines.length} lines`);
    }
  } catch (e) {
    log(`save failed: ${e}`);
    setTitle('保存失败!');
  }
}

/* ---------- 文件装载（todo.pyw:565-602） ---------- */

function showMissing() {
  if (S.missingShown) return;
  S.missingShown = true;
  listEl.textContent = '';
  ROWS.clear();
  const div = document.createElement('div');
  div.className = 'missing';
  div.textContent = `文件不存在：\n${S.file}\n\n点顶栏「更换文件…」可选择新的文件`;
  listEl.appendChild(div);
}

async function loadFile() {
  // 外部改动重载：丢弃尚未落盘的旧内存状态（Tk load_file 同样直接重读，不回写）
  cancelSave();
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
  S.nl = data.nl;
  S.hasBom = data.has_bom;   // Tk has_bom 存实例，写回沿用
  S.lines = md.parseText(data.text);
  S.lastSeen = await statNow();
  S.undoStack = createUndoStack(50);   // 文件被外部/重新加载, 撤销历史失效
  let base = basename(S.file);
  if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3);
  setTitle(base);
  renderList();
  log(`loaded ${S.lines.length} lines from ${S.file}`);
}

/* ↻（todo.pyw:581-589）：先收尾未提交的编辑并落盘，再读回文件 */
async function refreshFromDisk() {
  await requestPanelCommit();
  closeEditor();
  cancelSave();
  if (await fileStateExists()) {
    try {
      if (await writeText(md.serialize(S.lines))) {
        log(`saved ${S.lines.length} lines`);
      }
    } catch (e) {
      log(`save failed: ${e}`);
    }
  }
  await loadFile();
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
  if (DND.on) cleanupDrag();           // 重画行之前先收掉拖动浮层（外部重载可能把行换掉）
  const doc = document.scrollingElement;
  const max0 = doc.scrollHeight - doc.clientHeight;
  const frac = max0 > 0 ? doc.scrollTop / max0 : 0;
  closeEditor();                       // 静默提交，不重渲染（todo.pyw:607）
  S.missingShown = false;
  listEl.textContent = '';
  ROWS.clear();
  VIS.length = 0;
  let i = 0;
  while (i < S.lines.length) {
    const ln = S.lines[i];
    // 0.4.0：备注只在详情面板里出现；顶格备注行静默隐藏但原样留在文件里。
    if (ln.kind === 'note') { i += 1; continue; }
    buildRow(i, ln);
    if (ln.kind === 'todo') {
      i = md.subtreeEnd(S.lines, i);   // 待办的整个子块收进详情面板
    } else {
      i += 1;
    }
  }
  doc.scrollTop = frac * (doc.scrollHeight - doc.clientHeight);
  refreshPanel(focusIdx);              // 主列表是清单渲染的唯一出口
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
  const ln = S.lines[i];
  pushUndo();
  md.toggleRaw(ln);
  renderList();
  scheduleSave();
}

function editRow(i) {
  if (S.missingShown) return;
  const info = ROWS.get(i);
  if (!info || !info.label) return;
  if (S.edit && S.edit.index === i) { S.edit.input.focus(); return; }
  if (S.edit) closeEditor();
  const ln = S.lines[i];
  const input = document.createElement('input');
  input.className = 'row-edit' + (ln.checked ? ' done' : '');
  input.value = ln.text;
  info.label.style.display = 'none';
  info.row.insertBefore(input, info.label.nextSibling);
  input.select();
  input.focus();

  const entry = { index: i, input };
  S.edit = entry;

  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // IME 组合中的回车/ESC 不处理
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
  });
  input.addEventListener('blur', () => { if (S.edit === entry) commitEdit(); });
  input.addEventListener('compositionend', () => input.focus());
}

/* 编辑框提交（todo.pyw:854-864）：值不做 trim，空文本照写 */
function commitEdit() {
  if (!S.edit) return;
  const { index, input } = S.edit;
  S.edit = null;
  input.remove();
  if (!(index >= 0 && index < S.lines.length)) { renderList(); return; }
  pushUndo();
  md.setLineText(S.lines[index], input.value);
  panelSyncAnchor(index);
  renderList();
  scheduleSave();
}

function cancelEdit() {
  if (!S.edit) return;
  const { input } = S.edit;
  S.edit = null;
  input.remove();
  renderList();
}

/* 静默提交不重渲染（todo.pyw:879-890 close_editor） */
function closeEditor() {
  if (!S.edit) return;
  const { index, input } = S.edit;
  S.edit = null;
  if (index >= 0 && index < S.lines.length) {
    try {
      pushUndo();
      md.setLineText(S.lines[index], input.value);
      panelSyncAnchor(index);
      scheduleSave();
    } catch (e) { /*Tk 同款吞异常*/ }
  }
}

/* 正在编辑的行随删除一起消失：不提交，直接丢弃（todo.pyw:953-964） */
function discardEditor() {
  if (!S.edit) return;
  const { input } = S.edit;
  S.edit = null;
  input.remove();
}

function panelSyncAnchor(i) {
  // todo.pyw:892-896：就地改了面板对应待办的文字 → 同步锚，别让面板自毁
  if (S.panelOpen && i === S.panelTodo && i >= 0 && i < S.lines.length) {
    const ln = S.lines[i];
    S.panelAnchor = [ln.text, md.indentUnits(ln.indent)];
  }
}

/* 点击编辑框以外的地方即结束编辑（todo.pyw:912-925）
   捕获阶段：Tauri 注入的拖动区处理在 document 冒泡期 preventDefault + stopImmediatePropagation，
   冒泡监听收不到、preventDefault 还让输入框不 blur，点标题栏就提交不了（#4） */
document.addEventListener('mousedown', (e) => {
  const editing = S.edit || S.panelEditing;
  if (!editing) return;
  if (e.target && e.target.closest && e.target.closest('input')) return;
  setTimeout(() => {
    if (S.edit) commitEdit();
    if (S.panelEditing) emitTo('panel', 'panel-commit', {});
  }, 0);
}, true);

/* ---------- 插入/删除/分组（todo.pyw:927-997） ---------- */

function insertLine(i, kind, indent, text, opts = {}) {
  pushUndo();
  const ref = opts.pos === undefined ? i : opts.pos;
  if (ref >= 0 && ref < S.lines.length && !S.lines[ref].raw.endsWith('\n')) {
    S.lines[ref].raw += S.nl;
  }
  const raw = indent + (kind === 'todo' ? '- [ ] ' : '- ') + text + S.nl;
  const at = (opts.pos === undefined ? i : opts.pos) + 1;
  S.lines.splice(at, 0, md.parseLine(raw));
  renderList();
  scheduleSave();
  if (opts.inPanel) {
    setTimeout(() => pushPanelData(at), 30);   // Tk after(30, p_edit(at))
  } else {
    setTimeout(() => editRow(at), 30);         // Tk after(30, edit_row(at))
  }
}

async function deleteLine(i) {
  if (!(i >= 0 && i < S.lines.length)) return;
  pushUndo();
  const ln = S.lines[i];
  if (ln.kind === 'todo') {
    const end = md.subtreeEnd(S.lines, i);
    if (S.edit && i <= S.edit.index && S.edit.index < end) discardEditor();
    if (S.panelOpen && i <= S.panelTodo && S.panelTodo < end) closePanel();
    S.lines = md.deleteSubtree(S.lines, i);
  } else {
    if (S.edit && S.edit.index === i) discardEditor();
    S.lines.splice(i, 1);
  }
  renderList();
  scheduleSave();
}

async function addTodoEnd() {
  // todo.pyw:969-978
  if (!(await fileStateExists())) {
    S.lines = [];
    S.missingShown = false;
    await writeText('- [ ] 新待办' + S.nl);
    S.lastSeen = await statNow();
  }
  if (!S.lines.length) {
    insertLine(-1, 'todo', '', '新待办');
    return;
  }
  insertLine(S.lines.length - 1, 'todo', '', '新待办');
}

function groupBlockEnd(i) {
  // todo.pyw:981-986；0.4.0 起与拖动排序共用同一个行块定义
  return md.blockEnd(S.lines, i);
}

function insertGroup(i) {
  // todo.pyw:988-997
  pushUndo();
  const pos = groupBlockEnd(i);
  if (pos - 1 >= 0 && pos - 1 < S.lines.length && !S.lines[pos - 1].raw.endsWith('\n')) {
    S.lines[pos - 1].raw += S.nl;
  }
  S.lines.splice(pos, 0, md.parseLine('**新分组**' + S.nl));
  renderList();
  scheduleSave();
  setTimeout(() => editRow(pos), 30);
}

function nextTodoIndent(i) {
  // todo.pyw:1454-1461
  for (let j = i + 1; j < S.lines.length; j += 1) {
    if (S.lines[j].kind === 'todo') return S.lines[j].indent;
    if (S.lines[j].kind === 'header' || S.lines[j].kind === 'blank') break;
  }
  return '';
}

/* ---------- 拖动排序（0.4.0） ----------
   起拖只认行右缘的小把手；pointer 自绘浮层 + 插入线（HTML5 DnD 在 WebView2 里不可靠）。
   落点只有行间插入，且永远落在整块边界：待办带走整棵子树，分组带走整组。
   搬行本身是 md.js 的纯函数（blockEnd / allowsTopSlot / canMove / moveBlock，26 项 TDD）。 */

const GRIP_SVG = '<svg viewBox="0 0 8 14" fill="none">'
  + '<circle cx="2" cy="3" r="1.1" fill="currentColor"/><circle cx="6" cy="3" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="7" r="1.1" fill="currentColor"/><circle cx="6" cy="7" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="11" r="1.1" fill="currentColor"/><circle cx="6" cy="11" r="1.1" fill="currentColor"/>'
  + '</svg>';

function addHandle(row, i) {
  const h = document.createElement('span');
  h.className = 'drag-handle';
  h.innerHTML = GRIP_SVG;
  h.addEventListener('pointerdown', (e) => startDrag(e, i, h));
  // 把手上的右键仍然是这一行的菜单（不落到整行空白菜单）
  h.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (DND.on) { cleanupDrag(); return; }
    hideMenu();
    menuRow(i, e.clientX, e.clientY);
  });
  row.appendChild(h);
}

function startDrag(e, i, handle) {
  if (e.button !== 0 || S.missingShown || !S.lines[i]) return;
  e.preventDefault();          // 不夺焦点、不拖选文字
  e.stopPropagation();
  const x0 = e.clientX, y0 = e.clientY;
  let live = false;
  const onMove = (ev) => {
    if (!live) {
      if (Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      live = beginDrag(i);
      if (!live) { detach(); return; }
    }
    trackDrag(ev);
  };
  const onUp = (ev) => {
    if (live) dropDrag(ev);
    detach();
  };
  const onCancel = () => {
    if (live) cleanupDrag();
    detach();
  };
  function detach() {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* 行已重渲染 */ }
  }
  try { handle.setPointerCapture(e.pointerId); } catch (_) { return; }
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
}

function beginDrag(i) {
  closeEditor();                 // 静默提交，不重渲染（重渲染会换掉把手）
  const ln = S.lines[i];
  if (!ln) return false;
  DND.on = true;
  DND.from = i;
  DND.slot = -1;
  DND.lines = S.lines;
  const info = ROWS.get(i);
  DND.srcEl = info ? info.row : null;
  if (DND.srcEl) DND.srcEl.classList.add('drag-src');

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost' + (ln.kind === 'header' ? ' drag-ghost-header' : '');
  const text = document.createElement('span');
  text.className = 'drag-ghost-text';
  text.textContent = ln.text || '（空）';
  ghost.appendChild(text);
  const [td, , nt] = ln.kind === 'todo' ? md.subtreeStats(S.lines, i) : [0, 0, 0];
  if (td + nt) {
    const cnt = document.createElement('span');
    cnt.className = 'drag-ghost-count';
    cnt.textContent = `+${td + nt}`;
    ghost.appendChild(cnt);
  }
  if (DND.srcEl) ghost.style.width = `${Math.round(DND.srcEl.getBoundingClientRect().width)}px`;

  const line = document.createElement('div');
  line.className = 'drop-line';
  line.style.display = 'none';
  document.body.appendChild(ghost);
  document.body.appendChild(line);
  DND.ghost = ghost;
  DND.line = line;
  DND.ghostH = ghost.getBoundingClientRect().height;
  document.body.classList.add('dragging');
  return true;
}

function trackDrag(ev) {
  if (!DND.on) return;
  if (S.lines !== DND.lines) { cleanupDrag(); return; }   // 文件被外部改过：放弃
  DND.lastY = ev.clientY;
  if (DND.ghost) {
    DND.ghost.style.left = `${ev.clientX + 16}px`;
    DND.ghost.style.top = `${ev.clientY - Math.max(DND.ghostH / 2, 12)}px`;
  }
  DND.edge = edgeDir(ev.clientY);
  if (DND.edge) startScrollPump(); else stopScrollPump();
  refreshSlot();
}

/* 指针停进窗口上下 24px 就算进入滚动区；按住不动也继续滚（每帧 12px）。 */
function edgeDir(y) {
  if (y < EDGE_SCROLL) return -1;
  if (y > window.innerHeight - EDGE_SCROLL) return 1;
  return 0;
}

function startScrollPump() {
  if (DND.pump) return;
  DND.pump = requestAnimationFrame(function tick() {
    if (!DND.on || !DND.edge) { stopScrollPump(); return; }
    window.scrollBy(0, EDGE_STEP * DND.edge);
    refreshSlot();
    DND.pump = requestAnimationFrame(tick);
  });
}

function stopScrollPump() {
  if (DND.pump) { cancelAnimationFrame(DND.pump); DND.pump = 0; }
}

function refreshSlot() {
  DND.slot = slotAt(DND.lastY);
  drawLine();
}

function drawLine() {
  if (!DND.line) return;
  const pos = DND.slot >= 0 ? slotPos(DND.slot) : null;
  if (!pos) { DND.line.style.display = 'none'; return; }
  DND.line.style.display = 'block';
  DND.line.style.top = `${Math.round(pos.top - 1)}px`;
  DND.line.style.left = `${Math.round(pos.left)}px`;
  DND.line.style.width = `${Math.max(0, Math.round(pos.right - pos.left))}px`;
}

/* 指针高度 → 落点下标（插在这一行之前）。行间空白归上一行。
   拖的是分组时只认组边界：上半落到本组之前，下半落到本组之后（= 下一组之前），
   否则分组会插进别人组中间，把那一组的条目改归自己。 */
function slotAt(y) {
  if (!VIS.length) return -1;
  if (y < VIS[0].el.getBoundingClientRect().top) return slotOK(VIS[0].i) ? VIS[0].i : -1;
  let hit = -1, rect = null;
  for (const v of VIS) {
    const r = v.el.getBoundingClientRect();
    if (y < r.top) break;
    hit = v.i;
    rect = r;
  }
  if (hit < 0) return -1;
  const upper = y < rect.top + rect.height / 2;
  let slot;
  if (S.lines[DND.from].kind === 'header') {
    const g = groupStart(hit);
    if (g < 0) return -1;
    slot = upper ? g : md.blockEnd(S.lines, g);
  } else if (S.lines[hit].kind === 'header') {
    slot = hit + 1;                       // 拖到组头 = 组首
  } else {
    slot = upper ? hit : md.blockEnd(S.lines, hit);
  }
  return slotOK(slot) ? slot : -1;
}

/* 这一行所属分组的标题下标；上面一个标题都没有时返回 -1。 */
function groupStart(i) {
  let k = i;
  while (k > 0 && S.lines[k].kind !== 'header') k -= 1;
  return S.lines[k].kind === 'header' ? k : -1;
}

function slotOK(slot) {
  if (!(slot >= 0 && slot <= S.lines.length)) return false;
  if (slot === 0 && !md.allowsTopSlot(S.lines)) return false;   // 第一组标题之前没有落点
  return md.canMove(S.lines, DND.from, slot);
}

/* 落点的屏幕坐标：插入线从「下一可见行」的缩进位画到行右缘。 */
function slotPos(slot) {
  let next = null, prev = null;
  for (const v of VIS) {
    if (v.i < slot) prev = v;
    else { next = v; break; }
  }
  if (next) {
    const r = next.el.getBoundingClientRect();
    return { top: r.top, left: labelLeft(next.el), right: r.right };
  }
  if (prev) {
    const r = prev.el.getBoundingClientRect();
    return { top: r.bottom, left: labelLeft(prev.el), right: r.right };
  }
  return null;
}

function labelLeft(row) {
  const lbl = row.querySelector('.label');
  return (lbl || row).getBoundingClientRect().left;
}

function dropDrag(ev) {
  const inside = ev.clientX >= 0 && ev.clientY >= 0
    && ev.clientX <= window.innerWidth && ev.clientY <= window.innerHeight;
  const slot = DND.slot, from = DND.from;
  const fresh = S.lines === DND.lines;   // 拖到一半文件被外部改过（轮询重载换了数组）就放弃
  cleanupDrag();
  if (!fresh || !inside || slot < 0) return;   // 拖出窗口或没有合法落点 = 取消，不写不记撤销
  pushUndo();
  S.lines = md.moveBlock(S.lines, from, slot, S.nl);
  renderList();
  scheduleSave();
  log(`drag move ${from} -> ${slot}`);
}

function cleanupDrag() {
  stopScrollPump();
  if (DND.ghost) DND.ghost.remove();
  if (DND.line) DND.line.remove();
  if (DND.srcEl) DND.srcEl.classList.remove('drag-src');
  document.body.classList.remove('dragging');
  DND.on = false;
  DND.from = -1;
  DND.slot = -1;
  DND.lastY = 0;
  DND.edge = 0;
  DND.lines = null;
  DND.ghost = null;
  DND.line = null;
  DND.srcEl = null;
  DND.ghostH = 0;
}

/* ---------- 右键菜单（todo.pyw:1041-1072, 1463-1486） ---------- */

function showMenu(items, x, y) {
  menuEl.textContent = '';
  for (const it of items) {
    if (it === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menuEl.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'menu-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { hideMenu(); it.fn(); });
    menuEl.appendChild(el);
  }
  menuEl.style.display = 'block';
  const rect = menuEl.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 2;
  const maxY = window.innerHeight - rect.height - 2;
  menuEl.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
}

function hideMenu() { menuEl.style.display = 'none'; }

function menuRow(i, x, y) {
  const ln = S.lines[i];
  const items = [];
  if (ln.kind === 'header') {
    items.push({ label: '在此分组添加待办', fn: () => insertLine(i, 'todo', nextTodoIndent(i), '新待办') });
    items.push({ label: '在下方插入分组', fn: () => insertGroup(i) });
    items.push({ label: '重命名分组', fn: () => editRow(i) });
    items.push({ label: '删除分组标题', fn: () => deleteLine(i) });
  } else if (ln.kind === 'todo') {
    items.push({ label: '在下方插入待办', fn: () => insertLine(i, 'todo', ln.indent, '新待办', { pos: md.subtreeEnd(S.lines, i) - 1 }) });
    items.push({ label: '打开详情面板', fn: () => openPanel(i) });
    items.push({ label: '在下方插入分组', fn: () => insertGroup(i) });
    items.push('sep');
    items.push({ label: '编辑', fn: () => editRow(i) });
    items.push({ label: '删除', fn: () => deleteLine(i) });
  } else if (ln.kind === 'note') {
    items.push({ label: '在下方插入注释', fn: () => insertLine(i, 'note', ln.indent, '') });
    items.push({ label: '在下方插入分组', fn: () => insertGroup(i) });
    items.push({ label: '编辑', fn: () => editRow(i) });
    items.push({ label: '删除', fn: () => deleteLine(i) });
  } else {
    return;
  }
  showMenu(items, x, y);
}

function menuBlank(x, y) {
  showMenu([
    { label: '在末尾添加待办', fn: addTodoEnd },
    { label: '在末尾添加分组', fn: () => insertGroup(S.lines.length - 1) },
    'sep',
    { label: '退出', fn: exitApp },
  ], x, y);
}

/* 原“右键标题栏”菜单（更换文件… / 打开文件位置 / 退出）已整块删除，前两项改由顶栏常驻图标接管
   （退出已有 ✕）。删而不是修的原因：Tauri 2 注入的 window/scripts/drag.js 在 document 上注册
   冒泡期 mousedown，命中 data-tauri-drag-region 时 preventDefault + stopImmediatePropagation +
   invoke start_dragging；它注册得比页面脚本早，所以这里冒泡期的“点菜单外面关掉”永远收不到 ——
   菜单点开后点标题栏关不掉（四个按钮在 CLICKABLE_TAGS 里，所以点按钮本来就能关）。
   常驻图标没有开合状态，直接绕开整类问题；右键标题栏现在什么也不发生（全局 contextmenu
   preventDefault 兜掉 WebView2 默认菜单，见 bindChrome）。 */

/* ---------- 详情面板（todo.pyw:1074-1261） ---------- */

function locateAnchor() {
  const [text, units] = S.panelAnchor;
  for (let k = 0; k < S.lines.length; k += 1) {
    const ln = S.lines[k];
    if (ln.kind === 'todo' && ln.text === text && md.indentUnits(ln.indent) === units) return k;
  }
  return -1;
}

function openPanel(i) {
  const ln = S.lines[i];
  S.panelAnchor = [ln.text, md.indentUnits(ln.indent)];
  S.panelTodo = i;
  S.panelOpen = true;
  invoke('panel_open');
  pushPanelData();
}

function closePanel() {
  if (!S.panelOpen) return;
  S.panelOpen = false;
  S.panelTodo = -1;
  S.panelAnchor = null;
  resolveCommit();
  invoke('panel_close');
  emitTo('panel', 'panel-hide', {});
  log('panel closed');
}

function refreshPanel(focusIdx) {
  if (!S.panelOpen) return;
  pushPanelData(focusIdx);
}

function pushPanelData(focusIdx) {
  if (!S.panelOpen) return;
  const i = locateAnchor();
  if (i < 0) {
    log('panel target gone -> close');
    closePanel();
    return;
  }
  S.panelTodo = i;
  const [todos, notes] = md.panelParts(S.lines, i);
  emitTo('panel', 'panel-data', {
    title: S.lines[i].text,
    todos: todos.map((j) => ({ j, checked: S.lines[j].checked, text: S.lines[j].text })),
    notes: notes.map((j) => ({ j, text: S.lines[j].text })),
    focusIdx: focusIdx === undefined ? null : focusIdx,
  });
}

/* 面板编辑需先落定再动清单（Tk _commit_edits 的跨窗口等价物） */
function requestPanelCommit() {
  if (!S.panelOpen) return Promise.resolve();
  const p = new Promise((res) => { S.commitWaiter = res; });
  emitTo('panel', 'panel-commit', {});
  setTimeout(() => { if (S.commitWaiter === res) { S.commitWaiter = null; res(); } }, 400);
  return p;
}

function resolveCommit() {
  if (S.commitWaiter) { const r = S.commitWaiter; S.commitWaiter = null; r(); }
}

function panelReqHandler(ev) {
  const d = ev.payload || {};
  switch (d.type) {
    case 'toggle':
      toggleLine(d.j);
      break;
    case 'edit-commit':
      // Tk p_edit commit(1323-1333)：push_undo/set_line_text/render_list/schedule_save
      if (d.j >= 0 && d.j < S.lines.length) {
        pushUndo();
        md.setLineText(S.lines[d.j], d.value);
        renderList();
        scheduleSave();
      }
      resolveCommit();
      break;
    case 'edit-cancel':
    case 'rename-cancel':
      resolveCommit();
      refreshPanel();
      break;
    case 'rename': {
      // Tk p_rename commit(1379-1393)：先恢复标题，改字后同步锚
      const i = S.panelTodo;
      if (i >= 0 && i < S.lines.length) {
        pushUndo();
        md.setLineText(S.lines[i], d.value);
        const ln = S.lines[i];
        S.panelAnchor = [ln.text, md.indentUnits(ln.indent)];
        renderList();
        scheduleSave();
      }
      resolveCommit();
      break;
    }
    case 'delete':
      deleteLine(d.j);
      break;
    case 'add-todo':
      pAddTodo();
      break;
    case 'add-note':
      pAddNote();
      break;
    case 'move': {
      // 0.4.0：面板里拖动排序（只在同一栏内，跨栏不合法）。真搬行只在这里做。
      const to = d.where === 'before' ? d.anchor : md.blockEnd(S.lines, d.anchor);
      if (md.canMove(S.lines, d.from, to)) {
        pushUndo();
        S.lines = md.moveBlock(S.lines, d.from, to, S.nl);
        renderList();
        scheduleSave();   // renderList 已经顺带 refreshPanel，面板行会重建
        log(`panel drag move ${d.from} -> ${to}`);
      }
      break;
    }
    case 'close':
      closePanel();
      break;
    case 'ack':
      resolveCommit();
      break;
    case 'edit-state':
      S.panelEditing = !!d.editing;
      break;
    default:
      break;
  }
}

function pAddTodo() {
  // todo.pyw:1435-1443
  const i = S.panelTodo;
  if (!(i >= 0 && i < S.lines.length)) return;
  const [todos] = md.panelParts(S.lines, i);
  const pos = todos.length ? todos[todos.length - 1] : i;
  insertLine(pos, 'todo', md.childIndent(S.lines[i]), '新待办', { inPanel: true });
}

function pAddNote() {
  // todo.pyw:1445-1452
  const i = S.panelTodo;
  if (!(i >= 0 && i < S.lines.length)) return;
  const pos = md.subtreeEnd(S.lines, i) - 1;
  insertLine(pos, 'note', md.childIndent(S.lines[i]), '', { inPanel: true });
}

/* ---------- 文件/窗口杂项（todo.pyw:1488-1538） ---------- */

async function chooseFile() {
  const path = await invoke('choose_file');
  if (path) {
    S.file = path;
    S.missingShown = false;
    await loadFile();
    invoke('save_config');
  }
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
    const st = await invoke('poll_tick');   // Win32 维护（贴桌面/面板置顶/离屏救援/配置落盘）在 Rust 侧
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
    await requestPanelCommit();
    closeEditor();
    closePanel();
    cancelSave();
    if (await writeText(md.serialize(S.lines))) {
      log(`saved ${S.lines.length} lines`);
    }
  } catch (e) { /* Tk on_close 同款吞异常 */ }
  log('exit');
  invoke('exit_app');   // Rust 写 config 后退出
}

/* ---------- 顶栏/把手绑定 ---------- */

/* 顶栏图标（内联单色 SVG，风格同 GRIP_SVG / boxSvg）：viewBox 13 与显示尺寸 1:1，
   坐标落在 .5 上，1px 线才不发虚。13px 画在 .hbtn 的 30×26 热区正中。
   更换文件 = 纯文档页（矩形 + 右上折角），不叠箭头 —— 13px 下两笔会糊；
   打开文件位置 = ↗，与资源管理器“在文件夹中显示”同义。 */
const ICON_CHOOSE_SVG = '<svg viewBox="0 0 13 13" fill="none">'
  + '<path d="M2.5 1.5H7.5L10.5 4.5V11.5H2.5Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  + '<path d="M7.5 1.5V4.5H10.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  + '</svg>';
const ICON_REVEAL_SVG = '<svg viewBox="0 0 13 13" fill="none">'
  + '<path d="M3.5 9.5L9.5 3.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>'
  + '<path d="M6.5 3.5H9.5V6.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg>';

function bindChrome() {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('btn-close', exitApp);
  on('btn-refresh', refreshFromDisk);
  on('btn-pin', toggleDock);
  on('btn-add', addTodoEnd);
  // 两个常驻图标接管原“右键标题栏”菜单的前两项。文件缺失（S.missingShown）时两者仍可用：
  // 更换文件正是缺失时唯一的出路；↗ 交给 Rust 侧的“路径不存在”提示，不静默失败。
  on('btn-choose', chooseFile);
  on('btn-reveal', () => invoke('open_file_location', { file: S.file }));
  $('btn-choose').innerHTML = ICON_CHOOSE_SVG;
  $('btn-reveal').innerHTML = ICON_REVEAL_SVG;
  // Tk 按钮按下不夺焦点（Canvas 无焦点），防止空格键误触
  for (const id of ['btn-close', 'btn-refresh', 'btn-pin', 'btn-add', 'btn-choose', 'btn-reveal']) {
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
  // 列表空白（含尾部 padding）
  listEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menuBlank(e.clientX, e.clientY);
  });
  // Ctrl+Z（todo.pyw:510, 1009-1023）
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (S.edit || S.panelEditing || !S.undoStack.canUndo()) return;
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      if (DND.on) { e.preventDefault(); cleanupDrag(); return; }   // 0.4.0：Esc 取消拖动
      hideMenu();
    }
  });
  // 拖动中右键 = 取消（捕获阶段，顺手吞掉这一下的行菜单）
  document.addEventListener('contextmenu', (e) => {
    if (!DND.on) return;
    e.preventDefault();
    e.stopPropagation();
    cleanupDrag();
  }, true);
  // 点击菜单外关闭（捕获阶段：理由同上，冒泡期会被拖动区处理吞掉，#4）
  document.addEventListener('mousedown', (e) => {
    if (!menuEl.contains(e.target)) hideMenu();
  }, true);
}

/* ---------- 启动 ---------- */

async function boot() {
  const info = await invoke('app_info');
  S.file = info.file;
  S.docked = info.docked !== undefined ? !!info.docked : false;
  setTitle(info.title || '桌面待办');
  updateDockButton();

  bindChrome();
  await window.__TAURI__.event.listen('panel-req', panelReqHandler);
  await window.__TAURI__.event.listen('app-exit-request', () => exitApp());
  await window.__TAURI__.event.listen('dock-changed', (e) => {
    // 托盘菜单切模式时由 Rust 广播：按状态重算，别信本地翻转
    S.docked = !!e.payload;
    updateDockButton();
  });
  await window.__TAURI__.event.listen('panel-close', () => {
    // Rust 侧面板被系统关闭（Alt+F4 等）→ 主窗口同步清状态
    S.panelOpen = false;
    S.panelTodo = -1;
    S.panelAnchor = null;
    resolveCommit();
  });
  await window.__TAURI__.event.listen('panel-ready', () => {
    // 面板页监听就绪：首次打开时 panel-data 可能早于 panel.js 加载而丢失，这里补推
    log('panel ready');
    if (S.panelOpen) pushPanelData();
  });

  await loadFile();
  pollTick();   // Tk 启动时先跑一轮 poll 再进入循环
}

boot().catch((e) => log(`boot error: ${e}`));
