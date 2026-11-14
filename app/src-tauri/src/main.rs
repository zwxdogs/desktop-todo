// 桌面待办 —— Tauri 2 壳的入口。真正的装配在 lib 里（`app::run`），这里只保留进程外壳属性。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_todo::app::run();
}
