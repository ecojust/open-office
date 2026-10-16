#!/usr/bin/env node
/** Audit source names, final assets and explicitly supplied logs without mutating them. */
import { readFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactFiles, escaped, isHistoricalPath, isLegalPath, policy, protectedSpans, repositoryRoot, slash, sourceFiles } from './office-branding-policy.mjs'

const prohibited = [...policy.families.map(family => family.old), ...policy.marketingNames]
const engineNames = prohibited.sort((a, b) => b.length - a.length).map(escaped).join('|')
// A file such as office_pdf.js contains a suffix shared with a retired viewer name.
// Dependency signatures remain detectable, without rejecting our own artifact stem.
const retiredNames = policy.retiredPdfNames.sort((a, b) => b.length - a.length).map(escaped).join('|')
const expression = new RegExp(`${engineNames}|\\b(?:${retiredNames})\\b`, 'gi')
const invalidProjectReferences = new RegExp((policy.invalidProjectReferences ?? []).join('|'), 'gi')
const decoder = new TextDecoder('utf-8', { fatal: true })

function masked(text, spans) {
  // Preserve line positions in diagnostics while hiding only documented literal spans.
  const pieces = []
  let end = 0
  for (const span of spans) {
    if (span.end <= end) continue
    if (span.start > end) pieces.push(text.slice(end, span.start))
    pieces.push(text.slice(Math.max(end, span.start), span.end).replace(/[^\r\n]/g, ' '))
    end = span.end
  }
  return pieces.join('') + text.slice(end)
}

