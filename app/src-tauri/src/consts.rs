//! 全局常量：进程级参数、退出与看门狗的宽限、托盘菜单 id。
//!
//! 全部集中在这里，避免同一个数字（如退出宽限）在判定与执行两处各写一遍后各改一半。

use std::time::Duration;

pub const APP_NAME: &str = "桌面待办";

/// #5777 workaround 参数（Win11 Build 26200 GPU/AudioService 沙箱崩溃循环）。
/// additional_browser_args 会覆盖 wry 默认值，故 msWebOOUI 等常规禁用项也要自带。
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,AudioServiceSandbox --no-sandbox --disable-gpu-sandbox";

/// 自动重启专用参数：新实例要等老进程把单实例锁放掉再接管。
pub const RESTART_ARG: &str = "--wait-mutex";

/// 退出宽限（ADR 0008）：JS 收到 app-exit-request 后要提交编辑、写盘再调 exit_app。
/// 写盘是 tmp+rename 的原子替换，所以到点强退不会写坏文件；等不到 JS 也必须退。
pub const EXIT_GRACE: Duration = Duration::from_millis(2500);

/// 看门狗阈值（ADR 0008）：页面连加载都没完成 → 12s；JS 起过但心跳停了 → 20s。
/// 正常启动慢盘/大文件也就几秒，取够宽松，宁可晚点救也不要误 reload 丢未提交编辑。
pub const WATCHDOG_LOAD_LIMIT: Duration = Duration::from_secs(12);
pub const WATCHDOG_BEAT_LIMIT: Duration = Duration::from_secs(20);
pub const WATCHDOG_MAX_RELOADS: u32 = 3;

/// 托盘菜单项 id（菜单构建与事件匹配共用，避免字符串两处各写一遍）。
pub const TRAY_SHOW: &str = "tray-show";
pub const TRAY_DOCK: &str = "tray-dock";
pub const TRAY_QUIT: &str = "tray-quit";

/// 长跑日志封顶：启动时超过这个字节数就清空，只留本次运行。
pub const LOG_MAX_BYTES: u64 = 200_000;
