import test from 'node:test'
import assert from 'node:assert/strict'
import { createPdfAuthorPreference, normalizePdfAuthor, PDF_AUTHOR_STORAGE_KEY } from '../src/pdf/author.ts'

function storage(initial) {
  const values = new Map(initial === undefined ? [] : [[PDF_AUTHOR_STORAGE_KEY, initial]])
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('PDF author is an explicit Unicode identity, with no generated guest or login name', () => {
  assert.equal(normalizePdfAuthor('  陈江 · Open Office  '), '陈江 · Open Office')
  assert.equal(normalizePdfAuthor('   '), '')
  assert.equal(normalizePdfAuthor('𠮷'.repeat(200)), '𠮷'.repeat(200))
  assert.throws(() => normalizePdfAuthor('𠮷'.repeat(201)), /200/)
  for (const value of ['Name\nOther', 'Name\u0000Other', 'Name\u0085Other']) assert.throws(() => normalizePdfAuthor(value), /控制字符/)
  assert.equal(createPdfAuthorPreference(() => storage()).read(), '')
})

test('PDF author changes persist across stores, notify live tabs and preserve explicit clearing', () => {
  const disk = storage(), preferences = createPdfAuthorPreference(() => disk), changes = []
  const unsubscribe = preferences.subscribe(value => changes.push(value))
  assert.equal(preferences.save(' 陈江 '), true)
  assert.equal(preferences.read(), '陈江')
  assert.equal(createPdfAuthorPreference(() => disk).read(), '陈江')
  assert.equal(preferences.save(''), true)
  assert.equal(createPdfAuthorPreference(() => disk).read(), '')
  assert.deepEqual(changes, ['陈江', ''])
  unsubscribe(); preferences.save('Ada'); assert.deepEqual(changes, ['陈江', ''])
})

test('corrupt or unavailable local preferences stay empty, while an explicit session choice remains usable', () => {
  assert.equal(createPdfAuthorPreference(() => storage('x'.repeat(201))).read(), '')
  const preferences = createPdfAuthorPreference(() => { throw Error('Storage unavailable') })
  assert.equal(preferences.read(), '')
  assert.equal(preferences.save('陈江'), false)
  assert.equal(preferences.read(), '陈江')
  assert.throws(() => preferences.save('bad\nvalue'), /控制字符/)
  assert.equal(preferences.read(), '陈江')
})
