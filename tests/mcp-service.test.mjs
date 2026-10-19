import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpService } from '../src/mcp/service.ts'

// Exercise the real lifecycle controller. The controlled transport below is an
// IPC double; these tests do not claim that a native HTTP listener was started.
const config = { port: 38487, token: '0123456789abcdef'.repeat(4), allowEdits: true }
const tools = [
  { name: 'document_read', description: 'Read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'document_edit', description: 'Edit', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  { name: 'unannotated', description: 'No permission hint', inputSchema: { type: 'object' } },
]
const stopped = () => ({ running: false, sessionId: null, documentId: null, endpoint: null, port: null })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function eventually(check, explanation = 'Expected asynchronous controller work to finish') {
  for (let count = 0; count < 60; count++) {
    if (check()) return
    await Promise.resolve()
  }
  assert.ok(check(), explanation)
}
function harness(overrides = {}) {
  let current = { id: 'doc-a', kind: 'word', title: 'A.docx' }, now = 1000, callback, serial = 0
  const calls = [], changes = [], completed = [], executed = []
  const transport = {
    async start(configuration, document, catalog) {
      calls.push(['start', configuration, document, catalog])
      return { running: true, sessionId: `session-${++serial}`, documentId: document.id, endpoint: 'http://127.0.0.1:38487/mcp', port: 38487 }
    },
    async stop(sessionId) { calls.push(['stop', sessionId]); return stopped() },
    async heartbeat(sessionId) {
      calls.push(['heartbeat', sessionId])
      return { running: true, sessionId, documentId: current?.id, endpoint: 'http://127.0.0.1:38487/mcp', port: 38487 }
    },
    async claim(sessionId, requestId) { calls.push(['claim', sessionId, requestId]); return true },
    async complete(sessionId, requestId, result) { completed.push({ sessionId, requestId, result }) },
    async listen(listener) { callback = listener; calls.push(['listen']); return () => { calls.push(['unlisten']); callback = undefined } },
    ...overrides.transport,
  }
  const controller = createMcpService({
    transport,
    currentDocument: () => current,
    now: () => now,
    changed: state => changes.push(state),
    execute: async (request, assertCurrent) => {
      executed.push(request)
      return overrides.execute ? overrides.execute(request, assertCurrent) : { documentId: request.documentId, value: 'ok' }
    },
  })
  return {
    controller, transport, calls, changes, completed, executed,
    setDocument(document) { current = document },
    advance(milliseconds) { now += milliseconds },
    start(configuration = config) { return controller.start(configuration, current, tools) },
    emit(fields = {}) {
      assert.ok(callback, 'The request listener must be attached first')
      callback({ sessionId: controller.inspect().sessionId, requestId: `request-${++serial}`, documentId: current?.id,
        toolName: 'document_read', arguments: {}, deadlineAt: now + 1000, ...fields })
    },
  }
}

test('MCP reports Running only after native transport startup has completed', async () => {
  const gate = deferred()
  const h = harness({ transport: { start: () => gate.promise } })
  const startup = h.start()
  assert.equal(h.controller.inspect().phase, 'starting')
  await eventually(() => h.calls.some(call => call[0] === 'listen'))
  gate.resolve({ running: true, sessionId: 'ready-session', documentId: 'doc-a', endpoint: 'http://127.0.0.1:38487/mcp', port: 38487 })
  await startup
  assert.deepEqual(h.changes.map(state => state.phase), ['starting', 'running'])
  assert.equal(h.controller.inspect().sessionId, 'ready-session')
  await h.controller.dispose()
})

test('MCP uses one document session and repeated starts do not create another listener', async () => {
  const h = harness()
  await Promise.all([h.start(), h.start()])
  await h.start()
  assert.equal(h.calls.filter(call => call[0] === 'start').length, 1)
  assert.equal(h.calls.filter(call => call[0] === 'listen').length, 1)
  assert.equal(h.controller.inspect().documentId, 'doc-a')
  await h.controller.dispose()
})

test('MCP switching documents during pending startup revokes and closes the returned session', async () => {
  const gate = deferred(), starts = []
  const h = harness({ transport: { start(...args) { starts.push(args); return gate.promise } } })
  const startup = h.start()
  await eventually(() => starts.length === 1)
  h.setDocument({ id: 'doc-b', kind: 'sheet', title: 'B.xlsx' })
  const switching = h.controller.contextChanged()
  assert.equal(h.controller.inspect().phase, 'stopping')
  gate.resolve({ running: true, sessionId: 'stale-session', documentId: 'doc-a', endpoint: 'http://127.0.0.1:38487/mcp', port: 38487 })
  await Promise.all([startup, switching])
  assert.deepEqual(h.controller.inspect(), { phase: 'stopped' })
  assert.ok(h.calls.some(call => call[0] === 'stop' && call[1] === 'stale-session'))
  assert.equal(h.changes.some(state => state.phase === 'running'), false)
  assert.equal(starts.length, 1, 'The next document must not start automatically')
  await h.controller.dispose()
})

test('MCP switching documents before listener registration finishes never starts a server', async () => {
  const gate = deferred()
  const h = harness({ transport: { listen: () => gate.promise } })
  const startup = h.start()
  await Promise.resolve()
  h.setDocument({ id: 'doc-b', kind: 'note', title: 'B.oonote' })
  const switching = h.controller.contextChanged()
  gate.resolve(() => {})
  await Promise.all([startup, switching])
  assert.equal(h.calls.some(call => call[0] === 'start'), false)
  assert.equal(h.controller.inspect().phase, 'stopped')
  await h.controller.dispose()
})

test('MCP entering the workbench or closing the active document stops without restarting', async () => {
  const h = harness()
  await h.start()
  h.setDocument(undefined)
  await h.controller.contextChanged()
  assert.equal(h.controller.inspect().phase, 'stopped')
  assert.equal(h.calls.filter(call => call[0] === 'start').length, 1)
  await h.controller.dispose()
})

test('MCP an unchanged current document keeps its explicitly started session', async () => {
  const h = harness()
  await h.start()
  const running = h.controller.inspect()
  h.setDocument({ id: 'doc-a', kind: 'word', title: 'Renamed.docx' })
  await h.controller.contextChanged()
  assert.deepEqual(h.controller.inspect(), running)
  assert.equal(h.calls.some(call => call[0] === 'stop'), false)
  await h.controller.dispose()
})

test('MCP native startup failure clears any partial listener and never displays Running', async () => {
  const h = harness({ transport: { start: async () => { throw Error('端口已被占用') } } })
  await assert.rejects(h.start(), /端口已被占用/)
  assert.equal(h.controller.inspect().phase, 'error')
  assert.match(h.controller.inspect().error, /端口已被占用/)
  assert.equal(h.changes.some(state => state.phase === 'running'), false)
  assert.ok(h.calls.some(call => call[0] === 'stop'))
  await h.controller.dispose()
})

test('MCP incomplete startup acknowledgements are rejected and stopped', async () => {
  for (const response of [stopped(), { running: true, sessionId: null },
    { running: true, sessionId: 'wrong-document', documentId: 'doc-b', endpoint: 'http://127.0.0.1:38487/mcp' },
    { running: true, sessionId: 'no-endpoint', documentId: 'doc-a', endpoint: null }]) {
    const h = harness({ transport: { start: async () => response } })
    await assert.rejects(h.start(), /未成功启动/)
    assert.equal(h.controller.inspect().phase, 'error')
    assert.ok(h.calls.some(call => call[0] === 'stop'))
    await h.controller.dispose()
  }
})

test('MCP read-only configuration filters the advertised catalog and rejects write calls', async () => {
  const h = harness()
  await h.start({ ...config, allowEdits: false })
  assert.deepEqual(h.calls.find(call => call[0] === 'start')[3].map(tool => tool.name), ['document_read'])
  h.emit({ toolName: 'document_edit' })
  h.emit({ toolName: 'unannotated' })
  await eventually(() => h.completed.length === 2)
  assert.equal(h.executed.length, 0)
  assert.equal(h.calls.some(call => call[0] === 'claim'), false)
  for (const { result } of h.completed) {
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /不允许/)
  }
  await h.controller.dispose()
})

