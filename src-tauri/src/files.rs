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
const NOTEBOOK_LIMIT: usize = 16 * 1024 * 1024;
const ENCODED_LIMIT: usize = ((DOCUMENT_LIMIT as usize + 2) / 3) * 4;
const HISTORY_LIMIT: u64 = 2 * 1024 * 1024;
const MAX_RECENT: usize = 100;
const EXTENSIONS: &[&str] = &[
    "docx", "xlsx", "csv", "tsv", "pptx", "potx", "ppsx", "pdf", "oonote",
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
// Keep retired variants readable so a previous recent-file database can be
// migrated entry by entry. They are rejected by from_path and cannot be opened
// or exported; no retired engine is registered or loaded.
pub enum DocExt {
    Docx,
    Odt,
    Doc,
    Rtf,
    Xlsx,
    Csv,
    Tsv,
    Ods,
    Xls,
    Pptx,
    Potx,
    Ppsx,
    Odp,
    Ppt,
    Pdf,
    Oonote,
}

impl DocExt {
    fn as_str(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Odt => "odt",
            Self::Doc => "doc",
            Self::Rtf => "rtf",
            Self::Xlsx => "xlsx",
            Self::Csv => "csv",
            Self::Tsv => "tsv",
            Self::Ods => "ods",
            Self::Xls => "xls",
            Self::Pptx => "pptx",
            Self::Potx => "potx",
            Self::Ppsx => "ppsx",
            Self::Odp => "odp",
            Self::Ppt => "ppt",
            Self::Pdf => "pdf",
            Self::Oonote => "oonote",
        }
    }

    fn from_path(path: &Path) -> Result<Self, String> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .ok_or("文件缺少受支持的扩展名。")?;
        match extension.to_ascii_lowercase().as_str() {
            "docx" => Ok(Self::Docx),
            "xlsx" => Ok(Self::Xlsx),
            "csv" => Ok(Self::Csv),
            "tsv" => Ok(Self::Tsv),
            "pptx" => Ok(Self::Pptx),
            "potx" => Ok(Self::Potx),
            "ppsx" => Ok(Self::Ppsx),
            "pdf" => Ok(Self::Pdf),
            "oonote" => Ok(Self::Oonote),
            _ => Err("请选择 DOCX、XLSX、CSV、TSV、PPTX、POTX、PPSX、PDF 或 OONOTE 文件；其他格式请先转换为受支持的格式。".into()),
        }
    }

    fn kind(self) -> DocumentKind {
        match self {
            Self::Docx | Self::Odt | Self::Doc | Self::Rtf => DocumentKind::Word,
            Self::Xlsx | Self::Csv | Self::Tsv | Self::Ods | Self::Xls => DocumentKind::Sheet,
            Self::Pptx | Self::Potx | Self::Ppsx | Self::Odp | Self::Ppt => {
                DocumentKind::Presentation
            }
            Self::Pdf => DocumentKind::Pdf,
            Self::Oonote => DocumentKind::Note,
        }
    }

    fn ensure_exportable(self) -> Result<(), String> {
        if !matches!(
            self,
            Self::Docx | Self::Xlsx | Self::Csv | Self::Tsv | Self::Pptx | Self::Pdf | Self::Oonote
        ) {
            return Err(
                "此格式不能直接保存。演示模板和放映文件请另存为 PPTX 副本，原文件将保留。".into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Word,
    Sheet,
    Presentation,
    Pdf,
    Note,
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
    /// Other currently open tabs, supplied by the shell before showing Save As.
    #[serde(default)]
    pub protected_document_ids: Vec<String>,
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
                        || !document
                            .path
                            .extension()
                            .and_then(|value| value.to_str())
                            .is_some_and(|value| {
                                value.eq_ignore_ascii_case(document.extension.as_str())
                            })
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
        validate_document_signature(&bytes, extension)?;
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

    /// The caller must be the opt-in native smoke session. The directory is
    /// owned by that session; neither its path nor a filename comes from IPC.
    pub(crate) fn create_smoke_document(
        &self,
        directory: &Path,
        extension: DocExt,
        encoded: &str,
    ) -> Result<NativeDocument, String> {
        let _operation = self.begin_operation()?;
        if !matches!(
            extension,
            DocExt::Docx | DocExt::Xlsx | DocExt::Pptx | DocExt::Pdf | DocExt::Oonote
        ) {
            return Err("Native smoke requires an editable document format.".into());
        }
        let bytes = decode_document(encoded)?;
        validate_document_signature(&bytes, extension)?;
        let path = directory.join(format!("native-workspace.{}", extension.as_str()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Unable to create isolated native smoke document: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Unable to write isolated native smoke document: {error}"))?;
        drop(file);
        self.register_open(path)
    }

    /// Saving an opened document always targets its approved original path. The
    /// displayed filename is not a new capability and never changes that path.
    /// Callers hold the operation guard through validation and atomic replacement.
    fn save_existing(
        &self,
        record: &StoredDocument,
        extension: DocExt,
        expected_sha256: Option<&str>,
        bytes: Vec<u8>,
    ) -> Result<SaveResult, String> {
        if extension != record.extension {
            return Err("变更文档格式时必须使用另存为。".into());
        }
        let Some(expected) = expected_sha256 else {
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
        self.save_to_target(snapshot, extension, bytes)
    }

    fn ensure_target_not_open(
        &self,
        target: &TargetSnapshot,
        protected_document_ids: &[String],
    ) -> Result<(), String> {
        validate_protected_document_ids(protected_document_ids)?;
        // Existing filenames can differ in case on case-insensitive volumes.
        // Resolve them just as open does before comparing approved identities.
        let path = if target.sha256.is_some() {
            fs::canonicalize(&target.path).map_err(|error| format!("无法复核保存位置：{error}"))?
        } else {
            target.path.clone()
        };
        if self
            .records()?
            .iter()
            .any(|record| protected_document_ids.contains(&record.id) && record.path == path)
        {
            return Err("该文件已在其他标签中打开，请切换到该标签或选择其他保存位置。".into());
        }
        Ok(())
    }

    fn save_to_target(
        &self,
        snapshot: TargetSnapshot,
        extension: DocExt,
        bytes: Vec<u8>,
    ) -> Result<SaveResult, String> {
        extension.ensure_exportable()?;
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

fn validate_protected_document_ids(ids: &[String]) -> Result<(), String> {
    if ids.len() > MAX_RECENT || ids.iter().any(|id| !valid_id(id)) {
        return Err("已打开文档列表无效，请关闭保存窗口后重试。".into());
    }
    Ok(())
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

/// Bound the versioned notebook envelope before exposing it to the editor. The
/// editor additionally validates block content, inline marks and image payloads.
fn valid_notebook(bytes: &[u8]) -> bool {
    if bytes.len() > NOTEBOOK_LIMIT {
        return false;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let Ok(notebook) =
        serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}'))
    else {
        return false;
    };
    if notebook.get("format").and_then(|value| value.as_str()) != Some("open-office-notebook")
        || notebook.get("version").and_then(|value| value.as_u64()) != Some(1)
    {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    let valid_node =
        |node: &serde_json::Value, titled: bool, ids: &mut std::collections::HashSet<String>| {
            let Some(id) = node.get("id").and_then(|value| value.as_str()) else {
                return false;
            };
            !id.is_empty()
                && id.len() <= 100
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                && ids.insert(id.to_owned())
                && (!titled
                    || node
                        .get("title")
                        .and_then(|value| value.as_str())
                        .is_some_and(|title| title.chars().count() <= 200))
        };
    if !valid_node(&notebook, true, &mut ids) {
        return false;
    }
    let Some(sections) = notebook.get("sections").and_then(|value| value.as_array()) else {
        return false;
    };
    if sections.is_empty() || sections.len() > 100 {
        return false;
    }
    let mut page_count = 0;
    let mut block_count = 0;
    for section in sections {
        if !valid_node(section, true, &mut ids) {
            return false;
        }
        let Some(pages) = section.get("pages").and_then(|value| value.as_array()) else {
            return false;
        };
        page_count += pages.len();
        if pages.is_empty() || page_count > 2000 {
            return false;
        }
        for page in pages {
            if !valid_node(page, true, &mut ids) {
                return false;
            }
            let Some(blocks) = page.get("blocks").and_then(|value| value.as_array()) else {
                return false;
            };
            block_count += blocks.len();
            if blocks.is_empty() || block_count > 20000 {
                return false;
            }
            for block in blocks {
                if !valid_node(block, false, &mut ids)
                    || !matches!(
                        block.get("type").and_then(|value| value.as_str()),
                        Some("paragraph" | "heading" | "bullet" | "numbered" | "todo" | "image")
                    )
                {
                    return false;
                }
            }
        }
    }
    true
}

/// Screen the container header or notebook envelope before passing local bytes
/// to the active editor. Each editor must still fully validate its document and
/// refuse encrypted or damaged payloads.
fn validate_document_signature(bytes: &[u8], extension: DocExt) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("文档为空，无法打开。".into());
    }
    let valid = match extension {
        // Text tables have no container magic. Accept UTF-8 (including an
        // optional BOM), tabs and line breaks; reject binary/control bytes
        // before passing the content to the spreadsheet parser.
        DocExt::Csv | DocExt::Tsv => std::str::from_utf8(bytes).is_ok_and(|text| {
            !text
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\t' | '\r' | '\n'))
        }),
        DocExt::Pdf => bytes[..bytes.len().min(1024)]
            .windows(5)
            .any(|window| window == b"%PDF-"),
        DocExt::Oonote => valid_notebook(bytes),
        DocExt::Odt
        | DocExt::Doc
        | DocExt::Rtf
        | DocExt::Ods
        | DocExt::Xls
        | DocExt::Odp
        | DocExt::Ppt => false,
        _ => bytes.len() >= 30 && bytes.starts_with(b"PK\x03\x04"),
    };
    if !valid {
        return Err(format!(
            "文件内容与 .{} 格式不符，或文件已损坏。请使用原始文档；加密文件请先在原应用解密。",
            extension.as_str()
        ));
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
        validate_protected_document_ids(&request.protected_document_ids)?;
        request.extension.ensure_exportable()?;
        let bytes = decode_document(&request.base64)?;
        validate_document_signature(&bytes, request.extension)?;
        let existing = request
            .document_id
            .as_deref()
            .map(|id| store.record(id))
            .transpose()?;
        if let Some(record) = existing.as_ref().filter(|_| !request.save_as) {
            return store.save_existing(
                record,
                request.extension,
                request.expected_sha256.as_deref(),
                bytes,
            );
        }
        let target = {
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
        store.ensure_target_not_open(&target, &request.protected_document_ids)?;
        store.save_to_target(target, request.extension, bytes)
    })
    .await
    .map_err(|error| format!("保存文件操作异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Container-header fixtures for file-capability tests, not engine documents.
    // Real parsing/import and exported package checks run in browser tests.
    fn zip_header_fixture(body: &[u8]) -> Vec<u8> {
        let mut bytes = b"PK\x03\x04".to_vec();
        bytes.resize(30, 0);
        bytes.extend_from_slice(body);
        bytes
    }

    fn ole_header_fixture() -> Vec<u8> {
        let mut bytes = vec![0; 512];
        bytes[..8].copy_from_slice(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1");
        for (position, value) in [(26, 3_u16), (28, 0xfffe), (30, 9), (32, 6)] {
            bytes[position..position + 2].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn notebook_fixture() -> serde_json::Value {
        serde_json::json!({
            "format": "open-office-notebook", "version": 1, "id": "notebook-1", "title": "工作笔记",
            "sections": [{ "id": "section-1", "title": "项目", "pages": [{
                "id": "page-1", "title": "会议记录", "blocks": [{
                    "id": "block-1", "type": "paragraph", "content": [{"text": "开始记录"}]
                }]
            }] }]
        })
    }

    #[test]
    fn reopening_and_saving_an_existing_file_keeps_its_identity_and_original_path() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let path = directory.path().join("original.docx");
        fs::write(&path, zip_header_fixture(b"original")).unwrap();
        let store = DocumentStore::new(data.clone()).unwrap();
        let first = store.register_open(path.clone()).unwrap();
        let second = store
            .register_open(directory.path().join(".").join("original.docx"))
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(store.records().unwrap().len(), 1);
        let updated = zip_header_fixture(b"edited in place");
        let result = store
            .save_existing(
                &store.record(&first.id).unwrap(),
                DocExt::Docx,
                Some(&first.sha256),
                updated.clone(),
            )
            .unwrap();
        let SaveResult::Saved { document } = result else {
            panic!("expected original-file save")
        };
        assert_eq!(document.id, first.id);
        assert_eq!(document.name, "original.docx");
        assert_eq!(document.sha256, hash_bytes(&updated));
        assert_eq!(fs::read(&path).unwrap(), updated);
        let files: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.file_type().unwrap().is_file())
            .collect();
        assert_eq!(
            files.len(),
            1,
            "normal save must not create a copy or leave staged files"
        );
        let restored = DocumentStore::new(data).unwrap();
        let reopened = restored
            .register_open(restored.approved_document_path(&first.id).unwrap())
            .unwrap();
        assert_eq!(reopened.id, first.id);
        assert_eq!(reopened.sha256, document.sha256);
        assert_eq!(STANDARD.decode(reopened.base64).unwrap(), updated);
    }

    #[test]
    fn direct_save_refuses_stale_or_missing_revisions_and_format_conversion() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("original.docx");
        let original = zip_header_fixture(b"original");
        fs::write(&path, &original).unwrap();
        let store = DocumentStore::new(directory.path().join("data")).unwrap();
        let opened = store.register_open(path.clone()).unwrap();
        let record = store.record(&opened.id).unwrap();
        let update = zip_header_fixture(b"my edits");
        for expected in [None, Some("invalid"), Some("0".repeat(64).as_str())] {
            assert!(matches!(
                store
                    .save_existing(&record, DocExt::Docx, expected, update.clone())
                    .unwrap(),
                SaveResult::Conflict { .. }
            ));
        }
        assert!(store
            .save_existing(&record, DocExt::Xlsx, Some(&opened.sha256), update.clone())
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let external = zip_header_fixture(b"external edits");
        fs::write(&path, &external).unwrap();
        assert!(matches!(
            store
                .save_existing(&record, DocExt::Docx, Some(&opened.sha256), update.clone())
                .unwrap(),
            SaveResult::Conflict { .. }
        ));
        let reopened = store.register_open(path.clone()).unwrap();
        assert_eq!(reopened.id, opened.id);
        assert!(matches!(
            store
                .save_existing(
                    &store.record(&opened.id).unwrap(),
                    DocExt::Docx,
                    Some(&opened.sha256),
                    update
                )
                .unwrap(),
            SaveResult::Conflict { .. }
        ));
        assert_eq!(fs::read(&path).unwrap(), external);
    }

    #[test]
    fn explicit_same_format_save_as_creates_a_distinct_identity_and_preserves_source() {
        let directory = tempfile::tempdir().unwrap();
        let original_path = directory.path().join("original.docx");
        let saved_path = directory.path().join("chosen-name.docx");
        let original = zip_header_fixture(b"original");
        let edited = zip_header_fixture(b"edited");
        fs::write(&original_path, &original).unwrap();
        let store = DocumentStore::new(directory.path().join("data")).unwrap();
        let opened = store.register_open(original_path.clone()).unwrap();
        let result = store
            .save_to_target(
                TargetSnapshot::capture(saved_path.clone()).unwrap(),
                DocExt::Docx,
                edited.clone(),
            )
            .unwrap();
        let SaveResult::Saved { document } = result else {
            panic!("expected explicit save as")
        };
        assert_ne!(opened.id, document.id);
        assert_eq!(
            store.register_open(saved_path.clone()).unwrap().id,
            document.id
        );
        assert_eq!(
            store.register_open(original_path.clone()).unwrap().id,
            opened.id
        );
        assert_eq!(fs::read(original_path).unwrap(), original);
        assert_eq!(fs::read(saved_path).unwrap(), edited);
    }

    #[test]
    fn save_as_cannot_overwrite_another_open_tab_but_can_reuse_its_own_path() {
        let directory = tempfile::tempdir().unwrap();
        let own_path = directory.path().join("own.docx");
        let other_path = directory.path().join("other.docx");
        let original = zip_header_fixture(b"other tab contents");
        fs::write(&own_path, zip_header_fixture(b"own contents")).unwrap();
        fs::write(&other_path, &original).unwrap();
        let store = DocumentStore::new(directory.path().join("data")).unwrap();
        let own = store.register_open(own_path.clone()).unwrap();
        let other = store.register_open(other_path.clone()).unwrap();
        let protected = vec![other.id.clone()];
        let target =
            TargetSnapshot::capture(directory.path().join(".").join("other.docx")).unwrap();
        let message = store
            .ensure_target_not_open(&target, &protected)
            .unwrap_err();
        assert!(message.contains("其他标签"));
        assert_eq!(fs::read(&other_path).unwrap(), original);
        assert_eq!(store.record(&other.id).unwrap().sha256, other.sha256);
        assert_eq!(store.records().unwrap().len(), 2);
        store
            .ensure_target_not_open(&TargetSnapshot::capture(own_path).unwrap(), &protected)
            .unwrap();
        store
            .ensure_target_not_open(
                &TargetSnapshot::capture(directory.path().join("new.docx")).unwrap(),
                &protected,
            )
            .unwrap();
        store
            .ensure_target_not_open(&TargetSnapshot::capture(other_path).unwrap(), &[])
            .unwrap();
        assert!(validate_protected_document_ids(&vec![own.id; MAX_RECENT + 1]).is_err());
        assert!(validate_protected_document_ids(&["../other.docx".into()]).is_err());
        let request: SaveDocumentRequest = serde_json::from_value(serde_json::json!({
            "name": "own.docx", "extension": "docx", "base64": "aGVsbG8=", "saveAs": false
        }))
        .unwrap();
        assert!(
            request.protected_document_ids.is_empty(),
            "existing native callers remain compatible"
        );
    }

    #[test]
    fn notebook_format_round_trips_through_the_original_file_capability() {
        assert!(EXTENSIONS.contains(&"oonote"));
        assert_eq!(
            DocExt::from_path(Path::new("笔记.OONOTE")).unwrap(),
            DocExt::Oonote
        );
        assert_eq!(serde_json::to_value(DocExt::Oonote).unwrap(), "oonote");
        assert_eq!(serde_json::to_value(DocumentKind::Note).unwrap(), "note");
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("工作笔记.oonote");
        let mut notebook = notebook_fixture();
        fs::write(&path, serde_json::to_vec(&notebook).unwrap()).unwrap();
        let store = DocumentStore::new(directory.path().join("data")).unwrap();
        let opened = store.register_open(path.clone()).unwrap();
        assert_eq!(opened.kind, DocumentKind::Note);
        notebook["sections"][0]["pages"][0]["blocks"][0]["content"][0]["text"] = "已经更新".into();
        let edited = serde_json::to_vec(&notebook).unwrap();
        validate_document_signature(&edited, DocExt::Oonote).unwrap();
        let result = store
            .save_existing(
                &store.record(&opened.id).unwrap(),
                DocExt::Oonote,
                Some(&opened.sha256),
                edited.clone(),
            )
            .unwrap();
        let SaveResult::Saved { document } = result else {
            panic!("expected notebook save")
        };
        assert_eq!(document.id, opened.id);
        assert_eq!(document.kind, DocumentKind::Note);
        assert_eq!(fs::read(&path).unwrap(), edited);
        assert_eq!(store.register_open(path).unwrap().sha256, document.sha256);
    }

    #[test]
    fn notebook_envelope_rejects_unknown_versions_binary_and_invalid_structure() {
        let valid = notebook_fixture();
        let encoded = serde_json::to_vec(&valid).unwrap();
        validate_document_signature(&encoded, DocExt::Oonote).unwrap();
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(&encoded);
        validate_document_signature(&bom, DocExt::Oonote).unwrap();
        for invalid in [
            b"{}".as_slice(),
            b"[]",
            b"null",
            b"\xff\xfe",
            b"PK\x03\x04",
            b"%PDF-1.7",
        ] {
            assert!(validate_document_signature(invalid, DocExt::Oonote).is_err());
        }
        for (pointer, value) in [
            ("/format", serde_json::json!("unknown")),
            ("/version", serde_json::json!(2)),
            ("/id", serde_json::json!("not valid")),
            ("/title", serde_json::json!("字".repeat(201))),
            ("/sections", serde_json::json!([])),
            ("/sections/0/pages", serde_json::json!([])),
            ("/sections/0/pages/0/blocks", serde_json::json!([])),
            (
                "/sections/0/pages/0/blocks/0/id",
                serde_json::json!("notebook-1"),
            ),
            (
                "/sections/0/pages/0/blocks/0/type",
                serde_json::json!("script"),
            ),
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(
                validate_document_signature(&serde_json::to_vec(&invalid).unwrap(), DocExt::Oonote)
                    .is_err(),
                "{pointer}"
            );
        }
        assert!(!valid_notebook(&vec![b' '; NOTEBOOK_LIMIT + 1]));
    }

    #[test]
    fn smoke_document_registration_is_isolated_and_never_overwrites_a_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let store = DocumentStore::new(directory.path().join("store")).unwrap();
        let original = zip_header_fixture(b"native document");
        let encoded = STANDARD.encode(&original);
        let opened = store
            .create_smoke_document(directory.path(), DocExt::Docx, &encoded)
            .unwrap();
        assert_eq!(opened.name, "native-workspace.docx");
        assert_eq!(opened.base64, encoded);
        assert_eq!(opened.sha256, hash_bytes(&original));
        assert_eq!(
            store.approved_document_path(&opened.id).unwrap(),
            directory
                .path()
                .join("native-workspace.docx")
                .canonicalize()
                .unwrap()
        );
        assert!(store
            .create_smoke_document(
                directory.path(),
                DocExt::Docx,
                &STANDARD.encode(zip_header_fixture(b"replacement"))
            )
            .is_err());
        assert_eq!(
            fs::read(directory.path().join("native-workspace.docx")).unwrap(),
            original
        );
        assert!(store
            .create_smoke_document(directory.path(), DocExt::Potx, &encoded)
            .is_err());
        assert!(!directory.path().join("native-workspace.potx").exists());
    }

    #[test]
    fn import_only_formats_retain_kind_and_cannot_be_written_back() {
        for (extension, name, kind) in [
            (DocExt::Potx, "potx", DocumentKind::Presentation),
            (DocExt::Ppsx, "ppsx", DocumentKind::Presentation),
        ] {
            assert!(EXTENSIONS.contains(&name));
            assert_eq!(
                DocExt::from_path(Path::new(&format!("Source.{}", name.to_uppercase()))).unwrap(),
                extension
            );
            assert_eq!(extension.kind(), kind);
            assert_eq!(serde_json::to_value(extension).unwrap(), name);
            assert!(extension.ensure_exportable().is_err());
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(format!("source.{name}"));
            let original = zip_header_fixture(b"original presentation");
            fs::write(&path, &original).unwrap();
            let store = DocumentStore::new(directory.path().join("data")).unwrap();
            let opened = store.register_open(path.clone()).unwrap();
            let target = TargetSnapshot::capture(path.clone()).unwrap();
            assert!(store
                .save_to_target(target, extension, b"wrong overwrite".to_vec())
                .is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(store.record(&opened.id).unwrap().sha256, opened.sha256);
            let export = match kind {
                DocumentKind::Word => DocExt::Docx,
                DocumentKind::Sheet => DocExt::Xlsx,
                _ => DocExt::Pptx,
            };
            let target = directory.path().join(format!("copy.{}", export.as_str()));
            assert!(matches!(
                store
                    .save_to_target(
                        TargetSnapshot::capture(target).unwrap(),
                        export,
                        zip_header_fixture(b"converted copy")
                    )
                    .unwrap(),
                SaveResult::Saved { .. }
            ));
            assert_eq!(
                fs::read(&path).unwrap(),
                original,
                "A converted copy must preserve the original bytes"
            );
        }
    }

    #[test]
    fn retired_formats_are_rejected_without_discarding_supported_history() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let store = DocumentStore::new(data.clone()).unwrap();
        let active = directory.path().join("active.docx");
        fs::write(&active, zip_header_fixture(b"active document")).unwrap();
        let opened = store.register_open(active).unwrap();
        let mut records = store.records().unwrap();
        for (name, extension) in [
            ("odt", DocExt::Odt),
            ("doc", DocExt::Doc),
            ("rtf", DocExt::Rtf),
            ("ods", DocExt::Ods),
            ("xls", DocExt::Xls),
            ("odp", DocExt::Odp),
            ("ppt", DocExt::Ppt),
        ] {
            assert!(!EXTENSIONS.contains(&name));
            assert_eq!(
                serde_json::from_str::<DocExt>(&format!("\"{name}\"")).unwrap(),
                extension
            );
            assert!(DocExt::from_path(Path::new(&format!("old.{name}"))).is_err());
            assert!(extension.ensure_exportable().is_err());
            let old = directory.path().join(format!("old.{name}"));
            fs::write(&old, zip_header_fixture(b"retired format")).unwrap();
            assert!(store.register_open(old.clone()).is_err());
            upsert_record(
                &mut records,
                old,
                extension,
                hash_bytes(&zip_header_fixture(b"retired format")),
            )
            .unwrap();
        }
        assert_eq!(store.records().unwrap().len(), 1);
        store
            .stage_history(&records)
            .unwrap()
            .persist(&store.inner.history_path)
            .unwrap();
        let restored = DocumentStore::new(data).unwrap();
        assert_eq!(
            restored.records().unwrap().len(),
            8,
            "Historical entries stay readable without loading a retired engine"
        );
        assert_eq!(restored.record(&opened.id).unwrap().extension, DocExt::Docx);
    }

    #[test]
    fn text_table_formats_validate_utf8_and_keep_native_file_capabilities() {
        for (extension, name, contents) in [
            (DocExt::Csv, "csv", "\u{feff}名称,数量\r\n苹果,12\r\n"),
            (DocExt::Tsv, "tsv", "名称\t数量\n苹果\t12\n"),
        ] {
            assert!(EXTENSIONS.contains(&name));
            assert_eq!(extension.kind(), DocumentKind::Sheet);
            assert_eq!(serde_json::to_value(extension).unwrap(), name);
            assert_eq!(
                DocExt::from_path(Path::new(&format!("Table.{}", name.to_uppercase()))).unwrap(),
                extension
            );
            assert!(extension.ensure_exportable().is_ok());
            assert!(validate_document_signature(contents.as_bytes(), extension).is_ok());
            for bytes in [
                b"\xff\xfeA".as_slice(),
                b"a\0b",
                b"a\x1bb",
                b"a\x7fb",
                b"a\xc2\x85b",
            ] {
                assert!(validate_document_signature(bytes, extension).is_err());
            }
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(format!("source.{name}"));
            fs::write(&path, contents).unwrap();
            let store = DocumentStore::new(directory.path().join("data")).unwrap();
            let opened = store.register_open(path.clone()).unwrap();
            assert_eq!(opened.extension, extension);
            assert_eq!(opened.kind, DocumentKind::Sheet);
            assert_eq!(STANDARD.decode(opened.base64).unwrap(), contents.as_bytes());
            // A separate export preserves the original import and receives its
            // own file capability, just as the shell's copy-only export does.
            let target = directory.path().join(format!("copy.{name}"));
            store
                .save_to_target(
                    TargetSnapshot::capture(target.clone()).unwrap(),
                    extension,
                    contents.as_bytes().to_vec(),
                )
                .unwrap();
            assert_eq!(fs::read(&path).unwrap(), contents.as_bytes());
            assert_eq!(fs::read(target).unwrap(), contents.as_bytes());
        }
    }

    #[test]
    fn document_headers_reject_empty_mislabeled_and_broken_containers() {
        let ole = ole_header_fixture();
        for extension in [
            DocExt::Docx,
            DocExt::Xlsx,
            DocExt::Pptx,
            DocExt::Potx,
            DocExt::Ppsx,
        ] {
            assert!(
                validate_document_signature(&zip_header_fixture(b"package"), extension).is_ok()
            );
            assert!(
                validate_document_signature(&ole, extension).is_err(),
                "Encrypted OOXML uses an OLE container and must be refused"
            );
            assert!(validate_document_signature(b"PK\x03\x04", extension).is_err());
            assert!(
                validate_document_signature(b"<html>renamed document</html>", extension).is_err()
            );
        }
        assert!(validate_document_signature(b"{\\rtf1\\ansi text}", DocExt::Rtf).is_err());
        assert!(validate_document_signature(b"{\\rtf0 text}", DocExt::Rtf).is_err());
        assert!(validate_document_signature(b"{\\rtf1invalid}", DocExt::Rtf).is_err());
        assert!(validate_document_signature(b"\n%PDF-1.7", DocExt::Pdf).is_ok());
        assert!(validate_document_signature(b"not PDF", DocExt::Pdf).is_err());
        for name in EXTENSIONS {
            let extension = DocExt::from_path(Path::new(&format!("file.{name}"))).unwrap();
            assert!(validate_document_signature(&[], extension).is_err());
        }
        let directory = tempfile::tempdir().unwrap();
        let store = DocumentStore::new(directory.path().join("data")).unwrap();
        let bad = directory.path().join("renamed.docx");
        fs::write(&bad, b"malformed document").unwrap();
        assert!(store.register_open(bad).is_err());
        assert!(
            store.records().unwrap().is_empty(),
            "Rejected bytes must not grant a recent-file capability"
        );
    }

    #[test]
    fn presentation_formats_serialize_without_enabling_mismatched_files() {
        for (extension, name) in [
            (DocExt::Pptx, "pptx"),
            (DocExt::Potx, "potx"),
            (DocExt::Ppsx, "ppsx"),
        ] {
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
        assert_eq!(
            serde_json::from_value::<DocExt>(serde_json::json!("ppt")).unwrap(),
            DocExt::Ppt
        );
        assert!(!EXTENSIONS.contains(&"ppt"));
    }

    #[test]
    fn presentation_save_and_history_reopen_preserve_bytes_identity_and_kind() {
        // This tests the native opaque-byte file bridge; Rust slide parsing and
        // actual slide edits are exercised by the separate engine round trips.
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("app-data");
        let store = DocumentStore::new(data.clone()).unwrap();
        let existing = directory.path().join("已有文档.docx");
        fs::write(&existing, zip_header_fixture(b"existing word document")).unwrap();
        let word = store.register_open(existing).unwrap();
        for extension in [DocExt::Pptx] {
            let path = directory
                .path()
                .join(format!("汇报.{}", extension.as_str()));
            fs::write(&path, zip_header_fixture(b"original slide fixture")).unwrap();
            let opened = store.register_open(path.clone()).unwrap();
            assert_eq!(opened.kind, DocumentKind::Presentation);
            assert_eq!(opened.extension, extension);
            assert_eq!(
                STANDARD.decode(&opened.base64).unwrap(),
                zip_header_fixture(b"original slide fixture")
            );
            let snapshot = TargetSnapshot::capture(path.clone()).unwrap();
            let SaveResult::Saved { document } = store
                .save_to_target(
                    snapshot,
                    extension,
                    zip_header_fixture(b"edited slide fixture"),
                )
                .unwrap()
            else {
                panic!("Expected saved presentation")
            };
            assert_eq!(document.id, opened.id);
            assert_eq!(document.kind, DocumentKind::Presentation);
            assert_eq!(
                document.sha256,
                hash_bytes(&zip_header_fixture(b"edited slide fixture"))
            );
            assert_eq!(
                fs::read(&path).unwrap(),
                zip_header_fixture(b"edited slide fixture")
            );
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
                zip_header_fixture(b"edited slide fixture")
            );
            assert_eq!(restored.record(&word.id).unwrap().extension, DocExt::Docx);
        }
    }

    #[test]
    fn presentation_conflict_preserves_external_edits_and_original_history() {
        for extension in [DocExt::Pptx] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory
                .path()
                .join(format!("slides.{}", extension.as_str()));
            fs::write(&path, zip_header_fixture(b"original slides")).unwrap();
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
        for valid in ["报告.docx", "财务 2026.xlsx", "笔记.DOCX", "文档.pdf"] {
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
        let path = directory.path().join("new.xlsx");
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
        fs::write(&path, zip_header_fixture(b"original")).unwrap();
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
        fs::write(&path, zip_header_fixture(b"original")).unwrap();
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
        fs::write(&path, b"%PDF-1.7 original").unwrap();
        let store = DocumentStore::new(data.clone()).unwrap();
        let opened = store.register_open(path.clone()).unwrap();
        fs::remove_dir_all(&data).unwrap();
        fs::write(&data, b"not a directory").unwrap();
        let target = TargetSnapshot::capture(path.clone()).unwrap();
        assert!(store
            .save_to_target(target, DocExt::Pdf, b"edits".to_vec())
            .is_err());
        assert_eq!(fs::read(path).unwrap(), b"%PDF-1.7 original");
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
        fs::write(&path, zip_header_fixture(b"original")).unwrap();
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
