<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { EditorExport, Extension } from '../shared/document'
import { prepareRustWordDocument, type PreparedRustWordDocument, type RustWordSession } from '../word/rust/client'
import type { RustWordAlignment, RustWordCommand, RustWordSnapshot } from '../word/rust/types'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedRustWordDocument; active?: boolean; disabled?: boolean }>(), { active: true, disabled: false })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string] }>()
const snapshot = shallowRef<RustWordSnapshot>(), input = ref<HTMLTextAreaElement>(), surface = ref<HTMLElement>()
const loading = ref(true), pending = ref(0), problem = ref(''), notice = ref(''), focused = ref(false), composing = ref(false)
const viewportVersion = ref(0)
let session: RustWordSession | undefined, unsubscribe: (() => void) | undefined
let disposed = false, generation = 0, opening: Promise<void> = Promise.resolve(), compositionPending = false
let lastExport: { generation: number; revision: number } | undefined
let drag: { pointerId: number; element: Element } | undefined
let nextHit: { page: number; x: number; y: number; extend: boolean } | undefined, hitRunning = false
const unavailable = computed(() => props.disabled || !props.active || loading.value || !snapshot.value)
const toolbarDisabled = computed(() => unavailable.value || !!pending.value || composing.value)
const pages = computed(() => snapshot.value?.layout.pages ?? [])
const color = computed(() => snapshot.value?.format.color?.startsWith('#') ? snapshot.value.format.color : '#000000')
const fontSizes = computed(() => [...new Set([8,9,10,11,12,14,16,18,20,24,28,32,36,48,60,72, ...(snapshot.value?.format.fontSize ? [snapshot.value.format.fontSize] : [])])].sort((left, right) => left - right))
const characters = computed(() => snapshot.value?.document.paragraphs.reduce((total, paragraph) => total + Array.from(paragraph.runs.map(run => run.text).join('')).length, 0) ?? 0)
const inputStyle = computed(() => {
  viewportVersion.value
  const caret = snapshot.value?.layout.caret
  if (!caret) return { left: '0px', top: '0px' }
  const page = surface.value?.querySelector<HTMLElement>(`[data-page="${caret.page}"]`)
  return { left: `${(page?.offsetLeft ?? 0) + caret.x * 4 / 3}px`, top: `${(page?.offsetTop ?? 0) + caret.y * 4 / 3}px`, fontSize: `${snapshot.value?.format.fontSize ?? 12}pt`, minHeight: `${caret.height * 4 / 3}px` }
})
function report(cause: unknown) {
  if (disposed) return
  problem.value = cause instanceof Error ? cause.message : String(cause)
  emit('error', problem.value)
}
function focus() { if (props.active && !unavailable.value) input.value?.focus({ preventScroll: true }) }
function accept(value: RustWordSnapshot, token: number) {
  if (disposed || token !== generation) return
  snapshot.value = value; emit('dirty', value.dirty)
  void nextTick(async () => {
    if (disposed || token !== generation) return
    viewportVersion.value++
    await nextTick()
    if (disposed || token !== generation) return
    if (focused.value && props.active && !drag) input.value?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
async function command(value: RustWordCommand, restore = false, finishComposition = false) {
  if (!session || loading.value || (!finishComposition && unavailable.value)) return
  const active = session, token = generation
  pending.value++; problem.value = ''; notice.value = ''
  try { await active.command(value); if (token === generation && restore) focus() }
  catch (cause) { if (token === generation) report(cause) }
  finally { if (token === generation) pending.value-- }
}
function insert(text: string) { if (text) void command({ type: 'replaceText', text }) }
function stopDrag() {
  if (drag?.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
  drag = undefined; nextHit = undefined
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229) return
  if (unavailable.value) { event.preventDefault(); return }
  stopDrag()
  const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase()
  if (modifier) {
    if (key === 'a') { event.preventDefault(); void command({ type: 'selectAll' }); return }
    if (key === 'z' || key === 'y') { event.preventDefault(); void command({ type: key === 'y' || event.shiftKey ? 'redo' : 'undo' }); return }
    if (key === 'b' || key === 'i') {
      event.preventDefault()
      if (!pending.value) { const field = key === 'b' ? 'bold' : 'italic'; void command({ type: 'format', [field]: snapshot.value?.format[field] !== true }) }
      return
    }
    if (['c', 'x', 'v'].includes(key)) return
  }
  const directions: Record<string, 'left' | 'right' | 'up' | 'down' | 'home' | 'end'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' }
  if (directions[event.key]) { event.preventDefault(); void command({ type: 'move', direction: directions[event.key]!, extend: event.shiftKey }); return }
  if (event.key === 'Enter') { event.preventDefault(); insert('\n'); return }
  if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); void command({ type: event.key === 'Backspace' ? 'deleteBackward' : 'deleteForward' }); return }
  if (event.key === 'Tab') { event.preventDefault(); insert('\t') }
}
function beforeInput(event: Event) {
  const value = event as InputEvent
  if (value.isComposing || composing.value || compositionPending) return
  if (unavailable.value) { event.preventDefault(); return }
  if (value.inputType === 'insertText' && value.data !== null) { event.preventDefault(); insert(value.data) }
  else if (value.inputType === 'insertParagraph' || value.inputType === 'insertLineBreak') { event.preventDefault(); insert('\n') }
  else if (value.inputType.startsWith('delete')) { event.preventDefault(); void command({ type: value.inputType.includes('Backward') ? 'deleteBackward' : 'deleteForward' }) }
  else if (value.inputType === 'historyUndo' || value.inputType === 'historyRedo') { event.preventDefault(); void command({ type: value.inputType === 'historyUndo' ? 'undo' : 'redo' }) }
}
function textInput(event: Event) {
  if (composing.value || (event as InputEvent).isComposing) return
  const value = input.value?.value ?? ''
  if (input.value) input.value.value = ''
  if (!compositionPending && !unavailable.value) insert(value)
}
function startComposition() {
  if (unavailable.value) return
  stopDrag(); composing.value = true
  if (input.value) input.value.value = ''
}
function endComposition(event: CompositionEvent) {
  if (!composing.value) return
  composing.value = false; compositionPending = true
  const token = generation
  if (input.value) input.value.value = ''
  // A save can disable the toolbar before blur commits an already-started IME
  // transaction. That transaction still belongs ahead of the queued export.
  if (event.data) void command({ type: 'replaceText', text: event.data }, false, true)
  setTimeout(() => { if (generation === token) { compositionPending = false; if (input.value) input.value.value = '' } }, 0)
}
function clipboard(event: ClipboardEvent, cut = false) {
  event.preventDefault()
  if (unavailable.value || composing.value || pending.value || !event.clipboardData || !snapshot.value) return
  event.clipboardData.setData('text/plain', snapshot.value.selectionText)
  if (cut && snapshot.value.selectionText) void command({ type: 'replaceText', text: '' })
}
function paste(event: ClipboardEvent) {
  event.preventDefault()
  if (unavailable.value || composing.value) return
  insert(event.clipboardData?.getData('text/plain') ?? '')
}
function hit(event: PointerEvent) {
  if (!(event.target instanceof Element)) return
  const pageElement = event.target.closest<HTMLElement>('[data-page]')
  if (!pageElement) return
  const index = Number(pageElement.dataset.page), page = pages.value[index]
  if (!page) return
  const rectangle = pageElement.getBoundingClientRect()
  return { page: index, x: (event.clientX - rectangle.left) * page.width / rectangle.width, y: (event.clientY - rectangle.top) * page.height / rectangle.height }
}
async function flushHit() {
  if (hitRunning) return
  hitRunning = true
  try {
    while (nextHit) { const value = nextHit; nextHit = undefined; await command({ type: 'hitTest', ...value }) }
  } finally { hitRunning = false }
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || unavailable.value || pending.value || composing.value) return
  const point = hit(event)
  if (!point || !(event.currentTarget instanceof Element)) return
  event.preventDefault(); focus()
  event.currentTarget.setPointerCapture(event.pointerId)
  drag = { pointerId: event.pointerId, element: event.currentTarget }
  nextHit = { ...point, extend: event.shiftKey }; void flushHit()
}
function pointerMove(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return
  // Pointer capture changes event.target. Use the page under the actual point.
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-page]')
  if (!element) return
  const index = Number(element.dataset.page), page = pages.value[index]
  if (!page) return
  const rectangle = element.getBoundingClientRect()
  nextHit = { page: index, x: (event.clientX - rectangle.left) * page.width / rectangle.width, y: (event.clientY - rectangle.top) * page.height / rectangle.height, extend: true }
  void flushHit()
}
function pointerUp(event: PointerEvent) {
  if (drag?.pointerId !== event.pointerId) return
  if (drag.element.hasPointerCapture(event.pointerId)) drag.element.releasePointerCapture(event.pointerId)
  drag = undefined
}
function changeSize(event: Event) { const value = Number((event.target as HTMLSelectElement).value); if (value >= 8 && value <= 72) void command({ type: 'format', fontSize: value }, true) }
function changeColor(event: Event) { void command({ type: 'format', color: (event.target as HTMLInputElement).value }, true) }
function changeAlign(event: Event) { void command({ type: 'align', alignment: (event.target as HTMLSelectElement).value as RustWordAlignment }, true) }
async function flush() {
  await opening
  if (composing.value) { input.value?.blur(); await nextTick() }
  if (composing.value) throw Error('请先确认输入法中的文字，再保存文稿。')
  if (!session) throw Error('请等待文字文稿打开。')
  await session.settled()
}
async function exportFile(options: { format?: Extension } = {}): Promise<EditorExport> {
  await flush()
  if (options.format && options.format !== 'docx') throw Error('此文字编辑器目前支持保存 DOCX 文稿。')
  const active = session!, token = generation, result = await active.export()
  if (disposed || token !== generation || session !== active) throw Error('文稿已切换，请重新保存。')
  lastExport = { generation: token, revision: result.snapshot.revision }
  return { base64: result.base64, extension: 'docx', name: props.document.name.replace(/\.[^.]+$/, '') + '.docx', dirty: result.snapshot.dirty }
}
async function markSaved() {
  await flush()
  if (lastExport?.generation !== generation || lastExport.revision !== session?.snapshot.revision) {
    emit('dirty', session?.snapshot.dirty ?? true)
    throw Error('导出后文稿又有修改，请再次保存当前内容。')
  }
  await session.command({ type: 'markSaved' })
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (options.force) return
  await flush()
  if (lastExport?.generation !== generation || lastExport.revision !== session?.snapshot.revision) throw Error('导出后文稿又有修改，请先保存当前内容，再切换文稿。')
}
async function undo() { try { await flush(); await command({ type: 'undo' }, true) } catch (cause) { report(cause) } }
async function redo() { try { await flush(); await command({ type: 'redo' }, true) } catch (cause) { report(cause) } }
async function load() {
  const token = ++generation, source = { ...props.document }, previous = session, supplied = props.prepared
  unsubscribe?.(); unsubscribe = undefined; session = undefined; snapshot.value = undefined; lastExport = undefined
  stopDrag(); loading.value = true; pending.value = 0; composing.value = false; compositionPending = false; problem.value = ''; notice.value = ''
  if (previous) await previous.close().catch(() => undefined)
  let prepared: PreparedRustWordDocument | undefined
  try {
    prepared = supplied
    let active = prepared?.take(source)
    if (!active) { prepared = await prepareRustWordDocument(source); active = prepared.take(source) }
    if (!active) throw Error('文字文稿准备失败。')
    if (disposed || token !== generation || source.id !== props.document.id) { await active.close(); return }
    session = active; unsubscribe = active.subscribe(value => accept(value, token)); accept(active.snapshot, token)
    loading.value = false; emit('status', '文字文稿已就绪'); emit('ready')
  } catch (cause) { prepared?.discard(); if (token === generation) { loading.value = false; report(cause) } }
}
watch(() => [props.document.id, props.document.base64] as const, ([id], previous) => { if (!previous || id !== previous[0] || !session) opening = load() }, { immediate: true })
watch(() => props.active, value => { if (!value) { stopDrag(); input.value?.blur() } })
function resized() { viewportVersion.value++ }
onMounted(() => window.addEventListener('resize', resized))
onBeforeUnmount(() => { disposed = true; generation++; stopDrag(); unsubscribe?.(); props.prepared?.discard(); window.removeEventListener('resize', resized); void session?.close().catch(() => undefined) })
defineExpose({ exportFile, markSaved, discardChanges, undo, redo, focus })
</script>

