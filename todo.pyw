# -*- coding: utf-8 -*-
"""
桌面待办 —— 把 Markdown 待办清单固定在 Windows 桌面上显示和编辑。

用法:
    pythonw todo.pyw [md文件路径]
不带参数时读取 config.json 中记住的文件（默认程序目录下的 待办.md）。
传入文件路径即为测试运行：不读写 config.json，并在文件旁写 widget.log 便于调试。

行为:
- 默认嵌入桌面层（壁纸/图标之上、普通窗口之下），不占任务栏，Win+D 可见
- 点击方框勾选、双击文字编辑（点输入框以外任何地方即结束）、右键增删条目
- 双击待办打开详情面板: 上栏子待办、下栏备注, 各自带添加按钮
- 层级只到「待办 -> 子待办」一层, 子待办是纯叶子
- 外部改动（如 Obsidian）约 1 秒内自动刷新; 桌面上的改动自动写回文件
- 序列化时未被编辑的行原样保留, 不破坏 Obsidian 的格式
"""
import ctypes
import json
import os
import re
import subprocess
import sys
import time
from ctypes import wintypes

import tkinter as tk
from tkinter import font as tkfont, filedialog, messagebox

APP_NAME = "桌面待办"
APP_VERSION = "0.2.7"
MUTEX_NAME = "Zwx_DesktopTodoWidget_Mutex"
TEST_MODE = len(sys.argv) > 1  # 传入文件路径 = 测试运行


