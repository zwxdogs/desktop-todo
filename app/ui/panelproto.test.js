// panelproto.js 的行为测试 —— 面板协议一张表、一次握手、一次显式回执。
// 这里两头接上线手动投递，所以「还没握手那一刻」能停住看清楚。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAIN, PANEL, TO_MAIN, TO_PANEL, BOTH, TABLE, createProtocol, makeOp, requireHost,
} from "./panelproto.js";

/* 一对哑管道：send 只把载荷压进 outbox，deliver() 才真投给对方。
   这样「排队 / 补发」「回执 / 超时」都能一步一步看清楚。 */
function wire() {
  const logs = { main: [], panel: [] };
  const outbox = { main: [], panel: [] };
  const receivers = { main: null, panel: null };
  const make = (side) => createProtocol({
    side,
    link: {
      listen: async (fn) => { receivers[side] = fn; },
      send: (payload) => { outbox[side].push(payload); },
    },
    log: (m) => logs[side].push(m),
    flushTimeoutMs: 30,
  });
  const main = make(MAIN);
  const panel = make(PANEL);
  const toPeer = (side) => (side === MAIN ? PANEL : MAIN);
  // 把 side 已发出的消息全投给对端
  const deliver = (side) => {
    const peer = toPeer(side);
    const batch = outbox[side].splice(0);
    for (const p of batch) receivers[peer](p);
    return batch;
  };
  return { main, panel, logs, outbox, deliver, receivers };
}

const noop = () => {};

test("处理函数必须覆盖本端收的每一条消息（打错一个名字就会被点名）", async () => {
  // 窗口那边是一张 { 名字: 函数 } 的表；打错一个键以前只会在运行到那条消息时
  // 记一行日志，静默失效。这里把「覆盖」本身钉成断言。
  const { main, panel, logs } = wire();
  // 主窗口收：全部 op + editing + hello + receipt
  await main.start(Object.fromEntries(
    TABLE.filter((r) => r.dir === TO_MAIN || r.dir === BOTH).map((r) => [r.name, noop]),
  ));
  assert.doesNotMatch(logs.main.join("\n"), /没有处理函数/, "覆盖齐了就不该点名");
  // 面板收：data / flush / hide + hello
  await panel.start(Object.fromEntries(
    TABLE.filter((r) => r.dir === TO_PANEL || r.dir === BOTH).map((r) => [r.name, noop]),
  ));
  assert.doesNotMatch(logs.panel.join("\n"), /没有处理函数/);

  // 少一个就点名（这里故意漏掉 toggle）
  const { main: m2, logs: l2 } = wire();
  const missing = Object.fromEntries(
    TABLE.filter((r) => r.dir === TO_MAIN || r.dir === BOTH).map((r) => [r.name, noop]),
  );
  delete missing.toggle;
  await m2.start(missing);
  assert.match(l2.main.join("\n"), /没有处理函数.*toggle/);
});

test("协议表：消息名唯一，方向只有三个，操作与命令都不缺", () => {
  const names = TABLE.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, "消息名不许重");
  for (const row of TABLE) {
    assert.ok([TO_MAIN, TO_PANEL, BOTH].includes(row.dir), `${row.name} 的方向`);
    assert.ok(Array.isArray(row.fields), `${row.name} 的字段表`);
    assert.ok(row.kind === "op" || row.kind === "notice" || row.kind === "command", `${row.name} 的种类`);
  }
  // 验收标准里的六种面板操作都在表里，且都是「面板发、主窗口收」的操作
  const ops = TABLE.filter((r) => r.kind === "op");
  for (const name of ["toggle", "setText", "remove", "addTodo", "addNote", "addBelow", "move", "close"]) {
    const row = ops.find((r) => r.name === name);
    assert.ok(row, `缺面板操作 ${name}`);
    assert.equal(row.dir, TO_MAIN, `${name} 应当由面板发出`);
  }
  // 握手与回执是协议自己处理的，窗口不用各装一个空处理函数
  assert.equal(TABLE.find((r) => r.name === "hello").kind, "notice");
  assert.equal(TABLE.find((r) => r.name === "hello").dir, BOTH, "两窗发同一种 hello");
  assert.equal(TABLE.find((r) => r.name === "receipt").kind, "notice");
});

