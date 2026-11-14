//! Win32 FFI 与窗口句柄：全程序唯一出现 `unsafe extern` 的地方，也是唯一把 tauri 窗口
//! 换算成 HWND / client 几何的地方。
//!
//! 上层（dock / layout / panel / maintenance）只调这里语义化的窄接口，不再各自声明 FFI、
//! 也不再各自记常量与调用顺序。

use crate::geometry::Rect;
use std::path::Path;
use std::time::Duration;

// SetWindowPos 的 hwndInsertAfter
const HWND_BOTTOM: isize = 1;
// GetWindow 的方向：z 序里的前一个窗口
const GW_HWNDPREV: u32 = 3;
// GetWindowLongW / SetWindowLongW 的 index
const GWL_EXSTYLE: i32 = -20;
// 扩展样式位：TOOLWINDOW / APPWINDOW 是一对互斥语义，TOPMOST 只读来看面板有没有被系统剥掉
const WS_EX_TOOLWINDOW: i64 = 0x0000_0080;
const WS_EX_APPWINDOW: i64 = 0x0004_0000;
const WS_EX_TOPMOST: i64 = 0x0000_0008;
// SetWindowPos flags
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;
// DWM 圆角偏好（Win11）：工具窗默认不圆、也没有投影，必须显式要 ROUND 才和普通窗口一致。
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWCP_DEFAULT: u32 = 0;
const DWMWCP_ROUND: u32 = 2;
// GetSystemMetrics
const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;
const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;
// 单实例锁：CreateFileW 的参数
const GENERIC_WRITE: u32 = 0x4000_0000;
const OPEN_ALWAYS: u32 = 4;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;

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

/// 宽字符 + 结尾 NUL（所有 Win32 字符串参数都要这个形式）。
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 日志时间戳：本地时区的 HH:MM:SS。
pub fn now_hms() -> String {
    let mut st =
        SYSTEMTIME { year: 0, month: 0, day_of_week: 0, day: 0, hour: 0, minute: 0, second: 0, milliseconds: 0 };
    unsafe { GetLocalTime(&mut st) };
    format!("{:02}:{:02}:{:02}", st.hour, st.minute, st.second)
}

/// 桌面窗口（Progman）。0 = 没找到。
pub fn progman() -> isize {
    let cls = wide("Progman");
    unsafe { FindWindowW(cls.as_ptr(), std::ptr::null()) }
}

