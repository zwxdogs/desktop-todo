---
status: accepted
date: 2026-11-13
---

# 删除 Tk 0.2.7 的回退路径（源码与打包链）

[ADR-0005](0005-lift-tk-parity.md) 解除对等约束时保留了回退路径：`todo.pyw` 与根目录 `build.ps1` 留在仓库里，「需要回退时仍可按 ADR-0003 构建 0.2.7」。2026-11-13，维护者在 #6 拍板：这条回退路径直接删掉。

## Context

- Tauri 2 自 0.3.0 起接管，0.4.0 已发版；Tk 版最后一次改动是 2026-11-12 的 0.2.7，此后没有一行新代码。
- 回退路径是四个文件互相引用的打包链：根 `build.ps1` → `DesktopTodo.spec` → `todo.pyw` / `gen_icon.py` / `packaging/gen_version_info.py`，再加上 `assets/app.ico` 与 `config.example.json`。它不参与 Tauri 的构建、测试、部署，却要跟每一处"回退路径仍在"的文档措辞一起维护。
- 「回退」真正发生时的两条替代路径都还在：git 历史里删除前的提交能取回全部源码，GitHub Releases 上的 `DesktopTodo-0.2.7-win64.zip` 能直接给用户可运行的程序。

## Decision

从仓库删除 Tk 0.2.7 的源码与整条打包链：`todo.pyw`、根 `build.ps1`、`DesktopTodo.spec`、`test_todo.py`、`gen_icon.py`、`assets/app.ico`、`packaging/gen_version_info.py`、`packaging/version_info.txt`、`config.example.json`。

同一批还删除了迁移期的一次性证据与原型：`spike/`（Tauri 2 原型 + WebView2 裸探针）与 `ui_audit/`（像素审计截图与驱动器）。它们的结论留在 `docs/research/` 里。

## Considered Options

- **保留现状（ADR-0005 的结论）**：回退一年用不上，却要长期为 9 个文件与三处文档措辞买单。否决。
- **归档到 `archive/tk-0.2.7/`**：格式上干净，实质只是把清理推迟；回退能力本来就不来自"文件在哪个目录"，而来自 git 历史。否决。
- **删除（选中）**：git 历史即归档，取回命令写在本 ADR 与删除提交的 message 里。

## Consequences

- 代码与文档里 48 处 `todo.pyw:NNN` 行号注释**不删**（[ADR-0005](0005-lift-tk-parity.md) 定调：考古线索，不是约束），但它们现在指向 git 历史，不在工作树；`app/PARITY.md` 的逐函数对照表同理。
- 取回源码：`git checkout ac81474 -- todo.pyw build.ps1 DesktopTodo.spec test_todo.py gen_icon.py packaging assets config.example.json`；重建 Tk 版：取回后 `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`；撤销本次删除：`git revert 76a70a1`。
- 同步修改：`AGENTS.md` 的 Baseline 段与 Tests 段、`README.md` 的配置段与回退说明、`docs/adr/0003` 与 `docs/adr/0005` 的现行性注记、三份 `docs/research/` 报告顶部的"原文引用物已删除"注记。
- `docs/research/` 的三份报告是带日期的调研记录，正文里的 `todo.pyw` 行号、`spike/` 路径、`ui_audit/` 截图引用一律不改写，只在顶部加注记。
