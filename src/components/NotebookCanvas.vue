<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import Icon from './Icon.vue'
import { blankRegion, noteId, validateImage, type NoteBlock, type NotePage, type NoteRegion } from '../notes/model'
import { blocksFromDom, blocksFromHtml, renderBlocks } from '../notes/dom'
import { moveRegion, nextRegionPosition, resizeRegion } from '../notes/layout'
import { canvasPoint, NOTE_GRID_SIZE, snapRegionPosition, type SnapGuide, type SnapRect, type SnapState } from '../notes/snapping'
import { createNoteSearchHighlighter, noteSearchMatches, noteSearchRanges, searchSegments } from '../notes/search'
import { bytesToBase64 } from '../shared/document'

const props = withDefaults(defineProps<{ page: NotePage; editable: boolean; query: string; smartAlignment?: boolean; snapToGrid?: boolean; commit: (regions: NoteRegion[]) => boolean }>(), { smartAlignment: true, snapToGrid: true })
const emit = defineEmits<{ error: [message: string]; status: [message: string]; busy: [value: boolean]; composing: [value: boolean]; pending: [value: boolean]; 'request-delete': [regionId: string]; history: [action: 'undo' | 'redo'] }>()
const surface = ref<HTMLElement>(), imageInput = ref<HTMLInputElement>()
const regions = shallowRef<NoteRegion[]>([]), selected = ref(''), busy = ref(false), composing = ref(false)
const bodies = new Map<string, HTMLElement>(), elements = new Map<string, HTMLElement>(), rendered = new Map<string, string>(), dirtyBodies = new Set<string>()
const measuredHeights = shallowRef<ReadonlyMap<string, number>>(new Map())
const alignmentGuides = shallowRef<SnapGuide[]>([])
const gestureExtent = shallowRef<{ width: number; height: number }>()
const resizeObserver = new ResizeObserver(entries => {
 const next = new Map(measuredHeights.value)
 let changed = false
 for (const entry of entries) {
  const element = entry.target as HTMLElement, id = element.dataset.regionId
  if (id && next.get(id) !== element.offsetHeight) { next.set(id, element.offsetHeight); changed = true }
 }
 if (changed) measuredHeights.value = next
})
let disposed = false, generation = 0, savedRange: Range | undefined, imageRequest: number | undefined
const highlighter = createNoteSearchHighlighter(document)
let highlightQueued = false
function highlight() {
 if (highlightQueued || disposed) return
 highlightQueued = true
 nextTick(() => { highlightQueued = false; if (!disposed) highlighter.refresh([...bodies.values()], props.query) })
}
let gesture: { pointerId: number; id: string; kind: 'move' | 'resize'; origin: { x: number; y: number }; client: { x: number; y: number }; original: NoteRegion; element: HTMLElement; bounds: SnapRect; neighbours: SnapRect[]; state: SnapState; moved: boolean; bypass: boolean } | undefined
const imageOf = (region: NoteRegion) => region.blocks.length === 1 && region.blocks[0].type === 'image' ? region.blocks[0] : undefined
const extent = computed(() => ({ width: Math.max(780, gestureExtent.value?.width ?? 0, ...regions.value.map(region => region.x + region.width + 64)), height: Math.max(700, gestureExtent.value?.height ?? 0, ...regions.value.map(region => region.y + Math.max(region.height ?? 40, measuredHeights.value.get(region.id) ?? 140) + 180)) }))
function report(error: unknown) { if (!disposed) emit('error', error instanceof Error ? error.message : String(error)) }
function setBusy(value: boolean) { busy.value = value; emit('busy', value) }
function markPending() { emit('pending', dirtyBodies.size > 0) }
// DOM reading and persisted validation order equivalent marks differently.
// Compare their meaning so normalizing a save never rebuilds the active caret.
function blockSignature(blocks: NoteBlock[]) { return JSON.stringify(blocks, (key, value) => key === 'marks' && Array.isArray(value) ? [...value].sort() : value) }
function bindBody(id: string, element: Element | ComponentPublicInstance | null) {
 if (!(element instanceof HTMLElement)) {
  const previous = bodies.get(id)
  nextTick(() => { if (previous && !previous.isConnected && bodies.get(id) === previous) { bodies.delete(id); rendered.delete(id); highlight() } })
  return
 }
 if (bodies.get(id) !== element) rendered.delete(id)
 bodies.set(id, element)
 const region = regions.value.find(region => region.id === id)
 if (region) renderBody(region)
 highlight()
}
function bindRegion(id: string, element: Element | ComponentPublicInstance | null) {
 if (element instanceof HTMLElement) { elements.set(id, element); resizeObserver.observe(element) }
 else {
  const previous = elements.get(id)
  nextTick(() => { if (previous && !previous.isConnected && elements.get(id) === previous) { resizeObserver.unobserve(previous); elements.delete(id) } })
 }
}
function renderBody(region: NoteRegion, force = false) {
 const body = bodies.get(region.id), signature = blockSignature(region.blocks)
 if (!body || (!force && rendered.get(region.id) === signature) || dirtyBodies.has(region.id)) return
 if (savedRange && body.contains(savedRange.commonAncestorContainer)) savedRange = undefined
 body.replaceChildren(renderBlocks(document, region.blocks)); rendered.set(region.id, signature)
}
function sync() {
 regions.value = structuredClone(props.page.regions)
 if (!regions.value.some(region => region.id === selected.value)) selected.value = ''
 for (const region of regions.value) renderBody(region)
}
function refresh() {
 sync()
 nextTick(() => { for (const region of regions.value) renderBody(region); highlight() })
}
function apply(candidate: NoteRegion[]) {
 if (!props.commit(candidate)) return false
 regions.value = structuredClone(candidate)
 return true
}
function flush(): boolean {
 if (composing.value || busy.value) return false
 if (!dirtyBodies.size) return true
 try {
  const candidate = structuredClone(regions.value)
  for (const id of dirtyBodies) {
   const body = bodies.get(id), region = candidate.find(region => region.id === id)
   if (body && region) region.blocks = blocksFromDom(body)
  }
  if (!apply(candidate)) return false
  for (const id of dirtyBodies) { const region = candidate.find(region => region.id === id); if (region) rendered.set(id, blockSignature(region.blocks)) }
  dirtyBodies.clear(); markPending(); return true
 } catch (cause) { report(cause); markPending(); return false }
}
function input(id: string) { dirtyBodies.add(id); markPending(); if (!composing.value) flush() }
function composition(id: string, value: boolean) {
 composing.value = value; emit('composing', value)
 if (!value) input(id)
}
function rememberSelection() {
 const selection = window.getSelection()
 if (!selection?.rangeCount) return
 for (const [id, body] of bodies) if (body.contains(selection.anchorNode) && body.contains(selection.focusNode)) { selected.value = id; savedRange = selection.getRangeAt(0).cloneRange(); return }
}
function restoreSelection() {
 const body = bodies.get(selected.value)
 if (!body) return false
 body.focus()
 const selection = window.getSelection()
 const range = savedRange && body.contains(savedRange.commonAncestorContainer) ? savedRange : document.createRange()
 if (range !== savedRange) { range.selectNodeContents(body); range.collapse(false) }
 selection?.removeAllRanges(); selection?.addRange(range)
 return true
}
function focus() {
 if (!bodies.has(selected.value)) selected.value = regions.value.find(region => !imageOf(region))?.id ?? ''
 restoreSelection()
}
function heights() { return new Map([...elements].map(([id, element]) => [id, element.offsetHeight])) }
function addText(position?: { x: number; y: number }) {
 if (!props.editable || busy.value || composing.value || !flush()) return false
 const point = position ?? nextRegionPosition(regions.value, heights()), region = blankRegion(Math.max(0, Math.min(19520, Math.round(point.x))), Math.max(24, Math.min(19520, Math.round(point.y))))
 if (!apply([...regions.value, region])) return false
 selected.value = region.id; savedRange = undefined
 nextTick(() => { renderBody(region); focus() })
 return true
}
function doubleClick(event: MouseEvent) {
 if (event.target !== surface.value) return
 const { rect, zoom } = canvasGeometry()
 addText(canvasPoint({ x: event.clientX, y: event.clientY }, rect, zoom))
}
function clearSelection() {
 if (gesture || busy.value || composing.value) return
 const region = elements.get(selected.value), active = document.activeElement
 if (active instanceof HTMLElement && region?.contains(active)) active.blur()
 const selection = window.getSelection()
 if (selection?.anchorNode && region?.contains(selection.anchorNode)) selection.removeAllRanges()
 selected.value = ''; savedRange = undefined
}
function clickCanvas(event: MouseEvent) {
 if (event.target instanceof Element && !event.target.closest('.note-region')) clearSelection()
}
function format(command: string, value?: string) {
 if (!props.editable || busy.value || composing.value || !restoreSelection()) return
 document.execCommand(command, false, value); input(selected.value); rememberSelection()
}
function insertFragment(fragment: DocumentFragment) {
 if (!restoreSelection()) return
 const selection = window.getSelection(); if (!selection?.rangeCount) return
 const range = selection.getRangeAt(0), end = fragment.lastChild
 range.deleteContents(); range.insertNode(fragment)
 if (end) { range.setStartAfter(end); range.collapse(true); selection.removeAllRanges(); selection.addRange(range) }
 input(selected.value); rememberSelection()
}
function todo() {
 if (!props.editable || busy.value || composing.value) return
 if (!bodies.has(selected.value)) { if (addText()) nextTick(todo); return }
 insertFragment(renderBlocks(document, [{ id: noteId(), type: 'todo', checked: false, content: [{ text: '待办事项' }] }]))
}
function beforeInput(event: InputEvent) {
 if (!props.editable || busy.value) { event.preventDefault(); return }
 if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
  // Native Edit menus can request history without sending a keyboard shortcut.
  event.preventDefault()
  if (!composing.value) emit('history', event.inputType === 'historyUndo' ? 'undo' : 'redo')
 }
}
function clickBody(id: string, event: MouseEvent) {
 selected.value = id
 if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') {
  if (!props.editable || busy.value) event.preventDefault(); else input(id)
 }
 rememberSelection()
}
async function paste(event: ClipboardEvent, id: string) {
 event.preventDefault(); selected.value = id; rememberSelection()
 if (!props.editable || busy.value || composing.value) return
 const file = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'))
 if (file) { await insertImage(file); return }
 try {
  const html = event.clipboardData?.getData('text/html'), text = event.clipboardData?.getData('text/plain') ?? ''
  if (!html) { restoreSelection(); document.execCommand('insertText', false, text); input(id); rememberSelection(); return }
  const blocks = blocksFromHtml(html), images = blocks.filter(block => block.type === 'image'), textBlocks = blocks.filter(block => block.type !== 'image')
  if (textBlocks.length) insertFragment(renderBlocks(document, textBlocks))
  if (images.length) await insertImages(images)
 } catch (cause) { report(cause) }
}
function chooseImage() {
 if (!props.editable || busy.value || composing.value || !flush()) return
 rememberSelection(); imageRequest = generation; setBusy(true); imageInput.value?.click()
}
function cancelImage() { imageRequest = undefined; setBusy(false) }
async function imageChosen(event: Event) {
 const input = event.target as HTMLInputElement, file = input.files?.[0], request = imageRequest
 input.value = ''; imageRequest = undefined; setBusy(false)
 if (file && request === generation) await insertImage(file)
}
async function dimensions(dataUrl: string) {
 const image = new Image(); image.src = dataUrl
 await image.decode()
 if (!image.naturalWidth || !image.naturalHeight) throw Error('无法读取这张图片。')
 const ratio = image.naturalHeight / image.naturalWidth
 // Give small images a usable resize target while preserving their proportions.
 const width = Math.max(80, 40 / ratio, Math.min(480, image.naturalWidth)), height = width * ratio
 if (width > 19500 || height > 19500) throw Error('图片比例过大，请先裁剪图片。')
 return { width: Math.round(width), height: Math.max(40, Math.round(height)) }
}
async function insertImage(file: File) {
 if (!props.editable || busy.value || composing.value || !flush()) return
 const owner = generation; setBusy(true)
 try {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 4 * 1024 * 1024) throw Error('请选择不超过 4 MB 的 PNG 或 JPEG 图片。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const block: NoteBlock = { id: noteId(), type: 'image', dataUrl: validateImage(`data:${file.type};base64,${bytesToBase64(bytes)}`), alt: Array.from(file.name).slice(0, 200).join('') }
  if (owner !== generation || disposed) return
  await appendImages([block], owner)
 } catch (cause) { report(cause) } finally { if (owner === generation) setBusy(false) }
}
async function insertImages(blocks: NoteBlock[]) {
 if (!flush()) return
 const owner = generation; setBusy(true)
 try { await appendImages(blocks, owner) } catch (cause) { report(cause) } finally { if (owner === generation) setBusy(false) }
}
async function appendImages(blocks: NoteBlock[], owner: number) {
 const candidate = structuredClone(regions.value)
 for (const block of blocks) {
  if (block.type !== 'image') continue
  const size = await dimensions(block.dataUrl)
  if (owner !== generation || disposed || !props.editable) return
  const point = nextRegionPosition(candidate, heights())
  candidate.push({ id: noteId(), x: point.x, y: Math.min(point.y, 20000 - size.height), ...size, blocks: [block] })
 }
 if (apply(candidate)) { selected.value = candidate.at(-1)!.id; savedRange = undefined; emit('status', '图片已插入，可拖动顶部手柄移动，拖动右下角等比缩放。') }
}
function startGesture(event: PointerEvent, region: NoteRegion, kind: 'move' | 'resize') {
 if (event.button !== 0 || !props.editable || busy.value || composing.value || !flush()) return
 event.preventDefault(); rememberSelection(); selected.value = region.id
 const element = event.currentTarget as HTMLElement
 const { rect, zoom } = canvasGeometry(), client = { x: event.clientX, y: event.clientY }
 const bounds = (region: NoteRegion): SnapRect => ({ id: region.id, x: region.x, y: region.y, width: region.width, height: Math.max(region.height ?? 40, elements.get(region.id)?.offsetHeight ?? 40) })
 gestureExtent.value = { ...extent.value }
 gesture = { pointerId: event.pointerId, id: region.id, kind, origin: canvasPoint(client, rect, zoom), client, original: structuredClone(region), element, bounds: bounds(region), neighbours: regions.value.map(bounds), state: {}, moved: false, bypass: event.altKey }
 alignmentGuides.value = []
 element.setPointerCapture(event.pointerId); document.addEventListener('keydown', globalKey, true); document.addEventListener('keyup', gestureModifier, true); setBusy(true)
}
function canvasGeometry() {
 const canvas = surface.value!, rect = canvas.getBoundingClientRect()
 return { rect, zoom: canvas.offsetWidth ? rect.width / canvas.offsetWidth : 1 }
}
function pointerMove(event: PointerEvent) {
 if (!gesture || gesture.pointerId !== event.pointerId) return
 gesture.client = { x: event.clientX, y: event.clientY }; gesture.bypass = event.altKey
 updateGesture()
}
function updateGesture() {
 if (!gesture) return
 const { rect, zoom } = canvasGeometry(), point = canvasPoint(gesture.client, rect, zoom)
 const original = gesture.original, dx = point.x - gesture.origin.x, dy = point.y - gesture.origin.y
 // Scrolling beneath a held pointer is also a drag, while a plain handle click
 // must not snap the block. Measure displacement against the current viewport.
 if (!gesture.moved && Math.hypot(dx * zoom, dy * zoom) < 2) return
 gesture.moved = true
 let updated: NoteRegion
 if (gesture.kind === 'move') {
  const result = snapRegionPosition(gesture.bounds, { x: original.x + dx, y: original.y + dy }, gesture.neighbours, { grid: props.snapToGrid, align: props.smartAlignment, zoom, previous: gesture.state, bypass: gesture.bypass })
  updated = { ...original, x: result.x, y: result.y }; gesture.state = result.state; alignmentGuides.value = result.guides
 } else updated = resizeRegion(original, imageOf(original) && Math.abs(dy) > Math.abs(dx) ? dy * original.width / (original.height ?? original.width) : dx)
 regions.value = regions.value.map(region => region.id === gesture!.id ? updated : region)
 // Preserve the largest drag extent, avoiding automatic scroll clamping feeding
 // back into another move as the last region is pulled inward from the edge.
 gestureExtent.value = { ...extent.value }
 highlight()
}
function gestureModifier(event: KeyboardEvent) { if (event.key === 'Alt' && gesture) { gesture.bypass = event.type === 'keydown'; updateGesture() } }
function finishGesture(cancel = false) {
 const current = gesture; if (!current) return
 gesture = undefined; alignmentGuides.value = []; gestureExtent.value = undefined
 document.removeEventListener('keydown', globalKey, true)
 document.removeEventListener('keyup', gestureModifier, true)
 if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
 if (cancel || (current.moved && !apply(regions.value))) regions.value = regions.value.map(region => region.id === current.id ? current.original : region)
 setBusy(false)
}
function pointerEnd(event: PointerEvent, cancel = false) {
 if (gesture?.pointerId !== event.pointerId) return
 // A final scroll or pointer displacement may arrive before the next move event.
 if (!cancel) { gesture.client = { x: event.clientX, y: event.clientY }; gesture.bypass = event.altKey; updateGesture() }
 finishGesture(cancel)
}
function controlKey(event: KeyboardEvent, region: NoteRegion, kind: 'move' | 'resize') {
 if (event.key === 'Escape' && gesture) { event.preventDefault(); finishGesture(true); return }
 if (!props.editable || busy.value || composing.value || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !flush()) return
 event.preventDefault(); event.stopPropagation()
 const step = event.shiftKey ? 20 : 2, direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -step : step
 const updated = kind === 'resize' ? resizeRegion(region, direction) : moveRegion(region, ['ArrowLeft', 'ArrowRight'].includes(event.key) ? direction : 0, ['ArrowUp', 'ArrowDown'].includes(event.key) ? direction : 0)
 apply(regions.value.map(item => item.id === region.id ? updated : item))
}
function removeRegion(region: NoteRegion) { if (props.editable && !busy.value && !composing.value && flush()) emit('request-delete', region.id) }
function globalKey(event: KeyboardEvent) {
 if (gesture && event.key === 'Alt') { gestureModifier(event); return }
 if (event.key !== 'Escape' || event.isComposing || composing.value) return
 if (gesture) { event.preventDefault(); finishGesture(true) }
 else if (selected.value) { event.preventDefault(); clearSelection() }
}
function revealMatch() {
 const viewport = surface.value?.parentElement
 if (!viewport || !props.query.trim()) return
 for (const region of regions.value) {
  let target: DOMRect | undefined
  const image = imageOf(region), body = bodies.get(region.id)
  if (image && noteSearchMatches(image.alt, props.query).length) target = elements.get(region.id)?.querySelector('mark')?.getBoundingClientRect() ?? elements.get(region.id)?.getBoundingClientRect()
  else if (body) target = noteSearchRanges(document, [body], props.query)[0]?.getClientRects()[0]
  if (!target) continue
  const view = viewport.getBoundingClientRect(), margin = 20
  const left = target.left < view.left + margin ? target.left - view.left - margin : target.right > view.right - margin ? target.right - view.right + margin : 0
  const top = target.top < view.top + margin ? target.top - view.top - margin : target.bottom > view.bottom - margin ? target.bottom - view.bottom + margin : 0
  viewport.scrollBy({ left, top, behavior: 'instant' })
  break
 }
}
watch(() => props.page.id, () => {
 generation++; finishGesture(true); imageRequest = undefined; setBusy(false); composing.value = false; emit('composing', false)
 dirtyBodies.clear(); markPending(); rendered.clear(); selected.value = ''; savedRange = undefined; refresh()
}, { immediate: true })
watch(() => props.page.regions, () => { if (!gesture && !dirtyBodies.size) refresh() })
watch(() => props.query, highlight)
watch(() => props.editable, value => { if (!value && gesture) finishGesture(true) })
onBeforeUnmount(() => { disposed = true; generation++; finishGesture(true); highlighter.destroy(); resizeObserver.disconnect(); bodies.clear(); elements.clear(); rendered.clear(); savedRange = undefined })
defineExpose({ format, todo, chooseImage, addText, rememberSelection, focus, flush, refresh, revealMatch, getTextElements: () => [...bodies.values()] })
</script>

