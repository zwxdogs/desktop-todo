//! 主窗口两态（ADR 0004）与贴桌面：本程序唯一知道「贴着桌面该长什么样」的地方。
//!
//! 固定在桌面：桌面图标之上、所有应用窗口之下，任务栏与 Alt+Tab 里都没有它。
//! 普通窗口：正常 z 序，任务栏有图标、Alt+Tab 里有它。两种模式都不用 topmost（置顶功能已下线）。
//!
//! 顺序即实现（#17）：贴桌面要按「tao 旗子 → 互斥 exstyle → DWM 圆角 → 任务栏按钮 → 压底」走，
//! 且首次显示前落一遍、显示后再落一遍。这套顺序从前由调用方记住，启动时因此连调两次；
//! 现在只由 `pin_to_desktop` / `apply` 拥有，调用方只说「进入固定在桌面」「切到普通窗口」
//! 或「重新压回桌面层」。

use std::sync::Mutex;
use tauri::{Emitter, WebviewWindow};

use crate::persist;
use crate::state::Host;
use crate::tray;
use crate::win32;

/// 「当前是哪一态」的唯一存放处。
#[derive(Default)]
pub struct Mode {
    docked: Mutex<bool>,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct DockStyle {
    always_on_bottom: bool,
    always_on_top: bool,
    toolwindow: bool,
    skip_taskbar: bool,
}

/// 两态映射成窗口样式。纯函数：这里是「贴着桌面 = 哪几个位」的唯一定义。
pub fn dock_style(docked: bool) -> DockStyle {
    if docked {
        DockStyle { always_on_bottom: true, always_on_top: false, toolwindow: true, skip_taskbar: true }
    } else {
        DockStyle { always_on_bottom: false, always_on_top: false, toolwindow: false, skip_taskbar: false }
    }
}

pub fn is_docked(host: &Host) -> bool {
    *host.state::<Mode>().docked.lock().unwrap()
}

fn set_mode(host: &Host, docked: bool) {
    *host.state::<Mode>().docked.lock().unwrap() = docked;
}

/// 把 dock_style 落到窗口上。顺序有讲究，任何一步都不能随便挪：
/// 1) tao 的旗子先落——tao 的 set_window_flags 只要 diff 非空，就按它内部的 WindowFlags 整份重写
///    GWL_STYLE/GWL_EXSTYLE（window_state.rs apply_diff → to_window_styles），ON_TASKBAR 时还会
///    补回 WS_EX_APPWINDOW；排在手工位之后就会把 TOOLWINDOW 抹掉。
///    清 ALWAYS_ON_BOTTOM 也必须在最前：tao 的 WM_WINDOWPOSCHANGING handler 在该 flag 存在时会把
///    每次 SetWindowPos 的 hwndInsertAfter 强制改写为 HWND_BOTTOM，不清除则普通窗口永远浮不上来。
/// 2) 再落 TOOLWINDOW/APPWINDOW 这对互斥手工位（tao 不认识它们），紧跟一步把 DWM 圆角偏好对齐：
///    工具窗默认直角无投影，两态会不像同一个窗口。
/// 3) set_skip_taskbar 开关任务栏按钮（TOOLWINDOW 只挡 Alt+Tab 与新建按钮）。
/// 4) 固定在桌面时最后压底：上面 FRAMECHANGED 那一下会把窗口提到最前，压底必须排在它之后。
fn apply(win: &WebviewWindow, docked: bool) {
    let style = dock_style(docked);
    let hwnd = win32::hwnd(win);
    let _ = win.set_always_on_bottom(style.always_on_bottom);
    let _ = win.set_always_on_top(style.always_on_top);
    if let Some(h) = hwnd {
        win32::set_toolwindow(h, style.toolwindow);
        win32::set_rounded_corners(h, style.toolwindow);
    }
    let _ = win.set_skip_taskbar(style.skip_taskbar);
    if style.always_on_bottom {
        if let Some(h) = hwnd {
            win32::pin_bottom(h);
        }
    }
}

/// 重新压回桌面层：Win+D、失焦、以及系统重排 z 序之后。
/// `always_on_bottom` 是 tao 的旗子，`pin_bottom` 是 Win32 的手工位，两个都要落。
fn pin_bottom_again(win: &WebviewWindow) {
    let _ = win.set_always_on_bottom(true);
    if let Some(h) = win32::hwnd(win) {
        win32::pin_bottom(h);
    }
}

/// 主窗重新压回桌面层（失焦、Win+D 两条路径共用）。窗口不在时静默。
pub fn pin_to_desktop(host: &Host) {
    if let Some(win) = host.window("main") {
        pin_bottom_again(&win);
    }
}

/// 启动时进入模式：一次调用把「初始两态」落定。**贴桌面只此一个入口**，启动不再连调两次。
///
/// 首次 ShowWindow 会按建窗时的样式重算 exstyle，显示前落的 TOOLWINDOW/APPWINDOW 会被抹掉
/// （实测：显示前设的被覆盖，显示后设的稳定），所以这里的两次 `apply` 不是冗余——中间那次 `show`
/// 必须夹在中间。调用方不必知道这件事，这正是接缝要藏起来的东西。
pub fn enter(host: &Host, win: &WebviewWindow, docked: bool) -> tauri::Result<()> {
    set_mode(host, docked);
    apply(win, docked);
    win.show()?;
    crate::watchdog::mark_shown(host);
    apply(win, docked);
    host.log(&format!(
        "{}: hwnd={}",
        if docked { "desktop mode" } else { "normal window" },
        win32::hwnd(win).unwrap_or(-1)
    ));
    Ok(())
}

/// 切两态的唯一入口（命令、托盘都走这里）：落状态 → 落窗口样式 → 同步托盘勾选 →
/// 通知前端 → 存盘 → 记日志。
///
/// 本函数会在主线程被调用（tauri 同步命令跑在主线程），所以内部不许有阻塞主线程的调用。
pub fn switch(host: &Host, docked: bool) {
    set_mode(host, docked);
    // 就地落样式，不 hide/show：隐藏再显示那一下就是用户看到的整窗闪烁。
    if let Some(win) = host.window("main") {
        apply(&win, docked);
    }
    tray::sync_check(host);
    let _ = host.app().emit("dock-changed", docked);
    persist::save(host);
    host.log(if docked {
        "docked: pinned above desktop (no taskbar)"
    } else {
        "normal: plain window (taskbar icon on)"
    });
}

#[cfg(test)]
mod dock_style_tests {
    use super::*;

    #[test]
    fn docked_mode_pins_above_desktop_without_taskbar() {
        let s = dock_style(true);
        assert!(s.always_on_bottom, "固定在桌面 = 压到桌面图标之上");
        assert!(s.toolwindow, "固定在桌面时要从任务栏和 Alt+Tab 里消失（APPWINDOW 由 set_toolwindow 一起清）");
        assert!(s.skip_taskbar);
    }

    #[test]
    fn normal_mode_is_a_plain_window() {
        let s = dock_style(false);
        assert!(!s.always_on_bottom);
        assert!(!s.toolwindow, "普通窗口要进任务栏和 Alt+Tab（并恢复 APPWINDOW）");
        assert!(!s.skip_taskbar);
        // 纯函数不碰窗口，只定义「贴着桌面 = 哪几个位」；置顶位两态都必须是 false
        assert!(!s.always_on_top);
    }

    #[test]
    fn topmost_is_never_used() {
        // 用户 2026-11-13 定稿：置顶功能整体下线，两种模式都不许 topmost
        assert!(!dock_style(true).always_on_top);
        assert!(!dock_style(false).always_on_top);
    }
}
