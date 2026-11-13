# PARITY — Tauri 实现与 Tk 0.2.7 的历史对照（迁移期工程记录）

> **角色（[ADR 0005](../docs/adr/0005-lift-tk-parity.md)，2026-11-13）**：Tauri 2 实现是基线，Tk 0.2.7 是**历史参照**（`todo.pyw` 已于 2026-11 从仓库删除，见 [ADR 0006](../docs/adr/0006-remove-tk-fallback.md)；对照以本表与 git 历史为准）。
> 本表是 0.3.0 迁移期的逐函数工程记录，用来证明换栈时没漏功能；**它不再是约束**——新改动只要行为写清、测试守住、偏离记进 §3，不需要在这里补一行对照才被批准。
> 「等效」= 迁移当时的用户可见行为一致；之后有意改动的条目在「状态」列注明，并按 §3 追加一条偏离记录。

## 1. 数据层（纯函数）

| todo.pyw | app/ui/md.js | 状态 |
|---|---|---|
| Line 类 / 四正则 (75-100) | parseLine | 等效（cb_pos/ending/ws_after_cb 逐字段） |
| parse_text/serialize (102-127) | parseText/serialize | 等效 |
| toggle_raw/set_line_text (130-148) | toggleRaw/setLineText | 等效（单字符 diff/四分支重建） |
| child_indent/indent_units (151-158) | childIndent/indentUnits | 等效（expandtabs(4)） |
| subtree_end (160-186) | subtreeEnd | 等效 |
| subtree_stats/panel_parts (189-227) | subtreeStats/panelParts | 等效 |
| delete_subtree (236-254) | deleteSubtree | 等效 |
| —（0.4.0 新增） | blockEnd / allowsTopSlot / canMove / moveBlock | 拖动排序的行块定义与搬运（纯函数，26 项 TDD） |

测试：`node --test app/ui/*.test.js` = **83/83**（md + undo，与已删除的 `test_todo.py` 的 36 用例同源扩展，见 [ADR 0006](../docs/adr/0006-remove-tk-fallback.md)）。

## 2. 应用层逐函数对照

