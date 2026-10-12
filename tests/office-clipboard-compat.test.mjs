import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../public/office/clipboard-compat.js', import.meta.url), 'utf8')
const context = vm.createContext({})
vm.runInContext(source, context)
const install = context.installOfficeClipboardPermissionCompatibility

test('unsupported clipboard queries keep the exact rejected promise and native arguments', async () => {
  for (const name of ['clipboard-read', 'clipboard-write']) {
    const error = new TypeError('Unsupported permission descriptor')
    const original = Promise.reject(error), descriptor = { name }, options = { probe: true }, observed = []
    const permissions = { query(...args) {
      assert.equal(this, permissions)
      assert.deepEqual(args, [descriptor, options])
      return original
    } }
    const nativeQuery = permissions.query
    const restore = install(permissions, (...args) => observed.push(args))
    const returned = permissions.query(descriptor, options)
    assert.equal(returned, original, 'Do not resolve unsupported queries with a fake permission status')
    await assert.rejects(returned, value => value === error)
    assert.deepEqual(observed, [[name, error]])
    restore()
    assert.equal(permissions.query, nativeQuery)
  }
})

test('real clipboard permission statuses are unchanged, including denied', async () => {
  for (const state of ['denied', 'prompt', 'granted']) {
    const status = { state, onchange: null }
    const original = Promise.resolve(status)
    const permissions = { query: () => original }
    install(permissions, () => assert.fail('A valid status is not an unsupported API'))
    assert.equal(permissions.query({ name: 'clipboard-read' }), original)
    assert.equal(await original, status)
    assert.equal(status.state, state)
  }
})

test('other permission descriptors do not get an error handler', async () => {
  const error = new TypeError('Native camera permission failure')
  const original = Promise.reject(error)
  Object.defineProperty(original, 'catch', { get() { assert.fail('Non-clipboard promises must be untouched') } })
  const permissions = { query: () => original }
  install(permissions, () => assert.fail('Non-clipboard query must not be handled'))
  assert.equal(permissions.query({ name: 'camera' }), original)
  await assert.rejects(original, value => value === error)
})

test('unexpected clipboard failures are rethrown rather than suppressed', async () => {
  // Observe the independent branch to verify that it rejects with the same
  // error. In a browser without this test observer it reaches unhandledrejection.
  class TrackedPromise extends Promise {
    catch(handler) { this.observation = super.catch(handler); return this.observation }
  }
  for (const error of [new DOMException('Denied by policy', 'SecurityError'), new Error('Engine failure')]) {
    const original = TrackedPromise.reject(error)
    const permissions = { query: () => original }
    install(permissions, () => assert.fail('Unexpected errors are not unsupported descriptors'))
    assert.equal(permissions.query({ name: 'clipboard-write' }), original)
    await assert.rejects(original.observation, value => value === error)
    await assert.rejects(original, value => value === error)
  }
})

test('synchronous query failures and missing API preserve native behavior', () => {
  const error = new TypeError('Invalid invocation')
  const permissions = { query() { throw error } }
  install(permissions, () => assert.fail('Synchronous errors must propagate'))
  assert.throws(() => permissions.query({ name: 'clipboard-read' }), value => value === error)
  assert.doesNotThrow(() => install(undefined, () => {})())
})
