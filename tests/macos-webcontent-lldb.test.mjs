import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWebContentDebugger } from '../scripts/macos-webcontent-lldb.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'office-lldb-test-'));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), signals: [],
    kill(signal) { this.signals.push(signal); options.onKill?.(signal, api); return true; },
    unref() { this.unreferenced = true; } });
  const api = { directory, child, calls: [], ended: false,
    emit(event, fields = {}) {
      child.stdout.write(`${api.config.prefix}${JSON.stringify({ event, pid: 12345, ...fields })}\n`);
    },
    close(code = 0) { api.ended = true; child.emit('close', code, null); },
    finish(cleanup = 'detached') { api.emit('finished', { cleanup }); api.close(); },
    spawnProcess(program, args, spawnOptions) {
      api.calls.push({ program, args, options: spawnOptions });
      const path = JSON.parse(args.at(-1).match(/open\(("(?:\\.|[^"\\])*")/)[1]);
      api.python = readFileSync(path, 'utf8');
      const configLine = api.python.split('\n').find(line => line.startsWith('cfg = json.loads('));
      api.config = JSON.parse(JSON.parse(configLine.slice('cfg = json.loads('.length, -1)));
      if (!options.spawnError) child.pid = 23456;
      queueMicrotask(() => {
        if (!options.spawnError) child.emit('spawn');
        options.onSpawn?.(api);
      });
      return child;
    },
  };
  const watch = setInterval(() => {
    if (!api.ended && api.config && existsSync(api.config.stopFile)) options.onStop?.(api);
  }, 5);
  t.after(() => { clearInterval(watch); child.stdout.destroy(); child.stderr.destroy(); rmSync(directory, { force: true, recursive: true }); });
  api.start = extra => startWebContentDebugger({ pid: 12345, directory, platform: 'darwin',
    spawnProcess: api.spawnProcess, attachTimeoutMs: 500, stopTimeoutMs: 100, ...extra });
  return api;
}

test('input readiness requires exact PID attach and a separate continued/running marker', async t => {
  const fake = fixture(t, { onSpawn: api => { api.emit('initialized'); api.emit('attached'); }, onStop: api => api.finish() });
  let resolved = false;
  const pending = fake.start().then(value => { resolved = true; return value; });
  await delay(20);
  assert.equal(resolved, false, 'Attach alone must never release OS input');
  const ready = `${fake.config.prefix}${JSON.stringify({ event: 'ready', pid: 12345 })}\n`;
  for (const byte of Buffer.from(ready)) fake.child.stdout.write(Buffer.from([byte]));
  const session = await pending;
  assert.equal(session.report.status, 'attached');
  assert.equal(session.report.ready, true);
  assert.equal(session.report.safeToContinue, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].program, '/usr/bin/xcrun');
  assert.equal(fake.calls[0].options.shell, false);
  assert.deepEqual(fake.calls[0].args.slice(0, 4), ['lldb', '--no-lldbinit', '--batch', '-o']);
  assert.equal(fake.config.pid, 12345);
  const stop = session.stop();
  assert.equal(session.finish(), stop, 'Cleanup must be idempotent');
  const result = await stop;
  assert.equal(result.cleanup, 'detached');
  assert.deepEqual(fake.child.signals, []);
});

test('permission-denied attach is blocked and safe only after no-attach cleanup', async t => {
  const fake = fixture(t, { onSpawn: api => {
    api.emit('initialized');
    api.emit('blocked', { reason: 'attach-denied-or-unavailable', detail: 'Not allowed to attach to process' });
    setTimeout(() => api.finish('not-attached'), 20);
  } });
  const session = await fake.start();
  assert.equal(session.report.status, 'blocked');
  assert.equal(session.report.ready, false);
  assert.equal(session.report.safeToContinue, true);
  assert.equal(session.report.cleanup, 'not-attached');
  assert.equal(session.report.events[1].detail, 'Not allowed to attach to process');
  await session.stop();
  assert.deepEqual(fake.child.signals, []);
});

for (const sequence of [
  [['initialized'], ['ready']],
  [['initialized'], ['attached', { pid: 54321 }], ['ready']],
  [['initialized'], ['attached'], ['ready', { pid: 54321 }]],
]) test(`invalid ready protocol cannot release input: ${JSON.stringify(sequence)}`, async t => {
  const fake = fixture(t, { onSpawn: api => {
    for (const [event, fields] of sequence) api.emit(event, fields);
    api.emit('blocked', { reason: 'cannot-erase-protocol-failure' });
    api.finish();
  } });
  const session = await fake.start();
  assert.equal(session.report.status, 'failed');
  assert.equal(session.report.ready, false);
  assert.equal(session.report.safeToContinue, false);
});

