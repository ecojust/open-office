<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import { base64ToBytes, bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { createWordDocument, documentText, inheritedParagraphStyle, AUTO_LINE_HEIGHT_LIMITS, PARAGRAPH_SPACING_LIMITS, POINT_LINE_HEIGHT_LIMITS, PAGE_SIZE_LIMITS, PAGE_MARGIN_LIMITS, BASELINE_OFFSET_LIMITS, LETTER_SPACING_LIMITS, normalizeTextColor, normalizeUnderlineColor, orderedSelection, paragraphInsertionFormat, paragraphText, withParagraphMarkerSource, WordController, type ParagraphMarkerFormat, type ParagraphStyle, type TextStyle, type WordDocument, type WordPage, type WordRun, type WordSelection } from '../word/core/model'
import { importWordDocument, exportWordDocument } from '../word/core/runtime'
import type { PreparedWordDocument } from '../word/core/prepared'
import { invalidateWordFontMetrics, readWordDom, readWordRange, readWordSelection, renderWordDom, restoreWordSelection } from '../word/core/dom'
import { HIGHLIGHT_COLORS, type HighlightColor } from '../word/core/highlight'
import { normalizeBackgroundColor } from '../word/core/background'
import { textColorPaint } from '../word/core/text-color'
import { normalizePaperDimension } from '../word/core/paper'
import '../word/core/editor.css'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedWordDocument; active?: boolean; disabled?: boolean }>(), { active: true, disabled: false })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string] }>()
const content = ref<HTMLElement>(), controller = shallowRef<WordController>()
const version = ref(0), selectionVersion = ref(0), loading = ref(true), problem = ref(''), notice = ref('')
const composing = ref(false)
let disposed = false, generation = 0, readyGeneration = 0, opening: Promise<void> = Promise.resolve(), compositionPending = false
let fontMetricsPending = false
let compositionInsertion: { generation: number; revision: number; paragraph: number; id: string; text: string; format: ParagraphMarkerFormat } | undefined
let savedExport: { generation: number; revision: number; snapshot: WordDocument } | undefined
type IndentKey = 'indentLeft' | 'indentRight' | 'indentFirstLine'
const indentFields: { key: IndentKey; label: string; testId: string }[] = [
  { key: 'indentLeft', label: '左侧缩进', testId: 'word-indent-left' },
  { key: 'indentRight', label: '右侧缩进', testId: 'word-indent-right' },
  { key: 'indentFirstLine', label: '首行缩进', testId: 'word-indent-first-line' },
]
const indentPanelId = `word-indent-${crypto.randomUUID()}`
const indentPanel = ref<HTMLFormElement>(), indentOpen = ref(false), indentError = ref('')
const indentDraft = ref<Record<IndentKey, string>>({ indentLeft: '', indentRight: '', indentFirstLine: '' })
const indentMixed = ref<Record<IndentKey, boolean>>({ indentLeft: false, indentRight: false, indentFirstLine: false })
const indentTouched = ref<IndentKey[]>([])
let indentSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
type ParagraphSpacingKey = 'spaceBefore' | 'spaceAfter'
type LineHeightRule = NonNullable<ParagraphStyle['lineHeightRule']>
const paragraphSpacingFields: { key: ParagraphSpacingKey; label: string; testId: string }[] = [
  { key: 'spaceBefore', label: '段前', testId: 'word-paragraph-spacing-before' },
  { key: 'spaceAfter', label: '段后', testId: 'word-paragraph-spacing-after' },
]
const paragraphLineChoices: { value: LineHeightRule; label: string; hint: string }[] = [
  { value: 'auto', label: '倍数', hint: '随文字大小变化' },
  { value: 'exact', label: '固定值', hint: '固定每行高度' },
  { value: 'atLeast', label: '最小值', hint: '允许较大文字撑高' },
]
const paragraphSpacingPanelId = `word-paragraph-spacing-${crypto.randomUUID()}`
const paragraphSpacingPanel = ref<HTMLFormElement>(), paragraphSpacingOpen = ref(false), paragraphSpacingError = ref('')
const paragraphSpacingOverlay = ref(false)
const paragraphSpacingPanelStyle = ref<{ maxHeight: string; width?: string; left?: string; top?: string }>({ maxHeight: '55vh' })
const paragraphSpacingDraft = ref<Record<ParagraphSpacingKey, string>>({ spaceBefore: '', spaceAfter: '' })
const paragraphSpacingMixed = ref<Record<ParagraphSpacingKey, boolean>>({ spaceBefore: false, spaceAfter: false })
const paragraphSpacingTouched = ref<ParagraphSpacingKey[]>([])
const paragraphLineRule = ref<LineHeightRule | ''>(''), paragraphLineDraft = ref(''), paragraphLineMixed = ref(false), paragraphLineTouched = ref(false)
const paragraphLineLimits = computed(() => paragraphLineRule.value === 'auto'
  ? { ...AUTO_LINE_HEIGHT_LIMITS, units: 100 }
  : { ...POINT_LINE_HEIGHT_LIMITS, units: 20 })
let paragraphSpacingSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
type PageField = 'width' | 'height' | 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight'
type PagePreset = 'a4' | 'a5' | 'letter' | 'legal' | 'custom'
const pageSettingsFields: { key: PageField; label: string; testId: string }[] = [
  { key: 'width', label: '纸张宽度', testId: 'word-page-settings-width' },
  { key: 'height', label: '纸张高度', testId: 'word-page-settings-height' },
  { key: 'marginTop', label: '上边距', testId: 'word-page-settings-margin-top' },
  { key: 'marginBottom', label: '下边距', testId: 'word-page-settings-margin-bottom' },
  { key: 'marginLeft', label: '左边距', testId: 'word-page-settings-margin-left' },
  { key: 'marginRight', label: '右边距', testId: 'word-page-settings-margin-right' },
]
const pagePresets: { value: PagePreset; label: string; width?: number; height?: number }[] = [
  { value: 'a4', label: 'A4', width: 595.3, height: 841.9 },
  { value: 'a5', label: 'A5', width: 419.55, height: 595.3 },
  { value: 'letter', label: 'Letter', width: 612, height: 792 },
  { value: 'legal', label: 'Legal', width: 612, height: 1008 },
  { value: 'custom', label: '自定义' },
]
const pageSettingsId = `word-page-settings-${crypto.randomUUID()}`
const pageSettingsPanel = ref<HTMLFormElement>(), pageSettingsOpen = ref(false), pageSettingsError = ref('')
const pageSettingsDraft = ref<Record<PageField, string>>({ width: '', height: '', marginTop: '', marginBottom: '', marginLeft: '', marginRight: '' })
const pageSettingsTouched = ref<PageField[]>([]), pageSettingsPreset = ref<PagePreset>('custom')
const pageSettingsOrientation = ref<'portrait' | 'landscape'>('portrait')
const pageSettingsOrientationTouched = ref(false)
const pageSettingsDimensionsValid = computed(() => (['width', 'height'] as const).every(key => {
  const value = Number(pageSettingsDraft.value[key])
  return pageSettingsDraft.value[key].trim() && Number.isFinite(value) && value >= PAGE_SIZE_LIMITS.min && value <= PAGE_SIZE_LIMITS.max
    && Math.abs(value * 20 - Math.round(value * 20)) < 1e-7
}))
const pageSettingsSizePreview = computed(() => {
  if (!pageSettingsDimensionsValid.value || !pageSettingsTouched.value.some(key => key === 'width' || key === 'height')) return undefined
  const width = Number(pageSettingsDraft.value.width), height = Number(pageSettingsDraft.value.height)
  try {
    const normalizedWidth = normalizePaperDimension(width), normalizedHeight = normalizePaperDimension(height)
    return normalizedWidth !== width || normalizedHeight !== height ? { size: `${normalizedWidth} × ${normalizedHeight} 磅`, error: '' } : undefined
  } catch (cause) {
    return { size: '', error: cause instanceof Error ? cause.message : String(cause) }
  }
})
let pageSettingsSnapshot: { generation: number; revision: number; page: WordPage } | undefined
const underlineMenuId = `word-underline-${crypto.randomUUID()}`
const underlineControl = ref<HTMLElement>(), underlineMenu = ref<HTMLElement>(), underlineMenuOpen = ref(false)
const underlineMenuStyle = ref<{ left: string; top: string; maxHeight: string }>({ left: '0px', top: '0px', maxHeight: '350px' })
const underlineColorMode = ref<'auto' | 'custom' | 'mixed'>('auto'), underlineColorDraft = ref('#20242B'), underlineColorTouched = ref(false)
const underlineChoices: { name: 'none' | 'single' | 'double'; value: NonNullable<TextStyle['underline']>; label: string }[] = [
  { name: 'none', value: false, label: '无下划线' },
  { name: 'single', value: true, label: '单下划线' },
  { name: 'double', value: 'double', label: '双下划线' },
]
let underlineSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
const colorMenuId = `word-color-${crypto.randomUUID()}`
const colorControl = ref<HTMLElement>(), colorMenu = ref<HTMLFormElement>(), colorMenuOpen = ref(false)
const colorMenuStyle = ref<{ left: string; top: string; maxHeight: string }>({ left: '0px', top: '0px', maxHeight: '260px' })
const colorMode = ref<'auto' | 'custom' | 'mixed'>('custom'), colorDraft = ref('#20242B'), colorTouched = ref(false)
let colorSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
const strikeMenuId = `word-strike-${crypto.randomUUID()}`
const strikeControl = ref<HTMLElement>(), strikeMenu = ref<HTMLElement>(), strikeMenuOpen = ref(false)
const strikeChoices: { value: NonNullable<TextStyle['strike']>; label: string }[] = [
  { value: 'none', label: '无删除线' },
  { value: 'single', label: '单删除线' },
  { value: 'double', label: '双删除线' },
]
let strikeSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
const highlightMenuId = `word-highlight-${crypto.randomUUID()}`
const highlightControl = ref<HTMLElement>(), highlightMenu = ref<HTMLElement>(), highlightMenuOpen = ref(false)
const highlightMenuStyle = ref<{ left: string; top: string; maxHeight: string }>({ left: '0px', top: '0px', maxHeight: '360px' })
const highlightChoices = [...HIGHLIGHT_COLORS.filter(choice => choice.value === 'none'), ...HIGHLIGHT_COLORS.filter(choice => choice.value !== 'none')]
let highlightSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
const backgroundMenuId = `word-background-${crypto.randomUUID()}`
const backgroundControl = ref<HTMLElement>(), backgroundMenu = ref<HTMLFormElement>(), backgroundMenuOpen = ref(false)
const backgroundMenuStyle = ref<{ left: string; top: string; maxHeight: string }>({ left: '0px', top: '0px', maxHeight: '240px' })
const backgroundDraft = ref('#FFF2CC')
let backgroundSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
const letterSpacingMenuId = `word-letter-spacing-${crypto.randomUUID()}`
const letterSpacingControl = ref<HTMLElement>(), letterSpacingMenu = ref<HTMLFormElement>(), letterSpacingMenuOpen = ref(false)
const letterSpacingMenuStyle = ref<{ left: string; top: string; maxHeight: string }>({ left: '0px', top: '0px', maxHeight: '352px' })
const letterSpacingDraft = ref(''), letterSpacingTouched = ref(false), letterSpacingError = ref('')
const kerningDraft = ref<'on' | 'off' | 'mixed'>('off'), kerningTouched = ref(false)
let letterSpacingSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
const caseMenuId = `word-case-${crypto.randomUUID()}`
const caseControl = ref<HTMLElement>(), caseMenu = ref<HTMLElement>(), caseMenuOpen = ref(false)
const caseMenuStyle = ref<{ left: string; top: string; maxHeight: string }>({ left: '0px', top: '0px', maxHeight: '160px' })
const caseChoices: { value: NonNullable<TextStyle['caseMap']>; label: string }[] = [
  { value: 'none', label: '原样' }, { value: 'upper', label: '全部大写' }, { value: 'smallCaps', label: '小型大写' },
]
let caseSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined
const positionMenuId = `word-position-${crypto.randomUUID()}`
const positionControl = ref<HTMLElement>(), positionMenu = ref<HTMLFormElement>(), positionMenuOpen = ref(false)
const positionMenuStyle = ref<{ left: string; top: string; maxHeight: string }>({ left: '0px', top: '0px', maxHeight: '260px' })
const positionDraft = ref(''), positionTouched = ref(false), positionError = ref('')
let positionSnapshot: { generation: number; revision: number; selection: WordSelection } | undefined

