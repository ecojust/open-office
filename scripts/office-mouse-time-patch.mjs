/**
 * Deterministic, version-pinned correction of one native mouse timestamp cast.
 * No file/network writes, office execution, global clock changes or imports.
 * Provenance and source-equivalent change: vendor/patches/office-mouse-time.md.
 */
import { createHash } from 'node:crypto'

export const MOUSE_TIME_PATCH = Object.freeze({
  id: 'qt-wasm-mouse-time-u64-wrap-v1',
  source: Object.freeze({ bytes: 161667499, sha256: '9ebd9a487e849a24b9c69f843ebdb451709c27b7722c010e36846433474a5bd4' }),
  output: Object.freeze({ bytes: 161667500, sha256: '56a2f4f43d0c5dbe45937054833d1946383bd07f1017d359d0efe7f4c9d85dd0' }),
  sourceBodySha256: 'b1c4989d454f76eeee543176ba12b7b55db6b54108142673c0ad7569dd5a374c',
  patchedBodySha256: '55c0db0f6cea8766245f33e9b77deb31338070e1025e8dab1ce1e976943d0ee0',
  registrationBodySha256: 'dc9a9d54613020a9ca9e346d630ef505a570ad4ba7e502d548526422a4211731',
  callbackFunction: 221801,
  registrationFunction: 221638,
  callbackTableEntry: 270150,
  bodyPatch: Object.freeze({
    offset: 2575,
    // block i32; guarded truncation; fallback zero. Local 18 holds date_now().
    sourceHex: '027f201244000000000000f041632012440000000000000000667104402012ab0c010b41000b',
    outputHex: '027f201244000000000000f043632012440000000000000000667104402012b1a70c010b41000b',
  }),
})

const MAGIC = Buffer.from('0061736d01000000', 'hex')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function check(condition, message) {
  if (!condition) throw Error(`Office mouse timestamp patch: ${message}`)
}
function uleb(value) {
  check(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, 'invalid unsigned section length')
  const bytes = []
  do { const low = value % 128; value = Math.floor(value / 128); bytes.push(low | (value ? 128 : 0)) } while (value)
  return Buffer.from(bytes)
}

// A bounded reader for this pinned module, not a permissive generic WASM parser.
class Reader {
  constructor(bytes, start = 0, end = bytes.length) { this.bytes = bytes; this.pos = start; this.end = end }
  byte() { check(this.pos < this.end, 'truncated WASM section'); return this.bytes[this.pos++] }
  take(length) {
    check(Number.isInteger(length) && length >= 0 && this.pos + length <= this.end, 'out-of-bounds WASM section')
    const value = this.bytes.subarray(this.pos, this.pos + length); this.pos += length; return value
  }
  u32() {
    const start = this.pos; let value = 0
    for (let index = 0; index < 5; index++) {
      const byte = this.byte(); value += (byte & 127) * 2 ** (index * 7)
      if (!(byte & 128)) {
        check(value <= 0xffffffff && this.bytes.subarray(start, this.pos).equals(uleb(value)), 'noncanonical/overflowing unsigned LEB')
        return value
      }
    }
    throw Error('Office mouse timestamp patch: unterminated unsigned LEB')
  }
  i32() {
    let value = 0; let bits = 0
    for (let index = 0; index < 5; index++) {
      const byte = this.byte(); value += (byte & 127) * 2 ** bits; bits += 7
      if (!(byte & 128)) {
        if (byte & 64) value -= 2 ** bits
        check(value >= -0x80000000 && value <= 0x7fffffff, 'overflowing signed LEB')
        return value
      }
    }
    throw Error('Office mouse timestamp patch: unterminated signed LEB')
  }
  name() { return this.take(this.u32()).toString('utf8') }
  done() { check(this.pos === this.end, 'unexpected trailing section data') }
}

