import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bridge = `
import contextlib, importlib.util, io, json, os, sys
spec = importlib.util.spec_from_file_location('inspector', 'scripts/inspect-macos-diagnostic.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.load(sys.stdin)
try:
    context = module.parse_context(request.get('time', ''), request.get('pids', ''))
    if request.get('mode') == 'parse':
        value = context
    elif request.get('mode') == 'ips':
        value = module.ips_summary(request['ips'].encode())
    elif request.get('mode') in ('emit', 'rust-emit'):
        evidence = {'report.json': request['report'], 'system-webkit.ndjson': request['log'].encode()}
        evidence.update({name: text.encode() for name, text in request.get('evidence', {}).items()})
        def read(name, limit, as_json=True):
            value = evidence.get(name)
            if isinstance(value, bytes) and len(value) > limit:
                raise ValueError('read bound exceeded')
            return value
        stream = io.StringIO()
        os.environ['GH_INSPECT_TOKEN'] = 'fake-test-token'
        with contextlib.redirect_stdout(stream):
            if request.get('mode') == 'rust-emit':
                module.summarize_rust(read, {'id': 1}, {'id': 2}, 'a' * 40)
            else:
                module.summarize(read, request.get('files', list(evidence)), {'id': 1}, {'id': 2, 'size_in_bytes': 3}, 'a' * 40, context)
        value = stream.getvalue()
    else:
        value = module.context_log_summary(request['log'].encode(), request['report'], module.process_rows(request['report']['processSamples']), context)
    print(json.dumps({'ok': True, 'value': value}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
`;
function inspect(patch = {}) {
  const report = {
    startedAt: '2026-10-15T17:16:10.000Z', finishedAt: '2026-10-15T17:16:20.000Z',
    process: { pid: 15706 }, processSamples: [{ rows: ['15734 1 1000 0.0 /com.apple.WebKit.WebContent'] }],
  };
  const request = { time: '2026-10-15T17:16:18.24Z', pids: '15706,15734', report, log: '', ...patch };
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', bridge], {
    cwd: root, input: JSON.stringify(request), encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function event(pid, milliseconds, message = 'normal focus and selection message', extra = {}) {
  return JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 15, 17, 16, 18, milliseconds)).toISOString(),
    processID: pid, processImagePath: '/com.apple.WebKit.WebContent', eventMessage: message, ...extra });
}
function annotations(output) {
  return output.trimEnd().split('\n').map(line => {
    assert.ok(line.startsWith('::notice title=macOS diagnostic '));
    const text = line.slice(line.indexOf('::', 2) + 2).replaceAll('%0D', '\r').replaceAll('%0A', '\n').replaceAll('%25', '%');
    assert.ok(Buffer.byteLength(text) <= 2800);
    return JSON.parse(text);
  });
}
function crashBody(patch = {}) {
  return { pid: 15734, procName: 'com.apple.WebKit.WebContent',
    procPath: '/Users/private-person/Library/process',
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS' },
    termination: { namespace: 'SIGNAL', code: 11, indicator: 'Segmentation fault: 11' },
    faultingThread: 1,
    threads: [{ frames: [{ symbol: 'unrelated thread' }] }, { triggered: true,
      frames: Array.from({ length: 9 }, (_, i) => ({ symbol: `WebCore::focus${i}`, symbolLocation: i, imageIndex: 0 })) }],
    usedImages: [{ name: 'WebCore', path: '/Users/private-person/Frameworks/WebCore' }], ...patch };
}

test('context input requires exact UTC time and one or two distinct valid PIDs', () => {
  assert.equal(inspect({ mode: 'parse', time: '', pids: '' }).value, null);
  assert.deepEqual(inspect({ mode: 'parse' }).value.pids, [15706, 15734]);
  for (const patch of [{ time: '' }, { pids: '' }, { time: '2026-02-30T17:16:18Z' },
    { time: '2026-10-15T17:16:18+00:00' }, { pids: '1' }, { pids: '2147483648' },
    { pids: '15706,15706' }, { pids: '15706,15734,16043' }, { pids: '15706; echo injected' }]) {
    assert.equal(inspect({ mode: 'parse', ...patch }).ok, false);
  }
});

