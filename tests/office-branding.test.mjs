import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { inspectBranding, checkOfficeBranding } from '../scripts/check-office-branding.mjs'
import { applyMigrationPlan, createMigrationPlan, migratePath, migrateText } from '../scripts/migrate-office-names.mjs'
import { policy, repositoryRoot } from '../scripts/office-branding-policy.mjs'

const run = promisify(execFile)
const word = policy.families[0]
const quote = value => JSON.stringify(value)

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'office-naming-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await run('git', ['init', '--quiet'], { cwd: root })
  return root
}

async function put(root, path, text) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

async function sourceText(path) {
  try { return await readFile(join(repositoryRoot, path), 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT' || migratePath(path) === path) throw error
    return readFile(join(repositoryRoot, migratePath(path)), 'utf8')
  }
}

test('source identifiers, resource paths and display labels have distinct replacements', () => {
  for (const family of policy.families) {
    const source = `struct ${family.title}App; type ${family.pascal}Snapshot = (); use ${family.old}_doc::Document;
const label = ${quote(family.title)}; const ${family.old} = 1; report.${family.old} = ${family.old};
const artifact = '${family.old}/${family.old}_bg.wasm'; const bindgen = ['--out-name', '${family.old}'];`
    const result = migrateText(source, 'src/example.rs')
    assert.ok(result.includes(`struct ${family.type}App;`))
    assert.ok(result.includes(`type ${family.type}Snapshot`))
    assert.ok(result.includes(`use ${family.identifier}_doc::Document`))
    assert.ok(result.includes('const label = "Open Office"'))
    assert.ok(result.includes(`report.${family.short} = ${family.short}`))
    assert.ok(result.includes(`'${family.directory}/${family.directory}_bg.wasm'`))
    assert.ok(result.includes(`'--out-name', '${family.directory}'`))
    assert.equal(inspectBranding(result, 'src/example.rs').length, 0)
  }
})

test('Cargo application targets and workspace default members name actual directories and binaries', async () => {
  for (const family of policy.families) {
    const original = `name = "${family.old}"\ndefault-run = "${family.old}"\ndefault-members = ["apps/${family.old}", "apps/${family.old}-cli"]\n`
    const migrated = migrateText(original, `vendor/${family.old}/Cargo.toml`)
    assert.ok(migrated.includes(`name = "${family.directory}"`))
    assert.ok(migrated.includes(`default-run = "${family.directory}"`))
    assert.ok(migrated.includes(`"apps/${family.directory}"`))
    assert.ok(migrated.includes(`"apps/${family.directory}-cli"`))
    const workspace = await sourceText(`vendor/${family.directory}/Cargo.toml`)
    assert.ok(workspace.includes(`"apps/${family.directory}"`))
    const app = await sourceText(`vendor/${family.directory}/apps/${family.directory}/Cargo.toml`)
    assert.ok(app.includes(`name = "${family.directory}"`))
    if (app.includes('default-run')) assert.ok(app.includes(`default-run = "${family.directory}"`))
  }
})

test('native executable, desktop IDs and package resource references follow renamed artifacts', () => {
  for (const family of policy.families) {
    const input = `env!("CARGO_BIN_EXE_${family.old}")\nCommand::new("${family.old}")\npath.join("${family.old}")\nExec=${family.old} %F\nTryExec=${family.old}\ncommand: ${family.old}\n  - name: ${family.old}\nfor bin in ${family.old} ${family.old}-cli; do\ninstall target/release/${family.old} /app/bin/${family.old}\nAPP_ID=ai.storyteller.${family.old}\n`
    const result = migrateText(input, 'scripts/package.sh')
    for (const expected of [`CARGO_BIN_EXE_${family.directory}`, `Command::new("${family.directory}")`, `.join("${family.directory}")`, `Exec=${family.directory}`, `command: ${family.directory}`, `name: ${family.directory}`, `for bin in ${family.directory}`, `target/release/${family.directory}`, `/app/bin/${family.directory}`, `ai.storyteller.${family.directory}`]) assert.ok(result.includes(expected), expected)
    const resources = migrateText(`.set("OriginalFilename", "${family.old}.exe").set("InternalName", "${family.old}")\ninclude_str!("../windows/${family.old}.wxs")\nconst FILES = ['${family.old}.d.ts']; directory: 'frontend/${family.old}'`, 'src/resources.rs')
    for (const expected of [`"${family.directory}.exe"`, `"InternalName", "${family.directory}"`, `windows/${family.directory}.wxs`, `'${family.directory}.d.ts'`, `'frontend/${family.directory}'`]) assert.ok(resources.includes(expected), expected)
  }
})

test('actual build scripts, client URLs, boundary checks and icon inputs agree after migration', async () => {
  const iconsPath = 'scripts/build-office-icons.mjs'
  const icons = migrateText(await readFile(join(repositoryRoot, iconsPath), 'utf8'), iconsPath)
  const boundariesPath = 'scripts/check-editor-boundaries.mjs'
  const boundaries = migrateText(await readFile(join(repositoryRoot, boundariesPath), 'utf8'), boundariesPath)
  for (const family of policy.families.slice(0, 3)) {
    const buildPath = `scripts/build-${family.old}.mjs`
    const build = migrateText(await sourceText(buildPath), buildPath)
    const clientPath = `src/${family.short}/rust/client.ts`
    const client = migrateText(await readFile(join(repositoryRoot, clientPath), 'utf8'), clientPath)
    assert.ok(build.includes(`'--out-name', '${family.directory}'`))
    assert.ok(build.includes(`'${family.directory}_bg.wasm'`))
    assert.ok(build.includes(`${family.host.replaceAll('-', '_')}.wasm`))
    assert.ok(client.includes(`${family.directory}/${family.directory}.js`))
    assert.ok(client.includes(`${family.directory}/${family.directory}_bg.wasm`))
    const inspector = await sourceText(`scripts/${family.directory}-native-smoke.mjs`)
    assert.ok(inspector.includes(`'${family.directory}.d.ts'`))
    assert.ok(inspector.includes(`directory: 'frontend/${family.directory}'`))
    assert.ok(boundaries.includes(`['${family.directory}', '${family.directory}']`))
    const key = family.short === 'presentation' ? 'deck' : family.short
    assert.ok(icons.includes(`${key}: '${family.directory}'`))
  }
  assert.ok(boundaries.includes("['office-pdf', 'office_pdf']"))
})

test('fixed upstream provenance, copyrights and historical results retain original bytes', () => {
  const original = `https://github.com/storytold/${word.old}/blob/0123456789/src/lib.rs`
  const copyright = `// Copyright 2026 ${word.title} contributors`
  const home = `https://github.com/storytold/${word.old}`
  const migrated = migrateText(`${original}\n${copyright}\n${home}\n`, 'src/example.rs')
  assert.equal(migrated, `${original}\n${copyright}\n${policy.repository}\n`)
  assert.equal(migrateText(`${home}.git`, 'docs/setup.md'), policy.repository)
  assert.equal(migrateText(`${home}/issues/new?template=bug`, 'docs/setup.md'), policy.repository)
  assert.equal(inspectBranding(migrated, 'src/example.rs').length, 0)
  const resourceCopyright = `Copyright (c) the ${word.title} authors. MIT OR Apache-2.0.`
  const resources = `.set("LegalCopyright", "${resourceCopyright}").set("InternalName", "${word.old}")`
  const resourceResult = migrateText(resources, 'src/build.rs')
  assert.ok(resourceResult.includes(quote(resourceCopyright)))
  assert.ok(resourceResult.includes(`"InternalName", "${word.directory}"`))
  assert.equal(inspectBranding(resourceResult, 'src/build.rs').length, 0)
  assert.ok(inspectBranding(resourceCopyright, 'runtime.log', { kind: 'log' }).length)
  const historyPath = policy.historicalFiles[0]
  assert.ok(historyPath)
  const history = JSON.stringify({ engine: word.title, sourceHash: word.old })
  assert.equal(migrateText(history, historyPath), history)
  assert.equal(migratePath(historyPath), historyPath)
  assert.equal(inspectBranding(history, historyPath).length, 0)
  assert.ok(inspectBranding(history, historyPath, { kind: 'log' }).length)
})

test('compatibility exceptions apply only at explicit source paths or as exact WASM tokens', () => {
  const entry = policy.compatibility.find(entry => entry.id === 'word-canvas-transform-uri')
  const literal = entry.literals[0]
  const path = entry.paths[0]
  assert.equal(migrateText(quote(literal), path), quote(literal))
  assert.equal(inspectBranding(quote(literal), path).length, 0)
  assert.ok(inspectBranding(quote(literal), 'src/unrelated.rs').length)
  assert.equal(inspectBranding(`\0${literal}\0`, 'dist/editor.wasm', { kind: 'wasm' }).length, 0)
  assert.ok(inspectBranding(`\0${word.old}_doc::Document\0`, 'dist/editor.wasm', { kind: 'wasm' }).length)
  const pdf = policy.families.at(-1)
  assert.ok(inspectBranding(`\0${pdf.title}App\0`, 'dist/editor.wasm', { kind: 'wasm' }).length)
  assert.ok(inspectBranding(literal, 'dist/editor.js', { kind: 'asset' }).length)
  assert.ok(inspectBranding(literal, 'runtime.log', { kind: 'log' }).length)
  assert.equal(inspectBranding('office_pdf.js office_pdf_bg.wasm', 'dist/office-pdf/office_pdf.js', { kind: 'asset' }).length, 0)
})

test('observed embedded legal payloads preserve UTF-8 and never exempt partial names or logs', async () => {
  for (const entry of policy.embeddedLegalNotices) {
    assert.ok(entry.notices.length > 0)
    for (const { literal, sourcePaths } of entry.notices) {
      assert.ok(literal.length > 50)
      assert.ok(sourcePaths.length > 0)
      for (const path of sourcePaths) assert.ok((await sourceText(path)).includes(literal), path)
      const bytes = Buffer.from(literal, 'utf8').toString('latin1')
      const path = `dist/editor/${entry.assetBasename}`
      assert.equal(inspectBranding(`\0${bytes}\0`, path, { kind: 'wasm' }).length, 0)
      assert.ok(inspectBranding(bytes.slice(1), path, { kind: 'wasm' }).length)
      assert.ok(inspectBranding(bytes, 'dist/unknown.wasm', { kind: 'wasm' }).length)
      assert.ok(inspectBranding(`${bytes}${word.old}`, path, { kind: 'wasm' }).length)
      assert.ok(inspectBranding(literal, 'runtime.log', { kind: 'log' }).length)
      assert.ok(inspectBranding(literal, 'dist/editor.js', { kind: 'asset' }).length)
    }
  }
})

test('observed packed extension aliases require the complete source-verified WASM sequence', async () => {
  const aliases = new Set(policy.compatibility.flatMap(entry => entry.literals))
  for (const entry of policy.embeddedCompatibilitySequences) {
    assert.ok(entry.parts.length > 1)
    assert.equal(entry.literal, `${entry.parts.map(part => part.literal).join('')}\0`)
    for (const [index, part] of entry.parts.entries()) {
      assert.ok((await sourceText(part.sourcePath)).includes(quote(part.literal)), part.sourcePath)
      if (index > 0) assert.ok(aliases.has(quote(part.literal)))
    }
    const path = `dist/editor/${entry.assetBasename}`
    assert.equal(inspectBranding(entry.literal, path, { kind: 'wasm' }).length, 0)
    assert.ok(inspectBranding(entry.literal.slice(1), path, { kind: 'wasm' }).length)
    assert.ok(inspectBranding(entry.literal.slice(0, -1), path, { kind: 'wasm' }).length)
    assert.ok(inspectBranding(entry.literal, 'dist/unknown.wasm', { kind: 'wasm' }).length)
    assert.ok(inspectBranding(`${entry.literal}${word.old}`, path, { kind: 'wasm' }).length)
    assert.ok(inspectBranding(entry.literal, 'runtime.log', { kind: 'log' }).length)
    assert.ok(inspectBranding(entry.literal, 'dist/editor.js', { kind: 'asset' }).length)
  }
})

test('host error adapters preserve arbitrary filenames and messages without branding replacement', async () => {
  for (const family of policy.families.slice(1, 3)) {
    const path = `vendor/${family.old}/apps/open-office-host/src/document.rs`
    const migrated = migrateText(await sourceText(path), path)
    const adapter = migrated.match(/pub\(crate\) fn clean_error[\s\S]*?\n\}/)?.[0]
    assert.ok(adapter)
    assert.ok(adapter.includes('error.to_string()'))
    assert.ok(!adapter.includes('.replace'))
  }
})