test("发消息：缺字段、多字段、认不出的名字都是当场抛错", async () => {
  const { main, panel, deliver } = wire();
  await main.start({});
  await panel.start({});
  deliver(PANEL);
  deliver(MAIN);
  assert.throws(() => main.send("data", { title: "甲" }), /缺字段 todos/);
  assert.throws(() => main.send("data", { title: "甲", todos: [], notes: [], focusIdx: null, x: 1 }), /多了字段 x/);
  assert.throws(() => main.send("nope", {}), /未知面板消息/);
  // 操作也必须过表
  assert.throws(() => panel.sendOp({ type: "toggle" }), /缺字段 j/);
  assert.throws(() => makeOp("data", {}), /不是面板操作/);
});

test("发消息：方向不对当场抛错（面板不能发 data，主窗口不能发 toggle）", async () => {
  const { main, panel } = wire();
  await main.start({});
  await panel.start({});
  assert.throws(() => panel.send("data", { title: "甲", todos: [], notes: [], focusIdx: null }), /不该从 panel 发出/);
  assert.throws(() => main.send("toggle", { j: 1 }), /不该从 main 发出/);
});

test("握手：hello 之前发的消息排队，hello 之后补发；data 只留最后一份", async () => {
  const { main, panel, deliver, outbox } = wire();
  await main.start({});
  await panel.start({});
  // 两窗都还没收到对端的 hello
  main.send("data", { title: "一", todos: [], notes: [], focusIdx: null });
  main.send("data", { title: "二", todos: [], notes: [], focusIdx: null });
  main.send("hide", {});
  assert.deepEqual(outbox.main.map((p) => p.type), ["hello"], "握手前只放行 hello");
  assert.equal(main.queued(), 2, "两份 data 合成一份 + 一条 hide");

  deliver(MAIN);   // 主窗口的 hello 到面板
  assert.equal(panel.peerReady(), true);

  deliver(PANEL);  // 面板的 hello 回主窗口 → 主窗口补发队列
  assert.equal(main.peerReady(), true);
  const flushed = outbox.main.map((p) => p.type).filter((t) => t !== "hello");
  assert.deepEqual(flushed, ["data", "hide"], "data 只留最后一份");
  const last = outbox.main.find((p) => p.type === "data");
  assert.equal(last.title, "二", "留下的是最新的那份内容");
});

test("握手：一方的 hello 丢掉时，另一方补喊一次，最后仍接得上", async () => {
  const { main, panel, deliver, outbox } = wire();
  await main.start({});
  // 面板先启动、先喊 hello——但主窗口此刻还没装监听，这一声丢了
  await panel.start({});
  assert.equal(panel.peerReady(), false);
  outbox.panel.length = 0;
  // 主窗口随后启动，喊 hello
  deliver(MAIN);
  assert.equal(panel.peerReady(), true, "面板收到主窗口的 hello");
  // 回喊：面板把自己的 hello 补回主窗口
  deliver(PANEL);
  assert.equal(main.peerReady(), true, "丢掉的握手靠回喊补上");
});

test("announce 可以再喊一次 hello（面板页重载后主窗口重连）", async () => {
  const { main, panel, deliver, outbox } = wire();
  await main.start({});
  await panel.start({});
  deliver(MAIN);
  deliver(PANEL);
  // 握手完成后每端手里没有待发消息（回喊的那一声 hello 已随第一轮投递走掉）
  assert.equal(main.queued(), 0);
  assert.equal(panel.queued(), 0);
  outbox.main.length = 0;
  main.announce();
  assert.deepEqual(outbox.main.map((p) => p.type), ["hello"]);
  assert.ok(outbox.main[0].epoch, "hello 带本次加载的身份");
});

test("面板页重载：新对端喊 hello，主窗口回它一声并重推内容", async () => {
  const { main, deliver, receivers, outbox } = wire();
  let hellos = 0;
  await main.start({ hello: () => { hellos += 1; } });
  outbox.main.length = 0;

  // 面板页重载 = 一个全新的协议端（新 epoch）从零开始握手
  const panelIn = [];
  const fresh = createProtocol({
    side: PANEL,
    link: { listen: async (fn) => { panelIn.push(fn); }, send: (p) => { outbox.panel.push(p); } },
    log: () => {},
  });
  await fresh.start({});
  // 新面板的 hello 到主窗口：主窗口必须（a）回一声（否则新面板永远不知道自己能发，
  // 它发出的每条消息都会卡在队列里），（b）把 hello 投给处理函数（好重推内容）。
  for (const p of outbox.panel.splice(0)) receivers[MAIN](p);
  assert.equal(hellos, 1, "重载后的 hello 要投给处理函数");
  const reply = outbox.main.filter((p) => p.type === "hello");
  assert.equal(reply.length, 1, "主窗口要回一声 hello");
  assert.ok(reply[0].epoch, "回的那一声带主窗口自己的身份");

  // 那一声回执真的到新面板，它就能发了
  for (const p of outbox.main.splice(0)) panelIn[0](p);
  assert.equal(fresh.peerReady(), true, "新面板收到回执后就能发了");
});

