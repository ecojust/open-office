import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync, truncateSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { checkInputPreflight, parseInputRequest, inputForWindow, checkLifecycle,
  validateEditingReport, viewportMapping, geometryForRequest, captureStream, collectCrashReports,
  finalizeMacosEditingDiagnostic, parseArgs, debuggerTargetPid, EDITING_ACTIONS, EDITING_CHECKS, EDITING_F2_ACTIONS, EDITING_F2_CHECKS } from '../scripts/macos-editing-diagnostic.mjs';

function finalizationFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'macos-final-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const temporary = join(directory, 'temporary'); mkdirSync(temporary);
  const native = { schemaVersion: 1, generation: 2, terminations: 1, events: [{ phase: 'web-content-terminated' }] };
  const frontend = { ok: false, editing: { actions: [{ actionId: 'f2-d6', completed: false }] } };
  writeFileSync(join(temporary, 'diagnostics.json'), JSON.stringify(native));
  writeFileSync(join(temporary, 'frontend.json'), JSON.stringify(frontend));
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ status: 'preflight-passed', actions: [] }));
  const report = { ok: false, status: 'failed', error: 'Original WebContent failure', gaps: [], process: { pid: 1234 },
    actions: [{ request: { actionId: 'f2-d6' }, result: { ok: true } }] };
  const processState = () => ({ closed: false, exitCode: null, exitSignal: null, stdout: Buffer.from('app started'), stderr: Buffer.from('original failure detail') });
  const state = { report, directory, temporary, started: Date.now() - 5000, processState, app: { pid: 1234 } };
  return { state, native, frontend, read: () => JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) };
}

test('EPERM during app cleanup cannot hide the original failure, OS receipts or native/frontend evidence behind preflight', async t => {
  const fixture = finalizationFixture(t), { state } = fixture;
  const signals = [], handles = [];
  state.app.stdout = { destroy: () => handles.push('stdout') };
  state.app.stderr = { destroy: () => handles.push('stderr') };
  state.app.unref = () => handles.push('process');
  const log = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
    kill() { this.exitCode = 0; } });
  state.log = log;
  state.finishLog = captureStream(log, join(state.directory, 'system-webkit.ndjson'), 1024);
  log.stdout.emit('data', Buffer.from('WebContent crash before cleanup\n'));
  await finalizeMacosEditingDiagnostic(state, {
    wait: async () => {},
    kill: (_app, signal = 'SIGTERM') => { signals.push(signal); throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); },
    collectReports: async (_started, _directory, options) => {
      assert.equal(options.terminated, true, 'Native evidence must be loaded despite the failed cleanup');
      log.stdout.emit('data', Buffer.from('ReportCrash after cleanup\n'));
      return { files: [], gaps: ['no-stable-crash-report-within-deadline'] };
    },
  });
  const report = fixture.read();
  assert.equal(report.status, 'failed'); assert.equal(report.ok, false);
  assert.equal(report.error, 'Original WebContent failure', 'Cleanup must not replace the original failure cause');
  assert.deepEqual(report.actions, state.report.actions);
  assert.deepEqual(report.nativeDiagnostics, fixture.native); assert.deepEqual(report.frontend, fixture.frontend);
  assert.deepEqual(JSON.parse(readFileSync(join(state.directory, 'native-diagnostics.json'))), fixture.native);
  assert.deepEqual(JSON.parse(readFileSync(join(state.directory, 'frontend-report.json'))), fixture.frontend);
  assert.equal(report.process.closed, false); assert.equal(report.process.stderrTail, 'original failure detail');
  assert(report.gaps.some(gap => gap.startsWith('application-SIGTERM: EPERM:')));
  assert(report.gaps.some(gap => gap.startsWith('application-SIGKILL: EPERM:')));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(handles, ['stdout', 'stderr', 'process']);
  assert.equal(readFileSync(join(state.directory, 'system-webkit.ndjson'), 'utf8'), 'WebContent crash before cleanup\n');
  assert.equal(readFileSync(join(state.directory, 'system-reportcrash.ndjson'), 'utf8'), 'ReportCrash after cleanup\n');
  assert.ok(report.finishedAt); assert(report.durationMs >= 5000);
  assert.equal(existsSync(state.temporary), true, 'A fixture still running must retain its evidence directory');
  assert.equal(report.retainedEvidenceDirectory, state.temporary);
});

