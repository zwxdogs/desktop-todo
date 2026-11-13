# Tauri 2 / Electron / Flutter：Windows 桌面待办应用选型调研

> _文中引用的 `todo.pyw` 与行号对应 0.2.6/0.2.7 的 Tk 源码，该文件已于 2026-11 从仓库删除（[ADR 0006](../../docs/adr/0006-remove-tk-fallback.md)）；需要原物时从 git 历史取。_

- 调研日期：2026-11-12
- 对象：`E:\项目\desktop-todo\todo.pyw`（v0.2.6，约 1,594 行 Python 3.12 + Tkinter，PyInstaller onedir）
- 问题：三者之中，谁能在「更高性能 / 更小占用 / 更方便开发」上领先？——不是单选，按三条轴分别回答。

## 0. 怎么读这份报告

**取道说明（重要）**：本机 DNS 把 `tauri.app`、`docs.rs`、`doc.qt.io`、`pypi.org`、`learn.microsoft.com`、`storage.googleapis.com` 解析到 198.18.0.x，无法直读。因此版本号、API 与缺陷状态一律取自 **GitHub 源仓库的 raw 文件 / Releases / Issues**（下文标注「经 GitHub 源仓库」），官方站点的叙述类内容若只能间接确认，会写「经镜像/未直读」。凡未取到一手证据的，一律写「未查到」，不做推测填空。

**证据标签**：

| 标签 | 含义 |
|---|---|
| ［官方文档］ | 厂商/项目官方文档或 README |
| ［源码］ | 我直接读到的仓库源码行、Cargo.toml、CI 配置等 |
| ［实测］ | 有机器、版本、方法的测量数字。分「第三方基准」与「本项目历史实测」两类，不混用 |
| ［社区］ | issue、讨论、个人经验，未经独立验证 |
| ［估算］ | 本报告的推断，用于量级参考，不作为事实 |
| ［未查到］ | 明确未取到证据 |

**单机基准的适用边界**：下文引用的第三方基准是**一台机器、一款应用、六种实现**，能回答「量级差多少」，不能回答「你机器上多少 MB」。它也没有测 200% DPI 清晰度与中文 IME。

## 1. 执行摘要

1. **三目标不能同时最优。** Tauri 赢在磁盘与安装包（磁盘 4.1MB、安装包 1.3MB），但它的运行时就是 WebView2/Chromium，空闲内存反而比 Electron 略高（working set 407.2MB vs 347.6MB，private 212.3MB vs 220.1MB），进程数 7 vs 4，IPC 1000 次往返 1629.2ms 最慢。［实测·第三方］
2. **Electron 是「开发最省 + 占用最大」的极端。** 磁盘 357.1MB、NSIS 安装包 115.7MB、空闲 working set 347.6MB；换来的是 JS 单栈、调试/签名/自动更新工具链最成熟。［实测·第三方］［官方文档］
3. **Flutter 是「内存最省 + 冷启最贵」的极端。** 空闲 working set 197.0MB、private 207.2MB、峰值 218.5MB、单进程，但冷启 3067ms，其中约 2.2s 花在 Dart `main()` 之前的引擎与 GPU 初始化。对「点开就要看见」的待办应用，这是最扎眼的代价。［实测·第三方］
4. **桌面集成不是「能不能」，而是「谁替你修 bug」。** 三者都能落 Win32 兜底（Tauri 用 `windows` crate、Electron 用 native module/FFI、Flutter 用 FFI/win32 包）。差别在：Tauri 官方 API 最全但已知缺陷最多（skip_taskbar #10422 open、Win+D #14461 open、always_on_bottom 创建时不生效 #9597）；Electron 干脆没有 always-on-bottom（#6399 建成即关）；Flutter 靠 `window_manager`，API 有（`isAlwaysOnBottom` / `isVisibleInTaskbar`），但底层刚迁到仍标 WIP 的 nativeapi。［源码］［社区］
5. **200% DPI 模糊是唯一「换栈立刻见效」的问题。** 现状是 `SetProcessDpiAwareness(1)`（System DPI aware，todo.pyw:1534），两块 4K、200% 下混 DPI 必然模糊。Chromium 系与 Flutter 都按显示器渲染，换过去清晰度会有实质改善——但要自己做 DPI 变更时的布局重排。［实测·本项目］［源码］
6. **最大的体感短板与 GUI 栈无关。** 800 行列表 toggle 2538ms 来自「每次全量重建控件」，不是 Tk 的锅；任何栈全量重建 800 个节点都会慢。先做虚拟列表/增量更新（估 1–2 人日），再谈换栈。［实测·本项目］［估算］

> 一句话：**「更小占用」和「更方便开发」在这三个栈里是互斥的；「更高性能」要拆成启动（Flutter 输）、内存（Electron 输）、磁盘（Electron 输）、交互（三者接近）分别看。**

## 2. 决策矩阵