test('MCP claimed reads serialize the actual execution result into tool content', async () => {
  const h = harness()
  await h.start()
  h.emit({ requestId: 'read-1' })
  await eventually(() => h.completed.length === 1)
  assert.deepEqual(h.completed[0].result, { content: [{ type: 'text', text: '{"documentId":"doc-a","value":"ok"}' }] })
  assert.ok(h.calls.some(call => call[0] === 'claim' && call[2] === 'read-1'))
  assert.equal(h.executed.length, 1)
  await h.controller.dispose()
})

test('MCP duplicate, wrong-session and stopped events never execute a tool twice', async () => {
  const h = harness()
  await h.start()
  const sessionId = h.controller.inspect().sessionId
  h.emit({ requestId: 'same' })
  h.emit({ requestId: 'same' })
  h.emit({ requestId: 'foreign', sessionId: 'another-session' })
  await eventually(() => h.completed.length === 1)
  await h.controller.stop()
  h.emit({ requestId: 'after-stop', sessionId })
  for (let count = 0; count < 5; count++) await Promise.resolve()
  assert.equal(h.executed.length, 1)
  assert.equal(h.completed.length, 1)
  await h.controller.dispose()
})

test('MCP failed native claim prevents a replayed or cancelled request from executing', async () => {
  const h = harness({ transport: { claim: async () => false } })
  await h.start()
  h.emit()
  for (let count = 0; count < 15; count++) await Promise.resolve()
  assert.equal(h.executed.length, 0)
  assert.equal(h.completed.length, 0, 'Native cancellation already owns completion')
  await h.controller.dispose()
})

