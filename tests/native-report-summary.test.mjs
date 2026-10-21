import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeReportSummary } from '../scripts/native-report-summary.mjs';

test('native report summary exposes current editor groups and bounded lifecycle metadata', () => {
  const report = nativeReportSummary({ platformId: 'macos-arm64', commit: 'a'.repeat(40), runId: '123', durationMs: 40000,
    process: { exitCode: 1, timedOut: false }, frontend: { word: { ok: true }, sheet: { ok: true }, presentation: { ok: false }, pdf: { ok: true } },
    nativeDiagnostics: { events: [{ phase: 'office-presentation-roundtrip', detail: 'initializing', elapsedMs: 30000 },
      { phase: 'pdf-roundtrip', detail: 'complete', elapsedMs: 35000 }] } });
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(Object.keys(report.groups), ['word', 'sheet', 'presentation', 'pdf', 'notebook', 'workflow', 'mcp', 'workspace']);
  for (const name of ['word', 'sheet', 'presentation', 'pdf']) assert.deepEqual(report.groups[name], {
    present: true, ok: name !== 'presentation', failure: null, cleanupFailure: null,
  });
  for (const name of ['notebook', 'workflow', 'mcp', 'workspace']) assert.deepEqual(report.groups[name], {
    present: false, ok: false, failure: null, cleanupFailure: null,
  });
  assert.deepEqual(report.events, [{ phase: 'office-presentation-roundtrip', elapsedMs: 30000, generation: null, complete: false },
    { phase: 'pdf-roundtrip', elapsedMs: 35000, generation: null, complete: true }]);
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
  assert.equal(summary.events.length, 64);
  assert.equal(summary.events[0].elapsedMs, 336);
});

test('extended diagnostics preserve first crash context through a later renderer reload', () => {
  const events = Array.from({ length: 240 }, (_, elapsedMs) => ({ phase: 'mcp-step-complete', detail: 'sheet native status', elapsedMs, generation: elapsedMs < 100 ? 1 : 2 }));
  events[99] = { phase: 'web-content-terminated', detail: 'private reason', elapsedMs: 99, generation: 1 };
  events[100] = { phase: 'document-start', detail: 'private boot identity', elapsedMs: 100, generation: 2 };
  const summary = nativeReportSummary({ nativeDiagnostics: { events, generation: 2, terminations: 1 } });
  assert.deepEqual(summary.lifecycle, { generation: 2, terminations: 1, documentStartRetained: true, retainedEventCount: 240 });
  assert(summary.events.length <= 64);
  assert(summary.events.some(event => event.elapsedMs === 59));
  assert(summary.events.some(event => event.phase === 'web-content-terminated'));
  assert(summary.events.some(event => event.phase === 'document-start'));
  assert(summary.events.some(event => event.elapsedMs === 239));
  assert(!JSON.stringify(summary).includes('private'));
});

test('resource and MCP details only expose exact fixed names and error enums', () => {
  const secret = 'PRIVATE_TOKEN_DO_NOT_PUBLISH';
  const events = [
    { phase: 'http-asset', detail: 'office-sheet/office-sheet_bg.wasm (12345 bytes)' },
    { phase: 'http-asset', detail: `/private/${secret} (12345 bytes)` },
    { phase: 'http-io-error', detail: `BrokenPipe: ${secret}` },
    { phase: 'http-io-error', detail: `${secret}: arbitrary` },
    { phase: 'mcp-step-start', detail: 'sheet sheet_execute_command' },
    { phase: 'mcp-step-failed', detail: secret },
    { phase: 'sheet-mcp-command-begin', detail: 'host.mcpExecute' },
  ];
  const summary = nativeReportSummary({ frontend: { sheet: { error: 'Load failed', canvas: { width: 960, height: 498, paintCalls: 3 }, text: secret },
    mcp: { editors: [{ kind: 'sheet', exported: { base64: secret }, actual: secret }] } }, nativeDiagnostics: { events } });
  assert.equal(summary.groups.sheet.failure, 'resource-load-failed');
  assert.equal(summary.sheetProgress.canvasPresent, true);
  assert.equal(summary.sheetProgress.resourcesVerified, false);
  assert.equal(summary.resourceEvents[0].asset, 'office-sheet/office-sheet_bg.wasm');
  assert.equal(summary.resourceEvents[1].asset, 'unknown-asset');
  assert.equal(summary.resourceEvents[2].ioKind, 'BrokenPipe');
  assert.equal(summary.resourceEvents[3].ioKind, 'unknown-io-error');
  assert.equal(summary.events[0].step, 'sheet sheet_execute_command');
  assert.equal(summary.events[1].step, 'unknown-step');
  assert.equal(summary.events[2].step, 'host.mcpExecute');
  assert(!JSON.stringify(summary).includes(secret));
  assert(!JSON.stringify(summary).includes('/private/'));
});
