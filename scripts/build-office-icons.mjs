// Original Open Office tooling. SVG is an authoring format only: Rust receives static geometry.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EPSILON = 1e-8
const TOLERANCE = 0.04 // SVG units, under 0.1 screen pixel at normal ribbon sizes.
const LIMIT = 8192
const COMMANDS = new Set('MmLlHhVvCcQqZz')
const PAINT = { none: 'None', currentColor: 'Ink', '#5b73e8': 'Accent' }
const fail = message => { throw new Error(`Office SVG: ${message}`) }
const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPSILON
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const numeric = value => {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) fail(`invalid number ${value}`)
  const number = Number(value)
  if (!Number.isFinite(number) || Math.abs(number) > 1024) fail(`number out of range: ${value}`)
  return number
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1], square = dx * dx + dy * dy
  const t = square ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / square)) : 0
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy)
}

/** Parse the deliberately small, bounded SVG path subset; preserve subpath boundaries. */
export function parsePath(data) {
  if (typeof data !== 'string' || !data.trim() || data.length > 65536) fail('missing or oversized path')
  const tokens = []
  const token = /[a-zA-Z]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/gy
  let offset = 0
  while (offset < data.length) {
    const separator = /^[\s,]+/.exec(data.slice(offset))
    if (separator) offset += separator[0].length
    if (offset === data.length) break
    token.lastIndex = offset
    const match = token.exec(data)
    if (!match) fail(`invalid path syntax at ${offset}`)
    if (/^[a-zA-Z]$/.test(match[0]) && !COMMANDS.has(match[0])) fail(`unsupported path command ${match[0]}`)
    tokens.push(match[0]); offset = token.lastIndex
    if (tokens.length > LIMIT) fail('too many path tokens')
  }
  let i = 0, command = '', current = [0, 0], start = [0, 0], subpath
  const subpaths = []
  const read = () => {
    const value = tokens[i++]
    if (value === undefined || COMMANDS.has(value)) fail('incomplete path command')
    return numeric(value)
  }
  const append = point => {
    if (!subpath) fail('path must start with M')
    // Control points may extend beyond the viewport; actual drawn points must fit the icon.
    if (point.some(value => !Number.isFinite(value) || value < -0.01 || value > 24.01)) fail('path extends outside the 24×24 viewBox')
    if (!subpath.points.length || !same(subpath.points.at(-1), point)) subpath.points.push(point)
    if (subpath.points.length > LIMIT) fail('flattened path exceeds point limit')
    current = point
  }
  const curve = (points, depth = 0) => {
    if (points.slice(1, -1).every(point => distanceToSegment(point, points[0], points.at(-1)) <= TOLERANCE)) {
      append(points.at(-1)); return
    }
    if (depth >= 14) fail('curve requires excessive subdivision')
    const levels = [points]
    while (levels.at(-1).length > 1) {
      const previous = levels.at(-1)
      levels.push(previous.slice(1).map((point, index) => midpoint(previous[index], point)))
    }
    curve(levels.map(level => level[0]), depth + 1)
    curve(levels.map(level => level.at(-1)).reverse(), depth + 1)
  }
  while (i < tokens.length) {
    if (COMMANDS.has(tokens[i])) command = tokens[i++]
    if (!command) fail('path must start with a command')
    const upper = command.toUpperCase(), relative = command !== upper
    const origin = [...current]
    const point = () => [read() + (relative ? origin[0] : 0), read() + (relative ? origin[1] : 0)]
    if (upper === 'M') {
      start = point(); subpath = { points: [], closed: false }; subpaths.push(subpath)
      if (subpaths.length > 128) fail('too many subpaths')
      append(start); command = relative ? 'l' : 'L'
    } else if (upper === 'Z') {
      if (!subpath || subpath.closed) fail('unexpected close path')
      if (subpath.points.length > 1 && same(subpath.points.at(-1), start)) subpath.points.pop()
      subpath.closed = true; current = [...start]; command = ''; subpath = undefined
    } else {
      if (!subpath) fail('draw command requires an open subpath starting with M')
      if (upper === 'L') append(point())
      else if (upper === 'H') append([read() + (relative ? origin[0] : 0), origin[1]])
      else if (upper === 'V') append([origin[0], read() + (relative ? origin[1] : 0)])
      else if (upper === 'C') curve([origin, point(), point(), point()])
      else if (upper === 'Q') curve([origin, point(), point()])
    }
  }
  if (!subpaths.length || subpaths.some(path => path.points.length < 2)) fail('path has an empty or single-point subpath')
  return subpaths
}

