import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWorkspaceSync } from '../src/shared/workspace-sync.ts'

const encoded = text => Buffer.from(text).toString('base64')
const decoded = document => Buffer.from(document.base64, 'base64').toString()
const settle = () => new Promise(resolve => setImmediate(resolve))
const clone = value => structuredClone(value)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function document(id, version, body, name = '合同.docx') {
  return { id, version, name, kind: 'word', extension: 'docx', base64: encoded(body),
    sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: Buffer.byteLength(body), updatedBy: 'other-client' }
}

function summary(document) {
  const { base64: _base64, ...value } = document
  return value
}

// This model tracks content revisions independently of network acknowledgements.
// Neither bind() nor a server response is allowed to replace local editor data.
function workspace({ remote = [], local = [], available = true } = {}) {
  const server = new Map(remote.map(item => [item.id, clone(item)]))
  const editors = new Map(local.map(item => [item.key, {
    name: '合同.docx', extension: 'docx', kind: 'word', body: '本地正文', revision: `${item.key}:1`, editCount: 1, ...clone(item),
  }]))
  const calls = { states: 0, reads: [], publishes: [], bindings: [], adoptions: [], forks: [], messages: [], stateUpdates: [] }
  let nextId = 0
  const env = { available }
  function change(key, body) {
    const editor = editors.get(key)
    editor.body = body
    editor.revision = `${key}:${++editor.editCount}`
  }
  function accept(request) {
    const existing = server.get(request.id)
    if ((existing?.version ?? 0) !== request.expectedVersion) {
      return { status: 'conflict', document: summary(existing) }
    }
    const result = document(request.id, (existing?.version ?? 0) + 1, decoded(request), request.name)
    result.updatedBy = request.clientId
    server.set(result.id, result)
    return { status: 'accepted', document: summary(result) }
  }
  const implementation = {
    async state() { return { running: true, documents: [...server.values()].map(summary), revision: calls.states } },
    async document(id) { return clone(server.get(id)) },
    async publish(request) { return accept(request) },
  }
  const transport = {
    async state() { calls.states++; return implementation.state() },
    async document(id) { calls.reads.push(id); return implementation.document(id) },
    async publish(request) { calls.publishes.push(clone(request)); return implementation.publish(request) },
  }
  const hooks = {
    locals: () => [...editors.values()].map(editor => ({ key: editor.key, binding: clone(editor.binding) })),
    available: () => env.available,
    async revision(key) { return editors.get(key)?.revision },
    async snapshot(key) {
      const editor = editors.get(key)
      return { name: editor.name, extension: editor.extension, base64: encoded(editor.body), revision: editor.revision }
    },
    bind(key, binding) { calls.bindings.push([key, clone(binding)]); editors.get(key).binding = clone(binding) },
    async adopt(key, remote, expectedRevision, canCommit) {
      calls.adoptions.push([key, clone(remote), expectedRevision])
      const editor = editors.get(key)
      if (!canCommit() || !editor || editor.revision !== expectedRevision) return false
      change(key, decoded(remote))
      editor.name = remote.name
      editor.binding = { id: remote.id, version: remote.version, revision: editor.revision }
      return true
    },
    fork(key, name) { calls.forks.push([key, name]); editors.get(key).name = name },
    notify(message) { calls.messages.push(message) },
    state(value) { calls.stateUpdates.push(clone(value)) },
  }
  const sync = createWorkspaceSync(transport, hooks, 'this-client', () => `new-${++nextId}`)
  return { sync, server, editors, env, calls, change, accept, implementation, hooks }
}

test('new documents publish once and bind only the captured local revision', async () => {
  const fixture = workspace({ local: [{ key: 'a', body: '新建中文文档' }] })
  await fixture.sync.tick()
  assert.equal(fixture.calls.publishes.length, 1)
  assert.deepEqual(fixture.calls.publishes[0], { id: 'new-1', expectedVersion: 0, clientId: 'this-client_1', name: '合同.docx', extension: 'docx', base64: encoded('新建中文文档') })
  assert.deepEqual(fixture.editors.get('a').binding, { id: 'new-1', version: 1, revision: 'a:1' })
  assert.equal(decoded(fixture.server.get('new-1')), '新建中文文档')
  await fixture.sync.tick()
  assert.equal(fixture.calls.publishes.length, 1, 'an acknowledged unchanged revision is not uploaded again')
})

