import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Separate Linux debug IPC evidence. This is deliberately not the final-package
// Windows/macOS Office/PDF gate in native-smoke.mjs, and never calls its runner.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_LIMIT = 1024 * 1024;
const TAIL_LIMIT = 32 * 1024;
const SOURCE_FILES = [
  'src/word/core/native-package-smoke.ts', 'scripts/word-package-native-smoke.mjs',
  'src/word/core/runtime.ts', 'src/word/core/docx.ts', 'src/word/core/model.ts',
  'src/word/core/highlight.ts', 'src/word/core/background.ts', 'src/word/core/scripts.ts',
  'src/native.ts', 'src/shared/document.ts', 'src/App.vue', 'src/types.ts',
  'src-tauri/src/lib.rs', 'src-tauri/src/server.rs', 'src-tauri/src/smoke.rs',
  'src-tauri/src/word.rs', 'src-tauri/build.rs', 'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json',
  'crates/word-package/src/lib.rs', 'crates/word-package/Cargo.toml',
];
export const REQUIRED_CHECKS = Object.freeze([
  'tauri-ipc-present', 'browser-seed-rust-read', 'native-roundtrip-1', 'native-roundtrip-2',
  'second-edit-text', 'chinese-emoji-retained', 'script-and-strike-retained',
  'highlight-background-retained', 'explicit-clears-retained',
  'native-read-invalid-base64-rejected', 'native-read-invalid-zip-rejected',
  'native-write-invalid-base64-rejected', 'native-write-unsafe-name-rejected',
  'native-write-duplicate-name-rejected', 'no-office-wasm-resources',
]);
const BODY_SUFFIX = '\n上标中文😀下标中文😀\n明确取消中文😀取消高亮保留背景';
const EXPECTED_FORMATS = [
  { text: '上标中文😀', style: { fontSize: 18, underline: true, strike: 'double', verticalAlign: 'superscript', highlight: 'yellow', backgroundColor: '#13579B' } },
  { text: '下标中文😀', style: { fontSize: 14, strike: 'single', verticalAlign: 'subscript', highlight: 'cyan', backgroundColor: '#ABCDEF' } },
  { text: '明确取消中文😀', style: { fontSize: 18, strike: 'none', verticalAlign: 'baseline', highlight: 'none', backgroundColor: 'none' } },
  { text: '取消高亮保留背景', style: { fontSize: 18, strike: 'double', verticalAlign: 'superscript', highlight: 'none', backgroundColor: '#FEDCBA' } },
];
const EXPECTED_REJECTIONS = [
  'DOCX ZIP Base64 编码无效。', 'DOCX 文件为空、损坏或超过 16 MiB。',
  'DOCX ZIP 内容 Base64 编码无效。', 'DOCX 包含越界或保留的 ZIP 路径。',
  'DOCX ZIP 包含重复或大小写歧义的文件。',
];

export function validateWordPackageReport(report) {
  assert.equal(report?.schemaVersion, 1, 'Unexpected frontend report schema');
  assert.equal(report.kind, 'word-package-ipc', 'This is not independent Word IPC evidence');
  assert.equal(report.ok, true, report.error || 'Frontend checks failed');
  assert.deepEqual(report.checks, [...REQUIRED_CHECKS], 'Missing, duplicate or unexpected IPC checks');
  assert.equal(typeof report.userAgent, 'string');
  assert.ok(report.userAgent.length > 0 && report.userAgent.length < 2000, 'Missing WebView user agent');
  assert.ok(Number.isSafeInteger(report.elapsedMs) && report.elapsedMs >= 0, 'Invalid elapsed time');
  assert.equal(report.roundTrips?.length, 2, 'Both native package reopenings are required');
  const texts = ['原文中文😀', '第二次保存中文😀 SECOND_SAVE_TOKEN'];
  for (const [index, round] of report.roundTrips.entries()) {
    assert.ok(Number.isSafeInteger(round.docxBytes) && round.docxBytes > 100 && round.docxBytes <= 16 * 1024 * 1024);
    assert.equal(round.text, texts[index] + BODY_SUFFIX, 'Native package text did not persist');
  }
  assert.equal(report.formats?.length, EXPECTED_FORMATS.length, 'Missing semantic readback');
  for (const [index, expected] of EXPECTED_FORMATS.entries()) {
    const actual = report.formats[index];
    assert.equal(actual.text, expected.text);
    for (const [key, value] of Object.entries(expected.style)) assert.equal(actual.style?.[key], value, `${expected.text}: ${key}`);
  }
  for (const [key, value] of Object.entries({ strike: 'none', verticalAlign: 'baseline', highlight: 'none', backgroundColor: 'none' })) {
    assert.equal(report.formats[2].directStyle?.[key], value, `Explicit ${key} reset lost provenance`);
  }
  assert.equal(report.rejections?.length, EXPECTED_REJECTIONS.length, 'Missing native rejection evidence');
  for (const [index, error] of EXPECTED_REJECTIONS.entries()) {
    assert.equal(report.rejections[index]?.check, REQUIRED_CHECKS[9 + index]);
    assert.equal(report.rejections[index]?.error, error, 'ACL/transport errors cannot satisfy malformed-input checks');
  }
  assert.ok(Number.isSafeInteger(report.resources?.observed) && report.resources.observed > 0, 'No resource observations were recorded');
  assert.deepEqual(report.resources.forbidden, [], 'Office/WASM requests were observed');
  assert.equal(typeof report.resources.observation, 'string');
  return true;
}

