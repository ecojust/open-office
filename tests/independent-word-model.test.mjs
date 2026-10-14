import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_LINE_HEIGHT_LIMITS, BASELINE_OFFSET_FONTS, BASELINE_OFFSET_LIMITS, createWordDocument, documentText, LETTER_SPACING_LIMITS, normalizeDocument, normalizeUnderlineColor, normalizeVerticalAlign, normalizeSourceVerticalAlign, PAGE_MARGIN_LIMITS, PAGE_SIZE_LIMITS, PARAGRAPH_SPACING_LIMITS, POINT_LINE_HEIGHT_LIMITS, WordController, withParagraphMarkerSource, paragraphInsertionFormat } from '../src/word/core/model.ts'
import { normalizePaperDimension } from '../src/word/core/paper.ts'
import { HIGHLIGHT_COLORS, highlightFromCss, isHighlightColor } from '../src/word/core/highlight.ts'
import { backgroundFromCss, normalizeBackgroundColor, textBackgroundColor } from '../src/word/core/background.ts'

const range = (p, from, to, end = p) => ({ anchor: { paragraph: p, offset: from }, focus: { paragraph: end, offset: to } })
function sample() {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'first', style: { align: 'center' }, runs: [{ text: '中文😀', style: { bold: true } }, { text: ' plain', style: { italic: true } }] },
    { id: 'second', style: { heading: 2 }, runs: [{ text: 'second', style: { color: '#123456' } }] },
    { id: 'third', style: {}, runs: [{ text: 'tail', style: {} }] },
  ]
  return new WordController(model)
}

test('partial character format preserves surrounding runs, false values, and undo selection', () => {
  const c = sample(), before = c.model, selected = range(0, 2, 4)
  c.formatText(selected, { bold: false, color: '#abcdef' })
  assert.deepEqual(c.model.paragraphs[0].runs, [
    { text: '中文', style: { bold: true } },
    { text: '😀', style: { bold: false, color: '#ABCDEF' } },
    { text: ' plain', style: { italic: true } },
  ])
  assert.equal(c.dirty, true)
  c.undo()
  assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selected)
  assert.equal(c.dirty, false)
  c.redo()
  assert.equal(c.model.paragraphs[0].runs[1].style.bold, false)
})

test('replacing a backwards multi-paragraph range joins prefix and suffix without losing their styles', () => {
  const c = sample()
  c.replaceText({ anchor: { paragraph: 1, offset: 3 }, focus: { paragraph: 0, offset: 4 } }, ' inserted\n新段')
  assert.equal(documentText(c.model), '中文😀 inserted\n新段ond\ntail')
  assert.equal(c.model.paragraphs[0].id, 'first')
  assert.deepEqual(c.model.paragraphs[1].runs.at(-1), { text: 'ond', style: { color: '#123456' } })
  assert.equal(c.model.paragraphs[1].style.align, 'center')
  assert.deepEqual(c.selection, range(1, 2, 2))
  c.undo()
  assert.equal(documentText(c.model), '中文😀 plain\nsecond\ntail')
  c.redo()
  assert.equal(documentText(c.model), '中文😀 inserted\n新段ond\ntail')
})

test('a paragraph range ending at the next paragraph start excludes that paragraph', () => {
  const c = sample()
  c.formatParagraph(range(0, 1, 0, 1), { align: 'right', heading: 1 })
  assert.deepEqual(c.model.paragraphs[0].style, { align: 'right', heading: 1 })
  assert.deepEqual(c.model.paragraphs[1].style, { heading: 2 })
  c.formatParagraph(range(1, 0, 0), { align: 'justify' })
  assert.equal(c.model.paragraphs[1].style.align, 'justify')
})

test('invalid selection, Unicode, formatting and paper geometry cannot partly commit', () => {
  const c = sample(), before = c.model
  for (const work of [
    () => c.formatText(range(0, 3, 4), { bold: false }),
    () => c.replaceText(range(0, 0, 1), '\ud800'),
    () => c.formatText(range(0, 0, 1), { fontSize: NaN }),
    () => c.setDocument({ ...c.model, page: { ...c.model.page, marginLeft: 600 } }),
    () => c.setDocument({ ...c.model, paragraphs: [] }),
  ]) assert.throws(work)
  assert.deepEqual(c.model, before)
  assert.equal(c.revision, 0)
  assert.equal(c.canUndo, false)
})

test('model and selection reads are detached; selection and no-op changes do not dirty the file', () => {
  const c = sample()
  c.model.paragraphs[0].runs[0].text = 'external mutation'
  c.selection.anchor.offset = 999
  c.setSelection(range(1, 1, 4))
  c.setDocument(c.model)
  c.formatText(range(0, 0, 0), { bold: true })
  assert.equal(documentText(c.model), '中文😀 plain\nsecond\ntail')
  assert.equal(c.dirty, false)
  assert.equal(c.canUndo, false)
  assert.equal(c.revision, 0)
})

test('saving an older export cannot mark a newer edit clean; editing after undo drops redo', () => {
  const c = sample()
  c.replaceText(range(2, 4, 4), '!')
  const exportedRevision = c.revision
  c.replaceText(range(2, 5, 5), '?')
  c.markSaved(exportedRevision)
  assert.equal(c.dirty, true)
  c.undo()
  assert.equal(c.dirty, false, 'undo returns to the version actually written to disk')
  assert.equal(c.canRedo, true)
  c.markSaved()
  assert.equal(c.dirty, false)
  c.replaceText(range(2, 5, 5), '新')
  assert.equal(c.canRedo, false)
  c.undo()
  assert.equal(c.dirty, false)
})

test('page formatting is one transaction preserving backwards Unicode selection and document content', () => {
  const c = sample(), selected = { anchor: { paragraph: 1, offset: 3 }, focus: { paragraph: 0, offset: 4 } }
  c.setSelection(selected)
  const before = c.model
  c.formatPage({ width: 792, height: 612, marginTop: 36, marginRight: 54, marginBottom: 72, marginLeft: 90, orientation: 'landscape' })
  const after = c.model
  assert.deepEqual(after.page, { width: 792, height: 612, marginTop: 36, marginRight: 54, marginBottom: 72, marginLeft: 90, orientation: 'landscape' })
  assert.deepEqual(after.paragraphs, before.paragraphs)
  assert.deepEqual(c.selection, selected)
  assert.equal(c.revision, 1); assert.equal(c.dirty, true)
  c.undo()
  assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
  assert.equal(c.canUndo, false); assert.equal(c.canRedo, true); assert.equal(c.dirty, false)
  c.redo()
  assert.deepEqual(c.model, after); assert.deepEqual(c.selection, selected)
})

test('page no-ops preserve clean state and redo while partial valid changes retain untouched values', () => {
  const c = sample(), before = c.model
  c.formatPage({}); c.formatPage(before.page); c.formatPage({ width: undefined })
  assert.deepEqual(c.model, before); assert.equal(c.revision, 0); assert.equal(c.canUndo, false); assert.equal(c.dirty, false)
  c.formatPage({ marginLeft: 72.05 })
  assert.deepEqual(c.model.page, { ...before.page, marginLeft: 72.05 })
  c.undo()
  const revision = c.revision
  c.formatPage({}); c.formatPage(c.model.page)
  assert.equal(c.revision, revision); assert.equal(c.canRedo, true)
  c.redo(); assert.equal(c.model.page.marginLeft, 72.05)
  c.undo(); c.formatPage({ marginRight: 0.1 + 0.2 })
  assert.equal(c.model.page.marginRight, 0.3)
  assert.equal(c.canRedo, false)
})

test('invalid page changes preserve selection, dirty state and both history directions atomically', () => {
  const c = sample(), selected = range(0, 2, 4)
  c.setSelection(selected); c.formatPage({ width: 612 }); c.undo()
  const before = c.model, revision = c.revision
  const invalid = [
    null, [], { paper: 'A4' }, { orientation: 'diagonal' }, { orientation: null },
    { width: NaN }, { height: Infinity }, { marginTop: '12' },
    { width: 71.95 }, { height: 1584.05 }, { marginLeft: -0.05 }, { marginBottom: 1584.05 },
    { width: 612.025 }, { marginTop: 0.01 },
    { width: 144, marginLeft: 72, marginRight: 72 },
    { width: 72.15, marginLeft: 0.05, marginRight: 72.1 },
    { height: 72.15, marginTop: 0.05, marginBottom: 72.1 },
    { height: 100, marginTop: 60, marginBottom: 41 },
    { width: 612, marginLeft: 1584 },
  ]
  for (const patch of invalid) {
    assert.throws(() => c.formatPage(patch))
    assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
    assert.equal(c.revision, revision); assert.equal(c.dirty, false)
    assert.equal(c.canUndo, false); assert.equal(c.canRedo, true)
  }
  c.redo(); assert.equal(c.model.page.width, 612)
})

test('page geometry uses integer twips for both zero-area rejection and one-twip body acceptance', () => {
  const model = createWordDocument()
  model.page = { width: 72.15, height: 72.15, marginLeft: 0.05, marginRight: 72.1, marginTop: 0, marginBottom: 0 }
  assert.throws(() => normalizeDocument(model), /页边距/)
  model.page.marginRight = 72.05
  model.page.marginTop = 0.05; model.page.marginBottom = 72.1
  assert.throws(() => normalizeDocument(model), /页边距/)
  model.page.marginBottom = 72.05
  const c = new WordController(model)
  assert.deepEqual(c.model.page, model.page)
  assert.equal(Math.round(c.model.page.width * 20) - Math.round(c.model.page.marginLeft * 20) - Math.round(c.model.page.marginRight * 20), 1)
  assert.equal(Math.round(c.model.page.height * 20) - Math.round(c.model.page.marginTop * 20) - Math.round(c.model.page.marginBottom * 20), 1)
})

test('page formatting retains marker editing origin and live baseline insertion across history', () => {
  const hard = wholeBodyMarkerController()
  hard.formatText(range(0, 0, 4), { bold: true })
  const beforePage = hard.model
  hard.formatPage({ width: 612, height: 792 })
  assert.deepEqual(hard.model.paragraphs, beforePage.paragraphs)
  hard.formatText(range(0, 0, 4), { italic: false })
  assert.deepEqual(hard.model.paragraphs[0].marker.directStyle, { bold: true, italic: false })
  hard.undo(); hard.undo(); assert.deepEqual(hard.model, beforePage)
  hard.redo(); hard.formatText(range(0, 0, 4), { underline: 'double' })
  assert.deepEqual(hard.model.paragraphs[0].marker.directStyle, { bold: true, underline: 'double' })

  const model = createWordDocument(), base = { fontSize: 12, fontName: 'DejaVu Sans' }
  model.paragraphs[0] = { id: 'page-session', style: {}, sourceRun: base,
    marker: { style: { ...base, verticalAlign: 'superscript' }, directStyle: { verticalAlign: 'superscript' } },
    runs: [{ text: 'BODY', style: { ...base, verticalAlign: 25 }, directStyle: { fontSize: 12, verticalAlign: 25 } }] }
  const c = new WordController(model)
  c.replaceText(range(0, 0, 4), ''); c.replaceText(c.selection, 'x')
  const session = c.model
  assert.ok(session.paragraphs[0].sessionInsertion)
  c.formatPage({ marginLeft: 36 })
  assert.deepEqual(c.model.paragraphs, session.paragraphs)
  c.undo(); assert.deepEqual(c.model, session); c.redo()
  c.replaceText(c.selection, 'y')
  assert.equal(documentText(c.model), 'xy')
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.verticalAlign, 25)
  assert.deepEqual(c.model.paragraphs[0].marker, session.paragraphs[0].marker)
})

test('page editing validates exact twips without changing legacy document normalization', () => {
  assert.deepEqual(PAGE_SIZE_LIMITS, { min: 72, max: 1584, step: 0.05 })
  assert.deepEqual(PAGE_MARGIN_LIMITS, { min: 0, max: 1584, step: 0.05 })
  const legacy = createWordDocument(); legacy.page.width = 595.275; legacy.page.marginLeft = 72.024
  const c = new WordController(legacy)
  assert.equal(c.model.page.width, 595.3); assert.equal(c.model.page.marginLeft, 72)
  assert.throws(() => c.formatPage({ width: 595.275 }))
  c.formatPage({ width: 72, height: 72, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 })
  assert.deepEqual(c.model.page, { width: 72, height: 72, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 })
  c.formatPage({ width: 1584, height: 1584, marginRight: 1583.95, marginBottom: 1583.95 })
  assert.equal(c.model.page.width - c.model.page.marginLeft - c.model.page.marginRight > 0, true)
})

test('explicit page orientation is independent of dimensions and survives normalization and history', () => {
  const c = new WordController(), before = c.model
  assert.equal(before.page.orientation, undefined)
  c.formatPage({ orientation: 'landscape' })
  assert.deepEqual(c.model.page, { ...before.page, orientation: 'landscape' })
  assert.equal(c.model.page.width < c.model.page.height, true, 'orientation-only updates do not invent a dimension swap')
  assert.deepEqual(normalizeDocument(c.model), c.model)
  const revision = c.revision
  c.formatPage({ orientation: 'landscape' }); assert.equal(c.revision, revision)
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.equal(c.model.page.orientation, 'landscape')
  const invalid = c.model; invalid.page.orientation = 'auto'
  assert.throws(() => c.setDocument(invalid), /方向/)
  assert.equal(c.model.page.orientation, 'landscape')
  c.formatPage({ width: 792, height: 612, orientation: 'portrait' })
  assert.equal(c.model.page.orientation, 'portrait'); assert.equal(c.model.page.width > c.model.page.height, true)
})

test('paper dimensions match native first-open measurements at fit boundaries and overlapping paper edges', () => {
  // Independent native DOCX first/second-save measurements from page-settings
  // presets-report.json and paper-table-report.json, expressed as integer twips.
  const measurements = [
    [8391, 8391], [11906, 11906], [16838, 16838], [12240, 12240], [15840, 15840], [20160, 20160],
    [11880, 11880], [11881, 11906], [11930, 11906], [11931, 11931],
    [8365, 8365], [8366, 8391], [8415, 8391], [8416, 8416],
    [5953, 5940], [6480, 6463], [7920, 7937], [10431, 10440], [17280, 17291],
    [12215, 12200], [15865, 15874],
  ]
  for (const [input, expected] of measurements) {
    assert.equal(normalizePaperDimension(input / 20), expected / 20, `${input} first-open size`)
    assert.equal(normalizePaperDimension(expected / 20), expected / 20, `${input} later-open size`)
  }
})

test('all 30241 supported raw twip sizes either reach a stable in-range size or explicitly reject the 125 native drifts', () => {
  // These eight disjoint groups have separate native first/second-save controls.
  const driftRanges = [[5965, 5977], [6488, 6504], [7896, 7912], [10407, 10415],
    [12936, 12958], [17256, 17266], [18684, 18695], [20185, 20207]]
  let accepted = 0, rejected = 0
  for (let twips = 1440; twips <= 31680; twips++) {
    const drifts = driftRanges.some(([min, max]) => twips >= min && twips <= max)
    if (drifts) {
      assert.throws(() => normalizePaperDimension(twips / 20), /保存重开后无法保持稳定/, `${twips}`)
      rejected++
    } else {
      const normalized = normalizePaperDimension(twips / 20)
      assert.ok(normalized >= 72 && normalized <= 1584, `${twips} remains in range`)
      assert.equal(normalizePaperDimension(normalized), normalized, `${twips} remains stable`)
      accepted++
    }
  }
  assert.equal(accepted, 30116); assert.equal(rejected, 125)
})

test('page edits normalize dimensions without fitting margins and reject native drifts atomically', () => {
  const c = sample(), selected = range(0, 2, 4), before = c.model
  c.setSelection(selected)
  c.formatPage({ width: 11930 / 20 })
  assert.deepEqual(c.model, before); assert.equal(c.canUndo, false); assert.equal(c.revision, 0)
  c.formatPage({ width: 8415 / 20, height: 11930 / 20, marginLeft: 298.25, orientation: 'landscape' })
  assert.deepEqual(c.model.page, { ...before.page, width: 419.55, height: 595.3, marginLeft: 298.25, orientation: 'landscape' })
  assert.deepEqual(c.model.paragraphs, before.paragraphs); assert.deepEqual(c.selection, selected)
  const after = c.model
  c.undo(); assert.deepEqual(c.model, before)
  const revision = c.revision
  for (const twips of [5965, 6488, 7896, 10407, 12936, 17256, 18684, 20185]) {
    for (const dimension of ['width', 'height']) {
      assert.throws(() => c.formatPage({ [dimension]: twips / 20, marginTop: 18, orientation: 'landscape' }), /保存重开后无法保持稳定/)
      assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
      assert.equal(c.revision, revision); assert.equal(c.canRedo, true); assert.equal(c.dirty, false)
    }
  }
  c.redo(); assert.deepEqual(c.model, after)
})

test('page body area is checked in integer twips after standard-paper normalization', () => {
  const c = sample(), before = c.model
  assert.throws(() => c.formatPage({ width: 11930 / 20, marginLeft: 300, marginRight: 295.3 }), /页边距/)
  assert.deepEqual(c.model, before); assert.equal(c.revision, 0)
  c.formatPage({ width: 11881 / 20, marginLeft: 300, marginRight: 295.25 })
  assert.equal(c.model.page.width, 595.3)
  assert.equal(Math.round(c.model.page.width * 20) - Math.round(c.model.page.marginLeft * 20) - Math.round(c.model.page.marginRight * 20), 1)
  c.undo(); assert.deepEqual(c.model, before)
})

test('rejected oversized replacement leaves both document and selection unchanged', () => {
  const c = sample(), before = c.model, cursor = c.selection
  assert.throws(() => c.replaceText(range(0, 1, 2), '\n'.repeat(5001)), /限制/)
  assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, cursor)
  assert.equal(c.canUndo, false)
})

test('cross-paragraph formatting retains empty paragraph insertion attributes', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'a', style: {}, runs: [{ text: 'a', style: {} }] },
    { id: 'empty', style: {}, runs: [{ text: '', style: { bold: true, fontSize: 18 } }] },
    { id: 'b', style: {}, runs: [{ text: 'b', style: {} }] },
  ]
  const c = new WordController(model)
  c.formatText(range(0, 0, 1, 2), { italic: true })
  assert.deepEqual(c.model.paragraphs[1].runs[0].style, { bold: true, italic: true, fontSize: 18 })
})

test('normalization preserves empty paragraphs and soft breaks but compacts adjacent equal runs', () => {
  const input = createWordDocument()
  input.paragraphs[0].runs = [{ text: ' a\t', style: { bold: false } }, { text: 'b\nc ', style: { bold: false } }]
  input.paragraphs.push({ id: 'empty', style: {}, runs: [{ text: '', style: { fontSize: 18 } }] })
  const out = normalizeDocument(input)
  assert.deepEqual(out.paragraphs[0].runs, [{ text: ' a\tb\nc ', style: { bold: false } }])
  assert.equal(out.paragraphs.length, 2)
  assert.equal(out.paragraphs[1].runs[0].style.fontSize, 18)
  assert.equal(documentText(out), ' a\tb\nc \n')
})

function styledHeading(text = '标题') {
  const model = createWordDocument()
  model.paragraphs[0] = {
    id: 'heading', style: { heading: 1, keepNext: true },
    directStyle: {},
    sourceRun: { fontSize: 24, bold: true, fontName: 'Liberation Serif' },
    runs: [{ text, style: { fontSize: 24, bold: true, fontName: 'Liberation Serif' }, directStyle: {} }],
    nextParagraphStyle: {
      paragraph: { heading: 0, keepNext: false, spaceAfter: 8 },
      run: { fontSize: 12, bold: false, fontName: 'Liberation Serif' },
      sourceRun: { fontSize: 24, bold: true, fontName: 'Liberation Serif' },
    },
  }
  return new WordController(model)
}

test('Enter at a heading end uses its next style and preserves only direct character overrides', () => {
  const c = styledHeading()
  c.formatText(range(0, 0, 2), { color: '#ab1234', italic: true, bold: false })
  const before = c.model
  c.replaceText(range(0, 2, 2), '\n')
  const next = c.model.paragraphs[1]
  assert.deepEqual(next.style, { heading: 0, spaceAfter: 8, keepNext: false })
  assert.deepEqual(next.runs, [{ text: '', style: {
    bold: false, italic: true, fontSize: 12, fontName: 'Liberation Serif', color: '#AB1234',
  }, directStyle: { bold: false, italic: true, color: '#AB1234' } }])
  assert.equal(next.nextParagraphStyle, undefined)
  assert.deepEqual(next.sourceRun, { bold: false, fontSize: 12, fontName: 'Liberation Serif' })
  c.replaceText(c.selection, '正文😀')
  assert.equal(c.model.paragraphs[1].runs[0].style.fontSize, 12)
  c.undo(); c.undo()
  assert.deepEqual(c.model, before)
  c.redo()
  assert.equal(c.model.paragraphs[1].runs[0].style.bold, false)
})

test('Enter in the middle retains heading style and follow behavior; empty heading Enter follows', () => {
  const c = styledHeading()
  c.replaceText(range(0, 1, 1), '\n')
  assert.equal(documentText(c.model), '标\n题')
  assert.deepEqual(c.model.paragraphs[1].style, c.model.paragraphs[0].style)
  assert.deepEqual(c.model.paragraphs[1].nextParagraphStyle, c.model.paragraphs[0].nextParagraphStyle)
  assert.deepEqual(c.model.paragraphs[1].sourceRun, c.model.paragraphs[0].sourceRun)
  assert.deepEqual(c.model.paragraphs[1].runs[0].directStyle, {})
  c.replaceText(range(1, 1, 1), '\n')
  assert.equal(c.model.paragraphs[2].runs[0].style.fontSize, 12)
  const empty = styledHeading('')
  empty.replaceText(range(0, 0, 0), '\n')
  assert.equal(empty.model.paragraphs[1].style.heading, 0)
  assert.equal(empty.model.paragraphs[1].runs[0].style.bold, false)
})