const model = computed(() => { version.value; return controller.value?.model })
const unavailable = computed(() => props.disabled || loading.value || !controller.value || composing.value)
const characters = computed(() => model.value ? Array.from(documentText(model.value).replace(/\n/g, '')).length : 0)
const canUndo = computed(() => { version.value; return !!controller.value?.canUndo })
const canRedo = computed(() => { version.value; return !!controller.value?.canRedo })
const pageStyle = computed(() => {
  const page = model.value?.page || createWordDocument().page
  return { width: `${page.width}pt`, minHeight: `${page.height}pt`, padding: `${page.marginTop}pt ${page.marginRight}pt ${page.marginBottom}pt ${page.marginLeft}pt`, tabSize: `${model.value?.defaultTabStop ?? 36}pt` }
})
const selectedStyles = computed(() => {
  version.value; selectionVersion.value
  const current = controller.value, value = model.value
  if (!current || !value) return [] as TextStyle[]
  const [start, end] = orderedSelection(current.selection), styles: TextStyle[] = []
  const collapsed = start.paragraph === end.paragraph && start.offset === end.offset
  const insertionParagraph = value.paragraphs[start.paragraph]!
  if (collapsed && insertionParagraph.marker && start.offset === paragraphText(insertionParagraph).length) return [paragraphInsertionFormat(insertionParagraph).style]
  for (let index = start.paragraph; index <= end.paragraph; index++) {
    const paragraph = value.paragraphs[index]!
    let offset = 0
    for (const run of paragraph.runs) {
      const limit = offset + run.text.length
      const from = index === start.paragraph ? start.offset : 0, to = index === end.paragraph ? end.offset : paragraphText(paragraph).length
      if (collapsed ? from >= offset && from <= limit : limit > from && offset < to) styles.push(run.style)
      offset = limit
    }
    if (index < end.paragraph) styles.push(paragraph.marker?.style ?? (paragraphText(paragraph).length ? paragraph.sourceRun ?? {} : paragraph.runs[0]!.style))
  }
  return styles.length ? styles : [{}]
})
const selectionParagraph = computed(() => { selectionVersion.value; return model.value?.paragraphs[controller.value?.selection.focus.paragraph || 0] })
const fontSize = computed(() => { const sizes = new Set(selectedStyles.value.map(style => style.fontSize || 12)); return sizes.size === 1 ? String([...sizes][0]) : '' })
const colorSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.color ?? '#20242B'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? '#20242B'
})
const colorLabel = computed(() => colorSelection.value === 'mixed' ? '混合' : colorSelection.value === 'auto' ? '自动' : colorSelection.value)
const color = computed(() => textColorPaint(selectedStyles.value[0] ?? {}) ?? '#20242B')
const marked = (key: 'bold' | 'italic') => selectedStyles.value.length > 0 && selectedStyles.value.every(style => style[key] === true)
const underlineSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.underline === 'double' ? 'double' : style.underline ? 'single' : 'none'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'none'
})
const underlinePressed = computed(() => underlineSelection.value === 'mixed' ? 'mixed' : underlineSelection.value !== 'none')
const underlineColorSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.underlineColor ?? 'auto'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'auto'
})
const underlineColorLabel = computed(() => underlineColorSelection.value === 'mixed' ? '混合' : underlineColorSelection.value === 'auto' ? '跟随文字' : underlineColorSelection.value)
const strikeSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.strike ?? 'none'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'none'
})
const strikePressed = computed(() => strikeSelection.value === 'mixed' ? 'mixed' : strikeSelection.value !== 'none')
const highlightSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.highlight ?? 'none'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'none'
})
const selectedHighlight = computed(() => HIGHLIGHT_COLORS.find(choice => choice.value === highlightSelection.value))
const highlightLabel = computed(() => highlightSelection.value === 'mixed' ? '混合' : selectedHighlight.value?.label || '无色')
const backgroundSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.backgroundColor ?? 'none'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'none'
})
const backgroundLabel = computed(() => backgroundSelection.value === 'mixed' ? '混合' : backgroundSelection.value === 'none' ? '无背景色' : backgroundSelection.value)
const letterSpacingSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.letterSpacing ?? 0))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 0
})
const letterSpacingLabel = computed(() => {
  const value = letterSpacingSelection.value
  return value === 'mixed' ? '混合' : value === 0 ? '常规' : `${value > 0 ? '加宽' : '紧缩'} ${Math.abs(value)} 磅`
})
const kerningSelection = computed<'on' | 'off' | 'mixed'>(() => {
  const values = new Set(selectedStyles.value.map(style => style.kerning ? 'on' : 'off'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'off'
})
const caseSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.caseMap ?? 'none'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'none'
})
const caseLabel = computed(() => caseSelection.value === 'mixed' ? '混合' : caseChoices.find(choice => choice.value === caseSelection.value)!.label)
const positionSelection = computed(() => {
  const values = new Set(selectedStyles.value.map(style => style.verticalAlign ?? 'baseline'))
  return values.size > 1 ? 'mixed' : [...values][0] ?? 'baseline'
})
const positionLabel = computed(() => {
  const value = positionSelection.value
  return typeof value === 'number' ? `${value > 0 ? '上移' : '下移'} ${Math.abs(value)}%`
    : value === 'mixed' ? '混合' : value === 'superscript' ? '上标' : value === 'subscript' ? '下标' : '正常'
})
function verticalPressed(value: 'superscript' | 'subscript'): boolean | 'mixed' {
  const matches = selectedStyles.value.map(style => (style.verticalAlign ?? 'baseline') === value)
  return matches.length > 0 && matches.every(Boolean) ? true : matches.some(Boolean) ? 'mixed' : false
}

