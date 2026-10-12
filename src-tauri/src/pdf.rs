//! Owns the local PDF worker. IPC supplies document data, never a program or path.
//! Each request has a private working directory, a real deadline, and bounded pipes.
use serde_json::Value;
#[cfg(any(windows, test))]
use std::path::PathBuf;
use std::{
    io::Write,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tauri::{AppHandle, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::watch,
};

const INPUT_LIMIT: usize = 100 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 100 * 1024 * 1024;
const STDERR_LIMIT: usize = 256 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub struct PdfRuntime {
    active: Arc<Mutex<Option<RunningJob>>>,
    closing: Arc<AtomicBool>,
}

struct RunningJob {
    token: u64,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    process: Arc<WorkerProcess>,
}

#[derive(Default)]
struct WorkerProcess {
    pid: AtomicU32,
    stopping: AtomicBool,
    launch: Mutex<()>,
}

struct JobGuard {
    runtime: PdfRuntime,
    token: u64,
    done: watch::Sender<bool>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut active = self
            .runtime
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if active.as_ref().map(|job| job.token) == Some(self.token) {
            *active = None;
        }
        // send_replace retains completion even if a receiver has not begun waiting yet.
        self.done.send_replace(true);
    }
}

impl PdfRuntime {
    fn reserve(
        &self,
    ) -> Result<
        (
            JobGuard,
            watch::Receiver<bool>,
            watch::Sender<bool>,
            Arc<WorkerProcess>,
        ),
        String,
    > {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if self.closing.load(Ordering::SeqCst) {
            return Err("CLOSING: 应用正在关闭，无法开始 PDF 操作。".into());
        }
        if active.is_some() {
            return Err("BUSY: 已有 PDF 操作正在进行，请等待完成或先取消。".into());
        }
        let token = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let (cancel, receiver) = watch::channel(false);
        let (done, completion) = watch::channel(false);
        let process = Arc::new(WorkerProcess::default());
        *active = Some(RunningJob {
            token,
            cancel: cancel.clone(),
            done: completion,
            process: process.clone(),
        });
        Ok((
            JobGuard {
                runtime: self.clone(),
                token,
                done,
            },
            receiver,
            cancel,
            process,
        ))
    }

    fn cancel_active(&self, closing: bool) -> Option<watch::Receiver<bool>> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        // Shares reserve's mutex: shutdown cannot miss a concurrently starting request.
        if closing {
            self.closing.store(true, Ordering::SeqCst);
        }
        let job = active.as_ref()?;
        job.cancel.send_replace(true);
        Some(job.done.clone())
    }

    /// Cancel the active worker and wait for process reaping and temporary-file cleanup.
    /// The application's close/exit handler must await this before calling app.exit().
    pub async fn shutdown(&self) {
        if let Some(done) = self.cancel_active(true) {
            wait_done(done).await;
        }
    }

    /// Synchronous safety net for RunEvent::Exit; normal close should await shutdown().
    pub fn force_shutdown(&self) {
        let process = {
            let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            self.closing.store(true, Ordering::SeqCst);
            active.as_ref().map(|job| {
                job.cancel.send_replace(true);
                job.process.clone()
            })
        };
        if let Some(process) = process {
            // The spawn and PID publication use this same lock: exit cannot miss a new child.
            let _launch = process.launch.lock().unwrap_or_else(|e| e.into_inner());
            process.stopping.store(true, Ordering::SeqCst);
            kill_tree_sync(process.pid.load(Ordering::SeqCst));
        }
    }
}

async fn wait_done(mut done: watch::Receiver<bool>) {
    while !*done.borrow_and_update() {
        if done.changed().await.is_err() {
            break;
        }
    }
}

struct CancelOnDrop(Option<watch::Sender<bool>>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancel) = &self.0 {
            cancel.send_replace(true);
        }
    }
}

#[cfg(any(debug_assertions, test))]
fn development_command(project: &Path) -> Result<Command, String> {
    let backend = project.join("pdf-backend");
    let python = if cfg!(windows) {
        backend.join(".venv").join("Scripts").join("python.exe")
    } else {
        backend.join(".venv").join("bin").join("python")
    };
    let script = backend.join("engine.py");
    if !python.is_file() || !script.is_file() {
        return Err(
            "STARTUP_ERROR: 本地 PDF 引擎尚未准备好，请先安装项目 pdf-backend 的 Python 环境。"
                .into(),
        );
    }
    let mut command = Command::new(python);
    // Ignore ambient PYTHONPATH/user-site packages; only this fixed venv owns imports.
    command.arg("-I").arg(script);
    Ok(command)
}

