//! 界面存活看门狗（ADR 0008）：自己拥有心跳、加载、reload 计数与放弃状态。
//!
//! 先 reload 自救，救不回来（实测：WebView2 浏览器进程被杀后 reload 返回成功但页面永不回来）
//! 就重启自己一把——那正是用户「双击重开」要做的事，而老版本连退都退不掉，重开无从谈起。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::WebviewWindow;

use crate::consts::{WATCHDOG_BEAT_LIMIT, WATCHDOG_LOAD_LIMIT, WATCHDOG_MAX_RELOADS};
use crate::exit;
use crate::state::Host;
use crate::win32;

/// 白屏有两种死法，都要能自救：① 页面根本没加载（shown_at 之后一直没动静）；
/// ② 页面加载过、WebView2 进程后来死了（心跳停）。两种都不该把用户锁在关不掉的窗口里。
pub struct Watchdog {
    inner: Mutex<Beat>,
    /// 重启标记文件：页面成功加载后删掉。
    restart_marker: PathBuf,
}

struct Beat {
    shown_at: Instant,
    page_loaded: bool,
    last_beat: Instant,
    js_ready: bool,
    reloads: u32,
    exiting: bool,
    gave_up: bool,
    can_restart: bool,
}

impl Watchdog {
    pub fn new(boot: Instant, restart_marker: PathBuf, can_restart: bool) -> Self {
        Self {
            inner: Mutex::new(Beat {
                shown_at: boot,
                page_loaded: false,
                last_beat: boot,
                js_ready: false,
                reloads: 0,
                exiting: false,
                gave_up: false,
                can_restart,
            }),
            restart_marker,
        }
    }
}

fn state(host: &Host) -> tauri::State<'_, Watchdog> {
    host.state::<Watchdog>()
}

/// 主窗 show() 的时刻：加载计时的起点（启动、reload 都重置）。
pub fn mark_shown(host: &Host) {
    state(host).inner.lock().unwrap().shown_at = Instant::now();
}

/// 页面加载完成：白屏自救的第二个信号源（心跳之外的硬证据）。
pub fn mark_loaded(host: &Host) {
    let wd = state(host);
    let mut b = wd.inner.lock().unwrap();
    b.page_loaded = true;
    b.last_beat = Instant::now();
    b.shown_at = Instant::now();
    // 页面真的回来了：清掉重启标记，下次白屏还能自救
    let _ = std::fs::remove_file(&wd.restart_marker);
}

/// 每秒一次的心跳：看门狗据此判断界面还活着。
/// JS 在模块顶层就开定时器，只要脚本执行到就发——boot 卡在半路也还有心跳，不会被误 reload。
pub fn beat(host: &Host, ready: bool) {
    let wd = state(host);
    let mut b = wd.inner.lock().unwrap();
    b.last_beat = Instant::now();
    if ready && !b.js_ready {
        b.js_ready = true;
        b.shown_at = Instant::now();
        let _ = std::fs::remove_file(&wd.restart_marker);
        drop(b);
        host.log("ui ready (boot finished)");
    }
}

/// JS 现在是否还能答话（退出要用：能答就等它提交编辑）。
pub fn js_alive(host: &Host) -> bool {
    let wd = state(host);
    let b = wd.inner.lock().unwrap();
    exit::js_is_alive(b.js_ready, b.last_beat.elapsed())
}

/// 退出流程已开始（看门狗就此停手）。返回 false = 这次请求是重复的。
pub fn begin_exit(host: &Host) -> bool {
    let wd = state(host);
    let mut b = wd.inner.lock().unwrap();
    if b.exiting {
        return false;
    }
    b.exiting = true;
    true
}

/// 看门狗这一秒要做什么（锁内决定，锁外执行）。
enum Action {
    Reload(u32),
    GiveUp { restart: bool },
}

/// 判定本身不带状态，单独拆出来测（ADR 0008 的核心策略）。
#[derive(Debug, PartialEq)]
enum Step {
    Idle,
    Reload,
    GiveUp { restart: bool },
}

/// silent 超限才动手；reload 次数没到上限就再试一次；到顶了：
/// 允许重启就重启（只允许一次，重启后还白屏说明环境本身坏了），否则彻底撒手——
/// 撒手不影响退出，退出有 exit::request 兜底。
fn step(silent: Duration, limit: Duration, reloads: u32, gave_up: bool, can_restart: bool) -> Step {
    if silent <= limit {
        return Step::Idle;
    }
    if reloads >= WATCHDOG_MAX_RELOADS {
        if gave_up {
            return Step::Idle;
        }
        return Step::GiveUp { restart: can_restart };
    }
    Step::Reload
}

