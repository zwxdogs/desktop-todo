/* 自绘滚动条（0.4.1 新增；Tk 0.2.7 没有滚动条，只有滚轮 —— 见 PARITY §3-13）。
   原生滚动条做不出淡入淡出（伪元素没有 opacity），而且会贯穿标题栏，所以：
   - 原生条在各滚动容器上藏掉（#list / .pane-scroll 的 scrollbar-width:none）
   - 这里画一条浮层拇指：滚动时淡入、停手后淡出、悬停加深、可拖
   几何计算放在纯函数 thumbLayout() 里（可单测）；DOM/事件在 attachScrollbar() 里。 */
'use strict';

const MIN_THUMB = 24;    // 拇指最短长度（px）：长列表里纯比例会缩成一条线，抓不住
const HIDE_DELAY = 900;  // 停手后多久开始淡出（ms）
const WIDTH = 6;         // 拇指宽（px）
const RIGHT_INSET = 3;   // 拇指离容器右缘的距离（px）

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* 拇指几何：返回 { top, height, max }，内容不足一屏时返回 null。
   top 是视口坐标（与 trackTop 同一坐标系），height 是拇指长度，max 是最大 scrollTop。 */
export function thumbLayout({
  scrollTop,
  scrollHeight,
  clientHeight,
  trackTop,
  trackHeight,
  minThumb = MIN_THUMB,
}) {
  const max = scrollHeight - clientHeight;
  if (!(max > 0) || !(trackHeight > 0)) return null;
  const height = Math.min(trackHeight, Math.max(minThumb, (clientHeight / scrollHeight) * trackHeight));
  const top = trackTop + (clamp(scrollTop, 0, max) / max) * (trackHeight - height);
  return { top, height, max };
}

/* 给一个滚动容器挂一条浮层滚动条。
   opts.bottomInset：轨道底部让开的像素（主窗口让开右下角 22px 缩放把手）。
   返回 { refresh }；refresh() = 静默重算（内容重画后调，不触发显示）。 */
export function attachScrollbar(scroller, opts = {}) {
  const bottomInset = opts.bottomInset || 0;

  const bar = document.createElement('div');
  bar.className = 'vscroll';
  const thumb = document.createElement('div');
  thumb.className = 'vscroll-thumb';
  bar.appendChild(thumb);
  document.body.appendChild(bar);

  let max = 0;            // 当前最大 scrollTop
  let trackH = 0;         // 轨道长度
  let thumbH = 0;         // 拇指长度
  let hideTimer = 0;
  let dragging = false;
  let hovering = false;
  let programmatic = null; // 我们刚设过的 scrollTop：随之而来的那次 scroll 不当作"用户在滚"
  let dragStartY = 0;
  let dragStartTop = 0;

  function track() {
    const r = scroller.getBoundingClientRect();
    return {
      top: r.top + 2,                                  // 上下各内缩 2px，不贴边
      height: Math.max(0, r.height - 4 - bottomInset), // 再让开底部（缩放把手）
      right: r.right - RIGHT_INSET,
    };
  }

  function layout() {
    const t = track();
    bar.style.left = `${Math.round(t.right - WIDTH)}px`;
    bar.style.top = `${Math.round(t.top)}px`;
    bar.style.height = `${Math.round(t.height)}px`;
    const lay = thumbLayout({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      trackTop: t.top,
      trackHeight: t.height,
    });
    if (!lay) {
      max = 0;
      bar.classList.remove('on', 'show', 'dragging');
      return false;
    }
    max = lay.max;
    trackH = t.height;
    thumbH = lay.height;
    thumb.style.top = `${Math.round(lay.top - t.top)}px`;
    thumb.style.height = `${Math.round(lay.height)}px`;
    bar.classList.add('on');
    return true;
  }

  function show() {
    if (!bar.classList.contains('on')) return;
    clearTimeout(hideTimer);
    bar.classList.add('show');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!dragging && !hovering) bar.classList.remove('show');
    }, HIDE_DELAY);
  }

  function onScroll() {
    const at = scroller.scrollTop;
    if (programmatic !== null && Math.abs(at - programmatic) < 1) {
      programmatic = null;      // 程序性恢复滚动位置：位置更新，但不闪条子
      layout();
      return;
    }
    programmatic = null;
    if (!layout()) return;
    show();
    scheduleHide();
  }

  /* 内容重画/数据重推后静默重算：位置立刻正确，但不因 scrollTop 变化闪出条子 */
  function refresh() {
    layout();
    programmatic = scroller.scrollTop;
    setTimeout(() => { programmatic = null; }, 250);   // 万一没有 scroll 事件，别一直吞
  }

  thumb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !max) return;
    e.preventDefault();
    dragging = true;
    dragStartY = e.clientY;
    dragStartTop = scroller.scrollTop;
    thumb.setPointerCapture(e.pointerId);
    bar.classList.add('show', 'dragging');
    clearTimeout(hideTimer);
  });

  thumb.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const span = trackH - thumbH;
    if (span <= 0) return;
    scroller.scrollTop = dragStartTop + ((e.clientY - dragStartY) * max) / span;
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    try { thumb.releasePointerCapture(e.pointerId); } catch (_) { /* 指针已消失 */ }
    scheduleHide();
  }
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  // 鼠标停在拇指上时不淡出（否则想抓它的时候它先没了）
  thumb.addEventListener('pointerenter', () => { hovering = true; show(); });
  thumb.addEventListener('pointerleave', () => { hovering = false; scheduleHide(); });

  // 滚轮落在拇指上时透传给内容（拇指盖住的 6px 仍然能滚）
  thumb.addEventListener('wheel', (e) => {
    scroller.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  scroller.addEventListener('scroll', onScroll, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => layout()).observe(scroller);
  }
  window.addEventListener('resize', () => layout());

  layout();
  return { refresh };
}
