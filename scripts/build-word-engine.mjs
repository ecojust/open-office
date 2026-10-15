import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'public/word-engine')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const notices = ['LICENSE-Noto-CJK.txt', 'LICENSE-DejaVu.txt', 'LICENSE-Noto-Core.txt', 'manifest.json']
const sources = ['scripts/build-word-engine.mjs']
async function collect(relative) {
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${relative}/${entry.name}`
    if (entry.isDirectory()) await collect(path)
    else if (entry.isFile()) sources.push(path)
  }
}
for (const crate of ['word-engine', 'word-package']) {
  sources.push(`crates/${crate}/Cargo.toml`, `crates/${crate}/Cargo.lock`)
  await collect(`crates/${crate}/src`)
}
await collect('crates/word-engine/fonts')
const fingerprint = createHash('sha256')
for (const path of sources.sort()) fingerprint.update(path).update('\0').update(await readFile(join(root, path))).update('\0')
const sourceHash = fingerprint.digest('hex')
try {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  const wasm = await readFile(join(output, 'word_engine.wasm'))
  const noticesValid = (await Promise.all(notices.map(async name => sha256(await readFile(join(output, 'fonts', name))) === sha256(await readFile(join(root, 'crates/word-engine/fonts', name)))))).every(Boolean)
  if (manifest.sourceHash === sourceHash && manifest.sha256 === sha256(wasm) && noticesValid) {
    console.log('Rust Word WASM matches source and font hashes.')
    process.exit(0)
  }
} catch { /* A clean checkout builds the artifact below. */ }
if (process.argv.includes('--check')) throw Error('Rust Word WASM is missing or stale. Run npm run word:build.')
const targetDir = join(root, 'crates/word-engine/target')
const result = spawnSync(process.env.CARGO || 'cargo', ['build', '--locked', '--release', '--lib', '--target', 'wasm32-unknown-unknown', '--manifest-path', join(root, 'crates/word-engine/Cargo.toml'), '--target-dir', targetDir], { cwd: root, stdio: 'inherit', env: process.env })
if (result.error) throw Error(`Cannot run Rust compiler: ${result.error.message}. Install Rust and run rustup target add wasm32-unknown-unknown.`)
if (result.status !== 0) process.exit(result.status || 1)
const binary = join(targetDir, 'wasm32-unknown-unknown/release/word_engine.wasm')
const bytes = await readFile(binary)
await WebAssembly.compile(bytes)
await mkdir(output, { recursive: true })
await mkdir(join(output, 'fonts'), { recursive: true })
for (const name of notices) await copyFile(join(root, 'crates/word-engine/fonts', name), join(output, 'fonts', name))
await copyFile(binary, join(output, 'word_engine.wasm'))
await writeFile(join(output, 'manifest.json'), JSON.stringify({ protocolVersion: 1, sourceHash, sha256: sha256(bytes), sizeBytes: bytes.length, target: 'wasm32-unknown-unknown' }, null, 2) + '\n')
console.log(`Built Rust Word WASM (${bytes.length} bytes).`)
