// notice.js — 顶栏那条提示的唯一状态机（#18）。
//
// 两种消息共用同一处，因为窗口顶部只有一条位置：
//   ① 写盘失败（persistent）：一直挂着，直到某次写盘成功；点它就重试。
//   ② 一次性的短消息（info）：约 3 秒自己消失，例如「编辑已丢弃」。
//
// 优先级写在这里而不是窗口里：**还没保存成功的时候，一条一闪而过的消息不能把它盖掉**。
// 这个决定不碰 DOM，所以能用 node --test 守住；画它、定时器、点击都在窗口那边。
//
// 状态形状：null | { kind: 'save', text } | { kind: 'info', text, token }
//   token 由调用方给（每发一条 info 自增）：过期只清自己那一条，
//   免得「A 的定时器到点把后发的 B 清掉」。

/** 一条消息的状态迁移。纯函数：同样的 state + ev 永远得到同样的 next。 */
export function nextNotice(state, ev) {
  switch (ev.type) {
    case 'save-failed':
      // 失败永远接管：哪怕是刚弹出来的短消息，也先让位给「你的改动没写进去」
      return { kind: 'save', text: ev.text };
    case 'saved':
      // 只清写盘那条；info 自己有自己的过期时间，不归保存成功管
      return state && state.kind === 'save' ? null : state;
    case 'info':
      // 写盘失败还挂着时不再刷短消息：两条挤一处，短的那条只会把要紧的盖掉
      if (state && state.kind === 'save') return state;
      return { kind: 'info', text: ev.text, token: ev.token };
    case 'expire':
      // 只清自己那一条：期间换了新消息就什么都不做
      return state && state.kind === 'info' && state.token === ev.token ? null : state;
    default:
      return state;
  }
}

/** 这条提示现在能不能点（只有写盘失败那条能点：点它是重试）。 */
export function noticeIsClickable(state) {
  return !!state && state.kind === 'save';
}
