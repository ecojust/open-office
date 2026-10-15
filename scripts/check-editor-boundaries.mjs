import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const editors = ['wordcraft', 'gridcraft', 'deckcraft']
const retiredSource = [
  'crates/word-engine', 'crates/word-package', 'src/office', 'src/word/core', 'src/presentation/core',
  'src/components/OfficeEditor.vue', 'src/components/PresentationEffects.vue',
  'src/components/PresentationFontNotice.vue', 'src/components/PresentationWorkbench.vue',
  'src/components/SheetWorkbench.vue', 'src/components/SlidePreview.vue',
  'src/components/StandalonePresentationEditor.vue', 'src/components/StandaloneWordEditor.vue',
  'src/components/WordWorkbench.vue', 'src/presentation/chart-workbook.ts',
  'src/presentation/native-smoke.ts', 'src/presentation/pptx-package.ts',
  'src/presentation/session.ts', 'src/presentation/types.ts', 'src/presentation/workbench.css',
  'src/sheet/types.ts', 'src/word/draft-review.ts', 'src/word/rust/native-smoke.ts',
  'src/word/rust/types.ts', 'src/word/rust/worker.ts', 'src/word/types.ts', 'src-tauri/src/word.rs',
  'scripts/build-word-engine.mjs', 'scripts/fetch-office-runtime.mjs',
  'scripts/office-mouse-time-patch.mjs', 'scripts/rust-word-native-smoke.mjs',
  'scripts/word-package-native-smoke.mjs', 'vendor/office-runtime-manifest.json',
]
const retiredAssetRoots = ['office', 'office-runtime', 'word-engine', 'word-package']
// Match concrete runtime entry points, not historical product names or PDF.js's
// supported legacy/build entry point. Legal notices and Markdown are not code.
const runtimeReferences = [
  ['retired Office host', /(?:^|[\/"'`])office\/host\.(?:html|js)\b/],
  ['retired Office runtime', /\boffice-runtime[\/]/],
  ['retired Word runtime', /\bword-engine[\/]/],
  ['retired Word package runtime', /\bword-package[\/]/],
  ['retired native Word command', /\b(?:word_engine_request|word_read_package|word_write_package)\b/],
  ['retired Office bootstrap URL', /\bruntimeBaseUrl\b/],
]
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.html', '.rs'])
const retiredDependency = /^(?:word[-_]engine|word[-_]package|zetajs|zetaoffice|libreoffice)(?:$|[-/])/i

const slash = value => value.replaceAll('\\', '/')
async function stat(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function read(path) {
  try { return await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function containsArtifact(path) {
  const info = await stat(path)
  if (!info) return false
  if (!info.isDirectory()) return true
  for (const entry of await readdir(path)) {
    if (await containsArtifact(join(path, entry))) return true
  }
  return false // Git does not track empty directories left after a deletion.
}
async function files(root, directory, errors) {
  const found = []
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['legal', '.git', 'target', 'node_modules'].includes(entry.name)) continue
      const absolute = join(path, entry.name)
      // Deployment assets must be self-contained, and a symlink must not hide
      // an engine from this audit or make us scan outside the repository.
      if (entry.isSymbolicLink()) errors.push(`${slash(relative(root, absolute))}: symlinks are not audited; use a regular file or directory`)
      else if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) found.push(absolute)
    }
  }
  const directoryStat = await stat(directory)
  if (directoryStat?.isSymbolicLink()) errors.push(`${slash(relative(root, directory))}: symlinks are not audited; use a regular directory`)
  else if (directoryStat?.isDirectory()) await walk(directory)
  return found
}

/** Audit retired engine boundaries without requiring a Rust build or network. */
export async function checkEditorBoundaries({ root = repoRoot, dist = false } = {}) {
  root = resolve(root)
  const errors = []
  for (const path of retiredSource) {
    if (await containsArtifact(join(root, path))) errors.push(`${path}: retired engine source must be removed`)
  }
  const packageText = await read(join(root, 'package.json'))
  if (packageText === null) errors.push('package.json: missing dependency manifest')
  else {
    const manifest = JSON.parse(packageText)
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[group] ?? {})) {
        if (retiredDependency.test(name.replace(/^@[^/]+\//, '')) || /(?:crates\/)?word-(?:engine|package)(?:[\/]|$)/.test(String(version))) {
          errors.push(`package.json: ${group}.${name} retains a retired engine dependency`)
        }
      }
    }
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (/\b(?:build-word-engine|fetch-office-runtime|office-mouse-time-patch|rust-word-native-smoke|word-package-native-smoke)\.(?:mjs|cjs)\b/.test(command)) {
        errors.push(`package.json: script ${name} runs a retired engine`)
      }
    }
  }
  for (const path of ['Cargo.toml', 'Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const content = await read(join(root, path))
    if (content && /(?:^|\n)\s*(?:name\s*=\s*["']word[-_](?:engine|package)["']|word[-_](?:engine|package)\s*=)|\bpackage\s*=\s*["']word[-_](?:engine|package)["']|\bpath\s*=\s*["'][^"']*\bword-(?:engine|package)(?:[\/"'])/m.test(content)) {
      errors.push(`${path}: retains a retired native Word dependency`)
    }
  }
  async function inspectCode(path, imports = false) {
    if (!codeExtensions.has(extname(path))) return
    const content = await readFile(path, 'utf8')
    const display = slash(relative(root, path))
    for (const [label, pattern] of runtimeReferences) {
      if (pattern.test(content)) errors.push(`${display}: references ${label}`)
    }
    if (imports) {
      // Catch a dangling legacy import even if its old source was deleted.
      for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
        if (!match[1].startsWith('.')) continue
        const imported = slash(relative(root, resolve(dirname(path), match[1].split('?')[0])))
        if (retiredSource.some(retired => imported === retired || imported.startsWith(`${retired}/`) || imported === retired.replace(/\.(?:ts|vue)$/, ''))) {
          errors.push(`${display}: imports retired source ${match[1]}`)
        }
      }
    }
  }
  for (const directory of ['src', 'src-tauri/src']) {
    for (const path of await files(root, join(root, directory), errors)) await inspectCode(path, true)
  }
  for (const path of ['src-tauri/build.rs', 'vite.config.ts', 'index.html']) {
    if (await stat(join(root, path))) await inspectCode(join(root, path), true)
  }
  async function inspectAssets(directory) {
    for (const name of retiredAssetRoots) {
      if (await containsArtifact(join(root, directory, name))) errors.push(`${directory}/${name}: retired runtime assets must be removed (including ignored build output)`)
    }
    for (const path of await files(root, join(root, directory), errors)) {
      const asset = slash(relative(join(root, directory), path))
      if (/(?:^|\/)(?:soffice(?:\.|$)|word_engine(?:\.|$)|zeta\.js$)/.test(asset)) errors.push(`${directory}/${asset}: retired runtime artifact`)
      if (asset.endsWith('.wasm') && !editors.some(name => asset === `${name}/${name}_bg.wasm`) && !asset.startsWith('pdfjs/wasm/')) {
        errors.push(`${directory}/${asset}: unexpected WASM engine; only the three current editors and PDF.js are allowed`)
      }
      await inspectCode(path)
    }
  }
  await inspectAssets('public')
  if (dist) {
    if (!(await stat(join(root, 'dist')))?.isDirectory()) errors.push('dist: missing build output; run npm run build first')
    else {
      await inspectAssets('dist')
      for (const name of editors) {
        for (const filename of [`${name}.js`, `${name}_bg.wasm`, 'manifest.json']) {
          const path = `dist/${name}/${filename}`
          if (!(await stat(join(root, path)))?.isFile()) errors.push(`${path}: missing current editor artifact`)
        }
      }
      for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
        const directory = `dist/pdfjs/${name}`
        if (!(await files(root, join(root, directory), errors)).length) errors.push(`${directory}: missing offline PDF.js assets`)
      }
      const assets = await files(root, join(root, 'dist/assets'), errors)
      if (!assets.some(path => /^pdf\.worker(?:\.min)?-[\w-]+\.mjs$/.test(path.split(/[\\/]/).at(-1)))) {
        errors.push('dist/assets: missing bundled PDF.js worker')
      }
      if (!(await stat(join(root, 'dist/index.html')))?.isFile()) errors.push('dist/index.html: missing application entry point')
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter(arg => arg !== '--dist')
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')}. Usage: node scripts/check-editor-boundaries.mjs [--dist]`)
  const result = await checkEditorBoundaries({ dist: process.argv.includes('--dist') })
  if (!result.ok) {
    console.error(`Editor boundary audit failed (${result.errors.length} findings):\n${result.errors.map(message => `- ${message}`).join('\n')}`)
    process.exitCode = 1
  } else console.log(`Editor boundaries verified: retired source, native dependencies and public assets are absent${process.argv.includes('--dist') ? '; distribution contains the three current editors and offline PDF assets' : ''}.`)
}
