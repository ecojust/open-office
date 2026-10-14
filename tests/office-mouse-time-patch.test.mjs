import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MOUSE_TIME_PATCH, patchOfficeMouseTime, inspectOfficeMouseTime } from '../scripts/office-mouse-time-patch.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function leb(n) {
  const result = []
  do { const b = n % 128; n = Math.floor(n / 128); result.push(b | (n ? 128 : 0)) } while (n)
  return Buffer.from(result)
}
function section(id, payload) { return Buffer.concat([Buffer.from([id]), leb(payload.length), payload]) }

function originalFromDerived(source) {
  const result = Buffer.alloc(MOUSE_TIME_PATCH.source.bytes)
  // Independently reverse the three known changed ranges. This runs only in
  // tests, never in the download/patch path, and the original digest is required.
  source.copy(result, 0, 0, 1002684)
  leb(102354131).copy(result, 1002684)
  source.copy(result, 1002688, 1002688, 102702224)
  leb(3299).copy(result, 102702224)
  source.copy(result, 102702226, 102702226, 102704801)
  Buffer.from(MOUSE_TIME_PATCH.bodyPatch.sourceHex, 'hex').copy(result, 102704801)
  source.copy(result, 102704839, 102704840)
  assert.equal(hash(result), MOUSE_TIME_PATCH.source.sha256, 'independently reconstructed upstream must match its pinned digest')
  return result
}

// Execute the exact replacement expression, with local 18 populated from the
// argument. This independent tiny module has no office imports or side effects.
function executableCast(hex) {
  const body = Buffer.concat([Buffer.from([1, 18, 0x7c, 0x20, 0, 0x21, 18]), Buffer.from(hex, 'hex'), Buffer.from([0x0b])])
  const module = Buffer.concat([
    Buffer.from('0061736d01000000', 'hex'),
    section(1, Buffer.from([1, 0x60, 1, 0x7c, 1, 0x7f])),
    section(3, Buffer.from([1, 0])),
    section(7, Buffer.from([1, 4, 0x63, 0x61, 0x73, 0x74, 0, 0])),
    section(10, Buffer.concat([Buffer.from([1]), leb(body.length), body])),
  ])
  assert.equal(WebAssembly.validate(module), true)
  const cast = new WebAssembly.Instance(new WebAssembly.Module(module)).exports.cast
  return value => cast(value) >>> 0
}
const originalCast = executableCast(MOUSE_TIME_PATCH.bodyPatch.sourceHex)
const patchedCast = executableCast(MOUSE_TIME_PATCH.bodyPatch.outputHex)
const modulus = 2 ** 32

test('the exact original mouse cast loses epoch time; the scoped replacement retains low 32 bits', () => {
  for (const epoch of [Date.UTC(2026, 9, 14), Date.UTC(2026, 9, 14) + 1337.75, Date.UTC(2040, 0, 1)]) {
    assert.equal(originalCast(epoch), 0)
    const independentlyExpected = Number(BigInt(Math.trunc(epoch)) & 0xffffffffn)
    assert.equal(patchedCast(epoch), independentlyExpected)
    assert.notEqual(patchedCast(epoch), 0)
  }
})

test('the replacement keeps the old non-trapping zero behavior for invalid clock values', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, -0.1, -(2 ** 32), 2 ** 64, 2 ** 65]) {
    assert.equal(patchedCast(value), 0, String(value))
    assert.equal(originalCast(value), 0, String(value))
  }
})

test('valid fractional/zero values truncate and unsigned 32-bit boundary values wrap', () => {
  for (const [value, expected] of [
    [-0, 0], [0, 0], [0.999, 0], [1.999, 1], [modulus - 0.25, 0xffffffff],
    [modulus, 0], [modulus + 1, 1], [2 * modulus + 13.75, 13], [2 ** 64 - 2048, 0xfffff800],
  ]) assert.equal(patchedCast(value), expected, String(value))
})

