// readfail.test.js — 「文件在，但读不进来」的判定、措辞，以及读失败期间能不能写（#21）。
//
// 三件事一起钉，因为它们是同一个判断的三面：分错了类就会给出错误的处置办法，
// 而「能不能写」判错了会让用户的文件被内存里那份空清单盖掉——比说错一句话危险得多。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReadError, fileNameOf, unreadableHint, notUtf8Hint,
  loadFailure, canWriteList, loadNoticeText,
} from './readfail.js';

/* ---------- 分类 ---------- */

test('Rust 的三种前缀分得开：missing / read / utf8', () => {
  assert.equal(classifyReadError('missing: 系统找不到指定的文件。 (os error 2)'), 'missing');
  assert.equal(classifyReadError('read: 拒绝访问。 (os error 5)'), 'unreadable');
  assert.equal(classifyReadError('utf8: invalid utf-8 sequence of 1 bytes from index 0'), 'not-utf8');
});

test('只按前缀认，不按正文里出现过的字认', () => {
  // 文件被占住时，Windows 的正文里恰好带 file/read 这些词也不许被认成「不是 UTF-8」
  assert.equal(
    classifyReadError('read: 另一个程序正在使用此文件，进程无法访问。 (os error 32)'),
    'unreadable',
  );
  assert.equal(classifyReadError('utf8: 文件 read 到一半'), 'not-utf8');
});

test('认不出来的说法一律算「打不开」：不许退回什么都不显示', () => {
  // 空白窗口正是这个 bug 本身；哪怕是一个没见过的 IO 错误，也得让界面说点什么
  assert.equal(classifyReadError(''), 'unreadable');
  assert.equal(classifyReadError(undefined), 'unreadable');
  assert.equal(classifyReadError(null), 'unreadable');
  assert.equal(classifyReadError('some other io failure'), 'unreadable');
});

test('包在 Error 对象里的消息也认得出', () => {
  assert.equal(classifyReadError(new Error('utf8: invalid utf-8 sequence')), 'not-utf8');
  assert.equal(classifyReadError(new Error('missing: 不在')), 'missing');
});

/* ---------- 措辞 ---------- */

test('提示里只报文件名，不报整条路径', () => {
  assert.equal(fileNameOf('E:\\项目\\待办.md'), '待办.md');
  assert.equal(fileNameOf('E:/项目/待办.md'), '待办.md');
  assert.equal(fileNameOf('待办.md'), '待办.md');
  assert.equal(fileNameOf('E:\\项目\\子目录\\检查清单.md'), '检查清单.md');
});

test('读不动（被占用 / 没权限）的说法逐字钉住', () => {
  assert.equal(
    unreadableHint('E:\\项目\\待办.md'),
    '打不开这个文件：待办.md　可能正被别的程序占用，或没有读取权限。'
    + '关掉占用它的程序后，点这里重试。',
  );
});

test('不是 UTF-8 的说法逐字钉住，且给出另存为 UTF-8 的指引', () => {
  assert.equal(
    notUtf8Hint('E:\\项目\\待办.md'),
    '这个文件不是 UTF-8 编码，读不出来：待办.md　用记事本打开它，'
    + '另存为时把编码选成 UTF-8，再回来点这里重试。',
  );
});

test('两条提示都不把整条路径带进界面（窄窗口里会把句子挤散）', () => {
  assert.ok(!unreadableHint('E:\\项目\\待办.md').includes('E:\\'));
  assert.ok(!notUtf8Hint('E:\\项目\\待办.md').includes('项目'));
});

test('拿不到文件名时句子仍然通顺，不留一个空冒号', () => {
  for (const t of [unreadableHint(''), notUtf8Hint(''), unreadableHint(null)]) {
    assert.ok(!t.includes('：　'), t);
    assert.ok(!t.includes('：，'), t);
  }
  assert.ok(unreadableHint('').startsWith('打不开这个文件'));
  assert.ok(notUtf8Hint('').startsWith('这个文件不是 UTF-8 编码'));
});

/* ---------- 可写判定 ---------- */

test('装载成功：可写，且没有任何错误提示', () => {
  const s = loadFailure({ file: 'E:\\项目\\待办.md', kind: 'ok' });
  assert.equal(s, null, '成功就没有失败可记');
  assert.equal(canWriteList({ loaded: true, failure: s }), true);
  assert.equal(loadNoticeText(s), null);
});

test('读不动 / 不是 UTF-8：都不可写', () => {
  for (const kind of ['unreadable', 'not-utf8']) {
    const s = loadFailure({ file: 'E:\\项目\\待办.md', kind });
    assert.equal(canWriteList({ loaded: false, failure: s }), false, kind);
  }
});

test('最危险的一支：不是 UTF-8 时，即使 loaded 还是旧的 true 也不许当可写', () => {
  // 文件里有内容、内存里是空的，放开写就是清空用户的清单
  const s = loadFailure({ file: 'E:\\项目\\待办.md', kind: 'not-utf8' });
  assert.equal(canWriteList({ loaded: true, failure: s }), false);
});

test('没有打开文件（缺失态）不可写，与以前一致', () => {
  const s = loadFailure({ file: 'E:\\项目\\待办.md', kind: 'missing' });
  assert.equal(canWriteList({ loaded: false, failure: s }), false);
});

/* ---------- 提示条说什么 ---------- */

test('两种读失败的提示语就是上面那两份常量', () => {
  const file = 'E:\\项目\\待办.md';
  assert.equal(loadNoticeText(loadFailure({ file, kind: 'unreadable' })), unreadableHint(file));
  assert.equal(loadNoticeText(loadFailure({ file, kind: 'not-utf8' })), notUtf8Hint(file));
});

test('缺失态不借提示条说话：它有自己的占位（starter.js 的 missingHint）', () => {
  const s = loadFailure({ file: 'E:\\项目\\待办.md', kind: 'missing' });
  assert.equal(loadNoticeText(s), null);
});

test('提示语跟着当前文件走：换了文件重试，句子报的是新文件名', () => {
  const a = loadFailure({ file: 'E:\\项目\\甲.md', kind: 'unreadable' });
  const b = loadFailure({ file: 'E:\\项目\\乙.md', kind: 'unreadable' });
  assert.ok(loadNoticeText(a).includes('甲.md'));
  assert.ok(loadNoticeText(b).includes('乙.md'));
});
