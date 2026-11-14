//! 详情面板窗口：开、关、置顶自愈。
//!
//! 面板只是详情窗：它起不来不该拖垮主窗（白屏自救同理，ADR 0008）。所以建窗失败只记日志，
//! 主窗照常。

use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::consts::BROWSER_ARGS;
use crate::geometry;
use crate::state::Host;
use crate::win32;

/// 面板的逻辑尺寸，缩放后再乘。
const PANEL_W: f64 = 420.0;
const PANEL_H: f64 = 520.0;
const PANEL_GAP: f64 = 12.0;

/// 建面板窗（隐藏待用，不进任务栏/Alt+Tab），顺手把 TOOLWINDOW 位落好。
/// udf 目录与主窗共用（绿色便携语义）。
pub fn build(host: &Host, udf: Option<std::path::PathBuf>) {
    let builder = WebviewWindowBuilder::new(host.app(), "panel", WebviewUrl::App("panel.html".into()))
        .title(crate::consts::APP_NAME)
        .inner_size(PANEL_W, PANEL_H)
        .decorations(false)
        .resizable(false)
        .visible(false)
        .skip_taskbar(true)
        .focused(false);
    let builder = if let Some(d) = udf { builder.data_directory(d) } else { builder };
    match builder.additional_browser_args(BROWSER_ARGS).build() {
        Ok(panel) => {
            let _ = panel.hide();
            if let Some(h) = win32::hwnd(&panel) {
                win32::set_toolwindow(h, true);
            }
            let _ = panel.set_always_on_top(true);
        }
        Err(e) => host.log(&format!("panel build failed: {}（详情面板不可用，主窗照常）", e)),
    }
}

/// 打开面板：落在主窗旁边，置顶、显示、拿焦点。
pub fn open(host: &Host, win: &tauri::WebviewWindow) {
    let Some(p) = host.window("panel") else { return };
    let Ok(sf) = win.scale_factor() else { return };
    let s = sf.max(1.0);
    let panel = ((PANEL_W * s) as i32, (PANEL_H * s) as i32);
    let gap = (PANEL_GAP * s) as i32;
    // Tk panel_pos 用 winfo_rootx/rooty/width（client 语义）
    let Some(main) = win32::client_rect(win) else { return };
    let (px, py) = geometry::panel_pos(main, panel, gap, win32::virtual_screen());
    let _ = p.set_position(PhysicalPosition::new(px, py));
    let _ = p.set_size(PhysicalSize::new(panel.0 as u32, panel.1 as u32));
    let _ = p.set_always_on_top(true);
    let _ = p.show();
    // TOOLWINDOW 必须在「显示之后」落：首次 ShowWindow 会按建窗时的样式重算 exstyle，
    // 显示前设的 TOOLWINDOW 会被抹掉（实测，ADR 0004）。
    if let Some(h) = win32::hwnd(&p) {
        win32::set_toolwindow(h, true);
    }
    let _ = p.set_focus();
    host.log("panel open");
}

/// 关闭面板（隐藏，不销毁）。
pub fn close(host: &Host) {
    if let Some(p) = host.window("panel") {
        let _ = p.hide();
    }
    host.log("panel closed");
}

/// 系统把 WS_EX_TOPMOST 剥掉时兜底自愈（Win32 位直读，Tk attributes 不可信的同款绕行）。
/// 面板不可见时不折腾。
pub fn heal_topmost(host: &Host) {
    let Some(p) = host.window("panel") else { return };
    if !p.is_visible().unwrap_or(false) {
        return;
    }
    let Some(h) = win32::hwnd(&p) else { return };
    if win32::has_topmost(h) {
        return;
    }
    let _ = p.set_always_on_top(true);
    host.log("panel topmost stripped by system -> restored");
}
