// 桌面待办 0.3.0 —— Tauri 2 壳。
// 职责边界（ADR 0003）：领域逻辑（解析/序列化/渲染/编辑）在前端 ui/md.js + app.js；
// 这里只做窗口管理、文件 IO、config 持久化、单实例、Win32 维护轮询。
// 与 todo.pyw 0.2.7 的行为对齐见 app/PARITY.md；唯一有意差异 = 主窗口进任务栏。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WindowEvent};

// ---------------- Win32 FFI ----------------
const HWND_BOTTOM: isize = 1;
const GW_HWNDPREV: u32 = 3;
const GWL_EXSTYLE: i32 = -20;
const GWL_STYLE: i32 = -16;
const WS_EX_TOOLWINDOW: i64 = 0x0000_0080;
const WS_EX_TOPMOST: i64 = 0x0000_0008;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;

// #5777 workaround 参数（Win11 Build 26200 GPU/AudioService 沙箱崩溃循环）。
// additional_browser_args 会覆盖 wry 默认值，故 msWebOOUI 等常规禁用项也要自带。
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,AudioServiceSandbox --no-sandbox --disable-gpu-sandbox";
const MUTEX_NAME: &str = "Zwx_DesktopTodoWidget_Mutex";
const APP_NAME: &str = "桌面待办";

#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(hwnd: isize, hwnd_after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetForegroundWindow() -> isize;
    fn FindWindowW(class: *const u16, title: *const u16) -> isize;
    fn GetWindow(hwnd: isize, cmd: u32) -> isize;
    fn GetWindowLongW(hwnd: isize, index: i32) -> i64;
    fn SetWindowLongW(hwnd: isize, index: i32, value: i64) -> i64;
    fn IsIconic(hwnd: isize) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *const u8, initial: i32, name: *const u16) -> isize;
    fn SetLastError(code: u32);
    fn GetLastError() -> u32;
    fn GetLocalTime(out: *mut SYSTEMTIME);
}

#[repr(C)]
struct SYSTEMTIME {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn now_hms() -> String {
    let mut st = SYSTEMTIME { year: 0, month: 0, day_of_week: 0, day: 0, hour: 0, minute: 0, second: 0, milliseconds: 0 };
    unsafe { GetLocalTime(&mut st) };
    format!("{:02}:{:02}:{:02}", st.hour, st.minute, st.second)
}

// ---------------- 共享状态 ----------------
struct Shared {
    exe_dir: PathBuf,
    file: PathBuf,
    testing: bool,
    docked: bool,
    ro_warned: bool,
    dirty_config: bool, // Moved/Resized 置位，poll_tick 里统一落盘（≈Tk 拖完松手保存）
    log_path: Option<PathBuf>,
}

impl Shared {
    fn log(&self, msg: &str) {
        if let Some(p) = &self.log_path {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "[{}] {}", now_hms(), msg);
            }
        } else {
            eprintln!("[{}] {}", now_hms(), msg);
        }
    }
    fn warn_readonly(&mut self, msg: &str) {
        if self.ro_warned || self.testing {
            return;
        }
        self.ro_warned = true;
        let text = format!(
            "程序目录不可写，设置和待办改动无法保存：\n{}\n({})\n\n请把整个文件夹移动到可写目录使用（如桌面、D 盘），不要放在 Program Files 或其他只读位置。",
            self.exe_dir.display(),
            msg
        );
        show_message_box("warning", &text);
        self.log(&format!("write failed: {}", msg));
    }
}

// ---------------- 贴桌面 Win32（与 todo.pyw send_above_desktop 一致） ----------------
fn progman_hwnd() -> isize {
    let cls = wide("Progman");
    unsafe { FindWindowW(cls.as_ptr(), std::ptr::null()) }
}

