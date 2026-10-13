import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { inspectPptxZip, PPTX_LIMITS } from '../src/presentation/pptx-package.ts'
const small = () => zipSync({ 'ppt/presentation.xml': strToU8('<presentation/>'), 'readme.txt':strToU8('preserved') })
const centralOffset = bytes => new DataView(bytes.buffer, bytes.byteOffset).getUint32(bytes.length - 6, true)
const rejected = (bytes, code) => assert.throws(() => inspectPptxZip(bytes), error => error.code === code)
test('ZIP inspection accepts actual bounded stored and deflated entries without decompression', () => {
  const data = small(), result = inspectPptxZip(data)
  assert.deepEqual(result.entries.map(e => e.name), ['ppt/presentation.xml','readme.txt'])
  assert.equal(result.expandedBytes, 24); assert.ok(result.entries.every(e => !e.data))
})
test('ZIP package rejects traversal and ambiguous case-folded filenames', () => {
  rejected(zipSync({'../outside': strToU8('bad')}), 'ZIP_PATH')
  rejected(zipSync({'ppt/A.xml':strToU8('a'),'ppt/a.xml':strToU8('b')}), 'ZIP_DUPLICATE')
  rejected(zipSync({'C:/outside':strToU8('bad')}), 'ZIP_PATH')
})
test('ZIP package rejects forged large expansion before allocating any member', () => {
  const data = small(), view = new DataView(data.buffer)
  view.setUint32(centralOffset(data) + 24, PPTX_LIMITS.mediaBytes + 1, true)
  rejected(data, 'ZIP_EXPANSION')
})
test('ZIP package rejects encrypted entries, symlinks and mismatched local headers', () => {
  let data = small(); new DataView(data.buffer).setUint16(centralOffset(data) + 8, 1, true); rejected(data, 'ZIP_UNSUPPORTED')
  data = small(); new DataView(data.buffer).setUint32(centralOffset(data) + 38, 0xa1ff0000, true); rejected(data, 'ZIP_SYMLINK')
  data = small(); data[30] ^= 1; rejected(data, 'ZIP_INVALID')
})
test('ZIP truncated or non-ZIP input and data overlapping central directory are rejected', () => {
  rejected(new Uint8Array(100), 'ZIP_INVALID')
  const original = small(); rejected(original.subarray(0, original.length - 3), 'ZIP_INVALID')
  const data = small(); new DataView(data.buffer).setUint32(centralOffset(data) + 20, data.length, true); rejected(data, 'ZIP_INVALID')
})