function report(cause: unknown) {
  problem.value = cause instanceof Error ? cause.message : String(cause)
  emit('error', problem.value)
}
function safely(work: () => unknown) {
  try { const result = work(); if (result instanceof Promise) void result.catch(report) } catch (cause) { report(cause) }
}
function current(): WordController {
  if (!controller.value || loading.value || disposed) throw Error('请等待文字文稿打开。')
  return controller.value
}
function refresh() {
  if (pageSettingsSnapshot && !pageSettingsSnapshotCurrent(pageSettingsSnapshot)) closePageSettings()
  if (indentSnapshot && !formatSnapshotCurrent(indentSnapshot)) closeIndentPanel()
  if (paragraphSpacingSnapshot && !formatSnapshotCurrent(paragraphSpacingSnapshot)) closeParagraphSpacingPanel()
  if (underlineSnapshot && !formatSnapshotCurrent(underlineSnapshot)) closeUnderlineMenu()
  if (colorSnapshot && !formatSnapshotCurrent(colorSnapshot)) closeColorMenu()
  if (strikeSnapshot && !formatSnapshotCurrent(strikeSnapshot)) closeStrikeMenu()
  if (highlightSnapshot && !formatSnapshotCurrent(highlightSnapshot)) closeHighlightMenu()
  if (backgroundSnapshot && !formatSnapshotCurrent(backgroundSnapshot)) closeBackgroundMenu()
  if (letterSpacingSnapshot && !formatSnapshotCurrent(letterSpacingSnapshot)) closeLetterSpacingMenu()
  if (caseSnapshot && !formatSnapshotCurrent(caseSnapshot)) closeCaseMenu()
  if (positionSnapshot && !formatSnapshotCurrent(positionSnapshot)) closePositionMenu()
  version.value++; selectionVersion.value++
  emit('dirty', !!controller.value?.dirty)
}
function render(restore = false) {
  if (!content.value || !controller.value || composing.value) return
  renderWordDom(content.value, controller.value.model)
  fontMetricsPending = false
  if (restore && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function loadedFonts() {
  invalidateWordFontMetrics(); fontMetricsPending = true
  if (!composing.value && !compositionPending) render(document.activeElement === content.value)
}
function rememberSelection() {
  if (!content.value || !controller.value || composing.value || compositionPending) return
  const selection = readWordSelection(content.value)
  if (!selection) return
  try {
    controller.value.setSelection(selection); selectionVersion.value++
    if (indentSnapshot && !formatSnapshotCurrent(indentSnapshot)) closeIndentPanel()
    if (paragraphSpacingSnapshot && !formatSnapshotCurrent(paragraphSpacingSnapshot)) closeParagraphSpacingPanel()
    if (underlineSnapshot && !formatSnapshotCurrent(underlineSnapshot)) closeUnderlineMenu()
    if (colorSnapshot && !formatSnapshotCurrent(colorSnapshot)) closeColorMenu()
    if (strikeSnapshot && !formatSnapshotCurrent(strikeSnapshot)) closeStrikeMenu()
    if (highlightSnapshot && !formatSnapshotCurrent(highlightSnapshot)) closeHighlightMenu()
    if (backgroundSnapshot && !formatSnapshotCurrent(backgroundSnapshot)) closeBackgroundMenu()
    if (letterSpacingSnapshot && !formatSnapshotCurrent(letterSpacingSnapshot)) closeLetterSpacingMenu()
    if (caseSnapshot && !formatSnapshotCurrent(caseSnapshot)) closeCaseMenu()
    if (positionSnapshot && !formatSnapshotCurrent(positionSnapshot)) closePositionMenu()
  } catch { /* Native input will commit its updated model and caret together. */ }
}
function commitInput(restore = false) {
  if (!content.value || !controller.value || composing.value) return
  const active = current(), selection = readWordSelection(content.value), revision = active.revision
  let canonical = false, scriptFonts = false, markerInput = false
  try {
    const next = readWordDom(content.value, active.model)
    if (compositionInsertion && compositionInsertion.generation === generation && compositionInsertion.revision === active.revision) {
      const saved = compositionInsertion, before = active.model, paragraph = next.paragraphs[saved.paragraph]
      // Keep the live IME DOM untouched until composition commits. Writer
      // types at the paragraph end using its final body run overlaid with
      // direct marker attributes; an empty paragraph uses its resolved mark.
      // Validate the original prefix before replacing only the appended run.
      if (next.paragraphs.length !== before.paragraphs.length || paragraph?.id !== saved.id || !paragraphText(paragraph).startsWith(saved.text)) throw Error('输入法修改了段落边界，请重新输入。')
      const inserted = paragraphText(paragraph).slice(saved.text.length)
      if (inserted) paragraph.runs = [...runSlice(before.paragraphs[saved.paragraph]!.runs, 0, saved.text.length), { text: inserted, ...structuredClone(saved.format) }]
    }
    active.setDocument(next, selection)
    const paragraph = next.paragraphs[(selection || active.selection).focus.paragraph]
    scriptFonts = !!paragraph?.runs.some(run => run.style.fontNameEastAsia && run.style.fontNameEastAsia !== run.style.fontName)
    // A native insertion can enter the marker's geometry-only placeholder,
    // or put body text before it. Reconcile that paragraph so the marker's
    // empty-line font never becomes the newly typed text's visible size.
    markerInput = !!paragraph?.marker && active.revision !== revision
    canonical = content.value.childNodes.length === next.paragraphs.length && next.paragraphs.every((paragraph, index) => {
      const node = content.value!.childNodes[index]
      return node instanceof HTMLElement && node.tagName === 'P' && node.dataset.wordParagraph === paragraph.id
    })
  }
  catch (cause) {
    // Browser input has already changed the DOM. A rejected edit must return
    // to the last valid transaction so saving and undo remain usable.
    render(restore || document.activeElement === content.value); refresh()
    throw cause
  }
  if (active.revision !== revision) refresh()
  else { selectionVersion.value++; emit('dirty', active.dirty) }
  // Native typing already updates its paragraph and caret. Preserve both; only
  // normalize a structural browser edit that escaped the paragraph container.
  if (markerInput) render(restore)
  else if (restore && (!canonical || scriptFonts)) render(true)
}
function input(event: Event) {
  if (props.disabled) return
  if (composing.value || compositionPending || (event as InputEvent).isComposing) { emit('dirty', true); return }
  safely(() => commitInput(true))
}
function startComposition() {
  if (props.disabled) return
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu(); rememberSelection()
  compositionInsertion = undefined
  const active = controller.value
  if (active) {
    const [start, end] = orderedSelection(active.selection), paragraph = active.model.paragraphs[start.paragraph]!
    if (paragraph.marker && start.paragraph === end.paragraph && start.offset === end.offset && start.offset === paragraphText(paragraph).length) {
      compositionInsertion = { generation, revision: active.revision, paragraph: start.paragraph, id: paragraph.id, text: paragraphText(paragraph), format: paragraphInsertionFormat(paragraph) }
    }
  }
  composing.value = true
}
function endComposition() {
  composing.value = false; compositionPending = true
  const token = generation
  queueMicrotask(() => {
    if (disposed || generation !== token) return
    compositionPending = false
    safely(() => { try { commitInput(document.activeElement === content.value); if (fontMetricsPending) render(document.activeElement === content.value) } finally { compositionInsertion = undefined } })
  })
}
function blur() {
  if (!composing.value && !compositionPending) safely(() => commitInput())
}
function command(work: (active: WordController) => void) {
  if (unavailable.value) return
  closeParagraphSpacingPanel()
  closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu()
  commitInput(); rememberSelection()
  problem.value = ''; notice.value = ''; work(current()); refresh(); render(true)
}
function formatText(patch: TextStyle) {
  command(active => {
    const [start, end] = orderedSelection(active.selection)
    if (start.paragraph === end.paragraph && start.offset === end.offset && paragraphText(active.model.paragraphs[start.paragraph]!).length) {
      notice.value = '请先选中文字，再设置字符格式。'; emit('status', notice.value); return
    }
    active.formatText(active.selection, patch)
  })
}
function toggle(key: 'bold' | 'italic') { formatText({ [key]: !marked(key) }) }
function toggleUnderline() { formatText({ underline: underlinePressed.value !== true }) }
function closeUnderlineMenu(restore = false) {
  underlineMenuOpen.value = false; underlineSnapshot = undefined
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleUnderlineMenu() {
  if (unavailable.value) return
  if (underlineMenuOpen.value) { closeUnderlineMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu(); commitInput(); rememberSelection()
  const active = current(), anchor = underlineControl.value?.getBoundingClientRect()
  if (!anchor) return
  const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12
  const opensAbove = below < 330 && above > below, height = Math.min(350, Math.max(80, opensAbove ? above : below))
  underlineMenuStyle.value = {
    left: `${Math.max(8, Math.min(anchor.right - 248, window.innerWidth - 256))}px`,
    top: `${opensAbove ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6}px`,
    maxHeight: `${height}px`,
  }
  underlineColorMode.value = underlineColorSelection.value === 'mixed' ? 'mixed' : underlineColorSelection.value === 'auto' ? 'auto' : 'custom'
  underlineColorDraft.value = underlineColorSelection.value.startsWith('#') ? underlineColorSelection.value : color.value.toUpperCase()
  underlineColorTouched.value = false
  underlineSnapshot = { generation, revision: active.revision, selection: active.selection }
  underlineMenuOpen.value = true
  void nextTick(() => {
    if (!underlineMenuOpen.value) return
    const target = underlineMenu.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]') || underlineMenu.value?.querySelector('button')
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' })
  })
}
function chooseUnderline(value: NonNullable<TextStyle['underline']>) {
  if (!underlineSnapshot || !formatSnapshotCurrent(underlineSnapshot)) { closeUnderlineMenu(); return }
  formatText({ underline: value })
}
function underlineMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeUnderlineMenu(true); return }
  // The dialog contains a style menu and a color form. Keep arrow navigation
  // within the style choices; native Tab/arrow behavior serves the form.
  if (!(event.target instanceof HTMLElement) || !event.target.closest('[role="menu"]')) return
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(underlineMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: 'nearest' })
}
function editUnderlineColor(event: Event) {
  underlineColorDraft.value = normalizeUnderlineColor((event.target as HTMLInputElement).value)
  underlineColorMode.value = 'custom'; underlineColorTouched.value = true
}
function applyUnderlineColor() {
  if (unavailable.value || !underlineSnapshot) return
  const snapshot = underlineSnapshot
  commitInput(); rememberSelection()
  if (!formatSnapshotCurrent(snapshot)) { closeUnderlineMenu(); return }
  if (!underlineColorTouched.value || underlineColorMode.value === 'mixed') { closeUnderlineMenu(true); return }
  formatText({ underlineColor: underlineColorMode.value === 'auto' ? 'auto' : normalizeUnderlineColor(underlineColorDraft.value) })
}
function underlineMenuFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !underlineControl.value?.contains(event.relatedTarget)) closeUnderlineMenu()
}
function closeColorMenu(restore = false) {
  colorMenuOpen.value = false; colorSnapshot = undefined
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleColorMenu() {
  if (unavailable.value) return
  if (colorMenuOpen.value) { closeColorMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu(); commitInput(); rememberSelection()
  const active = current(), anchor = colorControl.value?.getBoundingClientRect()
  if (!anchor) return
  const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12
  const opensAbove = below < 240 && above > below, height = Math.min(260, Math.max(80, opensAbove ? above : below))
  colorMenuStyle.value = {
    left: `${Math.max(8, Math.min(anchor.right - 248, window.innerWidth - 256))}px`,
    top: `${opensAbove ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6}px`,
    maxHeight: `${height}px`,
  }
  colorMode.value = colorSelection.value === 'mixed' ? 'mixed' : colorSelection.value === 'auto' ? 'auto' : 'custom'
  colorDraft.value = color.value
  colorTouched.value = false
  colorSnapshot = { generation, revision: active.revision, selection: active.selection }
  colorMenuOpen.value = true
  void nextTick(() => {
    if (!colorMenuOpen.value) return
    const target = colorMenu.value?.querySelector<HTMLInputElement>('input:checked') || colorMenu.value?.querySelector('input')
    target?.focus({ preventScroll: true })
  })
}
function editColor(event: Event) {
  colorDraft.value = normalizeTextColor((event.target as HTMLInputElement).value)
  colorMode.value = 'custom'; colorTouched.value = true
}
function applyColor() {
  if (unavailable.value || !colorSnapshot) return
  const snapshot = colorSnapshot
  commitInput(); rememberSelection()
  if (!formatSnapshotCurrent(snapshot)) { closeColorMenu(); return }
  if (!colorTouched.value || colorMode.value === 'mixed') { closeColorMenu(true); return }
  const value = normalizeTextColor(colorMode.value === 'auto' ? 'auto' : colorDraft.value)
  // Reapplying the effective value must not manufacture a direct override or
  // reset a paragraph marker. Automatic and fixed RGB remain distinct values.
  if (selectedStyles.value.every(style => (style.color ?? '#20242B') === value)) { closeColorMenu(true); return }
  formatText({ color: value })
}
function colorMenuFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !colorControl.value?.contains(event.relatedTarget)) closeColorMenu()
}
function toggleVertical(value: 'superscript' | 'subscript') {
  formatText({ verticalAlign: verticalPressed(value) === true ? 'baseline' : value })
}
function toggleStrike() { formatText({ strike: strikePressed.value === true ? 'none' : 'single' }) }
function closeStrikeMenu(restore = false) {
  strikeMenuOpen.value = false; strikeSnapshot = undefined
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleStrikeMenu() {
  if (unavailable.value) return
  if (strikeMenuOpen.value) { closeStrikeMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu(); commitInput(); rememberSelection()
  const active = current()
  strikeSnapshot = { generation, revision: active.revision, selection: active.selection }
  strikeMenuOpen.value = true
  void nextTick(() => {
    if (!strikeMenuOpen.value) return
    const checked = strikeMenu.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    const target = checked || strikeMenu.value?.querySelector('button')
    target?.focus()
  })
}
function chooseStrike(value: NonNullable<TextStyle['strike']>) {
  if (!strikeSnapshot || !formatSnapshotCurrent(strikeSnapshot)) { closeStrikeMenu(); return }
  formatText({ strike: value })
}
function strikeMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeStrikeMenu(true); return }
  if (event.key === 'Tab') { closeStrikeMenu(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(strikeMenu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
function closeHighlightMenu(restore = false) {
  highlightMenuOpen.value = false; highlightSnapshot = undefined
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleHighlightMenu() {
  if (unavailable.value) return
  if (highlightMenuOpen.value) { closeHighlightMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu(); commitInput(); rememberSelection()
  const active = current(), anchor = highlightControl.value?.getBoundingClientRect()
  if (!anchor) return
  const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12
  const opensAbove = below < 340 && above > below, height = Math.min(360, Math.max(80, opensAbove ? above : below))
  highlightMenuStyle.value = {
    left: `${Math.max(8, Math.min(anchor.right - 224, window.innerWidth - 232))}px`,
    top: `${opensAbove ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6}px`,
    maxHeight: `${height}px`,
  }
  highlightSnapshot = { generation, revision: active.revision, selection: active.selection }
  highlightMenuOpen.value = true
  void nextTick(() => {
    if (!highlightMenuOpen.value) return
    const target = highlightMenu.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]') || highlightMenu.value?.querySelector('button')
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' })
  })
}
function chooseHighlight(value: HighlightColor) {
  if (!highlightSnapshot || !formatSnapshotCurrent(highlightSnapshot)) { closeHighlightMenu(); return }
  formatText({ highlight: value })
}
function highlightMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHighlightMenu(true); return }
  if (event.key === 'Tab') { closeHighlightMenu(); return }
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(highlightMenu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  if (!buttons.length) return
  const index = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : event.key === 'ArrowDown' ? (index === 0 ? 1 : Math.min(buttons.length - 1, index + 2))
      : event.key === 'ArrowUp' ? Math.max(0, index - 2)
        : event.key === 'ArrowRight' ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1)
  buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: 'nearest' })
}
function outsideCharacterMenus(event: PointerEvent) {
  if (!(event.target instanceof Node)) return
  if (paragraphSpacingOpen.value && paragraphSpacingOverlay.value && !paragraphSpacingPanel.value?.contains(event.target)
    && !(event.target instanceof Element && event.target.closest('[data-testid="word-paragraph-spacing-toggle"]'))) closeParagraphSpacingPanel()
  if (underlineMenuOpen.value && !underlineControl.value?.contains(event.target)) closeUnderlineMenu()
  if (colorMenuOpen.value && !colorControl.value?.contains(event.target)) closeColorMenu()
  if (strikeMenuOpen.value && !strikeControl.value?.contains(event.target)) closeStrikeMenu()
  if (highlightMenuOpen.value && !highlightControl.value?.contains(event.target)) closeHighlightMenu()
  if (backgroundMenuOpen.value && !backgroundControl.value?.contains(event.target)) closeBackgroundMenu()
  if (letterSpacingMenuOpen.value && !letterSpacingControl.value?.contains(event.target)) closeLetterSpacingMenu()
  if (caseMenuOpen.value && !caseControl.value?.contains(event.target)) closeCaseMenu()
  if (positionMenuOpen.value && !positionControl.value?.contains(event.target)) closePositionMenu()
}
function resizeCharacterMenus() {
  updateParagraphSpacingHeight()
  closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu()
}
function closeBackgroundMenu(restore = false) {
  backgroundMenuOpen.value = false; backgroundSnapshot = undefined
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleBackgroundMenu() {
  if (unavailable.value) return
  if (backgroundMenuOpen.value) { closeBackgroundMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu(); commitInput(); rememberSelection()
  const active = current(), anchor = backgroundControl.value?.getBoundingClientRect()
  if (!anchor) return
  const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12
  const opensAbove = below < 220 && above > below, height = Math.min(240, Math.max(80, opensAbove ? above : below))
  backgroundMenuStyle.value = {
    left: `${Math.max(8, Math.min(anchor.right - 248, window.innerWidth - 256))}px`,
    top: `${opensAbove ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6}px`,
    maxHeight: `${height}px`,
  }
  backgroundDraft.value = /^#[\da-f]{6}$/i.test(backgroundSelection.value) ? backgroundSelection.value : '#FFF2CC'
  backgroundSnapshot = { generation, revision: active.revision, selection: active.selection }
  backgroundMenuOpen.value = true
  void nextTick(() => { if (backgroundMenuOpen.value) backgroundMenu.value?.querySelector('input')?.focus({ preventScroll: true }) })
}
function editBackground(event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (/^#[\da-f]{6}$/i.test(value)) backgroundDraft.value = value.toUpperCase()
}
function applyBackground(value = backgroundDraft.value) {
  if (unavailable.value || !backgroundSnapshot) return
  if (!formatSnapshotCurrent(backgroundSnapshot)) { closeBackgroundMenu(); return }
  const [start, end] = orderedSelection(backgroundSnapshot.selection)
  const hasSelection = start.paragraph !== end.paragraph || start.offset !== end.offset
  const coveredByHighlight = selectedStyles.value.some(style => style.highlight && style.highlight !== 'none')
  formatText({ backgroundColor: normalizeBackgroundColor(value) })
  if (hasSelection && coveredByHighlight && value !== 'none') {
    notice.value = '背景色已保留；有高亮的文字会优先显示高亮。'; emit('status', notice.value)
  }
}
function backgroundMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeBackgroundMenu(true) }
}
function backgroundMenuFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !backgroundControl.value?.contains(event.relatedTarget)) closeBackgroundMenu()
}
function closeLetterSpacingMenu(restore = false) {
  letterSpacingMenuOpen.value = false; letterSpacingSnapshot = undefined; letterSpacingError.value = ''
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleLetterSpacingMenu() {
  if (unavailable.value) return
  if (letterSpacingMenuOpen.value) { closeLetterSpacingMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeCaseMenu(); closePositionMenu(); commitInput(); rememberSelection()
  const active = current(), anchor = letterSpacingControl.value?.getBoundingClientRect()
  if (!anchor) return
  const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12
  const opensAbove = below < 332 && above > below, height = Math.min(352, Math.max(80, opensAbove ? above : below))
  letterSpacingMenuStyle.value = {
    left: `${Math.max(8, Math.min(anchor.right - 272, window.innerWidth - 280))}px`,
    top: `${opensAbove ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6}px`,
    maxHeight: `${height}px`,
  }
  letterSpacingDraft.value = letterSpacingSelection.value === 'mixed' ? '' : String(letterSpacingSelection.value)
  letterSpacingTouched.value = false; letterSpacingError.value = ''
  kerningDraft.value = kerningSelection.value; kerningTouched.value = false
  letterSpacingSnapshot = { generation, revision: active.revision, selection: active.selection }
  letterSpacingMenuOpen.value = true
  void nextTick(() => {
    if (!letterSpacingMenuOpen.value) return
    const input = letterSpacingMenu.value?.querySelector('input')
    input?.focus({ preventScroll: true }); input?.select()
  })
}
function editLetterSpacing(event: Event) {
  letterSpacingDraft.value = (event.target as HTMLInputElement).value
  letterSpacingTouched.value = true; letterSpacingError.value = ''
}
function applyLetterSpacing(reset = false) {
  if (unavailable.value || !letterSpacingSnapshot) return
  const snapshot = letterSpacingSnapshot
  const draft = reset ? '0' : letterSpacingDraft.value.trim(), value = Number(draft)
  if (reset || letterSpacingTouched.value) {
    if (!draft || !Number.isFinite(value) || value < LETTER_SPACING_LIMITS.min || value > LETTER_SPACING_LIMITS.max
      || Math.abs(value * 20 - Math.round(value * 20)) > 1e-7) {
      letterSpacingError.value = `请输入 ${LETTER_SPACING_LIMITS.min} 至 ${LETTER_SPACING_LIMITS.max} 之间的数值，以 ${LETTER_SPACING_LIMITS.step} 磅递增。`
      return
    }
  }
  commitInput(); rememberSelection()
  if (!formatSnapshotCurrent(snapshot)) { closeLetterSpacingMenu(); notice.value = '选区或文稿已变化，请重新打开字符间距。'; return }
  const patch: TextStyle = {}
  if (reset || letterSpacingTouched.value) patch.letterSpacing = Math.round(value * 20) / 20
  // The existing normal-spacing action only clears tracking. Apply commits
  // both independently touched drafts together, producing one undo entry.
  if (!reset && kerningTouched.value && kerningDraft.value !== 'mixed') patch.kerning = kerningDraft.value === 'on' ? 1 : 0
  if (Object.keys(patch).length) formatText(patch)
  else closeLetterSpacingMenu(true)
}
function letterSpacingMenuFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !letterSpacingControl.value?.contains(event.relatedTarget)) closeLetterSpacingMenu()
}
function closePositionMenu(restore = false) {
  positionMenuOpen.value = false; positionSnapshot = undefined; positionError.value = ''
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function togglePositionMenu() {
  if (unavailable.value) return
  if (positionMenuOpen.value) { closePositionMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); commitInput(); rememberSelection()
  const active = current(), anchor = positionControl.value?.getBoundingClientRect()
  if (!anchor) return
  const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12
  const opensAbove = below < 260 && above > below, height = Math.min(260, Math.max(90, opensAbove ? above : below))
  positionMenuStyle.value = {
    left: `${Math.max(8, Math.min(anchor.right - 248, window.innerWidth - 256))}px`,
    top: `${opensAbove ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6}px`,
    maxHeight: `${height}px`,
  }
  positionDraft.value = typeof positionSelection.value === 'number' ? String(positionSelection.value) : positionSelection.value === 'baseline' ? '0' : ''
  positionTouched.value = false; positionError.value = ''
  positionSnapshot = { generation, revision: active.revision, selection: active.selection }
  positionMenuOpen.value = true
  void nextTick(() => {
    if (!positionMenuOpen.value) return
    const input = positionMenu.value?.querySelector('input')
    input?.focus({ preventScroll: true }); input?.select()
  })
}
function editPosition(event: Event) {
  positionDraft.value = (event.target as HTMLInputElement).value
  positionTouched.value = true; positionError.value = ''
}
function applyPosition(reset = false) {
  if (unavailable.value || !positionSnapshot) return
  const snapshot = positionSnapshot, draft = reset ? '0' : positionDraft.value.trim(), value = Number(draft)
  if ((reset || positionTouched.value) && (!draft || !Number.isInteger(value) || value < BASELINE_OFFSET_LIMITS.min || value > BASELINE_OFFSET_LIMITS.max)) {
    positionError.value = `请输入 ${BASELINE_OFFSET_LIMITS.min} 至 ${BASELINE_OFFSET_LIMITS.max} 之间的整数百分比。`
    return
  }
  commitInput(); rememberSelection()
  if (!formatSnapshotCurrent(snapshot)) { closePositionMenu(); notice.value = '选区或文稿已变化，请重新打开文字位置。'; return }
  if (reset || positionTouched.value) formatText({ verticalAlign: value === 0 ? 'baseline' : value })
  else closePositionMenu(true)
}
function positionMenuFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !positionControl.value?.contains(event.relatedTarget)) closePositionMenu()
}
function closeCaseMenu(restore = false) {
  caseMenuOpen.value = false; caseSnapshot = undefined
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleCaseMenu() {
  if (unavailable.value) return
  if (caseMenuOpen.value) { closeCaseMenu(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closePositionMenu(); commitInput(); rememberSelection()
  const active = current(), anchor = caseControl.value?.getBoundingClientRect()
  if (!anchor) return
  const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12
  const opensAbove = below < 160 && above > below, height = Math.min(160, Math.max(34, opensAbove ? above : below))
  caseMenuStyle.value = {
    left: `${Math.max(8, Math.min(anchor.right - 184, window.innerWidth - 192))}px`,
    top: `${opensAbove ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6}px`,
    maxHeight: `${height}px`,
  }
  caseSnapshot = { generation, revision: active.revision, selection: active.selection }
  caseMenuOpen.value = true
  void nextTick(() => {
    if (!caseMenuOpen.value) return
    const target = caseMenu.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]') || caseMenu.value?.querySelector('button')
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' })
  })
}
function chooseCase(value: NonNullable<TextStyle['caseMap']>) {
  if (unavailable.value || !caseSnapshot) return
  const snapshot = caseSnapshot
  commitInput(); rememberSelection()
  if (!formatSnapshotCurrent(snapshot)) { closeCaseMenu(); return }
  formatText({ caseMap: value })
}
function caseMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCaseMenu(true); return }
  if (event.key === 'Tab') {
    caseControl.value?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus({ preventScroll: true })
    closeCaseMenu(); return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(caseMenu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: 'nearest' })
}
function caseMenuFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !caseControl.value?.contains(event.relatedTarget)) closeCaseMenu()
}
function formatParagraph(patch: ParagraphStyle) { command(active => active.formatParagraph(active.selection, patch)) }
function sameSelection(left: WordSelection, right: WordSelection): boolean {
  return left.anchor.paragraph === right.anchor.paragraph && left.anchor.offset === right.anchor.offset
    && left.focus.paragraph === right.focus.paragraph && left.focus.offset === right.focus.offset
}
function formatSnapshotCurrent(snapshot: NonNullable<typeof indentSnapshot>): boolean {
  return !!controller.value && snapshot.generation === generation && snapshot.revision === controller.value.revision
    && sameSelection(snapshot.selection, controller.value.selection)
}
function closeIndentPanel(restore = false) {
  indentOpen.value = false; indentSnapshot = undefined; indentError.value = ''
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleIndentPanel() {
  if (unavailable.value) return
  closePageSettings()
  closeParagraphSpacingPanel()
  closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu()
  if (indentOpen.value) { closeIndentPanel(true); return }
  commitInput(); rememberSelection()
  const active = current(), selection = active.selection, [start, end] = orderedSelection(selection)
  const last = end.paragraph > start.paragraph && end.offset === 0 ? end.paragraph - 1 : end.paragraph
  const paragraphs = active.model.paragraphs.slice(start.paragraph, last + 1)
  for (const { key } of indentFields) {
    const values = new Set(paragraphs.map(paragraph => paragraph.style[key] ?? 0))
    indentMixed.value[key] = values.size > 1
    indentDraft.value[key] = values.size === 1 ? String([...values][0]) : ''
  }
  indentTouched.value = []; indentError.value = ''
  indentSnapshot = { generation, revision: active.revision, selection }
  indentOpen.value = true
  void nextTick(() => { if (indentOpen.value) indentPanel.value?.querySelector('input')?.focus() })
}
function editIndent(key: IndentKey, event: Event) {
  indentDraft.value[key] = (event.target as HTMLInputElement).value
  if (!indentTouched.value.includes(key)) indentTouched.value.push(key)
  indentError.value = ''
}
function applyIndent() {
  if (unavailable.value || !indentSnapshot) return
  const snapshot = indentSnapshot, patch: ParagraphStyle = {}
  // Validate the entire draft before committing anything. Untouched mixed
  // fields do not enter the patch, so per-paragraph values remain intact.
  for (const key of indentTouched.value) {
    const draft = indentDraft.value[key].trim(), value = Number(draft)
    if (!draft || !Number.isFinite(value) || value < -1584 || value > 1584 || Math.abs(value * 20 - Math.round(value * 20)) > 1e-7) {
      indentError.value = '请输入 −1584 至 1584 之间的数值，以 0.05 磅递增。'
      return
    }
    patch[key] = Math.round(value * 20) / 20
  }
  commitInput(); rememberSelection()
  if (!formatSnapshotCurrent(snapshot)) {
    closeIndentPanel(); notice.value = '选区或文稿已变化，请重新打开段落缩进。'; return
  }
  if (Object.keys(patch).length) current().formatParagraph(snapshot.selection, patch)
  closeIndentPanel(); problem.value = ''; notice.value = ''; refresh(); render(true)
}
function closeParagraphSpacingPanel(restore = false) {
  paragraphSpacingOpen.value = false; paragraphSpacingSnapshot = undefined; paragraphSpacingError.value = ''
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function toggleParagraphSpacingPanel() {
  if (unavailable.value) return
  closePageSettings()
  if (paragraphSpacingOpen.value) { closeParagraphSpacingPanel(true); return }
  closeIndentPanel(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu()
  commitInput(); rememberSelection()
  const active = current(), selection = active.selection, [start, end] = orderedSelection(selection)
  const last = end.paragraph > start.paragraph && end.offset === 0 ? end.paragraph - 1 : end.paragraph
  const paragraphs = active.model.paragraphs.slice(start.paragraph, last + 1)
  for (const { key } of paragraphSpacingFields) {
    const values = new Set(paragraphs.map(paragraph => paragraph.style[key]))
    const value = [...values][0]
    paragraphSpacingMixed.value[key] = values.size > 1
    paragraphSpacingDraft.value[key] = values.size === 1 && value !== undefined ? String(value) : ''
  }
  const rules = new Set(paragraphs.map(paragraph => paragraph.style.lineHeight !== undefined ? paragraph.style.lineHeightRule ?? 'auto' : undefined))
  const heights = new Set(paragraphs.map(paragraph => paragraph.style.lineHeight))
  const rule = [...rules][0], height = [...heights][0]
  paragraphLineRule.value = rules.size === 1 && rule !== undefined ? rule : ''
  paragraphLineMixed.value = rules.size > 1 || heights.size > 1
  paragraphLineDraft.value = rules.size === 1 && heights.size === 1 && height !== undefined ? String(height) : ''
  paragraphSpacingTouched.value = []; paragraphLineTouched.value = false; paragraphSpacingError.value = ''
  paragraphSpacingSnapshot = { generation, revision: active.revision, selection }
  paragraphSpacingOpen.value = true
  void nextTick(() => {
    if (!paragraphSpacingOpen.value) return
    updateParagraphSpacingHeight(); paragraphSpacingPanel.value?.querySelector('input')?.focus()
  })
}
function updateParagraphSpacingHeight() {
  const panel = paragraphSpacingPanel.value
  if (!paragraphSpacingOpen.value || !panel) return
  const bottom = Math.min(window.innerHeight, panel.parentElement?.getBoundingClientRect().bottom ?? window.innerHeight)
  const toolbarBottom = panel.parentElement?.querySelector('.word-toolbar')?.getBoundingClientRect().bottom ?? panel.getBoundingClientRect().top
  const available = bottom - toolbarBottom - 48
  paragraphSpacingOverlay.value = available < 220
  if (paragraphSpacingOverlay.value) {
    const height = Math.min(440, window.innerHeight - 32), width = Math.min(700, window.innerWidth - 24)
    paragraphSpacingPanelStyle.value = { maxHeight: `${height}px`, width: `${width}px`, left: `${(window.innerWidth - width) / 2}px`, top: `${Math.max(16, (window.innerHeight - height) / 2)}px` }
  } else paragraphSpacingPanelStyle.value = { maxHeight: `${available}px` }
}
function paragraphSpacingFocusout(event: FocusEvent) {
  if (paragraphSpacingOverlay.value && event.relatedTarget instanceof Node && !paragraphSpacingPanel.value?.contains(event.relatedTarget)
    && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-testid="word-paragraph-spacing-toggle"]'))) closeParagraphSpacingPanel()
}
function editParagraphSpacing(key: ParagraphSpacingKey, event: Event) {
  paragraphSpacingDraft.value[key] = (event.target as HTMLInputElement).value
  if (!paragraphSpacingTouched.value.includes(key)) paragraphSpacingTouched.value.push(key)
  paragraphSpacingError.value = ''
}
function chooseParagraphLineRule(rule: LineHeightRule) {
  // A multiplier is not a point measurement. A unit change needs an explicit
  // new value instead of reinterpreting an old number in the other unit.
  if (!paragraphLineRule.value || (paragraphLineRule.value === 'auto') !== (rule === 'auto')) paragraphLineDraft.value = ''
  paragraphLineRule.value = rule; paragraphLineTouched.value = true; paragraphSpacingError.value = ''
}
function editParagraphLineHeight(event: Event) {
  paragraphLineDraft.value = (event.target as HTMLInputElement).value
  paragraphLineTouched.value = true; paragraphSpacingError.value = ''
}
function applyParagraphSpacing() {
  if (unavailable.value || !paragraphSpacingSnapshot) return
  const snapshot = paragraphSpacingSnapshot, patch: ParagraphStyle = {}
  for (const key of paragraphSpacingTouched.value) {
    const draft = paragraphSpacingDraft.value[key].trim(), value = Number(draft)
    if (!draft || !Number.isFinite(value) || value < PARAGRAPH_SPACING_LIMITS.min || value > PARAGRAPH_SPACING_LIMITS.max || Math.abs(value * 20 - Math.round(value * 20)) > 1e-7) {
      paragraphSpacingError.value = `段前和段后请输入 ${PARAGRAPH_SPACING_LIMITS.min} 至 ${PARAGRAPH_SPACING_LIMITS.max} 之间的数值，以 ${PARAGRAPH_SPACING_LIMITS.step} 磅递增。`; return
    }
    patch[key] = Math.round(value * 20) / 20
  }
  if (paragraphLineTouched.value) {
    const draft = paragraphLineDraft.value.trim(), value = Number(draft), rule = paragraphLineRule.value, limits = paragraphLineLimits.value
    if (!rule) { paragraphSpacingError.value = '请选择行距方式，再输入对应数值。'; return }
    if (!draft || !Number.isFinite(value) || value < limits.min || value > limits.max
      || Math.abs(value * limits.units - Math.round(value * limits.units)) > 1e-7) {
      paragraphSpacingError.value = rule === 'auto' ? `行距倍数请输入 ${limits.min} 至 ${limits.max} 之间的数值，以 ${limits.step} 递增。`
        : `行距请输入 ${limits.min} 至 ${limits.max} 之间的数值，以 0.05 磅递增。`
      return
    }
    patch.lineHeight = Math.round(value * limits.units) / limits.units
    patch.lineHeightRule = rule
  }
  commitInput(); rememberSelection()
  if (!formatSnapshotCurrent(snapshot)) {
    closeParagraphSpacingPanel(); notice.value = '选区或文稿已变化，请重新打开段落间距。'; return
  }
  if (Object.keys(patch).length) current().formatParagraph(snapshot.selection, patch)
  closeParagraphSpacingPanel(); problem.value = ''; notice.value = ''; refresh(); render(true)
}
function pageSettingsSnapshotCurrent(snapshot: NonNullable<typeof pageSettingsSnapshot>): boolean {
  return !!controller.value && snapshot.generation === generation && snapshot.revision === controller.value.revision
}
function closePageSettings(restore = false) {
  pageSettingsOpen.value = false; pageSettingsSnapshot = undefined; pageSettingsError.value = ''
  if (restore && content.value && controller.value && props.active) restoreWordSelection(content.value, controller.value.selection)
}
function pagePresetFor(width: number, height: number): PagePreset {
  const small = Math.min(width, height), large = Math.max(width, height)
  return pagePresets.find(preset => preset.width !== undefined && Math.abs(preset.width - small) < 0.001 && Math.abs(preset.height! - large) < 0.001)?.value ?? 'custom'
}
function togglePageSettings() {
  if (unavailable.value) return
  if (pageSettingsOpen.value) { closePageSettings(true); return }
  closeIndentPanel(); closeParagraphSpacingPanel(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu()
  commitInput(); rememberSelection()
  const active = current(), page = active.model.page
  for (const { key } of pageSettingsFields) pageSettingsDraft.value[key] = String(page[key])
  pageSettingsPreset.value = pagePresetFor(page.width, page.height)
  pageSettingsOrientation.value = page.orientation ?? (page.width > page.height ? 'landscape' : 'portrait')
  pageSettingsTouched.value = []; pageSettingsOrientationTouched.value = false; pageSettingsError.value = ''
  pageSettingsSnapshot = { generation, revision: active.revision, page }
  pageSettingsOpen.value = true
  void nextTick(() => {
    if (pageSettingsOpen.value) pageSettingsPanel.value?.querySelector<HTMLInputElement>('input:checked')?.focus()
  })
}
function setPageDraft(key: PageField, value: string) {
  pageSettingsDraft.value[key] = value
  if (!pageSettingsTouched.value.includes(key)) pageSettingsTouched.value.push(key)
  pageSettingsError.value = ''
}
function editPageSetting(key: PageField, event: Event) {
  setPageDraft(key, (event.target as HTMLInputElement).value)
  if (key === 'width' || key === 'height') pageSettingsPreset.value = 'custom'
}
function choosePagePreset(value: PagePreset) {
  pageSettingsPreset.value = value
  const preset = pagePresets.find(preset => preset.value === value)!
  if (preset.width === undefined || preset.height === undefined) return
  const landscape = pageSettingsOrientation.value === 'landscape'
  setPageDraft('width', String(landscape ? preset.height : preset.width))
  setPageDraft('height', String(landscape ? preset.width : preset.height))
  pageSettingsOrientationTouched.value = true
}
function choosePageOrientation(orientation: 'portrait' | 'landscape') {
  const width = Number(pageSettingsDraft.value.width), height = Number(pageSettingsDraft.value.height)
  if (!pageSettingsDraft.value.width.trim() || !pageSettingsDraft.value.height.trim() || !Number.isFinite(width) || !Number.isFinite(height)) {
    pageSettingsError.value = '请先输入有效的纸张宽度和高度，再调整方向。'; return
  }
  const small = Math.min(width, height), large = Math.max(width, height)
  setPageDraft('width', String(orientation === 'landscape' ? large : small))
  setPageDraft('height', String(orientation === 'landscape' ? small : large))
  pageSettingsOrientation.value = orientation; pageSettingsOrientationTouched.value = true
}
function applyPageSettings() {
  if (unavailable.value || !pageSettingsSnapshot) return
  const snapshot = pageSettingsSnapshot, patch: Partial<WordPage> = {}
  for (const key of pageSettingsTouched.value) {
    const draft = pageSettingsDraft.value[key].trim(), value = Number(draft)
    const limits = key === 'width' || key === 'height' ? PAGE_SIZE_LIMITS : PAGE_MARGIN_LIMITS
    if (!draft || !Number.isFinite(value) || value < limits.min || value > limits.max || Math.abs(value * 20 - Math.round(value * 20)) > 1e-7) {
      const field = pageSettingsFields.find(field => field.key === key)!
      pageSettingsError.value = `${field.label}请输入 ${limits.min} 至 ${limits.max} 之间的数值，以 ${limits.step} 磅递增。`; return
    }
    const normalized = Math.round(value * 20) / 20
    if (normalized !== snapshot.page[key]) patch[key] = normalized
  }
  if (pageSettingsOrientationTouched.value && pageSettingsOrientation.value !== snapshot.page.orientation) patch.orientation = pageSettingsOrientation.value
  commitInput(); rememberSelection()
  if (!pageSettingsSnapshotCurrent(snapshot)) {
    closePageSettings(); notice.value = '文稿已变化，请重新打开页面设置。'; return
  }
  try {
    if (Object.keys(patch).length) current().formatPage(patch)
  } catch (cause) {
    pageSettingsError.value = cause instanceof Error ? cause.message : String(cause); return
  }
  closePageSettings(); problem.value = ''; notice.value = ''; refresh(); render(true)
}
function changeSize(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  if (Number.isFinite(value) && value >= 1 && value <= 400) formatText({ fontSize: value })
}
function changeHeading(event: Event) {
  const heading = Number((event.target as HTMLSelectElement).value) as 0 | 1 | 2 | 3
  command(active => {
    const selection = active.selection, [start, end] = orderedSelection(selection), next = active.model
    const last = end.paragraph > start.paragraph && !end.offset ? end.paragraph - 1 : end.paragraph
    for (let index = start.paragraph; index <= last; index++) {
      const paragraph = next.paragraphs[index]!
      const previousParagraph = inheritedParagraphStyle(paragraph)
      const followParagraph: ParagraphStyle = paragraph.nextParagraphStyle ? { ...paragraph.nextParagraphStyle.paragraph } : { ...previousParagraph, heading: 0 }
      const previousFollowRun = paragraph.nextParagraphStyle?.run
      // Imported documents can enable document-wide hyphenation while disabling
      // it in every supported paragraph. Preserve that effective follow style.
      if (next.autoHyphenation) followParagraph.suppressAutoHyphens = true
      const inherited: TextStyle = (heading === 0 ? previousFollowRun : undefined) || paragraph.sourceRun || paragraph.nextParagraphStyle?.sourceRun || {
        fontName: 'Times New Roman', fontNameEastAsia: 'Times New Roman', fontNameCs: 'Times New Roman',
        fontSize: 12, color: '#20242B', bold: false, italic: false, underline: false,
      }
      const sourceRun: TextStyle = heading === 0 && previousFollowRun ? { ...previousFollowRun } : { ...inherited, fontSize: [12, 24, 20, 16][heading], bold: heading !== 0 }
      const directParagraph = { ...(paragraph.directStyle ?? paragraph.style) }
      delete directParagraph.heading
      const sourceParagraph: ParagraphStyle = { ...(heading ? previousParagraph : followParagraph), heading }
      paragraph.style = { ...sourceParagraph, ...directParagraph }
      paragraph.sourceParagraph = sourceParagraph
      paragraph.directStyle = directParagraph
      paragraph.sourceRun = sourceRun
      if (paragraph.marker) paragraph.marker = withParagraphMarkerSource(paragraph.marker, sourceRun)
      paragraph.runs = paragraph.runs.map(run => {
        const directStyle = { ...(run.directStyle ?? run.style) }
        const style: TextStyle = { ...sourceRun, ...(run.sourceVerticalAlign !== undefined ? { verticalAlign: run.sourceVerticalAlign } : {}), ...(run.sourceColor !== undefined ? { color: run.sourceColor } : {}), ...directStyle }
        return { ...run, style, directStyle }
      })
      paragraph.nextParagraphStyle = { paragraph: heading ? followParagraph : { ...sourceParagraph }, run: previousFollowRun ? { ...previousFollowRun } : { ...inherited, fontSize: 12, bold: false }, sourceRun }
    }
    active.setDocument(next, selection)
  })
}
function changeAlign(event: Event) { formatParagraph({ align: (event.target as HTMLSelectElement).value as ParagraphStyle['align'] }) }
function changeColor(event: Event) {
  const value = normalizeTextColor((event.target as HTMLInputElement).value)
  commitInput(); rememberSelection()
  if (selectedStyles.value.every(style => (style.color ?? '#20242B') === value)) return
  formatText({ color: value })
}
function insertText(text: string) { command(active => active.replaceText(active.selection, text)) }

function runSlice(runs: WordRun[], start: number, end: number): WordRun[] {
  let offset = 0
  const result: WordRun[] = []
  for (const run of runs) {
    const from = Math.max(0, start - offset), to = Math.min(run.text.length, end - offset)
    if (to > from) result.push({ ...run, text: run.text.slice(from, to), style: { ...run.style }, ...(run.directStyle !== undefined ? { directStyle: { ...run.directStyle } } : {}) })
    offset += run.text.length
  }
  return result
}
function insertSoftBreak() {
  command(active => {
    const [start, end] = orderedSelection(active.selection), next = active.model
    const first = next.paragraphs[start.paragraph]!, last = next.paragraphs[end.paragraph]!
    const left = runSlice(first.runs, 0, start.offset), right = runSlice(last.runs, end.offset, paragraphText(last).length)
    const inherited = start.offset === paragraphText(first).length && first.marker ? paragraphInsertionFormat(first) : left.at(-1) || first.runs[0]!
    first.runs = [...left, { text: '\n', style: { ...inherited.style }, ...(inherited.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: inherited.sourceVerticalAlign } : {}), ...(inherited.sourceColor !== undefined ? { sourceColor: inherited.sourceColor } : {}), ...(inherited.directStyle !== undefined ? { directStyle: { ...inherited.directStyle } } : {}) }, ...right]
    next.paragraphs.splice(start.paragraph, end.paragraph - start.paragraph + 1, first)
    const point = { paragraph: start.paragraph, offset: start.offset + 1 }
    active.setDocument(next, { anchor: point, focus: point })
  })
}
function deleteSelectionOrParagraphBoundary(input: InputEvent): boolean {
  if (!input.inputType.startsWith('delete')) return false
  const selection = current().selection, [start, end] = orderedSelection(selection)
  let range = start.paragraph !== end.paragraph || start.offset !== end.offset ? selection : undefined
  if (!range && start.offset === end.offset) {
    const paragraphs = model.value!.paragraphs
    if (input.inputType === 'deleteContentBackward' && start.offset === 0 && start.paragraph > 0) {
      range = { anchor: { paragraph: start.paragraph - 1, offset: paragraphText(paragraphs[start.paragraph - 1]!).length }, focus: end }
    } else if (input.inputType === 'deleteContentForward' && start.offset === paragraphText(paragraphs[start.paragraph]!).length && start.paragraph + 1 < paragraphs.length) {
      range = { anchor: start, focus: { paragraph: start.paragraph + 1, offset: 0 } }
    }
    if (!range) range = deletionToEmptyParagraph(input, start.paragraph, start.offset)
  }
  if (!range) return false
  // Native selection deletion and paragraph merging can rebuild spans from
  // visible CSS, losing character metadata and background hidden by highlight.
  input.preventDefault()
  const target = range
  safely(() => command(active => active.replaceText(target, '')))
  return true
}
function deletionToEmptyParagraph(input: InputEvent, paragraph: number, offset: number): WordSelection | undefined {
  if (!['deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward', 'deleteSoftLineBackward', 'deleteSoftLineForward', 'deleteHardLineBackward', 'deleteHardLineForward'].includes(input.inputType)) return
  const value = model.value?.paragraphs[paragraph], root = content.value
  if (!value || !root) return
  const text = paragraphText(value)
  if (!text.length) return
  const ranges = input.getTargetRanges?.() ?? []
  if (ranges.length) {
    if (ranges.length !== 1) return
    const target = readWordRange(root, ranges[0]!)
    if (!target) return
    const [start, end] = orderedSelection(target)
    // Only own deletion of the complete paragraph contents. Partial native
    // ranges retain browser-specific word/grapheme deletion behavior.
    if (start.paragraph === paragraph && end.paragraph === paragraph && start.offset === 0 && end.offset === text.length) return target
    return
  }
  // Older WebViews may omit target ranges. Handle only the final complete
  // grapheme at its matching edge, never splitting a surrogate or ZWJ emoji.
  const backward = input.inputType === 'deleteContentBackward' && offset === text.length
  const forward = input.inputType === 'deleteContentForward' && offset === 0
  if (!backward && !forward) return
  let single = text.length === (text.codePointAt(0)! > 0xffff ? 2 : 1)
  if (typeof Intl.Segmenter === 'function') {
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]()
    single = !segments.next().done && !!segments.next().done
  }
  if (single) return { anchor: { paragraph, offset: 0 }, focus: { paragraph, offset: text.length } }
}
function beforeInput(event: Event) {
  const input = event as InputEvent
  if (props.disabled) { event.preventDefault(); return }
  if (input.isComposing || composing.value || compositionPending) return
  rememberSelection()
  const selection = current().selection, [start, end] = orderedSelection(selection)
  const insertionParagraph = current().model.paragraphs[start.paragraph]!
  if (input.inputType === 'insertText' && typeof input.data === 'string'
    && (start.paragraph !== end.paragraph || start.offset !== end.offset || (insertionParagraph.marker && start.offset === paragraphText(insertionParagraph).length))) {
    // Replacing a whole native run drops its metadata, including the separate
    // highlight and background layers. Composition keeps its existing path.
    input.preventDefault()
    const text = input.data
    safely(() => command(active => active.replaceText(selection, text)))
    return
  }
  if (deleteSelectionOrParagraphBoundary(input)) return
  if (input.inputType === 'insertParagraph' || input.inputType === 'insertLineBreak') {
    event.preventDefault(); safely(() => input.inputType === 'insertParagraph' ? insertText('\n') : insertSoftBreak())
  } else if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') {
    event.preventDefault(); safely(() => input.inputType === 'historyUndo' ? undo() : redo())
  } else if (input.inputType.startsWith('format')) event.preventDefault()
}
function keydown(event: KeyboardEvent) {
  if (props.disabled) return
  if (event.isComposing || composing.value || event.keyCode === 229) return
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  const key = event.key.toLowerCase()
  if (['z', 'y', 'b', 'i', 'u'].includes(key)) {
    event.preventDefault()
    safely(() => key === 'z' ? (event.shiftKey ? redo() : undo()) : key === 'y' ? redo() : key === 'u' ? toggleUnderline() : toggle(key === 'b' ? 'bold' : 'italic'))
  }
}
function copyFormattedText(event: ClipboardEvent, cut = false) {
  if (!content.value || !controller.value || loading.value || disposed || !event.clipboardData) return
  if (cut && props.disabled) { event.preventDefault(); return }
  if (composing.value || compositionPending) return
  commitInput(); rememberSelection()
  const active = current(), selection = readWordSelection(content.value)
  if (!selection) return
  const [start, end] = orderedSelection(selection)
  if (start.paragraph === end.paragraph && start.offset === end.offset) return
  const fragment = active.model
  fragment.paragraphs = fragment.paragraphs.slice(start.paragraph, end.paragraph + 1).map((paragraph, index) => {
    const runs = runSlice(paragraph.runs, index === 0 ? start.offset : 0,
      index === end.paragraph - start.paragraph ? end.offset : paragraphText(paragraph).length)
    return { ...paragraph, runs: runs.length ? runs : [{ ...paragraph.runs[0]!, text: '' }] }
  })
  const copiedParagraphs = start.paragraph !== end.paragraph && end.offset === 0 ? fragment.paragraphs.slice(0, -1) : fragment.paragraphs
  if (!copiedParagraphs.some(paragraph => paragraph.style.lineHeightRule === 'exact' || paragraph.runs.some(run => {
    const style = run.style
    return run.text && (style.color === 'auto' || style.caseMap === 'upper' || style.caseMap === 'smallCaps'
      || typeof style.verticalAlign === 'number' || style.underlineColor !== undefined || style.underline === 'double' || style.strike === 'double'
      || (style.underline && style.strike && style.strike !== 'none'))
  }))) return
  // The browser's default clipboard can transform case text and collapse
  // separately colored or double decorations into a single line style.
  // Exact line-height preview uses editor-only line boxes; clipboard output
  // must retain ordinary point line-height without those visual offsets.
  // Automatic text color is semantic inside DOCX; external HTML receives its
  // actual paint, without the editor metadata used to preserve that semantic.
  // Copy logical text and render its model slice to preserve independent
  // decorations and full run formatting, including partial text-node ranges.
  event.preventDefault()
  const text = documentText(fragment)
  // Ending at the next paragraph's offset zero selects the separator, not
  // that paragraph's text or insertion formatting. Plaintext retains the
  // separator; rich HTML already has a block boundary and must not attach
  // the unselected paragraph's marker/style as an extra empty block.
  if (start.paragraph !== end.paragraph && end.offset === 0) fragment.paragraphs.pop()
  else delete fragment.paragraphs.at(-1)!.marker
  const html = document.createElement('div')
  renderWordDom(html, fragment, { forClipboard: true })
  // Editor placeholders have zero logical length. In a nonempty paragraph
  // they must not turn into an additional HTML line break on rich paste.
  for (const placeholder of html.querySelectorAll('br[data-word-placeholder]')) {
    if (placeholder.closest('p')?.textContent) placeholder.remove()
  }
  for (const element of html.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) if (attribute.name.startsWith('data-word-') || attribute.name === 'data-heading') element.removeAttribute(attribute.name)
  }
  event.clipboardData.setData('text/plain', text)
  event.clipboardData.setData('text/html', html.innerHTML)
  if (cut) command(editor => editor.replaceText(selection, ''))
}
function paste(event: ClipboardEvent) {
  event.preventDefault()
  if (unavailable.value) return
  const text = event.clipboardData?.getData('text/plain')
  if (text !== undefined) safely(() => insertText(text))
}
function drop(event: DragEvent) {
  event.preventDefault()
  if (unavailable.value || event.dataTransfer?.files.length) return
  const text = event.dataTransfer?.getData('text/plain')
  if (text) safely(() => insertText(text))
}
async function flushInput() {
  if (composing.value) { content.value?.blur(); await nextTick() }
  if (composing.value) throw Error('请先确认输入法中的文字，再保存文稿。')
  if (compositionPending) await nextTick()
  commitInput()
}
async function exportFile(options: { format?: Extension } = {}): Promise<EditorExport & { revision: number }> {
  await opening; await flushInput()
  if (options.format && options.format !== 'docx') throw Error('此文字编辑器目前支持保存 DOCX 文稿。')
  const active = current(), token = generation, revision = active.revision
  const snapshot = active.model, bytes = await exportWordDocument(snapshot)
  if (disposed || generation !== token || active.revision !== revision) throw Error('导出期间文稿已变化，请重新保存。')
  savedExport = { generation: token, revision, snapshot }
  return { base64: bytesToBase64(bytes), extension: 'docx', name: props.document.name.replace(/\.[^.]+$/, '') + '.docx', revision, dirty: active.dirty }
}
async function markSaved() {
  if (savedExport?.generation !== generation) return
  current().markSaved(savedExport.revision, savedExport.snapshot); refresh()
}
async function discardChanges(options: { force?: boolean } = {}) {
  await opening
  if (options.force) return
  await flushInput()
  if (savedExport?.generation !== generation || savedExport.revision !== current().revision) throw Error('导出后文稿又有修改，请先保存当前内容，再切换文稿。')
}
async function undo() {
  await opening
  if (!controller.value || loading.value || composing.value) return
  await flushInput(); current().undo(); problem.value = ''; refresh(); render(true)
}
async function redo() {
  await opening
  if (!controller.value || loading.value || composing.value) return
  await flushInput(); current().redo(); problem.value = ''; refresh(); render(true)
}
async function load() {
  closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu()
  const token = ++generation
  const source = { ...props.document }
  const isCurrent = () => !disposed && generation === token && props.document.id === source.id && props.document.base64 === source.base64
  loading.value = true; problem.value = ''; notice.value = ''; composing.value = false; compositionPending = false; compositionInsertion = undefined
  savedExport = undefined; controller.value = undefined
  try {
    if (source.extension !== 'docx') { props.prepared?.discard(); throw Error('此文字编辑器目前支持 DOCX，请先将文稿转换为 DOCX。') }
    const value = props.prepared?.take(source) ?? (source.base64 ? await importWordDocument(base64ToBytes(source.base64)) : createWordDocument())
    if (!isCurrent()) return
    controller.value = new WordController(value); loading.value = false; refresh()
    await nextTick()
    if (!isCurrent()) return
    render(); readyGeneration = token; emit('status', '文字文稿已就绪 · 正文编辑'); emit('ready')
  } catch (cause) { if (isCurrent()) { loading.value = false; report(cause) } }
}
watch(() => [props.document.id, props.document.base64] as const, ([id], previous) => {
  // A loaded editor owns its live model, including same-id saved snapshots.
  // Only an unfinished import must restart when its source bytes change.
  if (!previous || id !== previous[0] || !controller.value || readyGeneration !== generation) opening = load()
}, { immediate: true })
watch(() => props.active && !props.disabled, value => { if (!value) { closeIndentPanel(); closeParagraphSpacingPanel(); closePageSettings(); closeUnderlineMenu(); closeColorMenu(); closeStrikeMenu(); closeHighlightMenu(); closeBackgroundMenu(); closeLetterSpacingMenu(); closeCaseMenu(); closePositionMenu() } })
onMounted(() => { document.addEventListener('selectionchange', rememberSelection); document.addEventListener('pointerdown', outsideCharacterMenus); window.addEventListener('resize', resizeCharacterMenus); document.fonts?.addEventListener('loadingdone', loadedFonts) })
onBeforeUnmount(() => { disposed = true; generation++; props.prepared?.discard(); document.removeEventListener('selectionchange', rememberSelection); document.removeEventListener('pointerdown', outsideCharacterMenus); window.removeEventListener('resize', resizeCharacterMenus); document.fonts?.removeEventListener('loadingdone', loadedFonts) })
defineExpose({ exportFile, markSaved, discardChanges, undo, redo, focus: () => content.value?.focus() })
</script>

