import type { RustWordRequest, RustWordResponse } from './types'

type EngineExports = {
  memory: WebAssembly.Memory
  word_engine_alloc(length: number): number
  word_engine_dealloc(pointer: number, length: number): void
  word_engine_request(pointer: number, length: number): number
  word_engine_result_len(): number
}
let engine: Promise<EngineExports> | undefined
let queue: Promise<void> = Promise.resolve()
const maxRequestBytes = 24 * 1024 * 1024
async function load(url: string): Promise<EngineExports> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' })
  if (!response.ok) throw Error('文字编辑器资源加载失败，请重新打开文稿。')
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {})
  const exports = instance.exports as unknown as EngineExports
  if (!(exports.memory instanceof WebAssembly.Memory) || ['word_engine_alloc', 'word_engine_dealloc', 'word_engine_request', 'word_engine_result_len'].some(key => typeof instance.exports[key] !== 'function')) throw Error('文字编辑器资源版本不匹配。')
  return exports
}
self.onmessage = (event: MessageEvent<{ id: number; url: string; request: RustWordRequest }>) => {
  const message = event.data
  queue = queue.then(async () => {
    try {
      const api = await (engine ??= load(message.url))
      const json = JSON.stringify(message.request)
      if (json.length > maxRequestBytes) throw Error('文稿数据过大，无法在当前编辑器中处理。')
      const input = new TextEncoder().encode(json)
      if (input.length > maxRequestBytes) throw Error('文稿数据过大，无法在当前编辑器中处理。')
      const pointer = api.word_engine_alloc(input.length)
      if (pointer === 0) throw Error('文字编辑器没有足够空间处理此文稿。')
      let result: RustWordResponse
      try {
        new Uint8Array(api.memory.buffer, pointer, input.length).set(input)
        const output = api.word_engine_request(pointer, input.length)
        const length = api.word_engine_result_len()
        // Calls may grow memory. The response belongs to Rust until the next
        // request; decode it now and free only our own input allocation.
        result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(api.memory.buffer, output, length))) as RustWordResponse
      } finally { api.word_engine_dealloc(pointer, input.length) }
      self.postMessage({ id: message.id, response: result })
    } catch (cause) {
      self.postMessage({ id: message.id, error: cause instanceof Error ? cause.message : String(cause) })
    }
  })
}
