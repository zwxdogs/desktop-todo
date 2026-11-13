// md.tree.test.js — 子块扫描/统计/面板分栏/整树删除（逐条对应 test_todo.py 的同名用例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseText, parseLine, subtreeEnd, subtreeStats, panelParts, deleteSubtree, indentUnits, childIndent } from './md.js';

test('indentUnits: expandtabs(4) 语义', () => {
  assert.equal(indentUnits(''), 0);
  assert.equal(indentUnits('    '), 4);
  assert.equal(indentUnits('\t'), 4);
  assert.equal(indentUnits('  \t'), 4);   // 2 空格 + tab → 跳到下个 4 的倍数
  assert.equal(indentUnits('   \t'), 4);
  assert.equal(indentUnits('\t\t'), 8);
});

// ---- childIndent（todo.pyw:151-157：对齐到父条目正文位置）----
test('childIndent: todo 对齐 "- [ ] " 正文起点', () => {
  const ln = parseLine('- [ ] 父任务');
  assert.equal(childIndent(ln), ' '.repeat(0 + 1 + 6));   // units 0 + '-' + 6 = 7
});
test('childIndent: 带缩进的 todo', () => {
  const ln = parseLine('    - [ ] 父任务');
  assert.equal(childIndent(ln), ' '.repeat(4 + 1 + 6));   // units 4 + '-' + 6 = 11
});
test('childIndent: note 用 marker+2', () => {
  const ln = parseLine('  - 注释');
  assert.equal(childIndent(ln), ' '.repeat(2 + 1 + 2));   // units 2 + '-' + 2 = 5
});
test('childIndent: other 无 marker', () => {
  const ln = parseLine('普通行');
  assert.equal(childIndent(ln), '  ');                    // units 0 + '' + 2
});

// ---- subtreeEnd ----
test('subtreeEnd: 无子块', () => {
  const lines = parseText('- [ ] 父\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(lines, 0), 1);
});

test('subtreeEnd: 基本子块', () => {
  const lines = parseText('- [ ] 父\n  - [ ] 子1\n  - [x] 子2\n  - 备注\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(lines, 0), 4);
});

test('subtreeEnd: 中间空行不打断', () => {
  const lines = parseText('- [ ] 父\n  - 子\n\n  - 备注\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(lines, 0), 4);
});

test('subtreeEnd: 块尾空行不算', () => {
  const lines = parseText('- [ ] 父\n  - 子\n\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(lines, 0), 2);
});

test('subtreeEnd: 更深标题截断', () => {
  const lines = parseText('- [ ] 父\n  - 子\n  **小标题**\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(lines, 0), 2);
});

test('subtreeEnd: tab 缩进算子块', () => {
  const lines = parseText('- [ ] 父\n\t- 子\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(lines, 0), 2);
});

test('subtreeEnd: EOF 结尾', () => {
  const lines = parseText('- [ ] 父\n  - 子\n');
  assert.equal(subtreeEnd(lines, 0), 2);
});

test('subtreeEnd: 中间 other 不打断、块尾 other 不算', () => {
  const a = parseText('- [ ] 父\n  普通段落\n  - [ ] 子\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(a, 0), 3);
  const b = parseText('- [ ] 父\n  - 子\n普通段落\n- [ ] 下一个\n');
  assert.equal(subtreeEnd(b, 0), 2);
});

// ---- subtreeStats ----
test('subtreeStats: 递归混合统计 (待办, 完成, 备注)', () => {
  const lines = parseText('- [ ] 父\n  - [ ] 子1\n  - [x] 子2\n    - [ ] 孙\n  - 备注1\n  - 备注2\n');
  assert.deepEqual(subtreeStats(lines, 0), [3, 1, 2]);
});

test('subtreeStats: 只有备注', () => {
  const lines = parseText('- [ ] 父\n  - 备注1\n  - 备注2\n');
  assert.deepEqual(subtreeStats(lines, 0), [0, 0, 2]);
});

test('subtreeStats: 无子块', () => {
  const lines = parseText('- [ ] 父\n- [ ] 下一个\n');
  assert.deepEqual(subtreeStats(lines, 0), [0, 0, 0]);
});

test('subtreeStats: [X] 大写算完成', () => {
  const lines = parseText('- [ ] 父\n  - [X] 子\n');
  assert.deepEqual(subtreeStats(lines, 0), [1, 1, 0]);
});

test('subtreeStats: 更深嵌套全计入', () => {
  const lines = parseText('- [ ] 父\n  - [x] 子\n    - [x] 孙\n      - 曾孙备注\n');
  assert.deepEqual(subtreeStats(lines, 0), [2, 2, 1]);
});

// ---- panelParts ----
test('panelParts: 按文件顺序分栏', () => {
  const lines = parseText('- [ ] 父\n  - [ ] 子1\n  - 备注1\n  - [x] 子2\n  - 备注2\n');
  assert.deepEqual(panelParts(lines, 0), [[1, 3], [2, 4]]);
});

test('panelParts: 无子块', () => {
  const lines = parseText('- [ ] 父\n- [ ] 下一个\n');
  assert.deepEqual(panelParts(lines, 0), [[], []]);
});

test('panelParts: 空行不进栏', () => {
  const lines = parseText('- [ ] 父\n  - [ ] 子\n\n  - 备注\n');
  assert.deepEqual(panelParts(lines, 0), [[1], [3]]);
});

test('panelParts: other 进备注栏', () => {
  const lines = parseText('- [ ] 父\n  普通段落\n  - 备注\n');
  assert.deepEqual(panelParts(lines, 0), [[], [1, 2]]);
});

test('panelParts: 更深内容照常收录', () => {
  const lines = parseText('- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n      - 曾孙备注\n');
  assert.deepEqual(panelParts(lines, 0), [[1, 2], [3]]);
});

test('panelParts: 止于下一个同级待办', () => {
  const lines = parseText('- [ ] A\n- [ ] 父\n  - [ ] 子\n- [ ] B\n');
  assert.deepEqual(panelParts(lines, 1), [[2], []]);
});

// ---- deleteSubtree ----
test('deleteSubtree: 删整块', () => {
  const lines = parseText('- [ ] 父\n  - 子\n- [ ] 下一个\n**分组**\n');
  const rest = deleteSubtree(lines, 0);
  assert.deepEqual(rest.map((l) => l.raw), ['- [ ] 下一个\n', '**分组**\n']);
});

test('deleteSubtree: 保留前面的行', () => {
  const lines = parseText('- [ ] A\n- [ ] 父\n  - 子\n- [ ] B\n');
  const rest = deleteSubtree(lines, 1);
  assert.deepEqual(rest.map((l) => l.raw), ['- [ ] A\n', '- [ ] B\n']);
});

test('deleteSubtree: 删最后一个待办', () => {
  const lines = parseText('- [ ] A\n- [ ] 父\n  - 子\n');
  const rest = deleteSubtree(lines, 1);
  assert.deepEqual(rest.map((l) => l.raw), ['- [ ] A\n']);
});

test('deleteSubtree: 不修改原列表', () => {
  const src = '- [ ] A\n- [ ] 父\n  - 子\n  - 备注\n';
  const lines = parseText(src);
  deleteSubtree(lines, 1);
  assert.equal(lines.length, 4);
});

test('deleteSubtree: 更深子树整删', () => {
  const lines = parseText('- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n      - 备注\n- [ ] B\n');
  const rest = deleteSubtree(lines, 0);
  assert.deepEqual(rest.map((l) => l.raw), ['- [ ] B\n']);
});
