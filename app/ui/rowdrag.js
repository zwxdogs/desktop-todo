// rowdrag.js — 行拖动的唯一实现（主窗口与详情面板共用）。
// 一窗一套政策，交互本体只有这一份：指针捕获、拖动浮层、插入线、自动滚、落点求解。
// 政策由适配器回答：主窗口算「这一行能不能插进这个分组」，详情面板算「跨栏算不算同一个
// 落点」。适配器只提供行的几何与落点规则，不碰指针、也不画浮层。
//
// 落点求解是纯函数（mainDropTarget / panelDropTarget）：喂行模型 + 量好的行矩形，不碰 DOM，
// 所以能直接用 node --test 守（见 rowdrag.test.js）。

import { blockEnd, canMove } from './md.js';

const EDGE_SCROLL = 24;  // 指针进到容器上下这么多像素内就开始自动滚动
const EDGE_STEP = 12;    // 自动滚动每帧滚多少像素
const DRAG_THRESHOLD = 3;   // 指针移动超过这么多像素才算起拖（不然只是点了一下把手）

export const GRIP_SVG = '<svg viewBox="0 0 8 14" fill="none">'
  + '<circle cx="2" cy="3" r="1.1" fill="currentColor"/><circle cx="6" cy="3" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="7" r="1.1" fill="currentColor"/><circle cx="6" cy="7" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="11" r="1.1" fill="currentColor"/><circle cx="6" cy="11" r="1.1" fill="currentColor"/>'
  + '</svg>';

/* 主窗口政策：落点只有行间插入，且永远落在整块边界；待办带走整棵子树，分组带走整组。
   规则本体是 md.js 的纯函数（blockEnd / canMove）；本文件只负责把指针位置换算成插槽。
   rows 是可见行（分组标题 / 待办）按文档顺序量好的矩形。 */
export function mainDropTarget(lines, rows, y, from) {
  if (!rows.length || !(from >= 0 && from < lines.length)) return null;

  let slot = -1;
  if (y < rows[0].top) {
    slot = rows[0].key;
  } else {
    let hit = null;
    for (const r of rows) {
      if (y < r.top) break;
      hit = r;
    }
    if (!hit) return null;
    const upper = y < hit.top + (hit.bottom - hit.top) / 2;
    if (lines[from].kind === 'header') {
      const g = groupStart(lines, hit.key);
      if (g < 0) return null;
      slot = upper ? g : blockEnd(lines, g);
    } else if (lines[hit.key].kind === 'header') {
      slot = upper ? hit.key : hit.key + 1;    // 组头上半 = 组前，下半 = 组首
    } else {
      slot = upper ? hit.key : blockEnd(lines, hit.key);
    }
  }

  if (!canMove(lines, from, slot)) return null;
  return targetForSlot(rows, slot);
}

/* 面板政策：只认本栏内的行，上半 = 之前，下半 = 之后；指针出了本栏就没有落点（跨栏不合法）。 */
export function panelDropTarget(rows, bounds, y) {
  if (!rows.length) return null;
  if (y < bounds.top || y > bounds.bottom) return null;
  if (y < rows[0].top) return { rowKey: rows[0].key, where: 'before' };
  let hit = null;
  for (const r of rows) {
    if (y < r.top) break;
    hit = r;
  }
  if (!hit) return null;
  const upper = y < hit.top + (hit.bottom - hit.top) / 2;
  return { rowKey: hit.key, where: upper ? 'before' : 'after' };
}

/* 插入 slot 在屏幕上的落点：落在 slot 处的第一条可见行之前；slot 越过末行则落在末行之后。
   落点同时带回 slot 本身——{ rowKey, where } 撑不下「越过末行」的全部信息（末行之后可能是
   未渲染进 rows 的隐藏行），宿主不能再由 rowKey 反推一次 slot。 */
function targetForSlot(rows, slot) {
  for (const r of rows) {
    if (r.key >= slot) return { rowKey: r.key, where: 'before', slot };
  }
  return { rowKey: rows[rows.length - 1].key, where: 'after', slot };
}

/* 这一行所属分组的标题下标；上面一个标题都没有时返回 -1。 */
function groupStart(lines, i) {
  let k = i;
  while (k > 0 && lines[k].kind !== 'header') k -= 1;
  return lines[k].kind === 'header' ? k : -1;
}

/* 拖动引擎。适配器（两个窗口各一个）提供：
     container      自动滚动的滚动容器
     rows()         可拖行 [{ key, el }]（文档顺序）
     canStart(key)  这一行现在能不能起拖
     ghost(key)     浮层内容 { text, count?, header? }
     resolve(rows, y, from)  落点（喂量好的 rows；两个纯函数之一）
     stale(token)   起拖时的数据是否已被换掉（换掉就放弃这次拖动）
     lineRight(el)  插入线右端（缺省 = 行右缘）
     onStart(key)   起拖前收掉编辑框之类的收尾
     onDrop(from, target)  落定（target = { rowKey, where, slot }） */
