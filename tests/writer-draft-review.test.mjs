import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Exercise the release helper itself. These tests cover only explicit draft
// review and confirmation guards; they do not claim native document rendering.
const source = await readFile(new URL('../src/word/draft-review.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const exports = {}
vm.runInNewContext(code, { exports, require: () => ({}) })
const { createWriterDraftReview, writerDraftReviewMatches } = exports

function writer() {
  return {
    documentId: 'word-1', revision: 6, dirty: true,
    selection: { id: 'cursor-1', text: '', truncated: false, collapsed: true, tableName: null, cellName: null },
    page: {
      styleName: 'Standard', width: 210, height: 297, landscape: false,
      marginLeft: 20, marginRight: 21, marginTop: 22, marginBottom: 23,
      headerEnabled: false, footerEnabled: false,
      headerText: '', footerText: '', headerTruncated: false, footerTruncated: false,
    },
  }
}
const origin = () => ({ id: 'word-1', revision: 4, selection: 'cursor-1', styleName: 'Standard' })
const pageDraft = () => ({ width: '220', height: '307', marginLeft: '30', marginRight: '31', marginTop: '32', marginBottom: '33' })
const textDraft = () => ({ enabled: 'true', text: '已保留的草稿\n第二行\t原样保留' })
function freezeDeep(value) {
  Object.freeze(value)
  for (const item of Object.values(value)) if (item && typeof item === 'object') freezeDeep(item)
  return value
}

test('review preserves the user draft and original intent while capturing the freshly read version', () => {
  for (const panel of ['page', 'header', 'footer']) {
    const state = freezeDeep(writer()), draft = freezeDeep(panel === 'page' ? pageDraft() : textDraft()), original = freezeDeep(origin())
    const before = JSON.stringify({ state, draft, original })
    const review = createWriterDraftReview(panel, state, draft, original)
    assert.equal(review.panel, panel)
    assert.equal(review.documentId, 'word-1')
    assert.equal(review.revision, 6)
    assert.equal(review.selectionId, 'cursor-1')
    assert.equal(review.styleName, 'Standard')
    assert.deepEqual(JSON.parse(review.draftJson), draft)
    assert.equal(typeof review.targetJson, 'string')
    assert.equal(writerDraftReviewMatches(review, state, draft), true)
    assert.equal(JSON.stringify({ state, draft, original }), before)
    assert.equal(original.revision, 4, 'reading a review must not silently rebind the original draft')
  }
})

test('review rejects another document, selection, page style or a revision older than the draft', () => {
  const changes = [
    state => { state.documentId = 'word-2' },
    state => { state.selection.id = 'cursor-2' },
    state => { state.page.styleName = 'First Page' },
    state => { state.revision = 3 },
  ]
  for (const panel of ['page', 'header', 'footer']) {
    for (const change of changes) {
      const state = writer(), draft = panel === 'page' ? pageDraft() : textDraft(), original = origin()
      change(state)
      const before = JSON.stringify({ state, draft, original })
      assert.throws(() => createWriterDraftReview(panel, state, draft, original))
      assert.equal(JSON.stringify({ state, draft, original }), before)
    }
  }
})

test('review accepts the original revision but refuses missing or unusable current versions', () => {
  const state = writer(), draft = pageDraft(), original = origin()
  state.revision = original.revision
  const review = createWriterDraftReview('page', state, draft, original)
  assert.equal(review.revision, original.revision)
  assert.equal(writerDraftReviewMatches(review, null, draft), false)
  assert.equal(writerDraftReviewMatches(review, undefined, draft), false)
  for (const revision of [NaN, Infinity, 6.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createWriterDraftReview('page', { ...state, revision }, draft, original))
  }
})

test('the page review shows all six current and proposed measurements before confirmation', () => {
  const review = createWriterDraftReview('page', writer(), pageDraft(), origin())
  assert.deepEqual(JSON.parse(JSON.stringify(review.rows)), [
    { label: '纸张宽度（毫米）', current: '210', proposed: '220' },
    { label: '纸张高度（毫米）', current: '297', proposed: '307' },
    { label: '上边距（毫米）', current: '22', proposed: '32' },
    { label: '下边距（毫米）', current: '23', proposed: '33' },
    { label: '左边距（毫米）', current: '20', proposed: '30' },
    { label: '右边距（毫米）', current: '21', proposed: '31' },
  ])
})

test('header and footer reviews expose both enabled state and the exact proposed text', () => {
  for (const panel of ['header', 'footer']) {
    const state = writer(), draft = textDraft(), review = createWriterDraftReview(panel, state, draft, origin())
    assert.deepEqual(JSON.parse(JSON.stringify(review.rows)), [
      { label: '启用状态', current: '关闭', proposed: '启用' },
      { label: panel === 'header' ? '页眉文字' : '页脚文字', current: '', proposed: draft.text },
    ])
    const disabledDraft = { enabled: 'false', text: '' }
    const disabledReview = createWriterDraftReview(panel, state, disabledDraft, origin())
    assert.equal(disabledReview.rows[0].proposed, '关闭')
    assert.equal(disabledReview.rows[1].proposed, '')
  }
})

test('an unchanged reviewed version can be confirmed, but a later version or target identity cannot', () => {
  const changes = [
    state => { state.documentId = 'word-2' },
    state => { state.revision++ },
    state => { state.revision-- },
    state => { state.selection.id = 'cursor-2' },
    state => { state.page.styleName = 'First Page' },
  ]
  for (const panel of ['page', 'header', 'footer']) {
    const state = writer(), draft = panel === 'page' ? pageDraft() : textDraft()
    const review = createWriterDraftReview(panel, state, draft, origin())
    assert.equal(writerDraftReviewMatches(review, structuredClone(state), structuredClone(draft)), true)
    for (const change of changes) {
      const next = structuredClone(state)
      change(next)
      const before = JSON.stringify({ review, next, draft })
      assert.equal(writerDraftReviewMatches(review, next, draft), false)
      assert.equal(JSON.stringify({ review, next, draft }), before)
    }
  }
})

test('page confirmation becomes invalid when any reviewed dimension or margin changes', () => {
  const state = writer(), draft = pageDraft(), review = createWriterDraftReview('page', state, draft, origin())
  for (const key of ['width', 'height', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom']) {
    const changedTarget = structuredClone(state)
    changedTarget.page[key]++
    assert.equal(writerDraftReviewMatches(review, changedTarget, draft), false, `changed target ${key}`)
    const changedDraft = { ...draft, [key]: String(Number(draft[key]) + 1) }
    assert.equal(writerDraftReviewMatches(review, state, changedDraft), false, `changed draft ${key}`)
  }
})

test('header and footer reviews reject enabled or truncated native content without touching the draft', () => {
  for (const panel of ['header', 'footer']) {
    for (const field of [`${panel}Enabled`, `${panel}Truncated`]) {
      const state = writer(), draft = textDraft(), original = origin()
      state.page[field] = true
      const before = JSON.stringify({ state, draft, original })
      assert.throws(() => createWriterDraftReview(panel, state, draft, original))
      assert.equal(JSON.stringify({ state, draft, original }), before)
    }
  }
})

test('header and footer confirmation rejects native content changes and subsequent draft edits', () => {
  for (const panel of ['header', 'footer']) {
    const state = writer(), draft = textDraft(), review = createWriterDraftReview(panel, state, draft, origin())
    for (const [key, value] of [[`${panel}Enabled`, true], [`${panel}Truncated`, true], [`${panel}Text`, '别处刚写入的内容']]) {
      const next = structuredClone(state)
      next.page[key] = value
      assert.equal(writerDraftReviewMatches(review, next, draft), false, key)
    }
    assert.equal(writerDraftReviewMatches(review, state, { ...draft, text: `${draft.text}\n新增内容` }), false)
    assert.equal(writerDraftReviewMatches(review, state, { ...draft, enabled: 'false' }), false)
    assert.equal(writerDraftReviewMatches(review, state, draft), true, 'failed confirmations do not consume or rebind the review')
  }
})

test('the review is a detached snapshot, not a live reference to the document or the draft', () => {
  const state = writer(), draft = pageDraft(), original = origin()
  const review = createWriterDraftReview('page', state, draft, original), before = JSON.stringify(review)
  state.page.marginLeft = 100
  state.revision++
  draft.marginLeft = '99'
  original.revision = 100
  assert.equal(JSON.stringify(review), before)
  assert.equal(writerDraftReviewMatches(review, state, draft), false)
})
