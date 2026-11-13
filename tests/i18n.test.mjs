import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as catalog from '../src/i18n/catalog.ts'

const { parseLocale, translate, englishMessages } = catalog

test('locale parsing retains Chinese defaults and normalizes supported English preferences', () => {
  for (const value of [undefined, null, '', 'zh-CN', 'zh', 'fr', 'invalid', 'EN']) assert.equal(parseLocale(value), 'zh-CN')
  for (const value of ['en', 'en-US', 'en-GB']) assert.equal(parseLocale(value), 'en')
})

test('translation substitutes only requested placeholders and preserves parameter content verbatim', () => {
  const source = '确定删除“{title}”？删除后可使用撤销恢复。'
  const title = '项目设置 / 删除事件 / $& / {title} / <script> / 🗂️'
  assert.equal(translate('zh-CN', source, { title }), `确定删除“${title}”？删除后可使用撤销恢复。`)
  assert.equal(translate('en', source, { title }), `Delete “${title}”? You can undo this action.`)
  assert.equal(translate('en', '{count} 个事件', { count: 0 }), '0 events')
  assert.equal(translate('en', source), 'Delete “{title}”? You can undo this action.')
  const inherited = Object.create({ title: 'must not be used' })
  assert.equal(translate('en', source, inherited), 'Delete “{title}”? You can undo this action.')
})

test('unknown text and object prototype names are safe fallback values', () => {
  for (const source of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', '用户文档 / arbitrary text', 'Before 项目设置 after']) {
    assert.equal(translate('en', source), source)
    assert.equal(translate('zh-CN', source), source)
  }
  assert.equal(translate('en', 'Unknown {name}', { name: '保留原文' }), 'Unknown 保留原文')
})

test('formatted diagnostics match complete known messages and preserve embedded document content', () => {
  const source = '“项目设置”轨道的“删除事件”与“备注”日期重叠，请调整日期或角色。半高事件也占用该日期。'
  assert.equal(translate('en', source), '“删除事件” and “备注” overlap on the “项目设置” track. Change the dates or owner. Half-height events also occupy their dates.')
  assert.equal(translate('en', 'Prefix: ' + source), 'Prefix: ' + source)
  assert.equal(translate('en', '用户事件 · 2026-11-02 — 2026-11-04 · 下午 · 高度 50%'), '用户事件 · 2026-11-02 — 2026-11-04 · Afternoon · Height 50%')
})

test('warning lists translate only when every message is known, retaining semicolons within messages', () => {
  const first = '部分颜色格式不受支持，已使用默认颜色。'
  const frame = '框架位置得到保留；frame 裁剪关系已展开。'
  const last = '纹理填充已转换为纯色填充。'
  const source = [first, frame, last].join('；')
  assert.equal(translate('en', source), [first, frame, last].map(part => translate('en', part)).join('; '))
  assert.equal(translate('zh-CN', source), source)
  const mixed = `${first}；不认识的用户文字；${last}`
  assert.equal(translate('en', mixed), mixed)
})

