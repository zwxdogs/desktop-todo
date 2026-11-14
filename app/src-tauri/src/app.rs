//! 启动装配：读参数、读配置、拿单实例锁、起窗口与常驻线程。
//!
//! 这里是唯一「知道全部模块」的地方；每个模块自己不知道别人。装配顺序就是启动顺序，
//! 每一步都写清楚为什么排在这里——从前这些注释散在 1400 行的 `main` 里。

use std::path::PathBuf;
use std::time::Instant;
use tauri::{Emitter, Manager, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::config::Config;
use crate::consts::{APP_NAME, BROWSER_ARGS, LOG_MAX_BYTES, RESTART_ARG};
use crate::dialog;
use crate::dock;
use crate::exit;
use crate::geometry::{self, Rect};
use crate::panel;
use crate::state::{AppEnv, Host};
use crate::tray::{self, TrayState};
use crate::watchdog::{self, Watchdog};
use crate::win32;

/// 命令行解析结果：测试运行与自动重启都只体现在这里。
pub struct Args {
    /// 带清单路径参数启动 = 测试模式（不读不写 config.json）。
    pub file: Option<String>,
    /// 测试模式下 argv[2] == "float"：不贴桌面。
    pub want_dock: bool,
    /// 测试模式下 argv[2] == "x,y"：指定物理像素位置。
    pub pos: Option<(i32, i32)>,
    /// 本程序自动重启时给自己的参数，不算用户传入。
    pub wait_for_mutex: bool,
}

/// 解析 argv（不含程序名）。`--wait-mutex` 先行剔除：它是自动重启给自己的参数，
/// 留着会被当成「测试模式的清单路径」，让正式启动误入测试模式。
pub fn parse_args<I: IntoIterator<Item = String>>(raw: I) -> Args {
    let all: Vec<String> = raw.into_iter().collect();
    let wait_for_mutex = all.iter().any(|a| a == RESTART_ARG);
    let args: Vec<String> = all.into_iter().filter(|a| a != RESTART_ARG).collect();
    let file = args.first().cloned();
    let mut want_dock = true;
    let mut pos = None;
    if args.len() > 1 {
        if args[1] == "float" {
            want_dock = false;
        } else {
            pos = args[1]
                .split(',')
                .map(|v| v.trim().parse::<i32>().ok())
                .collect::<Option<Vec<i32>>>()
                .and_then(|v| if v.len() == 2 { Some((v[0], v[1])) } else { None });
        }
    }
    Args { file, want_dock, pos, wait_for_mutex }
}

/// 启动时的窗口矩形（物理像素）：位置沿用 config，尺寸受屏幕约束并夹回屏内。
///
/// `primary` 只决定「没存过位置时落哪」（右侧留 40、顶部留 100，与 Tk 的初值一致）；
/// `screen` 是**虚拟桌面**的外接矩形，尺寸上限与夹取都按它算——副屏上的坐标必须原样保留。
///
/// 无框可缩放窗口的 outer 含隐形 WS_THICKFRAME 边（本机实测 outer 比 client 大 26×15 物理像素），
/// 所以这里的一切都是 client 语义（Tk winfo 语义），与 config 存的坐标一致。
pub fn initial_frame(
    cfg: &Config,
    testing: bool,
    test_pos: Option<(i32, i32)>,
    scale: f64,
    primary: Rect,
    screen: Rect,
) -> Rect {
    let s = scale.max(1.0);
    if testing {
        let w = (430.0 * s) as i32;
        let h = (660.0 * s) as i32;
        let (x, y) = test_pos.unwrap_or(((100.0 * s) as i32, (100.0 * s) as i32));
        return Rect::new(x, y, w, h);
    }
    // 尺寸：config 里存过就用，但不许超过屏幕；下限与 min_inner_size 一致（恢复旧 config 里
    // 更窄的尺寸时也得撑到 300×180）。
    let w = match cfg.w {
        Some(v) => (v as i32).min(screen.w - 20),
        None => (380.0 * s) as i32,
    };
    let h = match cfg.h {
        Some(v) => (v as i32).min(screen.h - 60),
        None => (640.0 * s) as i32,
    };
    let w = w.max((300.0 * s) as i32);
    let h = h.max((180.0 * s) as i32);
    // 位置：没存过就落在主屏右上角
    let (x, y) = match (cfg.x, cfg.y) {
        (Some(ax), Some(ay)) => (ax as i32, ay as i32),
        _ => (primary.right() - w - (40.0 * s) as i32, primary.y + (100.0 * s) as i32),
    };
    let (x, y) = geometry::clamp((x, y), (w, h), screen);
    Rect::new(x, y, w, h)
}

/// 单实例锁：独占文件锁，句柄故意不关（整个进程生命周期都要持有它，进程退出时内核释放）。
///
/// 自动重启拉起的新实例带 `--wait-mutex`：老进程要退几百毫秒才放锁，它最多等 8 秒。
fn acquire_instance_lock(app_dir: &std::path::Path, wait_for_mutex: bool) {
    let tries = if wait_for_mutex { 80 } else { 1 }; // 80 × 100ms
    if !win32::lock_instance(&app_dir.join("widget.lock"), tries) {
        std::process::exit(0); // 已有实例在跑
    }
}

/// 日志常开（ADR 0008）：白屏那次一点痕迹都没留下，事后只能靠猜。
/// 测试运行写 md 旁边（与原行为一致），正式运行写 exe 旁 widget.log；超 200KB 启动时清空。
fn prepare_log(testing: bool, file: &std::path::Path, app_dir: &std::path::Path) -> Option<PathBuf> {
    let path = if testing { file.parent().unwrap_or(app_dir).join("widget.log") } else { app_dir.join("widget.log") };
    if std::fs::metadata(&path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::write(&path, "");
    }
    Some(path)
}

/// 真正的启动。
pub fn run() {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let app_dir = exe_dir.clone().unwrap_or_else(|| PathBuf::from("."));

    let args = parse_args(std::env::args().skip(1));
    let testing = args.file.is_some();
    let cfg = if testing { Config::default() } else { Config::load(&app_dir) };
    let file: PathBuf = match &args.file {
        Some(md) => PathBuf::from(md),
        None => cfg.resolve_file(&app_dir),
    };
    // 默认普通窗口（ADR 0004）：「普通窗口 → 固定在桌面」是用户唯一主动动作；
    // 老 config 里写着 docked=true 的继续固定在桌面，不迁移。
    let initial_dock = if testing { args.want_dock } else { cfg.docked };
    let log_path = prepare_log(testing, &file, &app_dir);

    acquire_instance_lock(&app_dir, args.wait_for_mutex);

    let boot = Instant::now();
    // 上一轮自动重启留下的标记：还在说明「重启后仍然白屏」，这次不再连环重启
    let restart_marker = app_dir.join("widget.restart");
    let can_restart = !restart_marker.exists();

    let env = AppEnv::new(app_dir.clone(), file.clone(), testing, log_path);
    let watchdog_state = Watchdog::new(boot, restart_marker, can_restart);
    let want_pos = args.pos;

    tauri::Builder::default()
        .manage(env)
        .manage(dock::Mode::default())
        .manage(TrayState::default())
        .manage(watchdog_state)
        .invoke_handler(tauri::generate_handler![
            crate::commands::app_info,
            crate::commands::read_md,
            crate::commands::write_md,
            crate::commands::file_state,
            crate::commands::save_config,
            crate::commands::set_docked,
            crate::commands::resize_start,
            crate::commands::poll_tick,
            crate::commands::maintain_reanchor,
            crate::commands::maintain_heal_panel,
            crate::commands::maintain_rescue_offscreen,
            crate::commands::maintain_flush_config,
            crate::commands::maintain_file_state,
            crate::commands::panel_open,
            crate::commands::panel_close,
            crate::commands::choose_file,
            crate::commands::new_md_file,
            crate::commands::open_file_location,
            crate::commands::log_line,
            crate::commands::heartbeat,
            crate::commands::exit_app
        ])
        // 页面加载完成 = 白屏自救的第二个信号源（心跳之外的硬证据，ADR 0008）
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                let host = Host::of(webview.app_handle());
                watchdog::mark_loaded(&host);
                host.log("page load finished");
            }
        })
        .setup(move |app| {
            let host = Host::of(app.handle());
            let scale =
                app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
            // 夹取按**整个虚拟桌面**算（多显示器外接矩形），不是主屏：留在副屏上的窗口
            // 下次启动不能被拽回主屏。首启的右上角落点仍以主屏为基准。
            let screen = win32::virtual_screen();
            let primary = win32::primary_screen();
            let frame = initial_frame(&cfg, testing, want_pos, scale, primary, screen);

            // 主窗口：进任务栏（用户要求，0.2.7 唯一有意差异）；
            // #9597 workaround：创建时不抢焦点，随后压底才不会被「创建即置顶」顶回来
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(APP_NAME)
                // 最小内宽 300：顶栏现在是 6 个 30px 按钮 + 9px 分组竖线（约 205px 固定），
                // 260 会把标题挤到只剩十几像素；高度沿用 180。
                .min_inner_size(300.0, 180.0)
                .decorations(false)
                .transparent(false)
                .resizable(true)
                .visible(false)
                .focused(false);
            // UDF：exe 旁的 udf/（绿色便携语义，与 config.json 同址；
            // loader 对显式 UDF 要求目录可创建，失败会清掉新建目录 —— 见 spike 报告 §3.1）
            let udf = exe_dir.as_ref().map(|d| d.join("udf"));
            let win = if let Some(d) = &udf {
                let _ = std::fs::create_dir_all(d);
                win.data_directory(d.clone())
            } else {
                win
            };
            // build 失败 = WebView2 环境建不起来（udf 被占用 / 运行时损坏）。以前这里 `?`
            // 让 setup 返回 Err → tauri panic，进程悄悄死掉，用户看到的是「双击没反应」。
            // 改成把原因写进日志并弹框说明（ADR 0008）。
            let win = match win.additional_browser_args(BROWSER_ARGS).build() {
                Ok(w) => w,
                Err(e) => {
                    host.log(&format!("webview build failed: {}", e));
                    dialog::show(
                        dialog::Level::Error,
                        &format!("界面起不来（WebView2 运行时可能被占用或损坏）：\n{}\n\n请先确认没有正在运行的实例，或重启电脑后再试。", e),
                    );
                    std::process::exit(1);
                }
            };
            win.hide()?;

            // 尺寸/位置：先按 client 值设，再读回 inner 原点求一次偏差并补偿（见 set_client_position）。
            // tao 的 set_position 是 outer 语义，无框可缩放窗口带隐形 WS_THICKFRAME 边，
            // 直接按 inner 值设会每轮向右下漂移。
            win.set_size(PhysicalSize::new(frame.w as u32, frame.h as u32))?;
            win32::set_client_position(&win, frame.x, frame.y)?;

            // 进入初始两态（ADR 0004）：一次调用把样式、显示、显示后的复落与日志都办完
            dock::enter(&host, &win, initial_dock)?;

            // 托盘：两种模式下都在。固定在桌面时任务栏没有图标，托盘就是唤回主窗口的入口。
            tray::build(&host, initial_dock)?;

            // 详情面板：独立 webview 窗口，隐藏待用
            panel::build(&host, udf);

            // 看门狗最后起：此时窗口已 show、页面开始加载，计时才有意义
            watchdog::spawn(&host, win.clone());

            Ok(())
        })
        .on_window_event(|win, event| match event {
            tauri::WindowEvent::Focused(false) => {
                // 只在贴桌面模式重压底；普通窗口模式保持原 z 序
                let host = Host::from_window(win);
                if win.label() == "main" && dock::is_docked(&host) {
                    dock::pin_to_desktop(&host);
                }
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                // 拖动/缩放期间高频触发，只在维护轮询里统一落盘（≈Tk 松手保存）
                if win.label() == "main" {
                    Host::from_window(win).mark_config_dirty();
                }
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let host = Host::from_window(win);
                if win.label() == "main" {
                    // 任务栏右键关闭 / Alt+F4：JS 活着就交给它走 on_close 语义（提交编辑→保存→退出），
                    // JS 死了就直接退——退出这件事不能整个挂在 webview 上（ADR 0008）
                    api.prevent_close();
                    exit::request(&host);
                } else {
                    // 面板被外部关闭（Alt+F4）：与面板内 ✕ 同路径
                    api.prevent_close();
                    let _ = host.app().emit_to("main", "panel-close", ());
                    panel::close(&host);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    fn primary() -> Rect {
        Rect::new(0, 0, 1920, 1080)
    }

    fn screen() -> Rect {
        primary()
    }

    fn frame(cfg: &Config) -> Rect {
        initial_frame(cfg, false, None, 1.0, primary(), screen())
    }

    #[test]
    fn fresh_install_lands_top_right_at_the_default_size() {
        let f = frame(&Config::default());
        assert_eq!((f.w, f.h), (380, 640), "全新安装的尺寸");
        assert_eq!((f.x, f.y), (1920 - 380 - 40, 100), "没存过位置就落主屏右上角");
    }

    #[test]
    fn stored_geometry_is_restored_exactly() {
        // 验收「文件位置重启后保持」：config 里的 client 坐标原样回来，不偏移不缩放
        let cfg = Config { file: "a.md".into(), x: Some(300), y: Some(200), w: Some(760), h: Some(640), docked: true };
        assert_eq!((frame(&cfg).x, frame(&cfg).y, frame(&cfg).w, frame(&cfg).h), (300, 200, 760, 640));
    }

    #[test]
    fn oversized_height_is_capped_then_the_window_is_pulled_up() {
        // 换到更矮的屏幕：高度先按屏高夹住，夹完之后底边仍在屏外，所以 y 也要跟着上移
        let cfg = Config { file: "a.md".into(), x: Some(300), y: Some(200), w: Some(760), h: Some(1280), docked: true };
        let f = frame(&cfg);
        assert_eq!(f.h, 1080 - 60, "高度按屏高夹住");
        assert_eq!(f.y, 1080 - f.h, "夹完高度后底边不能还在屏外");
    }

    #[test]
    fn oversized_and_stray_geometry_is_pulled_back() {
        // 旧 config 可能记着更窄的尺寸（低于 min_inner_size）或屏外的坐标
        let cfg = Config { file: "a.md".into(), x: Some(9999), y: Some(-400), w: Some(120), h: Some(90), docked: false };
        let f = frame(&cfg);
        assert_eq!((f.w, f.h), (300, 180), "低于下限要撑到 min_inner_size");
        assert_eq!((f.x, f.y), (1620, 0), "屏外坐标夹回屏内");
    }

    #[test]
    fn a_window_left_on_a_left_hand_monitor_stays_there() {
        // 本机实测虚拟桌面 = (-1920,0)+3840x1080。旧实现按主屏夹取，会把留在左副屏的窗口
        // 拽回主屏——那正是「屏幕外救援」要保住的东西。现在夹取按虚拟桌面算。
        let vs = Rect::new(-1920, 0, 3840, 1080);
        let cfg = Config { file: "a.md".into(), x: Some(-1800), y: Some(100), w: Some(760), h: Some(640), docked: true };
        let f = initial_frame(&cfg, false, None, 1.0, primary(), vs);
        assert_eq!((f.x, f.y), (-1800, 100), "副屏坐标必须原样保留");
    }

    #[test]
    fn test_mode_uses_fixed_size_and_optional_position() {
        let f = initial_frame(&Config::default(), true, None, 1.0, primary(), screen());
        assert_eq!((f.x, f.y, f.w, f.h), (100, 100, 430, 660));
        let g = initial_frame(&Config::default(), true, Some((7, 8)), 1.0, primary(), screen());
        assert_eq!((g.x, g.y), (7, 8), "argv 指定的位置优先");
    }

    #[test]
    fn scaling_multiplies_the_defaults() {
        // 150% 缩放下默认尺寸跟着放大，否则高分屏上字大窗小
        let big = Rect::new(0, 0, 2560, 1440);
        let f = initial_frame(&Config::default(), false, None, 1.5, big, big);
        assert_eq!((f.w, f.h), (570, 960));
    }

    #[test]
    fn restart_arg_is_filtered_out_of_user_args() {
        // --wait-mutex 是本程序自动重启时给自己的参数，不能被当成「测试模式的文件路径」
        let a = parse_args(vec!["--wait-mutex".to_string()]);
        assert!(a.wait_for_mutex);
        assert_eq!(a.file, None, "过滤掉之后就没有位置参数了");
    }
}
