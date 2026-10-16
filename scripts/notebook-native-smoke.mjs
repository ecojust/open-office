import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const NOTEBOOK_NATIVE_CHECKS = Object.freeze([
  'mounted-notebook-dom-input',
  'global-save-writes-approved-notebook-file',
  'native-file-readback-reopens-in-new-notebook-session',
  'notebook-tabs-and-editors-closed',
]);
export const NOTEBOOK_NATIVE_LIMITATIONS = Object.freeze([
  'The isolated temporary file is provisioned by a smoke-only native command; system file chooser interaction is not covered.',
  'Editing uses DOM input in the installed native WebView; physical keyboard input and operating-system IME are not covered.',
  'The following workspace autosave check removes the shared native smoke directory and verifies its removal.',
]);
export const NOTEBOOK_PAGE_TITLE = '原生笔记 Native notebook';
export const NOTEBOOK_PAGE_TEXT = 'NATIVE_NOTEBOOK_EDIT 本地保存与重开';
const check = (value, message) => assert.ok(value, `Native notebook: ${message}`);
const integer = (value, label, minimum = 0) => check(Number.isSafeInteger(value) && value >= minimum, `invalid ${label}`);
const object = (value, label) => check(value && typeof value === 'object' && !Array.isArray(value), `missing ${label}`);

function notebookBytes(base64, hash, size, label) {
  check(typeof base64 === 'string' && base64.length > 0 && base64.length <= 65536 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} Base64 invalid`);
  integer(size, `${label} size`, 1);
  check(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), `${label} SHA-256 invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.toString('base64') === base64 && bytes.length === size && createHash('sha256').update(bytes).digest('hex') === hash, `${label} bytes differ`);
  let model;
  try { model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error(`Native notebook: ${label} is not UTF-8 JSON`); }
  object(model, `${label} notebook`);
  const section = model.sections?.[0], page = section?.pages?.[0], block = page?.blocks?.[0];
  check(section && page && block, `${label} notebook structure missing`);
  const ids = [model.id, section.id, page.id, block.id];
  check(ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) && new Set(ids).size === ids.length, `${label} notebook IDs invalid`);
  return model;
}
function snapshot(value, label, dirty) {
  object(value, label); integer(value.documentId, `${label} document ID`, 1); integer(value.revision, `${label} revision`);
  check(value.dirty === dirty, `${label} dirty state differs`);
}

/** Independent JSON/byte checks on the actual native save/readback receipt. */
export function validateNativeNotebookReport(report, workspace) {
  object(report, 'installed notebook report');
  check(report.schemaVersion === 1 && report.kind === 'notebook-native' && report.transport === 'native-webview-ipc' && report.ok === true, 'native acceptance did not pass');
  check(report.native?.tauri === true, 'requires native IPC');
  let origin;
  try { origin = new URL(report.native.origin); } catch { throw Error('Native notebook: invalid origin'); }
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Number(origin.port) > 0 && origin.origin === report.native.origin, 'requires installed WebView origin');
  assert.deepEqual(report.checks, [...NOTEBOOK_NATIVE_CHECKS], 'Native notebook: ordered checks differ');
  assert.deepEqual(report.limitations, [...NOTEBOOK_NATIVE_LIMITATIONS], 'Native notebook: native coverage limits differ');
  check(report.error === undefined && report.cleanupError === undefined, 'operation or cleanup failed');
  const edit = report.editing, persistence = report.persistence, reopened = report.reopened;
  object(edit, 'DOM edit'); object(persistence, 'native persistence'); object(reopened, 'reopened notebook');
  check(edit.title === NOTEBOOK_PAGE_TITLE && edit.text === NOTEBOOK_PAGE_TEXT, 'DOM text differs');
  integer(edit.titleInputEvents, 'title input count', 1); integer(edit.bodyInputEvents, 'body input count', 1);
  snapshot(edit.before, 'blank notebook', false); snapshot(edit.after, 'edited notebook', true);
  check(edit.before.revision === 0 && edit.after.documentId === edit.before.documentId && edit.after.revision > edit.before.revision, 'DOM input did not advance the same notebook');
  check(typeof persistence.targetId === 'string' && persistence.targetId.length > 0 && persistence.targetId.length <= 256, 'file identity missing');
  const initial = notebookBytes(persistence.initialBase64, persistence.initialSha256, persistence.initialSizeBytes, 'initial');
  const saved = notebookBytes(persistence.readbackBase64, persistence.finalSha256, persistence.finalSizeBytes, 'saved');
  const section = initial.sections[0], page = section.pages[0], block = page.blocks[0];
  assert.deepEqual(initial, { format: 'open-office-notebook', version: 1, id: initial.id, title: 'native-notebook',
    sections: [{ id: section.id, title: '日常笔记', pages: [{ id: page.id, title: '无标题页面', blocks: [{ id: block.id, type: 'paragraph', content: [] }] }] }] }, 'Native notebook: initial content differs');
  // The browser may replace the empty paragraph node during insertion. Its new
  // block ID remains validated above; notebook, section and page IDs must persist.
  const expected = structuredClone(initial);
  expected.sections[0].pages[0].title = NOTEBOOK_PAGE_TITLE;
  expected.sections[0].pages[0].blocks = [{ id: saved.sections[0].pages[0].blocks[0].id, type: 'paragraph', content: [{ text: NOTEBOOK_PAGE_TEXT }] }];
  assert.deepEqual(saved, expected, 'Native notebook: independently parsed saved content differs');
  check(persistence.finalSha256 !== persistence.initialSha256 && persistence.dialogObserved === false, 'save did not update original bytes or opened a dialog');
  snapshot(persistence.saved, 'saved notebook', false);
  check(persistence.saved.documentId === edit.after.documentId && persistence.saved.revision === edit.after.revision, 'save acknowledged another revision');
  assert.deepEqual(persistence.saves, [{ documentId: persistence.targetId, extension: 'oonote', expectedSha256: persistence.initialSha256, saveAs: false,
    status: 'saved', savedId: persistence.targetId, savedSha256: persistence.finalSha256, savedSizeBytes: persistence.finalSizeBytes }], 'Native notebook: original-file save receipt differs');
  snapshot(reopened.snapshot, 'reopened notebook', false);
  check(reopened.keyChanged === true && reopened.snapshot.documentId !== edit.after.documentId && reopened.snapshot.revision === 0, 'reopen reused an existing session');
  check(reopened.fileId === persistence.targetId && reopened.sha256 === persistence.finalSha256 && reopened.exportedBase64 === persistence.readbackBase64, 'reopen did not preserve disk bytes and file identity');
  check(reopened.title === NOTEBOOK_PAGE_TITLE && reopened.text === NOTEBOOK_PAGE_TEXT, 'reopened UI content differs');
  assert.deepEqual(report.cleanup, { closedDocuments: 2 }, 'Native notebook: editors did not close');
  check(workspace?.ok === true && workspace.schemaVersion === 2 && workspace.kind === 'workspace-native' && workspace.transport === 'native-webview-ipc'
    && workspace.native?.origin === report.native.origin && workspace.cleanup?.temporaryFilesRemoved === true, 'shared native temporary-file cleanup did not pass');
  return { notebookDomInput: true, notebookSavedFileReadback: true, notebookSessionCleanup: true };
}
