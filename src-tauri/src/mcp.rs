//! Authenticated, document-scoped MCP transport. Editor mutations stay in the UI.
//! This module deliberately has no desktop-framework dependency so the production
//! TCP transport can be exercised against real editors by the browser harness.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_HEADER: usize = 16 * 1024;
// Embedded image assets and structured range/shape edits share this bounded body.
const MAX_BODY: usize = 8 * 1024 * 1024;
// A 7 MiB structured result is JSON-encoded again in MCP content[].text.
const MAX_RESULT: usize = 16 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 16;
const MAX_PENDING: usize = 8;
const MAX_CLIENTS: usize = 64;
const CLIENT_IDLE_SECONDS: u64 = 600;
const REQUEST_SECONDS: u64 = 30;
const LEASE_MILLIS: u64 = 30_000;
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
pub type Dispatch = Arc<dyn Fn(ToolRequest) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpConfig {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub allow_edits: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpDocument {
    pub id: String,
    pub kind: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub session_id: Option<String>,
    pub document_id: Option<String>,
    pub endpoint: Option<String>,
    pub port: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub session_id: String,
    pub request_id: String,
    pub document_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub deadline_at: u64,
}

struct Pending {
    client_id: String,
    rpc_id: Value,
    deadline: Instant,
    claimed: bool,
    reply: Sender<Value>,
}

struct Session {
    id: String,
    document: McpDocument,
    port: u16,
    token: String,
    tools: Vec<Value>,
    dispatch: Dispatch,
    stopped: AtomicBool,
    heartbeat: AtomicU64,
    connections: AtomicUsize,
    pending: Mutex<HashMap<String, Pending>>,
    listener: Mutex<Option<thread::JoinHandle<()>>>,
    clients: Mutex<HashMap<String, Instant>>,
}

impl Session {
    fn live(&self) -> bool {
        !self.stopped.load(Ordering::Acquire)
            && now_millis().saturating_sub(self.heartbeat.load(Ordering::Acquire)) <= LEASE_MILLIS
    }

    fn revoke(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut clients) = self.clients.lock() {
            clients.clear();
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, request) in pending.drain() {
                let _ = request
                    .reply
                    .send(tool_error("MCP 服务已停止，当前文档已失效。"));
            }
        }
    }

    fn close_listener(&self) {
        self.revoke();
        if let Ok(mut listener) = self.listener.lock() {
            if let Some(listener) = listener.take() {
                let _ = listener.join();
            }
        }
    }

    fn status(&self) -> McpStatus {
        if !self.live() {
            return McpStatus::default();
        }
        McpStatus {
            running: true,
            session_id: Some(self.id.clone()),
            document_id: Some(self.document.id.clone()),
            endpoint: Some(format!("http://127.0.0.1:{}/mcp", self.port)),
            port: Some(self.port),
        }
    }
}

pub struct McpService {
    config_path: PathBuf,
    config: Mutex<Result<McpConfig, String>>,
    session: Mutex<Option<Arc<Session>>>,
}

impl McpService {
    pub fn new(config_path: PathBuf) -> Result<Self, String> {
        // A damaged or unwritable MCP settings file must not prevent documents
        // from opening. Report the configuration error only in MCP settings;
        // saving corrected settings repairs it without discarding the file here.
        let config = (|| -> Result<McpConfig, String> {
            if config_path.exists() {
                if std::fs::metadata(&config_path)
                    .map_err(|_| "无法读取 MCP 配置。")?
                    .len()
                    > 8192
                {
                    return Err("MCP 配置文件过大。".into());
                }
                let bytes = std::fs::read(&config_path).map_err(|_| "无法读取 MCP 配置。")?;
                let config =
                    serde_json::from_slice(&bytes).map_err(|_| "MCP 配置文件格式无效。")?;
                validate_config(&config)?;
                Ok(config)
            } else {
                let config = McpConfig {
                    port: 19780,
                    token: random_id()?,
                    allow_edits: true,
                };
                persist_config(&config_path, &config)?;
                Ok(config)
            }
        })();
        Ok(Self {
            config_path,
            config: Mutex::new(config),
            session: Mutex::new(None),
        })
    }

    pub fn get_config(&self) -> Result<McpConfig, String> {
        self.config
            .lock()
            .map_err(|_| "MCP 配置不可用。".to_owned())?
            .clone()
    }

    pub fn save_config(&self, config: McpConfig) -> Result<McpConfig, String> {
        validate_config(&config)?;
        let session = self.session.lock().map_err(|_| "MCP 服务不可用。")?;
        if session.as_ref().is_some_and(|session| session.live()) {
            return Err("请先停止 MCP 服务，再修改配置。".into());
        }
        let mut current = self.config.lock().map_err(|_| "MCP 配置不可用。")?;
        persist_config(&self.config_path, &config)?;
        *current = Ok(config.clone());
        Ok(config)
    }

