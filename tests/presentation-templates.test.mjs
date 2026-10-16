import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/presentation/templates.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const pptx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255])
const base64 = Buffer.from(pptx).toString('base64')
const builtin = { id: 'blueprint', name: '蓝图', description: '项目方案', accent: '#4576ce', slideCount: 3, file: 'blueprint.pptx', preview: 'blueprint.svg' }

function api(overrides = {}) {
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports, URL, Uint8Array, ArrayBuffer, atob, btoa,
    document: { baseURI: 'https://local.example/office/index.html' },
    require: path => { assert.equal(path, '../shared/id'); return { createId: () => 'test-id' } },
    ...overrides,
  })
  vm.runInContext(compiled, context)
  return module.exports
}

test('template titles trim outer whitespace, preserve Unicode, and limit characters rather than UTF-16 units', () => {
  const { normalizePresentationTemplateName: normalize } = api()
  assert.equal(normalize('  秋季 · 项目方案 \n'), '秋季 · 项目方案')
  assert.equal(normalize('📝'.repeat(60)), '📝'.repeat(60))
  for (const value of ['', ' \n\t', null, undefined]) assert.throws(() => normalize(value), /请输入模板名称/)
  for (const value of ['字'.repeat(61), '📝'.repeat(61)]) assert.throws(() => normalize(value), /不能超过 60/)
})

test('invalid titles, slide counts, and document bytes fail before accessing storage', async () => {
  let opens = 0
  const templates = api({ indexedDB: { open() { opens++; assert.fail('Invalid input must not open storage') } } })
  await assert.rejects(templates.savePresentationTemplate({ name: ' ', slideCount: 3, base64 }), /请输入模板名称/)
  for (const slideCount of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(templates.savePresentationTemplate({ name: '模板', slideCount, base64 }), /至少需要一页/)
  }
  for (const invalid of ['', 'abc', '!!!!', 'P=AB', 'UEsDBA=!', 'aGVsbG8=']) {
    await assert.rejects(templates.savePresentationTemplate({ name: '模板', slideCount: 3, base64: invalid }), /模板.*(数据|PPTX)/)
  }
  assert.equal(opens, 0)
})

test('oversized documents fail before base64 decoding or database writes', async () => {
  const templates = api({ atob() { assert.fail('Do not allocate decoded data over the limit') } })
  const oversized = 'A'.repeat(4 * Math.ceil((templates.MAX_PRESENTATION_TEMPLATE_BYTES + 1) / 3))
  await assert.rejects(templates.savePresentationTemplate({ name: '过大模板', slideCount: 3, base64: oversized }), /不能超过 40 MB/)
})

test('missing and denied storage report a recoverable Chinese error', async () => {
  for (const indexedDB of [undefined, { open() { throw Object.assign(new Error('Denied'), { name: 'SecurityError' }) } }]) {
    await assert.rejects(api({ indexedDB }).savePresentationTemplate({ name: '模板', slideCount: 3, base64 }), /打开模板库失败.*存储权限/)
  }
})

test('built-in assets resolve beneath the application base path and keep their document bytes', async () => {
  const requested = []
  const templates = api({ fetch: async url => {
    requested.push(String(url))
    return String(url).endsWith('manifest.json')
      ? { ok: true, json: async () => [builtin] }
      : { ok: true, headers: new Headers(), arrayBuffer: async () => pptx.buffer }
  } })
  const result = await templates.loadPresentationTemplate({ id: builtin.id, source: 'builtin' })
  assert.equal(result.base64, base64)
  assert.deepEqual(requested, [
    'https://local.example/office/presentation-templates/manifest.json',
    'https://local.example/office/presentation-templates/blueprint.pptx',
  ])
})

test('invalid built-in manifests cannot fetch remote or parent-directory documents', async () => {
  const invalid = [
    [{ ...builtin, file: '../secret.pptx' }],
    [{ ...builtin, file: 'https://elsewhere.example/demo.pptx' }],
    [{ ...builtin, preview: '../../logo.svg' }],
    [{ ...builtin, id: 'custom-stolen' }],
    [{ ...builtin, accent: 'red' }],
    [{ ...builtin, slideCount: 0 }],
    [builtin, builtin], [], {},
  ]
  for (const manifest of invalid) {
    let requests = 0
    const templates = api({ fetch: async () => { requests++; return { ok: true, json: async () => manifest } } })
    await assert.rejects(templates.loadPresentationTemplate({ id: builtin.id, source: 'builtin' }), /读取内置模板失败/)
    assert.equal(requests, 1)
  }
})

test('a failed manifest read is retryable, and missing or oversized assets are reported', async () => {
  let requests = 0
  const templates = api({ fetch: async url => {
    requests++
    if (requests === 1) throw new Error('temporary failure')
    return String(url).endsWith('manifest.json')
      ? { ok: true, json: async () => [builtin] }
      : { ok: false }
  } })
  await assert.rejects(templates.loadPresentationTemplate({ id: builtin.id, source: 'builtin' }), /读取内置模板失败/)
  await assert.rejects(templates.loadPresentationTemplate({ id: builtin.id, source: 'builtin' }), /读取内置模板文件失败/)
  assert.equal(requests, 3)
  const tooLarge = api({ fetch: async url => String(url).endsWith('manifest.json')
    ? { ok: true, json: async () => [builtin] }
    : { ok: true, headers: new Headers({ 'content-length': String(41 * 1024 * 1024) }), arrayBuffer() { assert.fail('Do not load an oversized response') } },
  })
  await assert.rejects(tooLarge.loadPresentationTemplate({ id: builtin.id, source: 'builtin' }), /读取内置模板文件失败/)
})

test('built-in templates cannot be deleted, and forged custom identifiers cannot read data', async () => {
  const templates = api()
  await assert.rejects(templates.deletePresentationTemplate('blueprint'), /内置模板不能删除/)
  await assert.rejects(templates.loadPresentationTemplate({ id: 'blueprint', source: 'custom' }), /自定义模板标识无效/)
})