test('direct character formatting survives Enter even when equal to the inherited value', () => {
  const c = styledHeading()
  c.formatText(range(0, 0, 2), { fontSize: 24, bold: true })
  c.replaceText(range(0, 2, 2), '\n')
  assert.equal(c.model.paragraphs[1].runs[0].style.fontSize, 24)
  assert.equal(c.model.paragraphs[1].runs[0].style.bold, true)
  const model = createWordDocument()
  model.paragraphs[0].runs = [
    { text: 'a', style: { bold: true }, directStyle: {} },
    { text: 'b', style: { bold: true }, directStyle: { bold: true } },
    { text: 'c', style: { bold: true } },
  ]
  assert.equal(normalizeDocument(model).paragraphs[0].runs.length, 3, 'equal display does not erase format provenance')
})

test('heading Enter keeps direct paragraph alignment and spacing but resets hard keep attributes', () => {
  const c = styledHeading()
  c.formatParagraph(range(0, 0, 0), { align: 'center', spaceAfter: 16, lineHeight: 1.5, lineHeightRule: 'auto', keepNext: true, keepLines: true })
  const before = c.model
  c.replaceText(range(0, 2, 2), '\n')
  assert.deepEqual(c.model.paragraphs[1].style, { align: 'center', heading: 0, spaceAfter: 16, keepNext: false, lineHeight: 1.5, lineHeightRule: 'auto' })
  assert.deepEqual(c.model.paragraphs[1].directStyle, { align: 'center', spaceAfter: 16, lineHeight: 1.5, lineHeightRule: 'auto' })
  c.undo()
  assert.deepEqual(c.model, before)
})

test('Enter resets hard keep attributes to the inherited base at the middle and end', () => {
  for (const inheritedKeep of [true, false]) for (const offset of [0, 2, 4]) {
    const model = createWordDocument()
    const sourceParagraph = { keepNext: inheritedKeep, keepLines: inheritedKeep, indentLeft: 36, indentRight: 18, indentFirstLine: -18 }
    const directStyle = { keepNext: !inheritedKeep, keepLines: !inheritedKeep, indentLeft: 0, align: 'center', spaceAfter: 16 }
    model.paragraphs[0] = { id: 'split', sourceParagraph, directStyle, style: { ...sourceParagraph, ...directStyle }, runs: [{ text: '中文😀', style: {} }] }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, offset, offset), '\n')
    const [first, second] = c.model.paragraphs
    assert.equal(first.style.keepNext, !inheritedKeep)
    assert.equal(first.style.keepLines, !inheritedKeep)
    assert.equal(second.style.keepNext, inheritedKeep)
    assert.equal(second.style.keepLines, inheritedKeep)
    assert.equal(second.directStyle.keepNext, undefined)
    assert.equal(second.directStyle.keepLines, undefined)
    assert.deepEqual(second.sourceParagraph, normalizeDocument(model).paragraphs[0].sourceParagraph)
    assert.equal(second.style.indentLeft, 0, 'explicit zero remains an override')
    assert.equal(second.style.indentFirstLine, -18, 'inherited hanging indent survives')
    assert.equal(second.directStyle.align, 'center')
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.equal(c.model.paragraphs[1].style.keepNext, inheritedKeep)
  }
})

test('following a heading style preserves direct zero indents and replaces inherited indents', () => {
  const c = styledHeading(), model = c.model
  Object.assign(model.paragraphs[0], {
    sourceParagraph: { heading: 1, keepNext: true, indentLeft: 36, indentRight: 18, indentFirstLine: 18 },
    style: { heading: 1, keepNext: true, indentLeft: 0, indentRight: 18, indentFirstLine: 18 },
    directStyle: { indentLeft: 0 },
  })
  Object.assign(model.paragraphs[0].nextParagraphStyle.paragraph, { indentLeft: 72, indentRight: 36, indentFirstLine: -18 })
  c.setDocument(model)
  c.replaceText(range(0, 2, 2), '\n')
  const paragraph = c.model.paragraphs[1]
  assert.equal(paragraph.style.indentLeft, 0)
  assert.equal(paragraph.style.indentRight, 36)
  assert.equal(paragraph.style.indentFirstLine, -18)
  assert.equal(paragraph.sourceParagraph.indentLeft, 72)
  assert.deepEqual(paragraph.directStyle, { indentLeft: 0 })
})

test('indent edits quantize to twips, reject invalid values atomically and preserve untouched selected formats', () => {
  const c = sample()
  c.formatParagraph(range(0, 0, 0, 2), { indentLeft: -12.126, indentRight: 18, indentFirstLine: -18 })
  assert.equal(c.model.paragraphs[0].style.indentLeft, -12.15)
  assert.equal(c.model.paragraphs[0].style.align, 'center')
  assert.equal(c.model.paragraphs[1].style.heading, 2)
  assert.equal(c.model.paragraphs[2].style.indentLeft, undefined)
  const before = c.model, revision = c.revision
  for (const invalid of [NaN, Infinity, '12', -1584.05, 1584.05]) {
    assert.throws(() => c.formatParagraph(range(0, 0, 0), { indentLeft: 20, indentFirstLine: invalid }))
    assert.deepEqual(c.model, before); assert.equal(c.revision, revision)
  }
  c.undo(); assert.deepEqual(c.model, sample().model)
})

test('effective paragraph changes are rebased against the source without flattening other inherited fields', () => {
  const model = createWordDocument()
  Object.assign(model.paragraphs[0], {
    sourceParagraph: { keepNext: true, indentLeft: 36, indentRight: 18, lineHeight: 12, lineHeightRule: 'exact' },
    directStyle: {},
    style: { keepNext: false, indentLeft: 0, indentRight: 18, lineHeight: 1.5, lineHeightRule: 'auto' },
  })
  const normalized = normalizeDocument(model).paragraphs[0]
  assert.deepEqual(normalized.directStyle, { indentLeft: 0, keepNext: false, lineHeight: 1.5, lineHeightRule: 'auto' })
  assert.equal(normalized.sourceParagraph.indentLeft, 36)
  assert.equal(normalized.directStyle.indentRight, undefined)
  assert.deepEqual(normalizeDocument({ ...model, paragraphs: [normalized] }).paragraphs[0], normalized)
  model.paragraphs[0].style = { ...model.paragraphs[0].sourceParagraph, lineHeight: 18 }
  const exact = normalizeDocument(model).paragraphs[0]
  assert.equal(exact.directStyle.lineHeight, 18)
  assert.equal(exact.directStyle.lineHeightRule, 'exact', 'direct line values must retain their effective units on export')
  const legacy = createWordDocument()
  Object.assign(legacy.paragraphs[0], { style: { lineHeight: 12, lineHeightRule: 'exact', keepNext: true }, directStyle: { keepNext: true }, runs: [{ text: 'AB', style: {} }] })
  const c = new WordController(legacy)
  c.formatParagraph(range(0, 0, 0), { lineHeight: 18 })
  c.replaceText(range(0, 1, 1), '\n')
  assert.equal(c.model.paragraphs[1].style.lineHeight, 18)
  assert.equal(c.model.paragraphs[1].style.lineHeightRule, 'exact')
  assert.equal(c.model.paragraphs[1].style.keepNext, undefined)
  for (const lineHeight of [18.025, 400, 928.8]) {
    Object.assign(legacy.paragraphs[0], { style: { lineHeight, lineHeightRule: 'exact' }, directStyle: { lineHeight } })
    const once = normalizeDocument(legacy)
    assert.equal(once.paragraphs[0].directStyle.lineHeight, Math.round(lineHeight * 20) / 20)
    assert.deepEqual(normalizeDocument(once), once, 'exact direct line values use point units on the first normalization')
  }
})

test('value-only paragraph line height edits retain each target rule and commit atomically', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'exact', style: { lineHeight: 18, lineHeightRule: 'exact' }, sourceParagraph: { lineHeight: 18, lineHeightRule: 'exact' }, directStyle: {}, runs: [{ text: 'EXACT', style: {} }] },
    { id: 'minimum', style: { lineHeight: 24, lineHeightRule: 'atLeast' }, directStyle: {}, runs: [{ text: 'MINIMUM', style: {} }] },
    { id: 'multiple', style: { lineHeight: 1.5, lineHeightRule: 'auto' }, runs: [{ text: 'MULTIPLE', style: {} }] },
  ]
  const c = new WordController(model), before = c.model
  c.formatParagraph(range(0, 0, 0, 2), { lineHeight: 400.025 })
  for (const [index, rule] of ['exact', 'atLeast'].entries()) {
    assert.deepEqual(c.model.paragraphs[index].style, { lineHeight: 400.05, lineHeightRule: rule })
    assert.deepEqual(c.model.paragraphs[index].directStyle, { lineHeight: 400.05, lineHeightRule: rule })
  }
  assert.deepEqual(c.model.paragraphs[0].sourceParagraph, before.paragraphs[0].sourceParagraph)
  assert.deepEqual(c.model.paragraphs[2], before.paragraphs[2], 'an end boundary at offset zero excludes the auto paragraph')
  c.undo(); assert.deepEqual(c.model, before)
  c.redo()
  const formatted = c.model, revision = c.revision
  for (const invalid of [400, NaN, Infinity, -1, 1584.05, '12']) {
    assert.throws(() => c.formatParagraph(range(0, 0, 1, 2), { lineHeight: invalid, spaceBefore: 12 }))
    assert.deepEqual(c.model, formatted); assert.equal(c.revision, revision)
  }
  c.undo(); assert.deepEqual(c.model, before, 'failed edits do not create history entries')
})

test('line height patches use point rounding independently of multiple rounding', () => {
  for (const rule of ['exact', 'atLeast']) {
    const model = createWordDocument()
    model.paragraphs[0].style = { lineHeight: 18, lineHeightRule: rule }
    const c = new WordController(model)
    c.formatParagraph(range(0, 0, 0), { lineHeight: 18.025 })
    assert.deepEqual(c.model.paragraphs[0].style, { lineHeight: 18.05, lineHeightRule: rule })
    c.formatParagraph(range(0, 0, 0), { lineHeight: 928.8 })
    assert.equal(c.model.paragraphs[0].style.lineHeight, 928.8)
    c.formatParagraph(range(0, 0, 0), { lineHeight: 0.05 })
    assert.equal(c.model.paragraphs[0].style.lineHeight, 0.05)
  }
})

test('paragraph spacing preserves independent zeros, provenance, Enter and history', () => {
  const model = createWordDocument()
  const sourceParagraph = { spaceBefore: 6, spaceAfter: 12, lineHeight: 24, lineHeightRule: 'exact' }
  Object.assign(model.paragraphs[0], {
    style: { ...sourceParagraph, lineHeight: 18 }, sourceParagraph, directStyle: { lineHeight: 18 },
    nextParagraphStyle: { paragraph: { spaceBefore: 3, spaceAfter: 5, lineHeight: 1.5, lineHeightRule: 'auto' }, run: {} },
    runs: [{ text: 'ABC', style: {} }],
  })
  const c = new WordController(model), before = c.model
  c.formatParagraph(range(0, 1, 1), { spaceAfter: 0 })
  assert.deepEqual(c.model.paragraphs[0].directStyle, { spaceAfter: 0, lineHeight: 18, lineHeightRule: 'exact' })
  assert.equal(c.model.paragraphs[0].style.spaceBefore, 6)
  assert.deepEqual(c.model.paragraphs[0].sourceParagraph, before.paragraphs[0].sourceParagraph)
  c.replaceText(range(0, 3, 3), '\n')
  assert.deepEqual(c.model.paragraphs[1].style, { spaceBefore: 3, spaceAfter: 0, lineHeight: 18, lineHeightRule: 'exact' })
  assert.deepEqual(c.model.paragraphs[1].directStyle, { spaceAfter: 0, lineHeight: 18, lineHeightRule: 'exact' })
  c.undo(); c.undo(); assert.deepEqual(c.model, before)
  c.redo(); c.redo(); assert.equal(c.model.paragraphs[1].style.spaceAfter, 0)
})

test('paragraph spacing limits keep all supported integer percentages and reject unsafe native boundaries atomically', () => {
  assert.deepEqual(PARAGRAPH_SPACING_LIMITS, { min: 0, max: 1584, step: 0.05 })
  assert.deepEqual(POINT_LINE_HEIGHT_LIMITS, { min: 0.05, max: 928.8, step: 0.05 })
  assert.deepEqual(AUTO_LINE_HEIGHT_LIMITS, { min: 0.01, max: 3.33, step: 0.01 })
  const model = createWordDocument()
  for (let percent = 1; percent <= 333; percent++) {
    model.paragraphs[0].style = { lineHeight: percent / 100, lineHeightRule: 'auto' }
    assert.deepEqual(normalizeDocument(model).paragraphs[0].style, model.paragraphs[0].style)
  }
  const c = new WordController(model), before = c.model
  for (const patch of [
    { lineHeight: 3.34, lineHeightRule: 'auto' },
    { lineHeight: 0, lineHeightRule: 'auto' },
    { lineHeight: 0.009, lineHeightRule: 'auto' },
    { lineHeight: 928.85, lineHeightRule: 'exact' },
    { lineHeight: 1584, lineHeightRule: 'atLeast' },
    { lineHeight: 0, lineHeightRule: 'exact' },
    { spaceBefore: -0.05 }, { spaceAfter: 1584.05 },
  ]) {
    assert.throws(() => c.formatParagraph(range(0, 0, 0), patch))
    assert.deepEqual(c.model, before); assert.equal(c.revision, 0); assert.equal(c.canUndo, false)
  }
  c.formatParagraph(range(0, 0, 0), { spaceBefore: 1584, spaceAfter: 0, lineHeight: 1.156, lineHeightRule: 'auto' })
  assert.deepEqual(c.model.paragraphs[0].style, { spaceBefore: 1584, spaceAfter: 0, lineHeight: 1.16, lineHeightRule: 'auto' })
})

test('removing an empty leading paragraph keeps the following paragraph spacing and style provenance', () => {
  const model = createWordDocument()
  const firstParagraph = { spaceBefore: 6, spaceAfter: 12, lineHeight: 18, lineHeightRule: 'exact' }
  const secondParagraph = { spaceBefore: 8, spaceAfter: 4, lineHeight: 2, lineHeightRule: 'auto' }
  model.paragraphs = [
    { id: 'empty', style: firstParagraph, sourceParagraph: firstParagraph, directStyle: {}, sourceRun: { fontSize: 18 }, runs: [{ text: '', style: { fontSize: 18 }, directStyle: {} }] },
    { id: 'body', style: secondParagraph, sourceParagraph: { ...secondParagraph, spaceAfter: 9 }, directStyle: { spaceAfter: 4 },
      sourceRun: { fontSize: 12 }, runs: [{ text: 'XYZ', style: { fontSize: 12 }, directStyle: {} }],
      marker: { style: { fontSize: 12, italic: true }, directStyle: { italic: true } },
      nextParagraphStyle: { paragraph: { spaceAfter: 5 }, run: { fontSize: 16 } } },
  ]
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 0, 0, 1), '')
  const { id: _beforeId, ...expected } = before.paragraphs[1]
  const { id: _afterId, ...actual } = c.model.paragraphs[0]
  assert.deepEqual(actual, expected)
  assert.equal(documentText(c.model), 'XYZ')
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.deepEqual(c.model.paragraphs[0].style, secondParagraph)
})

test('LibreOffice font, language, paragraph and package properties survive edit and history', () => {
  const model = createWordDocument()
  model.defaultTabStop = 56.7
  model.autoHyphenation = true
  model.packageMetadata = { coreProperties: '<properties>属性</properties>', fontTable: '<fonts>خط</fonts>' }
  model.paragraphs[0].style = { lineHeight: 1.25, lineHeightRule: 'auto', keepNext: false, keepLines: true, widowControl: true, suppressAutoHyphens: true }
  model.paragraphs[0].runs = [{ text: '中文 Latin 😀', style: {
    fontName: 'Liberation Serif', fontNameEastAsia: 'DejaVu Sans', fontNameCs: 'Noto Sans',
    language: 'en-US', languageEastAsia: 'zh-CN', languageBidi: 'hi-IN', fontSizeCs: 12, kerning: 0,
  }, directStyle: {} }]
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 2, 2), '追加')
  assert.deepEqual(c.model.packageMetadata, before.packageMetadata)
  assert.deepEqual(c.model.paragraphs[0].runs[0].style, before.paragraphs[0].runs[0].style)
  assert.equal(c.model.defaultTabStop, 56.7)
  assert.equal(c.model.autoHyphenation, true)
  c.undo()
  assert.deepEqual(c.model, before)
  c.redo()
  assert.equal(c.model.paragraphs[0].style.suppressAutoHyphens, true)
})

test('unsupported scripts and invalid added properties reject atomically', () => {
  const c = styledHeading(), before = c.model
  for (const work of [
    () => c.replaceText(range(0, 1, 1), 'العربية'),
    () => c.replaceText(range(0, 1, 1), '\u202eabc'),
    () => c.formatText(range(0, 0, 1), { language: 'invalid lang' }),
    () => c.formatParagraph(range(0, 0, 0), { lineHeightRule: 'exact' }),
    () => c.formatParagraph(range(0, 0, 0), { lineHeight: 132.01, lineHeightRule: 'auto' }),
    () => c.setDocument({ ...c.model, defaultTabStop: 0 }),
    () => c.setDocument({ ...c.model, autoHyphenation: 'true' }),
    () => c.setDocument({ ...c.model, packageMetadata: { unknown: '<x/>' } }),
  ]) assert.throws(work)
  assert.deepEqual(c.model, before)
  assert.equal(c.revision, 0)
  assert.equal(c.canUndo, false)
})

test('merging paragraphs rebases only changed inherited run formatting and survives history', () => {
  const model = createWordDocument()
  const first = { fontName: 'Arial', fontSize: 16, bold: true, italic: true, underline: true, color: '#AA0000', kerning: 10 }
  const second = { fontName: 'Liberation Serif', fontSize: 12, color: '#000000' }
  model.paragraphs = [
    { id: 'first', style: {}, sourceRun: first, runs: [{ text: 'first', style: first, directStyle: {} }] },
    { id: 'second', style: {}, sourceRun: second, runs: [{ text: 'second', style: second, directStyle: { fontSize: 12 } }] },
  ]
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 5, 0, 1), '')
  assert.equal(documentText(c.model), 'firstsecond')
  assert.deepEqual(c.model.paragraphs[0].runs[0].directStyle, {})
  const moved = c.model.paragraphs[0].runs[1]
  assert.equal(moved.style.fontName, 'Liberation Serif')
  assert.equal(moved.style.fontSize, 12)
  assert.deepEqual(moved.directStyle, {
    bold: false, italic: false, underline: false, fontSize: 12,
    fontName: 'Liberation Serif', fontNameEastAsia: 'Liberation Serif', fontNameCs: 'Liberation Serif',
    color: '#000000', kerning: 0,
  })
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[1].style.bold, false)
  // A browser DOM merge enters through setDocument rather than replaceText.
  const raw = structuredClone(before)
  raw.paragraphs[0].runs.push(...raw.paragraphs.pop().runs)
  const dom = new WordController(before); dom.setDocument(raw)
  assert.deepEqual(dom.model.paragraphs[0].runs, c.model.paragraphs[0].runs)
})

test('an unrepresentable inherited language removal rejects a paragraph merge atomically', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'a', style: {}, sourceRun: { language: 'en-US' }, runs: [{ text: 'a', style: { language: 'en-US' }, directStyle: {} }] },
    { id: 'b', style: {}, sourceRun: {}, runs: [{ text: 'b', style: {}, directStyle: {} }] },
  ]
  const c = new WordController(model), before = c.model, selected = c.selection
  assert.throws(() => c.replaceText(range(0, 1, 0, 1), ''), /语言/)
  assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selected)
  assert.equal(c.canUndo, false)
  assert.equal(c.revision, 0)
})

test('the smallest positive OOXML kerning threshold stays explicit and undoable', () => {
  const c = sample(), before = c.model
  c.formatText(range(0, 0, 1), { kerning: 0.5 })
  assert.equal(c.model.paragraphs[0].runs[0].style.kerning, 0.5)
  assert.equal(c.canUndo, true)
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[0].style.kerning, 0.5)
})

test('script and strike edits retain logical size, partial runs and history', () => {
  const model = createWordDocument()
  model.paragraphs[0].runs = [{ text: 'A中文😀Z', style: { underline: true, fontSize: 18.5 } }]
  const c = new WordController(model), before = c.model, selected = range(0, 1, 5)
  c.formatText(selected, { verticalAlign: 'superscript', strike: 'double' })
  assert.deepEqual(c.model.paragraphs[0].runs, [
    { text: 'A', style: { underline: true, fontSize: 18.5 } },
    { text: '中文😀', style: { underline: true, strike: 'double', verticalAlign: 'superscript', fontSize: 18.5 } },
    { text: 'Z', style: { underline: true, fontSize: 18.5 } },
  ])
  c.formatText(selected, { verticalAlign: 'subscript', strike: 'single' })
  assert.equal(c.model.paragraphs[0].runs[1].style.fontSize, 18.5)
  c.formatText(selected, { verticalAlign: 'baseline', strike: 'none' })
  assert.deepEqual(c.model.paragraphs[0].runs[1].style, { underline: true, strike: 'none', verticalAlign: 'baseline', fontSize: 18.5 })
  c.undo(); assert.equal(c.model.paragraphs[0].runs[1].style.verticalAlign, 'subscript')
  c.undo(); assert.equal(c.model.paragraphs[0].runs[1].style.strike, 'double')
  c.undo(); assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selected)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[1].style.fontSize, 18.5)
})

