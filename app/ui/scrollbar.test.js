// scrollbar.js 的几何测试 —— 自绘滚动条拇指的位置/长度（0.4.1 新增，Tk 0.2.7 无滚动条）。
// 只测纯函数 thumbLayout()：DOM 部分（淡入淡出、拖动）在 WebView2 里靠手验。
import { test } from "node:test";
import assert from "node:assert/strict";
import { thumbLayout } from "./scrollbar.js";

const T = (o) => thumbLayout({ trackTop: 40, trackHeight: 400, minThumb: 24, ...o });

test("内容不足一屏（没有可滚距离）→ 不出拇指", () => {
  assert.equal(T({ scrollTop: 0, scrollHeight: 700, clientHeight: 800 }), null);
});

test("内容刚好一屏 → 不出拇指", () => {
  assert.equal(T({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 }), null);
});

test("顶端：拇指贴轨道顶，长度按可视比例", () => {
  const r = T({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 });
  assert.equal(r.top, 40);
  assert.equal(r.height, 160);      // 800/2000 × 400
  assert.equal(r.max, 1200);
});

test("中点：拇指落在轨道正中", () => {
  const r = T({ scrollTop: 600, scrollHeight: 2000, clientHeight: 800 });
  assert.equal(r.top, 160);         // 40 + 600/1200 × (400-160)
});

test("底端：拇指贴轨道底（顶 + 长 = 轨道底）", () => {
  const r = T({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 });
  assert.equal(r.top, 280);         // 40 + 400 - 160
});

test("超长内容：拇指收缩到最小 24，仍夹在轨道内", () => {
  const top = T({ scrollTop: 0, scrollHeight: 100000, clientHeight: 800 });
  assert.equal(top.height, 24);
  const end = T({ scrollTop: 100000 - 800, scrollHeight: 100000, clientHeight: 800 });
  assert.equal(end.height, 24);
  assert.equal(end.top, 416);       // 40 + 400 - 24
});

test("scrollTop 越界（负值 / 超过最大值）夹到两端", () => {
  assert.equal(T({ scrollTop: -50, scrollHeight: 2000, clientHeight: 800 }).top, 40);
  assert.equal(T({ scrollTop: 99999, scrollHeight: 2000, clientHeight: 800 }).top, 280);
});

test("轨道比最小时长短时，拇指不超过轨道", () => {
  const r = T({ scrollTop: 0, scrollHeight: 100000, clientHeight: 800, trackHeight: 20 });
  assert.equal(r.height, 20);
});
