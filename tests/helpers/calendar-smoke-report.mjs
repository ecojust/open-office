import { createHash } from 'node:crypto';
import { CALENDAR_NATIVE_CHECKS, CALENDAR_NATIVE_LIMITATIONS, CALENDAR_PAGE_TITLE, CALENDAR_PAGE_TEXT,
  CALENDAR_NOTE_DATE, CALENDAR_NOTE_COLOR, CALENDAR_NOTE_TYPE, CALENDAR_SECOND_TITLE, CALENDAR_SECOND_TEXT, CALENDAR_SECOND_COLOR } from '../../scripts/calendar-native-smoke.mjs';
const bytes = model => { const data = Buffer.from(JSON.stringify(model)); return { base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'), size: data.length }; };
// Validator fixture only. This is never evidence from an installed/native process.
export function calendarReport() {
  const model = { format: 'open-office-calendar', version: 1, id: 'calendar', title: 'native-calendar', workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week', notes: [], history: [] };
  const initial = bytes(model), timestamp = '2026-11-04T10:00:00.000Z';
  model.notes.push({ id: 'note', title: CALENDAR_PAGE_TITLE, content: CALENDAR_PAGE_TEXT, date: CALENDAR_NOTE_DATE, color: CALENDAR_NOTE_COLOR, type: CALENDAR_NOTE_TYPE, created_at: timestamp, weight: 0.7 });
  model.history.push({ title: CALENDAR_PAGE_TITLE, color: CALENDAR_NOTE_COLOR, type: CALENDAR_NOTE_TYPE, lastUsedAt: timestamp });
  model.notes.push({ id: 'second', title: CALENDAR_SECOND_TITLE, content: CALENDAR_SECOND_TEXT, date: CALENDAR_NOTE_DATE, color: CALENDAR_SECOND_COLOR, type: CALENDAR_NOTE_TYPE, created_at: timestamp, weight: 0.3 });
  model.history.unshift({ title: CALENDAR_SECOND_TITLE, color: CALENDAR_SECOND_COLOR, type: CALENDAR_NOTE_TYPE, lastUsedAt: timestamp });
  const final = bytes(model), targetId = 'approved-native-calendar-file';
  return { schemaVersion: 1, kind: 'calendar-native', transport: 'native-webview-ipc', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...CALENDAR_NATIVE_CHECKS], limitations: [...CALENDAR_NATIVE_LIMITATIONS],
    editing: { title: CALENDAR_PAGE_TITLE, text: CALENDAR_PAGE_TEXT, date: CALENDAR_NOTE_DATE, color: CALENDAR_NOTE_COLOR, type: CALENDAR_NOTE_TYPE, titleInputEvents: 1, bodyInputEvents: 1,
      before: { documentId: 1, revision: 0, dirty: false }, after: { documentId: 1, revision: 4, dirty: true } },
    allocation: { title: CALENDAR_SECOND_TITLE, text: CALENDAR_SECOND_TEXT, color: CALENDAR_SECOND_COLOR, titleInputEvents: 1, bodyInputEvents: 1, keyEvents: 2, beforePercent: [50, 50], afterPercent: [70, 30] },
    persistence: { targetId, initialBase64: initial.base64, initialSha256: initial.sha256, initialSizeBytes: initial.size,
      readbackBase64: final.base64, finalSha256: final.sha256, finalSizeBytes: final.size, dialogObserved: false,
      saved: { documentId: 1, revision: 4, dirty: false }, saves: [{ documentId: targetId, extension: 'oocalendar', expectedSha256: initial.sha256, saveAs: false,
        status: 'saved', savedId: targetId, savedKind: 'calendar', savedSha256: final.sha256, savedSizeBytes: final.size }] },
    reopened: { keyChanged: true, fileId: targetId, sha256: final.sha256, snapshot: { documentId: 2, revision: 0, dirty: false }, exportedBase64: final.base64, title: CALENDAR_PAGE_TITLE, text: CALENDAR_PAGE_TEXT, date: CALENDAR_NOTE_DATE, allocationPercent: [70, 30] },
    cleanup: { closedDocuments: 2 } };
}
