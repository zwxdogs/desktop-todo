// md.move.test.js — 拖动排序的行块搬运（blockEnd / allowsTopSlot / canMove / moveBlock）。
// 每条用例对应 grill-me 定下的规则：整块搬、缩进原样、只行间插入、落回原处不算移动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseText, blockEnd, allowsTopSlot, canMove, moveBlock } from './md.js';

const raws = (lines) => lines.map((l) => l.raw);

// ---- blockEnd ----
test('blockEnd: 待办带走整棵子树', () => {
  const lines = parseText('- [ ] 父\n\t- [ ] 子\n\t- 备注\n- [ ] 下一个\n');
  assert.equal(blockEnd(lines, 0), 3);
});

test('blockEnd: 分组标题带走组内全部行，直到下一个标题', () => {
  const lines = parseText('**A**\n- [ ] a\n- [ ] b\n**B**\n- [ ] c\n');
  assert.equal(blockEnd(lines, 0), 3);
  assert.equal(blockEnd(lines, 3), 5);
});

test('blockEnd: 最后一个分组到文件末尾（含尾部空行）', () => {
  const lines = parseText('**A**\n- [ ] a\n\n\n');
  assert.equal(blockEnd(lines, 0), 4);
});

test('blockEnd: 备注行自成一格', () => {
  const lines = parseText('- [ ] a\n- 注释\n');
  assert.equal(blockEnd(lines, 1), 2);
});

test('blockEnd: 下标越界退回 i+1', () => {
  const lines = parseText('- [ ] a\n');
  assert.equal(blockEnd(lines, 5), 6);
});

// ---- allowsTopSlot ----
test('allowsTopSlot: 文件以分组标题开头时，不许落到它之前', () => {
  const lines = parseText('**A**\n- [ ] a\n');
  assert.equal(allowsTopSlot(lines), false);
});

test('allowsTopSlot: 文件以待办开头时允许', () => {
  const lines = parseText('- [ ] a\n- [ ] b\n');
  assert.equal(allowsTopSlot(lines), true);
});

test('allowsTopSlot: 开头有空行、后面有分组标题时仍不许', () => {
  const lines = parseText('\n**A**\n- [ ] a\n');
  assert.equal(allowsTopSlot(lines), false);
});

test('allowsTopSlot: 一眼看不出来——开头是顶格备注，后面才出现分组标题', () => {
  const lines = parseText('- 备注\n**A**\n- [ ] a\n');
  assert.equal(allowsTopSlot(lines), false);
});

// ---- canMove ----
test('canMove: 跨分组搬运合法', () => {
  const lines = parseText('**A**\n- [ ] a\n**B**\n- [ ] b\n');
  assert.equal(canMove(lines, 1, 4), true);   // a 搬到 b 之后
  assert.equal(canMove(lines, 3, 1), true);   // b 搬到 a 之前
});

test('canMove: 落回原位置或原块尾都算没动', () => {
  const lines = parseText('**A**\n- [ ] a\n- [ ] b\n');
  assert.equal(canMove(lines, 1, 1), false);
  assert.equal(canMove(lines, 1, 2), false);
});

test('canMove: 插进自己的子树里不合法', () => {
  const lines = parseText('- [ ] 父\n\t- [ ] 子\n\t- 备注\n- [ ] 下一个\n');
  assert.equal(canMove(lines, 0, 1), false);
  assert.equal(canMove(lines, 0, 2), false);
  assert.equal(canMove(lines, 0, 3), false);   // 落在块尾 = 原位置，也算没动
  assert.equal(canMove(lines, 0, 4), true);    // 搬到文件末尾
});

test('canMove: 分组标题不能落到自己组里，但能整组搬到最后', () => {
  const lines = parseText('**A**\n- [ ] a\n**B**\n- [ ] b\n');
  assert.equal(canMove(lines, 0, 2), false);
  assert.equal(canMove(lines, 0, 4), true);    // 落点是文件末尾
});

test('canMove: 下标越界不合法', () => {
  const lines = parseText('- [ ] a\n');
  assert.equal(canMove(lines, 0, -1), false);
  assert.equal(canMove(lines, 0, 9), false);
});

test('canMove: 第一个分组标题之前的位置永远不合法（开头有杂物也一样）', () => {
  const lines = parseText('\n**A**\n- [ ] a\n- [ ] b\n');
  assert.equal(canMove(lines, 3, 0), false);   // 空行之前
  assert.equal(canMove(lines, 3, 1), false);   // 标题之前
  assert.equal(canMove(lines, 3, 2), true);    // 组内第一条之前 = 组首
});

