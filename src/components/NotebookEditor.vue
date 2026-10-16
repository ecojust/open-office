<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { useDialogFocus } from '../shared/dialog-focus'
import { base64ToBytes, bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { blankBlock, blankPage, noteId, noteTitle, pageText, validateImage, type Notebook, type NoteBlock } from '../notes/model'
import { NotebookSession } from '../notes/session'
import { blocksFromDom, blocksFromHtml, renderBlocks } from '../notes/dom'

const props = withDefaults(defineProps<{ document: NativeDocument; active?: boolean; disabled?: boolean; theme?: Appearance }>(), { active: true, disabled: false, theme: 'system' })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: 'new'|'open'|'save'|'saveAs'|'print'|'close'] }>()
const body = ref<HTMLElement>(), titleInput = ref<HTMLInputElement>(), imageInput = ref<HTMLInputElement>(), searchInput = ref<HTMLInputElement>(), dialogInput = ref<HTMLInputElement>()
const dialogElement = ref<HTMLElement>()
useDialogFocus(dialogElement)
const model = shallowRef<Notebook>(), currentSection = ref(''), currentPage = ref(''), query = ref(''), navigation = ref(false)
const composing = ref(false), imageBusy = ref(false), loading = ref(true), problem = ref(''), pending = ref(false), titlePending = ref(false)
const undoAvailable = ref(false), redoAvailable = ref(false), dirty = ref(false)
const dialog = ref<{ title: string; message?: string; value: string; destructive: boolean; apply: (value: string) => void }>()
let session: NotebookSession | undefined, disposed = false, token = 0, savedRange: Range | undefined, printFrame: HTMLIFrameElement | undefined
let imageRequest: { token: number; pageId: string } | undefined
let lastExport: { token: number; base64: string; revision: number } | undefined
const section = computed(() => model.value?.sections.find(item => item.id === currentSection.value))
const page = computed(() => section.value?.pages.find(item => item.id === currentPage.value))
const results = computed(() => {
 const needle = query.value.trim().toLocaleLowerCase()
 if (!needle || !model.value) return []
 return model.value.sections.flatMap(section => section.pages.filter(page => pageText(page).toLocaleLowerCase().includes(needle)).map(page => ({ section, page })))
})
const editable = computed(() => props.active && !props.disabled && !loading.value && !dialog.value && !imageBusy.value)
function report(cause: unknown) {
 if (disposed) return
 problem.value = cause instanceof Error ? cause.message : String(cause)
 // Recoverable editing errors belong to this editor and clear when corrected.
 // Only a failed document load should mark the shell tab as unable to open.
 if (loading.value) emit('error', problem.value)
}
function accept() {
 if (!session) return
 model.value = session.model
 const state = session.inspect(); undoAvailable.value = state.canUndo; redoAvailable.value = state.canRedo; dirty.value = state.dirty || pending.value || titlePending.value || composing.value
 emit('dirty', dirty.value)
}
function change(edit: (copy: Notebook) => void) {
 if (!session) return
 session.change(edit); accept(); problem.value = ''
}
function updatePage(edit: (blocks: NoteBlock[], notebook: Notebook) => void) {
 const id = currentPage.value
 change(copy => { const target = copy.sections.flatMap(section => section.pages).find(page => page.id === id); if (!target) throw Error('页面已切换，请重新操作。'); edit(target.blocks, copy) })
}
function render() {
 if (!body.value || !page.value) return
 body.value.replaceChildren(renderBlocks(document, page.value.blocks))
 savedRange = undefined
}
function commitBody() {
 if (!body.value || !page.value || composing.value) return
 try {
  const blocks = blocksFromDom(body.value), id = currentPage.value
  change(copy => { const page = copy.sections.flatMap(item => item.pages).find(item => item.id === id); if (page) page.blocks = blocks })
  pending.value = false; accept()
 } catch (cause) { pending.value = true; accept(); report(cause) }
}
function inputBody() { pending.value = true; if (!composing.value) commitBody(); else accept() }
function titleChanged(event: Event) {
 const value = (event.target as HTMLInputElement).value
 try {
  if (Array.from(value).length > 200) throw Error('页面标题不能超过 200 字。')
  const id = currentPage.value
  change(copy => { const page = copy.sections.flatMap(item => item.pages).find(item => item.id === id); if (page) page.title = value })
  titlePending.value = false; accept()
 } catch (cause) { titlePending.value = true; accept(); report(cause) }
}
function rememberSelection() {
 const selection = window.getSelection()
 if (selection?.rangeCount && body.value?.contains(selection.anchorNode) && body.value.contains(selection.focusNode)) savedRange = selection.getRangeAt(0).cloneRange()
}
function restoreSelection() {
 if (!body.value) return
 body.value.focus()
 const selection = window.getSelection()
 if (savedRange && body.value.contains(savedRange.commonAncestorContainer)) { selection?.removeAllRanges(); selection?.addRange(savedRange) }
 else { const range = document.createRange(); range.selectNodeContents(body.value); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range) }
}
function requireReady() {
 if (!session || loading.value || disposed) throw Error('请等待笔记打开。')
 if (composing.value) throw Error('请先确认输入法文字，再保存笔记。')
 if (pending.value || titlePending.value || dialog.value || imageBusy.value) throw Error('请先完成当前笔记操作。')
}
async function selectPage(sectionId: string, pageId: string) {
 if (!editable.value || composing.value) return
 commitBody()
 if (pending.value || titlePending.value) return
 currentSection.value = sectionId; currentPage.value = pageId; navigation.value = false
 await nextTick(); render()
}
function openDialog(title: string, value: string, apply: (value: string) => void, message?: string) {
 if (!editable.value || composing.value) return
 commitBody(); if (pending.value || titlePending.value) return
 dialog.value = { title, value, apply, destructive: !!message, message }
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
function addPage() {
 if (!editable.value || !section.value || composing.value) return
 commitBody(); if (pending.value || titlePending.value) return
 const value = blankPage(), id = currentSection.value
 try { change(copy => copy.sections.find(item => item.id === id)!.pages.push(value)); currentPage.value = value.id; nextTick(() => { render(); titleInput.value?.focus(); titleInput.value?.select() }) } catch (cause) { report(cause) }
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
 const target = page.value; if (!target) return
 openDialog('删除页面', '', () => {
  const sectionId = currentSection.value
  change(copy => { const section = copy.sections.find(item => item.id === sectionId)!; section.pages = section.pages.filter(item => item.id !== target.id); if (!section.pages.length) section.pages.push(blankPage()) })
  currentPage.value = section.value!.pages[0].id
 }, `删除“${target.title || '无标题页面'}”及其全部内容？可以使用撤销恢复。`)
}
function removeImage(id: string) { openDialog('删除图片', '', () => updatePage(blocks => { const index = blocks.findIndex(block => block.id === id && block.type === 'image'); if (index >= 0) blocks.splice(index, 1); if (!blocks.length) blocks.push(blankBlock()) }), '删除这张图片？可以使用撤销恢复。') }
function bodyClick(event: MouseEvent) {
 const target = event.target as HTMLElement
 const remove = target.closest<HTMLButtonElement>('[data-delete-image]')
 if (remove?.dataset.deleteImage) { event.preventDefault(); removeImage(remove.dataset.deleteImage) }
 else if (target instanceof HTMLInputElement && target.type === 'checkbox') { if (!editable.value) event.preventDefault(); else commitBody() }
 rememberSelection()
}
function format(command: string, value?: string) {
 if (!editable.value || composing.value) return
 restoreSelection()
 document.execCommand(command, false, value)
 commitBody(); rememberSelection()
}
function todo() {
 if (!editable.value || composing.value) return
 restoreSelection()
 const fragment = renderBlocks(document, [{ id: noteId(), type: 'todo', checked: false, content: [{ text: '待办事项' }] }])
 insertFragment(fragment)
}
function insertFragment(fragment: DocumentFragment) {
 restoreSelection()
 const selection = window.getSelection(); if (!selection?.rangeCount) return
 const range = selection.getRangeAt(0), end = fragment.lastChild
 if (!range.collapsed && [...body.value?.querySelectorAll('figure') ?? []].some(figure => range.intersectsNode(figure))) { emit('status','请先通过“删除图片”按钮确认删除选区中的图片。'); return }
 range.deleteContents(); range.insertNode(fragment)
 if (end) { range.setStartAfter(end); range.collapse(true); selection.removeAllRanges(); selection.addRange(range) }
 commitBody(); rememberSelection()
}
function paste(event: ClipboardEvent) {
 event.preventDefault()
 if (!editable.value || composing.value) return
 const image = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'))
 if (image) { void insertImage(image); return }
 try {
  const html = event.clipboardData?.getData('text/html'), text = event.clipboardData?.getData('text/plain') ?? ''
  if (html) insertFragment(renderBlocks(document, blocksFromHtml(html)))
  else { restoreSelection(); document.execCommand('insertText', false, text); commitBody(); rememberSelection() }
 } catch (cause) { report(cause) }
}
function beforeInput(event: InputEvent) {
 if (!editable.value) { event.preventDefault(); return }
 if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); void (event.inputType === 'historyUndo' ? undo() : redo()); return }
 // Structural image deletion is deliberate and always confirmed through its button.
 if (event.inputType.startsWith('delete')) {
  const selection = window.getSelection(), figures = [...body.value?.querySelectorAll('figure') ?? []]
  const ranges: Range[] = []
  if (selection?.rangeCount) ranges.push(selection.getRangeAt(0))
  for (const target of event.getTargetRanges?.() ?? []) {
   const range = document.createRange(); range.setStart(target.startContainer, target.startOffset); range.setEnd(target.endContainer, target.endOffset); ranges.push(range)
  }
  const removesImage = ranges.some(range => !range.collapsed && figures.some(figure => range.intersectsNode(figure)))
  if (removesImage) { event.preventDefault(); emit('status','请使用图片上的“删除图片”按钮，并确认删除。') }
 }
}
function chooseImage() {
 if (!editable.value || composing.value) return
 rememberSelection(); imageRequest = { token, pageId: currentPage.value }; imageBusy.value = true; imageInput.value?.click()
}
async function imageChosen(event: Event) {
 const input = event.target as HTMLInputElement, file = input.files?.[0], request = imageRequest
 input.value = ''; imageRequest = undefined; imageBusy.value = false
 if (file && request && request.token === token && request.pageId === currentPage.value) await insertImage(file)
}
async function insertImage(file: File) {
 if (imageBusy.value || !editable.value || composing.value) return
 const owner = token, pageId = currentPage.value
 imageBusy.value = true
 try {
  if (!['image/png','image/jpeg'].includes(file.type) || file.size > 4 * 1024 * 1024) throw Error('请选择不超过 4 MB 的 PNG 或 JPEG 图片。')
  const bytes = new Uint8Array(await file.arrayBuffer()), dataUrl = validateImage(`data:${file.type};base64,${bytesToBase64(bytes)}`)
  if (disposed || owner !== token || pageId !== currentPage.value) return
  imageBusy.value = false
  insertFragment(renderBlocks(document, [{ id: noteId(), type: 'image', dataUrl, alt: Array.from(file.name).slice(0,200).join('') }]))
 } catch (cause) { report(cause) } finally { if (owner === token) imageBusy.value = false }
}
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
 if (!editable.value || composing.value) return
 if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); void (event.shiftKey ? redo() : undo()).catch(report) }
 else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); void redo().catch(report) }
}
async function inspect() { if (!session) throw Error('请等待笔记打开。'); return { ...session.inspect(), dirty: session.inspect().dirty || composing.value || pending.value || titlePending.value } }
async function canBackgroundExport() { return !!session && !disposed && !loading.value && !composing.value && !pending.value && !titlePending.value && !dialog.value && !imageBusy.value }
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
async function discardChanges(options: { force?: boolean } = {}) {
 if (options.force) { token++; composing.value = false; pending.value = false; titlePending.value = false; return }
 requireReady(); session!.validateReceipt()
}
async function search(value: string) { query.value = value; navigation.value = true; await nextTick(); searchInput.value?.focus() }
async function print() {
 requireReady(); if (!page.value || !model.value) return
 printFrame?.remove()
 const frame = document.createElement('iframe'); frame.title = '打印笔记'; frame.style.cssText = 'position:fixed;left:-10000px;width:1px;height:1px;'; document.body.append(frame); printFrame = frame
 const output = frame.contentDocument
 if (!output) throw Error('无法创建打印页面。')
 const title = output.createElement('title'); title.textContent = page.value.title || '无标题页面'; output.head.append(title)
 const style = output.createElement('style'); style.textContent = 'body{font:15px/1.8 system-ui,sans-serif;color:#111;max-width:800px;margin:32px auto;white-space:pre-wrap}img{max-width:100%;height:auto}figure{margin:16px 0}h1{font-size:28px}input{margin-right:8px}code{background:#eee;padding:2px 4px}'; output.head.append(style)
 const heading = output.createElement('h1'); heading.textContent = page.value.title || '无标题页面'; output.body.append(heading, renderBlocks(output, page.value.blocks, false))
 await Promise.all([...output.images].map(image => image.decode?.().catch(() => undefined)))
 frame.contentWindow?.print()
}
function focus() { body.value?.focus() }
watch(() => props.document.id, async () => {
 const owner = ++token; loading.value = true
 try {
  const next = new NotebookSession(props.document.base64 ? base64ToBytes(props.document.base64) : undefined, props.document.name.replace(/\.[^.]+$/, ''))
  if (disposed || owner !== token) return
  session = next; lastExport = undefined; composing.value = false; pending.value = false; titlePending.value = false; imageBusy.value = false; dialog.value = undefined; problem.value = ''
  currentSection.value = next.model.sections[0].id; currentPage.value = next.model.sections[0].pages[0].id; accept()
  await nextTick(); render(); emit('ready')
 } catch (cause) { report(cause) } finally { if (owner === token) loading.value = false }
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; token++; savedRange = undefined; printFrame?.remove() })
defineExpose({ exportFile, markSaved, discardChanges, inspect, syncRevision: inspect, canBackgroundExport, undo, redo, search, print, focus })
</script>

