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
        self.assertRegex(mod.APP_VERSION, r"^\d+\.\d+\.\d+$")


class SubtreeEndTest(unittest.TestCase):
    """子块扫描 subtree_end: 待办的子块边界(详情面板功能的地基)。

    子块 = 待办之后所有缩进更深(按 expandtabs(4) 折算)的连续行;
    中间的空行和 other 行不打断子块, 块尾空行/other 行不算子块;
    缩进 <= 父的行截断子块, 分组标题无论缩进多深都截断。
    """

    @classmethod
    def setUpClass(cls):
        cls.mod = load_todo()

    def test_no_children(self):
        lines = self.mod.parse_text("- [ ] 父\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 1)

    def test_basic_children(self):
        lines = self.mod.parse_text(
            "- [ ] 父\n  - [ ] 子1\n  - [x] 子2\n  - 备注\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 4)

    def test_interior_blank_keeps_block(self):
        lines = self.mod.parse_text("- [ ] 父\n  - 子\n\n  - 备注\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 4)

    def test_trailing_blank_excluded(self):
        lines = self.mod.parse_text("- [ ] 父\n  - 子\n\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 2)

    def test_deeper_header_terminates(self):
        lines = self.mod.parse_text("- [ ] 父\n  - 子\n  **小标题**\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 2)

    def test_tab_indent_is_child(self):
        lines = self.mod.parse_text("- [ ] 父\n\t- 子\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 2)

    def test_eof_end(self):
        lines = self.mod.parse_text("- [ ] 父\n  - 子\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 2)

    def test_interior_other_keeps_block(self):
        # 子块中间的普通段落行(other)不打断子块, 其后的子行照常圈入
        lines = self.mod.parse_text("- [ ] 父\n  普通段落\n  - [ ] 子\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 3)

    def test_trailing_other_excluded(self):
        lines = self.mod.parse_text("- [ ] 父\n  - 子\n普通段落\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_end(lines, 0), 2)


class SubtreeStatsTest(unittest.TestCase):
    """徽标统计 subtree_stats: 子树内 (待办总数, 已完成数, 备注数) 递归统计。"""

    @classmethod
    def setUpClass(cls):
        cls.mod = load_todo()

    def test_mixed_recursive(self):
        lines = self.mod.parse_text(
            "- [ ] 父\n"
            "  - [ ] 子1\n"
            "  - [x] 子2\n"
            "    - [ ] 孙\n"
            "  - 备注1\n"
            "  - 备注2\n")
        self.assertEqual(self.mod.subtree_stats(lines, 0), (3, 1, 2))

    def test_notes_only(self):
        lines = self.mod.parse_text("- [ ] 父\n  - 备注1\n  - 备注2\n")
        self.assertEqual(self.mod.subtree_stats(lines, 0), (0, 0, 2))

    def test_no_children(self):
        lines = self.mod.parse_text("- [ ] 父\n- [ ] 下一个\n")
        self.assertEqual(self.mod.subtree_stats(lines, 0), (0, 0, 0))

    def test_checked_x_counts_done(self):
        lines = self.mod.parse_text("- [ ] 父\n  - [X] 子\n")
        self.assertEqual(self.mod.subtree_stats(lines, 0), (1, 1, 0))

    def test_deep_nested_all_counted(self):
        lines = self.mod.parse_text(
            "- [ ] 父\n"
            "  - [x] 子\n"
            "    - [x] 孙\n"
            "      - 曾孙备注\n")
        self.assertEqual(self.mod.subtree_stats(lines, 0), (2, 2, 1))


class DeleteSubtreeTest(unittest.TestCase):
    """整树删除 delete_subtree: 移除待办及其子块，返回新列表不动原列表。"""

    @classmethod
    def setUpClass(cls):
        cls.mod = load_todo()

    def test_removes_block(self):
        lines = self.mod.parse_text("- [ ] 父\n  - 子\n- [ ] 下一个\n**分组**\n")
        rest = self.mod.delete_subtree(lines, 0)
        self.assertEqual([ln.raw for ln in rest], ["- [ ] 下一个\n", "**分组**\n"])

    def test_keeps_lines_before(self):
        lines = self.mod.parse_text("- [ ] A\n- [ ] 父\n  - 子\n- [ ] B\n")
        rest = self.mod.delete_subtree(lines, 1)
        self.assertEqual([ln.raw for ln in rest], ["- [ ] A\n", "- [ ] B\n"])

    def test_delete_last_todo(self):
        lines = self.mod.parse_text("- [ ] A\n- [ ] 父\n  - 子\n")
        rest = self.mod.delete_subtree(lines, 1)
        self.assertEqual([ln.raw for ln in rest], ["- [ ] A\n"])

    def test_original_untouched(self):
        src = "- [ ] A\n- [ ] 父\n  - 子\n  - 备注\n"
        lines = self.mod.parse_text(src)
        self.mod.delete_subtree(lines, 1)
        self.assertEqual(len(lines), 4)
        self.assertEqual(self.mod.serialize(lines), src)

    def test_deletes_deeper_subtree(self):
        lines = self.mod.parse_text(
            "- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n      - 备注\n- [ ] B\n")
        rest = self.mod.delete_subtree(lines, 0)
        self.assertEqual([ln.raw for ln in rest], ["- [ ] B\n"])


class ClampPosTest(unittest.TestCase):
    """窗口拉回 clamp_pos: 把左上角 (x,y) 的 w×h 窗口夹回虚拟屏幕内。"""

    @classmethod
    def setUpClass(cls):
        cls.mod = load_todo()

    def test_inside_unchanged(self):
        # 已在屏内(含贴边) 不动
        self.assertEqual(self.mod.clamp_pos(100, 100, 430, 660, 0, 0, 1920, 1080),
                         (100, 100))
        self.assertEqual(self.mod.clamp_pos(1490, 420, 430, 660, 0, 0, 1920, 1080),
                         (1490, 420))

    def test_right_edge_sliver(self):
        # 本机事故形态: 虚拟屏右缘 3840, 窗口 x=3062 w=760 -> 拉到 3080
        self.assertEqual(self.mod.clamp_pos(3062, 697, 760, 1280, -3840, 0, 7680, 2160),
                         (3062, 697))
        self.assertEqual(self.mod.clamp_pos(3846, 697, 760, 1280, -3840, 0, 7680, 2160),
                         (3080, 697))

    def test_off_left_monitor(self):
        # 负坐标屏(左屏)同样生效
        self.assertEqual(self.mod.clamp_pos(-4000, 100, 430, 660, -3840, 0, 7680, 2160),
                         (-3840, 100))

    def test_window_bigger_than_screen(self):
        # 窗口比屏幕还大 -> 贴左上角
        self.assertEqual(self.mod.clamp_pos(50, 50, 8000, 3000, 0, 0, 1920, 1080),
                         (0, 0))


class PanelPosTest(unittest.TestCase):
    """详情面板落点 panel_pos: 优先主窗口右侧, 放不下放左侧, 再贴虚拟屏右缘。"""

    @classmethod
    def setUpClass(cls):
        cls.mod = load_todo()

    def test_right_side_normal(self):
        # 主窗口在屏幕中部 -> 面板放右侧 gap=12
        self.assertEqual(self.mod.panel_pos(300, 200, 430, 420, 520, 0, 0, 1920, 1080, 12),
                         (742, 200))

    def test_right_offscreen_falls_left(self):
        # 本机事故形态: 挂件贴右屏边, 右侧放不下 -> 放挂件左侧
        self.assertEqual(self.mod.panel_pos(3062, 697, 760, 420, 520, -3840, 0, 7680, 2160, 12),
                         (2630, 697))

    def test_left_also_offscreen_clamps_right_edge(self):
        # 窄屏上挂件在最左缘 -> 右侧、左侧都放不下, 面板贴虚拟屏右缘
        self.assertEqual(self.mod.panel_pos(0, 100, 200, 420, 520, 0, 0, 500, 1080, 12),
                         (68, 100))

    def test_y_clamped_bottom(self):
        # y 超出下缘 -> 夹回
        self.assertEqual(self.mod.panel_pos(100, 900, 430, 420, 520, 0, 0, 1920, 1080, 12),
                         (542, 548))


if __name__ == "__main__":
    unittest.main()
