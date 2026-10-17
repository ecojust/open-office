//! Native, user-initiated printing. PDF bytes never grant a filesystem
//! capability, and HTML printing always targets the prepared main webview.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

#[cfg(target_os = "macos")]
#[path = "printing_macos.rs"]
mod macos;
#[cfg(target_os = "windows")]
#[path = "printing_windows.rs"]
mod windows;

const PDF_LIMIT: usize = 64 * 1024 * 1024;
static PRINTING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize)]
pub struct PrintResult {
    pub status: &'static str,
}

struct PrintGuard;

impl PrintGuard {
    fn acquire() -> Result<Self, String> {
        PRINTING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "已有打印任务正在准备或显示，请完成后重试。".to_owned())?;
        Ok(Self)
    }
}

impl Drop for PrintGuard {
    fn drop(&mut self) {
        PRINTING.store(false, Ordering::Release);
    }
}

fn require_origin(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法确认打印窗口来源。")?;
    let server = app
        .try_state::<crate::server::AssetServer>()
        .ok_or("文档界面尚未准备完成。")?;
    if window.label() != "main"
        || !crate::server::AssetServer::allows_navigation(&server.info, &url)
    {
        return Err("打印仅可由当前桌面工作区发起。".into());
    }
    Ok(())
}

fn pdf_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > PDF_LIMIT.div_ceil(3) * 4 {
        return Err("打印文件不能超过 64 MB。".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "打印文件编码无效。")?;
    if bytes.len() > PDF_LIMIT {
        return Err("打印文件不能超过 64 MB。".into());
    }
    if !bytes.starts_with(b"%PDF-") || bytes.len() < 12 {
        return Err("打印内容不是有效的 PDF 文档。".into());
    }
    Ok(bytes)
}

fn job_title(value: &str) -> String {
    let value: String = value
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect();
    let value = value.trim();
    if value.is_empty() {
        "文档打印".into()
    } else {
        value.into()
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
enum Progress {
    Started,
    Finished(Result<PrintResult, String>),
}

/// A queued callback must begin promptly. Once the native dialog is shown,
/// the user controls its duration; do not destroy print data on a timer while
/// the system is still using it. A destroyed window or dropped callback ends
/// the wait, including shutdown while a print is being prepared.
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn wait_for_print(
    app: tauri::AppHandle,
    receiver: std::sync::mpsc::Receiver<Progress>,
    cancelled: std::sync::Arc<AtomicBool>,
) -> Result<PrintResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut started = false;
        loop {
            match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
                Ok(Progress::Started) => started = true,
                Ok(Progress::Finished(result)) => return result,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("打印任务已中止，请重试。".into());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if app.get_webview_window("main").is_none() {
                cancelled.store(true, Ordering::Release);
                return Err("文档窗口已关闭，打印已取消。".into());
            }
            if !started && std::time::Instant::now() >= deadline {
                cancelled.store(true, Ordering::Release);
                return Err("系统打印窗口未能及时启动，请稍后重试。".into());
            }
        }
    })
    .await
    .map_err(|_| "打印任务未能完成。".to_owned())?
}

#[tauri::command]
pub async fn print_pdf(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    base64: String,
    title: String,
) -> Result<PrintResult, String> {
    require_origin(&app, &window)?;
    let guard = PrintGuard::acquire()?;
    let bytes = pdf_bytes(&base64)?;
    let title = job_title(&title);
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let owner = app.clone();
        app.run_on_main_thread(move || {
            let _guard = guard;
            if stop.load(Ordering::Acquire) {
                return;
            }
            let _ = sender.send(Progress::Started);
            let result =
                require_origin(&owner, &window).and_then(|_| macos::print_pdf(&bytes, &title));
            let _ = sender.send(Progress::Finished(result));
        })
        .map_err(|_| "无法启动系统打印窗口。")?;
        wait_for_print(app, receiver, cancelled).await
    }
    #[cfg(target_os = "windows")]
    {
        // Window creation must originate outside a UI/COM event callback on
        // Windows. The builder dispatches creation itself; only ShowPrintUI
        // belongs in with_webview. File preparation also stays off the UI thread.
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            require_origin(&app, &window)?;
            windows::print_pdf(app, bytes, title)
        })
        .await
        .map_err(|_| "无法完成打印预览准备。".to_owned())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (guard, bytes, title);
        Err("当前桌面平台尚未接入系统打印，请先导出 PDF 后使用系统打印功能。".into())
    }
}

#[tauri::command]
pub async fn print_html(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<PrintResult, String> {
    require_origin(&app, &window)?;
    let guard = PrintGuard::acquire()?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let owner = app.clone();
        let original = window.clone();
        window
            .with_webview(move |platform| {
                let _guard = guard;
                if stop.load(Ordering::Acquire) {
                    return;
                }
                let _ = sender.send(Progress::Started);
                let result = require_origin(&owner, &original).and_then(|_| {
                    #[cfg(target_os = "macos")]
                    {
                        macos::print_html(platform.inner())
                    }
                    #[cfg(target_os = "windows")]
                    {
                        windows::show_print_ui(platform).map(|_| PrintResult { status: "opened" })
                    }
                });
                let _ = sender.send(Progress::Finished(result));
            })
            .map_err(|_| "无法访问文档打印视图。")?;
        wait_for_print(app, receiver, cancelled).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = guard;
        Err("当前桌面平台尚未接入系统打印。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_pdf_bytes() {
        let pdf = b"%PDF-1.7\n%%EOF\n";
        assert_eq!(pdf_bytes(&STANDARD.encode(pdf)).unwrap(), pdf);
        assert!(pdf_bytes("not base64").is_err());
        assert!(pdf_bytes(&STANDARD.encode(b"<html>hello</html>")).is_err());
        assert!(pdf_bytes(&STANDARD.encode(b"%PDF-1")).is_err());
        assert!(pdf_bytes(&"A".repeat(PDF_LIMIT.div_ceil(3) * 4 + 1)).is_err());
    }

    #[test]
    fn print_titles_are_bounded_plain_text() {
        assert_eq!(job_title("\n \0"), "文档打印");
        assert_eq!(job_title(" 示例\n.pdf "), "示例.pdf");
        assert_eq!(job_title(&"图".repeat(200)).chars().count(), 160);
    }
}
