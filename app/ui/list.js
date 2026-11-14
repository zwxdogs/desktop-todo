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
  // 详情面板盯着的待办：锚是 [文字, 缩进]；重定位归本模块，窗口由入口开。
  let panel = null; // { index, text, units }

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

  /* ---------- 面板锚点 ---------- */

  function setPanel(i) {
    if (i >= 0 && i < lines.length) {
      panel = {
        index: i,
        text: lines[i].text,
        units: md.indentUnits(lines[i].indent),
      };
    } else {
      panel = null;
    }
  }

  // 按锚（文字 + 缩进）重新定位面板盯着的待办；找不到返回 -1。
  function panelIndex() {
    if (!panel) return -1;
    for (let k = 0; k < lines.length; k += 1) {
      const ln = lines[k];
      if (ln.kind === 'todo' && ln.text === panel.text
          && md.indentUnits(ln.indent) === panel.units) {
        panel.index = k;
        return k;
      }
    }
    panel.index = -1;
    return -1;
  }

  /* 一次真变更的收尾：面板锚跟着走，然后重绘（除非安静）与排写盘。 */
  function afterChange(change, quiet, o = {}) {
    if (change.kind === 'setText' && panel && panel.index === change.index && lines[change.index]) {
      // 就地改了面板那条待办的文字：锚要跟着换，否则面板会以为目标没了
      panel.text = lines[change.index].text;
      panel.units = md.indentUnits(lines[change.index].indent);
    } else {
      panelIndex();   // 搬行/插入/删除都会挪位置：按锚重新定位（找不到就记 -1）
    }
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
    lines = md.deleteCompleted(lines);
    const unfinished = blocks.filter((b) => b.unfinished > 0).length;
    afterChange({ kind: 'deleteCompleted' }, false);
    return { n: blocks.length, unfinished };
  }

  /* 整份替换：装载文件、外部改动重读。撤销历史与待落盘的旧内容一起作废。 */
  function replaceAll(next = {}) {
    cancelSave();
    if (next.lines) lines = next.lines;
    if (next.nl !== undefined) nl = next.nl;
    if (next.hasBom !== undefined) hasBom = !!next.hasBom;
    undoStack = createUndoStack(cap);
    if (panel) panelIndex();
    if (hooks.render) hooks.render(lines);
  }

  /* 撤销：先写成功再换内存（写失败就什么也不动，与现状一致）。
     写完不排写盘 —— 内存换成的就是刚写下去的那一份。 */
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
    setPanel,
    panelIndex,
    toggle, setText, insert, remove, move, deleteCompleted, replaceAll, undo,
  };
}
