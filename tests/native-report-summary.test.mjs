import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeReportSummary } from '../scripts/native-report-summary.mjs';

test('native report summary exposes current editor groups and bounded lifecycle metadata', () => {
  const report = nativeReportSummary({ platformId: 'macos-arm64', commit: 'a'.repeat(40), runId: '123', durationMs: 40000,
    process: { exitCode: 1, timedOut: false }, frontend: { word: { ok: true }, sheet: { ok: true }, presentation: { ok: false }, pdf: { ok: true } },
    nativeDiagnostics: { events: [{ phase: 'office-presentation-roundtrip', detail: 'initializing', elapsedMs: 30000 },
      { phase: 'pdf-roundtrip', detail: 'complete', elapsedMs: 35000 }] } });
  assert.deepEqual(report.groups, { word: { present: true, ok: true }, sheet: { present: true, ok: true }, presentation: { present: true, ok: false }, pdf: { present: true, ok: true } });
  assert.deepEqual(report.events, [{ phase: 'office-presentation-roundtrip', elapsedMs: 30000, complete: false }, { phase: 'pdf-roundtrip', elapsedMs: 35000, complete: true }]);
});

test('native report summaries cannot expose logs document data unknown phases or exception values', () => {
  const secret = 'PRIVATE_TOKEN_DO_NOT_PUBLISH';
  const report = nativeReportSummary({ platformId: secret, commit: secret, runId: secret, durationMs: Infinity,
    process: { stdoutTail: secret, stderrTail: secret, exitCode: secret, signal: secret }, errors: [secret],
    frontend: { error: secret, stack: secret, presentation: { ok: true, text: secret } },
    nativeDiagnostics: { events: [{ phase: secret, detail: secret }, { phase: 'presentation', detail: secret, elapsedMs: secret },
      { phase: 'office-host:reply', detail: JSON.stringify({ action: 'export', error: secret }) }] } });
  const text = JSON.stringify(report);
  assert.ok(!text.includes(secret)); assert.ok(!text.includes(Buffer.from(secret).toString('base64')));
  assert.equal(report.failure, 'other'); assert.equal(report.events.length, 1);
  assert.equal(report.durationMs, null); assert.equal(report.process.exitCode, null);
});

test('known state failures retain fixed categories while exception suffixes remain private', () => {
  const error = '文档在导出后又有修改，已保留内容。请重新保存或明确放弃修改。';
  assert.equal(nativeReportSummary({ frontend: { error } }).failure, 'export-revision-conflict');
  assert.equal(nativeReportSummary({ frontend: { error: error + 'private detail' } }).failure, 'other');
});

test('lifecycle summaries cap both input processing and emitted event count', () => {
  const events = Array.from({ length: 400 }, (_, index) => ({ phase: 'presentation', detail: 'complete', elapsedMs: index }));
  const summary = nativeReportSummary({ nativeDiagnostics: { events } });
  assert.equal(summary.events.length, 80);
  assert.equal(summary.events[0].elapsedMs, 320);
});
