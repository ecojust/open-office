import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import { bytesToBase64, base64ToBytes } from '../src/shared/document.ts'

const source = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function fallback() {
  const sizes = { encoded: [], decoded: [] }, module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports,
    btoa(value) { sizes.encoded.push(value.length); return btoa(value) },
    atob(value) { sizes.decoded.push(value.length); return atob(value) },
  })
  vm.runInContext('Uint8Array.fromBase64 = undefined; Uint8Array.prototype.toBase64 = undefined', context)
  vm.runInContext(compiled, context)
  return { ...module.exports, sizes, bytes: value => vm.runInContext(`new Uint8Array(${JSON.stringify(Array.from(value))})`, context) }
}

test('binary helpers preserve exact bytes, including chunk boundaries and subarray offsets', () => {
  for (const size of [0, 1, 2, 3, 24575, 24576, 24577, 32768, 65537, 2 * 1024 * 1024 + 1]) {
    const source = Uint8Array.from({ length: size + 9 }, (_, i) => (i * 73) % 256).subarray(7, 7 + size)
    const expected = Buffer.from(source).toString('base64')
    assert.equal(bytesToBase64(source), expected)
    assert.deepEqual(base64ToBytes(expected), source)
  }
})

test('older WebKit fallback bounds every binary-string conversion without corrupting padding', () => {
  const f = fallback(), source = Uint8Array.from({ length: 100003 }, (_, i) => i % 256)
  const expected = Buffer.from(source).toString('base64')
  assert.equal(f.bytesToBase64(f.bytes(source)), expected)
  assert.deepEqual(Array.from(f.base64ToBytes(expected)), Array.from(source))
  assert.ok(f.sizes.encoded.length > 1 && f.sizes.encoded.every(size => size <= 24576))
  assert.ok(f.sizes.decoded.length > 1 && f.sizes.decoded.every(size => size <= 32768))
  for (const input of ['', 'YQ', 'YQ==', 'YWI', 'YWI=', 'Y W\nJ\tj\r\fZA==']) {
    assert.equal(Buffer.from(f.base64ToBytes(input)).toString('binary'), atob(input))
  }
})

test('invalid encoded files fail before producing a partial decoded document', () => {
  const f = fallback()
  for (const input of ['A', 'a===', 'AA=', '===', 'AA==AAAA', 'AA-_', 'AA\u00a0==', '=']) {
    assert.throws(() => base64ToBytes(input))
    assert.throws(() => f.base64ToBytes(input))
  }
})
