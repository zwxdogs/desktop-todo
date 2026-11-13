// undo.js 的行为测试 —— 与 todo.pyw App.push_undo/undo 语义逐条对齐。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUndoStack } from "./undo.js";

test("push 后 undo 弹回同一条快照", () => {
  const u = createUndoStack();
  u.push("A");
  assert.equal(u.size(), 1);
  assert.equal(u.undo(), "A");
});

test("undo 空栈返回 null（Tk None）", () => {
  const u = createUndoStack();
  assert.equal(u.undo(), null);
  u.push("A");
  u.undo();
  assert.equal(u.undo(), null);
});

test("与栈顶相同的快照不重复入栈", () => {
  const u = createUndoStack();
  u.push("A");
  u.push("A");
  u.push("A");
  assert.equal(u.size(), 1);
});

test("LIFO：后进的先弹出", () => {
  const u = createUndoStack();
  u.push("A");
  u.push("B");
  u.push("C");
  assert.equal(u.undo(), "C");
  assert.equal(u.undo(), "B");
  assert.equal(u.undo(), "A");
  assert.equal(u.undo(), null);
});

test("容量 50：超过后丢最旧（Tk pop(0)）", () => {
  const u = createUndoStack(50);
  for (let i = 0; i < 51; i++) u.push("s" + i); // s0..s50
  assert.equal(u.size(), 50);
  // s0 已被丢弃；第一个弹出的必须是 s50，最后一个是 s1
  assert.equal(u.undo(), "s50");
  for (let i = 49; i >= 1; i--) assert.equal(u.undo(), "s" + i);
  assert.equal(u.undo(), null);
});

test("canUndo：空栈 false、有货 true、撤空后 false（Tk `if not stack: return`）", () => {
  const u = createUndoStack();
  assert.equal(u.canUndo(), false);
  u.push("A");
  assert.equal(u.canUndo(), true);
  u.undo();
  assert.equal(u.canUndo(), false);
});

test("撤销后再 push 不同的快照正常工作", () => {
  const u = createUndoStack();
  u.push("A");
  u.push("B");
  u.undo(); // 弹出 B，栈里剩 A
  u.push("C");
  assert.equal(u.size(), 2);
  assert.equal(u.undo(), "C");
  assert.equal(u.undo(), "A");
});
