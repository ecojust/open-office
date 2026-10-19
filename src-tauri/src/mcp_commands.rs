//! Desktop IPC boundary for the document-scoped MCP service.
use crate::mcp::{McpConfig, McpDocument, McpService, McpStatus};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager};

fn require_main(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法确认桌面工作区来源。")?;
    if window.label() != "main"
        || !crate::server::AssetServer::allows_navigation(
            &app.state::<crate::server::AssetServer>().info,
            &url,
        )
    {
        return Err("MCP 设置仅可在桌面客户端主窗口中操作。".into());
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_get_config(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<McpConfig, String> {
    require_main(&app, &window)?;
    app.state::<McpService>().get_config()
}

#[tauri::command]
pub fn mcp_save_config(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    config: McpConfig,
) -> Result<McpConfig, String> {
    require_main(&app, &window)?;
    app.state::<McpService>().save_config(config)
}

#[tauri::command]
pub fn mcp_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    config: McpConfig,
    document: McpDocument,
    tools: Vec<Value>,
) -> Result<McpStatus, String> {
    require_main(&app, &window)?;
    let emitter = window.clone();
    app.state::<McpService>().start(
        config,
        document,
        tools,
        Arc::new(move |request| {
            emitter
                .emit("mcp-tool-request", request)
                .map_err(|_| "无法发送 MCP 文档请求。".into())
        }),
    )
}

#[tauri::command]
pub fn mcp_stop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: Option<String>,
) -> Result<McpStatus, String> {
    require_main(&app, &window)?;
    app.state::<McpService>().stop(session_id.as_deref())
}

#[tauri::command]
pub fn mcp_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<McpStatus, String> {
    require_main(&app, &window)?;
    Ok(app.state::<McpService>().status())
}

#[tauri::command]
pub fn mcp_heartbeat(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<McpStatus, String> {
    require_main(&app, &window)?;
    app.state::<McpService>().heartbeat(&session_id)
}

#[tauri::command]
pub fn mcp_claim(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    request_id: String,
) -> Result<bool, String> {
    require_main(&app, &window)?;
    app.state::<McpService>().claim(&session_id, &request_id)
}

#[tauri::command]
pub fn mcp_complete(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    require_main(&app, &window)?;
    app.state::<McpService>()
        .complete(&session_id, &request_id, result)
}

#[tauri::command]
pub async fn mcp_smoke_probe(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: crate::mcp_probe::ProbeRequest,
) -> Result<Value, String> {
    require_main(&app, &window)?;
    if app.state::<crate::server::AssetServer>().smoke.is_none() {
        return Err("Native MCP verification is disabled.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<McpService>();
        match request {
            crate::mcp_probe::ProbeRequest::Tool {
                session_id,
                tool_name,
                arguments,
            } => {
                if !arguments.is_object() {
                    return Err("Native MCP tool arguments must be an object.".into());
                }
                let (port, token) = service.probe_connection(&session_id)?;
                let mut result = crate::mcp_probe::probe_tool(port, &token, &tool_name, arguments)?;
                // A successful tool result must still belong to the original
                // document when this diagnostic reports completion.
                service.probe_connection(&session_id)?;
                result["sessionId"] = Value::String(session_id);
                Ok(result)
            }
            crate::mcp_probe::ProbeRequest::Stopped { port } => {
                crate::mcp_probe::probe_stopped(port)
            }
        }
    })
    .await
    .map_err(|_| "Native MCP HTTP verification task failed.")?
}