评分：● 好，◐ 中，○ 差。括号内为关键证据。

| 维度 | Tauri 2 | Electron | Flutter | 现状 Tk 基线 |
|---|---|---|---|---|
| 当前稳定版 | 2.12.5［源码］ | 45.3.1（2026-11-12）［官方文档］ | 3.50.0［源码·tag］ | — |
| 语言 / UI | Rust + HTML/CSS/JS | JS/TS + HTML/CSS | Dart + Widget | Python + Tk |
| 空闲 private / WS | 212.3 / 407.2 MB ●◐ | 220.1 / 347.6 MB ◐ | 207.2 / 197.0 MB ● | 15.7 / 30.2 MB ●●● |
| 冷启 / 热启 | 1162 / 614 ms ◐ | 725 / 546 ms ● | 3067 / 2336 ms ○ | 192ms 首窗；冷缓存 890–1040ms ● |
| 磁盘 / 安装包 | 4.1 MB / 1.3 MB ●●● | 357.1 MB / 115.7 MB ○ | 26.5 MB / 未提供 ● | ≈13.4 MB Tk 运行时 ● |
| 列表渲染（10k 虚拟表） | load 50.0 / filter 62.1 ms ● | 76.7 / 74.4 ms ◐ | 125.6 / 132.2 ms ○ | 800 行全量重建 2538ms ○ |
| 200% DPI | 按显示器渲染 ●（未本机实测） | 按显示器渲染 ●（未本机实测） | 按显示器渲染 ●（未本机实测） | System aware → 模糊 ○ |
| always-on-bottom | 有 API，创建时失效 #9597 ◐ | 无公开 API #6399 ○ | `isAlwaysOnBottom`（nativeapi WIP）◐ | 手工 Win32 Z 序 ● |
| skip_taskbar | #10422 open，不可靠 ○ | `setSkipTaskbar` + `type:'toolbar'` ● | `isVisibleInTaskbar` ◐ | `WS_EX_TOOLWINDOW` ● |
| Win+D 存活 | #14461 open，仍被最小化 ○ | 未查到 | 未查到 | 轮询里自己复原 ● |
| 点击穿透 | `set_ignore_cursor_events` ● | `setIgnoreMouseEvents` + forward ● | `setIgnoreMouseEvents` ◐ | 不适用 |
| 中文 IME | #16391 open（2.12.5 复现）○ | Chromium 输入栈成熟 ◐ | 有支持，细节 issue 未查到 ◐ | 系统原生 ● |
| 托盘 / 通知 / 单实例 / 文件监听 | 官方插件齐全 ● | 内建齐全 ● | 第三方（tray_manager / local_notifier / 手写）◐ | 需手写 ○ |
| 热重载 | 前端 HMR + Rust 重编译 ◐ | renderer HMR，主进程需重启 ◐ | hot reload ● | 无 ○ |
| 打包 / 签名 / 自动更新 | 内建 bundler + updater，签名自己接 ● | electron-builder / forge 全自动 ● | MSIX/Inno + 自己接 ● | PyInstaller，无自动更新 ◐ |
| 组件生态 | Web 生态（最大）●●● | Web 生态（最大）●●● | 偏移动端风格，桌面控件需自建 ◐ | 无 ○ |
| 学习曲线 | Rust + Web 两栈 ○ | 单栈 JS/TS ● | Dart + Widget 新范式 ◐ | 已会 ● |
| 迁移成本（估） | 14–22 人日 | 12–20（保 Python）/ 16–26（全 TS）人日 | 18–28 人日 | 0 |
| 长期维护风险 | 2→3 迁移未定 ◐ | 8 周节奏，须持续跟版 ◐ | 桌面无 SLA，插件 WIP ◐ | 自维护，稳定 ● |

## 3. 分轴详述

### 3.1 版本现状（截至 2026-11）

| 项目 | 事实 | 来源 |
|---|---|---|
| Tauri 稳定线 | **2.12.5**（`crates/tauri/Cargo.toml` 的 `version`） | ［源码］经 GitHub 源仓库 |
| Tauri 3 | **alpha**，`tauri-v3.0.0-alpha.6` 发布于 2026-11-06；迁移文档明写 “Tauri 3.0 is in alpha” | ［官方文档］经 GitHub 源仓库 |
| Tauri 工程要求 | workspace `rust-version = "1.90"`、edition 2024；Windows 需 MSVC Build Tools + WebView2（Win10 1803+ 自带） | ［源码］ |
| Electron 稳定版 | **45.3.1**，2026-11-12T02:05Z 发布 | ［官方文档］releases API |
| Electron 支持周期 | 最新 3 个稳定大版本；8 周一版（4 周 alpha + 4 周 beta）；旧线只收安全修复 → 当前受支持 45/44/43，43 在 46 发布时 EOL | ［官方文档］`docs/tutorial/electron-timelines.md` |
| Flutter 稳定线 | **3.50.0**（tag 存在，`3.50.0-0.x.pre` 为其 alpha 预发布）；上一稳定线 3.44.x | ［源码］tag 列表（releases API 只回 2024 年 beta 标签，`releases_windows.json` 被 DNS 拦截） |
| Flutter Windows 成熟度 | Windows 自 2.10（2022-02）起为稳定目标；构建需 VS 2022 的“使用 C++ 的桌面开发”工作负载 | ［官方文档］docs.flutter.dev/desktop（**未直读**，站点被 DNS 拦截；按公开发布时间线记录） |

