import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateNativeCalendarReport, CALENDAR_NATIVE_CHECKS, CALENDAR_NATIVE_LIMITATIONS } from '../scripts/calendar-native-smoke.mjs';
import { calendarReport } from './helpers/calendar-smoke-report.mjs';
import { workspaceReport } from './helpers/workspace-smoke-report.mjs';

test('native calendar acceptance independently validates DOM changes, file bytes, history and clean new-session reopen', () => {
  assert.deepEqual(validateNativeCalendarReport(calendarReport(), workspaceReport()), {
    calendarDomInput: true, calendarAllocationReadback: true, calendarSavedFileReadback: true, calendarSessionCleanup: true,
  });
});

test('calendar gate rejects browser substitutes, missing edits, altered targets, stale revisions and missing cleanup', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateNativeCalendarReport(value, workspaceReport()), /Native calendar/);
  for (const mutate of [
    r => { r.transport = 'browser'; }, r => { r.native.tauri = false; }, r => { r.native.origin = 'http://localhost:31415'; },
    r => { r.native.origin = 'http://127.0.0.1:31415/path'; }, r => { r.checks.reverse(); }, r => { r.limitations.pop(); },
    r => { r.error = 'failed'; }, r => { r.cleanupError = 'failed'; }, r => { r.editing.titleInputEvents = 0; }, r => { r.editing.bodyInputEvents = 0; },
    r => { r.editing.after.revision = 0; }, r => { r.allocation.keyEvents = 0; }, r => { r.allocation.afterPercent = [50, 50]; }, r => { delete r.allocation; }, r => { r.reopened.allocationPercent = [50, 50]; }, r => { r.editing.after.documentId = 3; }, r => { r.editing.after.dirty = false; },
    r => { r.editing.date = '2026-11-05'; }, r => { r.persistence.readbackBase64 = r.persistence.initialBase64; },
    r => { r.persistence.finalSizeBytes++; }, r => { r.persistence.finalSha256 = '0'.repeat(64); },
    r => { r.persistence.saves[0].documentId = 'other-file'; }, r => { r.persistence.saves[0].savedKind = 'note'; },
    r => { r.persistence.saves[0].expectedSha256 = r.persistence.finalSha256; }, r => { r.persistence.saves[0].saveAs = true; },
    r => { r.persistence.saves.push(r.persistence.saves[0]); }, r => { r.persistence.saved.revision++; },
    r => { r.persistence.saved.dirty = true; }, r => { r.persistence.dialogObserved = true; },
    r => { r.reopened.snapshot.documentId = r.editing.after.documentId; }, r => { r.reopened.snapshot.revision = 1; },
    r => { r.reopened.fileId = 'different-file'; }, r => { r.reopened.exportedBase64 = r.persistence.initialBase64; },
    r => { r.reopened.text = ''; }, r => { r.reopened.date = '2026-11-05'; }, r => { r.cleanup.closedDocuments = 1; },
  ]) { const report = calendarReport(); mutate(report); assert.throws(() => validateNativeCalendarReport(report, workspaceReport()), /Native calendar/); }
  for (const workspace of [undefined, {}, { ...workspaceReport(), native: { origin: 'http://127.0.0.1:22' } },
    { ...workspaceReport(), cleanup: { temporaryFilesRemoved: false } }]) assert.throws(() => validateNativeCalendarReport(calendarReport(), workspace), /cleanup/);
});

function rewriteSaved(report, mutate) {
  const model = JSON.parse(Buffer.from(report.persistence.readbackBase64, 'base64').toString('utf8')); mutate(model);
  const bytes = Buffer.from(JSON.stringify(model)), base64 = bytes.toString('base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
  Object.assign(report.persistence, { readbackBase64: base64, finalSha256: sha256, finalSizeBytes: bytes.length });
  Object.assign(report.persistence.saves[0], { savedSha256: sha256, savedSizeBytes: bytes.length });
  Object.assign(report.reopened, { exportedBase64: base64, sha256 });
}
test('recomputed hashes cannot disguise unexpected calendar content or history copied with body', () => {
  for (const mutate of [
    m => { m.version = 2; }, m => { delete m.workdayHours; }, m => { delete m.weekMode; }, m => { m.weekMode = 'work'; }, m => { m.workdayHours = 8; }, m => { m.allocationDisplay = 'hours'; },
    m => { delete m.notes[0].weight; }, m => { m.notes[0].weight = '0.7'; }, m => { m.notes[0].weight = 0.5; m.notes[1].weight = 0.5; },
    m => { m.notes[1].weight = 0.2; }, m => { m.notes[1].type = '非工作日'; }, m => { m.id = 'different-book'; }, m => { m.title = 'changed'; },
    m => { m.notes = []; }, m => { m.notes.push({ ...m.notes[0], id: 'extra' }); }, m => { m.notes[0].content = 'wrong'; },
    m => { m.notes[0].date = '2026-02-30'; }, m => { m.notes[0].type = '非工作日'; }, m => { m.notes[0].color = '#ff0000'; },
    m => { m.notes[0].created_at = 'yesterday'; }, m => { m.notes[0].id = m.id; }, m => { m.notes[0].extra = true; },
    m => { m.history = []; }, m => { m.history[0].content = m.notes[0].content; }, m => { m.history[0].title = 'wrong'; },
    m => { m.history[0].lastUsedAt = 'invalid'; }, m => { m.extra = true; },
  ]) { const report = calendarReport(); rewriteSaved(report, mutate); assert.throws(() => validateNativeCalendarReport(report, workspaceReport()), /Native calendar/); }
});

test('installed helper and mandatory source-bound publication gate agree on calendar coverage', () => {
  const source = readFileSync(new URL('../src/calendar/native-smoke.ts', import.meta.url), 'utf8');
  for (const check of [...CALENDAR_NATIVE_CHECKS, ...CALENDAR_NATIVE_LIMITATIONS]) assert.ok(source.includes(check));
  assert.match(source, /native\.openRecent\(temporary\.id\)/);
  assert.match(source, /\[data-testid="shell-save"\]/);
  assert.match(source, /adapter\.close\(mounted\.key\)/);
  const gate = readFileSync(new URL('../scripts/native-smoke.mjs', import.meta.url), 'utf8');
  assert.match(gate, /validateNativeCalendarReport\(report\.calendar, report\.workspace\)/);
  const workflow = readFileSync(new URL('../.github/workflows/desktop-publish-verified.yml', import.meta.url), 'utf8');
  assert.match(workflow, /validateFrontendReport.*verified-source\/scripts\/native-smoke\.mjs/);
  assert.match(workflow, /assert\.equal\(report\.commit, process\.env\.VERIFIED_SOURCE_SHA\)/);
  assert.match(workflow, /validateFrontendReport\(report\.frontend\)/);
});
