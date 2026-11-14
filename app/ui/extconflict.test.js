// extconflict.test.js — 外部改动撞上未落盘本地改动时的判定（#22）。
//
// 钉的是三条最容易写反的政策，它们直接决定用户的字会不会无声消失：
//   ① 有未落盘改动才弹，没有就静默重载（同步盘每分钟写一次，每次都弹就是弹窗地狱）。
//   ② 弹层开着时再来外部变化：按住不动，不连环弹、也不偷偷重载。
//   ③ 弹层里失败只把原因挂上去，不许自己关掉——关掉就等于替用户选了「刷新」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasUnflushed, conflictPlan, nextConflict, isConflictOpen, conflictText, conflictFailText,
  outBackupName,
} from './extconflict.js';

/* ---------- ① 有没有未落盘的本地改动 ---------- */

test('没有排着的写盘、也没有编辑：不算未落盘', () => {
  assert.equal(hasUnflushed({ pending: false, editing: false, panelEditing: false }), false);
});

test('写盘合并窗口里还排着一笔：算未落盘', () => {
  // 250ms 防抖窗口里的那几笔是最危险的一种——重载会把它们连同计时器一起丢掉
  assert.equal(hasUnflushed({ pending: true, editing: false, panelEditing: false }), true);
});

test('主窗口内联编辑没提交：算未落盘', () => {
  assert.equal(hasUnflushed({ pending: false, editing: true, panelEditing: false }), true);
});

test('详情面板里有没落定的编辑：算未落盘', () => {
  assert.equal(hasUnflushed({ pending: false, editing: false, panelEditing: true }), true);
});

test('缺字段的调用按「没有」算：判定不许因为少传一个键就抛错', () => {
  assert.equal(hasUnflushed({}), false);
  assert.equal(hasUnflushed(), false);
});

/* ---------- ② 这一轮外部变化该怎么办 ---------- */

test('没有未落盘改动：静默重载，不弹层', () => {
  assert.equal(conflictPlan(null, { hasLocal: false }), 'reload');
});

test('有未落盘改动：弹层问用户', () => {
  assert.equal(conflictPlan(null, { hasLocal: true }), 'prompt');
});

test('弹层还开着：按住不动', () => {
  // 三种输入都要按住的，尤其是「现在看起来没有未落盘改动」那一支：
  // 用户已经把字落进内存（弹层前先落定），此刻重载等于把那些字丢掉
  const open = { kind: 'conflict' };
  assert.equal(conflictPlan(open, { hasLocal: false }), 'hold');
  assert.equal(conflictPlan(open, { hasLocal: true }), 'hold');
});

/* ---------- ③ 弹层的开合 ---------- */

test('弹层从收起状态打开', () => {
  const s = nextConflict(null, { type: 'external', hasLocal: true });
  assert.deepEqual(s, { kind: 'conflict' });
});

test('连着多次外部写入不连环弹：第二、三次不换新状态', () => {
  const first = nextConflict(null, { type: 'external', hasLocal: true });
  const second = nextConflict(first, { type: 'external', hasLocal: true });
  assert.equal(second, first, '同一个弹层不该被后来的外部变化重开一遍');
  const third = nextConflict(second, { type: 'external', hasLocal: true });
  assert.equal(third, first);
});

test('没有未落盘改动时外部变化不动弹层状态', () => {
  assert.equal(nextConflict(null, { type: 'external', hasLocal: false }), null);
});

test('刷新与撤回都收起弹层', () => {
  const open = nextConflict(null, { type: 'external', hasLocal: true });
  assert.equal(nextConflict(open, { type: 'refresh' }), null);
  assert.equal(nextConflict(open, { type: 'revert' }), null);
});

test('收起之后再来一次冲突能重新弹', () => {
  const open = nextConflict(null, { type: 'external', hasLocal: true });
  assert.equal(nextConflict(open, { type: 'refresh' }), null);
  assert.deepEqual(nextConflict(null, { type: 'external', hasLocal: true }), { kind: 'conflict' });
});

test('撤回失败：原因挂在弹层上，弹层不关', () => {
  // 写 -out-bak 失败时原文件一个字节没动，用户此刻还能改选「刷新」——所以弹层必须留着
  const open = nextConflict(null, { type: 'external', hasLocal: true });
  const failed = nextConflict(open, { type: 'failed', reason: 'replace: 拒绝访问。 (os error 5)' });
  assert.deepEqual(failed, { kind: 'conflict', reason: 'replace: 拒绝访问。 (os error 5)' });
});

test('没有弹层时收到失败事件：不凭空开一个弹层', () => {
  assert.equal(nextConflict(null, { type: 'failed', reason: 'x' }), null);
});

test('没见过的动作：状态原样不动', () => {
  const open = nextConflict(null, { type: 'external', hasLocal: true });
  assert.equal(nextConflict(open, { type: 'nonsense' }), open);
  assert.equal(nextConflict(null, { type: 'nonsense' }), null);
});