def _base_dir():
    """程序目录: 打包成 exe 后取 exe 所在目录, 否则取本文件所在目录。

    PyInstaller 冻结后 __file__ 指向临时解压目录(_MEIPASS)或
    _internal 子目录, config.json/待办.md 必须跟着 exe 走(绿色便携版语义)。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


APP_DIR = _base_dir()
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
DEFAULT_FILE = os.path.join(APP_DIR, "待办.md")

# ---------------- 配色 ----------------
C_BG     = "#FAFBFC"
C_HEADER = "#EDF0F4"
C_TEXT   = "#24292F"
C_DONE   = "#9CA3AF"
C_NOTE   = "#8B929B"
C_NOTE_T = "#57606A"   # 备注正文: 备注移进详情面板后不必再用次要灰
C_HEADFG = "#3D76B5"
C_ACCENT = "#4A8FE2"
C_BOX    = "#C6CCD4"   # 未勾选方框: 比旧版浅一档, 配 2px 发丝边
C_HOVER  = "#F2F5F8"   # 行 hover 底色
C_PRESS  = "#E8EEF6"   # 行 pressed 底色
C_RULE   = "#DFE4EA"   # 发丝分隔线(顶栏下/面板栏间)
C_HAIRLINE = "#E1E6ED" # 窗体 1px 外描边
C_GRIP   = "#A8B0BC"   # 右下缩放手柄
C_BTN_HOVER = "#E3E8EF"
C_BTN_PRESS = "#D7DEE7"

# 内联编辑 Entry 的统一样式(主列表/面板/标题改名共用)
ENTRY_STYLE = dict(bg="#FFFFFF", fg=C_TEXT, relief="solid", bd=1,
                   highlightthickness=1,
                   highlightbackground=C_ACCENT, highlightcolor=C_ACCENT)

# ---------------- Markdown 行解析 ----------------
RE_BLANK  = re.compile(r"^\s*$")
RE_HEADER = re.compile(r"^(\s*)\*\*(.+?)\*\*\s*$")
RE_TODO   = re.compile(r"^(\s*)([-*+])[ \t]+\[([ xX])\](\s*)(.*)$")
RE_NOTE   = re.compile(r"^(\s*)([-*+])[ \t]+(.*)$")


class Line:
    """文件中的一行。raw 为原始文本(含行尾符)，未被编辑的行写回时一字不动。"""
    __slots__ = ("kind", "raw", "indent", "marker", "checked",
                 "text", "cb_pos", "ws_after_cb", "ending")

    def __init__(self, kind, raw, indent="", marker="", checked=False,
                 text="", cb_pos=-1, ws_after_cb=""):
        self.kind = kind          # blank / header / todo / note / other
        self.raw = raw
        self.indent = indent
        self.marker = marker
        self.checked = checked
        self.text = text
        self.cb_pos = cb_pos      # raw 中 "[" 的下标, 翻转勾选时原位替换
        self.ws_after_cb = ws_after_cb
        m = re.search(r"(\r?\n)$", raw)
        self.ending = m.group(1) if m else ""

    def indent_units(self):
        return len(self.indent.expandtabs(4))


def parse_line(raw):
    m = re.search(r"(\r?\n)$", raw)
    body = raw[:m.start()] if m else raw
    if RE_BLANK.match(body):
        return Line("blank", raw)
    m = RE_HEADER.match(body)
    if m:
        return Line("header", raw, indent=m.group(1), text=m.group(2))
    m = RE_TODO.match(body)
    if m:
        return Line("todo", raw, indent=m.group(1), marker=m.group(2),
                    checked=m.group(3) != " ", text=m.group(5),
                    cb_pos=m.start(3), ws_after_cb=m.group(4))
    m = RE_NOTE.match(body)
    if m:
        return Line("note", raw, indent=m.group(1), marker=m.group(2), text=m.group(3))
    return Line("other", raw, text=body)


def parse_text(text):
    return [parse_line(l) for l in text.splitlines(True)]


def serialize(lines):
    return "".join(l.raw for l in lines)


def toggle_raw(line):
    """原位翻转 [ ] / [x]，其余字符一字不动。cb_pos 指向方括号内的状态字符。"""
    i = line.cb_pos
    line.raw = line.raw[:i] + ("x" if not line.checked else " ") + line.raw[i + 1:]
    line.checked = not line.checked


def set_line_text(line, text):
    line.text = text
    if line.kind == "todo":
        line.raw = (line.indent + line.marker + " ["
                    + ("x" if line.checked else " ") + "]"
                    + line.ws_after_cb + text + line.ending)
    elif line.kind == "note":
        line.raw = line.indent + line.marker + " " + text + line.ending
    elif line.kind == "header":
        line.raw = line.indent + "**" + text + "**" + line.ending
    else:
        line.raw = text + line.ending


def child_indent(line):
    """子项缩进：对齐到父条目正文位置，Obsidian 里可正确嵌套。"""
    if line.kind == "todo":
        n = line.indent_units() + len(line.marker) + 6   # "- [ ] " 正文起点
    else:
        n = line.indent_units() + len(line.marker) + 2
    return " " * n


def subtree_end(lines, i):
    """待办 lines[i] 的子块结束位置（不含）。

    子块 = 其后所有缩进更深（indent_units 按 expandtabs(4) 折算）的连续行：
    中间的空行和 other 行不打断子块（other 行解析不出缩进，随其后的子行一起圈入），
    但块尾的空行/other 行不算子块；
    缩进 <= 父的行截断子块；分组标题（header）无论缩进多深都截断。
    i 越界或不是待办时返回 i+1。
    """
    if not 0 <= i < len(lines) or lines[i].kind != "todo":
        return i + 1
    base = lines[i].indent_units()
    end = i + 1
    j = i + 1
    while j < len(lines):
        ln = lines[j]
        if ln.kind in ("blank", "other"):
            j += 1                      # 空行/other 暂不放行，只有后续子行才把它圈进来
            continue
        if ln.kind == "header":
            break                       # 分组标题是硬边界
        if ln.kind != "other" and ln.indent_units() > base:
            j += 1
            end = j                     # 只有真实子行才推进块尾
            continue
        break
    return end


def subtree_stats(lines, i):
    """待办 lines[i] 子树的 (待办总数, 已完成数, 备注数)，递归统计。

    供主列表徽标（如「✓2/5 📝3」）使用；父待办自身不计入。
    """
    end = subtree_end(lines, i)
    todos = done = notes = 0
    for ln in lines[i + 1:end]:
        if ln.kind == "todo":
            todos += 1
            if ln.checked:
                done += 1
        elif ln.kind == "note":
            notes += 1
    return todos, done, notes


def delete_subtree(lines, i):
    """删除待办 lines[i] 及其整个子块，返回新列表（不修改原列表）。"""
    end = subtree_end(lines, i)
    return lines[:i] + lines[end:]


def panel_parts(lines, i):
    """详情面板两栏的内容：返回 (子待办下标, 备注下标)，均按文件原顺序。

    上栏放待办，下栏放备注与其它普通行（other 行当普通文字显示）；
    空行只是文件里的排版，不进入任何一栏。
    """
    end = subtree_end(lines, i)
    todos, notes = [], []
    for j in range(i + 1, end):
        ln = lines[j]
        if ln.kind == "todo":
            todos.append(j)
        elif ln.kind in ("note", "other"):
            notes.append(j)
    return todos, notes


# ---------------- Win32: 伪桌面层 ----------------
# 思路: 不用 SetParent 挂载(Tk 窗口被挂载后 DWM 不再合成其画面, 且坐标系错乱),
# 而是把普通顶层窗口压到 Z 序底部、桌面窗口(Progman)之上 —— 效果等同贴在桌面上:
# 普通应用窗口自然盖住它; 显示桌面/最小化应用时它可见、可点击。
user32 = ctypes.windll.user32

HWND_BOTTOM = 1
GW_HWNDPREV = 3
GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x00000008
SWP_NOSIZE, SWP_NOMOVE = 0x0001, 0x0002
SWP_NOACTIVATE, SWP_FRAMECHANGED, SWP_SHOWWINDOW = 0x0010, 0x0020, 0x0040


def toplevel_hwnd(widget):
    h = widget.winfo_id()
    p = user32.GetParent(h)
    return p or h


def _set_window_long(hwnd, index, value):
    """SetWindowLongW 需要的 32 位有符号值(Python 无符号结果超出范围时会 OverflowError)。"""
    value &= 0xFFFFFFFF
    if value >= 0x80000000:
        value -= 0x100000000
    return user32.SetWindowLongW(hwnd, index, value)


def desktop_hwnd():
    return user32.FindWindowW("Progman", None)


def set_toolwindow(root):
    """WS_EX_TOOLWINDOW: 不出现在任务栏和 Alt+Tab。"""
    hwnd = toplevel_hwnd(root)
    WS_EX_TOOLWINDOW = 0x00000080
    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    _set_window_long(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW)
    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE)


def send_above_desktop(root):
    """把窗口压到"桌面之上、其余窗口之下"的 Z 序位置。"""
    hwnd = toplevel_hwnd(root)
    progman = desktop_hwnd()
    if not progman:
        return
    user32.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    # 把桌面窗口垫到我们正下方(Progman 平时就在最底, 该调用通常只是保持原位)
    user32.SetWindowPos(progman, hwnd, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)


def virtual_screen():
    """虚拟屏幕(全部显示器)的物理像素范围 (x, y, w, h); 取不到时退回主屏。

    本应用在 PerMonitorV2/system-aware 下实测: Tk 的 wm geometry / winfo_x()
    坐标与这里的物理像素 1:1 对应(DPI 缩放不改变坐标值), 因此可直接混用。
    """
    sm = user32.GetSystemMetrics
    vx, vy, vw, vh = sm(76), sm(77), sm(78), sm(79)
    if vw <= 0 or vh <= 0:
        vx, vy, vw, vh = 0, 0, sm(0), sm(1)
    return vx, vy, vw, vh


def clamp_pos(x, y, w, h, vx, vy, vw, vh):
    """把左上角 (x, y) 的 w×h 窗口夹回虚拟屏幕内, 返回新左上角; 已在屏内则原样返回。"""
    nx = max(vx, min(x, vx + vw - w))
    ny = max(vy, min(y, vy + vh - h))
    return nx, ny


def panel_pos(rx, ry, rw, pw, ph, vx, vy, vw, vh, gap):
    """详情面板落点: 优先主窗口右侧, 右侧放不下放主窗口左侧, 再贴虚拟屏右缘;
    y 对齐主窗口并夹回屏内。"""
    px = rx + rw + gap
    if px + pw > vx + vw:
        px = rx - pw - gap
    if px < vx:
        px = max(vx, vx + vw - pw - gap)
    py = max(vy, min(ry, vy + vh - ph - gap))
    return px, py


def at_desktop_level(root):
    """是否已在'紧贴桌面上方'的 Z 序位置。"""
    progman = desktop_hwnd()
    return bool(progman) and user32.GetWindow(progman, GW_HWNDPREV) == toplevel_hwnd(root)


def is_foreground(root):
    return user32.GetForegroundWindow() == toplevel_hwnd(root)


def is_iconic(root):
    return bool(user32.IsIconic(toplevel_hwnd(root)))


# ---------------- 主应用 ----------------
class App:
    def __init__(self, root, file_path):
        self.root = root
        self.file = file_path
        self.testing = TEST_MODE
        self.cfg = {}
        if not self.testing and os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, encoding="utf-8") as f:
                    self.cfg = json.load(f)
            except Exception:
                self.cfg = {}

        self.lines = []
        self.nl = "\n"
        self.has_bom = False
        self.last_seen = None
        self.save_job = None
        self.docked = False
        self._pox = self._poy = 0   # 桌面父窗口客户区原点(屏幕坐标)
        self.rows = {}
        self.edit_entry = None
        self.edit_index = -1
        self.edit_commit = None      # 当前内联编辑的提交回调(点外面/刷新时统一调用)
        # --- 详情面板状态 ---
        self.panel = None            # 详情面板 Toplevel（单实例）
        self.panel_todo = -1         # 面板对应的待办行下标
        self.panel_anchor = ("", 0)  # (待办文字, 缩进) 外部重载后重定位锚
        self.p_rows = {}
        self.p_edit_entry = None
        self.p_edit_index = -1
        self.p_edit_commit = None
        self.p_rename_entry = None
        self.p_rename_commit = None
        self.p_title_lbl = None
        self.p_title_pack = {}
        self.missing_shown = False
        self.undo_stack = []
        self._dx = self._dy = 0
        self._mx = self._my = 0
        self._rw = self._rh = 0
        self.logf = None
        self.ro_warned = False   # 只读目录警告只弹一次
        if self.testing:
            self.logf = open(os.path.join(os.path.dirname(self.file), "widget.log"),
                             "a", encoding="utf-8", buffering=1)
        self.log("%s v%s" % (APP_NAME, APP_VERSION))

        s = self.s = max(1.0, root.winfo_fpixels("1i") / 96.0)
        root.title(APP_NAME)
        root.configure(bg=C_HAIRLINE)
        root.overrideredirect(True)
        root.minsize(int(260 * s), int(180 * s))

        # 1px 外描边: 无边框窗口落在浅色壁纸上没有边界, 让 shell 内缩 1px
        # 露出 root 底色; 不占额外布局, 也不影响拖动/缩放命中。
        self.shell = tk.Frame(root, bg=C_BG)
        self.shell.pack(fill="both", expand=True, padx=1, pady=1)

        self.f_item = tkfont.Font(family="Microsoft YaHei UI", size=10)
        self.f_item_done = tkfont.Font(family="Microsoft YaHei UI", size=10, overstrike=1)
        self.f_note = tkfont.Font(family="Microsoft YaHei UI", size=9)
        self.f_note_done = tkfont.Font(family="Microsoft YaHei UI", size=9, overstrike=1)
        self.f_head = tkfont.Font(family="Microsoft YaHei UI", size=11, weight="bold")
        self.f_btn = tkfont.Font(family="Microsoft YaHei UI", size=9)

        # --- 顶栏(右→左: ✕ ↻ 📌 ＋) ---
        hdr = tk.Frame(self.shell, bg=C_HEADER, height=int(34 * s))
        hdr.pack(fill="x", side="top")
        hdr.pack_propagate(False)
        self.hdr = hdr
        # 顶栏底色与正文只差 1.06:1, 用一条 1px 发丝线分界, 比加深整条栏更轻
        hdr_rule = tk.Frame(self.shell, bg=C_RULE, height=1)
        hdr_rule.pack(fill="x", side="top")
        self.lbl_title = tk.Label(hdr, text=APP_NAME, bg=C_HEADER, fg=C_TEXT,
                                  font=self.f_btn, cursor="fleur")
        self.lbl_title.pack(side="left", padx=(int(10 * s), 0))

        # 图标按钮: 统一尺寸的 Canvas 盒子, 字形按墨迹包围盒居中。
        # 不同字形的行盒高低不一, 用 Label 排版时视觉中心对不齐; 这里按
        # bbox 反算偏移, 既让四个图标的中线一致, 点亮时的色块也正好套住字形。
        bw, bh = int(30 * s), int(26 * s)
        self._hdr_fonts = {}                    # 保住 Font 引用, 否则字形不显示

        def hbtn(text, cmd, fsize):
            box = tk.Canvas(hdr, width=bw, height=bh, bg=C_HEADER,
                            highlightthickness=0, cursor="hand2")
            fnt = self._hdr_fonts.get(fsize)
            if fnt is None:
                fnt = self._hdr_fonts[fsize] = tkfont.Font(
                    family="Microsoft YaHei UI", size=fsize)
            tid = box.create_text(bw // 2, bh // 2, text=text, font=fnt,
                                  fill="#5A6472")
            bb = box.bbox(tid)
            if bb:                                  # 墨迹中心对齐盒子中心
                box.move(tid, bw // 2 - (bb[0] + bb[2]) / 2.0,
                         bh // 2 - (bb[1] + bb[3]) / 2.0 - 1)
            box.glyph = tid
            box.lit = False
            box.hover = False

            def _paint(bg, ink):
                box.configure(bg=bg)
                box.itemconfigure(tid, fill=ink)

            def _enter(e):
                box.hover = True
                _paint(C_BTN_HOVER, C_TEXT)

            def _leave(e):
                box.hover = False
                if box.lit:
                    _paint("#DCE9FA", C_ACCENT)
                else:
                    _paint(C_HEADER, "#5A6472")

            def _press(e):
                _paint(C_BTN_PRESS, C_TEXT)

            def _release(e):
                if box.lit:
                    _paint("#DCE9FA", C_ACCENT)
                elif box.hover:
                    _paint(C_BTN_HOVER, C_TEXT)
                else:
                    _paint(C_HEADER, "#5A6472")

            box.bind("<Enter>", _enter, add="+")
            box.bind("<Leave>", _leave, add="+")
            box.bind("<ButtonPress-1>", _press, add="+")
            box.bind("<ButtonRelease-1>", _release, add="+")
            box.bind("<Button-1>", lambda e: cmd())
            return box

        self.btn_close = hbtn("✕", self.on_close, 12)
        self.btn_refresh = hbtn("↻", self.refresh_from_disk, 13)
        self.btn_pin = hbtn("📌", self.toggle_dock, 9)
        self.btn_add = hbtn("＋", self.add_todo_end, 14)
        self.btn_close.pack(side="right", padx=(0, int(6 * s)))
        self.btn_refresh.pack(side="right")
        self.btn_pin.pack(side="right")
        self.btn_add.pack(side="right")

        for w in (hdr, self.lbl_title):
            w.bind("<Button-1>", self._drag_press, add="+")
            w.bind("<B1-Motion>", self._drag_move, add="+")
            w.bind("<ButtonRelease-1>", lambda e: self.save_config(), add="+")
            w.bind("<Button-3>", self.menu_title, add="+")

        # --- 清单区 ---
        self.canvas = tk.Canvas(self.shell, bg=C_BG, highlightthickness=0,
                                yscrollincrement=int(26 * s))
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Button-3>", self.menu_blank, add="+")
        self.canvas.bind("<MouseWheel>",
                         lambda e: self.canvas.yview_scroll(int(-e.delta / 120) * 2, "units"),
                         add="+")
        self.list_frame = tk.Frame(self.canvas, bg=C_BG)
        self.canvas.create_window((0, 0), window=self.list_frame, anchor="nw", tags=("inner",))
        self.list_frame.bind("<Configure>",
                             lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", self._on_canvas_configure, add="+")
        self.list_frame.bind("<Button-3>", self.menu_blank, add="+")

        # --- 右下角缩放把手(3 条斜线; 22 DIP 命中区) ---
        gw = int(22 * s)
        self.grip = tk.Canvas(self.shell, width=gw, height=gw, bg=C_BG,
                              highlightthickness=0, cursor="size_nw_se")
        self.grip.place(relx=1.0, rely=1.0, anchor="se", x=-1, y=-1)
        self._paint_grip()
        self.grip.bind("<Enter>", lambda e: self._paint_grip(True), add="+")
        self.grip.bind("<Leave>", lambda e: self._paint_grip(False), add="+")
        self.grip.bind("<Button-1>", self._rs_press, add="+")
        self.grip.bind("<B1-Motion>", self._rs_move, add="+")
        self.grip.bind("<ButtonRelease-1>", lambda e: self.save_config(), add="+")
        self.grip.bind("<Button-3>", self.menu_blank, add="+")

        self._bind_click_outside(root)

        self.root.bind("<Control-z>", self.undo)

    # ---------- 日志 ----------
    def log(self, msg):
        if self.logf:
            self.logf.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))

    def _warn_readonly(self, e):
        """程序目录不可写(常见于解压进 Program Files)时一次性弹窗提示。"""
        if self.ro_warned or self.testing:
            return
        self.ro_warned = True
        try:
            messagebox.showwarning(
                APP_NAME,
                "程序目录不可写，设置和待办改动无法保存：\n%s\n(%s)\n\n"
                "请把整个文件夹移动到可写目录使用（如桌面、D 盘），"
                "不要放在 Program Files 或其他只读位置。" % (APP_DIR, e),
                parent=self.root)
        except Exception:
            pass

    # ---------- 文件读写 ----------
    def stat_now(self):
        try:
            st = os.stat(self.file)
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def read_file(self):
        with open(self.file, "rb") as f:
            data = f.read()
        self.has_bom = data.startswith(b"\xef\xbb\xbf")
        if self.has_bom:
            data = data[3:]
        text = data.decode("utf-8")
        self.nl = "\r\n" if "\r\n" in text else "\n"
        return text

    def write_text(self, content):
        data = (b"\xef\xbb\xbf" if self.has_bom else b"") + content.encode("utf-8")
        tmp = self.file + ".todo_tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, self.file)
        except OSError as e:
            # 程序目录只读(如 Program Files)或文件被占用: 弹窗说明而不是静默丢失
            self._warn_readonly(e)
            self.log("write failed: %s" % e)
            return False
        self.last_seen = self.stat_now()
        return True

    def load_file(self):
        if not os.path.exists(self.file):
            self.show_missing()
            self.log("file missing: %s" % self.file)
            return
        text = self.read_file()
        self.lines = parse_text(text)
        self.last_seen = self.stat_now()
        self.undo_stack = []   # 文件被外部/重新加载, 撤销历史失效
        base = os.path.basename(self.file)
        if base.lower().endswith(".md"):
            base = base[:-3]
        self.lbl_title.config(text=base)
        self.render_list()   # 面板刷新在 render_list 末尾统一跟进
        self.log("loaded %d lines from %s" % (len(self.lines), self.file))

    def refresh_from_disk(self):
        """顶栏 ↻: 先收尾未提交的编辑并落盘(不让它被重载覆盖), 再读回文件。"""
        self._commit_edits()
        if self.save_job:
            self.root.after_cancel(self.save_job)
            self.save_job = None
        if os.path.exists(self.file):
            self.do_save()
        self.load_file()

    def show_missing(self):
        if self.missing_shown:
            return
        self.missing_shown = True
        for w in self.list_frame.winfo_children():
            w.destroy()
        lbl = tk.Label(self.list_frame,
                       text="文件不存在：\n%s\n\n右键 → 「更换文件…」可选择新的文件" % self.file,
                       bg=C_BG, fg=C_NOTE, font=self.f_item, justify="left",
                       wraplength=int(300 * self.s))
        lbl.pack(pady=int(40 * self.s), padx=int(16 * self.s))
        self._bind_wheel_tree(lbl, self.canvas)

    # ---------- 渲染清单 ----------
    def render_list(self):
        y = self.canvas.yview()[0]
        self.close_editor()
        self.missing_shown = False
        for w in self.list_frame.winfo_children():
            w.destroy()
        self.rows = {}
        i = 0
        while i < len(self.lines):
            self.build_row(i, self.lines[i])
            if self.lines[i].kind == "todo":
                i = subtree_end(self.lines, i)   # 待办的整个子块收进详情面板
            else:
                i += 1
        tail = tk.Frame(self.list_frame, bg=C_BG, height=int(28 * self.s))
        tail.pack(fill="x")
        tail.bind("<Button-3>", self.menu_blank, add="+")   # 尾部占位条也是空白处
        self.list_frame.update_idletasks()
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        self.canvas.yview_moveto(y)
        self._update_wrap_for(self.canvas, self.rows)
        self._bind_wheel_tree(self.list_frame, self.canvas)
        self.refresh_panel()   # 主列表是清单渲染的唯一出口, 面板在此统一跟随刷新
        if self.testing:
            for i, ln in enumerate(self.lines):
                if ln.kind == "todo" and i in self.rows:
                    b = self.rows[i]["box"]
                    self.log("todo i=%d checked=%s box screen=%d,%d"
                             % (i, ln.checked, b.winfo_rootx(), b.winfo_rooty()))

    def build_row(self, i, ln):
        s = self.s
        f = self.list_frame
        if ln.kind == "blank":
            sp = tk.Frame(f, bg=C_BG, height=int(8 * s))
            sp.pack(fill="x")
            sp.bind("<Button-3>", self.menu_blank, add="+")
            return
        pad = int(16 * s) + min(ln.indent_units() * int(8 * s), int(160 * s))
        row = tk.Frame(f, bg=C_BG)
        row.pack(fill="x")
        row.bind("<Button-3>", self.menu_blank, add="+")   # 行内边距的空白也算空白处
        info = {"row": row, "lbl": None, "box": None}

        if ln.kind == "header":
            lbl = tk.Label(row, text=ln.text, bg=C_BG, fg=C_HEADFG, font=self.f_head,
                           anchor="w", justify="left")
            lbl.pack(fill="x", padx=(pad, int(10 * s)), pady=(int(8 * s), int(4 * s)))
            info["lbl"], info["pack"], info["font"] = lbl, \
                {"fill": "x", "padx": (pad, int(10 * s)), "pady": (int(8 * s), int(4 * s))}, self.f_head
            info["wrap_pad"] = pad
            lbl.bind("<Double-Button-1>", lambda e, i=i: self.edit_row(i))
            lbl.bind("<Button-3>", lambda e, i=i: self.menu_row(e, i))
        else:
            if ln.kind == "todo":
                box = tk.Canvas(row, width=int(18 * s), height=int(18 * s),
                                bg=C_BG, highlightthickness=0, cursor="hand2")
                box.pack(side="left", padx=(pad, int(8 * s)), pady=int(4 * s))
                self.draw_box(box, ln.checked)
                box.bind("<Button-1>", lambda e, i=i: self.toggle_line(i))
                box.bind("<Button-3>", lambda e, i=i: self.menu_row(e, i))
                info["box"] = box
                # 子树徽标「✓2/5 📝3」: 递归统计整棵子树, 点按打开详情面板
                td, dn, nt = subtree_stats(self.lines, i)
                if td or nt:
                    badge = self._make_badge(row, td, dn, nt)
                    badge.pack(side="right", padx=(0, int(12 * s)))
                    badge.bind("<Button-1>", lambda e, i=i: self.open_panel(i))
                    info["badge"] = badge
                    # todo 行 wrap_pad=pad+勾选框(18s+8s), 再加实测徽标宽+右边距
                    info["wrap_pad"] = pad + int(18 * s) + int(8 * s) \
                        + badge.badge_width + int(12 * s)
            elif ln.kind == "note":
                pad += int(16 * s)
            font = (self.f_item_done if ln.checked else self.f_item) \
                if ln.kind == "todo" else \
                (self.f_note_done if ln.checked else self.f_note)
            fg = (C_DONE if ln.checked else C_TEXT) if ln.kind == "todo" else \
                 (C_DONE if ln.checked else C_NOTE_T)
            if ln.kind == "other":
                fg = C_TEXT
                font = self.f_item
            # 普通注释行渲染出无序列表圆点(仅显示用, 不写入文件)
            text_disp = ("• " + ln.text) if ln.kind == "note" else ln.text
            lbl = tk.Label(row, text=text_disp, bg=C_BG, fg=fg, font=font,
                           anchor="w", justify="left")
            info["wrap_pad"] = pad if ln.kind != "todo" \
                else pad + int(18 * s) + int(8 * s)
            lbl.pack(side="left", fill="x", expand=True,
                     padx=(0 if ln.kind == "todo" else pad, int(12 * s)), pady=int(2 * s))
            info["lbl"] = lbl
            info["font"] = font
            info["pack"] = {"side": "left", "fill": "x", "expand": True,
                            "padx": (0 if ln.kind == "todo" else pad, int(12 * s)),
                            "pady": int(2 * s)}
            if ln.kind == "todo":
                # 双击待办 = 打开详情面板(内联改名改走右键菜单的「编辑」)
                lbl.bind("<Double-Button-1>", lambda e, i=i: self.open_panel(i))
            else:
                lbl.bind("<Double-Button-1>", lambda e, i=i: self.edit_row(i))
            lbl.bind("<Button-3>", lambda e, i=i: self.menu_row(e, i))
        self._bind_row_hover(row, (info.get("lbl"), info.get("box"), info.get("badge")))
        self.rows[i] = info

    def draw_box(self, canvas, checked):
        s = self.s
        canvas.delete("all")
        a, b = int(2 * s), int(16 * s)
        if checked:
            canvas.create_rectangle(a, a, b, b, fill=C_ACCENT, outline=C_ACCENT)
            canvas.create_line(int(5 * s), int(9 * s), int(8 * s), int(12 * s),
                               fill="white", width=2, capstyle="round", joinstyle="round")
            canvas.create_line(int(8 * s), int(12 * s), int(13 * s), int(5 * s),
                               fill="white", width=2, capstyle="round", joinstyle="round")
        else:
            canvas.create_rectangle(a, a, b, b, outline=C_BOX, width=max(1, int(1 * s)))

    def _paint_grip(self, hover=False):
        c = self.grip
        c.delete("all")
        s = self.s
        col = "#8B95A1" if hover else C_GRIP
        width = max(1, int(1 * s))
        size = int(14 * s)
        for d in (int(2 * s), int(6 * s), int(10 * s)):
            c.create_line(size - d, size, size, size - d,
                          fill=col, width=width, capstyle="round")

    def _bind_row_hover(self, row, widgets):
        """行 hover/pressed: 同一行的 Frame/Label/Canvas 一起换底色。"""
        ws = [row] + [w for w in widgets if w is not None]

        def tint(color):
            for w in ws:
                try:
                    w.configure(bg=color)
                except tk.TclError:
                    pass

        for w in ws:
            w.bind("<Enter>", lambda e: tint(C_HOVER), add="+")
            w.bind("<Leave>", lambda e: tint(C_BG), add="+")
            w.bind("<ButtonPress-1>", lambda e: tint(C_PRESS), add="+")
            w.bind("<ButtonRelease-1>", lambda e: tint(C_HOVER), add="+")

    def _make_badge(self, parent, td, dn, nt):
        """子树徽标: 勾/页图标用线条画, 数字用正文字体, 不再依赖 emoji 回退字形。"""
        s = self.s
        f = self.f_btn
        icon = int(10 * s)
        gap = int(4 * s)
        mid = int(8 * s)
        t1 = ("%d/%d" % (dn, td)) if td else ""
        t2 = ("%d" % nt) if nt else ""
        w = 0
        if t1:
            w += icon + gap + f.measure(t1)
        if t1 and t2:
            w += mid
        if t2:
            w += icon + gap + f.measure(t2)
        w = max(w, 1)
        h = int(18 * s)
        c = tk.Canvas(parent, width=w, height=h, bg=C_BG,
                      highlightthickness=0, cursor="hand2")
        y = h // 2
        x = 0
        if t1:
            self._badge_check(c, x, y)
            c.create_text(x + icon + gap, y, text=t1, anchor="w",
                          font=f, fill=C_NOTE)
            x += icon + gap + f.measure(t1)
        if t1 and t2:
            x += mid
        if t2:
            self._badge_note(c, x, y)
            c.create_text(x + icon + gap, y, text=t2, anchor="w",
                          font=f, fill=C_NOTE)
        c.badge_width = w
        return c

    def _badge_check(self, c, x, y):
        s = self.s
        width = max(1, int(1 * s))
        c.create_line(x + int(1 * s), y, x + int(4 * s), y + int(3 * s),
                      x + int(9 * s), y - int(4 * s),
                      fill=C_NOTE, width=width, capstyle="round", joinstyle="round")

    def _badge_note(self, c, x, y):
        s = self.s
        width = max(1, int(1 * s))
        c.create_rectangle(x + int(1 * s), y - int(6 * s),
                           x + int(9 * s), y + int(6 * s),
                           outline=C_NOTE, width=width)
        c.create_line(x + int(3 * s), y - int(3 * s),
                      x + int(7 * s), y - int(3 * s), fill=C_NOTE, width=width)
        c.create_line(x + int(3 * s), y,
                      x + int(7 * s), y, fill=C_NOTE, width=width)

    def _bind_wheel_tree(self, w, canvas):
        """把滚轮事件绑到 w 及其所有子件, 滚动指定画布(主列表/面板共用)。"""
        w.bind("<MouseWheel>",
               lambda e: canvas.yview_scroll(int(-e.delta / 120) * 2, "units"), add="+")
        for c in w.winfo_children():
            self._bind_wheel_tree(c, canvas)

    def _on_canvas_configure(self, e):
        self.canvas.itemconfigure("inner", width=e.width)
        self._update_wrap_for(self.canvas, self.rows)

    def _update_wrap_for(self, canvas, rows):
        """按指定窗口宽度给每行文字设置自动换行宽度(主列表/面板共用)。"""
        w = canvas.winfo_width()
        if w <= 10:
            return
        right = int(30 * self.s)
        for info in (rows.values() if isinstance(rows, dict) else rows):
            lbl = info.get("lbl")
            if lbl is not None:
                lbl.configure(wraplength=max(80, int(w - info.get("wrap_pad", 0) - right)))

    # ---------- 编辑操作 ----------
    def toggle_line(self, i):
        ln = self.lines[i]
        self.push_undo()
        toggle_raw(ln)
        self.log("toggle i=%d checked=%s" % (i, ln.checked))
        self.render_list()
        self.schedule_save()

    def edit_row(self, i):
        if self.missing_shown:
            return
        rw = self.rows.get(i)
        if not rw or not rw["lbl"]:
            return
        ln = self.lines[i]
        self.log("edit_row i=%d" % i)
        lbl = rw["lbl"]
        ent = tk.Entry(rw["row"], font=rw.get("font", self.f_item), **ENTRY_STYLE)
        lbl.pack_forget()
        ent.pack(**rw["pack"])
        ent.insert(0, ln.text)
        ent.select_range(0, "end")
        ent.icursor("end")
        ent.focus_set()
        self.edit_entry = ent
        self.edit_index = i

        def commit(event=None):
            if self.edit_entry is not ent:
                return
            val = ent.get()
            self.edit_entry = None
            self.edit_commit = None
            self.push_undo()
            set_line_text(self.lines[i], val)
            self._panel_sync_anchor(i)   # 改的正是面板对应的待办 → 别让面板自毁
            self.render_list()
            self.schedule_save()

        def cancel(event=None):
            if self.edit_entry is not ent:
                return
            self.edit_entry = None
            self.edit_commit = None
            self.render_list()

        self.edit_commit = commit
        ent.bind("<Return>", commit)
        ent.bind("<KP_Enter>", commit)
        ent.bind("<Escape>", cancel)
        ent.bind("<FocusOut>", commit)

    def close_editor(self):
        if self.edit_entry is not None and 0 <= self.edit_index < len(self.lines):
            ent = self.edit_entry
            self.edit_entry = None
            self.edit_commit = None
            try:
                self.push_undo()
                set_line_text(self.lines[self.edit_index], ent.get())
                self._panel_sync_anchor(self.edit_index)
                self.schedule_save()
            except Exception:
                pass

    def _panel_sync_anchor(self, i):
        """就地改动了面板所对应待办的文字后, 同步重定位锚(否则面板会判定目标消失而自毁)。"""
        if self.panel is not None and i == self.panel_todo and 0 <= i < len(self.lines):
            ln = self.lines[i]
            self.panel_anchor = (ln.text, ln.indent_units())

    def _commit_edits(self, exclude=None):
        """提交所有未定稿的内联编辑（点编辑框以外的地方 / 刷新时统一走这里）。"""
        for ent_attr, fn_attr in (("edit_entry", "edit_commit"),
                                  ("p_edit_entry", "p_edit_commit"),
                                  ("p_rename_entry", "p_rename_commit")):
            ent = getattr(self, ent_attr)
            fn = getattr(self, fn_attr)
            if ent is None or fn is None or ent is exclude:
                continue
            try:
                fn()
            except tk.TclError:
                pass

    def _bind_click_outside(self, win):
        """点编辑框以外的任何地方即结束编辑。

        Tk 里 Label/Frame 被点击不会夺焦点, 单靠 <FocusOut> 收不了尾, 所以在顶层
        窗口统一监听 <Button-1>: 事件先由目标控件自己处理, 轮到顶层时再提交;
        用 after_idle 推迟一步, 免得边提交边销毁正要处理本次事件的控件。
        """
        def on_click(event):
            w = event.widget
            if all(getattr(self, a) is None
                   for a in ("edit_entry", "p_edit_entry", "p_rename_entry")):
                return
            self.root.after_idle(lambda: self._commit_edits(w))
        win.bind("<Button-1>", on_click, add="+")

    def insert_line(self, i, kind, indent, text="", edit_after=None, pos=None):
        """在第 i 行之后插入一行（i=-1 表示最前）。

        pos 覆盖插入位置(新行插在其后一行)，例如插到整个子块末尾；
        edit_after 指随后的内联编辑回调，默认主列表 edit_row，面板传 self.p_edit。
        """
        self.push_undo()
        ref = i if pos is None else pos
        if 0 <= ref < len(self.lines) and not self.lines[ref].raw.endswith("\n"):
            self.lines[ref].raw += self.nl
        raw = indent + ("- [ ] " if kind == "todo" else "- ") + text + self.nl
        at = (i if pos is None else pos) + 1
        self.lines.insert(at, parse_line(raw))
        self.render_list()
        self.schedule_save()
        edit = edit_after or self.edit_row
        self.root.after(30, lambda: edit(at))

    def delete_line(self, i):
        """删除第 i 行；待办连同其整个子块一起删除（Ctrl+Z 可撤销）。"""
        if not 0 <= i < len(self.lines):
            return
        self.push_undo()
        ln = self.lines[i]
        if ln.kind == "todo":
            end = subtree_end(self.lines, i)
            if i <= self.edit_index < end:        # 正在编辑的行随子块一起删除
                self.edit_entry = None
            if i <= self.p_edit_index < end:
                self.p_edit_entry = None
            if self.panel is not None and i <= self.panel_todo < end:
                self.close_panel()                # 面板对应的待办被删 → 关面板
            self.lines = delete_subtree(self.lines, i)
        else:
            if self.edit_index == i:
                self.edit_entry = None
            if self.p_edit_index == i:
                self.p_edit_entry = None
            self.lines.pop(i)
        self.render_list()
        self.schedule_save()

    def add_todo_end(self):
        if not os.path.exists(self.file):
            self.lines = []
            self.missing_shown = False
            self.write_text("- [ ] 新待办" + self.nl)
            self.last_seen = self.stat_now()
        if not self.lines:
            self.insert_line(-1, "todo", "", "新待办")
            return
        self.insert_line(len(self.lines) - 1, "todo", "", "新待办")

    # ---------- 分组操作 ----------
    def group_block_end(self, i):
        """第 i 行所在分组块的末尾(下一个分组标题之前的插入位置)。"""
        j = i + 1
        while j < len(self.lines) and self.lines[j].kind != "header":
            j += 1
        return j

    def insert_group(self, i):
        """在第 i 行所属分组之后插入新分组(该分组已有条目不会被划进新分组)。"""
        self.push_undo()
        pos = self.group_block_end(i)
        if 0 <= pos - 1 < len(self.lines) and not self.lines[pos - 1].raw.endswith("\n"):
            self.lines[pos - 1].raw += self.nl
        self.lines.insert(pos, parse_line("**新分组**" + self.nl))
        self.render_list()
        self.schedule_save()
        self.root.after(30, lambda: self.edit_row(pos))

    # ---------- 撤销 ----------
    def push_undo(self):
        """把当前清单内容压入撤销栈(调用时机: 即将修改清单内容之前)。"""
        snap = serialize(self.lines)
        if self.undo_stack and self.undo_stack[-1] == snap:
            return
        self.undo_stack.append(snap)
        if len(self.undo_stack) > 50:
            self.undo_stack.pop(0)

    def undo(self, event=None):
        """Ctrl+Z: 撤回最近一次清单改动(勾选/改字/插入/删除)。"""
        if self.edit_entry is not None or self.p_edit_entry is not None \
                or not self.undo_stack:
            return
        snap = self.undo_stack.pop()
        try:
            self.write_text(snap)
        except Exception as e:
            self.log("undo save failed: %r" % e)
            return
        self.lines = parse_text(snap)
        self.render_list()
        self.log("undo (left %d snapshots)" % len(self.undo_stack))
        return "break"

    # ---------- 保存 ----------
    def schedule_save(self):
        if self.save_job:
            self.root.after_cancel(self.save_job)
        self.save_job = self.root.after(250, self.do_save)

    def do_save(self):
        self.save_job = None
        try:
            if self.write_text(serialize(self.lines)):
                self.log("saved %d lines" % len(self.lines))
        except Exception as e:
            self.log("save failed: %r" % e)
            self.lbl_title.config(text="保存失败!")

    # ---------- 右键菜单 ----------
    def menu_row(self, event, i):
        ln = self.lines[i]
        m = tk.Menu(self.root, tearoff=0, font=self.f_btn)
        if ln.kind == "header":
            m.add_command(label="在此分组添加待办",
                          command=lambda: self.insert_line(i, "todo",
                                                           self._next_todo_indent(i), "新待办"))
            m.add_command(label="在下方插入分组", command=lambda: self.insert_group(i))
            m.add_command(label="重命名分组", command=lambda: self.edit_row(i))
            m.add_command(label="删除分组标题", command=lambda: self.delete_line(i))
        elif ln.kind == "todo":
            m.add_command(label="在下方插入待办",
                          command=lambda: self.insert_line(
                              i, "todo", ln.indent, "新待办",
                              pos=subtree_end(self.lines, i) - 1))  # 插到整块之后, 不把旧子块过继给新待办
            m.add_command(label="打开详情面板", command=lambda: self.open_panel(i))
            m.add_command(label="在下方插入分组", command=lambda: self.insert_group(i))
            m.add_separator()
            m.add_command(label="编辑", command=lambda: self.edit_row(i))
            m.add_command(label="删除", command=lambda: self.delete_line(i))
        elif ln.kind == "note":
            m.add_command(label="在下方插入注释",
                          command=lambda: self.insert_line(i, "note", ln.indent))
            m.add_command(label="在下方插入分组", command=lambda: self.insert_group(i))
            m.add_command(label="编辑", command=lambda: self.edit_row(i))
            m.add_command(label="删除", command=lambda: self.delete_line(i))
        else:
            return
        try:
            m.tk_popup(event.x_root, event.y_root)
        finally:
            m.grab_release()

    # ---------- 详情面板 ----------
    def _panel_locate(self):
        """按锚(待办文字+缩进)重找面板对应待办的行下标；找不到返回 -1。"""
        text, units = self.panel_anchor
        for k, ln in enumerate(self.lines):
            if ln.kind == "todo" and ln.text == text and ln.indent_units() == units:
                return k
        return -1

    def open_panel(self, i):
        """打开待办详情面板(单实例, 新开替换旧的)。"""
        ln = self.lines[i]
        self.close_panel()
        self.panel_anchor = (ln.text, ln.indent_units())
        self.panel_todo = i
        s = self.s
        win = self.panel = tk.Toplevel(self.root)
        win.configure(bg=C_HAIRLINE)
        shell = tk.Frame(win, bg=C_BG)
        shell.pack(fill="both", expand=True, padx=1, pady=1)
        # 无边框: 隐藏 Windows 原生标题栏(用户反馈其与自绘标题行重复),
        # 面板只保留下方自绘标题行; 位置由 panel_pos 决定, 无系统拖动需求。
        # overrideredirect 必须在映射前设置, 映射后再切会闪现原生边框。
        win.overrideredirect(True)
        # 不用 transient(owner 关系): poll 贴桌面的 SetWindowPos(HWND_BOTTOM)
        # 会把 owned 面板一起拖下水并剥掉 TOPMOST 位(Windows owned 链重排)。
        # 面板保持独立顶层窗口, 不进任务栏/Alt+Tab 由下方 set_toolwindow 保证。
        # TOOLWINDOW 样式须在映射后再写: 去掉 transient 后 Tk 会在映射时
        # 按 wm 状态重算 exstyle, 映射前的 Win32 写入会被洗掉 → 进任务栏。
        def _apply_toolwindow(_e=None):
            try:
                set_toolwindow(win)
            except Exception:
                pass
        _apply_toolwindow()
        win.bind("<Map>", _apply_toolwindow, add="+")
        # 浮在其他窗口之上(用户要求面板始终可见); 主挂件仍贴桌面底层不受影响
        try:
            win.attributes("-topmost", True)
        except Exception:
            pass
        win.geometry("%dx%d+%d+%d" % (int(420 * s), int(520 * s),
                     *panel_pos(self.root.winfo_x(), self.root.winfo_y(),
                                self.root.winfo_width(), int(420 * s), int(520 * s),
                                *virtual_screen(), int(12 * s))))
        win.protocol("WM_DELETE_WINDOW", self.close_panel)
        win.bind("<Escape>", lambda e: self.close_panel())
        self.log("panel open i=%d" % i)

        # 标题栏: 待办文字(双击改名) + 关闭
        hdr = tk.Frame(shell, bg=C_HEADER, height=int(34 * s))
        hdr.pack(fill="x", side="top")
        hdr.pack_propagate(False)
        self.p_title_pack = {"side": "left", "fill": "x", "expand": True,
                             "padx": (int(12 * s), int(4 * s)), "pady": int(4 * s)}
        self.p_title_lbl = tk.Label(hdr, text=ln.text, bg=C_HEADER, fg=C_TEXT,
                                    font=self.f_head, anchor="w")
        self.p_title_lbl.pack(**self.p_title_pack)
        self.p_title_lbl.bind("<Double-Button-1>", lambda e: self.p_rename())
        xb = tk.Label(hdr, text="✕", bg=C_HEADER, fg="#5A6472", font=self.f_btn,
                      padx=int(7 * s), cursor="hand2")
        xb.pack(side="right", padx=(0, int(6 * s)))
        xb.bind("<Button-1>", lambda e: self.close_panel())
        xb.bind("<Enter>", lambda e: xb.configure(bg=C_BTN_HOVER), add="+")
        xb.bind("<Leave>", lambda e: xb.configure(bg=C_HEADER), add="+")
        xb.bind("<ButtonPress-1>", lambda e: xb.configure(bg=C_BTN_PRESS), add="+")
        xb.bind("<ButtonRelease-1>", lambda e: xb.configure(bg=C_BTN_HOVER), add="+")
        p_rule = tk.Frame(shell, bg=C_RULE, height=1)
        p_rule.pack(fill="x", side="top")

        # 内容区: 上下两栏各占一半, 各自独立滚动
        # 上栏 = 子待办 + 左下角「添加子待办」; 下栏 = 备注 + 左下角「添加备注」
        # 用 grid + uniform 保证两栏严格 1:1(用 pack 时按各自请求高度分剩余空间, 内容多的那栏会更高)
        body = tk.Frame(shell, bg=C_BG)
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=1)
        body.rowconfigure(0, weight=1, uniform="pane")
        body.rowconfigure(2, weight=1, uniform="pane")
        self.p_todo_canvas, self.p_todo_frame = self._p_make_pane(body, True, 0)
        sep = tk.Frame(body, bg=C_RULE, height=1)
        sep.grid(row=1, column=0, sticky="ew")
        self.p_note_canvas, self.p_note_frame = self._p_make_pane(body, False, 2)
        for canvas, frame in ((self.p_todo_canvas, self.p_todo_frame),
                              (self.p_note_canvas, self.p_note_frame)):
            frame.bind("<Configure>",
                       lambda e, c=canvas: c.configure(scrollregion=c.bbox("all")))
            canvas.bind("<Configure>", lambda e, c=canvas: (
                c.itemconfigure("pinner", width=e.width), self._p_update_wrap()), add="+")
        self._bind_click_outside(win)   # 点面板里编辑框以外的地方也结束编辑

        self.render_panel()

    def _p_make_pane(self, parent, is_todo, row):
        """建面板的一栏: 左下角添加按钮 + 可滚动的行容器。返回 (画布, 行容器)。

        按钮先 pack 到 side=bottom, 内容再 fill 剩余空间, 保证按钮始终可见;
        栏本体用 grid 放进 body 的 row 行(行权重+uniform 由调用方设置)。
        """
        s = self.s
        pane = tk.Frame(parent, bg=C_BG)
        pane.grid(row=row, column=0, sticky="nsew")
        bar = tk.Frame(pane, bg=C_BG)
        bar.pack(fill="x", side="bottom")
        add = tk.Label(bar, text="＋ 添加子待办" if is_todo else "＋ 添加备注",
                       bg=C_BG, fg=C_ACCENT, font=self.f_btn,
                       cursor="hand2", padx=int(16 * s), pady=int(8 * s))
        add.pack(side="left")
        add.bind("<Button-1>", lambda e: (self.p_add_todo() if is_todo
                                          else self.p_add_note()))
        add.bind("<Enter>", lambda e: add.configure(bg=C_HOVER), add="+")
        add.bind("<Leave>", lambda e: add.configure(bg=C_BG), add="+")
        add.bind("<ButtonPress-1>", lambda e: add.configure(bg=C_PRESS), add="+")
        add.bind("<ButtonRelease-1>", lambda e: add.configure(bg=C_HOVER), add="+")
        canvas = tk.Canvas(pane, bg=C_BG, highlightthickness=0,
                           yscrollincrement=int(26 * s))
        canvas.pack(fill="both", expand=True)
        frame = tk.Frame(canvas, bg=C_BG)
        canvas.create_window((0, 0), window=frame, anchor="nw", tags=("pinner",))
        return canvas, frame

    def close_panel(self):
        if self.panel is None:
            return
        win = self.panel
        self.panel = None
        self.panel_todo = -1
        self.p_rows = {}
        self.p_todo_infos = []
        self.p_note_infos = []
        self.p_edit_entry = None
        self.p_edit_index = -1
        self.p_edit_commit = None
        self.p_rename_entry = None
        self.p_rename_commit = None
        self.p_title_lbl = None
        try:
            win.destroy()
        except Exception:
            pass
        self.log("panel closed")

    def refresh_panel(self):
        """清单变化后面板跟随重渲染；对应待办被删则关闭面板。"""
        if self.panel is not None:
            self.render_panel()

    def _p_update_wrap(self):
        """两栏各自按自己画布的宽度重新计算换行宽度。"""
        self._update_wrap_for(self.p_todo_canvas, self.p_todo_infos)
        self._update_wrap_for(self.p_note_canvas, self.p_note_infos)

    def render_panel(self):
        if self.panel is None:
            return
        i = self._panel_locate()
        if i < 0:
            self.log("panel target gone -> close")
            self.close_panel()
            return
        self.panel_todo = i
        self._p_close_editor()
        self._p_restore_title()
        ln = self.lines[i]
        self.p_title_lbl.config(text=ln.text)
        try:
            self.panel.title(ln.text)
        except Exception:
            pass
        y1 = self.p_todo_canvas.yview()[0]
        y2 = self.p_note_canvas.yview()[0]
        for frame in (self.p_todo_frame, self.p_note_frame):
            for w in frame.winfo_children():
                w.destroy()
        self.p_rows = {}
        self.p_todo_infos = []
        self.p_note_infos = []
        todos, notes = panel_parts(self.lines, i)
        for j in todos:
            self.p_build_row(j, self.p_todo_frame, self.p_todo_infos)
        for j in notes:
            self.p_build_row(j, self.p_note_frame, self.p_note_infos)
        for frame, canvas, y in ((self.p_todo_frame, self.p_todo_canvas, y1),
                                 (self.p_note_frame, self.p_note_canvas, y2)):
            frame.update_idletasks()
            canvas.configure(scrollregion=canvas.bbox("all"))
            canvas.yview_moveto(y)
            self._bind_wheel_tree(frame, canvas)
        self._p_update_wrap()

    def p_build_row(self, j, frame, infos):
        """面板一行: 全部顶格（不再按层级缩进）; 备注留显示用圆点, 不写回文件。"""
        s = self.s
        ln = self.lines[j]
        pad = int(12 * s)
        row = tk.Frame(frame, bg=C_BG)
        row.pack(fill="x")
        info = {"row": row, "lbl": None, "box": None}

        if ln.kind == "todo":
            box = tk.Canvas(row, width=int(18 * s), height=int(18 * s),
                            bg=C_BG, highlightthickness=0, cursor="hand2")
            box.pack(side="left", padx=(pad, int(8 * s)), pady=int(4 * s))
            self.draw_box(box, ln.checked)
            box.bind("<Button-1>", lambda e, j=j: self.toggle_line(j))
            box.bind("<Button-3>", lambda e, j=j: self.p_menu(e, j))
            info["box"] = box
        font = (self.f_item_done if ln.checked else self.f_item) \
            if ln.kind == "todo" else \
            (self.f_note_done if ln.checked else self.f_note)
        fg = (C_DONE if ln.checked else C_TEXT) if ln.kind == "todo" else \
             (C_DONE if ln.checked else C_NOTE_T)
        if ln.kind == "other":
            fg = C_TEXT
            font = self.f_item
        text_disp = ("• " + ln.text) if ln.kind == "note" else ln.text
        lbl = tk.Label(row, text=text_disp, bg=C_BG, fg=fg, font=font,
                       anchor="w", justify="left")
        info["wrap_pad"] = pad + (int(18 * s) + int(8 * s) if ln.kind == "todo" else 0)
        lbl.pack(side="left", fill="x", expand=True,
                 padx=(0 if ln.kind == "todo" else pad, int(12 * s)), pady=int(2 * s))
        info["lbl"] = lbl
        info["font"] = font
        info["pack"] = {"side": "left", "fill": "x", "expand": True,
                        "padx": (0 if ln.kind == "todo" else pad, int(12 * s)),
                        "pady": int(2 * s)}
        lbl.bind("<Double-Button-1>", lambda e, j=j: self.p_edit(j))
        lbl.bind("<Button-3>", lambda e, j=j: self.p_menu(e, j))
        self._bind_row_hover(row, (lbl, info.get("box")))
        self.p_rows[j] = info
        infos.append(info)

    def p_edit(self, j):
        if self.panel is None:
            return
        rw = self.p_rows.get(j)
        if not rw or not rw["lbl"]:
            return
        ln = self.lines[j]
        lbl = rw["lbl"]
        ent = tk.Entry(rw["row"], font=rw.get("font", self.f_item), **ENTRY_STYLE)
        lbl.pack_forget()
        ent.pack(**rw["pack"])
        ent.insert(0, ln.text)
        ent.select_range(0, "end")
        ent.icursor("end")
        ent.focus_set()
        self.p_edit_entry = ent
        self.p_edit_index = j

        def commit(event=None):
            if self.p_edit_entry is not ent:
                return "break"
            val = ent.get()
            self.p_edit_entry = None
            self.p_edit_commit = None
            self.push_undo()
            set_line_text(self.lines[j], val)
            self.render_list()
            self.schedule_save()
            return "break"

        def cancel(event=None):
            if self.p_edit_entry is not ent:
                return "break"
            self.p_edit_entry = None
            self.p_edit_commit = None
            self.render_panel()
            return "break"  # 不传给面板级 <Escape>(否则取消编辑会连面板一起关)

        self.p_edit_commit = commit
        ent.bind("<Return>", commit)
        ent.bind("<KP_Enter>", commit)
        ent.bind("<Escape>", cancel)
        ent.bind("<FocusOut>", commit)

    def _p_close_editor(self):
        """提交面板里未定稿的内联编辑(不触发重渲染)。"""
        if self.p_edit_entry is not None and 0 <= self.p_edit_index < len(self.lines):
            ent = self.p_edit_entry
            self.p_edit_entry = None
            self.p_edit_commit = None
            try:
                self.push_undo()
                set_line_text(self.lines[self.p_edit_index], ent.get())
                self.schedule_save()
            except Exception:
                pass

    def p_rename(self):
        """双击面板标题栏: 内联 Entry 改根待办文字。"""
        i = self.panel_todo
        if not 0 <= i < len(self.lines) or self.p_rename_entry is not None:
            return
        lbl = self.p_title_lbl
        ent = tk.Entry(lbl.master, font=self.f_head, **ENTRY_STYLE)
        lbl.pack_forget()
        ent.pack(side="left", fill="x", expand=True,
                 padx=self.p_title_pack["padx"], pady=self.p_title_pack["pady"],
                 ipady=int(2 * self.s))
        ent.insert(0, self.lines[i].text)
        ent.select_range(0, "end")
        ent.icursor("end")
        ent.focus_set()
        self.p_rename_entry = ent

        def commit(event=None):
            if self.p_rename_entry is not ent:
                return "break"
            val = ent.get()
            # 先销毁 Entry 并恢复标题(若先清状态再调, _p_restore_title 会跳过
            # destroy 导致 Entry 泄漏在标题栏, 与标题共存)
            self._p_restore_title()
            self.p_rename_commit = None
            self.push_undo()
            set_line_text(self.lines[i], val)
            # 同步重定位锚, 否则改名后 _panel_locate 找不到行 → 面板自毁
            self.panel_anchor = (self.lines[i].text, self.lines[i].indent_units())
            self.render_list()
            self.schedule_save()
            return "break"

        def cancel(event=None):
            if self.p_rename_entry is not ent:
                return "break"
            self.p_rename_commit = None
            self._p_restore_title()
            return "break"  # 不传给面板级 <Escape>(否则取消改名会连面板一起关)

        self.p_rename_commit = commit
        ent.bind("<Return>", commit)
        ent.bind("<KP_Enter>", commit)
        ent.bind("<Escape>", cancel)
        ent.bind("<FocusOut>", commit)

    def _p_restore_title(self):
        if self.p_rename_entry is not None:
            try:
                self.p_rename_entry.destroy()
            except Exception:
                pass
            self.p_rename_entry = None
        self.p_rename_commit = None
        if self.p_title_lbl is not None:
            try:
                self.p_title_lbl.pack(**self.p_title_pack)
            except Exception:
                pass

    def p_menu(self, event, j):
        """面板行右键: 子待办是叶子, 只有编辑与删除。"""
        ln = self.lines[j]
        if ln.kind not in ("todo", "note", "other"):
            return
        m = tk.Menu(self.panel, tearoff=0, font=self.f_btn)
        m.add_command(label="编辑", command=lambda: self.p_edit(j))
        m.add_command(label="删除", command=lambda: self.delete_line(j))
        try:
            m.tk_popup(event.x_root, event.y_root)
        finally:
            m.grab_release()

    def p_add_todo(self):
        """在子待办区末尾加一条子待办(纯叶子), 并立即进入内联编辑。"""
        i = self.panel_todo
        if not 0 <= i < len(self.lines):
            return
        todos, _ = panel_parts(self.lines, i)
        pos = todos[-1] if todos else i   # 没有子待办时紧跟根待办
        self.insert_line(pos, "todo", child_indent(self.lines[i]), "新待办",
                         edit_after=self.p_edit)

    def p_add_note(self):
        """把一条新备注追加到子块末尾, 并立即进入内联编辑。"""
        i = self.panel_todo
        if not 0 <= i < len(self.lines):
            return
        pos = subtree_end(self.lines, i) - 1   # 子块最后一行(块为空时即根待办自身)
        self.insert_line(pos, "note", child_indent(self.lines[i]), "",
                         edit_after=self.p_edit)

    def _next_todo_indent(self, i):
        """分组标题后的第一条待办缩进：跟随已有的下一条待办，否则顶格。"""
        for j in range(i + 1, len(self.lines)):
            if self.lines[j].kind == "todo":
                return self.lines[j].indent
            if self.lines[j].kind in ("header", "blank"):
                break
        return ""

    def menu_blank(self, event):
        """空白处右键: 列表尾部/行内边距/两行之间的空隙/标题栏空白/缩放把手。"""
        m = tk.Menu(self.root, tearoff=0, font=self.f_btn)
        m.add_command(label="在末尾添加待办", command=self.add_todo_end)
        m.add_command(label="在末尾添加分组",
                      command=lambda: self.insert_group(len(self.lines) - 1))
        m.add_separator()
        m.add_command(label="退出", command=self.on_close)
        try:
            m.tk_popup(event.x_root, event.y_root)
        finally:
            m.grab_release()

    def menu_title(self, event):
        """标题栏右键: 只剩文件相关的三项。"""
        m = tk.Menu(self.root, tearoff=0, font=self.f_btn)
        m.add_command(label="更换文件…", command=self.choose_file)
        m.add_command(label="打开文件位置", command=self.open_file_location)
        m.add_separator()
        m.add_command(label="退出", command=self.on_close)
        try:
            m.tk_popup(event.x_root, event.y_root)
        finally:
            m.grab_release()

    def choose_file(self):
        init = os.path.dirname(self.file) if os.path.exists(self.file) else APP_DIR
        path = filedialog.askopenfilename(
            title="选择待办 Markdown 文件", parent=self.root, initialdir=init,
            filetypes=[("Markdown 文件", "*.md"), ("所有文件", "*.*")])
        if path:
            self.file = path
            self.missing_shown = False
            self.load_file()
            self.save_config()

    def open_file_location(self):
        """在资源管理器中打开待办文件所在目录并选中该文件。"""
        path = os.path.normpath(self.file)
        try:
            if os.path.exists(path):
                # canonical 形式: explorer /select,"路径" (整个作为一条命令行传给 explorer)
                subprocess.Popen('explorer /select,"%s"' % path)
                self.log("open location: %s" % path)
            elif os.path.isdir(os.path.dirname(path)):
                subprocess.Popen('explorer "%s"' % os.path.dirname(path))
                self.log("open dir (file missing): %s" % os.path.dirname(path))
            else:
                messagebox.showinfo(APP_NAME, "文件和目录都不存在：\n%s" % path,
                                    parent=self.root)
        except Exception as e:
            self.log("open location failed: %r" % e)
            messagebox.showinfo(APP_NAME, "打开失败：%s" % e, parent=self.root)

    def toggle_dock(self):
        if self.docked:
            self.docked = False
            self.root.attributes("-topmost", True)
            self.root.lift()
        else:
            self.docked = True
            self.root.attributes("-topmost", False)
            send_above_desktop(self.root)
        self._update_pin()
        self.save_config()

    def _update_pin(self):
        """钉住图标: 悬浮置顶时点亮(蓝字浅蓝底), 贴桌面时回到常态灰。"""
        lit = not self.docked
        self.btn_pin.lit = lit
        try:
            self.btn_pin.config(bg="#DCE9FA" if lit else C_HEADER)
            self.btn_pin.itemconfigure(self.btn_pin.glyph,
                                       fill=C_ACCENT if lit else "#5A6472")
        except tk.TclError:
            pass

    # ---------- 外部变化轮询 ----------
    def poll(self):
        try:
            # 桌面模式: 维持"桌面之上、其他窗口之下"的贴桌面状态
            if self.docked:
                if is_iconic(self.root):
                    # Win+D / 全部最小化会把本窗口也最小化, 立即还原, 保持桌面可见
                    self.root.deiconify()
                    send_above_desktop(self.root)
                    self.log("restored from Win+D minimize")
                elif not is_foreground(self.root) and not at_desktop_level(self.root):
                    send_above_desktop(self.root)
            # 窗口被拖到屏幕外(拖过头/显示器热插拔/改分辨率)则拉回虚拟屏幕内
            self._panel_restore_topmost()
            if not is_iconic(self.root):
                wx, wy = self.root.winfo_x(), self.root.winfo_y()
                nx, ny = clamp_pos(wx, wy,
                                   self.root.winfo_width(), self.root.winfo_height(),
                                   *virtual_screen())
                if (nx, ny) != (wx, wy):
                    self.root.geometry("+%d+%d" % (nx, ny))
                    self.log("window off-screen -> rescued to %d,%d" % (nx, ny))
            cur = self.stat_now()
            if cur is None:
                if not self.missing_shown:
                    self.show_missing()
                    self.log("file disappeared")
                self.last_seen = None
            elif cur != self.last_seen:
                self.last_seen = cur
                self.log("external change -> reload")
                self.load_file()
        except Exception as e:
            self.log("poll error: %r" % e)
        self.root.after(1000, self.poll)

    # ---------- 窗口拖动/缩放 ----------
    def _panel_restore_topmost(self):
        """详情面板 WS_EX_TOPMOST 被系统剥除时的兜底自愈(幂等, 每 poll 一发)。

        Win32 层直读样式位: Tk 的 attributes('-topmost') 是内部状态,
        Win32 位被剥时它仍返回 True, 不可信。
        """
        if self.panel is None:
            return
        hwnd = toplevel_hwnd(self.panel)
        if not hwnd or (user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST):
            return
        try:
            self.panel.attributes("-topmost", True)
        except Exception:
            return
        self.log("panel topmost stripped by system -> restored")

    def set_pos(self, sx, sy):
        """以屏幕坐标设置窗口位置（嵌入模式下换算为父窗口坐标）。"""
        self.root.geometry("+%d+%d" % (sx - self._pox, sy - self._poy))

    def get_pos(self):
        """返回窗口位置的屏幕坐标。"""
        return (self.root.winfo_x() + self._pox, self.root.winfo_y() + self._poy)

    def _drag_press(self, e):
        self._dx = e.x_root - self.get_pos()[0]
        self._dy = e.y_root - self.get_pos()[1]

    def _drag_move(self, e):
        self.set_pos(e.x_root - self._dx, e.y_root - self._dy)

    def _rs_press(self, e):
        self._rw, self._rh = self.root.winfo_width(), self.root.winfo_height()
        self._mx, self._my = e.x_root, e.y_root

    def _rs_move(self, e):
        w = max(int(260 * self.s), self._rw + e.x_root - self._mx)
        h = max(int(180 * self.s), self._rh + e.y_root - self._my)
        self.root.geometry("%dx%d+%d+%d" % (w, h,
                                            self.root.winfo_x(), self.root.winfo_y()))

    # ---------- 配置/退出 ----------
    def save_config(self):
        if self.testing:
            return
        cfg = {"file": self.file,
               "x": self.get_pos()[0], "y": self.get_pos()[1],
               "w": self.root.winfo_width(), "h": self.root.winfo_height(),
               "docked": self.docked}
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=1)
        except OSError as e:
            self._warn_readonly(e)

    def on_close(self):
        try:
            self._commit_edits()
            self.close_panel()
            if self.save_job:
                self.root.after_cancel(self.save_job)
                self.save_job = None
            self.do_save()
        except Exception:
            pass
        self.save_config()
        self.log("exit")
        if self.logf:
            self.logf.close()
        try:
            self.root.destroy()
        except Exception:
            pass


def _set_dpi_awareness():
    """优先 PerMonitorV2, 失败退回 system-aware。

    Tk 8.6 不处理 WM_DPICHANGED, 窗口跨不同缩放屏时像素尺寸不变; PMv2 至少让
    新窗口按目标屏 DPI 渲染, 不再整窗位图拉伸(旧版 system-aware 的主要模糊源)。
    """
    try:
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return "pmv2"
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
        return "system"
    except Exception:
        return "none"


def main():
    if TEST_MODE:
        file_path = sys.argv[1]
        cfg = {}
    else:
        cfg = {}
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, encoding="utf-8") as f:
                    cfg = json.load(f)
            except Exception:
                cfg = {}
        file_path = cfg.get("file") or DEFAULT_FILE
        if not os.path.isabs(file_path):
            file_path = os.path.join(APP_DIR, file_path)

    # 单实例保护
    k32 = ctypes.windll.kernel32
    # 启动器/终端可能留下 183 的 last error, 先清零再建互斥体, 否则会误判已有实例
    k32.SetLastError(0)
    k32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        sys.exit(0)

    awareness = _set_dpi_awareness()

    root = tk.Tk()
    app = App(root, file_path)
    app.log("dpi awareness: %s" % awareness)

    s = app.s
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()  # 物理像素

    # argv[2] = "float" 悬浮置顶测试模式; argv[2] = "x,y" 指定桌面位置的测试模式(物理像素)
    test_pos = None
    want_dock = cfg.get("docked", True)
    if app.testing and len(sys.argv) > 2:
        if sys.argv[2] == "float":
            want_dock = False
        else:
            try:
                test_pos = tuple(int(v) for v in sys.argv[2].split(","))
            except ValueError:
                test_pos = None

    if app.testing:
        x = test_pos[0] if test_pos else int(100 * s)
        y = test_pos[1] if test_pos else int(100 * s)
        w, h = int(430 * s), int(660 * s)
    else:
        # config.json 里存的是物理像素; 首次运行按 DPI 缩放给出默认位置(主屏右侧)
        w = min(int(cfg["w"]), sw - 20) if "w" in cfg else int(380 * s)
        h = min(int(cfg["h"]), sh - 60) if "h" in cfg else int(640 * s)
        if "x" in cfg:
            x, y = int(cfg["x"]), int(cfg["y"])
        else:
            x = sw - w - int(40 * s)
            y = int(100 * s)
        w = max(int(260 * s), w)
        h = max(int(180 * s), h)
        # 夹回虚拟屏幕(全部显示器)内, 防止存档坐标落在屏外
        x, y = clamp_pos(x, y, w, h, *virtual_screen())
    root.geometry("%dx%d+%d+%d" % (w, h, x, y))
    root.update_idletasks()

    root.attributes("-topmost", True)   # 悬浮模式保持置顶; 桌面模式随后取消
    set_toolwindow(root)                # 两种模式都不进任务栏/Alt+Tab
    root.deiconify()
    root.update()                       # 完成映射与首帧绘制

    if want_dock:
        app.docked = True
        root.attributes("-topmost", False)
        send_above_desktop(root)
        app.log("desktop mode: hwnd=%s" % toplevel_hwnd(root))
    app._update_pin()                    # 顶栏钉住图标反映 config 里的 docked
    app.load_file()
    root.protocol("WM_DELETE_WINDOW", app.on_close)
    app.poll()
    root.mainloop()


if __name__ == "__main__":
    main()