test("面板页重载后发得出的消息不再卡在队列里", async () => {
  const { main, receivers, outbox } = wire();
  const got = [];
  await main.start({ toggle: (m) => got.push(m) });
  outbox.main.length = 0;

  // 新面板从零开始；主窗口此刻已经是 ready 的老对端
  const panelIn = [];
  const fresh = createProtocol({
    side: PANEL,
    link: { listen: async (fn) => { panelIn.push(fn); }, send: (p) => { outbox.panel.push(p); } },
    log: () => {},
  });
  await fresh.start({});
  fresh.send("toggle", { j: 3 });
  assert.equal(fresh.queued(), 1, "握手前先排队");

  // 主窗口收到新面板的 hello 并回一声；回执投回新面板
  for (const p of outbox.panel.splice(0)) receivers[MAIN](p);
  for (const p of outbox.main.splice(0)) panelIn[0](p);

  assert.equal(fresh.queued(), 0, "回执到了，队列补发出去");
  assert.equal(fresh.peerReady(), true);
  // 补发出去的那条 toggle 也真的到了主窗口
  for (const p of outbox.panel.splice(0)) receivers[MAIN](p);
  assert.deepEqual(got, [{ type: "toggle", j: 3 }], "补发之后消息不再卡住");
});

test("同一个对端重复喊 hello 只回一次（不会 ping-pong）", async () => {
  const { main, receivers, outbox } = wire();
  await main.start({});
  outbox.main.length = 0;
  receivers[MAIN]({ type: "hello", epoch: "panel-aaa" });
  assert.deepEqual(outbox.main.map((p) => p.type), ["hello"]);
  outbox.main.length = 0;
  receivers[MAIN]({ type: "hello", epoch: "panel-aaa" });   // 同一个对端再喊
  assert.equal(outbox.main.length, 0, "同一个 epoch 不再回");
  receivers[MAIN]({ type: "hello", epoch: "panel-bbb" });   // 新对端
  assert.deepEqual(outbox.main.map((p) => p.type), ["hello"], "新 epoch 才回");
});

test("收到坏消息只记日志、不投给处理函数（不认识的 name / 方向错 / 少键 / 多键）", async () => {
  const { main, panel, logs, receivers } = wire();
  const seen = [];
  await main.start({ toggle: (m) => seen.push(m) });
  await panel.start({});

  receivers[MAIN]({ type: "nope" });
  receivers[MAIN]({ type: "data", title: "甲", todos: [], notes: [], focusIdx: null });   // 方向错
  receivers[MAIN]({ type: "toggle" });                                                   // 少字段
  receivers[MAIN]({ type: "toggle", j: 1, extra: true });                                // 多字段
  receivers[MAIN]({ type: "toggle", j: 2 });                                             // 好

  assert.deepEqual(seen, [{ type: "toggle", j: 2 }], "只有合法的消息到达处理函数");
  const joined = logs.main.join("\n");
  assert.match(joined, /未知面板消息: nope/);
  assert.match(joined, /方向不对/);
  assert.match(joined, /缺字段 j/);
  assert.match(joined, /多了字段 extra/);
});

test("处理函数抛错被吞掉并记日志，协议本身不倒", async () => {
  const { main, panel, logs, receivers } = wire();
  await main.start({ toggle: () => { throw new Error("boom"); } });
  await panel.start({});
  receivers[MAIN]({ type: "toggle", j: 1 });
  assert.match(logs.main.join("\n"), /处理 toggle 出错: boom/);
});

test("start 时处理函数不齐只记日志，不阻止启动", async () => {
  const { main, logs } = wire();
  await main.start({ toggle: noop });
  const joined = logs.main.join("\n");
  assert.match(joined, /没有处理函数/);
  assert.match(joined, /setText/, "缺的处理函数逐个点名");
  // hello / receipt 由协议自己处理，不该被点名
  assert.doesNotMatch(joined, /hello/);
  assert.doesNotMatch(joined, /receipt/);
  // 只点名本端收的：主窗口不该被要求装 data / hide
  assert.doesNotMatch(joined, /data/);
  assert.doesNotMatch(joined, /hide/);
});

