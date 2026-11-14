//! 托盘：图标、菜单、勾选态同步，以及「显示待办」这条唤回路径。
//!
//! 托盘勾选态 = 当前模式。set_checked 会 run_on_main_thread + 阻塞等待，在主线程（命令/托盘回调）
//! 里调用会死锁，所以统一丢给一个常驻同步线程按到达顺序执行——每次新开线程的话，两次快速切换的
//! 落点顺序不保证，勾选态可能永久反着。
//!
//! 同一套理由也适用于「主题色」的三项（#23）：`set_checked` 与 `Window::set_theme` 都会阻塞
//! 主线程，所以主题切换在 `on_menu` 里同步做（它已经在线程里），勾选态则走**另一条**常驻线程，
//! 与停靠项各走各的——两条通道互不相干，谁也不会因为对方排着队而卡住。

use std::sync::mpsc::Sender;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::config::ThemePref;
use crate::consts::{
    APP_NAME, TRAY_DOCK, TRAY_QUIT, TRAY_SHOW, TRAY_THEME_DARK, TRAY_THEME_LIGHT, TRAY_THEME_SYSTEM,
};
use crate::dock;
use crate::exit;
use crate::state::Host;
use crate::theme;

/// 勾选态的同步通道（由常驻线程消费）。
///
/// 停靠项与主题项各一条：主题三条要互斥，投递的是「该勾上的那一档」，而不是三条各自的真假。
#[derive(Default)]
pub struct TrayState {
    check_tx: Mutex<Option<Sender<bool>>>,
    theme_tx: Mutex<Option<Sender<ThemePref>>>,
}

/// 把当前模式推给同步线程；没建托盘时静默。
pub fn sync_check(host: &Host) {
    let docked = dock::is_docked(host);
    if let Some(tx) = host.state::<TrayState>().check_tx.lock().unwrap().as_ref() {
        let _ = tx.send(docked);
    }
}

/// 把当前主题档位推给同步线程；没建托盘时静默。
pub fn sync_theme(host: &Host) {
    let pref = theme::current(host);
    if let Some(tx) = host.state::<TrayState>().theme_tx.lock().unwrap().as_ref() {
        let _ = tx.send(pref);
    }
}

/// 建托盘：先登记两条勾选通道，再建菜单与图标（建完立刻可能被命令触发 sync_check）。
pub fn build(host: &Host, initial_dock: bool) -> tauri::Result<()> {
    let app = host.app();
    let show_item = MenuItem::with_id(app, TRAY_SHOW, "显示待办", true, None::<&str>)?;
    let dock_item = CheckMenuItem::with_id(app, TRAY_DOCK, "固定在桌面", true, initial_dock, None::<&str>)?;

    // 主题色子菜单（#23）：三项互斥勾选，当前项勾上。默认「跟随系统」。
    let pref = theme::current(host);
    let light_item = theme_check(app, TRAY_THEME_LIGHT, ThemePref::Light, pref)?;
    let dark_item = theme_check(app, TRAY_THEME_DARK, ThemePref::Dark, pref)?;
    let system_item = theme_check(app, TRAY_THEME_SYSTEM, ThemePref::System, pref)?;
    let theme_menu =
        Submenu::with_items(app, "主题色", true, &[&light_item, &dark_item, &system_item])?;

    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &dock_item, &theme_menu, &sep, &quit_item])?;

    let (check_tx, check_rx) = std::sync::mpsc::channel::<bool>();
    *host.state::<TrayState>().check_tx.lock().unwrap() = Some(check_tx);
    {
        // set_checked 阻塞，不能碰主线程：常驻线程按到达顺序落最新值
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

    let (theme_tx, theme_rx) = std::sync::mpsc::channel::<ThemePref>();
    *host.state::<TrayState>().theme_tx.lock().unwrap() = Some(theme_tx);
    {
        // 三项互斥：投递的是「该勾上的那一档」，落一次就是整组的新状态。
        // 与停靠项同理，set_checked 阻塞，只在这条线程里调用。
        let items = [(ThemePref::Light, light_item), (ThemePref::Dark, dark_item), (ThemePref::System, system_item)];
        std::thread::spawn(move || {
            while let Ok(first) = theme_rx.recv() {
                let mut latest = first;
                while let Ok(next) = theme_rx.try_recv() {
                    latest = next;
                }
                for (pref, item) in &items {
                    let _ = item.set_checked(*pref == latest);
                }
            }
        });
    }

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            // 菜单回调在主线程；set_checked 之类会阻塞主线程，处理一律丢到独立线程
            let host = Host::of(app);
            let id = event.id().as_ref().to_owned();
            std::thread::spawn(move || on_menu(&host, &id));
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let host = Host::of(tray.app_handle());
                std::thread::spawn(move || show_main_window(&host));
            }
        });
    // 托盘位图 = exe 内嵌的应用图标（tauri 在 Windows 上从图标资源解码，免开 image-png）
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    } else {
        host.log("tray: no embedded app icon resource");
    }
    tray.build(app)?;
    Ok(())
}

