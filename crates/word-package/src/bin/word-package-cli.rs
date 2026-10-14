//! A real native test adapter, not a replacement for the Tauri IPC transport.
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read, Write};
use word_package::{read_package_base64, write_package_base64, Part, CLI_INPUT_LIMIT};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Read { base64: String },
    Write { parts: Vec<Part> },
}

fn run() -> Result<serde_json::Value, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(CLI_INPUT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > CLI_INPUT_LIMIT {
        return Err("DOCX 包请求超过大小限制。".into());
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "DOCX 包请求 JSON 无效。")?;
    match request {
        Request::Read { base64 } => Ok(json!({"ok": true, "parts": read_package_base64(&base64)?})),
        Request::Write { parts } => Ok(json!({"ok": true, "base64": write_package_base64(parts)?})),
    }
}
fn main() {
    let (response, code) = match run() {
        Ok(value) => (value, 0),
        Err(error) => (json!({"ok": false, "error": error}), 1),
    };
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &response).is_err() || stdout.write_all(b"\n").is_err() {
        std::process::exit(2);
    }
    std::process::exit(code);
}
