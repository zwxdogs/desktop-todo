/* 桌面待办 0.4.0 详情面板逻辑（panel.html）。
   与 todo.pyw (0.2.7) 的 p_* 系列函数对应：
   - 数据由主窗口经协议推来（Tk render_panel 的远端等价物）
   - 操作经协议回传主窗口应用（Tk 直接改 self.lines 的远端等价物）
   - 内联编辑/标题改名在本地进行，落定时回传（Tk p_edit/p_rename 的 commit/cancel）
   0.4.0 新增：两栏各自的拖动排序（跨栏不合法；真搬行仍由主窗口执行）。
   #16 起跨窗消息全走 panelproto.js：消息名、方向、字段只在那张表里定义，
   这里只装三个处理函数（data / flush / hide），按名字发操作。 */

'use strict';

import { attachScrollbar } from './scrollbar.js';
import { plusButton } from './plus.js';
import { createRowDrag, panelDropTarget, GRIP_SVG } from './rowdrag.js';
import { createMenu } from './rowmenu.js';
import { openRowEdit } from './rowedit.js';
import { connect, PANEL, requireHost } from './panelproto.js';

/* 宿主对象只取一次（与 app.js 同一个 host() 形状）：Tauri 的 withGlobalTauri
   把它作为初始化脚本注入，早于任何页面脚本，所以取不到就是真没注入。 */
let HOST = null;
function host() {
  if (!HOST) HOST = requireHost();
  return HOST;
}

const log = (msg) => {
  try { host().core.invoke('log_line', { msg: 'panel: ' + msg }); } catch (_) {
    // 连宿主对象都拿不到：只能落在 devtools 控制台
    console.error('panel: ' + msg);
  }
};
/* 先挂错误钩子：下面任何一步抛错都要留痕（ADR 0008 的同类处理） */
window.onerror = (msg, src, line) => { log('js error: ' + msg + ' @' + src + ':' + line); };
window.onunhandledrejection = (ev) => { log('js rejection: ' + ev.reason); };

/* 两窗走同一个 connect：链路、握手、落定都由协议模块负责。 */
const proto = connect({ side: PANEL, getHost: host, log });

const $ = (id) => document.getElementById(id);
const titleEl = $('panel-title');
const titleEdit = $('panel-title-edit');
const paneTodo = $('pane-todos');
const paneNote = $('pane-notes');
// 自绘滚动条（0.4.1）：两栏各一条，各自独立显隐
const scrollTodos = attachScrollbar(paneTodo);
const scrollNotes = attachScrollbar(paneNote);

const P = {
  data: null,          // 最近一次 data
  edit: null,          // { j, input, handle }
  renaming: false,
};

/* 面板对清单的一次操作：proto.send 按协议表校验名字与字段，发错当场抛。 */
function setEditing(on) { proto.send('editing', { on }); }

/* ---------- 行构建（Tk p_build_row 1263-1303：全部顶格 pad=12） ---------- */

function boxSvg(checked) {
  if (checked) {
    return '<svg viewBox="0 0 18 18" fill="none">' +
      '<rect x="2" y="2" width="14" height="14" fill="#4A8FE2" stroke="#4A8FE2"/>' +
      '<polyline points="5,9 8,12 13,5" stroke="#FFFFFF" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  }
  return '<svg viewBox="0 0 18 18" fill="none">' +
    '<rect x="2" y="2" width="14" height="14" fill="none" stroke="#C6CCD4" stroke-width="1"/></svg>';
}

/* 删除/插行之前先把未定稿的内联编辑落回去（Tk delete_line 前的 _commit_edits）。
   顺序要紧：先 teardown 再发——主窗口回推新一轮数据时若还挂着 P.edit，
   onData 会再落一遍并 return，把那一轮渲染吞掉（新行就进不了编辑）。 */
function commitPending() {
  for (const op of harvest('deliver')) proto.sendOp(op);
}

function pMenu(j, x, y) {
  // Tk p_menu(1422-1433)：子待办是叶子，只有编辑与删除
  menu.show([
    { label: '编辑', fn: () => pEdit(j) },
    { label: '删除', fn: () => {
        // Tk delete_line 前会 _commit_edits：先落定未定稿编辑再删
        commitPending();
        proto.send('remove', { j });
      } },
  ], x, y);
}

function buildRow(container, item, isTodo) {
  const row = document.createElement('div');
  row.className = `row row-${item.kind}`;
  row.dataset.j = String(item.j);
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pMenu(item.j, e.clientX, e.clientY);
  });

  if (isTodo) {
    const box = document.createElement('span');
    box.className = 'box';
    box.innerHTML = boxSvg(item.checked);
    box.style.marginLeft = '12px';
    box.addEventListener('click', () => proto.send('toggle', { j: item.j }));
    row.appendChild(box);
  }

  const lbl = document.createElement('div');
  const done = isTodo && item.checked;
  lbl.className = 'label' + (done ? ' done' : '');
  const kind = isTodo ? 'todo' : 'note';
  lbl.textContent = kind === 'note' ? '• ' + item.text : item.text;
  if (kind !== 'todo') {
    lbl.style.paddingLeft = '12px';
    if (item.checked) lbl.classList.add('done');
  }
  lbl.addEventListener('dblclick', () => pEdit(item.j));
  row.appendChild(lbl);
  addHandle(row, item.j, container);   // 0.4.0：拖动手柄
  addPlus(row, item.j, kind);          // ADR 0007：在这行下面插一条同类条目
  container.appendChild(row);
  return lbl;
}