test('plain runs moved under inherited scripts and strike receive explicit baseline and none overrides', () => {
  const model = createWordDocument(), scripted = { verticalAlign: 'superscript', strike: 'double', fontSize: 24 }
  model.paragraphs = [
    { id: 'script', style: {}, sourceRun: scripted, runs: [{ text: '上', style: scripted, directStyle: {} }] },
    { id: 'plain', style: {}, sourceRun: { fontSize: 24 }, runs: [{ text: '普通', style: { fontSize: 24 }, directStyle: {} }] },
  ]
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 1, 0, 1), '')
  assert.deepEqual(c.model.paragraphs[0].runs[0].directStyle, {})
  assert.deepEqual(c.model.paragraphs[0].runs[1], {
    text: '普通', style: { strike: 'none', verticalAlign: 'baseline', fontSize: 24 },
    directStyle: { strike: 'none', verticalAlign: 'baseline' },
  })
  assert.deepEqual(normalizeDocument(c.model), c.model)
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[1].style.fontSize, 24)
  // DOM paragraph joins use setDocument; they must retain the same explicit resets.
  const joined = structuredClone(before)
  joined.paragraphs[0].runs.push(...joined.paragraphs.pop().runs)
  const dom = new WordController(before); dom.setDocument(joined)
  assert.deepEqual(dom.model.paragraphs[0].runs, c.model.paragraphs[0].runs)
})

test('end Enter follows inherited script styles and removes hard script while retaining strike resets', () => {
  for (const direct of [{}, { verticalAlign: 'baseline', strike: 'none' }, { verticalAlign: 'subscript', strike: 'single' }]) {
    const model = createWordDocument()
    const source = { verticalAlign: 'superscript', strike: 'double', fontSize: 24 }
    const follow = { verticalAlign: 'subscript', strike: 'single', fontSize: 12 }
    model.paragraphs[0] = {
      id: 'heading', style: { heading: 1 }, sourceRun: source,
      runs: [{ text: '标题', style: { ...source, ...direct }, directStyle: direct }],
      nextParagraphStyle: { paragraph: {}, run: follow, sourceRun: source },
    }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 2, 2), '\n')
    const run = c.model.paragraphs[1].runs[0]
    assert.equal(run.text, '')
    assert.deepEqual(run.style, { strike: direct.strike ?? 'single', verticalAlign: 'subscript', fontSize: 12 })
    const remainingDirect = { ...direct }; delete remainingDirect.verticalAlign
    assert.deepEqual(run.directStyle, remainingDirect)
    c.replaceText(c.selection, '正文😀')
    assert.equal(c.model.paragraphs[1].runs[0].style.fontSize, 12)
    assert.equal(c.model.paragraphs[1].runs[0].style.strike, direct.strike ?? 'single')
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('end Enter resets hard scripts to the current paragraph base while middle splits retain them', () => {
  for (const inherited of [undefined, 'superscript', 'subscript', 'baseline']) {
    for (const direct of ['superscript', 'subscript', 'baseline']) {
      for (const offset of [0, 1, 2]) {
        const model = createWordDocument(), sourceRun = inherited === undefined ? {} : { verticalAlign: inherited }
        model.paragraphs[0] = { id: 'script', style: {}, sourceRun, runs: [{ text: 'ab', style: { verticalAlign: direct, strike: 'double', fontSize: 18 }, directStyle: { verticalAlign: direct, strike: 'double', fontSize: 18 } }] }
        const c = new WordController(model), before = c.model
        c.replaceText(range(0, offset, offset), '\n')
        const successor = c.model.paragraphs[1].runs[0]
        assert.equal(successor.style.verticalAlign, offset === 2 ? inherited : direct)
        assert.equal(successor.directStyle.verticalAlign, offset === 2 ? undefined : direct)
        assert.equal(successor.style.fontSize, 18)
        assert.equal(successor.style.strike, 'double')
        c.undo(); assert.deepEqual(c.model, before)
        c.redo(); assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, offset === 2 ? inherited : direct)
      }
    }
  }
  for (const text of ['', 'legacy']) {
    const model = createWordDocument()
    model.paragraphs[0].runs = [{ text, style: { verticalAlign: 'superscript', strike: 'single', fontSize: 12 } }]
    const c = new WordController(model)
    c.replaceText(range(0, text.length, text.length), '\n')
    assert.deepEqual(c.model.paragraphs[1].runs[0].style, { strike: 'single', fontSize: 12 })
  }
})

test('cross-paragraph script formatting preserves empty insertion properties without visual-size mutation', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'a', style: {}, runs: [{ text: 'A', style: { fontSize: 1 } }] },
    { id: 'empty', style: {}, sourceRun: { fontSize: 400 }, runs: [{ text: '', style: { fontSize: 400 }, directStyle: {} }] },
    { id: 'b', style: {}, runs: [{ text: 'B', style: { fontSize: 12.5 } }] },
  ]
  const c = new WordController(model)
  c.formatText(range(0, 0, 1, 2), { verticalAlign: 'superscript', strike: 'double' })
  assert.deepEqual(c.model.paragraphs.map(p => p.runs[0].style.fontSize), [1, 400, 12.5])
  assert.deepEqual(c.model.paragraphs[1].runs[0].directStyle, { strike: 'double', verticalAlign: 'superscript' })
  c.replaceText(range(1, 0, 0), '空段输入')
  assert.equal(c.model.paragraphs[1].runs[0].style.fontSize, 400)
  assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, 'superscript')
})

test('invalid script and strike values reject atomically in all character style layers', () => {
  const c = sample(), before = c.model, selection = c.selection
  for (const [property, invalids] of [
    ['verticalAlign', ['super', 'sub', 'BASELINE', '', null, 0.5, true, {}, []]],
    ['strike', ['solid', 'false', '', null, 0, false, {}, []]],
  ]) for (const invalid of invalids) {
    assert.throws(() => c.formatText(range(0, 0, 1), { bold: false, [property]: invalid }))
    for (const layer of ['style', 'directStyle', 'sourceRun', 'nextParagraphStyle']) {
      const modified = structuredClone(before), paragraph = modified.paragraphs[0]
      if (layer === 'style' || layer === 'directStyle') paragraph.runs[0][layer] = { [property]: invalid }
      else if (layer === 'sourceRun') paragraph.sourceRun = { [property]: invalid }
      else paragraph.nextParagraphStyle = { paragraph: {}, run: { [property]: invalid } }
      assert.throws(() => c.setDocument(modified))
    }
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selection)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('named character scripts survive end Enter after hard escapement resets, including heading follow styles', () => {
  for (const sourceVerticalAlign of ['superscript', 'subscript', 'baseline']) {
    for (const direct of [undefined, 'baseline', 'subscript', 'superscript']) {
      for (const following of [false, true]) {
        const model = createWordDocument()
        const sourceRun = { verticalAlign: 'superscript', fontSize: 24 }
        const directStyle = { strike: 'double', ...(direct !== undefined ? { verticalAlign: direct } : {}) }
        model.paragraphs[0] = {
          id: 'named-character', style: {}, sourceRun,
          runs: [{ text: '字符', style: { ...sourceRun, verticalAlign: sourceVerticalAlign, ...directStyle }, directStyle, sourceVerticalAlign }],
          ...(following ? { nextParagraphStyle: { paragraph: {}, run: { verticalAlign: 'subscript', fontSize: 12 } } } : {}),
        }
        const c = new WordController(model), before = c.model
        c.replaceText(range(0, 2, 2), '\n')
        const inserted = c.model.paragraphs[1].runs[0]
        assert.equal(inserted.sourceVerticalAlign, sourceVerticalAlign)
        assert.equal(inserted.style.verticalAlign, sourceVerticalAlign)
        assert.equal(inserted.directStyle.verticalAlign, undefined)
        assert.equal(inserted.style.fontSize, following ? 12 : 24)
        assert.equal(inserted.style.strike, 'double')
        c.replaceText(c.selection, '继承')
        assert.equal(c.model.paragraphs[1].runs[0].sourceVerticalAlign, sourceVerticalAlign)
        assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, sourceVerticalAlign)
        c.undo(); c.undo(); assert.deepEqual(c.model, before)
        c.redo(); assert.equal(c.model.paragraphs[1].runs[0].sourceVerticalAlign, sourceVerticalAlign)
      }
    }
  }
})

test('equal-looking runs keep distinct character script sources through edits, splits and merges', () => {
  const model = createWordDocument()
  model.paragraphs[0] = {
    id: 'sources', style: {}, sourceRun: { fontSize: 12 },
    runs: ['superscript', 'subscript', 'baseline'].map((sourceVerticalAlign, index) => ({
      text: ['AB', 'CD', 'EF'][index], sourceVerticalAlign,
      style: { fontSize: 12, verticalAlign: 'baseline' }, directStyle: { verticalAlign: 'baseline' },
    })),
  }
  const c = new WordController(model)
  assert.equal(c.model.paragraphs[0].runs.length, 3, 'equal direct/effective style cannot erase named sources')
  c.formatText(range(0, 1, 5), { strike: 'single' })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.sourceVerticalAlign]), [
    ['A', 'superscript'], ['B', 'superscript'], ['CD', 'subscript'], ['E', 'baseline'], ['F', 'baseline'],
  ])
  c.replaceText(range(0, 3, 3), 'X\nY')
  assert.equal(c.model.paragraphs[1].runs[0].sourceVerticalAlign, 'subscript')
  assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, 'baseline', 'multi-line paste retains hard override')
  c.replaceText(range(0, 4, 0, 1), '')
  assert.equal(documentText(c.model), 'ABCXYDEF')
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => run.sourceVerticalAlign), ['superscript', 'superscript', 'subscript', 'baseline', 'baseline'])
  const before = c.model
  c.replaceText(range(0, 3, 3), '\n')
  assert.equal(c.model.paragraphs[1].runs[0].sourceVerticalAlign, 'subscript')
  assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, 'baseline', 'middle split keeps hard baseline')
  c.undo(); assert.deepEqual(c.model, before)
})

test('character script source validates atomically and takes priority over paragraph script during normalization', () => {
  const c = sample(), before = c.model
  for (const sourceVerticalAlign of [null, true, 1, '', 'super', {}, []]) {
    const malformed = structuredClone(before)
    malformed.paragraphs[0].runs[0].sourceVerticalAlign = sourceVerticalAlign
    assert.throws(() => c.setDocument(malformed), /上下标/)
    assert.deepEqual(c.model, before)
    assert.equal(c.canUndo, false)
  }
  const model = createWordDocument()
  model.paragraphs[0] = {
    id: 'source', style: {}, sourceRun: { verticalAlign: 'superscript', fontSize: 12 },
    runs: [{ text: 'baseline', sourceVerticalAlign: 'baseline', style: { verticalAlign: 'baseline', fontSize: 12 }, directStyle: {} }],
  }
  const normalized = normalizeDocument(model)
  assert.deepEqual(normalized.paragraphs[0].runs[0].directStyle, {})
  assert.deepEqual(normalizeDocument(normalized), normalized)
  const moved = structuredClone(normalized)
  moved.paragraphs[0].sourceRun.verticalAlign = 'subscript'
  assert.equal(normalizeDocument(moved).paragraphs[0].runs[0].style.verticalAlign, 'baseline')
  assert.deepEqual(normalizeDocument(moved).paragraphs[0].runs[0].directStyle, {})
})

test('the highlight palette preserves all standard colors and distinguishes CSS names from OOXML names', () => {
  assert.equal(HIGHLIGHT_COLORS.length, 17)
  assert.equal(new Set(HIGHLIGHT_COLORS.map(color => color.value)).size, 17)
  assert.equal(new Set(HIGHLIGHT_COLORS.filter(color => color.hex).map(color => color.hex)).size, 16)
  for (const color of HIGHLIGHT_COLORS) {
    assert.equal(isHighlightColor(color.value), true)
    if (!color.hex) { assert.equal(color.value, 'none'); continue }
    assert.equal(highlightFromCss(color.hex), color.value)
    const channels = color.hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16))
    assert.equal(highlightFromCss(`rgb(${channels.join(', ')})`), color.value)
    assert.equal(highlightFromCss(`rgb(${channels.join(' ')})`), color.value)
    assert.equal(highlightFromCss(`rgba(${channels.join(', ')}, 1)`), color.value)
  }
  assert.equal(highlightFromCss('green'), 'darkGreen', 'CSS green is #008000; OOXML green is #00FF00')
  assert.equal(highlightFromCss('lime'), 'green')
  assert.equal(highlightFromCss('navy'), 'darkBlue')
  assert.equal(highlightFromCss('#fff'), 'white', 'white is a real paint, not a cleared highlight')
  assert.equal(highlightFromCss('transparent'), undefined)
  assert.equal(highlightFromCss('rgba(255, 255, 0, 0)'), undefined, 'transparent child spans reveal their inherited highlight')
  assert.equal(highlightFromCss(''), undefined, 'an unstyled regional font span must not clear highlight')
  for (const invalid of ['#123456', 'rgb(255, 10, 0)', 'rgba(255, 255, 0, .5)', 'rgb(256, 255, 0)', 'darkBlue', 'inherit']) assert.throws(() => highlightFromCss(invalid))
})

test('highlight edits affect only the selected characters and explicit none remains distinct from white', () => {
  const model = createWordDocument()
  model.paragraphs[0].runs = [{ text: 'A中文😀Z', style: { fontSize: 18, verticalAlign: 'subscript', strike: 'double', underline: true } }]
  const c = new WordController(model), before = c.model, selected = range(0, 1, 5)
  for (const highlight of ['yellow', 'white', 'none']) {
    c.formatText(selected, { highlight })
    assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.highlight]), [['A', undefined], ['中文😀', highlight], ['Z', undefined]])
    const formatted = c.model.paragraphs[0].runs[1].style
    assert.equal(formatted.fontSize, 18)
    assert.equal(formatted.verticalAlign, 'subscript')
    assert.equal(formatted.strike, 'double')
    assert.equal(formatted.underline, true)
  }
  c.undo(); assert.equal(c.model.paragraphs[0].runs[1].style.highlight, 'white')
  c.undo(); assert.equal(c.model.paragraphs[0].runs[1].style.highlight, 'yellow')
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.deepEqual(c.selection, selected)
})

test('plain text merged into a highlighted paragraph receives a semantic none override', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'highlighted', style: {}, sourceRun: { highlight: 'yellow' }, runs: [{ text: '黄', style: { highlight: 'yellow' }, directStyle: {} }] },
    { id: 'plain', style: {}, sourceRun: {}, runs: [{ text: '无', style: {}, directStyle: {} }] },
    { id: 'white', style: {}, sourceRun: { highlight: 'white' }, runs: [{ text: '白', style: { highlight: 'white' }, directStyle: {} }] },
  ]
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 1, 0, 1), '')
  assert.deepEqual(c.model.paragraphs[0].runs[1], { text: '无', style: { highlight: 'none' }, directStyle: { highlight: 'none' } })
  c.replaceText(range(0, 2, 0, 1), '')
  assert.deepEqual(c.model.paragraphs[0].runs[2], { text: '白', style: { highlight: 'white' }, directStyle: { highlight: 'white' } })
  assert.deepEqual(normalizeDocument(c.model), c.model)
  c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('highlight persists on Enter while following inherited styles and preserving explicit clear', () => {
  for (const direct of [undefined, 'red', 'white', 'none']) for (const follow of [false, true]) {
    const model = createWordDocument()
    const sourceRun = { highlight: 'yellow', fontSize: 24 }
    const directStyle = { verticalAlign: 'superscript', ...(direct !== undefined ? { highlight: direct } : {}) }
    model.paragraphs[0] = {
      id: 'highlight', style: {}, sourceRun,
      runs: [{ text: 'ab', style: { ...sourceRun, ...directStyle }, directStyle }],
      ...(follow ? { nextParagraphStyle: { paragraph: {}, run: { highlight: 'cyan', fontSize: 12 } } } : {}),
    }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 2, 2), '\n')
    const inserted = c.model.paragraphs[1].runs[0]
    assert.equal(inserted.style.highlight, direct ?? (follow ? 'cyan' : 'yellow'))
    assert.equal(inserted.directStyle.highlight, direct)
    assert.equal(inserted.style.verticalAlign, undefined, 'only hard escapement resets on end Enter')
    c.replaceText(c.selection, '新字')
    assert.equal(c.model.paragraphs[1].runs[0].style.highlight, direct ?? (follow ? 'cyan' : 'yellow'))
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('invalid highlight values cannot partly update any character style layer', () => {
  const c = sample(), before = c.model, selection = c.selection
  for (const highlight of ['Yellow', 'transparent', '#FFFF00', 'darkblue', '', 1, true, null, [], {}]) {
    assert.equal(isHighlightColor(highlight), false)
    assert.throws(() => c.formatText(range(0, 0, 1), { bold: false, highlight }), /高亮/)
    for (const layer of ['style', 'directStyle', 'sourceRun', 'nextParagraphStyle']) {
      const malformed = structuredClone(before), paragraph = malformed.paragraphs[0]
      if (layer === 'style' || layer === 'directStyle') paragraph.runs[0][layer] = { highlight }
      else if (layer === 'sourceRun') paragraph.sourceRun = { highlight }
      else paragraph.nextParagraphStyle = { paragraph: {}, run: { highlight } }
      assert.throws(() => c.setDocument(malformed), /高亮/)
    }
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selection)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('background colors retain arbitrary opaque RGB and compose below highlight without changing either layer', () => {
  assert.equal(normalizeBackgroundColor('#12AbEf'), '#12ABEF')
  assert.equal(normalizeBackgroundColor('none'), 'none')
  for (const color of ['#000000', '#FFFFFF', '#FFFF00', '#123456', '#AB12EF']) {
    assert.equal(backgroundFromCss(color), color)
    const rgb = color.slice(1).match(/../g).map(component => Number.parseInt(component, 16))
    assert.equal(backgroundFromCss(`rgb(${rgb.join(', ')})`), color)
    assert.equal(backgroundFromCss(`rgb(${rgb.join(' ')})`), color)
    assert.equal(backgroundFromCss(`rgba(${rgb.join(', ')}, 1)`), color)
  }
  assert.equal(backgroundFromCss('yellow'), '#FFFF00', 'unmarked CSS yellow is shading, not an invented highlight')
  assert.equal(backgroundFromCss('green'), '#008000')
  assert.equal(backgroundFromCss('#a2f'), '#AA22FF')
  assert.equal(backgroundFromCss('transparent'), undefined)
  assert.equal(backgroundFromCss('rgba(17, 34, 51, 0)'), undefined)
  for (const invalid of ['#12345', 'rgb(256, 0, 0)', 'rgba(17, 34, 51, .5)', 'inherit']) assert.throws(() => backgroundFromCss(invalid))
  const layered = { highlight: 'yellow', backgroundColor: '#123456' }
  assert.equal(textBackgroundColor(layered), '#FFFF00')
  assert.deepEqual(layered, { highlight: 'yellow', backgroundColor: '#123456' })
  assert.equal(textBackgroundColor({ ...layered, highlight: 'none' }), '#123456')
  assert.equal(textBackgroundColor({ highlight: 'yellow', backgroundColor: 'none' }), '#FFFF00')
  assert.equal(textBackgroundColor({ highlight: 'none', backgroundColor: 'none' }), undefined)
  assert.equal(textBackgroundColor({ backgroundColor: '#FFFFFF' }), '#FFFFFF')
})

test('background editing and clearing retain highlight, script and decoration through partial edits and history', () => {
  const model = createWordDocument()
  model.paragraphs[0].runs = [{ text: 'A中文😀Z', style: { highlight: 'yellow', fontSize: 36, verticalAlign: 'superscript', strike: 'double', underline: true } }]
  const c = new WordController(model), before = c.model, selected = range(0, 1, 5)
  c.formatText(selected, { backgroundColor: '#ab12ef' })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.backgroundColor]), [['A', undefined], ['中文😀', '#AB12EF'], ['Z', undefined]])
  let style = c.model.paragraphs[0].runs[1].style
  assert.equal(textBackgroundColor(style), '#FFFF00')
  c.formatText(selected, { highlight: 'none' })
  style = c.model.paragraphs[0].runs[1].style
  assert.equal(textBackgroundColor(style), '#AB12EF')
  assert.equal(style.fontSize, 36)
  assert.equal(style.verticalAlign, 'superscript')
  assert.equal(style.strike, 'double')
  assert.equal(style.underline, true)
  c.formatText(selected, { backgroundColor: 'none' })
  assert.equal(textBackgroundColor(c.model.paragraphs[0].runs[1].style), undefined)
  c.undo(); assert.equal(c.model.paragraphs[0].runs[1].style.backgroundColor, '#AB12EF')
  c.undo(); assert.equal(c.model.paragraphs[0].runs[1].style.highlight, 'yellow')
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.deepEqual(c.selection, selected)
})

