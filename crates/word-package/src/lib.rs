//! Independent ZIP container processing. This crate does not parse WordprocessingML.
//! All metadata is checked before decompression; readers never extract to disk.

use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{write::DeflateEncoder, Compression, Decompress, FlushDecompress, Status};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io::Write};

pub const INPUT_LIMIT: usize = 16 * 1024 * 1024;
pub const EXPANDED_LIMIT: usize = 32 * 1024 * 1024;
pub const PART_LIMIT: usize = 4 * 1024 * 1024;
pub const ENTRY_LIMIT: usize = 256;
pub const NAME_LIMIT: usize = 1024;
pub const fn encoded_limit(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}
pub const CLI_INPUT_LIMIT: usize =
    encoded_limit(EXPANDED_LIMIT) + ENTRY_LIMIT * (NAME_LIMIT * 6 + 128);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Part {
    pub name: String,
    pub data_base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawPart {
    pub name: String,
    pub data: Vec<u8>,
}

type Result<T> = std::result::Result<T, String>;
fn ensure(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn u16_at(bytes: &[u8], at: usize) -> Result<u16> {
    let value = bytes.get(at..at + 2).ok_or("DOCX ZIP 文件头不完整。")?;
    Ok(u16::from_le_bytes(value.try_into().unwrap()))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    let value = bytes.get(at..at + 4).ok_or("DOCX ZIP 文件头不完整。")?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}
fn safe_name(name: &str) -> Result<()> {
    ensure(
        !name.is_empty()
            && name.len() <= NAME_LIMIT
            && !name.starts_with('/')
            && !name.contains("//")
            && !name
                .chars()
                .any(|c| c <= '\u{1f}' || c == '\u{7f}' || "\\:#?".contains(c)),
        "DOCX 包含不安全的 ZIP 路径。",
    )?;
    ensure(
        name.trim_end_matches('/')
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
            && !["__proto__", "prototype", "constructor"].contains(&name),
        "DOCX 包含越界或保留的 ZIP 路径。",
    )
}
fn extra_fields(bytes: &[u8]) -> Result<()> {
    let mut cursor = 0;
    while cursor < bytes.len() {
        ensure(cursor + 4 <= bytes.len(), "DOCX ZIP 扩展字段不完整。")?;
        let kind = u16_at(bytes, cursor)?;
        let size = u16_at(bytes, cursor + 2)? as usize;
        ensure(
            ![0x0001, 0x0017, 0x9901].contains(&kind),
            "不支持 ZIP64 或加密 DOCX。",
        )?;
        cursor += 4 + size;
        ensure(cursor <= bytes.len(), "DOCX ZIP 扩展字段长度无效。")?;
    }
    Ok(())
}

struct Entry<'a> {
    name: String,
    compressed: &'a [u8],
    method: u16,
    size: usize,
    crc: u32,
}
fn inspect(bytes: &[u8]) -> Result<Vec<Entry<'_>>> {
    ensure(
        bytes.len() >= 22 && bytes.len() <= INPUT_LIMIT,
        "DOCX 文件为空、损坏或超过 16 MiB。",
    )?;
    let end = (bytes.len().saturating_sub(65_557)..=bytes.len() - 22)
        .rev()
        .find(|&at| {
            u32_at(bytes, at).ok() == Some(0x06054b50)
                && u16_at(bytes, at + 20).is_ok_and(|n| at + 22 + n as usize == bytes.len())
        })
        .ok_or("无法读取 DOCX ZIP 目录。")?;
    let count = u16_at(bytes, end + 10)? as usize;
    let directory_size = u32_at(bytes, end + 12)? as usize;
    let directory = u32_at(bytes, end + 16)? as usize;
    ensure(
        u16_at(bytes, end + 4)? == 0
            && u16_at(bytes, end + 6)? == 0
            && u16_at(bytes, end + 8)? as usize == count,
        "不支持分卷 DOCX。",
    )?;
    ensure(
        count > 0 && count <= ENTRY_LIMIT && directory <= end && directory_size == end - directory,
        "DOCX ZIP 目录无效或文件数量超过 256。",
    )?;
    let mut entries = Vec::with_capacity(count);
    let mut seen = HashSet::with_capacity(count);
    let mut ranges = Vec::with_capacity(count);
    let mut cursor = directory;
    let mut expanded = 0;
    for _ in 0..count {
        ensure(
            cursor + 46 <= end && u32_at(bytes, cursor)? == 0x02014b50,
            "DOCX ZIP 目录项损坏。",
        )?;
        let version = u16_at(bytes, cursor + 6)?;
        let flags = u16_at(bytes, cursor + 8)?;
        let method = u16_at(bytes, cursor + 10)?;
        let crc = u32_at(bytes, cursor + 16)?;
        let compressed_size = u32_at(bytes, cursor + 20)? as usize;
        let size = u32_at(bytes, cursor + 24)? as usize;
        let name_len = u16_at(bytes, cursor + 28)? as usize;
        let extra_len = u16_at(bytes, cursor + 30)? as usize;
        let comment_len = u16_at(bytes, cursor + 32)? as usize;
        let attrs = u32_at(bytes, cursor + 38)?;
        let local = u32_at(bytes, cursor + 42)? as usize;
        ensure(
            version <= 20
                && flags & !0x080e == 0
                && (method == 0 || method == 8)
                && (method == 8 || flags & 6 == 0)
                && size != u32::MAX as usize
                && compressed_size != u32::MAX as usize
                && local != u32::MAX as usize,
            "不支持加密、ZIP64 或特殊压缩格式的 DOCX。",
        )?;
        ensure(u16_at(bytes, cursor + 34)? == 0, "不支持分卷 DOCX 条目。")?;
        ensure(
            name_len > 0
                && name_len <= NAME_LIMIT
                && cursor + 46 + name_len + extra_len + comment_len <= end,
            "DOCX ZIP 文件名或目录长度无效。",
        )?;
        let name_bytes = &bytes[cursor + 46..cursor + 46 + name_len];
        ensure(
            flags & 0x800 != 0 || name_bytes.is_ascii(),
            "DOCX ZIP 文件名必须使用 UTF-8。",
        )?;
        let name = std::str::from_utf8(name_bytes)
            .map_err(|_| "DOCX ZIP 文件名编码无效。")?
            .to_owned();
        safe_name(&name)?;
        ensure(
            seen.insert(name.to_lowercase()),
            "DOCX ZIP 包含重复或大小写歧义的文件。",
        )?;
        ensure(
            (attrs >> 16) & 0xf000 != 0xa000,
            "不支持 DOCX ZIP 中的符号链接。",
        )?;
        ensure(size <= PART_LIMIT, "DOCX ZIP 单个文件超过 4 MiB。")?;
        expanded += size;
        ensure(expanded <= EXPANDED_LIMIT, "DOCX ZIP 解压内容超过 32 MiB。")?;
        ensure(
            !name.ends_with('/') || size == 0,
            "DOCX ZIP 目录条目不能包含正文。",
        )?;
        extra_fields(&bytes[cursor + 46 + name_len..cursor + 46 + name_len + extra_len])?;
        ensure(
            local <= directory && local + 30 <= directory && u32_at(bytes, local)? == 0x04034b50,
            "DOCX ZIP 本地文件头损坏。",
        )?;
        let local_name_len = u16_at(bytes, local + 26)? as usize;
        let local_extra_len = u16_at(bytes, local + 28)? as usize;
        let start = local + 30 + local_name_len + local_extra_len;
        ensure(
            start <= directory
                && compressed_size <= directory - start
                && local_name_len == name_len
                && u16_at(bytes, local + 4)? == version
                && u16_at(bytes, local + 6)? == flags
                && u16_at(bytes, local + 8)? == method
                && u16_at(bytes, local + 10)? == u16_at(bytes, cursor + 12)?
                && u16_at(bytes, local + 12)? == u16_at(bytes, cursor + 14)?,
            "DOCX ZIP 文件头与目录不一致。",
        )?;
        ensure(
            &bytes[local + 30..local + 30 + local_name_len] == name_bytes,
            "DOCX ZIP 本地与目录文件名不一致。",
        )?;
        extra_fields(&bytes[local + 30 + local_name_len..start])?;
        ensure(
            method != 0 || size == compressed_size,
            "DOCX ZIP 未压缩条目长度不一致。",
        )?;
        let expected = [crc, compressed_size as u32, size as u32];
        for (index, value) in expected.iter().enumerate() {
            let actual = u32_at(bytes, local + 14 + index * 4)?;
            ensure(
                actual == *value || flags & 8 != 0 && actual == 0,
                "DOCX ZIP 本地校验值或长度与目录不一致。",
            )?;
        }
        let stop = start + compressed_size;
        let mut range_end = stop;
        if flags & 8 != 0 {
            let matches = |at: usize| {
                at + 12 <= directory
                    && expected
                        .iter()
                        .enumerate()
                        .all(|(i, v)| u32_at(bytes, at + i * 4).ok() == Some(*v))
            };
            if stop + 16 <= directory && u32_at(bytes, stop)? == 0x08074b50 && matches(stop + 4) {
                range_end += 16;
            } else if matches(stop) {
                range_end += 12;
            } else {
                return Err("DOCX ZIP 数据描述符与目录不一致。".into());
            }
        }
        ranges.push((local, range_end));
        entries.push(Entry {
            name,
            compressed: &bytes[start..stop],
            method,
            size,
            crc,
        });
        cursor += 46 + name_len + extra_len + comment_len;
    }
    ensure(cursor == end, "DOCX ZIP 目录长度不一致。")?;
    ranges.sort_unstable();
    ensure(
        ranges.windows(2).all(|pair| pair[1].0 >= pair[0].1),
        "DOCX ZIP 文件数据范围重叠。",
    )?;
    Ok(entries)
}