function readSections(bytes) {
  check(bytes.subarray(0, 8).equals(MAGIC), 'not a WASM v1 module')
  const reader = new Reader(bytes, 8); const sections = new Map()
  while (reader.pos < reader.end) {
    const start = reader.pos; const id = reader.byte(); const size = reader.u32(); const payload = reader.pos
    reader.take(size)
    check(id <= 13 && (id === 0 || !sections.has(id)), 'duplicate or unknown WASM section')
    if (id !== 0) sections.set(id, { id, start, payload, size, end: reader.pos })
  }
  return sections
}
function sectionReader(bytes, sections, id) {
  const section = sections.get(id); check(section, `missing section ${id}`)
  return new Reader(bytes, section.payload, section.end)
}
function readLimits(reader) {
  const flags = reader.u32(); check(flags <= 3, 'unsupported limits in pinned module')
  reader.u32(); if (flags & 1) reader.u32()
}
function exactBytes(actual, offset, hex, label) {
  const expected = Buffer.from(hex, 'hex')
  check(actual.subarray(offset, offset + expected.length).equals(expected), `${label} does not match pinned instructions`)
}

function inspectKnown(bytes, state) {
  const sections = readSections(bytes)
  const typeReader = sectionReader(bytes, sections, 1); const types = []
  for (let count = typeReader.u32(); count > 0; count--) {
    check(typeReader.byte() === 0x60, 'unexpected non-function type')
    const params = [...typeReader.take(typeReader.u32())]; const results = [...typeReader.take(typeReader.u32())]
    types.push({ params, results })
  }
  typeReader.done()
  const importReader = sectionReader(bytes, sections, 2); const imports = []
  for (let count = importReader.u32(); count > 0; count--) {
    const module = importReader.name(); const name = importReader.name(); const kind = importReader.byte()
    if (kind === 0) imports.push({ module, name, type: importReader.u32() })
    else if (kind === 1) { check(importReader.byte() === 0x70, 'unexpected table type'); readLimits(importReader) }
    else if (kind === 2) readLimits(importReader)
    else if (kind === 3) importReader.take(2)
    else if (kind === 4) { check(importReader.byte() === 0, 'unexpected tag kind'); importReader.u32() }
    else check(false, 'unexpected import kind')
  }
  importReader.done()
  check(imports.length === 325, 'imported function count changed')
  for (const [index, name, type] of [
    [62, 'emscripten_set_mousedown_callback_on_thread', 10],
    [63, 'emscripten_set_mouseup_callback_on_thread', 10],
    [64, 'emscripten_set_mousemove_callback_on_thread', 10],
    [71, 'emscripten_date_now', 137],
  ]) {
    check(imports[index]?.module === 'env' && imports[index]?.name === name && imports[index]?.type === type, `import ${index} binding changed`)
  }
  check(JSON.stringify(types[137]) === '{"params":[],"results":[124]}', 'date_now signature changed')
  const functionReader = sectionReader(bytes, sections, 3); const functions = []
  for (let count = functionReader.u32(); count > 0; count--) functions.push(functionReader.u32())
  functionReader.done()
  check(functions.length === 223522 && functions[221801 - imports.length] === 5 && functions[221638 - imports.length] === 1, 'native callback function types changed')
  check(JSON.stringify(types[5]) === '{"params":[127,127,127],"results":[127]}', 'mouse callback signature changed')
  check(JSON.stringify(types[1]) === '{"params":[127,127],"results":[]}', 'registration function signature changed')
  const elements = sectionReader(bytes, sections, 9); let callback = null
  for (let count = elements.u32(); count > 0; count--) {
    check(elements.u32() === 0 && elements.byte() === 0x41, 'unexpected element segment in pinned module')
    const base = elements.i32(); check(base >= 0 && elements.byte() === 0x0b, 'unexpected element base expression')
    for (let length = elements.u32(), index = 0; index < length; index++) {
      const fn = elements.u32()
      if (base + index === MOUSE_TIME_PATCH.callbackTableEntry) {
        check(callback === null, 'duplicate callback table entry'); callback = fn
      }
    }
  }
  elements.done(); check(callback === MOUSE_TIME_PATCH.callbackFunction, 'mouse callback table binding changed')
  const code = sections.get(10); const bodies = new Map(); const codeReader = sectionReader(bytes, sections, 10)
  const count = codeReader.u32(); check(count === functions.length, 'code/function count mismatch')
  for (let index = 0; index < count; index++) {
    const sizePrefix = codeReader.pos; const length = codeReader.u32(); const start = codeReader.pos
    codeReader.take(length)
    if (index + imports.length === 221638 || index + imports.length === 221801) {
      bodies.set(index + imports.length, { sizePrefix, start, end: codeReader.pos, length })
    }
  }
  codeReader.done()
  const mouse = bodies.get(221801); const registration = bodies.get(221638)
  check(mouse && registration, 'native mouse functions absent')
  const mouseBytes = bytes.subarray(mouse.start, mouse.end); const registrationBytes = bytes.subarray(registration.start, registration.end)
  const patched = state === 'output'
  check(mouse.length === (patched ? 3300 : 3299) && sha256(mouseBytes) === (patched ? MOUSE_TIME_PATCH.patchedBodySha256 : MOUSE_TIME_PATCH.sourceBodySha256), 'mouse function body hash changed')
  check(registration.length === 3032 && sha256(registrationBytes) === MOUSE_TIME_PATCH.registrationBodySha256, 'registration function body hash changed')
  // Full-body hashes and prior disassembly pin these as decoded instructions,
  // not arbitrary byte-pattern matches elsewhere in the file.
  for (const [offset, call] of [[1303, '3e'], [1324, '3f'], [1345, '40']]) {
    exactBytes(registrationBytes, offset, `410141c6be10410210${call}`, 'registered mouse callback')
  }
  exactBytes(mouseBytes, 17, '10472112', 'date_now call and local')
  exactBytes(mouseBytes, MOUSE_TIME_PATCH.bodyPatch.offset, patched ? MOUSE_TIME_PATCH.bodyPatch.outputHex : MOUSE_TIME_PATCH.bodyPatch.sourceHex, 'timestamp cast')
  exactBytes(mouseBytes, 3103 + Number(patched), '2004360218', 'native timestamp store')
  return { state, code, mouse, sections }
}