test('merging paragraphs preserves independent shading and highlight inheritance without flattening shared layers', () => {
  const model = createWordDocument(), first = { highlight: 'yellow', backgroundColor: '#123456' }
  const second = { highlight: 'yellow', backgroundColor: '#ABCDEF' }
  model.paragraphs = [
    { id: 'first', style: {}, sourceRun: first, runs: [{ text: '甲', style: first, directStyle: {} }] },
    { id: 'second', style: {}, sourceRun: second, runs: [{ text: '乙', style: second, directStyle: {} }] },
    { id: 'plain', style: {}, sourceRun: {}, runs: [{ text: '丙', style: {}, directStyle: {} }] },
  ]
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 1, 0, 1), '')
  assert.deepEqual(c.model.paragraphs[0].runs[1].directStyle, { backgroundColor: '#ABCDEF' })
  assert.equal(c.model.paragraphs[0].runs[1].style.highlight, 'yellow')
  c.replaceText(range(0, 2, 0, 1), '')
  assert.deepEqual(c.model.paragraphs[0].runs[2].directStyle, { highlight: 'none', backgroundColor: 'none' })
  assert.equal(textBackgroundColor(c.model.paragraphs[0].runs[2].style), undefined)
  assert.deepEqual(normalizeDocument(c.model), c.model)
  c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('background follows paragraph inheritance on Enter while direct RGB and none persist', () => {
  for (const direct of [undefined, '#12ABEF', '#FFFFFF', 'none']) for (const offset of [1, 2]) {
    const model = createWordDocument(), sourceRun = { highlight: 'yellow', backgroundColor: '#123456', fontSize: 24 }
    const directStyle = { verticalAlign: 'superscript', ...(direct !== undefined ? { backgroundColor: direct } : {}) }
    model.paragraphs[0] = {
      id: 'shading', style: {}, sourceRun,
      runs: [{ text: 'ab', style: { ...sourceRun, ...directStyle }, directStyle }],
      nextParagraphStyle: { paragraph: {}, run: { highlight: 'none', backgroundColor: '#ABCDEF', fontSize: 12 } },
    }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, offset, offset), '\n')
    const inserted = c.model.paragraphs[1].runs[0]
    assert.equal(inserted.style.backgroundColor, direct ?? (offset === 2 ? '#ABCDEF' : '#123456'))
    assert.equal(inserted.directStyle.backgroundColor, direct)
    assert.equal(inserted.style.highlight, offset === 2 ? 'none' : 'yellow')
    assert.equal(inserted.style.verticalAlign, offset === 2 ? undefined : 'superscript')
    c.undo(); assert.deepEqual(c.model, before)
  }
})

test('whole-selection replacement and deletion retain both paint layers and named script provenance', () => {
  const model = createWordDocument()
  const sourceRun = { fontSize: 36, highlight: 'cyan', backgroundColor: '#123456' }
  model.paragraphs[0] = {
    id: 'replacement', style: {}, sourceRun,
    runs: [{ text: 'A中😀B', style: { ...sourceRun, verticalAlign: 'superscript', strike: 'double', underline: true }, directStyle: { strike: 'double', underline: true }, sourceVerticalAlign: 'superscript' }],
  }
  const c = new WordController(model), before = c.model, originalRun = before.paragraphs[0].runs[0]
  c.replaceText(range(0, 0, 5), '新😀')
  assert.deepEqual(c.model.paragraphs[0].runs[0], { ...originalRun, text: '新😀' })
  c.replaceText(range(0, 0, 3), '')
  assert.deepEqual(c.model.paragraphs[0].runs[0], { ...originalRun, text: '' })
  c.replaceText(range(0, 0, 0), '再输入')
  assert.deepEqual(c.model.paragraphs[0].runs[0], { ...originalRun, text: '再输入' })
  c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('invalid background values reject atomically in every character style layer', () => {
  const c = sample(), before = c.model, selection = c.selection
  for (const backgroundColor of ['#FFF', '#12345678', '#GG0000', 'auto', 'transparent', 'NONE', 'red', '', 1, false, null, [], {}]) {
    assert.throws(() => normalizeBackgroundColor(backgroundColor), /背景/)
    assert.throws(() => c.formatText(range(0, 0, 1), { highlight: 'yellow', backgroundColor }), /背景/)
    for (const layer of ['style', 'directStyle', 'sourceRun', 'nextParagraphStyle']) {
      const malformed = structuredClone(before), paragraph = malformed.paragraphs[0]
      if (layer === 'style' || layer === 'directStyle') paragraph.runs[0][layer] = { backgroundColor }
      else if (layer === 'sourceRun') paragraph.sourceRun = { backgroundColor }
      else paragraph.nextParagraphStyle = { paragraph: {}, run: { backgroundColor } }
      assert.throws(() => c.setDocument(malformed), /背景/)
    }
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selection)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('double underline remains distinct from single, none and strike through partial edits and history', () => {
  const model = createWordDocument()
  model.paragraphs[0].runs = [{ text: 'A中文😀Z', style: { underline: true, strike: 'single', verticalAlign: 'superscript', fontSize: 18.5, highlight: 'yellow', backgroundColor: '#123456' } }]
  const c = new WordController(model), before = c.model, selected = range(0, 1, 5)
  c.formatText(selected, { underline: 'double' })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.underline]), [['A', true], ['中文😀', 'double'], ['Z', true]])
  const changed = c.model.paragraphs[0].runs[1].style
  assert.deepEqual(changed, { ...before.paragraphs[0].runs[0].style, underline: 'double' })
  c.formatText(selected, { strike: 'double', underline: false })
  assert.equal(c.model.paragraphs[0].runs[1].style.underline, false)
  assert.equal(c.model.paragraphs[0].runs[1].style.strike, 'double')
  c.undo(); assert.deepEqual(c.model.paragraphs[0].runs[1].style, changed)
  c.undo(); assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selected)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[1].style.underline, 'double')
})

test('underline rebasing preserves all single, double and none combinations on paragraph joins', () => {
  for (const base of [undefined, false, true, 'double']) for (const moved of [undefined, false, true, 'double']) {
    const model = createWordDocument()
    const first = { fontSize: 24, ...(base !== undefined ? { underline: base } : {}) }
    const second = { fontSize: 24, ...(moved !== undefined ? { underline: moved } : {}) }
    model.paragraphs = [
      { id: 'first', style: {}, sourceRun: first, runs: [{ text: '甲', style: first, directStyle: {} }] },
      { id: 'second', style: {}, sourceRun: second, runs: [{ text: '乙', style: second, directStyle: {} }] },
    ]
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 1, 0, 1), '')
    const last = c.model.paragraphs[0].runs.at(-1)
    assert.equal(last.style.underline ?? false, moved ?? false)
    const expectedDirect = (base ?? false) === (moved ?? false) ? {} : { underline: moved ?? false }
    assert.deepEqual(last.directStyle, expectedDirect)
    assert.deepEqual(normalizeDocument(c.model), c.model)
    // Native paragraph joins flow through setDocument and the same rebase.
    const joined = structuredClone(before)
    joined.paragraphs[0].runs.push(...joined.paragraphs.pop().runs)
    const dom = new WordController(before); dom.setDocument(joined)
    assert.deepEqual(dom.model.paragraphs[0].runs, c.model.paragraphs[0].runs)
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.equal(c.model.paragraphs[0].runs.at(-1).style.underline ?? false, moved ?? false)
  }
})

test('underline follows paragraph style at end Enter while direct single, double and none persist', () => {
  for (const inherited of [undefined, false, true, 'double']) for (const direct of [undefined, false, true, 'double']) for (const offset of [1, 2]) {
    const model = createWordDocument()
    const sourceRun = { fontSize: 24, ...(inherited !== undefined ? { underline: inherited } : {}) }
    const directStyle = { strike: 'single', ...(direct !== undefined ? { underline: direct } : {}) }
    model.paragraphs[0] = {
      id: 'underline', style: {}, sourceRun,
      runs: [{ text: 'ab', style: { ...sourceRun, ...directStyle }, directStyle }],
      nextParagraphStyle: { paragraph: {}, run: { underline: 'double', fontSize: 12 } },
    }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, offset, offset), '\n')
    const inserted = c.model.paragraphs[1].runs[0]
    assert.equal(inserted.style.underline, direct ?? (offset === 2 ? 'double' : inherited))
    assert.equal(inserted.directStyle.underline, direct)
    assert.equal(inserted.style.strike, 'single')
    c.replaceText(c.selection, '中😀')
    assert.equal(c.model.paragraphs[1].runs[0].style.underline, inserted.style.underline)
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('double underline survives whole-selection replacement, deletion and empty paragraph insertion', () => {
  for (const inherited of [false, true, 'double']) for (const direct of [undefined, false, true, 'double']) {
    const model = createWordDocument(), sourceRun = { underline: inherited, fontSize: 18 }
    const directStyle = { strike: 'double', ...(direct !== undefined ? { underline: direct } : {}) }
    model.paragraphs[0] = { id: 'replace', style: {}, sourceRun, runs: [{ text: 'A中😀B', style: { ...sourceRun, ...directStyle }, directStyle }] }
    const c = new WordController(model), before = c.model, originalRun = before.paragraphs[0].runs[0]
    c.replaceText(range(0, 0, 5), '新😀')
    assert.deepEqual(c.model.paragraphs[0].runs[0], { ...originalRun, text: '新😀' })
    c.replaceText(range(0, 0, 3), '')
    assert.deepEqual(c.model.paragraphs[0].runs[0], { ...originalRun, text: '' })
    c.replaceText(range(0, 0, 0), '再输入')
    assert.deepEqual(c.model.paragraphs[0].runs[0], { ...originalRun, text: '再输入' })
    c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('cross-paragraph double underline formatting includes empty runs and preserves explicit same-value overrides', () => {
  const model = createWordDocument(), sourceRun = { underline: 'double', fontSize: 24 }
  model.paragraphs = ['A', '', 'B'].map((text, index) => ({ id: `paragraph-${index}`, style: {}, sourceRun, runs: [{ text, style: sourceRun, directStyle: {} }] }))
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 1, 2), { underline: 'double' })
  assert.equal(c.canUndo, true, 'an explicit direct double differs from inherited double')
  assert.deepEqual(c.model.paragraphs.map(p => p.runs[0].directStyle), [{ underline: 'double' }, { underline: 'double' }, { underline: 'double' }])
  c.replaceText(range(1, 0, 0), '空段输入')
  assert.deepEqual(c.model.paragraphs[1].runs[0].style, sourceRun)
  c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('invalid underline values reject atomically in every effective, direct and inherited style layer', () => {
  const c = sample(), before = c.model, selection = c.selection
  for (const underline of ['true', 'false', 'single', 'none', 'DOUBLE', 'wavy', 'dotted', 'dashed', '', 0, 1, null, [], {}]) {
    assert.throws(() => c.formatText(range(0, 0, 1), { bold: true, underline }), /下划线/)
    assert.throws(() => c.replaceText(range(0, 0, 1), 'bad', { underline }), /下划线/)
    for (const layer of ['style', 'directStyle', 'sourceRun', 'nextParagraphStyle', 'nextSourceRun']) {
      const malformed = structuredClone(before), paragraph = malformed.paragraphs[0]
      if (layer === 'style' || layer === 'directStyle') paragraph.runs[0][layer] = { underline }
      else if (layer === 'sourceRun') paragraph.sourceRun = { underline }
      else if (layer === 'nextSourceRun') paragraph.nextParagraphStyle = { paragraph: {}, run: {}, sourceRun: { underline } }
      else paragraph.nextParagraphStyle = { paragraph: {}, run: { underline } }
      assert.throws(() => c.setDocument(malformed), /下划线/)
    }
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selection)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('paragraph markers normalize independently without becoming body inheritance or trailing runs', () => {
  const model = createWordDocument()
  model.paragraphs[0] = {
    id: 'marker', style: {}, sourceRun: { fontSize: 12, underline: true },
    marker: { style: { fontSize: 48, underline: 'double', backgroundColor: '#ab12ef' }, directStyle: { fontSize: 48, underline: 'double', backgroundColor: '#ab12ef' } },
    runs: [{ text: '正文😀', style: { fontSize: 12, underline: true }, directStyle: {} }],
  }
  const normalized = normalizeDocument(model), p = normalized.paragraphs[0]
  assert.deepEqual(p.sourceRun, model.paragraphs[0].sourceRun)
  assert.deepEqual(p.runs, model.paragraphs[0].runs)
  assert.equal(p.marker.style.fontSize, 48)
  assert.equal(p.marker.style.backgroundColor, '#AB12EF')
  assert.deepEqual(p.marker.style, p.marker.directStyle)
  assert.equal(documentText(normalized), '正文😀')
  normalized.paragraphs[0].marker.style.fontSize = 30
  assert.equal(model.paragraphs[0].marker.style.fontSize, 48, 'normalization detaches marker objects')
})

test('a truly empty paragraph mirrors its marker while soft breaks and legacy empty runs remain distinct', () => {
  const model = createWordDocument(), marker = {
    style: { fontSize: 18, underline: 'double', strike: 'single', verticalAlign: 'superscript', highlight: 'yellow', backgroundColor: '#123456' },
    directStyle: { fontSize: 18, underline: 'double', strike: 'single', highlight: 'yellow', backgroundColor: '#123456' },
    sourceVerticalAlign: 'superscript',
  }
  model.paragraphs = [
    { id: 'empty', style: {}, marker, runs: [{ text: '', style: { fontSize: 9, underline: false } }, { text: '', style: { fontSize: 24, strike: 'double' } }] },
    { id: 'soft', style: {}, marker, runs: [{ text: '\n', style: { fontSize: 9 }, directStyle: { fontSize: 9 } }] },
    { id: 'legacy', style: {}, runs: [{ text: '', style: { fontSize: 24, bold: true } }] },
  ]
  const normalized = normalizeDocument(model)
  assert.deepEqual(normalized.paragraphs[0].runs, [{ text: '', ...normalized.paragraphs[0].marker }])
  assert.deepEqual(normalized.paragraphs[1].runs, model.paragraphs[1].runs)
  assert.deepEqual(normalized.paragraphs[2].runs, model.paragraphs[2].runs)
  assert.equal(normalized.paragraphs[2].marker, undefined)
  assert.equal(documentText(normalized), '\n\n\n')
})

test('partial body formatting leaves markers intact and crossing a boundary formats exactly the included markers', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12 }
  model.paragraphs = ['AB', '', 'B'].map((text, index) => ({
    id: `marker-${index}`, style: {}, sourceRun,
    marker: { style: { fontSize: 24, underline: 'double' }, directStyle: { fontSize: 24, underline: 'double' } },
    runs: [{ text, style: sourceRun, directStyle: {} }],
  }))
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 1), { fontSize: 9, underline: false })
  assert.deepEqual(c.model.paragraphs.map(p => p.marker), before.paragraphs.map(p => p.marker))
  assert.equal(c.model.paragraphs[0].runs[0].style.fontSize, 9)
  c.undo()
  c.formatText(range(0, 2, 0, 2), { underline: false })
  assert.deepEqual(c.model.paragraphs.map(p => p.marker.style.underline), [false, false, 'double'])
  assert.equal(c.model.paragraphs[1].runs[0].style.underline, false)
  assert.deepEqual(c.model.paragraphs[0].runs, before.paragraphs[0].runs, 'boundary-only selection does not format first body text')
  assert.deepEqual(c.model.paragraphs[2].runs, before.paragraphs[2].runs, 'end offset zero excludes final body and marker')
  c.undo(); assert.deepEqual(c.model, before)
})

test('formatting a previously unformatted paragraph separator creates a marker without inheriting adjacent direct body format', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'first', style: {}, sourceRun: { fontSize: 12 }, runs: [{ text: 'A', style: { fontSize: 24, bold: true }, directStyle: { fontSize: 24, bold: true } }] },
    { id: 'second', style: {}, runs: [{ text: 'B', style: {} }] },
  ]
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 1, 0, 1), { underline: 'double' })
  assert.deepEqual(c.model.paragraphs[0].marker, { style: { fontSize: 12, underline: 'double' }, directStyle: { underline: 'double' } })
  assert.deepEqual(c.model.paragraphs[0].runs, before.paragraphs[0].runs)
  assert.equal(c.model.paragraphs[1].marker, undefined)
  assert.equal(c.dirty, true)
  c.undo(); assert.deepEqual(c.model, before); assert.equal(c.dirty, false)
  c.redo(); assert.equal(c.model.paragraphs[0].marker.style.underline, 'double')
})

test('same-paragraph replacement preserves an independent marker and deletion to empty restores its insertion mirror', () => {
  const model = createWordDocument()
  model.paragraphs[0] = {
    id: 'edit', style: {}, sourceRun: { fontSize: 12 },
    marker: { style: { fontSize: 24, underline: 'double', verticalAlign: 'superscript' }, directStyle: { fontSize: 24, underline: 'double', verticalAlign: 'superscript' } },
    runs: [{ text: 'A中😀B', style: { fontSize: 9, italic: true }, directStyle: { fontSize: 9, italic: true } }],
  }
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 0, 5), '新😀')
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  assert.equal(c.model.paragraphs[0].runs[0].style.fontSize, 9)
  c.replaceText(range(0, 0, 3), '')
  assert.deepEqual(c.model.paragraphs[0].runs, [{ text: '', ...before.paragraphs[0].marker }])
  c.replaceText(c.selection, '再输入😀')
  assert.deepEqual(c.model.paragraphs[0].runs, [{ text: '再输入😀', ...before.paragraphs[0].marker }])
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('paragraph joins keep the surviving first marker while preserving the suffix body appearance', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'first', style: {}, sourceRun: { fontSize: 12 }, marker: { style: { fontSize: 18, underline: 'double' }, directStyle: { fontSize: 18, underline: 'double' } }, runs: [{ text: 'A', style: { fontSize: 12 }, directStyle: {} }] },
    { id: 'last', style: {}, sourceRun: { fontSize: 9 }, marker: { style: { fontSize: 36, strike: 'double' }, directStyle: { fontSize: 36, strike: 'double' } }, runs: [{ text: 'B', style: { fontSize: 9, italic: true }, directStyle: { italic: true } }] },
  ]
  for (const backwards of [false, true]) {
    const c = new WordController(model), before = c.model, selected = range(0, 1, 0, 1)
    if (backwards) [selected.anchor, selected.focus] = [selected.focus, selected.anchor]
    c.replaceText(selected, '')
    assert.equal(documentText(c.model), 'AB')
    assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
    assert.equal(c.model.paragraphs[0].runs[1].style.fontSize, 9)
    c.undo(); assert.deepEqual(c.model, before)
  }
})

test('Enter copies marker hard attributes while follow styles update only marker inheritance', () => {
  for (const offset of [0, 1, 2]) {
    const model = createWordDocument(), sourceRun = { fontSize: 24, bold: true, underline: true }
    model.paragraphs[0] = {
      id: 'split', style: { heading: 1 }, sourceRun,
      marker: { style: { ...sourceRun, underline: 'double', backgroundColor: '#123456' }, directStyle: { underline: 'double', backgroundColor: '#123456' } },
      nextParagraphStyle: { paragraph: { heading: 0 }, run: { fontSize: 12, bold: false, underline: false }, sourceRun },
      runs: [{ text: 'AB', style: sourceRun, directStyle: {} }],
    }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, offset, offset), '\n')
    const [first, second] = c.model.paragraphs
    assert.deepEqual(first.marker, before.paragraphs[0].marker)
    assert.equal(second.marker.style.fontSize, offset === 2 ? 12 : 24)
    assert.equal(second.marker.style.bold, offset !== 2)
    assert.equal(second.marker.style.underline, 'double')
    assert.deepEqual(second.marker.directStyle, before.paragraphs[0].marker.directStyle)
    if (offset === 2) assert.deepEqual(second.runs, [{ text: '', ...second.marker }])
    c.replaceText(c.selection, 'X')
    assert.equal(c.model.paragraphs[1].runs[0].style.underline, offset === 2 ? 'double' : true, 'middle/start insertion keeps suffix body format, end insertion uses marker')
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('marker source changes retain explicit same-value resets and named script provenance', () => {
  const marker = { style: { fontSize: 18, bold: false, underline: false, verticalAlign: 'superscript' }, directStyle: { bold: false, underline: false }, sourceVerticalAlign: 'superscript' }
  const changed = withParagraphMarkerSource(marker, { fontSize: 12, bold: true, underline: 'double', verticalAlign: 'subscript' })
  assert.deepEqual(changed, { style: { fontSize: 12, bold: false, underline: false, verticalAlign: 'superscript' }, directStyle: { bold: false, underline: false }, sourceVerticalAlign: 'superscript' })
  assert.equal(marker.style.fontSize, 18)
  const legacy = withParagraphMarkerSource({ style: { fontSize: 18, bold: false } }, { fontSize: 12, bold: true })
  assert.deepEqual(legacy, { style: { fontSize: 18, bold: false }, directStyle: { fontSize: 18, bold: false } })
})

test('invalid paragraph marker formats reject atomically without changing document, selection or history', () => {
  const c = sample(), before = c.model, selection = c.selection
  const invalid = [null, false, 3, '', [], {}, { style: [] }, { style: {}, directStyle: [] }, { style: {}, text: 'marker' }, { style: {}, sourceVerticalAlign: 'super' }]
  for (const field of ['style', 'directStyle']) for (const value of [{ underline: 'wavy' }, { fontSize: 0 }, { backgroundColor: 'transparent' }, { highlight: '#123456' }, { verticalAlign: 'super' }]) invalid.push({ style: {}, [field]: value })
  for (const marker of invalid) {
    const next = c.model; next.paragraphs[0].marker = marker
    assert.throws(() => c.setDocument(next))
    assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selection); assert.equal(c.canUndo, false)
  }
})

test('native paragraph-end insertion takes the independent marker while body replacement keeps body format', () => {
  const model = createWordDocument(), marker = { style: { fontSize: 18, bold: true, underline: 'double', verticalAlign: 'superscript' }, directStyle: { fontSize: 18, bold: true, underline: 'double', verticalAlign: 'superscript' } }
  model.paragraphs[0] = { id: 'end-insert', style: {}, marker, runs: [{ text: 'BODY', style: { fontSize: 12 }, directStyle: { fontSize: 12 } }] }
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 4, 4), 'X')
  assert.deepEqual(c.model.paragraphs[0].runs[1], { text: 'X', ...marker })
  c.undo(); assert.deepEqual(c.model, before)
  c.replaceText(range(0, 0, 4), 'Y')
  assert.deepEqual(c.model.paragraphs[0].runs[0], { text: 'Y', style: { fontSize: 12 }, directStyle: { fontSize: 12 } })
  c.undo()
  c.replaceText(range(0, 4, 4), '\n'); c.replaceText(c.selection, 'X')
  assert.deepEqual(c.model.paragraphs[1].marker, marker)
  assert.deepEqual(c.model.paragraphs[1].runs[0], { text: 'X', ...marker })
})

