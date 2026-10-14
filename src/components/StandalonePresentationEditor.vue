<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { OfficeExportRequest, OfficeExportResult } from '../office/types'
import type { PresentationAction, PresentationArrangeOperation, PresentationChartType, PresentationObjectQuery, PresentationTextStyle, PresentationParagraphStyle, PresentationTextLayoutPatch } from '../presentation/types'
import { PRESENTATION_LAYOUTS } from '../presentation/types'
import type { PresentationModel, SlideObject } from '../presentation/core/types'
import { createPresentation, PresentationController } from '../presentation/core/model'
import { importPresentation, exportPresentation } from '../presentation/core/pptx'
import { slideSvg } from '../presentation/core/render'
import { textLayoutFor } from '../presentation/core/scene'
import { prepareSmartArtTextEdit, discardPreparedSmartArtTextEdit } from '../presentation/core/smartart-text'
import { effectiveRichText } from '../presentation/core/rich-text'
import { textRangeBlockedReason } from '../presentation/core/text-range-format'
import { textOpacityBlockedReason } from '../presentation/core/format-text-paint'
import { tableCellBlockedReasons, tableResizeBlockedReason } from '../presentation/core/table-text-content'
import { textContentBlockedReason } from '../presentation/core/text-content-edit'
import { exportPresentationPdf } from '../presentation/core/pdf'
import { base64ToBytes, bytesToBase64 } from '../shared/document'
import { parsePptxPackage, type PptxPatch, type PptxPresentation, type PptxSlide } from '../presentation/pptx-package'
import SlidePreview from './SlidePreview.vue'
import PresentationEffects from './PresentationEffects.vue'
import PresentationFontNotice from './PresentationFontNotice.vue'
import '../presentation/core/editor.css'

const props = withDefaults(defineProps<{ document: NativeDocument; active?: boolean; disabled?: boolean }>(), { active: true, disabled: false })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string] }>()
type FeaturePatch = Omit<PptxPatch['slides'][number], 'slideIndex'>
const controller = shallowRef<PresentationController>(), version = ref(0), loading = ref(true), busy = ref(false), problem = ref('')
const root = ref<HTMLElement>(), viewport = ref<HTMLElement>(), stage = ref<HTMLElement>(), textInput = ref<HTMLTextAreaElement>()
const imageInput = ref<HTMLInputElement>(), effects = ref<InstanceType<typeof PresentationEffects>>()
const propertiesOpen = ref(true), notesOpen = ref(false), fit = ref(true), zoom = ref(1), fitScale = ref(2)
const notesDraft = ref(''), nameDraft = ref(''), effectsPending = ref(false)
const textEdit = ref<{ id: string; text: string; initialText: string; revision: number } | null>(null), propertyDraft = ref<Record<string, string>>({})
const dataDialog = ref<null | { kind: 'table' | 'chart'; id?: string; text: string; title: string; chartType: PresentationChartType; cells?: string[][]; revision?: number; cellReasons?: Array<Array<string | undefined>>; resizeReason?: string }>(null)
const smartArtDialog = ref<null | { id: string; nodeId: string; text: string; initialText: string; revision: number }>(null)
const smartArtInput = ref<HTMLInputElement>()
type RangeFormatDraft = { fontName: string; fontSize: string; opacity: string | number; color: string; colorEnabled: boolean; bold: string; italic: string; underline: string; strike: string; highlightMode: string; highlightColor: string }
const rangeFormatDialog = ref<null | { id: string; text: string; start: number; end: number; revision: number; format: RangeFormatDraft }>(null)
const rangeFormatInput = ref<HTMLTextAreaElement>()
const rangeFormatChanged = computed(() => { const value = rangeFormatDialog.value?.format; return !!value && !!(value.fontName || value.fontSize || String(value.opacity).trim() || value.colorEnabled || value.bold || value.italic || value.underline || value.strike || value.highlightMode) })
const rangeFormatSelection = computed(() => { const value = rangeFormatDialog.value; return value ? Array.from(value.text.slice(value.start, value.end)) : [] })
type ParagraphDialog = { id: string; text: string; revision: number; paragraphs: string[]; indices: number[]; page: number; blocked?: string;
  align: string; lineUnit: string; lineValue: string; beforeUnit: string; beforeValue: string; afterUnit: string; afterValue: string; outer: string;
  vertical: string; wrap: string; left: string; right: string; top: string; bottom: string }
const paragraphDialog = ref<ParagraphDialog | null>(null)
const paragraphChanged = computed(() => { const d = paragraphDialog.value; return !!d && ['align','lineUnit','beforeUnit','afterUnit','outer','vertical','wrap','left','right','top','bottom'].some(key => String(d[key as keyof ParagraphDialog] ?? '').trim()) })
const paragraphRows = computed(() => paragraphDialog.value?.paragraphs.map((text, index) => ({ text, index })).slice(paragraphDialog.value.page * 100, (paragraphDialog.value.page + 1) * 100) || [])
const preview = shallowRef<{ base64: string; presentation: PptxPresentation; startPage: number } | null>(null)
const dragPreview = ref<Record<string, Partial<SlideObject>>>({}), marquee = ref<null | { x: number; y: number; width: number; height: number }>(null)
let disposed = false, generation = 0, observer: ResizeObserver | undefined, opening: Promise<void> = Promise.resolve()
let textOverlayContext: CanvasRenderingContext2D | null | undefined
let previewGeneration = 0
let sidebarManuallyToggled = false
let savedExport: { revision: number; generation: number } | undefined
const copiedObjects = shallowRef<SlideObject[]>([])
let compatibilityCopySaved = false
const state = computed(() => { version.value; return controller.value?.state() })
const model = computed(() => { version.value; return controller.value?.model })
const slide = computed(() => model.value?.slides[state.value?.currentPageIndex ?? 0])
const selected = computed(() => slide.value?.objects.filter(object => state.value?.selectedObjectIds.includes(object.id)) || [])
const primary = computed(() => selected.value[0])
const textOpacityReason = computed(() => selected.value.map(item => textOpacityBlockedReason(item)).find(Boolean))
const primaryTextOpacity = computed(() => {
  const item = primary.value
  if (!item) return ''
  const paragraphs = effectiveRichText(item)
  const values = new Set(paragraphs?.flatMap(paragraph => paragraph.runs.length ? paragraph.runs.map(run => run.style.opacity ?? 1) : [paragraph.style.opacity ?? 1]) || [item.textStyle.opacity ?? 1])
  return values.size === 1 ? Math.round([...values][0]! * 10000) / 100 : ''
})
function selectedTextDecoration(key: 'underlineStyle' | 'strike') {
  const values = new Set(selected.value.flatMap(item => {
    const paragraphs = effectiveRichText(item)
    const styles = paragraphs?.flatMap(p => p.runs.length ? p.runs.map(r => r.style) : [p.style]) || [item.textStyle]
    return styles.map(style => key === 'underlineStyle' ? (style.underlineStyle ?? (style.underline ? 'single' : 'none')) : (style.strike ?? 'none'))
  }))
  return values.size === 1 ? [...values][0]! : ''
}
const selectedUnderlineStyle = computed(() => selectedTextDecoration('underlineStyle'))
const selectedStrike = computed(() => selectedTextDecoration('strike'))
const selectedHighlight = computed(() => {
  const paints = selected.value.flatMap(item => {
    const paragraphs = effectiveRichText(item)
    const styles = paragraphs?.flatMap(p => p.runs.length ? p.runs.map(r => r.style) : [p.style]) || [item.textStyle]
    return styles.map(style => ({ color: style.highlightColor || '', opacity: style.highlightOpacity ?? 1 }))
  })
  const colors = new Set(paints.map(paint => !paint.color || paint.opacity === 0 ? '' : `${paint.color.toLowerCase()}@${paint.opacity}`))
  if (colors.size !== 1) return { color: '#fff176', label: '混合高亮' }
  const paint = paints[0]
  if (!paint?.color || !paint.opacity) return { color: '#fff176', label: '无高亮' }
  return { color: paint.color, label: paint.opacity === 1 ? '已设置高亮' : `高亮不透明度 ${Math.round(paint.opacity * 100)}%` }
})
const scale = computed(() => fit.value ? fitScale.value : 3.7795275591 * zoom.value)
const stageStyle = computed(() => ({ width: `${(model.value?.width || 254) * scale.value}px`, height: `${(model.value?.height || 142.875) * scale.value}px` }))
const changedDraft = computed(() => !!textEdit.value && textEdit.value.text !== slide.value?.objects.find(item => item.id === textEdit.value?.id)?.text || notesDraft.value !== slide.value?.notes || nameDraft.value !== slide.value?.name || !!Object.keys(propertyDraft.value).length || effectsPending.value || !!dataDialog.value || !!smartArtDialog.value && smartArtDialog.value.text !== smartArtDialog.value.initialText || rangeFormatChanged.value || paragraphChanged.value)
const dirty = computed(() => !!state.value?.dirty || !!state.value && changedDraft.value)
const currentSvg = computed(() => {
  if (!model.value || !slide.value) return ''
  const current = { ...slide.value, objects: slide.value.objects.map(object => ({ ...previewObject(object, dragPreview.value[object.id]), ...(textEdit.value?.id === object.id ? { text: '' } : {}) })) }
  return slideSvg(model.value, current)
})
const thumbnails = computed(() => model.value?.slides.map(item => slideSvg(model.value!, item, { width: 240, height: 135 })) || [])
const featureSlide = computed<PptxSlide | null>(() => slide.value ? ({ index: state.value!.currentPageIndex, id: slide.value.id, partName: slide.value.sourcePart || '', name: slide.value.name, title: slide.value.name, notes: slide.value.notes, hidden: slide.value.hidden, transition: slide.value.transition, media: slide.value.media, hasUnsupportedAnimations: !!slide.value.hasUnsupportedAnimations, warnings: slide.value.warnings }) : null)
const warnings = computed(() => [...new Set([...(model.value?.warnings || []), ...(slide.value?.warnings || [])])])
watch(dirty, value => emit('dirty', value))

