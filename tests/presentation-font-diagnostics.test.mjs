import test from 'node:test'
import assert from 'node:assert/strict'
import { collectPresentationFonts, probeFontAvailability } from '../src/presentation/core/font-diagnostics.ts'

const style = fontName => ({ fontName, fontSize: 18, bold: false, italic: false, underline: false, color: '#000000', align: 'left' })
const textObject = (fontName, text = 'Text', extra = {}) => ({ id: 'text', type: 'text', text, textStyle: style(fontName), ...extra })
const model = (objects, inheritedObjects = []) => ({ slides: [{ objects, inheritedObjects }] })
const run = (text, fontName) => ({ text, style: style(fontName) })
const paragraph = (runs, fontName = 'Unused paragraph') => ({ runs, style: style(fontName), defaultRun: { style: style('Unused insertion') } })
const richObject = (paragraphs, extra = {}) => {
  const text = paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n')
  return textObject('Unused toolbar', text, { richText: { sourceText: text, sourceStyle: style('Unused toolbar'), paragraphs }, ...extra })
}

function fakeContext({ available = new Set(), identical = false, invalidMetrics = false, throws = false, ignoreCandidates = false } = {}) {
  let current = '16px original'
  const assigned = [], measured = []
  return {
    assigned, measured,
    get font() { return current },
    set font(value) { assigned.push(value); if (!(ignoreCandidates && value.includes('"'))) current = value },
    measureText(text) {
      measured.push({ font: current, text })
      if (throws) throw Error('Lost canvas')
      if (invalidMetrics) return { width: NaN }
      const generic = current.match(/(?:^48px |, )(monospace|serif|sans-serif)$/)?.[1] || 'monospace'
      const quoted = current.match(/^48px ("(?:[^"\\]|\\.)*"), /)?.[1]
      const named = quoted ? JSON.parse(quoted) : ''
      const base = { monospace: 10, serif: 11, 'sans-serif': 12 }[generic]
      const factor = !identical && available.has(named) ? 14 : base
      return { width: text.length * factor, actualBoundingBoxAscent: factor * .8, actualBoundingBoxDescent: factor * .2 }
    },
  }
}

test('collector visits actual text, inherited objects and group descendants, deduplicates names without mutation', () => {
  const child = textObject('  Arial  ', 'Child'), objects = [textObject('No ink', ''), { type: 'rectangle', text: '', textStyle: style('Default unused'), children: [child] }, textObject('arial'), textObject('Noto Sans CJK SC')]
  const source = model(objects, [textObject('Master Font')]), before = JSON.stringify(source)
  assert.deepEqual(collectPresentationFonts(source), { names: ['Master Font', 'Arial', 'Noto Sans CJK SC'], truncated: false })
  assert.equal(JSON.stringify(source), before)
})

test('collector includes effective rich run fonts and excludes unused toolbar, paragraph and insertion fonts', () => {
  const object = richObject([paragraph([run('one', 'Run A'), run('two', 'Run B')])])
  assert.deepEqual(collectPresentationFonts(model([object])).names, ['Run A', 'Run B'])
  object.textStyle = style('Replacement')
  assert.deepEqual(collectPresentationFonts(model([object])).names, ['Replacement'])
  object.textStyle = style('Unused toolbar')
  object.textStyleOverrides = { fontName: 'Unused toolbar' }
  assert.deepEqual(collectPresentationFonts(model([object])).names, ['Unused toolbar'], 'Explicit baseline-value font applications replace every old run font')
})

test('collector follows changed paragraph templates and empty paragraph metrics instead of stale original runs', () => {
  const object = richObject([paragraph([run('one', 'First'), run('two', 'Old unused')]), paragraph([], 'Empty metrics'), paragraph([run('keep', 'Keep')])])
  object.text = 'replacement\n\nkeep'
  assert.deepEqual(collectPresentationFonts(model([object])).names, ['First', 'Empty metrics', 'Keep'])
  const initialEmpty = richObject([paragraph([], 'Large empty metrics'), paragraph([run('keep', 'Keep')])])
  initialEmpty.text = 'inserted\nkeep'
  assert.deepEqual(collectPresentationFonts(model([initialEmpty])).names, ['Unused insertion', 'Keep'])
  const breakObject = richObject([paragraph([run('', 'Empty unused'), run('text', 'Text'), run('\n', 'Break')], 'End metrics')])
  assert.deepEqual(collectPresentationFonts(model([breakObject])).names, ['Text', 'Break', 'End metrics'])
})

