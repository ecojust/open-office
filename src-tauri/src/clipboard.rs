//! Image files explicitly copied to the system clipboard. No renderer-supplied
//! path is accepted, and pasted files never become document read capabilities.

use crate::files::NativeImage;

#[cfg(any(target_os = "macos", test))]
use {
    base64::{engine::general_purpose::STANDARD, Engine},
    std::{
        collections::HashSet,
        fs::{self, File},
        io::Read,
        path::{Path, PathBuf},
    },
};

#[cfg(any(target_os = "macos", test))]
const IMAGE_LIMIT: u64 = 4 * 1024 * 1024;
#[cfg(any(target_os = "macos", test))]
const TOTAL_LIMIT: u64 = 16 * 1024 * 1024;
#[cfg(any(target_os = "macos", test))]
const IMAGE_COUNT_LIMIT: usize = 16;

#[cfg(any(target_os = "macos", test))]
fn clipboard_path(value: &str) -> Option<PathBuf> {
    let url = tauri::Url::parse(value).ok()?;
    if url.scheme() != "file"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_some_and(|host| host != "localhost")
    {
        return None;
    }
    let path = url.to_file_path().ok()?;
    (path.is_absolute() && !path.as_os_str().to_string_lossy().contains('\0')).then_some(path)
}

#[cfg(any(target_os = "macos", test))]
fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg")
    )
}

#[cfg(target_os = "macos")]
fn system_clipboard_paths() -> Result<Vec<PathBuf>, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};

    // Called on the main thread. Snapshot file URLs once; do not inspect text
    // representations (a copied path or URL is still text, not a copied file).
    let pasteboard = NSPasteboard::generalPasteboard();
    let Some(items) = pasteboard.pasteboardItems() else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for index in 0..items.count() {
        let item = items.objectAtIndex(index);
        // SAFETY: This is AppKit's immutable, process-lifetime file URL type.
        let Some(value) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else {
            continue;
        };
        let Some(path) = clipboard_path(&value.to_string()) else {
            continue;
        };
        if is_image_path(&path) && seen.insert(path.clone()) {
            paths.push(path);
            if paths.len() > IMAGE_COUNT_LIMIT {
                return Err("一次最多粘贴 16 张图片。".into());
            }
        }
    }
    Ok(paths)
}

