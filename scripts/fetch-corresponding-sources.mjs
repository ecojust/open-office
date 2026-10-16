#!/usr/bin/env node
/** Download fixed upstream source archives without executing or unpacking them.
 * Keep these outside public/: they belong beside a release, not inside the app binary.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = path.join(projectRoot, 'public/legal/corresponding-sources-manifest.json')

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.archives) || !manifest.archives.length) {
    throw Error('Unsupported or empty corresponding-source manifest')
  }
  const names = new Set()
  for (const asset of manifest.archives) {
    if (!/^[A-Za-z0-9._+-]+\.tar\.(?:gz|xz)$/.test(asset.file)
        || names.has(asset.file)
        || !/^[a-f0-9]{64}$/.test(asset.sha256)
        || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 2 * 1024 ** 3) {
      throw Error('Unsafe filename, duplicate archive, size, or checksum in source manifest')
    }
    const url = new URL(asset.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw Error('Source archives must use authenticated HTTPS origins without URL credentials')
    }
    if (asset.commit && (!/^[a-f0-9]{40}$/.test(asset.commit) || !url.pathname.includes(asset.commit))) {
      throw Error('Git source URL must identify its complete pinned commit')
    }
    names.add(asset.file)
  }
  return manifest
}

async function matches(file, asset) {
  try {
    if ((await stat(file)).size !== asset.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === asset.sha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function fetchSourceArchives({
  manifest,
  directory,
  verifyOnly = false,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  validateManifest(manifest)
  await mkdir(directory, { recursive: true })
  for (const asset of manifest.archives) {
    const file = path.join(directory, asset.file)
    if (await matches(file, asset)) {
      log(`Verified ${asset.file} (${asset.bytes} bytes)`)
      continue
    }
    if (verifyOnly) throw Error(`Missing or damaged source archive: ${asset.file}`)
    log(`Downloading ${asset.file}`)
    const temporary = `${file}.${randomUUID()}.partial`
    try {
      const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(600_000) })
      if (!response.ok || !response.body) throw Error(`Source download failed: HTTP ${response.status} (${asset.file})`)
      const hash = createHash('sha256')
      let bytes = 0
      let header = Buffer.alloc(0)
      const checker = new Transform({ transform(chunk, _, callback) {
        bytes += chunk.length
        if (bytes > asset.bytes) return callback(Error(`Source archive exceeds recorded size: ${asset.file}`))
        if (header.length < 6) header = Buffer.concat([header, chunk.subarray(0, 6 - header.length)])
        hash.update(chunk)
        callback(null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body), checker, createWriteStream(temporary, { flags: 'wx' }))
      const magic = asset.file.endsWith('.gz') ? Buffer.from([0x1f, 0x8b]) : Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
      if (!header.subarray(0, magic.length).equals(magic)
          || bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
        throw Error(`Source archive verification failed: ${asset.file}; no checksum was updated`)
      }
      // Never replace an existing archive with an unverified or partial network response.
      await rm(file, { force: true })
      await rename(temporary, file)
      log(`Verified ${asset.file} (${bytes} bytes)`)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const checksums = manifest.archives.map(asset => `${asset.sha256}  ${asset.file}`).join('\n') + '\n'
  await writeFile(path.join(directory, 'SHA256SUMS'), checksums)
  await writeFile(path.join(directory, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { archiveCount: manifest.archives.length, totalBytes: manifest.archives.reduce((sum, file) => sum + file.bytes, 0) }
}

async function main() {
  const args = process.argv.slice(2)
  let directory = path.join(projectRoot, 'artifacts/corresponding-sources')
  let verifyOnly = false
  let listOnly = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--verify' || args[index] === '--offline') verifyOnly = true
    else if (args[index] === '--list') listOnly = true
    else if (args[index] === '--out-dir' && args[index + 1] && !args[index + 1].startsWith('--')) directory = path.resolve(args[++index])
    else throw Error('Usage: node scripts/fetch-corresponding-sources.mjs [--verify|--offline] [--list] [--out-dir PATH]')
  }
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (listOnly) {
    console.log(JSON.stringify(manifest, null, 2))
    return
  }
  const result = await fetchSourceArchives({ manifest, directory, verifyOnly })
  await copyFile(path.join(projectRoot, 'public/legal/CORRESPONDING-SOURCE.md'), path.join(directory, 'README.md'))
  console.log(`Verified ${result.archiveCount} upstream source archives (${result.totalBytes} bytes): ${directory}`)
  console.log('Read README.md: application source and vendored Rust editor sources are additional release materials.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
