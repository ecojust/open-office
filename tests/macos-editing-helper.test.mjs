import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/sheet/rust/macos-editing-smoke.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const bootId = 'd3b1ead1-d8e1-418f-b964-cd13826da6ac'
function harness({ native = false, optedIn = false, boot, existing = [], liveTimeOrigin = () => 12345 } = {}) {
  const module = { exports: {} }, calls = [], listeners = new Set()
  const window = {
    __OPEN_OFFICE_DIAGNOSTIC_BOOT__: boot,
    addEventListener(name) { listeners.add(name) },
    removeEventListener(name) { listeners.delete(name) },
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, window, performance: { get timeOrigin() { return liveTimeOrigin() } }, setTimeout, clearTimeout,
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