关于「Tauri 2 的支持窗口」与「Tauri 3 的破坏面清单」：**未查到**官方承诺。

### 3.2 性能与占用

#### 3.2.1 唯一找到的有方法学独立基准

来源：`https://github.com/adarSonmez/desktop-framework-benchmark`（README + `results/latest/report.md` + `spec/BENCH_PROTOCOL.md`）。

- 机器：AMD Ryzen 7 7840HS（16 线程）/ 15GB / RTX 3050 Laptop / 144Hz / Windows 11 Pro build 26300。**不是本项目机器。**［实测·第三方］
- 应用：同一款 10,000 行虚拟列表 + 搜索/排序/CRUD/详情/JSON 存储，六种实现（Electron、Tauri、Flutter、Qt、MAUI、WinUI）。
- 方法：release 构建；1 次冷启 + 10 次热启轮转取中位；**进程树全量采样**（含 WebView2/Chromium 子进程）；idle 窗口静置 3000ms；60 次热启全部通过结果校验。

| 指标 | Electron | Tauri | Flutter |
|---|---|---|---|
| 冷启到首窗 | 725 ms | 1162 ms | 3067 ms |
| 热启到首窗 | 546 ms | 614 ms | 2336 ms |
| 窗口出现 | 327 ms | 45 ms | 2382 ms |
| 空闲 working set | 347.6 MB | 407.2 MB | 197.0 MB |
| 空闲 private | 220.1 MB | 212.3 MB | 207.2 MB |
| 峰值 working set | 449.5 MB | 515.3 MB | 218.5 MB |
| 进程数 | 4 | 7 | 1 |
| 全程 CPU 时间 | 3586 ms | 6531 ms | 6531 ms |
| 磁盘占用 | 357.1 MB | 4.1 MB | 26.5 MB |
| 文件数 | 75 | 1 | 12 |
| 安装包（NSIS） | 115.7 MB | 1.3 MB | 未提供 |
| 加载 10k 行 | 76.7 ms | 50.0 ms | 125.6 ms |
| 过滤 | 74.4 ms | 62.1 ms | 132.2 ms |
| 排序 | 73.0 ms | 76.0 ms | 143.0 ms |
| 滚动 60 步 | 864.7 ms | 851.8 ms | 2354.2 ms |
| CRUD | 195.2 ms | 190.8 ms | 213.0 ms |
| 保存 | 10.0 ms | 50.5 ms | 40.3 ms |
| IPC 1000 次往返 | 145.2 ms | 1629.2 ms | 62.9 ms |

#### 3.2.2 三个必须写进报告的口径警告

1. **Flutter 的滚动数字不可直接比。** README 明写：Flutter 的帧步进被 60Hz 节流，WebView 变体跑在 144Hz，2354.2ms ≈ 60 步 × 33ms 的下限。这是测试脚手架差异，不是 Flutter 滚动慢 2.7 倍。［实测·第三方·限定］
2. **Tauri 与 Electron 的差异主要是进程模型与 IPC，不是渲染。** 两者同为 Chromium/WebView2；WebView2 官方文档承认每个控件会拉起 browser/renderer/GPU 多进程，冷启动要拉进程与磁盘缓存，有 “noticeable delay”，并建议不要用 WebView2 做首屏 UI。［官方文档］经 `MicrosoftDocs/edge-developer`
3. **IPC 是各栈自己实现的**，不可跨栈硬比；Tauri 的 1629.2ms（≈1.6ms/次）说明 command 层往返成本高，适合粗粒度调用。

#### 3.2.3 与本项目现状的对照

| 指标 | 现状（实测·本项目） | 换栈后的量级（估算） |
|---|---|---|
| 空闲 working set | 30.2 MB（长期实例 35.7） | Tauri ~400MB / Electron ~350MB / Flutter ~200MB |
| 空闲 private | 15.7 MB（长期 27.8） | 200MB 上下，三者同一量级 |
| 热启到首窗 | 170–280 ms（中位 192） | Tauri ~600 / Electron ~550 / Flutter ~2300（外机数字，本机未测） |
| 磁盘 | ≈13.4 MB（Tk 运行时） | Tauri 4.1 / Flutter 26.5 / Electron 357.1 |
| 800 行列表 toggle | 2538 ms | 取决于是否虚拟化，不取决于栈 |