fn pin_bottom(hwnd: isize) {
    unsafe {
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        // 再把 Progman 压回最底（垫底）：最终 Progman 最底、我们紧贴其上。
        // 注意第二参必须是 HWND_BOTTOM——传 hwnd 会把桌面放到我们之上，点击全穿到桌面。
        let pm = progman_hwnd();
        if pm != 0 {
            SetWindowPos(pm, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

trait Repin {
    fn repin(&self);
}
impl Repin for tauri::Window {
    fn repin(&self) {
        let _ = self.set_always_on_bottom(true);
        if let Some(h) = self.hwnd().ok().map(|h| h.0 as isize) {
            pin_bottom(h);
        }
    }
}
impl Repin for WebviewWindow {
    fn repin(&self) {
        let _ = self.set_always_on_bottom(true);
        if let Some(h) = self.hwnd().ok().map(|h| h.0 as isize) {
            pin_bottom(h);
        }
    }
}

fn at_desktop_level(hwnd: isize) -> bool {
    let pm = progman_hwnd();
    pm != 0 && unsafe { GetWindow(pm, GW_HWNDPREV) } == hwnd
}

// 面板：WS_EX_TOOLWINDOW（不进任务栏/Alt+Tab），对齐 Tk set_toolwindow。
fn set_toolwindow(hwnd: isize) {
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW);
        SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE);
    }
}

fn virtual_screen() -> (i32, i32, i32, i32) {
    let (vx, vy, vw, vh) = unsafe { (GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79)) };
    if vw <= 0 || vh <= 0 {
        return (0, 0, unsafe { GetSystemMetrics(0) }, unsafe { GetSystemMetrics(1) });
    }
    (vx, vy, vw, vh)
}

fn clamp_pos(x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    let (vx, vy, vw, vh) = virtual_screen();
    (vx.max(x.min(vx + vw - w)), vy.max(y.min(vy + vh - h)))
}

// 面板落点：优先主窗右侧，右侧放不下放左侧，再贴虚拟屏右缘；y 对齐主窗并夹回屏内。
fn panel_pos(rx: i32, ry: i32, rw: i32, pw: i32, ph: i32, gap: i32) -> (i32, i32) {
    let (vx, vy, vw, vh) = virtual_screen();
    let mut px = rx + rw + gap;
    if px + pw > vx + vw {
        px = rx - pw - gap;
    }
    if px < vx {
        px = (vx + vw - pw - gap).max(vx);
    }
    let py = vy.max(ry.min(vy + vh - ph - gap));
    (px, py)
}

// ---------------- config.json ----------------
// 与 todo.pyw json.dump(cfg, ensure_ascii=False, indent=1) 字节对齐：
// 1 空格缩进、无尾随换行、Python 风格字符串转义。
fn py_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn write_config(app: &AppHandle) {
    let (file, docked) = {
        let st = app.state::<Mutex<Shared>>();
        let s = st.lock().unwrap();
        (s.file.to_string_lossy().into_owned(), s.docked)
    };
    let Some(win) = app.get_webview_window("main") else { return };
    // Tk geometry 语义 = client 区域；无框可缩放窗口的 outer 含隐形 WS_THICKFRAME 边
    // （本机实测 outer 比 client 大 26×15 物理像素），用 outer 记忆会每轮启动膨胀。
    let Ok(pos) = win.inner_position() else { return };
    let Ok(size) = win.inner_size() else { return };
    let cfg = format!(
        "{{\n \"file\": {},\n \"x\": {},\n \"y\": {},\n \"w\": {},\n \"h\": {},\n \"docked\": {}\n}}",
        py_json_string(&file),
        pos.x, pos.y, size.width, size.height, if docked { "true" } else { "false" }
    );
    let path = {
        let st = app.state::<Mutex<Shared>>();
        let s = st.lock().unwrap();
        s.exe_dir.join("config.json")
    };
    if let Err(e) = std::fs::write(&path, cfg.as_bytes()) {
        app.state::<Mutex<Shared>>().lock().unwrap().warn_readonly(&e.to_string());
    }
}

