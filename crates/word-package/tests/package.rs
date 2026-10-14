use base64::{engine::general_purpose::STANDARD, Engine};
use word_package::{
    encoded_limit, read_package, read_package_base64, write_package, write_package_base64, Part,
    RawPart, ENTRY_LIMIT, EXPANDED_LIMIT, INPUT_LIMIT, PART_LIMIT,
};

fn part(name: &str, data: &[u8]) -> RawPart {
    RawPart {
        name: name.into(),
        data: data.to_vec(),
    }
}
fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn set16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
fn set32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn central(bytes: &[u8]) -> usize {
    u32_at(bytes, bytes.len() - 6) as usize
}
fn fixture() -> Vec<u8> {
    write_package(&[part("word/document.xml", b"<p>hello</p>")]).unwrap()
}
fn deflated() -> Vec<u8> {
    write_package(&[part("word/document.xml", &vec![b'a'; 16384])]).unwrap()
}
fn rejected(bytes: &[u8]) {
    assert!(read_package(bytes).is_err(), "mutated archive was accepted");
}

#[test]
fn deterministic_round_trip_supports_utf8_empty_stored_and_deflated_parts() {
    let parts = vec![
        part("word/", b""),
        part("word/正文.xml", "中文 😀\t\n".as_bytes()),
        part("empty", b""),
        part("binary", &[0, 1, 255]),
        part("long", &vec![b'x'; 20000]),
    ];
    let bytes = write_package(&parts).unwrap();
    assert_eq!(bytes, write_package(&parts).unwrap());
    assert_eq!(read_package(&bytes).unwrap(), parts);
    assert!(bytes.len() < 1024);
    let transported = read_package_base64(&STANDARD.encode(bytes)).unwrap();
    assert_eq!(transported[1].data_base64, STANDARD.encode("中文 😀\t\n"));
    let restored = write_package_base64(transported).unwrap();
    assert_eq!(
        read_package(&STANDARD.decode(restored).unwrap()).unwrap(),
        parts
    );
}

#[test]
fn unsafe_names_case_duplicates_and_nonempty_directories_are_rejected() {
    for name in [
        "",
        "/absolute",
        "../file",
        "a/../file",
        "./file",
        "a//file",
        "a\\file",
        "C:file",
        "file?x",
        "file#x",
        "a\0b",
        "a\u{7f}b",
        "__proto__",
        "constructor",
        "prototype",
        "/",
        "a///",
    ] {
        assert!(
            write_package(&[part(name, b"abc")]).is_err(),
            "accepted {name:?}"
        );
    }
    assert!(write_package(&[part("word/A.xml", b"x"), part("word/a.xml", b"y")]).is_err());
    assert!(write_package(&[part("word/", b"not empty")]).is_err());
    assert!(write_package(&[part(&"x".repeat(1025), b"")]).is_err());
}

#[test]
fn crc_local_header_flags_methods_and_names_cannot_spoof_directory() {
    let original = fixture();
    let directory = central(&original);
    for at in [4, 6, 8, 10, 12, 14, 18, 22, 30] {
        let mut bytes = original.clone();
        bytes[at] ^= 1;
        rejected(&bytes);
    }
    let mut bytes = original.clone();
    bytes[30 + "word/document.xml".len()] ^= 1;
    rejected(&bytes);
    for (local_at, central_at, value) in [
        (6, 8, 1),
        (6, 8, 0x8040),
        (6, 8, 0x8800),
        (8, 10, 99),
        (4, 6, 45),
    ] {
        let mut bytes = original.clone();
        set16(&mut bytes, local_at, value);
        set16(&mut bytes, directory + central_at, value);
        rejected(&bytes);
    }
}

#[test]
fn central_entries_cannot_escape_duplicate_overlap_or_change_disk() {
    let original = write_package(&[part("aa.xml", b"A"), part("bb.xml", b"B")]).unwrap();
    let directory = central(&original);
    let second = directory + 46 + 6;
    let second_local = u32_at(&original, second + 42) as usize;
    let mut bytes = original.clone();
    bytes[directory + 46..directory + 52].copy_from_slice(b"../a.x");
    bytes[30..36].copy_from_slice(b"../a.x");
    rejected(&bytes);
    let mut bytes = original.clone();
    bytes[second + 46..second + 52].copy_from_slice(b"AA.xml");
    bytes[second_local + 30..second_local + 36].copy_from_slice(b"AA.xml");
    rejected(&bytes);
    let mut bytes = original.clone();
    set32(&mut bytes, second + 42, 0);
    bytes[second + 46..second + 52].copy_from_slice(b"aa.xml");
    rejected(&bytes);
    let mut bytes = original.clone();
    set16(&mut bytes, directory + 34, 1);
    rejected(&bytes);
    let mut bytes = original.clone();
    let end = bytes.len() - 22;
    set16(&mut bytes, end + 4, 1);
    rejected(&bytes);
    let mut bytes = original.clone();
    set32(&mut bytes, directory + 38, 0xa000 << 16);
    rejected(&bytes);
    let mut bytes = original.clone();
    set32(&mut bytes, directory + 42, u32::MAX);
    rejected(&bytes);
}

