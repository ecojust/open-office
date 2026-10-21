//! Browser acceptance bridge for the production Rust MCP transport. Only Tauri
//! IPC is replaced with newline-delimited stdio; HTTP and document tools are real.
#[path = "../../../../src-tauri/src/mcp.rs"]
mod mcp;
#[path = "../../../../src-tauri/src/mcp_probe.rs"]
mod mcp_probe;

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};

fn write_json(output: &Arc<Mutex<io::Stdout>>, value: Value) -> Result<(), String> {
    let mut stdout = output.lock().map_err(|_| "Output lock failed")?;
    serde_json::to_writer(&mut *stdout, &value).map_err(|error| error.to_string())?;
    stdout.write_all(b"\n").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn run() -> Result<(), String> {
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let service = Arc::new(mcp::McpService::new(directory.path().join("mcp.json"))?);
    let output = Arc::new(Mutex::new(io::stdout()));
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        // Rehearse the installed smoke with the same Rust HTTP probe. Keep the
        // main stdio reader free to claim/complete requests from the WebView.
        if request["op"] == "probe" {
            let service = service.clone();
            let output = output.clone();
            std::thread::spawn(move || {
                let result = (|| -> Result<Value, String> {
                    let probe: mcp_probe::ProbeRequest = serde_json::from_value(request["request"].clone()).map_err(|error| error.to_string())?;
                    match probe {
                        mcp_probe::ProbeRequest::Tool { session_id, tool_name, arguments } => {
                            let (port, token) = service.probe_connection(&session_id)?;
                            let mut value = mcp_probe::probe_tool(port, &token, &tool_name, arguments)?;
                            service.probe_connection(&session_id)?;
                            value["sessionId"] = Value::String(session_id);
                            Ok(value)
                        }
                        mcp_probe::ProbeRequest::Stopped { port } => mcp_probe::probe_stopped(port),
                    }
                })();
                let response = match result {
                    Ok(result) => json!({"id":request["id"],"ok":true,"result":result}),
                    Err(error) => json!({"id":request["id"],"ok":false,"error":error}),
                };
                let _ = write_json(&output, response);
            });
            continue;
        }
        let result: Result<Value, String> = (|| {
            let required = |key: &str| request[key].as_str().ok_or_else(|| format!("Missing {key}"));
            match required("op")? {
                "start" => {
                    let config = serde_json::from_value(request["config"].clone()).map_err(|error| error.to_string())?;
                    let document = serde_json::from_value(request["document"].clone()).map_err(|error| error.to_string())?;
                    let tools = serde_json::from_value(request["tools"].clone()).map_err(|error| error.to_string())?;
                    let event_output = output.clone();
                    let callback = Arc::new(move |event| write_json(&event_output, json!({ "event": "mcp-request", "request": event })));
                    serde_json::to_value(service.start(config, document, tools, callback)?).map_err(|error| error.to_string())
                }
                "stop" => serde_json::to_value(service.stop(request["sessionId"].as_str())?).map_err(|error| error.to_string()),
                "status" => serde_json::to_value(service.status()).map_err(|error| error.to_string()),
                "heartbeat" => serde_json::to_value(service.heartbeat(required("sessionId")?)?).map_err(|error| error.to_string()),
                "claim" => Ok(json!(service.claim(required("sessionId")?, required("requestId")?)?)),
                "complete" => {
                    service.complete(required("sessionId")?, required("requestId")?, request["result"].clone())?;
                    Ok(Value::Null)
                }
                _ => Err("Unknown harness operation".into()),
            }
        })();
        let response = match result {
            Ok(result) => json!({ "id": request["id"], "ok": true, "result": result }),
            Err(error) => json!({ "id": request["id"], "ok": false, "error": error }),
        };
        write_json(&output, response)?;
    }
    service.stop(None)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("MCP browser acceptance harness: {error}");
        std::process::exit(1);
    }
}
