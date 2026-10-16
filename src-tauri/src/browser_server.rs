//! An explicitly started browser workspace, separate from the desktop IPC origin.
//! The random URL grants access only to published snapshots and packaged assets.
//! Accepted revisions are durable; they never write an original user file.
use base64::{engine::general_purpose::STANDARD, Engine};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const DOCUMENT_LIMIT: usize = 40 * 1024 * 1024;
const WORKSPACE_LIMIT: u64 = 64 * 1024 * 1024;
const DOCUMENT_COUNT_LIMIT: usize = 64;
const BODY_LIMIT: usize = 56 * 1024 * 1024;
const HISTORY_LIMIT: u64 = 90 * 1024 * 1024;
const HEADER_LIMIT: usize = 16 * 1024;
const CONNECTION_LIMIT: usize = 32;
const UPLOAD_LIMIT: usize = 2;
const MAX_SAFE_VERSION: u64 = (1_u64 << 53) - 1;
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserServerStatus {
    pub running: bool,
    pub local_url: Option<String>,
    pub lan_urls: Vec<String>,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub status_code: u16,
    pub body: Value,
}

impl SyncResponse {
    fn ok(body: Value) -> Self {
        Self {
            status_code: 200,
            body,
        }
    }
    fn error(status_code: u16, message: &str) -> Self {
        Self {
            status_code,
            body: json!({"error": message}),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentSummary {
    id: String,
    name: String,
    extension: String,
    kind: String,
    sha256: String,
    size_bytes: u64,
    version: u64,
    updated_by: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedDocument {
    #[serde(flatten)]
    summary: DocumentSummary,
    base64: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Workspace {
    format_version: u32,
    revision: u64,
    documents: BTreeMap<String, SharedDocument>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishRequest {
    id: String,
    expected_version: u64,
    client_id: String,
    name: String,
    extension: String,
    base64: String,
}

struct WorkspaceStore {
    path: PathBuf,
    state: Mutex<Workspace>,
}

pub struct BrowserServerManager {
    root: PathBuf,
    store: Arc<WorkspaceStore>,
    running: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    local_url: String,
    lan_urls: Vec<String>,
    active: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct ServerContext {
    root: PathBuf,
    prefix: String,
    active: Arc<AtomicBool>,
    store: Arc<WorkspaceStore>,
    uploads: Arc<AtomicUsize>,
}

/// Captured by the smoke-only native bridge, never serialized or supplied by IPC.
pub(crate) struct NativeSmokeEndpoint {
    address: SocketAddr,
    prefix: String,
}

impl NativeSmokeEndpoint {
    pub(crate) fn assert_revoked(&self) -> Result<(), String> {
        match TcpStream::connect_timeout(&self.address, Duration::from_secs(2)) {
            Err(_) => Ok(()),
            Ok(_) => Err("Stopped browser workspace still accepts native TCP connections.".into()),
        }
    }

    fn request(
        &self,
        method: &str,
        suffix: &str,
        body: Option<&Value>,
        origin: Option<&str>,
        range: Option<&str>,
    ) -> Result<(u16, Vec<u8>), String> {
        // This endpoint was derived from this manager's own loopback listener.
        // No host, scheme, port, credential or arbitrary path is accepted via IPC.
        let mut stream = TcpStream::connect_timeout(&self.address, Duration::from_secs(5))
            .map_err(|error| format!("Native workspace TCP connection failed: {error}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| error.to_string())?;
        let bytes = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| error.to_string())?;
        write!(
            stream,
            "{method} {}{suffix} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
            self.prefix, self.address
        )
        .map_err(|error| error.to_string())?;
        if let Some(origin) = origin {
            write!(stream, "Origin: {origin}\r\n").map_err(|error| error.to_string())?;
        }
        if let Some(range) = range {
            write!(stream, "Range: {range}\r\n").map_err(|error| error.to_string())?;
        }
        if let Some(bytes) = &bytes {
            write!(
                stream,
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                bytes.len()
            )
            .map_err(|error| error.to_string())?;
        }
        stream
            .write_all(b"\r\n")
            .map_err(|error| error.to_string())?;
        if let Some(bytes) = &bytes {
            stream.write_all(bytes).map_err(|error| error.to_string())?;
        }
        let limit = BODY_LIMIT + HEADER_LIMIT;
        let mut response = Vec::new();
        stream
            .take(limit as u64 + 1)
            .read_to_end(&mut response)
            .map_err(|error| error.to_string())?;
        if response.len() > limit {
            return Err("Native workspace HTTP response exceeds its limit.".into());
        }
        let boundary = response
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .ok_or("Native workspace HTTP response lacks headers.")?;
        if boundary > HEADER_LIMIT {
            return Err("Native workspace HTTP response headers exceed their limit.".into());
        }
        let headers = std::str::from_utf8(&response[..boundary])
            .map_err(|_| "Native workspace HTTP headers are invalid.")?;
        let status = headers
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|status| status.parse::<u16>().ok())
            .ok_or("Native workspace HTTP status is invalid.")?;
        let length = headers
            .split("\r\n")
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            })
            .ok_or("Native workspace HTTP length is missing.")?;
        let body = response.split_off(boundary + 4);
        if body.len() != length {
            return Err("Native workspace HTTP response was truncated.".into());
        }
        Ok((status, body))
    }
}

impl BrowserServerManager {
    pub fn new(root: PathBuf, workspace_directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&workspace_directory)
            .map_err(|error| format!("无法创建浏览器工作区：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&workspace_directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("无法保护浏览器工作区：{error}"))?;
        }
        let path = workspace_directory.join("workspace.json");
        let state = if path.exists() {
            let file =
                File::open(&path).map_err(|error| format!("无法读取浏览器工作区：{error}"))?;
            if file.metadata().map_err(|error| error.to_string())?.len() > HISTORY_LIMIT {
                return Err("浏览器工作区超过大小限制，请保留原文件后重新建立工作区。".into());
            }
            let mut bytes = Vec::new();
            file.take(HISTORY_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() as u64 > HISTORY_LIMIT {
                return Err("浏览器工作区超过大小限制。".into());
            }
            let state: Workspace = serde_json::from_slice(&bytes)
                .map_err(|error| format!("浏览器工作区记录损坏，原文件已保留：{error}"))?;
            validate_workspace(&state)?;
            state
        } else {
            Workspace {
                format_version: 1,
                revision: 0,
                documents: BTreeMap::new(),
            }
        };
        Ok(Self {
            root,
            store: Arc::new(WorkspaceStore {
                path,
                state: Mutex::new(state),
            }),
            running: Mutex::new(None),
        })
    }

    pub fn status(&self) -> Result<BrowserServerStatus, String> {
        let running = self.running.lock().map_err(|_| "浏览器服务状态不可用。")?;
        self.status_locked(running.as_ref())
    }

    fn status_locked(
        &self,
        running: Option<&RunningServer>,
    ) -> Result<BrowserServerStatus, String> {
        let revision = self
            .store
            .state
            .lock()
            .map_err(|_| "浏览器工作区状态不可用。")?
            .revision;
        Ok(BrowserServerStatus {
            running: running.is_some(),
            local_url: running.map(|server| server.local_url.clone()),
            lan_urls: running
                .map(|server| server.lan_urls.clone())
                .unwrap_or_default(),
            revision,
        })
    }

    pub fn start(&self) -> Result<BrowserServerStatus, String> {
        let mut running = self.running.lock().map_err(|_| "浏览器服务状态不可用。")?;
        if running.is_some() {
            return self.status_locked(running.as_ref());
        }
        let root = self
            .root
            .canonicalize()
            .map_err(|_| "找不到浏览器界面资源，请先完成应用构建。")?;
        if !root.join("index.html").is_file() {
            return Err("浏览器界面资源缺少 index.html。".into());
        }
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| "无法生成浏览器访问链接。")?;
        let prefix = format!("/{}/", hex::encode(random));
        let socket = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|error| format!("无法启动浏览器服务：{error}"))?;
        let port = socket
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        socket
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let url = |host: &str| format!("http://{host}:{port}{prefix}?workspace=shared");
        let local_url = url("127.0.0.1");
        let lan_urls = local_ipv4_addresses()
            .iter()
            .map(|address| url(&address.to_string()))
            .collect();
        let active = Arc::new(AtomicBool::new(true));
        let context = ServerContext {
            root,
            prefix,
            active: active.clone(),
            store: self.store.clone(),
            uploads: Arc::new(AtomicUsize::new(0)),
        };
        let connections = Arc::new(AtomicUsize::new(0));
        let listener = thread::Builder::new()
            .name("office-browser-listener".into())
            .spawn(move || {
                while context.active.load(Ordering::Acquire) {
                    match socket.accept() {
                        Ok((mut stream, _)) => {
                            if stream.set_nonblocking(false).is_err()
                                || stream
                                    .set_read_timeout(Some(Duration::from_secs(10)))
                                    .is_err()
                                || stream
                                    .set_write_timeout(Some(Duration::from_secs(60)))
                                    .is_err()
                            {
                                continue;
                            }
                            let Some(guard) = CounterGuard::acquire(&connections, CONNECTION_LIMIT)
                            else {
                                let _ = send_json(
                                    &mut stream,
                                    SyncResponse::error(503, "浏览器服务繁忙，请稍后重试。"),
                                    false,
                                );
                                continue;
                            };
                            let source = context.clone();
                            let _ = thread::Builder::new()
                                .name("office-browser-request".into())
                                .spawn(move || {
                                    let _guard = guard;
                                    let _ = serve(&mut stream, &source);
                                });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(15))
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|error| format!("无法启动浏览器服务线程：{error}"))?;
        *running = Some(RunningServer {
            local_url,
            lan_urls,
            active,
            listener: Some(listener),
        });
        self.status_locked(running.as_ref())
    }

    pub fn stop(&self) -> Result<BrowserServerStatus, String> {
        let mut running = self.running.lock().map_err(|_| "浏览器服务状态不可用。")?;
        if let Some(mut server) = running.take() {
            // Fence every pending mutation before revoking the old URL. A body
            // still arriving on an accepted socket must not publish after stop.
            {
                let _state = self
                    .store
                    .state
                    .lock()
                    .map_err(|_| "浏览器工作区状态不可用。")?;
                server.active.store(false, Ordering::Release);
            }
            if let Some(listener) = server.listener.take() {
                let _ = listener.join();
            }
        }
        self.status_locked(None)
    }

    /// Desktop IPC dispatches the identical protocol without exposing IPC to LAN.
    pub fn dispatch(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<SyncResponse, String> {
        let active = {
            let running = self.running.lock().map_err(|_| "浏览器服务状态不可用。")?;
            let Some(server) = running.as_ref() else {
                return Ok(SyncResponse::error(503, "浏览器服务尚未启动。"));
            };
            server.active.clone()
        };
        self.store
            .dispatch(&active, method, path.trim_start_matches('/'), body)
    }

    /// Called only after the desktop IPC bridge checks opt-in smoke mode and
    /// uses the session's isolated workspace. All checks use real local TCP.
    pub(crate) fn native_smoke_probe(
        &self,
        id: &str,
        replacement_base64: &str,
    ) -> Result<(Value, NativeSmokeEndpoint), String> {
        if !valid_identifier(id) {
            return Err("Invalid native workspace smoke document ID.".into());
        }
        let endpoint = {
            let running = self
                .running
                .lock()
                .map_err(|_| "Browser workspace state unavailable.")?;
            let server = running.as_ref().ok_or(
                "Start the browser server through its normal IPC command before probing it.",
            )?;
            let raw = server
                .local_url
                .strip_prefix("http://")
                .ok_or("Invalid native workspace listener URL.")?;
            let (authority, target) = raw
                .split_once('/')
                .ok_or("Invalid native workspace listener URL.")?;
            let address: SocketAddr = authority
                .parse()
                .map_err(|_| "Invalid native workspace listener address.")?;
            if !address.ip().is_loopback() {
                return Err("Native workspace smoke requires its own loopback listener.".into());
            }
            NativeSmokeEndpoint {
                address,
                prefix: format!("/{}", target.split('?').next().unwrap_or("")),
            }
        };
        let assert_status = |actual: u16, expected: u16| -> Result<(), String> {
            if actual == expected {
                Ok(())
            } else {
                Err(format!(
                    "Native workspace HTTP status {actual}; expected {expected}."
                ))
            }
        };
        let parse = |bytes: &[u8]| {
            serde_json::from_slice::<Value>(bytes)
                .map_err(|error| format!("Invalid native workspace HTTP JSON: {error}"))
        };
        let (index_status, index) = endpoint.request("GET", "", None, None, None)?;
        assert_status(index_status, 200)?;
        let installed_index =
            fs::read(self.root.join("index.html")).map_err(|error| error.to_string())?;
        if index.is_empty() || index != installed_index {
            return Err("Native workspace served different installed frontend assets.".into());
        }
        let (range_status, range) = endpoint.request(
            "GET",
            "office-pdf/office_pdf_bg.wasm",
            None,
            None,
            Some("bytes=0-7"),
        )?;
        assert_status(range_status, 206)?;
        if range != b"\0asm\x01\0\0\0" {
            return Err("Native workspace did not serve a complete WASM range.".into());
        }
        let (state_status, state) = endpoint.request("GET", "_sync/state", None, None, None)?;
        assert_status(state_status, 200)?;
        let state = parse(&state)?;
        if state["running"] != true
            || !state["documents"]
                .as_array()
                .is_some_and(|documents| documents.iter().any(|document| document["id"] == id))
        {
            return Err("Native workspace state omitted the published document.".into());
        }
        let path = format!("_sync/documents/{id}");
        let (document_status, initial) = endpoint.request("GET", &path, None, None, None)?;
        assert_status(document_status, 200)?;
        let initial: SharedDocument =
            serde_json::from_slice(&initial).map_err(|error| error.to_string())?;
        let (_, replacement_hash, _) = validate_document(
            id,
            "native-http-smoke",
            &initial.summary.name,
            &initial.summary.extension,
            replacement_base64,
        )?;
        if replacement_hash == initial.summary.sha256 {
            return Err(
                "Native workspace smoke requires genuinely different edited document bytes.".into(),
            );
        }
        let initial_version = initial.summary.version;
        let initial_hash = initial.summary.sha256.clone();
        let request = json!({"id":id,"expectedVersion":initial_version,"clientId":"native-http-smoke","name":initial.summary.name,"extension":initial.summary.extension,"base64":replacement_base64});
        let origin = format!("http://{}", endpoint.address);
        let (write_status, accepted) = endpoint.request(
            "POST",
            "_sync/documents",
            Some(&request),
            Some(&origin),
            None,
        )?;
        assert_status(write_status, 200)?;
        let accepted = parse(&accepted)?;
        if accepted["status"] != "accepted"
            || accepted["document"]["sha256"] != replacement_hash
            || accepted["document"]["version"] != initial_version + 1
        {
            return Err("Native workspace did not accept exactly one edited revision.".into());
        }
        let stale = json!({"id":id,"expectedVersion":initial_version,"clientId":"native-stale-smoke","name":initial.summary.name,"extension":initial.summary.extension,"base64":initial.base64});
        let (stale_write_status, conflict) =
            endpoint.request("POST", "_sync/documents", Some(&stale), Some(&origin), None)?;
        assert_status(stale_write_status, 409)?;
        let conflict = parse(&conflict)?;
        if conflict["status"] != "conflict" || conflict["document"]["sha256"] != replacement_hash {
            return Err("Native workspace lost the accepted revision during a stale write.".into());
        }
        let (wrong_origin_status, _) = endpoint.request(
            "POST",
            "_sync/documents",
            Some(&json!({})),
            Some("http://invalid.example"),
            None,
        )?;
        assert_status(wrong_origin_status, 403)?;
        let (readback_status, readback) = endpoint.request("GET", &path, None, None, None)?;
        assert_status(readback_status, 200)?;
        let readback = parse(&readback)?;
        if readback["base64"] != replacement_base64
            || readback["sha256"] != replacement_hash
            || readback["version"] != initial_version + 1
        {
            return Err(
                "Native workspace HTTP readback does not match the accepted snapshot.".into(),
            );
        }
        Ok((
            json!({"schemaVersion":1,"execution":"native-tcp","documentId":id,
            "initialVersion":initial_version,"acceptedVersion":initial_version + 1,"initialSha256":initial_hash,"acceptedSha256":replacement_hash,
            "assetIndex":true,"wasmRange":true,"stateRead":true,"documentRead":true,"writeAccepted":true,"staleWriteRejected":true,"readback":true,"wrongOriginRejected":true,
            "indexStatus":index_status,"rangeStatus":range_status,"stateStatus":state_status,"documentStatus":document_status,"writeStatus":write_status,"staleWriteStatus":stale_write_status,"readbackStatus":readback_status,"wrongOriginStatus":wrong_origin_status,
            "indexBytes":index.len(),"indexSha256":hex::encode(Sha256::digest(&index)),"rangeBytes":range.len()}),
            endpoint,
        ))
    }
}

impl Drop for BrowserServerManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

impl WorkspaceStore {
    fn dispatch(
        &self,
        active: &AtomicBool,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<SyncResponse, String> {
        let mut state = self.state.lock().map_err(|_| "浏览器工作区状态不可用。")?;
        if !active.load(Ordering::Acquire) {
            return Ok(SyncResponse::error(503, "浏览器服务已停止，此链接已失效。"));
        }
        match (method, path) {
            ("GET", "_sync/state") => Ok(SyncResponse::ok(json!({
                "running": true, "revision": state.revision,
                "documents": state.documents.values().map(|document| &document.summary).collect::<Vec<_>>()
            }))),
            ("GET", path) if path.starts_with("_sync/documents/") => {
                let id = &path["_sync/documents/".len()..];
                match state.documents.get(id) {
                    Some(document) => Ok(SyncResponse::ok(json!(document))),
                    None => Ok(SyncResponse::error(404, "找不到共享文档。")),
                }
            }
            ("POST", "_sync/documents") => {
                let request: PublishRequest =
                    match serde_json::from_value(body.unwrap_or(Value::Null)) {
                        Ok(request) => request,
                        Err(_) => return Ok(SyncResponse::error(400, "共享文档请求格式无效。")),
                    };
                if request.expected_version > MAX_SAFE_VERSION {
                    return Ok(SyncResponse::error(400, "共享版本号无效。"));
                }
                let (size, sha256, kind) = match validate_document(
                    &request.id,
                    &request.client_id,
                    &request.name,
                    &request.extension,
                    &request.base64,
                ) {
                    Ok(values) => values,
                    Err(message) => return Ok(SyncResponse::error(400, &message)),
                };
                let current = state.documents.get(&request.id);
                if let Some(document) = current {
                    if document.summary.sha256 == sha256
                        && document.summary.name == request.name
                        && document.summary.extension == request.extension
                    {
                        return Ok(SyncResponse::ok(
                            json!({"status":"accepted", "document":document.summary}),
                        ));
                    }
                    if document.summary.version != request.expected_version {
                        return Ok(SyncResponse {
                            status_code: 409,
                            body: json!({"status":"conflict", "document":document.summary}),
                        });
                    }
                } else if request.expected_version != 0 {
                    return Ok(SyncResponse::error(
                        404,
                        "共享文档不存在；请保留本地内容并重新读取工作区。",
                    ));
                }
                if current.is_none() && state.documents.len() >= DOCUMENT_COUNT_LIMIT {
                    return Ok(SyncResponse::error(413, "共享文档数量已达到 64 个上限。"));
                }
                let total: u64 = state
                    .documents
                    .values()
                    .map(|document| document.summary.size_bytes)
                    .sum();
                if total
                    - current
                        .map(|document| document.summary.size_bytes)
                        .unwrap_or(0)
                    + size
                    > WORKSPACE_LIMIT
                {
                    return Ok(SyncResponse::error(
                        413,
                        "共享工作区总大小超过 64 MB，原有版本已保留。",
                    ));
                }
                let version = current
                    .map(|document| document.summary.version)
                    .unwrap_or(0)
                    .checked_add(1)
                    .filter(|version| *version <= MAX_SAFE_VERSION)
                    .ok_or("共享文档版本号已耗尽。")?;
                let revision = state
                    .revision
                    .checked_add(1)
                    .filter(|revision| *revision <= MAX_SAFE_VERSION)
                    .ok_or("共享工作区版本号已耗尽。")?;
                let document = SharedDocument {
                    summary: DocumentSummary {
                        id: request.id.clone(),
                        name: request.name,
                        extension: request.extension,
                        kind: kind.into(),
                        sha256,
                        size_bytes: size,
                        version,
                        updated_by: request.client_id,
                    },
                    base64: request.base64,
                };
                let summary = document.summary.clone();
                let previous = state.documents.insert(request.id.clone(), document);
                let previous_revision = state.revision;
                state.revision = revision;
                if let Err(error) = self.persist(&state) {
                    state.revision = previous_revision;
                    if let Some(previous) = previous {
                        state.documents.insert(request.id, previous);
                    } else {
                        state.documents.remove(&request.id);
                    }
                    return Ok(SyncResponse::error(507, &error));
                }
                Ok(SyncResponse::ok(
                    json!({"status":"accepted", "document":summary}),
                ))
            }
            (_, "_sync/state" | "_sync/documents") => {
                Ok(SyncResponse::error(405, "不支持此请求方法。"))
            }
            _ => Ok(SyncResponse::error(404, "找不到浏览器工作区接口。")),
        }
    }

    fn persist(&self, state: &Workspace) -> Result<(), String> {
        let parent = self.path.parent().ok_or("浏览器工作区路径无效。")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("无法保存共享版本，原版本已保留：{error}"))?;
        serde_json::to_writer(&mut temporary, state)
            .map_err(|error| format!("无法写入共享版本，原版本已保留：{error}"))?;
        temporary
            .flush()
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|error| format!("无法同步共享版本，原版本已保留：{error}"))?;
        temporary
            .persist(&self.path)
            .map_err(|error| format!("无法提交共享版本，原版本已保留：{error}"))?;
        Ok(())
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_document(
    id: &str,
    client: &str,
    name: &str,
    extension: &str,
    encoded: &str,
) -> Result<(u64, String, &'static str), String> {
    if !valid_identifier(id) || !valid_identifier(client) {
        return Err("文档或客户端标识无效。".into());
    }
    let kind = match extension {
        "docx" => "word",
        "xlsx" => "sheet",
        "pptx" => "presentation",
        "pdf" => "pdf",
        _ => return Err("共享文档仅支持 DOCX、XLSX、PPTX 和 PDF。".into()),
    };
    if name.is_empty()
        || name.trim() != name
        || name.starts_with('\u{feff}')
        || name.ends_with('\u{feff}')
        || name.len() > 240
        || name.starts_with('.')
        || name.ends_with(['.', ' '])
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
                )
        })
        || !name
            .to_ascii_lowercase()
            .ends_with(&format!(".{extension}"))
    {
        return Err("共享文件名或扩展名无效。".into());
    }
    let device = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("共享文件名属于系统保留名称。".into());
    }
    if encoded.len() > DOCUMENT_LIMIT.div_ceil(3) * 4 {
        return Err("共享文档超过 40 MB 上限。".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "共享文档不是有效的 Base64 数据。")?;
    if bytes.is_empty() || bytes.len() > DOCUMENT_LIMIT {
        return Err("共享文档为空或超过 40 MB 上限。".into());
    }
    if STANDARD.encode(&bytes) != encoded {
        return Err("共享文档 Base64 编码不规范。".into());
    }
    let valid = if extension == "pdf" {
        bytes[..bytes.len().min(1024)]
            .windows(5)
            .any(|part| part == b"%PDF-")
    } else {
        bytes.len() >= 30 && bytes.starts_with(b"PK\x03\x04")
    };
    if !valid {
        return Err("共享文档内容与格式不符；原有版本已保留。".into());
    }
    Ok((
        bytes.len() as u64,
        hex::encode(Sha256::digest(&bytes)),
        kind,
    ))
}

fn validate_workspace(state: &Workspace) -> Result<(), String> {
    if state.format_version != 1
        || state.revision > MAX_SAFE_VERSION
        || state.documents.len() > DOCUMENT_COUNT_LIMIT
    {
        return Err("浏览器工作区记录版本或数量无效。".into());
    }
    let mut total = 0;
    for (id, document) in &state.documents {
        let summary = &document.summary;
        let (size, hash, kind) = validate_document(
            id,
            &summary.updated_by,
            &summary.name,
            &summary.extension,
            &document.base64,
        )?;
        if id != &summary.id
            || summary.size_bytes != size
            || summary.sha256 != hash
            || summary.kind != kind
            || summary.version == 0
            || summary.version > state.revision
        {
            return Err("浏览器工作区校验失败，原文件已保留。".into());
        }
        total += size;
    }
    if total > WORKSPACE_LIMIT {
        return Err("浏览器工作区超过 64 MB 总大小上限。".into());
    }
    Ok(())
}

fn local_ipv4_addresses() -> BTreeSet<Ipv4Addr> {
    let mut addresses = BTreeSet::new();
    // UDP connect selects a local route without sending a packet or contacting
    // another service. Multiple routes also work when the default route is absent.
    for target in [
        "192.0.2.1:9",
        "192.168.255.255:9",
        "10.255.255.255:9",
        "172.31.255.255:9",
    ] {
        if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
            if socket.connect(target).is_ok() {
                if let Ok(SocketAddr::V4(address)) = socket.local_addr() {
                    if !address.ip().is_loopback() && !address.ip().is_unspecified() {
                        addresses.insert(*address.ip());
                    }
                }
            }
        }
    }
    addresses
}

struct CounterGuard(Arc<AtomicUsize>);
impl CounterGuard {
    fn acquire(counter: &Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        if counter.fetch_add(1, Ordering::AcqRel) >= limit {
            counter.fetch_sub(1, Ordering::AcqRel);
            None
        } else {
            Some(Self(counter.clone()))
        }
    }
}
impl Drop for CounterGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn write_headers(
    stream: &mut TcpStream,
    status: u16,
    mime: &str,
    length: u64,
    extra: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Content Too Large",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        507 => "Insufficient Storage",
        _ => "Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nConnection: close\r\nCache-Control: no-store\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {CSP}\r\n{extra}\r\n")
}

fn send_json(stream: &mut TcpStream, response: SyncResponse, head: bool) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&response.body)?;
    write_headers(
        stream,
        response.status_code,
        "application/json; charset=utf-8",
        bytes.len() as u64,
        "",
    )?;
    if !head {
        stream.write_all(&bytes)?;
    }
    stream.flush()
}

fn serve(stream: &mut TcpStream, context: &ServerContext) -> std::io::Result<()> {
    let mut input = Vec::new();
    let mut chunk = [0_u8; 8192];
    let header_end = loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        input.extend_from_slice(&chunk[..count]);
        if let Some(position) = input.windows(4).position(|part| part == b"\r\n\r\n") {
            if position + 4 > HEADER_LIMIT {
                return send_json(stream, SyncResponse::error(431, "请求头过大。"), false);
            }
            break position + 4;
        }
        if input.len() > HEADER_LIMIT {
            return send_json(stream, SyncResponse::error(431, "请求头过大。"), false);
        }
    };
    let header = match std::str::from_utf8(&input[..header_end]) {
        Ok(value) => value.to_owned(),
        Err(_) => return send_json(stream, SyncResponse::error(400, "请求头无效。"), false),
    };
    let mut lines = header.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.0" | "HTTP/1.1") {
        return send_json(stream, SyncResponse::error(400, "请求格式无效。"), false);
    }
    let method = parts[0];
    let head = method == "HEAD";
    let mut fields = BTreeMap::new();
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return send_json(stream, SyncResponse::error(400, "请求头无效。"), head);
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || fields
                .insert(name.to_ascii_lowercase(), value.trim())
                .is_some()
        {
            return send_json(stream, SyncResponse::error(400, "请求头重复或无效。"), head);
        }
    }
    let local = stream.local_addr()?;
    let host = fields.get("host").copied().unwrap_or("");
    let valid_host = host == local.to_string()
        || (local.ip().is_loopback() && host == format!("localhost:{}", local.port()));
    if !valid_host || fields.contains_key("transfer-encoding") {
        return send_json(
            stream,
            SyncResponse::error(403, "此请求不属于当前浏览器服务。"),
            head,
        );
    }
    let origin = format!("http://{host}");
    if fields.get("origin").is_some_and(|value| *value != origin) {
        return send_json(
            stream,
            SyncResponse::error(403, "不允许跨站访问共享工作区。"),
            head,
        );
    }
    let target = parts[1].split('?').next().unwrap_or("");
    let Some(path) = target.strip_prefix(&context.prefix) else {
        return send_json(stream, SyncResponse::error(404, "访问链接无效。"), head);
    };
    if !context.active.load(Ordering::Acquire) {
        return send_json(stream, SyncResponse::error(503, "浏览器服务已停止。"), head);
    }
    if method == "POST" {
        if path != "_sync/documents" {
            return send_json(stream, SyncResponse::error(404, "找不到共享接口。"), false);
        }
        if fields.get("origin").copied() != Some(origin.as_str())
            || !fields.get("content-type").is_some_and(|value| {
                value.split(';').next().unwrap_or("").trim() == "application/json"
            })
        {
            return send_json(
                stream,
                SyncResponse::error(403, "共享请求必须来自当前页面。"),
                false,
            );
        }
        let Some(length) = fields
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|length| *length <= BODY_LIMIT)
        else {
            return send_json(
                stream,
                SyncResponse::error(413, "共享请求缺少长度或超过大小上限。"),
                false,
            );
        };
        let Some(_upload) = CounterGuard::acquire(&context.uploads, UPLOAD_LIMIT) else {
            return send_json(
                stream,
                SyncResponse::error(503, "其他文档正在同步，请稍后重试。"),
                false,
            );
        };
        let mut body = input.split_off(header_end);
        if body.len() > length {
            return send_json(stream, SyncResponse::error(400, "请求长度不匹配。"), false);
        }
        while body.len() < length {
            if !context.active.load(Ordering::Acquire) {
                return send_json(
                    stream,
                    SyncResponse::error(503, "浏览器服务已停止。"),
                    false,
                );
            }
            let limit = (length - body.len()).min(chunk.len());
            let count = stream.read(&mut chunk[..limit])?;
            if count == 0 {
                return send_json(stream, SyncResponse::error(400, "文档传输不完整。"), false);
            }
            body.extend_from_slice(&chunk[..count]);
        }
        let body = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => {
                return send_json(stream, SyncResponse::error(400, "请求 JSON 无效。"), false)
            }
        };
        let response = context
            .store
            .dispatch(&context.active, method, path, Some(body))
            .unwrap_or_else(|error| SyncResponse::error(503, &error));
        return send_json(stream, response, false);
    }
    if !matches!(method, "GET" | "HEAD") {
        return send_json(stream, SyncResponse::error(405, "不支持此请求方法。"), head);
    }
    if fields
        .get("content-length")
        .is_some_and(|length| *length != "0")
        || input.len() > header_end
    {
        return send_json(
            stream,
            SyncResponse::error(400, "读取请求不能包含正文。"),
            head,
        );
    }
    if path.starts_with("_sync/") {
        let response = context
            .store
            .dispatch(&context.active, "GET", path, None)
            .unwrap_or_else(|error| SyncResponse::error(503, &error));
        return send_json(stream, response, head);
    }
    let Some(path) = resolve_asset(&context.root, path) else {
        return send_json(stream, SyncResponse::error(404, "找不到界面资源。"), head);
    };
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return send_json(stream, SyncResponse::error(404, "找不到界面资源。"), head),
    };
    let length = file.metadata()?.len();
    let (status, start, count, extra) = if let Some(value) = fields.get("range") {
        match byte_range(value, length) {
            Some((start, end)) => (
                206,
                start,
                end - start + 1,
                format!("Accept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{length}\r\n"),
            ),
            None => return send_json(stream, SyncResponse::error(416, "文件读取范围无效。"), head),
        }
    } else {
        (200, 0, length, "Accept-Ranges: bytes\r\n".into())
    };
    write_headers(stream, status, mime(&path), count, &extra)?;
    if !head {
        file.seek(SeekFrom::Start(start))?;
        let copied = std::io::copy(&mut file.take(count), stream)?;
        if copied != count {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Incomplete application asset",
            ));
        }
    }
    stream.flush()
}

