//! Recovery-model migrations. Only known internal metadata keys are renamed; opaque parts stay intact.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{collections::BTreeMap, sync::Arc};

type Parts = BTreeMap<String, Arc<Vec<u8>>>;

const PASSTHROUGH_KEYS: [(&str, &str); 6] = [
    ("wordcraft:vbaProject.related", "office-word:vbaProject.related"),
    ("wordcraft:embedded.parts", "office-word:embedded.parts"),
    ("wordcraft:customXml.roots", "office-word:customXml.roots"),
    ("wordcraft:settings.orig", "office-word:settings.orig"),
    ("wordcraft:app.kept", "office-word:app.kept"),
    ("wordcraft:unmodelled.roots", "office-word:unmodelled.roots"),
];

fn migrate(mut parts: Parts) -> Parts {
    for (old, current) in PASSTHROUGH_KEYS {
        if let Some(value) = parts.remove(old) {
            // A current value is authoritative when an older recovery snapshot kept both.
            parts.entry(current.into()).or_insert(value);
        }
    }
    parts
}

pub(crate) fn deserialize_passthrough<'de, D: Deserializer<'de>>(de: D) -> Result<Parts, D::Error> {
    Parts::deserialize(de).map(migrate)
}

pub(crate) fn serialize_passthrough<S: Serializer>(parts: &Parts, serializer: S) -> Result<S::Ok, S::Error> {
    migrate(parts.clone()).serialize(serializer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Document;

    #[test]
    fn recovery_metadata_migrates_without_losing_parts_or_overwriting_current_values() {
        let mut old = serde_json::json!({"passthrough": {"customXml/item1.xml": [99], "opaque:extension": [100]}});
        for (index, (legacy, _)) in PASSTHROUGH_KEYS.iter().enumerate() {
            old["passthrough"][*legacy] = serde_json::json!([index as u8, 0, 255]);
        }
        old["passthrough"][PASSTHROUGH_KEYS[0].1] = serde_json::json!([42]);
        let doc: Document = serde_json::from_value(old).unwrap();
        assert_eq!(doc.passthrough.len(), 8);
        for (index, (legacy, current)) in PASSTHROUGH_KEYS.iter().enumerate() {
            assert!(!doc.passthrough.contains_key(*legacy));
            assert_eq!(doc.passthrough[*current].as_ref(), &if index == 0 { vec![42] } else { vec![index as u8, 0, 255] });
        }
        assert_eq!(doc.passthrough["customXml/item1.xml"].as_ref(), &[99]);
        assert_eq!(doc.passthrough["opaque:extension"].as_ref(), &[100]);
        let encoded = serde_json::to_value(&doc).unwrap();
        assert_eq!(serde_json::from_value::<Document>(encoded).unwrap(), doc);
    }

    #[test]
    fn serializing_an_older_in_memory_model_writes_only_current_metadata_keys() {
        let mut doc = Document::new();
        for (legacy, _) in PASSTHROUGH_KEYS {
            doc.passthrough.insert(legacy.into(), Arc::new(vec![7, 8, 9]));
        }
        let encoded = serde_json::to_value(&doc).unwrap();
        for (legacy, current) in PASSTHROUGH_KEYS {
            assert!(encoded["passthrough"].get(legacy).is_none());
            assert_eq!(encoded["passthrough"][current], serde_json::json!([7, 8, 9]));
        }
    }
}
