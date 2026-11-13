---
status: superseded by 0003
date: 2026-11-10
---

# 继续使用 Python + Tkinter，不迁移到 Tauri 2

当前 `todo.pyw` 是单文件 Python + Tkinter 桌面挂件：空闲内存 30–36MB，热启动 0.17–0.28s，冷缓存首次约 0.9–1.0s。为获得现代 UI 与动画，评估过 Tauri 2；按 WebView2 的量级估算，其空闲内存约 100–200MB、热启动 0.5–1.5s（**未实测**，5 天 spike 未运行）。对一个常驻桌面、要求“轻”的小挂件，3–6 倍的内存代价不划算，因此决定 v1 继续留在 Tkinter，不启动迁移。本次未写迁移代码，现有应用不受影响。

## Considered Options

- **Tauri 2**：现代 UI/动画能力强，置底与不进任务栏都有对应 API；但 WebView2 多进程带来约 3–6 倍内存和更慢的冷启动。否决。
- **Qt Quick / PySide6**：可复用 Python，动效能力足够；报告估算迁移量约为 Tauri 的一半，但内存预计仍高于 Tk，且会引入约 78MB 的 PySide6-Essentials wheel（安装后更大）。未深入评估。
- **Win32 + Direct2D**：性能下限最好（实测空窗口约 9MB），但文本编辑、IME、布局都要自建，工作量最大。否决。
- **继续 Tkinter**：占用最低、代码已存在；现代 UI 与复杂动效受限。选中。

## Consequences

- 不引入 WebView2、Rust、Node 运行时；保持单文件、低占用和现有分发方式。
- 现代 UI/动画只能做到 Tk 能力范围内（微动效、主题、Canvas 绘制）；复杂动效需要重开此决策。
- 分发（PyInstaller onedir）与列表增量渲染（P1.5）按调研报告单独推进，不依赖迁移。
- 本决策基于估算而非实测。重新评估的条件：① 本机实测 Tauri 2 空闲 ≤150MB 且热启动 ≤1s（同一份 Markdown）；② Tk 无法实现一个必须的交互动效，且该动效对产品是硬要求；③ 应用定位从“桌面挂件”变成完整应用，内存不再是首要约束。
