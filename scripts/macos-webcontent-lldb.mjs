import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const TRACE_LIMIT = 1024 * 1024;
const CONTROLLER_LIMIT = 8192;
const LINE_LIMIT = 8192;
function waitWithin(promise, milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

// This is executed by LLDB's own Python interpreter, not the system Python.
// SetWaitForLaunch(false, true) selects asynchronous attach without waiting for
// a new process or looking one up by name. See SBAttachInfo / SBTarget::Attach.
function debuggerProgram(configuration) {
  return `import json, os, time, lldb
cfg = json.loads(${JSON.stringify(JSON.stringify(configuration))})
prefix = cfg['prefix']
process = None
attached = False
ready = False
cleanup = 'not-attached'
debugger = lldb.debugger

def emit(event, **fields):
    print(prefix + json.dumps(dict(event=event, pid=cfg['pid'], **fields)), flush=True)

def cancelled():
    return os.path.exists(cfg['stopFile'])

def describe(error):
    return str(error.GetCString() or 'unknown LLDB error')[:1500]

def command(text, limit):
    result = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand(text, result)
    print('\\n--- ' + text + ' ---', flush=True)
    for value in [result.GetOutput(), result.GetError()]:
        if value:
            data = value.encode('utf-8', errors='replace')
            print(data[:limit].decode('utf-8', errors='replace'), flush=True)
            if len(data) > limit:
                print('[command output truncated]', flush=True)

def drain(listener):
    # Reading events updates SBProcess's public state. No unbounded blocking
    # WaitForEvent call; the outer controller owns the absolute timeout.
    event = lldb.SBEvent()
    for _ in range(128):
        if not listener.GetNextEvent(event):
            break

try:
    debugger.SetAsync(True)
    setting = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand('settings set target.detach-on-error true', setting)
    if not setting.Succeeded():
        emit('blocked', reason='detach-safety-setting-unavailable', detail=str(setting.GetError() or '')[:1500])
    else:
        emit('initialized')
        target = debugger.CreateTarget('')
        listener = lldb.SBListener('open-office-webcontent-diagnostic')
        info = lldb.SBAttachInfo(cfg['pid'])
        info.SetWaitForLaunch(False, True)
        info.SetListener(listener)
        error = lldb.SBError()
        process = target.Attach(info, error)
        if error.Fail():
            # Failed asynchronous setup may still have allocated a process.
            process = target.GetProcess()
            emit('blocked', reason='attach-denied-or-unavailable', detail=describe(error))
        else:
            deadline = time.monotonic() + cfg['attachSeconds']
            while time.monotonic() < deadline and not cancelled():
                drain(listener)
                state = process.GetState()
                if state in [lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid]:
                    emit('blocked', reason='attach-ended-before-stop', detail=str(process.GetExitDescription() or '')[:1500])
                    break
                if state == lldb.eStateStopped:
                    if process.GetProcessID() != cfg['pid']:
                        emit('failed', reason='attached-pid-mismatch')
                        break
                    attached = True
                    emit('attached')
                    resumed = process.Continue()
                    if resumed.Fail():
                        emit('failed', reason='continue-failed', detail=describe(resumed))
                        break
                    while time.monotonic() < deadline and not cancelled():
                        drain(listener)
                        state = process.GetState()
                        if state == lldb.eStateRunning:
                            ready = True
                            emit('ready')
                            break
                        if state in [lldb.eStateExited, lldb.eStateDetached, lldb.eStateCrashed]:
                            emit('failed', reason='target-ended-before-ready')
                            break
                        time.sleep(0.02)
                    break
                time.sleep(0.02)
            if not ready and not cancelled() and time.monotonic() >= deadline:
                emit('failed', reason='attach-timeout')
            if ready:
                deadline = time.monotonic() + cfg['sessionSeconds']
                while time.monotonic() < deadline and not cancelled():
                    drain(listener)
                    state = process.GetState()
                    if state in [lldb.eStateExited, lldb.eStateDetached]:
                        emit('target-ended', state=state)
                        break
                    if state in [lldb.eStateStopped, lldb.eStateCrashed]:
                        reasons = []
                        for index in range(min(process.GetNumThreads(), 64)):
                            thread = process.GetThreadAtIndex(index)
                            reason = thread.GetStopReason()
                            if reason not in [lldb.eStopReasonNone, lldb.eStopReasonInvalid]:
                                reasons.append(dict(thread=thread.GetThreadID(), reason=reason,
                                    description=str(thread.GetStopDescription(1024) or '')[:1024]))
                        emit('stopped', state=state, reasons=reasons[:4])
                        command('thread backtrace all -c 32', 512 * 1024)
                        command('register read --all', 64 * 1024)
                        command('image list -o -f', 256 * 1024)
                        emit('captured')
                        break
                    time.sleep(0.02)
                if not cancelled() and time.monotonic() >= deadline:
                    emit('failed', reason='session-deadline')
except BaseException as error:
    emit('failed', reason='lldb-python-error', detail=str(error)[:1500])
finally:
    if process is not None and process.IsValid():
        state = process.GetState()
        if state == lldb.eStateExited:
            cleanup = 'target-exited'
        elif state == lldb.eStateDetached:
            cleanup = 'detached'
        elif state == lldb.eStateInvalid and attached:
            cleanup = 'unconfirmed'
        elif state != lldb.eStateInvalid:
            # Detach(false) resumes a stopped inferior. Never Kill/Destroy or
            # send signals to the target, including during cancellation.
            detached = process.Detach(False)
            cleanup = 'detached' if detached.Success() else 'detach-failed'
            if detached.Fail():
                emit('cleanup-error', detail=describe(detached))
    emit('finished', cleanup=cleanup)
`;
}

/** Diagnostic only: this changes timing and is never release acceptance proof.
 * A blocked attach may continue without a debugger only when safeToContinue is
 * true. A failed/uncertain cleanup must abort native input. stop()/finish() are
 * the same idempotent bounded cleanup operation; neither signals the target.
 */
export async function startWebContentDebugger({ pid, directory, attachTimeoutMs = 8000,
  stopTimeoutMs = 1500, sessionTimeoutMs = 180000, platform = process.platform, spawnProcess = spawn } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid, 'Expected a distinct, exact WebContent PID');
  assert.ok(typeof directory === 'string' && isAbsolute(directory), 'Expected an absolute evidence directory');
  assert.ok(Number.isFinite(attachTimeoutMs) && attachTimeoutMs >= 100 && attachTimeoutMs <= 8000);
  assert.ok(Number.isFinite(stopTimeoutMs) && stopTimeoutMs >= 50 && stopTimeoutMs <= 2000);
  assert.ok(Number.isFinite(sessionTimeoutMs) && sessionTimeoutMs >= 100 && sessionTimeoutMs <= 180000);
  const report = { schemaVersion: 1, diagnosticOnly: true, kind: 'macos-webcontent-lldb', pid,
    status: 'starting', ready: false, safeToContinue: false, cleanup: 'pending', attachAttempts: 0,
    events: [], trace: { file: null, limitBytes: TRACE_LIMIT, bytes: 0, totalBytes: 0, truncated: false } };
  const inert = () => ({ report, stop: async () => report, finish: async () => report });
  if (platform !== 'darwin') {
    Object.assign(report, { status: 'blocked', reason: 'requires-macos', safeToContinue: true, cleanup: 'not-started' });
    return inert();
  }

  mkdirSync(directory, { recursive: true });
  const work = mkdtempSync(join(directory, 'webcontent-lldb-'));
  const tracePath = join(work, 'trace.txt'), scriptPath = join(work, 'controller.py'), stopFile = join(work, 'stop');
  const prefix = `OO_LLDB_${randomUUID()}:`;
  const reserveMs = Math.min(500, attachTimeoutMs / 4);
  writeFileSync(scriptPath, debuggerProgram({ pid, prefix, stopFile,
    attachSeconds: (attachTimeoutMs - reserveMs) / 1000, sessionSeconds: sessionTimeoutMs / 1000 }), { flag: 'wx', mode: 0o600 });
  report.trace.file = relative(directory, tracePath);
  const chunks = [], controllerChunks = [];
  let child, spawned = false, closed = false, initialized = false, attached = false, readyResolve, closeResolve, stopping;
  let childBytes = 0, controllerBytes = 0, signalAttempt;
  let line = Buffer.alloc(0), discardLine = false, decisionResolved = false;
  const decision = new Promise(resolve => { readyResolve = resolve; });
  const completion = new Promise(resolve => { closeResolve = resolve; });
  const decide = () => { if (!decisionResolved) { decisionResolved = true; readyResolve(); } };
  const fail = reason => {
    if (report.status !== 'failed') report.reason = reason;
    report.status = 'failed'; report.safeToContinue = false;
  };
  const save = () => {
    try {
      // Keep controller failure evidence even if LLDB has exhausted its output
      // budget. These tagged lines are written directly, never parsed as child
      // readiness/cleanup markers.
      const body = Buffer.concat(chunks).subarray(0, TRACE_LIMIT - controllerBytes);
      const output = Buffer.concat([body, ...controllerChunks]);
      report.trace.bytes = output.length;
      writeFileSync(tracePath, output, { mode: 0o600 });
    } catch (error) {
      report.evidenceError = String(error.code || 'trace-write-error').slice(0, 80);
      fail('debugger-evidence-write-failed');
    }
  };
  const capture = chunk => {
    const bytes = Buffer.from(chunk);
    report.trace.totalBytes += bytes.length;
    const remaining = TRACE_LIMIT - childBytes;
    if (remaining > 0) { chunks.push(Buffer.from(bytes.subarray(0, remaining))); childBytes += Math.min(bytes.length, remaining); }
    report.trace.bytes = Math.min(TRACE_LIMIT, childBytes + controllerBytes);
    report.trace.truncated = report.trace.totalBytes > TRACE_LIMIT;
  };
  const controllerError = (operation, error) => {
    // Cap record count and encoded bytes, including non-ASCII JSON escaping.
    if (controllerChunks.length < 8) {
      const event = { event: 'controller-error', source: 'controller', pid, operation,
        code: String(error.code || 'error').slice(0, 40), syscall: String(error.syscall || '').slice(0, 80),
        detail: String(error.message || error).slice(0, 500) };
      const bytes = Buffer.from(`\n${prefix}${JSON.stringify(event)}\n`);
      if (controllerBytes + bytes.length <= CONTROLLER_LIMIT) {
        controllerChunks.push(bytes); controllerBytes += bytes.length;
        report.trace.totalBytes += bytes.length;
        report.trace.truncated = report.trace.totalBytes > TRACE_LIMIT;
        if (report.events.length < 24) report.events.push(event);
      }
    }
    save();
  };
  const processError = (error, operation = signalAttempt ? 'kill' : 'process') => {
    // Node also emits child 'error' for kill(EPERM). Lack of an LLDB marker
    // proves nothing about whether xcrun/LLDB already owns a target process.
    const neverSpawned = operation === 'process' && !spawned && child?.pid === undefined
      && !initialized && !attached && /^spawn(?:\s|$)/.test(String(error.syscall || ''));
    if (neverSpawned) {
      Object.assign(report, { status: 'blocked', reason: `debugger-spawn-${String(error.code || 'error').slice(0, 40)}`,
        safeToContinue: true, cleanup: 'not-started' });
      closed = true; closeResolve();
    } else fail(`debugger-${operation}-${String(error.code || 'error').slice(0, 40)}`);
    controllerError(neverSpawned ? 'spawn' : operation, error);
    decide();
  };
  const signalDebugger = signal => {
    signalAttempt = signal;
    try { child.kill(signal); }
    catch (error) { processError(error, 'kill'); }
    finally { signalAttempt = undefined; }
  };
  const marker = value => {
    if (!value.startsWith(prefix)) return;
    let event;
    try { event = JSON.parse(value.slice(prefix.length)); } catch { fail('invalid-debugger-marker'); return; }
    if (event.pid !== pid || typeof event.event !== 'string') { fail('debugger-marker-pid-mismatch'); return; }
    if (report.events.length < 24) report.events.push({ event: event.event,
      ...(event.reason ? { reason: String(event.reason).slice(0, 100) } : {}),
      ...(event.detail ? { detail: String(event.detail).slice(0, 1500) } : {}),
      ...(Array.isArray(event.reasons) ? { reasons: event.reasons.slice(0, 4) } : {}) });
    if (event.event === 'initialized') initialized = true;
    else if (event.event === 'attached') {
      if (!initialized || attached) fail('invalid-attach-marker-order');
      else attached = true;
    } else if (event.event === 'ready') {
      if (!initialized || !attached || report.ready || report.status === 'failed') fail('invalid-ready-marker-order');
      else { Object.assign(report, { status: 'attached', ready: true, safeToContinue: true }); decide(); }
    } else if (event.event === 'blocked') {
      if (attached || report.ready) fail('blocked-after-attach');
      else if (report.status !== 'failed') Object.assign(report, { status: 'blocked', reason: String(event.reason || 'attach-blocked').slice(0, 100) });
    } else if (event.event === 'failed') fail(String(event.reason || 'debugger-failed').slice(0, 100));
    else if (event.event === 'stopped' || event.event === 'target-ended') report.safeToContinue = false;
    else if (event.event === 'captured') report.captured = true;
    else if (event.event === 'finished') {
      report.cleanup = ['not-attached', 'detached', 'target-exited', 'detach-failed'].includes(event.cleanup) ? event.cleanup : 'unconfirmed';
      report.safeToContinue = report.status === 'blocked' && ['not-attached', 'detached'].includes(report.cleanup);
      if (report.cleanup === 'detach-failed' || report.cleanup === 'unconfirmed') fail('debugger-cleanup-unconfirmed');
    }
  };
  const stdout = chunk => {
    capture(chunk);
    const data = Buffer.from(chunk);
    for (let start = 0; start < data.length;) {
      const newline = data.indexOf(10, start), end = newline < 0 ? data.length : newline;
      if (!discardLine) {
        if (line.length + end - start > LINE_LIMIT) { line = Buffer.alloc(0); discardLine = true; }
        else line = Buffer.concat([line, data.subarray(start, end)]);
      }
      if (newline < 0) break;
      if (!discardLine) marker(line.toString('utf8').replace(/\r$/, ''));
      line = Buffer.alloc(0); discardLine = false; start = newline + 1;
    }
  };
  const cleanup = async (timeoutMs = stopTimeoutMs) => {
    if (closed) { save(); return report; }
    try { writeFileSync(stopFile, 'detach\n', { mode: 0o600 }); }
    catch (error) { processError(error, 'stop-file'); }
    const gracefulMs = Math.max(0, timeoutMs - Math.min(250, timeoutMs / 2));
    await waitWithin(completion, gracefulMs);
    if (!closed) {
      // Only the debugger child is signalled. target.detach-on-error was set
      // before attach; forced cleanup still cannot count as confirmed detach.
      signalDebugger('SIGINT');
      await waitWithin(completion, timeoutMs - gracefulMs);
    }
    if (!closed) {
      signalDebugger('SIGKILL');
      report.cleanup = 'unconfirmed'; fail('debugger-cleanup-timeout');
      child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.();
    }
    save();
    return report;
  };
  const stop = () => stopping ??= cleanup();
  try {
    // No shell, sudo, process-name matching, lldbinit, signing or security changes.
    child = spawnProcess('/usr/bin/xcrun', ['lldb', '--no-lldbinit', '--batch', '-o',
      `script exec(compile(open(${JSON.stringify(scriptPath)}, 'r').read(), ${JSON.stringify(scriptPath)}, 'exec'))`],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    report.attachAttempts = 1;
    child.once('spawn', () => { spawned = true; });
    // Persistent: both SIGINT and a subsequent SIGKILL can emit EPERM.
    child.on('error', error => processError(error));
    child.once('close', (code, signal) => {
      closed = true; report.exitCode = code; report.signal = signal;
      if (report.cleanup === 'pending') { report.cleanup = 'unconfirmed'; fail('debugger-exited-without-cleanup'); }
      closeResolve(); decide(); save();
    });
    child.stdout.on('data', stdout);
    child.stderr.on('data', capture);
  } catch (error) {
    if (child) processError(error, 'setup');
    else {
      Object.assign(report, { status: 'blocked', reason: `debugger-spawn-${String(error.code || 'error').slice(0, 40)}`,
        safeToContinue: true, cleanup: 'not-started' });
      closed = true; controllerError('spawn', error); return inert();
    }
  }
  const decided = await waitWithin(decision, attachTimeoutMs - reserveMs);
  if (!decided) {
    fail('attach-timeout');
    controllerError('attach-timeout', { code: 'ETIMEDOUT', message: 'Debugger did not confirm attach and running state before the deadline' });
  }
  if (!report.safeToContinue && !closed) {
    stopping = cleanup(reserveMs);
    await stopping;
  }
  save();
  return { report, stop, finish: stop };
}
