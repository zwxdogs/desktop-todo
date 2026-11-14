//! 命令层：前端能调的每一件事，这里只做参数适配。
//!
//! 命令里不出现 Win32 调用、也不直接拿共享状态的锁——需要动窗口就找 `dock` / `panel`，
//! 需要动文件就找 `files`，需要落盘就找 `persist`，需要状态就问 `Host`。
//! 这样「命令」与「实现」各自可读，也各自可测。

use serde::Serialize;
use std::path::Path;

use crate::dialog;
use crate::dock;
use crate::exit;
use crate::files::{self, FileIdentity, FileState, ReadOut};
use crate::maintenance;
use crate::panel;
use crate::persist;
use crate::state::Host;
use crate::watchdog;

#[derive(Serialize)]
pub struct AppInfo {
    #[serde(flatten)]
    pub identity: FileIdentity,
    pub docked: bool,
}

#[derive(Serialize)]
pub struct NewFileOut {
    #[serde(flatten)]
    pub identity: FileIdentity,
    pub created: bool,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    let host = Host::of(&app);
    AppInfo { identity: FileIdentity::of(&host.file()), docked: dock::is_docked(&host) }
}

#[tauri::command]
pub async fn read_md(file: String) -> Result<ReadOut, String> {
    files::read(Path::new(&file))
}

