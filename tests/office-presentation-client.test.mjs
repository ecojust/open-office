import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { base64ToBytes, bytesToBase64 } from '../src/shared/document.ts'
import { createId } from '../src/shared/id.ts'
import * as mediaValidation from '../src/presentation/rust/media.ts'

const clientSource = await readFile(new URL('../src/presentation/rust/client.ts', import.meta.url), 'utf8')
const editorSource = (await readFile(new URL('../src/components/RustPresentationEditor.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const wordClientSource = await readFile(new URL('../src/word/rust/client.ts', import.meta.url), 'utf8')
const wordEditorSource = (await readFile(new URL('../src/components/RustWordEditor.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
function evaluate(source, require, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, require, console, URL, Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout, crypto: { randomUUID }, ...globals })
  return module.exports
}
// Controlled WASM/DOM doubles exercise the real adapter's state transitions.
// Actual PPTX parsing, rendering and editing are checked in the browser/native gate.
function harness(kind = 'presentation') {
  const word = kind === 'word', format = word ? 'docx' : 'pptx'
  const state = new Map(), calls = [], document = { baseURI: 'http://localhost/', activeElement: null }
  const font = { loadFailures: 0, registrationFailures: 0, alreadyAdded: false, chinese: true, htmlResponse: false, data: undefined }
  const fontHeader = new Uint8Array(28)
  fontHeader[1] = 1; fontHeader[5] = 1
  let receive, flushGate, documentId = 0, pendingText, startGate
  class Element {
    children = []; parentElement; style = {}; dataset = {}; isConnected = true; listeners = new Map()
    append(child) { child.remove(); this.children.push(child); child.parentElement = this }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined }
    setAttribute() {}
    addEventListener(type, callback) { this.listeners.set(type, callback) }
    removeEventListener(type) { this.listeners.delete(type) }
    dispatchEvent(event) { this.listeners.get(event.type)?.({ ...event, target: this }); return true }
    focus() { document.activeElement = this; this.dispatchEvent({ type: 'focus' }) }
    blur() { document.activeElement = null }
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
      if (bytes[0] === 255) throw Error('Invalid presentation package')
      state.set(id, { sessionId: id, documentId: ++documentId, revision: 0, dirty: false, pages: 1, slides: [{ id: 'slide-1', index: 0, name: 'Slide 1' }], name, selection: [], ui: null, text: '', undo: [], redo: [] })
      return snapshot(id)
    },
    async start(canvas) { calls.push(['start']); canvas.parentElement.append(new Input()); if (startGate) await startGate },
    activate(id) { calls.push(['activate', id]); state.get(id).ui = { dialog: null, showing: null, home: false }; return snapshot(id) },
    inspect: snapshot,
    async flush(id) { calls.push(['flush', id]); if (flushGate) await flushGate(); if (pendingText?.id === id) { edit(id, pendingText.text); pendingText = undefined } },
    command(id, commandId, params) {
      calls.push(['command', id, commandId]); const value = JSON.parse(params), doc = state.get(id)
      if (commandId === 'font.add') {
        font.data = value.data
        if (font.registrationFailures-- > 0) return JSON.stringify({ ok: false, error: 'font initialization temporarily failed', snapshot: JSON.parse(snapshot(id)) })
        if (font.alreadyAdded) return JSON.stringify({ ok: false, error: `${font.chinese ? '无法执行“添加字体”：' : 'invalid parameters for `font.add`: '}not a font OfficePresentation can read (or already added)`, snapshot: JSON.parse(snapshot(id)) })
        return JSON.stringify({ ok: true, result: { faces: 1 }, snapshot: JSON.parse(snapshot(id)) })
      }
      if (commandId === 'text.set') edit(id, value.text)
      else if (commandId === 'host.setTemplatePanelOpen') doc.ui = { ...doc.ui, templatePanelOpen: value.open }
      else if (commandId === 'edit.undo' && doc.undo.length) { doc.redo.push(doc.text); doc.text = doc.undo.pop(); doc.revision++; doc.dirty = true; doc.canRedo = true }
      else if (commandId === 'edit.redo' && doc.redo.length) { doc.undo.push(doc.text); doc.text = doc.redo.pop(); doc.revision++; doc.dirty = true }
      return JSON.stringify({ ok: true, snapshot: JSON.parse(snapshot(id)), result: { text: doc.text } })
    },
    exportFile(id, format) { calls.push(['export', id, format]); return new TextEncoder().encode(JSON.stringify({ text: state.get(id).text, format })) },
    markSaved(id, expectedDocument, revision) { calls.push(['saved', id]); const doc = state.get(id); if (doc.documentId !== expectedDocument || doc.revision !== revision) return false; doc.dirty = false; return true },
    close(id, expectedDocument, revision, force) { calls.push(['close', id]); const doc = state.get(id); if (!force && (doc.documentId !== expectedDocument || doc.revision !== revision || doc.dirty)) return false; state.delete(id); return true },
    setActive(value) { calls.push(['active', value]) },
    setTheme(value) { calls.push(['theme', value]) },
    destroy() { calls.push(['destroy']) },
  }
  const globals = {
    document, window: { dispatchEvent() {} }, HTMLElement: Element, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type } }, FocusEvent: class { constructor(type) { this.type = type } },
    async fetch(url) {
      calls.push(['fetch', url])
      return { ok: font.loadFailures-- <= 0, arrayBuffer: async () => font.htmlResponse ? new TextEncoder().encode('<html>Not found</html>').buffer : fontHeader.slice().buffer }
    },
  }
  const client = evaluate(word ? wordClientSource : clientSource, name => {
    if (name === '../../shared/document') return { base64ToBytes, bytesToBase64 }
    if (name === '../../shared/id') return { createId }
    if (name === '../../../assets/fonts/ui/WenQuanYiMicroHei-Regular.ttf?url') return { default: '/assets/document-font.ttf' }
    if (name === `http://localhost/office-${kind}/office-${kind}.js`) return { default: async () => {}, createHost(callback) { receive = callback; return host } }
    throw Error(`Unexpected import ${name}`)
  }, globals)
  const source = (name = `document.${format}`, base64 = '') => ({ id: randomUUID(), name, base64, extension: name.split('.').at(-1) })
  async function open(input = source()) { const prepared = await (word ? client.prepareRustWordDocument : client.prepareRustPresentationDocument)(input); return prepared.take(input) }
  function component(input = source()) {
    const props = vue.reactive({ document: input, active: false, disabled: false, theme: 'system', templatesOpen: false }), events = [], unmount = []
    let exposed
    const scope = vue.effectScope()
    scope.run(() => evaluate(word ? wordEditorSource : editorSource, name => {
      if (name === 'vue') return { ...vue, onBeforeUnmount(callback) { unmount.push(callback) } }
      if (name === '../shared/document') return { bytesToBase64 }
      if (name === '../shared/printing') return { printPdf: () => assert.fail('Unexpected printing in a non-printing presentation component test') }
      if (name === `../${kind}/rust/client`) return client
      if (name === '../presentation/rust/media') return mediaValidation
      throw Error(`Unexpected component import ${name}`)
    }, { ...globals, defineProps: () => props, withDefaults: value => value, defineEmits: () => (...event) => events.push(event), defineExpose(value) { exposed = value } }))
    return { props, events, editor: exposed, dispose() { unmount.forEach(callback => callback()); scope.stop() } }
  }
  return { client, open, source, state, calls, document, Element, component, setFlushGate(value) { flushGate = value }, font, notify(event) { receive(JSON.stringify(event)) }, pending(id, text) { pendingText = { id, text } }, setStartGate(value) { startGate = value } }
}

