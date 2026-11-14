//! 托盘：图标、菜单、勾选态同步，以及「显示待办」这条唤回路径。
//!
//! 托盘勾选态 = 当前模式。set_checked 会 run_on_main_thread + 阻塞等待，在主线程（命令/托盘回调）
//! 里调用会死锁，所以统一丢给一个常驻同步线程按到达顺序执行——每次新开线程的话，两次快速切换的
//! 落点顺序不保证，勾选态可能永久反着。

use std::sync::mpsc::Sender;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::consts::{APP_NAME, TRAY_DOCK, TRAY_QUIT, TRAY_SHOW};
use crate::dock;
use crate::exit;
use crate::state::Host;

/// 勾选态的同步通道（由常驻线程消费）。
#[derive(Default)]
pub struct TrayState {
    check_tx: Mutex<Option<Sender<bool>>>,
}

/// 把当前模式推给同步线程；没建托盘时静默。
pub fn sync_check(host: &Host) {
    let docked = dock::is_docked(host);
    if let Some(tx) = host.state::<TrayState>().check_tx.lock().unwrap().as_ref() {
        let _ = tx.send(docked);
    }
}

/// 建托盘：先登记勾选通道，再建菜单与图标（建完立刻可能被命令触发 sync_check）。
pub fn build(host: &Host, initial_dock: bool) -> tauri::Result<()> {
    let app = host.app();
    let show_item = MenuItem::with_id(app, TRAY_SHOW, "显示待办", true, None::<&str>)?;
    let dock_item = CheckMenuItem::with_id(app, TRAY_DOCK, "固定在桌面", true, initial_dock, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &dock_item, &sep, &quit_item])?;

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
