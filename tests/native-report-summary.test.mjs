import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeReportSummary } from '../scripts/native-report-summary.mjs';

test('native report summary preserves only fixed phases and public operation metadata', () => {
  const report = nativeReportSummary({ platformId: 'macos-arm64', commit: 'a'.repeat(40), runId: '123', durationMs: 40000,
    process: { exitCode: 1, timedOut: false }, frontend: { office: {}, pdf: { ok: true }, error: '文档在导出后又有修改，已保留内容。请重新保存或明确放弃修改。' },
    nativeDiagnostics: { events: [{ phase: 'word-workbench', detail: 'starting actual formatting, tables and review round trips', elapsedMs: 30000 },
      { phase: 'office-host:reply', detail: JSON.stringify({ action: 'discard', ok: false, error: '文档在导出后又有修改，已保留内容。请重新保存或明确放弃修改。' }), elapsedMs: 35000 }] } });
  assert.equal(report.failure, 'export-revision-conflict');
  assert.equal(report.groups.pdf.ok, true); assert.equal(report.groups.wordWorkbench.present, false);
  assert.deepEqual(report.events.map(event => [event.phase, event.action, event.failure]), [['word-workbench', undefined, undefined], ['office-host:reply', 'discard', 'export-revision-conflict']]);
});

test('native report summaries cannot expose log tails document data unknown phases or exception values', () => {
  const secret = 'PRIVATE_TOKEN_DO_NOT_PUBLISH';
  const report = nativeReportSummary({ platformId: secret, commit: secret, runId: secret, durationMs: Infinity,
    process: { stdoutTail: secret, stderrTail: secret, exitCode: secret, signal: secret }, errors: [secret],
    frontend: { error: secret, stack: secret, wordWorkbench: { ok: true, text: secret } },
    nativeDiagnostics: { events: [{ phase: secret, detail: secret }, { phase: 'word-workbench', detail: secret, elapsedMs: secret },
      { phase: 'office-host:reply', detail: JSON.stringify({ action: 'export', ok: false, error: secret, path: secret, revision: secret }) },
      { phase: 'office-host:request', detail: JSON.stringify({ action: secret }) }, { phase: 'office-host:reply', detail: 'null' }] } });
  const text = JSON.stringify(report);
  assert.ok(!text.includes(secret)); assert.ok(!text.includes(Buffer.from(secret).toString('base64')));
  assert.equal(report.failure, 'other'); assert.equal(report.events.length, 2);
  assert.equal(report.durationMs, null); assert.equal(report.process.exitCode, null);
});
