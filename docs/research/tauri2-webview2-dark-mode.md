# Tauri 2 + WebView2 的深色能力边界

日期：2026-11-14　状态：调研完成（官方文档 + 源码逐条取证）
取证方式：以本机 `Cargo.lock` 实际钉住的版本为准（tauri 2.12.5 / tauri-runtime-wry 2.12.3 / wry 0.57.2 / tao 0.37.2 / muda 0.20.0 / tray-icon 0.25.1 / rfd 0.15.4 / webview2-com-sys 0.39.1），逐文件读 crates.io 源码；WebView2 侧读 Microsoft 官方 API spec 原文（`MicrosoftEdge/WebView2Feedback/specs/PreferredColorScheme.md`）与 `webview2-com-sys` 绑定；CSS/浏览器侧读 CSS Color Adjust 1（CSSWG ED）、CSSOM View Level 1（CSSWG ED）与 Chromium 源码。**本机 DNS 把 `tauri.app`、`learn.microsoft.com` 解析到私有地址而被拦下，这两站只作链接指向、未取到正文**；凡依赖它们的结论，一律改用同源的仓库源码或 spec 原文佐证。文中明确区分「官方文档写明」「源码可读出」「推断」「未查到」。

## 结论摘要

1. `app.windows[].theme` 是**「初始窗口主题」**，`None`＝跟随系统、`Light`/`Dark`＝强制；它在 Windows 上同时改两处——**非客户区（标题栏）的 DWM 深色标志**与**该 webview 的 `CoreWebView2Profile.PreferredColorScheme`**，后者才是 `prefers-color-scheme` 的来源。
2. WebView2 里 `prefers-color-scheme` **既不纯粹跟随系统，也不由页面决定**：它是 profile 级的显式开关（`AUTO` 才跟随系统），官方 spec 明写它同时决定「WebView2 自己的 UI（对话框、提示、右键菜单）」。
3. `color-scheme` CSS 能一并变暗的是**滚动条、表单控件、拼写检查线等「UA 渲染的页内件」**（规范强制）；**右键菜单与自动填充下拉不在这份清单里**——右键菜单由 `PreferredColorScheme` 管，自动填充的官方说法未查到。
4. 本项目**没有用 `tauri-plugin-dialog`**，而是直接依赖 `rfd 0.15.4`；Windows 后端走 `IFileDialog`/`IFileOpenDialog`（Common Item Dialog），且**未启用 `common-controls-v6`**，所以消息框走的是 `MessageBoxW`。这两者 rfd 都不提供任何主题接口，深色与否只能跟随系统；托盘菜单由 `tray-icon` 直接 `TrackPopupMenu`，**完全不经 `muda` 的深色绘制路径**，Tauri 也没有给托盘菜单设主题的 API。
5. `matchMedia(...).addEventListener('change')` 是 CSSOM View 规定的标准能力、Chromium 有完整实现链路，但**「WebView2 在 `PreferredColorScheme` 变化时会派发该事件」没有官方明文**；更稳的官方路径是 Tauri 自己的 `Window.onThemeChanged`（由 `WM_SETTINGCHANGE` 驱动）。

## 逐条取证

### 1. Tauri 2 的 theme 字段

**配置层（官方文档写明）**：`WindowConfig.theme` 的类型是 `Option<Theme>`，字段注释原文：

> The initial window theme. Defaults to the system theme. Only implemented on Windows and macOS 10.14+.

