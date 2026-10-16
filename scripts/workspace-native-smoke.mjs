import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_NATIVE_CHECKS = Object.freeze([
  'real-autosave-timer-writes-approved-temporary-file',
  'saved-file-readback-reopened-in-rust',
  'native-temporary-file-and-session-cleanup',
]);
export const WORKSPACE_NATIVE_LIMITATIONS = Object.freeze([
  'The temporary file capability is provisioned by a smoke-only native command; native file chooser interaction is not covered.',
  'Text edits use the real Rust command interface; physical keyboard input and operating-system IME are not covered.',
]);
export const WORKSPACE_BASELINE_TEXT = 'NATIVE_AUTOSAVE_BASE 中文';
export const WORKSPACE_SAVED_TEXT = `${WORKSPACE_BASELINE_TEXT} NATIVE_AUTOSAVE_EDIT 已保存`;

const check = (value, message) => assert.ok(value, `Native workspace: ${message}`);
const object = (value, label) => check(value && typeof value === 'object' && !Array.isArray(value), `missing ${label}`);
const integer = (value, label, minimum = 0) => check(Number.isSafeInteger(value) && value >= minimum, `invalid ${label}`);
const hash = (value, label) => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `invalid ${label} SHA-256`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function documentBytes(base64, expectedHash, expectedSize, label) {
  hash(expectedHash, label);
  integer(expectedSize, `${label} size`, 101);
  check(expectedSize <= 1024 * 1024, `${label} exceeds the small smoke specimen bound`);
  check(typeof base64 === 'string' && base64.length <= 1_398_104
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} Base64 is invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.toString('base64') === base64 && bytes.length === expectedSize && sha256(bytes) === expectedHash, `${label} bytes do not match the recorded hash and size`);
  check(bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')), `${label} format signature differs`);
  return bytes;
}

function inspectSavedDocx(bytes, expectedText, label) {
  const directory = mkdtempSync(join(tmpdir(), 'open-office-workspace-docx-'));
  let result;
  try {
    const path = join(directory, 'document.docx');
    writeFileSync(path, bytes, { flag: 'wx' });
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    result = spawnSync(python, [join(dirname(fileURLToPath(import.meta.url)), 'workspace-smoke-docx.py'), path], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  check(!result.error && result.status === 0 && !result.signal,
    `${label} independent DOCX verification failed: ${String(result.stderr || result.error?.message || 'invalid document').trim().slice(0, 500)}`);
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { throw Error(`Native workspace: ${label} DOCX evidence is invalid JSON`); }
  check(evidence.text === expectedText, `${label} independent DOCX text differs`);
  return evidence;
}

/** Current publication policy also validates reports produced by older commits. */
export function validateNativeWorkspaceReport(report) {
  object(report, 'native autosave report');
  check(report.schemaVersion === 2 && report.kind === 'workspace-native' && report.ok === true, 'native autosave acceptance did not pass');
  check(report.transport === 'native-webview-ipc', 'requires the installed native WebView and IPC');
  object(report.native, 'native WebView identity');
  check(report.native.tauri === true, 'native IPC was not available');
  let origin;
  try { origin = new URL(report.native.origin); } catch { throw Error('Native workspace: invalid native WebView origin'); }
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Number(origin.port) > 0
    && origin.origin === report.native.origin, 'not the native app loopback origin');
  assert.deepEqual(report.checks, [...WORKSPACE_NATIVE_CHECKS], 'Native workspace: missing ordered acceptance checks');
  assert.deepEqual(report.limitations, [...WORKSPACE_NATIVE_LIMITATIONS], 'Native workspace: disclose the native chooser and OS input limits');
  check(report.error === undefined && report.cleanupError === undefined, 'operation or cleanup failed');

  const autosave = report.autosave; object(autosave, 'real autosave observations');
  check(autosave.intervalMs === 30_000 && Number.isSafeInteger(autosave.elapsedMs) && autosave.elapsedMs >= 30_000 && autosave.elapsedMs <= 50_000,
    'autosave must use the ordinary 30-second timer within its bounded wait');
  check(typeof autosave.targetId === 'string' && autosave.targetId.length > 0 && autosave.targetId.length <= 256, 'missing approved native file identity');
  const baselineBytes = documentBytes(autosave.initialBase64, autosave.initialSha256, autosave.initialSizeBytes, 'approved initial file');
  check(autosave.finalSha256 !== autosave.initialSha256, 'autosave did not change the file');
  const saved = documentBytes(autosave.readbackBase64, autosave.finalSha256, autosave.finalSizeBytes, 'autosaved readback');
  integer(autosave.beforeRevision, 'before-save revision', 1);
  check(autosave.afterRevision === autosave.beforeRevision && autosave.beforeDirty === true && autosave.afterDirty === false, 'autosave did not acknowledge the same edited revision');
  check(autosave.focusRetained === true && autosave.blurEvents === 0 && autosave.dialogObserved === false, 'autosave interrupted editor focus or opened a dialog');
  check(autosave.expectedText === WORKSPACE_SAVED_TEXT && autosave.reopenedText === WORKSPACE_SAVED_TEXT, 'Rust reopen lost the autosaved edit');
  check(Array.isArray(autosave.saves) && autosave.saves.length === 1, 'requires exactly one ordinary native save receipt');
  assert.deepEqual(autosave.saves[0], { documentId: autosave.targetId, extension: 'docx', expectedSha256: autosave.initialSha256, saveAs: false,
    status: 'saved', savedId: autosave.targetId, savedSha256: autosave.finalSha256, savedSizeBytes: autosave.finalSizeBytes },
  'Native workspace: save must write the approved file directly and acknowledge its actual bytes');
  assert.deepEqual(report.cleanup, { temporaryFilesRemoved: true, closedDocuments: 2 },
    'Native workspace: temporary-file removal or editor cleanup failed');
  inspectSavedDocx(baselineBytes, WORKSPACE_BASELINE_TEXT, 'initial');
  inspectSavedDocx(saved, WORKSPACE_SAVED_TEXT, 'saved');
  return { workspaceLocalAutosave: true, workspaceSavedFileReadback: true, workspaceSessionCleanup: true };
}
