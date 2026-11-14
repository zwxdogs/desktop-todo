// list.js — 清单模块（app/ui）：清单的全部变更入口。
// 八个意图：勾选 / 改字 / 插入 / 删除 / 搬块 / 删除已完成 / 整份替换 / 撤销。
// 模块内部包着撤销栈（todo.pyw:1000-1023）、写盘合并窗口（todo.pyw:1026-1038）、
// 面板锚点（todo.pyw:892-896）与行保真；主窗口与详情面板的入口只调意图，
// 不再各自排「压撤销 → 改行 → 重绘 → 排写盘」。
// 无 DOM、无 Tauri：重绘、写盘、回执、入口自己的收尾都走注入的 hooks，所以能直接
// 用 node --test 跑（仓库里没有 jsdom，测试面就是这类纯模块）。

import * as md from './md.js';
import { createUndoStack } from './undo.js';

/* hooks:
     before(change)   每次真变更之前一次；change 描述这次变更（kind + 下标/区间/行块）。
                      入口在这里收掉会被这次变更碰坏的编辑框与面板。
     render(lines)    重绘（安静变更不走，例如编辑器失焦的静默提交）。
     write(text)      写盘，返回 Promise<boolean>；撤销要先写成功再换内存。
     afterSave(ok, n, err) 合并写盘的结果：成功记条数，失败记错误文本。
     onSnapshot()     压快照的副产物（回执浮层只认「刚删完」那一刻）。 */
