// Tauri 2 spike：贴桌面（Z 序压底）+ 任务栏可见 + 行保真文件读写。
// 关键决策：
// - 不调 set_skip_taskbar（用户要求进任务栏；跳过即天然规避 #10422）。
// - always-on-bottom：窗口创建后 set_always_on_bottom(true)，且失焦时重新压底。
//   创建时 focus:false，规避 #9597（创建即上浮）。
// - Win32 兜底直接声明 user32 FFI，不引入额外 crate。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent};

const HWND_BOTTOM: isize = 1;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
// #5777 workaround 参数。additional_browser_args 会覆盖 wry 默认值，
// 故 msWebOOUI 等常规禁用项也要自带。
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,AudioServiceSandbox --no-sandbox --disable-gpu-sandbox";

#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(
        hwnd: isize,
        hwnd_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn GetForegroundWindow() -> isize;
}

// 把窗口压到 Z 序最底（桌面之上）。
fn pin_bottom(hwnd: isize) {
    unsafe {
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

// always-on-bottom + Win32 兜底，创建后与每次失焦都要做一遍。
// setup 拿到的是 WebviewWindow，on_window_event 拿到的是 Window，
// 两者都提供 set_always_on_bottom/hwnd，用本地 trait 统一入口。
trait Repin {
    fn repin(&self);
}
impl Repin for tauri::Window {
    fn repin(&self) {
        let _ = self.set_always_on_bottom(true);
        if let Ok(h) = self.hwnd() {
            pin_bottom(h.0 as isize);
        }
    }
}
impl Repin for tauri::WebviewWindow {
    fn repin(&self) {
        let _ = self.set_always_on_bottom(true);
        if let Ok(h) = self.hwnd() {
            pin_bottom(h.0 as isize);
        }
    }
}

#[tauri::command]
fn initial_file() -> String {
    // 优先环境变量；否则取 exe 旁的 sample.md（计划任务/exe 直启都能拿到内容）。
    if let Ok(p) = std::env::var("DT_SPIKE_FILE") {
        if !p.is_empty() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("sample.md");
            if p.exists() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    String::new()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("utf8: {e}"))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("write: {e}"))
}

#[tauri::command]
fn log_line(msg: String) {
    eprintln!("[spike] {msg}");
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![initial_file, read_file, write_file, log_line])
        .setup(|app| {
            eprintln!("[spike] setup entered");
            match app.path().app_local_data_dir() {
                Ok(p) => {
                    let s = p.display().to_string();
                    let exists = p.exists();
                    eprintln!("[spike] app_local_data_dir={s} exists={exists}");
                }
                Err(e) => eprintln!("[spike] app_local_data_dir resolve FAILED: {e}"),
            }
            use std::error::Error as _;
            // UDF：exe 旁的 udf/（复刻 WebView2 loader 默认布局 <exe>.exe.WebView2）。
            // 不用 app_local_data_dir：本机 %LOCALAPPDATA% 部分子树对受限 token 不可写，
            // 且 loader 对显式 UDF 需要目录可创建（wvprobe 实验矩阵结论）。
            let udf = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("udf")));
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("桌面待办 spike")
            .inner_size(380.0, 640.0)
            .focused(false)
            .decorations(false);
            // Win11 Build 26200 已知 bug（WebView2Feedback #5777 / Chromium 577213782）：
            // GPU/AudioService 子进程在 Chromium 沙箱内崩溃循环（STATUS_BREAKPOINT），
            // 浏览器随后自杀 → controller 失败。
            let win = if let Some(d) = udf {
                let ds = d.display().to_string();
                eprintln!("[spike] data_directory={ds}");
                let _ = std::fs::create_dir_all(&d);
                win.data_directory(d)
            } else {
                win
            };
            let win = win.additional_browser_args(BROWSER_ARGS).build();
            let win = match win {
                Ok(w) => {
                    eprintln!("[spike] window+webview built OK");
                    w
                }
                Err(e) => {
                    eprintln!("[spike] build FAILED debug={e:?}");
                    let mut src: Option<&(dyn std::error::Error + 'static)> = e.source();
                    while let Some(s) = src {
                        eprintln!("[spike]   caused by: {s}");
                        src = s.source();
                    }
                    return Err(e.into());
                }
            };
            let hwnd_dbg = win.hwnd().map(|h| h.0 as isize).unwrap_or(-1);
            eprintln!("[spike] hwnd={hwnd_dbg}");
            // #9597 workaround：创建时不抢焦点，随后压底才不会被"创建即置顶"顶回来。
            win.repin();
            eprintln!("[spike] pinned bottom, skip_taskbar=0");
            Ok(())
        })
        .on_window_event(|win, event| {
            if let WindowEvent::Focused(false) = event {
                // 编辑完成/失焦后重新压底，保证"普通窗口之下"始终成立。
                win.repin();
                let fg = unsafe { GetForegroundWindow() };
                eprintln!("[spike] blurred -> repinned bottom (fg now={fg})");
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
