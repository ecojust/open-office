import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveRichText } from '../src/presentation/core/rich-text.ts'
import { layoutRichText, richTextBounds } from '../src/presentation/core/rich-text-layout.ts'
import { buildSlideScene, estimatedTextWidth, PT_TO_MM } from '../src/presentation/core/scene.ts'
import { slideSvg } from '../src/presentation/core/render.ts'

const base = { fontName: 'Arial', fontSize: 18, bold: false, italic: false, underline: false, color: '#000000', align: 'left' }
const small = { ...base, fontSize: 12, italic: true, color: '#0000ff' }
const large = { ...base, fontSize: 42, bold: true, color: '#ff0000' }
const paragraphs = [{ style: { ...base, align: 'center' }, runs: [{ text: 'ÁÉ', style: small }, { text: 'Big', style: large }] }, { style: { ...base, align: 'right' }, runs: [{ text: 'gy', style: small }] }]
const text = 'ÁÉBig\ngy'
const rich = { sourceText: text, sourceStyle: base, paragraphs }
const object = (extra = {}) => ({ id: 'rich', name: 'Rich', type: 'text', x: 10, y: 10, width: 150, height: 80, rotation: 0, text, textStyle: base, richText: rich, capabilities: { text: true }, fillColor: null, lineColor: null, lineWidth: 0, zIndex: 0, ...extra })
const page = (obj) => ({ id: 'slide', name: 'Slide', objects: [obj], hidden: false, background: '#ffffff', warnings: [], layout: 0, notes: '', transition: { type: 'none' }, media: [] })
const metrics = (_text, _style, size) => ({ ascent: size * .85, descent: size * .15 })
const flat = nodes => nodes.flatMap(node => node.kind === 'group' ? flat(node.children) : [node])

test('mixed sizes share a maximum-ascent baseline; paragraphs retain distinct alignment and fonts', () => {
  const obj = object(), slide = page(obj), model = { width: 200, height: 120, slides: [slide], warnings: [] }
  const nodes = flat(buildSlideScene(model, slide, { measureText: estimatedTextWidth, measureTextMetrics: metrics })).filter(node => node.kind === 'text')
  assert.deepEqual(nodes.map(node => node.text), ['ÁÉ', 'Big', 'gy'])
  assert.equal(nodes[0].y, nodes[1].y)
  assert.equal(nodes[0].size, 12 * PT_TO_MM)
  assert.equal(nodes[1].size, 42 * PT_TO_MM)
  assert.equal(nodes[0].italic, true); assert.equal(nodes[0].bold, false)
  assert.equal(nodes[1].bold, true); assert.equal(nodes[1].italic, false)
  assert.ok(Math.abs(nodes[0].x + (nodes[0].width + nodes[1].width) / 2 - 85) < 1e-8)
  assert.ok(Math.abs(nodes[2].x + nodes[2].width - 158.7) < 1e-8)
  assert.ok(Math.abs(nodes[0].y - (11.3 + 42 * PT_TO_MM * .85)) < 1e-8)
  assert.ok(nodes[2].y > nodes[1].y)
})

test('toolbar changes apply only modified attributes and plain text edit mirrors export paragraph templates', () => {
  const resized = effectiveRichText(object({ textStyle: { ...base, fontSize: 27, italic: true } }))
  assert.deepEqual(resized[0].runs.map(run => [run.style.fontSize, run.style.italic, run.style.color, run.style.bold]), [[27, true, '#0000ff', false], [27, true, '#ff0000', true]])
  const edited = effectiveRichText(object({ text: 'Changed\ngy' }))
  assert.equal(edited[0].runs.length, 1); assert.equal(edited[0].runs[0].text, 'Changed')
  assert.equal(edited[0].runs[0].style.fontSize, 12)
  assert.deepEqual(edited[1], paragraphs[1])
  assert.equal(effectiveRichText(object({ richText: undefined })), undefined)
})