test('a clean local document adopts a newer remote model and its new baseline', async () => {
  const fixture = workspace({ remote: [document('shared', 2, '远端的新正文')],
    local: [{ key: 'a', body: '旧正文', binding: { id: 'shared', version: 1, revision: 'a:1' } }] })
  await fixture.sync.tick()
  const editor = fixture.editors.get('a')
  assert.equal(editor.body, '远端的新正文')
  assert.deepEqual(editor.binding, { id: 'shared', version: 2, revision: 'a:2' })
  assert.deepEqual(fixture.calls.reads, ['shared'])
  assert.equal(fixture.calls.publishes.length, 0)
  await fixture.sync.tick()
  assert.equal(fixture.calls.publishes.length, 0)
  assert.equal(fixture.calls.adoptions.length, 1)
})

test('concurrent local and remote edits preserve local content as a separate conflict document', async () => {
  const original = document('shared', 2, '另一端的修改')
  const fixture = workspace({ remote: [original],
    local: [{ key: 'a', body: '尚未发送的本地修改', binding: { id: 'shared', version: 1, revision: 'old-revision' } }] })
  await fixture.sync.tick()
  assert.deepEqual(fixture.server.get('shared'), original)
  assert.equal(decoded(fixture.server.get('new-1')), '尚未发送的本地修改')
  assert.equal(fixture.server.get('new-1').name, '合同 - 冲突副本.docx')
  assert.equal(fixture.editors.get('a').body, '尚未发送的本地修改')
  assert.equal(fixture.editors.get('a').name, '合同 - 冲突副本.docx')
  assert.deepEqual(fixture.editors.get('a').binding, { id: 'new-1', version: 1, revision: 'a:1' })
  assert.equal(fixture.calls.messages.length, 1)
  assert.equal(fixture.calls.adoptions.length, 0)
})

test('a server update between listing and compare-and-swap publication creates a conflict copy', async () => {
  const fixture = workspace({ remote: [document('shared', 1, '共同基线')],
    local: [{ key: 'a', body: '本地编辑', binding: { id: 'shared', version: 1, revision: 'old-revision' } }] })
  fixture.implementation.publish = async request => {
    if (request.id === 'shared') fixture.server.set('shared', document('shared', 2, '抢先提交的远端编辑'))
    return fixture.accept(request)
  }
  await fixture.sync.tick()
  assert.deepEqual(fixture.calls.publishes.map(item => [item.id, item.expectedVersion]), [['shared', 1], ['new-1', 0]])
  assert.equal(decoded(fixture.server.get('shared')), '抢先提交的远端编辑')
  assert.equal(decoded(fixture.server.get('new-1')), '本地编辑')
  assert.equal(fixture.editors.get('a').binding.id, 'new-1')
})

test('a publication acknowledgement cannot acknowledge edits made while the request was pending', async () => {
  const fixture = workspace({ local: [{ key: 'a', body: '第一版' }] }), pending = deferred()
  fixture.implementation.publish = async request => { await pending.promise; return fixture.accept(request) }
  const first = fixture.sync.tick()
  await settle()
  assert.equal(fixture.calls.publishes.length, 1)
  fixture.change('a', '发送过程中继续编辑的第二版')
  pending.resolve()
  await first
  assert.equal(fixture.editors.get('a').body, '发送过程中继续编辑的第二版')
  assert.equal(fixture.editors.get('a').binding.revision, 'a:1')
  assert.equal(fixture.editors.get('a').revision, 'a:2')
  assert.equal(decoded(fixture.server.get('new-1')), '第一版')
  await fixture.sync.tick()
  assert.equal(decoded(fixture.server.get('new-1')), '发送过程中继续编辑的第二版')
  assert.deepEqual(fixture.editors.get('a').binding, { id: 'new-1', version: 2, revision: 'a:2' })
})

