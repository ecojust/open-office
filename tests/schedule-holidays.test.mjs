import test from 'node:test'
import assert from 'node:assert/strict'
import { HolidayClient } from '../src/schedule/holidays.ts'

const NOW = Date.UTC(2026, 9, 29), DAY = 86_400_000, CACHE_PREFIX = 'open-office.schedule.holidays.v1.'
const plain = value => JSON.parse(JSON.stringify(value))
const yearFrom = input => Number(String(input).match(/(\d{4})\.json$/)?.[1])
const fixture = (year = 2026, name = '元旦') => ({ year, papers: [], days: [{ date: `${year}-01-01`, name, isOffDay: true }, { date: `${year}-01-04`, name, isOffDay: false }] })
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
class MemoryStorage {
 values = new Map()
 get length() { return this.values.size }
 key(index) { return [...this.values.keys()][index] ?? null }
 getItem(key) { return this.values.get(key) ?? null }
 setItem(key, value) { this.values.set(key, String(value)) }
 removeItem(key) { this.values.delete(key) }
}
function cached(storage, year, fetchedAt = NOW, days = { [`${year}-01-01`]: '已缓存假日' }) {
 storage.setItem(`${CACHE_PREFIX}${year}`, JSON.stringify({ version: 1, year, fetchedAt, days }))
}