test('mouse time differences survive epoch truncation and unsigned wrap without changing wall time', () => {
  const epoch = Date.UTC(2026, 9, 14)
  for (const delay of [1, 25, 399, 1200, 5000]) {
    assert.equal((patchedCast(epoch + delay) - patchedCast(epoch)) >>> 0, delay)
  }
  assert.equal((patchedCast(400 * modulus + 50) - patchedCast(400 * modulus - 25)) >>> 0, 75)
  // No import, Date.now, performance.now or other application's clock is patched.
  const originalDateNow = Date.now; const before = originalDateNow()
  patchedCast(before)
  assert.equal(Date.now, originalDateNow)
  assert.ok(Date.now() >= before)
})

test('unknown, truncated and non-Buffer inputs cannot be silently patched', () => {
  for (const value of [null, new Uint8Array(8), Buffer.from('0061736d01000000', 'hex'), Buffer.alloc(0)]) {
    assert.throws(() => patchOfficeMouseTime(value), /Office mouse timestamp patch:/)
    assert.throws(() => inspectOfficeMouseTime(value), /Office mouse timestamp patch:/)
  }
})

test('pinned actual runtime is transformed once, preserving every non-target byte and validating the full module', async t => {
  let source
  try { source = await readFile(new URL('../public/office-runtime/soffice.wasm', import.meta.url)) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    t.skip('The full pinned office runtime is not present; fetch it for the full-binary regression. Tiny WASM boundary tests above still run.')
    return
  }
  // Runtime fetch may already have installed the verified derived asset. Restore
  // the source in memory only so the same test exercises actual transformation.
  const supplied = inspectOfficeMouseTime(source)
  if (supplied.state === 'output') source = originalFromDerived(source)
  assert.equal(inspectOfficeMouseTime(source).state, 'source')
  const output = patchOfficeMouseTime(source)
  assert.notEqual(source, output)
  assert.equal(hash(source), MOUSE_TIME_PATCH.source.sha256, 'input was not changed')
  assert.equal(output.length, MOUSE_TIME_PATCH.output.bytes)
  assert.equal(hash(output), MOUSE_TIME_PATCH.output.sha256)
  assert.equal(hash(originalFromDerived(output)), hash(source), 'the already-derived asset path is also reproducible')
  assert.equal(inspectOfficeMouseTime(output).state, 'output')
  assert.equal(patchOfficeMouseTime(output), output, 'idempotent verified output needs no allocation')
  assert.equal(WebAssembly.validate(source), true, 'the pinned module must be supported by this validation environment')
  assert.equal(WebAssembly.validate(output), true, 'the complete derived module must remain valid')
  // Original sections/body prefix lengths were independently recorded by the
  // research parser, not obtained from the transformation under test.
  assert.deepEqual(output.subarray(0, 1002684), source.subarray(0, 1002684))
  assert.deepEqual(output.subarray(1002688, 102702224), source.subarray(1002688, 102702224))
  assert.deepEqual(output.subarray(102702226, 102704801), source.subarray(102702226, 102704801))
  assert.deepEqual(output.subarray(102704840), source.subarray(102704839))
  assert.equal(output.subarray(102704801, 102704840).toString('hex'), MOUSE_TIME_PATCH.bodyPatch.outputHex)
  for (const [bytes, offset] of [[source, 102704832], [source, 102638370 + 1303], [output, 102704833], [output, output.length - 1]]) {
    bytes[offset] ^= 1
    try {
      assert.throws(() => patchOfficeMouseTime(bytes), /unknown source\/output hash/)
      assert.throws(() => inspectOfficeMouseTime(bytes), /unknown source\/output hash/)
    } finally { bytes[offset] ^= 1 }
  }
  assert.equal(hash(source), MOUSE_TIME_PATCH.source.sha256)
  assert.equal(hash(output), MOUSE_TIME_PATCH.output.sha256)
})