test('offline errors preserve bindings and local data and permit a subsequent retry', async () => {
  const binding = { id: 'shared', version: 1, revision: 'old-revision' }
  const fixture = workspace({ remote: [document('shared', 1, '原文')], local: [{ key: 'a', body: '待发送正文', binding }] })
  const state = fixture.implementation.state
  fixture.implementation.state = async () => { throw Error('网络中断') }
  await assert.rejects(fixture.sync.tick(), /网络中断/)
  assert.deepEqual(fixture.editors.get('a').binding, binding)
  assert.equal(fixture.editors.get('a').body, '待发送正文')
  assert.equal(fixture.calls.publishes.length, 0)
  fixture.implementation.state = state
  await fixture.sync.tick()
  assert.equal(decoded(fixture.server.get('shared')), '待发送正文')
  assert.equal(fixture.editors.get('a').binding.version, 2)
})

test('a failed publication preserves the existing baseline rather than marking local data synchronized', async () => {
  const binding = { id: 'shared', version: 1, revision: 'old-revision' }
  const fixture = workspace({ remote: [document('shared', 1, '原文')], local: [{ key: 'a', body: '本地修改', binding }] })
  fixture.implementation.publish = async () => { throw Error('写入未完成') }
  await assert.rejects(fixture.sync.tick(), /写入未完成/)
  assert.deepEqual(fixture.editors.get('a').binding, binding)
  assert.equal(fixture.editors.get('a').body, '本地修改')
  assert.equal(decoded(fixture.server.get('shared')), '原文')
  assert.equal(fixture.calls.bindings.length, 0)
})

test('busy state and overlapping ticks never start a second synchronization transaction', async () => {
  const fixture = workspace({ available: false, local: [{ key: 'a' }] }), pending = deferred()
  await fixture.sync.tick()
  assert.equal(fixture.calls.states, 0)
  fixture.env.available = true
  fixture.implementation.state = () => pending.promise
  const first = fixture.sync.tick()
  await fixture.sync.tick()
  assert.equal(fixture.calls.states, 1)
  fixture.env.available = false
  pending.resolve({ running: true, revision: 0, documents: [] })
  await first
  assert.equal(fixture.calls.publishes.length, 0)
  fixture.env.available = true
  await fixture.sync.tick()
  assert.equal(fixture.calls.states, 2)
  assert.equal(fixture.calls.publishes.length, 1)
})

test('a local edit during remote fetch makes adoption fail without advancing the baseline', async () => {
  const binding = { id: 'shared', version: 1, revision: 'a:1' }
  const fixture = workspace({ remote: [document('shared', 2, '远端编辑')], local: [{ key: 'a', body: '共同原文', binding }] })
  const pending = deferred()
  fixture.implementation.document = () => pending.promise
  const first = fixture.sync.tick()
  await settle()
  fixture.change('a', '远端下载时本地继续编辑')
  pending.resolve(document('shared', 2, '远端编辑'))
  await first
  assert.equal(fixture.editors.get('a').body, '远端下载时本地继续编辑')
  assert.deepEqual(fixture.editors.get('a').binding, binding)
  assert.equal(fixture.calls.bindings.length, 0)
  assert.equal(fixture.calls.publishes.length, 0)
  await fixture.sync.tick()
  assert.equal(decoded(fixture.server.get('new-1')), '远端下载时本地继续编辑')
  assert.equal(decoded(fixture.server.get('shared')), '远端编辑')
})

test('a failed model preparation preserves the old document and allows a later synchronization', async () => {
  const binding = { id: 'shared', version: 1, revision: 'a:1' }
  const fixture = workspace({ remote: [document('shared', 2, '损坏的远端内容')], local: [{ key: 'a', body: '可编辑原文', binding }] })
  const adopt = fixture.hooks.adopt
  fixture.hooks.adopt = async () => { throw Error('远端文档解析失败') }
  await assert.rejects(fixture.sync.tick(), /解析失败/)
  assert.equal(fixture.editors.get('a').body, '可编辑原文')
  assert.deepEqual(fixture.editors.get('a').binding, binding)
  fixture.hooks.adopt = adopt
  await fixture.sync.tick()
  assert.equal(fixture.editors.get('a').binding.version, 2)
})

