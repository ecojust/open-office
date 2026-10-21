import test from 'node:test'
import assert from 'node:assert/strict'
import { tool, validateToolArguments } from '../src/mcp/tool-schema.ts'

const schema = tool('canvas_edit', 'Edit canvas', false, {
  operations: { type: 'array', minItems: 1, maxItems: 3, items: {
    type: 'object', required: ['kind', 'values'], additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['write', 'clear'] },
      values: { type: 'array', items: { anyOf: [{ type: 'string', maxLength: 20 }, { type: 'number', minimum: 0 }, { type: 'boolean' }, { type: 'null' }] } },
      target: { type: ['string', 'null'] },
    },
  } },
}, ['operations']).inputSchema

test('structured edit arguments validate nested arrays, unions, enums, null and booleans without mutating input', () => {
  const args = { operations: [{ kind: 'write', values: ['title', 4.5, true, null], target: null }] }
  const result = validateToolArguments(schema, args)
  assert.deepEqual(result, args)
  result.operations[0].values.push('new')
  assert.equal(args.operations[0].values.length, 4)
  assert.equal(validateToolArguments(schema, { operations: [{ kind: 'write', values: ['line\u000bnext'] }] }).operations[0].values[0], 'line\u000bnext')
})

test('invalid nested operations are rejected before any document mutation', () => {
  for (const args of [
    { operations: [] }, { operations: [{ kind: 'unknown', values: [] }] },
    { operations: [{ kind: 'write', values: [-1] }] },
    { operations: [{ kind: 'write', values: ['x'.repeat(21)] }] },
    { operations: [{ kind: 'write', values: [{}] }] },
    { operations: [{ kind: 'write', values: [], target: 2 }] },
    { operations: [{ kind: 'write', values: [], extra: 1 }] },
    { operations: [{ kind: 'write' }] },
    { operations: Array(4).fill({ kind: 'clear', values: [] }) },
  ]) assert.throws(() => validateToolArguments(schema, args), /MCP/)
})

test('open engine params remain JSON-only and bounded with prototype keys rejected recursively', () => {
  const engine = tool('word_execute_command', 'Execute', false, { params: { type: 'object', additionalProperties: true } }).inputSchema
  for (const params of [
    { n: Infinity }, { n: NaN }, { fn: () => {} }, { bad: undefined }, { date: new Date() },
    { x: JSON.parse('{"__proto__":{"polluted":true}}') },
    JSON.parse('{"format":{"constructor":{"prototype":{"polluted":true}}}}'),
    { text: '\u0000' }, { binary: new Uint8Array([1, 2]) },
  ]) assert.throws(() => validateToolArguments(engine, { params }), /MCP/)
  let nested = {}
  for (let i = 0; i < 40; i++) nested = { nested }
  assert.throws(() => validateToolArguments(engine, { params: nested }), /嵌套/)
  assert.throws(() => validateToolArguments(engine, { params: { values: Array(100001).fill(0) } }), /集合/)
  assert.throws(() => validateToolArguments(engine, { params: { image: '中'.repeat(3 * 1024 * 1024) } }), /7 MiB/)
  const image = 'a'.repeat(2 * 1024 * 1024)
  assert.equal(validateToolArguments(engine, { params: { image } }).params.image.length, image.length)
  assert.equal({}.polluted, undefined)
})

test('schema composition and destructive command hints describe actual edit capability', () => {
  const composed = { type: 'object', additionalProperties: false, properties: {
    n: { allOf: [{ type: 'number', exclusiveMinimum: 1 }, { maximum: 9 }] },
    mode: { oneOf: [{ const: 'single' }, { const: 'batch' }] },
  } }
  assert.deepEqual(validateToolArguments(composed, { n: 2, mode: 'batch' }), { n: 2, mode: 'batch' })
  for (const args of [{ n: 1 }, { n: 10 }, { mode: 'other' }]) assert.throws(() => validateToolArguments(composed, args))
  assert.equal(tool('word_execute_command', '', false).annotations.destructiveHint, true)
  assert.equal(tool('note_edit', '', false).annotations.destructiveHint, true)
  assert.equal(tool('word_list_commands', '', true).annotations.destructiveHint, false)
})