test('rich wrap conserves text across runs, uses large-font metrics and respects hard breaks and empty lines', () => {
  const p = [{ style: base, runs: [{ text: 'one two\n\n中文长句', style: small }, { text: 'BIG', style: large }] }]
  const lines = layoutRichText(p, 15, true, estimatedTextWidth, metrics)
  assert.equal(lines.flatMap(line => line.fragments).map(run => run.text).join(''), 'onetwo中文长句BIG')
  assert.ok(lines.some(line => line.fragments.every(fragment => !fragment.text)))
  assert.ok(lines.every(line => Number.isFinite(line.height) && line.height >= line.ascent + line.descent))
  const big = lines.find(line => line.fragments.some(fragment => fragment.text.includes('B')))
  assert.equal(big.ascent, 42 * PT_TO_MM * .85)
  assert.equal(layoutRichText(p, 2, false, estimatedTextWidth, metrics).length, 3)
})

test('rich content cannot inject raw XML, external resources or executable SVG colors', () => {
  const evil = '<script>alert(1)</script>'
  const obj = object({ text: evil, richText: { sourceText: evil, sourceStyle: base, paragraphs: [{ style: base, runs: [{ text: evil, style: { ...base, fontName: '" onload="evil()', color: 'url(https://evil.invalid)' } }] }] } })
  const slide = page(obj), svg = slideSvg({ width: 200, height: 120, slides: [slide], warnings: [] }, slide)
  assert.doesNotMatch(svg, /<script|<foreignObject|https:\/\/evil|\sonload="/)
  assert.match(svg, /&lt;script&gt;/)
})


test('exact-fit words do not create whitespace-only wrap lines or break at style boundaries', () => {
  const measure = text => text.length
  const p = [{ style: base, runs: [{ text: 'hello world', style: base }] }]
  assert.deepEqual(layoutRichText(p, 5, true, measure, metrics).map(line => line.fragments.map(run => run.text).join('')), ['hello', 'world'])
  const mixed = [{ style: base, runs: [{ text: 'a hel', style: base }, { text: 'lo world', style: small }] }]
  assert.deepEqual(layoutRichText(mixed, 5, true, measure, metrics).map(line => line.fragments.map(run => run.text).join('')), ['a', 'hello', 'world'])
})


const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} vs ${expected}`)
const paragraph = (runs, extra = {}) => ({ style: base, runs, ...extra })
const run = (text, fontSize = 18, baseline) => ({ text, style: { ...base, fontSize }, ...(baseline !== undefined ? { baseline } : {}) })

test('fixed line spacing is a baseline advance even when successive lines have different large glyphs', () => {
  const p = paragraph([run('small\n', 12), run('LARGE\n', 42), run('third', 18)], { lineSpacing: { unit: 'points', value: 1 } })
  const lines = layoutRichText([p], 100, false, estimatedTextWidth, metrics)
  assert.equal(lines.length, 3)
  close(lines[1].baseline - lines[0].baseline, PT_TO_MM, 'First fixed baseline advance')
  close(lines[2].baseline - lines[1].baseline, PT_TO_MM, 'Second fixed baseline advance')
  assert.ok(lines[1].height < lines[1].ascent + lines[1].descent, 'Exact spacing is not enlarged to glyph bounds')
  const bounds = richTextBounds(lines)
  assert.ok(bounds.top < 0 && bounds.height >= 42 * PT_TO_MM, 'Ink extent includes a large overlapping middle line')
})

test('percent line spacing preserves explicit zero and keeps paragraph spacing separate from soft/hard breaks', () => {
  const p = paragraph([run('same\nsame\nsame', 20)], { lineSpacing: { unit: 'percent', value: 1.5 }, spaceBefore: { unit: 'points', value: 6 }, spaceAfter: { unit: 'points', value: 8 } })
  const lines = layoutRichText([p], 100, false, estimatedTextWidth, metrics, { spaceFirstLastParagraph: true })
  close(lines[1].baseline - lines[0].baseline, lines[0].fontSize * 1.5)
  close(lines[2].baseline - lines[1].baseline, lines[1].fontSize * 1.5)
  close(lines[0].spaceBefore, 6 * PT_TO_MM); assert.equal(lines[1].spaceBefore, 0)
  close(lines[2].spaceAfter, 8 * PT_TO_MM); assert.equal(lines[1].spaceAfter, 0)
  const zero = layoutRichText([{ ...p, lineSpacing: { unit: 'percent', value: 0 } }], 100, false, estimatedTextWidth, metrics)
  close(zero[1].baseline, zero[0].baseline)
})

test('adjacent paragraph gaps collapse by maximum and outer paragraph spacing obeys bodyPr opt-in', () => {
  const p = [paragraph([run('one')], { spaceBefore: { unit: 'points', value: 5 }, spaceAfter: { unit: 'points', value: 12 } }),
    paragraph([run('two')], { spaceBefore: { unit: 'points', value: 7 }, spaceAfter: { unit: 'points', value: 9 } })]
  const lines = layoutRichText(p, 100, false, estimatedTextWidth, metrics)
  close(lines[0].baseline, lines[0].ascent)
  close(lines[1].baseline - lines[0].baseline, lines[0].height + 12 * PT_TO_MM)
  assert.equal(lines[0].spaceBefore, 0); assert.equal(lines[1].spaceAfter, 0)
  const outer = layoutRichText(p, 100, false, estimatedTextWidth, metrics, { spaceFirstLastParagraph: true })
  close(outer[0].baseline - lines[0].baseline, 5 * PT_TO_MM)
  close(richTextBounds(outer).height - richTextBounds(lines).height, 14 * PT_TO_MM)
})

test('percent paragraph spacing uses first/last largest font size and not modified line advance', () => {
  const p = paragraph([run('small\n', 12), run('large', 36)], { lineSpacing: { unit: 'percent', value: 1.5 }, spaceBefore: { unit: 'percent', value: .5 }, spaceAfter: { unit: 'percent', value: .5 } })
  const narrowMetrics = (_text, _style, size) => ({ ascent: size * .6, descent: size * .1 })
  const lines = layoutRichText([p], 100, false, estimatedTextWidth, narrowMetrics, { spaceFirstLastParagraph: true })
  close(lines[0].spaceBefore, 6 * PT_TO_MM); close(lines[1].spaceAfter, 18 * PT_TO_MM)
  const exact = layoutRichText([{ ...p, lineSpacing: { unit: 'points', value: 1 } }], 100, false, estimatedTextWidth, metrics, { spaceFirstLastParagraph: true })
  close(lines[0].spaceBefore, exact[0].spaceBefore); close(lines[1].spaceAfter, exact[1].spaceAfter)
})

test('run baseline offsets are separate from stored font sizes and shared SVG scene positions', () => {
  const p = paragraph([run('normal', 24, 0), run('up', 12.34, .3), run('down', 18, -.25), run('zero', 12.34, 0)])
  const sourceText = p.runs.map(run => run.text).join(''), obj = object({ text: sourceText, textStyle: base, richText: { sourceText, sourceStyle: base, paragraphs: [p] } })
  const slide = page(obj), model = { width: 200, height: 120, slides: [slide], warnings: [] }
  const nodes = flat(buildSlideScene(model, slide, { measureText: estimatedTextWidth, measureTextMetrics: metrics })).filter(node => node.kind === 'text')
  close(nodes[0].y - nodes[1].y, 12.34 * PT_TO_MM * .3)
  close(nodes[2].y - nodes[0].y, 18 * PT_TO_MM * .25)
  close(nodes[3].y, nodes[0].y)
  close(nodes[1].size, 12.34 * PT_TO_MM, 'Already sized superscript must not receive a second arbitrary shrink')
  assert.equal(effectiveRichText(obj)[0].runs[1].style.fontSize, 12.34)
  const changed = effectiveRichText({ ...obj, textStyle: { ...base, fontSize: 30 }, textStyleOverrides: { fontSize: 30 } })
  assert.equal(changed[0].runs[1].baseline, .3)
  const shifted = layoutRichText(changed, 100, false, estimatedTextWidth, metrics)[0].fragments
  close(shifted[1].baselineOffset, 30 * PT_TO_MM * .3)
})

test('vertical alignment measures complete ink bounds even with overlapping fixed lines and raised text', () => {
  const p = paragraph([run('small\n', 12), run('BIG', 42, .3)], { lineSpacing: { unit: 'points', value: 1 } })
  for (const verticalAlign of ['middle', 'bottom']) {
    const sourceText = 'small\nBIG', obj = object({ text: sourceText, textStyle: base, textLayout: { verticalAlign, wrap: false, insets: { left: 0, right: 0, top: 4, bottom: 6 } }, richText: { sourceText, sourceStyle: base, paragraphs: [p] } })
    const slide = page(obj), model = { width: 200, height: 120, slides: [slide], warnings: [] }
    const nodes = flat(buildSlideScene(model, slide, { measureText: estimatedTextWidth, measureTextMetrics: metrics })).filter(node => node.kind === 'text')
    const inkTop = Math.min(...nodes.map(node => node.y - node.size * .85)), inkBottom = Math.max(...nodes.map(node => node.y + node.size * .15))
    assert.ok(inkTop >= 14 && inkBottom <= 84 + 1e-8)
    if (verticalAlign === 'bottom') close(inkBottom, 84)
    else close((inkTop + inkBottom) / 2, 49)
  }
})

test('plain-text editing retains paragraph spacing and first-run baseline while empty insertion uses defaults', () => {
  const p = paragraph([run('old', 24, .3)], { lineSpacing: { unit: 'points', value: 12 }, spaceBefore: { unit: 'points', value: 7 }, defaultRun: { style: base, baseline: -.1 } })
  const empty = paragraph([], { style: large, baseline: .25, defaultRun: { style: small, baseline: 0 } })
  const obj = object({ text: 'changed\ninserted', richText: { sourceText: 'old\n', sourceStyle: base, paragraphs: [p, empty] } })
  const result = effectiveRichText(obj)
  assert.deepEqual(result[0].lineSpacing, p.lineSpacing); assert.deepEqual(result[0].spaceBefore, p.spaceBefore)
  assert.equal(result[0].runs[0].baseline, .3); assert.equal(result[0].runs[0].style.fontSize, 24)
  assert.equal(result[1].runs[0].baseline, 0); assert.equal(result[1].runs[0].style.fontSize, 12)
})


test('explicit percentage advance is independent of baseline shifts and greatest run size controls its base', () => {
  const p = paragraph([run('up\n', 20, .3), run('normal ', 12), run('large', 20)], { lineSpacing: { unit: 'percent', value: 1.5 } })
  const lines = layoutRichText([p], 100, false, estimatedTextWidth, metrics)
  close(lines[1].baseline - lines[0].baseline, 30 * PT_TO_MM)
  close(lines[0].fontSize, 20 * PT_TO_MM); close(lines[1].fontSize, 20 * PT_TO_MM)
})

test('explicit break formatting affects its line, not the following line, with wrapping either enabled or disabled', () => {
  const p = paragraph([run('first', 12), run('\n', 42, .3), run('second', 12)])
  const wrapped = layoutRichText([p], 100, true, estimatedTextWidth, metrics)
  const unwrapped = layoutRichText([p], 100, false, estimatedTextWidth, metrics)
  for (const lines of [wrapped, unwrapped]) {
    close(lines[0].fontSize, 42 * PT_TO_MM)
    close(lines[1].fontSize, 12 * PT_TO_MM)
  }
  assert.deepEqual(unwrapped.map(line => [line.height, line.ascent, line.descent, line.baseline]), wrapped.map(line => [line.height, line.ascent, line.descent, line.baseline]))
})


test('empty ordinary runs do not change layout when wrapping is toggled without a line break', () => {
  const p = paragraph([run('', 42), run('second', 12)])
  const wrapped = layoutRichText([p], 1000, true, estimatedTextWidth, metrics)
  const unwrapped = layoutRichText([p], 1000, false, estimatedTextWidth, metrics)
  assert.deepEqual(unwrapped.map(line => [line.height, line.ascent, line.descent, line.baseline, line.fontSize]), wrapped.map(line => [line.height, line.ascent, line.descent, line.baseline, line.fontSize]))
  close(unwrapped[0].fontSize, 12 * PT_TO_MM)
})