/// 写失败时把原因**抛给前端**（不再只回一个 false）：界面上那条「保存失败」要说明
/// 为什么失败——磁盘满、文件被别的程序占着、目录只读，处置办法完全不同（#18）。
///
/// 返回 `Result<(), String>` 而不是 `Result<bool, String>`：成功就是 `Ok(())`，
/// 失败就是 `Err(原因)`，没有「成功但返回 false」这种第三种状态。
///
/// 「目录不可写」那类仍然弹一次原生框（`warn_readonly` 自己按 os error 号分类并去重），
/// 其余的失败只进提示条——以前它把任何写失败都判成这一类，磁盘满时会建议人去搬文件夹。
#[tauri::command]
pub async fn write_md(app: tauri::AppHandle, file: String, content: String, has_bom: bool) -> Result<(), String> {
    match files::write(Path::new(&file), &content, has_bom) {
        Ok(()) => Ok(()),
        Err(e) => {
            Host::of(&app).warn_readonly(&e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn file_state(file: String) -> Option<FileState> {
    maintenance::file_state(&file)
}

#[tauri::command]
pub fn save_config(app: tauri::AppHandle) {
    persist::save(&Host::of(&app));
}

#[tauri::command]
pub fn set_docked(app: tauri::AppHandle, docked: bool) {
    dock::switch(&Host::of(&app), docked);
}

/// 右下角 grip 拖拽缩放（对齐 Tk grip 的 resize 手势；系统原生手感，松手由 Moved/Resized 记账）。
#[tauri::command]
pub fn resize_start(window: tauri::Window) {
    let _ = window.start_resize_dragging(tauri_runtime::ResizeDirection::SouthEast);
}

/// 1s 维护轮询：五件事各自具名（见 `maintenance`），返回值只有文件状态。
#[tauri::command]
pub fn poll_tick(app: tauri::AppHandle, win: tauri::WebviewWindow, file: String) -> Option<FileState> {
    maintenance::tick(&Host::of(&app), &win, &file)
}

// 五件事各自也能单独触发：整轮轮询是常规路径，单步入口给探针与将来的按需维护用。
// 名字与 `maintenance` 里的步骤一一对应，不再另起一套叫法。

/// ① 保持贴在桌面层（Win+D 还原 / 被顶开后重新压底）。
#[tauri::command]
pub fn maintain_reanchor(app: tauri::AppHandle, win: tauri::WebviewWindow) {
    maintenance::reanchor(&Host::of(&app), &win);
}

/// ② 面板置顶自愈。
#[tauri::command]
pub fn maintain_heal_panel(app: tauri::AppHandle) {
    maintenance::heal_panel(&Host::of(&app));
}

/// ③ 离屏救援。
#[tauri::command]
pub fn maintain_rescue_offscreen(app: tauri::AppHandle, win: tauri::WebviewWindow) {
    maintenance::rescue_offscreen(&Host::of(&app), &win);
}

/// ④ 把攒下的几何改动落进 config.json。
#[tauri::command]
pub fn maintain_flush_config(app: tauri::AppHandle) {
    maintenance::flush_config(&Host::of(&app));
}

/// ⑤ 读文件状态。
#[tauri::command]
pub async fn maintain_file_state(file: String) -> Option<FileState> {
    maintenance::file_state(&file)
}

#[tauri::command]
pub fn panel_open(app: tauri::AppHandle, win: tauri::WebviewWindow) {
    panel::open(&Host::of(&app), &win);
}

#[tauri::command]
pub fn panel_close(app: tauri::AppHandle) {
    panel::close(&Host::of(&app));
}

#[tauri::command]
pub async fn choose_file(app: tauri::AppHandle) -> Option<FileIdentity> {
    let host = Host::of(&app);
    let dir = files::dialog_dir(&host.file(), &host.exe_dir());
    let picked = rfd::FileDialog::new()
        .set_title("选择待办 Markdown 文件")
        .set_directory(dir)
        .add_filter("Markdown 文件", &["md"])
        .add_filter("所有文件", &["*"])
        .pick_file();
    // Tk choose_file(1493)：self.file = path —— 后续 save_config 都落新路径；
    // 读写类命令不读它，目标永远由调用方显式带路径
    picked.map(|p| host.replace_file(p))
}

/// ＋ 新建待办文件：原生「另存为」挑位置，只有路径不存在时才写入示例内容。
///
/// 指到已存在的文件一律不覆盖——那多半是用户想打开它，交给前端按「打开已有文件」处理。
#[tauri::command]
pub async fn new_md_file(app: tauri::AppHandle, content: String) -> Result<Option<NewFileOut>, String> {
    let host = Host::of(&app);
    let dir = files::dialog_dir(&host.file(), &host.exe_dir());
    let picked = rfd::FileDialog::new()
        .set_title("新建待办 Markdown 文件")
        .set_directory(dir)
        .set_file_name("待办.md")
        .add_filter("Markdown 文件", &["md"])
        .save_file();
    let Some(p) = picked else { return Ok(None) };
    let created = files::create_with_template(&p, &content)?;
    Ok(Some(NewFileOut { identity: host.replace_file(p), created }))
}

#[tauri::command]
pub async fn open_file_location(app: tauri::AppHandle, file: String) {
    let host = Host::of(&app);
    let path = Path::new(&file);
    match files::reveal(path) {
        Ok(target) => host.log(&format!("open location: {}", target)),
        Err(e) => {
            // 两个分支的失败文案不同：spawn 失败是「打开失败：…」，两者都不存在是路径提示
            let text = if path.exists() || path.parent().map(|d| d.is_dir()).unwrap_or(false) {
                format!("打开失败：{}", e)
            } else {
                e
            };
            dialog::show(dialog::Level::Info, &text);
            host.log(&format!("open location failed: {}", text));
        }
    }
}

#[tauri::command]
pub fn log_line(app: tauri::AppHandle, msg: String) {
    Host::of(&app).log(&msg);
}

/// 每秒一次的心跳：看门狗据此判断界面还活着（ADR 0008）。
#[tauri::command]
pub fn heartbeat(app: tauri::AppHandle, ready: Option<bool>) {
    watchdog::beat(&Host::of(&app), ready == Some(true));
}

/// JS 先提交编辑、写盘，再调这里：保存 config 后整体退出（对齐 todo.pyw on_close 收尾）。
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    exit::finish(&Host::of(&app));
}
