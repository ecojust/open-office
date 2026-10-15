import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/sheet/rust/macos-editing-smoke.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const bootId = 'd3b1ead1-d8e1-418f-b964-cd13826da6ac'
function harness({ native = false, optedIn = false, boot, existing = [], liveTimeOrigin = () => 12345, dom } = {}) {
  const module = { exports: {} }, calls = [], listeners = new Set()
  const window = {
    __OPEN_OFFICE_DIAGNOSTIC_BOOT__: boot,
    addEventListener(name) { listeners.add(name) },
    removeEventListener(name) { listeners.delete(name) },
    ...dom?.window,
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, window, document: dom?.document, Node: dom?.Node, performance: { get timeOrigin() { return liveTimeOrigin() } }, setTimeout, clearTimeout,
    require(name) {
      if (name === '@tauri-apps/api/core') return { isTauri: () => native }
      if (name === '../../smoke') return { smokeRequested: () => optedIn, smokeStage: (...args) => calls.push(['stage', ...args]) }
      throw Error(`Unexpected runtime dependency ${name}`)
    },
  })
  const adapter = { tabs: () => existing, open: async () => { calls.push(['open']); throw Error('No fixture should be opened') }, close: async key => { calls.push(['close', key]) } }
  return { api: module.exports, adapter, calls, listeners }
}
test('native editing diagnostic rejects browser transport before opening documents', async () => {
  const h = harness({ optedIn: true })
  await assert.rejects(h.api.runMacosEditingSmoke(h.adapter), /opted-in native WebView/)
  assert.deepEqual(h.calls, [])
})
test('native editing diagnostic requires the process opt-in even when Tauri IPC exists', async () => {
  const h = harness({ native: true })
  await assert.rejects(h.api.runMacosEditingSmoke(h.adapter), /opted-in native WebView/)
  await assert.rejects(h.api.runMacosEditingSmoke(h.adapter, { editEntry: 'f2' }), /opted-in native WebView/)
  await assert.rejects(h.api.runMacosEditingSmoke(h.adapter, { editEntry: 'preselect' }), /opted-in native WebView/)
  assert.deepEqual(h.calls, [])
})
test('unknown editing entry is rejected before reading boot state or opening documents', async () => {
  const h = harness({ native: true, optedIn: true })
  await assert.rejects(h.api.runMacosEditingSmoke(h.adapter, { editEntry: 'other' }), /unsupported diagnostic edit entry/)
  assert.deepEqual(h.calls, [])
  assert.equal(h.listeners.size, 0)
})
test('native F2 control is explicitly marked diagnostic-only and has no double-click check', async () => {
  const h = harness({ native: true, optedIn: true, boot: { bootId, timeOrigin: 12345 },
    existing: [{ key: 'user-unsaved-work', kind: 'sheet', dirty: true, ready: true }] })
  const report = await h.api.runMacosEditingSmoke(h.adapter, { editEntry: 'f2' })
  assert.equal(report.editEntry, 'f2')
  assert.equal(report.diagnosticOnly, true)
  assert.equal(report.transport, 'local-wasm-in-native-webview')
  assert.equal(report.ok, false)
  assert.match(report.error, /cold empty workbench/)
  assert.equal(report.cleanup.attempted, 0)
  assert.ok(h.calls.every(([name]) => name === 'stage'))
  assert.deepEqual([...h.api.MACOS_EDITING_F2_CHECKS], [...h.api.MACOS_EDITING_CHECKS].map(check =>
    check === 'sheet-double-click-native-typing' ? 'sheet-f2-native-typing' : check))
  assert.ok(!h.api.MACOS_EDITING_F2_CHECKS.includes('sheet-double-click-native-typing'))
  assert.equal(h.listeners.size, 0)
})
test('preselection control is diagnostic-only and cannot touch a nonempty user workbench', async () => {
  const h = harness({ native: true, optedIn: true, boot: { bootId, timeOrigin: 12345 },
    existing: [{ key: 'user-unsaved-work', kind: 'sheet', dirty: true, ready: true }] })
  const report = await h.api.runMacosEditingSmoke(h.adapter, { editEntry: 'preselect' })
  assert.equal(report.editEntry, 'preselect')
  assert.equal(report.diagnosticOnly, true)
  assert.equal(report.ok, false)
  assert.match(report.error, /cold empty workbench/)
  assert.equal(report.cleanup.attempted, 0)
  assert.ok(h.calls.every(([name]) => name === 'stage'))
  assert.deepEqual([...h.api.MACOS_EDITING_PRESELECT_CHECKS], [...h.api.MACOS_EDITING_CHECKS].map(check =>
    check === 'sheet-double-click-native-typing' ? 'sheet-preselect-native-typing' : check))
  assert.ok(!h.api.MACOS_EDITING_PRESELECT_CHECKS.includes('sheet-double-click-native-typing'))
  assert.equal(h.listeners.size, 0)
})
test('native editing evidence refuses missing, malformed UUID or invalid captured timestamp markers', async () => {
  for (const boot of [undefined, { bootId: 'not-a-valid-native-boot', timeOrigin: 12345 },
    ...[NaN, Infinity, -1, 0, '12345', undefined].map(timeOrigin => ({ bootId, timeOrigin }))]) {
    const h = harness({ native: true, optedIn: true, boot })
    await assert.rejects(h.api.runMacosEditingSmoke(h.adapter), error => {
      assert.match(error.message, /boot marker is missing or invalid/)
      assert.match(error.message, /"markerType":/)
      assert.match(error.message, /"storedTimeOrigin":/)
      assert(Buffer.byteLength(error.message) < 400)
      return true
    })
    assert.deepEqual(h.calls, [])
  }
})
test('invalid boot details remain bounded even for an oversized non-ASCII identifier', async () => {
  const h = harness({ native: true, optedIn: true, boot: { bootId: '😀\\"\n'.repeat(1000), timeOrigin: 12345 } })
  await assert.rejects(h.api.runMacosEditingSmoke(h.adapter), error => {
    assert(Buffer.byteLength(error.message) < 400)
    assert.equal(error.message.includes('\n'), false)
    assert.match(error.message, /"storedTimeOrigin":"12345"/)
    return true
  })
  assert.deepEqual(h.calls, [])
})
test('captured boot identity does not depend on a repeated WebKit wall-clock conversion', async () => {
  let reads = 0
  const h = harness({ boot: Object.freeze({ bootId, timeOrigin: 12344 }),
    liveTimeOrigin: () => { reads++; return 12345 + reads },
    existing: [{ key: 'user-unsaved-work', kind: 'sheet', dirty: true, ready: true }] })
  const report = await h.api.verifyMacosEditing(h.adapter, () => { throw Error('No input should be requested') })
  assert.equal(report.bootId, bootId)
  assert.equal(report.timeOrigin, 12344, 'Report must preserve the exact native-captured timestamp')
  assert.match(report.error, /cold empty workbench/)
  assert.equal(reads, 0, 'The live wall-clock getter is not an identity source')
  assert.ok(h.calls.every(([name]) => name === 'stage'))
})
test('diagnostic refuses a nonempty user workbench without opening or closing any user tabs', async () => {
  const h = harness({ boot: { bootId, timeOrigin: 12345 }, existing: [{ key: 'user-unsaved-work', kind: 'sheet', dirty: true, ready: true }] })
  const report = await h.api.verifyMacosEditing(h.adapter, () => { throw Error('No input should be requested') })
  assert.equal(report.ok, false)
  assert.match(report.error, /cold empty workbench/)
  assert.equal(report.editEntry, 'doubleclick')
  assert.equal(report.diagnosticOnly, false)
  assert.equal(report.transport, 'local-wasm-in-browser')
  assert.deepEqual([...report.finalTabIds], ['user-unsaved-work'])
  assert.equal(report.cleanup.attempted, 0)
  assert.ok(h.calls.every(([name]) => name === 'stage'))
  assert.equal(h.listeners.size, 0)
})