来源：[`crates/tauri-utils/src/config.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/config.rs)（本机 vendored 副本 `tauri-utils-2.10.2` 同句，行 2105）；对外的配置参考页是 [tauri.app/reference/config](https://v2.tauri.app/reference/config/)（本站被 DNS 拦，未取正文）。本项目 `app/src-tauri/tauri.conf.json` 的 `app.windows[0]` **没有 `theme` 键**，即 `None`＝跟随系统。

**Builder 层（源码可读出）**：`WindowBuilder::theme(Option<Theme>)` 的文档注释是「Forces a theme or uses the system settings if None was provided.」——语义就是**三态：Some(Light)/Some(Dark) 强制，None 跟随系统**。[`crates/tauri/src/window/mod.rs`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/window/mod.rs#L912)

**运行时 API（官方文档 + 源码）**：`Window::set_theme(&self, theme: Option<Theme>)` 存在，平台注释为「Linux / macOS 是应用级、iOS/Android 不支持」——**Windows 是窗口级**。JS 侧是 `getCurrentWindow().setTheme('dark' | 'light' | null)`，注释「pass in `null` or `undefined` to follow system theme」，并注明**需要 `core:window:allow-set-theme` 权限（不在 `core:window:default` 里）**。[`crates/tauri/src/window/mod.rs#L1996`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/window/mod.rs#L1996)、[`packages/api/src/window.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/window.ts)

**它究竟改了什么（源码可读出，逐跳）**：

| 跳 | 位置 | 行为 |
|---|---|---|
| 1 | `runtime-wry` `WindowMessage::SetTheme` | `window.set_theme(to_tao_theme(theme))`（[lib.rs#L3568](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri-runtime-wry/src/lib.rs#L3568)） |
| 2 | tao Windows | 写 `window_state.preferred_theme`，再 `SendMessageW(CHANGE_THEME_MSG_ID)`；`update_theme()` → `try_window_theme()` → **`DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE = 20)`**，即只改**非客户区/标题栏**（[`window.rs#L930`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/window.rs#L930)、[`dark_mode.rs#L118`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/dark_mode.rs#L118)、[`dark_mode.rs#L178`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/dark_mode.rs#L178)） |
| 3 | tao 另有进程级开关 | 事件循环初始化时无条件 `allow_dark_mode_for_app(true)`（uxtheme 序号 135 `SetPreferredAppMode(AllowDark)`）——**整个进程声明「我支持深色」**（[`event_loop.rs#L190`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/event_loop.rs#L190)、[`dark_mode.rs#L38`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/dark_mode.rs#L38)） |
| 4 | `runtime-wry` → wry | 建 webview 时 `webview_builder.with_theme(match window.theme() { Dark=>Dark, Light=>Light, _=>Light })`（[lib.rs#L4992](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri-runtime-wry/src/lib.rs#L4992)） |
| 5 | wry Windows | `ICoreWebView2_13::Profile().SetPreferredColorScheme(DARK/LIGHT/AUTO)`（[`webview2/mod.rs#L2008`](https://github.com/tauri-apps/wry/blob/wry-v0.57.2/src/webview2/mod.rs#L2008)） |
| 6 | 系统换主题时 | tao 在 `WM_SETTINGCHANGE` 里 `update_theme()` → 发 `ThemeChanged` → runtime-wry 对每个 webview **再调一次** `set_theme`（[`event_loop.rs#L2070`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/event_loop.rs#L2070)、[`lib.rs#L4239`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri-runtime-wry/src/lib.rs#L4239)） |
| 7 | 附带 | `tauri::Window::set_theme` 还会顺带 `muda::Menu::set_theme_for_hwnd`——**只影响挂在窗口上的菜单栏，与托盘菜单无关**（[`window/mod.rs#L1996`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/window/mod.rs#L1996)、[`menu/mod.rs#L754`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/menu/mod.rs#L754)） |

两点必须记住：

- **窗口 `decorations: false` 时，第 2 跳（DWM 标题栏）没有标题栏可改**，实际收益接近零；真正起作用的是第 4–6 跳（`PreferredColorScheme`）。
- **Tauri 传给 WebView2 的永远是显式的 Light/Dark，从不留 `AUTO`**（第 4 跳 `_ => Light`，第 6 跳同）。也就是说 `prefers-color-scheme` 的取值由 Tauri 决定，而不是浏览器自己去问系统。

### 2. WebView2 里 `prefers-color-scheme` 怎么被决定

**官方 spec 原文（Microsoft 仓库内的 API 提案文，非二手转述）**：

> This sets the color scheme for WebView2 UI like dialogs, prompts, and context menus **by setting the `prefers-color-scheme` media feature** for websites to respond to. […] The default value for this is `COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO`, **which will follow whatever color scheme the OS is currently set to.**

来源：[`MicrosoftEdge/WebView2Feedback/specs/PreferredColorScheme.md`](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/PreferredColorScheme.md)。枚举值 `AUTO = 0 / LIGHT = 1 / DARK = 2` 见同仓 spec 与本机绑定源码 `webview2-com-sys-0.39.1/src/bindings.rs:634`（生成代码上游：[webview2-rs `crates/bindings/src/bindings.rs`](https://github.com/wravery/webview2-rs/blob/main/crates/bindings/src/bindings.rs)）。对应的 MS Learn 页面：[CoreWebView2Profile.PreferredColorScheme](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2profile.preferredcolorscheme)（本站被 DNS 拦，未取正文）。

**「强制深色」与「跟随系统」的差别，官方只有一句话**：`AUTO` 跟随系统；`LIGHT`/`DARK` 是**显式覆盖**。差别落在两层：

1. **页内**：Chromium 的 `prefers-color-scheme` 求值直接读宿主给的偏好值，不是读系统设置——`PrefersColorSchemeMediaFeatureEval` 用 `media_values.GetPreferredColorScheme()`，与 `kDark`/`kLight` 比对（[`media_query_evaluator.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/css/media_query_evaluator.cc)）。Chromium 另有 `Page::SetPreferenceOverride("prefers-color-scheme", ...)` 这条注入通道，改完会走 `SettingsChanged(ChangeType::kColorScheme)`（[`page.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/page/page.cc)）——**WebView2 走的就是这条「宿主覆盖」通道（推断：spec 明说它设置的是 media feature，Chromium 侧唯一入口即此处，但 Microsoft 未公开其实现细节）**。
2. **WebView2 自己的 UI**：spec 那句话把「dialogs, prompts, and context menus」和 media feature 绑在一起——**强制 `DARK` 时，右键菜单也会变深；强制 `LIGHT` 时，即使系统是深色，右键菜单仍是浅色**。反向证据：官方 issue 里报的正是「`PreferredColorScheme` 设了但 context menu/scrollbar 不跟随」的 bug（[#3696](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3696)、[#4920](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4920)），说明这个联动**被设计成存在**、只是有缺陷。

**「是否还能影响标题栏/对话框」——不能**：标题栏是 DWM 的事（第 1 节的 `DWMWA_USE_IMMERSIVE_DARK_MODE`），文件对话框是 shell 的事（第 4 节）。`PreferredColorScheme` 的作用域是「该 profile 关联的 WebView2 及其自带 UI」，spec 对 profile 的定义没有跨出 webview。

### 3. `color-scheme: dark` 对浏览器自带件的覆盖范围

**规范（官方文档写明，CSS Color Adjust 1）**：

> For all elements, the user agent must match the following to the element color scheme: **the default colors of scrollbars and other interaction UI**; **the default colors of form controls** and other "specially-rendered" elements; **the default colors of other browser-provided UI, such as "spellcheck" underlines**; the value of system colors; the value of the `light-dark()` function. On the root element, the element color scheme additionally must affect **the surface color of the canvas, and the viewport's scrollbars**.

并且给了推荐写法：`<meta name=color-scheme content="light dark">` 或 `:root { color-scheme: light dark; }`，即「让浏览器自带的 UI（scrollbars, inputs, etc）跟着我的媒体查询一起走」。[CSS Color Adjust 1 §Effects of the Used Color Scheme](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-effect)

逐项对照本题列的四类：

| 件 | 是否被 `color-scheme` 变暗 | 依据 |
|---|---|---|
| 滚动条 | **是**（规范强制） | 上引规范 |
| 原生下拉框（`<select>` 弹出列表） | **是**，而且实现上确实如此：Chromium 的 select 弹层是一个页面弹窗，会把元素的 color-scheme 序列化成 `<meta name=color-scheme>` 再渲染（`SerializeColorScheme` + `PagePopupClient::AddLiteral("\n<meta name=color-scheme ...")`） | [Chromium `internal_popup_menu.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/html/forms/internal_popup_menu.cc) |
| 右键菜单 | **否**——它不是页内件，是 WebView2 自己的 UI，归 `PreferredColorScheme` 管 | WebView2 spec（第 2 节）；规范清单里没有它 |
| 自动填充/建议下拉 | **未查到**官方说明它受 `color-scheme` 影响；规范清单里也没有它。按「浏览器自带 UI」推断它跟 `PreferredColorScheme`，但 Microsoft 没有明文 | — |

补充一个与本项目直接相关的坑：**`color-scheme` 只改「UA 自己画的那套颜色」，不改作者写死的 hex**。规范明确「Pages have to opt into color scheme support」；本项目 `app/ui/style.css` 里 78 处 `#hex` 匹配（任务描述写 76，量法差异不影响结论）、`:root` 只有一个 `--c-grip` 变量、无 `color-scheme` 声明——**加 `color-scheme: dark` 不会让任何一处界面变深**，它只负责让 WebView2 自己画的那几件（滚动条、输入框）跟上。

### 4. 文件对话框与托盘菜单

**先纠正前提**：本项目**没有 `tauri-plugin-dialog`**，`app/src-tauri/Cargo.toml` 直接写 `rfd = "0.15"`，调用点只有 `src/commands.rs:138`、`:156`（选文件）与 `src/dialog.rs:10`（消息框）。作对照：`tauri-plugin-dialog 2.8.4` 依赖 `rfd 0.17` 且开启 `common-controls-v6`（[plugins-workspace `plugins/dialog/Cargo.toml`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/dialog/Cargo.toml)）；本项目的 `rfd` **没开这个 feature**（`cargo tree -e features -p rfd` 实测：`feats=ashpd,async-std,default,pollster,urlencoding,xdg-portal`）。

**用的是哪套 API（源码可读出）**：rfd 的 Windows 后端 `win_cid` 就是 **Common Item Dialog**——`CoCreateInstance(CLSID_FileOpenDialog / CLSID_FileSaveDialog)` 拿到 `IFileOpenDialog`/`IFileDialog`，再 `SetOptions`/`SetFileTypes`/`Show`/`GetResult`（[rfd `file_dialog/dialog_ffi.rs`](https://github.com/PolyMeilex/rfd/blob/0.15.4/src/backend/win_cid/file_dialog/dialog_ffi.rs)）。这也正是 MS Learn 说的「Starting with Windows Vista, the Common Item Dialog supersedes the older Common File Dialog」：[Common Item Dialog](https://learn.microsoft.com/en-us/windows/win32/shell/common-file-dialog)（正文经 MicrosoftDocs/win32 仓库原文取得）。

**消息框走哪套，取决于 feature（源码可读出）**：`common-controls-v6` 关着 → `MessageBoxW`；开着 → `TaskDialogIndirect`（[rfd `message_dialog.rs`](https://github.com/PolyMeilex/rfd/blob/0.15.4/src/backend/win_cid/message_dialog.rs)）。本项目关着 → `MessageBoxW`。

**系统深色下会不会自动变暗**：**官方文档未查到**任何关于 `IFileDialog`/`MessageBox`/`TaskDialog` 是否跟随深色主题的说明。`common-file-dialog` 页通篇只讲用法与自定义控件，一个「theme/dark」字样都没有。**推断（可验证的推理，非结论）**：这两者都是 shell/user32 自己画的窗口，没有 API 给调用方「传主题」；它们的深色与否只能取决于系统主题 + 进程是否已声明支持深色（tao 在启动时无条件 `SetPreferredAppMode(AllowDark)`，见第 1 节第 3 跳）。所以**「应用内手动切深色」不可能把文件对话框也切过去**——rfd 的 win_cid 后端里没有任何 `DwmSetWindowAttribute`/`SetPreferredAppMode`/`SetWindowTheme` 调用（全目录 grep 无 `dark` 命中）。

**托盘菜单（源码可读出）**：`tray-icon 0.25.1` 在 Windows 上直接 `SetForegroundWindow` + `TrackPopupMenu`，没有任何主题处理（[`platform_impl/windows/mod.rs`](https://github.com/tauri-apps/tray-icon/blob/tray-icon-v0.25.1/src/platform_impl/windows/mod.rs) 的 `show_tray_menu`）。`muda` 确实有 Windows 深色菜单栏绘制（`dark_menu_bar.rs` 自绘 `WM_UAHDRAWMENU`/`WM_UAHDRAWMENUITEM`，判据是 uxtheme 的 `ShouldAppsUseDarkMode`，[muda `dark_menu_bar.rs`](https://github.com/tauri-apps/muda/blob/muda-v0.20.0/src/platform_impl/windows/dark_menu_bar.rs)），但**它只挂在 `init_for_hwnd_with_theme` / `set_theme_for_hwnd` 这条「菜单栏绑到某个 HWND」的路径上**（[`platform_impl/windows/mod.rs#L265`](https://github.com/tauri-apps/muda/blob/muda-v0.20.0/src/platform_impl/windows/mod.rs#L265)、[`#L362`](https://github.com/tauri-apps/muda/blob/muda-v0.20.0/src/platform_impl/windows/mod.rs#L362)），托盘菜单根本不经过它。`TrayIconBuilder` 也没有 theme 方法（`tauri-2.12.5/src/tray/mod.rs` 全文无 `theme`）。**结论：托盘菜单 = 系统 `TrackPopupMenu`，跟随系统、不跟随应用内的手动开关；要「跟应用一致」只能自己画。**

### 5. `prefers-color-scheme` 变化能否被监听

**规范层（官方文档写明）**：`MediaQueryList` 是 `EventTarget`，`matches` 变化时派发 `change`（`addListener`/`removeListener` 只是 `addEventListener`/`removeEventListener` 的兼容别名，`onchange` 是事件处理器 IDL）。[CSSOM View Level 1 §The MediaQueryList Interface](https://drafts.csswg.org/cssom-view/#the-mediaquerylist-interface)

**Chromium 实现链路（源码可读出）**：`Page::SetPreferenceOverride("prefers-color-scheme")` → `SettingsChanged(ChangeType::kColorScheme)` → `InvalidateColorScheme()` → 对每个 LocalFrame `document->ColorSchemeChanged()`；媒体查询侧 `MediaQueryMatcher::MediaFeaturesChanged()` 逐个 `MediaQueryList::MediaFeaturesChanged()`，值真变了就 `EnqueueUniqueAnimationFrameEvent(change)`。[`page.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/page/page.cc)、[`media_query_matcher.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/css/media_query_matcher.cc)、[`media_query_list.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/css/media_query_list.cc)

**WebView2 侧**：「`PreferredColorScheme` 变化会触发页面的 `change` 事件」——**未查到官方明文**。这是本次调研唯一没能落到官方页的一条。可说的只有：该 API 在标准里有、Chromium 里有完整实现、WebView2 的 spec 承认它设置的就是该 media feature（第 2 节），因此**推断可用**；要证实只能实测。

**更稳的官方替代路径（官方文档 + 源码）**：Tauri 自己暴露了 `getCurrentWindow().onThemeChanged(handler)`（事件 `tauri://theme-changed`），数据源是 tao 的 `WM_SETTINGCHANGE` → `update_theme` → `WindowEvent::ThemeChanged`。[`packages/api/src/window.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/window.ts)、[`event_loop.rs#L2070`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/event_loop.rs#L2070)。注意源码里的一个短路：`update_theme()` 在 `from_settings_change_event && preferred_theme.is_some()` 时直接 return——**一旦应用强制了主题，系统主题变化就不再派发 `ThemeChanged`**（[`event_loop.rs#L2233`](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/windows/event_loop.rs#L2233)）。

## 对本项目的启示

前置事实（本仓库实测，非推断）：`app/src-tauri/tauri.conf.json` 无 `theme` 键（=跟随系统）；`app/src-tauri/src/` 全目录**没有任何 `theme`/`set_theme`**；窗口由 `app.rs:196`、`panel.rs:21` 的 `WebviewWindowBuilder::new(...)` 建，未设主题；`app/ui/**` 里唯一的媒体查询是 `style.css:359` 的 `prefers-reduced-motion`，无 `prefers-color-scheme`、无 `color-scheme`；原生滚动条已被 `#list::-webkit-scrollbar { display:none }`（`style.css:124`）与 `scrollbar-width:none` 关掉，改由 `scrollbar.js` 自绘；全 UI 只有一个原生 `<input>`（`panel.html` 的 `#panel-title-edit`，默认 `display:none`），无 `<select>`。

**A. 跟随系统（成本最低，且今天就已经半成品）**

- 要点亮的地方只有一处：`style.css` 的颜色字面量要收成变量，并加 `@media (prefers-color-scheme: dark)` 或 `:root{color-scheme: light dark}`。
- **关键便利（源码可读出的行为）**：Tauri 建窗口时已经把 tao 解析出的窗口主题**显式写进** `PreferredColorScheme`（第 1 节第 4 跳），系统换主题时还会再同步一次（第 6 跳）。所以**不需要改任何 Rust、不需要开权限，`prefers-color-scheme` 现在就应该已经在跟随系统**——这一条值得先花五分钟在 DevTools 里 `matchMedia('(prefers-color-scheme: dark)').matches` 验一下再动手。
- 自绘的部分**全部零成本**：顶栏、图标按钮、行、勾选框、拖动浮影、回执浮层、提示条、自绘滚动条、`rowmenu.js` 的右键菜单——都是 DOM/CSS，改变量即可。
- 系统绘制的部分**只能跟随、跟着系统走就别指望和界面完全一致**：`rfd` 的 `IFileDialog`（`commands.rs` 选文件）、`MessageBoxW`（`dialog.rs` 报错）、托盘菜单（`tray.rs` 的 `Menu`/`MenuItem`/`CheckMenuItem`）。系统深色时它们**大概率**也是深的（进程已被 tao 声明为支持深色），但**官方无明文**，不要写进验收标准。
- 监听方式：优先 `getCurrentWindow().onThemeChanged()`（官方 API，`core:default` 已覆盖事件），把 `matchMedia` 的 `change` 当兜底；注意 `onThemeChanged` 只在「没强制主题」时才来（第 5 节那条短路）。

**B. 手动开关（亮/暗/跟随三态）**

- 要动的地方是**两类，不是一类**：
  1. **自绘界面**：与 A 相同的 CSS 变量改造，只是由 `data-theme` 属性而不是媒体查询来选值。
  2. **WebView2 自带件**：必须调 `getCurrentWindow().setTheme('dark'|'light'|null)`。这一步决定的是 `prefers-color-scheme` **和右键菜单/提示框**——也就是说，不做这一步，用户选「深色」而系统是浅色时，**右键菜单会闪一个白框**（`rowmenu.js` 自绘的菜单没事，但 WebView2 的任何原生 UI 会不一致）。
- **有一个必须提前知道的成本**：`setTheme` 需要 `core:window:allow-set-theme` 权限，**不在 `core:default` 里**（API 注释明写）。当前 `capabilities/default.json` 只有 `core:default` + `core:window:allow-start-dragging`，走这条路要加权限。
- **有一处永远修不好**：**托盘菜单**。它由 `tray-icon` 直接 `TrackPopupMenu`，`Tauri` 没有主题 API、`muda` 的深色自绘也不覆盖这条路径（第 4 节）。手动切了深色而系统是浅色时，托盘菜单仍是浅色。可选：接受不一致，或把托盘菜单也改成自绘（成本远高于收益，不建议）。
- 文件对话框与 `MessageBoxW` 同理：**只能跟随系统**，「手动开关」对它们无效（第 4 节）。

**C. 只给字号（完全不碰颜色）**

- 一处系统绘制的部分都不用管，`theme` 保持缺省，托盘/对话框/右键菜单天然一致。
- 唯一要做的是确认加字号不会撞上写死的行高：`style.css` 的颜色和尺寸都是逐条字面量、只有一个 `--c-grip` 变量，行高若为绝对 px，放大字号会压字。这属于纯 CSS 的自查，风险最低。
- 代价是：`prefers-color-scheme` 在系统深色下依然会变（WebView2 自带件会跟着变深），而自绘界面保持浅色——**「只给字号」并不等于「界面绝对不变」，WebView2 自己那几件仍会随系统翻**。这条容易被忽略，值得在验收时点一句。

**一句话取舍**：自绘占绝大多数 → 深色的「画面」几乎零成本；成本全在**三处系统绘制的缝隙**（文件对话框、消息框、托盘菜单），而这三处**任何方案都无法让它跟应用内开关一致**，只能跟随系统或忍。所以推荐 A（跟随系统）作为第一步：Rust 零改动、无新权限、自绘全覆盖；把 B 留到确实有人抱怨「系统深色但我想用亮色」时再做，并接受托盘菜单不一致。
