# 贴桌面 Markdown 待办小组件：技术栈选型调研

> _文中引用的 `todo.pyw` 与行号对应当时的 Tk 源码，该文件已于 2026-11 从仓库删除（[ADR 0006](../../docs/adr/0006-remove-tk-fallback.md)）；需要原物时从 git 历史取。_

- 调研对象：本仓库 `todo.pyw`（989 行 / 39,028 字节，纯 Python 3 标准库 + Tkinter，`pythonw` 直接运行，无打包产物）
- 目标平台：Windows 10/11 x64（仅此）
- 核心诉求：**最快、最轻**，同时必须满足"壁纸之上、普通窗口之下、不占任务栏、Win+D 后仍可见"
- 调研日期：2026-11-10；本机环境：Windows 11 Pro 26200 / i7-12700（12C20T）/ 31.7 GB RAM
- 方法：读 `todo.pyw` 源码 + 本机轻量实测（不改仓库、不装卸任何工具链）+ 一手文档与源码核查
- 证据等级约定见 §2；**没有一手来源的数字一律标为估算或"未查到"**，全文不编造

---

## 0. 结论（先看这段就够决策）

### 0.1 一句话推荐

**不换栈。** 继续用 Python + Tkinter，把力气花在"能分发、能自启、DPI 正确"三件事上；只有当目标从"自用"变成"对外发布/需要现代 UI 组件"时，才考虑用 **Tauri 2** 重写外壳——这是唯一在"桌面层 + 体积"两项拿满分的现代替代，但它在"冷启动 + 内存"两项会明确倒退。

### 0.2 三条支撑理由

1. **现状已经在"轻"的第一梯队，且是实测的**：冷启动到窗口可见 168–278 ms（5+3 次样本，中位 192 ms，热缓存；冷缓存首启见 §3.3），10 秒空闲工作集 30–36 MB，1 秒轮询的空闲 CPU ≈ 0.16% 单核【实测】。能明显低于这个数的只有 Win32 原生（理论量级）与 egui/Slint（但见 §6.5 的代价）。Electron 是它的 5 倍体积、WebView2 系是它的多进程内存模型。
2. **最难的一维（桌面层集成）已经被解决，而换栈要重解一遍**：`todo.pyw:144-192` 用"顶层窗口压到 Z 序底 + 把 Progman 垫到下面 + `WS_EX_TOOLWINDOW`"实现贴桌面，`todo.pyw:814-838` 在 1 秒轮询里兼做 Win+D 复原与 Z 序维持。换到别的栈，要么有等价 API（Tauri 2、Qt），要么退回自己写 P/Invoke（Electron、WPF、WinUI 3、Flutter、Avalonia）。
3. **迁移真正贵的不是 UI，是"只改被编辑的那一行"这个不变量**：`class Line`（`todo.pyw:53-72`）、`parse_line()`（75-91）、`serialize()`（98-99）、`toggle_raw()`（102-106）、`set_line_text()`（109-120）共同保证全文只有被编辑行变化、勾选原位翻转、保留缩进/BOM/CRLF。任何富文本控件（WPF RichTextBox、Qt QTextDocument、浏览器 contenteditable）都会在"读入→改→写回"过程中重排 Markdown 格式，这条不变量必须在新栈里重新实现并重新验证，风险与工作量都落在最容易回归的地方。

### 0.3 物理最优与工程最优不是同一件事

| 口径 | 赢家 | 代价 |
| --- | --- | --- |
| 纯物理"最轻"（无运行时、内存最小、二进制最小） | Win32 + Direct2D | 文本编辑、IME 组字、命中测试、Markdown 往返全部自绘；对本项目是 5–10 倍工作量 |
| 物理上"够轻且可维护" | Python + Tkinter（现状） | 需要自己补打包/自启/DPI；UI 观感停留在 2010 年代 |
| "必须换栈"时的最优 | Tauri 2 | 冷启动与内存倒退；行保真解析要用 Rust/TS 重写 |

### 0.4 什么情况下这个结论会翻转

| 触发条件 | 建议改投 | 理由 |
| --- | --- | --- |
| 要发给别人用（现在零打包产物，别人根本跑不起来） | **先打包（PyInstaller onedir）**，不是换栈 | 打包只花 1–2 天，换栈要 2–4 周【估算】 |
| 需要动画/自绘/复杂排版、或想要 Web 生态 UI | Tauri 2 | 置底/不进任务栏是一等 API，见 §5 |
| 单指"常驻内存"、能接受开发成本翻倍 | egui（需自带 CJK 字体）或 Slint | 理论更省，但缺现成富文本编辑与置底 API 的成熟度，见 §6.5 |
| 需要长期稳定、可招人维护、跨平台可能 | Qt Widgets（C++） | `Qt::WindowStaysOnBottomHint` 在 Windows 对 frameless 窗口有效，见 §5 |
| 团队已有 .NET 栈、需要托盘/自启/安装器一条龙 | WPF | 但体积下限被 .NET Desktop Runtime 锁死在 55.7 MB 安装器【实测】 |

---

## 1. 把"最快、最轻"拆成可度量维度

"最快最轻"必须落到可测指标，否则无法比较。本报告的五个维度与权重（面向**作者自用**这一当前事实）：

| # | 维度 | 定义（怎么测） | 权重 | 为什么是这个权重 |
| --- | --- | --- | --- | --- |
| D1 | 冷启动到首帧 | `pythonw`/exe 进程创建 → 第一个可见窗口出现（ms，冷启动=进程不在文件缓存热态之外的首次） | 20% | 用户每次开机/每次重启组件都会遇到；但一天只遇到几次，不是主要体感 |
| D2 | 常驻内存 | 空闲 10 s 的 Working Set（MB），工作态另记 | 20% | 常驻 24 h 的组件，内存是持续成本；也是"轻"最直观的口径 |
| D3 | 分发体积 | 用户机器上需要新增的字节（含运行时）；若运行时预装则记 0 但要注明 | 15% | 现状是"自己机器上已装 Python"所以为 0；一旦分发就变成硬成本 |
| D4 | 桌面层集成 | 置底/不进任务栏/透明/点击穿透/多屏 DPI：是原生 API 还是要 interop，Win+D 后是否稳定 | 20% | 这是本项目的**存在理由**，做不稳就不是这个产品；且它是移植时最容易踩坑的一维 |
| D5 | 开发与运维 | 实现本功能清单的代价、迁移成本、打包/签名/更新/崩溃排查成熟度 | 25% | 单人业余项目，可维护性直接决定项目能不能活下去 |

> 说明：权重不是客观真理，§4.3 给了灵敏度分析——把 D5 权重清零、或把 D2 提到 50%，结论是否变化。结论是：**都不翻盘**。

---

## 2. 证据等级标记

| 标记 | 含义 |
| --- | --- |
| 【实测】 | 本次在本机测量，方法见 §10，可复现 |
| 【一手】 | 官方文档 / 官方仓库源码 / 规范 / release notes，链接见 §11 |
| 【估算】 | 由已知组件或进程模型推算，**没有一手数字**，仅用于给量级 |
| 【未查到】 | 查过但没有可靠数据，不猜 |