    pub fn start(
        &self,
        config: McpConfig,
        document: McpDocument,
        tools: Vec<Value>,
        dispatch: Dispatch,
    ) -> Result<McpStatus, String> {
        validate_config(&config)?;
        validate_document(&document)?;
        let tools = validate_tools(tools, config.allow_edits)?;
        let mut current = self.session.lock().map_err(|_| "MCP 服务不可用。")?;
        if let Some(previous) = current.take() {
            previous.close_listener();
        }
        let listener = TcpListener::bind(("127.0.0.1", config.port))
            .map_err(|_| format!("无法启动 MCP：端口 {} 已被占用或不可用。", config.port))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "无法配置 MCP 监听器。")?;
        let session = Arc::new(Session {
            id: random_id()?,
            document,
            port: config.port,
            token: config.token,
            tools,
            dispatch,
            stopped: AtomicBool::new(false),
            heartbeat: AtomicU64::new(now_millis()),
            connections: AtomicUsize::new(0),
            pending: Mutex::new(HashMap::new()),
            listener: Mutex::new(None),
            clients: Mutex::new(HashMap::new()),
        });
        let worker = session.clone();
        let listener_thread = thread::Builder::new()
            .name("document-mcp-listener".into())
            .spawn(move || {
                while worker.live() {
                    match listener.accept() {
                        Ok((mut stream, peer)) => {
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            if worker.connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS
                            {
                                worker.connections.fetch_sub(1, Ordering::AcqRel);
                                let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
                                write_response(&mut stream, 503, None);
                                continue;
                            }
                            let request_session = worker.clone();
                            let spawned = thread::Builder::new()
                                .name("document-mcp-request".into())
                                .spawn(move || {
                                    let _guard = ConnectionGuard(request_session.clone());
                                    serve(&mut stream, &request_session);
                                });
                            if spawned.is_err() {
                                worker.connections.fetch_sub(1, Ordering::AcqRel);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(15))
                        }
                        Err(_) => break,
                    }
                }
                worker.revoke();
            })
            .map_err(|_| "无法创建 MCP 服务线程。")?;
        *session.listener.lock().map_err(|_| "MCP 监听器不可用。")? = Some(listener_thread);
        let status = session.status();
        *current = Some(session);
        Ok(status)
    }

    /// Credentials are consumed by the smoke-only Rust HTTP probe and never
    /// returned through its IPC response.
    pub(crate) fn probe_connection(&self, session_id: &str) -> Result<(u16, String), String> {
        let current = self.session.lock().map_err(|_| "MCP 服务不可用。")?;
        let session = current
            .as_ref()
            .filter(|session| session.id == session_id && session.live())
            .ok_or("MCP 会话已停止。")?;
        Ok((session.port, session.token.clone()))
    }

    pub fn status(&self) -> McpStatus {
        self.session
            .lock()
            .ok()
            .and_then(|session| session.as_ref().map(|session| session.status()))
            .unwrap_or_default()
    }

    pub fn stop(&self, session_id: Option<&str>) -> Result<McpStatus, String> {
        let mut current = self.session.lock().map_err(|_| "MCP 服务不可用。")?;
        if let Some(session) = current.as_ref() {
            // A delayed stop from an older editor must never stop a newer session.
            if session_id.is_some_and(|id| id != session.id) {
                return Ok(session.status());
            }
            session.close_listener();
        }
        current.take();
        Ok(McpStatus::default())
    }

    pub fn heartbeat(&self, session_id: &str) -> Result<McpStatus, String> {
        let current = self.session.lock().map_err(|_| "MCP 服务不可用。")?;
        let session = current
            .as_ref()
            .filter(|session| session.id == session_id && session.live())
            .ok_or("MCP 会话已停止。")?;
        session.heartbeat.store(now_millis(), Ordering::Release);
        Ok(session.status())
    }

    pub fn claim(&self, session_id: &str, request_id: &str) -> Result<bool, String> {
        let current = self.session.lock().map_err(|_| "MCP 服务不可用。")?;
        let Some(session) = current
            .as_ref()
            .filter(|session| session.id == session_id && session.live())
        else {
            return Ok(false);
        };
        let mut pending = session.pending.lock().map_err(|_| "MCP 请求不可用。")?;
        let Some(request) = pending.get_mut(request_id) else {
            return Ok(false);
        };
        if request.claimed || request.deadline <= Instant::now() {
            return Ok(false);
        }
        request.claimed = true;
        Ok(true)
    }

    pub fn complete(
        &self,
        session_id: &str,
        request_id: &str,
        result: Value,
    ) -> Result<(), String> {
        if !result.get("content").is_some_and(Value::is_array)
            || result.to_string().len() > MAX_RESULT
        {
            return Err("MCP 工具结果格式无效或超过大小限制。".into());
        }
        let current = self.session.lock().map_err(|_| "MCP 服务不可用。")?;
        let session = current
            .as_ref()
            .filter(|session| session.id == session_id && session.live())
            .ok_or("MCP 会话已停止。")?;
        let mut pending = session.pending.lock().map_err(|_| "MCP 请求不可用。")?;
        let request = pending.get(request_id).ok_or("MCP 请求已失效。")?;
        if !request.claimed || request.deadline <= Instant::now() {
            return Err("MCP 请求未领取或已超时。".into());
        }
        let request = pending.remove(request_id).ok_or("MCP 请求已失效。")?;
        request
            .reply
            .send(result)
            .map_err(|_| "MCP 请求连接已断开。".into())
    }
}

