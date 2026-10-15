import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWebContentExitObserver } from '../scripts/macos-webcontent-exit.mjs';

function fixture(t, { onStart, onStop, stuck = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'oo-exit-observer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 90001; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const signals = []; let done = false;
  const api = {
    directory, child, signals,
    event(event, patch = {}) {
      child.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'macos-process-exit', source: 'EVFILT_PROC',
        event, pid: 90002, unixMs: 1792090785600, elapsedMs: 12, ...patch }) + '\n');
    },
    close(code = 0, signal = null) {
      if (done) return;
      done = true; child.emit('close', code, signal);
    },
    saved() { return JSON.parse(readFileSync(join(directory, 'webcontent-exit-observer.json'), 'utf8')); },
  };
  child.stdin.on('finish', () => { if (onStop) onStop(api); else if (!stuck) { api.event('stopped'); api.close(); } });
  child.kill = signal => { signals.push({ pid: child.pid, signal }); if (!stuck) api.close(null, signal); return !stuck; };
  child.unref = () => {};
  api.start = patch => startWebContentExitObserver({ pid: 90002, helper: '/tmp/os-input', directory,
    platform: 'darwin', registrationTimeoutMs: 100, observationTimeoutMs: 2000,
    spawnProcess(file, args, options) {
      assert.equal(file, '/tmp/os-input');
      assert.deepEqual(args, ['--observe-exit', '90002', '--timeout-ms', String(patch?.observationTimeoutMs ?? 2000)]);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      queueMicrotask(() => onStart?.(api));
      return child;
    }, ...patch });
  return api;
}

