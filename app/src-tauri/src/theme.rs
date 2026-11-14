//! 主题色：亮 / 暗 / 跟随系统三态的唯一所有者（#23）。
//!
//! 为什么是 Rust 而不是 JS 的 `setTheme`：那个 API 要 `core:window:allow-set-theme` 权限，
//! 而托盘菜单本来就在 Rust 侧，从 Rust 直接调 `Window::set_theme` 不必给前端开任何权限。
//!
//! `set_theme` 在 Windows 上落到 `CoreWebView2Profile::SetPreferredColorScheme`
//! （链路由本地 crate 源码核实：tauri-runtime-wry 的 `WindowMessage::SetTheme` → tao
//! `SendMessageW(CHANGE_THEME_MSG_ID)` → 同步回调 `update_theme` → `ThemeChanged` →
//! `webview.set_theme` → wry `SetPreferredColorScheme`）。所以 CSS 的
//! `prefers-color-scheme` 媒体查询会跟着变，界面侧不需要 `data-theme` 那套属性。
//!
//! **必须对两个窗口都设**：`panel` 是独立 webview（`panel.rs`），只设主窗就是「面板不换色」。
//!
//! 两处系统绘制的缝隙只跟随系统、不跟本开关（维护者已接受，见 #23 §5）：托盘菜单
//! （`tray-icon` 直接 `TrackPopupMenu`）、`rfd` 的文件对话框、`MessageBoxW` 消息框。
//!
//! `set_theme` 会阻塞主线程（tao 在窗口过程里同步刷新），所以托盘回调把它丢进常驻线程，
//! 与 `TrayState` 的勾选态同步同一套做法——见 `tray.rs` 的模块注释。

use std::sync::Mutex;

use crate::config::ThemePref;
use crate::state::Host;

/// 「现在选的是哪一档」的唯一存放处。
#[derive(Default)]
pub struct Mode {
    pref: Mutex<ThemePref>,
}

/// 当前主题档位（`persist` 落盘时问它）。
pub fn current(host: &Host) -> ThemePref {
    *host.state::<Mode>().pref.lock().unwrap()
}

fn set_current(host: &Host, pref: ThemePref) {
    *host.state::<Mode>().pref.lock().unwrap() = pref;
}

/// 登记当前档位，**不碰窗口**。
///
/// 启动时它比窗口还早：托盘菜单要在建的时候就知道该勾哪一项（`tray::build` 读 `current`），
/// 而那时 `panel` 还没建。所以「记住选哪档」与「落到窗口上」是两件事，分开两个调用；
/// 合成一个的话，要么托盘勾错项，要么得把托盘挪到面板之后，两样都是在藏依赖。
pub fn register(host: &Host, pref: ThemePref) {
    set_current(host, pref);
}

/// 把一档主题落到窗口上。切档与启动共用这一条路径：
/// 启动时窗口刚建好、还没显示，切档时窗口已经显示——两条路径唯一的差别由调用方负责
/// （启动走它自己的装配顺序），这里只管「设成这个主题」。
///
/// 返回实际设上的窗口数，供日志与测试以外的地方判断「到底有没有窗口在」。
/// 必须在 `panel::build` 之后调用，否则面板拿不到这一次的主题。
pub fn apply(host: &Host, pref: ThemePref) -> usize {
    let theme = pref.to_window_theme();
    let mut done = 0;
    for label in ["main", "panel"] {
        let Some(win) = host.window(label) else { continue };
        match win.set_theme(theme) {
            Ok(()) => done += 1,
            // 面板起不来时它本来就不在（`panel::build` 失败只记日志），不该连累主窗；
            // 但既然窗口在、调用却失败，得留下痕迹，否则「面板不换色」会变成无解的谜。
            Err(e) => host.log(&format!("theme: set_theme({}) on {} failed: {}", pref_word(pref), label, e)),
        }
    }
    done
}

/// 切主题的唯一入口（托盘菜单调它）：落状态 → 落到两个窗口 → 存盘 → 记日志。
///
/// 本函数**会阻塞**（`set_theme` 同步走窗口过程），所以调用方不能是主线程。
/// 托盘回调已经在线程里，命令层不该调它——这也是没给前端开这个能力的原因之一。
pub fn switch(host: &Host, pref: ThemePref) {
    set_current(host, pref);
    let n = apply(host, pref);
    crate::persist::save(host);
    host.log(&format!("theme: {} ({} window(s))", pref_word(pref), n));
}

/// 启动收尾：两个窗口都建好之后，按登记好的档位落一次。
/// 与 `switch` 的区别只有一处——不存盘：启动时读到的就是盘上那份，没有新东西要写。
pub fn settle(host: &Host) {
    let pref = current(host);
    let n = apply(host, pref);
    host.log(&format!("theme: initial {} ({} window(s))", pref_word(pref), n));
}

fn pref_word(pref: ThemePref) -> &'static str {
    match pref {
        ThemePref::System => "system",
        ThemePref::Light => "light",
        ThemePref::Dark => "dark",
    }
}

/// 日志与托盘文案共用的一处：菜单三项的标签与 id 都从这里来，免得两处各写一遍中文。
pub fn label(pref: ThemePref) -> &'static str {
    match pref {
        ThemePref::System => "跟随系统",
        ThemePref::Light => "亮色",
        ThemePref::Dark => "暗色",
    }
}

#[cfg(test)]
mod theme_mode_tests {
    use super::*;

    #[test]
    fn every_pref_has_a_menu_label() {
        // 托盘菜单的三项来自这里：漏一个就是菜单少一项，或者点了没字的按钮
        assert_eq!(label(ThemePref::System), "跟随系统");
        assert_eq!(label(ThemePref::Light), "亮色");
        assert_eq!(label(ThemePref::Dark), "暗色");
    }

    #[test]
    fn labels_are_distinct_so_the_menu_cannot_show_two_identical_items() {
        let all = [ThemePref::System, ThemePref::Light, ThemePref::Dark];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(label(*a), label(*b), "菜单项文案不能重复");
            }
        }
    }
}
