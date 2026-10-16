import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_DOCX_BASE64 = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UPSTREAM = '3292ba05d3c15c003823be6849e87a1c6e205242';
const FILES = ['office-word.d.ts', 'office-word.js', 'office-word_bg.wasm', 'office-word_bg.wasm.d.ts'];
const RUNTIME_FILES = ['office-word.js', 'office-word_bg.wasm'];
export const OFFICE_WORD_SMOKE_TEXT = 'OfficeWord Native 中文😀';
export const REQUIRED_OFFICE_WORD_CHECKS = Object.freeze([
  'default-mounted-local-wasm-canvas-painted',
  'synthetic-dom-input-chinese-emoji',
  'rust-character-formatting',
  'docx-export-and-save-receipt',
  'stale-save-and-invalid-open-preserve-active-document',
  'saved-docx-reopened-in-default-editor',
]);
export const OFFICE_WORD_SMOKE_LIMITATIONS = Object.freeze([
  'Synthetic WebView input events are not a physical operating-system IME.',
  'Save checks cover exported DOCX bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.',
]);
const FORMAT = { bold: true, italic: true, underline: true, size: 16, color: '336699' };
const check = (value, message) => assert.ok(value, `OfficeWord ${message}`);
const digest = value => createHash('sha256').update(value).digest('hex');
function object(value, label) { check(value && typeof value === 'object' && !Array.isArray(value), `${label} is missing`); }
function positive(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} is invalid`);
}

/** Match the build script's path+NUL+bytes+NUL fingerprint without executing a build. */
export function wordSourceHash(root = ROOT) {
  const files = ['scripts/build-office-word.mjs', 'scripts/build-office-icons.mjs'];
  function collect(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (['target', '.git'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  collect('vendor/office-word'); collect('assets/fonts/open-office'); collect('src/icons');
  check(files.some(name => name.startsWith('vendor/office-word/'))
    && files.some(name => name.startsWith('assets/fonts/open-office/')), 'source and licensed fonts are required');
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  return hash.digest('hex');
}

function containedFile(root, path, maxBytes) {
  const canonicalRoot = realpathSync(root), canonical = realpathSync(path);
  const within = relative(canonicalRoot, canonical);
  check(within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`), 'installed asset escapes the application resources');
  const stat = statSync(canonical);
  check(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'installed asset is not a bounded regular file');
  return { path: canonical, bytes: stat.size };
}
function hashFile(path) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), descriptor = openSync(path, 'r');
  try { let size; while ((size = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)); }
  finally { closeSync(descriptor); }
  return hash.digest('hex');
}
function manifestEvidence(evidence, sourceHash) {
  object(evidence, 'installed resource evidence');
  check(evidence.schemaVersion === 1 && evidence.verified === true && evidence.directory === 'frontend/office-word', 'installed resource verification is missing');
  check(typeof evidence.manifestText === 'string' && Buffer.byteLength(evidence.manifestText) <= 16 * 1024
    && SHA256.test(evidence.manifestSha256) && digest(evidence.manifestText) === evidence.manifestSha256, 'manifest digest does not match its exact bytes');
  let manifest;
  try { manifest = JSON.parse(evidence.manifestText); } catch { throw Error('OfficeWord installed manifest is invalid JSON'); }
  check(manifest?.engine === 'Open Office' && manifest.upstreamCommit === UPSTREAM
    && manifest.target === 'wasm32-unknown-unknown' && manifest.wasmBindgenVersion === '0.2.129', 'installed manifest identifies a different engine or bridge');
  check(SHA256.test(manifest.sourceHash) && manifest.sourceHash === sourceHash, 'installed manifest does not match the current checkout source');
  object(manifest.files, 'manifest file inventory'); object(evidence.files, 'installed file inventory');
  assert.deepEqual(Object.keys(manifest.files).sort(), FILES, 'OfficeWord manifest file inventory changed');
  assert.deepEqual(Object.keys(evidence.files).sort(), FILES, 'OfficeWord installed file inventory changed');
  for (const name of FILES) {
    object(evidence.files[name], `installed ${name}`);
    check(SHA256.test(manifest.files[name]) && evidence.files[name].sha256 === manifest.files[name], `installed ${name} digest differs from the manifest`);
    positive(evidence.files[name].bytes, `installed ${name} size`, 256 * 1024 * 1024);
  }
  check(manifest.sizeBytes === evidence.files['office-word_bg.wasm'].bytes, 'installed WASM size differs from the manifest');
  return manifest;
}

/** Always reads the installed frontend tree, never a source/public fallback. */
export function inspectInstalledOfficeWord(resourceRoot, { root = ROOT } = {}) {
  const directory = join(resourceRoot, 'frontend', 'office-word');
  const manifestFile = containedFile(resourceRoot, join(directory, 'manifest.json'), 16 * 1024);
  const manifestText = readFileSync(manifestFile.path, 'utf8');
  const evidence = { schemaVersion: 1, verified: true, directory: 'frontend/office-word', manifestText, manifestSha256: hashFile(manifestFile.path), files: {} };
  for (const name of FILES) {
    const file = containedFile(resourceRoot, join(directory, name), 256 * 1024 * 1024);
    evidence.files[name] = { sha256: hashFile(file.path), bytes: file.bytes };
    if (name === 'office-word_bg.wasm') {
      const descriptor = openSync(file.path, 'r'), header = Buffer.alloc(8);
      try { check(readSync(descriptor, header, 0, 8, 0) === 8 && header.equals(Buffer.from('0061736d01000000', 'hex')), 'installed WASM header is invalid'); }
      finally { closeSync(descriptor); }
    }
  }
  manifestEvidence(evidence, wordSourceHash(root));
  return evidence;
}