<template>
 <div class="note-canvas-container" @keydown="globalKey" @click="clickCanvas" @scroll="updateGesture">
  <p class="note-canvas-hint"><Icon name="info" :size="16" />双击添加文字 · 拖动时按住 Alt / Option 自由移动 · 点击空白取消选择</p>
  <div ref="surface" class="note-canvas" :class="{ 'grid-enabled': snapToGrid }" data-testid="notebook-canvas" :style="{ minWidth: `${extent.width}px`, minHeight: `${extent.height}px`, '--note-grid-size': `${NOTE_GRID_SIZE}px` }" @dblclick="doubleClick" @pointermove="pointerMove" @pointerup="pointerEnd($event)" @pointercancel="pointerEnd($event, true)" @lostpointercapture="pointerEnd($event, true)">
   <section v-for="(region, index) in regions" :key="region.id" :ref="element => bindRegion(region.id, element)" class="note-region" :class="{ selected: selected === region.id, 'image-region': !!imageOf(region) }" :style="{ left: `${region.x}px`, top: `${region.y}px`, width: `${region.width}px`, minHeight: region.height ? `${region.height}px` : '40px' }" :data-region-id="region.id" :data-region-kind="imageOf(region) ? 'image' : 'text'" :tabindex="imageOf(region) ? 0 : undefined" @pointerdown="selected = region.id" @click="selected = region.id" @focusin="selected = region.id">
    <div class="note-region-controls">
     <button type="button" class="note-region-move" :aria-label="`移动${imageOf(region) ? '图片' : '文字'}区域 ${index + 1}`" title="拖动对齐和吸附；Alt / Option 自由移动；方向键微调，Shift 加速" :disabled="!editable" @pointerdown="startGesture($event, region, 'move')" @keydown="controlKey($event, region, 'move')"><svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" /></svg><span>{{ imageOf(region) ? '图片' : '文字区域' }}</span></button>
     <button type="button" class="note-region-delete" :aria-label="imageOf(region) ? `删除图片${imageOf(region)!.alt ? `：${imageOf(region)!.alt}` : ''}` : `删除文字区域 ${index + 1}`" title="删除区域" :disabled="!editable || busy" @click="removeRegion(region)"><Icon name="trash" :size="16" /></button>
    </div>
    <template v-if="imageOf(region)"><img class="note-region-image" :src="imageOf(region)!.dataUrl" :alt="imageOf(region)!.alt" :style="{ height: `${region.height ?? region.width}px` }" draggable="false" /><div v-if="query.trim() && searchSegments(imageOf(region)!.alt, query).some(part => part.match)" class="note-image-caption"><template v-for="(part, partIndex) in searchSegments(imageOf(region)!.alt, query)" :key="partIndex"><mark v-if="part.match">{{ part.text }}</mark><span v-else>{{ part.text }}</span></template></div></template>
    <div v-else :ref="element => bindBody(region.id, element)" class="note-region-body" data-testid="notebook-content" role="textbox" :aria-label="`文字区域 ${index + 1}`" aria-multiline="true" :contenteditable="editable && !busy" spellcheck="true" @input="input(region.id)" @beforeinput="beforeInput" @compositionstart="composition(region.id, true)" @compositionend="composition(region.id, false)" @paste="paste($event, region.id)" @drop.prevent @dragover.prevent @click="clickBody(region.id, $event)" @focus="selected = region.id" @keyup="rememberSelection" @mouseup="rememberSelection" @blur="rememberSelection" />
    <button type="button" class="note-region-resize" :aria-label="imageOf(region) ? `调整图片大小 ${index + 1}` : `调整文字区域宽度 ${index + 1}`" :title="imageOf(region) ? '拖动等比缩放；方向键微调，Shift 加速' : '拖动调整宽度；方向键微调，Shift 加速'" :disabled="!editable" @pointerdown="startGesture($event, region, 'resize')" @keydown="controlKey($event, region, 'resize')"><svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M12 17h5v-5" /></svg></button>
   </section>
   <div v-for="guide in alignmentGuides" :key="guide.axis" class="note-alignment-guide" :class="`guide-${guide.axis}`" :data-axis="guide.axis" :data-position="guide.position" aria-hidden="true" :style="guide.axis === 'x' ? { left: `${guide.position}px`, top: `${guide.start}px`, height: `${guide.end - guide.start}px` } : { top: `${guide.position}px`, left: `${guide.start}px`, width: `${guide.end - guide.start}px` }" />
  </div>
  <input ref="imageInput" class="note-image-input" type="file" accept="image/png,image/jpeg" aria-label="插入图片文件" @change="imageChosen" @cancel="cancelImage" />
 </div>
