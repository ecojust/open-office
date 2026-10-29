//! Bounded storage for public holiday announcements. Renderers supply cache
//! entries only; the application chooses one fixed file in its data directory.
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const KEY_PREFIX: &str = "open-office.schedule.holidays.v1.";
const MAX_ENTRIES: usize = 12;
const ENTRY_LIMIT: usize = 256 * 1024;
const FILE_LIMIT: usize = 3 * 1024 * 1024;
const CLOCK_TOLERANCE_MS: f64 = 5.0 * 60.0 * 1000.0;
type HolidayEntries = BTreeMap<String, String>;

pub struct ScheduleHolidayCache {
    path: PathBuf,
    access: Mutex<()>,
}

impl ScheduleHolidayCache {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            access: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<HolidayEntries, String> {
        let _access = self.access.lock().map_err(|_| "节假日缓存暂不可用。")?;
        read_entries(&self.path)
    }

    fn save(&self, entries: HolidayEntries) -> Result<(), String> {
        validate_entries(&entries)?;
        let bytes = serde_json::to_vec(&entries).map_err(|_| "无法编码节假日缓存。")?;
        if bytes.len() > FILE_LIMIT {
            return Err("节假日缓存超过 3 MiB 大小限制。".into());
        }
        let _access = self.access.lock().map_err(|_| "节假日缓存暂不可用。")?;
        // A failed initial read must not turn a later refresh into an overwrite
        // of malformed or unreadable data. Check again under the write lock.
        read_entries(&self.path)?;
        let parent = self.path.parent().ok_or("无法定位节假日缓存目录。")?;
        fs::create_dir_all(parent).map_err(|_| "无法创建节假日缓存目录。")?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建节假日缓存文件。")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| "无法设置节假日缓存权限。")?;
        }
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "无法写入节假日缓存。")?;
        temporary
            .persist(&self.path)
            .map_err(|_| "无法替换节假日缓存。")?;
        Ok(())
    }
}

fn validate_entries(entries: &HolidayEntries) -> Result<(), String> {
    if entries.len() > MAX_ENTRIES {
        return Err("节假日缓存最多保留 12 个年度。".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间无效，无法验证节假日缓存。")?
        .as_secs_f64()
        * 1000.0;
    for (key, raw) in entries {
        let year = key
            .strip_prefix(KEY_PREFIX)
            .filter(|year| year.len() == 4 && year.bytes().all(|digit| digit.is_ascii_digit()))
            .and_then(|year| year.parse::<u64>().ok())
            .filter(|year| (1900..=9999).contains(year))
            .ok_or("节假日缓存键无效。")?;
        if raw.len() > ENTRY_LIMIT {
            return Err("节假日年度缓存超过 256 KiB 大小限制。".into());
        }
        let entry: serde_json::Value =
            serde_json::from_str(raw).map_err(|_| "节假日年度缓存不是有效 JSON。")?;
        if entry.get("version").and_then(|value| value.as_u64()) != Some(1)
            || entry.get("year").and_then(|value| value.as_u64()) != Some(year)
            || !entry
                .get("fetchedAt")
                .and_then(|value| value.as_f64())
                .is_some_and(|value| {
                    value.is_finite() && value >= 0.0 && value <= now + CLOCK_TOLERANCE_MS
                })
            || !entry.get("days").is_some_and(|value| value.is_object())
        {
            return Err("节假日年度缓存的版本、年份、时间或日期结构无效。".into());
        }
    }
    Ok(())
}

fn read_entries(path: &Path) -> Result<HolidayEntries, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BTreeMap::new());
        }
        Err(_) => return Err("无法读取节假日缓存，原文件已保留。".into()),
    };
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取节假日缓存，原文件已保留。")?;
    if bytes.len() > FILE_LIMIT {
        return Err("节假日缓存超过 3 MiB 大小限制，原文件已保留。".into());
    }
    let entries =
        serde_json::from_slice(&bytes).map_err(|_| "节假日缓存文件结构无效，原文件已保留。")?;
    validate_entries(&entries)?;
    Ok(entries)
}

