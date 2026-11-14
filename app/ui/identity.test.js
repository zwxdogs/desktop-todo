import test from 'node:test';
import assert from 'node:assert/strict';

import { readIdentity } from './identity.js';

test('回传的身份原样带回 file/title', () => {
  const id = readIdentity({ file: 'E:/项目/待办.md', title: '待办' });
  assert.deepEqual(id, { file: 'E:/项目/待办.md', title: '待办' });
});

test('多余的字段不参与身份（app_info 还带 docked）', () => {
  const id = readIdentity({ file: 'a.md', title: 'a', docked: true });
  assert.deepEqual(id, { file: 'a.md', title: 'a' });
});

test('读不到 title 就抛错，而不是把 undefined 落进状态', () => {
  // 旧 AppInfo 只有 file/testing/docked：boot 读 info.title 得 undefined，标题永远回退常量
  assert.throws(() => readIdentity({ file: 'a.md' }), /文件身份字段缺失/);
});

test('command 取消（null）不是身份，也不许静默通过', () => {
  assert.throws(() => readIdentity(null), /文件身份字段缺失/);
});

test('字段类型不对同样抛错', () => {
  assert.throws(() => readIdentity({ file: 1, title: 'a' }), /文件身份字段缺失/);
  assert.throws(() => readIdentity({ file: 'a.md', title: null }), /文件身份字段缺失/);
});
