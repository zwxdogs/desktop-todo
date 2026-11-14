/* 详情面板协议（#16）：主窗口与详情面板之间的跨窗消息只认这一张表。
   以前十几个消息形状是两窗各自的字符串字面量（panel-data / panel-req / panel-commit /
   panel-hide / panel-ready），加一个面板操作要同时改 switch、处理函数、确认方向三处；
   「面板改完了没有」则压在主窗口一个 400ms 墙钟上。这里把三件事各收成一处：

   1. TABLE —— 消息名、方向、载荷键的唯一出处。窗口只按名字 send、按名字装处理函数，
      发错方向、少键、多键在编码时就抛错，不再靠对端猜。
   2. 握手 —— 两窗同一件事：装好监听，向对端 hello；对端 hello 之前发的消息排队
      （data 只留最后一份，它是「当前内容」而不是一次事件），hello 之后补发。
      宿主对象 window.__TAURI__ 由注入脚本在页面脚本之前写好，拿不到就是真坏了，
      所以只取一次、当场报错，不再每 20ms 轮询。
   3. 落定 —— 主窗口 flush {id} 请面板把未定稿的编辑交出来；面板回 receipt {id, ops}，
      回执本身就是「面板本来要交什么」的完整答案，所以主窗口只等回执，
      超时只剩一条告警。编辑既不会因为面板收起而丢，也不会因为墙钟到点而被当成已落定。

   本模块不碰 DOM、不碰清单：窗口只交一个 link（发 / 收）和一张处理函数表。
   所以它能用 node --test 直接跑（panelproto.test.js 里两头接上线手动投递，
   于是「还没握手那一刻」也能停住看清楚）。 */

'use strict';

export const MAIN = 'main';
export const PANEL = 'panel';
/* 方向按收端命名：to-main 由面板发出、主窗口收，反之亦然。
   BOTH 只给握手用——两窗各发各的 hello，收端不同、事件通道也不同。 */
export const TO_MAIN = 'to-main';
export const TO_PANEL = 'to-panel';
export const BOTH = 'both';

/* 每个方向一条事件通道，载荷统一是 { type, ...fields }。 */
const EVENT = { [TO_MAIN]: 'proto-to-main', [TO_PANEL]: 'proto-to-panel' };

/* 协议表：消息名 / 种类 / 方向 / 载荷键 / 一句话说明。
   kind = 'op'      面板对清单的一次操作（落定回执里可以一起交回）
        = 'notice'  面板的状态与握手（回执由协议自己处理）
        = 'command' 主窗口对面板的命令
   caption 只给人看，代码不读它。
   载荷里的 `j` 是清单里的行下标（面板两栏的行都用它定位），沿用 panel.js / list.js
   里同一套叫法，别在协议里另起一个名字。 */