test("落定：面板回显式回执，主窗口拿到面板本来要交的操作", async () => {
  const { main, panel, deliver, outbox } = wire();
  await main.start({});
  let pending = null;   // 面板侧的未定稿编辑
  let flushed = 0;
  await panel.start({
    flush: (m) => {
      flushed += 1;
      const ops = pending === null ? [] : [pending];
      pending = null;
      panel.send("receipt", { id: m.id, ops });
    },
  });
  deliver(MAIN);
  deliver(PANEL);

  pending = makeOp("setText", { j: 3, value: "改过的字" });
  const promise = main.flush();
  deliver(MAIN);   // flush 到面板
  assert.equal(flushed, 1);
  deliver(PANEL);  // 回执到主窗口
  const ops = await promise;
  assert.deepEqual(ops, [{ type: "setText", j: 3, value: "改过的字" }]);
});

test("落定：面板没有未定稿编辑时回执是空数组，不是 null", async () => {
  const { main, panel, deliver } = wire();
  await main.start({});
  await panel.start({ flush: (m) => panel.send("receipt", { id: m.id, ops: [] }) });
  deliver(MAIN);
  deliver(PANEL);
  const promise = main.flush();
  deliver(MAIN);
  deliver(PANEL);
  assert.deepEqual(await promise, []);
});

test("落定：没有回执就只告警并 resolve(null)，正确性不挂在墙钟上", async () => {
  const { main, panel, deliver, logs } = wire();
  await main.start({});
  await panel.start({ flush: () => {} });   // 面板收下请求但不回
  deliver(MAIN);
  deliver(PANEL);
  const ops = await main.flush();
  assert.equal(ops, null);
  assert.match(logs.main.join("\n"), /没有回执/);
  assert.match(logs.main.join("\n"), /只告警/);
});

test("落定：回执里不认识或不合法操作被丢掉并记日志，好的照收", async () => {
  const { main, panel, deliver, logs } = wire();
  await main.start({});
  await panel.start({
    flush: (m) => panel.send("receipt", {
      id: m.id,
      ops: [
        { type: "toggle", j: 1 },
        { type: "data", title: "甲" },        // notice/command 混进操作里
        { type: "setText", j: 2 },            // 少字段
        null,
      ],
    }),
  });
  deliver(MAIN);
  deliver(PANEL);
  const promise = main.flush();
  deliver(MAIN);
  deliver(PANEL);
  assert.deepEqual(await promise, [{ type: "toggle", j: 1 }]);
  const joined = logs.main.join("\n");
  assert.match(joined, /不认识的操作: data/);
  assert.match(joined, /操作不合法/);
});

test("落定：不认识的回执 id 只记日志", async () => {
  const { main, panel, logs, receivers } = wire();
  await main.start({});
  await panel.start({});
  receivers[MAIN]({ type: "receipt", id: 99, ops: [] });
  assert.match(logs.main.join("\n"), /不认识的落定回执 #99/);
});

test("落定：还没握手时不发请求、直接 resolve(null)", async () => {
  const { main, logs } = wire();
  await main.start({});
  assert.equal(await main.flush(), null);
  assert.match(logs.main.join("\n"), /还没握手/);
});

test("落定只能由主窗口发起", async () => {
  const { panel } = wire();
  await panel.start({});
  await assert.rejects(() => panel.flush(), /只有主窗口能请求落定/);
});

test("start 只能调一次", async () => {
  const { main } = wire();
  await main.start({});
  await assert.rejects(() => main.start({}), /已经启动过/);
});

test("requireHost：宿主对象没注入就抛错（不再每 20ms 轮询）", () => {
  const saved = globalThis.window;
  try {
    globalThis.window = undefined;
    assert.throws(() => requireHost(), /__TAURI__ 没有注入/);
    globalThis.window = {};
    assert.throws(() => requireHost(), /__TAURI__ 没有注入/);
    globalThis.window = { __TAURI__: { core: {} } };
    assert.throws(() => requireHost(), /__TAURI__ 没有注入/, "缺 event 也算没注入");
    const host = { core: {}, event: {} };
    globalThis.window = { __TAURI__: host };
    assert.equal(requireHost(), host);
  } finally {
    globalThis.window = saved;
  }
});
