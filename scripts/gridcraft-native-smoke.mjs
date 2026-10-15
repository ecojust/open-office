import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_XLSX_BASE64 = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UPSTREAM = 'e6b6b349708ab4978cb3f061f6bd6ecbc25667cb';
const FILES = ['gridcraft.d.ts', 'gridcraft.js', 'gridcraft_bg.wasm', 'gridcraft_bg.wasm.d.ts'];
const RUNTIME_FILES = ['gridcraft.js', 'gridcraft_bg.wasm'];
export const GRIDCRAFT_SMOKE_TEXT = 'Open Office 表格😀';
export const REQUIRED_GRIDCRAFT_CHECKS = Object.freeze([
  'default-mounted-local-wasm-canvas-painted',
  'synthetic-dom-input-chinese-emoji',
  'rust-formulas-and-cell-formatting',
  'xlsx-export-and-save-receipt',
  'stale-save-and-invalid-open-preserve-active-document',
  'saved-xlsx-reopened-in-default-editor',
]);
export const GRIDCRAFT_SMOKE_LIMITATIONS = Object.freeze([
  'Synthetic WebView input events are not a physical operating-system IME.',
  'Save checks cover exported XLSX bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.',
]);
const FORMAT = { bold: true };
const FORMULA = { input: '=SUM(B1:B2)', value: 42, inputs: [12, 30] };
const check = (value, message) => assert.ok(value, `GridCraft ${message}`);
const digest = value => createHash('sha256').update(value).digest('hex');
function object(value, label) { check(value && typeof value === 'object' && !Array.isArray(value), `${label} is missing`); }
function positive(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} is invalid`);
}

/** Match the build script's path+NUL+bytes+NUL fingerprint without executing a build. */
export function gridcraftSourceHash(root = ROOT) {
  const files = ['scripts/build-gridcraft.mjs', 'scripts/build-office-icons.mjs'];
  function collect(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (['target', '.git'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  collect('vendor/gridcraft'); collect('assets/fonts/open-office'); collect('src/icons');
  check(files.some(name => name.startsWith('vendor/gridcraft/'))
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
  check(evidence.schemaVersion === 1 && evidence.verified === true && evidence.directory === 'frontend/gridcraft', 'installed resource verification is missing');
  check(typeof evidence.manifestText === 'string' && Buffer.byteLength(evidence.manifestText) <= 16 * 1024
    && SHA256.test(evidence.manifestSha256) && digest(evidence.manifestText) === evidence.manifestSha256, 'manifest digest does not match its exact bytes');
  let manifest;
  try { manifest = JSON.parse(evidence.manifestText); } catch { throw Error('GridCraft installed manifest is invalid JSON'); }
  check(manifest?.engine === 'GridCraft' && manifest.upstreamCommit === UPSTREAM
    && manifest.target === 'wasm32-unknown-unknown' && manifest.wasmBindgenVersion === '0.2.129', 'installed manifest identifies a different engine or bridge');
  check(SHA256.test(manifest.sourceHash) && manifest.sourceHash === sourceHash, 'installed manifest does not match the current checkout source');
  object(manifest.files, 'manifest file inventory'); object(evidence.files, 'installed file inventory');
  assert.deepEqual(Object.keys(manifest.files).sort(), FILES, 'GridCraft manifest file inventory changed');
  assert.deepEqual(Object.keys(evidence.files).sort(), FILES, 'GridCraft installed file inventory changed');
  for (const name of FILES) {
    object(evidence.files[name], `installed ${name}`);
    check(SHA256.test(manifest.files[name]) && evidence.files[name].sha256 === manifest.files[name], `installed ${name} digest differs from the manifest`);
    positive(evidence.files[name].bytes, `installed ${name} size`, 256 * 1024 * 1024);
  }
  check(manifest.sizeBytes === evidence.files['gridcraft_bg.wasm'].bytes, 'installed WASM size differs from the manifest');
  return manifest;
}

/** Always reads the installed frontend tree, never a source/public fallback. */
export function inspectInstalledGridcraft(resourceRoot, { root = ROOT } = {}) {
  const directory = join(resourceRoot, 'frontend', 'gridcraft');
  const manifestFile = containedFile(resourceRoot, join(directory, 'manifest.json'), 16 * 1024);
  const manifestText = readFileSync(manifestFile.path, 'utf8');
  const evidence = { schemaVersion: 1, verified: true, directory: 'frontend/gridcraft', manifestText, manifestSha256: hashFile(manifestFile.path), files: {} };
  for (const name of FILES) {
    const file = containedFile(resourceRoot, join(directory, name), 256 * 1024 * 1024);
    evidence.files[name] = { sha256: hashFile(file.path), bytes: file.bytes };
    if (name === 'gridcraft_bg.wasm') {
      const descriptor = openSync(file.path, 'r'), header = Buffer.alloc(8);
      try { check(readSync(descriptor, header, 0, 8, 0) === 8 && header.equals(Buffer.from('0061736d01000000', 'hex')), 'installed WASM header is invalid'); }
      finally { closeSync(descriptor); }
    }
  }
  manifestEvidence(evidence, gridcraftSourceHash(root));
  return evidence;
}

function validateRuntimeResources(resources) {
  object(resources, 'runtime resource report');
  check(resources.wasmLoaded === true && resources.sameOrigin === true && resources.wasmPath === '/gridcraft/gridcraft_bg.wasm', 'runtime must load the local packaged WASM');
  check(SHA256.test(resources.manifestSha256) && SHA256.test(resources.sourceHash) && resources.upstreamCommit === UPSTREAM, 'runtime resource provenance is missing');
  object(resources.files, 'runtime asset digests');
  assert.deepEqual(Object.keys(resources.files).sort(), RUNTIME_FILES, 'GridCraft runtime asset inventory differs');
  for (const name of RUNTIME_FILES) {
    object(resources.files[name], `runtime ${name}`);
    check(SHA256.test(resources.files[name].sha256), `runtime ${name} digest is invalid`);
    positive(resources.files[name].bytes, `runtime ${name} size`, 256 * 1024 * 1024);
  }
}

/** Publication can verify serialized installed evidence against its checkout. */
export function validateNativeGridcraftEvidence(report, { root = ROOT } = {}) {
  const installed = report?.preflight?.gridcraft;
  const manifest = manifestEvidence(installed, gridcraftSourceHash(root));
  const runtime = report?.frontend?.gridcraft?.resources;
  validateRuntimeResources(runtime);
  check(runtime.manifestSha256 === installed.manifestSha256 && runtime.sourceHash === manifest.sourceHash
    && runtime.upstreamCommit === manifest.upstreamCommit, 'WebView manifest differs from the independently verified installed manifest');
  for (const name of RUNTIME_FILES) assert.deepEqual(runtime.files[name], installed.files[name], `GridCraft WebView ${name} differs from the independently verified installed file`);
  return { gridcraftInstalledAssets: true, gridcraftRuntimeAssetDigests: true, gridcraftCheckoutSource: true };
}

function inspectXlsx(base64, label) {
  check(typeof base64 === 'string' && base64.length > 0 && base64.length < MAX_XLSX_BASE64
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} XLSX Base64 is missing or invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.length > 100 && bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) && bytes.toString('base64') === base64, `${label} has no canonical XLSX ZIP bytes`);
  const directory = mkdtempSync(join(tmpdir(), 'open-office-gridcraft-xlsx-'));
  let result;
  try {
    const path = join(directory, 'export.xlsx'); writeFileSync(path, bytes, { flag: 'wx' });
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    result = spawnSync(python, [join(ROOT, 'tests', 'browser', 'gridcraft-inspect-xlsx.py'), path], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  check(!result.error && result.status === 0 && !result.signal,
    `${label} independent XLSX verification failed: ${String(result.stderr || result.error?.message || 'invalid ZIP/XML').trim().slice(0, 500)}`);
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { throw Error(`GridCraft ${label} independent XLSX evidence is invalid JSON`); }
  check(Array.isArray(evidence.sheets) && evidence.sheets.length === 1, `${label} XLSX must contain the original sheet`);
  const cells = evidence.sheets[0].cells;
  check(cells?.A1?.value === GRIDCRAFT_SMOKE_TEXT && cells.A1.style?.bold === true, `${label} independent XLSX text or bold formatting differs`);
  check(cells.B1?.value === 12 && cells.B2?.value === 30 && cells.C1?.formula === FORMULA.input && cells.C1?.value === FORMULA.value, `${label} independent XLSX formula, inputs or cached value differs`);
  check(!cells.D1 || cells.D1.value === null || cells.D1.value === '', `${label} includes changes made after the save receipt`);
  return evidence;
}

/** A browser report is useful diagnostically but can never satisfy this gate. */
export function validateGridcraftNativeReport(report) {
  object(report, 'native canvas report');
  check(report.schemaVersion === 1 && report.kind === 'gridcraft-native' && report.ok === true, 'native canvas checks failed');
  check(report.engine === 'gridcraft-wasm' && report.transport === 'local-wasm-in-native-webview', 'default canvas must use local WASM in the native WebView');
  assert.deepEqual(report.checks, [...REQUIRED_GRIDCRAFT_CHECKS], 'GridCraft requires all six ordered canvas checks');
  assert.deepEqual(report.limitations, [...GRIDCRAFT_SMOKE_LIMITATIONS], 'GridCraft native smoke must disclose its synthetic-input and file-dialog limits');
  assert.deepEqual(report.cleanup, { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 }, 'GridCraft did not clean up both sessions and its renderer');
  check(report.error === undefined && report.closeError === undefined, 'native smoke reported an operation or cleanup error');
  object(report.canvas, 'canvas observations');
  for (const name of ['width', 'height', 'sheetCount', 'paintCalls']) positive(report.canvas[name], `canvas ${name}`);
  check(report.canvas.width > 100 && report.canvas.height > 100, 'default canvas was not visible');
  assert.deepEqual(report.domInput, { eventType: 'input', isTrusted: false, text: GRIDCRAFT_SMOKE_TEXT, accepted: true }, 'GridCraft DOM input evidence differs');
  assert.deepEqual(report.format, FORMAT, 'GridCraft active cell formatting differs');
  assert.deepEqual(report.formula, FORMULA, 'GridCraft formula evidence differs');
  assert.deepEqual(report.failures, { staleSaveRejected: true, invalidOpenRejected: true, preserved: true }, 'GridCraft did not preserve the workbook on failed operations');
  check(report.text === GRIDCRAFT_SMOKE_TEXT && report.reopenedText === GRIDCRAFT_SMOKE_TEXT, 'text did not survive export/reopen');
  validateRuntimeResources(report.resources);
  return { exported: inspectXlsx(report.xlsxBase64, 'export'), reopened: inspectXlsx(report.reopenedXlsxBase64, 'reopen') };
}