test('Deck registers the bundled document font once for concurrent sessions without edits or save acknowledgements', async () => {
  const h = harness(), sessions = await Promise.all([h.open(), h.open()])
  assert.equal(h.calls.filter(call => call[0] === 'fetch').length, 1)
  assert.equal(h.calls.filter(call => call[2] === 'font.add').length, 1)
  assert.equal(base64ToBytes(h.font.data).length, 28, 'Font bytes are passed to the Rust font database')
  assert.equal(h.calls.filter(call => call[0] === 'saved').length, 0)
  for (const session of sessions) {
    assert.equal(session.snapshot.dirty, false)
    assert.equal(session.snapshot.revision, 0)
    assert.deepEqual(h.state.get(session.id).undo, [])
    await session.close(true)
  }
})

test('Deck font download failures retry without creating orphan sessions', async () => {
  const h = harness(); h.font.loadFailures = 1
  await assert.rejects(h.open(), /字体加载失败/)
  assert.equal(h.state.size, 0)
  assert.equal(h.calls.filter(call => call[0] === 'prepare').length, 0)
  const session = await h.open()
  assert.equal(h.calls.filter(call => call[0] === 'fetch').length, 2)
  assert.equal(h.state.size, 1)
  assert.equal(session.snapshot.dirty, false)
  await session.close(true)
})