fn resolve_asset(root: &Path, suffix: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(suffix).decode_utf8().ok()?;
    if decoded.contains(['\\', '\0', '\r', '\n'])
        || decoded.split('/').any(|part| matches!(part, "." | ".."))
    {
        return None;
    }
    let relative = if decoded.is_empty() {
        Path::new("index.html")
    } else {
        Path::new(decoded.as_ref())
    };
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let path = root.join(relative).canonicalize().ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

fn byte_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    if length == 0 || value.contains(',') {
        return None;
    }
    let (from, to) = value.split_once('-')?;
    if from.is_empty() {
        let count = to.parse::<u64>().ok()?;
        return (count > 0).then_some((length.saturating_sub(count), length - 1));
    }
    let start = from.parse::<u64>().ok()?;
    let end = if to.is_empty() {
        length - 1
    } else {
        to.parse::<u64>().ok()?
    };
    (start < length && end >= start).then_some((start, end.min(length - 1)))
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" | "metadata" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _assets: tempfile::TempDir,
        data: tempfile::TempDir,
        manager: BrowserServerManager,
    }

    fn fixture() -> Fixture {
        let assets = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::write(assets.path().join("index.html"), "browser shell").unwrap();
        fs::write(assets.path().join("test.wasm"), b"0123456789").unwrap();
        let manager = BrowserServerManager::new(assets.path().into(), data.path().into()).unwrap();
        Fixture {
            _assets: assets,
            data,
            manager,
        }
    }

    fn publish(id: &str, expected: u64, client: &str, text: &str) -> Value {
        json!({"id":id, "expectedVersion":expected, "clientId":client,
            "name":"共享.pdf", "extension":"pdf", "base64":STANDARD.encode(format!("%PDF-1.7\n{text}\n%%EOF"))})
    }

    fn post(manager: &BrowserServerManager, body: Value) -> SyncResponse {
        manager
            .dispatch("POST", "_sync/documents", Some(body))
            .unwrap()
    }

    fn endpoint(manager: &BrowserServerManager) -> (String, String) {
        let url = manager.status().unwrap().local_url.unwrap();
        let (host, path) = url
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap();
        (host.into(), format!("/{}", path.split('?').next().unwrap()))
    }

    fn request(
        manager: &BrowserServerManager,
        method: &str,
        suffix: &str,
        host_override: Option<&str>,
        origin: Option<&str>,
        body: Option<&str>,
    ) -> String {
        let (host, prefix) = endpoint(manager);
        let mut stream = TcpStream::connect(&host).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut headers = format!(
            "{method} {prefix}{suffix} HTTP/1.1\r\nHost: {}\r\n",
            host_override.unwrap_or(&host)
        );
        if let Some(origin) = origin {
            headers.push_str(&format!("Origin: {origin}\r\n"));
        }
        if let Some(body) = body {
            headers.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ));
        }
        headers.push_str("\r\n");
        stream.write_all(headers.as_bytes()).unwrap();
        if let Some(body) = body {
            stream.write_all(body.as_bytes()).unwrap();
        }
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn not_started_by_construction_and_a_restart_revokes_the_link() {
        let fixture = fixture();
        assert!(!fixture.manager.status().unwrap().running);
        assert_eq!(
            post(&fixture.manager, publish("doc", 0, "desktop", "first")).status_code,
            503
        );
        let first = fixture.manager.start().unwrap();
        assert_eq!(first.local_url, fixture.manager.start().unwrap().local_url);
        assert_eq!(
            post(&fixture.manager, publish("doc", 0, "desktop", "first")).status_code,
            200
        );
        let (old_host, old_prefix) = endpoint(&fixture.manager);
        let old_active = fixture
            .manager
            .running
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .active
            .clone();
        fixture.manager.stop().unwrap();
        assert!(!old_active.load(Ordering::Acquire));
        assert!(TcpStream::connect(old_host).is_err());
        let second = fixture.manager.start().unwrap();
        assert_ne!(first.local_url, second.local_url);
        assert!(!second.local_url.unwrap().contains(&old_prefix));
        assert_eq!(
            fixture
                .manager
                .store
                .dispatch(
                    &old_active,
                    "POST",
                    "_sync/documents",
                    Some(publish("doc", 1, "old", "stale"))
                )
                .unwrap()
                .status_code,
            503
        );
        assert_eq!(fixture.manager.status().unwrap().revision, 1);
    }

    #[test]
    fn cas_preserves_current_version_and_identical_retry_is_idempotent() {
        let fixture = fixture();
        fixture.manager.start().unwrap();
        let original = publish("doc", 0, "desktop", "first");
        let response = post(&fixture.manager, original.clone());
        assert_eq!(response.body["document"]["version"], 1);
        assert_eq!(response.body["document"]["kind"], "pdf");
        let duplicate = post(&fixture.manager, original);
        assert_eq!(duplicate.status_code, 200);
        assert_eq!(fixture.manager.status().unwrap().revision, 1);
        assert_eq!(
            post(&fixture.manager, publish("doc", 1, "browser", "second")).status_code,
            200
        );
        let stale = post(&fixture.manager, publish("doc", 1, "desktop", "third"));
        assert_eq!(stale.status_code, 409);
        assert_eq!(stale.body["status"], "conflict");
        assert_eq!(stale.body["document"]["version"], 2);
        assert_eq!(
            fixture
                .manager
                .dispatch("GET", "_sync/documents/doc", None)
                .unwrap()
                .body["base64"],
            publish("doc", 1, "browser", "second")["base64"]
        );
        assert_eq!(
            post(
                &fixture.manager,
                publish("conflict-copy", 0, "desktop", "third")
            )
            .status_code,
            200
        );
        assert_eq!(
            fixture
                .manager
                .dispatch("GET", "_sync/state", None)
                .unwrap()
                .body["documents"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn concurrent_editors_cannot_both_replace_the_same_revision() {
        let fixture = fixture();
        fixture.manager.start().unwrap();
        post(&fixture.manager, publish("doc", 0, "desktop", "initial"));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        thread::scope(|scope| {
            let jobs: Vec<_> = ["browser-a", "browser-b"]
                .into_iter()
                .map(|client| {
                    let barrier = barrier.clone();
                    let manager = &fixture.manager;
                    scope.spawn(move || {
                        barrier.wait();
                        post(manager, publish("doc", 1, client, client)).status_code
                    })
                })
                .collect();
            barrier.wait();
            let mut statuses: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
            statuses.sort();
            assert_eq!(statuses, [200, 409]);
        });
        assert_eq!(fixture.manager.status().unwrap().revision, 2);
    }

    #[test]
    fn accepted_snapshots_recover_after_restart_without_original_file_access() {
        let fixture = fixture();
        fixture.manager.start().unwrap();
        post(&fixture.manager, publish("doc", 0, "browser", "durable"));
        fixture.manager.stop().unwrap();
        let reopened =
            BrowserServerManager::new(fixture._assets.path().into(), fixture.data.path().into())
                .unwrap();
        assert!(!reopened.status().unwrap().running);
        reopened.start().unwrap();
        assert_eq!(reopened.status().unwrap().revision, 1);
        assert_eq!(
            reopened
                .dispatch("GET", "_sync/documents/doc", None)
                .unwrap()
                .body["updatedBy"],
            "browser"
        );
    }

    #[test]
    fn invalid_or_failed_snapshot_preserves_memory_and_persisted_revision() {
        let fixture = fixture();
        fixture.manager.start().unwrap();
        post(&fixture.manager, publish("doc", 0, "desktop", "good"));
        let original = fs::read(fixture.data.path().join("workspace.json")).unwrap();
        let mut invalid = publish("doc", 1, "browser", "bad");
        invalid["base64"] = json!(STANDARD.encode(b"not a PDF"));
        assert_eq!(post(&fixture.manager, invalid).status_code, 400);
        assert_eq!(
            fs::read(fixture.data.path().join("workspace.json")).unwrap(),
            original
        );
        fs::remove_file(fixture.data.path().join("workspace.json")).unwrap();
        fs::create_dir(fixture.data.path().join("workspace.json")).unwrap();
        assert_eq!(
            post(
                &fixture.manager,
                publish("doc", 1, "browser", "failed disk write")
            )
            .status_code,
            507
        );
        assert_eq!(fixture.manager.status().unwrap().revision, 1);
        assert_eq!(
            fixture
                .manager
                .dispatch("GET", "_sync/documents/doc", None)
                .unwrap()
                .body["version"],
            1
        );
    }

    #[test]
    fn corrupt_persisted_workspace_is_never_silently_replaced() {
        let fixture = fixture();
        fs::write(fixture.data.path().join("workspace.json"), b"broken").unwrap();
        assert!(BrowserServerManager::new(
            fixture._assets.path().into(),
            fixture.data.path().into()
        )
        .is_err());
        assert_eq!(
            fs::read(fixture.data.path().join("workspace.json")).unwrap(),
            b"broken"
        );
    }

    #[test]
    fn names_identifiers_formats_and_base64_are_checked() {
        let valid = STANDARD.encode(b"%PDF-1.7\n%%EOF");
        for name in [
            "../x.pdf",
            "CON.pdf",
            "LPT1.pdf",
            ".hidden.pdf",
            "a\\b.pdf",
            "x.docx",
            "x\n.pdf",
        ] {
            assert!(
                validate_document("doc", "client", name, "pdf", &valid).is_err(),
                "accepted {name}"
            );
        }
        assert!(validate_document("../doc", "client", "x.pdf", "pdf", &valid).is_err());
        assert!(validate_document("doc", "client", "x.pdf", "pdf", "!!").is_err());
        assert!(validate_document("doc", "client", "x.xls", "xls", &valid).is_err());
        assert!(validate_document("doc", "client", "中文.pdf", "pdf", &valid).is_ok());
    }

    #[test]
    fn http_serves_assets_and_sync_only_under_the_secret_with_same_origin_writes() {
        let fixture = fixture();
        fixture.manager.start().unwrap();
        let (host, _) = endpoint(&fixture.manager);
        let origin = format!("http://{host}");
        let shell = request(&fixture.manager, "GET", "", None, None, None);
        assert!(shell.starts_with("HTTP/1.1 200"));
        assert!(shell.ends_with("browser shell"));
        assert!(shell.contains("connect-src 'self';"));
        assert!(!shell.contains("ipc.localhost"));
        let body = publish("doc", 0, "browser", "network").to_string();
        assert!(request(
            &fixture.manager,
            "POST",
            "_sync/documents",
            None,
            None,
            Some(&body)
        )
        .starts_with("HTTP/1.1 403"));
        assert!(request(
            &fixture.manager,
            "POST",
            "_sync/documents",
            None,
            Some("http://evil.test"),
            Some(&body)
        )
        .starts_with("HTTP/1.1 403"));
        assert!(request(
            &fixture.manager,
            "GET",
            "_sync/state",
            Some("evil.test"),
            None,
            None
        )
        .starts_with("HTTP/1.1 403"));
        assert!(request(
            &fixture.manager,
            "POST",
            "_sync/documents",
            None,
            Some(&origin),
            Some(&body)
        )
        .starts_with("HTTP/1.1 200"));
        let state = request(&fixture.manager, "GET", "_sync/state", None, None, None);
        assert!(state.contains("\"revision\":1"));
        assert!(!state.contains("base64"));
        assert!(request(
            &fixture.manager,
            "GET",
            "_sync/documents/doc",
            None,
            None,
            None
        )
        .contains("base64"));
        for suffix in [
            "../workspace.json",
            "%2e%2e/workspace.json",
            "%2fetc/passwd",
            "__native-smoke/failure",
            "_sync/../../workspace.json",
        ] {
            assert!(
                request(&fixture.manager, "GET", suffix, None, None, None)
                    .starts_with("HTTP/1.1 404"),
                "accepted {suffix}"
            );
        }
    }

    #[test]
    fn pending_upload_is_rejected_after_stop() {
        let fixture = fixture();
        fixture.manager.start().unwrap();
        let (host, prefix) = endpoint(&fixture.manager);
        let mut stream = TcpStream::connect(&host).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let body = publish("doc", 0, "browser", "late").to_string();
        write!(stream, "POST {prefix}_sync/documents HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len()).unwrap();
        // Wait for the listener to accept this connection before shutdown.
        let running = fixture.manager.running.lock().unwrap();
        let active = running.as_ref().unwrap().active.clone();
        drop(running);
        thread::sleep(Duration::from_millis(50));
        fixture.manager.stop().unwrap();
        let _ = stream.write_all(body.as_bytes());
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        assert!(!active.load(Ordering::Acquire));
        assert_eq!(fixture.manager.status().unwrap().revision, 0);
        assert!(!fixture.data.path().join("workspace.json").exists());
        assert!(!response.starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn asset_range_and_symlink_boundaries_are_safe() {
        let fixture = fixture();
        let root = fixture._assets.path().canonicalize().unwrap();
        assert!(resolve_asset(&root, "index.html").is_some());
        for path in [
            "../index.html",
            "%2e%2e/index.html",
            "./index.html",
            "%2fetc/passwd",
            "a%5cb",
            "%00",
        ] {
            assert!(resolve_asset(&root, path).is_none());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(fixture.data.path(), root.join("private")).unwrap();
            fs::write(fixture.data.path().join("secret"), "private").unwrap();
            assert!(resolve_asset(&root, "private/secret").is_none());
        }
        assert_eq!(byte_range("bytes=3-7", 10), Some((3, 7)));
        assert_eq!(byte_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(byte_range("bytes=0-99", 10), Some((0, 9)));
        for value in ["bytes=10-", "bytes=8-7", "bytes=-0", "bytes=0-1,3-4"] {
            assert!(byte_range(value, 10).is_none());
        }
        fixture.manager.start().unwrap();
        let (host, prefix) = endpoint(&fixture.manager);
        let mut stream = TcpStream::connect(&host).unwrap();
        write!(
            stream,
            "GET {prefix}test.wasm HTTP/1.1\r\nHost: {host}\r\nRange: bytes=3-7\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.contains("Content-Type: application/wasm"));
        assert!(response.ends_with("34567"));
    }

    #[test]
    fn native_smoke_probe_uses_real_http_and_requires_an_edited_snapshot() {
        let fixture = fixture();
        let pdf_assets = fixture._assets.path().join("office-pdf");
        fs::create_dir(&pdf_assets).unwrap();
        fs::write(pdf_assets.join("office_pdf_bg.wasm"), b"\0asm\x01\0\0\0").unwrap();
        fixture.manager.start().unwrap();
        let initial = publish("native-doc", 0, "desktop", "original");
        post(&fixture.manager, initial.clone());
        assert!(fixture
            .manager
            .native_smoke_probe("native-doc", initial["base64"].as_str().unwrap())
            .is_err());
        let edited = publish("native-doc", 1, "desktop", "edited");
        let (report, endpoint) = fixture
            .manager
            .native_smoke_probe("native-doc", edited["base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(report["execution"], "native-tcp");
        assert_eq!(report["initialVersion"], 1);
        assert_eq!(report["acceptedVersion"], 2);
        assert_eq!(report["writeStatus"], 200);
        assert_eq!(report["staleWriteStatus"], 409);
        assert_eq!(report["wrongOriginStatus"], 403);
        assert_eq!(report["rangeBytes"], 8);
        assert_eq!(
            report["indexSha256"],
            hex::encode(Sha256::digest(b"browser shell"))
        );
        assert!(endpoint.assert_revoked().is_err());
        fixture.manager.stop().unwrap();
        endpoint.assert_revoked().unwrap();
    }

    #[test]
    fn http_rejects_duplicate_headers_chunking_and_oversized_bodies() {
        let fixture = fixture();
        fixture.manager.start().unwrap();
        let (host, prefix) = endpoint(&fixture.manager);
        for (extra, expected) in [
            (format!("Host: {host}\r\n"), 400),
            ("Transfer-Encoding: chunked\r\n".into(), 403),
            (format!("Content-Type: application/json\r\nOrigin: http://{host}\r\nContent-Length: {}\r\n", BODY_LIMIT + 1), 413),
        ] {
            let mut stream = TcpStream::connect(&host).unwrap();
            write!(stream, "POST {prefix}_sync/documents HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with(&format!("HTTP/1.1 {expected}")), "{response}");
        }
        assert_eq!(fixture.manager.status().unwrap().revision, 0);
    }
}
