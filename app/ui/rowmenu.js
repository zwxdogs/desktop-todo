/* 下拉菜单：主窗口与详情面板共用的一份实现（#15 从两份各写一份里收上来）。
   锚点、溢出夹回、置亮归属、置灰占位都在这里；调用方只给条目和位置。
   条目可以是 'sep' 或 { label, fn, disabled }；opts.owner 是「再点同一枚按钮收起」的归属按钮。 */

export function createMenu(el) {
  let owner = null;

  function show(items, x, y, opts = {}) {
    el.textContent = '';
    for (const it of items) {
      if (it === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        el.appendChild(sep);
        continue;
      }
      const item = document.createElement('div');
      item.className = 'menu-item' + (it.disabled ? ' disabled' : '');
      item.textContent = it.label;
      if (it.disabled) {
        // 置灰项只是个占位说明：点了不动作，菜单也不关（ADR 0007）
        item.addEventListener('click', (e) => { e.stopPropagation(); });
      } else {
        item.addEventListener('click', () => { hide(); it.fn(); });
      }
      el.appendChild(item);
    }
    el.style.display = 'block';
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 2;
    const maxY = window.innerHeight - rect.height - 2;
    el.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
    el.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
    if (owner) owner.classList.remove('lit');
    owner = opts.owner || null;
    if (owner) owner.classList.add('lit');
  }

  function hide() {
    el.style.display = 'none';
    if (owner) { owner.classList.remove('lit'); owner = null; }
  }

  function isOpen() { return el.style.display === 'block'; }

  /* 捕获期的「点菜单外关闭」要不要放过这个目标：落在归属按钮上就交给它的 click 去 toggle。 */
  function owns(target) { return !!(owner && owner.contains(target)); }

  return { show, hide, isOpen, owns };
}
