// Diagnostic-only OS ownership probe. Unknown output is a gap, never a guessed PID.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { startWebContentExitObserver } from './macos-webcontent-exit.mjs';

const run = promisify(execFile);
const pidValid = value => Number.isSafeInteger(value) && value > 1 && value <= 0x7fffffff;
export function responsiblePid(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) return null;
  const matches = [...text.matchAll(/^\s*responsible pid\s*[:=]\s*(\d{1,10})\s*$/gim)];
  if (matches.length !== 1) return null;
  const pid = Number(matches[0][1]);
  return pidValid(pid) ? pid : null;
}
export function webContentPids(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) return [];
  return [...new Set(text.split('\n').flatMap(line => {
    const match = /^\s*(\d{1,10})\s+(.+)$/.exec(line);
    if (!match || !/(?:^|\/)com\.apple\.WebKit\.WebContent$/.test(match[2])) return [];
    const pid = Number(match[1]);
    return pidValid(pid) ? [pid] : [];
  }))].slice(0, 16);
}

export function observeOwnedWebContent({ appPid, helper, directory, platform = process.platform,
  execute = run, observe = startWebContentExitObserver } = {}) {
  assert(pidValid(appPid)); assert(isAbsolute(helper)); assert(isAbsolute(directory));
  const report = { schemaVersion: 1, diagnosticOnly: true, appPid,
    ownershipSource: 'launchctl-procinfo-responsible-pid', status: 'searching',
    candidateCount: 0, ownershipUnavailableCount: 0, unrelatedCount: 0,
    targets: [], limitations: ['OS responsibility associates the WebContent process with the app, not with a specific WKWebView.',
      'An observed exit after app shutdown is not proof of a renderer crash.', 'A signal alone does not establish its cause.'] };
  const sessions = [], seen = new Set();
  let stopped = false, pending, timer, polls = 0;
  mkdirSync(directory, { recursive: true });
  const save = () => writeFileSync(join(directory, 'owned-webcontent.json'), JSON.stringify(report) + '\n');
  const command = async (program, args, maxBuffer) => {
    try { return (await execute(program, args, { shell: false, encoding: 'utf8', timeout: 1200, maxBuffer })).stdout; }
    catch { return null; }
  };
  const poll = async () => {
    if (stopped || ++polls > 1500 || sessions.length >= 4) return;
    const output = await command('/bin/ps', ['-axo', 'pid=,comm='], 256 * 1024);
    for (const pid of webContentPids(output)) {
      if (stopped || seen.has(pid) || seen.size >= 32 || sessions.length >= 4) continue;
      seen.add(pid); report.candidateCount++;
      // procinfo is read-only. sudo is non-interactive and invokes only this fixed query.
      const info = await command('/usr/bin/sudo', ['-n', '/bin/launchctl', 'procinfo', String(pid)], 64 * 1024);
      const owner = responsiblePid(info);
      if (owner === null) { report.ownershipUnavailableCount++; continue; }
      if (owner !== appPid) { report.unrelatedCount++; continue; }
      // Re-read the executable name before registering, reducing PID-reuse ambiguity.
      const current = await command('/bin/ps', ['-p', String(pid), '-o', 'pid=,comm='], 4096);
      if (!webContentPids(current).includes(pid) || stopped) continue;
      const session = await observe({ pid, helper, directory: join(directory, `pid-${pid}`), observationTimeoutMs: 180000 });
      sessions.push(session);
      report.targets.push({ pid, responsiblePid: owner, ownershipVerified: true, associatedAtUnixMs: Date.now(),
        observer: session.report });
      report.status = session.report.registered ? 'observing' : 'observer-blocked';
    }
    save();
  };
  const tick = () => { if (!pending && !stopped) pending = poll().catch(() => {
    report.status = 'probe-failed'; save();
  }).finally(() => { pending = null; }); };
  if (platform !== 'darwin') report.status = 'requires-macos';
  else { tick(); timer = setInterval(tick, 200); }
  save();
  let stopping;
  const stop = () => stopping ??= (async () => {
    stopped = true; clearInterval(timer); await pending;
    for (const session of sessions) await session.stop();
    if (!sessions.length && platform === 'darwin') report.status = 'no-verified-owned-webcontent';
    report.stoppedAtUnixMs = Date.now(); save(); return report;
  })();
  return { report, stop };
}
