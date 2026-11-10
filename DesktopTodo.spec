# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec: DesktopTodo onedir 绿色便携版。

构建:  py -3.12 -m PyInstaller DesktopTodo.spec --noconfirm --clean
产物:  dist/DesktopTodo/  (DesktopTodo.exe + _internal/)
用户侧语义: config.json 与 待办.md 始终放 exe 旁边(todo.pyw 的 _base_dir 保证)。
"""
import os

APP_NAME = "DesktopTodo"

a = Analysis(
    ["todo.pyw"],
    pathex=[SPECPATH],
    binaries=[],
    # 模板配置随包分发(仅供用户参考复制; 应用只读写 exe 旁的 config.json)
    datas=[("config.example.json", ".")],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 应用只用 ctypes/json/os/re/subprocess/sys/time/tkinter;
    # 这些标准库大件确认不可达, 排除瘦身(冒烟与测试会兜底验证)
    excludes=[
        "unittest", "pydoc_data", "test", "asyncio", "concurrent",
        "email", "http", "xml", "sqlite3", "multiprocessing", "curses",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,       # onedir: DLL 归 COLLECT, 不塞进 exe
    name=APP_NAME,
    debug=False,
    strip=False,
    upx=False,                   # 压缩会提高杀软误报率, 不用
    console=False,               # .pyw 语义: 无控制台窗口
    icon="assets/app.ico",
    version="packaging/version_info.txt",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name=APP_NAME,
)
