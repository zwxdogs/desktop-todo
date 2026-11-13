// 桌面待办 0.4.0 —— Tauri 2 壳。
// 职责边界（ADR 0003）：领域逻辑（解析/序列化/渲染/编辑）在前端 ui/md.js + app.js；
// 这里只做窗口管理、文件 IO、config 持久化、单实例、托盘、Win32 维护轮询。
// 与 todo.pyw 0.2.7 的行为对齐见 app/PARITY.md；有意差异 = 主窗口两态（固定桌面 / 普通窗口，ADR 0004）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WindowEvent,
};

// ---------------- Win32 FFI ----------------
const HWND_BOTTOM: isize = 1;
const GW_HWNDPREV: u32 = 3;
const GWL_EXSTYLE: i32 = -20;
const GWL_STYLE: i32 = -16;
const WS_EX_TOOLWINDOW: i64 = 0x0000_0080;
const WS_EX_APPWINDOW: i64 = 0x0004_0000;
const WS_EX_TOPMOST: i64 = 0x0000_0008;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;
// DWM 圆角偏好（Win11）：工具窗默认不圆、也没有投影，必须显式要 ROUND 才和普通窗口一致。
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWCP_DEFAULT: u32 = 0;
const DWMWCP_ROUND: u32 = 2;

// #5777 workaround 参数（Win11 Build 26200 GPU/AudioService 沙箱崩溃循环）。
// additional_browser_args 会覆盖 wry 默认值，故 msWebOOUI 等常规禁用项也要自带。
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,AudioServiceSandbox --no-sandbox --disable-gpu-sandbox";
// 自动重启专用参数：新实例要等老进程把单实例锁放掉再接管（见 main 里的文件锁循环）
const RESTART_ARG: &str = "--wait-mutex";
const APP_NAME: &str = "桌面待办";
// 退出宽限（ADR 0008）：JS 收到 app-exit-request 后要提交编辑、写盘再调 exit_app。
// 写盘是 tmp+rename 的原子替换，所以到点强退不会写坏文件；等不到 JS 也必须退。
const EXIT_GRACE: Duration = Duration::from_millis(2500);
// 看门狗阈值（ADR 0008）：页面连加载都没完成 → 12s；JS 起过但心跳停了 → 20s。
// 正常启动慢盘/大文件也就几秒，取够宽松，宁可晚点救也不要误 reload 丢未提交编辑。
const WATCHDOG_LOAD_LIMIT: Duration = Duration::from_secs(12);
const WATCHDOG_BEAT_LIMIT: Duration = Duration::from_secs(20);
const WATCHDOG_MAX_RELOADS: u32 = 3;
// 托盘菜单项 id（菜单构建与事件匹配共用，避免字符串两处各写一遍）
const TRAY_SHOW: &str = "tray-show";
const TRAY_DOCK: &str = "tray-dock";
const TRAY_QUIT: &str = "tray-quit";

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

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const std::os::raw::c_void, size: u32) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        attrs: *const u8,
        disposition: u32,
        flags: u32,
        template: isize,
    ) -> isize;
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
    // ---- 界面存活看门狗（ADR 0008）----
    // 白屏有两种死法，都要能自救：① 页面根本没加载（shown_at 之后一直没动静）；
    // ② 页面加载过、WebView2 进程后来死了（心跳停）。两种都不该把用户锁在关不掉的窗口里。
    shown_at: Instant,   // 主窗 show() 的时刻，boot 成功 / reload 时重置
    page_loaded: bool,   // on_page_load 收到过 Finished
    last_beat: Instant,  // 最近一次 JS 心跳（ui 里 setInterval 每秒一次）
    js_ready: bool,      // JS boot 跑完过一次
    reloads: u32,        // 已自救 reload 次数
    exiting: bool,       // 退出流程已开始，看门狗停手
    gave_up: bool,       // 放弃自救只记一次日志（退出仍然可用）
    can_restart: bool,   // 这次运行还允许自动重启一次（防连环重启）
    restart_marker: PathBuf, // 重启标记文件：页面成功加载后删掉
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