export const TABLE = [
  // —— 面板 → 主窗口：清单操作（新增一个面板操作 = 这里加一行 + 主窗口给一个处理函数）——
  { name: 'toggle', kind: 'op', dir: TO_MAIN, fields: ['j'], caption: '勾选 / 取消这一行' },
  { name: 'setText', kind: 'op', dir: TO_MAIN, fields: ['j', 'value'], caption: '改这一行的文字（内联编辑落定）' },
  { name: 'discardEdit', kind: 'op', dir: TO_MAIN, fields: ['j'], caption: '内联编辑被取消，主窗口重推内容' },
  { name: 'remove', kind: 'op', dir: TO_MAIN, fields: ['j'], caption: '删除这一行（待办带走整个子块）' },
  { name: 'addTodo', kind: 'op', dir: TO_MAIN, fields: [], caption: '在子待办栏末尾加一条' },
  { name: 'addNote', kind: 'op', dir: TO_MAIN, fields: [], caption: '在备注栏末尾加一条' },
  { name: 'addBelow', kind: 'op', dir: TO_MAIN, fields: ['kind', 'j'], caption: '在这一行下方插一条同类条目' },
  { name: 'move', kind: 'op', dir: TO_MAIN, fields: ['from', 'anchor', 'where'], caption: '面板里把一行搬到另一行前 / 后' },
  { name: 'rename', kind: 'op', dir: TO_MAIN, fields: ['value'], caption: '改这条待办的标题' },
  { name: 'discardRename', kind: 'op', dir: TO_MAIN, fields: [], caption: '标题改名被取消' },
  { name: 'close', kind: 'op', dir: TO_MAIN, fields: [], caption: '收起面板' },

  // —— 握手：两个方向各一条，两窗发同一种 hello；epoch 标识「哪一次页面加载」 ——
  { name: 'hello', kind: 'notice', dir: BOTH, fields: ['epoch'], caption: '握手：本端监听已装好' },

  // —— 面板 → 主窗口：状态 ——
  { name: 'editing', kind: 'notice', dir: TO_MAIN, fields: ['on'], caption: '面板里有未落定的编辑' },
  { name: 'receipt', kind: 'notice', dir: TO_MAIN, fields: ['id', 'ops'], caption: '落定回执，携带未定稿的操作' },

  // —— 主窗口 → 面板 ——
  { name: 'data', kind: 'command', dir: TO_PANEL, fields: ['title', 'todos', 'notes', 'focusIdx'], coalesce: true, caption: '面板要显示的全部内容' },
  { name: 'flush', kind: 'command', dir: TO_PANEL, fields: ['id'], caption: '把未落定的编辑交出来（回 receipt）' },
  { name: 'hide', kind: 'command', dir: TO_PANEL, fields: [], caption: '面板已收起，清掉本地状态' },
];

const byName = new Map(TABLE.map((m) => [m.name, m]));

/* 两条由协议自己处理的消息：窗口不必各装一个空处理函数。
   HELLO（握手）与 RECEIPT（落定回执）是协议的一部分，不是窗口的业务。
   名字只在这里写一次；窗口那边用它回执（`proto.send(proto.RECEIPT, …)`）。 */
const HELLO = 'hello';
const RECEIPT = 'receipt';
const INTERNAL = new Set([HELLO, RECEIPT]);

/* 握手用的那一行：announce 每次现取，不写第二份字面量。 */
const helloRow = () => byName.get(HELLO);

function rowOf(name) {
  const row = byName.get(name);
  if (!row) throw new Error(`未知面板消息: ${name}`);
  return row;
}

/* 按表校验并取值：键必须齐、不能多。发送端与接收端共用这一份，
   所以「编码时能发出什么」与「解码时收得下什么」永远不会各说各话。 */
function check(row, args, where) {
  const out = { type: row.name };
  for (const f of row.fields) {
    if (!(f in args)) throw new Error(`${where} ${row.name} 缺字段 ${f}`);
    out[f] = args[f];
  }
  for (const k of Object.keys(args)) {
    if (k !== 'type' && !row.fields.includes(k)) throw new Error(`${where} ${row.name} 多了字段 ${k}`);
  }
  return out;
}

const encode = (row, args) => check(row, args, '面板消息');

/* 面板把未定稿的编辑交回去时用它编码：名字必须是表里的一条操作。 */
export function makeOp(name, args = {}) {
  const row = rowOf(name);
  if (row.kind !== 'op') throw new Error(`${name} 不是面板操作`);
  return encode(row, args);
}

/* 宿主对象：Tauri 的 withGlobalTauri 把它作为初始化脚本注入，早于任何页面脚本。
   取不到就是真的没注入（打不开 / 版本不对），这里抛错让启动日志说清楚，
   而不是每 20 毫秒问一次「来了吗」。 */
export function requireHost() {
  const host = typeof window !== 'undefined' ? window.__TAURI__ : null;
  if (!host || !host.core || !host.event) throw new Error('__TAURI__ 没有注入');
  return host;
}

/* 把一个方向的 link 接到 Tauri 事件上：收 = listen 本方向的通道，发 = emitTo 对端。
   宿主对象用 getHost 取（调用时才取）：模块顶层就不碰 window.__TAURI__，
   页面脚本先于初始化脚本执行这种极端情况不会把整个模块带倒（#16）。 */
