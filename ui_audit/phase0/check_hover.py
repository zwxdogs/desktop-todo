# -*- coding: utf-8 -*-
"""Phase 0 交互态自检: 合成 Enter/Leave/Press 事件, 打印实际底色。"""
import ctypes
import importlib.util
import os
import sys

import tkinter as tk

HERE = os.path.dirname(os.path.abspath(__file__))
TODO = os.path.join(os.path.dirname(os.path.dirname(HERE)), "todo.pyw")
SAMPLE = os.path.join(HERE, "sample.md")

try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)

sys.argv = ["todo.pyw", SAMPLE]
spec = importlib.util.spec_from_file_location("todo_mod", TODO)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

root = tk.Tk()
app = mod.App(root, SAMPLE)
root.geometry("760x1000+40+20")
root.attributes("-topmost", True)
root.update()
app.load_file()
root.update()

def bg(w):
    return w.cget("bg")

# 主列表行: 找一个带徽标的 todo
info = None
for i, it in app.rows.items():
    if it.get("lbl") is not None and it.get("badge") is not None:
        info = it
        break
assert info is not None
lbl, box, badge = info["lbl"], info["box"], info["badge"]

lbl.event_generate("<Enter>")
root.update()
print("row enter :", bg(lbl), bg(box), bg(badge),
      "expect", mod.C_HOVER)
lbl.event_generate("<ButtonPress-1>")
root.update()
print("row press :", bg(lbl), bg(box), bg(badge),
      "expect", mod.C_PRESS)
lbl.event_generate("<ButtonRelease-1>")
root.update()
print("row release:", bg(lbl), bg(box), bg(badge),
      "expect", mod.C_HOVER)
lbl.event_generate("<Leave>")
root.update()
print("row leave :", bg(lbl), bg(box), bg(badge),
      "expect", mod.C_BG)

# 顶栏按钮 hover: 只发 Enter/Leave, 不触发命令
app.btn_add.event_generate("<Enter>")
root.update()
print("btn enter :", bg(app.btn_add), "expect", mod.C_BTN_HOVER)
app.btn_add.event_generate("<Leave>")
root.update()
print("btn leave :", bg(app.btn_add), "expect", mod.C_HEADER)

# 钉住图标点亮态: hover 离开后应回到浅蓝底而不是普通底色
app.docked = False
app._update_pin()
root.update()
print("pin lit   :", app.btn_pin.lit, bg(app.btn_pin), "expect True #DCE9FA")
app.btn_pin.event_generate("<Enter>")
root.update()
print("pin hover :", bg(app.btn_pin), "expect", mod.C_BTN_HOVER)
app.btn_pin.event_generate("<Leave>")
root.update()
print("pin leave :", bg(app.btn_pin), "expect #DCE9FA")

# 缩放手柄: 3 条线
print("grip items:", len(app.grip.find_all()), "expect 3")

# 详情面板: 标题字号 + 行 hover + 添加按钮 hover
target = None
for i, ln in enumerate(app.lines):
    if ln.kind == "todo" and ln.text == "开发控制器":
        target = i
        break
assert target is not None
app.open_panel(target)
root.update()
print("panel title font:", app.p_title_lbl.cget("font"),
      "size", app.f_head.actual("size"), "weight", app.f_head.actual("weight"))
pinfo = app.p_todo_infos[0]
pinfo["lbl"].event_generate("<Enter>")
root.update()
print("panel row enter:", bg(pinfo["lbl"]), bg(pinfo["box"]),
      "expect", mod.C_HOVER)
pinfo["lbl"].event_generate("<Leave>")
root.update()
print("panel row leave:", bg(pinfo["lbl"]), bg(pinfo["box"]),
      "expect", mod.C_BG)

pane = app.p_todo_canvas.master
bar = [w for w in pane.winfo_children() if isinstance(w, tk.Frame)][0]
add = bar.winfo_children()[0]
add.event_generate("<Enter>")
root.update()
print("panel add enter:", bg(add), "expect", mod.C_HOVER)
add.event_generate("<Leave>")
root.update()
print("panel add leave:", bg(add), "expect", mod.C_BG)

print("window bg:", root.cget("bg"), "expect", mod.C_HAIRLINE)
print("shell children:", [w.winfo_class() for w in app.shell.winfo_children()])

root.destroy()
