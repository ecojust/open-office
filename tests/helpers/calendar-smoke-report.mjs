import { createHash } from 'node:crypto';
import { CALENDAR_NATIVE_CHECKS, CALENDAR_NATIVE_LIMITATIONS, CALENDAR_PAGE_TITLE, CALENDAR_PAGE_TEXT,
  CALENDAR_NOTE_DATE, CALENDAR_NOTE_COLOR, CALENDAR_NOTE_TYPE } from '../../scripts/calendar-native-smoke.mjs';
const bytes = model => { const data = Buffer.from(JSON.stringify(model)); return { base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'), size: data.length }; };
// Validator fixture only. This is never evidence from an installed/native process.
export function calendarReport() {
  const model = { format: 'open-office-calendar', version: 1, id: 'calendar', title: 'native-calendar', notes: [], history: [] };
  const initial = bytes(model), timestamp = '2026-11-04T10:00:00.000Z';
  model.notes.push({ id: 'note', title: CALENDAR_PAGE_TITLE, content: CALENDAR_PAGE_TEXT, date: CALENDAR_NOTE_DATE, color: CALENDAR_NOTE_COLOR, type: CALENDAR_NOTE_TYPE, created_at: timestamp });
  model.history.push({ title: CALENDAR_PAGE_TITLE, color: CALENDAR_NOTE_COLOR, type: CALENDAR_NOTE_TYPE, lastUsedAt: timestamp });
  const final = bytes(model), targetId = 'approved-native-calendar-file';
  return { schemaVersion: 1, kind: 'calendar-native', transport: 'native-webview-ipc', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...CALENDAR_NATIVE_CHECKS], limitations: [...CALENDAR_NATIVE_LIMITATIONS],
    editing: { title: CALENDAR_PAGE_TITLE, text: CALENDAR_PAGE_TEXT, date: CALENDAR_NOTE_DATE, color: CALENDAR_NOTE_COLOR, type: CALENDAR_NOTE_TYPE, titleInputEvents: 1, bodyInputEvents: 1,
      before: { documentId: 1, revision: 0, dirty: false }, after: { documentId: 1, revision: 1, dirty: true } },
    persistence: { targetId, initialBase64: initial.base64, initialSha256: initial.sha256, initialSizeBytes: initial.size,
      readbackBase64: final.base64, finalSha256: final.sha256, finalSizeBytes: final.size, dialogObserved: false,
      saved: { documentId: 1, revision: 1, dirty: false }, saves: [{ documentId: targetId, extension: 'oocalendar', expectedSha256: initial.sha256, saveAs: false,
        status: 'saved', savedId: targetId, savedKind: 'calendar', savedSha256: final.sha256, savedSizeBytes: final.size }] },
    reopened: { keyChanged: true, fileId: targetId, sha256: final.sha256, snapshot: { documentId: 2, revision: 0, dirty: false }, exportedBase64: final.base64, title: CALENDAR_PAGE_TITLE, text: CALENDAR_PAGE_TEXT, date: CALENDAR_NOTE_DATE },
    cleanup: { closedDocuments: 2 } };
}