impl Drop for McpService {
    fn drop(&mut self) {
        let _ = self.stop(None);
    }
}

struct ConnectionGuard(Arc<Session>);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::AcqRel);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成安全的 MCP 令牌。")?;
    Ok(hex::encode(bytes))
}

fn validate_config(config: &McpConfig) -> Result<(), String> {
    if config.port < 1024 {
        return Err("MCP 端口须为 1024 至 65535。".into());
    }
    if !(32..=128).contains(&config.token.len())
        || !config
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("MCP 访问令牌须为 32 至 128 个字母、数字、下划线或连字符。".into());
    }
    Ok(())
}

fn persist_config(path: &PathBuf, config: &McpConfig) -> Result<(), String> {
    let parent = path.parent().ok_or("MCP 配置目录无效。")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建 MCP 配置目录。")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法保存 MCP 配置。")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法保护 MCP 配置。")?;
    }
    serde_json::to_writer_pretty(&mut file, config).map_err(|_| "无法序列化 MCP 配置。")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "无法写入 MCP 配置。")?;
    file.persist(path).map_err(|_| "无法替换 MCP 配置。")?;
    Ok(())
}

fn validate_document(document: &McpDocument) -> Result<(), String> {
    if document.id.is_empty()
        || document.id.len() > 256
        || document.title.len() > 1024
        || ![
            "word",
            "sheet",
            "presentation",
            "pdf",
            "note",
            "canvas",
            "diagram",
        ]
        .contains(&document.kind.as_str())
    {
        return Err("MCP 当前文档信息无效。".into());
    }
    Ok(())
}

fn validate_tools(tools: Vec<Value>, allow_edits: bool) -> Result<Vec<Value>, String> {
    if tools.is_empty()
        || tools.len() > 128
        || serde_json::to_vec(&tools)
            .map_err(|_| "MCP 工具列表无效。")?
            .len()
            > MAX_BODY
    {
        return Err("MCP 工具列表为空或超过大小限制。".into());
    }
    let mut names = HashSet::new();
    for tool in &tools {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or("MCP 工具名称无效。")?;
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
            || !names.insert(name.to_owned())
            || tool.pointer("/inputSchema/type").and_then(Value::as_str) != Some("object")
        {
            return Err("MCP 工具定义无效。".into());
        }
        if !allow_edits
            && tool
                .pointer("/annotations/readOnlyHint")
                .and_then(Value::as_bool)
                != Some(true)
        {
            return Err("只读 MCP 服务不能包含编辑工具。".into());
        }
    }
    Ok(tools)
}

struct HttpRequest {
    method: String,
    client_id: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream, session: &Session) -> Result<HttpRequest, u16> {
    // Windows may inherit the listener's nonblocking mode on accepted sockets.
    // Request workers use bounded blocking reads, including split HTTP bodies.
    stream.set_nonblocking(false).map_err(|_| 503u16)?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::with_capacity(2048);
    let end;
    loop {
        if Instant::now() > deadline || !session.live() {
            return Err(408);
        }
        if let Some(position) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            end = position + 4;
            break;
        }
        if bytes.len() >= MAX_HEADER {
            return Err(431);
        }
        let mut chunk = [0u8; 2048];
        let count = stream.read(&mut chunk).map_err(|_| 408u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if end > MAX_HEADER {
        return Err(431);
    }
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| 400u16)?;
    let mut lines = header.split("\r\n");
    let request = lines.next().ok_or(400u16)?.split(' ').collect::<Vec<_>>();
    if request.len() != 3 || !["HTTP/1.0", "HTTP/1.1"].contains(&request[2]) {
        return Err(400);
    }
    if request[1] != "/mcp" {
        return Err(404);
    }
    let method = request[0].to_owned();
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line.split_once(':').ok_or(400u16)?;
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.bytes().any(|b| b < 0x20 && b != b'\t')
        {
            return Err(400);
        }
        if headers
            .insert(key.to_ascii_lowercase(), value.trim().to_owned())
            .is_some()
        {
            return Err(400);
        }
    }
    let expected_host = format!("127.0.0.1:{}", session.port);
    let localhost_host = format!("localhost:{}", session.port);
    if !headers
        .get("host")
        .is_some_and(|host| host == &expected_host || host == &localhost_host)
    {
        return Err(403);
    }
    if headers.get("origin").is_some_and(|origin| {
        origin != &format!("http://{expected_host}")
            && origin != &format!("http://{localhost_host}")
    }) {
        return Err(403);
    }
    let expected_auth = format!("Bearer {}", session.token);
    if !headers
        .get("authorization")
        .is_some_and(|auth| constant_time_equal(auth.as_bytes(), expected_auth.as_bytes()))
    {
        return Err(401);
    }
    if headers.contains_key("transfer-encoding") {
        return Err(400);
    }
    if let Some(protocol) = headers.get("mcp-protocol-version") {
        if !PROTOCOLS.contains(&protocol.as_str()) {
            return Err(400);
        }
    }
    if !["POST", "GET", "DELETE"].contains(&method.as_str()) {
        return Err(405);
    }
    let client_id = headers.get("mcp-session-id").cloned();
    if method != "POST" {
        return Ok(HttpRequest {
            method,
            client_id,
            body: Vec::new(),
        });
    }
    if !headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return Err(415);
    }
    if headers.get("accept").is_some_and(|value| {
        !value.split(',').any(|part| {
            ["application/json", "*/*"].contains(&part.trim().split(';').next().unwrap_or(""))
        })
    }) {
        return Err(406);
    }
    let length = headers
        .get("content-length")
        .ok_or(411u16)?
        .parse::<usize>()
        .map_err(|_| 400u16)?;
    if length > MAX_BODY {
        return Err(413);
    }
    let mut body = bytes[end..].to_vec();
    if body.len() > length {
        return Err(400);
    }
    while body.len() < length {
        if Instant::now() > deadline || !session.live() {
            return Err(408);
        }
        let mut chunk = [0u8; 8192];
        let remaining = (length - body.len()).min(chunk.len());
        let count = stream.read(&mut chunk[..remaining]).map_err(|_| 408u16)?;
        if count == 0 {
            return Err(400);
        }
        body.extend_from_slice(&chunk[..count]);
    }
    Ok(HttpRequest {
        method,
        client_id,
        body,
    })
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn write_response(stream: &mut TcpStream, status: u16, body: Option<&Value>) {
    write_session_response(stream, status, body, None);
}

