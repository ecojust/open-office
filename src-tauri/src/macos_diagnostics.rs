//! Opt-in observations only. Production keeps Tauri's normal termination handler.
use crate::{server::AssetServer, smoke::Smoke};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSScreen, NSView, NSWindow};
use serde_json::json;
use tauri::Manager;

pub fn instrument(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    if std::env::var("OPEN_OFFICE_SMOKE").as_deref() != Ok("1")
        || std::env::var("OPEN_OFFICE_SMOKE_SCOPE").as_deref() != Ok("macos-editing")
    {
        return builder;
    }
    builder.on_web_content_process_terminate(|webview| {
        if let Some(server) = webview.try_state::<AssetServer>() {
            if let Some(smoke) = &server.smoke {
                smoke.note("web-content-terminated", webview.label());
            }
        }
        // Installing a hook replaces runtime-wry's default reload callback.
        // Preserve it: suppressing reload would change the reported symptom.
        let result = webview.reload();
        if let Some(server) = webview.try_state::<AssetServer>() {
            if let Some(smoke) = &server.smoke {
                smoke.note(
                    "web-content-reload-requested",
                    if result.is_ok() { "ok" } else { "error" },
                );
            }
        }
    })
}

pub fn record_geometry(window: &tauri::WebviewWindow, smoke: &Smoke) {
    if smoke.scope() != "macos-editing" {
        return;
    }
    let diagnostic = smoke.clone();
    let result = window.with_webview(move |platform| {
        let Some(mtm) = MainThreadMarker::new() else {
            diagnostic.note("editing-window-error", "not-main-thread");
            return;
        };
        // Tauri documents these platform handles as live WKWebView/NSWindow
        // pointers for this main-thread callback. WKWebView inherits NSView.
        let view: &NSView = unsafe { &*platform.inner().cast() };
        let window: &NSWindow = unsafe { &*platform.ns_window().cast() };
        let screens = NSScreen::screens(mtm);
        let Some(primary) = screens.firstObject() else {
            diagnostic.note("editing-window-error", "no-screen");
            return;
        };
        let bounds = view.bounds();
        let rect = window.convertRectToScreen(view.convertRect_toView(bounds, None));
        let primary = primary.frame();
        // AppKit screen coordinates have a lower-left origin; CGEvent uses the
        // upper-left of the primary display. These are points, not Retina pixels.
        let geometry = json!({"pid":std::process::id(),"windowId":window.windowNumber(),
            "x":rect.origin.x,"y":primary.origin.y + primary.size.height - rect.origin.y - rect.size.height,
            "width":rect.size.width,"height":rect.size.height,"scaleFactor":window.backingScaleFactor(),
            "coordinateSpace":"quartz-screen-points"});
        diagnostic.note("editing-window-geometry", &geometry.to_string());
    });
    if result.is_err() {
        smoke.note("editing-window-error", "platform-handle-unavailable");
    }
}
