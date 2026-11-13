// md.insert.test.js — 「点加号在条目下方插一条待办」的落点（md.todoBelow）。
// 接缝：纯函数，只回答两个值 —— 新行跟在谁后面（after）、缩进多少（indent）。
// after 直接喂 insertLine：它的 ref 是"插在这一行之后"，所以带子块的待办取 subtreeEnd-1。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseText, todoBelow } from './md.js';

const lines = (text) => parseText(text);

test('todoBelow: 分组标题 → 紧跟标题，缩进跟组内第一条待办', () => {
  const l = lines('**组**\n    - [ ] 甲\n    - [ ] 乙\n');
  assert.deepEqual(todoBelow(l, 0), { after: 0, indent: '    ' });
});

test('todoBelow: 没有子项的待办 → 紧跟它后面，缩进与它相同', () => {
  const l = lines('**组**\n  - [ ] 甲\n- [ ] 乙\n');
  assert.deepEqual(todoBelow(l, 1), { after: 1, indent: '  ' });
});

test('todoBelow: 带子块的待办 → 插在整块之后，不抢子项', () => {
  const l = lines('- [ ] 父\n    - [ ] 子\n    - 备注\n    - [ ] 子二\n- [ ] 下一个\n');
  assert.deepEqual(todoBelow(l, 0), { after: 3, indent: '' });
});

test('todoBelow: 组头后是空行 / 下一个组头 / 文件末尾 → 顶格', () => {
  assert.deepEqual(todoBelow(lines('**组**\n\n- [ ] 甲\n'), 0), { after: 0, indent: '' });
  assert.deepEqual(todoBelow(lines('**组**\n**另一组**\n'), 0), { after: 0, indent: '' });
  assert.deepEqual(todoBelow(lines('**组**\n'), 0), { after: 0, indent: '' });
});

test('todoBelow: 子块末尾的空行不算块内 → 插在空行之前', () => {
  const l = lines('- [ ] 父\n    - [ ] 子\n\n- [ ] 下一个\n');
  assert.deepEqual(todoBelow(l, 0), { after: 1, indent: '' });
});

test('todoBelow: 末行没有换行符也照常给落点（补换行是 insertLine 的事）', () => {
  const l = lines('- [ ] 甲\n- [ ] 乙');
  assert.deepEqual(todoBelow(l, 1), { after: 1, indent: '' });
});

test('todoBelow: tab 缩进原样抄回，不换算成空格', () => {
  const l = lines('- [ ] 父\n\t- [ ] 子\n');
  assert.deepEqual(todoBelow(l, 0), { after: 1, indent: '' });
  assert.deepEqual(todoBelow(l, 1), { after: 1, indent: '\t' });
});

test('todoBelow: tab 与空格混用的缩进也原样带回，不折算', () => {
  const l = lines('**组**\n\t  - [ ] 事\n');
  assert.deepEqual(todoBelow(l, 0), { after: 0, indent: '\t  ' });
  assert.deepEqual(todoBelow(l, 1), { after: 1, indent: '\t  ' });
});

test('todoBelow: 备注、普通段落、空行没有加号 → null；越界也 null', () => {
  const l = lines('- 备注\n段落\n\n');
  assert.equal(todoBelow(l, 0), null);
  assert.equal(todoBelow(l, 1), null);
  assert.equal(todoBelow(l, 2), null);
  assert.equal(todoBelow(l, 9), null);
});
