// Render the requested catalogue artwork into the web and desktop icon formats.
// The source image is kept intact; an SVG viewport selects the green ox tile.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'assets/branding/open-family-source.png'))
const expectedHash = '90e609e33185119f1418327f11c5afc0431a3c6f95f187d31a261615728728f0'
if (createHash('sha256').update(source).digest('hex') !== expectedHash) {
  throw new Error('Brand source has changed; verify the artwork and tile coordinates before regenerating icons.')
}

const temporary = await mkdtemp(join(tmpdir(), 'open-office-brand-'))
try {
  const viewport = join(temporary, 'brand.svg')
  // Keep the original aspect ratio and engraving. Clip only the surrounding dark
  // catalogue background, with a small transparent margin around the tile.
  await writeFile(viewport, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="132 141 410 410">
  <defs><clipPath id="tile"><rect x="142" y="151" width="390" height="396" rx="74"/></clipPath></defs>
  <image width="1918" height="820" xlink:href="data:image/png;base64,${source.toString('base64')}" clip-path="url(#tile)"/>
</svg>\n`)
  const output = join(temporary, 'icons')
  execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', viewport, '--output', output], { cwd: root, stdio: 'pipe' })
  const native = join(root, 'src-tauri/icons')
  await mkdir(native, { recursive: true })
  for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico']) {
    await copyFile(join(output, name), join(native, name))
  }
  await copyFile(join(output, '128x128@2x.png'), join(root, 'public/brand-mark.png'))
  await copyFile(join(output, '32x32.png'), join(root, 'public/favicon.png'))
  console.log('Open Office green ox icons generated for the app, browser, macOS and Windows.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
