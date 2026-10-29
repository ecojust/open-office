<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import Icon from './components/Icon.vue'
import McpSettingsDialog from './components/McpSettingsDialog.vue'
import { createDefaultMcpConfig, loadMcpConfig, saveMcpConfig as storeBrowserMcpConfig, type McpConfig } from './mcp/config'
import { createMcpService, type McpServiceState } from './mcp/service'
import { getMcpConfig, saveMcpConfig as storeNativeMcpConfig, mcpTransport } from './mcp/native'
import { catalogForKind, executeDocumentTool } from './mcp/document-tools'
import NotebookEditor from './components/NotebookEditor.vue'
import ScheduleEditor from './components/ScheduleEditor.vue'
import { decodeSchedule } from './schedule/model'
import WorkflowEditor from './components/WorkflowEditor.vue'
import { importText as importWorkflowText, documentBytes as workflowBytes } from './workflow/core/files'
import type { WorkflowDocument } from './workflow/core/types'
import { decodeNotebook } from './notes/model'
import { createAutosaveScheduler, type AutosaveTarget } from './shared/autosave'
import RustWordEditor from './components/RustWordEditor.vue'
import RustSheetEditor from './components/RustSheetEditor.vue'
import RustPresentationEditor from './components/RustPresentationEditor.vue'
import PresentationTemplates from './components/PresentationTemplates.vue'
import { listPresentationTemplates, loadPresentationTemplate, savePresentationTemplate, deletePresentationTemplate, normalizePresentationTemplateName, type PresentationTemplate } from './presentation/templates'
import type { OfficePresentationSnapshot } from './presentation/rust/office-presentation-types'
import RustPdfEditor from './components/RustPdfEditor.vue'
import * as native from './native'
import { smokeAwait, smokeFailure, smokeFeatures, smokeRequested, smokeStage } from './smoke'
import type { NativeDocument, RecentDocument, SaveDocumentRequest, SaveResult } from './types'
import { useDialogFocus } from './shared/dialog-focus'
import { useAppearance } from './shared/appearance'
import { createId } from './shared/id'
import { inspectOfficeWordSession, prepareRustWordDocument, type PreparedRustWordDocument } from './word/rust/client'
import { inspectOfficeSheetSession, prepareRustSheetDocument, type PreparedRustSheetDocument } from './sheet/rust/client'
import { inspectOfficePresentationSession, prepareRustPresentationDocument, type PreparedRustPresentationDocument } from './presentation/rust/client'
import type { OfficePresentationSmokeEditor } from './presentation/rust/office-presentation-native-smoke'
import type { OfficeSheetSmokeEditor } from './sheet/rust/office-sheet-native-smoke'
import type { OfficeWordSmokeEditor } from './word/rust/office-word-native-smoke'
import { inspectOfficePdfSession, prepareRustPdfDocument, type PreparedRustPdfDocument } from './pdf/rust/client'
import type { OfficePdfSmokeEditor } from './pdf/rust/native-smoke'
import type { EditingSmokeAdapter } from './sheet/rust/macos-editing-smoke'
import type { NotebookNativeSmokeAdapter } from './notes/native-smoke'
import { bytesToBase64, base64ToBytes, extensionOf, kindOf, documentKindOf, withExtension, defaultSaveExtension, isImportOnly, validateDocumentSignature, saveFormats, saveFileName, type SaveExtension, type Kind, type Extension, type EditorHandle, type EditorExport } from './shared/document'

