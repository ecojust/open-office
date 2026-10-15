import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'

// Execute the exact script embedded by Rust, with only its injected URL token
// substituted. This checks the installed-page listeners, not a copied filter.
const source = await readFile(new URL('../src-tauri/src/smoke-init.js', import.meta.url), 'utf8')
const base = 'http://127.0.0.1:43210/fixture-secret/'
const resizeMessage = 'ResizeObserver loop completed with undelivered notifications.'

function initialize({ href = `${base}?nativeSmoke=1`, injectedBase = base, now = 0 } = {}) {
  const listeners = new Map(), requests = [], window = {}
  let clock = now
  class ErrorEvent {
    constructor(type, init = {}) {
      Object.assign(this, { type, target: window, isTrusted: true, message: '', error: null, filename: '', lineno: 0, colno: 0 }, init)
    }
  }
  const context = vm.createContext({
    window, ErrorEvent, URL, location: { href }, navigator: { userAgent: 'native-smoke-init-test' },
    crossOriginIsolated: true, SharedArrayBuffer,
    crypto: { randomUUID }, performance: { now: () => clock, timeOrigin: 1700000000000 },
    addEventListener(type, callback, capture) {
      const entries = listeners.get(type) || []
      entries.push({ callback, capture }); listeners.set(type, entries)
    },
    fetch(url, options) {
      requests.push({ url, method: options.method, headers: options.headers, body: JSON.parse(options.body) })
      return Promise.resolve({ ok: true })
    },
  })
  vm.runInContext(source.replace('__OPEN_OFFICE_SMOKE_BASE_URL__', JSON.stringify(injectedBase)), context, { filename: 'smoke-init.js' })
  const emit = (type, event) => { for (const { callback } of listeners.get(type) || []) callback(event) }
  const error = (init = {}) => new ErrorEvent('error', init)
  const notify = (at = clock, init = {}) => { clock = at; emit('error', error({ message: resizeMessage, ...init })) }
  const progress = () => requests.filter(request => request.url === `${injectedBase}__native-smoke/progress`)
  const failures = () => requests.filter(request => request.url === `${injectedBase}__native-smoke/failure`)
  return { requests, listeners, window, href, error, emit, notify, progress, failures }
}

function assertOneFailure(h, expected) {
  assert.equal(h.failures().length, 1)
  const request = h.failures()[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.body.ok, false)
  assert.equal(request.body.phase, 'renderer-uncaught')
  assert.equal(request.body.error, expected)
  assert.equal(request.body.crossOriginIsolated, true)
  assert.equal(request.body.sharedArrayBuffer, true)
  assert.equal(request.body.userAgent, 'native-smoke-init-test')
}
function fillWindow(h, start, count = 30) {
  for (let index = 0; index < count; index++) h.notify(start + index * 30)
}

test('each document has an immutable new boot identifier also sent to the host', () => {
  const first = initialize(), second = initialize()
  const boot = first.window.__OPEN_OFFICE_DIAGNOSTIC_BOOT__
  assert.match(boot.bootId, /^[a-f0-9-]{36}$/)
  assert.equal(boot.timeOrigin, 1700000000000)
  assert.equal(Object.isFrozen(boot), true)
  assert.notEqual(boot.bootId, second.window.__OPEN_OFFICE_DIAGNOSTIC_BOOT__.bootId)
  assert.deepEqual(JSON.parse(first.progress()[0].body.detail), { bootId: boot.bootId, timeOrigin: boot.timeOrigin })
  assert.throws(() => { first.window.__OPEN_OFFICE_DIAGNOSTIC_BOOT__ = {} }, TypeError)
})

