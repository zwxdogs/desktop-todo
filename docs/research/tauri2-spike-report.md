# Tauri 2 spike 实测报告（选项 C）

> _本文引用的 `spike/`（原型与探针）与 `ui_audit/`（审计截图）已于 2026-11 从仓库删除（[#6](https://github.com/zwxdogs/desktop-todo/issues/6)、[ADR 0006](../../docs/adr/0006-remove-tk-fallback.md)）；需要原物时从 git 历史取。_

- 日期：2026-11-12
- 结论状态：spike 已完成并能在本机运行；**是否迁移仍待拍板**
- 前置文档：`docs/research/desktop-widget-tech-stack.md`（栈对比）、`docs/research/tauri-electron-flutter.md`（三栈基准）、`docs/adr/0001-*.md`（留在 Tkinter，accepted 2026-11-10）、`.scratch/ui_audit/REPORT.md`（Tk 审计）
- 关联 issue 结论：#10422（skip_taskbar）、#9597（创建即置顶）、#14461（Win+D）——本次实测全部给出本机答案

## 0. 一句话结论

Tauri 2 能同时做到「贴桌面 + 进任务栏 + 视觉天花板全解锁」，行保真逻辑已用 TDD 移植并通过 46/46 用例；代价是空闲内存约为 Tk 的 5～6 倍（树私有 ~191MB vs Tk 30～36MB），且本机（Win11 Build 26200）存在一个**必须用 `--no-sandbox` 类参数绕过的 WebView2 已知 GPU 沙箱崩溃 bug**（安全权衡，见 §3.2）。

## 1. spike 回答的问题（对应选项 C 定义）

| 问题 | 答案 | 证据 |
|---|---|---|
| 贴桌面（普通窗口之下、壁纸之上） | **可行** | 创建后 `set_always_on_bottom(true)` + FFI `SetWindowPos(HWND_BOTTOM)`；失焦重压底。Z 序实测：底部方向依次为 `桌面待办`(Tk)、`Program Manager`，spike 紧贴其上、全屏窗口之下（win32_checks.ps1 输出 [3][7]） |
| 进任务栏（用户新要求） | **可行** | 不调 `set_skip_taskbar`；EXSTYLE=0x40110：`WS_EX_APPWINDOW` 置位、`TOOLWINDOW=False`、`TOPMOST=False`（输出 [2]）。任务栏按钮实拍：`ui_audit/spike/taskbar.png`（蓝色勾图标 + 运行指示条）。#10422 天然规避 |
| 行保真读写 | **可行，已验证** | `spike/tauri2/ui/md.js` 移植 todo.pyw 纯函数；`node --test` 46/46 绿（10 解析 + 11 字节级保真 + 25 树操作），sample.md 往返字节一致 |
| IME 行内编辑 | 代码路径已就绪 | `app.js` compositionstart/update/end 上报 + `isComposing`/`keyCode 229` 守卫；**候选窗位置仍需人工核验**（合成事件无法模拟真 IME） |
| Tk 做不到的视觉 | **全部做到** | 圆角行 8px、hover/pressed 120ms transition、勾选 180ms cubic-bezier 动画、顶栏 `backdrop-filter: blur(14px)` 粘性半透明、6px 细滚动条、demo 卡 16px 圆角 + 32px 阴影。截图：`ui_audit/spike/spike_main.png` |
| 启动/内存 | 见 §4 | 启动过门，**内存不过 ADR 0001 重开门槛** |

## 2. 交付物

```
spike/tauri2/            # Tauri 2 spike（可 cargo build --release 直接构建）
  ui/                    # index.html / style.css / app.js / md.js + 3 个测试文件
  src-tauri/             # main.rs（贴桌面 FFI + 文件命令 + UDF/浏览器参数修复）
  bench/measure.ps1      # 计划任务直启 exe，测启动 ms + 树内存
  bench/win32_checks.ps1 # EXSTYLE / Z 序 / Win+D 三项核验
  README.md              # 问题判据表 + 运行说明
spike/wvprobe/           # WebView2 裸 COM 探针（诊断工具，保留作证据链）
ui_audit/spike/spike_main.png   # spike 窗口实拍
ui_audit/spike/taskbar.png      # 任务栏按钮实拍（蓝色勾 + 运行指示条）
```

运行方式（本机已验证）：

```
cd spike/tauri2/src-tauri && cargo build --release
# 计划任务直启 exe（cmd 包 start 会被任务计划回收整棵树——实测教训）
desktop-todo-spike.exe   # 读 exe 旁 sample.md；40 行 sample 已就位
```

## 3. 本机两处 WebView2 硬坑（重要新发现，此前三栈调研均未覆盖）

### 3.1 UDF（用户数据目录）的可写性硬约束

- tauri 2.12.5 在 Windows 上**强制** `data_directory = app_local_data_dir()`（`tauri-2.12.5\src\manager\webview.rs ~558-572`），并 `create_dir_all(...)?`——目录建不出来时应用直接 panic（`app.rs:1444`，错误伪装成 `Io(os error 5)`）。
- WebView2 loader 对**显式 UDF** 的行为：目录必须可创建/可写；启动中止时会清掉新建的 UDF。受限 token（开发沙箱）下 `%LOCALAPPDATA%` 部分子树不可写 → controller 阶段 `0x800700AA`。
- spike 的落地选择：`data_directory(exe 旁 udf/)`——复刻 loader 默认布局 `<exe>.exe.WebView2` 的思路，部署到任何目录都自包含。**迁移时必须显式设置 UDF，不要依赖默认值。**

### 3.2 Win11 Build 26200 GPU/AudioService 沙箱崩溃循环（比 UDF 更严重）

- 已知 bug：[WebView2Feedback #5777](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5777)（open，2026-10-24）/ Chromium issue `577213782`。本机正好是 Build 26200（SearchHost UA 实证 `10.0.0.0.26200`）。
- 本机症状：GPU/AudioService 子进程在 Chromium 沙箱内崩溃循环（`STATUS_BREAKPOINT 0x80000003`，msedge.dll 157.0.4341.46），浏览器随后自杀；controller 侧表现为 `E_UNEXPECTED 0x8000FFFF` 或 `0x800700AA`。实验期间 Application 日志捕获 18 次 `Id=1000` 崩溃事件（20:26–20:41，与探针/任务运行时刻吻合）。
- 裸 COM 探针（`spike/wvprobe/`）逐层二分，排除了沙箱 ACL、组策略、runtime 版本（154/156/157 全试）、窗口样式、命令行参数，最终由 web 检索定位到 #5777。
- **绕过**（进入 spike 代码）：`additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,AudioServiceSandbox --no-sandbox --disable-gpu-sandbox")`。注意两点：
  1. tauri 的 `additional_browser_args` 会**覆盖** wry 默认参数，`msWebOOUI` 等需自带（`tauri-2.12.5\src\webview\mod.rs:1030`）；
  2. **这等于关掉 Chromium 渲染沙箱**。对本挂件风险可控（只渲染本地 md、无远程内容），但这是一个持续的安全权衡：Chromium 上游修复进入 Evergreen runtime 后应立即摘掉。可在应用里做成「检测崩溃 → 提示 → 降级启用」的策略。

## 4. 实测数据（bench/measure.ps1，5 次热启 + 1 次冷启）

| 指标 | 本次 spike | 三栈基准（重应用） | Tk 现状 | ADR 0001 重开门槛 |
|---|---|---|---|---|
| 启动到窗口句柄（冷/热） | **32ms / 55ms 中位** | 1162/614ms | 0.89–1.04s / 0.17–0.28s | ≤1s ✅ |
| 空闲树私有内存 | **~191MB** | 212.3MB | 30–36MB | ≤150MB ❌ |
| 空闲树工作集 | ~365MB | 407.2MB | ~40–60MB | — |
| 磁盘增量 | exe 8.8MB（runtime Evergreen 共享，0 额外） | 4.1MB+runtime | 13.4MB runtime | — |

- 启动快的原因：spike 前端是 4 个静态文件（无打包器/开发服务器）；进程→句柄只计窗口创建，WebView2 内容加载在句柄出现后百余 ms 内完成。
- 内存组成：desktop-todo-spike.exe ~10MB + 5~6 个 msedgewebview2 进程（GPU/network/storage/renderer/crashpad）。**~191MB 是结构性下限**（比三栈基准的 212MB 略低是因为应用更小），针对 ADR 0001 的重开门槛：**启动达标、内存不达标**。

## 5. 与 Tk 路线的逐项对照（决策输入）

| 维度 | Tk（0.2.7 现状） | Tauri 2 spike |
|---|---|---|
| 圆角/阴影/毛玻璃/过渡/细滚动条/粘性顶栏 | 8.6 做不到 | 全部原生 CSS ✅ |
| 贴桌面 | ✅（send_above_desktop） | ✅（always_on_bottom + FFI 兜底） |
| 进任务栏 | 目前 toolwindow 不进（可改） | ✅ 默认进 |
| Win+D | 保持可见（ADR 记录） | **会被最小化**（tauri #14461 族）⚠️ 决策点 |
| 内存 | 30–36MB | ~191MB ❌ |
| 行保真 | Python 已验证 | JS 移植 46/46 ✅ |
| 栈复杂度 | 单文件 Python | Rust + TS/HTML/CSS 双栈 |
| 本机 WebView2 健康 | 无依赖 | 需 GPU 沙箱绕过参数 ⚠️ 决策点 |
| 打包 | PyInstaller onedir ~14MB | NSIS ~1.3MB + bootstrapper |

## 6. 迁移工作量（在 tauri-electron-flutter.md 的 14–22 人日上新增/修订）

- 新增：UDF 显式设置与清理策略（0.5 天）；WebView2 崩溃检测与沙箱参数降级逻辑（1 天）；Win+D 行为的产品决策与可能的恢复策略（0.5–1 天）；md.js 已在 spike 完成（原估算中的大头已消化）。
- 维持：布局/交互全量移植、面板、托盘/自启、打包（NSIS）、auto-update。
- 修订后总估算：**12–20 人日**。

## 7. 待拍板清单（按影响排序）

1. **换不换**：视觉天花板（Tk 8.6 的硬限制）值不值得 191MB 内存 + 双栈维护 + WebView2 依赖。
2. **若换**：GPU 沙箱绕过参数是否接受（安全权衡；上游修复后可摘）。
3. **若换**：Win+D 最小化行为是否可接受（与 Tk 现状不同； mitigation 可试 restore 事件重压底，但「Win+D 后仍在桌面」这一语义可能做不到）。
4. **若不换**：接受 Tk 8.6 视觉上限，Phase 0 风格为最终形态。

## 8. 复现实验的关键命令（留档）

```powershell
# 裸 COM 探针矩阵（UDF × 参数）
spike\wvprobe\target\release\wvprobe.exe 'args,lang' 'C:\Users\zwxUnderdogs\AppData\Local\cap-x'
spike\wvprobe\target\release\wvprobe.exe 'customargs:--no-sandbox --disable-gpu-sandbox --disable-features=AudioServiceSandbox' 'null'
# 崩溃证据
Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000} | ? { $_.Message -match 'msedgewebview2' }
# Win32 三项核验
powershell -File spike\tauri2\bench\win32_checks.ps1
# 基准
powershell -File spike\tauri2\bench\measure.ps1 -Runs 5
```
