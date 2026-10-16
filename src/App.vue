<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import Icon from './components/Icon.vue'
import ServerPanel from './components/ServerPanel.vue'
import { createAutosaveScheduler, type AutosaveTarget } from './shared/autosave'
import { browserWorkspaceDispatcher, createWorkspaceTransport, isSharedWorkspaceLocation, WorkspaceTransportError, type BrowserServerStatus, type WorkspaceDocument, type WorkspaceState, type WorkspaceExtension } from './shared/browser-workspace'
import { createWorkspaceSync, type SyncBinding, type SyncSnapshot } from './shared/workspace-sync'
import RustWordEditor from './components/RustWordEditor.vue'
import RustSheetEditor from './components/RustSheetEditor.vue'
import RustPresentationEditor from './components/RustPresentationEditor.vue'
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
import { bytesToBase64, base64ToBytes, extensionOf, kindOf, withExtension, defaultSaveExtension, isImportOnly, validateDocumentSignature, saveFormats, saveFileName, type SaveExtension, type Kind, type Extension, type EditorHandle } from './shared/document'

interface Tab { sync?: SyncBinding; syncName?: string; key: string; document: NativeDocument; fileId?: string; requiresSaveAs?: boolean; importWarnings?:string[]; dirty: boolean; ready: boolean; loadError?: string }
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
let nativeSmokeSaveObserver: ((request: SaveDocumentRequest, result: SaveResult) => void) | undefined
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
const activeRustWord = computed(() => active.value?.document.kind === 'word')
const activeRustSheet = computed(() => active.value?.document.kind === 'sheet')
const activeRustPresentation = computed(() => active.value?.document.kind === 'presentation')
const activeRustPdf = computed(() => active.value?.document.kind === 'pdf')
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
type PresentationEditorHandle = EditorHandle & { present(startPage?: number): Promise<void>; stopPresentation(): void | Promise<void> }
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
let appDisposed = false
onBeforeUnmount(() => { appDisposed = true; setRustWordDocument(); setRustSheetDocument(); setRustPresentationDocument(); setRustPdfDocument() })
const recents = ref<RecentDocument[]>([]), busy = ref(''), error = ref(''), status = ref('所有文件，仅在你的设备上处理')
const help = ref(false), search = ref(''), closeTarget = ref<Tab | 'window' | null>(null)
const saveAsDraft = ref<{ key:string; kind:Kind; format:SaveExtension; name:string; error:string } | null>(null)
const sharedBrowser = !native.isTauri() && isSharedWorkspaceLocation()
const serverPanel = ref(false), serverPending = ref(false), serverError = ref(''), serverNotice = ref('')
const serverStatus = ref<BrowserServerStatus>({running:false,localUrl:null,lanUrls:[],revision:0})
const sharedState = ref<WorkspaceState>({running:false,revision:0,documents:[]})
const syncApplying = ref(false), composing = ref(false), backgroundSaving = ref(false)
const stagedTab = ref<Tab>()
const globalActionsBlocked = computed(() => !!busy.value || !!saveAsDraft.value || !!closeTarget.value || help.value || serverPanel.value || syncApplying.value)
const editorInputBlocked = computed(() => (!!busy.value && !backgroundSaving.value) || !!saveAsDraft.value || !!closeTarget.value || help.value || serverPanel.value || syncApplying.value)
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
    if (currentDocument.value?.document.kind !== 'pdf') save(true, 'pdf')
  } else editCommand(action)
}
watch([activeKey, home, globalActionsBlocked], () => closeNewMenu())
const saveAsDialog = ref<HTMLElement>()
function formatsFor(tab:Tab | undefined) { return tab ? saveFormats(tab.document.kind) : [] }
const saveAsOptions = computed(() => formatsFor(tabs.value.find(tab=>tab.key===saveAsDraft.value?.key)))
const saveAsCopy = computed(() => !!saveAsDraft.value&&!!active.value&&saveAsDraft.value.format!==defaultSaveExtension(active.value.document.extension))
useDialogFocus(saveAsDialog)
const helpDialog = ref<HTMLElement>(), closeDialog = ref<HTMLElement>()
useDialogFocus(helpDialog)
useDialogFocus(closeDialog)
const fileInput = ref<HTMLInputElement>()
let unlisten: (() => void) | undefined
let pendingWindowClose = false
const editor = () => activeRustWord.value ? rustWordHandles.get(activeKey.value) : activeRustSheet.value ? rustSheetHandles.get(activeKey.value) : activeRustPresentation.value ? rustPresentationHandles.get(activeKey.value) : rustPdfHandles.get(activeKey.value)
const kindNames: Record<Kind,string> = { word:'文字文档', sheet:'电子表格', presentation:'演示文稿', pdf:'PDF 文档' }
const icons: Record<Kind,string> = {word:'file',sheet:'sheet',presentation:'presentation',pdf:'pdf'}
const filteredRecents = computed(() => recents.value.filter(r => r.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const message = (e:unknown) => e instanceof Error ? e.message : String(e)
async function editorTransaction<T>(label:string, work:()=>Promise<T>, preserveInput=false):Promise<T> {
  if (busy.value||syncApplying.value) throw Error('正在处理另一项文档操作，请等待完成。')
  backgroundSaving.value=preserveInput
  error.value=''; busy.value=label
  try {
    await syncCapture?.catch(()=>undefined)
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
function readyFor(id:string|undefined) { const tab=tabs.value.find(t=>t.key===id)??(stagedTab.value?.key===id?stagedTab.value:undefined); if(tab) {tab.ready=true;tab.loadError=undefined;smokeStage('editor-ready',tab.document.kind)} }
function editorError(id:string|undefined,value:string) {
  error.value=value
  const tab=tabs.value.find(t=>t.key===id)
  if(tab&&!tab.ready)tab.loadError=value
  if(stagedTab.value&&stagedTab.value.key===id)stagedTab.value.loadError=value
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
  const format=defaultSaveExtension(tab.document.extension)
  const handle=requireEditor(tab), exported=await handle.exportFile({format})
  if(activeKey.value!==tab.key)throw Error('文档已切换，旧的导出结果未被使用。')
  if(exported.extension!==format)throw Error('编辑器返回的快照格式与当前文档不一致，切换已取消。')
  if(exported.dirty)tab.dirty=true
  return {handle,exported,document:{...tab.document,name:withExtension(tab.document.name,exported.extension),base64:exported.base64,extension:exported.extension,sizeBytes:Math.floor(exported.base64.length*.75)}}
}
async function stash() {
  const tab=active.value
  if(!tab || tab.loadError) return
  // Dirty notifications arrive asynchronously. Always snapshot the actual loaded model.
  // Export refuses pending PDF drafts; Rust editors verify this exact export revision.
  const snapshot=await capture(tab)
  await snapshot.handle.discardChanges?.()
  // Imported sources remain protected after a normalized in-memory snapshot.
  // Only a successful editable-format Save As clears this safeguard.
  tab.requiresSaveAs=tab.requiresSaveAs||isImportOnly(tab.document.extension)
  tab.document=snapshot.document
}
async function activate(tab:Tab) {
  if(activeKey.value!==tab.key) {
    await stash()
    activeKey.value=tab.key
    const kind=tab.document.kind
    const entries=kind==='word'?rustWordEntries.value:kind==='sheet'?rustSheetEntries.value:kind==='presentation'?rustPresentationEntries.value:rustPdfEntries.value
    const reusable=entries.some(entry=>entry.document.id===tab.key)
    if(!reusable){tab.ready=false;tab.loadError=undefined}
    if(kind==='word')setRustWordDocument(tab.document)
    else if(kind==='sheet')setRustSheetDocument(tab.document)
    else if(kind==='presentation')setRustPresentationDocument(tab.document)
    else setRustPdfDocument(tab.document)
    await nextTick()
  }
  home.value=false
}
async function addDocument(doc:NativeDocument, fileId?:string) {
  // Validate the format family before touching any active document or session.
  doc={...doc}
  if(extensionOf(doc.name)!==doc.extension||kindOf(doc.extension)!==doc.kind)throw Error('文件名、格式与文档类型不一致，无法打开。')
  const existing=fileId && tabs.value.find(t=>t.fileId===fileId)
  if(existing) { await activate(existing); return existing }
  // Each engine supports eight live models. Reserve one for a validated remote
  // replacement so receiving an update never requires discarding the old model.
  if(tabs.value.filter(tab=>tab.document.kind===doc.kind).length>=7)throw Error('同一类型最多同时打开 7 份文档，请先保存并关闭其中一份。')
  const key=createId()
  let wordPrepared:PreparedRustWordDocument|undefined
  let sheetPrepared:PreparedRustSheetDocument|undefined
  let presentationPrepared:PreparedRustPresentationDocument|undefined
  let pdfPrepared:PreparedRustPdfDocument|undefined
  try {
    // Every Rust parser prepares an isolated model before the active tab is touched.
    if(doc.kind==='word')wordPrepared=await prepareRustWordDocument({...doc,id:key})
    else if(doc.kind==='sheet')sheetPrepared=await prepareRustSheetDocument({...doc,id:key})
    else if(doc.kind==='presentation')presentationPrepared=await prepareRustPresentationDocument({...doc,id:key})
    else pdfPrepared=await prepareRustPdfDocument({...doc,id:key})
    if(appDisposed)return
    const protectedImport=!!doc.base64
    const importWarnings=protectedImport
      ? [doc.kind==='sheet'&&['csv','tsv'].includes(doc.extension)?'已导入文本数据；保存为 XLSX 工作簿，原始数据文件保留。':'此文件首次保存将生成副本。请核对复杂内容与排版。',...(sheetPrepared?.warnings??presentationPrepared?.warnings??pdfPrepared?.warnings??[])]
      : []
    const tab:Tab={key,document:{...doc,id:key},fileId,requiresSaveAs:protectedImport||isImportOnly(doc.extension),importWarnings,dirty:!fileId,ready:false}
    await stash()
    if(appDisposed)return
    tabs.value.push(tab); const storedTab=tabs.value[tabs.value.length-1]!; activeKey.value=key; home.value=false
    if(doc.kind==='word') {setRustWordDocument(tab.document,wordPrepared);wordPrepared=undefined}
    else if(doc.kind==='sheet') {setRustSheetDocument(tab.document,sheetPrepared);sheetPrepared=undefined}
    else if(doc.kind==='presentation') {setRustPresentationDocument(tab.document,presentationPrepared);presentationPrepared=undefined}
    else {setRustPdfDocument(tab.document,pdfPrepared);pdfPrepared=undefined}
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
    const extension:Extension=kind==='word'?'docx':kind==='sheet'?'xlsx':kind==='presentation'?'pptx':'pdf'
    const number=tabs.value.filter(t=>t.document.kind===kind).length+1
    await addDocument({id:'',kind,extension,name:`未命名${kindNames[kind]}${number}.${extension}`,base64:'',sha256:'',sizeBytes:0})
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
async function saveActive(saveAs=false, format?:Extension, chosenName?:string, directOnly?:AutosaveTarget):Promise<boolean> {
  const tab=active.value;if(!tab)return false
  const directAllowed=()=>native.isTauri()&&tab.key===directOnly?.key&&tab.fileId===directOnly?.fileId&&!tab.requiresSaveAs&&!isImportOnly(tab.document.extension)&&defaultSaveExtension(tab.document.extension)===tab.document.extension
  if(directOnly&&!directAllowed())return false
  if(format&&isImportOnly(format))throw Error('模板与放映文件仅支持导入，请另存为 PPTX 副本。')
  const requestedFormat=format||defaultSaveExtension(tab.document.extension)
  if(!formatsFor(tab).some(option=>option.extension===requestedFormat))throw Error('当前编辑器不支持此保存格式。')
  const handle=requireEditor(tab)
  if(directOnly&&!await handle.canBackgroundExport?.())return false
  const exported=await handle.exportFile({format:requestedFormat,...(directOnly?{background:true}:{})})
  if(activeKey.value!==tab.key)throw Error('文档已切换，本次保存已取消。')
  if(isImportOnly(exported.extension))throw Error('编辑器未生成现代格式，保存已取消，原文件未被修改。')
  if(exported.extension!==requestedFormat)throw Error('编辑器返回的格式与所选格式不一致，保存已取消。')
  if(directOnly&&(!directAllowed()||exported.saveAs||exported.extension!==tab.document.extension))return false
  if(exported.dirty)tab.dirty=true
  const isCopy=(tab.document.kind==='sheet'&&['csv','tsv','pdf'].includes(requestedFormat))||(!!format && format!==tab.document.extension)
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
  const request:SaveDocumentRequest={documentId:isCopy||protectSource?undefined:tab.fileId,name,extension:exported.extension,base64:exported.base64,expectedSha256:isCopy||protectSource?undefined:tab.document.sha256,saveAs:saveAs||isCopy||protectSource||exported.saveAs||!tab.fileId}
  const result=await native.saveDocument(request)
  if(smokeMode.value)nativeSmokeSaveObserver?.(request,result)
  if(result.status==='cancelled') return false
  if(result.status==='conflict') { error.value=`${result.message} 请使用“另存为”保留当前修改。`;return false }
  if(!isCopy) {
    tab.fileId=result.document.id
    tab.document={...result.document,id:tab.key,base64:exported.base64}
    tab.requiresSaveAs=false
    if(tab.sync)tab.syncName=name
    tab.importWarnings=[]
    await handle.markSaved?.(exported.base64,directOnly?{background:true}:undefined);tab.dirty=false
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
function previewSlides(startPage=0) {
  void task('正在准备放映',async()=>{
    const tab=active.value
    if(tab?.document.kind!=='presentation')return
    const handle=rustPresentationHandles.get(tab.key)
    if(!tab.ready||!handle)throw Error('演示文稿编辑器尚未就绪。')
    await handle.present(startPage)
  })
}
function changeTab(tab:Tab) {void task('正在切换文档',()=>activate(tab))}
async function removeTab(tab:Tab, discardConfirmed=false) {
  if(tab.key===activeKey.value) {
    if(tab.ready)await editor()?.discardChanges?.({force:discardConfirmed})
    await rustPresentationHandles.get(tab.key)?.stopPresentation()
    const next=tabs.value.find(t=>t.key!==tab.key)
    // Do not ask stash() to export a tab whose close was already checked/confirmed.
    activeKey.value=''
    if(next) await activate(next)
    else home.value=true
  }
  tabs.value=tabs.value.filter(t=>t.key!==tab.key)
  for(const entries of [rustWordEntries,rustSheetEntries,rustPresentationEntries,rustPdfEntries]) {
    for(const entry of entries.value)if(entry.document.id===tab.key)entry.prepared?.discard()
    entries.value=entries.value.filter(entry=>entry.document.id!==tab.key) as typeof entries.value
  }
  rustWordHandles.delete(tab.key);rustSheetHandles.delete(tab.key);rustPresentationHandles.delete(tab.key);rustPdfHandles.delete(tab.key)
}
function closeTab(tab:Tab) {
  if(busy.value||syncApplying.value)return
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
  if(busy.value||syncApplying.value) {pendingWindowClose=true;return}
  saveAsDraft.value=null
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
    if(target==='window') {
      if(action==='save') for(const tab of tabs.value.filter(t=>t.dirty)) {await activate(tab);await awaitReady(tab);if(!await saveActive())return}
      closeTarget.value=null;await native.confirmClose()
    } else {
      if(action==='save') {await activate(target);await awaitReady(target);if(!await saveActive())return}
      await removeTab(target,action==='discard');closeTarget.value=null
    }
  })
}
function editCommand(command:'undo'|'redo'|'print') {void task('正在处理',async()=>{const fn=editor()?.[command];if(fn)await fn();else if(command==='print'&&await saveActive(true,'pdf'))status.value='已导出 PDF；请在系统 PDF 阅读器中打开并打印。'})}
function rustEditorFileAction(action:string) {
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
let lastInputAt = 0
let sharedStateGeneration = 0
let syncCapture: Promise<SyncSnapshot> | undefined
let syncController: ReturnType<typeof createWorkspaceSync> | undefined
let syncTimer: ReturnType<typeof setInterval> | undefined
const workspaceTransport = native.isTauri() ? createWorkspaceTransport(native.dispatchBrowserWorkspace)
  : sharedBrowser ? createWorkspaceTransport(browserWorkspaceDispatcher()) : undefined
function inputActivity(event: Event) {
  if (!(event.target instanceof Element) || !event.target.closest('.editor-content')) return
  lastInputAt = Date.now()
  if(event.type==='compositionstart')composing.value=true
  if(event.type==='compositionend')composing.value=false
}
function syncAvailable() {
  return !appDisposed && !busy.value && !saveAsDraft.value && !closeTarget.value && !help.value
    && !syncApplying.value && !composing.value && Date.now()-lastInputAt>1200
}
function handleFor(tab: Tab) {
  return (tab.document.kind==='word'?rustWordHandles:tab.document.kind==='sheet'?rustSheetHandles:
    tab.document.kind==='presentation'?rustPresentationHandles:rustPdfHandles).get(tab.key)
}
function removeEditorEntry(key:string) {
  for(const entries of [rustWordEntries,rustSheetEntries,rustPresentationEntries,rustPdfEntries]) {
    for(const entry of entries.value)if(entry.document.id===key)entry.prepared?.discard()
    entries.value=entries.value.filter(entry=>entry.document.id!==key) as typeof entries.value
  }
  rustWordHandles.delete(key);rustSheetHandles.delete(key);rustPresentationHandles.delete(key);rustPdfHandles.delete(key)
}
function sharedName(tab:Tab) {return withExtension(tab.syncName??tab.document.name,defaultSaveExtension(tab.document.extension))}
function sharedToken(revision:string,tab:Tab) {return JSON.stringify([revision,sharedName(tab)])}
async function sharedRevision(key:string) {
  const tab=tabs.value.find(item=>item.key===key)
  const handle=tab&&handleFor(tab)
  if(!await handle?.canBackgroundExport?.())return undefined
  const value=await handle?.syncRevision?.()
  return value&&tab?sharedToken(`${value.documentId}:${value.revision}`,tab):undefined
}
async function sharedSnapshot(key:string):Promise<SyncSnapshot> {
  const tab=tabs.value.find(item=>item.key===key), handle=tab&&handleFor(tab)
  if(!tab?.ready||!handle)throw Error('文档尚未就绪，稍后同步。')
  const operation=(async()=>{
    if(!await handle.canBackgroundExport?.())throw Error('请先确认当前输入，随后会自动同步。')
    const extension=defaultSaveExtension(tab.document.extension)
    const exported=await handle.exportFile({format:extension,background:true})
    if(!exported.revision||!['docx','xlsx','pptx','pdf'].includes(exported.extension))throw Error('当前文档暂不支持同步。')
    return {name:sharedName(tab),extension:exported.extension as WorkspaceExtension,base64:exported.base64,revision:sharedToken(exported.revision,tab)}
  })()
  syncCapture=operation
  try{return await operation}finally{if(syncCapture===operation)syncCapture=undefined}
}
async function prepareSharedTab(tab:Tab) {
  const doc=tab.document
  if(doc.kind==='word')return {kind:doc.kind,prepared:await prepareRustWordDocument(doc)} as const
  if(doc.kind==='sheet')return {kind:doc.kind,prepared:await prepareRustSheetDocument(doc)} as const
  if(doc.kind==='presentation')return {kind:doc.kind,prepared:await prepareRustPresentationDocument(doc)} as const
  return {kind:doc.kind,prepared:await prepareRustPdfDocument(doc)} as const
}
function mountSharedTab(tab:Tab, candidate:Awaited<ReturnType<typeof prepareSharedTab>>) {
  if(candidate.kind==='word')setRustWordDocument(tab.document,candidate.prepared)
  else if(candidate.kind==='sheet')setRustSheetDocument(tab.document,candidate.prepared)
  else if(candidate.kind==='presentation')setRustPresentationDocument(tab.document,candidate.prepared)
  else setRustPdfDocument(tab.document,candidate.prepared)
}
async function awaitStaged(tab:Tab) {
  if(tab.loadError)throw Error(tab.loadError)
  if(appDisposed)throw Error('工作区已关闭。')
  if(tab.ready)return
  await new Promise<void>((resolve,reject)=>{
    let stop=()=>{}
    const finish=(failure?:Error)=>{clearTimeout(timer);stop();failure?reject(failure):resolve()}
    const timer=setTimeout(()=>finish(Error('同步文档打开超时，原文档仍保留。')),120000)
    stop=watch(()=>[tab.ready,tab.loadError,stagedTab.value?.key!==tab.key] as const,([ready,failure,disposed])=>{
      if(failure||disposed)finish(Error(failure||'工作区已关闭。'));else if(ready)finish()
    },{flush:'post'})
  })
}
async function adoptShared(key:string, remote:WorkspaceDocument, expectedRevision:string, canCommit:()=>boolean):Promise<boolean> {
  const previous=tabs.value.find(item=>item.key===key)
  if(!previous||!syncAvailable())return false
  if(!await handleFor(previous)?.canBackgroundExport?.())return false
  const nextKey=createId()
  const candidateTab:Tab={...previous,key:nextKey,ready:false,loadError:undefined,dirty:true,
    document:{...previous.document,id:nextKey,name:previous.fileId?previous.document.name:remote.name,base64:remote.base64,sizeBytes:remote.sizeBytes,extension:remote.extension,kind:remote.kind},
    sync:{id:remote.id,version:remote.version},syncName:remote.name}
  // Parse before blocking input; the original editor and undo history remain alive.
  const candidate=await prepareSharedTab(candidateTab)
  let committed=false, mounted=false, switched=false, ownsBarrier=false
  const owner=syncController
  try {
    if(!await handleFor(previous)?.canBackgroundExport?.())return false
    if(!canCommit()||!syncAvailable()||!serverStatus.value.running||!tabs.value.includes(previous))return false
    syncApplying.value=true;ownsBarrier=true
    await nextTick()
    const handle=handleFor(previous)
    if(!handle||composing.value||busy.value)return false
    const current=await handle.exportFile({format:defaultSaveExtension(previous.document.extension),background:true})
    if(!current.revision||sharedToken(current.revision,previous)!==expectedRevision||composing.value||busy.value||!canCommit()||appDisposed)return false
    stagedTab.value=candidateTab
    mountSharedTab(stagedTab.value,candidate);mounted=true
    await nextTick();await awaitStaged(stagedTab.value)
    const replacement=stagedTab.value!
    // A candidate is mounted invisibly first; no original session is discarded on a parse/load failure.
    const snapshot=await handleFor(replacement)?.inspect?.()
    if(!snapshot||replacement.loadError)throw Error(replacement.loadError||'同步文档未就绪。')
    replacement.sync={id:remote.id,version:remote.version,revision:sharedToken(`${snapshot.documentId}:${snapshot.revision}`,replacement)}
    const latest=await handle.exportFile({format:defaultSaveExtension(previous.document.extension),background:true})
    if(!latest.revision||sharedToken(latest.revision,previous)!==expectedRevision||!canCommit()||appDisposed||!serverStatus.value.running)return false
    const index=tabs.value.indexOf(previous)
    if(index<0)return false
    const replacingActive=activeKey.value===key
    tabs.value.splice(index,1,replacement)
    if(replacingActive)activeKey.value=nextKey
    switched=true
    await nextTick()
    // Queue behind renderer activation before retiring the retained session.
    await handleFor(replacement)?.inspect?.()
    if(replacement.loadError)throw Error(replacement.loadError)
    if(appDisposed||!serverStatus.value.running||syncController!==owner)return false
    removeEditorEntry(key)
    committed=true
    status.value='已接收共享工作区的修改；保存到文件由客户端控制'
    return true
  } finally {
    if(!committed) {
      if(switched) {
        const index=tabs.value.findIndex(item=>item.key===nextKey)
        if(index>=0)tabs.value.splice(index,1,previous)
        if(activeKey.value===nextKey)activeKey.value=key
      }
      if(mounted)removeEditorEntry(nextKey)
      else candidate.prepared.discard()
    }
    if(ownsBarrier){
      stagedTab.value=undefined;syncApplying.value=false
      if(pendingWindowClose){pendingWindowClose=false;void closeWindow()}
    }
  }
}
function enableWorkspaceSync() {
  if(!workspaceTransport||syncController)return
  syncController=createWorkspaceSync(workspaceTransport,{
    locals:()=>tabs.value.filter(tab=>tab.ready&&!tab.loadError).map(tab=>({key:tab.key,binding:tab.sync})),
    available:syncAvailable,revision:sharedRevision,snapshot:sharedSnapshot,adopt:adoptShared,
    bind(key,binding){const tab=tabs.value.find(item=>item.key===key);if(tab)tab.sync=binding},
    fork(key,name){const tab=tabs.value.find(item=>item.key===key);if(tab){tab.document={...tab.document,name};tab.syncName=name;tab.fileId=undefined;tab.requiresSaveAs=true;tab.dirty=true;tab.importWarnings=['两端同时修改，已保留为独立冲突副本。']}},
    notify(value){serverNotice.value=value;status.value=value},
    state(value){sharedStateGeneration++;sharedState.value=value;serverError.value='';if(sharedBrowser)serverStatus.value.running=value.running},
  },createId(),createId)
}
async function pollWorkspace() {
  if(!syncController||appDisposed)return
  const controller=syncController, priorStateGeneration=sharedStateGeneration
  try {await controller.tick()}
  catch(cause){if(!appDisposed&&controller===syncController){
    serverError.value=message(cause)
    const disconnected=cause instanceof WorkspaceTransportError&&(['network','timeout','forbidden','unavailable'].includes(cause.code)||(priorStateGeneration===sharedStateGeneration&&['not-found','invalid-response','http'].includes(cause.code)))
    status.value=disconnected?'同步暂时中断，当前编辑仍保留；恢复连接后自动重试。':`同步暂缓：${message(cause)}`
    if(sharedBrowser&&disconnected)serverStatus.value.running=false
  }}
}
async function startServer() {
  if(serverPending.value||!native.isTauri())return
  serverPending.value=true;serverError.value=''
  try {serverStatus.value=await native.startBrowserServer();enableWorkspaceSync();await pollWorkspace();serverNotice.value='Server 已启动，打开的文档将自动加入共享工作区。'}
  catch(cause){serverError.value=message(cause)}finally{serverPending.value=false}
}
async function stopServer() {
  if(serverPending.value||!native.isTauri())return
  serverPending.value=true
  try {serverStatus.value=await native.stopBrowserServer();syncController?.dispose();syncController=undefined;serverNotice.value='Server 已停止，访问链接已失效。工作区快照仍保存在本机。'}
  catch(cause){serverError.value=message(cause)}finally{serverPending.value=false}
}
async function openSharedDocument(id:string) {
  if(!workspaceTransport||busy.value||syncApplying.value)return
  serverPanel.value=false
  await task('正在打开共享文档',async()=>{
    const existing=tabs.value.find(tab=>tab.sync?.id===id)
    if(existing){await activate(existing);return}
    const remote=await workspaceTransport.document(id)
    const tab=await addDocument({...remote,id:''})
    if(!tab)return
    // Bind immediately so background polling cannot publish this import as a new document.
    tab.sync={id:remote.id,version:remote.version};tab.syncName=remote.name
    await nextTick();await awaitReady(tab)
    const snapshot=await handleFor(tab)?.inspect?.()
    if(!snapshot)throw Error('共享文档尚未就绪。')
    tab.sync={id:remote.id,version:remote.version,revision:sharedToken(`${snapshot.documentId}:${snapshot.revision}`,tab)}
    tab.importWarnings=['来自共享工作区；保存到文件时请选择本机位置。']
    status.value='已连接共享文档，编辑后自动同步'
  })
}
async function copyServerLink(url:string) {
  try {
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(url)
    else {
      const field=document.createElement('textarea');field.value=url;field.style.position='fixed';field.style.opacity='0'
      document.body.append(field);field.select()
      try{if(!document.execCommand('copy'))throw Error('请选中访问链接后手动复制。')}finally{field.remove()}
    }
    serverNotice.value='访问链接已复制'
  }catch{serverError.value='无法自动复制，请选中访问链接后手动复制。'}
}
const autosaveEnabled=ref((()=>{try{return localStorage.getItem('open-office-autosave')==='true'}catch{return false}})())
const autosaveTitle=computed(()=>sharedBrowser?'编辑自动同步到客户端工作区；保存按钮可下载文件副本。':!native.isTauri()?'通过桌面版的 Server 链接可自动同步。':'每 30 秒保存修改；请先手动选择保存位置。首次导入的原文件不会被自动覆盖。')
const autosave=createAutosaveScheduler({
  readState(){const tab=active.value;return {enabled:autosaveEnabled.value,native:native.isTauri(),key:tab?.key,fileId:tab?.fileId,
    dirty:!!tab?.dirty,ready:!!tab?.ready,requiresSaveAs:!!tab?.requiresSaveAs,
    canSaveDirectly:!!tab&&!!handleFor(tab)&&!isImportOnly(tab.document.extension)&&defaultSaveExtension(tab.document.extension)===tab.document.extension,
    busy:!!busy.value||!!syncCapture,modal:!!saveAsDraft.value||!!closeTarget.value||help.value||serverPanel.value,
    composing:composing.value||Date.now()-lastInputAt<1200,remoteEditing:syncApplying.value}},
  async save(target){
    const tab=active.value
    // A pause inside an unfinished cell, text box or form is not confirmation.
    // Check before the shell's input barrier; the editor checks again atomically
    // when exporting and acknowledging the saved bytes.
    if(!tab||tab.key!==target.key||!await handleFor(tab)?.canBackgroundExport?.())return true
    return editorTransaction('正在自动保存',()=>saveActive(false,undefined,undefined,target),true)
  },
  onError(){status.value='自动保存暂未完成，当前修改仍保留，稍后重试。'},
})
watch(autosaveEnabled,value=>{try{localStorage.setItem('open-office-autosave',String(value))}catch{}autosave.notify()})
onMounted(async()=>{
  for(const type of ['input','keydown','pointerdown','compositionstart','compositionend'])document.addEventListener(type,inputActivity,true)
  if(sharedBrowser){enableWorkspaceSync();serverPanel.value=true;await pollWorkspace()}
  else if(native.isTauri())try{serverStatus.value=await native.statusBrowserServer();if(serverStatus.value.running)enableWorkspaceSync()}catch{ /* Server errors are reported when its panel is opened. */ }
  if(!appDisposed)syncTimer=setInterval(()=>void pollWorkspace(),1500)
})
onBeforeUnmount(()=>{
  autosave.dispose();syncController?.dispose();stagedTab.value=undefined;if(syncTimer)clearInterval(syncTimer)
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
          smokeStage('workspace-native','starting native Server and scheduled file persistence verification')
          const {runWorkspaceNativeSmoke}=await import('./shared/workspace-native-smoke')
          if(!sheet.reopenedXlsxBase64||!presentation.reopenedPptxBase64||!pdf.reopenedPdfBase64)throw Error('Verified native workspace fixtures are missing')
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
                modal:!!saveAsDraft.value||!!closeTarget.value||help.value||serverPanel.value}
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
          },{xlsx:sheet.reopenedXlsxBase64,pptx:presentation.reopenedPptxBase64,pdf:pdf.reopenedPdfBase64})
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
    <input ref="fileInput" data-testid="document-open-input" class="visually-hidden" type="file" accept=".docx,.xlsx,.csv,.tsv,.pptx,.potx,.ppsx,.pdf" @change="browserFile" />
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
          <button data-testid="shell-autosave" class="autosave-toggle" role="switch" :aria-checked="native.isTauri()?autosaveEnabled:sharedBrowser" :disabled="!native.isTauri()" :title="autosaveTitle" aria-label="自动保存" @click="autosaveEnabled=!autosaveEnabled"><span class="autosave-track" :class="{enabled:native.isTauri()?autosaveEnabled:sharedBrowser}"><i/></span><span>自动保存</span></button>
          <button data-testid="shell-save-as" :disabled="documentActionsDisabled" @click="globalFileAction('saveAs')" title="当前文档另存为 · Ctrl / ⌘ Shift S" aria-label="当前文档另存为"><Icon name="save-as" :size="17"/><span class="file-action-label">另存为</span></button>
          <button data-testid="shell-export-pdf" :disabled="documentActionsDisabled||currentDocument?.document.kind==='pdf'" @click="globalFileAction('exportPdf')" title="导出当前文档为 PDF" aria-label="导出当前文档为 PDF"><Icon name="download" :size="17"/><span class="file-action-label">导出 PDF</span></button>
          <button data-testid="shell-print" :disabled="documentActionsDisabled" @click="globalFileAction('print')" title="打印当前文档 · Ctrl / ⌘ P" aria-label="打印当前文档"><Icon name="print" :size="17"/><span class="file-action-label">打印</span></button>
          <span class="separator"/>
          <button :disabled="documentActionsDisabled" @click="globalFileAction('undo')" title="撤销" aria-label="撤销"><Icon name="undo" :size="17"/></button>
          <button :disabled="documentActionsDisabled" @click="globalFileAction('redo')" title="重做" aria-label="重做"><Icon name="redo" :size="17"/></button>
        </div>
      </nav>
      <span class="titlebar-context" :title="currentDocument?.document.name">{{currentDocument?.document.name || '工作台'}}</span>
      <div class="titlebar-right">
        <button data-testid="shell-server" class="server-toolbar-button" :class="{connected:serverStatus.running}" @click="serverPanel=true" :title="serverError||serverNotice||'浏览器工作区'"><Icon name="server" :size="18"/><span>Server</span><i v-if="serverStatus.running"/></button>
        <span class="save-state" data-testid="global-save-state" :title="currentDocument?.document.name"><i v-if="currentDocument?.dirty" class="dirty-dot"/>{{currentDocument ? currentDocument.loadError ? '打开失败' : !currentDocument.ready ? '正在载入' : sharedBrowser&&serverStatus.running ? '自动同步中' : currentDocument.dirty ? '尚未保存' : '已保存' : '本地办公'}}</span>
        <div class="theme-switch" role="group" aria-label="界面主题">
          <button v-for="option in appearanceOptions" :key="option.value" :data-testid="'theme-'+option.value" :aria-label="option.label" :title="option.label" :aria-pressed="appearance===option.value" @click="appearance=option.value"><Icon :name="option.icon" :size="17"/></button>
        </div>
        <button class="icon-button" @click="help=true" aria-label="使用说明" :title="'使用说明 · '+buildVersion"><Icon name="info" :size="18"/></button>
      </div>
    </header>
    <div v-show="home" class="workspace" :inert="globalActionsBlocked">
      <aside class="sidebar">
        <button class="primary open-sidebar" @click="openFile" aria-label="打开文件" title="打开文件 · Ctrl / ⌘ O"><Icon name="folder"/><span>打开文件</span><kbd>⌘ / Ctrl O</kbd></button>
        <nav aria-label="工作区"><button :class="{selected:section==='home'}" :aria-current="section==='home'?'page':undefined" aria-label="工作台" title="工作台" @click="section='home'"><Icon name="home"/><span>工作台</span></button><button :class="{selected:section==='recent'}" :aria-current="section==='recent'?'page':undefined" aria-label="最近打开" title="最近打开" @click="section='recent'"><Icon name="clock"/><span>最近打开</span></button></nav>
        <div v-if="tabs.length" class="sidebar-documents"><span class="eyebrow">正在编辑</span><button v-for="tab in tabs" :key="tab.key" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button></div>
        <div class="sidebar-bottom"><Icon name="shield"/><strong>{{sharedBrowser?'连接客户端工作区':'文件保存在本机'}}</strong><p>{{sharedBrowser?'编辑自动同步到客户端；保存可下载文件副本。':'打开、编辑与保存，都在本地完成。'}}</p><button @click="help=true">格式支持与快捷键 <Icon name="arrow" :size="15"/></button></div>
      </aside>
      <main class="home-main">
        <div class="home-heading"><div><span class="eyebrow">本地工作空间</span><h1>{{section==='home'?'工作台':'最近打开'}}</h1><p>{{section==='home'?'新建一份文档，或继续编辑本机文件。':'在这里查找并继续之前的工作。'}}</p></div></div>
        <section v-if="section==='home'" class="create-grid" aria-label="新建文件">
          <button class="create-card word" @click="newDocument('word')"><span class="document-art"><Icon name="file" :size="27"/></span><span class="card-bottom"><span><strong>文字文档</strong><small>文字排版、表格与图片编辑</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">DOCX</span></button>
          <button class="create-card sheet" @click="newDocument('sheet')"><span class="document-art"><Icon name="sheet" :size="27"/></span><span class="card-bottom"><span><strong>电子表格</strong><small>数据整理与公式计算</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">XLSX · CSV · TSV</span></button>
          <button class="create-card presentation" @click="newDocument('presentation')"><span class="document-art"><Icon name="presentation" :size="27"/></span><span class="card-bottom"><span><strong>演示文稿</strong><small>幻灯片设计与演示</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">PPTX · POTX · PPSX</span></button>
          <button class="create-card pdf" @click="newDocument('pdf')"><span class="document-art"><Icon name="pdf" :size="27"/></span><span class="card-bottom"><span><strong>PDF 工作室</strong><small>文字编辑、批注与页面整理</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">PDF</span></button>
        </section>
        <section class="recent-section"><div class="section-heading"><h2>最近打开 <span>{{recents.length}}</span></h2><label class="search-box"><Icon name="search" :size="17"/><input v-model="search" placeholder="查找最近的文件" aria-label="查找最近的文件"/></label></div>
          <div v-if="!filteredRecents.length" class="empty-files"><div class="empty-icon"><Icon name="folder" :size="29"/></div><strong>{{search?'没有找到匹配的文件':'你的下一份作品，从这里开始'}}</strong><p>{{native.isTauri()?'打开本机文件后，可以在这里快速找到它。':'浏览器支持本地编辑和导出文件；桌面版还可直接保存到本机文件。'}}</p><button class="text-button" @click="openFile">打开一份文件 <Icon name="arrow" :size="16"/></button></div>
          <div v-else class="recent-list"><button v-for="item in filteredRecents" :key="item.id" class="recent-row" @click="openRecent(item)"><span class="file-icon" :class="item.kind"><Icon :name="icons[item.kind]"/></span><span class="recent-name">{{item.name}}<small>{{kindNames[item.kind]}} · {{item.extension.toUpperCase()}}</small></span><time>{{new Date(item.lastOpenedAt* (item.lastOpenedAt<1e12?1000:1)).toLocaleDateString('zh-CN')}}</time><Icon name="arrow" :size="17"/></button></div>
        </section>
        <footer class="home-footer"><span>支持 DOCX、XLSX、PPTX 与 PDF 文件</span><span>OPEN OFFICE · {{new Date().getFullYear()}}</span></footer>
      </main>
    </div>
    <section v-show="!home" class="editor-workspace" :inert="editorInputBlocked">
      <div ref="tabBar" class="tab-bar" :inert="globalActionsBlocked"><button class="home-tab" @click="home=true" aria-label="工作台"><Icon name="home" :size="18"/></button><div v-for="tab in tabs" :key="tab.key" class="document-tab" :class="{active:activeKey===tab.key}" role="tab" :aria-selected="activeKey===tab.key"><button class="tab-name" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]" :size="16"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button><button class="tab-close" @click="closeTab(tab)" :aria-label="`关闭 ${tab.document.name}`"><Icon name="close" :size="14"/></button></div><button class="new-tab" @click="home=true" aria-label="新建文档"><Icon name="plus" :size="18"/></button></div>
      <div v-if="active?.importWarnings?.length" class="import-review-notice" role="note" data-testid="import-review-notice"><Icon name="info" :size="16"/><div><p v-for="warning in active.importWarnings" :key="warning">{{warning}}</p><strong>保存需另存副本，避免自动覆盖原件。</strong></div></div>
      <div class="editor-content" :inert="editorInputBlocked">
        <RustWordEditor :theme="appearance" v-for="entry in rustWordEntries" :key="entry.document.id" v-show="activeRustWord&&activeKey===entry.document.id" :ref="handle=>setRustWordHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustWord&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustSheetEditor :theme="appearance" v-for="entry in rustSheetEntries" :key="entry.document.id" v-show="activeRustSheet&&activeKey===entry.document.id" :ref="handle=>setRustSheetHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustSheet&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustPresentationEditor :theme="appearance" v-for="entry in rustPresentationEntries" :key="entry.document.id" v-show="activeRustPresentation&&activeKey===entry.document.id" :ref="handle=>setRustPresentationHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustPresentation&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustPdfEditor :theme="appearance" v-for="entry in rustPdfEntries" :key="entry.document.id" v-show="activeRustPdf&&activeKey===entry.document.id" :ref="handle=>setRustPdfHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustPdf&&activeKey===entry.document.id" :disabled="editorInputBlocked" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
      </div>
      <footer class="editor-status"><span>{{status}}</span><span>{{active?.document.extension.toUpperCase()}} · {{activeRustWord?'文字编辑':activeRustSheet?'表格编辑':activeRustPresentation?'演示编辑':'PDF 编辑'}}</span></footer>
    </section>
    <ServerPanel v-if="serverPanel" :desktop="native.isTauri()" :running="serverStatus.running" :pending="serverPending" :local-url="serverStatus.localUrl" :lan-urls="serverStatus.lanUrls" :documents="sharedState.documents" :notice="serverNotice" :error="serverError" @close="serverPanel=false" @start="startServer" @stop="stopServer" @copy="copyServerLink" @open-document="openSharedDocument"/>
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
    <div v-if="closeTarget" class="modal-backdrop" @keydown.esc="closeTarget=null"><section ref="closeDialog" class="modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="close-heading"><span class="modal-icon"><Icon name="save" :size="27"/></span><h2 id="close-heading">保存你的修改？</h2><p>{{closeTarget==='window'?'有文档尚未保存。保存后再退出，可以保留所有修改。':`“${closeTarget.document.name}”有尚未保存的修改。`}}</p><div class="modal-actions"><button @click="closeTarget=null">取消</button><button @click="resolveClose('discard')">不保存</button><button class="primary" @click="resolveClose('save')">{{closeTarget==='window'?'全部保存并退出':'保存并关闭'}}</button></div></section></div>
    <div v-if="help" class="modal-backdrop" @click.self="help=false" @keydown.esc.stop.prevent="help=false"><section ref="helpDialog" class="modal help-modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="help-heading"><button class="modal-close icon-button" @click="help=false" aria-label="关闭说明"><Icon name="close"/></button><span class="eyebrow">OPEN OFFICE</span><h2 id="help-heading">为本地工作而设计</h2><div class="help-grid"><article><Icon name="file"/><h3>文字、表格与演示</h3><p>提供中文文字排版、表格与公式、数据分析、幻灯片编排及 PDF 导出。文字、表格、演示与 PDF 均使用本地 Rust 文档引擎。支持 DOCX、XLSX、CSV、TSV、PPTX、POTX 与 PPSX；模板与放映文稿另存为 PPTX。旧 DOC、RTF、ODT、XLS、ODS、PPT 与 ODP 请先转换为支持的格式。</p></article><article><Icon name="pdf"/><h3>PDF 工作室</h3><p>支持 PDF 阅读、文字编辑、批注、页面整理与书签导航。编辑、排版和保存均由本地 Rust 引擎处理。</p></article></div><p class="help-note">PDF 原文编辑针对可提取的文字，不包含扫描件 OCR。受密码或编辑权限保护的文件需要相应授权。修改数字签名文件时会另存副本。演示文稿支持幻灯片编排、对象编辑、备注与放映。复杂转场、动画、SmartArt 与媒体兼容性请以导出结果为准。复杂文档的兼容性仍需逐步完善：复杂排版、最新函数、宏与插件仍有差异。请检查导出结果；宏不自动执行。</p><p class="help-note"><strong>永久本地范围：</strong>不提供账户、云盘、云协作或云 AI，也不将这些服务列入后续功能计划。安装包内的编辑引擎在本机处理文档。</p><p class="help-note"><strong>自动保存与 Server：</strong>自动保存开关位于保存按钮旁，桌面版每 30 秒保存已选择本机位置的当前文档。Server 由你手动启动，本机或局域网浏览器可直接通过链接编辑，停顿后自动同步到客户端工作区。两端同时修改会保留冲突副本。浏览器保存按钮下载文件副本；写入本机文件由客户端控制。停止 Server 后链接失效。</p><p class="help-shortcuts">打开 <kbd>Ctrl / ⌘ O</kbd>　保存 <kbd>Ctrl / ⌘ S</kbd>　另存为 <kbd>Ctrl / ⌘ ⇧ S</kbd></p><small>版本 {{appVersion}} · 构建 {{buildVersion}} · 使用本地 Rust 文档引擎。第三方许可随应用提供。</small><button class="primary" @click="help=false">开始工作</button></section></div>
  </div>
</template>

<style scoped>
.autosave-toggle{display:inline-flex;gap:6px!important;align-items:center;white-space:nowrap}.autosave-track{width:25px;height:15px;border-radius:12px;background:var(--ui-line-strong);padding:2px;display:inline-flex;align-items:center}.autosave-track i{width:11px;height:11px;border-radius:50%;background:white;box-shadow:0 1px 3px #0002;transition:transform .15s}.autosave-track.enabled{background:var(--ui-accent)}.autosave-track.enabled i{transform:translateX(10px)}.server-toolbar-button{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;padding:6px 8px;border-radius:6px}.server-toolbar-button:hover{background:var(--ui-surface-muted)}.server-toolbar-button.connected{color:var(--ui-accent)}.server-toolbar-button i{width:5px;height:5px;border-radius:50%;background:var(--ui-success)}

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
