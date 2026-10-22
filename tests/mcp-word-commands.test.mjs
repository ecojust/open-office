import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWordCommands, wordQueryCommands } from '../src/mcp/word-tools.ts'
import { validateToolArguments } from '../src/mcp/tool-schema.ts'

const describe = id => describeWordCommands({ commands: [{ id, parameters: 'native engine contract' }] }).commands[0]

test('inline Word imports and style transfers expose schemas clients can use without filesystem paths', () => {
  for (const id of ['insert.textFromFile', 'insert.object', 'styles.copyFrom', 'tools.attachTemplate', 'tools.updateStyles']) {
    const command = describe(id)
    const valid = { name: 'source.docx', data: 'AAAA', ...(id === 'styles.copyFrom' ? { styles: ['Normal'] } : {}) }
    assert.deepEqual(validateToolArguments(command.inputSchema, valid), valid)
    assert.match(command.parameters, /No filesystem paths/)
    for (const name of ['/tmp/source.docx', '../source.docx', 'C:\\source.docx', 'file:source.docx']) {
      assert.throws(() => validateToolArguments(command.inputSchema, { ...valid, name }), /MCP/)
    }
    for (const missing of ['name', 'data']) {
      const args = { ...valid }; delete args[missing]
      assert.throws(() => validateToolArguments(command.inputSchema, args), /MCP/)
    }
  }
})

test('Word table gestures require completed coordinates, while document clipboard paste accepts no external payload', () => {
  for (const [id, valid] of [
    ['table.draw', { page: 0, x0: 80, y0: 80, x1: 280, y1: 160 }],
    ['table.eraser', { page: 0, x: 180, y: 120 }],
  ]) {
    const { inputSchema } = describe(id)
    assert.deepEqual(validateToolArguments(inputSchema, valid), valid)
    assert.throws(() => validateToolArguments(inputSchema, {}), /MCP/)
    assert.throws(() => validateToolArguments(inputSchema, { ...valid, page: -1 }), /MCP/)
  }
  for (const id of ['edit.paste', 'edit.pasteMerge', 'edit.pasteText']) {
    assert.deepEqual(validateToolArguments(describe(id).inputSchema, {}), {})
  }
  assert.deepEqual(validateToolArguments(describe('edit.pasteSpecial').inputSchema, { as: 'formatted' }), { as: 'formatted' })
  assert.throws(() => validateToolArguments(describe('edit.pasteSpecial').inputSchema, {}), /MCP/)
})

test('Word clipboard inspection and style discovery are queries, clipboard mutations require editing', () => {
  for (const id of ['edit.clipboardItems', 'styles.organizer', 'tools.templates', 'file.accessibility', 'file.compatibility']) assert.ok(wordQueryCommands.includes(id), id)
  for (const id of ['edit.copy', 'edit.cut', 'edit.repeat', 'edit.clearClipboard', 'styles.copyFrom', 'tools.updateStyles']) assert.ok(!wordQueryCommands.includes(id), id)
})
