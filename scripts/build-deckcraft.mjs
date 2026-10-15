import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOfficeIcons } from './build-office-icons.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'vendor/deckcraft')
const output = join(root, 'public/deckcraft')
const digest = value => createHash('sha256').update(value).digest('hex')
await buildOfficeIcons({ root, families: ['deck'], check: process.argv.includes('--check') })
const sources = ['scripts/build-deckcraft.mjs', 'scripts/build-office-icons.mjs']
async function collect(relative) {
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['target', '.git'].includes(entry.name)) continue
    const path = `${relative}/${entry.name}`
    if (entry.isDirectory()) await collect(path)
    else if (entry.isFile()) sources.push(path)
  }
}
await collect('vendor/deckcraft')
await collect('src/icons')
// The host embeds these locally bundled, licensed fonts for Chinese UI and documents.
await collect('assets/fonts/open-office')
await collect('assets/fonts/deck')
const hash = createHash('sha256')
for (const path of sources.sort()) hash.update(path).update('\0').update(await readFile(join(root, path))).update('\0')
const sourceHash = hash.digest('hex')
try {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  if (manifest.sourceHash === sourceHash && (await Promise.all(Object.entries(manifest.files).map(async ([name, sha]) => digest(await readFile(join(output, name))) === sha))).every(Boolean)) {
    console.log('DeckCraft Rust editor matches source and artifact hashes.')
    process.exit(0)
  }
} catch { /* Missing or stale generated output is rebuilt. */ }
if (process.argv.includes('--check')) throw Error('DeckCraft WASM is missing or stale. Run npm run deck:build.')
const bindgen = process.env.WASM_BINDGEN || 'wasm-bindgen'
const version = spawnSync(bindgen, ['--version'], { encoding: 'utf8' })
if (version.status !== 0 || version.stdout.trim() !== 'wasm-bindgen 0.2.129') {
  throw Error('Install the pinned WASM bridge: cargo install --locked wasm-bindgen-cli --version 0.2.129 (or set WASM_BINDGEN to that executable).')
}
const targetDir = process.env.DECKCRAFT_TARGET_DIR || join(source, 'target')
const built = spawnSync(process.env.CARGO || 'cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', join(source, 'Cargo.toml'), '-p', 'open-office-deckcraft-host', '--target-dir', targetDir], { cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_PROFILE_RELEASE_LTO: 'false', OPEN_OFFICE_FONTS_DIR: join(root, 'assets/fonts/open-office'), OPEN_OFFICE_DECK_FONTS_DIR: join(root, 'assets/fonts/deck') } })
if (built.error) throw built.error
if (built.status !== 0) process.exit(built.status || 1)
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const generated = spawnSync(bindgen, [join(targetDir, 'wasm32-unknown-unknown/release/open_office_deckcraft_host.wasm'), '--target', 'web', '--out-dir', output, '--out-name', 'deckcraft'], { stdio: 'inherit' })
if (generated.error) throw generated.error
if (generated.status !== 0) process.exit(generated.status || 1)
const files = {}
async function hashOutput(prefix = '') {
  for (const entry of await readdir(join(output, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) await hashOutput(name + '/')
    else if (entry.isFile()) files[name] = digest(await readFile(join(output, name)))
  }
}
await hashOutput()
const bytes = await readFile(join(output, 'deckcraft_bg.wasm'))
await WebAssembly.compile(bytes)
await writeFile(join(output, 'manifest.json'), JSON.stringify({ engine: 'DeckCraft', upstreamCommit: '9859da39255c0262cd592bb57101d7f2fa961f72', sourceHash, files, sizeBytes: bytes.length, target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129' }, null, 2) + '\n')
console.log(`Built DeckCraft Rust editor (${bytes.length} WASM bytes).`)
