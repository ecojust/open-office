//! Local document capabilities. IPC accepts opaque document IDs, never filesystem paths.
//!
//! A path becomes a capability only after a native open/save dialog approves it. The
//! recent-file database preserves those capabilities across launches. All long-running
//! work runs off the UI thread; a separate operation token serializes mutations without
//! keeping the state mutex locked while a dialog, hash, or disk write is in progress.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;

const DOCUMENT_LIMIT: u64 = 100 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 20 * 1024 * 1024;
const ENCODED_LIMIT: usize = ((DOCUMENT_LIMIT as usize + 2) / 3) * 4;
const HISTORY_LIMIT: u64 = 2 * 1024 * 1024;
const MAX_RECENT: usize = 100;
const EXTENSIONS: &[&str] = &["docx", "odt", "xlsx", "ods", "pptx", "odp", "pdf"];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocExt {
    Docx,
    Odt,
    Xlsx,
    Ods,
    Pptx,
    Odp,
    Pdf,
}

impl DocExt {
    fn as_str(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Odt => "odt",
            Self::Xlsx => "xlsx",
            Self::Ods => "ods",
            Self::Pptx => "pptx",
            Self::Odp => "odp",
            Self::Pdf => "pdf",
        }
    }

    fn from_path(path: &Path) -> Result<Self, String> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .ok_or("文件缺少受支持的扩展名。")?;
        match extension.to_ascii_lowercase().as_str() {
            "docx" => Ok(Self::Docx),
            "odt" => Ok(Self::Odt),
            "xlsx" => Ok(Self::Xlsx),
            "ods" => Ok(Self::Ods),
            "pptx" => Ok(Self::Pptx),
            "odp" => Ok(Self::Odp),
            "pdf" => Ok(Self::Pdf),
            _ => Err("仅支持 DOCX、ODT、XLSX、ODS、PPTX、ODP 和 PDF 文件；不支持旧版 PPT。".into()),
        }
    }

    fn kind(self) -> DocumentKind {
        match self {
            Self::Docx | Self::Odt => DocumentKind::Word,
            Self::Xlsx | Self::Ods => DocumentKind::Sheet,
            Self::Pptx | Self::Odp => DocumentKind::Presentation,
            Self::Pdf => DocumentKind::Pdf,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Word,
    Sheet,
    Presentation,
    Pdf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDocument {
    pub id: String,
    pub name: String,
    pub extension: DocExt,
    pub kind: DocumentKind,
    pub base64: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImage {
    pub name: String,
    pub base64: String,
    pub mime_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    pub id: String,
    pub name: String,
    pub extension: DocExt,
    pub kind: DocumentKind,
    pub last_opened_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDocumentRequest {
    pub document_id: Option<String>,
    pub name: String,
    pub extension: DocExt,
    pub base64: String,
    pub expected_sha256: Option<String>,
    #[serde(default)]
    pub save_as: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub id: String,
    pub name: String,
    pub extension: DocExt,
    pub kind: DocumentKind,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SaveResult {
    Saved { document: SavedDocument },
    Cancelled,
    Conflict { message: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDocument {
    id: String,
    path: PathBuf,
    extension: DocExt,
    sha256: String,
    last_opened_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    version: u32,
    documents: Vec<StoredDocument>,
}

struct StoreInner {
    history_path: PathBuf,
    documents: Mutex<Vec<StoredDocument>>,
    busy: AtomicBool,
}

#[derive(Clone)]
pub struct DocumentStore {
    inner: Arc<StoreInner>,
}

struct OperationGuard(Arc<StoreInner>);

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

impl DocumentStore {
    /// `app_data_directory` must be obtained from Tauri's application path resolver,
    /// never supplied by a webview command argument.
    pub fn new(app_data_directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&app_data_directory)
            .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
        let history_path = app_data_directory.join("recent-files.json");
        let documents = match File::open(&history_path) {
            Ok(file) => {
                let bytes = read_limited(file, HISTORY_LIMIT, "最近文件记录")?;
                let history: History = serde_json::from_slice(&bytes).map_err(|error| {
                    format!("最近文件记录损坏，请保留该记录并联系支持：{error}")
                })?;
                if history.version != 1 || history.documents.len() > MAX_RECENT {
                    return Err("最近文件记录的版本或长度不正确。".into());
                }
                let mut ids = std::collections::HashSet::new();
                let mut paths = std::collections::HashSet::new();
                for document in &history.documents {
                    if !valid_id(&document.id)
                        || !valid_hash(&document.sha256)
                        || !document.path.is_absolute()
                        || DocExt::from_path(&document.path)? != document.extension
                        || document.path.file_name().is_none()
                        || !ids.insert(document.id.clone())
                        || !paths.insert(document.path.clone())
                    {
                        return Err("最近文件记录含有无效条目。".into());
                    }
                }
                history.documents
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("无法读取最近文件记录：{error}")),
        };
        Ok(Self {
            inner: Arc::new(StoreInner {
                history_path,
                documents: Mutex::new(documents),
                busy: AtomicBool::new(false),
            }),
        })
    }

    fn begin_operation(&self) -> Result<OperationGuard, String> {
        self.inner
            .busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "另一个文件操作尚未完成，请关闭文件窗口或稍后重试。".to_string())?;
        Ok(OperationGuard(self.inner.clone()))
    }

    fn records(&self) -> Result<Vec<StoredDocument>, String> {
        self.inner
            .documents
            .lock()
            .map(|records| records.clone())
            .map_err(|_| "文件状态不可用，请重新启动应用。".into())
    }

    fn replace_records(&self, records: Vec<StoredDocument>) -> Result<(), String> {
        *self
            .inner
            .documents
            .lock()
            .map_err(|_| "文件状态不可用，请重新启动应用。".to_string())? = records;
        Ok(())
    }

    fn record(&self, id: &str) -> Result<StoredDocument, String> {
        if !valid_id(id) {
            return Err("文档标识无效，请通过文件选择窗口打开文档。".into());
        }
        self.inner
            .documents
            .lock()
            .map_err(|_| "文件状态不可用，请重新启动应用。".to_string())?
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or_else(|| "此文档尚未授权，请通过文件选择窗口重新打开。".into())
    }

    /// A native-only helper for future local conversion/rendering work. This is not
    /// an HTTP route or an IPC command and cannot grant a new file capability.
    pub(crate) fn approved_document_path(&self, id: &str) -> Result<PathBuf, String> {
        let record = self.record(id)?;
        verify_record_path(&record)?;
        Ok(record.path)
    }

    fn stage_history(&self, records: &[StoredDocument]) -> Result<NamedTempFile, String> {
        let mut recent = records.to_vec();
        recent.sort_by(|left, right| {
            right
                .last_opened_at
                .cmp(&left.last_opened_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        recent.truncate(MAX_RECENT);
        let bytes = serde_json::to_vec_pretty(&History {
            version: 1,
            documents: recent,
        })
        .map_err(|error| format!("无法编码最近文件记录：{error}"))?;
        if bytes.len() as u64 > HISTORY_LIMIT {
            return Err("最近文件记录超过大小上限。".into());
        }
        stage_bytes(&self.inner.history_path, &bytes, None)
    }

    fn register_open(&self, path: PathBuf) -> Result<NativeDocument, String> {
        let extension = DocExt::from_path(&path)?;
        let path = fs::canonicalize(&path).map_err(|error| format!("无法打开所选文件：{error}"))?;
        if DocExt::from_path(&path)? != extension {
            return Err("所选链接的目标文件类型不同，请直接选择实际文档。".into());
        }
        let bytes = read_document(&path)?;
        let hash = hash_bytes(&bytes);
        let mut records = self.records()?;
        let record = upsert_record(&mut records, path, extension, hash.clone())?;
        let name = file_name(&record.path)?;
        let staged_history = self.stage_history(&records)?;
        staged_history
            .persist(&self.inner.history_path)
            .map_err(|error| format!("无法保存最近文件记录：{error}"))?;
        self.replace_records(records)?;
        Ok(NativeDocument {
            id: record.id,
            name,
            extension,
            kind: extension.kind(),
            base64: STANDARD.encode(&bytes),
            sha256: hash,
            size_bytes: bytes.len() as u64,
        })
    }

    fn save_to_target(
        &self,
        snapshot: TargetSnapshot,
        extension: DocExt,
        bytes: Vec<u8>,
    ) -> Result<SaveResult, String> {
        let mut records = self.records()?;
        let hash = hash_bytes(&bytes);
        let record = upsert_record(&mut records, snapshot.path.clone(), extension, hash.clone())?;
        let name = file_name(&record.path)?;
        // Stage and sync BOTH writes first. A full/read-only app-data directory must
        // not alter the user's document merely because history could not be saved.
        let staged_history = self.stage_history(&records)?;
        let staged_document = stage_bytes(&snapshot.path, &bytes, snapshot.permissions.clone())?;
        match replace_if_unchanged(staged_document, &snapshot) {
            Ok(()) => {}
            Err(ReplaceError::Conflict(message)) => return Ok(SaveResult::Conflict { message }),
            Err(ReplaceError::Io(message)) => return Err(message),
        }
        // The document is now on disk. Keep memory aligned even if the independent
        // history-file rename fails; never report success/clear UI dirty in that case.
        self.replace_records(records)?;
        staged_history
            .persist(&self.inner.history_path)
            .map_err(|error| {
                format!(
                    "文档内容已写入，但最近文件记录保存失败；编辑器应保留未保存标记。请另存为或重新打开核对内容：{error}"
                )
            })?;
        Ok(SaveResult::Saved {
            document: SavedDocument {
                id: record.id,
                name,
                extension,
                kind: extension.kind(),
                sha256: hash,
                size_bytes: bytes.len() as u64,
            },
        })
    }
}

fn valid_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn new_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法创建文档标识：{error}"))?;
    Ok(hex::encode(bytes))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn upsert_record(
    records: &mut Vec<StoredDocument>,
    path: PathBuf,
    extension: DocExt,
    sha256: String,
) -> Result<StoredDocument, String> {
    if let Some(record) = records.iter_mut().find(|record| record.path == path) {
        record.extension = extension;
        record.sha256 = sha256;
        record.last_opened_at = now_millis();
        return Ok(record.clone());
    }
    let record = StoredDocument {
        id: new_id()?,
        path,
        extension,
        sha256,
        last_opened_at: now_millis(),
    };
    records.push(record.clone());
    Ok(record)
}

fn file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "文件名不是有效的 Unicode 文本。".into())
}

fn validate_file_name(name: &str, extension: DocExt) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 240
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
                )
        })
        || name.ends_with(['.', ' '])
        || name.starts_with('.')
    {
        return Err("文件名不能含有路径、控制字符或系统保留字符。".into());
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("文件名无效。")?;
    let device = stem
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
        || DocExt::from_path(Path::new(name))? != extension
    {
        return Err("文件名或扩展名与保存类型不一致。".into());
    }
    Ok(())
}

fn decode_document(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > ENCODED_LIMIT {
        return Err("文档超过 100 MB 大小上限。".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "文档数据不是有效的 Base64 编码。".to_string())?;
    if bytes.len() as u64 > DOCUMENT_LIMIT {
        return Err("文档超过 100 MB 大小上限。".into());
    }
    if bytes.is_empty() {
        return Err("无法保存空的文档数据。".into());
    }
    Ok(bytes)
}

fn read_limited(file: File, limit: u64, description: &str) -> Result<Vec<u8>, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取{description}信息：{error}"))?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(format!("{description}不是普通文件或超过大小上限。"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取{description}：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{description}超过大小上限。"));
    }
    Ok(bytes)
}