test('debugger, crash-report and log cleanup errors are independent and cannot suppress the final report', async t => {
  const fixture = finalizationFixture(t), { state } = fixture;
  state.report.ok = true; state.report.status = 'passed'; delete state.report.error;
  state.processState = () => ({ closed: true, exitCode: 0, exitSignal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  state.debuggerControl = { stop: async () => { throw new Error('detach failed'); } };
  state.log = { exitCode: null, kill: () => { throw new Error('log kill denied'); } };
  const savedLogs = [];
  state.finishLog = destination => { savedLogs.push(destination || 'checkpoint'); return { file: destination || 'system-webkit.ndjson' }; };
  await finalizeMacosEditingDiagnostic(state, { wait: async () => {}, collectReports: async () => { throw new Error('crash directory failed'); } });
  const report = fixture.read();
  assert.equal(report.ok, false); assert.equal(report.status, 'failed');
  for (const stage of ['debugger-cleanup', 'crash-report-collection', 'system-log-SIGTERM', 'system-log-SIGKILL']) {
    assert(report.gaps.some(gap => gap.startsWith(`${stage}:`)), `Missing ${stage} evidence`);
  }
  assert.match(report.error, /detach failed/);
  assert.deepEqual(report.nativeDiagnostics, fixture.native); assert.deepEqual(report.frontend, fixture.frontend);
  assert.equal(savedLogs.length, 2, 'The log save must still run after log termination fails');
});

test('a failed evidence copy retains its source and still publishes the other evidence and final failure', async t => {
  const fixture = finalizationFixture(t), { state } = fixture;
  delete state.app;
  mkdirSync(join(state.directory, 'native-diagnostics.json'));
  await finalizeMacosEditingDiagnostic(state, { wait: async () => {} });
  const report = fixture.read();
  assert.equal(report.error, 'Original WebContent failure'); assert.equal(report.status, 'failed');
  assert(report.gaps.some(gap => gap.startsWith('native-diagnostics.json:')));
  assert.equal(report.retainedEvidenceDirectory, state.temporary);
  assert.equal(existsSync(join(state.temporary, 'diagnostics.json')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(state.directory, 'frontend-report.json'))), fixture.frontend);
});

test('log kill error events and false returns fail cleanup while retaining their evidence', async t => {
  const fixture = finalizationFixture(t), { state } = fixture;
  state.report.ok = true; state.report.status = 'passed'; delete state.report.error;
  state.processState = () => ({ closed: true, exitCode: 0, exitSignal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const signals = [];
  const log = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null,
    kill(signal) { signals.push(signal); this.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' })); return false; } });
  state.log = log;
  state.finishLog = captureStream(log, join(state.directory, 'system-webkit.ndjson'), 1024);
  await finalizeMacosEditingDiagnostic(state, { wait: async () => {}, collectReports: async () => ({ files: [] }) });
  const report = fixture.read();
  assert.equal(report.ok, false); assert.equal(report.status, 'failed');
  assert.match(report.error, /system-log-SIGTERM: Signal was not sent/);
  assert(report.gaps.some(gap => gap.startsWith('system-log-SIGKILL:')));
  assert(report.gaps.some(gap => gap.startsWith('system-log-cleanup:')));
  assert.match(report.reportCrashLog.stderr, /kill EPERM/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(report.nativeDiagnostics, fixture.native); assert.deepEqual(report.frontend, fixture.frontend);
});

test('a false log kill return racing an observed exit does not fail or send another signal', async t => {
  for (const exit of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) await t.test(JSON.stringify(exit), async t => {
    const fixture = finalizationFixture(t), { state } = fixture;
    state.report.ok = true; state.report.status = 'passed'; delete state.report.error;
    state.processState = () => ({ closed: true, exitCode: 0, exitSignal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const signals = [];
    const log = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null,
      kill(signal) { signals.push(signal); return false; } });
    state.log = log;
    state.finishLog = captureStream(log, join(state.directory, 'system-webkit.ndjson'), 1024);
    await finalizeMacosEditingDiagnostic(state, {
      wait: async milliseconds => { if (milliseconds === 150) Object.assign(log, exit); },
      collectReports: async () => ({ files: [] }),
    });
    const report = fixture.read();
    assert.equal(report.ok, true); assert.equal(report.status, 'passed'); assert.equal(report.error, undefined);
    assert.deepEqual(report.gaps, []); assert.deepEqual(signals, ['SIGTERM']);
  });
});

function crashFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'macos-editing-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'user'), output = join(directory, 'output');
  mkdirSync(source); mkdirSync(output);
  return { source, output, roots: [source, join(directory, 'missing-system')], write(name, value, time = Date.now()) {
    const path = join(source, name);
    writeFileSync(path, value); utimesSync(path, time / 1000, time / 1000);
    return path;
  } };
}

test('a recorded termination waits for a delayed crash report to stop changing', async t => {
  const fixture = crashFixture(t), started = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started });
  const pending = collectCrashReports(started, fixture.output, { roots: fixture.roots, terminated: true });
  t.mock.timers.tick(500); await Promise.resolve();
  fixture.write('com.apple.WebKit.WebContent.ips', '{"partial":');
  t.mock.timers.tick(500); await Promise.resolve();
  fixture.write('com.apple.WebKit.WebContent.ips', '{"partial":false,"frames":["crash-frame"]}');
  t.mock.timers.tick(500); await Promise.resolve();
  assert.deepEqual(readdirSync(fixture.output), [], 'A changed report must not be copied yet');
  t.mock.timers.tick(500);
  const evidence = await pending;
  assert.equal(evidence.scanCount, 5);
  assert.equal(evidence.waitMs, 2000);
  assert.equal(evidence.maxWaitMs, 10000);
  assert.equal(evidence.files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.output, evidence.files[0].file))), { partial: false, frames: ['crash-frame'] });
});