interface Tab { key: string; document: NativeDocument; fileId?: string; requiresSaveAs?: boolean; importWarnings?:string[]; dirty: boolean; ready: boolean; loadError?: string; autoSavedAt?: number }
const appVersion = __APP_VERSION__
const buildVersion = __BUILD_VERSION__
const brandIcon = new URL('./brand-mark.png', document.baseURI).href
const { appearance, effectiveAppearance } = useAppearance()
const appearanceOptions = [
  { value: 'light', icon: 'sun', label: '浅色主题' },
  { value: 'dark', icon: 'moon', label: '深色主题' },
  { value: 'system', icon: 'monitor', label: '跟随系统' },
] as const
const smokeMode = ref(smokeRequested())
let nativeSmokeSaveObserver: ((request: SaveDocumentRequest, result: SaveResult) => void) | undefined
smokeStage('app-setup', 'Vue setup reached')
const tabs = ref<Tab[]>([]), activeKey = ref(''), home = ref(true)
const tabBar = ref<HTMLElement>()
let tabBarObserver: ResizeObserver | undefined
function revealActiveTab() {
  const bar = tabBar.value, tab = bar?.querySelector<HTMLElement>('.document-tab.active')
  if (home.value || !bar?.clientWidth || !tab) return
  const viewport = bar.getBoundingClientRect(), item = tab.getBoundingClientRect()
  const left = bar.scrollLeft + item.left - viewport.left
  // Keep scrolling local to the tab list, and align oversized tabs by their start.
  const right = left + Math.min(item.width, bar.clientWidth)
  if (left < bar.scrollLeft - 1) bar.scrollLeft = left
  else if (right > bar.scrollLeft + bar.clientWidth + 1) bar.scrollLeft = right - bar.clientWidth
}
watch([activeKey, home], revealActiveTab, { flush: 'post' })
onMounted(() => {
  tabBarObserver = new ResizeObserver(revealActiveTab)
  if (tabBar.value) tabBarObserver.observe(tabBar.value)
})
onBeforeUnmount(() => tabBarObserver?.disconnect())
const active = computed(() => tabs.value.find(t => t.key === activeKey.value))
const activeRustWord = computed(() => active.value?.document.kind === 'word')
const activeRustSheet = computed(() => active.value?.document.kind === 'sheet')
const activeRustPresentation = computed(() => active.value?.document.kind === 'presentation')
const activeRustPdf = computed(() => active.value?.document.kind === 'pdf')
const activeSchedule = computed(() => active.value?.document.kind === 'schedule')
const activeNote = computed(() => active.value?.document.kind === 'note')
const isWorkflowKind = (kind: Kind) => kind === 'canvas' || kind === 'diagram'
const activeWorkflow = computed(() => !!active.value && isWorkflowKind(active.value.document.kind))
const activeRustEditor = computed(() => activeRustWord.value || activeRustSheet.value || activeRustPresentation.value || activeRustPdf.value)
const rustWordEntries = shallowRef<{document:NativeDocument;prepared?:PreparedRustWordDocument}[]>([])
const rustWordHandles = new Map<string,EditorHandle>()
function setRustWordDocument(document?: NativeDocument, prepared?: PreparedRustWordDocument) {
  if(!document) {
    for(const entry of rustWordEntries.value)entry.prepared?.discard()
    rustWordEntries.value=[];rustWordHandles.clear()
  } else if(!rustWordEntries.value.some(entry=>entry.document.id===document.id)) {
    rustWordEntries.value=[...rustWordEntries.value,{document,prepared}]
  } else prepared?.discard()
}
function setRustWordHandle(id:string,handle:unknown) {
  if(handle)rustWordHandles.set(id,handle as EditorHandle)
  else rustWordHandles.delete(id)
}
const rustSheetEntries = shallowRef<{document:NativeDocument;prepared?:PreparedRustSheetDocument}[]>([])
const rustSheetHandles = new Map<string,EditorHandle>()
function setRustSheetDocument(document?:NativeDocument,prepared?:PreparedRustSheetDocument) {
  if(!document) {
    for(const entry of rustSheetEntries.value)entry.prepared?.discard()
    rustSheetEntries.value=[];rustSheetHandles.clear()
  } else if(!rustSheetEntries.value.some(entry=>entry.document.id===document.id)) {
    rustSheetEntries.value=[...rustSheetEntries.value,{document,prepared}]
  } else prepared?.discard()
}
function setRustSheetHandle(id:string,handle:unknown) {
  if(handle)rustSheetHandles.set(id,handle as EditorHandle)
  else rustSheetHandles.delete(id)
}
type PresentationEditorHandle = Omit<EditorHandle, 'inspect'> & { present(startPage?: number): Promise<void>; stopPresentation(): void | Promise<void>; inspect(): Promise<OfficePresentationSnapshot>; applyTemplate(base64: string): Promise<OfficePresentationSnapshot> }
const rustPresentationEntries = shallowRef<{document:NativeDocument;prepared?:PreparedRustPresentationDocument}[]>([])
const rustPresentationHandles = new Map<string,PresentationEditorHandle>()
function setRustPresentationDocument(document?:NativeDocument,prepared?:PreparedRustPresentationDocument) {
  if(!document) {
    for(const entry of rustPresentationEntries.value)entry.prepared?.discard()
    rustPresentationEntries.value=[];rustPresentationHandles.clear()
  } else if(!rustPresentationEntries.value.some(entry=>entry.document.id===document.id)) {
    rustPresentationEntries.value=[...rustPresentationEntries.value,{document,prepared}]
  } else prepared?.discard()
}
function setRustPresentationHandle(id:string,handle:unknown) {
  if(handle)rustPresentationHandles.set(id,handle as PresentationEditorHandle)
  else rustPresentationHandles.delete(id)
}
const rustPdfEntries = shallowRef<{document:NativeDocument;prepared?:PreparedRustPdfDocument}[]>([])
const rustPdfHandles = new Map<string,EditorHandle>()
function setRustPdfDocument(document?:NativeDocument,prepared?:PreparedRustPdfDocument) {
  if(!document) {
    for(const entry of rustPdfEntries.value)entry.prepared?.discard()
    rustPdfEntries.value=[];rustPdfHandles.clear()
  } else if(!rustPdfEntries.value.some(entry=>entry.document.id===document.id)) {
    rustPdfEntries.value=[...rustPdfEntries.value,{document,prepared}]
  } else prepared?.discard()
}
function setRustPdfHandle(id:string,handle:unknown) {
  if(handle)rustPdfHandles.set(id,handle as EditorHandle)
  else rustPdfHandles.delete(id)
}
const noteEntries = shallowRef<{document:NativeDocument}[]>([])
const noteHandles = new Map<string,EditorHandle>()
function setNoteDocument(document?:NativeDocument) {
  if(!document) {noteEntries.value=[];noteHandles.clear()}
  else if(!noteEntries.value.some(entry=>entry.document.id===document.id))noteEntries.value=[...noteEntries.value,{document}]
}
function setNoteHandle(id:string,handle:unknown) {
  if(handle)noteHandles.set(id,handle as EditorHandle)
  else noteHandles.delete(id)
}
const workflowEntries = shallowRef<{document:NativeDocument}[]>([])
const workflowHandles = new Map<string,EditorHandle>()
function setWorkflowDocument(document?:NativeDocument) {
  if(!document) {workflowEntries.value=[];workflowHandles.clear()}
  else if(!workflowEntries.value.some(entry=>entry.document.id===document.id))workflowEntries.value=[...workflowEntries.value,{document}]
}
function setWorkflowHandle(id:string,handle:unknown) {
  if(handle)workflowHandles.set(id,handle as EditorHandle)
  else workflowHandles.delete(id)
}
const scheduleEntries = shallowRef<{document:NativeDocument}[]>([])
const scheduleHandles = new Map<string,EditorHandle>()
function setScheduleDocument(document?:NativeDocument) {
  if(!document) {scheduleEntries.value=[];scheduleHandles.clear()}
  else if(!scheduleEntries.value.some(entry=>entry.document.id===document.id))scheduleEntries.value=[...scheduleEntries.value,{document}]
}
function setScheduleHandle(id:string,handle:unknown) {
  if(handle)scheduleHandles.set(id,handle as EditorHandle)
  else scheduleHandles.delete(id)
}
let appDisposed = false
onBeforeUnmount(() => { appDisposed = true; setRustWordDocument(); setRustSheetDocument(); setRustPresentationDocument(); setRustPdfDocument(); setNoteDocument(); setWorkflowDocument(); setScheduleDocument() })
const recents = ref<RecentDocument[]>([]), busy = ref(''), error = ref(''), status = ref('所有文件，仅在你的设备上处理')
const help = ref(false), search = ref(''), closeTarget = ref<Tab | 'window' | 'all' | null>(null)
const mcpSettingsOpen = ref(false), mcpSettingsBusy = ref(false), mcpSettingsError = ref(''), mcpWorking = ref(false)
const mcpMutating = ref(false)
const mcpConfig = shallowRef<McpConfig>(createDefaultMcpConfig())
const mcpConfigReady = ref(false)
const mcpState = shallowRef<McpServiceState>({ phase: 'stopped' })
const recentList = ref<HTMLElement>()
watch(search, () => { if(recentList.value) recentList.value.scrollTop = 0 }, { flush: 'post' })
const saveAsDraft = ref<{ key:string; kind:Kind; format:SaveExtension; name:string; error:string } | null>(null)
type TemplateDraft = { kind:'save'; key:string; name:string; error:string } | { kind:'apply'|'delete'; key:string; template:PresentationTemplate; error:string }
const templateDraft = ref<TemplateDraft | null>(null), templateDialog = ref<HTMLElement>()
const templatePanelOpen = ref(false), templateListLoading = ref(false), templateListError = ref('')
const presentationTemplates = shallowRef<PresentationTemplate[]>([])
let templateListRequest = 0
useDialogFocus(templateDialog)
watch([templatePanelOpen, activeRustPresentation, home], () => nextTick(() => window.dispatchEvent(new Event('resize'))))
const composing = ref(false), backgroundSaving = ref(false)
const globalActionsBlocked = computed(() => !!busy.value || !!saveAsDraft.value || !!templateDraft.value || !!closeTarget.value || help.value || mcpSettingsOpen.value || mcpWorking.value)
const editorInputBlocked = computed(() => (!!busy.value && !backgroundSaving.value) || !!saveAsDraft.value || !!templateDraft.value || !!closeTarget.value || help.value || mcpSettingsOpen.value || mcpMutating.value)
const currentDocument = computed(() => home.value ? undefined : active.value)
const documentActionsDisabled = computed(() => globalActionsBlocked.value || !currentDocument.value?.ready)
const printDisabled = computed(() => documentActionsDisabled.value || typeof editor()?.print !== 'function')
const newMenu = ref<HTMLDetailsElement>()
function closeNewMenu(restoreFocus = false) {
  newMenu.value?.removeAttribute('open')
  if (restoreFocus) newMenu.value?.querySelector('summary')?.focus()
}
function dismissNewMenu(event: PointerEvent) {
  if (newMenu.value && !event.composedPath().includes(newMenu.value)) closeNewMenu()
}
function globalNewDocument(kind: Kind) {
  closeNewMenu()
  if (!globalActionsBlocked.value) newDocument(kind)
}
function globalFileAction(action: 'open' | 'save' | 'saveAs' | 'exportPdf' | 'print' | 'undo' | 'redo') {
  closeNewMenu()
  if (globalActionsBlocked.value) return
  if (action === 'open') { openFile(); return }
  if (documentActionsDisabled.value) return
  if (action === 'save') save()
  else if (action === 'saveAs') save(true)
  else if (action === 'exportPdf') {
    if (currentDocument.value && saveFormats(currentDocument.value.document.kind).some(option=>option.extension==='pdf') && currentDocument.value.document.kind !== 'pdf') save(true, 'pdf')
  } else editCommand(action)
}
watch([activeKey, home, globalActionsBlocked], () => closeNewMenu())
const saveAsDialog = ref<HTMLElement>()
function formatsFor(tab:Tab | undefined) { return tab ? saveFormats(tab.document.kind) : [] }
const saveAsOptions = computed(() => formatsFor(tabs.value.find(tab=>tab.key===saveAsDraft.value?.key)))
const saveAsCopy = computed(() => !!saveAsDraft.value&&!!active.value&&saveAsDraft.value.format!==defaultSaveExtension(active.value.document.extension,active.value.document.kind))
useDialogFocus(saveAsDialog)
const helpDialog = ref<HTMLElement>(), closeDialog = ref<HTMLElement>()
useDialogFocus(helpDialog)
useDialogFocus(closeDialog)
const fileInput = ref<HTMLInputElement>()
const scheduleImportInput = ref<HTMLInputElement>()
let unlisten: (() => void) | undefined
let pendingWindowClose = false
const editor = () => activeRustWord.value ? rustWordHandles.get(activeKey.value) : activeRustSheet.value ? rustSheetHandles.get(activeKey.value) : activeRustPresentation.value ? rustPresentationHandles.get(activeKey.value) : activeRustPdf.value ? rustPdfHandles.get(activeKey.value) : activeSchedule.value ? scheduleHandles.get(activeKey.value) : activeWorkflow.value ? workflowHandles.get(activeKey.value) : noteHandles.get(activeKey.value)
const kindNames: Record<Kind,string> = { word:'文字文档', sheet:'电子表格', presentation:'演示文稿', pdf:'PDF 文档', note:'笔记本', canvas:'画布', diagram:'代码图表', schedule:'计划排期' }
const icons: Record<Kind,string> = {word:'file',sheet:'sheet',presentation:'presentation',pdf:'pdf',note:'notebook',canvas:'canvas',diagram:'code-diagram',schedule:'schedule'}
const helpTools: { kind: Kind; name: string; description: string }[] = [
  { kind: 'word', name: '文字', description: '撰写文章、整理报告，完成图文排版。' },
  { kind: 'sheet', name: '表格', description: '记录数据、计算公式，制作分析图表。' },
  { kind: 'presentation', name: '演示', description: '制作幻灯片，用模板呈现汇报与创意。' },
  { kind: 'pdf', name: 'PDF', description: '阅读和编辑文档，添加批注、签名与图章。' },
  { kind: 'note', name: '笔记本', description: '分区记录笔记，自由摆放文字与图片。' },
  { kind: 'canvas', name: '画布', description: '绘制图形、连线与手绘，梳理想法和流程。' },
  { kind: 'schedule', name: '计划排期', description: '安排项目日期、角色分工与事件，直观调整时间。' },
  { kind: 'diagram', name: '代码图表', description: '用简洁代码绘制时序图等图表，实时预览。' },
]
const filteredRecents = computed(() => recents.value.filter(r => r.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const message = (e:unknown) => e instanceof Error ? e.message : String(e)
const mcpService = createMcpService({
  transport: mcpTransport,
  currentDocument: () => currentDocument.value ? { id:currentDocument.value.key, kind:currentDocument.value.document.kind, title:currentDocument.value.document.name } : undefined,
  changed: value => { mcpState.value = value },
  async execute(request, assertCurrent) {
    if (globalActionsBlocked.value || composing.value) throw Error('当前文档正在编辑或处理其他操作，请稍后重试。')
    const tab = currentDocument.value
    if (!tab?.ready || tab.key !== request.documentId) throw Error('当前文档尚未准备好。')
    const handle = requireEditor(tab)
    if (!await handle.canBackgroundExport?.()) throw Error('请先完成当前输入、拖动或弹窗操作，再调用 MCP。')
    assertCurrent()
    if (globalActionsBlocked.value || composing.value) throw Error('当前文档正在处理其他操作，请稍后重试。')
    const mutating = catalogForKind(tab.document.kind).find(tool => tool.name === request.toolName)?.annotations.readOnlyHint !== true
    mcpWorking.value = true
    mcpMutating.value = mutating
    try {
      if (mutating && document.activeElement instanceof HTMLElement) document.activeElement.blur()
      await nextTick()
      assertCurrent()
      const result = await executeDocumentTool(tab.document.kind, handle, request.toolName, request.arguments, assertCurrent)
      assertCurrent()
      if (mutating) status.value = 'MCP 操作已应用到当前文档'
      return result
    } finally {
      mcpWorking.value = false; mcpMutating.value = false
      // Resume editor input and flush the dirty/status UI before replying to the client.
      await nextTick()
    }
  },
})
let mcpSettingsLoading:Promise<void>|undefined
function readMcpSettings():Promise<void> {
  if (mcpSettingsLoading) return mcpSettingsLoading
  mcpSettingsBusy.value = true
  mcpSettingsLoading = (async () => {
    try {
      const config = await (native.isTauri() ? getMcpConfig() : Promise.resolve(loadMcpConfig()))
      if (appDisposed) return
      mcpConfig.value = config; mcpConfigReady.value = true; mcpSettingsError.value = ''
    } catch (cause) { mcpSettingsError.value = `无法读取 MCP 设置：${message(cause)}` }
    finally { mcpSettingsBusy.value = false; mcpSettingsLoading = undefined }
  })()
  return mcpSettingsLoading
}
function openMcpSettings() {
  mcpSettingsOpen.value = true
  if (!mcpConfigReady.value) void readMcpSettings()
}
async function saveMcpSettings(config:McpConfig) {
  if (mcpSettingsBusy.value) return
  mcpSettingsBusy.value = true; mcpSettingsError.value = ''
  try {
    await mcpService.stop()
    if (native.isTauri()) mcpConfig.value = await storeNativeMcpConfig(config)
    else { storeBrowserMcpConfig(config); mcpConfig.value = config }
    mcpConfigReady.value = true; mcpSettingsOpen.value = false
    status.value = 'MCP 设置已保存；请在当前文档中开启服务。'
  } catch (cause) { mcpSettingsError.value = message(cause) }
  finally { mcpSettingsBusy.value = false }
}
async function toggleMcp() {
  try {
    if (mcpState.value.phase !== 'stopped' && mcpState.value.phase !== 'error') { await mcpService.stop(); return }
    if (!native.isTauri()) { openMcpSettings(); return }
    if (documentActionsDisabled.value || !currentDocument.value) return
    if (!mcpConfigReady.value) await readMcpSettings()
    if (!mcpConfigReady.value) { openMcpSettings(); return }
    const tab = currentDocument.value
    if (!tab?.ready || globalActionsBlocked.value) return
    await mcpService.start(mcpConfig.value, { id:tab.key,kind:tab.document.kind,title:tab.document.name }, catalogForKind(tab.document.kind))
  } catch (cause) { error.value = message(cause) }
}
watch([activeKey, home], () => { void mcpService.contextChanged().catch(cause => { error.value = message(cause) }) }, { flush:'sync' })
let mcpHeartbeatTimer:ReturnType<typeof setInterval>|undefined
onMounted(() => {
  void readMcpSettings()
  mcpHeartbeatTimer = setInterval(() => { void mcpService.heartbeat() }, 5000)
})
onBeforeUnmount(() => { clearInterval(mcpHeartbeatTimer); void mcpService.dispose().catch(() => undefined) })
async function editorTransaction<T>(label:string, work:()=>Promise<T>, preserveInput=false):Promise<T> {
  if (busy.value) throw Error('正在处理另一项文档操作，请等待完成。')
  backgroundSaving.value=preserveInput
  error.value=''; busy.value=label
  try {
    // Native verification uses this same input barrier as user actions.
    // Do not suppress dirty events or replace a failed revision with a newer one.
    const focused=document.activeElement
    if(!preserveInput&&focused instanceof HTMLElement) focused.blur()
    await nextTick()
    return await work()
  } finally {
    busy.value='';backgroundSaving.value=false
    if(pendingWindowClose) {pendingWindowClose=false;void closeWindow()}
  }
}
async function task(label:string, work:()=>Promise<void>) {
  if (busy.value) return
  try { await editorTransaction(label,work) } catch(e) { error.value=message(e) }
}
function nativeTransactionalEditor<T extends object>(handle:T):T {
  return new Proxy(handle,{get(target,key,receiver){
    const value=Reflect.get(target,key,receiver)
    if(typeof value!=='function')return value
    // Programmatic edits already carry their captured revision. Do not insert
    // another focus/render await between constructing that intent and sending it.
    // File snapshots use the same barrier as the user-facing Save command.
    if(key!=='exportFile')return value.bind(target)
    return (...args:unknown[])=>editorTransaction('正在验证本机文档操作',()=>value.apply(target,args))
  }})
}
function dirtyFor(id:string|undefined, value:boolean) {
  const tab=tabs.value.find(t=>t.key===id)
  if(tab && value) tab.dirty=true
}
function readyFor(id:string|undefined) { const tab=tabs.value.find(t=>t.key===id); if(tab) {tab.ready=true;tab.loadError=undefined;smokeStage('editor-ready',tab.document.kind)} }
function editorError(id:string|undefined,value:string) {
  error.value=value
  const tab=tabs.value.find(t=>t.key===id)
  if(tab&&!tab.ready)tab.loadError=value
  smokeStage('editor-error',value)
}
function requireEditor(tab:Tab) {
  if(!tab.ready)throw Error(tab.loadError?'该文档未成功打开，无法保存。可以重试、关闭此标签或切回其他文档。':'文档仍在打开，请等待编辑器就绪后再保存或切换。')
  const handle=editor()
  if(!handle||activeKey.value!==tab.key)throw Error('当前文档尚未准备好。')
  return handle
}
async function awaitReady(tab:Tab):Promise<void> {
  if(tab.loadError)throw Error(tab.loadError)
  if(tab.ready)return
  await new Promise<void>((resolve,reject)=>{
    let stop=()=>{}
    const finish=(failure?:Error)=>{clearTimeout(timeout);stop();failure?reject(failure):resolve()}
    const timeout=setTimeout(()=>finish(Error('文档打开超时，未保存内容仍保留，请重试或取消关闭。')),120000)
    stop=watch(()=>[tab.ready,tab.loadError,activeKey.value] as const,([ready,failure,key])=>{
      if(key!==tab.key)finish(Error('文档已切换，本次保存已取消。'))
      else if(failure)finish(Error(failure))
      else if(ready)finish()
    },{flush:'post'})
  })
}
async function capture(tab:Tab) {
  const format=defaultSaveExtension(tab.document.extension,tab.document.kind)
  const handle=requireEditor(tab), exported=await handle.exportFile({format})
  if(activeKey.value!==tab.key)throw Error('文档已切换，旧的导出结果未被使用。')
  if(exported.extension!==format)throw Error('编辑器返回的快照格式与当前文档不一致，切换已取消。')
  if(exported.dirty)tab.dirty=true
  return {handle,exported,document:{...tab.document,name:withExtension(tab.document.name,exported.extension),base64:exported.base64,extension:exported.extension,sizeBytes:Math.floor(exported.base64.length*.75)}}
}
async function stash() {
  const tab=active.value
  if(!tab || tab.loadError) return
  // Every open tab retains its live model and undo history. Settle queued input
  // before hiding it, but leave file bytes, identity and save receipts untouched.
  const handle=requireEditor(tab), snapshot=await handle.prepareDeactivate()
  if(activeKey.value!==tab.key||handleFor(tab)!==handle)throw Error('文档已切换，本次切换已取消。')
  // Notifications can lag behind the final input batch; a new unsaved document
  // must also remain dirty even when its initial engine model is unchanged.
  if(snapshot.dirty)tab.dirty=true
}
async function activate(tab:Tab) {
  if(activeKey.value!==tab.key) {
    await stash()
    activeKey.value=tab.key
    const kind=tab.document.kind
    const entries=kind==='word'?rustWordEntries.value:kind==='sheet'?rustSheetEntries.value:kind==='presentation'?rustPresentationEntries.value:kind==='pdf'?rustPdfEntries.value:kind==='note'?noteEntries.value:kind==='schedule'?scheduleEntries.value:workflowEntries.value
    const reusable=entries.some(entry=>entry.document.id===tab.key)
    if(!reusable){tab.ready=false;tab.loadError=undefined}
    if(kind==='word')setRustWordDocument(tab.document)
    else if(kind==='sheet')setRustSheetDocument(tab.document)
    else if(kind==='presentation')setRustPresentationDocument(tab.document)
    else if(kind==='pdf')setRustPdfDocument(tab.document)
    else if(kind==='note')setNoteDocument(tab.document)
    else if(kind==='schedule')setScheduleDocument(tab.document)
    else setWorkflowDocument(tab.document)
    await nextTick()
  }
  home.value=false
}
async function addDocument(doc:NativeDocument, fileId?:string) {
  // Validate the format family before touching any active document or session.
  doc={...doc}
  if(extensionOf(doc.name)!==doc.extension)throw Error('文件名、格式与文档类型不一致，无法打开。')
  const sharedEnvelope=doc.extension==='owflow'||doc.extension==='json'
  const expectedKind=sharedEnvelope&&doc.base64?documentKindOf(base64ToBytes(doc.base64),doc.extension):doc.extension==='owflow'&&isWorkflowKind(doc.kind)?doc.kind:kindOf(doc.extension)
  if(expectedKind!==doc.kind)throw Error('文件名、格式与文档类型不一致，无法打开。')
  const existing=fileId && tabs.value.find(t=>t.fileId===fileId)
  if(existing) { await activate(existing); return existing }
  // Rust engines support eight live models per document kind.
  if(tabs.value.filter(tab=>tab.document.kind===doc.kind).length>=8)throw Error('同一类型最多同时打开 8 份文档，请先保存并关闭其中一份。')
  const key=createId()
  let wordPrepared:PreparedRustWordDocument|undefined
  let sheetPrepared:PreparedRustSheetDocument|undefined
  let presentationPrepared:PreparedRustPresentationDocument|undefined
  let pdfPrepared:PreparedRustPdfDocument|undefined
  let workflowWarnings:string[]=[]
  try {
    // Every Rust parser prepares an isolated model before the active tab is touched.
    if(doc.kind==='word')wordPrepared=await prepareRustWordDocument({...doc,id:key})
    else if(doc.kind==='sheet')sheetPrepared=await prepareRustSheetDocument({...doc,id:key})
    else if(doc.kind==='presentation')presentationPrepared=await prepareRustPresentationDocument({...doc,id:key})
    else if(doc.kind==='pdf')pdfPrepared=await prepareRustPdfDocument({...doc,id:key})
    else if(doc.kind==='schedule'&&doc.base64)decodeSchedule(base64ToBytes(doc.base64))
    else if(doc.kind==='note'&&doc.base64)decodeNotebook(base64ToBytes(doc.base64))
    else if(isWorkflowKind(doc.kind)&&doc.base64) {
      const imported=importWorkflowText(doc.name,new TextDecoder('utf-8',{fatal:true}).decode(base64ToBytes(doc.base64)))
      if(imported.documents.length!==1)throw Error('请通过打开文件导入多页画布。')
      workflowWarnings=imported.warnings
    }
    if(appDisposed)return
    const requiresConversion=isImportOnly(doc.extension)||defaultSaveExtension(doc.extension,doc.kind)!==doc.extension
    const importWarnings=[...(requiresConversion?['此格式需要转换后保存，原文件保留。']:[]),...(sheetPrepared?.warnings??presentationPrepared?.warnings??pdfPrepared?.warnings??workflowWarnings)]
    const tab:Tab={key,document:{...doc,id:key},fileId,requiresSaveAs:requiresConversion,importWarnings,dirty:!fileId,ready:false}
    await stash()
    if(appDisposed)return
    tabs.value.push(tab); const storedTab=tabs.value[tabs.value.length-1]!; activeKey.value=key; home.value=false
    if(doc.kind==='word') {setRustWordDocument(tab.document,wordPrepared);wordPrepared=undefined}
    else if(doc.kind==='sheet') {setRustSheetDocument(tab.document,sheetPrepared);sheetPrepared=undefined}
    else if(doc.kind==='presentation') {setRustPresentationDocument(tab.document,presentationPrepared);presentationPrepared=undefined}
    else if(doc.kind==='pdf') {setRustPdfDocument(tab.document,pdfPrepared);pdfPrepared=undefined}
    else if(doc.kind==='note')setNoteDocument(tab.document)
    else if(doc.kind==='schedule')setScheduleDocument(tab.document)
    else setWorkflowDocument(tab.document)
    return storedTab
  } finally {
    // Failed preflight/stash or disposal must not retain an undelivered model.
    wordPrepared?.discard()
    sheetPrepared?.discard()
    presentationPrepared?.discard()
    pdfPrepared?.discard()
  }
}
function newDocument(kind:Kind) {
  void task('正在新建文档',async()=>{
    const extension:Extension=kind==='word'?'docx':kind==='sheet'?'xlsx':kind==='presentation'?'pptx':kind==='pdf'?'pdf':kind==='note'?'oonote':kind==='schedule'?'ooschedule':'owflow'
    const number=tabs.value.filter(t=>t.document.kind===kind).length+1
    await addDocument({id:'',kind,extension,name:`未命名${kindNames[kind]}${number}.${extension}`,base64:'',sha256:'',sizeBytes:0})
  })
}
async function refreshRecents() { if(native.isTauri()) recents.value=await native.listRecentDocuments() }
async function openImportedDocument(doc:NativeDocument,fileId?:string) {
  if(isWorkflowKind(doc.kind)&&doc.base64) {
    const imported=importWorkflowText(doc.name,new TextDecoder('utf-8',{fatal:true}).decode(base64ToBytes(doc.base64)))
    if(imported.documents.length>1) {
      // Validate every imported page and the tab budget before changing the workspace.
      const pages=imported.documents.map((page,index)=>({page,bytes:workflowBytes(page),name:`${doc.name.replace(/\.[^.]+$/,'')} - ${index+1}.owflow`}))
      if(tabs.value.filter(tab=>tab.document.kind==='canvas').length+pages.length>8)throw Error(`文件含 ${pages.length} 页画布，同时打开将超过 8 份，请先关闭其他画布或拆分文件。`)
      for(const {page,bytes,name} of pages) {
        const tab=await addDocument({id:'',name,kind:page.kind==='mermaid'?'diagram':'canvas',extension:'owflow',base64:bytesToBase64(bytes),sha256:'',sizeBytes:bytes.length})
        if(tab){tab.requiresSaveAs=true;tab.importWarnings=['已按页面导入独立画布，保存时选择新位置，原文件保留。',...imported.warnings];await nextTick();await awaitReady(tab)}
      }
      return
    }
  }
  await addDocument(doc,fileId)
}
function createCanvasCopy(model:WorkflowDocument) {
  if(globalActionsBlocked.value)return
  void task('正在创建画布副本',async()=>{
    const bytes=workflowBytes(model)
    await addDocument({id:'',name:`${Array.from(model.title.replace(/[\x00-\x1f/\\:<>"|?*]/g,' ').trim()).slice(0,60).join('')||'图表'} - 画布.owflow`,kind:'canvas',extension:'owflow',base64:bytesToBase64(bytes),sha256:'',sizeBytes:bytes.length})
  })
}
function exportWorkflowCopy(id:string,output:EditorExport) {
  if(globalActionsBlocked.value||home.value||id!==activeKey.value)return
  void task('正在导出图片',async()=>{
    if(!['svg','png'].includes(output.extension))throw Error('不支持此图片格式。')
    const tab=active.value;if(!tab||tab.key!==id||!isWorkflowKind(tab.document.kind))return
    validateDocumentSignature(base64ToBytes(output.base64),output.extension)
    const name=withExtension(tab.document.name,output.extension)
    if(!native.isTauri()){download(output.base64,name);status.value='图片已生成下载文件';return}
    const result=await native.saveDocument({name,extension:output.extension,base64:output.base64,saveAs:true,protectedDocumentIds:tabs.value.flatMap(tab=>tab.fileId?[tab.fileId]:[])})
    if(result.status==='conflict')throw Error(result.message)
    if(result.status==='saved')status.value='图片副本已保存'
  })
}
function exportScheduleCopy(id:string,format:'json'|'png') {
  if(globalActionsBlocked.value||home.value||id!==activeKey.value)return
  void task(format==='png'?'正在导出完整排期图片':'正在导出排期数据',async()=>{
    const tab=active.value;if(!tab||tab.key!==id||tab.document.kind!=='schedule')return
    const output=await requireEditor(tab).exportFile({format})
    if(output.extension!==format)throw Error('排期导出格式与请求不符。')
    const bytes=base64ToBytes(output.base64)
    validateDocumentSignature(bytes,format)
    if(format==='json')decodeSchedule(bytes)
    const name=withExtension(tab.document.name,format), label=format==='png'?'整张排期表 PNG':'排期 JSON 数据'
    if(!native.isTauri()){download(output.base64,name);status.value=`${label}已生成下载文件`;return}
    const result=await native.saveDocument({name,extension:format,base64:output.base64,saveAs:true,protectedDocumentIds:tabs.value.flatMap(tab=>tab.fileId?[tab.fileId]:[])})
    if(result.status==='conflict')throw Error(result.message)
    if(result.status==='saved')status.value=`${label}副本已保存`
  })
}
function importSchedule(id:string) {
  if(globalActionsBlocked.value||home.value||id!==activeKey.value)return
  if(!native.isTauri()){scheduleImportInput.value?.click();return}
  void task('正在导入排期',async()=>{
    const doc=await native.openDocument()
    if(!doc)return
    if(!['ooschedule','json'].includes(doc.extension)||doc.kind!=='schedule')throw Error('请选择 .ooschedule 或导出的排期 JSON 文件。')
    await openImportedDocument(doc,doc.id)
    await refreshRecents()
  })
}
async function browserScheduleFile(event:Event) {
  const input=event.target as HTMLInputElement, file=input.files?.[0];input.value=''
  if(!file)return
  await task('正在导入排期',async()=>{
    const extension=extensionOf(file.name)
    if(!['ooschedule','json'].includes(extension))throw Error('请选择 .ooschedule 或导出的排期 JSON 文件。')
    if(file.size>4*1024*1024)throw Error('排期文件不能超过 4 MiB。')
    const bytes=new Uint8Array(await file.arrayBuffer())
    decodeSchedule(bytes)
    await openImportedDocument({id:'',name:file.name,extension,kind:'schedule',base64:bytesToBase64(bytes),sha256:'',sizeBytes:file.size})
  })
}
function openFile() {
  if(native.isTauri()) void task('正在打开文件',async()=>{
    const document=await native.openDocument(); if(document) await openImportedDocument(document,document.id)
    await refreshRecents()
  })
  else fileInput.value?.click()
}
async function browserFile(event:Event) {
  const input=event.target as HTMLInputElement, file=input.files?.[0]; input.value=''
  if(!file) return
  await task('正在读取文件',async()=>{
    const extension=extensionOf(file.name)
    if(file.size>40*1024*1024) throw Error('请选择不超过 40 MB 的文档。')
    const bytes=new Uint8Array(await file.arrayBuffer())
    validateDocumentSignature(bytes,extension)
    await openImportedDocument({id:'',name:file.name,extension,kind:documentKindOf(bytes,extension),base64:bytesToBase64(bytes),sha256:'',sizeBytes:file.size})
  })
}
function openRecent(item:RecentDocument) { void task('正在打开最近文件',async()=>{const doc=await native.openRecent(item.id);await openImportedDocument(doc,doc.id);await refreshRecents()}) }
function download(base64:string,name:string) {
  const url=URL.createObjectURL(new Blob([base64ToBytes(base64).buffer as ArrayBuffer])), link=document.createElement('a')
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000)
}
async function saveActive(saveAs=false, format?:Extension, chosenName?:string, directOnly?:AutosaveTarget):Promise<boolean> {
  const tab=active.value;if(!tab)return false
  const directAllowed=()=>native.isTauri()&&tab.key===directOnly?.key&&tab.fileId===directOnly?.fileId&&!tab.requiresSaveAs&&!isImportOnly(tab.document.extension)&&defaultSaveExtension(tab.document.extension,tab.document.kind)===tab.document.extension
  if(directOnly&&!directAllowed())return false
  const requestedFormat=format||defaultSaveExtension(tab.document.extension,tab.document.kind)
  if(!formatsFor(tab).some(option=>option.extension===requestedFormat))throw Error('当前编辑器不支持此保存格式。')
  const handle=requireEditor(tab)
  if(directOnly&&!await handle.canBackgroundExport?.())return false
  const exported=await handle.exportFile({format:requestedFormat,...(directOnly?{background:true}:{})})
  if(activeKey.value!==tab.key)throw Error('文档已切换，本次保存已取消。')
  if(exported.extension!==requestedFormat)throw Error('编辑器返回的格式与所选格式不一致，保存已取消。')
  if(directOnly&&(!directAllowed()||exported.saveAs||exported.extension!==tab.document.extension))return false
  if(exported.dirty)tab.dirty=true
  const isCopy=(tab.document.kind==='sheet'&&['csv','tsv','pdf'].includes(requestedFormat))||(isWorkflowKind(tab.document.kind)&&requestedFormat!=='owflow')||(!!format && format!==tab.document.extension)
  const protectSource=tab.requiresSaveAs||isImportOnly(tab.document.extension)
  // The shell owns the saved filename; editor snapshots may still carry the
  // original import name after a same-format Save As.
  const exportName=withExtension(tab.document.name||exported.name||'未命名',exported.extension)
  const name=chosenName||(protectSource?exportName.replace(/\.[^.]+$/,` - 副本.${exported.extension}`):exportName)
  if(!native.isTauri()) {
    download(exported.base64,name)
    if(!isCopy) { tab.document={...tab.document,base64:exported.base64,name,extension:exported.extension};tab.requiresSaveAs=false;tab.importWarnings=[];await handle.markSaved?.(exported.base64);tab.dirty=(isWorkflowKind(tab.document.kind)||tab.document.kind==='schedule')?!!(await handle.inspect?.())?.dirty:false }
    status.value='已生成下载文件';return true
  }
  const request:SaveDocumentRequest={documentId:isCopy||protectSource?undefined:tab.fileId,name,extension:exported.extension,base64:exported.base64,expectedSha256:isCopy||protectSource?undefined:tab.document.sha256,saveAs:saveAs||isCopy||protectSource||exported.saveAs||!tab.fileId}
  const protectedDocumentIds=[...new Set(tabs.value.filter(other=>(other.key!==tab.key||isCopy||protectSource)&&other.fileId).map(other=>other.fileId!))]
  if(protectedDocumentIds.length)request.protectedDocumentIds=protectedDocumentIds
  const result=await native.saveDocument(request)
  if(smokeMode.value)nativeSmokeSaveObserver?.(request,result)
  if(result.status==='cancelled') return false
  if(result.status==='conflict') { error.value=`${result.message} 请使用“另存为”保留当前修改。`;return false }
  if(!isCopy) {
    tab.fileId=result.document.id
    tab.document={...result.document,id:tab.key,base64:exported.base64}
    tab.requiresSaveAs=false
    tab.importWarnings=[]
    await handle.markSaved?.(exported.base64,directOnly?{background:true}:undefined);tab.dirty=(isWorkflowKind(tab.document.kind)||tab.document.kind==='schedule')?!!(await handle.inspect?.())?.dirty:false
    if(!directOnly){tab.autoSavedAt=undefined;autosaveWaiting.value=undefined}
  }
  await refreshRecents();status.value=isCopy?`${exported.extension.toUpperCase()} 副本已保存`:'已保存到本机';return true
}
function openSaveAs() {
  const tab=active.value
  if(!tab?.ready||busy.value||closeTarget.value)return
  const formats=formatsFor(tab), preferred=defaultSaveExtension(tab.document.extension,tab.document.kind)
  saveAsDraft.value={key:tab.key,kind:tab.document.kind,format:formats.find(option=>option.extension===preferred)?.extension||formats[0]!.extension,
    name:tab.document.name.replace(/\.[^.]+$/,'')+(tab.requiresSaveAs||isImportOnly(tab.document.extension)?' - 副本':''),error:''}
}
async function confirmSaveAs() {
  const draft=saveAsDraft.value
  if(!draft||busy.value)return
  try {
    if(activeKey.value!==draft.key||active.value?.document.kind!==draft.kind)throw Error('文档已经切换，请关闭此窗口后重新选择另存为。')
    if(!formatsFor(active.value).some(option=>option.extension===draft.format))throw Error('请选择当前文档支持的格式。')
    const name=saveFileName(draft.name,draft.format)
    draft.error=''
    await editorTransaction('正在另存文档',async()=>{
      if(activeKey.value!==draft.key)throw Error('文档已经切换，保存已取消。')
      const format=draft.format===defaultSaveExtension(active.value!.document.extension,active.value!.document.kind)?undefined:draft.format
      if(await saveActive(true,format,name))saveAsDraft.value=null
      else if(error.value)draft.error=error.value
    })
  }catch(cause){draft.error=message(cause)}
}
function cancelSaveAs(){if(!busy.value)saveAsDraft.value=null}
function save(saveAs=false,format?:Extension) {
  if(saveAs&&!format){openSaveAs();return}
  void task(format?`正在导出 ${format.toUpperCase()}`:'正在保存文档',async()=>{await saveActive(saveAs,format)})
}
function previewSlides(startPage=0) {
  void task('正在准备放映',async()=>{
    const tab=active.value
    if(tab?.document.kind!=='presentation')return
    const handle=rustPresentationHandles.get(tab.key)
    if(!tab.ready||!handle)throw Error('演示文稿编辑器尚未就绪。')
    await handle.present(startPage)
  })
}
async function refreshPresentationTemplates() {
  const request = ++templateListRequest
  templateListLoading.value = true; templateListError.value = ''
  try {
    const items = await listPresentationTemplates()
    if (!appDisposed && request === templateListRequest) presentationTemplates.value = items
  } catch (cause) {
    if (!appDisposed && request === templateListRequest) templateListError.value = message(cause)
  } finally {
    if (!appDisposed && request === templateListRequest) templateListLoading.value = false
  }
}
function togglePresentationTemplates() {
  if (documentActionsDisabled.value || !activeRustPresentation.value) return
  templatePanelOpen.value = !templatePanelOpen.value
  if (templatePanelOpen.value) void refreshPresentationTemplates()
}
function openPresentationTemplateDialog(kind:'save'|'apply'|'delete', template?:PresentationTemplate) {
  const tab = currentDocument.value
  if (documentActionsDisabled.value || tab?.document.kind !== 'presentation') return
  if (kind === 'save') templateDraft.value = { kind, key:tab.key, name:Array.from(tab.document.name.replace(/\.[^.]+$/, '')).slice(0,60).join(''), error:'' }
  else if (template && (kind !== 'delete' || template.source === 'custom')) templateDraft.value = { kind, key:tab.key, template, error:'' }
}
function cancelPresentationTemplateDialog() { if (!busy.value) templateDraft.value = null }
async function confirmPresentationTemplate() {
  const draft = templateDraft.value
  if (!draft || busy.value) return
  draft.error = ''
  try {
    const name = draft.kind === 'save' ? normalizePresentationTemplateName(draft.name) : ''
    await editorTransaction(draft.kind === 'save' ? '正在保存模板' : draft.kind === 'apply' ? '正在切换模板' : '正在删除模板', async () => {
      const tab = currentDocument.value, handle = rustPresentationHandles.get(draft.key)
      if (!tab?.ready || tab.key !== draft.key || tab.document.kind !== 'presentation' || !handle) throw Error('当前演示文稿已切换，请重新选择模板操作。')
      if (draft.kind === 'save') {
        const exported = await handle.exportFile({format:'pptx'}), snapshot = await handle.inspect()
        if (exported.extension !== 'pptx' || exported.revision !== `${snapshot.documentId}:${snapshot.revision}`) throw Error('演示内容已变化，请重新保存模板。')
        await savePresentationTemplate({name,base64:exported.base64,slideCount:snapshot.slides.length})
        status.value = `已将“${name}”保存到我的模板`
      } else if (draft.kind === 'apply') {
        const source = await loadPresentationTemplate(draft.template)
        if (currentDocument.value?.key !== draft.key) throw Error('当前演示文稿已切换，模板切换已取消。')
        const snapshot = await handle.applyTemplate(source.base64)
        tab.dirty = snapshot.dirty; tab.autoSavedAt = undefined
        tab.importWarnings = [...(snapshot.warnings ?? [])]
        autosaveWaiting.value = undefined
        status.value = `已切换为“${draft.template.name}”，可通过撤销恢复`
      } else {
        await deletePresentationTemplate(draft.template.id)
        status.value = `已删除模板“${draft.template.name}”`
      }
      templateDraft.value = null
      if (draft.kind !== 'apply') await refreshPresentationTemplates()
    })
  } catch (cause) {
    if (templateDraft.value === draft) {
      draft.error = message(cause)
      await nextTick()
      templateDialog.value?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus()
    }
  }
}
function changeTab(tab:Tab) {void task('正在切换文档',()=>activate(tab))}
async function removeTab(tab:Tab, discardConfirmed=false) {
  if(tab.key===activeKey.value) {
    if(tab.ready)await editor()?.discardChanges?.({force:discardConfirmed})
    await rustPresentationHandles.get(tab.key)?.stopPresentation()
    const next=tabs.value.find(t=>t.key!==tab.key)
    // Do not settle a tab whose close was already checked/confirmed.
    activeKey.value=''
    if(next) await activate(next)
    else home.value=true
  }
  tabs.value=tabs.value.filter(t=>t.key!==tab.key)
  noteEntries.value=noteEntries.value.filter(entry=>entry.document.id!==tab.key)
  workflowEntries.value=workflowEntries.value.filter(entry=>entry.document.id!==tab.key)
  scheduleEntries.value=scheduleEntries.value.filter(entry=>entry.document.id!==tab.key)
  for(const entries of [rustWordEntries,rustSheetEntries,rustPresentationEntries,rustPdfEntries]) {
    for(const entry of entries.value)if(entry.document.id===tab.key)entry.prepared?.discard()
    entries.value=entries.value.filter(entry=>entry.document.id!==tab.key) as typeof entries.value
  }
  rustWordHandles.delete(tab.key);rustSheetHandles.delete(tab.key);rustPresentationHandles.delete(tab.key);rustPdfHandles.delete(tab.key);noteHandles.delete(tab.key);workflowHandles.delete(tab.key);scheduleHandles.delete(tab.key)
}
function closeTab(tab:Tab) {
  if(busy.value)return
  if(tab.dirty) {closeTarget.value=tab;return}
  void task('正在检查文档',async()=>{
    if(tab.key===activeKey.value&&tab.ready) {
      try {const snapshot=await capture(tab);tab.document=snapshot.document}
      catch(e) {tab.dirty=true;error.value=message(e);closeTarget.value=tab;return}
    }
    if(tab.dirty) {closeTarget.value=tab;return}
    await removeTab(tab)
  })
}
const closeDocuments = computed(() => {
  const target=closeTarget.value
  return typeof target==='string'?tabs.value.filter(tab=>tab.dirty):target?[target]:[]
})
const closeBatch = computed(() => typeof closeTarget.value==='string')
async function removeTabs(selected:Tab[], discardConfirmed=false) {
  const keys=new Set(selected.map(tab=>tab.key))
  // Release all drafts before removing any tab. Batch discard never serializes,
  // saves, or activates a document that the user chose to discard.
  for(const tab of selected) {
    await rustPresentationHandles.get(tab.key)?.stopPresentation()
    if(tab.ready)await handleFor(tab)?.discardChanges?.({force:discardConfirmed})
  }
  if(keys.has(activeKey.value))activeKey.value=''
  tabs.value=tabs.value.filter(tab=>!keys.has(tab.key))
  for(const entries of [rustWordEntries,rustSheetEntries,rustPresentationEntries,rustPdfEntries]) {
    for(const entry of entries.value)if(keys.has(entry.document.id))entry.prepared?.discard()
    entries.value=entries.value.filter(entry=>!keys.has(entry.document.id)) as typeof entries.value
  }
  noteEntries.value=noteEntries.value.filter(entry=>!keys.has(entry.document.id))
  workflowEntries.value=workflowEntries.value.filter(entry=>!keys.has(entry.document.id))
  scheduleEntries.value=scheduleEntries.value.filter(entry=>!keys.has(entry.document.id))
  for(const key of keys)for(const handles of [rustWordHandles,rustSheetHandles,rustPresentationHandles,rustPdfHandles,noteHandles,workflowHandles,scheduleHandles])handles.delete(key)
  if(!tabs.value.length)home.value=true
  else if(!activeKey.value)await activate(tabs.value[0]!)
}
async function closeAllTabs() {
  if(globalActionsBlocked.value||!tabs.value.length)return
  await task('正在检查未保存修改',async()=>{
    await rustPresentationHandles.get(activeKey.value)?.stopPresentation()
    const tab=active.value
    if(tab?.ready) {
      try {const snapshot=await capture(tab);tab.document=snapshot.document}
      catch(cause) {tab.dirty=true;error.value=message(cause)}
    }
    if(tabs.value.some(tab=>tab.dirty))closeTarget.value='all'
    else await removeTabs([...tabs.value])
  })
}
async function closeWindow() {
  await mcpService.stop().catch(cause => { error.value = message(cause) })
  if(busy.value) {pendingWindowClose=true;return}
  saveAsDraft.value=null
  templateDraft.value=null
  await task('正在检查未保存修改',async()=>{
    // Stop the show inside the same input barrier as the unsaved-content check.
    await rustPresentationHandles.get(activeKey.value)?.stopPresentation()
    const tab=active.value
    if(tab?.ready) {
      try {const snapshot=await capture(tab);tab.document=snapshot.document}
      catch(e) {tab.dirty=true;error.value=message(e)}
    }
    if(tabs.value.some(t=>t.dirty))closeTarget.value='window'
    else await native.confirmClose()
  })
}
async function resolveClose(action:'save'|'discard') {
  const target=closeTarget.value;if(!target)return
  await task(action==='save'?'正在保存未完成的文档':'正在关闭',async()=>{
    if(target==='window'||target==='all') {
      if(action==='save') for(const tab of tabs.value.filter(t=>t.dirty)) {await activate(tab);await awaitReady(tab);if(!await saveActive())return}
      if(target==='window')await native.confirmClose()
      else await removeTabs([...tabs.value],action==='discard')
      closeTarget.value=null
    } else {
      if(action==='save') {await activate(target);await awaitReady(target);if(!await saveActive())return}
      await removeTab(target,action==='discard');closeTarget.value=null
    }
  })
}
function editCommand(command:'undo'|'redo'|'print') {
  if (documentActionsDisabled.value) return
  void task(command === 'print' ? '正在准备打印' : '正在处理', async () => {
    const current = editor()
    if (command === 'print') {
      if (typeof current?.print !== 'function') throw Error('当前文档尚不能打印，请等待编辑器准备完成后重试。')
      const result = await current.print()
      status.value = result.status === 'cancelled' ? '已取消打印' : result.status === 'completed' ? '打印已提交给系统' : '已打开打印窗口'
    } else await current?.[command]?.()
  })
}
function rustEditorFileAction(action:string) {
  if(globalActionsBlocked.value)return
  if(action==='save')save()
  else if(action==='saveAs')save(true)
  else if(action==='exportPdf')save(true,'pdf')
  else if(action==='open')openFile()
  else if(action==='new'&&active.value)newDocument(active.value.document.kind)
  else if(action==='print')editCommand('print')
  else if(action==='close'&&active.value)closeTab(active.value)
}
function keydown(event:KeyboardEvent) {
  if(event.defaultPrevented)return
  const key=event.key.toLowerCase()
  const fileShortcut=((event.ctrlKey||event.metaKey)&&!event.altKey&&['n','o','s','p'].includes(key))||(activeRustEditor.value&&event.key==='F12')
  const presentationShortcut=event.key==='F5'&&activeRustPresentation.value&&!home.value
  if(globalActionsBlocked.value){if(fileShortcut||presentationShortcut)event.preventDefault();return}
  if(presentationShortcut) {
    if(event.target instanceof Element&&event.target.closest('.rust-presentation-editor'))return
    event.preventDefault();previewSlides();return
  }
  if(activeRustEditor.value&&!home.value&&event.key==='F12') {
    if(event.target instanceof Element&&event.target.closest('.rust-word-editor,.rust-sheet-editor,.rust-presentation-editor,.rust-pdf-editor'))return
    event.preventDefault()
    if(!busy.value&&!closeTarget.value&&!help.value)save(true)
    return
  }
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return
  if(activeRustEditor.value&&!home.value) {
    // The canvas and its text agent report file actions themselves. Shell controls
    // have no engine listener, so handle their shortcuts here exactly once.
    if(event.target instanceof Element&&event.target.closest('.rust-word-editor,.rust-sheet-editor,.rust-presentation-editor,.rust-pdf-editor'))return
    if(!fileShortcut)return
    event.preventDefault()
    if(busy.value||closeTarget.value||help.value)return
    rustEditorFileAction(key==='n'?'new':key==='o'?'open':key==='p'?'print':event.shiftKey?'saveAs':'save')
    return
  }
  if(key==='o'){event.preventDefault();globalFileAction('open')}
  if(key==='s'){event.preventDefault();globalFileAction(event.shiftKey?'saveAs':'save')}
  if(key==='n'){
    event.preventDefault()
    if(currentDocument.value)globalNewDocument(currentDocument.value.document.kind)
    else {newMenu.value?.setAttribute('open','');newMenu.value?.querySelector('button')?.focus()}
  }
  if(key==='p'&&currentDocument.value){event.preventDefault();globalFileAction('print')}
}
function beforeUnload(event:BeforeUnloadEvent){if(tabs.value.some(t=>t.dirty)){event.preventDefault();event.returnValue=''}}
const lastInputAt = ref(0)
function inputActivity(event: Event) {
  if (!(event.target instanceof Element) || !event.target.closest('.editor-content')) return
  lastInputAt.value = Date.now()
  if(event.type==='compositionstart')composing.value=true
  if(event.type==='compositionend')composing.value=false
}
function handleFor(tab: Tab) {
  return (tab.document.kind==='word'?rustWordHandles:tab.document.kind==='sheet'?rustSheetHandles:
    tab.document.kind==='presentation'?rustPresentationHandles:tab.document.kind==='pdf'?rustPdfHandles:tab.document.kind==='note'?noteHandles:tab.document.kind==='schedule'?scheduleHandles:workflowHandles).get(tab.key)
}
const autosaveEnabled=ref((()=>{try{return localStorage.getItem('open-office-autosave')==='true'}catch{return false}})())
const autosaveWaiting=ref<{key:string;reason:string}>()
const autosaveTitle=computed(()=>native.isTauri()?'每 10 秒将修改保存回当前文件；输入或弹窗期间暂缓，完成编辑后自动继续。新建文件请先选择保存位置。':'浏览器编辑请使用保存按钮下载；桌面版支持直接保存原文件。')
const saveStateLabel=computed(()=>{
  const tab=currentDocument.value
  if(!tab)return '本地办公'
  if(tab.loadError)return '打开失败'
  if(!tab.ready)return '正在载入'
  if(backgroundSaving.value)return '正在自动保存'
  if(!tab.dirty)return tab.autoSavedAt?'已自动保存':'已保存'
  if(!autosaveEnabled.value||!native.isTauri())return '尚未保存'
  if(!tab.fileId||tab.requiresSaveAs||defaultSaveExtension(tab.document.extension,tab.document.kind)!==tab.document.extension)return '请先保存'
  if(composing.value)return '等待输入完成'
  if(autosaveWaiting.value?.key===tab.key)return autosaveWaiting.value.reason
  return '等待自动保存'
})
const saveStateTitle=computed(()=>{
  const tab=currentDocument.value
  if(!tab)return '文件保存在本机'
  if(saveStateLabel.value==='请先保存')return '请先点击保存，选择保存位置或完成格式转换，之后即可自动保存。'
  if(saveStateLabel.value==='等待完成编辑')return '请确认当前单元格、文本框或弹窗中的编辑；自动保存会在完成后继续，当前输入不会被打断。'
  if(!tab.dirty&&tab.autoSavedAt)return `${tab.document.name} · ${new Date(tab.autoSavedAt).toLocaleTimeString()} 已自动保存到本机`
  return `${tab.document.name} · ${saveStateLabel.value}`
})
const autosave=createAutosaveScheduler({
  readState(){const tab=active.value;return {enabled:autosaveEnabled.value,native:native.isTauri(),key:tab?.key,fileId:tab?.fileId,
    dirty:!!tab?.dirty,ready:!!tab?.ready,requiresSaveAs:!!tab?.requiresSaveAs,
    canSaveDirectly:!!tab&&!!handleFor(tab)&&!isImportOnly(tab.document.extension)&&defaultSaveExtension(tab.document.extension,tab.document.kind)===tab.document.extension,
    busy:!!busy.value,modal:!!saveAsDraft.value||!!templateDraft.value||!!closeTarget.value||help.value||mcpSettingsOpen.value,
    composing:composing.value||Date.now()-lastInputAt.value<1200,remoteEditing:mcpWorking.value}},
  async save(target){
    const tab=active.value
    // A pause inside an unfinished cell, text box or form is not confirmation.
    // Check before the shell's input barrier; the editor checks again atomically
    // when exporting and acknowledging the saved bytes.
    if(!tab||tab.key!==target.key||tab.fileId!==target.fileId)return 'deferred'
    if(!await handleFor(tab)?.canBackgroundExport?.()) {
      autosaveWaiting.value={key:tab.key,reason:'等待完成编辑'}
      return 'deferred'
    }
    // Readiness may cross an asynchronous engine queue. Recheck the shell before
    // reserving the write transaction, including a preference switched off then.
    if(!autosaveEnabled.value||active.value?.key!==target.key||tab.fileId!==target.fileId||
      globalActionsBlocked.value||composing.value||Date.now()-lastInputAt.value<1200)return 'deferred'
    autosaveWaiting.value=undefined
    const saved=await editorTransaction('正在自动保存',()=>saveActive(false,undefined,undefined,target),true)
    if(saved)tab.autoSavedAt=Date.now()
    return saved
  },
  onError(_error,target){
    if(target)autosaveWaiting.value={key:target.key,reason:'自动保存待重试'}
    status.value='自动保存暂未完成，当前修改仍保留，稍后重试。'
  },
})
// Display the scheduler's actual deadline; rendering never restarts its timer.
const autosaveClock=ref(Date.now())
let autosaveDisplayTimer:ReturnType<typeof setInterval>|undefined
onMounted(()=>{autosaveDisplayTimer=setInterval(()=>{autosaveClock.value=Date.now()},1000)})
onBeforeUnmount(()=>clearInterval(autosaveDisplayTimer))
const autosaveCountdown=computed(()=>{
  void autosaveClock.value
  if(!native.isTauri()||!autosaveEnabled.value)return ''
  const tab=currentDocument.value
  if(!tab)return '待编辑'
  if(!tab.ready)return '等待载入'
  const timing=autosave.inspectTiming()
  if(backgroundSaving.value||(timing.status==='running'&&timing.target?.key===tab.key))return '保存中…'
  if(!tab.fileId||tab.requiresSaveAs||defaultSaveExtension(tab.document.extension,tab.document.kind)!==tab.document.extension)return '请先保存'
  if(!tab.dirty)return '已保存'
  if(timing.status==='deferred')return composing.value||Date.now()-lastInputAt.value<1200?'等待输入完成':globalActionsBlocked.value?'等待操作完成':'等待完成编辑'
  if(timing.remainingMs!==undefined) {
    const seconds=Math.ceil(timing.remainingMs/1000)
    return timing.status==='retrying'?`${seconds} 秒后重试`:seconds>0?`${seconds} 秒`:'即将保存'
  }
  return '等待保存'
})
watch(autosaveEnabled,value=>{try{localStorage.setItem('open-office-autosave',String(value))}catch{}autosaveWaiting.value=undefined;autosave.notify()})
onMounted(async()=>{
  for(const type of ['input','keydown','pointerdown','compositionstart','compositionend'])document.addEventListener(type,inputActivity,true)
})
onBeforeUnmount(()=>{
  autosave.dispose()
  for(const type of ['input','keydown','pointerdown','compositionstart','compositionend'])document.removeEventListener(type,inputActivity,true)
})

function editingSmokeAdapter(): EditingSmokeAdapter {
  return {
    open:async(kind,name)=>{
      await editorTransaction('正在验证原生编辑输入',()=>addDocument({id:'',kind,extension:kind==='word'?'docx':'xlsx',name,base64:'',sha256:'',sizeBytes:0}))
      await nextTick()
      const tab=active.value
      if(!tab||tab.document.kind!==kind)throw Error('Native editing diagnostic tab missing')
      await awaitReady(tab)
      const handle=(kind==='word'?rustWordHandles:rustSheetHandles).get(tab.key) as OfficeWordSmokeEditor|OfficeSheetSmokeEditor|undefined
      if(!handle?.inspect||!handle.command)throw Error('Native editing diagnostic handle unavailable')
      const snapshot=await handle.inspect()
      const element=[...document.querySelectorAll<HTMLElement>(`[data-testid="rust-${kind}-editor"]`)].find(node=>node.dataset.sessionId===snapshot.sessionId)
      if(!element)throw Error('Native editing diagnostic canvas container missing')
      return {key:tab.key,kind,element,editor:handle}
    },
    activeKey:()=>activeKey.value,
    tabs:()=>tabs.value.map(tab=>({key:tab.key,kind:tab.document.kind,dirty:tab.dirty,ready:tab.ready})),
    shell:()=>{
      const workspace=document.querySelector<HTMLElement>('.editor-workspace')
      return {home:home.value,tabCount:tabs.value.length,workspaceDisplay:workspace?getComputedStyle(workspace).display:'missing',visibleTabCount:[...document.querySelectorAll<HTMLElement>('.document-tab')].filter(node=>node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0).length}
    },
    activate:async key=>{
      const tab=tabs.value.find(candidate=>candidate.key===key)
      if(!tab)throw Error('Native editing diagnostic activation tab missing')
      await editorTransaction('正在验证保留文档',()=>activate(tab));await nextTick();await awaitReady(tab)
    },
    close:async key=>{
      const tab=tabs.value.find(candidate=>candidate.key===key)
      if(!tab)throw Error('Native editing diagnostic cleanup tab missing')
      const inspect=tab.document.kind==='word'?inspectOfficeWordSession:inspectOfficeSheetSession
      const handle=(tab.document.kind==='word'?rustWordHandles:rustSheetHandles).get(key) as OfficeWordSmokeEditor|OfficeSheetSmokeEditor|undefined
      const sessionId=(await handle?.inspect())?.sessionId
      await removeTab(tab,true);await nextTick()
      if(sessionId){let closed=false;try{await inspect(sessionId)}catch{closed=true};if(!closed)throw Error('Native editing diagnostic session survived cleanup')}
    },
  }
}
onMounted(async()=>{
  window.addEventListener('keydown',keydown);window.addEventListener('beforeunload',beforeUnload);window.addEventListener('pointerdown',dismissNewMenu)
  smokeStage('app-mounted',JSON.stringify(smokeMode.value?smokeFeatures():{}))
  try {
    if(smokeMode.value&&!native.isTauri())throw Error('Native WebView has no Tauri IPC; native bootstrap cannot run')
    if(native.isTauri()) {
      unlisten=await smokeAwait('ipc-close-listener',()=>native.onCloseRequested(closeWindow))
      await smokeAwait('ipc-recent-documents',refreshRecents)
      const config=await smokeAwait('ipc-bootstrap',native.bootstrap) as Awaited<ReturnType<typeof native.bootstrap>> & {smokeMode?:boolean}
      if(smokeMode.value&&!config.smokeMode)throw Error('Native smoke URL was not enabled by the process')
      if(config.smokeMode) {
        smokeMode.value=true
        if(config.smokeScope==='macos-editing') {
          const report:Record<string,unknown>={...smokeFeatures(),scope:'macos-editing'}
          try {
            if(!crossOriginIsolated)throw Error('Native WebView is not cross-origin isolated')
            const {runMacosEditingSmoke}=await import('./sheet/rust/macos-editing-smoke')
            const editing=await runMacosEditingSmoke(editingSmokeAdapter())
            report.editing=editing;report.ok=editing.ok
          }catch(e){report.ok=false;report.error=message(e)}
          await smokeAwait('ipc-smoke-report',()=>invoke('smoke_report',{report}))
          return
        }
        const report:Record<string,unknown>={...smokeFeatures()}
        try {
          if(!crossOriginIsolated)throw Error('Native WebView is not cross-origin isolated')
          smokeStage('office-word-native','starting the default OfficeWord canvas and input round trip')
          const {runOfficeWordNativeSmoke}=await import('./word/rust/office-word-native-smoke')
          const word=await runOfficeWordNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认文字编辑器',()=>addDocument({id:'',kind:'word',extension:'docx',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.document.kind!=='word')throw Error('Default OfficeWord smoke tab missing')
              await awaitReady(tab)
              const handle=rustWordHandles.get(tab.key) as OfficeWordSmokeEditor|undefined
              if(!handle?.inspect||!handle.command)throw Error('Default OfficeWord smoke editor unavailable')
              const snapshot=await handle.inspect()
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="rust-word-editor"]')].find(node=>node.dataset.sessionId===snapshot.sessionId)
              if(!element)throw Error('Default OfficeWord smoke canvas container missing')
              return {key:tab.key,element,editor:nativeTransactionalEditor(handle)}
            },
            activeKey:()=>activeKey.value,
            close:async key=>{
              const tab=tabs.value.find(candidate=>candidate.key===key)
              if(!tab)throw Error('OfficeWord smoke cleanup tab missing')
              const handle=rustWordHandles.get(key) as OfficeWordSmokeEditor|undefined
              const sessionId=(await handle?.inspect())?.sessionId
              await removeTab(tab,true)
              await nextTick()
              // The real component unmount queues session.close. Inspect uses
              // that same queue, so rejection confirms cleanup has completed.
              if(sessionId) {
                let closed=false
                try {await inspectOfficeWordSession(sessionId)} catch {closed=true}
                if(!closed)throw Error('OfficeWord smoke session survived unmount')
              }
            },
          })
          report.word=word
          if(!word.ok)throw Error(word.error||word.closeError||'Default OfficeWord native verification failed')
          smokeStage('office-word-native','complete')
          smokeStage('office-sheet-native','starting the default spreadsheet canvas, formulas and XLSX round trip')
          const {runOfficeSheetNativeSmoke}=await import('./sheet/rust/office-sheet-native-smoke')
          const sheet=await runOfficeSheetNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认表格编辑器',()=>addDocument({id:'',kind:'sheet',extension:'xlsx',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.document.kind!=='sheet')throw Error('Default spreadsheet smoke tab missing')
              await awaitReady(tab)
              const handle=rustSheetHandles.get(tab.key) as OfficeSheetSmokeEditor|undefined
              if(!handle?.inspect||!handle.command||!handle.query)throw Error('Default spreadsheet smoke editor unavailable')
              const snapshot=await handle.inspect()
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="rust-sheet-editor"]')].find(node=>node.dataset.sessionId===snapshot.sessionId)
              if(!element)throw Error('Default spreadsheet smoke canvas container missing')
              return {key:tab.key,element,editor:nativeTransactionalEditor(handle)}
            },
            activeKey:()=>activeKey.value,
            close:async key=>{
              const tab=tabs.value.find(candidate=>candidate.key===key)
              if(!tab)throw Error('Spreadsheet smoke cleanup tab missing')
              const handle=rustSheetHandles.get(key) as OfficeSheetSmokeEditor|undefined
              const sessionId=(await handle?.inspect())?.sessionId
              await removeTab(tab,true)
              await nextTick()
              if(sessionId) {
                let closed=false
                try {await inspectOfficeSheetSession(sessionId)} catch {closed=true}
                if(!closed)throw Error('Spreadsheet smoke session survived unmount')
              }
            },
          })
          report.sheet=sheet
          if(!sheet.ok)throw Error(sheet.error||sheet.closeError||'Default spreadsheet native verification failed')
          smokeStage('office-sheet-native','complete')
          smokeStage('office-presentation-native','starting the default presentation canvas, slide editing and PPTX round trip')
          const {runOfficePresentationNativeSmoke}=await import('./presentation/rust/office-presentation-native-smoke')
          const presentation=await runOfficePresentationNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认演示文稿编辑器',()=>addDocument({id:'',kind:'presentation',extension:'pptx',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.document.kind!=='presentation')throw Error('Default presentation smoke tab missing')
              await awaitReady(tab)
              const handle=rustPresentationHandles.get(tab.key) as OfficePresentationSmokeEditor|undefined
              if(!handle?.inspect||!handle.command||!handle.query)throw Error('Default presentation smoke editor unavailable')
              const snapshot=await handle.inspect()
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="rust-presentation-editor"]')].find(node=>node.dataset.sessionId===snapshot.sessionId)
              if(!element)throw Error('Default presentation smoke canvas container missing')
              return {key:tab.key,element,editor:nativeTransactionalEditor(handle)}
            },
            activeKey:()=>activeKey.value,
            close:async key=>{
              const tab=tabs.value.find(candidate=>candidate.key===key)
              if(!tab)throw Error('Presentation smoke cleanup tab missing')
              const handle=rustPresentationHandles.get(key) as OfficePresentationSmokeEditor|undefined
              const sessionId=(await handle?.inspect())?.sessionId
              await removeTab(tab,true)
              await nextTick()
              if(sessionId) {
                let closed=false
                try {await inspectOfficePresentationSession(sessionId)} catch {closed=true}
                if(!closed)throw Error('Presentation smoke session survived unmount')
              }
            },
          })
          report.presentation=presentation
          if(!presentation.ok)throw Error(presentation.error||presentation.closeError||'Default presentation native verification failed')
          smokeStage('office-presentation-native','complete')
          smokeStage('pdf-native','starting the default PDF canvas, text editing and PDF round trip')
          const {runOfficePdfNativeSmoke}=await import('./pdf/rust/native-smoke')
          const pdf=await runOfficePdfNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认 PDF 编辑器',()=>addDocument({id:'',kind:'pdf',extension:'pdf',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.document.kind!=='pdf')throw Error('Default PDF smoke tab missing')
              await awaitReady(tab)
              const handle=rustPdfHandles.get(tab.key) as OfficePdfSmokeEditor|undefined
              if(!handle?.inspect||!handle.command||!handle.query)throw Error('Default PDF smoke editor unavailable')
              const snapshot=await handle.inspect()
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="rust-pdf-editor"]')].find(node=>node.dataset.sessionId===snapshot.sessionId)
              if(!element)throw Error('Default PDF smoke canvas container missing')
              return {key:tab.key,element,editor:nativeTransactionalEditor(handle)}
            },
            activeKey:()=>activeKey.value,
            close:async key=>{
              const tab=tabs.value.find(candidate=>candidate.key===key)
              if(!tab)throw Error('PDF smoke cleanup tab missing')
              const handle=rustPdfHandles.get(key) as OfficePdfSmokeEditor|undefined
              const sessionId=(await handle?.inspect())?.sessionId
              await removeTab(tab,true)
              await nextTick()
              if(sessionId) {
                let closed=false
                try {await inspectOfficePdfSession(sessionId)} catch {closed=true}
                if(!closed)throw Error('PDF smoke session survived unmount')
              }
            },
          })
          report.pdf=pdf
          if(!pdf.ok)throw Error(pdf.error||pdf.closeError||'Default PDF native verification failed')
          smokeStage('pdf-native','complete')
          smokeStage('notebook-native','starting mounted notebook input and native original-file save verification')
          const {runNotebookNativeSmoke}=await import('./notes/native-smoke')
          const notebook=await runNotebookNativeSmoke({
            open:async source=>{
              const tab=await editorTransaction('正在验证本机笔记本',()=>addDocument(source,source.id||undefined))
              if(!tab||tab.document.kind!=='note')throw Error('Native notebook smoke tab missing')
              await nextTick();await awaitReady(tab);await nextTick()
              const editor=noteHandles.get(tab.key) as Awaited<ReturnType<NotebookNativeSmokeAdapter['open']>>['editor']|undefined
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="notebook-editor"]')].find(node=>node.dataset.documentId===tab.key)
              if(!editor?.inspect||!editor.markSaved||!element)throw Error('Native notebook editor unavailable')
              return {key:tab.key,element,editor}
            },
            bindTemporaryFile:async(key,file)=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab||tab.fileId||tab.document.kind!=='note'||file.kind!=='note'||file.extension!=='oonote')throw Error('Invalid temporary notebook capability')
              tab.fileId=file.id;tab.document={...file,id:key};tab.requiresSaveAs=false;tab.importWarnings=[];tab.dirty=false
              await nextTick()
            },
            state:key=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab)throw Error('Native notebook tab closed unexpectedly')
              return {active:activeKey.value===key&&!home.value,ready:tab.ready,dirty:tab.dirty,busy:!!busy.value||autosave.running,fileId:tab.fileId,sha256:tab.document.sha256,
                modal:!!saveAsDraft.value||!!templateDraft.value||!!closeTarget.value||help.value}
            },
            autosaveEnabled:()=>autosaveEnabled.value,
            setAutosave:async enabled=>{autosaveEnabled.value=enabled;await nextTick();autosave.notify()},
            observeNativeSaves:observer=>{
              if(nativeSmokeSaveObserver)throw Error('Native save observer already installed')
              nativeSmokeSaveObserver=observer
              return ()=>{if(nativeSmokeSaveObserver===observer)nativeSmokeSaveObserver=undefined}
            },
            close:async key=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab)throw Error('Native notebook cleanup tab missing')
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="notebook-editor"]')].find(node=>node.dataset.documentId===key)
              await removeTab(tab,true);await nextTick()
              if(tabs.value.some(item=>item.key===key)||noteEntries.value.some(item=>item.document.id===key)||noteHandles.has(key)||element?.isConnected)throw Error('Native notebook editor survived cleanup')
            },
          })
          report.notebook=notebook
          if(!notebook.ok)throw Error(notebook.error||notebook.cleanupError||'Native notebook verification failed')
          smokeStage('notebook-native','complete')
          smokeStage('workflow-native','starting mounted canvas and code diagram original-file verification')
          const {runWorkflowNativeSmoke}=await import('./workflow/native-smoke')
          type WorkflowSmokeEditor=Awaited<ReturnType<import('./workflow/native-smoke').WorkflowNativeSmokeAdapter['open']>>['editor']
          const workflow=await runWorkflowNativeSmoke({
            open:async source=>{
              const tab=await editorTransaction('正在验证本机画布和代码图表',()=>addDocument(source,source.id||undefined))
              if(!tab||!['canvas','diagram'].includes(tab.document.kind))throw Error('Native workflow smoke tab missing')
              await nextTick();await awaitReady(tab);await nextTick()
              const editor=workflowHandles.get(tab.key) as WorkflowSmokeEditor|undefined
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="workflow-editor"]')].find(node=>node.dataset.documentId===tab.key)
              if(!editor?.inspect||!editor.markSaved||!element)throw Error('Native workflow editor unavailable')
              return {key:tab.key,element,editor}
            },
            bindTemporaryFile:async(key,file)=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab||tab.fileId||!['canvas','diagram'].includes(tab.document.kind)||file.kind!==tab.document.kind||file.extension!=='owflow')throw Error('Invalid temporary workflow capability')
              tab.fileId=file.id;tab.document={...file,id:key};tab.requiresSaveAs=false;tab.importWarnings=[];tab.dirty=false
              await nextTick()
            },
            state:key=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab)throw Error('Native workflow tab closed unexpectedly')
              return {active:activeKey.value===key&&!home.value,ready:tab.ready,dirty:tab.dirty,busy:!!busy.value||autosave.running,fileId:tab.fileId,sha256:tab.document.sha256,
                modal:!!saveAsDraft.value||!!templateDraft.value||!!closeTarget.value||help.value}
            },
            autosaveEnabled:()=>autosaveEnabled.value,
            setAutosave:async enabled=>{autosaveEnabled.value=enabled;await nextTick();autosave.notify()},
            observeNativeSaves:observer=>{
              if(nativeSmokeSaveObserver)throw Error('Native save observer already installed')
              nativeSmokeSaveObserver=observer
              return ()=>{if(nativeSmokeSaveObserver===observer)nativeSmokeSaveObserver=undefined}
            },
            close:async key=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab)throw Error('Native workflow cleanup tab missing')
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="workflow-editor"]')].find(node=>node.dataset.documentId===key)
              await removeTab(tab,true);await nextTick()
              if(tabs.value.some(item=>item.key===key)||workflowEntries.value.some(item=>item.document.id===key)||workflowHandles.has(key)||element?.isConnected)throw Error('Native workflow editor survived cleanup')
            },
          })
          report.workflow=workflow
          if(!workflow.ok)throw Error(workflow.error||workflow.cleanupError||'Native workflow verification failed')
          smokeStage('workflow-native','complete')
          smokeStage('mcp-native','starting native HTTP document tool verification')
          const {runMcpNativeSmoke}=await import('./mcp/native-smoke')
          const savedMcpConfig=mcpConfig.value
          const mcp=await runMcpNativeSmoke({
            open:async source=>{
              const tab=await editorTransaction('正在验证本机 MCP',()=>addDocument(source))
              if(!tab)throw Error('Native MCP smoke tab missing')
              await nextTick();await awaitReady(tab)
              const handle=handleFor(tab) as (EditorHandle & {inspect():Promise<{documentId:number;revision:number;dirty:boolean;[key:string]:unknown}>;query?(id:string,params?:Record<string,unknown>):Promise<unknown>;inspectModel?():Promise<unknown>})|undefined
              if(!handle?.inspect||!handle.exportFile)throw Error('Native MCP editor unavailable')
              return {key:tab.key,editor:handle,read:async()=>{
                if(source.kind==='sheet')return handle.query!('cell.get',{cell:'A1'})
                if(source.kind==='presentation')return handle.query!('slide.inspect',{index:0})
                if(source.kind==='pdf')return handle.query!('document.inspect')
                if(source.kind==='canvas'||source.kind==='diagram')return handle.inspectModel!()
                if(source.kind==='note')return {visibleText:[...document.querySelectorAll('[data-testid="notebook-content"]')].map(element=>element.textContent||'').join('\n')}
                return handle.inspect()
              }}
            },
            start:async key=>{
              const tab=currentDocument.value
              if(!tab||tab.key!==key)throw Error('Native MCP target is not active')
              // Ephemeral smoke permissions never overwrite the user's saved settings.
              mcpConfig.value={...createDefaultMcpConfig(),allowEdits:true}
              await mcpService.start(mcpConfig.value,{id:tab.key,kind:tab.document.kind,title:tab.document.name},catalogForKind(tab.document.kind))
              await nextTick()
            },
            documentState:key=>({active:activeKey.value===key&&!home.value,dirty:tabs.value.find(tab=>tab.key===key)?.dirty===true}),
            state:()=>mcpService.inspect(),
            stop:async()=>{try{await mcpService.stop()}finally{mcpConfig.value=savedMcpConfig;await nextTick()}},
            close:async key=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab)throw Error('Native MCP cleanup tab missing')
              const handle=handleFor(tab)
              const sessionId=(await handle?.inspect?.() as {sessionId?:string}|undefined)?.sessionId
              await removeTab(tab,true);await nextTick()
              if(handleFor(tab)||tabs.value.some(item=>item.key===key))throw Error('Native MCP editor survived cleanup')
              const inspector=tab.document.kind==='word'?inspectOfficeWordSession:tab.document.kind==='sheet'?inspectOfficeSheetSession:tab.document.kind==='presentation'?inspectOfficePresentationSession:tab.document.kind==='pdf'?inspectOfficePdfSession:undefined
              if(sessionId&&inspector){let closed=false;try{await inspector(sessionId)}catch{closed=true};if(!closed)throw Error('Native MCP Rust session survived cleanup')}
            },
          })
          report.mcp=mcp
          if(!mcp.ok)throw Error(mcp.error||mcp.cleanupError||'Native MCP verification failed')
          smokeStage('mcp-native','complete')
          smokeStage('workspace-native','starting scheduled native file persistence verification')
          const {runWorkspaceNativeSmoke}=await import('./shared/workspace-native-smoke')
          const workspace=await runWorkspaceNativeSmoke({
            openWord:async source=>{
              const tab=await editorTransaction('正在验证本机自动保存',()=>addDocument(source))
              if(!tab)throw Error('Native workspace smoke tab missing')
              await nextTick();await awaitReady(tab)
              const editor=rustWordHandles.get(tab.key) as OfficeWordSmokeEditor|undefined
              if(!editor?.inspect||!editor.command)throw Error('Native workspace Word editor unavailable')
              return {key:tab.key,editor}
            },
            bindTemporaryFile:async(key,file)=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab||tab.fileId||tab.document.kind!=='word'||file.kind!=='word'||file.extension!=='docx')throw Error('Invalid temporary autosave capability')
              tab.fileId=file.id;tab.document={...file,id:key};tab.requiresSaveAs=false;tab.importWarnings=[];tab.dirty=false
              await nextTick()
            },
            state:key=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab)throw Error('Native autosave tab closed unexpectedly')
              return {active:activeKey.value===key&&!home.value,dirty:tab.dirty,ready:tab.ready,saving:autosave.running||!!busy.value,fileId:tab.fileId,requiresSaveAs:!!tab.requiresSaveAs,sha256:tab.document.sha256,
                modal:!!saveAsDraft.value||!!templateDraft.value||!!closeTarget.value||help.value}
            },
            autosaveEnabled:()=>autosaveEnabled.value,
            setAutosave:async enabled=>{autosaveEnabled.value=enabled;await nextTick();autosave.notify()},
            observeNativeSaves:observer=>{
              if(nativeSmokeSaveObserver)throw Error('Native save observer already installed')
              nativeSmokeSaveObserver=observer
              return ()=>{if(nativeSmokeSaveObserver===observer)nativeSmokeSaveObserver=undefined}
            },
            close:async key=>{
              const tab=tabs.value.find(item=>item.key===key)
              if(!tab)throw Error('Native workspace cleanup tab missing')
              const sessionId=(await (rustWordHandles.get(key) as OfficeWordSmokeEditor|undefined)?.inspect())?.sessionId
              await removeTab(tab,true);await nextTick()
              if(sessionId){let closed=false;try{await inspectOfficeWordSession(sessionId)}catch{closed=true};if(!closed)throw Error('Native workspace Word session survived cleanup')}
            },
          })
          report.workspace=workspace
          if(!workspace.ok)throw Error(workspace.error||workspace.cleanupError||'Native workspace verification failed')
          report.ok=true
          smokeStage('workspace-native','complete')
        }catch(e){report.ok=false;report.error=message(e)}
        await smokeAwait('ipc-smoke-report',()=>invoke('smoke_report',{report}))
      }
    }
  }catch(e){error.value=message(e);if(smokeMode.value)await smokeFailure(e,'app-startup')}
})
onBeforeUnmount(()=>{unlisten?.();window.removeEventListener('keydown',keydown);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('pointerdown',dismissNewMenu)})
</script>

