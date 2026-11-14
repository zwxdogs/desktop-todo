// 桌面待办 —— Tauri 2 壳。
//
// 职责边界（ADR 0003）：领域逻辑（解析/序列化/渲染/编辑）在前端 ui/md.js + app.js；
// 这里只做窗口管理、文件 IO、config 持久化、单实例、托盘、Win32 维护轮询。
// 与 todo.pyw 0.2.7 的行为对齐见 app/PARITY.md；有意差异 = 主窗口两态（固定桌面 / 普通窗口，ADR 0004）。
//
// 按接缝分家（#17）：每个模块拥有自己的一块状态与顺序，命令层只剩参数适配。
//
//   win32        Win32 FFI：全程序唯一出现 unsafe extern 的地方
//   geometry     屏幕几何：矩形、夹回屏内、面板落点（纯算术）
//   consts       进程级常量：退出宽限、看门狗阈值、托盘 id
//   dialog       原生消息框
//   config       config.json 的唯一定义
//   files        清单文件的读写与身份
//   state        共享状态的唯一句柄（Host）与进程事实
//   persist      config 落盘
//   dock         两态（固定桌面 / 普通窗口）与一次贴桌面
//   panel        详情面板窗口
//   tray         托盘图标、菜单、勾选态
//   watchdog     界面存活看门狗
//   exit         退出
//   maintenance  每秒维护：五件事各自具名
//   commands     命令层：只做参数适配
//   app          启动装配

pub mod app;
pub mod commands;
pub mod config;
pub mod consts;
pub mod dialog;
pub mod dock;
pub mod exit;
pub mod files;
pub mod geometry;
pub mod maintenance;
pub mod panel;
pub mod persist;
pub mod state;
pub mod tray;
pub mod watchdog;
pub mod win32;