fn write_session_response(
    stream: &mut TcpStream,
    status: u16,
    body: Option<&Value>,
    client_id: Option<&str>,
) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let body = body.map(Value::to_string).unwrap_or_default();
    let extra = if status == 405 {
        "Allow: POST, DELETE\r\n"
    } else if status == 401 {
        "WWW-Authenticate: Bearer\r\n"
    } else {
        ""
    };
    let session_header = client_id
        .map(|id| format!("Mcp-Session-Id: {id}\r\n"))
        .unwrap_or_default();
    let header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n{extra}{session_header}\r\n", body.len());
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}

fn resolve_client(session: &Session, client_id: Option<&str>) -> Result<String, u16> {
    let client_id = client_id.ok_or(400u16)?;
    let mut clients = session.clients.lock().map_err(|_| 503u16)?;
    let last_seen = clients.get_mut(client_id).ok_or(404u16)?;
    if last_seen.elapsed() > Duration::from_secs(CLIENT_IDLE_SECONDS) {
        clients.remove(client_id);
        return Err(404);
    }
    *last_seen = Instant::now();
    Ok(client_id.to_owned())
}

fn cancel_client_requests(session: &Session, client_id: &str, rpc_id: Option<&Value>) {
    if let Ok(mut pending) = session.pending.lock() {
        pending.retain(|_, request| {
            if request.client_id == client_id && rpc_id.is_none_or(|id| &request.rpc_id == id) {
                let _ = request.reply.send(tool_error("MCP 请求已取消。"));
                false
            } else {
                true
            }
        });
    }
}