#[derive(Default, serde::Deserialize)]
struct ConfigRaw {
    file: Option<String>,
    #[serde(default)]
    x: Option<i64>,
    #[serde(default)]
    y: Option<i64>,
    #[serde(default)]
    w: Option<i64>,
    #[serde(default)]
    h: Option<i64>,
    #[serde(default)]
    docked: Option<bool>,
}

fn load_config(app_dir: &Path) -> ConfigRaw {
    let Ok(text) = std::fs::read_to_string(app_dir.join("config.json")) else {
        return ConfigRaw::default();
    };
    // 外部工具（PS5.1 Set-Content -Encoding UTF8 等）可能写出 BOM，serde_json 不认，剥掉
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).unwrap_or_default()
}

// ---------------- 数据对象 ----------------
#[derive(Serialize)]
struct AppInfo {
    file: String,
    testing: bool,
    docked: bool,
}

#[derive(Serialize)]
struct ReadOut {
    text: String,
    has_bom: bool,
    // 与 todo.pyw read_file(547) 一致："\r\n" if "\r\n" in text else "\n"
    nl: String,
}

#[derive(Serialize, Clone)]
struct FileState {
    // ns 自 epoch；超 JS Number 精度，按字符串比较（与 Tk 的 mtime_ns 整数元组等价）
    mtime_ns: String,
    size: u64,
}

fn stat_file(path: &Path) -> Option<FileState> {
    let md = std::fs::metadata(path).ok()?;
    let t = md.modified().ok()?;
    let ns = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(FileState { mtime_ns: ns.to_string(), size: md.len() })
}

fn read_md_file(path: &Path) -> Result<ReadOut, String> {
    let data = std::fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("missing: {}", e)
        } else {
            format!("read: {}", e)
        }
    })?;
    let has_bom = data.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if has_bom { &data[3..] } else { &data[..] };
    let text = String::from_utf8(body.to_vec()).map_err(|e| format!("utf8: {}", e))?;
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    Ok(ReadOut { text, has_bom, nl: nl.to_string() })
}

// 与 todo.pyw write_text 一致：tmp + os.replace 原子替换，保留 BOM。
fn write_md_file(path: &Path, content: &str, has_bom: bool) -> Result<(), String> {
    let mut data: Vec<u8> = Vec::with_capacity(content.len() + 3);
    if has_bom {
        data.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    data.extend_from_slice(content.as_bytes());
    // todo.pyw 用 path + ".todo_tmp"；with_extension 会替换已有扩展名，手动拼接
    let tmp_s = format!("{}.todo_tmp", path.display());
    let tmp = PathBuf::from(tmp_s);
    std::fs::write(&tmp, &data).map_err(|e| format!("write: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace: {}", e))
}

// ---------------- 命令 ----------------
#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let s = app.state::<Mutex<Shared>>();
    let s = s.lock().unwrap();
    AppInfo { file: s.file.to_string_lossy().into_owned(), testing: s.testing, docked: s.docked }
}

#[tauri::command]
async fn read_md(file: String) -> Result<ReadOut, String> {
    read_md_file(Path::new(&file))
}

// 失败时不报错而是返回 false：与 Tk write_text 一致（弹窗提示后继续运行）
#[tauri::command]
async fn write_md(app: AppHandle, file: String, content: String, has_bom: bool) -> Result<bool, String> {
    match write_md_file(Path::new(&file), &content, has_bom) {
        Ok(()) => Ok(true),
        Err(e) => {
            app.state::<Mutex<Shared>>().lock().unwrap().warn_readonly(&e);
            Ok(false)
        }
    }
}

#[tauri::command]
async fn file_state(file: String) -> Option<FileState> {
    stat_file(Path::new(&file))
}

#[tauri::command]
fn save_config(app: AppHandle) {
    write_config(&app);
}

