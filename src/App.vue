<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import Icon from './components/Icon.vue'
import OfficeEditor from './components/OfficeEditor.vue'
import PdfEditor from './components/PdfEditor.vue'
import SlidePreview from './components/SlidePreview.vue'
import PresentationWorkbench from './components/PresentationWorkbench.vue'
import PresentationEffects from './components/PresentationEffects.vue'
import WordWorkbench from './components/WordWorkbench.vue'
import SheetWorkbench from './components/SheetWorkbench.vue'
import type { PresentationState, PresentationAction } from './presentation/types'
import type { WriterState, WriterAction, WriterQuery } from './word/types'
import type { CalcState, CalcAction, CalcDataQuery } from './sheet/types'
import type { PptxPresentation, patchPptxPackage } from './presentation/pptx-package'
import * as native from './native'
import { smokeAwait, smokeFailure, smokeFeatures, smokeRequested, smokeStage } from './smoke'
import type { NativeDocument, RecentDocument } from './types'
import type { OfficeDocument } from './office/types'
import { bytesToBase64, base64ToBytes, extensionOf, kindOf, withExtension, type Kind, type Extension, type EditorHandle } from './shared/document'

interface Tab { key: string; document: NativeDocument; fileId?: string; dirty: boolean; ready: boolean; loadError?: string }
const buildVersion = __BUILD_VERSION__
const brandIcon = new URL('./favicon.svg', document.baseURI).href
const smokeMode = ref(smokeRequested())
smokeStage('app-setup', 'Vue setup reached')
const tabs = ref<Tab[]>([]), activeKey = ref(''), home = ref(true), section = ref('home')
const active = computed(() => tabs.value.find(t => t.key === activeKey.value))
const officeDocument = shallowRef<OfficeDocument>(), pdfDocument = shallowRef<NativeDocument>()
const officeEditor = ref<EditorHandle & { insertImage?(image: {name:string;base64:string}):Promise<void>; newSlide?():Promise<unknown>; smokeTest?():Promise<unknown>; getPresentationState?():Promise<PresentationState>; presentationObjectData?(query:{type:'table'|'chart';id:string}):Promise<unknown>; presentationAction?(action:PresentationAction):Promise<PresentationState>; presentationEdit?(patch:PresentationPatch):Promise<void>; getWriterState?():Promise<WriterState>; writerAction?(action:WriterAction):Promise<WriterState>; writerData?(query:WriterQuery):Promise<unknown>; getCalcState?():Promise<CalcState>; calcAction?(action:CalcAction):Promise<CalcState>; calcData?(query:CalcDataQuery):Promise<unknown> }>()
type PresentationPatch = Omit<Parameters<typeof patchPptxPackage>[1]['slides'][number], 'slideIndex'>
const pdfEditor = ref<EditorHandle>()
const presentationState = shallowRef<PresentationState | null>(null), presentationFeatures = shallowRef<PptxPresentation['slides'][number] | null>(null)
const presentationWorkbench = ref<{hasPendingEdits():boolean;assertNoPendingEdits():void;discardDrafts():void}>()
const presentationEffects = ref<{hasPendingEdits():boolean;discardDrafts():void}>()
type WorkbenchDrafts<T> = {hasPendingEdits():boolean;assertNoPendingEdits():void;discardDrafts():void;actionSucceeded?(state:T):void;actionFailed?():void}
const wordWorkbench = ref<WorkbenchDrafts<WriterState>>(), sheetWorkbench = ref<WorkbenchDrafts<CalcState>>()
const writerState = shallowRef<WriterState | null>(null), calcState = shallowRef<CalcState | null>(null)
function assertWorkbenchDrafts() {
  if(active.value?.document.kind==='word')wordWorkbench.value?.assertNoPendingEdits()
  if(active.value?.document.kind==='sheet')sheetWorkbench.value?.assertNoPendingEdits()
  if(active.value?.document.kind!=='presentation')return
  presentationWorkbench.value?.assertNoPendingEdits()
  if(presentationEffects.value?.hasPendingEdits())throw Error('切换设置尚未应用，请先应用或还原。')
}
function presentationChanged(state:PresentationState) {if(state.documentId===activeKey.value)presentationState.value=state}
function writerChanged(state:WriterState) {if(state.documentId===activeKey.value)writerState.value=state}
function calcChanged(state:CalcState) {if(state.documentId===activeKey.value)calcState.value=state}
watch(activeKey,()=>{presentationState.value=null;presentationFeatures.value=null;writerState.value=null;calcState.value=null})
const slidePreview = shallowRef<{base64:string;name:string;startPage:number;presentation?:PptxPresentation}>()
const recents = ref<RecentDocument[]>([]), busy = ref(''), error = ref(''), status = ref('所有文件，仅在你的设备上处理')
const help = ref(false), search = ref(''), closeTarget = ref<Tab | 'window' | null>(null)
const fileInput = ref<HTMLInputElement>(), imageInput = ref<HTMLInputElement>()
let unlisten: (() => void) | undefined
let pendingWindowClose = false
const editor = () => active.value?.document.kind === 'pdf' ? pdfEditor.value : officeEditor.value
const kindNames: Record<Kind,string> = { word:'文字文档', sheet:'电子表格', presentation:'演示文稿', pdf:'PDF 文档' }
const icons: Record<Kind,string> = {word:'file',sheet:'sheet',presentation:'presentation',pdf:'pdf'}
const filteredRecents = computed(() => recents.value.filter(r => r.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const message = (e:unknown) => e instanceof Error ? e.message : String(e)
async function task(label:string, work:()=>Promise<void>) {
  if (busy.value) return
  error.value=''; busy.value=label
  // A visual overlay alone leaves the iframe's keyboard focus active during exports.
  const focused=document.activeElement
  if(focused instanceof HTMLElement) focused.blur()
  try { await nextTick(); await work() } catch(e) { error.value=message(e) } finally {
    busy.value=''
    if(pendingWindowClose) {pendingWindowClose=false;void closeWindow()}
  }
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
  const handle=requireEditor(tab), exported=await handle.exportFile()
  if(activeKey.value!==tab.key)throw Error('文档已切换，旧的导出结果未被使用。')
  if(exported.dirty)tab.dirty=true
  return {handle,exported,document:{...tab.document,base64:exported.base64,extension:exported.extension,sizeBytes:Math.floor(exported.base64.length*.75)}}
}
async function stash() {
  const tab=active.value
  if(!tab || tab.loadError) return
  // Dirty notifications arrive asynchronously. Always snapshot the actual loaded model.
  // Export also refuses un-applied PDF drafts, and Office discard checks this revision.
  const snapshot=await capture(tab)
  await snapshot.handle.discardChanges?.()
  tab.document=snapshot.document
}
async function activate(tab:Tab) {
  if(activeKey.value!==tab.key) {
    const reuseOffice=tab.document.kind!=='pdf'&&officeDocument.value?.id===tab.key
    await stash()
    activeKey.value=tab.key
    if(tab.document.kind==='pdf') {tab.ready=false;tab.loadError=undefined;pdfDocument.value=tab.document}
    else {
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
      else if(tab.document.kind==='presentation'&&officeEditor.value?.getPresentationState)presentationChanged(await officeEditor.value.getPresentationState())
    }
  }
  home.value=false
}
async function addDocument(doc:NativeDocument, fileId?:string) {
  const existing=fileId && tabs.value.find(t=>t.fileId===fileId)
  if(existing) { await activate(existing); return }
  const key=crypto.randomUUID()
  const tab:Tab={key,document:{...doc,id:key},fileId,dirty:!fileId,ready:false}
  await stash()
  tabs.value.push(tab); activeKey.value=key; home.value=false
  if(doc.kind==='pdf') pdfDocument.value=tab.document
  else officeDocument.value=tab.document as OfficeDocument
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
    await addDocument({id:'',name:file.name,extension,kind:kindOf(extension),base64:bytesToBase64(new Uint8Array(await file.arrayBuffer())),sha256:'',sizeBytes:file.size})
  })
}
function openRecent(item:RecentDocument) { void task('正在打开最近文件',async()=>{const doc=await native.openRecent(item.id);await addDocument(doc,doc.id);await refreshRecents()}) }
function download(base64:string,name:string) {
  const url=URL.createObjectURL(new Blob([base64ToBytes(base64).buffer as ArrayBuffer])), link=document.createElement('a')
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000)
}
async function saveActive(saveAs=false, format?:Extension):Promise<boolean> {
  const tab=active.value;if(!tab)return false
  assertWorkbenchDrafts()
  const handle=requireEditor(tab)
  const exported=await handle.exportFile(format?{format}:undefined)
  if(activeKey.value!==tab.key)throw Error('文档已切换，本次保存已取消。')
  if(exported.dirty)tab.dirty=true
  const isCopy=!!format && format!==tab.document.extension
  const name=exported.name || withExtension(tab.document.name,exported.extension)
  if(!native.isTauri()) {
    download(exported.base64,name)
    if(!isCopy) { tab.document={...tab.document,base64:exported.base64,name};tab.dirty=false;await handle.markSaved?.(exported.base64) }
    status.value='已生成下载文件';return true
  }
  const result=await native.saveDocument({documentId:isCopy?undefined:tab.fileId,name,extension:exported.extension,base64:exported.base64,expectedSha256:isCopy?undefined:tab.document.sha256,saveAs:saveAs||isCopy||exported.saveAs||!tab.fileId})
  if(result.status==='cancelled') return false
  if(result.status==='conflict') { error.value=`${result.message} 请使用“另存为”保留当前修改。`;return false }
  if(!isCopy) {
    tab.fileId=result.document.id
    tab.document={...result.document,id:tab.key,base64:exported.base64}
    tab.dirty=false;await handle.markSaved?.(exported.base64)
  }
  await refreshRecents();status.value=isCopy?`${exported.extension.toUpperCase()} 副本已保存`:'已保存到本机';return true
}
function save(saveAs=false,format?:Extension) {void task(format?`正在导出 ${format.toUpperCase()}`:'正在保存文档',async()=>{await saveActive(saveAs,format)})}
function newSlide() {
  void task('正在新建幻灯片',async()=>{
    const tab=active.value;if(!tab||tab.document.kind!=='presentation')return
    requireEditor(tab);assertWorkbenchDrafts()
    if(!officeEditor.value?.newSlide)throw Error('演示文稿编辑器尚未就绪。')
    await officeEditor.value.newSlide();status.value='已新建幻灯片，沿用当前母版和布局'
  })
}
async function readPresentationObject(query:{type:'table'|'chart';id:string}) {
  if(!officeEditor.value?.presentationObjectData)throw Error('演示文稿尚未准备好。')
  return officeEditor.value.presentationObjectData(query)
}
function runPresentationAction(action:PresentationAction) {
  void task('正在更新幻灯片',async()=>{
    if(presentationEffects.value?.hasPendingEdits())throw Error('切换设置尚未应用，请先应用或还原。')
    if(!officeEditor.value?.presentationAction)throw Error('演示工作台尚未准备好。')
    presentationChanged(await officeEditor.value.presentationAction(action))
  })
}
function refreshPresentation() {void task('正在刷新幻灯片',async()=>{if(officeEditor.value?.getPresentationState)presentationChanged(await officeEditor.value.getPresentationState())})}
function runWriterAction(action:WriterAction) {
  void task('正在更新文档',async()=>{
    if(active.value?.document.kind!=='word'||!officeEditor.value?.writerAction)throw Error('文字工作台尚未就绪。')
    try {
      const state=await officeEditor.value.writerAction(action)
      writerChanged(state);wordWorkbench.value?.actionSucceeded?.(state)
    } catch(error) {wordWorkbench.value?.actionFailed?.();throw error}
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
async function readWriterData(query:WriterQuery) {
  if(!officeEditor.value?.writerData)throw Error('文字文档尚未准备好。')
  return officeEditor.value.writerData(query)
}
async function readCalcData(query:CalcDataQuery) {
  if(!officeEditor.value?.calcData)throw Error('工作表尚未准备好。')
  return officeEditor.value.calcData(query)
}
function editPresentationFeatures(patch:PresentationPatch) {
  void task('正在更新放映设置',async()=>{
    presentationWorkbench.value?.assertNoPendingEdits()
    if(!officeEditor.value?.presentationEdit)throw Error('演示工作台尚未准备好。')
    await officeEditor.value.presentationEdit(patch);status.value='已更新放映设置，请保存文稿'
  })
}
function previewSlides(startPage=0) {
  void task('正在准备放映预览',async()=>{
    const tab=active.value;if(!tab||tab.document.kind!=='presentation')return
    assertWorkbenchDrafts()
    const handle=requireEditor(tab)
    const pptx=await handle.exportFile({format:'pptx'})
    const {parsePptxPackage}=await import('./presentation/pptx-package')
    const presentation=await parsePptxPackage(base64ToBytes(pptx.base64))
    const exported=await handle.exportFile({format:'pdf'})
    if(activeKey.value!==tab.key)throw Error('文档已切换，已取消旧演示文稿的预览。')
    if(exported.dirty)tab.dirty=true
    slidePreview.value={base64:exported.base64,name:tab.document.name,startPage:Number.isSafeInteger(startPage)?Math.max(0,startPage):0,presentation}
  })
}
function closeSlidePreview() {slidePreview.value=undefined}
function changeTab(tab:Tab) {void task('正在切换文档',()=>activate(tab))}
async function removeTab(tab:Tab, discardConfirmed=false) {
  if(tab.key===activeKey.value) {
    if(discardConfirmed) {presentationWorkbench.value?.discardDrafts();presentationEffects.value?.discardDrafts();wordWorkbench.value?.discardDrafts();sheetWorkbench.value?.discardDrafts()}
    if(tab.ready)await editor()?.discardChanges?.({force:discardConfirmed})
    const next=tabs.value.find(t=>t.key!==tab.key)
    // Do not ask stash() to export a tab whose close was already checked/confirmed.
    activeKey.value=''
    if(next) await activate(next)
    else {home.value=true;officeDocument.value=undefined;pdfDocument.value=undefined}
  }
  tabs.value=tabs.value.filter(t=>t.key!==tab.key)
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
  // The native close confirmation must remain visible above a presentation.
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
function editCommand(command:'undo'|'redo'|'print') {void task('正在处理',async()=>{const fn=editor()?.[command];if(fn)await fn();else if(command==='print'&&await saveActive(true,'pdf'))status.value='已导出 PDF；请在系统 PDF 阅读器中打开并打印。'})}
function insertImage() {
  if(native.isTauri()) void task('正在插入图片',async()=>{const image=await native.pickImage();if(image)await officeEditor.value?.insertImage?.(image)})
  else imageInput.value?.click()
}
async function browserImage(event:Event) {
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return
  await task('正在插入图片',async()=>{if(file.size>10*1024*1024)throw Error('图片不能超过 10 MB');await officeEditor.value?.insertImage?.({name:file.name,base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))})})
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
      if(!officeEditor.value?.presentationAction || !Number.isInteger(request.pageIndex))throw Error('请先选择要复制的幻灯片。')
      presentationChanged(await officeEditor.value.presentationAction({type:'duplicate-page',pageIndex:request.pageIndex!}))
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
  if(slidePreview.value)return
  if(event.key==='F5'&&active.value?.document.kind==='presentation'&&!home.value){event.preventDefault();previewSlides();return}
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return
  if(event.key.toLowerCase()==='o'){event.preventDefault();openFile()}
  if(event.key.toLowerCase()==='s'){event.preventDefault();save(event.shiftKey)}
}
function beforeUnload(event:BeforeUnloadEvent){if(tabs.value.some(t=>t.dirty)){event.preventDefault();event.returnValue=''}}
onMounted(async()=>{
  window.addEventListener('keydown',keydown);window.addEventListener('beforeunload',beforeUnload)
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
          smokeStage('office-start','creating Writer document')
          await addDocument({id:'',kind:'word',extension:'docx',name:'Smoke.docx',base64:'',sha256:'',sizeBytes:0})
          await nextTick()
          const deadline=Date.now()+240000
          while(!active.value?.ready&&Date.now()<deadline) {
            if(active.value?.loadError)throw Error(active.value.loadError)
            await new Promise(resolve=>setTimeout(resolve,250))
          }
          if(!active.value?.ready)throw Error('Office engine readiness timed out after 240s')
          if(!officeEditor.value?.smokeTest)throw Error('Office smoke test unavailable')
          smokeStage('office-roundtrip','starting actual Writer, Calc and Impress edits')
          const office=await officeEditor.value.smokeTest() as {impress?:{pdfBase64?:string;pdfPageCount?:number}}
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
            await addDocument({id:'',kind,extension,name:`Native ${kind} verification.${extension}`,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)})
            await nextTick();const current=active.value;if(!current)throw Error('Native document tab missing')
            await awaitReady(current)
            return officeEditor.value!
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
            await addDocument({id:'',kind:'presentation',extension:'pptx',name:'Native presentation verification.pptx',base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)})
            await nextTick();const current=active.value;if(!current)throw Error('Native presentation tab missing')
            await awaitReady(current)
            return officeEditor.value as unknown as Awaited<ReturnType<Parameters<typeof verifyNativePresentation>[0]['create']>>
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
onBeforeUnmount(()=>{unlisten?.();window.removeEventListener('keydown',keydown);window.removeEventListener('beforeunload',beforeUnload)})
</script>

<template>
  <div class="app-shell" :class="{'editing':!home}">
    <input ref="fileInput" data-testid="document-open-input" class="visually-hidden" type="file" accept=".docx,.odt,.xlsx,.ods,.pptx,.odp,.pdf" @change="browserFile" />
    <input ref="imageInput" class="visually-hidden" type="file" accept="image/png,image/jpeg" @change="browserImage" />
    <header class="titlebar">
      <button class="brand" @click="home=true;section='home'" aria-label="返回工作台"><img :src="brandIcon" alt="" /><span>Open <b>Office</b></span></button>
      <span class="titlebar-context">{{ !home && active ? active.document.name : '专注于内容，让工作更从容' }}</span>
      <div class="titlebar-right"><span class="local-badge"><i/> 本地办公</span><span class="build-version">{{ buildVersion }}</span><button class="icon-button" @click="help=true" aria-label="使用说明"><Icon name="info" :size="18"/></button></div>
    </header>
    <div v-show="home" class="workspace">
      <aside class="sidebar">
        <button class="primary open-sidebar" @click="openFile"><Icon name="folder"/>打开文件<kbd>⌘ O</kbd></button>
        <nav aria-label="工作区"><button :class="{selected:section==='home'}" @click="section='home'"><Icon name="home"/>工作台</button><button :class="{selected:section==='recent'}" @click="section='recent'"><Icon name="clock"/>最近打开</button></nav>
        <div v-if="tabs.length" class="sidebar-documents"><span class="eyebrow">正在编辑</span><button v-for="tab in tabs" :key="tab.key" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button></div>
        <div class="sidebar-bottom"><Icon name="shield"/><strong>安心，离线处理</strong><p>你的文档留在本机。<br/>无需账户，也无需上传。</p><button @click="help=true">了解编辑与格式兼容 <Icon name="arrow" :size="15"/></button></div>
      </aside>
      <main class="home-main">
        <div class="home-heading"><div><span class="eyebrow">YOUR SPACE TO CREATE</span><h1>{{section==='home'?'今天，从一个好想法开始。':'继续上一次的工作。'}}</h1><p>文字、表格、演示与 PDF，在一个安静的工作空间里。</p></div><span class="workspace-mark">OO<span>WORKSPACE</span></span></div>
        <section v-if="section==='home'" class="create-grid" aria-label="新建文件">
          <button class="create-card word" @click="newDocument('word')"><div class="document-art"><span>W</span><i/><i/><i/></div><span class="card-bottom"><span><strong>文字文档</strong><small>让思考成为清晰的表达</small></span><span class="card-plus"><Icon name="plus"/></span></span><span class="file-kind">DOCX · ODT</span></button>
          <button class="create-card sheet" @click="newDocument('sheet')"><div class="document-art"><span>X</span><i/><i/><i/></div><span class="card-bottom"><span><strong>电子表格</strong><small>把复杂数据，整理得井井有条</small></span><span class="card-plus"><Icon name="plus"/></span></span><span class="file-kind">XLSX · ODS</span></button>
          <button class="create-card presentation" @click="newDocument('presentation')"><div class="document-art"><span>P</span><i/><i/><i/></div><span class="card-bottom"><span><strong>演示文稿</strong><small>把每一个想法，讲得更精彩</small></span><span class="card-plus"><Icon name="plus"/></span></span><span class="file-kind">PPTX · ODP</span></button>
          <button class="create-card pdf" @click="newDocument('pdf')"><div class="document-art"><span>P</span><i/><i/><i/></div><span class="card-bottom"><span><strong>PDF 工作室</strong><small>编辑原文、批注与整理页面</small></span><span class="card-plus"><Icon name="plus"/></span></span><span class="file-kind">PDF</span></button>
        </section>
        <section class="recent-section"><div class="section-heading"><h2>最近打开 <span>{{recents.length}}</span></h2><label class="search-box"><Icon name="search" :size="17"/><input v-model="search" placeholder="查找最近的文件" aria-label="查找最近的文件"/></label></div>
          <div v-if="!filteredRecents.length" class="empty-files"><div class="empty-icon"><Icon name="folder" :size="29"/></div><strong>{{search?'没有找到匹配的文件':'你的下一份作品，从这里开始'}}</strong><p>{{native.isTauri()?'打开本机文件后，可以在这里快速找到它。':'浏览器预览支持打开和导出文件；桌面版提供原文件保存与完整 PDF 编辑。'}}</p><button class="text-button" @click="openFile">打开一份文件 <Icon name="arrow" :size="16"/></button></div>
          <div v-else class="recent-list"><button v-for="item in filteredRecents" :key="item.id" class="recent-row" @click="openRecent(item)"><span class="file-icon" :class="item.kind"><Icon :name="icons[item.kind]"/></span><span class="recent-name">{{item.name}}<small>{{kindNames[item.kind]}} · {{item.extension.toUpperCase()}}</small></span><time>{{new Date(item.lastOpenedAt* (item.lastOpenedAt<1e12?1000:1)).toLocaleDateString('zh-CN')}}</time><Icon name="arrow" :size="17"/></button></div>
        </section>
        <footer class="home-footer"><span>一处工作台，四种创造力。</span><span>OPEN OFFICE · {{new Date().getFullYear()}}</span></footer>
      </main>
    </div>
    <section v-show="!home" class="editor-workspace">
      <div class="tab-bar"><button class="home-tab" @click="home=true" aria-label="工作台"><Icon name="home" :size="18"/></button><div v-for="tab in tabs" :key="tab.key" class="document-tab" :class="{active:activeKey===tab.key}" role="tab" :aria-selected="activeKey===tab.key"><button class="tab-name" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]" :size="16"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button><button class="tab-close" @click="closeTab(tab)" :aria-label="`关闭 ${tab.document.name}`"><Icon name="close" :size="14"/></button></div><button class="new-tab" @click="home=true" aria-label="新建文档"><Icon name="plus" :size="18"/></button></div>
      <div class="command-bar"><button @click="openFile"><Icon name="folder" :size="17"/>打开</button><span class="separator"/><button :disabled="!active?.ready" @click="save()"><Icon name="save" :size="17"/>保存</button><button :disabled="!active?.ready" @click="save(true)">另存为</button><button v-if="active?.document.kind!=='pdf'" :disabled="!active?.ready" @click="save(true,'pdf')"><Icon name="download" :size="17"/>导出 PDF</button><span class="separator"/><button :disabled="!active?.ready" @click="editCommand('undo')" title="撤销"><Icon name="undo" :size="17"/></button><button :disabled="!active?.ready" @click="editCommand('redo')" title="重做"><Icon name="redo" :size="17"/></button><template v-if="active?.document.kind==='presentation'"><span class="separator"/><button :disabled="!active?.ready" @click="newSlide" data-testid="presentation-new-slide"><Icon name="plus" :size="17"/>新建幻灯片</button><button :disabled="!active?.ready" @click="insertImage"><Icon name="image" :size="17"/>插入图片</button><button :disabled="!active?.ready" @click="previewSlides()" title="内置放映、转场与本地音视频 · F5" data-testid="presentation-preview"><Icon name="presentation" :size="17"/>预览放映</button><button :disabled="!active?.ready" @click="save(true,active.document.extension==='odp'?'pptx':'odp')" data-testid="presentation-export-alternate">导出 {{active.document.extension==='odp'?'PPTX':'ODP'}}</button></template><span class="command-spacer"/><span class="save-state"><i :class="{'dirty-dot':active?.dirty}"/>{{active?.dirty?'尚未保存':'已保存'}}</span></div>
      <div class="editor-content" :inert="!!busy">
        <WordWorkbench v-if="officeDocument" v-show="active?.document.kind!=='pdf'" ref="wordWorkbench" :active="active?.document.kind==='word'" :state="writerState" :read-data="readWriterData" :busy="!!busy" :disabled="!active?.ready" @action="runWriterAction" @refresh="refreshWriter" @insert-image="insertImage" @draft-change="dirtyFor(activeKey,$event)">
        <SheetWorkbench ref="sheetWorkbench" :active="active?.document.kind==='sheet'" :state="calcState" :read-data="readCalcData" :busy="!!busy" :disabled="!active?.ready" @action="runCalcAction" @refresh="refreshCalc" @insert-image="insertImage" @draft-change="dirtyFor(activeKey,$event)">
        <PresentationWorkbench ref="presentationWorkbench" :active="active?.document.kind==='presentation'" :state="presentationState" :read-object-data="readPresentationObject" :busy="!!busy" @action="runPresentationAction" @refresh="refreshPresentation" @insert-image="insertImage" @preview="previewSlides" @draft-change="dirtyFor(activeKey,$event)">
          <OfficeEditor ref="officeEditor" :document="officeDocument" :smoke-mode="smokeMode" @dirty="dirtyFor(officeDocument?.id,$event)" @ready="readyFor(officeDocument?.id)" @error="editorError(officeDocument?.id,$event)" @status="status=$event" @request="officeRequest" @presentation-state="presentationChanged" @presentation-features="presentationFeatures=$event" @word-state="writerChanged" @sheet-state="calcChanged"/>
          <template #effects><PresentationEffects v-if="presentationState" ref="presentationEffects" :slide="presentationFeatures" :page-id="presentationState.currentPage.id" :enabled="active?.document.extension==='pptx'" :busy="!!busy" @edit="editPresentationFeatures" @draft-change="dirtyFor(activeKey,$event)" @error="error=$event"/></template>
        </PresentationWorkbench>
        </SheetWorkbench>
        </WordWorkbench>
        <PdfEditor v-if="pdfDocument && active?.document.kind==='pdf'" :key="pdfDocument.id" ref="pdfEditor" :document="pdfDocument" :initial-dirty="active?.dirty" @dirty="dirtyFor(pdfDocument?.id,$event)" @ready="readyFor(pdfDocument?.id)" @error="editorError(pdfDocument?.id,$event)" @status="status=$event"/>
      </div>
      <footer class="editor-status"><span>{{status}}</span><span>{{active?.document.extension.toUpperCase()}} · 本机编辑</span></footer>
    </section>
    <SlidePreview v-if="slidePreview" :base64="slidePreview.base64" :name="slidePreview.name" :start-page="slidePreview.startPage" :presentation="slidePreview.presentation" @close="closeSlidePreview" @error="error=$event"/>
    <div v-if="error" class="error-banner" role="alert"><Icon name="info"/><span>{{error}}</span><button @click="error=''" aria-label="关闭错误提示"><Icon name="close" :size="16"/></button></div>
    <div v-if="busy" class="busy-overlay" role="status"><span class="busy-pill"><i/>{{busy}}</span></div>
    <div v-if="closeTarget" class="modal-backdrop" @keydown.esc="closeTarget=null"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="close-heading"><span class="modal-icon"><Icon name="save" :size="27"/></span><h2 id="close-heading">保存你的修改？</h2><p>{{closeTarget==='window'?'有文档尚未保存。保存后再退出，可以保留所有修改。':`“${closeTarget.document.name}”有尚未保存的修改。`}}</p><div class="modal-actions"><button @click="closeTarget=null">取消</button><button @click="resolveClose('discard')">不保存</button><button class="primary" @click="resolveClose('save')">{{closeTarget==='window'?'全部保存并退出':'保存并关闭'}}</button></div></section></div>
    <div v-if="help" class="modal-backdrop" @click.self="help=false"><section class="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-heading"><button class="modal-close icon-button" @click="help=false" aria-label="关闭说明"><Icon name="close"/></button><span class="eyebrow">OPEN OFFICE</span><h2 id="help-heading">为本地工作而设计</h2><div class="help-grid"><article><Icon name="file"/><h3>文字、表格与演示</h3><p>提供中文文字排版、表格与公式、数据分析、幻灯片编排及 PDF 导出。文档使用本地引擎处理，高级内置菜单目前为英文。</p></article><article><Icon name="pdf"/><h3>PDF 工作室</h3><p>支持原有文字替换、文字和图片、批注、手写签名、页面整理，以及页码、透明水印和书签导航。</p></article></div><p class="help-note">PDF 原文编辑针对可提取的文字，不包含扫描件 OCR。受密码或编辑权限保护的文件需要相应授权。修改数字签名文件时会另存副本。演示文稿提供中文编排、对象与图表编辑、备注、转场和本地媒体放映。SmartArt、逐对象动画、Morph 和微软云端功能尚未完整实现。完整 Microsoft 365 功能尚未对齐：复杂排版、最新函数、宏与插件、云协作仍有差距。请检查导出结果；宏不自动执行。</p><p class="help-shortcuts">打开 <kbd>Ctrl / ⌘ O</kbd>　保存 <kbd>Ctrl / ⌘ S</kbd>　另存为 <kbd>Ctrl / ⌘ ⇧ S</kbd></p><small>版本 0.4.0 · 构建 {{buildVersion}} · 使用 LibreOffice / ZetaOffice、PDF.js 与 PyMuPDF。第三方许可随应用提供。</small><button class="primary" @click="help=false">开始工作</button></section></div>
  </div>
</template>
