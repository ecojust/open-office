import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectInstalledWordcraft, validateNativeWordcraftEvidence, validateWordcraftNativeReport } from './wordcraft-native-smoke.mjs';
import { inspectInstalledGridcraft, validateNativeGridcraftEvidence, validateGridcraftNativeReport } from './gridcraft-native-smoke.mjs';
import { inspectInstalledDeckcraft, validateNativeDeckcraftEvidence, validateDeckcraftNativeReport } from './deckcraft-native-smoke.mjs';

// This launches the final packaged GUI, not a source executable or an isolated
// engine substitute. A native desktop session is required on the CI runner.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 300_000;
const MAX_REPORT_BYTES = 12 * 1024 * 1024;
const STREAM_TAIL_BYTES = 32 * 1024;
const PLATFORMS = Object.freeze({
  'windows-x64': { os: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc' },
  'macos-x64': { os: 'darwin', arch: 'x64', nativeArch: 'x86_64', target: 'x86_64-apple-darwin' },
  'macos-arm64': { os: 'darwin', arch: 'arm64', nativeArch: 'arm64', target: 'aarch64-apple-darwin' },
});

function requireCheck(value, message) {
  assert.ok(value, message);
}

export function selectExecution(platformId, target, hostPlatform, hostArch, allowRosetta) {
  const configuration = PLATFORMS[platformId];
  requireCheck(configuration, 'OPEN_OFFICE_PLATFORM_ID must be windows-x64, macos-x64, or macos-arm64');
  requireCheck(target === configuration.target, 'OPEN_OFFICE_TARGET does not match the selected platform');
  requireCheck(hostPlatform === configuration.os, 'Native smoke tests must run on the matching operating system');
  if (hostArch === configuration.arch) {
    return { targetArch: configuration.arch, hostArch, executionMode: 'native' };
  }
  requireCheck(allowRosetta === '1' && platformId === 'macos-x64'
    && target === 'x86_64-apple-darwin' && hostPlatform === 'darwin' && hostArch === 'arm64',
  'Host and target CPU architectures differ; only explicitly enabled Intel macOS on a native Apple Silicon Node host may use Rosetta 2');
  return { targetArch: 'x64', hostArch: 'arm64', executionMode: 'rosetta2' };
}

export function validateRosettaProbe(probe) {
  requireCheck(probe.hardwareArm64 === '1', 'Rosetta validation requires actual Apple Silicon hardware');
  requireCheck(probe.nodeProcessTranslated === '0', 'Rosetta validation must be orchestrated by native ARM Node, not translated Node');
  requireCheck(probe.x86ProbeTranslated === '1', 'The explicitly launched x86_64 probe is not running under Rosetta 2');
  return { hardwareArm64: 1, nodeProcessTranslated: 0, x86ProbeTranslated: 1, verified: true };
}

export function guiLaunchCommand(executable, executionMode) {
  requireCheck(executionMode === 'native' || executionMode === 'rosetta2', 'Unknown native GUI execution mode');
  return executionMode === 'rosetta2'
    ? { command: '/usr/bin/arch', args: ['-x86_64', executable] }
    : { command: executable, args: [] };
}

export function appendLogTail(previous, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (bytes.length >= STREAM_TAIL_BYTES) return Buffer.from(bytes.subarray(-STREAM_TAIL_BYTES));
  return Buffer.from(Buffer.concat([previous, bytes]).subarray(-STREAM_TAIL_BYTES));
}

export function decodeLogTail(bytes) {
  // Normalize potentially split/invalid UTF-8 first, then bound the encoded text
  // again so replacement characters cannot enlarge the artifact beyond 32 KiB.
  const utf8 = Buffer.from(bytes.toString('utf8'));
  let offset = Math.max(0, utf8.length - STREAM_TAIL_BYTES);
  while (offset < utf8.length && (utf8[offset] & 0xc0) === 0x80) offset++;
  return utf8.subarray(offset).toString('utf8');
}

export function escapeWorkflowCommand(value) {
  // GitHub decodes command data after identifying its physical line. Escape '%' first.
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function shortDiagnostic(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, limit);
}

export function emitFailureDiagnostics(report, env, reportPath) {
  const phase = report.frontend?.phase ?? report.phase;
  const lastNativeEvent = Array.isArray(report.nativeDiagnostics?.events) ? report.nativeDiagnostics.events.at(-1) : null;
  const lines = [
    `Open Office native GUI smoke failed (${shortDiagnostic(report.platformId, 40)}).`,
    `Phase: ${phase == null ? 'not reported' : shortDiagnostic(phase, 160)}`,
    `Reason: ${shortDiagnostic(report.errors?.[0] || 'No diagnostic reason was recorded', 1000)}`,
  ];
  if (lastNativeEvent?.phase != null) {
    lines.push(`Last native phase: ${shortDiagnostic(lastNativeEvent.phase, 160)}`);
    if (lastNativeEvent.detail != null) lines.push(`Native detail: ${shortDiagnostic(lastNativeEvent.detail, 400)}`);
  }
  if (report.frontend?.error != null) lines.push(`Frontend error: ${shortDiagnostic(report.frontend.error, 1000)}`);
  lines.push(`Process: exit=${report.process?.exitCode ?? 'none'}, signal=${shortDiagnostic(report.process?.signal || 'none', 40)}, timedOut=${report.process?.timedOut === true}`);
  lines.push(`Detailed diagnostics and log tails: artifacts/${basename(reportPath)}`);
  const message = lines.join('\n');
  console.error(`::error title=Open Office native GUI smoke::${escapeWorkflowCommand(message)}`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      requireCheck(isAbsolute(env.GITHUB_STEP_SUMMARY), 'GITHUB_STEP_SUMMARY must be an absolute path');
      const html = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### Open Office native GUI smoke failed\n\n<pre>${html}</pre>\n`, 'utf8');
    } catch (error) {
      const safeCode = shortDiagnostic(error?.code || error?.name || 'unknown error', 80);
      console.error(`::error title=Open Office smoke summary::${escapeWorkflowCommand(`Could not append GITHUB_STEP_SUMMARY (${safeCode}); the diagnostic artifact is preserved.`)}`);
    }
  }
}

