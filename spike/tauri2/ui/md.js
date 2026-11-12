// md.js — 待办 Markdown 行保真核心（ spike/tauri2/ui ）。
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

// deleteSubtree：删除待办及其子块，返回新数组（不动原数组）。
export function deleteSubtree(lines, i) {
  const end = subtreeEnd(lines, i);
  return lines.slice(0, i).concat(lines.slice(end));
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
