import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { base64ToBytes, bytesToBase64 } from '../src/shared/document.ts'
import { createId } from '../src/shared/id.ts'
import { createPdfAuthorPreference, normalizePdfAuthor } from '../src/pdf/author.ts'

const clientSource = await readFile(new URL('../src/pdf/rust/client.ts', import.meta.url), 'utf8')
const editorSource = (await readFile(new URL('../src/components/RustPdfEditor.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const sheetClientSource = await readFile(new URL('../src/sheet/rust/client.ts', import.meta.url), 'utf8')
const sheetEditorSource = (await readFile(new URL('../src/components/RustSheetEditor.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
function evaluate(source, require, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, require, console, URL, Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout, crypto: { randomUUID }, ...globals })
  return module.exports
}
// Controlled WASM/DOM doubles exercise the real adapter's state transitions.
// Actual PDF parsing, rendering and editing are checked in the browser/native gate.
function harness(kind = 'pdf') {
  const sheet = kind === 'sheet', format = sheet ? 'xlsx' : 'pdf'
  const state = new Map(), calls = [], document = { baseURI: 'http://localhost/', activeElement: null }
  const authorStore = new Map(), author = { normalizePdfAuthor, pdfAuthorPreference: createPdfAuthorPreference(() => ({ getItem: key => authorStore.get(key) ?? null, setItem: (key, value) => authorStore.set(key, value) })) }
  let receive, documentId = 0, pendingText, startGate, drainGate, flushError, authorError, discardPending = false, activeHostId
  class Element {
    children = []; parentElement; style = {}; dataset = {}; isConnected = true; listeners = new Map()
    append(child) { child.remove(); this.children.push(child); child.parentElement = this }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined }
    setAttribute() {}
    addEventListener(type, callback) { this.listeners.set(type, callback) }
    removeEventListener(type) { this.listeners.delete(type) }
    dispatchEvent(event) { this.listeners.get(event.type)?.({ ...event, target: this }); return true }
    focus() { document.activeElement = this; this.dispatchEvent({ type: 'focus' }) }
    blur() { document.activeElement = null; this.dispatchEvent({ type: 'blur' }) }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] }
  }
  class Input extends Element {}
  document.body = new Element()
  document.createElement = tag => tag === 'input' ? new Input() : new Element()
  const snapshot = id => { const { text, undo, redo, ...value } = state.get(id); return JSON.stringify(value) }
  const edit = (id, text) => { const doc = state.get(id); doc.undo.push(doc.text); doc.redo = []; doc.text = text; doc.revision++; doc.dirty = true; doc.canUndo = true }
  const host = {
    prepare(id, name, bytes) {
      calls.push(['prepare', id, name])
      if (bytes[0] === 255) throw Error('Invalid pdf package')
      state.set(id, { sessionId: id, documentId: ++documentId, revision: 0, dirty: false, backgroundExportReady: true, sheets: [{ index: 0, name: 'Sheet1' }], pageCount: 1, pages: [{ index: 0, width: 595, height: 842 }], name, selection: [], text: '', undo: [], redo: [] })
      return snapshot(id)
    },
    async start(canvas) { calls.push(['start']); canvas.parentElement.append(new Input()); if (startGate) await startGate },
    activate(id) { calls.push(['activate', id]); activeHostId = id; return snapshot(id) },
    inspect: snapshot,
    async flush(id) { calls.push(['flush', id]); if (flushError) throw flushError; if (pendingText?.id === id) { edit(id, pendingText.text); pendingText = undefined } },
    command(id, commandId, params) {
      calls.push(['command', id, commandId]); const value = JSON.parse(params), doc = state.get(id)
      if (commandId === 'text.set') edit(id, value.text)
      else if (commandId === 'ui.set' && value.key === 'author') {
        if (authorError) return JSON.stringify({ ok: false, error: authorError })
        doc.author = value.value
      }
      else if (commandId === 'edit.undo' && doc.undo.length) { doc.redo.push(doc.text); doc.text = doc.undo.pop(); doc.revision++; doc.dirty = true; doc.canRedo = true }
      else if (commandId === 'edit.redo' && doc.redo.length) { doc.undo.push(doc.text); doc.text = doc.redo.pop(); doc.revision++; doc.dirty = true }
      return JSON.stringify({ ok: true, snapshot: JSON.parse(snapshot(id)), result: { text: doc.text } })
    },
    exportFile(id, format) { calls.push(['export', id, format]); return new TextEncoder().encode(JSON.stringify({ text: state.get(id).text, format })) },
    markSaved(id, expectedDocument, revision) { calls.push(['saved', id]); const doc = state.get(id); if (doc.documentId !== expectedDocument || doc.revision !== revision) return false; doc.dirty = false; return true },
    close(id, expectedDocument, revision, force) { calls.push(['close', id]); const doc = state.get(id); if (!force && (doc.documentId !== expectedDocument || doc.revision !== revision || doc.dirty)) return false; state.delete(id); if (force && activeHostId === id) discardPending = true; return true },
    async drainDiscardedInput() { calls.push(['drain', discardPending]); if (discardPending) { if (drainGate) await drainGate; discardPending = false } },
    setActive(value) { calls.push(['active', value]) },
    setTheme(value) { calls.push(['theme', value]) },
    destroy() { calls.push(['destroy']) },
  }
  const globals = { document, window: { dispatchEvent() {} }, HTMLElement: Element, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type } }, FocusEvent: class { constructor(type) { this.type = type } }, InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options) } } }
  const client = evaluate(sheet ? sheetClientSource : clientSource, name => {
    if (name === '../../shared/document') return { base64ToBytes }
    if (name === '../../shared/id') return { createId }
    if (name === '../author') return author
    if (name === (sheet ? 'http://localhost/office-sheet/office-sheet.js' : 'http://localhost/office-pdf/office_pdf.js')) return { default: async () => {}, createHost(callback) { receive = callback; return host } }
    throw Error(`Unexpected import ${name}`)
  }, globals)
  const source = (name = `example.${format}`, base64 = '') => ({ id: randomUUID(), name, base64, extension: name.split('.').at(-1) })
  async function open(input = source()) { const prepared = await client[sheet ? 'prepareRustSheetDocument' : 'prepareRustPdfDocument'](input); return prepared.take(input) }
  function component(input = source(), options = {}) {
    const props = vue.reactive({ document: input, active: false, disabled: false, theme: 'system', ...options }), events = [], unmount = []
    let exposed
    const scope = vue.effectScope()
    scope.run(() => evaluate(sheet ? sheetEditorSource : editorSource, name => {
      if (name === 'vue') return { ...vue, onBeforeUnmount(callback) { unmount.push(callback) } }
      if (name === '../shared/document') return { bytesToBase64 }
      if (name === '../pdf/author') return author
      if (name === '../shared/dialog-focus') return { useDialogFocus() {} }
      if (name === `../${kind}/rust/client`) return client
      throw Error(`Unexpected component import ${name}`)
    }, { ...globals, defineProps: () => props, withDefaults: value => value, defineEmits: () => (...event) => events.push(event), defineExpose(value) { exposed = value } }))
    return { props, events, editor: exposed, dispose() { unmount.forEach(callback => callback()); scope.stop() } }
  }
  return { client, open, source, state, calls, document, Element, component, authorStore, author: author.pdfAuthorPreference, notify(event) { receive(JSON.stringify(event)) }, pending(id, text) { pendingText = { id, text } }, setStartGate(value) { startGate = value }, setDrainGate(value) { drainGate = value }, setFlushError(value) { flushError = value }, setAuthorError(value) { authorError = value } }
}