function validateRuntimeResources(resources) {
  object(resources, 'runtime resource report');
  check(resources.wasmLoaded === true && resources.sameOrigin === true && resources.wasmPath === '/office-word/office-word_bg.wasm', 'runtime must load the local packaged WASM');
  check(SHA256.test(resources.manifestSha256) && SHA256.test(resources.sourceHash) && resources.upstreamCommit === UPSTREAM, 'runtime resource provenance is missing');
  object(resources.files, 'runtime asset digests');
  assert.deepEqual(Object.keys(resources.files).sort(), RUNTIME_FILES, 'OfficeWord runtime asset inventory differs');
  for (const name of RUNTIME_FILES) {
    object(resources.files[name], `runtime ${name}`);
    check(SHA256.test(resources.files[name].sha256), `runtime ${name} digest is invalid`);
    positive(resources.files[name].bytes, `runtime ${name} size`, 256 * 1024 * 1024);
  }
}

/** Validate installed files without claiming that a runtime-resource probe ran. */
export function validateInstalledOfficeWordEvidence(evidence, { root = ROOT } = {}) {
  return manifestEvidence(evidence, wordSourceHash(root));
}

/** Publication can verify serialized installed evidence against its checkout. */
export function validateNativeOfficeWordEvidence(report, { root = ROOT } = {}) {
  const installed = report?.preflight?.word;
  const manifest = manifestEvidence(installed, wordSourceHash(root));
  const runtime = report?.frontend?.word?.resources;
  validateRuntimeResources(runtime);
  check(runtime.manifestSha256 === installed.manifestSha256 && runtime.sourceHash === manifest.sourceHash
    && runtime.upstreamCommit === manifest.upstreamCommit, 'WebView manifest differs from the independently verified installed manifest');
  for (const name of RUNTIME_FILES) assert.deepEqual(runtime.files[name], installed.files[name], `OfficeWord WebView ${name} differs from the independently verified installed file`);
  return { wordInstalledAssets: true, wordRuntimeAssetDigests: true, wordCheckoutSource: true };
}

function inspectDocx(base64, label) {
  check(typeof base64 === 'string' && base64.length > 0 && base64.length < MAX_DOCX_BASE64
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} DOCX Base64 is missing or invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.length > 100 && bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) && bytes.toString('base64') === base64, `${label} has no canonical DOCX ZIP bytes`);
  const directory = mkdtempSync(join(tmpdir(), 'open-office-office-word-docx-'));
  let result;
  try {
    const path = join(directory, 'export.docx'); writeFileSync(path, bytes, { flag: 'wx' });
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    result = spawnSync(python, [join(ROOT, 'scripts', 'office-word-smoke-docx.py'), path], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  check(!result.error && result.status === 0 && !result.signal,
    `${label} independent DOCX verification failed: ${String(result.stderr || result.error?.message || 'invalid ZIP/XML').trim().slice(0, 500)}`);
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { throw Error(`OfficeWord ${label} independent DOCX evidence is invalid JSON`); }
  check(evidence.text === OFFICE_WORD_SMOKE_TEXT, `${label} independent DOCX text differs`);
  assert.deepEqual(evidence.format, FORMAT, `OfficeWord ${label} independent DOCX formatting differs`);
  return evidence;
}

export function validateOfficeWordNativeReport(report) {
  object(report, 'native canvas report');
  check(report.schemaVersion === 1 && report.kind === 'office-word-native' && report.ok === true, 'native canvas checks failed');
  check(report.engine === 'office-word-wasm' && report.transport === 'local-wasm-in-native-webview', 'default canvas must use local WASM in the native WebView');
  assert.deepEqual(report.checks, [...REQUIRED_OFFICE_WORD_CHECKS], 'OfficeWord requires all six ordered canvas checks');
  assert.deepEqual(report.limitations, [...OFFICE_WORD_SMOKE_LIMITATIONS], 'OfficeWord native smoke must disclose its synthetic-input and file-dialog limits');
  assert.deepEqual(report.cleanup, { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 }, 'OfficeWord did not clean up both sessions and its renderer');
  check(report.error === undefined && report.closeError === undefined, 'native smoke reported an operation or cleanup error');
  object(report.canvas, 'canvas observations');
  for (const name of ['width', 'height', 'pageCount', 'paintCalls']) positive(report.canvas[name], `canvas ${name}`);
  check(report.canvas.width > 100 && report.canvas.height > 100, 'default canvas was not visible');
  assert.deepEqual(report.domInput, { eventType: 'input', isTrusted: false, text: OFFICE_WORD_SMOKE_TEXT, accepted: true }, 'OfficeWord DOM input evidence differs');
  assert.deepEqual(report.format, FORMAT, 'OfficeWord active character formatting differs');
  assert.deepEqual(report.failures, { staleSaveRejected: true, invalidOpenRejected: true, preserved: true }, 'OfficeWord did not preserve the document on failed operations');
  check(report.text === OFFICE_WORD_SMOKE_TEXT && report.reopenedText === OFFICE_WORD_SMOKE_TEXT, 'text did not survive export/reopen');
  validateRuntimeResources(report.resources);
  return { exported: inspectDocx(report.docxBase64, 'export'), reopened: inspectDocx(report.reopenedDocxBase64, 'reopen') };
}
