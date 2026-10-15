<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import Icon from './components/Icon.vue'
import OfficeEditor from './components/OfficeEditor.vue'
const StandaloneWordEditor = defineAsyncComponent(() => import('./components/StandaloneWordEditor.vue'))
import RustWordEditor from './components/RustWordEditor.vue'
import RustSheetEditor from './components/RustSheetEditor.vue'
import PdfEditor from './components/PdfEditor.vue'
import SlidePreview from './components/SlidePreview.vue'
import StandalonePresentationEditor from './components/StandalonePresentationEditor.vue'
import WordWorkbench from './components/WordWorkbench.vue'
import SheetWorkbench from './components/SheetWorkbench.vue'
import type { PresentationState, PresentationAction } from './presentation/types'
import type { WriterState, WriterAction, WriterCommand, WriterQuery } from './word/types'
import type { CalcState, CalcAction, CalcDataQuery } from './sheet/types'
import type { PptxPresentation, patchPptxPackage } from './presentation/pptx-package'
import * as native from './native'
import { smokeAwait, smokeFailure, smokeFeatures, smokeRequested, smokeStage } from './smoke'
import type { NativeDocument, RecentDocument } from './types'
import type { OfficeDocument } from './office/types'
import { reviewOfficeImport } from './office/import-review'
import { useDialogFocus } from './shared/dialog-focus'
import { useAppearance } from './shared/appearance'
import { prepareWordDocument, type PreparedWordDocument } from './word/core/prepared'
import { inspectWordcraftSession, prepareRustWordDocument, type PreparedRustWordDocument } from './word/rust/client'
import { inspectGridcraftSession, prepareRustSheetDocument, type PreparedRustSheetDocument } from './sheet/rust/client'
import type { GridcraftSmokeEditor } from './sheet/rust/gridcraft-native-smoke'
import type { WordcraftSmokeEditor } from './word/rust/wordcraft-native-smoke'
import { bytesToBase64, base64ToBytes, extensionOf, kindOf, withExtension, defaultSaveExtension, isImportOnly, validateDocumentSignature, saveFormats, saveFileName, type SaveExtension, type Kind, type Extension, type EditorHandle } from './shared/document'