| todo.pyw | Tauri 实现载体 | 状态 |
|---|---|---|
| read_file(540)/write_text(550) | Rust read_md_file/write_md_file（BOM/`.todo_tmp`/replace/只读警告） | 等效 |
| load_file(565) | app.js loadFile（missing→showMissing；undo 栈重置；标题 basename 去 .md） | 等效 |
| refresh_from_disk(581) | app.js refreshFromDisk（commit→取消 save→存在则先写→load） | 等效 |
| show_missing(591) | app.js showMissing（同文案/wraplength 300） | 等效 |
| render_list(605) | app.js renderList（滚动分数保存恢复；0.4.0 起主窗口跳过备注行） | 等效 |
| build_row(635) | app.js buildRow + style.css（pad=16+min(8u,160)；hover/整行） | 等效 |
| draw_box(709) | app.js boxSvg（勾/白折线/2px 边） | 等效 |
| badge(750) | app.js makeBadge（SVG 勾/页 + %d/%d %d，仅 td‖nt） | 等效；0.4.0 起悬停整行时徽标左移 20px 给拖动把手让位 |
| 顶栏 hbtn(398-478) | index.html .hbtn ×4 + CSS hover/press/lit | 等效；0.4.0 起另有 2 个 SVG 图标按钮（更换文件 / 打开文件位置，§3-10） |
| grip(495) | index.html #grip SVG 3 斜线 + hover 变色 | 等效 |
| edit_row(835) | app.js editRow（Entry→input；不 trim、空照写；Esc/Enter/blur 同语义） | 等效 |
| toggle_line(827) | app.js（box click → toggle → render → save） | 等效 |
| insert_line(927) | app.js insertLine（ref=pos??i；nl 补行；30ms 后聚焦新行） | 等效 |
| delete_line(945) | app.js deleteLine（子块连删；面板命中→关面板） | 等效 |
| add_todo_end(969) | app.js addTodoEnd（无文件→建文件；空表插首；否则尾插） | 等效 |
| group_block_end/insert_group(981-997) | app.js insertGroup（nl 补在 pos-1；插入 pos；30ms 编辑） | 等效 |
| push_undo/undo(1000-1023) | undo.js + app.js undo（编辑中忽略；栈顶同跳过；cap 50） | 等效 |
| schedule_save/do_save(1026-1038) | app.js scheduleSave/doSave（250ms 防抖；失败标题「保存失败!」） | 等效 |
| menu_row(1041) | app.js menuRow（header/todo/note/other 四组菜单项逐项一致） | 等效* |
| menu_blank/menu_title(1463-1486) | app.js menuBlank；menuTitle **已删除** | menu_blank 等效*；menu_title 取消（0.4.0，改为顶栏常驻图标，§3-10） |
| _panel_locate(1075) | app.js locateAnchor（text+indent_units 锚） | 等效 |
| open/close_panel(1083/1194) | app.js openPanel/closePanel + Rust panel_open/close（420s×520s、toolwindow、topmost、单实例） | 等效 |
| render_panel(1225) | app.js pushPanelData → panel.js render（两栏、保滚动、标题同步） | 等效（跨窗事件） |
| p_build_row(1263) | panel.js buildRow（pad=12 顶格；todo 徽标位预留） | 等效 |
| p_edit(1305) | panel.js pEdit（本地编辑，commit 经 panel-req；Esc 取消不落盘） | 等效（跨窗事件） |
| p_rename(1362) | panel.js pRename（双击标题；Esc 只恢复；Esc 不冒泡） | 等效（跨窗事件） |
| p_menu(1422) | panel.js pMenu（[编辑, 删除]） | 等效* |
| p_add_todo/p_add_note(1435/1445) | app.js pAddTodo/pAddNote（pos/child_indent 逐参数一致） | 等效 |
| _next_todo_indent(1454) | app.js nextTodoIndent | 等效 |
| choose_file(1488) | app.js chooseFile + Rust rfd（initdir/过滤器；path 落 Rust Shared.file） | 等效 |
| open_file_location(1499) | Rust open_file_location（explorer /select、"路径"；父目录；双不存在弹窗） | 等效 |
| toggle_dock/_update_pin(1517-1538) | app.js toggleDock/updatePin + Rust set_docked_state/apply_docked（点亮=固定在桌面：压底+TOOLWINDOW+无任务栏；不点亮=普通窗口：正常 z 序+任务栏图标；两态都不 topmost） | 语义改写（ADR 0004） |
| poll(1541) | Rust poll_tick（贴桌面维持/Win+D 还原/面板 topmost 自愈/离屏救援）+ app.js（文件变化/missing） | 等效 |
| 拖动(1602) | data-tauri-drag-region（原生拖动） | 等效* |
| 缩放 grip(1606) | Rust resize_start（系统原生 SE 向 resize） | 等效* |
| save_config(1620) | Rust write_config（py_json_string 逐字节对齐 json.dump indent=1） | 等效 |
| on_close(1633) | app.js exitApp + Rust exit_app（commit→关面板→存盘→config→退出） | 等效 |
| main(1671) | Rust main（argv 测试模式/互斥体/尺寸 clamp/默认位=普通窗口/启动序列/托盘） | 等效 |
| 1s 外部变化轮询 | JS pollTick 1s + Rust poll_tick | 等效 |

\* 菜单与拖拽的载体差异见 §3。

## 3. 有意的载体差异（行为一致或已获批）