/// 起一个每秒看一眼的常驻线程。
pub fn spawn(host: &Host, win: WebviewWindow) {
    let host = host.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        let action = {
            let wd = state(&host);
            let mut b = wd.inner.lock().unwrap();
            if b.exiting {
                continue;
            }
            // 没加载完 / JS 没起来：从 show（或 boot 成功）算起；起来了：只看心跳间隔
            let (silent, limit) = if b.js_ready {
                (b.last_beat.elapsed(), WATCHDOG_BEAT_LIMIT)
            } else {
                (b.shown_at.elapsed(), WATCHDOG_LOAD_LIMIT)
            };
            match step(silent, limit, b.reloads, b.gave_up, b.can_restart) {
                Step::Idle => continue,
                Step::GiveUp { restart } => {
                    b.gave_up = true;
                    let reloads = b.reloads;
                    drop(b);
                    host.log(&format!(
                        "watchdog: ui silent {}s, {} reloads did not help",
                        silent.as_secs(),
                        reloads
                    ));
                    Action::GiveUp { restart }
                }
                Step::Reload => {
                    b.reloads += 1;
                    let n = b.reloads;
                    let loaded = b.page_loaded;
                    b.page_loaded = false;
                    b.js_ready = false;
                    b.shown_at = Instant::now();
                    b.last_beat = Instant::now();
                    drop(b);
                    host.log(&format!(
                        "watchdog: ui silent {}s (page loaded = {}) -> reload #{}",
                        silent.as_secs(),
                        loaded,
                        n
                    ));
                    Action::Reload(n)
                }
            }
        };
        match action {
            Action::Reload(n) => {
                if let Err(e) = win.reload() {
                    host.log(&format!("watchdog: reload #{} failed: {}", n, e));
                }
            }
            Action::GiveUp { restart: true } => {
                restart_self(&host);
                exit::force(&host, "ui unreachable after reloads, restarted a fresh instance");
                return;
            }
            // 已经自动重启过一次还是白屏 = 环境本身有问题（运行时损坏、udf 坏）。
            // 不再连环重启，退出仍然可用，留给用户自己决定重开还是修环境。
            Action::GiveUp { restart: false } => return,
        }
    });
}

/// 拉起一个新实例：新实例带 --wait-mutex，自己等老进程放出单实例锁再接管。
fn restart_self(host: &Host) {
    {
        let wd = state(host);
        // 重启标记：新实例启动时看到它就只再试一次自救、不再连环重启
        let _ = std::fs::write(&wd.restart_marker, "1");
    }
    match win32::spawn_detached_self(crate::consts::RESTART_ARG) {
        Ok(child) => host.log(&format!("restart: spawned pid {}", child.id())),
        Err(e) => host.log(&format!("restart: spawn failed: {}", e)),
    }
}

// 白屏自救的判定表：事件里最贵的是「每 20 秒才动一次手」和「无限重启」，两条都要钉住。
#[cfg(test)]
mod watchdog_tests {
    use super::*;

    #[test]
    fn reloads_before_giving_up() {
        let limit = Duration::from_secs(20);
        assert_eq!(step(Duration::from_secs(5), limit, 0, false, true), Step::Idle);
        assert_eq!(step(Duration::from_secs(21), limit, 0, false, true), Step::Reload);
        // reload 用满上限 → 该重启了（这正是 2026-11-13 现场：浏览器进程死了，reload 救不回来）
        assert_eq!(
            step(Duration::from_secs(21), limit, WATCHDOG_MAX_RELOADS, false, true),
            Step::GiveUp { restart: true }
        );
        // 重启过一次还是白屏 → 不再连环重启
        assert_eq!(
            step(Duration::from_secs(21), limit, WATCHDOG_MAX_RELOADS, false, false),
            Step::GiveUp { restart: false }
        );
        // 已经撒手就不再重复记录
        assert_eq!(step(Duration::from_secs(999), limit, WATCHDOG_MAX_RELOADS, true, true), Step::Idle);
    }

    #[test]
    fn thresholds_leave_room_for_a_slow_disk() {
        // 宁可晚点救也不要误 reload 丢未提交编辑：两条阈值都得明显长于正常启动
        assert!(WATCHDOG_LOAD_LIMIT >= Duration::from_secs(8));
        assert!(WATCHDOG_BEAT_LIMIT >= Duration::from_secs(15));
        assert!(WATCHDOG_MAX_RELOADS >= 1, "一次都不试就重启太急");
        // 心跳阈值必须大于退出宽限：否则「心跳刚停但 JS 还想提交编辑」会被看门狗和退出抢
        assert!(WATCHDOG_BEAT_LIMIT > crate::consts::EXIT_GRACE);
    }
}
