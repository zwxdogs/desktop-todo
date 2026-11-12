// WebView2 全流程探针 v2：隐藏窗口 → 环境创建 → Controller（强制浏览器进程拉起）。
// 变体：argv[1]=args,lang（默认 args,lang=复刻 wry）；argv[2]=udf（"null"=loader 默认）。
// 目的：区分「环境对象创建成功但浏览器拉不起」与「wry/tauri 上下文特有失败」。
use std::sync::mpsc;

use webview2_com::{
    wait_with_pump, CoreWebView2EnvironmentOptions, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, Microsoft::Web::WebView2::Win32::*,
};
use windows::{
    core::{PCWSTR, Result},
    Win32::{
        Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName, MAX_LOCALE_NAME, LOCALE_ALLOW_NEUTRAL_NAMES},
        System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
            RegisterClassW, TranslateMessage, CW_USEDEFAULT, HMENU, MSG, WINDOW_EX_STYLE,
            WINDOW_STYLE, WM_APP, WNDCLASSW,
        },
    },
};

// 唤醒可能阻塞的 GetMessage。
const WM_PROBE_KICK: u32 = WM_APP + 7;

static mut PROBE_HWND: isize = 0;

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        if msg == WM_PROBE_KICK {
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let variant = argv.get(1).cloned().unwrap_or_else(|| "args,lang".into());
    let udf = argv.get(2).cloned().unwrap_or_default();
    let udfw: Vec<u16> = if udf.is_empty() || udf == "null" {
        println!("udf=<null - loader default>");
        Vec::new()
    } else {
        // 注意：不删目录——复刻 spike 真实条件（目录已存在）。
        let _ = std::fs::create_dir_all(&udf);
        println!("udf={udf}");
        udf.encode_utf16().chain(std::iter::once(0)).collect()
    };

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        println!("CoInitializeEx: {:?}", hr.ok());
    }

    // 1) 普通隐藏窗口（Controller 需要真实顶层窗口）。
    let class_name: Vec<u16> = "wvprobe_full\0".encode_utf16().collect();
    let hwnd = unsafe {
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            lpszClassName: PCWSTR::from_raw(class_name.as_ptr()),
            hInstance: HINSTANCE::default(),
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            println!("RegisterClassW FAILED");
            return;
        }
        match CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR::from_raw(class_name.as_ptr()),
            windows::core::w!("wvprobe full"),
            WINDOW_STYLE(0x00C0_0000), // WS_OVERLAPPEDWINDOW
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            500,
            400,
            None,
            None,
            Some(HINSTANCE::default()),
            None,
        ) {
            Ok(h) => h,
            Err(_) => {
                println!("CreateWindowExW FAILED");
                return;
            }
        }
    };
    unsafe { PROBE_HWND = hwnd.0 as isize };
    println!("window OK");

    // 2) 环境创建（复刻 wry 参数）。
    let (tx, rx) = mpsc::channel::<Result<ICoreWebView2Environment>>();
    let options = CoreWebView2EnvironmentOptions::default();
    let opts: ICoreWebView2EnvironmentOptions = unsafe {
        if variant.contains("args") {
            options.set_additional_browser_arguments(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string(),
            );
        }
        if let Some(rest) = variant.strip_prefix("customargs:") {
            options.set_additional_browser_arguments(rest.to_string());
        }
        if variant.contains("lang") {
            let lcid = GetUserDefaultUILanguage();
            let mut lang = [0u16; MAX_LOCALE_NAME as usize];
            LCIDToLocaleName(lcid as u32, Some(&mut lang), LOCALE_ALLOW_NEUTRAL_NAMES);
            let name = String::from_utf16_lossy(&lang);
            let name = name.trim_end_matches('\0').to_string();
            println!("lang={name}");
            options.set_language(name);
        }
        if let Some(rest) = variant.strip_prefix("langx:") {
            println!("langx={rest}");
            options.set_language(rest.to_string());
        }
        options.set_are_browser_extensions_enabled(false);
        options.set_scroll_bar_style(COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT);
        options.into()
    };
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |error_code, environment| {
            let result = (|| -> Result<ICoreWebView2Environment> {
                error_code?;
                environment.ok_or_else(|| windows::core::Error::from(E_POINTER))
            })();
            match &result {
                Ok(_) => println!("handler: environment OK"),
                Err(e) => println!("handler ENV FAILED hr=0x{:08X} msg={}", e.code().0, e),
            }
            let _ = tx.send(result);
            unsafe { kick() };
            Ok(())
        },
    ));
    unsafe {
        let udf_ptr = if udfw.is_empty() {
            PCWSTR::null()
        } else {
            PCWSTR::from_raw(udfw.as_ptr())
        };
        match CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), udf_ptr, &opts, &handler) {
            Ok(()) => println!("env immediate call: ok"),
            Err(e) => println!("env immediate FAILED hr=0x{:08X} msg={}", e.code().0, e),
        }
    }

    let env = match wait_with_pump(rx) {
        Ok(Ok(e)) => {
            println!("ENV OK");
            e
        }
        Ok(Err(e)) => {
            println!("ENV FAILED hr=0x{:08X} msg={}", e.code().0, e);
            println!("--- variant [{variant}] udf=({udf}) done: ENV-FAIL ---");
            return;
        }
        Err(e) => {
            println!("PUMP FAILED {e:?}");
            return;
        }
    };

    // 3) Controller 创建（强制浏览器进程 + EBWebView 落地）。
    //    WebView2 对「隐藏父窗口」的 controller 创建有兼容性限制——先显示窗口再创建。
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
            hwnd,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        );
    }
    let (tx2, rx2) = mpsc::channel::<Result<ICoreWebView2Controller>>();
    let handler2 = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |error_code, controller| {
            let result = (|| -> Result<ICoreWebView2Controller> {
                error_code?;
                controller.ok_or_else(|| windows::core::Error::from(E_POINTER))
            })();
            match &result {
                Ok(_) => println!("handler: controller OK"),
                Err(e) => println!("handler CTRL FAILED hr=0x{:08X} msg={}", e.code().0, e),
            }
            let _ = tx2.send(result);
            unsafe { kick() };
            Ok(())
        },
    ));
    unsafe {
        match env.CreateCoreWebView2Controller(hwnd, &handler2) {
            Ok(()) => println!("ctrl immediate call: ok"),
            Err(e) => println!("ctrl immediate FAILED hr=0x{:08X} msg={}", e.code().0, e),
        }
    }

    match wait_with_pump(rx2) {
        Ok(Ok(ctrl)) => {
            unsafe {
                let _ = ctrl.SetBounds(RECT {
                    left: 0,
                    top: 0,
                    right: 500,
                    bottom: 400,
                });
            }
            println!("CONTROLLER OK");
            println!("--- variant [{variant}] udf=({udf}) done: FULL-OK ---");
        }
        Ok(Err(e)) => {
            println!("CONTROLLER FAILED hr=0x{:08X} msg={}", e.code().0, e);
            println!("--- variant [{variant}] udf=({udf}) done: CTRL-FAIL ---");
        }
        Err(e) => println!("PUMP2 FAILED {e:?}"),
    }
}

unsafe fn kick() {
    if PROBE_HWND != 0 {
        let _ = PostMessageW(Some(HWND(PROBE_HWND as *mut core::ffi::c_void)), WM_PROBE_KICK, WPARAM(0), LPARAM(0));
    }
}
