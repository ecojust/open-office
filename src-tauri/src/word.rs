//! CPU-only independent Word package operations. No filesystem paths are accepted.
use word_package::Part;

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