/* ---------- 拖动排序（0.4.0；0.4.2 收进 rowdrag.js）----------
   两栏各自排序：子待办只与子待办换位，备注只与备注换位（跨栏不合法）。
   这里每栏一个适配器（政策：跨栏算不算同一个落点）；指针、浮层、插入线、自动滚、
   落点求解都在 rowdrag.js，落定后把「从哪行搬到哪行之前/之后」回传主窗口执行。 */

function paneRows(pane) {
  return [...pane.querySelectorAll('.row')].map((el) => ({ key: Number(el.dataset.j), el }));
}

function makePaneDrag(pane) {
  return createRowDrag({
    container: pane,
    rows: () => paneRows(pane),
    canStart: () => !P.edit && !P.renaming && !!P.data,
    ghost: (j) => {
      const row = paneRows(pane).find((r) => r.key === j);
      const lbl = row && row.el.querySelector('.label');
      return { text: lbl ? lbl.textContent.replace(/^• /, '') : '' };
    },
    resolve: (rows, y) => panelDropTarget(rows, pane.getBoundingClientRect(), y),
    lineRight: () => window.innerWidth - 8,
    onDrop: (from, target) => proto.send('move', { from, anchor: target.rowKey, where: target.where }),
  });
}

const dragTodo = makePaneDrag(paneTodo);
const dragNote = makePaneDrag(paneNote);
const dragFor = (pane) => (pane === paneTodo ? dragTodo : dragNote);
function anyDragOn() { return dragTodo.isOn() || dragNote.isOn(); }
function cleanupDrags() { dragTodo.cleanup(); dragNote.cleanup(); }

function addHandle(row, j, pane) {
  const h = document.createElement('span');
  h.className = 'drag-handle';
  h.innerHTML = GRIP_SVG;
  const drag = dragFor(pane);
  h.addEventListener('pointerdown', (e) => drag.start(e, h, j));
  h.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (drag.isOn()) { drag.cleanup(); return; }
    menu.hide();
    pMenu(j, e.clientX, e.clientY);
  });
  row.appendChild(h);
}

/* 行内加号（ADR 0007）：点它在这行下面插一条同类条目（子待办插兄弟，备注插备注）。
   先收掉未定稿的编辑，否则主窗口回推的新数据会被 onData 的提交逻辑吞掉。 */
function addPlus(row, j, kind) {
  const p = plusButton(kind === 'todo' ? '在下方添加子待办' : '在下方添加备注');
  p.addEventListener('click', (e) => {
    e.stopPropagation();
    commitPending();
    proto.send('addBelow', { kind, j });
  });
  p.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (anyDragOn()) { cleanupDrags(); return; }
    menu.hide();
    pMenu(j, e.clientX, e.clientY);
  });
  row.appendChild(p);
}

/* ---------- 渲染（Tk render_panel 1225-1261） ---------- */

