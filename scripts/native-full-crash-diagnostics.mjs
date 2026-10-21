// Diagnostic orchestration only: execute the unmodified full native smoke once,
// keeping bounded OS evidence around it. This never publishes or accepts a release.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runNativeSmoke } from './native-smoke.mjs';
import { captureStream, collectCrashReports } from './macos-editing-diagnostic.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = join(root, 'artifacts', 'native-full-crash');
mkdirSync(directory, { recursive: true });
const started = Date.now();
const write = (name, value) => writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
const delay = ms => new Promise(done => setTimeout(done, ms));
const report = {
  schemaVersion: 1, diagnosticOnly: true, releaseAcceptance: false, ok: false, status: 'failed',
  commit: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null,
  startedAt: new Date(started).toISOString(), processSamples: [], systemMemorySamples: [], gaps: [],
  limitations: ['One diagnostic full smoke does not accept a release.',
    'Sampled WebKit processes can belong to other applications; RSS does not establish the cause of a termination.',
    'Absence of an IPS report does not prove that WebContent survived.'],
};
const safeCommand = (program, args) => {
  const result = spawnSync(program, args, { shell: false, encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024 });
  return result.status === 0 && !result.signal && !result.error ? result.stdout : null;
};
let log, finishLog, timer, smoke, lastMemory = 0;
const sample = () => {
  const now = Date.now();
  const processes = safeCommand('/bin/ps', ['-axo', 'pid,ppid,rss,pcpu,comm']);
  if (processes !== null) {
    // Keep the original fixed ps columns for the existing bounded inspector.
    const rows = processes.split('\n').filter(row => /open-office|WebContent|WebKit|GPU/.test(row)).slice(0, 40);
    report.processSamples.push({ unixMs: now, rows });
    if (report.processSamples.length > 700) report.processSamples.shift();
  }
  if (now - lastMemory >= 2000) {
    lastMemory = now;
    const output = safeCommand('/usr/bin/vm_stat', []);
    const values = {};
    const fields = new Map([
      ['Pages free', 'free'], ['Pages active', 'active'], ['Pages inactive', 'inactive'],
      ['Pages speculative', 'speculative'], ['Pages wired down', 'wired'],
      ['Pages occupied by compressor', 'compressor'], ['Swapins', 'swapins'], ['Swapouts', 'swapouts'],
    ]);
    for (const line of (output || '').split('\n')) {
      const match = /^([^:]+):\s*(\d+)\.?$/.exec(line.trim());
      if (match && fields.has(match[1]) && Number.isSafeInteger(Number(match[2]))) values[fields.get(match[1])] = Number(match[2]);
    }
    const pageSize = /page size of (\d+) bytes/.exec(output || '');
    report.systemMemorySamples.push({ unixMs: now, pageSize: pageSize ? Number(pageSize[1]) : null, pages: values });
    if (report.systemMemorySamples.length > 180) report.systemMemorySamples.shift();
  }
};
try {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  assert.match(report.commit || '', /^[a-f0-9]{40}$/);
  assert.match(report.runId || '', /^\d{1,20}$/);
  report.system = { swVers: safeCommand('/usr/bin/sw_vers', [])?.trim(), machine: 'arm64', node: process.version,
    memoryBytes: Number(safeCommand('/usr/sbin/sysctl', ['-n', 'hw.memsize'])?.trim()) || null };
  const predicate = 'process == "open-office" OR process CONTAINS "WebContent" OR process CONTAINS "WebKit" OR process == "ReportCrash" OR subsystem BEGINSWITH "com.apple.WebKit" OR (process == "kernel" AND eventMessage CONTAINS[c] "memorystatus") OR (process == "runningboardd" AND eventMessage CONTAINS[c] "WebContent")';
  log = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--level', 'debug', '--predicate', predicate], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  finishLog = captureStream(log, join(directory, 'system-webkit.ndjson'), 8 * 1024 * 1024);
  sample(); timer = setInterval(sample, 500);
  smoke = await runNativeSmoke(process.argv.slice(2), { ...process.env, OPEN_OFFICE_SMOKE_SCOPE: 'full' }, root);
  report.nativeDiagnostics = smoke.nativeDiagnostics;
  report.process = smoke.process;
  report.frontend = { ok: smoke.frontend?.ok === true, error: smoke.frontend?.error || null };
  if (smoke.nativeDiagnostics) write('native-diagnostics.json', smoke.nativeDiagnostics);
  // Keep the full smoke evidence in its existing artifact file, not twice here.
  const lifecycleClean = smoke.nativeDiagnostics?.generation === 1 && smoke.nativeDiagnostics?.terminations === 0;
  report.ok = smoke.ok === true && lifecycleClean;
  report.status = report.ok ? 'passed' : 'failed';
  if (!report.ok) report.error = !lifecycleClean ? 'Native full smoke did not preserve a single WebContent lifetime.' : 'Native full smoke failed; see its bounded phase summary.';
} catch {
  report.error = 'Diagnostic orchestration could not finish; retained evidence may be incomplete.';
} finally {
  clearInterval(timer);
  sample();
  const terminated = report.nativeDiagnostics?.terminations > 0;
  if (terminated && finishLog) report.systemLog = finishLog(undefined, { reset: true });
  try { report.crashReports = await collectCrashReports(started, directory, { terminated }); }
  catch { report.gaps.push('crash-report-collection-failed'); }
  if (log) {
    log.kill('SIGTERM'); await delay(150);
    if (log.exitCode === null) log.kill('SIGKILL');
  }
  if (finishLog) {
    if (report.systemLog) report.reportCrashLog = finishLog(join(directory, 'system-reportcrash.ndjson'));
    else report.systemLog = finishLog();
  }
  report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - started;
  write('report.json', report);
}
console.log(`Native full smoke crash diagnostic: ${report.status}; diagnostic only.`);
process.exitCode = report.ok ? 0 : 1;
