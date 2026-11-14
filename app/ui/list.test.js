// list.js 的行为测试 —— 八个意图各一条实现，撤销/写盘/锚点/行保真都在模块内部。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createList } from "./list.js";
import * as md from "./md.js";

const SRC = "**工作**\n- [ ] 甲\n  - [x] 甲一\n- [ ] 乙\n\n**生活**\n- [x] 丙\n";

function mk(src, o = {}) {
  const calls = { render: 0, snap: 0, before: [], writes: [], after: [] };
  const list = createList({
    lines: md.parseText(src),
    nl: "\n",
    debounceMs: 5,
    hooks: {
      render: () => { calls.render += 1; },
      onSnapshot: () => { calls.snap += 1; },
      before: (m) => { calls.before.push(m); },
      write: async (t) => { calls.writes.push(t); return o.writeOk === undefined ? true : o.writeOk; },
      afterSave: (ok, n) => { calls.after.push([ok, n]); },
    },
  });
  return { list, calls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("勾选只改方框里那一个字符，其余字节不动", () => {
  const { list, calls } = mk("- [ ] 甲\n- [ ] 乙\n");
  list.toggle(1);
  assert.equal(list.text(), "- [ ] 甲\n- [x] 乙\n");
  assert.equal(calls.snap, 1);
  assert.equal(calls.render, 1);
  assert.equal(list.canUndo(), true);
});

test("勾选不是待办的行：不动、不压快照", () => {
  const { list, calls } = mk("**组**\n- [ ] 甲\n");
  assert.equal(list.toggle(0), false);
  assert.equal(list.toggle(9), false);
  assert.equal(calls.snap, 0);
  assert.equal(calls.render, 0);
});

test("文字没变时 setText 不重建 raw（行保真：行尾空白不丢）", () => {
  // 分组的 raw 是 **组** 加两个空格：parseLine 的 \s*$ 会吞掉它们，
  // 只要重建一次 raw 就丢了 —— 这正是「文字没变不重建」要守住的东西
  const src = "**组**  \n- [ ] 甲 \n";
  const { list } = mk(src);
  list.setText(0, "组");
  list.setText(1, "甲 ");
  assert.equal(list.text(), src);
});

test("改字只动那一行，别的行原样", () => {
  const src = "**组**\n- [ ] 甲\n- 备注  \n";
  const { list } = mk(src);
  list.setText(1, "甲改");
  assert.equal(list.text(), "**组**\n- [ ] 甲改\n- 备注  \n");
});

test("面板锚点：改字后仍认得出那条待办", () => {
  const { list } = mk("- [ ] 甲\n- [ ] 乙\n");
  list.setPanel(0);
  assert.equal(list.panelIndex(), 0);
  list.setText(0, "甲改");
  assert.equal(list.panelIndex(), 0);
});

test("面板锚点：目标被删后记 -1", () => {
  const { list } = mk("- [ ] 甲\n  - [x] 甲一\n- [ ] 乙\n");
  list.setPanel(0);
  list.remove(0);
  assert.equal(list.panelIndex(), -1);
  assert.equal(list.text(), "- [ ] 乙\n");
});

test("面板锚点：在前面插行后跟着挪", () => {
  const { list } = mk("- [ ] 甲\n");
  list.setPanel(0);
  list.insert(0, "header", "", "组");
  assert.equal(list.panelIndex(), 1);
});

test("插入：落点前一行缺换行时先补上", () => {
  const { list } = mk("- [ ] 甲");
  const at = list.insert(1, "todo", "", "乙");
  assert.equal(at, 1);
  assert.equal(list.text(), "- [ ] 甲\n- [ ] 乙\n");
});

test("插入：分组标题用 **名称**，返回插入后的下标", () => {
  const { list } = mk("- [ ] 甲\n");
  const at = list.insert(0, "header", "", "新分组");
  assert.equal(at, 0);
  assert.equal(list.text(), "**新分组**\n- [ ] 甲\n");
});

test("插入：备注行是 - 文本，缩进原样带进去", () => {
  const { list } = mk("- [ ] 甲\n");
  list.insert(1, "note", "  ", "补充");
  assert.equal(list.text(), "- [ ] 甲\n  - 补充\n");
});

test("删除：待办带走整块，返回被删区间", () => {
  const { list, calls } = mk("- [ ] 甲\n  - [x] 甲一\n- [ ] 乙\n");
  const r = list.remove(0);
  assert.deepEqual(r, { index: 0, end: 2, kind: "todo" });
  assert.equal(list.text(), "- [ ] 乙\n");
  assert.deepEqual(calls.before[0], { kind: "remove", index: 0, end: 2 });
});

test("删除：非待办只删一行", () => {
  const { list } = mk("**组**\n- [ ] 甲\n");
  list.remove(0);
  assert.equal(list.text(), "- [ ] 甲\n");
});

test("搬块：不合法落点 = 不压快照、不重绘", () => {
  const { list, calls } = mk("- [ ] 甲\n- [ ] 乙\n");
  assert.equal(list.move(0, 0), false);
  assert.equal(list.move(0, 1), false);
  assert.equal(calls.snap, 0);
  assert.equal(calls.render, 0);
});

test("搬块：合法时整块搬走，撤销能回去", async () => {
  const src = "- [ ] 甲\n  - [x] 甲一\n- [ ] 乙\n";
  const { list } = mk(src);
  assert.equal(list.move(0, 3), true);
  assert.equal(list.text(), "- [ ] 乙\n- [ ] 甲\n  - [x] 甲一\n");
  await list.undo();
  assert.equal(list.text(), src);
});

test("删除已完成：整批只压一个快照，报数与未勾子待办数", () => {
  const { list, calls } = mk(SRC);
  const r = list.deleteCompleted();
  assert.deepEqual(r, { n: 1, unfinished: 0 });
  assert.equal(calls.snap, 1);
  assert.equal(list.text(), "**工作**\n- [ ] 甲\n  - [x] 甲一\n- [ ] 乙\n\n**生活**\n");
  assert.equal(list.pending(), true);
});

test("删除已完成：没有命中时什么都不做", () => {
  const { list, calls } = mk("**组**\n- [ ] 甲\n");
  assert.equal(list.deleteCompleted(), null);
  assert.equal(calls.snap, 0);
  assert.equal(calls.render, 0);
});

test("删除已完成：父项没勾时子项不动", () => {
  const { list } = mk("- [ ] 父\n  - [x] 子\n");
  assert.equal(list.deleteCompleted(), null);
  assert.equal(list.text(), "- [ ] 父\n  - [x] 子\n");
});

test("整份替换：换行与 BOM 跟着换，撤销历史清空，旧写盘作废", async () => {
  const { list, calls } = mk("- [ ] 甲\n");
  list.toggle(0);                      // 排一次写盘
  assert.equal(list.pending(), true);
  list.replaceAll({ lines: md.parseText("- [ ] 乙\r\n"), nl: "\r\n", hasBom: true });
  assert.equal(list.pending(), false);
  assert.equal(list.canUndo(), false);
  assert.equal(list.hasBom(), true);
  assert.equal(list.text(), "- [ ] 乙\r\n");   // 换行符跟着文件走
  await sleep(30);
  assert.equal(calls.writes.length, 0);   // 替换前那次 toggle 排的写盘被取消，没落盘
});

test("撤销：先写成功再换内存", async () => {
  const { list, calls } = mk("- [ ] 甲\n");
  list.toggle(0);
  assert.equal(await list.undo(), true);
  assert.equal(list.text(), "- [ ] 甲\n");
  assert.equal(calls.writes[calls.writes.length - 1], "- [ ] 甲\n");
});

test("撤销：写盘失败就不动内存，返回 false", async () => {
  const { list } = mk("- [ ] 甲\n", { writeOk: false });
  list.toggle(0);
  assert.equal(await list.undo(), false);
  assert.equal(list.text(), "- [x] 甲\n");
  assert.equal(list.canUndo(), false);   // Tk 同款：快照先弹出，写失败就丢了
});

test("撤销：空栈返回 false", async () => {
  const { list } = mk("- [ ] 甲\n");
  assert.equal(await list.undo(), false);
});

test("写盘合并：窗口内连着改几次只落一次盘，内容是最后一次", async () => {
  const { list, calls } = mk("- [ ] 甲\n- [ ] 乙\n");
  list.toggle(0);
  list.toggle(1);
  list.setText(0, "甲改");
  assert.equal(calls.writes.length, 0);
  await sleep(30);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0], "- [x] 甲改\n- [x] 乙\n");
  assert.equal(calls.after.length, 1);
  assert.equal(calls.after[0][0], true);
});

