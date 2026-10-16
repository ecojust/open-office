mod browser_server;
mod files;
#[cfg(target_os = "macos")]
mod macos_diagnostics;
#[cfg(target_os = "macos")]
mod macos_webview;
mod server;
mod smoke;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Closing(AtomicBool);

/// Keep optional workspace I/O out of application setup. A damaged workspace
/// affects only Server commands, and no listener starts until explicitly asked.
struct BrowserWorkspace {
    asset_root: PathBuf,
    directory: PathBuf,
    manager: OnceLock<Result<browser_server::BrowserServerManager, String>>,
}

/// Created only by the explicit native diagnostic environment. No path in this
/// session can be supplied by a renderer; regular application data stays intact.
struct SmokeWorkspaceSession {
    directory: Mutex<Option<tempfile::TempDir>>,
    endpoint: Mutex<Option<browser_server::NativeSmokeEndpoint>>,
}

fn require_desktop_workspace_origin(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法确认桌面工作区来源。")?;
    if window.label() != "main"
        || !server::AssetServer::allows_navigation(&app.state::<server::AssetServer>().info, &url)
    {
        return Err("此操作仅可在桌面客户端主窗口中执行。".into());
    }
    Ok(())
}

fn require_workspace_smoke(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    require_desktop_workspace_origin(app, window)?;
    if app.state::<server::AssetServer>().smoke.is_none()
        || app.try_state::<SmokeWorkspaceSession>().is_none()
    {
        return Err("Native workspace diagnostics are disabled.".into());
    }
    Ok(())
}

#[tauri::command]
async fn smoke_prepare_document(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    base64: String,
    extension: files::DocExt,
) -> Result<files::NativeDocument, String> {
    require_workspace_smoke(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SmokeWorkspaceSession>();
        let directory = session
            .directory
            .lock()
            .map_err(|_| "Native smoke session unavailable.")?;
        let directory = directory
            .as_ref()
            .ok_or("Native smoke session already cleaned up.")?;
        let fixtures = directory.path().join("fixtures");
        std::fs::create_dir_all(&fixtures).map_err(|error| error.to_string())?;
        app.state::<files::DocumentStore>()
            .create_smoke_document(&fixtures, extension, &base64)
    })
    .await
    .map_err(|_| "Native document preparation task failed.")?
}

#[tauri::command]
async fn smoke_probe_browser_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    document_id: String,
    replacement_base64: String,
) -> Result<serde_json::Value, String> {
    require_workspace_smoke(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SmokeWorkspaceSession>();
        let directory = session
            .directory
            .lock()
            .map_err(|_| "Native smoke session unavailable.")?;
        if directory.is_none() {
            return Err("Native smoke session already cleaned up.".into());
        }
        let workspace = app.state::<BrowserWorkspace>();
        let (report, endpoint) = workspace
            .manager()?
            .native_smoke_probe(&document_id, &replacement_base64)?;
        *session
            .endpoint
            .lock()
            .map_err(|_| "Native smoke endpoint unavailable.")? = Some(endpoint);
        Ok(report)
    })
    .await
    .map_err(|_| "Native workspace TCP diagnostic task failed.")?
}

#[tauri::command]
async fn smoke_cleanup_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    require_workspace_smoke(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SmokeWorkspaceSession>();
        let mut directory = session.directory.lock().map_err(|_| "Native smoke session unavailable.")?;
        if app.state::<BrowserWorkspace>().manager()?.status()?.running {
            return Err("Stop the browser server through its normal IPC command before cleanup.".into());
        }
        let endpoint = session.endpoint.lock().map_err(|_| "Native smoke endpoint unavailable.")?;
        endpoint.as_ref().ok_or("Native workspace TCP diagnostic has not completed.")?.assert_revoked()?;
        let temporary = directory.take().ok_or("Native smoke session already cleaned up.")?;
        let path = temporary.path().to_path_buf();
        temporary.close().map_err(|error| format!("Unable to clean isolated native smoke files: {error}"))?;
        if path.exists() { return Err("Isolated native smoke files were not removed.".into()); }
        Ok(serde_json::json!({"serverStopped":true,"oldLinkRevoked":true,"temporaryFilesRemoved":true}))
    })
    .await
    .map_err(|_| "Native workspace cleanup task failed.")?
}

impl BrowserWorkspace {
    fn new(asset_root: PathBuf, directory: PathBuf) -> Self {
        Self {
            asset_root,
            directory,
            manager: OnceLock::new(),
        }
    }

    fn manager(&self) -> Result<&browser_server::BrowserServerManager, String> {
        self.manager
            .get_or_init(|| {
                browser_server::BrowserServerManager::new(
                    self.asset_root.clone(),
                    self.directory.clone(),
                )
            })
            .as_ref()
            .map_err(Clone::clone)
    }
}