**结论：换成三者中任何一个，空闲内存都会从 30MB 级跳到 200MB 级，涨 6–13 倍。** 这是「完整应用 + 美化」的入场费，不是选型能绕过的。若「低占用」是不可让步的硬约束，正确答案是**不换栈**。

#### 3.2.4 200% DPI 与清晰度

- 现状：`SetProcessDpiAwareness(1)` = System DPI aware（todo.pyw:1534）。两块 4K/200% 下，跨屏或非主屏缩放会位图拉伸 → 模糊。这是 Tk 的已知长期问题（python/cpython#119459，2024-05 开、2026-10 仍 open）。［源码］［社区］
- Chromium 系（Tauri/Electron）：按显示器渲染，文本走 DirectWrite，200% 下清晰。但窗口位置/尺寸在 DPI 变化时需自己重算（Tauri 有 `ScaleFactorChanged` 事件，Electron 有 `screen` 模块）。
- Flutter：引擎自绘，理论上不受系统缩放影响；**是否显式声明 PerMonitorV2 未取到源码级证据**，按「未查到」处理，需本机实测。
- **本报告未做任何本机 DPI 实测**（约束是不构建、不运行）。

#### 3.2.5 列表渲染与滚动

第三方基准里 10k 行虚拟列表的 load 是 50–126ms，说明**虚拟化之后三者都不慢**；本项目 800 行 2538ms 是「全量销毁重建控件」的代价。无论选哪个栈，这一项都要重做：Web 侧用窗口化列表，Flutter 用 `ListView.builder` + `itemExtent`。［实测·第三方］［实测·本项目］

### 3.3 开发便利性

#### 3.3.1 一个具体工作流对比（改一行列表行高）

| 步骤 | Tauri 2 | Electron | Flutter |
|---|---|---|---|
| 起开发态 | `cargo tauri dev`（前端 dev server + Rust 编译） | `npm run dev`（Electron + Vite） | `flutter run -d windows` |
| 只改 CSS/样式 | 前端 HMR，毫秒级 | 同左 | hot reload，<1s |
| 改 UI 结构逻辑 | 前端 HMR 仍生效 | 同左 | hot reload 常生效，状态丢失时 hot restart |
| 改原生/主进程侧 | Rust 重编译，估 10–40s（增量） | 主进程需重启整个 app | 需重启（引擎侧改动更慢） |
| 断点调试 | 前端 DevTools + Rust 侧 `lldb`/`cargo` 日志 | 主进程 + renderer 双 DevTools | Dart DevTools（成熟） |
| 打包 | `cargo tauri build`（WiX/NSIS） | `electron-builder`（NSIS/MSIX） | `flutter build windows` + MSIX/Inno |
| 代码签名 | 自己接 `signtool`（tauri-action 有示例） | electron-builder 配置项直给 | 自己接 |
| 自动更新 | 内建 updater（需签名密钥 + 静态托管） | electron-updater（最成熟） | 无官方，需自己写 |

［官方文档］［估算：编译耗时］

#### 3.3.2 语言与心智负担

- **Tauri**：两栈。前端是 HTML/CSS/JS（学习成本≈0，你已会 Python 但不熟 JS 则中等），Rust 侧只在需要窗口/托盘/文件监听时写，量不大但生命周期与 `Send + Sync` 会咬人。**单人项目的真实风险是「半年后回来看不懂自己写的 Rust」**。
- **Electron**：单栈 JS/TS。主进程/渲染进程/IPC 三段式是唯一的概念负担，但文档与示例最多，出问题搜得到答案。
- **Flutter**：单栈 Dart + Widget 树。语言易学（类 Java/Kotlin），但「一切皆 Widget + 约束向下、尺寸向上」的布局模型与 Tk 的 pack/grid 直觉差异大；桌面端 Fine-grained 控件（右键菜单、拖拽排序、原生标题栏）都要自己搭。

#### 3.3.3 生态与组件

- Web 系（Tauri/Electron）可直接用成熟设计系统（Tailwind、shadcn/ui、Radix、Framer Motion 等），「更好看」的上限最高，也最容易做出「现代应用」质感。
- Flutter 的 Material/Cupertino 组件开箱即用、动画一致性强，但**桌面气质**（密度、右键菜单、键盘导航）要自己调，社区桌面组件质量参差。
- 单文件 1,594 行的现状意味着：换栈后代码量会涨（前端拆组件 + 构建配置），维护「一个文件」的简单性会消失。

### 3.4 桌面集成逐项核对

前提：本项目窗口形态是「无边框 + 贴在壁纸之上、普通窗口之下 + 不进任务栏 + Win+D 可见 + 可点击穿透（未来）」。逐项如下。

