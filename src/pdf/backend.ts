import { invoke, isTauri } from '@tauri-apps/api/core'
import type { NativeDocument, NativeImage, SaveResult } from '../types'
import type { PdfResponse } from './protocol'

export const hasPdfEditingEngine = () => isTauri() || import.meta.env.DEV

export async function callPdfBackend(request: Record<string, unknown>): Promise<PdfResponse> {
  if (isTauri()) return invoke<PdfResponse>('pdf_request', { request })
  if (!import.meta.env.DEV) throw new Error('浏览器版本仅支持 PDF 预览。请在桌面应用中编辑。')
  const response = await fetch(new URL('./__pdf-dev', document.baseURI), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`本地 PDF 开发引擎暂不可用（HTTP ${response.status}）。`)
  return response.json() as Promise<PdfResponse>
}

/** Native file dialogs in installed apps. Browser pickers exist only for local development. */
async function pickDevelopmentFile(accept: string): Promise<File | null> {
  if (!import.meta.env.DEV) throw new Error('请在桌面应用中使用此功能。')
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    const done = (file: File | null) => { input.remove(); resolve(file) }
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => done(null), { once: true })
    document.body.append(input)
    input.click()
  })
}

async function fileBase64(file: File): Promise<string> {
  if (file.size > 96 * 1024 * 1024) throw new Error('文件超过 96 MiB，请使用较小的文件。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  return btoa(parts.join(''))
}

export async function pickPdfDocument(): Promise<NativeDocument | null> {
  if (isTauri()) return invoke('open_document')
  const file = await pickDevelopmentFile('.pdf,application/pdf')
  if (!file) return null
  return { id: crypto.randomUUID(), name: file.name, extension: 'pdf', kind: 'pdf', base64: await fileBase64(file), sha256: '', sizeBytes: file.size }
}

export async function pickPdfImage(): Promise<NativeImage | null> {
  if (isTauri()) return invoke('pick_image')
  const file = await pickDevelopmentFile('.png,.jpg,.jpeg,image/png,image/jpeg')
  if (!file) return null
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('请选择 PNG 或 JPEG 图片。')
  return { name: file.name, base64: await fileBase64(file), mimeType: file.type as NativeImage['mimeType'] }
}

export async function saveExtractedPdf(name: string, base64: string): Promise<SaveResult> {
  if (isTauri()) return invoke('save_document', { request: { name, extension: 'pdf', base64, saveAs: true } })
  if (!import.meta.env.DEV) throw new Error('请在桌面应用中提取 PDF 页面。')
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return { status: 'saved', document: { id: '', name, extension: 'pdf', kind: 'pdf', sha256: '', sizeBytes: bytes.length } }
}
