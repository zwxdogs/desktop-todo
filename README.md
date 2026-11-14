# 桌面待办

把 Markdown 待办清单固定在 Windows 桌面上显示和编辑的小工具。Tauri 2（Rust 壳 + WebView2 前端）单文件 exe，Markdown 是唯一事实源。

## 功能

- 清单模式：单击方框勾选，双击待办打开详情面板，鼠标移到分组或待办上、点名字右边露出的小加号即可在它下方加一条待办；右键编辑/删除/插入分组
- 拖动排序：鼠标移到某行右缘出现小把手，拖动即可把分组或待办搬到别处——待办带走整棵子块、分组带走整组；面板里子待办与备注各自排序
- 详情面板：上栏子待办、下栏备注，两栏等高、各自滚动；每栏左下角分别是「＋ 添加子待办」「＋ 添加备注」，行上的小加号在那一行下面插一条同类条目
- 内联编辑：双击文字改名，点编辑框以外的任何地方即结束并保存
- 批量删除已完成：顶栏垃圾桶一键删掉所有已勾选的顶层待办（连同它下面的子块），没有确认框；删完底部浮层报「已删除 N 条 · Ctrl+Z 撤销」，点浮层或按 Ctrl+Z 整批退回。父项没勾时，它下面勾掉的子待办不动；父项勾了就连未勾选的子待办一起删，浮层会补一句「其中 M 条待办下有未勾选的子待办」
- 层级只有两级：待办 → 子待办（子待办是叶子，不再挂子项或备注）；文件里已有的更深行仍照常显示，程序不会改写
- 顶栏图标：[文件菜单][打开文件位置][删除已完成] | 📌 固定在桌面 / 普通窗口（点亮＝固定在桌面）· ✕ 退出；「文件菜单」单击展开下拉，两项「打开文件…」（换一个 md）和「新建文件…」（新建待办文件）
- 空白处右键：只有「在末尾添加分组」（没打开文件时这一项是灰的）；清单为空时列表里会有一句灰字指路；右键顶栏没有菜单（打开已有、新建待办两项收进顶栏第一枚「文件菜单」，「打开文件位置」仍是它旁边那枚图标）
- 嵌入桌面层：壁纸之上、普通窗口之下；主窗口进任务栏（详情面板不进任务栏），Win+D 可见
- 外部改动（如 Obsidian）约 1 秒自动刷新，桌面上的改动自动写回
- 未被编辑的行原样保留，不破坏 Markdown 格式

## 运行

源码运行（需要 Rust 与 WebView2 Runtime）：先 `app\build.ps1` 构建，再运行 `dist\DesktopTodo\DesktopTodo.exe`；开发时也可 `cd app\src-tauri && cargo run --release`。

测试模式（不写配置，日志写到 md 同目录的 widget.log）：

```
dist\DesktopTodo\DesktopTodo.exe <md文件路径> [float|x,y]
```

不带参数时读取 exe 旁 `config.json` 记住的文件；没有配置时使用程序目录下的 `待办.md`。

## 测试

```
node --test app/ui/*.test.js
```

纯函数（Markdown 解析/序列化、子树、删除、批量删除已完成、缩进、拖动排序、滚动条几何）与清单模块、撤销栈共 144 项。

## 构建

```
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1
```

产物：`dist\DesktopTodo\DesktopTodo.exe`（单文件）与 `dist\DesktopTodo-<版本>-win64.zip`（版本取自 `app\src-tauri\tauri.conf.json`）。

## 本机部署（维护者）

```
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1
```

1. 结束正在运行的 `DesktopTodo.exe`
2. 用 `dist\DesktopTodo\DesktopTodo.exe` 覆盖 `E:\桌面待办\DesktopTodo\DesktopTodo.exe`
3. 保留该目录的 `config.json`；若还残留 PyInstaller 的 `_internal\`，整目录删掉
4. 重新启动，确认贴桌面、任务栏按钮、窗口位置与读写正常

## 下载分发版（免安装）

到 [GitHub Releases](https://github.com/zwxdogs/desktop-todo/releases) 下载 `DesktopTodo-<版本>-win64.zip`，解压到任意**可写**目录（如桌面、D 盘；不要放 Program Files），双击 `DesktopTodo.exe` 即可。

- 首次使用：点顶栏第一枚图标（文件菜单）→「打开文件…」，选择你的 Markdown 清单；或点「新建文件…」建一个，或在程序目录放一个 `待办.md`
- 绿色便携：配置（`config.json`）、WebView2 用户数据（`udf/`）和待办文件都在 exe 旁边，整个文件夹拷走即带走全部数据
- 未签名，首次运行 SmartScreen 若提示，选「更多信息 → 仍要运行」
- Windows 10 需要安装 WebView2 Evergreen Runtime（Windows 11 自带）

## 配置

`config.json` 由程序自动维护（首次运行、换文件、移动窗口后写回），平时不用手改：

```json
{ "file": "待办.md", "docked": true }
```

想换清单文件就点顶栏「文件菜单」→「打开文件…」，或往程序目录放一个 `待办.md`。`file` 为相对路径时按程序目录解析；窗口位置和大小也写在同一个文件里（物理像素，格式与 0.2.7 相同）。该文件属于本机运行时状态，已在 `.gitignore` 中排除。

## 环境

- Windows 10/11 + WebView2 Runtime
- 构建：Rust stable（cargo）
- 测试：Node.js（`node --test`）
- 回退：Tk 0.2.7 的源码已从仓库删除（见 [ADR 0006](docs/adr/0006-remove-tk-fallback.md)），需要时从 git 历史取；只想要可运行的老版本就用 Releases 里的 Tk 版（最后发布的是 `DesktopTodo-0.2.4-win64.zip`）

## 许可

本项目采用 [MIT 许可证](LICENSE)，版权归 zwxdogs 所有。可以随意使用、修改、分发和商用，保留版权声明与许可声明即可。