for (const phase of ['state', 'document', 'publish', 'conflict']) {
  test(`disposing while ${phase} is pending prevents late responses from changing local state`, async () => {
    const needsRemote = phase === 'document' || phase === 'conflict'
    const fixture = workspace({ remote: needsRemote ? [document('shared', 2, '远端正文')] : [], local: [{ key: 'a', body: '本地正文',
      ...(needsRemote ? { binding: { id: 'shared', version: 1, revision: phase === 'document' ? 'a:1' : 'previous' } } : {}) }] })
    const pending = deferred()
    if (phase === 'state') fixture.implementation.state = () => pending.promise
    else if (phase === 'document') fixture.implementation.document = () => pending.promise
    else fixture.implementation.publish = () => pending.promise
    const operation = fixture.sync.tick()
    await settle()
    const before = clone([...fixture.editors]), bindings = fixture.calls.bindings.length, stateUpdates = fixture.calls.stateUpdates.length
    fixture.sync.dispose()
    if (phase === 'state') pending.resolve({ running: true, revision: 9, documents: [summary(document('late', 9, '忽略'))] })
    else if (phase === 'document') pending.resolve(document('shared', 2, '忽略'))
    else pending.resolve({ status: 'accepted', document: summary(document('new-1', 1, '忽略')) })
    await operation
    assert.deepEqual([...fixture.editors], before)
    assert.equal(fixture.calls.bindings.length, bindings)
    assert.equal(fixture.calls.stateUpdates.length, stateUpdates)
    assert.equal(fixture.calls.adoptions.length, 0)
    assert.equal(fixture.calls.forks.length, 0)
    assert.equal(fixture.calls.messages.length, 0)
    const attempts = fixture.calls.states
    await fixture.sync.tick()
    assert.equal(fixture.calls.states, attempts)
  })
}

for (const reason of ['busy', 'disposed']) for (const conflicted of [false, true]) {
  test(`becoming ${reason} during ${conflicted ? 'conflict' : 'new-document'} snapshot export does not start a network publication`, async () => {
    const fixture = workspace({ remote: conflicted ? [document('shared', 2, '远端正文')] : [], local: [{ key: 'a', body: '未确认导出',
      ...(conflicted ? { binding: { id: 'shared', version: 1, revision: 'previous' } } : {}) }] }), pending = deferred()
    fixture.hooks.snapshot = () => pending.promise
    const operation = fixture.sync.tick()
    await settle()
    if (reason === 'busy') fixture.env.available = false
    else fixture.sync.dispose()
    pending.resolve({ name: '合同.docx', extension: 'docx', base64: encoded('未确认导出'), revision: 'a:1' })
    await operation
    assert.equal(fixture.calls.publishes.length, 0)
    assert.equal(fixture.calls.bindings.length, 0)
    assert.equal(fixture.server.size, conflicted ? 1 : 0)
    assert.deepEqual(fixture.editors.get('a').binding, conflicted ? { id: 'shared', version: 1, revision: 'previous' } : undefined)
  })
}

test('a rejected conflict-copy response after disposal does not emit a late failure or alter local state', async () => {
  const binding = { id: 'shared', version: 1, revision: 'previous' }
  const fixture = workspace({ remote: [document('shared', 2, '远端正文')], local: [{ key: 'a', body: '本地正文', binding }] })
  const pending = deferred()
  fixture.implementation.publish = () => pending.promise
  const operation = fixture.sync.tick()
  await settle()
  fixture.sync.dispose()
  pending.resolve({ status: 'conflict', document: summary(document('new-1', 1, '保留')) })
  await assert.doesNotReject(operation)
  assert.deepEqual(fixture.editors.get('a').binding, binding)
  assert.equal(fixture.editors.get('a').body, '本地正文')
  assert.equal(fixture.calls.messages.length, 0)
  assert.equal(fixture.calls.forks.length, 0)
})

for (const mode of ['new', 'update', 'conflict']) {
  test(`a lost ${mode} publication acknowledgement is recovered without creating duplicate documents`, async () => {
    const initial = mode !== 'new'
    const fixture = workspace({ remote: initial ? [document('shared', mode === 'conflict' ? 2 : 1, '远端正文')] : [],
      local: [{ key: 'a', body: '已经到达服务器的第一版', ...(initial ? { binding: { id: 'shared', version: 1, revision: 'previous' } } : {}) }] })
    let loseAcknowledgement = true
    fixture.implementation.publish = async request => {
      const result = fixture.accept(request)
      if (loseAcknowledgement) { loseAcknowledgement = false; throw Error('服务器已保存，但响应中断') }
      return result
    }
    await assert.rejects(fixture.sync.tick(), /响应中断/)
    const copies = fixture.server.size, posts = fixture.calls.publishes.length
    fixture.change('a', '响应中断后继续编辑的第二版')
    await fixture.sync.tick()
    assert.equal(fixture.calls.publishes.length, posts, 'the listing confirms the specific pending request')
    assert.equal(fixture.server.size, copies)
    assert.equal(fixture.editors.get('a').binding.revision, 'a:1')
    assert.equal(fixture.editors.get('a').revision, 'a:2')
    assert.equal(fixture.editors.get('a').body, '响应中断后继续编辑的第二版')
    await fixture.sync.tick()
    assert.equal(fixture.server.size, copies)
    assert.equal(decoded(fixture.server.get(fixture.editors.get('a').binding.id)), '响应中断后继续编辑的第二版')
    assert.equal(fixture.editors.get('a').binding.revision, 'a:2')
    if (mode === 'conflict') assert.equal(fixture.calls.forks.length, 1)
  })
}