/** Require the actual three mounted Rust editors and the retained PDF engine. */
export function validateFrontendReport(report) {
  requireCheck(report && typeof report === 'object' && !Array.isArray(report), 'Missing native frontend report');
  requireCheck(report.ok === true, 'The native GUI reported a failed smoke test');
  requireCheck(report.crossOriginIsolated === true, 'Native WebView is not cross-origin isolated');
  requireCheck(report.sharedArrayBuffer === true, 'SharedArrayBuffer is unavailable in the native WebView');
  requireCheck(typeof report.userAgent === 'string' && report.userAgent.length > 10, 'Missing native WebView user agent');
  validateWordcraftNativeReport(report.wordcraft);
  validateGridcraftNativeReport(report.gridcraft);
  validateDeckcraftNativeReport(report.deckcraft);

  const pdf = report.pdf;
  requireCheck(pdf?.ok === true && pdf.reopened === true, 'The bundled PDF engine did not reopen its edited output');
  requireCheck(pdf.removedOldText === true && pdf.newTextPresent === true, 'PDF original-text replacement checks failed');
  requireCheck(pdf.metadata?.pageCount === 1, 'PDF round-trip page count is incorrect');
  requireCheck(typeof pdf.text === 'string'
    && pdf.text.includes('NEW_NATIVE_TEXT') && pdf.text.includes('新的合同')
    && !pdf.text.includes('OLD_NATIVE_TEXT') && !pdf.text.includes('旧合同'), 'PDF reopened text does not match the replacement fixture');

  return {
    wordcraftDefaultCanvas: true, wordcraftDomInput: true, wordcraftDocxReadback: true,
    wordcraftFailureAtomicity: true, wordcraftSessionCleanup: true,
    gridcraftDefaultCanvas: true, gridcraftDomInput: true, gridcraftXlsxReadback: true,
    gridcraftFormulaRoundTrip: true, gridcraftFailureAtomicity: true, gridcraftSessionCleanup: true,
    deckcraftDefaultCanvas: true, deckcraftDomInput: true, deckcraftPptxReadback: true,
    deckcraftPdfReadback: true, deckcraftFailureAtomicity: true, deckcraftSessionCleanup: true,
    crossOriginIsolated: true, sharedArrayBuffer: true,
    pdfOriginalTextReplacementRoundTrip: true,
  };
}