fn serve(stream: &mut TcpStream, session: &Arc<Session>) {
    let request = match read_request(stream, session) {
        Ok(request) => request,
        Err(status) => {
            write_response(stream, status, None);
            return;
        }
    };
    if !session.live() {
        write_response(stream, 503, None);
        return;
    }
    if request.method != "POST" {
        let client_id = match resolve_client(session, request.client_id.as_deref()) {
            Ok(id) => id,
            Err(status) => {
                write_response(stream, status, None);
                return;
            }
        };
        if request.method == "DELETE" {
            if let Ok(mut clients) = session.clients.lock() {
                clients.remove(&client_id);
            }
            cancel_client_requests(session, &client_id, None);
            write_response(stream, 200, None);
        } else {
            write_response(stream, 405, None);
        }
        return;
    }
    let value: Value = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(_) => {
            write_response(
                stream,
                200,
                Some(&rpc_error(Value::Null, -32700, "Invalid JSON")),
            );
            return;
        }
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    let method = value.get("method").and_then(Value::as_str);
    if !value.is_object()
        || value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || method.is_none()
        || (!id.is_null() && !id.is_string() && !id.is_number())
    {
        write_response(
            stream,
            200,
            Some(&rpc_error(Value::Null, -32600, "Invalid request")),
        );
        return;
    }
    let method = method.unwrap_or_default();
    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        write_response(stream, 200, Some(&rpc_error(id, -32602, "Invalid params")));
        return;
    }
    let notification = !value
        .as_object()
        .is_some_and(|value| value.contains_key("id"));
    let client_id = if method == "initialize" && !notification {
        let mut clients = match session.clients.lock() {
            Ok(clients) => clients,
            Err(_) => {
                write_response(stream, 503, None);
                return;
            }
        };
        clients
            .retain(|_, last_seen| last_seen.elapsed() <= Duration::from_secs(CLIENT_IDLE_SECONDS));
        if clients.len() >= MAX_CLIENTS {
            write_response(stream, 503, None);
            return;
        }
        let id = match random_id() {
            Ok(id) => id,
            Err(_) => {
                write_response(stream, 503, None);
                return;
            }
        };
        clients.insert(id.clone(), Instant::now());
        id
    } else {
        match resolve_client(session, request.client_id.as_deref()) {
            Ok(id) => id,
            Err(status) => {
                write_response(stream, status, None);
                return;
            }
        }
    };
    if notification {
        if method == "notifications/cancelled" {
            if let Some(request_id) = params.get("requestId") {
                cancel_client_requests(session, &client_id, Some(request_id));
            }
        }
        write_session_response(stream, 202, None, Some(&client_id));
        return;
    }
    let response = match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version = if PROTOCOLS.contains(&requested) {
                requested
            } else {
                PROTOCOLS[0]
            };
            rpc_result(
                id,
                json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"Open Office","version":env!("CARGO_PKG_VERSION")},"instructions":format!("仅连接当前{}文档：{}。切换文档会停止服务。", session.document.kind, session.document.title)}),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({"tools":session.tools})),
        "tools/call" => call_tool(id, params, session, &client_id),
        _ => rpc_error(id, -32601, "Method not found"),
    };
    write_session_response(stream, 200, Some(&response), Some(&client_id));
}