test('dry-run does not mutate; apply preserves binary and legal content and skips generated output', async t => {
  const root = await repository(t)
  const originalPath = `vendor/${word.old}/src/lib.rs`
  const original = `pub struct ${word.title}App; // existing local work\n`
  const licensePath = `vendor/${word.old}/LICENSE`
  const license = `${word.title} copyright\n`
  const binaryPath = `vendor/${word.old}/tests/sample.bin`
  const binary = Buffer.from([0, 255, 10, 0])
  const generatedPath = `public/${word.old}/generated.js`
  await put(root, originalPath, original)
  await put(root, licensePath, license)
  await put(root, binaryPath, binary)
  await put(root, generatedPath, original)
  const plan = await createMigrationPlan(root)
  assert.equal(await readFile(join(root, originalPath), 'utf8'), original)
  assert.equal(plan.changes.length, 3)
  await applyMigrationPlan(plan)
  assert.equal(await readFile(join(root, migratePath(originalPath)), 'utf8'), `pub struct ${word.type}App; // existing local work\n`)
  assert.equal(await readFile(join(root, migratePath(licensePath)), 'utf8'), license)
  assert.deepEqual(await readFile(join(root, migratePath(binaryPath))), binary)
  assert.equal(await readFile(join(root, generatedPath), 'utf8'), original)
  await assert.rejects(readFile(join(root, originalPath)), { code: 'ENOENT' })
})

