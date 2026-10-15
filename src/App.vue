<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import Icon from './components/Icon.vue'
import RustWordEditor from './components/RustWordEditor.vue'
import RustSheetEditor from './components/RustSheetEditor.vue'
import RustPresentationEditor from './components/RustPresentationEditor.vue'
import PdfEditor from './components/PdfEditor.vue'
import * as native from './native'
import { smokeAwait, smokeFailure, smokeFeatures, smokeRequested, smokeStage } from './smoke'
import type { NativeDocument, RecentDocument } from './types'
import { useDialogFocus } from './shared/dialog-focus'
import { useAppearance } from './shared/appearance'
import { inspectWordcraftSession, prepareRustWordDocument, type PreparedRustWordDocument } from './word/rust/client'
import { inspectGridcraftSession, prepareRustSheetDocument, type PreparedRustSheetDocument } from './sheet/rust/client'
import { inspectDeckcraftSession, prepareRustPresentationDocument, type PreparedRustPresentationDocument } from './presentation/rust/client'
import type { DeckcraftSmokeEditor } from './presentation/rust/deckcraft-native-smoke'
import type { GridcraftSmokeEditor } from './sheet/rust/gridcraft-native-smoke'
import type { WordcraftSmokeEditor } from './word/rust/wordcraft-native-smoke'
import { bytesToBase64, base64ToBytes, extensionOf, kindOf, withExtension, defaultSaveExtension, isImportOnly, validateDocumentSignature, saveFormats, saveFileName, type SaveExtension, type Kind, type Extension, type EditorHandle } from './shared/document'