fn call_tool(id: Value, params: Value, session: &Arc<Session>, client_id: &str) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return rpc_error(id, -32602, "Tool name is required");
    };
    if !session
        .tools
        .iter()
        .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
    {
        return rpc_error(id, -32602, "Unknown or unavailable tool");
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return rpc_error(id, -32602, "Tool arguments must be an object");
    }
    let request_id = match random_id() {
        Ok(id) => id,
        Err(error) => return rpc_result(id, tool_error(&error)),
    };
    let (reply, receive) = mpsc::channel();
    let deadline = Instant::now() + Duration::from_secs(REQUEST_SECONDS);
    {
        let Ok(mut pending) = session.pending.lock() else {
            return rpc_result(id, tool_error("MCP 请求不可用。"));
        };
        if !session.live() {
            return rpc_result(id, tool_error("MCP 服务已停止。"));
        }
        if pending.len() >= MAX_PENDING {
            return rpc_result(id, tool_error("MCP 请求过多，请稍后重试。"));
        }
        pending.insert(
            request_id.clone(),
            Pending {
                client_id: client_id.to_owned(),
                rpc_id: id.clone(),
                deadline,
                claimed: false,
                reply,
            },
        );
    }
    let event = ToolRequest {
        session_id: session.id.clone(),
        request_id: request_id.clone(),
        document_id: session.document.id.clone(),
        tool_name: name.to_owned(),
        arguments,
        deadline_at: now_millis() + REQUEST_SECONDS * 1000,
    };
    let result = if session.live() {
        match (session.dispatch)(event) {
            Ok(()) => receive
                .recv_timeout(Duration::from_secs(REQUEST_SECONDS))
                .unwrap_or_else(|_| tool_error("MCP 请求超时，请重试。")),
            Err(_) => tool_error("无法连接当前文档编辑器。"),
        }
    } else {
        tool_error("MCP 服务已停止。")
    };
    if let Ok(mut pending) = session.pending.lock() {
        pending.remove(&request_id);
    }
    rpc_result(id, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> McpConfig {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        McpConfig {
            port,
            token: "a".repeat(64),
            allow_edits: false,
        }
    }
    fn document(id: &str) -> McpDocument {
        McpDocument {
            id: id.into(),
            kind: "word".into(),
            title: "示例文档.docx".into(),
        }
    }
    fn tools() -> Vec<Value> {
        vec![
            json!({"name":"document_read","description":"Read active document","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}),
        ]
    }
    fn service() -> (tempfile::TempDir, Arc<McpService>) {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(McpService::new(directory.path().join("mcp.json")).unwrap());
        (directory, service)
    }
    fn request_raw(
        config: &McpConfig,
        method: &str,
        body: &str,
        extra: &str,
        token: &str,
    ) -> (u16, Option<Value>, Option<String>) {
        let mut stream = TcpStream::connect(("127.0.0.1", config.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(stream, "{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n{extra}\r\n{body}", config.port, body.len()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (header, body) = response.split_once("\r\n\r\n").unwrap();
        (
            header.split(' ').nth(1).unwrap().parse().unwrap(),
            if body.is_empty() {
                None
            } else {
                Some(serde_json::from_str(body).unwrap())
            },
            header
                .lines()
                .find_map(|line| line.strip_prefix("Mcp-Session-Id: ").map(str::to_owned)),
        )
    }
    fn initialize_client(config: &McpConfig) -> String {
        request_raw(config, "POST", r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#, "", &config.token).2.unwrap()
    }
    fn request(
        config: &McpConfig,
        method: &str,
        body: &str,
        extra: &str,
        token: &str,
    ) -> (u16, Option<Value>) {
        let initialize = serde_json::from_str::<Value>(body)
            .ok()
            .is_some_and(|value| value["method"] == "initialize");
        let extra = if !initialize
            && token == config.token
            && !extra.to_ascii_lowercase().contains("mcp-session-id:")
        {
            format!("{extra}Mcp-Session-Id: {}\r\n", initialize_client(config))
        } else {
            extra.to_owned()
        };
        let (status, body, _) = request_raw(config, method, body, &extra, token);
        (status, body)
    }
    fn rpc(config: &McpConfig, value: Value) -> Value {
        let (status, body) = request(config, "POST", &value.to_string(), "", &config.token);
        assert_eq!(status, 200);
        body.unwrap()
    }

    #[test]
    fn config_persists_privately_and_validates_permissions() {
        let (directory, service) = service();
        let initial = service.get_config().unwrap();
        assert_eq!(initial.token.len(), 64);
        assert!(initial.allow_edits);
        let custom = config();
        service.save_config(custom.clone()).unwrap();
        let restored = McpService::new(directory.path().join("mcp.json"))
            .unwrap()
            .get_config()
            .unwrap();
        assert_eq!(restored.token, custom.token);
        assert_eq!(restored.port, custom.port);
        assert!(!restored.allow_edits, "an explicitly saved read-only preference is retained");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(directory.path().join("mcp.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let mut invalid = custom.clone();
        invalid.port = 80;
        assert!(service.save_config(invalid).is_err());
        let mut invalid = custom.clone();
        invalid.token = "invalid token".repeat(4);
        assert!(service.save_config(invalid).is_err());
        let mut edits = tools();
        edits[0]["annotations"]["readOnlyHint"] = Value::Bool(false);
        assert!(service
            .start(custom.clone(), document("a"), edits, Arc::new(|_| Ok(())))
            .is_err());
        service
            .start(custom.clone(), document("a"), tools(), Arc::new(|_| Ok(())))
            .unwrap();
        assert!(service.save_config(custom).is_err());
    }

    #[test]
    fn real_http_initialization_catalog_auth_and_origin_guards() {
        let (_, service) = service();
        let config = config();
        let status = service
            .start(
                config.clone(),
                document("a"),
                tools(),
                Arc::new(|_| panic!("read never dispatches")),
            )
            .unwrap();
        assert!(status.running);
        assert_eq!(status.document_id.as_deref(), Some("a"));
        let initialized = rpc(
            &config,
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"Test","version":"1"}}}),
        );
        assert_eq!(initialized["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(
            initialized["result"]["capabilities"]["tools"]["listChanged"],
            false
        );
        assert_eq!(
            rpc(
                &config,
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})
            )["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            rpc(&config, json!({"jsonrpc":"2.0","id":3,"method":"ping"}))["result"],
            json!({})
        );
        assert_eq!(
            request(
                &config,
                "POST",
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                "",
                &config.token
            )
            .0,
            202
        );
        assert_eq!(request(&config, "GET", "", "", &config.token).0, 405);
        assert_eq!(request(&config, "POST", "{}", "", "bad-token").0, 401);
        assert_eq!(
            request(
                &config,
                "POST",
                "{}",
                "Origin: https://attacker.example\r\n",
                &config.token
            )
            .0,
            403
        );
        assert_eq!(
            request(
                &config,
                "POST",
                "{}",
                "Host: attacker.example\r\n",
                &config.token
            )
            .0,
            400
        );
        assert_eq!(
            request(
                &config,
                "POST",
                "{}",
                "MCP-Protocol-Version: unknown\r\n",
                &config.token
            )
            .0,
            400
        );
        assert_eq!(
            request(
                &config,
                "POST",
                "{}",
                "Transfer-Encoding: chunked\r\n",
                &config.token
            )
            .0,
            400
        );
        assert_eq!(
            rpc(
                &config,
                json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"missing"}})
            )["error"]["code"],
            -32602
        );
        assert_eq!(
            request(&config, "POST", "{", "", &config.token).1.unwrap()["error"]["code"],
            -32700
        );
        assert_eq!(rpc(&config, json!([]))["error"]["code"], -32600);
        assert_eq!(
            rpc(
                &config,
                json!({"jsonrpc":"2.0","id":6,"method":"ping","params":[]})
            )["error"]["code"],
            -32602
        );
    }

    #[test]
    fn tool_calls_require_claim_and_complete_over_real_http() {
        let (_, service) = service();
        let config = config();
        let (sender, events) = mpsc::channel();
        let status = service
            .start(
                config.clone(),
                document("a"),
                tools(),
                Arc::new(move |event| sender.send(event).map_err(|_| "closed".into())),
            )
            .unwrap();
        let session = status.session_id.unwrap();
        let client_config = config.clone();
        let client = thread::spawn(move || {
            rpc(
                &client_config,
                json!({"jsonrpc":"2.0","id":"read-1","method":"tools/call","params":{"name":"document_read","arguments":{"offset":2}}}),
            )
        });
        let event = events.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event.document_id, "a");
        assert_eq!(event.arguments["offset"], 2);
        assert!(event.deadline_at > now_millis());
        let result = json!({"content":[{"type":"text","text":"真实文档内容"}]});
        assert!(service
            .complete(&session, &event.request_id, result.clone())
            .is_err());
        assert!(!service.claim("stale-session", &event.request_id).unwrap());
        assert!(service.claim(&session, &event.request_id).unwrap());
        assert!(!service.claim(&session, &event.request_id).unwrap());
        service
            .complete(&session, &event.request_id, result.clone())
            .unwrap();
        let response = client.join().unwrap();
        assert_eq!(response["id"], "read-1");
        assert_eq!(response["result"], result);
        assert!(service
            .complete(&session, &event.request_id, result)
            .is_err());
    }

    #[test]
    fn inline_edit_assets_cross_http_and_oversized_bodies_are_rejected() {
        let (_, service) = service();
        let mut config = config();
        config.allow_edits = true;
        let (sender, events) = mpsc::channel();
        let catalog = vec![json!({"name":"document_edit", "inputSchema":{"type":"object"}, "annotations":{"readOnlyHint":false}})];
        let status = service.start(config.clone(), document("a"), catalog,
            Arc::new(move |event| sender.send(event).map_err(|_| "closed".into()))).unwrap();
        let client_config = config.clone();
        let client = thread::spawn(move || rpc(&client_config,
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"document_edit","arguments":{"assets":{"picture.png":"A".repeat(2 * 1024 * 1024)}}}})));
        let event = events.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(event.arguments["assets"]["picture.png"].as_str().unwrap().len(), 2 * 1024 * 1024);
        let session = status.session_id.unwrap();
        assert!(service.claim(&session, &event.request_id).unwrap());
        service.complete(&session, &event.request_id, json!({"content":[{"type":"text","text":"updated"}]})).unwrap();
        assert_eq!(client.join().unwrap()["result"]["content"][0]["text"], "updated");

        let mut stream = TcpStream::connect(("127.0.0.1", config.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        write!(stream, "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", config.port, config.token, MAX_BODY + 1).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 413 "), "{response}");
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn stopping_revokes_pending_and_old_session_cannot_affect_new_document() {
        let (_, service) = service();
        let config = config();
        let (sender, events) = mpsc::channel();
        let old = service
            .start(
                config.clone(),
                document("a"),
                tools(),
                Arc::new(move |event| sender.send(event).map_err(|_| "closed".into())),
            )
            .unwrap()
            .session_id
            .unwrap();
        let client_config = config.clone();
        let client = thread::spawn(move || {
            rpc(
                &client_config,
                json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"document_read"}}),
            )
        });
        let event = events.recv_timeout(Duration::from_secs(2)).unwrap();
        service.stop(Some(&old)).unwrap();
        assert_eq!(client.join().unwrap()["result"]["isError"], true);
        let new = service
            .start(config.clone(), document("b"), tools(), Arc::new(|_| Ok(())))
            .unwrap();
        assert_ne!(new.session_id.as_ref().unwrap(), &old);
        assert!(!service.claim(&old, &event.request_id).unwrap());
        assert!(service
            .complete(&old, &event.request_id, json!({"content":[]}))
            .is_err());
        assert!(service.heartbeat(&old).is_err());
        assert_eq!(
            service.stop(Some(&old)).unwrap().document_id.as_deref(),
            Some("b")
        );
        assert!(
            service
                .heartbeat(new.session_id.as_ref().unwrap())
                .unwrap()
                .running
        );
        service.stop(None).unwrap();
        assert!(!service.status().running);
        assert!(TcpStream::connect(("127.0.0.1", config.port)).is_err());
    }

    #[test]
    fn lease_expiry_and_request_deadline_refuse_late_claims() {
        let (_, service) = service();
        let config = config();
        let (sender, events) = mpsc::channel();
        let session_id = service
            .start(
                config.clone(),
                document("a"),
                tools(),
                Arc::new(move |event| sender.send(event).map_err(|_| "closed".into())),
            )
            .unwrap()
            .session_id
            .unwrap();
        let client_config = config.clone();
        let client = thread::spawn(move || {
            rpc(
                &client_config,
                json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"document_read"}}),
            )
        });
        let event = events.recv_timeout(Duration::from_secs(2)).unwrap();
        {
            let session = service.session.lock().unwrap();
            let session = session.as_ref().unwrap();
            session
                .pending
                .lock()
                .unwrap()
                .get_mut(&event.request_id)
                .unwrap()
                .deadline = Instant::now() - Duration::from_secs(1);
        }
        assert!(!service.claim(&session_id, &event.request_id).unwrap());
        {
            let session = service.session.lock().unwrap();
            session
                .as_ref()
                .unwrap()
                .heartbeat
                .store(now_millis() - LEASE_MILLIS - 1, Ordering::Release);
        }
        assert!(!service.status().running);
        assert!(service.heartbeat(&session_id).is_err());
        assert_eq!(client.join().unwrap()["result"]["isError"], true);
        service.stop(None).unwrap();
        assert!(TcpStream::connect(("127.0.0.1", config.port)).is_err());
    }

    #[test]
    fn occupied_port_never_reports_running() {
        let (_, service) = service();
        let config = config();
        let _listener = TcpListener::bind(("127.0.0.1", config.port)).unwrap();
        assert!(service
            .start(config, document("a"), tools(), Arc::new(|_| Ok(())))
            .is_err());
        assert!(!service.status().running);
    }

    #[test]
    fn http_client_sessions_reject_missing_stale_and_disconnected_clients() {
        let (_, service) = service();
        let config = config();
        service
            .start(config.clone(), document("a"), tools(), Arc::new(|_| Ok(())))
            .unwrap();
        let client = initialize_client(&config);
        let headers = format!("Mcp-Session-Id: {client}\r\n");
        let ping = r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#;
        assert_eq!(request_raw(&config, "POST", ping, "", &config.token).0, 400);
        assert_eq!(
            request_raw(&config, "POST", ping, &headers, &config.token).0,
            200
        );
        service.stop(None).unwrap();
        service
            .start(config.clone(), document("b"), tools(), Arc::new(|_| Ok(())))
            .unwrap();
        assert_eq!(
            request_raw(&config, "POST", ping, &headers, &config.token).0,
            404
        );
        let new_client = initialize_client(&config);
        let new_headers = format!("Mcp-Session-Id: {new_client}\r\n");
        assert_eq!(
            request_raw(&config, "DELETE", "", &new_headers, &config.token).0,
            200
        );
        assert_eq!(
            request_raw(&config, "POST", ping, &new_headers, &config.token).0,
            404
        );
        assert!(service.status().running);
    }

    #[test]
    fn client_cancellation_releases_only_its_pending_requests() {
        let (_, service) = service();
        let config = config();
        let (sender, events) = mpsc::channel();
        let runtime = service
            .start(
                config.clone(),
                document("a"),
                tools(),
                Arc::new(move |event| sender.send(event).map_err(|_| "closed".into())),
            )
            .unwrap()
            .session_id
            .unwrap();
        let client = initialize_client(&config);
        let headers = format!("Mcp-Session-Id: {client}\r\n");
        let client_config = config.clone();
        let client_headers = headers.clone();
        let pending = thread::spawn(move || {
            request_raw(
                &client_config,
                "POST",
                r#"{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"document_read"}}"#,
                &client_headers,
                &client_config.token,
            )
        });
        let event = events.recv_timeout(Duration::from_secs(2)).unwrap();
        let other = initialize_client(&config);
        let cancellation =
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":42}}"#;
        assert_eq!(
            request_raw(
                &config,
                "POST",
                cancellation,
                &format!("Mcp-Session-Id: {other}\r\n"),
                &config.token
            )
            .0,
            202
        );
        assert!(service
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .unwrap()
            .contains_key(&event.request_id));
        assert_eq!(
            request_raw(&config, "POST", cancellation, &headers, &config.token).0,
            202
        );
        assert!(pending.join().unwrap().1.unwrap()["result"]["isError"]
            .as_bool()
            .unwrap());
        assert!(!service.claim(&runtime, &event.request_id).unwrap());
    }

    #[test]
    fn damaged_optional_config_does_not_prevent_application_startup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mcp.json");
        std::fs::write(&path, "damaged").unwrap();
        let service = McpService::new(path.clone()).unwrap();
        assert!(service.get_config().is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "damaged");
        service.save_config(config()).unwrap();
        assert!(service.get_config().is_ok());
    }

    #[test]
    fn accepted_connections_wait_for_delayed_headers_and_body() {
        let (_, service) = service();
        let config = config();
        service
            .start(config.clone(), document("a"), tools(), Arc::new(|_| Ok(())))
            .unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", config.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        // Ensure accept runs before any bytes arrive; a nonblocking accepted
        // socket would return WouldBlock here instead of honoring its timeout.
        thread::sleep(Duration::from_millis(50));
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#;
        write!(
            stream,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n",
            config.port, config.token
        )
        .unwrap();
        thread::sleep(Duration::from_millis(20));
        write!(
            stream,
            "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        thread::sleep(Duration::from_millis(20));
        stream.write_all(&body.as_bytes()[..20]).unwrap();
        thread::sleep(Duration::from_millis(20));
        stream.write_all(&body.as_bytes()[20..]).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
        let json: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(json["result"]["protocolVersion"], "2025-03-26");
    }
}