fn read_document(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("无法读取文档：{error}"))?;
    read_limited(file, DOCUMENT_LIMIT, "文档")
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn verify_record_path(record: &StoredDocument) -> Result<(), String> {
    let canonical = fs::canonicalize(&record.path)
        .map_err(|error| format!("文档可能已移动或删除，请重新选择文件：{error}"))?;
    if canonical != record.path || DocExt::from_path(&canonical)? != record.extension {
        return Err("文档路径已变更为其他位置，请通过文件选择窗口重新授权。".into());
    }
    if !fs::metadata(&canonical)
        .map_err(|error| format!("无法检查文档：{error}"))?
        .is_file()
    {
        return Err("已授权的位置不再是普通文件。".into());
    }
    Ok(())
}

struct TargetSnapshot {
    path: PathBuf,
    sha256: Option<String>,
    permissions: Option<fs::Permissions>,
}

impl TargetSnapshot {
    fn capture(path: PathBuf) -> Result<Self, String> {
        // Canonicalize the parent, not a nonexistent target. This also prevents a
        // later save through a replaced directory symlink from changing locations.
        let parent = path.parent().ok_or("保存位置缺少父目录。")?;
        let canonical_parent =
            fs::canonicalize(parent).map_err(|error| format!("无法访问保存目录：{error}"))?;
        let path = canonical_parent.join(path.file_name().ok_or("保存文件名无效。")?);
        let (sha256, permissions) = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("不能覆盖符号链接或特殊文件，请选择普通文件。".into());
                }
                if metadata.permissions().readonly() {
                    return Err("所选文件为只读，请另存到可写位置。".into());
                }
                (
                    Some(hash_bytes(&read_document(&path)?)),
                    Some(metadata.permissions()),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
            Err(error) => return Err(format!("无法检查保存位置：{error}")),
        };
        Ok(Self {
            path,
            sha256,
            permissions,
        })
    }
}

