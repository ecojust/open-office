<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { compileCodeDiagram, DiagramSyntaxError, lookupDiagramSource, type CodeDiagramResult } from '../core/code-diagram.ts'
import { sceneToSvg } from '../core/svg.ts'
import { combineBounds, edgePoints, elementBounds, pointsPath } from '../core/geometry.ts'
import { clone, DEFAULT_STYLE, newId, type Scene } from '../core/types.ts'
import { DIAGRAM_TEMPLATES, DIAGRAM_KIND_LABELS } from '../core/diagrams/catalog.ts'
import { applyDiagramStyle, DIAGRAM_STYLES, normalizeDiagramStyle, type DiagramStyleId } from '../core/diagram-appearance.ts'
import type { DiagramKind, DiagramTemplate } from '../core/diagrams/common.ts'
import AppIcon from './AppIcon.vue'

const props = withDefaults(defineProps<{ source: string; theme: 'light' | 'dark'; diagramStyle?: DiagramStyleId; active?: boolean; disabled?: boolean }>(), { active: true, disabled: false })
const emit = defineEmits<{ change: [source: string]; changeStyle: [id: DiagramStyleId]; createFlow: [scene: Scene]; export: [format: 'png' | 'svg']; status: [message: string]; pending: [value: boolean] }>()
const composing = ref(false)
const interactive = computed(() => props.active && !props.disabled)
const draft = ref(props.source), sourceInput = ref<HTMLTextAreaElement>(), error = ref(''), errorLine = ref(0)
const compiled = ref<CodeDiagramResult | null>(null), parsing = ref(false), scrollTop = ref(0), zoom = ref(1)
const compiledSource = ref(''), selection = ref({ start: 0, end: 0, head: 0 })
const previewScroll = ref<HTMLElement>(), sourceOverlay = ref<SVGSVGElement>()
type LibraryTemplate = DiagramTemplate & { kind: DiagramKind }
const templatesOpen = ref(false), templateCategory = ref('all'), templateSearch = ref('')
const pendingTemplate = ref<LibraryTemplate>(), templateDialog = ref<HTMLElement>(), templateSearchInput = ref<HTMLInputElement>(), templateButton = ref<HTMLButtonElement>()
const stylesOpen = ref(false), styleDialog = ref<HTMLElement>(), styleButton = ref<HTMLButtonElement>()
const exportOpen = ref(false), exportControl = ref<HTMLElement>(), exportButton = ref<HTMLButtonElement>(), exportMenu = ref<HTMLElement>()
const exportMenuId = newId('diagram-image-export')
const errorId = newId('diagram-error'), styleTitleId = newId('diagram-style-title'), styleDescriptionId = newId('diagram-style-description')
const templateTitleId = newId('diagram-template-title'), replaceTitleId = newId('diagram-replace-title')
const canExport = computed(() => Boolean(compiled.value && !parsing.value && !error.value && compiledSource.value === draft.value))
const currentStyleId = computed(() => normalizeDiagramStyle(props.diagramStyle))
const currentStyle = computed(() => DIAGRAM_STYLES.find(style => style.id === currentStyleId.value)!)
const modalOpen = computed(() => templatesOpen.value || stylesOpen.value)
let timer: ReturnType<typeof setTimeout> | undefined, published = props.source
// Textareas expose LF-normalized offsets; the saved source keeps its original endings.
const sourcePositions = computed(() => {
  const toRaw = [0], lineStarts = [0]
  for (let offset = 0; offset < draft.value.length; offset++) {
    const newline = draft.value[offset] === '\r' || draft.value[offset] === '\n'
    if (draft.value[offset] === '\r' && draft.value[offset + 1] === '\n') offset++
    toRaw.push(offset + 1)
    if (newline) lineStarts.push(toRaw.length - 1)
  }
  return { toRaw, lineStarts }
})
const lines = computed(() => Array.from({ length: sourcePositions.value.lineStarts.length }, (_, index) => index + 1).join('\n'))
const styledScene = computed(() => compiled.value ? applyDiagramStyle(compiled.value.scene, currentStyleId.value) : undefined)
const svg = computed(() => styledScene.value ? sceneToSvg(styledScene.value, { background: true }) : '')
// Match the rendered page exactly, including its export padding and aspect ratio.
const previewViewBox = computed(() => svg.value.match(/\bviewBox="([^"]+)"/)?.[1] || '0 0 1 1')
const cursorLine = computed(() => draft.value.slice(0, selection.value.head).split(/\r\n|\r|\n/).length)
const sourceElementIds = computed(() => {
  if (!compiled.value || parsing.value || error.value || compiledSource.value !== draft.value) return []
  const { start, end } = selection.value
  const result = lookupDiagramSource(compiled.value.sourceMap, start, end)
  if (result.length || start !== end) return result
  // End stops after the final token, so keep that token located at a line boundary.
  if (start > 0 && (start === draft.value.length || /[\r\n]/.test(draft.value[start]!)) && !/\s/.test(draft.value[start - 1]!)) {
    return lookupDiagramSource(compiled.value.sourceMap, start - 1)
  }
  return []
})
const sourceHighlights = computed(() => {
  const scene = styledScene.value
  if (!scene) return []
  const ids = new Set(sourceElementIds.value)
  return scene.elements.filter(element => ids.has(element.id)).map(element => {
    const points = element.type === 'edge' ? edgePoints(element, scene) : element.type === 'stroke' ? element.points : undefined
    const bounds = points ? elementBounds({ ...element, type: 'stroke', points }) : elementBounds(element)
    return { id: element.id, bounds, path: points ? pointsPath(points) + (element.type === 'stroke' && element.closed ? ' Z' : '') : '' }
  })
})
const sourceLocation = computed(() => `第 ${cursorLine.value} 行 · ${parsing.value ? '等待预览更新' : sourceHighlights.value.length ? `已定位 ${sourceHighlights.value.length} 个图形` : '此处无对应图形'}`)
const kindLabel = computed(() => compiled.value ? DIAGRAM_KIND_LABELS[compiled.value.kind] : '图表')
const elementCount = computed(() => compiled.value?.scene.elements.length ?? 0)
const categories = computed(() => [...new Set(DIAGRAM_TEMPLATES.map(template => template.category))])
const kindsCount = computed(() => new Set(DIAGRAM_TEMPLATES.map(template => template.kind)).size)
const kindsList = computed(() => [...new Set(DIAGRAM_TEMPLATES.map(template => DIAGRAM_KIND_LABELS[template.kind]))].join('、'))
const visibleTemplates = computed(() => {
  const search = templateSearch.value.trim().toLocaleLowerCase()
  return DIAGRAM_TEMPLATES.filter(template => (templateCategory.value === 'all' || template.category === templateCategory.value)
    && (!search || `${template.title} ${template.description} ${DIAGRAM_KIND_LABELS[template.kind]} ${template.kind} ${template.source}`.toLocaleLowerCase().includes(search)))
})
const syntaxTemplate = computed(() => DIAGRAM_TEMPLATES.find(template => template.kind === (compiled.value?.kind || 'flowchart')))
const syntaxExample = computed(() => syntaxTemplate.value?.source || '')