test('stale sources and destination collisions abort before the first write', async t => {
  const root = await repository(t)
  const first = `src/a-${word.old}.ts`, second = `src/z-${word.old}.ts`
  await put(root, first, 'const a = 1\n')
  await put(root, second, 'const z = 1\n')
  const plan = await createMigrationPlan(root)
  await put(root, second, 'const z = 2 // newer edit\n')
  await assert.rejects(applyMigrationPlan(plan), /Source changed after planning/)
  assert.equal(await readFile(join(root, first), 'utf8'), 'const a = 1\n')
  await assert.rejects(readFile(join(root, migratePath(first))), { code: 'ENOENT' })
  const current = await createMigrationPlan(root)
  await put(root, migratePath(second), 'occupied\n')
  await assert.rejects(applyMigrationPlan(current), /destination already exists/)
  assert.equal(await readFile(join(root, first), 'utf8'), 'const a = 1\n')
})

test('new assets and explicitly requested logs are audited independently of source exclusions', async t => {
  const root = await repository(t)
  await put(root, 'src/app.ts', 'export const name = "Open Office"\n')
  await put(root, 'dist/app.js', `console.log(${quote(word.title)})\n`)
  await put(root, 'test-results/runtime.log', `error: ${word.title}\n`)
  const result = await checkOfficeBranding({ root, source: true, dist: true, logs: ['test-results/runtime.log'] })
  assert.equal(result.ok, false)
  assert.deepEqual(result.checked, { source: 1, assets: 1, logs: 1 })
  assert.deepEqual(result.findings.map(finding => finding.kind), ['asset', 'log'])
})

