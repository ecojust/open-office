<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import NotebookCanvas from './NotebookCanvas.vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { useDialogFocus } from '../shared/dialog-focus'
import { base64ToBytes, bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { printHtml, type PrintOutcome } from '../shared/printing'
import { blankPage, blankRegion, descendantPageIds, noteId, noteTitle, pageHierarchy, pageText, NOTE_MAX_PAGE_DEPTH, type Notebook, type NoteRegion } from '../notes/model'
import { NotebookSession } from '../notes/session'
import { renderBlocks } from '../notes/dom'
import { noteSearchMatches, searchSegments } from '../notes/search'

const props = withDefaults(defineProps<{ document: NativeDocument; active?: boolean; disabled?: boolean; theme?: Appearance }>(), { active: true, disabled: false, theme: 'system' })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: 'new'|'open'|'save'|'saveAs'|'print'|'close'] }>()
const canvas = ref<InstanceType<typeof NotebookCanvas>>(), titleInput = ref<HTMLInputElement>(), searchInput = ref<HTMLInputElement>(), dialogInput = ref<HTMLInputElement>()
const dialogElement = ref<HTMLElement>(), pageMenuElement = ref<HTMLElement>()
useDialogFocus(dialogElement)
const model = shallowRef<Notebook>(), currentSection = ref(''), currentPage = ref(''), query = ref(''), navigation = ref(false)
const bodyComposing = ref(false), titleComposing = ref(false), canvasBusy = ref(false), loading = ref(true), problem = ref(''), pending = ref(false), titlePending = ref(false)
const composing = computed(() => bodyComposing.value || titleComposing.value)
const undoAvailable = ref(false), redoAvailable = ref(false), dirty = ref(false), titleScroll = ref(0)
const smartAlignment = ref(true), snapToGrid = ref(true)
// Invalid titles remain editable drafts when shell barriers cause a rerender.
const titleDraft = ref<string>()
const dialog = ref<{ title: string; message?: string; value: string; destructive: boolean; apply: (value: string) => void }>()
const pageMenu = ref<{ sectionId: string; pageId: string; x: number; y: number }>()
let menuTrigger: HTMLElement | undefined
let session: NotebookSession | undefined, disposed = false, token = 0
let lastExport: { token: number; base64: string; revision: number } | undefined
const section = computed(() => model.value?.sections.find(item => item.id === currentSection.value))
const page = computed(() => section.value?.pages.find(item => item.id === currentPage.value))
const orderedPages = computed(() => pageHierarchy(section.value?.pages ?? []))
const titleParts = computed(() => searchSegments(titleDraft.value ?? page.value?.title ?? '', query.value))
const results = computed(() => {
 const needle = query.value.trim()
 if (!needle || !model.value) return []
 return model.value.sections.flatMap(section => pageHierarchy(section.pages).filter(({page}) => noteSearchMatches(pageText(page), needle).length > 0).map(({page,depth}) => ({ section, page, depth })))
})
// Gestures and image decoding block saves/navigation, but must not disable the
// canvas that owns the operation before it can finish or cancel it.
const editable = computed(() => props.active && !props.disabled && !loading.value && !dialog.value)
const controlsReady = computed(() => editable.value && !composing.value && !canvasBusy.value)
function report(cause: unknown) {
 if (disposed) return
 problem.value = cause instanceof Error ? cause.message : String(cause)
 if (loading.value) emit('error', problem.value)
}
function accept() {
 if (!session) return
 model.value = session.model
 const state = session.inspect(); undoAvailable.value = state.canUndo; redoAvailable.value = state.canRedo
 dirty.value = state.dirty || pending.value || titlePending.value || composing.value || canvasBusy.value
 emit('dirty', dirty.value)
}
function change(edit: (copy: Notebook) => void) {
 if (!session) return
 session.change(edit); accept(); problem.value = ''
}
function commitRegions(regions: NoteRegion[]): boolean {
 const id = currentPage.value
 try {
  change(copy => { const target = copy.sections.flatMap(section => section.pages).find(page => page.id === id); if (!target) throw Error('页面已切换，请重新操作。'); target.regions = regions })
  pending.value = false; accept(); return true
 } catch (cause) { report(cause); return false }
}
function render() { titleScroll.value = 0; canvas.value?.refresh() }
function commitBody(): boolean { return canvas.value?.flush() !== false && !pending.value && !titlePending.value }
function titleChanged(event: Event) {
 const value = (event.target as HTMLInputElement).value
 titleDraft.value = value
 try {
  if (Array.from(value).length > 200) throw Error('页面标题不能超过 200 字。')
  const id = currentPage.value
  change(copy => { const target = copy.sections.flatMap(item => item.pages).find(item => item.id === id); if (target) target.title = value })
  titlePending.value = false; titleDraft.value = undefined; accept()
 } catch (cause) { titlePending.value = true; accept(); report(cause) }
}
function requireReady() {
 if (!session || loading.value || disposed) throw Error('请等待笔记打开。')
 if (composing.value) throw Error('请先确认输入法文字，再保存笔记。')
 if (pending.value || titlePending.value || dialog.value || canvasBusy.value) throw Error('请先完成当前笔记操作。')
}
async function selectPage(sectionId: string, pageId: string) {
 if (!controlsReady.value || !commitBody()) return
 closePageMenu(); currentSection.value = sectionId; currentPage.value = pageId; navigation.value = false
 await nextTick(); render()
 if (query.value.trim() && !noteSearchMatches(page.value?.title ?? '',query.value).length) canvas.value?.revealMatch()
}
function openDialog(title: string, value: string, apply: (value: string) => void, message?: string) {
 if (!controlsReady.value || !commitBody()) return
 closePageMenu(); dialog.value = { title, value, apply, destructive: !!message, message }
 nextTick(() => { dialogInput.value?.focus(); dialogInput.value?.select() })
}
function confirmDialog() {
 const current = dialog.value; if (!current) return
 try { current.apply(current.destructive ? '' : noteTitle(current.value)); dialog.value = undefined; nextTick(render) } catch (cause) { report(cause) }
}
function addSection() {
 openDialog('新建分区', '新分区', value => {
  const newSection = { id: noteId(), title: value, pages: [blankPage()] }
  change(copy => copy.sections.push(newSection)); currentSection.value = newSection.id; currentPage.value = newSection.pages[0].id
 })
}
function addPage(parentId?: string, sectionId = currentSection.value) {
 if (!controlsReady.value || !section.value || !commitBody()) return
 try {
  const value = blankPage()
  if (parentId) value.parentId = parentId
  change(copy => {
   const target = copy.sections.find(item => item.id === sectionId)
   if (!target) throw Error('分区已切换，请重新操作。')
   const parent = pageHierarchy(target.pages).find(item => item.page.id === parentId)
   if (parentId && (!parent || parent.depth >= NOTE_MAX_PAGE_DEPTH - 1)) throw Error(`子页面最多支持 ${NOTE_MAX_PAGE_DEPTH} 层。`)
   target.pages.push(value)
  })
  closePageMenu(); currentSection.value = sectionId; currentPage.value = value.id
  nextTick(() => { render(); titleInput.value?.focus(); titleInput.value?.select() })
 } catch (cause) { report(cause); closePageMenu() }
}
function openPageMenu(event: MouseEvent | KeyboardEvent, pageId: string) {
 if (!controlsReady.value) return
 event.preventDefault(); menuTrigger = event.currentTarget as HTMLElement
 const rect = menuTrigger.getBoundingClientRect()
 const x = event instanceof MouseEvent && event.clientX ? event.clientX : rect.left + 24
 const y = event instanceof MouseEvent && event.clientY ? event.clientY : rect.bottom
 pageMenu.value = { sectionId: currentSection.value, pageId, x: Math.max(8,Math.min(x,window.innerWidth-208)), y:Math.max(8,Math.min(y,window.innerHeight-64)) }
 nextTick(() => pageMenuElement.value?.querySelector<HTMLElement>('[role=menuitem]')?.focus())
}
function closePageMenu(restoreFocus = false) {
 pageMenu.value = undefined
 if (restoreFocus && menuTrigger?.isConnected) menuTrigger.focus({preventScroll:true})
}
function dismissMenu(event: PointerEvent) { if (!(event.target as Element).closest('.note-page-menu')) closePageMenu() }
function pageMenuKeyboard(event: KeyboardEvent) {
 if (['Escape','Tab'].includes(event.key)) { if(event.key==='Escape') event.preventDefault(); closePageMenu(true) }
 else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); pageMenuElement.value?.querySelector<HTMLElement>('[role=menuitem]')?.focus() }
}
function renameSection() {
 const target = section.value; if (!target) return
 openDialog('重命名分区', target.title, value => change(copy => { copy.sections.find(item => item.id === target.id)!.title = value }))
}
function deleteSection() {
 const target = section.value; if (!target || !model.value) return
 openDialog('删除分区', '', () => {
  change(copy => { copy.sections = copy.sections.filter(item => item.id !== target.id); if (!copy.sections.length) copy.sections.push({ id: noteId(), title: '日常笔记', pages: [blankPage()] }) })
  currentSection.value = model.value!.sections[0].id; currentPage.value = model.value!.sections[0].pages[0].id
 }, `删除“${target.title}”及其中 ${target.pages.length} 个页面？可以使用撤销恢复。`)
}
function deletePage() {
 const target = page.value, owner = section.value; if (!target || !owner) return
 const ids = descendantPageIds(owner.pages, target.id)
 openDialog('删除页面', '', () => {
  change(copy => { const targetSection = copy.sections.find(item => item.id === owner.id)!; targetSection.pages = targetSection.pages.filter(item => !ids.has(item.id)); if (!targetSection.pages.length) targetSection.pages.push(blankPage()) })
  currentPage.value = section.value!.pages.find(item=>item.id===target.parentId)?.id ?? section.value!.pages[0].id
 }, `删除“${target.title || '无标题页面'}”${ids.size>1 ? `及其 ${ids.size-1} 个子页面` : ''}的全部内容？可以使用撤销恢复。`)
}
function removeRegion(id: string) {
 const target = page.value?.regions.find(region=>region.id===id), pageId = currentPage.value
 if (!target) return
 const image = target.blocks[0]?.type === 'image'
 openDialog(image ? '删除图片' : '删除内容区域', '', () => change(copy => {
  const targetPage = copy.sections.flatMap(section=>section.pages).find(page=>page.id===pageId)!
  targetPage.regions = targetPage.regions.filter(region=>region.id!==id)
  if (!targetPage.regions.length) targetPage.regions.push(blankRegion())
 }), image ? '删除这张图片？可以使用撤销恢复。' : '删除这个区域及其中的全部内容？可以使用撤销恢复。')
}
function format(command: string, value?: string) { if (controlsReady.value) canvas.value?.format(command,value) }
function rememberSelection() { canvas.value?.rememberSelection() }
function todo() { if (controlsReady.value) canvas.value?.todo() }
function chooseImage() { if (controlsReady.value) canvas.value?.chooseImage() }
function addText() { if (controlsReady.value) canvas.value?.addText() }
function refreshSelection() {
 if (!model.value) return
 let selected = model.value.sections.find(item => item.id === currentSection.value) ?? model.value.sections[0]
 if (!selected.pages.some(item => item.id === currentPage.value)) {
  const owner = model.value.sections.find(item => item.pages.some(page => page.id === currentPage.value))
  if (owner) selected = owner
  else currentPage.value = selected.pages[0].id
 }
 currentSection.value = selected.id
}
async function undo() { requireReady(); if (session!.undo()) { accept(); refreshSelection(); await nextTick(); render() } }
async function redo() { requireReady(); if (session!.redo()) { accept(); refreshSelection(); await nextTick(); render() } }
function keydown(event: KeyboardEvent) {
 if (!controlsReady.value || event.defaultPrevented) return
 if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); void (event.shiftKey ? redo() : undo()).catch(report) }
 else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); void redo().catch(report) }
}
async function inspect() { if (!session) throw Error('请等待笔记打开。'); return { ...session.inspect(), dirty: session.inspect().dirty || composing.value || pending.value || titlePending.value || canvasBusy.value } }
async function canBackgroundExport() { return !!session && !disposed && !loading.value && !composing.value && !pending.value && !titlePending.value && !dialog.value && !canvasBusy.value }
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
 requireReady()
 if (options.format && options.format !== 'oonote') throw Error('笔记支持保存为 .oonote；如需 PDF，请使用打印功能。')
 const result = session!.export(), base64 = bytesToBase64(result.bytes)
 lastExport = { token, base64, revision: result.snapshot.revision }
 return { base64, extension: 'oonote', name: props.document.name.replace(/\.[^.]+$/, '') + '.oonote', dirty: result.snapshot.dirty, revision: `${result.snapshot.documentId}:${result.snapshot.revision}` }
}
async function markSaved(base64?: string, _options: { background?: boolean } = {}) {
 requireReady()
 if (!lastExport || lastExport.token !== token || base64 !== lastExport.base64) throw Error('保存回执与当前笔记不匹配，请重新保存。')
 session!.markSaved(base64ToBytes(base64)); accept()
}
async function prepareDeactivate() {
 if (!commitBody()) throw Error('请先完成当前笔记操作。')
 requireReady()
 return session!.inspect()
}
async function discardChanges(options: { force?: boolean } = {}) {
 if (options.force) { token++; bodyComposing.value = false; titleComposing.value = false; pending.value = false; titlePending.value = false; titleDraft.value = undefined; return }
 if ((await prepareDeactivate()).dirty) throw Error('笔记还有未保存的修改，请先保存或确认不保存后关闭。')
}
async function search(value: string) { query.value = value; navigation.value = true; await nextTick(); searchInput.value?.focus() }
async function print(): Promise<PrintOutcome> {
 await prepareDeactivate()
 if (!page.value) throw Error('请先选择要打印的笔记页面。')
 const current = structuredClone(page.value), owner = token
 const width = Math.max(720,...current.regions.map(region=>region.x+region.width+24))
 return await printHtml({
  title: current.title || '无标题页面',
  css: '@media print{@page{size:A4 portrait;margin:12mm}}#office-print-root{font:15px/1.85 system-ui,sans-serif;color:#111;box-sizing:border-box;padding:24px}#office-print-root .note-print-page{position:relative;transform-origin:top left}#office-print-root section{position:absolute;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 12px}#office-print-root img{display:block;width:100%;height:100%;object-fit:contain}#office-print-root figure{margin:0;width:100%;height:100%}#office-print-root h1{font-size:27px;line-height:1.4}#office-print-root h2{font-size:22px}#office-print-root h3{font-size:18px}#office-print-root input{margin-right:10px}#office-print-root code{background:#eee;padding:2px 5px}',
  render(output, container) {
   const heading = output.createElement('h1'); heading.textContent = current.title || '无标题页面'
   const content = output.createElement('main'); content.className = 'note-print-page'; content.style.width = `${width}px`
   for(const region of current.regions) {
    const element = output.createElement('section'); element.style.cssText = `left:${region.x}px;top:${region.y}px;width:${region.width}px;${region.height ? `height:${region.height}px;` : ''}`
    if(region.blocks[0]?.type==='image') element.style.padding='0'
    element.append(renderBlocks(output,region.blocks,false)); content.append(element)
   }
   container.append(heading,content)
  },
  prepare(container) {
   if (disposed || owner !== token || current.id !== currentPage.value) throw Error('笔记页面已切换，请重新打印。')
   const content = container.querySelector<HTMLElement>('.note-print-page')!
   const height = Math.max(100,...[...content.children].map(element=>{const node=element as HTMLElement;return node.offsetTop+node.offsetHeight+24}))
   content.style.height=`${height}px`; content.style.zoom=String(Math.min(1,720/width))
  },
 })
}
function focus() { canvas.value?.focus() }
watch(()=>[props.active,props.disabled],()=>{if(!controlsReady.value)closePageMenu()})
watch(() => props.document.id, async () => {
 const owner = ++token; loading.value = true
 try {
  const next = new NotebookSession(props.document.base64 ? base64ToBytes(props.document.base64) : undefined, props.document.name.replace(/\.[^.]+$/, ''))
  if (disposed || owner !== token) return
  session = next; lastExport = undefined; bodyComposing.value = false; titleComposing.value = false; pending.value = false; titlePending.value = false; titleDraft.value = undefined; canvasBusy.value = false; dialog.value = undefined; pageMenu.value=undefined; query.value=''; problem.value = ''
  currentSection.value = next.model.sections[0].id; currentPage.value = next.model.sections[0].pages[0].id; accept()
  await nextTick(); render(); emit('ready')
 } catch (cause) { report(cause) } finally { if (owner === token) loading.value = false }
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; token++ })
defineExpose({ prepareDeactivate, exportFile, markSaved, discardChanges, inspect, syncRevision: inspect, canBackgroundExport, undo, redo, search, print, focus })
</script>