test('holiday client accepts an annual source, records makeup workdays as non-holidays and sends no credentials', async () => {
 const calls = [], storage = new MemoryStorage()
 const client = new HolidayClient({ storage, now: () => NOW, fetch: async (url, options) => { calls.push({ url: String(url), options }); return response(fixture()) } })
 assert.deepEqual(plain(client.read([2026])), {})
 const loaded = await client.load([2026])
 assert.deepEqual(plain(loaded), { years: { 2026: { '2026-01-01': '元旦', '2026-01-04': null } }, failedYears: [] })
 assert.equal(calls.length, 1)
 assert.equal(calls[0].url, 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json')
 assert.equal(calls[0].options.credentials, 'omit')
 assert.equal(calls[0].options.referrerPolicy, 'no-referrer')
 assert.equal(calls[0].options.redirect, 'error')
 assert.equal(calls[0].options.cache, undefined)
 assert.ok(calls[0].options.signal instanceof AbortSignal)
 assert.deepEqual(plain(client.read([2025, 2026])), { 2026: { '2026-01-01': '元旦', '2026-01-04': null } })
 assert.deepEqual(plain(new HolidayClient({ storage, now: () => NOW }).read([2026])), plain(loaded.years))
})

test('holiday refresh respects the 24 hour TTL; force refresh replaces the whole validated year', async () => {
 let now = NOW, requests = 0, source = fixture()
 const storage = new MemoryStorage(), client = new HolidayClient({ storage, now: () => now, fetch: async () => { requests++; return response(source) } })
 await client.load([2026]); assert.equal(requests, 1)
 now += DAY - 1
 await client.load([2026]); assert.equal(requests, 1)
 source = { year: 2026, papers: [], days: [{ date: '2026-02-16', name: '春节', isOffDay: true }] }
 now++
 const fresh = await client.load([2026]); assert.equal(requests, 2)
 assert.deepEqual(plain(fresh.years), { 2026: { '2026-02-16': '春节' } })
 await client.load([2026], true); assert.equal(requests, 3)
})

test('offline refresh retains previous data and failed refreshes cool down for five minutes', async () => {
 let now = NOW, requests = 0
 const storage = new MemoryStorage(); cached(storage, 2026, NOW - DAY)
 const client = new HolidayClient({ storage, now: () => now, fetch: async () => { requests++; throw Error('offline') } })
 const first = await client.load([2026])
 assert.deepEqual(plain(first), { years: { 2026: { '2026-01-01': '已缓存假日' } }, failedYears: [2026] })
 assert.equal(requests, 2)
 now += 5 * 60_000 - 1
 assert.deepEqual((await client.load([2026])).failedYears, [2026]); assert.equal(requests, 2)
 now++
 await client.load([2026]); assert.equal(requests, 4)
 await client.load([2026], true); assert.equal(requests, 6)
 assert.deepEqual(plain(client.read([2026])), plain(first.years))
})

test('a failed primary source falls back to the fixed secondary source', async () => {
 const calls = []
 const client = new HolidayClient({ storage: null, now: () => NOW, fetch: async url => {
  calls.push(String(url))
  return calls.length === 1 ? new Response('not available', { status: 503 }) : response(fixture())
 } })
 const result = await client.load([2026])
 assert.deepEqual(result.failedYears, [])
 assert.equal(result.years[2026]['2026-01-01'], '元旦')
 assert.deepEqual(calls, ['https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json', 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json'])
})

test('manual refresh revalidates HTTP caches on both sources without changing their URLs', async () => {
 const calls = [], client = new HolidayClient({ storage: null, now: () => NOW, fetch: async (url, options) => {
  calls.push({ url: String(url), cache: options.cache })
  return String(url).includes('raw.githubusercontent.com') ? new Response('unavailable', { status: 503 }) : response(fixture())
 } })
 assert.deepEqual((await client.load([2026])).failedYears, [])
 assert.deepEqual((await client.load([2026], true)).failedYears, [])
 assert.deepEqual(calls.map(call => call.cache), [undefined, undefined, 'no-cache', 'no-cache'])
 assert.deepEqual(calls.slice(0, 2).map(call => call.url), calls.slice(2).map(call => call.url))
})

test('an annual source includes adjacent-year holiday dates such as New Year Eve', async () => {
 const client = new HolidayClient({ storage: null, now: () => NOW, fetch: async () => response({ year: 2027, papers: [], days: [
  { date: '2026-12-31', name: '元旦', isOffDay: true },
  { date: '2027-01-01', name: '元旦', isOffDay: true },
  { date: '2026-12-27', name: '元旦', isOffDay: false },
 ] }) })
 assert.deepEqual(plain(await client.load([2027])), { years: { 2027: { '2026-12-31': '元旦', '2027-01-01': '元旦', '2026-12-27': null } }, failedYears: [] })
})

test('annual validation rejects malformed, duplicate and out-of-year dates without overwriting the cache', async () => {
 const malformed = [
  { ...fixture(), year: 2025 },
  { year: 2026, days: [] },
  { year: 2026, days: [{ date: '2026-01-04', name: '元旦', isOffDay: false }] },
  { year: 2026, days: [{ date: '2025-12-31', name: '元旦', isOffDay: true }] },
  { year: 2026, days: [{ date: '2026-02-29', name: '节日', isOffDay: true }] },
  { year: 2026, days: [{ date: '2028-01-01', name: '节日', isOffDay: true }] },
  { year: 2026, days: [{ date: '2026-1-01', name: '节日', isOffDay: true }] },
  { year: 2026, days: [{ date: '2026-01-01', name: '节日', isOffDay: 1 }] },
  { year: 2026, days: [{ date: '2026-01-01', name: '', isOffDay: true }] },
  { year: 2026, days: [{ date: '2026-01-01', name: '无效\u0000节日', isOffDay: true }] },
  { year: 2026, days: [{ date: '2026-01-01', name: '节'.repeat(101), isOffDay: true }] },
  { year: 2026, days: [fixture().days[0], { ...fixture().days[0], name: '重复日期' }] },
  { year: 2026, days: Array.from({ length: 1099 }, () => fixture().days[0]) },
  { year: 2026, days: [fixture().days[0], { date: '2026-01-04', name: null, isOffDay: false }] },
 ]
 for (const value of malformed.map(value => ({ ...value, papers: [] })).concat([{ ...fixture(), papers: 'invalid' }, { ...fixture(), papers: ['javascript:alert(1)'] }, { ...fixture(), papers: [1] }])) {
  const storage = new MemoryStorage(); cached(storage, 2026, NOW - DAY)
  const before = storage.getItem(`${CACHE_PREFIX}2026`)
  const client = new HolidayClient({ storage, now: () => NOW, fetch: async () => response(value) })
  const result = await client.load([2026])
  assert.deepEqual(result.failedYears, [2026], JSON.stringify(value).slice(0, 160))
  assert.equal(result.years[2026]['2026-01-01'], '已缓存假日')
  assert.equal(storage.getItem(`${CACHE_PREFIX}2026`), before)
 }
})

test('response size and strict UTF-8 decoding reject corrupt or oversized payloads', async () => {
 const cases = [
  () => new Response('{invalid-json'),
  () => new Response(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])),
  () => new Response(JSON.stringify(fixture()), { headers: { 'content-length': String(256 * 1024 + 1) } }),
  () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024)); controller.enqueue(new Uint8Array(128 * 1024 + 1)); controller.close() } })),
 ]
 for (const makeResponse of cases) {
  let requests = 0
  const client = new HolidayClient({ storage: null, now: () => NOW, fetch: async () => { requests++; return makeResponse() } })
  assert.deepEqual(plain(await client.load([2026])), { years: {}, failedYears: [2026] })
  assert.equal(requests, 2)
 }
})

test('each source times out after five seconds even when a fetch ignores abort', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] })
 const signals = [], client = new HolidayClient({ storage: null, now: () => NOW, fetch: async (_url, options) => { signals.push(options.signal); return new Promise(() => {}) } })
 const pending = client.load([2026])
 await nextTurn(); assert.equal(signals.length, 1)
 t.mock.timers.tick(4999); await nextTurn(); assert.equal(signals.length, 1)
 t.mock.timers.tick(1); await nextTurn(); assert.equal(signals.length, 2); assert.equal(signals[0].aborted, true)
 t.mock.timers.tick(5000)
 assert.deepEqual(plain(await pending), { years: {}, failedYears: [2026] })
 assert.equal(signals[1].aborted, true)
})

