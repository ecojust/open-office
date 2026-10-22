# WASM compatibility with older WebKit optimizers

Packaged macOS diagnostics reproduced a WebContent crash in
`JSC::B3::LowerMacros::recursivelyBuildSwitch`, followed by
`WTF::BitVector::resizeOutOfLine` and `pas_panic_on_out_of_memory_error`.
This matches [WebKit bug 317022](https://bugs.webkit.org/show_bug.cgi?id=317022)
and its [overflow-safe range fix](https://commits.webkit.org/318166@main).
A sparse i64 comparison chain can span more than `i64::MAX`; older optimizers
misclassify the overflowing range as a dense, enormous jump table.

After wasm-bindgen, the four editor builds run the locked Rust tool in
`scripts/wasm-webkit-compat`. It parses operators with wasmparser and rewrites
only i64 equality operations, without touching immediate bytes:

- `a == b`: `i32.wrap_i64(clz(a XOR b) >> 6)`.
- `a != b`: invert that i32 result.
- `a == 0`: `i32.wrap_i64(clz(a) >> 6)`.

For zero, the 64-bit leading-zero count is 64; every other bit pattern produces
0 through 63. Shifting by 6 therefore yields exactly the original Boolean.
The generated code has no i64 equality predicates for the old optimizer to
combine into a sparse i64 switch. It uses standard WASM instructions supported
by the existing platform baseline, with no private WebKit preferences.

The tool validates both modules, preserves non-code sections and all indices,
and is idempotent. Source fingerprints include the tool, its lockfile and its
wrapper. Installation verification uses the same source list; artifact hashes
are calculated after the transformation. Native lifecycle, unchanged-package
Rosetta and macOS 26 real-input publication requirements remain enforced.

`tests/wasm-webkit-compat.test.mjs` exercises signed boundaries, every single-bit
position, complements and deterministic random pairs against JavaScript BigInt.
It also checks exports, opaque custom sections, opcode-like immediate bytes,
idempotence, and rejection without modification of malformed input. Native
package verification remains necessary: a Linux browser is supplementary evidence.
