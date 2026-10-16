#!/usr/bin/env node
/** One-time source migration. Dry-run by default; never rewrites build output or legal records. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, lstat, rename, unlink, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath, escaped, isHistoricalPath, isLegalPath, policy, repositoryRoot, sourceFiles, transformUnprotected } from './office-branding-policy.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const decoder = new TextDecoder('utf-8', { fatal: true })

/** File and directory names use hyphens; Rust modules and environment variables use underscores. */
export function migratePath(path) {
  if (isHistoricalPath(path) || isLegalPath(path) && path.startsWith('public/legal/')) return path
  for (const family of policy.families) {
    path = path.replaceAll(family.old, family.directory)
      .replaceAll(family.pascal, family.type)
      .replaceAll(family.title, family.type)
      .replaceAll(family.old.toUpperCase(), family.identifier.toUpperCase())
  }
  for (const name of policy.marketingNames) {
    path = path.replaceAll(name.toUpperCase(), 'OPEN_OFFICE')
      .replaceAll(name.toLowerCase(), 'open_office')
      .replaceAll(name, 'OpenOffice')
  }
  return path
}

function rewriteFragment(text, path) {
  // Resolve complete promotional destinations before renaming identifier fragments.
  // Otherwise a bare website label or an API repository path can become a fictional URL.
  for (const host of policy.marketingHosts) {
    text = text.replace(new RegExp(`https?://(?:www\\.)?${escaped(host)}(?:/[^\\s"'\x60<>)]*)?`, 'g'), policy.repository)
      .replace(new RegExp(`(?:www\\.)?${escaped(host)}(?:/[^\\s"'\x60<>)]*)?`, 'g'), policy.repository.replace('https://', ''))
  }
  for (const family of policy.families) {
    text = text.replace(new RegExp(`https://github\\.com/storytold/${escaped(family.old)}(?:\\.git)?(?:/[^\\s"'\x60<>)]*)?(?=[\\s"'\x60<>)#]|$)`, 'g'), policy.repository)
    text = text.replaceAll(`https://api.github.com/repos/storytold/${family.old}`, policy.repository.replace('https://github.com/', 'https://api.github.com/repos/'))
      .replaceAll(`github.com/storytold/${family.old}`, policy.repository.replace('https://', ''))
      .replaceAll(`storytold/${family.old}`, policy.repository.replace('https://github.com/', ''))
  }
  for (const family of policy.families) {
    // A few artifact-only harnesses enumerate directory stems as whole strings.
    if ((policy.resourceIdentifierPaths ?? []).includes(path)) {
      text = text.replace(new RegExp(`(["'])${escaped(family.old)}\\1`, 'g'), `$1${family.directory}$1`)
    }
    for (const key of family.resourceKeys ?? [family.short]) {
      text = text.replace(new RegExp(`((?:\\b${escaped(key)}|["']${escaped(key)}["'])[ \\t]*:[ \\t]*["'])${escaped(family.old)}(["'])`, 'g'), `$1${family.directory}$2`)
    }
    // This fork's repository is distinct from the unchanged upstream records in legal/.
    text = text.replace(new RegExp(`https://github\\.com/storytold/${escaped(family.old)}(?:\\.git)?(?:/[^\\s"'\x60<>)]*)?(?=[\\s"'\x60<>)#]|$)`, 'g'), policy.repository)
      .replaceAll(`open-office-${family.old}-host`, family.host)
      .replaceAll(`open_office_${family.old}_host`, family.host.replaceAll('-', '_'))
      .replaceAll(`CARGO_BIN_EXE_${family.old}`, `CARGO_BIN_EXE_${family.directory}`)
      .replaceAll(`ai.storyteller.${family.old}`, `ai.storyteller.${family.directory}`)
      .replaceAll(family.old.toUpperCase(), family.identifier.toUpperCase())
      .replaceAll(family.pascal, family.type)
      .replaceAll(family.title, family.type)
    for (const alias of family.titleAliases ?? []) text = text.replaceAll(alias, family.type)
    text = text.replaceAll(`${family.old}_bg`, `${family.directory}_bg`)
      .replaceAll(`${family.old}_`, `${family.identifier}_`)
      .replaceAll(`${family.old}-`, `${family.directory}-`)
      .replaceAll(`${family.old}/`, `${family.directory}/`)
      .replaceAll(`${family.old}\\`, `${family.directory}\\`)
      .replaceAll(`${family.old}.js`, `${family.directory}.js`)
      .replaceAll(`${family.old}.d.ts`, `${family.directory}.d.ts`)
      .replaceAll(`${family.old}.exe`, `${family.directory}.exe`)
      .replaceAll(`${family.old}.wxs`, `${family.directory}.wxs`)
      .replaceAll(`${family.old}.mjs`, `${family.directory}.mjs`)
      .replaceAll(`${family.old}.cjs`, `${family.directory}.cjs`)
      .replaceAll(`${family.old}.ts`, `${family.directory}.ts`)
      .replaceAll(`${family.old}.py`, `${family.directory}.py`)
      .replaceAll(`${family.old}.md`, `${family.directory}.md`)
      .replaceAll(`${family.old}.toml`, `${family.directory}.toml`)
      .replaceAll(`${family.old}.log`, `${family.directory}.log`)
      .replaceAll(`${family.old}.png`, `${family.directory}.png`)
      .replaceAll(`${family.old}.svg`, `${family.directory}.svg`)
      .replaceAll(`${family.old}.ico`, `${family.directory}.ico`)
      .replaceAll(`${family.old}.icns`, `${family.directory}.icns`)
    // Whole directory strings (build scripts), package names and cache paths are not JS variables.
    text = text.replace(new RegExp(`((?:vendor|public|dist|apps|frontend)/)${escaped(family.old)}(?=["'\x60\\s)]|$)`, 'g'), `$1${family.directory}`)
      .replace(new RegExp(`(^[ \\t]*(?:name|default-run)[ \\t]*=[ \\t]*")${escaped(family.old)}(")`, 'gm'), `$1${family.directory}$2`)
      .replace(new RegExp(`((?:--package|--bin|-p)[ \\t]+)${escaped(family.old)}\\b`, 'g'), `$1${family.directory}`)
      .replace(new RegExp(`((?:["']--out-name["'][ \\t]*,[ \\t]*|["']${family.short}["']?[ \\t]*:[ \\t]*|\\b${family.short}[ \\t]*:[ \\t]*)["'])${escaped(family.old)}(["'])`, 'g'), `$1${family.directory}$2`)
      .replace(new RegExp(`(["']frontend["'][ \\t]*,[ \\t]*["'])${escaped(family.old)}(["'])`, 'g'), `$1${family.directory}$2`)
      .replace(new RegExp(`((?:Command::new|\\.join)\\(["'])${escaped(family.old)}(["'])`, 'g'), `$1${family.directory}$2`)
      .replace(new RegExp(`(["']InternalName["'][ \\t]*,[ \\t]*["'])${escaped(family.old)}(["'])`, 'g'), `$1${family.directory}$2`)
      .replace(new RegExp(`((?:target/(?:debug|release)|(?:[a-zA-Z_]+/)*bin|\\$\\{?BIN\\}?|(?:usr/)?share/(?:doc)?)/)${escaped(family.old)}(?=[\\s"'\x60.;)/]|$)`, 'g'), `$1${family.directory}`)
      .replace(new RegExp(`(^[ \\t]*(?:Exec|TryExec)[ \\t]*=[ \\t]*)${escaped(family.old)}\\b`, 'gm'), `$1${family.directory}`)
      .replace(new RegExp(`(^[ \\t]*(?:- )?(?:command|name):[ \\t]*)${escaped(family.old)}\\b`, 'gm'), `$1${family.directory}`)
      .replace(new RegExp(`(for (?:bin|name) in )${escaped(family.old)}\\b`, 'g'), `$1${family.directory}`)
      .replaceAll(`storytold/${family.old}`, policy.repository.replace('https://github.com/', ''))
      .replace(new RegExp(`${family.type} maintainers <${escaped(family.old)}@storyteller\\.ai>`, 'g'), 'Open Office maintainers')
      .replace(new RegExp(`(\\[[ \\t]*["'])${escaped(family.old)}(["'][ \\t]*,[ \\t]*["'])${escaped(family.old)}(["'][ \\t]*\\])`, 'g'), `$1${family.directory}$2${family.directory}$3`)
      .replace(new RegExp(`\\.${escaped(family.old)}(?=["'\x60])`, 'g'), `.${family.directory}`)
      .replaceAll(family.old, family.short)
  }
  // Remove obsolete promotional destinations instead of inventing renamed upstream URLs.
  for (const host of policy.marketingHosts) text = text.replace(new RegExp(`https?://(?:www\\.)?${escaped(host)}(?:/[^\\s"'\x60<>)]*)?`, 'g'), policy.repository)
  for (const url of policy.marketingUrls) text = text.replaceAll(url, policy.repository)
  for (const name of policy.marketingNames) {
    text = text.replace(new RegExp(`https://github\\.com/storytold/${escaped(name.toLowerCase())}(?:\\.git)?(?:/[^\\s"'\x60<>)]*)?(?=[\\s"'\x60<>)#]|$)`, 'g'), policy.repository)
      .replaceAll(name.toUpperCase(), 'OPEN_OFFICE')
      .replaceAll(name.toLowerCase(), 'open_office')
      .replaceAll(name, 'OpenOffice')
  }
  return text
}

