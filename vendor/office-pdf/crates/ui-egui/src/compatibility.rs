//! Preferences written by earlier standalone builds remain readable after an upgrade.

pub const SETTINGS_KEY: &str = "office-pdf";
pub const PREVIOUS_SETTINGS_KEYS: [&str; 2] = ["pdfcraft", "printcraft"];
/// Exact per-user directory names used before the neutral storage name.
pub const PREVIOUS_STORAGE_FOLDERS: [&str; 2] = ["PdfCraft", "PrintCraft"];

pub fn read_settings(storage: &dyn eframe::Storage) -> Option<String> {
    std::iter::once(SETTINGS_KEY).chain(PREVIOUS_SETTINGS_KEYS).find_map(|key| storage.get_string(key))
}

pub(crate) fn write_settings(storage: &mut dyn eframe::Storage, value: String) {
    storage.set_string(SETTINGS_KEY, value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct MemoryStorage(BTreeMap<String, String>);

    impl eframe::Storage for MemoryStorage {
        fn get_string(&self, key: &str) -> Option<String> {
            self.0.get(key).cloned()
        }
        fn set_string(&mut self, key: &str, value: String) {
            self.0.insert(key.into(), value);
        }
        fn remove_string(&mut self, key: &str) {
            self.0.remove(key);
        }
        fn flush(&mut self) {}
    }

    #[test]
    fn previous_preferences_restore_and_the_next_save_uses_the_current_key() {
        use eframe::App;
        for legacy in PREVIOUS_SETTINGS_KEYS {
            let mut storage = MemoryStorage::default();
            storage.0.insert(legacy.into(), r#"{"theme":"dark","language":"zh-hans"}"#.into());
            let mut app = crate::OfficePdfApp::new();
            app.restore(&read_settings(&storage).unwrap());
            assert_eq!(app.language, "zh-hans");
            let legacy_value = storage.0.get(legacy).cloned();
            app.save(&mut storage);
            let saved: serde_json::Value = serde_json::from_str(&storage.0[SETTINGS_KEY]).unwrap();
            assert_eq!(saved["language"], "zh-hans");
            assert_eq!(storage.0.get(legacy).cloned(), legacy_value);
            assert_eq!(read_settings(&storage), storage.0.get(SETTINGS_KEY).cloned());
        }
    }

    #[test]
    fn current_preferences_take_precedence_over_all_older_keys() {
        let mut storage = MemoryStorage::default();
        for legacy in PREVIOUS_SETTINGS_KEYS {
            storage.0.insert(legacy.into(), "old".into());
        }
        write_settings(&mut storage, "current".into());
        assert_eq!(read_settings(&storage).as_deref(), Some("current"));
    }
}
