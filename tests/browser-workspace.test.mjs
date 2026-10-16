import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  WORKSPACE_LIMITS, WorkspaceTransportError, createWorkspaceTransport,
  browserWorkspaceDispatcher, isSharedWorkspaceLocation,
} from '../src/shared/browser-workspace.ts'

const token = 'a1'.repeat(32)
const location = new URL(`http://127.0.0.1:8750/${token}/?workspace=shared`)
const encode = text => Buffer.from(text).toString('base64')
const initialBytes = encode('%PDF-1.7\ninitial document')
const kind = { docx: 'word', xlsx: 'sheet', pptx: 'presentation', pdf: 'pdf' }

function publish(overrides = {}) {
  return {
    id: 'document-1', expectedVersion: 0, clientId: 'client-1',
    name: '季度报告.pdf', extension: 'pdf', base64: initialBytes,
    ...overrides,
  }
}

function metadata(request = publish(), version = 1) {
  const bytes = Buffer.from(request.base64, 'base64')
  return {
    id: request.id, name: request.name, extension: request.extension, kind: kind[request.extension],
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
    version, updatedBy: request.clientId,
  }
}

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
})
const fixed = (body, statusCode = 200) => createWorkspaceTransport(async () => ({ statusCode, body }))
const fails = (code, statusCode) => error => {
  assert.ok(error instanceof WorkspaceTransportError)
  assert.equal(error.code, code)
  if (statusCode !== undefined) assert.equal(error.statusCode, statusCode)
  return true
}

test('two real HTTP clients receive CAS conflicts without replacing the accepted snapshot', async t => {
  const documents = new Map()
  let revision = 0
  const server = createServer(async (request, response) => {
    const path = request.url?.slice(`/${token}/`.length)
    let status = 200
    let result
    if (request.method === 'GET' && path === '_sync/state') {
      result = { running: true, revision, documents: [...documents.values()].map(({ base64, ...summary }) => summary) }
    } else if (request.method === 'GET' && path?.startsWith('_sync/documents/')) {
      result = documents.get(path.slice('_sync/documents/'.length))
      if (!result) { status = 404; result = { error: 'private backend details' } }
    } else if (request.method === 'POST' && path === '_sync/documents') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const previous = documents.get(input.id)
      const candidate = metadata(input, (previous?.version ?? 0) + 1)
      if (previous && previous.sha256 === candidate.sha256 && previous.name === input.name) {
        const { base64, ...document } = previous
        result = { status: 'accepted', document }
      } else if (previous && previous.version !== input.expectedVersion) {
        status = 409
        const { base64, ...document } = previous
        result = { status: 'conflict', document }
      } else {
        revision++
        documents.set(input.id, { ...candidate, base64: input.base64 })
        result = { status: 'accepted', document: candidate }
      }
    } else { status = 404; result = { error: 'no route' } }
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const address = new URL(`http://127.0.0.1:${server.address().port}/${token}/?workspace=shared`)
  const desktop = createWorkspaceTransport(browserWorkspaceDispatcher(address))
  const browser = createWorkspaceTransport(browserWorkspaceDispatcher(address))
  assert.deepEqual(await desktop.state(), { running: true, revision: 0, documents: [] })
  const first = await desktop.publish(publish())
  assert.equal(first.status, 'accepted')
  assert.equal(first.document.version, 1)
  const browserOpened = await browser.document(first.document.id)
  assert.equal(browserOpened.base64, initialBytes)

  const newer = publish({ expectedVersion: 1, base64: encode('%PDF-1.7\ndesktop revision') })
  assert.equal((await desktop.publish(newer)).document.version, 2)
  const staleDraft = Object.freeze(publish({ expectedVersion: browserOpened.version,
    clientId: 'browser-2', base64: encode('%PDF-1.7\nbrowser unsaved changes') }))
  const conflict = await browser.publish(staleDraft)
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.document.version, 2)
  assert.equal(conflict.document.updatedBy, 'client-1')
  assert.equal((await browser.document(first.document.id)).base64, newer.base64)
  assert.equal(staleDraft.base64, encode('%PDF-1.7\nbrowser unsaved changes'))
  assert.equal((await browser.state()).revision, 2)
  // A lost response can be retried without a new edit or revision.
  const retry = await desktop.publish(newer)
  assert.equal(retry.status, 'accepted')
  assert.equal(retry.document.version, 2)
  assert.equal((await desktop.state()).revision, 2)
  await assert.rejects(browser.document('absent'), fails('not-found', 404))
})