test('standard UA ResizeObserver notification records progress without masking the next real exception', () => {
  const h = initialize()
  assert.equal(h.listeners.get('error').length, 1)
  assert.equal(h.listeners.get('error')[0].capture, true)
  assert.equal(h.listeners.get('unhandledrejection').length, 1)
  assert.equal(h.progress()[0].body.phase, 'document-start')
  h.notify(1)
  assert.equal(h.failures().length, 0)
  assert.equal(h.progress().length, 2)
  assert.equal(h.progress()[1].body.phase, 'renderer-resize-observer-notification')
  assert.equal(h.progress()[1].body.detail, 'count=1; consecutiveBusyWindows=0')
  h.emit('error', h.error({ message: 'real callback exception', error: new Error('real callback exception'), filename: 'app.js', lineno: 10, colno: 4 }))
  assertOneFailure(h, 'real callback exception')
})

test('trusted ResizeObserver notification naming the current document remains recoverable', () => {
  const h = initialize()
  h.notify(1, { filename: h.href })
  assert.equal(h.failures().length, 0)
  assert.equal(h.progress().length, 2)
  assert.equal(h.progress()[1].body.phase, 'renderer-resize-observer-notification')
  h.emit('error', h.error({ message: resizeMessage, filename: h.href, error: new Error('callback threw the same wording') }))
  assertOneFailure(h, resizeMessage)
})

test('only an exact browser-shaped ResizeObserver ErrorEvent can be recoverable', async t => {
  const cases = [
    ['exception attached', h => h.error({ message: resizeMessage, error: new Error(resizeMessage) })],
    ['non-document source filename attached', h => h.error({ message: resizeMessage, filename: 'app.js' })],
    ['different document URL', h => h.error({ message: resizeMessage, filename: `${base}other.html?nativeSmoke=1` })],
    ['synthetic same-shaped event', h => h.error({ message: resizeMessage, isTrusted: false })],
    ['synthetic event naming the current document', h => h.error({ message: resizeMessage, filename: h.href, isTrusted: false })],
    ['source line attached', h => h.error({ message: resizeMessage, lineno: 1 })],
    ['source column attached', h => h.error({ message: resizeMessage, colno: 1 })],
    ['ordinary event object', h => ({ target: h.window, isTrusted: true, message: resizeMessage, error: null, filename: '', lineno: 0, colno: 0 })],
    ['non-window target', h => h.error({ message: resizeMessage, target: { tagName: 'DIV' } })],
  ]
  for (const [name, makeEvent] of cases) await t.test(name, () => {
    const h = initialize()
    h.emit('error', makeEvent(h))
    assertOneFailure(h, resizeMessage)
    assert.equal(h.progress().length, 1, 'A real exception must not be reclassified as resize progress')
  })
})

test('different ResizeObserver wording remains a fatal error', () => {
  const h = initialize(), message = 'ResizeObserver loop limit exceeded'
  h.emit('error', h.error({ message }))
  assertOneFailure(h, message)
})

test('script loading failures and unhandled promise rejections remain fatal', async t => {
  await t.test('script element error', () => {
    const h = initialize()
    h.emit('error', { target: { tagName: 'SCRIPT' } })
    assertOneFailure(h, 'Entry script failed to load')
  })
  await t.test('Error rejection', () => {
    const h = initialize()
    h.emit('unhandledrejection', { reason: new Error('async engine failed') })
    assertOneFailure(h, 'async engine failed')
  })
  await t.test('string rejection', () => {
    const h = initialize()
    h.emit('unhandledrejection', { reason: 'promise failed without Error object' })
    assertOneFailure(h, 'promise failed without Error object')
  })
})

test('only the first fatal error is reported across subsequent event types', () => {
  const h = initialize()
  h.notify(5)
  h.emit('error', h.error({ message: 'first failure' }))
  h.emit('error', h.error({ message: 'later failure', error: new Error('later failure') }))
  h.emit('error', { target: { tagName: 'SCRIPT' } })
  h.emit('unhandledrejection', { reason: new Error('later rejection') })
  assertOneFailure(h, 'first failure')
})

