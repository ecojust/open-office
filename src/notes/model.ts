/** Portable notebook format. Only this data model is persisted; HTML is never stored. */
export type NoteMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code'
export type NoteInline = { text: string; marks?: NoteMark[] }
export type NoteTextBlock = { id: string; type: 'paragraph' | 'heading' | 'bullet' | 'numbered' | 'todo'; content: NoteInline[]; level?: 1 | 2 | 3; checked?: boolean }
export type NoteBlock = NoteTextBlock | { id: string; type: 'image'; dataUrl: string; alt: string }
export type NotePage = { id: string; title: string; blocks: NoteBlock[] }
export type NoteSection = { id: string; title: string; pages: NotePage[] }
export type Notebook = { format: 'open-office-notebook'; version: 1; id: string; title: string; sections: NoteSection[] }
export const NOTE_MAX_BYTES = 16 * 1024 * 1024
export const NOTE_IMAGE_MAX_BYTES = 4 * 1024 * 1024
const marks: readonly string[] = ['bold', 'italic', 'underline', 'strike', 'code']
let sequence = 0
export function noteId(): string { return `n_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}_${(++sequence).toString(36)}`}` }
export function blankBlock(): NoteTextBlock { return { id: noteId(), type: 'paragraph', content: [] } }
export function blankPage(title = '无标题页面'): NotePage { return { id: noteId(), title, blocks: [blankBlock()] } }
export function createNotebook(title = '我的笔记本'): Notebook { return { format: 'open-office-notebook', version: 1, id: noteId(), title, sections: [{ id: noteId(), title: '日常笔记', pages: [blankPage()] }] } }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('笔记文件结构不正确。'); return value as Record<string, unknown> }
function text(value: unknown, max: number): string { if (typeof value !== 'string' || Array.from(value).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error('笔记文字无效或过长。'); return value }
export function noteTitle(value: string): string { const title = text(value.trim(), 200); if (!title) throw Error('名称不能为空。'); return title }
export function validateImage(dataUrl: unknown): string {
 if (typeof dataUrl !== 'string') throw Error('图片数据无效。')
 const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
 if (!match || match[2].length % 4 !== 0 || match[2].length > Math.ceil(NOTE_IMAGE_MAX_BYTES / 3) * 4) throw Error('仅支持不超过 4 MB 的 PNG 或 JPEG 图片。')
 let header: string
 try { header = atob(match[2].slice(0, 32)) } catch { throw Error('图片编码无效。') }
 const png = [137,80,78,71,13,10,26,10].every((v,i) => header.charCodeAt(i) === v)
 const jpeg = header.charCodeAt(0) === 255 && header.charCodeAt(1) === 216 && header.charCodeAt(2) === 255
 const decodedSize = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0)
 if (decodedSize > NOTE_IMAGE_MAX_BYTES || (match[1] === 'png' ? !png : !jpeg)) throw Error('图片内容与格式不符。')
 return dataUrl
}
export function validateNotebook(value: unknown): Notebook {
 const root = object(value), ids = new Set<string>()
 let pageCount = 0, blockCount = 0, textCount = 0
 const id = (raw: unknown) => { if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw) || ids.has(raw)) throw Error('笔记标识无效或重复。'); ids.add(raw); return raw }
 const list = (raw: unknown, max: number) => { if (!Array.isArray(raw) || !raw.length || raw.length > max) throw Error('笔记分区、页面或内容数量无效。'); return raw }
 if (root.format !== 'open-office-notebook' || root.version !== 1) throw Error('此笔记格式或版本暂不支持。请选择 .oonote 文件。')
 const result: Notebook = { format: 'open-office-notebook', version: 1, id: id(root.id), title: text(root.title, 200), sections: [] }
 result.sections = list(root.sections, 100).map(rawSection => {
  const section = object(rawSection)
  return { id: id(section.id), title: text(section.title, 200), pages: list(section.pages, 2000).map(rawPage => {
   if (++pageCount > 2000) throw Error('笔记页面过多。')
   const page = object(rawPage)
   return { id: id(page.id), title: text(page.title, 200), blocks: list(page.blocks, 20000).map(rawBlock => {
    if (++blockCount > 20000) throw Error('笔记内容块过多。')
    const block = object(rawBlock), blockId = id(block.id)
    if (block.type === 'image') return { id: blockId, type: 'image' as const, dataUrl: validateImage(block.dataUrl), alt: text(block.alt, 200) }
    if (!['paragraph','heading','bullet','numbered','todo'].includes(String(block.type)) || !Array.isArray(block.content) || block.content.length > 20000) throw Error('笔记内容格式无效。')
    const content: NoteInline[] = block.content.map(rawInline => {
     const inline = object(rawInline), value = text(inline.text, 1000000)
     textCount += value.length
     if (textCount > 8000000) throw Error('笔记文字过多。')
     if (inline.marks !== undefined && (!Array.isArray(inline.marks) || inline.marks.some(mark => typeof mark !== 'string' || !marks.includes(mark)))) throw Error('笔记文字格式不受支持。')
     const style = marks.filter(mark => (inline.marks as unknown[] | undefined)?.includes(mark)) as NoteMark[]
     return style.length ? { text: value, marks: style } : { text: value }
    })
    const result: NoteTextBlock = { id: blockId, type: block.type as NoteTextBlock['type'], content }
    if (result.type === 'heading') { if (![1,2,3].includes(block.level as number)) throw Error('笔记标题层级无效。'); result.level = block.level as 1|2|3 }
    if (result.type === 'todo') { if (typeof block.checked !== 'boolean') throw Error('待办状态无效。'); result.checked = block.checked }
    return result
   }) }
  }) }
 })
 if (new TextEncoder().encode(JSON.stringify(result)).length > NOTE_MAX_BYTES) throw Error('笔记文件不能超过 16 MB。')
 return result
}
export function decodeNotebook(bytes: Uint8Array): Notebook {
 if (!bytes.length || bytes.length > NOTE_MAX_BYTES) throw Error('笔记文件为空或超过 16 MB。')
 let value: unknown
 try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw Error('笔记文件不是有效的 UTF-8 JSON。') }
 return validateNotebook(value)
}
export function encodeNotebook(notebook: Notebook): Uint8Array { return new TextEncoder().encode(JSON.stringify(validateNotebook(notebook))) }
export function pageText(page: NotePage): string { return [page.title, ...page.blocks.map(block => block.type === 'image' ? block.alt : block.content.map(inline => inline.text).join(''))].join('\n') }