test('registration is required before returning and preserves exact PID and registration timestamps', async t => {
  const fake = fixture(t);
  let returned = false;
  const pending = fake.start().then(value => { returned = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(returned, false);
  fake.event('registered');
  const control = await pending;
  assert.equal(control.report.status, 'observing');
  assert.equal(control.report.registeredPid, 90002);
  assert.equal(control.report.registeredAtUnixMs, 1792090785600);
  assert.ok(Number.isFinite(control.report.registrationReceivedAtUnixMs));
  assert.equal(fake.saved().registered, true);
  assert.equal(await control.stop(), control.report);
  assert.equal(control.report.status, 'stopped');
  assert.equal(control.report.cleanup, 'observer-exited');
  assert.deepEqual(fake.signals, []);
});

test('a queued exit record is drained before stopping observer and retains raw signal/detail evidence', async t => {
  const fake = fixture(t, { onStart: api => api.event('registered') });
  const control = await fake.start();
  const stop = control.stop();
  setTimeout(() => {
    fake.event('exited', { rawData: 0x20009, flags: 0x8010, fflags: 0x86000000,
      waitStatusAvailable: true, detailAvailable: true, waitStatus: 9, signaled: true, signal: 9,
      exitedNormally: false, coreDumped: false, detailFlags: 0x20000, memoryExit: true,
      codeSigningExit: false, decryptFailure: false });
    fake.close();
  }, 25);
  await stop;
  assert.equal(control.report.status, 'exited');
  assert.equal(control.report.exit.rawData, 0x20009);
  assert.equal(control.report.exit.signal, 9);
  assert.equal(control.report.exit.memoryExit, true);
  assert.ok(control.report.exit.receivedAtUnixMs >= control.report.registrationReceivedAtUnixMs);
  assert.equal(fake.saved().exit.waitStatus, 9);
  assert.deepEqual(fake.signals, []);
  assert.equal(await control.stop(), control.report);
});

test('permission denial and target already gone stay distinct from registration timeout', async t => {
  for (const [errno, reason] of [[13, 'permission-denied'], [1, 'permission-denied'], [3, 'target-absent-before-registration']]) {
    const fake = fixture(t, { onStart(api) { api.event('blocked', { errno, reason, stage: 'registration-failed' }); api.close(); } });
    const { report } = await fake.start();
    assert.equal(report.status, 'blocked'); assert.equal(report.reason, reason);
    assert.equal(report.registered, false); assert.equal(report.events[0].errno, errno);
    assert.deepEqual(fake.signals, []);
  }
  const fake = fixture(t, { onStop: api => api.close() });
  const { report } = await fake.start();
  assert.equal(report.status, 'failed'); assert.equal(report.reason, 'observer-registration-timeout');
});

test('wrong PID, output before registration and incomplete exit cannot become valid exit evidence', async t => {
  for (const send of [api => api.event('registered', { pid: 90003 }),
    api => api.event('exited', { rawData: 11, fflags: 0x84000000, waitStatusAvailable: true, detailAvailable: false }),
    api => { api.event('registered'); api.event('exited', {}); }]) {
    const fake = fixture(t, { onStart: send, onStop: api => api.close() });
    const control = await fake.start();
    assert.equal(control.report.status, 'failed');
    assert.equal(control.report.exit, undefined);
    await control.stop();
  }
});

test('protocol preserves SIGSEGV and normal exit independently of whether detail flags are available', async t => {
  for (const status of [{ waitStatus: 139, signal: 11, signaled: true, coreDumped: true, exitedNormally: false },
    { waitStatus: 256, exitCode: 1, signaled: false, exitedNormally: true }]) {
    const fake = fixture(t, { onStart: api => api.event('registered') });
    const control = await fake.start();
    fake.event('exited', { rawData: status.waitStatus, flags: 0x8010, fflags: 0x84000000,
      waitStatusAvailable: true, detailAvailable: false, ...status });
    fake.close();
    await control.stop();
    assert.equal(control.report.status, 'exited');
    assert.equal(control.report.exit.waitStatus, status.waitStatus);
    assert.equal(control.report.exit.signal, status.signal);
    assert.equal(control.report.exit.exitCode, status.exitCode);
    assert.equal(control.report.exit.memoryExit, undefined);
  }
});

test('split JSON lines work and unbounded output is rejected without saving raw output', async t => {
  const fake = fixture(t, { onStart(api) {
    api.child.stdout.write('{"schemaVersion":1,"kind":"macos-process-exit","source":"EVFILT_PROC",');
    api.child.stdout.write('"event":"registered","pid":90002,"unixMs":1,"elapsedMs":1}\n');
  } });
  const control = await fake.start();
  assert.equal(control.report.registered, true);
  fake.child.stdout.write('x'.repeat(17000));
  assert.equal(control.report.reason, 'observer-output-limit');
  await control.stop();
  assert.ok(readFileSync(join(fake.directory, 'webcontent-exit-observer.json')).length < 8192);
});

test('observation timeout is explicit and stuck observer cleanup only signals its own child', async t => {
  const fake = fixture(t, { onStart: api => api.event('registered'), stuck: true });
  const control = await fake.start();
  fake.event('timeout', { reason: 'observation-deadline' });
  const began = Date.now();
  await control.stop();
  assert.equal(control.report.status, 'timeout');
  assert.equal(control.report.cleanup, 'observer-exit-unconfirmed');
  assert.ok(Date.now() - began < 1800);
  assert.deepEqual(fake.signals, [{ pid: 90001, signal: 'SIGTERM' }, { pid: 90001, signal: 'SIGKILL' }]);
});

test('non-macOS, invalid bounds and spawn errors never claim registered status', async t => {
  const fake = fixture(t);
  const unsupported = await fake.start({ platform: 'linux' });
  assert.equal(unsupported.report.status, 'blocked');
  await unsupported.stop();
  assert.equal(unsupported.report.cleanup, 'not-started');
  for (const patch of [{ pid: 1 }, { pid: process.pid }, { pid: 0x80000000 }, { registrationTimeoutMs: 5001 }, { observationTimeoutMs: 180001 }]) {
    await assert.rejects(fake.start(patch));
  }
  const unavailable = await fake.start({ spawnProcess() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.equal(unavailable.report.status, 'failed'); assert.equal(unavailable.report.registered, false);
  assert.equal(unavailable.report.errorCode, 'ENOENT');
});