function hashFile(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    let bytes;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}

function containedFile(root, path) {
  const canonicalRoot = realpathSync(root), actual = realpathSync(path);
  const difference = relative(canonicalRoot, actual);
  requireCheck(difference && !difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference), 'A required application file escapes its installed layout');
  requireCheck(statSync(actual).isFile(), `Required application file is not a regular file: ${basename(path)}`);
  return actual;
}

/** Verify a real AMD64 PE32+ file rather than accepting a .exe filename. */
export function verifyWindowsExecutable(path) {
  const descriptor = openSync(path, 'r');
  try {
    const size = statSync(path).size, dos = Buffer.alloc(64);
    requireCheck(size >= 90 && readSync(descriptor, dos, 0, dos.length, 0) === dos.length, 'Windows executable has a truncated DOS header');
    requireCheck(dos.toString('ascii', 0, 2) === 'MZ', 'Windows executable is not a PE file');
    const offset = dos.readUInt32LE(0x3c), pe = Buffer.alloc(26);
    requireCheck(offset >= 64 && offset + pe.length <= size && readSync(descriptor, pe, 0, pe.length, offset) === pe.length, 'Windows executable has an invalid PE header offset');
    requireCheck(pe.readUInt32LE(0) === 0x00004550, 'Windows executable PE signature is invalid');
    requireCheck(pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b, 'Windows executable is not native AMD64 PE32+');
    const optionalHeaderBytes = pe.readUInt16LE(20);
    requireCheck(optionalHeaderBytes >= 112 && offset + 24 + optionalHeaderBytes <= size, 'Windows executable has a truncated PE32+ optional header');
    return { machine: 'AMD64', optionalHeader: 'PE32+', optionalHeaderBytes, sha256: hashFile(path), bytes: size };
  } finally { closeSync(descriptor); }
}