async fn browser_workspace_call<T: Send + 'static>(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    operation: impl FnOnce(&browser_server::BrowserServerManager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // The capability is still bound to the original desktop origin. Independently
    // verify the caller here; a browser sharing URL never grants native commands.
    require_desktop_workspace_origin(&app, &window)?;
    // AppHandle owns access to managed state throughout the blocking task; no
    // borrowed State guard crosses an await point or escapes its application.
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = app.state::<BrowserWorkspace>();
        operation(workspace.manager()?)
    })
    .await
    .map_err(|_| "浏览器工作区操作未完成，请重试。")?
}

#[tauri::command]
async fn start_browser_server(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<browser_server::BrowserServerStatus, String> {
    browser_workspace_call(app, window, browser_server::BrowserServerManager::start).await
}

#[tauri::command]
async fn status_browser_server(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<browser_server::BrowserServerStatus, String> {
    browser_workspace_call(app, window, browser_server::BrowserServerManager::status).await
}

#[tauri::command]
async fn stop_browser_server(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<browser_server::BrowserServerStatus, String> {
    browser_workspace_call(app, window, browser_server::BrowserServerManager::stop).await
}

#[tauri::command]
async fn dispatch_browser_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<browser_server::SyncResponse, String> {
    browser_workspace_call(app, window, move |manager| {
        manager.dispatch(&method, &path, body)
    })
    .await
}

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
async fn confirm_close(app: tauri::AppHandle, closing: State<'_, Closing>) -> Result<(), String> {
    // The UI asks about unsaved changes before invoking this command.
    if !closing.0.swap(true, Ordering::AcqRel) {
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
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            confirm_close,
            smoke_report,
            files::open_document,
            files::open_recent,
            files::list_recent_documents,
            files::save_document,
            files::pick_image,
            start_browser_server,
            status_browser_server,
            stop_browser_server,
            dispatch_browser_workspace,
            smoke_prepare_document,
            smoke_probe_browser_workspace,
            smoke_cleanup_workspace,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let diagnostic = smoke::Smoke::from_environment(move || {
                let handle = handle.clone();
                handle.state::<Closing>().0.store(true, Ordering::Release);
                handle.exit(1);
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
            let appdata = if diagnostic.is_some() {
                let directory = tempfile::Builder::new()
                    .prefix("open-office-native-workspace-")
                    .tempdir()?;
                let root = directory.path().to_path_buf();
                app.manage(SmokeWorkspaceSession {
                    directory: Mutex::new(Some(directory)),
                    endpoint: Mutex::new(None),
                });
                root
            } else {
                appdata
            };
            let asset_root = frontend_root(app.handle())?;
            app.manage(BrowserWorkspace::new(
                asset_root.clone(),
                appdata.join("browser-workspace"),
            ));
            app.manage(files::DocumentStore::new(appdata)?);
            let server = server::AssetServer::start_with_smoke(&asset_root, diagnostic.clone())?;
            let navigation = server.info.clone();
            let url = server.url();
            // Fetch IPC supplies only Origin (no token path) to Tauri's ACL.
            // Restrict it to this exact random loopback port and main window;
            // HTTP asset access and window navigation still require the token.
            let capability = tauri::ipc::CapabilityBuilder::new("session-ui")
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
                .permission("allow-start-browser-server")
                .permission("allow-status-browser-server")
                .permission("allow-stop-browser-server")
                .permission("allow-dispatch-browser-workspace");
            let capability = if diagnostic.is_some() {
                capability
                    .permission("allow-smoke-prepare-document")
                    .permission("allow-smoke-probe-browser-workspace")
                    .permission("allow-smoke-cleanup-workspace")
            } else {
                capability
            };
            app.add_capability(capability)?;
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
        _ => {}
    });
}

#[cfg(test)]
mod browser_workspace_tests {
    use super::BrowserWorkspace;

    #[test]
    fn optional_workspace_is_lazy_and_initialization_does_not_start_a_listener() {
        let assets = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let directory = data.path().join("browser-workspace");
        let workspace = BrowserWorkspace::new(assets.path().into(), directory.clone());

        assert!(
            !directory.exists(),
            "Application setup must not read or create optional data"
        );
        assert!(workspace.manager.get().is_none());
        let status = workspace.manager().unwrap().status().unwrap();
        assert!(
            !status.running,
            "Status inspection must never start a listener"
        );
        assert!(status.local_url.is_none());
        assert!(status.lan_urls.is_empty());
    }

    #[test]
    fn unusable_optional_storage_does_not_prevent_creating_application_state() {
        let assets = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let blocked = data.path().join("not-a-directory");
        std::fs::write(&blocked, b"preserve me").unwrap();
        let workspace =
            BrowserWorkspace::new(assets.path().into(), blocked.join("browser-workspace"));

        assert!(workspace.manager.get().is_none());
        assert!(workspace.manager().is_err());
        assert!(
            workspace.manager().is_err(),
            "Repeated commands return the same initialization error"
        );
        assert_eq!(std::fs::read(&blocked).unwrap(), b"preserve me");
    }
}