test('project references reject fabricated migration URLs in source, assets and logs', () => {
  const invalid = [
    `getopen${'_office.com'}/apps/office-pdf`,
    ...policy.families.flatMap(family => [
      `github.com/${'storytold/'}${family.short}`,
      `https://api.github.com/repos/${'storytold/'}${family.directory}/releases/latest`,
    ]),
  ]
  for (const text of invalid) {
    for (const kind of ['source', 'asset', 'wasm', 'log']) {
      assert.ok(inspectBranding(text, 'src/project-links.rs', { kind }).some(finding => finding.message.startsWith('Fabricated project')))
    }
  }
  assert.equal(inspectBranding(policy.repository, 'src/project-links.rs').length, 0)
  const historicalSource = `https://github.com/storytold/${word.old}/blob/1234567/src/lib.rs`
  assert.equal(inspectBranding(historicalSource, 'src/project-links.rs').length, 0)
  // An unchanged, real upstream release stream is a factual exception, never a
  // fictional repository assembled from our new binary name.
  const updates = 'vendor/office-pdf/apps/office-pdf/src/updates.rs'
  const upstream = `https://api.github.com/repos/storytold/${policy.families[3].old}/releases/latest`
  assert.equal(inspectBranding(upstream, updates).length, 0)
})

test('migration resolves bare website labels and repository paths before identifier renaming', () => {
  for (const host of policy.marketingHosts) {
    const display = migrateText(`${host}/apps/${word.old}`, 'src/dialog.rs')
    assert.equal(display, policy.repository.replace('https://', ''))
    assert.equal(migrateText(`https://${host}/apps/${word.old}`, 'src/dialog.rs'), policy.repository)
  }
  for (const family of policy.families) {
    assert.equal(migrateText(`github.com/storytold/${family.old}`, 'src/dialog.rs'), policy.repository.replace('https://', ''))
    const issue = `storytold/${family.old}#255`
    assert.equal(migrateText(`// Rendering fix from ${issue}.`, 'src/render.rs'), `// Rendering fix from ${issue}.`)
    const migrated = migrateText(`https://api.github.com/repos/storytold/${family.old}/releases/latest`, 'src/new-updater.rs')
    assert.equal(migrated, policy.repository.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases/latest')
    assert.equal(inspectBranding(migrated, 'src/new-updater.rs').length, 0)
  }
})
