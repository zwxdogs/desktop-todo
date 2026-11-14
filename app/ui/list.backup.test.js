// 「删除已完成」的兜底（#20）：删前写同目录 待办-bak.md，Ctrl+Z 在内存撤销栈被整份重载
// 清掉之后仍能读回来。
//
// 这一组钉住的是**触发条件**，它比功能本身更容易写错：
//   · Ctrl+Z 永远先走内存撤销栈；备份只是内存那份没了之后的兜底。
//   · 绝不因为「栈恰好是空的」就去读备份——那会把上一次运行遗留的旧状态复活进来，
//     比丢一次删除更糟。凭据是「本次运行里确实做过删除已完成」这个内存事实，
//     进程一起来就是假的，所以重启后不会复活旧备份。
//   · 备份只属于它自己那个文件：切文件就作废。
//   · 写备份失败就不删（宁可删不掉，也不能删了没法撤）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createList } from "./list.js";
import * as md from "./md.js";

const SRC = "**工作**\n- [ ] 甲\n  - [x] 甲一\n- [x] 乙\n\n**生活**\n- [x] 丙\n";
const AFTER = "**工作**\n- [ ] 甲\n  - [x] 甲一\n\n**生活**\n";

// 盘上那份备份的替身：一个文件，只有一份，写就覆盖（与 Rust 侧 backup_path 的语义一致）。
function mkBackup(disk = null) {
  const state = { disk, writes: 0, reads: 0, failWrite: false, failRead: false };
  return {
    state,
    port: {
      write: async (text) => {
        if (state.failWrite) throw new Error("write: 拒绝访问。 (os error 5)");
        state.writes += 1;
        state.disk = { text, nl: "\n", has_bom: false };
      },
      read: async () => {
        if (state.failRead) throw new Error("read: 另一个程序正在使用此文件。 (os error 32)");
        state.reads += 1;
        return state.disk;
      },
    },
  };
}

function mk(src, o = {}) {
  const calls = { writes: [], render: 0, snap: 0 };
  const list = createList({
    lines: md.parseText(src),
    nl: o.nl || "\n",
    hasBom: !!o.hasBom,
    file: o.file,
    debounceMs: 5,
    hooks: {
      render: () => { calls.render += 1; },
      onSnapshot: () => { calls.snap += 1; },
      write: async (t) => { calls.writes.push(t); return o.writeOk === undefined ? true : o.writeOk; },
      backup: o.backup,
    },
  });
  return { list, calls };
}

test("删除已完成：删之前把完整清单写进备份（单条删除不写）", async () => {
  const bak = mkBackup();
  const single = mk(SRC, { backup: bak.port });
  single.list.remove(1);                 // 单条删除：只靠内存撤销栈，不动备份
  assert.equal(bak.state.writes, 0, "单条删除不写备份");

  const { list } = mk(SRC, { backup: bak.port });
  const r = await list.deleteCompleted();
  assert.deepEqual(r, { ok: true, n: 2, unfinished: 0 });
  assert.equal(bak.state.disk.text, SRC, "备份是删除前的完整清单，不是删剩的");
  assert.equal(list.text(), AFTER);
});

test("删除已完成：写备份失败就不删，返回原因，清单与撤销栈都不动", async () => {
  const bak = mkBackup();
  bak.state.failWrite = true;
  const { list, calls } = mk(SRC, { backup: bak.port });

  const r = await list.deleteCompleted();
  assert.equal(r.ok, false);
  assert.match(String(r.err), /os error 5/, "原因原样交出去，界面要说明为什么删不了");
  assert.equal(list.text(), SRC, "一个字都不能删");
  assert.equal(list.canUndo(), false, "没删就没快照");
  assert.equal(calls.snap, 0);
  assert.equal(calls.writes.length, 0, "也不排写盘");
  assert.equal(list.canRestoreBackup(), false, "没写成备份就没有可恢复的东西");
});

test("恢复备份：本次运行没做过删除已完成时，栈空也不读备份", async () => {
  const bak = mkBackup({ text: "- [x] 上一次运行留下的\n", nl: "\n", has_bom: false });
  const { list, calls } = mk("- [ ] 甲\n", { backup: bak.port });

  assert.equal(list.canRestoreBackup(), false);
  const r = await list.restoreBackup();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "nothing");
  assert.equal(bak.state.reads, 0, "根本不该去碰盘上那份旧备份");
  assert.equal(list.text(), "- [ ] 甲\n");
  assert.equal(calls.writes.length, 0);
});

