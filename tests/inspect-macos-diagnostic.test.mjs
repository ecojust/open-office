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
    elif request.get('mode') == 'emit':
        evidence = {'report.json': request['report'], 'system-webkit.ndjson': request['log'].encode()}
        stream = io.StringIO()
        os.environ['GH_INSPECT_TOKEN'] = 'fake-test-token'
        with contextlib.redirect_stdout(stream):
            module.summarize(lambda name, *_: evidence.get(name), [], {'id': 1}, {'id': 2, 'size_in_bytes': 3}, 'a' * 40, context)
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
