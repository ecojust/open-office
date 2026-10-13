<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { NativeDocument } from '../types'
import {
  appendHistory, base64ToBytes, colorToRgb, errorMessage, movePages, orderedRect,
  PdfOperationError, pointToDocument, rectToViewport, requestPdf,
  type PdfMetadata, type PdfPoint, type PdfRect, type PdfResponse, type PdfTextBlock,
} from '../pdf/protocol'
import '../pdf/pdf.css'
import { hasPdfEditingEngine, pickPdfDocument, pickPdfImage, saveExtractedPdf } from '../pdf/backend'
import { canvasOutputScale, releaseCanvas, trimHistoryBudget } from '../pdf/resources'
import { useDialogFocus } from '../shared/dialog-focus'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{ document: NativeDocument; initialDirty?: boolean }>()
const engineAvailable = hasPdfEditingEngine()
const emit = defineEmits<{
  dirty: [value: boolean]
  ready: []
  error: [message: string]
  status: [message: string]
}>()

type Tool = 'select' | 'text' | 'highlight' | 'ink' | 'image'
type Viewport = ReturnType<pdfjs.PDFPageProxy['getViewport']>
const tool = ref<Tool>('select')
const tools: { id: Tool; label: string; icon: string }[] = [
  { id: 'select', label: '编辑原文', icon: 'cursor' },
  { id: 'text', label: '新增文字', icon: 'text' },
  { id: 'highlight', label: '高亮', icon: 'highlight' },
  { id: 'ink', label: '手绘 / 签名', icon: 'pen' },
  { id: 'image', label: '插入图片', icon: 'image' },
]
const icons: Record<string, string> = {
  cursor: 'm5 3 14 10-7 1-3 7-4-18Z',
  text: 'M4 5V3h16v2M12 3v18M8 21h8',
  highlight: 'm15 3 6 6-10 10H5v-6L15 3ZM3 21h18',
  pen: 'm16 3 5 5-12 12-6 1 1-6L16 3ZM3 21l5-5',
  image: 'M3 3h18v18H3V3Zm0 14 6-6 4 4 3-3 5 5M16 7h.01',
  pages: 'M7 3h14v15H7V3ZM3 7v14h14',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  undo: 'M3 10h12a6 6 0 0 1 0 12M3 10l6-6M3 10l6 6',
  redo: 'M21 10H9a6 6 0 0 0 0 12M21 10l-6-6M21 10l-6 6',
  rotate: 'M20 7V2l-5 5h5a9 9 0 1 0 1 9',
  trash: 'M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  up: 'm6 12 6-6 6 6M12 6v15',
  down: 'm6 12 6 6 6-6M12 3v15',
  extract: 'M8 3H3v18h18v-5M13 3h8v8M21 3 10 14',
  merge: 'M3 4h6v6H3V4ZM15 4h6v6h-6V4ZM6 10v5h12v-5M12 15v6M9 18l3 3 3-3',
  close: 'm6 6 12 12M6 18 18 6',
  fit: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',
}
const stage = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const pageSurface = ref<HTMLDivElement | null>(null)
const thumbList = ref<HTMLDivElement | null>(null)
const metadata = ref<PdfMetadata | null>(null)
const textBlocks = ref<PdfTextBlock[]>([])
const currentBytes = ref('')
const pageIndex = ref(0)
const selectedPages = ref<number[]>([0])
const zoom = ref(1)
const fitWidth = ref(true)
const viewport = ref<Viewport | null>(null)
const loading = ref(false)
const rendering = ref(false)
const working = ref(false)
const busyLabel = ref('正在打开 PDF…')
const localError = ref('')
const notice = ref('')
const warnings = ref<string[]>([])
const passwordRequired = ref(false)
const passwordInput = ref('')
const password = ref('')
const allowSignedCopy = ref(false)
const signedSource = ref(false)
const copyRequired = ref(false)
const showPages = ref(true)
const sidebarTab = ref<'pages' | 'outline'>('pages')
const outline = ref<{ level: number; title: string; pageIndex: number | null }[]>([])
const stampMode = ref<'page_numbers' | 'watermark' | null>(null)
const stampDialog = ref<HTMLFormElement | null>(null)
const stampScope = ref<'all' | 'selected'>('all')
const stampText = ref('草稿'), stampSize = ref(44), stampOpacity = ref(16), stampColor = ref('#647080')
const stampFormat = ref('number-total'), stampPosition = ref('bottom-center'), stampChanged = ref(false)
let stampReturnFocus: HTMLElement | null = null
const showSearch = ref(false)
const searchQuery = ref('')
const searchedQuery = ref('')
const searching = ref(false)
const searchResults = ref<{ pageIndex: number; text: string }[]>([])
const selectedText = ref<PdfTextBlock | null>(null)
const editText = ref('')
const fontSize = ref(12)
const color = ref('#1f2937')
const highlightColor = ref('#facc15')
const inkWidth = ref(2)
const pendingRect = ref<PdfRect | null>(null)
const inkPaths = ref<PdfPoint[][]>([])
const image = ref<{ name: string; base64: string } | null>(null)
const mergeCandidate = ref<NativeDocument | null>(null)
const mergeDialog = ref<HTMLElement>()
useDialogFocus(mergeDialog)
const mergePassword = ref('')
const allowUnencryptedMerge = ref(false)
const allowSignedMerge = ref(false)
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])

let pdf: pdfjs.PDFDocumentProxy | null = null
let documentEpoch = 0
let documentRevision = 0
let renderSequence = 0
let textSequence = 0
let searchSequence = 0
let disposed = false
let currentDocumentId = ''
let savedBase64 = ''
let baselineDirty = false
let lastExportedBytes = ''
let operationTail: Promise<void> = Promise.resolve()
let resizeObserver: ResizeObserver | null = null
let resizeFrame = 0
let thumbnailFrame = 0
let activeThumbnails = 0
let dragStart: PdfPoint | null = null
let activePointer: number | null = null
let lastSelectionAnchor = 0
let mainRenderTask: pdfjs.RenderTask | null = null
const renderTasks = new Set<pdfjs.RenderTask>()
const loadingTasks = new Set<pdfjs.PDFDocumentLoadingTask>()
const thumbnails = new Map<number, HTMLCanvasElement>()
const thumbnailRevisions = new Map<number, number>()
const thumbnailQueue = new Set<number>()
const visibleThumbnails = new Set<number>()
const thumbnailJobs = new Map<number, { cancelled: boolean; task?: pdfjs.RenderTask }>()
const inspectedPages = new Set<number>()

const pageCount = computed(() => metadata.value?.pageCount ?? pdf?.numPages ?? 0)
const isBusy = computed(() => loading.value || working.value)
const permission = computed(() => {
  const value = metadata.value?.permissions
  return value && typeof value === 'object' ? value : null
})
const signedLocked = computed(() => signedSource.value && !allowSignedCopy.value)
const canModify = computed(() => currentBytes.value.length > 0 && engineAvailable && !signedLocked.value && permission.value?.modify !== false && permission.value?.edit !== false)
const canAnnotate = computed(() => currentBytes.value.length > 0 && engineAvailable && !signedLocked.value && permission.value?.annotate !== false)
const canAssemble = computed(() => currentBytes.value.length > 0 && engineAvailable && !signedLocked.value && permission.value?.assemble !== false)
const canCopy = computed(() => currentBytes.value.length > 0 && engineAvailable && permission.value?.copy !== false)
const canUndo = computed(() => !!undoStack.value.length && !isBusy.value)
const canRedo = computed(() => !!redoStack.value.length && !isBusy.value)
const currentTextBlocks = computed(() => textBlocks.value.filter(block => block.pageIndex === pageIndex.value && block.text.trim()))
const propertyPanelVisible = computed(() => !!selectedText.value || tool.value !== 'select')
const hasPendingEdits = computed(() => {
  if (stampChanged.value) return true
  if (selectedText.value) {
    const block = selectedText.value
    return editText.value !== block.text || Math.abs(fontSize.value - block.fontSize) > 0.05 || color.value !== textColorHex(block)
      || !!pendingRect.value?.some((coordinate, index) => Math.abs(coordinate - block.bbox[index]!) > 0.01)
  }
  if (tool.value === 'text') return !!editText.value.trim()
  if (tool.value === 'ink') return inkPaths.value.some(path => path.length > 1)
  if (tool.value === 'highlight' || tool.value === 'image' && image.value) {
    return !!pendingRect.value && pendingRect.value[2] - pendingRect.value[0] > 0 && pendingRect.value[3] - pendingRect.value[1] > 0
  }
  return false
})
const pageStyle = computed(() => ({ width: `${viewport.value?.width ?? 0}px`, height: `${viewport.value?.height ?? 0}px` }))
const selectionStyle = computed(() => pendingRect.value && viewport.value ? rectStyle(pendingRect.value) : undefined)
const toolHint = computed(() => {
  if (!engineAvailable) return '浏览器仅提供 PDF 预览。请使用桌面应用编辑文件。'
  if (tool.value === 'select' && permission.value?.copy === false) return '文件权限不允许提取原文，因此不能显示可编辑的文字区域。需要文档所有者授权。'
  if (tool.value === 'select') return currentTextBlocks.value.length ? '点击页面上的文字，编辑内容后应用。' : '本页没有可直接编辑的文本，可能是扫描页或轮廓文字。可新增文字或批注；编辑原文需要先进行 OCR。'
  if (tool.value === 'text') return '在页面拖出文字区域，再输入内容并应用。'
  if (tool.value === 'highlight') return '在页面拖出需要高亮的区域，点击应用保存。'
  if (tool.value === 'ink') return '直接在页面书写，可连续绘制多笔。这是手写批注，不是数字证书签名。'
  return image.value ? `已选择 ${image.value.name}，在页面拖出图片放置区域。` : '选择一张 PNG 或 JPEG 图片，再在页面拖出放置区域。'
})
const editBlockedReason = computed(() => !engineAvailable ? '请在桌面应用中编辑 PDF。' : signedLocked.value ? '签名文件需先确认编辑副本。' : '文件权限不允许此操作。')

