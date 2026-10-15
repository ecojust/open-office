import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { base64ToBytes, bytesToBase64 } from '../src/shared/document.ts'
import * as mediaValidation from '../src/presentation/rust/media.ts'

const clientSource = await readFile(new URL('../src/presentation/rust/client.ts', import.meta.url), 'utf8')
const editorSource = (await readFile(new URL('../src/components/RustPresentationEditor.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
function evaluate(source, require, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, require, console, URL, Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout, crypto: { randomUUID }, ...globals })
  return module.exports
}
// Controlled WASM/DOM doubles exercise the real adapter's state transitions.
// Actual PPTX parsing, rendering and editing are checked in the browser/native gate.
function harness() {
  const state = new Map(), calls = [], document = { baseURI: 'http://localhost/', activeElement: null }
  let receive, documentId = 0, pendingText, startGate
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
      state.set(id, { sessionId: id, documentId: ++documentId, revision: 0, dirty: false, slides: [{ id: 'slide-1', index: 0, name: 'Slide 1' }], name, selection: [], text: '', undo: [], redo: [] })
      return snapshot(id)
    },
    async start(canvas) { calls.push(['start']); canvas.parentElement.append(new Input()); if (startGate) await startGate },
    activate(id) { calls.push(['activate', id]); return snapshot(id) },
    inspect: snapshot,
    async flush(id) { calls.push(['flush', id]); if (pendingText?.id === id) { edit(id, pendingText.text); pendingText = undefined } },
    command(id, commandId, params) {
      calls.push(['command', id, commandId]); const value = JSON.parse(params), doc = state.get(id)
      if (commandId === 'text.set') edit(id, value.text)
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
  const globals = { document, window: { dispatchEvent() {} }, HTMLElement: Element, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type } }, FocusEvent: class { constructor(type) { this.type = type } } }
  const client = evaluate(clientSource, name => {
    if (name === '../../shared/document') return { base64ToBytes }
    if (name === 'http://localhost/deckcraft/deckcraft.js') return { default: async () => {}, createHost(callback) { receive = callback; return host } }
    throw Error(`Unexpected import ${name}`)
  }, globals)
  const source = (name = 'slides.pptx', base64 = '') => ({ id: randomUUID(), name, base64, extension: name.split('.').at(-1) })
  async function open(input = source()) { const prepared = await client.prepareRustPresentationDocument(input); return prepared.take(input) }
  function component(input = source()) {
    const props = vue.reactive({ document: input, active: false, disabled: false, theme: 'system' }), events = [], unmount = []
    let exposed
    const scope = vue.effectScope()
    scope.run(() => evaluate(editorSource, name => {
      if (name === 'vue') return { ...vue, onBeforeUnmount(callback) { unmount.push(callback) } }
      if (name === '../shared/document') return { bytesToBase64 }
      if (name === '../presentation/rust/client') return client
      if (name === '../presentation/rust/media') return mediaValidation
      throw Error(`Unexpected component import ${name}`)
    }, { ...globals, defineProps: () => props, withDefaults: value => value, defineEmits: () => (...event) => events.push(event), defineExpose(value) { exposed = value } }))
    return { props, events, editor: exposed, dispose() { unmount.forEach(callback => callback()); scope.stop() } }
  }
  return { client, open, source, state, calls, document, Element, component, notify(event) { receive(JSON.stringify(event)) }, pending(id, text) { pendingText = { id, text } }, setStartGate(value) { startGate = value } }
}

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
