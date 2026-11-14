// notice.js 的状态迁移测试（#18 第三段：写盘失败界面上要看得见）。
// 钉住的是「谁盖谁」这条政策，不碰 DOM。
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextNotice, noticeIsClickable } from "./notice.js";

test("写盘失败：从空状态接管", () => {
  const s = nextNotice(null, { type: "save-failed", text: "保存失败：磁盘已满" });
  assert.deepEqual(s, { kind: "save", text: "保存失败：磁盘已满" });
  assert.equal(noticeIsClickable(s), true);
});

test("写盘失败：盖住正在显示的短消息", () => {
  const info = nextNotice(null, { type: "info", text: "编辑已丢弃", token: 1 });
  const s = nextNotice(info, { type: "save-failed", text: "保存失败" });
  assert.equal(s.kind, "save", "丢字这件事比「编辑已丢弃」要紧");
});

test("短消息：写盘失败还挂着时不许刷上去", () => {
  const failed = nextNotice(null, { type: "save-failed", text: "保存失败" });
  const s = nextNotice(failed, { type: "info", text: "编辑已丢弃", token: 2 });
  assert.deepEqual(s, failed, "两条挤一处时，一闪而过的那条只会把要紧的盖掉");
});

test("短消息：没有失败时正常显示，并带上自己的 token", () => {
  const s = nextNotice(null, { type: "info", text: "编辑已丢弃", token: 7 });
  assert.deepEqual(s, { kind: "info", text: "编辑已丢弃", token: 7 });
  assert.equal(noticeIsClickable(s), false, "短消息点了没动作，不该是能点的样子");
});

test("短消息过期：只清自己那一条", () => {
  const a = nextNotice(null, { type: "info", text: "A", token: 1 });
  const b = nextNotice(a, { type: "info", text: "B", token: 2 });
  assert.deepEqual(b, { kind: "info", text: "B", token: 2 }, "同一条位置上的新消息直接替换旧消息");
  assert.equal(nextNotice(b, { type: "expire", token: 1 }), b, "A 的定时器到点不能把 B 清掉");
  assert.equal(nextNotice(b, { type: "expire", token: 2 }), null, "自己的定时器到了才清");
});

test("保存成功：清掉失败提示，但不动短消息", () => {
  const failed = nextNotice(null, { type: "save-failed", text: "保存失败" });
  assert.equal(nextNotice(failed, { type: "saved" }), null);
  const info = nextNotice(null, { type: "info", text: "编辑已丢弃", token: 3 });
  assert.deepEqual(nextNotice(info, { type: "saved" }), info, "短消息有自己的过期时间，不归保存成功管");
});

test("重复的保存成功 / 没见过的动作：不改变状态", () => {
  assert.equal(nextNotice(null, { type: "saved" }), null);
  const s = nextNotice(null, { type: "info", text: "A", token: 1 });
  assert.deepEqual(nextNotice(s, { type: "nonsense" }), s);
});

test("写盘失败之后又来一次失败：换成新的那条文字", () => {
  const a = nextNotice(null, { type: "save-failed", text: "保存失败：磁盘已满" });
  const b = nextNotice(a, { type: "save-failed", text: "保存失败：文件被占用" });
  assert.deepEqual(b, { kind: "save", text: "保存失败：文件被占用" });
});
