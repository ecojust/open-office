import test from 'node:test'
import assert from 'node:assert/strict'
import { holidayStorage } from '../src/schedule/holiday-native.ts'
import { HolidayClient } from '../src/schedule/holidays.ts'

const NOW = Date.UTC(2026, 9, 29), PREFIX = 'open-office.schedule.holidays.v1.'
const key = year => `${PREFIX}${year}`
const entry = (year, name = '元旦') => JSON.stringify({ version: 1, year, fetchedAt: NOW, days: { [`${year}-01-01`]: name, [`${year}-01-04`]: null } })
const plain = value => JSON.parse(JSON.stringify(value))
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((accept, fail) => { resolve = accept; reject = fail }); return { promise, resolve, reject } }

test('native holiday storage restores a saved snapshot for synchronous validated reads after restart', async () => {
 let saved, requests = 0, restartWrites = 0
 const first = holidayStorage({}, async snapshot => { saved = snapshot })
 first.storage.setItem(key(2026), entry(2026))
 first.storage.setItem(key(2025), '{invalid-json')
 await first.flush()
 const restarted = holidayStorage(saved, async () => { restartWrites++ })
 const client = new HolidayClient({ storage: restarted.storage, now: () => NOW, fetch: async () => { requests++; throw Error('network must not be used') } })
 assert.deepEqual(plain(client.read([2025, 2026, 2027])), { 2026: { '2026-01-01': '元旦', '2026-01-04': null } })
 assert.equal(restarted.storage.length, 2)
 assert.equal(restarted.storage.key(0), key(2026))
 assert.equal(restarted.storage.getItem(key(2026)), entry(2026))
 assert.equal(restarted.storage.getItem('missing'), null)
 await restarted.flush()
 assert.equal(requests, 0)
 assert.equal(restartWrites, 0)
})

test('same-tick insertions, replacement and year pruning persist only the final cache snapshot', async () => {
 const snapshots = [], adapter = holidayStorage({}, async snapshot => { snapshots.push(snapshot) })
 for (let year = 2013; year <= 2026; year++) adapter.storage.setItem(key(year), entry(year))
 adapter.storage.setItem(key(2026), entry(2026, '更新后的元旦'))
 adapter.storage.removeItem(key(2013)); adapter.storage.removeItem(key(2014))
 adapter.storage.removeItem('missing')
 assert.equal(snapshots.length, 0)
 assert.equal(adapter.storage.length, 12)
 await adapter.flush()
 assert.equal(snapshots.length, 1)
 assert.equal(Object.keys(snapshots[0]).length, 12)
 assert.equal(Object.hasOwn(snapshots[0], key(2013)), false)
 assert.equal(Object.hasOwn(snapshots[0], key(2014)), false)
 assert.equal(snapshots[0][key(2026)], entry(2026, '更新后的元旦'))
 adapter.storage.removeItem('still-missing')
 await adapter.flush()
 assert.equal(snapshots.length, 1)
})

test('delayed native writes remain serial and cannot overwrite a newer cache snapshot', { timeout: 2000 }, async () => {
 const gates = [], snapshots = []; let disk = {}, active = 0, peak = 0, flushed = false
 const adapter = holidayStorage({}, async snapshot => {
  const gate = deferred(); gates.push(gate); snapshots.push(snapshot)
  active++; peak = Math.max(peak, active)
  await gate.promise
  disk = snapshot; active--
 })
 adapter.storage.setItem(key(2026), entry(2026, '旧公告'))
 await nextTurn()
 assert.equal(snapshots.length, 1)
 adapter.storage.setItem(key(2026), entry(2026, '新公告'))
 adapter.storage.setItem(key(2027), entry(2027))
 await nextTurn()
 assert.equal(snapshots.length, 1)
 assert.equal(adapter.storage.getItem(key(2026)), entry(2026, '新公告'))
 const finishing = adapter.flush().then(() => { flushed = true })
 gates[0].resolve(); await nextTurn()
 assert.equal(snapshots.length, 2)
 assert.equal(disk[key(2026)], entry(2026, '旧公告'))
 assert.equal(flushed, false)
 assert.equal(snapshots[0][key(2027)], undefined)
 assert.equal(snapshots[1][key(2026)], entry(2026, '新公告'))
 assert.equal(snapshots[1][key(2027)], entry(2027))
 gates[1].resolve(); await finishing
 assert.equal(peak, 1)
 assert.deepEqual(disk, { [key(2026)]: entry(2026, '新公告'), [key(2027)]: entry(2027) })
 assert.equal(flushed, true)
})

test('a failed native write rejects flush, retains readable memory and permits the next write', async () => {
 let attempts = 0, saved
 const adapter = holidayStorage({}, async snapshot => {
  attempts++
  if (attempts === 1) throw Error('disk unavailable')
  saved = snapshot
 })
 adapter.storage.setItem(key(2026), entry(2026))
 await assert.rejects(adapter.flush(), /disk unavailable/)
 const client = new HolidayClient({ storage: adapter.storage, now: () => NOW, fetch: async () => { throw Error('network must not be used') } })
 assert.equal(client.read([2026])[2026]['2026-01-01'], '元旦')
 assert.equal(adapter.storage.getItem(key(2026)), entry(2026))
 adapter.storage.setItem(key(2027), entry(2027))
 await adapter.flush()
 assert.equal(attempts, 2)
 assert.deepEqual(saved, { [key(2026)]: entry(2026), [key(2027)]: entry(2027) })
})
