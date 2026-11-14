//! 退出：JS 活着就让它提交编辑再退，JS 死了就直接退。
//!
//! ADR 0008 的根因是整条退出链都挂在 JS 监听上，而白屏时 JS 已经死了 —— 所以「还活着吗」
//! 必须能识破「曾经就绪、现在没心跳」，退出也要有不依赖 webview 的后手。

use std::time::Duration;
use tauri::Emitter;

use crate::consts::EXIT_GRACE;
use crate::persist;
use crate::state::Host;

/// 「JS 还活着吗」：boot 跑完过，且最近一次心跳没超时。两个条件缺一不可——
/// 白屏时 js_ready 可能还是 true，但心跳早停了，这时不能再等它。
pub fn js_is_alive(js_ready: bool, since_beat: Duration) -> bool {
    js_ready && since_beat < EXIT_GRACE
}

/// 退出请求：JS 活着 → 让它提交编辑、写盘、调 exit_app；JS 死了/不答 → 直接退。
/// 重复调用（连点两次退出）只生效一次。
pub fn request(host: &Host) {
    if !crate::watchdog::begin_exit(host) {
        return;
    }
    let alive = crate::watchdog::js_alive(host);
    host.log(&format!("exit request (js alive = {})", alive));
    persist::save(host);
    if alive {
        let _ = host.app().emit("app-exit-request", ());
        let host2 = host.clone();
        std::thread::spawn(move || {
            std::thread::sleep(EXIT_GRACE);
            force(&host2, "js did not answer exit request");
        });
    } else {
        force(host, "webview is not answering");
    }
}

/// 真正退出：先走正常路径（事件循环返回 → main 结束），再不济直接结束进程。
/// 主线程若卡在某个 Win32 调用里，app.exit(0) 只会排队等不到，所以必须有后手。
pub fn force(host: &Host, why: &str) {
    persist::save(host);
    host.log(&format!("force exit: {}", why));
    host.app().exit(0);
    let host2 = host.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_GRACE);
        host2.log("force exit: event loop still alive, terminating process");
        std::process::exit(0);
    });
}

/// JS 先提交编辑、写盘，再调这里：保存 config 后整体退出（对齐 todo.pyw on_close 收尾）。
pub fn finish(host: &Host) {
    persist::save(host);
    host.log("exit");
    host.app().exit(0);
}

// ADR 0008：2026-11-13 白屏事故。「托盘退出不了」的根因是退出链全挂在 JS 上，
// 而白屏时 JS 已经死了 —— 所以判定必须能识破「曾经就绪、现在没心跳」。
#[cfg(test)]
mod exit_tests {
    use super::*;

    #[test]
    fn js_counts_as_alive_only_when_booted_and_beating() {
        assert!(js_is_alive(true, Duration::from_millis(500)), "boot 完成 + 心跳新鲜 = 可以等它提交编辑");
        assert!(!js_is_alive(true, Duration::from_secs(60)), "心跳停了（白屏）不能再等，必须直接退");
        assert!(!js_is_alive(false, Duration::from_millis(500)), "boot 没跑完就没有退出监听，等也没用");
        assert!(!js_is_alive(false, Duration::from_secs(60)));
    }

    #[test]
    fn exit_grace_is_short_enough_to_still_feel_like_quitting() {
        // 等 JS 再兜底的总时长必须明显短于「用户以为点了没反应」的耐心阈值
        assert!(EXIT_GRACE <= Duration::from_secs(3), "兜底等待超过 3 秒就会被当成卡死");
        assert!(EXIT_GRACE >= Duration::from_millis(500), "太快则正常的写盘 + 退出流程会被腰斩");
    }
}
