import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { slideSvg } from '../src/presentation/core/render.ts'
import { buildSlideScene, estimatedTextWidth, safeImageDataUrl, textLayoutFor, PT_TO_MM } from '../src/presentation/core/scene.ts'
import { assertPdfPngDimensions, exportPresentationPdf } from '../src/presentation/core/pdf.ts'

const style = { fontName: 'Noto Sans CJK SC', fontSize: 18, bold: false, italic: false, underline: false, color: '#17253b', align: 'left' }
const shape = (extra = {}) => ({ id: 's1', name: '标题', type: 'text', x: 10, y: 10, width: 150, height: 40, rotation: 0, text: '独立演示真实编辑 中文 QA', fillColor: null, lineColor: null, lineWidth: .3, zIndex: 0, textStyle: { ...style }, capabilities: { text: true, fill: true, line: true, geometry: true }, ...extra })
const slide = (objects, extra = {}) => ({ id: 'slide1', name: '第一页', hidden: false, layout: 20, background: '#ffffff', notes: '', objects, transition: { type: 'none' }, media: [], warnings: [], ...extra })
const model = slides => ({ width: 254, height: 142.875, slides, warnings: [] })
const flatten = nodes => nodes.flatMap(node => node.kind === 'group' ? flatten(node.children) : [node])
const fixedMetrics = (_text, _style, size) => ({ ascent: size * .88, descent: size * .12 })