#[tauri::command]
fn set_docked(app: AppHandle, win: WebviewWindow, docked: bool) {
    app.state::<Mutex<Shared>>().lock().unwrap().docked = docked;
    let hwnd = win.hwnd().ok().map(|h| h.0 as isize);
    if docked {
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_bottom(true);
        if let Some(h) = hwnd {
            pin_bottom(h);
        }
        app.state::<Mutex<Shared>>().lock().unwrap().log("docked: pinned above desktop");
    } else {
        // 关键：先清 ALWAYS_ON_BOTTOM——tao 的 WM_WINDOWPOSCHANGING handler
        // 在该 flag 存在时会把每次 SetWindowPos 的 hwndInsertAfter 强制改写为
        // HWND_BOTTOM（event_loop.rs:1139-1143），不清除则置顶永远被反向压底。
        let _ = win.set_always_on_bottom(false);
        let _ = win.set_always_on_top(true);
        app.state::<Mutex<Shared>>().lock().unwrap().log("floating: topmost on");
    }
    write_config(&app);
}

// 右下角 grip 拖拽缩放（对齐 Tk grip 的 resize 手势；系统原生手感，松手由 Moved/Resized 记账）
#[tauri::command]
fn resize_start(window: tauri::Window) {
    let _ = window.start_resize_dragging(tauri_runtime::ResizeDirection::SouthEast);
}

// 1s 维护轮询（对齐 todo.pyw poll()）：贴桌面维持、面板置顶自愈、离屏救援、
// config 落盘；返回文件状态供 JS 决定是否重载。
#[tauri::command]
fn poll_tick(app: AppHandle, win: WebviewWindow) -> Option<FileState> {
    let hwnd = win.hwnd().ok().map(|h| h.0 as isize);
    let (docked, file) = {
        let s = app.state::<Mutex<Shared>>();
        let s = s.lock().unwrap();
        (s.docked, s.file.clone())
    };
    if docked {
        if let Some(h) = hwnd {
            unsafe {
                if IsIconic(h) != 0 {
                    // Win+D / 全部最小化会把本窗口也最小化，立即还原，保持桌面可见
                    let _ = win.unminimize();
                    win.repin();
                    app.state::<Mutex<Shared>>().lock().unwrap().log("restored from Win+D minimize");
                } else if GetForegroundWindow() != h && !at_desktop_level(h) {
                    win.repin();
                }
            }
        }
    }
    // 面板 WS_EX_TOPMOST 被系统剥除时兜底自愈（Win32 位直读，Tk attributes 不可信的同款绕行）
    if let Some(p) = app.get_webview_window("panel") {
        if p.is_visible().unwrap_or(false) {
            if let Some(ph) = p.hwnd().ok().map(|h| h.0 as isize) {
                unsafe {
                    if GetWindowLongW(ph, GWL_EXSTYLE) & WS_EX_TOPMOST == 0 {
                        let _ = p.set_always_on_top(true);
                        app.state::<Mutex<Shared>>().lock().unwrap().log("panel topmost stripped by system -> restored");
                    }
                }
            }
        }
    }
    // 离屏救援（拖过头/显示器热插拔/改分辨率）——client 语义与 Tk 一致
    if let (Some(h), Ok(pos), Ok(size)) = (hwnd, win.inner_position(), win.inner_size()) {
        unsafe {
            if IsIconic(h) == 0 {
                let (nx, ny) = clamp_pos(pos.x, pos.y, size.width as i32, size.height as i32);
                if (nx, ny) != (pos.x, pos.y) {
                    let _ = win.set_position(PhysicalPosition::new(nx, ny));
                    app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("window off-screen -> rescued to {},{}", nx, ny));
                }
            }
        }
    }
    // Moved/Resized 攒下的 config 落盘
    let dirty = { app.state::<Mutex<Shared>>().lock().unwrap().dirty_config };
    if dirty {
        write_config(&app);
        app.state::<Mutex<Shared>>().lock().unwrap().dirty_config = false;
    }
    stat_file(&file)
}

