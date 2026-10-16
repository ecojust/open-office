fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bootstrap",
            "confirm_close",
            "smoke_report",
            "open_document",
            "open_recent",
            "list_recent_documents",
            "save_document",
            "pick_image",
            "start_browser_server",
            "status_browser_server",
            "stop_browser_server",
            "dispatch_browser_workspace",
            "smoke_prepare_document",
            "smoke_probe_browser_workspace",
            "smoke_cleanup_workspace",
        ]),
    ))
    .expect("Unable to generate native command permissions");
}