| 能力 | Tauri 2 | Electron | Flutter |
|---|---|---|---|
| **always-on-bottom** | 官方 `always_on_bottom(true)`，但**创建瞬间不生效**（#9597，2024-04-29 以 `not_planned` 关闭；需 `.focused(false)` 规避，报告者称仍会闪一下）［社区］ | **无公开 API**。#6399「Always on bottom functionality?」2016-07-08 建、次日即关（completed），只提供 `alwaysOnTop`。源码里有内部 `behind_task_bar_` + `MoveBehindTaskBarIfNeeded()`（`SetWindowPos(hwnd, Shell_TrayWnd, …)`），非文档化接口［源码］［社区］ | `window.isAlwaysOnBottom = true`（window_manager，基于 nativeapi）［官方文档］ |
| **skip_taskbar** | `skip_taskbar(true)`，但 Windows 上**不可靠**：#10422 open（2024-07-30 建、2026-07-13 更新）。根因是 tao 用 `ITaskbarList::DeleteTab/AddTab` 而非改扩展样式；维护者拒绝内置 `WS_EX_TOOLWINDOW` 做法，需自己 `SetWindowLongPtr`［社区］ | `win.setSkipTaskbar(true)`；`type: 'toolbar'` 在构造时直接加 `WS_EX_TOOLWINDOW`（源码确认）●［源码］ | `window.isVisibleInTaskbar = false` ◐ |
| **Win+D 存活** | #14461：即便 `minimizable: false`，Win+D 仍会最小化窗口［社区］ | **未查到**对应 issue/文档；需自测 | **未查到** |
| **点击穿透** | `set_ignore_cursor_events(true)` → `IGNORE_CURSOR_EVENT`［官方文档］ | `setIgnoreMouseEvents(true, {forward:true})` → `WS_EX_TRANSPARENT｜WS_EX_LAYERED` + 可选 forward［源码］ | `window.setIgnoreMouseEvents(ignore, forward)` ◐ |
| **PerMonitorV2** | 未取到源码级证据（tao 侧应有设置）；**未查到** | Chromium 按显示器渲染，未取到源码级声明；**未查到** | **未查到**（需实测） |
| **中文 IME** | **#16391 open**（2026-10-24 建，2026-11-12 更新，status: upstream）：同应用多窗口间切换后，候选窗跑到屏幕 (0,0)；复现于 **2.12.5 / wry 0.57.1 / tao 0.37.2 / WebView2 142.0.3595.69**，微软拼音与微信输入法均中招；关联 wry#1908、tauri#15436、WebView2Feedback#5675［社区］ | Chromium 输入法栈长期打磨，多窗口 IME 问题少；**未查到**具体待修 issue ◐ | Windows IME 有官方支持（3.x 起）；细节 bug 编号**未查到** ◐ |
| **托盘** | 内建 `TrayIconBuilder`（v2 起）● | 内建 `Tray` ● | `tray_manager` 第三方 ◐ |
| **通知** | `plugin-notification` ● | 内建 `Notification` ● | `local_notifier`/`flutter_local_notifications` 第三方 ◐ |
| **单实例** | `plugin-single-instance` ● | `app.requestSingleInstanceLock()` ● | 需第三方或手写（window_manager 文档有教程）◐ |
| **文件监听** | `plugin-fs` watch / `notify` crate ● | `fs.watch`（跨平台不齐）或 `chokidar` ● | `watcher` 包 ◐ |
| **贴到壁纸层（WorkerW/Progman）** | 社区插件 `tauri-plugin-wallpaper`（4.1.0），宣称 pinned 窗口能存活「显示桌面」——**与核心 #14461 冲突，未独立验证**［社区］ | 需自己写 Win32（`SetParent` 到 `WorkerW`/`Progman`）○ | 需 FFI 调 `win32` 包 ○ |

**这一节的结论**：三者的差距不在「有没有办法」，而在**默认体验**。
- Tauri 的 API 面最像「原生应用框架」，但 Windows 窗口层的坑最多、修复周期以年计（#10767 从 2024-08 开到 2026-10 才关）。
- Electron 缺 always-on-bottom 这一块，其余靠成熟的 `native_window_views` 实现，反而最稳；但你要自己补 Win32。
- Flutter 的 `window_manager` 表面上最全（连 `isAlwaysOnBottom` 都有），但底层刚重写到 nativeapi，自述 “Work in Progress: the API is under active development”，且要求 Flutter 3.50/Dart 3.14——**这是维护风险，不是功能缺失**。

**兜底能力**：三者都能直接调 Win32。Tauri 用 `windows` crate（Rust），Electron 用 `node-ffi-napi`/native addon 或 `koffi`，Flutter 用 `win32` + `ffi` 包。也就是说「贴桌面 + 不进任务栏 + Win+D 复原」这套现有 88 行胶水（todo.pyw:236–323）在任何栈都能重写，代价是 2–4 人日 + 自己扛 bug。

### 3.5 迁移成本

#### 3.5.1 现状代码的可复用性拆解（实测·本项目）

