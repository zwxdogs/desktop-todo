# -*- coding: utf-8 -*-
"""点勾选后行被重建, 确认 release 事件不会打到已销毁控件。"""
import ctypes
import importlib.util
import os
import shutil
import sys
import tkinter as tk

HERE = os.path.dirname(os.path.abspath(__file__))
TODO = os.path.join(os.path.dirname(os.path.dirname(HERE)), "todo.pyw")
SAMPLE = os.path.join(HERE, "sample.md")
TMP = os.path.join(HERE, "toggle_test.md")
shutil.copyfile(SAMPLE, TMP)

try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)

sys.argv = ["todo.pyw", TMP]
spec = importlib.util.spec_from_file_location("todo_mod", TODO)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

errors = []
root = tk.Tk()
root.report_callback_exception = lambda *a: errors.append(a)
app = mod.App(root, TMP)
root.geometry("760x1000+40+20")
root.update()
app.load_file()
root.update()

target = None
for i, ln in enumerate(app.lines):
    if ln.kind == "todo" and ln.text == "准备去复旦做的实验":
        target = i
        break
assert target is not None
box = app.rows[target]["box"]
box.event_generate("<ButtonPress-1>")
root.update()
print("after press checked:", app.lines[target].checked)
# 重建后指针下是新控件, release 应落在新 box 上
new_box = app.rows[target]["box"]
print("row rebuilt:", new_box is not box)
new_box.event_generate("<ButtonRelease-1>")
root.update()
print("callback errors:", errors)
print("new row exists:", target in app.rows)
root.destroy()
os.remove(TMP)