function error(error: unknown) { problem.value = error instanceof Error ? error.message : String(error); emit('error', problem.value) }
function current() { if (!controller.value || loading.value || disposed) throw Error('请等待演示文稿打开。'); return controller.value }
function refresh(resetDrafts = false) {
  version.value++
  if (resetDrafts) { notesDraft.value = slide.value?.notes || ''; nameDraft.value = slide.value?.name || ''; propertyDraft.value = {} }
  emit('dirty', dirty.value)
}
function safely(work: () => unknown) { try { const result = work(); if (result instanceof Promise) void result.catch(error) } catch (cause) { error(cause) } }
function resetFit() {
  if (!viewport.value || !model.value) return
  if (!sidebarManuallyToggled) propertiesOpen.value = window.innerWidth > 640
  fitScale.value = Math.max(.1, Math.min((viewport.value.clientWidth - 64) / model.value.width, (viewport.value.clientHeight - 64) / model.value.height))
}
async function load() {
  const token = ++generation
  loading.value = true; busy.value = false; problem.value = ''; savedExport = undefined; preview.value = null; compatibilityCopySaved = false
  controller.value = undefined; textEdit.value = null; dataDialog.value = null; smartArtDialog.value = null; rangeFormatDialog.value = null; paragraphDialog.value = null; propertyDraft.value = {}; effectsPending.value = false
  // Imported objects refer to parts in their own package. This clipboard is
  // document-local; reusing it after a load could bind to another file's rIds.
  copiedObjects.value = []
  try {
    if (props.document.extension !== 'pptx') throw Error('独立演示编辑器支持 PPTX。请先将 PPT 或 ODP 文件转换为 PPTX，再打开编辑。')
    const content = props.document.base64 ? await importPresentation(base64ToBytes(props.document.base64)) : createPresentation()
    if (disposed || token !== generation) return
    controller.value = new PresentationController(content, props.document.id)
    loading.value = false; refresh(true)
    await nextTick(); resetFit(); if (viewport.value) observer?.observe(viewport.value)
    emit('status', '演示文稿已就绪 · 本机独立编辑'); emit('ready')
  } catch (cause) { if (!disposed && token === generation) { loading.value = false; error(cause) } }
}
function propertyValue(key: string, fallback: unknown) { return propertyDraft.value[key] ?? String(fallback ?? '') }
function setDraft(key: string, event: Event) { propertyDraft.value = { ...propertyDraft.value, [key]: (event.target as HTMLInputElement).value } }
function applyPropertyDrafts() {
  const entries = Object.entries(propertyDraft.value)
  if (!entries.length) return
  const item = primary.value
  if (!item) throw Error('请先选中要修改的对象。')
  const changes: Record<string, unknown> = {}, textStyle: Partial<PresentationTextStyle> = {}
  for (const [key, value] of entries) {
    if (key === 'fontName') { if (!value.trim()) throw Error('字体名称不能为空。'); textStyle.fontName = value.trim(); continue }
    const number = Number(value)
    if (key === 'fillOpacity' || key === 'lineOpacity' || key === 'textOpacity') {
      if (!value.trim() || !Number.isFinite(number) || number < 0 || number > 100) throw Error('不透明度请输入 0 到 100；当前输入已保留。')
      if (key === 'textOpacity') textStyle.opacity = number / 100
      else changes[key] = number / 100
      continue
    }
    if (!value.trim() || !Number.isFinite(number)) throw Error('位置、大小和字号必须填写有效数字；当前输入已保留。')
    if (['width', 'height', 'fontSize'].includes(key) && number <= 0) throw Error('宽高和字号必须大于零；当前输入已保留。')
    if (key === 'fontSize') textStyle.fontSize = number
    else changes[key] = number
  }
  if (Object.keys(textStyle).length) changes.textStyle = textStyle
  current().batch(selected.value.map(object => ({ type: 'update-object', id: object.id, ...changes } as PresentationAction)))
  propertyDraft.value = {}; refresh()
}
function commitText() {
  if (!textEdit.value) return
  const draft = textEdit.value
  const item = slide.value?.objects.find(object => object.id === draft.id)
  if (!item) throw Error('文字对应的对象已变化，输入已保留。')
  if (item.text !== draft.initialText || current().revision !== draft.revision) throw Error('正文或文稿已改变，输入已保留；请复制输入后按 Esc 重新打开编辑。')
  if (item.text !== draft.text) current().action({ type: 'update-object', id: draft.id, text: draft.text, expectedRevision: draft.revision })
  textEdit.value = null; refresh()
}
function textKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault(); textEdit.value = null; refresh(); void nextTick(() => root.value?.focus())
  } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault(); safely(commitText)
  }
}
function applyData() {
  const draft = dataDialog.value
  if (!draft) return
  const rows = draft.cells || draft.text.replace(/\r/g, '').split('\n').map(row => row.split('\t'))
  if (!draft.cells && !draft.text.trim()) throw Error('请至少填写一行数据。')
  if (draft.kind === 'table') {
    if (rows.length > 30 || Math.max(...rows.map(row => row.length)) > 20) throw Error('表格最多 30 行、20 列。')
    const columns = Math.max(...rows.map(row => row.length)), cells = rows.map(row => Array.from({ length: columns }, (_, index) => row[index] || ''))
    current().action(draft.id ? { type: 'update-table', id: draft.id, cells, expectedRevision: draft.revision } : { type: 'insert-table', rows: cells.length, columns, cells })
  } else {
    if (rows.length < 2 || (rows[0]?.length || 0) < 2) throw Error('图表第一行需包含类别标题和至少一个系列；下方至少一行数值。')
    const series = rows[0]!.slice(1), categories = rows.slice(1).map(row => row[0] || ''), values = rows.slice(1).map(row => series.map((_, column) => {
      const raw = row[column + 1]?.trim(), value = Number(raw)
      if (!raw || !Number.isFinite(value)) throw Error('图表数据必须是有限数字，请检查空白或文字单元格。')
      return value
    }))
    const data = { chartType: draft.chartType, categories, series, values, title: draft.title }
    current().action(draft.id ? { type: 'update-chart', id: draft.id, ...data } : { type: 'insert-chart', ...data })
  }
  dataDialog.value = null; refresh()
}
function dataCell(row: number, column: number, event: Event) {
  if (!dataDialog.value) return
  const rows = dataDialog.value.cells || dataDialog.value.text.split('\n').map(line => line.split('\t'))
  while (rows[row]!.length <= column) rows[row]!.push('')
  rows[row]![column] = (event.target as HTMLInputElement).value
  if (!dataDialog.value.cells) dataDialog.value.text = rows.map(line => line.join('\t')).join('\n')
}
function addDataDimension(dimension: 'row' | 'column') {
  if (!dataDialog.value) return
  const draft = dataDialog.value, rows = draft.cells || draft.text.split('\n').map(line => line.split('\t')), columns = Math.max(...rows.map(row => row.length))
  if (dimension === 'row') rows.push(Array.from({ length: columns }, (_, column) => draft.kind === 'table' ? '' : column === 0 ? `类别 ${rows.length}` : '0'))
  else rows.forEach((row, index) => { while (row.length < columns) row.push(''); row.push(draft.kind === 'table' ? '' : index === 0 ? `系列 ${columns}` : '0') })
  if (!draft.cells) draft.text = rows.map(line => line.join('\t')).join('\n')
}
function openParagraphFormat(item: SlideObject) {
  safely(() => {
    commitDrafts()
    item = current().model.slides[current().currentPageIndex]!.objects.find(object => object.id === item.id) || item
    const paragraphs = effectiveRichText(item)?.map(paragraph => paragraph.runs.map(run => run.text).join('')) || item.text.split('\n')
    paragraphDialog.value = { id: item.id, text: item.text, revision: current().revision, paragraphs, indices: paragraphs.map((_, index) => index), page: 0, blocked: textRangeBlockedReason(item),
      align: '', lineUnit: '', lineValue: '', beforeUnit: '', beforeValue: '', afterUnit: '', afterValue: '', outer: '', vertical: '', wrap: '', left: '', right: '', top: '', bottom: '' }
    void nextTick(() => root.value?.querySelector<HTMLElement>('[data-testid="presentation-paragraph-dialog"] button')?.focus())
  })
}
function closeParagraphFormat() {
  paragraphDialog.value = null
  void nextTick(() => root.value?.querySelector<HTMLElement>('[data-testid="presentation-paragraph-format"]')?.focus())
}
function applyParagraphFormat() {
  const d = paragraphDialog.value
  if (!d) return
  if (current().revision !== d.revision) throw Error('文稿已经变化，请取消并重新打开段落与文本框设置。')
  const paragraphStyle: PresentationParagraphStyle = {}, layout: PresentationTextLayoutPatch = {}, actions: PresentationAction[] = []
  if (d.align) paragraphStyle.align = d.align as PresentationTextStyle['align']
  for (const [prefix, key] of [['line', 'lineSpacing'], ['before', 'spaceBefore'], ['after', 'spaceAfter']] as const) {
    const unit = d[`${prefix}Unit`], raw = String(d[`${prefix}Value`])
    if (!unit) continue
    if (!raw.trim() || !Number.isFinite(Number(raw))) throw Error('请填写有效的行距或段距数值；0 表示明确设置为零。')
    paragraphStyle[key] = { unit: unit as 'percent' | 'points', value: Number(raw) / (unit === 'percent' ? 100 : 1) }
  }
  if (Object.keys(paragraphStyle).length || d.outer) {
    if (d.blocked) throw Error(d.blocked)
    actions.push({ type: 'format-paragraphs', id: d.id, paragraphIndices: [...d.indices], paragraphStyle,
      ...(d.outer ? { spaceFirstLastParagraph: d.outer === 'true' } : {}), expectedText: d.text, expectedRevision: d.revision })
  }
  if (d.vertical) layout.verticalAlign = d.vertical as 'top' | 'middle' | 'bottom'
  if (d.wrap) layout.wrap = d.wrap === 'true'
  for (const key of ['left','right','top','bottom'] as const) if (String(d[key]).trim()) {
    if (!Number.isFinite(Number(d[key]))) throw Error('文本框内边距必须填写有效数字。')
    layout.insets ||= {}; layout.insets[key] = Number(d[key])
  }
  if (Object.keys(layout).length) actions.push({ type: 'set-text-layout', id: d.id, layout, expectedRevision: d.revision })
  if (!actions.length) throw Error('请选择至少一项要修改的排版属性。')
  current().batch(actions); paragraphDialog.value = null; refresh()
  emit('status', '段落与文本框排版已更新')
  void nextTick(() => root.value?.focus())
}
function openRangeFormat(item: SlideObject) {
  safely(() => {
    commitDrafts()
    item = current().model.slides[current().currentPageIndex]!.objects.find(object => object.id === item.id) || item
    const reason = textRangeBlockedReason(item)
    if (reason) throw Error(reason)
    rangeFormatDialog.value = { id: item.id, text: item.text, start: 0, end: 0, revision: current().revision,
      format: { fontName: '', fontSize: '', opacity: '', color: item.textStyle.color, colorEnabled: false, bold: '', italic: '', underline: '', strike: '', highlightMode: '', highlightColor: '#fff176' } }
    void nextTick(() => { rangeFormatInput.value?.focus(); rangeFormatInput.value?.setSelectionRange(0, 0) })
  })
}
function selectRangeFormat() {
  if (!rangeFormatDialog.value || !rangeFormatInput.value) return
  rangeFormatDialog.value.start = rangeFormatInput.value.selectionStart
  rangeFormatDialog.value.end = rangeFormatInput.value.selectionEnd
}
function closeRangeFormat() {
  rangeFormatDialog.value = null
  void nextTick(() => { const button = root.value?.querySelector<HTMLButtonElement>('[data-testid="presentation-range-format"]'); (button || root.value)?.focus() })
}
function applyRangeFormat() {
  const draft = rangeFormatDialog.value
  if (!draft) return
  if (rangeFormatInput.value?.value !== draft.text) throw Error('文本显示与原文不一致，请取消并重新打开局部文字格式。')
  if (draft.start === draft.end) throw Error('请先选中需要设置格式的文字。')
  if (current().revision !== draft.revision) throw Error('文稿已经变化，请取消并重新打开局部文字格式。当前输入已保留。')
  const patch: Partial<PresentationTextStyle> = {}, format = draft.format
  if (format.fontName.trim()) patch.fontName = format.fontName.trim()
  if (String(format.fontSize).trim()) patch.fontSize = Number(format.fontSize)
  if (String(format.opacity).trim()) {
    const opacity = Number(format.opacity)
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw Error('文字不透明度请输入 0 到 100；当前输入已保留。')
    patch.opacity = opacity / 100
  }
  if (format.colorEnabled) patch.color = format.color
  for (const key of ['bold', 'italic'] as const) if (format[key]) patch[key] = format[key] === 'true'
  if (format.underline) patch.underlineStyle = format.underline === 'true' ? 'single' : format.underline === 'false' ? 'none' : 'double'
  if (format.strike) patch.strike = format.strike as PresentationTextStyle['strike']
  if (format.highlightMode) { patch.highlightColor = format.highlightMode === 'none' ? null : format.highlightColor; if (format.highlightMode === 'color') patch.highlightOpacity = 1 }
  if (!Object.keys(patch).length) throw Error('请选择至少一项要修改的格式。')
  // The core action validates the range and commits XML/style changes atomically.
  current().action({ type: 'format-text-range', id: draft.id, start: draft.start, end: draft.end, textStyle: patch, expectedText: draft.text, expectedRevision: draft.revision })
  rangeFormatDialog.value = null; refresh()
  emit('status', '选中文字的格式已更新')
  void nextTick(() => root.value?.focus())
}
function openSmartArtNode(item: SlideObject, nodeId: string) {
  safely(() => {
    commitDrafts()
    if (item.smartArt?.blockedReason) throw Error(item.smartArt.blockedReason)
    const node = item.smartArt?.nodes.find(value => value.id === nodeId)
    if (!node?.editable) throw Error(node?.reason || '此节点暂不支持安全编辑。')
    smartArtDialog.value = { id: item.id, nodeId, text: node.text, initialText: node.text, revision: current().revision }
    void nextTick(() => { smartArtInput.value?.focus(); smartArtInput.value?.select() })
  })
}
function closeSmartArtDialog() {
  smartArtDialog.value = null
  void nextTick(() => { const button = root.value?.querySelector<HTMLButtonElement>('[data-testid="presentation-smartart-node"]:not(:disabled)'); (button || root.value)?.focus() })
}
async function applySmartArtText() {
  const draft = smartArtDialog.value
  if (!draft || busy.value) return
  if (draft.text === draft.initialText) { closeSmartArtDialog(); return }
  const active = current(), token = generation
  if (active.revision !== draft.revision) throw Error('文稿已经变化，请取消并重新打开此节点。当前输入已保留。')
  busy.value = true
  let prepared: PresentationAction | undefined
  try {
    prepared = await prepareSmartArtTextEdit(active.model, draft.id, draft.nodeId, draft.text, draft.revision)
    if (disposed || token !== generation || controller.value !== active || smartArtDialog.value !== draft || !props.active || props.disabled) return
    active.action(prepared)
    smartArtDialog.value = null; refresh()
    emit('status', '节点文字已更新，原图布局保持不变')
    void nextTick(() => root.value?.focus())
  } finally {
    if (prepared?.type === 'update-smartart-text') discardPreparedSmartArtTextEdit(prepared)
    if (!disposed && token === generation) busy.value = false
  }
}
function commitDrafts() {
  if (busy.value) throw Error('正在处理演示文稿，请稍候再编辑或保存。')
  if (paragraphDialog.value) throw Error('段落与文本框还有未确认的输入。请点击“应用排版”或“取消”，再继续。')
  if (rangeFormatDialog.value) throw Error('局部文字格式还有未确认的输入。请点击“应用格式”或“取消”，再继续。')
  if (smartArtDialog.value) throw Error('节点文字还有未确认的输入。请点击“应用文字”或“取消”，再继续。')
  if (effectsPending.value) throw Error('切换效果还有未应用的输入。请在右侧点击“应用切换”或“还原”，再继续。')
  commitText(); applyPropertyDrafts(); applyData()
  const page = slide.value
  if (!page) return
  const actions: PresentationAction[] = []
  if (nameDraft.value !== page.name) actions.push({ type: 'rename-page', pageIndex: current().currentPageIndex, name: nameDraft.value })
  if (notesDraft.value !== page.notes) actions.push({ type: 'set-notes', pageIndex: current().currentPageIndex, text: notesDraft.value })
  if (actions.length) { current().batch(actions); refresh(true) }
}
function action(value: PresentationAction) { commitDrafts(); const result = current().action(value); refresh(true); return result }
function selectPage(index: number) { safely(() => action({ type: 'select-page', pageIndex: index })) }
async function presentationAction(value: PresentationAction) { await opening; return action(value) }
async function getPresentationState() { await opening; commitDrafts(); return current().state() }
async function presentationObjectData(query: PresentationObjectQuery) { await opening; commitDrafts(); return current().objectData(query) }
async function presentationEdit(patch: FeaturePatch) {
  await opening
  if (busy.value) throw Error('正在准备放映，请稍候再编辑。')
  commitText(); applyPropertyDrafts()
  const result = current().editFeatures(patch)
  effectsPending.value = false; refresh(); return result
}
function newSlide() { return presentationAction({ type: 'add-page', layout: 20 }) }
function changeStyle(patch: Partial<PresentationTextStyle>) { safely(() => { commitDrafts(); current().batch(selected.value.filter(item => item.capabilities.text).map(item => ({ type: 'update-object', id: item.id, textStyle: patch }))); refresh() }) }
function updateSelected(patch: Partial<SlideObject>) { safely(() => { commitDrafts(); current().batch(selected.value.map(item => ({ type: 'update-object', id: item.id, ...patch } as PresentationAction))); refresh() }) }
function arrange(operation: PresentationArrangeOperation) { safely(() => action({ type: 'arrange-objects', ids: selected.value.map(item => item.id), operation })) }
async function beginText(item: SlideObject) {
  if (!item.capabilities.text || item.type === 'table' || item.type === 'chart') return
  try {
    commitDrafts(); current().action({ type: 'select-objects', ids: [item.id] }); refresh()
    const selected = slide.value?.objects.find(object => object.id === item.id)
    if (!selected) throw Error('文字对应的对象已变化。')
    const reason = textContentBlockedReason(selected); if (reason) throw Error(reason)
    textEdit.value = { id: selected.id, text: selected.text, initialText: selected.text, revision: current().revision }
    await nextTick(); textInput.value?.focus(); textInput.value?.select()
  } catch (cause) { error(cause) }
}
async function insertText() {
  try { action({ type: 'insert-text', text: '双击编辑文字' }); if (primary.value) await beginText(primary.value) } catch (cause) { error(cause) }
}
function openData(kind: 'table' | 'chart', item?: SlideObject) {
  safely(() => {
    commitDrafts()
    const selected = item ? current().model.slides[current().currentPageIndex]!.objects.find(object => object.id === item.id) || item : undefined
    if (selected?.table) dataDialog.value = { kind, id: selected.id, text: '', cells: selected.table.cells.map(row => [...row]), revision: current().revision, cellReasons: tableCellBlockedReasons(selected), resizeReason: tableResizeBlockedReason(selected), title: '', chartType: 'column' }
    else if (selected?.chart) dataDialog.value = { kind, id: selected.id, text: [['类别', ...selected.chart.series], ...selected.chart.categories.map((name, index) => [name, ...(selected.chart!.values[index] || [])])].map(row => row.join('\t')).join('\n'), title: selected.chart.title, chartType: selected.chart.type }
    else dataDialog.value = { kind, text: kind === 'table' ? '项目\t负责人\t进度\n方案\t设计组\t完成\n交付\t产品组\t进行中' : '类别\t本期\t上期\n第一季度\t42\t30\n第二季度\t68\t48\n第三季度\t85\t62', title: '季度对比', chartType: 'column' }
    void nextTick(() => root.value?.querySelector<HTMLTextAreaElement>('[data-testid="presentation-data-input"], .pe-data-preview textarea:not([readonly])')?.focus())
  })
}
async function insertImage(image: { name: string; base64: string; mimeType?: string }) { await opening; commitDrafts(); const result = current().insertImage(image); refresh(); return result }
async function pickImage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file) return
  const token = generation, pageId = slide.value?.id
  try {
    if (file.size > 25 * 1024 * 1024) throw Error('图片不能超过 25 MiB。')
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw Error('请选择 PNG、JPEG、WebP 或 GIF 图片。')
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (token !== generation || pageId !== slide.value?.id || props.disabled || busy.value) throw Error('读取图片时页面已切换或正在保存、准备放映，请重新选择图片。')
    await insertImage({ name: file.name, base64: bytesToBase64(bytes), mimeType: file.type })
  } catch (cause) { error(cause) }
}
async function exportFile(options: OfficeExportRequest = {}): Promise<OfficeExportResult & { saveAs?: boolean }> {
  await opening; commitDrafts()
  const active = current(), token = generation, revision = active.revision, format = options.format || 'pptx'
  if (format !== 'pptx' && format !== 'pdf') throw Error('独立演示编辑器可保存 PPTX，或导出 PDF。')
  const snapshot = snapshotModel(active.model)
  const bytes = format === 'pdf' ? await exportPresentationPdf(snapshot) : await exportPresentation(snapshot)
  if (disposed || token !== generation) throw Error('导出期间文档已切换，请重新保存。')
  if (active.revision !== revision) throw Error('导出期间演示文稿已有新修改，请重新保存。')
  if (format === 'pptx') savedExport = { revision, generation: token }
  const saveAs = format === 'pptx' && (!!snapshot.warnings.length || snapshot.slides.some(page => page.warnings.length)) && !compatibilityCopySaved
  return { base64: bytesToBase64(bytes), extension: format, name: props.document.name.replace(/\.[^.]+$/, '') + (saveAs ? ' 副本' : '') + '.' + format, revision, dirty: active.dirty, ...(saveAs ? { saveAs: true } : {}) }
}
async function markSaved() { if (savedExport?.generation === generation) { current().markSaved(savedExport.revision); compatibilityCopySaved = true; refresh() } }
function discardDrafts() { textEdit.value = null; dataDialog.value = null; smartArtDialog.value = null; rangeFormatDialog.value = null; paragraphDialog.value = null; propertyDraft.value = {}; effectsPending.value = false; refresh(true); effects.value?.discardDrafts() }
function assertNoPendingEdits() { commitDrafts() }
async function discardChanges(options: { force?: boolean } = {}) {
  await opening
  if (options.force) { discardDrafts(); return }
  commitDrafts()
  if (savedExport?.generation !== generation || savedExport.revision !== current().revision) throw Error('导出后演示文稿又有修改，请重新保存当前内容，再切换文档。')
}
async function undo() { await opening; commitDrafts(); current().undo(); refresh(true) }
async function redo() { await opening; commitDrafts(); current().redo(); refresh(true) }
async function present(startPage = 0) {
  if (busy.value) return
  const token = generation, previewToken = ++previewGeneration
  let ownsBusy = false
  try {
    await opening
    if (disposed || token !== generation || previewToken !== previewGeneration || !props.active || busy.value) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement && root.value?.contains(focused)) focused.blur()
    commitDrafts(); busy.value = true; ownsBusy = true
    const active = current(), revision = active.revision, snapshot = snapshotModel(active.model)
    const [pdf, pptx] = await Promise.all([exportPresentationPdf(snapshot), exportPresentation(snapshot)])
    const presentation = await parsePptxPackage(pptx)
    if (disposed || token !== generation || previewToken !== previewGeneration || !props.active) return
    if (active !== controller.value || revision !== active.revision) throw Error('准备放映期间演示文稿已有新修改，请重新开始放映。')
    preview.value = { base64: bytesToBase64(pdf), presentation, startPage }
  } catch (cause) { error(cause); throw cause } finally { if (ownsBusy) busy.value = false }
}
function stopPresentation() { previewGeneration++; preview.value = null }
function snapshotModel(source: PresentationModel): PresentationModel {
  const snapshot = structuredClone({ ...source, sourceParts: undefined }) as PresentationModel
  snapshot.sourceParts = source.sourceParts
  return snapshot
}
function previewObject(object: SlideObject, patch?: Partial<SlideObject>): SlideObject {
  if (!patch) return object
  const transformed = { ...object, ...patch }
  if (object.children) {
    const sx = object.width ? transformed.width / object.width : 1, sy = object.height ? transformed.height / object.height : 1
    transformed.children = object.children.map(child => previewObject(child, { x: transformed.x + (child.x - object.x) * sx, y: transformed.y + (child.y - object.y) * sy, width: child.width * sx, height: child.height * sy }))
  }
  return transformed
}
function objectStyle(object: SlideObject) {
  const geometry = { ...object, ...dragPreview.value[object.id] }
  return { left: `${geometry.x * scale.value}px`, top: `${geometry.y * scale.value}px`, width: `${Math.max(geometry.width, 1) * scale.value}px`, height: `${Math.max(geometry.height, 1) * scale.value}px`, transform: `rotate(${geometry.rotation}deg)` }
}
const richTextEditing = computed(() => {
  const paragraphs = slide.value?.objects.find(object => object.id === textEdit.value?.id)?.richText?.paragraphs
  return !!paragraphs && (paragraphs.length > 1 || paragraphs.some(paragraph => paragraph.runs.length > 1 || paragraph.runs.some(run => run.text.includes('\n'))))
})
const textStyle = computed(() => {
  const item = slide.value?.objects.find(object => object.id === textEdit.value?.id)
  if (!item) return {}
  const layout = textLayoutFor({ ...item, text: textEdit.value?.text ?? item.text })
  const fontFamily = `"${item.textStyle.fontName.replace(/["\\\r\n]/g, '')}", "Noto Sans CJK SC", sans-serif`
  if (textOverlayContext === undefined) textOverlayContext = document.createElement('canvas').getContext('2d')
  let firstBaseline = layout.ascent * scale.value
  if (textOverlayContext) {
    textOverlayContext.font = `${item.textStyle.italic ? 'italic ' : ''}${item.textStyle.bold ? 'bold ' : ''}${layout.fontSize * scale.value}px ${fontFamily}`
    const metrics = textOverlayContext.measureText(textEdit.value?.text || 'Mg')
    const ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent
    if (Number.isFinite(ascent) && Number.isFinite(descent)) firstBaseline = ascent + (layout.lineHeight * scale.value - ascent - descent) / 2
  }
  // A textarea aligns CSS line boxes, while the SVG aligns visible glyphs.
  // Keep their first baseline together for normal middle/bottom text boxes.
  const top = Math.max(0, layout.firstBaseline * scale.value - firstBaseline)
  return { ...objectStyle(item), fontFamily, fontSize: `${layout.fontSize * scale.value}px`, lineHeight: `${layout.lineHeight * scale.value}px`, fontWeight: item.textStyle.bold ? '700' : '400', fontStyle: item.textStyle.italic ? 'italic' : 'normal', textDecoration: item.textStyle.underline ? 'underline' : 'none', textAlign: item.textStyle.align, color: item.textStyle.color,
    padding: `${top}px ${Math.max(0, layout.insets.right) * scale.value}px ${Math.max(0, layout.insets.bottom) * scale.value}px ${Math.max(0, layout.insets.left) * scale.value}px`,
    whiteSpace: item.textLayout?.wrap === false ? 'pre' as const : 'pre-wrap' as const, transform: `rotate(${item.rotation + layout.rotation}deg)` }
})
type Drag = { pointer: number; x: number; y: number; items: SlideObject[]; mode: string; moved: boolean; append: string[] }
let drag: Drag | null = null
function point(event: PointerEvent) { const box = stage.value!.getBoundingClientRect(); return { x: (event.clientX - box.left) / scale.value, y: (event.clientY - box.top) / scale.value } }
function startDrag(event: PointerEvent, item?: SlideObject, mode = 'move') {
  if (event.button !== 0 || !stage.value || busy.value || props.disabled || textEdit.value && textEdit.value.id === item?.id) return
  try {
    commitDrafts(); event.preventDefault(); event.stopPropagation(); root.value?.focus({ preventScroll: true })
    const source = current(), previously = source.selectedObjectIds
    if (item) {
      if (event.shiftKey || event.metaKey || event.ctrlKey) source.action({ type: 'select-objects', ids: previously.includes(item.id) ? previously.filter(id => id !== item.id) : [...previously, item.id] })
      else if (!previously.includes(item.id)) source.action({ type: 'select-objects', ids: [item.id] })
    } else if (!event.shiftKey) source.action({ type: 'select-objects', ids: [] })
    refresh()
    const origin = point(event)
    drag = { pointer: event.pointerId, ...origin, items: selected.value.filter(object => !object.locked).map(object => structuredClone(object)), mode: item ? mode : 'marquee', moved: false, append: event.shiftKey ? [...source.selectedObjectIds] : [] }
    if (!item) marquee.value = { ...origin, width: 0, height: 0 }
  } catch (cause) { error(cause) }
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId || !stage.value || props.disabled || busy.value) return
  const position = point(event), dx = position.x - drag.x, dy = position.y - drag.y
  if (!drag.moved && Math.hypot(dx, dy) * scale.value < 3) return
  if (!drag.moved) stage.value.setPointerCapture(event.pointerId)
  drag.moved = true
  if (drag.mode === 'marquee') { marquee.value = { x: Math.min(drag.x, position.x), y: Math.min(drag.y, position.y), width: Math.abs(dx), height: Math.abs(dy) }; return }
  const changes: Record<string, Partial<SlideObject>> = {}
  for (const item of drag.items) {
    if (drag.mode === 'move') changes[item.id] = { x: item.x + dx, y: item.y + dy }
    else if (drag.mode === 'rotate') {
      const cx = item.x + item.width / 2, cy = item.y + item.height / 2
      const delta = (Math.atan2(position.y - cy, position.x - cx) - Math.atan2(drag.y - cy, drag.x - cx)) * 180 / Math.PI
      const angle = item.rotation + delta
      const snapped = event.shiftKey ? Math.round(angle / 15) * 15 : angle
      changes[item.id] = { rotation: ((snapped + 180) % 360 + 360) % 360 - 180 }
    } else {
      const radians = item.rotation * Math.PI / 180, localX = dx * Math.cos(radians) + dy * Math.sin(radians), localY = -dx * Math.sin(radians) + dy * Math.cos(radians)
      const west = drag.mode.includes('w'), north = drag.mode.includes('n')
      let width = Math.max(2, item.width + (west ? -localX : localX)), height = Math.max(2, item.height + (north ? -localY : localY))
      if (event.shiftKey) { const ratio = item.width / Math.max(1, item.height); if (width / height > ratio) height = width / ratio; else width = height * ratio }
      const shiftX = (width - item.width) / 2 * (west ? -1 : 1), shiftY = (height - item.height) / 2 * (north ? -1 : 1)
      changes[item.id] = { width, height, x: item.x + item.width / 2 + shiftX * Math.cos(radians) - shiftY * Math.sin(radians) - width / 2, y: item.y + item.height / 2 + shiftX * Math.sin(radians) + shiftY * Math.cos(radians) - height / 2 }
    }
  }
  dragPreview.value = changes
}
function endDrag(event: PointerEvent, cancelled = false) {
  if (!drag || drag.pointer !== event.pointerId) return
  const movement = drag; drag = null
  if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  safely(() => {
    if (!cancelled && !props.disabled && !busy.value && movement.moved) {
      if (movement.mode === 'marquee' && marquee.value) {
        const box = marquee.value, ids = slide.value!.objects.filter(item => item.x >= box.x && item.y >= box.y && item.x + item.width <= box.x + box.width && item.y + item.height <= box.y + box.height).map(item => item.id)
        current().action({ type: 'select-objects', ids: [...new Set([...movement.append, ...ids])] })
      } else current().batch(Object.entries(dragPreview.value).map(([id, geometry]) => ({ type: 'update-object', id, ...geometry } as PresentationAction)))
    }
  })
  dragPreview.value = {}; marquee.value = null; refresh()
}
function copy() { commitDrafts(); copiedObjects.value = current().copyObjects(); emit('status', `已复制 ${copiedObjects.value.length} 个对象`) }
function paste() { commitDrafts(); if (!copiedObjects.value.length) return; current().pasteObjects(copiedObjects.value); refresh() }
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || props.disabled || busy.value || !props.active || preview.value || loading.value || !controller.value || root.value?.closest('[inert]')) return
  const target = event.target as HTMLElement, typing = !!target?.closest('input,textarea,select,[contenteditable="true"]')
  if (target?.closest('[role="dialog"]') && !root.value?.contains(target)) return
  if (paragraphDialog.value) { if (event.key === 'Escape') { event.preventDefault(); closeParagraphFormat() } return }
  if (rangeFormatDialog.value) { if (event.key === 'Escape') { event.preventDefault(); closeRangeFormat() } return }
  if (smartArtDialog.value) { if (event.key === 'Escape') { event.preventDefault(); closeSmartArtDialog() } return }
  if (dataDialog.value) { if (event.key === 'Escape') { event.preventDefault(); dataDialog.value = null; root.value?.focus() } return }
  if (event.key === 'F5') { event.preventDefault(); event.stopImmediatePropagation(); safely(() => present(event.shiftKey ? current().currentPageIndex : 0)); return }
  if (event.key === 'Escape') { textEdit.value = null; propertyDraft.value = {}; if (!typing) safely(() => action({ type: 'select-objects', ids: [] })); return }
  if (typing) return
  const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase()
  if (command && ['z', 'y', 'c', 'x', 'v', 'a', 'd'].includes(key)) {
    event.preventDefault(); event.stopPropagation()
    safely(() => {
      if (key === 'z') return event.shiftKey ? redo() : undo()
      if (key === 'y') return redo()
      if (key === 'c' || key === 'x') { copy(); if (key === 'x') action({ type: 'delete-objects', ids: current().selectedObjectIds }); return }
      if (key === 'v') return paste()
      if (key === 'a') return action({ type: 'select-objects', ids: slide.value!.objects.map(item => item.id) })
      commitDrafts(); current().duplicateObjects(); refresh()
    }); return
  }
  if (['Delete', 'Backspace'].includes(event.key) && selected.value.length) { event.preventDefault(); safely(() => action({ type: 'delete-objects', ids: current().selectedObjectIds })); return }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault()
    safely(() => {
      if (!selected.value.length) return action({ type: 'select-page', pageIndex: Math.max(0, Math.min(current().model.slides.length - 1, current().currentPageIndex + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1))) })
      commitDrafts(); const distance = event.shiftKey ? 10 : 1
      current().batch(selected.value.map(item => ({ type: 'update-object', id: item.id, x: item.x + (event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0), y: item.y + (event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0) }))); refresh()
    })
  }
}
function modalKey(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const dialog = (event.currentTarget as HTMLElement), fields = [...dialog.querySelectorAll<HTMLElement>('button,select,input,textarea')].filter(item => !(item as HTMLInputElement).disabled)
  const first = fields[0], last = fields.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
function toggleProperties() { sidebarManuallyToggled = true; propertiesOpen.value = !propertiesOpen.value; void nextTick(resetFit) }
watch(() => props.document.id, () => { opening = load() }, { immediate: true })
watch(() => props.active, active => { if (!active) stopPresentation(); else void nextTick(resetFit) })
onMounted(() => { observer = new ResizeObserver(resetFit); if (viewport.value) observer.observe(viewport.value); window.addEventListener('keydown', keydown, true) })
onBeforeUnmount(() => { disposed = true; generation++; observer?.disconnect(); window.removeEventListener('keydown', keydown, true); preview.value = null })
defineExpose({ exportFile, markSaved, discardChanges, assertNoPendingEdits, discardDrafts, undo, redo, present, stopPresentation, isPresenting: () => !!preview.value, newSlide, insertImage, getPresentationState, presentationAction, presentationObjectData, presentationEdit, focus: () => root.value?.focus() })
</script>

<template>
  <section ref="root" class="pe-editor" tabindex="-1" :inert="props.disabled||busy" :aria-busy="busy||loading" data-testid="standalone-presentation-editor" :data-ready="!!state && !loading" :data-slide-count="state?.pageCount || 0" :data-slide-index="state?.currentPageIndex || 0" aria-label="演示文稿编辑器">
    <div v-if="loading" class="pe-loading" role="status">正在打开演示文稿…</div>
    <template v-else-if="state && model && slide">
      <nav class="pe-toolbar" aria-label="幻灯片工具">
        <div class="pe-tool-group">
          <button data-testid="presentation-new-slide" title="新建空白幻灯片" @click="safely(newSlide)"><span class="pe-icon">＋</span>新建页</button>
          <button data-testid="presentation-insert-text" @click="insertText"><span class="pe-icon pe-text-icon">T</span>文字</button>
          <select aria-label="插入形状" class="pe-tool-select" value="" @change="safely(() => action({type:'insert-shape',shapeType:($event.target as HTMLSelectElement).value as 'rectangle'|'ellipse'|'line'})); ($event.target as HTMLSelectElement).value=''">
            <option value="" disabled>形状 ▾</option><option value="rectangle">矩形</option><option value="ellipse">椭圆</option><option value="line">直线</option>
          </select>
          <button data-testid="presentation-insert-image" @click="imageInput?.click()">图片</button>
          <button data-testid="presentation-insert-table" @click="openData('table')">表格</button>
          <button data-testid="presentation-insert-chart" @click="openData('chart')">图表</button>
        </div>
        <div v-if="primary?.capabilities.text" class="pe-tool-group pe-text-tools">
          <button :aria-pressed="primary.textStyle.bold" title="加粗" @click="changeStyle({bold:!primary.textStyle.bold})"><b>B</b></button>
          <button :aria-pressed="primary.textStyle.italic" title="斜体" @click="changeStyle({italic:!primary.textStyle.italic})"><i>I</i></button>
          <button :aria-pressed="primary.textStyle.underline" title="下划线" @click="changeStyle({underline:!primary.textStyle.underline})"><u>U</u></button>
        </div>
        <div class="pe-tool-group pe-toolbar-end">
          <button :aria-pressed="propertiesOpen" title="显示或收起属性" @click="toggleProperties">属性</button>
          <button class="pe-present" data-testid="presentation-present" :disabled="busy" title="从当前页放映 · Shift+F5" @click="safely(() => present(state!.currentPageIndex))">▷ {{ busy ? '准备中…' : '放映' }}</button>
        </div>
        <input ref="imageInput" type="file" class="pe-hidden-input" accept="image/png,image/jpeg,image/webp,image/gif" data-testid="presentation-image-input" @change="pickImage" />
      </nav>
      <div v-if="problem" class="pe-notice pe-error" role="alert"><span>{{ problem }}</span><button aria-label="关闭错误提示" @click="problem=''">×</button></div>
      <details v-if="warnings.length" class="pe-notice pe-warning"><summary>此文稿有 {{ warnings.length }} 项兼容提示</summary><p v-for="message in warnings" :key="message">{{ message }}</p></details>
      <PresentationFontNotice :key="document.id" :model="model" :active="active" />
      <div class="pe-workspace" :class="{'pe-properties-hidden':!propertiesOpen}">
        <aside class="pe-filmstrip" aria-label="幻灯片列表">
          <div class="pe-panel-heading"><strong>幻灯片</strong><span>{{ state.pageCount }}</span></div>
          <ol>
            <li v-for="(page,index) in model.slides" :key="page.id" :class="{'is-current':index===state.currentPageIndex,'is-hidden':page.hidden}">
              <button class="pe-thumbnail-button" data-testid="presentation-slide-thumbnail" :data-slide-index="index" :aria-label="`第 ${index+1} 页：${page.name}${page.hidden?'，已隐藏':''}`" :aria-current="index===state.currentPageIndex?'page':undefined" @click="selectPage(index)">
                <span class="pe-slide-number">{{ index+1 }}</span><span class="pe-thumbnail" v-html="thumbnails[index]"></span><span class="pe-slide-name">{{ page.name }}<span v-if="page.hidden"> · 已隐藏</span></span>
              </button>
            </li>
          </ol>
          <div class="pe-slide-actions">
            <button data-testid="presentation-duplicate-slide" title="复制当前页" @click="safely(() => action({type:'duplicate-page',pageIndex:state!.currentPageIndex}))">复制</button>
            <button data-testid="presentation-delete-slide" title="删除当前页" :disabled="state.pageCount<=1" @click="safely(() => action({type:'delete-page',pageIndex:state!.currentPageIndex}))">删除</button>
            <button title="当前页上移" :disabled="state.currentPageIndex===0" @click="safely(() => action({type:'move-page',pageIndex:state!.currentPageIndex,direction:'up'}))">↑</button>
            <button title="当前页下移" :disabled="state.currentPageIndex===state.pageCount-1" @click="safely(() => action({type:'move-page',pageIndex:state!.currentPageIndex,direction:'down'}))">↓</button>
          </div>
        </aside>
        <main class="pe-canvas-column">
          <div v-if="textEdit && richTextEditing" class="pe-notice pe-warning" role="status" data-testid="presentation-rich-text-edit-notice">按文字差异保留格式，重复文字请核对样式；混合格式或手动换行正文请在原有行内修改。Esc 取消。</div>
          <div ref="viewport" class="pe-viewport" @pointerdown.self="safely(() => action({type:'select-objects',ids:[]}))">
            <div class="pe-stage-spacing" :style="stageStyle">
              <div ref="stage" class="pe-stage" :style="stageStyle" data-testid="presentation-stage" role="group" :aria-label="`第 ${state.currentPageIndex+1} 页编辑画布`" @pointerdown.self="startDrag($event)" @pointermove="moveDrag" @pointerup="endDrag($event)" @pointercancel="endDrag($event,true)">
                <div class="pe-slide-svg" v-html="currentSvg"></div>
                <div v-for="item in slide.objects" :key="item.id" class="pe-object" :class="{'is-selected':state.selectedObjectIds.includes(item.id),'is-editing':textEdit?.id===item.id,'is-locked':item.locked}" :style="objectStyle(item)" data-testid="presentation-object" :data-object-id="item.id" :data-kind="item.type" :data-x="item.x" :data-y="item.y" :data-width="item.width" :data-height="item.height" :aria-label="`${item.name}，${item.type==='text'?'文字':item.type}`" @pointerdown="startDrag($event,item)" @dblclick.stop="item.type==='table'||item.type==='chart'?openData(item.type,item):beginText(item)">
                  <template v-if="state.selectedObjectIds.includes(item.id) && !textEdit && !item.locked">
                    <button v-for="corner in ['nw','ne','sw','se']" :key="corner" class="pe-handle" :class="'pe-handle-'+corner" :data-testid="'presentation-resize-'+corner" :aria-label="`缩放${item.name}`" @pointerdown.stop="startDrag($event,item,corner)"></button>
                    <button class="pe-rotate-handle" data-testid="presentation-rotate" :aria-label="`旋转${item.name}`" @pointerdown.stop="startDrag($event,item,'rotate')">↻</button>
                  </template>
                </div>
                <textarea v-if="textEdit" ref="textInput" v-model="textEdit.text" class="pe-text-editor" :style="textStyle" data-testid="presentation-text-editor" aria-label="编辑对象文字" spellcheck="false" @pointerdown.stop @blur="safely(commitText)" @keydown.stop="textKeydown"></textarea>
                <div v-if="marquee" class="pe-marquee" :style="{left:`${marquee.x*scale}px`,top:`${marquee.y*scale}px`,width:`${marquee.width*scale}px`,height:`${marquee.height*scale}px`}"></div>
              </div>
            </div>
          </div>
          <div v-if="notesOpen" class="pe-notes"><label for="pe-speaker-notes">演讲者备注</label><textarea id="pe-speaker-notes" v-model="notesDraft" data-testid="presentation-notes" placeholder="添加当前页的演讲提示…" @blur="safely(commitDrafts)"></textarea></div>
          <footer class="pe-status"><span>第 {{ state.currentPageIndex+1 }} / {{ state.pageCount }} 页<span v-if="selected.length"> · {{ selected.length }} 个对象</span></span><button :aria-pressed="notesOpen" @click="notesOpen=!notesOpen; nextTick(resetFit)">备注</button><div class="pe-zoom"><button title="缩小" @click="fit=false; zoom=Math.max(.25,(Math.round(scale/3.7795275591*10)-1)/10)">−</button><output>{{ Math.round(scale/3.7795275591*100) }}%</output><button title="放大" @click="fit=false; zoom=Math.min(3,(Math.round(scale/3.7795275591*10)+1)/10)">＋</button><button :aria-pressed="fit" @click="fit=true; resetFit()">适合</button></div></footer>
        </main>
        <aside v-show="propertiesOpen" class="pe-properties" aria-label="幻灯片与对象属性">
          <div class="pe-panel-heading"><strong>{{ primary ? '对象属性' : '幻灯片属性' }}</strong><button title="收起属性" @click="toggleProperties">×</button></div>
          <template v-if="primary">
            <p class="pe-selection-name">{{ primary.name }}<span v-if="selected.length>1">等 {{ selected.length }} 个对象</span></p>
            <section v-if="primary.smartArt" class="pe-property-section pe-smartart-nodes" aria-label="图示节点文字">
              <h3>图示节点文字</h3>
              <p>{{ primary.smartArt.blockedReason || '可修改受支持节点的文字，保留原图布局。' }}</p>
              <div v-for="(node,index) in primary.smartArt.nodes" :key="node.id">
                <button class="pe-wide-button" data-testid="presentation-smartart-node" :data-node-id="node.id" :disabled="!!primary.smartArt.blockedReason || !node.editable" :title="primary.smartArt.blockedReason || node.reason || '编辑节点文字'" @click="openSmartArtNode(primary,node.id)">{{ node.text || `空白节点 ${index+1}` }}<span v-if="node.editable && !primary.smartArt.blockedReason"> · 编辑</span></button>
                <p v-if="!node.editable && !primary.smartArt.blockedReason">{{ node.reason || '此节点暂为只读。' }}</p>
              </div>
            </section>
            <section class="pe-property-section"><h3>位置与大小 <small>毫米</small></h3><div class="pe-property-grid"><label v-for="entry in [{key:'x',label:'X'},{key:'y',label:'Y'},{key:'width',label:'宽度'},{key:'height',label:'高度'},{key:'rotation',label:'旋转 °'}]" :key="entry.key">{{ entry.label }}<input type="number" step="0.5" :data-testid="'presentation-'+entry.key" :disabled="primary.locked || !primary.capabilities.geometry" :value="propertyValue(entry.key,Math.round(Number(primary[entry.key as keyof SlideObject])*100)/100)" @input="setDraft(entry.key,$event)" @change="safely(applyPropertyDrafts)" /></label></div></section>
            <section v-if="primary.capabilities.text" class="pe-property-section"><h3>文字</h3>
              <label>字体<input list="pe-fonts" :value="propertyValue('fontName',primary.textStyle.fontName)" @input="setDraft('fontName',$event)" @change="safely(applyPropertyDrafts)" /></label>
              <datalist id="pe-fonts"><option>Arial</option><option>Noto Sans SC</option><option>Microsoft YaHei</option><option>SimSun</option><option>Georgia</option><option>Times New Roman</option></datalist>
              <div class="pe-property-grid"><label>字号<input type="number" min="5" max="300" data-testid="presentation-font-size" :value="propertyValue('fontSize',primary.textStyle.fontSize)" @input="setDraft('fontSize',$event)" @change="safely(applyPropertyDrafts)" /></label><label>文字颜色<input type="color" data-testid="presentation-font-color" :value="primary.textStyle.color" @input="changeStyle({color:($event.target as HTMLInputElement).value})" /></label></div>
              <label>文字不透明度 %<input type="number" min="0" max="100" step="1" data-testid="presentation-text-opacity" placeholder="混合" :disabled="!!textOpacityReason" :title="textOpacityReason || '0% 完全透明，100% 不透明；填写后应用于所选对象的全部文字'" :value="propertyValue('textOpacity',primaryTextOpacity)" @input="setDraft('textOpacity',$event)" @change="safely(applyPropertyDrafts)" /></label>
              <p v-if="textOpacityReason" class="pe-property-hint">{{ textOpacityReason }}</p>
              <div class="pe-property-grid">
                <label>下划线<select data-testid="presentation-underline-style" :value="selectedUnderlineStyle" @change="changeStyle({underlineStyle:($event.target as HTMLSelectElement).value as PresentationTextStyle['underlineStyle']})"><option value="" disabled>混合</option><option value="none">无</option><option value="single">单下划线</option><option value="double">双下划线</option></select></label>
                <label>删除线<select data-testid="presentation-strike" :value="selectedStrike" @change="changeStyle({strike:($event.target as HTMLSelectElement).value as PresentationTextStyle['strike']})"><option value="" disabled>混合</option><option value="none">无</option><option value="single">单删除线</option><option value="double">双删除线</option></select></label>
              </div>
              <label>文字高亮<span class="pe-highlight-control"><input type="color" data-testid="presentation-highlight-color" :value="selectedHighlight.color" title="选择颜色后应用不透明高亮" @input="changeStyle({highlightColor:($event.target as HTMLInputElement).value,highlightOpacity:1})" /><button type="button" data-testid="presentation-highlight-clear" @click="changeStyle({highlightColor:null})">清除</button></span></label>
              <p class="pe-property-hint" data-testid="presentation-highlight-status">{{ selectedHighlight.label }}</p>
              <div class="pe-button-row"><button v-for="entry in [{value:'left',label:'左'},{value:'center',label:'中'},{value:'right',label:'右'},{value:'justify',label:'两端'}]" :key="entry.value" :aria-pressed="primary.textStyle.align===entry.value" :title="entry.label+'对齐文字'" @click="changeStyle({align:entry.value as PresentationTextStyle['align']})">{{ entry.label }}</button></div>
              <button v-if="primary.type!=='table'&&primary.type!=='chart'" class="pe-wide-button" @click="beginText(primary)">编辑文字</button>
              <button v-if="!primary.locked&&primary.type!=='table'&&primary.type!=='chart'" class="pe-wide-button" data-testid="presentation-range-format" @click="openRangeFormat(primary)">局部文字格式</button>
              <button v-if="!primary.locked&&primary.type!=='table'&&primary.type!=='chart'" class="pe-wide-button" data-testid="presentation-paragraph-format" @click="openParagraphFormat(primary)">段落与文本框</button>
            </section>
            <section v-if="primary.capabilities.fill || primary.capabilities.line" class="pe-property-section"><h3>填充与边框</h3><div class="pe-property-grid">
              <label v-if="primary.capabilities.fill">填充<input type="color" :value="primary.fillColor||'#ffffff'" @input="updateSelected({fillColor:($event.target as HTMLInputElement).value})" /></label>
              <label v-if="primary.capabilities.line">边框<input type="color" :value="primary.lineColor||'#334155'" @input="updateSelected({lineColor:($event.target as HTMLInputElement).value})" /></label>
              <label v-if="primary.capabilities.line">线宽<input type="number" min="0" max="20" step="0.1" :value="propertyValue('lineWidth',primary.lineWidth)" @input="setDraft('lineWidth',$event)" @change="safely(applyPropertyDrafts)" /></label>
              <label v-if="primary.capabilities.fill && ['text','rectangle','ellipse'].includes(primary.type)">填充不透明度 %<input type="number" min="0" max="100" step="1" data-testid="presentation-fill-opacity" :disabled="!primary.fillColor" :title="primary.fillColor ? '0% 完全透明，100% 不透明' : '请先设置明确的填充颜色'" :value="propertyValue('fillOpacity',Math.round((primary.fillOpacity ?? 1)*10000)/100)" @input="setDraft('fillOpacity',$event)" @change="safely(applyPropertyDrafts)" /></label>
              <label v-if="primary.capabilities.line && ['text','rectangle','ellipse','line'].includes(primary.type)">边框不透明度 %<input type="number" min="0" max="100" step="1" data-testid="presentation-line-opacity" :disabled="!primary.lineColor" :title="primary.lineColor ? '0% 完全透明，100% 不透明' : '请先设置明确的边框颜色'" :value="propertyValue('lineOpacity',Math.round((primary.lineOpacity ?? 1)*10000)/100)" @input="setDraft('lineOpacity',$event)" @change="safely(applyPropertyDrafts)" /></label>
            </div><div class="pe-button-row"><button v-if="primary.capabilities.fill" @click="updateSelected({fillColor:null})">无填充</button><button v-if="primary.capabilities.line" @click="updateSelected({lineWidth:0})">无线条</button></div></section>
            <section class="pe-property-section"><h3>排列</h3><div class="pe-button-row"><button @click="arrange('front')">置顶</button><button @click="arrange('back')">置底</button><button @click="arrange('forward')">上移</button><button @click="arrange('backward')">下移</button></div><select aria-label="对齐对象" value="" @change="arrange(($event.target as HTMLSelectElement).value as PresentationArrangeOperation); ($event.target as HTMLSelectElement).value=''"><option value="" disabled>对齐与分布…</option><option value="align-left">左对齐</option><option value="align-center">水平居中</option><option value="align-right">右对齐</option><option value="align-top">顶端对齐</option><option value="align-middle">垂直居中</option><option value="align-bottom">底端对齐</option><option value="distribute-horizontal">水平分布</option><option value="distribute-vertical">垂直分布</option></select><div class="pe-button-row"><button :disabled="selected.length<2" @click="arrange('group')">组合</button><button :disabled="primary.type!=='group'" @click="arrange('ungroup')">取消组合</button></div></section>
            <button v-if="primary.type==='table'||primary.type==='chart'" class="pe-wide-button" data-testid="presentation-edit-data" @click="openData(primary.type,primary)">编辑{{ primary.type==='table'?'表格':'图表' }}数据</button>
            <div class="pe-button-row pe-object-actions"><button @click="safely(copy)">复制</button><button :disabled="!copiedObjects.length" @click="safely(paste)">粘贴</button><button @click="safely(() => action({type:'delete-objects',ids:state!.selectedObjectIds}))">删除</button></div>
          </template>
          <section class="pe-property-section"><h3>当前幻灯片</h3><label>名称<input v-model="nameDraft" aria-label="幻灯片名称" @change="safely(commitDrafts)" /></label><label>版式<select :value="slide.layout" @change="safely(() => action({type:'set-layout',pageIndex:state!.currentPageIndex,layout:Number(($event.target as HTMLSelectElement).value)}))"><option v-for="layout in PRESENTATION_LAYOUTS" :key="layout.value" :value="layout.value">{{ layout.label }}</option></select></label><div class="pe-property-grid"><label>背景<input type="color" :value="slide.background||'#ffffff'" @input="safely(() => action({type:'set-background',pageIndex:state!.currentPageIndex,color:($event.target as HTMLInputElement).value}))" /></label><label>比例<select :value="Math.abs(model.width/model.height-16/9)<.02?'wide':Math.abs(model.width/model.height-4/3)<.02?'standard':'custom'" @change="safely(() => action({type:'set-page-size',width:254,height:($event.target as HTMLSelectElement).value==='wide'?142.875:190.5}));nextTick(resetFit)"><option value="wide">16:9 宽屏</option><option value="standard">4:3 标准</option><option value="custom" disabled>自定义</option></select></label></div><label class="pe-checkbox"><input type="checkbox" data-testid="presentation-hide-slide" :checked="slide.hidden" @change="safely(() => action({type:'set-hidden',pageIndex:state!.currentPageIndex,value:($event.target as HTMLInputElement).checked}))" />放映时隐藏本页</label></section>
          <PresentationEffects ref="effects" :slide="featureSlide" :page-id="slide.id" :enabled="true" :busy="busy||props.disabled" @edit="safely(() => presentationEdit($event))" @draft-change="effectsPending=$event" @error="error" />
        </aside>
      </div>
      <div v-if="paragraphDialog" class="pe-modal-backdrop">
        <section class="pe-data-dialog pe-paragraph-dialog" role="dialog" aria-modal="true" aria-label="段落与文本框" data-testid="presentation-paragraph-dialog" @keydown="modalKey">
          <header><h2>段落与文本框</h2><button aria-label="取消段落与文本框设置" @click="closeParagraphFormat">×</button></header>
          <p>只应用明确设置的属性。手动换行仍属于同一段落。</p>
          <p v-if="paragraphDialog.blocked" role="status">此文字的段落设置暂不可用：{{ paragraphDialog.blocked }} 仍可设置文本框。</p>
          <fieldset :disabled="!!paragraphDialog.blocked">
            <legend>段落</legend>
            <div class="pe-paragraph-picker-actions"><span>已选 {{ paragraphDialog.indices.length }} / {{ paragraphDialog.paragraphs.length }} 段</span><button data-testid="presentation-paragraph-all" @click="paragraphDialog.indices=paragraphDialog.paragraphs.map((_,index)=>index)">全选</button><button data-testid="presentation-paragraph-none" @click="paragraphDialog.indices=[]">清空</button></div>
            <div class="pe-paragraph-picker" aria-label="选择段落"><label v-for="row in paragraphRows" :key="row.index"><input v-model="paragraphDialog.indices" type="checkbox" :value="row.index" :data-testid="'presentation-paragraph-'+row.index" /><span>{{ row.index+1 }}. {{ row.text.replace(/\n/g,' ↵ ') || '（空段落）' }}</span></label></div>
            <div v-if="paragraphDialog.paragraphs.length>100" class="pe-button-row"><button :disabled="!paragraphDialog.page" @click="paragraphDialog.page--">上一组</button><span>{{ paragraphDialog.page+1 }} / {{ Math.ceil(paragraphDialog.paragraphs.length/100) }}</span><button :disabled="(paragraphDialog.page+1)*100>=paragraphDialog.paragraphs.length" @click="paragraphDialog.page++">下一组</button></div>
            <div class="pe-dialog-fields"><label>水平对齐<select v-model="paragraphDialog.align" data-testid="presentation-paragraph-align"><option value="">保留原样</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select></label><label>首尾段距<select v-model="paragraphDialog.outer" data-testid="presentation-paragraph-outer"><option value="">保留原样</option><option value="true">应用首尾段距</option><option value="false">忽略首尾段距</option></select></label></div>
            <div v-for="entry in [{prefix:'line',label:'行距'},{prefix:'before',label:'段前间距'},{prefix:'after',label:'段后间距'}] as const" :key="entry.prefix" class="pe-spacing-row"><label>{{ entry.label }}<select v-model="paragraphDialog[`${entry.prefix}Unit`]" :data-testid="'presentation-paragraph-'+entry.prefix+'-unit'"><option value="">保留原样</option><option value="percent">百分比（%）</option><option value="points">固定值（磅）</option></select></label><label>{{ paragraphDialog[`${entry.prefix}Unit`]==='percent'?'百分比':'磅值' }}<input v-model="paragraphDialog[`${entry.prefix}Value`]" :disabled="!paragraphDialog[`${entry.prefix}Unit`]" :data-testid="'presentation-paragraph-'+entry.prefix+'-value'" type="number" min="0" max="1000" step="0.01" placeholder="填写数值" /></label></div>
            <p>100% 等于本行最大字号；固定行距较小时文字可重叠。首尾段距对整个文本框生效。</p>
          </fieldset>
          <details class="pe-layout-details"><summary>文本框</summary><div class="pe-dialog-fields"><label>垂直对齐<select v-model="paragraphDialog.vertical" data-testid="presentation-layout-vertical"><option value="">保留原样</option><option value="top">顶部</option><option value="middle">居中</option><option value="bottom">底部</option></select></label><label>自动换行<select v-model="paragraphDialog.wrap" data-testid="presentation-layout-wrap"><option value="">保留原样</option><option value="true">开启</option><option value="false">关闭</option></select></label></div><div class="pe-insets-fields"><label v-for="entry in [{key:'left',label:'左'},{key:'right',label:'右'},{key:'top',label:'上'},{key:'bottom',label:'下'}] as const" :key="entry.key">{{ entry.label }}内边距（毫米）<input v-model="paragraphDialog[entry.key]" :data-testid="'presentation-layout-'+entry.key" type="number" min="0" max="1000" step="0.1" placeholder="保留原值" /></label></div></details>
          <footer><button data-testid="presentation-paragraph-cancel" @click="closeParagraphFormat">取消</button><button class="pe-primary" data-testid="presentation-paragraph-apply" :disabled="!paragraphChanged" @click="safely(applyParagraphFormat)">应用排版</button></footer>
        </section>
      </div>
      <div v-if="rangeFormatDialog" class="pe-modal-backdrop">
        <section class="pe-data-dialog" role="dialog" aria-modal="true" aria-label="局部文字格式" @keydown="modalKey">
          <header><h2>局部文字格式</h2><button aria-label="取消局部文字格式" @click="closeRangeFormat">×</button></header>
          <label class="pe-data-label">选择需要修改格式的文字<textarea ref="rangeFormatInput" :value="rangeFormatDialog.text" readonly data-testid="presentation-range-input" spellcheck="false" @select="selectRangeFormat" @keyup="selectRangeFormat" @mouseup="selectRangeFormat"></textarea></label>
          <p aria-live="polite">{{ rangeFormatSelection.length ? `已选中 ${rangeFormatSelection.length} 个字符：${rangeFormatSelection.slice(0,80).join('')}${rangeFormatSelection.length>80?'…':''}` : '在上方拖动或用键盘选中文字，然后选择要修改的格式。' }}</p>
          <div class="pe-dialog-fields"><label>字体<input v-model="rangeFormatDialog.format.fontName" data-testid="presentation-range-font" placeholder="保留原字体" /></label><label>字号<input v-model="rangeFormatDialog.format.fontSize" data-testid="presentation-range-size" type="number" min="5" max="300" placeholder="保留原字号" /></label></div>
          <label>文字不透明度 %<input v-model="rangeFormatDialog.format.opacity" data-testid="presentation-range-opacity" type="number" min="0" max="100" step="1" placeholder="保留原样" /></label>
          <div class="pe-dialog-fields"><label v-for="entry in [{key:'bold',label:'粗体'},{key:'italic',label:'斜体'}] as const" :key="entry.key">{{ entry.label }}<select v-model="rangeFormatDialog.format[entry.key]" :data-testid="'presentation-range-'+entry.key"><option value="">保留原样</option><option value="true">启用</option><option value="false">关闭</option></select></label><label>文字颜色<span class="pe-range-color"><input v-model="rangeFormatDialog.format.colorEnabled" type="checkbox" data-testid="presentation-range-color-enabled" aria-label="修改选中文字颜色" /><input v-model="rangeFormatDialog.format.color" type="color" :disabled="!rangeFormatDialog.format.colorEnabled" data-testid="presentation-range-color" aria-label="选中文字颜色" /></span></label></div>
          <div class="pe-dialog-fields">
            <label>下划线<select v-model="rangeFormatDialog.format.underline" data-testid="presentation-range-underline"><option value="">保留原样</option><option value="false">无</option><option value="true">单下划线</option><option value="double">双下划线</option></select></label>
            <label>删除线<select v-model="rangeFormatDialog.format.strike" data-testid="presentation-range-strike"><option value="">保留原样</option><option value="none">无</option><option value="single">单删除线</option><option value="double">双删除线</option></select></label>
          </div>
          <div class="pe-dialog-fields"><label>文字高亮<select v-model="rangeFormatDialog.format.highlightMode" data-testid="presentation-range-highlight-mode"><option value="">保留原样</option><option value="color">设置颜色</option><option value="none">清除高亮</option></select></label><label>高亮颜色<input v-model="rangeFormatDialog.format.highlightColor" data-testid="presentation-range-highlight-color" type="color" :disabled="rangeFormatDialog.format.highlightMode!=='color'" /></label></div>
          <p>这里只修改选中文字的格式，不改变文字内容。未选择的格式和其他文字保持原样。</p>
          <footer><button data-testid="presentation-range-cancel" @click="closeRangeFormat">取消</button><button class="pe-primary" data-testid="presentation-range-apply" :disabled="!rangeFormatSelection.length||!rangeFormatChanged" @click="safely(applyRangeFormat)">应用格式</button></footer>
        </section>
      </div>
      <div v-if="smartArtDialog" class="pe-modal-backdrop">
        <section class="pe-data-dialog" role="dialog" aria-modal="true" aria-label="编辑图示节点文字" @keydown="modalKey">
          <header><h2>编辑节点文字</h2><button aria-label="取消节点文字编辑" @click="closeSmartArtDialog">×</button></header>
          <label class="pe-data-label">节点文字<input ref="smartArtInput" v-model="smartArtDialog.text" maxlength="1000" data-testid="presentation-smartart-input" @keydown.enter.prevent="safely(applySmartArtText)" /></label>
          <p>保留此节点的字体、颜色与布局。建议使用简短文字，过长内容可能超出原有图形。</p>
          <footer><button data-testid="presentation-smartart-cancel" @click="closeSmartArtDialog">取消</button><button class="pe-primary" data-testid="presentation-smartart-apply" @click="safely(applySmartArtText)">应用文字</button></footer>
        </section>
      </div>
      <div v-if="dataDialog" class="pe-modal-backdrop">
        <section class="pe-data-dialog" role="dialog" aria-modal="true" :aria-label="dataDialog.kind==='table'?'编辑表格数据':'编辑图表数据'" @keydown="modalKey">
          <header><h2>{{ dataDialog.id?'编辑':'插入' }}{{ dataDialog.kind==='table'?'表格':'图表' }}</h2><button data-testid="presentation-data-close" aria-label="放弃此次数据输入" @click="dataDialog=null;root?.focus()">×</button></header>
          <template v-if="dataDialog.kind==='chart'"><div class="pe-dialog-fields"><label>图表标题<input v-model="dataDialog.title" data-testid="presentation-chart-title" /></label><label>图表类型<select v-model="dataDialog.chartType" data-testid="presentation-chart-type"><option value="column">柱状图</option><option value="bar">条形图</option><option value="line">折线图</option><option value="pie">饼图</option></select></label></div></template>
          <label v-if="!dataDialog.cells" class="pe-data-label">{{ dataDialog.kind==='table'?'表格单元格':'类别和系列数据' }}<textarea v-model="dataDialog.text" data-testid="presentation-data-input" spellcheck="false"></textarea></label>
          <p v-if="!dataDialog.cells">每行一条记录，以制表符分隔列。可直接从电子表格复制粘贴。{{ dataDialog.kind==='chart'?'第一行填写“类别”和系列名称，后续行填写类别与数值。':'' }}</p>
          <p v-else>逐格编辑，可在单元格内换行。保留原有混合文字与段落格式；复杂格只读。重复文字按最终差异匹配，独立格式文字暂不能增删换行。</p>
          <p v-if="dataDialog.resizeReason">{{ dataDialog.resizeReason }}</p>
          <div class="pe-button-row"><button :disabled="!!dataDialog.resizeReason" @click="addDataDimension('row')">＋ 添加行</button><button :disabled="!!dataDialog.resizeReason" @click="addDataDimension('column')">＋ 添加列</button><template v-if="dataDialog.cells"><button :disabled="!!dataDialog.resizeReason||dataDialog.cells.length<=1" @click="dataDialog.cells.pop()">－ 末行</button><button :disabled="!!dataDialog.resizeReason||(dataDialog.cells[0]?.length||0)<=1" @click="dataDialog.cells.forEach(row=>row.pop())">－ 末列</button></template></div>
          <div class="pe-data-preview" :class="{'pe-data-cells':!!dataDialog.cells}" aria-label="可编辑数据网格"><table><tbody><tr v-for="(row,index) in (dataDialog.cells || dataDialog.text.split('\n').map(line=>line.split('\t'))).slice(0,101)" :key="index"><td v-for="(cell,column) in row.slice(0,21)" :key="column"><template v-if="dataDialog.cells"><textarea :value="cell" :readonly="!!dataDialog.cellReasons?.[index]?.[column]" :aria-label="`第 ${index+1} 行第 ${column+1} 列`" :title="dataDialog.cellReasons?.[index]?.[column]" @input="dataCell(index,column,$event)" /><small v-if="dataDialog.cellReasons?.[index]?.[column]">{{ dataDialog.cellReasons[index]![column] }}</small></template><input v-else :value="cell" :aria-label="`第 ${index+1} 行第 ${column+1} 列`" @input="dataCell(index,column,$event)" /></td></tr></tbody></table></div>
          <footer><button @click="dataDialog=null;root?.focus()">取消</button><button class="pe-primary" data-testid="presentation-data-apply" @click="safely(applyData)">应用数据</button></footer>
        </section>
      </div>
    </template>
    <div v-else class="pe-load-error" role="alert"><strong>无法打开演示文稿</strong><p>{{ problem }}</p><button @click="opening=load()">重试</button></div>
    <SlidePreview v-if="preview" :base64="preview.base64" :name="props.document.name" :presentation="preview.presentation" :start-page="preview.startPage" @close="stopPresentation" @error="error" />
  </section>
</template>
