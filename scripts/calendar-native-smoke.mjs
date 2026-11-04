import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const CALENDAR_NATIVE_CHECKS = Object.freeze([
  'mounted-calendar-dom-input',
  'mounted-calendar-allocation-keyboard-adjustment',
  'global-save-writes-approved-calendar-file',
  'native-file-readback-reopens-in-new-calendar-session',
  'calendar-tabs-and-editors-closed',
]);
export const CALENDAR_NATIVE_LIMITATIONS = Object.freeze([
  'The isolated temporary file is provisioned by a smoke-only native command; system file chooser interaction is not covered.',
  'Editing uses DOM input in the installed native WebView; physical keyboard input and operating-system IME are not covered.',
  'The following workspace autosave check removes the shared native smoke directory and verifies its removal.',
]);
export const CALENDAR_PAGE_TITLE = '原生日历 Native calendar';
export const CALENDAR_NOTE_DATE = '2026-11-04';
export const CALENDAR_NOTE_COLOR = '#3b82f6';
export const CALENDAR_NOTE_TYPE = '工作日';
export const CALENDAR_PAGE_TEXT = 'NATIVE_CALENDAR_EDIT 本地保存与重开';
export const CALENDAR_SECOND_TITLE = '原生协作 Native allocation';
export const CALENDAR_SECOND_TEXT = 'NATIVE_CALENDAR_ALLOCATION 两项工时分配';
export const CALENDAR_SECOND_COLOR = '#16a34a';
const check = (value, message) => assert.ok(value, `Native calendar: ${message}`);
const integer = (value, label, minimum = 0) => check(Number.isSafeInteger(value) && value >= minimum, `invalid ${label}`);
const object = (value, label) => check(value && typeof value === 'object' && !Array.isArray(value), `missing ${label}`);

function calendarBytes(base64, hash, size, label) {
  check(typeof base64 === 'string' && base64.length > 0 && base64.length <= 65536 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} Base64 invalid`);
  integer(size, `${label} size`, 1);
  check(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), `${label} SHA-256 invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.toString('base64') === base64 && bytes.length === size && createHash('sha256').update(bytes).digest('hex') === hash, `${label} bytes differ`);
  let model;
  try { model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error(`Native calendar: ${label} is not UTF-8 JSON`); }
  object(model, `${label} calendar`);
  check(model.format === 'open-office-calendar' && model.version === 1 && Array.isArray(model.notes) && Array.isArray(model.history), `${label} calendar structure invalid`);
  check(typeof model.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(model.id), `${label} calendar ID invalid`);
  return model;
}
function snapshot(value, label, dirty) {
  object(value, label); integer(value.documentId, `${label} document ID`, 1); integer(value.revision, `${label} revision`);
  check(value.dirty === dirty, `${label} dirty state differs`);
}