#[test]
fn otherwise_valid_nested_local_headers_cannot_overlap() {
    let nested = write_package(&[part("inner.xml", b"nested")]).unwrap();
    let nested_local = &nested[..central(&nested)];
    let mut bytes = write_package(&[
        part("outer.xml", nested_local),
        part("inner.xml", b"nested"),
    ])
    .unwrap();
    // Outer payload is short enough to stay stored, so the nested local header
    // can be pointed to directly by the second central directory entry.
    if u16_at(&bytes, 8) != 0 {
        // Construct the outer stored entry from a one-part archive plus a
        // copied central record, independent of compressor size decisions.
        bytes = write_package(&[part("outer.xml", b""), part("inner.xml", b"nested")]).unwrap();
        let payload_at = 30 + "outer.xml".len();
        let old_directory = central(&bytes);
        let outer_crc = crc32fast::hash(nested_local);
        bytes.splice(payload_at..payload_at, nested_local.iter().copied());
        let directory = old_directory + nested_local.len();
        let end = bytes.len() - 22;
        set32(&mut bytes, end + 16, directory as u32);
        for (local_at, central_at, value) in [
            (14, 16, outer_crc),
            (18, 20, nested_local.len() as u32),
            (22, 24, nested_local.len() as u32),
        ] {
            set32(&mut bytes, local_at, value);
            set32(&mut bytes, directory + central_at, value);
        }
    }
    let directory = central(&bytes);
    let second = directory + 46 + "outer.xml".len();
    set32(&mut bytes, second + 42, (30 + "outer.xml".len()) as u32);
    let error = read_package(&bytes).unwrap_err();
    assert!(
        error.contains("重叠"),
        "expected overlap rejection, got {error}"
    );
}

#[test]
fn output_limit_applies_even_to_incompressible_input() {
    let mut random = Vec::with_capacity(PART_LIMIT);
    let mut value = 0x9372_ab01_u32;
    for _ in 0..PART_LIMIT {
        value ^= value << 13;
        value ^= value >> 17;
        value ^= value << 5;
        random.push(value as u8);
    }
    let parts: Vec<_> = (0..4)
        .map(|i| part(&format!("binary-{i}"), &random))
        .collect();
    assert!(write_package(&parts).unwrap_err().contains("16 MiB"));
}

#[test]
fn invalid_utf8_or_unflagged_unicode_names_are_rejected() {
    let original = write_package(&[part("正文.xml", b"")]).unwrap();
    let directory = central(&original);
    let mut bytes = original.clone();
    set16(&mut bytes, 6, 0);
    set16(&mut bytes, directory + 8, 0);
    rejected(&bytes);
    let mut bytes = original.clone();
    bytes[30] = 0xff;
    bytes[directory + 46] = 0xff;
    rejected(&bytes);
}

fn with_descriptor(signed: bool) -> Vec<u8> {
    let mut bytes = deflated();
    let directory = central(&bytes);
    let crc = u32_at(&bytes, directory + 16);
    let compressed = u32_at(&bytes, directory + 20);
    let size = u32_at(&bytes, directory + 24);
    let mut descriptor = Vec::new();
    if signed {
        descriptor.extend_from_slice(&0x08074b50_u32.to_le_bytes());
    }
    for value in [crc, compressed, size] {
        descriptor.extend_from_slice(&value.to_le_bytes());
    }
    bytes.splice(directory..directory, descriptor.iter().copied());
    let new_directory = directory + descriptor.len();
    let end = bytes.len() - 22;
    set32(&mut bytes, end + 16, new_directory as u32);
    set16(&mut bytes, 6, 0x808);
    set16(&mut bytes, new_directory + 8, 0x808);
    for offset in [14, 18, 22] {
        set32(&mut bytes, offset, 0);
    }
    bytes
}

#[test]
fn data_descriptors_with_and_without_signature_are_checked() {
    for signed in [false, true] {
        let original = with_descriptor(signed);
        assert_eq!(read_package(&original).unwrap()[0].data.len(), 16384);
        let directory = central(&original);
        let descriptor_len = if signed { 16 } else { 12 };
        for at in [directory - descriptor_len, directory - 8, directory - 4] {
            let mut bytes = original.clone();
            bytes[at] ^= 1;
            rejected(&bytes);
        }
        let mut bytes = original.clone();
        let end = bytes.len() - 22;
        set32(&mut bytes, end + 16, (directory - descriptor_len) as u32);
        rejected(&bytes);
    }
}