test('PDF identity applies before editing and follows open tabs without changing document receipts or drafts', async () => {
  const h = harness(), first = await h.open(), second = await h.open()
  await first.attach(new h.Element(), true)
  assert.equal(h.state.get(first.id).author, '')
  const revision = first.snapshot.revision
  h.pending(first.id, 'uncommitted draft')
  const flushes = h.calls.filter(call => call[0] === 'flush').length
  assert.equal(await first.setAuthor(' 陈江 '), true)
  assert.equal(h.state.get(first.id).author, '陈江')
  assert.equal(first.snapshot.revision, revision)
  assert.equal(first.snapshot.dirty, false)
  assert.equal(h.state.get(first.id).text, '')
  assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
  await second.attach(new h.Element(), true)
  assert.equal(h.state.get(second.id).author, '陈江')
  await assert.rejects(first.setAuthor('Other'), /先切换/)
  await second.setAuthor('')
  await first.attach(new h.Element(), true)
  assert.equal(h.state.get(first.id).author, '')
  assert.equal(h.author.read(), '')
  assert.equal(h.state.get(first.id).text, 'uncommitted draft')
  assert.equal(h.state.get(second.id).dirty, false)
  await first.close(true); await second.close(true)
})

test('PDF identity setup failures cannot silently enable an old default author or overwrite the saved choice', async () => {
  const h = harness(), session = await h.open(), container = new h.Element()
  h.author.save('Ada'); h.setAuthorError('Author setup failed')
  await assert.rejects(session.attach(container, true), /Author setup failed/)
  session.setInteractive(true)
  assert.equal(h.calls.filter(call => call[0] === 'active').at(-1)[1], false)
  await assert.rejects(session.setAuthor('陈江'), /Author setup failed/)
  assert.equal(h.author.read(), 'Ada')
  h.setAuthorError(undefined)
  await session.attach(container, true)
  assert.equal(h.state.get(session.id).author, 'Ada')
  assert.equal(h.calls.filter(call => call[0] === 'active').at(-1)[1], true)
  await session.close(true)
})

