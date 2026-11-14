//! 每秒一次的维护：五件事各自具名、可单独触发。
//!
//! 从前 `poll_tick` 一次做五件事却只回一个文件状态，读代码的人看不出哪一步动了窗口。
//! 现在每一步都是一个窄函数，`tick` 只是把它们按固定顺序排一遍：
//!
//! | 步骤 | 做什么 | 什么时候会动 |
//! |---|---|---|
//! | `reanchor` | 固定在桌面时保持贴在桌面层 | Win+D 最小化 / z 序被顶开 |
//! | `heal_panel` | 面板被系统剥掉置顶位时补回 | 系统重排 z 序 |
//! | `rescue_offscreen` | 窗口跑到屏外时拉回来 | 拖过头 / 显示器热插拔 / 改分辨率 |
//! | `flush_config` | Moved/Resized 攒下的改动落盘 | 用户刚拖过窗口 |
//! | `file_state` | 读文件状态给前端决定要不要重载 | 每次 |
//!
//! 前四步没有返回值（它们自己决定要不要动手），第五步的返回值就是心跳回给前端的东西。

use tauri::WebviewWindow;

use crate::dock;
use crate::geometry;
use crate::panel;
use crate::persist;
use crate::state::Host;
use crate::win32;

/// ① 贴桌面维持：Win+D / 全部最小化会把本窗口也最小化，立即还原，保持桌面可见；
/// 被别的窗口顶开（不再紧贴 Progman 之上）就重新压底。
pub fn reanchor(host: &Host, win: &WebviewWindow) {
    if !dock::is_docked(host) {
        return;
    }
    let Some(h) = win32::hwnd(win) else { return };
    if win32::is_iconic(h) {
        let _ = win.unminimize();
        dock::pin_to_desktop(host);
        host.log("restored from Win+D minimize");
    } else if win32::foreground() != h && !win32::at_desktop_level(h) {
        dock::pin_to_desktop(host);
    }
}

/// ② 面板置顶自愈。
pub fn heal_panel(host: &Host) {
    panel::heal_topmost(host);
}

/// ③ 离屏救援（client 语义与 Tk 一致）：最小化时不动，免得把用户的还原位置覆盖掉。
///
/// 位置必须按 client 原点上屏（见 `win32::set_client_position`）：直接用 `set_position` 会按 outer
/// 落点，被夹回右缘的窗口下一轮又差几个像素、每秒都在挪——实测过。
pub fn rescue_offscreen(host: &Host, win: &WebviewWindow) {
    let Some(h) = win32::hwnd(win) else { return };
    if win32::is_iconic(h) {
        return;
    }
    let Some(frame) = win32::client_rect(win) else { return };
    let (nx, ny) = geometry::clamp((frame.x, frame.y), (frame.w, frame.h), win32::virtual_screen());
    if (nx, ny) == (frame.x, frame.y) {
        return;
    }
    let _ = win32::set_client_position(win, nx, ny);
    host.log(&format!("window off-screen -> rescued to {},{}", nx, ny));
}

/// ④ Moved/Resized 攒下的 config 落盘。
pub fn flush_config(host: &Host) {
    persist::flush_if_dirty(host);
}

/// ⑤ 文件状态：路径由前端显式传入、不从当前文件猜——轮询只报调用方指着的那个文件（#12）。
pub fn file_state(file: &str) -> Option<crate::files::FileState> {
    crate::files::stat(std::path::Path::new(file))
}

/// 跑一遍全部维护步骤，返回文件状态。顺序即文档里的顺序，不依赖彼此。
pub fn tick(host: &Host, win: &WebviewWindow, file: &str) -> Option<crate::files::FileState> {
    reanchor(host, win);
    heal_panel(host);
    rescue_offscreen(host, win);
    flush_config(host);
    file_state(file)
}

#[cfg(test)]
mod maintenance_tests {
    use super::*;
    use crate::geometry::Rect;

    #[test]
    fn rescue_clamp_is_idempotent() {
        // 救援必须收敛：救一次之后再算一遍不能又变一个位置，否则每秒都在挪窗口
        let screen = Rect::new(0, 0, 1920, 1080);
        let size = (400, 600);
        for start in [(-999, 300), (5000, 300), (500, 9999), (500, 300)] {
            let once = geometry::clamp(start, size, screen);
            assert_eq!(geometry::clamp(once, size, screen), once, "救一次就该稳定在 {:?}", start);
        }
    }
}