#[tauri::command]
fn panel_open(app: AppHandle, win: WebviewWindow) {
    let Some(p) = app.get_webview_window("panel") else { return };
    let Ok(sf) = win.scale_factor() else { return };
    let s = sf.max(1.0);
    let pw = (420.0 * s) as i32;
    let ph = (520.0 * s) as i32;
    let gap = (12.0 * s) as i32;
    // Tk panel_pos 用 winfo_rootx/rooty/width（client 语义）
    let Ok(mpos) = win.inner_position() else { return };
    let Ok(msize) = win.inner_size() else { return };
    let (px, py) = panel_pos(mpos.x, mpos.y, msize.width as i32, pw, ph, gap);
    let _ = p.set_position(PhysicalPosition::new(px, py));
    let _ = p.set_size(PhysicalSize::new(pw as u32, ph as u32));
    // TOOLWINDOW 样式在显示后再确认一次（映射时 wm 可能重算 exstyle，Tk 同款问题）
    if let Some(h) = p.hwnd().ok().map(|h| h.0 as isize) {
        set_toolwindow(h);
    }
    let _ = p.set_always_on_top(true);
    let _ = p.show();
    let _ = p.set_focus();
    app.state::<Mutex<Shared>>().lock().unwrap().log("panel open");
}

#[tauri::command]
fn panel_close(app: AppHandle) {
    if let Some(p) = app.get_webview_window("panel") {
        let _ = p.hide();
    }
    app.state::<Mutex<Shared>>().lock().unwrap().log("panel closed");
}

#[tauri::command]
async fn choose_file(app: AppHandle) -> Option<String> {
    let (cur, exe_dir) = {
        let s = app.state::<Mutex<Shared>>();
        let s = s.lock().unwrap();
        (s.file.clone(), s.exe_dir.clone())
    };
    let mut dlg = rfd::FileDialog::new().set_title("选择待办 Markdown 文件");
    if cur.exists() {
        if let Some(d) = cur.parent() {
            dlg = dlg.set_directory(d);
        }
    } else {
        dlg = dlg.set_directory(&exe_dir);
    }
    dlg = dlg.add_filter("Markdown 文件", &["md"]).add_filter("所有文件", &["*"]);
    dlg.pick_file().map(|p| {
        // Tk choose_file(1493)：self.file = path —— 后续 save_config/读写都用新路径
        let path = p.to_string_lossy().into_owned();
        app.state::<Mutex<Shared>>().lock().unwrap().file = PathBuf::from(&path);
        path
    })
}

#[tauri::command]
async fn open_file_location(app: AppHandle, file: String) {
    use std::os::windows::process::CommandExt;
    let path = PathBuf::from(&file);
    if path.exists() {
        // canonical 形式: explorer /select,"路径"
        match std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.display())).spawn() {
            Ok(_) => app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("open location: {}", path.display())),
            Err(e) => {
                show_message_box("info", &format!("打开失败：{}", e));
                app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("open location failed: {:?}", e));
            }
        }
    } else if path.parent().map(|d| d.is_dir()).unwrap_or(false) {
        let d = path.parent().unwrap();
        match std::process::Command::new("explorer").arg(d).spawn() {
            Ok(_) => app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("open dir (file missing): {}", d.display())),
            Err(e) => {
                show_message_box("info", &format!("打开失败：{}", e));
                app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("open location failed: {:?}", e));
            }
        }
    } else {
        show_message_box("info", &format!("文件和目录都不存在：\n{}", path.display()));
    }
}

fn show_message_box(level: &str, text: &str) {
    let dialog = rfd::MessageDialog::new().set_title(APP_NAME).set_description(text);
    let dialog = match level {
        "warning" => dialog.set_level(rfd::MessageLevel::Warning),
        "error" => dialog.set_level(rfd::MessageLevel::Error),
        _ => dialog.set_level(rfd::MessageLevel::Info),
    };
    dialog.show();
}

#[tauri::command]
fn log_line(app: AppHandle, msg: String) {
    app.state::<Mutex<Shared>>().lock().unwrap().log(&msg);
}

