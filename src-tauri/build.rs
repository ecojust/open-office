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
            "pdf_request",
            "cancel_pdf",
        ]),
    ))
    .expect("Unable to generate native command permissions");
}
