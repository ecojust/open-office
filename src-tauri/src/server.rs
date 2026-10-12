//! A loopback-only, read-only asset server. User documents are never served here.
//! A fresh secret URL namespace prevents other local pages from reading app assets.
use crate::smoke::{Smoke, REPORT_LIMIT};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const HEADER_LIMIT: usize = 16 * 1024;
const CONNECTION_LIMIT: usize = 32;
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost https://ipc.localhost; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub origin: String,
    pub base_path: String,
    pub runtime_base_url: String,
    pub platform: String,
    pub smoke_mode: bool,
}

pub struct AssetServer {
    pub info: Bootstrap,
    pub smoke: Option<Smoke>,
    shutdown: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct Assets {
    root: PathBuf,
    token: String,
    host: String,
    smoke: Option<Smoke>,
}

impl AssetServer {
    pub fn start(root: &Path) -> Result<Self, String> {
        Self::start_with_smoke(root, None)
    }

    pub fn start_with_smoke(root: &Path, smoke: Option<Smoke>) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|_| {
            "找不到应用界面资源。开发时请先运行 npm run build，安装版请重新安装完整应用。"
        })?;
        if !root.join("index.html").is_file() {
            return Err("应用界面资源缺少 index.html。".into());
        }
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| "无法生成本地服务安全标识。")?;
        let token = hex::encode(random);
        let socket = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| format!("无法启动本地文档界面服务：{error}"))?;
        let address = socket.local_addr().map_err(|_| "无法取得本地服务端口。")?;
        socket
            .set_nonblocking(true)
            .map_err(|_| "无法配置本地资源服务。")?;
        let origin = format!("http://{address}");
        let base_path = format!("/{token}/");
        let info = Bootstrap {
            runtime_base_url: format!("{origin}{base_path}office-runtime/"),
            origin,
            base_path,
            platform: std::env::consts::OS.into(),
            smoke_mode: smoke.is_some(),
        };
        let assets = Assets {
            root,
            token,
            host: address.to_string(),
            smoke: smoke.clone(),
        };
        if let Some(diagnostic) = &smoke {
            diagnostic.note("http-listening", "loopback static assets ready");
        }
        let shutdown = Arc::new(AtomicBool::new(false));
        let stop = shutdown.clone();
        let connections = Arc::new(AtomicUsize::new(0));
        let listener = thread::Builder::new()
            .name("office-assets".into())
            .spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    match socket.accept() {
                        Ok((mut stream, peer)) => {
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
                            if connections.fetch_add(1, Ordering::AcqRel) >= CONNECTION_LIMIT {
                                connections.fetch_sub(1, Ordering::AcqRel);
                                let _ = error_response(&mut stream, 503, "Busy", false, None);
                                continue;
                            }
                            let active = connections.clone();
                            let source = assets.clone();
                            let spawned = thread::Builder::new().name("office-asset".into()).spawn(
                                move || {
                                    let _guard = ConnectionGuard(active);
                                    let _ = serve(&mut stream, &source);
                                },
                            );
                            if spawned.is_err() {
                                connections.fetch_sub(1, Ordering::AcqRel);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(15))
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|_| "无法启动本地资源线程。")?;
        Ok(Self {
            info,
            smoke,
            shutdown,
            listener: Some(listener),
        })
    }

    pub fn url(&self) -> String {
        format!("{}{}", self.info.origin, self.info.base_path)
    }

    pub fn ipc_origin_pattern(&self) -> String {
        // Tauri's fetch IPC derives the caller URL from the Origin header, which
        // has no pathname. Bind IPC to this exact per-launch host/port; the HTTP
        // server and the main-window navigation guard separately enforce token.
        format!("{}/*", self.info.origin)
    }

    pub fn allows_navigation(info: &Bootstrap, url: &tauri::Url) -> bool {
        url.origin().ascii_serialization() == info.origin
            && url.username().is_empty()
            && url.password().is_none()
            && url.path().starts_with(&info.base_path)
    }
}

