import { invoke, isTauri as detectTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AppBootstrap, NativeDocument, NativeImage, RecentDocument, SaveDocumentRequest, SaveResult } from './types'

export const isTauri = (): boolean => detectTauri()
export const bootstrap = (): Promise<AppBootstrap> => invoke('bootstrap')
export const openDocument = (): Promise<NativeDocument | null> => invoke('open_document')
export const openRecent = (documentId: string): Promise<NativeDocument> => invoke('open_recent', { documentId })
export const listRecentDocuments = (): Promise<RecentDocument[]> => invoke('list_recent_documents')
export const saveDocument = (request: SaveDocumentRequest): Promise<SaveResult> => invoke('save_document', { request })
export const pickImage = (): Promise<NativeImage | null> => invoke('pick_image')
export const confirmClose = (): Promise<void> => invoke('confirm_close')
export const onCloseRequested = (callback: () => void): Promise<UnlistenFn> => listen('app-close-requested', callback)

export interface WordPackagePart { name: string; dataBase64: string }
/** ZIP/CRC work runs in the Rust backend; OOXML semantics remain in the shared codec. */
export const readWordPackage = (base64: string): Promise<WordPackagePart[]> => invoke('word_read_package', { base64 })
export const writeWordPackage = (parts: WordPackagePart[]): Promise<string> => invoke('word_write_package', { parts })

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(chunks.join(''))
}

export function base64ToBytes(base64: string): Uint8Array {
  const decoded = atob(base64)
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
  return bytes
}
