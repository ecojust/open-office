import { readFile, lstat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const policy = JSON.parse(await readFile(new URL('./office-branding-policy.json', import.meta.url), 'utf8'))
export const slash = value => value.replaceAll('\\', '/')
export const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function isLegalPath(path) {
  const name = path.split('/').at(-1)
  return policy.legalDirectories.some(prefix => path.startsWith(prefix))
    || policy.legalFiles.includes(canonicalPath(path))
    || policy.legalBasenames.includes(name)
    || ['', '.txt', '.md'].includes(extname(name)) && policy.legalFilenamePrefixes.some(prefix => name.startsWith(prefix))
}

export function isHistoricalPath(path) {
  return (policy.historicalFiles ?? []).includes(path)
}

export function isExcludedSource(path) {
  return path.startsWith('public/') && !path.startsWith('public/legal/')
    || path.split('/').some(part => policy.excludedDirectories.includes(part))
}

export function canonicalPath(path) {
  for (const family of policy.families) {
    path = path.replaceAll(`vendor/${family.old}/`, `vendor/${family.directory}/`)
      .replaceAll(`/apps/${family.old}`, `/apps/${family.directory}`)
  }
  return path
}

export function compatibilityLiterals(path) {
  const normalized = canonicalPath(path)
  return policy.compatibility.filter(entry => entry.paths.includes(normalized)).flatMap(entry => entry.literals)
}

/** Return protected spans; ordinary comments and string literals remain audited. */
export function protectedSpans(text, path, { compatibility = true, provenance = true, dependencies = true } = {}) {
  const spans = []
  const add = (start, end, reason) => { if (end > start) spans.push({ start, end, reason }) }
  if (provenance) {
    // An in-source copyright notice is retained verbatim, not rewritten as our authorship.
    for (const match of text.matchAll(/^[ \t]*(?:\/\/[!/]?|#|\*|<!--)?[ \t]*(?:Copyright\s+(?:\(c\)\s+)?\d|SPDX-FileCopyrightText:)[^\r\n]*/gmi)) {
      add(match.index, match.index + match[0].length, 'copyright')
    }
    // Windows resource values, translated notices and plist text also carry real
    // attribution. Protect the literal payload, not the enclosing code or line.
    for (const match of text.matchAll(/"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|<string>[^<\r\n]*<\/string>/g)) {
      if (/Copyright\s+(?:\(c\)|©|the|\d)|©\s*\d/i.test(match[0])) add(match.index, match.index + match[0].length, 'copyright')
    }
    // Legal links still point to their original, unrenamed source records.
    for (const match of text.matchAll(/(?:\.?\.?\/)*public\/legal\/[^\s"'`<>)]*/g)) add(match.index, match.index + match[0].length, 'legal-link')
    // A versioned source or historical issue URL remains a factual upstream reference.
    // Never attach an upstream commit or issue number to this fork's repository URL.
    for (const match of text.matchAll(/https:\/\/(?:github\.com\/[^/\s]+\/[^/\s]+\/(?:blob|tree|commit|commits|archive|releases|pull|issues\/\d+)|raw\.githubusercontent\.com\/|codeload\.github\.com\/)[^\s"'`<>)]*/g)) {
      add(match.index, match.index + match[0].length, 'source-reference')
    }
    // Issue shorthand in source comments is historical evidence too.
    for (const match of text.matchAll(/\bstorytold\/[a-z][a-z0-9-]*#\d+\b/g)) {
      add(match.index, match.index + match[0].length, 'source-reference')
    }
    for (const literal of policy.historicalReferences ?? []) {
      for (const match of text.matchAll(new RegExp(escaped(literal), 'g'))) add(match.index, match.index + literal.length, 'historical-reference')
    }
    for (const entry of (policy.sourceReferences ?? []).filter(entry => entry.paths.includes(canonicalPath(path)))) {
      for (const pattern of entry.patterns) {
        for (const match of text.matchAll(new RegExp(pattern, 'g'))) add(match.index, match.index + match[0].length, 'external-reference')
      }
    }
  }
  if (compatibility) {
    for (const literal of compatibilityLiterals(path)) {
      let start = 0
      while ((start = text.indexOf(literal, start)) !== -1) {
        add(start, start + literal.length, 'compatibility')
        start += literal.length
      }
    }
  }
  if (dependencies) {
    for (const entry of policy.dependencyIdentities.filter(entry => entry.paths.includes(canonicalPath(path)))) {
      for (const pattern of entry.patterns) {
        for (const match of text.matchAll(new RegExp(pattern, 'g'))) add(match.index, match.index + match[0].length, 'dependency')
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end)
}

export function transformUnprotected(text, path, transform) {
  const spans = protectedSpans(text, path)
  let end = 0, result = ''
  for (const span of spans) {
    if (span.end <= end) continue
    if (span.start > end) result += transform(text.slice(end, span.start))
    result += text.slice(Math.max(end, span.start), span.end)
    end = span.end
  }
  return result + transform(text.slice(end))
}

/** Git's source inventory includes new, nonignored engine files without touching caches. */
export async function sourceFiles(root) {
  const listed = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const files = []
  for (const path of [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()) {
    if (isExcludedSource(path)) continue
    try {
      const info = await lstat(join(root, path))
      if (info.isSymbolicLink()) throw Error(`Source symlink is not audited: ${path}`)
      if (info.isFile()) files.push(path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return files
}

export async function artifactFiles(root, directory) {
  const files = []
  async function walk(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw Error(`Artifact symlink is not audited: ${slash(relative(root, path))}`)
    if (info.isDirectory()) {
      for (const item of await readdir(path)) await walk(join(path, item))
    } else if (info.isFile()) files.push(path)
  }
  await walk(directory)
  return files.sort()
}
