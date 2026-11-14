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

test("一次性的失败（#20 写备份失败）：挂着，但不可点", () => {
  // 它和写盘失败一样要一直挂在界面上——用户得看清为什么没做成；
  // 但它没有「点一下重试」这个动作，伪装成可点是骗人。
  const s = nextNotice(null, { type: "error", text: "没能写备份文件，这次没有删除：磁盘已满" });
  assert.deepEqual(s, { kind: "error", text: "没能写备份文件，这次没有删除：磁盘已满" });
  assert.equal(noticeIsClickable(s), false, "点了没有对应动作，就不该是能点的样子");
});

test("一次性的失败：不许盖掉还挂着的写盘失败", () => {
  const failed = nextNotice(null, { type: "save-failed", text: "保存失败" });
  const s = nextNotice(failed, { type: "error", text: "没能写备份文件" });
  assert.deepEqual(s, failed, "丢字那条更要紧，不能被一条旧的失败说明顶掉");
});

test("一次性的失败：保存成功不会清掉它", () => {
  // 「保存成功」回答的是另一件事：那一次写盘的失败已经过去了
  const s = nextNotice(null, { type: "error", text: "没能写备份文件" });
  assert.deepEqual(nextNotice(s, { type: "saved" }), s);
});

test("一次性的失败：后面的短消息可以接管它", () => {
  const s = nextNotice(null, { type: "error", text: "没能写备份文件" });
  const b = nextNotice(s, { type: "info", text: "已取回删除前的清单", token: 1 });
  assert.deepEqual(b, { kind: "info", text: "已取回删除前的清单", token: 1 }, "刚发生的消息比一条旧说明更贴近现在");
});

test("一次性的失败：后来做成了就收掉（dismiss-error）", () => {
  // 「这次没能删除」挂在那儿，下一次删除成功了就不该还留着这句话
  const s = nextNotice(null, { type: "error", text: "没能写备份文件，这次没有删除" });
  assert.equal(nextNotice(s, { type: "dismiss-error" }), null);
});

test("一次性的失败：新的一条接管旧的（两条都是 error）", () => {
  const a = nextNotice(null, { type: "error", text: "取回失败：读不动" });
  const b = nextNotice(a, { type: "error", text: "没能写备份文件，这次没有删除" });
  assert.deepEqual(b, { kind: "error", text: "没能写备份文件，这次没有删除" }, "刚发生的那件事占这个位置");
});

test("dismiss-error：不动别人的消息", () => {
  // 它只收拾自己那种；写盘失败与短消息各有各的收尾条件
  const failed = nextNotice(null, { type: "save-failed", text: "保存失败" });
  assert.deepEqual(nextNotice(failed, { type: "dismiss-error" }), failed);
  const info = nextNotice(null, { type: "info", text: "A", token: 1 });
  assert.deepEqual(nextNotice(info, { type: "dismiss-error" }), info);
  assert.equal(nextNotice(null, { type: "dismiss-error" }), null);
});
