//! A loopback-only, read-only asset server. User documents are never served here.
//! A fresh secret URL namespace prevents other local pages from reading app assets.
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
    shutdown: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct Assets {
    root: PathBuf,
    token: String,
    host: String,
}

impl AssetServer {
    pub fn start(root: &Path) -> Result<Self, String> {
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
            smoke_mode: std::env::var("OPEN_OFFICE_SMOKE").as_deref() == Ok("1"),
        };
        let assets = Assets {
            root,
            token,
            host: address.to_string(),
        };
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
            shutdown,
            listener: Some(listener),
        })
    }

    pub fn url(&self) -> String {
        format!("{}{}", self.info.origin, self.info.base_path)
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
    loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        input.extend_from_slice(&chunk[..count]);
        if input.len() > HEADER_LIMIT {
            return error_response(stream, 431, "Headers too large", false, None);
        }
        if input.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            break;
        }
    }
    let request = match std::str::from_utf8(&input) {
        Ok(request) => request,
        Err(_) => return error_response(stream, 400, "Bad request", false, None),
    };
    let mut lines = request.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.0" | "HTTP/1.1") {
        return error_response(stream, 400, "Bad request", false, None);
    }
    let head = parts[0] == "HEAD";
    if !matches!(parts[0], "GET" | "HEAD") {
        return error_response(stream, 405, "Read only", head, Some("Allow: GET, HEAD"));
    }
    let mut host = None;
    let mut range = None;
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
    }
    if host != Some(assets.host.as_str()) {
        return error_response(stream, 403, "Forbidden", head, None);
    }
    let path = match resolve_path(&assets.root, &assets.token, parts[1]) {
        Ok(path) => path,
        Err(_) => return error_response(stream, 404, "Not found", head, None),
    };
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return error_response(stream, 404, "Not found", head, None),
    };
    let length = file.metadata()?.len();
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
        assert!(request(&server, "/wrong/", "GET", "").starts_with("HTTP/1.1 404"));
        assert!(request(&server, &server.info.base_path, "HEAD", "").ends_with("\r\n\r\n"));
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
