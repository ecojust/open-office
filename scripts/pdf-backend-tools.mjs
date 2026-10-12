import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const backendRoot = join(projectRoot, 'pdf-backend');
export const venvRoot = join(backendRoot, '.venv');
export const venvPython = join(venvRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const runtimeRoot = join(projectRoot, 'src-tauri', 'pdf-runtime');
export const executableName = `open-office-pdf${process.platform === 'win32' ? '.exe' : ''}`;
export const pyinstallerVersion = '6.16.0';
export const pymupdfVersion = '1.28.2';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot, shell: false, windowsHide: true, stdio: 'inherit', timeout: 900_000, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr || ''}`);
  return result;
}

export function capture(command, args, timeout = 120_000) {
  return run(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 4 * 1024 * 1024 }).stdout.trim();
}

export function pythonDetails(command, args = []) {
  return JSON.parse(capture(command, [...args, '-c', 'import json,sys,platform;print(json.dumps({"version":list(sys.version_info[:3]),"platform":sys.platform,"machine":platform.machine()}))'], 15_000));
}

export function findPython() {
  const candidates = process.env.OPEN_OFFICE_PYTHON ? [[process.env.OPEN_OFFICE_PYTHON, []]]
    : process.platform === 'win32' ? [['py', ['-3.12']], ['python', []]]
      : [['python3.12', []], ['python3', []], ['python', []]];
  for (const [command, args] of candidates) {
    try {
      const details = pythonDetails(command, args);
      if (details.version[0] === 3 && details.version[1] >= 10 && details.version[1] <= 13) return { command, args, details };
    } catch { /* Try another explicitly named Python command. */ }
  }
  throw new Error('Install Python 3.12 (supported: 3.10–3.13), or set OPEN_OFFICE_PYTHON to its executable path.');
}

export function nativeTarget() {
  const host = capture('rustc', ['-vV'], 15_000).match(/^host: (.+)$/m)?.[1]?.trim();
  assert.match(host || '', /^(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-gnu)$/, 'Unsupported native Rust target');
  const requested = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || host;
  assert.equal(requested, host, `Python freezing must run natively: ${host} cannot freeze ${requested}`);
  return host;
}

export function requireMatchingPython(details, host) {
  const architecture = { x86_64: 'x86_64', AMD64: 'x86_64', amd64: 'x86_64', arm64: 'aarch64', aarch64: 'aarch64' }[details.machine];
  const platform = { darwin: 'apple-darwin', win32: 'pc-windows-msvc', linux: 'unknown-linux-gnu' }[details.platform];
  assert.equal(`${architecture}-${platform}`, host, 'Python and Rust must use the same native OS and CPU; recreate a wrongly-architectured pdf-backend/.venv');
}

export function verifyEngine(command, prefix = [], selfTest = false) {
  const result = JSON.parse(capture(command, [...prefix, selfTest ? '--self-test' : '--info']));
  assert.equal(result.engine, 'pymupdf');
  assert.equal(result.version, pymupdfVersion, 'PDF engine version does not match the pinned requirement');
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.local, true);
  if (selfTest) {
    assert.equal(result.selfTest, true);
    assert.equal(result.status, 'PASSED');
    assert.equal(result.chineseReplacementVerified, true);
  }
  return result;
}

export function preparePython() {
  if (!existsSync(venvPython)) {
    const candidate = findPython();
    console.log('Creating local PDF build environment. The finished application will not require system Python.');
    run(candidate.command, [...candidate.args, '-m', 'venv', venvRoot]);
  }
  const details = pythonDetails(venvPython);
  assert.ok(details.version[0] === 3 && details.version[1] >= 10 && details.version[1] <= 13, 'Unsupported Python version in existing venv');
  let ready = false;
  try {
    const versions = JSON.parse(capture(venvPython, ['-c', 'import json,importlib.metadata as m;print(json.dumps({"pymupdf":m.version("pymupdf"),"pyinstaller":m.version("pyinstaller")}))'], 15_000));
    ready = versions.pymupdf === pymupdfVersion && versions.pyinstaller === pyinstallerVersion;
  } catch { /* First preparation or dependencies changed. */ }
  if (!ready) {
    console.log('Installing pinned PDF build dependencies (network is needed only for development/build preparation).');
    run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(backendRoot, 'requirements.txt'), `PyInstaller==${pyinstallerVersion}`]);
  }
  verifyEngine(venvPython, [join(backendRoot, 'engine.py')]);
  verifyEngine(venvPython, [join(backendRoot, 'engine.py')], true);
  return details;
}

export function sourceHashes() {
  const files = {};
  const add = file => { files[relative(projectRoot, file).replaceAll('\\', '/')] = sha(readFileSync(file)); };
  function walk(root) {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.venv', 'build', '__pycache__'].includes(entry.name)) continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.py') || entry.name === 'requirements.txt') add(path);
    }
  }
  walk(backendRoot);
  for (const name of ['pdf-backend-tools.mjs', 'build-pdf-backend.mjs', 'ensure-pdf-backend.mjs', 'seal-macos-pdf-runtime.mjs']) add(join(projectRoot, 'scripts', name));
  return files;
}

export function runtimeInventory(directory) {
  const root = realpathSync(directory), files = {};
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.gitkeep') continue;
      const file = join(current, entry.name), name = relative(root, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        const link = readlinkSync(file);
        assert.ok(!isAbsolute(link) && realpathSync(file).startsWith(`${root}${sep}`), `Runtime link escapes or is broken: ${name}`);
        files[name] = { link };
      } else if (entry.isDirectory()) walk(file);
      else {
        assert.ok(entry.isFile(), `Unsupported runtime entry: ${name}`);
        const bytes = readFileSync(file);
        files[name] = { bytes: bytes.length, sha256: sha(bytes), ...(process.platform === 'win32' ? {} : { executable: Boolean(lstatSync(file).mode & 0o111) }) };
      }
    }
  }
  walk(root);
  return { sha256: sha(JSON.stringify(files)), fileCount: Object.keys(files).length, files };
}

export function main(task) {
  Promise.resolve().then(task).catch(error => { console.error(`Open Office PDF: ${error.stack || error}`); process.exitCode = 1; });
}
