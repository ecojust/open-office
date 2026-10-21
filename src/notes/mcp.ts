import { blankPage, blankRegion, descendantPageIds, noteId, noteTitle, type Notebook, type NoteBlock, type NotePage, type NoteRegion, type NoteSection } from './model.ts'

export type NoteEditOperation =
 | { op: 'notebook.rename'; title: string }
 | { op: 'section.add'; id?: string; title: string; index?: number }
 | { op: 'section.rename'; sectionId: string; title: string }
 | { op: 'section.delete'; sectionId: string }
 | { op: 'section.move'; sectionId: string; index: number }
 | { op: 'page.add'; sectionId: string; id?: string; title: string; parentId?: string; index?: number }
 | { op: 'page.rename'; pageId: string; title: string }
 | { op: 'page.delete'; pageId: string }
 | { op: 'page.move'; pageId: string; sectionId: string; parentId?: string | null; index?: number }
 | { op: 'region.add'; pageId: string; region: Omit<NoteRegion, 'id' | 'blocks'> & { id?: string; blocks?: NoteBlock[] }; index?: number }
 | { op: 'region.update'; regionId: string; patch: Partial<Omit<NoteRegion, 'id' | 'height'>> & { height?: number | null } }
 | { op: 'region.delete'; regionId: string }
 | { op: 'region.move'; regionId: string; pageId: string; index?: number }

function insert<T>(items: T[], value: T, index = items.length) {
 if (!Number.isInteger(index) || index < 0 || index > items.length) throw Error('插入位置超出范围。')
 items.splice(index, 0, value)
}
export function findNotePage(notebook: Notebook, id: string): { section: NoteSection; page: NotePage } {
 for (const section of notebook.sections) { const page = section.pages.find(page => page.id === id); if (page) return { section, page } }
 throw Error(`笔记页面不存在：${id}`)
}
function findSection(notebook: Notebook, id: string): NoteSection {
 const section = notebook.sections.find(section => section.id === id)
 if (!section) throw Error(`笔记分区不存在：${id}`)
 return section
}
function findRegion(notebook: Notebook, id: string) {
 for (const section of notebook.sections) for (const page of section.pages) {
  const region = page.regions.find(region => region.id === id)
  if (region) return { section, page, region }
 }
 throw Error(`笔记区域不存在：${id}`)
}
/** Called only on a session's detached transaction draft. Final model validation is
 * performed once by NotebookSession; any invalid operation rolls back the batch. */
export function editNotebook(notebook: Notebook, operations: readonly NoteEditOperation[]) {
 if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw Error('一次笔记编辑需要 1–100 项操作。')
 const created: { type: 'section' | 'page' | 'region'; id: string }[] = []
 let pageId: string | undefined
 for (const operation of operations) {
  switch (operation.op) {
   case 'notebook.rename': notebook.title = noteTitle(operation.title); break
   case 'section.add': {
    const section: NoteSection = { id: operation.id ?? noteId(), title: noteTitle(operation.title), pages: [blankPage()] }
    insert(notebook.sections, section, operation.index); created.push({ type: 'section', id: section.id }, { type: 'page', id: section.pages[0]!.id }); pageId = section.pages[0]!.id; break
   }
   case 'section.rename': findSection(notebook, operation.sectionId).title = noteTitle(operation.title); break
   case 'section.delete': {
    findSection(notebook, operation.sectionId); notebook.sections = notebook.sections.filter(section => section.id !== operation.sectionId)
    if (!notebook.sections.length) notebook.sections.push({ id: noteId(), title: '日常笔记', pages: [blankPage()] })
    break
   }
   case 'section.move': {
    const section = findSection(notebook, operation.sectionId); notebook.sections.splice(notebook.sections.indexOf(section), 1); insert(notebook.sections, section, operation.index); break
   }
   case 'page.add': {
    const section = findSection(notebook, operation.sectionId), page = blankPage(operation.title)
    if (operation.id !== undefined) page.id = operation.id
    if (operation.parentId !== undefined) page.parentId = operation.parentId
    insert(section.pages, page, operation.index); created.push({ type: 'page', id: page.id }); pageId = page.id; break
   }
   case 'page.rename': { const { page } = findNotePage(notebook, operation.pageId); page.title = operation.title; pageId = page.id; break }
   case 'page.delete': {
    const { section, page } = findNotePage(notebook, operation.pageId), removing = descendantPageIds(section.pages, page.id)
    section.pages = section.pages.filter(page => !removing.has(page.id)); if (!section.pages.length) section.pages.push(blankPage()); break
   }
   case 'page.move': {
    const { section, page } = findNotePage(notebook, operation.pageId), destination = findSection(notebook, operation.sectionId), ids = descendantPageIds(section.pages, page.id)
    if (operation.parentId && ids.has(operation.parentId)) throw Error('页面不能移动到自己或子页面中。')
    const moving = section.pages.filter(item => ids.has(item.id)); section.pages = section.pages.filter(item => !ids.has(item.id))
    if (operation.parentId) page.parentId = operation.parentId; else delete page.parentId
    const index = operation.index ?? destination.pages.length
    if (!Number.isInteger(index) || index < 0 || index > destination.pages.length) throw Error('页面位置超出范围。')
    destination.pages.splice(index, 0, ...moving)
    if (!section.pages.length) section.pages.push(blankPage())
    pageId = page.id; break
   }
   case 'region.add': {
    const { page } = findNotePage(notebook, operation.pageId), region = { ...blankRegion(), ...structuredClone(operation.region), id: operation.region.id ?? noteId() }
    insert(page.regions, region, operation.index); created.push({ type: 'region', id: region.id }); pageId = page.id; break
   }
   case 'region.update': {
    const target = findRegion(notebook, operation.regionId), patch = structuredClone(operation.patch)
    Object.assign(target.region, patch)
    if (patch.height === null) delete target.region.height
    pageId = target.page.id; break
   }
   case 'region.delete': {
    const { page, region } = findRegion(notebook, operation.regionId); page.regions.splice(page.regions.indexOf(region), 1)
    if (!page.regions.length) page.regions.push(blankRegion())
    pageId = page.id; break
   }
   case 'region.move': {
    const { page, region } = findRegion(notebook, operation.regionId), destination = findNotePage(notebook, operation.pageId).page
    page.regions.splice(page.regions.indexOf(region), 1); insert(destination.regions, region, operation.index)
    if (!page.regions.length) page.regions.push(blankRegion())
    pageId = destination.id; break
   }
   default: throw Error('不支持的笔记编辑操作。')
  }
 }
 return { created, pageId }
}