fn stage_bytes(
    destination: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<NamedTempFile, String> {
    let parent = destination.parent().ok_or("保存位置缺少父目录。")?;
    let mut staged = NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法在保存目录创建临时文件：{error}"))?;
    staged
        .write_all(bytes)
        .map_err(|error| format!("文档写入失败，原文件未改动：{error}"))?;
    if let Some(permissions) = permissions {
        staged
            .as_file()
            .set_permissions(permissions)
            .map_err(|error| format!("无法保留文件权限，原文件未改动：{error}"))?;
    }
    staged
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法完成文件同步，原文件未改动：{error}"))?;
    Ok(staged)
}

#[derive(Debug)]
enum ReplaceError {
    Conflict(String),
    Io(String),
}

fn replace_if_unchanged(
    staged: NamedTempFile,
    target: &TargetSnapshot,
) -> Result<(), ReplaceError> {
    let changed = || {
        ReplaceError::Conflict(
            "文件已被其他应用修改、移动或替换。为保护外部改动，请重新打开，或将当前内容另存为。"
                .into(),
        )
    };
    let parent = target.path.parent().ok_or_else(changed)?;
    if fs::canonicalize(parent).map_err(|_| changed())? != parent {
        return Err(changed());
    }
    let current_hash = match fs::symlink_metadata(&target.path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(changed());
            }
            Some(hash_bytes(
                &read_document(&target.path).map_err(ReplaceError::Io)?,
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(ReplaceError::Io(format!("无法复核目标文件：{error}"))),
    };
    if current_hash != target.sha256 {
        return Err(changed());
    }
    // tempfile uses an atomic replacement on both Windows and Unix; never delete
    // the destination first. An uncooperative external writer can still race the
    // final hash/rename interval (filesystems offer no portable hash-CAS operation).
    if target.sha256.is_none() {
        staged.persist_noclobber(&target.path).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                changed()
            } else {
                ReplaceError::Io(format!("保存失败，原文件未改动：{error}"))
            }
        })?;
    } else {
        staged
            .persist(&target.path)
            .map_err(|error| ReplaceError::Io(format!("替换失败，原文件未改动：{error}")))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_document(
    app: AppHandle,
    store: State<'_, DocumentStore>,
) -> Result<Option<NativeDocument>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = store.begin_operation()?;
        let selected = app
            .dialog()
            .file()
            .add_filter("办公文档", EXTENSIONS)
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "请选择此电脑上的本地文档。".to_string())?;
        store.register_open(path).map(Some)
    })
    .await
    .map_err(|error| format!("打开文件操作异常：{error}"))?
}