test('PDF failed import keeps the edited session, selection and undo history', async () => {
  const h = harness(), first = await h.open()
  await first.command('text.set', { text: '保留PDF😀' })
  const before = JSON.stringify(h.state.get(first.id))
  await assert.rejects(h.open(h.source('broken.pdf', '/w==')), /Invalid pdf/)
  assert.equal(JSON.stringify(h.state.get(first.id)), before)
  await first.command('edit.undo')
  assert.equal((await first.query('document.inspect')).text, '')
  await first.command('edit.redo')
  assert.equal((await first.query('document.inspect')).text, '保留PDF😀')
})

for (const kind of ['pdf', 'sheet']) {
  const format = kind === 'pdf' ? 'pdf' : 'xlsx'
  test(`${kind} background checks retain pending drafts and recheck readiness at export and acknowledgement`, async () => {
    const h = harness(kind), session = await h.open(), model = h.state.get(session.id)
    await session.command('text.set', { text: 'committed' })
    const baseline = h.calls.length
    assert.equal(await session.canBackgroundExport(), true)
    const exported = await session.export(format, { background: true })
    assert.equal(JSON.parse(new TextDecoder().decode(exported.bytes)).text, 'committed')
    model.backgroundExportReady = false
    h.pending(session.id, 'unconfirmed draft')
    const before = JSON.stringify(model)
    assert.equal(await session.canBackgroundExport(), false)
    await assert.rejects(session.export(format, { background: true }), /完成当前编辑/)
    await assert.rejects(session.markSaved(exported.snapshot.documentId, exported.snapshot.revision, { background: true }), /正在编辑/)
    assert.equal(JSON.stringify(model), before, 'readiness/export/save ACK cannot commit or erase a draft')
    assert.equal(h.calls.slice(baseline).filter(call => call[0] === 'flush').length, 0)
    assert.equal(h.calls.slice(baseline).filter(call => call[0] === 'saved').length, 0)
    // Once the user commits, a previous write cannot acknowledge newer input.
    await session.settled()
    model.backgroundExportReady = true
    const afterCommit = h.calls.length
    await assert.rejects(session.markSaved(exported.snapshot.documentId, exported.snapshot.revision, { background: true }), /又有修改/)
    assert.equal(model.dirty, true)
    const current = await session.export(format, { background: true })
    await session.markSaved(current.snapshot.documentId, current.snapshot.revision, { background: true })
    assert.equal(model.dirty, false)
    assert.equal(h.calls.slice(afterCommit).filter(call => call[0] === 'flush').length, 0)
  })

  test(`${kind} background export fails closed for old hosts and does not blur IME`, async () => {
    const h = harness(kind), session = await h.open(), container = new h.Element(), model = h.state.get(session.id)
    await session.attach(container, true)
    delete model.backgroundExportReady
    assert.equal(await session.canBackgroundExport(), false)
    await assert.rejects(session.export(format, { background: true }), /完成当前编辑/)
    model.backgroundExportReady = true
    const input = container.children[1]
    input.focus(); input.dispatchEvent({ type: 'compositionstart' })
    const baseline = h.calls.length
    assert.equal(await session.canBackgroundExport(), false)
    await assert.rejects(session.export(format, { background: true }), /完成当前编辑/)
    await assert.rejects(session.markSaved(model.documentId, model.revision, { background: true }), /正在编辑/)
    assert.equal(h.document.activeElement, input)
    assert.equal(h.calls.slice(baseline).filter(call => ['flush', 'export', 'saved'].includes(call[0])).length, 0)
    input.dispatchEvent({ type: 'compositionend' })
    assert.equal(await session.canBackgroundExport(), true)
    await session.close(true)
  })

  test(`${kind} component revision/readiness/background save skip flush while manual save still commits`, async () => {
    const h = harness(kind), component = h.component(), editor = component.editor
    await editor.inspect()
    const model = [...h.state.values()][0], baseline = h.calls.length
    model.backgroundExportReady = false
    h.pending(model.sessionId, 'pending')
    await editor.syncRevision()
    assert.equal(await editor.canBackgroundExport(), false)
    await assert.rejects(editor.exportFile({ format, background: true }), /完成当前编辑/)
    assert.equal(model.text, '')
    assert.equal(h.calls.slice(baseline).filter(call => call[0] === 'flush').length, 0)
    model.backgroundExportReady = true
    const saved = await editor.exportFile({ format, background: true })
    await editor.markSaved(saved.base64, { background: true })
    assert.equal(h.calls.slice(baseline).filter(call => call[0] === 'flush').length, 0)
    const manual = await editor.exportFile({ format })
    assert.equal(JSON.parse(Buffer.from(manual.base64, 'base64').toString()).text, 'pending')
    assert.ok(h.calls.slice(baseline).some(call => call[0] === 'flush'))
    component.dispose()
  })
}