// 托盘勾选态的同步通道（由常驻线程消费，见 sync_tray_check）
struct TrayState {
    check_tx: Mutex<Option<std::sync::mpsc::Sender<bool>>>,
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

// WS_EX_TOOLWINDOW / WS_EX_APPWINDOW 是一对互斥语义：toolwindow=true 就同时清掉 APPWINDOW。
// 必须两个一起处理——创建时 tao 给了 WS_EX_APPWINDOW，两者并存时它会盖过 TOOLWINDOW 把任务栏按钮撑回来。
// 样式改动后必须 SetWindowPos(SWP_FRAMECHANGED) 才会被 shell 采纳。
fn set_ex_flags(hwnd: isize, toolwindow: bool) {
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        let next = if toolwindow {
            (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW
        } else {
            (ex & !WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW
        };
        if next != ex {
            SetWindowLongW(hwnd, GWL_EXSTYLE, next);
            SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        }
    }
}

// ---------------- 主窗口两态（ADR 0004） ----------------
// 固定在桌面：桌面图标之上、所有应用窗口之下，任务栏与 Alt+Tab 里都没有它。
// 普通窗口：正常 z 序，任务栏有图标、Alt+Tab 里有它。两种模式都不用 topmost（置顶功能已下线）。
#[derive(Debug, PartialEq, Clone, Copy)]
struct DockStyle {
    always_on_bottom: bool,
    always_on_top: bool,
    toolwindow: bool,
    skip_taskbar: bool,
}

fn dock_style(docked: bool) -> DockStyle {
    if docked {
        DockStyle { always_on_bottom: true, always_on_top: false, toolwindow: true, skip_taskbar: true }
    } else {
        DockStyle { always_on_bottom: false, always_on_top: false, toolwindow: false, skip_taskbar: false }
    }
}

// 窗口 HWND（Win32 结构字段要 isize；x64 上句柄就是整数值）。
fn win_hwnd(win: &WebviewWindow) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

// WS_EX_TOOLWINDOW 会让 DWM 跳过系统圆角与投影：Win11 实测（2026-11-13，[#9]）工具窗四角是直角、
// 窗外没有阴影，切回普通窗口两样都回来。两态必须看起来是同一个窗口，所以固定在桌面时显式要
// DWMWCP_ROUND；普通窗口回落 DEFAULT（系统本来就会给它圆角）。实测工具窗 + ROUND 的像素与非工具窗
// 完全一致，说明投影也随之回来。样式改完（FRAMECHANGED）之后再落这个属性，DWM 按最终 exstyle 重算。
fn set_corner_preference(hwnd: isize, round: bool) {
    let pref: u32 = if round { DWMWCP_ROUND } else { DWMWCP_DEFAULT };
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const u32 as *const std::os::raw::c_void,
            4,
        );
    }
}

// 把 dock_style 落到窗口上。顺序有讲究，任何一步都不能随便挪：
// 1) tao 的旗子先落——tao 的 set_window_flags 只要 diff 非空，就按它内部的 WindowFlags 整份重写
//    GWL_STYLE/GWL_EXSTYLE（window_state.rs apply_diff → to_window_styles），ON_TASKBAR 时还会
//    补回 WS_EX_APPWINDOW；排在手工位之后就会把 TOOLWINDOW 抹掉。
//    清 ALWAYS_ON_BOTTOM 也必须在最前：tao 的 WM_WINDOWPOSCHANGING handler 在该 flag 存在时会把
//    每次 SetWindowPos 的 hwndInsertAfter 强制改写为 HWND_BOTTOM，不清除则普通窗口永远浮不上来。
// 2) 再落 TOOLWINDOW/APPWINDOW 这对互斥手工位（tao 不认识它们，见 set_ex_flags）。
//    紧跟一步把 DWM 圆角偏好对齐（见 set_corner_preference）：工具窗默认直角无投影，两态会不像同一个窗口。
// 3) ITaskbarList::DeleteTab/AddTab 开关任务栏按钮（TOOLWINDOW 只挡 Alt+Tab 与新建按钮）。
// 4) 固定在桌面时最后 pin_bottom：上面 FRAMECHANGED 那一下会把窗口提到最前，压底必须排在它之后。
// 不需要再靠 hide/show 让 shell 重算归属：SWP_FRAMECHANGED + ITaskbarList 已经够用，窗口不会闪。
fn apply_docked(win: &WebviewWindow, docked: bool) {
    let style = dock_style(docked);
    let hwnd = win_hwnd(win);
    let _ = win.set_always_on_bottom(style.always_on_bottom);
    let _ = win.set_always_on_top(style.always_on_top);
    if let Some(h) = hwnd {
        set_ex_flags(h, style.toolwindow);
        set_corner_preference(h, style.toolwindow);
    }
    let _ = win.set_skip_taskbar(style.skip_taskbar);
    if style.always_on_bottom {
        if let Some(h) = hwnd {
            pin_bottom(h);
        }
    }
}