test('native dispatch uses the same statusCode protocol and snapshots are returned as independent values', async () => {
  const data = metadata()
  const calls = []
  const transport = createWorkspaceTransport(async (method, path, body) => {
    calls.push({ method, path, body })
    return { statusCode: 200, body: { running: true, revision: 1, documents: [data] } }
  })
  const result = await transport.state()
  assert.deepEqual(calls, [{ method: 'GET', path: '_sync/state', body: undefined }])
  result.documents[0].name = 'local edit.pdf'
  assert.equal(data.name, '季度报告.pdf')
})

test('only token-scoped shared URLs enable browser mode', () => {
  assert.equal(isSharedWorkspaceLocation(location), true)
  assert.equal(isSharedWorkspaceLocation(new URL(`https://example.test/${token}/index.html?workspace=shared`)), true)
  for (const value of [
    'file:///tmp/index.html?workspace=shared', 'http://example.test/?workspace=shared',
    `http://example.test/${token}/`, `http://example.test/${token}/?workspace=shared&workspace=shared`,
    `http://name:password@example.test/${token}/?workspace=shared`,
    `http://example.test/${token}/nested/?workspace=shared`,
    'http://example.test/not-a-token/?workspace=shared',
  ]) {
    assert.equal(isSharedWorkspaceLocation(new URL(value)), false, value)
    assert.throws(() => browserWorkspaceDispatcher(new URL(value)), fails('invalid-request'))
  }
  assert.equal(isSharedWorkspaceLocation(), false)
})

test('fetch captures the original token directory and uses no credentials or redirects', async () => {
  const input = new URL(location.href)
  input.pathname += 'index.html'
  input.hash = '#document'
  input.searchParams.set('untrusted', 'https://elsewhere.test/')
  const calls = []
  const dispatch = browserWorkspaceDispatcher(input, {
    fetch: async (url, init) => {
      calls.push({ url, init })
      const request = JSON.parse(init.body)
      return jsonResponse({ status: 'accepted', document: metadata(request) })
    },
  })
  input.hostname = 'elsewhere.test'
  input.pathname = '/overridden/'
  const result = await createWorkspaceTransport(dispatch).publish(publish({ name: '报告.v2.pdf' }))
  assert.equal(result.status, 'accepted')
  assert.equal(calls[0].url, `http://127.0.0.1:8750/${token}/_sync/documents`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.mode, 'same-origin')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(JSON.parse(calls[0].init.body).name, '报告.v2.pdf')
})

test('arbitrary paths, IDs and file names cannot retarget the fixed fetch endpoint', async () => {
  let calls = 0
  const dispatch = browserWorkspaceDispatcher(location, { fetch: async () => { calls++; throw new Error('unexpected fetch') } })
  const transport = createWorkspaceTransport(dispatch)
  for (const path of ['../_sync/state', '/_sync/state', '//elsewhere.test', 'https://elsewhere.test/',
    '_sync/documents/../state', '_sync/documents/a?other=1', '_sync/documents/a%2fb', '_sync/documents/a\n']) {
    await assert.rejects(dispatch('GET', path), fails('invalid-request'))
  }
  for (const id of ['', '../state', 'a/b', 'a%2fb', 'a?b', 'x'.repeat(129), '中文', 'valid\n', 'valid\r\n']) {
    await assert.rejects(transport.document(id), fails('invalid-request'))
  }
  for (const name of ['../outside.pdf', 'a/b.pdf', 'a\\b.pdf', 'a:stream.pdf',
    'a\u0000.pdf', 'a\u007f.pdf', 'a\u0085.pdf', '.hidden.pdf', 'trailing.pdf ',
    ' leading.pdf', 'CON.pdf', 'nul.part.pdf', 'COM1.pdf', 'LPT9.pdf', 'a.docx',
    'a.pdf.exe', 'a\ud800.pdf', `${'字'.repeat(79)}.docx`]) {
    await assert.rejects(transport.publish(publish({ name })), fails('invalid-request'), name)
  }
  await assert.rejects(dispatch('GET', '_sync/state', publish()), fails('invalid-request'))
  await assert.rejects(dispatch('DELETE', '_sync/documents'), fails('invalid-request'))
  assert.equal(calls, 0)
})

test('state rejects invalid fields, unsafe revisions, duplicate IDs and cumulative limits', async () => {
  const valid = { running: true, revision: 1, documents: [metadata()] }
  assert.deepEqual(await fixed(valid).state(), valid)
  for (const data of [null, [], {}, { ...valid, running: 'true' }, { ...valid, revision: -1 },
    { ...valid, revision: 0 }, { ...valid, revision: 0.5 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, documents: {} },
    { ...valid, unexpected: true }, { ...valid, documents: [metadata(), metadata()] },
    { ...valid, documents: Array.from({ length: 65 }, (_, i) => ({ ...metadata(), id: `id-${i}` })) },
    { ...valid, documents: [
      { ...metadata(), id: 'a', sizeBytes: WORKSPACE_LIMITS.documentBytes },
      { ...metadata(), id: 'b', sizeBytes: WORKSPACE_LIMITS.documentBytes },
    ] },
  ]) await assert.rejects(fixed(data).state(), fails('invalid-response'))
})