#[cfg(any(not(debug_assertions), test))]
fn bundled_command(resources: &Path) -> Result<Command, String> {
    let runtime = resources.join("pdf-runtime");
    let executable = runtime.join(if cfg!(windows) {
        "open-office-pdf.exe"
    } else {
        "open-office-pdf"
    });
    if !executable.is_file() || !runtime.join("_internal").is_dir() {
        return Err(
            "STARTUP_ERROR: 安装包的 PDF 运行时不完整，请重新安装包含 pdf-runtime 的完整版本。"
                .into(),
        );
    }
    Ok(Command::new(executable))
}

fn pdf_command(_app: &AppHandle) -> Result<Command, String> {
    #[cfg(debug_assertions)]
    {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("STARTUP_ERROR: 无法定位 PDF 开发环境。")?;
        development_command(root)
    }
    #[cfg(not(debug_assertions))]
    {
        let resources = _app
            .path()
            .resource_dir()
            .map_err(|_| "STARTUP_ERROR: 无法定位 PDF 应用资源。")?;
        bundled_command(&resources)
    }
}

struct LimitedInput {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}
impl Write for LimitedInput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("input limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_request(request: &Value) -> Result<(String, Vec<u8>), String> {
    if !request.is_object() || request.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("PROTOCOL_ERROR: PDF 请求必须是 protocolVersion 为 1 的对象。".into());
    }
    let id = request
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or("PROTOCOL_ERROR: PDF 请求编号无效。")?;
    // Reserve one byte for the protocol newline; serialization never allocates beyond the cap.
    let mut writer = LimitedInput {
        bytes: Vec::new(),
        limit: INPUT_LIMIT - 1,
        exceeded: false,
    };
    if serde_json::to_writer(&mut writer, request).is_err() {
        return Err(if writer.exceeded {
            "INPUT_LIMIT: PDF 请求超过 100 MiB 上限。"
        } else {
            "PROTOCOL_ERROR: PDF 请求无法编码。"
        }
        .into());
    }
    writer.bytes.push(b'\n');
    Ok((id.to_owned(), writer.bytes))
}

fn parse_response(bytes: &[u8], request_id: &str) -> Result<Value, String> {
    let response: Value = serde_json::from_slice(bytes)
        .map_err(|_| "OUTPUT_INVALID: PDF 引擎没有返回完整有效的单个 JSON 对象。")?;
    if !response.is_object()
        || response.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || response.get("requestId").and_then(Value::as_str) != Some(request_id)
        || !response.get("ok").is_some_and(Value::is_boolean)
    {
        return Err("OUTPUT_INVALID: PDF 引擎的协议或请求编号不匹配。".into());
    }
    // Engine errors are structured product responses, not bridge exceptions; preserve them.
    Ok(response)
}

#[derive(Clone, Copy)]
struct Limits {
    output: usize,
    stderr: usize,
    timeout: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            output: OUTPUT_LIMIT,
            stderr: STDERR_LIMIT,
            timeout: REQUEST_TIMEOUT,
        }
    }
}

async fn read_limited<R: AsyncRead + Unpin>(
    mut stream: R,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "OUTPUT_ERROR: 无法读取本地 PDF 引擎输出。")?;
        if count == 0 {
            return Ok(bytes);
        }
        if count > limit.saturating_sub(bytes.len()) {
            return Err("OUTPUT_LIMIT: PDF 引擎输出超过安全上限，任务已停止。".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

async fn wait_cancel(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(windows)]
fn taskkill_command(pid: u32) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let mut command =
        std::process::Command::new(PathBuf::from(root).join("System32").join("taskkill.exe"));
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn kill_tree_sync(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        // This fixed system helper has its own bounded lifetime too.
        if let Ok(mut helper) = taskkill_command(pid).spawn() {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                match helper.try_wait() {
                    Ok(Some(_)) => break,
                    _ if std::time::Instant::now() >= deadline => {
                        let _ = helper.kill();
                        let _ = helper.wait();
                        break;
                    }
                    _ => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        }
    }
}

struct ProcessGuard {
    child: Option<Child>,
    pid: u32,
    process: Arc<WorkerProcess>,
}
impl ProcessGuard {
    async fn terminate_and_reap(&mut self) {
        #[cfg(unix)]
        kill_tree_sync(self.pid);
        #[cfg(windows)]
        {
            let pid = self.pid;
            let _ = tauri::async_runtime::spawn_blocking(move || kill_tree_sync(pid)).await;
        }
        if let Some(child) = &mut self.child {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        self.child = None;
        self.process.pid.store(0, Ordering::SeqCst);
    }
}
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Last-resort protection on panic/aborted task; normal cancellation awaits above.
            kill_tree_sync(self.pid);
            let _ = child.start_kill();
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
        }
        self.process.pid.store(0, Ordering::SeqCst);
    }
}

