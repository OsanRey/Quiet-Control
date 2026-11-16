// Quiet Control is a GUI application, including portable research/debug builds.
// Diagnostics remain available in the application's file logs.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some("--proxy-recovery-watchdog") {
            let code = args.get(2).and_then(|s| s.parse::<u32>().ok())
                .map(satelite_proxy_lib::run_proxy_recovery_watchdog).unwrap_or(2);
            std::process::exit(code);
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let runtime = dir.join("webview-runtime");
                if runtime.join("msedgewebview2.exe").is_file() {
                    std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", runtime);
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    apply_webkitgtk_workarounds();
    satelite_proxy_lib::run()
}

// WebKitGTK ≥2.42 的 DMA-BUF 渲染器在部分 Wayland/Mesa/NVIDIA 栈上创建 surfaceless EGL
// display 会得到 EGL_BAD_ALLOC 并在 Web 进程里直接 abort（应用闪退、日志仅剩该行）。
// 默认退回传统渲染路径；用户已显式设置同名变量时不覆盖，留出手动调参出口。
#[cfg(target_os = "linux")]
fn apply_webkitgtk_workarounds() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}
