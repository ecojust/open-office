# Local native mouse timestamp correction

Patch ID: `qt-wasm-mouse-time-u64-wrap-v1`.

The public runtime was supplied as a prebuilt binary. This change deterministically transforms **one identified mouse callback** in that pinned binary. It neither replaces a global clock nor claims a complete source rebuild of the upstream runtime. `scripts/office-mouse-time-patch.mjs` performs no file or network writes; it accepts and returns Buffers.

## Fixed inputs and outputs

| Item | Bytes | SHA-256 |
| --- | ---: | --- |
| Upstream `soffice.wasm` | 161667499 | `9ebd9a487e849a24b9c69f843ebdb451709c27b7722c010e36846433474a5bd4` |
| Derived `soffice.wasm` | 161667500 | `56a2f4f43d0c5dbe45937054833d1946383bd07f1017d359d0efe7f4c9d85dd0` |
| Original mouse function body | 3299 | `b1c4989d454f76eeee543176ba12b7b55db6b54108142673c0ad7569dd5a374c` |
| Derived mouse function body | 3300 | `55c0db0f6cea8766245f33e9b77deb31338070e1025e8dab1ce1e976943d0ee0` |
| Unchanged callback-registration body | 3032 | `dc9a9d54613020a9ca9e346d630ef505a570ad4ba7e502d548526422a4211731` |

The corresponding unchanged `soffice.js` is 858124 bytes, SHA-256 `5143e5354f470b87f86ba272bcfef857bd13e6f07b59666e48a7ccb89643cd77`. It implements `emscripten_date_now` as `Date.now()`. Its `emscripten_get_now` also uses epoch time (`performance.timeOrigin + performance.now()`), so substituting that import would not correct this defect.

Upstream download URL: <https://cdn.zetaoffice.net/zetaoffice_latest/soffice.wasm>. Despite the moving alias, only the exact decoded response-body hash above is accepted. A different upstream version requires new analysis and new pinned hashes; this script must not guess matching offsets in an unfamiliar runtime.

## Actual binary evidence and change

The actual module imports `env.emscripten_date_now` at function 71 (`() -> f64`). Function 221638 registers table index 270150 as the mouse-down, mouse-up and mouse-move callback through imports 62–64. The element section maps that table entry to function 221801. These bindings, signatures, whole-file hashes and both native body hashes are verified by the transformation.

In function 221801, `call 71` saves its result to local 18. The original code converts that value to an unsigned i32 only if it is in `[0, 2^32)`; otherwise an explicit `i32.const 0` is used. Modern epoch milliseconds exceed 2^32, so all mouse events get time zero. The result is stored in the native mouse event's timestamp field at offset 24. Native click-count processing can consequently mistake clicks separated by many seconds for a double click at the same position.

Only the cast expression at body offset 2575 changes:

1. Its upper-bound `f64.const 2^32` becomes `f64.const 2^64`.
2. `i32.trunc_f64_u` becomes `i64.trunc_f64_u; i32.wrap_i64`.
3. The nonnegative guard, invalid-value fallback zero, native result type, event store, date import and other code remain unchanged.

The replacement adds one byte. The script structurally parses and rewrites the function body's ULEB length and Code-section payload length (102354131 → 102354132). It reparses the result and requires its independently recorded derived hash. Already-derived input is verified and returned unchanged. Unknown or damaged input is rejected, including input that happens to contain similar opcode bytes.

For finite nonnegative epoch values below 2^64, the behavior is `uint32(uint64(trunc(epochMilliseconds)))`. It retains milliseconds modulo 2^32, the native event's existing 32-bit width. Negative values, NaN, infinities and values at/above 2^64 return zero without trapping. No wall-clock calculation elsewhere is altered.

The timestamp wraps approximately every 49.7 days. Qt's unsigned elapsed-time comparison can handle this wrap; VCL copies the value to a wider unsigned field, so a click pair straddling the wrap may be treated as separate. This patch does not redesign the native event-time ABI, provide a monotonic clock, or eliminate wall-clock adjustments. Its bounded objective is to stop all contemporary mouse timestamps collapsing to zero.

## Source equivalent and licensing provenance

`qt-wasm-mouse-time-source-equivalent.patch` applies to the publicly published QtBase snapshot:

- Repository: <https://github.com/allotropia/qtbase>
- Commit: `a320678c85ec8029d5394bcd673d4c208af1de3a`
- File: `src/plugins/platforms/wasm/qwasmeventtranslator.cpp`
- Original file SHA-256: `9c883d88031e6baf13cf45fe703963aa14f162895648c34992c59fb33e5a76e9`
- Exact file URL: <https://raw.githubusercontent.com/allotropia/qtbase/a320678c85ec8029d5394bcd673d4c208af1de3a/src/plugins/platforms/wasm/qwasmeventtranslator.cpp>

This snapshot obtains epoch time in `QWasmEventTranslator::processMouse` and passes it to `handleMouseEvent`, whose native timestamp is an `ulong` (32 bits in the identified WASM). It explains the same data flow. Its exact identity with the CDN compiler inputs has **not** been independently established. The source diff documents the intended bounded conversion; it is not evidence that rebuilding this snapshot produces the shipped binary, and no such rebuild was performed.

The Qt WASM platform-plugin files retain their existing Qt copyright and GPL-3.0-only notices. Include this local-change description, the source-equivalent patch and the complete deterministic transformation script with the corresponding-source materials, alongside the fixed upstream archives, existing license notices and recorded build/source-provenance limits. A source diff alone does not establish an otherwise unproved complete corresponding-source chain.

## Fetch and release integration contract

Keep the upstream download's byte count/hash distinct from the derived asset's byte count/hash. Download and verify the former, run the deterministic transformation, verify the latter, then install atomically. A matching derived file needs no reapplication; a matching upstream file can be derived offline. Unknown bytes must never be treated as a valid new upstream or silently patched. Do not replace the upstream checksum with the derived checksum while continuing to download the unmodified upstream URL.

The runtime manifest, release cache key, corresponding-source manifest's runtime-manifest checksum and shipped-asset hashes must describe the same derived artifact. The source bundle must also carry this script, patch and explanation. Preserve original hashes as provenance, and record the local derivation explicitly instead of presenting it as the CDN's original build.

## Verification and limits

Run `node --test --experimental-test-isolation=none tests/office-mouse-time-patch.test.mjs`.

The tests execute the exact old and new cast expressions in tiny, isolated WASM modules. They cover epoch milliseconds, fractional truncation, invalid input, 2^32 wrap, elapsed differences and unchanged global clocks. With the full pinned runtime available, they additionally verify the actual source/derived digests, untouched byte ranges, idempotence, corrupt/unknown rejection and `WebAssembly.validate` for the entire original and derived modules. Validation does not instantiate the office engine.

Browser behavior requires a separate runtime regression: delayed single clicks at the original cell position after editing/Enter; real rapid double clicks; selection after Ctrl+Home; clicking another cell and returning; save/reopen; and formulas such as `NOW()` to establish that document wall time remains normal. Static/binary validation alone must not be reported as passing those browser tests.

Research evidence (development workspace, not a release runtime dependency): `/workspace/open-office-research/libreoffice/calc-input-targeted/{mouse-time-findings.md,wasm-mouse-time-evidence.json,inspect-wasm-mouse-time.py}`. Registration/callback disassembly used WABT 1.0.39; the product transformer has no WABT dependency.
