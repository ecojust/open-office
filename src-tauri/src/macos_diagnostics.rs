//! Opt-in observations only. Production keeps Tauri's normal termination handler.
use crate::{server::AssetServer, smoke::Smoke};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSScreen, NSView, NSWindow};
use serde_json::{json, Value};
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
    sample_geometry(window, smoke, None);
}

pub fn record_input_geometry(window: &tauri::WebviewWindow, smoke: &Smoke, request: Value) {
    sample_geometry(window, smoke, Some(request));
}

fn sample_geometry(window: &tauri::WebviewWindow, smoke: &Smoke, request: Option<Value>) {
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
        // This optional private read-only selector identifies this WKWebView's
        // process. Never infer ownership from a WebContent name or parent PID.
        // Only the explicitly opted-in diagnostic reaches this callback.
        // WebKit WKWebViewPrivate.h declares this property as pid_t (i32):
        // https://github.com/WebKit/WebKit/blob/f38c61096af22dabaf3a5e97242e513c71f29c1e/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h#L226
        let supports_process_id: bool = unsafe {
            msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)]
        };
        let web_content_pid: Option<i32> = if supports_process_id {
            let pid: i32 = unsafe { msg_send![view, _webProcessIdentifier] };
            (pid > 0 && pid as u32 != std::process::id()).then_some(pid)
        } else {
            None
        };
        let screens = NSScreen::screens(mtm);
        let Some(primary) = screens.firstObject() else {
            diagnostic.note("editing-window-error", "no-screen");
            return;
        };
        let bounds = view.bounds();
        let rect = window.convertRectToScreen(view.convertRect_toView(bounds, None));
        let primary = primary.frame();
        let visible = view.visibleRect();
        let safe = view.safeAreaRect();
        let frame = view.frame();
        let window_frame = window.frame();
        let content_bounds = window.contentView().map(|content| content.bounds());
        let layout = window.contentLayoutRect();
        let layout_screen = window.convertRectToScreen(layout);
        let visible_screen = window.convertRectToScreen(view.convertRect_toView(visible, None));
        let safe_screen = window.convertRectToScreen(view.convertRect_toView(safe, None));
        let insets = view.safeAreaInsets();
        let top = primary.origin.y + primary.size.height;
        let bound_points = [rect.origin.x, top - rect.origin.y - rect.size.height, rect.size.width, rect.size.height];
        let layout_points = [layout_screen.origin.x, top - layout_screen.origin.y - layout_screen.size.height, layout_screen.size.width, layout_screen.size.height];
        let intersect_x = bound_points[0].max(layout_points[0]);
        let intersect_y = bound_points[1].max(layout_points[1]);
        let layout_intersection = [intersect_x, intersect_y,
            ((bound_points[0] + bound_points[2]).min(layout_points[0] + layout_points[2]) - intersect_x).max(0.0),
            ((bound_points[1] + bound_points[3]).min(layout_points[1] + layout_points[3]) - intersect_y).max(0.0)];
        // AppKit screen coordinates have a lower-left origin; CGEvent uses the
        // upper-left of the primary display. These are points, not Retina pixels.
        let geometry = json!({"actionId":request.as_ref().and_then(|value|value.get("actionId")),
            "viewport":request.as_ref().map(|value|json!({"width":value["viewportWidth"],"height":value["viewportHeight"]})),
            "pid":std::process::id(),"windowId":window.windowNumber(),
            "webContent":{"pid":web_content_pid,"supported":supports_process_id,
                "source":"WKWebView._webProcessIdentifier"},
            "x":rect.origin.x,"y":primary.origin.y + primary.size.height - rect.origin.y - rect.size.height,
            "width":rect.size.width,"height":rect.size.height,"scaleFactor":window.backingScaleFactor(),
            "bounds":[bounds.origin.x,bounds.origin.y,bounds.size.width,bounds.size.height],
            "visibleRect":[visible.origin.x,visible.origin.y,visible.size.width,visible.size.height],
            "safeAreaRect":[safe.origin.x,safe.origin.y,safe.size.width,safe.size.height],
            "frame":[frame.origin.x,frame.origin.y,frame.size.width,frame.size.height],
            "windowFrame":[window_frame.origin.x,window_frame.origin.y,window_frame.size.width,window_frame.size.height],
            "contentViewBounds":content_bounds.map(|rect|[rect.origin.x,rect.origin.y,rect.size.width,rect.size.height]),
            "windowContentLayoutRect":[layout.origin.x,layout.origin.y,layout.size.width,layout.size.height],
            "layoutOnScreen":layout_points,
            "candidates":{
                "bounds":bound_points,
                "visibleRect":[visible_screen.origin.x,top - visible_screen.origin.y - visible_screen.size.height,visible_screen.size.width,visible_screen.size.height],
                "safeAreaRect":[safe_screen.origin.x,top - safe_screen.origin.y - safe_screen.size.height,safe_screen.size.width,safe_screen.size.height],
                "contentLayoutIntersection":layout_intersection},
            "safeAreaInsets":[insets.top,insets.left,insets.bottom,insets.right],
            "coordinateSpace":"quartz-screen-points"});
        diagnostic.note("editing-window-geometry", &geometry.to_string());
    });
    if result.is_err() {
        smoke.note("editing-window-error", "platform-handle-unavailable");
    }
}