test('summary validation enforces editable formats, matching kinds, names, hashes and byte bounds', async () => {
  const data = metadata()
  for (const patch of [
    { id: '../x' }, { name: 'a.docx' }, { name: 'a.pdf\n' }, { name: `${'字'.repeat(79)}.pdf` },
    { extension: 'potx' }, { extension: 'csv' }, { extension: 'DOCX' }, { kind: 'word' },
    { sha256: 'a'.repeat(63) }, { sha256: 'A'.repeat(64) }, { sha256: 'g'.repeat(64) }, { sha256: 'a'.repeat(64) + '\n' },
    { sizeBytes: 0 }, { sizeBytes: 1.5 }, { sizeBytes: WORKSPACE_LIMITS.documentBytes + 1 },
    { version: 0 }, { version: -1 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { updatedBy: '' }, { updatedBy: 'x'.repeat(129) }, { unexpected: true },
  ]) {
    await assert.rejects(fixed({ running: true, revision: 1, documents: [{ ...data, ...patch }] }).state(), fails('invalid-response'))
  }
  for (const format of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const candidate = metadata(publish({ extension: format, name: `报告.${format.toUpperCase()}` }))
    assert.equal((await fixed({ running: true, revision: 1, documents: [candidate] }).state()).documents[0].kind, kind[format])
  }
})

test('full documents must match the requested ID and strict base64 decoded size', async () => {
  const valid = { ...metadata(), base64: initialBytes }
  assert.deepEqual(await fixed(valid).document('document-1'), valid)
  for (const patch of [
    { id: 'different' }, { sizeBytes: 1 }, { base64: '' }, { base64: initialBytes + '\n' },
    { base64: initialBytes.slice(0, -1) }, { base64: 'Zg=' }, { base64: 'Zh==' },
    { base64: 'Zm9=' }, { base64: '====' }, { base64: '-_==' }, { base64: null },
    { base64: 'AA=A' }, { extra: 'field' },
  ]) await assert.rejects(fixed({ ...valid, ...patch }).document('document-1'), fails('invalid-response'))
  // Valid padding for 1, 2 and 3 decoded bytes.
  for (const text of ['f', 'fo', 'foo']) {
    const request = publish({ base64: encode(text) })
    assert.equal((await fixed({ ...metadata(request), base64: request.base64 }).document(request.id)).sizeBytes, text.length)
  }
})

test('invalid outgoing requests fail before IPC/fetch and do not mutate the draft', async () => {
  let calls = 0
  const transport = createWorkspaceTransport(async () => { calls++; throw new Error('must not dispatch') })
  const draft = Object.freeze(publish())
  for (const patch of [
    { expectedVersion: -1 }, { expectedVersion: 0.5 }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { clientId: '../client' }, { extension: 'csv' }, { id: '' }, { base64: 'Zh==' },
    { base64: 'Zg' }, { base64: 'Z g==' }, { base64: 'AAA\n' }, { base64: '' }, { extra: true },
  ]) await assert.rejects(transport.publish({ ...draft, ...patch }), fails('invalid-request'))
  const tooLarge = 'A'.repeat(Math.ceil((WORKSPACE_LIMITS.documentBytes + 1) / 3) * 4)
  await assert.rejects(transport.publish({ ...draft, base64: tooLarge }), fails('invalid-request'))
  assert.equal(calls, 0)
  assert.equal(draft.base64, initialBytes)
})

test('CAS responses require matching HTTP status, document identity and accepted metadata', async () => {
  const accepted = { status: 'accepted', document: metadata() }
  const conflict = { status: 'conflict', document: { ...metadata(), version: 2 } }
  assert.deepEqual(await fixed(accepted).publish(publish()), accepted)
  assert.deepEqual(await fixed(conflict, 409).publish(publish()), conflict)
  for (const [status, body] of [
    [409, accepted], [200, conflict], [200, { ...accepted, extra: 1 }],
    [200, { status: 'accepted' }], [409, { error: 'missing snapshot' }],
    [200, { ...accepted, document: { ...metadata(), id: 'other-document' } }],
    [409, { ...conflict, document: { ...metadata(), id: 'other-document' } }],
    [200, { ...accepted, document: { ...metadata(), name: 'wrong.pdf' } }],
    [200, { ...accepted, document: { ...metadata(), sizeBytes: 10 } }],
  ]) await assert.rejects(fixed(body, status).publish(publish()), fails('invalid-response'))
  // An idempotent retry can be accepted with the original updater/version.
  assert.equal((await fixed(accepted).publish(publish({ clientId: 'retrying-client', expectedVersion: 1 }))).document.updatedBy, 'client-1')
})

test('HTTP errors and rejected dispatches never expose bodies, URLs or private local paths', async () => {
  const privateText = 'SECRET /Users/person/private.docx document base64'
  for (const [status, code] of [[401, 'forbidden'], [403, 'forbidden'], [404, 'not-found'],
    [410, 'not-found'], [413, 'too-large'], [408, 'timeout'], [504, 'timeout'],
    [429, 'unavailable'], [503, 'unavailable'], [507, 'http'], [500, 'http']]) {
    await assert.rejects(fixed({ error: privateText }, status).state(), error => {
      fails(code, status)(error)
      assert.equal(String(error).includes(privateText), false)
      assert.equal('cause' in error, false)
      return true
    })
  }
  await assert.rejects(createWorkspaceTransport(async () => { throw new Error(privateText) }).state(), fails('network'))
  for (const result of [null, { status: 200, body: {} }, { statusCode: 99 }, { statusCode: 600 }, { statusCode: 200.5 }]) {
    await assert.rejects(createWorkspaceTransport(async () => result).state(), fails('invalid-response'))
  }
})

test('fetch timeout aborts both stalled headers and a stalled response body', async () => {
  let signal
  const stalledHeaders = browserWorkspaceDispatcher(location, {
    timeoutMs: 10,
    fetch: (_url, options) => { signal = options.signal; return new Promise(() => {}) },
  })
  await assert.rejects(stalledHeaders('GET', '_sync/state'), fails('timeout'))
  assert.equal(signal.aborted, true)

  let cancelled = false
  const stalledBody = browserWorkspaceDispatcher(location, {
    timeoutMs: 10,
    fetch: async (_url, options) => {
      signal = options.signal
      return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  await assert.rejects(stalledBody('GET', '_sync/state'), fails('timeout'))
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, true)
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 120001]) {
    assert.throws(() => browserWorkspaceDispatcher(location, { timeoutMs }), fails('invalid-request'))
  }
})

test('fetch validates JSON media type, encoding and streamed bounds before protocol parsing', async () => {
  const invalidResponses = [
    () => new Response('<html>not json</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{ broken json', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    () => jsonResponse({}, 200, { 'Content-Length': '999999999' }),
    () => jsonResponse({}, 200, { 'Content-Length': '-1' }),
    () => jsonResponse({}, 200, { 'Content-Length': 'NaN' }),
    () => new Response(' '.repeat(128 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
  ]
  for (const makeResponse of invalidResponses) {
    const dispatch = browserWorkspaceDispatcher(location, { fetch: async () => makeResponse() })
    await assert.rejects(dispatch('GET', '_sync/state'), fails('invalid-response'))
  }
  const chunks = ['{"running":true,', '"revision":0,"documents":[]}']
  const dispatch = browserWorkspaceDispatcher(location, {
    fetch: async () => new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    } }), { headers: { 'Content-Type': 'application/json' } }),
  })
  assert.deepEqual(await createWorkspaceTransport(dispatch).state(), { running: true, revision: 0, documents: [] })
})

test('redirects and network exceptions are rejected without forwarding secrets', async () => {
  for (const patch of [{ redirected: true }, { url: 'http://elsewhere.test/_sync/state' }]) {
    const response = jsonResponse({ running: true, revision: 0, documents: [] })
    for (const [key, value] of Object.entries(patch)) Object.defineProperty(response, key, { value })
    const dispatch = browserWorkspaceDispatcher(location, { fetch: async () => response })
    await assert.rejects(dispatch('GET', '_sync/state'), fails('invalid-response'))
  }
  const dispatch = browserWorkspaceDispatcher(location, { fetch: async () => { throw new Error('SECRET capability URL') } })
  await assert.rejects(dispatch('GET', '_sync/state'), error => {
    fails('network')(error)
    assert.equal(error.message.includes('SECRET'), false)
    return true
  })
})

test('non-success HTTP responses are cancelled without reading private error bodies', async () => {
  let cancelled = false
  const dispatch = browserWorkspaceDispatcher(location, {
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 }),
  })
  await assert.rejects(createWorkspaceTransport(dispatch).state(), fails('unavailable', 503))
  assert.equal(cancelled, true)
})
