import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PPTX_BASE64 = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UPSTREAM = '9859da39255c0262cd592bb57101d7f2fa961f72';
const FILES = ['office-presentation.d.ts', 'office-presentation.js', 'office-presentation_bg.wasm', 'office-presentation_bg.wasm.d.ts'];
const RUNTIME_FILES = ['office-presentation.js', 'office-presentation_bg.wasm'];
export const OFFICE_PRESENTATION_SMOKE_TEXT = 'Open Office 演示😀';
export const REQUIRED_OFFICE_PRESENTATION_CHECKS = Object.freeze([
  'default-mounted-local-wasm-canvas-painted',
  'synthetic-dom-input-chinese-emoji',
  'rust-slide-editing-and-text-formatting',
  'pptx-export-and-save-receipt',
  'stale-save-and-invalid-open-preserve-active-document',
  'saved-pptx-reopened-in-default-editor',
  'pdf-export-and-independent-readback',
]);
export const OFFICE_PRESENTATION_SMOKE_LIMITATIONS = Object.freeze([
  'Synthetic WebView input events are not a physical operating-system IME.',
  'Save checks cover exported PPTX bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.',
]);
const FORMAT = { bold: true };
export const OFFICE_PRESENTATION_SECOND_SLIDE_TEXT = 'Second slide 第二页';
const check = (value, message) => assert.ok(value, `OfficePresentation ${message}`);
const digest = value => createHash('sha256').update(value).digest('hex');
function object(value, label) { check(value && typeof value === 'object' && !Array.isArray(value), `${label} is missing`); }
function positive(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} is invalid`);
}

/** Match the build script's path+NUL+bytes+NUL fingerprint without executing a build. */
export function presentationSourceHash(root = ROOT) {
  const files = ['scripts/build-office-presentation.mjs', 'scripts/build-office-icons.mjs'];
  function collect(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (['target', '.git'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  collect('vendor/office-presentation'); collect('assets/fonts/open-office'); collect('assets/fonts/deck'); collect('src/icons');
  check(files.some(name => name.startsWith('vendor/office-presentation/'))
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
  check(evidence.schemaVersion === 1 && evidence.verified === true && evidence.directory === 'frontend/office-presentation', 'installed resource verification is missing');
  check(typeof evidence.manifestText === 'string' && Buffer.byteLength(evidence.manifestText) <= 16 * 1024
    && SHA256.test(evidence.manifestSha256) && digest(evidence.manifestText) === evidence.manifestSha256, 'manifest digest does not match its exact bytes');
  let manifest;
  try { manifest = JSON.parse(evidence.manifestText); } catch { throw Error('OfficePresentation installed manifest is invalid JSON'); }
  check(manifest?.engine === 'Open Office' && manifest.upstreamCommit === UPSTREAM
    && manifest.target === 'wasm32-unknown-unknown' && manifest.wasmBindgenVersion === '0.2.129', 'installed manifest identifies a different engine or bridge');
  check(SHA256.test(manifest.sourceHash) && manifest.sourceHash === sourceHash, 'installed manifest does not match the current checkout source');
  object(manifest.files, 'manifest file inventory'); object(evidence.files, 'installed file inventory');
  assert.deepEqual(Object.keys(manifest.files).sort(), FILES, 'OfficePresentation manifest file inventory changed');
  assert.deepEqual(Object.keys(evidence.files).sort(), FILES, 'OfficePresentation installed file inventory changed');
  for (const name of FILES) {
    object(evidence.files[name], `installed ${name}`);
    check(SHA256.test(manifest.files[name]) && evidence.files[name].sha256 === manifest.files[name], `installed ${name} digest differs from the manifest`);
    positive(evidence.files[name].bytes, `installed ${name} size`, 256 * 1024 * 1024);
  }
  check(manifest.sizeBytes === evidence.files['office-presentation_bg.wasm'].bytes, 'installed WASM size differs from the manifest');
  return manifest;
}

/** Always reads the installed frontend tree, never a source/public fallback. */
export function inspectInstalledOfficePresentation(resourceRoot, { root = ROOT } = {}) {
  const directory = join(resourceRoot, 'frontend', 'office-presentation');
  const manifestFile = containedFile(resourceRoot, join(directory, 'manifest.json'), 16 * 1024);
  const manifestText = readFileSync(manifestFile.path, 'utf8');
  const evidence = { schemaVersion: 1, verified: true, directory: 'frontend/office-presentation', manifestText, manifestSha256: hashFile(manifestFile.path), files: {} };
  for (const name of FILES) {
    const file = containedFile(resourceRoot, join(directory, name), 256 * 1024 * 1024);
    evidence.files[name] = { sha256: hashFile(file.path), bytes: file.bytes };
    if (name === 'office-presentation_bg.wasm') {
      const descriptor = openSync(file.path, 'r'), header = Buffer.alloc(8);
      try { check(readSync(descriptor, header, 0, 8, 0) === 8 && header.equals(Buffer.from('0061736d01000000', 'hex')), 'installed WASM header is invalid'); }
      finally { closeSync(descriptor); }
    }
  }
  manifestEvidence(evidence, presentationSourceHash(root));
  return evidence;
}

function validateRuntimeResources(resources) {
  object(resources, 'runtime resource report');
  check(resources.wasmLoaded === true && resources.sameOrigin === true && resources.wasmPath === '/office-presentation/office-presentation_bg.wasm', 'runtime must load the local packaged WASM');
  check(SHA256.test(resources.manifestSha256) && SHA256.test(resources.sourceHash) && resources.upstreamCommit === UPSTREAM, 'runtime resource provenance is missing');
  object(resources.files, 'runtime asset digests');
  assert.deepEqual(Object.keys(resources.files).sort(), RUNTIME_FILES, 'OfficePresentation runtime asset inventory differs');
  for (const name of RUNTIME_FILES) {
    object(resources.files[name], `runtime ${name}`);
    check(SHA256.test(resources.files[name].sha256), `runtime ${name} digest is invalid`);
    positive(resources.files[name].bytes, `runtime ${name} size`, 256 * 1024 * 1024);
  }
}

/** Publication can verify serialized installed evidence against its checkout. */
export function validateNativeOfficePresentationEvidence(report, { root = ROOT } = {}) {
  const installed = report?.preflight?.presentation;
  const manifest = manifestEvidence(installed, presentationSourceHash(root));
  const runtime = report?.frontend?.presentation?.resources;
  validateRuntimeResources(runtime);
  check(runtime.manifestSha256 === installed.manifestSha256 && runtime.sourceHash === manifest.sourceHash
    && runtime.upstreamCommit === manifest.upstreamCommit, 'WebView manifest differs from the independently verified installed manifest');
  for (const name of RUNTIME_FILES) assert.deepEqual(runtime.files[name], installed.files[name], `OfficePresentation WebView ${name} differs from the independently verified installed file`);
  return { presentationInstalledAssets: true, presentationRuntimeAssetDigests: true, presentationCheckoutSource: true };
}


function exportedBytes(base64, label, maximum, signature) {
  check(typeof base64 === 'string' && base64.length > 0 && base64.length < maximum
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} Base64 is missing or invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.length > 100 && bytes.subarray(0, signature.length).equals(signature) && bytes.toString('base64') === base64, `${label} has no canonical document bytes`);
  return bytes;
}
function inspectDocument(base64, extension, label) {
  const bytes = exportedBytes(base64, label, extension === 'pdf' ? 8 * 1024 * 1024 : MAX_PPTX_BASE64,
    extension === 'pdf' ? Buffer.from('%PDF-') : Buffer.from('504b0304', 'hex'));
  const directory = mkdtempSync(join(tmpdir(), 'open-office-office-presentation-readback-'));
  let result;
  try {
    const path = join(directory, `export.${extension}`); writeFileSync(path, bytes, { flag: 'wx' });
    // This external inspector is a test dependency, never an application runtime.
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    result = spawnSync(python, [join(ROOT, 'scripts', 'office-presentation-inspect-presentation.py'), path], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  check(!result.error && result.status === 0 && !result.signal,
    `${label} independent inspection failed: ${String(result.stderr || result.error?.message || 'invalid document').trim().slice(0, 500)}`);
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { throw Error(`OfficePresentation ${label} independent evidence is invalid JSON`); }
  return evidence;
}
function inspectPptx(base64, label) {
  const evidence = inspectDocument(base64, 'pptx', label);
  check(Array.isArray(evidence.slides) && evidence.slides.length === 2, `${label} PPTX must preserve both slides`);
  check(evidence.slides[0].text.trim() === OFFICE_PRESENTATION_SMOKE_TEXT
    && evidence.slides[1].text.trim() === OFFICE_PRESENTATION_SECOND_SLIDE_TEXT, `${label} PPTX text or slide order differs`);
  const runs = evidence.slides[0].runs.filter(run => run.text);
  check(runs.length > 0 && runs.every(run => run.bold === true), `${label} PPTX bold formatting differs`);
  return evidence;
}
function inspectPdf(base64) {
  const evidence = inspectDocument(base64, 'pdf', 'PDF export');
  check(Array.isArray(evidence.pages) && evidence.pages.length === 2, 'PDF must preserve both slide pages');
  for (const [index, fragments] of [['OpenOffice', '演示'], ['Secondslide', '第二页']].entries()) {
    const page = evidence.pages[index];
    check(typeof page.text === 'string' && fragments.every(fragment => page.text.replace(/\s/g, '').includes(fragment)), 'PDF independent text readback differs');
    check(Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0, 'PDF page dimensions are invalid');
  }
  return evidence;
}

/** Export validation is also reusable by browser tests, without granting native
 * transport acceptance or installed-asset provenance to browser execution. */
export function inspectOfficePresentationExports(report) {
  object(report, 'export report');
  return { exported: inspectPptx(report.pptxBase64, 'export'), reopened: inspectPptx(report.reopenedPptxBase64, 'reopen'), pdf: inspectPdf(report.pdfBase64) };
}

/** Success flags cannot substitute for actual canvas, export and reopen bytes. */
export function validateOfficePresentationNativeReport(report) {
  object(report, 'native canvas report');
  check(report.schemaVersion === 1 && report.kind === 'office-presentation-native' && report.ok === true, 'native canvas checks failed');
  check(report.engine === 'office-presentation-wasm' && report.transport === 'local-wasm-in-native-webview', 'default canvas must use local WASM in the native WebView');
  assert.deepEqual(report.checks, [...REQUIRED_OFFICE_PRESENTATION_CHECKS], 'OfficePresentation requires all seven ordered canvas checks');
  assert.deepEqual(report.limitations, [...OFFICE_PRESENTATION_SMOKE_LIMITATIONS], 'OfficePresentation native smoke must disclose its synthetic-input and file-dialog limits');
  assert.deepEqual(report.cleanup, { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 }, 'OfficePresentation did not clean up both sessions and its renderer');
  check(report.error === undefined && report.closeError === undefined, 'native smoke reported an operation or cleanup error');
  object(report.canvas, 'canvas observations');
  for (const name of ['width', 'height', 'slideCount', 'paintCalls']) positive(report.canvas[name], `canvas ${name}`);
  check(report.canvas.width > 100 && report.canvas.height > 100 && report.canvas.slideCount === 2, 'default canvas was not visible with both slides');
  assert.deepEqual(report.domInput, { eventType: 'input', isTrusted: false, text: OFFICE_PRESENTATION_SMOKE_TEXT, accepted: true }, 'OfficePresentation DOM input evidence differs');
  assert.deepEqual(report.format, FORMAT, 'OfficePresentation active text formatting differs');
  assert.deepEqual(report.slides, { count: 2, activeIndex: 0 }, 'OfficePresentation slide order or active slide differs');
  assert.deepEqual(report.failures, { staleSaveRejected: true, invalidOpenRejected: true, preserved: true }, 'OfficePresentation did not preserve the presentation on failed operations');
  check(report.text === OFFICE_PRESENTATION_SMOKE_TEXT && report.reopenedText === OFFICE_PRESENTATION_SMOKE_TEXT
    && report.secondSlideText === OFFICE_PRESENTATION_SECOND_SLIDE_TEXT, 'text did not survive export/reopen');
  assert.deepEqual(report.pdf, { pageCount: 2, textVerified: true }, 'OfficePresentation native PDF backend readback is missing');
  validateRuntimeResources(report.resources);
  return inspectOfficePresentationExports(report);
}