test('per-PID quotas retain ordinary WebContent messages despite application reload chatter', () => {
  const log = [...Array.from({ length: 40 }, (_, index) => event(15706, 200 + index)),
    ...Array.from({ length: 12 }, (_, index) => event(15734, 100 + index)),
    event(15734, -900, 'outside fixed window'), event(999, 240, 'unrequested PID')].join('\n');
  const result = inspect({ log });
  assert.equal(result.ok, true);
  assert.equal(result.value.lines.length, 20);
  assert.deepEqual(result.value.pidCounts.map(row => [row.pid, row.matches, row.selected, row.omitted]),
    [[15706, 40, 10, 30], [15734, 12, 10, 2]]);
  assert.equal(result.value.lines.filter(row => row.pid === 15734).length, 10);
  assert.ok(result.value.lines.every(row => row.message === 'normal focus and selection message'));
  assert.equal(result.value.lines.find(row => row.pid === 15734).time, '2026-10-15T17:16:18.102Z');
  assert.deepEqual(result.value.lines.map(row => row.time), result.value.lines.map(row => row.time).sort());
});

test('context rejects timestamps outside the run and process IDs absent from native observations', () => {
  assert.equal(inspect({ time: '2026-10-15T17:16:21Z' }).ok, false);
  assert.equal(inspect({ pids: '15706,999' }).ok, false);
  assert.equal(inspect({ report: { process: { pid: 15706 }, processSamples: [] } }).ok, false);
});

test('malformed tail fragments and oversized records are bounded without excluding following valid lines', () => {
  const log = ['partial tail fragment', 'x'.repeat(65537), event('15734', 240)].join('\n');
  const result = inspect({ log });
  assert.equal(result.ok, true);
  assert.equal(result.value.skippedLines, 2);
  assert.equal(result.value.lines.length, 1);
  assert.equal(result.value.lines[0].pid, 15734);
});

test('context annotations stay valid, bounded and scrub credentials without workflow-command injection', () => {
  const message = 'fake-test-token https://example.test/?secret=x ghp_abcdefghijk TOKEN=value\n::error::injected\n' + '文'.repeat(4000);
  const log = [15706, 15734].flatMap(pid => Array.from({ length: 12 }, (_, index) => event(pid, 220 + index, message))).join('\n');
  const result = inspect({ mode: 'emit', log });
  assert.equal(result.ok, true);
  assert.ok(!result.value.includes('fake-test-token'));
  assert.ok(!result.value.includes('https://example.test'));
  assert.ok(!result.value.includes('ghp_abcdefghijk'));
  assert.ok(!result.value.includes('TOKEN=value'));
  const lines = result.value.trimEnd().split('\n');
  assert.equal(lines.length, 8);
  const summaries = lines.map(line => {
    assert.ok(line.startsWith('::notice title=macOS diagnostic '));
    const text = line.slice(line.indexOf('::', 2) + 2).replaceAll('%0D', '\r').replaceAll('%0A', '\n').replaceAll('%25', '%');
    assert.ok(Buffer.byteLength(text) <= 2800);
    return JSON.parse(text);
  });
  assert.equal(summaries[0].section, 'context');
  const selected = summaries.slice(1).flatMap(summary => summary.lines);
  assert.equal(selected.length, 20);
  assert.ok(selected.every(row => row.messageTruncated === true));
});

test('IPS header plus crash object exposes only exception, termination and six triggered-thread frames', () => {
  const ips = JSON.stringify({ app_name: 'metadata-name', userName: 'private-person' }) + '\n' + JSON.stringify(crashBody());
  const result = inspect({ mode: 'ips', ips });
  assert.equal(result.ok, true);
  assert.equal(result.value.pid, 15734);
  assert.equal(result.value.exception.type, 'EXC_BAD_ACCESS');
  assert.equal(result.value.termination.indicator, 'Segmentation fault: 11');
  assert.equal(result.value.triggeredThread, 1);
  assert.equal(result.value.frameCount, 9);
  assert.deepEqual(result.value.frames.map(frame => frame.symbol), Array.from({ length: 6 }, (_, i) => `WebCore::focus${i}`));
  assert.equal(result.value.frames[0].image, 'WebCore');
  assert.ok(!JSON.stringify(result.value).includes('private-person'));
  assert.equal(result.value.causalityEstablished, false);
});

