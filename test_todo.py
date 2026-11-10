# -*- coding: utf-8 -*-
"""todo.pyw 路径解析单元测试: 源码运行与冻结(exe)两种模式。

运行:
    py -3.12 -m unittest test_todo -v
    python -m unittest test_todo -v
只用标准库, 与项目零依赖约定一致。
"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TODO_PYW = os.path.join(HERE, "todo.pyw")


def load_todo():
    """把 todo.pyw 当普通模块加载: 模块名不是 __main__, 不会启动 GUI。"""
    spec = importlib.util.spec_from_file_location("todo_under_test", TODO_PYW)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class BaseDirTest(unittest.TestCase):
    def setUp(self):
        self._had_frozen = hasattr(sys, "frozen")
        self._old_frozen = getattr(sys, "frozen", None)
        self._old_exe = sys.executable

    def tearDown(self):
        if self._had_frozen:
            sys.frozen = self._old_frozen
        elif hasattr(sys, "frozen"):
            del sys.frozen
        sys.executable = self._old_exe

    def test_dev_mode_uses_source_dir(self):
        """没冻结时 APP_DIR = todo.pyw 所在目录。"""
        mod = load_todo()
        self.assertEqual(mod.APP_DIR, HERE)
        self.assertEqual(mod.CONFIG_PATH, os.path.join(HERE, "config.json"))
        self.assertEqual(mod.DEFAULT_FILE, os.path.join(HERE, "待办.md"))

    def test_frozen_mode_uses_exe_dir(self):
        """模拟 PyInstaller 冻结: APP_DIR 必须跟 sys.executable 走, 而不是 _MEIPASS。"""
        fake_exe = os.path.join(HERE, "dist", "DesktopTodo", "DesktopTodo.exe")
        fake_dir = os.path.dirname(fake_exe)
        sys.frozen = True
        sys.executable = fake_exe
        mod = load_todo()
        self.assertEqual(mod.APP_DIR, fake_dir)
        self.assertEqual(mod.CONFIG_PATH, os.path.join(fake_dir, "config.json"))
        self.assertEqual(mod.DEFAULT_FILE, os.path.join(fake_dir, "待办.md"))

    def test_version_constant(self):
        mod = load_todo()
        self.assertEqual(mod.APP_VERSION, "0.1.0")


if __name__ == "__main__":
    unittest.main()
