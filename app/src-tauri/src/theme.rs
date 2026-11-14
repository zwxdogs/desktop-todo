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

/// 三档的全部差异，一处定义。
///
/// 每一档要回答四件事：config 里写成什么词、菜单上叫什么、日志里叫什么、落到窗口上是什么。
/// 之前这四件事散在 `config::theme_or_system` / `config::to_window_theme` / `pref_word` /
/// `label` / `tray::theme_pref_of` 五处各写一遍 match（复审指出：同一组变体被 switch 了五次，
/// 加第四档要改五个地方、漏一个就静默不一致）。现在只有这张表，加一档就是加一行；
/// 读的方向由 `all()` / 各具名函数提供，写回来时 `ThemePref` 还是那个 enum，类型安全不动。
struct Spec {
    pref: ThemePref,
    /// config.json 里的词（小写，人能读）。
    word: &'static str,
    /// 托盘菜单上的中文。
    label: &'static str,
    /// 落到窗口的 `set_theme` 语义；`None` = 跟随系统。
    window: Option<tauri::Theme>,
}

const SPECS: [Spec; 3] = [
    Spec { pref: ThemePref::Light, word: "light", label: "亮色", window: Some(tauri::Theme::Light) },
    Spec { pref: ThemePref::Dark, word: "dark", label: "暗色", window: Some(tauri::Theme::Dark) },
    Spec { pref: ThemePref::System, word: "system", label: "跟随系统", window: None },
];

fn spec(pref: ThemePref) -> &'static Spec {
    SPECS.iter().find(|s| s.pref == pref).expect("三档都在 SPECS 里")
}

/// 三档全表（按菜单顺序）；`tray` 建菜单与配置解析都走它。
pub fn all() -> impl Iterator<Item = ThemePref> {
    SPECS.iter().map(|s| s.pref)
}

/// `ThemePref` → config.json 里的词。
pub fn word(pref: ThemePref) -> &'static str {
    spec(pref).word
}

/// config.json 里的词 → `ThemePref`；不认识的词与缺省都落跟随系统。
pub fn from_word(raw: Option<&str>) -> ThemePref {
    raw.and_then(|w| SPECS.iter().find(|s| s.word == w).map(|s| s.pref)).unwrap_or(ThemePref::System)
}

/// 落到窗口的 `set_theme` 语义：`None` = 跟随系统。
pub fn window_theme(pref: ThemePref) -> Option<tauri::Theme> {
    spec(pref).window
}

/// 菜单上叫什么。
pub fn label(pref: ThemePref) -> &'static str {
    spec(pref).label
}

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

/// 主题必须落到的窗口。
///
/// 单独提出来是为了让这件事**可测**：`panel` 是独立 webview（`panel.rs` 建的），
/// 漏了它就变成「只有主窗换色、面板还是白的」——那正是验收里点名的一条。
/// 写成常量的另一个理由：它是「主题影响面」的唯一定义，将来加窗口只改这里。
pub const WINDOWS: [&str; 2] = ["main", "panel"];