#[cfg(any(target_os = "macos", test))]
fn read_images(paths: Vec<PathBuf>) -> Result<Vec<NativeImage>, String> {
    let mut images = Vec::new();
    let mut seen = HashSet::new();
    let mut total = 0;
    for path in paths {
        if !is_image_path(&path) || !seen.insert(path.clone()) {
            continue;
        }
        if images.len() == IMAGE_COUNT_LIMIT {
            return Err("一次最多粘贴 16 张图片。".into());
        }
        if !path.is_absolute() {
            return Err("剪贴板中的图片路径无效。".into());
        }
        let metadata = fs::symlink_metadata(&path).map_err(|_| "无法读取剪贴板中的图片文件。")?;
        if !metadata.is_file() {
            return Err("剪贴板中的图片必须是普通文件。".into());
        }
        if metadata.len() > IMAGE_LIMIT {
            return Err("每张粘贴图片不能超过 4 MB。".into());
        }
        if total + metadata.len() > TOTAL_LIMIT {
            return Err("一次粘贴的图片总大小不能超过 16 MB。".into());
        }
        let file = File::open(&path).map_err(|_| "无法读取剪贴板中的图片文件。")?;
        if !file
            .metadata()
            .map_err(|_| "无法读取剪贴板中的图片文件。")?
            .is_file()
        {
            return Err("剪贴板中的图片必须是普通文件。".into());
        }
        // The file may change after its metadata was read. Bound the actual
        // read too, and check the real bytes before returning any image.
        let mut bytes = Vec::new();
        file.take(IMAGE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取剪贴板中的图片文件。")?;
        if bytes.len() as u64 > IMAGE_LIMIT {
            return Err("每张粘贴图片不能超过 4 MB。".into());
        }
        total += bytes.len() as u64;
        if total > TOTAL_LIMIT {
            return Err("一次粘贴的图片总大小不能超过 16 MB。".into());
        }
        let mime_type = crate::files::image_mime_type(&path, &bytes)?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("剪贴板中的图片名称无效。")?;
        images.push(NativeImage {
            name: name.into(),
            base64: STANDARD.encode(&bytes),
            mime_type: mime_type.into(),
        });
    }
    Ok(images)
}

#[tauri::command]
pub async fn clipboard_images(app: tauri::AppHandle) -> Result<Vec<NativeImage>, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.send(system_clipboard_paths());
        })
        .map_err(|_| "无法读取系统剪贴板。")?;
        tauri::async_runtime::spawn_blocking(move || {
            let paths = receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "读取系统剪贴板超时，请重试。")??;
            read_images(paths)
        })
        .await
        .map_err(|_| "读取剪贴板图片失败。".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Other desktop webviews expose copied files through ClipboardEvent.
        let _ = app;
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn image(directory: &Path, name: &str, size: u64) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, PNG).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(size)
            .unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn only_local_file_urls_are_resolved_without_double_decoding() {
        let path = clipboard_path("file:///tmp/%E5%9B%BE%E7%89%87%20%2520.png").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/图片 %20.png"));
        assert_eq!(
            clipboard_path("file://localhost/tmp/image.png"),
            Some(PathBuf::from("/tmp/image.png"))
        );
        for value in [
            "https://example.com/image.png",
            "/tmp/image.png",
            "file://example.com/image.png",
            "file:///tmp/image.png?download=1",
            "file:///tmp/image.png#section",
            "file:///tmp/image%00.png",
        ] {
            assert!(clipboard_path(value).is_none(), "{value}");
        }
    }

    #[test]
    fn pasted_images_keep_name_mime_and_bytes_and_ignore_unrelated_files() {
        let temporary = tempfile::tempdir().unwrap();
        let png = image(temporary.path(), "图片.PNG", PNG.len() as u64);
        let jpeg = temporary.path().join("photo.JpEg");
        fs::write(&jpeg, [0xff, 0xd8, 0xff, 0x00]).unwrap();
        let images = read_images(vec![
            png.clone(),
            temporary.path().join("unrelated.txt"),
            jpeg,
            png,
        ])
        .unwrap();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].name, "图片.PNG");
        assert_eq!(images[0].mime_type, "image/png");
        assert_eq!(STANDARD.decode(&images[0].base64).unwrap(), PNG);
        assert_eq!(images[1].mime_type, "image/jpeg");
        assert!(read_images(Vec::new()).unwrap().is_empty());
    }

    #[test]
    fn rejects_wrong_magic_relative_paths_directories_and_symlinks() {
        let temporary = tempfile::tempdir().unwrap();
        let fake = temporary.path().join("fake.png");
        fs::write(&fake, b"not an image").unwrap();
        assert!(read_images(vec![fake]).unwrap_err().contains("文件类型"));
        assert!(read_images(vec![PathBuf::from("relative.png")])
            .unwrap_err()
            .contains("路径"));
        let directory = temporary.path().join("directory.png");
        fs::create_dir(&directory).unwrap();
        assert!(read_images(vec![directory])
            .unwrap_err()
            .contains("普通文件"));
        #[cfg(unix)]
        {
            let target = image(temporary.path(), "target.png", PNG.len() as u64);
            let link = temporary.path().join("link.png");
            std::os::unix::fs::symlink(target, &link).unwrap();
            assert!(read_images(vec![link]).unwrap_err().contains("普通文件"));
        }
    }

    #[test]
    fn enforces_individual_total_and_count_limits() {
        let temporary = tempfile::tempdir().unwrap();
        let oversized = image(temporary.path(), "large.png", IMAGE_LIMIT + 1);
        assert!(read_images(vec![oversized]).unwrap_err().contains("4 MB"));
        let four = (0..4)
            .map(|index| image(temporary.path(), &format!("{index}.png"), IMAGE_LIMIT))
            .collect::<Vec<_>>();
        assert_eq!(read_images(four.clone()).unwrap().len(), 4);
        let mut too_large = four;
        too_large.push(image(temporary.path(), "extra.png", PNG.len() as u64));
        assert!(read_images(too_large).unwrap_err().contains("16 MB"));
        let sixteen = (0..16)
            .map(|index| {
                image(
                    temporary.path(),
                    &format!("small-{index}.png"),
                    PNG.len() as u64,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(read_images(sixteen.clone()).unwrap().len(), 16);
        let mut too_many = sixteen;
        too_many.push(image(temporary.path(), "seventeenth.png", PNG.len() as u64));
        assert!(read_images(too_many).unwrap_err().contains("16 张"));
    }
}