test('missing crash reports cannot extend a termination collection past ten seconds', async t => {
  const fixture = crashFixture(t), started = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started });
  fixture.write('WebKit-empty.ips', '');
  const pending = collectCrashReports(started, fixture.output, { roots: fixture.roots, terminated: true });
  for (let index = 0; index < 20; index++) { t.mock.timers.tick(500); await Promise.resolve(); }
  const evidence = await pending;
  assert.equal(evidence.waitMs, 10000);
  assert.equal(evidence.scanCount, 21);
  assert.deepEqual(evidence.files, []);
  assert(evidence.gaps.includes('no-stable-crash-report-within-deadline'));
  assert.equal(evidence.directories[0].recent[0].bytes, 0);
});

test('one-shot crash collection bounds metadata and continues after one file or directory fails', async t => {
  const fixture = crashFixture(t), started = Date.now();
  fixture.write('WebKit-a.ips', 'first');
  fixture.write('WebKit-b.ips', 'complete crash stack');
  fixture.write('WebKit-old.ips', 'old', started - 2000);
  const oversized = fixture.write('WebKit-large.ips', '');
  truncateSync(oversized, 8 * 1024 * 1024 + 1);
  for (let index = 0; index < 20; index++) fixture.write(`unmatched-${index}.ips`, '{}');
  // A per-file write failure must not hide a later readable report.
  mkdirSync(join(fixture.output, 'crash-1-WebKit-a.ips'));
  const evidence = await collectCrashReports(started, fixture.output, { roots: fixture.roots });
  assert.equal(evidence.maxWaitMs, 0);
  assert.equal(evidence.scanCount, 1);
  assert.equal(evidence.files.length, 1);
  assert.equal(readFileSync(join(fixture.output, evidence.files[0].file), 'utf8'), 'complete crash stack');
  assert(evidence.gaps.some(value => value.startsWith('user-crash-file-')));
  assert(evidence.gaps.includes('system-crash-directory-ENOENT'));
  assert(evidence.gaps.includes('matching-crash-report-limit'));
  assert.equal(evidence.directories[0].readable, true);
  assert.equal(evidence.directories[0].recentCount, 23);
  assert.equal(evidence.directories[0].recent.length, 16);
  assert(evidence.directories[0].recent.some(value => !value.matched));
  assert.equal(evidence.directories[1].readable, false);
});