impl Drop for AssetServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}

struct ConnectionGuard(Arc<AtomicUsize>);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn resolve_path(root: &Path, token: &str, target: &str) -> Result<PathBuf, ()> {
    let raw = target.split('?').next().ok_or(())?;
    let prefix = format!("/{token}/");
    let suffix = raw.strip_prefix(&prefix).ok_or(())?;
    let decoded = percent_decode_str(suffix).decode_utf8().map_err(|_| ())?;
    if decoded.contains(['\\', '\0', '\r', '\n']) {
        return Err(());
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
        return Err(());
    }
    // Check lexical components before canonicalizing as well as canonical containment.
    if decoded.split('/').any(|part| part == ".." || part == ".") {
        return Err(());
    }
    let path = root.join(relative).canonicalize().map_err(|_| ())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(());
    }
    Ok(path)
}

fn byte_range(value: &str, length: u64) -> Result<(u64, u64), ()> {
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if length == 0 || range.contains(',') {
        return Err(());
    }
    let (from, to) = range.split_once('-').ok_or(())?;
    if from.is_empty() {
        let count: u64 = to.parse().map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        return Ok((length.saturating_sub(count), length - 1));
    }
    let start: u64 = from.parse().map_err(|_| ())?;
    let end: u64 = if to.is_empty() {
        length - 1
    } else {
        to.parse().map_err(|_| ())?
    };
    if start >= length || end < start {
        return Err(());
    }
    Ok((start, end.min(length - 1)))
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "metadata" | "map" => "application/json",
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
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    length: u64,
    extra: Option<&str>,
) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nConnection: close\r\nCache-Control: no-store\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\nOrigin-Agent-Cluster: ?1\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {CSP}\r\n")?;
    if let Some(extra) = extra {
        write!(stream, "{extra}\r\n")?;
    }
    write!(stream, "\r\n")
}

fn error_response(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
    head: bool,
    extra: Option<&str>,
) -> std::io::Result<()> {
    headers(
        stream,
        status,
        message,
        "text/plain; charset=utf-8",
        message.len() as u64,
        extra,
    )?;
    if !head {
        stream.write_all(message.as_bytes())?;
    }
    Ok(())
}