function setStatus(message: string) {
  notice.value = message
  emit('status', message)
}
function fail(error: unknown) {
  const message = errorMessage(error)
  localError.value = message
  emit('error', message)
}
function alive(epoch: number) { return !disposed && epoch === documentEpoch }
function cancelRenders() {
  renderSequence++
  for (const task of renderTasks) task.cancel()
  renderTasks.clear()
  thumbnailQueue.clear()
  visibleThumbnails.clear()
  for (const job of thumbnailJobs.values()) { job.cancelled = true; job.task?.cancel() }
}
function clearPlacement() {
  pendingRect.value = null
  inkPaths.value = []
  dragStart = null
  activePointer = null
}
function clearEditorSelection() {
  selectedText.value = null
  editText.value = ''
  clearPlacement()
}
function announceDirty() { emit('dirty', baselineDirty || currentBytes.value !== savedBase64 || hasPendingEdits.value) }

async function decodePdf(base64: string, epoch: number): Promise<pdfjs.PDFDocumentProxy> {
  const assetBase = new URL('./pdfjs/', globalThis.document.baseURI).href
  const task = pdfjs.getDocument({
    data: base64ToBytes(base64), password: password.value || undefined,
    cMapUrl: `${assetBase}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`, wasmUrl: `${assetBase}wasm/`,
  })
  loadingTasks.add(task)
  try {
    const result = await task.promise
    if (!alive(epoch)) {
      await result.loadingTask.destroy()
      throw new PdfOperationError('STALE_DOCUMENT', '文件已关闭。')
    }
    return result
  } catch (error) {
    // A rejected loading promise still owns its worker and network transport.
    await task.destroy().catch(() => {})
    throw error
  } finally { loadingTasks.delete(task) }
}

async function installDocument(base64: string, response: PdfResponse, epoch: number, preparedPdf?: pdfjs.PDFDocumentProxy) {
  const nextPdf = preparedPdf ?? await decodePdf(base64, epoch)
  if (!alive(epoch)) { await nextPdf.loadingTask.destroy(); return }
  cancelRenders()
  const oldPdf = pdf
  pdf = nextPdf
  documentRevision++
  currentBytes.value = base64
  metadata.value = response.metadata ?? { pageCount: nextPdf.numPages, pages: [] }
  outline.value = response.metadata?.outline ?? []
  if (!response.metadata?.outline) void readPreviewOutline(nextPdf, epoch)
  pageIndex.value = Math.min(Math.max(0, pageIndex.value), nextPdf.numPages - 1)
  textBlocks.value = (response.textBlocks ?? []).filter(block => block.pageIndex === pageIndex.value)
  inspectedPages.clear()
  for (const block of textBlocks.value) inspectedPages.add(block.pageIndex)
  warnings.value = response.warnings ?? []
  signedSource.value ||= !!metadata.value.signed
  selectedPages.value = selectedPages.value.filter(index => index < nextPdf.numPages)
  if (!selectedPages.value.length) selectedPages.value = [pageIndex.value]
  clearEditorSelection()
  thumbnailRevisions.clear()
  for (const thumb of thumbnails.values()) releaseCanvas(thumb)
  if (oldPdf) void oldPdf.loadingTask.destroy().catch(() => {})
  await nextTick()
  if (!alive(epoch)) return
  ensureResizeObserver()
  await renderCurrentPage()
  queueVisibleThumbnails()
  void inspectCurrentPage()
}

async function readPreviewOutline(source: pdfjs.PDFDocumentProxy, epoch: number) {
  try {
    const result: typeof outline.value = []
    const walk = async (items: Awaited<ReturnType<pdfjs.PDFDocumentProxy['getOutline']>>, level: number) => {
      for (const item of items || []) {
        if (result.length >= 2000 || level > 20 || !alive(epoch) || source !== pdf) return
        let destination: number | null = null
        try {
          const target = typeof item.dest === 'string' ? await source.getDestination(item.dest) : item.dest
          if (Array.isArray(target) && target[0] != null) destination = typeof target[0] === 'number' ? target[0] : await source.getPageIndex(target[0])
        } catch { /* Unsupported external destinations remain visible but cannot be followed. */ }
        result.push({ level, title: String(item.title).slice(0, 500), pageIndex: destination !== null && destination >= 0 && destination < source.numPages ? destination : null })
        await walk(item.items, level + 1)
      }
    }
    await walk(await source.getOutline(), 1)
    if (alive(epoch) && source === pdf) outline.value = result
  } catch { if (alive(epoch) && source === pdf) outline.value = [] }
}

