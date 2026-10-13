import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as documentHelpers from '../src/shared/document.ts'

// Run the actual bridge with controlled frame, listener and timer ownership.
// No browser, native office engine or WASM runtime is started by these tests.
const source = await readFile(new URL('../src/office/bridge.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function bridgeHarness(t) {
  const origin = 'http://127.0.0.1:5198'
  const listeners = new Set(), timers = new Map(), posts = [], events = [], removals = [], navigations = []
  let nextId = 0, nextTimer = 0, src = ''
  const contentWindow = { postMessage(sentMessage, targetOrigin, transfer) {
    const message = structuredClone(sentMessage, { transfer })
    posts.push({ message, sentMessage, targetOrigin, transfer })
  } }
  const frame = {
    contentWindow,
    get src() { return src },
    set src(value) { src = value; navigations.push(value) },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, URL, Error, ArrayBuffer, Uint8Array, atob, btoa,
    require(name) {
      if (name === '../shared/document') return documentHelpers
      throw Error(`Unexpected bridge import: ${name}`)
    },
    crypto: { randomUUID: () => `bridge-id-${++nextId}` },
    document: { baseURI: `${origin}/` }, location: { origin },
    window: {
      addEventListener(type, listener) { assert.equal(type, 'message'); listeners.add(listener) },
      removeEventListener(type, listener) { assert.equal(type, 'message'); removals.push(listener); listeners.delete(listener) },
    },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  const { OfficeBridge, OFFICE_CHANNEL } = module.exports
  const bridge = new OfficeBridge(frame, event => events.push(event))
  frame.src = bridge.hostUrl
  const receive = [...listeners][0]
  const message = (data = {}, overrides = {}) => ({
    origin, source: contentWindow,
    data: { channel: OFFICE_CHANNEL, session: bridge.session, ...data },
    ...overrides,
  })
  const emit = (data, overrides) => {
    for (const listener of [...listeners]) listener(message(data, overrides))
  }
  t.after(() => bridge.dispose())
  return { bridge, frame, contentWindow, origin, listeners, timers, posts, events, removals, navigations, receive, message, emit }
}

async function until(predicate) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail('Bridge did not reach the expected promise boundary')
}

test('disposing before startup rejects ready and the queued open without sending it', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  const open = h.bridge.request('open', { id: 'A', base64: 'U09VUkNF' }, 'A')
  const readyRejected = assert.rejects(h.bridge.ready, /关闭/)
  const openRejected = assert.rejects(open, /关闭/)
  assert.equal(h.timers.size, 1, 'Only the startup timer exists while open awaits readiness')

  h.bridge.dispose()

  assert.equal(h.timers.size, 0)
  assert.equal(h.bridge.pending.size, 0)
  assert.equal(h.listeners.size, 0)
  await Promise.all([readyRejected, openRejected])
  await assert.rejects(h.bridge.request('open', { id: 'B' }, 'B'), /关闭/)
  assert.equal(h.posts.length, 0)
  assert.equal(h.timers.size, 0)
})

test('disposing a ready bridge rejects every pending RPC and clears its timers immediately', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  assert.equal(h.timers.size, 0)
  const first = h.bridge.request('open', { id: 'A' }, 'A')
  const second = h.bridge.request('word-state', {}, 'A')
  const rejected = [assert.rejects(first, /关闭/), assert.rejects(second, /关闭/)]
  await until(() => h.posts.length === 2)
  assert.equal(h.timers.size, 2)
  assert.equal(h.bridge.pending.size, 2)

  h.bridge.dispose()

  assert.equal(h.timers.size, 0, 'No timeout needs to fire to reject the RPCs')
  assert.equal(h.bridge.pending.size, 0)
  await Promise.all(rejected)
  await assert.rejects(h.bridge.request('export', {}, 'A'), /关闭/)
  assert.equal(h.posts.length, 2)
  assert.equal(h.timers.size, 0)
})

test('closing after ready but before a request resumes prevents posting or creating an RPC timer', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const pending = h.bridge.request('open', { id: 'A' }, 'A')
  h.bridge.dispose()
  await assert.rejects(pending, /关闭/)
  assert.equal(h.posts.length, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.bridge.pending.size, 0)
})

test('startup and RPC replies require the current origin, frame, channel and session', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  const invalid = [
    [{}, { origin: 'https://other.example' }],
    [{}, { source: {} }],
    [{ channel: 'old-channel' }, {}],
    [{ session: 'old-session' }, {}],
  ]
  for (const [data, overrides] of invalid) h.emit({ event: 'engine-ready', ...data }, overrides)
  assert.equal(h.timers.size, 1, 'Invalid ready messages cannot finish startup')
  assert.equal(h.events.length, 0)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const result = h.bridge.request('word-state', {}, 'A')
  await until(() => h.posts.length === 1)
  const { requestId } = h.posts[0].message
  for (const [data, overrides] of invalid) {
    h.emit({ requestId, ok: true, data: { stale: true }, ...data }, overrides)
  }
  h.emit({ requestId: 'unknown-request', ok: true, data: { stale: true } })
  assert.equal(h.timers.size, 1)
  assert.equal(h.bridge.pending.size, 1, 'Old sources and sessions cannot settle the current request')
  assert.equal(h.events.length, 1)

  const response = { documentId: 'A', revision: 7 }
  h.emit({ requestId, ok: true, data: response })
  assert.equal(await result, response)
  assert.equal(h.timers.size, 0)
  assert.equal(h.bridge.pending.size, 0)
})

