import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkEditorBoundaries } from '../scripts/check-editor-boundaries.mjs'

async function fixture(t, { built = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'editor-boundaries-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, content = '') => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await put('package.json', JSON.stringify({ dependencies: { vue: '3.5.22', 'pdfjs-dist': '6.4.299' } }))
  await put('src-tauri/Cargo.toml', '[dependencies]\nserde = "1"\n')
  await put('src/App.vue', '<script>import PdfEditor from "./components/PdfEditor.vue"</script>')
  await put('src/components/PdfEditor.vue', 'import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"')
  await put('public/legal/retired-engine-notices.md', 'Historic office/host.html and word-engine/word_engine.wasm distributions used LibreOffice.')
  if (built) {
    await put('dist/index.html', '<script type="module" src="/assets/index-123.js"></script>')
    await put('dist/assets/index-123.js', 'const editor = new URL("deckcraft/deckcraft.js", document.baseURI)')
    for (const name of ['wordcraft', 'gridcraft', 'deckcraft']) {
      await put(`dist/${name}/${name}.js`, 'export function createHost() {}')
      await put(`dist/${name}/${name}_bg.wasm`, Buffer.from([0, 97, 115, 109]))
      await put(`dist/${name}/manifest.json`, '{}')
    }
    await put('dist/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap', 'fixture')
    await put('dist/pdfjs/standard_fonts/FoxitSerif.pfb', 'fixture')
    await put('dist/pdfjs/wasm/qcms_bg.wasm', Buffer.from([0, 97, 115, 109]))
    await put('dist/assets/pdf.worker.min-abc123.mjs', 'const worker = true')
    await put('dist/legal/retired-engine-notices.md', 'Historical word-engine/word_engine.wasm and office-runtime/soffice.wasm')
  }
  return { root, put }
}

test('current sources and PDF.js legacy API pass without generated editor output', async t => {
  const { root } = await fixture(t)
  await mkdir(join(root, 'crates/word-engine/src'), { recursive: true })
  await mkdir(join(root, 'public/office-runtime'), { recursive: true })
  assert.deepEqual(await checkEditorBoundaries({ root }), { ok: true, errors: [] })
})

test('ignored stale public runtime files block a build', async t => {
  const { root, put } = await fixture(t)
  await put('public/office-runtime/soffice.wasm', 'stale runtime')
  const report = await checkEditorBoundaries({ root })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some(error => error.includes('public/office-runtime: retired runtime assets')))
})

test('a dangling import of a deleted editor is still rejected', async t => {
  const { root, put } = await fixture(t)
  await put('src/App.vue', 'import OfficeEditor from "./components/OfficeEditor.vue"')
  const report = await checkEditorBoundaries({ root })
  assert.ok(report.errors.some(error => error.includes('imports retired source ./components/OfficeEditor.vue')))
})

test('native dependencies cannot reintroduce the retired engine through an alias', async t => {
  const { root, put } = await fixture(t)
  await put('src-tauri/Cargo.toml', '[dependencies]\nengine = { package = "word-engine", version = "1" }')
  const report = await checkEditorBoundaries({ root })
  assert.ok(report.errors.some(error => error.includes('src-tauri/Cargo.toml: retains a retired native Word dependency')))
})

test('an npm script cannot recreate the removed Office distribution', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', JSON.stringify({ scripts: { assets: 'node scripts/fetch-office-runtime.mjs' } }))
  const report = await checkEditorBoundaries({ root })
  assert.ok(report.errors.some(error => error.includes('script assets runs a retired engine')))
})

test('distribution requires all three current editor bundles and offline PDF assets', async t => {
  const { root } = await fixture(t, { built: true })
  assert.deepEqual(await checkEditorBoundaries({ root, dist: true }), { ok: true, errors: [] })
  await rm(join(root, 'dist/deckcraft/deckcraft_bg.wasm'))
  await rm(join(root, 'dist/assets/pdf.worker.min-abc123.mjs'))
  const report = await checkEditorBoundaries({ root, dist: true })
  assert.ok(report.errors.some(error => error.includes('dist/deckcraft/deckcraft_bg.wasm: missing')))
  assert.ok(report.errors.some(error => error.includes('missing bundled PDF.js worker')))
})

test('stale distribution assets are rejected even when public has already been cleaned', async t => {
  const { root, put } = await fixture(t, { built: true })
  await put('dist/office/host.html', '<script src="host.js"></script>')
  assert.equal((await checkEditorBoundaries({ root })).ok, true)
  const report = await checkEditorBoundaries({ root, dist: true })
  assert.ok(report.errors.some(error => error.includes('dist/office: retired runtime assets')))
})

test('frontend chunks cannot retain old host URLs after asset removal', async t => {
  const { root, put } = await fixture(t, { built: true })
  await put('dist/assets/index-123.js', 'const frame = "/office/host.html"; invoke("word_read_package", data)')
  const report = await checkEditorBoundaries({ root, dist: true })
  assert.ok(report.errors.some(error => error.includes('dist/assets/index-123.js: references retired Office host')))
  assert.ok(report.errors.some(error => error.includes('dist/assets/index-123.js: references retired native Word command')))
})

test('relocating or renaming an obsolete WASM bundle does not evade the audit', async t => {
  const { root, put } = await fixture(t, { built: true })
  await put('dist/assets/alternate-engine.wasm', 'stale')
  const report = await checkEditorBoundaries({ root, dist: true })
  assert.ok(report.errors.some(error => error.includes('dist/assets/alternate-engine.wasm: unexpected WASM engine')))
})

test('symlinked asset directories cannot hide retired engines outside the scan', async t => {
  const { root } = await fixture(t)
  await symlink(join(root, 'src'), join(root, 'public/hidden-runtime'), 'dir')
  const report = await checkEditorBoundaries({ root })
  assert.ok(report.errors.some(error => error.includes('public/hidden-runtime: symlinks are not audited')))
})