test('timeout also covers a stalled response stream and releases its reader', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] })
 let calls = 0, cancellations = 0
 const client = new HolidayClient({ storage: null, now: () => NOW, fetch: async () => {
  calls++
  return new Response(new ReadableStream({ cancel() { cancellations++ } }))
 } })
 const pending = client.load([2026]); await nextTurn()
 assert.equal(calls, 1)
 t.mock.timers.tick(5000); await nextTurn(); assert.equal(calls, 2)
 t.mock.timers.tick(5000)
 assert.deepEqual((await pending).failedYears, [2026])
 await nextTurn(); assert.equal(cancellations, 2)
})

test('concurrent requests for the same year are deduplicated, including a forced request', async () => {
 let requests = 0, release
 const client = new HolidayClient({ storage: null, now: () => NOW, fetch: async () => { requests++; return new Promise(resolve => { release = resolve }) } })
 const first = client.load([2026]), second = client.load([2026], true)
 await nextTurn(); assert.equal(requests, 1)
 release(response(fixture()))
 const results = await Promise.all([first, second])
 assert.deepEqual(plain(results[0]), plain(results[1])); assert.equal(requests, 1)
})

test('separate overlapping loads share a two-request concurrency limit', async () => {
 const waiting = [], calls = []; let active = 0, peak = 0
 const client = new HolidayClient({ storage: null, now: () => NOW, fetch: async url => {
  const year = yearFrom(url); calls.push(year); active++; peak = Math.max(peak, active)
  return new Promise(resolve => waiting.push(() => { active--; resolve(response(fixture(year))) }))
 } })
 const first = client.load([2024, 2025]), second = client.load([2026, 2027])
 await nextTurn(); assert.equal(calls.length, 2)
 for (let turns = 0; turns < 40 && (calls.length < 4 || waiting.length); turns++) { const finish = waiting.shift(); if (finish) finish(); await nextTurn() }
 assert.equal(calls.length, 4)
 const results = await Promise.all([first, second])
 assert.deepEqual(results.map(result => result.failedYears), [[], []]); assert.equal(peak, 2)
 assert.deepEqual([...calls].sort(), [2024, 2025, 2026, 2027])
})

test('only five distinct valid requested years can cause network requests', async () => {
 const calls = []
 const client = new HolidayClient({ storage: null, now: () => NOW, fetch: async url => { const year = yearFrom(url); calls.push(year); return response(fixture(year)) } })
 const result = await client.load([2026, 2026, 2025, 2024, 2023, 2022, 2021, 1899, 10_000, 2026.5, NaN, Infinity])
 assert.deepEqual(calls.sort(), [2022, 2023, 2024, 2025, 2026])
 for (const year of [2021, 1899, 10_000, 2026.5, NaN, Infinity]) assert.ok(result.failedYears.includes(year), `failed year ${year}`)
 assert.equal(Object.keys(result.years).length, 5)
})

test('invalid cached entries are ignored and output objects cannot mutate the client cache', async () => {
 const storage = new MemoryStorage()
 cached(storage, 2026, NOW, { '2026-02-29': '无效日期' })
 cached(storage, 2025, NOW, { '2025-01-01': '' })
 storage.setItem(`${CACHE_PREFIX}2024`, '{invalid-json')
 cached(storage, 2023, NOW)
 const client = new HolidayClient({ storage, now: () => NOW, fetch: async url => response(fixture(yearFrom(url))) })
 assert.deepEqual(plain(client.read([2024, 2025, 2026])), {})
 const exported = client.read([2023])
 try { exported[2023]['2023-01-01'] = '被修改'; delete exported[2023] } catch { /* Frozen snapshots are also valid. */ }
 assert.equal(client.read([2023])[2023]['2023-01-01'], '已缓存假日')
})

test('cache keeps at most twelve annual records and preserves unrelated storage', async () => {
 const storage = new MemoryStorage(); storage.setItem('other-document-preference', 'preserve')
 let now = NOW
 const client = new HolidayClient({ storage, now: () => now, fetch: async url => response(fixture(yearFrom(url))) })
 for (const year of Array.from({ length: 14 }, (_, index) => 2013 + index)) { now++; await client.load([year]) }
 const keys = [...storage.values.keys()].filter(key => key.startsWith(CACHE_PREFIX))
 assert.ok(keys.length <= 12)
 assert.equal(storage.getItem('other-document-preference'), 'preserve')
 assert.equal(client.read([2026])[2026]['2026-01-01'], '元旦')
})

test('storage failures still leave successful annual data available in memory', async () => {
 let requests = 0
 const storage = { get length() { throw Error('blocked') }, key() { throw Error('blocked') }, getItem() { throw Error('blocked') }, setItem() { throw Error('quota') }, removeItem() { throw Error('blocked') } }
 const client = new HolidayClient({ storage, now: () => NOW, fetch: async () => { requests++; return response(fixture()) } })
 assert.deepEqual((await client.load([2026])).failedYears, [])
 assert.equal(client.read([2026])[2026]['2026-01-01'], '元旦')
 await client.load([2026]); assert.equal(requests, 1)
})