| 层 | 位置 | 行数量级 | 可复用性 |
|---|---|---|---|
| 行模型/解析/序列化/子树/面板 parts | todo.pyw:74–235 | ≈160 | **纯逻辑，可移植**（Python 保留 or 逐行翻译） |
| Win32/桌面胶水 | todo.pyw:236–323 | ≈88 | 必须按新栈重写 |
| 列表渲染 + 行内编辑 + 结构编辑 | todo.pyw:553–946 | ≈390 | 逻辑可参考，控件要重建 |
| 详情面板 | todo.pyw:947–1340 | ≈390 | 同上，UI 最大块 |
| 文件读写/轮询/保存/配置 | todo.pyw:488–529, 898–903, 1399, 1478–1490 | ≈200 | 逻辑可移植（行保真是硬约束） |
| 拖拽/缩放/主入口 | todo.pyw:1452–1476, 1511–1594 | ≈160 | 重写 |

**行保真是最大风险**：只改被编辑行、保留缩进/BOM/CRLF、不重排。这条在 Python 里已经跑通，换语言重写时最容易回归。

#### 3.5.2 三条迁移路径

**路径 A：Tauri 2 + Python sidecar（保留核心逻辑）**

- Rust 壳 + 窗口/桌面胶水 + `tauri.conf.json`：估 4–6 人日（含 skip_taskbar/Win+D 兜底调试）
- 前端列表/编辑/详情/拖拽（HTML/CSS/JS）：估 7–11 人日
- sidecar 协议（JSON 行模型、增量写回、生命周期）：估 2–3 人日
- 打包（`bundle.externalBin` + 带 `-$TARGET_TRIPLE` 后缀、PyInstaller 双产物、签名）：估 1–2 人日
- **合计 14–22 人日**（业余 6–8 小时/周 ≈ 1.5–2.5 个月）［估算］
- 代价：长期维护两个运行时；sidecar 保留 Python（Tk 运行时 ≈13.4MB 可裁掉，但 Python 本身几 MB + 启动开销）；官方文档将 sidecar 定位为 “temporary bridge, not the long-term architecture”［官方文档］

**路径 B：Electron**

- 主进程（窗口/托盘/单实例/IPC）+ 渲染层：估 9–15 人日
- 若保 Python 核心作子进程：+2–3 人日（协议与打包）
- 若把行模型翻译成 TS（约 200–300 行）：+3–5 人日，换来单运行时
- **合计 12–20 人日（保 Python）/ 16–26 人日（全 TS）**［估算］

**路径 C：Flutter 全重写**

- Dart 领域层（行模型/序列化/子树/面板 parts，250–350 行）：3–5 人日
- UI（虚拟列表、行内编辑器、详情面板、拖拽、右键菜单，1,200–1,800 行）：10–15 人日
- 桌面集成（window_manager / tray_manager / 单实例 / 通知 / 文件监听）：2–4 人日
- 打包签名（MSIX 或 Inno）：2–3 人日
- **合计 18–28 人日**；不确定性最大（无 Python 复用、Dart 学习、IME/DPI 需自测、nativeapi 处于 WIP）［估算］

#### 3.5.3 与「不换栈」的改造对比

| 改造项 | 成本（估） | 换栈后还需要吗 |
|---|---|---|
| 虚拟列表/增量重绘 | 1–2 人日 | 需要（都要重做） |
| PMv2 声明 + 字体渲染调优 | 0.5–1 人日 | Tk 上只能部分缓解；换栈后由栈负责 |
| 设计系统（配色/间距/状态/动效） | 3–5 人日 | 需要（且是新栈的主要工作量） |
| 圆角/阴影/毛玻璃 | Tk 基本做不到 | 换栈才有 |

也就是说：**「美化」的 4–6 人日投入在任何路线都躲不掉；换栈额外买的是「圆角/阴影/动效/组件生态」，代价是 10–20 人日的重写 + 200MB 级内存。**

### 3.6 长期维护

| 风险 | Tauri 2 | Electron | Flutter |
|---|---|---|---|
| 大版本迁移 | 2→3 在 alpha（alpha.6 @2026-11-06），破坏面清单**未查到**；2.x 支持窗口**未查到**官方承诺 | 8 周一个稳定版，3 版支持窗口 → 每年约 6 次被迫升级，旧线只收安全补丁。单人估 0.5–1 人日/次，**3–6 人日/年**［估算］ | 框架演进快；桌面插件跟版滞后（window_manager 新版直接要求 Flutter 3.50，旧 API 移入 `legacy.dart` 待删） |
| 依赖健康 | 官方插件质量稳定；社区插件（wallpaper）单点 | 生态最大，弃坑包多但替代多 | 桌面端插件多为个人维护（tray_manager、window_manager 均为 leanflutter 系） |
| 平台 bug 修复速度 | 窗口层 bug 以年计（#10422 开两年半、#10767 两年两个月） | 窗口层最成熟 | 未见系统性数据 |
| 单人认知负担 | 两栈（Rust + Web） | 一栈（JS/TS） | 一栈（Dart） |

