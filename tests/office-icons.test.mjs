import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildOfficeIcons, compileSvg, parsePath, triangulate, verifySharedIcons, verifyShellIconAliases } from '../scripts/build-office-icons.mjs'

const svg = paths => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
const signedArea = points => points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a[0] * b[1] - a[1] * b[0] }, 0) / 2

test('SVG relative and repeated commands preserve separate open and closed subpaths', () => {
  assert.deepEqual(parsePath('m 2,3 4,0 h 2 v 5 l -6,0 z M 10 10 L 12 12 14 10'), [
    { points: [[2, 3], [6, 3], [8, 3], [8, 8], [2, 8]], closed: true },
    { points: [[10, 10], [12, 12], [14, 10]], closed: false },
  ])
  assert.deepEqual(parsePath('M2 2L4 2L4 4L2 2Z')[0].points, [[2, 2], [4, 2], [4, 4]])
})

test('Cubic and quadratic curves are flattened accurately without losing relative endpoints', () => {
  const [path] = parsePath('M2 12c0 -10 20 -10 20 0q-10 10 -20 0')
  assert.ok(path.points.length > 25 && path.points.length < 256)
  assert.deepEqual(path.points.at(-1), [2, 12])
  assert.ok(path.points.some(([x, y]) => Math.abs(x - 12) < 0.001 && Math.abs(y - 4.5) < 0.001))
  assert.ok(path.points.some(([x, y]) => Math.abs(x - 12) < 0.001 && Math.abs(y - 17) < 0.001))
  const distance = (point, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], square = dx * dx + dy * dy
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / square))
    return Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t)
  }
  for (let i = 0; i <= 100; i++) {
    const t = i / 100, s = 1 - t
    const point = [2 * s ** 3 + 6 * s ** 2 * t + 66 * s * t ** 2 + 22 * t ** 3,
      12 * s ** 3 + 6 * s ** 2 * t + 6 * s * t ** 2 + 12 * t ** 3]
    assert.ok(Math.min(...path.points.slice(1).map((b, index) => distance(point, path.points[index], b))) <= 0.041)
  }
})

test('Non-convex fills are triangulated in both winding directions with the exact polygon area', () => {
  const polygon = [[2, 2], [16, 2], [16, 8], [8, 8], [8, 18], [2, 18]]
  for (const points of [polygon, [...polygon].reverse()]) {
    const triangles = triangulate(points)
    assert.equal(triangles.length, 12)
    let area = 0
    for (let i = 0; i < triangles.length; i += 3) {
      const triangle = triangles.slice(i, i + 3).map(index => points[index])
      assert.ok(signedArea(triangle) > 0)
      area += signedArea(triangle)
    }
    assert.equal(area, Math.abs(signedArea(points)))
  }
  assert.throws(() => triangulate([[2, 2], [20, 20], [2, 20], [18, 2]]), /self-intersecting/)
})

test('Theme paint and root/path fill/stroke opacity retain their SVG meaning', () => {
  const [path] = compileSvg(svg('<path fill="#5b73e8" fill-opacity=".14" stroke-opacity=".6" opacity=".5" d="M3 3H20V20H3Z"/>').replace('<svg ', '<svg opacity=".8" '))
  assert.equal(path.fill, 'Accent'); assert.equal(path.stroke, 'Ink')
  assert.ok(Math.abs(path.fillOpacity - 0.056) < 1e-8)
  assert.equal(path.strokeOpacity, 0.24)
  assert.equal(path.triangles.length, 6)
  const [open] = compileSvg(svg('<path fill="#5b73e8" d="M3 3H20V20"/>'))
  assert.equal(open.closed, false, 'implicit fill closure must not add a stroke across the open edge')
  assert.equal(open.triangles.length, 3)
  const [fillOnly] = compileSvg('<svg viewBox="0 0 24 24"><path fill="#5b73e8" opacity=".14" d="M3 3H20V20Z"/></svg>')
  assert.equal(fillOnly.stroke, 'None', 'omitted SVG stroke must not invent an outline on a filled shape')
  assert.equal(fillOnly.fill, 'Accent')
  assert.equal(fillOnly.fillOpacity, 0.14)
  assert.throws(() => compileSvg('<svg viewBox="0 0 24 24"><path d="M3 3H20V20Z"/></svg>'), /fill must be explicit/)
})

