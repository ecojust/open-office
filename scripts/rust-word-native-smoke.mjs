// Linux debug WebView/IPC evidence; browser UI and installed release validation
// are separate checks. Never accepts a pre-existing report as a successful run.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
assert.equal(process.platform, 'linux', 'This harness validates a Linux debug WebView only')
const executable = process.argv[2]
assert.ok(executable && executable.startsWith('/'), 'Pass the absolute path to the freshly built open-office executable')
assert.equal(readFileSync(executable).subarray(0, 4).toString('hex'), '7f454c46')
const directory = mkdtempSync(join(tmpdir(), 'open-office-rust-word-ipc-'))
const reportPath = join(directory, 'frontend.json')
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = folder => readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry =>
  entry.name === 'target' ? [] : entry.isDirectory() ? files(`${folder}/${entry.name}`) : [`${folder}/${entry.name}`])
const sourceFiles = ['src/App.vue', 'src-tauri/src/word.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/smoke.rs', 'src-tauri/build.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', ...files('src/word/rust'), ...files('crates/word-engine'), ...files('crates/word-package'), ...files('dist/assets'), 'dist/index.html']
const fingerprint = () => Object.fromEntries(sourceFiles.map(path => [path, hash(join(root, path))]))
const before = fingerprint(), binaryHash = hash(executable)
const env = { ...process.env, OPEN_OFFICE_SMOKE: '1', OPEN_OFFICE_SMOKE_SCOPE: 'rust-word-engine', OPEN_OFFICE_SMOKE_OUTPUT: reportPath, GDK_BACKEND: 'x11' }
for (const [key, name] of [['XDG_DATA_HOME', 'data'], ['XDG_CONFIG_HOME', 'config'], ['XDG_CACHE_HOME', 'cache'], ['XDG_RUNTIME_DIR', 'runtime']]) {
  env[key] = join(directory, name); mkdirSync(env[key], { mode: 0o700 })
}
const evidence = { ok: false, kind: 'rust-word-engine-native', directory, binaryHash, before, limitations: ['Linux debug Tauri IPC; no native file dialogs or installed Windows/macOS validation.', 'Browser UI acceptance is recorded separately.'] }
try {
  await new Promise((done, reject) => {
    const child = spawn(env.DISPLAY ? executable : 'xvfb-run', env.DISPLAY ? [] : ['-a', executable], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = '', expired = false
    const timer = setTimeout(() => { expired = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }, 90000)
    child.stdout.on('data', chunk => { tail = (tail + chunk).slice(-16000) })
    child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-16000) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer); evidence.process = { code, signal, expired, tail }
      code === 0 && !signal && !expired ? done() : reject(Error('Native Rust Word process failed; see report'))
    })
  })
  assert.ok(statSync(reportPath).size < 1024 * 1024)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  evidence.frontend = report
  assert.equal(report.ok, true, report.error)
  assert.equal(report.transport, 'tauri-word-engine-request')
  assert.equal(report.checks.length, 5)
  assert.ok(report.glyphPaths > 0 && report.pages > 0)
  const exported = join(directory, 'native-export.docx')
  writeFileSync(exported, Buffer.from(report.docxBase64, 'base64'))
  evidence.xml = JSON.parse(execFileSync('python3', [join(root, 'tests/browser/rust-word-docx-oracle.py'), exported], { encoding: 'utf8' }))
  assert.equal(evidence.xml.paragraphs.map(p => p.text).join('\n'), 'Rust 正文 中文😀\nSecond paragraph')
  assert.equal(evidence.xml.paragraphs[0].align, 'center')
  for (const character of evidence.xml.paragraphs[0].characters) {
    assert.equal(character.bold, true); assert.equal(character.italic, true)
    assert.equal(character.fontSize, 14); assert.equal(character.color, '#C00000')
  }
  assert.equal(hash(executable), binaryHash)
  assert.deepEqual(fingerprint(), before, 'Product changed during native verification')
  evidence.ok = true
} catch (error) {
  evidence.error = String(error.stack || error)
  process.exitCode = 1
} finally {
  writeFileSync(join(directory, 'report.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ ok: evidence.ok, report: join(directory, 'report.json'), error: evidence.error }))
}