test('unapproved page URLs register no listeners and send no diagnostics', async t => {
  const cases = [
    ['missing smoke query', base],
    ['disabled smoke query', `${base}?nativeSmoke=0`],
    ['wrong smoke query value', `${base}?nativeSmoke=true`],
    ['different origin', 'http://127.0.0.1:43211/fixture-secret/?nativeSmoke=1'],
    ['different secret path', 'http://127.0.0.1:43210/other-secret/?nativeSmoke=1'],
    ['similar secret prefix', 'http://127.0.0.1:43210/fixture-secret-other/?nativeSmoke=1'],
  ]
  for (const [name, href] of cases) await t.test(name, () => {
    const h = initialize({ href })
    assert.equal(h.listeners.size, 0)
    assert.deepEqual(h.requests, [])
  })
  await t.test('injected base does not match the page', () => {
    const h = initialize({ injectedBase: 'http://127.0.0.1:43210/wrong-base/' })
    assert.equal(h.listeners.size, 0)
    assert.deepEqual(h.requests, [])
  })
})

test('a short high-volume mount burst is recoverable', () => {
  const h = initialize()
  for (let index = 0; index < 300; index++) h.notify(index)
  h.notify(1000)
  h.notify(2000)
  h.notify(3000)
  assert.equal(h.failures().length, 0)
  assert.ok(h.progress().some(request => request.body.phase === 'renderer-resize-observer-notification'))
  h.emit('unhandledrejection', { reason: new Error('real failure after resize burst') })
  assertOneFailure(h, 'real failure after resize burst')
})

test('three sustained one-second windows with at least 30 notifications fail at the next boundary', () => {
  const h = initialize({ now: 5000 })
  fillWindow(h, 5000)
  fillWindow(h, 6000)
  fillWindow(h, 7000)
  assert.equal(h.failures().length, 0, 'The third window has not yet completed')
  h.notify(8000)
  assertOneFailure(h, 'Persistent ResizeObserver notification loop across three successive observation windows.')
  h.notify(8030)
  h.emit('error', h.error({ message: 'later failure' }))
  assert.equal(h.failures().length, 1, 'Persistent-loop failures use the same fatal deduplication')
})

test('a gap longer than two seconds resets sustained ResizeObserver accumulation', () => {
  const h = initialize()
  fillWindow(h, 0)
  fillWindow(h, 1000)
  fillWindow(h, 2000)
  // The previous event was at 2870; resume after a genuine > 2 second gap.
  fillWindow(h, 5000)
  fillWindow(h, 6000)
  fillWindow(h, 7000)
  assert.equal(h.failures().length, 0, 'A later burst must not inherit the two earlier busy windows')
  h.notify(8000)
  assertOneFailure(h, 'Persistent ResizeObserver notification loop across three successive observation windows.')
})

test('an observation interval of exactly two seconds resets the busy-window count', () => {
  const h = initialize()
  fillWindow(h, 0)
  fillWindow(h, 1000)
  fillWindow(h, 2000)
  // The measured interval starts at 2000, not at that window's final event.
  // It is exactly 2000 ms when this next notification arrives.
  fillWindow(h, 4000)
  fillWindow(h, 5000)
  fillWindow(h, 6000)
  assert.equal(h.failures().length, 0)
  h.notify(7000)
  assertOneFailure(h, 'Persistent ResizeObserver notification loop across three successive observation windows.')
})

test('low-frequency notifications and an intervening quiet window are not sustained loops', async t => {
  await t.test('29 notifications per window remain below the threshold', () => {
    const h = initialize()
    for (let start = 0; start < 10000; start += 1000) fillWindow(h, start, 29)
    h.notify(10000)
    assert.equal(h.failures().length, 0)
  })
  await t.test('a quiet window interrupts otherwise frequent notifications', () => {
    const h = initialize()
    fillWindow(h, 0)
    fillWindow(h, 1000)
    fillWindow(h, 2000, 1)
    fillWindow(h, 3000)
    fillWindow(h, 4000)
    fillWindow(h, 5000, 1)
    h.notify(6000)
    assert.equal(h.failures().length, 0)
  })
})
