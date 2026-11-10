# 桌面待办

把 Markdown 待办清单固定在 Windows 桌面上显示和编辑的小工具，单文件、只依赖标准库（Tkinter）。

## 功能

- 清单模式：单击方框勾选，双击文字编辑，右键增删条目/分组
- 原文模式：直接编辑 Markdown 源文本，顶栏「原文」按钮切换
- 嵌入桌面层：壁纸之上、普通窗口之下，不占任务栏，Win+D 可见
- 外部改动（如 Obsidian）约 1 秒自动刷新，桌面上的改动自动写回
- 未被编辑的行原样保留，不破坏 Markdown 格式

## 运行

```
pythonw todo.pyw [md文件路径]
```

不带参数时读取 `config.json` 中记住的文件；没有配置时使用程序目录下的 `待办.md`。

## 配置

复制 `config.example.json` 为 `config.json`：

```json
{ "file": "待办.md", "docked": true }
```

`file` 为相对路径时按程序目录解析；窗口位置和大小会写回 `config.json`。该文件属于本机运行时状态，已在 `.gitignore` 中排除。

## 环境

- Windows 10/11
- Python 3（含 tkinter，标准库自带）