#[test]
fn compressed_stream_rejects_size_lies_truncation_trailing_bytes_and_bad_blocks() {
    let original = deflated();
    let directory = central(&original);
    let start = 30 + u16_at(&original, 26) as usize;
    assert_eq!(u16_at(&original, 8), 8);
    let mut bytes = original.clone();
    set32(&mut bytes, 22, 1);
    set32(&mut bytes, directory + 24, 1);
    rejected(&bytes);
    let mut bytes = original.clone();
    bytes[start] = 7;
    rejected(&bytes);
    let mut bytes = original.clone();
    let length = u32_at(&bytes, 18);
    set32(&mut bytes, 18, length - 1);
    set32(&mut bytes, directory + 20, length - 1);
    rejected(&bytes);
    let mut bytes = original.clone();
    bytes.insert(directory, 0);
    let new_directory = directory + 1;
    let end = bytes.len() - 22;
    set32(&mut bytes, end + 16, new_directory as u32);
    let length = u32_at(&bytes, 18);
    set32(&mut bytes, 18, length + 1);
    set32(&mut bytes, new_directory + 20, length + 1);
    rejected(&bytes);
    let mut bytes = original.clone();
    set32(&mut bytes, 22, PART_LIMIT as u32 + 1);
    set32(&mut bytes, directory + 24, PART_LIMIT as u32 + 1);
    rejected(&bytes);
}

#[test]
fn size_count_and_base64_limits_are_enforced() {
    assert!(write_package(&[]).is_err());
    assert!(write_package(
        &(0..=ENTRY_LIMIT)
            .map(|i| part(&i.to_string(), b""))
            .collect::<Vec<_>>()
    )
    .is_err());
    assert!(write_package(&[part("large", &vec![0; PART_LIMIT + 1])]).is_err());
    let parts: Vec<_> = (0..=EXPANDED_LIMIT / PART_LIMIT)
        .map(|i| part(&i.to_string(), &vec![0; PART_LIMIT]))
        .collect();
    assert!(write_package(&parts).is_err());
    assert!(read_package(&vec![0; INPUT_LIMIT + 1]).is_err());
    assert!(read_package_base64(&"A".repeat(encoded_limit(INPUT_LIMIT) + 1)).is_err());
    assert!(read_package_base64("%%%").is_err());
    assert!(write_package_base64(vec![Part {
        name: "x".into(),
        data_base64: "!".into()
    }])
    .is_err());
    assert!(write_package_base64(vec![Part {
        name: "x".into(),
        data_base64: "A".repeat(encoded_limit(PART_LIMIT) + 1)
    }])
    .is_err());
}

#[test]
fn malformed_headers_and_truncations_never_panic() {
    let original = fixture();
    for length in 0..original.len() {
        rejected(&original[..length]);
    }
    let mut bytes = original.clone();
    bytes.push(0);
    rejected(&bytes);
    let mut bytes = original.clone();
    let end = bytes.len() - 22;
    set32(&mut bytes, end + 12, u32::MAX);
    rejected(&bytes);
    let mut bytes = original.clone();
    let end = bytes.len() - 22;
    set32(&mut bytes, end + 16, u32::MAX);
    rejected(&bytes);
    // Deterministically perturb every byte; regardless of acceptance, malformed
    // metadata must remain a Result rather than an out-of-bounds panic.
    for at in 0..original.len() {
        let mut bytes = original.clone();
        bytes[at] ^= 0xff;
        let _ = read_package(&bytes);
    }
}

#[test]
fn zip64_and_malformed_extra_fields_are_rejected() {
    let original = fixture();
    let directory = central(&original);
    for extra in [vec![1, 0, 0, 0], vec![2, 0, 5, 0], vec![2, 0, 0]] {
        let mut bytes = original.clone();
        bytes.splice(directory..directory, extra.iter().copied());
        set16(&mut bytes, 28, extra.len() as u16);
        // The insertion is deliberately after the local data; move it to the
        // correct local extra location, retaining all later offsets.
        let data_start = 30 + "word/document.xml".len();
        let inserted: Vec<_> = bytes.drain(directory..directory + extra.len()).collect();
        bytes.splice(data_start..data_start, inserted);
        let new_directory = directory + extra.len();
        let end = bytes.len() - 22;
        set32(&mut bytes, end + 16, new_directory as u32);
        rejected(&bytes);
    }
}
