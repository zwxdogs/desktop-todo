/* 桌面待办 0.4.0 详情面板逻辑（panel.html）。
   与 todo.pyw (0.2.7) 的 p_* 系列函数对应：
   - 数据由主窗口经 panel-data 推送（Tk render_panel 的远端等价物）
   - 操作经 panel-req 回传主窗口应用（Tk 直接改 self.lines 的远端等价物）
   - 行内编辑/标题改名在本地进行，提交时回传（Tk p_edit/p_rename 的 commit/cancel）
   0.4.0 新增：两栏各自的拖动排序（跨栏不合法；真搬行仍由主窗口执行）。 */
'use strict';

/* __TAURI__ 由注入脚本在页面加载后写入，panel.js 可能先于它执行（与 app.js 早期同类竞态）。
   因此所有 IPC 都等就绪后再发；就绪前产生的请求排队，就绪后补发。 */
let TAURI = null;
const pendingReq = [];
const emitReq = (payload) => {
  if (!TAURI) { pendingReq.push(payload); return; }
  TAURI.event.emitTo('main', 'panel-req', payload);
};
const log = (msg) => { if (TAURI) TAURI.core.invoke('log_line', { msg: 'panel: ' + msg }); };
window.onerror = (msg, src, line) => {
  log('js error: ' + msg + ' @' + src + ':' + line);
};
window.onunhandledrejection = (ev) => {
  log('js rejection: ' + ev.reason);
};

const $ = (id) => document.getElementById(id);
const titleEl = $('panel-title');
const titleEdit = $('panel-title-edit');
const paneTodo = $('pane-todos');
const paneNote = $('pane-notes');

const P = {
  data: null,          // 最近一次 panel-data
  edit: null,          // { j, input, label }
  renaming: false,
};

function setEditing(on) { emitReq({ type: 'edit-state', editing: on }); }

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

