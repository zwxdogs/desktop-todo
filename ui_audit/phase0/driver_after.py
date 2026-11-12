# -*- coding: utf-8 -*-
"""UI audit capture driver: loads todo.pyw as a module in TEST_MODE, renders
the list and the detail panel, and grabs both HWNDs to PNG.

Usage: py -3.12 driver.py <todo.pyw> <sample.md> <outdir>
"""
import ctypes
import importlib.util
import json
import os
import sys
import time

from PIL import Image

TODO, SAMPLE, OUTDIR = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUTDIR, exist_ok=True)

# Must be set before Tk starts; mirror the app's PMv2 path.
try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)

# TEST_MODE is computed at import time from len(sys.argv) > 1.
sys.argv = ["todo.pyw", SAMPLE]

spec = importlib.util.spec_from_file_location("todo_mod", TODO)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

import tkinter as tk

root = tk.Tk()
app = mod.App(root, SAMPLE)
root.geometry("760x1000+40+20")
root.attributes("-topmost", True)
root.update()
app.load_file()
root.update()
time.sleep(0.4)
root.update()

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

for fn, res, args in (
    (user32.GetWindowDC, ctypes.c_void_p, [ctypes.c_void_p]),
    (user32.GetDC, ctypes.c_void_p, [ctypes.c_void_p]),
    (user32.GetAncestor, ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_uint]),
    (gdi32.CreateCompatibleDC, ctypes.c_void_p, [ctypes.c_void_p]),
    (gdi32.CreateCompatibleBitmap, ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]),
    (gdi32.SelectObject, ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_void_p]),
    (gdi32.GetDIBits, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint,
                                     ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]),
    (gdi32.BitBlt, ctypes.c_int, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                  ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_uint]),
    (gdi32.DeleteObject, ctypes.c_int, [ctypes.c_void_p]),
    (gdi32.DeleteDC, ctypes.c_int, [ctypes.c_void_p]),
    (user32.ReleaseDC, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p]),
    (user32.PrintWindow, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]),
    (user32.GetWindowRect, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p]),
):
    fn.restype = res
    fn.argtypes = args


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class BMIH(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", ctypes.c_uint16), ("biBitCount", ctypes.c_uint16),
                ("biCompression", ctypes.c_uint32), ("biSizeImage", ctypes.c_uint32),
                ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
                ("biClrUsed", ctypes.c_uint32), ("biClrImportant", ctypes.c_uint32)]


class BMI(ctypes.Structure):
    _fields_ = [("bmiHeader", BMIH), ("bmiColors", ctypes.c_uint32 * 3)]


def grab(hwnd, mode):
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    hdc = user32.GetWindowDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mdc, bmp)
    if mode == "print":
        ok = user32.PrintWindow(hwnd, mdc, 2)
    else:
        sdc = user32.GetDC(None)
        ok = gdi32.BitBlt(mdc, 0, 0, w, h, sdc, r.left, r.top, 0x00CC0020)
        user32.ReleaseDC(None, sdc)
    bi = BMI()
    bi.bmiHeader.biSize = ctypes.sizeof(BMIH)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    lines = gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(hwnd, hdc)
    return img, (r.left, r.top, w, h), int(ok), lines


def top_hwnd(win):
    return user32.GetAncestor(win.winfo_id(), 2) or win.winfo_id()


def capture(win, path):
    hwnd = top_hwnd(win)
    best = None
    for mode in ("print", "screen"):
        img, rect, ok, lines = grab(hwnd, mode)
        colors = len(img.getcolors(maxcolors=200000) or [])
        info = {"mode": mode, "rect": rect, "ok": ok, "lines": lines,
                "colors": colors, "size": list(img.size)}
        if colors > 8:
            best = (img, info)
            break
        if best is None:
            best = (img, info)
    img, info = best
    img.save(path)
    return info


facts = {"tk": root.tk.call("info", "patchlevel"),
         "fpixels_1i": root.winfo_fpixels("1i"),
         "scale_s": app.s,
         "screen": [root.winfo_screenwidth(), root.winfo_screenheight()],
         "root_geom": [root.winfo_x(), root.winfo_y(), root.winfo_width(), root.winfo_height()],
         "requested_geom": "760x1000+60+60",
         "fonts": {}}

for name in ("f_item", "f_note", "f_head", "f_btn", "f_item_done"):
    f = getattr(app, name)
    facts["fonts"][name] = {"family": f.actual("family"), "size_pt": f.actual("size"),
                            "px": f.metrics("linespace"), "measure_test": f.measure("测试 ab")}

main_info = capture(root, os.path.join(OUTDIR, "main.png"))
facts["main_capture"] = main_info

target = None
for i, ln in enumerate(app.lines):
    if ln.kind == "todo" and ln.text.startswith("开发控制器"):
        target = i
        break
assert target is not None, "target todo not found"
app.open_panel(target)
root.update()
time.sleep(0.5)
root.update()
panel_info = capture(app.panel, os.path.join(OUTDIR, "panel.png"))
facts["panel_capture"] = panel_info
facts["panel_geom"] = [app.panel.winfo_x(), app.panel.winfo_y(),
                       app.panel.winfo_width(), app.panel.winfo_height()]
facts["panel_target_index"] = target
facts["panel_rows"] = {"todos": len(app.p_todo_infos), "notes": len(app.p_note_infos)}

# 1:1 crop of list text: anchored on a rendered todo label, no resampling.
main_img = Image.open(os.path.join(OUTDIR, "main.png"))
anchor = None
badge_anchor = None
for i, info in app.rows.items():
    txt = info["lbl"].cget("text") if info.get("lbl") is not None else ""
    if anchor is None and txt == "MHD 实验":
        anchor = info
    if badge_anchor is None and txt.startswith("开发控制器"):
        badge_anchor = info
hx = anchor["lbl"].winfo_rootx() - root.winfo_rootx()
hy = anchor["lbl"].winfo_rooty() - root.winfo_rooty()
lx, ly = max(0, hx - 10), max(0, hy - 8)
crop = main_img.crop((lx, ly, min(lx + 200, main_img.width), min(ly + 200, main_img.height)))
crop.save(os.path.join(OUTDIR, "text_crop.png"))
facts["text_crop"] = {"origin": [lx, ly], "size": list(crop.size), "from": "main.png at 1:1"}

gc = main_img.crop((main_img.width - 120, main_img.height - 80, main_img.width, main_img.height))
gc.save(os.path.join(OUTDIR, "grip_crop.png"))
facts["grip_crop"] = {"origin": [main_img.width - 120, main_img.height - 80], "size": list(gc.size)}

if badge_anchor is not None:
    bx = badge_anchor["badge"].winfo_rootx() - root.winfo_rootx()
    by = badge_anchor["badge"].winfo_rooty() - root.winfo_rooty()
    bc = main_img.crop((max(0, bx - 8), max(0, by - 8),
                        min(main_img.width, bx + 192), min(main_img.height, by + 56)))
    bc.save(os.path.join(OUTDIR, "badge_crop.png"))
    facts["badge_crop"] = {"origin": [max(0, bx - 8), max(0, by - 8)], "size": list(bc.size)}

with open(os.path.join(OUTDIR, "facts.json"), "w", encoding="utf-8") as f:
    json.dump(facts, f, ensure_ascii=False, indent=2)

print(json.dumps(facts, ensure_ascii=False, indent=2))
root.destroy()