test('every parameterized catalog entry retains its interpolation fields', () => {
  const fields = text => [...new Set([...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map(match => match[1]))].sort()
  for (const [source, translated] of Object.entries(englishMessages)) {
    const expected = fields(source)
    // Braces in non-parameterized parser examples describe source-language syntax.
    if (expected.length) assert.deepEqual(fields(translated), expected, source)
  }
})

// Execute the real preference module with Vue's real refs/watchers and an
// isolated browser host. Each mount owns its storage, listeners and lifecycle;
// no test changes Node globals or another editor's shared locale singleton.
const preferenceSource = await readFile(new URL('../src/shared/i18n.ts', import.meta.url), 'utf8')
const preferenceCode = ts.transpileModule(preferenceSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function preferenceHost({ stored, denyRead = false, denyWrite = false, denyAccess = false } = {}) {
  const key = 'open-office.locale', values = new Map(stored === undefined ? [] : [[key, stored]]), writes = [], listeners = new Set(), cleanups = []
  const storage = {
    getItem(name) { if (denyRead) throw Error('Storage read denied'); return values.get(name) ?? null },
    setItem(name, value) { if (denyWrite) throw Error('Storage write denied'); writes.push([name, value]); values.set(name, value) },
  }
  const browserDocument = { documentElement: { lang: '' }, title: '' }
  const browserWindow = {
    get localStorage() { if (denyAccess) throw Error('Storage unavailable'); return storage },
    addEventListener(type, callback) { assert.equal(type, 'storage'); listeners.add(callback) },
    removeEventListener(type, callback) { assert.equal(type, 'storage'); listeners.delete(callback) },
  }
  const module = { exports: {} }
  vm.runInNewContext(preferenceCode, {
    module, exports: module.exports, window: browserWindow, document: browserDocument,
    require(name) {
      if (name === 'vue') return { ...vue, onBeforeUnmount(callback) { cleanups.push(callback) } }
      if (name === '../i18n/catalog.ts') return catalog
      throw Error(`Unexpected preference dependency: ${name}`)
    },
  })
  const api = module.exports, scope = vue.effectScope()
  const preference = scope.run(() => api.useLocalePreference())
  return {
    ...api, preference, values, writes, listeners, storage, document: browserDocument,
    storageEvent(event) { for (const callback of listeners) callback(event) },
    unmount() { cleanups.forEach(callback => callback()); scope.stop() },
  }
}

test('preference mount restores language, updates page metadata and persists language changes immediately', () => {
  const host = preferenceHost({ stored: 'en-US' })
  try {
    assert.equal(host.locale.value, 'en')
    assert.equal(host.document.documentElement.lang, 'en')
    assert.equal(host.document.title, 'Open Office · Local workspace')
    assert.equal(host.values.get(host.LOCALE_STORAGE_KEY), 'en')
    const label = vue.computed(() => host.t('项目设置'))
    assert.equal(label.value, 'Project settings')
    host.setLocale('zh-CN')
    assert.equal(label.value, '项目设置')
    assert.equal(host.document.documentElement.lang, 'zh-CN')
    assert.equal(host.document.title, 'Open Office · 本地办公工作空间')
    assert.equal(host.values.get(host.LOCALE_STORAGE_KEY), 'zh-CN')
    host.setLocale('en')
    assert.equal(label.value, 'Project settings')
    const reopened = preferenceHost({ stored: host.values.get(host.LOCALE_STORAGE_KEY) })
    try { assert.equal(reopened.locale.value, 'en') } finally { reopened.unmount() }
  } finally { host.unmount() }
})

test('unavailable browser storage does not prevent language changes or page metadata updates', () => {
  for (const options of [{ denyRead: true }, { denyWrite: true }, { denyAccess: true }]) {
    const host = preferenceHost(options)
    try {
      assert.equal(host.locale.value, 'zh-CN')
      host.setLocale('en')
      assert.equal(host.t('项目设置'), 'Project settings')
      assert.equal(host.document.documentElement.lang, 'en')
      assert.equal(host.document.title, 'Open Office · Local workspace')
    } finally { host.unmount() }
  }
})

test('only local language storage events synchronize the preference and removed values restore Chinese', () => {
  const host = preferenceHost()
  try {
    host.storageEvent({ key: 'unrelated.preference', newValue: 'en', storageArea: host.storage })
    assert.equal(host.locale.value, 'zh-CN')
    host.storageEvent({ key: host.LOCALE_STORAGE_KEY, newValue: 'en', storageArea: {} })
    assert.equal(host.locale.value, 'zh-CN', 'sessionStorage must not change the local preference')
    host.storageEvent({ key: host.LOCALE_STORAGE_KEY, newValue: 'en', storageArea: host.storage })
    assert.equal(host.locale.value, 'en')
    assert.equal(host.document.title, 'Open Office · Local workspace')
    host.storageEvent({ key: host.LOCALE_STORAGE_KEY, newValue: null, storageArea: host.storage })
    assert.equal(host.locale.value, 'zh-CN')
    host.setLocale('en')
    host.storageEvent({ key: null, newValue: null, storageArea: host.storage })
    assert.equal(host.locale.value, 'zh-CN', 'localStorage.clear resets the preference')
  } finally { host.unmount() }
})

test('unmount removes the storage listener and stops preference side effects', () => {
  const host = preferenceHost()
  assert.equal(host.listeners.size, 1)
  host.unmount()
  assert.equal(host.listeners.size, 0)
  const previousWrites = host.writes.length, previousTitle = host.document.title
  host.setLocale('en')
  assert.equal(host.writes.length, previousWrites)
  assert.equal(host.document.title, previousTitle)
})