<template>
  <section class="standalone-word-editor" data-testid="standalone-word-editor" :data-ready="!!controller && !loading" :aria-busy="loading">
    <div class="word-toolbar" role="toolbar" aria-label="文字与段落格式" @pointerdown="rememberSelection">
      <div class="word-toolbar-group">
        <button type="button" data-testid="word-undo" title="撤销（Ctrl / ⌘ Z）" aria-label="撤销" :disabled="unavailable || !canUndo" @mousedown.prevent @click="safely(undo)">↶</button>
        <button type="button" data-testid="word-redo" title="重做（Ctrl / ⌘ Shift Z）" aria-label="重做" :disabled="unavailable || !canRedo" @mousedown.prevent @click="safely(redo)">↷</button>
      </div>
      <div class="word-toolbar-group">
        <label class="word-select-label">段落
          <select data-testid="word-heading" aria-label="段落样式" :value="selectionParagraph?.style.heading || 0" :disabled="unavailable" @change="safely(() => changeHeading($event))">
            <option :value="0">正文</option><option :value="1">标题 1</option><option :value="2">标题 2</option><option :value="3">标题 3</option>
          </select>
        </label>
        <label class="word-select-label">字号
          <select data-testid="word-font-size" aria-label="字号" :value="fontSize" :disabled="unavailable" @change="safely(() => changeSize($event))">
            <option v-if="!fontSize" value="">混合</option>
            <option v-if="fontSize && ![8,9,10,11,12,14,16,18,20,24,28,32,36,48,72].includes(Number(fontSize))" :value="fontSize">{{ fontSize }}</option>
            <option v-for="size in [8,9,10,11,12,14,16,18,20,24,28,32,36,48,72]" :key="size" :value="String(size)">{{ size }}</option>
          </select>
        </label>
      </div>
      <div class="word-toolbar-group">
        <button type="button" class="word-bold" data-testid="word-bold" aria-label="加粗" title="选中文字后加粗（Ctrl / ⌘ B）" :aria-pressed="marked('bold')" :disabled="unavailable" @mousedown.prevent @click="safely(() => toggle('bold'))">B</button>
        <button type="button" class="word-italic" data-testid="word-italic" aria-label="斜体" title="选中文字后设为斜体（Ctrl / ⌘ I）" :aria-pressed="marked('italic')" :disabled="unavailable" @mousedown.prevent @click="safely(() => toggle('italic'))">I</button>
        <div ref="underlineControl" class="word-underline-control">
          <button type="button" class="word-underline" :class="{ 'word-underline-double': underlineSelection === 'double' }" :style="{ textDecorationColor: underlineColorSelection.startsWith('#') ? underlineColorSelection : undefined }" data-testid="word-underline" aria-label="下划线" :title="underlineSelection === 'double' ? '当前为双下划线；点击取消下划线（Ctrl / ⌘ U）' : '选中文字后添加下划线；再次点击取消（Ctrl / ⌘ U）'" :aria-pressed="underlinePressed" :disabled="unavailable" @mousedown.prevent @click="safely(toggleUnderline)">U</button>
          <button type="button" class="word-underline-menu-toggle" data-testid="word-underline-menu-toggle" :data-underline-color="underlineColorSelection" aria-label="选择下划线样式与颜色" :title="`下划线样式与颜色；当前颜色：${underlineColorLabel}`" aria-haspopup="dialog" :aria-expanded="underlineMenuOpen" :aria-controls="underlineMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleUnderlineMenu)" @keydown.down.prevent="safely(toggleUnderlineMenu)" @keydown.up.prevent="safely(toggleUnderlineMenu)"><span aria-hidden="true">▾</span></button>
          <form v-if="underlineMenuOpen" :id="underlineMenuId" ref="underlineMenu" class="word-underline-menu" data-testid="word-underline-menu" :style="underlineMenuStyle" role="dialog" aria-label="下划线样式与颜色" @submit.prevent="safely(applyUnderlineColor)" @keydown="underlineMenuKeydown" @focusout="underlineMenuFocusout">
            <div class="word-underline-scroll">
            <div role="menu" aria-label="下划线样式">
              <button v-for="choice in underlineChoices" :key="choice.name" type="button" role="menuitemradio" :data-testid="`word-underline-${choice.name}`" :aria-checked="underlineSelection === choice.name" :disabled="unavailable" @mousedown.prevent @click="safely(() => chooseUnderline(choice.value))"><span class="word-underline-choice-mark" aria-hidden="true">{{ underlineSelection === choice.name ? '✓' : '' }}</span><span>{{ choice.label }}</span><span v-if="choice.name !== 'none'" class="word-underline-preview" :class="{ 'word-underline-double': choice.name === 'double' }" :style="{ textDecorationColor: underlineColorSelection.startsWith('#') ? underlineColorSelection : undefined }" aria-hidden="true">Ab</span></button>
            </div>
            <fieldset class="word-underline-color-fieldset" :disabled="unavailable" :aria-describedby="`${underlineMenuId}-color-help`">
              <legend>下划线颜色 <span data-testid="word-underline-color-status">{{ underlineColorLabel }}</span></legend>
              <div class="word-underline-color-options"><label><input type="radio" data-testid="word-underline-color-auto" :name="`${underlineMenuId}-color`" value="auto" :checked="underlineColorMode === 'auto'" @change="underlineColorMode = 'auto'; underlineColorTouched = true">跟随文字</label><label><input type="radio" data-testid="word-underline-color-custom" :name="`${underlineMenuId}-color`" value="custom" :checked="underlineColorMode === 'custom'" @change="underlineColorMode = 'custom'; underlineColorTouched = true">自定义</label></div>
              <label class="word-underline-color-picker"><span>自定义颜色</span><input type="color" data-testid="word-underline-color-input" aria-label="自定义下划线颜色" :value="underlineColorDraft" @input="safely(() => editUnderlineColor($event))" @change="safely(() => editUnderlineColor($event))"><output>{{ underlineColorDraft }}</output></label>
              <p :id="`${underlineMenuId}-color-help`" class="word-underline-color-help">仅设置线条颜色，保留当前样式；混合值未修改时保留原值。</p>
            </fieldset>
            </div>
            <div class="word-underline-color-actions"><button type="submit" class="word-underline-color-apply" data-testid="word-underline-color-apply" :disabled="unavailable" @mousedown.prevent>应用颜色</button><button type="button" data-testid="word-underline-color-cancel" @mousedown.prevent @click="closeUnderlineMenu(true)">取消</button></div>
          </form>
        </div>
      </div>
      <div class="word-toolbar-group" role="group" aria-label="文字颜色、高亮与背景色">
        <div ref="colorControl" class="word-background-control">
          <label class="word-color-label" :title="`文字颜色：${colorLabel}；选择色块设置固定颜色`"><input data-testid="word-color" type="color" aria-label="文字颜色" :value="color" :disabled="unavailable" @change="safely(() => changeColor($event))"></label>
          <button type="button" class="word-background-toggle" data-testid="word-color-menu-toggle" :data-color="colorSelection" :aria-label="`文字颜色：${colorLabel}`" :title="`文字颜色：${colorLabel}；选择自动或自定义颜色`" aria-haspopup="dialog" :aria-expanded="colorMenuOpen" :aria-controls="colorMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleColorMenu)" @keydown.down.prevent="safely(toggleColorMenu)"><span>{{ colorSelection === 'mixed' ? '文字颜色·混合' : colorSelection === 'auto' ? '文字颜色·自动' : '文字颜色' }}</span><span class="word-highlight-arrow" aria-hidden="true">▾</span></button>
          <form v-if="colorMenuOpen" :id="colorMenuId" ref="colorMenu" class="word-background-menu" data-testid="word-color-menu" :style="colorMenuStyle" role="dialog" aria-label="文字颜色设置" :aria-describedby="`${colorMenuId}-help`" @submit.prevent="safely(applyColor)" @keydown.esc.prevent.stop="closeColorMenu(true)" @focusout="colorMenuFocusout">
            <p class="word-background-caption" data-testid="word-color-status">当前：{{ colorLabel }}</p>
            <fieldset class="word-kerning-fieldset" :disabled="unavailable">
              <legend>文字颜色</legend>
              <div class="word-underline-color-options"><label><input type="radio" data-testid="word-color-auto" :name="`${colorMenuId}-mode`" value="auto" :checked="colorMode === 'auto'" @change="colorMode = 'auto'; colorTouched = true">自动</label><label><input type="radio" data-testid="word-color-custom" :name="`${colorMenuId}-mode`" value="custom" :checked="colorMode === 'custom'" @change="colorMode = 'custom'; colorTouched = true">自定义</label></div>
              <label class="word-underline-color-picker"><span>自定义颜色</span><input type="color" data-testid="word-color-input" aria-label="自定义文字颜色" :value="colorDraft" @input="safely(() => editColor($event))" @change="safely(() => editColor($event))"><output>{{ colorDraft }}</output></label>
            </fieldset>
            <p :id="`${colorMenuId}-help`" class="word-underline-color-help">自动颜色根据文字背景显示黑色或白色，高亮不参与自动颜色判断。混合值未修改时保留原值。</p>
            <div class="word-background-actions"><button type="submit" class="word-background-apply" data-testid="word-color-apply" :disabled="unavailable" @mousedown.prevent>应用颜色</button><button type="button" data-testid="word-color-cancel" @mousedown.prevent @click="closeColorMenu(true)">取消</button></div>
          </form>
        </div>
        <div ref="highlightControl" class="word-highlight-control">
          <button type="button" class="word-highlight-toggle" data-testid="word-highlight-menu-toggle" :data-highlight="highlightSelection" :aria-label="`文字高亮：${highlightLabel}`" :title="`文字高亮：${highlightLabel}；选中文字后选择颜色`" aria-haspopup="menu" :aria-expanded="highlightMenuOpen" :aria-controls="highlightMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleHighlightMenu)" @keydown.down.prevent="safely(toggleHighlightMenu)"><span class="word-highlight-swatch" :class="{ 'word-highlight-none': highlightSelection === 'none', 'word-highlight-mixed': highlightSelection === 'mixed' }" :style="{ backgroundColor: selectedHighlight?.hex }" aria-hidden="true"/><span>{{ highlightSelection === 'mixed' ? '高亮·混合' : '高亮' }}</span><span class="word-highlight-arrow" aria-hidden="true">▾</span></button>
          <div v-if="highlightMenuOpen" :id="highlightMenuId" ref="highlightMenu" class="word-highlight-menu" data-testid="word-highlight-menu" :style="highlightMenuStyle" role="menu" aria-label="文字高亮颜色" @keydown="highlightMenuKeydown">
            <p class="word-highlight-caption">当前：{{ highlightLabel }}</p>
            <div class="word-highlight-palette" role="presentation">
              <button v-for="choice in highlightChoices" :key="choice.value" type="button" class="word-highlight-option" role="menuitemradio" :data-testid="`word-highlight-${choice.value}`" :data-color="choice.value" :aria-checked="highlightSelection === choice.value" :disabled="unavailable" @mousedown.prevent @click="safely(() => chooseHighlight(choice.value))"><span class="word-highlight-swatch" :class="{ 'word-highlight-none': choice.value === 'none' }" :style="{ backgroundColor: choice.hex }" aria-hidden="true"/><span>{{ choice.label }}</span><span class="word-highlight-check" aria-hidden="true">{{ highlightSelection === choice.value ? '✓' : '' }}</span></button>
            </div>
          </div>
        </div>
        <div ref="backgroundControl" class="word-background-control">
          <button type="button" class="word-background-toggle" data-testid="word-background-menu-toggle" :data-background="backgroundSelection" :aria-label="`文字背景色：${backgroundLabel}`" :title="`文字背景色：${backgroundLabel}；选中文字后设置`" aria-haspopup="dialog" :aria-expanded="backgroundMenuOpen" :aria-controls="backgroundMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleBackgroundMenu)" @keydown.down.prevent="safely(toggleBackgroundMenu)"><span class="word-highlight-swatch" :class="{ 'word-highlight-none': backgroundSelection === 'none', 'word-highlight-mixed': backgroundSelection === 'mixed' }" :style="{ backgroundColor: backgroundSelection.startsWith('#') ? backgroundSelection : undefined }" aria-hidden="true"/><span>{{ backgroundSelection === 'mixed' ? '背景色·混合' : '背景色' }}</span><span class="word-highlight-arrow" aria-hidden="true">▾</span></button>
          <form v-if="backgroundMenuOpen" :id="backgroundMenuId" ref="backgroundMenu" class="word-background-menu" data-testid="word-background-menu" :style="backgroundMenuStyle" role="dialog" aria-label="文字背景色" :aria-describedby="`${backgroundMenuId}-help`" @submit.prevent="safely(() => applyBackground())" @keydown="backgroundMenuKeydown" @focusout="backgroundMenuFocusout">
            <p class="word-background-caption">当前：{{ backgroundLabel }}</p>
            <label class="word-background-custom"><span>自定义颜色</span><input type="color" data-testid="word-background-color" aria-label="自定义背景色" :value="backgroundDraft" :disabled="unavailable" @input="editBackground" @change="editBackground"><output>{{ backgroundDraft }}</output></label>
            <button type="button" class="word-background-clear" data-testid="word-background-none" :disabled="unavailable" @mousedown.prevent @click="safely(() => applyBackground('none'))"><span class="word-highlight-swatch word-highlight-none" aria-hidden="true"/>无背景色</button>
            <p :id="`${backgroundMenuId}-help`" class="word-background-help">选择颜色后点击应用。</p>
            <div class="word-background-actions"><button type="submit" class="word-background-apply" data-testid="word-background-apply" :disabled="unavailable" @mousedown.prevent>应用背景色</button><button type="button" data-testid="word-background-cancel" @mousedown.prevent @click="closeBackgroundMenu(true)">取消</button></div>
          </form>
        </div>
      </div>
      <div class="word-toolbar-group" role="group" aria-label="大小写、字符间距、上下标与删除线">
        <div ref="caseControl" class="word-case-control">
          <button type="button" class="word-case-toggle" data-testid="word-case-menu-toggle" :data-case="caseSelection" :aria-label="`大小写显示：${caseLabel}`" :title="`大小写显示：${caseLabel}；保留原文`" aria-haspopup="menu" :aria-expanded="caseMenuOpen" :aria-controls="caseMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleCaseMenu)" @keydown.down.prevent="safely(toggleCaseMenu)"><span aria-hidden="true" class="word-case-icon">Aa</span><span>{{ caseSelection === 'mixed' ? '混合' : caseSelection === 'none' ? '大小写' : caseLabel }}</span><span class="word-highlight-arrow" aria-hidden="true">▾</span></button>
          <div v-if="caseMenuOpen" :id="caseMenuId" ref="caseMenu" class="word-case-menu" data-testid="word-case-menu" :style="caseMenuStyle" role="menu" aria-label="大小写显示" :aria-describedby="`${caseMenuId}-help`" @keydown="caseMenuKeydown" @focusout="caseMenuFocusout">
            <button v-for="choice in caseChoices" :key="choice.value" type="button" role="menuitemradio" :data-testid="`word-case-${choice.value}`" :aria-checked="caseSelection === choice.value" :disabled="unavailable" @mousedown.prevent @click="safely(() => chooseCase(choice.value))"><span class="word-case-check" aria-hidden="true">{{ caseSelection === choice.value ? '✓' : '' }}</span><span>{{ choice.label }}</span><span class="word-case-preview" :class="`word-case-${choice.value}`" aria-hidden="true">Abc</span></button>
            <p :id="`${caseMenuId}-help`" class="word-case-help">仅调整显示，保留原文。</p>
          </div>
        </div>
        <div ref="letterSpacingControl" class="word-letter-spacing-control">
          <button type="button" class="word-letter-spacing-toggle" data-testid="word-letter-spacing-toggle" :data-spacing="letterSpacingSelection" :data-kerning="kerningSelection" :aria-label="`字符间距与字偶距：${letterSpacingLabel}；字偶距${kerningSelection === 'mixed' ? '混合' : kerningSelection === 'on' ? '启用' : '关闭'}`" :title="`字符间距：${letterSpacingLabel}；字偶距：${kerningSelection === 'mixed' ? '混合' : kerningSelection === 'on' ? '启用' : '关闭'}`" aria-haspopup="dialog" :aria-expanded="letterSpacingMenuOpen" :aria-controls="letterSpacingMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleLetterSpacingMenu)" @keydown.down.prevent="safely(toggleLetterSpacingMenu)"><span aria-hidden="true" class="word-letter-spacing-icon">A↔</span><span>{{ letterSpacingSelection === 'mixed' ? '字距·混合' : letterSpacingSelection === 0 ? '字距' : letterSpacingLabel }}</span><span class="word-highlight-arrow" aria-hidden="true">▾</span></button>
          <form v-if="letterSpacingMenuOpen" :id="letterSpacingMenuId" ref="letterSpacingMenu" class="word-letter-spacing-menu" data-testid="word-letter-spacing-menu" :style="letterSpacingMenuStyle" role="dialog" aria-label="字符间距与字偶距" :aria-describedby="`${letterSpacingMenuId}-help`" novalidate @submit.prevent="safely(() => applyLetterSpacing())" @keydown.esc.prevent.stop="closeLetterSpacingMenu(true)" @focusout="letterSpacingMenuFocusout">
            <p class="word-letter-spacing-caption">当前：{{ letterSpacingLabel }}</p>
            <label class="word-letter-spacing-field"><span>字符间距 <small>（磅）</small></span><input type="number" data-testid="word-letter-spacing-input" aria-label="字符间距（磅）" :min="LETTER_SPACING_LIMITS.min" :max="LETTER_SPACING_LIMITS.max" :step="LETTER_SPACING_LIMITS.step" :value="letterSpacingDraft" :placeholder="letterSpacingSelection === 'mixed' ? '混合' : '0'" :aria-invalid="!!letterSpacingError" :aria-describedby="`${letterSpacingMenuId}-help${letterSpacingError ? ` ${letterSpacingMenuId}-error` : ''}`" :disabled="unavailable" @input="editLetterSpacing"></label>
            <button type="button" class="word-letter-spacing-normal" data-testid="word-letter-spacing-normal" :disabled="unavailable" @mousedown.prevent @click="safely(() => applyLetterSpacing(true))">恢复常规（0 磅）</button>
            <p :id="`${letterSpacingMenuId}-help`" class="word-letter-spacing-help">正值加宽，负值紧缩；每次 {{ LETTER_SPACING_LIMITS.step }} 磅。混合值未修改时保留原值。</p>
            <fieldset class="word-kerning-fieldset" :disabled="unavailable" :aria-describedby="`${letterSpacingMenuId}-kerning-help`">
              <legend>字偶距 <span data-testid="word-kerning-status" :data-kerning="kerningDraft">{{ kerningDraft === 'mixed' ? '混合 · 未修改' : kerningDraft === 'on' ? '启用' : '关闭' }}</span></legend>
              <div class="word-kerning-options">
                <label><input type="radio" data-testid="word-kerning-off" :name="`${letterSpacingMenuId}-kerning`" value="off" :checked="kerningDraft === 'off'" @change="kerningDraft = 'off'; kerningTouched = true"><span>关闭</span></label>
                <label><input type="radio" data-testid="word-kerning-on" :name="`${letterSpacingMenuId}-kerning`" value="on" :checked="kerningDraft === 'on'" @change="kerningDraft = 'on'; kerningTouched = true"><span>启用</span></label>
              </div>
              <p :id="`${letterSpacingMenuId}-kerning-help`" class="word-kerning-help">按字体调整 AV 等字偶的间距，与字符间距分别设置。</p>
            </fieldset>
            <p v-if="letterSpacingError" :id="`${letterSpacingMenuId}-error`" class="word-letter-spacing-error" role="alert">{{ letterSpacingError }}</p>
            <div class="word-letter-spacing-actions"><button type="submit" class="word-letter-spacing-apply" data-testid="word-letter-spacing-apply" :disabled="unavailable" @mousedown.prevent>应用</button><button type="button" data-testid="word-letter-spacing-cancel" @mousedown.prevent @click="closeLetterSpacingMenu(true)">取消</button></div>
          </form>
        </div>
        <button type="button" class="word-script-toggle" data-testid="word-superscript" aria-label="上标" title="选中文字后设置上标；再次点击恢复基线" :aria-pressed="verticalPressed('superscript')" :disabled="unavailable" @mousedown.prevent @click="safely(() => toggleVertical('superscript'))"><span aria-hidden="true">x<sup>2</sup></span></button>
        <button type="button" class="word-script-toggle" data-testid="word-subscript" aria-label="下标" title="选中文字后设置下标；再次点击恢复基线" :aria-pressed="verticalPressed('subscript')" :disabled="unavailable" @mousedown.prevent @click="safely(() => toggleVertical('subscript'))"><span aria-hidden="true">x<sub>2</sub></span></button>
        <div ref="positionControl" class="word-position-control">
          <button type="button" class="word-position-toggle" data-testid="word-position-toggle" :data-position="positionSelection" :aria-label="`文字位置：${positionLabel}`" :title="`文字位置：${positionLabel}；调整上移或下移比例`" aria-haspopup="dialog" :aria-expanded="positionMenuOpen" :aria-controls="positionMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(togglePositionMenu)" @keydown.down.prevent="safely(togglePositionMenu)"><span class="word-position-icon" aria-hidden="true">A↕</span><span>{{ typeof positionSelection === 'number' ? positionLabel : positionSelection === 'mixed' ? '位置·混合' : '位置' }}</span><span class="word-highlight-arrow" aria-hidden="true">▾</span></button>
          <form v-if="positionMenuOpen" :id="positionMenuId" ref="positionMenu" class="word-position-menu" data-testid="word-position-menu" :style="positionMenuStyle" role="dialog" aria-label="文字位置" :aria-describedby="`${positionMenuId}-help`" novalidate @submit.prevent="safely(() => applyPosition())" @keydown.esc.prevent.stop="closePositionMenu(true)" @focusout="positionMenuFocusout">
            <div class="word-position-scroll">
              <p class="word-position-caption">当前：{{ positionLabel }}</p>
              <label class="word-position-field"><span>基线偏移 <small>（字体高度 %）</small></span><input type="number" data-testid="word-position-input" aria-label="基线偏移（字体高度 %）" :min="BASELINE_OFFSET_LIMITS.min" :max="BASELINE_OFFSET_LIMITS.max" :step="BASELINE_OFFSET_LIMITS.step" :value="positionDraft" :placeholder="positionSelection === 'mixed' ? '混合' : positionSelection === 'superscript' ? '上标' : positionSelection === 'subscript' ? '下标' : '0'" :aria-invalid="!!positionError" :aria-describedby="`${positionMenuId}-help${positionError ? ` ${positionMenuId}-error` : ''}`" :disabled="unavailable" @input="editPosition"></label>
              <button type="button" class="word-position-normal" data-testid="word-position-normal" :disabled="unavailable" @mousedown.prevent @click="safely(() => applyPosition(true))">恢复正常位置（0%）</button>
              <p :id="`${positionMenuId}-help`" class="word-position-help">正值上移，负值下移，保留字号。DOCX 保存按半磅取整；空段尚未输入文字时，重新打开后不会保留偏移。混合值未修改时保留原值。</p>
              <p v-if="positionError" :id="`${positionMenuId}-error`" class="word-position-error" role="alert">{{ positionError }}</p>
            </div>
            <div class="word-position-actions"><button type="submit" class="word-position-apply" data-testid="word-position-apply" :disabled="unavailable" @mousedown.prevent>应用</button><button type="button" data-testid="word-position-cancel" @mousedown.prevent @click="closePositionMenu(true)">取消</button></div>
          </form>
        </div>
        <div ref="strikeControl" class="word-strike-control">
          <button type="button" class="word-strike" :class="{ 'word-strike-double': strikeSelection === 'double' }" data-testid="word-strike" aria-label="删除线" :title="strikeSelection === 'double' ? '当前为双删除线；点击取消删除线' : '选中文字后设置删除线；再次点击取消'" :aria-pressed="strikePressed" :disabled="unavailable" @mousedown.prevent @click="safely(toggleStrike)"><span aria-hidden="true">S</span></button>
          <button type="button" class="word-strike-menu-toggle" data-testid="word-strike-menu-toggle" aria-label="选择删除线样式" title="选择单删除线、双删除线或无删除线" aria-haspopup="menu" :aria-expanded="strikeMenuOpen" :aria-controls="strikeMenuId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleStrikeMenu)" @keydown.down.prevent="safely(toggleStrikeMenu)"><span aria-hidden="true">▾</span></button>
          <div v-if="strikeMenuOpen" :id="strikeMenuId" ref="strikeMenu" class="word-strike-menu" role="menu" aria-label="删除线样式" @keydown="strikeMenuKeydown">
            <button v-for="choice in strikeChoices" :key="choice.value" type="button" role="menuitemradio" :data-testid="`word-strike-${choice.value}`" :aria-checked="strikeSelection === choice.value" :disabled="unavailable" @mousedown.prevent @click="safely(() => chooseStrike(choice.value))"><span class="word-strike-choice-mark" aria-hidden="true">{{ strikeSelection === choice.value ? '✓' : '' }}</span><span>{{ choice.label }}</span><span v-if="choice.value !== 'none'" class="word-strike-preview" :class="{ 'word-strike-double': choice.value === 'double' }" aria-hidden="true">Ab</span></button>
          </div>
        </div>
      </div>
      <div class="word-toolbar-group word-paragraph-spacing-toolbar">
        <label class="word-select-label">对齐
          <select data-testid="word-align" aria-label="段落对齐" :value="selectionParagraph?.style.align || 'left'" :disabled="unavailable" @change="safely(() => changeAlign($event))">
            <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option>
          </select>
        </label>
        <button type="button" class="word-indent-toggle" data-testid="word-indent-toggle" :aria-expanded="indentOpen" :aria-controls="indentPanelId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleIndentPanel)">段落缩进</button>
        <button type="button" class="word-paragraph-spacing-toggle" data-testid="word-paragraph-spacing-toggle" :aria-expanded="paragraphSpacingOpen" :aria-controls="paragraphSpacingPanelId" :disabled="unavailable" @mousedown.prevent @click="safely(toggleParagraphSpacingPanel)" @keydown.down.prevent="safely(toggleParagraphSpacingPanel)">段落间距</button>
      </div>
      <div class="word-toolbar-group word-page-settings-toolbar">
        <button type="button" class="word-page-settings-toggle" data-testid="word-page-settings-toggle" aria-haspopup="dialog" :aria-expanded="pageSettingsOpen" :aria-controls="pageSettingsId" :disabled="unavailable" @mousedown.prevent @click="safely(togglePageSettings)" @keydown.down.prevent="safely(togglePageSettings)">页面设置</button>
      </div>
    </div>
    <form v-if="indentOpen" :id="indentPanelId" ref="indentPanel" class="word-indent-panel" data-testid="word-indent-panel" aria-label="段落缩进" :aria-describedby="`${indentPanelId}-help`" novalidate @submit.prevent="safely(applyIndent)" @keydown.esc.prevent.stop="closeIndentPanel(true)">
      <div class="word-indent-fields">
        <label v-for="field in indentFields" :key="field.key" class="word-indent-field">
          <span>{{ field.label }} <small>（磅）</small></span>
          <input :data-testid="field.testId" type="number" min="-1584" max="1584" step="0.05" :aria-label="`${field.label}（磅）`" :aria-describedby="`${indentPanelId}-help${indentError ? ` ${indentPanelId}-error` : ''}`" :aria-invalid="!!indentError" :value="indentDraft[field.key]" :placeholder="indentMixed[field.key] ? '混合' : '0'" :disabled="unavailable" @input="editIndent(field.key, $event)">
        </label>
        <div class="word-indent-actions">
          <button type="submit" class="word-indent-apply" data-testid="word-indent-apply" :disabled="unavailable">应用</button>
          <button type="button" data-testid="word-indent-cancel" @click="closeIndentPanel(true)">取消</button>
        </div>
      </div>
      <p :id="`${indentPanelId}-help`" class="word-indent-help">首行填负值可设置悬挂缩进；混合值未修改时保留各段原值。单位为磅（pt），1 磅约 0.35 毫米。</p>
      <p v-if="indentError" :id="`${indentPanelId}-error`" class="word-indent-error" role="alert">{{ indentError }}</p>
    </form>
    <form v-if="paragraphSpacingOpen" :id="paragraphSpacingPanelId" ref="paragraphSpacingPanel" class="word-paragraph-spacing-panel" :class="{ 'word-paragraph-spacing-overlay': paragraphSpacingOverlay }" :style="paragraphSpacingPanelStyle" data-testid="word-paragraph-spacing-panel" :role="paragraphSpacingOverlay ? 'dialog' : undefined" aria-label="段落间距" :aria-describedby="`${paragraphSpacingPanelId}-help`" novalidate @submit.prevent="safely(applyParagraphSpacing)" @keydown.esc.prevent.stop="closeParagraphSpacingPanel(true)" @focusout="paragraphSpacingFocusout">
      <h3 class="word-paragraph-spacing-title">段落间距</h3>
      <div class="word-paragraph-spacing-fields">
        <div class="word-paragraph-spacing-margins">
          <label v-for="field in paragraphSpacingFields" :key="field.key" class="word-paragraph-spacing-field">
            <span>{{ field.label }} <small>（磅）</small></span>
            <input :data-testid="field.testId" type="number" :min="PARAGRAPH_SPACING_LIMITS.min" :max="PARAGRAPH_SPACING_LIMITS.max" :step="PARAGRAPH_SPACING_LIMITS.step" :aria-label="`${field.label}间距（磅）`" :aria-describedby="`${paragraphSpacingPanelId}-help${paragraphSpacingError ? ` ${paragraphSpacingPanelId}-error` : ''}`" :aria-invalid="!!paragraphSpacingError" :value="paragraphSpacingDraft[field.key]" :placeholder="paragraphSpacingMixed[field.key] ? '混合' : '文稿默认'" :disabled="unavailable" @input="editParagraphSpacing(field.key, $event)">
          </label>
        </div>
        <fieldset class="word-paragraph-spacing-line" :disabled="unavailable">
          <legend>行距 <span v-if="paragraphLineMixed && !paragraphLineTouched">混合</span><span v-else-if="!paragraphLineRule">文稿默认</span></legend>
          <div class="word-paragraph-spacing-line-fields">
            <div class="word-paragraph-spacing-options">
              <label v-for="choice in paragraphLineChoices" :key="choice.value">
                <input type="radio" :data-testid="`word-paragraph-spacing-rule-${choice.value}`" :name="`${paragraphSpacingPanelId}-line-rule`" :value="choice.value" :checked="paragraphLineRule === choice.value" @change="chooseParagraphLineRule(choice.value)">
                <span>{{ choice.label }}<small>{{ choice.hint }}</small></span>
              </label>
            </div>
            <label class="word-paragraph-spacing-field word-paragraph-spacing-line-value">
              <span>{{ paragraphLineRule === 'auto' ? '倍数' : '数值' }} <small v-if="paragraphLineRule !== 'auto'">（磅）</small></span>
              <input type="number" data-testid="word-paragraph-spacing-line-height" :min="paragraphLineLimits.min" :max="paragraphLineLimits.max" :step="paragraphLineLimits.step" :aria-label="paragraphLineRule === 'auto' ? '行距倍数' : '行距数值（磅）'" :aria-describedby="`${paragraphSpacingPanelId}-line-help${paragraphSpacingError ? ` ${paragraphSpacingPanelId}-error` : ''}`" :aria-invalid="!!paragraphSpacingError" :value="paragraphLineDraft" :placeholder="!paragraphLineRule ? '先选择方式' : paragraphLineMixed && !paragraphLineTouched ? '混合' : '请输入数值'" :disabled="unavailable || !paragraphLineRule" @input="editParagraphLineHeight">
            </label>
          </div>
          <p :id="`${paragraphSpacingPanelId}-line-help`" class="word-paragraph-spacing-line-help">{{ paragraphLineRule === 'exact' ? '较大的文字可能重叠，请检查正文预览。' : paragraphLineRule === 'atLeast' ? '每行至少使用该高度，较大的文字可以撑高行距。' : paragraphLineRule === 'auto' ? `按文字高度设置行距；1 为单倍，1.5 为一倍半。支持 ${AUTO_LINE_HEIGHT_LIMITS.min} 至 ${AUTO_LINE_HEIGHT_LIMITS.max} 倍。` : '选择一种行距方式，再输入数值。' }}</p>
        </fieldset>
        <div class="word-paragraph-spacing-actions">
          <button type="submit" class="word-paragraph-spacing-apply" data-testid="word-paragraph-spacing-apply" :disabled="unavailable">应用</button>
          <button type="button" data-testid="word-paragraph-spacing-cancel" @click="closeParagraphSpacingPanel(true)">取消</button>
        </div>
      </div>
      <p :id="`${paragraphSpacingPanelId}-help`" class="word-paragraph-spacing-help">仅修改当前选区的段落。混合值和文稿默认值未修改时保留；段前、段后以 0.05 磅递增。</p>
      <p v-if="paragraphSpacingError" :id="`${paragraphSpacingPanelId}-error`" class="word-paragraph-spacing-error" role="alert">{{ paragraphSpacingError }}</p>
    </form>
    <form v-if="pageSettingsOpen" :id="pageSettingsId" ref="pageSettingsPanel" class="word-page-settings-panel" data-testid="word-page-settings-panel" role="dialog" aria-label="页面设置" :aria-describedby="`${pageSettingsId}-help`" novalidate @submit.prevent="safely(applyPageSettings)" @keydown.esc.prevent.stop="closePageSettings(true)">
      <header class="word-page-settings-heading"><h3>页面设置</h3><span>适用于整份文稿</span></header>
      <div class="word-page-settings-scroll">
        <fieldset class="word-page-settings-presets" :disabled="unavailable">
          <legend>纸张大小</legend>
          <div class="word-page-settings-options">
            <label v-for="preset in pagePresets" :key="preset.value">
              <input type="radio" :data-testid="`word-page-settings-preset-${preset.value}`" :name="`${pageSettingsId}-preset`" :value="preset.value" :checked="pageSettingsPreset === preset.value" @change="choosePagePreset(preset.value)"><span>{{ preset.label }}</span>
            </label>
          </div>
        </fieldset>
        <fieldset class="word-page-settings-orientation" :disabled="unavailable || !pageSettingsDimensionsValid">
          <legend>纸张方向</legend>
          <div class="word-page-settings-options">
            <label><input type="radio" data-testid="word-page-settings-orientation-portrait" :name="`${pageSettingsId}-orientation`" value="portrait" :checked="pageSettingsOrientation === 'portrait'" @change="choosePageOrientation('portrait')"><span><i class="word-page-settings-paper" aria-hidden="true"></i>纵向</span></label>
            <label><input type="radio" data-testid="word-page-settings-orientation-landscape" :name="`${pageSettingsId}-orientation`" value="landscape" :checked="pageSettingsOrientation === 'landscape'" @change="choosePageOrientation('landscape')"><span><i class="word-page-settings-paper word-page-settings-landscape" aria-hidden="true"></i>横向</span></label>
          </div>
        </fieldset>
        <div class="word-page-settings-fields">
          <label v-for="field in pageSettingsFields" :key="field.key" class="word-page-settings-field">
            <span>{{ field.label }} <small>（磅）</small></span>
            <input type="number" :data-testid="field.testId" :aria-label="`${field.label}（磅）`" :min="field.key === 'width' || field.key === 'height' ? PAGE_SIZE_LIMITS.min : PAGE_MARGIN_LIMITS.min" :max="field.key === 'width' || field.key === 'height' ? PAGE_SIZE_LIMITS.max : PAGE_MARGIN_LIMITS.max" step="0.05" :value="pageSettingsDraft[field.key]" :aria-invalid="!!(pageSettingsError || pageSettingsSizePreview?.error)" :aria-describedby="`${pageSettingsId}-help${pageSettingsError || pageSettingsSizePreview?.error ? ` ${pageSettingsId}-error` : ''}`" :disabled="unavailable" @input="editPageSetting(field.key, $event)">
          </label>
        </div>
        <p v-if="pageSettingsSizePreview?.size" class="word-page-settings-help" data-testid="word-page-settings-size-preview" role="status">应用后纸张尺寸：{{ pageSettingsSizePreview.size }}</p>
        <p :id="`${pageSettingsId}-help`" class="word-page-settings-help">以 0.05 磅递增，1 磅约 0.35 毫米。接近标准纸型的尺寸会自动校正为标准值。切换方向会调整纸张宽高，四边距保留原值。连续视图展示纸张宽度与页边距，不模拟分页。</p>
      </div>
      <footer class="word-page-settings-actions">
        <p v-if="pageSettingsError || pageSettingsSizePreview?.error" :id="`${pageSettingsId}-error`" class="word-page-settings-error" role="alert">{{ pageSettingsError || pageSettingsSizePreview?.error }}</p>
        <div class="word-page-settings-buttons"><button type="button" data-testid="word-page-settings-cancel" @click="closePageSettings(true)">取消</button><button type="submit" class="word-page-settings-apply" data-testid="word-page-settings-apply" :disabled="unavailable">应用</button></div>
      </footer>
    </form>
    <div class="word-view-heading"><strong>正文编辑 · 预览</strong><span title="连续视图展示纸张宽度和页边距；分页规则随文稿保存，当前不模拟实际分页。">连续视图 · 纸张宽度与页边距</span></div>
    <p v-if="problem" class="word-message word-problem" role="alert">{{ problem }}</p>
    <p v-if="notice" class="word-message" role="status">{{ notice }}</p>
    <div v-if="loading" class="word-loading" role="status">正在打开文稿…</div>
    <div v-else-if="controller" class="word-scroll">
      <div ref="content" class="word-page" data-testid="word-content" role="textbox" aria-label="文稿正文" aria-multiline="true" :aria-readonly="disabled" :contenteditable="!disabled" :style="pageStyle" spellcheck="false"
        @beforeinput="beforeInput" @input="input" @keydown="keydown" @copy="safely(() => copyFormattedText($event))" @cut="safely(() => copyFormattedText($event, true))" @paste="paste" @drop="drop" @dragover.prevent
        @compositionstart="startComposition" @compositionend="endComposition" @blur="blur" @mouseup="rememberSelection" @keyup="rememberSelection" />
    </div>
    <footer class="word-status"><span>{{ characters }} 字 · {{ model?.paragraphs.length || 0 }} 段</span><span>支持正文、字符格式与段落样式；表格、图片及复杂排版暂不支持。</span></footer>
  </section>
</template>