/// 把一档主题落到窗口上。切档与启动共用这一条路径：
/// 启动时窗口刚建好、还没显示，切档时窗口已经显示——两条路径唯一的差别由调用方负责
/// （启动走它自己的装配顺序），这里只管「设成这个主题」。
///
/// 返回实际设上的窗口数，调用方只拿去写日志（「设上了几个窗口」正是排查
/// 「面板怎么没换色」时第一个要看的事实）。
/// 必须在 `panel::build` 之后调用，否则面板拿不到这一次的主题。
pub fn apply(host: &Host, pref: ThemePref) -> usize {
    let theme = window_theme(pref);
    let mut done = 0;
    for win_label in WINDOWS {
        let Some(win) = host.window(win_label) else { continue };
        match win.set_theme(theme) {
            Ok(()) => done += 1,
            // 面板起不来时它本来就不在（`panel::build` 失败只记日志），不该连累主窗；
            // 但既然窗口在、调用却失败，得留下痕迹，否则「面板不换色」会变成无解的谜。
            Err(e) => host.log(&format!("theme: set_theme({}) on {} failed: {}", word(pref), win_label, e)),
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
    host.log(&format!("theme: {} ({} window(s))", word(pref), n));
}

/// 启动收尾：两个窗口都建好之后，按登记好的档位落一次。
/// 与 `switch` 的区别只有一处——不存盘：启动时读到的就是盘上那份，没有新东西要写。
pub fn settle(host: &Host) {
    let pref = current(host);
    let n = apply(host, pref);
    host.log(&format!("theme: initial {} ({} window(s))", word(pref), n));
}

#[cfg(test)]
mod theme_mode_tests {
    use super::*;

    #[test]
    fn theme_reaches_both_windows_and_only_those() {
        // 验收「切到暗色 → 主窗口与详情面板同时换色」：漏掉 panel 就是只有主窗换、
        // 面板还是白的。这条钉住的是「影响面」这个事实本身，不依赖真窗口。
        assert_eq!(WINDOWS, ["main", "panel"], "主窗与面板都必须收到，顺序也钉住");
        assert!(WINDOWS.contains(&"main"));
        assert!(WINDOWS.contains(&"panel"));
    }

    #[test]
    fn every_pref_has_a_menu_label() {
        // 托盘菜单的三项来自这里：漏一个就是菜单少一项，或者点了没字的按钮
        assert_eq!(label(ThemePref::System), "跟随系统");
        assert_eq!(label(ThemePref::Light), "亮色");
        assert_eq!(label(ThemePref::Dark), "暗色");
    }

    #[test]
    fn all_three_are_in_the_table_and_reachable_by_pref() {
        // 表少一行 → spec() 的 expect 会炸；多一行重复 → 三档就分不干净了
        let listed: Vec<ThemePref> = all().collect();
        assert_eq!(listed.len(), 3, "三档互斥：多一个少一个都不对");
        for pref in [ThemePref::Light, ThemePref::Dark, ThemePref::System] {
            assert!(listed.contains(&pref), "{:?} 不在 SPECS 里", pref);
        }
    }

    #[test]
    fn each_pref_round_trips_through_its_config_word() {
        // 写出去再读回来必须是同一档：这条错了「选了暗色重启变亮色」
        for pref in all() {
            assert_eq!(from_word(Some(word(pref))), pref, "{:?} 的 config 词必须能读回自己", pref);
        }
    }

    #[test]
    fn an_unknown_or_missing_word_falls_back_to_following_the_system() {
        // 手改错的 config 不该让人打不开待办，也不该把界面钉在某一档
        assert_eq!(from_word(None), ThemePref::System);
        assert_eq!(from_word(Some("")), ThemePref::System);
        assert_eq!(from_word(Some("System")), ThemePref::System, "大小写不认");
        assert_eq!(from_word(Some("auto")), ThemePref::System);
    }

    #[test]
    fn only_following_the_system_leaves_the_window_theme_unforced() {
        // 「跟随系统」落到 set_theme 的语义是 None（不是 Some(Light)）——这是三态的接缝，
        // 写错就变成「选了跟随系统却钉死在亮色」。
        assert_eq!(window_theme(ThemePref::System), None, "跟随系统 = 不强制");
        assert_eq!(window_theme(ThemePref::Light), Some(tauri::Theme::Light));
        assert_eq!(window_theme(ThemePref::Dark), Some(tauri::Theme::Dark));
    }

    #[test]
    fn config_words_labels_and_window_states_are_all_distinct() {
        // 三处都靠「一档一个值」区分：文案重了菜单会出现两个一样的项，
        // config 词重了读回来就分不出是哪个，窗口状态重了切档等于没切。
        let listed: Vec<ThemePref> = all().collect();
        for (i, a) in listed.iter().enumerate() {
            for b in &listed[i + 1..] {
                assert_ne!(word(*a), word(*b), "config 词不能重复");
                assert_ne!(label(*a), label(*b), "菜单项文案不能重复");
                assert_ne!(window_theme(*a), window_theme(*b), "窗口状态不能重复");
            }
        }
    }
}