test('spurious stderr or another session marker cannot establish readiness', async t => {
  const fake = fixture(t, { onSpawn: api => {
    api.child.stderr.write(`${api.config.prefix}{"event":"ready","pid":12345}\n`);
    api.child.stdout.write('OO_LLDB_another-session:{"event":"ready","pid":12345}\n');
  }, onStop: api => api.finish('not-attached') });
  const session = await fake.start({ attachTimeoutMs: 100 });
  assert.equal(session.report.ready, false);
  assert.equal(session.report.status, 'failed');
  assert.equal(session.report.reason, 'attach-timeout');
  assert.equal(session.report.safeToContinue, false);
  assert.equal(session.report.cleanup, 'not-attached');
});

test('capture remains at most 1 MiB while oversized lines cannot hide later protocol markers', async t => {
  const fake = fixture(t, { onSpawn: api => {
    api.emit('initialized'); api.emit('attached');
    api.child.stdout.write(Buffer.alloc(2 * 1024 * 1024, 0x61));
    api.child.stdout.write('\n');
    api.emit('ready');
  }, onStop: api => api.finish() });
  const session = await fake.start();
  assert.equal(session.report.ready, true);
  await session.stop();
  assert.equal(session.report.trace.bytes, 1024 * 1024);
  assert.equal(session.report.trace.truncated, true);
  assert(session.report.trace.totalBytes > 2 * 1024 * 1024);
  assert.equal(statSync(join(fake.directory, session.report.trace.file)).size, 1024 * 1024);
});

test('a later abnormal stop records evidence and detaches without signalling the inferior', async t => {
  const fake = fixture(t, { onSpawn: api => { api.emit('initialized'); api.emit('attached'); api.emit('ready'); } });
  const session = await fake.start();
  fake.emit('stopped', { reasons: [{ thread: 17, reason: 6, description: 'EXC_BAD_ACCESS' }] });
  fake.child.stdout.write('thread backtrace all\nWebCore::Example\nregister read --all\nimage list -o -f\n');
  fake.emit('captured'); fake.finish();
  const report = await session.finish();
  assert.equal(report.captured, true);
  assert.equal(report.cleanup, 'detached');
  assert.equal(report.safeToContinue, false);
  assert.match(readFileSync(join(fake.directory, report.trace.file), 'utf8'), /EXC_BAD_ACCESS/);
  assert.deepEqual(fake.child.signals, []);
});

test('normal target exit is distinguished from debugger exit without cleanup', async t => {
  for (const clean of [true, false]) {
    const fake = fixture(t, { onSpawn: api => {
      api.emit('initialized'); api.emit('attached'); api.emit('ready');
    } });
    const session = await fake.start();
    if (clean) { fake.emit('target-ended', { state: 10 }); fake.finish('target-exited'); }
    else fake.close(1);
    const report = await session.finish();
    assert.equal(report.cleanup, clean ? 'target-exited' : 'unconfirmed');
    assert.equal(report.status, clean ? 'attached' : 'failed');
    assert.equal(report.safeToContinue, false);
    assert.deepEqual(fake.child.signals, []);
  }
});

test('attach timeout never waits unboundedly or sends a signal to the requested PID', async t => {
  const fake = fixture(t);
  const started = Date.now();
  const session = await fake.start({ attachTimeoutMs: 100 });
  assert(Date.now() - started < 1000);
  assert.equal(session.report.status, 'failed');
  assert.equal(session.report.cleanup, 'unconfirmed');
  assert.equal(session.report.safeToContinue, false);
  assert.deepEqual(fake.child.signals, ['SIGINT', 'SIGKILL']);
  assert.equal(fake.child.unreferenced, true);
  assert.equal(fake.config.pid, 12345);
  assert.equal(await session.finish(), session.report);
});

test('post-ready stop timeout is bounded and cannot masquerade as confirmed detach', async t => {
  const fake = fixture(t, { onSpawn: api => { api.emit('initialized'); api.emit('attached'); api.emit('ready'); } });
  const session = await fake.start();
  const started = Date.now();
  const report = await session.stop();
  assert(Date.now() - started < 1000);
  assert.equal(report.reason, 'debugger-cleanup-timeout');
  assert.equal(report.cleanup, 'unconfirmed');
  assert.equal(report.safeToContinue, false);
  assert.deepEqual(fake.child.signals, ['SIGINT', 'SIGKILL']);
});

test('unavailable debugger is a no-attach blocked result', async t => {
  const fake = fixture(t, { spawnError: true, onSpawn: api => api.child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT', syscall: 'spawn /usr/bin/xcrun' })) });
  const session = await fake.start();
  assert.equal(session.report.status, 'blocked');
  assert.equal(session.report.reason, 'debugger-spawn-ENOENT');
  assert.equal(session.report.safeToContinue, true);
  assert.equal(session.report.cleanup, 'not-started');
  await session.finish();
  assert.deepEqual(fake.child.signals, []);
});

test('kill EPERM before LLDB initialization is never mistaken for a safe spawn failure', async t => {
  const fake = fixture(t, { onKill: (_signal, api) => {
    api.child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }));
  } });
  const session = await fake.start({ attachTimeoutMs: 100 });
  assert.equal(session.report.status, 'failed');
  assert.equal(session.report.safeToContinue, false);
  assert.equal(session.report.cleanup, 'unconfirmed');
  assert.deepEqual(fake.child.signals, ['SIGINT', 'SIGKILL']);
  assert.equal(await session.stop(), session.report);
});