export function parseOptions(args) {
  const options = { executable: undefined, timeoutMs: 90_000 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    assert.ok(['--executable', '--timeout-ms'].includes(name) && value && !seen.has(name), 'Usage: node scripts/word-package-native-smoke.mjs --executable /absolute/target/debug/open-office [--timeout-ms 90000]');
    seen.add(name);
    if (name === '--executable') options.executable = value;
    else {
      assert.match(value, /^\d+$/, 'Timeout must be a number of milliseconds');
      options.timeoutMs = Number(value);
    }
  }
  assert.ok(options.executable && isAbsolute(options.executable), 'An explicit absolute --executable is required');
  assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 180_000, 'Timeout must be between 1000 and 180000 ms');
  return options;
}

function hashFile(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), descriptor = openSync(path, 'r');
  try {
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}
function sourceHashes() {
  return Object.fromEntries(SOURCE_FILES.map(file => [file, hashFile(join(ROOT, file))]));
}
function frontendHashes() {
  const files = ['dist/index.html'];
  const collect = directory => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Built frontend assets must not be symlinks');
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else { assert.ok(entry.isFile(), 'Built frontend assets must be regular files'); files.push(path); }
    }
  };
  assert.ok(lstatSync(join(ROOT, files[0])).isFile(), 'A built dist/index.html is required');
  assert.ok(lstatSync(join(ROOT, 'dist/assets')).isDirectory(), 'Built dist/assets are required');
  collect('dist/assets');
  assert.ok(files.length > 1, 'Built frontend contains no assets');
  return Object.fromEntries(files.sort().map(file => [file, hashFile(join(ROOT, file))]));
}
function executableEvidence(path) {
  const actual = realpathSync(path);
  assert.equal(basename(actual), 'open-office', 'Only the actual Open Office debug executable is accepted');
  assert.equal(basename(dirname(actual)), 'debug', 'This harness accepts a debug executable only');
  const file = statSync(actual);
  assert.ok(file.isFile() && file.size > 64, 'Native executable is missing or empty');
  accessSync(actual, constants.X_OK);
  const descriptor = openSync(actual, 'r'), header = Buffer.alloc(20);
  try { assert.equal(readSync(descriptor, header, 0, header.length, 0), header.length); }
  finally { closeSync(descriptor); }
  assert.equal(header.toString('hex', 0, 4), '7f454c46', 'Expected a native Linux ELF executable');
  assert.equal(header[4], 2, 'Expected a 64-bit ELF executable');
  assert.equal(header[5], 1, 'Expected little-endian ELF');
  assert.ok(['x64', 'arm64'].includes(process.arch), 'Only Linux x64/arm64 hosts are supported');
  assert.equal(header.readUInt16LE(18), process.arch === 'x64' ? 62 : 183, 'ELF architecture does not match this host');
  return { path: actual, bytes: file.size, sha256: hashFile(actual), profile: 'debug', architecture: process.arch };
}