fn is_docked(app: &AppHandle) -> bool {
    app.state::<Mutex<Shared>>().lock().unwrap().docked
}

// 托盘勾选态 = 当前模式。set_checked 会 run_on_main_thread + 阻塞等待，在主线程（命令/托盘回调）
// 里调用会死锁，所以统一丢给一个常驻同步线程按到达顺序执行——每次新开线程的话，两次快速切换的
// 落点顺序不保证，勾选态可能永久反着。
fn sync_tray_check(app: &AppHandle) {
    let docked = is_docked(app);
    if let Some(tx) = app.state::<TrayState>().check_tx.lock().unwrap().as_ref() {
        let _ = tx.send(docked);
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
        // 测试模式从不读 config.json（见 setup 里 testing 分支），写它只有一个后果：
        // 跑一次探针就把用户真实部署的配置改成测试文件。之前实测时就这样踩过一次。
        if s.testing {
            s.log("test mode: config.json not written");
            return;
        }
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

// 切换两态的唯一入口（命令、托盘、启动都走这里）：落状态 → 落窗口样式 → 同步托盘勾选 → 存盘。
// 注意：本函数会在主线程被调用（tauri 同步命令跑在主线程），所以内部不许有阻塞主线程的调用。
fn set_docked_state(app: &AppHandle, docked: bool) {
    {
        let st = app.state::<Mutex<Shared>>();
        let mut s = st.lock().unwrap();
        s.docked = docked;
    }
    if let Some(win) = app.get_webview_window("main") {
        // 就地落样式，不 hide/show：隐藏再显示那一下就是用户看到的整窗闪烁。
        // 任务栏与 Alt+Tab 归属由 apply_docked 里的 ITaskbarList + SWP_FRAMECHANGED 让 shell 重算。
        apply_docked(&win, docked);
    }
    sync_tray_check(app);
    let _ = app.emit("dock-changed", docked);
    write_config(app);
    app.state::<Mutex<Shared>>()
        .lock()
        .unwrap()
        .log(if docked { "docked: pinned above desktop (no taskbar)" } else { "normal: plain window (taskbar icon on)" });
}

// 托盘左键 / 「显示待办」：切回普通窗口并置前，方便直接加待办。
fn show_main_window(app: &AppHandle) {
    if is_docked(app) {
        set_docked_state(app, false);
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        TRAY_SHOW => show_main_window(app),
        TRAY_DOCK => {
            let next = !is_docked(app);
            set_docked_state(app, next);
        }
        // 与 Alt+F4 / 任务栏关闭同路径：JS 活着就交给它提交编辑再退（见 request_exit）
        TRAY_QUIT => request_exit(app),
        _ => {}
    }
}

// 「JS 还活着吗」：boot 跑完过，且最近一次心跳没超时。两个条件缺一不可——
// 白屏时 js_ready 可能还是 true，但心跳早停了，这时不能再等它。
fn js_is_alive(js_ready: bool, since_beat: Duration) -> bool {
    js_ready && since_beat < EXIT_GRACE
}

// 退出：JS 活着 → 让它提交编辑、写盘、调 exit_app；JS 死了/不答 → 直接退。
// 白屏那次「托盘里退出不了」的根因是整条退出链都挂在 JS 监听上（ADR 0008）。
fn request_exit(app: &AppHandle) {
    let js_alive = {
        let state = app.state::<Mutex<Shared>>();
        let mut s = state.lock().unwrap();
        if s.exiting {
            return;
        }
        s.exiting = true;
        let alive = js_is_alive(s.js_ready, s.last_beat.elapsed());
        s.log(&format!("exit request (js alive = {})", alive));
        alive
    };
    write_config(app);
    if js_alive {
        let _ = app.emit("app-exit-request", ());
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(EXIT_GRACE);
            force_exit(&app, "js did not answer exit request");
        });
    } else {
        force_exit(app, "webview is not answering");
    }
}