<template>
 <section class="notebook-editor" :data-theme="theme" data-testid="notebook-editor" @keydown="keydown">
  <header class="note-toolbar" aria-label="笔记格式工具栏">
   <button class="note-navigation-toggle" title="分区与页面" aria-label="分区与页面" @click="navigation = !navigation"><Icon name="menu" :size="18" /></button>
   <button title="撤销 (Ctrl/⌘ Z)" aria-label="撤销" :disabled="!editable || !undoAvailable || composing" @mousedown.prevent @click="undo().catch(report)"><Icon name="undo" :size="18" /></button>
   <button title="重做" aria-label="重做" :disabled="!editable || !redoAvailable || composing" @mousedown.prevent @click="redo().catch(report)"><Icon name="redo" :size="18" /></button>
   <span class="note-separator" />
   <select aria-label="段落样式" :disabled="!editable || composing" @mousedown="rememberSelection" @change="format('formatBlock', ($event.target as HTMLSelectElement).value)">
    <option value="div">正文</option><option value="h1">大标题</option><option value="h2">小标题</option><option value="h3">三级标题</option>
   </select>
   <button title="加粗" aria-label="加粗" :disabled="!editable || composing" @mousedown.prevent @click="format('bold')"><Icon name="bold" :size="18" /></button>
   <button title="斜体" aria-label="斜体" :disabled="!editable || composing" @mousedown.prevent @click="format('italic')"><Icon name="italic" :size="18" /></button>
   <button title="下划线" aria-label="下划线" :disabled="!editable || composing" @mousedown.prevent @click="format('underline')"><Icon name="underline" :size="18" /></button>
   <button title="删除线" aria-label="删除线" :disabled="!editable || composing" @mousedown.prevent @click="format('strikeThrough')"><Icon name="strike" :size="18" /></button>
   <span class="note-separator" />
   <button title="项目列表" :disabled="!editable || composing" @mousedown.prevent @click="format('insertUnorderedList')"><Icon name="bullets" :size="18" /> 列表</button>
   <button title="编号列表" :disabled="!editable || composing" @mousedown.prevent @click="format('insertOrderedList')"><Icon name="numbering" :size="18" /> 编号</button>
   <button title="插入待办" :disabled="!editable || composing" @mousedown.prevent @click="todo"><Icon name="todo" :size="18" /> 待办</button>
   <button title="插入 PNG / JPEG 图片" :disabled="!editable || composing" @mousedown.prevent @click="chooseImage"><Icon name="image" :size="18" /> 图片</button>
   <input ref="imageInput" class="note-file-input" type="file" accept="image/png,image/jpeg" @change="imageChosen" @cancel="imageBusy = false; imageRequest = undefined" />
  </header>
  <div v-if="problem" class="note-problem" role="alert">{{ problem }}<button aria-label="关闭提示" @click="problem = ''"><Icon name="close" :size="14" /></button></div>
  <div class="note-workspace" :class="{ 'show-navigation': navigation }">
   <aside class="note-sidebar" aria-label="笔记本导航">
    <div class="note-notebook-title"><Icon name="folder" :size="20" /><button :disabled="!editable || composing" title="重命名笔记本" @click="openDialog('重命名笔记本', model?.title ?? '', value => change(copy => { copy.title = value }))">{{ model?.title || '笔记本' }}</button></div>
    <label class="note-search"><Icon name="search" :size="16" /><input ref="searchInput" v-model="query" placeholder="搜索整个笔记本" aria-label="搜索整个笔记本" /></label>
    <div v-if="query.trim()" class="note-search-results" aria-label="搜索结果">
     <p>{{ results.length }} 个匹配页面</p>
     <button v-for="result in results" :key="result.page.id" :disabled="!editable || composing" @click="selectPage(result.section.id, result.page.id)"><strong>{{ result.page.title || '无标题页面' }}</strong><small>{{ result.section.title }}</small></button>
    </div>
    <template v-else>
     <div class="note-list-heading"><span>分区</span><button title="新建分区" aria-label="新建分区" :disabled="!editable || composing" @click="addSection"><Icon name="plus" :size="16" /></button></div>
     <nav class="note-sections"><button v-for="item in model?.sections" :key="item.id" :class="{ selected: item.id === currentSection }" :disabled="!editable || composing" @click="selectPage(item.id, item.pages[0].id)"><span class="note-section-dot" />{{ item.title }}<small>{{ item.pages.length }}</small></button></nav>
     <div class="note-section-actions"><button :disabled="!editable || composing" @click="renameSection">重命名分区</button><button :disabled="!editable || composing" @click="deleteSection">删除分区</button></div>
     <div class="note-list-heading"><span>页面</span><button title="新建页面" aria-label="新建页面" :disabled="!editable || composing" @click="addPage"><Icon name="plus" :size="16" /></button></div>
     <nav class="note-pages"><button v-for="item in section?.pages" :key="item.id" :class="{ selected: item.id === currentPage }" :disabled="!editable || composing" @click="selectPage(currentSection, item.id)"><strong>{{ item.title || '无标题页面' }}</strong><small>{{ pageText(item).split('\n').slice(1).join(' ').slice(0,70) || '记录新的想法…' }}</small></button></nav>
    </template>
   </aside>
   <main class="note-main">
    <div class="note-page-meta"><span>{{ section?.title }} <span aria-hidden="true">/</span> {{ page?.title || '无标题页面' }}</span><button :disabled="!editable || composing" title="删除当前页面" @click="deletePage"><Icon name="trash" :size="16" /> 删除页面</button></div>
    <div class="note-paper">
     <input ref="titleInput" :value="page?.title" class="note-page-title" placeholder="无标题页面" aria-label="页面标题" :disabled="!editable" @input="titleChanged" @compositionstart="composing = true; accept()" @compositionend="composing = false; titleChanged($event); accept()" />
     <div ref="body" class="note-body" data-testid="notebook-content" role="textbox" aria-label="页面正文" aria-multiline="true" :contenteditable="editable" spellcheck="true" @input="inputBody" @beforeinput="beforeInput" @compositionstart="composing = true; accept()" @compositionend="composing = false; commitBody()" @paste="paste" @drop.prevent @dragover.prevent @click="bodyClick" @keyup="rememberSelection" @mouseup="rememberSelection" @blur="rememberSelection" />
    </div>
    <footer class="note-footer"><span>{{ page ? Array.from(pageText(page).split('\n').slice(1).join('')).length : 0 }} 字</span><span>{{ imageBusy ? '正在插入图片…' : composing ? '正在输入…' : dirty ? '有未保存的修改' : '已保存' }}</span><span>.oonote 笔记本</span></footer>
   </main>
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
button,input,select{font:inherit;color:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:7px;background:transparent;cursor:pointer;min-height:30px;padding:5px 8px}button:hover:not(:disabled){background:color-mix(in srgb,var(--note-accent) 10%,transparent)}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--note-accent);outline-offset:2px}.note-toolbar{display:flex;align-items:center;gap:3px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--note-line);background:var(--note-surface)}.note-toolbar select{height:30px;border:1px solid var(--note-line);background:var(--note-surface);border-radius:7px;padding:2px 8px}.note-separator{height:19px;border-left:1px solid var(--note-line);margin:0 6px}.note-file-input{display:none}.note-workspace{display:flex;flex:1;min-height:0}.note-sidebar{width:252px;flex:none;border-right:1px solid var(--note-line);padding:16px 12px;overflow:auto;background:var(--note-surface)}.note-notebook-title{display:flex;align-items:center;gap:6px;margin-bottom:16px;color:var(--note-accent)}.note-notebook-title button{font-size:15px;font-weight:600;text-align:left;justify-content:flex-start;overflow-wrap:anywhere}.note-search{display:flex;align-items:center;gap:8px;border:1px solid var(--note-line);border-radius:8px;padding:8px;color:var(--note-muted)}.note-search input{background:transparent;border:0;min-width:0;width:100%;outline:none}.note-list-heading{display:flex;justify-content:space-between;align-items:center;margin:18px 4px 8px;color:var(--note-muted);font-size:11px;font-weight:600;letter-spacing:.08em}.note-sections,.note-pages{display:flex;flex-direction:column;gap:4px}.note-sections button{justify-content:flex-start;text-align:left;min-height:36px;overflow-wrap:anywhere}.note-section-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--note-accent)}.note-sections small{margin-left:auto;color:var(--note-muted)}.note-sections .selected,.note-pages .selected{background:color-mix(in srgb,var(--note-accent) 11%,transparent);color:var(--note-accent)}.note-section-actions{display:flex;gap:4px;margin-top:6px;color:var(--note-muted);font-size:11px}.note-pages button,.note-search-results button{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:5px;padding:11px 12px;text-align:left;overflow:hidden;min-height:57px}.note-pages strong,.note-search-results strong{font-size:13px;font-weight:600;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.note-pages small,.note-search-results small{color:var(--note-muted);font-size:11px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.note-search-results>p{color:var(--note-muted);font-size:11px}.note-search-results button{width:100%}.note-main{min-width:0;flex:1;display:flex;flex-direction:column;overflow:auto}.note-page-meta{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 24px;color:var(--note-muted);font-size:11px}.note-page-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.note-page-meta button{flex:none}.note-paper{width:100%;max-width:980px;padding:24px 48px 48px;box-sizing:border-box;align-self:center;flex:1}.note-page-title{font-family:var(--document-font);font-synthesis:weight style;display:block;width:100%;box-sizing:border-box;font-size:30px;line-height:1.5;font-weight:650;border:0;border-bottom:1px solid var(--note-line);padding:0 0 20px;background:transparent;outline:none;margin:0 0 24px}.note-body{font-family:var(--document-font);font-synthesis:weight style;min-height:240px;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.85}.note-body :deep(div){min-height:1.85em}.note-body :deep(h1){font-size:27px;margin:24px 0 10px;line-height:1.4}.note-body :deep(h2){font-size:22px;margin:20px 0 8px}.note-body :deep(h3){font-size:18px;margin:16px 0 6px}.note-body :deep(ul),.note-body :deep(ol){padding-left:26px;margin:8px 0}.note-body :deep(code){background:color-mix(in srgb,var(--note-muted) 12%,transparent);padding:2px 5px;border-radius:4px;font:14px/1.6 ui-monospace,monospace}.note-body :deep([data-note-type=todo]){display:block}.note-body :deep(input[type=checkbox]){accent-color:var(--note-accent);margin:0 10px 0 0;vertical-align:middle;width:15px;height:15px}.note-body :deep([data-note-type=todo]:has(input:checked)){color:var(--note-muted);text-decoration:line-through}.note-body :deep(figure){margin:18px 0;display:flex;flex-direction:column;align-items:flex-start;gap:6px}.note-body :deep(img){max-width:100%;height:auto;border-radius:8px}.note-body :deep(figure button){font:11px var(--ui-font);color:var(--note-muted);border:1px solid var(--note-line);background:var(--note-surface);padding:4px 8px;border-radius:5px;cursor:pointer}.note-footer{display:flex;gap:18px;padding:10px 24px;color:var(--note-muted);border-top:1px solid var(--note-line);font-size:11px}.note-footer span:last-child{margin-left:auto}.note-problem{padding:8px 14px;background:color-mix(in srgb,#d98a1e 12%,var(--note-surface));display:flex;justify-content:space-between;align-items:center}.note-modal-backdrop{position:absolute;inset:0;background:#18213655;display:flex;align-items:center;justify-content:center;z-index:20;padding:20px}.note-dialog{width:360px;max-width:100%;padding:24px;background:var(--note-surface);border:1px solid var(--note-line);box-shadow:0 20px 70px #0003;border-radius:16px}.note-dialog h2{margin:0 0 14px;font-size:18px}.note-dialog p{color:var(--note-muted);line-height:1.7}.note-dialog>input{width:100%;box-sizing:border-box;border:1px solid var(--note-line);background:transparent;padding:9px;border-radius:7px}.note-dialog>div{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}.note-dialog button[type=submit]{background:var(--note-accent);color:#fff;padding:7px 16px}.note-dialog button.danger{background:#c64c53}.note-navigation-toggle{display:none}@media(max-width:850px){.note-sidebar{width:220px}.note-paper{padding:20px 28px 40px}.note-toolbar{padding:6px 10px;gap:1px}.note-toolbar button{font-size:12px}.note-separator{margin:0 3px}}@media(max-width:620px){.note-navigation-toggle{display:inline-flex}.note-sidebar{display:none;width:220px;position:absolute;top:82px;bottom:0;left:0;z-index:5;box-shadow:10px 0 30px #0002}.show-navigation .note-sidebar{display:block}.note-paper{padding:14px 20px 32px}.note-page-title{font-size:25px}.note-page-meta{padding:8px 16px}.note-toolbar{min-height:70px}.note-footer{padding:8px 16px;gap:10px}.note-footer span:last-child{display:none}}
</style>
