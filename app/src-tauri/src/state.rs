//! 共享状态的唯一句柄。
//!
//! #17 之前，四十多处代码各自 `app.state::<Mutex<Shared>>().lock().unwrap()` 穿过一个大巴状态；
//! 现在命令层与维护层只拿一个 `Host`，用语义化方法说话，锁与字段留在模块内部。
//!
//! 状态按所有者分家：进程事实（exe 目录、日志、测试模式、当前文件）在 `AppEnv` 里；
//! 模式在 `dock`，看门狗在 `watchdog`，退出在 `exit`，托盘通道在 `tray`。谁的状态谁上锁。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::dialog;
use crate::files::FileIdentity;
use crate::win32;

/// 进程级事实 + 当前文件：启动时定下来，之后只换文件。
///
/// 名字刻意不叫 `Shared`：它只装「这次运行的事实」，不装任何模块的状态。
/// 新加一个字段前先问「它的所有者是谁」，能放进自己模块就别放这里。
pub struct AppEnv {
    exe_dir: PathBuf,
    /// config.json 记的当前文件：身份的唯一来源（#12）。
    file: Mutex<PathBuf>,
    testing: bool,
    log_path: Option<PathBuf>,
    /// Moved/Resized 置位，维护轮询里统一落盘（≈Tk 拖完松手保存）。
    dirty_config: AtomicBool,
    /// 「程序目录不可写」只提示一次。
    ro_warned: AtomicBool,
}

impl AppEnv {
    pub fn new(exe_dir: PathBuf, file: PathBuf, testing: bool, log_path: Option<PathBuf>) -> Self {
        Self {
            exe_dir,
            file: Mutex::new(file),
            testing,
            log_path,
            dirty_config: AtomicBool::new(false),
            ro_warned: AtomicBool::new(false),
        }
    }
}

/// 命令层与维护层唯一的入口：拿到它就等于拿到整个应用，但看不到锁。
#[derive(Clone)]
pub struct Host {
    app: AppHandle,
}

impl Host {
    pub fn of(app: &AppHandle) -> Self {
        Self { app: app.clone() }
    }

    /// same-instance 入口：`Host::of(app_handle)` 的简写（事件回调里常见）。
    pub fn from_window(win: &impl Manager<tauri::Wry>) -> Self {
        Self::of(win.app_handle())
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// 某个模块自己的托管状态（谁的状态谁上锁，这里只做路由）。
    pub fn state<T: Send + Sync + 'static>(&self) -> tauri::State<'_, T> {
        self.app.state::<T>()
    }

    pub fn window(&self, label: &str) -> Option<tauri::WebviewWindow> {
        self.app.get_webview_window(label)
    }

    fn env(&self) -> tauri::State<'_, AppEnv> {
        self.app.state::<AppEnv>()
    }

    // ---- 进程事实 ----

    pub fn exe_dir(&self) -> PathBuf {
        self.env().exe_dir.clone()
    }

    pub fn testing(&self) -> bool {
        self.env().testing
    }

    /// 当前文件（身份的唯一来源）。命令不读它猜目标——目标永远由调用方显式带路径。
    pub fn file(&self) -> PathBuf {
        self.env().file.lock().unwrap().clone()
    }

    /// 换掉当前文件：唯一所有者换人，同时把新身份当场回传（choose_file / new_md_file 共用）。
    pub fn replace_file(&self, path: PathBuf) -> FileIdentity {
        let identity = FileIdentity::of(&path);
        *self.env().file.lock().unwrap() = path;
        identity
    }

    // ---- 日志 ----

    pub fn log(&self, msg: &str) {
        let line = format!("[{}] {}", win32::now_hms(), msg);
        match &self.env().log_path {
            Some(p) => {
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                    let _ = writeln!(f, "{}", line);
                }
            }
            None => eprintln!("{}", line),
        }
    }

    /// 写盘失败：只有「目录/文件不可写」这一类才弹那个「把文件夹移到可写位置」的框。
    /// 其余失败（磁盘满、目标被别的程序占用、路径不合法）各自处置办法不同，
    /// 一律套上「程序目录不可写」只会把人带偏——它们交给界面上那条提示条（#18）。
    pub fn warn_readonly(&self, msg: &str) {
        if !crate::files::is_permission_failure(msg) {
            self.log(&format!("write failed: {}", msg));
            return;
        }
        let env = self.env();
        if env.testing {
            return;
        }
        if env.ro_warned.swap(true, Ordering::Relaxed) {
            return;
        }
        let exe_dir = env.exe_dir.clone();
        drop(env);
        dialog::show(
            dialog::Level::Warning,
            &format!(
                "程序目录不可写，设置和待办改动无法保存：\n{}\n({})\n\n请把整个文件夹移动到可写目录使用（如桌面、D 盘），不要放在 Program Files 或其他只读位置。",
                exe_dir.display(),
                msg
            ),
        );
        self.log(&format!("write failed: {}", msg));
    }

    // ---- 待落盘的 config ----

    pub fn mark_config_dirty(&self) {
        self.env().dirty_config.store(true, Ordering::Relaxed);
    }

    /// 取走「有改动」的标志：有人取走就由他负责落盘，不会两个线程各写一遍。
    pub fn take_config_dirty(&self) -> bool {
        self.env().dirty_config.swap(false, Ordering::Relaxed)
    }
}