// 真正退出：先走正常路径（事件循环返回 → main 结束），再不济直接结束进程。
// 主线程若卡在某个 Win32 调用里，app.exit(0) 只会排队等不到，所以必须有后手。
fn force_exit(app: &AppHandle, why: &str) {
    write_config(app);
    app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("force exit: {}", why));
    app.exit(0);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_GRACE);
        app.state::<Mutex<Shared>>().lock().unwrap().log("force exit: event loop still alive, terminating process");
        std::process::exit(0);
    });
}

#[tauri::command]
fn set_docked(app: AppHandle, docked: bool) {
    set_docked_state(&app, docked);
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
    let hwnd = win_hwnd(&win);
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
            if let Some(ph) = win_hwnd(&p) {
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
    let _ = p.set_always_on_top(true);
    let _ = p.show();
    // TOOLWINDOW 必须在「显示之后」落：首次 ShowWindow 会按建窗时的样式重算 exstyle，
    // 显示前设的 TOOLWINDOW 会被抹掉（实测，ADR 0004）。
    if let Some(h) = win_hwnd(&p) {
        set_ex_flags(h, true);
    }
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

/* ＋ 新建待办文件：原生「另存为」挑位置，只有路径不存在时才写入示例内容。
   指到已存在的文件一律不覆盖——那多半是用户想打开它，交给 JS 按"打开已有文件"处理。
   Rust 侧顺手把 Shared.file 换到新路径，随后的 save_config 才会把它落进 config.json
   （与 choose_file 同一套语义）。
   父目录不存在时一并 create_dir_all：write_md_file 只做 tmp + rename，自己不会建目录。 */
#[derive(Serialize)]
struct NewFileOut {
    path: String,
    created: bool,
}

#[tauri::command]
async fn new_md_file(app: AppHandle, content: String) -> Result<Option<NewFileOut>, String> {
    let (cur, exe_dir) = {
        let s = app.state::<Mutex<Shared>>();
        let s = s.lock().unwrap();
        (s.file.clone(), s.exe_dir.clone())
    };
    // 默认目录 = 当前配置文件所在目录（用户上次选的地方）；文件还没落盘时退回 exe 目录。
    let dir = if cur.exists() {
        cur.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| exe_dir.clone())
    } else {
        exe_dir
    };
    let picked = rfd::FileDialog::new()
        .set_title("新建待办 Markdown 文件")
        .set_directory(&dir)
        .set_file_name("待办.md")
        .add_filter("Markdown 文件", &["md"])
        .save_file();
    let Some(p) = picked else { return Ok(None) };
    let created = !p.exists();
    if created {
        if let Some(parent) = p.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
            }
        }
        write_md_file(&p, &content, false)?;
    }
    app.state::<Mutex<Shared>>().lock().unwrap().file = p.clone();
    Ok(Some(NewFileOut { path: p.to_string_lossy().into_owned(), created }))
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

// 每秒一次的心跳：看门狗据此判断界面还活着（ADR 0008）。
// JS 在模块顶层就开定时器，只要脚本执行到就发——boot 卡在半路也还有心跳，不会被误 reload。
#[tauri::command]
fn heartbeat(app: AppHandle, ready: Option<bool>) {
    let state = app.state::<Mutex<Shared>>();
    let mut s = state.lock().unwrap();
    s.last_beat = Instant::now();
    if ready == Some(true) && !s.js_ready {
        s.js_ready = true;
        s.shown_at = Instant::now();
        let _ = std::fs::remove_file(&s.restart_marker);
        s.log("ui ready (boot finished)");
    }
}

// JS 先提交编辑、写盘，再调这里：保存 config 后整体退出（对齐 todo.pyw on_close 收尾）
#[tauri::command]
fn exit_app(app: AppHandle) {
    write_config(&app);
    app.state::<Mutex<Shared>>().lock().unwrap().log("exit");
    app.exit(0);
}

// 看门狗这一秒要做什么（锁内决定，锁外执行）
enum WatchdogAction {
    Reload(u32),
    GiveUp { restart: bool },
}

// 判定本身不带状态，单独拆出来测（ADR 0008 的核心策略）。
enum WatchdogStep {
    Idle,
    Reload,
    GiveUp { restart: bool },
}

