# Word package core

Independent Rust ZIP processing for the lightweight Word editor. This module handles the container; WordprocessingML, document semantics, input and rendering remain in the application.

`read_package(&[u8])` and `write_package(&[RawPart])` use byte buffers. `read_package_base64(&str)` and `write_package_base64(Vec<Part>)` provide the IPC shape `{ name, dataBase64 }`. Tauri invokes these through background tasks without accepting filesystem paths.

Bounds: 16 MiB ZIP input/output, 32 MiB total expanded content, 4 MiB per entry, 256 entries, 1,024 UTF-8 bytes per name. Stored and DEFLATE entries are supported, including standard data descriptors. The reader validates local/central metadata, names, ranges, CRCs and exact decompression lengths. Encryption, ZIP64, multiple disks, symlinks, ambiguous names and unsafe paths are rejected. XML parsing and semantic validation must still run after reading the package.

The writer uses the Rust DEFLATE backend, UTF-8 names, fixed ZIP timestamps and caller-supplied part ordering. It chooses stored data when compression makes an entry larger. Saving the same parts produces the same bytes.

```sh
cargo test --locked --manifest-path crates/word-package/Cargo.toml
cargo build --locked --manifest-path crates/word-package/Cargo.toml --bin word-package-cli
```

The CLI accepts one JSON request from standard input:

```json
{"operation":"read","base64":"..."}
{"operation":"write","parts":[{"name":"word/document.xml","dataBase64":"..."}]}
```

It returns `{ "ok": true, "parts": [...] }` or `{ "ok": true, "base64": "..." }`. Errors return `{ "ok": false, "error": "..." }` and a nonzero exit code. This adapter allows real Rust/browser interoperability tests without pretending to exercise native Tauri dialogs or IPC.