for (const mode of ['new', 'conflict']) {
  test(`retrying a ${mode} POST that never reached the server reuses its pending identifier`, async () => {
    const fixture = workspace({ remote: mode === 'conflict' ? [document('shared', 2, '远端正文')] : [],
      local: [{ key: 'a', ...(mode === 'conflict' ? { binding: { id: 'shared', version: 1, revision: 'previous' } } : {}) }] })
    let fail = true
    fixture.implementation.publish = async request => {
      if (fail) { fail = false; throw Error('连接在发送前中断') }
      return fixture.accept(request)
    }
    await assert.rejects(fixture.sync.tick(), /发送前中断/)
    await fixture.sync.tick()
    assert.equal(fixture.calls.publishes.length, 2)
    assert.deepEqual(fixture.calls.publishes[1], fixture.calls.publishes[0])
    assert.equal(fixture.server.size, mode === 'conflict' ? 2 : 1)
    assert.equal(fixture.editors.get('a').binding.revision, 'a:1')
  })
}

test('a stale listing followed by a repeated identical POST recognizes its existing receipt', async () => {
  const fixture = workspace({ local: [{ key: 'a' }] })
  let fail = true
  fixture.implementation.publish = async request => {
    const result = fixture.accept(request)
    if (fail) { fail = false; throw Error('响应超时') }
    return result
  }
  await assert.rejects(fixture.sync.tick(), /响应超时/)
  fixture.implementation.state = async () => ({ running: true, revision: 0, documents: [] })
  await fixture.sync.tick()
  assert.equal(fixture.server.size, 1)
  assert.equal(fixture.calls.publishes.length, 2)
  assert.deepEqual(fixture.calls.publishes[1], fixture.calls.publishes[0])
  assert.deepEqual(fixture.editors.get('a').binding, { id: 'new-1', version: 1, revision: 'a:1' })
  assert.equal(fixture.calls.forks.length, 0)
})

test('a timed-out old POST arriving after another edit cannot acknowledge the newer local revision', async () => {
  const fixture = workspace({ local: [{ key: 'a', body: '超时的第一版' }] })
  let oldRequest
  fixture.implementation.publish = async request => {
    if (!oldRequest) { oldRequest = clone(request); throw Error('请求超时，但仍在服务端队列中') }
    if (request.id === oldRequest.id && !fixture.server.has(request.id)) fixture.accept(oldRequest)
    return fixture.accept(request)
  }
  await assert.rejects(fixture.sync.tick(), /请求超时/)
  fixture.change('a', '尚未确认的新第二版')
  await fixture.sync.tick()
  assert.notEqual(fixture.calls.publishes[0].clientId, fixture.calls.publishes[1].clientId)
  assert.equal(decoded(fixture.server.get('new-1')), '超时的第一版')
  assert.equal(decoded(fixture.server.get('new-2')), '尚未确认的新第二版')
  assert.deepEqual(fixture.editors.get('a').binding, { id: 'new-2', version: 1, revision: 'a:2' })
})

test('a pending copy edited by another client is preserved while current local content gets a new copy', async () => {
  const fixture = workspace({ local: [{ key: 'a', body: '本端原文' }] })
  let fail = true
  fixture.implementation.publish = async request => {
    const result = fixture.accept(request)
    if (fail) { fail = false; throw Error('确认丢失') }
    return result
  }
  await assert.rejects(fixture.sync.tick(), /确认丢失/)
  fixture.server.set('new-1', document('new-1', 2, '另一端已经继续编辑'))
  await fixture.sync.tick()
  assert.equal(decoded(fixture.server.get('new-1')), '另一端已经继续编辑')
  assert.equal(decoded(fixture.server.get('new-2')), '本端原文')
  assert.equal(fixture.editors.get('a').binding.id, 'new-2')
})

