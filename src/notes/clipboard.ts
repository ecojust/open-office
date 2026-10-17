import { NOTE_IMAGE_MAX_BYTES, NOTE_MAX_BYTES, noteId, validateImage, type NoteBlock } from './model.ts'
import { bytesToBase64 } from '../shared/document.ts'

export function clipboardImageFiles(data: DataTransfer | null): File[] {
 const files = [...(data?.files ?? [])]
 if (!files.length) for (const item of [...(data?.items ?? [])]) {
  if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file) }
 }
 return files.filter(file => file.type.startsWith('image/') || /\.(png|jpe?g)$/i.test(file.name))
}

export async function imageFilesToBlocks(files: readonly File[]): Promise<NoteBlock[]> {
 if (files.length > 16 || files.reduce((total, file) => total + file.size, 0) > NOTE_MAX_BYTES) throw Error('一次最多粘贴 16 张图片，总大小不超过 16 MB。')
 return Promise.all(files.map(async file => {
  const type = file.type && file.type !== 'application/octet-stream' ? file.type : /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : ''
  if (!['image/png', 'image/jpeg'].includes(type) || file.size > NOTE_IMAGE_MAX_BYTES) throw Error('请选择不超过 4 MB 的 PNG 或 JPEG 图片。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { id: noteId(), type: 'image', dataUrl: validateImage(`data:${type};base64,${bytesToBase64(bytes)}`), alt: Array.from(file.name).slice(0, 200).join('') }
 }))
}