test('canMove: 分组只落在分组边界上——不能插进别人组中间', () => {
  const lines = parseText('**A**\n- [ ] a\n- [ ] b\n**C**\n- [ ] c\n**D**\n- [ ] d\n');
  assert.equal(canMove(lines, 3, 1), false);   // 插进 A 组中间会让 A 的条目归给 C
  assert.equal(canMove(lines, 3, 2), false);
  assert.equal(canMove(lines, 3, 0), false);   // 第一个标题之前
  assert.equal(canMove(lines, 3, 7), true);    // 文件末尾
});

test('canMove: 分组落到别的分组标题之前合法', () => {
  const lines = parseText('**A**\n- [ ] a\n**B**\n- [ ] b\n**C**\n- [ ] c\n');
  assert.equal(canMove(lines, 4, 2), true);    // C 搬到 B 之前
  assert.equal(canMove(lines, 4, 0), false);   // 不能搬到第一组之前
  assert.equal(canMove(lines, 4, 1), false);   // A 组内部不是组边界
  assert.equal(canMove(lines, 4, 6), false);   // 自己就是最后一组：末尾 = 原块尾，算没动
});

// ---- moveBlock ----
test('moveBlock: 待办连子块搬到另一组，字节零改动', () => {
  const lines = parseText('**A**\n- [ ] a\n\t- [ ] 子\n\t- 备注\n**B**\n- [ ] b\n');
  const out = moveBlock(lines, 1, 6);
  assert.deepEqual(raws(out), [
    '**A**\n',
    '**B**\n',
    '- [ ] b\n',
    '- [ ] a\n',
    '\t- [ ] 子\n',
    '\t- 备注\n',
  ]);
});

test('moveBlock: 把待办搬到组首', () => {
  const lines = parseText('**A**\n- [ ] a\n**B**\n- [ ] b\n- [ ] c\n');
  const out = moveBlock(lines, 4, 3);          // c 搬到 B 的组首
  assert.deepEqual(raws(out), ['**A**\n', '- [ ] a\n', '**B**\n', '- [ ] c\n', '- [ ] b\n']);
});

test('moveBlock: 整组搬到另一组之前', () => {
  const lines = parseText('**A**\n- [ ] a\n**B**\n- [ ] b\n**C**\n- [ ] c\n');
  const out = moveBlock(lines, 4, 2);           // C 搬到 B 之前（第一组之前不设落点）
  assert.deepEqual(raws(out), [
    '**A**\n', '- [ ] a\n', '**C**\n', '- [ ] c\n', '**B**\n', '- [ ] b\n',
  ]);
});

test('moveBlock: 备注行也能搬', () => {
  const lines = parseText('- [ ] p\n\t- 甲\n\t- 乙\n');
  const out = moveBlock(lines, 2, 1);
  assert.deepEqual(raws(out), ['- [ ] p\n', '\t- 乙\n', '\t- 甲\n']);
});

test('moveBlock: 不放回原位置就不改动（返回等值新数组）', () => {
  const src = '- [ ] a\n- [ ] b\n';
  const lines = parseText(src);
  const out = moveBlock(lines, 0, 0);
  assert.equal(out.map((l) => l.raw).join(''), src);
});

test('moveBlock: 不修改传入的数组', () => {
  const lines = parseText('- [ ] a\n- [ ] b\n');
  moveBlock(lines, 0, 2);
  assert.equal(lines[0].text, 'a');
});

test('moveBlock: 末尾无换行的行搬到中间时补行尾符', () => {
  const lines = parseText('- [ ] a\n- [ ] b');
  const out = moveBlock(lines, 1, 0);
  assert.equal(out.map((l) => l.raw).join(''), '- [ ] b\n- [ ] a\n');
});

test('moveBlock: 落到无行尾符的行之后时补行尾符', () => {
  const lines = parseText('- [ ] a\n- [ ] b\n- [ ] c\n');
  lines[0].raw = '- [ ] a';                    // 人为造出「中间行没行尾符」
  const out = moveBlock(lines, 2, 1);
  assert.equal(out.map((l) => l.raw).join(''), '- [ ] a\n- [ ] c\n- [ ] b\n');
});

test('moveBlock: 用文件自己的行尾符（CRLF 文件）', () => {
  const lines = parseText('- [ ] a\r\n- [ ] b');
  const out = moveBlock(lines, 1, 0, '\r\n');
  assert.equal(out.map((l) => l.raw).join(''), '- [ ] b\r\n- [ ] a\r\n');
});
