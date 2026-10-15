import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectInstalledWordcraft, validateNativeWordcraftEvidence, validateWordcraftNativeReport, wordcraftSourceHash } from '../scripts/wordcraft-native-smoke.mjs';
import { wordcraftReport } from './helpers/wordcraft-smoke-report.mjs';
import { wordcraftDocx } from './helpers/wordcraft-smoke-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function installation() {
  const directory = mkdtempSync(join(tmpdir(), 'wordcraft-native-contract-'));
  const root = join(directory, 'checkout'), resourceRoot = join(directory, 'installed');
  for (const path of ['scripts', 'vendor/wordcraft/src', 'crates/word-engine/fonts']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'scripts/build-wordcraft.mjs'), '// independently controlled fixture');
  writeFileSync(join(root, 'vendor/wordcraft/src/lib.rs'), '// source fixture');
  writeFileSync(join(root, 'crates/word-engine/fonts/license.txt'), 'font fixture');
  const assets = join(resourceRoot, 'frontend/wordcraft'); mkdirSync(assets, { recursive: true });
  const bytes = { 'wordcraft.js': Buffer.from('export const engine = "WordCraft";'), 'wordcraft.d.ts': Buffer.from('export const engine: string;'),
    'wordcraft_bg.wasm': Buffer.from('0061736d01000000', 'hex'), 'wordcraft_bg.wasm.d.ts': Buffer.from('export const memory: WebAssembly.Memory;') };
  for (const [name, value] of Object.entries(bytes)) writeFileSync(join(assets, name), value);
  const manifest = { engine: 'WordCraft', upstreamCommit: '3292ba05d3c15c003823be6849e87a1c6e205242', sourceHash: wordcraftSourceHash(root),
    files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha(value)])), sizeBytes: 8,
    target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129' };
  const writeManifest = () => writeFileSync(join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); writeManifest();
  return { directory, root, resourceRoot, assets, manifest, writeManifest, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function boundReport(installed) {
  const manifest = JSON.parse(installed.manifestText);
  return { preflight: { wordcraft: installed }, frontend: { wordcraft: { resources: {
    wasmLoaded: true, sameOrigin: true, wasmPath: '/wordcraft/wordcraft_bg.wasm', manifestSha256: installed.manifestSha256,
    sourceHash: manifest.sourceHash, upstreamCommit: manifest.upstreamCommit,
    files: Object.fromEntries(['wordcraft.js', 'wordcraft_bg.wasm'].map(name => [name, structuredClone(installed.files[name])])),
  } } } };
}

test('WordCraft default-canvas report independently checks both exported DOCX files', () => {
  const result = validateWordcraftNativeReport(wordcraftReport());
  assert.equal(result.exported.text, 'WordCraft Native 中文😀');
  assert.deepEqual(result.exported.format, result.reopened.format);
});

test('WordCraft canvas evidence cannot be replaced with old IPC or success flags', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateWordcraftNativeReport(value), /WordCraft/);
  for (const mutate of [
    report => { report.engine = 'rust-word'; }, report => { report.transport = 'tauri-word-engine-request'; },
    report => { report.transport = 'local-wasm-in-browser'; },
    report => { report.kind = 'core'; }, report => { report.schemaVersion = 0; }, report => { report.ok = false; },
    report => { report.checks.pop(); }, report => { report.checks.reverse(); }, report => { report.limitations = []; },
    report => { report.cleanup.closed = 1; }, report => { report.cleanup.remainingCanvas = 1; }, report => { report.cleanup.remainingInput = 1; },
    report => { report.canvas.paintCalls = 0; }, report => { report.canvas.width = 1; }, report => { report.canvas.pageCount = '1'; },
    report => { report.domInput.isTrusted = true; }, report => { report.domInput.eventType = 'command'; },
    report => { report.format.bold = false; }, report => { report.failures.preserved = false; },
    report => { report.reopenedText += 'duplicated'; }, report => { report.error = 'engine failure'; },
    report => { report.resources.sameOrigin = false; }, report => { report.resources.wasmPath = 'https://other.test/editor.wasm'; },
    report => { delete report.resources.files; }, report => { report.resources.files['wordcraft.js'].sha256 = ''; },
    report => { report.resources.files['wordcraft_bg.wasm'].bytes = Infinity; },
  ]) {
    const report = wordcraftReport(); mutate(report);
    assert.throws(() => validateWordcraftNativeReport(report), /WordCraft/);
  }
});

