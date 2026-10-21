import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const OUTPUT_LIMIT = 16 * 1024;
const LINE_LIMIT = 4096;
async function within(promise, ms) {
  let timer;
  const result = await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
  clearTimeout(timer);
  return result;
}

/** Read-only process observation: no debugger attach or signals to the target.
 * Start after fresh WKWebView PID geometry, before the first OS input. Stop
 * before application cleanup so our own shutdown is not treated as a defect.
 * The shared report object is mutated in place and also saved independently.
 */
export async function startWebContentExitObserver({ pid, helper, directory, registrationTimeoutMs = 2000,
  observationTimeoutMs = 120000, platform = process.platform, spawnProcess = spawn } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid <= 0x7fffffff && pid !== process.pid, 'Expected an exact distinct WebContent PID');
  assert.ok(typeof helper === 'string' && isAbsolute(helper), 'Expected absolute observer helper path');
  assert.ok(typeof directory === 'string' && isAbsolute(directory), 'Expected absolute evidence directory');
  assert.ok(Number.isInteger(registrationTimeoutMs) && registrationTimeoutMs >= 50 && registrationTimeoutMs <= 5000);
  assert.ok(Number.isInteger(observationTimeoutMs) && observationTimeoutMs >= 100 && observationTimeoutMs <= 180000);
  const report = { schemaVersion: 1, kind: 'macos-webcontent-exit', diagnosticOnly: true, pid, source: 'EVFILT_PROC',
    status: 'starting', registered: false, events: [], cleanup: 'pending', outputBytes: 0,
    evidenceFile: 'webcontent-exit-observer.json',
    interpretation: 'Darwin wait status and NOTE_EXIT_DETAIL are observations; a signal alone does not establish the cause.' };
  let child, closed = false, stopping, decisionResolve, closeResolve, sessionTimer;
  let pending = Buffer.alloc(0), terminal = false;
  const decision = new Promise(resolve => { decisionResolve = resolve; });
  const completion = new Promise(resolve => { closeResolve = resolve; });
  const save = () => {
    try { writeFileSync(join(directory, report.evidenceFile), `${JSON.stringify(report)}\n`, { mode: 0o600 }); }
    catch (error) { report.evidenceError = String(error.code || 'write-failed').slice(0, 60); }
  };
  const fail = (reason, error) => {
    if (report.status !== 'failed') report.reason = reason;
    report.status = 'failed';
    if (error) report.errorCode = String(error.code || 'error').slice(0, 60);
    decisionResolve(); save();
  };
  const signalObserver = signal => {
    try { child?.kill(signal); }
    catch (error) { report.cleanupError = String(error.code || 'signal-failed').slice(0, 60); save(); }
  };
  const cleanup = async () => {
    if (!child) { save(); return report; }
    // A native termination notification can precede delivery of this pipe's
    // final exit record. Drain briefly before requesting observer-only stop.
    if (!closed && report.registered && !terminal) await within(completion, 200);
    if (!closed) {
      try { child?.stdin?.end(); }
      catch (error) { report.cleanupError = String(error.code || 'stdin-close-failed').slice(0, 60); }
      await within(completion, 500);
    }
    if (!closed) { signalObserver('SIGTERM'); await within(completion, 150); }
    if (!closed) { signalObserver('SIGKILL'); await within(completion, 150); }
    clearTimeout(sessionTimer);
    report.cleanup = closed ? 'observer-exited' : 'observer-exit-unconfirmed';
    if (!closed) {
      child?.stdout?.destroy?.(); child?.stderr?.destroy?.(); child?.stdin?.destroy?.(); child?.unref?.();
    }
    save();
    return report;
  };
  const stop = () => stopping ??= cleanup();
  const result = { report, stop };
  if (platform !== 'darwin') {
    Object.assign(report, { status: 'blocked', reason: 'requires-macos', cleanup: 'not-started' });
    return { report, stop: async () => report };
  }
  mkdirSync(directory, { recursive: true });
  save();
  const record = text => {
    let event;
    try { event = JSON.parse(text); } catch { fail('invalid-observer-json'); return; }
    if (event?.schemaVersion !== 1 || event.kind !== 'macos-process-exit' || event.source !== 'EVFILT_PROC'
      || event.pid !== pid || !Number.isFinite(event.unixMs) || !Number.isFinite(event.elapsedMs)
      || !['registered', 'exited', 'blocked', 'failed', 'stopped', 'timeout'].includes(event.event)) {
      fail('invalid-observer-event'); return;
    }
    if (terminal || report.status === 'failed' || (event.event === 'registered' && report.registered)
      || (['exited', 'stopped', 'timeout'].includes(event.event) && !report.registered)) {
      fail('invalid-observer-event-order'); return;
    }
    const entry = { event: event.event, pid, unixMs: event.unixMs, elapsedMs: event.elapsedMs, receivedAtUnixMs: Date.now() };
    for (const field of ['reason', 'stage']) {
      if (typeof event[field] === 'string') entry[field] = event[field].slice(0, 100);
    }
    for (const field of ['errno', 'rawData', 'flags', 'fflags', 'waitStatus', 'exitCode', 'signal', 'detailFlags']) {
      if (Number.isSafeInteger(event[field]) && event[field] >= 0 && event[field] <= 0xffffffff) entry[field] = event[field];
    }
    for (const field of ['waitStatusAvailable', 'detailAvailable', 'exitedNormally', 'signaled', 'coreDumped', 'memoryExit', 'codeSigningExit', 'decryptFailure']) {
      if (typeof event[field] === 'boolean') entry[field] = event[field];
    }
    if (event.event === 'exited' && (!Number.isSafeInteger(entry.rawData) || !Number.isSafeInteger(entry.fflags)
      || typeof entry.waitStatusAvailable !== 'boolean' || typeof entry.detailAvailable !== 'boolean')) {
      fail('incomplete-exit-record'); return;
    }
    if (report.events.length < 6) report.events.push(entry);
    if (event.event === 'registered') {
      Object.assign(report, { registered: true, registeredPid: pid, registeredAtUnixMs: event.unixMs,
        registrationReceivedAtUnixMs: entry.receivedAtUnixMs, status: 'observing' });
    } else {
      terminal = true; clearTimeout(sessionTimer);
      Object.assign(report, { status: event.event, ...(entry.reason ? { reason: entry.reason } : {}) });
      if (event.event === 'exited') report.exit = entry;
    }
    decisionResolve(); save();
  };
  const data = chunk => {
    const bytes = Buffer.from(chunk);
    report.outputBytes += bytes.length;
    if (report.outputBytes > OUTPUT_LIMIT) { fail('observer-output-limit'); return; }
    pending = Buffer.concat([pending, bytes]);
    while (pending.includes(10)) {
      const index = pending.indexOf(10), line = pending.subarray(0, index);
      pending = pending.subarray(index + 1);
      if (line.length > LINE_LIMIT) { fail('observer-line-limit'); return; }
      if (line.length) record(line.toString('utf8'));
    }
    if (pending.length > LINE_LIMIT) { pending = Buffer.alloc(0); fail('observer-line-limit'); }
  };
  try {
    child = spawnProcess(helper, ['--observe-exit', String(pid), '--timeout-ms', String(observationTimeoutMs)],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', error => fail('observer-process-error', error));
    child.stdin.on('error', error => { report.controlError = String(error.code || 'stdin-error').slice(0, 60); save(); });
    child.stdout.on('data', data);
    child.stderr.on('data', chunk => {
      report.outputBytes += Buffer.byteLength(chunk);
      report.stderrTail = `${report.stderrTail || ''}${Buffer.from(chunk).toString('utf8')}`.slice(-1000);
      if (report.outputBytes > OUTPUT_LIMIT) fail('observer-output-limit');
    });
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(sessionTimer);
      Object.assign(report, { observerExitCode: code, observerExitSignal: signal, cleanup: 'observer-exited' });
      if (!terminal && report.status !== 'failed') fail('observer-exited-without-final-record');
      closeResolve(); decisionResolve(); save();
    });
  } catch (error) {
    closed = true; report.cleanup = 'not-started'; fail('observer-spawn-failed', error); closeResolve();
    return result;
  }
  sessionTimer = setTimeout(() => { fail('observer-session-deadline'); void stop(); }, observationTimeoutMs + registrationTimeoutMs);
  if (!await within(decision, registrationTimeoutMs)) fail('observer-registration-timeout');
  if (report.status !== 'observing' && !closed) await stop();
  return result;
}