fn inflate(entry: &Entry<'_>) -> Result<Vec<u8>> {
    if entry.method == 0 {
        return Ok(entry.compressed.to_vec());
    }
    let mut decoder = Decompress::new(false);
    // One extra byte detects a lying expanded-size header without allocating the
    // actual expansion. Both input and output counters must end exactly at EOS.
    let mut output = vec![0; entry.size + 1];
    let status = decoder
        .decompress(entry.compressed, &mut output, FlushDecompress::Finish)
        .map_err(|_| "DOCX ZIP 压缩数据损坏。")?;
    ensure(
        status == Status::StreamEnd
            && decoder.total_in() == entry.compressed.len() as u64
            && decoder.total_out() == entry.size as u64,
        "DOCX ZIP 压缩数据长度与目录不一致。",
    )?;
    output.truncate(entry.size);
    Ok(output)
}

pub fn read_package(input: &[u8]) -> Result<Vec<RawPart>> {
    let entries = inspect(input)?;
    let mut parts = Vec::with_capacity(entries.len());
    for entry in entries {
        let data = inflate(&entry)?;
        ensure(
            crc32fast::hash(&data) == entry.crc,
            "DOCX ZIP 内容 CRC 校验失败。",
        )?;
        parts.push(RawPart {
            name: entry.name,
            data,
        });
    }
    Ok(parts)
}

