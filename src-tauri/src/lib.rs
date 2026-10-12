mod files;
mod pdf;
mod server;

use std::{
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Closing(AtomicBool);

#[tauri::command]
fn bootstrap(server: State<'_, server::AssetServer>) -> server::Bootstrap {
    server.info.clone()
}

#[tauri::command]
async fn confirm_close(
    app: tauri::AppHandle,
    closing: State<'_, Closing>,
    pdf: State<'_, pdf::PdfRuntime>,
) -> Result<(), String> {
    // The UI asks about unsaved changes before invoking this command.
    // Await the owned process tree before allowing the application's run loop to exit.
    if !closing.0.swap(true, Ordering::AcqRel) {
        pdf.shutdown().await;
        app.exit(0);
    }
    Ok(())
}

#[tauri::command]
async fn smoke_report(app: tauri::AppHandle, report: serde_json::Value) -> Result<(), String> {
    if std::env::var("OPEN_OFFICE_SMOKE").as_deref() != Ok("1") {
        return Err("Native smoke reporting is disabled.".into());
    }
    let passed = report
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .ok_or("Smoke report requires an explicit ok boolean.")?;
    let data = serde_json::to_vec_pretty(&report).map_err(|_| "Invalid smoke report.")?;
    if data.len() > 1024 * 1024 {
        return Err("Smoke report exceeds 1 MiB.".into());
    }
    // The path is a process-launch option, never a renderer-controlled IPC argument.
    let output = PathBuf::from(
        std::env::var_os("OPEN_OFFICE_SMOKE_OUTPUT")
            .ok_or("Set OPEN_OFFICE_SMOKE_OUTPUT when launching the smoke test.")?,
    );
    if !output.is_absolute() {
        return Err("Smoke output must be an absolute path.".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let parent = output.parent().ok_or("Invalid smoke output directory.")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        file.write_all(&data).map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        file.persist(output).map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "Smoke output task failed.")??;
    app.state::<Closing>().0.store(true, Ordering::Release);
    app.state::<pdf::PdfRuntime>().shutdown().await;
    app.exit(if passed { 0 } else { 1 });
    Ok(())
}

fn frontend_root(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"))
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(_app
            .path()
            .resource_dir()
            .map_err(|_| "无法定位应用资源。")?
            .join("frontend"))
    }
}

pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Closing::default())
        .manage(pdf::PdfRuntime::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            confirm_close,
            smoke_report,
            files::open_document,
            files::open_recent,
            files::list_recent_documents,
            files::save_document,
            files::pick_image,
            pdf::pdf_request,
            pdf::cancel_pdf,
        ])
        .setup(|app| {
            let appdata = app.path().app_data_dir()?;
            app.manage(files::DocumentStore::new(appdata)?);
            let server = server::AssetServer::start(&frontend_root(app.handle())?)?;
            let navigation = server.info.clone();
            let url = server.url();
            // Only this randomly generated URL namespace gets native IPC access.
            // A wildcard localhost capability would grant unrelated local web pages access.
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("session-ui")
                    .local(false)
                    .window("main")
                    .remote(format!("{url}*"))
                    .permission("core:default")
                    .permission("allow-bootstrap")
                    .permission("allow-confirm-close")
                    .permission("allow-smoke-report")
                    .permission("allow-open-document")
                    .permission("allow-open-recent")
                    .permission("allow-list-recent-documents")
                    .permission("allow-save-document")
                    .permission("allow-pick-image")
                    .permission("allow-pdf-request")
                    .permission("allow-cancel-pdf"),
            )?;
            app.manage(server);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Open Office")
                .inner_size(1360.0, 900.0)
                .min_inner_size(900.0, 640.0)
                .on_navigation(move |url| server::AssetServer::allows_navigation(&navigation, url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<Closing>().0.load(Ordering::Acquire) {
                    api.prevent_close();
                    let _ = window.emit("app-close-requested", ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to start Open Office");

    application.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !app.state::<Closing>().0.load(Ordering::Acquire) {
                api.prevent_exit();
                let _ = app.emit("app-close-requested", ());
            }
        }
        tauri::RunEvent::Exit => app.state::<pdf::PdfRuntime>().force_shutdown(),
        _ => {}
    });
}