1. **菜单**：Tk 原生 `tk_popup` → 自绘 HTML 菜单（白底圆角阴影）。菜单项、顺序、sep、点击语义逐项一致；视觉是 0.2.7 视觉语言的自然延伸（同 Phase 0 批准的设计方向）。标题栏那一份已于 0.4.0 取消（§3-10），现在只剩列表空白 / 行 / 面板三处。
2. **主窗口两态（ADR 0004，0.4.0）**：Tk 0.2.7 的 📌 是「贴桌面 / 悬浮置顶」，且贴桌面时任务栏没有入口。用户 2026-11-13 定稿改为「固定在桌面 / 普通窗口」：固定在桌面 = 桌面图标之上、所有应用窗口之下，任务栏与 Alt+Tab 里都没有它（`WS_EX_TOOLWINDOW` + `ITaskbarList::DeleteTab`）；普通窗口 = 正常 z 序、任务栏有图标、Alt+Tab 里有它，点任务栏图标就能加待办；默认普通窗口。置顶功能整体下线（两种模式都不 topmost），新增常驻托盘（左键唤回普通窗口，右键菜单切模式/退出），面板仍不进任务栏且保持 topmost。
3. **拖动/缩放手势**：Tk 手动 geometry → 系统原生拖动/resize。手感更好；位置尺寸记账经 Moved/Resized → dirty_config → ≤1s 内落盘（Tk 是 release 时写）。
4. **跨窗面板通信**：Tk 直接调 self 方法 → main↔panel 事件。面板编辑提交瞬间有一次旧值→新值的重渲染（Tk 是同步刷新），≤1 帧。
5. **测试日志**：testing 模式写 `widget.log`（saved/loaded/panel/undo 等状态迁移，与 Tk 0.2.7 的 widget.log 同层级）；生产模式不写日志文件。调试期探针（click trace、按钮 client 坐标、toggle 栈、client_to_screen）已全部删除。
6. **拖动排序（0.4.0 新增，Tk 0.2.7 没有）**：主窗口里分组标题与顶层待办可拖（行右缘把手，悬停现身），整块搬：待办带走子树、分组带走整组，缩进原样；面板两栏各自排序（子待办/备注互不越栏，指针移出本栏即无落点）。落点只有整块边界（行间插入线 #4A8FE2，从缩进位画到行右缘），每次落点一条撤销记录，落回原处不写文件。两条边界规则写在 md.canMove 里：「第一个分组标题之前永远不设落点」「分组只落在另一组的标题之前或文件末尾」（否则会静默并组）；指针停进上下 24px 连续自动滚动。
7. **主窗口不渲染备注（0.4.0）**：备注只在详情面板出现；顶格备注行静默隐藏，文件字节保真、不迁移、不可编辑（用户 m00066/m00070 选定的甲案）。非待办/非备注的其它行（分不清类型的纯文本行）仍按 0.3.0 原样渲染，不隐藏。
8. **跨窗口拖拽没做（载体限制）**：主窗口↔面板之间不能拖。WebView2 上 HTML5 DnD 跨窗口会被 wry 的 IDropTarget 吃掉（非文件载荷回 DROPEFFECT_NONE，tauri#15138 not planned），pointer 拖拽又跨不了窗口；0.4.0 只做各窗口内的排序。
9. **测试模式不写 config.json（ADR 0004 期间新增）**：`DesktopTodo.exe <file> <dock|float>` 本来就从不读 config.json，但以前退出时照样把测试文件与测试窗口尺寸写进 exe 同目录的 config.json——跑一次探针就会把用户真实部署的配置改掉（2026-11-13 实测踩到，部署实例一度指向临时测试文件）。现在 testing 分支下 `write_config` 直接返回并记一行 `test mode: config.json not written`。
10. **标题栏右键菜单取消，改顶栏常驻图标（0.4.0，[#3](https://github.com/zwxdogs/desktop-todo/issues/3)）**：原「右键标题栏 → 更换文件… / 打开文件位置 / 退出」整块删除，前两项改为顶栏两个常驻图标（内联单色 SVG，13px，热区 30×26，tooltip 走 `title`），中间 1px 分组竖线（`pointer-events: none`，穿透后等同点标题栏空白可拖窗）；右键标题栏现在什么也不发生。原因不是审美：Tauri 注入的 `window/scripts/drag.js` 在 document **冒泡**期注册 mousedown，命中 `data-tauri-drag-region` 时 `preventDefault + stopImmediatePropagation + start_dragging`，页面脚本冒泡期注册的"点菜单外面关掉"永远收不到——"菜单弹出后点标题栏关不掉"在该载体下修不好；常驻图标没有开合状态，直接绕开整类问题。退出只剩顶栏 ✕ 与列表空白右键菜单里的「退出」。顺带：最小内宽 260 → 300（顶栏多了两个按钮，260 会把标题挤没），并删掉 `tauri.conf.json` 里主窗口 `create: false` 下不生效的 `minWidth/minHeight`；标题截断时悬停由 `title` 属性给出完整文件名。
11. **点标题栏提交内联编辑（0.4.0，[#4](https://github.com/zwxdogs/desktop-todo/issues/4)）**：用户可见行为与 Tk 一致（`todo.pyw:912-925` 就是提交），差别在实现——`app.js` 的"点编辑框外面提交"与"点菜单外关闭"、`panel.js` 的同款关菜单三条 document mousedown 改到**捕获阶段**。捕获先于注入脚本的冒泡监听，不再被 `preventDefault` 连带打断 input 的 blur（原来两者都会让编辑停在未提交状态）。

## 4. 验证状态

- [x] 纯函数 TDD 83/83（`node --test app/ui/*.test.js`，2026-11-13）
- [x] Rust release 编译通过（`app\build.ps1`，产物 `dist\DesktopTodo\DesktopTodo.exe`，2026-11-13）
- [x] TEST_MODE 运行时 parity：勾选/行内编辑/删除/Ctrl+Z/面板开合与内容/改名/删除、两次启动无漂移、Win+D 自愈、拖动与 grip 落盘（2026-11-13，票 #1）
- [x] 人工视觉对比（0.2.7 vs 0.3.0 截图；行距 26px、勾选框/文字/徽标同中线，用户确认）
- [x] 0.4.0 拖动排序：md.js 纯函数 26 项 TDD + DOM 侧主窗口/面板接入（2026-11-13）
- [x] 0.4.0 code-review（Standards + Spec 两轴，2026-11-13）：已修「分组拖进别人组中间会静默并组」「开头有杂物时仍能落到第一组之前」「拖到一半文件被外部改过仍按旧下标落点」「面板不认跨栏」「边缘滚动只在动鼠标时生效」「插入线右端/徽标让位未写进 PARITY」；两窗重复的拖动引擎记录为后续可抽 app/ui/dnd.js，不阻塞本次交付
- [x] code-review（Standards + Spec 两轴，2026-11-13）：4 条硬违规已修（fixture 移入 app/ui/fixtures/、测试命令路径统一、md.js 头注释、删除无调用者的 show_message）；重复菜单/commit 四连/Rust hwnd 锁辅助等判据项记录为后续重构，不阻塞本次交付
- [x] ADR 0004 两态 + 托盘（2026-11-13，`app\build.ps1` + `cargo test --offline` + 5 个 `node app/ui/*.test.js` 共 83/83）：Rust `dock_style` 3 项单测通过；实机探针复核——固定在桌面时主窗口 `ex=0x190`（TOOLWINDOW=True、APPWINDOW=False，无 topmost）且 z 序贴近桌面层（1115 条链里第 1108 位，在所有应用窗口之下）；普通窗口 `ex=0x40110`（APPWINDOW=True、TOOLWINDOW=False）且 z 序在前；托盘 `tray_icon_app` 两模式均在。踩到的坑写进代码注释：首次 `ShowWindow` 会按建窗时样式重算 exstyle，显示前设的 TOOLWINDOW 会被抹掉，必须显示后再落一次（面板 `panel_open` 同理）
- [x] ADR 0004 运行时切换实测（2026-11-13）：TEST_MODE 里点 📌 双向切换——固定→普通 `ex=0x190→0x40110`、日志 `normal: plain window (taskbar icon on)`；普通→固定 `ex=0x40110→0x190`、z 序 1112/1117、日志 `docked: pinned above desktop (no taskbar)`；两次切换窗口都保持可见（hide/show 无残留、无崩溃）。任务栏 UIA 核对：普通窗口态出现 `桌面待办 - 1 个运行窗口`，固定桌面态该条目消失。命令：`app\build.ps1`、`cargo test --offline`（3 项）、5 个 `node app/ui/*.test.js`（83/83）。托盘路径同样实测：左键点托盘图标 → 普通窗口（`ex=0x190→0x40110`，任务栏出现「桌面待办 - 1 个运行窗口」）；右键菜单选「固定在桌面」→ 回到 `ex=0x190` 且任务栏条目消失
- [x] ADR 0004 code-review（Standards + Spec 两轴，2026-11-13）：硬违规已修（本文件验证条目补上命令）。判据项已修：「`DockStyle.appwindow` 与 `toolwindow` 互为反值」→ 合并进 `set_ex_flags` 内部互斥维护；「hwnd 取值重复 6 处」→ 抽 `win_hwnd`；「托盘 id 是裸字符串」→ 提为 `TRAY_SHOW`/`TRAY_DOCK`/`TRAY_QUIT`；「切换模式仍由前端算终态」→ 前端只上报目标态，真相源是 Rust 的 `Shared.docked`；「`save_config` 双写」→ 删前端那次；「`sync_tray_check` 并发乱序」→ 改单线程通道只落最新值；「ADR 说取内嵌图标却留纯色 fallback」→ 删 fallback；`updatePin` → `updateDockButton`。不采纳：给 ADR 新增 frontmatter 关系字段（0003 顶部已有取代注记）、为三处 `thread::spawn` 抽薄包装
- [x] 0.4.0 顶栏图标 + 点标题栏提交编辑（2026-11-13，[#3](https://github.com/zwxdogs/desktop-todo/issues/3) / [#4](https://github.com/zwxdogs/desktop-todo/issues/4)）：`node --test --test-isolation=none app/ui/*.test.js` 83/83、`node --check` 两文件、`cargo check` 通过，`app\build.ps1` release 构建后部署重启；DOM 事件顺序没有可测接缝（现有测试全是纯函数），验收靠实机手测——编辑中点标题栏空白/文字提交并落盘、右键标题栏无菜单、分组竖线可拖窗、最窄 300 时标题省略、双击最大化与拖动排序不回归
- [x] ADR 0005 解除对等约束（2026-11-13）：本文件顶部改写角色、§3 补 #3/#4 两条偏离、§2 的 menu_title 与顶栏按钮行同步；0003 / 0004 / AGENTS.md 互相引用，仓库内不再有"必须与 0.2.7 完全一致"的表述