/** Independent JSON/byte checks on the actual native save/readback receipt. */
export function validateNativeCalendarReport(report, workspace) {
  object(report, 'installed calendar report');
  check(report.schemaVersion === 1 && report.kind === 'calendar-native' && report.transport === 'native-webview-ipc' && report.ok === true, 'native acceptance did not pass');
  check(report.native?.tauri === true, 'requires native IPC');
  let origin;
  try { origin = new URL(report.native.origin); } catch { throw Error('Native calendar: invalid origin'); }
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Number(origin.port) > 0 && origin.origin === report.native.origin, 'requires installed WebView origin');
  assert.deepEqual(report.checks, [...CALENDAR_NATIVE_CHECKS], 'Native calendar: ordered checks differ');
  assert.deepEqual(report.limitations, [...CALENDAR_NATIVE_LIMITATIONS], 'Native calendar: native coverage limits differ');
  check(report.error === undefined && report.cleanupError === undefined, 'operation or cleanup failed');
  const edit = report.editing, persistence = report.persistence, reopened = report.reopened;
  object(edit, 'DOM edit'); object(persistence, 'native persistence'); object(reopened, 'reopened calendar');
  check(edit.title === CALENDAR_PAGE_TITLE && edit.text === CALENDAR_PAGE_TEXT && edit.date === CALENDAR_NOTE_DATE && edit.color === CALENDAR_NOTE_COLOR && edit.type === CALENDAR_NOTE_TYPE, 'DOM fields differ');
  integer(edit.titleInputEvents, 'title input count', 1); integer(edit.bodyInputEvents, 'body input count', 1);
  const allocation = report.allocation;
  object(allocation, 'DOM allocation adjustment');
  check(allocation.title === CALENDAR_SECOND_TITLE && allocation.text === CALENDAR_SECOND_TEXT && allocation.color === CALENDAR_SECOND_COLOR, 'second note DOM fields differ');
  integer(allocation.titleInputEvents, 'second title input count', 1); integer(allocation.bodyInputEvents, 'second body input count', 1);
  check(allocation.keyEvents === 2, 'allocation keyboard events missing');
  const percentages = (actual, expected, label) => check(Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value - expected[index]) < 1e-6), `${label} percentages differ`);
  percentages(allocation.beforePercent, [50, 50], 'initial equal allocation'); percentages(allocation.afterPercent, [70, 30], 'DOM adjusted allocation');
  snapshot(edit.before, 'blank calendar', false); snapshot(edit.after, 'edited calendar', true);
  check(edit.before.revision === 0 && edit.after.documentId === edit.before.documentId && edit.after.revision >= edit.before.revision + 4, 'DOM input did not advance the same calendar');
  check(typeof persistence.targetId === 'string' && persistence.targetId.length > 0 && persistence.targetId.length <= 256, 'file identity missing');
  const initial = calendarBytes(persistence.initialBase64, persistence.initialSha256, persistence.initialSizeBytes, 'initial');
  const saved = calendarBytes(persistence.readbackBase64, persistence.finalSha256, persistence.finalSizeBytes, 'saved');
  assert.deepEqual(initial, { format: 'open-office-calendar', version: 1, id: initial.id, title: 'native-calendar', workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week', notes: [], history: [] }, 'Native calendar: initial content differs');
  check(saved.notes.length === 2 && saved.history.length === 2, 'saved note or history count differs');
  const [note, second] = saved.notes, [secondHistory, firstHistory] = saved.history;
  const ids = [saved.id, note.id, second.id];
  check(ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) && new Set(ids).size === ids.length, 'saved note IDs invalid');
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  check([note.created_at, second.created_at, firstHistory.lastUsedAt, secondHistory.lastUsedAt].every(timestamp), 'note/history timestamp invalid');
  percentages([note.weight * 100, second.weight * 100], [70, 30], 'saved non-default allocation');
  check(typeof note.weight === 'number' && typeof second.weight === 'number' && Math.abs(note.weight + second.weight - 1) < 1e-9, 'saved allocation does not conserve the workday');
  assert.deepEqual(saved, { ...initial, notes: [{ id: note.id, title: CALENDAR_PAGE_TITLE, content: CALENDAR_PAGE_TEXT,
    date: CALENDAR_NOTE_DATE, color: CALENDAR_NOTE_COLOR, created_at: note.created_at, type: CALENDAR_NOTE_TYPE, weight: note.weight },
    { id: second.id, title: CALENDAR_SECOND_TITLE, content: CALENDAR_SECOND_TEXT, date: CALENDAR_NOTE_DATE, color: CALENDAR_SECOND_COLOR,
      created_at: second.created_at, type: CALENDAR_NOTE_TYPE, weight: second.weight }],
    history: [{ title: CALENDAR_SECOND_TITLE, color: CALENDAR_SECOND_COLOR, type: CALENDAR_NOTE_TYPE, lastUsedAt: secondHistory.lastUsedAt },
      { title: CALENDAR_PAGE_TITLE, color: CALENDAR_NOTE_COLOR, type: CALENDAR_NOTE_TYPE, lastUsedAt: firstHistory.lastUsedAt }] }, 'Native calendar: independently parsed saved content differs');
  check(persistence.finalSha256 !== persistence.initialSha256 && persistence.dialogObserved === false, 'save did not update original bytes or opened a dialog');
  snapshot(persistence.saved, 'saved calendar', false);
  check(persistence.saved.documentId === edit.after.documentId && persistence.saved.revision === edit.after.revision, 'save acknowledged another revision');
  assert.deepEqual(persistence.saves, [{ documentId: persistence.targetId, extension: 'oocalendar', expectedSha256: persistence.initialSha256, saveAs: false,
    status: 'saved', savedId: persistence.targetId, savedKind: 'calendar', savedSha256: persistence.finalSha256, savedSizeBytes: persistence.finalSizeBytes }], 'Native calendar: original-file save receipt differs');
  snapshot(reopened.snapshot, 'reopened calendar', false);
  check(reopened.keyChanged === true && reopened.snapshot.documentId !== edit.after.documentId && reopened.snapshot.revision === 0, 'reopen reused an existing session');
  check(reopened.fileId === persistence.targetId && reopened.sha256 === persistence.finalSha256 && reopened.exportedBase64 === persistence.readbackBase64, 'reopen did not preserve disk bytes and file identity');
  check(reopened.title === CALENDAR_PAGE_TITLE && reopened.text === CALENDAR_PAGE_TEXT && reopened.date === CALENDAR_NOTE_DATE, 'reopened UI content differs');
  percentages(reopened.allocationPercent, [70, 30], 'reopened allocation');
  assert.deepEqual(report.cleanup, { closedDocuments: 2 }, 'Native calendar: editors did not close');
  check(workspace?.ok === true && workspace.schemaVersion === 2 && workspace.kind === 'workspace-native' && workspace.transport === 'native-webview-ipc'
    && workspace.native?.origin === report.native.origin && workspace.cleanup?.temporaryFilesRemoved === true, 'shared native temporary-file cleanup did not pass');
  return { calendarDomInput: true, calendarAllocationReadback: true, calendarSavedFileReadback: true, calendarSessionCleanup: true };
}