function render(d) {
  if (anyDragOn()) cleanupDrags();   // 数据被重推（行要重建）时先收掉拖动浮层
  const s1 = paneTodo.scrollTop;
  const s2 = paneNote.scrollTop;
  titleEl.textContent = d.title;
  document.title = d.title;
  paneTodo.textContent = '';
  paneNote.textContent = '';
  let focusLabel = null;
  for (const t of d.todos) {
    const lbl = buildRow(paneTodo, { ...t, kind: 'todo' }, true);
    if (d.focusIdx != null && t.j === d.focusIdx) focusLabel = lbl;
  }
  for (const n of d.notes) {
    buildRow(paneNote, { ...n, kind: 'note' }, false);
  }
  paneTodo.scrollTop = s1;
  paneNote.scrollTop = s2;
  scrollTodos.refresh();    // 0.4.1：两栏行数变了，拇指长度重算（静默，不闪）
  scrollNotes.refresh();
  if (focusLabel) pEditAt(focusLabel);
}

/* ---------- 内联编辑（Tk p_edit 1305-1347） ---------- */

function pEdit(j) {
  if (P.edit || P.renaming) return;
  const lbl = findLabel(j);
  if (!lbl) return;
  pEditAt(lbl, j);
}

function pEditAt(lbl, j) {
  if (P.edit || P.renaming) return;
  const idx = j !== undefined ? j : labelIndex(lbl);
  if (idx == null) return;
  const handle = openRowEdit({
    label: lbl,
    text: lbl.textContent.replace(/^• /, ''),
    done: lbl.classList.contains('done'),
    onFinish: (v) => {
      if (!P.edit || P.edit.handle !== handle) return;
      const jj = P.edit.j;
      teardownEdit();
      commitEdit(jj, v);
    },
    onCancel: () => {
      if (!P.edit || P.edit.handle !== handle) return;
      const jj = P.edit.j;
      teardownEdit();
      proto.send('discardEdit', { j: jj });
      proto.send('editing', { on: false });
    },
  });
  P.edit = { j: idx, input: handle.input, handle };
  setEditing(true);
}

function labelIndex(lbl) {
  // 从 DOM 反查行号：遍历两栏
  const search = (pane, items) => {
    const rows = pane.querySelectorAll('.row .label');
    for (let k = 0; k < rows.length; k += 1) {
      if (rows[k] === lbl) return items[k] ? items[k].j : null;
    }
    return null;
  };
  const r = search(paneTodo, P.data.todos);
  return r != null ? r : search(paneNote, P.data.notes);
}

function findLabel(j) {
  const all = [...paneTodo.querySelectorAll('.row .label'),
               ...paneNote.querySelectorAll('.row .label')];
  const idx = [...P.data.todos.map((t) => t.j), ...P.data.notes.map((n) => n.j)].indexOf(j);
  return idx >= 0 ? all[idx] : null;
}

function teardownEdit() {
  if (!P.edit) return;
  const { handle } = P.edit;
  P.edit = null;
  handle.teardown();
}

function commitEdit(j, value) {
  // Tk p_edit commit(1323-1333)：主窗口应用后重推内容
  setEditing(false);
  proto.send('setText', { j, value });
}

/* ---------- 标题改名（Tk p_rename 1362-1420） ---------- */

function pRename() {
  if (P.edit || P.renaming || !P.data) return;
  P.renaming = true;
  setEditing(true);
  titleEdit.value = titleEl.textContent;
  titleEl.style.display = 'none';
  titleEdit.style.display = '';
  titleEdit.select();
  titleEdit.focus();
}

function teardownRename() {
  P.renaming = false;
  titleEdit.style.display = 'none';
  titleEl.style.display = '';
  setEditing(false);
}

titleEdit.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    const v = titleEdit.value;
    teardownRename();
    proto.send('rename', { value: v });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    teardownRename();
    proto.send('discardRename', {});
  }
});
titleEdit.addEventListener('blur', () => {
  if (P.renaming) {
    const v = titleEdit.value;
    teardownRename();
    proto.send('rename', { value: v });
  }
});
titleEdit.addEventListener('compositionend', () => titleEdit.focus());

/* ---------- 菜单 ---------- */

