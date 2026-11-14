// notice.js — 顶栏那条提示的唯一状态机（#18、#20、#21）。
//
// 四种消息共用同一处，因为窗口顶部只有一条位置：
//   ① 写盘失败（save，persistent、可点）：一直挂着，直到某次写盘成功；点它就重试。
//   ② 装载失败（load，persistent、可点）：文件读不进来——被占用 / 没权限 / 不是 UTF-8。
//      一直挂着（它就是这个窗口现在的样子），点它重新读那个文件；读成功才收掉。
//   ③ 一次性的短消息（info）：约 3 秒自己消失，例如「编辑已丢弃」。
//   ④ 一次性的错误（error，persistent、**不可点**）：例如「写备份失败，这次没有删除」。
//      它和 ①② 一样要一直挂着——用户得看清为什么没做成——但它没有「点一下就重试」这个动作：
//      能重试的那件事（再点一次垃圾桶）本来就在界面上，伪装成可点是骗人。
//
// 优先级写在这里而不是窗口里：**比「一条一闪而过的消息」要紧的，是丢字和读不进来**。
// 这个决定不碰 DOM，所以能用 node --test 守住；画它、定时器、点击都在窗口那边。
//
// 状态形状：null | { kind: 'save', text } | { kind: 'load', text }
//                | { kind: 'info', text, token } | { kind: 'error', text }
//   token 由调用方给（每发一条 info 自增）：过期只清自己那一条，
//   免得「A 的定时器到点把后发的 B 清掉」。

/* 点下去要做什么：'retry-save' | 'retry-load' | null。三种「可点/不可点」的答案只有这一份，
   窗口按它分派，不再各自判断 kind。 */
const ACTION = { save: 'retry-save', load: 'retry-load' };

/* 这两种挂着的时候，短消息不许顶上来：它们说的是「字丢了 / 文件读不进来」。
   error 不在里面——它是「上一步没做成」，比一条刚刚发生的事旧，
   所以后面的短消息可以接管它（见 info 分支）。 */
const BLOCKS_INFO = { save: true, load: true };

/** 一条消息的状态迁移。纯函数：同样的 state + ev 永远得到同样的 next。 */
export function nextNotice(state, ev) {
  switch (ev.type) {
    case 'save-failed':
      // 失败永远接管：哪怕是刚弹出来的短消息，也先让位给「你的改动没写进去」
      return { kind: 'save', text: ev.text };
    case 'load-failed':
      // 读不进来比一条早先的写盘失败更贴近现在：此刻清单根本不可写（#21）。
      // 短消息同样让位——文件都读不出来，一句「编辑已丢弃」不是用户要知道的事。
      return { kind: 'load', text: ev.text };
    case 'load-ok':
      // 读成功了：只清装载失败那一条。写盘失败说的是另一件事（读得动不代表写进去了）
      return state && state.kind === 'load' ? null : state;
    case 'error':
      // 一次性的失败同样要一直挂着，但它不可点——不能抢掉「写盘/装载失败」那两条的位置
      if (state && (state.kind === 'save' || state.kind === 'load')) return state;
      return { kind: 'error', text: ev.text };
    case 'dismiss-error':
      // 那件事后来做成了（例如重试删除成功）：一条已经在说别的话的提示保持原样
      return state && state.kind === 'error' ? null : state;
    case 'saved':
      // 只清写盘那条；info 自己有自己的过期时间，load / error 也不是「保存成功」能回答的事
      return state && state.kind === 'save' ? null : state;
    case 'info':
      // 丢字 / 读不进来还挂着时不再刷短消息：两条挤一处，短的那条只会把要紧的盖掉
      if (state && BLOCKS_INFO[state.kind]) return state;
      // 但短消息可以接管 error：它是「刚发生的那件事」，比一条旧的失败说明更贴近现在
      return { kind: 'info', text: ev.text, token: ev.token };
    case 'expire':
      // 只清自己那一条：期间换了新消息就什么都不做
      return state && state.kind === 'info' && state.token === ev.token ? null : state;
    default:
      return state;
  }
}

/** 这条提示现在能不能点（写盘失败 = 重试保存；装载失败 = 重试读取）。 */
export function noticeIsClickable(state) {
  return noticeAction(state) !== null;
}

/** 这条提示点下去要做什么：'retry-save' | 'retry-load' | null（没得点）。 */
export function noticeAction(state) {
  return (state && ACTION[state.kind]) || null;
}
