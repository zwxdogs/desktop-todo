---
status: accepted
date: 2026-11-12
supersedes: 0001
---

# 迁移到 Tauri 2，替换 Python + Tkinter 渲染层

> _其中「主窗口进任务栏」一项被 [ADR-0004](0004-pin-means-docked.md) 取代：主窗口改为「固定在桌面 / 普通窗口」两态，只有普通窗口才进任务栏。_

2026-11-12，用户在看完 Tauri 2 spike（`spike/tauri2/`，实测证据见 `docs/research/tauri2-spike-report.md`）后拍板：「可以更换，我认为tauri的更好」，并给出两条硬约束：① 迁移后功能与 0.2.7 完全一致，不增不减；② 测试验证，不留 bug。应用定位从「桌面挂件」升级为「完整应用」：主窗口进任务栏（这是与 0.2.7 唯一的**有意**差异，用户明确要求），其余功能逐项平移。

## 本决策基于的实测（本机，2026-11-12）

- 贴桌面：Tauri `set_always_on_bottom` + FFI `HWND_BOTTOM` 兜底，Z 序核验通过（紧贴 Progman 之上）。
- 任务栏：默认 APPWINDOW 样式，任务栏按钮实拍确认。
- 行保真：md.js 移植 todo.pyw 纯函数，46/46 测试绿（与 test_todo.py 36 用例同构超集）。
- 性能：冷启 32ms / 热启中位 55ms（窗口句柄出现），树私有内存 ~191MB（Tk 为 30–36MB）。内存代价是用户接受的换栈成本。
- 视觉：圆角/阴影/blur/过渡/细滚动条/粘性顶栏全部可用（Tk 8.6 明确做不到）。

## 已知代价与缓解（详细机制见 spike 报告 §3）

- **内存 ~191MB**（WebView2 多进程）。接受。
- **Win11 Build 26200 GPU/AudioService 沙箱崩溃 bug**（WebView2Feedback #5777 open）：必须传 `--no-sandbox --disable-gpu-sandbox --disable-features=AudioServiceSandbox,...` 绕过；上游修复后应移除。
- **WebView2 用户数据目录**：显式指定在 exe 旁 `udf/`（绿色便携语义，与 config.json 同址）。
- **Win+D**：窗口会被最小化，由 1s 轮询自动还原（与 Tk 行为一致的兜底，机制相同）。

## Consequences

- `todo.pyw` 与 `build.ps1` 保留在仓库中作为参照与回退路径，不再构建部署；部署目标 `E:\桌面待办\DesktopTodo` 改放 Tauri 单文件 exe（config.json 保留，格式不变：物理像素坐标 + docked）。
- 领域逻辑继续以纯函数形式存在于 `app/ui/md.js`（单一事实源不变：Markdown 文件）；Rust 只做壳（窗口管理、文件 IO、config 持久化、单实例、Win32 维护轮询）。
- 详情面板是独立窗口，但与主窗口分属两个 webview，状态同步走事件（行为与 Tk 单进程 Toplevel 对齐）。
- 单实例互斥体名不变（`Zwx_DesktopTodoWidget_Mutex`），与旧版互斥。
- 版本号 0.3.0（换栈里程碑）。