function logCapture(t, limit) {
  const directory = mkdtempSync(join(tmpdir(), 'macos-editing-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const path = join(directory, 'system-webkit.ndjson');
  return { child, path, finish: captureStream(child, path, limit) };
}

test('log capture retains the final crash record after exceeding the real 8 MiB limit', t => {
  const limit = 8 * 1024 * 1024;
  const capture = logCapture(t, limit);
  const prefix = Buffer.alloc(limit + 1024, 0x61);
  const crash = Buffer.from('\n' + JSON.stringify({ message: 'WebContent terminated 演示😀', generation: 2 }) + '\n');
  capture.child.stdout.emit('data', prefix);
  // Split UTF-8 and JSON records across data events, as a pipe may do.
  for (const byte of crash) capture.child.stdout.emit('data', Buffer.from([byte]));
  const report = capture.finish();
  const expected = Buffer.concat([prefix, crash]);
  assert.deepEqual(readFileSync(capture.path), expected.subarray(-limit));
  assert.deepEqual(report, { file: 'system-webkit.ndjson', mode: 'tail', limitBytes: limit, bytes: limit,
    totalBytes: expected.length, droppedBytes: expected.length - limit, truncated: true, startsMidLine: true, stderr: '' });
  const completeLines = readFileSync(capture.path, 'utf8').split('\n').slice(1).filter(Boolean);
  assert.deepEqual(completeLines.map(line => JSON.parse(line)), [{ message: 'WebContent terminated 演示😀', generation: 2 }]);
});

test('log tail preserves byte order and line-boundary metadata through repeated wraps', t => {
  const capture = logCapture(t, 73);
  let expected = Buffer.alloc(0);
  const records = Array.from({ length: 18 }, (_, index) => Buffer.from(JSON.stringify({ index, text: '中文😀' }) + '\n'));
  const source = Buffer.concat(records);
  for (let position = 0; position < source.length;) {
    const chunk = source.subarray(position, position + (position % 97) + 1);
    position += chunk.length;
    capture.child.stdout.emit('data', chunk);
    expected = Buffer.concat([expected, chunk]);
    const report = capture.finish();
    const dropped = Math.max(0, expected.length - 73);
    assert.deepEqual(readFileSync(capture.path), expected.subarray(dropped));
    assert.equal(report.droppedBytes, dropped);
    assert.equal(report.startsMidLine, dropped > 0 && expected[dropped - 1] !== 0x0a);
  }
});

test('log capture distinguishes a complete retained line from a truncated first fragment', t => {
  const capture = logCapture(t, 8);
  capture.child.stdout.emit('data', Buffer.from('old\nnew\n'));
  assert.equal(capture.finish().truncated, false);
  capture.child.stdout.emit('data', Buffer.from('end\n'));
  const report = capture.finish();
  assert.equal(readFileSync(capture.path, 'utf8'), 'new\nend\n');
  assert.equal(report.startsMidLine, false);
  assert.equal(report.droppedBytes, 4);
  assert.equal(report.totalBytes, 12);
});

test('a crash checkpoint stays intact when the separately bounded waiting log overflows', t => {
  const capture = logCapture(t, 32);
  capture.child.stdout.emit('data', Buffer.from('before crash\nWebContent Crash\n'));
  const checkpoint = capture.finish(undefined, { reset: true });
  const saved = readFileSync(capture.path);
  const waiting = Buffer.from('ReportCrash wait\n'.repeat(20) + 'report published\n');
  capture.child.stdout.emit('data', waiting);
  const waitPath = join(capture.path, '..', 'system-reportcrash.ndjson');
  const report = capture.finish(waitPath);
  assert.deepEqual(readFileSync(capture.path), saved, 'Waiting output must not replace the crash-time log');
  assert(saved.toString().includes('WebContent Crash'));
  assert.deepEqual(readFileSync(waitPath), waiting.subarray(-32));
  assert.equal(checkpoint.totalBytes, saved.length);
  assert.equal(report.file, 'system-reportcrash.ndjson');
  assert.equal(report.totalBytes, waiting.length, 'Waiting counters must exclude the checkpoint phase');
  assert.equal(report.bytes, 32);
  assert.equal(report.droppedBytes, waiting.length - 32);
  assert.equal(report.truncated, true);
});

test('a phase checkpoint reports a split first line without retaining earlier bytes', t => {
  const capture = logCapture(t, 32);
  capture.child.stdout.emit('data', Buffer.from('partial'));
  capture.finish(undefined, { reset: true });
  capture.child.stdout.emit('data', Buffer.from(' record\nnext\n'));
  const waitPath = join(capture.path, '..', 'system-reportcrash.ndjson');
  const report = capture.finish(waitPath);
  assert.equal(readFileSync(waitPath, 'utf8'), ' record\nnext\n');
  assert.equal(report.startsMidLine, true);
  assert.equal(report.truncated, false);
  assert.equal(report.droppedBytes, 0);
});

test('log capture keeps stderr bounded and records stream failures without enlarging stdout', t => {
  const capture = logCapture(t, 32);
  capture.child.stderr.emit('data', Buffer.from('演示😀'.repeat(20000)));
  capture.child.emit('error', new Error('log stream stopped'));
  const report = capture.finish();
  assert.equal(report.bytes, 0);
  assert.equal(report.totalBytes, 0);
  assert.equal(report.droppedBytes, 0);
  assert.equal(report.startsMidLine, false);
  assert.equal(report.truncated, false);
  assert.equal(readFileSync(capture.path).length, 0);
  assert(Buffer.byteLength(report.stderr) <= 32 * 1024);
  assert(report.stderr.endsWith('log stream stopped'));
});

const geometry = { actionId: 'single-a1', viewport: { width: 1200, height: 800 }, pid: 1234, windowId: 92, x: 40, y: 70,
  width: 1200, height: 800, scaleFactor: 2, coordinateSpace: 'quartz-screen-points', candidates: {
    bounds: [40, 70, 1200, 800], visibleRect: [40, 70, 1200, 800], safeAreaRect: [40, 70, 1200, 800], contentLayoutIntersection: [40, 70, 1200, 800] } };
const request = { actionId: 'single-a1', kind: 'click', clientX: 300, clientY: 200, viewportWidth: 1200, viewportHeight: 800 };
const permissions = { postEventAccess: true, accessibilityTrusted: true, screenCaptureAccess: false, inputSourceId: 'com.apple.keylayout.ABC' };

function fixture(editEntry = 'doubleclick') {
  const f2 = editEntry === 'f2', expectedActions = f2 ? EDITING_F2_ACTIONS : EDITING_ACTIONS;
  const sessions = ['sheet', 'sheet', 'word'].map((kind, index) => ({ key: `tab-${index}`, kind, sessionId: `${kind}-${index}`, documentId: index + 1 }));
  const snapshot = (index, after = false) => {
    const count = expectedActions[index][2].startsWith('word:') ? 3 : 2;
    return { activeKey: sessions[count === 2 ? 1 : 2].key,
      tabs: sessions.slice(0, count).map(({ key, kind }) => ({ key, kind, dirty: true, ready: true })),
      sessions: sessions.slice(0, count).map((value, item) => ({ ...value, revision: item === 0 ? 2 : index * 2 + (after ? 2 : 1), dirty: item !== 0 && index > 0 })),
      shell: { home: false, tabCount: count, workspaceDisplay: 'flex', visibleTabCount: count } };
  };
  const sent = expectedActions.map(([actionId, kind, , value]) => {
    const input = { actionId, kind, viewportWidth: 1200, viewportHeight: 800,
      ...(['click', 'doubleClick'].includes(kind) ? { clientX: 300, clientY: 200 } : kind === 'type' ? { text: value } : { key: value }) };
    const current = { ...structuredClone(geometry), actionId };
    return { request: input, geometry: current, mapping: viewportMapping(input, current), nativeInput: inputForWindow(input, current, current.pid),
      result: { schemaVersion: 1, ok: true, actionId, kind, method: 'CGEvent-hidSystemState', physicalIME: false,
        pid: geometry.pid, windowId: geometry.windowId, eventCount: kind === 'doubleClick' ? 5 : kind === 'click' ? 3 : kind === 'key' ? 2 : value.length * 2,
        startedAt: 1700000000000, finishedAt: 1700000001000, permissions: structuredClone(permissions) } };
  });
  const actions = expectedActions.map(([actionId, kind, target, value], index) => ({ actionId, kind, target, completed: true,
    before: snapshot(index), after: snapshot(index, true), events: ['click', 'doubleClick'].includes(kind)
      ? [{ type: kind === 'doubleClick' ? 'dblclick' : 'click', target: target === 'shell:undo' ? 'button:撤销' : target.startsWith('word:') ? 'wordcraft-canvas' : 'gridcraft-canvas',
        isTrusted: true, clientX: 300, clientY: 200, detail: kind === 'doubleClick' ? 2 : 1 }]
      : (kind === 'key' ? [value] : [...value]).map(key => ({ type: 'keyup', key, isTrusted: true, target: target.startsWith('word:') ? 'wordcraft-input' : 'gridcraft-input' })) }));
  const editing = { schemaVersion: 1, kind: 'macos-editing', transport: 'local-wasm-in-native-webview', editEntry, diagnosticOnly: f2, ok: true,
    bootId: 'd3b1ead1-d8e1-418f-b964-cd13826da6ac', timeOrigin: 1700000000000, checks: [...(f2 ? EDITING_F2_CHECKS : EDITING_CHECKS)],
    initialTabIds: sessions.slice(0, 2).map(item => item.key), finalTabIds: sessions.map(item => item.key), sessions, actions,
    observations: { singleClickValue: 42, [f2 ? 'f2Value' : 'doubleClickValue']: 'sheetnative', ribbonBold: true, commandValue: 'API_SENTINEL',
      undoneValue: null, wordText: 'wordnative', retained: { a1: 42, bold: true, d6: 'sheetnative', pristineA1: null } },
    lastState: { ...snapshot(expectedActions.length - 1, true), activeKey: sessions[1].key }, cleanup: { attempted: 3, closed: 3, ok: true } };
  const diagnostics = { schemaVersion: 1, scope: 'macos-editing', generation: 1, terminations: 0, events: [
    { phase: 'document-start', detail: JSON.stringify({ bootId: editing.bootId, timeOrigin: editing.timeOrigin }) },
    ...sent.flatMap(item => [{ phase: 'editing-input-request', detail: JSON.stringify(item.request) }, { phase: 'editing-window-geometry', detail: JSON.stringify(item.geometry) }]),
  ] };
  return { frontend: { ok: true, nativeLifecycle: { generation: 1, terminations: 0 }, editing }, diagnostics, sent };
}
const validate = value => validateEditingReport(value.frontend, value.diagnostics, value.sent);

test('diagnostic entry defaults to double-click and only explicit F2 or LLDB flags opt in', () => {
  const basic = ['--app', '/tmp/Open Office.app', '--helper', '/tmp/os-input'];
  assert.deepEqual(parseArgs(basic), { '--app': '/tmp/Open Office.app', '--helper': '/tmp/os-input', editEntry: 'doubleclick', lldb: false });
  assert.deepEqual(parseArgs([...basic, '--edit-entry', 'f2', '--lldb']), { ...parseArgs(basic), editEntry: 'f2', lldb: true });
  assert.equal(parseArgs(['--helper', '/tmp/os-input', '--preflight']).preflight, true);
  for (const extra of [['--edit-entry'], ['--edit-entry', 'F2'], ['--edit-entry', 'f2', '--edit-entry', 'doubleclick'], ['--lldb', '--lldb'], ['--unknown']]) {
    assert.throws(() => parseArgs([...basic, ...extra]));
  }
});

test('LLDB accepts only the sampled private WebView PID with no process-name or parent fallback', () => {
  const current = { ...geometry, webContent: { supported: true, source: 'WKWebView._webProcessIdentifier', pid: 2345 } };
  assert.equal(debuggerTargetPid(current, geometry.pid), 2345);
  assert.throws(() => debuggerTargetPid(current, 9999), /another application/);
  for (const webContent of [undefined, { ...current.webContent, supported: false },
    { ...current.webContent, source: 'ps-name-match' }, ...[null, 0, -1, 1, 2.5, 0x80000000, geometry.pid].map(pid => ({ ...current.webContent, pid }))]) {
    assert.equal(debuggerTargetPid({ ...geometry, webContent }, geometry.pid), null);
  }
});

test('F2 has a separate 12-action control validator and cannot stand in for a double-click pass', () => {
  const value = fixture('f2');
  const f2Validate = value => validateEditingReport(value.frontend, value.diagnostics, value.sent, { editEntry: 'f2' });
  assert.equal(value.sent.length, 12); assert.equal(value.frontend.editing.checks.length, 8);
  assert.equal(f2Validate(value), true);
  assert.throws(() => validate(value), /entry differs/);
  assert.throws(() => f2Validate(fixture()), /entry differs/);
  for (const mutate of [
    v => { delete v.frontend.editing.editEntry; },
    v => { delete v.frontend.editing.diagnosticOnly; },
    v => { v.frontend.editing.observations.doubleClickValue = v.frontend.editing.observations.f2Value; delete v.frontend.editing.observations.f2Value; },
    v => { v.frontend.editing.checks[2] = 'sheet-double-click-native-typing'; },
    v => { v.frontend.editing.actions[4].events[0].key = 'Enter'; },
    v => { v.sent[4].request.key = 'Enter'; },
    v => { v.frontend.editing.actions[7].after.tabs.pop(); },
    v => { v.diagnostics.terminations = 1; },
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => f2Validate(changed)); }
  const mislabeled = fixture(); mislabeled.frontend.editing.diagnosticOnly = true;
  assert.throws(() => validate(mislabeled), /Control experiments/);
});

test('posting permission and keyboard layout preflight cannot be replaced by synthetic input', () => {
  const preflight = { schemaVersion: 1, kind: 'macos-os-input-preflight', permissions: { ...permissions } };
  assert.equal(checkInputPreflight(preflight), null);
  preflight.permissions.postEventAccess = false;
  assert.equal(checkInputPreflight(preflight), 'macos-post-event-permission-denied');
  preflight.permissions.postEventAccess = true; preflight.permissions.inputSourceId = 'com.apple.inputmethod.SCIM.ITABC';
  assert.equal(checkInputPreflight(preflight), 'unsupported-keyboard-input-source');
});

test('Retina geometry uses native screen points and does not double the display scale', () => {
  assert.deepEqual(inputForWindow(request, geometry, 1234), { actionId: 'single-a1', kind: 'click', pid: 1234, windowId: 92, x: 340, y: 270 });
  assert.throws(() => inputForWindow(request, geometry, 5678), /belong/);
  assert.throws(() => inputForWindow(request, { ...geometry, actionId: 'old-action' }, 1234), /stale/);
  assert.throws(() => inputForWindow(request, { ...geometry, viewport: { width: 1200, height: 600 } }, 1234), /different viewport/);
});

test('fresh measured inset region may match the viewport without guessing titlebar dimensions', () => {
  const input = { ...request, viewportWidth: 1024, viewportHeight: 642 };
  const current = { ...geometry, viewport: { width: 1024, height: 642 }, x: 0, y: 31, width: 1024, height: 674,
    candidates: { bounds: [0, 31, 1024, 674], visibleRect: [0, 31, 1024, 674],
      safeAreaRect: [0, 63, 1024, 642], contentLayoutIntersection: [0, 63, 1024, 642] } };
  assert.deepEqual(viewportMapping(input, current), { rect: [0, 63, 1024, 642], sources: ['safeAreaRect', 'contentLayoutIntersection'] });
  assert.deepEqual(inputForWindow(input, current, 1234), { actionId: 'single-a1', kind: 'click', pid: 1234, windowId: 92, x: 300, y: 263 });
  current.candidates.safeAreaRect = [0, 31, 1024, 642];
  assert.throws(() => viewportMapping(input, current), /conflicting/);
  current.candidates.safeAreaRect = [0, 31, 1024, 674];
  current.candidates.contentLayoutIntersection = [0, 31, 1024, 674];
  assert.throws(() => viewportMapping(input, current), /disagree/);
});

test('geometry must arrive after and identify the exact input request', () => {
  const event = { phase: 'editing-input-request', detail: JSON.stringify(request) };
  const sample = { phase: 'editing-window-geometry', detail: JSON.stringify(geometry) };
  assert.equal(geometryForRequest(request, [sample, event]), null, 'Even a matching old sample cannot be reused');
  assert.equal(geometryForRequest(request, [event, { ...sample, detail: JSON.stringify({ ...geometry, actionId: 'other' }) }]), null);
  assert.deepEqual(geometryForRequest(request, [event, sample]), geometry);
});

test('progress requests reject truncated, oversized, out-of-viewport and unknown OS commands', () => {
  assert.deepEqual(parseInputRequest(JSON.stringify(request)), request);
  assert.throws(() => parseInputRequest('{'));
  assert.throws(() => parseInputRequest(' '.repeat(400)), /bound/);
  for (const invalid of [{ ...request, kind: 'shell' }, { ...request, command: 'kill' }, { ...request, clientX: 1200 },
    { ...request, kind: 'key', key: 'Meta+Q' }, { ...request, kind: 'type', text: 'not\nallowed' }]) {
    assert.throws(() => parseInputRequest(JSON.stringify(invalid)));
  }
});

test('native page lifecycle rejects reloads and terminated content processes even after a new successful report', () => {
  const value = fixture();
  checkLifecycle(value.diagnostics, true);
  assert.throws(() => checkLifecycle({ ...value.diagnostics, generation: 2 }), /restarted/);
  assert.throws(() => checkLifecycle({ ...value.diagnostics, terminations: 1 }), /terminated/);
  value.diagnostics.events.push({ phase: 'web-content-reload-requested', detail: 'ok' });
  assert.throws(() => checkLifecycle(value.diagnostics), /restart event/);
});

test('complete native two-cold-sheet then Word scenario validates observed model edits and retained sessions', () => {
  assert.equal(validate(fixture()), true);
});

test('incomplete, synthetic, unrelated, restarted or state-losing evidence cannot become a pass', async t => {
  const cases = [
    ['browser-only transport', v => { v.frontend.editing.transport = 'local-wasm-in-browser'; }],
    ['missing behavior check', v => { v.frontend.editing.checks.pop(); }],
    ['missing OS action', v => { v.sent.pop(); }],
    ['duplicate action', v => { v.frontend.editing.actions[2] = structuredClone(v.frontend.editing.actions[1]); }],
    ['uncompleted gesture', v => { v.frontend.editing.actions[0].completed = false; }],
    ['synthetic event', v => { v.frontend.editing.actions[0].events[0].isTrusted = false; }],
    ['unrelated event type', v => { v.frontend.editing.actions[0].events[0].type = 'mousemove'; }],
    ['wrong canvas', v => { v.frontend.editing.actions[0].events[0].target = 'wordcraft-canvas'; }],
    ['wrong pointer location', v => { v.frontend.editing.actions[0].events[0].clientX += 20; }],
    ['wrong native key', v => { v.frontend.editing.actions[1].events[0].key = '5'; }],
    ['no actual model edit', v => { v.frontend.editing.observations.singleClickValue = null; }],
    ['undo did not apply', v => { v.frontend.editing.observations.undoneValue = 'API_SENTINEL'; }],
    ['tabs removed in middle', v => { v.frontend.editing.actions[4].after.tabs.pop(); }],
    ['session replaced in middle', v => { v.frontend.editing.actions[4].after.sessions[1].sessionId = 'replacement'; }],
    ['home hides existing tabs', v => { v.frontend.editing.actions[4].after.shell.home = true; }],
    ['pristine workbook mutated', v => { v.frontend.editing.actions[4].after.sessions[0].dirty = true; }],
    ['different boot', v => { v.frontend.editing.bootId = 'a3b1ead1-d8e1-418f-b964-cd13826da6ac'; }],
    ['native injection failed', v => { v.sent[0].result.ok = false; }],
    ['native events not sent', v => { v.sent[0].result.eventCount = 0; }],
    ['incomplete cleanup', v => { v.frontend.editing.cleanup.closed = 2; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = fixture(); mutate(value); assert.throws(() => validate(value)); });
});

test('frontend check inventory remains aligned with the external native validator', () => {
  const source = readFileSync(new URL('../src/sheet/rust/macos-editing-smoke.ts', import.meta.url), 'utf8');
  const block = source.match(/export const MACOS_EDITING_CHECKS = \[([\s\S]*?)\] as const/)[1];
  assert.deepEqual([...block.matchAll(/'([^']+)'/g)].map(match => match[1]), EDITING_CHECKS);
});