test('deleting the boundary after an empty first paragraph retains the following marker', () => {
  for (const nextMarker of [undefined, { style: { fontSize: 18, italic: true }, directStyle: { fontSize: 18, italic: true } }]) {
    const model = createWordDocument()
    model.paragraphs = [
      { id: 'empty-first', style: {}, marker: { style: { fontSize: 24, bold: true }, directStyle: { fontSize: 24, bold: true } }, runs: [{ text: '', style: {} }] },
      { id: 'next', style: {}, ...(nextMarker ? { marker: nextMarker } : {}), runs: [{ text: 'BODY', style: { fontSize: 12 } }] },
    ]
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 0, 0, 1), '')
    assert.equal(documentText(c.model), 'BODY')
    assert.deepEqual(c.model.paragraphs[0].marker, nextMarker)
    c.undo(); assert.deepEqual(c.model, before)
  }
})

test('formatting the complete nonempty body resets marker hard attributes to paragraph source plus patch', () => {
  for (const includeSeparator of [false, true]) for (const backwards of [false, true]) {
    const model = createWordDocument(), sourceRun = { fontSize: 12, color: '#000000', underline: false }
    model.paragraphs = [
      { id: 'whole', style: {}, sourceRun,
        marker: { style: { fontSize: 48, color: '#CC0000', underline: 'double', verticalAlign: 'superscript', highlight: 'yellow', strike: 'double' }, directStyle: { fontSize: 48, color: '#CC0000', underline: 'double', verticalAlign: 'superscript', highlight: 'yellow', strike: 'double' } },
        runs: [{ text: 'BODY', style: { ...sourceRun, fontSize: 9, italic: true }, directStyle: { fontSize: 9, italic: true } }] },
      { id: 'next', style: {}, marker: { style: { fontSize: 36 }, directStyle: { fontSize: 36 } }, runs: [{ text: 'AFTER', style: {} }] },
    ]
    const c = new WordController(model), before = c.model, selected = includeSeparator ? range(0, 0, 0, 1) : range(0, 0, 4)
    if (backwards) [selected.anchor, selected.focus] = [selected.focus, selected.anchor]
    c.formatText(selected, { bold: true })
    assert.deepEqual(c.model.paragraphs[0].marker, { style: { ...sourceRun, bold: true }, directStyle: { bold: true } })
    assert.equal(c.model.paragraphs[0].runs[0].style.fontSize, 9, 'visible body retains its other direct attributes')
    assert.equal(c.model.paragraphs[0].runs[0].style.italic, true)
    assert.deepEqual(c.model.paragraphs[1].marker, before.paragraphs[1].marker)
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true })
  }
})

test('complete body formatting creates a missing marker and removes an old marker character-style source', () => {
  for (const oldMarker of [undefined, { style: { fontSize: 12, verticalAlign: 'superscript' }, directStyle: {}, sourceVerticalAlign: 'superscript' }]) {
    const model = createWordDocument(), sourceRun = { fontSize: 12 }
    model.paragraphs[0] = { id: 'whole-source', style: {}, sourceRun, ...(oldMarker ? { marker: oldMarker } : {}), runs: [{ text: 'BODY', style: sourceRun, directStyle: {} }] }
    const c = new WordController(model), before = c.model
    c.formatText(range(0, 0, 4), { italic: true })
    assert.deepEqual(c.model.paragraphs[0].marker, { style: { fontSize: 12, italic: true }, directStyle: { italic: true } })
    assert.equal(c.model.paragraphs[0].marker.sourceVerticalAlign, undefined)
    c.undo(); assert.deepEqual(c.model, before)
  }
})

test('formatting an empty caret immediately stores a marker and insertion mirror with undoable direct overrides', () => {
  for (const existingMarker of [false, true]) {
    const model = createWordDocument(), sourceRun = { fontSize: 12, underline: 'double', verticalAlign: 'subscript' }
    const format = {
      style: { fontSize: 24, underline: false, verticalAlign: 'baseline', highlight: 'yellow' },
      directStyle: { fontSize: 24, underline: false, verticalAlign: 'baseline', highlight: 'yellow' },
      sourceVerticalAlign: 'superscript',
    }
    model.paragraphs[0] = { id: 'empty-caret', style: {}, sourceRun,
      ...(existingMarker ? { marker: format } : {}), runs: [{ text: '', ...format }] }
    const c = new WordController(model), before = c.model, caret = range(0, 0, 0)
    c.formatText(caret, { underline: 'double' })
    const expected = { ...format, style: { ...format.style, underline: 'double' }, directStyle: { ...format.directStyle, underline: 'double' } }
    assert.deepEqual(c.model.paragraphs[0].marker, expected)
    assert.deepEqual(c.model.paragraphs[0].runs, [{ text: '', ...expected }])
    assert.equal(c.dirty, true, 'empty formatting must be saved even before any text is entered')
    assert.equal(c.revision, 1)
    assert.equal(c.canUndo, true)
    c.markSaved()
    assert.equal(c.dirty, false)
    c.undo(); assert.deepEqual(c.model, before); assert.equal(c.dirty, true)
    c.redo(); assert.deepEqual(c.model.paragraphs[0].marker, expected); assert.equal(c.dirty, false)
    c.replaceText(caret, '输入😀')
    assert.deepEqual(c.model.paragraphs[0].runs, [{ text: '输入😀', ...expected }])
  }
})

test('a collapsed character-format command still leaves nonempty paragraphs and history unchanged', () => {
  for (const text of ['BODY', ' ', '\t', '\n']) for (const atEnd of [false, true]) {
    const model = createWordDocument(), marker = { style: { fontSize: 24, underline: 'double' }, directStyle: { fontSize: 24, underline: 'double' } }
    model.paragraphs[0] = { id: 'nonempty-caret', style: {}, marker, runs: [{ text, style: { fontSize: 12 } }] }
    const c = new WordController(model), before = c.model, offset = atEnd ? text.length : 0
    c.formatText(range(0, offset, offset), { underline: false })
    assert.deepEqual(c.model, before)
    assert.equal(c.revision, 0); assert.equal(c.dirty, false); assert.equal(c.canUndo, false)
  }
})

test('paragraph-end insertion overlays only explicit marker attributes on the adjacent body', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12, color: '#000000' }
  model.paragraphs[0] = { id: 'overlay', style: {}, sourceRun,
    marker: { style: { ...sourceRun, bold: true }, directStyle: { bold: true } },
    runs: [{ text: 'BODY', style: { fontSize: 24, italic: true, color: '#0044AA' }, directStyle: { fontSize: 24, italic: true, color: '#0044AA' } }] }
  const c = new WordController(model), before = c.model
  const expected = { style: { fontSize: 24, italic: true, color: '#0044AA', bold: true }, directStyle: { fontSize: 24, italic: true, color: '#0044AA', bold: true } }
  assert.deepEqual(paragraphInsertionFormat(c.model.paragraphs[0]), expected)
  c.replaceText(range(0, 4, 4), 'X')
  assert.deepEqual(c.model.paragraphs[0].runs[1], { text: 'X', ...expected })
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  c.undo(); assert.deepEqual(c.model, before)
  c.replaceText(range(0, 4, 4), '\n')
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  assert.deepEqual(c.model.paragraphs[1].marker, expected, 'End Enter materializes actual insertion attributes in the new empty mark')
  assert.deepEqual(c.model.paragraphs[1].runs, [{ text: '', ...expected }])
  c.replaceText(c.selection, 'X')
  assert.deepEqual(c.model.paragraphs[1].runs, [{ text: 'X', ...expected }])
  c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('End Enter clears only body hard escapement while retaining explicit and named marker scripts', () => {
  for (const markerScript of [undefined, 'superscript', 'baseline']) for (const namedScript of [undefined, 'subscript']) {
    const model = createWordDocument(), sourceRun = { fontSize: 12 }
    const directStyle = { bold: true, ...(markerScript ? { verticalAlign: markerScript } : {}) }
    const marker = { style: { ...sourceRun, ...(namedScript ? { verticalAlign: namedScript } : {}), ...directStyle }, directStyle,
      ...(namedScript ? { sourceVerticalAlign: namedScript } : {}) }
    model.paragraphs[0] = { id: 'enter-script', style: {}, sourceRun, marker,
      runs: [{ text: 'BODY', style: { fontSize: 24, verticalAlign: 'superscript' }, directStyle: { fontSize: 24, verticalAlign: 'superscript' } }] }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 4, 4), '\n')
    const after = c.model.paragraphs[1]
    assert.equal(after.marker.style.verticalAlign, markerScript ?? namedScript)
    assert.equal(after.marker.directStyle.verticalAlign, markerScript)
    assert.equal(after.marker.sourceVerticalAlign, namedScript)
    assert.equal(after.marker.style.fontSize, 24)
    assert.deepEqual(after.runs, [{ text: '', ...after.marker }])
    assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  }
})

test('paragraph insertion preserves named marker script provenance and explicit marker resets', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12, verticalAlign: 'subscript' }
  for (const reset of [undefined, 'baseline']) {
    const marker = { style: { ...sourceRun, verticalAlign: reset ?? 'superscript' }, directStyle: reset ? { verticalAlign: reset } : {}, sourceVerticalAlign: 'superscript' }
    model.paragraphs[0] = { id: 'script-overlay', style: {}, sourceRun, marker,
      runs: [{ text: 'BODY', style: { fontSize: 24, verticalAlign: 'baseline', italic: true }, directStyle: { fontSize: 24, verticalAlign: 'baseline', italic: true } }] }
    const p = normalizeDocument(model).paragraphs[0], format = paragraphInsertionFormat(p)
    assert.equal(format.style.fontSize, 24)
    assert.equal(format.style.italic, true)
    assert.equal(format.sourceVerticalAlign, 'superscript')
    assert.equal(format.style.verticalAlign, reset ?? 'superscript')
    assert.equal(format.directStyle.verticalAlign, reset)
  }
})

function wholeBodyMarkerController() {
  const model = createWordDocument(), sourceRun = { fontSize: 12, color: '#000000' }
  model.paragraphs[0] = { id: 'whole-origin', style: {}, sourceRun,
    marker: { style: { fontSize: 18, color: '#CC0000', underline: 'double' }, directStyle: { fontSize: 18, color: '#CC0000', underline: 'double' } },
    runs: [{ text: 'BODY', style: { fontSize: 24, italic: true, color: '#0044AA' }, directStyle: { fontSize: 24, italic: true, color: '#0044AA' } }] }
  return new WordController(model)
}

test('whole-body formatting clears an imported marker once and accumulates later paragraph hard attributes', () => {
  const c = wholeBodyMarkerController(), before = c.model
  c.formatText(range(0, 0, 4), { bold: true })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true })
  c.formatText(range(0, 0, 4), { italic: false })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, italic: false })
  assert.equal(c.model.paragraphs[0].runs[0].style.fontSize, 24)
  assert.equal(c.model.paragraphs[0].runs[0].style.color, '#0044AA')
  c.undo(); assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true })
  c.redo(); assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, italic: false })
  c.formatText(range(0, 0, 4), { underline: 'double' })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, italic: false, underline: 'double' })
  c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
  c.formatText(range(0, 0, 4), { italic: false })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { italic: false }, 'undo restores imported-marker origin')
})

test('DOM updates preserve unchanged marker origin while marker replacement and reopening establish imported origin', () => {
  const c = wholeBodyMarkerController()
  c.formatText(range(0, 0, 4), { bold: true })
  const dom = c.model; dom.paragraphs[0].runs[0].text += '!'
  c.setDocument(dom)
  c.formatText(range(0, 0, 5), { italic: false })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, italic: false })
  c.markSaved()
  const reopened = new WordController(c.model)
  reopened.formatText(range(0, 0, 5), { underline: 'double' })
  assert.deepEqual(reopened.model.paragraphs[0].marker.directStyle, { underline: 'double' })
  c.formatText(range(0, 0, 5), { underline: 'double' })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, italic: false, underline: 'double' }, 'saving does not change the active session origin')
  const replaced = c.model; replaced.paragraphs[0].marker.style.color = '#009900'; replaced.paragraphs[0].marker.directStyle.color = '#009900'
  c.setDocument(replaced)
  c.formatText(range(0, 0, 5), { strike: 'single' })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { strike: 'single' })
})

test('paragraph-style rebasing preserves session marker hard-attribute origin', () => {
  const c = wholeBodyMarkerController()
  c.formatText(range(0, 0, 4), { bold: true })
  const heading = c.model, paragraph = heading.paragraphs[0]
  paragraph.style.heading = 1
  paragraph.sourceRun = { fontSize: 18, color: '#112233', bold: true }
  paragraph.marker = withParagraphMarkerSource(paragraph.marker, paragraph.sourceRun)
  c.setDocument(heading)
  c.formatText(range(0, 0, 4), { italic: false })
  assert.deepEqual(c.model.paragraphs[0].marker, {
    style: { fontSize: 18, color: '#112233', bold: true, italic: false },
    directStyle: { bold: true, italic: false },
  })
  c.undo(); c.undo()
  assert.equal(c.model.paragraphs[0].marker.style.fontSize, 12)
  c.formatText(range(0, 0, 4), { underline: 'double' })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, underline: 'double' })
})

test('split and merged paragraphs carry the retained marker editing origin through history', () => {
  const c = wholeBodyMarkerController()
  c.formatText(range(0, 0, 4), { bold: true })
  c.replaceText(range(0, 2, 2), '\n')
  c.formatText(range(1, 0, 2), { italic: false })
  assert.deepEqual(c.model.paragraphs[1].marker.directStyle, { bold: true, italic: false })
  c.replaceText(range(0, 2, 0, 1), '')
  c.formatText(range(0, 0, 4), { underline: 'double' })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, underline: 'double' }, 'nonempty join keeps first marker origin')
  c.undo(); c.undo(); assert.equal(c.model.paragraphs.length, 2)
  c.replaceText(range(0, 0, 2), '')
  c.replaceText(range(0, 0, 0, 1), '')
  c.formatText(range(0, 0, 2), { strike: 'single' })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { bold: true, italic: false, strike: 'single' }, 'empty first join keeps second marker origin')
})

test('character tracking retains signed twips and explicit zero in every character-format layer', () => {
  assert.deepEqual(LETTER_SPACING_LIMITS, { min: -20, max: 20, step: 0.05 })
  for (const raw of [-20, -2, -1.15, -0.05, -0, 0, 0.05, 0.15, 1.15, 0.1 + 0.2, 20]) {
    const letterSpacing = Math.round(raw * 20) / 20 || 0
    const model = createWordDocument(), style = { letterSpacing: raw, kerning: 12 }
    model.paragraphs[0] = { id: 'tracking', style: {}, sourceRun: style,
      marker: { style, directStyle: { letterSpacing: raw } },
      runs: [{ text: 'A中😀', style, directStyle: { letterSpacing: raw } }],
      nextParagraphStyle: { paragraph: {}, run: style, sourceRun: style } }
    const p = normalizeDocument(model).paragraphs[0]
    for (const format of [p.sourceRun, p.marker.style, p.marker.directStyle, p.runs[0].style,
      p.runs[0].directStyle, p.nextParagraphStyle.run, p.nextParagraphStyle.sourceRun]) {
      assert.equal(format.letterSpacing, letterSpacing)
      assert.equal(Object.is(format.letterSpacing, -0), false)
    }
    assert.equal(p.runs[0].style.kerning, 12, 'tracking never replaces the independent kerning threshold')
  }
  const plain = normalizeDocument(createWordDocument())
  assert.equal(Object.hasOwn(plain.paragraphs[0].runs[0].style, 'letterSpacing'), false)
})

test('invalid tracking rejects atomically across run, marker, source and follow styles', () => {
  const c = sample(), before = c.model, selection = c.selection
  for (const letterSpacing of [NaN, Infinity, -Infinity, '1', null, false, -20.05, 20.05, 0.01, -0.025, 1.151]) {
    assert.throws(() => c.formatText(range(0, 0, 2), { letterSpacing }), /字符间距/)
    for (const layer of ['style', 'directStyle', 'sourceRun', 'markerStyle', 'markerDirect', 'nextRun', 'nextSource']) {
      const input = c.model, p = input.paragraphs[0]
      if (layer === 'style') p.runs[0].style.letterSpacing = letterSpacing
      else if (layer === 'directStyle') p.runs[0].directStyle = { letterSpacing }
      else if (layer === 'sourceRun') p.sourceRun = { letterSpacing }
      else if (layer === 'markerStyle') p.marker = { style: { letterSpacing } }
      else if (layer === 'markerDirect') p.marker = { style: {}, directStyle: { letterSpacing } }
      else if (layer === 'nextRun') p.nextParagraphStyle = { paragraph: {}, run: { letterSpacing } }
      else p.nextParagraphStyle = { paragraph: {}, run: {}, sourceRun: { letterSpacing } }
      assert.throws(() => c.setDocument(input), /字符间距/)
    }
  }
  assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selection)
  assert.equal(c.revision, 0)
  assert.equal(c.canUndo, false)
})

test('partial tracking edits preserve the body, independent marker, kerning and undo selection', () => {
  const model = createWordDocument(), sourceRun = { letterSpacing: 1.15, kerning: 10 }
  model.paragraphs[0] = { id: 'tracking-partial', style: {}, sourceRun,
    marker: { style: { ...sourceRun, letterSpacing: -0.5 }, directStyle: { letterSpacing: -0.5 } },
    runs: [{ text: 'A中😀B', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model), before = c.model, selected = range(0, 1, 4)
  c.formatText(selected, { letterSpacing: 0 })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.letterSpacing, run.style.kerning]), [
    ['A', 1.15, 10], ['中😀', 0, 10], ['B', 1.15, 10],
  ])
  assert.deepEqual(c.model.paragraphs[0].runs[1].directStyle, { letterSpacing: 0 })
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  c.undo(); assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[1].style.letterSpacing, 0)
})

test('paragraph joins materialize zero tracking only when needed to preserve the moved text', () => {
  for (const [firstSpacing, secondSpacing, expectedDirect] of [[1.15, undefined, 0], [-0.5, 1.15, 1.15], [undefined, undefined, undefined]]) {
    const first = firstSpacing === undefined ? {} : { letterSpacing: firstSpacing }
    const second = secondSpacing === undefined ? {} : { letterSpacing: secondSpacing }
    const model = createWordDocument()
    model.paragraphs = [
      { id: 'first-tracking', style: {}, sourceRun: first, runs: [{ text: 'A', style: first, directStyle: {} }] },
      { id: 'second-tracking', style: {}, sourceRun: second, runs: [{ text: 'B', style: second, directStyle: {} }] },
    ]
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 1, 0, 1), '')
    const moved = c.model.paragraphs[0].runs.at(-1)
    assert.equal(moved.directStyle.letterSpacing, expectedDirect)
    assert.equal(moved.style.letterSpacing ?? 0, secondSpacing ?? 0)
    const merged = c.model
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.deepEqual(c.model, merged)
    const domModel = structuredClone(before)
    domModel.paragraphs[0].runs.push(...domModel.paragraphs.pop().runs)
    const dom = new WordController(before); dom.setDocument(domModel)
    assert.deepEqual(dom.model.paragraphs[0].runs, merged.paragraphs[0].runs)
  }
})

