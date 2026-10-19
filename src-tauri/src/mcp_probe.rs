//! HTTP client used only by explicitly enabled installed-app diagnostics.
//! It connects to the production listener; editor tools still traverse ordinary
//! event delivery, request claiming and the desktop completion command.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProbeRequest {
    Tool {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        arguments: Value,
    },
    Stopped {
        port: u16,
    },
}

pub fn probe_tool(
    port: u16,
    token: &str,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let (initialized, http_session_id) = request(
        port,
        token,
        "POST",
        None,
        Some(
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":"2025-03-26","capabilities":{},
                "clientInfo":{"name":"Open Office Native Verification","version":"1"}
            }}),
        ),
    )?;
    let http_session_id =
        http_session_id.ok_or("Native MCP initialize omitted the session header.")?;
    let result = (|| {
        request(
            port,
            token,
            "POST",
            Some(&http_session_id),
            Some(json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
        )?;
        let (catalog, _) = request(
            port,
            token,
            "POST",
            Some(&http_session_id),
            Some(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})),
        )?;
        if !catalog
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| {
                tools
                    .iter()
                    .any(|tool| tool.get("name").and_then(Value::as_str) == Some(tool_name))
            })
        {
            return Err("Native MCP tool is absent from the advertised catalog.".into());
        }
        let (response, _) = request(
            port,
            token,
            "POST",
            Some(&http_session_id),
            Some(
                json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":tool_name,"arguments":arguments}}),
            ),
        )?;
        if response.get("error").is_some()
            || response.pointer("/result/isError").and_then(Value::as_bool) == Some(true)
        {
            return Err("Native MCP tool execution did not succeed.".into());
        }
        if !response
            .pointer("/result/content")
            .is_some_and(Value::is_array)
        {
            return Err("Native MCP tool result is malformed.".into());
        }
        Ok(
            json!({"port":port,"initialized":initialized,"catalog":catalog,"response":response,"httpSessionId":http_session_id}),
        )
    })();
    let disconnected = request(port, token, "DELETE", Some(&http_session_id), None);
    match result {
        Ok(result) => {
            disconnected?;
            Ok(result)
        }
        Err(error) => Err(error),
    }
}

pub fn probe_stopped(port: u16) -> Result<Value, String> {
    if port < 1024 {
        return Err("Native MCP probe port is invalid.".into());
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    // Windows can report a refused loopback connection after its first SYN
    // retry, which can exceed one second under parallel native tests. Allow
    // that bounded delay, but never treat a timeout as evidence of shutdown.
    match TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            Ok(json!({"port":port,"closed":true}))
        }
        Ok(_) => Err("Native MCP listener still accepts connections after deactivation.".into()),
        Err(error) => Err(format!(
            "Native MCP listener closure could not be verified: {error} ({:?}).",
            error.kind()
        )),
    }
}

fn request(
    port: u16,
    token: &str,
    method: &str,
    session: Option<&str>,
    body: Option<Value>,
) -> Result<(Value, Option<String>), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| "Native MCP HTTP connection failed.")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(35)))
        .map_err(|_| "Native MCP HTTP timeout setup failed.")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "Native MCP HTTP timeout setup failed.")?;
    let expected_status = if body
        .as_ref()
        .and_then(|value| value.get("method"))
        .and_then(Value::as_str)
        .is_some_and(|method| method.starts_with("notifications/"))
    {
        "202"
    } else {
        "200"
    };
    let body = body.map(|value| value.to_string()).unwrap_or_default();
    let session = session
        .map(|session| format!("Mcp-Session-Id: {session}\r\n"))
        .unwrap_or_default();
    write!(stream,"{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nMCP-Protocol-Version: 2025-03-26\r\nContent-Length: {}\r\n{session}\r\n{body}", body.len()).map_err(|_| "Native MCP HTTP request failed.")?;
    let mut bytes = Vec::new();
    const MAX_RESPONSE: u64 = 9 * 1024 * 1024;
    stream
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Native MCP HTTP response failed.")?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err("Native MCP HTTP response exceeded the limit.".into());
    }
    let end = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or("Native MCP HTTP response has no header.")?;
    let header =
        std::str::from_utf8(&bytes[..end]).map_err(|_| "Native MCP HTTP header is malformed.")?;
    let mut lines = header.split("\r\n");
    if lines.next().and_then(|line| line.split_whitespace().nth(1)) != Some(expected_status) {
        return Err("Native MCP HTTP request returned an unsuccessful status.".into());
    }
    let mut session_id = None;
    let mut length = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("mcp-session-id") {
                session_id = Some(value.trim().to_owned());
            }
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let payload = &bytes[end + 4..];
    if length != Some(payload.len()) {
        return Err("Native MCP HTTP response length is invalid.".into());
    }
    let value = if payload.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(payload)
            .map_err(|_| "Native MCP HTTP response JSON is malformed.")?
    };
    Ok((value, session_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::{McpConfig, McpDocument, McpService};
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc};

    #[test]
    fn installed_app_probe_uses_real_http_and_normal_claim_completion_bridge() {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(McpService::new(directory.path().join("mcp.json")).unwrap());
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let token = "b".repeat(64);
        let (send, receive) = mpsc::channel();
        let status = service.start(
            McpConfig { port, token: token.clone(), allow_edits: false },
            McpDocument { id: "native-probe-document".into(), kind: "word".into(), title: "测试文档.docx".into() },
            vec![json!({"name":"word_read","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}})],
            Arc::new(move |request| send.send(request).map_err(|_| "closed".into())),
        ).unwrap();
        assert!(probe_stopped(port).is_err());
        let bridge = service.clone();
        let worker = std::thread::spawn(move || {
            let event = receive.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(event.document_id, "native-probe-document");
            assert_eq!(event.tool_name, "word_read");
            assert!(bridge.claim(&event.session_id, &event.request_id).unwrap());
            bridge
                .complete(
                    &event.session_id,
                    &event.request_id,
                    json!({"content":[{"type":"text","text":"native-real-document"}]}),
                )
                .unwrap();
        });
        let result = probe_tool(port, &token, "word_read", json!({})).unwrap();
        worker.join().unwrap();
        assert_eq!(
            result["initialized"]["result"]["protocolVersion"],
            "2025-03-26"
        );
        assert_eq!(
            result["response"]["result"]["content"][0]["text"],
            "native-real-document"
        );
        assert_eq!(result["port"], port);
        assert!(!result.to_string().contains(&token));
        assert!(service
            .probe_connection(status.session_id.as_ref().unwrap())
            .is_ok());
        service.stop(None).unwrap();
        assert!(service
            .probe_connection(status.session_id.as_ref().unwrap())
            .is_err());
        assert_eq!(probe_stopped(port).unwrap()["closed"], true);
    }
}