test('Deck failed font registration closes the unpublished session and retries on the next open', async () => {
  const h = harness(); h.font.registrationFailures = 1
  await assert.rejects(h.open(), /font initialization temporarily failed/)
  const preparedId = h.calls.find(call => call[0] === 'prepare')[1]
  assert.equal(h.state.size, 0)
  assert.ok(h.calls.some(call => call[0] === 'close' && call[1] === preparedId))
  await assert.rejects(h.client.inspectOfficePresentationSession(preparedId), /尚未打开/)
  const session = await h.open()
  assert.equal(h.calls.filter(call => call[2] === 'font.add').length, 2)
  assert.equal(session.snapshot.dirty, false)
  assert.deepEqual(h.state.get(session.id).undo, [])
  await session.close(true)
})

test('Deck accepts an already embedded document font and keeps undo limited to user edits', async () => {
  for (const chinese of [false, true]) {
    const h = harness(); h.font.alreadyAdded = true; h.font.chinese = chinese
    const first = await h.open(), second = await h.open()
    assert.equal(h.calls.filter(call => call[2] === 'font.add').length, 1)
    assert.equal(first.snapshot.dirty, false)
    await first.command('text.set', { text: '我的演示' })
    assert.deepEqual(h.state.get(first.id).undo, [''])
    await first.command('edit.undo')
    assert.equal((await first.query('text.get')).text, '')
    assert.equal(second.snapshot.dirty, false)
    await first.close(true); await second.close(true)
  }
})

test('Deck rejects a font asset HTML fallback before preparing a document and permits retry', async () => {
  const h = harness(); h.font.htmlResponse = true
  await assert.rejects(h.open(), /字体文件无效/)
  assert.equal(h.calls.filter(call => call[0] === 'prepare').length, 0)
  h.font.htmlResponse = false
  const session = await h.open()
  assert.equal(h.state.size, 1)
  await session.close(true)
})

test('Deck media input accepts the Rust 32 MiB boundary and rejects one byte beyond for every media kind', () => {
  for (const [purpose, name] of [['picture', 'photo.PNG'], ['audio', 'track.mp3'], ['video', 'clip.mp4']]) {
    assert.doesNotThrow(() => mediaValidation.validatePresentationMedia({ name, size: 32 * 1024 * 1024 }, purpose))
    assert.throws(() => mediaValidation.validatePresentationMedia({ name, size: 32 * 1024 * 1024 + 1 }, purpose), { message: '插入的媒体不能超过 32 MiB。' })
    assert.throws(() => mediaValidation.validatePresentationMedia({ name: 'wrong.pptx', size: 100 }, purpose), /支持的文件格式/)
  }
})