/// 主题色的一个勾选项：文案与 id 都从 `theme` / `consts` 取，免得两处各写一遍。
fn theme_check<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    pref: ThemePref,
    current: ThemePref,
) -> tauri::Result<CheckMenuItem<R>> {
    CheckMenuItem::with_id(app, id, theme::label(pref), true, pref == current, None::<&str>)
}

/// 托盘左键 / 「显示待办」：切回普通窗口并置前，方便直接加待办。
pub fn show_main_window(host: &Host) {
    if dock::is_docked(host) {
        dock::switch(host, false);
    }
    if let Some(win) = host.window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn on_menu(host: &Host, id: &str) {
    // 主题项：三条共用前缀，按 id 反查档位（加第四档只需在 to_pref 里补一行）
    if let Some(pref) = theme_pref_of(id) {
        theme::switch(host, pref);
        sync_theme(host);
        return;
    }
    match id {
        TRAY_SHOW => show_main_window(host),
        TRAY_DOCK => {
            let next = !dock::is_docked(host);
            dock::switch(host, next);
        }
        // 与 Alt+F4 / 任务栏关闭同路径：JS 活着就交给它提交编辑再退（见 exit::request）
        TRAY_QUIT => exit::request(host),
        _ => {}
    }
}

/// 菜单 id → 主题档位。不属于主题项的 id 回 None。
///
/// 单独拎出来是为了让它可测：id 与档位的对应错了，整张菜单点了都不会有反应。
/// 不加前缀判断：这张表里没有的 id 本来就回 None，「显示待办」「退出」不会被误吞，
/// 而前缀多一层只是多一处可以对不上的东西（复审指出它并不买任何东西）。
fn theme_pref_of(id: &str) -> Option<ThemePref> {
    match id {
        TRAY_THEME_LIGHT => Some(ThemePref::Light),
        TRAY_THEME_DARK => Some(ThemePref::Dark),
        TRAY_THEME_SYSTEM => Some(ThemePref::System),
        _ => None,
    }
}

#[cfg(test)]
mod tray_menu_tests {
    use super::*;

    #[test]
    fn each_theme_item_maps_back_to_its_own_pref() {
        // 勾了哪一项就得切到哪一档：这里错一位，用户点「暗色」会得到亮色
        assert_eq!(theme_pref_of(TRAY_THEME_LIGHT), Some(ThemePref::Light));
        assert_eq!(theme_pref_of(TRAY_THEME_DARK), Some(ThemePref::Dark));
        assert_eq!(theme_pref_of(TRAY_THEME_SYSTEM), Some(ThemePref::System));
    }

    #[test]
    fn the_other_tray_items_are_not_mistaken_for_theme_items() {
        // 前缀判断太宽会把「显示待办」「退出」吞进主题分支，导致托盘点了没反应
        for id in [TRAY_SHOW, TRAY_DOCK, TRAY_QUIT, "", "tray-theme-", "tray-theme-nope"] {
            assert_eq!(theme_pref_of(id), None, "{} 不该被判成主题项", id);
        }
    }
}