<template>
 <section class="notebook-editor" :data-theme="theme" :data-document-id="document.id" data-testid="notebook-editor" @keydown="keydown" @pointerdown.capture="dismissMenu">
  <header class="note-toolbar" aria-label="笔记格式工具栏">
   <button class="note-navigation-toggle" title="分区与页面" aria-label="分区与页面" @click="navigation = !navigation"><Icon name="menu" :size="18" /></button>
   <button title="撤销 (Ctrl/⌘ Z)" aria-label="撤销" :disabled="!controlsReady || !undoAvailable" @mousedown.prevent @click="undo().catch(report)"><Icon name="undo" :size="18" /></button>
   <button title="重做" aria-label="重做" :disabled="!controlsReady || !redoAvailable" @mousedown.prevent @click="redo().catch(report)"><Icon name="redo" :size="18" /></button>
   <span class="note-separator" />
   <select aria-label="段落样式" :disabled="!controlsReady" @mousedown="rememberSelection" @change="format('formatBlock', ($event.target as HTMLSelectElement).value)">
    <option value="div">正文</option><option value="h1">大标题</option><option value="h2">小标题</option><option value="h3">三级标题</option>
   </select>
   <button title="加粗" aria-label="加粗" :disabled="!controlsReady" @mousedown.prevent @click="format('bold')"><Icon name="bold" :size="18" /></button>
   <button title="斜体" aria-label="斜体" :disabled="!controlsReady" @mousedown.prevent @click="format('italic')"><Icon name="italic" :size="18" /></button>
   <button title="下划线" aria-label="下划线" :disabled="!controlsReady" @mousedown.prevent @click="format('underline')"><Icon name="underline" :size="18" /></button>
   <button title="删除线" aria-label="删除线" :disabled="!controlsReady" @mousedown.prevent @click="format('strikeThrough')"><Icon name="strike" :size="18" /></button>
   <span class="note-separator" />
   <button title="项目列表" :disabled="!controlsReady" @mousedown.prevent @click="format('insertUnorderedList')"><Icon name="bullets" :size="18" /> 列表</button>
   <button title="编号列表" :disabled="!controlsReady" @mousedown.prevent @click="format('insertOrderedList')"><Icon name="numbering" :size="18" /> 编号</button>
   <button title="插入待办" :disabled="!controlsReady" @mousedown.prevent @click="todo"><Icon name="todo" :size="18" /> 待办</button>
   <button title="插入 PNG / JPEG 图片" :disabled="!controlsReady" @mousedown.prevent @click="chooseImage"><Icon name="image" :size="18" /> 图片</button>
   <button title="添加独立文本区域" aria-label="添加文本区域" :disabled="!controlsReady" @mousedown.prevent @click="addText"><Icon name="plus" :size="18" /> 文本区域</button>
   <span class="note-separator" />
   <button aria-label="智能对齐" :aria-pressed="smartAlignment" title="拖动时对齐其他区域的边缘与中心；按住 Alt / Option 暂时关闭" :disabled="!controlsReady" @mousedown.prevent @click="smartAlignment = !smartAlignment"><svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M4 5h5v5H4zM15 14h5v5h-5zM9 7.5h6M9 16.5h6" /></svg> 智能对齐</button>
   <button aria-label="网格吸附" :aria-pressed="snapToGrid" title="拖动时吸附到 10 像素网格；按住 Alt / Option 暂时关闭" :disabled="!controlsReady" @mousedown.prevent @click="snapToGrid = !snapToGrid"><svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v16H4zM9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" /></svg> 网格吸附</button>
  </header>
  <div v-if="problem" class="note-problem" role="alert">{{ problem }}<button aria-label="关闭提示" @click="problem = ''"><Icon name="close" :size="14" /></button></div>
  <div class="note-workspace" :class="{ 'show-navigation': navigation }">
   <aside class="note-sidebar" aria-label="笔记本导航">
    <div class="note-notebook-title"><Icon name="folder" :size="20" /><button :disabled="!controlsReady" title="重命名笔记本" @click="openDialog('重命名笔记本', model?.title ?? '', value => change(copy => { copy.title = value }))">{{ model?.title || '笔记本' }}</button></div>
    <label class="note-search"><Icon name="search" :size="16" /><input ref="searchInput" v-model="query" placeholder="搜索整个笔记本" aria-label="搜索整个笔记本" /></label>
    <div v-if="query.trim()" class="note-search-results" aria-label="搜索结果">
     <p>{{ results.length }} 个匹配页面</p>
     <button v-for="result in results" :key="result.page.id" :title="result.page.title || '无标题页面'" :disabled="!controlsReady" @click="selectPage(result.section.id, result.page.id)"><strong>{{ result.page.title || '无标题页面' }}</strong><small>{{ result.section.title }}</small></button>
    </div>
    <template v-else>
     <div class="note-list-heading"><span>分区</span><button title="新建分区" aria-label="新建分区" :disabled="!controlsReady" @click="addSection"><Icon name="plus" :size="16" /></button></div>
     <nav class="note-sections"><button v-for="item in model?.sections" :key="item.id" :class="{ selected: item.id === currentSection }" :disabled="!controlsReady" @click="selectPage(item.id, item.pages[0].id)"><span class="note-section-dot" />{{ item.title }}<small>{{ item.pages.length }}</small></button></nav>
     <div class="note-section-actions"><button :disabled="!controlsReady" @click="renameSection">重命名分区</button><button :disabled="!controlsReady" @click="deleteSection">删除分区</button></div>
     <div class="note-list-heading"><span>页面</span><button title="新建页面" aria-label="新建页面" :disabled="!controlsReady" @click="addPage()"><Icon name="plus" :size="16" /></button></div>
     <nav class="note-pages" aria-label="分区页面"><button v-for="item in orderedPages" :key="item.page.id" :data-page-id="item.page.id" :data-depth="item.depth" :title="item.page.title || '无标题页面'" :style="{paddingLeft:`${12+item.depth*16}px`}" :class="{ selected: item.page.id === currentPage, 'note-child-page': item.depth>0 }" :disabled="!controlsReady" aria-haspopup="menu" @click="selectPage(currentSection, item.page.id)" @contextmenu="openPageMenu($event,item.page.id)" @keydown.shift.f10="openPageMenu($event,item.page.id)" @keydown="($event.key==='ContextMenu') && openPageMenu($event,item.page.id)"><strong>{{ item.page.title || '无标题页面' }}</strong></button></nav>
    </template>
   </aside>
   <main class="note-main">
    <div class="note-page-meta"><span>{{ section?.title }} <span aria-hidden="true">/</span> {{ page?.title || '无标题页面' }}</span><button :disabled="!controlsReady" title="删除当前页面" @click="deletePage"><Icon name="trash" :size="16" /> 删除页面</button></div>
    <div class="note-paper">
     <div class="note-title-wrap">
      <div v-if="query.trim()" class="note-title-highlights" aria-hidden="true"><div :style="{transform:`translateX(${-titleScroll}px)`}"><template v-for="(part,index) in titleParts" :key="index"><mark v-if="part.match" class="note-search-mark">{{part.text}}</mark><span v-else>{{part.text}}</span></template></div></div>
      <input ref="titleInput" :value="titleDraft ?? page?.title" class="note-page-title" placeholder="无标题页面" aria-label="页面标题" :disabled="!editable || canvasBusy" @input="titleChanged" @scroll="titleScroll=($event.target as HTMLInputElement).scrollLeft" @compositionstart="titleComposing = true; accept()" @compositionend="titleComposing = false; titleChanged($event); accept()" />
     </div>
     <NotebookCanvas v-if="page" :key="page.id" ref="canvas" :page="page" :editable="editable" :query="query" :smart-alignment="smartAlignment" :snap-to-grid="snapToGrid" :commit="commitRegions" @error="report" @status="emit('status',$event)" @busy="canvasBusy=$event; accept()" @composing="bodyComposing=$event; accept()" @pending="pending=$event; accept()" @request-delete="removeRegion" @history="($event==='undo'?undo():redo()).catch(report)" />
    </div>
    <footer class="note-footer"><span>{{ page ? Array.from(pageText(page).split('\n').slice(1).join('')).length : 0 }} 字</span><span>{{ canvasBusy ? '正在编辑区域…' : composing ? '正在输入…' : dirty ? '有未保存的修改' : '已保存' }}</span><span>.oonote 笔记本</span></footer>
   </main>
  </div>
  <div v-if="pageMenu" ref="pageMenuElement" class="note-page-menu" role="menu" aria-label="页面操作" :style="{left:`${pageMenu.x}px`,top:`${pageMenu.y}px`}" @keydown.stop="pageMenuKeyboard" @contextmenu.prevent>
   <button role="menuitem" @click="addPage(pageMenu.pageId,pageMenu.sectionId)"><Icon name="plus" :size="18" /> 添加子页面</button>
  </div>
  <div v-if="dialog" class="note-modal-backdrop" @keydown.esc.prevent="dialog = undefined">
   <form ref="dialogElement" class="note-dialog" role="dialog" aria-modal="true" :aria-label="dialog.title" @submit.prevent="confirmDialog">
    <h2>{{ dialog.title }}</h2><p v-if="dialog.message">{{ dialog.message }}</p>
    <input v-else ref="dialogInput" v-model="dialog.value" :aria-label="dialog.title" autocomplete="off" />
    <div><button type="button" @click="dialog = undefined">取消</button><button type="submit" :class="{ danger: dialog.destructive }">{{ dialog.destructive ? '确认删除' : '确定' }}</button></div>
   </form>
  </div>
 </section>