<template>
  <section class="rust-word-editor" data-testid="rust-word-editor" :data-ready="!!snapshot && !loading" :data-revision="snapshot?.revision" :data-pages="pages.length" :aria-busy="loading">
    <div class="rust-word-toolbar" role="toolbar" aria-label="文字格式">
      <button data-testid="rust-word-undo" aria-label="撤销" :disabled="toolbarDisabled || !snapshot?.canUndo" @mousedown.prevent @click="undo">↶</button>
      <button data-testid="rust-word-redo" aria-label="重做" :disabled="toolbarDisabled || !snapshot?.canRedo" @mousedown.prevent @click="redo">↷</button>
      <button class="rust-word-bold" data-testid="rust-word-bold" aria-label="加粗" :aria-pressed="snapshot?.format.bold === null ? 'mixed' : !!snapshot?.format.bold" :disabled="toolbarDisabled" @mousedown.prevent @click="command({ type: 'format', bold: snapshot?.format.bold !== true }, true)">B</button>
      <button class="rust-word-italic" data-testid="rust-word-italic" aria-label="斜体" :aria-pressed="snapshot?.format.italic === null ? 'mixed' : !!snapshot?.format.italic" :disabled="toolbarDisabled" @mousedown.prevent @click="command({ type: 'format', italic: snapshot?.format.italic !== true }, true)">I</button>
      <label>字号<select data-testid="rust-word-font-size" aria-label="字号" :value="snapshot?.format.fontSize ?? ''" :disabled="toolbarDisabled" @change="changeSize"><option value="" disabled>混合</option><option v-for="size in fontSizes" :key="size" :value="size">{{ size }}</option></select></label>
      <label>文字颜色<input data-testid="rust-word-color" aria-label="文字颜色" type="color" :value="color" :disabled="toolbarDisabled" @change="changeColor"></label>
      <button class="rust-word-auto" data-testid="rust-word-color-auto" :aria-pressed="snapshot?.format.color === 'auto'" :disabled="toolbarDisabled" @mousedown.prevent @click="command({ type: 'format', color: 'auto' }, true)">自动颜色</button>
      <label>对齐<select data-testid="rust-word-align" aria-label="段落对齐" :value="snapshot?.format.align ?? ''" :disabled="toolbarDisabled" @change="changeAlign"><option value="" disabled>混合</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
    </div>
    <p class="rust-word-scope">支持基础正文、文字格式和分页；表格、图片及编号暂不支持。</p>
    <p v-if="problem" class="rust-word-error" role="alert">{{ problem }}</p>
    <p v-if="notice" class="rust-word-notice" role="status">{{ notice }}</p>
    <div class="rust-word-scroll">
      <div ref="surface" class="rust-word-surface" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="stopDrag">
        <div v-for="(page, index) in pages" :key="index" class="rust-word-page" :data-page="index" :style="{ width: `${page.width}pt`, height: `${page.height}pt` }">
          <svg :data-testid="`rust-word-page-${index}`" :viewBox="`0 0 ${page.width} ${page.height}`" :width="page.width" :height="page.height" role="img" :aria-label="`文稿第 ${index + 1} 页`">
            <rect :width="page.width" :height="page.height" fill="white" />
            <rect v-for="(rectangle, selected) in snapshot?.layout.selectionRects.filter(rectangle => rectangle.page === index)" :key="`selection-${selected}`" data-testid="rust-word-selection" :x="rectangle.x" :y="rectangle.y" :width="rectangle.width" :height="rectangle.height" fill="#b6d0fc" />
            <path v-for="(path, glyph) in page.paths" :key="glyph" :d="path.d" :fill="path.fill" />
            <line v-if="focused && !composing && snapshot?.layout.caret?.page === index && !snapshot.selectionText" data-testid="rust-word-caret" :x1="snapshot.layout.caret.x" :x2="snapshot.layout.caret.x" :y1="snapshot.layout.caret.y" :y2="snapshot.layout.caret.y + snapshot.layout.caret.height" stroke="#315bd4" stroke-width="1" />
          </svg>
        </div>
        <textarea ref="input" data-testid="rust-word-input" class="rust-word-input" :class="{ 'rust-word-composing': composing }" :style="inputStyle" aria-label="文稿输入" autocomplete="off" autocapitalize="off" :spellcheck="false" :disabled="unavailable && !composing" @keydown="keydown" @beforeinput="beforeInput" @input="textInput" @compositionstart="startComposition" @compositionend="endComposition" @copy="clipboard($event)" @cut="clipboard($event, true)" @paste="paste" @focus="focused = true" @blur="focused = false" />
      </div>
      <p v-if="loading" class="rust-word-loading" role="status">正在打开文稿…</p>
    </div>
    <footer class="rust-word-status"><span>{{ pages.length }} 页 · {{ characters }} 字</span><span>{{ composing ? '正在输入' : pending ? '正在处理' : '' }}</span></footer>
  </section>