</template>

<style scoped>
.note-canvas-container{position:relative;min-width:0;min-height:0;overflow:auto;flex:1}.note-canvas-hint{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--note-muted);padding:0 24px;margin:4px 0 24px;white-space:nowrap}.note-canvas{position:relative;box-sizing:border-box;background-image:radial-gradient(var(--note-line) .7px,transparent .7px);background-size:20px 20px}.note-region{position:absolute;box-sizing:border-box;border:1px solid transparent;border-radius:5px;background:transparent;outline:none}.note-region.selected{border-color:color-mix(in srgb,var(--note-accent) 36%,var(--note-line));background:var(--note-surface)}.note-region-controls{position:absolute;left:-1px;right:-1px;bottom:100%;height:25px;display:flex;justify-content:space-between;align-items:center;opacity:0;visibility:hidden;pointer-events:none;border:1px solid var(--note-line);border-radius:6px 6px 0 0;background:var(--note-surface)}.note-region.selected .note-region-controls{opacity:1;visibility:visible;pointer-events:auto}.note-region-controls button,.note-region-resize{display:inline-flex;align-items:center;justify-content:center;gap:5px;font:11px var(--ui-font);color:var(--note-muted);padding:2px 6px;border:0;background:transparent;border-radius:4px;cursor:pointer;box-sizing:border-box}.note-region-controls button:focus-visible,.note-region-resize:focus-visible{outline:2px solid var(--note-accent);outline-offset:2px}.note-region-controls button:hover,.note-region-resize:hover{color:var(--note-accent);background:color-mix(in srgb,var(--note-accent) 10%,transparent)}.note-region-controls .note-region-move{cursor:grab;touch-action:none;flex:1;justify-content:flex-start;height:23px}.note-region-controls .note-region-move:active{cursor:grabbing}.note-region-delete{height:23px;width:28px}.note-region-resize{position:absolute;right:-8px;bottom:-8px;width:22px;height:22px;cursor:nwse-resize;touch-action:none;background:var(--note-surface);border:1px solid var(--note-line);color:var(--note-accent);opacity:0;visibility:hidden;pointer-events:none}.note-region.selected .note-region-resize{opacity:1;visibility:visible;pointer-events:auto}.note-region-body{font-family:var(--document-font);font-synthesis:weight style;min-height:40px;box-sizing:border-box;padding:10px 12px;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.85}.note-region-body :deep(div){min-height:1.85em}.note-region-body :deep(h1){font-size:27px;margin:14px 0 8px;line-height:1.4}.note-region-body :deep(h2){font-size:22px;margin:12px 0 6px}.note-region-body :deep(h3){font-size:18px;margin:10px 0 5px}.note-region-body :deep(ul),.note-region-body :deep(ol){padding-left:26px;margin:8px 0}.note-region-body :deep(code){background:color-mix(in srgb,var(--note-muted) 12%,transparent);padding:2px 5px;border-radius:4px;font:14px/1.6 ui-monospace,monospace}.note-region-body :deep(input[type=checkbox]){accent-color:var(--note-accent);margin:0 10px 0 0;vertical-align:middle;width:15px;height:15px}.note-region-body :deep([data-note-type=todo]:has(input:checked)){color:var(--note-muted);text-decoration:line-through}.note-region-image{display:block;width:100%;object-fit:contain;user-select:none;border-radius:4px}.note-image-caption{font:11px/1.5 var(--ui-font);padding:4px 6px;overflow-wrap:anywhere}.note-image-caption mark{background:#ffd761;color:#312408;border-radius:2px}.note-image-input{display:none}.note-region-controls button:disabled,.note-region-resize:disabled{cursor:default;opacity:.4}
.note-canvas{background-image:none}.note-canvas.grid-enabled{background-image:radial-gradient(var(--note-line) .7px,transparent .7px);background-size:var(--note-grid-size) var(--note-grid-size);background-position:-5px -5px}
.note-alignment-guide{position:absolute;z-index:3;pointer-events:none;background:var(--note-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--note-surface) 60%,transparent)}.guide-x{width:1px}.guide-y{height:1px}.note-alignment-guide::before,.note-alignment-guide::after{content:'';position:absolute;width:5px;height:5px;border:1px solid var(--note-accent);background:var(--note-surface);box-sizing:border-box;transform:translate(-2px,-2px)}.guide-x::after{bottom:0}.guide-y::after{right:0}
</style>
