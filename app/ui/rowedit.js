/* 行内编辑框：主窗口与详情面板共用的一份实现（#15）。
   Enter / 失焦提交，Esc 取消；IME 组合中的回车与 Esc 不处理（交给输入法）。
   返回的 teardown 可重入，调用方先用它收掉自己的状态，再决定提交还是丢弃。 */

export function openRowEdit({ label, text, done, onFinish, onCancel }) {
  const row = label.parentNode;
  const input = document.createElement('input');
  input.className = 'row-edit' + (done ? ' done' : '');
  input.value = text;
  label.style.display = 'none';
  row.classList.add('editing');   // 编辑中把加号和把手收起来（CSS 只管显隐）
  row.insertBefore(input, label.nextSibling);
  input.select();
  input.focus();

  let closed = false;
  function teardown() {
    if (closed) return;
    closed = true;
    input.remove();
    label.style.display = '';
    row.classList.remove('editing');
  }

  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // IME 组合中的回车/ESC 不处理
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value;
      teardown();
      if (onFinish) onFinish(v);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      teardown();
      if (onCancel) onCancel();
    }
  });
  input.addEventListener('blur', () => {
    if (closed) return;
    const v = input.value;
    teardown();
    if (onFinish) onFinish(v);
  });
  input.addEventListener('compositionend', () => input.focus());

  return { input, teardown };
}