async function openStamp(mode: 'page_numbers' | 'watermark') {
  if (!canModify.value || isBusy.value) return
  if (hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再添加页码或水印。'); return }
  clearEditorSelection(); stampReturnFocus = globalThis.document.activeElement as HTMLElement | null
  stampMode.value = mode; stampScope.value = 'all'; stampChanged.value = false
  stampSize.value = mode === 'watermark' ? 44 : 10
  await nextTick(); stampDialog.value?.focus()
}
function closeStamp() {
  if (isBusy.value) return
  stampMode.value = null; stampChanged.value = false; stampReturnFocus?.focus(); stampReturnFocus = null
  announceDirty()
}
function stampKeyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeStamp() }
  if (event.key === 'Tab') {
    const fields = [...(stampDialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') || [])]
    const first = fields[0], last = fields.at(-1)
    if (event.shiftKey && (globalThis.document.activeElement === first || globalThis.document.activeElement === stampDialog.value)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
async function applyStamp() {
  const mode = stampMode.value, epoch = documentEpoch
  if (!mode || !canModify.value || isBusy.value) return
  const pageIndices = stampScope.value === 'selected' ? [...selectedPages.value] : Array.from({ length: pageCount.value }, (_, index) => index)
  try {
    await queueOperation(mode, { pageIndices, fontSize: stampSize.value, color: colorToRgb(stampColor.value),
      ...(mode === 'watermark' ? { text: stampText.value, opacity: stampOpacity.value / 100 } : { format: stampFormat.value, position: stampPosition.value }) }, '正在更新页面内容…')
    if (alive(epoch)) { closeStamp(); setStatus(`已为 ${pageIndices.length} 页添加${mode === 'watermark' ? '水印' : '页码'}，可以撤销。请保存文件。`) }
  } catch { /* Keep the settings visible; queueOperation already reported the precise error. */ }
}

async function openCurrentDocument(reset = true) {
  const epoch = ++documentEpoch
  searchSequence++
  textSequence++
  cancelRenders()
  for (const task of loadingTasks) void task.destroy().catch(() => {})
  loadingTasks.clear()
  loading.value = true
  working.value = false
  operationTail = Promise.resolve()
  busyLabel.value = '正在读取 PDF…'
  localError.value = ''
  passwordRequired.value = false
  if (reset) {
    const oldPdf = pdf
    pdf = null
    if (oldPdf) void oldPdf.loadingTask.destroy().catch(() => {})
    currentDocumentId = props.document.id
    savedBase64 = props.document.base64
    baselineDirty = !!props.initialDirty
    lastExportedBytes = ''
    currentBytes.value = ''
    releaseCanvas(canvas.value)
    for (const thumb of thumbnails.values()) releaseCanvas(thumb)
    thumbnailRevisions.clear()
    metadata.value = null
    outline.value = []; stampMode.value = null; stampChanged.value = false
    password.value = ''
    passwordInput.value = ''
    pageIndex.value = 0
    selectedPages.value = [0]
    selectedText.value = null
    undoStack.value = []
    redoStack.value = []
    textBlocks.value = []
    searchResults.value = []
    searchedQuery.value = ''
    signedSource.value = false
    copyRequired.value = false
    allowSignedCopy.value = false
    mergeCandidate.value = null
    image.value = null
    mergePassword.value = ''
    allowUnencryptedMerge.value = false
    allowSignedMerge.value = false
    tool.value = 'select'
    clearPlacement()
    emit('dirty', baselineDirty)
  }
  try {
    if (!engineAvailable) {
      if (!props.document.base64) throw new Error('请在桌面应用中新建 PDF。浏览器版本仅支持预览已有文件。')
      const previewPdf = await decodePdf(props.document.base64, epoch)
      const response: PdfResponse = { protocolVersion: 1, requestId: '', ok: true, metadata: { pageCount: previewPdf.numPages, pages: [] } }
      await installDocument(props.document.base64, response, epoch, previewPdf)
    } else {
      const response = await requestPdf(props.document.base64 ? 'inspect' : 'new', props.document.base64, props.document.base64 ? { pageIndices: [pageIndex.value] } : {}, password.value || undefined)
      if (!alive(epoch)) return
      const bytes = response.base64 || props.document.base64
      if (!bytes) throw new Error('PDF 引擎未返回文件数据。')
      await installDocument(bytes, response, epoch)
    }
    if (!alive(epoch)) return
    setStatus(`${pageCount.value} 页 PDF · 文件在此设备处理`)
    announceDirty()
    emit('ready')
  } catch (error) {
    if (!alive(epoch)) return
    if (error instanceof PdfOperationError && ['PASSWORD_REQUIRED', 'INVALID_PASSWORD'].includes(error.code) || error instanceof Error && error.name === 'PasswordException') {
      passwordRequired.value = true
      if (password.value) localError.value = '密码不正确，请重试。'
      setStatus('此 PDF 需要密码才能打开。')
    } else { fail(error) }
  } finally { if (alive(epoch)) loading.value = false }
}

function unlockDocument() {
  if (!passwordInput.value || loading.value) return
  password.value = passwordInput.value
  void openCurrentDocument(false)
}

async function renderCurrentPage() {
  const source = pdf
  if (!source || !canvas.value || !stage.value || loading.value && !currentBytes.value) return
  const sequence = ++renderSequence
  const revision = documentRevision
  const index = pageIndex.value
  const previousTask = mainRenderTask
  let page: pdfjs.PDFPageProxy | undefined
  if (previousTask) previousTask.cancel()
  rendering.value = true
  try {
    if (previousTask) await previousTask.promise.catch(() => {})
    if (sequence !== renderSequence || source !== pdf || disposed) return
    page = await source.getPage(index + 1)
    if (sequence !== renderSequence || source !== pdf || disposed) return
    const unitViewport = page.getViewport({ scale: 1 })
    if (fitWidth.value) zoom.value = Math.max(0.2, Math.min(2, (stage.value.clientWidth - 48) / unitViewport.width))
    const nextViewport = page.getViewport({ scale: zoom.value })
    viewport.value = nextViewport
    await nextTick()
    if (!canvas.value || sequence !== renderSequence || revision !== documentRevision) return
    const outputScale = canvasOutputScale(nextViewport.width, nextViewport.height, Math.min(globalThis.devicePixelRatio || 1, 2))
    const targetCanvas = canvas.value
    targetCanvas.width = Math.max(1, Math.floor(nextViewport.width * outputScale))
    targetCanvas.height = Math.max(1, Math.floor(nextViewport.height * outputScale))
    const context = targetCanvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('无法创建 PDF 页面画布。')
    const task = page.render({ canvas: targetCanvas, canvasContext: context, viewport: nextViewport, transform: [outputScale, 0, 0, outputScale, 0, 0] })
    mainRenderTask = task
    renderTasks.add(task)
    try { await task.promise } finally { renderTasks.delete(task); if (mainRenderTask === task) mainRenderTask = null }
  } catch (error) {
    if (sequence === renderSequence && alive(documentEpoch) && !(error instanceof Error && error.name === 'RenderingCancelledException')) fail(error)
  } finally { page?.cleanup(); if (sequence === renderSequence) rendering.value = false }
}

function ensureResizeObserver() {
  if (resizeObserver || !stage.value) return
  resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => {
      if (disposed) return
      if (fitWidth.value) void renderCurrentPage()
      queueVisibleThumbnails()
    })
  })
  resizeObserver.observe(stage.value)
}
function registerThumbnail(element: unknown, index: number) {
  const previous = thumbnails.get(index)
  if (previous === element) return
  releaseCanvas(previous)
  thumbnailJobs.get(index)?.task?.cancel()
  const job = thumbnailJobs.get(index)
  if (job) job.cancelled = true
  thumbnailRevisions.delete(index)
  if (element instanceof HTMLCanvasElement) {
    releaseCanvas(element)
    const page = metadata.value?.pages[index]
    element.style.aspectRatio = page ? `${page.width} / ${page.height}` : '104 / 147'
    thumbnails.set(index, element)
  } else {
    thumbnails.delete(index)
    thumbnailQueue.delete(index)
    visibleThumbnails.delete(index)
  }
}
function queueVisibleThumbnails() {
  cancelAnimationFrame(thumbnailFrame)
  thumbnailFrame = requestAnimationFrame(() => {
    if (disposed) return
    visibleThumbnails.clear()
    thumbnailQueue.clear()
    const containerRect = pdf && thumbList.value && showPages.value && sidebarTab.value === 'pages'
      ? thumbList.value.getBoundingClientRect() : null
    for (const [index, element] of thumbnails) {
      const bounds = element.getBoundingClientRect()
      if (containerRect && bounds.bottom >= containerRect.top - 180 && bounds.top <= containerRect.bottom + 180) {
        visibleThumbnails.add(index)
        if (thumbnailRevisions.get(index) !== documentRevision) thumbnailQueue.add(index)
      } else {
        const job = thumbnailJobs.get(index)
        if (job) { job.cancelled = true; job.task?.cancel() }
        thumbnailRevisions.delete(index)
        releaseCanvas(element)
      }
    }
    runThumbnailQueue()
  })
}
function runThumbnailQueue() {
  while (activeThumbnails < 2 && thumbnailQueue.size && pdf) {
    const index = thumbnailQueue.values().next().value as number
    thumbnailQueue.delete(index)
    const element = thumbnails.get(index)
    const source = pdf
    const revision = documentRevision
    if (!element || !visibleThumbnails.has(index) || thumbnailJobs.has(index) || thumbnailRevisions.get(index) === revision) continue
    const job: { cancelled: boolean; task?: pdfjs.RenderTask } = { cancelled: false }
    thumbnailJobs.set(index, job)
    activeThumbnails++
    void (async () => {
      let page: pdfjs.PDFPageProxy | undefined
      try {
        page = await source.getPage(index + 1)
        if (source !== pdf || disposed || job.cancelled || !visibleThumbnails.has(index) || thumbnails.get(index) !== element) return
        const base = page.getViewport({ scale: 1 })
        const view = page.getViewport({ scale: 104 / base.width })
        element.style.aspectRatio = `${base.width} / ${base.height}`
        const density = canvasOutputScale(view.width, view.height, 1.5, 512 * 512)
        element.width = Math.max(1, Math.floor(view.width * density))
        element.height = Math.max(1, Math.floor(view.height * density))
        const context = element.getContext('2d', { alpha: false })
        if (!context) return
        const task = page.render({ canvas: element, canvasContext: context, viewport: view, transform: [density, 0, 0, density, 0, 0] })
        job.task = task
        renderTasks.add(task)
        try { await task.promise } finally { renderTasks.delete(task) }
        if (!job.cancelled && source === pdf && thumbnails.get(index) === element) thumbnailRevisions.set(index, revision)
      } catch { /* A later visibility pass can retry a failed thumbnail. */ }
      finally {
        page?.cleanup()
        thumbnailJobs.delete(index)
        if (job.cancelled || disposed || source !== pdf || thumbnails.get(index) !== element) releaseCanvas(element)
        activeThumbnails--
        if (!disposed) {
          if (job.cancelled && visibleThumbnails.has(index)) thumbnailQueue.add(index)
          runThumbnailQueue()
        }
      }
    })()
  }
}

async function inspectCurrentPage() {
  // Even a cache hit invalidates inspection of the page we just left.
  const sequence = ++textSequence
  if (!engineAvailable || !pdf || inspectedPages.has(pageIndex.value)) return
  const epoch = documentEpoch
  const revision = documentRevision
  const index = pageIndex.value
  try {
    const response = await requestPdf('inspect', currentBytes.value, { pageIndices: [index] }, password.value || undefined)
    if (!alive(epoch) || revision !== documentRevision || sequence !== textSequence) return
    textBlocks.value = response.textBlocks ?? []
    inspectedPages.clear()
    inspectedPages.add(index)
  } catch (error) { if (alive(epoch) && revision === documentRevision) fail(error) }
}

function selectPage(index: number, event?: MouseEvent) {
  if (isBusy.value || index < 0 || index >= pageCount.value) return
  if (index !== pageIndex.value && hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再切换页面。'); return }
  if (event?.shiftKey) {
    const start = Math.min(lastSelectionAnchor, index)
    const end = Math.max(lastSelectionAnchor, index)
    selectedPages.value = Array.from({ length: end - start + 1 }, (_, value) => start + value)
  } else if (event?.metaKey || event?.ctrlKey) {
    const selected = new Set(selectedPages.value)
    if (selected.has(index) && selected.size > 1) selected.delete(index)
    else selected.add(index)
    selectedPages.value = [...selected].sort((a, b) => a - b)
    lastSelectionAnchor = index
  } else {
    selectedPages.value = [index]
    lastSelectionAnchor = index
  }
  pageIndex.value = index
}
function togglePageSelection(index: number) {
  if (isBusy.value) return
  const selected = new Set(selectedPages.value)
  if (selected.has(index) && selected.size > 1) selected.delete(index)
  else selected.add(index)
  selectedPages.value = [...selected].sort((a, b) => a - b)
}
function changePage(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) selectPage(Math.min(pageCount.value - 1, Math.max(0, Math.round(value) - 1)))
}
function changeZoom(amount: number) {
  fitWidth.value = false
  zoom.value = Math.max(0.25, Math.min(4, Math.round((zoom.value + amount) * 100) / 100))
  void renderCurrentPage()
}
function fitPage() { fitWidth.value = true; void renderCurrentPage() }
function rectStyle(rect: PdfRect) {
  if (!viewport.value) return {}
  const bounds = rectToViewport(rect, viewport.value)
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, `${value}px`]))
}
function isSearchMatch(block: PdfTextBlock) {
  return !!searchedQuery.value && block.text.toLocaleLowerCase().includes(searchedQuery.value.toLocaleLowerCase())
}

