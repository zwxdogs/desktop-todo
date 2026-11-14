// 外部改动冲突（#22）实机验收驱动：CDP 连 WebView2，驱动真实 DOM 操作。
// 不碰真实清单：清单在 %TEMP%，由调用方先起一个 testing 实例（--remote-debugging-port）。
//
// 造冲突的确定性做法是**留一个没提交的内联编辑**：`S.edit` 在，`hasUnflushed` 就成立。
// 靠「排着一笔写盘」造不可靠——250ms 合并窗口比 1s 轮询短，那一笔通常先落盘了。
// 编辑走**分组标题**：双击待办打开的是详情面板，不是内联编辑（那是 app.js 的政策）。
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'node:fs/promises';

const PORT = process.env.CDP_PORT || '9333';
const FILE = process.argv[2];
if (!FILE) { console.error('usage: node out-conflict-drive.mjs <清单路径>'); process.exit(2); }

const BAK = FILE.replace(/\.md$/i, '-out-bak.md');
const BOM = '\uFEFF';
const EDIT_TEXT = '我打了一半的字';

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async attach(url) {
    const list = await targets();
    const t = list.find((x) => x.url === url) || list.find((x) => x.type === 'page');
    if (!t) throw new Error(`没找到 ${url} 的调试目标`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    const p = new Page(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const w = p.waiting.get(msg.id);
      if (!w) return;
      p.waiting.delete(msg.id);
      if (msg.error) w.rej(new Error(JSON.stringify(msg.error)));
      else w.res(msg.result);
    };
    return p;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  close() { this.ws.close(); }
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const main = await Page.attach('http://tauri.localhost/');
await main.send('Runtime.enable');

for (let i = 0; i < 60; i += 1) {
  const ready = await main.eval(`!!(window.__TAURI__ && document.querySelectorAll('#list .row').length)`);
  if (ready) break;
  await sleep(200);
}

const rows = () => main.eval(`[...document.querySelectorAll('#list .row')].map(r => {
  const l = r.querySelector('.label');
  return l ? l.textContent : '';
})`);
const dialog = () => main.eval(`(() => {
  const d = document.querySelector('#conflict');
  return {
    open: d.classList.contains('show'),
    title: document.querySelector('#conflict-title').textContent,
    text: document.querySelector('#conflict-text').textContent,
    refresh: document.querySelector('#conflict-refresh').textContent,
    revert: document.querySelector('#conflict-revert').textContent,
    reasonShown: document.querySelector('#conflict-reason').classList.contains('show'),
    reason: document.querySelector('#conflict-reason').textContent,
  };
})()`);
const writeExternal = (body) => fs.writeFile(FILE, BOM + body, 'utf8');

/* 造一次冲突：进入内联编辑、打一半的字、不提交，然后让外部改文件并等轮询。 */
async function makeConflict(externalBody) {
  await main.eval(`(() => {
    const d = document.querySelector('#conflict');
    if (d.classList.contains('show')) document.querySelector('#conflict-refresh').click();
    return true;
  })()`);
  await sleep(700);
  await main.eval(`(() => {
    const label = document.querySelector('#list .row-header .label');
    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const boxed = await main.eval(`(() => {
    const inp = document.querySelector('#list input.row-edit');
    if (!inp) return false;
    inp.value = ${JSON.stringify(EDIT_TEXT)};
    return true;
  })()`);
  await writeExternal(externalBody);
  await sleep(2200);   // 轮询 1s 一轮，给足两轮
  return boxed;
}

/* ---------- 场景 1：没有未落盘改动时静默重载，不弹层 ---------- */
await sleep(800);
await writeExternal('**工作**\r\n- [ ] 甲\r\n- [ ] 乙-外部改\r\n- [ ] 丙\r\n');
await sleep(2400);
const s1 = await dialog();
const t1 = await rows();
check('没有未落盘改动：不弹层', !s1.open);
check('没有未落盘改动：静默重载到了外部那份',
  t1.some((t) => t.includes('乙-外部改')), JSON.stringify(t1));

/* ---------- 场景 2：有未落盘改动时弹出自绘弹层 ---------- */
const boxed2 = await makeConflict('**工作**\r\n- [ ] 甲\r\n- [ ] 外部二\r\n- [ ] 丙\r\n');
const s2 = await dialog();
check('编辑框确实起来了（造冲突的前提）', boxed2);
check('有未落盘改动：弹出自绘弹层', s2.open);
check('弹层标题说明了发生了什么', s2.title.includes('外部'), s2.title);
check('弹层有「刷新」按钮', s2.refresh === '刷新', s2.refresh);
check('弹层有「撤回」按钮', s2.revert === '撤回', s2.revert);
check('弹层说明里带了 -out-bak', s2.text.includes('-out-bak'), s2.text.slice(0, 80));
check('弹层还带着当前文件名', s2.text.includes('检查清单.md'), s2.text.slice(0, 90));
check('弹层没有残留的失败原因', !s2.reasonShown);
check('弹层出现前编辑已落定（输入框收起）',
  !(await main.eval(`!!document.querySelector('#list input.row-edit')`)));

/* ---------- 场景 3：连续多次外部写入不连环弹 ---------- */
for (let i = 0; i < 3; i += 1) {
  await writeExternal(`**工作**\r\n- [ ] 甲\r\n- [ ] 外部连写${i}\r\n- [ ] 丙\r\n`);
  await sleep(1200);
}
const s3 = await dialog();
check('连续外部写入：弹层仍开着（没被关掉也没重开成别的）', s3.open);
check('连续外部写入：没有叠出失败原因', !s3.reasonShown);
check('连续外部写入：仍是同一份弹层文案', s3.refresh === '刷新' && s3.revert === '撤回');

/* ---------- 场景 4：点「撤回」→ 备份落地、原文件变回内存版本 ---------- */
await main.eval(`document.querySelector('#conflict-revert').click(), true`);
await sleep(2000);
let bak = null;
try { bak = await fs.readFile(BAK, 'utf8'); } catch { bak = null; }
const afterRevert = await fs.readFile(FILE, 'utf8');
check('撤回：同目录出现 -out-bak 备份', bak !== null, BAK);
check('撤回：备份内容是外部那份', !!bak && bak.includes('外部连写2'), bak ? JSON.stringify(bak.slice(0, 50)) : '(无)');
check('撤回：原文件变回用户所见的版本（含刚打的那半截字）',
  afterRevert.includes(EDIT_TEXT), JSON.stringify(afterRevert.slice(0, 90)));
check('撤回：撤的是整份覆盖，没有掺进外部内容',
  !afterRevert.includes('外部连写'), JSON.stringify(afterRevert.slice(0, 90)));
check('撤回：弹层关闭', !(await dialog()).open);
const notice = await main.eval(`(() => { const n = document.querySelector('#notice'); return { show: n.classList.contains('show'), text: n.textContent }; })()`);
check('撤回：顶部给出回执', notice.show && notice.text.includes('-out-bak'), JSON.stringify(notice));

/* ---------- 场景 5：撤回之后不会被自己的写入再触发一轮 ---------- */
await sleep(2400);
check('撤回后不自己触发第二轮弹层', !(await dialog()).open);
check('撤回后文件稳定（没被下一轮轮询改写）', (await fs.readFile(FILE, 'utf8')) === afterRevert);

/* ---------- 场景 6：点「刷新」→ 丢弃内存、重读文件 ---------- */
await makeConflict('**工作**\r\n- [ ] 甲\r\n- [ ] 外部六\r\n- [ ] 丙\r\n');
const s6before = await dialog();
await main.eval(`document.querySelector('#conflict-refresh').click(), true`);
await sleep(1600);
const s6 = await dialog();
const t6 = await rows();
check('点「刷新」前弹层确实在', s6before.open);
check('刷新：弹层关闭', !s6.open);
check('刷新：读到了磁盘上的外部版本', t6.some((t) => t.includes('外部六')), JSON.stringify(t6));
check('刷新：那半截没提交的字确实被丢弃（用户选的就是这个）',
  !(await fs.readFile(FILE, 'utf8')).includes(EDIT_TEXT));

/* ---------- 场景 7：写 -out-bak 失败时原文件一个字节不动 ---------- */
await makeConflict('**工作**\r\n- [ ] 甲\r\n- [ ] 外部七\r\n- [ ] 丙\r\n');
const openBefore7 = (await dialog()).open;
const beforeFail = await fs.readFile(FILE);
await fs.rm(BAK, { force: true }).catch(() => {});
await fs.mkdir(BAK, { recursive: true });
await main.eval(`document.querySelector('#conflict-revert').click(), true`);
await sleep(2200);
const afterFail = await fs.readFile(FILE);
const s7 = await dialog();
check('撤回失败：之前弹层是开着的', openBefore7);
check('撤回失败：原文件一个字节不动',
  Buffer.compare(beforeFail, afterFail) === 0, `${beforeFail.length} -> ${afterFail.length} 字节`);
check('撤回失败：弹层留着（用户还能改选「刷新」）', s7.open);
check('撤回失败：界面上说明了原因', s7.reasonShown && s7.reason.length > 10, s7.reason);
await fs.rm(BAK, { recursive: true, force: true });
await main.eval(`document.querySelector('#conflict-refresh').click(), true`);
await sleep(1600);
check('撤回失败后改选「刷新」仍可用', !(await dialog()).open);

/* ---------- 汇总 ---------- */
const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}${f.detail ? `  — ${f.detail}` : ''}`);
  process.exitCode = 1;
}
main.close();
