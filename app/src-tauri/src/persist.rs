//! config 落盘：把当前文件、几何、两态收成一份 Config 写回去。
//!
//! 唯一的写路径（启动、切模式、退出、维护轮询都走这里），调用方只说「现在该落盘了」。

use crate::config::Config;
use crate::state::Host;

/// 立刻落盘。测试模式从不读 config.json，也绝不写它：
/// 写它只有一个后果——跑一次探针就把用户真实部署的配置改成测试文件（实测踩过一次）。
pub fn save(host: &Host) {
    if host.testing() {
        host.log("test mode: config.json not written");
        return;
    }
    // 几何取 client 语义（Tk winfo）；无框窗口的 outer 含隐形边，拿它记账会每轮启动膨胀。
    let Some(win) = host.window("main") else { return };
    let Some(frame) = crate::win32::client_rect(&win) else { return };
    let cfg = Config {
        file: host.file().to_string_lossy().into_owned(),
        x: Some(frame.x as i64),
        y: Some(frame.y as i64),
        w: Some(frame.w as i64),
        h: Some(frame.h as i64),
        docked: crate::dock::is_docked(host),
    };
    if let Err(e) = cfg.save(&host.exe_dir()) {
        host.warn_readonly(&e);
    }
}

/// 维护轮询里的「配置落盘」那一步：只有 Moved/Resized 攒下改动时才写。
pub fn flush_if_dirty(host: &Host) {
    if host.take_config_dirty() {
        save(host);
    }
}
