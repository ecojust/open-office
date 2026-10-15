//! CPU-only independent Word package operations. No filesystem paths are accepted.
use word_package::Part;
use std::sync::{Arc, Mutex};

pub struct WordRuntime(Arc<Mutex<word_engine::Engine>>);

impl Default for WordRuntime {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(word_engine::Engine::new())))
    }
}

/// The same engine and request protocol used by the browser WASM worker.
#[tauri::command]
pub async fn word_engine_request(
    request: word_engine::Request,
    runtime: tauri::State<'_, WordRuntime>,
) -> Result<word_engine::Response, String> {
    let engine = runtime.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut engine = engine.lock().map_err(|_| "文字引擎会话异常。".to_string())?;
        Ok(engine.request(request))
    }).await.map_err(|_| "文字引擎任务异常。".to_string())?
}

#[tauri::command]
pub async fn word_read_package(base64: String) -> Result<Vec<Part>, String> {
    tauri::async_runtime::spawn_blocking(move || word_package::read_package_base64(&base64))
        .await
        .map_err(|_| "DOCX 包读取任务异常。".to_string())?
}

#[tauri::command]
pub async fn word_write_package(parts: Vec<Part>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || word_package::write_package_base64(parts))
        .await
        .map_err(|_| "DOCX 包写入任务异常。".to_string())?
}