## 4. 三种权重下的推荐

> 不替你拍板。以下是「如果这一条是第一位，选谁、付什么」。

### 4.1 低占用优先

**首选：不换栈**，把 1–2 人日投在虚拟列表 + PMv2 + 设计系统上。理由：换到任一栈，空闲内存都从 30MB 级跳到 200MB 级（实测基准 197–407MB），而你现在的 0.17–0.28s 热启在三者里也只在 Flutter 面前有优势。

**若必须换（因为「完整应用 + 美化」是硬需求）**：
- **Tauri 2**：空闲 private 212.3MB（三者最低之一）+ 磁盘 4.1MB + 安装包 1.3MB；但 working set 407.2MB 最高、7 进程。
- **Flutter**：working set 197.0MB / private 207.2MB 最低、单进程，但冷启 3s 违背「低干扰」。
- **不要选 Electron**：磁盘 357MB、安装包 116MB、WS 348MB，三项都垫底。

### 4.2 开发便利优先

**首选：Electron**。单栈 JS/TS、DevTools、`electron-builder` 全自动签名打包、`electron-updater` 最成熟、遇事搜得到答案。代价是接受最大占用与磁盘，并自己补 always-on-bottom 的 Win32 代码。
**次选：Tauri 2**（前端同栈，但要写 Rust，且窗口层要自己填坑）。
**不推荐：Flutter**（新语言 + 新布局模型 + 全重写，与「便利」相反）。

### 4.3 美化上限优先

**Tauri ≈ Electron（并列）**：都是 Web 渲染，CSS 的圆角/阴影/毛玻璃/动效上限最高，设计系统与组件库最成熟；Electron 胜在调试与打包省事，Tauri 胜在体积与（理论上的）更低内存。
**Flutter**：自绘一致性强、动画流畅可控，但「桌面质感」要自己调，组件生态偏移动端。
**Tk 出局**：无圆角/阴影/逐窗口透明，`wm` 只有整窗 `-alpha`，只有 `-topmost` 没有 `-bottommost`。

## 5. 三者中「更高性能 + 更小占用 + 更方便开发」能否同时成立？

**不能。** 冲突点具体是三条：

1. **「小占用」与「小体积」不是同一件事。** Tauri 把磁盘压到 4.1MB（比 Electron 小 87 倍），但运行时仍是 Chromium：private 212.3MB、WS 407.2MB、7 进程。**省的是磁盘，不是内存。** 要真低内存只能靠 Flutter 的单进程自绘（197MB WS），而它冷启 3s。
2. **「方便开发」与「低占用」反向。** Electron 的开发体验来自「自带整个 Chromium + Node」，这份便利正是 357MB 磁盘与 348MB 内存的来源。Tauri 用系统 WebView2 换掉打包体积，代价是 Rust 侧工作量 + 依赖系统运行时版本 + 窗口层 bug 要自己扛。
3. **「更高性能」必须分项。** 冷/热启动：Electron 最快（725/546ms），Flutter 最慢（3067/2336ms）。内存：Flutter 最低。磁盘：Tauri 最低。交互延迟：三者同量级（load 50–126ms），IPC 是 Tauri 最慢（1629ms/1000 次）。

**因此正确的问法不是「谁赢」，而是「你愿意在哪一轴上让步」。**

## 6. 什么新事实会改变结论

| 若发生 | 结论如何变 |
|---|---|
| Tauri 修掉 #10422（skip_taskbar）与 #14461（Win+D） | 「贴桌面 + 不进任务栏」在 Tauri 上变成一等公民，低占用优先下 Tauri 明显领先 |
| WebView2 的 `MemoryUsageTargetLevel=Low` / app-level process sharing 有实测把 idle 压到 <100MB | Tauri 翻盘，「小体积 + 低内存」同时成立 |
| Flutter 引擎把冷启做到 <500ms（或提供预热/常驻方案） | Flutter 的「低干扰」短板消失，凭 197MB WS + 单进程成为低占用首选 |
| Electron 提供官方 always-on-bottom | 便利优先路线不再有硬缺口 |
| 你决定「完整应用 = 普通窗口，不再贴桌面」 | 桌面集成一整节（always-on-bottom / skip_taskbar / Win+D / 壁纸层）失效，权重全转向美化与开发效率，Electron/Tauri 的选择变简单 |
| 你接受「美化 = 比现在好看一档」（换主题 + 圆角卡片 + 动效） | Tk 上做不到圆角/阴影，仍需换栈；但若只做「配色 + 间距 + 字体」，Tk 改造 2–4 人日即可，不必重写 |
| Tauri 3 发布稳定版并给出 2.x 支持承诺 | Tauri 的长期维护风险下调一档 |

## 7. 风险与未知

