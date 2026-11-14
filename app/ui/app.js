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
import { nextNotice, noticeAction } from './notice.js';
import {
  hasUnflushed, conflictPlan, nextConflict, isConflictOpen, conflictText, conflictFailText,
} from './extconflict.js';
import { fileNameOf } from './readfail.js';
import {
  classifyReadError, loadFailure, canWriteList, loadNoticeText,
} from './readfail.js';

/* 宿主对象由 Tauri 的初始化脚本在页面脚本**之前**写好（withGlobalTauri），
   所以取一次就够：取不到是真的没注入，requireHost 当场抛错（#16，不再惰性重试）。
   声明放在错误钩子之前——钩子里就用得到它，而 let 不像函数声明那样提升。 */
let HOST = null;
function host() {
  if (!HOST) HOST = requireHost();
  return HOST;
}
const invoke = (cmd, args) => host().core.invoke(cmd, args || {});

window.addEventListener('error', (ev) => {
  try {
    host().core.invoke('log_line', {
      msg: `js error: ${ev.message} @${ev.filename}:${ev.lineno}:${ev.colno}`,
    });
  } catch (_) { /* 连宿主对象都拿不到：没有能写日志的地方了 */ }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    host().core.invoke('log_line', { msg: `js rejection: ${ev.reason}` });
  } catch (_) { /* ignore */ }
});

const $ = (id) => document.getElementById(id);

/* 编辑目标消失时说的那句话：`commitEdit` 与 `closeEditor` 共用同一份文案。 */
const EDIT_GONE = '这一条已经不在了，刚才改的字没有写进去';
/* 一次性短消息挂多久（回执浮层也是 3 秒：两处各自计时，但时长只在这里定义一次）。 */
const INFO_NOTICE_MS = 3000;
const listEl = $('list');
const titleEl = $('title');
const menuEl = $('menu');
let mainScroll = null;   // 自绘滚动条（0.4.1；bindChrome 里挂到 listEl 上）

const S = {
  lines: [],       // 清单模块那份数组的镜像：每次重绘前由 render 钩子同步
  file: '',        // 最近一次从 Rust 命令采纳的路径：只原样转发给文件类命令，不自己拼
  loadedFile: '',  // 上一次真装载成功的是哪个文件；装载失败时清单模块的备份归属退回它（#20）
  title: '',       // 与 file 同时采纳的顶栏标题；装载成功后由 loadFile 落字（错误提示只是临时覆盖）
  lastSeen: null,
  docked: false,   // ADR 0004：false = 普通窗口（默认）；true = 固定在桌面（无任务栏图标）
  missingShown: false,
  loaded: false,   // 内存里的清单是否来自一次成功的读取；没装载成功就不许写盘（否则等于清空文件）
  loadFail: null,  // 这一次装载为什么失败（#21）：{kind,file} 或 null；判定与文案在 loadstate.js
  edit: null,            // { index, input, handle }
  panelOpen: false,
  panelEditing: false,   // 面板窗口里有未落定的编辑
  quitting: false,
};

/* 清单模块（list.js）：清单的唯一变更入口。每个意图在那边都有唯一实现，撤销栈、
   写盘合并窗口、面板锚点、行保真都在模块内部；这里只提供窗口自己的四件事：
   变更前收掉编辑框/面板、重绘、写盘、回执。换行符与 BOM 也由模块持有。 */