test('Enter follows inherited tracking while preserving explicit same-value and zero overrides', () => {
  for (const directSpacing of [undefined, 0, 1.15]) {
    const model = createWordDocument(), sourceRun = { letterSpacing: 1.15, kerning: 12 }
    const directStyle = directSpacing === undefined ? {} : { letterSpacing: directSpacing }
    model.paragraphs[0] = { id: 'tracking-heading', style: { heading: 1 }, sourceRun,
      nextParagraphStyle: { paragraph: { heading: 0 }, run: { letterSpacing: -0.5, kerning: 12 }, sourceRun },
      runs: [{ text: 'AB', style: { ...sourceRun, ...directStyle }, directStyle }] }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 2, 2), '\n')
    const next = c.model.paragraphs[1]
    assert.equal(next.runs[0].style.letterSpacing, directSpacing ?? -0.5)
    assert.equal(next.runs[0].directStyle.letterSpacing, directSpacing)
    assert.equal(next.sourceRun.letterSpacing, -0.5)
    c.replaceText(c.selection, 'C')
    assert.equal(c.model.paragraphs[1].runs[0].style.letterSpacing, directSpacing ?? -0.5)
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('flattened named-character tracking stays explicit through Enter into a different following style', () => {
  // The codec flattens a selected rStyle's tracking into directStyle even
  // when it equals the paragraph base. A visually identical inherited run
  // still follows the next paragraph style, matching native Writer Enter.
  for (const explicit of [false, true]) {
    const model = createWordDocument(), sourceRun = { letterSpacing: 1 }
    model.paragraphs[0] = { id: 'named-tracking', style: {}, sourceRun,
      nextParagraphStyle: { paragraph: {}, run: { letterSpacing: -0.5 }, sourceRun },
      runs: [{ text: 'A', style: sourceRun, directStyle: {} },
        { text: 'B', style: sourceRun, directStyle: explicit ? { letterSpacing: 1 } : {} }] }
    const c = new WordController(model), before = c.model
    c.formatText(range(0, 1, 2), { bold: true })
    c.replaceText(range(0, 2, 2), '\n')
    c.replaceText(c.selection, 'X')
    const next = c.model.paragraphs[1]
    assert.equal(next.sourceRun.letterSpacing, -0.5)
    assert.equal(next.runs[0].style.letterSpacing, explicit ? 1 : -0.5)
    assert.equal(next.runs[0].directStyle.letterSpacing, explicit ? 1 : undefined)
    assert.equal(next.runs[0].style.bold, true)
    c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('marker tracking controls end insertion and empty-caret formatting without changing earlier body text', () => {
  for (const letterSpacing of [-1.15, 0, 1.15]) {
    const model = createWordDocument(), sourceRun = { fontSize: 12, letterSpacing: 0.5 }
    const marker = { style: { ...sourceRun, letterSpacing }, directStyle: { letterSpacing } }
    model.paragraphs[0] = { id: 'tracking-marker', style: {}, sourceRun, marker,
      runs: [{ text: 'AB', style: { ...sourceRun, letterSpacing: -0.5 }, directStyle: { letterSpacing: -0.5 } }] }
    const c = new WordController(model), before = c.model
    assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).style.letterSpacing, letterSpacing)
    c.replaceText(range(0, 2, 2), '\n')
    assert.deepEqual(c.model.paragraphs[0], before.paragraphs[0])
    assert.equal(c.model.paragraphs[1].marker.style.letterSpacing, letterSpacing)
    assert.equal(c.model.paragraphs[1].marker.directStyle.letterSpacing, letterSpacing)
    assert.equal(c.model.paragraphs[1].runs[0].style.letterSpacing, letterSpacing)
    c.formatText(c.selection, { letterSpacing: 0 })
    assert.equal(c.model.paragraphs[1].marker.directStyle.letterSpacing, 0)
    assert.equal(c.model.paragraphs[1].runs[0].style.letterSpacing, 0)
    const rebased = withParagraphMarkerSource(c.model.paragraphs[1].marker, { letterSpacing: 2 })
    assert.equal(rebased.style.letterSpacing, 0, 'changing the paragraph base cannot erase an explicit zero')
  }
})

test('equal-looking inherited and explicit-zero tracking remain distinct through normalization and history', () => {
  const model = createWordDocument(), sourceRun = { letterSpacing: 0 }
  model.paragraphs[0] = { id: 'tracking-zero', style: {}, sourceRun,
    runs: [{ text: 'A', style: sourceRun, directStyle: {} }, { text: 'B', style: sourceRun, directStyle: { letterSpacing: 0 } }] }
  const c = new WordController(model), before = c.model
  assert.equal(before.paragraphs[0].runs.length, 2)
  c.formatText(range(0, 0, 1), { letterSpacing: -0.05 })
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[0].directStyle.letterSpacing, -0.05)
})

test('case mapping is a character display enum and never rewrites source text or UTF-16 offsets', () => {
  for (const caseMap of ['none', 'upper', 'smallCaps']) {
    const text = caseMap === 'none' ? 'aßİıﬃé e\u0301 αβБ中😀' : 'abZ中😀✈\ufe0f漢\u{e0100}'
    const model = createWordDocument(), style = { caseMap, fontSize: 12, letterSpacing: 0.5 }
    model.paragraphs[0] = { id: 'case-layer', style: {}, sourceRun: style,
      marker: { style, directStyle: { caseMap } },
      runs: [{ text, style, directStyle: { caseMap } }],
      nextParagraphStyle: { paragraph: {}, run: style, sourceRun: style } }
    const c = new WordController(model), p = c.model.paragraphs[0]
    for (const format of [p.sourceRun, p.marker.style, p.marker.directStyle, p.runs[0].style,
      p.runs[0].directStyle, p.nextParagraphStyle.run, p.nextParagraphStyle.sourceRun]) assert.equal(format.caseMap, caseMap)
    assert.equal(documentText(c.model), text)
    c.setSelection(range(0, 1, 2))
    assert.deepEqual(c.selection, range(0, 1, 2), 'selection still counts the original UTF-16 units')
    c.replaceText(c.selection, text.slice(1, 2))
    assert.equal(documentText(c.model), text, 'replacement inserts the original text without expanding its display casing')
    assert.equal(c.model.paragraphs[0].runs[0].style.fontSize, 12)
  }
  assert.equal(Object.hasOwn(normalizeDocument(createWordDocument()).paragraphs[0].runs[0].style, 'caseMap'), false)
})

test('unsupported case-map values reject atomically in every character-format layer', () => {
  const c = sample(), before = c.model, selected = c.selection
  for (const caseMap of [null, false, true, 0, 'uppercase', 'lower', 'capitalize', 'small-caps', '', [], {}]) {
    assert.throws(() => c.formatText(range(0, 0, 2), { caseMap }), /大小写/)
    for (const layer of ['style', 'directStyle', 'sourceRun', 'markerStyle', 'markerDirect', 'nextRun', 'nextSource']) {
      const input = c.model, p = input.paragraphs[0]
      if (layer === 'style') p.runs[0].style.caseMap = caseMap
      else if (layer === 'directStyle') p.runs[0].directStyle = { caseMap }
      else if (layer === 'sourceRun') p.sourceRun = { caseMap }
      else if (layer === 'markerStyle') p.marker = { style: { caseMap } }
      else if (layer === 'markerDirect') p.marker = { style: {}, directStyle: { caseMap } }
      else if (layer === 'nextRun') p.nextParagraphStyle = { paragraph: {}, run: { caseMap } }
      else p.nextParagraphStyle = { paragraph: {}, run: {}, sourceRun: { caseMap } }
      assert.throws(() => c.setDocument(input), /大小写/)
    }
  }
  assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selected)
  assert.equal(c.revision, 0)
  assert.equal(c.canUndo, false)
})

test('partial case-map formatting uses original Unicode positions and preserves unrelated formatting', () => {
  const model = createWordDocument(), sourceRun = { caseMap: 'upper', fontSize: 18, letterSpacing: 1.15 }
  const marker = { style: { ...sourceRun, caseMap: 'smallCaps' }, directStyle: { caseMap: 'smallCaps' } }
  model.paragraphs[0] = { id: 'case-partial', style: {}, sourceRun, marker,
    runs: [{ text: 'ab😀中z', style: { ...sourceRun, underline: 'double' }, directStyle: { underline: 'double' } }] }
  const c = new WordController(model), before = c.model, selected = range(0, 1, 4)
  c.formatText(selected, { caseMap: 'none' })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.caseMap]), [['a', 'upper'], ['b😀', 'none'], ['中z', 'upper']])
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  for (const run of c.model.paragraphs[0].runs) {
    assert.equal(run.style.fontSize, 18)
    assert.equal(run.style.letterSpacing, 1.15)
    assert.equal(run.style.underline, 'double')
  }
  assert.equal(documentText(c.model), 'ab😀中z')
  assert.throws(() => c.formatText(range(0, 2, 3), { caseMap: 'upper' }), /Unicode/)
  c.undo(); assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
  c.redo(); assert.equal(c.model.paragraphs[0].runs[1].directStyle.caseMap, 'none')
})

test('paragraph joins preserve moved text casing with an explicit none reset when needed', () => {
  for (const [firstCase, secondCase, expectedDirect] of [['upper', undefined, 'none'], ['smallCaps', 'upper', 'upper'], [undefined, undefined, undefined]]) {
    const first = firstCase === undefined ? {} : { caseMap: firstCase }
    const second = secondCase === undefined ? {} : { caseMap: secondCase }
    const model = createWordDocument()
    model.paragraphs = [
      { id: 'first-case', style: {}, sourceRun: first, runs: [{ text: 'a', style: first, directStyle: {} }] },
      { id: 'second-case', style: {}, sourceRun: second, runs: [{ text: 'b', style: second, directStyle: {} }] },
    ]
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 1, 0, 1), '')
    const moved = c.model.paragraphs[0].runs.at(-1), merged = c.model
    assert.equal(documentText(merged), 'ab')
    assert.equal(moved.style.caseMap ?? 'none', secondCase ?? 'none')
    assert.equal(moved.directStyle.caseMap, expectedDirect)
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.deepEqual(c.model, merged)
    const domModel = structuredClone(before)
    domModel.paragraphs[0].runs.push(...domModel.paragraphs.pop().runs)
    const dom = new WordController(before); dom.setDocument(domModel)
    assert.deepEqual(dom.model.paragraphs[0].runs, merged.paragraphs[0].runs)
  }
})

test('unverified Unicode case-display combinations reject formatting, paste and model replacement atomically', () => {
  for (const caseMap of ['upper', 'smallCaps']) for (const text of ['ß', 'é', 'ǅ', 'İ', 'ı', 'ﬃ', 'Ω', 'а', 'ᴬ', '\u{1d400}', 'a\u0307', '\u0301']) {
    const model = createWordDocument()
    model.paragraphs[0].runs = [{ text, style: {} }]
    const c = new WordController(model), before = c.model, selected = c.selection
    assert.throws(() => c.formatText(range(0, 0, text.length), { caseMap }), /大写.*暂不支持/)
    assert.throws(() => c.replaceText(range(0, 0, 0), text, { caseMap }), /大写.*暂不支持/)
    const changed = c.model
    changed.paragraphs[0].runs[0].style.caseMap = caseMap
    assert.throws(() => c.setDocument(changed), /大写.*暂不支持/)
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selected)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('case-display language checks apply to effective cased text without banning ordinary Unicode or uncased content', () => {
  for (const caseMap of ['upper', 'smallCaps']) for (const language of ['tr', 'TR-tr', 'az-Latn', 'el-GR', 'lt-LT', 'ga-IE']) {
    const model = createWordDocument()
    model.paragraphs[0].runs = [{ text: 'ascii', style: { language } }]
    const c = new WordController(model), before = c.model
    assert.throws(() => c.formatText(range(0, 0, 5), { caseMap }), /语言/)
    assert.deepEqual(c.model, before)
    assert.equal(c.canUndo, false)
    model.paragraphs[0].runs = [{ text: '中😀✈\ufe0f漢\u{e0100}', style: { language, caseMap } }]
    assert.equal(documentText(normalizeDocument(model)), '中😀✈\ufe0f漢\u{e0100}')
  }
  const model = createWordDocument(), text = 'ßé e\u0301 αβБ中😀'
  model.paragraphs[0] = { id: 'explicit-unmapped', style: {}, sourceRun: { caseMap: 'upper', language: 'tr-TR' },
    runs: [{ text, style: { caseMap: 'none', language: 'tr-TR' }, directStyle: { caseMap: 'none' } }] }
  const c = new WordController(model)
  assert.equal(documentText(c.model), text)
  assert.equal(c.model.paragraphs[0].runs[0].directStyle.caseMap, 'none')
})

test('empty case-mapped markers allow formatting but reject unsupported insertion without losing the caret or history', () => {
  for (const caseMap of ['upper', 'smallCaps']) {
    const c = new WordController()
    c.formatText(range(0, 0, 0), { caseMap })
    const before = c.model, revision = c.revision, selection = c.selection
    assert.equal(before.paragraphs[0].marker.directStyle.caseMap, caseMap)
    for (const text of ['ß', 'e\u0301']) assert.throws(() => c.replaceText(selection, text), /大写.*暂不支持/)
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selection)
    assert.equal(c.revision, revision)
    c.replaceText(selection, 'ab😀')
    assert.equal(documentText(c.model), 'ab😀')
    assert.equal(c.model.paragraphs[0].runs[0].style.caseMap, caseMap)
    c.undo(); assert.deepEqual(c.model, before)
    c.undo(); assert.equal(c.model.paragraphs[0].marker, undefined)
    assert.equal(c.dirty, false)
  }
})

test('case-mapped and ordinary Unicode text can coexist without rewriting or over-rejecting either selection', () => {
  const model = createWordDocument()
  model.paragraphs[0].runs = [{ text: 'abc ', style: {} }, { text: 'ßé e\u0301', style: {} }]
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 3), { caseMap: 'upper' })
  assert.equal(documentText(c.model), 'abc ßé e\u0301')
  assert.equal(c.model.paragraphs[0].runs[0].style.caseMap, 'upper')
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.caseMap, undefined)
  c.undo(); assert.deepEqual(c.model, before)
})

test('resolved named-character case-map resets and direct overrides continue through End Enter', () => {
  // The importer materializes Writer's paragraph/character same-mode
  // cancellation as direct none. It must remain none after the next style
  // changes, while an entirely inherited body follows the new paragraph.
  const cases = [
    ['upper', 'none', 'none', 'smallCaps', 'none'],
    ['smallCaps', 'none', 'none', 'upper', 'none'],
    ['upper', 'smallCaps', 'smallCaps', 'none', 'smallCaps'],
    ['none', 'none', 'none', 'upper', 'none'],
    ['upper', 'upper', 'upper', 'smallCaps', 'upper'],
    ['upper', 'upper', undefined, 'smallCaps', 'smallCaps'],
  ]
  for (const [sourceCase, resolvedCase, directCase, nextCase, expected] of cases) {
    const sourceRun = { caseMap: sourceCase, fontSize: 12 }, model = createWordDocument()
    model.paragraphs[0] = { id: 'resolved-case', style: {}, sourceRun,
      runs: [{ text: 'ab', style: { ...sourceRun, caseMap: resolvedCase }, directStyle: directCase === undefined ? {} : { caseMap: directCase } }],
      nextParagraphStyle: { paragraph: {}, run: { caseMap: nextCase, fontSize: 12 }, sourceRun } }
    const c = new WordController(model), before = c.model
    c.formatText(range(0, 1, 2), { bold: true })
    c.replaceText(range(0, 2, 2), '\n')
    c.replaceText(c.selection, 'x')
    const next = c.model.paragraphs[1]
    assert.equal(documentText(c.model), 'ab\nx')
    assert.equal(next.sourceRun.caseMap, nextCase)
    assert.equal(next.runs[0].style.caseMap, expected)
    assert.equal(next.runs[0].directStyle.caseMap, directCase)
    assert.equal(next.runs[0].style.bold, true)
    c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('independent marker case mapping overlays end insertion and survives source changes, Enter and history', () => {
  for (const caseMap of ['none', 'upper', 'smallCaps']) {
    const sourceRun = { caseMap: 'smallCaps', fontSize: 12 }, model = createWordDocument()
    const marker = { style: { ...sourceRun, caseMap }, directStyle: { caseMap } }
    model.paragraphs[0] = { id: 'case-marker', style: {}, sourceRun, marker,
      runs: [{ text: 'ab', style: { ...sourceRun, caseMap: 'none' }, directStyle: { caseMap: 'none' } }] }
    const c = new WordController(model), before = c.model
    assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).style.caseMap, caseMap)
    c.replaceText(range(0, 2, 2), '\n')
    assert.deepEqual(c.model.paragraphs[0], before.paragraphs[0])
    assert.equal(c.model.paragraphs[1].marker.style.caseMap, caseMap)
    assert.equal(c.model.paragraphs[1].marker.directStyle.caseMap, caseMap)
    c.replaceText(c.selection, 'xy')
    assert.equal(documentText(c.model), 'ab\nxy')
    assert.equal(c.model.paragraphs[1].runs[0].style.caseMap, caseMap)
    const rebased = withParagraphMarkerSource(c.model.paragraphs[1].marker, { caseMap: 'upper', fontSize: 24 })
    assert.equal(rebased.style.caseMap, caseMap)
    assert.equal(rebased.directStyle.caseMap, caseMap)
    assert.equal(rebased.style.fontSize, 24)
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('kerning retains original OOXML thresholds in all layers regardless of font size or script position', () => {
  for (const kerning of [0, 0.5, 1, 12, 14, 400]) {
    const model = createWordDocument(), style = { kerning, fontSize: 1, verticalAlign: 'superscript', letterSpacing: 0.5 }
    model.paragraphs[0] = { id: 'kerning-layers', style: {}, sourceRun: style,
      marker: { style, directStyle: { kerning } },
      runs: [{ text: 'AV中😀', style, directStyle: { kerning } }],
      nextParagraphStyle: { paragraph: {}, run: style, sourceRun: style } }
    const c = new WordController(model), p = c.model.paragraphs[0]
    for (const format of [p.sourceRun, p.marker.style, p.marker.directStyle, p.runs[0].style,
      p.runs[0].directStyle, p.nextParagraphStyle.run, p.nextParagraphStyle.sourceRun]) assert.equal(format.kerning, kerning)
    c.formatText(range(0, 0, 1), { fontSize: 400, verticalAlign: 'baseline' })
    assert.equal(c.model.paragraphs[0].runs[0].style.kerning, kerning, 'font changes do not rewrite the original threshold')
    assert.equal(c.model.paragraphs[0].runs[0].style.letterSpacing, 0.5)
    assert.equal(documentText(c.model), 'AV中😀')
  }
  assert.equal(Object.hasOwn(normalizeDocument(createWordDocument()).paragraphs[0].runs[0].style, 'kerning'), false)
})

test('invalid kerning thresholds reject atomically in run, marker, source and following styles', () => {
  const c = sample(), before = c.model, selected = c.selection
  for (const kerning of [NaN, Infinity, -Infinity, '1', null, true, -0.5, 400.5, 0.25, 0.75]) {
    assert.throws(() => c.formatText(range(0, 0, 1), { kerning }), /字距阈值/)
    for (const layer of ['style', 'directStyle', 'sourceRun', 'markerStyle', 'markerDirect', 'nextRun', 'nextSource']) {
      const input = c.model, p = input.paragraphs[0]
      if (layer === 'style') p.runs[0].style.kerning = kerning
      else if (layer === 'directStyle') p.runs[0].directStyle = { kerning }
      else if (layer === 'sourceRun') p.sourceRun = { kerning }
      else if (layer === 'markerStyle') p.marker = { style: { kerning } }
      else if (layer === 'markerDirect') p.marker = { style: {}, directStyle: { kerning } }
      else if (layer === 'nextRun') p.nextParagraphStyle = { paragraph: {}, run: { kerning } }
      else p.nextParagraphStyle = { paragraph: {}, run: {}, sourceRun: { kerning } }
      assert.throws(() => c.setDocument(input), /字距阈值/)
    }
  }
  assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selected)
  assert.equal(c.canUndo, false)
  assert.equal(c.revision, 0)
})

test('partial kerning changes keep raw thresholds outside the selection and leave the independent marker untouched', () => {
  const model = createWordDocument(), sourceRun = { kerning: 14, letterSpacing: 1.15, fontSize: 8 }
  model.paragraphs[0] = { id: 'kerning-partial', style: {}, sourceRun,
    marker: { style: { ...sourceRun, kerning: 0 }, directStyle: { kerning: 0 } },
    runs: [{ text: 'AV中😀VA', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model), before = c.model, selected = range(0, 0, 2)
  c.formatText(selected, { kerning: 1 })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.kerning, run.style.letterSpacing]), [['AV', 1, 1.15], ['中😀VA', 14, 1.15]])
  assert.deepEqual(c.model.paragraphs[0].runs[0].directStyle, { kerning: 1 })
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  c.formatText(selected, { kerning: 0 })
  assert.equal(c.model.paragraphs[0].runs[0].directStyle.kerning, 0)
  assert.equal(documentText(c.model), 'AV中😀VA')
  c.undo(); assert.equal(c.model.paragraphs[0].runs[0].style.kerning, 1)
  c.undo(); assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
})

test('paragraph merges retain raw kerning thresholds and explicitly clear inherited kerning on plain text', () => {
  for (const [firstValue, secondValue, expectedDirect] of [[14, undefined, 0], [14, 12, 12], [12, 0.5, 0.5], [0, 0, undefined]]) {
    const first = { kerning: firstValue }, second = secondValue === undefined ? {} : { kerning: secondValue }
    const model = createWordDocument()
    model.paragraphs = [
      { id: 'first-kern', style: {}, sourceRun: first, runs: [{ text: 'A', style: first, directStyle: {} }] },
      { id: 'second-kern', style: {}, sourceRun: second, runs: [{ text: 'V', style: second, directStyle: {} }] },
    ]
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 1, 0, 1), '')
    const merged = c.model, moved = merged.paragraphs[0].runs.at(-1)
    assert.equal(moved.style.kerning ?? 0, secondValue ?? 0)
    assert.equal(moved.directStyle.kerning, expectedDirect)
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.deepEqual(c.model, merged)
    const domModel = structuredClone(before)
    domModel.paragraphs[0].runs.push(...domModel.paragraphs.pop().runs)
    const dom = new WordController(before); dom.setDocument(domModel)
    assert.deepEqual(dom.model.paragraphs[0].runs, merged.paragraphs[0].runs)
  }
})

