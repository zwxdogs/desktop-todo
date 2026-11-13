// md.js — 待办 Markdown 行保真核心（ app/ui ）。
// 与 todo.pyw 的同名纯函数语义一一对应（ADR 0002 的 JS 移植）。
// raw 一字不动地保留原文（含行尾符），未被编辑的行写回时零差异。

const RE_BLANK = /^\s*$/;
const RE_HEADER = /^(\s*)\*\*(.+?)\*\*\s*$/;
// d 标志提供 groups 的起止下标：cbPos 用 indices[3][0]（方括号内状态字符）。
const RE_TODO = /^(\s*)([-*+])[ \t]+\[([ xX])\](\s*)(.*)$/d;
const RE_NOTE = /^(\s*)([-*+])[ \t]+(.*)$/;
const RE_ENDING = /(\r?\n)$/;

export function parseLine(raw) {
  const em = raw.match(RE_ENDING);
  const ending = em ? em[1] : '';
  const body = em ? raw.slice(0, raw.length - ending.length) : raw;

  if (RE_BLANK.test(body)) {
    return { kind: 'blank', raw, indent: '', marker: '', checked: false,
             text: '', cbPos: -1, wsAfterCb: '', ending };
  }
  let m = RE_HEADER.exec(body);
  if (m) {
    return { kind: 'header', raw, indent: m[1], marker: '', checked: false,
             text: m[2], cbPos: -1, wsAfterCb: '', ending };
  }
  m = RE_TODO.exec(body);
  if (m) {
    return { kind: 'todo', raw, indent: m[1], marker: m[2],
             checked: m[3] !== ' ', text: m[5],
             cbPos: m.indices[3][0], wsAfterCb: m[4], ending };
  }
  m = RE_NOTE.exec(body);
  if (m) {
    return { kind: 'note', raw, indent: m[1], marker: m[2], checked: false,
             text: m[3], cbPos: -1, wsAfterCb: '', ending };
  }
  return { kind: 'other', raw, indent: '', marker: '', checked: false,
           text: body, cbPos: -1, wsAfterCb: '', ending };
}

// serialize：未编辑过的行 raw 一字不动，因此输出与输入字节级一致。
export function serialize(lines) {
  return lines.map((l) => l.raw).join('');
}

// toggleRaw：原位翻转 [ ] / [x]，只改 cbPos 一个字符，其余字节零差异。
export function toggleRaw(line) {
  const i = line.cbPos;
  if (i < 0) return;
  line.raw = line.raw.slice(0, i) + (line.checked ? ' ' : 'x') + line.raw.slice(i + 1);
  line.checked = !line.checked;
}

// setLineText：行内改写后重建 raw；todo/note/header 分别保留各自的结构字符。
export function setLineText(line, text) {
  line.text = text;
  if (line.kind === 'todo') {
    line.raw = line.indent + line.marker + ' [' + (line.checked ? 'x' : ' ') + ']'
      + line.wsAfterCb + text + line.ending;
  } else if (line.kind === 'note') {
    line.raw = line.indent + line.marker + ' ' + text + line.ending;
  } else if (line.kind === 'header') {
    line.raw = line.indent + '**' + text + '**' + line.ending;
  } else {
    line.raw = text + line.ending;
  }
}

// indentUnits：Python str.expandtabs(4) 等价 —— tab 跳到下一个 4 的倍数列。
export function indentUnits(indent) {
  let col = 0;
  for (const ch of indent) col = ch === '\t' ? (Math.floor(col / 4) + 1) * 4 : col + 1;
  return col;
}

// subtreeEnd：待办 lines[i] 的子块结束位置（不含）。
// 中间空行/other 行不打断（但块尾的不算）；header 无论缩进多深都截断；
// 缩进 <= 父的行截断。i 越界或不是待办时返回 i+1。
export function subtreeEnd(lines, i) {
  if (!(i >= 0 && i < lines.length) || lines[i].kind !== 'todo') return i + 1;
  const base = indentUnits(lines[i].indent);
  let end = i + 1;
  let j = i + 1;
  while (j < lines.length) {
    const ln = lines[j];
    if (ln.kind === 'blank' || ln.kind === 'other') { j += 1; continue; }
    if (ln.kind === 'header') break;
    if (indentUnits(ln.indent) > base) { j += 1; end = j; continue; }
    break;
  }
  return end;
}