function onSegment(point, start, end) {
  return Math.abs(cross(start, end, point)) < EPSILON && point[0] >= Math.min(start[0], end[0]) - EPSILON
    && point[0] <= Math.max(start[0], end[0]) + EPSILON && point[1] >= Math.min(start[1], end[1]) - EPSILON
    && point[1] <= Math.max(start[1], end[1]) + EPSILON
}
function intersects(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b)
  return (abC * abD < -EPSILON && cdA * cdB < -EPSILON)
    || onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d)
}
const area = points => points.reduce((sum, a, i) => {
  const b = points[(i + 1) % points.length]
  return sum + a[0] * b[1] - b[0] * a[1]
}, 0) / 2

/** Ear clipping is offline only; reject holes, self intersections and degenerate geometry. */
export function triangulate(points) {
  if (points.length < 3 || points.length > 2048 || Math.abs(area(points)) < EPSILON) fail('degenerate or oversized fill polygon')
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue
      if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) fail('self-intersecting fill polygon')
    }
  }
  const remaining = points.map((_, index) => index)
  // Collinear points do not create an ear. They remain available for the independent stroke.
  for (let changed = true; changed && remaining.length > 3;) {
    changed = false
    for (let i = 0; i < remaining.length; i++) {
      const previous = points[remaining[(i + remaining.length - 1) % remaining.length]], current = points[remaining[i]], next = points[remaining[(i + 1) % remaining.length]]
      if (onSegment(current, previous, next)) { remaining.splice(i, 1); changed = true; break }
    }
  }
  if (area(remaining.map(index => points[index])) < 0) remaining.reverse()
  const triangles = []
  while (remaining.length > 3) {
    let clipped = false
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length], b = remaining[i], c = remaining[(i + 1) % remaining.length]
      if (cross(points[a], points[b], points[c]) <= EPSILON) continue
      if (remaining.some(index => index !== a && index !== b && index !== c && cross(points[a], points[b], points[index]) >= -EPSILON
        && cross(points[b], points[c], points[index]) >= -EPSILON && cross(points[c], points[a], points[index]) >= -EPSILON)) continue
      triangles.push(a, b, c); remaining.splice(i, 1); clipped = true; break
    }
    if (!clipped) fail('fill polygon could not be triangulated')
  }
  triangles.push(...remaining)
  return triangles
}