test('kerning in an empty marker survives explicit disable, source changes and undo without inserting text', () => {
  const model = createWordDocument(), sourceRun = { kerning: 14, letterSpacing: -0.5 }
  model.paragraphs[0] = { id: 'empty-kern', style: {}, sourceRun,
    marker: { style: sourceRun, directStyle: { kerning: 14 } },
    runs: [{ text: '', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 0), { kerning: 0 })
  assert.equal(c.model.paragraphs[0].marker.directStyle.kerning, 0)
  assert.equal(c.model.paragraphs[0].runs[0].style.kerning, 0)
  assert.equal(c.model.paragraphs[0].runs[0].style.letterSpacing, -0.5)
  assert.equal(documentText(c.model), '')
  const rebased = withParagraphMarkerSource(c.model.paragraphs[0].marker, { kerning: 400, letterSpacing: 2 })
  assert.equal(rebased.style.kerning, 0)
  assert.equal(rebased.directStyle.kerning, 0)
  c.undo(); assert.deepEqual(c.model, before)
  c.redo(); assert.equal(c.model.paragraphs[0].marker.directStyle.kerning, 0)
})

test('named-character kerning equal to its paragraph base continues through Enter while inherited kerning follows the next style', () => {
  for (const [value, explicit, nextValue, expected] of [[14, true, 0, 14], [0, true, 14, 0], [14, false, 0, 0], [0.5, true, 14, 0.5]]) {
    const sourceRun = { kerning: value, fontSize: 8 }, model = createWordDocument()
    model.paragraphs[0] = { id: 'named-kern', style: {}, sourceRun,
      runs: [{ text: 'AV', style: sourceRun, directStyle: explicit ? { kerning: value } : {} }],
      nextParagraphStyle: { paragraph: {}, run: { kerning: nextValue, fontSize: 12 }, sourceRun } }
    const c = new WordController(model), before = c.model
    c.formatText(range(0, 0, 1), { italic: true })
    c.replaceText(range(0, 2, 2), '\n')
    c.replaceText(c.selection, 'x')
    const next = c.model.paragraphs[1]
    assert.equal(documentText(c.model), 'AV\nx')
    assert.equal(next.sourceRun.kerning, nextValue)
    assert.equal(next.runs[0].style.kerning, expected)
    assert.equal(next.runs[0].directStyle.kerning, explicit ? value : undefined)
    assert.equal(next.runs[0].style.fontSize, 12)
    c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('marker kerning overrides end insertion independently from the body and remains explicit after Enter', () => {
  for (const kerning of [0, 0.5, 14]) {
    const sourceRun = { kerning: 400, fontSize: 12 }, model = createWordDocument()
    model.paragraphs[0] = { id: 'marker-kern', style: {}, sourceRun,
      marker: { style: { ...sourceRun, kerning }, directStyle: { kerning } },
      runs: [{ text: 'AV', style: { ...sourceRun, kerning: 1 }, directStyle: { kerning: 1 } }] }
    const c = new WordController(model), before = c.model
    assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).style.kerning, kerning)
    c.replaceText(range(0, 2, 2), '\n')
    assert.deepEqual(c.model.paragraphs[0], before.paragraphs[0])
    assert.equal(c.model.paragraphs[1].marker.directStyle.kerning, kerning)
    c.replaceText(c.selection, 'VA')
    assert.equal(documentText(c.model), 'AV\nVA')
    assert.equal(c.model.paragraphs[1].runs[0].style.kerning, kerning)
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('underline paint normalizes RGB and explicit text-color paint independently in every format layer', () => {
  assert.equal(normalizeUnderlineColor('#aB12eF'), '#AB12EF')
  assert.equal(normalizeUnderlineColor('auto'), 'auto')
  const model = createWordDocument(), sourceRun = { underline: 'double', underlineColor: '#aB12eF', color: '#123456' }
  model.paragraphs[0] = { id: 'underline-paint', style: {}, sourceRun,
    marker: { style: { ...sourceRun, underline: false, underlineColor: 'auto' }, directStyle: { underline: false, underlineColor: 'auto' } },
    runs: [{ text: 'A中文😀Z', style: sourceRun, directStyle: { underline: 'double', underlineColor: '#ab12ef' } }],
    nextParagraphStyle: { paragraph: {}, run: { underline: true, underlineColor: '#eF3210' }, sourceRun } }
  const normalized = normalizeDocument(model), p = normalized.paragraphs[0]
  assert.equal(p.sourceRun.underlineColor, '#AB12EF')
  assert.equal(p.runs[0].style.underlineColor, '#AB12EF')
  assert.equal(p.runs[0].directStyle.underlineColor, '#AB12EF')
  assert.equal(p.marker.style.underlineColor, 'auto')
  assert.equal(p.marker.style.underline, false)
  assert.equal(p.nextParagraphStyle.run.underlineColor, '#EF3210')
  assert.equal(p.nextParagraphStyle.sourceRun.underlineColor, '#AB12EF')
  assert.equal(documentText(normalized), 'A中文😀Z')
  assert.deepEqual(normalizeDocument(normalized), normalized)
})

test('unsupported underline colors reject atomically in body, marker, source and following styles', () => {
  const c = sample(), before = c.model, selection = c.selection
  for (const underlineColor of ['#FFF', '#12345678', '#gg0000', 'AUTO', 'currentColor', 'none', 'transparent', 'red', '', 1, false, null, [], {}]) {
    assert.throws(() => normalizeUnderlineColor(underlineColor), /下划线颜色/)
    assert.throws(() => c.formatText(range(0, 0, 1), { bold: false, underlineColor }), /下划线颜色/)
    assert.throws(() => c.replaceText(range(0, 0, 1), 'bad', { underlineColor }), /下划线颜色/)
    for (const layer of ['style', 'directStyle', 'sourceRun', 'nextRun', 'nextSourceRun', 'marker', 'markerDirect']) {
      const malformed = structuredClone(before), p = malformed.paragraphs[0]
      if (layer === 'style' || layer === 'directStyle') p.runs[0][layer] = { underlineColor }
      else if (layer === 'sourceRun') p.sourceRun = { underlineColor }
      else if (layer === 'nextRun' || layer === 'nextSourceRun') p.nextParagraphStyle = { paragraph: {}, run: layer === 'nextRun' ? { underlineColor } : {}, ...(layer === 'nextSourceRun' ? { sourceRun: { underlineColor } } : {}) }
      else p.marker = layer === 'marker' ? { style: { underlineColor } } : { style: {}, directStyle: { underlineColor } }
      assert.throws(() => c.setDocument(malformed), /下划线颜色/)
    }
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selection)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('partial underline recoloring preserves text paint, strike, line type and the independent marker', () => {
  const model = createWordDocument(), sourceRun = { underline: 'double', underlineColor: '#CC0000', color: '#123456', strike: 'double', verticalAlign: 'superscript' }
  model.paragraphs[0] = { id: 'partial-paint', style: {}, sourceRun,
    marker: { style: { ...sourceRun, underline: false, underlineColor: '#FFFF00' }, directStyle: { underline: false, underlineColor: '#FFFF00' } },
    runs: [{ text: 'A中文😀Z', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model), before = c.model, selected = range(0, 1, 5)
  c.formatText(selected, { underlineColor: '#0088ff' })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.underlineColor]), [['A', '#CC0000'], ['中文😀', '#0088FF'], ['Z', '#CC0000']])
  const changed = c.model.paragraphs[0].runs[1]
  assert.deepEqual(changed.style, { ...sourceRun, underlineColor: '#0088FF' })
  assert.deepEqual(changed.directStyle, { underline: 'double', underlineColor: '#0088FF' })
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  c.formatText(selected, { color: '#00AA00', strike: 'none' })
  assert.equal(c.model.paragraphs[0].runs[1].style.underlineColor, '#0088FF')
  c.formatText(selected, { underlineColor: 'auto' })
  assert.equal(c.model.paragraphs[0].runs[1].style.underlineColor, 'auto')
  assert.equal(c.model.paragraphs[0].runs[1].style.underline, 'double')
  assert.equal(c.model.paragraphs[0].runs[1].style.color, '#00AA00')
  assert.equal(documentText(c.model), 'A中文😀Z')
  c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
})

test('disabling and restoring an underline preserves its latent RGB paint through deletion and typing', () => {
  const model = createWordDocument(), sourceRun = { underline: 'double', underlineColor: '#C01020', color: '#002244' }
  model.paragraphs[0] = { id: 'latent-paint', style: {}, sourceRun, runs: [{ text: 'AV', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 2), { underline: false })
  assert.equal(c.model.paragraphs[0].runs[0].style.underlineColor, '#C01020')
  assert.deepEqual(c.model.paragraphs[0].runs[0].directStyle, { underline: false, underlineColor: '#C01020' })
  c.replaceText(range(0, 0, 2), '')
  c.formatText(range(0, 0, 0), { underline: true })
  c.replaceText(c.selection, '新😀')
  const run = c.model.paragraphs[0].runs[0]
  assert.equal(run.style.underline, true)
  assert.equal(run.style.underlineColor, '#C01020')
  assert.equal(run.style.color, '#002244')
  c.undo(); c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('underline line and paint continue as one explicit item across end Enter while pure inheritance follows the next style', () => {
  for (const [source, direct, expected] of [
    [{ underline: true, underlineColor: '#CC0000' }, { underline: true, underlineColor: '#CC0000' }, [true, '#CC0000']],
    [{ underline: true, underlineColor: '#CC0000' }, {}, ['double', '#00CC00']],
    [{ underline: 'double' }, { underline: 'double' }, ['double', 'auto']],
    [{ underline: true, underlineColor: '#CC0000' }, { underline: false, underlineColor: '#0000CC' }, [false, '#0000CC']],
    [{ underline: true, underlineColor: '#CC0000' }, { underline: true, underlineColor: 'auto' }, [true, 'auto']],
  ]) {
    const model = createWordDocument(), sourceRun = { ...source, color: '#123456' }
    model.paragraphs[0] = { id: 'follow-paint', style: {}, sourceRun,
      runs: [{ text: 'AV', style: { ...sourceRun, ...direct }, directStyle: direct }],
      nextParagraphStyle: { paragraph: {}, run: { underline: 'double', underlineColor: '#00CC00', color: '#665544' } } }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 2, 2), '\n')
    c.replaceText(c.selection, 'x')
    const run = c.model.paragraphs[1].runs[0]
    assert.deepEqual([run.style.underline, run.style.underlineColor], expected)
    assert.equal(run.style.color, '#665544')
    assert.equal(documentText(c.model), 'AV\nx')
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('a color-only edit pins the current inherited underline line through the following paragraph style', () => {
  for (const underline of [false, true, 'double']) {
    const model = createWordDocument(), sourceRun = { underline, underlineColor: '#CC0000' }
    model.paragraphs[0] = { id: 'color-only', style: {}, sourceRun,
      runs: [{ text: 'ab', style: sourceRun, directStyle: {} }],
      nextParagraphStyle: { paragraph: {}, run: { underline: underline === 'double' ? true : 'double', underlineColor: '#00CC00' } } }
    const c = new WordController(model)
    c.formatText(range(0, 1, 2), { underlineColor: '#0000CC' })
    assert.deepEqual(c.model.paragraphs[0].runs.at(-1).directStyle, { underline, underlineColor: '#0000CC' })
    c.replaceText(range(0, 2, 2), '\n')
    c.replaceText(c.selection, 'x')
    assert.equal(c.model.paragraphs[1].runs[0].style.underline, underline)
    assert.equal(c.model.paragraphs[1].runs[0].style.underlineColor, '#0000CC')
  }
})

test('joining paragraphs preserves colored, latent and automatic underline paint without changing text color', () => {
  for (const [firstPaint, secondPaint, secondLine] of [['#CC0000', undefined, true], ['#CC0000', 'auto', 'double'], ['#CC0000', '#0000CC', false], ['auto', '#CC0000', true]]) {
    const first = { underline: true, underlineColor: firstPaint, color: '#123456' }, second = { underline: secondLine, ...(secondPaint !== undefined ? { underlineColor: secondPaint } : {}), color: '#123456' }
    const model = createWordDocument()
    model.paragraphs = [
      { id: 'first-paint', style: {}, sourceRun: first, runs: [{ text: 'A', style: first, directStyle: {} }] },
      { id: 'second-paint', style: {}, sourceRun: second, runs: [{ text: 'B', style: second, directStyle: {} }] },
    ]
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 1, 0, 1), '')
    const moved = c.model.paragraphs[0].runs.at(-1)
    assert.equal(moved.style.underline, secondLine)
    assert.equal(moved.style.underlineColor, secondPaint ?? 'auto')
    assert.deepEqual(moved.directStyle, { underline: secondLine, underlineColor: secondPaint ?? 'auto' })
    assert.equal(moved.style.color, '#123456')
    const merged = c.model
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.deepEqual(c.model, merged)
    const joined = structuredClone(before); joined.paragraphs[0].runs.push(...joined.paragraphs.pop().runs)
    const dom = new WordController(before); dom.setDocument(joined)
    assert.deepEqual(dom.model.paragraphs[0].runs, merged.paragraphs[0].runs)
  }
})

test('empty marker recoloring and automatic reset survive typing and retain latent paint independently', () => {
  const model = createWordDocument(), sourceRun = { underline: 'double', underlineColor: '#CC0000', strike: 'single', color: '#123456' }
  model.paragraphs[0] = { id: 'empty-paint', style: {}, sourceRun,
    marker: { style: sourceRun, directStyle: {} }, runs: [{ text: '', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 0), { underlineColor: '#0033CC' })
  assert.deepEqual(c.model.paragraphs[0].marker.directStyle, { underline: 'double', underlineColor: '#0033CC' })
  c.formatText(range(0, 0, 0), { underline: false })
  assert.equal(c.model.paragraphs[0].marker.style.underlineColor, '#0033CC')
  c.formatText(range(0, 0, 0), { underlineColor: 'auto' })
  c.replaceText(c.selection, 'x')
  assert.equal(c.model.paragraphs[0].runs[0].style.underline, false)
  assert.equal(c.model.paragraphs[0].runs[0].style.underlineColor, 'auto')
  assert.equal(c.model.paragraphs[0].runs[0].style.strike, 'single')
  c.undo(); c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('marker underline overrides replace the adjacent underline item without replacing body text paint', () => {
  const body = { underline: 'double', underlineColor: '#CC0000', color: '#123456', strike: 'double' }
  for (const marker of [
    { style: { underline: true }, directStyle: { underline: true } },
    { style: { underline: false, underlineColor: '#0000CC' }, directStyle: { underlineColor: '#0000CC' } },
  ]) {
    const paragraph = { id: 'marker-item', style: {}, marker, runs: [{ text: 'AV', style: body, directStyle: body }] }
    const format = paragraphInsertionFormat(paragraph)
    assert.equal(format.style.underline, marker.style.underline)
    assert.equal(format.style.underlineColor, marker.style.underlineColor ?? 'auto')
    assert.equal(format.style.color, '#123456')
    assert.equal(format.style.strike, 'double')
    const followed = withParagraphMarkerSource(marker, { underline: 'double', underlineColor: '#00CC00', color: '#665544' })
    assert.equal(followed.style.underline, marker.style.underline)
    assert.equal(followed.style.underlineColor, marker.style.underlineColor ?? 'auto')
    assert.equal(followed.style.color, '#665544')
  }
})

test('whole-body recoloring stores the selected underline type on a reset marker instead of its paragraph type', () => {
  for (const markerLine of [false, true]) {
    const sourceRun = { underline: false, color: '#123456', fontSize: 12 }, model = createWordDocument()
    model.paragraphs[0] = { id: 'whole-color-marker', style: {}, sourceRun,
      marker: { style: { ...sourceRun, underline: markerLine, underlineColor: '#00CC00', fontSize: 30 }, directStyle: { underline: markerLine, underlineColor: '#00CC00', fontSize: 30 } },
      runs: [{ text: 'ABC', style: { ...sourceRun, underline: 'double', underlineColor: '#CC0000', fontSize: 18 }, directStyle: { underline: 'double', underlineColor: '#CC0000', fontSize: 18 } }],
      nextParagraphStyle: { paragraph: {}, run: { underline: false, color: '#665544', fontSize: 10 } } }
    const c = new WordController(model), before = c.model
    c.formatText(range(0, 0, 3), { underlineColor: '#0000CC' })
    assert.deepEqual(c.model.paragraphs[0].marker, { style: { ...sourceRun, underline: 'double', underlineColor: '#0000CC' }, directStyle: { underline: 'double', underlineColor: '#0000CC' } })
    assert.equal(c.model.paragraphs[0].runs[0].style.fontSize, 18, 'body keeps unrelated attributes when the imported marker is reset')
    const colored = c.model
    c.replaceText(range(0, 3, 3), 'x')
    assert.equal(c.model.paragraphs[0].runs.at(-1).style.underline, 'double')
    assert.equal(c.model.paragraphs[0].runs.at(-1).style.underlineColor, '#0000CC')
    c.undo(); assert.deepEqual(c.model, colored)
    c.replaceText(range(0, 3, 3), '\n'); c.replaceText(c.selection, 'x')
    assert.equal(c.model.paragraphs[1].marker.style.underline, 'double')
    assert.equal(c.model.paragraphs[1].runs[0].style.underline, 'double')
    assert.equal(c.model.paragraphs[1].runs[0].style.underlineColor, '#0000CC')
    c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('whole-body text-color underline reset retains the selected line type and accumulates prior hard marker attributes', () => {
  const model = createWordDocument(), sourceRun = { underline: false, color: '#123456' }
  model.paragraphs[0] = { id: 'whole-auto-marker', style: {}, sourceRun,
    marker: { style: { ...sourceRun, underline: true, underlineColor: '#00CC00', italic: true }, directStyle: { underline: true, underlineColor: '#00CC00', italic: true } },
    runs: [{ text: 'ABC', style: { ...sourceRun, underline: 'double', underlineColor: '#CC0000' }, directStyle: { underline: 'double', underlineColor: '#CC0000' } }] }
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 3), { bold: true })
  c.formatText(range(0, 0, 3), { underlineColor: 'auto' })
  const p = c.model.paragraphs[0]
  assert.deepEqual(p.marker.directStyle, { bold: true, underline: 'double', underlineColor: 'auto' })
  assert.equal(p.marker.style.italic, undefined)
  assert.equal(p.runs[0].style.underline, 'double')
  assert.equal(p.runs[0].style.underlineColor, 'auto')
  c.replaceText(range(0, 3, 3), 'x')
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.underlineColor, 'auto')
  c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('custom baseline offsets use a single integer-percent alignment slot and normalize zero to baseline', () => {
  assert.deepEqual(BASELINE_OFFSET_LIMITS, { min: -100, max: 100, step: 1 })
  for (const value of [-100, -25, -13, -4, 4, 13, 25, 100]) assert.equal(normalizeVerticalAlign(value), value)
  for (const value of [0, -0]) assert.equal(normalizeVerticalAlign(value), 'baseline')
  for (const value of ['baseline', 'superscript', 'subscript']) {
    assert.equal(normalizeVerticalAlign(value), value)
    assert.equal(normalizeSourceVerticalAlign(value), value)
  }
  for (const value of [-101, 101, 0.5, NaN, Infinity, '25', '25%', null, false]) assert.throws(() => normalizeVerticalAlign(value))
  for (const value of [-25, 0, 25]) assert.throws(() => normalizeSourceVerticalAlign(value))
})

test('a partial custom offset replaces standard script without scaling glyphs or changing independent paint', () => {
  const model = createWordDocument(), style = { fontSize: 12, verticalAlign: 'superscript', underline: 'double', underlineColor: '#123456', strike: 'single' }
  model.paragraphs[0] = { id: 'partial-offset', style: {}, marker: { style: { italic: true }, directStyle: { italic: true } }, runs: [{ text: 'A😀BC', style, directStyle: style }] }
  const c = new WordController(model), before = c.model, selected = range(0, 1, 3)
  c.formatText(selected, { verticalAlign: -25 })
  assert.deepEqual(c.model.paragraphs[0].runs.map(run => [run.text, run.style.verticalAlign, run.style.fontSize]), [['A', 'superscript', 12], ['😀', -25, 12], ['BC', 'superscript', 12]])
  assert.equal(c.model.paragraphs[0].runs[1].style.underlineColor, '#123456')
  assert.equal(c.model.paragraphs[0].runs[1].style.strike, 'single')
  assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
  c.formatText(selected, { verticalAlign: 0 })
  assert.equal(c.model.paragraphs[0].runs[1].style.verticalAlign, 'baseline')
  c.formatText(selected, { verticalAlign: 'subscript' })
  assert.equal(c.model.paragraphs[0].runs[1].style.verticalAlign, 'subscript')
  c.undo(); c.undo(); c.undo()
  assert.deepEqual(c.model, before)
  assert.deepEqual(c.selection, selected)
})

test('numeric paragraph and named-character sources reject atomically instead of inventing style offset semantics', () => {
  const c = sample(), before = c.model
  for (const value of [-25, 0, 25]) for (const location of ['sourceRun', 'nextRun', 'nextSourceRun', 'runSource', 'markerSource']) {
    const modified = structuredClone(before), p = modified.paragraphs[0]
    if (location === 'sourceRun') p.sourceRun = { verticalAlign: value }
    else if (location === 'nextRun') p.nextParagraphStyle = { paragraph: {}, run: { verticalAlign: value } }
    else if (location === 'nextSourceRun') p.nextParagraphStyle = { paragraph: {}, run: {}, sourceRun: { verticalAlign: value } }
    else if (location === 'runSource') p.runs[0].sourceVerticalAlign = value
    else p.marker = { style: {}, sourceVerticalAlign: value }
    assert.throws(() => c.setDocument(modified), location)
    assert.deepEqual(c.model, before)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('invalid custom offsets cannot partly commit through direct body or marker layers', () => {
  const c = sample(), before = c.model, selection = c.selection
  for (const value of [-101, 101, 1.5, NaN, Infinity]) {
    assert.throws(() => c.formatText(range(0, 0, 2), { bold: false, verticalAlign: value }))
    for (const location of ['style', 'directStyle', 'markerStyle', 'markerDirect']) {
      const modified = structuredClone(before), p = modified.paragraphs[0]
      if (location === 'style' || location === 'directStyle') p.runs[0][location] = { verticalAlign: value }
      else p.marker = { style: location === 'markerStyle' ? { verticalAlign: value } : {}, ...(location === 'markerDirect' ? { directStyle: { verticalAlign: value } } : {}) }
      assert.throws(() => c.setDocument(modified), location)
    }
    assert.deepEqual(c.model, before)
    assert.deepEqual(c.selection, selection)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
})

test('resizing custom-offset text preserves its session percentage and insertion format', () => {
  const model = createWordDocument(), style = { fontSize: 12, verticalAlign: 4 }
  model.paragraphs[0] = { id: 'resize-offset', style: {}, runs: [{ text: 'AB', style, directStyle: style }] }
  const c = new WordController(model), before = c.model
  for (const fontSize of [18, 1]) {
    c.formatText(range(0, 0, 2), { fontSize })
    assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 4)
    assert.equal(c.model.paragraphs[0].runs[0].style.fontSize, fontSize)
    c.replaceText(range(0, 2, 2), 'x')
    assert.equal(c.model.paragraphs[0].runs.at(-1).style.verticalAlign, 4)
    assert.equal(c.model.paragraphs[0].runs.at(-1).style.fontSize, fontSize)
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('imported body-only custom offsets clear at End Enter while inherited or named script continues', () => {
  for (const sourceVerticalAlign of [undefined, 'superscript', 'subscript', 'baseline']) {
    const sourceRun = { fontSize: 12, verticalAlign: 'superscript' }, model = createWordDocument()
    model.paragraphs[0] = { id: 'body-only-offset', style: {}, sourceRun,
      marker: { style: sourceRun, directStyle: {} },
      runs: [{ text: 'AB', style: { ...sourceRun, verticalAlign: 25 }, directStyle: { verticalAlign: 25 }, ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}) }],
      nextParagraphStyle: { paragraph: {}, run: { fontSize: 18, verticalAlign: 'subscript' } } }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 2, 2), '\n')
    const successor = c.model.paragraphs[1]
    assert.equal(successor.runs[0].style.verticalAlign, sourceVerticalAlign ?? 'subscript')
    assert.equal(successor.runs[0].directStyle.verticalAlign, undefined)
    assert.equal(successor.marker.style.verticalAlign, sourceVerticalAlign ?? 'subscript')
    c.replaceText(c.selection, 'x')
    assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, sourceVerticalAlign ?? 'subscript')
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('whole-body offset commands replace an imported marker and preserve their session offset through End Enter', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12 }
  model.paragraphs[0] = { id: 'whole-offset', style: {}, sourceRun,
    marker: { style: { ...sourceRun, bold: true }, directStyle: { bold: true } },
    runs: [{ text: 'BODY', style: sourceRun, directStyle: {} }],
    nextParagraphStyle: { paragraph: {}, run: { fontSize: 18, verticalAlign: 'subscript' } } }
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 4), { verticalAlign: 25 })
  assert.deepEqual(c.model.paragraphs[0].marker, { style: { ...sourceRun, verticalAlign: 25 }, directStyle: { verticalAlign: 25 } })
  c.replaceText(range(0, 4, 4), 'x')
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.verticalAlign, 25)
  c.replaceText(c.selection, '\n'); c.replaceText(c.selection, 'x')
  assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, 25)
  assert.equal(c.model.paragraphs[1].marker.style.verticalAlign, 25)
  assert.equal(c.model.paragraphs[1].runs[0].style.fontSize, 18)
  c.undo(); c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('a middle Enter preserves direct custom offsets without turning them into paragraph style sources', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12 }, style = { ...sourceRun, verticalAlign: -25 }
  model.paragraphs[0] = { id: 'split-offset', style: {}, sourceRun,
    marker: { style: sourceRun, directStyle: {} }, runs: [{ text: 'ABCD', style, directStyle: { verticalAlign: -25 } }] }
  const c = new WordController(model), before = c.model
  c.replaceText(range(0, 2, 2), '\n')
  assert.deepEqual(c.model.paragraphs.map(p => [p.runs[0].text, p.runs[0].style.verticalAlign, p.runs[0].directStyle.verticalAlign]), [['AB', -25, -25], ['CD', -25, -25]])
  assert.deepEqual(c.model.paragraphs.map(p => p.sourceRun), [sourceRun, sourceRun])
  c.replaceText(range(0, 2, 0, 1), '')
  assert.equal(documentText(c.model), 'ABCD')
  assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, -25)
  c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('joining differently styled paragraphs keeps custom offsets direct and retains explicit baseline resets', () => {
  for (const align of [-25, 25, 'baseline']) {
    const model = createWordDocument(), firstSource = { fontSize: 12, verticalAlign: 'superscript' }, secondSource = { fontSize: 18, verticalAlign: 'subscript' }
    model.paragraphs = [
      { id: 'offset-first', style: {}, sourceRun: firstSource, runs: [{ text: 'A', style: firstSource, directStyle: {} }] },
      { id: 'offset-second', style: {}, sourceRun: secondSource, runs: [{ text: 'B', style: { ...secondSource, verticalAlign: align }, directStyle: { verticalAlign: align } }] },
    ]
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 1, 0, 1), '')
    const moved = c.model.paragraphs[0].runs.at(-1)
    assert.equal(moved.style.verticalAlign, align)
    assert.equal(moved.directStyle.verticalAlign, align)
    assert.equal(moved.style.fontSize, 18)
    assert.equal(moved.directStyle.fontSize, 18)
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); assert.equal(c.model.paragraphs[0].runs.at(-1).style.verticalAlign, align)
  }
})

test('an empty-caret offset command remains active after typing and Enter in the same session', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12 }
  model.paragraphs[0] = { id: 'empty-offset', style: {}, sourceRun,
    marker: { style: sourceRun, directStyle: {} }, runs: [{ text: '', style: sourceRun, directStyle: {} }],
    nextParagraphStyle: { paragraph: {}, run: { fontSize: 18 } } }
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 0), { verticalAlign: 25 })
  assert.equal(c.model.paragraphs[0].marker.style.verticalAlign, 25)
  assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
  c.replaceText(c.selection, 'x'); c.replaceText(c.selection, '\n'); c.replaceText(c.selection, 'y')
  assert.equal(documentText(c.model), 'x\ny')
  assert.deepEqual(c.model.paragraphs.map(p => p.runs[0].style.verticalAlign), [25, 25])
  assert.deepEqual(c.model.paragraphs.map(p => p.marker.style.verticalAlign), [25, 25])
  assert.equal(c.model.paragraphs[1].runs[0].style.fontSize, 18)
  c.undo(); c.undo(); c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('deleting all text after an offset command retains the session insertion offset and remains undoable', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12 }
  model.paragraphs[0] = { id: 'delete-offset', style: {}, sourceRun,
    marker: { style: sourceRun, directStyle: {} }, runs: [{ text: 'BODY', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model), before = c.model
  c.formatText(range(0, 0, 4), { verticalAlign: 25 })
  c.replaceText(range(0, 0, 4), '')
  assert.equal(documentText(c.model), '')
  assert.equal(c.model.paragraphs[0].marker.style.verticalAlign, 25)
  assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
  const emptySession = c.model
  c.replaceText(c.selection, 'x')
  assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
  c.undo(); assert.deepEqual(c.model, emptySession)
  c.undo(); c.undo(); assert.deepEqual(c.model, before)
})

test('custom offsets accept only the verified effective font families with matching regional metrics', () => {
  assert.deepEqual(BASELINE_OFFSET_FONTS, ['Times New Roman', 'DejaVu Sans', 'Liberation Serif'])
  for (const fontName of [undefined, ...BASELINE_OFFSET_FONTS, 'times new roman', 'DEJAVU SANS']) {
    const model = createWordDocument(), style = { verticalAlign: 25, ...(fontName !== undefined ? { fontName, fontNameEastAsia: fontName.toUpperCase() } : {}) }
    model.paragraphs[0] = { id: 'verified-offset-font', style: {}, marker: { style, directStyle: style }, runs: [{ text: 'Aa中文😀', style, directStyle: style }] }
    const c = new WordController(model)
    assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
    assert.equal(c.model.paragraphs[0].marker.style.verticalAlign, 25)
  }
})

test('custom offsets reject unverified or different East Asian fonts after inherited styles resolve', () => {
  for (const fonts of [
    { fontName: 'Arial' },
    { fontName: 'Noto Sans CJK SC', fontNameEastAsia: 'Noto Sans CJK SC' },
    { fontName: 'Times New Roman', fontNameEastAsia: 'DejaVu Sans' },
    { fontNameEastAsia: 'Noto Sans CJK SC' },
  ]) for (const inherited of [false, true]) {
    const model = createWordDocument(), base = { fontSize: 12, ...fonts }
    model.paragraphs[0] = { id: 'unverified-offset-font', style: {}, ...(inherited ? { sourceRun: base } : {}),
      marker: { style: base, directStyle: inherited ? {} : base }, runs: [{ text: 'ABC中文', style: base, directStyle: inherited ? {} : base }] }
    const c = new WordController(model), before = c.model
    assert.throws(() => c.formatText(range(0, 3, 4), { verticalAlign: 25 }), /字体/)
    assert.deepEqual(c.model, before)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
    const changed = structuredClone(before)
    changed.paragraphs[0].marker.style.verticalAlign = 25
    changed.paragraphs[0].marker.directStyle.verticalAlign = 25
    if (['Arial', 'Noto Sans CJK SC'].includes(fonts.fontName)) {
      assert.throws(() => c.setDocument(changed), /字体/)
      assert.deepEqual(c.model, before)
    } else {
      c.setDocument(changed)
      assert.equal(c.model.paragraphs[0].marker.style.verticalAlign, 25, 'a marker does not use its East Asian family until non-ASCII text is inserted')
    }
  }
})

test('font edits cannot leave existing custom offsets with unsupported metrics and clearing the offset permits the edit', () => {
  const model = createWordDocument(), style = { fontSize: 12, fontName: 'DejaVu Sans', verticalAlign: 25 }
  model.paragraphs[0] = { id: 'offset-font-change', style: {}, runs: [{ text: '中B', style, directStyle: style }] }
  const c = new WordController(model), before = c.model
  for (const patch of [{ fontName: 'Arial' }, { fontNameEastAsia: 'Times New Roman' }]) {
    assert.throws(() => c.formatText(range(0, 0, 1), patch), /字体/)
    assert.deepEqual(c.model, before)
    assert.equal(c.canUndo, false)
  }
  c.formatText(range(0, 0, 1), { verticalAlign: 0, fontName: 'Arial' })
  assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 'baseline')
  assert.equal(c.model.paragraphs[0].runs[0].style.fontName, 'Arial')
  c.undo(); assert.deepEqual(c.model, before)
})

test('a multi-paragraph custom-offset command rejects atomically when any selected effective font is unsupported', () => {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'verified-font', style: {}, runs: [{ text: 'ABC', style: { fontName: 'Liberation Serif' } }] },
    { id: 'unverified-font', style: {}, runs: [{ text: 'DEF', style: { fontName: 'Arial' } }] },
  ]
  const c = new WordController(model), before = c.model
  assert.throws(() => c.formatText(range(0, 0, 3, 1), { verticalAlign: -25, color: '#123456' }), /字体/)
  assert.deepEqual(c.model, before)
  assert.equal(c.revision, 0)
  assert.equal(c.canUndo, false)
})

test('an unused different East Asian font allows ASCII custom offsets but rejects subsequent non-ASCII insertion atomically', () => {
  const model = createWordDocument(), style = { fontSize: 12, fontName: 'DejaVu Sans', fontNameEastAsia: 'Noto Sans CJK SC', verticalAlign: 25 }
  model.paragraphs[0] = { id: 'ascii-offset-regional-font', style: {}, runs: [{ text: 'A\tB\nC', style, directStyle: style }] }
  const c = new WordController(model), before = c.model
  for (const text of ['中', '😀', 'é', 'Ω']) {
    assert.throws(() => c.replaceText(range(0, 1, 1), text), /字体/)
    assert.deepEqual(c.model, before)
    assert.equal(c.revision, 0)
    assert.equal(c.canUndo, false)
  }
  c.replaceText(range(0, 1, 1), 'x')
  assert.equal(documentText(c.model), 'Ax\tB\nC')
  assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
})

test('empty numeric markers allow an unused regional font and validate the actual text on typing', () => {
  const model = createWordDocument(), sourceRun = { fontSize: 12, fontName: 'Times New Roman', fontNameEastAsia: 'Noto Sans CJK SC' }
  model.paragraphs[0] = { id: 'empty-offset-regional-font', style: {}, sourceRun,
    marker: { style: sourceRun, directStyle: {} }, runs: [{ text: '', style: sourceRun, directStyle: {} }] }
  const c = new WordController(model)
  c.formatText(range(0, 0, 0), { verticalAlign: 25 })
  const emptySession = c.model, revision = c.revision
  assert.throws(() => c.replaceText(c.selection, '中😀'), /字体/)
  assert.deepEqual(c.model, emptySession)
  assert.equal(c.revision, revision)
  c.replaceText(c.selection, 'ASCII')
  assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
  c.undo(); assert.deepEqual(c.model, emptySession)
})

test('deleting imported numeric text preserves a live caret offset without replacing an independent script or size marker', () => {
  const base = { fontSize: 12, fontName: 'DejaVu Sans' }
  for (const markerDirect of [{}, { verticalAlign: 'superscript' }, { fontSize: 24, bold: true }]) {
    const model = createWordDocument(), marker = { style: { ...base, ...markerDirect }, directStyle: markerDirect }
    model.paragraphs[0] = { id: 'delete-native-offset', style: {}, sourceRun: base, marker,
      runs: [{ text: 'BODY', style: { ...base, verticalAlign: 25 }, directStyle: { fontSize: 12, verticalAlign: 25 } }] }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 0, 4), '')
    const empty = c.model.paragraphs[0], insertion = paragraphInsertionFormat(empty)
    assert.deepEqual(empty.marker, before.paragraphs[0].marker, 'the persistent marker remains independent from the live caret')
    assert.equal(empty.runs[0].style.verticalAlign, 25)
    assert.equal(empty.runs[0].style.fontSize, 12)
    assert.equal(empty.runs[0].style.bold, markerDirect.bold)
    assert.equal(insertion.style.verticalAlign, 25)
    assert.equal(insertion.style.fontSize, 12)
    const emptySession = c.model
    c.replaceText(c.selection, 'x')
    const typed = c.model.paragraphs[0]
    assert.equal(typed.runs[0].style.verticalAlign, 25)
    assert.equal(typed.runs[0].style.fontSize, 12)
    assert.equal(typed.runs[0].style.bold, markerDirect.bold)
    assert.deepEqual(typed.marker, before.paragraphs[0].marker)
    c.undo(); assert.deepEqual(c.model, emptySession)
    c.undo(); assert.deepEqual(c.model, before)
    c.redo(); c.redo(); assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
  }
})

test('an explicit baseline marker cancels a deleted numeric offset while ordinary empty marker authority is unchanged', () => {
  const base = { fontSize: 12, fontName: 'DejaVu Sans' }, model = createWordDocument()
  for (const bodyAlignment of [25, 'superscript']) {
    const markerDirect = { verticalAlign: 'baseline', bold: true }
    model.paragraphs[0] = { id: 'delete-reset-offset', style: {}, sourceRun: base,
      marker: { style: { ...base, ...markerDirect }, directStyle: markerDirect },
      runs: [{ text: 'BODY', style: { ...base, verticalAlign: bodyAlignment }, directStyle: { verticalAlign: bodyAlignment } }] }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 0, 4), '')
    assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 'baseline')
    assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).style.verticalAlign, 'baseline')
    assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
    c.replaceText(c.selection, 'x')
    assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 'baseline')
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('numeric deletion retains named-body provenance and keeps a marker-free insertion undoable', () => {
  const base = { fontSize: 12, fontName: 'DejaVu Sans' }
  for (const hasMarker of [false, true]) {
    const model = createWordDocument()
    model.paragraphs[0] = { id: 'delete-offset-provenance', style: {}, sourceRun: base,
      ...(hasMarker ? { marker: { style: { ...base, italic: true }, directStyle: { italic: true } } } : {}),
      runs: [{ text: 'BODY', style: { ...base, verticalAlign: 25 }, directStyle: { verticalAlign: 25 }, sourceVerticalAlign: 'superscript' }] }
    const c = new WordController(model), before = c.model
    c.replaceText(range(0, 0, 4), '')
    assert.equal(c.model.paragraphs[0].runs[0].sourceVerticalAlign, 'superscript')
    assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).sourceVerticalAlign, 'superscript')
    c.replaceText(c.selection, 'x')
    assert.equal(c.model.paragraphs[0].runs[0].sourceVerticalAlign, 'superscript')
    assert.equal(c.model.paragraphs[0].runs[0].style.verticalAlign, 25)
    assert.equal(c.model.paragraphs[0].runs[0].style.italic, hasMarker ? true : undefined)
    assert.deepEqual(c.model.paragraphs[0].marker, before.paragraphs[0].marker)
    c.undo(); c.undo(); assert.deepEqual(c.model, before)
  }
})