test('Unsupported SVG constructs and ambiguous fill geometry fail explicitly', () => {
  const invalid = [
    '<path d="M2 2A4 4 0 0 1 8 8"/>', '<path d="M2 2S5 5 8 8"/>', '<text>icon</text>',
    '<g><path d="M2 2L8 8"/></g>', '<path transform="rotate(4)" d="M2 2L8 8"/>',
    '<path fill="url(#external)" d="M2 2L8 8"/>', '<path stroke="red" d="M2 2L8 8"/>',
    '<path d="M2 2L8 8" stroke-width="2"/>', '<path d="M2 2L8 8" opacity="2"/>',
    '<path d="M2 2L25 8"/>', '<path d="M2 2LNaN 8"/>', '<path d="M2 2L8"/>',
    '<path d="M2 2L8 8" d="M4 4L9 9"/>', '<path fill="currentColor" d="M2 2L8 8"/>',
    '<path fill="currentColor" d="M2 2H20V20H2Z M6 6H16V16H6Z"/>', '<path d="M2 2L8 8&amp;"/>',
    '<image href="https://example.test/icon.svg"/>', '<path d="M2 2"/>',
  ]
  for (const source of invalid) assert.throws(() => compileSvg(svg(source)), /Office SVG/)
  assert.throws(() => compileSvg(svg('<path d="M2 2L8 8"/>').replace('0 0 24 24', '0 0 48 48')), /viewBox/)
  assert.throws(() => compileSvg(`<!DOCTYPE svg>${svg('<path d="M2 2L8 8"/>')}`), /svg root/)
})

