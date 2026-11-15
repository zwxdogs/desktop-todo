# 桌面待办

基于Tauri 2开发，把待办清单固定在 Windows 桌面上显示和编辑的小工具。待办清单以Markdown文件保存。

<div align=left><img src="https://raw.githubusercontent.com/zwxdogs/markdown-image/main/20261115142143692.png" height=300></div>

## 功能

- 清单模式：单击方框勾选，双击待办打开详情面板。鼠标移到分组或待办上，右侧出现加号可以点击用于添加待办。右键点击待办也可以进行编辑/删除/插入分组。
- 拖动排序：鼠标移到某行待办最右侧出现的小把手可拖动待办或分组。
- 详情面板：上栏子待办、下栏备注。
- 修改待办：目前只能在详情面板中双击待办或右键编辑来修改。
- 批量删除：顶栏垃圾桶一键删掉所有已勾选的顶层待办，删除后用点击浮窗或使用Ctrl+Z可撤销。
- 固定在桌面：点击图钉图标可以将待办窗口固定在桌面（置于底层）。
- 主题色：托盘右键菜单「主题色」→ 亮色 / 暗色 / 跟随系统。

## 下载与运行

[GitHub Releases](https://github.com/zwxdogs/desktop-todo/releases) 下载 `DesktopTodo-<版本>-win64.zip`，解压到任意**可写**目录（如桌面、D 盘；不要放 Program Files），双击 `DesktopTodo.exe` 即可。
- 首次使用请点击顶栏第一个图标（文件菜单）→「新建文件…」，新建一个待办清单的md文件。

## 环境

- Windows 10/11 + WebView2 Runtime
- 构建：Rust stable（cargo）
- 测试：Node.js（`node --test`）

## 许可

本项目采用 [MIT 许可证](LICENSE)，版权归 zwxdogs 所有。可以随意使用、修改、分发和商用，保留版权声明与许可声明即可。
