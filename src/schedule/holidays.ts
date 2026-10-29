/** Source-year announcements may include dates in either neighboring year.
 * null records explicitly remove a holiday when a newer announcement amends it. */
export type HolidayYears = Readonly<Record<number, Readonly<Record<string, string | null>>>>
type HolidayDays = Readonly<Record<string, string | null>>
type HolidayStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
type CacheEntry = { version: 1; year: number; fetchedAt: number; days: HolidayDays }
type HolidayClientOptions = { fetch?: typeof globalThis.fetch; storage?: HolidayStorage | null; now?: () => number }

const PREFIX = 'open-office.schedule.holidays.v1.'
const MAX_BYTES = 256 * 1024, MAX_CACHED_YEARS = 12, MAX_LOAD_YEARS = 5
const TTL = 24 * 60 * 60 * 1000, RETRY_DELAY = 5 * 60 * 1000, TIMEOUT = 5000
const SOURCES = ['https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/', 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/']
const encoder = new TextEncoder()
let networkActive = 0
const networkQueue: (() => void)[] = []

/** All clients share the transport limit; the exported client also deduplicates tabs. */
async function networkSlot<T>(work: () => Promise<T>): Promise<T> {
 if (networkActive >= 2) await new Promise<void>(resolve => networkQueue.push(resolve))
 else networkActive++
 try { return await work() }
 finally {
  const next = networkQueue.shift()
  if (next) next()
  else networkActive--
 }
}
function validYear(year: number): boolean { return Number.isSafeInteger(year) && year >= 1900 && year <= 9999 }
function record(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('节假日数据结构无效。')
 return value as Record<string, unknown>
}
function validDate(date: string, sourceYear: number): boolean {
 const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
 if (!match) return false
 const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
 if (year < 1 || year > 9999 || Math.abs(year - sourceYear) > 1) return false
 const parsed = new Date(Date.UTC(year, month - 1, day))
 return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}
function holidayName(value: unknown): string {
 if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw Error('节假日名称无效。')
 return value.trim()
}
function validatedDays(value: unknown, year: number): HolidayDays {
 const source = record(value), entries = Object.entries(source), days: Record<string, string | null> = {}
 if (!entries.length || entries.length > 1098) throw Error('节假日年度数据为空或过多。')
 let currentYearHoliday = false
 for (const [date, name] of entries) {
  if (!validDate(date, year)) throw Error('节假日日期无效。')
  days[date] = name === null ? null : holidayName(name)
  if (Number(date.slice(0, 4)) === year && days[date] !== null) currentYearHoliday = true
 }
 if (!currentYearHoliday) throw Error('节假日年度公告尚未完整发布。')
 return Object.freeze(days)
}
function parseAnnouncement(value: unknown, year: number): HolidayDays {
 const source = record(value)
 if (source.year !== year || !Array.isArray(source.days) || !source.days.length || source.days.length > 1098 || !Array.isArray(source.papers) || source.papers.length > 32) throw Error('节假日年度公告格式无效。')
 for (const paper of source.papers) if (typeof paper !== 'string' || paper.length > 2048 || !/^https?:\/\/[^\s]+$/.test(paper)) throw Error('节假日公告来源格式无效。')
 const days: Record<string, string | null> = {}
 for (const item of source.days) {
  const entry = record(item)
  if (typeof entry.date !== 'string' || !validDate(entry.date, year) || Object.hasOwn(days, entry.date) || typeof entry.isOffDay !== 'boolean') throw Error('节假日日期或放假标记无效。')
  const name = holidayName(entry.name)
  days[entry.date] = entry.isOffDay ? name : null
 }
 return validatedDays(days, year)
}
function defaultStorage(): HolidayStorage | undefined {
 try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}
async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
 if (!response.ok || response.redirected) throw Error('节假日数据请求失败。')
 const declared = response.headers.get('content-length')
 if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw Error('节假日响应超过大小限制。')
 if (!response.body) throw Error('节假日响应为空。')
 const reader = response.body.getReader(), chunks: Uint8Array[] = []
 const cancelRead = () => { void reader.cancel().catch(() => {}) }
 signal.addEventListener('abort', cancelRead, { once: true })
 let length = 0, completed = false
 try {
  while (true) {
   if (signal.aborted) throw Error('节假日请求已超时。')
   const { done, value } = await reader.read()
   if (signal.aborted) throw Error('节假日请求已超时。')
   if (done) { completed = true; break }
   length += value.byteLength
   if (length > MAX_BYTES) throw Error('节假日响应超过大小限制。')
   chunks.push(value)
  }
 } finally {
  signal.removeEventListener('abort', cancelRead)
  if (!completed) void reader.cancel().catch(() => {})
  reader.releaseLock()
 }
 const bytes = new Uint8Array(length)
 let offset = 0
 for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
 return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export class HolidayClient {
 private readonly fetcher: typeof globalThis.fetch | undefined
 private readonly storage: HolidayStorage | undefined
 private readonly now: () => number
 private readonly memory = new Map<number, CacheEntry>()
 private readonly pending = new Map<number, Promise<boolean>>()
 private readonly failedAt = new Map<number, number>()

 constructor(options: HolidayClientOptions = {}) {
  this.fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis)
  this.storage = options.storage === undefined ? defaultStorage() : options.storage ?? undefined
  this.now = options.now ?? Date.now
 }
 private cached(year: number): CacheEntry | undefined {
  const current = this.memory.get(year)
  if (current) return current
  try {
   const raw = this.storage?.getItem(`${PREFIX}${year}`)
   if (!raw || raw.length > MAX_BYTES || encoder.encode(raw).byteLength > MAX_BYTES) return undefined
   const entry = record(JSON.parse(raw)), fetchedAt = entry.fetchedAt
   if (entry.version !== 1 || entry.year !== year || typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt < 0 || fetchedAt > this.now() + RETRY_DELAY) return undefined
   const cached: CacheEntry = { version: 1, year, fetchedAt, days: validatedDays(entry.days, year) }
   this.remember(cached)
   return cached
  } catch { return undefined }
 }
 private remember(entry: CacheEntry) {
  this.memory.delete(entry.year); this.memory.set(entry.year, entry)
  while (this.memory.size > MAX_CACHED_YEARS) this.memory.delete(this.memory.keys().next().value!)
 }
 private save(entry: CacheEntry) {
  this.remember(entry)
  try {
   const storage = this.storage
   if (!storage) return
   storage.setItem(`${PREFIX}${entry.year}`, JSON.stringify(entry))
   const keys: { key: string; fetchedAt: number }[] = []
   for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith(PREFIX)) continue
    let fetchedAt = 0
    try { const item = record(JSON.parse(storage.getItem(key) ?? 'null')); if (typeof item.fetchedAt === 'number' && Number.isFinite(item.fetchedAt)) fetchedAt = item.fetchedAt } catch { /* Invalid entries are evicted first. */ }
    keys.push({ key, fetchedAt })
   }
   keys.sort((a, b) => b.fetchedAt - a.fetchedAt || (a.key === `${PREFIX}${entry.year}` ? -1 : b.key === `${PREFIX}${entry.year}` ? 1 : a.key.localeCompare(b.key)))
   for (const item of keys.slice(MAX_CACHED_YEARS)) storage.removeItem(item.key)
  } catch { /* Quota or privacy restrictions do not discard validated memory data. */ }
 }
 read(years: number[]): HolidayYears {
  const result: Record<number, HolidayDays> = {}
  for (const year of new Set(years)) {
   if (!validYear(year)) continue
   const entry = this.cached(year)
   if (entry) result[year] = entry.days
  }
  return Object.freeze(result)
 }
 private async source(year: number, base: string, force: boolean): Promise<HolidayDays> {
  if (!this.fetcher) throw Error('此环境无法获取在线节假日。')
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
   return await Promise.race([
    (async () => {
     const response = await this.fetcher!(`${base}${year}.json`, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', ...(force ? { cache: 'no-cache' as const } : {}) })
     return parseAnnouncement(await responseJson(response, controller.signal), year)
    })(),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(Error('节假日请求已超时。')) }, TIMEOUT) }),
   ])
  } finally { clearTimeout(timeout); controller.abort() }
 }
 private loadYear(year: number, force: boolean): Promise<boolean> {
  const existing = this.pending.get(year)
  if (existing) return existing
  const now = this.now(), cached = this.cached(year), failedAt = this.failedAt.get(year)
  if (!force && cached && now >= cached.fetchedAt && now - cached.fetchedAt < TTL) return Promise.resolve(true)
  if (!force && failedAt !== undefined && now >= failedAt && now - failedAt < RETRY_DELAY) return Promise.resolve(false)
  const operation = networkSlot(async () => {
   for (const base of SOURCES) {
    try {
     const days = await this.source(year, base, force)
     this.save({ version: 1, year, fetchedAt: this.now(), days }); this.failedAt.delete(year)
     return true
    } catch { /* Keep the whole previous year while trying the fallback source. */ }
   }
   this.failedAt.delete(year); this.failedAt.set(year, this.now())
   while (this.failedAt.size > MAX_CACHED_YEARS) this.failedAt.delete(this.failedAt.keys().next().value!)
   return false
  }).finally(() => this.pending.delete(year))
  this.pending.set(year, operation)
  return operation
 }
 async load(years: number[], force = false): Promise<{ years: HolidayYears; failedYears: number[] }> {
  const requested = [...new Set(years)], accepted = requested.filter(validYear).slice(0, MAX_LOAD_YEARS), acceptedSet = new Set(accepted)
  const outcomes = await Promise.all(accepted.map(async year => ({ year, ok: await this.loadYear(year, force) })))
  const failures = new Set(outcomes.filter(item => !item.ok).map(item => item.year))
  return { years: this.read(requested), failedYears: requested.filter(year => !acceptedSet.has(year) || failures.has(year)) }
 }
}

/** Shared by schedule editors so simultaneous tabs reuse the same refresh. */
export const holidayClient = new HolidayClient()
