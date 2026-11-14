// 编辑锚点与面板锚点的回归测试（#18 第 1、2 段）。
//
// 根因：行的身份被当成了它的下标。下标在「插入 / 删除 / 搬块 / 整份替换」之后就不成立了，
// 于是提交时把字写到了别人头上，或者直接丢掉；面板则按「文字 + 缩进」去猜，
// 撞上两条同名同缩进的待办就永远绑第一条。
//
// 这一组测试钉住的是**行为**：正在编辑的那一条，无论清单一路上怎么变，
// 交上去的字都落在它自己身上；它真的不在了就明确交不出来（返回 -1），绝不猜。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createList } from "./list.js";
import * as md from "./md.js";

function mk(src) {
  return createList({
    lines: md.parseText(src),
    nl: "\n",
    debounceMs: 5,
    hooks: { render: () => {}, write: async () => true },
  });
}

const TODO = "**组**\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n";

test("锚点：一条待办的锚在插入行之后仍然指向它自己", () => {
  const list = mk(TODO);
  const a = list.anchorAt(3);                       // 丙
  list.insert(1, "todo", "", "新待办");              // 在甲下面插一条
  assert.equal(list.indexOfAnchor(a), 4, "丙 从 3 挪到了 4，锚必须跟着走");
  assert.equal(list.lines()[list.indexOfAnchor(a)].text, "丙");
});

test("锚点：删掉前面的行之后仍然指向它自己", () => {
  const list = mk(TODO);
  const a = list.anchorAt(3);
  list.remove(2);                                   // 删乙
  assert.equal(list.indexOfAnchor(a), 2);
  assert.equal(list.lines()[list.indexOfAnchor(a)].text, "丙");
});

test("锚点：搬块之后仍然指向它自己", () => {
  const list = mk(TODO);
  const a = list.anchorAt(1);                       // 甲
  assert.equal(list.move(1, 4), true);               // 甲 搬到末尾
  assert.equal(list.lines()[list.indexOfAnchor(a)].text, "甲");
});

test("锚点：同名同缩进的两条待办各自独立", () => {
  const list = mk("- [ ] 写周报\n  - 第一条的备注\n- [ ] 写周报\n  - 第二条的备注\n");
  const first = list.anchorAt(0);
  const second = list.anchorAt(2);
  assert.equal(list.indexOfAnchor(first), 0);
  assert.equal(list.indexOfAnchor(second), 2, "锚靠的是行本身，不是文字");
});

test("锚点：整份替换之后按文字重绑（外部改动重载，行还在）", () => {
  const list = mk(TODO);
  const a = list.anchorAt(3);
  // 外部编辑器只改了别的行：丙 的文字与缩进没变
  list.replaceAll({ lines: md.parseText("**组**\n- [ ] 甲\n- [ ] 甲二\n- [ ] 乙\n- [ ] 丙\n"), nl: "\n" });
  assert.equal(list.lines()[list.indexOfAnchor(a)].text, "丙", "行还在就该重新认出来");
});

test("锚点：整份替换之后目标不在了就交不出来，不猜", () => {
  const list = mk(TODO);
  const a = list.anchorAt(3);
  list.replaceAll({ lines: md.parseText("**组**\n- [ ] 甲\n"), nl: "\n" });
  assert.equal(list.indexOfAnchor(a), -1, "丙 已经不在文件里了");
});

test("锚点：整份替换之后有两处同名同缩进，交不出来（不猜是哪一条）", () => {
  const list = mk("- [ ] 写周报\n");
  const a = list.anchorAt(0);
  list.replaceAll({ lines: md.parseText("- [ ] 写周报\n- [ ] 写周报\n"), nl: "\n" });
  assert.equal(list.indexOfAnchor(a), -1, "两条都长得一样，认错比认不出更糟");
});

test("锚点：同名两条删掉一条之后，锚不许「认领」幸存的那一条", () => {
  // 这条是复查时发现的真漏洞：只查「现在唯一命中」，唯一命中正好落在幸存的那条上，
  // 于是「改第二条」的字写进了第一条——而它可能就是被删掉的那一条。
  const list = mk("- [ ] 写周报\n    - 第一条的备注\n- [ ] 写周报\n    - 第二条的备注\n");
  const second = list.anchorAt(2);                    // 编辑第二条
  list.replaceAll({ lines: md.parseText("- [ ] 写周报\n    - 第一条的备注\n"), nl: "\n" });
  assert.equal(list.indexOfAnchor(second), -1, "幸存的那条与手里这条长得一样，认它就是串行");
});

test("锚点：独一无二的行改名之后仍然认得回来", () => {
  // only 只是「建锚那一刻唯一」，不该把改名之后的行永久锁死
  const list = mk("- [ ] 甲\n- [ ] 乙\n");
  const a = list.anchorAt(0);
  list.setText(0, "甲改");
  assert.equal(list.indexOfAnchor(a), 0);
  list.replaceAll({ lines: md.parseText("- [ ] 甲改\n- [ ] 乙\n"), nl: "\n" });
  assert.equal(list.lines()[list.indexOfAnchor(a)].text, "甲改", "改完名它是唯一的，外部重载后认得回来");
});

test("锚点：面板在外部重载后也不会认领另一条同名的待办", () => {
  // spec 复查抓到的同款洞（面板这一侧）
  const list = mk("- [ ] 写周报\n    - 第一条的备注\n- [ ] 写周报\n    - 第二条的备注\n");
  list.setPanel(2);
  list.replaceAll({ lines: md.parseText("- [ ] 写周报\n    - 第一条的备注\n"), nl: "\n" });
  assert.equal(list.panelIndex(), -1, "面板不许悄悄跳去盯幸存的另一条");
});

test("锚点：越界或对不上的行返回 null", () => {
  const list = mk(TODO);
  assert.equal(list.anchorAt(-1), null);
  assert.equal(list.anchorAt(99), null);
  assert.equal(list.indexOfAnchor(null), -1);
});

test("锚点：撤销换掉了整份清单，旧锚作废不串行", async () => {
  const list = mk(TODO);
  list.setText(1, "甲改");
  const a = list.anchorAt(3);
  assert.equal(await list.undo(), true);
  // 撤销把内存换成了重新解析的一份：旧锚若还能指到别人身上就是串行
  const i = list.indexOfAnchor(a);
  assert.ok(i === -1 || list.lines()[i].text === "丙", `锚必须指向丙或交不出来，实际指向 ${i}`);
});

test("面板锚点：同名同缩进的两条待办，绑的是被双击的那一条", () => {
  const list = mk("- [ ] 写周报\n  - 第一条的备注\n- [ ] 写周报\n  - 第二条的备注\n");
  list.setPanel(2);
  assert.equal(list.panelIndex(), 2, "绑到下标 0 就是让用户改错那一条");
  assert.deepEqual(md.panelParts(list.lines(), list.panelIndex())[1], [3]);
});

test("面板锚点：改另一条同名待办的名字，不会把面板拽过去", () => {
  const list = mk("- [ ] 写周报\n  - 第一条的备注\n- [ ] 写周报\n  - 第二条的备注\n");
  list.setPanel(2);
  list.setText(0, "写周报A");
  assert.equal(list.panelIndex(), 2);
});

test("面板锚点：目标被删掉之后交不出来", () => {
  const list = mk("- [ ] 写周报\n  - 第一条的备注\n- [ ] 写周报\n  - 第二条的备注\n");
  list.setPanel(2);
  list.remove(2);
  assert.equal(list.panelIndex(), -1);
});