const COMMON = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity']
function attributes(source, allowed) {
  const result = {}
  const attribute = /\s+([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gy
  let offset = 0
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break
    attribute.lastIndex = offset
    const match = attribute.exec(source)
    if (!match) fail('malformed XML attribute')
    const [, key, double, single] = match
    if (!allowed.includes(key)) fail(`unsupported attribute ${key}`)
    if (Object.hasOwn(result, key)) fail(`duplicate attribute ${key}`)
    result[key] = double ?? single; offset = attribute.lastIndex
  }
  return result
}
const opacity = value => {
  const result = value === undefined ? 1 : numeric(value)
  if (result < 0 || result > 1) fail('opacity must be between 0 and 1')
  return result
}
function style(attrs, inherited = {}) {
  // SVG's default stroke is none. Its default black fill is outside our themed
  // palette, so require an explicit fill on each path or its svg ancestor.
  const result = { stroke: 'none', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...inherited, ...attrs }
  if ((result.fill !== undefined && !Object.hasOwn(PAINT, result.fill)) || !Object.hasOwn(PAINT, result.stroke)) fail('only none, currentColor and #5b73e8 paints are supported')
  if (numeric(result['stroke-width']) !== 1.65 || result['stroke-linecap'] !== 'round' || result['stroke-linejoin'] !== 'round') fail('icons require 1.65 round strokes and joins')
  return result
}

export function compileSvg(source, label = 'icon.svg') {
  try {
    if (typeof source !== 'string' || source.length > 131072 || /[&\u0000]/.test(source)) fail('entities and oversized SVG are not supported')
    source = source.replace(/<!--[^]*?-->/g, '').trim()
    const root = /^<svg\b([^<>]*)>([^]*)<\/svg>$/.exec(source)
    if (!root) fail('expected a single svg root containing only paths')
    const attrs = attributes(root[1], [...COMMON, 'xmlns', 'viewBox', 'width', 'height'])
    if (attrs.xmlns !== undefined && attrs.xmlns !== 'http://www.w3.org/2000/svg') fail('invalid SVG namespace')
    if (attrs.viewBox?.trim().split(/[\s,]+/).join(' ') !== '0 0 24 24') fail('viewBox must be 0 0 24 24')
    for (const size of ['width', 'height']) if (attrs[size] !== undefined && numeric(attrs[size]) !== 24) fail(`${size} must be 24`)
    const inherited = style(attrs), rootOpacity = opacity(attrs.opacity)
    const output = [], pattern = /\s*<path\b([^<>]*?)\s*\/>/gy
    let offset = 0, count = 0
    while (root[2].slice(offset).trim()) {
      pattern.lastIndex = offset
      const match = pattern.exec(root[2])
      if (!match) fail('only self-closing path elements are supported (no groups, transforms or text)')
      offset = pattern.lastIndex
      if (++count > 128) fail('too many path elements')
      const pathAttrs = attributes(match[1], [...COMMON, 'd'])
      const pathStyle = style(pathAttrs, inherited)
      if (pathStyle.fill === undefined) fail('fill must be explicit on the path or its svg ancestor; implicit black is outside the themed palette')
      const paths = parsePath(pathAttrs.d)
      const filled = pathStyle.fill !== 'none'
      // Multiple disjoint fills are easy to author as separate path elements. Refuse
      // compound fills rather than silently erasing holes or changing winding rules.
      if (filled && paths.length !== 1) fail('filled paths require one simple closed subpath; split disjoint fills into separate paths')
      for (const path of paths) {
        // SVG implicitly closes an open subpath for fill, but not for stroke.
        // Triangulation closes the polygon while `closed` preserves stroke semantics.
        const alpha = rootOpacity * opacity(pathAttrs.opacity)
        output.push({ ...path, triangles: filled ? triangulate(path.points) : [],
          fill: PAINT[pathStyle.fill], stroke: PAINT[pathStyle.stroke],
          fillOpacity: alpha * opacity(pathStyle['fill-opacity']), strokeOpacity: alpha * opacity(pathStyle['stroke-opacity']) })
      }
    }
    if (!output.length || output.every(path => path.fill === 'None' && path.stroke === 'None')) fail('icon contains no visible geometry')
    return output
  } catch (error) { throw new Error(`${label}: ${error.message}`, { cause: error }) }
}

/** A build-time contract only: equivalent toolbar actions share identical source art. */
export async function verifySharedIcons(root = ROOT) {
  const aliases = JSON.parse(await readFile(join(root, 'src/icons/shared.json'), 'utf8'))
  if (!aliases || Array.isArray(aliases) || typeof aliases !== 'object' || Object.keys(aliases).length > 1024) fail('shared.json must be a bounded object mapping icon names')
  const safe = name => typeof name === 'string' && /^(word|sheet|deck|shell)\/[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)
  for (const [target, source] of Object.entries(aliases)) {
    if (!safe(target) || !safe(source) || target === source) fail(`invalid shared icon mapping ${target}`)
    const targetBytes = await readFile(join(root, 'src/icons/svg', `${target}.svg`))
    const sourceBytes = await readFile(join(root, 'src/icons/svg', `${source}.svg`))
    if (!targetBytes.equals(sourceBytes)) fail(`shared icon ${target} differs from canonical ${source}; synchronize the original SVG files`)
  }
}

const rustNumber = number => {
  const text = (Math.abs(number) < 0.0000005 ? 0 : number).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')
  return text
}
function rustSource(family, icons) {
  const lines = [
    '// Generated by scripts/build-office-icons.mjs; do not edit by hand.',
    `// Source: src/icons/svg/${family}/*.svg — original Open Office interface artwork (MIT).`,
    '// Curves are flattened offline to <= 0.04 SVG units; simple fills are triangulated offline.',
    'use crate::office_svg::{IconPath, Paint};', '',
    '#[cfg(test)]', 'pub const NAMES: &[&str] = &[', ...icons.map(icon => `    ${JSON.stringify(icon.name)},`), '];', '',
    '#[rustfmt::skip]', "pub fn lookup(name: &str) -> Option<&'static [IconPath]> {", '    match name {',
  ]
  for (const icon of icons) {
    lines.push(`        ${JSON.stringify(icon.name)} => Some(&[`)
    for (const path of icon.paths) {
      lines.push('            IconPath {', `                points: &[${path.points.map(point => `[${point.map(rustNumber).join(', ')}]`).join(', ')}],`,
        `                triangles: &[${path.triangles.join(', ')}],`, `                closed: ${path.closed}, fill: Paint::${path.fill}, stroke: Paint::${path.stroke},`,
        `                fill_opacity: ${rustNumber(path.fillOpacity)}, stroke_opacity: ${rustNumber(path.strokeOpacity)},`, '            },')
    }
    lines.push('        ]),')
  }
  lines.push('        _ => None,', '    }', '}', '')
  return lines.join('\n')
}

/** Pure --check: generate in memory, compare exact bytes, never write or launch Cargo. */
export async function buildOfficeIcons({ root = ROOT, families = ['word', 'sheet', 'deck'], check = false } = {}) {
  await verifySharedIcons(root)
  const products = []
  for (const family of families) {
    const vendors = { word: 'wordcraft', sheet: 'gridcraft', deck: 'deckcraft' }
    if (!Object.hasOwn(vendors, family)) fail(`unknown family ${family}`)
    const relative = `src/icons/svg/${family}`, directory = join(root, relative)
    const names = JSON.parse(await readFile(join(directory, 'names.json'), 'utf8'))
    if (!Array.isArray(names) || !names.length || names.length > 1024 || names.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name))
      || new Set(names).size !== names.length) fail(`${relative}/names.json must contain unique safe icon names`)
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.some(entry => !entry.isFile() || (entry.name !== 'names.json' && !entry.name.endsWith('.svg')))) fail(`${relative} contains unexpected files or symlinks`)
    const actual = entries.filter(entry => entry.name.endsWith('.svg')).map(entry => entry.name.slice(0, -4)).sort()
    const expected = [...names].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${family} coverage differs: missing [${expected.filter(name => !actual.includes(name))}], unexpected [${actual.filter(name => !expected.includes(name))}]`)
    const icons = []
    for (const name of expected) icons.push({ name, paths: compileSvg(await readFile(join(directory, `${name}.svg`), 'utf8'), `${relative}/${name}.svg`) })
    const output = join(root, `vendor/${vendors[family]}/crates/ui-egui/src/office_icons.rs`)
    const content = rustSource(family, icons)
    let existing
    try { existing = await readFile(output, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing !== content && check) fail(`${family} generated geometry is missing or stale; run node scripts/build-office-icons.mjs`)
    products.push({ family, output, content, changed: existing !== content, count: icons.length })
  }
  // Validate every requested family first; an invalid second family cannot leave a partial update.
  if (!check) for (const product of products) if (product.changed) {
    await mkdir(dirname(product.output), { recursive: true })
    await writeFile(product.output, product.content)
  }
  return products.map(({ content, ...product }) => product)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let check = false, families = ['word', 'sheet', 'deck']
  while (args.length) {
    const option = args.shift()
    if (option === '--check') check = true
    else if (option === '--family') families = [args.shift()]
    else fail(`unknown option ${option}`)
  }
  for (const result of await buildOfficeIcons({ check, families })) console.log(`${result.family}: ${result.count} original SVG icons ${check ? 'verified' : result.changed ? 'compiled' : 'unchanged'}.`)
}
