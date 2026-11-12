# Tauri 2 spike（选项 C）

desktop-todo「界面美观性」问题的换栈验证：用最小 Tauri 2 应用回答四个问题——
贴桌面行不行、任务栏可见吗、行保真与中文 IME 能不能平移、启动/内存的真实数字是多少。

## 回答的问题与判据

| 问题 | 判据 | 结论（2026-11-12 实测） |
| --- | --- | --- |
| 贴桌面（壁纸之上、普通窗口之下） | win32_checks.ps1 [3][4]：Z 序仅剩桌面层、Progman 上方紧邻 | ✅ 底部方向=[Tk 挂件, Progman]，spike 紧贴其上；失焦自动重压底 |
| 任务栏可见（完整应用定位） | win32_checks.ps1 [2]：无 WS_EX_TOOLWINDOW + 人工确认任务栏按钮 | ✅ EXSTYLE=0x40110（APPWINDOW 置位、无 TOOLWINDOW）；任务栏按钮截图 ui_audit/spike/taskbar.png |
| Win+D 后行为 | win32_checks.ps1 [5][6][7]：最小化/恢复、恢复后是否回到桌面层 | ⚠️ 被最小化（IsIconic=True），与 Tk「Win+D 可见」不同（tauri #14461 族），待拍板 |
| 行保真读写 | ui/*.test.js 46 项 + 运行时勾选后文件字节级 diff=1 | ✅ 46/46 通过；写回字节级保真 |
| 中文 IME | 人工：双击行内编辑输中文，候选窗位置正常即 PASS | 待人工（composition 事件链路已在代码就绪） |
| 启动/内存 | bench/measure.ps1：热启中位、空闲进程树 private/WS；对照 Tk 30–36MB / 0.17–0.28s | ✅ 启动 冷 32ms/热中位 55ms；⚠️ 树私有 ~191MB / WS ~365MB（>ADR 0001 门槛 150MB） |
| 视觉天花板 | 顶栏 Aa 按钮打开演示卡：AA 圆角、柔和阴影、backdrop blur、平滑过渡 | ✅ 全部呈现；粘性顶栏为 body 滚动容器实现（行真从顶栏下穿过） |

## 运行

```powershell
# 构建
cd spike/tauri2/src-tauri
cargo build --release --features custom-protocol

# 跑 UI 单测（node >= 18）
cd ../ui && node --test

# 启动（指定待办文件）
$env:DT_SPIKE_FILE = 'E:\项目\desktop-todo\ui_audit\phase0\sample.md'
& ..\src-tauri\target\release\desktop-todo-spike.exe

# 行为核验 / 性能测量
powershell -File ..\bench\win32_checks.ps1
powershell -File ..\bench\measure.ps1
```

## 结构

- `ui/md.js` — 行保真核心：todo.pyw 纯函数（ADR 0002）的 JS 移植，46 个测试对应
  test_todo.py 的同名用例；`raw` 一字不动，未编辑行写回零差异。
- `ui/app.js` — 渲染/勾选/双击行内编辑（IME 面）/写回。
- `ui/style.css` — Phase 0 设计语言的延续 + Tk 8.6 做不到的部分（圆角/阴影/blur/过渡/粘性半透明顶栏）。
- `src-tauri/src/main.rs` — `set_always_on_bottom` + 失焦重压底（#9597 用 focus:false 规避）、
  不设 skip_taskbar（任务栏可见）、user32 FFI 兜底 HWND_BOTTOM、read/write_file 命令。
- `bench/` — 测量与行为核验脚本（方法学与 docs/research/tauri-electron-flutter.md 对齐）。

## 已知边界

- spike 不含：详情面板、右键菜单、外部改动 1s 轮询、Ctrl+Z、配置持久化。
- read_file/write_file 接受任意路径、无校验——spike 边界内成立，迁移时需收窄到待办文件。
- WebView2 需 #5777 绕过参数（--no-sandbox 等，见 main.rs 注释与本机报告 §3.2）。
- 测量在开发机（Ryzen 7840HS/双 4K@200%）上做，横向对比同机 Tk 数字才有意义。
