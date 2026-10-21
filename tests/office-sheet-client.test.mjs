import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/sheet/rust/client.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

// Exercise the real client with explicit event provenance and a host double.
// Actual Rust hit testing and trusted OS events are covered by the native gate.
function harness() {
  const state = new Map(), calls = [], document = { baseURI: 'http://localhost/', activeElement: null }
  let nextId = 0, failGesture = false
  class Element {
    children = []; parentElement; style = {}; dataset = {}; isConnected = true; listeners = new Map()
    rect = { left: 23, top: 57, width: 900, height: 600 }
    append(child) { child.remove(); this.children.push(child); child.parentElement = this }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = undefined }
    setAttribute() {}
    getBoundingClientRect() { return this.rect }
    addEventListener(type, callback) { const list = this.listeners.get(type) ?? []; list.push(callback); this.listeners.set(type, list) }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== callback)) }
    dispatchEvent(event) { for (const callback of this.listeners.get(event.type) ?? []) callback({ target: this, ...event }); return true }
    focus() { calls.push(['focus']); document.activeElement = this; this.dispatchEvent({ type: 'focus' }) }
    blur() { calls.push(['blur']); document.activeElement = null }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] }
  }
  class Input extends Element {}
  document.body = new Element()
  document.createElement = tag => tag === 'input' ? new Input() : new Element()
  const snapshot = id => JSON.stringify(state.get(id))
  const host = {
    prepare(id, name) {
      state.set(id, { sessionId: id, name, documentId: ++nextId, revision: 0, dirty: false, sheets: [{ name: 'Sheet1', index: 0 }], ui: { mode: 'Ready', editor: null } })
      return snapshot(id)
    },
    async start(canvas) { calls.push(['start']); canvas.parentElement.append(new Input()) },
    activate(id) { calls.push(['activate', id]); return snapshot(id) },
    inspect: snapshot,
    async flush(id) { calls.push(['flush', id]) },
    trustedDoubleClick(id, documentId, x, y, modifiers) {
      calls.push(['double', id, documentId, x, y, modifiers])
      if (failGesture) throw Error('Gesture host unavailable')
      const value = state.get(id), handled = !value.ui.editor
      if (handled) { value.ui = { mode: 'Edit', editor: { cell: 'D6' } }; value.revision++ }
      return JSON.stringify({ handled, snapshot: value })
    },
    command(...args) { calls.push(['command', ...args]); throw Error('Unexpected command fallback') },
    close(id) { calls.push(['close', id]); state.delete(id); return true },
    setActive(value) { calls.push(['active', value]) },
    setTheme() {},
    destroy() { calls.push(['destroy']) },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, document, URL, Uint8Array, setTimeout, clearTimeout,
    window: { dispatchEvent() {} }, HTMLElement: Element, HTMLInputElement: Input,
    Event: class { constructor(type) { this.type = type } }, FocusEvent: class { constructor(type) { this.type = type } },
    require(name) {
      if (name === '../../shared/document') return { base64ToBytes: () => new Uint8Array() }
      if (name === '../../shared/id') return { createId: () => String(++nextId) }
      if (name === '../../smoke') return { smokeStage() {} }
      if (name === 'http://localhost/office-sheet/office-sheet.js') return { default: async () => {}, createHost: () => host }
      throw Error(`Unexpected import ${name}`)
    },
  })
  async function open() {
    const input = { id: `source-${++nextId}`, name: 'Workbook.xlsx', extension: 'xlsx', base64: '' }
    return (await module.exports.prepareRustSheetDocument(input)).take(input)
  }
  const gesture = (canvas, overrides = {}) => canvas.dispatchEvent({ type: 'dblclick', isTrusted: true, button: 0, detail: 2,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, clientX: 223, clientY: 257, ...overrides })
  return { open, Element, state, calls, document, gesture, failGesture() { failGesture = true } }
}

test('Sheet browser-recognized double-click reaches the current Rust session synchronously without flush or focus changes', async () => {
  const h = harness(), session = await h.open(), container = new h.Element()
  await session.attach(container, true)
  const [canvas, input] = container.children
  h.document.activeElement = canvas
  const before = h.calls.length
  h.gesture(canvas)
  assert.deepEqual(h.calls.slice(before), [['double', session.id, session.snapshot.documentId, 200, 200, false]])
  assert.equal(session.snapshot.ui.editor.cell, 'D6')
  assert.equal(session.snapshot.revision, 1)
  assert.equal(h.document.activeElement, canvas, 'The adapter leaves natural Rust input focus handoff intact')
  h.gesture(canvas)
  assert.equal(session.snapshot.revision, 1, 'A host no-op for an existing editor does not replace its draft')
  assert.equal(input.listeners.get('focus').length, 1)
  assert.equal(canvas.listeners.get('dblclick').length, 1)
})

test('Sheet ignores synthetic, modified, wrong-target and out-of-bounds double-clicks', async () => {
  const h = harness(), session = await h.open(), container = new h.Element()
  await session.attach(container, true)
  const [canvas, input] = container.children
  for (const overrides of [
    { isTrusted: false }, { button: 1 }, { detail: 1 }, { detail: 3 },
    { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { target: input }, { clientX: 22 }, { clientX: 923 }, { clientY: 56 }, { clientY: 657 },
    { clientX: NaN }, { clientY: Infinity },
  ]) h.gesture(canvas, overrides)
  canvas.isConnected = false; h.gesture(canvas); canvas.isConnected = true
  input.dispatchEvent({ type: 'compositionstart' }); h.gesture(canvas)
  assert.equal(h.calls.filter(([kind]) => kind === 'double').length, 0)
  assert.equal(session.snapshot.revision, 0)
  input.dispatchEvent({ type: 'compositionend' }); h.gesture(canvas)
  assert.equal(h.calls.filter(([kind]) => kind === 'double').length, 1)
})

test('Sheet shared canvas double-click listener follows tab identity and rejects disabled, retired and pending activations', async () => {
  const h = harness(), first = await h.open(), second = await h.open(), a = new h.Element(), b = new h.Element()
  await first.attach(a, true)
  const canvas = a.children[0]
  first.setInteractive(false); h.gesture(canvas)
  first.setInteractive(true); first.deactivate(); h.gesture(canvas)
  await first.attach(a, true)
  const nextAttach = second.attach(b, true)
  h.gesture(canvas) // The next tab has requested activation, but its queued attach has not run.
  await nextAttach
  const before = h.calls.length
  h.gesture(canvas)
  assert.deepEqual(h.calls.slice(before), [['double', second.id, second.snapshot.documentId, 200, 200, false]])
  assert.equal(first.snapshot.revision, 0)
  assert.equal(second.snapshot.revision, 1)
  assert.equal(canvas.listeners.get('dblclick').length, 1, 'Moving a shared canvas does not install another listener')
  await second.close(true)
  const count = h.calls.filter(([kind]) => kind === 'double').length
  h.gesture(canvas)
  assert.equal(h.calls.filter(([kind]) => kind === 'double').length, count)
  await first.attach(a, true); h.gesture(canvas)
  assert.equal(first.snapshot.revision, 1)
})

test('Sheet gesture host errors are reported without fallback commands, committing drafts or moving focus', async () => {
  const h = harness(), session = await h.open(), container = new h.Element(), events = []
  session.onEvent(event => events.push(event))
  await session.attach(container, true)
  const before = h.calls.length
  h.failGesture(); h.gesture(container.children[0])
  assert.deepEqual(h.calls.slice(before).map(([kind]) => kind), ['double'])
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
  assert.match(events[0].message, /Gesture host unavailable/)
  assert.equal(session.snapshot.revision, 0)
})