export function createList(opts = {}) {
  let lines = opts.lines || [];
  let nl = opts.nl || '\n';
  let hasBom = !!opts.hasBom;
  const hooks = opts.hooks || {};
  const debounceMs = opts.debounceMs === undefined ? 250 : opts.debounceMs;
  const cap = opts.cap === undefined ? 50 : opts.cap;
  let undoStack = createUndoStack(cap);
  let saveTimer = null;
  // 详情面板盯着的待办：行锚（见下面「行锚点」），重定位归本模块，窗口由入口开。
  let panel = null;

  const text = () => md.serialize(lines);

  function before(change) {
    if (hooks.before) hooks.before(change);
  }

  function snapshot() {
    undoStack.push(text());
    if (hooks.onSnapshot) hooks.onSnapshot();
  }

  /* ---------- 写盘合并：250ms 窗口里连着改几次，只落一次盘 ---------- */

  function cancelSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  }

  async function doSave() {
    saveTimer = null;
    if (!hooks.write) return;
    let ok = false;
    let err = null;
    try { ok = await hooks.write(text()); } catch (e) { ok = false; err = e; }
    if (hooks.afterSave) hooks.afterSave(ok, lines.length, err);
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, debounceMs);
  }

  /* ---------- 行锚点 ----------
     行的身份**不是它的下标**：插入、删除、搬块、整份替换之后下标就不成立了，
     拿旧下标去改新数组等于把字写到别人头上（#18）。锚是两级凭据：

       ① row —— 行对象本身。同一份内存里做变更时，数组元素仍是同一批对象
          （md.moveBlock / deleteSubtree / deleteCompleted 都复用引用），所以
          `lines.indexOf(row)` 最硬：内容、位置怎么变都认得出它。
          一处例外：md.moveBlock 里 withEnding 会给「原本是文件末行」的那一行换一个
          `{...line}` 的副本（为了补行尾换行），那一行的 ① 就此失效、掉到 ②。
       ② kind + text + units —— 行对象被换掉时才用（整份替换、撤销都会重新
          parseText 造一批新对象）。这时只能按内容认，两个条件缺一不可：

          a. 现在的清单里**唯一命中**；
          b. 建锚时这个内容也**只有一行**（anchorAt 记下的 `only`）。

     为什么要 b：外部编辑器把「写周报」两条删掉一条，剩下那条与手里这条长得一模一样。
     只查 a 的话，唯一命中正好落在幸存的那一条上，于是「改第二条」的字写进了第一条——
     而它其实可能是被删掉的那一条。**认错比认不出更糟**，所以建锚时就不唯一的内容，
     一旦行对象没了就不再尝试重绑（`only` 为假 = 永久认不出）。

     交不出来时调用方要明确丢弃并提示，绝不退化成「那就在原下标上写吧」。 */

  function anchorAt(i) {
    const ln = lines[i];
    if (!ln) return null;
    const units = md.indentUnits(ln.indent);
    // 建锚这一刻，全清单里有几行与它「按内容」不可区分。>1 就意味着将来没法靠内容认领它。
    let same = 0;
    for (const other of lines) {
      if (other.kind === ln.kind && other.text === ln.text
          && md.indentUnits(other.indent) === units) same += 1;
    }
    return { row: ln, kind: ln.kind, text: ln.text, units, only: same === 1 };
  }

  function indexOfAnchor(a) {
    if (!a || a.dead) return -1;
    const direct = lines.indexOf(a.row);
    if (direct >= 0) {
      // 还看得见那一行：顺手把缓存的内容凭据刷成它现在的样子。
      // 不刷的话，行被就地改名之后 `text` 是旧的，等行对象哪天被换掉（整份替换）
      // 就再也认不回来了——而那时它明明是唯一的。
      const ln = lines[direct];
      a.text = ln.text;
      a.units = md.indentUnits(ln.indent);
      a.only = anchorAt(direct).only;
      return direct;
    }
    // 行对象没了：只有「建锚时它就独一无二」才允许按内容认回来
    if (!a.only) return -1;
    let hit = -1;
    for (let k = 0; k < lines.length; k += 1) {
      const ln = lines[k];
      if (ln.kind === a.kind && ln.text === a.text && md.indentUnits(ln.indent) === a.units) {
        if (hit >= 0) return -1;   // 现在也不唯一：照样不猜
        hit = k;
      }
    }
    // 按内容认回来了：把行引用换成当前数组里的那一行（此后走 ① 那条硬路径）
    if (hit >= 0) a.row = lines[hit];
    return hit;
  }

  /* 这一行被删掉了：锚就此作废。不能留给「按内容重绑」去猜——目标没了之后，
     同名的另一条会顶上来，那正是「改错了那一条」。删除是本模块自己做的，
     它知道删的是哪几行，所以这里明确说死，不推理。 */
  function killAnchorIn(a, from, to) {
    if (!a) return;
    const i = lines.indexOf(a.row);
    if (i >= from && i < to) a.dead = true;
  }

  /* ---------- 面板锚点 ---------- */

  function setPanel(i) {
    panel = anchorAt(i);
  }

  // 面板盯着的待办现在在哪（-1 = 认不出来了）。会顺手刷新锚缓存的内容凭据
  // （see indexOfAnchor），所以严格说它不是纯查询——调用方别指望它没有副作用。
  function panelIndex() {
    return indexOfAnchor(panel);
  }

  /* 一次真变更的收尾：锚跟着走，然后重绘（除非安静）与排写盘。

     锚自己会认出新位置并顺手刷新缓存的「内容凭据」（见 indexOfAnchor），所以这里
     只需要在面板盯着的那一行被就地改名之后碰它一次——把刷新这件事做掉，
     否则要等下一次有人问「它在哪」才生效。 */
  function afterChange(change, quiet, o = {}) {
    if (panel && change.kind === 'setText') indexOfAnchor(panel);
    if (!quiet && hooks.render) hooks.render(lines);
    if (o.save !== false) scheduleSave();
  }

  /* ---------- 八个意图 ---------- */

  function toggle(i) {
    if (!(i >= 0 && i < lines.length)) return false;
    const ln = lines[i];
    if (ln.kind !== 'todo') return false;
    before({ kind: 'toggle', index: i });
    snapshot();
    md.toggleRaw(ln);
    afterChange({ kind: 'toggle', index: i }, false);
    return true;
  }

  function setText(i, value, o = {}) {
    if (!(i >= 0 && i < lines.length)) return false;
    const ln = lines[i];
    before({ kind: 'setText', index: i });
    snapshot();
    // 行保真：文字没变就不重建 raw（静默提交每次都会走到这里）
    if (ln.text !== value) md.setLineText(ln, value);
    afterChange({ kind: 'setText', index: i }, !!o.quiet);
    return true;
  }

  /* 在 at 处插一行（at 是插入后的下标）。kind: 'todo' | 'note' | 'header'。 */
  function insert(at, lineKind, indent, value) {
    if (!(at >= 0 && at <= lines.length)) return -1;
    before({ kind: 'insert', index: at });
    snapshot();
    // 行尾缺换行时补一个，避免插完之后两行粘成一行（只动落点前那一行）
    if (at > 0 && !lines[at - 1].raw.endsWith('\n')) lines[at - 1].raw += nl;
    const body = lineKind === 'header' ? `**${value}**`
      : lineKind === 'todo' ? `- [ ] ${value}` : `- ${value}`;
    lines.splice(at, 0, md.parseLine(indent + body + nl));
    afterChange({ kind: 'insert', index: at }, false);
    return at;
  }

  function remove(i) {
    if (!(i >= 0 && i < lines.length)) return null;
    const ln = lines[i];
    const end = ln.kind === 'todo' ? md.subtreeEnd(lines, i) : i + 1;
    before({ kind: 'remove', index: i, end });
    snapshot();
    // 面板盯着的行若在这个区间里，锚明确作废：同名的另一条不许顶上来
    killAnchorIn(panel, i, end);
    if (ln.kind === 'todo') lines = md.deleteSubtree(lines, i);
    else lines.splice(i, 1);
    afterChange({ kind: 'remove', index: i, end }, false);
    return { index: i, end, kind: ln.kind };
  }

  function move(from, to) {
    if (!md.canMove(lines, from, to)) return false;
    before({ kind: 'move', from, to });
    snapshot();
    lines = md.moveBlock(lines, from, to, nl);
    afterChange({ kind: 'move', from, to }, false);
    return true;
  }

  function deleteCompleted() {
    const blocks = md.completedScan(lines);
    if (!blocks.length) return null;
    before({ kind: 'deleteCompleted', blocks });
    snapshot();
    // 被整批删掉的那些行：面板锚若落在其中，同样明确作废
    for (const b of blocks) killAnchorIn(panel, b.i, b.end);
    lines = md.deleteCompleted(lines);
    const unfinished = blocks.filter((b) => b.unfinished > 0).length;
    afterChange({ kind: 'deleteCompleted' }, false);
    return { n: blocks.length, unfinished };
  }

  /* 整份替换：装载文件、外部改动重读。撤销历史与待落盘的旧内容一起作废。
     行对象整批换新，锚只剩「按内容重绑」这一条路——所以这里什么都不做：
     锚自己会在下次 indexOfAnchor 时尝试按 ② 认领，认不出/认重了就是 -1。 */
  function replaceAll(next = {}) {
    cancelSave();
    if (next.lines) lines = next.lines;
    if (next.nl !== undefined) nl = next.nl;
    if (next.hasBom !== undefined) hasBom = !!next.hasBom;
    undoStack = createUndoStack(cap);
    if (hooks.render) hooks.render(lines);
  }

  /* 撤销：先写成功再换内存（写失败就什么也不动，与现状一致）。
     写完不排写盘 —— 内存换成的就是刚写下去的那一份。
     撤销回来的是重新解析的一批新对象：旧锚的 ① 一定失效，只剩按内容认领；
     认不出或撞上同名的两条就交不出来（-1），绝不退回旧下标。 */
  async function undo() {
    if (!undoStack.canUndo()) return false;
    const snap = undoStack.undo();
    if (hooks.write) {
      let ok = false;
      try { ok = await hooks.write(snap); } catch (_) { ok = false; }
      if (!ok) return false;
    }
    lines = md.parseText(snap);
    afterChange({ kind: 'undo' }, false, { save: false });
    return true;
  }

  return {
    lines: () => lines,
    text,
    hasBom: () => hasBom,
    pending: () => !!saveTimer,
    cancelSave,
    canUndo: () => undoStack.canUndo(),
    undoSize: () => undoStack.size(),
    anchorAt,
    indexOfAnchor,
    setPanel,
    panelIndex,
    toggle, setText, insert, remove, move, deleteCompleted, replaceAll, undo,
  };
}