test('PDF save receipt rejects later input and ignores delayed older frame snapshots', async () => {
  const h = harness(), session = await h.open()
  await session.command('text.set', { text: 'first' })
  const exported = await session.export(), old = { ...exported.snapshot }
  h.pending(session.id, 'later')
  await assert.rejects(session.markSaved(old.documentId, old.revision), /又有修改/)
  h.notify({ type: 'change', sessionId: session.id, snapshot: { ...old, dirty: false } })
  assert.equal(session.snapshot.dirty, true)
  assert.equal(session.snapshot.revision, old.revision + 1)
  const next = await session.export()
  await session.markSaved(next.snapshot.documentId, next.snapshot.revision)
  assert.equal(session.snapshot.dirty, false)
})

test('PDF sessions isolate edits and file actions while theme changes retain drafts', async () => {
  const h = harness(), first = await h.open(), second = await h.open(), events = []
  first.onEvent(event => events.push(event)); second.onEvent(event => events.push(event))
  await first.attach(new h.Element(), true)
  await first.command('text.set', { text: 'one' })
  await second.attach(new h.Element(), true)
  h.pending(second.id, 'two')
  const flushes = h.calls.filter(call => call[0] === 'flush').length
  await h.client.setRustPdfTheme('dark')
  assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
  assert.equal(second.snapshot.revision, 0)
  h.notify({ type: 'action', sessionId: first.id, action: 'save' })
  h.notify({ type: 'action', sessionId: second.id, action: 'save' })
  assert.deepEqual(events.map(event => event.sessionId), [second.id])
  await second.settled()
  assert.equal((await first.query('document.inspect')).text, 'one')
  assert.equal((await second.query('document.inspect')).text, 'two')
  second.deactivate()
  h.notify({ type: 'action', sessionId: second.id, action: 'open' })
  assert.equal(events.length, 1)
  await first.close(true); await second.close(true)
  assert.equal(h.calls.filter(call => call[0] === 'destroy').length, 1)
})

