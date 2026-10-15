//! Configure WebKit's public compatibility mode before the first navigation.
use crate::smoke::Smoke;
use objc2::{msg_send, rc::Retained, sel, MainThreadMarker};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration, WKWebpagePreferences};
use serde_json::json;

// WKSecurityRestrictionMode is NS_ENUM(NSInteger), available from macOS 26.4.
// objc2-web-kit 0.3.2 predates these public accessors, so call their selectors
// after checking runtime support. Do not use private JSC preferences or KVC.
// https://developer.apple.com/documentation/webkit/wkwebpagepreferences/securityrestrictionmode
const NONE: isize = 0;
const MAXIMIZE_COMPATIBILITY: isize = 1;
const LOCKDOWN: isize = 2;

fn supported(preferences: &WKWebpagePreferences) -> bool {
    // SAFETY: NSObject's selector query is available on all supported macOS
    // versions; it does not invoke either potentially unavailable accessor.
    unsafe {
        let getter: bool =
            msg_send![preferences, respondsToSelector: sel!(securityRestrictionMode)];
        let setter: bool =
            msg_send![preferences, respondsToSelector: sel!(setSecurityRestrictionMode:)];
        getter && setter
    }
}

fn note(smoke: Option<&Smoke>, stage: &str, supported: bool, actual: Option<isize>, action: &str) {
    if let Some(smoke) = smoke {
        smoke.note(
            "editing-webkit-policy",
            &json!({"source":"WKWebpagePreferences.securityRestrictionMode", "stage":stage,
                "supported":supported, "requested":MAXIMIZE_COMPATIBILITY,
                "actual":actual, "action":action})
            .to_string(),
        );
    }
}

pub fn configuration(
    smoke: Option<&Smoke>,
) -> Result<Option<Retained<WKWebViewConfiguration>>, &'static str> {
    let mtm = MainThreadMarker::new().ok_or("WebKit configuration requires the main thread.")?;
    // SAFETY: creation and preference access occur on the AppKit main thread.
    // defaultWebpagePreferences is available since macOS 10.15 (minimum: 13).
    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    let preferences = unsafe { configuration.defaultWebpagePreferences() };
    if !supported(&preferences) {
        note(smoke, "before-create", false, None, "keep-platform-default");
        return Ok(None);
    }
    // SAFETY: the selector exists and its public return type is NSInteger.
    let before: isize = unsafe { msg_send![&*preferences, securityRestrictionMode] };
    let action = match before {
        NONE => "set-maximize-compatibility",
        MAXIMIZE_COMPATIBILITY => "already-compatible",
        LOCKDOWN => "preserve-lockdown",
        _ => "preserve-unknown-mode",
    };
    note(smoke, "before-set", true, Some(before), action);
    if before == NONE {
        // SAFETY: the public setter exists and accepts WKSecurityRestrictionMode
        // (NSInteger). Only None is changed: never lower system Lockdown or a
        // future mode. This disables JIT for the whole WebContent process, not
        // only this app's spreadsheet WASM, and may reduce editing performance.
        unsafe {
            let _: () =
                msg_send![&*preferences, setSecurityRestrictionMode: MAXIMIZE_COMPATIBILITY];
        }
    }
    // SAFETY: the getter was checked above. Record readback rather than assuming
    // WebKit accepted the requested policy.
    let after: isize = unsafe { msg_send![&*preferences, securityRestrictionMode] };
    note(smoke, "after-set", true, Some(after), action);
    // Supplying a configuration makes wry use its existing websiteDataStore.
    // This fresh configuration keeps the same default persistent store as our
    // normal (non-incognito, no custom store ID) window. wry still installs its
    // IPC, initialization scripts and unregistered custom protocol handlers.
    Ok(Some(configuration))
}

/// Observe the configuration actually copied into the created WKWebView.
/// Production creates no diagnostic callback or output.
pub fn record_created(window: &tauri::WebviewWindow, smoke: &Smoke) {
    let diagnostic = smoke.clone();
    let result = window.with_webview(move |platform| {
        if MainThreadMarker::new().is_none() {
            note(Some(&diagnostic), "created", false, None, "not-main-thread");
            return;
        }
        // SAFETY: Tauri's main-thread platform callback supplies the live
        // WKWebView; its public configuration getter returns a retained copy.
        let webview: &WKWebView = unsafe { &*platform.inner().cast() };
        let configuration = unsafe { webview.configuration() };
        let preferences = unsafe { configuration.defaultWebpagePreferences() };
        let available = supported(&preferences);
        let actual = if available {
            // SAFETY: checked public NSInteger getter on the main thread.
            Some(unsafe { msg_send![&*preferences, securityRestrictionMode] })
        } else {
            None
        };
        note(Some(&diagnostic), "created", available, actual, "readback");
    });
    if result.is_err() {
        note(
            Some(smoke),
            "created",
            false,
            None,
            "platform-handle-unavailable",
        );
    }
}