fn require_main(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法确认桌面工作区来源。")?;
    if window.label() != "main"
        || !crate::server::AssetServer::allows_navigation(
            &app.state::<crate::server::AssetServer>().info,
            &url,
        )
    {
        return Err("节假日缓存仅可在桌面客户端主窗口中操作。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn load_schedule_holidays(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<HolidayEntries, String> {
    require_main(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<ScheduleHolidayCache>().load())
        .await
        .map_err(|_| "读取节假日缓存任务异常。")?
}

#[tauri::command]
pub async fn save_schedule_holidays(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    entries: HolidayEntries,
) -> Result<(), String> {
    require_main(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<ScheduleHolidayCache>().save(entries))
        .await
        .map_err(|_| "保存节假日缓存任务异常。")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(year: u64) -> String {
        serde_json::json!({
            "version": 1,
            "year": year,
            "fetchedAt": 1000.5,
            "days": { format!("{year}-01-01"): "元旦", format!("{year}-01-02"): null }
        })
        .to_string()
    }

    fn entries(year: u64) -> HolidayEntries {
        [(format!("{KEY_PREFIX}{year}"), entry(year))].into()
    }

    #[test]
    fn schedule_cache_survives_recreation_and_replaces_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("app-data/schedule-holidays.json");
        let store = ScheduleHolidayCache::new(path.clone());
        assert!(store.load().unwrap().is_empty());
        assert!(!path.exists());
        let original = entries(2026);
        store.save(original.clone()).unwrap();
        drop(store);
        let reopened = ScheduleHolidayCache::new(path.clone());
        assert_eq!(reopened.load().unwrap(), original);
        let next: HolidayEntries = (2026..2038)
            .map(|year| (format!("{KEY_PREFIX}{year}"), entry(year)))
            .collect();
        reopened.save(next.clone()).unwrap();
        assert_eq!(
            ScheduleHolidayCache::new(path.clone()).load().unwrap(),
            next
        );
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        reopened.save(BTreeMap::new()).unwrap();
        assert!(reopened.load().unwrap().is_empty());
        for year in [1900, 9999] {
            reopened.save(entries(year)).unwrap();
            assert_eq!(reopened.load().unwrap(), entries(year));
        }
    }

    #[test]
    fn schedule_cache_rejects_keys_and_malicious_records_without_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schedule-holidays.json");
        let store = ScheduleHolidayCache::new(path.clone());
        store.save(entries(2026)).unwrap();
        let original = fs::read(&path).unwrap();
        for key in [
            "../private.json".to_string(),
            "__proto__".to_string(),
            format!("{KEY_PREFIX}1899"),
            format!("{KEY_PREFIX}10000"),
            format!("{KEY_PREFIX}+2026"),
            format!("{KEY_PREFIX}02026"),
            format!("{KEY_PREFIX}２０２６"),
            format!("{KEY_PREFIX}2026.json"),
            format!("{KEY_PREFIX}2026/../2025"),
        ] {
            assert!(store.save([(key, entry(2026))].into()).is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        for (field, invalid) in [
            ("version", serde_json::json!(2)),
            ("version", serde_json::json!("1")),
            ("year", serde_json::json!(2025)),
            ("fetchedAt", serde_json::json!(-1)),
            ("fetchedAt", serde_json::json!(1e30)),
            ("fetchedAt", serde_json::json!("1000")),
            ("days", serde_json::json!([])),
            ("days", serde_json::Value::Null),
        ] {
            let mut record: serde_json::Value = serde_json::from_str(&entry(2026)).unwrap();
            record[field] = invalid;
            assert!(store
                .save([(format!("{KEY_PREFIX}2026"), record.to_string())].into())
                .is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        for invalid in ["", "{", "null", "[]", "{\"fetchedAt\":NaN}"] {
            assert!(store
                .save([(format!("{KEY_PREFIX}2026"), invalid.to_string())].into())
                .is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn schedule_cache_enforces_entry_count_utf8_and_serialized_file_limits() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schedule-holidays.json");
        let store = ScheduleHolidayCache::new(path.clone());
        store.save(entries(2026)).unwrap();
        let original = fs::read(&path).unwrap();
        let many: HolidayEntries = (2026..2039)
            .map(|year| (format!("{KEY_PREFIX}{year}"), entry(year)))
            .collect();
        assert!(store.save(many).is_err());
        let mut record: serde_json::Value = serde_json::from_str(&entry(2026)).unwrap();
        record["padding"] = serde_json::json!("年".repeat(ENTRY_LIMIT / 2));
        let raw = record.to_string();
        assert!(raw.chars().count() < ENTRY_LIMIT);
        assert!(raw.len() > ENTRY_LIMIT);
        assert!(store
            .save([(format!("{KEY_PREFIX}2026"), raw)].into())
            .is_err());
        let full: HolidayEntries = (2026..2038)
            .map(|year| {
                let mut raw = entry(year);
                raw.extend(std::iter::repeat_n(' ', ENTRY_LIMIT - raw.len()));
                (format!("{KEY_PREFIX}{year}"), raw)
            })
            .collect();
        assert!(validate_entries(&full).is_ok());
        assert!(serde_json::to_vec(&full).unwrap().len() > FILE_LIMIT);
        assert!(store.save(full).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn schedule_cache_read_failures_preserve_existing_data_on_later_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schedule-holidays.json");
        let store = ScheduleHolidayCache::new(path.clone());
        let malicious: HolidayEntries = [("../other.json".to_string(), entry(2026))].into();
        for invalid in [
            Vec::new(),
            b"{".to_vec(),
            b"[]".to_vec(),
            b"{\"open-office.schedule.holidays.v1.2026\":null}".to_vec(),
            serde_json::to_vec(&malicious).unwrap(),
            vec![b' '; FILE_LIMIT + 1],
            vec![0xc3, 0x28],
        ] {
            fs::write(&path, &invalid).unwrap();
            assert!(store.load().is_err());
            assert!(store.save(entries(2026)).is_err());
            assert_eq!(fs::read(&path).unwrap(), invalid);
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.load().is_err());
        assert!(store.save(entries(2026)).is_err());
        assert!(path.is_dir());
    }
}