test('dispose drops frame and event references, unloads the frame once and ignores already queued messages', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const queued = [
    h.message({ event: 'engine-ready' }),
    h.message({ event: 'dirty', data: { dirty: true } }),
    h.message({ event: 'error', error: 'Late engine error' }),
    h.message({ requestId: 'old-request', ok: true, data: { stale: true } }),
  ]
  const eventCount = h.events.length

  h.bridge.dispose()
  h.bridge.dispose()

  assert.equal(h.bridge.frame, null, 'A retained bridge must not retain the iframe')
  assert.equal(h.bridge.onEvent, null, 'A retained bridge must not retain its owner callback')
  assert.equal(h.frame.src, 'about:blank')
  assert.deepEqual(h.navigations, [h.bridge.hostUrl, 'about:blank'])
  assert.deepEqual(h.removals, [h.receive])
  assert.equal(h.listeners.size, 0)
  Object.defineProperty(h.frame, 'contentWindow', { get() { assert.fail('Disposed messages must not access the old frame') } })
  for (const event of queued) assert.doesNotThrow(() => h.receive(event))
  assert.equal(h.events.length, eventCount)
  assert.equal(h.timers.size, 0)
  await assert.rejects(h.bridge.request('word-state', {}, 'A'), /关闭/)
})

test('normal RPCs preserve request payloads, results, errors and event delivery', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const data = Object.freeze({ id: 'A', type: 'state' })
  const state = h.bridge.request('word-state', data, 'A')
  await until(() => h.posts.length === 1)
  const posted = h.posts[0]
  assert.equal(posted.targetOrigin, h.origin)
  assert.equal(posted.message.channel, 'open-office-engine')
  assert.equal(posted.message.session, h.bridge.session)
  assert.equal(posted.message.action, 'word-state')
  assert.equal(posted.message.documentId, 'A')
  assert.equal(posted.sentMessage.data, data, 'Ordinary RPCs do not allocate a replacement payload')
  assert.deepEqual(posted.message.data, data)
  assert.equal(posted.transfer.length, 0)
  const result = { id: 'A', revision: 0 }
  h.emit({ requestId: posted.message.requestId, ok: true, data: result })
  assert.equal(await state, result)
  assert.equal(h.timers.size, 0)

  const failed = h.bridge.request('export', { format: 'docx' }, 'A')
  const rejection = assert.rejects(failed, /Expected export failure/)
  await until(() => h.posts.length === 2)
  assert.notEqual(h.posts[1].message.requestId, posted.message.requestId)
  h.emit({ requestId: h.posts[1].message.requestId, ok: false, error: 'Expected export failure' })
  await rejection
  assert.equal(h.timers.size, 0)
  assert.equal(h.bridge.pending.size, 0)
  h.emit({ event: 'dirty', documentId: 'A', data: { dirty: true } })
  assert.deepEqual(h.events.map(event => event.event), ['engine-ready', 'dirty'])
})

for (const action of ['open', 'insert-image']) {
  test(`${action} transfers bytes and detaches the sender buffer without changing original data`, { timeout: 1000 }, async t => {
    const h = bridgeHarness(t)
    h.emit({ event: 'engine-ready' })
    await h.bridge.ready
    const bytes = Uint8Array.from({ length: 49159 }, (_, index) => (index * 37) % 256)
    const base64 = Buffer.from(bytes).toString('base64')
    const data = Object.freeze({ id: 'A', name: 'fixture.bin', mime: 'application/octet-stream', base64 })
    const result = h.bridge.request(action, data, 'A')
    await until(() => h.posts.length === 1)

    const posted = h.posts[0]
    assert.notEqual(posted.sentMessage.data, data)
    assert.equal(posted.transfer.length, 1)
    assert.equal(posted.transfer[0], posted.sentMessage.data.buffer)
    assert.equal(posted.sentMessage.data.buffer.byteLength, 0, 'A real transfer detaches the sender allocation')
    assert.equal('base64' in posted.sentMessage.data, false)
    assert.equal('base64' in posted.message.data, false)
    assert.deepEqual(new Uint8Array(posted.message.data.buffer), bytes)
    const { buffer, ...metadata } = posted.message.data
    assert.deepEqual(metadata, { id: 'A', name: 'fixture.bin', mime: 'application/octet-stream' })
    assert.equal(buffer.byteLength, bytes.length)
    assert.deepEqual(data, { id: 'A', name: 'fixture.bin', mime: 'application/octet-stream', base64 })
    assert.equal('buffer' in data, false)
    assert.equal(h.bridge.pending.size, 1)
    h.emit({ requestId: posted.message.requestId, ok: true, data: { id: 'A' } })
    assert.equal((await result).id, 'A')
    assert.equal(h.timers.size, 0)
  })
}

