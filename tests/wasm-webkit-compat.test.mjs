import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const leb = n => { const out = []; do { const b = n & 127; n >>>= 7; out.push(b | (n ? 128 : 0)); } while (n); return out; };
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
const vector = entries => [...leb(entries.length), ...entries.flat()];
const name = text => [text.length, ...Buffer.from(text)];
function fixture() {
  const types = [[0x60, 2, 0x7e, 0x7e, 1, 0x7f], [0x60, 1, 0x7e, 1, 0x7f], [0x60, 0, 1, 0x7e]];
  const bodies = [[0, 0x20, 0, 0x20, 1, 0x51, 0x0b], [0, 0x20, 0, 0x20, 1, 0x52, 0x0b], [0, 0x20, 0, 0x50, 0x0b],
    [0, 0x42, 0x51, 0x0b]]; // -47's signed immediate is 0x51: never rewrite operand bytes.
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vector(types)), ...section(3, [4, 0, 0, 1, 2]),
    ...section(7, vector(['eq', 'ne', 'zero', 'sentinel'].map((text, index) => [...name(text), 0, index]))),
    ...section(10, vector(bodies.map(body => [...leb(body.length), ...body]))),
    ...section(0, [...name('proof'), 0x50, 0x51, 0x52])]);
}
const args = ['run', '--quiet', '--locked', '--release', '--manifest-path', 'scripts/wasm-webkit-compat/Cargo.toml', '--'];

test('WebKit comparison compatibility preserves every bit, immediates, exports and custom sections', t => {
  const directory = mkdtempSync(join(tmpdir(), 'wasm-comparison-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'compare.wasm'), original = fixture(); writeFileSync(file, original);
  assert.match(execFileSync('cargo', [...args, file], { encoding: 'utf8' }), /3 comparisons rewritten/);
  const patched = readFileSync(file), module = new WebAssembly.Module(patched), api = new WebAssembly.Instance(module).exports;
  assert.deepEqual(WebAssembly.Module.exports(module).map(value => value.name), ['eq', 'ne', 'zero', 'sentinel']);
  assert.deepEqual(Buffer.from(WebAssembly.Module.customSections(module, 'proof')[0]), Buffer.from([0x50, 0x51, 0x52]));
  assert.equal(api.sentinel(), -47n);
  const values = [0n, 1n, -1n, -(1n << 63n), (1n << 63n) - 1n];
  for (let bit = 0n; bit < 64n; bit++) values.push(BigInt.asIntN(64, 1n << bit), BigInt.asIntN(64, ~(1n << bit)));
  let seed = 0x123456789abcdef0n;
  for (let i = 0; i < 64; i++) { seed = BigInt.asIntN(64, seed * 6364136223846793005n + 1442695040888963407n); values.push(seed); }
  for (const a of values) {
    assert.equal(api.zero(a), Number(a === 0n));
    for (const b of values) { assert.equal(api.eq(a, b), Number(a === b)); assert.equal(api.ne(a, b), Number(a !== b)); }
  }
  assert.match(execFileSync('cargo', [...args, file], { encoding: 'utf8' }), /0 comparisons rewritten/);
  assert.deepEqual(readFileSync(file), patched);
});

test('WebKit compatibility rejects malformed modules without changing the input', t => {
  const directory = mkdtempSync(join(tmpdir(), 'wasm-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'invalid.wasm'), bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 10, 255]); writeFileSync(file, bytes);
  const result = spawnSync('cargo', [...args, file], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /WASM compatibility/); assert.deepEqual(readFileSync(file), bytes);
});