test('repeated kill errors after attach preserve the report and persistent error listener', async t => {
  const fake = fixture(t, {
    onSpawn: api => { api.emit('initialized'); api.emit('attached'); api.emit('ready'); },
    onKill: (_signal, api) => api.child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' })),
  });
  const session = await fake.start();
  const report = await session.stop();
  assert.equal(report.safeToContinue, false);
  assert.equal(report.cleanup, 'unconfirmed');
  assert.ok(fake.child.listenerCount('error') > 0, 'A later process error must never become unhandled');
  assert.deepEqual(fake.child.signals, ['SIGINT', 'SIGKILL']);
  const trace = readFileSync(join(fake.directory, report.trace.file), 'utf8');
  const errors = trace.split('\n').filter(line => line.includes('"source":"controller"')).map(line => JSON.parse(line.slice(line.indexOf(':') + 1)));
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => error.code === 'EPERM' && error.event === 'controller-error'));
  assert.equal(report.events.filter(event => event.source === 'controller').length, 2);
});

test('a process error with a PID cannot claim no process was spawned even before its spawn event', async t => {
  const fake = fixture(t, { spawnError: true, onSpawn: api => {
    api.child.pid = 23456;
    api.child.emit('error', Object.assign(new Error('ambiguous spawn error'), { code: 'EIO', syscall: 'spawn /usr/bin/xcrun' }));
  }, onStop: api => api.finish('not-attached') });
  const session = await fake.start();
  assert.equal(session.report.status, 'failed');
  assert.equal(session.report.safeToContinue, false);
  assert.notEqual(session.report.cleanup, 'not-started');
});

test('the spawn event alone excludes safe no-spawn fallback even when the PID is missing', async t => {
  const fake = fixture(t, { spawnError: true, onSpawn: api => {
    api.child.emit('spawn');
    api.child.emit('error', Object.assign(new Error('late spawn error'), { code: 'EIO', syscall: 'spawn /usr/bin/xcrun' }));
  }, onStop: api => api.finish('not-attached') });
  const session = await fake.start();
  assert.equal(session.report.safeToContinue, false);
  assert.equal(session.report.status, 'failed');
});

test('a definite spawn rejection is persisted immediately, including an empty stdout', async t => {
  let immediatelySaved = false;
  const fake = fixture(t, { spawnError: true, onSpawn: api => {
    api.child.emit('error', Object.assign(new Error('spawn blocked'), { code: 'EPERM', syscall: 'spawn /usr/bin/xcrun' }));
    immediatelySaved = readFileSync(join(api.config.stopFile, '..', 'trace.txt'), 'utf8').includes('"code":"EPERM"');
  } });
  const session = await fake.start();
  assert.equal(session.report.safeToContinue, true);
  const trace = readFileSync(join(fake.directory, session.report.trace.file), 'utf8');
  assert.match(trace, /"source":"controller"/);
  assert.match(trace, /"code":"EPERM"/);
  assert.match(trace, /"operation":"spawn"/);
  assert.equal(immediatelySaved, true, 'Error evidence is flushed synchronously before any later cleanup can fail');
});

test('controller errors survive a full child output budget without exceeding the 1 MiB trace cap', async t => {
  const fake = fixture(t, {
    onSpawn: api => {
      api.emit('initialized'); api.emit('attached'); api.emit('ready');
      api.child.stdout.write(Buffer.alloc(2 * 1024 * 1024, 0x61));
    },
    onKill: () => { throw Object.assign(new Error('kill failed ' + 'x'.repeat(100000)), { code: 'EPERM', syscall: 'kill' }); },
  });
  const session = await fake.start();
  const report = await session.stop();
  assert.equal(report.safeToContinue, false);
  const trace = readFileSync(join(fake.directory, report.trace.file));
  assert.equal(trace.length, 1024 * 1024);
  assert.equal(report.trace.bytes, trace.length);
  assert.match(trace.toString(), /"source":"controller"/);
  assert.match(trace.toString(), /"code":"EPERM"/);
  assert.ok(!trace.toString().includes('x'.repeat(1000)));
});

test('non-macOS and invalid identifiers never start a debugger', async t => {
  const fake = fixture(t);
  const session = await fake.start({ platform: 'linux' });
  assert.equal(session.report.status, 'blocked');
  assert.equal(session.report.reason, 'requires-macos');
  assert.equal(fake.calls.length, 0);
  for (const pid of [0, -1, 1.2, NaN, '12345', process.pid]) await assert.rejects(fake.start({ pid }));
  await assert.rejects(fake.start({ attachTimeoutMs: 8001 }));
  assert.equal(fake.calls.length, 0);
});