test('MCP expired requests are refused both before and after an asynchronous native claim', async () => {
  const gate = deferred()
  let claims = 0
  const h = harness({ transport: { claim() { claims++; return gate.promise } } })
  await h.start()
  h.emit({ requestId: 'already-expired', deadlineAt: 1000 })
  await eventually(() => h.completed.length === 1)
  assert.equal(claims, 0)
  h.emit({ requestId: 'expired-in-claim', deadlineAt: 1001 })
  await eventually(() => claims === 1)
  h.advance(1)
  gate.resolve(true)
  await eventually(() => h.completed.length === 2)
  assert.equal(h.executed.length, 0)
  assert.ok(h.completed.every(({ result }) => result.isError))
  await h.controller.dispose()
})

test('MCP foreign document identifiers and unobserved current-document changes are refused', async () => {
  const h = harness()
  await h.start()
  h.emit({ requestId: 'wrong-target', documentId: 'doc-b' })
  await eventually(() => h.completed.length === 1)
  h.setDocument({ id: 'doc-b', kind: 'sheet', title: 'B.xlsx' })
  h.emit({ requestId: 'stale-target', documentId: 'doc-a' })
  await eventually(() => h.completed.length === 2)
  assert.equal(h.executed.length, 0)
  assert.equal(h.calls.some(call => call[0] === 'claim'), false)
  assert.ok(h.completed.every(({ result }) => result.isError))
  await h.controller.dispose()
})

test('MCP queued calls are revoked immediately when the current document changes', async () => {
  const gate = deferred(), mutations = []
  const h = harness({ execute: async (request, assertCurrent) => {
    await gate.promise
    assertCurrent()
    mutations.push(request.requestId)
    return { edited: true }
  } })
  await h.start()
  h.emit({ requestId: 'in-flight', toolName: 'document_edit' })
  h.emit({ requestId: 'queued', toolName: 'document_edit' })
  await eventually(() => h.executed.length === 1)
  h.setDocument({ id: 'doc-b', kind: 'presentation', title: 'B.pptx' })
  const switching = h.controller.contextChanged()
  gate.resolve()
  await switching
  for (let count = 0; count < 15; count++) await Promise.resolve()
  assert.deepEqual(mutations, [])
  assert.equal(h.executed.length, 1, 'The queued call must never reach its editor')
  assert.equal(h.completed.length, 0, 'Stopped native sessions own cancellation')
  assert.equal(h.controller.inspect().phase, 'stopped')
  await h.controller.dispose()
})

test('MCP calls execute in order and an editor failure does not poison later calls', async () => {
  const first = deferred(), order = []
  const h = harness({ execute: async request => {
    order.push(request.requestId)
    if (request.requestId === 'first') { await first.promise; throw Error('编辑器拒绝操作') }
    return { ok: true }
  } })
  await h.start()
  h.emit({ requestId: 'first' })
  h.emit({ requestId: 'second' })
  await eventually(() => h.executed.length === 1)
  assert.deepEqual(order, ['first'])
  first.resolve()
  await eventually(() => h.completed.length === 2)
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(h.completed[0].result.isError, true)
  assert.match(h.completed[0].result.content[0].text, /编辑器拒绝操作/)
  assert.equal(h.completed[1].result.isError, undefined)
  await h.controller.dispose()
})