---

## 3. 现状基线（全部实测）

| 指标 | 数值 | 方法 | 等级 |
| --- | --- | --- | --- |
| 冷启动到首个可见窗口 | 168 / 170 / 185 / 185 / 199 / 247 / 267 / 278 ms（8 次，中位 192） | 复制 `todo.pyw` 到临时目录仅改 Mutex 名，C# `EnumWindows` + `Stopwatch` 轮询；`float` 测试模式不写 `config.json` | 【实测】 |
| 裸 Tk 窗口（对照） | 125–150 ms | 同上，最小 Tk 脚本 | 【实测】 |
| `pythonw -c pass` 生命周期 | 46–56 ms | 同上 | 【实测】 |
| `_tkinter` / `tkinter` 导入 | 11.5 ms / 14.5 ms | `python -X importtime` | 【实测】 |
| 空闲工作集（小文件） | 30.2 MB WS / 15.7 MB Private / 204 handles | 启动后 10 s 采样 | 【实测】 |
| 空闲工作集（226 行文件） | 34.8 MB WS / 19.8 MB Private | 同上 | 【实测】 |
| 用户长期实例（已跑 ≈16 h） | 35.7 MB WS / 27.8 MB Private / 296 handles / 2 线程 | `Get-Process` | 【实测】 |
| 空闲 CPU | 10 s 内 0.016 s CPU ≈ 0.16% 单核 | `Get-Process` 两次采样差值 | 【实测】 |
| Tk/Tcl 运行时磁盘 | ≈13.4 MB（`tcl86t.dll` 1.8 + `tk86t.dll` 1.5 + `tcl8.6\` 3.2 + `tk8.6\` 1.5 + `Lib\tkinter` 1.2 + `_tkinter.pyd` 0.06 + `python39.dll` 4.3） | 文件系统 | 【实测】 |
| 本机 Python | 3.9.18（conda），Tk 8.6 / Tcl 8.6 | `python -c` | 【实测】 |
| Python 3.9 支持状态 | **end-of-life** | 官方版本表 | 【一手】[devguide](https://devguide.python.org/versions/) |
| 代码量 | 989 行 / 39,028 B，LF-only、无 BOM | `python` 读二进制：`count(b"\n")`=989、`splitlines()`=989 | 【实测】 |

### 3.1 原生下限（Lead 补测）

用 VS 2022（MSVC 14.44.35207）编译一个只创建空窗口的 Win32 C++ 程序（101,376 B）作标尺：WS 8.9–9.4 MB / Private 1.3–1.4 MB，首个可见窗口 27–60 ms（首次 177 ms）；加 20 个 STATIC 子控件仍是 9.0 MB / 36–59 ms。这是"自己写 Win32"的物理下限，不含任何文本编辑能力。

### 3.2 列表渲染成本（Lead 补测）

现状每次勾选/编辑都走 `render_list()` 销毁并重建全部行（`todo.pyw:370-391`）。把 `todo.pyw` 当模块导入、`TEST_MODE=True`、生成 N 行 Markdown 后计时（末尾 `update_idletasks()`，每档 1–2 次）：

| 行数 | `load_file()`（解析+重建） | `toggle_line(1)`（改一行+重建） |
| --- | --- | --- |
| 20 | 82 ms | 68 ms |
| 50 | 126 ms | 160 ms |
| 200 | 448 ms | 609 ms |
| 800 | 1,844 ms | 2,538 ms |

`resize` 仅 1–2 ms。→ 线性增长，成本在控件重建而非布局；20 行已可感知，50 行 160 ms，200 行 0.6 s。**这是本项目最大的体感短板，且与 GUI 栈无关，只与渲染策略有关**（修法见 §7 P1.5）。

### 3.3 冷启动口径

§3 主表的 168–278 ms 是**缓存热态**：把 `todo.pyw` 复制到新目录后的首次启动（文件缓存冷）实测 0.89–1.04 s，第二发起回到 0.17–0.22 s。开机自启处于两者之间，取决于 SysMain/杀软是否已缓存。

**基线结论**：现状的"快"是 0.2 秒级（冷缓存 <1.1 s）、"轻"是 30–36 MB 级；重写的最优收益上限约 25 MB 内存 + 150 ms 启动（§3.1），量级不变。真正卡体感的是列表全量重建（§3.2，200 行 0.6 s）与分发依赖本机 Python（§7 P0），两者都不需要换栈。任何候选要"赢"，必须在这两个数上明显更好，且不能在 D4 上倒退。

---

## 4. 评分矩阵

### 4.1 主表（0–5 分，越高越好；加权总分=Σ 分×权重）

| 候选 | D1 冷启动 20% | D2 内存 20% | D3 体积 15% | D4 桌面层 20% | D5 开发运维 25% | **加权** | 排名 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Python + Tkinter（现状）** | 4 | 4 | 4 | 4 | 5 | **4.25** | 1 |
| Win32 + Direct2D（基线） | 5 | 5 | 5 | 5 | 1 | 4.00 | 2 |
| egui（Rust） | 4 | 3.5 | 4 | 4 | 2 | 3.40 | 3 |
| PySide6（Qt for Python） | 2.5 | 2.5 | 2 | 5 | 4 | 3.30 | 4 |
| Tauri 2（Rust + WebView2） | 2 | 2 | 5 | 5 | 2.5 | 3.18 | 5 |
| WinForms | 3 | 3 | 3 | 3 | 3.5 | 3.13 | 6 |
| Qt Widgets（C++） | 3 | 3 | 2 | 5 | 2.5 | 3.13 | 6 |
| Slint（Rust） | 4 | 4 | 4 | 1.5 | 2 | 3.00 | 8 |
| WPF | 2.5 | 3 | 3 | 3 | 3 | 2.90 | 9 |
| Avalonia | 2.5 | 3 | 3 | 2.5 | 3 | 2.80 | 10 |
| Flutter desktop | 3 | 2 | 2 | 2 | 2.5 | 2.33 | 11 |
| WinUI 3 | 2 | 2.5 | 2 | 1.5 | 2 | 2.00 | 12 |
| Electron | 1 | 1 | 1 | 2.5 | 3 | 1.80 | 13 |

> **怎么读这张表**：它是"作者自用当前场景"的综合分，不是"现代化程度"排名。Tauri 排第 5，却是"如果必须换栈"的第一选择（§6.2）——因为它的失分项（冷启动、内存）在本项目里是"体感变差"，而它的得分项（桌面层 API、分发体积）恰好是最难自建的两项。同理，Win32 排第 2 但只适合做基线，不适合当产品。

### 4.2 打分依据（逐条，便于反驳）

**D1 冷启动**
- Python+Tk = 4：实测 0.17–0.28 s，是本表唯一有本机一手数据的栈。
- Win32 = 5：无运行时、无解释器/JIT/浏览器进程，理论下限【估算】。
- egui = 4：单可执行、无运行时，但需加载 8 MB 级 CJK 字体（见 §6.5）【估算】。
- Slint = 4：同上，官方称 runtime <300 KiB RAM【一手】。
- Tauri = 2：WebView2 "冷启动必须拉起进程与磁盘缓存，会带来可感知的延迟"【一手】；具体 ms 无官方数字【未查到】。
- Electron = 1：Chromium 全量 + Node 主进程，体积 150.9 MB 的同一套运行时【实测的体积 + 一手进程模型】。
- .NET 系（WPF/WinForms/WinUI/Avalonia）= 2–3：JIT/框架初始化 + 运行时装配；无官方 benchmark【未查到】，本机 PS 宿主测量不可用（§9.3），只能给 2–3 的量级判断【估算】。
- PySide6 = 2.5：Python 启动（≈0.05 s【实测】）+  Qt 库加载；无官方数字【未查到】【估算】。
- Qt C++ = 3：无解释器，但需加载 Qt DLL 与平台插件【估算】。
- Flutter = 3：AOT 的 Dart + Skia/Impeller 初始化【估算】。

**D2 内存**
- Python+Tk = 4：30–36 MB 实测【实测】。
- Win32 = 5：无运行时，理论最小【估算】。
- egui = 3.5：即时模式 + 字形图集（CJK 字形缓存按需增长）【估算】。
- Slint = 4：官方只声明 runtime <300 KiB，整进程 RSS 无数据【一手声明/【未查到】总量】，分数保守。
- Tauri = 2：WebView2 "每个控件都会拉起自己的 browser/renderer/GPU 进程，增加内存与启动开销"【一手】；无官方 MB 数【未查到】。
- Electron = 1：同引擎家族的多进程模型 + Node 堆【一手进程模型】；量级 100–300 MB【估算】。
- WPF/WinForms/WinUI/Avalonia = 2.5–3：托管运行时 + 框架图形栈；无一手数字【未查到】【估算】。
- Qt = 3：Qt Widgets 常驻量级 40–80 MB【估算】。
- Flutter = 2：引擎 + Dart VM isolate【估算】。

**D3 体积（"用户机器上要新增的字节"口径）**
- Python+Tk = 4：现状 0（依赖本机 Python）；打包后 onedir ≈20–25 MB【估算，由 §3 的 13.4 MB Tk/Python 运行时外推】。
- Tauri = 5：exe 未知【未查到】，但 WebView2 在 Win10 1803+ / Win11 已预装【一手】→ 新增字节接近"一个 exe + 前端资源"。
- Electron = 1：官方 release 的 `electron-v45.2.3-win32-x64.zip` = **150.9 MB**【实测】。
- Win32 = 5：<1 MB 量级【估算】。
- egui = 4：单 exe + 字体（NotoSansSC-Regular.otf 实测 7.9 MB，可子集化）【实测字体大小/【估算】总体积】。
- Slint = 4：同上【估算】。
- .NET 系 = 3：**框架依赖**需 .NET Desktop Runtime——官方 8.0.33 x64 安装器 **55.7 MB**、zip 35.1 MB【实测 HEAD Content-Length】、本机 8.0.0 安装后目录 **89.6 MB**【实测】；**自包含**体积无官方数字【未查到】，且 WPF/WinForms 的裁剪在 SDK 中被禁用【一手】→ 无法靠 trim 压下来。
- WinUI 3 = 2：.NET 运行时 + Windows App SDK 运行时 + VC++ Redistributable（未打包场景需自行部署）【一手】。
- Qt C++ = 2：windeployqt 收集 Qt DLL/插件 + 需官方 VC++ Redistributable【一手】；MB 数无官方【未查到】。
- PySide6 = 2：`PySide6-Essentials 6.12.0` win_amd64 wheel **78.3 MB**【实测 PyPI JSON】。
- Flutter/Avalonia = 2–3：无一手数字【未查到】【估算】。

**D4 桌面层**：见 §5 的逐项对照；这是本表里唯一有"原生 API 有无"硬事实的维度，因此分差最大（1.5–5）。给分口径：**5** = 置底 + 不进任务栏都是高层 API 一行属性；**4** = 两者可行但其中一项要绕一点（frameless 前提、或单个 API 缺失需 Win32 兜底）；**3** = 两项都得自己写 Win32（能写，但没人替你维护）；**2.5** = 有平台但缺透明/置底其一，语义不完整；**1.5** = 置底 API 缺失且文本编辑控件也要自建（Slint）。Slint 之所以从 2.5 降到 1.5：它的 Windows 后端没有置底入口（§5 表），必须自己取 HWND 调 `SetWindowPos`，这就退化成"在声明式 UI 框架里做 Win32 互操作"，比 Qt/Tauri 的现成属性贵一档。

**D5 开发与运维**
- Python+Tk = 5：零迁移；解析/文件/桌面层/单实例全部在手；缺的是打包/自启/托盘与 DPI（§7）。
- PySide6 = 4：**可以原样复用**现有 Python 侧的解析、文件、轮询逻辑（约 400 行），只重写 UI 层；但引入 78 MB 依赖。
- WinForms = 3.5：RichTextBox/NotifyIcon 成熟，托盘自启一条龙；Markdown 行保真仍需自写。
- Tauri = 2.5：Rust + 前端两套语言、行保真重写；但置底/不进任务栏/更新器是现成的（§5）。
- WPF = 3 / Avalonia = 3 / Qt C++ = 2.5 / Flutter = 2.5 / WinUI 3 = 2：均需重写行保真模型，其中 WinUI 3 还多一层 MSIX/运行时部署与"无边框透明"缺失（§6.4）。
- egui = 2 / Slint = 2 / Win32 = 1：文本编辑/富交互要自建，本项目最贵的部分在这里。

### 4.3 灵敏度分析（换权重是否翻盘）

| 场景 | 权重设定 | 前四名 | 结论 |
| --- | --- | --- | --- |
| 基准（自用） | D1 20 / D2 20 / D3 15 / D4 20 / D5 25 | 现状 4.25 > Win32 4.00 > egui 3.40 > PySide6 3.30 | 现状第一 |
| 迁移成本清零（假设"重写不要钱"） | D1 25 / D2 25 / D3 25 / D4 25 | Win32 5.00 > 现状 4.00 > egui 3.88 > Tauri 3.50 > Slint 3.38 | 现状仍是第二，且高于所有"真能落地的现代栈" |
| 内存优先 | D2 50%，其余各 12.5% | Win32 4.50 > 现状 4.13 > egui 3.50 > Slint 3.44 | 只有 Win32 能明显赢；Slint 的领先部分只是"runtime 300 KiB"的声明 |
| 对外分发（体积/运维更重要） | D1 15 / D2 10 / D3 25 / D4 20 / D5 30 | 现状（未打包，D3=1）3.55 ≈ Tauri 3.50 > egui 3.35 > PySide6 3.33 > WinForms 3.15 | 未打包时 Tauri 基本追平；P0 打包后现状 D3 回到 4，总分 4.30，重新拉开——**分发场景的胜负手是 P0，不是换栈** |

**读法**：在自用与绝大多数重排权重下，现状领先；唯一接近翻盘的是"对外分发 + 不打包"——目标机没有 Python 时，D3 是 0/1 的可用性问题，不是 20 MB 的体积问题，此时现状 3.55 与 Tauri 3.50 基本持平。P0 打包（1–2 天）把 D3 拉回 4 分，现状回到 4.30，重新拉开。结论：本项目的瓶颈是分发工程与渲染策略，不是栈；即使把 D5 清零，能赢的也只有"开发成本 1 分"的 Win32。

---

## 5. 桌面层集成能力对照（本项目最关键的一维）

需求拆解：① 壁纸之上、普通窗口之下 ② 不进任务栏/Alt+Tab ③ （可选）透明/圆角 ④ （可选）点击穿透 ⑤ 多显示器与 DPI 缩放不糊 ⑥ Win+D 后仍可见。

| 栈 | 置底（壁纸之上） | 不进任务栏 | 透明 | 点击穿透 | 结论 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| **Python + Tk（现状）** | 手写：`SetWindowPos(HWND_BOTTOM)` + 把 Progman 垫到下方 + 轮询维持 Z 序（`todo.pyw:144-192`, `814-838`） | `WS_EX_TOOLWINDOW`（`todo.pyw:162-169`） | Tk 无真透明；本项目也不需要（全窗口不透明） | 无（本项目不需要） | 已验证可用，但靠自己维护 | 项目源码 |
| **Tauri 2** | **一等 API**：`Window::set_always_on_bottom(bool)`；Windows 实现落到 `SetWindowPos(HWND_BOTTOM)` | **一等 API**：`set_skip_taskbar(bool)` | `transparent(true)` | 需 Win32 interop | 最省事 | [docs.rs](https://docs.rs/tauri/latest/tauri/window/struct.Window.html)、[tao window_state.rs](https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/windows/window_state.rs) |
| **Electron** | **无置底 API**（窗口层级只有 `setAlwaysOnTop`）→ 需 Win32 interop | `setSkipTaskbar(skip)`（Windows/macOS） | `transparent: true`（官方提示透明窗口可能留下视觉残留——文档中该提示仅针对 macOS） | 需 interop | 可行但要多写一层 | [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) |
| **Qt（C++ / PySide6）** | **原生**：`Qt::WindowStaysOnBottomHint`；官方注明"**在 Windows 上只对 frameless 或全屏窗口生效**"——本项目窗口正是 frameless | `Qt::WindowDoesNotAcceptFocus`（官方注明在 Windows 上可阻止出现在任务栏）/ `Qt::Tool` | `WA_TranslucentBackground`（Windows 上还需 `FramelessWindowHint`） | `WindowTransparentForInput`（语义上支持输入穿透；Windows 后端实际效果未核实） | Qt 与 Tauri 是仅有的两个"置底+不占任务栏"都有一等 API 的栈；Qt 的差异是不要 WebView2、不要 Rust 运行时，C++/Python 两用 | [Qt WindowType](https://doc.qt.io/qt-6/qt.html#WindowType-enum) |
| **WPF** | 无 → `HwndSource` + P/Invoke 同一套 Z 序手法 | 无 → P/Invoke `WS_EX_TOOLWINDOW` 或 `ShowInTaskbar=false` | `AllowsTransparency=true`，但**必须** `WindowStyle=None`，且是分层窗口 | 需 interop | 可行，代码量 ≈ 现状 | [AllowsTransparency](https://learn.microsoft.com/en-us/dotnet/api/system.windows.window.allowstransparency) |
| **WinForms** | 无 → P/Invoke | 无 → P/Invoke | 需分层窗口/自绘 | 需 interop | 同 WPF | 同上（同一 Win32 层） |
| **WinUI 3** | 无 → P/Invoke | 无 → P/Invoke | **不支持无边框透明窗口**：官方 feature proposal 仍 open | 需 interop | 最不适合本需求 | [#1247（open）](https://github.com/microsoft/microsoft-ui-xaml/issues/1247)、[#7276（closed as duplicate）](https://github.com/microsoft/microsoft-ui-xaml/issues/7276) |
| **egui / eframe** | `ViewportCommand::WindowLevel(WindowLevel::AlwaysOnBottom)`（已有枚举） | 视 winit 后端能力，未逐项核实 | 支持（wgpu/glow） | 需平台层处理 | 可行，但要自己接 | [egui viewport.rs](https://github.com/emilk/egui/blob/main/crates/egui/src/viewport.rs#L969) |
| **Slint** | 未在官方文档找到置底 API【未查到】 | 同上 | 有限 | — | 不确定性高 | [slint.dev](https://slint.dev/) |
| **Flutter desktop** | 无原生 → 依赖第三方 `win32` 包或平台通道 | 同上 | 需插件 | 需插件 | 桌面层生态最薄 | [Flutter Windows](https://docs.flutter.dev/platform-integration/windows/building) |
| **Avalonia** | 无置底 API【未查到】→ P/Invoke | 同上 | `TransparencyLevelHint`（存在，未逐字核实） | 需 interop | 与 WPF 同档 | — |
| **Win32 + D2D** | 完全自控（现状那套手法的"正版"） | 完全自控 | 完全自控 | 完全自控 | 只有它没有"能不能"的问题，只有"写不写"的问题 | [SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)、[扩展窗口样式](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles) |

### 5.1 DPI 与多屏（现状的真实短板）

- 现状调用 `SetProcessDpiAwareness(1)`（system DPI aware，`todo.pyw:930`）。微软文档明确：**system-DPI-aware 应用在 DPI 变化时会被系统位图拉伸，"often results in them being blurry"**，并建议升级到 per-monitor v2（需处理 `WM_DPICHANGED` 并重做布局假设）【一手】[High DPI Desktop Application Development](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)。
- 同一页的框架支持表：WinForms = "limited automatic per-monitor DPI scaling for some controls"，WPF = "native WPF applications will DPI scale"，UWP = full；**Tk 不在表内**（第三方框架普遍不在）【一手】。
- 现状是字号用 pt（`tkfont.Font(family="Microsoft YaHei UI", size=9/10/11)`，`todo.pyw:244-250`）而窗口/行高用像素（如默认 760×1280、`config.json` 的 x=3063 说明作者已在多显示器环境使用）——**pt 与 px 混用**，在 150%/200% 缩放的屏之间移动时需要人工调。
- 结论：多屏 DPI 是现状**唯一**必须修的"硬伤"，且它与是否换栈无关——换到任何非 WPF/Qt 的栈，PMv2 依然要自己处理。

### 5.2 透明其实不是需求

`todo.pyw` 全文没有使用 alpha/透明（只有悬浮模式的 `-topmost`，`todo.pyw:805-809`, `972-979`）。所以 §5 表里"透明"一列只是备选加分项，**不应作为选型的主要依据**；WinUI 3 的透明缺失因此只是"少一个未来的可能性"，不是否决项——它真正的问题是体积/部署链与 D4 全部靠 interop。

---

## 6. 逐栈分析

### 6.1 Python + Tkinter（现状）

- **判定**：综合最优，且是唯一"零迁移"选项。
- 冷启动 168–278 ms、内存 30–36 MB、CPU 0.16%【实测】；这已经优于绝大多数"现代"方案。
- **冻结打包后的代价**：PyInstaller `onefile` 会把自身解压到 `_MEI{xxxxxx}` 临时目录，官方文档称"single executable is a little slower to start up than the one-folder bundle"、"This can take a little time"【一手】[PyInstaller operating mode](https://pyinstaller.org/en/stable/operating-mode.html) → **应选 onedir**（目录 + 快捷方式/安装器），预计体积 20–25 MB【估算】、启动代价 +0.03–0.15 s【估算】。
- **真实短板**（都不是性能问题）：
  1. 没有打包产物 → 别人无法使用（P0，§7）；
  2. 无开机自启、无托盘（代码里没有 `winreg` / `Shell_NotifyIcon` / `pystray`）→ 自启可用 `winreg` 写 `HKCU\...\Run`（标准库，无需依赖）；托盘若要零依赖需 ctypes 调 `Shell_NotifyIcon`，约 100–150 行；
  3. system DPI aware（§5.1）；
  4. Python 3.9 已 EOL【一手】→ 迟早要升到 3.12/3.13，属于"计划内维护"而非换栈理由。
- **中文体验**：现有实现把字体钉成 `Microsoft YaHei UI`（`todo.pyw:244-250`），中文与拉丁混排正常；Tk 不做逐字形回退【经验判断】，emoji/生僻字需自行验证。IME 走系统，Text/Entry 组字可用（作者已日常使用）。
- **Markdown 体验**：行保真模型是本项目的护城河（§0.2 第 3 条），换栈会丢掉它。

### 6.2 Tauri 2（Rust + wry/WebView2）

- **判定**：**如果必须换，选它**。桌面层与体积两项满分。
- 桌面层：`set_always_on_bottom` / `set_skip_taskbar` 是一等 API【一手 docs.rs】；Windows 后端由 tao 用 `WindowFlags::ALWAYS_ON_BOTTOM → HWND_BOTTOM` 落地【一手源码】——**和 `todo.pyw` 现在手写的是同一个手法**，说明这条路在 Windows 上是被验证过的。
- 体积：WebView2 在 Windows 10 1803+ 与 Windows 11 已预装【一手 [prerequisites](https://v2.tauri.app/start/prerequisites/)】→ 应用本身新增字节小；但"含运行时"口径下并不小：本机 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application` 下 4 个版本目录各 **861–878 MB**【实测】（通常不计入应用体积，但要意识到它存在）。
- 冷启动/内存：WebView2 官方性能文档明确"每个控件拉起 browser/renderer/GPU 多个进程，增加内存与启动开销"、"冷启动必须拉起进程与磁盘缓存，可能带来可感知延迟"【一手 [WebView2 performance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)】；**具体 ms/MB 官方没有数字**【未查到】，只能给"冷启动比现状慢一档（0.4–1.5 s 量级）、内存高 2–4 倍"的估算【估算】。
- 体积优化：官方只给 Cargo 侧建议（`lto`、`opt-level="s"`、`strip`、`panic="abort"`），**没有给 MB 数字**【一手 [Tauri size](https://v2.tauri.app/concept/size/)】；因此"Tauri 应用只有几百 KB"这类说法在本报告不予采用。
- 迁移成本：Rust（窗口/文件/单实例/自启）+ 前端（清单 UI、行保真解析、IME 状态）两套语言；行保真必须用 TS/Rust 重写并重新验证。预计 900–1,400 行、业余 2–4 周【估算】。
- 中文/Markdown：WebView2 是 Edge 引擎，IME 与字体渲染最接近"浏览器里的体验"，`textarea`/`contenteditable` 的组字事件（`compositionstart/end`）可控，行保真可以在"自己解析、只重写被编辑行"的前提下做到（不要用 contenteditable 直接回写全文）。
- 打包/签名/更新：Tauri 自带 updater 与 WiX/NSIS 打包，但需要 Rust 工具链与签名证书；崩溃排查从 Python traceback 换成 Rust panic + WebView DevTools，心智负担上升。

### 6.3 Electron

- **判定**：直接排除。它是"用 150 MB 换开发速度"的方案，而本项目的开发速度已经被 Py+Tk 占住了。
- 体积：`electron-v45.2.3-win32-x64.zip` = **150.9 MB**【实测】。
- 冷启动/内存：Chromium 多进程 + Node 主进程【一手 [process model](https://www.electronjs.org/docs/latest/tutorial/process-model)】；无官方 ms/MB【未查到】，量级 100–300 MB【估算】。
- 桌面层：有 `setAlwaysOnTop`、`setSkipTaskbar`、`transparent`，**没有置底**（窗口层级 API 只有 always-on-top）【一手 BrowserWindow 文档】→ 要置底仍需 Win32 interop（Node 侧 ffi/原生插件），等于把现状那 60 行 ctypes 换成另一套更脆的绑定。
- 唯一优势：Web 技术栈 + 生态。对本项目（一个 Markdown 清单）属于过度工程。

### 6.4 .NET 家族：WPF / WinForms / WinUI 3

**共同的体积下限**：框架依赖部署必须装 .NET Desktop Runtime——官方 8.0.33 x64 安装器 **55.7 MB**、zip **35.1 MB**【实测 HEAD】、本机 8.0.0 安装后 **89.6 MB**【实测】。自包含部署可以省掉用户安装，但**WPF/WinForms 的裁剪在 SDK 里被禁用**（官方原文："almost no WPF apps are runnable after trimming, so trimming support for WPF is currently disabled in the .NET SDK"；WinForms 同样）【一手 [trimming incompatibilities](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities)】→ 自包含只能整包带运行时，体积无官方数字但不会小【未查到/【估算】"100 MB+"】。

- **WPF**：DPI 是四家里最好的（官方表："native WPF applications will DPI scale"）【一手】；托盘可借 WinForms `NotifyIcon`；无边框透明要 `AllowsTransparency=true` **且** `WindowStyle=None`【一手】；置底/不进任务栏全靠 P/Invoke。冷启动/内存无一手数字【未查到】。**若团队已有 .NET，这是最稳的选择；对本项目则是"用 55.7 MB 换一个更现代的 UI 与更好的 DPI"。**
- **WinForms**：最省事的托盘/自启/单实例（`Mutex` 同样可用）；DPI 只有"部分控件的有限自动缩放"【一手】；样式老旧，清单 UI 想好看要自绘。
- **WinUI 3**：**对本项目最不合适**。① 无边框透明窗口至今没有原生支持，官方 feature proposal #1247 仍 open，#7276 被作为重复关闭【一手】；② 未打包部署要自行部署 Windows App SDK 运行时 + VC++ Redistributable + .NET 6+【一手 [deploy unpackaged](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/deploy-unpackaged-apps)】；③ 置底/不进任务栏/透明全要 interop；④ MSIX 打包与签名链最重。它的优势（Fluent 控件、Mica）对本项目没有价值。

### 6.5 Rust 原生 GUI：egui / Slint

- **egui**：
  - 桌面层：`WindowLevel::AlwaysOnBottom` 已存在于 viewport 命令枚举【一手源码】→ 有能力，但要自己写平台细节。
  - **字体是硬成本**：egui 默认只带 Hack / Ubuntu-Light / NotoEmoji（`epaint_default_fonts` 源码可见）【一手】，**没有 CJK**；中文必须自带字体。实测：`NotoSansSC-Regular.otf` **7.9 MB**【实测 HEAD】，系统 `msyh.ttc` **18.8 MB**【实测】但不可随应用分发 → 至少要背 8 MB 字体（可子集化，但子集化会丢"用户可能输入的生僻字"）。
  - 开发成本：没有现成的"多行富文本 + 勾选清单 + 行内编辑"控件，`TextEdit` 是纯文本；清单勾选、行内编辑、右键菜单、拖拽排序全部自绘。行保真解析要重写。**这是本表里"能效比"最差的一档**：省下的 15 MB 内存，要用 3–4 倍开发时间换。
- **Slint**：官方唯一硬数字是"The Slint runtime fits in less than 300KiB RAM"【一手 [slint.dev](https://slint.dev/)】——注意这是 **runtime**，不是整进程 RSS，也不是二进制体积；置底 API 未在文档中找到【未查到】；文本编辑能力弱于 egui。**结论：不在候选之列**，除非未来官方补齐窗口层级与文本编辑。

### 6.6 Qt：C++ Widgets / PySide6

- **桌面层：与 Tauri 并列全表最强，但不要浏览器运行时**。`Qt::WindowStaysOnBottomHint` 原生存在，且官方注明"on Windows, this will work only for frameless or full-screen windows"——本项目窗口就是 frameless（`overrideredirect(True)` 对应 `FramelessWindowHint`）【一手】；不进任务栏可用 `Qt::WindowDoesNotAcceptFocus`（官方注明在 Windows 上阻止出现在任务栏）或 `Qt::Tool`【一手】。这两条是"写在框架里"的，不是社区 hack。
- **体积**：C++ 部署用 `windeployqt` 收集 Qt DLL/插件（插件必须放 `platforms` 等子目录）、VC++ 运行库需官方 Redistributable【一手】；MB 数官方没给【未查到】。PySide6 侧有实测：`PySide6-Essentials 6.12.0` win_amd64 wheel **78.3 MB**【实测 PyPI】。
- **PySide6 的特殊价值**：**唯一能原样复用现有 Python 逻辑的换 UI 方案**——`Line`/`parse_line`/`serialize`/文件写入/轮询/单实例/配置约 400 行可整体搬过去，只重写 UI 层。若动机是"想换个好看的 UI 又不想重写业务"，这是最省力路径（约 450–600 行、1–2 周【估算】）。代价：内存/启动/体积全面劣于 Tk（wheel 78 MB、Qt 库常驻），**与"更轻"的目标相反**。
- **Qt 的 Markdown 陷阱**：`QTextDocument` 是富文本文档模型，读写会规范化空白/换行；必须绕开它、自己按行解析（现有 `Line` 模型可直接复用），否则行保真必坏。

### 6.7 Flutter desktop / Avalonia

- **Flutter**：Windows 构建依赖 Visual Studio 的 C++ 桌面工作负载（官方文档"Compiling with Visual Studio"）【一手】；桌面层无原生置底/透明 API，要靠 `win32` 包或平台通道【未查到官方 API】；体积/内存无官方数字【未查到】。**判定**：为一个清单组件引入整套引擎 + VS 工具链，收益为负。
- **Avalonia**：.NET 生态的跨平台 XAML；体积/内存与 WPF 同档（同运行时）【估算】；置底无原生 API【未查到】→ P/Invoke。**判定**：与 WPF 相比没有本项目需要的优势（跨平台对本项目无用），仅当"想用 XAML 又要跨平台"时成立。

### 6.8 原生 Win32 + Direct2D（"最轻"的物理基线）

- 冷启动/内存/体积的理论下限：无运行时、无可执行解释器、无浏览器进程；exe <1 MB、RSS 10–20 MB 量级【估算】（没有官方数字，也不需要——它是标尺）。
- 代价：文本编辑、光标/选区、IME 组字、滚动、命中测试、Markdown 解析与行保真、右键菜单、拖拽，全部自绘或自己接。等价于重写一个迷你编辑器，**5–10 倍工作量**【估算】。
- **用途**：标定"轻"的下限，以及提醒一件事——现状 30 MB 距离物理下限只有 15–20 MB，而这 15–20 MB 换来的是整个 Tk 的文本/IME/布局能力。**这笔交易是划算的**。

---

## 7. 针对本项目的推荐路线（留，分阶段）

### P0｜能分发（1–2 天，收益最大）

1. 用 **PyInstaller onedir** 产出目录版（不要 onefile，理由见 §6.1 的官方说明），附带 `todo.pyw` 同等行为的 exe + `config.example.json`。
2. 验收：双击 exe → 首帧 ≤ 0.6 s（热缓存；冷缓存首启与现状同量级，约 1 s，见 §3.3）；产物 ≤ 30 MB；目标机无 Python 也能跑。
3. 备注：`APP_DIR = os.path.dirname(os.path.abspath(__file__))`（`todo.pyw:30`）、`CONFIG_PATH` 在其下（`todo.pyw:31`），而代码里**没有** `sys.frozen` 分支。冻结后 `__file__` 指向打包布局内部（onefile 更糟：指向每次启动重建的 `_MEI*` 临时目录），`config.json` 会跟着跑；P0 必须显式改为 `os.path.dirname(sys.executable)` 并加 `sys.frozen` 判断，否则配置会读不到或写丢——这是打包环节最容易踩、且只在打包后才暴露的一个坑。

### P1｜常驻体验（0.5–1 天）

1. **开机自启**：`winreg` 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（标准库，零依赖），配一个"设置"开关；保存在 `config.json`。
2. **托盘（可选）**：零依赖需 ctypes 调 `Shell_NotifyIcon`（约 100–150 行）；若允许一个第三方依赖，`pystray` 更省事——但这会打破"纯标准库"的项目约束，建议先不做（贴桌面的组件本来就常驻可见，托盘收益低）。

### P1.5｜列表增量渲染（0.5–1 天，体感收益最大）

1. 现状 `render_list()`（`todo.pyw:370-391`）每次销毁全部行控件再重建；勾选 20 行 68 ms、50 行 160 ms、200 行 609 ms（§3.2）。
2. 改法：保留"行索引 → 控件"映射，勾选/编辑只更新受影响的行；行数 >200 时再加虚拟列表（只渲染可视区 + 上下各一屏留白）。
3. 验收：50 行勾选 <20 ms、200 行 <50 ms（同 §3.2 测法）；滚动/拖拽不回归。

### P2｜DPI/多屏（1–2 天，唯一"硬伤"）

1. 把 `SetProcessDpiAwareness(1)`（`todo.pyw:930`）升级为 **PMv2**（`SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)`），并处理 `WM_DPICHANGED`（Tk 侧需要 `<Configure>` 重新布局 + 重算 `tk scaling`）。
2. 把字号从 pt 改成"按当前 DPI 计算的像素"，或在启动与 DPI 变化时重设 `tk scaling`；窗口尺寸/行高的像素常量改为按 DPI 比例换算。
3. 验收：在 100%/150% 两块屏之间拖动，不糊、不错位、不越界（**这是本项目唯一需要真机验证的改动**）。
4. 风险：Tk 8.6 对 PMv2 没有官方支持声明【未查到】；若验证失败，退路是"启动时按当前显示器 DPI 决定缩放并禁止跨屏拖动"，或把这一项留给未来的重写。

### P3｜观察（不做，但留门）

- 若未来要"对外发布 + 现代 UI"，先做 **3 个 spike**（每个 ≤1 天）再决定是否迁移：
  1. Tauri 2 最小窗口 + `set_always_on_bottom(true)` + `set_skip_taskbar(true)`，验证 Win+D、Progman 之上、多屏拖动；
  2. 在 WebView 里用"自己解析、只重写被编辑行"的方式实现 20 行 Markdown 的勾选/行内编辑，跑现有 `roundtrip_check.py` 的等价断言；
  3. 冷启动/内存实测（与 §3 同法），若冷启动 >0.6 s 或内存 >120 MB，则不迁移。

---

## 8. 迁移成本估算（若最终决定换）

| 模块 | 现有实现（行号） | 行数 | Tauri 2 | egui | PySide6 | WPF / Avalonia | Qt C++ | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 行模型 + 解析/序列化 | `todo.pyw:53-120` | ≈70 | 150–250（TS 或 Rust） | 150–250（Rust） | **0（原样复用）** | 150–250（C#） | 150–250（C++） | **最高**：必须逐字节复现"只改被编辑行/保留缩进与 BOM/CRLF" |
| 清单 UI + 勾选 + 行内编辑 + 右键菜单 | ≈300 | 300 | 200–350（HTML/CSS/TS） | 300–450（自绘） | 200–300（QWidget） | 250–350（XAML） | 300–400 | 高：行内编辑与 IME 组字的交互 |
| 原文模式编辑器 | `todo.pyw:660-720` | ≈120 | 150–250（textarea + 自解析） | 200+ | 100–180（QPlainTextEdit） | 150–250 | 150–250 | 中：不要用富文本控件直接往返 |
| 桌面层 Z 序 + Win+D 维持 | `todo.pyw:144-192`, `814-838` | ≈70 | **5–10**（API） | 20–40 | 20–40 | 60–80（P/Invoke） | **10–20**（原生 flag） | 中：Win+D 与 Progman 关系的回归测试 |
| 文件轮询/防抖/原子写 | `todo.pyw:326-332`, `627-641`, `838` | ≈50 | 40（notify/fs 或轮询） | 40 | **0（复用）** | 40 | 40 | 低 |
| 配置/单实例/启动参数 | `todo.pyw:867-878`, `todo.pyw:925` | ≈50 | 40 | 40 | **0–20（复用）** | 40 | 40 | 低 |
| **合计** | — | — | **900–1,400 行 / 2–4 周** | **900–1,300 行 / 3–5 周** | **450–600 行 / 1–2 周** | **800–1,100 行 / 2–3 周** | **800–1,100 行 / 3–4 周** | — |

> 工期为业余投入的粗估【估算】，不含打包/签名/更新链（据 §6 各栈的成熟度另加 1–5 天）。

**如果只记一句话**：迁移成本里 70% 集中在"行保真 + 行内编辑 + IME"这三件互相纠缠的事上；这三件事与"换哪个栈"关系不大，只与"重写多少 UI 逻辑"有关。所以**能用 Python 复用的迁移（PySide6）最便宜，能原生复用桌面层能力的迁移（Tauri/Qt）最省心，两者不可兼得**。

### 8.1 其余小功能的实现代价（对照现状，均为增量）

| 功能 | 现状（Tk） | PySide6 | Tauri 2 | WPF | WinForms | Qt C++ | egui | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 系统托盘 | 中：无托盘，零依赖要 ctypes 调 `Shell_NotifyIcon`（约 100–150 行） | 低：`QSystemTrayIcon` | 低：Tauri 自带 tray API | 低：借 WinForms `NotifyIcon`（官方互操作） | 低：原生 | 低：`QSystemTrayIcon` | 中：`tray-icon` crate | 本项目收益低（组件常驻可见），见 §7 P1 |
| 开机自启 | 低：`winreg` 写 `HKCU\...\Run`（标准库） | 低 | 低：官方 autostart 插件 | 低 | 低 | 低 | 低 | 各栈都是一次注册表写入，不构成选型差异 |
| 单实例 | **已有**：命名 Mutex（`todo.pyw:925`） | 低：`QLocalServer`/Mutex | 低：官方 single-instance 插件 | 低：Mutex | 低：Mutex | 低：Mutex | 低：Mutex | 无差异 |
| DPI（PMv2 不糊） | **中**：Tk 8.6 无官方 PMv2 声明，需自己处理 `<Configure>` 与 `tk scaling`（§7 P2） | 低：Qt 6 原生 PMv2 | 低：WebView2 负责 | 低：官方支持 | 中：仅"部分控件有限自动缩放" | 低：原生 PMv2 | 中：winit 支持，需实测 | **现状唯一真短板**，也是最该先修的一项 |
| 富文本清单 + 行内编辑 | **已有**（含 IME 日常验证） | 中：`QWidget` 自绘或 `QTextEdit` 绕开 | 中：HTML 行内编辑 + IME 组字事件 | 中：`RichTextBox` 会重排格式 | 中：同上 | 中 | 高：全部自绘 | 决定迁移成本的主项（§8 表第 2 行） |

> 这张表回答"换栈能不能让这些小功能更省事"：**托盘/自启/单实例都不构成理由**（各栈都低），真正有差异的只有 DPI 与富文本编辑——而 DPI 恰是留在现状也能修好的。【判断，依据见对应链接】

---

## 9. 没查实的地方（诚实清单）

### 9.1 缺一手数字的项（本报告只给了量级或直接标"未查到"）

1. Tauri 2 应用的 exe 体积、冷启动 ms、空闲内存 MB —— 官方只给编译优化建议与"WebView2 会拉起多进程"的定性描述。
2. Electron 的冷启动与内存官方数字（只有进程模型描述）。
3. WPF / WinForms / WinUI 3 / Avalonia 的冷启动与空闲内存官方 benchmark；WPF/WinForms **自包含发布**的体积。
4. Qt/C++ 部署后的实际体积；PySide6 的实际常驻内存。
5. Flutter desktop、Avalonia 的体积/内存/冷启动。
6. Slint 的置底窗口 API 是否存在；Slint 整进程 RSS（官方 300 KiB 是 runtime，不是进程）。
7. Tk 8.6 是否支持 per-monitor v2（未找到官方支持声明）；因此 §7 P2 有"验证失败"的退路。
8. egui 在 Windows 上 `AlwaysOnBottom` 是否完整落地（winit 后端未逐项核实）。

### 9.2 本机未能实测的项

- 无法实测任何"未安装"的栈（禁止安装工具链：没有 .NET SDK、没有 VS C++、没有 PySide6、没有 PyInstaller）。因此所有非 Python 栈的数字都没有本机一手测量。
- 冷启动样本受"文件系统缓存是否热"影响：本报告的样本大多在第二次及以后启动（非严格首次冷启动），故用**区间**而非单值表述；`pythonw -c pass` 的 46–56 ms 是纯进程创建开销的下界。

### 9.3 一个被作废的测量

曾用 PowerShell 宿主 + WPF/WinForms 建窗并测内存，得到 262 MB / 82.8 MB 的数字——**该数据不可用**：测量值被 PowerShell 宿主本身污染，且"首个无主窗口"的过滤条件在 `ShowInTaskbar=false`/模态窗口下返回 -1。已在 §4.2 里把 .NET 系的 D1/D2 降级为"无一手数字"的量级判断。

---

## 10. 复现方法（附录）

临时目录：`%TEMP%\dsh-todo-probe\`（不改仓库、不杀用户正在运行的实例）。

1. **冷启动**：`Copy-Item todo.pyw` 到临时目录，仅把 `MUTEX_NAME`（`Zwx_DesktopTodoWidget_Mutex`，`todo.pyw:33`）改名，避免与正在运行的实例互斥；`argv` 传 `md 路径` + `float`（走测试模式，不读写 `config.json`）。用一个内联 C# 的 `EnumWindows`/`GetWindowThreadProcessId` + `Stopwatch` 轮询该 PID 的第一个可见无主窗口，记录到 `ms`。
2. **内存/CPU**：启动后 `Start-Sleep 10`，`Get-Process -Id $p | Select WorkingSet64,PrivateMemorySize64,HandleCount`；CPU 用两次 `Get-Process` 的 `CPU` 差值 / 墙钟时间。
3. **体积**：`Get-Item` 逐个量 `python39.dll`、`tcl86t.dll`、`tk86t.dll`、`tcl8.6\`、`tk8.6\`、`Lib\tkinter`；.NET 运行时目录 `Get-ChildItem -Recurse | Measure-Object Length -Sum`。
4. **第三方体积**：PyPI JSON API（`https://pypi.org/pypi/PySide6-Essentials/json`）取 wheel `size`；GitHub release API 取 Electron zip `size`；`Invoke-WebRequest -Method Head` 取 .NET 运行时安装器 `Content-Length`；字体同理（`NotoSansSC-Regular.otf`）。

---

## 11. 来源清单

访问日期均为 2026-11-10。

| # | 用途 | 来源 | 类型 |
| --- | --- | --- | --- |
| 1 | Python 3.9 EOL 状态 | https://devguide.python.org/versions/ | 官方文档 |
| 2 | PyInstaller onefile vs onedir 的启动差异 | https://pyinstaller.org/en/stable/operating-mode.html | 官方文档 |
| 3 | .NET 裁剪对 WPF/WinForms 不可用 | https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities | 官方文档 |
| 4 | .NET 8 运行时安装包元数据（体积来源） | https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json | 官方发布元数据 |
| 5 | Tauri 体积优化建议（无 MB 数字） | https://v2.tauri.app/concept/size/ | 官方文档 |
| 6 | Tauri 前置：WebView2 预装于 Win10 1803+ | https://v2.tauri.app/start/prerequisites/ | 官方文档 |
| 7 | `set_always_on_bottom` / `set_skip_taskbar` | https://docs.rs/tauri/latest/tauri/window/struct.Window.html | 官方 API 文档 |
| 8 | tao 的 Windows 实现：`ALWAYS_ON_BOTTOM → HWND_BOTTOM` | https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/windows/window_state.rs | 源码 |
| 9 | Electron BrowserWindow API（无置底） | https://www.electronjs.org/docs/latest/api/browser-window | 官方文档 |
| 10 | Electron 进程模型 | https://www.electronjs.org/docs/latest/tutorial/process-model | 官方文档 |
| 11 | WebView2 性能：多进程、冷启动开销 | https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance | 官方文档 |
| 12 | Windows App SDK 未打包部署前提 | https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/deploy-unpackaged-apps | 官方文档 |
| 13 | WinUI 3 透明窗口：feature proposal（open） | https://github.com/microsoft/microsoft-ui-xaml/issues/1247 | 官方仓库 issue |
| 14 | 同上（重复项，2026-06 关闭） | https://github.com/microsoft/microsoft-ui-xaml/issues/7276 | 官方仓库 issue |
| 15 | WPF `AllowsTransparency` 与 `WindowStyle=None` 的约束 | https://learn.microsoft.com/en-us/dotnet/api/system.windows.window.allowstransparency | 官方 API 文档 |
| 16 | system-DPI-aware 会被位图拉伸 + 框架 DPI 支持表 | https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows | 官方文档 |
| 17 | Qt 窗口类型：`WindowStaysOnBottomHint`（Windows 仅 frameless/全屏）、`WindowDoesNotAcceptFocus` | https://doc.qt.io/qt-6/qt.html#WindowType-enum | 官方文档 |
| 18 | Qt Windows 部署（windeployqt/插件/VC++ 运行库） | https://doc.qt.io/qt-6/windows-deployment.html | 官方文档 |
| 19 | egui `WindowLevel::AlwaysOnBottom` | https://github.com/emilk/egui/blob/main/crates/egui/src/viewport.rs#L969 | 源码 |
| 20 | egui 默认字体只有 Hack/Ubuntu-Light/NotoEmoji（无 CJK） | https://github.com/emilk/egui/blob/main/crates/epaint_default_fonts/src/lib.rs | 源码 |
| 21 | Slint runtime <300 KiB 声明 | https://slint.dev/ | 官方站点 |
| 22 | Flutter Windows 构建依赖 Visual Studio | https://docs.flutter.dev/platform-integration/windows/building | 官方文档 |
| 23 | PySide6-Essentials wheel 体积（78.3 MB） | https://pypi.org/project/PySide6-Essentials/ | 官方包元数据 |
| 24 | `SetWindowPos` / `HWND_BOTTOM` | https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos | 官方 API 文档 |
| 25 | 扩展窗口样式 `WS_EX_TOOLWINDOW` | https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles | 官方文档 |
| 26 | NotoSansSC-Regular.otf 体积（7.9 MB） | https://github.com/notofonts/noto-cjk/blob/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf | 官方字体仓库 |
| 27 | Electron v45.2.3 win32-x64 zip 体积（150.9 MB） | https://github.com/electron/electron/releases | 官方 release 资产 |
| 28 | 项目源码（行号引用） | 本仓库 `todo.pyw` | 源码 |

---

### 附：本报告没有采用的常见说法

| 说法 | 为什么不用 |
| --- | --- |
| "Tauri 应用只有 600 KB / 几 MB" | 官方尺寸文档只给编译选项，不给 MB 数字【未查到】；不引用无法核实的营销数字 |
| "Electron 内存 200 MB" | 无官方一手数字；本报告只引用官方"多进程 + 额外内存"的定性描述 |
| "WebView2 已预装所以 Tauri 体积为 0" | 预装是事实【一手】，但运行时磁盘占用 861–878 MB/版本【实测】，两个口径必须分开说 |
| "WinUI 3 支持 Mica 所以能做毛玻璃桌面组件" | Mica 是**窗口背景材质**，不是"无边框透明窗口"；官方透明窗口提案仍 open【一手】 |
| "Qt 的置底在 Windows 无效" | 官方文档的限定是"only for frameless or full-screen windows"，本项目恰恰是 frameless【一手】 |