test("恢复备份：外部改动整份重载清掉撤销栈之后，仍能取回删除前的清单", async () => {
  const bak = mkBackup();
  const { list, calls } = mk(SRC, { backup: bak.port, file: "E:/项目/待办.md" });
  await list.deleteCompleted();
  assert.equal(list.text(), AFTER);

  // 外部编辑器存了一次盘：整份重载，撤销栈整个换新
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n", file: "E:/项目/待办.md" });
  assert.equal(list.canUndo(), false, "重载之后内存里没有可撤销的东西了");
  assert.equal(list.canRestoreBackup(), true, "但本次运行确实做过删除已完成，备份还在");

  const r = await list.restoreBackup();
  assert.equal(r.ok, true);
  assert.equal(list.text(), SRC, "取回的是删除前那份完整清单");
  assert.equal(calls.writes.at(-1), SRC, "写回走的是同一条写盘路径");
  assert.equal(list.canRestoreBackup(), false, "备份视为已消费");
  assert.equal(list.canUndo(), true, "恢复本身也能撤回（第二次 Ctrl+Z 回到重载后的样子）");
});

test("恢复备份：内存撤销栈还有东西时不许读备份", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  assert.equal(list.canUndo(), true);

  const r = await list.restoreBackup();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "undoable", "先撤内存那份，备份是它没了之后的兜底");
  assert.equal(bak.state.reads, 0);
});

test("恢复备份：备份已消费，第二次不会再读", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n" });
  assert.equal((await list.restoreBackup()).ok, true);
  await list.undo();                     // 把恢复本身也撤掉，栈又空了
  assert.equal(list.canUndo(), false);

  const r = await list.restoreBackup();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "nothing");
  assert.equal(bak.state.reads, 1, "消费过就不再碰盘");
});

test("内存撤销：撤到删除已完成之前，备份就此作废", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  assert.equal(list.canRestoreBackup(), true);

  assert.equal(await list.undo(), true);       // 弹出删除已完成那个快照
  assert.equal(list.text(), SRC, "内存里已经退回去了");
  assert.equal(list.canRestoreBackup(), false, "再用备份恢复只会把同一件事做第二遍");
});

test("内存撤销：删完之后又改了一笔，先撤那笔时备份仍然有效", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  list.setText(0, "工作改");

  assert.equal(await list.undo(), true);       // 撤掉刚改的那一笔
  assert.equal(list.canRestoreBackup(), true, "删除那一批还没退回来，备份仍要留着");
  assert.equal(await list.undo(), true);       // 再撤，这次弹出删除已完成
  assert.equal(list.canRestoreBackup(), false);
});

test("切到另一个文件：上一个文件的备份不许跟过来", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port, file: "E:/项目/甲.md" });
  await list.deleteCompleted();
  assert.equal(list.canRestoreBackup(), true);

  list.replaceAll({ lines: md.parseText("- [ ] 别的清单\n"), nl: "\n", file: "E:/项目/乙.md" });
  assert.equal(list.canRestoreBackup(), false, "乙.md 的 Ctrl+Z 不能把 甲-bak.md 的内容搬进来");
  assert.equal((await list.restoreBackup()).reason, "nothing");
});

test("换身份（setFile）：备份凭据当场作废，不等整份重载", async () => {
  // 装载可能失败：那时清单还挂着旧内容，但「这份备份属于甲.md」已经不成立了
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port, file: "E:/项目/甲.md" });
  await list.deleteCompleted();
  assert.equal(list.canRestoreBackup(), true);

  list.setFile("E:/项目/乙.md");
  assert.equal(list.canRestoreBackup(), false);
  assert.equal(bak.state.reads, 0);

  // 换回同一个文件不算换：凭据不该因为一次重复赋值就丢
  const bak2 = mkBackup();
  const l2 = mk(SRC, { backup: bak2.port, file: "E:/项目/甲.md" }).list;
  await l2.deleteCompleted();
  l2.setFile("E:/项目/甲.md");
  assert.equal(l2.canRestoreBackup(), true);
});

test("恢复备份：换行符与 BOM 跟备份走，恢复后写盘是逐字节还原", async () => {
  const bak = mkBackup();
  const { list, calls } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  // 盘上那份备份是 CRLF + BOM（删除时文件本来就是这样）
  bak.state.disk = { text: "**工作**\r\n- [x] 乙\r\n", nl: "\r\n", has_bom: true };

  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n", hasBom: false });
  const r = await list.restoreBackup();
  assert.equal(r.ok, true);
  assert.equal(list.hasBom(), true, "BOM 是备份自己的那份");
  assert.equal(list.text(), "**工作**\r\n- [x] 乙\r\n", "换行符也是备份那份");
  assert.equal(calls.writes.at(-1), "**工作**\r\n- [x] 乙\r\n");
});

test("恢复备份：盘上没有备份 → 什么也不做，凭据作废", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n" });
  bak.state.disk = null;                 // 用户自己把 待办-bak.md 删了

  const r = await list.restoreBackup();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing");
  assert.equal(list.text(), AFTER, "没有备份可读就保持原样");
  assert.equal(list.canRestoreBackup(), false, "没有就是没有，不必每次 Ctrl+Z 都去探盘");
});