#[tauri::command]
pub async fn open_recent(
    document_id: String,
    store: State<'_, DocumentStore>,
) -> Result<NativeDocument, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = store.begin_operation()?;
        let path = store.approved_document_path(&document_id)?;
        store.register_open(path)
    })
    .await
    .map_err(|error| format!("打开最近文件操作异常：{error}"))?
}

fn image_mime_type(path: &Path, bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() as u64 > IMAGE_LIMIT {
        return Err("图片超过 20 MB 大小上限。".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    match extension.to_ascii_lowercase().as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok("image/png"),
        "jpg" | "jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Ok("image/jpeg"),
        "png" | "jpg" | "jpeg" => Err("图片内容与文件类型不符，或文件已损坏。".into()),
        _ => Err("请选择 PNG 或 JPEG 图片。".into()),
    }
}

#[tauri::command]
pub async fn pick_image(
    app: AppHandle,
    store: State<'_, DocumentStore>,
) -> Result<Option<NativeImage>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = store.begin_operation()?;
        let Some(selected) = app
            .dialog()
            .file()
            .add_filter("图片", &["png", "jpg", "jpeg"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "请选择此电脑上的本地图片。".to_string())?;
        let file = File::open(&path).map_err(|error| format!("无法读取图片：{error}"))?;
        let bytes = read_limited(file, IMAGE_LIMIT, "图片")?;
        let mime_type = image_mime_type(&path, &bytes)?;
        Ok(Some(NativeImage {
            name: file_name(&path)?,
            base64: STANDARD.encode(&bytes),
            mime_type: mime_type.into(),
        }))
    })
    .await
    .map_err(|error| format!("选择图片操作异常：{error}"))?
}