export function tauriLink({ side, getHost, log = () => {} }) {
  const peer = side === MAIN ? PANEL : MAIN;
  const recvEvent = side === MAIN ? TO_MAIN : TO_PANEL;
  const sendEvent = side === MAIN ? TO_PANEL : TO_MAIN;
  return {
    listen: (fn) => getHost().event.listen(EVENT[recvEvent], (ev) => fn(ev.payload)),
    send: (payload) => {
      const p = getHost().event.emitTo(peer, EVENT[sendEvent], payload);
      if (p && typeof p.catch === 'function') {
        p.catch((e) => log(`面板消息发不出去（${payload && payload.type}）: ${e}`));
      }
    },
  };
}

/* 建一个协议端。link 只有两件事：listen(fn) 收、send(payload) 发。 */
export function createProtocol({ side, link, log = () => {}, flushTimeoutMs = 800 }) {
  if (side !== MAIN && side !== PANEL) throw new Error(`未知窗口: ${side}`);
  const sendDir = side === MAIN ? TO_PANEL : TO_MAIN;
  const recvDir = side === MAIN ? TO_MAIN : TO_PANEL;
  /* 本次页面加载的身份：面板页重载会换一个新的，对端据此认出「这是个新对端」。 */
  const epoch = `${side}-${Math.random().toString(36).slice(2, 10)}`;

  let handlers = {};
  let started = false;
  let peerReady = false;
  let repliedTo = null;      // 已经回过 hello 的那个对端身份（防 ping-pong）
  const queue = [];          // 对端握手前攒下的消息
  const waits = new Map();   // 落定请求 id → { resolve, timer }
  let seq = 0;

  function post(payload, row) {
    if (peerReady || row.name === HELLO) { link.send(payload); return; }
    if (row.coalesce) {
      // data 是「当前内容」不是一次事件：排队时只留最后一份
      for (let k = queue.length - 1; k >= 0; k -= 1) {
        if (queue[k].type === payload.type) queue.splice(k, 1);
      }
    }
    queue.push(payload);
  }

  function flushQueue() {
    while (queue.length) link.send(queue.shift());
  }

  /* 握手：收到对面的 hello 就是「这个对端已经装好监听、可以发了」。
     三件事缺一件都会出问题：
     1. 把自己攒下的消息补发出去（peerReady + flushQueue）。
     2. 用**自己的 epoch** 回一声 hello —— 面板页重载后是个全新的对端，而主窗口
        早就是 ready 状态、不会主动再喊；不回这一声的话，新面板永远不知道自己能发，
        它发出的每条消息都卡在队列里（#16 code-review 实测就是这么丢的）。
     3. 同一个对端只回一次：身份记在 repliedTo 里，所以不会来回 ping-pong。 */
  function onHello(m) {
    const fresh = m.epoch !== repliedTo;
    peerReady = true;
    flushQueue();
    if (fresh) replyHello(m.epoch);
  }

  function replyHello(peerEpoch) {
    repliedTo = peerEpoch;
    link.send(encode(helloRow(), { epoch }));
  }

  /* 主动喊一声 hello：面板窗口比主窗口晚建、或主窗口「要用面板了」时用。 */
  function announce() {
    link.send(encode(helloRow(), { epoch }));
  }

  /* 回执里的操作再按表验一遍：不认识 / 键不对的丢掉并记日志，
     不让一条坏操作在清单上「什么也没发生」。 */
  function takeOps(list) {
    const ops = [];
    for (const o of list) {
      const row = byName.get(o && o.type);
      if (!row || row.kind !== 'op') {
        log(`回执里有不认识的操作: ${o && o.type}`);
        continue;
      }
      try { ops.push(encode(row, o)); } catch (e) { log(`回执里的操作不合法: ${e.message}`); }
    }
    return ops;
  }

  function onReceipt(payload) {
    const wait = waits.get(payload.id);
    if (!wait) {
      log(`收了不认识的落定回执 #${payload.id}`);
      return;
    }
    waits.delete(payload.id);
    clearTimeout(wait.timer);
    if (!Array.isArray(payload.ops)) {
      log(`落定回执 #${payload.id} 的 ops 不是数组`);
      wait.resolve([]);
      return;
    }
    wait.resolve(takeOps(payload.ops));
  }

  function dispatch(payload) {
    const name = payload && payload.type;
    const row = byName.get(name);
    if (!row) { log(`未知面板消息: ${name}`); return; }
    if (row.dir !== recvDir && row.dir !== BOTH) { log(`面板消息 ${name} 的方向不对`); return; }
    /* 收端与发端共用同一份校验：坏消息只记日志，不投给处理函数。 */
    try { check(row, payload, '收到'); } catch (e) { log(e.message); return; }
    if (name === HELLO) onHello(payload);
    else if (name === RECEIPT) onReceipt(payload);
    const fn = handlers[name];
    if (!fn) {
      if (!INTERNAL.has(name)) log(`没有 ${name} 的处理函数`);
      return;
    }
    try { fn(payload); } catch (e) { log(`处理 ${name} 出错: ${e && e.message ? e.message : e}`); }
  }

  function send(name, args = {}) {
    const row = rowOf(name);
    if (row.dir !== sendDir && row.dir !== BOTH) throw new Error(`面板消息 ${name} 不该从 ${side} 发出`);
    post(encode(row, args), row);
  }

  /* 发一条已经编码好的操作（面板收起前把本地未定稿的编辑交出去）。 */
  function sendOp(op) {
    const row = byName.get(op && op.type);
    if (!row || row.kind !== 'op') throw new Error(`未知面板操作: ${op && op.type}`);
    post(encode(row, op), row);
  }

  /* 主窗口请面板落定：等显式回执，回执里带着面板本来要交的操作。
     超时只记一条告警并 resolve(null) —— 正确性不挂在墙钟上。 */
  function flush() {
    if (side !== MAIN) return Promise.reject(new Error('只有主窗口能请求落定'));
    if (!peerReady) {
      log('还没握手，没有可落定的编辑');
      return Promise.resolve(null);
    }
    const id = (seq += 1);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waits.delete(id);
        log(`落定请求 #${id} 没有回执（${flushTimeoutMs}ms）——只告警，不再等`);
        resolve(null);
      }, flushTimeoutMs);
      waits.set(id, { resolve, timer });
      try {
        send('flush', { id });
      } catch (e) {
        clearTimeout(timer);
        waits.delete(id);
        log(`落定请求发不出去: ${e.message}`);
        resolve(null);
      }
    });
  }

  /* 装监听 → 检查处理函数齐不齐 → 向对端 hello。两窗走的是同一条。
     监听装好之后才 hello，所以对端收到 hello 时发来的消息一定收得到。 */
  async function start(map) {
    if (started) throw new Error('面板协议已经启动过');
    handlers = map || {};
    const missing = TABLE
      .filter((r) => (r.dir === recvDir || r.dir === BOTH) && !INTERNAL.has(r.name) && !handlers[r.name])
      .map((r) => r.name);
    if (missing.length) log(`这些消息没有处理函数: ${missing.join(', ')}`);
    await link.listen(dispatch);
    started = true;
    post(encode(helloRow(), { epoch }), helloRow());
    return api;
  }

  const api = {
    side,
    start,
    send,
    sendOp,
    op: makeOp,
    flush,
    /* 再喊一声 hello：面板窗口比主窗口晚建时，主窗口「要用了」就重喊一次。 */
    announce,
    /* 协议自己处理的两条消息名：窗口回执时用它，别在窗口里另写一份字面量。 */
    HELLO,
    RECEIPT,
    /* 观察面（测试与排查用）：握手状态、还有几条消息在等握手。 */
    peerReady: () => peerReady,
    queued: () => queue.length,
  };
  return api;
}

/* 一个窗口的入口：接一条 Tauri 通道、返回协议端。
   getHost 每次现取，requireHost 在真没注入时当场抛错（模块顶层不碰 window.__TAURI__）。 */
export function connect({ side, getHost, log, flushTimeoutMs }) {
  const hostOf = getHost || requireHost;
  return createProtocol({
    side,
    link: tauriLink({ side, getHost: hostOf, log }),
    log,
    flushTimeoutMs,
  });
}
