//! Test-only process: its stdin acts as the desktop IPC transport while real
//! browser contexts use the production HTTP listener. Never included in releases.
use open_office_browser_server_tests::browser_server::BrowserServerManager;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    let assets = arguments
        .next()
        .ok_or("Usage: office-browser-harness ASSET_DIRECTORY WORKSPACE_DIRECTORY")?;
    let workspace = arguments.next().ok_or("Missing workspace directory")?;
    if arguments.next().is_some() {
        return Err("Unexpected extra arguments".into());
    }
    let server = BrowserServerManager::new(assets.into(), workspace.into())?;
    emit(json!({"ready":server.start()?}))?;
    for line in io::stdin().lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                emit(json!({"error":error.to_string()}))?;
                continue;
            }
        };
        let result = match request["command"].as_str() {
            Some("start") => server.start().map(|status| json!({"status":status})),
            Some("stop") => server.stop().map(|status| json!({"status":status})),
            Some("status") => server.status().map(|status| json!({"status":status})),
            Some(_) => Err("Unknown harness command".into()),
            None => server
                .dispatch(
                    request["method"].as_str().unwrap_or("GET"),
                    request["path"].as_str().unwrap_or("_sync/state"),
                    request.get("body").cloned(),
                )
                .map(|response| json!({"response":response})),
        };
        emit(result.unwrap_or_else(|error| json!({"error":error})))?;
    }
    server.stop()?;
    Ok(())
}

fn emit(value: Value) -> Result<(), String> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &value).map_err(|error| error.to_string())?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|error| error.to_string())
}
