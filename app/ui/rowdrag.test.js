// rowdrag.test.js — 行拖动的落点求解（纯函数，喂几何数据，不碰 DOM）。
// 两份政策：主窗口按「行块 / 分组边界」算落点，详情面板按「本栏内 before/after」算落点。
// 拖动引擎本身（指针捕获、浮层、自动滚）在浏览器里跑，这里只守落点。
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseText } from './md.js';
import { mainDropTarget, panelDropTarget } from './rowdrag.js';

/* 主窗口样例：分组 A（a1、a2）→ 分组 B（b1）。键 = 行下标。 */
const lines = parseText([
  '**A**\n',
  '- [ ] a1\n',
  '- [ ] a2\n',
  '**B**\n',
  '- [ ] b1\n',
].join(''));

const rows = [
  { key: 0, top: 0, bottom: 24 },
  { key: 1, top: 30, bottom: 54 },
  { key: 2, top: 60, bottom: 84 },
  { key: 3, top: 90, bottom: 114 },
  { key: 4, top: 120, bottom: 144 },
];

test('main: 拖待办到另一行上半 → 插在它之前', () => {
  assert.deepEqual(mainDropTarget(lines, rows, 40, 2), { rowKey: 1, where: 'before', slot: 1 });
});

test('main: 拖待办到另一行下半 → 插在整块之后', () => {
  assert.deepEqual(mainDropTarget(lines, rows, 80, 1), { rowKey: 3, where: 'before', slot: 3 });
});

test('main: 落到自己块内部 → 没有落点', () => {
  assert.equal(mainDropTarget(lines, rows, 70, 2), null);
});

test('main: 拖到下一组组头上半 = 自身块尾，没有落点', () => {
  assert.equal(mainDropTarget(lines, rows, 100, 2), null);
});

test('main: 拖到下一组组头下半 → 该组组首之前', () => {
  assert.deepEqual(mainDropTarget(lines, rows, 110, 2), { rowKey: 4, where: 'before', slot: 4 });
});

test('main: 拖到最后一行下半 → 落到文件末尾', () => {
  assert.deepEqual(mainDropTarget(lines, rows, 140, 2), { rowKey: 4, where: 'after', slot: 5 });
});

test('main: 拖分组只认组边界，落进本组中间不算', () => {
  assert.equal(mainDropTarget(lines, rows, 20, 0), null);
});

test('main: 有分组时第一个组头之前没有落点', () => {
  assert.equal(mainDropTarget(lines, rows, -5, 2), null);
});

test('main: 没有分组时可以在第一行之前落下', () => {
  const flat = parseText('- [ ] x\n- [ ] y\n');
  const flatRows = [
    { key: 0, top: 0, bottom: 24 },
    { key: 1, top: 30, bottom: 54 },
  ];
  assert.deepEqual(mainDropTarget(flat, flatRows, -5, 1), { rowKey: 0, where: 'before', slot: 0 });
});

test('main: 拖分组到文件末尾 → 落在最后一行之后', () => {
  assert.deepEqual(mainDropTarget(lines, rows, 140, 0), { rowKey: 4, where: 'after', slot: 5 });
});

test('main: 起拖行不在清单里 → 没有落点', () => {
  assert.equal(mainDropTarget(lines, rows, 40, 99), null);
});

test('main: 没有任何可拖行 → 没有落点', () => {
  assert.equal(mainDropTarget(lines, [], 40, 2), null);
});

test('main: 文件以隐藏行结尾时，拖分组到末尾仍落在文件末尾', () => {
  // 末行 `* note` 不是可拖行，rows 只到 b1；落点必须带回 slot，不能让宿主由末行反推。
  const tail = parseText('**A**\n- [ ] a1\n\n**B**\n- [ ] b1\n* note\n');
  const tailRows = rows.filter((r) => r.key !== 2);
  assert.deepEqual(mainDropTarget(tail, tailRows, 500, 0), { rowKey: 4, where: 'after', slot: 6 });
});

/* 详情面板样例：同一栏里两行，跨栏由 bounds 拒绝。 */
const paneRows = [
  { key: 1, top: 0, bottom: 24 },
  { key: 2, top: 30, bottom: 54 },
];
const bounds = { top: -10, bottom: 200 };

test('panel: 本栏顶部 → 第一行之前', () => {
  assert.deepEqual(panelDropTarget(paneRows, bounds, -5), { rowKey: 1, where: 'before' });
});

test('panel: 行上半 → 之前，下半 → 之后', () => {
  assert.deepEqual(panelDropTarget(paneRows, bounds, 5), { rowKey: 1, where: 'before' });
  assert.deepEqual(panelDropTarget(paneRows, bounds, 20), { rowKey: 1, where: 'after' });
});

test('panel: 本栏底部空白 → 最后一行之后', () => {
  assert.deepEqual(panelDropTarget(paneRows, bounds, 150), { rowKey: 2, where: 'after' });
});

test('panel: 跨栏（指针出了本栏）→ 没有落点', () => {
  assert.equal(panelDropTarget(paneRows, bounds, -20), null);
  assert.equal(panelDropTarget(paneRows, bounds, 201), null);
});

test('panel: 空栏 → 没有落点', () => {
  assert.equal(panelDropTarget([], bounds, 10), null);
});