interface Tab { key: string; document: NativeDocument; fileId?: string; requiresSaveAs?: boolean; importWarnings?:string[]; dirty: boolean; ready: boolean; loadError?: string }
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
const activeRustWord = computed(() => active.value?.document.kind === 'word')
const activeRustSheet = computed(() => active.value?.document.kind === 'sheet')
const activeRustPresentation = computed(() => active.value?.document.kind === 'presentation')
const activeRustEditor = computed(() => activeRustWord.value || activeRustSheet.value || activeRustPresentation.value)
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
let appDisposed = false
onBeforeUnmount(() => { appDisposed = true; setRustWordDocument(); setRustSheetDocument(); setRustPresentationDocument() })
const pdfDocument = shallowRef<NativeDocument>()
const pdfEditor = ref<EditorHandle>()
const recents = ref<RecentDocument[]>([]), busy = ref(''), error = ref(''), status = ref('所有文件，仅在你的设备上处理')
const help = ref(false), search = ref(''), closeTarget = ref<Tab | 'window' | null>(null)
const saveAsDraft = ref<{ key:string; kind:Kind; format:SaveExtension; name:string; error:string } | null>(null)
const globalActionsBlocked = computed(() => !!busy.value || !!saveAsDraft.value || !!closeTarget.value || help.value)
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
const editor = () => activeRustWord.value ? rustWordHandles.get(activeKey.value) : activeRustSheet.value ? rustSheetHandles.get(activeKey.value) : activeRustPresentation.value ? rustPresentationHandles.get(activeKey.value) : pdfEditor.value
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
    const entries=kind==='word'?rustWordEntries.value:kind==='sheet'?rustSheetEntries.value:kind==='presentation'?rustPresentationEntries.value:[]
    const reusable=entries.some(entry=>entry.document.id===tab.key)
    if(!reusable){tab.ready=false;tab.loadError=undefined}
    if(kind==='word')setRustWordDocument(tab.document)
    else if(kind==='sheet')setRustSheetDocument(tab.document)
    else if(kind==='presentation')setRustPresentationDocument(tab.document)
    else pdfDocument.value=tab.document
    await nextTick()
  }
  home.value=false
}
async function addDocument(doc:NativeDocument, fileId?:string) {
  // Validate the format family before touching any active document or session.
  doc={...doc}
  if(extensionOf(doc.name)!==doc.extension||kindOf(doc.extension)!==doc.kind)throw Error('文件名、格式与文档类型不一致，无法打开。')
  const existing=fileId && tabs.value.find(t=>t.fileId===fileId)
  if(existing) { await activate(existing); return }
  const key=crypto.randomUUID()
  let wordPrepared:PreparedRustWordDocument|undefined
  let sheetPrepared:PreparedRustSheetDocument|undefined
  let presentationPrepared:PreparedRustPresentationDocument|undefined
  try {
    // Every Rust parser prepares an isolated model before the active tab is touched.
    if(doc.kind==='word')wordPrepared=await prepareRustWordDocument({...doc,id:key})
    else if(doc.kind==='sheet')sheetPrepared=await prepareRustSheetDocument({...doc,id:key})
    else if(doc.kind==='presentation')presentationPrepared=await prepareRustPresentationDocument({...doc,id:key})
    if(appDisposed)return
    const protectedImport=doc.kind!=='pdf'&&!!doc.base64
    const importWarnings=protectedImport
      ? [doc.kind==='sheet'&&['csv','tsv'].includes(doc.extension)?'已导入文本数据；保存为 XLSX 工作簿，原始数据文件保留。':'此文件首次保存将生成副本。请核对复杂内容与排版。',...(sheetPrepared?.warnings??presentationPrepared?.warnings??[])]
      : []
    const tab:Tab={key,document:{...doc,id:key},fileId,requiresSaveAs:protectedImport||isImportOnly(doc.extension),importWarnings,dirty:!fileId,ready:false}
    await stash()
    if(appDisposed)return
    tabs.value.push(tab); activeKey.value=key; home.value=false
    if(doc.kind==='word') {setRustWordDocument(tab.document,wordPrepared);wordPrepared=undefined}
    else if(doc.kind==='sheet') {setRustSheetDocument(tab.document,sheetPrepared);sheetPrepared=undefined}
    else if(doc.kind==='presentation') {setRustPresentationDocument(tab.document,presentationPrepared);presentationPrepared=undefined}
    else pdfDocument.value=tab.document
  } finally {
    // Failed preflight/stash or disposal must not retain an undelivered model.
    wordPrepared?.discard()
    sheetPrepared?.discard()
    presentationPrepared?.discard()
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
async function saveActive(saveAs=false, format?:Extension, chosenName?:string):Promise<boolean> {
  const tab=active.value;if(!tab)return false
  if(format&&isImportOnly(format))throw Error('模板与放映文件仅支持导入，请另存为 PPTX 副本。')
  const requestedFormat=format||defaultSaveExtension(tab.document.extension)
  if(!formatsFor(tab).some(option=>option.extension===requestedFormat))throw Error('当前编辑器不支持此保存格式。')
  const handle=requireEditor(tab)
  const exported=await handle.exportFile({format:requestedFormat})
  if(activeKey.value!==tab.key)throw Error('文档已切换，本次保存已取消。')
  if(isImportOnly(exported.extension))throw Error('编辑器未生成现代格式，保存已取消，原文件未被修改。')
  if(exported.extension!==requestedFormat)throw Error('编辑器返回的格式与所选格式不一致，保存已取消。')
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
    else {home.value=true;pdfDocument.value=undefined}
  }
  tabs.value=tabs.value.filter(t=>t.key!==tab.key)
  if(pdfDocument.value?.id===tab.key)pdfDocument.value=undefined
  for(const entries of [rustWordEntries,rustSheetEntries,rustPresentationEntries]) {
    for(const entry of entries.value)if(entry.document.id===tab.key)entry.prepared?.discard()
    entries.value=entries.value.filter(entry=>entry.document.id!==tab.key) as typeof entries.value
  }
  rustWordHandles.delete(tab.key);rustSheetHandles.delete(tab.key);rustPresentationHandles.delete(tab.key)
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
    if(event.target instanceof Element&&event.target.closest('.rust-word-editor,.rust-sheet-editor,.rust-presentation-editor'))return
    event.preventDefault()
    if(!busy.value&&!closeTarget.value&&!help.value)save(true)
    return
  }
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return
  if(activeRustEditor.value&&!home.value) {
    // The canvas and its text agent report file actions themselves. Shell controls
    // have no engine listener, so handle their shortcuts here exactly once.
    if(event.target instanceof Element&&event.target.closest('.rust-word-editor,.rust-sheet-editor,.rust-presentation-editor'))return
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
        const report:Record<string,unknown>={...smokeFeatures()}
        try {
          if(!crossOriginIsolated)throw Error('Native WebView is not cross-origin isolated')
          smokeStage('wordcraft-native','starting the default WordCraft canvas and input round trip')
          const {runWordcraftNativeSmoke}=await import('./word/rust/wordcraft-native-smoke')
          const wordcraft=await runWordcraftNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认文字编辑器',()=>addDocument({id:'',kind:'word',extension:'docx',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.document.kind!=='word')throw Error('Default WordCraft smoke tab missing')
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
              if(!tab||tab.document.kind!=='sheet')throw Error('Default spreadsheet smoke tab missing')
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
          smokeStage('deckcraft-native','starting the default presentation canvas, slide editing and PPTX round trip')
          const {runDeckcraftNativeSmoke}=await import('./presentation/rust/deckcraft-native-smoke')
          const deckcraft=await runDeckcraftNativeSmoke({
            open:async(base64,name)=>{
              await editorTransaction('正在验证默认演示文稿编辑器',()=>addDocument({id:'',kind:'presentation',extension:'pptx',name,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)}))
              await nextTick()
              const tab=active.value
              if(!tab||tab.document.kind!=='presentation')throw Error('Default presentation smoke tab missing')
              await awaitReady(tab)
              const handle=rustPresentationHandles.get(tab.key) as DeckcraftSmokeEditor|undefined
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
              const handle=rustPresentationHandles.get(key) as DeckcraftSmokeEditor|undefined
              const sessionId=(await handle?.inspect())?.sessionId
              await removeTab(tab,true)
              await nextTick()
              if(sessionId) {
                let closed=false
                try {await inspectDeckcraftSession(sessionId)} catch {closed=true}
                if(!closed)throw Error('Presentation smoke session survived unmount')
              }
            },
          })
          report.deckcraft=deckcraft
          if(!deckcraft.ok)throw Error(deckcraft.error||deckcraft.closeError||'Default presentation native verification failed')
          smokeStage('deckcraft-native','complete')
          const {requestPdf}=await import('./pdf/protocol')
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
          <button class="create-card presentation" @click="newDocument('presentation')"><span class="document-art"><Icon name="presentation" :size="27"/></span><span class="card-bottom"><span><strong>演示文稿</strong><small>幻灯片设计与演示</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">PPTX · POTX · PPSX</span></button>
          <button class="create-card pdf" @click="newDocument('pdf')"><span class="document-art"><Icon name="pdf" :size="27"/></span><span class="card-bottom"><span><strong>PDF 工作室</strong><small>文字编辑、批注与页面整理</small></span><span class="card-plus"><Icon name="plus" :size="18"/></span></span><span class="file-kind">PDF</span></button>
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
        <RustWordEditor :theme="appearance" v-for="entry in rustWordEntries" :key="entry.document.id" v-show="activeRustWord&&activeKey===entry.document.id" :ref="handle=>setRustWordHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustWord&&activeKey===entry.document.id" :disabled="!!busy||!!saveAsDraft||!!closeTarget||help" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustSheetEditor :theme="appearance" v-for="entry in rustSheetEntries" :key="entry.document.id" v-show="activeRustSheet&&activeKey===entry.document.id" :ref="handle=>setRustSheetHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustSheet&&activeKey===entry.document.id" :disabled="!!busy||!!saveAsDraft||!!closeTarget||help" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <RustPresentationEditor :theme="appearance" v-for="entry in rustPresentationEntries" :key="entry.document.id" v-show="activeRustPresentation&&activeKey===entry.document.id" :ref="handle=>setRustPresentationHandle(entry.document.id,handle)" :document="entry.document" :prepared="entry.prepared" :active="!home&&activeRustPresentation&&activeKey===entry.document.id" :disabled="!!busy||!!saveAsDraft||!!closeTarget||help" @dirty="dirtyFor(entry.document.id,$event)" @ready="readyFor(entry.document.id)" @error="editorError(entry.document.id,$event)" @status="activeKey===entry.document.id&&(status=$event)" @file-action="activeKey===entry.document.id&&rustEditorFileAction($event)"/>
        <PdfEditor v-if="pdfDocument && active?.document.kind==='pdf'" :key="pdfDocument.id" ref="pdfEditor" :document="pdfDocument" :initial-dirty="active?.dirty" @dirty="dirtyFor(pdfDocument?.id,$event)" @ready="readyFor(pdfDocument?.id)" @error="editorError(pdfDocument?.id,$event)" @status="status=$event"/>
      </div>
      <footer class="editor-status"><span>{{status}}</span><span>{{active?.document.extension.toUpperCase()}} · {{activeRustWord?'文字编辑':activeRustSheet?'表格编辑':activeRustPresentation?'演示编辑':'PDF 编辑'}}</span></footer>
    </section>
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
    <div v-if="help" class="modal-backdrop" @click.self="help=false" @keydown.esc.stop.prevent="help=false"><section ref="helpDialog" class="modal help-modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="help-heading"><button class="modal-close icon-button" @click="help=false" aria-label="关闭说明"><Icon name="close"/></button><span class="eyebrow">OPEN OFFICE</span><h2 id="help-heading">为本地工作而设计</h2><div class="help-grid"><article><Icon name="file"/><h3>文字、表格与演示</h3><p>提供中文文字排版、表格与公式、数据分析、幻灯片编排及 PDF 导出。文字、表格和演示均使用本地 Rust 文档引擎。支持 DOCX、XLSX、CSV、TSV、PPTX、POTX 与 PPSX；模板与放映文稿另存为 PPTX。旧 DOC、RTF、ODT、XLS、ODS、PPT 与 ODP 请先转换为支持的格式。部分高级菜单目前为英文。</p></article><article><Icon name="pdf"/><h3>PDF 工作室</h3><p>支持原有文字替换、文字和图片、批注、手写签名、页面整理，以及页码、透明水印和书签导航。</p></article></div><p class="help-note">PDF 原文编辑针对可提取的文字，不包含扫描件 OCR。受密码或编辑权限保护的文件需要相应授权。修改数字签名文件时会另存副本。演示文稿支持幻灯片编排、对象编辑、备注与放映。复杂转场、动画、SmartArt 与媒体兼容性请以导出结果为准。Microsoft 365 的本地文档能力尚未完全对齐：复杂排版、最新函数、宏与插件仍有差异。请检查导出结果；宏不自动执行。</p><p class="help-note"><strong>永久本地范围：</strong>不提供账户、云盘、云协作或云 AI，也不将这些服务列入后续功能计划。安装包内的编辑引擎在本机处理文档。</p><p class="help-shortcuts">打开 <kbd>Ctrl / ⌘ O</kbd>　保存 <kbd>Ctrl / ⌘ S</kbd>　另存为 <kbd>Ctrl / ⌘ ⇧ S</kbd></p><small>版本 {{appVersion}} · 构建 {{buildVersion}} · 使用本地 Rust 文档引擎、PDF.js 与 PyMuPDF。第三方许可随应用提供。</small><button class="primary" @click="help=false">开始工作</button></section></div>
  </div>
</template>

<style scoped>
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
