// 撤销栈 —— todo.pyw App.push_undo/undo 的 1:1 移植（TDD 接缝）。
// Tk 语义：
//   push_undo(): 序列化快照入栈；与栈顶相同则跳过；超过 50 条丢最旧（pop(0)）。
//   undo():      弹出最近一条快照（LIFO）；栈空返回 None。

export function createUndoStack(cap = 50) {
  const stack = [];

  return {
    /** 即将修改清单内容之前调用；与栈顶快照相同则不重复入栈。 */
    push(snapshot) {
      if (stack.length && stack[stack.length - 1] === snapshot) return;
      stack.push(snapshot);
      if (stack.length > cap) stack.shift(); // Tk pop(0)：丢最旧
    },

    /** 撤回：弹出并返回最近一条快照；栈空返回 null。 */
    undo() {
      return stack.length ? stack.pop() : null;
    },

    /** 栈非空（Tk undo() 开头的 `if not self.undo_stack: return`）。 */
    canUndo() {
      return stack.length > 0;
    },

    /** 当前栈深（测试/日志用）。 */
    size() {
      return stack.length;
    },
  };
}