function queueOperation(operation: string, options: Record<string, unknown>, message: string): Promise<void> {
  const epoch = documentEpoch
  const run = operationTail.then(async () => {
    if (!alive(epoch) || !currentBytes.value) return
    working.value = true
    busyLabel.value = message
    localError.value = ''
    const before = currentBytes.value
    try {
      const response = await requestPdf(operation, before, { ...options, allowSignedCopy: options.allowSignedCopy === true || allowSignedCopy.value }, password.value || undefined)
      if (!alive(epoch)) return
      if (!response.base64) throw new Error('PDF 引擎未返回修改后的文件，原文件已保留。')
      await installDocument(response.base64, response, epoch)
      if (!alive(epoch)) return
      undoStack.value = appendHistory(undoStack.value, before)
      redoStack.value = []
      if (operation === 'merge' && (options.allowUnencryptedCopy || options.allowSignedCopy)) copyRequired.value = true
      searchedQuery.value = ''
      searchResults.value = []
      announceDirty()
      setStatus('更改已应用，请保存文件。')
    } catch (error) {
      if (alive(epoch)) fail(error)
      throw error
    } finally { if (alive(epoch)) working.value = false }
  })
  // Keep the queue usable after failure. The caller receives the rejecting promise.
  operationTail = run.catch(() => {})
  return run
}
function runOperation(operation: string, options: Record<string, unknown>, message: string) {
  if (isBusy.value) return
  void queueOperation(operation, options, message).catch(() => {})
}

function chooseText(block: PdfTextBlock) {
  if (!canModify.value || isBusy.value || tool.value !== 'select') return
  if (hasPendingEdits.value && selectedText.value?.id !== block.id) { setStatus('请先应用或取消当前文字编辑。'); return }
  selectedText.value = block
  editText.value = block.text
  fontSize.value = Math.round(block.fontSize * 10) / 10
  color.value = textColorHex(block)
  pendingRect.value = [...block.bbox]
}
function textColorHex(block: PdfTextBlock) {
  if (typeof block.color === 'number') return `#${block.color.toString(16).padStart(6, '0')}`
  return `#${block.color.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`
}
function applyText() {
  const block = selectedText.value
  if (!canModify.value || !pendingRect.value || !editText.value.trim()) return
  runOperation(block ? 'replace_text' : 'add_text', {
    pageIndex: pageIndex.value, rect: pendingRect.value, ...(block ? { sourceRect: block.bbox } : {}), text: editText.value,
    fontSize: fontSize.value, color: colorToRgb(color.value), align: 0,
  }, block ? '正在替换原文…' : '正在添加文字…')
}
function applyAnnotation() {
  if (tool.value === 'highlight' && pendingRect.value && canAnnotate.value) {
    runOperation('highlight', { pageIndex: pageIndex.value, rects: [pendingRect.value], color: colorToRgb(highlightColor.value), opacity: 0.4 }, '正在添加高亮…')
  } else if (tool.value === 'ink' && inkPaths.value.length && canAnnotate.value) {
    runOperation('ink', { pageIndex: pageIndex.value, paths: inkPaths.value, color: colorToRgb(color.value), width: inkWidth.value }, '正在保存手绘…')
  } else if (tool.value === 'image' && pendingRect.value && image.value && canModify.value) {
    runOperation('add_image', { pageIndex: pageIndex.value, rect: pendingRect.value, imageBase64: image.value.base64 }, '正在插入图片…')
  }
}
async function chooseImage() {
  if (!canModify.value || isBusy.value) return
  const epoch = documentEpoch
  try {
    const result = await pickPdfImage()
    if (alive(epoch) && result) { image.value = result; clearPlacement(); tool.value = 'image' }
  } catch (error) { if (alive(epoch)) fail(error) }
}
function toolEnabled(id: Tool) { return id === 'highlight' || id === 'ink' ? canAnnotate.value : canModify.value }
function chooseTool(id: Tool) {
  if (isBusy.value || !toolEnabled(id)) return
  if (hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再切换工具。'); return }
  clearEditorSelection()
  tool.value = id
  if (id === 'image' && !image.value) void chooseImage()
}

function pointerDocumentPoint(event: PointerEvent): PdfPoint | null {
  if (!viewport.value || !pageSurface.value) return null
  const bounds = pageSurface.value.getBoundingClientRect()
  const x = Math.max(0, Math.min(viewport.value.width, event.clientX - bounds.left))
  const y = Math.max(0, Math.min(viewport.value.height, event.clientY - bounds.top))
  return pointToDocument([x, y], viewport.value)
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || tool.value === 'select' || isBusy.value || !toolEnabled(tool.value)) return
  const point = pointerDocumentPoint(event)
  if (!point) return
  event.preventDefault()
  dragStart = point
  activePointer = event.pointerId
  pageSurface.value?.setPointerCapture(event.pointerId)
  if (tool.value === 'ink') inkPaths.value = [...inkPaths.value, [point]]
  else pendingRect.value = orderedRect(point, point)
}
function pointerMove(event: PointerEvent) {
  if (activePointer !== event.pointerId || !dragStart) return
  const point = pointerDocumentPoint(event)
  if (!point) return
  if (tool.value === 'ink') {
    const path = inkPaths.value.at(-1)
    if (!path) return
    const last = path.at(-1)!
    if (Math.hypot(last[0] - point[0], last[1] - point[1]) >= 0.8) path.push(point)
  } else pendingRect.value = orderedRect(dragStart, point)
}
function pointerUp(event: PointerEvent) {
  if (activePointer !== event.pointerId) return
  if (pageSurface.value?.hasPointerCapture(event.pointerId)) pageSurface.value.releasePointerCapture(event.pointerId)
  if (tool.value === 'ink') inkPaths.value = inkPaths.value.filter(path => path.length > 1)
  else if (pendingRect.value && (pendingRect.value[2] - pendingRect.value[0] < 5 || pendingRect.value[3] - pendingRect.value[1] < 5)) {
    pendingRect.value = null
    setStatus('请拖出一个区域，宽和高至少 5 点。')
  }
  dragStart = null
  activePointer = null
}
function pointerCancel(event: PointerEvent) {
  if (activePointer !== event.pointerId) return
  if (tool.value === 'ink') inkPaths.value = inkPaths.value.slice(0, -1)
  else pendingRect.value = null
  dragStart = null
  activePointer = null
}
function inkDisplayPoints(path: PdfPoint[]) {
  if (!viewport.value) return ''
  const view = viewport.value
  return path.map(([x, y]) => view.convertToViewportPoint(x + view.viewBox[0]!, view.viewBox[3]! - y).join(',')).join(' ')
}