/* ---------- ④ 「弹层开着」这一个判定，别处也读它 ---------- */

test('isConflictOpen 只认 conflict 那一种状态', () => {
  assert.equal(isConflictOpen(null), false);
  assert.equal(isConflictOpen(undefined), false);
  assert.equal(isConflictOpen({ kind: 'other' }), false);
  assert.equal(isConflictOpen({ kind: 'conflict' }), true);
  assert.equal(isConflictOpen({ kind: 'conflict', reason: 'x' }), true, '带着失败原因时弹层照样开着');
});

/* ---------- ⑤ 文案：两个按钮各是什么、备份叫什么、失败时说什么 ---------- */

test('弹层文案：带文件名，说清两个选择与 -out-bak', () => {
  const t = conflictText('检查清单.md');
  assert.match(t, /检查清单\.md/);
  assert.match(t, /刷新/);
  assert.match(t, /撤回/);
  assert.match(t, /-out-bak/, '要让用户在资源管理器里认得出那份备份');
  assert.match(t, /检查清单-out-bak\.md/, '说具体名字比只说后缀好认');
});

test('弹层文案：说出的备份名必须和 Rust 真写的那个一致', () => {
  // 两边规则的权威在 Rust（files::out_backup_path）；这里是它的只读镜像，
  // 文案里出现了名字就必须是那个名字，否则用户去资源管理器里会找不到。
  const t = conflictText('待办.md');
  assert.match(t, /待办-out-bak\.md/);
  assert.doesNotMatch(t, /待办-bak\.md/, '别把 #20 的删除备份名混进来');
});

test('弹层文案：拿不到文件名时句子仍然通顺（不留空括号）', () => {
  const t = conflictText('');
  assert.match(t, /这个清单/);
  assert.doesNotMatch(t, /「」/, '不许写出一个空文件名');
});

test('失败文案：先说原文件没动，再给原因', () => {
  const t = conflictFailText('replace: 拒绝访问。 (os error 5)');
  assert.match(t, /原文件没有改动/, '最要紧的是「你的文件还在」');
  assert.match(t, /拒绝访问/);
});

test('失败文案：没有原因也说得出一句完整的话', () => {
  assert.match(conflictFailText(''), /未知原因/);
  assert.match(conflictFailText(undefined), /未知原因/);
});

/* ---------- ⑥ 备份文件名：纯函数层也要有（验收第 9 条） ----------
   真写哪个路径由 Rust 的 files::out_backup_path 决定（前端不拼路径，#12）；
   这里钉的是它的只读镜像，两边必须给出同一个名字，否则弹层里说的名字是假的。 */

test('备份文件名：主名后加 -out-bak，扩展名保留', () => {
  assert.equal(outBackupName('E:\\项目\\待办.md'), '待办-out-bak.md');
  assert.equal(outBackupName('E:\\项目\\检查清单.md'), '检查清单-out-bak.md');
  assert.equal(outBackupName('/home/u/待办.md'), '待办-out-bak.md');
  assert.equal(outBackupName('待办.md'), '待办-out-bak.md', '没有目录时也要工作');
});

test('备份文件名：扩展名原样保留（大小写不动）', () => {
  assert.equal(outBackupName('E:\\项目\\清单.MD'), '清单-out-bak.MD');
});

test('备份文件名：主名按最后一个点切', () => {
  assert.equal(outBackupName('E:\\项目\\a.b.md'), 'a.b-out-bak.md');
});

test('备份文件名：没有扩展名就直接追加', () => {
  assert.equal(outBackupName('E:\\项目\\待办'), '待办-out-bak');
});

test('备份文件名：前导点不算扩展名（与 Rust 的 file_stem 一致）', () => {
  assert.equal(outBackupName('E:\\项目\\.md'), '.md-out-bak');
});

test('备份文件名：源文件自己就叫 -out-bak 时再追加一次，永不等同源文件', () => {
  // 与 #20 的 -bak 同一条规则：追加而不是替换
  assert.equal(outBackupName('E:\\项目\\待办-out-bak.md'), '待办-out-bak-out-bak.md');
  assert.notEqual(outBackupName('待办.md'), '待办.md');
  assert.notEqual(outBackupName('待办'), '待办');
  assert.notEqual(outBackupName('.md'), '.md');
  assert.notEqual(outBackupName('待办-out-bak.md'), '待办-out-bak.md');
  assert.notEqual(outBackupName('E:\\项目\\待办.md'), 'E:\\项目\\待办.md');
});

test('备份文件名：拿不到文件名时返回空串，调用方退回不带名字的说法', () => {
  assert.equal(outBackupName(''), '');
  assert.equal(outBackupName(undefined), '');
  assert.equal(outBackupName(null), '');
  assert.equal(outBackupName('E:\\项目\\'), '', '只有目录时没有文件名可拼');
});