test('PDF latest attach wins when another tab deactivates during renderer start', async () => {
  const h = harness(), first = await h.open(), second = await h.open()
  let release
  h.setStartGate(new Promise(resolve => { release = resolve }))
  const oldAttach = first.attach(new h.Element(), true)
  await new Promise(resolve => setTimeout(resolve, 0))
  const nextAttach = second.attach(new h.Element(), true)
  first.deactivate(); release()
  await Promise.all([oldAttach, nextAttach])
  assert.deepEqual(h.calls.filter(call => call[0] === 'activate').map(call => call[1]), [second.id])
})

test('PDF unfinished IME input blocks save while appearance changes retain composition', async () => {
  const h = harness(), session = await h.open(), container = new h.Element()
  await session.attach(container, true)
  const input = container.children[1]
  input.focus(); input.dispatchEvent({ type: 'compositionstart' })
  const before = h.calls.filter(call => call[0] === 'active').length
  session.setInteractive(false)
  await h.client.setRustPdfTheme('dark')
  assert.equal(h.calls.filter(call => call[0] === 'active').length, before)
  await assert.rejects(session.export(), /输入法/)
  input.dispatchEvent({ type: 'compositionend' })
  h.pending(session.id, '中文😀')
  const result = await session.export()
  assert.equal(JSON.parse(new TextDecoder().decode(result.bytes)).text, '中文😀')
  await session.close(true)
})

test('PDF prepared handoffs are single use and retain the exact source across async loading', async () => {
  const h = harness(), source = h.source(), original = { ...source }
  const promise = h.client.prepareRustPdfDocument(source)
  source.id = 'replacement'; source.base64 = '/w=='
  const prepared = await promise, session = prepared.take(original)
  assert.ok(session)
  assert.equal(prepared.take(original), undefined)
  const mismatched = await h.client.prepareRustPdfDocument(h.source())
  assert.equal(mismatched.take(original), undefined)
  await session.inspect()
  assert.equal(h.state.size, 1)
  await assert.rejects(h.client.prepareRustPdfDocument(h.source('old.docx')), /PDF/)
  assert.equal(h.state.size, 1)
})

test('PDF component failed direct replacement preserves the previous pdf', async () => {
  const h = harness(), mounted = h.component(), editor = mounted.editor
  await editor.command('text.set', { text: 'keep original' })
  const before = await editor.inspect()
  mounted.props.document = h.source('broken.pdf', '/w==')
  await vue.nextTick()
  const after = await editor.inspect()
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.revision, before.revision)
  assert.equal((await editor.query('document.inspect')).text, 'keep original')
  assert.ok(mounted.events.some(event => event[0] === 'error' && /Invalid/.test(event[1])))
  mounted.dispose()
})


test('PDF component save receipts reject wrong bytes and newer edits without clearing dirty state', async () => {
  const h = harness(), mounted = h.component(), editor = mounted.editor
  await editor.command('text.set', { text: 'original content' })
  const exported = await editor.exportFile()
  assert.equal(exported.extension, 'pdf')
  await assert.rejects(editor.markSaved('different bytes'), /导出结果不同/)
  await editor.markSaved(exported.base64)
  assert.equal((await editor.inspect()).dirty, false)
  await editor.command('text.set', { text: 'later content' })
  await assert.rejects(editor.markSaved(exported.base64), /又有修改/)
  assert.equal((await editor.inspect()).dirty, true)
  await editor.undo(); assert.equal((await editor.query('document.inspect')).text, 'original content')
  await editor.redo(); assert.equal((await editor.query('document.inspect')).text, 'later content')
  mounted.dispose()
})