// Thumbnails use the same style transformation and SVG renderer as the live diagram.
const styleExample: Scene = {
  background: '#ffffff', grid: false,
  elements: [
    { id: 'style-start', type: 'shape', shape: 'rectangle', x: 8, y: 28, width: 48, height: 32, text: '开始', style: { ...DEFAULT_STYLE, fill: '#eff6ff', fontSize: 11 }, locked: false },
    { id: 'style-choice', type: 'shape', shape: 'diamond', x: 82, y: 20, width: 44, height: 48, text: '判断', style: { ...DEFAULT_STYLE, fill: '#fff7dc', fontSize: 11 }, locked: false },
    { id: 'style-end', type: 'shape', shape: 'ellipse', x: 152, y: 28, width: 48, height: 32, text: '完成', style: { ...DEFAULT_STYLE, fill: '#e8f7ef', fontSize: 11 }, locked: false },
    { id: 'style-first', type: 'edge', from: { x: 0, y: 0, nodeId: 'style-start' }, to: { x: 0, y: 0, nodeId: 'style-choice' }, label: '', arrow: 'end', route: 'orthogonal', style: { ...DEFAULT_STYLE }, locked: false },
    { id: 'style-second', type: 'edge', from: { x: 0, y: 0, nodeId: 'style-choice' }, to: { x: 0, y: 0, nodeId: 'style-end' }, label: '', arrow: 'end', route: 'orthogonal', style: { ...DEFAULT_STYLE }, locked: false },
  ],
}
const stylePreviews = DIAGRAM_STYLES.map(style => ({ ...style, svg: sceneToSvg(applyDiagramStyle(styleExample, style.id), { background: true }) }))