test("写盘失败：原因交给 afterSave，不只是交一个 false", async () => {
  // 界面上那条「保存失败」要说明为什么（磁盘满 / 文件被占 / 目录只读），
  // 所以写盘抛出来的原因必须原样传到 afterSave —— 吞成 false 之后只能说「未知原因」（#18）
  const seen = [];
  const list = createList({
    lines: md.parseText("- [ ] 甲\n"),
    nl: "\n",
    debounceMs: 5,
    hooks: {
      render: () => {},
      write: async () => { throw new Error("replace: 另一个程序正在使用此文件"); },
      afterSave: (ok, n, err) => { seen.push([ok, n, err && err.message]); },
    },
  });
  list.toggle(0);
  await sleep(30);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], false, "失败就是失败");
  assert.match(seen[0][2], /另一个程序正在使用此文件/, "原因不能在路上被吞掉");
});

test("每次真变更都压一次快照，供入口收掉回执浮层", () => {
  const { list, calls } = mk("- [ ] 甲\n");
  list.toggle(0);
  list.setText(0, "甲改");
  assert.equal(calls.snap, 2);
});

test("行保真：勾上再取消，整份文件字节回到原样", () => {
  const src = "**组 **\n- [ ] 甲  \n  - [x] 子\n\n";
  const { list } = mk(src);
  list.toggle(1);
  list.toggle(1);
  assert.equal(list.text(), src);
});

test("上一次的操作能被下一次撤销", async () => {
  const { list } = mk("- [ ] 甲\n");
  list.setText(0, "甲改");
  list.toggle(0);
  await list.undo();
  assert.equal(list.text(), "- [ ] 甲改\n");   // 退到勾选之前：字还在，勾没了
  await list.undo();
  assert.equal(list.text(), "- [ ] 甲\n");
});

test("插入也走同一个收尾：重绘一次、排一次写盘", () => {
  const { list, calls } = mk("");
  list.insert(0, "todo", "", "甲");
  assert.equal(calls.render, 1);
  assert.equal(list.pending(), true);
  assert.equal(list.text(), "- [ ] 甲\n");
});