const menuEl = $('menu');
const menu = createMenu(menuEl);
// 与主窗口一致用捕获阶段：拖动区处理在 document 冒泡期吞掉事件（#4；本窗口暂无拖动区，防复制粘贴）
document.addEventListener('mousedown', (e) => {
  if (!menuEl.contains(e.target)) menu.hide();
}, true);
document.addEventListener('contextmenu', (e) => e.preventDefault());

/* 收起面板：先把未定稿的编辑交出去（Tk close_panel 开头就是 _commit_edits），
   再请主窗口关。内联编辑与标题改名都要交，否则点 ✕ 那一刻改了一半的标题会没。 */
function requestClose() {
  commitPending();   // harvest('deliver')：内联编辑与改名一起交，并清掉本地编辑态
  proto.send('close', {});
}
$('panel-x').addEventListener('click', requestClose);
$('panel-x').addEventListener('mousedown', (e) => e.preventDefault());
$('add-todo').addEventListener('click', () => { commitPending(); proto.send('addTodo', {}); });
$('add-note').addEventListener('click', () => { commitPending(); proto.send('addNote', {}); });
for (const id of ['panel-x', 'add-todo', 'add-note']) {
  $(id).addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
}
titleEl.addEventListener('dblclick', pRename);   // Tk 1132
$('hdr').addEventListener('contextmenu', (e) => { e.preventDefault(); });

/* Escape：先取消拖动，其次取消编辑/改名，否则关面板（Tk 1120 + 各 Entry 的 "break"） */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (anyDragOn()) { e.preventDefault(); cleanupDrags(); return; }
  if (P.edit || P.renaming) return;   // 编辑框自己的 handler 处理并 stopPropagation
  requestClose();
});

/* 拖动中右键 = 取消（捕获阶段，顺手吞掉这一下的行菜单） */
document.addEventListener('contextmenu', (e) => {
  if (!anyDragOn()) return;
  e.preventDefault();
  e.stopPropagation();
  cleanupDrags();
}, true);

/* ---------- 协议处理函数（表里的每一条收消息都在这儿有唯一实现） ---------- */

/* 把未定稿的编辑收成操作、并就地清掉本地编辑态。
   标题改名有两种政策，Tk 也是两种，所以这里明写出来：
   - 'deliver'：落定与收起时把改名交出去 —— 用户打的字不能丢。
   - 'drop'：数据被重推时丢弃改名（Tk _p_restore_title）—— 新一轮内容里的标题
     已经是权威的，再把手里这份旧值交上去会把它盖掉。
   内联编辑两种政策都是交出去（Tk 两种路径都先 _p_close_editor）。 */
function harvest(policy) {
  const ops = [];
  if (P.edit) {
    const { j, input } = P.edit;
    const value = input.value;
    teardownEdit();
    setEditing(false);
    ops.push(proto.op('setText', { j, value }));
  }
  if (P.renaming) {
    const value = titleEdit.value;
    teardownRename();   // 已含 setEditing(false)
    if (policy === 'deliver') ops.push(proto.op('rename', { value }));
  }
  return ops;
}

function onData(d) {
  log('data received: title=' + d.title + ' todos=' + d.todos.length + ' notes=' + d.notes.length);
  // Tk render_panel(1234-1235)：先 _p_close_editor（落定），再 _p_restore_title（丢弃改名）
  const ops = harvest('drop');
  if (ops.length) {
    for (const op of ops) proto.sendOp(op);   // 主窗口应用后会再推一轮数据
    return;                                    // 等下一轮 data 再渲染
  }
  P.data = d;
  render(d);
}

/* 主窗口请求落定：把未定稿的编辑交回去，再回显式回执。
   回执本身就是「面板本来要交什么」的完整答案，主窗口照着落，
   不再靠一个 400ms 墙钟猜「大概落定完了吧」。 */
function onFlush(m) {
  const ops = harvest('deliver');
  proto.send(proto.RECEIPT, { id: m.id, ops });
}

/* 面板被收起：清本地编辑态（Tk close_panel 清空状态）。
   未定稿的编辑在收起之前已经由 flush 交回去了，这里只丢本地壳。 */
function onHide() {
  if (P.edit) teardownEdit();
  if (P.renaming) teardownRename();
  setEditing(false);
}

(async () => {
  await proto.start({ data: onData, flush: onFlush, hide: onHide });
  log('ready');
})().catch((e) => log('init failed: ' + (e && e.message ? e.message : e)));