async function openStyles() {
  if (!interactive.value || !flush()) return
  closeExportMenu(); templatesOpen.value = false; pendingTemplate.value = undefined; stylesOpen.value = true
  await nextTick()
  const selected = styleDialog.value?.querySelector<HTMLButtonElement>('[data-diagram-style][aria-pressed="true"]')
  selected?.scrollIntoView({ block: 'nearest' }); selected?.focus({ preventScroll: true })
}
function closeStyles() {
  stylesOpen.value = false
  nextTick(() => styleButton.value?.focus({ preventScroll: true }))
}
function chooseStyle(id: DiagramStyleId) {
  if (!interactive.value || !flush()) return
  if (id === currentStyleId.value) return
  emit('changeStyle', id)
  emit('status', `已应用“${DIAGRAM_STYLES.find(style => style.id === id)!.label}”风格，可撤销恢复`)
}
function styleDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeStyles(); return }
  if (!styleDialog.value) return
  if (event.key === 'Tab') {
    const controls = [...styleDialog.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(element => element.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    return
  }
  // Keep document shortcuts (undo, redo, save) available while the style panel is open.
  if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const cards = [...styleDialog.value.querySelectorAll<HTMLButtonElement>('[data-diagram-style]')]
  const index = cards.findIndex(card => card === document.activeElement)
  if (index < 0) return
  event.preventDefault(); event.stopPropagation()
  const firstRow = cards[0]?.getBoundingClientRect().top
  const columns = Math.max(1, cards.filter(card => Math.abs(card.getBoundingClientRect().top - (firstRow ?? 0)) < 1).length)
  let next = index
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = cards.length - 1
  else if (event.key === 'ArrowUp') next = index >= columns ? index - columns : index + columns * Math.floor((cards.length - 1 - index) / columns)
  else if (event.key === 'ArrowDown') next = index + columns < cards.length ? index + columns : index % columns
  else next = (index + (event.key === 'ArrowLeft' ? -1 : 1) + cards.length) % cards.length
  cards[next]?.focus()
}

async function openTemplates() {
  if (!interactive.value || !flush()) return
  closeExportMenu(); stylesOpen.value = false; pendingTemplate.value = undefined; templatesOpen.value = true
  await nextTick(); templateSearchInput.value?.focus({ preventScroll: true })
}
function closeTemplates(focusSource = false) {
  templatesOpen.value = false; pendingTemplate.value = undefined
  nextTick(() => (focusSource ? sourceInput.value : templateButton.value)?.focus({ preventScroll: true }))
}
function chooseTemplate(template: LibraryTemplate) {
  if (!interactive.value || composing.value) return
  if (draft.value === template.source) { closeTemplates(); emit('status', '当前源码已经是此模板'); return }
  if (draft.value.trim()) {
    pendingTemplate.value = template
    nextTick(() => templateDialog.value?.querySelector<HTMLButtonElement>('[data-template-cancel]')?.focus({ preventScroll: true }))
    return
  }
  applyTemplate(template)
}
function applyTemplate(template: LibraryTemplate) {
  if (!interactive.value || composing.value) return
  // Publish pending input separately so replacing a template is one undoable change.
  clearTimeout(timer); publish()
  draft.value = template.source; publish(); parse(); zoom.value = 1; scrollTop.value = 0
  if (sourceInput.value) sourceInput.value.scrollTop = 0
  nextTick(() => { sourceInput.value?.setSelectionRange(0, 0); syncSelection() })
  closeTemplates(true); emit('status', `已使用“${template.title}”，可撤销恢复原源码`)
}
function backToTemplates() {
  pendingTemplate.value = undefined
  nextTick(() => templateSearchInput.value?.focus({ preventScroll: true }))
}
function dialogKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Escape') { event.preventDefault(); if (pendingTemplate.value) backToTemplates(); else closeTemplates(); return }
  if (event.key !== 'Tab' || !templateDialog.value) return
  const controls = [...templateDialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')]
    .filter(element => element.getClientRects().length)
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

async function openExportMenu(last = false) {
  if (!interactive.value || !canExport.value) return
  exportOpen.value = true
  await nextTick()
  const items = exportMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  items?.[last ? items.length - 1 : 0]?.focus({ preventScroll: true })
}
function closeExportMenu(restoreFocus = false) {
  exportOpen.value = false
  if (restoreFocus) nextTick(() => exportButton.value?.focus({ preventScroll: true }))
}
function toggleExportMenu() { if (exportOpen.value) closeExportMenu(); else void openExportMenu() }
function chooseImageExport(format: 'png' | 'svg') {
  if (!canExport.value) { closeExportMenu(); return }
  if (!flush()) return
  if (!canExport.value) { closeExportMenu(); return }
  closeExportMenu(true)
  emit('export', format)
}
function exportMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeExportMenu(true); return }
  if (event.key === 'Tab') {
    event.preventDefault(); event.stopPropagation(); closeExportMenu()
    nextTick(() => (event.shiftKey ? exportButton.value : sourceInput.value)?.focus({ preventScroll: true }))
    return
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  const items = [...(exportMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])]
  const index = items.findIndex(item => item === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
  items[next]?.focus({ preventScroll: true })
}
function closeExportOutside(event: Event) {
  if (exportOpen.value && event.target instanceof Node && !exportControl.value?.contains(event.target)) closeExportMenu()
}
watch(canExport, value => { if (!value) closeExportMenu() })

function publish() { if (composing.value) return; if (draft.value !== published) { published = draft.value; emit('change', draft.value) } }
function parse() {
  parsing.value = false
  try {
    compiled.value = compileCodeDiagram(draft.value); error.value = ''; errorLine.value = 0
    compiledSource.value = draft.value
    emit('status', `${kindLabel.value} · ${elementCount.value} 个图元`)
  } catch (cause) {
    compiledSource.value = ''
    compiled.value = null; error.value = cause instanceof Error ? cause.message : '无法解析此源码。'
    errorLine.value = cause instanceof DiagramSyntaxError ? cause.line : 0
    emit('status', '代码图表源码需要修正')
  }
}
function onInput() {
  clearTimeout(timer); parsing.value = true
  if (composing.value) return
  syncSelection()
  timer = setTimeout(() => { publish(); parse() }, 220)
}
function flush(): boolean { if (composing.value) return false; clearTimeout(timer); publish(); if (compiledSource.value !== draft.value || error.value) parse(); return true }
function compositionStart() { composing.value = true; clearTimeout(timer) }
function compositionEnd() { composing.value = false; draft.value = sourceInput.value?.value ?? draft.value; onInput() }
function createFlow() { if (!interactive.value || !flush()) return; if (styledScene.value) emit('createFlow', clone(styledScene.value)) }
function onKeydown(event: KeyboardEvent) {
  if (!interactive.value || composing.value || event.isComposing) return
  if (event.key !== 'Tab') return
  event.preventDefault()
  const input = sourceInput.value!
  const domStart = input.selectionStart, start = rawSourceOffset(domStart), end = rawSourceOffset(input.selectionEnd)
  draft.value = draft.value.slice(0, start) + '  ' + draft.value.slice(end)
  nextTick(() => { input.selectionStart = input.selectionEnd = domStart + 2; syncSelection() })
  onInput()
}
function rawSourceOffset(domOffset: number) {
  const positions = sourcePositions.value.toRaw
  return positions[Math.max(0, Math.min(domOffset, positions.length - 1))]!
}
function syncSelection() {
  const input = sourceInput.value
  if (!input) return
  const start = rawSourceOffset(input.selectionStart), end = rawSourceOffset(input.selectionEnd)
  selection.value = { start, end, head: input.selectionDirection === 'backward' ? start : end }
}
function locateCurrent() {
  const overlay = sourceOverlay.value, container = previewScroll.value
  if (!overlay || !container || !sourceHighlights.value.length) return
  const transform = overlay.getScreenCTM()
  if (!transform) return
  const bounds = combineBounds(sourceHighlights.value.map(highlight => highlight.bounds)), point = overlay.createSVGPoint()
  point.x = bounds.x + bounds.width / 2; point.y = bounds.y + bounds.height / 2
  const screen = point.matrixTransform(transform), viewport = container.getBoundingClientRect()
  container.scrollTo({ left: container.scrollLeft + screen.x - viewport.left - container.clientWidth / 2, top: container.scrollTop + screen.y - viewport.top - container.clientHeight / 2, behavior: 'auto' })
}
function locateError() {
  if (!sourceInput.value || !errorLine.value) return
  const start = sourcePositions.value.lineStarts[errorLine.value - 1] ?? sourceInput.value.value.length
  const end = sourceInput.value.value.indexOf('\n', start)
  sourceInput.value.focus(); sourceInput.value.setSelectionRange(start, end < 0 ? sourceInput.value.value.length : end)
  sourceInput.value.scrollTop = Math.max(0, (errorLine.value - 3) * 23)
  scrollTop.value = sourceInput.value.scrollTop
  syncSelection()
}
watch(() => props.source, value => {
  if (value === draft.value) { published = value; return }
  if (composing.value) return
  clearTimeout(timer); published = value; draft.value = value; parse()
  nextTick(syncSelection)
})
onMounted(() => { document.addEventListener('pointerdown', closeExportOutside, true); document.addEventListener('focusin', closeExportOutside) })
onBeforeUnmount(() => { document.removeEventListener('pointerdown', closeExportOutside, true); document.removeEventListener('focusin', closeExportOutside); clearTimeout(timer) })
function hasDirtyDraft() { return composing.value || draft.value !== props.source }
function hasPendingEdits() { return hasDirtyDraft() || modalOpen.value }
watch([draft, composing, () => props.source], () => emit('pending', hasDirtyDraft()), { flush: 'sync' })
watch(() => props.active, value => { if (!value) { closeExportMenu(); stylesOpen.value = false; templatesOpen.value = false; pendingTemplate.value = undefined } })
defineExpose({ flush, hasPendingEdits, hasDirtyDraft, focus: () => sourceInput.value?.focus() })
parse()
</script>

<template>
  <section class="diagram-editor" :class="{ 'is-dark': theme === 'dark' }" aria-label="代码图表编辑器" :inert="!interactive">
    <div class="diagram-toolbar" :inert="modalOpen">
      <div class="diagram-toolbar-start"><div class="diagram-title"><AppIcon name="code" :size="18"/><strong>代码图表</strong><span class="diagram-badge">{{ kindsCount }} 类图表</span></div></div>
      <div class="diagram-toolbar-actions"><button ref="styleButton" type="button" class="diagram-style-toggle" :aria-label="`图表风格，当前${currentStyle.label}`" :title="`图表风格 · ${currentStyle.label}`" :aria-expanded="stylesOpen" aria-haspopup="dialog" data-testid="diagram-style-toggle" @click="openStyles"><AppIcon name="palette" :size="18"/><span>图表风格<small>{{ currentStyle.label }}</small></span><AppIcon name="chevron" :size="12"/></button>
      <button ref="templateButton" type="button" class="diagram-template-toggle" aria-label="图表类型与模板" :aria-expanded="templatesOpen" aria-haspopup="dialog" data-testid="diagram-template-toggle" @click="openTemplates"><AppIcon name="templates" :size="16"/><span>图表模板</span><AppIcon name="chevron" :size="12"/></button>
      <button type="button" class="diagram-convert" aria-label="创建独立画布" data-testid="diagram-create-copy" :disabled="!compiled || parsing" @click="createFlow"><AppIcon name="duplicate" :size="16"/><span>创建独立画布</span></button>
      <div ref="exportControl" class="diagram-image-export"><button ref="exportButton" type="button" class="diagram-export-toggle" aria-label="导出图片" :title="parsing ? '正在更新预览，完成后可导出图片' : error ? '请先修正源码后再导出图片' : '导出 PNG 图片或 SVG 矢量图'" :disabled="!canExport" :aria-expanded="exportOpen" :aria-controls="exportMenuId" aria-haspopup="menu" data-testid="diagram-export-image" @click="toggleExportMenu" @keydown.down.prevent.stop="openExportMenu()" @keydown.up.prevent.stop="openExportMenu(true)" @keydown.escape.prevent.stop="closeExportMenu(true)"><AppIcon name="image" :size="17"/><span>导出图片</span><AppIcon name="chevron" :size="12"/></button>
        <div v-if="exportOpen" :id="exportMenuId" ref="exportMenu" class="diagram-export-menu" role="menu" aria-label="导出图片格式" data-testid="diagram-export-menu" @keydown="exportMenuKeydown"><button type="button" role="menuitem" tabindex="-1" data-testid="diagram-export-png" @click="chooseImageExport('png')"><AppIcon name="image" :size="17"/><span>PNG 图片<small>适合文档和演示</small></span></button><button type="button" role="menuitem" tabindex="-1" data-testid="diagram-export-svg" @click="chooseImageExport('svg')"><AppIcon name="shapes" :size="17"/><span>SVG 矢量图<small>放大后保持清晰</small></span></button></div>
      </div></div>
    </div>
    <div class="diagram-workspace" :inert="modalOpen">
      <div class="diagram-source-panel">
        <div class="diagram-panel-title"><span>源码</span><span>修改后自动预览</span></div>
        <div class="diagram-code">
          <div class="diagram-gutter" aria-hidden="true"><pre :style="{ transform: `translateY(${-scrollTop}px)` }">{{ lines }}</pre></div>
          <textarea ref="sourceInput" v-model="draft" maxlength="500000" @compositionstart="compositionStart" @compositionend="compositionEnd" aria-label="代码图表源码" data-testid="diagram-source" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" :aria-invalid="Boolean(error)" :aria-describedby="error ? errorId : undefined" @input="onInput" @blur="flush" @keydown="onKeydown" @keyup="syncSelection" @click="syncSelection" @select="syncSelection" @selectionchange="syncSelection" @pointerup="syncSelection" @focus="syncSelection" @scroll="scrollTop = ($event.target as HTMLTextAreaElement).scrollTop" />
        </div>
        <div class="diagram-source-location" data-testid="diagram-source-location"><AppIcon name="cursor" :size="13"/><span>{{ sourceLocation }}</span><button type="button" aria-label="定位当前图形" title="将当前图形移到预览中央" data-testid="diagram-locate-current" :disabled="!sourceHighlights.length" @click="locateCurrent"><AppIcon name="fit" :size="14"/><span>定位图形</span></button></div>
        <details class="diagram-help">
          <summary><AppIcon name="chevron-right" :size="13"/><AppIcon name="help" :size="14"/><span>语法示例与支持范围</span></summary>
          <p><strong>{{ syntaxTemplate ? DIAGRAM_KIND_LABELS[syntaxTemplate.kind] : '图表' }}</strong> · {{ syntaxTemplate?.description }}</p>
          <pre class="diagram-syntax-example">{{ syntaxExample }}</pre>
          <p>模板包含{{ kindsList }}。示例源码可直接编辑。</p>
          <p>支持这些类型的常用语法子集；未实现的指令会提示具体行号。源码独立保存，创建独立画布后可调整图元；副本的修改不会反写源码。</p>
        </details>
      </div>
      <div class="diagram-preview-panel">
        <div class="diagram-panel-title"><span>预览 <span v-if="compiled" class="diagram-preview-kind"><AppIcon :name="compiled.kind" :size="12"/>{{ kindLabel }}</span></span><div class="diagram-zoom"><button type="button" aria-label="缩小预览" :disabled="zoom <= .4" @click="zoom = Math.max(.4, zoom - .2)"><AppIcon name="minus" :size="13"/></button><button type="button" aria-label="重置预览缩放" @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button><button type="button" aria-label="放大预览" :disabled="zoom >= 3" @click="zoom = Math.min(3, zoom + .2)"><AppIcon name="plus" :size="13"/></button></div></div>
        <div v-if="parsing" class="diagram-parsing" role="status"><span class="diagram-spinner" />正在解析…</div>
        <div v-if="error && !parsing" :id="errorId" class="diagram-error" role="alert" data-testid="diagram-error">
          <strong><AppIcon name="alert" :size="16"/>源码需要修正</strong><p>{{ error }}</p><button v-if="errorLine" type="button" @click="locateError"><AppIcon name="search" :size="14"/>定位到第 {{ errorLine }} 行</button>
        </div>
        <div v-if="compiled" ref="previewScroll" class="diagram-preview-scroll" :aria-busy="parsing">
          <div class="diagram-preview" :style="{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%` }">
            <div class="diagram-preview-page">
              <div class="diagram-preview-art" data-testid="diagram-preview" v-html="svg"/>
              <svg v-if="sourceHighlights.length" ref="sourceOverlay" class="diagram-source-overlay" data-testid="diagram-source-overlay" :viewBox="previewViewBox" aria-hidden="true">
                <g v-for="highlight in sourceHighlights" :key="highlight.id" :data-source-element-id="highlight.id">
                  <template v-if="highlight.path"><path :d="highlight.path" class="diagram-highlight-path-glow"/><path :d="highlight.path" class="diagram-highlight-path-halo"/><path :d="highlight.path" class="diagram-highlight-path"/></template>
                  <template v-else><rect :x="highlight.bounds.x - 5" :y="highlight.bounds.y - 5" :width="highlight.bounds.width + 10" :height="highlight.bounds.height + 10" rx="7" class="diagram-highlight-halo"/><rect :x="highlight.bounds.x - 5" :y="highlight.bounds.y - 5" :width="highlight.bounds.width + 10" :height="highlight.bounds.height + 10" rx="7" class="diagram-highlight-shape"/></template>
                </g>
              </svg>
            </div>
          </div>
        </div>
        <div v-if="compiled?.warnings.length" class="diagram-warnings" role="status"><p v-for="warning in compiled.warnings" :key="warning">{{ warning }}</p></div>
        <div v-if="!compiled && !error && !parsing" class="diagram-empty">在左侧输入源码，即可绘制图表。</div>
      </div>
    </div>
    <div v-if="stylesOpen" class="diagram-library-backdrop diagram-style-backdrop" @click.self="closeStyles" @keydown="styleDialogKeydown">
      <section ref="styleDialog" class="diagram-library diagram-style-library" role="dialog" aria-modal="true" :aria-labelledby="styleTitleId" :aria-describedby="styleDescriptionId" data-testid="diagram-style-panel">
        <header><div><AppIcon name="palette" :size="20"/><h2 :id="styleTitleId">图表风格</h2></div><button type="button" class="diagram-library-close" aria-label="关闭图表风格" @click="closeStyles"><AppIcon name="close" :size="17"/></button></header>
        <p :id="styleDescriptionId" class="diagram-style-description">选择代码图表的配色与线条外观，源码保持不变。修改后可随时撤销。</p>
        <div class="diagram-style-grid" role="group" aria-label="代码图表风格">
          <button v-for="style in stylePreviews" :key="style.id" type="button" class="diagram-style-card" :data-diagram-style="style.id" :aria-label="`${style.label}风格，${style.description}`" :aria-pressed="currentStyleId === style.id" data-testid="diagram-style-card" @click="chooseStyle(style.id)">
            <span class="diagram-style-preview" aria-hidden="true" v-html="style.svg"/>
            <span class="diagram-style-card-heading"><strong>{{ style.label }}</strong><AppIcon v-if="currentStyleId === style.id" name="check" :size="15"/><span v-else class="diagram-style-swatches" aria-hidden="true"><i v-for="color in style.palette.slice(0, 3)" :key="color" :style="{ background: color }"/></span></span>
            <small>{{ style.description }}</small>
          </button>
        </div>
        <footer><span aria-live="polite">当前风格：{{ currentStyle.label }}</span><button type="button" @click="closeStyles"><AppIcon name="check" :size="15"/>完成</button></footer>
      </section>
    </div>
    <div v-if="templatesOpen" class="diagram-library-backdrop" @click.self="closeTemplates()" @keydown="dialogKeydown">
      <section ref="templateDialog" class="diagram-library" role="dialog" aria-modal="true" :aria-labelledby="pendingTemplate ? replaceTitleId : templateTitleId" data-testid="diagram-template-library">
        <header><div><AppIcon :name="pendingTemplate ? 'refresh' : 'templates'" :size="19"/><h2 :id="pendingTemplate ? replaceTitleId : templateTitleId">{{ pendingTemplate ? '替换当前源码？' : '选择图表模板' }}</h2></div><button type="button" class="diagram-library-close" aria-label="关闭图表模板" @click="closeTemplates()"><AppIcon name="close" :size="17"/></button></header>
        <template v-if="pendingTemplate">
          <div class="diagram-replace-content"><div class="diagram-replace-template"><AppIcon :name="pendingTemplate.kind" :size="25"/><div><strong>{{ pendingTemplate.title }}</strong><small>{{ DIAGRAM_KIND_LABELS[pendingTemplate.kind] }}</small></div></div><p>将使用此模板替换当前源码。替换后可以通过工具栏“撤销”恢复原来的内容。</p><pre>{{ pendingTemplate.source }}</pre></div>
          <footer><button type="button" data-template-cancel @click="backToTemplates">返回模板</button><button type="button" class="diagram-primary" data-testid="diagram-confirm-template" @click="applyTemplate(pendingTemplate)"><AppIcon name="check" :size="15"/>替换源码</button></footer>
        </template>
        <template v-else>
          <div class="diagram-library-tools"><label class="diagram-template-search"><AppIcon name="search" :size="15"/><input ref="templateSearchInput" v-model="templateSearch" type="search" placeholder="搜索类型、用途或语法关键词" aria-label="搜索图表模板"/></label><div class="diagram-categories" role="group" aria-label="图表分类"><button type="button" :aria-pressed="templateCategory === 'all'" @click="templateCategory = 'all'">全部 <small>{{ DIAGRAM_TEMPLATES.length }}</small></button><button v-for="category in categories" :key="category" type="button" :aria-pressed="templateCategory === category" @click="templateCategory = category">{{ category }}</button></div></div>
          <div class="diagram-template-grid"><button v-for="template in visibleTemplates" :key="template.id" type="button" class="diagram-template-card" :data-template-id="template.id" :data-diagram-kind="template.kind" :aria-label="`使用模板：${template.title}`" @click="chooseTemplate(template)"><span class="diagram-template-icon"><AppIcon :name="template.kind" :size="21"/></span><span class="diagram-template-copy"><strong>{{ template.title }}</strong><small>{{ template.description }}</small><span>{{ DIAGRAM_KIND_LABELS[template.kind] }} · {{ template.source.split('\n').length }} 行示例</span></span><AppIcon name="chevron-right" :size="14"/></button><p v-if="!visibleTemplates.length" class="diagram-no-templates">没有匹配的模板，试试其他关键词或分类。</p></div>
          <footer><span>{{ kindsCount }} 类图表 · {{ visibleTemplates.length }} 个示例 · 注释说明语法用法</span><button type="button" @click="closeTemplates()">取消</button></footer>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.diagram-editor{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--ui-text,#273449);background:var(--ui-bg,#f4f6fa);font-family:var(--ui-font);font-size:13px}.diagram-toolbar{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 16px;border-bottom:1px solid var(--ui-line,#e2e8f0);background:var(--ui-surface,#fff)}.diagram-title{display:flex;align-items:center;gap:10px;white-space:nowrap}.diagram-title strong{font-size:14px}.diagram-badge{color:var(--ui-muted,#64748b);font-size:11px}.diagram-editor button{font:inherit;cursor:pointer;border:1px solid var(--ui-line,#dce3ed);color:var(--ui-text,#273449);background:var(--ui-surface,#fff);border-radius:7px;padding:6px 10px}.diagram-editor button:hover:not(:disabled){border-color:var(--ui-accent,#3577e5);color:var(--ui-accent,#3577e5)}.diagram-editor button:disabled{opacity:.45;cursor:default}.diagram-editor button:focus-visible,.diagram-editor summary:focus-visible{outline:2px solid var(--ui-accent,#3577e5);outline-offset:2px}.diagram-convert{display:flex;align-items:center;gap:7px;white-space:nowrap}.diagram-convert svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.5}.diagram-workspace{display:grid;grid-template-columns:minmax(260px,37%) minmax(0,1fr);flex:1;min-height:0;overflow:hidden}.diagram-source-panel,.diagram-preview-panel{min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}.diagram-source-panel{background:var(--ui-surface,#fff);border-right:1px solid var(--ui-line,#e2e8f0)}.diagram-panel-title{height:37px;flex-shrink:0;padding:0 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--ui-muted,#64748b);font-size:11px;border-bottom:1px solid var(--ui-line,#e2e8f0);background:var(--ui-surface,#fff)}.diagram-panel-title>span:first-child{font-weight:600;color:var(--ui-text,#273449)}.diagram-code{flex:1;min-height:180px;display:flex;overflow:hidden;position:relative}.diagram-gutter{flex:0 0 43px;overflow:hidden;text-align:right;padding:16px 10px 0 0;color:var(--ui-muted,#94a3b8);background:var(--ui-bg,#f8fafc);user-select:none}.diagram-gutter pre{margin:0;font:13px/23px ui-monospace,SFMono-Regular,Consolas,monospace}.diagram-code textarea{display:block;border:0;border-radius:0;outline:0;resize:none;width:100%;min-width:0;height:100%;min-height:180px;box-sizing:border-box;padding:16px 16px 32px 12px;font:13px/23px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--ui-text,#273449);background:var(--ui-surface,#fff);tab-size:2;white-space:pre;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--ui-line,#cbd5e1) transparent}.diagram-code textarea:focus{box-shadow:inset 2px 0 var(--ui-accent,#3577e5)}.diagram-help{padding:11px 14px;border-top:1px solid var(--ui-line,#e2e8f0);font-size:11px;color:var(--ui-muted,#64748b);max-height:38%;overflow:auto;scrollbar-width:thin}.diagram-help summary{cursor:pointer;color:var(--ui-text,#273449)}.diagram-help p{margin:10px 0 0;line-height:1.8}.diagram-help code{font-size:10px;background:var(--ui-bg,#f4f6fa);border-radius:3px;padding:2px 3px}.diagram-preview-kind{font-weight:400;font-size:10px;padding-left:8px;color:var(--ui-muted,#64748b)}.diagram-zoom{display:flex;align-items:center;gap:3px}.diagram-zoom button{border:0;font-size:11px;padding:2px 6px;min-width:24px}.diagram-preview-scroll{flex:1;min-height:0;overflow:auto;scrollbar-width:thin;padding:24px;box-sizing:border-box;background-image:radial-gradient(var(--ui-line,#d6dfe9) .7px,transparent .7px);background-size:16px 16px}.diagram-preview{min-height:100%;display:flex;align-items:flex-start;justify-content:center;transition:width .12s;box-sizing:border-box}.diagram-preview-art :deep(svg){display:block;width:100%;height:auto;max-height:none;box-shadow:0 4px 24px #1e293b0b;border:1px solid var(--ui-line,#e2e8f0);border-radius:5px}.diagram-parsing{position:absolute;top:48px;left:50%;transform:translateX(-50%);z-index:2;display:flex;align-items:center;gap:7px;background:var(--ui-surface,#fff);padding:7px 12px;border:1px solid var(--ui-line,#e2e8f0);border-radius:20px;font-size:11px;box-shadow:0 2px 10px #00000009}.diagram-spinner{width:11px;height:11px;border:2px solid var(--ui-line,#e2e8f0);border-top-color:var(--ui-accent,#3577e5);border-radius:50%;animation:diagram-spin .8s linear infinite}.diagram-error{margin:24px;padding:18px;border:1px solid #f3bbbb;border-radius:9px;background:#fff3f3;color:#9b2b2b;line-height:1.6}.diagram-error strong{font-size:14px}.diagram-error p{margin:8px 0 14px;overflow-wrap:anywhere}.diagram-error button{background:#fff;color:#9b2b2b;border-color:#f3bbbb;font-size:12px}.diagram-warnings{padding:8px 15px;background:var(--ui-surface,#fff);border-top:1px solid var(--ui-line,#e2e8f0);color:var(--ui-muted,#64748b);font-size:11px;max-height:100px;overflow:auto}.diagram-warnings p{margin:3px 0;line-height:1.5}.diagram-empty{display:grid;place-items:center;flex:1;color:var(--ui-muted,#64748b);padding:24px;text-align:center}.is-dark .diagram-error{background:#3a242b;color:#ffc1c1;border-color:#75414a}.is-dark .diagram-error button{background:#3a242b;color:#ffc1c1;border-color:#75414a}@keyframes diagram-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.diagram-workspace{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(210px,43%) minmax(200px,1fr);overflow:auto}.diagram-source-panel{border-right:0;border-bottom:1px solid var(--ui-line,#e2e8f0)}.diagram-code{min-height:100px}.diagram-code textarea{min-height:100px}.diagram-gutter{flex-basis:34px;padding-right:7px}.diagram-toolbar{padding:7px 10px;gap:6px}.diagram-badge{display:none}.diagram-convert{font-size:11px!important;padding:6px 7px!important}.diagram-help{padding:8px 10px;max-height:45%}.diagram-preview-scroll{padding:12px}.diagram-error{margin:12px;padding:12px}}@media(prefers-reduced-motion:reduce){.diagram-preview{transition:none}.diagram-spinner{animation:none}}
</style>

<style scoped>
.diagram-editor { position: relative; }
.diagram-preview-page { width: 100%; min-width: 0; position: relative; }
.diagram-source-overlay { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.diagram-source-overlay path, .diagram-source-overlay rect { vector-effect: non-scaling-stroke; stroke-linecap: round; stroke-linejoin: round; }
.diagram-highlight-halo, .diagram-highlight-path-halo { fill: none; stroke: #fff; stroke-width: 5; stroke-opacity: .85; }
.diagram-highlight-shape { fill: #3b82f6; fill-opacity: .11; stroke: #2563eb; stroke-width: 2; }
.diagram-highlight-path-glow { fill: none; stroke: #3b82f6; stroke-opacity: .2; stroke-width: 13; }
.diagram-highlight-path { fill: none; stroke: #2563eb; stroke-width: 2; }
.is-dark .diagram-highlight-shape, .is-dark .diagram-highlight-path { stroke: #60a5fa; }
.is-dark .diagram-highlight-halo, .is-dark .diagram-highlight-path-halo { stroke: #152034; }
.diagram-source-location { flex: none; display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 3px 10px; border-top: 1px solid var(--ui-line, #e2e8f0); color: var(--ui-muted, #64748b); font-size: 10px; }
.diagram-source-location > svg { flex: none; color: var(--ui-accent, #3577e5); }
.diagram-source-location > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diagram-source-location button { display: inline-flex; align-items: center; gap: 4px; flex: none; margin-left: auto; padding: 4px 6px; border-color: transparent; font-size: 10px; white-space: nowrap; }
@media (min-width: 761px) and (max-width: 1040px) { .diagram-source-location button > span { display: none; } }

.diagram-toolbar-actions, .diagram-template-toggle, .diagram-error strong, .diagram-error button { display: flex; align-items: center; gap: 7px; }
.diagram-toolbar-actions { min-width: 0; gap: 8px; }
.diagram-toolbar-start { display: flex; align-items: center; gap: 10px; min-width: 0; }
.diagram-image-export { position: relative; flex: none; }
.diagram-export-toggle { display: flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--ui-accent, #3577e5) !important; background: var(--ui-accent-soft, #eaf1ff) !important; font-size: 12px !important; }
.diagram-export-menu { position: absolute; right: 0; top: calc(100% + 7px); z-index: 30; width: 196px; max-width: calc(100vw - 24px); padding: 5px; box-sizing: border-box; background: var(--ui-surface, #fff); border: 1px solid var(--ui-line, #dce3ed); border-radius: 9px; box-shadow: 0 8px 28px #172b4d26; }
.diagram-export-menu button { display: flex; align-items: center; gap: 9px; width: 100%; border-color: transparent; text-align: left; padding: 9px; }
.diagram-export-menu button:hover, .diagram-export-menu button:focus-visible { background: var(--ui-accent-soft, #eaf1ff); }
.diagram-export-menu button > span { display: grid; gap: 4px; font-size: 12px; }
.diagram-export-menu small { color: var(--ui-muted, #64748b); font-size: 10px; }
.diagram-template-toggle { white-space: nowrap; font-size: 12px !important; }
.diagram-style-toggle { display: flex; align-items: center; gap: 8px; white-space: nowrap; font-size: 12px !important; }
.diagram-style-toggle > span { display: flex; align-items: center; gap: 7px; }
.diagram-style-toggle small { color: var(--ui-muted, #64748b); font-size: 10px; font-weight: 400; }
.diagram-style-toggle > svg:first-child { color: var(--ui-accent, #3577e5); }
.diagram-title > svg { color: var(--ui-accent, #3577e5); }
.diagram-preview-kind { display: inline-flex; align-items: center; gap: 4px; }
.diagram-zoom button { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; }
.diagram-help summary { list-style: none; display: flex; align-items: center; gap: 6px; min-height: 20px; }
.diagram-help summary::-webkit-details-marker { display: none; }
.diagram-help[open] summary > svg:first-child { transform: rotate(90deg); }
.diagram-syntax-example { margin: 10px 0 0; padding: 10px; border: 1px solid var(--ui-line, #e2e8f0); border-radius: 5px; background: var(--ui-bg, #f4f6fa); color: var(--ui-text, #273449); overflow: auto; font: 11px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.diagram-library-backdrop { position: absolute; inset: 0; z-index: 35; display: flex; align-items: center; justify-content: center; padding: 18px; background: #14213d55; }
.diagram-library { display: flex; flex-direction: column; width: 720px; max-width: 100%; max-height: 100%; overflow: hidden; border: 1px solid var(--ui-line, #dce3ed); border-radius: 11px; background: var(--ui-surface, #fff); box-shadow: 0 18px 64px #0f172a30; }
.diagram-library > header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--ui-line, #e2e8f0); }
.diagram-library > header > div { display: flex; align-items: center; gap: 9px; }
.diagram-library > header > div > svg { color: var(--ui-accent, #3577e5); }
.diagram-library h2 { margin: 0; font-size: 16px; font-weight: 650; }
.diagram-library .diagram-library-close { display: grid; place-items: center; width: 29px; height: 29px; padding: 0; flex: none; border-color: transparent; }
.diagram-library-tools { flex: none; padding: 13px 17px 10px; border-bottom: 1px solid var(--ui-line, #e2e8f0); }
.diagram-template-search { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 10px; background: var(--ui-bg, #f4f6fa); border: 1px solid var(--ui-line, #e2e8f0); border-radius: 6px; color: var(--ui-muted, #64748b); }
.diagram-template-search:focus-within { border-color: var(--ui-accent, #3577e5); }
.diagram-template-search input { min-width: 0; flex: 1; width: 100%; border: 0; background: transparent; color: var(--ui-text, #273449); font: inherit; font-size: 12px; outline: 0; }
.diagram-template-search input:focus-visible { box-shadow: none; }
.diagram-categories { display: flex; align-items: center; gap: 5px; margin-top: 10px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
.diagram-categories button { flex: none; display: flex; align-items: center; gap: 5px; padding: 5px 9px; border-color: transparent; font-size: 11px; white-space: nowrap; }
.diagram-categories button[aria-pressed="true"] { color: var(--ui-accent, #3577e5); background: var(--ui-accent-soft, #eaf1ff); border-color: var(--ui-accent-soft, #eaf1ff); }
.diagram-categories small { font-size: 10px; opacity: .8; }
.diagram-template-grid { min-height: 0; padding: 13px 17px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; gap: 9px; overflow-y: auto; scrollbar-width: thin; }
.diagram-template-grid .diagram-template-card { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 12px; text-align: left; }
.diagram-template-card > svg { margin-left: auto; color: var(--ui-muted, #64748b); }
.diagram-template-icon { display: grid; place-items: center; width: 35px; height: 38px; flex: none; border-radius: 7px; background: var(--ui-accent-soft, #eaf1ff); color: var(--ui-accent, #3577e5); }
.diagram-template-copy { display: grid; min-width: 0; gap: 4px; }
.diagram-template-copy strong { font-size: 12px; color: var(--ui-text, #273449); line-height: 1.45; }
.diagram-template-copy small { font-size: 10px; color: var(--ui-muted, #64748b); line-height: 1.5; }
.diagram-template-copy > span { font-size: 9px; color: var(--ui-accent, #3577e5); }
.diagram-no-templates { grid-column: 1 / -1; margin: 18px 0; color: var(--ui-muted, #64748b); text-align: center; font-size: 12px; }
.diagram-library > footer { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding: 11px 17px; border-top: 1px solid var(--ui-line, #e2e8f0); }
.diagram-library > footer > span { margin-right: auto; color: var(--ui-muted, #64748b); font-size: 10px; }
.diagram-library > footer button { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; white-space: nowrap; }
.diagram-library .diagram-primary { color: #fff; border-color: #2563eb; background: #2563eb; }
.diagram-library .diagram-primary:hover { color: #fff; background: #1d4ed8; border-color: #1d4ed8; }
.diagram-replace-content { min-height: 0; overflow: auto; padding: 17px; }
.diagram-replace-template { display: flex; align-items: center; gap: 11px; }
.diagram-replace-template > svg { color: var(--ui-accent, #3577e5); }
.diagram-replace-template strong { display: block; font-size: 14px; }
.diagram-replace-template small { display: block; margin-top: 3px; color: var(--ui-muted, #64748b); font-size: 10px; }
.diagram-replace-content p { color: var(--ui-muted, #64748b); font-size: 12px; line-height: 1.8; margin: 16px 0 12px; }
.diagram-replace-content pre { max-height: 28vh; overflow: auto; margin: 0; padding: 12px; border: 1px solid var(--ui-line, #e2e8f0); border-radius: 6px; background: var(--ui-bg, #f4f6fa); color: var(--ui-text, #273449); font: 11px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.diagram-style-library { width: 820px; }
.diagram-style-description { flex: none; margin: 0; padding: 12px 18px 0; font-size: 12px; line-height: 1.7; color: var(--ui-muted, #64748b); }
.diagram-style-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 14px 17px 17px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--ui-line, #cbd5e1) transparent; }
.diagram-style-grid .diagram-style-card { display: flex; flex-direction: column; align-items: stretch; gap: 7px; min-width: 0; border-radius: 9px; padding: 7px; text-align: left; background: var(--ui-surface, #fff); }
.diagram-style-card[aria-pressed="true"] { border-color: var(--ui-accent, #3577e5); box-shadow: 0 0 0 1px var(--ui-accent, #3577e5); background: var(--ui-bg, #f4f6fa); }
.diagram-style-preview { display: block; height: 66px; overflow: hidden; border: 1px solid var(--ui-line, #dce3ed); border-radius: 5px; }
.diagram-style-preview :deep(svg) { display: block; width: 100%; height: 100%; }
.diagram-style-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 5px; padding: 0 2px; }
.diagram-style-card-heading strong { color: var(--ui-text, #273449); font-size: 12px; }
.diagram-style-card-heading > svg { color: var(--ui-accent, #3577e5); flex: none; }
.diagram-style-card > small { color: var(--ui-muted, #64748b); font-size: 10px; line-height: 1.6; padding: 0 2px 2px; }
.diagram-style-swatches { display: flex; gap: 3px; }
.diagram-style-swatches i { width: 6px; height: 6px; border: 1px solid #64748b30; border-radius: 50%; }
.is-dark .diagram-style-preview { border-color: #64748b66; }
@media (max-width: 1000px) {
  .diagram-style-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .diagram-style-toggle > span { flex-direction: column; gap: 1px; align-items: flex-start; }
  .diagram-badge { display: none; }
}
@media (max-width: 640px) {
  .diagram-toolbar { flex-wrap: wrap; row-gap: 7px; }
  .diagram-toolbar-start { width: 100%; gap: 8px; }
  .diagram-toolbar-actions { width: 100%; justify-content: space-between; }
  .diagram-export-toggle { padding: 6px 7px !important; font-size: 11px !important; gap: 5px; }
  .diagram-export-toggle > svg:last-child { display: none; }
  .diagram-title { gap: 5px; }.diagram-title strong { font-size: 12px; }
  .diagram-toolbar-actions { gap: 5px; }.diagram-template-toggle { font-size: 11px !important; padding: 6px 7px !important; gap: 4px; }
  .diagram-template-toggle > svg:last-child { display: none; }
  .diagram-convert { gap: 5px; }
  .diagram-convert > span { display: none; }.diagram-convert { justify-content: center; min-width: 32px; min-height: 32px; }
  .diagram-style-toggle { gap: 5px; padding: 5px 7px !important; font-size: 11px !important; }
  .diagram-style-toggle > svg:last-child { display: none; }.diagram-style-toggle small { font-size: 9px; }
  .diagram-library-backdrop { padding: 10px; }.diagram-library > header { padding: 12px; }.diagram-library h2 { font-size: 14px; }
  .diagram-library-tools { padding: 10px 12px 7px; }.diagram-template-grid { grid-template-columns: minmax(0, 1fr); padding: 10px 12px; gap: 7px; }
  .diagram-template-grid .diagram-template-card { padding: 10px; }.diagram-template-copy strong { font-size: 11px; }
  .diagram-library > footer { padding: 10px 12px; }.diagram-library > footer > span { max-width: 60%; line-height: 1.5; }
  .diagram-replace-content { padding: 12px; }
  .diagram-style-description { padding: 10px 12px 0; font-size: 11px; }
  .diagram-style-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 12px; }
  .diagram-style-preview { height: 58px; }
  .diagram-style-card > small { font-size: 9px; }
}

.diagram-library { border-radius: var(--ui-radius); border-color: var(--ui-line-strong); background: var(--ui-surface); color: var(--ui-text); box-shadow: 0 20px 72px #0003; }
.diagram-library button,.diagram-editor button { border-radius: var(--ui-radius); }
.diagram-library-backdrop { background: #0006; backdrop-filter: none; }
.diagram-primary { background: var(--ui-accent)!important; color: var(--ui-on-accent)!important; }
</style>
