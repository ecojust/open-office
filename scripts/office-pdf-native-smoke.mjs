import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/;
const UPSTREAM = 'f65f7330418e8121ebe59c01003da899340ceee9';
const FILES = ['office_pdf.d.ts', 'office_pdf.js', 'office_pdf_bg.wasm', 'office_pdf_bg.wasm.d.ts'];
const RUNTIME_FILES = ['office_pdf.js', 'office_pdf_bg.wasm'];
const check = (value, message) => assert.ok(value, `Open Office PDF ${message}`);
const digest = value => createHash('sha256').update(value).digest('hex');
function object(value, label) { check(value && typeof value === 'object' && !Array.isArray(value), `${label} is missing`); }
function positive(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} is invalid`);
}

/** Match the build script's path+NUL+bytes+NUL fingerprint without executing a build. */
export function pdfSourceHash(root = ROOT) {
  const files = ['scripts/build-office-pdf.mjs', 'scripts/build-office-icons.mjs'];
  function collect(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (['target', '.git'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  collect('vendor/office-pdf'); collect('assets/fonts/open-office'); collect('assets/fonts/deck'); collect('src/icons');
  check(files.some(name => name.startsWith('vendor/office-pdf/'))
    && files.some(name => name.startsWith('assets/fonts/open-office/'))
    && files.some(name => name.startsWith('assets/fonts/deck/')), 'source and licensed fonts are required');
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
  check(evidence.schemaVersion === 1 && evidence.verified === true && evidence.directory === 'frontend/office-pdf', 'installed resource verification is missing');
  check(typeof evidence.manifestText === 'string' && Buffer.byteLength(evidence.manifestText) <= 16 * 1024
    && SHA256.test(evidence.manifestSha256) && digest(evidence.manifestText) === evidence.manifestSha256, 'manifest digest does not match its exact bytes');
  let manifest;
  try { manifest = JSON.parse(evidence.manifestText); } catch { throw Error('Open Office PDF installed manifest is invalid JSON'); }
  check(manifest?.engine === 'Open Office PDF' && manifest.upstreamCommit === UPSTREAM
    && manifest.target === 'wasm32-unknown-unknown' && manifest.wasmBindgenVersion === '0.2.129', 'installed manifest identifies a different engine or bridge');
  check(SHA256.test(manifest.sourceHash) && manifest.sourceHash === sourceHash, 'installed manifest does not match the current checkout source');
  object(manifest.files, 'manifest file inventory'); object(evidence.files, 'installed file inventory');
  assert.deepEqual(Object.keys(manifest.files).sort(), FILES, 'Open Office PDF manifest file inventory changed');
  assert.deepEqual(Object.keys(evidence.files).sort(), FILES, 'Open Office PDF installed file inventory changed');
  for (const name of FILES) {
    object(evidence.files[name], `installed ${name}`);
    check(SHA256.test(manifest.files[name]) && evidence.files[name].sha256 === manifest.files[name], `installed ${name} digest differs from the manifest`);
    positive(evidence.files[name].bytes, `installed ${name} size`, 256 * 1024 * 1024);
  }
  check(manifest.sizeBytes === evidence.files['office_pdf_bg.wasm'].bytes, 'installed WASM size differs from the manifest');
  return manifest;
}

/** Always reads the installed frontend tree, never a source/public fallback. */
export function inspectInstalledPdf(resourceRoot, { root = ROOT } = {}) {
  const directory = join(resourceRoot, 'frontend', 'office-pdf');
  const manifestFile = containedFile(resourceRoot, join(directory, 'manifest.json'), 16 * 1024);
  const manifestText = readFileSync(manifestFile.path, 'utf8');
  const evidence = { schemaVersion: 1, verified: true, directory: 'frontend/office-pdf', manifestText, manifestSha256: hashFile(manifestFile.path), files: {} };
  for (const name of FILES) {
    const file = containedFile(resourceRoot, join(directory, name), 256 * 1024 * 1024);
    evidence.files[name] = { sha256: hashFile(file.path), bytes: file.bytes };
    if (name === 'office_pdf_bg.wasm') {
      const descriptor = openSync(file.path, 'r'), header = Buffer.alloc(8);
      try { check(readSync(descriptor, header, 0, 8, 0) === 8 && header.equals(Buffer.from('0061736d01000000', 'hex')), 'installed WASM header is invalid'); }
      finally { closeSync(descriptor); }
    }
  }
  manifestEvidence(evidence, pdfSourceHash(root));
  return evidence;
}

function validateRuntimeResources(resources) {
  object(resources, 'runtime resource report');
  check(resources.wasmLoaded === true && resources.sameOrigin === true && resources.wasmPath === '/office-pdf/office_pdf_bg.wasm', 'runtime must load the local packaged WASM');
  check(SHA256.test(resources.manifestSha256) && SHA256.test(resources.sourceHash) && resources.upstreamCommit === UPSTREAM, 'runtime resource provenance is missing');
  object(resources.files, 'runtime asset digests');
  assert.deepEqual(Object.keys(resources.files).sort(), RUNTIME_FILES, 'Open Office PDF runtime asset inventory differs');
  for (const name of RUNTIME_FILES) {
    object(resources.files[name], `runtime ${name}`);
    check(SHA256.test(resources.files[name].sha256), `runtime ${name} digest is invalid`);
    positive(resources.files[name].bytes, `runtime ${name} size`, 256 * 1024 * 1024);
  }
}

export function validateInstalledPdfEvidence(evidence, { root = ROOT } = {}) {
  return manifestEvidence(evidence, pdfSourceHash(root));
}

/** Publication can verify serialized installed evidence against its checkout. */
export function validateNativePdfEvidence(report, { root = ROOT } = {}) {
  const installed = report?.preflight?.pdf;
  const manifest = manifestEvidence(installed, pdfSourceHash(root));
  const runtime = report?.frontend?.pdf?.resources;
  validateRuntimeResources(runtime);
  check(runtime.manifestSha256 === installed.manifestSha256 && runtime.sourceHash === manifest.sourceHash
    && runtime.upstreamCommit === manifest.upstreamCommit, 'WebView manifest differs from the independently verified installed manifest');
  for (const name of RUNTIME_FILES) assert.deepEqual(runtime.files[name], installed.files[name], `Open Office PDF WebView ${name} differs from the independently verified installed file`);
  return { pdfInstalledAssets: true, pdfRuntimeAssetDigests: true, pdfCheckoutSource: true };
}

export const REQUIRED_OFFICE_PDF_CHECKS = Object.freeze([
  'default-mounted-local-wasm-canvas-painted',
  'packaged-pdf-wasm-manifest-verified',
  'pdf-content-insert-and-replace',
  'stale-save-receipt-rejected',
  'undo-redo-preserves-real-text',
  'pdf-export-reopened',
  'two-live-pdf-sessions',
  'reopened-content-editable',
  'invalid-open-preserves-active-session',
  'session-cleanup-complete',
]);
export const PDF_SMOKE_LIMITATIONS = Object.freeze([
  'PDF edit checks use the mounted editor command interface; they are not physical keyboard or IME input.',
  'Save checks cover exported PDF bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.',
]);
function replacementText(text, label) {
  check(typeof text === 'string' && text.includes('NEW_NATIVE_TEXT') && text.includes('新的合同')
    && !text.includes('OLD_NATIVE_TEXT') && !text.includes('旧合同'), `${label} does not contain the actual replaced text`);
}
function inspectPdf(base64, label) {
  check(typeof base64 === 'string' && base64.length > 0 && base64.length <= 4 * 1024 * 1024
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} Base64 is missing or invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.length > 100 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    && bytes.toString('base64') === base64, `${label} has no canonical PDF bytes`);
  const directory = mkdtempSync(join(tmpdir(), 'open-office-pdf-readback-'));
  let result;
  try {
    const path = join(directory, 'export.pdf'); writeFileSync(path, bytes, { flag: 'wx' });
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    // This independent test-only parser is not shipped with the application.
    result = spawnSync(python, [join(ROOT, 'scripts', 'office-presentation-inspect-presentation.py'), path], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  check(!result.error && result.status === 0 && !result.signal,
    `${label} independent inspection failed: ${String(result.stderr || result.error?.message || 'invalid document').trim().slice(0, 500)}`);
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { throw Error(`Open Office PDF ${label} independent evidence is invalid JSON`); }
  check(Array.isArray(evidence.pages) && evidence.pages.length === 1, `${label} independent page count differs`);
  const page = evidence.pages[0];
  replacementText(page?.text, `${label} independent readback`);
  check(Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0, `${label} page dimensions are invalid`);
  return evidence;
}

/** Browser verification may reuse the independent parser without claiming native execution. */
export function inspectOfficePdfExports(report) {
  object(report, 'export report');
  return { exported: inspectPdf(report.pdfBase64, 'export'), reopened: inspectPdf(report.reopenedPdfBase64, 'reopen') };
}

/** Require actual mounted editing and exported bytes, not isolated command success. */
export function validatePdfNativeReport(report) {
  object(report, 'native canvas report');
  check(report.schemaVersion === 1 && report.kind === 'pdf-native' && report.ok === true, 'native canvas checks failed');
  check(report.engine === 'office-pdf-wasm' && report.transport === 'local-wasm-in-native-webview', 'default canvas must use local WASM in the native WebView');
  assert.deepEqual(report.checks, [...REQUIRED_OFFICE_PDF_CHECKS], 'Open Office PDF requires all ordered editor checks');
  assert.deepEqual(report.limitations, [...PDF_SMOKE_LIMITATIONS], 'Open Office PDF must disclose command-input and file-dialog limits');
  assert.deepEqual(report.cleanup, { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 }, 'Open Office PDF did not clean up both sessions and renderer');
  check(report.error === undefined && report.closeError === undefined, 'native smoke reported an operation or cleanup error');
  object(report.canvas, 'canvas observations');
  for (const name of ['width', 'height', 'pageCount', 'paintCalls']) positive(report.canvas[name], `canvas ${name}`);
  check(report.canvas.width > 100 && report.canvas.height > 100 && report.canvas.pageCount === 1, 'default canvas was not visible with its page');
  assert.deepEqual(report.undoRedo, { undo: true, redo: true }, 'Open Office PDF undo/redo failed');
  assert.deepEqual(report.failures, { staleSaveRejected: true, invalidOpenRejected: true, preserved: true }, 'Open Office PDF did not preserve the document on failed operations');
  check(report.reopened === true && report.removedOldText === true && report.newTextPresent === true, 'content replacement or reopened editing failed');
  check(report.metadata?.pageCount === 1, 'round-trip page count is incorrect');
  replacementText(report.text, 'reopened text');
  validateRuntimeResources(report.resources);
  return inspectOfficePdfExports(report);
}
