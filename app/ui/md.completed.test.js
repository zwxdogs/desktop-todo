// md.completed.test.js — 「删除已完成」的判定与删除（md.completedScan / md.deleteCompleted）。
// 接缝：纯函数。规则（用户拍板）：只看顶层待办自己的勾选状态；勾了就整块删
// （子待办、备注跟着走）；父项没勾时，它下面勾掉的子待办一律不动。
// 「顶层」不是「顶格」：分组里的待办可能带缩进，只要不在另一个待办的子块里就是顶层。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseText, serialize, completedScan, deleteCompleted } from './md.js';

const lines = (text) => parseText(text);

test('completedScan: 空清单 / 只有未勾选的 → 没有可删的', () => {
  assert.deepEqual(completedScan(lines('')), []);
  assert.deepEqual(completedScan(lines('**组**\n- [ ] 甲\n- 备注\n\n')), []);
});

test('completedScan: 顶层勾选的待办 → 一个块，[i, end) 只包住它自己', () => {
  assert.deepEqual(completedScan(lines('- [x] 甲\n')), [{ i: 0, end: 1, unfinished: 0 }]);
});

test('completedScan: 大写 [X] 同样算完成', () => {
  assert.deepEqual(completedScan(lines('- [X] 甲\n')), [{ i: 0, end: 1, unfinished: 0 }]);
});

test('completedScan: 父项勾选、子块里还有未勾选的子待办 → unfinished 报出来', () => {
  const l = lines('- [x] 父\n    - [x] 子一\n    - [ ] 子二\n    - 备注\n- [ ] 下一个\n');
  assert.deepEqual(completedScan(l), [{ i: 0, end: 4, unfinished: 1 }]);
});

test('completedScan: 父项没勾 → 整块跳过，里面勾掉的子待办不算', () => {
  const l = lines('- [ ] 父\n    - [x] 子\n');
  assert.deepEqual(completedScan(l), []);
});

test('completedScan: 分组里的待办带缩进也算顶层，标题不打断扫描', () => {
  const l = lines('**甲组**\n    - [x] 一\n    - [ ] 二\n**乙组**\n  - [x] 三\n');
  assert.deepEqual(completedScan(l), [
    { i: 1, end: 2, unfinished: 0 },
    { i: 4, end: 5, unfinished: 0 },
  ]);
});

test('completedScan: tab 与空格混用的缩进也按层级判父子', () => {
  const l = lines('- [ ] 父\n\t  - [x] 子\n');
  assert.deepEqual(completedScan(l), []);
});

test('completedScan: 子块末尾的空行不算进块里', () => {
  const l = lines('- [x] 甲\n    - [ ] 子\n\n- [ ] 乙\n');
  assert.deepEqual(completedScan(l), [{ i: 0, end: 2, unfinished: 1 }]);
});

test('deleteCompleted: 只删勾选的整块，未勾选的块连同里面的子待办原样保留', () => {
  const l = lines('**组**\n- [x] 甲\n    - 备注甲\n- [ ] 乙\n    - [x] 乙的子\n');
  assert.equal(
    serialize(deleteCompleted(l)),
    '**组**\n- [ ] 乙\n    - [x] 乙的子\n',
  );
});

test('deleteCompleted: 保留行 raw 一字不动（行保真），空行也留着', () => {
  const l = lines('- [x] 甲\n\n\n- [ ] 乙\n');
  const out = deleteCompleted(l);
  assert.equal(serialize(out), '\n\n- [ ] 乙\n');
  assert.equal(out[2].raw, '- [ ] 乙\n');
});

test('deleteCompleted: 没有可删的 → 内容等值且返回新数组', () => {
  const l = lines('- [ ] 甲\n');
  const out = deleteCompleted(l);
  assert.equal(serialize(out), '- [ ] 甲\n');
  assert.notEqual(out, l);
});

test('deleteCompleted: 全勾选 → 只剩结构（分组标题、空行）', () => {
  const l = lines('**组**\n- [x] 甲\n\n- [x] 乙\n');
  assert.equal(serialize(deleteCompleted(l)), '**组**\n\n');
});