test('SVG escapes text, font, IDs and labels and refuses executable paint, XML and image URLs', () => {
  const malicious = '" onload="alert(1)<script>evil()</script>'
  const page = slide([
    shape({ id: malicious, text: malicious, textStyle: { ...style, fontName: malicious, color: 'url(https://evil.invalid)' }, fillColor: 'url(https://evil.invalid)', sourceXml: '<script>source()</script>' }),
    shape({ id: 'image', type: 'image', image: { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', mimeType: 'image/svg+xml' } }),
  ], { name: malicious, background: 'url(https://evil.invalid)' })
  const svg = slideSvg(model([page]), page)
  assert.doesNotMatch(svg, /<script|<foreignObject|<image|url\(|https:\/\/evil/)
  assert.doesNotMatch(svg, /\sonload="/)
  assert.match(svg, /&quot; onload=&quot;alert\(1\)&lt;script&gt;/)
  assert.match(svg, /不支持的图片格式/)
  assert.equal(safeImageDataUrl('https://evil.invalid/image.png'), null)
  assert.equal(safeImageDataUrl('data:image/png;base64,abcd" onload="evil'), null)
})

test('SVG includes editable object IDs, group rotation, inherited decorations and stable clipping without global IDs', () => {
  const page = slide([shape({ id: 'group', type: 'group', rotation: 30, opacity: .5, children: [shape({ id: 'child', x: 40, y: 35, textStyle: { ...style, bold: true, italic: true, underline: true } })] })], { inheritedObjects: [shape({ id: 'master', type: 'ellipse', fillColor: '#eee' })] })
  const svg = slideSvg(model([page]), page, { width: 800, height: 450 })
  assert.match(svg, /width="800" height="450" viewBox="0 0 254 142.875"/)
  assert.match(svg, /data-object-id="master" data-inherited="true"/)
  assert.match(svg, /data-object-id="group" transform="rotate\(30 85 30\)" opacity="0.5"/)
  assert.match(svg, /data-object-id="child"/)
  assert.match(svg, /font-weight="700" font-style="italic" text-decoration="underline"/)
  assert.doesNotMatch(svg, /clip-path="url| id="/)
  assert.doesNotMatch(slideSvg(model([page]), page, { omitObjectIds: ['child'] }), /data-object-id="child"/)
})

test('shared layout wraps CJK, preserves explicit newlines and aligns centered text', () => {
  const page = slide([shape({ text: '中文换行测试\n第二行', width: 25, height: 60, textStyle: { ...style, align: 'center' } })])
  const nodes = flatten(buildSlideScene(model([page]), page, { measureText: estimatedTextWidth })).filter(node => node.kind === 'text')
  assert.equal(nodes.map(node => node.text).join(''), '中文换行测试第二行')
  assert.ok(nodes.length >= 3)
  for (const node of nodes) assert.ok(Math.abs(node.x + node.width / 2 - 22.5) < .001)
  for (let index = 1; index < nodes.length; index++) assert.ok(nodes[index].y > nodes[index - 1].y)
})

test('body vertical anchors and asymmetric or zero insets place text inside the content rectangle', () => {
  const size = 20 * PT_TO_MM, lineHeight = size * 1.25
  const layouts = ['top', 'middle', 'bottom'].map(verticalAlign => {
    const object = shape({ x: 10, y: 20, width: 80, height: 60, text: '第一行\n第二行', textStyle: { ...style, fontSize: 20, align: 'right' }, textLayout: { verticalAlign, insets: { left: 5, right: 7, top: 3, bottom: 9 } } })
    const page = slide([object]), nodes = flatten(buildSlideScene(model([page]), page, { measureText: estimatedTextWidth, measureTextMetrics: fixedMetrics })).filter(node => node.kind === 'text')
    const layout = textLayoutFor(object, { measureText: estimatedTextWidth, measureTextMetrics: fixedMetrics })
    const extra = 48 - (size + lineHeight), top = 23 + (verticalAlign === 'middle' ? extra / 2 : verticalAlign === 'bottom' ? extra : 0)
    assert.equal(nodes.length, 2)
    assert.ok(Math.abs(nodes[0].y - (top + size * .88)) < 1e-8)
    assert.ok(Math.abs(nodes[1].y - nodes[0].y - lineHeight) < 1e-8)
    for (const node of nodes) assert.ok(Math.abs(node.x + node.width - 83) < 1e-8)
    assert.deepEqual(layout.inner, { x: 15, y: 23, width: 68, height: 48 })
    assert.ok(Math.abs(layout.top + object.y - top) < 1e-8)
    assert.ok(Math.abs(layout.firstBaseline + object.y - nodes[0].y) < 1e-8, 'Textarea overlay and vector scene share the baseline')
    return nodes[0].y
  })
  assert.ok(layouts[0] < layouts[1] && layouts[1] < layouts[2])
  const zero = shape({ text: '零边距', textLayout: { insets: { left: 0, right: 0, top: 0, bottom: 0 } } }), page = slide([zero])
  const first = flatten(buildSlideScene(model([page]), page, { measureTextMetrics: fixedMetrics })).find(node => node.kind === 'text')
  assert.equal(first.x, zero.x)
  assert.ok(Math.abs(first.y - zero.y - style.fontSize * PT_TO_MM * .88) < 1e-8)
})

test('no-wrap keeps explicit line breaks, clips overflow and composes body and object rotations', () => {
  const object = shape({ x: 20, y: 30, width: 30, height: 50, rotation: 30, text: '这是一段不会自动换行的中文\n第二行', textLayout: { wrap: false, rotation: -90, insets: { left: 2, right: 4, top: 3, bottom: 5 } } })
  const page = slide([object]), scene = buildSlideScene(model([page]), page, { measureText: estimatedTextWidth })
  const group = scene.find(node => node.kind === 'group' && node.id === object.id), textGroup = group.children[0]
  assert.equal(group.rotation, 30)
  assert.equal(textGroup.rotation, -90)
  assert.deepEqual(textGroup.clip, { x: 22, y: 33, width: 24, height: 42 })
  const nodes = flatten(scene).filter(node => node.kind === 'text')
  assert.deepEqual(nodes.map(node => node.text), object.text.split('\n'))
  assert.ok(nodes[0].width > textGroup.clip.width)
  assert.equal(textLayoutFor(object, { measureText: estimatedTextWidth }).lineCount, 2)
  assert.ok(textLayoutFor({ ...object, textLayout: { ...object.textLayout, wrap: true } }, { measureText: estimatedTextWidth }).lineCount > 2)
  const svg = slideSvg(model([page]), page)
  assert.match(svg, /transform="rotate\(30 35 55\)"/)
  assert.match(svg, /transform="rotate\(-90 35 55\)"/)
  assert.match(svg, /<svg x="22" y="33" width="24" height="42"[^>]*overflow="hidden"/)
  const empty = { ...object, textLayout: { insets: { left: 40, right: 40, top: 0, bottom: 0 } } }, emptyPage = slide([empty])
  assert.equal(flatten(buildSlideScene(model([emptyPage]), emptyPage)).filter(node => node.kind === 'text').length, 0, 'No drawable content rectangle must not leak text')
})

test('tables and all supported chart types produce finite vector geometry including negative values', () => {
  const objects = [shape({ id: 'table', type: 'table', table: { cells: [['名称', '金额'], ['收入', '120']] } }), ...['column', 'bar', 'line', 'pie'].map((type, index) => shape({ id: type, type: 'chart', y: 20 * index, height: 60, chart: { type, categories: ['一月', '二月'], series: ['收入', '成本'], values: [[120, 30], [-50, 10]], title: '月度金额' } }))]
  const page = slide(objects), svg = slideSvg(model([page]), page)
  assert.doesNotMatch(svg, /NaN|Infinity|<image/)
  for (const type of ['column', 'bar', 'line', 'pie']) assert.ok(svg.includes(`data-object-id="${type}"`))
  assert.match(svg, /名称/)
  assert.match(svg, /月度金额/)
  assert.ok((svg.match(/<path/g) ?? []).length > 20)
})

test('protected unsupported chart/table placeholders explain preview limitations without claiming data is empty', () => {
  for (const type of ['chart', 'table']) {
    const protectedPage = slide([shape({ type, locked: true, height: 55 })])
    const svg = slideSvg(model([protectedPage]), protectedPage)
    assert.match(svg, type === 'chart' ? /暂不支持此类图表预览/ : /暂不支持此类表格预览/)
    assert.match(svg, /原始数据保留/)
    assert.doesNotMatch(svg, /图表无数据|空表格/)
    const emptyPage = slide([shape({ type, height: 55 })])
    assert.match(slideSvg(model([emptyPage]), emptyPage), type === 'chart' ? /图表无数据/ : /空表格/)
  }
})

test('chart geometry preserves ratios above ten million and at finite number boundaries', () => {
  const points = (type, values) => {
    const page = slide([shape({ type: 'chart', height: 100, chart: { type, categories: ['A', 'B'], series: ['S'], values: values.map(value => [value]), title: '' } })])
    const all = flatten(buildSlideScene(model([page]), page))
    return all.filter(node => node.kind === 'rect' && node.fill === '#4472c4' && node.width > 2 && node.height > 2 || node.kind === 'path' && node.fill === '#4472c4')
  }
  for (const type of ['column', 'bar']) {
    for (const values of [[20_000_000, 40_000_000], [500_000_000_000, 1_000_000_000_000], [-500_000_000_000, -1_000_000_000_000], [Number.MAX_VALUE / 2, Number.MAX_VALUE]]) {
      const bars = points(type, values), dimension = type === 'column' ? 'height' : 'width'
      assert.equal(bars.length, 2)
      assert.ok(Math.abs(bars[1][dimension] / bars[0][dimension] - 2) < .000001, `${type}: ${values}`)
    }
  }
  const sector = points('pie', [20_000_000, 40_000_000])[0], [cx, cy] = sector.points[0]
  const [startX, startY] = sector.points[1], [endX, endY] = sector.points.at(-1)
  const sweep = Math.atan2(endY - cy, endX - cx) - Math.atan2(startY - cy, startX - cx)
  assert.ok(Math.abs(sweep - Math.PI * 2 / 3) < .000001, 'First pie slice occupies one third, not half')
})

test('zero-width and no-fill lines remain invisible in the shared SVG/PDF scene', () => {
  const page = slide([shape({ id: 'zero', type: 'line', lineColor: '#ff0000', lineWidth: 0 }), shape({ id: 'none', type: 'line', lineColor: null, lineWidth: 3 }), shape({ id: 'visible', type: 'line', lineColor: '#00ff00', lineWidth: .1 })])
  const lines = flatten(buildSlideScene(model([page]), page)).filter(node => node.kind === 'path')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].stroke, '#00ff00')
  assert.equal(lines[0].strokeWidth, .1)
  const svg = slideSvg(model([page]), page)
  assert.match(svg, /data-object-id="zero"/)
  assert.match(svg, /data-object-id="none"/)
  assert.doesNotMatch(svg, /stroke="#ff0000"/)
})

const pngHeader = (width, height) => {
  const header = new Uint8Array(33), view = new DataView(header.buffer)
  header.set([137, 80, 78, 71, 13, 10, 26, 10])
  view.setUint32(8, 13); view.setUint32(12, 0x49484452)
  view.setUint32(16, width); view.setUint32(20, height)
  return header
}

test('PNG pixel budgets reject zero, truncated and oversized dimensions before raster decoding', async () => {
  assert.doesNotThrow(() => assertPdfPngDimensions(pngHeader(8000, 8000)))
  assert.doesNotThrow(() => assertPdfPngDimensions(pngHeader(1, 1)))
  for (const [width, height] of [[8000, 8001], [64_000_001, 1], [0, 1], [1, 0], [0xffffffff, 0xffffffff]]) assert.throws(() => assertPdfPngDimensions(pngHeader(width, height)), /6400 万像素/)
  assert.throws(() => assertPdfPngDimensions(pngHeader(1, 1).slice(0, 24)), /图片头/)
  const invalid = pngHeader(1, 1); invalid[12] = 0
  assert.throws(() => assertPdfPngDimensions(invalid), /IHDR/)
  const fontBytes = new Uint8Array(await readFile(new URL('../public/office-runtime/NotoSansCJKsc-Regular.otf', import.meta.url)))
  const page = slide([shape({ type: 'image', image: { mimeType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.from(pngHeader(8000, 8001)).toString('base64')}` } })])
  await assert.rejects(exportPresentationPdf(model([page]), { fontBytes }), /6400 万像素/, 'PDF export must reject the header without passing it to the PNG raster decoder')
})

test('PDF text matrices preserve point sizes, vertical anchors, insets and nested text rotation', async () => {
  const fontBytes = new Uint8Array(await readFile(new URL('../public/office-runtime/NotoSansCJKsc-Regular.otf', import.meta.url)))
  const { default: fontkit } = await import('@pdf-lib/fontkit'), font = fontkit.create(fontBytes)
  const objects = ['top', 'middle', 'bottom'].map((verticalAlign, index) => shape({ id: verticalAlign, x: 5 + index * 80, y: 15, width: 70, height: 65, text: verticalAlign.toUpperCase(), textStyle: { ...style, fontSize: 20 }, textLayout: { verticalAlign, insets: { left: 5, right: 8, top: 3, bottom: 7 }, wrap: false } }))
  const rotated = shape({ id: 'rotated', x: 85, y: 95, width: 80, height: 35, text: 'ROTATED', rotation: 30, textStyle: { ...style, fontSize: 16, align: 'center' }, textLayout: { verticalAlign: 'middle', rotation: -90, insets: { left: 3, right: 3, top: 2, bottom: 2 }, wrap: false } })
  objects.push(rotated)
  const accent = shape({ id: 'accent', x: 5, y: 95, width: 70, height: 35, text: 'ÁÉ', textStyle: { ...style, fontSize: 20 }, textLayout: { verticalAlign: 'top', insets: { left: 2, right: 2, top: 2, bottom: 2 } } })
  const descender = { ...accent, id: 'descender', x: 175, text: 'gyjpq', textLayout: { ...accent.textLayout, verticalAlign: 'bottom' } }
  objects.push(accent, descender)
  const deck = model([slide(objects)]), bytes = await exportPresentationPdf(deck, { fontBytes })
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'), loading = pdfjs.getDocument({ data: bytes, isEvalSupported: false })
  const document = await loading.promise
  try {
    const page = await document.getPage(1), items = (await page.getTextContent()).items, k = 1 / PT_TO_MM
    for (const object of objects.slice(0, 3)) {
      const item = items.find(item => item.str === object.text)
      assert.ok(item, `Searchable ${object.text} text survives PDF clipping`)
      const glyphs = font.layout(object.text).glyphs, glyphScale = 20 * PT_TO_MM / font.unitsPerEm
      const ascent = Math.max(0, ...glyphs.map(glyph => glyph.bbox.maxY)) * glyphScale, descent = -Math.min(0, ...glyphs.map(glyph => glyph.bbox.minY)) * glyphScale
      const extra = (object.height - 3 - 7) - ascent - descent
      const top = object.y + 3 + (object.id === 'middle' ? extra / 2 : object.id === 'bottom' ? extra : 0)
      assert.ok(Math.abs(item.transform[4] / k - (object.x + 5)) < .0001)
      assert.ok(Math.abs(deck.height - item.transform[5] / k - (top + ascent)) < .0001)
      assert.ok(Math.abs(item.transform[0] - 20) < .0001, 'Point size is preserved, not treated as pixels/mm')
    }
    const item = items.find(item => item.str === 'ROTATED')
    assert.ok(item)
    const theta = (rotated.rotation + rotated.textLayout.rotation) * Math.PI / 180
    assert.ok(Math.abs(item.transform[0] / 16 - Math.cos(theta)) < .0001)
    assert.ok(Math.abs(item.transform[1] / 16 + Math.sin(theta)) < .0001, 'Body and object rotations both reach the actual PDF text matrix')
    for (const object of [accent, descender]) {
      const item = items.find(item => item.str === object.text), baseline = deck.height - item.transform[5] / k
      const glyphs = font.layout(object.text).glyphs, glyphScale = 20 * PT_TO_MM / font.unitsPerEm
      const actualTop = baseline - Math.max(...glyphs.map(glyph => glyph.bbox.maxY)) * glyphScale
      const actualBottom = baseline - Math.min(...glyphs.map(glyph => glyph.bbox.minY)) * glyphScale
      assert.ok(actualTop >= object.y + 2 - .0001, `${object.text}: accented glyphs fit below the actual PDF top clip`)
      assert.ok(actualBottom <= object.y + object.height - 2 + .0001, `${object.text}: descenders fit above the actual PDF bottom clip`)
    }
    const operators = await page.getOperatorList()
    assert.ok(operators.fnArray.includes(pdfjs.OPS.clip), 'PDF uses a vector clip for text overflow')
  } finally { await loading.destroy() }
})

test('PDF embeds searchable Chinese, exact slide dimensions and hidden pages without screenshots', async () => {
  const fontBytes = new Uint8Array(await readFile(new URL('../public/office-runtime/NotoSansCJKsc-Regular.otf', import.meta.url)))
  const first = slide([shape(), shape({ id: 'diagram', type: 'rectangle', x: 15, y: 70, width: 80, height: 20, fillColor: '#ff0000', text: '向量矩形' })])
  const second = slide([shape({ text: '隐藏页面仍保留' }), shape({ id: 'picture', type: 'image', x: 10, y: 65, width: 20, height: 20, image: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } })], { id: 'slide2', hidden: true })
  const bytes = await exportPresentationPdf(model([first, second]), { fontBytes })
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-')
  assert.ok(bytes.length < 500_000, 'Embedded CJK font should be subset, not 16 MB')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = pdfjs.getDocument({ data: bytes, useSystemFonts: false, isEvalSupported: false })
  const document = await loading.promise
  const fontWarnings = []
  const warn = console.warn, log = console.log
  const record = original => (...args) => { if (/Warning:.*(?:font|subr|glyph|CFF)/i.test(args.join(' '))) fontWarnings.push(args.join(' ')); original(...args) }
  console.warn = record(warn); console.log = record(log)
  try {
    assert.equal(document.numPages, 2)
    const page = await document.getPage(1), viewport = page.getViewport({ scale: 1 })
    assert.ok(Math.abs(viewport.width - 720) < .001)
    assert.ok(Math.abs(viewport.height - 405) < .001)
    const content = await page.getTextContent()
    const text = content.items.map(item => item.str).join('')
    assert.match(text, /独立演示真实编辑 中文 QA/)
    assert.match(text, /向量矩形/)
    const ops = await page.getOperatorList()
    assert.ok(!ops.fnArray.includes(pdfjs.OPS.paintImageXObject), 'Text and shapes stay vector')
    const hidden = await document.getPage(2)
    assert.match((await hidden.getTextContent()).items.map(item => item.str).join(''), /隐藏页面仍保留/)
    assert.ok((await hidden.getOperatorList()).fnArray.includes(pdfjs.OPS.paintImageXObject), 'Embedded PNG survives PDF export')
    assert.deepEqual(fontWarnings, [], 'CJK subsets must contain valid font dictionaries, subroutines and CFF headers')
  } finally { console.warn = warn; console.log = log; await loading.destroy() }
})