// silent 超限才动手；reload 次数没到上限就再试一次；到顶了：
// 允许重启就重启（只允许一次，重启后还白屏说明环境本身坏了），否则彻底撒手——
// 撒手不影响退出，退出有 request_exit 兜底。
fn watchdog_step(silent: Duration, limit: Duration, reloads: u32, gave_up: bool, can_restart: bool) -> WatchdogStep {
    if silent <= limit {
        return WatchdogStep::Idle;
    }
    if reloads >= WATCHDOG_MAX_RELOADS {
        if gave_up {
            return WatchdogStep::Idle;
        }
        return WatchdogStep::GiveUp { restart: can_restart };
    }
    WatchdogStep::Reload
}

// 界面存活看门狗（ADR 0008）：每秒看一眼「页面是否加载过 / JS 心跳还在不在」。
// 先 reload 自救，救不回来（实测：WebView2 浏览器进程被杀后 reload 返回成功但页面永不回来）
// 就重启自己一把——那正是用户「双击重开」要做的事，而老版本连退都退不掉，重开无从谈起。
fn spawn_watchdog(app: AppHandle, win: WebviewWindow) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        let action = {
            let state = app.state::<Mutex<Shared>>();
            let mut s = state.lock().unwrap();
            if s.exiting {
                continue;
            }
            // 没加载完 / JS 没起来：从 show（或 boot 成功）算起；起来了：只看心跳间隔
            let (silent, limit) = if s.js_ready {
                (s.last_beat.elapsed(), WATCHDOG_BEAT_LIMIT)
            } else {
                (s.shown_at.elapsed(), WATCHDOG_LOAD_LIMIT)
            };
            match watchdog_step(silent, limit, s.reloads, s.gave_up, s.can_restart) {
                WatchdogStep::Idle => continue,
                WatchdogStep::GiveUp { restart } => {
                    s.gave_up = true;
                    s.log(&format!(
                        "watchdog: ui silent {}s, {} reloads did not help",
                        silent.as_secs(),
                        s.reloads
                    ));
                    WatchdogAction::GiveUp { restart }
                }
                WatchdogStep::Reload => {
                    s.reloads += 1;
                    let n = s.reloads;
                    let loaded = s.page_loaded;
                    s.page_loaded = false;
                    s.js_ready = false;
                    s.shown_at = Instant::now();
                    s.last_beat = Instant::now();
                    s.log(&format!(
                        "watchdog: ui silent {}s (page loaded = {}) -> reload #{}",
                        silent.as_secs(),
                        loaded,
                        n
                    ));
                    WatchdogAction::Reload(n)
                }
            }
        };
        match action {
            WatchdogAction::Reload(n) => {
                if let Err(e) = win.reload() {
                    app.state::<Mutex<Shared>>()
                        .lock()
                        .unwrap()
                        .log(&format!("watchdog: reload #{} failed: {}", n, e));
                }
            }
            WatchdogAction::GiveUp { restart: true } => {
                restart_self(&app);
                force_exit(&app, "ui unreachable after reloads, restarted a fresh instance");
                return;
            }
            // 已经自动重启过一次还是白屏 = 环境本身有问题（运行时损坏、udf 坏）。
            // 不再连环重启，退出仍然可用，留给用户自己决定重开还是修环境。
            WatchdogAction::GiveUp { restart: false } => return,
        }
    });
}

// 拉起一个新实例：新实例带 --wait-mutex，自己等老进程放出单实例锁再接管。
// CREATE_NO_WINDOW + DETACHED_PROCESS：不闪黑框，也不随本进程一起死。
fn restart_self(app: &AppHandle) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            app.state::<Mutex<Shared>>()
                .lock()
                .unwrap()
                .log(&format!("restart: cannot resolve exe path: {}", e));
            return;
        }
    };
    {
        let state = app.state::<Mutex<Shared>>();
        let s = state.lock().unwrap();
        // 重启标记：新实例启动时看到它就只再试一次自救、不再连环重启（见 can_restart）
        let _ = std::fs::write(&s.restart_marker, "1");
        s.log(&format!("restart: spawning {}", exe.display()));
    }
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    // 直接拉新实例并带上 --wait-mutex：它自己等老进程放出单实例锁再接管。
    // （不要绕 cmd.exe /C + start：Rust 给 cmd 加引号的规则和 cmd 自己的解析撞车，
    //   实测那样一条命令根本没被解析成 start，静默失败。）
    if let Err(e) = std::process::Command::new(&exe)
        .arg(RESTART_ARG)
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
    {
        app.state::<Mutex<Shared>>()
            .lock()
            .unwrap()
            .log(&format!("restart: spawn failed: {}", e));
    }
}

