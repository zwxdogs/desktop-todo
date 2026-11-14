// 深色主题的静态检查（#23）。
//
// 这里不渲染 CSS，钉的是三件「一改就会静默坏掉」的事：
//   1. 界面里所有颜色都走变量——再冒出一个字面量，深色下就是一块亮的。
//   2. 亮色定义过的每个变量，深色 @media 里都有对应的一行——漏一个，
//      那一处就会保留亮色值（比如深底上写一行黑字）。
//   3. 深色块存在，且用的是媒体查询而不是 data-theme 属性——后者要求 JS 参与，
//      而本项目换色的唯一来源是 WebView2 的 PreferredColorScheme。
//
// 所有断言都在「去掉注释」的文本上做：注释里会提到具体色值、`data-theme`、媒体查询，
// 它们是说明而不是规则，混进来只会让测试指向错的地方。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "style.css"), "utf8");

/** 去掉 /* ... *\/ 注释（保留换行，行号不至于全挤在一起）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const css = stripComments(raw);

/** 取 marker 之后第一个配平的 { ... } 块（内部还嵌着规则块，不能靠正则贪婪匹配）。 */
function blockAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let i = text.indexOf("{", at);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const lightBlock = blockAfter(css, ":root {");
const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
const darkBlock = darkAt < 0 ? null : blockAfter(css.slice(darkAt), ":root {");

function varNames(block) {
  const out = new Set();
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:/g)) out.add(m[1]);
  return out;
}

function varValue(block, name) {
  const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

test("亮色与深色两套变量都定义了", () => {
  assert.ok(lightBlock, "找不到 :root 的配色块");
  assert.ok(darkBlock, "找不到 @media (prefers-color-scheme: dark) 里的 :root 配色块");
  assert.ok(varNames(lightBlock).size > 20, "亮色变量太少，多半是块没切对");
});

test("深色覆盖了亮色的每一个变量", () => {
  // 漏一个的后果是不对称的：漏 --c-text，深底上就是一片黑字，读不出来。
  const light = varNames(lightBlock);
  const dark = varNames(darkBlock);
  const missing = [...light].filter((n) => !dark.has(n));
  assert.deepEqual(missing, [], `深色缺这些变量：${missing.join(", ")}`);
});

test("深色块里没有亮色没定义的变量", () => {
  // 多出来的定义是拼写错误，它会静默失效（引用的地方拿到空值，那条规则整条作废）
  const light = varNames(lightBlock);
  const extra = [...varNames(darkBlock)].filter((n) => !light.has(n));
  assert.deepEqual(extra, [], `深色多出这些未定义的变量：${extra.join(", ")}`);
});

test("正文之外的颜色不许再写字面量", () => {
  // 变量表（:root 与深色块）之外出现 #hex / rgba() 就意味着换色换不动那一处。
  const outside = css.replace(lightBlock, "").replace(darkBlock, "");
  const literals = [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], `这些颜色没有变量化：${literals.join(", ")}`);
});

test("换色靠媒体查询，不靠 data-theme 属性", () => {
  // 属性那套要求 JS 监听并写 DOM；本项目的开关落在 WebView2 的 PreferredColorScheme 上，
  // 媒体查询自己就会变（见 src-tauri/src/theme.rs）。写错成属性，托盘切了主题界面不会动。
  assert.ok(darkAt >= 0, "深色要用 prefers-color-scheme 触发");
  assert.ok(!css.includes("data-theme"), "不该引入 data-theme：没有 JS 会给它赋值");
});

test("声明 color-scheme，让 UA 自绘件跟着换", () => {
  // 滚动条、输入框、弹层按钮这些是浏览器自己画的，只有声明 color-scheme 才会跟着变深。
  assert.match(lightBlock, /color-scheme:\s*light dark/, "缺 color-scheme: light dark");
});

test("深色下勾选框的三块色都换了一档", () => {
  // 验收项「勾选框在深色下仍然看得清」：填充、勾线、未勾描边各自由变量给色，
  // 且深色那套里三者的值都与亮色不同（不是漏改后巧合相等）。
  for (const name of ["c-accent", "c-accent-text", "c-box"]) {
    const light = varValue(lightBlock, name);
    const dark = varValue(darkBlock, name);
    assert.ok(light, `亮色缺 --${name}`);
    assert.ok(dark, `深色缺 --${name}`);
    assert.notEqual(light, dark, `--${name} 在深色下没换：深色下勾选框会和亮色一样`);
  }
});

test("深色不许有变量与亮色同值（除了有意保持的）", () => {
  // 复审抓到的真 bug：--c-grip-hover 在深色块里抄了亮色的 #8B95A1，注释还写着「压一档」。
  // 只在「两套该不同」的变量上断言——同值本身不一定是错，但抄漏是，所以给一份白名单。
  const SAME_BY_DESIGN = new Set([
    // 有意两套相同的：强调色在深色下提亮后，某些派生色仍可复用（当前没有），
    // 真出现时在这里写一行并说明理由，别默默放过。
  ]);
  const light = varNames(lightBlock);
  const same = [...light].filter((n) => !SAME_BY_DESIGN.has(n) && varValue(lightBlock, n) === varValue(darkBlock, n));
  assert.deepEqual(same, [], `这些变量在深色下与亮色完全相同（多半是抄漏）：${same.join(", ")}`);
});

test("勾选框的色不写在 SVG 属性里", () => {
  // SVG presentation attribute 里 var() 各引擎行为不一致（w3c/svgwg#1031），
  // 所以 checkbox.js 只输出 class，色在样式表里给。
  const src = stripComments(readFileSync(join(here, "checkbox.js"), "utf8"));
  const at = src.indexOf("export function boxSvg");
  assert.ok(at >= 0, "checkbox.js 里找不到 boxSvg");
  const end = src.indexOf("\n}", at);
  const boxFn = src.slice(at, end < 0 ? at + 900 : end);
  assert.ok(boxFn.includes("box-fill"), "选中态的方块应带 box-fill 类");
  assert.ok(boxFn.includes("box-tick"), "勾线应带 box-tick 类");
  assert.ok(boxFn.includes("box-empty"), "未勾态的描边应带 box-empty 类");
  assert.ok(!/#[0-9a-fA-F]{6}/.test(boxFn), "boxSvg 里不该再有硬编码色");
});

test("两个窗口共用同一份勾选框，不再各写一遍", () => {
  // 复审指出的 Shotgun Surgery：本来 app.js 与 panel.js 各有一份逐字相同的 boxSvg，
  // 深色主题这次要同时改两边的颜色。现在只有 checkbox.js 一份，两窗都是 import。
  for (const file of ["app.js", "panel.js"]) {
    const src = stripComments(readFileSync(join(here, file), "utf8"));
    assert.ok(/import\s*\{[^}]*boxSvg[^}]*\}\s*from\s*['"]\.\/checkbox\.js['"]/.test(src),
      `${file} 应从 checkbox.js 导入 boxSvg`);
    assert.ok(!/function\s+boxSvg\s*\(/.test(src), `${file} 不该再自带一份 boxSvg`);
  }
});

test("样式表里给了勾选框三个 class 的颜色", () => {
  // 上一条保证 JS 只输出 class；这一条保证 class 真有人管色，否则框会画不出来
  for (const cls of ["box-fill", "box-tick", "box-empty"]) {
    assert.match(css, new RegExp(`\\.${cls}\\s*\\{[^}]*var\\(--c-`), `.${cls} 没用变量给色`);
  }
});
