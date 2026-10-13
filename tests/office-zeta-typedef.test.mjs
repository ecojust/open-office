import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

// Execute the shipped translation functions with owned Embind-handle doubles.
// Native Writer/Calc probes separately verify these types against real WASM.
const source = await readFile(new URL('../public/office/zeta.js', import.meta.url), 'utf8')
const start = source.indexOf('    function translateTypeDescription(td) {')
const end = source.indexOf('    function translateToEmbind(', start)
assert.ok(start >= 0 && end > start)
const translation = source.slice(start, end)

function environment() {
  const handles = [], classes = Object.fromEntries(['VOID','BOOLEAN','BYTE','SHORT','UNSIGNED_SHORT','LONG','UNSIGNED_LONG','HYPER','UNSIGNED_HYPER','FLOAT','DOUBLE','CHAR','STRING','TYPE','ANY','TYPEDEF','SEQUENCE','ENUM','STRUCT','EXCEPTION','INTERFACE','UNKNOWN'].map(name => [name, { name }]))
  function owned(label, methods = {}) {
    const handle = { label, deleted: 0, ...methods, delete() { this.deleted++; assert.equal(this.deleted, 1, `${label} must be released once`) } }
    handles.push(handle); return handle
  }
  function descriptor(kind, name, referenced, failure) {
    return owned(`description:${name}`, { kind, referenced, failure, getTypeClass: () => classes[kind], getName: () => name })
  }
  const types = new Proxy({}, { get(_target, key) {
    return argument => owned(`type:${String(key)}`, { type: key, ...(key === 'Sequence' ? { component: argument.type } : { name: argument }) })
  } })
  const Module = { uno_Type: types, uno: { com: { sun: { star: { uno: { TypeClass: classes }, reflection: {
    XIndirectTypeDescription: { query(td) { return owned(`indirect:${td.getName()}`, { getReferencedType() { if (td.failure) throw td.failure; return td.referenced } }) } },
  } } } } } }
  const context = vm.createContext({ Module, Error })
  vm.runInContext(`${translation}\nthis.translate=translateTypeDescription;this.consume=translateTypeDescriptionAndDelete`, context)
  function releasedExcept(result) { for (const handle of handles) assert.equal(handle.deleted, handle === result ? 0 : 1, handle.label) }
  return { descriptor, consume: context.consume, translate: context.translate, releasedExcept, handles }
}

test('UNO Color typedef resolves to owned Long without inventing a sequence', () => {
  const e = environment(), color = e.descriptor('TYPEDEF', 'com.sun.star.util.Color', e.descriptor('LONG', 'long'))
  const type = e.consume(color)
  assert.equal(type.type, 'Long')
  assert.equal(e.handles.some(handle => handle.type === 'Sequence'), false)
  e.releasedExcept(type); type.delete(); e.releasedExcept()
})

test('nested typedefs resolve recursively, and the caller still owns the returned type', () => {
  const e = environment(), alias = e.descriptor('TYPEDEF', 'OuterColor', e.descriptor('TYPEDEF', 'InnerColor', e.descriptor('LONG', 'long')))
  const type = e.consume(alias)
  assert.equal(type.type, 'Long'); e.releasedExcept(type)
  type.delete(); e.releasedExcept()
})

for (const aliasOutside of [false, true]) test(`typedef ${aliasOutside ? 'of a sequence' : 'inside a sequence'} preserves the underlying type shape and ownership`, () => {
  const e = environment(), scalar = e.descriptor('LONG', 'long')
  const description = aliasOutside
    ? e.descriptor('TYPEDEF', 'Colors', e.descriptor('SEQUENCE', '[]long', scalar))
    : e.descriptor('SEQUENCE', '[]Color', e.descriptor('TYPEDEF', 'Color', scalar))
  const type = e.consume(description)
  assert.equal(type.type, 'Sequence'); assert.equal(type.component, 'Long')
  assert.equal(e.handles.filter(handle => handle.type === 'Sequence').length, 1)
  e.releasedExcept(type); type.delete(); e.releasedExcept()
})

test('unsupported referenced types propagate their real error while releasing every description', () => {
  const e = environment(), alias = e.descriptor('TYPEDEF', 'Alias', e.descriptor('UNKNOWN', 'UnsupportedTarget'))
  assert.throws(() => e.consume(alias), /bad type description UnsupportedTarget/)
  e.releasedExcept()
})

test('a failing referenced-type lookup releases both the queried interface and owned alias', () => {
  const e = environment(), failure = Error('native referenced-type lookup failed')
  const alias = e.descriptor('TYPEDEF', 'BrokenAlias', null, failure)
  assert.throws(() => e.consume(alias), error => error === failure)
  e.releasedExcept()
})

test('the non-consuming translator does not delete its caller-owned alias description', () => {
  const e = environment(), alias = e.descriptor('TYPEDEF', 'Color', e.descriptor('LONG', 'long'))
  const type = e.translate(alias)
  assert.equal(alias.deleted, 0)
  alias.delete(); e.releasedExcept(type); type.delete(); e.releasedExcept()
})

test('the redistributed bridge remains pinned with its upstream copyright and modification notice', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/legal/corresponding-sources-manifest.json', import.meta.url), 'utf8'))
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.zetaJsShippedSha256)
  const license = await readFile(new URL('../public/legal/ZETAJS-MIT.txt', import.meta.url), 'utf8')
  assert.match(license, /2024 allotropia software GmbH and contributors/)
  for (const path of ['../THIRD_PARTY_NOTICES.md','../public/legal/THIRD_PARTY_NOTICES.md']) assert.match(await readFile(new URL(path, import.meta.url), 'utf8'), /TYPEDEF/)
  assert.match(await readFile(new URL('../public/legal/zetajs-local-change.patch', import.meta.url), 'utf8'), /TypeClass\.TYPEDEF/)
})