// ---------------- 启动 ----------------
fn main() {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let app_dir = exe_dir.clone().unwrap_or_else(|| PathBuf::from("."));

    // argv：[1]=md 路径 → 测试运行；[2]="float" 或 "x,y"（物理像素）
    // （对齐 todo.pyw：argv[2]=="float" 悬浮置顶测试；"x,y" 指定桌面位置）
    // --wait-mutex 是本程序自动重启时给自己的参数，不算用户传入，先滤掉。
    let args: Vec<String> = std::env::args().skip(1).filter(|a| a != RESTART_ARG).collect();
    let wait_for_mutex = std::env::args().any(|a| a == RESTART_ARG);
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
    // 默认普通窗口（ADR 0004）：「普通窗口 → 固定在桌面」是用户唯一主动动作；
    // 老 config 里写着 docked=true 的继续固定在桌面，不迁移。
    let initial_dock = if testing { want_dock } else { cfg.docked.unwrap_or(false) };

    // 日志常开（ADR 0008）：白屏那次一点痕迹都没留下，事后只能靠猜。
    // 测试运行写 md 旁边（与原行为一致），正式运行写 exe 旁 widget.log。
    let log_path = Some(if testing {
        file.parent().unwrap_or(&app_dir).join("widget.log")
    } else {
        app_dir.join("widget.log")
    });
    // 长跑日志封顶：启动时超过 200KB 就清空，只留本次运行
    if let Some(p) = &log_path {
        if std::fs::metadata(p).map(|m| m.len() > 200_000).unwrap_or(false) {
            let _ = std::fs::write(p, "");
        }
    }

    // 单实例保护：独占文件锁（share=0），不是命名互斥体。
    // 2026-11-13 实测：WebView2 启动浏览器进程时开了句柄继承，孤儿 msedgewebview2 子进程会
    // 把命名互斥体一起继承着，老进程退出后名字对象仍然活着 —— 自动重启的新实例要等 8 秒、
    // 然后静默自杀。文件句柄不可继承，进程一退内核就放锁，子进程继承不到。
    // 句柄故意不关闭：整个进程生命周期都要持有它（进程退出时内核自动释放）。
    // 自动重启拉起的新实例带 --wait-mutex：老进程要退几百毫秒才放锁，它最多等 8 秒。
    let lock_path = wide(&app_dir.join("widget.lock").to_string_lossy());
    {
        let mut tries = if wait_for_mutex { 80 } else { 1 };   // 80 × 100ms
        loop {
            let handle = unsafe {
                CreateFileW(
                    lock_path.as_ptr(),
                    0x4000_0000,   // GENERIC_WRITE
                    0,             // share = 0：独占
                    std::ptr::null(),
                    4,             // OPEN_ALWAYS：没有就建
                    0x80,          // FILE_ATTRIBUTE_NORMAL
                    0,
                )
            };
            if handle != -1 {
                break;   // 拿到锁
            }
            tries -= 1;
            if tries == 0 {
                std::process::exit(0);   // 已有实例在跑
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    let boot = Instant::now();
    // 上一轮自动重启留下的标记：还在说明「重启后仍然白屏」，这次不再连环重启
    let restart_marker = app_dir.join("widget.restart");
    let can_restart = !restart_marker.exists();
    let managed = Mutex::new(Shared {
        exe_dir: app_dir.clone(),
        file,
        testing,
        docked: initial_dock,
        ro_warned: false,
        dirty_config: false,
        log_path,
        shown_at: boot,
        page_loaded: false,
        last_beat: boot,
        js_ready: false,
        reloads: 0,
        exiting: false,
        gave_up: false,
        can_restart,
        restart_marker,
    });

    tauri::Builder::default()
        .manage(managed)
        .invoke_handler(tauri::generate_handler![
            app_info, read_md, write_md, file_state, save_config, set_docked,
            resize_start, poll_tick,
            panel_open, panel_close, choose_file, new_md_file, open_file_location,
            log_line, heartbeat, exit_app
        ])
        // 页面加载完成 = 白屏自救的第二个信号源（心跳之外的硬证据，ADR 0008）
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                let app = webview.app_handle();
                let state = app.state::<Mutex<Shared>>();
                let mut s = state.lock().unwrap();
                s.page_loaded = true;
                s.last_beat = Instant::now();
                s.shown_at = Instant::now();
                // 页面真的回来了：清掉重启标记，下次白屏还能自救
                let _ = std::fs::remove_file(&s.restart_marker);
                s.log("page load finished");
            }
        })
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
                // 最小内宽 300：顶栏现在是 6 个 30px 按钮 + 9px 分组竖线（约 205px 固定），
                // 260 会把标题挤到只剩十几像素；高度沿用 180。
                .min_inner_size(300.0, 180.0)
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
            // build 失败 = WebView2 环境建不起来（udf 被占用 / 运行时损坏）。以前这里 `?`
            // 让 setup 返回 Err → tauri panic，进程悄悄死掉，用户看到的是「双击没反应」。
            // 改成把原因写进日志并弹框说明（ADR 0008）。
            let win = match win.additional_browser_args(BROWSER_ARGS).build() {
                Ok(w) => w,
                Err(e) => {
                    app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("webview build failed: {}", e));
                    show_message_box(
                        "error",
                        &format!("界面起不来（WebView2 运行时可能被占用或损坏）：\n{}\n\n请先确认没有正在运行的实例，或重启电脑后再试。", e),
                    );
                    std::process::exit(1);
                }
            };
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
                // 下限与 min_inner_size 保持一致（恢复旧 config 里更窄的尺寸时也得撑到 300）
                let w = w.max((300.0 * s) as i32);
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

            // 初始两态（ADR 0004）：先把样式落好再显示，任务栏按钮才按对的模式出现
            app.manage(TrayState { check_tx: Mutex::new(None) });
            apply_docked(&win, initial_dock);
            let hwnd = win_hwnd(&win).unwrap_or(-1);
            let mode = if initial_dock { "desktop mode" } else { "normal window" };
            app.state::<Mutex<Shared>>().lock().unwrap().log(&format!("{}: hwnd={}", mode, hwnd));
            win.show()?;
            app.state::<Mutex<Shared>>().lock().unwrap().shown_at = Instant::now();
            // 首次 ShowWindow 会按建窗时的样式重算 exstyle，显示前落的 TOOLWINDOW/APPWINDOW 会被抹掉
            // （实测：显示前设的被覆盖，显示后设的稳定），所以显示后必须再落一次。
            apply_docked(&win, initial_dock);

            // 托盘：两种模式下都在。固定在桌面时任务栏没有图标，托盘就是唤回主窗口的入口。
            let show_item = MenuItem::with_id(app, TRAY_SHOW, "显示待办", true, None::<&str>)?;
            let dock_item = CheckMenuItem::with_id(app, TRAY_DOCK, "固定在桌面", true, initial_dock, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, TRAY_QUIT, "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &dock_item, &sep, &quit_item])?;
            // 勾选态同步：先登记通道再建图标（建完立刻可能被按钮/命令触发 sync_tray_check），
            // 由常驻线程按顺序取最新值落 set_checked——它阻塞，不能碰主线程。
            let (check_tx, check_rx) = std::sync::mpsc::channel::<bool>();
            *app.state::<TrayState>().check_tx.lock().unwrap() = Some(check_tx);
            {
                let item = dock_item.clone();
                std::thread::spawn(move || {
                    while let Ok(first) = check_rx.recv() {
                        let mut latest = first;
                        while let Ok(next) = check_rx.try_recv() {
                            latest = next;
                        }
                        let _ = item.set_checked(latest);
                    }
                });
            }
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip(APP_NAME)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    // 菜单回调在主线程；set_checked 之类会阻塞主线程，处理一律丢到独立线程
                    let app = app.clone();
                    let id = event.id().as_ref().to_owned();
                    std::thread::spawn(move || on_tray_menu(&app, &id));
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle().clone();
                        std::thread::spawn(move || show_main_window(&app));
                    }
                });
            // 托盘位图 = exe 内嵌的应用图标（tauri 在 Windows 上从图标资源解码，免开 image-png）
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            } else {
                app.state::<Mutex<Shared>>().lock().unwrap().log("tray: no embedded app icon resource");
            }
            tray.build(app)?;

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
            let panel = panel.additional_browser_args(BROWSER_ARGS).build();
            // 面板只是详情窗：它起不来不该拖垮主窗（白屏自救同理，ADR 0008）
            match panel {
                Ok(panel) => {
                    panel.hide()?;
                    if let Some(h) = win_hwnd(&panel) {
                        set_ex_flags(h, true);
                    }
                    let _ = panel.set_always_on_top(true);
                }
                Err(e) => app
                    .state::<Mutex<Shared>>()
                    .lock()
                    .unwrap()
                    .log(&format!("panel build failed: {}（详情面板不可用，主窗照常）", e)),
            }

            // 看门狗最后起：此时窗口已 show、页面开始加载，计时才有意义
            spawn_watchdog(app.handle().clone(), win.clone());

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
                    // 任务栏右键关闭 / Alt+F4：JS 活着就交给它走 on_close 语义（提交编辑→保存→退出），
                    // JS 死了就直接退——退出这件事不能整个挂在 webview 上（ADR 0008）
                    api.prevent_close();
                    request_exit(app);
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

