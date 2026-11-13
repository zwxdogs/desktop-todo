# 同类应用如何「一次清掉所有已完成项」

日期：2026-11-13　状态：调研完成（官方帮助文档逐条取证）
取证方式：直接抓取各产品官方帮助页正文；下表引号内为原文。**「未查到」指官方文档没有写，不等于产品没有该功能。**

## 结论摘要

1. 「清空所有已完成」不是通用命令：7 个对象里只有 Google Tasks 提供一键命令，且范围只到**单个清单**；其余都靠「已完成视图 + 手动多选删除」。
2. 入口几乎都在**列表/视图级菜单**（List options、Display 开关、列表顶部「清除」），没有「清空整个账户」的入口。
3. 删除普遍**不可撤销**：Todoist 明写无撤销，Things 在 iPhone/iPad 上永久删除，Apple 只靠「最近删除」保留 30 天兜底。
4. 嵌套任务的风险官方几乎不谈；唯一说清的是 Obsidian Tasks 维护者——删父项会把子项变成缩进代码块、从任务查询里消失。

## 对照表

| 应用 | 入口 | 范围 | 确认 | 可撤销/归档 | 父项带未完成子项 |
|---|---|---|---|---|---|
| [Google Tasks](https://support.google.com/tasks/answer/7675690?hl=en) | 网页版列表右侧 `List options > Delete all completed tasks`（原文 "Tip: To delete all completed tasks, on the right of the list, click List options > Delete all completed tasks."）；[Android 帮助页](https://support.google.com/tasks/answer/7675690?hl=en&co=GENIE.Platform%3DAndroid)只有单任务删除与删清单 | 当前清单 | 未查到（文档未描述确认步骤，也未提条数） | 未查到；文档只对**单任务**删除写了 "To cancel, click Undo."，批量删除未提，未见回收站 | 未查到 |
| [Microsoft To Do](https://support.microsoft.com/en-us/todo/create-edit-delete-and-restore-tasks) | 无批量清理命令。已完成项在 **Completed 智能列表**里汇总展示（设置中开启，按清单分组），要清就在该视图 Shift-click 多选 → 右键 `Delete tasks` | 当前视图/所选分组 | 桌面与网页可开关 "Confirm before deleting"，移动端强制确认；是否报条数未查到 | 删除进 Outlook「已删除邮件」，可 `Move` 回 Tasks | 未查到 |
| [Todoist](https://www.todoist.com/help/articles/view-completed-tasks-in-todoist-J19h2s) | 项目里 `Display > Completed tasks` 显示已完成，再多选删除（Ctrl/Cmd+click、Shift 选范围、移动端长按 → `Select Task`/`Select All`；见 [批量操作](https://www.todoist.com/help/articles/add-or-manage-multiple-tasks-in-todoist-PcPoskdUp)） | 当前项目/视图 | 单任务删除要点两次 `Delete`；批量删除的确认未查到 | **明写不可撤销**："Careful! There's no option to undo task deletion."，只能靠删前的 CSV 备份恢复；Reporting 记删除且 "You can't remove entries from Reporting." | 只写了反向级联（"uncomplete them, this will uncomplete their parent tasks automatically"）；删除已完成父项对未完成子项的影响未查到 |
| [Things 3](https://culturedcode.com/things/support/articles/4001304/) | 无专门命令。Logbook 即归档，⌘A 全选或多选后删除 | Logbook 当前视图 | 未查到 | Logbook 本身是归档；Mac 删除进 Trash，倒空才永久；"Deletions on iPhone, iPad, and Vision are permanent and can't be undone." | 未查到 |
| [Apple 提醒事项](https://support.apple.com/guide/reminders/delete-reminders-remna83c9566/mac) | 列表顶部「显示/隐藏」旁的「清除」→ 选取一个选项 →「删除」；在侧边栏「已完成」智能列表同样操作 | 当前列表；在「已完成」里操作即覆盖所有列表 | 未查到（文档未写确认框或条数） | 进「最近删除」，保留 30 天（最多约 40 天）可恢复，之后永久删除 | 未查到 |
| TickTick / 滴答清单 | 未查到（官方帮助中心为 SPA，抓取只得到空壳，不凭猜测补） | 未查到 | 未查到 | 未查到 | 未查到 |
| [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks/issues/3276)（Markdown 即事实源） | **没有**「删除本笔记所有已完成任务」命令（issue 2026-06-09 以 not planned 关闭）；社区插件 Archiver / obsidian-tasks-cleaner 代劳（[讨论](https://github.com/obsidian-tasks-group/obsidian-tasks/discussions/2318)： "No it's not possible... several other community plugins that do this."） | 不适用 | 不适用 | 插件未提供；只能靠编辑器撤销/git | 维护者明确警告：删父项会让子项变成缩进代码块、从任务查询中消失；"if there are nested items inside a task, do not delete it unless it only contains other completed tasks" |

来源逐条：Google Tasks [删任务/清单](https://support.google.com/tasks/answer/7675690?hl=en)、[Android 版](https://support.google.com/tasks/answer/7675690?hl=en&co=GENIE.Platform%3DAndroid)；Microsoft To Do [删除与恢复](https://support.microsoft.com/en-us/todo/create-edit-delete-and-restore-tasks)、[Completed 智能列表（官方博客）](https://techcommunity.microsoft.com/blog/to-doblog/new-features-come-to-microsoft-to-do/1359840)；Todoist [已完成任务](https://www.todoist.com/help/articles/view-completed-tasks-in-todoist-J19h2s)、[任务基础（含删除与撤销）](https://www.todoist.com/help/articles/introduction-to-tasks-080OAXric)、[批量操作](https://www.todoist.com/help/articles/add-or-manage-multiple-tasks-in-todoist-PcPoskdUp)、[子任务](https://www.todoist.com/help/articles/use-sub-tasks-in-todoist-kMamDo)；Things 3 [Logbook](https://culturedcode.com/things/support/articles/4001304/)；Apple 提醒事项 [删除提醒事项](https://support.apple.com/guide/reminders/delete-reminders-remna83c9566/mac)、[标记完成](https://support.apple.com/guide/reminders/mark-reminders-complete-or-incomplete-remndbeda47c/mac)；Obsidian Tasks [issue #3276](https://github.com/obsidian-tasks-group/obsidian-tasks/issues/3276)、[讨论 #2318](https://github.com/obsidian-tasks-group/obsidian-tasks/discussions/2318)。

## 对本项目的启示

1. **事实**：没有一家把「清空整个账户」做成入口，最接近的 Google Tasks 也只到单个清单且藏在列表菜单里。**推断**：本项目把范围限定为「当前清单（当前 Markdown 文件）」符合用户预期；若要「全部文件」，应作为独立命令且单独确认。
2. **事实**：主流交互是「先让已完成项可见，再多选删」，批量删除的确认框与条数在官方文档里几乎都查不到（Google Tasks、Things、Apple 都没写）。**推断**：我们报条数、给二次确认属于超出惯例的改进，不算违背用户习惯，但要一句话说清范围（"本清单 12 项"）。
3. **事实**：删除不可撤销是常态——Todoist 明说没有撤销，Things 在手机上永久删除，Apple 仅靠 30 天「最近删除」兜底。**推断**：本项目直接改事实源文件，风险高于上述任何一个，清理动作至少应可 Ctrl+Z，或先写备份再删。
4. **事实**：唯一正面讨论「已完成父项带未完成子项」的是 Obsidian Tasks，结论是**不要删**（子项会退化成缩进代码块、从查询里消失）。**推断**：若本项目支持缩进子项，清理命令必须跳过带未完成子项的父项，并显式提示「跳过 N 项」，不能静默连带删除。
5. **事实**：Obsidian Tasks 把这类功能以 `scope: commands` + `status: not planned` 关闭，交给社区插件。**推断**：这说明「Markdown 即事实源 + 一键删行」在生态里本身就是高风险区，做之前应先定义清楚「删哪些行、留下什么」。
