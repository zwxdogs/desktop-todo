/* 行内加号（ADR 0007）：主窗口与详情面板共用同一个元素与同一枚图标。
   只管"长什么样"，点下去做什么由两个窗口各自接线（缩进与落点的规则在 md.js）。 */
'use strict';

const PLUS_SVG = '<svg viewBox="0 0 12 12" fill="none">'
  + '<path d="M6 2.5v7M2.5 6h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '</svg>';

/** 造一个悬停现身的加号；title 说明它插在哪（例如「在下方添加待办」）。 */
export function plusButton(title) {
  const p = document.createElement('span');
  p.className = 'plus-add';
  p.innerHTML = PLUS_SVG;
  p.title = title;
  // 别让按下加号把编辑框的焦点抢走：blur 会立刻提交并重画整行，重画后这个按钮已经不在，
  // click 就落空了（先提交、后插入的效果等于"点了没反应"）。
  p.addEventListener('mousedown', (e) => e.preventDefault());
  return p;
}