test('WordCraft native export and reopened bytes each must pass XML rather than declared format/text', () => {
  const wrongText = wordcraftDocx(parts => { parts['word/document.xml'] = parts['word/document.xml'].replace('WordCraft Native', 'Different engine'); });
  for (const key of ['docxBase64', 'reopenedDocxBase64']) {
    for (const invalid of [undefined, '', '%%%invalid', 'A'.repeat(1024 * 1024), wrongText]) {
      const report = wordcraftReport(); report[key] = invalid;
      assert.throws(() => validateWordcraftNativeReport(report), /WordCraft/);
    }
  }
});

test('installed assets bind exact manifest bytes, WASM/JS sizes and hashes to the WebView and checkout', () => {
  const fixture = installation();
  try {
    const installed = inspectInstalledWordcraft(fixture.resourceRoot, { root: fixture.root });
    assert.equal(installed.files['wordcraft_bg.wasm'].bytes, 8);
    const report = boundReport(installed);
    assert.deepEqual(validateNativeWordcraftEvidence(report, { root: fixture.root }), {
      wordcraftInstalledAssets: true, wordcraftRuntimeAssetDigests: true, wordcraftCheckoutSource: true,
    });
    for (const mutate of [
      item => { delete item.preflight.wordcraft; }, item => { delete item.frontend.wordcraft; },
      item => { item.preflight.wordcraft.verified = false; }, item => { item.preflight.wordcraft.manifestText += ' '; },
      item => { item.preflight.wordcraft.files['wordcraft.js'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.wordcraft.resources.manifestSha256 = 'e'.repeat(64); },
      item => { item.frontend.wordcraft.resources.files['wordcraft_bg.wasm'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.wordcraft.resources.files['wordcraft.js'].bytes++; },
      item => { item.frontend.wordcraft.resources.sourceHash = 'e'.repeat(64); },
    ]) {
      const mutated = structuredClone(report); mutate(mutated);
      assert.throws(() => validateNativeWordcraftEvidence(mutated, { root: fixture.root }), /WordCraft/);
    }
    writeFileSync(join(fixture.root, 'vendor/wordcraft/src/lib.rs'), '// modified after build');
    assert.throws(() => validateNativeWordcraftEvidence(report, { root: fixture.root }), /current checkout source/);
  } finally { fixture.cleanup(); }
});

test('installed preflight rejects missing, modified, stale or malformed assets without source fallback', () => {
  const mutations = [
    item => rmSync(join(item.assets, 'wordcraft.js')),
    item => writeFileSync(join(item.assets, 'wordcraft_bg.wasm'), Buffer.from('modified')),
    item => { item.manifest.sizeBytes++; item.writeManifest(); },
    item => { item.manifest.sourceHash = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.files['../escape'] = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.upstreamCommit = '0'.repeat(40); item.writeManifest(); },
    item => { item.manifest.wasmBindgenVersion = '0.0.0'; item.writeManifest(); },
    item => writeFileSync(join(item.assets, 'manifest.json'), '{invalid'),
    item => { const bytes = Buffer.from('not wasm'); writeFileSync(join(item.assets, 'wordcraft_bg.wasm'), bytes); item.manifest.files['wordcraft_bg.wasm'] = sha(bytes); item.writeManifest(); },
  ];
  for (const mutate of mutations) {
    const fixture = installation();
    try { mutate(fixture); assert.throws(() => inspectInstalledWordcraft(fixture.resourceRoot, { root: fixture.root })); }
    finally { fixture.cleanup(); }
  }
});

test('an installed symlink cannot redirect WASM to outside the application resources', { skip: process.platform === 'win32' }, () => {
  const fixture = installation();
  try {
    const path = join(fixture.assets, 'wordcraft_bg.wasm'), outside = join(fixture.directory, 'outside.wasm');
    writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
    assert.throws(() => inspectInstalledWordcraft(fixture.resourceRoot, { root: fixture.root }), /escapes/);
  } finally { fixture.cleanup(); }
});