test('Deck failed import keeps the edited session, selection and undo history', async () => {
  const h = harness(), first = await h.open()
  await first.command('text.set', { text: '保留演示😀' })
  const before = JSON.stringify(h.state.get(first.id))
  await assert.rejects(h.open(h.source('broken.pptx', '/w==')), /Invalid presentation/)
  assert.equal(JSON.stringify(h.state.get(first.id)), before)
  await first.command('edit.undo')
  assert.equal((await first.query('text.get')).text, '')
  await first.command('edit.redo')
  assert.equal((await first.query('text.get')).text, '保留演示😀')
})

test('Deck save receipt rejects later input and ignores delayed older frame snapshots', async () => {
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

test('Deck sessions isolate edits and file actions while theme changes retain drafts', async () => {
  const h = harness(), first = await h.open(), second = await h.open(), events = []
  first.onEvent(event => events.push(event)); second.onEvent(event => events.push(event))
  await first.attach(new h.Element(), true)
  await first.command('text.set', { text: 'one' })
  await second.attach(new h.Element(), true)
  h.pending(second.id, 'two')
  const flushes = h.calls.filter(call => call[0] === 'flush').length
  await h.client.setRustPresentationTheme('dark')
  assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
  assert.equal(second.snapshot.revision, 0)
  h.notify({ type: 'action', sessionId: first.id, action: 'save' })
  h.notify({ type: 'action', sessionId: second.id, action: 'save' })
  assert.deepEqual(events.map(event => event.sessionId), [second.id])
  await second.settled()
  assert.equal((await first.query('text.get')).text, 'one')
  assert.equal((await second.query('text.get')).text, 'two')
  second.deactivate()
  h.notify({ type: 'action', sessionId: second.id, action: 'open' })
  assert.equal(events.length, 1)
  await first.close(true); await second.close(true)
  assert.equal(h.calls.filter(call => call[0] === 'destroy').length, 1)
})

test('Deck template actions only reach the active interactive presentation', async () => {
  const h = harness(), first = await h.open(), second = await h.open(), events = []
  first.onEvent(event => events.push(event)); second.onEvent(event => events.push(event))
  await first.attach(new h.Element(), true)
  h.notify({ type: 'action', sessionId: first.id, action: 'toggleTemplates' })
  h.notify({ type: 'action', sessionId: second.id, action: 'toggleTemplates' })
  assert.deepEqual(events.map(event => [event.type, event.sessionId]), [['toggle-templates', first.id]])
  first.setInteractive(false)
  h.notify({ type: 'action', sessionId: first.id, action: 'toggleTemplates' })
  assert.equal(events.length, 1)
  await second.attach(new h.Element(), true)
  h.notify({ type: 'action', sessionId: first.id, action: 'toggleTemplates' })
  h.notify({ type: 'action', sessionId: second.id, action: 'toggleTemplates' })
  assert.deepEqual(events.map(event => [event.type, event.sessionId]), [['toggle-templates', first.id], ['toggle-templates', second.id]])
  second.deactivate()
  h.notify({ type: 'action', sessionId: second.id, action: 'toggleTemplates' })
  assert.equal(events.length, 2)
  await first.close(true); await second.close(true)
})

test('Deck template panel state preserves pending input and save receipts', async () => {
  const h = harness(), session = await h.open()
  await session.attach(new h.Element(), true)
  h.pending(session.id, '输入中的文字')
  const flushes = h.calls.filter(call => call[0] === 'flush').length
  for (const open of [true, false]) {
    await session.setTemplatePanelOpen(open)
    const current = await session.inspect()
    assert.equal(current.ui.templatePanelOpen, open)
    assert.equal(current.dirty, false)
    assert.equal(current.revision, 0)
    assert.deepEqual(h.state.get(session.id).undo, [])
    assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
  }
  await session.settled()
  assert.equal((await session.query('text.get')).text, '输入中的文字')
  await session.close(true)
})

test('Deck latest attach wins when another tab deactivates during renderer start', async () => {
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

test('Deck media picker receipts reject a changed selection and keep the request identity', async () => {
  const h = harness(), session = await h.open(), events = []
  session.onEvent(event => events.push(event))
  await session.attach(new h.Element(), true)
  h.notify({ type: 'action', sessionId: session.id, action: 'pickFile', purpose: 'picture', requestId: 17 })
  assert.equal(events[0].requestId, 17)
  await session.command('text.set', { text: 'changed after picker' })
  await assert.rejects(session.command('host.deliverFile', { requestId: 17, data: 'AAAA' }, events[0]), /选区已有变化/)
  assert.ok(!h.calls.some(call => call[2] === 'host.deliverFile'))
  await assert.rejects(session.query('text.set'), /只读/)
})

test('Deck unfinished IME input blocks save while appearance changes retain composition', async () => {
  const h = harness(), session = await h.open(), container = new h.Element()
  await session.attach(container, true)
  const input = container.children[1]
  input.focus(); input.dispatchEvent({ type: 'compositionstart' })
  const before = h.calls.filter(call => call[0] === 'active').length
  session.setInteractive(false)
  await h.client.setRustPresentationTheme('dark')
  assert.equal(h.calls.filter(call => call[0] === 'active').length, before)
  await assert.rejects(session.export(), /输入法/)
  input.dispatchEvent({ type: 'compositionend' })
  h.pending(session.id, '中文😀')
  const result = await session.export()
  assert.equal(JSON.parse(new TextDecoder().decode(result.bytes)).text, '中文😀')
  await session.close(true)
})

test('Deck prepared handoffs are single use and retain the exact source across async loading', async () => {
  const h = harness(), source = h.source(), original = { ...source }
  const promise = h.client.prepareRustPresentationDocument(source)
  source.id = 'replacement'; source.base64 = '/w=='
  const prepared = await promise, session = prepared.take(original)
  assert.ok(session)
  assert.equal(prepared.take(original), undefined)
  const mismatched = await h.client.prepareRustPresentationDocument(h.source())
  assert.equal(mismatched.take(original), undefined)
  await session.inspect()
  assert.equal(h.state.size, 1)
  await assert.rejects(h.client.prepareRustPresentationDocument(h.source('old.ppt')), /PPTX/)
  assert.equal(h.state.size, 1)
})

test('Deck component only marks the exact PPTX export as saved; PDF does not consume its receipt', async () => {
  const h = harness(), mounted = h.component(), editor = mounted.editor
  await editor.command('text.set', { text: 'save me' })
  const exported = await editor.exportFile()
  await assert.rejects(editor.markSaved('different bytes'), /导出结果不同/)
  const pdf = await editor.exportFile({ format: 'pdf' })
  assert.equal(pdf.extension, 'pdf')
  await editor.markSaved(exported.base64)
  assert.equal((await editor.inspect()).dirty, false)
  await editor.command('text.set', { text: 'newer' })
  await assert.rejects(editor.markSaved(exported.base64), /又有修改/)
  assert.equal((await editor.inspect()).dirty, true)
  await editor.undo(); assert.equal((await editor.query('text.get')).text, 'save me')
  await editor.redo(); assert.equal((await editor.query('text.get')).text, 'newer')
  mounted.dispose()
})

test('presentation sync revision observes pending input without committing it', async () => {
  const h = harness(), mounted = h.component(), editor = mounted.editor
  const before = await editor.inspect()
  h.pending(before.sessionId, 'pending shared text')
  assert.equal((await editor.inspect()).revision, before.revision, 'Read-only inspection does not commit the draft')
  const flushes = h.calls.filter(call => call[0] === 'flush').length
  const synced = await editor.syncRevision()
  assert.equal(synced.revision, before.revision)
  assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
  const exported = await editor.exportFile()
  assert.equal(exported.revision, `${synced.documentId}:${synced.revision + 1}`)
  assert.equal((await editor.inspect()).dirty, true, 'A synchronization snapshot is not a filesystem save receipt')
  mounted.dispose()
})

for (const kind of ['word', 'presentation']) {
  const format = kind === 'word' ? 'docx' : 'pptx'
  const readyUi = () => ({ dialog: null, showing: null, home: false })

  test(`${kind} background readiness is read-only and rejects absent or modal UI state`, async () => {
    const h = harness(kind), session = await h.open(), doc = h.state.get(session.id)
    h.pending(session.id, 'unfinished input')
    const before = JSON.stringify(doc), flushes = h.calls.filter(call => call[0] === 'flush').length
    assert.equal(await session.canBackgroundExport(), false, 'Prepared sessions have no active UI state')
    assert.equal(JSON.stringify(doc), before)
    for (const ui of [undefined, null, false, [], {}, { dialog: 'format' }, ...(kind === 'presentation'
      ? [{ ...readyUi(), showing: {} }, { ...readyUi(), home: true }, { dialog: null, showing: null }]
      : [])]) {
      doc.ui = ui
      assert.equal(await session.canBackgroundExport(), false)
      await assert.rejects(session.export(format, { background: true }), /稍后/)
    }
    doc.ui = readyUi()
    doc.selection = { text: { start: 0, end: 0 } }
    assert.equal(await session.canBackgroundExport(), true, 'Normal text selection stays editable')
    assert.equal(doc.revision, 0)
    assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
    assert.equal(h.calls.filter(call => call[0] === 'export').length, 0)
    await session.close(true)
  })

  test(`${kind} background export and save acknowledgement recheck UI without flushing`, async () => {
    const h = harness(kind), session = await h.open(), doc = h.state.get(session.id)
    doc.ui = readyUi()
    await session.command('text.set', { text: 'saved revision' })
    const flushes = h.calls.filter(call => call[0] === 'flush').length
    const exported = await session.export(format, { background: true })
    assert.equal(await session.canBackgroundExport(), true)
    doc.ui.dialog = 'font'
    await assert.rejects(session.export(format, { background: true }), /稍后/)
    await assert.rejects(session.markSaved(exported.snapshot.documentId, exported.snapshot.revision, { background: true }), /稍后/)
    assert.equal(h.calls.filter(call => call[0] === 'export').length, 1)
    assert.equal(h.calls.filter(call => call[0] === 'saved').length, 0)
    doc.ui = readyUi()
    doc.revision++; doc.text = 'newer local revision'; doc.dirty = true
    await assert.rejects(session.markSaved(exported.snapshot.documentId, exported.snapshot.revision, { background: true }), /又有修改/)
    assert.equal(doc.dirty, true)
    const current = await session.export(format, { background: true })
    await session.markSaved(current.snapshot.documentId, current.snapshot.revision, { background: true })
    assert.equal(doc.dirty, false)
    assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
    await session.close(true)
  })

  test(`${kind} background work retains IME focus and does not commit composition`, async () => {
    const h = harness(kind), session = await h.open(), container = new h.Element()
    await session.attach(container, true)
    const exported = await session.export(format, { background: true }), input = container.children[1]
    input.focus(); input.dispatchEvent({ type: 'compositionstart' })
    h.pending(session.id, 'uncommitted composition')
    const before = JSON.stringify(h.state.get(session.id)), flushes = h.calls.filter(call => call[0] === 'flush').length
    assert.equal(await session.canBackgroundExport(), false)
    await assert.rejects(session.export(format, { background: true }), /稍后/)
    await assert.rejects(session.markSaved(exported.snapshot.documentId, exported.snapshot.revision, { background: true }), /稍后/)
    assert.equal(h.document.activeElement, input)
    assert.equal(JSON.stringify(h.state.get(session.id)), before)
    assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
    input.dispatchEvent({ type: 'compositionend' })
    await session.close(true)
  })

  test(`${kind} component background paths and revision inspection skip flush`, async () => {
    const h = harness(kind), mounted = h.component(), editor = mounted.editor
    const before = await editor.inspect(), doc = h.state.get(before.sessionId)
    doc.ui = readyUi()
    h.pending(before.sessionId, 'unrendered input')
    const flushes = h.calls.filter(call => call[0] === 'flush').length
    assert.equal(await editor.canBackgroundExport(), true)
    assert.equal((await editor.syncRevision()).revision, before.revision)
    const exported = await editor.exportFile({ background: true })
    assert.equal(exported.revision, `${before.documentId}:${before.revision}`)
    assert.equal(doc.text, '')
    await editor.markSaved(exported.base64, { background: true })
    assert.equal(h.calls.filter(call => call[0] === 'flush').length, flushes)
    const manual = await editor.exportFile()
    assert.equal(manual.revision, `${before.documentId}:${before.revision + 1}`)
    assert.equal(doc.text, 'unrendered input')
    mounted.dispose()
  })
}

test('Deck component failed direct replacement preserves the previous presentation', async () => {
  const h = harness(), mounted = h.component(), editor = mounted.editor
  await editor.command('text.set', { text: 'keep original' })
  const before = await editor.inspect()
  mounted.props.document = h.source('broken.pptx', '/w==')
  await vue.nextTick()
  const after = await editor.inspect()
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.revision, before.revision)
  assert.equal((await editor.query('text.get')).text, 'keep original')
  assert.ok(mounted.events.some(event => event[0] === 'error' && /Invalid/.test(event[1])))
  mounted.dispose()
})

for (const kind of ['word', 'presentation']) {
  test(`${kind} switching settles live input without exporting or acknowledging saved bytes`, async () => {
    const h = harness(kind), mounted = h.component(), editor = mounted.editor
    try {
      const original = await editor.inspect()
      await editor.discardChanges()
      assert.equal(h.calls.filter(call => call[0] === 'export' || call[0] === 'saved').length, 0, 'An imported clean document needs no export receipt to close')
      h.pending(original.sessionId, 'queued live content')
      const settled = await editor.prepareDeactivate()
      assert.equal(settled.documentId, original.documentId)
      assert.equal(settled.revision, original.revision + 1)
      assert.equal(settled.dirty, true)
      assert.equal(h.state.get(original.sessionId).text, 'queued live content')
      assert.equal(h.calls.filter(call => call[0] === 'export' || call[0] === 'saved').length, 0, 'Settling input is neither serialization nor a save')
      await assert.rejects(editor.discardChanges(), /未保存/)
      const receipt = await editor.exportFile()
      await assert.rejects(editor.discardChanges(), /未保存/, 'An in-memory export must not authorize discarding unsaved content')
      await editor.markSaved(receipt.base64)
      await editor.discardChanges()
      await editor.undo()
      assert.equal(h.state.get(original.sessionId).text, '')
      await editor.redo()
      assert.equal(h.state.get(original.sessionId).text, 'queued live content', 'Switch preparation and save acknowledgment preserve undo history')
      await assert.rejects(editor.markSaved(receipt.base64), /又有修改/)
      await assert.rejects(editor.discardChanges(), /未保存/)
    } finally { mounted.dispose() }
  })
}

for (const kind of ['word', 'presentation']) {
 test(`${kind} MCP guard cancels commands revoked while queued or while flushing, before any engine mutation`, async () => {
  const h = harness(kind), current = await h.open()
  let revoked = true
  const guard = () => { if (revoked) throw Error('MCP session stopped') }
  const command = () => kind === 'pdf' ? current.command('text.set', { text: 'remote text' }, guard) : current.command('text.set', { text: 'remote text' }, undefined, guard)
  const initial = h.calls.length
  await assert.rejects(command(), /MCP session stopped/)
  assert.equal(h.calls.length, initial)
  revoked = false
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  h.setFlushGate(async () => { entered(); await blocked })
  const pending = command()
  await waiting
  revoked = true; release()
  await assert.rejects(pending, /MCP session stopped/)
  assert.equal(h.state.get(current.id).text, '')
  assert.equal(h.calls.filter(call => call[0] === 'command' && call[2] === 'text.set').length, 0)
  h.setFlushGate(undefined); revoked = false
  await command()
  assert.equal(h.state.get(current.id).text, 'remote text')
  assert.equal(h.state.get(current.id).dirty, true)
  await current.close(true)
 })
}