// subtreeStats：子树内 (待办总数, 已完成数, 备注数)，父待办自身不计入。
export function subtreeStats(lines, i) {
  const end = subtreeEnd(lines, i);
  let todos = 0, done = 0, notes = 0;
  for (let j = i + 1; j < end; j += 1) {
    const ln = lines[j];
    if (ln.kind === 'todo') { todos += 1; if (ln.checked) done += 1; }
    else if (ln.kind === 'note') notes += 1;
  }
  return [todos, done, notes];
}

// completedScan：主列表里可见的那一层待办（「顶层待办」）中已勾选的块。
// 返回 [{ i, end, unfinished }]：i/end 是整块的 [起, 止)，unfinished 是块内未勾选的子待办数。
// 父项没勾时整块跳过——它下面勾掉的子待办不算（用户拍板：只管父待办自己的勾选）。
// 「顶层」按子块层级判，不按顶格判：分组里的待办带缩进也仍是顶层。
export function completedScan(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.kind !== 'todo') { i += 1; continue; }
    const end = subtreeEnd(lines, i);
    if (ln.checked) {
      const [todos, done] = subtreeStats(lines, i);
      out.push({ i, end, unfinished: todos - done });
    }
    i = end;
  }
  return out;
}

// deleteCompleted：删掉 completedScan 报出的所有块，返回新数组（不动原数组）。
// 没命中的行 raw 一字不动（行保真）：未勾选的待办连同它的子块、分组标题、备注、空行全都留下。
export function deleteCompleted(lines) {
  const kill = new Set();
  for (const b of completedScan(lines)) {
    for (let j = b.i; j < b.end; j += 1) kill.add(j);
  }
  return lines.filter((_, idx) => !kill.has(idx));
}

// deleteSubtree：删除待办及其子块，返回新数组（不动原数组）。
export function deleteSubtree(lines, i) {
  const end = subtreeEnd(lines, i);
  return lines.slice(0, i).concat(lines.slice(end));
}

// blockEnd：拖动排序时的「行块」结束位置（不含）。
// 待办带走整棵子树；分组标题带走组内所有行，直到下一个标题（含组尾空行）；
// 其余行自成一格。i 越界时退回 i+1。
export function blockEnd(lines, i) {
  if (!(i >= 0 && i < lines.length)) return i + 1;
  const ln = lines[i];
  if (ln.kind === 'todo') return subtreeEnd(lines, i);
  if (ln.kind === 'header') {
    let j = i + 1;
    while (j < lines.length && lines[j].kind !== 'header') j += 1;
    return j;
  }
  return i + 1;
}

// allowsTopSlot：文件里有分组标题时，第一个标题之前没有落点
// （会造出不属于任何分组的顶层待办；开头是空行或顶格备注也不行）。
export function allowsTopSlot(lines) {
  return !lines.some((l) => l.kind === 'header');
}

// canMove：把 lines[from] 的行块搬到 insertAt（原下标，语义是「插在这一行之前」）是否算一次真移动。
// 落回原位置、原块尾、或自己块内部都不算。
// 两条边界规则：① 不许落到第一个分组标题之前；② 分组只能落在另一组的标题之前或文件末尾，
// 插进别的组中间会让那一组的条目改归拖过来的组（静默并组）。
export function canMove(lines, from, insertAt) {
  if (!(from >= 0 && from < lines.length)) return false;
  if (!(insertAt >= 0 && insertAt <= lines.length)) return false;
  const end = blockEnd(lines, from);
  if (insertAt === from || insertAt === end) return false;
  if (insertAt > from && insertAt < end) return false;
  if (!allowsTopSlot(lines) && insertAt <= firstHeader(lines)) return false;
  if (lines[from].kind === 'header'
      && insertAt !== lines.length && lines[insertAt].kind !== 'header') return false;
  return true;
}