fn push16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn push32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}
struct Written {
    name: String,
    offset: usize,
    crc: u32,
    size: usize,
    compressed_size: usize,
    method: u16,
}

pub fn write_package(parts: &[RawPart]) -> Result<Vec<u8>> {
    ensure(
        !parts.is_empty() && parts.len() <= ENTRY_LIMIT,
        "DOCX ZIP 需要 1 至 256 个文件。",
    )?;
    let mut seen = HashSet::with_capacity(parts.len());
    let mut expanded = 0;
    let mut central_size = 0;
    // Validate the whole caller-owned collection before compression or output.
    for part in parts {
        safe_name(&part.name)?;
        ensure(
            seen.insert(part.name.to_lowercase()),
            "DOCX ZIP 包含重复或大小写歧义的文件。",
        )?;
        ensure(
            part.data.len() <= PART_LIMIT,
            "DOCX ZIP 单个文件超过 4 MiB。",
        )?;
        ensure(
            !part.name.ends_with('/') || part.data.is_empty(),
            "DOCX ZIP 目录条目不能包含正文。",
        )?;
        expanded += part.data.len();
        central_size += 46 + part.name.len();
        ensure(expanded <= EXPANDED_LIMIT, "DOCX ZIP 解压内容超过 32 MiB。")?;
    }
    let mut out = Vec::new();
    let mut records = Vec::with_capacity(parts.len());
    for part in parts {
        let mut compressor = DeflateEncoder::new(Vec::new(), Compression::fast());
        compressor
            .write_all(&part.data)
            .map_err(|_| "无法压缩 DOCX ZIP 内容。")?;
        let compressed = compressor
            .finish()
            .map_err(|_| "无法完成 DOCX ZIP 压缩。")?;
        let (data, method) = if compressed.len() < part.data.len() {
            (compressed.as_slice(), 8)
        } else {
            (part.data.as_slice(), 0)
        };
        ensure(
            out.len() + 30 + part.name.len() + data.len() + central_size + 22 <= INPUT_LIMIT,
            "保存的 DOCX ZIP 超过 16 MiB，原文件未修改。",
        )?;
        let record = Written {
            name: part.name.clone(),
            offset: out.len(),
            crc: crc32fast::hash(&part.data),
            size: part.data.len(),
            compressed_size: data.len(),
            method,
        };
        push32(&mut out, 0x04034b50);
        push16(&mut out, 20);
        push16(&mut out, 0x800);
        push16(&mut out, method);
        push16(&mut out, 0);
        push16(&mut out, 33);
        push32(&mut out, record.crc);
        push32(&mut out, data.len() as u32);
        push32(&mut out, part.data.len() as u32);
        push16(&mut out, part.name.len() as u16);
        push16(&mut out, 0);
        out.extend_from_slice(part.name.as_bytes());
        out.extend_from_slice(data);
        records.push(record);
    }
    let directory = out.len();
    for record in records {
        push32(&mut out, 0x02014b50);
        push16(&mut out, 20);
        push16(&mut out, 20);
        push16(&mut out, 0x800);
        push16(&mut out, record.method);
        push16(&mut out, 0);
        push16(&mut out, 33);
        push32(&mut out, record.crc);
        push32(&mut out, record.compressed_size as u32);
        push32(&mut out, record.size as u32);
        push16(&mut out, record.name.len() as u16);
        push16(&mut out, 0);
        push16(&mut out, 0);
        push16(&mut out, 0);
        push16(&mut out, 0);
        push32(&mut out, 0);
        push32(&mut out, record.offset as u32);
        out.extend_from_slice(record.name.as_bytes());
    }
    let size = out.len() - directory;
    push32(&mut out, 0x06054b50);
    push16(&mut out, 0);
    push16(&mut out, 0);
    push16(&mut out, parts.len() as u16);
    push16(&mut out, parts.len() as u16);
    push32(&mut out, size as u32);
    push32(&mut out, directory as u32);
    push16(&mut out, 0);
    Ok(out)
}