function pMenu(j, x, y) {
  // Tk p_menu(1422-1433)：子待办是叶子，只有编辑与删除
  showMenu([
    { label: '编辑', fn: () => pEdit(j) },
    { label: '删除', fn: () => {
        // Tk delete_line 前会 _commit_edits：先提交未定稿编辑再删
        if (P.edit) commitEdit(P.edit.j, P.edit.input.value);
        emitReq({ type: 'delete', j });
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
    box.addEventListener('click', () => emitReq({ type: 'toggle', j: item.j }));
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
  container.appendChild(row);
  return lbl;
}

/* ---------- 拖动排序（0.4.0）----------
   两栏各自排序：子待办只与子待办换位，备注只与备注换位（跨栏不合法）。
   本地只画浮层与插入线，落定后把「从哪行搬到哪行之前/之后」回传主窗口，
   由拥有 S.lines 的主窗口用 md.moveBlock 真正搬行。 */

const GRIP_SVG = '<svg viewBox="0 0 8 14" fill="none">'
  + '<circle cx="2" cy="3" r="1.1" fill="currentColor"/><circle cx="6" cy="3" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="7" r="1.1" fill="currentColor"/><circle cx="6" cy="7" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="11" r="1.1" fill="currentColor"/><circle cx="6" cy="11" r="1.1" fill="currentColor"/>'
  + '</svg>';

const EDGE_SCROLL = 24;  // 指针进到本栏上下这么多像素内就开始自动滚动
const EDGE_STEP = 12;    // 自动滚动每帧滚多少像素

const DND = {
  on: false,
  j: -1,
  pane: null,
  slot: null,      // { anchor, where: 'before'|'after', el }
  lastY: 0,
  edge: 0,
  pump: 0,
  ghost: null,
  line: null,
  srcEl: null,
  ghostH: 0,
};

function addHandle(row, j, pane) {
  const h = document.createElement('span');
  h.className = 'drag-handle';
  h.innerHTML = GRIP_SVG;
  h.addEventListener('pointerdown', (e) => startDrag(e, j, pane, h));
  h.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (DND.on) { cleanupDrag(); return; }
    hideMenu();
    pMenu(j, e.clientX, e.clientY);
  });
  row.appendChild(h);
}

function startDrag(e, j, pane, handle) {
  if (e.button !== 0 || P.edit || P.renaming || !P.data) return;
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX, y0 = e.clientY;
  let live = false;
  const onMove = (ev) => {
    if (!live) {
      if (Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      live = beginDrag(j, pane);
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

function beginDrag(j, pane) {
  const row = [...pane.querySelectorAll('.row')].find((r) => Number(r.dataset.j) === j);
  if (!row) return false;
  DND.on = true;
  DND.j = j;
  DND.pane = pane;
  DND.slot = null;
  DND.srcEl = row;
  row.classList.add('drag-src');

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  const text = document.createElement('span');
  text.className = 'drag-ghost-text';
  const lbl = row.querySelector('.label');
  text.textContent = lbl ? lbl.textContent.replace(/^• /, '') : '';
  ghost.appendChild(text);
  ghost.style.width = `${Math.round(row.getBoundingClientRect().width)}px`;

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
  DND.lastY = ev.clientY;
  if (DND.ghost) {
    DND.ghost.style.left = `${ev.clientX + 16}px`;
    DND.ghost.style.top = `${ev.clientY - Math.max(DND.ghostH / 2, 12)}px`;
  }
  DND.edge = edgeDir(ev.clientY);
  if (DND.edge) startScrollPump(); else stopScrollPump();
  refreshSlot();
}

/* 指针停进本栏上下 24px 就算进入滚动区；按住不动也继续滚（每帧 12px）。 */
function edgeDir(y) {
  if (!DND.pane) return 0;
  const r = DND.pane.getBoundingClientRect();
  if (y < r.top + EDGE_SCROLL) return -1;
  if (y > r.bottom - EDGE_SCROLL) return 1;
  return 0;
}

function startScrollPump() {
  if (DND.pump) return;
  DND.pump = requestAnimationFrame(function tick() {
    if (!DND.on || !DND.edge) { stopScrollPump(); return; }
    DND.pane.scrollTop += EDGE_STEP * DND.edge;
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
  const slot = DND.slot;
  if (!slot) { DND.line.style.display = 'none'; return; }
  const r = slot.el.getBoundingClientRect();
  const lbl = slot.el.querySelector('.label');
  const left = (lbl || slot.el).getBoundingClientRect().left;
  DND.line.style.display = 'block';
  DND.line.style.top = `${Math.round((slot.where === 'before' ? r.top : r.bottom) - 1)}px`;
  DND.line.style.left = `${Math.round(left)}px`;
  DND.line.style.width = `${Math.max(0, Math.round(window.innerWidth - left - 8))}px`;
}

/* 指针高度 → 落点：只认本栏内的行，上半 = 之前，下半 = 之后。
   指针移出本栏（比如从子待办栏拖到备注栏）就没有落点：跨栏不合法。 */
function slotAt(y) {
  if (!DND.pane) return null;
  const pr = DND.pane.getBoundingClientRect();
  if (y < pr.top || y > pr.bottom) return null;
  const rows = [...DND.pane.querySelectorAll('.row')];
  if (!rows.length) return null;
  if (y < rows[0].getBoundingClientRect().top) {
    return { anchor: Number(rows[0].dataset.j), where: 'before', el: rows[0] };
  }
  let hit = null, rect = null;
  for (const r of rows) {
    const rr = r.getBoundingClientRect();
    if (y < rr.top) break;
    hit = r;
    rect = rr;
  }
  if (!hit) return null;
  return {
    anchor: Number(hit.dataset.j),
    where: y < rect.top + rect.height / 2 ? 'before' : 'after',
    el: hit,
  };
}

function dropDrag(ev) {
  const inside = ev.clientX >= 0 && ev.clientY >= 0
    && ev.clientX <= window.innerWidth && ev.clientY <= window.innerHeight;
  const slot = DND.slot;
  const from = DND.j;
  cleanupDrag();
  if (!inside || !slot) return;
  emitReq({ type: 'move', from, anchor: slot.anchor, where: slot.where });
}

function cleanupDrag() {
  stopScrollPump();
  if (DND.ghost) DND.ghost.remove();
  if (DND.line) DND.line.remove();
  if (DND.srcEl) DND.srcEl.classList.remove('drag-src');
  document.body.classList.remove('dragging');
  DND.on = false;
  DND.j = -1;
  DND.pane = null;
  DND.slot = null;
  DND.lastY = 0;
  DND.edge = 0;
  DND.ghost = null;
  DND.line = null;
  DND.srcEl = null;
  DND.ghostH = 0;
}

/* ---------- 渲染（Tk render_panel 1225-1261） ---------- */

function render(d) {
  if (DND.on) cleanupDrag();   // 数据被重推（行要重建）时先收掉拖动浮层
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
  if (focusLabel) pEditAt(focusLabel);
}

/* ---------- 行内编辑（Tk p_edit 1305-1347） ---------- */

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
  const input = document.createElement('input');
  input.className = 'row-edit' + (lbl.classList.contains('done') ? ' done' : '');
  input.value = lbl.textContent.replace(/^• /, '');
  lbl.style.display = 'none';
  lbl.parentNode.insertBefore(input, lbl.nextSibling);
  input.select();
  input.focus();
  P.edit = { j: idx, input, label: lbl };
  setEditing(true);

  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();   // Tk return "break"：别冒泡成面板级 Escape
      const v = input.value;
      const jj = P.edit.j;
      teardownEdit();
      commitEdit(jj, v);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const jj = P.edit.j;
      teardownEdit();
      emitReq({ type: 'edit-cancel', j: jj });
      emitReq({ type: 'edit-state', editing: false });
    }
  });
  input.addEventListener('blur', () => {
    // FocusOut → commit（Tk 1347）
    if (P.edit && P.edit.input === input) {
      const v = input.value;
      const jj = P.edit.j;
      teardownEdit();
      commitEdit(jj, v);
    }
  });
  input.addEventListener('compositionend', () => input.focus());
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
  const { input, label } = P.edit;
  P.edit = null;
  input.remove();
  label.style.display = '';
}

function commitEdit(j, value) {
  // Tk p_edit commit(1323-1333)：主窗口应用后 render_list → 面板收到新数据
  setEditing(false);
  emitReq({ type: 'edit-commit', j, value });
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
    emitReq({ type: 'rename', value: v });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    teardownRename();
    emitReq({ type: 'rename-cancel' });
  }
});
titleEdit.addEventListener('blur', () => {
  if (P.renaming) {
    const v = titleEdit.value;
    teardownRename();
    emitReq({ type: 'rename', value: v });
  }
});
titleEdit.addEventListener('compositionend', () => titleEdit.focus());

/* ---------- 菜单 ---------- */

const menuEl = $('menu');
function showMenu(items, x, y) {
  menuEl.textContent = '';
  for (const it of items) {
    if (it === 'sep') continue;
    const el = document.createElement('div');
    el.className = 'menu-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { hideMenu(); it.fn(); });
    menuEl.appendChild(el);
  }
  menuEl.style.display = 'block';
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 2))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 2))}px`;
}
function hideMenu() { menuEl.style.display = 'none'; }
// 与主窗口一致用捕获阶段：拖动区处理在 document 冒泡期吞掉事件（#4；本窗口暂无拖动区，防复制粘贴）
document.addEventListener('mousedown', (e) => {
  if (!menuEl.contains(e.target)) hideMenu();
}, true);
document.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------- 顶栏 ---------- */

$('panel-x').addEventListener('click', () => emitReq({ type: 'close' }));
$('panel-x').addEventListener('mousedown', (e) => e.preventDefault());
$('add-todo').addEventListener('click', () => emitReq({ type: 'add-todo' }));
$('add-note').addEventListener('click', () => emitReq({ type: 'add-note' }));
for (const id of ['panel-x', 'add-todo', 'add-note']) {
  $(id).addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
}
titleEl.addEventListener('dblclick', pRename);   // Tk 1132
$('hdr').addEventListener('contextmenu', (e) => { e.preventDefault(); });

/* Escape：先取消拖动，其次取消编辑/改名，否则关面板（Tk 1120 + 各 Entry 的 "break"） */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (DND.on) { e.preventDefault(); cleanupDrag(); return; }
  if (P.edit || P.renaming) return;   // 编辑框自己的 handler 处理并 stopPropagation
  emitReq({ type: 'close' });
});

/* 拖动中右键 = 取消（捕获阶段，顺手吞掉这一下的行菜单） */
document.addEventListener('contextmenu', (e) => {
  if (!DND.on) return;
  e.preventDefault();
  e.stopPropagation();
  cleanupDrag();
}, true);

/* ---------- 事件 ---------- */

function onPanelData(ev) {
  const d = ev.payload;
  if (!d) return;
  log('panel-data received: title=' + d.title + ' todos=' + d.todos.length + ' notes=' + d.notes.length);
  // Tk render_panel(1234-1235)：先 _p_close_editor（提交），再 _p_restore_title（丢弃改名）
  if (P.renaming) teardownRename();
  if (P.edit) {
    const { j, input } = P.edit;
    teardownEdit();
    setEditing(false);
    commitEdit(j, input.value);   // 主窗口应用后会再推一轮新数据
    return;                        // 等下一轮 panel-data 再渲染
  }
  P.data = d;
  render(d);
}

function onPanelCommit() {
  // 主窗口请求落定编辑（删除/刷新/退出前）
  if (P.edit) {
    const { j, input } = P.edit;
    teardownEdit();
    setEditing(false);
    commitEdit(j, input.value);
  } else if (P.renaming) {
    const v = titleEdit.value;
    teardownRename();
    emitReq({ type: 'rename', value: v });
  } else {
    emitReq({ type: 'ack' });
  }
}

function onPanelHide() {
  // 面板被收起：清本地编辑态（Tk close_panel 清空状态）
  if (P.edit) { P.edit.input.remove(); P.edit = null; }
  if (P.renaming) teardownRename();
  setEditing(false);
}

function waitTauri() {
  return new Promise((resolve) => {
    const tick = () => {
      const t = window.__TAURI__;
      if (t && t.core && t.event) resolve(t);
      else setTimeout(tick, 20);
    };
    tick();
  });
}

(async () => {
  TAURI = await waitTauri();
  for (const p of pendingReq.splice(0)) TAURI.event.emitTo('main', 'panel-req', p);
  await TAURI.event.listen('panel-data', onPanelData);
  await TAURI.event.listen('panel-commit', onPanelCommit);
  await TAURI.event.listen('panel-hide', onPanelHide);
  // 通知主窗口监听已就绪：首次打开时主窗口的 panel-data 可能早于本页加载而丢失
  await TAURI.event.emitTo('main', 'panel-ready', {});
  log('ready');
})().catch((e) => log('init failed: ' + e));