function firstHeader(lines) {
  return lines.findIndex((l) => l.kind === 'header');
}

// 行尾缺换行时补一个，避免搬完之后两行粘成一行。只用于块尾与落点前一行。
function withEnding(line, nl) {
  if (line.raw.endsWith('\n')) return line;
  return { ...line, raw: line.raw + nl };
}

// moveBlock：把 lines[from] 的行块搬到 insertAt，返回新数组（原数组不动）。
// 不合法时（canMove 为假）返回等值副本，调用方不必先判。
// 行块内部 raw 一字不动，缩进（tab / 空格混用）原样跟着走。
export function moveBlock(lines, from, insertAt, nl = '\n') {
  if (!canMove(lines, from, insertAt)) return lines.slice();
  const end = blockEnd(lines, from);
  let block = lines.slice(from, end);
  let rest = lines.slice(0, from).concat(lines.slice(end));
  const at = insertAt > end ? insertAt - block.length : insertAt;
  if (at < rest.length) {
    block = block.slice(0, -1).concat([withEnding(block[block.length - 1], nl)]);
  }
  if (at > 0 && !rest[at - 1].raw.endsWith('\n')) {
    rest = rest.slice(0, at - 1).concat([withEnding(rest[at - 1], nl)], rest.slice(at));
  }
  return rest.slice(0, at).concat(block, rest.slice(at));
}

// childIndent：子项缩进，对齐到父条目正文位置（todo.pyw:151-157）。
// todo 对齐 "- [ ] " 之后（units + len(marker) + 6），其余对齐 "- " 之后（units + len(marker) + 2）。
export function childIndent(line) {
  const n = line.kind === 'todo'
    ? indentUnits(line.indent) + line.marker.length + 6
    : indentUnits(line.indent) + line.marker.length + 2;
  return ' '.repeat(n);
}

// groupTodoIndent：分组标题下第一条待办的缩进（todo.pyw:1454-1461 的 next_todo_indent）。
// 扫到第一条待办就抄它的缩进；撞上下一个组头或空行、或者组里根本没有待办，一律顶格。
export function groupTodoIndent(lines, i) {
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j].kind === 'todo') return lines[j].indent;
    if (lines[j].kind === 'header' || lines[j].kind === 'blank') break;
  }
  return '';
}

// todoBelow：「在条目 i 下方插一条待办」的落点，直接喂 insertLine(after, 'todo', indent, ...)。
// 分组标题插在标题本身之后、缩进跟组内第一条待办；待办插在整棵子块之后（不抢子项）。
// 备注/普通段落/空行不挂加号，返回 null。
export function todoBelow(lines, i) {
  const ln = lines[i];
  if (!ln) return null;
  if (ln.kind === 'header') return { after: i, indent: groupTodoIndent(lines, i) };
  if (ln.kind === 'todo') return { after: subtreeEnd(lines, i) - 1, indent: ln.indent };
  return null;
}

// panelParts：详情面板两栏 (子待办下标, 备注下标)，按文件原顺序；空行不进。
export function panelParts(lines, i) {
  const end = subtreeEnd(lines, i);
  const todos = [], notes = [];
  for (let j = i + 1; j < end; j += 1) {
    const ln = lines[j];
    if (ln.kind === 'todo') todos.push(j);
    else if (ln.kind === 'note' || ln.kind === 'other') notes.push(j);
  }
  return [todos, notes];
}

// 等价 Python str.splitlines(True)（本应用只关心 \n / \r\n）：保留每行行尾。
export function parseText(text) {
  const out = [];
  const re = /[^\r\n]*(?:\r\n|\n|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex += 1; if (re.lastIndex > text.length) break; continue; }
    out.push(parseLine(m[0]));
    if (re.lastIndex >= text.length) break;
  }
  return out;
}
