// md.test.js — md.js 的单元测试（node --test）。
// 接缝：parseLine / parseText / serialize —— 行保真的地基，与 todo.pyw 同名纯函数语义一一对应。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, parseText } from './md.js';

test('parseLine: 空白行 kind=blank', () => {
  const ln = parseLine('   \n');
  assert.equal(ln.kind, 'blank');
  assert.equal(ln.raw, '   \n');
});

test('parseLine: 分组标题 kind=header，indent/text 拆出', () => {
  const ln = parseLine('  **分组名**\n');
  assert.equal(ln.kind, 'header');
  assert.equal(ln.indent, '  ');
  assert.equal(ln.text, '分组名');
});

test('parseLine: 未完成待办 checked=false，cbPos 指向方括号内状态字符', () => {
  const ln = parseLine('- [ ] 买牛奶\n');
  assert.equal(ln.kind, 'todo');
  assert.equal(ln.indent, '');
  assert.equal(ln.marker, '-');
  assert.equal(ln.checked, false);
  assert.equal(ln.text, '买牛奶');
  assert.equal(ln.cbPos, 3);       // "- [ ] ..." 中 '[' 下标 2，状态字符下标 3
  assert.equal(ln.wsAfterCb, ' '); // "] 买" 之间的那个空格，Python 版同此
});

test('parseLine: 已完成待办 [x]/[X] 都算 checked', () => {
  assert.equal(parseLine('- [x] a\n').checked, true);
  assert.equal(parseLine('- [X] a\n').checked, true);
});

test('parseLine: wsAfterCb 保留复选框后的空白', () => {
  const ln = parseLine('  * [ ]   带空格的行\n');
  assert.equal(ln.indent, '  ');
  assert.equal(ln.marker, '*');
  assert.equal(ln.wsAfterCb, '   ');
  assert.equal(ln.text, '带空格的行');
  assert.equal(ln.cbPos, 5);
});

test('parseLine: 备注行 kind=note', () => {
  const ln = parseLine('  - 这是一条备注\n');
  assert.equal(ln.kind, 'note');
  assert.equal(ln.indent, '  ');
  assert.equal(ln.marker, '-');
  assert.equal(ln.text, '这是一条备注');
});

test('parseLine: 普通段落 kind=other，text 为去行尾原文', () => {
  const ln = parseLine('普通段落\n');
  assert.equal(ln.kind, 'other');
  assert.equal(ln.text, '普通段落');
});

test('parseLine: ending 记录行尾符，无行尾为空串', () => {
  assert.equal(parseLine('a\r\n').ending, '\r\n');
  assert.equal(parseLine('a\n').ending, '\n');
  assert.equal(parseLine('a').ending, '');
});

test('parseLine: CRLF 的 cbPos 不受行尾影响', () => {
  assert.equal(parseLine('- [ ] a\r\n').cbPos, 3);
});

test('parseText: 按 splitlines(true) 语义切行（保留行尾，末行可无行尾）', () => {
  const lines = parseText('- [ ] A\n- [ ] B\r\n尾行');
  assert.deepEqual(lines.map((l) => l.raw), ['- [ ] A\n', '- [ ] B\r\n', '尾行']);
});
