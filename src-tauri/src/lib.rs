mod files;
#[cfg(target_os = "macos")]
mod macos_diagnostics;
#[cfg(target_os = "macos")]
mod macos_webview;
mod pdf;
mod server;
mod smoke;

use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Closing(AtomicBool);

#[tauri::command]
fn bootstrap(
    server: State<'_, server::AssetServer>,
    window: tauri::WebviewWindow,
) -> server::Bootstrap {
    if let Some(smoke) = &server.smoke {
        smoke.note("ipc-bootstrap", "native bootstrap command reached");
        #[cfg(target_os = "macos")]
        macos_diagnostics::record_geometry(&window, smoke);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
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
    let diagnostic = app
        .state::<server::AssetServer>()
        .smoke
        .clone()
        .ok_or("Native smoke reporting is disabled.")?;
    let passed = tauri::async_runtime::spawn_blocking(move || diagnostic.report(&report))
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
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = macos_diagnostics::instrument(builder);
    let application = builder
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
            let handle = app.handle().clone();
            let diagnostic = smoke::Smoke::from_environment(move || {
                let handle = handle.clone();
                handle.state::<Closing>().0.store(true, Ordering::Release);
                let pdf = handle.state::<pdf::PdfRuntime>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    pdf.shutdown().await;
                    handle.exit(1);
                });
            })?;
            #[cfg(target_os = "macos")]
            let diagnostic = diagnostic.map(|mut smoke| {
                let app = app.handle().clone();
                smoke.observe_input_requests(move |request| {
                    if let (Some(window), Some(server)) = (
                        app.get_webview_window("main"),
                        app.try_state::<server::AssetServer>(),
                    ) {
                        if let Some(smoke) = &server.smoke {
                            macos_diagnostics::record_input_geometry(&window, smoke, request);
                        }
                    }
                });
                smoke
            });
            if let Some(smoke) = &diagnostic {
                smoke.note("native-setup", "initializing document store");
            }
            let appdata = app.path().app_data_dir()?;
            app.manage(files::DocumentStore::new(appdata)?);
            let server = server::AssetServer::start_with_smoke(
                &frontend_root(app.handle())?,
                diagnostic.clone(),
            )?;
            let navigation = server.info.clone();
            let url = server.url();
            // Fetch IPC supplies only Origin (no token path) to Tauri's ACL.
            // Restrict it to this exact random loopback port and main window;
            // HTTP asset access and window navigation still require the token.
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("session-ui")
                    .local(false)
                    .window("main")
                    .remote(server.ipc_origin_pattern())
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
            if let Some(smoke) = &diagnostic {
                smoke.note("acl-ready", "native commands restricted to this session");
            }
            let initial_url = if diagnostic.is_some() {
                format!("{url}?nativeSmoke=1")
            } else {
                url.clone()
            };
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(initial_url.parse()?))
                    .title("Open Office")
                    .inner_size(1360.0, 900.0)
                    .min_inner_size(900.0, 640.0)
                    .on_navigation(move |url| {
                        server::AssetServer::allows_navigation(&navigation, url)
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            #[cfg(target_os = "macos")]
            if let Some(configuration) = macos_webview::configuration(diagnostic.as_ref())? {
                builder = builder.with_webview_configuration(configuration);
            }
            if let Some(smoke) = &diagnostic {
                let progress = smoke.clone();
                builder = builder
                    .initialization_script(smoke::initialization_script(&url))
                    .on_page_load(move |_, payload| {
                        progress.note("webview-page", &format!("{:?}", payload.event()))
                    });
            }
            let window = builder.build()?;
            if let Some(smoke) = &diagnostic {
                #[cfg(target_os = "macos")]
                macos_webview::record_created(&window, smoke);
                smoke.note("window-created", "showing and focusing test window");
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            ) {
                if let Some(server) = window.try_state::<server::AssetServer>() {
                    if let Some(smoke) = &server.smoke {
                        if let Some(webview) = window.get_webview_window("main") {
                            macos_diagnostics::record_geometry(&webview, smoke);
                        }
                    }
                }
            }
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