#[cfg(test)]
mod dock_style_tests {
    use super::*;

    #[test]
    fn docked_mode_pins_above_desktop_without_taskbar() {
        let s = dock_style(true);
        assert!(s.always_on_bottom, "固定在桌面 = 压到桌面图标之上");
        assert!(s.toolwindow, "固定在桌面时要从任务栏和 Alt+Tab 里消失（APPWINDOW 由 set_ex_flags 一起清）");
        assert!(s.skip_taskbar);
    }

    #[test]
    fn normal_mode_is_a_plain_window() {
        let s = dock_style(false);
        assert!(!s.always_on_bottom);
        assert!(!s.toolwindow, "普通窗口要进任务栏和 Alt+Tab（并恢复 APPWINDOW）");
        assert!(!s.skip_taskbar);
    }

    #[test]
    fn topmost_is_never_used() {
        // 用户 2026-11-13 定稿：置顶功能整体下线，两种模式都不许 topmost
        assert!(!dock_style(true).always_on_top);
        assert!(!dock_style(false).always_on_top);
    }

    // ADR 0008：2026-11-13 白屏事故。「托盘退出不了」的根因是退出链全挂在 JS 上，
    // 而白屏时 JS 已经死了 —— 所以判定必须能识破「曾经就绪、现在没心跳」。
    #[test]
    fn js_counts_as_alive_only_when_booted_and_beating() {
        assert!(js_is_alive(true, Duration::from_millis(500)), "boot 完成 + 心跳新鲜 = 可以等它提交编辑");
        assert!(!js_is_alive(true, Duration::from_secs(60)), "心跳停了（白屏）不能再等，必须直接退");
        assert!(!js_is_alive(false, Duration::from_millis(500)), "boot 没跑完就没有退出监听，等也没用");
        assert!(!js_is_alive(false, Duration::from_secs(60)));
    }

