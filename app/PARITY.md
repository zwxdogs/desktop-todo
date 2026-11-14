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
| —（0.4.1 新增） | groupTodoIndent / todoBelow | 行内加号的落点与缩进（纯函数，8 项 TDD） |
| —（0.4.2 新增） | completedScan / deleteCompleted | 批量删除已完成：哪些块算「已完成」、整块删（纯函数，12 项 TDD，§3-15） |
| —（0.4.2 新增） | createList（app/ui/list.js） | 清单的八个变更意图 + 撤销栈 + 写盘合并 + 面板锚点（模块 + hooks，26 项 TDD，§3-17） |

测试：`node --test app/ui/*.test.js` = **144/144**（md + 行内加号落点 + 批量删除已完成 + 清单模块 + undo + 新建示例文案 + 滚动条几何，与已删除的 `test_todo.py` 的 36 用例同源扩展，见 [ADR 0006](../docs/adr/0006-remove-tk-fallback.md)）。

## 2. 应用层逐函数对照

| todo.pyw | Tauri 实现载体 | 状态 |
|---|---|---|
| read_file(540)/write_text(550) | Rust read_md_file/write_md_file（BOM/`.todo_tmp`/replace/只读警告） | 等效 |
| load_file(565) | app.js loadFile（missing→showMissing；undo 栈重置；标题 basename 去 .md） | 等效 |
| refresh_from_disk(581) | **已删除**（顶栏 ↻ 已去掉：外部改动本来就由 `poll_tick` 每秒按 mtime:size 自动重载，§3-16） | 取消 |
| show_missing(591) | app.js showMissing（同文案/wraplength 300） | 等效 |
| render_list(605) | app.js renderList（滚动分数保存恢复；0.4.0 起主窗口跳过备注行） | 等效 |
| build_row(635) | app.js buildRow + style.css（pad=16+min(8u,160)；hover/整行） | 等效 |
| draw_box(709) | app.js boxSvg（勾/白折线/2px 边） | 等效 |
| badge(750) | app.js makeBadge（SVG 勾/页 + %d/%d %d，仅 td‖nt） | 等效；0.4.0 起悬停整行时徽标左移给行右缘的加号与把手让位，0.4.1 起让位 40px（§3-14） |
| 顶栏 hbtn(398-478) | index.html .hbtn（0.4.2 起 5 枚）+ CSS hover/press/lit/disabled | 等效；0.4.0 起另有 3 个 SVG 图标按钮（更换文件 / 新建待办文件 / 打开文件位置，§3-10），0.4.2 起前两者合并成「文件菜单」下拉、再加「删除已完成」（§3-15、§3-16） |
| grip(495) | index.html #grip SVG 3 斜线 + hover 变色 | 等效 |
| edit_row(835) | app.js editRow（Entry→input；不 trim、空照写；Esc/Enter/blur 同语义） | 等效 |
| toggle_line(827) | app.js（box click → toggle → render → save） | 等效 |
| insert_line(927) | app.js insertLine（ref=pos??i；nl 补行；30ms 后聚焦新行） | 等效 |
| delete_line(945) | app.js deleteLine（子块连删；面板命中→关面板） | 等效 |
| —（0.4.2 新增） | app.js deleteCompletedTodos + 顶栏 🗑 + 回执浮层 | 批量删除已完成（一行都不勾确认框、整批一个撤销快照，§3-15） | 新增 |
| add_todo_end(969) | **已删除**（添加待办改为行右缘的加号，§3-14） | 取消 |
| group_block_end/insert_group(981-997) | app.js insertGroup（nl 补在 pos-1；插入 pos；30ms 编辑） | 等效 |
| push_undo/undo(1000-1023) | undo.js + app.js undo（编辑中忽略；栈顶同跳过；cap 50） | 等效 |
| schedule_save/do_save(1026-1038) | app.js scheduleSave/doSave（250ms 防抖；失败标题「保存失败!」） | 等效 |
| menu_row(1041) | app.js menuRow（header/todo 两组：插入分组、重命名/编辑、删除、打开详情面板；blank/other/note 不开菜单） | 偏离（§3-14：不再有"加待办"两项，note 组随主窗口不渲染备注一并删除） |
| menu_blank/menu_title(1463-1486) | app.js menuBlank；menuTitle **已删除** | menu_blank 偏离（§3-14：只剩「在末尾添加分组」，缺文件时置灰）；menu_title 取消（0.4.0，改为顶栏常驻图标，§3-10） |
| _panel_locate(1075) | app.js locateAnchor（text+indent_units 锚） | 等效 |
| open/close_panel(1083/1194) | app.js openPanel/closePanel + Rust panel_open/close（420s×520s、toolwindow、topmost、单实例） | 等效 |
| render_panel(1225) | app.js pushPanelData → panel.js render（两栏、保滚动、标题同步） | 等效（跨窗事件） |
| p_build_row(1263) | panel.js buildRow（pad=12 顶格；todo 徽标位预留） | 等效 |
| p_edit(1305) | panel.js pEdit（本地编辑，commit 经 panel-req；Esc 取消不落盘） | 等效（跨窗事件） |
| p_rename(1362) | panel.js pRename（双击标题；Esc 只恢复；Esc 不冒泡） | 等效（跨窗事件） |
| p_menu(1422) | panel.js pMenu（[编辑, 删除]） | 等效* |
| p_add_todo/p_add_note(1435/1445) | app.js pAddTodo/pAddNote（pos/child_indent 逐参数一致） | 等效 |
| _next_todo_indent(1454) | md.groupTodoIndent（纯函数，§3-14） | 搬家 |
| choose_file(1488) | app.js chooseFile + Rust rfd（initdir/过滤器；path 落 Rust Shared.file） | 等效 |
| —（0.4.0 新增） | Rust new_md_file + app.js newFile（rfd 另存为：默认名 `待办.md`、默认目录=当前文件父目录或 exe 目录、父目录缺则建；目标已存在→只切换不覆盖；新建时写入 starterText 示例，§3-12） | 新增 |
| open_file_location(1499) | Rust open_file_location（`explorer /select,"路径"`，路径先经 `explorer_path` 规范成反斜杠绝对路径——正斜杠会让 explorer 只开默认文件夹、不选中文件，2026-11-14 修；父目录；双不存在弹窗） | 等效 |
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

