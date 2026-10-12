<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import Icon from './components/Icon.vue'
import OfficeEditor from './components/OfficeEditor.vue'
import PdfEditor from './components/PdfEditor.vue'
import * as native from './native'
import type { NativeDocument, RecentDocument } from './types'
import type { OfficeDocument } from './office/types'
import { bytesToBase64, base64ToBytes, extensionOf, kindOf, withExtension, type Kind, type Extension, type EditorHandle } from './shared/document'

interface Tab { key: string; document: NativeDocument; fileId?: string; dirty: boolean; ready: boolean }
const buildVersion = __BUILD_VERSION__
const brandIcon = new URL('./favicon.svg', document.baseURI).href
const smokeMode = ref(false)
const tabs = ref<Tab[]>([]), activeKey = ref(''), home = ref(true), section = ref('home')
const active = computed(() => tabs.value.find(t => t.key === activeKey.value))
const officeDocument = shallowRef<OfficeDocument>(), pdfDocument = shallowRef<NativeDocument>()
const officeEditor = ref<EditorHandle & { insertImage?(image: {name:string;base64:string}):Promise<void>; smokeTest?():Promise<unknown> }>()
const pdfEditor = ref<EditorHandle>()
const recents = ref<RecentDocument[]>([]), busy = ref(''), error = ref(''), status = ref('所有文件，仅在你的设备上处理')
const help = ref(false), search = ref(''), closeTarget = ref<Tab | 'window' | null>(null)
const fileInput = ref<HTMLInputElement>(), imageInput = ref<HTMLInputElement>()
let unlisten: (() => void) | undefined
const editor = () => active.value?.document.kind === 'pdf' ? pdfEditor.value : officeEditor.value
const kindNames: Record<Kind,string> = { word:'文字文档', sheet:'电子表格', pdf:'PDF 文档' }
const icons: Record<Kind,string> = {word:'file',sheet:'sheet',pdf:'pdf'}
const filteredRecents = computed(() => recents.value.filter(r => r.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const message = (e:unknown) => e instanceof Error ? e.message : String(e)
async function task(label:string, work:()=>Promise<void>) {
  if (busy.value) return
  error.value=''; busy.value=label
  try { await work() } catch(e) { error.value=message(e) } finally { busy.value='' }
}
function dirtyFor(id:string|undefined, value:boolean) {
  const tab=tabs.value.find(t=>t.key===id)
  if(tab && value) tab.dirty=true
}
function readyFor(id:string|undefined) { const tab=tabs.value.find(t=>t.key===id); if(tab) tab.ready=true }
async function stash() {
  const tab=active.value, handle=editor()
  if(!tab || !handle) return
  if(tab.dirty) {
    const exported=await handle.exportFile()
    tab.document={...tab.document,base64:exported.base64,extension:exported.extension,sizeBytes:Math.floor(exported.base64.length*.75)}
  }
  await handle.discardChanges?.()
}
async function activate(tab:Tab) {
  if(activeKey.value!==tab.key) {
    await stash()
    activeKey.value=tab.key
    if(tab.document.kind==='pdf') pdfDocument.value=tab.document
    else officeDocument.value=tab.document as OfficeDocument
    await nextTick()
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
    const extension:Extension=kind==='word'?'docx':kind==='sheet'?'xlsx':'pdf'
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
  const tab=active.value, handle=editor(); if(!tab || !handle) return false
  const exported=await handle.exportFile(format?{format}:undefined)
  const isCopy=format==='pdf' && tab.document.kind!=='pdf'
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
  await refreshRecents();status.value=isCopy?'PDF 副本已保存':'已保存到本机';return true
}
function save(saveAs=false,format?:Extension) {void task(format==='pdf'?'正在导出 PDF':'正在保存文档',async()=>{await saveActive(saveAs,format)})}
function changeTab(tab:Tab) {void task('正在切换文档',()=>activate(tab))}
async function removeTab(tab:Tab) {
  if(tab.key===activeKey.value) {
    await editor()?.discardChanges?.()
    tab.dirty=false
    const next=tabs.value.find(t=>t.key!==tab.key)
    if(next) await activate(next)
    else {activeKey.value='';home.value=true;officeDocument.value=undefined;pdfDocument.value=undefined}
  }
  tabs.value=tabs.value.filter(t=>t.key!==tab.key)
}
function closeTab(tab:Tab) {if(tab.dirty)closeTarget.value=tab;else void task('正在关闭文档',()=>removeTab(tab))}
function closeWindow() {if(tabs.value.some(t=>t.dirty))closeTarget.value='window';else void native.confirmClose()}
async function resolveClose(action:'save'|'discard') {
  const target=closeTarget.value;if(!target)return
  await task(action==='save'?'正在保存未完成的文档':'正在关闭',async()=>{
    if(target==='window') {
      if(action==='save') for(const tab of tabs.value.filter(t=>t.dirty)) {await activate(tab);if(!await saveActive())return}
      closeTarget.value=null;await native.confirmClose()
    } else {
      if(action==='save') {await activate(target);if(!await saveActive())return}
      await removeTab(target);closeTarget.value=null
    }
  })
}
function editCommand(command:'undo'|'redo'|'print') {void task('正在处理',async()=>{const fn=editor()?.[command];if(fn)await fn();else if(command==='print')await saveActive(true,'pdf')})}
function insertImage() {
  if(native.isTauri()) void task('正在插入图片',async()=>{const image=await native.pickImage();if(image)await officeEditor.value?.insertImage?.(image)})
  else imageInput.value?.click()
}
async function browserImage(event:Event) {
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return
  await task('正在插入图片',async()=>{if(file.size>10*1024*1024)throw Error('图片不能超过 10 MB');await officeEditor.value?.insertImage?.({name:file.name,base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))})})
}
function officeRequest(request:{type:string}) {
  if(request.type==='open')openFile()
  else if(request.type==='new') {home.value=true;section.value='home'}
  else if(request.type==='save')save()
  else if(request.type==='save-as')save(true)
  else if(request.type==='export-pdf')save(true,'pdf')
  else if(request.type==='insert-image')insertImage()
  else if(request.type==='close' && active.value)closeTab(active.value)
  else if(request.type==='print')editCommand('print')
}
function keydown(event:KeyboardEvent) {
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return
  if(event.key.toLowerCase()==='o'){event.preventDefault();openFile()}
  if(event.key.toLowerCase()==='s'){event.preventDefault();save(event.shiftKey)}
}
function beforeUnload(event:BeforeUnloadEvent){if(tabs.value.some(t=>t.dirty)){event.preventDefault();event.returnValue=''}}
onMounted(async()=>{
  window.addEventListener('keydown',keydown);window.addEventListener('beforeunload',beforeUnload)
  try {
    if(native.isTauri()) {
      unlisten=await native.onCloseRequested(closeWindow);await refreshRecents()
      const config=await native.bootstrap() as Awaited<ReturnType<typeof native.bootstrap>> & {smokeMode?:boolean}
      if(config.smokeMode) {
        smokeMode.value=true
        const report:Record<string,unknown>={crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer!=='undefined',userAgent:navigator.userAgent}
        try {
          if(!crossOriginIsolated)throw Error('Native WebView is not cross-origin isolated')
          await addDocument({id:'',kind:'word',extension:'docx',name:'Smoke.docx',base64:'',sha256:'',sizeBytes:0})
          await nextTick()
          for(let count=0;count<480&&!active.value?.ready;count++) await new Promise(resolve=>setTimeout(resolve,500))
          if(!officeEditor.value?.smokeTest)throw Error('Office smoke test unavailable')
          report.office=await officeEditor.value.smokeTest()
          const {requestPdf}=await import('./pdf/protocol')
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
        }catch(e){report.ok=false;report.error=message(e)}
        await invoke('smoke_report',{report})
      }
    }
  }catch(e){error.value=message(e)}
})
onBeforeUnmount(()=>{unlisten?.();window.removeEventListener('keydown',keydown);window.removeEventListener('beforeunload',beforeUnload)})
</script>

<template>
  <div class="app-shell" :class="{'editing':!home}">
    <input ref="fileInput" class="visually-hidden" type="file" accept=".docx,.odt,.xlsx,.ods,.pdf" @change="browserFile" />
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
        <div class="home-heading"><div><span class="eyebrow">YOUR SPACE TO CREATE</span><h1>{{section==='home'?'今天，从一个好想法开始。':'继续上一次的工作。'}}</h1><p>文字、表格与 PDF，在一个安静的工作空间里。</p></div><span class="workspace-mark">OO<span>WORKSPACE</span></span></div>
        <section v-if="section==='home'" class="create-grid" aria-label="新建文件">
          <button class="create-card word" @click="newDocument('word')"><div class="document-art"><span>W</span><i/><i/><i/></div><span class="card-bottom"><span><strong>文字文档</strong><small>让思考成为清晰的表达</small></span><span class="card-plus"><Icon name="plus"/></span></span><span class="file-kind">DOCX · ODT</span></button>
          <button class="create-card sheet" @click="newDocument('sheet')"><div class="document-art"><span>X</span><i/><i/><i/></div><span class="card-bottom"><span><strong>电子表格</strong><small>把复杂数据，整理得井井有条</small></span><span class="card-plus"><Icon name="plus"/></span></span><span class="file-kind">XLSX · ODS</span></button>
          <button class="create-card pdf" @click="newDocument('pdf')"><div class="document-art"><span>P</span><i/><i/><i/></div><span class="card-bottom"><span><strong>PDF 工作室</strong><small>编辑原文、批注与整理页面</small></span><span class="card-plus"><Icon name="plus"/></span></span><span class="file-kind">PDF</span></button>
        </section>
        <section class="recent-section"><div class="section-heading"><h2>最近打开 <span>{{recents.length}}</span></h2><label class="search-box"><Icon name="search" :size="17"/><input v-model="search" placeholder="查找最近的文件" aria-label="查找最近的文件"/></label></div>
          <div v-if="!filteredRecents.length" class="empty-files"><div class="empty-icon"><Icon name="folder" :size="29"/></div><strong>{{search?'没有找到匹配的文件':'你的下一份作品，从这里开始'}}</strong><p>{{native.isTauri()?'打开本机文件后，可以在这里快速找到它。':'浏览器预览支持打开和导出文件；桌面版提供原文件保存与完整 PDF 编辑。'}}</p><button class="text-button" @click="openFile">打开一份文件 <Icon name="arrow" :size="16"/></button></div>
          <div v-else class="recent-list"><button v-for="item in filteredRecents" :key="item.id" class="recent-row" @click="openRecent(item)"><span class="file-icon" :class="item.kind"><Icon :name="icons[item.kind]"/></span><span class="recent-name">{{item.name}}<small>{{kindNames[item.kind]}} · {{item.extension.toUpperCase()}}</small></span><time>{{new Date(item.lastOpenedAt* (item.lastOpenedAt<1e12?1000:1)).toLocaleDateString('zh-CN')}}</time><Icon name="arrow" :size="17"/></button></div>
        </section>
        <footer class="home-footer"><span>一处工作台，三种创造力。</span><span>OPEN OFFICE · {{new Date().getFullYear()}}</span></footer>
      </main>
    </div>
    <section v-show="!home" class="editor-workspace">
      <div class="tab-bar"><button class="home-tab" @click="home=true" aria-label="工作台"><Icon name="home" :size="18"/></button><div v-for="tab in tabs" :key="tab.key" class="document-tab" :class="{active:activeKey===tab.key}" role="tab" :aria-selected="activeKey===tab.key"><button class="tab-name" @click="changeTab(tab)"><Icon :name="icons[tab.document.kind]" :size="16"/><span>{{tab.document.name}}</span><i v-if="tab.dirty" class="dirty-dot"/></button><button class="tab-close" @click="closeTab(tab)" :aria-label="`关闭 ${tab.document.name}`"><Icon name="close" :size="14"/></button></div><button class="new-tab" @click="home=true" aria-label="新建文档"><Icon name="plus" :size="18"/></button></div>
      <div class="command-bar"><button @click="openFile"><Icon name="folder" :size="17"/>打开</button><span class="separator"/><button :disabled="!active?.ready" @click="save()"><Icon name="save" :size="17"/>保存</button><button :disabled="!active?.ready" @click="save(true)">另存为</button><button v-if="active?.document.kind!=='pdf'" :disabled="!active?.ready" @click="save(true,'pdf')"><Icon name="download" :size="17"/>导出 PDF</button><span class="separator"/><button :disabled="!active?.ready" @click="editCommand('undo')" title="撤销"><Icon name="undo" :size="17"/></button><button :disabled="!active?.ready" @click="editCommand('redo')" title="重做"><Icon name="redo" :size="17"/></button><span class="command-spacer"/><span class="save-state"><i :class="{'dirty-dot':active?.dirty}"/>{{active?.dirty?'尚未保存':'已保存'}}</span></div>
      <div class="editor-content">
        <OfficeEditor v-if="officeDocument" v-show="active?.document.kind!=='pdf'" ref="officeEditor" :document="officeDocument" :smoke-mode="smokeMode" @dirty="dirtyFor(officeDocument?.id,$event)" @ready="readyFor(officeDocument?.id)" @error="error=$event" @status="status=$event" @request="officeRequest"/>
        <PdfEditor v-if="pdfDocument && active?.document.kind==='pdf'" :key="pdfDocument.id" ref="pdfEditor" :document="pdfDocument" :initial-dirty="active?.dirty" @dirty="dirtyFor(pdfDocument?.id,$event)" @ready="readyFor(pdfDocument?.id)" @error="error=$event" @status="status=$event"/>
      </div>
      <footer class="editor-status"><span>{{status}}</span><span>{{active?.document.extension.toUpperCase()}} · 本机编辑</span></footer>
    </section>
    <div v-if="error" class="error-banner" role="alert"><Icon name="info"/><span>{{error}}</span><button @click="error=''" aria-label="关闭错误提示"><Icon name="close" :size="16"/></button></div>
    <div v-if="busy" class="busy-overlay" role="status"><span class="busy-pill"><i/>{{busy}}</span></div>
    <div v-if="closeTarget" class="modal-backdrop" @keydown.esc="closeTarget=null"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="close-heading"><span class="modal-icon"><Icon name="save" :size="27"/></span><h2 id="close-heading">保存你的修改？</h2><p>{{closeTarget==='window'?'有文档尚未保存。保存后再退出，可以保留所有修改。':`“${closeTarget.document.name}”有尚未保存的修改。`}}</p><div class="modal-actions"><button @click="closeTarget=null">取消</button><button @click="resolveClose('discard')">不保存</button><button class="primary" @click="resolveClose('save')">{{closeTarget==='window'?'全部保存并退出':'保存并关闭'}}</button></div></section></div>
    <div v-if="help" class="modal-backdrop" @click.self="help=false"><section class="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-heading"><button class="modal-close icon-button" @click="help=false" aria-label="关闭说明"><Icon name="close"/></button><span class="eyebrow">OPEN OFFICE</span><h2 id="help-heading">为本地工作而设计</h2><div class="help-grid"><article><Icon name="file"/><h3>文字与表格</h3><p>使用完整办公内核，支持文字排版、表格、公式、图表与 PDF 导出。高级菜单目前为英文，支持中文输入及本地字体。</p></article><article><Icon name="pdf"/><h3>PDF 工作室</h3><p>支持原有文字替换、添加文字和图片、批注、手写签名，以及页面旋转、删除、排序、提取和合并。</p></article></div><p class="help-note">PDF 原文编辑针对可提取的文字，不包含扫描件 OCR。受密码或编辑权限保护的文件需要相应授权。修改数字签名文件时会另存副本。复杂 Office 排版建议导出后复核；宏不自动执行。</p><p class="help-shortcuts">打开 <kbd>Ctrl / ⌘ O</kbd>　保存 <kbd>Ctrl / ⌘ S</kbd>　另存为 <kbd>Ctrl / ⌘ ⇧ S</kbd></p><small>版本 0.1.0 · 构建 {{buildVersion}} · 使用 LibreOffice / ZetaOffice、PDF.js 与 PyMuPDF。第三方许可随应用提供。</small><button class="primary" @click="help=false">开始工作</button></section></div>
  </div>
</template>
