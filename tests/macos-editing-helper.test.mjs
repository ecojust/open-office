import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/sheet/rust/macos-editing-smoke.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function harness({ native = false, optedIn = false, boot, existing = [] } = {}) {
  const module = { exports: {} }, calls = [], listeners = new Set()
  const window = {
    __OPEN_OFFICE_DIAGNOSTIC_BOOT__: boot,
    addEventListener(name) { listeners.add(name) },
    removeEventListener(name) { listeners.delete(name) },
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, window, performance: { timeOrigin: 12345 }, setTimeout, clearTimeout,
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
  assert.deepEqual(h.calls, [])
})
test('native editing evidence refuses a missing or stale initialization boot marker', async () => {
  for (const boot of [undefined, { bootId: 'fixture-native-boot-id', timeOrigin: 12344 }]) {
    const h = harness({ native: true, optedIn: true, boot })
    await assert.rejects(h.api.runMacosEditingSmoke(h.adapter), /boot marker is missing or invalid/)
    assert.deepEqual(h.calls, [])
  }
})
test('diagnostic refuses a nonempty user workbench without opening or closing any user tabs', async () => {
  const h = harness({ boot: { bootId: 'fixture-native-boot-id', timeOrigin: 12345 }, existing: [{ key: 'user-unsaved-work', kind: 'sheet', dirty: true, ready: true }] })
  const report = await h.api.verifyMacosEditing(h.adapter, () => { throw Error('No input should be requested') })
  assert.equal(report.ok, false)
  assert.match(report.error, /cold empty workbench/)
  assert.equal(report.transport, 'local-wasm-in-browser')
  assert.deepEqual([...report.finalTabIds], ['user-unsaved-work'])
  assert.equal(report.cleanup.attempted, 0)
  assert.ok(h.calls.every(([name]) => name === 'stage'))
  assert.equal(h.listeners.size, 0)
})