function launch(executable, env, cwd, timeoutMs, diagnostic) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [], { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    diagnostic.pid = child.pid ?? null;
    const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let done = false, forceTimer, cleanupTimer;
    const killGroup = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') diagnostic.cleanupError = String(error.message).slice(0, 500); }
    };
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(cleanupTimer);
      process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
      for (const name of ['stdout', 'stderr']) diagnostic[`${name}Tail`] = tails[name].toString('utf8');
      if (error) { killGroup('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.unref(); reject(error); }
      else resolvePromise();
    };
    const interrupted = signal => { diagnostic.interrupted = signal; finish(Error(`Harness interrupted by ${signal}`)); };
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      diagnostic[`${name}Bytes`] = (diagnostic[`${name}Bytes`] || 0) + chunk.length;
      tails[name] = Buffer.concat([tails[name], chunk]).subarray(-TAIL_LIMIT);
    });
    const timer = setTimeout(() => {
      diagnostic.timedOut = true;
      killGroup('SIGTERM');
      forceTimer = setTimeout(() => killGroup('SIGKILL'), 1500);
      cleanupTimer = setTimeout(() => finish(Error(`Native IPC smoke exceeded ${timeoutMs} ms`)), 6000);
    }, timeoutMs);
    child.once('error', error => finish(Error(`Native process could not start: ${error.code || error.message}`)));
    child.once('exit', (code, signal) => { diagnostic.exitCode = code; diagnostic.signal = signal; });
    child.once('close', (code, signal) => {
      diagnostic.exitCode = code; diagnostic.signal = signal;
      if (diagnostic.timedOut || code !== 0 || signal) finish(Error(`Native process failed (exit=${code}, signal=${signal}, timeout=${diagnostic.timedOut})`));
      else if (diagnostic.cleanupError) finish(Error(diagnostic.cleanupError));
      else finish();
    });
  });
}

function readReport(path) {
  const file = lstatSync(path);
  assert.ok(file.isFile() && !file.isSymbolicLink() && file.size > 0 && file.size <= REPORT_LIMIT, 'Frontend report must be a new regular JSON file of at most 1 MiB');
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 0 && bytes.length <= REPORT_LIMIT);
  return JSON.parse(bytes.toString('utf8'));
}

export async function runWordPackageNativeSmoke(args = process.argv.slice(2), env = process.env) {
  const directory = mkdtempSync(join(tmpdir(), 'open-office-word-ipc-'));
  const frontendPath = join(directory, 'frontend-report.json'), reportPath = join(directory, 'report.json');
  const started = Date.now();
  const report = {
    schemaVersion: 1, kind: 'word-package-ipc', ok: false,
    scope: 'Linux debug Tauri WebView, real word package IPC and shared OOXML codec; no Office/WASM engine or file dialogs.',
    limitations: ['Not a Windows/macOS final-package release gate.', 'No app editing, native dialogs, PDF rendering or Microsoft Office runtime compatibility tested.', 'No-resource evidence is based on Resource Timing, not network isolation.'],
    host: { platform: process.platform, architecture: process.arch }, directory, startedAt: new Date(started).toISOString(),
    process: { exitCode: null, signal: null, timedOut: false }, frontend: null, errors: [],
  };
  try {
    assert.equal(process.platform, 'linux', 'This separate harness supports Linux debug builds only');
    const options = parseOptions(args);
    assert.ok(typeof env.DISPLAY === 'string' && env.DISPLAY.trim(), 'An existing X11 DISPLAY (for example Xvfb) is required');
    report.executable = executableEvidence(options.executable);
    report.sourceHashes = sourceHashes();
    report.frontendHashes = frontendHashes();
    report.timeoutMs = options.timeoutMs;
    const data = join(directory, 'data'), config = join(directory, 'config'), cache = join(directory, 'cache'), runtime = join(directory, 'runtime');
    for (const path of [data, config, cache, runtime]) mkdirSync(path, { mode: 0o700 });
    assert.equal(existsSync(frontendPath), false, 'Frontend destination must be fresh');
    await launch(report.executable.path, {
      ...env, GDK_BACKEND: 'x11', XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_RUNTIME_DIR: runtime,
      OPEN_OFFICE_SMOKE: '1', OPEN_OFFICE_SMOKE_SCOPE: 'word-package-ipc', OPEN_OFFICE_SMOKE_OUTPUT: frontendPath,
    }, directory, options.timeoutMs, report.process);
    report.frontend = readReport(frontendPath);
    validateWordPackageReport(report.frontend);
    assert.equal(report.process.exitCode, 0); assert.equal(report.process.signal, null); assert.equal(report.process.timedOut, false);
    assert.equal(hashFile(report.executable.path), report.executable.sha256, 'Executable changed during smoke');
    assert.deepEqual(sourceHashes(), report.sourceHashes, 'Source changed during smoke');
    assert.deepEqual(frontendHashes(), report.frontendHashes, 'Built frontend changed during smoke');
    report.ok = true;
  } catch (error) {
    report.errors.push(String(error instanceof Error ? error.message : error).slice(0, 4000));
    if (!report.frontend && existsSync(frontendPath)) {
      try { report.frontend = readReport(frontendPath); } catch (failure) { report.errors.push(`Unreadable frontend report: ${String(failure.message).slice(0, 500)}`); }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - started;
    // Preserve this unique directory, including failure-only native diagnostics.
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { report, reportPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { report, reportPath } = await runWordPackageNativeSmoke();
    console.log(JSON.stringify({ ok: report.ok, reportPath, errors: report.errors }));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