test('IPS supports one object and triggered flag fallback without inventing an absent faulting thread', () => {
  const body = crashBody({ faultingThread: 900 });
  body.threads[1].frames = [{ symbol: 'failure /Users/private-person/source.mm:42', imageIndex: 99, imageOffset: 123 }];
  const result = inspect({ mode: 'ips', ips: JSON.stringify(body) });
  assert.equal(result.ok, true);
  assert.equal(result.value.triggeredThread, 1);
  assert.equal(result.value.frames[0].image, '[unknown]');
  assert.equal(result.value.frames[0].imageOffset, 123);
  assert.ok(!result.value.frames[0].symbol.includes('private-person'));
  delete body.threads[1].triggered;
  const absent = inspect({ mode: 'ips', ips: JSON.stringify(body) });
  assert.equal(absent.value.triggeredThread, null);
  assert.deepEqual(absent.value.frames, []);
});

test('default summaries preserve both log phases, collection and service evidence within ten bounded notices', () => {
  const report = {
    startedAt: '2026-10-15T17:16:10.000Z', finishedAt: '2026-10-15T17:16:30.000Z', process: { pid: 15706 },
    systemLog: { bytes: 8388608, truncated: true, mode: 'tail', totalBytes: 15000000, droppedBytes: 6611392 },
    reportCrashLog: { bytes: 123, truncated: false, mode: 'tail', totalBytes: 123, droppedBytes: 0, startsMidLine: true },
    crashReports: { files: [{ file: 'crash-1-WebContent.ips' }], scanCount: 3, waitMs: 1003, maxWaitMs: 10000,
      gaps: [], directories: [{ directory: 'user', readable: true, recentCount: 1,
        recent: [{ file: 'WebContent.ips', matched: true, bytes: 1200 }] }, { directory: 'system', readable: false, recentCount: 0 }] },
    crashReporterServices: [
      { query: 'print-disabled gui/501', exitCode: 0, lines: ['"com.apple.ReportCrash" => false'] },
      { query: 'print-disabled system', exitCode: 0, lines: [] },
      { query: 'print gui/501/com.apple.ReportCrash', exitCode: 0, lines: ['state = running', 'pid = 22'] },
      { query: 'print system/com.apple.ReportCrash.Root', exitCode: 113, errorCode: null, lines: [] },
    ],
  };
  const ips = JSON.stringify(crashBody());
  const result = inspect({ mode: 'emit', time: '', pids: '', report,
    evidence: { 'system-reportcrash.ndjson': '', 'crash-1-WebContent.ips': ips, 'crash-2-Open Office.ips': ips, 'crash-3-GPU.ips': ips },
    log: Array.from({ length: 20 }, (_, i) => event(15706, i, 'process terminated reason=Crash')).join('\n') });
  assert.equal(result.ok, true, result.error);
  const rows = annotations(result.value);
  assert.equal(rows.length, 10);
  assert.ok(rows.every(row => !row.summaryError));
  const metadata = rows.find(row => row.section === 'crash-evidence');
  assert.equal(metadata.crashReports.scanCount, 3);
  assert.equal(metadata.crashReports.waitMs, 1003);
  assert.equal(metadata.crashReports.maxWaitMs, 10000);
  assert.equal(metadata.crashReports.directories[0].readable, true);
  assert.equal(metadata.crashReports.directories[1].readable, false);
  assert.equal(metadata.reportCrashLog.bytes, 123);
  assert.equal(metadata.reportCrashLog.available, true);
  assert.equal(metadata.crashReporterServices.length, 4);
  assert.equal(metadata.crashReporterServices[3].exitCode, 113);
  assert.equal(metadata.ipsCount, 3);
  assert.equal(metadata.ipsSummarized, 2);
  assert.equal(rows.filter(row => row.section === 'crash-report').length, 2);
  assert.equal(rows.find(row => row.section === 'system-log').bytes, 8388608);
  assert.equal(rows.filter(row => row.section === 'related-system-log').flatMap(row => row.lines).length, 8);
});