export function createRowDrag(adapter) {
  const D = {
    on: false,
    from: -1,
    target: null,
    lastY: 0,
    edge: 0,
    pump: 0,
    ghost: null,
    line: null,
    srcEl: null,
    ghostH: 0,
    token: null,
  };

  function measure() {
    return adapter.rows().map(({ key, el }) => {
      const b = el.getBoundingClientRect();
      return { key, el, top: b.top, bottom: b.bottom };
    });
  }

  function start(ev, handle, key) {
    if (ev.button !== 0 || !adapter.canStart(key)) return;
    ev.preventDefault();          // 不夺焦点、不拖选文字
    ev.stopPropagation();
    const x0 = ev.clientX, y0 = ev.clientY;
    let live = false;
    const onMove = (e) => {
      if (!live) {
        if (Math.abs(e.clientX - x0) < DRAG_THRESHOLD && Math.abs(e.clientY - y0) < DRAG_THRESHOLD) return;
        live = begin(key);
        if (!live) { detach(); return; }
      }
      track(e);
    };
    const onUp = (e) => {
      if (live) drop(e);
      detach();
    };
    const onCancel = () => {
      if (live) cleanup();
      detach();
    };
    function detach() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      try { handle.releasePointerCapture(ev.pointerId); } catch (_) { /* 行已重渲染 */ }
    }
    try { handle.setPointerCapture(ev.pointerId); } catch (_) { return; }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
  }

  function begin(key) {
    if (adapter.onStart) adapter.onStart(key);
    const src = adapter.rows().find((r) => r.key === key);
    if (!src) return false;
    const content = adapter.ghost(key) || {};
    D.on = true;
    D.from = key;
    D.target = null;
    D.token = adapter.token ? adapter.token() : null;
    D.srcEl = src.el;
    src.el.classList.add('drag-src');

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost' + (content.header ? ' drag-ghost-header' : '');
    const text = document.createElement('span');
    text.className = 'drag-ghost-text';
    text.textContent = content.text || '';
    ghost.appendChild(text);
    if (content.count) {
      const cnt = document.createElement('span');
      cnt.className = 'drag-ghost-count';
      cnt.textContent = `+${content.count}`;
      ghost.appendChild(cnt);
    }
    ghost.style.width = `${Math.round(src.el.getBoundingClientRect().width)}px`;

    const line = document.createElement('div');
    line.className = 'drop-line';
    line.style.display = 'none';
    document.body.appendChild(ghost);
    document.body.appendChild(line);
    D.ghost = ghost;
    D.line = line;
    D.ghostH = ghost.getBoundingClientRect().height;
    document.body.classList.add('dragging');
    return true;
  }

  function track(ev) {
    if (!D.on) return;
    if (adapter.stale && adapter.stale(D.token)) { cleanup(); return; }
    D.lastY = ev.clientY;
    if (D.ghost) {
      D.ghost.style.left = `${ev.clientX + 16}px`;
      D.ghost.style.top = `${ev.clientY - Math.max(D.ghostH / 2, 12)}px`;
    }
    D.edge = edgeDir(ev.clientY);
    if (D.edge) startScrollPump(); else stopScrollPump();
    refresh();
  }

  function edgeDir(y) {
    const r = adapter.container.getBoundingClientRect();
    if (y < r.top + EDGE_SCROLL) return -1;
    if (y > r.bottom - EDGE_SCROLL) return 1;
    return 0;
  }

  function startScrollPump() {
    if (D.pump) return;
    D.pump = requestAnimationFrame(function tick() {
      if (!D.on || !D.edge) { stopScrollPump(); return; }
      adapter.container.scrollTop += EDGE_STEP * D.edge;
      refresh();
      D.pump = requestAnimationFrame(tick);
    });
  }

  function stopScrollPump() {
    if (D.pump) { cancelAnimationFrame(D.pump); D.pump = 0; }
  }

  function refresh() {
    const rows = measure();
    D.target = adapter.resolve(rows, D.lastY, D.from);
    drawLine(rows);
  }

  function drawLine(rows) {
    if (!D.line) return;
    const pos = D.target ? lineSpan(rows, D.target) : null;
    if (!pos) { D.line.style.display = 'none'; return; }
    D.line.style.display = 'block';
    D.line.style.top = `${Math.round(pos.top - 1)}px`;
    D.line.style.left = `${Math.round(pos.left)}px`;
    D.line.style.width = `${Math.max(0, Math.round(pos.right - pos.left))}px`;
  }

  function lineSpan(rows, target) {
    const row = rows.find((r) => r.key === target.rowKey);
    if (!row) return null;
    const b = row.el.getBoundingClientRect();
    const lbl = row.el.querySelector('.label');
    const left = (lbl || row.el).getBoundingClientRect().left;
    const right = adapter.lineRight ? adapter.lineRight(row.el) : b.right;
    return { top: target.where === 'before' ? b.top : b.bottom, left, right };
  }

  function drop(ev) {
    const inside = ev.clientX >= 0 && ev.clientY >= 0
      && ev.clientX <= window.innerWidth && ev.clientY <= window.innerHeight;
    const target = D.target;
    const from = D.from;
    const fresh = !(adapter.stale && adapter.stale(D.token));
    cleanup();
    if (!fresh || !inside || !target) return;   // 拖出窗口或没有合法落点 = 取消，不写不记撤销
    adapter.onDrop(from, target);
  }

  function cleanup() {
    stopScrollPump();
    if (D.ghost) D.ghost.remove();
    if (D.line) D.line.remove();
    if (D.srcEl) D.srcEl.classList.remove('drag-src');
    document.body.classList.remove('dragging');
    D.on = false;
    D.from = -1;
    D.target = null;
    D.lastY = 0;
    D.edge = 0;
    D.token = null;
    D.ghost = null;
    D.line = null;
    D.srcEl = null;
    D.ghostH = 0;
  }

  return { start, cleanup, isOn: () => D.on };
}