function nativeTool(program, args, label = basename(program)) {
  const result = spawnSync(program, args, {
    shell: false, encoding: 'utf8', timeout: 25_000, maxBuffer: 512 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal) {
    // Codesign only reads our fixed local build artifacts. Its bounded diagnostic
    // tail is necessary to identify a broken resource seal/framework remotely.
    // Fixture-only application stdout/stderr tails stay in the diagnostic artifact.
    const diagnostic = program === '/usr/bin/codesign'
      ? Buffer.from(String(result.stderr || '')).subarray(-4000).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      : '';
    throw new Error(`${label} verification failed (exit=${result.status ?? 'none'}, signal=${result.signal ?? 'none'}, code=${result.error?.code ?? 'none'})${diagnostic ? `\n${diagnostic}` : ''}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function rosettaPreflight(evidence) {
  requireCheck(process.platform === 'darwin' && process.arch === 'arm64', 'Rosetta probes require native Apple Silicon Node');
  Object.assign(evidence, {
    verified: false, nodeArchitecture: process.arch, raw: {},
    translatedProbeExecutable: '/usr/bin/arch',
    translatedProbeArguments: ['-x86_64', '/usr/sbin/sysctl', '-in', 'sysctl.proc_translated'],
  });
  evidence.raw.hardwareArm64 = nativeTool('/usr/sbin/sysctl', ['-in', 'hw.optional.arm64'], 'Apple Silicon hardware probe').trim();
  evidence.raw.nodeProcessTranslated = nativeTool('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], 'Native ARM orchestration probe').trim();
  evidence.raw.x86ProbeTranslated = nativeTool('/usr/bin/arch', ['-x86_64', '/usr/sbin/sysctl', '-in', 'sysctl.proc_translated'], 'Rosetta 2 x86_64 execution probe').trim();
  Object.assign(evidence, validateRosettaProbe(evidence.raw));
}

export function validateMacArchitectures(mainArchitectures, pdfArchitectures, nativeArch) {
  requireCheck(mainArchitectures.length === 1 && mainArchitectures[0] === nativeArch
    && pdfArchitectures.length === 1 && pdfArchitectures[0] === nativeArch,
  'Main app and PDF runtime must each contain exactly the selected macOS architecture');
}

function macPreflight(app, mainExecutable, pdfExecutable, nativeArch) {
  const signatures = [], descriptions = {}, cdHashes = {};
  for (const [label, path] of [['app', app], ['main', mainExecutable], ['pdfRuntime', pdfExecutable]]) {
    nativeTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', path], `codesign ${label} (${basename(path)})`);
    const description = nativeTool('/usr/bin/codesign', ['--display', '--verbose=4', path], `codesign ${label} metadata (${basename(path)})`);
    const cdHash = /^CDHash=([a-f0-9]{40})\s*$/mi.exec(description);
    requireCheck(cdHash, `The ${label} signature has no verifiable CodeDirectory hash`);
    descriptions[label] = description;
    cdHashes[label] = cdHash[1].toLowerCase();
    signatures.push(label);
  }
  requireCheck(cdHashes.app === cdHashes.main, 'The application bundle and main executable signature hashes differ');
  const description = descriptions.app;
  const sealed = /Sealed Resources version=(\d+)\s+rules=(\d+)\s+files=(\d+)/.exec(description);
  requireCheck(sealed && Number(sealed[1]) >= 2 && Number(sealed[3]) > 0, 'Final macOS app has no verified sealed resources');
  const plist = /Info\.plist entries=(\d+)/.exec(description);
  requireCheck(plist && Number(plist[1]) > 0, 'Final macOS app signature does not bind its Info.plist');
  requireCheck(/^Signature=adhoc\s*$/m.test(description), 'Final macOS app does not have the required ad-hoc bundle signature');
  requireCheck(!/linker-signed/i.test(description), 'Final macOS app still has a linker-only signature instead of a sealed bundle signature');
  const mainArchitectures = nativeTool('/usr/bin/lipo', ['-archs', mainExecutable]).trim().split(/\s+/);
  const pdfArchitectures = nativeTool('/usr/bin/lipo', ['-archs', pdfExecutable]).trim().split(/\s+/);
  validateMacArchitectures(mainArchitectures, pdfArchitectures, nativeArch);
  return {
    strictSignatureVerification: signatures,
    cdHashes,
    sealedResources: { version: Number(sealed[1]), rules: Number(sealed[2]), files: Number(sealed[3]) },
    signature: 'adhoc', infoPlistEntries: Number(plist[1]), linkerSigned: false,
    developerIdSigned: false, notarized: false,
    mainArchitectures, pdfArchitectures, originalAppResigned: false,
  };
}

function parseOptions(args) {
  if (args.length === 0) return {};
  requireCheck(args.length === 2 && args[0] === '--app' && isAbsolute(args[1]), 'Usage: node scripts/native-smoke.mjs [--app /absolute/path/Open Office.app]');
  return { app: args[1] };
}

function locateApplication(configuration, options, env, root) {
  let app = null, resourceRoot, executable;
  if (configuration.os === 'win32') {
    requireCheck(!options.app, '--app is only supported for a final macOS .app');
    const installed = env.OPEN_OFFICE_INSTALLED_APP;
    requireCheck(installed && isAbsolute(installed), 'OPEN_OFFICE_INSTALLED_APP must name the real NSIS installation directory; portable/source executables are not accepted');
    resourceRoot = realpathSync(installed);
    executable = containedFile(resourceRoot, join(resourceRoot, 'open-office.exe'));
  } else {
    const candidates = options.app ? [options.app] : [
      join(root, 'src-tauri', 'target', configuration.target, 'release', 'bundle', 'macos', 'Open Office.app'),
      join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Open Office.app'),
    ].filter(existsSync);
    requireCheck(candidates.length === 1, 'Select exactly one final macOS app using --app; no source/portable fallback is allowed');
    app = realpathSync(candidates[0]);
    requireCheck(app.endsWith('.app') && statSync(app).isDirectory(), 'The selected macOS application is not a .app bundle');
    executable = containedFile(app, join(app, 'Contents', 'MacOS', 'open-office'));
    resourceRoot = realpathSync(join(app, 'Contents', 'Resources'));
    containedFile(app, join(resourceRoot, 'frontend', 'index.html'));
  }
  containedFile(resourceRoot, join(resourceRoot, 'frontend', 'index.html'));
  containedFile(resourceRoot, join(resourceRoot, 'frontend', 'office', 'host.html'));
  const pdfExecutable = containedFile(resourceRoot, join(resourceRoot, 'pdf-runtime', configuration.os === 'win32' ? 'open-office-pdf.exe' : 'open-office-pdf'));
  requireCheck(statSync(join(resourceRoot, 'pdf-runtime', '_internal')).isDirectory(), 'The installed PDF runtime is missing its onedir dependencies');
  return { app, executable, resourceRoot, pdfExecutable };
}

function killTree(child, env, force = false) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT;
    requireCheck(systemRoot && isAbsolute(systemRoot), 'Cannot locate the fixed Windows system directory for taskkill');
    const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
    requireCheck(existsSync(taskkill), 'Windows taskkill is unavailable for process-tree cleanup');
    // PID is supplied by Node, not by the renderer or a shell argument string.
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, timeout: 10_000, stdio: 'ignore',
    });
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function runGui(executable, output, workingDirectory, env, diagnostic, executionMode = 'native') {
  return new Promise((resolvePromise, reject) => {
    const launch = guiLaunchCommand(executable, executionMode);
    const child = spawn(launch.command, launch.args, {
      cwd: workingDirectory, shell: false, detached: process.platform !== 'win32', windowsHide: false,
      env: { ...env, OPEN_OFFICE_SMOKE: '1', OPEN_OFFICE_SMOKE_OUTPUT: output },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    diagnostic.launchExecutable = launch.command;
    diagnostic.launchArguments = launch.args;
    diagnostic.pid = child.pid ?? null;
    const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
    const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    diagnostic.stdoutBytes = 0; diagnostic.stderrBytes = 0;
    let finished = false, forceTimer, cleanupTimer;
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', chunk => {
        if (finished) return;
        diagnostic[`${stream}Bytes`] += chunk.length;
        hashes[stream].update(chunk);
        tails[stream] = appendLogTail(tails[stream], chunk);
      });
    }
    const timeout = setTimeout(() => {
      diagnostic.timedOut = true;
      try { killTree(child, env); } catch { diagnostic.cleanupError = 'Could not terminate the native process tree'; }
      forceTimer = setTimeout(() => {
        try { killTree(child, env, true); } catch { diagnostic.cleanupError = 'Could not force-terminate the native process tree'; }
      }, 1500);
      cleanupTimer = setTimeout(() => finish(new Error('Native GUI exceeded 300 seconds and did not close after process-tree termination')), 12_000);
    }, TIMEOUT_MS);
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(forceTimer); clearTimeout(cleanupTimer);
      diagnostic.stdoutSha256 = hashes.stdout.digest('hex');
      diagnostic.stderrSha256 = hashes.stderr.digest('hex');
      diagnostic.stdoutTail = decodeLogTail(tails.stdout);
      diagnostic.stderrTail = decodeLogTail(tails.stderr);
      if (error) {
        // Even an OS-level kill failure must not keep Node/CI alive via pipe handles.
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      if (error) reject(error); else resolvePromise();
    };
    child.on('error', error => {
      diagnostic.spawnErrorCode = error.code || 'UNKNOWN';
      finish(new Error(`Cannot launch the final native app (${diagnostic.spawnErrorCode})`));
    });
    child.on('exit', (code, signal) => { diagnostic.exitCode = code; diagnostic.signal = signal; });
    child.on('close', (code, signal) => {
      diagnostic.exitCode = code; diagnostic.signal = signal;
      if (diagnostic.timedOut) {
        // A detached PDF worker must not survive the app's timeout/exit.
        try { killTree(child, env, true); } catch { diagnostic.cleanupError = 'Process-tree cleanup could not be confirmed'; }
        finish(new Error('Native GUI did not finish its smoke test within 300 seconds'));
      } else if (code !== 0 || signal) {
        try { killTree(child, env, true); } catch { diagnostic.cleanupError = 'Process-tree cleanup could not be confirmed'; }
        finish(new Error(`Native GUI exited unsuccessfully (exit=${code ?? 'none'}, signal=${signal ?? 'none'})`));
      } else {
        diagnostic.cleanExit = true;
        finish();
      }
    });
  });
}

function readJsonEvidence(path) {
  const stat = lstatSync(path);
  requireCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_REPORT_BYTES, 'Native evidence must be a regular JSON file no larger than 12 MiB');
  const bytes = readFileSync(path);
  requireCheck(bytes.length > 0 && bytes.length <= MAX_REPORT_BYTES, 'Native evidence exceeded 12 MiB while being read');
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function readFrontendReport(path) {
  return readJsonEvidence(path).value;
}

function writeEvidence(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx' });
  renameSync(temporary, path);
}

function writeReport(path, report) {
  writeEvidence(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function preserveNativeDiagnostics(temporaryDirectory, root, platformId, report) {
  const path = join(temporaryDirectory, 'diagnostics.json');
  try {
    const evidence = readJsonEvidence(path);
    requireCheck(evidence.value?.schemaVersion === 1 && Array.isArray(evidence.value.events)
      && evidence.value.events.length <= 256, 'Native diagnostics schema is invalid');
    for (const event of evidence.value.events) {
      requireCheck(typeof event?.phase === 'string' && event.phase.length <= 80
        && typeof event.detail === 'string' && event.detail.length <= 400
        && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0, 'Native diagnostic event is invalid');
    }
    report.nativeDiagnostics = evidence.value;
    const artifact = join(root, 'artifacts', `${platformId}-native-diagnostics.json`);
    // Preserve the same bounded bytes, rather than expanding them with pretty JSON.
    writeEvidence(artifact, evidence.bytes);
    report.nativeDiagnosticsArtifact = `artifacts/${basename(artifact)}`;
  } catch (error) {
    report.nativeDiagnosticsError = error?.code === 'ENOENT'
      ? 'Native process did not produce diagnostics.json'
      : `Native diagnostics could not be preserved (${shortDiagnostic(error?.code || error?.name || 'invalid evidence', 80)})`;
  }
}

export async function runNativeSmoke(args = process.argv.slice(2), env = process.env, root = PROJECT_ROOT) {
  const started = Date.now();
  const platformId = Object.hasOwn(PLATFORMS, env.OPEN_OFFICE_PLATFORM_ID || '') ? env.OPEN_OFFICE_PLATFORM_ID : 'unknown-platform';
  const reportPath = join(root, 'artifacts', `${platformId}-native-smoke.json`);
  const report = {
    schemaVersion: 1, kind: 'native-gui-smoke', ok: false, platformId, target: env.OPEN_OFFICE_TARGET || null,
    commit: env.GITHUB_SHA || null, runId: env.GITHUB_RUN_ID || null,
    host: { platform: process.platform, architecture: process.arch },
    targetArch: PLATFORMS[platformId]?.arch || null, hostArch: process.arch, executionMode: 'native',
    startedAt: new Date(started).toISOString(), timeoutMs: TIMEOUT_MS,
    preflight: {}, process: { exitCode: null, signal: null, timedOut: false, stdoutTail: '', stderrTail: '' }, frontend: null, errors: [],
  };
  let temporaryDirectory, rawReport;
  try {
    const configuration = PLATFORMS[platformId], options = parseOptions(args);
    const execution = selectExecution(platformId, env.OPEN_OFFICE_TARGET, process.platform, process.arch, env.OPEN_OFFICE_ALLOW_ROSETTA);
    Object.assign(report, execution);
    requireCheck(/^[0-9a-f]{40}$/i.test(env.GITHUB_SHA || ''), 'GITHUB_SHA must identify the exact tested source commit');
    requireCheck(/^\d+$/.test(env.GITHUB_RUN_ID || ''), 'GITHUB_RUN_ID must identify this native CI run');
    const location = locateApplication(configuration, options, env, root);
    report.preflight.installedResourceLayout = true;
    report.preflight.finalExecutable = basename(location.executable);
    report.preflight.finalExecutableSha256 = hashFile(location.executable);
    report.preflight.pdfExecutableSha256 = hashFile(location.pdfExecutable);
    report.preflight.wordcraft = inspectInstalledWordcraft(location.resourceRoot, { root });
    report.preflight.gridcraft = inspectInstalledGridcraft(location.resourceRoot, { root });
    report.preflight.deckcraft = inspectInstalledDeckcraft(location.resourceRoot, { root });
    if (configuration.os === 'darwin') {
      report.preflight.macos = macPreflight(location.app, location.executable, location.pdfExecutable, configuration.nativeArch);
      if (execution.executionMode === 'rosetta2') {
        report.preflight.rosetta = {};
        rosettaPreflight(report.preflight.rosetta);
      }
    } else {
      report.preflight.installedNSISLayout = true;
      report.preflight.windows = {
        main: verifyWindowsExecutable(location.executable), pdfRuntime: verifyWindowsExecutable(location.pdfExecutable),
      };
    }
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'open-office-native-smoke-'));
    rawReport = join(temporaryDirectory, 'frontend-report.json');
    // This path is unique, was not created beforehand, and is not reused on reruns.
    requireCheck(!existsSync(rawReport), 'The native GUI report destination is not fresh');
    await runGui(location.executable, rawReport, temporaryDirectory, env, report.process, execution.executionMode);
    report.frontend = readFrontendReport(rawReport);
    report.checks = validateFrontendReport(report.frontend);
    Object.assign(report.checks, validateNativeWordcraftEvidence(report, { root }));
    Object.assign(report.checks, validateNativeGridcraftEvidence(report, { root }));
    Object.assign(report.checks, validateNativeDeckcraftEvidence(report, { root }));
    requireCheck(report.process.cleanExit === true && report.process.exitCode === 0 && !report.process.signal && !report.process.timedOut, 'Native GUI did not exit cleanly after its checks');
    report.ok = true;
  } catch (error) {
    // Retain a failure report from the GUI for diagnosis, even when it exited 1.
    if (!report.frontend && rawReport && existsSync(rawReport)) {
      try { report.frontend = readFrontendReport(rawReport); } catch { /* invalid report is not evidence */ }
    }
    report.errors.push(String(error?.message || 'Native smoke test failed').slice(0, 5000));
  } finally {
    if (!report.ok && temporaryDirectory) preserveNativeDiagnostics(temporaryDirectory, root, platformId, report);
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    writeReport(reportPath, report);
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`Native GUI smoke ${report.ok ? 'passed' : 'failed'}: artifacts/${basename(reportPath)}`);
  if (!report.ok) emitFailureDiagnostics(report, env, reportPath);
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeSmoke().then(report => { process.exitCode = report.ok ? 0 : 1; }).catch(error => {
    const message = `Native smoke could not finish writing its diagnostic report (${shortDiagnostic(error?.code || error?.name || 'unknown error', 80)}).`;
    const platformId = Object.hasOwn(PLATFORMS, process.env.OPEN_OFFICE_PLATFORM_ID || '') ? process.env.OPEN_OFFICE_PLATFORM_ID : 'unknown-platform';
    emitFailureDiagnostics({ platformId, errors: [message], process: {} }, process.env,
      join(PROJECT_ROOT, 'artifacts', `${platformId}-native-smoke.json`));
    process.exitCode = 1;
  });
}