</template>

<style scoped>
.notebook-editor{height:100%;min-height:0;display:flex;flex-direction:column;position:relative;background:var(--ui-bg,#f5f6fa);color:var(--ui-text,#242a3d);font-size:13px;--note-line:var(--ui-line,#e3e6ef);--note-surface:var(--ui-surface,#fff);--note-muted:var(--ui-muted,#788093);--note-accent:var(--ui-accent,#5b73e8)}
button,input,select{font:inherit;color:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:7px;background:transparent;cursor:pointer;min-height:30px;padding:5px 8px}button:hover:not(:disabled){background:color-mix(in srgb,var(--note-accent) 10%,transparent)}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--note-accent);outline-offset:2px}.note-toolbar{display:flex;align-items:center;gap:3px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--note-line);background:var(--note-surface)}.note-toolbar select{height:30px;border:1px solid var(--note-line);background:var(--note-surface);border-radius:7px;padding:2px 8px}.note-separator{height:19px;border-left:1px solid var(--note-line);margin:0 6px}.note-file-input{display:none}.note-workspace{display:flex;flex:1;min-height:0}.note-sidebar{width:252px;flex:none;border-right:1px solid var(--note-line);padding:12px;overflow:auto;background:var(--note-surface)}.note-notebook-title{display:flex;align-items:center;gap:6px;margin-bottom:10px;color:var(--note-accent)}.note-notebook-title button{font-size:15px;font-weight:600;text-align:left;justify-content:flex-start;overflow-wrap:anywhere}.note-search{display:flex;align-items:center;gap:8px;border:1px solid var(--note-line);border-radius:8px;padding:8px;color:var(--note-muted)}.note-search input{background:transparent;border:0;min-width:0;width:100%;outline:none}.note-list-heading{display:flex;justify-content:space-between;align-items:center;margin:12px 4px 4px;color:var(--note-muted);font-size:11px;font-weight:600;letter-spacing:.08em}.note-sections,.note-pages{display:flex;flex-direction:column;gap:2px}.note-sections button{justify-content:flex-start;text-align:left;min-height:32px;overflow-wrap:anywhere}.note-section-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--note-accent)}.note-sections small{margin-left:auto;color:var(--note-muted)}.note-sections .selected,.note-pages .selected{background:color-mix(in srgb,var(--note-accent) 11%,transparent);color:var(--note-accent)}.note-section-actions{display:flex;gap:4px;margin-top:6px;color:var(--note-muted);font-size:11px}.note-pages button{display:flex;align-items:center;justify-content:flex-start;height:32px;min-height:32px;box-sizing:border-box;padding:6px 12px;text-align:left;overflow:hidden;line-height:20px}.note-search-results button{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;padding:7px 12px;text-align:left;overflow:hidden;min-height:48px}.note-pages strong,.note-search-results strong{font-size:13px;font-weight:600;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.note-search-results small{color:var(--note-muted);font-size:11px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.note-search-results>p{color:var(--note-muted);font-size:11px}.note-search-results button{width:100%}.note-main{min-width:0;min-height:0;flex:1;display:flex;flex-direction:column;overflow:hidden}.note-page-meta{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 24px;color:var(--note-muted);font-size:11px}.note-page-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.note-page-meta button{flex:none}.note-paper{width:100%;min-height:0;padding:16px 24px 0;box-sizing:border-box;flex:1;display:flex;flex-direction:column}.note-page-title{font-family:var(--document-font);font-synthesis:weight style;display:block;width:100%;box-sizing:border-box;font-size:30px;line-height:1.5;font-weight:650;border:0;border-bottom:1px solid var(--note-line);padding:0 0 20px;background:transparent;outline:none;margin:0;position:relative;z-index:1}.note-footer{display:flex;gap:18px;padding:10px 24px;color:var(--note-muted);border-top:1px solid var(--note-line);font-size:11px}.note-footer span:last-child{margin-left:auto}.note-problem{padding:8px 14px;background:color-mix(in srgb,#d98a1e 12%,var(--note-surface));display:flex;justify-content:space-between;align-items:center}.note-modal-backdrop{position:absolute;inset:0;background:#18213655;display:flex;align-items:center;justify-content:center;z-index:20;padding:20px}.note-dialog{width:360px;max-width:100%;padding:24px;background:var(--note-surface);border:1px solid var(--note-line);box-shadow:0 20px 70px #0003;border-radius:16px}.note-dialog h2{margin:0 0 14px;font-size:18px}.note-dialog p{color:var(--note-muted);line-height:1.7}.note-dialog>input{width:100%;box-sizing:border-box;border:1px solid var(--note-line);background:transparent;padding:9px;border-radius:7px}.note-dialog>div{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}.note-dialog button[type=submit]{background:var(--note-accent);color:#fff;padding:7px 16px}.note-dialog button.danger{background:#c64c53}.note-navigation-toggle{display:none}@media(max-width:850px){.note-sidebar{width:220px}.note-paper{padding:12px 18px 0}.note-toolbar{padding:6px 10px;gap:1px}.note-toolbar button{font-size:12px}.note-separator{margin:0 3px}}@media(max-width:620px){.note-navigation-toggle{display:inline-flex}.note-sidebar{display:none;width:220px;position:absolute;top:82px;bottom:0;left:0;z-index:5;box-shadow:10px 0 30px #0002}.show-navigation .note-sidebar{display:block}.note-paper{padding:8px 12px 0}.note-page-title{font-size:25px}.note-page-meta{padding:8px 16px}.note-toolbar{min-height:70px}.note-footer{padding:8px 16px;gap:10px}.note-footer span:last-child{display:none}}

.note-title-wrap{position:relative;flex:none;overflow:hidden}.note-title-highlights{position:absolute;inset:0;overflow:hidden;pointer-events:none;color:transparent;font:650 30px/1.5 var(--document-font);font-synthesis:weight style;white-space:pre;padding-bottom:20px}.note-title-highlights>div{width:max-content}.note-search-mark{background:#f4cf58;color:transparent;border-radius:2px}.note-canvas-hint{font-size:11px;color:var(--note-muted);margin:10px 0 8px;flex:none}.note-page-menu{position:fixed;width:192px;z-index:30;background:var(--note-surface);border:1px solid var(--note-line);border-radius:10px;padding:5px;box-shadow:0 10px 36px #18213626;box-sizing:border-box}.note-page-menu button{width:100%;justify-content:flex-start;padding:8px 10px}.note-footer{flex:none}.note-page-meta{flex:none}.note-pages button{flex:none}.note-page-title{flex:none}.note-canvas-hint{line-height:1.5}@media(max-width:620px){.note-title-highlights{font-size:25px}.note-canvas-hint{font-size:10px}}
.note-toolbar button[aria-pressed=true]{color:var(--note-accent);background:color-mix(in srgb,var(--note-accent) 12%,transparent)}
</style>