// Only internal tests may substitute a command. Production always uses pdf_command().
async fn supervise(
    mut command: Command,
    input: Vec<u8>,
    request_id: String,
    mut cancel: watch::Receiver<bool>,
    process: Arc<WorkerProcess>,
    limits: Limits,
) -> Result<Value, String> {
    if *cancel.borrow() {
        return Err("CANCELLED: PDF 操作已取消。".into());
    }
    let deadline = tokio::time::Instant::now() + limits.timeout;
    let directory = tempfile::Builder::new()
        .prefix("open-office-pdf-")
        .tempdir()
        .map_err(|_| "TEMP_ERROR: 无法创建私有 PDF 临时目录。")?;
    command
        .current_dir(directory.path())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("TMPDIR", directory.path())
        .env("TMP", directory.path())
        .env("TEMP", directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let (child, pid) = {
        let _launch = process.launch.lock().unwrap_or_else(|e| e.into_inner());
        if process.stopping.load(Ordering::SeqCst) || *cancel.borrow() {
            return Err("CANCELLED: PDF 操作已取消。".into());
        }
        let child = command
            .spawn()
            .map_err(|_| "STARTUP_ERROR: 无法启动内置 PDF 引擎。")?;
        let pid = child
            .id()
            .ok_or("STARTUP_ERROR: 无法取得 PDF 引擎进程编号。")?;
        process.pid.store(pid, Ordering::SeqCst);
        (child, pid)
    };
    let mut owned = ProcessGuard {
        child: Some(child),
        pid,
        process,
    };
    let result = async {
        let child = owned.child.as_mut().expect("owned worker");
        let mut stdin = child.stdin.take().ok_or("STARTUP_ERROR: PDF 输入通道不可用。")?;
        let stdout = child.stdout.take().ok_or("STARTUP_ERROR: PDF 输出通道不可用。")?;
        let stderr = child.stderr.take().ok_or("STARTUP_ERROR: PDF 诊断通道不可用。")?;
        let writer = async move {
            stdin.write_all(&input).await.map_err(|_| "INPUT_ERROR: 传递 PDF 数据失败。".to_string())?;
            stdin.shutdown().await.map_err(|_| "INPUT_ERROR: 关闭 PDF 输入通道失败。".to_string())?;
            drop(stdin); // engine reads until EOF, not merely until the newline.
            Ok::<(), String>(())
        };
        let streams = async {
            let (_, output, _diagnostics, status) = tokio::try_join!(
                writer,
                read_limited(stdout, limits.output),
                read_limited(stderr, limits.stderr),
                async { child.wait().await.map_err(|_| "PROCESS_ERROR: 无法回收 PDF 引擎。".to_string()) },
            )?;
            if !status.success() {
                // Never surface raw stderr: it can contain document text or complete requests.
                return Err("PROCESS_EXIT: PDF 引擎异常退出，原文件未被替换。".into());
            }
            parse_response(&output, &request_id)
        };
        tokio::pin!(streams);
        tokio::select! {
            biased;
            _ = wait_cancel(&mut cancel) => Err("CANCELLED: PDF 操作已取消。".into()),
            _ = tokio::time::sleep_until(deadline) => Err("TIMEOUT: PDF 操作超过 120 秒，任务已停止，原文件未被替换。".into()),
            result = &mut streams => result,
        }
    }.await;
    // Also clean up stray descendants after a normal parent exit, then reap the parent.
    owned.terminate_and_reap().await;
    drop(owned);
    drop(directory);
    result
}

#[tauri::command]
pub async fn pdf_request(
    app: AppHandle,
    runtime: State<'_, PdfRuntime>,
    request: Value,
) -> Result<Value, String> {
    // Reserve before expensive encoding: a second 100 MiB request must fail busy immediately.
    let (guard, cancel, cancellation, process) = runtime.reserve()?;
    let (id, input) = encode_request(&request)?;
    drop(request);
    let command = pdf_command(&app)?;
    let mut cancel_on_drop = CancelOnDrop(Some(cancellation));
    // The process owner is detached from the IPC future so a dropped invocation cannot skip reaping.
    let task = tauri::async_runtime::spawn(async move {
        let result = supervise(command, input, id, cancel, process, Limits::default()).await;
        drop(guard);
        result
    });
    let result = task
        .await
        .map_err(|_| "PROCESS_ERROR: PDF 操作未能完成，任务已停止。".to_string())?;
    cancel_on_drop.0 = None;
    result
}

#[tauri::command]
pub async fn cancel_pdf(runtime: State<'_, PdfRuntime>) -> Result<bool, String> {
    match runtime.cancel_active(false) {
        Some(done) => {
            wait_done(done).await;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires npm run pdf:build for the current host"]
    async fn frozen_pdf_round_trip_uses_the_real_bundled_engine() {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut document = String::new();
        for operation in ["new", "inspect"] {
            let request = json!({
                "protocolVersion": 1, "requestId": operation, "operation": operation,
                "documentBase64": document, "options": {}
            });
            let (id, input) = encode_request(&request).unwrap();
            let (_sender, cancel) = watch::channel(false);
            let response = supervise(
                bundled_command(resources).unwrap(),
                input,
                id,
                cancel,
                Arc::new(WorkerProcess::default()),
                Limits::default(),
            )
            .await
            .unwrap();
            assert_eq!(response["ok"], true, "{response}");
            if operation == "new" {
                document = response["base64"]
                    .as_str()
                    .expect("new PDF bytes")
                    .to_owned();
                assert!(!document.is_empty());
            } else {
                assert_eq!(response["metadata"]["pageCount"], 1);
            }
        }
    }

    #[test]
    fn protocol_rejects_bad_envelopes_and_keeps_engine_errors() {
        for request in [
            json!([]),
            json!({"protocolVersion": 2, "requestId": "test"}),
            json!({"protocolVersion": 1}),
        ] {
            assert!(encode_request(&request).is_err());
        }
        let (id, input) =
            encode_request(&json!({"protocolVersion":1,"requestId":"test","operation":"inspect"}))
                .unwrap();
        assert_eq!(id, "test");
        assert_eq!(input.last(), Some(&b'\n'));
        let error = json!({"protocolVersion":1,"requestId":"test","ok":false,"error":{"code":"PASSWORD_REQUIRED","message":"需要密码"}});
        assert_eq!(
            parse_response(&serde_json::to_vec(&error).unwrap(), "test").unwrap(),
            error
        );
        assert!(parse_response(b"{}\n{}", "test").is_err());
        assert!(parse_response(
            br#"{"protocolVersion":1,"requestId":"wrong","ok":true}"#,
            "test"
        )
        .is_err());
    }

    #[test]
    fn input_writer_enforces_exact_limit_before_allocating_more() {
        let mut writer = LimitedInput {
            bytes: vec![],
            limit: 5,
            exceeded: false,
        };
        writer.write_all(b"12345").unwrap();
        assert!(writer.write_all(b"6").is_err());
        assert!(writer.exceeded);
        assert_eq!(writer.bytes, b"12345");
    }

    #[test]
    fn resolver_only_uses_fixed_runtime_and_requires_internal_libraries() {
        let root = tempfile::tempdir().unwrap();
        assert!(development_command(root.path()).is_err());
        let backend = root.path().join("pdf-backend");
        let python = if cfg!(windows) {
            backend.join(".venv").join("Scripts").join("python.exe")
        } else {
            backend.join(".venv").join("bin").join("python")
        };
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, b"placeholder").unwrap();
        std::fs::write(backend.join("engine.py"), b"placeholder").unwrap();
        assert_eq!(
            development_command(root.path())
                .unwrap()
                .as_std()
                .get_program(),
            python.as_os_str()
        );
        let directory = root.path().join("pdf-runtime");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join(if cfg!(windows) {
                "open-office-pdf.exe"
            } else {
                "open-office-pdf"
            }),
            b"placeholder",
        )
        .unwrap();
        assert!(bundled_command(root.path()).is_err());
        std::fs::create_dir(directory.join("_internal")).unwrap();
        assert!(bundled_command(root.path()).is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn busy_cancellation_and_shutdown_are_race_safe() {
        let runtime = PdfRuntime::default();
        let (guard, cancel, _, _) = runtime.reserve().unwrap();
        assert!(runtime.reserve().err().unwrap().starts_with("BUSY:"));
        let done = runtime.cancel_active(true).unwrap();
        assert!(*cancel.borrow());
        assert!(runtime.reserve().err().unwrap().starts_with("CLOSING:"));
        drop(guard);
        wait_done(done).await;
        runtime.shutdown().await;
        assert!(runtime.active.lock().unwrap().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pipe_limit_includes_every_byte() {
        assert_eq!(read_limited(&b"12345"[..], 5).await.unwrap(), b"12345");
        assert!(read_limited(&b"123456"[..], 5)
            .await
            .unwrap_err()
            .starts_with("OUTPUT_LIMIT:"));
    }

    #[cfg(unix)]
    fn mock_command(script: &'static str) -> Command {
        // Shell is only a fixed test fixture; no production entry point accepts it or its args.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn normal_result_drains_both_pipes_while_writing_and_removes_private_cwd() {
        let (_sender, cancel) = watch::channel(false);
        let process = Arc::new(WorkerProcess::default());
        let result = supervise(
            mock_command("head -c 200000 /dev/zero >&2; cat >/dev/null; printf '{\"protocolVersion\":1,\"requestId\":\"test\",\"ok\":true,\"cwd\":\"%s\"}' \"$PWD\""),
            vec![b'x'; 200000], "test".into(), cancel, process.clone(), Limits::default(),
        ).await.unwrap();
        assert_eq!(result["ok"], true);
        let path = PathBuf::from(result["cwd"].as_str().unwrap());
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("open-office-pdf-"));
        assert!(!path.exists());
        assert_eq!(process.pid.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn timeout_and_output_limits_kill_and_reap_worker() {
        for (script, expected) in [
            ("sleep 30 & wait", "TIMEOUT:"),
            ("head -c 20000 /dev/zero; sleep 30", "OUTPUT_LIMIT:"),
            ("head -c 20000 /dev/zero >&2; sleep 30", "OUTPUT_LIMIT:"),
        ] {
            let (_sender, cancel) = watch::channel(false);
            let process = Arc::new(WorkerProcess::default());
            let started = std::time::Instant::now();
            let error = supervise(
                mock_command(script),
                vec![],
                "test".into(),
                cancel,
                process.clone(),
                Limits {
                    output: 10000,
                    stderr: 10000,
                    timeout: Duration::from_millis(250),
                },
            )
            .await
            .unwrap_err();
            assert!(error.starts_with(expected), "{error}");
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_eq!(process.pid.load(Ordering::SeqCst), 0);
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_and_shutdown_wait_for_actual_worker_reaping() {
        let runtime = PdfRuntime::default();
        let (guard, cancel, _, process) = runtime.reserve().unwrap();
        let observed = process.clone();
        let task = tokio::spawn(async move {
            let result = supervise(
                mock_command("sleep 30 & wait"),
                vec![],
                "test".into(),
                cancel,
                observed,
                Limits::default(),
            )
            .await;
            drop(guard);
            result
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while process.pid.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let worker_pid = process.pid.load(Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(5), runtime.shutdown())
            .await
            .unwrap();
        assert!(task.await.unwrap().unwrap_err().starts_with("CANCELLED:"));
        assert_eq!(process.pid.load(Ordering::SeqCst), 0);
        assert_eq!(
            unsafe { libc::kill(worker_pid as i32, 0) },
            -1,
            "worker must be gone before shutdown completes"
        );
        assert!(runtime.active.lock().unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn nonzero_exit_and_extra_json_never_succeed_or_echo_document_text() {
        for (script, expected) in [
            ("cat >/dev/null; printf secret-pdf-text >&2; printf '{\"protocolVersion\":1,\"requestId\":\"test\",\"ok\":true}'; exit 4", "PROCESS_EXIT:"),
            ("cat >/dev/null; printf '{}{}'", "OUTPUT_INVALID:"),
        ] {
            let (_sender, cancel) = watch::channel(false);
            let error = supervise(mock_command(script), vec![], "test".into(), cancel, Arc::new(WorkerProcess::default()), Limits::default()).await.unwrap_err();
            assert!(error.starts_with(expected), "{error}");
            assert!(!error.contains("secret-pdf-text"));
        }
    }
}