test('PDF sync revision observes state without committing pending input', async () => {
  const h = harness(), mounted = h.component(), editor = mounted.editor
  const before = await editor.inspect()
  h.pending(before.sessionId, 'pending shared text')
  assert.equal((await editor.inspect()).revision, before.revision, 'Read-only inspection does not commit the draft')
  const calls = h.calls.length
  const synced = await editor.syncRevision()
  assert.equal(synced.revision, before.revision)
  assert.equal(h.calls.slice(calls).filter(call => call[0] === 'flush').length, 0)
  const exported = await editor.exportFile()
  assert.equal(exported.revision, `${synced.documentId}:${synced.revision + 1}`)
  assert.equal((await editor.inspect()).dirty, true, 'A synchronization snapshot is not a filesystem save receipt')
  mounted.dispose()
})

test('confirmed PDF discard clears only its own composing input before closing', async () => {
  const h = harness(), session = await h.open(), container = new h.Element()
  await session.attach(container, true)
  const input = container.children[1]
  input.focus(); input.value = 'pending composition'; input.dispatchEvent({ type: 'compositionstart' })
  input.addEventListener('blur', () => { input.value = 'late composition'; input.dispatchEvent({ type: 'compositionend' }) })
  await session.close(true)
  assert.equal(input.value, '')
  assert.equal(h.state.size, 0)
  assert.equal(h.document.activeElement, null)
  assert.equal(h.calls.filter(call => call[0] === 'destroy').length, 1)
})

test('confirmed component discard releases unfinished input before the surviving PDF attaches', async () => {
  const h = harness(), source = h.source(), prepared = await h.client.prepareRustPdfDocument(source)
  const first = prepared.take(source), second = await h.open(), oldContainer = new h.Element(), nextContainer = new h.Element()
  const mounted = h.component(source, { prepared: vue.markRaw({ take: () => first, discard() {} }) })
  await mounted.editor.command('text.set', { text: 'discarded draft' })
  await first.attach(oldContainer, true)
  await second.command('text.set', { text: 'surviving content' })
  const input = oldContainer.children[1]
  input.focus(); input.value = 'unfinished'; input.dispatchEvent({ type: 'compositionstart' })
  await assert.rejects(mounted.editor.discardChanges(), /输入法/)
  assert.equal(h.state.has(first.id), true)
  await mounted.editor.discardChanges({ force: true })
  assert.equal(h.state.has(first.id), false)
  first.deactivate()
  await second.attach(nextContainer, true)
  mounted.dispose()
  assert.equal(nextContainer.children.length, 2)
  assert.equal(input.value, '')
  assert.equal((await second.query('document.inspect')).text, 'surviving content')
  await second.command('edit.undo')
  assert.equal((await second.query('document.inspect')).text, '')
  await second.command('edit.redo')
  assert.equal((await second.query('document.inspect')).text, 'surviving content')
  await second.close(true)
})

test('PDF close drains the old renderer input before another session can receive the canvas', async () => {
  const h = harness(), first = await h.open(), second = await h.open(), oldContainer = new h.Element(), nextContainer = new h.Element()
  await first.attach(oldContainer, true)
  let release
  h.setDrainGate(new Promise(resolve => { release = resolve }))
  const closing = first.close(true), attaching = second.attach(nextContainer, true)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(h.state.has(first.id), false, 'the confirmed-discarded host entry is already released')
  assert.equal(nextContainer.children.length, 0, 'the new tab cannot receive input before the drain finishes')
  assert.deepEqual(h.calls.filter(call => call[0] === 'activate').map(call => call[1]), [first.id])
  release()
  await Promise.all([closing, attaching])
  assert.equal(nextContainer.children.length, 2)
  assert.deepEqual(h.calls.filter(call => call[0] === 'activate').map(call => call[1]), [first.id, second.id])
  await second.close(true)
})

test('a failed PDF input drain releases the closed session and can be retried before activating its survivor', async () => {
  const h = harness(), first = await h.open(), second = await h.open(), oldContainer = new h.Element(), nextContainer = new h.Element()
  await first.attach(oldContainer, true)
  let rejectDrain
  h.setDrainGate(new Promise((_, reject) => { rejectDrain = reject }))
  const closing = first.close(true)
  await new Promise(resolve => setTimeout(resolve, 5))
  rejectDrain(Error('renderer input drain failed'))
  await assert.rejects(closing, /input drain failed/)
  await assert.rejects(first.inspect(), /已关闭/)
  assert.equal(oldContainer.children.length, 0)
  h.setDrainGate(undefined)
  await second.attach(nextContainer, true)
  assert.equal(nextContainer.children.length, 2)
  await second.close(true)
})