#[tauri::command]
pub fn list_recent_documents(
    store: State<'_, DocumentStore>,
) -> Result<Vec<RecentDocument>, String> {
    let mut records = store.records()?;
    records.sort_by(|left, right| {
        right
            .last_opened_at
            .cmp(&left.last_opened_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    records.truncate(MAX_RECENT);
    records
        .into_iter()
        .map(|record| {
            Ok(RecentDocument {
                name: file_name(&record.path)?,
                id: record.id,
                extension: record.extension,
                kind: record.extension.kind(),
                last_opened_at: record.last_opened_at,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn save_document(
    request: SaveDocumentRequest,
    app: AppHandle,
    store: State<'_, DocumentStore>,
) -> Result<SaveResult, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = store.begin_operation()?;
        validate_file_name(&request.name, request.extension)?;
        let bytes = decode_document(&request.base64)?;
        let existing = request
            .document_id
            .as_deref()
            .map(|id| store.record(id))
            .transpose()?;
        let target = if let Some(record) = existing.as_ref().filter(|_| !request.save_as) {
            if request.extension != record.extension {
                return Err("变更文档格式时必须使用另存为。".into());
            }
            let Some(expected) = request.expected_sha256.as_deref() else {
                return Ok(SaveResult::Conflict {
                    message: "缺少原文档版本信息，请重新打开文档或另存为。".into(),
                });
            };
            if !valid_hash(expected) || !expected.eq_ignore_ascii_case(&record.sha256) {
                return Ok(SaveResult::Conflict {
                    message: "当前编辑版本已过期，请重新打开文档或另存为，以免覆盖更新。".into(),
                });
            }
            if let Err(message) = verify_record_path(record) {
                return Ok(SaveResult::Conflict { message });
            }
            let snapshot = TargetSnapshot::capture(record.path.clone())?;
            if snapshot.sha256.as_deref() != Some(record.sha256.as_str()) {
                return Ok(SaveResult::Conflict {
                    message: "磁盘文件已被其他应用修改，请重新打开文档，或将当前编辑内容另存为。"
                        .into(),
                });
            }
            snapshot
        } else {
            let mut dialog = app
                .dialog()
                .file()
                .set_file_name(&request.name)
                .add_filter("办公文档", &[request.extension.as_str()]);
            if let Some(parent) = existing.as_ref().and_then(|record| record.path.parent()) {
                dialog = dialog.set_directory(parent);
            }
            let Some(selected) = dialog.blocking_save_file() else {
                return Ok(SaveResult::Cancelled);
            };
            let mut path = selected
                .into_path()
                .map_err(|_| "请选择此电脑上的本地保存位置。".to_string())?;
            if path.extension().is_none() {
                path.set_extension(request.extension.as_str());
            }
            validate_file_name(&file_name(&path)?, request.extension)?;
            TargetSnapshot::capture(path)?
        };
        store.save_to_target(target, request.extension, bytes)
    })
    .await
    .map_err(|error| format!("保存文件操作异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_formats_serialize_without_enabling_legacy_or_mismatched_files() {
        for (extension, name) in [(DocExt::Pptx, "pptx"), (DocExt::Odp, "odp")] {
            assert!(
                EXTENSIONS.contains(&name),
                "Native open dialog must expose {name}"
            );
            assert_eq!(
                extension.as_str(),
                name,
                "Save dialog must use the exact format"
            );
            assert_eq!(serde_json::to_value(extension).unwrap(), name);
            assert_eq!(
                serde_json::from_value::<DocExt>(serde_json::json!(name)).unwrap(),
                extension
            );
            assert_eq!(
                DocExt::from_path(Path::new(&format!(
                    "项目汇报.{}",
                    name.to_ascii_uppercase()
                )))
                .unwrap(),
                extension
            );
            assert_eq!(
                serde_json::to_value(extension.kind()).unwrap(),
                "presentation"
            );
            assert!(validate_file_name(&format!("项目汇报.{name}"), extension).is_ok());
            for wrong in [
                "项目汇报.ppt",
                "项目汇报.pptm",
                "项目汇报.docx",
                "../slides.pptx",
                "CON.pptx",
            ] {
                assert!(
                    validate_file_name(wrong, extension).is_err(),
                    "Accepted {wrong}"
                );
            }
        }
        assert!(validate_file_name("项目汇报.odp", DocExt::Pptx).is_err());
        assert!(validate_file_name("项目汇报.pptx", DocExt::Odp).is_err());
        assert!(serde_json::from_value::<DocExt>(serde_json::json!("ppt")).is_err());
        assert!(!EXTENSIONS.contains(&"ppt"));
    }

    #[test]
    fn presentation_save_and_history_reopen_preserve_bytes_identity_and_kind() {
        // This tests the native opaque-byte file bridge; Impress parsing and
        // actual slide edits are exercised by the separate engine round trips.
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("app-data");
        let store = DocumentStore::new(data.clone()).unwrap();
        let existing = directory.path().join("已有文档.docx");
        fs::write(&existing, b"existing word document").unwrap();
        let word = store.register_open(existing).unwrap();
        for extension in [DocExt::Pptx, DocExt::Odp] {
            let path = directory
                .path()
                .join(format!("汇报.{}", extension.as_str()));
            fs::write(&path, b"original slide fixture").unwrap();
            let opened = store.register_open(path.clone()).unwrap();
            assert_eq!(opened.kind, DocumentKind::Presentation);
            assert_eq!(opened.extension, extension);
            assert_eq!(
                STANDARD.decode(&opened.base64).unwrap(),
                b"original slide fixture"
            );
            let snapshot = TargetSnapshot::capture(path.clone()).unwrap();
            let SaveResult::Saved { document } = store
                .save_to_target(snapshot, extension, b"edited slide fixture".to_vec())
                .unwrap()
            else {
                panic!("Expected saved presentation")
            };
            assert_eq!(document.id, opened.id);
            assert_eq!(document.kind, DocumentKind::Presentation);
            assert_eq!(document.sha256, hash_bytes(b"edited slide fixture"));
            assert_eq!(fs::read(&path).unwrap(), b"edited slide fixture");
            let receipt = serde_json::to_value(&document).unwrap();
            assert_eq!(receipt["kind"], "presentation");
            assert_eq!(receipt["extension"], extension.as_str());
            assert!(receipt.get("path").is_none());
            let restored = DocumentStore::new(data.clone()).unwrap();
            let approved = restored.approved_document_path(&document.id).unwrap();
            let reopened = restored.register_open(approved).unwrap();
            assert_eq!(reopened.id, opened.id);
            assert_eq!(reopened.kind, DocumentKind::Presentation);
            assert_eq!(reopened.sha256, document.sha256);
            assert_eq!(
                STANDARD.decode(&reopened.base64).unwrap(),
                b"edited slide fixture"
            );
            assert_eq!(restored.record(&word.id).unwrap().extension, DocExt::Docx);
        }
    }

    #[test]
    fn presentation_conflict_preserves_external_edits_and_original_history() {
        for extension in [DocExt::Pptx, DocExt::Odp] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory
                .path()
                .join(format!("slides.{}", extension.as_str()));
            fs::write(&path, b"original slides").unwrap();
            let store = DocumentStore::new(directory.path().join("data")).unwrap();
            let opened = store.register_open(path.clone()).unwrap();
            let snapshot = TargetSnapshot::capture(path.clone()).unwrap();
            fs::write(&path, b"slides edited elsewhere").unwrap();
            assert!(matches!(
                store
                    .save_to_target(snapshot, extension, b"my slides".to_vec())
                    .unwrap(),
                SaveResult::Conflict { .. }
            ));
            assert_eq!(fs::read(path).unwrap(), b"slides edited elsewhere");
            assert_eq!(store.record(&opened.id).unwrap().sha256, opened.sha256);
        }
    }

    #[test]
    fn names_cannot_select_paths_devices_or_different_types() {
        for valid in ["报告.docx", "财务 2026.xlsx", "笔记.ODT", "文档.pdf"] {
            assert!(
                validate_file_name(valid, DocExt::from_path(Path::new(valid)).unwrap()).is_ok()
            );
        }
        for invalid in [
            "../report.docx",
            "C:\\report.docx",
            "http://file.docx",
            "CON.docx",
            "LPT1.docx",
            "nul.backup.docx",
            "report.docx ",
            ".docx",
            "file\n.docx",
            "file.exe",
            "report.xlsx",
        ] {
            assert!(
                validate_file_name(invalid, DocExt::Docx).is_err(),
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn external_changes_before_replacement_preserve_external_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.docx");
        fs::write(&path, b"original").unwrap();
        let snapshot = TargetSnapshot::capture(path.clone()).unwrap();
        let staged = stage_bytes(&path, b"my edits", None).unwrap();
        fs::write(&path, b"external edits").unwrap();
        assert!(matches!(
            replace_if_unchanged(staged, &snapshot),
            Err(ReplaceError::Conflict(_))
        ));
        assert_eq!(fs::read(path).unwrap(), b"external edits");
    }

    #[test]
    fn target_created_after_save_dialog_is_not_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("new.ods");
        let snapshot = TargetSnapshot::capture(path.clone()).unwrap();
        let staged = stage_bytes(&path, b"my edits", None).unwrap();
        fs::write(&path, b"someone else's new file").unwrap();
        assert!(matches!(
            replace_if_unchanged(staged, &snapshot),
            Err(ReplaceError::Conflict(_))
        ));
        assert_eq!(fs::read(path).unwrap(), b"someone else's new file");
    }

    #[test]
    fn successful_save_is_atomic_and_restores_approved_recent_document() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("app-data");
        let path = directory.path().join("report.docx");
        fs::write(&path, b"original").unwrap();
        let store = DocumentStore::new(data.clone()).unwrap();
        let first = store.register_open(path.clone()).unwrap();
        let target = TargetSnapshot::capture(path.clone()).unwrap();
        let result = store
            .save_to_target(target, DocExt::Docx, b"new contents".to_vec())
            .unwrap();
        let SaveResult::Saved { document } = result else {
            panic!("expected successful save")
        };
        assert_eq!(first.id, document.id);
        assert_eq!(document.sha256, hash_bytes(b"new contents"));
        assert_eq!(fs::read(&path).unwrap(), b"new contents");
        let restored = DocumentStore::new(data).unwrap();
        assert_eq!(
            restored.approved_document_path(&first.id).unwrap(),
            fs::canonicalize(path).unwrap()
        );
        assert_eq!(restored.record(&first.id).unwrap().sha256, document.sha256);
        let serialized = serde_json::to_value(&document).unwrap();
        assert_eq!(serialized["sizeBytes"], 12);
        assert!(serialized.get("path").is_none());
    }

    #[test]
    fn rejected_save_does_not_change_record_or_source() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.xlsx");
        fs::write(&path, b"original").unwrap();
        let store = DocumentStore::new(directory.path().join("data")).unwrap();
        let opened = store.register_open(path.clone()).unwrap();
        let target = TargetSnapshot::capture(path.clone()).unwrap();
        fs::write(&path, b"outside update").unwrap();
        let result = store
            .save_to_target(target, DocExt::Xlsx, b"new contents".to_vec())
            .unwrap();
        assert!(matches!(result, SaveResult::Conflict { .. }));
        assert_eq!(store.record(&opened.id).unwrap().sha256, opened.sha256);
        assert_eq!(fs::read(path).unwrap(), b"outside update");
    }

    #[test]
    fn metadata_staging_failure_does_not_replace_source() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let path = directory.path().join("report.pdf");
        fs::write(&path, b"original").unwrap();
        let store = DocumentStore::new(data.clone()).unwrap();
        let opened = store.register_open(path.clone()).unwrap();
        fs::remove_dir_all(&data).unwrap();
        fs::write(&data, b"not a directory").unwrap();
        let target = TargetSnapshot::capture(path.clone()).unwrap();
        assert!(store
            .save_to_target(target, DocExt::Pdf, b"edits".to_vec())
            .is_err());
        assert_eq!(fs::read(path).unwrap(), b"original");
        assert_eq!(store.record(&opened.id).unwrap().sha256, opened.sha256);
    }

    #[test]
    fn concurrent_operations_are_rejected_without_locking_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = DocumentStore::new(directory.path().to_path_buf()).unwrap();
        let operation = store.begin_operation().unwrap();
        assert!(store.begin_operation().is_err());
        assert!(store.records().is_ok());
        drop(operation);
        assert!(store.begin_operation().is_ok());
        assert!(store.approved_document_path("../../secret.pdf").is_err());
        assert!(store.approved_document_path(&"a".repeat(32)).is_err());
    }

    #[test]
    fn encoded_input_must_be_nonempty_base64_and_within_limit() {
        assert_eq!(decode_document("aGVsbG8=").unwrap(), b"hello");
        assert!(decode_document("").is_err());
        assert!(decode_document("data:application/pdf;base64,aGVsbG8=").is_err());
        assert!(decode_document("invalid base64!").is_err());
    }

    #[test]
    fn image_extension_must_match_magic_and_svg_is_not_accepted() {
        let png = b"\x89PNG\r\n\x1a\n";
        let jpeg = &[0xff, 0xd8, 0xff, 0xe0];
        assert_eq!(
            image_mime_type(Path::new("图.PNG"), png).unwrap(),
            "image/png"
        );
        assert_eq!(
            image_mime_type(Path::new("图.jpeg"), jpeg).unwrap(),
            "image/jpeg"
        );
        assert!(image_mime_type(Path::new("fake.png"), jpeg).is_err());
        assert!(image_mime_type(Path::new("fake.jpg"), png).is_err());
        assert!(image_mime_type(Path::new("fake.svg"), png).is_err());
        assert!(image_mime_type(Path::new("fake.png"), b"<svg>script</svg>").is_err());
        assert!(image_mime_type(Path::new("empty.jpg"), b"").is_err());
    }

    #[test]
    fn bounded_reader_rejects_an_oversized_image_before_allocating_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        let file = File::create(&path).unwrap();
        file.set_len(IMAGE_LIMIT + 1).unwrap();
        drop(file);
        assert!(read_limited(File::open(path).unwrap(), IMAGE_LIMIT, "图片").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_approved_path_with_symlink_revokes_access() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.docx");
        let other = directory.path().join("other.docx");
        fs::write(&path, b"original").unwrap();
        fs::write(&other, b"other file").unwrap();
        let store = DocumentStore::new(directory.path().join("data")).unwrap();
        let opened = store.register_open(path.clone()).unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert!(store.approved_document_path(&opened.id).is_err());
        assert!(TargetSnapshot::capture(path).is_err());
        assert_eq!(fs::read(other).unwrap(), b"other file");
    }
}
