//! Historical native-file identifiers accepted on import. Writers use the current identifiers.

pub const LEGACY_MIMETYPES: [&str; 2] = ["application/vnd.storyteller.deckcraft+zip", "application/vnd.storyteller.slidecraft+zip"];

/// Current extension first: it wins when recovery holds both an old and an upgraded snapshot.
pub const NATIVE_EXTENSIONS: [&str; 3] = [crate::EXTENSION, "deckcraft", "slidecraft"];

pub fn is_native_extension(extension: &str) -> bool {
    NATIVE_EXTENSIONS.iter().any(|candidate| extension.eq_ignore_ascii_case(candidate))
}

pub(crate) fn native_manifest(format: &str) -> bool {
    is_native_extension(format)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MIMETYPE, Manifest, Presentation, VERSION, load, read_entry, save, sniff};
    use std::io::{Cursor, Write};

    #[test]
    fn historical_packages_load_with_media_then_save_with_current_identifiers() {
        for (format, mime) in NATIVE_EXTENSIONS[1..].iter().zip(LEGACY_MIMETYPES) {
            let mut presentation = Presentation::default();
            let media = presentation.add_media("image.png", "image/png", vec![1, 2, 3, 4]).unwrap();
            let manifest = Manifest { format: (*format).into(), version: VERSION, generator: "legacy".into(), presentation };
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zip.start_file("mimetype", stored).unwrap();
            zip.write_all(mime.as_bytes()).unwrap();
            zip.start_file("presentation.json", stored).unwrap();
            zip.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
            zip.start_file(format!("media/{}", media.0), stored).unwrap();
            zip.write_all(&[1, 2, 3, 4]).unwrap();
            let legacy = zip.finish().unwrap().into_inner();
            assert!(sniff(&legacy));
            let restored = load(&legacy).unwrap();
            assert_eq!(restored.media(media).unwrap().data.as_ref(), &[1, 2, 3, 4]);
            let upgraded = save(&restored).unwrap();
            assert!(sniff(&upgraded));
            let mut zip = zip::ZipArchive::new(Cursor::new(upgraded.as_slice())).unwrap();
            assert_eq!(read_entry(&mut zip, "mimetype").unwrap(), MIMETYPE.as_bytes());
            let manifest: serde_json::Value = serde_json::from_slice(&read_entry(&mut zip, "presentation.json").unwrap()).unwrap();
            assert_eq!(manifest["format"], crate::EXTENSION);
            assert!(manifest["generator"].as_str().unwrap().starts_with("Open Office "));
            assert_eq!(load(&upgraded).unwrap(), restored);
        }
    }

    #[test]
    fn native_extension_detection_accepts_old_names_case_insensitively() {
        for extension in NATIVE_EXTENSIONS {
            assert!(is_native_extension(&extension.to_ascii_uppercase()));
        }
        assert!(!is_native_extension("zip"));
        assert!(!is_native_extension("pptx"));
    }
}