function inspect(bytes) {
  check(Buffer.isBuffer(bytes), 'expected a Buffer')
  const state = ['source', 'output'].find(key => bytes.length === MOUSE_TIME_PATCH[key].bytes)
  check(state, 'unknown source/output length; only the pinned runtime is accepted')
  check(sha256(bytes) === MOUSE_TIME_PATCH[state].sha256, 'unknown source/output hash; refusing to patch an unverified runtime')
  return inspectKnown(bytes, state)
}

/** Check exact whole-file/body hashes and import/table/registration bindings. */
export function inspectOfficeMouseTime(bytes) {
  const result = inspect(bytes)
  return Object.freeze({ state: result.state, patchId: MOUSE_TIME_PATCH.id, ...MOUSE_TIME_PATCH[result.state] })
}

/** Return the verified derived Buffer; an already verified output is unchanged. */
export function patchOfficeMouseTime(bytes) {
  const { state, code, mouse } = inspect(bytes)
  if (state === 'output') return bytes
  const from = Buffer.from(MOUSE_TIME_PATCH.bodyPatch.sourceHex, 'hex')
  const to = Buffer.from(MOUSE_TIME_PATCH.bodyPatch.outputHex, 'hex')
  const offset = mouse.start + MOUSE_TIME_PATCH.bodyPatch.offset
  const body = Buffer.concat([bytes.subarray(mouse.start, offset), to, bytes.subarray(offset + from.length, mouse.end)])
  const newBodySize = uleb(body.length)
  const codeDelta = body.length - mouse.length + newBodySize.length - (mouse.start - mouse.sizePrefix)
  const output = Buffer.concat([
    bytes.subarray(0, code.start + 1), uleb(code.size + codeDelta),
    bytes.subarray(code.payload, mouse.sizePrefix), newBodySize, body,
    bytes.subarray(mouse.end),
  ])
  // Reparse the output and verify its separately pinned digest, never trust a
  // successful Buffer edit or a caller-supplied expected hash as verification.
  check(inspect(output).state === 'output', 'derived output failed self-verification')
  return output
}
