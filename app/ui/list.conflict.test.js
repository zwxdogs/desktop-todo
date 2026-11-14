// 外部改动冲突期间（弹层开着）不许自动写盘（#22）。
//
// 为什么这层必须存在：轮询发现外部改动时先要把正在编辑的字落定（flushPanel + closeEditor），
// 而落定会排一次 250ms 写盘。那次写盘一旦落下去，磁盘上那份外部内容就当场没了——
// 用户还没选「刷新 / 撤回」，撤回要留档的那份已经被自己盖掉。所以弹层开着期间
// 写盘合并窗口只记账、不出手：改动仍在内存里，两种选择都还成立。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createList } from "./list.js";
import * as md from "./md.js";

const SRC = "**工作**\n- [ ] 甲\n- [ ] 乙\n";

function mk(o = {}) {
  const writes = [];
  const list = createList({
    lines: md.parseText(SRC),
    nl: "\n",
    debounceMs: o.debounceMs === undefined ? 5 : o.debounceMs,
    hooks: { write: async (t) => { writes.push(t); return true; } },
  });
  return { list, writes };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("hold：暂停期间的变更照旧进内存，但一笔都不写盘", async () => {
  const { list, writes } = mk();
  list.hold();
  list.toggle(1);
  list.setText(2, "乙改");
  assert.equal(list.lines()[2].text, "乙改", "内存照改：用户的字不能因为弹层而丢");
  await sleep(30);
  assert.deepEqual(writes, [], "弹层开着时不许自动落盘");
});

test("hold：本来排着的那笔也当场取消（它正是会盖掉外部内容的那一笔）", async () => {
  const { list, writes } = mk();
  list.toggle(1);            // 排上 5ms 的那一笔
  list.hold();               // 弹层要开了
  await sleep(30);
  assert.deepEqual(writes, [], "取消掉已经在计时的那一次");
});

test("release：恢复后可以把攒下的改动照常写出去", async () => {
  const { list, writes } = mk();
  list.hold();
  list.toggle(1);
  list.release();
  list.toggle(2);            // 一次普通变更，重新排写盘
  await sleep(30);
  assert.equal(writes.length, 1, "release 之后合并窗口照常工作");
  assert.equal(writes[0], list.text());
});

test("release 本身不写盘：撤回落盘由调用方决定写什么", async () => {
  // 「撤回」要先写 -out-bak 再整份写回原文件，顺序由窗口掌握；这里只是解锁
  const { list, writes } = mk();
  list.hold();
  list.toggle(1);
  list.release();
  await sleep(30);
  assert.deepEqual(writes, [], "解锁不等于替用户决定现在写");
});

test("hold 期间 replaceAll（静默重载那条路）仍要取消计时器（既有行为不变）", async () => {
  const { list, writes } = mk();
  list.toggle(1);
  list.replaceAll({ lines: md.parseText("- [ ] 外部\n") });
  await sleep(30);
  assert.deepEqual(writes, []);
  assert.equal(list.text(), "- [ ] 外部\n");
});