pub fn read_package_base64(encoded: &str) -> Result<Vec<Part>> {
    ensure(
        encoded.len() <= encoded_limit(INPUT_LIMIT),
        "DOCX ZIP 编码数据超过 16 MiB 限制。",
    )?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "DOCX ZIP Base64 编码无效。")?;
    read_package(&bytes).map(|parts| {
        parts
            .into_iter()
            .map(|p| Part {
                name: p.name,
                data_base64: STANDARD.encode(p.data),
            })
            .collect()
    })
}

pub fn write_package_base64(parts: Vec<Part>) -> Result<String> {
    ensure(
        !parts.is_empty() && parts.len() <= ENTRY_LIMIT,
        "DOCX ZIP 需要 1 至 256 个文件。",
    )?;
    // Encoded lengths are checked before any decoding; exact decoded lengths are
    // checked again because Base64 padding can change the size by up to 2 bytes.
    let mut encoded_total = 0;
    for part in &parts {
        safe_name(&part.name)?;
        ensure(
            part.data_base64.len() <= encoded_limit(PART_LIMIT),
            "DOCX ZIP 单个文件编码超过 4 MiB 限制。",
        )?;
        encoded_total += part.data_base64.len();
        ensure(
            encoded_total <= encoded_limit(EXPANDED_LIMIT) + parts.len() * 4,
            "DOCX ZIP 编码内容超过 32 MiB 限制。",
        )?;
    }
    let mut raw = Vec::with_capacity(parts.len());
    let mut expanded = 0;
    for part in parts {
        let data = STANDARD
            .decode(part.data_base64)
            .map_err(|_| "DOCX ZIP 内容 Base64 编码无效。")?;
        ensure(data.len() <= PART_LIMIT, "DOCX ZIP 单个文件超过 4 MiB。")?;
        expanded += data.len();
        ensure(expanded <= EXPANDED_LIMIT, "DOCX ZIP 解压内容超过 32 MiB。")?;
        raw.push(RawPart {
            name: part.name,
            data,
        });
    }
    write_package(&raw).map(|bytes| STANDARD.encode(bytes))
}
