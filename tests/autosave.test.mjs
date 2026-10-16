import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutosaveScheduler, AUTOSAVE_INTERVAL_MS, AUTOSAVE_MAX_BACKOFF_MS } from '../src/shared/autosave.ts'

const settle = () => new Promise(resolve => setImmediate(resolve))

function fakeClock() {
  let now = 0, sequence = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimeout(callback, milliseconds) { const id = ++sequence; pending.set(id, { at: now + milliseconds, callback }); return id },
    clearTimeout(id) { pending.delete(id) },
    get pending() { return pending.size },
    async advance(milliseconds) {
      const until = now + milliseconds
      for (;;) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = next[1].at
        pending.delete(next[0])
        next[1].callback()
        await settle()
      }
      now = until
      await settle()
    },
  }
}

function editable(overrides = {}) {
  return { enabled: true, native: true, key: 'tab-1', fileId: 'local-1', dirty: true, ready: true,
    requiresSaveAs: false, canSaveDirectly: true, busy: false, modal: false, composing: false, remoteEditing: false, ...overrides }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('automatic saves wait 30 seconds and only repeat for a dirty local document', async () => {
  assert.equal(AUTOSAVE_INTERVAL_MS, 30_000)
  assert.equal(AUTOSAVE_MAX_BACKOFF_MS, 300_000)
  const clock = fakeClock(), state = editable(), calls = []
  const scheduler = createAutosaveScheduler({ clock, readState: () => state,
    async save(target) { calls.push(target); state.dirty = false; return true } })
  await clock.advance(29_999)
  assert.equal(calls.length, 0)
  await clock.advance(1)
  assert.deepEqual(calls, [{ key: 'tab-1', fileId: 'local-1' }])
  await clock.advance(90_000)
  assert.equal(calls.length, 1)
  state.dirty = true
  await clock.advance(30_000)
  assert.equal(calls.length, 2)
  scheduler.dispose()
  assert.equal(clock.pending, 0)
})

for (const [name, overrides] of Object.entries({
  browser: { native: false },
  clean: { dirty: false },
  loading: { ready: false },
  'protected import': { requiresSaveAs: true },
  'conversion or missing editor': { canSaveDirectly: false },
  'another transaction': { busy: true },
  dialog: { modal: true },
  'uncommitted IME': { composing: true },
  'remote editor': { remoteEditing: true },
  'new document without a path': { fileId: undefined },
  'empty file identifier': { fileId: '  ' },
  'no active tab': { key: undefined },
  'unreported direct-save capability': { canSaveDirectly: undefined },
})) {
  test(`automatic saves skip ${name} and recheck at the next tick`, async () => {
    const clock = fakeClock(), state = editable(overrides), calls = []
    const scheduler = createAutosaveScheduler({ clock, readState: () => state,
      async save(target) { calls.push(target); state.dirty = false; return true } })
    await clock.advance(90_000)
    assert.equal(calls.length, 0, 'the file-saving callback must not be entered')
    Object.assign(state, editable())
    await clock.advance(30_000)
    assert.equal(calls.length, 1, 'transient conditions recover without a renderer notification')
    scheduler.dispose()
  })
}

test('preference changes cancel pending ticks and repeated notifications cannot postpone a save', async () => {
  const clock = fakeClock(), state = editable({ enabled: false }), calls = []
  const scheduler = createAutosaveScheduler({ clock, readState: () => state, async save() { calls.push(clock.now()); return true } })
  assert.equal(clock.pending, 0)
  state.enabled = true
  scheduler.notify()
  for (let i = 0; i < 5; i++) { await clock.advance(5_000); scheduler.notify() }
  await clock.advance(5_000)
  assert.deepEqual(calls, [30_000])
  state.enabled = false
  scheduler.notify()
  assert.equal(clock.pending, 0)
  await clock.advance(60_000)
  assert.deepEqual(calls, [30_000])
  state.enabled = true
  scheduler.notify()
  await clock.advance(30_000)
  assert.deepEqual(calls, [30_000, 120_000])
  scheduler.dispose()
})

test('eligibility is read at the deadline, not captured when the timer was created', async () => {
  const clock = fakeClock(), state = editable(), calls = []
  const scheduler = createAutosaveScheduler({ clock, readState: () => state, async save(target) { calls.push(target); return true } })
  await clock.advance(29_999)
  state.composing = true
  await clock.advance(1)
  assert.equal(calls.length, 0)
  state.composing = false
  state.key = 'tab-2'; state.fileId = 'local-2'
  await clock.advance(30_000)
  assert.deepEqual(calls, [{ key: 'tab-2', fileId: 'local-2' }])
  scheduler.dispose()
})

test('one in-flight save holds an immutable target across notifications and tab changes', async () => {
  const clock = fakeClock(), state = editable(), pending = deferred(), calls = []
  const scheduler = createAutosaveScheduler({ clock, readState: () => state,
    save(target) { calls.push(target); scheduler.notify(); return calls.length === 1 ? pending.promise : Promise.resolve(true) } })
  await clock.advance(30_000)
  assert.equal(scheduler.running, true)
  assert.equal(clock.pending, 0)
  state.key = 'tab-2'; state.fileId = 'local-2'
  for (let i = 0; i < 10; i++) scheduler.notify()
  await clock.advance(300_000)
  assert.deepEqual(calls, [{ key: 'tab-1', fileId: 'local-1' }])
  assert.equal(Object.isFrozen(calls[0]), true)
  pending.resolve(true)
  await settle()
  assert.equal(scheduler.running, false)
  await clock.advance(30_000)
  assert.deepEqual(calls, [{ key: 'tab-1', fileId: 'local-1' }, { key: 'tab-2', fileId: 'local-2' }])
  scheduler.dispose()
})

test('false results and exceptions back off exponentially, cap at five minutes, and reset after success', async () => {
  const clock = fakeClock(), state = editable(), calls = [], failures = []
  const scheduler = createAutosaveScheduler({ clock, readState: () => state,
    async save() {
      calls.push(clock.now())
      if (calls.length === 6) return true
      if (calls.length % 2) throw Error('本地文件暂时不可写')
      return false
    },
    onError(error, target, retryInMs) { failures.push({ error, target, retryInMs }); scheduler.notify() },
  })
  await clock.advance(810_000)
  assert.deepEqual(calls, [30_000, 60_000, 120_000, 240_000, 480_000, 780_000, 810_000])
  assert.deepEqual(failures.map(item => item.retryInMs), [30_000, 60_000, 120_000, 240_000, 300_000, 30_000])
  assert.ok(failures.every(item => item.error instanceof Error && item.target.fileId === 'local-1'))
  scheduler.dispose()
})

test('one document failure does not delay another file, and switching back preserves its backoff', async () => {
  const clock = fakeClock(), state = editable(), calls = [], retries = []
  const scheduler = createAutosaveScheduler({ clock, readState: () => state,
    async save(target) { calls.push([clock.now(), target.fileId]); return target.fileId === 'local-2' },
    onError(_error, target, retryInMs) { retries.push([target.fileId, retryInMs]) },
  })
  await clock.advance(60_000)
  state.key = 'tab-2'; state.fileId = 'local-2'
  scheduler.notify()
  await clock.advance(30_000)
  state.key = 'tab-1'; state.fileId = 'local-1'
  await clock.advance(30_000)
  state.fileId = 'local-1-saved-as'
  await clock.advance(30_000)
  assert.deepEqual(calls, [[30_000, 'local-1'], [60_000, 'local-1'], [90_000, 'local-2'], [120_000, 'local-1'], [150_000, 'local-1-saved-as']])
  assert.deepEqual(retries, [['local-1', 30_000], ['local-1', 60_000], ['local-1', 120_000], ['local-1-saved-as', 30_000]])
  scheduler.dispose()
})

test('disposing a pending save suppresses later error callbacks and all rescheduling', async () => {
  const clock = fakeClock(), state = editable(), pending = deferred(), errors = []
  let calls = 0
  const scheduler = createAutosaveScheduler({ clock, readState: () => state,
    save() { calls++; return pending.promise }, onError: error => errors.push(error) })
  await clock.advance(30_000)
  scheduler.dispose()
  scheduler.notify()
  pending.reject(Error('保存失败'))
  await settle()
  await clock.advance(600_000)
  assert.equal(calls, 1)
  assert.equal(scheduler.running, false)
  assert.equal(clock.pending, 0)
  assert.deepEqual(errors, [])
})

test('disposal inside an error notification prevents the finally block from scheduling again', async () => {
  const clock = fakeClock(), state = editable()
  let calls = 0
  const scheduler = createAutosaveScheduler({ clock, readState: () => state,
    async save() { calls++; throw Error('文件不可写') },
    onError() { scheduler.dispose(); scheduler.notify() },
  })
  await clock.advance(300_000)
  assert.equal(calls, 1)
  assert.equal(clock.pending, 0)
})

test('turning the preference off during a save prevents any following timer', async () => {
  const clock = fakeClock(), state = editable(), pending = deferred()
  const scheduler = createAutosaveScheduler({ clock, readState: () => state, save: () => pending.promise })
  await clock.advance(30_000)
  state.enabled = false
  scheduler.notify()
  pending.resolve(true)
  await settle()
  assert.equal(clock.pending, 0)
  assert.equal(scheduler.running, false)
  scheduler.dispose()
})

test('state and error-notification exceptions fail closed without killing the timer', async () => {
  const clock = fakeClock(), state = editable()
  let stateUnavailable = true, calls = 0
  const scheduler = createAutosaveScheduler({ clock,
    readState() { if (stateUnavailable) throw Error('状态暂不可用'); return state },
    async save() { calls++; return true },
    onError() { throw Error('通知暂不可用') },
  })
  await clock.advance(60_000)
  assert.equal(calls, 0)
  stateUnavailable = false
  await clock.advance(30_000)
  assert.equal(calls, 1)
  scheduler.dispose()
})

test('invalid timing configuration cannot start a hot retry loop', () => {
  for (const intervalMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => createAutosaveScheduler({ readState: () => editable(), save: async () => true, intervalMs }), RangeError)
  }
  assert.throws(() => createAutosaveScheduler({ readState: () => editable(), save: async () => true, intervalMs: 30_000, maxBackoffMs: 1 }), RangeError)
})