test('PDF pending deletion and comment decisions alone bypass a blocked flush in the real serialized adapter', async () => {
  const h = harness(), session = await h.open()
  h.setFlushError(Error('请确认删除'))
  for (const command of ['ui.delete.confirm','ui.delete.cancel','ui.commentDraft.open','ui.commentDraft.submit','ui.commentDraft.discard','ui.commentDraft.return']) {
    const before = h.calls.length
    h.state.get(session.id).revision++
    const result = await session.command(command)
    assert.equal(result.revision,h.state.get(session.id).revision)
    assert.deepEqual(h.calls.slice(before),[['command',session.id,command]])
  }
  for (const command of ['edit.undo','text.set','ui.delete.confirm.other','ui.commentDraft.submit.other','ui.commentDraft.unknown']) {
    const before=h.calls.length
    await assert.rejects(session.command(command),/请确认删除/)
    assert.deepEqual(h.calls.slice(before),[['flush',session.id]])
  }
  await session.command('ui.delete.cancel')
  await session.close(true)
  await assert.rejects(session.command('ui.delete.confirm'),/关闭/)
})
test('PDF component forwards pending decisions without its outer flush but protects ordinary commands', async () => {
  const h=harness(), mounted=h.component()
  await mounted.editor.inspect()
  const id=[...h.state.keys()][0]
  h.setFlushError(Error('等待删除确认'))
  for (const command of ['ui.delete.confirm','ui.delete.cancel','ui.commentDraft.open','ui.commentDraft.submit','ui.commentDraft.discard','ui.commentDraft.return']) {
    const before=h.calls.length
    await mounted.editor.command(command)
    assert.deepEqual(h.calls.slice(before),[['command',id,command]])
  }
  for (const command of ['edit.undo','ui.delete.cancel.other','ui.commentDraft.submit.other','ui.commentDraft.unknown']) {
    const before=h.calls.length
    await assert.rejects(mounted.editor.command(command),/等待删除确认/)
    assert.deepEqual(h.calls.slice(before),[['flush',id]])
  }
  mounted.dispose()
})

for (const kind of ['pdf', 'sheet']) {
  test(`${kind} switching retains committed drafts and requires a real save before unconfirmed close`, async () => {
    const h = harness(kind), mounted = h.component(), editor = mounted.editor
    try {
      const original = await editor.inspect()
      await editor.discardChanges()
      assert.equal(h.calls.filter(call => call[0] === 'export' || call[0] === 'saved').length, 0, 'A clean imported document can close without first exporting')
      h.pending(original.sessionId, 'queued live content')
      const settled = await editor.prepareDeactivate()
      assert.equal(settled.documentId, original.documentId)
      assert.equal(settled.revision, original.revision + 1)
      assert.equal(settled.dirty, true)
      assert.equal(h.state.get(original.sessionId).text, 'queued live content')
      assert.equal(h.calls.filter(call => call[0] === 'export' || call[0] === 'saved').length, 0)
      await assert.rejects(editor.discardChanges(), /未保存/)
      const receipt = await editor.exportFile()
      await assert.rejects(editor.discardChanges(), /未保存/, 'Exporting to memory cannot acknowledge filesystem persistence')
      await editor.markSaved(receipt.base64)
      await editor.discardChanges()
      await editor.undo(); assert.equal(h.state.get(original.sessionId).text, '')
      await editor.redo(); assert.equal(h.state.get(original.sessionId).text, 'queued live content')
      await assert.rejects(editor.markSaved(receipt.base64), /又有修改/)
      await assert.rejects(editor.discardChanges(), /未保存/)
      h.setFlushError(Error('Unresolved editor draft'))
      await assert.rejects(editor.prepareDeactivate(), /Unresolved editor draft/)
      await assert.rejects(editor.discardChanges(), /Unresolved editor draft/)
      assert.equal(h.state.get(original.sessionId).text, 'queued live content')
    } finally { mounted.dispose() }
  })
}
