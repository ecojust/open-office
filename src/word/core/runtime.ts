import { isTauri, readWordPackage, writeWordPackage } from '../../native'
import { base64ToBytes, bytesToBase64 } from '../../shared/document'
import { importWordDocument as importBrowserDocument, exportWordDocument as exportBrowserDocument,
  importWordParts, exportWordParts, WordDocumentError } from './docx'
import type { WordDocument } from './model'

function packageError(cause: unknown): never {
  if (cause instanceof WordDocumentError) throw cause
  throw new WordDocumentError(cause instanceof Error ? cause.message : String(cause))
}

/** Desktop uses Rust for bounded ZIP decoding. Every part still passes the same XML/OOXML checks. */
export async function importWordDocument(input: Uint8Array): Promise<WordDocument> {
  if (!isTauri()) return importBrowserDocument(input)
  try {
    if (input.byteLength > 16 * 1024 * 1024) throw Error('独立文字编辑器支持不超过 16 MiB 的 DOCX。')
    const parts = await readWordPackage(bytesToBase64(input))
    const entries = new Map<string, Uint8Array>()
    for (const part of parts) {
      if (entries.has(part.name)) throw Error('DOCX 包含重复的文件。')
      entries.set(part.name, base64ToBytes(part.dataBase64))
    }
    return importWordParts(entries)
  } catch (cause) { return packageError(cause) }
}

/** No silent fallback: a rejected native package must never be accepted by another implementation. */
export async function exportWordDocument(model: WordDocument): Promise<Uint8Array> {
  if (!isTauri()) return exportBrowserDocument(model)
  try {
    const parts = Array.from(exportWordParts(model), ([name, data]) => ({ name, dataBase64: bytesToBase64(data) }))
    return base64ToBytes(await writeWordPackage(parts))
  } catch (cause) { return packageError(cause) }
}
