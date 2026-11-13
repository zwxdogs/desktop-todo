// md.fidelity.test.js — 写回保真：序列化往返、勾选翻转只动一个字符、行内改写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLine, parseText, serialize, toggleRaw, setLineText } from './md.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, 'fixtures', 'sample.md');

test('serialize: 空往返 = 原文', () => {
  for (const src of ['', '\n', '- [ ] a\r\n  - b\n\n**h**\n尾']) {
    assert.equal(serialize(parseText(src)), src);
  }
});

test('serialize: 真实 sample.md 字节级往返', () => {
  const src = readFileSync(SAMPLE, 'utf8');
  assert.equal(serialize(parseText(src)), src);
});

test('toggleRaw: 只把状态字符从空格换成 x，其余字节不动', () => {
  const ln = parseLine('  * [ ]   带空格的行  \r\n');
  const before = ln.raw;
  toggleRaw(ln);
  assert.equal(ln.raw, '  * [x]   带空格的行  \r\n');
  assert.equal(ln.raw.length, before.length);
  assert.equal(ln.checked, true);
});

test('toggleRaw: 反向 x -> 空格', () => {
  const ln = parseLine('- [x] a\n');
  toggleRaw(ln);
  assert.equal(ln.raw, '- [ ] a\n');
  assert.equal(ln.checked, false);
});

test('toggleRaw: 未勾选行整体字节级差异恰好 1 处', () => {
  const src = '- [ ] 父\n  - [ ] 子1\n  - [x] 子2\n  - 备注\n- [ ] 下一个\n';
  const lines = parseText(src);
  toggleRaw(lines[0]);
  const after = serialize(lines);
  assert.notEqual(after, src);
  const diffs = [...src].filter((ch, i) => ch !== after[i]).length;
  assert.equal(diffs, 1);
});

test('setLineText: todo 行重建保留 indent/marker/wsAfterCb/ending', () => {
  const ln = parseLine('  * [ ]   旧文字\r\n');
  setLineText(ln, '新文字');
  assert.equal(ln.raw, '  * [ ]   新文字\r\n');
  assert.equal(ln.text, '新文字');
});

test('setLineText: 已勾选 todo 重建为 [x]', () => {
  const ln = parseLine('- [x] 旧\n');
  setLineText(ln, '新');
  assert.equal(ln.raw, '- [x] 新\n');
});

test('setLineText: note 行重建保留缩进与行尾', () => {
  const ln = parseLine('    - 旧备注\n');
  setLineText(ln, '新备注');
  assert.equal(ln.raw, '    - 新备注\n');
});

test('setLineText: header 行重建', () => {
  const ln = parseLine('**标题**\n');
  setLineText(ln, '新标题');
  assert.equal(ln.raw, '**新标题**\n');
});

test('setLineText: other 行重建为纯文字加行尾', () => {
  const ln = parseLine('普通段落\n');
  setLineText(ln, '改过的段落');
  assert.equal(ln.raw, '改过的段落\n');
});

test('真实 sample.md：翻转一行后其余行字节不变', () => {
  const src = readFileSync(SAMPLE, 'utf8');
  const lines = parseText(src);
  const target = lines.findIndex((l) => l.kind === 'todo' && !l.checked);
  assert.ok(target >= 0, 'sample.md 应存在未完成待办');
  toggleRaw(lines[target]);
  const after = serialize(lines);
  const a = src.split('\n');
  const b = after.split('\n');
  assert.equal(a.length, b.length);
  const changed = a.filter((l, i) => l !== b[i]);
  assert.equal(changed.length, 1);
});