test('collector bounds count, traversal depth, cycles and rich text budget', () => {
  const source = model(Array.from({ length: 65 }, (_, index) => textObject(`Font ${index}`)))
  const result = collectPresentationFonts(source)
  assert.equal(result.names.length, 64); assert.equal(result.truncated, true)
  assert.deepEqual(collectPresentationFonts(model([textObject('One')])), { names: ['One'], truncated: false })
  assert.deepEqual(collectPresentationFonts(model([textObject('One')]), 0), { names: [], truncated: true })
  assert.deepEqual(collectPresentationFonts(model([textObject('One'), textObject('one')]), 1), { names: ['One'], truncated: false })
  assert.equal(collectPresentationFonts(source, 2.9).names.length, 2)
  const group = { type: 'group', children: [] }; group.children.push(group, textObject('Cycle child'))
  assert.deepEqual(collectPresentationFonts(model([group])), { names: ['Cycle child'], truncated: false })
  let deep = textObject('Deep'); for (let index = 0; index < 100; index++) deep = { type: 'group', children: [deep] }
  assert.equal(collectPresentationFonts(model([deep])).truncated, true)
  assert.equal(collectPresentationFonts(model(Array.from({ length: 25000 }, () => textObject('Same')))).truncated, true)
  assert.equal(collectPresentationFonts(model([richObject([paragraph([run('x'.repeat(1_000_001), 'Huge')])])])).truncated, true)
})

test('collector avoids protected cached artwork fonts and adds rendered table/chart labels only', () => {
  const source = model([{ type: 'unknown', locked: true, text: 'Original unsupported text', textStyle: style('Unavailable embedded'), diagramPreview: { dataUrl: 'data:image/png;base64,AAAA' } },
    { type: 'table', textStyle: style('Table font'), table: { cells: [['Cell', '']] } }, { type: 'chart', textStyle: style('Unused chart font'), chart: { title: 'Chart' } }])
  assert.deepEqual(collectPresentationFonts(source).names, ['Table font', 'sans-serif'])
})

test('font probe identifies differing metrics, treats full fallback equivalence as possible substitution and restores state', () => {
  const present = fakeContext({ available: new Set(['Present Font']) })
  assert.equal(probeFontAvailability('Present Font', present), 'available')
  assert.equal(present.font, '16px original')
  assert.equal(present.measured.length, 24, 'Three generic fallbacks and four Latin/CJK samples, each measured against its candidate')
  assert.ok(present.measured.some(item => /汉字/.test(item.text)))
  assert.equal(probeFontAvailability('Missing Font', present), 'possibly-substituted')
  const alias = fakeContext({ available: new Set(['Alias']), identical: true })
  assert.equal(probeFontAvailability('Alias', alias), 'possibly-substituted', 'Metric aliases are not falsely claimed to prove installation')
})

test('generic families are available without probing; invalid names and unreliable canvases stay unknown', () => {
  for (const name of ['serif', ' sans-serif ', 'MONOSPACE', 'system-ui', 'ui-serif']) assert.equal(probeFontAvailability(name, null), 'available')
  for (const name of ['', ' ', 'A'.repeat(129), 'Bad\nName', 'Bad\0Name', 'inherit', 'revert-layer']) assert.equal(probeFontAvailability(name, fakeContext()), 'unknown')
  assert.equal(probeFontAvailability('Some font', null), 'unknown')
  for (const options of [{ invalidMetrics: true }, { throws: true }, { ignoreCandidates: true }]) {
    const context = fakeContext(options)
    assert.equal(probeFontAvailability('Some font', context), 'unknown')
    assert.equal(context.font, '16px original')
  }
})

test('font names are quoted as one literal CSS family and cannot insert additional fallback rules', () => {
  const name = 'Name",monospace;url(https://example.invalid)\\font', context = fakeContext()
  assert.equal(probeFontAvailability(name, context), 'possibly-substituted')
  const candidates = context.assigned.filter(value => value.includes('"'))
  for (const font of candidates) {
    const match = font.match(/^48px ("(?:[^"\\]|\\.)*"), (monospace|serif|sans-serif)$/)
    assert.ok(match, `Exactly one escaped family plus one fixed fallback: ${font}`)
    assert.equal(JSON.parse(match[1]), name)
  }
  assert.equal(context.font, '16px original')
})

test('probe has no permanent availability cache and rechecks when the caller invalidates its cache', () => {
  const available = new Set(), context = fakeContext({ available })
  assert.equal(probeFontAvailability('Late Font', context), 'possibly-substituted')
  available.add('Late Font')
  assert.equal(probeFontAvailability('Late Font', context), 'available')
})


test('uninspectable source names are omitted safely and mark the diagnostic as incomplete', () => {
  const result = collectPresentationFonts(model([textObject('Safe'), textObject('Bad\nname'), textObject('X'.repeat(129))]))
  assert.deepEqual(result, { names: ['Safe'], truncated: true })
})

test('table fonts use displayed mixed cells, not the unused uniform table style', () => {
  const source = model([{ type: 'table', textStyle: style('Unused table default'), table: { cells: [['OneTwo', 'Fallback']] },
    tableCellText: [[{ richText: { sourceText: 'OneTwo', sourceStyle: style('Unused baseline'), paragraphs: [paragraph([run('One', 'Cell A'), run('Two', 'Cell B')])] } }, {}]] }])
  assert.deepEqual(collectPresentationFonts(source).names, ['Cell A', 'Cell B', 'Unused table default'])
  assert.deepEqual(collectPresentationFonts(source, 1), { names: ['Cell A'], truncated: true })
})