type WordEngine = 'rust' | 'independent' | 'legacy'
type SheetEngine = 'rust' | 'legacy'
interface Tab { key: string; document: NativeDocument; wordEngine?: WordEngine; sheetEngine?: SheetEngine; fileId?: string; requiresSaveAs?: boolean; importWarnings?:string[]; dirty: boolean; ready: boolean; loadError?: string }
const appVersion = __APP_VERSION__
const buildVersion = __BUILD_VERSION__
const brandIcon = new URL('./favicon.svg', document.baseURI).href
const { appearance } = useAppearance()
const appearanceOptions = [
  { value: 'light', icon: 'sun', label: '浅色主题' },
  { value: 'dark', icon: 'moon', label: '深色主题' },
  { value: 'system', icon: 'monitor', label: '跟随系统' },
] as const
const smokeMode = ref(smokeRequested())
smokeStage('app-setup', 'Vue setup reached')
const tabs = ref<Tab[]>([]), activeKey = ref(''), home = ref(true), section = ref('home')
const tabBar = ref<HTMLElement>()
let tabBarObserver: ResizeObserver | undefined
function revealActiveTab() {
  const bar = tabBar.value, tab = bar?.querySelector<HTMLElement>('.document-tab.active')
  if (home.value || !bar?.clientWidth || !tab) return
  const viewport = bar.getBoundingClientRect(), item = tab.getBoundingClientRect()
  if (item.left < viewport.left) bar.scrollLeft += item.left - viewport.left
  else if (item.right > viewport.right) bar.scrollLeft += item.right - viewport.right
}
watch([activeKey, home], revealActiveTab, { flush: 'post' })
onMounted(() => {
  tabBarObserver = new ResizeObserver(revealActiveTab)
  if (tabBar.value) tabBarObserver.observe(tabBar.value)
})
onBeforeUnmount(() => tabBarObserver?.disconnect())
const active = computed(() => tabs.value.find(t => t.key === activeKey.value))
const activeIndependentWord = computed(() => active.value?.document.kind === 'word' && active.value.wordEngine === 'independent')
const activeRustWord = computed(() => active.value?.document.kind === 'word' && active.value.wordEngine === 'rust')
const activeRustSheet = computed(() => active.value?.document.kind === 'sheet' && active.value.sheetEngine === 'rust')
const activeRustEditor = computed(() => activeRustWord.value || activeRustSheet.value)
const activeOwnWord = computed(() => activeIndependentWord.value || activeRustWord.value)
const rustWordDocument = shallowRef<NativeDocument>()
const rustWordPrepared = shallowRef<PreparedRustWordDocument>()
const rustWordEditor = ref<EditorHandle>()
const rustWordEntries = shallowRef<{document:NativeDocument;prepared?:PreparedRustWordDocument}[]>([])
const rustWordHandles = new Map<string,EditorHandle>()
function setRustWordDocument(document?: NativeDocument, prepared?: PreparedRustWordDocument) {
  if(!document) {
    for(const entry of rustWordEntries.value)entry.prepared?.discard()
    rustWordEntries.value=[];rustWordHandles.clear()
  } else if(!rustWordEntries.value.some(entry=>entry.document.id===document.id)) {
    rustWordEntries.value=[...rustWordEntries.value,{document,prepared}]
  } else prepared?.discard()
  rustWordPrepared.value = prepared
  rustWordDocument.value = document
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
const independentWordDocument = shallowRef<NativeDocument>()
const independentWordPrepared = shallowRef<PreparedWordDocument>()
let appDisposed = false
function setIndependentWordDocument(document?: NativeDocument, prepared?: PreparedWordDocument) {
  independentWordPrepared.value?.discard()
  independentWordPrepared.value = prepared
  independentWordDocument.value = document
}
onBeforeUnmount(() => { appDisposed = true; setIndependentWordDocument(); setRustWordDocument(); setRustSheetDocument() })
const independentWordEditor = ref<EditorHandle>()
const officeDocument = shallowRef<OfficeDocument>(), pdfDocument = shallowRef<NativeDocument>(), presentationDocument = shallowRef<NativeDocument>()
const officeEditor = ref<EditorHandle & { insertImage?(image: {name:string;base64:string}):Promise<void>; newSlide?():Promise<unknown>; smokeTest?():Promise<unknown>; getPresentationState?():Promise<PresentationState>; presentationObjectData?(query:{type:'table'|'chart';id:string}):Promise<unknown>; presentationAction?(action:PresentationAction):Promise<PresentationState>; presentationEdit?(patch:PresentationPatch):Promise<void>; getWriterState?():Promise<WriterState>; writerAction?(action:WriterAction):Promise<WriterState>; writerCommand?(command:WriterCommand):Promise<WriterState>; writerData?(query:WriterQuery):Promise<unknown>; getCalcState?():Promise<CalcState>; calcAction?(action:CalcAction):Promise<CalcState>; calcData?(query:CalcDataQuery):Promise<unknown> }>()
type PresentationPatch = Omit<Parameters<typeof patchPptxPackage>[1]['slides'][number], 'slideIndex'>
const pdfEditor = ref<EditorHandle>()
type PresentationEditorHandle = EditorHandle & {
  present(startPage?:number):Promise<void>; stopPresentation():void
  assertNoPendingEdits():void; discardDrafts():void
  insertImage(image:{name:string;base64:string;mimeType?:string}):Promise<void>
  newSlide():Promise<unknown>; getPresentationState():Promise<PresentationState>
  presentationAction(action:PresentationAction):Promise<PresentationState>
  presentationObjectData(query:{type:'table'|'chart';id:string}):Promise<unknown>
  presentationEdit(patch:PresentationPatch):Promise<void>
}
const presentationEditor = ref<PresentationEditorHandle>()
const presentationState = shallowRef<PresentationState | null>(null)
type WorkbenchDrafts<T> = {hasPendingEdits():boolean;assertNoPendingEdits():void;discardDrafts():void;actionSucceeded?(state:T):void;actionFailed?():void}
const wordWorkbench = ref<WorkbenchDrafts<WriterState>>(), sheetWorkbench = ref<WorkbenchDrafts<CalcState>>()
const writerState = shallowRef<WriterState | null>(null), calcState = shallowRef<CalcState | null>(null)
function assertWorkbenchDrafts() {
  if(active.value?.document.kind==='word'&&!activeOwnWord.value)wordWorkbench.value?.assertNoPendingEdits()
  if(active.value?.document.kind==='sheet'&&!activeRustSheet.value)sheetWorkbench.value?.assertNoPendingEdits()
  if(active.value?.document.kind!=='presentation')return
  presentationEditor.value?.assertNoPendingEdits()
}
function presentationChanged(state:PresentationState) {if(state.documentId===activeKey.value)presentationState.value=state}
function writerChanged(state:WriterState) {if(state.documentId===activeKey.value)writerState.value=state}
function calcChanged(state:CalcState) {if(state.documentId===activeKey.value)calcState.value=state}
watch(activeKey,()=>{presentationState.value=null;writerState.value=null;calcState.value=null})
const slidePreview = shallowRef<{base64:string;name:string;startPage:number;presentation?:PptxPresentation}>()
const recents = ref<RecentDocument[]>([]), busy = ref(''), error = ref(''), status = ref('所有文件，仅在你的设备上处理')
const help = ref(false), search = ref(''), closeTarget = ref<Tab | 'window' | null>(null)
const saveAsDraft = ref<{ key:string; kind:Kind; format:SaveExtension; name:string; error:string } | null>(null)
const globalActionsBlocked = computed(() => !!busy.value || !!saveAsDraft.value || !!closeTarget.value || help.value || !!slidePreview.value)
const currentDocument = computed(() => home.value ? undefined : active.value)
const documentActionsDisabled = computed(() => globalActionsBlocked.value || !currentDocument.value?.ready)
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
    if (currentDocument.value?.document.kind !== 'pdf' && !activeIndependentWord.value) save(true, 'pdf')
  } else if (action !== 'print' || !activeIndependentWord.value) editCommand(action)
}
watch([activeKey, home, globalActionsBlocked], () => closeNewMenu())
const saveAsDialog = ref<HTMLElement>()
function formatsFor(tab:Tab | undefined) {
  return !tab ? [] : tab.sheetEngine==='rust'
    ? [{extension:'xlsx' as const,title:'XLSX 工作簿',description:'保存可编辑的工作表、公式与格式'}, {extension:'csv' as const,title:'CSV 数据副本',description:'仅导出当前工作表的显示值，不包含公式、格式和其他工作表'}, {extension:'tsv' as const,title:'TSV 数据副本',description:'以制表符分隔当前工作表的显示值，不包含公式、格式和其他工作表'}, {extension:'pdf' as const,title:'PDF 文档',description:'用于阅读、打印与分享'}]
    : tab.wordEngine==='rust'
    ? [{extension:'docx' as const,title:'DOCX 文档',description:'保存可编辑的文字、表格与排版'}, {extension:'pdf' as const,title:'PDF 文档',description:'用于阅读、打印与分享'}]
    : tab.wordEngine==='independent' ? [{extension:'docx' as const,title:'DOCX 文档',description:'保存当前正文和已支持的文字、段落格式'}] : saveFormats(tab.document.kind)
}
const saveAsOptions = computed(() => formatsFor(tabs.value.find(tab=>tab.key===saveAsDraft.value?.key)))
const saveAsCopy = computed(() => !!saveAsDraft.value&&!!active.value&&saveAsDraft.value.format!==defaultSaveExtension(active.value.document.extension))
useDialogFocus(saveAsDialog)
const helpDialog = ref<HTMLElement>(), closeDialog = ref<HTMLElement>()
useDialogFocus(helpDialog)
useDialogFocus(closeDialog)
const fileInput = ref<HTMLInputElement>(), independentWordInput = ref<HTMLInputElement>(), legacyWordInput = ref<HTMLInputElement>(), legacySheetInput = ref<HTMLInputElement>(), imageInput = ref<HTMLInputElement>()
let unlisten: (() => void) | undefined
let pendingWindowClose = false
const editor = () => activeRustSheet.value ? rustSheetHandles.get(activeKey.value) : activeRustWord.value ? rustWordHandles.get(activeKey.value)??rustWordEditor.value : activeIndependentWord.value ? independentWordEditor.value : active.value?.document.kind === 'pdf' ? pdfEditor.value : active.value?.document.kind === 'presentation' ? presentationEditor.value : officeEditor.value
const imageEditor = () => activeOwnWord.value || activeRustSheet.value ? undefined : active.value?.document.kind === 'presentation' ? presentationEditor.value : officeEditor.value
const kindNames: Record<Kind,string> = { word:'文字文档', sheet:'电子表格', presentation:'演示文稿', pdf:'PDF 文档' }
const icons: Record<Kind,string> = {word:'file',sheet:'sheet',presentation:'presentation',pdf:'pdf'}
const filteredRecents = computed(() => recents.value.filter(r => r.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const message = (e:unknown) => e instanceof Error ? e.message : String(e)
async function editorTransaction<T>(label:string, work:()=>Promise<T>):Promise<T> {
  if (busy.value) throw Error('正在处理另一项文档操作，请等待完成。')
  error.value=''; busy.value=label
  try {
    // Native verification uses this same input barrier as user actions.
    // Do not suppress dirty events or replace a failed revision with a newer one.
    const focused=document.activeElement
    if(focused instanceof HTMLElement) focused.blur()
    await nextTick()
    return await work()
  } finally {
    busy.value=''
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
  assertWorkbenchDrafts()
  const handle=requireEditor(tab), exported=await handle.exportFile({format:defaultSaveExtension(tab.document.extension)})
  if(activeKey.value!==tab.key)throw Error('文档已切换，旧的导出结果未被使用。')
  if(isImportOnly(exported.extension))throw Error('旧版格式仅支持导入，请另存为现代格式。原文件未被修改。')
  if(exported.dirty)tab.dirty=true
  return {handle,exported,document:{...tab.document,name:withExtension(tab.document.name,exported.extension),base64:exported.base64,extension:exported.extension,sizeBytes:Math.floor(exported.base64.length*.75)}}
}
async function stash() {
  const tab=active.value
  if(!tab || tab.loadError) return
  // Dirty notifications arrive asynchronously. Always snapshot the actual loaded model.
  // Export also refuses un-applied PDF drafts, and Office discard checks this revision.
  const snapshot=await capture(tab)
  await snapshot.handle.discardChanges?.()
  // An imported legacy source stays read-only even after an in-memory snapshot
  // has a modern extension. Only a successful Save As clears this safeguard.
  tab.requiresSaveAs=tab.requiresSaveAs||isImportOnly(tab.document.extension)
  tab.document=snapshot.document
}
async function activate(tab:Tab) {
  if(activeKey.value!==tab.key) {
    const reuseOffice=(tab.wordEngine==='legacy'||tab.sheetEngine==='legacy')&&officeDocument.value?.id===tab.key
    const reuseRustSheet=tab.sheetEngine==='rust'&&rustSheetEntries.value.some(entry=>entry.document.id===tab.key)
    const reuseRustWord=tab.wordEngine==='rust'&&rustWordEntries.value.some(entry=>entry.document.id===tab.key)
    const reuseIndependentWord=tab.wordEngine==='independent'&&independentWordDocument.value?.id===tab.key
    const reusePresentation=tab.document.kind==='presentation'&&presentationDocument.value?.id===tab.key
    await stash()
    activeKey.value=tab.key
    if(tab.sheetEngine==='rust') {
      if(!reuseRustSheet){tab.ready=false;tab.loadError=undefined}
      setRustSheetDocument(tab.document)
    } else if(tab.wordEngine==='rust') {
      if(!reuseRustWord){tab.ready=false;tab.loadError=undefined}
      setRustWordDocument(tab.document)
    }
    else if(tab.wordEngine==='independent') {
      if(!reuseIndependentWord){tab.ready=false;tab.loadError=undefined}
      setIndependentWordDocument(tab.document)
    }
    else if(tab.document.kind==='pdf') {tab.ready=false;tab.loadError=undefined;pdfDocument.value=tab.document}
    else if(tab.document.kind==='presentation') {
      if(!reusePresentation){tab.ready=false;tab.loadError=undefined}
      presentationDocument.value=tab.document
    } else {
      if(officeDocument.value?.id!==tab.key) {tab.ready=false;tab.loadError=undefined}
      officeDocument.value=tab.document as OfficeDocument
    }
    await nextTick()
    // A PDF tab hides rather than destroys the Office canvas. On returning to
    // that same document no prop change occurs, so refresh its cleared toolbar
    // state explicitly without reopening or losing the in-memory model.
    if(reuseOffice&&tab.ready) {
      if(tab.document.kind==='word'&&officeEditor.value?.getWriterState)writerChanged(await officeEditor.value.getWriterState())
      else if(tab.document.kind==='sheet'&&officeEditor.value?.getCalcState)calcChanged(await officeEditor.value.getCalcState())
    }
    if(reusePresentation&&tab.ready&&presentationEditor.value)presentationChanged(await presentationEditor.value.getPresentationState())
  }
  home.value=false
}
async function addDocument(doc:NativeDocument, fileId?:string, wordEngine?:WordEngine, sheetEngine?:SheetEngine) {
  // Capture the exact source before asynchronous preflight or snapshot work.
  doc={...doc}
  if(doc.kind==='word') wordEngine ??= 'rust'
  else wordEngine=undefined
  if(doc.kind==='sheet')sheetEngine ??= ['xlsx','csv','tsv'].includes(doc.extension)?'rust':'legacy'
  else sheetEngine=undefined
  if(doc.kind==='presentation'&&doc.extension!=='pptx')throw Error('独立演示编辑器目前支持 PPTX。请先将旧 PPT 或 ODP 转换为 PPTX；原文件未修改。')
  const existing=fileId && tabs.value.find(t=>t.fileId===fileId&&t.wordEngine===wordEngine&&t.sheetEngine===sheetEngine)
  if(existing) { await activate(existing); return }
  const key=crypto.randomUUID()
  let prepared:PreparedWordDocument|undefined
  let rustPrepared:PreparedRustWordDocument|undefined
  let sheetPrepared:PreparedRustSheetDocument|undefined
  try {
    if(sheetEngine==='rust')sheetPrepared=await prepareRustSheetDocument({...doc,id:key})
    if(wordEngine==='rust') {
      if(doc.extension!=='docx')throw Error('当前文字编辑器支持 DOCX。其他格式请从工作台的“兼容编辑器”入口打开。')
      // Rust parses and lays out the entire input before an existing tab is touched.
      rustPrepared=await prepareRustWordDocument({...doc,id:key})
    }
    if(wordEngine==='independent') {
      if(doc.kind!=='word'||doc.extension!=='docx')throw Error('轻量文字文档目前只支持 DOCX。请从“兼容编辑器”打开其他格式。')
      if(doc.base64) {
        // Validate the entire supported subset before creating a tab or replacing
        // a currently editable model. Rejected documents remain untouched.
        const {importWordDocument}=await import('./word/core/runtime')
        prepared=prepareWordDocument({id:key,base64:doc.base64},await importWordDocument(base64ToBytes(doc.base64)))
      }
    }
    if(appDisposed)return
    // The compatibility review describes that engine's format conversions.
    // The Rust workbook parser supplies its own import warnings.
    const review=sheetEngine==='rust'?{requiresSaveAs:false,warnings:sheetPrepared?.warnings??[]}:reviewOfficeImport(doc)
    const protectedWordImport=(wordEngine==='independent'||wordEngine==='rust')&&!!doc.base64
    const protectedSheetImport=sheetEngine==='rust'&&!!doc.base64
    const importWarnings=protectedSheetImport
      ? [doc.extension==='xlsx'?'此工作簿首次保存将生成副本。请核对复杂公式、图表与格式。':'已导入文本数据；保存为 XLSX 工作簿，原始数据文件保留。',...review.warnings]
      : protectedWordImport?[wordEngine==='rust'?'此文档首次保存将生成副本。请核对复杂文档的排版与内容。':'此 DOCX 已通过轻量文字文档的支持范围检查，首次保存将生成副本。',...review.warnings]:review.warnings
    const tab:Tab={key,document:{...doc,id:key},wordEngine,sheetEngine,fileId,requiresSaveAs:protectedWordImport||protectedSheetImport||isImportOnly(doc.extension)||review.requiresSaveAs,importWarnings,dirty:!fileId,ready:false}
    await stash()
    if(appDisposed)return
    tabs.value.push(tab); activeKey.value=key; home.value=false
    if(sheetEngine==='rust') {setRustSheetDocument(tab.document,sheetPrepared);sheetPrepared=undefined}
    else if(wordEngine==='rust') {setRustWordDocument(tab.document,rustPrepared);rustPrepared=undefined}
    else if(wordEngine==='independent') {setIndependentWordDocument(tab.document,prepared);prepared=undefined}
    else if(doc.kind==='pdf') pdfDocument.value=tab.document
    else if(doc.kind==='presentation')presentationDocument.value=tab.document
    else officeDocument.value=tab.document as OfficeDocument
  } finally {
    // Failed preflight/stash or disposal must not retain an undelivered model.
    prepared?.discard()
    rustPrepared?.discard()
    sheetPrepared?.discard()
  }
}
function newDocument(kind:Kind,wordEngine?:WordEngine) {
  void task('正在新建文档',async()=>{
    const extension:Extension=kind==='word'?'docx':kind==='sheet'?'xlsx':kind==='presentation'?'pptx':'pdf'
    const number=tabs.value.filter(t=>t.document.kind===kind).length+1
    await addDocument({id:'',kind,extension,name:`未命名${kindNames[kind]}${number}.${extension}`,base64:'',sha256:'',sizeBytes:0},undefined,wordEngine)
  })
}
async function refreshRecents() { if(native.isTauri()) recents.value=await native.listRecentDocuments() }
function openFile() {
  if(native.isTauri()) void task('正在打开文件',async()=>{
    const document=await native.openDocument(); if(document) await addDocument(document,document.id)
    await refreshRecents()
  })
  else fileInput.value?.click()
}
function openIndependentWord() {
  if(native.isTauri())void task('正在打开轻量文字文档',async()=>{
    const document=await native.openDocument()
    if(document)await addDocument(document,document.id,'independent')
    await refreshRecents()
  })
  else independentWordInput.value?.click()
}
function openLegacyWord() {
  if(native.isTauri())void task('正在打开兼容文字文档',async()=>{
    const doc=await native.openDocument()
    if(doc) {
      if(doc.kind!=='word')throw Error('请选择文字文档。')
      await addDocument(doc,doc.id,'legacy')
    }
    await refreshRecents()
  })
  else legacyWordInput.value?.click()
}
function openLegacySheet() {
  if(native.isTauri())void task('正在打开兼容工作簿',async()=>{
    const doc=await native.openDocument()
    if(doc) {
      if(!['xlsx','ods','xls'].includes(doc.extension))throw Error('兼容表格支持 XLSX、ODS 与 XLS 文件。')
      await addDocument(doc,doc.id,undefined,'legacy')
    }
    await refreshRecents()
  })
  else legacySheetInput.value?.click()
}
async function browserLegacySheet(event:Event) {
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value=''
  if(!file)return
  await task('正在读取兼容工作簿',async()=>{
    const extension=extensionOf(file.name)
    if(!['xlsx','ods','xls'].includes(extension))throw Error('兼容表格支持 XLSX、ODS 与 XLS 文件。')
    if(file.size>40*1024*1024)throw Error('请选择不超过 40 MB 的工作簿。')
    const bytes=new Uint8Array(await file.arrayBuffer());validateDocumentSignature(bytes,extension)
    await addDocument({id:'',name:file.name,extension,kind:'sheet',base64:bytesToBase64(bytes),sha256:'',sizeBytes:file.size},undefined,undefined,'legacy')
  })
}
async function browserLegacyWord(event:Event) {
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value=''
  if(!file)return
  await task('正在读取兼容文字文档',async()=>{
    const extension=extensionOf(file.name)
    if(kindOf(extension)!=='word')throw Error('请选择文字文档。')
    if(file.size>40*1024*1024)throw Error('请选择不超过 40 MB 的文档。')
    const bytes=new Uint8Array(await file.arrayBuffer());validateDocumentSignature(bytes,extension)
    await addDocument({id:'',name:file.name,extension,kind:'word',base64:bytesToBase64(bytes),sha256:'',sizeBytes:file.size},undefined,'legacy')
  })
}
async function browserIndependentWord(event:Event) {
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value=''
  if(!file)return
  await task('正在读取轻量文字文档',async()=>{
    if(extensionOf(file.name)!=='docx')throw Error('轻量文字文档目前只支持 DOCX。')
    if(file.size>40*1024*1024)throw Error('请选择不超过 40 MB 的文档。')
    const bytes=new Uint8Array(await file.arrayBuffer())
    validateDocumentSignature(bytes,'docx')
    await addDocument({id:'',name:file.name,extension:'docx',kind:'word',base64:bytesToBase64(bytes),sha256:'',sizeBytes:file.size},undefined,'independent')
  })
}
async function browserFile(event:Event) {
  const input=event.target as HTMLInputElement, file=input.files?.[0]; input.value=''
  if(!file) return
  await task('正在读取文件',async()=>{
    const extension=extensionOf(file.name)
    if(file.size>40*1024*1024) throw Error('请选择不超过 40 MB 的文档。')
    const bytes=new Uint8Array(await file.arrayBuffer())
    validateDocumentSignature(bytes,extension)
    await addDocument({id:'',name:file.name,extension,kind:kindOf(extension),base64:bytesToBase64(bytes),sha256:'',sizeBytes:file.size})
  })
}
function openRecent(item:RecentDocument) { void task('正在打开最近文件',async()=>{const doc=await native.openRecent(item.id);await addDocument(doc,doc.id);await refreshRecents()}) }
function download(base64:string,name:string) {
  const url=URL.createObjectURL(new Blob([base64ToBytes(base64).buffer as ArrayBuffer])), link=document.createElement('a')
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000)
}
async function saveActive(saveAs=false, format?:Extension, chosenName?:string):Promise<boolean> {
  const tab=active.value;if(!tab)return false
  assertWorkbenchDrafts()
  if(format&&isImportOnly(format))throw Error('旧版格式仅支持导入，请选择 DOCX、XLSX 或 PPTX 保存副本。')
  if(tab.document.kind==='presentation'&&format&&format!=='pptx'&&format!=='pdf')throw Error('独立演示编辑器支持保存 PPTX 和导出 PDF，暂不支持 ODP 转换。')
  const requestedFormat=format||defaultSaveExtension(tab.document.extension)
  if(!formatsFor(tab).some(option=>option.extension===requestedFormat))throw Error(tab.wordEngine==='independent'?'轻量文字文档目前只支持保存 DOCX。':'当前编辑器不支持此保存格式。')
  const handle=requireEditor(tab)
  const exported=await handle.exportFile({format:requestedFormat})
  if(activeKey.value!==tab.key)throw Error('文档已切换，本次保存已取消。')
  if(isImportOnly(exported.extension))throw Error('编辑器未生成现代格式，保存已取消，原文件未被修改。')
  if(exported.extension!==requestedFormat)throw Error('编辑器返回的格式与所选格式不一致，保存已取消。')
  if(exported.dirty)tab.dirty=true
  const isCopy=(tab.sheetEngine==='rust'&&['csv','tsv','pdf'].includes(requestedFormat))||(!!format && format!==tab.document.extension)
  const protectSource=tab.requiresSaveAs||isImportOnly(tab.document.extension)
  // The shell owns the saved filename; editor snapshots may still carry the
  // original import name after a same-format Save As.
  const exportName=withExtension(tab.document.name||exported.name||'未命名',exported.extension)
  const name=chosenName||(protectSource?exportName.replace(/\.[^.]+$/,` - 副本.${exported.extension}`):exportName)
  if(!native.isTauri()) {
    download(exported.base64,name)
    if(!isCopy) { tab.document={...tab.document,base64:exported.base64,name,extension:exported.extension};tab.requiresSaveAs=false;tab.importWarnings=[];await handle.markSaved?.(exported.base64);tab.dirty=false }
    status.value='已生成下载文件';return true
  }
  const result=await native.saveDocument({documentId:isCopy||protectSource?undefined:tab.fileId,name,extension:exported.extension,base64:exported.base64,expectedSha256:isCopy||protectSource?undefined:tab.document.sha256,saveAs:saveAs||isCopy||protectSource||exported.saveAs||!tab.fileId})
  if(result.status==='cancelled') return false
  if(result.status==='conflict') { error.value=`${result.message} 请使用“另存为”保留当前修改。`;return false }
  if(!isCopy) {
    tab.fileId=result.document.id
    tab.document={...result.document,id:tab.key,base64:exported.base64}
    tab.requiresSaveAs=false
    tab.importWarnings=[]
    await handle.markSaved?.(exported.base64);tab.dirty=false
  }
  await refreshRecents();status.value=isCopy?`${exported.extension.toUpperCase()} 副本已保存`:'已保存到本机';return true
}
function openSaveAs() {
  const tab=active.value
  if(!tab?.ready||busy.value||closeTarget.value)return
  const formats=formatsFor(tab), preferred=defaultSaveExtension(tab.document.extension)
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
      const format=draft.format===defaultSaveExtension(active.value!.document.extension)?undefined:draft.format
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
function newSlide() {
  void task('正在新建幻灯片',async()=>{
    assertWorkbenchDrafts()
    if(!presentationEditor.value)throw Error('演示文稿编辑器尚未就绪。')
    await presentationEditor.value.newSlide()
  })
}
function runWriterAction(action:WriterAction) {
  void task('正在更新文档',async()=>{
    if(active.value?.document.kind!=='word'||activeOwnWord.value||!officeEditor.value?.writerAction)throw Error('文字工作台尚未就绪。')
    try {
      const state=await officeEditor.value.writerAction(action)
      writerChanged(state);wordWorkbench.value?.actionSucceeded?.(state)
    } catch(error) {wordWorkbench.value?.actionFailed?.();throw error}
  })
}
function runWriterCommand(command:WriterCommand) {
  void task('正在更新文档',async()=>{
    assertWorkbenchDrafts()
    if(active.value?.document.kind!=='word'||activeOwnWord.value||!officeEditor.value?.writerCommand)throw Error('文字工作台尚未就绪。')
    writerChanged(await officeEditor.value.writerCommand(command))
  })
}
function runCalcAction(action:CalcAction) {
  void task('正在更新工作表',async()=>{
    if(active.value?.document.kind!=='sheet'||!officeEditor.value?.calcAction)throw Error('表格工作台尚未就绪。')
    try {
      const state=await officeEditor.value.calcAction(action)
      calcChanged(state);sheetWorkbench.value?.actionSucceeded?.(state)
    } catch(error) {sheetWorkbench.value?.actionFailed?.();throw error}
  })
}
function refreshWriter() {void task('正在刷新文档属性',async()=>{if(officeEditor.value?.getWriterState)writerChanged(await officeEditor.value.getWriterState())})}
function refreshCalc() {void task('正在刷新工作表属性',async()=>{if(officeEditor.value?.getCalcState)calcChanged(await officeEditor.value.getCalcState())})}
async function readFreshWriterState():Promise<WriterState> {
  const tab=active.value, handle=officeEditor.value
  if(!tab?.ready||tab.document.kind!=='word'||tab.wordEngine!=='legacy'||!handle?.getWriterState)throw Error('文字文档尚未准备好，输入已保留。')
  const state=await handle.getWriterState()
  if(activeKey.value!==tab.key||officeEditor.value!==handle||state.documentId!==tab.key)throw Error('文档已切换，本次核对已取消，输入已保留。')
  writerChanged(state)
  return state
}
async function readWriterData(query:WriterQuery) {
  if(!officeEditor.value?.writerData)throw Error('文字文档尚未准备好。')
  return officeEditor.value.writerData(query)
}
async function readCalcData(query:CalcDataQuery) {
  if(!officeEditor.value?.calcData)throw Error('工作表尚未准备好。')
  return officeEditor.value.calcData(query)
}
function previewSlides(startPage=0) {
  void task('正在准备放映',async()=>{
    if(active.value?.document.kind!=='presentation'||!presentationEditor.value)return
    assertWorkbenchDrafts()
    await presentationEditor.value.present(startPage)
  })
}
function closeSlidePreview() {slidePreview.value=undefined}
function changeTab(tab:Tab) {void task('正在切换文档',()=>activate(tab))}
async function removeTab(tab:Tab, discardConfirmed=false) {
  if(tab.key===activeKey.value) {
    if(discardConfirmed) {presentationEditor.value?.discardDrafts();wordWorkbench.value?.discardDrafts();sheetWorkbench.value?.discardDrafts()}
    if(tab.ready)await editor()?.discardChanges?.({force:discardConfirmed})
    const next=tabs.value.find(t=>t.key!==tab.key)
    // Do not ask stash() to export a tab whose close was already checked/confirmed.
    activeKey.value=''
    if(next) await activate(next)
    else {home.value=true;officeDocument.value=undefined;pdfDocument.value=undefined;presentationDocument.value=undefined;setIndependentWordDocument();setRustWordDocument();setRustSheetDocument()}
  }
  tabs.value=tabs.value.filter(t=>t.key!==tab.key)
  // Keep a hidden Office model only while its tab can still be resumed. Closing
  // that tab must also unload its WASM iframe, even when PDF tabs remain open.
  if(officeDocument.value&&!tabs.value.some(t=>t.key===officeDocument.value?.id)) {
    officeDocument.value=undefined
    presentationState.value=null;writerState.value=null;calcState.value=null
  }
  if(pdfDocument.value&&!tabs.value.some(t=>t.key===pdfDocument.value?.id))pdfDocument.value=undefined
  if(presentationDocument.value&&!tabs.value.some(t=>t.key===presentationDocument.value?.id))presentationDocument.value=undefined
  if(independentWordDocument.value&&!tabs.value.some(t=>t.key===independentWordDocument.value?.id))setIndependentWordDocument()
  for(const entry of rustWordEntries.value)if(!tabs.value.some(t=>t.key===entry.document.id))entry.prepared?.discard()
  rustWordEntries.value=rustWordEntries.value.filter(entry=>tabs.value.some(t=>t.key===entry.document.id))
  if(rustWordDocument.value&&!tabs.value.some(t=>t.key===rustWordDocument.value?.id))rustWordDocument.value=undefined
  for(const entry of rustSheetEntries.value)if(!tabs.value.some(t=>t.key===entry.document.id))entry.prepared?.discard()
  rustSheetEntries.value=rustSheetEntries.value.filter(entry=>tabs.value.some(t=>t.key===entry.document.id))
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
async function closeWindow() {
  if(busy.value) {pendingWindowClose=true;return}
  saveAsDraft.value=null
  // The native close confirmation must remain visible above a presentation.
  presentationEditor.value?.stopPresentation()
  if(slidePreview.value) {closeSlidePreview();await nextTick()}
  await task('正在检查未保存修改',async()=>{
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
    if(target==='window') {
      if(action==='save') for(const tab of tabs.value.filter(t=>t.dirty)) {await activate(tab);await awaitReady(tab);if(!await saveActive())return}
      closeTarget.value=null;await native.confirmClose()
    } else {
      if(action==='save') {await activate(target);await awaitReady(target);if(!await saveActive())return}
      await removeTab(target,action==='discard');closeTarget.value=null
    }
  })
}
function editCommand(command:'undo'|'redo'|'print') {void task('正在处理',async()=>{if(activeIndependentWord.value&&command==='print')throw Error('当前轻量文字预览暂不支持打印或 PDF 导出。');const fn=editor()?.[command];if(fn)await fn();else if(command==='print'&&await saveActive(true,'pdf'))status.value='已导出 PDF；请在系统 PDF 阅读器中打开并打印。'})}
function insertImage() {
  if(activeOwnWord.value)return
  if(native.isTauri()) void task('正在插入图片',async()=>{const image=await native.pickImage();if(image)await imageEditor()?.insertImage?.(image)})
  else imageInput.value?.click()
}
async function browserImage(event:Event) {
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return
  await task('正在插入图片',async()=>{if(file.size>10*1024*1024)throw Error('图片不能超过 10 MB');await imageEditor()?.insertImage?.({name:file.name,base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))})})
}
function rustEditorFileAction(action:string) {
  if(action==='save')save()
  else if(action==='saveAs')save(true)
  else if(action==='exportPdf')save(true,'pdf')
  else if(action==='open')openFile()
  else if(action==='new')newDocument(activeRustSheet.value?'sheet':'word')
  else if(action==='print')editCommand('print')
  else if(action==='close'&&active.value)closeTab(active.value)
}
function officeRequest(request:{type:string;notice?:string;pageIndex?:number}) {
  if(request.type==='open')openFile()
  else if(request.type==='new') {home.value=true;section.value='home'}
  else if(request.type==='save')save()
  else if(request.type==='save-as')save(true)
  else if(request.type==='export-pdf') {
    void task('正在导出 PDF',async()=>{
      let saved=false
      try {saved=await saveActive(true,'pdf')}
      finally {if(request.notice)status.value=`${request.notice}${saved?' PDF 副本已保存。':''}`}
    })
  }
  else if(request.type==='insert-image')insertImage()
  else if(request.type==='presentation-preview')previewSlides(request.pageIndex)
  else if(request.type==='presentation-duplicate') {
    void task('正在复制幻灯片',async()=>{
      assertWorkbenchDrafts()
      if(!presentationEditor.value?.presentationAction || !Number.isInteger(request.pageIndex))throw Error('请先选择要复制的幻灯片。')
      presentationChanged(await presentationEditor.value.presentationAction({type:'duplicate-page',pageIndex:request.pageIndex!}))
    })
  }
  else if(request.type==='close' && active.value)closeTab(active.value)
  else if(request.type==='print')editCommand('print')
  else if(request.type==='quit') {
    if(native.isTauri())void closeWindow()
    else status.value='请先保存修改，再关闭当前浏览器标签页。'
  }
}
function keydown(event:KeyboardEvent) {
  if(slidePreview.value||event.defaultPrevented)return
  const key=event.key.toLowerCase()
  const fileShortcut=((event.ctrlKey||event.metaKey)&&!event.altKey&&['n','o','s','p'].includes(key))||(activeRustEditor.value&&event.key==='F12')
  if(globalActionsBlocked.value){if(fileShortcut)event.preventDefault();return}
  if(event.key==='F5'&&active.value?.document.kind==='presentation'&&!home.value){event.preventDefault();previewSlides();return}
  if(activeRustEditor.value&&!home.value&&event.key==='F12') {
    if(event.target instanceof Element&&event.target.closest('.rust-word-editor,.rust-sheet-editor'))return
    event.preventDefault()
    if(!busy.value&&!closeTarget.value&&!help.value)save(true)
    return
  }
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return
  if(activeRustEditor.value&&!home.value) {
    // The canvas and its text agent report file actions themselves. Shell controls
    // have no engine listener, so handle their shortcuts here exactly once.
    if(event.target instanceof Element&&event.target.closest('.rust-word-editor,.rust-sheet-editor'))return
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
        if(config.smokeScope==='rust-word-engine') {
          const {runNativeRustWordSmoke}=await import('./word/rust/native-smoke')
          const report=await runNativeRustWordSmoke()
          await smokeAwait('ipc-smoke-report',()=>invoke('smoke_report',{report}))
          return
        }
        if(config.smokeScope==='word-package-ipc') {
          smokeStage('word-package-ipc','starting independent Word native round trips')
          const {runNativeWordPackageSmoke}=await import('./word/core/native-package-smoke')
          const report=await runNativeWordPackageSmoke()
          await smokeAwait('ipc-smoke-report',()=>invoke('smoke_report',{report}))
          return
        }
        const report:Record<string,unknown>={...smokeFeatures()}
        try {
          smokeStage('rust-word-engine','starting real Rust Word editing, layout and DOCX round trips')
          const {runNativeRustWordSmoke}=await import('./word/rust/native-smoke')
          const rustWordEngine=await runNativeRustWordSmoke()
          report.rustWordEngine=rustWordEngine
          if(!rustWordEngine.ok)throw Error(rustWordEngine.error||rustWordEngine.closeError||'Rust Word native engine verification failed')
          smokeStage('rust-word-engine','complete')
          if(!crossOriginIsolated)throw Error('Native WebView is not cross-origin isolated')
          // Capture independent Word IPC evidence before mounting any Office
          // host: its Resource Timing check observes requests since navigation.
          smokeStage('word-package-ipc','starting independent Word native round trips')
          const {runNativeWordPackageSmoke}=await import('./word/core/native-package-smoke')
          const independentWordPackage=await runNativeWordPackageSmoke()
          report.independentWordPackage=independentWordPackage
          if(!independentWordPackage.ok)throw Error(independentWordPackage.error||'Independent Word native package verification failed')
          smokeStage('word-package-ipc','complete')
          smokeStage('wordcraft-native','starting the default WordCraft canvas and input round trip')
          const {runWordcraftNativeSmoke}=await import('./word/rust/wordcraft-native-smoke')
          const wordcraft=await runWordcraftNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认文字编辑器',()=>addDocument({id:'',kind:'word',extension:'docx',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.wordEngine!=='rust')throw Error('Default WordCraft smoke tab missing')
              await awaitReady(tab)
              const handle=rustWordHandles.get(tab.key) as WordcraftSmokeEditor|undefined
              if(!handle?.inspect||!handle.command)throw Error('Default WordCraft smoke editor unavailable')
              const snapshot=await handle.inspect()
              const element=[...document.querySelectorAll<HTMLElement>('[data-testid="rust-word-editor"]')].find(node=>node.dataset.sessionId===snapshot.sessionId)
              if(!element)throw Error('Default WordCraft smoke canvas container missing')
              return {key:tab.key,element,editor:nativeTransactionalEditor(handle)}
            },
            activeKey:()=>activeKey.value,
            close:async key=>{
              const tab=tabs.value.find(candidate=>candidate.key===key)
              if(!tab)throw Error('WordCraft smoke cleanup tab missing')
              const handle=rustWordHandles.get(key) as WordcraftSmokeEditor|undefined
              const sessionId=(await handle?.inspect())?.sessionId
              await removeTab(tab,true)
              await nextTick()
              // The real component unmount queues session.close. Inspect uses
              // that same queue, so rejection confirms cleanup has completed.
              if(sessionId) {
                let closed=false
                try {await inspectWordcraftSession(sessionId)} catch {closed=true}
                if(!closed)throw Error('WordCraft smoke session survived unmount')
              }
            },
          })
          report.wordcraft=wordcraft
          if(!wordcraft.ok)throw Error(wordcraft.error||wordcraft.closeError||'Default WordCraft native verification failed')
          smokeStage('wordcraft-native','complete')
          smokeStage('gridcraft-native','starting the default spreadsheet canvas, formulas and XLSX round trip')
          const {runGridcraftNativeSmoke}=await import('./sheet/rust/gridcraft-native-smoke')
          const gridcraft=await runGridcraftNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认表格编辑器',()=>addDocument({id:'',kind:'sheet',extension:'xlsx',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.sheetEngine!=='rust')throw Error('Default spreadsheet smoke tab missing')
              await awaitReady(tab)
              const handle=rustSheetHandles.get(tab.key) as GridcraftSmokeEditor|undefined
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
              const handle=rustSheetHandles.get(key) as GridcraftSmokeEditor|undefined
              const sessionId=(await handle?.inspect())?.sessionId
              await removeTab(tab,true)
              await nextTick()
              if(sessionId) {
                let closed=false
                try {await inspectGridcraftSession(sessionId)} catch {closed=true}
                if(!closed)throw Error('Spreadsheet smoke session survived unmount')
              }
            },
          })
          report.gridcraft=gridcraft
          if(!gridcraft.ok)throw Error(gridcraft.error||gridcraft.closeError||'Default spreadsheet native verification failed')
          smokeStage('gridcraft-native','complete')
          smokeStage('office-start','creating Writer document')
          await editorTransaction('正在准备本机文档验证',()=>addDocument({id:'',kind:'word',extension:'docx',name:'Smoke.docx',base64:'',sha256:'',sizeBytes:0},undefined,'legacy'))
          await nextTick()
          const deadline=Date.now()+240000
          while(!active.value?.ready&&Date.now()<deadline) {
            if(active.value?.loadError)throw Error(active.value.loadError)
            await new Promise(resolve=>setTimeout(resolve,250))
          }
          if(!active.value?.ready)throw Error('Office engine readiness timed out after 240s')
          if(!officeEditor.value?.smokeTest)throw Error('Office smoke test unavailable')
          smokeStage('office-roundtrip','starting actual Writer, Calc and Impress edits')
          const office=await editorTransaction('正在验证本机办公内核',()=>officeEditor.value!.smokeTest!()) as {impress?:{pdfBase64?:string;pdfPageCount?:number}}
          const presentationPdf=office.impress?.pdfBase64
          if(office.impress)delete office.impress.pdfBase64
          report.office=office
          if(!presentationPdf||!office.impress)throw Error('Impress smoke test returned no exported PDF')
          const {requestPdf}=await import('./pdf/protocol')
          const presentationInfo=await requestPdf('inspect',presentationPdf,{})
          office.impress.pdfPageCount=presentationInfo.metadata?.pageCount
          if(office.impress.pdfPageCount!==2)throw Error('Impress exported PDF must contain both slides')
          smokeStage('office-roundtrip','complete')
          smokeStage('pdf-roundtrip','starting actual original text replacement')
          const pdf=await requestPdf('new','',{});if(!pdf.base64)throw Error('PDF new returned no bytes')
          const added=await requestPdf('add_text',pdf.base64,{pageIndex:0,rect:[35,35,500,100],text:'OLD_NATIVE_TEXT 旧合同',fontSize:14})
          if(!added.base64)throw Error('PDF add_text returned no bytes')
          const changed=await requestPdf('replace_text',added.base64,{pageIndex:0,rect:[35,35,500,110],text:'NEW_NATIVE_TEXT 新的合同',fontSize:14})
          if(!changed.base64)throw Error('PDF replace_text returned no bytes')
          const info=await requestPdf('inspect',changed.base64,{})
          const text=(info.textBlocks||[]).map(item=>item.text).join('\n')
          const removedOldText=!text.includes('OLD_NATIVE_TEXT')&&!text.includes('旧合同')
          const newTextPresent=text.includes('NEW_NATIVE_TEXT')&&text.includes('新的合同')
          if(!removedOldText||!newTextPresent||info.metadata?.pageCount!==1)throw Error('PDF original text replacement did not survive reopening')
          report.pdf={ok:true,reopened:true,removedOldText,newTextPresent,text,metadata:info.metadata};report.ok=true
          smokeStage('pdf-roundtrip','complete')
          const {verifyNativeWord,verifyNativeCalc,pdfReadbackText}=await import('./office/native-workbench-smoke')
          const loadNativeWorkbench=async(kind:'word'|'sheet',base64='')=>{
            const extension=kind==='word'?'docx':'xlsx'
            await editorTransaction('正在验证文档保存与重新打开',()=>addDocument({id:'',kind,extension,name:`Native ${kind} verification.${extension}`,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)},undefined,kind==='word'?'legacy':undefined,kind==='sheet'?'legacy':undefined))
            await nextTick();const current=active.value;if(!current)throw Error('Native document tab missing')
            await awaitReady(current)
            return nativeTransactionalEditor(officeEditor.value!)
          }
          const inspectWorkbenchPdf=async(base64:string)=>{
            const first=await requestPdf('inspect',base64,{pageIndices:[0]})
            const pageCount=first.metadata?.pageCount||0
            if(!pageCount||pageCount>20)throw Error('Native document PDF page count out of bounds')
            let text=pdfReadbackText(first.textBlocks||[])
            for(let pageIndex=1;pageIndex<pageCount;pageIndex++){
              const page=await requestPdf('inspect',base64,{pageIndices:[pageIndex]})
              text+='\n'+pdfReadbackText(page.textBlocks||[])
            }
            return {pageCount,text}
          }
          smokeStage('word-workbench','starting actual formatting, tables and review round trips')
          type NativeWriter=Awaited<ReturnType<Parameters<typeof verifyNativeWord>[0]['create']>>
          report.wordWorkbench=await verifyNativeWord({create:async()=>await loadNativeWorkbench('word') as NativeWriter,reopen:async base64=>await loadNativeWorkbench('word',base64) as NativeWriter,inspectPdf:inspectWorkbenchPdf})
          smokeStage('word-workbench','complete')
          smokeStage('sheet-workbench','starting actual workbook, formulas and data round trips')
          type NativeCalc=Awaited<ReturnType<Parameters<typeof verifyNativeCalc>[0]['create']>>
          report.sheetWorkbench=await verifyNativeCalc({create:async()=>await loadNativeWorkbench('sheet') as NativeCalc,reopen:async base64=>await loadNativeWorkbench('sheet',base64) as NativeCalc,inspectPdf:inspectWorkbenchPdf})
          smokeStage('sheet-workbench','complete')
          smokeStage('presentation-workbench','starting native editor, PPTX features and player')
          const {verifyNativePresentation}=await import('./presentation/native-smoke')
          const loadNativePresentation=async(base64='')=>{
            await editorTransaction('正在验证演示文稿保存与重新打开',()=>addDocument({id:'',kind:'presentation',extension:'pptx',name:'Native presentation verification.pptx',base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
            await nextTick();const current=active.value;if(!current)throw Error('Native presentation tab missing')
            await awaitReady(current)
            return nativeTransactionalEditor(presentationEditor.value!) as unknown as Awaited<ReturnType<Parameters<typeof verifyNativePresentation>[0]['create']>>
          }
          report.presentationWorkbench=await verifyNativePresentation({
            create:()=>loadNativePresentation(),reopen:base64=>loadNativePresentation(base64),
            show:async(base64,presentation)=>{slidePreview.value={base64,presentation,name:'Native presentation verification',startPage:0};await nextTick()},
            close:closeSlidePreview,
          })
          smokeStage('presentation-workbench','complete')
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
    <input ref="fileInput" data-testid="document-open-input" class="visually-hidden" type="file" accept=".docx,.odt,.doc,.rtf,.xlsx,.ods,.xls,.csv,.tsv,.pptx,.odp,.ppt,.pdf" @change="browserFile" />
    <input ref="legacyWordInput" class="visually-hidden" type="file" accept=".docx,.odt,.doc,.rtf" @change="browserLegacyWord"/>
    <input ref="legacySheetInput" data-testid="legacy-sheet-open-input" class="visually-hidden" type="file" accept=".xlsx,.ods,.xls" @change="browserLegacySheet"/>
    <input ref="independentWordInput" data-testid="independent-word-open-input" class="visually-hidden" type="file" accept=".docx" @change="browserIndependentWord" />
    <input ref="imageInput" class="visually-hidden" type="file" accept="image/png,image/jpeg" @change="browserImage" />
    <header class="titlebar" data-testid="global-toolbar" :inert="globalActionsBlocked">
      <button class="brand" @click="home=true;section='home'" aria-label="返回工作台"><img :src="brandIcon" alt="" /><span>Open <b>Office</b></span></button>
      <nav class="global-file-toolbar" aria-label="全局文件操作">
        <details ref="newMenu" class="new-document-menu" @keydown.esc.stop.prevent="closeNewMenu(true)">
          <summary data-testid="shell-new" aria-label="新建文档" title="新建文档 · Ctrl / ⌘ N"><Icon name="plus" :size="17"/><span class="file-action-label">新建</span><Icon name="chevron-down" :size="12"/></summary>
          <div class="new-document-options" role="group" aria-label="选择新建文档类型">
            <button v-for="kind in (['word','sheet','presentation','pdf'] as const)" :key="kind" :data-testid="'shell-new-'+kind" @click="globalNewDocument(kind)"><Icon :name="icons[kind]" :size="18"/><span>{{kindNames[kind]}}</span></button>
          </div>
        </details>
        <div class="global-file-actions">
          <button data-testid="shell-open" @click="globalFileAction('open')" title="打开文件 · Ctrl / ⌘ O" aria-label="打开文件"><Icon name="folder" :size="17"/><span class="file-action-label">打开</span></button>
          <span class="separator"/>
          <button data-testid="shell-save" :disabled="documentActionsDisabled" @click="globalFileAction('save')" title="保存当前文档 · Ctrl / ⌘ S" aria-label="保存当前文档"><Icon name="save" :size="17"/><span class="file-action-label">保存</span></button>
          <button data-testid="shell-save-as" :disabled="documentActionsDisabled" @click="globalFileAction('saveAs')" title="当前文档另存为 · Ctrl / ⌘ Shift S" aria-label="当前文档另存为"><Icon name="save-as" :size="17"/><span class="file-action-label">另存为</span></button>
          <button data-testid="shell-export-pdf" :disabled="documentActionsDisabled||currentDocument?.document.kind==='pdf'||activeIndependentWord" @click="globalFileAction('exportPdf')" title="导出当前文档为 PDF" aria-label="导出当前文档为 PDF"><Icon name="download" :size="17"/><span class="file-action-label">导出 PDF</span></button>
          <button data-testid="shell-print" :disabled="documentActionsDisabled||activeIndependentWord" @click="globalFileAction('print')" title="打印当前文档 · Ctrl / ⌘ P" aria-label="打印当前文档"><Icon name="print" :size="17"/><span class="file-action-label">打印</span></button>
          <span class="separator"/>
          <button :disabled="documentActionsDisabled" @click="globalFileAction('undo')" title="撤销" aria-label="撤销"><Icon name="undo" :size="17"/></button>
          <button :disabled="documentActionsDisabled" @click="globalFileAction('redo')" title="重做" aria-label="重做"><Icon name="redo" :size="17"/></button>
        </div>
      </nav>
      <span class="titlebar-context" :title="currentDocument?.document.name">{{currentDocument?.document.name || '工作台'}}</span>
      <div class="titlebar-right">
        <span class="save-state" data-testid="global-save-state" :title="currentDocument?.document.name"><i v-if="currentDocument?.dirty" class="dirty-dot"/>{{currentDocument ? currentDocument.loadError ? '打开失败' : !currentDocument.ready ? '正在载入' : currentDocument.dirty ? '尚未保存' : '已保存' : '本地办公'}}</span>
        <div class="theme-switch" role="group" aria-label="界面主题">
          <button v-for="option in appearanceOptions" :key="option.value" :data-testid="'theme-'+option.value" :aria-label="option.label" :title="option.label" :aria-pressed="appearance===option.value" @click="appearance=option.value"><Icon :name="option.icon" :size="17"/></button>
        </div>
        <button class="icon-button" @click="help=true" aria-label="使用说明" :title="'使用说明 · '+buildVersion"><Icon name="info" :size="18"/></button>
      </div>
    </header>
    <div v-show="home" class="workspace" :inert="!!saveAsDraft">
      <aside class="sidebar">
        <button class="primary open-sidebar" @click="openFile" aria-label="打开文件" title="打开文件 · Ctrl / ⌘ O"><Icon name="folder"/><span>打开文件</span><kbd>⌘ / Ctrl O</kbd></button>
        <nav aria-label="工作区"><button :class="{selected:section==='home'}" :aria-current="section==='home'?'page':undefined" aria-label="工作台" title="工作台" @click="section='home'"><Icon name="home"/><span>工作台</span></button><button :class="{selected:section==='recent'}" :aria-current="section==='recent'?'page':undefined" aria-label="最近打开" title="最近打开" @click="section='recent'"><Icon name="clock"/><span>最近打开</span></button></nav>
        <div v-if="tabs.length" class="sidebar-documents"><span class="eyebrow">正在编辑</span><button v-for="tab in tabs" :key="tab.key" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button></div>
        <div class="sidebar-bottom"><Icon name="shield"/><strong>文件保存在本机</strong><p>打开、编辑与保存，<br/>都在本地完成。</p><button @click="help=true">格式支持与快捷键 <Icon name="arrow" :size="15"/></button></div>
      </aside>
      <main class="home-main">
        <div class="home-heading"><div><span class="eyebrow">本地工作空间</span><h1>{{section==='home'?'工作台':'最近打开'}}</h1><p>{{section==='home'?'新建一份文档，或继续编辑本机文件。':'在这里查找并继续之前的工作。'}}</p></div></div>
        <section v-if="section==='home'" class="create-grid" aria-label="新建文件">
          <button class="create-card word" @click="newDocument('word')"><span class="document-art"><Icon name="file" :size="27"/></span><span class="card-bottom"><span><strong>文字文档</strong><small>文字排版、表格与图片编辑</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">DOCX</span></button>
          <button class="create-card sheet" @click="newDocument('sheet')"><span class="document-art"><Icon name="sheet" :size="27"/></span><span class="card-bottom"><span><strong>电子表格</strong><small>数据整理与公式计算</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">XLSX · CSV · TSV</span></button>
          <button class="create-card presentation" @click="newDocument('presentation')"><span class="document-art"><Icon name="presentation" :size="27"/></span><span class="card-bottom"><span><strong>演示文稿</strong><small>幻灯片设计与演示</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">PPTX · 独立编辑器</span></button>
          <button class="create-card pdf" @click="newDocument('pdf')"><span class="document-art"><Icon name="pdf" :size="27"/></span><span class="card-bottom"><span><strong>PDF 工作室</strong><small>文字编辑、批注与页面整理</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">PDF</span></button>
        </section>
        <section v-if="section==='home'" class="independent-word-entry" aria-labelledby="legacy-word-heading">
          <div><h2 id="legacy-word-heading">兼容编辑器</h2><p>使用内嵌办公引擎，适用于表格、图片和复杂排版，支持 DOCX、ODT、DOC 与 RTF。ODS 和 XLS 使用兼容表格保留公式，复杂 XLSX 也可从这里打开。</p></div>
          <div class="independent-word-entry-actions"><button data-testid="legacy-word-new" @click="newDocument('word','legacy')"><Icon name="plus" :size="16"/>新建兼容文档</button><button data-testid="legacy-word-open" @click="openLegacyWord"><Icon name="folder" :size="16"/>打开复杂文档</button><button data-testid="legacy-sheet-open" @click="openLegacySheet"><Icon name="sheet" :size="16"/>打开兼容表格</button></div>
        </section>
        <section v-if="section==='home'" class="independent-word-entry" aria-labelledby="independent-word-heading">
          <div><h2 id="independent-word-heading">轻量文字文档 <span>旧版预览</span></h2><p>用于基础正文与段落编辑，保存为 DOCX。保留旧版轻量编辑体验。复杂文档请使用“兼容编辑器”。</p></div>
          <div class="independent-word-entry-actions"><button data-testid="independent-word-new" @click="newDocument('word','independent')"><Icon name="plus" :size="16"/>新建轻量文档</button><button data-testid="independent-word-open" @click="openIndependentWord"><Icon name="folder" :size="16"/>打开 DOCX</button></div>
        </section>
        <section class="recent-section"><div class="section-heading"><h2>最近打开 <span>{{recents.length}}</span></h2><label class="search-box"><Icon name="search" :size="17"/><input v-model="search" placeholder="查找最近的文件" aria-label="查找最近的文件"/></label></div>
          <div v-if="!filteredRecents.length" class="empty-files"><div class="empty-icon"><Icon name="folder" :size="29"/></div><strong>{{search?'没有找到匹配的文件':'你的下一份作品，从这里开始'}}</strong><p>{{native.isTauri()?'打开本机文件后，可以在这里快速找到它。':'浏览器预览支持打开和导出文件；桌面版提供原文件保存与完整 PDF 编辑。'}}</p><button class="text-button" @click="openFile">打开一份文件 <Icon name="arrow" :size="16"/></button></div>
          <div v-else class="recent-list"><button v-for="item in filteredRecents" :key="item.id" class="recent-row" @click="openRecent(item)"><span class="file-icon" :class="item.kind"><Icon :name="icons[item.kind]"/></span><span class="recent-name">{{item.name}}<small>{{kindNames[item.kind]}} · {{item.extension.toUpperCase()}}</small></span><time>{{new Date(item.lastOpenedAt* (item.lastOpenedAt<1e12?1000:1)).toLocaleDateString('zh-CN')}}</time><Icon name="arrow" :size="17"/></button></div>
        </section>
        <footer class="home-footer"><span>支持 DOCX、XLSX、PPTX 与 PDF 文件</span><span>OPEN OFFICE · {{new Date().getFullYear()}}</span></footer>
      </main>
    </div>
    <section v-show="!home" class="editor-workspace" :inert="!!saveAsDraft">
      <div ref="tabBar" class="tab-bar"><button class="home-tab" @click="home=true" aria-label="工作台"><Icon name="home" :size="18"/></button><div v-for="tab in tabs" :key="tab.key" class="document-tab" :class="{active:activeKey===tab.key}" role="tab" :aria-selected="activeKey===tab.key"><button class="tab-name" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]" :size="16"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button><button class="tab-close" @click="closeTab(tab)" :aria-label="`关闭 ${tab.document.name}`"><Icon name="close" :size="14"/></button></div><button class="new-tab" @click="home=true" aria-label="新建文档"><Icon name="plus" :size="18"/></button></div>
      <div v-if="active?.importWarnings?.length" class="import-review-notice" role="note" data-testid="import-review-notice"><Icon name="info" :size="16"/><div><p v-for="warning in active.importWarnings" :key="warning">{{warning}}</p><strong>保存需另存副本，避免自动覆盖原件。</strong></div></div>
      <div class="editor-content" :inert="!!busy">
        <WordWorkbench v-if="officeDocument" v-show="!activeOwnWord&&!activeRustSheet&&(active?.document.kind==='word'||active?.document.kind==='sheet')" ref="wordWorkbench" :active="active?.document.kind==='word'&&!activeOwnWord" :state="writerState" :read-data="readWriterData" :refresh-state="readFreshWriterState" :busy="!!busy" :disabled="!active?.ready" @action="runWriterAction" @command="runWriterCommand" @refresh="refreshWriter" @insert-image="insertImage" @draft-change="dirtyFor(activeKey,$event)">
        <SheetWorkbench ref="sheetWorkbench" :active="active?.document.kind==='sheet'&&!activeRustSheet" :state="calcState" :read-data="readCalcData" :busy="!!busy" :disabled="!active?.ready" @action="runCalcAction" @refresh="refreshCalc" @insert-image="insertImage" @draft-change="dirtyFor(activeKey,$event)">
          <OfficeEditor ref="officeEditor" :document="officeDocument" :smoke-mode="smokeMode" @dirty="dirtyFor(officeDocument?.id,$event)" @ready="readyFor(officeDocument?.id)" @error="editorError(officeDocument?.id,$event)" @status="status=$event" @request="officeRequest" @word-state="writerChanged" @sheet-state="calcChanged"/>

        </SheetWorkbench>
        </WordWorkbench>
        <RustWordEditor :theme="appearance" v-for="entry in rustWordEntries" :key="entry.document.id" v-show="activeRustWord&&activeKey===entry.document.id" :ref="handle=>setRustWordHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustWord&&activeKey===entry.document.id" :disabled="!!busy||!!saveAsDraft||!!closeTarget||help" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustSheetEditor :theme="appearance" v-for="entry in rustSheetEntries" :key="entry.document.id" v-show="activeRustSheet&&activeKey===entry.document.id" :ref="handle=>setRustSheetHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustSheet&&activeKey===entry.document.id" :disabled="!!busy||!!saveAsDraft||!!closeTarget||help" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <StandaloneWordEditor v-if="independentWordDocument" v-show="activeIndependentWord" ref="independentWordEditor" :document="independentWordDocument" :prepared="independentWordPrepared" :active="!home&&activeIndependentWord" :disabled="!!busy" @dirty="dirtyFor(independentWordDocument?.id,$event)" @ready="readyFor(independentWordDocument?.id)" @error="editorError(independentWordDocument?.id,$event)" @status="status=$event"/>
        <StandalonePresentationEditor v-if="presentationDocument" v-show="active?.document.kind==='presentation'" ref="presentationEditor" :document="presentationDocument" :active="!home&&active?.document.kind==='presentation'" :disabled="!!busy" @dirty="dirtyFor(presentationDocument?.id,$event)" @ready="readyFor(presentationDocument?.id)" @error="editorError(presentationDocument?.id,$event)" @status="status=$event"/>
        <PdfEditor v-if="pdfDocument && active?.document.kind==='pdf'" :key="pdfDocument.id" ref="pdfEditor" :document="pdfDocument" :initial-dirty="active?.dirty" @dirty="dirtyFor(pdfDocument?.id,$event)" @ready="readyFor(pdfDocument?.id)" @error="editorError(pdfDocument?.id,$event)" @status="status=$event"/>
      </div>
      <footer class="editor-status"><span>{{status}}</span><span>{{active?.document.extension.toUpperCase()}} · {{activeRustWord?'文字编辑':activeRustSheet?'表格编辑':activeIndependentWord?'轻量文字预览':active?.wordEngine==='legacy'||active?.sheetEngine==='legacy'?'兼容编辑器':'本机编辑'}}</span></footer>
    </section>
    <SlidePreview v-if="slidePreview" :base64="slidePreview.base64" :name="slidePreview.name" :start-page="slidePreview.startPage" :presentation="slidePreview.presentation" @close="closeSlidePreview" @error="error=$event"/>
    <div v-if="error" class="error-banner" role="alert"><Icon name="info"/><span>{{error}}</span><button @click="error=''" aria-label="关闭错误提示"><Icon name="close" :size="16"/></button></div>
    <div v-if="busy" class="busy-overlay" role="status"><span class="busy-pill"><i/>{{busy}}</span></div>
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
    <div v-if="closeTarget" class="modal-backdrop" @keydown.esc="closeTarget=null"><section ref="closeDialog" class="modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="close-heading"><span class="modal-icon"><Icon name="save" :size="27"/></span><h2 id="close-heading">保存你的修改？</h2><p>{{closeTarget==='window'?'有文档尚未保存。保存后再退出，可以保留所有修改。':`“${closeTarget.document.name}”有尚未保存的修改。`}}</p><div class="modal-actions"><button @click="closeTarget=null">取消</button><button @click="resolveClose('discard')">不保存</button><button class="primary" @click="resolveClose('save')">{{closeTarget==='window'?'全部保存并退出':'保存并关闭'}}</button></div></section></div>
    <div v-if="help" class="modal-backdrop" @click.self="help=false" @keydown.esc.stop.prevent="help=false"><section ref="helpDialog" class="modal help-modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="help-heading"><button class="modal-close icon-button" @click="help=false" aria-label="关闭说明"><Icon name="close"/></button><span class="eyebrow">OPEN OFFICE</span><h2 id="help-heading">为本地工作而设计</h2><div class="help-grid"><article><Icon name="file"/><h3>文字、表格与演示</h3><p>提供中文文字排版、表格与公式、数据分析、幻灯片编排及 PDF 导出。文字与 XLSX 表格使用本地文档引擎，部分高级菜单目前为英文。支持导入 CSV 与 TSV 数据，ODS、XLS 和复杂 XLSX 可使用兼容表格。演示文稿采用独立编辑器，支持 PPTX，旧 PPT 与 ODP 请先转换格式。导入 DOC、RTF、XLS 后另存现代格式副本，保留原件。</p></article><article><Icon name="pdf"/><h3>PDF 工作室</h3><p>支持原有文字替换、文字和图片、批注、手写签名、页面整理，以及页码、透明水印和书签导航。</p></article></div><p class="help-note">PDF 原文编辑针对可提取的文字，不包含扫描件 OCR。受密码或编辑权限保护的文件需要相应授权。修改数字签名文件时会另存副本。演示文稿提供中文编排、对象与图表编辑、备注、转场和本地媒体放映。SmartArt、逐对象动画和 Morph 尚未完整实现。Microsoft 365 的本地文档能力尚未完全对齐：复杂排版、最新函数、宏与插件仍有差异。请检查导出结果；宏不自动执行。</p><p class="help-note"><strong>永久本地范围：</strong>不提供账户、云盘、云协作或云 AI，也不将这些服务列入后续功能计划。安装包内的编辑引擎在本机处理文档。</p><p class="help-shortcuts">打开 <kbd>Ctrl / ⌘ O</kbd>　保存 <kbd>Ctrl / ⌘ S</kbd>　另存为 <kbd>Ctrl / ⌘ ⇧ S</kbd></p><small>版本 {{appVersion}} · 构建 {{buildVersion}} · 使用 LibreOffice / ZetaOffice、PDF.js 与 PyMuPDF。第三方许可随应用提供。</small><button class="primary" @click="help=false">开始工作</button></section></div>
  </div>
</template>

<style scoped>
.independent-word-entry { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 20px 0 28px; padding: 18px 20px; border: 1px solid var(--ui-line); border-radius: var(--ui-radius); background: var(--ui-surface); }
.independent-word-entry h2 { margin: 0; font-size: 15px; font-weight: 600; }
.independent-word-entry h2 span { margin-left: 8px; padding: 2px 6px; border-radius: 3px; background: var(--ui-accent-soft); color: var(--ui-accent); font-size: 11px; font-weight: 500; }
.independent-word-entry p { margin: 7px 0 0; font-size: 12px; line-height: 1.6; color: var(--ui-muted); }
.independent-word-entry-actions { display: flex; flex: none; flex-wrap: wrap; gap: 8px; }
.independent-word-entry-actions button { display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--ui-line); border-radius: var(--ui-radius); background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.independent-word-entry-actions button:hover { background: var(--ui-accent-soft); }
@media (max-width: 900px) { .independent-word-entry { align-items: flex-start; flex-direction: column; gap: 12px; } }
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
