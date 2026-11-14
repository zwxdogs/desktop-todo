/* 勾选框的 SVG（主窗口与详情面板共用，0.4.2 / #23）。
 *
 * 原本 app.js 与 panel.js 各有一份逐字相同的 boxSvg；深色主题这次要同时改两边的颜色，
 * 两份就立刻成了必须同步维护的东西（复审指出这是 Shotgun Surgery 的典型）。
 * 现在颜色由样式表按 class 给（`.box-fill` / `.box-tick` / `.box-empty`），
 * 两窗只调这一个函数，换主题自动跟着走。
 *
 * 为什么颜色不写成 SVG presentation attribute 里的 var()：var() 在属性里是否解析
 * 各引擎不一致（w3c/svgwg#1031），落到样式表规则里则一致。 */

/* Tk draw_box(709-720)：选中 = accent 实心方块 + 勾线；未选中 = 1px 描边。
   坐标写死成 18 格的物理格，与 .box 的 18px 画布同源（s 单位）。 */
export function boxSvg(checked) {
  if (checked) {
    return '<svg viewBox="0 0 18 18" fill="none">' +
      '<rect class="box-fill" x="2" y="2" width="14" height="14"/>' +
      '<polyline class="box-tick" points="5,9 8,12 13,5" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  }
  return '<svg viewBox="0 0 18 18" fill="none">' +
    '<rect class="box-empty" x="2" y="2" width="14" height="14" fill="none" stroke-width="1"/></svg>';
}
