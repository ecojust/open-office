//! Windows printing for the prepared document layer and isolated PDF previews.

use std::{
    fs,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, PlatformWebview},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
};
use windows_core::Interface;

static NEXT_PREVIEW: AtomicU64 = AtomicU64::new(1);

/// Invoke inside `with_webview`; the caller receives the real native result
/// through its asynchronous command channel, never by blocking the UI thread.
pub fn show_print_ui(platform: PlatformWebview) -> Result<(), String> {
    // SAFETY: Tauri supplies the live controller on its owning UI thread. The
    // checked interface cast rejects runtimes that do not support printing.
    let view = unsafe { platform.controller().CoreWebView2() }
        .map_err(|error| format!("无法取得打印窗口：{error}"))?;
    let printable = view
        .cast::<ICoreWebView2_16>()
        .map_err(|error| format!("当前系统组件不支持原生打印，请更新系统组件：{error}"))?;
    // SAFETY: the interface was queried successfully on the controller thread.
    // Success means the print UI opened, not that the user printed a document.
    unsafe { printable.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM) }
        .map_err(|error| format!("无法打开系统打印窗口：{error}"))
}

fn same_pdf(url: &Url, expected: &Url) -> bool {
    let mut without_fragment = url.clone();
    without_fragment.set_fragment(None);
    without_fragment == *expected
}

fn preview_title(title: &str) -> String {
    let title: String = title
        .chars()
        .filter(|ch| !ch.is_control())
        .take(120)
        .collect();
    let title = title.trim();
    if title.is_empty() {
        "打印预览 · 使用工具栏打印".into()
    } else {
        format!("{title} · 打印预览 · 使用工具栏打印")
    }
}

fn remove_preview(directory: tempfile::TempDir) {
    // The native PDF viewer may release its file handle shortly after Destroyed.
    // Keep the temporary owner until then; never delete a pending print job when
    // ShowPrintUI returns, because Windows does not expose its completion here.
    std::thread::spawn(move || {
        let path = directory.path().to_path_buf();
        if directory.close().is_ok() {
            return;
        }
        for _ in 0..30 {
            std::thread::sleep(Duration::from_millis(100));
            match fs::remove_dir_all(&path) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) => {}
            }
        }
    });
}

/// Called on a worker thread after the shared command validates the PDF bytes.
/// The builder performs its own UI dispatch; wrapping it in a UI event callback
/// risks nested native window creation on Windows.
/// Only this generated PDF is navigable; the preview has no command capability.
pub fn print_pdf(
    app: AppHandle,
    bytes: Vec<u8>,
    title: String,
) -> Result<super::PrintResult, String> {
    if app.get_webview_window("main").is_none() {
        return Err("文档窗口已关闭，打印已取消。".into());
    }
    let directory = tempfile::Builder::new()
        .prefix("open-office-print-")
        .tempdir()
        .map_err(|error| format!("无法创建打印预览目录：{error}"))?;
    let path = directory.path().join("document.pdf");
    fs::write(&path, bytes).map_err(|error| format!("无法准备打印预览：{error}"))?;
    let url = Url::from_file_path(&path).map_err(|_| "无法创建打印预览地址".to_string())?;
    let allowed = url.clone();
    let loaded_pdf = url.clone();
    let requested = Arc::new(AtomicBool::new(false));
    let label = format!(
        "print-preview-{}",
        NEXT_PREVIEW.fetch_add(1, Ordering::Relaxed)
    );
    // The main workspace may close while the PDF is being written.
    let main = app
        .get_webview_window("main")
        .ok_or("文档窗口已关闭，打印已取消。")?;
    super::require_origin(&app, &main)?;
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(preview_title(&title))
        .inner_size(1040.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .focused(true)
        .devtools(false)
        .drag_and_drop(false)
        .on_navigation(move |next| same_pdf(next, &allowed))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished
                || !same_pdf(payload.url(), &loaded_pdf)
                || requested.swap(true, Ordering::AcqRel)
            {
                return;
            }
            // Load may precede the PDF viewer's readiness. Keep the visible PDF
            // toolbar available as a retry path instead of assuming it printed.
            let failed_window = window.clone();
            if window
                .with_webview(move |platform| {
                    if show_print_ui(platform).is_err() {
                        let _ =
                            failed_window.set_title("打印预览 · 系统打印未打开，请使用工具栏打印");
                    }
                })
                .is_err()
            {
                let _ = window.set_title("打印预览 · 系统打印未打开，请使用工具栏打印");
            }
        })
        .build()
        .map_err(|error| format!("无法打开打印预览：{error}"))?;
    // Construction failures above drop the directory immediately. Successful
    // previews retain it until destroyed, including while their dialog is open.
    let resource = Mutex::new(Some(directory));
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(mut resource) = resource.lock() {
                if let Some(directory) = resource.take() {
                    remove_preview(directory);
                }
            }
        }
    });
    // Construction dispatch can race with application shutdown. Register the
    // cleanup first so destroying a late preview also releases its PDF file.
    if app.get_webview_window("main").is_none() {
        let _ = window.destroy();
        return Err("文档窗口已关闭，打印已取消。".into());
    }
    Ok(super::PrintResult { status: "opened" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_navigation_allows_only_its_pdf_and_page_fragments() {
        let expected =
            Url::parse("file:///C:/Users/test/AppData/Local/Temp/job/document.pdf").unwrap();
        assert!(same_pdf(&expected, &expected));
        assert!(same_pdf(&expected.join("#page=2").unwrap(), &expected));
        for candidate in [
            "file:///C:/Users/test/AppData/Local/Temp/job/",
            "file:///C:/Users/test/AppData/Local/Temp/secret.pdf",
            "file:///C:/Users/test/AppData/Local/Temp/job/document.pdf?other=1",
            "https://example.com/document.pdf",
            "javascript:window.print()",
        ] {
            assert!(!same_pdf(&Url::parse(candidate).unwrap(), &expected));
        }
    }

    #[test]
    fn preview_title_does_not_accept_control_characters_or_unbounded_names() {
        assert_eq!(preview_title("\n\r\t"), "打印预览 · 使用工具栏打印");
        assert_eq!(
            preview_title(" 报告\n "),
            "报告 · 打印预览 · 使用工具栏打印"
        );
        assert_eq!(
            preview_title(&"字".repeat(200))
                .chars()
                .take_while(|ch| *ch == '字')
                .count(),
            120
        );
    }
}