fn serve(stream: &mut TcpStream, assets: &Assets) -> std::io::Result<()> {
    let mut input = Vec::new();
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        input.extend_from_slice(&chunk[..count]);
        if let Some(position) = input.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            if position + 4 > HEADER_LIMIT {
                return error_response(stream, 431, "Headers too large", false, None);
            }
            break position + 4;
        }
        if input.len() > HEADER_LIMIT {
            return error_response(stream, 431, "Headers too large", false, None);
        }
    };
    let header_bytes = input[..header_end].to_vec();
    let request = match std::str::from_utf8(&header_bytes) {
        Ok(request) => request,
        Err(_) => return error_response(stream, 400, "Bad request", false, None),
    };
    let mut lines = request.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.0" | "HTTP/1.1") {
        return error_response(stream, 400, "Bad request", false, None);
    }
    let head = parts[0] == "HEAD";
    let mut host = None;
    let mut range = None;
    let mut origin = None;
    let mut length = None;
    let mut content_type = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return error_response(stream, 400, "Bad request", head, None);
        };
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return error_response(stream, 400, "Bad host", head, None);
            }
            host = Some(value.trim());
        }
        if name.eq_ignore_ascii_case("range") {
            if range.is_some() {
                return error_response(stream, 416, "Invalid range", head, None);
            }
            range = Some(value.trim());
        }
        if name.eq_ignore_ascii_case("origin") {
            if origin.is_some() {
                return error_response(stream, 400, "Bad origin", head, None);
            }
            origin = Some(value.trim());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return error_response(stream, 400, "Bad length", head, None);
            }
            length = Some(value.trim());
        }
        if name.eq_ignore_ascii_case("content-type") {
            content_type = Some(value.trim());
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return error_response(stream, 400, "Unsupported encoding", head, None);
        }
    }
    if host != Some(assets.host.as_str()) {
        return error_response(stream, 403, "Forbidden", head, None);
    }
    let diagnostic_route = parts[1]
        .split('?')
        .next()
        .unwrap_or("")
        .strip_prefix(&format!("/{}/__native-smoke/", assets.token));
    if parts[0] == "POST" {
        if let (Some(smoke), Some(route)) = (&assets.smoke, diagnostic_route) {
            if !matches!(route, "progress" | "failure") {
                return error_response(stream, 404, "Not found", false, None);
            }
            if origin != Some(format!("http://{}", assets.host).as_str())
                || content_type != Some("application/json")
            {
                smoke.note("http-report-rejected", "origin or content type mismatch");
                return error_response(stream, 403, "Forbidden", false, None);
            }
            let Some(length) = length
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|length| *length <= REPORT_LIMIT)
            else {
                return error_response(stream, 413, "Report too large", false, None);
            };
            let mut body = input[header_end..].to_vec();
            if body.len() > length {
                return error_response(stream, 400, "Bad body", false, None);
            }
            while body.len() < length {
                let read_limit = (length - body.len()).min(chunk.len());
                let read = stream.read(&mut chunk[..read_limit])?;
                if read == 0 {
                    return error_response(stream, 400, "Truncated body", false, None);
                }
                body.extend_from_slice(&chunk[..read]);
            }
            let Ok(report) = serde_json::from_slice::<serde_json::Value>(&body) else {
                return error_response(stream, 400, "Bad JSON", false, None);
            };
            if route == "progress" {
                let Some(phase) = report
                    .get("phase")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty() && value.len() <= 80)
                else {
                    return error_response(stream, 400, "Bad phase", false, None);
                };
                smoke.note(
                    phase,
                    report
                        .get("detail")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(""),
                );
            } else if let Err(error) = smoke.failure_report(&report) {
                smoke.note("http-report-rejected", &error);
                return error_response(stream, 400, "Invalid failure report", false, None);
            }
            headers(stream, 200, "OK", "application/json", 2, None)?;
            stream.write_all(b"{}")?;
            stream.flush()?;
            if route == "failure" {
                smoke.stop_after_failure();
            }
            return Ok(());
        }
    }
    if !matches!(parts[0], "GET" | "HEAD") {
        return error_response(stream, 405, "Read only", head, Some("Allow: GET, HEAD"));
    }
    let path = match resolve_path(&assets.root, &assets.token, parts[1]) {
        Ok(path) => path,
        Err(_) => {
            if let Some(smoke) = &assets.smoke {
                let name = parts[1]
                    .split('?')
                    .next()
                    .unwrap_or("")
                    .strip_prefix(&format!("/{}/", assets.token))
                    .unwrap_or("outside token namespace");
                smoke.note("http-404", name);
            }
            return error_response(stream, 404, "Not found", head, None);
        }
    };
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return error_response(stream, 404, "Not found", head, None),
    };
    let length = file.metadata()?.len();
    if let Some(smoke) = &assets.smoke {
        let name = path
            .strip_prefix(&assets.root)
            .unwrap_or(&path)
            .to_string_lossy();
        if name.ends_with(".html")
            || name.ends_with(".js")
            || name.ends_with(".wasm")
            || name.ends_with(".data")
        {
            smoke.note("http-asset", &format!("{name} ({length} bytes)"));
        }
    }
    let (status, reason, start, count, extra) = if let Some(range) = range {
        match byte_range(range, length) {
            Ok((start, end)) => (
                206,
                "Partial Content",
                start,
                end - start + 1,
                format!("Accept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{length}"),
            ),
            Err(_) => {
                return error_response(
                    stream,
                    416,
                    "Range not satisfiable",
                    head,
                    Some(&format!("Content-Range: bytes */{length}")),
                )
            }
        }
    } else {
        (200, "OK", 0, length, "Accept-Ranges: bytes".into())
    };
    headers(stream, status, reason, mime(&path), count, Some(&extra))?;
    if !head {
        file.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut file.take(count), stream)?;
    }
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    #[test]
    fn token_and_canonical_root_are_required() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("index.html"), "home").unwrap();
        let root_path = root.path().canonicalize().unwrap();
        assert!(resolve_path(&root_path, "secret", "/secret/").is_ok());
        assert!(resolve_path(&root_path, "secret", "/secret/index.html?v=1").is_ok());
        for path in [
            "/index.html",
            "/wrong/index.html",
            "/secret/../index.html",
            "/secret/%2e%2e/index.html",
            "/secret/%2fetc/passwd",
            "/secret/a%5c..%5cindex.html",
            "/secret/%00",
            "/secret/./index.html",
        ] {
            assert!(
                resolve_path(&root_path, "secret", path).is_err(),
                "accepted {path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_publish_a_file_outside_assets() {
        let root = tempfile::tempdir().unwrap();
        let private = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(private.path(), root.path().join("leak")).unwrap();
        assert!(resolve_path(
            &root.path().canonicalize().unwrap(),
            "secret",
            "/secret/leak"
        )
        .is_err());
    }

    #[test]
    fn range_requests_are_bounded() {
        assert_eq!(byte_range("bytes=3-8", 10), Ok((3, 8)));
        assert_eq!(byte_range("bytes=3-", 10), Ok((3, 9)));
        assert_eq!(byte_range("bytes=-3", 10), Ok((7, 9)));
        assert_eq!(byte_range("bytes=0-99", 10), Ok((0, 9)));
        for invalid in [
            "bytes=10-",
            "bytes=4-3",
            "bytes=-0",
            "bytes=0-1,3-4",
            "units=0-3",
        ] {
            assert!(byte_range(invalid, 10).is_err());
        }
        assert!(byte_range("bytes=0-", 0).is_err());
    }

    fn request(server: &AssetServer, path: &str, method: &str, extra: &str) -> String {
        let address: SocketAddr = server
            .info
            .origin
            .strip_prefix("http://")
            .unwrap()
            .parse()
            .unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {address}\r\n{extra}\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn actual_server_has_isolation_headers_and_cannot_write() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("index.html"), "0123456789").unwrap();
        let server = AssetServer::start(root.path()).unwrap();
        assert!(server.info.origin.starts_with("http://127.0.0.1:"));
        assert_eq!(server.info.base_path.len(), 66);
        let response = request(&server, &server.info.base_path, "GET", "");
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("Cross-Origin-Opener-Policy: same-origin"));
        assert!(response.contains("Cross-Origin-Embedder-Policy: require-corp"));
        assert!(response.ends_with("0123456789"));
        let partial = request(
            &server,
            &server.info.base_path,
            "GET",
            "Range: bytes=2-4\r\n",
        );
        assert!(partial.starts_with("HTTP/1.1 206"));
        assert!(partial.ends_with("234"));
        assert!(request(&server, &server.info.base_path, "POST", "").starts_with("HTTP/1.1 405"));
        assert!(request(
            &server,
            &format!("{}__native-smoke/failure", server.info.base_path),
            "POST",
            ""
        )
        .starts_with("HTTP/1.1 405"));
        assert!(request(&server, "/wrong/", "GET", "").starts_with("HTTP/1.1 404"));
        assert!(request(&server, &server.info.base_path, "HEAD", "").ends_with("\r\n\r\n"));
    }

    #[test]
    fn ipc_capability_matches_fetch_origin_without_token_path_and_rejects_other_servers() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("index.html"), "home").unwrap();
        let server = AssetServer::start(root.path()).unwrap();
        let capability: tauri::utils::acl::RemoteUrlPattern =
            server.ipc_origin_pattern().parse().unwrap();
        // Mirrors tauri 2.12's ipc/protocol.rs parse_invoke_request: Origin is
        // parsed as a URL, not the full webview page URL, so its path is just /.
        let caller: tauri::Url = server.info.origin.parse().unwrap();
        assert_eq!(caller.path(), "/");
        assert!(capability.test(&caller));
        let old_token_pattern: tauri::utils::acl::RemoteUrlPattern =
            format!("{}*", server.url()).parse().unwrap();
        assert!(
            !old_token_pattern.test(&caller),
            "The old path ACL rejects real fetch IPC"
        );
        assert!(capability.test(&format!("{}?nativeSmoke=1", server.url()).parse().unwrap()));
        let port = caller.port().unwrap();
        for foreign in [
            format!(
                "http://127.0.0.1:{}/",
                if port == 65535 { port - 1 } else { port + 1 }
            ),
            format!("http://localhost:{port}/"),
            format!("https://127.0.0.1:{port}/"),
            "https://example.com/".into(),
        ] {
            assert!(
                !capability.test(&foreign.parse().unwrap()),
                "Accepted foreign origin: {foreign}"
            );
        }
        // Origin ACL must not accidentally relax the separate navigation guard.
        assert!(!AssetServer::allows_navigation(&server.info, &caller));
        assert!(!AssetServer::allows_navigation(
            &server.info,
            &format!("{}/wrong/", server.info.origin).parse().unwrap()
        ));
    }

    #[test]
    fn smoke_fallback_requires_exact_origin_token_and_explicit_failure() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("index.html"), "home").unwrap();
        let output = root.path().join("result/report.json");
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        let smoke = Smoke::new(output.clone(), move || {
            flag.store(true, Ordering::Release);
        });
        let server = AssetServer::start_with_smoke(root.path(), Some(smoke)).unwrap();
        let post = |path: &str, origin: &str, body: &str| {
            let address = server.info.origin.strip_prefix("http://").unwrap();
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            write!(stream,"POST {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        let route = format!("{}__native-smoke/failure", server.info.base_path);
        assert!(post(&route, "http://localhost:1", r#"{"ok":false}"#).starts_with("HTTP/1.1 403"));
        assert!(post(
            "/wrong/__native-smoke/failure",
            &server.info.origin,
            r#"{"ok":false}"#
        )
        .starts_with("HTTP/1.1 405"));
        assert!(post(&route, &server.info.origin, r#"{"ok":true}"#).starts_with("HTTP/1.1 400"));
        assert!(!output.exists());
        assert!(!stopped.load(Ordering::Acquire));
        let progress = format!("{}__native-smoke/progress", server.info.base_path);
        assert!(post(
            &progress,
            &server.info.origin,
            r#"{"phase":"main-entry","detail":"module loaded"}"#
        )
        .starts_with("HTTP/1.1 200"));
        assert!(post(
            &route,
            &server.info.origin,
            r#"{"ok":false,"error":"IPC unavailable"}"#
        )
        .starts_with("HTTP/1.1 200"));
        assert!(output.is_file());
        assert!(stopped.load(Ordering::Acquire));
    }

    #[test]
    fn navigation_stays_in_the_same_secret_namespace() {
        let info = Bootstrap {
            origin: "http://127.0.0.1:12345".into(),
            base_path: "/secret/".into(),
            runtime_base_url: String::new(),
            platform: "test".into(),
            smoke_mode: false,
        };
        assert!(AssetServer::allows_navigation(
            &info,
            &"http://127.0.0.1:12345/secret/office/host.html"
                .parse()
                .unwrap()
        ));
        for url in [
            "https://example.com/secret/",
            "http://127.0.0.1:12346/secret/",
            "http://127.0.0.1:12345/other/",
            "file:///secret/",
            "http://user@127.0.0.1:12345/secret/",
        ] {
            assert!(!AssetServer::allows_navigation(
                &info,
                &url.parse().unwrap()
            ));
        }
    }
}
