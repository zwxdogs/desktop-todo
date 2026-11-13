# PARITY — Tauri 0.3.0 vs Tk 0.2.7 行为对照

> 用户约束（m01392）：功能与 0.2.7 **完全一致，不增不减**。
> 本表逐函数对照 `todo.pyw`（1754 行，0.2.7）与 `app/`（Tauri 2）。
> 「等效」= 实现载体不同但用户可见行为一致；已知的载体差异在 §3 单列。

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

测试：`node --test app/ui/*.test.js` = **57/57**（md + undo，与 test_todo.py 36 用例同源扩展）。

## 2. 应用层逐函数对照

| todo.pyw | Tauri 实现载体 | 状态 |
|---|---|---|
| read_file(540)/write_text(550) | Rust read_md_file/write_md_file（BOM/`.todo_tmp`/replace/只读警告） | 等效 |
| load_file(565) | app.js loadFile（missing→showMissing；undo 栈重置；标题 basename 去 .md） | 等效 |
| refresh_from_disk(581) | app.js refreshFromDisk（commit→取消 save→存在则先写→load） | 等效 |
| show_missing(591) | app.js showMissing（同文案/wraplength 300） | 等效 |
| render_list(605) | app.js renderList（滚动分数保存恢复） | 等效 |
| build_row(635) | app.js buildRow + style.css（pad=16+min(8u,160)；hover/整行） | 等效 |
| draw_box(709) | app.js boxSvg（勾/白折线/2px 边） | 等效 |
| badge(750) | app.js makeBadge（SVG 勾/页 + %d/%d %d，仅 td‖nt） | 等效 |
| 顶栏 hbtn(398-478) | index.html .hbtn ×4 + CSS hover/press/lit | 等效 |
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
| menu_blank/menu_title(1463-1486) | app.js menuBlank/menuTitle | 等效* |
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
| toggle_dock/_update_pin(1517-1538) | app.js toggleDock/updatePin + Rust set_docked（topmost/pin_bottom） | 等效 |
| poll(1541) | Rust poll_tick（贴桌面维持/Win+D 还原/面板 topmost 自愈/离屏救援）+ app.js（文件变化/missing） | 等效 |
| 拖动(1602) | data-tauri-drag-region（原生拖动） | 等效* |
| 缩放 grip(1606) | Rust resize_start（系统原生 SE 向 resize） | 等效* |
| save_config(1620) | Rust write_config（py_json_string 逐字节对齐 json.dump indent=1） | 等效 |
| on_close(1633) | app.js exitApp + Rust exit_app（commit→关面板→存盘→config→退出） | 等效 |
| main(1671) | Rust main（argv 测试模式/互斥体/尺寸 clamp/默认位/启动序列） | 等效 |
| 1s 外部变化轮询 | JS pollTick 1s + Rust poll_tick | 等效 |

\* 菜单与拖拽的载体差异见 §3。

## 3. 有意的载体差异（行为一致或已获批）

1. **菜单**：Tk 原生 `tk_popup` → 自绘 HTML 菜单（白底圆角阴影）。菜单项、顺序、sep、点击语义逐项一致；视觉是 0.2.7 视觉语言的自然延伸（同 Phase 0 批准的设计方向）。
2. **主窗口进任务栏**：用户唯一点名的新行为（m00554）。面板仍不进任务栏（skip_taskbar）。
3. **拖动/缩放手势**：Tk 手动 geometry → 系统原生拖动/resize。手感更好；位置尺寸记账经 Moved/Resized → dirty_config → ≤1s 内落盘（Tk 是 release 时写）。
4. **跨窗面板通信**：Tk 直接调 self 方法 → main↔panel 事件。面板编辑提交瞬间有一次旧值→新值的重渲染（Tk 是同步刷新），≤1 帧。
5. **测试日志**：testing 模式写 `widget.log`（saved/loaded/panel/undo 等状态迁移，与 Tk 0.2.7 的 widget.log 同层级）；生产模式不写日志文件。调试期探针（click trace、按钮 client 坐标、toggle 栈、client_to_screen）已全部删除。

## 4. 验证状态

- [x] 纯函数 TDD 57/57（`node --test app/ui/*.test.js`，2026-11-13）
- [x] Rust release 编译通过（`app\build.ps1`，产物 `dist\DesktopTodo\DesktopTodo.exe`，2026-11-13）
- [x] TEST_MODE 运行时 parity：勾选/行内编辑/删除/Ctrl+Z/面板开合与内容/改名/删除、两次启动无漂移、Win+D 自愈、拖动与 grip 落盘（2026-11-13，票 #1）
- [x] 人工视觉对比（0.2.7 vs 0.3.0 截图；行距 26px、勾选框/文字/徽标同中线，用户确认）
- [x] code-review（Standards + Spec 两轴，2026-11-13）：4 条硬违规已修（fixture 移入 app/ui/fixtures/、测试命令路径统一、md.js 头注释、删除无调用者的 show_message）；重复菜单/commit 四连/Rust hwnd 锁辅助等判据项记录为后续重构，不阻塞本次交付