function rotateSelected() {
  if (hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再旋转页面。'); return }
  if (canAssemble.value) runOperation('rotate', { pageIndices: selectedPages.value, degrees: 90 }, '正在旋转页面…')
}
function deleteSelected() {
  if (hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再删除页面。'); return }
  if (!canAssemble.value || selectedPages.value.length >= pageCount.value) return
  runOperation('delete', { pageIndices: selectedPages.value }, '正在删除页面…')
}
function moveSelected(direction: -1 | 1) {
  if (!canAssemble.value || isBusy.value) return
  if (hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再调整页序。'); return }
  const epoch = documentEpoch
  const order = movePages(pageCount.value, selectedPages.value, direction)
  if (order.every((value, index) => value === index)) return
  const nextSelection = selectedPages.value.map(index => order.indexOf(index))
  const nextPage = order.indexOf(pageIndex.value)
  void queueOperation('reorder', { order }, '正在调整页序…').then(() => {
    if (alive(epoch)) { selectedPages.value = nextSelection; pageIndex.value = nextPage }
  }).catch(() => {})
}
async function extractSelected() {
  if (!canCopy.value || isBusy.value) return
  if (hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再提取页面。'); return }
  const epoch = documentEpoch
  working.value = true
  busyLabel.value = '正在提取页面…'
  localError.value = ''
  try {
    const result = await requestPdf('extract', currentBytes.value, { pageIndices: selectedPages.value, allowSignedCopy: allowSignedCopy.value }, password.value || undefined)
    if (!alive(epoch)) return
    if (!result.base64) throw new Error('提取未返回 PDF 文件。')
    const name = `${props.document.name.replace(/\.pdf$/i, '')}_提取.pdf`
    const saved = await saveExtractedPdf(name, result.base64)
    if (alive(epoch)) {
      if (saved.status === 'conflict') throw new Error(saved.message)
      setStatus(saved.status === 'cancelled' ? '已取消提取文件的保存。' : '所选页面已另存，当前 PDF 保持不变。')
    }
  } catch (error) { if (alive(epoch)) fail(error) }
  finally { if (alive(epoch)) working.value = false }
}
async function mergeDocument() {
  if (!canAssemble.value || isBusy.value) return
  if (hasPendingEdits.value) { setStatus('请先应用或清除当前编辑，再合并文件。'); return }
  const epoch = documentEpoch
  try {
    const selected = await pickPdfDocument()
    if (!alive(epoch) || !selected) return
    if (selected.extension.toLowerCase() !== 'pdf') throw new Error('合并页面请选择 PDF 文件。')
    mergeCandidate.value = selected
    mergePassword.value = ''
    allowUnencryptedMerge.value = false
    allowSignedMerge.value = false
  } catch (error) { if (alive(epoch)) fail(error) }
}
async function confirmMerge() {
  const candidate = mergeCandidate.value
  if (!candidate || isBusy.value) return
  const epoch = documentEpoch
  try {
    await queueOperation('merge', {
      documents: [{ base64: currentBytes.value, password: password.value || undefined }, { base64: candidate.base64, password: mergePassword.value || undefined }],
      allowUnencryptedCopy: allowUnencryptedMerge.value,
      allowSignedCopy: allowSignedMerge.value,
    }, '正在合并 PDF…')
    if (alive(epoch)) { mergeCandidate.value = null; mergePassword.value = '' }
  } catch { /* queueOperation displays the precise password/permission error and retains the dialog. */ }
}

async function restoreHistory(direction: 'undo' | 'redo') {
  const from = direction === 'undo' ? undoStack : redoStack
  const to = direction === 'undo' ? redoStack : undoStack
  if (!from.value.length || isBusy.value) return
  const value = from.value.at(-1)!
  const before = currentBytes.value
  const epoch = documentEpoch
  working.value = true
  busyLabel.value = direction === 'undo' ? '正在撤销…' : '正在重做…'
  localError.value = ''
  const action = (async () => {
    try {
      const response = await requestPdf('inspect', value, {}, password.value || undefined)
      if (!alive(epoch)) return
      await installDocument(value, response, epoch)
      if (!alive(epoch)) return
      from.value = from.value.slice(0, -1)
      to.value = appendHistory(to.value, before)
      const history = trimHistoryBudget(undoStack.value, redoStack.value, direction === 'undo' ? 'redo' : 'undo')
      undoStack.value = history.undo
      redoStack.value = history.redo
      announceDirty()
      setStatus(direction === 'undo' ? '已撤销上一步。' : '已重做。')
    } catch (error) { if (alive(epoch)) fail(error) }
    finally { if (alive(epoch)) working.value = false }
  })()
  operationTail = action
  await action
}
async function undo() { await restoreHistory('undo') }
async function redo() { await restoreHistory('redo') }

async function searchDocument() {
  const query = searchQuery.value.trim()
  const source = pdf
  const sequence = ++searchSequence
  const revision = documentRevision
  if (!source || !query || permission.value?.copy === false) { searchedQuery.value = ''; searchResults.value = []; return }
  searching.value = true
  searchResults.value = []
  searchedQuery.value = query
  try {
    const results: { pageIndex: number; text: string }[] = []
    for (let index = 0; index < source.numPages; index++) {
      if (sequence !== searchSequence || revision !== documentRevision || source !== pdf || disposed) return
      const page = await source.getPage(index + 1)
      try {
        const content = await page.getTextContent()
        if (sequence !== searchSequence || revision !== documentRevision || source !== pdf || disposed) return
        const text = content.items.map(item => 'str' in item ? item.str : '').join(' ')
        const position = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
        if (position >= 0) results.push({ pageIndex: index, text: text.slice(Math.max(0, position - 24), position + query.length + 64) })
      } finally { page.cleanup() }
    }
    searchResults.value = results
    setStatus(results.length ? `在 ${results.length} 页找到“${query}”。` : `没有找到“${query}”。扫描图片不会包含可搜索文本。`)
    if (results[0]) selectPage(results[0].pageIndex)
  } catch (error) { if (sequence === searchSequence && source === pdf) fail(error) }
  finally { if (sequence === searchSequence) searching.value = false }
}

async function exportFile(options?: { format?: string }): Promise<{ base64: string; extension: 'pdf'; name?: string; saveAs?: boolean; dirty: boolean }> {
  if (options?.format && options.format.toLowerCase() !== 'pdf') throw new Error('PDF 编辑器只能导出 PDF 格式。')
  const epoch = documentEpoch
  await operationTail
  if (!alive(epoch)) throw new Error('文件已切换，请重新保存当前文件。')
  if (loading.value || working.value || !currentBytes.value) throw new Error('请等待 PDF 操作完成后再保存。')
  if (hasPendingEdits.value) throw new Error('页面上还有未应用的编辑，请先应用或取消。')
  lastExportedBytes = currentBytes.value
  return {
    base64: currentBytes.value, extension: 'pdf', dirty: baselineDirty || currentBytes.value !== savedBase64,
    ...((signedSource.value || copyRequired.value) && currentBytes.value !== savedBase64 ? {
      name: `${props.document.name.replace(/\.pdf$/i, '')}_编辑副本.pdf`, saveAs: true,
    } : {}),
  }
}
function markSaved(base64?: string) {
  savedBase64 = base64 ?? (lastExportedBytes || currentBytes.value)
  lastExportedBytes = ''
  baselineDirty = false
  announceDirty()
}
function resizeTextRegion(axis: 'width' | 'height', event: Event) {
  if (!pendingRect.value || !viewport.value) return
  const size = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(size) || size < 5) return
  const rect = [...pendingRect.value] as PdfRect
  const page = metadata.value?.pages[pageIndex.value]
  if (axis === 'width') rect[2] = Math.min(page?.width ?? viewport.value.viewBox[2]! - viewport.value.viewBox[0]!, rect[0] + size)
  else rect[3] = Math.min(page?.height ?? viewport.value.viewBox[3]! - viewport.value.viewBox[1]!, rect[1] + size)
  pendingRect.value = rect
}
async function discardChanges() {
  await operationTail
  // The shell already stashed the PDF or confirmed closing. There is no internal
  // document-close prompt to bypass; release only the not-yet-applied preview.
  clearEditorSelection()
  stampMode.value = null; stampChanged.value = false
}
defineExpose({ exportFile, undo, redo, markSaved, discardChanges })

watch(() => [props.document.id, props.document.base64] as const, ([id, base64]) => {
  if (id === currentDocumentId && currentBytes.value === base64) {
    return
  }
  void openCurrentDocument()
}, { immediate: true })
watch(pageIndex, () => { clearEditorSelection(); stage.value?.scrollTo({ top: 0, left: 0 }); void renderCurrentPage(); void inspectCurrentPage() })
watch([showPages, sidebarTab], () => { void nextTick().then(queueVisibleThumbnails) })
watch(propertyPanelVisible, () => { if (fitWidth.value) void nextTick().then(renderCurrentPage) })
watch(hasPendingEdits, value => { if (value) emit('dirty', true) })

onBeforeUnmount(() => {
  disposed = true
  documentEpoch++
  searchSequence++
  textSequence++
  cancelRenders()
  resizeObserver?.disconnect()
  cancelAnimationFrame(resizeFrame)
  cancelAnimationFrame(thumbnailFrame)
  for (const task of loadingTasks) void task.destroy().catch(() => {})
  loadingTasks.clear()
  if (pdf) void pdf.loadingTask.destroy().catch(() => {})
  pdf = null
  releaseCanvas(canvas.value)
  for (const thumbnail of thumbnails.values()) releaseCanvas(thumbnail)
  thumbnails.clear()
  thumbnailRevisions.clear()
  textBlocks.value = []
  savedBase64 = ''
  lastExportedBytes = ''
  password.value = ''
  passwordInput.value = ''
  currentBytes.value = ''
  image.value = null
  mergeCandidate.value = null
  undoStack.value = []
  redoStack.value = []
})
</script>

<template>
  <section class="pdf-editor" data-testid="pdf-editor" aria-label="PDF 编辑器" :aria-busy="isBusy">
    <svg class="pdf-icon-definitions" aria-hidden="true"><defs><symbol v-for="(path, id) in icons" :id="`pdf-icon-${id}`" :key="id" viewBox="0 0 24 24"><path :d="path" /></symbol></defs></svg>
    <div class="pdf-toolbar">
      <div class="pdf-toolbar-group">
        <button class="pdf-icon-button" :class="{ active: showPages }" title="页面列表" aria-label="页面列表" :aria-pressed="showPages" @click="showPages = !showPages"><svg><use href="#pdf-icon-pages" /></svg></button>
        <button class="pdf-icon-button" :class="{ active: showSearch }" title="搜索 PDF" aria-label="搜索 PDF" data-testid="pdf-search-toggle" :aria-pressed="showSearch" :disabled="!pageCount" @click="showSearch = !showSearch"><svg><use href="#pdf-icon-search" /></svg></button>
      </div>
      <div class="pdf-toolbar-group pdf-edit-tools">
        <button v-for="item in tools" :key="item.id" class="pdf-tool-button" :class="{ active: tool === item.id }" :aria-pressed="tool === item.id" :aria-label="item.label" :disabled="isBusy || !toolEnabled(item.id)" :title="!toolEnabled(item.id) ? editBlockedReason : item.label" :data-testid="`pdf-tool-${item.id}`" @click="chooseTool(item.id)"><svg><use :href="`#pdf-icon-${item.icon}`" /></svg><span>{{ item.label }}</span></button>
      </div>
      <div class="pdf-toolbar-group">
        <button class="pdf-icon-button" title="撤销（最多保留 8 次，大文件至少保留最近一次）" aria-label="撤销 PDF 编辑" data-testid="pdf-undo" :disabled="!canUndo" @click="undo"><svg><use href="#pdf-icon-undo" /></svg></button>
        <button class="pdf-icon-button" title="重做" aria-label="重做 PDF 编辑" data-testid="pdf-redo" :disabled="!canRedo" @click="redo"><svg><use href="#pdf-icon-redo" /></svg></button>
      </div>
      <div class="pdf-toolbar-group">
        <button class="pdf-tool-button" :disabled="!canModify || isBusy" data-testid="pdf-page-numbers" @click="openStamp('page_numbers')"><span aria-hidden="true">#</span>页码</button>
        <button class="pdf-tool-button" :disabled="!canModify || isBusy" data-testid="pdf-watermark" @click="openStamp('watermark')"><span aria-hidden="true">◈</span>水印</button>
      </div>
      <div class="pdf-toolbar-group pdf-zoom-controls">
        <button class="pdf-icon-button" aria-label="缩小 PDF" :disabled="!pageCount || isBusy" @click="changeZoom(-0.15)">−</button>
        <span class="pdf-zoom-value" aria-live="off">{{ Math.round(zoom * 100) }}%</span>
        <button class="pdf-icon-button" aria-label="放大 PDF" :disabled="!pageCount || isBusy" @click="changeZoom(0.15)">+</button>
        <button class="pdf-icon-button" :class="{ active: fitWidth }" title="适合宽度" aria-label="适合宽度" :disabled="!pageCount || isBusy" @click="fitPage"><svg><use href="#pdf-icon-fit" /></svg></button>
      </div>
    </div>

    <div v-if="localError" class="pdf-message pdf-message-error" role="alert" data-testid="pdf-error"><span>{{ localError }}</span><button aria-label="关闭 PDF 错误提示" @click="localError = ''">×</button></div>
    <div v-if="signedSource" class="pdf-message pdf-message-warning" data-testid="pdf-signature-notice"><span>{{ allowSignedCopy ? '正在编辑签名文件的副本。修改将使原有数字签名失效，保存时请另存。' : '此文件含数字签名。修改会使签名失效，原件应保留。' }}</span><button v-if="!allowSignedCopy" :disabled="isBusy" @click="allowSignedCopy = true">编辑副本</button></div>
    <div v-if="permission && (permission.modify === false || permission.assemble === false || permission.annotate === false)" class="pdf-message pdf-message-info">此文件包含权限限制。{{ permission.modify === false ? '不能修改原文。' : '' }}{{ permission.annotate === false ? '不能添加批注。' : '' }}{{ permission.assemble === false ? '不能调整页面。' : '' }}</div>
    <div v-for="warning in warnings" :key="warning" class="pdf-message pdf-message-warning">{{ warning }}</div>

    <div v-if="showSearch" class="pdf-search-bar">
      <form @submit.prevent="searchDocument"><svg><use href="#pdf-icon-search" /></svg><input v-model="searchQuery" type="search" placeholder="搜索文档文字" aria-label="搜索 PDF 文字" data-testid="pdf-search-input" :disabled="!pageCount || isBusy" /><button class="pdf-primary-button" :disabled="!searchQuery.trim() || searching || isBusy" data-testid="pdf-search-submit">{{ searching ? '搜索中…' : '搜索' }}</button></form>
      <div v-if="searchedQuery" class="pdf-search-results"><span>{{ searching ? '正在搜索所有页面…' : `${searchResults.length} 页匹配` }}</span><button v-for="result in searchResults" :key="result.pageIndex" :title="result.text" @click="selectPage(result.pageIndex)">第 {{ result.pageIndex + 1 }} 页 · {{ result.text }}</button></div>
    </div>

    <div class="pdf-workspace">
      <aside v-show="showPages && pageCount" class="pdf-pages-panel" aria-label="PDF 页面管理">
        <div class="pdf-sidebar-tabs" aria-label="PDF 侧栏"><button :class="{active:sidebarTab==='pages'}" :aria-pressed="sidebarTab==='pages'" @click="sidebarTab='pages'">页面</button><button :class="{active:sidebarTab==='outline'}" :aria-pressed="sidebarTab==='outline'" data-testid="pdf-outline-tab" @click="sidebarTab='outline'">目录 <small>{{ outline.length }}</small></button></div>
        <div v-show="sidebarTab==='pages'" class="pdf-page-manager">
        <div class="pdf-panel-heading"><strong>页面</strong><span>{{ selectedPages.length }} 页已选</span></div>
        <div class="pdf-page-actions">
          <button class="pdf-icon-button" title="顺时针旋转选中页" aria-label="旋转选中页" data-testid="pdf-rotate" :disabled="!canAssemble || isBusy" @click="rotateSelected"><svg><use href="#pdf-icon-rotate" /></svg></button>
          <button class="pdf-icon-button" title="前移选中页" aria-label="前移选中页" data-testid="pdf-move-up" :disabled="!canAssemble || isBusy || selectedPages.every((value, index) => value === index)" @click="moveSelected(-1)"><svg><use href="#pdf-icon-up" /></svg></button>
          <button class="pdf-icon-button" title="后移选中页" aria-label="后移选中页" data-testid="pdf-move-down" :disabled="!canAssemble || isBusy || selectedPages.every((value, index) => value === pageCount - selectedPages.length + index)" @click="moveSelected(1)"><svg><use href="#pdf-icon-down" /></svg></button>
          <button class="pdf-icon-button" :title="selectedPages.length >= pageCount ? '至少需要保留一页' : '删除选中页（可以撤销）'" aria-label="删除选中页" data-testid="pdf-delete" :disabled="!canAssemble || isBusy || selectedPages.length >= pageCount" @click="deleteSelected"><svg><use href="#pdf-icon-trash" /></svg></button>
          <button class="pdf-icon-button" :title="canCopy ? '将选中页另存为 PDF' : '文件权限禁止提取内容'" aria-label="提取选中页" data-testid="pdf-extract" :disabled="!canCopy || isBusy || signedLocked" @click="extractSelected"><svg><use href="#pdf-icon-extract" /></svg></button>
          <button class="pdf-icon-button" title="从另一份 PDF 追加页面" aria-label="合并 PDF" data-testid="pdf-merge" :disabled="!canAssemble || isBusy" @click="mergeDocument"><svg><use href="#pdf-icon-merge" /></svg></button>
        </div>
        <p class="pdf-page-help">勾选多页，或按住 Shift 连选</p>
        <div ref="thumbList" class="pdf-thumbnail-list" @scroll.passive="queueVisibleThumbnails">
          <div v-for="(_, index) in pageCount" :key="index" class="pdf-thumbnail-item" :class="{ selected: selectedPages.includes(index), current: pageIndex === index }">
            <input class="pdf-page-checkbox" type="checkbox" :checked="selectedPages.includes(index)" :disabled="isBusy" :aria-label="`选择第 ${index + 1} 页`" @change="togglePageSelection(index)" />
            <button class="pdf-thumbnail-button" :data-testid="`pdf-page-${index + 1}`" :aria-label="`转到第 ${index + 1} 页`" :aria-current="pageIndex === index ? 'page' : undefined" :disabled="isBusy" @click="selectPage(index, $event)"><canvas :ref="element => registerThumbnail(element, index)" aria-hidden="true" /><span>{{ index + 1 }}</span></button>
          </div>
        </div>
        </div>
        <nav v-show="sidebarTab==='outline'" class="pdf-outline-list" aria-label="PDF 书签目录">
          <p v-if="!outline.length" class="pdf-outline-empty">此 PDF 没有目录书签。页面中的普通标题不会自动成为书签。</p>
          <button v-for="(item,index) in outline" :key="index" :style="{paddingLeft:`${12 + (item.level-1)*12}px`}" :disabled="isBusy || item.pageIndex === null" :aria-current="item.pageIndex===pageIndex ? 'page' : undefined" :title="item.pageIndex === null ? '外部或无页码的目标，不能在此跳转' : `转到第 ${item.pageIndex+1} 页`" data-testid="pdf-outline-item" @click="item.pageIndex !== null && selectPage(item.pageIndex)"><span>{{ item.title || '未命名书签' }}</span><small>{{ item.pageIndex === null ? '—' : item.pageIndex+1 }}</small></button>
        </nav>
      </aside>

      <main ref="stage" class="pdf-stage" :class="{ 'pdf-stage-drawing': tool !== 'select' }" aria-label="PDF 页面">
        <div v-if="passwordRequired" class="pdf-unlock-card" data-testid="pdf-password-dialog"><div class="pdf-unlock-symbol">⌑</div><h2>打开加密 PDF</h2><p>密码仅用于在此设备打开这份文件。</p><form @submit.prevent="unlockDocument"><input v-model="passwordInput" type="password" autocomplete="off" placeholder="输入文档密码" aria-label="PDF 密码" data-testid="pdf-password" :disabled="loading" /><button class="pdf-primary-button" :disabled="!passwordInput || loading" data-testid="pdf-unlock">{{ loading ? '正在验证…' : '解锁文件' }}</button></form></div>
        <div v-else-if="!currentBytes && !loading" class="pdf-empty-state"><h2>尚未载入 PDF</h2><p>文件没有被修改。可以重新尝试打开。</p><button class="pdf-primary-button" @click="openCurrentDocument(false)">重新打开</button></div>
        <div v-show="currentBytes && !passwordRequired" ref="pageSurface" class="pdf-page-surface" :class="{ 'pdf-drawing-surface': tool !== 'select' }" :style="pageStyle" data-testid="pdf-page-surface" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerCancel">
          <canvas ref="canvas" class="pdf-main-canvas" data-testid="pdf-canvas" :aria-label="`PDF 第 ${pageIndex + 1} 页`" />
          <div class="pdf-text-overlay" :class="{ interactive: tool === 'select' && canModify && !isBusy && !rendering }">
            <button v-for="block in currentTextBlocks" :key="block.id" type="button" class="pdf-text-hit" :class="{ chosen: selectedText?.id === block.id, 'search-match': isSearchMatch(block) }" :style="rectStyle(block.bbox)" :title="block.text" :aria-label="`编辑文本：${block.text}`" :disabled="tool !== 'select' || !canModify || isBusy || rendering" data-testid="pdf-text-block" @pointerdown.stop @click.stop="chooseText(block)"><span class="pdf-sr-only">{{ block.text }}</span></button>
          </div>
          <div v-if="pendingRect && tool !== 'ink'" class="pdf-placement-rectangle" :style="selectionStyle" :class="{ 'pdf-highlight-preview': tool === 'highlight' }" :aria-label="tool === 'highlight' ? '高亮预览，尚未应用' : '编辑区域'" :data-color="highlightColor" />
          <svg v-if="inkPaths.length" class="pdf-ink-preview" :width="viewport?.width" :height="viewport?.height" aria-label="手绘预览，尚未应用"><polyline v-for="(path, index) in inkPaths" :key="index" :points="inkDisplayPoints(path)" fill="none" :stroke="color" :stroke-width="inkWidth * zoom" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </div>
        <div v-if="loading || working" class="pdf-busy-overlay" role="status" data-testid="pdf-busy"><span class="pdf-spinner" /><strong>{{ busyLabel }}</strong><span>文件正在本地处理</span></div>
        <div v-else-if="rendering" class="pdf-render-indicator" role="status">正在绘制页面…</div>
      </main>

      <aside v-if="propertyPanelVisible && currentBytes && !passwordRequired" class="pdf-properties" aria-label="PDF 编辑属性" data-testid="pdf-properties">
        <div class="pdf-panel-heading"><strong>{{ selectedText ? '编辑原文' : tools.find(item => item.id === tool)?.label }}</strong><button class="pdf-icon-button" title="取消当前编辑" aria-label="取消当前编辑" @click="clearEditorSelection(); tool = 'select'"><svg><use href="#pdf-icon-close" /></svg></button></div>
        <p class="pdf-property-hint">{{ selectedText ? '应用后会移除原文字并写入新内容，不使用白块遮盖。原字体不可用时会替换为本地字体。' : toolHint }}</p>
        <template v-if="selectedText || tool === 'text'">
          <label class="pdf-field">文字内容<textarea v-model="editText" rows="6" placeholder="输入文字" data-testid="pdf-text-input" :disabled="isBusy" /></label>
          <div class="pdf-property-row"><label class="pdf-field">字号<input v-model.number="fontSize" type="number" min="4" max="144" step="0.5" :disabled="isBusy" data-testid="pdf-font-size" /></label><label class="pdf-field">颜色<input v-model="color" type="color" :disabled="isBusy" aria-label="文字颜色" /></label></div>
          <div v-if="pendingRect" class="pdf-property-row"><label class="pdf-field">区域宽度（点）<input type="number" :value="Math.round(pendingRect[2] - pendingRect[0])" min="5" :disabled="isBusy" data-testid="pdf-region-width" @change="resizeTextRegion('width', $event)" /></label><label class="pdf-field">区域高度（点）<input type="number" :value="Math.round(pendingRect[3] - pendingRect[1])" min="5" :disabled="isBusy" data-testid="pdf-region-height" @change="resizeTextRegion('height', $event)" /></label></div>
          <p v-if="!pendingRect" class="pdf-property-hint">先在页面拖出文字区域。</p>
          <button class="pdf-primary-button" :disabled="isBusy || !canModify || !pendingRect || !editText.trim() || !(fontSize >= 4 && fontSize <= 144)" data-testid="pdf-apply-text" @click="applyText">{{ selectedText ? '替换原文' : '添加文字' }}</button>
        </template>
        <template v-else-if="tool === 'highlight'">
          <label class="pdf-field">高亮颜色<input v-model="highlightColor" type="color" :disabled="isBusy" aria-label="高亮颜色" /></label>
          <button class="pdf-primary-button" :disabled="isBusy || !canAnnotate || !pendingRect" data-testid="pdf-apply-highlight" @click="applyAnnotation">应用高亮</button>
        </template>
        <template v-else-if="tool === 'ink'">
          <div class="pdf-property-row"><label class="pdf-field">笔宽<input v-model.number="inkWidth" type="number" min="0.5" max="20" step="0.5" :disabled="isBusy" /></label><label class="pdf-field">墨色<input v-model="color" type="color" :disabled="isBusy" aria-label="手绘颜色" /></label></div>
          <p class="pdf-property-hint">已绘制 {{ inkPaths.length }} 笔</p>
          <button class="pdf-primary-button" :disabled="isBusy || !canAnnotate || !inkPaths.length || !(inkWidth >= 0.5 && inkWidth <= 20)" data-testid="pdf-apply-ink" @click="applyAnnotation">保存手绘</button>
        </template>
        <template v-else-if="tool === 'image'">
          <button class="pdf-secondary-button" :disabled="isBusy || !canModify" data-testid="pdf-pick-image" @click="chooseImage">{{ image ? '重新选择图片' : '选择图片' }}</button>
          <p v-if="image" class="pdf-image-name">{{ image.name }}</p>
          <button class="pdf-primary-button" :disabled="isBusy || !canModify || !image || !pendingRect" data-testid="pdf-apply-image" @click="applyAnnotation">插入图片</button>
        </template>
        <button class="pdf-secondary-button" :disabled="isBusy" data-testid="pdf-clear-placement" @click="clearEditorSelection()">清除当前选择 / 预览</button>
        <p class="pdf-property-footnote">应用后可撤销。保存前请核对换行、字形与页面布局。</p>
      </aside>
      <div v-if="stampMode" class="pdf-dialog-backdrop">
        <form ref="stampDialog" class="pdf-merge-dialog pdf-stamp-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-stamp-title" tabindex="-1" data-testid="pdf-stamp-dialog" @submit.prevent="applyStamp" @keydown="stampKeyboard" @input="stampChanged=true" @change="stampChanged=true">
          <div class="pdf-panel-heading"><strong id="pdf-stamp-title">{{ stampMode==='watermark' ? '添加文字水印' : '添加页码' }}</strong><button type="button" class="pdf-icon-button" aria-label="取消页码或水印" :disabled="isBusy" @click="closeStamp"><svg><use href="#pdf-icon-close" /></svg></button></div>
          <p>{{ stampMode==='watermark' ? '在页面中央叠加半透明文字，保留原文内容。水印不能阻止复制，也不能代替敏感信息的删除。' : '按文档中的实际页序编号，在页眉或页脚添加页码。已有页码不会自动移除，请避免重复添加。' }}</p>
          <label class="pdf-field">应用范围<span class="pdf-select-wrap"><select v-model="stampScope" aria-label="页码或水印范围" :disabled="isBusy" data-testid="pdf-stamp-scope"><option value="all">全部 {{ pageCount }} 页</option><option value="selected">所选 {{ selectedPages.length }} 页</option></select></span></label>
          <label v-if="stampMode==='watermark'" class="pdf-field">水印文字<input v-model="stampText" maxlength="120" required :disabled="isBusy" data-testid="pdf-watermark-text" /></label>
          <div v-else class="pdf-property-row"><label class="pdf-field">页码格式<span class="pdf-select-wrap"><select v-model="stampFormat" aria-label="页码格式" :disabled="isBusy" data-testid="pdf-number-format"><option value="number-total">1 / 10</option><option value="number">1</option><option value="chinese">第 1 页 / 共 10 页</option></select></span></label><label class="pdf-field">放置位置<span class="pdf-select-wrap"><select v-model="stampPosition" aria-label="页码位置" :disabled="isBusy"><option value="bottom-center">页脚居中</option><option value="bottom-left">页脚左侧</option><option value="bottom-right">页脚右侧</option><option value="top-center">页眉居中</option><option value="top-left">页眉左侧</option><option value="top-right">页眉右侧</option></select></span></label></div>
          <div class="pdf-property-row"><label class="pdf-field">字号 / 磅<input v-model.number="stampSize" type="number" min="8" :max="stampMode==='watermark' ? 144 : 32" required :disabled="isBusy" data-testid="pdf-stamp-size" /></label><label class="pdf-field">文字颜色<input v-model="stampColor" type="color" :disabled="isBusy" /></label></div>
          <label v-if="stampMode==='watermark'" class="pdf-field">不透明度 {{ stampOpacity }}%<input v-model.number="stampOpacity" type="range" min="5" max="80" :disabled="isBusy" aria-label="水印不透明度" /></label>
          <p class="pdf-stamp-note">应用后可撤销；保存后成为 PDF 页面内容。长文字放不下时会保留原文件并提示调整。</p>
          <div class="pdf-dialog-actions"><button type="button" class="pdf-secondary-button" :disabled="isBusy" @click="closeStamp">取消</button><button class="pdf-primary-button" :disabled="isBusy || !canModify || (stampMode==='watermark' && !stampText.trim())" data-testid="pdf-apply-stamp">{{ isBusy ? '正在应用…' : '应用到页面' }}</button></div>
        </form>
      </div>
      <div v-if="mergeCandidate" class="pdf-dialog-backdrop" @keydown.esc="!isBusy && (mergeCandidate = null)">
        <form ref="mergeDialog" class="pdf-merge-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="pdf-merge-title" data-testid="pdf-merge-dialog" @submit.prevent="confirmMerge">
          <div class="pdf-panel-heading"><strong id="pdf-merge-title">追加 PDF 页面</strong><button type="button" class="pdf-icon-button" aria-label="取消合并" :disabled="isBusy" @click="mergeCandidate = null"><svg><use href="#pdf-icon-close" /></svg></button></div>
          <p>将 <strong>{{ mergeCandidate.name }}</strong> 的页面追加到当前文档末尾。应用后可以撤销。</p>
          <label class="pdf-field">待合并文件的密码（如有）<input v-model="mergePassword" type="password" autocomplete="off" data-testid="pdf-merge-password" :disabled="isBusy" /></label>
          <label class="pdf-checkbox-label"><input v-model="allowUnencryptedMerge" type="checkbox" :disabled="isBusy" />允许合并加密文件并另存为未加密副本</label>
          <label class="pdf-checkbox-label"><input v-model="allowSignedMerge" type="checkbox" :disabled="isBusy" />若文件有数字签名，我了解合并后签名失效</label>
          <div class="pdf-dialog-actions"><button type="button" class="pdf-secondary-button" :disabled="isBusy" @click="mergeCandidate = null">取消</button><button class="pdf-primary-button" :disabled="isBusy" data-testid="pdf-confirm-merge">{{ isBusy ? '正在合并…' : '合并页面' }}</button></div>
        </form>
      </div>
    </div>

    <footer class="pdf-statusbar"><div class="pdf-page-navigation"><button aria-label="上一页" :disabled="pageIndex <= 0 || isBusy" @click="selectPage(pageIndex - 1)">‹</button><label><span class="pdf-sr-only">当前页码</span><input type="number" :value="pageIndex + 1" min="1" :max="pageCount || 1" :disabled="!pageCount || isBusy" data-testid="pdf-page-number" @change="changePage" /> / {{ pageCount }}</label><button aria-label="下一页" :disabled="pageIndex >= pageCount - 1 || isBusy" @click="selectPage(pageIndex + 1)">›</button></div><span class="pdf-status-text" :title="notice || toolHint">{{ notice || toolHint }}</span><span class="pdf-local-badge">本地处理</span></footer>
    <p v-if="currentBytes && !propertyPanelVisible && !isBusy" class="pdf-context-hint" :class="{ 'pdf-scanned-hint': !currentTextBlocks.length }" data-testid="pdf-context-hint">{{ toolHint }}</p>
  </section>
</template>
