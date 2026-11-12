// spike/tauri2/ui/app.js — 渲染 sample/真实待办文件，勾选/行内编辑走行保真写回。
import { parseText, serialize, toggleRaw, setLineText, subtreeStats, indentUnits } from './md.js';

const { invoke } = window.__TAURI__.core;
const win = window.__TAURI__.window.getCurrentWindow();

const listEl = document.getElementById('list');
const statusText = document.getElementById('status-text');
const imeState = document.getElementById('ime-state');

let filePath = '';
let lines = [];

const SVG_CHECK = '<svg viewBox="0 0 12 12"><path d="M2 6.5 4.8 9.2 10 3.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_DONE = '<svg viewBox="0 0 12 12"><path d="M2 6.5 4.8 9.2 10 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_NOTE = '<svg viewBox="0 0 12 12"><rect x="2" y="1.5" width="8" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 4.5h4M4 6.5h4M4 8.5h2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

function status(msg) {
  statusText.textContent = msg;
  invoke('log_line', { msg }).catch(() => {});
}

async function persist(reason) {
  try {
    await invoke('write_file', { path: filePath, contents: serialize(lines) });
    status(`已写回（${reason}）· 字节级保真`);
  } catch (e) {
    status(`写回失败: ${e}`);
  }
}

function makeBadge(stats) {
  const [todos, done, notes] = stats;
  if (todos === 0 && notes === 0) return null;
  const el = document.createElement('div');
  el.className = 'badge';
  if (todos > 0) {
    const b = document.createElement('span');
    b.className = 'b';
    b.innerHTML = `${todos > 0 && done === todos ? SVG_DONE : SVG_CHECK}<span>${done}/${todos}</span>`;
    el.appendChild(b);
  }
  if (notes > 0) {
    const b = document.createElement('span');
    b.className = 'b';
    b.innerHTML = `${SVG_NOTE}<span>${notes}</span>`;
    el.appendChild(b);
  }
  return el;
}

function startEdit(row, idx) {
  if (row.querySelector('.edit-input')) return;
  const label = row.querySelector('.todo-text');
  const input = document.createElement('input');
  input.className = 'edit-input';
  input.value = lines[idx].text;
  row.replaceChild(input, label);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const commit = () => {
    // 与 todo.pyw edit_row 对齐：不去空白（val = ent.get()）、空文本也照写
    // （Python 版 set_line_text(line, '') 保留空行，不删除）。
    const v = input.value;
    if (v !== lines[idx].text) {
      setLineText(lines[idx], v);
      persist('行内编辑');
    }
    render();
  };
  const cancel = () => render();

  // IME 组合事件直通状态栏 —— 验证 WebView2 中文输入链路（对照 Tauri #16391）
  input.addEventListener('compositionstart', () => { imeState.textContent = 'IME: 组合开始'; });
  input.addEventListener('compositionupdate', (e) => { imeState.textContent = `IME: ${e.data}`; });
  input.addEventListener('compositionend', () => { imeState.textContent = 'IME: 提交'; });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME 组合中的按键不当作编辑命令
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}

function render() {
  listEl.textContent = '';
  const frag = document.createDocumentFragment();

  lines.forEach((ln, i) => {
    if (ln.kind === 'blank') return;

    if (ln.kind === 'header') {
      const h = document.createElement('div');
      h.className = 'group-head';
      h.textContent = ln.text;
      frag.appendChild(h);
      return;
    }

    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginLeft = `${16 + indentUnits(ln.indent) * 8}px`;

    if (ln.kind === 'todo') {
      const box = document.createElement('div');
      box.className = 'checkbox' + (ln.checked ? ' checked' : '');
      box.innerHTML = SVG_CHECK;
      box.addEventListener('click', () => {
        toggleRaw(lines[i]);
        box.classList.toggle('checked', lines[i].checked);
        row.classList.toggle('is-done', lines[i].checked);
        persist('勾选');
      });
      row.appendChild(box);

      const label = document.createElement('div');
      label.className = 'todo-text';
      label.textContent = ln.text;
      row.appendChild(label);
      row.classList.toggle('is-done', ln.checked);
      row.title = '双击编辑（中文 IME 测试）';
      row.addEventListener('dblclick', () => startEdit(row, i));

      const badge = makeBadge(subtreeStats(lines, i));
      if (badge) row.appendChild(badge);
    } else if (ln.kind === 'note') {
      row.classList.add('note-row');
      const label = document.createElement('div');
      label.className = 'todo-text';
      label.textContent = `• ${ln.text}`;
      row.appendChild(label);
    } else {
      const label = document.createElement('div');
      label.className = 'todo-text';
      label.textContent = ln.text;
      row.appendChild(label);
    }

    row.addEventListener('pointerdown', () => row.classList.add('pressing'));
    row.addEventListener('pointerup', () => row.classList.remove('pressing'));
    row.addEventListener('pointerleave', () => row.classList.remove('pressing'));
    frag.appendChild(row);
  });

  listEl.appendChild(frag);
}

async function boot() {
  document.getElementById('btn-close').addEventListener('click', () => win.close());
  document.getElementById('btn-demo').addEventListener('click', () => {
    document.getElementById('demo-overlay').classList.remove('hidden');
  });
  document.getElementById('btn-demo-close').addEventListener('click', () => {
    document.getElementById('demo-overlay').classList.add('hidden');
  });

  try {
    filePath = await invoke('initial_file');
    if (!filePath) {
      status('未设置 DT_SPIKE_FILE 环境变量');
      return;
    }
    const text = await invoke('read_file', { path: filePath });
    lines = parseText(text);
    render();
    status(`已加载 ${lines.length} 行 · ${filePath}`);
  } catch (e) {
    status(`加载失败: ${e}`);
  }
}

boot();