test('export requests binary transfer and restores the public base64 result with metadata', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const options = Object.freeze({ format: 'docx', binary: false })
  const result = h.bridge.request('export', options, 'A')
  await until(() => h.posts.length === 1)
  const posted = h.posts[0]
  assert.deepEqual(posted.message.data, { format: 'docx', binary: true })
  assert.notEqual(posted.sentMessage.data, options)
  assert.deepEqual(options, { format: 'docx', binary: false })
  assert.equal(posted.transfer.length, 0)

  const bytes = Uint8Array.from({ length: 49159 }, (_, index) => (index * 17) % 256)
  const expected = Buffer.from(bytes).toString('base64')
  const response = structuredClone({
    requestId: posted.message.requestId, ok: true,
    data: { buffer: bytes.buffer, extension: 'docx', name: 'A.docx', revision: 7, dirty: true },
  }, { transfer: [bytes.buffer] })
  assert.equal(bytes.byteLength, 0, 'The simulated engine also transfers ownership of export bytes')
  h.emit(response)
  const exported = await result
  assert.deepEqual({ ...exported }, { extension: 'docx', name: 'A.docx', revision: 7, dirty: true, base64: expected })
  assert.equal('buffer' in exported, false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.bridge.pending.size, 0)
})

test('old frames and sessions cannot settle a binary export or access its byte payload', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const result = h.bridge.request('export', { format: 'pptx' }, 'A')
  await until(() => h.posts.length === 1)
  const { requestId } = h.posts[0].message
  const stale = { get buffer() { assert.fail('Rejected response identities must not access payload bytes') } }
  for (const [data, overrides] of [
    [{}, { origin: 'https://other.example' }],
    [{}, { source: {} }],
    [{ session: 'old-session' }, {}],
    [{ channel: 'old-channel' }, {}],
    [{ requestId: 'unknown-request' }, {}],
  ]) {
    h.emit({ requestId, ok: true, data: stale, ...data }, overrides)
    assert.equal(h.bridge.pending.size, 1)
    assert.equal(h.timers.size, 1)
  }
  h.emit({ requestId, ok: true, data: { buffer: Uint8Array.from([0, 255, 128]).buffer, extension: 'pptx' } })
  assert.equal((await result).base64, 'AP+A')
  assert.equal(h.bridge.pending.size, 0)
  assert.equal(h.timers.size, 0)
})

test('ordinary RPC replies retain buffer fields without attempting export conversion', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const result = h.bridge.request('word-state', {}, 'A')
  await until(() => h.posts.length === 1)
  const data = { buffer: Uint8Array.from([1, 2, 3]).buffer, revision: 9 }
  h.emit({ requestId: h.posts[0].message.requestId, ok: true, data })
  assert.equal(await result, data)
  assert.equal('base64' in data, false)
  assert.equal(h.timers.size, 0)
})

for (const failure of ['postMessage', 'missing-frame-window']) {
  test(`${failure} failure rejects the async request and immediately clears its timer`, { timeout: 1000 }, async t => {
    const h = bridgeHarness(t)
    h.emit({ event: 'engine-ready' })
    await h.bridge.ready
    const sendError = new DOMException('Expected transfer failure', 'DataCloneError')
    let sendCalls = 0
    if (failure === 'postMessage') h.contentWindow.postMessage = () => { sendCalls++; throw sendError }
    else h.frame.contentWindow = null
    const data = Object.freeze({ id: 'A', base64: 'U09VUkNF' })
    const result = h.bridge.request('open', data, 'A')
    await assert.rejects(result, failure === 'postMessage' ? /Expected transfer failure/ : /关闭/)
    assert.equal(sendCalls, failure === 'postMessage' ? 1 : 0)
    assert.equal(h.posts.length, 0)
    assert.equal(h.bridge.pending.size, 0)
    assert.equal(h.timers.size, 0)
    assert.equal(data.base64, 'U09VUkNF')
    assert.equal('buffer' in data, false)
  })
}

test('malformed export bytes reject after removing pending state and its timer', { timeout: 1000 }, async t => {
  const h = bridgeHarness(t)
  h.emit({ event: 'engine-ready' })
  await h.bridge.ready
  const result = h.bridge.request('export', { format: 'docx' }, 'A')
  const rejection = assert.rejects(result, /数据无效/)
  await until(() => h.posts.length === 1)
  h.emit({ requestId: h.posts[0].message.requestId, ok: true, data: { buffer: Uint8Array.from([1, 2, 3]) } })
  await rejection
  assert.equal(h.bridge.pending.size, 0)
  assert.equal(h.timers.size, 0)
})