export function migrateText(text, path) {
  if (isHistoricalPath(path) || isLegalPath(path)) return text
  let migrated = transformUnprotected(text, path, fragment => rewriteFragment(fragment, path))
  // A whole standalone product-label string is presentation, never a Rust/TS identifier.
  for (const family of policy.families) {
    migrated = migrated.replace(new RegExp(`(["'])${family.type}\\1`, 'g'), '$1Open Office$1')
  }
  // Host error payloads may contain user filenames. Source labels are migrated above;
  // remove the two legacy adapters that rewrote arbitrary runtime error strings.
  if (['vendor/office-sheet/apps/open-office-host/src/document.rs', 'vendor/office-presentation/apps/open-office-host/src/document.rs'].includes(canonicalPath(path))) {
    migrated = migrated.replace(/(pub\(crate\) fn clean_error\(error: impl std::fmt::Display\) -> String \{)[\s\S]*?\n\}/, '$1\n    error.to_string()\n}')
  }
  // Source-level branding is now correct. Delete only provably identical literal replacements,
  // avoiding any runtime rewriting of arbitrary filenames, document text or error payloads.
  migrated = migrated.replace(/\.(?:replace|replaceAll)\(\s*(["'])([^"'\r\n]*)\1\s*,\s*(["'])([^"'\r\n]*)\3\s*\)/g,
    (whole, _quote1, before, _quote2, after) => before === after ? '' : whole)
  return migrated
}

export async function createMigrationPlan(root = repositoryRoot) {
  root = resolve(root)
  const changes = [], skippedBinary = []
  for (const path of await sourceFiles(root)) {
    const absolute = join(root, path), bytes = await readFile(absolute)
    const nextPath = migratePath(path)
    let replacement = bytes
    try {
      if (bytes.includes(0)) throw Error('binary')
      const text = decoder.decode(bytes)
      replacement = Buffer.from(migrateText(text, path))
    } catch (error) {
      if (error.message !== 'binary' && error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error
      skippedBinary.push(path)
    }
    if (nextPath !== path || !replacement.equals(bytes)) changes.push({ path, nextPath, beforeHash: digest(bytes), afterHash: digest(replacement), mode: (await lstat(absolute)).mode & 0o777, bytes: replacement })
  }
  const destinations = new Set()
  for (const change of changes) {
    if (destinations.has(change.nextPath)) throw Error(`Migration has duplicate destination: ${change.nextPath}`)
    destinations.add(change.nextPath)
    if (change.path !== change.nextPath) {
      try {
        await lstat(join(root, change.nextPath))
        throw Error(`Migration destination already exists: ${change.nextPath}`)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return { root, changes, skippedBinary }
}

export function summarizePlan(plan) {
  return {
    schemaVersion: 1,
    root: plan.root,
    fileCount: plan.changes.length,
    renamedFiles: plan.changes.filter(change => change.path !== change.nextPath).length,
    rewrittenFiles: plan.changes.filter(change => change.beforeHash !== change.afterHash).length,
    preservedBinaryFiles: plan.skippedBinary.length,
    compatibility: policy.compatibility.map(({ id, reason }) => ({ id, reason })),
    changes: plan.changes.map(({ bytes: _bytes, mode: _mode, ...entry }) => entry),
  }
}

/** Refuse stale plans before the first write. Existing user changes are inputs, never reset. */
export async function applyMigrationPlan(plan) {
  for (const change of plan.changes) {
    const path = join(plan.root, change.path)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(path)) !== change.beforeHash) throw Error(`Source changed after planning: ${change.path}`)
    if (change.path !== change.nextPath) {
      try { await lstat(join(plan.root, change.nextPath)); throw Error(`Migration destination already exists: ${change.nextPath}`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  const oldDirectories = new Set()
  for (const change of plan.changes) {
    const source = join(plan.root, change.path), destination = join(plan.root, change.nextPath)
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.office-migration-${randomUUID()}`
    try {
      await writeFile(temporary, change.bytes, { flag: 'wx', mode: change.mode })
      await rename(temporary, destination)
    } finally {
      try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (source !== destination) {
      await unlink(source)
      for (let directory = dirname(source); directory !== plan.root; directory = dirname(directory)) oldDirectories.add(directory)
    }
  }
  // Remove empty source directories only; ignored caches and generated outputs stay untouched.
  for (const directory of [...oldDirectories].sort((a, b) => b.length - a.length)) {
    try { await rmdir(directory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
  }
  return summarizePlan(plan)
}

async function main() {
  const args = process.argv.slice(2)
  let root = repositoryRoot, output, apply = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true
    else if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i])
    else if (args[i] === '--plan' && args[i + 1]) output = resolve(args[++i])
    else throw Error('Usage: node scripts/migrate-office-names.mjs [--root PATH] [--plan FILE] [--apply]')
  }
  const plan = await createMigrationPlan(root)
  const summary = summarizePlan(plan)
  if (output) await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
  if (apply) await applyMigrationPlan(plan)
  console.log(`${apply ? 'Applied' : 'Planned'} Office naming migration: ${summary.renamedFiles} file moves, ${summary.rewrittenFiles} text updates. Legal text and compatibility identifiers retained.${apply ? '' : ' No repository files changed.'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
