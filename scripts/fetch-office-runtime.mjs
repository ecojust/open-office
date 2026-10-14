#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, rename, rm, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MOUSE_TIME_PATCH, patchOfficeMouseTime } from './office-mouse-time-patch.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(path.join(root, 'vendor/office-runtime-manifest.json'), 'utf8'))
const target = path.join(root, 'public/office-runtime')
const verifyOnly = process.argv.includes('--verify') || process.argv.includes('--offline')
await mkdir(target, { recursive: true })
async function matches(file, asset) {
  try {
    if ((await stat(file)).size !== asset.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === asset.sha256
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
for (const asset of manifest.assets) {
  if (!/^[A-Za-z0-9._-]+$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error('Invalid office runtime manifest')
  const derived = asset.derived
  if (derived && (asset.file !== 'soffice.wasm' || derived.id !== MOUSE_TIME_PATCH.id
      || asset.bytes !== MOUSE_TIME_PATCH.source.bytes || asset.sha256 !== MOUSE_TIME_PATCH.source.sha256
      || derived.bytes !== MOUSE_TIME_PATCH.output.bytes || derived.sha256 !== MOUSE_TIME_PATCH.output.sha256)) {
    throw Error('Unrecognized office runtime derivation; refusing to patch an unverified engine')
  }
  const shipped = derived || asset
  const file = path.join(target, asset.file)
  if (await matches(file, shipped)) { console.log(`Verified ${asset.file} (${shipped.bytes} bytes${derived ? `; ${derived.id}` : ''})`); continue }
  if (verifyOnly) throw Error(`Missing or damaged offline office resource: ${asset.file}. Run node scripts/fetch-office-runtime.mjs while online before building.`)
  const temporary = `${file}.${process.pid}.partial`
  try {
    // A previously verified upstream cache can be transformed without fetching
    // it again. The original stays intact until the derived file is verified.
    if (derived && await matches(file, asset)) {
      await writeFile(temporary, patchOfficeMouseTime(await readFile(file)))
      if (!await matches(temporary, shipped)) throw Error(`Derived SHA256 mismatch: ${asset.file}`)
      await rename(temporary, file)
      console.log(`Derived and verified ${asset.file} (${shipped.bytes} bytes; ${derived.id})`)
      continue
    }
    console.log(`Downloading ${asset.file} from ${asset.url}`)
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(180000) })
    if (!response.ok || !response.body) throw Error(`HTTP ${response.status}: ${asset.url}`)
    const hash = createHash('sha256'); let bytes = 0
    const verify = new Transform({ transform(chunk, _, callback) {
      bytes += chunk.length
      if (bytes > asset.bytes) return callback(Error(`Unexpected resource size: ${asset.file}`))
      hash.update(chunk); callback(null, chunk)
    } })
    // Node fetch decodes Brotli/gzip responses before the stream reaches disk.
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary))
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw Error(`SHA256 mismatch for ${asset.file}; upstream may have changed. Do not use an unverified engine.`)
    if (derived) await writeFile(temporary, patchOfficeMouseTime(await readFile(temporary)))
    if (!await matches(temporary, shipped)) throw Error(`Final runtime SHA256 mismatch: ${asset.file}`)
    await rename(temporary, file)
    console.log(`Verified ${asset.file} (${shipped.bytes} bytes${derived ? `; ${derived.id}` : ''})`)
  } finally { await rm(temporary, { force: true }) }
}
console.log('Offline office runtime is complete and checksum-verified.')