test('MCP a failed completion IPC does not block the next queued request', async () => {
  const completed = []
  const h = harness({ transport: { async complete(_sessionId, requestId) { completed.push(requestId); if (requestId === 'first') throw Error('Window unavailable') } } })
  await h.start()
  h.emit({ requestId: 'first' })
  h.emit({ requestId: 'second' })
  await eventually(() => completed.length === 2)
  assert.deepEqual(completed, ['first', 'second'])
  assert.equal(h.executed.length, 2)
  await h.controller.dispose()
})

test('MCP native lease expiry clears Running and invalidates its old request stream', async () => {
  const h = harness({ transport: { heartbeat: async () => stopped() } })
  await h.start()
  const sessionId = h.controller.inspect().sessionId
  await h.controller.heartbeat()
  assert.deepEqual(h.controller.inspect(), { phase: 'stopped' })
  h.emit({ sessionId })
  for (let count = 0; count < 5; count++) await Promise.resolve()
  assert.equal(h.executed.length, 0)
  await h.controller.dispose()
})

test('MCP heartbeat calls do not overlap and stale responses cannot stop a newer session', async () => {
  const gate = deferred()
  let heartbeats = 0
  const h = harness({ transport: { heartbeat() { heartbeats++; return gate.promise } } })
  await h.start()
  const originalSessionId = h.controller.inspect().sessionId
  const firstHeartbeat = h.controller.heartbeat()
  await h.controller.heartbeat()
  assert.equal(heartbeats, 1)
  await h.controller.stop()
  await h.start()
  assert.notEqual(h.controller.inspect().sessionId, originalSessionId)
  gate.resolve(stopped())
  await firstHeartbeat
  assert.equal(h.controller.inspect().phase, 'running')
  await h.controller.dispose()
})

test('MCP heartbeat failures stop the service and expose a disconnected state', async () => {
  const h = harness({ transport: { heartbeat: async () => { throw Error('IPC unavailable') } } })
  await h.start()
  await h.controller.heartbeat()
  assert.equal(h.controller.inspect().phase, 'error')
  assert.match(h.controller.inspect().error, /连接已中断.*IPC unavailable/)
  assert.ok(h.calls.some(call => call[0] === 'stop'))
  await h.controller.dispose()
})

test('MCP stop failures remain visible and require successful cleanup before restart', async () => {
  const h = harness()
  await h.start()
  h.transport.stop = async () => { throw Error('无法关闭服务') }
  await assert.rejects(h.controller.stop(), /无法关闭服务/)
  assert.equal(h.controller.inspect().phase, 'error')
  await assert.rejects(h.start(), /无法关闭服务/)
  assert.equal(h.calls.filter(call => call[0] === 'start').length, 1)
  h.transport.stop = async () => stopped()
  await h.start()
  assert.equal(h.controller.inspect().phase, 'running')
  await h.controller.dispose()
})

test('MCP dispose stops the service, detaches events and forbids a new start', async () => {
  const h = harness()
  await h.start()
  await h.controller.dispose()
  await h.start()
  await h.controller.heartbeat()
  assert.equal(h.controller.inspect().phase, 'stopped')
  assert.equal(h.calls.filter(call => call[0] === 'start').length, 1)
  assert.equal(h.calls.filter(call => call[0] === 'unlisten').length, 1)
  assert.equal(h.calls.filter(call => call[0] === 'heartbeat').length, 0)
})

test('MCP dispose detaches a listener that finishes registering after disposal', async () => {
  const registration = deferred()
  let detached = 0
  const h = harness({ transport: { listen: () => registration.promise } })
  const startup = h.start()
  await Promise.resolve()
  const disposal = h.controller.dispose()
  registration.resolve(() => { detached++ })
  await Promise.all([startup, disposal])
  assert.equal(detached, 1)
  assert.equal(h.calls.some(call => call[0] === 'start'), false)
  assert.equal(h.controller.inspect().phase, 'stopped')
})
