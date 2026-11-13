// starter.test.js — 新建文件的示例内容与「没有打开文件」提示语。
// 这两样都是用户第一次见到这个软件时唯一会读的东西，因此锁死它们的结构与措辞。

import test from 'node:test';
import assert from 'node:assert/strict';
import { starterText, missingHint } from './starter.js';
import { parseText, indentUnits } from './md.js';

test('示例内容是一份能直接用的清单：一段说明 + 一个分组 + 六条待办 + 一条挂在父任务下的注释', () => {
  const kinds = parseText(starterText('\r\n')).map((l) => l.kind);
  assert.deepEqual(kinds, [
    'other', 'blank', 'header', 'blank',
    'todo', 'todo', 'todo', 'todo', 'todo', 'todo',
    'note',
  ]);
});

test('示例的分组标题是「开始使用」', () => {
  const lines = parseText(starterText('\r\n'));
  assert.equal(lines[2].kind, 'header');
  assert.equal(lines[2].text, '开始使用');
});

test('示例里那条注释真的挂在最后一条待办下面（缩进比父任务深）', () => {
  const lines = parseText(starterText('\n'));
  const parent = lines[9];
  const note = lines[10];
  assert.equal(parent.kind, 'todo');
  assert.ok(indentUnits(note.indent) > indentUnits(parent.indent));
});

test('示例内容每一行都用调用方给的换行符结尾', () => {
  const crlf = starterText('\r\n');
  assert.ok(crlf.endsWith('\r\n'));
  assert.equal(crlf.replace(/\r\n/g, '').includes('\n'), false);
  const lf = starterText('\n');
  assert.equal(lf.includes('\r'), false);
});

test('没有打开文件时的提示按图标序号告诉用户点哪一个', () => {
  assert.equal(missingHint(2, 1),
    '目前没有打开待办 Markdown 文件。\n'
    + '请点击上方的第 2 个图标新建文件，或点击第 1 个图标打开已有文件。');
});

test('拿不到图标序号时不写出「第 0 个」，退化成不带数字的提示', () => {
  const t = missingHint(0, 0);
  assert.ok(!t.includes('第 0 个'));
  assert.ok(t.includes('新建文件'));
  assert.ok(t.includes('打开已有文件'));
});