test('a late POST response does not overwrite a binding replaced by another shell operation', async () => {
  const fixture = workspace({ local: [{ key: 'a' }] }), pending = deferred()
  fixture.implementation.publish = async request => { await pending.promise; return fixture.accept(request) }
  const operation = fixture.sync.tick()
  await settle()
  const replacement = { id: 'other-workspace-document', version: 9, revision: 'replacement' }
  fixture.editors.get('a').binding = replacement
  pending.resolve()
  await operation
  assert.deepEqual(fixture.editors.get('a').binding, replacement)
  assert.equal(fixture.calls.bindings.length, 0)
})

test('closing a tab during a POST leaves its remote result intact without touching a missing editor', async () => {
  const fixture = workspace({ local: [{ key: 'a' }] }), pending = deferred()
  fixture.implementation.publish = async request => { await pending.promise; return fixture.accept(request) }
  const operation = fixture.sync.tick()
  await settle()
  fixture.editors.delete('a')
  pending.resolve()
  await assert.doesNotReject(operation)
  assert.equal(fixture.server.size, 1)
  assert.equal(fixture.calls.bindings.length, 0)
  await fixture.sync.tick()
  assert.equal(fixture.calls.publishes.length, 1)
})

test('a stopped server is reported without exporting or publishing local document bytes', async () => {
  const fixture = workspace({ local: [{ key: 'a' }] })
  fixture.implementation.state = async () => ({ running: false, revision: 0, documents: [] })
  fixture.hooks.snapshot = async () => { throw Error('不应导出') }
  await fixture.sync.tick()
  assert.equal(fixture.calls.stateUpdates[0].running, false)
  assert.equal(fixture.calls.publishes.length, 0)
})

test('a binding mutated in place during export cannot redirect the captured upload intent', async () => {
  const fixture = workspace({ remote: [document('shared', 1, '原文')],
    local: [{ key: 'a', body: '本地编辑', binding: { id: 'shared', version: 1, revision: 'previous' } }] })
  fixture.hooks.locals = () => [...fixture.editors.values()].map(editor => ({ key: editor.key, binding: editor.binding }))
  const pending = deferred()
  fixture.hooks.snapshot = () => pending.promise
  const operation = fixture.sync.tick()
  await settle()
  fixture.editors.get('a').binding.id = 'different-document'
  pending.resolve({ name: '合同.docx', extension: 'docx', base64: encoded('本地编辑'), revision: 'a:1' })
  await operation
  assert.equal(fixture.calls.publishes.length, 0)
  assert.equal(fixture.editors.get('a').binding.id, 'different-document')
})

for (const reason of ['disposed', 'rebound']) {
  test(`a remote model being prepared cannot commit after its synchronization is ${reason}`, async () => {
    const original = { id: 'shared', version: 1, revision: 'a:1' }
    const fixture = workspace({ remote: [document('shared', 2, '不应替换的远端正文')],
      local: [{ key: 'a', body: '保留的本地模型', binding: original }] })
    const pending = deferred(), adopt = fixture.hooks.adopt
    let preparing = false
    fixture.hooks.adopt = async (...args) => { preparing = true; await pending.promise; return adopt(...args) }
    const operation = fixture.sync.tick()
    await settle()
    assert.equal(preparing, true)
    if (reason === 'disposed') fixture.sync.dispose()
    else fixture.editors.get('a').binding = { id: 'different-document', version: 8, revision: 'a:1' }
    const expected = clone(fixture.editors.get('a').binding)
    pending.resolve()
    await operation
    assert.equal(fixture.editors.get('a').body, '保留的本地模型')
    assert.deepEqual(fixture.editors.get('a').binding, expected)
    assert.equal(fixture.editors.get('a').revision, 'a:1')
  })
}

