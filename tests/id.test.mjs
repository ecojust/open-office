import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/shared/id.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function generator(crypto) {
  const module = { exports: {} }, context = vm.createContext({ module, exports: module.exports, crypto })
  vm.runInContext('Math.random = () => { throw Error("Insecure randomness must never be used") }', context)
  vm.runInContext(compiled, context)
  return module.exports.createId
}

test('secure-context UUID generation preserves the native method receiver and avoids the fallback', () => {
  const expected = '260ebfdc-7a0d-4a6b-b851-bfc6f6930d1e'
  const provider = {
    randomUUID() { assert.equal(this, provider); return expected },
    getRandomValues() { assert.fail('Native randomUUID should be preferred') },
  }
  assert.equal(generator(provider)(), expected)
})

test('LAN HTTP fallback preserves random bytes while setting RFC 4122 version and variant bits', () => {
  let seed = 0, calls = 0
  const provider = { getRandomValues(bytes) {
    assert.equal(this, provider); assert.equal(bytes.byteLength, 16); calls++
    for (let index = 0; index < bytes.length; index++) bytes[index] = seed + index
    seed = 240
    return bytes
  } }
  const createId = generator(provider)
  assert.equal(createId(), '00010203-0405-4607-8809-0a0b0c0d0e0f')
  assert.equal(createId(), 'f0f1f2f3-f4f5-46f7-b8f9-fafbfcfdfeff')
  assert.equal(calls, 2, 'Each identifier requests fresh cryptographic bytes')
})

test('missing or failed cryptographic randomness fails without a Math.random fallback', () => {
  for (const provider of [undefined, null, {}, { randomUUID: undefined, getRandomValues: undefined }]) {
    assert.throws(generator(provider), /无法生成安全标识/)
  }
  const failure = Error('Random source failed')
  assert.throws(generator({ getRandomValues() { throw failure } }), error => error === failure)
  assert.throws(generator({ randomUUID() { throw failure }, getRandomValues() { assert.fail('Do not hide a native failure') } }), error => error === failure)
})