test("恢复备份：读不动 → 说原因、保持原样，凭据留着下次再试", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n" });
  bak.state.failRead = true;

  const r = await list.restoreBackup();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "read");
  assert.match(String(r.err), /os error 32/);
  assert.equal(list.text(), AFTER, "读不回来就不动内存");
  assert.equal(list.canRestoreBackup(), true, "文件被占着是暂时的，下次 Ctrl+Z 还能试");
});

test("恢复备份：读到了但写不回去 → 不动内存，凭据留着", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port, writeOk: false });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n" });

  const r = await list.restoreBackup();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "write");
  assert.equal(list.text(), AFTER, "写不进去就别假装恢复了");
  assert.equal(list.canRestoreBackup(), true);
});

test("恢复备份写不回去时，什么都不动（内容、BOM、排着的写盘、凭据）", async () => {
  // cancelSave 排在写成功之后：失败路径上什么都还没发生，就不许影响别的东西。
  // 「栈空 + 排着写盘」这个组合经公开接口到不了（压快照是写盘的前提，replaceAll 又会取消
  // 写盘），所以这里只钉住失败路径本身不动内存这一条。
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port, writeOk: false });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n", hasBom: false });
  const pendingBefore = list.pending();

  const r = await list.restoreBackup();
  assert.equal(r.reason, "write");
  assert.equal(list.pending(), pendingBefore, "失败不动写盘状态");
  assert.equal(list.hasBom(), false, "失败不动 BOM");
  assert.equal(list.text(), AFTER, "失败不动内容");
  assert.equal(list.canRestoreBackup(), true, "失败不动凭据");
});

test("撤销写盘失败：备份凭据不许被消费（那批删除此刻还只在备份里）", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  assert.equal(list.canRestoreBackup(), true);

  // 让撤销这一次写盘失败（快照已经被弹出，内存一个字没动）
  const bad = mk(SRC, { backup: bak.port, writeOk: false });
  await bad.list.deleteCompleted();
  assert.equal(await bad.list.undo(), false, "写失败 = 这次撤销没发生");
  assert.equal(bad.list.text(), AFTER, "内存没动");
  assert.equal(bad.list.canRestoreBackup(), true, "那批删除还在备份里，凭据必须留着");
});

test("撤销「恢复备份」这一步：BOM 与换行符一起还原", async () => {
  // 恢复会把 nl / hasBom 换成备份那份；撤回它时也得换回来，
  // 否则第二次 Ctrl+Z 会顺手把文件编码改掉
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n", hasBom: false });
  bak.state.disk = { text: "**工作**\r\n- [x] 乙\r\n", nl: "\r\n", has_bom: true };

  assert.equal((await list.restoreBackup()).ok, true);
  assert.equal(list.hasBom(), true);
  assert.equal(list.text(), "**工作**\r\n- [x] 乙\r\n");

  assert.equal(await list.undo(), true);
  assert.equal(list.hasBom(), false, "撤回恢复要把 BOM 也撤回");
  assert.equal(list.text(), AFTER, "内容与换行符都回到恢复前");
});

test("整份重载之后第一次删除已完成，备份重新算数", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText("- [x] 新的已完成\n"), nl: "\n" });
  assert.equal(list.canRestoreBackup(), true, "上一批还没消费");

  await list.deleteCompleted();
  assert.equal(bak.state.disk.text, "- [x] 新的已完成\n", "备份被覆盖成这一批删除前的内容");
  assert.equal(list.text(), "");
});

test("连做两批删除、撤掉最近那批：凭据作废（备份里就是那一批之前的内容，内存里已经有了）", async () => {
  // 备份文件每次覆盖，所以它只认**最近**那一批删除。armedAt 记的是压快照那一刻的栈深：
  // 撤到那层以下 = 最近那批已经回到内存里，此时再读备份只会把同一份内容重复搬一遍。
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();                       // 第一批
  list.toggle(0);                                     // 勾一条，制造第二批
  await list.deleteCompleted();                       // 第二批

  assert.equal(await list.undo(), true);              // 撤掉第二批
  assert.equal(list.canRestoreBackup(), false, "最近那批已在内存里，备份没有用了");
});

test("撤掉一批之后又做新的删除已完成：凭据重新算数", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  await list.undo();                                   // 退回去，凭据作废
  assert.equal(list.canRestoreBackup(), false);

  const r = await list.deleteCompleted();               // 再来一次
  assert.equal(r.ok, true);
  assert.equal(list.canRestoreBackup(), true, "新的那批重新给了凭据");
});

test("恢复备份压的那个快照，撤销后不会把已经消费的凭据复活", async () => {
  const bak = mkBackup();
  const { list } = mk(SRC, { backup: bak.port });
  await list.deleteCompleted();
  list.replaceAll({ lines: md.parseText(AFTER), nl: "\n" });
  assert.equal((await list.restoreBackup()).ok, true);
  assert.equal(list.canRestoreBackup(), false, "恢复完就消费掉");

  assert.equal(await list.undo(), true);              // 撤回「恢复」这一步
  assert.equal(list.canRestoreBackup(), false, "撤销不该把消费过的凭据吐回来");
});