<template>
  <div class="app-shell" :class="{'editing':!home}">
    <input ref="fileInput" data-testid="document-open-input" class="visually-hidden" type="file" accept=".docx,.xlsx,.csv,.tsv,.pptx,.potx,.ppsx,.pdf,.oonote,.ooschedule,.owflow,.mmd,.mermaid,.drawio,.xml,.excalidraw,.json" @change="browserFile" />
    <input ref="scheduleImportInput" data-testid="schedule-import-input" class="visually-hidden" type="file" accept=".ooschedule,.json" @change="browserScheduleFile" />
    <aside class="sidebar" aria-label="全局导航" :inert="globalActionsBlocked">
      <button class="primary open-sidebar" @click="openFile" aria-label="打开文件" title="打开文件 · Ctrl / ⌘ O"><Icon name="folder"/><span>打开文件</span><kbd>⌘ / Ctrl O</kbd></button>
      <nav aria-label="工作区"><button :class="{selected:home}" :aria-current="home ? 'page' : undefined" aria-label="工作台" title="工作台" @click="home=true"><Icon name="home"/><span>工作台</span></button></nav>
      <div v-if="tabs.length" v-show="home" class="sidebar-documents"><div class="sidebar-documents-heading"><span class="eyebrow">正在编辑 · {{tabs.length}}</span><button data-testid="home-close-all" @click="closeAllTabs" title="关闭所有打开的文档">全部关闭</button></div><button v-for="tab in tabs" :key="tab.key" :title="tab.document.name" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button></div>
      <div class="sidebar-bottom" data-testid="global-appearance">
        <button class="brand" @click="home=true" aria-label="返回工作台" title="Open Office · 返回工作台"><img :src="brandIcon" alt="" /><span>Open <b>Office</b></span></button>
        <span class="sidebar-version" :title="'版本 '+appVersion+' · 构建 '+buildVersion">v{{appVersion}} · {{buildVersion}}</span>
        <div class="sidebar-controls" role="group" aria-label="外观与设置">
          <div class="theme-switch" role="group" aria-label="界面主题">
            <button v-for="option in appearanceOptions" :key="option.value" :data-testid="'theme-'+option.value" :aria-label="option.label" :title="option.value==='system' && appearance==='system' ? '跟随系统（当前为'+(effectiveAppearance==='dark'?'深色':'浅色')+'）' : option.label" :aria-pressed="appearance===option.value" @click="appearance=option.value"><Icon :name="option.icon" :size="18"/></button>
          </div>
          <button class="icon-button" data-testid="mcp-settings" @click="openMcpSettings" aria-label="MCP 设置" title="全局 MCP 设置" aria-haspopup="dialog" :aria-expanded="mcpSettingsOpen"><Icon name="link" :size="18"/></button>
          <button class="icon-button" @click="help=true" aria-label="使用说明" :title="'使用说明 · '+buildVersion" aria-haspopup="dialog" :aria-expanded="help"><Icon name="info" :size="18"/></button>
        </div>
      </div>
    </aside>
    <header class="titlebar" data-testid="global-toolbar" :inert="globalActionsBlocked">
      <nav class="global-file-toolbar" aria-label="全局文件操作">
        <details ref="newMenu" class="new-document-menu" @keydown.esc.stop.prevent="closeNewMenu(true)">
          <summary data-testid="shell-new" aria-label="新建文档" title="新建文档 · Ctrl / ⌘ N"><Icon name="plus" :size="18"/><span class="file-action-label">新建</span><Icon name="chevron-down" :size="12"/></summary>
          <div class="new-document-options" role="group" aria-label="选择新建文档类型">
            <button v-for="kind in (['word','sheet','presentation','pdf','note','canvas','diagram','schedule'] as const)" :key="kind" :data-testid="'shell-new-'+kind" @click="globalNewDocument(kind)"><Icon :name="icons[kind]" :size="18"/><span>{{kindNames[kind]}}</span></button>
          </div>
        </details>
        <div class="global-file-actions">
          <button data-testid="shell-open" @click="globalFileAction('open')" title="打开文件 · Ctrl / ⌘ O" aria-label="打开文件"><Icon name="folder" :size="18"/><span class="file-action-label">打开</span></button>
          <span class="separator"/>
          <button data-testid="shell-save" :disabled="documentActionsDisabled" @click="globalFileAction('save')" title="保存当前文档 · Ctrl / ⌘ S" aria-label="保存当前文档"><Icon name="save" :size="18"/><span class="file-action-label">保存</span></button>
          <button data-testid="shell-autosave" class="autosave-toggle" role="switch" :aria-checked="native.isTauri()&&autosaveEnabled" :disabled="!native.isTauri()" :title="autosaveTitle" aria-label="自动保存" :aria-describedby="autosaveCountdown ? 'autosave-timing' : undefined" @click="autosaveEnabled=!autosaveEnabled"><span class="autosave-track" :class="{enabled:native.isTauri()&&autosaveEnabled}"><i/></span><span class="autosave-label">自动保存</span><span v-if="autosaveCountdown" id="autosave-timing" data-testid="autosave-countdown" class="autosave-countdown" role="timer" aria-live="off">{{autosaveCountdown}}</span></button>
          <button data-testid="shell-save-as" :disabled="documentActionsDisabled" @click="globalFileAction('saveAs')" title="当前文档另存为 · Ctrl / ⌘ Shift S" aria-label="当前文档另存为"><Icon name="save-as" :size="18"/><span class="file-action-label">另存为</span></button>
          <button data-testid="shell-export-pdf" :disabled="documentActionsDisabled||currentDocument?.document.kind==='pdf'||!formatsFor(currentDocument).some(option=>option.extension==='pdf')" @click="globalFileAction('exportPdf')" title="导出当前文档为 PDF" aria-label="导出当前文档为 PDF"><Icon name="download" :size="18"/><span class="file-action-label">导出 PDF</span></button>
          <button data-testid="shell-print" :disabled="printDisabled" @click="globalFileAction('print')" :title="printDisabled ? '请等待可打印的文档就绪' : '打印当前文档 · Ctrl / ⌘ P'" aria-label="打印当前文档"><Icon name="print" :size="18"/><span class="file-action-label">打印</span></button>
          <span class="separator"/>
          <button :disabled="documentActionsDisabled" @click="globalFileAction('undo')" title="撤销" aria-label="撤销"><Icon name="undo" :size="18"/></button>
          <button :disabled="documentActionsDisabled" @click="globalFileAction('redo')" title="重做" aria-label="重做"><Icon name="redo" :size="18"/></button>
        </div>
      </nav>
      <span class="titlebar-context" :title="currentDocument?.document.name">{{currentDocument?.document.name || '工作台'}}</span>
      <div class="titlebar-right">
        <span class="save-state" data-testid="global-save-state" role="status" aria-live="polite" :title="saveStateTitle"><i v-if="currentDocument?.dirty" class="dirty-dot"/>{{saveStateLabel}}</span>
      </div>
    </header>
    <div v-show="home" class="workspace" :inert="globalActionsBlocked">
      <main class="home-main">
        <div class="home-heading"><div><span class="eyebrow">本地工作空间</span><h1>工作台</h1><p>新建一份文档，或继续编辑本机文件。</p></div></div>
        <section class="create-grid" aria-label="新建文件">
          <button class="create-card word" @click="newDocument('word')"><span class="document-art"><Icon name="file" :size="28"/></span><span class="card-bottom"><span><strong>文字文档</strong><small>文字排版、表格与图片编辑</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
          <button class="create-card sheet" @click="newDocument('sheet')"><span class="document-art"><Icon name="sheet" :size="28"/></span><span class="card-bottom"><span><strong>电子表格</strong><small>数据整理与公式计算</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
          <button class="create-card presentation" @click="newDocument('presentation')"><span class="document-art"><Icon name="presentation" :size="28"/></span><span class="card-bottom"><span><strong>演示文稿</strong><small>幻灯片设计与演示</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
          <button class="create-card pdf" @click="newDocument('pdf')"><span class="document-art"><Icon name="pdf" :size="28"/></span><span class="card-bottom"><span><strong>PDF 工作室</strong><small>文字编辑、批注与页面整理</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
          <button class="create-card note" data-testid="home-new-note" @click="newDocument('note')"><span class="document-art"><Icon name="notebook" :size="28"/></span><span class="card-bottom"><span><strong>笔记本</strong><small>分区与页面、灵感记录和待办</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
          <button class="create-card canvas" data-testid="home-new-canvas" @click="newDocument('canvas')"><span class="document-art"><Icon name="canvas" :size="28"/></span><span class="card-bottom"><span><strong>画布</strong><small>流程连线、自由绘制与灵感整理</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
          <button class="create-card diagram" data-testid="home-new-diagram" @click="newDocument('diagram')"><span class="document-art"><Icon name="code-diagram" :size="28"/></span><span class="card-bottom"><span><strong>代码图表</strong><small>代码绘图、实时预览与图表模板</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
          <button class="create-card schedule" data-testid="home-new-schedule" @click="newDocument('schedule')"><span class="document-art"><Icon name="schedule" :size="28"/></span><span class="card-bottom"><span><strong>计划排期</strong><small>项目日历、角色分工与事件安排</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span></button>
        </section>
        <section class="recent-section"><div class="section-heading"><h2>最近打开 <span>{{recents.length}}</span></h2><label class="search-box"><Icon name="search" :size="18"/><input v-model="search" placeholder="查找最近的文件" aria-label="查找最近的文件"/></label></div>
          <div ref="recentList" class="recent-list" role="region" aria-label="最近打开的文件" tabindex="0">
            <div v-if="!filteredRecents.length" class="empty-files"><div class="empty-icon"><Icon name="folder" :size="28"/></div><strong>{{search?'没有找到匹配的文件':'你的下一份作品，从这里开始'}}</strong><p>{{native.isTauri()?'打开本机文件后，可以在这里快速找到它。':'浏览器支持本地编辑和导出文件；桌面版还可直接保存到本机文件。'}}</p><button class="text-button" @click="openFile">打开一份文件 <Icon name="arrow" :size="16"/></button></div>
            <template v-else><button v-for="item in filteredRecents" :key="item.id" class="recent-row" @click="openRecent(item)"><span class="file-icon" :class="item.kind"><Icon :name="icons[item.kind]"/></span><span class="recent-name">{{item.name}}<small>{{kindNames[item.kind]}} · {{item.extension.toUpperCase()}}</small></span><time>{{new Date(item.lastOpenedAt* (item.lastOpenedAt<1e12?1000:1)).toLocaleDateString('zh-CN')}}</time><Icon name="arrow" :size="18"/></button></template>
          </div>
        </section>
        <footer class="home-footer"><span>文档 · 表格 · 演示 · PDF · 笔记本 · 画布 · 代码图表 · 计划排期</span><span>OPEN OFFICE · {{new Date().getFullYear()}}</span></footer>
      </main>
    </div>
    <section v-show="!home" class="editor-workspace" :inert="editorInputBlocked">
      <div class="tab-strip" :inert="globalActionsBlocked">
        <button class="home-tab" @click="home=true" aria-label="工作台" title="工作台"><Icon name="home" :size="18"/></button>
        <div ref="tabBar" class="tab-bar">
          <div v-for="tab in tabs" :key="tab.key" class="document-tab" :class="{active:activeKey===tab.key}" role="tab" :aria-selected="activeKey===tab.key"><button class="tab-name" :title="tab.document.name" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]" :size="16"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button><button class="tab-close" @click="closeTab(tab)" :aria-label="`关闭 ${tab.document.name}`"><Icon name="close" :size="14"/></button></div>
        </div>
        <button class="new-tab" @click="home=true" aria-label="新建文档" title="新建文档"><Icon name="plus" :size="18"/></button>
        <button class="close-all-tabs" data-testid="tabs-close-all" :disabled="globalActionsBlocked||!tabs.length" @click="closeAllTabs" title="批量关闭所有文档"><Icon name="close" :size="15"/><span>全部关闭</span></button>
      </div>
      <div v-if="currentDocument" class="document-mcp-bar" role="toolbar" :aria-label="kindNames[currentDocument.document.kind]+' MCP 服务'">
        <span class="document-mcp-kind"><Icon :name="icons[currentDocument.document.kind]" :size="14"/>{{kindNames[currentDocument.document.kind]}}<small>当前文档</small></span>
        <span v-if="mcpState.phase==='running'" class="document-mcp-detail" role="status">{{mcpWorking?'正在处理…':'修改实时显示 · 切换文档后关闭'}}</span>
        <button v-if="mcpConfigReady" class="document-mcp-permission" data-testid="document-mcp-permission" :disabled="globalActionsBlocked" aria-label="MCP 读写权限设置" :title="mcpConfig.allowEdits?'已开放当前文档编辑，点击调整权限':'当前仅提供读取工具；点击设置中开启编辑权限'" @click="openMcpSettings">{{mcpConfig.allowEdits?'允许编辑':'只读'}}<Icon name="chevron-down" :size="12"/></button>
        <button data-testid="document-mcp-toggle" class="document-mcp-toggle" :class="{running:mcpState.phase==='running'}" :aria-pressed="mcpState.phase==='running'" :aria-label="mcpState.phase==='running'?'停止当前文档 MCP 服务':'开启当前文档 MCP 服务'" :disabled="mcpState.phase==='stopping'||documentActionsDisabled" :title="!native.isTauri()?'请在桌面版开启本机 MCP 服务':mcpState.error||mcpState.endpoint||'根据全局设置开启当前文档的 MCP 服务；切换文档后自动关闭'" @click="toggleMcp">
          <i v-if="mcpState.phase==='running'" class="mcp-running-dot"/><Icon v-else name="link" :size="15"/>
          <span>MCP</span><strong v-if="mcpState.phase==='running'">Running</strong><span v-else-if="mcpState.phase==='starting'">启动中…</span><span v-else-if="mcpState.phase==='stopping'">停止中…</span><span v-else-if="mcpState.phase==='error'">重试</span>
        </button>
      </div>
      <div v-if="active?.importWarnings?.length" class="import-review-notice" role="note" data-testid="import-review-notice"><Icon name="info" :size="16"/><div><p v-for="warning in active.importWarnings" :key="warning">{{warning}}</p><strong>请核对文档内容与排版。</strong></div></div>
      <div class="editor-stage">
      <div class="editor-content" :inert="editorInputBlocked">
        <RustWordEditor :theme="appearance" v-for="entry in rustWordEntries" :key="entry.document.id" v-show="activeRustWord&&activeKey===entry.document.id" :ref="handle=>setRustWordHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustWord&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustSheetEditor :theme="appearance" v-for="entry in rustSheetEntries" :key="entry.document.id" v-show="activeRustSheet&&activeKey===entry.document.id" :ref="handle=>setRustSheetHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustSheet&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustPresentationEditor :theme="appearance" v-for="entry in rustPresentationEntries" :key="entry.document.id" v-show="activeRustPresentation&&activeKey===entry.document.id" :ref="handle=>setRustPresentationHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustPresentation&&activeKey===entry.document.id" :disabled="editorInputBlocked" :templates-open="templatePanelOpen" @toggle-templates="activeKey===entry.document.id&&togglePresentationTemplates()" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustPdfEditor :theme="appearance" v-for="entry in rustPdfEntries" :key="entry.document.id" v-show="activeRustPdf&&activeKey===entry.document.id" :ref="handle=>setRustPdfHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustPdf&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <NotebookEditor :theme="appearance" v-for="entry in noteEntries" :key="entry.document.id" v-show="activeNote&&activeKey===entry.document.id" :ref="handle=>setNoteHandle(entry.document.id,handle)" :document="entry.document" :active="!home&&activeNote&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <ScheduleEditor :theme="effectiveAppearance" v-for="entry in scheduleEntries" :key="entry.document.id" v-show="activeSchedule&&activeKey===entry.document.id" :ref="handle=>setScheduleHandle(entry.document.id,handle)" :document="entry.document" :active="!home&&activeSchedule&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)" @import="importSchedule(entry.document.id)" @export="exportScheduleCopy(entry.document.id,$event)"/>
        <WorkflowEditor :theme="effectiveAppearance" v-for="entry in workflowEntries" :key="entry.document.id" v-show="activeWorkflow&&activeKey===entry.document.id" :ref="handle=>setWorkflowHandle(entry.document.id,handle)" :document="entry.document" :active="!home&&activeWorkflow&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)" @create-canvas="activeKey===entry.document.id&&createCanvasCopy($event)" @export="exportWorkflowCopy(entry.document.id,$event)"/>
      </div>
      <PresentationTemplates v-if="!home&&activeRustPresentation&&templatePanelOpen" class="template-panel" :templates="presentationTemplates" :loading="templateListLoading" :error="templateListError" :disabled="documentActionsDisabled" @select="openPresentationTemplateDialog('apply',$event)" @save="openPresentationTemplateDialog('save')" @delete="openPresentationTemplateDialog('delete',$event)" @retry="refreshPresentationTemplates" @close="templatePanelOpen=false"/>
      </div>
      <footer class="editor-status"><span>{{status}}</span><span>{{active?.document.extension.toUpperCase()}} · {{activeRustWord?'文字编辑':activeRustSheet?'表格编辑':activeRustPresentation?'演示编辑':activeRustPdf?'PDF 编辑':activeNote?'笔记编辑':activeSchedule?'计划排期':active?.document.kind==='canvas'?'画布编辑':'代码图表'}}</span></footer>
    </section>
    <McpSettingsDialog v-if="mcpSettingsOpen" :config="mcpConfig" :running="mcpState.phase==='running'" :native-available="native.isTauri()" :saving="mcpSettingsBusy" :error="mcpSettingsError" @save="saveMcpSettings" @close="!mcpSettingsBusy&&(mcpSettingsOpen=false)"/>
    <div v-if="error" class="error-banner" role="alert"><Icon name="info"/><span>{{error}}</span><button @click="error=''" aria-label="关闭错误提示"><Icon name="close" :size="16"/></button></div>
    <div v-if="busy&&!backgroundSaving" class="busy-overlay" role="status"><span class="busy-pill"><i/>{{busy}}</span></div>
    <div v-if="saveAsDraft" class="modal-backdrop" @click.self="cancelSaveAs" @keydown.esc.stop.prevent="cancelSaveAs">
      <form ref="saveAsDialog" class="modal save-format-dialog" role="dialog" aria-modal="true" aria-labelledby="save-format-title" data-testid="save-format-dialog" @submit.prevent="confirmSaveAs">
        <h2 id="save-format-title">另存为</h2>
        <label class="save-name-label">文件名<span class="save-name-input"><input v-model="saveAsDraft.name" :disabled="!!busy" data-testid="save-format-name" aria-label="文件名，不含扩展名" autocomplete="off" spellcheck="false" /><span>.{{saveAsDraft.format}}</span></span></label>
        <fieldset :disabled="!!busy" class="save-format-options"><legend>文件格式</legend>
          <label v-for="option in saveAsOptions" :key="option.extension" class="save-format-option" :class="{selected:saveAsDraft.format===option.extension}">
            <input v-model="saveAsDraft.format" type="radio" name="save-format" :value="option.extension" :data-testid="'save-format-'+option.extension" />
            <span><strong>{{option.title}}</strong><small>{{option.description}}</small></span>
          </label>
        </fieldset>
        <p v-if="saveAsCopy" class="save-format-note">转换后生成副本，你可以继续编辑当前文稿。请检查转换后的排版与内容。</p>
        <p v-else class="save-format-note">{{native.isTauri()?'下一步选择保存位置。':'文件将下载到浏览器设置的下载位置。'}}</p>
        <p v-if="saveAsDraft.error" role="alert" class="save-format-error">{{saveAsDraft.error}}</p>
        <div class="modal-actions"><button type="button" :disabled="!!busy" data-testid="save-format-cancel" @click="cancelSaveAs">取消</button><button type="submit" :disabled="!!busy" class="primary" data-testid="save-format-confirm">{{native.isTauri()?'选择保存位置':'下载文件'}}</button></div>
      </form>
    </div>
    <div v-if="templateDraft" class="modal-backdrop" @click.self="cancelPresentationTemplateDialog" @keydown.esc.stop.prevent="cancelPresentationTemplateDialog">
      <form ref="templateDialog" class="modal template-dialog" role="dialog" aria-modal="true" aria-labelledby="presentation-template-title" data-testid="presentation-template-dialog" @submit.prevent="confirmPresentationTemplate">
        <h2 id="presentation-template-title">{{templateDraft.kind==='save'?'存为模板':templateDraft.kind==='apply'?'切换为此模板？':'删除此模板？'}}</h2>
        <template v-if="templateDraft.kind==='save'">
          <p>保存当前全部幻灯片及内容，之后可在“我的模板”中重复使用。模板保存在本机。</p>
          <label class="save-name-label">模板名称<span class="save-name-input"><input v-model="templateDraft.name" :disabled="!!busy" data-testid="presentation-template-name" aria-label="模板名称" autocomplete="off" spellcheck="false" /></span></label>
        </template>
        <template v-else>
          <div class="template-dialog-summary"><img v-if="templateDraft.template.preview" :src="templateDraft.template.preview" alt=""/><div><strong>{{templateDraft.template.name}}</strong><span>{{templateDraft.template.slideCount}} 页 · {{templateDraft.template.source==='builtin'?'内置模板':'我的模板'}}</span></div></div>
          <template v-if="templateDraft.kind==='apply'">
            <p>将替换当前演示的全部幻灯片、布局和内容，文件名保持不变。可通过撤销恢复。</p>
            <p v-if="active?.dirty" class="template-dialog-notice">当前未保存的修改也会被替换。</p>
            <p v-if="native.isTauri()&&autosaveEnabled&&active?.fileId&&!active.requiresSaveAs" class="template-dialog-notice">自动保存已开启，切换后的内容将自动保存回当前文件。</p>
          </template>
          <p v-else>此操作将从模板库中永久删除该模板，不影响已打开的演示文稿。</p>
        </template>
        <p v-if="templateDraft.error" role="alert" class="template-dialog-error">{{templateDraft.error}}</p>
        <div class="modal-actions"><button type="button" :disabled="!!busy" data-testid="presentation-template-cancel" @click="cancelPresentationTemplateDialog">取消</button><button type="submit" :disabled="!!busy" class="primary" data-testid="presentation-template-confirm">{{templateDraft.kind==='save'?'保存模板':templateDraft.kind==='apply'?'确认切换':'确认删除'}}</button></div>
      </form>
    </div>
    <div v-if="closeTarget" class="modal-backdrop" @keydown.esc.stop.prevent="!busy&&(closeTarget=null)">
      <section ref="closeDialog" class="modal close-documents-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="close-heading" data-testid="close-documents-dialog">
        <span class="modal-icon"><Icon name="save" :size="28"/></span><h2 id="close-heading">{{closeBatch?'保存这些文档的修改？':'保存你的修改？'}}</h2>
        <p>{{closeBatch?`${closeDocuments.length} 份文档尚未保存。可以一次性保存，或放弃这些修改${closeTarget==='window'?'并退出':'并关闭全部文档'}。`:`“${closeDocuments[0]?.document.name}”有尚未保存的修改。`}}</p>
        <ul v-if="closeBatch" class="close-document-list"><li v-for="tab in closeDocuments" :key="tab.key"><Icon :name="icons[tab.document.kind]" :size="18"/><span :title="tab.document.name">{{tab.document.name}}</span><span class="close-document-state">未保存</span></li></ul>
        <div class="modal-actions"><button data-testid="close-cancel" :disabled="!!busy" @click="closeTarget=null">取消</button><button data-testid="close-discard" :disabled="!!busy" @click="resolveClose('discard')">{{closeTarget==='window'?'全部不保存并退出':closeTarget==='all'?'全部不保存并关闭':'不保存并关闭'}}</button><button class="primary" data-testid="close-save" :disabled="!!busy" @click="resolveClose('save')">{{closeTarget==='window'?'全部保存并退出':closeTarget==='all'?'全部保存并关闭':'保存并关闭'}}</button></div>
      </section>
    </div>
    <div v-if="help" class="modal-backdrop help-backdrop" @click.self="help=false" @keydown.esc.stop.prevent="help=false">
      <section ref="helpDialog" class="modal help-modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="help-heading">
        <button class="modal-close icon-button" @click="help=false" aria-label="关闭说明"><Icon name="close"/></button>
        <span class="eyebrow">OPEN OFFICE</span>
        <h2 id="help-heading">八种工具，随需使用</h2>
        <div class="help-grid">
          <article v-for="tool in helpTools" :key="tool.kind">
            <span class="help-tool-icon"><Icon :name="icons[tool.kind]" :size="21"/></span>
            <div><h3>{{tool.name}}</h3><p>{{tool.description}}</p></div>
          </article>
        </div>
        <footer class="help-footer"><small>版本 {{appVersion}} · 构建 {{buildVersion}}</small><button class="primary" @click="help=false">开始工作</button></footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.editor-stage { display:flex; flex:1; min-width:0; min-height:0; position:relative; }