**本报告未做的测量**（约束：只读仓库、不构建、不运行）：
- 三栈在本机双 4K@200% 下的清晰度、字体渲染、IME 行为——**全部未实测**。
- Tauri/Electron/Flutter 在本机的冷热启动与内存——引用的是外机基准，不能当本机数字。
- 迁移工时的置信区间很宽（±50%），尤其「行保真写回」与 sidecar 生命周期。

**已识别的风险**：
- Flutter 的 `window_manager` 依赖 WIP 的 nativeapi，且要求 Flutter ≥3.50；一旦要升级框架，桌面层可能被迫跟改。
- Tauri 2→3 alpha 期的破坏面未知；3.0 稳定前不宜投入大量 Rust 侧代码。
- Electron 每年 3–6 人日的跟版成本对业余项目是持续税。
- sidecar 方案长期双运行时，官方自己说它是「临时桥」。
- 基准的 Flutter 滚动数字受 60Hz 节流影响，不可用来判定「Flutter 滚动卡」。

**来源冲突（如实列出）**：
1. SEO 营销文称 Tauri「空闲 30–50MB、安装包 8–12MB、冷启 <200ms」，与有方法学的实测（212.3MB private / 1.3MB 安装包 / 1162ms 冷启）差一个数量级，且无测量方法 → **不采用**。
2. `tauri-plugin-wallpaper` 宣称 pinned 窗口能存活「显示桌面」，而核心 issue #14461 说 Win+D 仍会最小化 → **未独立验证，两者并列保留**。
3. 关于「Tauri 是否能在 Windows 上稳定地不进任务栏」：#10422 的维护者立场（拒绝内置 TOOLWINDOW）与社区「能稳定做到」的经验冲突 → 本报告按「需要自己写兜底」处理。

## 8. 来源清单

**版本与工程事实**
- Tauri 版本：`https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri/Cargo.toml`［源码］
- Tauri v3 alpha 发布：`https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.6`［官方文档］
- Electron 最新版：`https://api.github.com/repos/electron/electron/releases/latest`（v45.3.1）［官方文档］
- Electron 支持周期：`https://github.com/electron/electron/blob/main/docs/tutorial/electron-timelines.md`［官方文档］
- Flutter 版本 tag：`https://api.github.com/repos/flutter/flutter/git/matching-refs/tags/3.50`［源码］
- Flutter 桌面状态：`https://docs.flutter.dev/desktop`（本机 DNS 无法直读）［官方文档·未直读］

**性能基准**
- `https://github.com/adarSonmez/desktop-framework-benchmark`（README、`results/latest/report.md`、`spec/BENCH_PROTOCOL.md`）［实测·第三方］
- WebView2 性能与启动：`https://github.com/MicrosoftDocs/edge-developer`（经 GitHub 源仓库）［官方文档］
- 本项目历史实测：`docs/research/desktop-widget-tech-stack.md`［实测·本项目］
- Tk DPI 缺陷：`https://github.com/python/cpython/issues/119459`［社区］

**桌面集成 / 缺陷**
- Tauri #9597（always_on_bottom 创建时不生效）：`https://github.com/tauri-apps/tauri/issues/9597`［社区］
- Tauri #10422（skip_taskbar 不可靠）：`https://github.com/tauri-apps/tauri/issues/10422`［社区］
- Tauri #14461（Win+D 仍最小化）：`https://github.com/tauri-apps/tauri/issues/14461`［社区］
- Tauri #16391（中文 IME 候选窗定位，open）：`https://github.com/tauri-apps/tauri/issues/16391`［社区］
- Tauri #15436（IME 组合异常）：`https://github.com/tauri-apps/tauri/issues/15436`［社区］
- Tauri #10767（拖拽区吞 mouseup，2026-10-28 关闭）：`https://github.com/tauri-apps/tauri/issues/10767`［社区］
- Electron #6399（Always on bottom，已关闭无此功能）：`https://github.com/electron/electron/issues/6399`［社区］
- Electron 窗口实现：`https://github.com/electron/electron/blob/main/shell/browser/native_window_views.cc`［源码］
- window_manager：`https://github.com/leanflutter/window_manager`［官方文档］
- nativeapi（WIP 声明）：`https://github.com/libnativeapi/nativeapi`［官方文档］
- Tauri sidecar 定位与打包：仓库内 `.scratch/research/tauri-evidence-2026-11-12.md`（经 GitHub 源仓库取证）［官方文档］

**本项目代码事实**
- `todo.pyw:74–235` 行模型；`todo.pyw:236–323` Win32 胶水；`todo.pyw:553–946` 列表与编辑；`todo.pyw:947–1340` 详情面板；`todo.pyw:1534` `SetProcessDpiAwareness(1)`［源码］
- 空闲 30–36MB / 热启 0.17–0.28s / 800 行 2538ms：`docs/research/desktop-widget-tech-stack.md`［实测·本项目］
