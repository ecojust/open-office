import { invoke, isTauri } from '@tauri-apps/api/core'
import { HolidayClient, holidayClient } from './holidays.ts'

/** The desktop HTTP origin uses a fresh port per launch. Persist its public
 * holiday cache through the native app-data store instead of origin storage. */
export function holidayStorage(entries: Record<string, string>, persist: (entries: Record<string, string>) => Promise<void>) {
 const values = new Map(Object.entries(entries))
 let scheduled = false, writes = Promise.resolve()
 function changed() {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
   scheduled = false
   // Snapshot after the client's synchronous insertion and 12-year pruning.
   const snapshot = Object.fromEntries(values)
   writes = writes.catch(() => {}).then(() => persist(snapshot))
   // A denied disk write must not become an unhandled rejection or lose memory.
   void writes.catch(() => {})
  })
 }
 return {
  storage: {
   get length() { return values.size },
   key(index: number) { return [...values.keys()][index] ?? null },
   getItem(key: string) { return values.get(key) ?? null },
   setItem(key: string, value: string) { values.set(key, value); changed() },
   removeItem(key: string) { if (values.delete(key)) changed() },
  },
  async flush() { await Promise.resolve(); await writes },
 }
}

let desktopClient: Promise<HolidayClient> | undefined
let flush: (() => Promise<void>) | undefined
export async function getHolidayClient(): Promise<HolidayClient> {
 if (typeof window === 'undefined' || !isTauri()) return holidayClient
 desktopClient ??= (async () => {
  let entries: Record<string, string> = {}
  try { entries = await invoke<Record<string, string>>('load_schedule_holidays') } catch { /* Keep online updates usable in memory without replacing an unreadable cache. */ }
  const adapter = holidayStorage(entries, entries => invoke<void>('save_schedule_holidays', { entries }))
  flush = adapter.flush
  return new HolidayClient({ storage: adapter.storage })
 })()
 return desktopClient
}
export async function flushHolidayCache(): Promise<boolean> {
 try { await flush?.(); return true } catch { return false }
}