</template>

<style scoped>
.rust-word-editor{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;background:#edf0f4;color:#303b4e}.rust-word-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:11px 18px;background:#fff;border-bottom:1px solid #e0e5ed}.rust-word-toolbar button,.rust-word-toolbar select{height:32px;border:1px solid #dbe1eb;border-radius:6px;background:#fff;color:#384154}.rust-word-toolbar button{min-width:32px;padding:0 9px;cursor:pointer}.rust-word-toolbar button[aria-pressed=true]{background:#e8edff;border-color:#c9d5fb;color:#315bd4}.rust-word-toolbar button[aria-pressed=mixed]{border-style:dashed}.rust-word-toolbar :disabled{opacity:.45;cursor:default}.rust-word-toolbar label{display:flex;align-items:center;gap:6px;margin-left:5px;font-size:12px}.rust-word-toolbar select{padding:0 5px}.rust-word-toolbar input[type=color]{width:32px;height:28px;padding:2px;border:1px solid #dbe1eb;border-radius:5px;background:#fff}.rust-word-bold{font-weight:750}.rust-word-italic{font-style:italic}.rust-word-toolbar .rust-word-auto{font-size:12px}.rust-word-scope{margin:0;padding:9px 18px;color:#69768b;font-size:11px;background:#f8f9fc}.rust-word-error,.rust-word-notice{margin:8px 18px;padding:9px 12px;font-size:12px;border-radius:6px;background:#fff2ed;color:#994326}.rust-word-notice{background:#eef3ff;color:#36548a}.rust-word-scroll{flex:1;min-height:0;overflow:auto;padding:20px 24px}.rust-word-surface{position:relative;width:max-content;min-width:100%;user-select:none;touch-action:none}.rust-word-page{margin:0 auto 20px;background:#fff;box-shadow:0 4px 20px #29394f14;cursor:text}.rust-word-page svg{display:block;width:100%;height:100%;overflow:hidden}.rust-word-input{position:absolute;z-index:2;box-sizing:border-box;width:1px;height:1px;margin:0;padding:0;border:0;resize:none;opacity:.01;overflow:hidden;outline:0;color:transparent;background:transparent;caret-color:transparent;pointer-events:none}.rust-word-input.rust-word-composing{width:240px;height:30px;opacity:1;padding:2px 4px;border:1px solid #8ba4d5;color:#20242b;background:#fff;caret-color:#20242b;pointer-events:auto}.rust-word-status{display:flex;justify-content:space-between;padding:8px 18px;border-top:1px solid #dfe5ed;background:#fff;font-size:11px;color:#69768b}.rust-word-loading{padding:20px;text-align:center;color:#69768b;font-size:13px}.rust-word-toolbar :focus-visible{outline:2px solid #6385e5;outline-offset:2px}
</style>