test('Complete name coverage and --check reject drift without writing or creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-icons-'))
  const directory = join(root, 'src/icons/svg/word')
  const generated = join(root, 'vendor/office-word/crates/ui-egui/src/office_icons.rs')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, 'src/icons/shared.json'), '{}')
    await writeFile(join(directory, 'names.json'), '["test"]')
    await writeFile(join(directory, 'test.svg'), svg('<path d="M2 2L8 8"/>'))
    await assert.rejects(buildOfficeIcons({ root, families: ['word'], check: true }), /missing or stale/)
    await assert.rejects(stat(generated), { code: 'ENOENT' })
    const [result] = await buildOfficeIcons({ root, families: ['word'] })
    assert.equal(result.changed, true); assert.equal(result.count, 1)
    const before = await readFile(generated, 'utf8'), timestamp = (await stat(generated)).mtimeMs
    assert.ok(before.includes('src/icons/svg/word/*.svg') && !before.includes(tmpdir()))
    assert.equal((await buildOfficeIcons({ root, families: ['word'], check: true }))[0].changed, false)
    assert.equal((await stat(generated)).mtimeMs, timestamp)
    await writeFile(join(directory, 'test.svg'), svg('<path d="M2 2L9 9"/>'))
    await assert.rejects(buildOfficeIcons({ root, families: ['word'], check: true }), /missing or stale/)
    assert.equal(await readFile(generated, 'utf8'), before)
    await writeFile(join(directory, 'names.json'), '["test","forgotten"]')
    await assert.rejects(buildOfficeIcons({ root, families: ['word'] }), /missing \[forgotten\]/)
    assert.equal(await readFile(generated, 'utf8'), before)
    await writeFile(join(directory, 'names.json'), '["test","test"]')
    await assert.rejects(buildOfficeIcons({ root, families: ['word'] }), /unique safe icon names/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Shared icon contracts reject cross-workspace drift and unsafe references without repairing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-shared-icons-'))
  try {
    for (const family of ['word', 'sheet', 'shell']) await mkdir(join(root, `src/icons/svg/${family}`), { recursive: true })
    const source = svg('<path d="M3 3H20V20"/>')
    for (const family of ['word', 'sheet', 'shell']) await writeFile(join(root, `src/icons/svg/${family}/save.svg`), source)
    const manifest = join(root, 'src/icons/shared.json')
    await writeFile(manifest, JSON.stringify({ 'sheet/save': 'word/save', 'word/save': 'shell/save' }))
    await verifySharedIcons(root)
    const target = join(root, 'src/icons/svg/sheet/save.svg')
    await writeFile(target, `${source}\n`)
    await assert.rejects(verifySharedIcons(root), /differs from canonical word\/save/)
    assert.equal(await readFile(target, 'utf8'), `${source}\n`)
    await writeFile(manifest, JSON.stringify({ 'word/save': '../../secret' }))
    await assert.rejects(verifySharedIcons(root), /invalid shared icon mapping/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Shell aliases import canonical editor SVGs and reject shadowing or indirect paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-shell-icon-aliases-'))
  try {
    const directory = join(root, 'src/icons/svg/word'), shell = join(root, 'src/icons/svg/shell')
    await mkdir(directory, { recursive: true }); await mkdir(shell, { recursive: true })
    await writeFile(join(root, 'src/icons/shared.json'), '{}')
    await writeFile(join(directory, 'names.json'), '["bold"]')
    await writeFile(join(directory, 'bold.svg'), svg('<path d="M6 4V20H13Q19 20 19 16Q19 12 13 12H6"/>'))
    const manifest = join(root, 'src/icons/shell-aliases.json')
    await writeFile(manifest, JSON.stringify({ bold: 'word/bold' }))
    await buildOfficeIcons({ root, families: ['word'] })
    const generated = join(root, 'src/icons/shell-aliases.ts')
    const source = await readFile(generated, 'utf8')
    assert.match(source, /import icon0 from '\.\/svg\/word\/bold\.svg\?raw'/)
    assert.match(source, /"bold": icon0/)
    await buildOfficeIcons({ root, families: ['word'], check: true })
    await writeFile(generated, `${source}\n`)
    await assert.rejects(buildOfficeIcons({ root, families: ['word'], check: true }), /shell icon aliases are missing or stale/)
    await writeFile(join(shell, 'bold.svg'), svg('<path d="M6 4V20"/>'))
    await assert.rejects(verifyShellIconAliases(root), /shadows an authored SVG/)
    await writeFile(manifest, JSON.stringify({ bold: 'shell/italic' }))
    await assert.rejects(verifyShellIconAliases(root), /invalid shell icon alias/)
    await writeFile(manifest, JSON.stringify({ bold: '../word/bold' }))
    await assert.rejects(verifyShellIconAliases(root), /invalid shell icon alias/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Presentation and PDF controls have complete original SVG coverage alongside existing editor families', async () => {
  const root = new URL('../', import.meta.url)
  const names = JSON.parse(await readFile(new URL('src/icons/svg/deck/names.json', root), 'utf8'))
  const adapter = await readFile(new URL('vendor/office-presentation/crates/ui-egui/src/icons.rs', root), 'utf8')
  const declared = [...adapter.matchAll(/^\s+\w+ => "([^"]+)",/gm)].map(match => match[1])
  assert.deepEqual([...names].sort(), declared.sort(), 'every typed toolbar icon must use an authored SVG')
  const products = await buildOfficeIcons({ check: true })
  assert.deepEqual(products.map(product => product.family), ['word', 'sheet', 'deck', 'pdf'])
  assert.equal(products.find(product => product.family === 'deck').count, names.length)
  const pdfNames = JSON.parse(await readFile(new URL('src/icons/svg/pdf/names.json', root), 'utf8'))
  const pdfCatalog = await readFile(new URL('vendor/office-pdf/crates/engine/src/catalog.rs', root), 'utf8')
  const pdfDeclared = [...pdfCatalog.matchAll(/\bicon:\s*"([^"]+)"/g)].map(match => match[1])
  assert.ok(pdfDeclared.length > 20, 'PDF tool catalog must declare its icons')
  for (const name of pdfDeclared) assert.ok(pdfNames.includes(name), `PDF tool icon ${name} needs an authored SVG`)
  assert.equal(products.find(product => product.family === 'pdf').count, pdfNames.length)
  assert.ok(products.every(product => !product.changed), 'checking presentation icons must preserve all generated editor geometry')
})
