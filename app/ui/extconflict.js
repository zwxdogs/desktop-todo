// extconflict.js — 外部改动撞上未落盘本地改动时的整个判定（#22）。
//
// 每秒一轮的 poll 按 `mtime:size` 发现文件变了。以前它无条件 `loadFile()`，而 `loadFile`
// 开头就是 `list.cancelSave()`：250ms 写盘合并窗口里还没落盘的那几笔直接丢，撤销栈也被
// 整份重载清空。单机少见，上同步盘（Obsidian 同步、另一台机器推送）就是日常。
//
// 三件事收在一处，因为它们是同一个判断的三面：
//   ① 有没有未落盘的本地改动（`hasUnflushed`）——决定要不要打扰用户；
//   ② 这一轮外部变化该怎么办（`conflictPlan`）——reload / prompt / hold；
//   ③ 弹层的开合（`nextConflict`）——纯状态机，照 notice.js 的做法。
//
// 为什么 ① 要包含「有编辑没提交」而不只是「排着写盘」：正在编辑的那一行，用户已经打了字
// 但一个字都没进内存——重载会把它连同输入框一起换掉。那不是「可能丢」，是一定丢。
//
// 政策是维护者 2026-11-14 拍板的（票 #22 正文）：**只在有未落盘改动时才弹**。同步盘可能
// 每分钟写一次，每次都弹就是弹窗地狱；而内存与磁盘无差别时刷新本来就无感。

/**
 * 现在有没有**不会自己消失**的本地改动。
 *
 * 三个来源任何一个成立都算：
 *   pending       写盘合并窗口（`list.pending()`）里还排着一笔——重载会把计时器一起清掉；
 *   editing       主窗口内联编辑没提交（`S.edit`）；
 *   panelEditing  详情面板里有没落定的编辑（`S.panelEditing`）。
 *
 * **判定要用落定之前的状态**：落定会把 editing / panelEditing 清零、只留下一次排着的
 * 写盘，落定之后再问就永远只剩 pending 一条了（见 app.js 的 externalChanged）。
 *
 * 缺字段按「没有」算：调用方少传一个键是好几个调用点的写法问题，不该让一次轮询抛错。
 */
export function hasUnflushed(unflushed = {}) {
  const u = unflushed || {};
  return !!(u.pending || u.editing || u.panelEditing);
}

/** 冲突弹层是不是开着。`conflictPlan` 的 'hold' 就是这一条，调用方读它比造一个假 hasLocal 清楚。 */
export function isConflictOpen(state) {
  return !!(state && state.kind === 'conflict');
}

/**
 * 这一轮外部变化该怎么办：
 *
 *   'reload' —— 静默重载（内存与磁盘没有未落盘的差别，刷新无感）。
 *   'prompt' —— 弹层问用户「刷新 / 撤回」。
 *   'hold'   —— 弹层还开着：这一轮什么也不做。
 *
 * 'hold' 是防连环弹窗的那一半。注意它**不看** hasLocal：弹层出现之前当前编辑已经落定
 * （`flushPanel` + `closeEditor`），那些字此刻在内存里排着写盘——若因为「现在看着没有未落盘
 * 改动」就去重载，等于把刚落定的那几笔连同弹层一起丢掉。
 */
export function conflictPlan(state, { hasLocal } = {}) {
  if (isConflictOpen(state)) return 'hold';
  return hasLocal ? 'prompt' : 'reload';
}

/**
 * 弹层状态的一次迁移。纯函数：同样的 state + ev 永远得到同样的 next。
 *
 * 形状：null | { kind: 'conflict', reason? }
 *   reason 只在「撤回失败」时出现——那次原文件一个字节都没动，界面要说清为什么。
 */
export function nextConflict(state, ev) {
  switch (ev.type) {
    case 'external':
      // 已经开着就原样返回（同一个对象）：连着几次外部写入不会把弹层重开一遍
      if (state && state.kind === 'conflict') return state;
      return ev.hasLocal ? { kind: 'conflict' } : state;
    case 'refresh':
    case 'revert':
      // 两个按钮都收起弹层。撤回失败走的是 failed，不是 revert——那时弹层要留着。
      return null;
    case 'failed':
      // 撤回没成功：原因挂在弹层上，弹层不关。此刻用户还能改选「刷新」，
      // 而关掉弹层等于替他选了「刷新」（丢掉内存里的改动）。
      if (!state || state.kind !== 'conflict') return state;
      return { kind: 'conflict', reason: ev.reason ? String(ev.reason) : '未知原因' };
    default:
      return state;
  }
}

/**
 * 弹层里给用户看的那句话。`name` 是当前清单的文件名。
 *
 * 措辞要说清三件事：外部改过了、此刻有两个选择、撤回会先留一份备份在哪儿。
 * 「-out-bak」这个名字写在这里（而不是拼进文件名）：用户要能在资源管理器里认出它。
 */
export function conflictText(name) {
  const who = name ? `「${name}」` : '这个清单';
  return `文件被其他程序改过了：${who}。`
    + '选「刷新」用磁盘上的版本，这次改动会丢；'
    + '选「撤回」先把外部那份存成同目录的 -out-bak 备份，再用你现在看到的版本整份写回。';
}

/** 撤回没成功时挂在弹层上的那句话（原文件一个字节没动，用户还能改选「刷新」）。 */
export function conflictFailText(reason) {
  return `没能存下外部那份备份，原文件没有改动：${reason || '未知原因'}`;
}