/** Binary compatibility tokens must be complete tokens, not prefixes of old package names. */
function binaryCompatibilitySpans(text) {
  const spans = []
  for (const literal of new Set(policy.compatibility.flatMap(entry => entry.literals))) {
    const raw = literal.startsWith('"') && literal.endsWith('"') ? literal.slice(1, -1) : literal
    for (const match of text.matchAll(new RegExp(escaped(raw), 'g'))) {
      const start = match.index, end = start + raw.length
      const shortToken = /^[a-z]+$/i.test(raw)
      if (shortToken && (/[a-zA-Z0-9_-]/.test(text[start - 1] ?? '') || /[a-zA-Z0-9_-]/.test(text[end] ?? ''))) continue
      spans.push({ start, end })
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end)
}

/** A bundled legal notice is exempt only as its complete observed UTF-8 byte payload. */
function binaryLegalSpans(text, path) {
  const spans = []
  for (const entry of policy.embeddedLegalNotices ?? []) {
    if (basename(path) !== entry.assetBasename) continue
    for (const { literal } of entry.notices) {
      // WASM is inspected as Latin-1 so every string offset is a byte offset.
      // Re-encode the original notice rather than losing multilingual text.
      const bytes = Buffer.from(literal, 'utf8').toString('latin1')
      let start = 0
      while ((start = text.indexOf(bytes, start)) !== -1) {
        spans.push({ start, end: start + bytes.length })
        start += bytes.length
      }
    }
  }
  return spans
}

/** Rust may pack an extension-alias array contiguously; accept only observed whole sequences. */
function binaryCompatibilitySequenceSpans(text, path) {
  const spans = []
  for (const entry of policy.embeddedCompatibilitySequences ?? []) {
    if (basename(path) !== entry.assetBasename) continue
    const bytes = Buffer.from(entry.literal, 'utf8').toString('latin1')
    let start = 0
    while ((start = text.indexOf(bytes, start)) !== -1) {
      spans.push({ start, end: start + bytes.length })
      start += bytes.length
    }
  }
  return spans
}

export function inspectBranding(text, path, { kind = 'source' } = {}) {
  if (kind !== 'log' && (isLegalPath(path) || kind === 'source' && isHistoricalPath(path))) return []
  const findings = []
  // Fabricated URLs cannot become valid merely by appearing in a source comment.
  // Original legal records and immutable historical files were excluded above.
  for (const match of text.matchAll(invalidProjectReferences)) {
    const line = kind === 'wasm' ? 0 : text.slice(0, match.index).split('\n').length
    findings.push({ path, line, kind, message: 'Fabricated project URL or repository reference' })
  }
  expression.lastIndex = 0
  const pathToInspect = kind === 'source' ? masked(path, protectedSpans(path, path)) : path
  if (expression.test(pathToInspect)) findings.push({ path, line: 0, kind: 'path', message: 'Obsolete product name in a source or asset path' })
  expression.lastIndex = 0
  const spans = kind === 'source' ? protectedSpans(text, path)
    : kind === 'wasm' ? [...binaryCompatibilitySpans(text), ...binaryLegalSpans(text, path), ...binaryCompatibilitySequenceSpans(text, path)].sort((a, b) => a.start - b.start || b.end - a.end) : []
  const inspect = masked(text, spans)
  for (const match of inspect.matchAll(expression)) {
    const line = kind === 'wasm' ? 0 : inspect.slice(0, match.index).split('\n').length
    findings.push({ path, line, kind, message: 'Obsolete product name outside an explicit legal or protocol exception' })
  }
  expression.lastIndex = 0
  return findings
}

export async function checkOfficeBranding({ root = repositoryRoot, source = true, dist = false, logs = [] } = {}) {
  root = resolve(root)
  const findings = [], checked = { source: 0, assets: 0, logs: 0 }
  if (source) {
    for (const path of await sourceFiles(root)) {
      if (isLegalPath(path) || isHistoricalPath(path)) continue
      const bytes = await readFile(join(root, path))
      let text = ''
      try { if (!bytes.includes(0)) text = decoder.decode(bytes) } catch (error) { if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error }
      findings.push(...inspectBranding(text, path))
      checked.source++
    }
  }
  if (dist) {
    const directory = typeof dist === 'string' ? resolve(root, dist) : join(root, 'dist')
    for (const path of await artifactFiles(root, directory)) {
      const asset = slash(relative(directory, path))
      if (isLegalPath(`public/${asset}`)) continue
      const bytes = await readFile(path), wasm = extname(path) === '.wasm'
      let text = ''
      if (wasm) text = bytes.toString('latin1')
      else {
        try { if (!bytes.includes(0)) text = decoder.decode(bytes) } catch (error) { if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error }
      }
      findings.push(...inspectBranding(text, slash(relative(root, path)), { kind: wasm ? 'wasm' : 'asset' }))
      checked.assets++
    }
  }
  for (const entry of logs) {
    const path = resolve(root, entry)
    for (const file of await artifactFiles(root, path)) {
      const text = await readFile(file, 'utf8')
      findings.push(...inspectBranding(text, slash(relative(root, file)), { kind: 'log' }))
      checked.logs++
    }
  }
  const unique = [...new Map(findings.map(finding => [`${finding.path}:${finding.line}:${finding.kind}`, finding])).values()]
  return { ok: unique.length === 0, checked, findings: unique }
}

async function main() {
  const options = { logs: [] }
  const args = process.argv.slice(2)
  let json = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) options.root = args[++i]
    else if (args[i] === '--dist') options.dist = true
    else if (args[i] === '--assets' && args[i + 1]) options.dist = args[++i]
    else if (args[i] === '--no-source') options.source = false
    else if (args[i] === '--log' && args[i + 1]) options.logs.push(args[++i])
    else if (args[i] === '--json') json = true
    else throw Error('Usage: node scripts/check-office-branding.mjs [--root PATH] [--dist|--assets PATH] [--log PATH] [--no-source] [--json]')
  }
  const result = await checkOfficeBranding(options)
  if (json) console.log(JSON.stringify(result, null, 2))
  else if (result.ok) console.log(`Office naming audit passed: ${result.checked.source} sources, ${result.checked.assets} assets, ${result.checked.logs} logs.`)
  else {
    console.error(`Office naming audit found ${result.findings.length} locations requiring review.`)
    for (const finding of result.findings.slice(0, 80)) console.error(`${finding.path}${finding.line ? `:${finding.line}` : ''}: ${finding.message}`)
    if (result.findings.length > 80) console.error('Use --json for the complete report.')
  }
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
