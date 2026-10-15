import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebContentExitObserver } from '../scripts/macos-webcontent-exit.mjs';

const helper = process.env.OPEN_OFFICE_MACOS_EXIT_OBSERVER_HELPER;
const skip = process.platform !== 'darwin' ? 'Darwin kqueue semantics require macOS'
  : !helper ? 'Set OPEN_OFFICE_MACOS_EXIT_OBSERVER_HELPER to the compiled diagnostic helper' : false;
const options = { skip, timeout: 10000 };

async function eventually(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

async function ownedTarget(t) {
  assert.ok(isAbsolute(helper), 'Native observer helper must be an absolute path');
  const directory = mkdtempSync(join(tmpdir(), 'oo-native-exit-'));
  // Every PID used here comes from this spawn. The child performs no external
  // I/O and has an independent deadline should the test runner disappear.
  const child = spawn(process.execPath, ['-e', `
    let pending = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => {
      pending += data;
      for (let i; (i = pending.indexOf('\\n')) >= 0;) {
        const command = pending.slice(0, i); pending = pending.slice(i + 1);
        if (command === 'exit17') process.exit(17);
        if (command === 'ping') process.stdout.write('pong\\n');
      }
    });
    process.stdin.on('end', () => process.exit(0));
    process.stdout.write('ready\\n');
    setTimeout(() => process.exit(99), 15000);
  `], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', closed = false, error, observer;
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-1024); });
  child.stderr.resume();
  child.stdin.on('error', value => { error = value; });
  child.on('error', value => { error = value; });
  child.once('close', () => { closed = true; });
  t.after(async () => {
    try {
      // Stop observation before cleaning up this test's target. Signals below
      // can only address the ChildProcess just created by this test.
      await observer?.stop();
      if (!closed) {
        child.stdin.end();
        for (let i = 0; i < 50 && !closed; i++) await delay(10);
      }
      if (!closed) child.kill('SIGKILL');
      await eventually(() => closed, 'Owned test child did not exit during cleanup', 1000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await eventually(() => output.includes('ready\n') || error || closed, 'Owned child did not become ready');
  assert.ifError(error);
  assert.equal(closed, false);
  assert.ok(Number.isInteger(child.pid) && child.pid > 1 && child.pid !== process.pid);
  return {
    child,
    async observe(observationTimeoutMs = 5000) {
      observer = await startWebContentExitObserver({ pid: child.pid, helper, directory,
        registrationTimeoutMs: 2000, observationTimeoutMs });
      if (observer.report.status === 'blocked' && observer.report.reason === 'permission-denied') {
        t.skip(`Darwin denied exit-status observation of owned child (errno ${observer.report.events[0]?.errno}); semantics not verified`);
        return null;
      }
      assert.equal(observer.report.status, 'observing', JSON.stringify(observer.report));
      assert.equal(observer.report.registered, true);
      assert.equal(observer.report.registeredPid, child.pid);
      // Swift retains fractional milliseconds; Date.now() truncates them.
      assert.ok(Math.floor(observer.report.registeredAtUnixMs) <= observer.report.registrationReceivedAtUnixMs);
      return observer;
    },
    async ping() {
      assert.equal(closed, false, 'Observer must not terminate its target');
      output = '';
      child.stdin.write('ping\n');
      await eventually(() => output.includes('pong\n') || closed || error, 'Owned child stopped responding');
      assert.ifError(error);
      assert.equal(closed, false, 'Observer must leave its target alive');
      assert.ok(output.includes('pong\n'));
    },
  };
}

test('native kqueue reports actual exit17 wait status after registration', options, async t => {
  const target = await ownedTarget(t), control = await target.observe();
  if (!control) return;
  const triggeredAt = Date.now();
  target.child.stdin.write('exit17\n');
  await eventually(() => control.report.status !== 'observing', 'Native exit17 event was not delivered');
  const exit = control.report.exit;
  assert.equal(control.report.status, 'exited', JSON.stringify(control.report));
  assert.equal(exit.waitStatusAvailable, true);
  assert.equal(exit.rawData & 0xffff, 17 << 8);
  assert.equal(exit.waitStatus, 17 << 8);
  assert.equal(exit.exitedNormally, true);
  assert.equal(exit.signaled, false);
  assert.equal(exit.exitCode, 17);
  assert.equal(exit.signal, undefined);
  assert.ok(Math.floor(control.report.registeredAtUnixMs) <= triggeredAt);
  assert.ok(exit.unixMs >= triggeredAt && exit.receivedAtUnixMs >= triggeredAt);
});

test('native kqueue reports actual SIGTERM independently of normal exit code', options, async t => {
  const target = await ownedTarget(t), control = await target.observe();
  if (!control) return;
  assert.equal(target.child.kill('SIGTERM'), true, 'Could not signal our own test child');
  await eventually(() => control.report.status !== 'observing', 'Native SIGTERM event was not delivered');
  const exit = control.report.exit;
  assert.equal(control.report.status, 'exited', JSON.stringify(control.report));
  assert.equal(exit.waitStatusAvailable, true);
  assert.equal(exit.rawData & 0xffff, 15);
  assert.equal(exit.waitStatus, 15);
  assert.equal(exit.signal, 15);
  assert.equal(exit.signaled, true);
  assert.equal(exit.exitedNormally, false);
  assert.equal(exit.coreDumped, false);
  assert.equal(exit.exitCode, undefined);
});

test('native observation deadline leaves its owned target alive', options, async t => {
  const target = await ownedTarget(t), control = await target.observe(350);
  if (!control) return;
  await eventually(() => control.report.status !== 'observing', 'Native observation deadline was not enforced');
  assert.equal(control.report.status, 'timeout', JSON.stringify(control.report));
  assert.equal(control.report.reason, 'observation-deadline');
  assert.equal(control.report.exit, undefined);
  await control.stop();
  await target.ping();
});

test('native observer stop leaves its owned target alive without an exit record', options, async t => {
  const target = await ownedTarget(t), control = await target.observe();
  if (!control) return;
  await control.stop();
  assert.equal(control.report.status, 'stopped', JSON.stringify(control.report));
  assert.equal(control.report.cleanup, 'observer-exited');
  assert.equal(control.report.exit, undefined);
  await target.ping();
});