// JS 先提交编辑、写盘，再调这里：保存 config 后整体退出（对齐 todo.pyw on_close 收尾）
#[tauri::command]
fn exit_app(app: AppHandle) {
    write_config(&app);
    app.state::<Mutex<Shared>>().lock().unwrap().log("exit");
    app.exit(0);
}

// ---------------- 启动 ----------------
fn main() {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let app_dir = exe_dir.clone().unwrap_or_else(|| PathBuf::from("."));

    // argv：[1]=md 路径 → 测试运行；[2]="float" 或 "x,y"（物理像素）
    // （对齐 todo.pyw：argv[2]=="float" 悬浮置顶测试；"x,y" 指定桌面位置）
    let args: Vec<String> = std::env::args().skip(1).collect();
    let testing = !args.is_empty();
    let mut want_dock = true;
    let mut test_pos: Option<(i32, i32)> = None;
    if testing && args.len() > 1 {
        if args[1] == "float" {
            want_dock = false;
        } else {
            test_pos = args[1]
                .split(',')
                .map(|v| v.trim().parse::<i32>().ok())
                .collect::<Option<Vec<i32>>>()
                .and_then(|v| if v.len() == 2 { Some((v[0], v[1])) } else { None });
        }
    }

    let cfg = if testing { ConfigRaw::default() } else { load_config(&app_dir) };
    let file: PathBuf = match (args.first(), cfg.file.clone()) {
        (Some(md), _) => PathBuf::from(md),
        (None, Some(f)) if !f.is_empty() => {
            let p = PathBuf::from(&f);
            if p.is_absolute() {
                p
            } else {
                app_dir.join(p)
            }
        }
        _ => app_dir.join("待办.md"),
    };
    let initial_dock = if testing { want_dock } else { cfg.docked.unwrap_or(true) };

    let log_path = testing.then(|| file.parent().unwrap_or(&app_dir).join("widget.log"));

    // 单实例保护（启动器可能留下 183 的 last error，先清零再建互斥体）
    let name = wide(MUTEX_NAME);
    unsafe {
        SetLastError(0);
        CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if GetLastError() == 183 {
            // ERROR_ALREADY_EXISTS
            std::process::exit(0);
        }
    }

    let managed = Mutex::new(Shared {
        exe_dir: app_dir.clone(),
        file,
        testing,
        docked: initial_dock,
        ro_warned: false,
        dirty_config: false,
        log_path,
    });

    tauri::Builder::default()
        .manage(managed)
        .invoke_handler(tauri::generate_handler![
            app_info, read_md, write_md, file_state, save_config, set_docked,
            resize_start, poll_tick,
            panel_open, panel_close, choose_file, open_file_location,
            log_line, exit_app
        ])
        .setup(move |app| {
            // UDF：exe 旁的 udf/（绿色便携语义，与 config.json 同址；
            // loader 对显式 UDF 要求目录可创建，失败会清掉新建目录 —— 见 spike 报告 §3.1）
            let udf = exe_dir.as_ref().map(|d| d.join("udf"));
            let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
            let s = scale.max(1.0);
            let (sw, sh) = unsafe { (GetSystemMetrics(0), GetSystemMetrics(1)) };

            // 主窗口：进任务栏（用户要求，0.2.7 唯一有意差异）；
            // #9597 workaround：创建时不抢焦点，随后压底才不会被“创建即置顶”顶回来
            let win = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(APP_NAME)
                .min_inner_size(260.0, 180.0)
                .decorations(false)
                .transparent(false)
                .resizable(true)
                .visible(false)
                .focused(false);
            let win = if let Some(d) = udf.clone() {
                let _ = std::fs::create_dir_all(&d);
                win.data_directory(d)
            } else {
                win
            };
            let win = win.additional_browser_args(BROWSER_ARGS).build()?;
            win.hide()?;

            // 尺寸/位置：config 存物理像素（与 Tk PMv2 下 winfo 坐标 1:1）
            let (x, y, w, h) = if testing {
                let w = (430.0 * s) as i32;
                let h = (660.0 * s) as i32;
                let (dx, dy) = test_pos.unwrap_or(((100.0 * s) as i32, (100.0 * s) as i32));
                (dx, dy, w, h)
            } else {
                let w = match cfg.w {
                    Some(v) => (v as i32).min(sw - 20),
                    None => (380.0 * s) as i32,
                };
                let h = match cfg.h {
                    Some(v) => (v as i32).min(sh - 60),
                    None => (640.0 * s) as i32,
                };
                let w = w.max((260.0 * s) as i32);
                let h = h.max((180.0 * s) as i32);
                let (x, y) = match (cfg.x, cfg.y) {
                    (Some(ax), Some(ay)) => (ax as i32, ay as i32),
                    _ => (sw - w - (40.0 * s) as i32, (100.0 * s) as i32),
                };
                let (x, y) = clamp_pos(x, y, w, h);
                (x, y, w, h)
            };
            win.set_size(PhysicalSize::new(w as u32, h as u32))?;
            // tao 的 set_position 是 outer 语义，而 config 存的是 client(inner) 坐标（Tk winfo 语义）。
            // 无框可缩放窗口带隐形 WS_THICKFRAME 边，直接按 inner 值设会每轮向右下漂移；
            // 设置后读回 inner 原点求一次偏差并补偿，二次调用收敛。
            win.set_position(PhysicalPosition::new(x, y))?;
            if let Ok(ip) = win.inner_position() {
                let (dx, dy) = (x - ip.x, y - ip.y);
                if dx != 0 || dy != 0 {
                    win.set_position(PhysicalPosition::new(x + dx, y + dy))?;
                }
            }

            // 初始 dock：悬浮 = 置顶；贴桌面 = 压底（顺序与 Tk 相同）
            if want_dock {
                let _ = win.set_always_on_top(false);
                win.repin();
                let hwnd = win.hwnd().ok().map(|h| h.0 as isize).unwrap_or(-1);
                app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("desktop mode: hwnd={}", hwnd));
            } else {
                let _ = win.set_always_on_top(true);
            }
            win.show()?;

            // 详情面板：独立 webview 窗口，隐藏待用；不进任务栏/Alt+Tab（对齐 Tk toolwindow）
            let panel = tauri::WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("panel.html".into()))
                .title(APP_NAME)
                .inner_size(420.0, 520.0)
                .decorations(false)
                .resizable(false)
                .visible(false)
                .skip_taskbar(true)
                .focused(false);
            let panel = if let Some(d) = udf {
                panel.data_directory(d)
            } else {
                panel
            };
            let panel = panel.additional_browser_args(BROWSER_ARGS).build()?;
            panel.hide()?;
            if let Some(h) = panel.hwnd().ok().map(|h| h.0 as isize) {
                set_toolwindow(h);
            }
            let _ = panel.set_always_on_top(true);

            Ok(())
        })
        .on_window_event(|win, event| match event {
            WindowEvent::Focused(false) => {
                // 只在贴桌面模式重压底；悬浮置顶模式保持置顶
                let app = win.app_handle();
                let docked = app.state::<Mutex<Shared>>().lock().unwrap().docked;
                if win.label() == "main" && docked {
                    win.repin();
                }
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                // 拖动/缩放期间高频触发，只在 poll_tick 统一落盘（≈Tk 松手保存）
                if win.label() == "main" {
                    win.app_handle().state::<Mutex<Shared>>().lock().unwrap().dirty_config = true;
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                let app = win.app_handle();
                if win.label() == "main" {
                    // 任务栏右键关闭 / Alt+F4：交给 JS 走 on_close 语义（提交编辑→保存→退出）
                    api.prevent_close();
                    let _ = app.emit("app-exit-request", ());
                } else {
                    // 面板被外部关闭（Alt+F4）：与面板内 ✕ 同路径
                    api.prevent_close();
                    let _ = app.emit_to("main", "panel-close", ());
                    if let Some(p) = app.get_webview_window("panel") {
                        let _ = p.hide();
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