for (const phase of ['snapshot', 'adopt', 'publish']) {
  test(`a first document ${phase} failure does not starve a later healthy document or lose its retry baseline`, async () => {
    const binding = phase === 'adopt' ? { id: 'damaged', version: 1, revision: 'bad:1' } : undefined
    const fixture = workspace({
      remote: phase === 'adopt' ? [document('damaged', 2, '远端可恢复内容', '失败.docx')] : [],
      local: [{ key: 'bad', name: '失败.docx', body: '保留失败文档的本地内容', binding },
        { key: 'good', name: '正常.docx', body: '正常文档仍须同步' }],
    })
    const failure = Error(`${phase} failed`)
    const snapshot = fixture.hooks.snapshot, adopt = fixture.hooks.adopt, publish = fixture.implementation.publish
    if (phase === 'snapshot') fixture.hooks.snapshot = async key => {
      if (key === 'bad') throw failure
      return snapshot(key)
    }
    else if (phase === 'adopt') fixture.hooks.adopt = async (key, ...args) => {
      if (key === 'bad') throw failure
      return adopt(key, ...args)
    }
    else fixture.implementation.publish = async request => {
      if (request.name === '失败.docx') throw failure
      return publish(request)
    }

    await assert.rejects(fixture.sync.tick(), error => error === failure)
    assert.equal(fixture.editors.get('bad').body, '保留失败文档的本地内容')
    assert.deepEqual(fixture.editors.get('bad').binding, binding)
    const healthyBinding = clone(fixture.editors.get('good').binding)
    assert.equal(decoded(fixture.server.get(healthyBinding.id)), '正常文档仍须同步')
    assert.equal(healthyBinding.revision, 'good:1')
    const failedPublication = fixture.calls.publishes.find(request => request.name === '失败.docx')

    fixture.hooks.snapshot = snapshot
    fixture.hooks.adopt = adopt
    fixture.implementation.publish = publish
    await fixture.sync.tick()
    assert.deepEqual(fixture.editors.get('good').binding, healthyBinding)
    assert.equal(fixture.calls.publishes.filter(request => request.name === '正常.docx').length, 1)
    const recovered = fixture.editors.get('bad')
    assert.equal(recovered.binding.revision, recovered.revision)
    if (phase === 'adopt') assert.equal(recovered.body, '远端可恢复内容')
    else assert.equal(decoded(fixture.server.get(recovered.binding.id)), '保留失败文档的本地内容')
    if (failedPublication) assert.equal(recovered.binding.id, failedPublication.id, 'a failed POST reuses its pending identifier')
  })
}

test('later document failures preserve earlier acknowledgements and report only the first failure after other tabs finish', async () => {
  const fixture = workspace({ local: ['first', 'bad', 'middle', 'last'].map(key => ({ key, name: `${key}.docx`, body: key })) })
  const firstFailure = Error('first local failure'), lastFailure = Error('later local failure')
  const snapshot = fixture.hooks.snapshot, attempted = []
  fixture.hooks.snapshot = async key => {
    attempted.push(key)
    if (key === 'bad') throw firstFailure
    if (key === 'last') throw lastFailure
    return snapshot(key)
  }
  await assert.rejects(fixture.sync.tick(), error => error === firstFailure)
  assert.deepEqual(attempted, ['first', 'bad', 'middle', 'last'])
  for (const key of ['first', 'middle']) {
    const editor = fixture.editors.get(key)
    assert.equal(decoded(fixture.server.get(editor.binding.id)), key)
    assert.equal(editor.binding.revision, editor.revision)
  }
  for (const key of ['bad', 'last']) {
    assert.equal(fixture.editors.get(key).binding, undefined)
    assert.equal(fixture.editors.get(key).body, key)
  }
})

for (const reason of ['busy', 'disposed']) {
  test(`document error isolation stops before later documents when synchronization becomes ${reason}`, async () => {
    const fixture = workspace({ local: [{ key: 'bad' }, { key: 'good' }] })
    const failure = Error('first document failed'), attempted = []
    fixture.hooks.snapshot = async key => {
      attempted.push(key)
      if (reason === 'busy') fixture.env.available = false
      else fixture.sync.dispose()
      throw failure
    }
    if (reason === 'disposed') await assert.doesNotReject(fixture.sync.tick())
    else await assert.rejects(fixture.sync.tick(), error => error === failure)
    assert.deepEqual(attempted, ['bad'])
    assert.equal(fixture.calls.publishes.length, 0)
    assert.equal(fixture.calls.bindings.length, 0)
    assert.equal(fixture.editors.get('good').binding, undefined)
  })
}