test('numeric deletion keeps two separate inputs and cursor returns distinct from an ordinary imported End', () => {
  const base = { fontSize: 12, fontName: 'DejaVu Sans' }
  for (const markerDirect of [{ verticalAlign: 'superscript' }, { fontSize: 24, bold: true }, { verticalAlign: 'baseline' }]) {
    const model = createWordDocument()
    model.paragraphs[0] = { id: 'continued-offset', style: {}, sourceRun: base,
      marker: { style: { ...base, ...markerDirect }, directStyle: markerDirect },
      runs: [{ text: 'BODY', style: { ...base, verticalAlign: 25 }, directStyle: { fontSize: 12, verticalAlign: 25 } }],
      nextParagraphStyle: { paragraph: {}, run: base } }
    const c = new WordController(model), before = c.model, marker = before.paragraphs[0].marker
    c.replaceText(range(0, 0, 4), '')
    const baseline = markerDirect.verticalAlign === 'baseline'
    for (const text of ['x', 'y']) {
      c.setSelection(c.selection)
      c.replaceText(c.selection, text)
      assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).style.verticalAlign, baseline ? 'baseline' : 25)
      assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).style.fontSize, 12)
      assert.deepEqual(c.model.paragraphs[0].marker, marker)
    }
    const typed = c.model, revision = c.revision
    c.markSaved()
    c.setSelection(range(0, 1, 1)); c.setSelection(range(0, 2, 2))
    assert.deepEqual(c.model, typed, 'moving away and returning preserves native session insertion provenance')
    assert.equal(c.revision, revision); assert.equal(c.dirty, false)
    c.replaceText(c.selection, '\n')
    assert.deepEqual(c.model.paragraphs[1].marker, marker, 'Enter must not materialize the live caret over the independent mark')
    c.setSelection(c.selection)
    c.replaceText(c.selection, 'z')
    assert.equal(documentText(c.model), 'xy\nz')
    const successor = c.model.paragraphs[1].runs[0]
    assert.equal(successor.style.verticalAlign ?? 'baseline', 'baseline')
    assert.equal(successor.style.fontSize, 12)
    assert.equal(successor.style.bold, markerDirect.bold)
    for (let i = 0; i < 5; i++) c.undo()
    assert.deepEqual(c.model, before)
    for (let i = 0; i < 5; i++) c.redo()
    assert.equal(documentText(c.model), 'xy\nz')
    assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign ?? 'baseline', 'baseline')

    const imported = new WordController(model)
    imported.setSelection(range(0, 4, 4))
    for (const text of ['x', 'y']) { imported.replaceText(imported.selection, text); imported.setSelection(imported.selection) }
    const end = imported.model.paragraphs[0].runs.at(-1)
    assert.equal(end.style.verticalAlign, markerDirect.verticalAlign ?? 25)
    assert.equal(end.style.fontSize, markerDirect.fontSize ?? 12)
    assert.equal(imported.model.paragraphs[0].sessionInsertion, undefined)
  }
})

test('session insertion validates atomically and stays outside the saved document signature', () => {
  const base = { fontSize: 12, fontName: 'DejaVu Sans' }, model = createWordDocument()
  model.paragraphs[0] = { id: 'session-validation', style: {}, sourceRun: base,
    marker: { style: { ...base, verticalAlign: 'superscript' }, directStyle: { verticalAlign: 'superscript' } },
    runs: [{ text: 'BODY', style: { ...base, verticalAlign: 25 }, directStyle: { fontSize: 12, verticalAlign: 25 } }] }
  const c = new WordController(model)
  c.replaceText(range(0, 0, 4), ''); c.replaceText(c.selection, 'x'); c.markSaved()
  const before = c.model, selected = c.selection, revision = c.revision
  for (const sessionInsertion of [null, [], { style: {}, unknown: true }, { style: { verticalAlign: 101 } }, { style: { verticalAlign: 25, fontName: 'Noto Sans' } }]) {
    const invalid = c.model; invalid.paragraphs[0].sessionInsertion = sessionInsertion
    assert.throws(() => c.setDocument(invalid))
    assert.deepEqual(c.model, before); assert.deepEqual(c.selection, selected)
    assert.equal(c.revision, revision); assert.equal(c.dirty, false)
  }
  const detached = c.model; delete detached.paragraphs[0].sessionInsertion
  c.setDocument(detached)
  assert.equal(c.dirty, false, 'session-only provenance changes are not unsaved document content')
  c.undo(); assert.deepEqual(c.model, before)
  c.replaceText(c.selection, 'y')
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.verticalAlign, 25)
})

test('explicit tail formatting updates deletion insertion while a new whole-body offset keeps ordinary mark continuation', () => {
  const base = { fontSize: 12, fontName: 'DejaVu Sans' }, model = createWordDocument()
  model.paragraphs[0] = { id: 'session-formatting', style: {}, sourceRun: base,
    marker: { style: { ...base, verticalAlign: 'superscript' }, directStyle: { verticalAlign: 'superscript' } },
    runs: [{ text: 'BODY', style: { ...base, verticalAlign: 25 }, directStyle: { fontSize: 12, verticalAlign: 25 } }] }
  const c = new WordController(model)
  c.replaceText(range(0, 0, 4), ''); c.replaceText(c.selection, 'x'); c.replaceText(c.selection, 'y')
  c.formatText(range(0, 1, 2), { fontSize: 18, italic: true })
  assert.equal(paragraphInsertionFormat(c.model.paragraphs[0]).style.fontSize, 18)
  c.replaceText(range(0, 2, 2), 'z')
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.fontSize, 18)
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.italic, true)
  assert.equal(c.model.paragraphs[0].runs.at(-1).style.verticalAlign, 25)
  c.formatText(range(0, 0, 3), { verticalAlign: -25 })
  assert.equal(c.model.paragraphs[0].sessionInsertion, undefined)
  c.replaceText(range(0, 0, 3), '')
  assert.equal(c.model.paragraphs[0].sessionInsertion, undefined)
  c.replaceText(c.selection, 'a'); c.setSelection(c.selection)
  c.replaceText(c.selection, '\n'); c.setSelection(c.selection)
  c.replaceText(c.selection, 'b')
  assert.equal(documentText(c.model), 'a\nb')
  assert.equal(c.model.paragraphs[1].runs[0].style.verticalAlign, -25, 'explicit numeric marker uses the existing whole-command Enter rule')
})