1. **菜单**：Tk 原生 `tk_popup` → 自绘 HTML 菜单（白底圆角阴影）。菜单项、顺序、sep、点击语义逐项一致；视觉是 0.2.7 视觉语言的自然延伸（同 Phase 0 批准的设计方向）。标题栏那一份已于 0.4.0 取消（§3-10），现在只剩列表空白 / 行 / 面板三处，外加 0.4.2 的顶栏文件菜单下拉（§3-16，开合状态挂在第一枚图标上）。
2. **主窗口两态（ADR 0004，0.4.0）**：Tk 0.2.7 的 📌 是「贴桌面 / 悬浮置顶」，且贴桌面时任务栏没有入口。用户 2026-11-13 定稿改为「固定在桌面 / 普通窗口」：固定在桌面 = 桌面图标之上、所有应用窗口之下，任务栏与 Alt+Tab 里都没有它（`WS_EX_TOOLWINDOW` + `ITaskbarList::DeleteTab`）；普通窗口 = 正常 z 序、任务栏有图标、Alt+Tab 里有它，点任务栏图标就能加待办；默认普通窗口。置顶功能整体下线（两种模式都不 topmost），新增常驻托盘（左键唤回普通窗口，右键菜单切模式/退出），面板仍不进任务栏且保持 topmost。切换两态就地落样式、不 hide/show（窗口不闪），任务栏与 Alt+Tab 归属由 `ITaskbarList` + `SWP_FRAMECHANGED` 让 shell 重算（[#8](https://github.com/zwxdogs/desktop-todo/issues/8)）；两态都显式对齐 DWM 圆角偏好，工具窗（固定在桌面）也要系统圆角与外阴影，两态看起来是同一个窗口（[#9](https://github.com/zwxdogs/desktop-todo/issues/9)）。
3. **拖动/缩放手势**：Tk 手动 geometry → 系统原生拖动/resize。手感更好；位置尺寸记账经 Moved/Resized → dirty_config → ≤1s 内落盘（Tk 是 release 时写）。
4. **跨窗面板通信**：Tk 直接调 self 方法 → main↔panel 事件。面板编辑提交瞬间有一次旧值→新值的重渲染（Tk 是同步刷新），≤1 帧。
5. **测试日志**：testing 模式写 `widget.log`（saved/loaded/panel/undo 等状态迁移，与 Tk 0.2.7 的 widget.log 同层级）；生产模式不写日志文件。调试期探针（click trace、按钮 client 坐标、toggle 栈、client_to_screen）已全部删除。
6. **拖动排序（0.4.0 新增，Tk 0.2.7 没有）**：主窗口里分组标题与顶层待办可拖（行右缘把手，悬停现身），整块搬：待办带走子树、分组带走整组，缩进原样；面板两栏各自排序（子待办/备注互不越栏，指针移出本栏即无落点）。落点只有整块边界（行间插入线 #4A8FE2，从缩进位画到行右缘），每次落点一条撤销记录，落回原处不写文件。两条边界规则写在 md.canMove 里：「第一个分组标题之前永远不设落点」「分组只落在另一组的标题之前或文件末尾」（否则会静默并组）；指针停进上下 24px 连续自动滚动。
7. **主窗口不渲染备注（0.4.0）**：备注只在详情面板出现；顶格备注行静默隐藏，文件字节保真、不迁移、不可编辑（用户 m00066/m00070 选定的甲案）。非待办/非备注的其它行（分不清类型的纯文本行）仍按 0.3.0 原样渲染，不隐藏。
8. **跨窗口拖拽没做（载体限制）**：主窗口↔面板之间不能拖。WebView2 上 HTML5 DnD 跨窗口会被 wry 的 IDropTarget 吃掉（非文件载荷回 DROPEFFECT_NONE，tauri#15138 not planned），pointer 拖拽又跨不了窗口；0.4.0 只做各窗口内的排序。
9. **测试模式不写 config.json（ADR 0004 期间新增）**：`DesktopTodo.exe <file> <dock|float>` 本来就从不读 config.json，但以前退出时照样把测试文件与测试窗口尺寸写进 exe 同目录的 config.json——跑一次探针就会把用户真实部署的配置改掉（2026-11-13 实测踩到，部署实例一度指向临时测试文件）。现在 testing 分支下 `write_config` 直接返回并记一行 `test mode: config.json not written`。
10. **标题栏右键菜单取消，改顶栏常驻图标（0.4.0，[#3](https://github.com/zwxdogs/desktop-todo/issues/3)）**：原「右键标题栏 → 更换文件… / 打开文件位置 / 退出」整块删除，前两项改为顶栏两个常驻图标（内联单色 SVG，13px，热区 30×26，tooltip 走 `title`），中间 1px 分组竖线（`pointer-events: none`，穿透后等同点标题栏空白可拖窗）；右键标题栏现在什么也不发生。原因不是审美：Tauri 注入的 `window/scripts/drag.js` 在 document **冒泡**期注册 mousedown，命中 `data-tauri-drag-region` 时 `preventDefault + stopImmediatePropagation + start_dragging`，页面脚本冒泡期注册的"点菜单外面关掉"永远收不到——"菜单弹出后点标题栏关不掉"在该载体下修不好；常驻图标没有开合状态，直接绕开整类问题（0.4.2 的文件菜单下拉重新引入开合，改用捕获期 `pointerdown` 绕开同一条被吞的路径，§3-16）。退出只剩顶栏 ✕（列表空白右键菜单里那一项后来也删了，§3-14）。顺带：最小内宽 260 → 300（顶栏多了两个按钮，260 会把标题挤没），并删掉 `tauri.conf.json` 里主窗口 `create: false` 下不生效的 `minWidth/minHeight`；标题截断时悬停由 `title` 属性给出完整文件名。
11. **点标题栏提交内联编辑（0.4.0，[#4](https://github.com/zwxdogs/desktop-todo/issues/4)）**：用户可见行为与 Tk 一致（`todo.pyw:912-925` 就是提交），差别在实现——`app.js` 的"点编辑框外面提交"与"点菜单外关闭"、`panel.js` 的同款关菜单三条 document mousedown 改到**捕获阶段**。捕获先于注入脚本的冒泡监听，不再被 `preventDefault` 连带打断 input 的 blur（原来两者都会让编辑停在未提交状态）。
12. **＋ 从「末尾加待办」改成「新建待办文件」（0.4.0）**：第一次打开时可能一个 md 都没有，而此前没有"新建"这条路（缺文件只提示右键→更换文件，那是"打开已有"）。现在顶栏第 2 个图标是「新建待办文件…」（文档+加号 SVG），夹在「更换文件」「打开文件位置」之间、分组竖线左侧（用户要求 ＋ 在竖线左边）；点击走原生另存为，默认名 `待办.md`，默认目录 = 当前文件父目录、文件不存在时用 exe 目录，父目录不存在会一并创建。用户在对话框里指到**已存在**的文件时按"打开已有文件"处理，绝不覆盖。新建成功的文件写入一段示例（`app/ui/starter.js` 的 `starterText`），用示例自己教用法：右键空白处添加分组、鼠标停在行右缘露出加号加待办、点方框勾选、双击打开详情面板改名、Ctrl+Z、自动保存，以及"父任务 + 缩进备注"一对（主列表不渲染备注且子项会折叠，没有这一对没人会发现面板）。示例只是文件内容，此后永不自动改写，用户自己删。缺失状态的提示改为按顶栏按钮序号指路（"第 2 个图标新建 / 第 1 个图标打开已有"），序号在运行时按 `#hdr .hbtn` 顺序算，不写死。同一处顺带修掉一个会毁掉首次引导的 bug：缺失状态下退出会把空内容写盘，于是下次启动"文件已存在"、示例再也不会生成——`exitApp` 现在要 `S.loaded && !S.missingShown` 才写（`refreshFromDisk` 那条同类保护随函数在 0.4.2 删除，§3-16），空白处右键菜单在缺失时只剩「退出」（§3-14：现在只剩「在末尾添加分组」且置灰），`addTodoEnd` 也不再隐式建文件（§3-14：该函数已删除，加待办走行上的加号）。
13. **自绘滚动条（0.4.1 新增，Tk 0.2.7 没有）**：Tk 0.2.7 只认滚轮，界面上没有任何滚动条；0.4.0 沿用了原生条，它贯穿整条右缘（连标题栏一起）且常显。0.4.1 起 `body` 不再滚动、`#list` 自己滚（标题栏固定 34px，滚轮落在标题栏上不影响内容），主窗口与面板两栏各挂一条 6px 浮层拇指（`app/ui/scrollbar.js`）：滚动淡入 120ms、停手 900ms 后淡出 350ms、悬停与拖动加深、可拖动、鼠标停在拇指上不淡出，不滚时完全不可见——比 0.2.7 多出"看得见也能拖"这一层能力（用户 2026-11-13 定稿，原话："不需要键盘能操作，只需要鼠标可以操作就行"）。原生条改为在各滚动容器上藏掉（此前 `scrollbar-width:none` 挂在 `body` 上，Chromium 只认滚动容器自己，等于从没生效）。`prefers-reduced-motion` 时不做淡入淡出、直接显隐。拇指几何统一走纯函数 `thumbLayout()`（8 项单测），DOM 侧的淡入淡出与拖动没有可测接缝，靠实机手验。已知重叠：拇指占右缘 3–9px，与行右缘的拖动把手（右缘 2–20px）最外 6px 重叠——拇指可见时那 6px 先归拇指（能拖滚动条），把手还剩左侧 12px 可抓，两者不互相打死。
14. **加待办改成行右缘的悬停加号（0.4.1 新增，[ADR 0007](../docs/adr/0007-inline-add-plus.md)）**：Tk 0.2.7 有三条加待办入口——行菜单「在下方插入待办」、分组菜单「在此分组添加待办」、空白菜单「在末尾添加待办」；三处全删，`addTodoEnd` 连函数一起删。改成鼠标悬停在待办或分组标题上时、在拖动把手左侧 22px 露出一个 12px 加号（`app/ui/plus.js` 的 `plusButton`，两窗共用），点它就在该条目下方一行插入一条待办并进内联编辑：待办落在整棵子块之后（`md.todoBelow` → `subtreeEnd-1`），分组标题取组内第一条待办的缩进（`md.groupTodoIndent`，先撞空行或下一个组头就顶格），两个落点都是纯函数、8 项单测。加号上右键等同该行右键。详情面板两栏的行同样有加号（插子待办/插备注，同样落在整棵子块之后），点击前先 `commitPending` 提交未完成的编辑；底部那两个「＋ 添加子待办 / ＋ 添加备注」保留（空栏时是唯一入口），同样先提交。行内编辑中该行藏起加号与把手（`editing` class 由 `dropEditor` 统一撤），拖动中（`body.dragging`）全局藏起加号；加号 `mousedown` 一律 `preventDefault`，否则"正在编辑另一行时点加号"会先被 blur 提交+重渲染吞掉这次点击。空白菜单只剩「在末尾添加分组」，文件缺失时该项置灰（`showMenu` 新增 `disabled`：灰字、点击吞掉且菜单不关）；退出只剩顶栏 ✕。空清单（没有任何可见行，含只有空行或只有被隐藏的顶格备注）在离顶 44px 处显示灰字「右键空白处，添加分组」（`addEmptyHint` 按上方空行的 8px 间隙扣算，`pointer-events:none`）。为了让位，徽标悬停左移 20→40px，行文字右内边距 42→64px，分组标题 40→62px，标题上的加号 `right:28px`、把手 `right:8px`；菜单最小宽 160→120px。用户 2026-11-13 三轮裁决，原话："在每个待办或分组名的右边……鼠标移动到上面时显示出一个加号""空清单要通过灰色字体提示用户右键添加分组"。

15. **批量删除已完成（0.4.2 新增，Tk 0.2.7 没有）**：顶栏第 3 枚图标（垃圾桶）一键删掉清单里所有已勾选的顶层待办，没有确认框。判定只看顶层待办**自己的**勾选：父项勾了就整块删（连它下面的子待办、备注），父项没勾时它下面勾掉的子待办**一律不动**；「顶层」按子块层级判而不是顶格判，所以分组里带缩进的待办照样算。整批只压**一个**撤销快照（浮在半空的面板编辑先落定，它自己压的快照在前），所以回执上点一下或 Ctrl+Z 一次就整批退回；回执在任何新撤销快照压栈时立刻收掉（否则窗口期内又勾了一条，点回执会撤掉那一条而不是整批），撤销本身也收掉它。删除走原有的 250ms 防抖保存与行保真。删完窗口底部出现 3 秒回执「已删除 N 条 · Ctrl+Z 撤销」，可点；块里带未勾选子待办时追加一行「其中 M 条待办下有未勾选的子待办」——不跳过这些块，只报数，这是用户 2026-11-13 明确的取舍（宁可整块删，也不留下半个父子关系）；讨论稿里这句原写作「未完成子项」，落地按 GLOSSARY 的禁用词改成「未勾选的子待办」。没有已完成项时图标置灰（`.hbtn:disabled`），title 退回「删除已完成」，有 N 条时 title 报「删除已完成（N）」；入口只此一枚，空白右键菜单不动（用户否决了加进右键菜单）。空掉的分组保留标题；正在编辑的行若落在被删块里随之丢弃（不提交打的字），否则先提交；详情面板指向被删待办则关面板（与单条删除同款）。同类产品对照见 `docs/research/bulk-clear-completed-patterns.md`（7 款里只有 Google Tasks 有一键命令，且都不提供撤销）。

16. **顶栏文件入口合并成一枚下拉，↻ 删除（0.4.2 变更）**：「更换文件…」与「新建待办文件…」两枚常驻图标合并成左侧第一枚（纯文档页图标，不叠箭头也不叠加号——13px 下多一笔会糊，菜单项自己说明是打开还是新建），单击展开下拉、再单击同一枚收起，点窗口内别处、Esc、窗口失焦也收起；下拉锚在按钮左下角，溢出时由 `showMenu` 夹回窗口内，展开期间按钮与 📌 同款点亮（`.hbtn.lit`）。两项「打开文件…」「新建文件…」仍走原生对话框，行为不变。缺文件提示相应从“第 N 个图标新建 / 第 M 个图标打开”改成“点第 N 个图标在菜单里选”（`missingHint(fileIdx)` 单序号，纯函数单测跟着改）。「打开文件位置」的 ↗ 换成闭合文件夹图标（左上抬起的 tab），并在缺失态置灰（`updateRevealButton` 与 `updateClearButton` 由 `updateChrome` 一起刷，挂在 `renderList`/`showMissing` 末尾）：那时 `S.file` 的路径多半不存在，Rust 的 `open_file_location` 只能打开不存在的父目录、或弹出「文件和目录都不存在」。↻（从磁盘刷新）整枚删除，`refreshFromDisk` 一并删掉：外部改动本来就由 `poll_tick` 每秒按 mtime:size 自动重载，而用户已不再手改原始 md（先落盘再读回那条手动路径不再需要）。顶栏因此从 7 枚变 5 枚；关闭“点别处”的监听从捕获期 `mousedown` 换成捕获期 `pointerdown`——标题栏拖动区上的 mousedown 会被 Tauri 注入的 drag.js 吞掉，pointerdown 早于它，标题栏空白处才关得掉。

## 4. 验证状态
- [x] 纯函数 TDD 89/89（`node --test app/ui/*.test.js`，2026-11-13）
- [x] Rust release 编译通过（`app\build.ps1`，产物 `dist\DesktopTodo\DesktopTodo.exe`，2026-11-13）
- [x] TEST_MODE 运行时 parity：勾选/行内编辑/删除/Ctrl+Z/面板开合与内容/改名/删除、两次启动无漂移、Win+D 自愈、拖动与 grip 落盘（2026-11-13，票 #1）
- [x] 人工视觉对比（0.2.7 vs 0.3.0 截图；行距 26px、勾选框/文字/徽标同中线，用户确认）
- [x] 0.4.0 拖动排序：md.js 纯函数 26 项 TDD + DOM 侧主窗口/面板接入（2026-11-13）
- [x] 0.4.0 code-review（Standards + Spec 两轴，2026-11-13）：已修「分组拖进别人组中间会静默并组」「开头有杂物时仍能落到第一组之前」「拖到一半文件被外部改过仍按旧下标落点」「面板不认跨栏」「边缘滚动只在动鼠标时生效」「插入线右端/徽标让位未写进 PARITY」；两窗重复的拖动引擎记录为后续可抽 app/ui/dnd.js，不阻塞本次交付
- [x] code-review（Standards + Spec 两轴，2026-11-13）：4 条硬违规已修（fixture 移入 app/ui/fixtures/、测试命令路径统一、md.js 头注释、删除无调用者的 show_message）；重复菜单/commit 四连/Rust hwnd 锁辅助等判据项记录为后续重构，不阻塞本次交付
- [x] ADR 0004 两态 + 托盘（2026-11-13，`app\build.ps1` + `cargo test --offline` + 5 个 `node app/ui/*.test.js` 共 83/83）：Rust `dock_style` 3 项单测通过；实机探针复核——固定在桌面时主窗口 `ex=0x190`（TOOLWINDOW=True、APPWINDOW=False，无 topmost）且 z 序贴近桌面层（1115 条链里第 1108 位，在所有应用窗口之下）；普通窗口 `ex=0x40110`（APPWINDOW=True、TOOLWINDOW=False）且 z 序在前；托盘 `tray_icon_app` 两模式均在。踩到的坑写进代码注释：首次 `ShowWindow` 会按建窗时样式重算 exstyle，显示前设的 TOOLWINDOW 会被抹掉，必须显示后再落一次（面板 `panel_open` 同理）
- [x] ADR 0004 去闪烁（2026-11-13，[#8](https://github.com/zwxdogs/desktop-todo/issues/8)）：`set_docked_state` 去掉 hide/show，`apply_docked` 改为「tao 旗子 → 手工 exstyle → ITaskbarList → pin_bottom」。TEST_MODE 实测（UIA 点 📌 + `SetWinEventHook` 监听 `EVENT_OBJECT_SHOW`/`EVENT_OBJECT_HIDE`）：普通窗口 `ex=0x40110`、任务栏有 `DesktopTodo - 1 个运行窗口`、z 序 6/37；固定在桌面 `ex=0x190`、任务栏条目消失、z 序 35/38 且紧贴 `Progman` 之上；再切回普通 `ex=0x40110`、任务栏条目回来。两次切换 hide/show 事件均为 0、窗口全程可见（对比：改动前每次切换都是一次 hide + 一次 show，即用户看到的闪烁）。命令：`cargo test --offline`（3 项）、`app\build.ps1` release 构建后部署重启
- [x] ADR 0004 圆角与投影两态一致（2026-11-13，[#9](https://github.com/zwxdogs/desktop-todo/issues/9)）：`WS_EX_TOOLWINDOW` 让 DWM 跳过系统圆角与投影，固定在桌面时四角是直角、无阴影。`apply_docked` 落完 `set_ex_flags` 后调 `set_corner_preference`：固定在桌面 `DWMWCP_ROUND`、普通窗口 `DWMWCP_DEFAULT`。实测（TEST_MODE 把窗口 park 到空桌面区域后截图）：修前 docked 直角无阴影、normal 圆角带阴影；清掉 TOOLWINDOW 圆角与阴影立即回来；工具窗 + `DWMWCP_ROUND` 的角部像素与非工具窗完全一致（投影随之恢复）；修后两态左上角 120×120 像素差 224/14400、最大通道差 14（活动/非活动边框色调）。命令：`cargo test --offline`（3 项）、`node --test --test-isolation=none app/ui/*.test.js`（89/89）、`app\build.ps1` release 构建后部署重启
- [x] ADR 0004 运行时切换实测（2026-11-13，hide/show 版本）：TEST_MODE 里点 📌 双向切换——固定→普通 `ex=0x190→0x40110`、日志 `normal: plain window (taskbar icon on)`；普通→固定 `ex=0x40110→0x190`、z 序 1112/1117、日志 `docked: pinned above desktop (no taskbar)`；两次切换窗口都保持可见（hide/show 无残留、无崩溃）。任务栏 UIA 核对：普通窗口态出现 `桌面待办 - 1 个运行窗口`，固定桌面态该条目消失。命令：`app\build.ps1`、`cargo test --offline`（3 项）、5 个 `node app/ui/*.test.js`（83/83）。托盘路径同样实测：左键点托盘图标 → 普通窗口（`ex=0x190→0x40110`，任务栏出现「桌面待办 - 1 个运行窗口」）；右键菜单选「固定在桌面」→ 回到 `ex=0x190` 且任务栏条目消失
- [x] ADR 0004 code-review（Standards + Spec 两轴，2026-11-13）：硬违规已修（本文件验证条目补上命令）。判据项已修：「`DockStyle.appwindow` 与 `toolwindow` 互为反值」→ 合并进 `set_ex_flags` 内部互斥维护；「hwnd 取值重复 6 处」→ 抽 `win_hwnd`；「托盘 id 是裸字符串」→ 提为 `TRAY_SHOW`/`TRAY_DOCK`/`TRAY_QUIT`；「切换模式仍由前端算终态」→ 前端只上报目标态，真相源是 Rust 的 `Shared.docked`；「`save_config` 双写」→ 删前端那次；「`sync_tray_check` 并发乱序」→ 改单线程通道只落最新值；「ADR 说取内嵌图标却留纯色 fallback」→ 删 fallback；`updatePin` → `updateDockButton`。不采纳：给 ADR 新增 frontmatter 关系字段（0003 顶部已有取代注记）、为三处 `thread::spawn` 抽薄包装
- [x] 0.4.0 顶栏图标 + 点标题栏提交编辑（2026-11-13，[#3](https://github.com/zwxdogs/desktop-todo/issues/3) / [#4](https://github.com/zwxdogs/desktop-todo/issues/4)）：`node --test --test-isolation=none app/ui/*.test.js` 83/83、`node --check` 两文件、`cargo check` 通过，`app\build.ps1` release 构建后部署重启；DOM 事件顺序没有可测接缝（现有测试全是纯函数），验收靠实机手测——编辑中点标题栏空白/文字提交并落盘、右键标题栏无菜单、分组竖线可拖窗、最窄 300 时标题省略、双击最大化与拖动排序不回归
- [x] ADR 0005 解除对等约束（2026-11-13）：本文件顶部改写角色、§3 补 #3/#4 两条偏离、§2 的 menu_title 与顶栏按钮行同步；0003 / 0004 / AGENTS.md 互相引用，仓库内不再有"必须与 0.2.7 完全一致"的表述
- [x] 0.4.1 自绘滚动条（2026-11-13，[#10](https://github.com/zwxdogs/desktop-todo/issues/10)）：`node --test app/ui/*.test.js` 97/97（新增 `app/ui/scrollbar.test.js` 8 项拇指几何）、`node --check app/ui/app.js app/ui/panel.js app/ui/scrollbar.js`、`app\build.ps1` release 构建后部署重启。显隐与拖动没有可测接缝，验收走 WebView2 远程调试实机核对（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，CDP `Runtime.evaluate` + `Input.dispatchMouseEvent`）：滚轮落标题栏 `#list.scrollTop` 保持 0；落清单则滚动且 `class="vscroll on show"`、`opacity` 60ms 内到 1、停手 1.2s 后回 0；鼠标停在拇指上 1.3s 仍为 1（不淡出）；按住拇指拖 32px → `scrollTop` 120→233（理论 32×414/117≈113.2，实测 113）、拖动中 `class` 含 `dragging`；把 `#list` 的 flex 改成 `0 0 200px` 后轨道 578→174、拇指 569→57，`ResizeObserver` 跟上。截图验收改用 CDP `Page.captureScreenshot`：`PrintWindow` + `PW_RENDERFULLCONTENT` 抓不到带 opacity 过渡的合成层，会把"条子明明在闪"拍成"什么都没有"，别再拿它判断显隐动画
- [x] 0.4.0 ＋ = 新建待办文件（2026-11-13）：`node --test --test-isolation=none app/ui/*.test.js` 89/89（新增 `app/ui/starter.test.js` 6 项：示例行序、分组标题、备注缩进、逐行换行符、提示文案、"序号为 0 时不出现第 0 个"）、`node --check app/ui/app.js` / `app/ui/starter.js`、`cargo check --release` 通过，`app\build.ps1` release 构建后部署重启；DOM 接线没有可测接缝（现有测试全是纯函数），验收靠实机手测——缺文件时提示里的两个序号与顶栏图标顺序一致、点 ＋ 另存为建出的文件带示例、指到已存在文件时只打开不覆盖、缺失状态退出不落空文件且下次启动仍缺文件、示例里的父任务+备注在详情面板里能对上
- [x] 0.4.1 加待办改行内加号（2026-11-13，[ADR 0007](../docs/adr/0007-inline-add-plus.md)）：`node --test app/ui/*.test.js` 106/106（当时计数；新增 `app/ui/md.insert.test.js` 9 项：分组标题缩进、无子项待办、带子块插整块之后、组头后空行/组头/文件末尾顶格、子块尾空行不算块内、末行无换行、tab 与空格混用原样带回、note/other/blank/越界返回 null）、`node --check app/ui/app.js app/ui/panel.js app/ui/md.js app/ui/plus.js`、`app\build.ps1` release 构建后部署重启；DOM 侧的悬停显形、点击落点、提交时序没有可测接缝（现有测试全是纯函数），验收靠实机手测——悬停加号出现且与徽标不重叠、点加号新行落在整块下方并进编辑、拖动中与编辑中不露加号、空白菜单只剩加分组且缺文件时置灰、空清单灰字离顶约 44px、面板加号与底部「＋」点击前先提交在编辑的那一条
- [ ] 0.4.2 批量删除已完成（2026-11-13）：`node --test app/ui/*.test.js` 118/118（新增 `app/ui/md.completed.test.js` 12 项：空清单/全未勾、单条、`[X]` 大写、父勾子未勾报 unfinished、父未勾子勾整块跳过、分组内缩进仍算顶层且标题不打断、tab 与空格混用、块尾空行不入块、未勾选块原样保留、行保真、无命中返回新数组、全勾选只剩分组标题）。等待实机验收——勾选若干条后点顶栏垃圾桶，确认条数回执与「其中 M 条…」第二行、点回执与 Ctrl+Z 都能整批退回、0 条时图标置灰且 title 无条数、编辑中点垃圾桶不丢文字且只需一次撤销、空分组保留标题
- [x] 0.4.2 打开文件位置修斜杠（2026-11-14）：`config.json` 里 `file` 是 `E:/项目/待办.md`（Tk 时代留下的正斜杠），Rust 把原样字符串交给 `explorer /select,"…"`，explorer 判定参数非法、转去打开自己的默认文件夹（这台机器上是「桌面」），既不进父目录也不选中文件——复现出来就是用户截图那种「打开的窗口里找不到 md」。修法：`explorer_path()` 把分隔符换反斜杠并剥掉 canonicalize 的 `\\?\` / `\\?\UNC\` 前缀，`absolute_explorer_path()` 用 canonicalize 补绝对路径；缺文件退开父目录那条一起过（`explorer <dir>` 同样只认反斜杠）。`cargo test --offline` 9/9（新增 `explorer_path_tests` 3 项：正斜杠转反斜杠、verbatim 前缀剥离、原生路径原样）、`node --test app/ui/*.test.js` 118/118、`app\build.ps1` release 构建后部署重启（`E:\桌面待办\DesktopTodo`，`config.json` 原样）。实机两步对照（`SetCursorPos` + `mouse_event` 点顶栏文件夹图标，`CopyFromScreen` 截窗口）：旧构建日志 `open location: E:/项目/待办.md`、前台冒出一个「桌面 - 文件资源管理器」（= 用户报的现象）；新构建日志 `open location: E:\项目\待办.md`，打开的是「E:\项目」窗口且 `待办.md` 已选中，状态栏「选中 1 个项目 972 字节」。命令行单独跑 `explorer /select,"E:/项目/待办.md"` 同样落在「桌面」，与 app 内一致。踩到的坑：点按钮前要先点一下窗口内容区把应用切到前台，否则第一次 `mouse_event` 只起激活作用、按钮不响应；点内容区别落在勾选框列上（x 太小会误勾一条待办，这次误勾了「双波长去混叠求解器修改优化」，已按原字节改回 `- [ ]`）
- [x] 0.4.2 顶栏文件菜单合并 / 文件夹图标 / 删 ↻（2026-11-14）：`node --test app/ui/*.test.js` 118/118（`app/ui/starter.test.js` 两项跟着 `missingHint` 单序号改写）、`node --check`（复制成 `.mjs` 后按 ESM 解析）通过、`app\build.ps1` release 构建后部署重启（`E:\桌面待办\DesktopTodo`，`config.json` 原样）。DOM 事件顺序没有可测接缝（现有测试全是纯函数），验收走实机：用 `SetCursorPos` + `mouse_event` 模拟鼠标（辅助进程必须先 `SetProcessDPIAware`，否则 200% DPI 下传给 `SetCursorPos` 的物理坐标会被再缩一次而点空——第一次验失败就是这个原因）＋ `CopyFromScreen` 截窗口对照（`PrintWindow` 抓不到合成层，见「0.4.1 自绘滚动条」那条）。实测五项：点文件菜单展开「打开文件… / 新建文件…」两项且按钮点亮；再点同一枚收起；点标题栏空白（拖动区，即 mousedown 被 drag.js 吞掉的那条路径）收起且窗口位置未变（`GetWindowRect` 前后同为 3049,748）；点清单正文收起；Esc 收起。缺文件态另用 testing 模式的临时实例复现（`DesktopTodo.exe <一个不存在的路径>`，不读写 `config.json`）：占位文案是新的单序号版，「打开文件位置」与「删除已完成」两枚同时置灰。同轮 code-review（Standards + Spec 两轴）修掉：本文件首行误加的 BOM、§2 hbtn 行把合并对象写成「更换文件 + 打开文件位置」（应为更换文件 + 新建待办文件）、§3-1 的菜单处数、§3-10 里“常驻图标没有开合状态”的旧结论、§3-12 仍引用已删除的 `refreshFromDisk`、§3-15 的图标序号、§3-16 的「路径不存在」措辞、README 的禁用词（标题栏 / 更换文件），以及代码侧 `showMenu` 顺手改 owner 态改为调用方 `setMenuOwner`、两处并列的 `update*Button` 合并成 `updateChrome`
- [x] 0.4.2 清单模块（2026-11-14，[#11](https://github.com/zwxdogs/desktop-todo/issues/11)）：八个变更意图（勾选/改字/插入/删除/搬块/删除已完成/整份替换/撤销）收进 `app/ui/list.js`，撤销栈、250 ms 写盘合并、面板锚点、行保真都留在模块里；`app/ui/app.js` 十二处「压撤销 → 改行 → 重绘 → 排写盘」序列删除，入口只调意图（行为不变，§3 无新偏离）。`node --test app/ui/*.test.js` 144/144（新增 `app/ui/list.test.js` 26 项：逐字节勾选、行保真、锚点跟随、插入换行修补、子树删除、非法搬动、撤销先写后换、写盘合并、写盘失败不回滚）、`node --check` 按 ESM 解析通过、`cargo test --offline` 9/9、`app\build.ps1` release 构建后部署重启（`E:\桌面待办\DesktopTodo`，`config.json` 原样，启动日志 `loaded 27 lines` / `ui ready` / `panel: ready`）。DOM 侧验收走 WebView2 远程调试实机驱动（testing 实例 + CDP `Runtime.evaluate` / `Input.dispatchMouseEvent`，不动真实清单）：勾选 alpha 落盘 `- [x]`、Ctrl+Z 还原字节；双击分组标题改名并提交；悬停加号插入并命名；真实鼠标拖把手把末位待办拖到首位（`drop-line` 出现、落盘顺序改变）；勾上带未勾子项的父项后点垃圾桶，整块删除并弹出「已删除 1 条 · Ctrl+Z 撤销 / 其中 1 条待办下有未勾选的子待办」，Ctrl+Z 整批退回且勾选态还原；面板双击标题改名、点「＋ 添加子待办」插子行并提交，均落盘
