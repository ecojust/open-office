import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../public/office/host.js', import.meta.url), 'utf8')
function host() {
  const handlers = new Map(), files = new Map(), writes = [], posts = [], workerPosts = [], events = []
  const origin = 'http://127.0.0.1:5198', parent = {}, port = { postMessage(value) { workerPosts.push(value) }, close() { events.push('close-port') } }
  const window = { addEventListener(type, fn) { const set = handlers.get(type) || []; set.push(fn); handlers.set(type, set) }, dispatchEvent() {},
    PThread: { terminateAllThreads() { events.push('terminate-workers') } } }
  parent.postMessage = (message, target, transfer = []) => { assert.equal(target, origin); posts.push(structuredClone(message, { transfer })) }
  const FS = {
    writeFile(path, bytes, options) { writes.push({ path, bytes, options }); files.set(path, bytes) },
    readFile(path) { return new Uint8Array(files.get(path)) },
    unlink(path) { assert.ok(files.has(path)); files.delete(path) },
  }
  const context = vm.createContext({ window, parent, FS, ArrayBuffer, Uint8Array, SharedArrayBuffer, URL, URLSearchParams, console, atob, btoa,
    location: { origin, href: `${origin}/office/host.html#session=memory`, hash: '#session=memory', search: '' },
    document: { getElementById: () => ({ addEventListener() {} }) },
    navigator: { permissions: {} }, installOfficeClipboardPermissionCompatibility: () => () => {},
    OpenOfficeOfflinePolicy: { installLocalTransport() {} }, setTimeout() {}, clearTimeout() {}, Event: class {},
  })
  vm.runInContext(source.replace('start().catch(fail);', 'globalThis.memoryHost = { setPort(value) { port = value }, workerMessage, inputBytes, toBase64 };'), context)
  context.memoryHost.setPort(port)
  const request = (action, data, id = 'document') => {
    const requestId = `req-${workerPosts.length}`
    for (const handler of handlers.get('message')) handler({ source: parent, origin, data: { channel: 'open-office-engine', session: 'memory', requestId, action, documentId: id, data } })
    return requestId
  }
  const reply = (requestId, data, ok = true) => context.memoryHost.workerMessage({ data: { requestId, data, ok } })
  return { request, reply, context, port, files, writes, posts, workerPosts, events, handlers }
}

test('transferred document and image bytes move into MEMFS without a second input copy', () => {
  const h = host(), buffer = new Uint8Array([80, 75, 3, 4]).buffer
  const id = h.request('open', { id: 'document', kind: 'word', extension: 'docx', buffer })
  assert.equal(h.writes[0].bytes.buffer, buffer)
  assert.equal(h.writes[0].options.canOwn, true)
  assert.equal('buffer' in h.workerPosts[0].data, false, 'The retained RPC stores only path metadata')
  h.reply(id, { closedPath: null })
  const image = new Uint8Array([1, 2, 3]).buffer
  const imageId = h.request('insert-image', { name: 'image.png', buffer: image })
  assert.equal(h.writes[1].bytes.buffer, image)
  assert.equal(h.writes[1].options.canOwn, true)
  h.reply(imageId, { dirty: true })
  assert.equal(h.files.has(h.writes[1].path), false)
})

test('binary exports transfer owned output and unlink it while preserving dirty/revision metadata', () => {
  const h = host()
  const open = h.request('open', { id: 'document', kind: 'word', extension: 'docx', base64: '' })
  h.reply(open, {})
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256), path = '/tmp/export.docx'
  h.files.set(path, bytes)
  const id = h.request('export', { format: 'docx', binary: true })
  h.reply(id, { path, name: 'test.docx', extension: 'docx', revision: 13, dirty: true })
  const result = h.posts.at(-1).data
  assert.equal(result.base64, undefined)
  assert.deepEqual(new Uint8Array(result.buffer), bytes)
  assert.equal(result.revision, 13); assert.equal(result.dirty, true)
  assert.equal(h.files.has(path), false)
})

test('legacy base64 protocol still exports identical bytes and pagehide stops all engine workers', () => {
  const h = host(), bytes = Uint8Array.from({ length: 50003 }, (_, i) => i % 256)
  assert.equal(h.context.memoryHost.toBase64(bytes), Buffer.from(bytes).toString('base64'))
  assert.deepEqual(Array.from(h.context.memoryHost.inputBytes({ base64: 'AQID' })), [1, 2, 3])
  for (const fn of h.handlers.get('pagehide')) fn()
  assert.deepEqual(h.events, ['close-port', 'terminate-workers'])
  const count = h.posts.length
  h.request('open', { id: 'late', kind: 'word', extension: 'docx', base64: 'AQID' })
  assert.equal(h.posts.length, count)
  assert.equal(h.writes.length, 0)
})