const list = createList({
  file: null,   // 身份在 adoptFile 里跟着 Rust 回传的路径走（备份要靠它判「是哪个清单」）
  hooks: {
    before: listBefore,
    render: (lines) => { S.lines = lines; renderList(); },
    write: (text) => writeText(text),
    /* 删除已完成的兜底（#20）：删前写同目录的 `待办-bak.md`，Ctrl+Z 在内存撤销栈
       被整份重载清掉之后靠它取回。路径由 Rust 从源文件派生，前端不拼文件名。 */
    backup: {
      write: (text, hasBom) => invoke('write_md_backup', { file: S.file, content: text, hasBom }),
      read: () => invoke('read_md_backup', { file: S.file }),
    },
    afterSave: (ok, n, err) => {
      if (ok) {
        log(`saved ${n} lines`);
        // 写成功：把上一次的「保存失败」收掉（短消息有自己的过期时间，不归这里管）
        setNotice({ type: 'saved' });
      } else {
        log(`save failed: ${err}`);
        // 写盘失败必须留在界面上：用户以为自己改了，文件里其实没有（#18 第三段）。
        // 原因来自 Rust 的 write_md（磁盘满 / 文件被占用 / 目录只读…），处置办法各不相同。
        setNotice({
          type: 'save-failed',
          text: `保存失败，改动没有写进文件：${err ? String(err.message || err) : '未知原因'}`,
        });
      }
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
   标题先不进界面——loadFile 读成功了才落字，免得新文件名配着旧文件的清单一起显示。

   清单模块那份 file 也在这里换：备份是「哪个清单的备份」，身份一换就作废（#20）。
   loadFile 的整份替换会再传一次（同值），它只是把这件事绑在「装载」这个动作上。 */
function adoptFile(raw) {
  const identity = readIdentity(raw);
  S.file = identity.file;
  S.title = identity.title;
  list.setFile(S.file);
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
   写成功后 JS 自记 lastSeen（Tk self.last_seen = stat_now()），否则 poll 误报外部变化并清撤销栈。

   写失败的原因要能到界面上（#18）：Rust 的 write_md 失败时抛 Err(原因)，这里不再把它
   咽成一个 false——吞掉之后提示条只能写「未知原因」，用户没法判断是磁盘满了还是文件被占着。
   抛给清单模块的 afterSave（它把 err 交给提示条）。

   命令成功时返回的是 Ok(()) = JS 侧的 undefined，所以「有没有写进去」由**是否抛错**表达，
   不看返回值：跑完没抛就是写进去了。

   #21：**这里是闸门本身，不只是入口置灰。** 读失败期间内存里那份清单不是文件的内容，
   任何一条把它写回文件的路都等于清空用户的东西；而入口有很多（勾选、面板、撤销、
   详情面板的勾/改/删、拖动排序、删除已完成、退出、切文件……），靠每一处都记得问一句
   `listReady()` 是守不住的——#21 复查就抓到「文件读完之后变非 UTF-8，面板还开着，
   在面板里勾一下就把旧内存写回去了」。所以判定放在这里：所有写盘都从这儿出去。 */
async function writeText(content) {
  if (!listReady()) {
    // 不是「这次写失败」，而是根本不许写。丢回一个明确的错误让调用方按失败处理，
    // 提示条那条装载失败已经在说为什么了，这里不再叠一条。
    log('write blocked: 清单未装载成功，拒绝写盘（#21）');
    throw new Error('清单没有装载成功，这次改动不会写进文件');
  }
  // 外部改动冲突弹层还开着（#22）：此刻磁盘上是**外部那份**，用户还没选「刷新 / 撤回」。
  // 任何一条把它写回去的路都会让外部改动凭空消失（撤回要留档的那份就没了），
  // 所以闸门也放在这里，而不只靠「按住 250ms 合并窗口」——撤销、删除已完成这些
  // 路径是直接写盘的，不经过那个窗口（与 #21 把闸门放在同一处是同一条理由）。
  if (conflictState) {
    log('write blocked: 外部改动冲突还没选（#22）');
    throw new Error('先选「刷新」或「撤回」，之后才能写盘');
  }
  try {
    await invoke('write_md', { file: S.file, content, hasBom: list.hasBom() });
    S.lastSeen = await statNow();
    return true;
  } catch (e) {
    log(`write failed: ${e}`);
    throw new Error(String(e));
  }
}

/* 同上，但失败不抛：切文件、新建、退出、点提示条重试这几条路径要「按失败继续」，
   不能因为一次写不进去就把后续动作（换文件 / 退出）也卡死。失败原因仍进日志。 */
async function saveQuietly(content) {
  try {
    return await writeText(content);
  } catch (e) {
    return false;
  }
}

/* ---------- 变更前收尾 + 撤销（todo.pyw:1000-1023） ----------
   「变更前要不要收掉编辑框、关掉面板」只在这里决定一次。清单模块每次真变更之前
   都会带着变更描述回调过来，十二处入口不再各自判断。 */
function listBefore(change) {
  const pi = list.panelIndex();   // 面板盯着的那一行；模块是锚的唯一所有者
  const ei = editIndex();         // 正在编辑的那一行现在在哪（-1 = 已经认不出来）
  if (change.kind === 'remove') {
    // 正在编辑的那行随删除一起消失：不提交，直接丢弃（todo.pyw:953-964）。
    // 但要说一声：用户刚打的字没了，静默丢掉是最糟的那种「成功」。
    if (ei >= change.index && ei < change.end) {
      discardEditor();
      showInfoNotice('正在编辑的这一条被删掉了，刚改的字没有写进去');
    }
    if (S.panelOpen && pi >= change.index && pi < change.end) closePanel();
  } else if (change.kind === 'deleteCompleted') {
    const covers = (k) => change.blocks.some((b) => b.i <= k && k < b.end);
    // 被删的那行不提交（丢字是用户要的），没被删的先落定，别把打的字丢了。
    // 批量删除本身有回执浮层报数，所以这一支不再叠一条短消息。
    if (S.edit) { if (covers(ei)) discardEditor(); else closeEditor(); }
    if (S.panelOpen && pi >= 0 && covers(pi)) closePanel();
  }
}

/* Ctrl+Z（todo.pyw:1009-1023；#20 加了「读回备份」这一层兜底）。
   顺序不能反：**先走内存撤销栈**。栈里一旦有东西，这次按键就归它——写失败也只报失败，
   绝不转去读备份（那会把一个更早的状态盖到当前清单上）。只有栈本身交不出来、而本次
   运行确实做过删除已完成、那批快照已被整份重载清掉时，才走备份。触发条件由清单模块
   持有（只有它知道那批删除有没有真的发生过），这里只负责把结果说给用户听。 */
async function undoNow() {
  hideToast();   // 回执只认「刚删完」那一刻：换了撤销目标就先收掉
  if (S.edit || S.panelEditing) return;
  // 外部改动冲突弹层还开着：此刻磁盘上是外部那份，撤销要先写盘才能换内存——
  // 写了就是替用户选了「撤回」，而他那两个选择还没做（#22）。快照留在栈里不动。
  if (conflictState) { log('undo blocked: 外部改动冲突还没选（#22）'); return; }
  if (list.canUndo()) {
    if (await list.undo()) log(`undo (left ${list.undoSize()} snapshots)`);
    else log('undo save failed');
    return;
  }
  if (!list.canRestoreBackup()) {
    log('undo: nothing to undo');
    return;
  }
  const r = await list.restoreBackup();
  if (r.ok) {
    log('undo from backup');
    // 文案不写死「待办-bak.md」：文件名跟着当前清单走（检查清单.md → 检查清单-bak.md）
    showInfoNotice('已取回删除前的清单（来自同目录的 -bak 备份）');
    return;
  }
  if (r.reason === 'read' || r.reason === 'write') {
    // 读/写失败要说明原因：这是「你的删除退不回来了」，不是一条可以忽略的日志
    log(`undo from backup failed: ${r.err || r.reason}`);
    setNotice({
      type: 'error',
      text: r.reason === 'write'
        ? '取回删除前的清单失败：写不进文件，清单没有改动'
        : `取回删除前的清单失败：读不动同目录的 -bak 备份${r.err ? `（${String(r.err.message || r.err)}）` : ''}`,
    });
    return;
  }
  // nothing / missing：备份不在了或不作数，这次 Ctrl+Z 就当什么也没发生
  log(`undo: no snapshot, backup ${r.reason}`);
}

/* ---------- 文件装载（todo.pyw:565-602） ---------- */

/* 装载失败之后清场：清单区清空（内存里那份不是文件的内容，不能继续画成「这就是你的清单」）,
   两枚跟着「有没有文件可显示」走的按钮置灰。两种失败共用这一步，差别只在顶上说什么。 */
function clearListView() {
  listEl.textContent = '';
  ROWS.clear();
  VIS.length = 0;
  drag.cleanup();   // 行都没了：拖动浮层/插入线也要收掉
  updateChrome();
}

/* 缺文件占位（0.4.0）：不再提「右键 → 更换文件…」（那条标题栏菜单已经整块删了），
   改成按顶栏图标的实际顺序报序号，用户照着点就行。序号每次现算，以后调按钮顺序
   这句话会自己跟着变，不会指错地方。0.4.2 起打开/新建合进同一枚下拉，
   starter.js 的 missingHint 只收一个序号，并说明动作在菜单里选。 */
function showMissing() {
  if (S.missingShown) return;
  S.missingShown = true;
  S.loaded = false;
  clearLoadFailure();   // 换成「文件不见了」的占位：顶上那条读不动的说明不再成立
  clearListView();
  const btnIdx = (id) => [...document.querySelectorAll('#hdr .hbtn')].indexOf($(id)) + 1;
  const div = document.createElement('div');
  div.className = 'missing';
  // 0.4.2 起打开/新建合在一枚下拉里，所以只报一个序号（starter.js 里说明菜单项）
  div.textContent = missingHint(btnIdx('btn-file'));
  listEl.appendChild(div);
}

/* 装载失败的两种「文件在、但读不进来」（#21）：清场，顶栏挂一条常驻、可点重试的说明。
   缺文件不走这里——它有 showMissing 那套占位文案（报图标序号）。

   编辑框与详情面板也一起收掉，**不落定**：它们指向的是上一次读进来的那份行，
   而那份内容现在既不是文件的内容、也不该写回去。留着它们只会让用户在幻觉上继续改。 */
function showLoadFailure(kind) {
  S.missingShown = false;
  S.loaded = false;
  S.loadFail = loadFailure({ file: S.file, kind });
  discardEditor();
  closePanel();
  clearListView();
  const text = loadNoticeText(S.loadFail);
  if (text) setNotice({ type: 'load-failed', text });
}

/* 装载成功 / 回到缺失态时，把上一次的装载失败收掉。
   只有「装载失败」这一种提示归这里清：保存失败说的是另一件事。
   只在**真的读成功**（loadFile 的读盘分支）与**换成缺失占位**时调——
   `renderList` 不能调它：清单每次变更都会重画，那会把这条提示悄悄收走（#21 复查修）。 */
function clearLoadFailure() {
  if (!S.loadFail) return;
  S.loadFail = null;
  setNotice({ type: 'load-ok' });
}

async function loadFile() {
  // 外部改动重载：丢弃尚未落盘的旧内存状态（Tk load_file 同样直接重读，不回写）。
  // 走到这里 = 「刷新」已被选中，或者内存里本来就没有未落盘的改动 —— 写盘该恢复常态，
  // 否则弹层关掉之后自动保存会一直按着、用户以为在保存其实一笔都没落（#22）。
  list.release();
  conflictState = null;
  paintConflict();
  list.cancelSave();
  if (!(await fileStateExists())) {
    showMissing();
    // 装载失败：#20 的备份归属退回「上一次真装载成功的那份」，凭据随之作废
    // （此时内存里的行仍属于它，而 S.file 已经是另一个文件了）
    list.setFile(S.loadedFile);
    log(`file missing: ${S.file}`);
    return;
  }
  let data;
  try {
    data = await invoke('read_md', { file: S.file });
  } catch (e) {
    // Rust 的三种前缀（files.rs 的 read）：missing / read / utf8。
    // 以前只认 missing，另外两种只写一行日志就 return —— 启动时用户看到的是一个空白窗口，
    // 以为文件丢了，去点「打开文件」还是同一个文件，死循环（#21）。
    const kind = classifyReadError(e);
    log(`load error (${kind}): ${e}`);
    if (kind === 'missing') {
      showMissing();
      log(`file missing: ${S.file}`);
    } else {
      showLoadFailure(kind);
    }
    // 记下「失败时这个文件长什么样」。不是为了自动重读（关掉占用它的程序、或者另存为 UTF-8，
    // 都可能不改 mtime），而是为了**别每秒重试一次**：轮询比的是 mtime:size，不记的话
    // 每一轮都会看见「变了」→ 重读 → 又失败，日志刷屏。真正的重试交给点上那条提示。
    S.lastSeen = await statNow();
    list.setFile(S.loadedFile);   // 同上传载失败：备份凭据不能挂在没读进来的文件上
    return;
  }
  clearLoadFailure();
  S.loaded = true;
  S.loadedFile = S.file;
  setTitle(S.title);   // 装载成功 = 回到当前文件名（清掉上一次「新建失败!」之类的临时提示）
  // 整份替换：换行符、BOM、撤销栈都交给清单模块，替换本身不写盘（外部改动重载，Tk 同款）。
  // file 一起带上：装载与「这份清单是哪个文件」是同一件事，两边不该有机会不一致（#20）。
  list.replaceAll({ lines: md.parseText(data.text), nl: data.nl, hasBom: data.has_bom, file: S.file });
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
  // 这里**不清**装载失败（#21）：renderList 每做一次变更都会跑（list.js 的 render 钩子），
  // 在读失败期间清掉它，就等于把「打不开 / 不是 UTF-8，点这里重试」那条提示悄悄收走。
  // 它只由 loadFile 装载成功后自己收（那才是「读得动」的证据）。
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

/* 正在编辑的那一行现在在哪（-1 = 它已经不在清单里，或认不准是哪一条）。
   编辑态存的是**行锚**不是下标：编辑期间插入、删除、拖动、外部重载都会让下标失效，
   拿旧下标提交就是「字写到别人头上」（#18）。 */
function editIndex() {
  return S.edit ? list.indexOfAnchor(S.edit.anchor) : -1;
}

function editRow(i) {
  if (S.missingShown) return;
  const info = ROWS.get(i);
  if (!info || !info.label) return;
  if (S.edit && editIndex() === i) { S.edit.input.focus(); return; }
  if (S.edit) closeEditor();
  const ln = S.lines[i];
  if (!ln) return;
  const anchor = list.anchorAt(i);
  if (!anchor) return;
  const handle = openRowEdit({
    label: info.label,
    text: ln.text,
    done: ln.checked,
    onFinish: (v) => commitEdit(v),
    onCancel: () => cancelEdit(),
  });
  S.edit = { anchor, input: handle.input, handle };
}

/* 编辑框收拾干净：清状态、拆输入框、撤掉这一行的 editing 标记（DOM 由 rowedit.js 收） */
function dropEditor() {
  if (!S.edit) return;
  const entry = S.edit;
  S.edit = null;
  entry.handle.teardown();
}

/* 编辑框提交（todo.pyw:854-864）：值不做 trim，空文本照写。
   落字前先按锚找回它自己：找不到就明确丢弃并提示，绝不退回旧下标。 */
function commitEdit(value) {
  if (!S.edit) return;
  const anchor = S.edit.anchor;
  const v = value !== undefined ? value : S.edit.input.value;
  dropEditor();
  const index = list.indexOfAnchor(anchor);
  if (index < 0) {
    showInfoNotice(EDIT_GONE);
    renderList();
    return;
  }
  list.setText(index, v);
}

function cancelEdit() {
  if (!S.edit) return;
  dropEditor();
  renderList();
}

/* 静默提交不重渲染（todo.pyw:879-890 close_editor）。
   这是「点别处 / 点顶栏 / 切文件」那一类收尾，也必须按锚落字。 */
function closeEditor() {
  if (!S.edit) return;
  const { anchor, input } = S.edit;
  dropEditor();
  const index = list.indexOfAnchor(anchor);
  if (index < 0) {
    showInfoNotice(EDIT_GONE);
    return;
  }
  try {
    list.setText(index, input.value, { quiet: true });
  } catch (e) { /*Tk 同款吞异常*/ }
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

/* 清单可写：文件读进来过、且没停在「读不进来」或「文件不见了」的状态。
   判定本身在 loadstate.js（有测试）：读失败时**绝不能**可写——内存里那份不是文件的内容，
   退出或随手勾一下就会把它写回文件，等于清空用户的清单（#21 验收第 4 条）。 */
function listReady() {
  return !S.missingShown && canWriteList({ loaded: S.loaded, failure: S.loadFail });
}

/* 批量删除已完成（用户拍板）：只看顶层待办自己的勾选，勾了就整块删。
   不弹确认框；删完在窗口底部给一条 3 秒的回执，点它就撤销整批（Q4 A）。
   整批只压一个快照：浮在半空的编辑先落定，之后才是这一批那一个 —— 回执点一下、
   或 Ctrl+Z 一次就退回去。编辑框与面板的收尾由 listBefore 统一处理。

   #20：删之前先写同目录的 `待办-bak.md`（清单模块内做）。写不成就不删，并说明原因——
   宁可这次删不掉，也不能删了没法撤。 */
async function deleteCompletedTodos() {
  if (!listReady()) return;
  await flushPanel();   // 详情面板里改了一半的先落回来
  const r = await list.deleteCompleted();
  if (!r) return;
  if (!r.ok) {
    const why = r.err ? String(r.err.message || r.err) : '未知原因';
    log(`backup failed, delete cancelled: ${why}`);
    setNotice({ type: 'error', text: `没能写备份文件，这次没有删除：${why}` });
    return;
  }
  setNotice({ type: 'dismiss-error' });   // 上一次没删成的说明到此为止：这次成了
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
  toastTimer = setTimeout(hideToast, INFO_NOTICE_MS);
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
    disabled: !listReady(),
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

/* ---------- 顶栏提示条（#18 第三段） ----------
   状态机在 notice.js（纯函数、有测试）：这里只负责把状态画出来、管定时器、接点击。
   为什么需要它：写盘失败以前只进 widget.log，用户看到的是打字、回车、待办正常显示，
   而文件里没有。桌面挂件上「改了却没写进去」必须当场看得见。 */
const noticeEl = $('notice');
let noticeState = null;   // 形状与迁移全在 notice.js：save / info / error（后两者见那边的注释）
let noticeTimer = null;
let noticeToken = 0;

function setNotice(ev) {
  noticeState = nextNotice(noticeState, ev);
  paintNotice();
}

/* 一次性短消息：约 3 秒自己收掉。写盘失败还挂着时它不会顶上去（notice.js 里的政策）。 */
function showInfoNotice(text) {
  noticeToken += 1;
  const token = noticeToken;
  setNotice({ type: 'info', text, token });
  if (noticeState && noticeState.kind === 'info' && noticeState.token === token) {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      setNotice({ type: 'expire', token });
    }, INFO_NOTICE_MS);
  }
}

function paintNotice() {
  if (!noticeEl) return;
  const s = noticeState;
  const action = noticeAction(s);
  noticeEl.textContent = s ? s.text : '';
  noticeEl.classList.toggle('show', !!s);
  noticeEl.classList.toggle('kind-save', !!s && s.kind === 'save');
  noticeEl.classList.toggle('kind-load', !!s && s.kind === 'load');
  noticeEl.classList.toggle('kind-info', !!s && s.kind === 'info');
  noticeEl.classList.toggle('kind-error', !!s && s.kind === 'error');
  // 两种可点各有各的动作：写盘失败是重试保存，装载失败是重新读那个文件（#21）
  noticeEl.title = action === 'retry-save' ? '点这里重试保存'
    : action === 'retry-load' ? '点这里重新读一次文件' : '';
  // 能点时它是个按钮：不给键盘用户留一个「看得见点不到」的死角
  if (action) {
    noticeEl.setAttribute('role', 'button');
    noticeEl.setAttribute('tabindex', '0');
  } else {
    noticeEl.setAttribute('role', 'alert');
    noticeEl.removeAttribute('tabindex');
  }
}

/* 点写盘失败那条 = 重试：把当前清单再写一次（成功的分支会自己把提示收掉）。 */
async function retrySave() {
  if (noticeAction(noticeState) !== 'retry-save') return;
  if (!listReady()) return;
  const ok = await saveQuietly(list.text());
  if (ok) setNotice({ type: 'saved' });
}

/* 点装载失败那条 = 重试读取（#21）：重新走一趟 loadFile，成功就照常显示清单，
   失败就换成新的那条说法。文件被占用时用户关掉占用它的程序，点一下这里就好了。
   与写盘那条共用同一个位置，所以动作按当前状态分派，不各自抢 click。 */
async function retryLoad() {
  if (noticeAction(noticeState) !== 'retry-load') return;
  log(`retry load: ${S.file}`);
  await loadFile();
}

function noticeClick() {
  const action = noticeAction(noticeState);
  if (action === 'retry-save') retrySave();
  else if (action === 'retry-load') retryLoad();
}

/* ---------- 外部改动冲突弹层（#22） ----------
   判定在 extconflict.js（纯函数、有测试）：这里只负责把状态画出来、接两个按钮。
   为什么需要它：轮询发现文件变了就 `loadFile()`，而它开头是 `list.cancelSave()` ——
   250ms 写盘窗口里还没落盘的那几笔直接丢，撤销栈也被整份重载清空。单机少见，
   上同步盘（Obsidian 同步、另一台机器推送）就是日常。

   政策是维护者拍的板（票 #22）：**只在有未落盘改动时才弹**。没有就照旧静默重载
   ——那时内存与磁盘没有差别，刷新本来就无感，而同步盘可能每分钟写一次，每次都弹
   就是弹窗地狱。「撤回」整份覆盖、不做合并：Markdown 待办清单没有可靠的合并语义。 */
const conflictEl = $('conflict');
let conflictState = null;   // 形状与迁移全在 extconflict.js：null | { kind: 'conflict', reason? }

function paintConflict() {
  if (!conflictEl) return;
  const s = conflictState;
  const wasOpen = conflictEl.classList.contains('show');
  conflictEl.classList.toggle('show', !!s);
  const reasonEl = $('conflict-reason');
  if (reasonEl) {
    const reason = s && s.reason;
    reasonEl.textContent = reason ? conflictFailText(reason) : '';
    reasonEl.classList.toggle('show', !!reason);
  }
  // 只在弹层刚打开时搬焦点：每次重绘都 focus 会把用户刚用 Tab 挪走的焦点抢回来
  if (s && !wasOpen) {
    // 键盘用户落在「撤回」上（保住字的那一个是主要动作），Tab 能到「刷新」
    const revert = $('conflict-revert');
    if (revert) revert.focus();
  }
}

function setConflict(ev) {
  conflictState = nextConflict(conflictState, ev);
  paintConflict();
}

/* 外部改动落到界面上的唯一入口：先判断有没有字可丢，再决定是弹还是静默重载。

   **判定要用落定之前的状态，按住要早于任何 await。** 两步的顺序是这条路的正确性：
   1. 先按**落定之前**的三个来源判定有没有未落盘的东西。落定会把 `S.edit` 清零、
      把字变成一次排着的写盘，落定之后再问就永远只剩 `list.pending()` 一条了。
   2. 要弹就**先** `list.hold()`，再 `flushPanel()` / `closeEditor()`。`flushPanel` 是
      跨窗口往返，这期间一次**早就排好**的 250ms 写盘可能正好到点：那一笔落下去就把
      磁盘上的外部内容盖掉了，接下来的「撤回」会拿用户自己的字去当外部那份留档。
      先按住就不存在这个窗口。 */
async function externalChanged() {
  if (isConflictOpen(conflictState)) {
    log('external change during conflict prompt: held');
    return;
  }
  // 缺失态 / 没装载成功：内存里没有「用户此刻看到的清单」可言，没有字可丢，
  // 也没有「刷新还是撤回」可问——直接走常规重载（#21 的读失败重试也在这条路上：
  // 用户把编码改好、或关掉占用它的程序，mtime 一变就自动读回来）。
  if (S.missingShown || !listReady()) {
    await loadFile();
    return;
  }
  const hasLocal = hasUnflushed({
    pending: list.pending(),
    editing: !!S.edit,
    panelEditing: S.panelEditing,
  });
  if (conflictPlan(conflictState, { hasLocal }) === 'reload') {
    log('external change -> silent reload');
    await loadFile();
    return;
  }
  list.hold();                    // 先按住写盘，再做任何 await：外部那份必须还在盘上
  log('external change with unflushed local edits -> ask');
  // 弹层出现之前把当前编辑落定：这一刻之后内存里就是「用户此刻看到的东西」
  if (S.panelEditing) await flushPanel();
  closeEditor();
  setConflictText();
  setConflict({ type: 'external', hasLocal });
}

/* 弹层的文案里要带当前文件名（不写死「待办.md」：清单可能叫 检查清单.md）。 */
function setConflictText() {
  const t = $('conflict-text');
  if (t) t.textContent = conflictText(fileNameOf(S.file));
}

/* 刷新 = 丢弃内存，直接重读文件（弹层出现之前的行为）。 */
async function conflictRefresh() {
  if (!conflictState) return;
  log('conflict: refresh (discard memory and reload)');
  setConflict({ type: 'refresh' });
  list.release();
  await loadFile();
}

/* 撤回 = 先把磁盘上那份外部内容原子写进同目录的 -out-bak，**成功之后**再把内存内容
   整份写回原文件。顺序就是这条路的全部正确性：写备份失败时绝不覆盖源文件，
   否则外部改动凭空消失、备份也没落地（票 #22 的硬性要求）。

   弹层里点「撤回」与「退出时弹层还开着」走的是同一趟（`archiveAndWriteBack`），
   收在一处：两种入口对「外部那份必须留档、留不下就不写」的要求完全相同。

   失败时弹层留着并挂上原因：用户此刻还能改选「刷新」，关掉弹层等于替他选了「刷新」。 */
async function archiveAndWriteBack() {
  return invoke('revert_md_external', {
    file: S.file,
    content: list.text(),
    hasBom: list.hasBom(),
  });
}

async function conflictRevert() {
  if (!conflictState) return;
  if (!listReady()) {
    setConflict({ type: 'failed', reason: '清单没有装载成功，这次改动不可能写进文件' });
    return;
  }
  log('conflict: revert (archive external version, then write memory back)');
  let res;
  try {
    res = await archiveAndWriteBack();
  } catch (e) {
    log(`revert failed: ${e}`);
    // 原文件一个字节没动（Rust 的顺序保证），弹层留着让用户改选「刷新」
    setConflict({ type: 'failed', reason: String((e && e.message) || e) });
    return;
  }
  setConflict({ type: 'revert' });
  list.release();                 // 撤回落完盘：之后照常自动保存
  if (res && res.backup) log(`external archived to ${res.backup}`);
  showInfoNotice('外部改动已存进同目录的 -out-bak 备份，文件恢复成你看到的版本');
  // 自己刚写下去的那一份：记下 mtime，否则下一轮轮询会把它当外部改动再弹一次
  S.lastSeen = await statNow();
}

/* 绑定与文案：两个按钮的字、遮罩点击、Tab 焦点。
   Esc 不接：两个按钮是这条路仅有的两个出口，Esc 该等于哪一个都不对
   （等于「刷新」会丢字，等于「撤回」会替你改文件）。
   点遮罩也不关（点空白等于「刷新」同样是替用户做决定），只把焦点收回卡面。 */
function bindConflict() {
  const title = $('conflict-title');
  if (title) title.textContent = '文件被外部改过了';
  const refresh = $('conflict-refresh');
  const revert = $('conflict-revert');
  if (refresh) refresh.textContent = '刷新';
  if (revert) revert.textContent = '撤回';
  if (!conflictEl) return;
  if (refresh) refresh.addEventListener('click', conflictRefresh);
  if (revert) revert.addEventListener('click', conflictRevert);
  conflictEl.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    // 点在遮罩（而不是卡面）上：焦点收回主要动作，别让它丢到后面的清单里
    if (e.target === conflictEl && revert) revert.focus();
  });
  conflictEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  conflictEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const order = [revert, refresh].filter(Boolean);
    if (!order.length) return;
    const at = order.indexOf(document.activeElement);
    const next = e.shiftKey ? at - 1 : at + 1;
    e.preventDefault();
    order[(next + order.length) % order.length].focus();
  });
}

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

/* 收起面板，但先把面板里未落定的编辑落回清单（#16 验收：关面板不丢字）。
   Tk close_panel 开头就是 _commit_edits，这里是它的跨窗口等价物。

   一律走一趟落定，不看 S.panelEditing：那条通知只是「面板里有没有字」的提示，
   漏收一条（面板刚起编辑、通知还在路上）就等于丢字。落定本身很便宜——
   面板没有未定稿就回一条空回执，一次往返而已，不值得拿正确性换。
   回执没来（面板页卡死）只记一条告警、照常收：这时把窗口留着不放更糟，
   而面板手里那份编辑它已经交不出来了。
   正在编辑的那行被删掉时走裸 closePanel —— 那时用户要的就是丢掉，与 Tk 同款。 */
async function closePanelSaving() {
  if (!S.panelOpen) return;
  if (!(await flushPanel())) log('panel close: 落定回执没来，面板里可能有字没落盘');
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
   #16：等面板的显式回执，回执里带着它本来要交的操作——照着落，不猜。
   返回 false = 没等到回执。调用方可以继续（面板页已经死了，它那份编辑本来就
   取不回来），但那是一条要记下来的告警，不是「大概落定完了吧」；
   退出那条路会把 false 记进日志，好让下一次排查有据可查。
   没握手时不发请求——协议自己也会挡（它记一条「还没握手」并回 null）。 */
async function flushPanel() {
  if (!S.panelOpen) return true;
  const ops = await panel.flush();
  if (ops === null) return false;
  for (const op of ops) applyPanelOp(op);
  return true;
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
  // 面板里有未落定的编辑：主窗口据此放过 Ctrl+Z 与退出前的收尾
  editing: (m) => { S.panelEditing = !!m.on; },
  /* 面板页（重新）握手：面板重载后本地状态全没了，得把当前内容再推一遍，
     否则它停在空白上直到下一次清单重画。 */
  hello: () => { if (S.panelOpen) pushPanelData(); },
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
   只负责重新装载并把它落进 config.json；详情面板还挂着旧文件的行，一并关掉。

   顺序与「谁来写盘」都要对，缺一个都会丢字：
   1. 先落定 —— 面板里没落定的编辑变成 list.setText，排进 250ms 写盘窗口。
   2. **马上把这一笔写下去** —— 紧接着的 loadFile 第一句就是 list.cancelSave()，
      否则刚排上的写盘会被它取消掉，面板里那份字只是进了内存、随即被新文件覆盖。
      身份此刻还是旧的，所以写到的是旧文件（正确目标）。
   3. 换身份、重新装载。

   第 2 步若写不进去，那几行字就真的没了（接下来 loadFile 会把内存整份换成新文件）。
   所以这里不能只记日志：先让人知道「切过去了，但旧文件里那几笔没写进去」，再继续切——
   停下来不切反而更糟，用户点的是「换文件」。 */
async function switchToFile(identity) {
  await closePanelSaving();          // 面板里改了一半的先落回清单（排写盘）
  if (list.pending()) {              // 排上了就立刻落盘，别让 loadFile 把它取消掉
    const ok = await saveQuietly(list.text());
    list.cancelSave();
    if (!ok) showInfoNotice('切走之前旧文件没写进去，刚才那几笔改动没能保住');
  }
  adoptFile(identity);
  S.missingShown = false;
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
  // 再把还没落盘的改动写回去：切走之后 S.lines 马上就换成新文件的内容。
  // 写失败要说一声：接下来 switchToFile 会把内存整份换掉，那几笔就真的没了。
  const pending = list.pending();
  list.cancelSave();
  closeEditor();
  if (pending && listReady() && !(await saveQuietly(list.text()))) {
    showInfoNotice('新建之前旧文件没写进去，刚才那几笔改动没能保住');
  }
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
        log('external change detected');
        // 有未落盘改动就弹层问「刷新 / 撤回」，没有就静默重载（#22）。
        // 弹层还开着时这里直接按住：既不再弹一次，也不偷偷重载。
        await externalChanged();
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
    // 弹层还开着就退出：内存里那份没落盘，而磁盘上是外部那份。退出时若直接写，
    // 外部改动就悄悄没了、备份也没落地——所以照「撤回」那套走一趟（先留档再写回）。
    // 留档失败就什么都不写：让文件停在外部那份上，那是唯一确定没丢掉的东西。
    if (conflictState) {
      try {
        await archiveAndWriteBack();
        log('exit: conflict open, external version archived before the final write');
      } catch (e) {
        log(`exit: conflict open, revert failed -> no write (${e})`);
        conflictState = null;
        paintConflict();
        list.release();
        log('exit');
        invoke('exit_app');
        return;
      }
      conflictState = null;
      paintConflict();
      list.release();
    }
    // 面板里没落定的编辑先交回清单，再写盘退出。回执没到就照常退——
    // 面板页已经答不上话了，干等只会让「关不掉」；但这一条要留下痕迹。
    if (!(await flushPanel())) log('exit: 面板落定回执没来，退出前可能有字没落盘');
    closeEditor();
    closePanel();          // 编辑已落定，这里只是收起窗口
    list.cancelSave();
    // 没装载成功就绝不写盘（0.4.0 修）：以前无条件写，退出一次就"生"出一个空文件，
    // 下次启动看着像本来就有文件，示例内容和新建引导再也不会出现；
    // 读取失败（#21：被占用 / 没权限 / 不是 UTF-8）时同理——内存里那份不是文件的内容，
    // 写回去就是把用户读不进来的清单清空。判定统一走 listReady()（含装载失败）。
    // 退出时写失败已经来不及在界面上说了（窗口马上就没了），所以只留日志，
    // 由 Rust 侧 exit 前那一次 persist 与磁盘状态兜底（#18 只负责「用着的时候看得见」）。
    if (listReady() && !(await saveQuietly(list.text()))) {
      log('exit: 退出前最后一次写盘失败');
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
  // 提示条：写盘失败那条点了重试保存，装载失败那条点了重新读文件（#21）
  if (noticeEl) {
    noticeEl.addEventListener('click', noticeClick);
    noticeEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!noticeIsClickable(noticeState)) return;
      e.preventDefault();
      noticeClick();
    });
    noticeEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  }
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
  // Ctrl+Z（todo.pyw:510, 1009-1023；#20：内存栈交不出来时才允许走备份）
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      // 清单不可写时这一次按键不接：撤销要先写盘，而读失败的当下内存里那份
      // 不是文件的内容——写回去就把它盖掉了（#21）。文件读得动之后照旧。
      if (!listReady()) return;
      // 外部改动冲突还没选（#22）：撤销要写盘，写了就等于替用户选了「撤回」
      if (conflictState) return;
      // 两个来源有一个能用就接过这次按键：光看栈会把「备份还能取回」那条路挡死
      if (!list.canUndo() && !list.canRestoreBackup()) return;
      if (S.edit || S.panelEditing) return;
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
  bindConflict();
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