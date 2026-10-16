/** Portable notebook format. Only this data model is persisted; HTML is never stored. */
export type NoteMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code'
export type NoteInline = { text: string; marks?: NoteMark[] }
export type NoteTextBlock = { id: string; type: 'paragraph' | 'heading' | 'bullet' | 'numbered' | 'todo'; content: NoteInline[]; level?: 1 | 2 | 3; checked?: boolean }
export type NoteBlock = NoteTextBlock | { id: string; type: 'image'; dataUrl: string; alt: string }
export type NoteRegion = { id: string; x: number; y: number; width: number; height?: number; blocks: NoteBlock[] }
export type NotePage = { id: string; title: string; parentId?: string; regions: NoteRegion[] }
export type NoteSection = { id: string; title: string; pages: NotePage[] }
export type Notebook = { format: 'open-office-notebook'; version: 2; id: string; title: string; sections: NoteSection[] }
export const NOTE_MAX_BYTES = 16 * 1024 * 1024
export const NOTE_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const NOTE_MAX_CANVAS = 20000
export const NOTE_MIN_REGION_WIDTH = 80
export const NOTE_MIN_REGION_HEIGHT = 40
/** Maximum number of page levels, including the root page at depth 0. */
export const NOTE_MAX_PAGE_DEPTH = 8
const marks: readonly string[] = ['bold', 'italic', 'underline', 'strike', 'code']
let sequence = 0
export function noteId(): string { return `n_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}_${(++sequence).toString(36)}`}` }
export function blankBlock(): NoteTextBlock { return { id: noteId(), type: 'paragraph', content: [] } }
export function blankRegion(x = 24, y = 24, width = 480): NoteRegion { return { id: noteId(), x, y, width, blocks: [blankBlock()] } }
export function blankPage(title = '无标题页面'): NotePage { return { id: noteId(), title, regions: [blankRegion()] } }
export function createNotebook(title = '我的笔记本'): Notebook { return { format: 'open-office-notebook', version: 2, id: noteId(), title, sections: [{ id: noteId(), title: '日常笔记', pages: [blankPage()] }] } }
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
/** Preorder follows the stored sibling order, even when a child precedes its parent in the file. */
export function pageHierarchy(pages: NotePage[]): { page: NotePage; depth: number }[] {
 const children = new Map<string | undefined, NotePage[]>()
 for (const page of pages) { const siblings = children.get(page.parentId) ?? []; siblings.push(page); children.set(page.parentId, siblings) }
 const result: { page: NotePage; depth: number }[] = [], seen = new Set<string>()
 const visit = (page: NotePage, depth: number) => {
  if (seen.has(page.id)) return
  seen.add(page.id); result.push({ page, depth })
  for (const child of children.get(page.id) ?? []) visit(child, depth + 1)
 }
 for (const page of children.get(undefined) ?? []) visit(page, 0)
 return result
}
export function descendantPageIds(pages: NotePage[], pageId: string): Set<string> {
 const result = new Set<string>([pageId]), children = new Map<string, string[]>()
 for (const page of pages) if (page.parentId) { const siblings = children.get(page.parentId) ?? []; siblings.push(page.id); children.set(page.parentId, siblings) }
 const pending = [pageId]
 while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!result.has(child)) { result.add(child); pending.push(child) }
 return result
}
function validateHierarchy(pages: NotePage[]): void {
 const byId = new Map(pages.map(page => [page.id, page]))
 for (const page of pages) {
  const ancestors = new Set([page.id])
  let parentId = page.parentId
  while (parentId !== undefined) {
   const parent = byId.get(parentId)
   if (!parent) throw Error('子页面的父页面必须位于同一分区。')
   if (ancestors.has(parentId)) throw Error('子页面不能循环引用父页面。')
   ancestors.add(parentId)
   if (ancestors.size > NOTE_MAX_PAGE_DEPTH) throw Error('页面最多支持 8 层（包含根页面）。')
   parentId = parent.parentId
  }
 }
}
/** Migration retains every block and mark, separating images from each contiguous text run. */
function migrateRegions(pageId: string, blocks: NoteBlock[], ids: Set<string>): NoteRegion[] {
 const runs: NoteBlock[][] = []
 for (const block of blocks) {
  const previous = runs.at(-1)
  if (block.type !== 'image' && previous?.[0].type !== 'image' && previous) previous.push(block)
  else runs.push([block])
 }
 const estimated = runs.map(run => run[0].type === 'image' ? 240 : Math.max(60, run.reduce((height, block) => {
  if (block.type === 'image') return height + 240
  const fontSize = block.type === 'heading' ? ({ 1:27, 2:22, 3:18 }[block.level ?? 1]) : 15
  const available = ['bullet', 'numbered', 'todo'].includes(block.type) ? 420 : 456
  const lines = block.content.map(inline => inline.text).join('').split(/\r\n?|\n/).reduce((sum, line) => {
   let width = 0
   // CJK and emoji occupy roughly a full em; ASCII is narrower. Reserve a
   // little extra width for bold text and retain explicit empty lines.
   for (const character of line) width += fontSize * (character === '\t' ? 4 : character.codePointAt(0)! < 128 ? 0.65 : 1.1)
   return sum + Math.max(1, Math.ceil(width / available))
  }, 0)
  return height + lines * Math.ceil(fontSize * 1.85) + (block.type === 'heading' ? 28 : 16)
 }, 20)))
 // Very large legacy pages use a grid so all origins remain reachable on the canvas.
 const grid = estimated.reduce((sum, height) => sum + height + 24, 24) > NOTE_MAX_CANVAS - 24
 const columns = grid ? Math.ceil(Math.sqrt(runs.length)) : 1
 const pitch = grid ? Math.min(504, (NOTE_MAX_CANVAS - 48) / columns) : 0
 let y = 24
 return runs.map((run, index) => {
  const stem = `region_${pageId.slice(0, 72)}_${index + 1}`
  let regionId = stem, suffix = 1
  while (ids.has(regionId)) regionId = `${stem}_${suffix++}`
  ids.add(regionId)
  const image = run[0].type === 'image'
  const region: NoteRegion = { id: regionId, x: grid ? 24 + (index % columns) * pitch : 24, y: grid ? 24 + Math.floor(index / columns) * pitch : y, width: grid ? pitch - 8 : image ? 320 : 480, blocks: run }
  if (image) region.height = grid ? Math.min(240, pitch - 8) : 240
  y += estimated[index] + 24
  return region
 })
}
export function validateNotebook(value: unknown): Notebook {
 const root = object(value), ids = new Set<string>(), legacyPages: { page: NotePage; blocks: NoteBlock[] }[] = []
 let pageCount = 0, regionCount = 0, blockCount = 0, textCount = 0
 const id = (raw: unknown) => { if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw) || ids.has(raw)) throw Error('笔记标识无效或重复。'); ids.add(raw); return raw }
 const list = (raw: unknown, max: number) => { if (!Array.isArray(raw) || !raw.length || raw.length > max) throw Error('笔记分区、页面或内容数量无效。'); return raw }
 const geometry = (raw: unknown, minimum: number) => { if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < minimum || raw > NOTE_MAX_CANVAS) throw Error('笔记区域的位置或尺寸无效。'); return raw }
 const blocks = (raw: unknown): NoteBlock[] => list(raw, 20000).map(rawBlock => {
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
 })
 if (root.format !== 'open-office-notebook' || (root.version !== 1 && root.version !== 2)) throw Error('此笔记格式或版本暂不支持。请选择 .oonote 文件。')
 const result: Notebook = { format: 'open-office-notebook', version: 2, id: id(root.id), title: text(root.title, 200), sections: [] }
 result.sections = list(root.sections, 100).map(rawSection => {
  const section = object(rawSection), sectionId = id(section.id)
  const pages = list(section.pages, 2000).map(rawPage => {
   if (++pageCount > 2000) throw Error('笔记页面过多。')
   const page = object(rawPage), result: NotePage = { id: id(page.id), title: text(page.title, 200), regions: [] }
   if (root.version === 1) legacyPages.push({ page: result, blocks: blocks(page.blocks) })
   else {
    if (page.parentId !== undefined) { if (typeof page.parentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(page.parentId)) throw Error('子页面的父页面标识无效。'); result.parentId = page.parentId }
    result.regions = list(page.regions, 20000).map(rawRegion => {
     if (++regionCount > 20000) throw Error('笔记区域过多。')
     const region = object(rawRegion)
     const result: NoteRegion = { id: id(region.id), x: geometry(region.x, 0), y: geometry(region.y, 0), width: geometry(region.width, NOTE_MIN_REGION_WIDTH), blocks: blocks(region.blocks) }
     if (region.height !== undefined) result.height = geometry(region.height, NOTE_MIN_REGION_HEIGHT)
     if (result.x + result.width > NOTE_MAX_CANVAS || result.y + (result.height ?? NOTE_MIN_REGION_HEIGHT) > NOTE_MAX_CANVAS) throw Error('笔记区域超出画布范围。')
     if (result.blocks.some(block => block.type === 'image') && (result.blocks.length !== 1 || result.blocks[0].type !== 'image')) throw Error('每张图片必须放在独立区域中。')
     if (result.blocks[0].type === 'image' && result.height === undefined) throw Error('图片区域必须提供完整尺寸。')
     return result
    })
   }
   return result
  })
  validateHierarchy(pages)
  return { id: sectionId, title: text(section.title, 200), pages }
 })
 // Allocate migration identities after all source identities have been reserved.
 for (const { page, blocks } of legacyPages) page.regions = migrateRegions(page.id, blocks, ids)
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
export function pageText(page: NotePage): string { return [page.title, ...page.regions.flatMap(region => region.blocks.map(block => block.type === 'image' ? block.alt : block.content.map(inline => inline.text).join('')))].join('\n') }