test('malformed or oversized IPS cannot suppress a subsequent valid report or leak parser content', () => {
  const result = inspect({ mode: 'emit', time: '', pids: '', evidence: {
    'crash-1-WebContent.ips': '{"private-path":"/Users/private-person/',
    'crash-2-WebContent.ips': JSON.stringify(crashBody()),
    'nested/crash-3-WebContent.ips': JSON.stringify(crashBody()),
  } });
  assert.equal(result.ok, true, result.error);
  const rows = annotations(result.value);
  const crashes = rows.filter(row => row.section === 'crash-report');
  assert.equal(crashes.length, 2);
  assert.equal(crashes[0].parsed, false);
  assert.equal(crashes[0].error, 'JSONDecodeError');
  assert.equal(crashes[1].exception.type, 'EXC_BAD_ACCESS');
  assert.ok(!result.value.includes('private-person'));
  const oversized = inspect({ mode: 'emit', time: '', pids: '', evidence: { 'crash-1-WebContent.ips': ' '.repeat(8 * 1024 * 1024 + 1) } });
  assert.equal(oversized.ok, true);
  assert.equal(annotations(oversized.value).find(row => row.section === 'crash-report').error, 'ValueError');
});

test('older artifacts explicitly distinguish missing crash collection and service metadata', () => {
  const result = inspect({ mode: 'emit', time: '', pids: '' });
  assert.equal(result.ok, true);
  const metadata = annotations(result.value).find(row => row.section === 'crash-evidence');
  assert.equal(metadata.crashReports.available, false);
  assert.equal(metadata.reportCrashLog.available, false);
  assert.equal(metadata.serviceEvidenceAvailable, false);
  assert.equal(metadata.ipsCount, 0);
});

test('Rust regression output includes compilation failure context and tail without emitting the full log', () => {
  const log = Array.from({ length: 70 }, (_, i) => `compile progress ${i}`);
  log[5] = 'error[E0433]: cannot find type CellEditor';
  log[6] = ' --> /Users/private-person/source.rs:22:1';
  log[7] = 'fake-test-token https://private.test/log\n::error::injected';
  log[35] = "thread 'deferred_edit' panicked at assertion failed: editor.active";
  log[66] = 'test result: FAILED. 0 passed; 1 failed';
  const result = inspect({ mode: 'rust-emit', evidence: { 'cargo-test.log': log.join('\n') } });
  assert.equal(result.ok, true, result.error);
  const rows = annotations(result.value);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].section, 'rust-regression');
  assert.equal(rows[0].failureMarkers, 3);
  assert.equal(rows[0].available, true);
  assert.equal(rows[0].establishesFix, false);
  assert.ok(rows.some(row => row.lines?.some(line => line.includes('error[E0433]'))));
  assert.ok(rows.some(row => row.lines?.some(line => line.includes("panicked at assertion"))));
  assert.ok(rows.at(-1).lines.includes('compile progress 69'));
  for (const omitted of ['compile progress 20', 'private-person', 'fake-test-token', 'https://private.test']) {
    assert.ok(!result.value.includes(omitted), omitted);
  }
});

test('Rust regression keeps large lines bounded and rejects logs over the 2 MiB limit', () => {
  const result = inspect({ mode: 'rust-emit', evidence: {
    'cargo-test.log': ['error: ' + '文'.repeat(2000), ...Array.from({ length: 20 }, () => '文'.repeat(2000))].join('\n'),
  } });
  assert.equal(result.ok, true);
  const rows = annotations(result.value);
  assert.ok(rows.length <= 6);
  assert.ok(rows.flatMap(row => row.lines || []).every(line => Buffer.byteLength(line) <= 240));
  assert.equal(inspect({ mode: 'rust-emit', evidence: { 'cargo-test.log': 'x'.repeat(2 * 1024 * 1024 + 1) } }).ok, false);
  const missing = annotations(inspect({ mode: 'rust-emit' }).value);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].available, false);
});
