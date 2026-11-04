import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSaveExtension, documentKindOf, extensionOf, isImportOnly, saveFormats } from '../src/shared/document.ts'
import { createCalendar, encodeCalendar } from '../src/calendar/model.ts'

test('calendar books and JSON copies route to their own editor and preserve imported originals', () => {
 const bytes = encodeCalendar(createCalendar('日历便笺'))
 assert.equal(extensionOf('事项.OOCALENDAR'), 'oocalendar')
 for (const extension of ['oocalendar', 'json']) assert.equal(documentKindOf(bytes, extension), 'calendar')
 assert.equal(isImportOnly('json'), true)
 assert.equal(isImportOnly('oocalendar'), false)
 assert.equal(defaultSaveExtension('json', 'calendar'), 'oocalendar')
 assert.deepEqual(saveFormats('calendar').map(item => item.extension), ['oocalendar'])
 for (const extension of ['owflow', 'ooschedule', 'oonote']) assert.throws(() => documentKindOf(bytes, extension))
})

test('calendar file gates reject future envelopes, malformed JSON and excess history before opening', () => {
 const book = createCalendar('事项')
 for (const value of [{...book, version: 2}, {...book, notes: {}}, {...book, history: undefined}, {...book, history: Array(101).fill({})}, {type: 'calendar', events: []}]) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  for (const extension of ['oocalendar', 'json']) assert.throws(() => documentKindOf(bytes, extension))
 }
 for (const extension of ['oocalendar', 'json']) assert.throws(() => documentKindOf(new Uint8Array([0xc3, 0x28]), extension))
})