    #[test]
    fn exit_grace_is_short_enough_to_still_feel_like_quitting() {
        // 等 JS 再兜底的总时长必须明显短于「用户以为点了没反应」的耐心阈值
        assert!(EXIT_GRACE <= Duration::from_secs(3), "兜底等待超过 3 秒就会被当成卡死");
        assert!(EXIT_GRACE >= Duration::from_millis(500), "太快则正常的写盘 + 退出流程会被腰斩");
    }

    // 白屏自救的判定表：事件里最贵的是「每 20 秒才动一次手」和「无限重启」，两条都要钉住。
    #[test]
    fn watchdog_reloads_before_giving_up() {
        let limit = Duration::from_secs(20);
        assert!(matches!(watchdog_step(Duration::from_secs(5), limit, 0, false, true), WatchdogStep::Idle));
        assert!(matches!(
            watchdog_step(Duration::from_secs(21), limit, 0, false, true),
            WatchdogStep::Reload
        ));
        // reload 用满上限 → 该重启了（这正是 2026-11-13 现场：浏览器进程死了，reload 救不回来）
        assert!(matches!(
            watchdog_step(Duration::from_secs(21), limit, WATCHDOG_MAX_RELOADS, false, true),
            WatchdogStep::GiveUp { restart: true }
        ));
        // 重启过一次还是白屏 → 不再连环重启
        assert!(matches!(
            watchdog_step(Duration::from_secs(21), limit, WATCHDOG_MAX_RELOADS, false, false),
            WatchdogStep::GiveUp { restart: false }
        ));
        // 已经撒手就不再重复记录
        assert!(matches!(
            watchdog_step(Duration::from_secs(999), limit, WATCHDOG_MAX_RELOADS, true, true),
            WatchdogStep::Idle
        ));
    }
}