/// 把窗口压到最底，再把 Progman 压回垫底：最终 Progman 最底、我们紧贴其上。
///
/// 注意第二参必须是 HWND_BOTTOM——传 hwnd 会把桌面放到我们之上，点击全穿到桌面。
pub fn pin_bottom(hwnd: isize) {
    unsafe {
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        let pm = progman();
        if pm != 0 {
            SetWindowPos(pm, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// 窗口是否紧贴在 Progman 之上（= 还在桌面层，没被别的窗口顶开）。
pub fn at_desktop_level(hwnd: isize) -> bool {
    let pm = progman();
    pm != 0 && unsafe { GetWindow(pm, GW_HWNDPREV) } == hwnd
}

/// WS_EX_TOOLWINDOW / WS_EX_APPWINDOW 一对互斥位一起落。
///
/// 两个必须同时处理：创建时 tao 给了 WS_EX_APPWINDOW，两者并存时它会盖过 TOOLWINDOW 把任务栏按钮撑回来。
/// 样式改动后必须 SetWindowPos(SWP_FRAMECHANGED) 才会被 shell 采纳。
pub fn set_toolwindow(hwnd: isize, toolwindow: bool) {
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

/// DWM 圆角偏好：工具窗默认直角无投影，Win11 上两态会不像同一个窗口。
/// 样式改完（FRAMECHANGED）之后再落这个属性，DWM 按最终 exstyle 重算。
pub fn set_rounded_corners(hwnd: isize, round: bool) {
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

/// 当前前台窗口。
pub fn foreground() -> isize {
    unsafe { GetForegroundWindow() }
}

/// 窗口是否被最小化（Win+D / 全部最小化也会把本窗口带上）。
pub fn is_iconic(hwnd: isize) -> bool {
    unsafe { IsIconic(hwnd) != 0 }
}

/// 窗口上是否还挂着 WS_EX_TOPMOST（系统会在某些场合悄悄剥掉）。
pub fn has_topmost(hwnd: isize) -> bool {
    unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST != 0 }
}

/// 主显示器尺寸（Win32 的物理值）。
pub fn primary_screen() -> Rect {
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    Rect::new(0, 0, w, h)
}

/// 整个虚拟桌面（多显示器合起来的外接矩形）；拿不到时退回主显示器。
pub fn virtual_screen() -> Rect {
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if vw <= 0 || vh <= 0 {
        return primary_screen();
    }
    Rect::new(vx, vy, vw, vh)
}

/// 单实例保护：独占文件锁（share=0），不是命名互斥体。
///
/// 2026-11-13 实测：WebView2 启动浏览器进程时开了句柄继承，孤儿 msedgewebview2 子进程会把
/// 命名互斥体一起继承着，老进程退出后名字对象仍然活着 —— 自动重启的新实例要等 8 秒、然后静默自杀。
/// 文件句柄不可继承，进程一退内核就放锁，子进程继承不到。句柄故意不关闭：整个进程生命周期都要持有它。
///
/// 返回 false = 已有实例在跑（tries 次、每次间隔 100ms 都没拿到）。
pub fn lock_instance(path: &Path, tries: u32) -> bool {
    let name = wide(&path.to_string_lossy());
    for _ in 0..tries {
        let handle = unsafe {
            CreateFileW(name.as_ptr(), GENERIC_WRITE, 0, std::ptr::null(), OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0)
        };
        if handle != -1 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

// ---------------- 窗口句柄与 client 几何 ----------------
// 窗口 HWND（Win32 结构字段要 isize；x64 上句柄就是整数值）。
// `tauri::Window` 与 `tauri::WebviewWindow` 是两条独立类型（on_window_event 给的是前者），
// 各自取一次，别再让调用方自己 `.hwnd().0 as isize`。

pub fn hwnd(win: &tauri::WebviewWindow) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

pub fn window_hwnd(win: &tauri::Window) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

/// 主窗当前的 client 矩形（inner 语义 = Tk 的 winfo；无框窗口的 outer 含隐形边，不能拿来记账）。
pub fn client_rect(win: &tauri::WebviewWindow) -> Option<Rect> {
    let pos = win.inner_position().ok()?;
    let size = win.inner_size().ok()?;
    Some(Rect::new(pos.x, pos.y, size.width as i32, size.height as i32))
}

/// 按 **client 原点**把窗口放到 (x, y)。
///
/// tao 的 `set_position` 是 outer 语义，而这里记账、夹取、config 存的全是 client 坐标（Tk winfo 语义）。
/// 无框可缩放窗口带隐形 WS_THICKFRAME 边（本机实测 outer 比 client 大 26×15 物理像素），直接按 client
/// 值设会每轮向右下漂移：设置后读回 inner 原点求一次偏差并补偿，二次调用即收敛。
///
/// 启动定位与离屏救援共用这一处：少了它，被夹回边界的窗口每秒都会再被判成「出界」并挪一点点。
pub fn set_client_position(win: &tauri::WebviewWindow, x: i32, y: i32) -> tauri::Result<()> {
    win.set_position(tauri::PhysicalPosition::new(x, y))?;
    if let Ok(ip) = win.inner_position() {
        let (dx, dy) = (x - ip.x, y - ip.y);
        if dx != 0 || dy != 0 {
            win.set_position(tauri::PhysicalPosition::new(x + dx, y + dy))?;
        }
    }
    Ok(())
}

/// 起一个自身的新实例（看门狗重启用）：`CREATE_NO_WINDOW | DETACHED_PROCESS`
/// 不闪黑框，也不随本进程一起死；带上 `--wait-mutex` 让它自己等老进程放出单实例锁再接管。
pub fn spawn_detached_self(restart_arg: &str) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let exe = std::env::current_exe()?;
    // 直接拉新实例，不绕 cmd.exe /C + start：Rust 给 cmd 加引号的规则和 cmd 自己的解析撞车，
    // 实测那样一条命令根本没被解析成 start，静默失败。
    std::process::Command::new(exe).arg(restart_arg).creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS).spawn()
}