.template-panel { flex:none; border-left:1px solid var(--ui-line); }
.template-dialog { width:min(480px,100%); max-height:calc(100dvh - 40px); overflow:auto; }
.template-dialog-summary { display:flex; align-items:center; gap:14px; margin:20px 0 15px; padding:12px; border:1px solid var(--ui-line); border-radius:var(--ui-radius); }
.template-dialog-summary img { width:128px; aspect-ratio:16/9; object-fit:contain; border-radius:4px; border:1px solid var(--ui-line); }
.template-dialog-summary > div { min-width:0; }
.template-dialog-summary strong { display:block; overflow-wrap:anywhere; font-size:14px; }
.template-dialog-summary span { display:block; margin-top:6px; color:var(--ui-muted); font-size:12px; }
.template-dialog .template-dialog-notice { color:var(--ui-warning); }
.template-dialog .template-dialog-error { color:var(--ui-danger); }
@media(max-width:900px) { .template-panel { position:absolute; right:0; top:28px; bottom:0; height:auto; width:min(300px,100%); z-index:10; box-shadow:-5px 0 20px #18213618; } }
.tab-strip { display:flex; flex:none; min-width:0; height:40px; overflow:hidden; background:var(--ui-surface-muted); border-bottom:1px solid var(--ui-line); }
.tab-strip .home-tab { border-right:1px solid var(--ui-line); }
.tab-strip .new-tab { border-left:1px solid var(--ui-line); }
.tab-strip .tab-bar { flex:1; min-width:0; height:100%; overflow-y:hidden; overscroll-behavior-x:contain; overflow-anchor:none; scroll-behavior:auto; border-bottom:0; }
.close-all-tabs { display:flex; align-items:center; gap:5px; flex:none; padding:0 12px; border-left:1px solid var(--ui-line); font-size:11px; color:var(--ui-muted); }
.close-all-tabs:hover:not(:disabled) { color:var(--ui-text); background:var(--ui-surface); }
.close-documents-dialog { width:min(560px,calc(100vw - 32px)); max-height:calc(100dvh - 40px); overflow:auto; }
.close-document-list { list-style:none; padding:0; margin:17px 0 5px; max-height:min(240px,35dvh); overflow:auto; border:1px solid var(--ui-line); border-radius:8px; }
.close-document-list li { display:flex; align-items:center; gap:9px; padding:10px 12px; font-size:12px; }
.close-document-list li + li { border-top:1px solid var(--ui-line); }
.close-document-list svg,.close-document-state { flex:none; }
.close-document-list li > span:not(.close-document-state) { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.close-document-state { color:var(--ui-warning); font-size:11px; }
.close-documents-dialog .modal-actions { flex-wrap:wrap; }
.create-card.note { --accent:#8965bb; --pale:color-mix(in srgb,#8965bb 12%,var(--ui-surface)); }
.file-icon.note { color:#8965bb; background:color-mix(in srgb,#8965bb 12%,var(--ui-surface)); }
@media(max-width:600px) { .close-all-tabs { padding:0 9px; } .close-all-tabs span { display:none; } }
@media(max-width:900px) { .autosave-toggle { width:auto!important; min-width:38px; padding:4px!important; flex:none; } .autosave-label { display:none; } }
.autosave-countdown{font-size:11px;font-variant-numeric:tabular-nums;min-width:30px;color:var(--ui-accent)}
.autosave-toggle{display:inline-flex;gap:6px!important;align-items:center;white-space:nowrap}.autosave-track{width:25px;height:15px;border-radius:12px;background:var(--ui-line-strong);padding:2px;display:inline-flex;align-items:center}.autosave-track i{width:11px;height:11px;border-radius:50%;background:white;box-shadow:0 1px 3px #0002;transition:transform .15s}.autosave-track.enabled{background:var(--ui-accent)}.autosave-track.enabled i{transform:translateX(10px)}

.save-format-dialog { width: min(480px, 100%); }
.save-name-label { display: grid; gap: 8px; margin: 20px 0; font-size: 13px; font-weight: 500; }
.save-name-input { display: flex; align-items: center; border: 1px solid var(--ui-line-strong); border-radius: var(--ui-radius); overflow: hidden; }
.save-name-input:focus-within { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.save-name-input input { min-width: 0; flex: 1; padding: 11px; border: 0; outline: none; background: transparent; font: inherit; color: inherit; }
.save-name-input > span { padding: 0 12px 0 0; color: var(--ui-muted); font-weight: 400; }
.save-format-options { display: grid; gap: 8px; border: 0; padding: 0; margin: 0; min-width: 0; }
.save-format-options legend { font-size: 13px; font-weight: 500; padding: 0 0 8px; }
.save-format-option { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--ui-line); border-radius: var(--ui-radius); cursor: pointer; }
.save-format-option.selected { border-color: var(--ui-accent); background: var(--ui-accent-soft); }
.save-format-option input { width: 16px; height: 16px; accent-color: var(--ui-accent); flex: none; }
.save-format-option strong { display: block; font-size: 13px; font-weight: 600; }
.save-format-option small { display: block; margin-top: 4px; color: var(--ui-muted); font-size: 12px; line-height: 1.5; }
.save-format-note { margin-top: 14px; }
.save-format-dialog .save-format-error { color: #b3261e; margin-top: 10px; }
.import-review-notice {
  display: flex; align-items: flex-start; gap: 9px; flex: none;
  padding: 9px 16px; background: var(--ui-warning-soft); border-bottom: 1px solid #eadcb7;
  color: var(--ui-warning); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere;
}
.import-review-notice > svg { flex: none; margin-top: 2px; }
.import-review-notice p { margin: 0; }
.import-review-notice strong { font-weight: 600; }
</style>