function timelineFixture(enabled = true) {
  class Node {
    constructor(parent) { this.parent = parent }
    contains(node) { return node === this || !!node?.parent && this.contains(node.parent) }
    get value() { throw Error('DOM values must never be read') }
    get textContent() { throw Error('DOM text must never be read') }
    getAttribute() { throw Error('Arbitrary DOM attributes must never be read') }
    focus() { throw Error('The logger must never change focus') }
  }
  const root = new Node(), canvas = new Node(root), input = new Node(root), sheet = new Node(root), outside = new Node()
  const document = { body: outside, activeElement: canvas }
  const listeners = new Map(), registrations = [], events = []
  const window = {
    addEventListener(name, callback, options) {
      registrations.push({ name, options })
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(callback)
    },
    removeEventListener(name, callback, capture) {
      assert.equal(capture, true)
      listeners.get(name)?.delete(callback)
    },
  }
  const h = harness({ dom: { Node, window, document } })
  const timeline = h.api.createEditingDomTimeline(bootId, enabled, detail => {
    assert.ok(detail.length <= 400)
    assert.ok(Buffer.byteLength(detail) <= 400, 'IDs and metadata must remain ASCII and fit the native note bound')
    events.push(JSON.parse(detail))
  })
  const scope = { root, canvas, input, actionId: 'double-d6', sessionId: `sheet-${bootId}` }
  function dispatch(type, target = canvas, isTrusted = true) {
    const event = { type, target, isTrusted,
      get data() { throw Error('Input text must never be read') },
      get key() { throw Error('Typed keys must never be read') },
      preventDefault() { throw Error('Events must remain untouched') },
      stopPropagation() { throw Error('Events must remain untouched') } }
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  return { timeline, scope, root, canvas, input, sheet, outside, document, registrations, listeners, events, dispatch }
}

test('DOM timeline is opt-in and installs no listeners when disabled', () => {
  const h = timelineFixture(false)
  h.timeline.begin(h.scope)
  h.dispatch('pointerdown')
  h.timeline.end(); h.timeline.stop()
  assert.deepEqual(h.events, [])
  assert.deepEqual(h.registrations, [])
})

test('DOM timeline preserves ordered identities, trusted flags and focus boundaries using metadata only', () => {
  const h = timelineFixture()
  h.dispatch('pointerdown')
  h.timeline.begin(h.scope)
  h.dispatch('pointerdown'); h.dispatch('pointerup'); h.dispatch('dblclick')
  h.document.activeElement = h.outside
  h.dispatch('blur', h.canvas)
  h.document.activeElement = h.input
  h.dispatch('focus', h.input, false)
  h.dispatch('selectionchange', h.document)
  h.timeline.end()
  assert.deepEqual(h.events.map(event => event.type), ['action-start', 'pointerdown', 'pointerup', 'dblclick', 'blur', 'focus', 'selectionchange', 'action-end'])
  assert.deepEqual(h.events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(h.events[1].trusted, true)
  assert.equal(h.events[4].activeElement, 'body')
  assert.equal(h.events[5].trusted, false)
  assert.equal(h.events[5].target, 'input')
  assert.equal(h.events[5].activeElement, 'input')
  assert.equal(h.events[6].target, 'document')
  for (const event of h.events) {
    assert.equal(event.bootId, bootId)
    assert.equal(event.sessionId, h.scope.sessionId)
    assert.equal(event.actionId, 'double-d6')
    assert.deepEqual(Object.keys(event).sort(), ['seq', 'actionId', 'type', 'trusted', 'target', 'activeElement', 'bootId', 'sessionId'].sort())
  }
  assert.ok(h.registrations.every(({ options }) => options.capture && options.passive))
})

test('DOM timeline filters other tabs, shell events and selection changes outside the sheet action', () => {
  const h = timelineFixture()
  h.timeline.begin(h.scope)
  h.dispatch('pointerdown', h.outside); h.dispatch('dblclick', h.outside)
  h.dispatch('focus', h.outside); h.dispatch('focus', h.sheet); h.dispatch('blur', h.sheet)
  h.document.activeElement = h.outside
  h.dispatch('selectionchange', h.document)
  h.document.activeElement = h.canvas
  h.dispatch('input', h.input); h.dispatch('keydown', h.input)
  assert.equal(h.events.length, 1, 'Only action-start should be recorded')
  h.dispatch('pointerdown', h.sheet)
  assert.equal(h.events[1].target, 'sheet')
  h.timeline.end()
  const count = h.events.length
  h.dispatch('focus', h.input); h.dispatch('selectionchange', h.document); h.dispatch('pointerup')
  assert.equal(h.events.length, count, 'No events after the active editing action')
})

test('DOM timeline caps the entire diagnostic at 60 notes across actions and removes listeners before cleanup', () => {
  const h = timelineFixture()
  h.timeline.begin(h.scope)
  for (let index = 0; index < 30; index++) h.dispatch('pointerdown')
  h.timeline.end()
  h.timeline.begin({ ...h.scope, actionId: 'f2-d6' })
  for (let index = 0; index < 100; index++) h.dispatch('selectionchange', h.document)
  h.timeline.end()
  h.timeline.begin(h.scope)
  assert.equal(h.events.length, 60)
  assert.equal(h.events.at(-1).seq, 60)
  assert.equal(h.events.at(-1).actionId, 'f2-d6')
  h.timeline.stop(); h.timeline.stop()
  assert.ok([...h.listeners.values()].every(listeners => listeners.size === 0))
  const before = h.registrations.length
  h.timeline.begin(h.scope)
  assert.equal(h.registrations.length, before, 'Stopped timeline cannot reactivate')
})

test('DOM timeline keeps long identities exact within the 400-character native bound and rejects unbounded IDs', () => {
  const h = timelineFixture()
  const scope = { ...h.scope, actionId: 'a'.repeat(64), sessionId: 's'.repeat(128) }
  h.timeline.begin(scope)
  h.dispatch('selectionchange', h.document)
  h.timeline.end()
  assert.equal(h.events.length, 3)
  assert.ok(h.events.every(event => event.actionId === scope.actionId && event.sessionId === scope.sessionId))
  const count = h.events.length
  for (const sessionId of ['s'.repeat(129), '用户输入', 'secret\nvalue']) {
    h.timeline.begin({ ...h.scope, sessionId }); h.dispatch('pointerdown'); h.timeline.end()
  }
  h.timeline.begin({ ...h.scope, actionId: 'a'.repeat(65) }); h.dispatch('pointerdown')
  assert.equal(h.events.length, count)
})
