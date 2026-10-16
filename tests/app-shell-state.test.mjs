import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { baseParse } from '@vue/compiler-dom'
import { zipSync, strToU8 } from 'fflate'
import { createId } from '../src/shared/id.ts'

// Run the real App.vue setup logic with Vue's real reactivity. Editors and native
// file dialogs are controlled doubles: these are shell-state regressions, not
// Rust/WASM/PDF engine or native WebView compatibility tests.
const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
const app = appSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const utilities = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const dialogFocus = await readFile(new URL('../src/shared/dialog-focus.ts', import.meta.url), 'utf8')
const appearanceSource = await readFile(new URL('../src/shared/appearance.ts', import.meta.url), 'utf8')
const autosaveSource = await readFile(new URL('../src/shared/autosave.ts', import.meta.url), 'utf8')
const browserWorkspaceSource = await readFile(new URL('../src/shared/browser-workspace.ts', import.meta.url), 'utf8')
const workspaceSyncSource = await readFile(new URL('../src/shared/workspace-sync.ts', import.meta.url), 'utf8')
const names = 'tabs,activeKey,active,home,tabBar,help,helpDialog,closeDialog,saveAsDraft,saveAsOptions,saveAsCopy,openSaveAs,confirmSaveAs,cancelSaveAs,rustPdfEntries,rustPdfHandles,setRustPdfHandle,rustWordEntries,rustWordHandles,setRustWordHandle,rustSheetEntries,rustSheetHandles,setRustSheetHandle,rustPresentationEntries,rustPresentationHandles,setRustPresentationHandle,busy,error,closeTarget,readyFor,dirtyFor,editorError,stash,activate,addDocument,newDocument,openFile,openRecent,browserFile,saveActive,closeTab,closeWindow,resolveClose,removeTab,task,editorTransaction,nativeTransactionalEditor,appearance,currentDocument,globalActionsBlocked,documentActionsDisabled,globalFileAction,globalNewDocument,keydown,rustEditorFileAction,previewSlides'
  + ',autosaveEnabled,autosave,backgroundSaving,editorInputBlocked,adoptShared,sharedSnapshot,sharedRevision,stagedTab,syncApplying,enableWorkspaceSync,pollWorkspace,serverStatus,serverError,sharedState,serverNotice,serverPanel,startServer,stopServer,openSharedDocument'


function compile(source, require, extra = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require, console, URL, setTimeout, clearTimeout,
    crypto: { randomUUID }, btoa, atob, TextEncoder, TextDecoder, __BUILD_VERSION__: 'test', __APP_VERSION__: 'test', HTMLElement: class {}, document: { baseURI: 'http://127.0.0.1/' }, ...extra })
  return module.exports
}


function shell({nativeEnabled = true, smoke = false, rustPrepareError, rustPrepare, wordSmokeError, wordSmokeReport, wordSmokeRun, sheetPrepareError, sheetPrepare, sheetWarnings = [], deckPrepareError, deckPrepare, deckWarnings = [], presentationSmokeError, presentationSmokeReport, presentationSmokeRun, sheetSmokeError, sheetSmokeReport, sheetSmokeRun, pdfPrepareError, pdfPrepare, pdfWarnings = [], pdfSmokeError, pdfSmokeReport, workspaceSmokeError, workspaceSmokeReport, storedAppearance, storedAutosave, systemDark = false, storageUnavailable = false, browserUrl = 'http://127.0.0.1/', browserFetch, workspaceDispatch} = {}) {
  const rustPreparations = [], sheetPreparations = [], deckPreparations = [], pdfPreparations = []
  const calls = [], mounted = [], beforeUnmount = [], observers = [], native = {
    isTauri: () => nativeEnabled,
    onCloseRequested: async () => () => {},
    bootstrap: async () => ({smokeMode:false}),
    listRecentDocuments: async () => [],
    openDocument: async () => null,
    statusBrowserServer: async () => ({running:false,localUrl:null,lanUrls:[],revision:0}),
    dispatchBrowserWorkspace: async (...args) => workspaceDispatch ? workspaceDispatch(...args) : {statusCode:200,body:{running:false,revision:0,documents:[]}},
    confirmClose: async () => { calls.push(['close']) },
    saveDocument: async request => {
      calls.push(['save', request])
      return { status: 'saved', document: { id: request.documentId || randomUUID(), name: request.name,
        kind: helpers.kindOf(request.extension), extension: request.extension, sha256: 'new-hash', sizeBytes: 3 } }
    },
  }
  const lifecycle = { ...vue, onMounted(callback) { mounted.push(callback) }, onBeforeUnmount(callback) { beforeUnmount.push(callback) } }
  const storage = new Map(storedAppearance === undefined ? [] : [['open-office.appearance', storedAppearance]])
  if (storedAutosave !== undefined) storage.set('open-office-autosave', storedAutosave)
  const windowListeners = new Map(), documentListeners = new Map(), mediaListeners = new Set()
  const timers = new Map(), intervals = new Map()
  const media = { matches: systemDark, addEventListener(_type, callback) { mediaListeners.add(callback) }, removeEventListener(_type, callback) { mediaListeners.delete(callback) } }
  class Element {}
  // Share DOM identities with the real dialog helper across both VM contexts.
  // Layout notifications remain controlled because this harness has no renderer.
  const browser = {
    crossOriginIsolated: true,
    Blob,
    AbortController, Response, Headers,
    location: new URL(browserUrl),
    fetch: browserFetch ?? (async () => { throw Error('Unexpected network request in shell-state test') }),
    URL: class extends URL { static createObjectURL(){return 'blob:shell-test'} static revokeObjectURL(){} },
    setTimeout(callback, milliseconds, ...args) {
      const timer=setTimeout(()=>{timers.delete(timer);callback(...args)},milliseconds)
      timer.unref();timers.set(timer,{callback,milliseconds,args});return timer
    },
    clearTimeout(timer) { clearTimeout(timer);timers.delete(timer) },
    // The scheduler and synchronization code are real. Their clock/DOM hosts are
    // controlled so a mounted shell cannot start background work in another test.
    setInterval(callback, milliseconds) { const timer={callback,milliseconds};intervals.set(timer,timer);return timer },
    clearInterval(timer) { intervals.delete(timer) },
    window: {
      addEventListener(type, callback) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(callback) },
      removeEventListener(type, callback) { windowListeners.get(type)?.delete(callback) },
      matchMedia: () => media,
      localStorage: {
        getItem(key) { if (storageUnavailable) throw Error('Storage unavailable'); return storage.get(key) ?? null },
        setItem(key, value) { if (storageUnavailable) throw Error('Storage unavailable'); storage.set(key, value) },
      },
    },
    document: {
      baseURI: browserUrl, activeElement: null, documentElement: { dataset: {} },
      addEventListener(type, callback) { if (!documentListeners.has(type)) documentListeners.set(type,new Set());documentListeners.get(type).add(callback) },
      removeEventListener(type, callback) { documentListeners.get(type)?.delete(callback) },
      createElement(tag) { assert.equal(tag,'a');return {click(){calls.push(['download',this.download,this.href])}} },
    },
    Element,
    HTMLElement: class extends Element {},
    ResizeObserver: class {
      targets = new Set()
      disconnected = false
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(target) { this.targets.add(target) }
      disconnect() { this.targets.clear(); this.disconnected = true }
      notify() { this.callback([...this.targets].map(target => ({ target })), this) }
    },
  }
  browser.localStorage=browser.window.localStorage
  browser.window.location=browser.location
  const scope = vue.effectScope()
  const focus = compile(dialogFocus, name => {
    if (name === 'vue') return lifecycle
    throw Error(`Unexpected dialog helper import ${name}`)
  }, browser)
  const appearance = compile(appearanceSource, name => {
    if (name === 'vue') return lifecycle
    throw Error(`Unexpected appearance helper import ${name}`)
  }, browser)
  const helpers = compile(utilities, () => { throw Error('Unexpected helper import') })
  const modules = new Map()
  function sharedModule(name) {
    if (modules.has(name)) return modules.get(name)
    const source = {'./shared/autosave':autosaveSource,'./shared/browser-workspace':browserWorkspaceSource,'./shared/workspace-sync':workspaceSyncSource}[name]
    if (!source) throw Error(`Unexpected shared module import ${name}`)
    const result=compile(source, dependency => sharedModule(dependency.replace(/^\.\//,'./shared/')), browser)
    modules.set(name,result);return result
  }
  const state = scope.run(() => compile(`${app}\nexport const state={${names}}`, name => {
    if (name === 'vue') return lifecycle
    if (name === './native') return native
    if (name === './smoke') return {smokeRequested:()=>smoke,smokeStage(){},smokeFeatures:()=>({}),smokeFailure:async(error,phase)=>{calls.push(['smoke-failure',phase,String(error)])},smokeAwait:async(_phase,action)=>action()}
    if (name === './shared/document') return helpers
    if (name === './shared/id') return { createId }
    if (name === './shared/dialog-focus') return focus
    if (name === './shared/appearance') return appearance
    if (['./shared/autosave','./shared/browser-workspace','./shared/workspace-sync'].includes(name)) return sharedModule(name)
    // This double verifies shell routing, preparation ownership and transaction
    // ordering only. Real Rust parsing, layout and WASM are tested separately.
    if (name === './word/rust/client') return { async prepareRustWordDocument(source) {
      const captured={...source}
      calls.push(['rust-preflight',captured])
      if(rustPrepareError)throw Error(rustPrepareError)
      const session=rustPrepare?await rustPrepare(captured):{testRustSession:rustPreparations.length}
      let pending=session
      const record={source:captured,session,discarded:0,takes:[]}
      const handoff={
        take(target){record.takes.push({...target});const value=pending;pending=undefined;return captured.id===target.id&&captured.base64===target.base64?value:undefined},
        discard(){record.discarded++;pending=undefined},
      }
      rustPreparations.push(Object.assign(record,{handoff}));calls.push(['rust-prepared',captured.id])
      return handoff
    } }
    if (name === './sheet/rust/client') return { async prepareRustSheetDocument(source) {
      const captured={...source}
      calls.push(['sheet-preflight',captured])
      if(sheetPrepareError)throw Error(sheetPrepareError)
      const session=sheetPrepare?await sheetPrepare(captured):{testSheetSession:sheetPreparations.length}
      let pending=session
      const record={source:captured,session,discarded:0,takes:[]}
      const handoff={warnings:[...sheetWarnings],
        take(target){record.takes.push({...target});const value=pending;pending=undefined;return captured.id===target.id&&captured.base64===target.base64?value:undefined},
        discard(){record.discarded++;pending=undefined},
      }
      sheetPreparations.push(Object.assign(record,{handoff}));calls.push(['sheet-prepared',captured.id])
      return handoff
    } }
    if (name === './presentation/rust/client') return { async prepareRustPresentationDocument(source) {
      const captured={...source};calls.push(['deck-preflight',captured])
      if(deckPrepareError)throw Error(deckPrepareError)
      const session=deckPrepare?await deckPrepare(captured):{testDeckSession:deckPreparations.length}
      let pending=session
      const record={source:captured,session,discarded:0,takes:[]}
      const handoff={warnings:[...deckWarnings],take(target){record.takes.push({...target});const value=pending;pending=undefined;return captured.id===target.id&&captured.base64===target.base64?value:undefined},discard(){record.discarded++;pending=undefined}}
      deckPreparations.push(Object.assign(record,{handoff}));calls.push(['deck-prepared',captured.id]);return handoff
    } }
    if (name === './presentation/rust/office-presentation-native-smoke') return {async runOfficePresentationNativeSmoke(adapter){calls.push(['office-presentation-native-smoke']);if(presentationSmokeError)throw Error(presentationSmokeError);if(presentationSmokeRun)return presentationSmokeRun(adapter);return presentationSmokeReport??{schemaVersion:1,ok:true,engine:'office-presentation-wasm',reopenedPptxBase64:'native-presentation-reopened'}}}
    if (name === './pdf/rust/client') return { async prepareRustPdfDocument(source) {
      const captured={...source};calls.push(['pdf-preflight',captured])
      if(pdfPrepareError)throw Error(pdfPrepareError)
      const session=pdfPrepare?await pdfPrepare(captured):{testPdfSession:pdfPreparations.length}
      let pending=session
      const record={source:captured,session,discarded:0,takes:[]}
      const handoff={warnings:[...pdfWarnings],take(target){record.takes.push({...target});const value=pending;pending=undefined;return captured.id===target.id&&captured.base64===target.base64?value:undefined},discard(){record.discarded++;pending=undefined}}
      pdfPreparations.push(Object.assign(record,{handoff}));calls.push(['pdf-prepared',captured.id]);return handoff
    } }
    if (name === './pdf/rust/native-smoke') return {async runOfficePdfNativeSmoke(){calls.push(['pdf-native-smoke']);if(pdfSmokeError)throw Error(pdfSmokeError);return pdfSmokeReport??{schemaVersion:1,ok:true,engine:'office-pdf-wasm',reopened:true,removedOldText:true,newTextPresent:true,reopenedPdfBase64:'native-pdf-reopened'}}}
    if (name === './word/rust/office-word-native-smoke') return {async runOfficeWordNativeSmoke(adapter){calls.push(['office-word-native-smoke']);if(wordSmokeError)throw Error(wordSmokeError);if(wordSmokeRun)return wordSmokeRun(adapter);return wordSmokeReport??{schemaVersion:1,ok:true,engine:'office-word-wasm'}}}
    if (name === './sheet/rust/office-sheet-native-smoke') return {async runOfficeSheetNativeSmoke(adapter){calls.push(['office-sheet-native-smoke']);if(sheetSmokeError)throw Error(sheetSmokeError);if(sheetSmokeRun)return sheetSmokeRun(adapter);return sheetSmokeReport??{schemaVersion:1,ok:true,engine:'office-sheet-wasm',reopenedXlsxBase64:'native-sheet-reopened'}}}
    if (name === './shared/workspace-native-smoke') return {async runWorkspaceNativeSmoke(adapter,fixtures){calls.push(['workspace-native-smoke',fixtures]);assert.equal(typeof adapter.observeNativeSaves,'function');if(workspaceSmokeError)throw Error(workspaceSmokeError);return workspaceSmokeReport??{schemaVersion:1,kind:'workspace-native',ok:true}}}
    if (name === '@tauri-apps/api/core') return { invoke: async (command,args) => { calls.push(['invoke',command,args]) } }
    if (name.endsWith('.vue')) return {}
    throw Error(`Unexpected setup import ${name}`)
  }, browser).state)
  const handle = {
    canBackgroundExport: async () => true,
    exportFile: async () => ({ base64: 'TkVX', extension: helpers.defaultSaveExtension(state.active.value?.document.extension || 'docx'), dirty: false }),
    discardChanges: async options => { calls.push(['discard', options]) },
    markSaved: async () => { calls.push(['marked']) },
  }
  const rustWordHandle = Object.create(handle)
  const presentationHandle = Object.assign(Object.create(handle), {
    present: async startPage => { calls.push(['present',state.activeKey.value,startPage]) },
    stopPresentation: async () => { calls.push(['stop-presentation']) },
  })
  function attachHandles() {
    for(const entry of state.rustPdfEntries.value)if(!state.rustPdfHandles.has(entry.document.id))state.setRustPdfHandle(entry.document.id,Object.create(handle))
    for(const entry of state.rustWordEntries.value)if(!state.rustWordHandles.has(entry.document.id))state.setRustWordHandle(entry.document.id,rustWordHandle)
    for(const entry of state.rustSheetEntries.value)if(!state.rustSheetHandles.has(entry.document.id))state.setRustSheetHandle(entry.document.id,Object.create(handle))
    for(const entry of state.rustPresentationEntries.value)if(!state.rustPresentationHandles.has(entry.document.id))state.setRustPresentationHandle(entry.document.id,presentationHandle)
  }
  scope.run(()=>vue.watch([state.rustWordEntries,state.rustSheetEntries,state.rustPresentationEntries,state.rustPdfEntries],attachHandles,{flush:'sync'}))
  function tab(id, { ready = true, dirty = false, fileId = id, kind = 'word' } = {}) {
    const extension = {word:'docx',sheet:'xlsx',presentation:'pptx',pdf:'pdf'}[kind]
    state.tabs.value.push({ key: id, ready, dirty, fileId, document: { id, kind, extension,
      name: `${id}.${extension}`, base64: 'T0xE', sha256: 'old-hash', sizeBytes: 3 } })
    return state.tabs.value.at(-1)
  }
  function active(tab) {
    state.activeKey.value = tab.key
    const entries={word:state.rustWordEntries,sheet:state.rustSheetEntries,presentation:state.rustPresentationEntries,pdf:state.rustPdfEntries}[tab.document.kind]
    if(entries&&!entries.value.some(entry=>entry.document.id===tab.key))entries.value=[...entries.value,{document:tab.document}]
  }
  async function idle() {
    for (let n = 0; n < 50 && state.busy.value; n++) { await Promise.resolve(); await vue.nextTick() }
    assert.equal(state.busy.value, '', 'The shell task should finish')
  }
  return { state, native, calls, rustPreparations, sheetPreparations, deckPreparations, pdfPreparations, handle, presentationHandle, rustWordHandle, tab, active, idle, browser, observers, storage, windowListeners, documentListeners, mediaListeners, timers, intervals,
    setSystemDark(value) { media.matches = value; for (const listener of mediaListeners) listener({ matches: value }) },
    dispatchWindow(type, event) { for (const listener of windowListeners.get(type) ?? []) listener(event) },
    dispatchDocument(type, event) { for (const listener of documentListeners.get(type) ?? []) listener({...event,type}) },
    async fireTimeout(milliseconds) {
      const entry=[...timers].find(([,value])=>value.milliseconds===milliseconds)
      assert.ok(entry,`Expected a scheduled ${milliseconds}ms timer`)
      browser.clearTimeout(entry[0]);entry[1].callback(...entry[1].args)
      for(let n=0;n<30;n++){await Promise.resolve();await vue.nextTick()}
    },
    async mount() { for (const callback of mounted) await callback() },
    unmount() { for (const callback of beforeUnmount) callback(); scope.stop() },
  }
}

test('autosave directOnly refuses browser downloads, missing file capabilities and protected or import-only files before export', async () => {
  for (const scenario of ['browser','missing-file','protected-import','template','conversion']) {
    const h=shell({nativeEnabled:scenario!=='browser'})
    const kind=scenario==='template'?'presentation':scenario==='conversion'?'sheet':'word'
    const tab=h.tab('automatic',{dirty:true,kind});h.active(tab)
    const target={key:tab.key,fileId:tab.fileId}
    if(scenario==='missing-file')tab.fileId=undefined
    if(scenario==='protected-import')tab.requiresSaveAs=true
    if(scenario==='template')tab.document.extension='potx'
    if(scenario==='conversion')tab.document.extension='csv'
    let exports=0
    h.handle.exportFile=async()=>{exports++;throw Error('Ineligible autosave must not export')}
    assert.equal(await h.state.saveActive(false,undefined,undefined,target),false,scenario)
    assert.equal(exports,0,scenario)
    assert.equal(h.calls.filter(call=>['save','download','marked'].includes(call[0])).length,0,scenario)
    assert.equal(h.state.saveAsDraft.value,null,scenario)
    assert.equal(tab.dirty,true,scenario)
    h.unmount()
  }
})

test('autosave rejects an editor Save As request without invoking a dialog, download or saved receipt', async () => {
  const h=shell(),tab=h.tab('protected-pdf',{kind:'pdf',dirty:true});h.active(tab)
  h.handle.exportFile=async()=>({base64:'TkVX',extension:'pdf',saveAs:true,dirty:true})
  assert.equal(await h.state.saveActive(false,undefined,undefined,{key:tab.key,fileId:tab.fileId}),false)
  assert.equal(tab.fileId,'protected-pdf');assert.equal(tab.document.base64,'T0xE');assert.equal(tab.dirty,true)
  assert.equal(h.state.saveAsDraft.value,null)
  assert.equal(h.calls.filter(call=>['save','download','marked'].includes(call[0])).length,0)
  h.unmount()
})

test('autosave rechecks the selected native destination and protected state after an asynchronous export', async () => {
  for(const mutation of ['changed-file','lost-file','protected','format','active-tab']) {
    const h=shell(),tab=h.tab('automatic',{dirty:true,kind:'sheet'}),other=h.tab('other',{dirty:true,kind:'sheet'});h.active(tab)
    const target={key:tab.key,fileId:tab.fileId}
    let release
    h.handle.exportFile=()=>new Promise(resolve=>{release=resolve})
    const saving=h.state.saveActive(false,undefined,undefined,target)
    await settleWorkspaceShell()
    assert.equal(typeof release,'function')
    if(mutation==='changed-file')tab.fileId='different-approved-file'
    if(mutation==='lost-file')tab.fileId=undefined
    if(mutation==='protected')tab.requiresSaveAs=true
    if(mutation==='format')tab.document.extension='csv'
    if(mutation==='active-tab')h.active(other)
    release({base64:'TkVX',extension:'xlsx',dirty:true})
    if(mutation==='active-tab')await assert.rejects(saving,/文档已切换/)
    else assert.equal(await saving,false,mutation)
    assert.equal(h.calls.filter(call=>['save','download','marked'].includes(call[0])).length,0,mutation)
    assert.equal(tab.document.base64,'T0xE');assert.equal(tab.dirty,true);assert.equal(other.dirty,true)
    assert.equal(h.state.saveAsDraft.value,null)
    h.unmount()
  }
})

test('autosave writes only the selected local file and awaits acknowledgement of the exact exported bytes', async () => {
  const h=shell(),tab=h.tab('live-session',{dirty:true,fileId:'chosen-native-file'});h.active(tab)
  let releaseReceipt,receiptStarted
  const entered=new Promise(resolve=>{receiptStarted=resolve})
  const receipt=new Promise(resolve=>{releaseReceipt=resolve})
  h.handle.exportFile=async options=>{assert.equal(options.background,true);return{base64:'TkVX',extension:'docx',dirty:true}}
  h.handle.markSaved=async(bytes,options)=>{assert.equal(options.background,true);h.calls.push(['receipt',bytes]);receiptStarted();await receipt}
  const saving=h.state.saveActive(false,undefined,undefined,{key:tab.key,fileId:tab.fileId})
  await entered
  const writes=h.calls.filter(call=>call[0]==='save')
  assert.equal(writes.length,1)
  assert.deepEqual({...writes[0][1]},{documentId:'chosen-native-file',name:'live-session.docx',extension:'docx',base64:'TkVX',expectedSha256:'old-hash',saveAs:false})
  assert.equal(h.calls.find(call=>call[0]==='receipt')[1],'TkVX')
  assert.equal(tab.dirty,true,'A disk write alone must not clear unacknowledged editor changes')
  releaseReceipt();assert.equal(await saving,true)
  assert.equal(tab.fileId,'chosen-native-file');assert.equal(tab.document.id,'live-session')
  assert.equal(tab.document.base64,'TkVX');assert.equal(tab.document.sha256,'new-hash');assert.equal(tab.dirty,false)
  assert.equal(h.calls.some(call=>call[0]==='download'),false);assert.equal(h.state.saveAsDraft.value,null)
  h.unmount()
})

test('failed autosave receipts and native conflicts keep changes dirty and never fall back to Save As', async () => {
  for(const mode of ['receipt','conflict','cancelled']) {
    const h=shell(),tab=h.tab('automatic',{dirty:true});h.active(tab)
    if(mode==='receipt')h.handle.markSaved=async()=>{throw Error('Saved revision changed')}
    else h.native.saveDocument=async request=>{h.calls.push(['save',request]);return {status:mode,message:'File changed externally'}}
    const saving=h.state.saveActive(false,undefined,undefined,{key:tab.key,fileId:tab.fileId})
    if(mode==='receipt')await assert.rejects(saving,/Saved revision changed/)
    else assert.equal(await saving,false)
    assert.equal(tab.dirty,true);assert.equal(tab.fileId,'automatic')
    assert.equal(h.calls.filter(call=>call[0]==='save').length,1)
    assert.equal(h.calls.some(call=>call[0]==='download'),false);assert.equal(h.state.saveAsDraft.value,null)
    h.unmount()
  }
})

test('mounted shell runs the real autosave scheduler and releases input listeners and timers on unmount', async () => {
  const h=shell({storedAutosave:'true'}),tab=h.tab('scheduled',{dirty:true,fileId:'selected-local-file'});h.active(tab)
  await h.mount()
  assert.equal(h.state.autosaveEnabled.value,true)
  for(const event of ['input','keydown','pointerdown','compositionstart','compositionend'])assert.equal(h.documentListeners.get(event)?.size,1)
  await h.fireTimeout(30000)
  assert.equal(h.calls.filter(call=>call[0]==='save').length,1)
  assert.equal(h.calls.find(call=>call[0]==='save')[1].documentId,'selected-local-file')
  assert.equal(tab.dirty,false)
  h.state.autosaveEnabled.value=false;await vue.nextTick()
  assert.equal(h.storage.get('open-office-autosave'),'false')
  assert.equal([...h.timers.values()].filter(timer=>timer.milliseconds===30000).length,0)
  h.unmount()
  assert.equal(h.intervals.size,0)
  assert.equal([...h.documentListeners.values()].reduce((count,listeners)=>count+listeners.size,0),0)
})

function backgroundHandle(h,tab) {
  const handles={word:h.state.rustWordHandles,sheet:h.state.rustSheetHandles,
    presentation:h.state.rustPresentationHandles,pdf:h.state.rustPdfHandles}
  return handles[tab.document.kind].get(tab.key)
}

test('background operations fail closed for pending input and editors without a readiness method',async()=>{
  for(const kind of ['word','sheet','presentation','pdf'])for(const mode of ['pending','missing']) {
    const h=shell(),tab=h.tab(`background-${kind}`,{kind,dirty:true});h.active(tab)
    h.state.serverStatus.value.running=true
    const handle=backgroundHandle(h,tab)
    handle.canBackgroundExport=mode==='pending'?async()=>false:undefined
    let revisions=0,exports=0
    handle.syncRevision=async()=>{revisions++;throw Error('Pending input must not be flushed by a revision probe')}
    handle.exportFile=async()=>{exports++;throw Error('Pending input must not be committed by a snapshot')}
    try {
      assert.equal(await h.state.sharedRevision(tab.key),undefined,`${kind}/${mode}`)
      await assert.rejects(h.state.sharedSnapshot(tab.key),/确认当前输入/)
      assert.equal(await h.state.adoptShared(tab.key,{...sharedWordSnapshot(),kind,extension:tab.document.extension},'unchanged',()=>true),false)
      assert.equal(await h.state.saveActive(false,undefined,undefined,{key:tab.key,fileId:tab.fileId}),false)
      assert.equal(revisions,0);assert.equal(exports,0)
      assert.equal(h.calls.length,0,'No parse, file write, receipt, download or editor operation may start')
      assert.equal(h.state.tabs.value[0],tab);assert.equal(tab.dirty,true)
      assert.equal(h.state.syncApplying.value,false);assert.equal(h.state.stagedTab.value,undefined)
    } finally {h.unmount()}
  }
})

test('shared snapshots request atomic background export for every editor without blurring focused input',async()=>{
  for(const kind of ['word','sheet','presentation','pdf']) {
    const h=shell(),tab=h.tab(`snapshot-${kind}`,{kind,dirty:true});h.active(tab)
    const handle=backgroundHandle(h,tab)
    let blurCount=0,revisions=0,exports=0
    h.browser.document.activeElement=Object.assign(new h.browser.HTMLElement(),{blur(){blurCount++}})
    handle.syncRevision=async()=>{revisions++;return {documentId:7,revision:11}}
    handle.exportFile=async options=>{
      exports++;assert.equal(options.background,true);assert.equal(options.format,tab.document.extension)
      return {base64:'TkVX',extension:tab.document.extension,revision:'7:11',dirty:true}
    }
    try {
      const revision=await h.state.sharedRevision(tab.key)
      const snapshot=await h.state.sharedSnapshot(tab.key)
      assert.equal(snapshot.revision,revision);assert.equal(snapshot.base64,'TkVX')
      assert.equal(revisions,1);assert.equal(exports,1);assert.equal(blurCount,0)
      assert.equal(h.calls.length,0);assert.equal(tab.dirty,true)
    } finally {h.unmount()}
  }
})

test('a draft started during remote preparation prevents mounting or exporting the replacement',async()=>{
  let release,pending=false,exports=0
  const preparation=new Promise(resolve=>{release=resolve})
  const h=shell({rustPrepare:async()=>{await preparation;return {prepared:true}}})
  const original=h.tab('draft-during-prepare',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.canBackgroundExport=async()=>!pending
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  h.rustWordHandle.exportFile=async()=>{exports++;throw Error('A pending draft must not be exported')}
  const expectedRevision=await h.state.sharedRevision(original.key)
  try {
    const replacing=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true)
    await settleWorkspaceShell()
    assert.equal(h.calls.filter(call=>call[0]==='rust-preflight').length,1)
    pending=true;release()
    assert.equal(await replacing,false)
    assert.equal(exports,0);assert.equal(h.rustPreparations[0].discarded,1)
    assert.equal(h.state.tabs.value[0],original);assert.equal(h.state.activeKey.value,original.key)
    assert.equal(h.state.rustWordEntries.value.length,1);assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
    assert.equal(h.state.stagedTab.value,undefined);assert.equal(h.state.syncApplying.value,false)
  } finally {release();h.unmount()}
})

test('a draft started while a shared candidate initializes is rejected by the final atomic background export',async()=>{
  let release,pending=false,exports=0,candidateKey
  const inspection=new Promise(resolve=>{release=resolve})
  const h=shell(),original=h.tab('draft-during-mount',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.canBackgroundExport=async()=>!pending
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  h.rustWordHandle.exportFile=async options=>{
    exports++;assert.equal(options.background,true)
    if(pending)throw Error('Background export cannot commit the pending draft')
    return {base64:'T0xE',extension:'docx',revision:'1:1',dirty:true}
  }
  const expectedRevision=await h.state.sharedRevision(original.key)
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(!candidate||candidate.document.id===candidateKey)return
    candidateKey=candidate.document.id
    h.state.setRustWordHandle(candidateKey,{canBackgroundExport:async()=>true,
      inspect:async()=>{await inspection;return {documentId:2,revision:0}}})
    h.state.readyFor(candidateKey)
  },{flush:'sync'})
  try {
    const replacing=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true)
    const rejected=assert.rejects(replacing,/cannot commit the pending draft/)
    await settleWorkspaceShell();assert.ok(candidateKey);assert.equal(exports,1)
    pending=true;release();await rejected
    assert.equal(exports,2);assert.equal(h.state.tabs.value[0],original);assert.equal(original.dirty,true)
    assert.equal(h.state.activeKey.value,original.key);assert.equal(h.state.rustWordEntries.value.length,1)
    assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
    assert.equal(h.state.rustWordHandles.has(candidateKey),false)
    assert.equal(h.state.syncApplying.value,false);assert.equal(h.state.stagedTab.value,undefined)
  } finally {release();stop();h.unmount()}
})

test('autosave leaves unfinished input focused and retries only after explicit editor readiness',async()=>{
  for(const kind of ['word','sheet','presentation','pdf']) {
    const h=shell({storedAutosave:'true'}),tab=h.tab(`autosave-draft-${kind}`,{kind,dirty:true});h.active(tab)
    const handle=backgroundHandle(h,tab)
    let pending=true,blurCount=0,exports=0,receipts=0
    const focused=Object.assign(new h.browser.HTMLElement(),{blur(){blurCount++;pending=false}})
    h.browser.document.activeElement=focused
    handle.canBackgroundExport=async()=>!pending
    handle.exportFile=async options=>{
      assert.equal(options.background,true);assert.equal(pending,false);exports++
      return {base64:'TkVX',extension:tab.document.extension,dirty:true}
    }
    handle.markSaved=async(bytes,options)=>{assert.equal(bytes,'TkVX');assert.equal(options.background,true);receipts++}
    try {
      await h.mount();await h.fireTimeout(30000)
      assert.equal(blurCount,0);assert.equal(pending,true);assert.equal(exports,0);assert.equal(receipts,0)
      assert.equal(h.calls.filter(call=>call[0]==='save').length,0);assert.equal(tab.dirty,true)
      assert.equal(h.browser.document.activeElement,focused)
      pending=false;await h.fireTimeout(30000);await h.idle()
      assert.equal(blurCount,0);assert.equal(exports,1);assert.equal(receipts,1)
      assert.equal(h.calls.filter(call=>call[0]==='save').length,1);assert.equal(tab.dirty,false)
    } finally {h.unmount()}
  }
})

test('autosave input guards survive drafts arriving after eligibility or before a saved receipt',async()=>{
  for(const phase of ['before-export','atomic-export','receipt']) {
    const h=shell({storedAutosave:'true'}),tab=h.tab('late-draft',{kind:'sheet',dirty:true});h.active(tab)
    const handle=backgroundHandle(h,tab)
    let pending=false,gates=0,exports=0,receipts=0,blurCount=0
    h.browser.document.activeElement=Object.assign(new h.browser.HTMLElement(),{blur(){blurCount++}})
    handle.canBackgroundExport=async()=>{
      const ready=!pending
      if(++gates===(phase==='before-export'?1:phase==='atomic-export'?2:-1))pending=true
      return ready
    }
    handle.exportFile=async options=>{
      exports++;assert.equal(options.background,true)
      if(pending)throw Error('Draft arrived before atomic export')
      return {base64:'TkVX',extension:'xlsx',dirty:true}
    }
    handle.markSaved=async(_bytes,options)=>{
      receipts++;assert.equal(options.background,true)
      if(pending)throw Error('Draft arrived before saved receipt')
    }
    const save=h.native.saveDocument
    h.native.saveDocument=async request=>{const result=await save(request);pending=true;return result}
    try {
      await h.mount();await h.fireTimeout(30000);await h.idle();await settleWorkspaceShell()
      assert.equal(pending,true);assert.equal(blurCount,0);assert.equal(tab.dirty,true)
      assert.equal(exports,phase==='before-export'?0:1)
      assert.equal(receipts,phase==='receipt'?1:0)
      assert.equal(h.calls.filter(call=>call[0]==='save').length,phase==='receipt'?1:0)
      assert.equal(h.calls.some(call=>call[0]==='download'),false);assert.equal(h.state.saveAsDraft.value,null)
    } finally {h.unmount()}
  }
})

test('autosave keeps the editor interactive during a native write and rejects a stale receipt after new input',async()=>{
  const h=shell({storedAutosave:'true'}),tab=h.tab('typing-during-write',{kind:'sheet',dirty:true});h.active(tab);h.state.home.value=false
  const handle=backgroundHandle(h,tab),save=h.native.saveDocument
  let release,revision=1,exportedRevision,receiptAttempts=0,blurCount=0,writeStarted=false
  const diskWrite=new Promise(resolve=>{release=resolve})
  const focused=Object.assign(new h.browser.HTMLElement(),{blur(){blurCount++}})
  h.browser.document.activeElement=focused
  handle.exportFile=async options=>{
    assert.equal(options.background,true);exportedRevision=revision
    return {base64:'TkVX',extension:'xlsx',revision:`1:${revision}`,dirty:true}
  }
  h.native.saveDocument=async request=>{writeStarted=true;await diskWrite;return save(request)}
  handle.markSaved=async(bytes,options)=>{
    receiptAttempts++;assert.equal(bytes,'TkVX');assert.equal(options.background,true)
    if(revision!==exportedRevision)throw Error('The saved revision predates the latest input')
  }
  try {
    await h.mount();await h.fireTimeout(30000)
    assert.equal(writeStarted,true);assert.equal(h.state.backgroundSaving.value,true)
    assert.ok(h.state.busy.value);assert.equal(h.state.globalActionsBlocked.value,true)
    assert.equal(h.state.documentActionsDisabled.value,true);assert.equal(h.state.editorInputBlocked.value,false)
    assert.equal(h.browser.document.activeElement,focused);assert.equal(blurCount,0)
    for(const [name,value] of [['help',true],['serverPanel',true],['syncApplying',true],['closeTarget',tab],['saveAsDraft',{key:tab.key}]]) {
      const previous=h.state[name].value
      h.state[name].value=value;assert.equal(h.state.editorInputBlocked.value,true,`${name} must still block editor input`)
      h.state[name].value=previous;assert.equal(h.state.editorInputBlocked.value,false)
    }
    revision++;h.state.dirtyFor(tab.key,true)
    release();await settleWorkspaceShell();await h.idle();await settleWorkspaceShell()
    assert.equal(h.calls.filter(call=>call[0]==='save').length,1);assert.equal(receiptAttempts,1)
    assert.equal(tab.dirty,true,'Writing an older snapshot must not erase newly typed changes')
    assert.equal(h.state.backgroundSaving.value,false);assert.equal(h.state.busy.value,'')
    assert.equal(h.state.globalActionsBlocked.value,false);assert.equal(h.state.editorInputBlocked.value,false)
    assert.equal(h.browser.document.activeElement,focused);assert.equal(blurCount,0)
  } finally {release();h.unmount()}
})

test('editor input and global file controls bind to separate barriers throughout the rendered shell',()=>{
  const template=appSource.match(/<template>([\s\S]*?)<\/template>\s*<style/)[1]
  const elements=[],parents=new Map()
  function visit(node,parent) {
    if(node.type===1){elements.push(node);parents.set(node,parent);parent=node}
    for(const child of node.children??[])visit(child,parent)
  }
  visit(baseParse(template),undefined)
  const attribute=(node,name)=>node.props.find(prop=>prop.type===6&&prop.name===name)?.value?.content
  const binding=(node,name)=>node.props.find(prop=>prop.type===7&&prop.name==='bind'&&prop.arg?.content===name)?.exp?.content
  const byClass=name=>elements.find(node=>attribute(node,'class')?.split(/\s+/).includes(name))
  assert.equal(binding(byClass('editor-workspace'),'inert'),'editorInputBlocked')
  assert.equal(binding(byClass('editor-content'),'inert'),'editorInputBlocked')
  assert.equal(binding(byClass('tab-bar'),'inert'),'globalActionsBlocked')
  assert.equal(binding(elements.find(node=>attribute(node,'data-testid')==='global-toolbar'),'inert'),'globalActionsBlocked')
  for(const tag of ['RustWordEditor','RustSheetEditor','RustPresentationEditor','RustPdfEditor']) {
    const editor=elements.find(node=>node.tag===tag)
    assert.equal(binding(editor,'disabled'),'editorInputBlocked',tag)
    for(let ancestor=parents.get(editor);ancestor;ancestor=parents.get(ancestor)) {
      const inert=binding(ancestor,'inert')
      if(inert!==undefined)assert.equal(inert,'editorInputBlocked',`${tag} must have no blocking ancestor during autosave`)
    }
  }
  const overlay=byClass('busy-overlay')
  assert.equal(overlay.props.find(prop=>prop.type===7&&prop.name==='if')?.exp?.content.replace(/\s+/g,''),'busy&&!backgroundSaving')
})

test('save-as rejects invalid names and stale targets before export; same-format success marks the saved document',async()=>{
  const h=shell(),a=h.tab('a',{dirty:true}),b=h.tab('b',{});h.active(a)
  let exports=0
  h.handle.exportFile=async({format})=>{exports++;return{base64:'TkVX',extension:format,dirty:true}}
  h.state.openSaveAs();h.state.saveAsDraft.value.name='../file'
  await h.state.confirmSaveAs();assert.equal(exports,0);assert.match(h.state.saveAsDraft.value.error,/文件名/)
  h.state.saveAsDraft.value.name='Safe';h.active(b)
  await h.state.confirmSaveAs();assert.equal(exports,0);assert.match(h.state.saveAsDraft.value.error,/切换/)
  h.state.cancelSaveAs();h.active(a);h.state.openSaveAs();h.state.saveAsDraft.value.name='Renamed'
  await h.state.confirmSaveAs()
  assert.equal(exports,1);assert.equal(h.state.saveAsDraft.value,null);assert.equal(a.dirty,false)
  assert.equal(a.document.name,'Renamed.docx');assert.ok(h.calls.some(c=>c[0]==='marked'))
  h.handle.exportFile=async()=>({base64:'TkVX',extension:'docx',name:'a.docx',dirty:true})
  await h.state.saveActive()
  assert.equal(h.calls.filter(c=>c[0]==='save').at(-1)[1].name,'Renamed.docx','Later exports retain the chosen filename instead of the stale editor import name')
})

test('save-as preserves its form and dirty state after a native conflict or export format mismatch',async()=>{
  const h=shell(),a=h.tab('a',{dirty:true});h.active(a)
  h.state.openSaveAs()
  h.handle.exportFile=async()=>({base64:'TkVX',extension:'pdf',dirty:true})
  await h.state.confirmSaveAs()
  assert.match(h.state.saveAsDraft.value.error,/格式.*不一致/);assert.equal(a.dirty,true)
  assert.ok(!h.calls.some(c=>c[0]==='save'))
  h.handle.exportFile=async()=>({base64:'TkVX',extension:'docx',dirty:true})
  h.native.saveDocument=async()=>({status:'conflict',message:'File changed'})
  await h.state.confirmSaveAs()
  assert.match(h.state.saveAsDraft.value.error,/File changed/);assert.equal(a.dirty,true)
})

test('tab overflow follows the active tab and disconnects its observer on unmount', async () => {
  const h = shell({nativeEnabled:false})
  let bounds = { left: 260, right: 360 }
  const bar = vue.markRaw({ clientWidth: 300, scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 10, right: 310 }),
    querySelector(selector) {
      assert.equal(selector, '.document-tab.active')
      return { getBoundingClientRect: () => bounds }
    },
  })
  h.state.tabBar.value = bar
  await h.mount()
  assert.equal(h.observers.length, 1)
  assert.equal(h.observers[0].targets.has(bar), true)
  h.observers[0].notify()
  assert.equal(bar.scrollLeft, 0, 'Home does not scroll the document tabs')
  h.state.home.value = false
  await vue.nextTick()
  assert.equal(bar.scrollLeft, 50, 'Opening a document reveals its right edge')
  bounds = { left: -20, right: 80 }
  h.state.activeKey.value = 'another-tab'
  await vue.nextTick()
  assert.equal(bar.scrollLeft, 20, 'Changing tabs reveals its left edge')
  bounds = { left: 250, right: 350 }
  h.observers[0].notify()
  assert.equal(bar.scrollLeft, 60, 'A resize keeps the active tab visible')
  h.unmount()
  assert.equal(h.observers[0].disconnected, true)
  assert.equal(h.observers[0].targets.size, 0)
})

test('real dialog focus helper cycles keyboard focus and restores its trigger on unmount', async () => {
  const h = shell(), listeners = new Map()
  function element(extra = {}) {
    return vue.markRaw(Object.assign(new h.browser.HTMLElement(), {
      tabIndex: 0, isConnected: true,
      focus() { h.browser.document.activeElement = this },
      matches: () => false, closest: () => null, getClientRects: () => [{}],
    }, extra))
  }
  const trigger = element(), first = element(), last = element()
  const dialog = element({
    querySelectorAll: () => [first, last],
    contains: node => node === dialog || node === first || node === last,
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type) },
  })
  trigger.focus()
  h.state.helpDialog.value = dialog
  await vue.nextTick()
  assert.equal(h.browser.document.activeElement, first)
  for (const [shiftKey, target] of [[true, last], [false, first]]) {
    let prevented = false
    listeners.get('keydown')({ key: 'Tab', shiftKey, defaultPrevented: false, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(h.browser.document.activeElement, target)
  }
  h.unmount()
  assert.equal(listeners.size, 0)
  assert.equal(h.browser.document.activeElement, trigger)
  h.state.closeDialog.value = dialog
  await vue.nextTick()
  assert.equal(listeners.size, 0, 'Unmounted dialog watchers no longer attach keyboard handlers')
})

test('native smoke URL reports failure even if Tauri injection is absent', async () => {
  const h=shell({nativeEnabled:false,smoke:true})
  await h.mount()
  assert.match(h.state.error.value,/no Tauri IPC/)
  assert.ok(h.calls.some(call=>call[0]==='smoke-failure'&&call[1]==='app-startup'))
})

test('Word smoke cannot start when the process has not enabled smoke mode', async () => {
  for(const scope of ['full']) for(const requested of [false,true]) {
    const h=shell({smoke:requested})
    h.native.bootstrap=async()=>({smokeMode:false,smokeScope:scope})
    await h.mount()
    assert.ok(!h.calls.some(call=>call[0]==='office-word-native-smoke'||call[0]==='office-sheet-native-smoke'||call[0]==='office-presentation-native-smoke'||call[0]==='invoke'))
    assert.equal(h.state.tabs.value.length,0)
    if(requested)assert.match(h.state.error.value,/not enabled by the process/)
    else assert.equal(h.state.error.value,'')
    h.unmount()
  }
})

test('full native smoke awaits the default OfficeWord gate before starting the presentation gate', async () => {
  let release, started
  const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve})
  const h=shell({smoke:true,wordSmokeRun:async()=>{started();return gate}})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  const mounting=h.mount()
  await entered
  assert.ok(!h.calls.some(call=>call[0]==='office-sheet-native-smoke'))

  assert.ok(!h.calls.some(call=>call[0]==='invoke'&&call[1]==='smoke_report'))
  const word={schemaVersion:1,ok:false,engine:'office-word-wasm',error:'controlled default OfficeWord failure'}
  release(word)
  await mounting
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
  assert.equal(report.word,word);assert.equal(report.ok,false)
  assert.match(report.error,/controlled default OfficeWord failure/)
  assert.equal(h.state.tabs.value.length,0)
  h.unmount()
})

test('full native smoke reports OfficeWord cleanup and thrown failures without starting the next editor', async () => {
  for(const mode of ['cleanup','thrown']) {
    const word={schemaVersion:1,ok:false,engine:'office-word-wasm',closeError:'controlled OfficeWord cleanup failure'}
    const h=shell({smoke:true,...(mode==='thrown'?{wordSmokeError:'controlled OfficeWord thrown failure'}:{wordSmokeReport:word})})
    h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
    await h.mount()
    const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
    assert.equal(report.ok,false);assert.match(report.error,/controlled OfficeWord/)
    assert.equal(h.state.tabs.value.length,0)
    if(mode==='cleanup')assert.equal(report.word,word)
    else assert.equal(report.word,undefined)
    h.unmount()
  }
})

test('native smoke startup IPC rejection reaches the HTTP failure fallback', async () => {
  const h=shell({smoke:true})
  h.native.onCloseRequested=async()=>{throw Error('Event capability denied')}
  await h.mount()
  assert.match(h.state.error.value,/capability denied/)
  assert.ok(h.calls.some(call=>call[0]==='smoke-failure'&&call[2].includes('capability denied')))
  const normal=shell({smoke:false})
  normal.native.bootstrap=async()=>{throw Error('Failed normal startup')}
  await normal.mount()
  assert.ok(!normal.calls.some(call=>call[0]==='smoke-failure'),'Normal mode must not emit smoke reports')
})

test('not-ready and failed documents cannot export or overwrite the old loaded model', async () => {
  const h = shell(), a = h.tab('A', { ready: false }); h.active(a)
  let exported = 0; h.handle.exportFile = async () => { exported++; return { base64: 'wrong', extension: 'docx' } }
  await assert.rejects(h.state.saveActive(), /仍在打开/)
  h.state.editorError('A', 'Cannot load A')
  await assert.rejects(h.state.saveActive(), /未成功打开/)
  assert.equal(exported, 0); assert.equal(h.calls.length, 0)
  const b = h.tab('B',{}); await h.state.activate(b)
  assert.equal(h.state.activeKey.value, 'B', 'A failed tab must not trap the user')
})

test('switching snapshots authoritative dirty state even before a dirty event arrives', async () => {
  const h = shell(), a = h.tab('A',{}), b = h.tab('B',{}); h.active(a)
  h.handle.exportFile = async () => ({ base64: 'RURJVA==', extension: 'docx', dirty: true })
  await h.state.activate(b)
  assert.equal(a.document.base64, 'RURJVA=='); assert.equal(a.dirty, true)
  assert.equal(h.state.activeKey.value, 'B'); assert.equal(b.ready, false)
  assert.equal(h.calls[0][0], 'discard')
})

test('revision mismatch or pending PDF edits reject switching without replacing snapshots', async () => {
  for (const pending of [false, true]) {
    const h = shell(), a = h.tab('A',{}), b = h.tab('B',{}); h.active(a)
    if (pending) h.handle.exportFile = async () => { throw Error('Apply pending PDF edits') }
    else h.handle.discardChanges = async () => { throw Error('Revision changed') }
    await assert.rejects(h.state.activate(b), pending ? /pending PDF/ : /Revision/)
    assert.equal(h.state.activeKey.value, 'A'); assert.equal(a.document.base64, 'T0xE')
  }
})

test('cancelled save and external conflict preserve dirty state and original identity', async () => {
  for (const result of [{ status: 'cancelled' }, { status: 'conflict', message: 'External change' }]) {
    const h = shell(), a = h.tab('A', { dirty: true }); h.active(a)
    h.native.saveDocument = async () => result
    assert.equal(await h.state.saveActive(), false)
    assert.equal(a.dirty, true); assert.equal(a.fileId, 'A'); assert.equal(a.document.sha256, 'old-hash')
    assert.ok(!h.calls.some(call => call[0] === 'marked'))
  }
})

test('reopening an already-open file retains its in-memory edits', async () => {
  const h = shell(), a = h.tab('A', { dirty: true }); h.active(a)
  await h.state.addDocument({ ...a.document, base64: 'disk-version' }, 'A')
  assert.equal(h.state.tabs.value.length, 1); assert.equal(a.document.base64, 'T0xE'); assert.equal(a.dirty, true)
})

test('a nominally clean tab with un-applied draft requires close confirmation', async () => {
  const h = shell(), a = h.tab('A', { kind: 'pdf' }); h.active(a)
  h.handle.exportFile = async () => { throw Error('Unapplied draft') }
  h.state.closeTab(a); await h.idle()
  assert.equal(h.state.tabs.value.length, 1); assert.equal(h.state.closeTarget.value.key, 'A')
  assert.equal(a.dirty, true)
  h.state.closeTarget.value = null // the actual Cancel button's action
  assert.equal(h.state.tabs.value.length, 1); assert.ok(!h.calls.some(call => call[0] === 'discard'))
})

test('save-and-close of a background tab waits for its own editor to become ready', async () => {
  const h = shell(), a = h.tab('A',{}), b = h.tab('B', { dirty: true }); h.active(a)
  h.state.closeTarget.value = b
  const closing = h.state.resolveClose('save')
  for (let n = 0; n < 15 && h.state.activeKey.value !== 'B'; n++) { await Promise.resolve(); await vue.nextTick() }
  assert.equal(h.state.activeKey.value, 'B'); assert.equal(b.ready, false)
  assert.ok(!h.calls.some(call => call[0] === 'save'), 'Never save the previous loaded editor')
  h.state.readyFor('B'); await closing
  assert.equal(h.calls.find(call => call[0] === 'save')[1].documentId, 'B')
  assert.ok(!h.state.tabs.value.some(tab => tab.key === 'B')); assert.equal(h.state.activeKey.value, 'A')
})

test('cancel during save-all keeps the window and unsaved tabs open', async () => {
  const h = shell(), a = h.tab('A', { dirty: true }); h.active(a)
  h.native.saveDocument = async () => ({ status: 'cancelled' })
  h.state.closeTarget.value = 'window'; await h.state.resolveClose('save')
  assert.equal(h.state.closeTarget.value, 'window'); assert.equal(a.dirty, true)
  assert.ok(!h.calls.some(call => call[0] === 'close'))
})

test('window close during a task is deferred once, without recursive checks', async () => {
  const h = shell()
  let release; const gate = new Promise(resolve => { release = resolve })
  const task = h.state.task('working', () => gate)
  await h.state.closeWindow(); assert.equal(h.calls.length, 0)
  release(); await task; await h.idle()
  assert.equal(h.calls.filter(call => call[0] === 'close').length, 1)
})

test('editor transaction blocks overlapping work and propagates errors while releasing the input barrier', async () => {
  const h=shell();let finish,worked=false
  const gate=new Promise(resolve=>{finish=resolve})
  const work=h.state.editorTransaction('saving',async()=>{worked=true;await gate;throw Error('Revision changed')})
  assert.equal(worked,false,'Work must wait for Vue to render the inert region')
  for(let n=0;n<10&&!worked;n++)await Promise.resolve()
  assert.equal(h.state.busy.value,'saving');assert.equal(worked,true)
  await assert.rejects(h.state.editorTransaction('another',async()=>assert.fail('Overlapping work must be blocked')),/另一项/)
  finish();await assert.rejects(work,/Revision changed/)
  assert.equal(h.state.busy.value,'')
})

test('native helper export uses the same guarded transaction and never swallows a failed discard', async()=>{
  const h=shell()
  let called=false
  h.handle.command=function(input){called=true;assert.equal(this,h.handle);assert.equal(h.state.busy.value,'');return input}
  h.handle.exportFile=async()=>{assert.equal(h.state.busy.value.length>0,true);return {base64:'snapshot',extension:'docx',revision:7}}
  const nativeEditor=h.state.nativeTransactionalEditor(h.handle)
  const intent={type:'apply-style',expectedRevision:3}
  assert.equal(nativeEditor.command(intent),intent)
  assert.equal(called,true,'Captured edit intents must forward synchronously without a new render/focus await')
  assert.equal((await nativeEditor.exportFile()).revision,7)
  assert.equal(h.state.busy.value,'')
  const a=h.tab('A',{}),b=h.tab('B',{});h.active(a)
  h.handle.discardChanges=async()=>{assert.equal(h.state.busy.value.length>0,true);throw Error('Revision changed')}
  await assert.rejects(h.state.editorTransaction('switching',()=>h.state.activate(b)),/Revision changed/)
  assert.equal(h.state.activeKey.value,'A');assert.equal(a.document.base64,'T0xE')
  assert.equal(h.state.busy.value,'')
  await h.state.task('switching',()=>h.state.activate(b))
  assert.match(h.state.error.value,/Revision changed/)
  assert.equal(h.state.activeKey.value,'A')
})

test('presentation PDF export stays a copy and never replaces the editable PPTX tab', async () => {
  for(const format of ['pdf']){
  const h=shell(), a=h.tab('deck',{kind:'presentation',dirty:true});h.active(a)
  h.handle.exportFile=async({format}={})=>({base64:'UFBUWA==',extension:format||'pptx',dirty:true})
  await h.state.saveActive(true,format)
  const request=h.calls.find(call=>call[0]==='save')[1]
  assert.equal(request.name,`deck.${format}`);assert.equal(request.documentId,undefined)
  assert.equal(a.document.kind,'presentation');assert.equal(a.document.extension,'pptx')
  assert.equal(a.fileId,'deck');assert.equal(a.dirty,true)
  assert.ok(!h.calls.some(call=>call[0]==='marked'))
  }
})

test('presentation rejects unsupported ODP export before invoking an editor or file dialog', async () => {
  const h=shell(),a=h.tab('deck',{kind:'presentation',dirty:true});h.active(a)
  let exports=0;h.presentationHandle.exportFile=async()=>{exports++;return {base64:'UNSUPPORTED',extension:'odp'}}
  await assert.rejects(h.state.saveActive(true,'odp'),/PPTX|支持/)
  assert.equal(exports,0);assert.equal(a.document.extension,'pptx');assert.equal(a.dirty,true)
  assert.ok(!h.calls.some(call=>call[0]==='save'))
})

test('native clean notifications never clear a tab with unsaved user content', () => {
  const h = shell(), tab = h.tab('A', { dirty: true })
  h.state.tabs.value = [tab]; h.state.activeKey.value = 'A'
  h.state.dirtyFor('A', false)
  assert.equal(tab.dirty, true)
  tab.dirty = false
  h.state.dirtyFor('A', true)
  assert.equal(tab.dirty, true)
})

function rustSource(id='source') {
  return {id,kind:'word',extension:'docx',name:`${id}.docx`,base64:'T0xE',sha256:'source-hash',sizeBytes:3}
}

function browserWordInput() {
  const bytes=zipSync({'word/document.xml':strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>')})
  return {value:'Browser.docx',files:[{name:'Browser.docx',size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}
}

test('successful Rust preparation precedes snapshot/discard/publication and captures immutable source bytes',async()=>{
  let finish
  const h=shell({rustPrepare:()=>new Promise(resolve=>{finish=resolve})}),tab=h.tab('live',{dirty:true});h.active(tab)
  h.handle.exportFile=async()=>{h.calls.push(['export-current']);return{base64:'RURJVA==',extension:'docx',dirty:true}}
  const source=rustSource('incoming'),opening=h.state.addDocument(source,source.id)
  await Promise.resolve()
  assert.equal(h.state.activeKey.value,tab.key);assert.equal(h.state.tabs.value.length,1)
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'rust-preflight');assert.equal(tab.document.base64,'T0xE')
  source.base64='TkVX';finish({testRustSession:'incoming'});await opening
  const next=h.state.active.value
  assert.deepEqual(h.calls.map(c=>c[0]),['rust-preflight','rust-prepared','export-current','discard'])
  assert.equal(tab.document.base64,'RURJVA==');assert.equal(tab.dirty,true)
  assert.equal(next.document.base64,'T0xE');assert.notEqual(next.key,tab.key)
  assert.equal(h.state.rustWordEntries.value.length,2);assert.equal(h.state.rustWordEntries.value[1].prepared,h.rustPreparations[0].handoff)
  assert.equal(h.state.rustWordEntries.value.at(-1).prepared.take(next.document),h.rustPreparations[0].session)
  assert.equal(h.state.rustWordEntries.value.at(-1).prepared.take(next.document),undefined)
  h.unmount()
})

test('failed snapshot and disposal release an undelivered Rust preparation without publishing a tab',async()=>{
  const h=shell(),tab=h.tab('typing',{dirty:true});h.active(tab)
  h.handle.exportFile=async()=>{throw Error('Composition pending')}
  await assert.rejects(h.state.addDocument(rustSource('new'),'new'),/Composition pending/)
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key)
  assert.equal(tab.document.base64,'T0xE');assert.equal(tab.dirty,true)
  assert.equal(h.rustPreparations[0].discarded,1)
  assert.equal(h.rustPreparations[0].handoff.take(h.rustPreparations[0].source),undefined)
  h.unmount()
  let finish
  const disposed=shell({rustPrepare:()=>new Promise(resolve=>{finish=resolve})})
  const opening=disposed.state.addDocument(rustSource('late'),'late')
  await Promise.resolve();disposed.unmount();finish({testRustSession:'late'});await opening
  assert.equal(disposed.state.tabs.value.length,0);assert.equal(disposed.state.rustWordEntries.value.length,0)
  assert.equal(disposed.rustPreparations[0].discarded,1)
  assert.equal(disposed.rustPreparations[0].handoff.take(disposed.rustPreparations[0].source),undefined)
})

test('OfficeWord offers DOCX and PDF and protects imported identity until a DOCX copy succeeds',async()=>{
  const h=shell();await h.state.addDocument(rustSource('original'),'original')
  const tab=h.state.active.value;h.state.readyFor(tab.key);tab.dirty=true
  let exports=0
  h.rustWordHandle.exportFile=async()=>{exports++;return{base64:'UlVTVA==',extension:'docx',dirty:true}}
  h.state.openSaveAs();assert.deepEqual(Array.from(h.state.saveAsOptions.value,o=>o.extension),['docx','pdf'])
  await assert.rejects(h.state.saveActive(true,'odt'),/不支持此保存格式/)
  h.state.saveAsDraft.value.format='odt';await h.state.confirmSaveAs();assert.match(h.state.saveAsDraft.value.error,/支持的格式/)
  assert.equal(exports,0);assert.ok(!h.calls.some(c=>c[0]==='save'));h.state.cancelSaveAs()
  const save=h.native.saveDocument
  h.native.saveDocument=async request=>{h.calls.push(['cancelled-rust-save',request]);return{status:'cancelled'}}
  assert.equal(await h.state.saveActive(),false)
  assert.equal(tab.dirty,true);assert.equal(tab.requiresSaveAs,true);assert.equal(tab.fileId,'original');assert.equal(tab.document.sha256,'source-hash')
  assert.ok(!h.calls.some(c=>c[0]==='marked'))
  h.native.saveDocument=save;assert.equal(await h.state.saveActive(),true)
  for(const request of h.calls.filter(c=>['save','cancelled-rust-save'].includes(c[0])).map(c=>c[1])){
    assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined);assert.equal(request.saveAs,true)
    assert.equal(request.name,'original - 副本.docx')
  }
  assert.notEqual(tab.fileId,'original');assert.equal(tab.requiresSaveAs,false);assert.equal(tab.dirty,false)
  assert.ok(h.calls.some(c=>c[0]==='marked'))
  h.unmount()
})

test('OfficeWord PDF export routes through its editor and never saves or replaces the imported DOCX',async()=>{
  const h=shell();await h.state.addDocument(rustSource('original'),'original')
  const tab=h.state.active.value;h.state.readyFor(tab.key);tab.dirty=true
  const before=JSON.stringify(tab),entry=h.state.rustWordEntries.value[0],formats=[]
  h.handle.exportFile=async()=>assert.fail('OfficeWord PDF must not export through the PDF editor')
  h.rustWordHandle.exportFile=async({format})=>{formats.push(format);return{base64:'JVBERi0xLjc=',extension:'pdf',dirty:true}}
  h.rustWordHandle.markSaved=async()=>assert.fail('A PDF copy must not mark the editable DOCX as saved')
  const save=h.native.saveDocument
  h.native.saveDocument=async request=>{h.calls.push(['cancelled-pdf-save',request]);return{status:'cancelled'}}
  assert.equal(await h.state.saveActive(true,'pdf'),false)
  assert.equal(JSON.stringify(tab),before)
  h.native.saveDocument=save
  assert.equal(await h.state.saveActive(true,'pdf'),true)
  assert.equal(JSON.stringify(tab),before,'PDF success retains the DOCX bytes, dirty flag, original identity and import safeguards')
  assert.equal(h.state.rustWordEntries.value[0],entry)
  assert.deepEqual(formats,['pdf','pdf'])
  const saves=h.calls.filter(c=>['save','cancelled-pdf-save'].includes(c[0]))
  assert.equal(saves.length,2)
  for(const [,request] of saves){
    assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined);assert.equal(request.saveAs,true)
    assert.equal(request.extension,'pdf');assert.equal(request.name,'original - 副本.pdf');assert.equal(request.base64,'JVBERi0xLjc=')
  }
  assert.ok(!h.calls.some(c=>c[0]==='marked'))
  h.unmount()
})

test('Rust tab switches preserve each mounted entry and use the matching editor handle',async()=>{
  const h=shell(),exported=[],discarded=[]
  const mountHandle=tab=>{
    const handle={canBackgroundExport:async()=>true,exportFile:async()=>{exported.push(tab.key);return{base64:Buffer.from(tab.key).toString('base64'),extension:'docx',dirty:true}},discardChanges:async()=>{discarded.push(tab.key)}}
    h.state.setRustWordHandle(tab.key,handle);h.state.readyFor(tab.key);return handle
  }
  await h.state.addDocument(rustSource('first'),'first');const first=h.state.active.value;mountHandle(first)
  const firstEntry=h.state.rustWordEntries.value[0]
  await h.state.addDocument(rustSource('second'),'second');const second=h.state.active.value;mountHandle(second)
  const secondEntry=h.state.rustWordEntries.value[1]
  const pdf=h.tab('pdf',{kind:'pdf'})
  h.handle.exportFile=async()=>({base64:'UERGOg==',extension:'pdf'})
  await h.state.activate(pdf);h.state.readyFor(pdf.key);await h.state.activate(first);await h.state.activate(second)
  assert.equal(first.ready,true);assert.equal(second.ready,true)
  assert.equal(h.state.rustWordEntries.value[0],firstEntry);assert.equal(h.state.rustWordEntries.value[1],secondEntry)
  assert.equal(firstEntry.document.base64,'T0xE','The mounted component input must not be replaced by snapshots')
  assert.equal(secondEntry.document.base64,'T0xE')
  assert.deepEqual(exported,[first.key,second.key,first.key]);assert.deepEqual(discarded,exported)
  assert.equal(first.document.base64,Buffer.from(first.key).toString('base64'))
  assert.equal(second.document.base64,Buffer.from(second.key).toString('base64'))
  assert.equal(h.rustPreparations.length,2);assert.ok(h.rustPreparations.every(p=>p.discarded===0))
  h.state.closeTarget.value=second;await h.state.resolveClose('discard')
  assert.equal(h.state.rustWordEntries.value.length,1);assert.equal(h.state.rustWordEntries.value[0],firstEntry)
  assert.equal(h.rustPreparations[1].discarded,1);assert.equal(h.rustPreparations[0].discarded,0)
  h.unmount();assert.equal(h.rustPreparations[0].discarded,1)
})

test('a failed Rust saved-revision acknowledgement cannot mark the shell tab clean',async()=>{
  const h=shell(),tab=h.tab('editing',{dirty:true});h.active(tab)
  h.rustWordHandle.exportFile=async()=>({base64:'UlVTVA==',extension:'docx',dirty:true})
  h.rustWordHandle.markSaved=async()=>{throw Error('Saved revision is stale')}
  await assert.rejects(h.state.saveActive(),/Saved revision is stale/)
  assert.equal(h.calls.filter(c=>c[0]==='save').length,1,'The disk write succeeded but its revision could not be acknowledged')
  assert.equal(tab.dirty,true,'Unacknowledged in-memory content must still prompt before closing')
  assert.equal(h.state.activeKey.value,tab.key)
  h.unmount()
})

function sheetSource(id='source',extension='xlsx') {
  return {id,kind:'sheet',extension,name:`${id}.${extension}`,base64:'T0xE',sha256:'source-hash',sizeBytes:3}
}

function mountSheetHandle(h,tab,overrides={}) {
  const handle={canBackgroundExport:async()=>true,exportFile:async({format})=>({base64:'U0hFRVQ=',extension:format,dirty:true}),
    discardChanges:async options=>{h.calls.push(['sheet-discard',tab.key,options])},
    markSaved:async bytes=>{h.calls.push(['sheet-marked',tab.key,bytes])},...overrides}
  h.state.setRustSheetHandle(tab.key,handle);h.state.readyFor(tab.key)
  return handle
}

test('global file controls ignore a hidden home document and retain generic Open and New', async () => {
  const h=shell(), word=h.tab('hidden-word',{dirty:true})
  h.active(word)
  h.rustWordHandle.exportFile=async()=>assert.fail('Home must not save its retained hidden document')
  h.rustWordHandle.undo=async()=>assert.fail('Home must not edit its retained hidden document')
  assert.equal(h.state.active.value.key,word.key)
  assert.equal(h.state.currentDocument.value,undefined)
  assert.equal(h.state.documentActionsDisabled.value,true)
  for(const action of ['save','saveAs','exportPdf','print','undo','redo'])h.state.globalFileAction(action)
  h.state.keydown({key:'s',ctrlKey:true,preventDefault(){}})
  await h.idle()
  assert.equal(h.state.saveAsDraft.value,null)
  assert.equal(word.dirty,true)
  assert.equal(h.calls.filter(call=>call[0]==='save').length,0)
  const openArguments=[]
  h.native.openDocument=async(...args)=>{openArguments.push(args);return null}
  h.state.globalFileAction('open');await h.idle()
  assert.deepEqual(openArguments,[[]],'Global Open is not restricted by the retained Word tab')
  // Creating another tab legitimately snapshots the retained editor, but must
  // not acknowledge that snapshot as an on-disk save.
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',dirty:true})
  h.state.globalNewDocument('sheet');await h.idle()
  assert.equal(h.state.home.value,false)
  assert.equal(h.state.currentDocument.value.document.kind,'sheet')
  assert.equal(h.state.documentActionsDisabled.value,true,'New editor must be ready before document actions enable')
  h.unmount()
})

test('global save and undo use only the visible active editor and respect the transaction barrier', async () => {
  const h=shell(), word=h.tab('word',{dirty:true}), sheet=h.tab('sheet',{kind:'sheet',dirty:true})
  const operations=[]
  h.rustWordHandle.exportFile=async()=>{operations.push('word-save');return{base64:'V09SRA==',extension:'docx',dirty:true}}
  h.rustWordHandle.undo=async()=>{operations.push('word-undo')}
  mountSheetHandle(h,sheet,{exportFile:async()=>{operations.push('sheet-save');return{base64:'U0hFRVQ=',extension:'xlsx',dirty:true}},undo:async()=>{operations.push('sheet-undo')}})
  h.active(sheet);h.state.home.value=false
  assert.equal(h.state.documentActionsDisabled.value,false)
  h.state.globalFileAction('save');await h.idle()
  assert.deepEqual(operations,['sheet-save']);assert.equal(sheet.dirty,false);assert.equal(word.dirty,true)
  h.state.globalFileAction('undo');await h.idle()
  h.active(word)
  h.state.globalFileAction('save');await h.idle()
  assert.deepEqual(operations,['sheet-save','sheet-undo','word-save'])
  assert.equal(h.calls.filter(call=>call[0]==='save').at(-1)[1].documentId,'word')
  h.state.openSaveAs()
  assert.equal(h.state.globalActionsBlocked.value,true)
  h.state.globalFileAction('undo');h.state.globalFileAction('open');h.state.globalNewDocument('sheet')
  assert.deepEqual(operations,['sheet-save','sheet-undo','word-save'])
  assert.equal(h.state.tabs.value.length,2)
  h.state.cancelSaveAs()
  h.state.busy.value='Controlled pending transaction'
  h.state.globalFileAction('save')
  assert.deepEqual(operations,['sheet-save','sheet-undo','word-save'])
  h.state.busy.value=''
  h.unmount()
})

test('Rust canvas shortcuts stay engine-owned while header shortcuts dispatch one active-document action', async () => {
  const h=shell(), sheet=h.tab('sheet-shortcut',{kind:'sheet',dirty:true})
  mountSheetHandle(h,sheet);h.active(sheet);h.state.home.value=false
  const editorTarget=Object.assign(new h.browser.Element(),{closest:()=>({})})
  let prevented=0
  h.state.keydown({key:'s',ctrlKey:true,target:editorTarget,preventDefault(){prevented++}})
  await h.idle()
  assert.equal(prevented,0);assert.equal(h.calls.filter(call=>call[0]==='save').length,0)
  const headerTarget=Object.assign(new h.browser.Element(),{closest:()=>null})
  h.state.keydown({key:'s',ctrlKey:true,target:headerTarget,preventDefault(){prevented++}})
  await h.idle()
  assert.equal(prevented,1);assert.equal(h.calls.filter(call=>call[0]==='save').length,1)
  const requests=[];h.native.openDocument=async(...args)=>{requests.push(args);return null}
  h.state.keydown({key:'o',ctrlKey:true,target:headerTarget,preventDefault(){}});await h.idle()
  assert.deepEqual(requests,[[]],'Header Ctrl+O uses the generic picker even for an active Rust spreadsheet')
  h.unmount()
})

test('real appearance hook persists explicit themes, follows system only in auto mode and does not edit documents', () => {
  const h=shell({storedAppearance:'dark',systemDark:false}), word=h.tab('theme-word',{dirty:true})
  h.active(word);h.state.home.value=false
  const initialCalls=h.calls.length
  assert.equal(h.state.appearance.value,'dark')
  assert.deepEqual(h.browser.document.documentElement.dataset,{theme:'dark',themePreference:'dark'})
  h.setSystemDark(true);h.state.appearance.value='light'
  assert.equal(h.browser.document.documentElement.dataset.theme,'light')
  assert.equal(h.storage.get('open-office.appearance'),'light')
  h.state.appearance.value='system'
  assert.equal(h.browser.document.documentElement.dataset.theme,'dark')
  h.setSystemDark(false)
  assert.equal(h.browser.document.documentElement.dataset.theme,'light')
  h.dispatchWindow('storage',{key:'open-office.appearance',newValue:'dark'})
  assert.equal(h.state.appearance.value,'dark')
  assert.equal(h.browser.document.documentElement.dataset.theme,'dark')
  h.dispatchWindow('storage',{key:'open-office.appearance',newValue:'invalid'})
  assert.equal(h.state.appearance.value,'system')
  assert.equal(word.dirty,true);assert.equal(word.document.base64,'T0xE');assert.equal(h.calls.length,initialCalls)
  assert.equal(h.mediaListeners.size,1)
  h.unmount()
  assert.equal(h.mediaListeners.size,0)
  assert.equal(h.windowListeners.get('storage').size,0)
})

test('appearance remains usable when storage is unavailable and invalid stored values follow the system', () => {
  const invalid=shell({storedAppearance:'unexpected',systemDark:true})
  assert.equal(invalid.state.appearance.value,'system')
  assert.equal(invalid.browser.document.documentElement.dataset.theme,'dark')
  invalid.unmount()
  const h=shell({storageUnavailable:true})
  assert.doesNotThrow(()=>{h.state.appearance.value='dark'})
  assert.equal(h.browser.document.documentElement.dataset.theme,'dark')
  h.unmount()
})

test('default spreadsheet new/save uses its own prepared Rust session and editor handle',async()=>{
  const h=shell()
  h.handle.exportFile=async()=>assert.fail('Default sheets must not export through the the presentation gate editor')
  h.rustWordHandle.exportFile=async()=>assert.fail('Default sheets must not export through the Word editor')
  h.state.newDocument('sheet');await h.idle()
  const tab=h.state.active.value,entry=h.state.rustSheetEntries.value[0],prepared=h.sheetPreparations[0]
  assert.equal(tab.document.extension,'xlsx')
  assert.equal(h.state.rustWordEntries.value.length,0)
  assert.equal(h.sheetPreparations.length,1);assert.equal(prepared.source.base64,'');assert.equal(prepared.source.id,tab.key)
  assert.equal(entry.prepared.take(tab.document),prepared.session);assert.equal(entry.prepared.take(tab.document),undefined)
  mountSheetHandle(h,tab)
  h.state.openSaveAs();assert.deepEqual(Array.from(h.state.saveAsOptions.value,o=>o.extension),['xlsx','csv','tsv','pdf']);h.state.cancelSaveAs()
  assert.equal(await h.state.saveActive(),true)
  assert.equal(tab.dirty,false);assert.equal(tab.document.base64,'U0hFRVQ=')
  assert.deepEqual(h.calls.filter(c=>c[0]==='sheet-marked'),[['sheet-marked',tab.key,'U0hFRVQ=']])
  h.unmount()
})

for(const route of ['native','recent','browser'])test(`generic ${route} XLSX opening uses Rust warnings and requires a protected first save`,async()=>{
  const warning='Controlled parser warning: unsupported chart detail'
  const h=shell({nativeEnabled:route!=='browser',sheetWarnings:[warning]}),source=sheetSource(route)
  if(route==='native'){h.native.openDocument=async()=>source;h.state.openFile();await h.idle()}
  else if(route==='recent'){h.native.openRecent=async id=>{assert.equal(id,'recent');return source};h.state.openRecent({id:'recent'});await h.idle()}
  else {
    const bytes=zipSync({"xl/workbook.xml":strToU8("<workbook/>")}),input={value:'Source.xlsx',files:[{name:'Source.xlsx',size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}
    await h.state.browserFile({target:input});assert.equal(input.value,'')
  }
  const tab=h.state.active.value
  assert.equal(tab.requiresSaveAs,true)
  assert.equal(h.sheetPreparations.length,1);assert.equal(h.sheetPreparations[0].source.id,tab.key)
  assert.equal(h.sheetPreparations[0].source.base64,tab.document.base64)
  assert.equal(tab.importWarnings.at(-1),warning)
  assert.equal(h.rustPreparations.length,0)
  h.unmount()
})

test('failed spreadsheet preparation leaves the active dirty document and engine untouched',async()=>{
  const h=shell({sheetPrepareError:'Malformed workbook package'}),tab=h.tab('live',{dirty:true});h.active(tab)
  const before=JSON.stringify(tab),live=h.state.rustWordEntries.value[0]
  h.handle.exportFile=async()=>assert.fail('Rejected spreadsheet must not snapshot the current document')
  await assert.rejects(h.state.addDocument(sheetSource('bad'),'bad'),/Malformed workbook package/)
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key)
  assert.equal(JSON.stringify(tab),before);assert.equal(h.state.rustWordEntries.value[0],live)
  assert.equal(h.state.rustSheetEntries.value.length,0)
  h.unmount()
})

test('unpublished spreadsheet candidates are discarded after blocked switching and app disposal',async()=>{
  const h=shell(),tab=h.tab('typing',{dirty:true});h.active(tab)
  h.handle.exportFile=async()=>{throw Error('Composition pending')}
  await assert.rejects(h.state.addDocument(sheetSource('new'),'new'),/Composition pending/)
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key)
  assert.equal(h.sheetPreparations[0].discarded,1);assert.equal(h.state.rustSheetEntries.value.length,0)
  h.unmount()
  let finish
  const disposed=shell({sheetPrepare:()=>new Promise(resolve=>{finish=resolve})})
  const opening=disposed.state.addDocument(sheetSource('late'),'late');await Promise.resolve()
  disposed.unmount();finish({testSheetSession:'late'});await opening
  assert.equal(disposed.state.tabs.value.length,0);assert.equal(disposed.state.rustSheetEntries.value.length,0)
  assert.equal(disposed.sheetPreparations[0].discarded,1)
})

test('spreadsheet imports protect their original identity until XLSX save succeeds',async()=>{
  const h=shell();await h.state.addDocument(sheetSource('original'),'original')
  const tab=h.state.active.value;mountSheetHandle(h,tab);tab.dirty=true
  const save=h.native.saveDocument
  h.native.saveDocument=async request=>{h.calls.push(['cancelled-sheet-save',request]);return{status:'cancelled'}}
  assert.equal(await h.state.saveActive(),false)
  assert.equal(tab.dirty,true);assert.equal(tab.requiresSaveAs,true);assert.equal(tab.fileId,'original')
  assert.ok(!h.calls.some(c=>c[0]==='sheet-marked'))
  h.native.saveDocument=save;assert.equal(await h.state.saveActive(),true)
  for(const [,request] of h.calls.filter(c=>['save','cancelled-sheet-save'].includes(c[0]))) {
    assert.equal(request.saveAs,true);assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined)
    assert.equal(request.name,'original - 副本.xlsx')
  }
  assert.notEqual(tab.fileId,'original');assert.equal(tab.requiresSaveAs,false);assert.equal(tab.dirty,false)
  assert.equal(h.calls.filter(c=>c[0]==='sheet-marked').length,1)
  h.unmount()
})

for(const format of ['csv','tsv','pdf'])test(`${format} spreadsheet exports preserve editable workbook identity, warnings and unsaved changes`,async()=>{
  const h=shell();await h.state.addDocument(sheetSource('original'),'original')
  const tab=h.state.active.value;tab.dirty=true
  mountSheetHandle(h,tab,{markSaved:async()=>assert.fail('A data/PDF export must not mark the workbook saved')})
  const before=JSON.stringify(tab),entry=h.state.rustSheetEntries.value[0]
  assert.equal(await h.state.saveActive(true,format),true)
  assert.equal(JSON.stringify(tab),before);assert.equal(h.state.rustSheetEntries.value[0],entry)
  const request=h.calls.find(c=>c[0]==='save')[1]
  assert.equal(request.extension,format);assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined);assert.equal(request.saveAs,true)
  h.unmount()
})

test('retained spreadsheet tabs use their own handles and only a closed tab releases its preparation',async()=>{
  const h=shell(),exports=[]
  await h.state.addDocument(sheetSource('first'),'first');const first=h.state.active.value
  mountSheetHandle(h,first,{exportFile:async()=>{exports.push(first.key);return{base64:'RklSU1Q=',extension:'xlsx',dirty:true}}})
  const firstEntry=h.state.rustSheetEntries.value[0]
  await h.state.addDocument(sheetSource('second'),'second');const second=h.state.active.value
  mountSheetHandle(h,second,{exportFile:async()=>{exports.push(second.key);return{base64:'U0VDT05E',extension:'xlsx',dirty:true}}})
  const secondEntry=h.state.rustSheetEntries.value[1]
  await h.state.activate(first);await h.state.activate(second)
  assert.deepEqual(exports,[first.key,second.key,first.key])
  assert.equal(h.state.rustSheetEntries.value[0],firstEntry);assert.equal(h.state.rustSheetEntries.value[1],secondEntry)
  assert.equal(firstEntry.document.base64,'T0xE');assert.equal(secondEntry.document.base64,'T0xE')
  assert.equal(first.ready,true);assert.equal(second.ready,true);assert.equal(h.sheetPreparations.length,2)
  h.native.saveDocument=async()=>({status:'cancelled'})
  h.state.closeTarget.value=second;await h.state.resolveClose('save')
  assert.equal(h.state.rustSheetEntries.value.length,2);assert.equal(h.sheetPreparations[1].discarded,0)
  assert.equal(h.state.closeTarget.value,second,'Cancelling the save leaves the unsaved close decision pending')
  h.state.closeTarget.value=second;await h.state.resolveClose('discard')
  assert.equal(h.state.rustSheetEntries.value.length,1);assert.equal(h.state.rustSheetEntries.value[0],firstEntry)
  assert.equal(h.sheetPreparations[1].discarded,1);assert.equal(h.sheetPreparations[0].discarded,0)
  h.unmount();assert.equal(h.sheetPreparations[0].discarded,1)
})

test('a rejected spreadsheet saved-revision acknowledgement leaves the tab dirty',async()=>{
  const h=shell(),tab=h.tab('editing',{kind:'sheet',dirty:true});h.active(tab)
  mountSheetHandle(h,tab,{markSaved:async()=>{throw Error('Spreadsheet saved revision is stale')}})
  await assert.rejects(h.state.saveActive(),/saved revision is stale/)
  assert.equal(h.calls.filter(c=>c[0]==='save').length,1);assert.equal(tab.dirty,true)
  assert.equal(h.state.activeKey.value,tab.key)
  h.unmount()
})

test('full native smoke awaits the default spreadsheet gate before the presentation gate',async()=>{
  let release,started
  const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve})
  const h=shell({smoke:true,sheetSmokeRun:async()=>{started();return gate}})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  const mounting=h.mount();await entered
  assert.ok(h.calls.some(c=>c[0]==='office-word-native-smoke'))
  assert.ok(!h.calls.some(c=>c[0]==='invoke'&&c[1]==='smoke_report'))
  const sheet={schemaVersion:1,ok:false,engine:'office-sheet-wasm',error:'controlled OfficeSheet failure'}
  release(sheet);await mounting
  const report=h.calls.find(c=>c[0]==='invoke'&&c[1]==='smoke_report')[2].report
  assert.equal(report.sheet,sheet);assert.equal(report.ok,false);assert.match(report.error,/controlled OfficeSheet/)
  assert.equal(h.state.tabs.value.length,0)
  h.unmount()
})

test('full native smoke propagates spreadsheet cleanup and thrown failures without starting the next editor',async()=>{
  for(const mode of ['cleanup','thrown']) {
    const sheet={schemaVersion:1,ok:false,engine:'office-sheet-wasm',closeError:'controlled OfficeSheet cleanup failure'}
    const h=shell({smoke:true,...(mode==='thrown'?{sheetSmokeError:'controlled OfficeSheet thrown failure'}:{sheetSmokeReport:sheet})})
    h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
    const report=h.calls.find(c=>c[0]==='invoke'&&c[1]==='smoke_report')[2].report
    assert.equal(report.ok,false);assert.match(report.error,/controlled OfficeSheet/)
    assert.equal(h.state.tabs.value.length,0)
    if(mode==='cleanup')assert.equal(report.sheet,sheet)
    else assert.equal(report.sheet,undefined)
    h.unmount()
  }
})

function deckSource(id='deck',extension='pptx') {
  return {id,kind:'presentation',extension,name:`${id}.${extension}`,base64:'T0xE',sha256:'source-hash',sizeBytes:3}
}
function mountDeckHandle(h,tab,overrides={}) {
  const handle={
    canBackgroundExport:async()=>true,
    exportFile:async({format})=>({base64:'REVDSw==',extension:format,dirty:true}),
    discardChanges:async options=>{h.calls.push(['deck-discard',tab.key,options])},
    markSaved:async bytes=>{h.calls.push(['deck-marked',tab.key,bytes])},
    present:async index=>{h.calls.push(['deck-present',tab.key,index])},
    stopPresentation:async()=>{h.calls.push(['deck-stop',tab.key])},...overrides,
  }
  h.state.setRustPresentationHandle(tab.key,handle);h.state.readyFor(tab.key)
  return handle
}

test('default Word and presentation creation prepare their own empty Rust sessions',async()=>{
  for(const [kind,entriesName,preparationsName,extension] of [['word','rustWordEntries','rustPreparations','docx'],['presentation','rustPresentationEntries','deckPreparations','pptx']]) {
    const h=shell();h.state.newDocument(kind);await h.idle()
    const tab=h.state.active.value,entry=h.state[entriesName].value[0],prepared=h[preparationsName][0]
    assert.equal(tab.document.kind,kind);assert.equal(tab.document.extension,extension)
    assert.equal(tab.ready,false);assert.equal(tab.dirty,true)
    assert.equal(h[preparationsName].length,1);assert.equal(prepared.source.base64,'');assert.equal(prepared.source.id,tab.key)
    assert.equal(entry.prepared.take(tab.document),prepared.session);assert.equal(entry.prepared.take(tab.document),undefined)
    h.state.readyFor(tab.key)
    if(kind==='presentation')mountDeckHandle(h,tab)
    assert.equal(await h.state.saveActive(),true);assert.equal(tab.dirty,false)
    h.unmount()
  }
})

for(const extension of ['pptx','potx','ppsx'])for(const route of ['native','recent','browser'])test(`${route} ${extension} imports prepare a presentation session and protect the source`,async()=>{
  const h=shell({nativeEnabled:route!=='browser'}),source=deckSource('Original',extension)
  if(route==='native'){h.native.openDocument=async()=>source;h.state.openFile();await h.idle()}
  else if(route==='recent'){h.native.openRecent=async()=>source;h.state.openRecent({id:'recent'});await h.idle()}
  else {
    const bytes=zipSync({'ppt/presentation.xml':strToU8('<presentation/>')})
    const input={value:source.name,files:[{name:source.name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}
    await h.state.browserFile({target:input});assert.equal(input.value,'')
  }
  const tab=h.state.active.value,entry=h.state.rustPresentationEntries.value[0]
  assert.equal(tab.document.kind,'presentation');assert.equal(tab.document.extension,extension)
  assert.equal(tab.requiresSaveAs,true);assert.equal(h.deckPreparations.length,1)
  assert.equal(entry.prepared,h.deckPreparations[0].handoff)
  assert.equal(h.deckPreparations[0].source.id,tab.key);assert.equal(h.deckPreparations[0].source.base64,tab.document.base64)
  assert.equal(h.rustPreparations.length,0);assert.equal(h.sheetPreparations.length,0)
  mountDeckHandle(h,tab);h.state.openSaveAs()
  assert.deepEqual(Array.from(h.state.saveAsOptions.value,option=>option.extension),['pptx','pdf'])
  assert.equal(h.state.saveAsDraft.value.format,'pptx')
  h.state.cancelSaveAs();assert.equal(await h.state.saveActive(),true)
  if(route==='browser')assert.equal(h.calls.find(call=>call[0]==='download')[1],'Original - 副本.pptx')
  else {
    const request=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(request.name,'Original - 副本.pptx');assert.equal(request.extension,'pptx')
    assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined);assert.equal(request.saveAs,true)
  }
  assert.equal(tab.document.extension,'pptx');assert.equal(tab.dirty,false);assert.equal(tab.requiresSaveAs,false)
  h.unmount()
})

for(const [extension,kind] of [['doc','word'],['rtf','word'],['odt','word'],['xls','sheet'],['ods','sheet'],['ppt','presentation'],['odp','presentation']])test(`removed ${extension} entrypoints fail before preflight or changes to a live document`,async()=>{
  const h=shell(),tab=h.tab('live',{dirty:true});h.active(tab)
  h.rustWordHandle.exportFile=async()=>assert.fail('Unsupported formats must not snapshot the live document')
  const before=JSON.stringify(tab),entry=h.state.rustWordEntries.value[0]
  await assert.rejects(h.state.addDocument({id:'source',kind,extension,name:`Old.${extension}`,base64:'SOURCE',sha256:'hash',sizeBytes:6},'source'),/请选择/)
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key);assert.equal(JSON.stringify(tab),before)
  assert.equal(h.state.rustWordEntries.value[0],entry);assert.equal(h.calls.length,0)
  h.unmount()
})

test('mismatched document metadata is rejected before allocating any session',async()=>{
  for(const source of [{...rustSource(),kind:'presentation'},{...deckSource(),extension:'pptx',name:'Disguised.pdf'}]) {
    const h=shell();await assert.rejects(h.state.addDocument(source),/不一致/)
    assert.equal(h.calls.length,0);assert.equal(h.state.tabs.value.length,0);h.unmount()
  }
})

test('failed presentation preparation preserves the active document and never falls back',async()=>{
  const h=shell({deckPrepareError:'Malformed presentation package'}),tab=h.tab('live',{dirty:true});h.active(tab)
  h.rustWordHandle.exportFile=async()=>assert.fail('Failed preflight must not snapshot the live document')
  const before=JSON.stringify(tab),entry=h.state.rustWordEntries.value[0]
  await assert.rejects(h.state.addDocument(deckSource(),'deck'),/Malformed presentation/)
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key);assert.equal(JSON.stringify(tab),before)
  assert.equal(h.state.rustWordEntries.value[0],entry);assert.equal(h.state.rustPresentationEntries.value.length,0)
  assert.deepEqual(h.calls.map(call=>call[0]),['deck-preflight']);h.unmount()
})

test('presentation preparations capture source bytes and are discarded if snapshot or disposal prevents publication',async()=>{
  const h=shell(),tab=h.tab('live',{dirty:true});h.active(tab)
  h.rustWordHandle.exportFile=async()=>{throw Error('Composition pending')}
  await assert.rejects(h.state.addDocument(deckSource(),'deck'),/Composition pending/)
  assert.equal(h.deckPreparations[0].discarded,1);assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key)
  h.unmount()
  let release
  const disposed=shell({deckPrepare:()=>new Promise(resolve=>{release=resolve})})
  const source=deckSource(),opening=disposed.state.addDocument(source,'deck');await Promise.resolve()
  source.base64='TkVX';disposed.unmount();release({session:'pending'});await opening
  assert.equal(disposed.deckPreparations[0].source.base64,'T0xE')
  assert.equal(disposed.deckPreparations[0].discarded,1);assert.equal(disposed.state.tabs.value.length,0)
})

test('presentation tabs keep separate mounted models, undo handles and saved receipts across tab switches',async()=>{
  const h=shell(),exports=[],undo=[]
  await h.state.addDocument(deckSource('first'),'first');const first=h.state.active.value
  mountDeckHandle(h,first,{exportFile:async()=>{exports.push(first.key);return{base64:'RklSU1Q=',extension:'pptx',dirty:true}},undo:async()=>{undo.push(first.key)}})
  const firstEntry=h.state.rustPresentationEntries.value[0]
  await h.state.addDocument(deckSource('second'),'second');const second=h.state.active.value
  mountDeckHandle(h,second,{exportFile:async()=>{exports.push(second.key);return{base64:'U0VDT05E',extension:'pptx',dirty:true}},undo:async()=>{undo.push(second.key)}})
  const secondEntry=h.state.rustPresentationEntries.value[1]
  await h.state.activate(first);await h.state.activate(second)
  h.state.globalFileAction('undo');await h.idle()
  assert.deepEqual(undo,[second.key]);assert.deepEqual(exports,[first.key,second.key,first.key])
  assert.equal(first.ready,true);assert.equal(second.ready,true)
  assert.equal(firstEntry,h.state.rustPresentationEntries.value[0]);assert.equal(secondEntry,h.state.rustPresentationEntries.value[1])
  assert.equal(firstEntry.document.base64,'T0xE');assert.equal(secondEntry.document.base64,'T0xE')
  h.native.saveDocument=async()=>({status:'cancelled'})
  h.state.closeTarget.value=second;await h.state.resolveClose('save')
  assert.equal(h.state.closeTarget.value,second);assert.equal(h.state.rustPresentationEntries.value.length,2);assert.equal(h.deckPreparations[1].discarded,0)
  h.state.closeTarget.value=second;await h.state.resolveClose('discard')
  assert.equal(h.state.rustPresentationEntries.value.length,1);assert.equal(h.state.rustPresentationEntries.value[0],firstEntry)
  assert.equal(h.state.rustPresentationHandles.has(second.key),false);assert.equal(h.deckPreparations[1].discarded,1)
  assert.equal(h.deckPreparations[0].discarded,0)
  h.unmount();assert.equal(h.deckPreparations[0].discarded,1)
})

test('background presentation close releases only that session and keeps the active PDF intact',async()=>{
  const h=shell();await h.state.addDocument(deckSource(),'deck');const deck=h.state.active.value;mountDeckHandle(h,deck)
  const pdf=h.tab('pdf',{kind:'pdf'});await h.state.activate(pdf);h.state.readyFor(pdf.key)
  const before=h.state.rustPdfEntries.value[0]
  await h.state.removeTab(deck,true)
  assert.equal(h.state.activeKey.value,pdf.key);assert.equal(h.state.rustPdfEntries.value[0],before)
  assert.equal(h.state.rustPresentationEntries.value.length,0);assert.equal(h.state.rustPresentationHandles.size,0)
  assert.equal(h.deckPreparations[0].discarded,1);h.unmount()
})

test('presentation save revision failures and pending edits preserve dirty state and prevent switching',async()=>{
  const h=shell(),deck=h.tab('deck',{kind:'presentation',dirty:true}),word=h.tab('word');h.active(deck)
  const handle=mountDeckHandle(h,deck,{markSaved:async()=>{throw Error('Saved revision is stale')}})
  await assert.rejects(h.state.saveActive(),/Saved revision/);assert.equal(deck.dirty,true)
  handle.exportFile=async()=>{throw Error('Apply the pending slide text')}
  await assert.rejects(h.state.activate(word),/pending slide/)
  assert.equal(h.state.activeKey.value,deck.key);assert.equal(h.state.rustPresentationEntries.value.length,1)
  h.unmount()
})

test('F5 starts the active presentation once and native close stops it before the unsaved dialog',async()=>{
  const h=shell(),deck=h.tab('deck',{kind:'presentation',dirty:true});h.active(deck);h.state.home.value=false
  mountDeckHandle(h,deck);let prevented=0
  h.state.keydown({key:'F5',preventDefault(){prevented++}});await h.idle()
  assert.equal(prevented,1);assert.deepEqual(h.calls.filter(call=>call[0]==='deck-present'),[['deck-present',deck.key,0]])
  await h.state.closeWindow()
  assert.ok(h.calls.some(call=>call[0]==='deck-stop'));assert.equal(h.state.closeTarget.value,'window')
  assert.ok(!h.calls.some(call=>call[0]==='close'));h.unmount()
})

test('full native smoke requires all four mounted Rust editors and actual workspace persistence gates',async()=>{
  const h=shell({smoke:true});h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,true);assert.equal(report.word.ok,true);assert.equal(report.sheet.ok,true);assert.equal(report.presentation.ok,true)
  assert.equal(report.pdf.reopened,true);assert.equal(report.pdf.removedOldText,true);assert.equal(report.pdf.newTextPresent,true);assert.equal(report.workspace.ok,true)
  assert.deepEqual(h.calls.filter(call=>call[0].endsWith('-native-smoke')).map(call=>call[0]),['office-word-native-smoke','office-sheet-native-smoke','office-presentation-native-smoke','pdf-native-smoke','workspace-native-smoke'])
  const fixtures=h.calls.find(call=>call[0]==='workspace-native-smoke')[1]
  assert.deepEqual({...fixtures},{xlsx:report.sheet.reopenedXlsxBase64,pptx:report.presentation.reopenedPptxBase64,pdf:report.pdf.reopenedPdfBase64})
  assert.equal(report.pdf.engine,'office-pdf-wasm')
  for(const old of ['office','independentWordPackage','rustWordEngine','wordWorkbench','sheetWorkbench','presentationWorkbench'])assert.equal(Object.hasOwn(report,old),false)
  h.unmount()
})

for(const mode of ['report','throw'])test(`failed workspace ${mode} prevents a full native release pass after editor verification`,async()=>{
  const h=shell({smoke:true,...(mode==='report'?{workspaceSmokeReport:{ok:false,error:'Controlled workspace failure'}}:{workspaceSmokeError:'Controlled workspace failure'})})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,/Controlled workspace failure/)
  assert.equal(report.word.ok,true);assert.equal(report.sheet.ok,true);assert.equal(report.presentation.ok,true);assert.equal(report.pdf.ok,true)
  assert.equal(h.calls.filter(call=>call[0]==='workspace-native-smoke').length,1)
  if(mode==='report')assert.equal(report.workspace.ok,false)
  h.unmount()
})

test('full native smoke refuses to run workspace verification without the actual reopened editor fixtures',async()=>{
  const h=shell({smoke:true,sheetSmokeReport:{ok:true,engine:'office-sheet-wasm'}})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,/workspace fixtures are missing/)
  assert.equal(report.workspace,undefined);assert.ok(!h.calls.some(call=>call[0]==='workspace-native-smoke'))
  h.unmount()
})

for(const mode of ['report','throw'])test(`failed presentation ${mode} fails native release evidence before PDF verification`,async()=>{
  const h=shell({smoke:true,...(mode==='report'?{presentationSmokeReport:{ok:false,error:'Controlled deck failure'}}:{presentationSmokeError:'Controlled deck failure'})})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,/Controlled deck failure/)
  assert.ok(!h.calls.some(call=>call[0]==='pdf-native-smoke'));h.unmount()
})


test('a mismatched snapshot format cannot replace a live tab during switching',async()=>{
  const h=shell(),first=h.tab('first',{dirty:true}),second=h.tab('second');h.active(first)
  h.rustWordHandle.exportFile=async()=>({base64:'JVBERg==',extension:'pdf',dirty:true})
  await assert.rejects(h.state.activate(second),/快照格式/)
  assert.equal(first.document.extension,'docx');assert.equal(first.document.base64,'T0xE');assert.equal(h.state.activeKey.value,first.key)
  assert.ok(!h.calls.some(call=>call[0]==='discard'));h.unmount()
})

test('presentation parser warnings accompany protected imports and F5 is blocked behind shell dialogs',async()=>{
  const warning='Controlled unsupported animation detail',h=shell({deckWarnings:[warning]})
  await h.state.addDocument(deckSource(),'deck');const tab=h.state.active.value;mountDeckHandle(h,tab)
  assert.equal(tab.importWarnings.at(-1),warning)
  h.state.openSaveAs();let prevented=0
  h.state.keydown({key:'F5',preventDefault(){prevented++}});await h.idle()
  assert.equal(prevented,1);assert.ok(!h.calls.some(call=>call[0]==='deck-present'))
  h.unmount()
})


test('presentation canvas owns F5 while shell controls dispatch the show command',async()=>{
  const h=shell(),tab=h.tab('deck',{kind:'presentation'});h.active(tab);h.state.home.value=false;mountDeckHandle(h,tab)
  let prevented=0
  const target=Object.assign(new h.browser.Element(),{closest:()=>({})})
  h.state.keydown({key:'F5',target,preventDefault(){prevented++}});await h.idle()
  assert.equal(prevented,0);assert.ok(!h.calls.some(call=>call[0]==='deck-present'))
  h.state.keydown({key:'F5',target:Object.assign(new h.browser.Element(),{closest:()=>null}),preventDefault(){prevented++}});await h.idle()
  assert.equal(prevented,1);assert.equal(h.calls.filter(call=>call[0]==='deck-present').length,1);h.unmount()
})


const pdfSource = (id='imported-pdf') => ({id,kind:'pdf',extension:'pdf',name:`${id}.pdf`,base64:'JVBERi0xLjc=',sha256:'source-hash',sizeBytes:8})
test('failed PDF preflight leaves the active edited model and every tab intact',async()=>{
  const h=shell({pdfPrepareError:'Malformed PDF'}),tab=h.tab('live',{dirty:true});h.active(tab)
  h.rustWordHandle.exportFile=async()=>assert.fail('Failed PDF preflight must not snapshot the live editor')
  const before=JSON.stringify(tab),entry=h.state.rustWordEntries.value[0]
  await assert.rejects(h.state.addDocument(pdfSource(),'pdf'),/Malformed PDF/)
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key);assert.equal(JSON.stringify(tab),before)
  assert.equal(h.state.rustWordEntries.value[0],entry);assert.equal(h.state.rustPdfEntries.value.length,0)
  assert.deepEqual(h.calls.map(call=>call[0]),['pdf-preflight']);h.unmount()
})
test('PDF tab switches retain each live model, handle and save protection',async()=>{
  const h=shell(),exported=[],undone=[]
  async function opened(id){
    await h.state.addDocument(pdfSource(id),id)
    const tab=h.state.active.value
    h.state.setRustPdfHandle(tab.key,{exportFile:async()=>{exported.push(id);return{base64:btoa(id),extension:'pdf',dirty:true}},discardChanges:async()=>{},undo:async()=>undone.push(id)})
    h.state.readyFor(tab.key)
    return tab
  }
  const first=await opened('first'),firstEntry=h.state.rustPdfEntries.value[0]
  const second=await opened('second'),secondEntry=h.state.rustPdfEntries.value[1]
  await h.state.activate(first);await h.state.activate(second)
  h.state.globalFileAction('undo');await h.idle()
  assert.deepEqual(exported,['first','second','first']);assert.deepEqual(undone,['second'])
  assert.equal(first.ready,true);assert.equal(second.ready,true)
  assert.equal(first.requiresSaveAs,true);assert.equal(second.requiresSaveAs,true)
  assert.equal(h.state.rustPdfEntries.value[0],firstEntry);assert.equal(h.state.rustPdfEntries.value[1],secondEntry)
  await h.state.removeTab(first,true)
  assert.equal(h.state.activeKey.value,second.key);assert.equal(h.state.rustPdfEntries.value[0],secondEntry)
  assert.equal(h.state.rustPdfHandles.has(first.key),false);assert.equal(h.pdfPreparations[0].discarded,1)
  h.unmount();assert.equal(h.pdfPreparations[1].discarded,1)
})
for(const mode of ['report','throw'])test(`failed PDF ${mode} prevents successful native release evidence`,async()=>{
  const h=shell({smoke:true,...(mode==='report'?{pdfSmokeReport:{ok:false,error:'Controlled PDF failure'}}:{pdfSmokeError:'Controlled PDF failure'})})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,/Controlled PDF failure/)
  h.unmount()
})

test('confirmed PDF close waits for draft release before activating the surviving tab',async()=>{
  const h=shell(),first=h.tab('discarded',{kind:'pdf',dirty:true}),second=h.tab('survivor',{kind:'pdf'})
  h.active(second);h.active(first);h.state.home.value=false
  let release,closed=false
  const barrier=new Promise(resolve=>{release=resolve})
  h.state.setRustPdfHandle(first.key,{discardChanges:async options=>{
    assert.equal(options.force,true)
    await barrier
    closed=true
  }})
  const stop=vue.watch(h.state.activeKey,key=>{
    if(key===second.key)assert.equal(closed,true,'The discarded input must be released before the next canvas attaches')
  },{flush:'sync'})
  h.state.closeTab(first)
  assert.equal(h.state.closeTarget.value,first)
  const closing=h.state.resolveClose('discard')
  await vue.nextTick()
  assert.equal(h.state.activeKey.value,first.key)
  assert.equal(h.state.tabs.value.length,2)
  release();await closing
  assert.equal(h.state.activeKey.value,second.key)
  assert.equal(h.state.tabs.value.length,1)
  assert.equal(h.state.rustPdfHandles.has(first.key),false)
  assert.equal(h.state.rustPdfHandles.has(second.key),true)
  stop();h.unmount()
})

const sharedWordSnapshot = () => ({id:'shared-word',name:'Shared.docx',extension:'docx',kind:'word',
  base64:'TkVX',sha256:'a'.repeat(64),sizeBytes:3,version:2,updatedBy:'remote-client'})
async function settleWorkspaceShell() {
  for(let n=0;n<20;n++){await Promise.resolve();await vue.nextTick()}
}

test('shared candidate errors raised during mount release the barrier immediately and retain the original editor',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  const expectedRevision=await h.state.sharedRevision(original.key)
  const originalEntry=h.state.rustWordEntries.value[0]
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',revision:'1:1',dirty:true})
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(candidate)h.state.editorError(candidate.document.id,'Candidate renderer could not start')
  },{flush:'sync'})
  try {
    await assert.rejects(h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true),/Candidate renderer/)
    assert.equal(h.state.syncApplying.value,false)
    assert.equal(h.state.stagedTab.value,undefined)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(h.state.activeKey.value,original.key)
    assert.equal(h.state.rustWordEntries.value.length,1)
    assert.equal(h.state.rustWordEntries.value[0],originalEntry)
    assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
    assert.equal(h.rustPreparations[0].discarded,1)
    assert.equal([...h.timers.values()].some(timer=>timer.milliseconds===120000),false)
  } finally {stop();h.unmount()}
})

test('shared replacement keeps the original model until the candidate has mounted and passed inspection',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  const expectedRevision=await h.state.sharedRevision(original.key)
  original.sync={id:'shared-word',version:1,revision:expectedRevision}
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',revision:'1:1',dirty:true})
  let release,inspections=0,candidateKey
  const barrier=new Promise(resolve=>{release=resolve})
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(!candidate||candidate.document.id===candidateKey)return
    candidateKey=candidate.document.id
    h.state.setRustWordHandle(candidateKey,{inspect:async()=>{
      if(++inspections===1)await barrier
      return {documentId:2,revision:0}
    }})
    h.state.readyFor(candidateKey)
  },{flush:'sync'})
  try {
    const replacing=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true)
    await settleWorkspaceShell()
    assert.equal(inspections,1)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(h.state.activeKey.value,original.key)
    assert.equal(h.state.rustWordHandles.has(original.key),true)
    assert.equal(h.state.rustWordEntries.value.length,2)
    release();assert.equal(await replacing,true)
    assert.equal(h.state.tabs.value.length,1)
    assert.equal(h.state.activeKey.value,candidateKey)
    assert.equal(h.state.tabs.value[0].document.base64,'TkVX')
    assert.equal(h.state.tabs.value[0].dirty,true)
    assert.ok(h.state.tabs.value[0].sync.revision.includes('2:0'))
    assert.equal(h.state.rustWordHandles.has(original.key),false)
    assert.equal(h.state.rustWordEntries.value.length,1)
    assert.equal(h.state.syncApplying.value,false)
  } finally {release();stop();h.unmount()}
})

test('a local edit arriving while a shared candidate initializes cancels replacement without losing undo ownership',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  const expectedRevision=await h.state.sharedRevision(original.key)
  original.sync={id:'shared-word',version:1,revision:expectedRevision}
  const originalEntry=h.state.rustWordEntries.value[0]
  let revision='1:1',release,candidateKey
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',revision,dirty:true})
  const barrier=new Promise(resolve=>{release=resolve})
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(!candidate||candidate.document.id===candidateKey)return
    candidateKey=candidate.document.id
    h.state.setRustWordHandle(candidateKey,{inspect:async()=>{await barrier;return {documentId:2,revision:0}}})
    h.state.readyFor(candidateKey)
  },{flush:'sync'})
  try {
    const replacing=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true)
    await settleWorkspaceShell()
    revision='1:2';release()
    assert.equal(await replacing,false)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(h.state.activeKey.value,original.key)
    assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
    assert.equal(h.state.rustWordHandles.has(candidateKey),false)
    assert.equal(h.state.rustWordEntries.value[0],originalEntry)
    assert.equal(original.sync.version,1)
    assert.equal(original.dirty,true)
    assert.equal(h.state.syncApplying.value,false)
  } finally {release();stop();h.unmount()}
})

test('uncommitted input blocks shared adoption and releases only the isolated preparation',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  const expectedRevision=await h.state.sharedRevision(original.key)
  h.rustWordHandle.exportFile=async()=>{throw Error('Apply the pending draft first')}
  try {
    await assert.rejects(h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true),/pending draft/)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(h.state.activeKey.value,original.key)
    assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
    assert.equal(h.state.rustWordEntries.value.length,1)
    assert.equal(h.rustPreparations[0].discarded,1)
    assert.equal(h.state.syncApplying.value,false)
  } finally {h.unmount()}
})

test('manual save waits for a background snapshot before creating its own exact save receipt',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original)
  let release,exports=0,savedReceipt
  const barrier=new Promise(resolve=>{release=resolve})
  h.rustWordHandle.exportFile=async()=>{
    const order=++exports
    if(order===1)await barrier
    savedReceipt=order===1?'QkdST1VORA==':'U0FWRUQ='
    return {base64:savedReceipt,extension:'docx',revision:`1:${order}`,dirty:true}
  }
  h.rustWordHandle.markSaved=async bytes=>{
    assert.equal(bytes,'U0FWRUQ=')
    assert.equal(bytes,savedReceipt)
    h.calls.push(['marked',bytes])
  }
  try {
    const background=h.state.sharedSnapshot(original.key)
    const saving=h.state.editorTransaction('Manual save',()=>h.state.saveActive())
    await settleWorkspaceShell()
    assert.equal(exports,1)
    assert.equal(h.calls.some(call=>call[0]==='save'),false)
    release();await background
    assert.equal(await saving,true)
    assert.equal(exports,2)
    assert.equal(h.calls.find(call=>call[0]==='save')[1].base64,'U0FWRUQ=')
    assert.equal(original.dirty,false)
    assert.equal(h.calls.filter(call=>call[0]==='marked').length,1)
  } finally {release();h.unmount()}
})

test('revoking a shared adoption while the candidate loads preserves the original tab and receipt',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',revision:'1:1',dirty:true})
  const expectedRevision=await h.state.sharedRevision(original.key)
  original.sync={id:'shared-word',version:1,revision:expectedRevision}
  let permitted=true,release,candidateKey
  const barrier=new Promise(resolve=>{release=resolve})
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(!candidate||candidate.document.id===candidateKey)return
    candidateKey=candidate.document.id
    h.state.setRustWordHandle(candidateKey,{inspect:async()=>{await barrier;return {documentId:2,revision:0}}})
    h.state.readyFor(candidateKey)
  },{flush:'sync'})
  try {
    const replacing=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>permitted)
    await settleWorkspaceShell()
    assert.ok(candidateKey)
    permitted=false;release()
    assert.equal(await replacing,false)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(h.state.activeKey.value,original.key)
    assert.equal(original.sync.version,1)
    assert.equal(h.state.rustWordHandles.has(candidateKey),false)
    assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
  } finally {release();stop();h.unmount()}
})

test('native close requested during shared replacement waits for its barrier before checking unsaved content',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',revision:'1:1',dirty:true})
  const expectedRevision=await h.state.sharedRevision(original.key)
  let release,candidateKey,inspections=0,candidateExports=0
  const barrier=new Promise(resolve=>{release=resolve})
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(!candidate||candidate.document.id===candidateKey)return
    candidateKey=candidate.document.id
    h.state.setRustWordHandle(candidateKey,{
      inspect:async()=>{if(++inspections===1)await barrier;return {documentId:2,revision:0}},
      exportFile:async()=>{candidateExports++;return {base64:'TkVX',extension:'docx',revision:'2:0',dirty:true}},
    })
    h.state.readyFor(candidateKey)
  },{flush:'sync'})
  try {
    const replacing=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true)
    await settleWorkspaceShell()
    assert.equal(h.state.syncApplying.value,true)
    await h.state.closeWindow()
    assert.equal(h.state.busy.value,'')
    assert.equal(h.state.closeTarget.value,null)
    assert.equal(h.calls.some(call=>call[0]==='close'),false)
    release();assert.equal(await replacing,true)
    await settleWorkspaceShell()
    assert.equal(h.state.closeTarget.value,'window')
    assert.equal(h.state.activeKey.value,candidateKey)
    assert.equal(candidateExports,1)
    assert.equal(h.calls.some(call=>call[0]==='close'),false)
  } finally {release();stop();h.unmount()}
})

test('pending editor drafts retain the browser connection while actual connection failures and recovery update it',async()=>{
  let response='okay'
  const h=shell({nativeEnabled:false,browserUrl:`http://127.0.0.1:8750/${'a1'.repeat(32)}/?workspace=shared`,
    browserFetch:async()=>{
      if(response==='offline')throw Error('Network is unavailable')
      return new Response(JSON.stringify(response==='revoked'?{error:'old link'}:{running:true,revision:0,documents:[]}),
        {status:response==='revoked'?404:200,headers:{'Content-Type':'application/json'}})
    }})
  const original=h.tab('original',{dirty:true});h.active(original)
  h.rustWordHandle.syncRevision=async()=>{throw Error('Apply the pending draft first')}
  try {
    h.state.enableWorkspaceSync()
    await h.state.pollWorkspace()
    assert.equal(h.state.serverStatus.value.running,true)
    assert.match(h.state.serverError.value,/pending draft/)
    assert.equal(h.state.tabs.value[0],original)
    response='offline';await h.state.pollWorkspace()
    assert.equal(h.state.serverStatus.value.running,false)
    response='okay';h.rustWordHandle.syncRevision=async()=>undefined
    await h.state.pollWorkspace()
    assert.equal(h.state.serverStatus.value.running,true)
    assert.equal(h.state.serverError.value,'')
    response='revoked';await h.state.pollWorkspace()
    assert.equal(h.state.serverStatus.value.running,false)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(original.dirty,true)
    assert.equal(h.calls.some(call=>call[0]==='save'||call[0]==='download'||call[0]==='marked'),false)
  } finally {h.unmount()}
})

test('stopping the server during candidate activation rolls back the staged switch before retiring the old model',async()=>{
  const h=shell(),original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.native.stopBrowserServer=async()=>({running:false,localUrl:null,lanUrls:[],revision:2})
  h.state.enableWorkspaceSync()
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',revision:'1:1',dirty:true})
  const expectedRevision=await h.state.sharedRevision(original.key)
  let release,candidateKey,inspections=0
  const barrier=new Promise(resolve=>{release=resolve})
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(!candidate||candidate.document.id===candidateKey)return
    candidateKey=candidate.document.id
    h.state.setRustWordHandle(candidateKey,{inspect:async()=>{
      if(++inspections===2)await barrier
      return {documentId:2,revision:0}
    }})
    h.state.readyFor(candidateKey)
  },{flush:'sync'})
  try {
    const replacing=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>true)
    await settleWorkspaceShell()
    assert.equal(inspections,2)
    assert.equal(h.state.activeKey.value,candidateKey)
    assert.equal(h.state.rustWordHandles.has(original.key),true)
    await h.state.stopServer()
    release();assert.equal(await replacing,false)
    assert.equal(h.state.serverStatus.value.running,false)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(h.state.activeKey.value,original.key)
    assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
    assert.equal(h.state.rustWordHandles.has(candidateKey),false)
  } finally {release();stop();h.unmount()}
})

test('a missing shared document leaves the connected workspace and local editor usable',async()=>{
  const remote=sharedWordSnapshot()
  const {base64,...summary}=remote
  const h=shell({nativeEnabled:false,browserUrl:`http://127.0.0.1:8750/${'b2'.repeat(32)}/?workspace=shared`,
    browserFetch:async url=>new Response(JSON.stringify(url.endsWith('/_sync/state')
      ?{running:true,revision:2,documents:[summary]}:{error:'Document was removed'}),
      {status:url.endsWith('/_sync/state')?200:404,headers:{'Content-Type':'application/json'}})})
  const original=h.tab('original',{dirty:true});h.active(original)
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  original.sync={id:remote.id,version:1,revision:await h.state.sharedRevision(original.key)}
  try {
    h.state.enableWorkspaceSync();await h.state.pollWorkspace()
    assert.equal(h.state.serverStatus.value.running,true)
    assert.match(h.state.serverError.value,/不存在/)
    assert.equal(h.state.tabs.value[0],original)
    assert.equal(h.state.activeKey.value,original.key)
    assert.equal(h.state.syncApplying.value,false)
    assert.equal(h.calls.some(call=>call[0]==='save'||call[0]==='download'||call[0]==='marked'),false)
  } finally {h.unmount()}
})

test('a revoked old preparation cannot clear the replacement controller candidate or input barrier',async()=>{
  let releaseOld,releaseCurrent,preparations=0,oldPermitted=true
  const oldPreparation=new Promise(resolve=>{releaseOld=resolve})
  const currentInspection=new Promise(resolve=>{releaseCurrent=resolve})
  const h=shell({rustPrepare:async()=>{if(++preparations===1)await oldPreparation;return {prepared:true}}})
  const original=h.tab('original',{dirty:true});h.active(original);h.state.serverStatus.value.running=true
  h.rustWordHandle.syncRevision=async()=>({documentId:1,revision:1})
  h.rustWordHandle.exportFile=async()=>({base64:'T0xE',extension:'docx',revision:'1:1',dirty:true})
  const expectedRevision=await h.state.sharedRevision(original.key)
  let candidateKey
  const stop=vue.watch(h.state.rustWordEntries,entries=>{
    const candidate=entries.find(entry=>entry.document.id!==original.key)
    if(!candidate||candidate.document.id===candidateKey)return
    candidateKey=candidate.document.id
    h.state.setRustWordHandle(candidateKey,{inspect:async()=>{await currentInspection;return {documentId:2,revision:0}}})
    h.state.readyFor(candidateKey)
  },{flush:'sync'})
  try {
    const old=h.state.adoptShared(original.key,sharedWordSnapshot(),expectedRevision,()=>oldPermitted)
    await settleWorkspaceShell()
    assert.equal(preparations,1)
    oldPermitted=false
    const current=h.state.adoptShared(original.key,{...sharedWordSnapshot(),version:3},expectedRevision,()=>true)
    await settleWorkspaceShell()
    assert.ok(candidateKey)
    assert.equal(h.state.syncApplying.value,true)
    assert.equal(h.state.stagedTab.value.key,candidateKey)
    releaseOld();assert.equal(await old,false)
    assert.equal(h.state.syncApplying.value,true)
    assert.equal(h.state.stagedTab.value.key,candidateKey)
    assert.equal(h.state.rustWordHandles.has(candidateKey),true)
    releaseCurrent();assert.equal(await current,true)
    assert.equal(h.state.activeKey.value,candidateKey)
    assert.equal(h.state.tabs.value[0].sync.version,3)
    assert.equal(h.state.syncApplying.value,false)
  } finally {releaseOld();releaseCurrent();stop();h.unmount()}
})

test('a stopped controller late network failure cannot overwrite the restarted workspace connection state',async()=>{
  let rejectOld,requests=0
  const stale=new Promise((_resolve,reject)=>{rejectOld=reject})
  const h=shell({workspaceDispatch:async()=>{
    if(++requests===1)return stale
    return {statusCode:200,body:{running:true,revision:2,documents:[]}}
  }})
  h.native.stopBrowserServer=async()=>({running:false,localUrl:null,lanUrls:[],revision:1})
  h.native.startBrowserServer=async()=>({running:true,localUrl:null,lanUrls:[],revision:2})
  try {
    h.state.enableWorkspaceSync()
    const obsoletePoll=h.state.pollWorkspace()
    await settleWorkspaceShell()
    await h.state.stopServer()
    await h.state.startServer()
    assert.equal(h.state.serverStatus.value.running,true)
    assert.equal(h.state.sharedState.value.revision,2)
    assert.equal(h.state.serverError.value,'')
    const notice=h.state.serverNotice.value
    rejectOld(Error('Old controller network failure'));await obsoletePoll
    assert.equal(h.state.serverStatus.value.running,true)
    assert.equal(h.state.sharedState.value.revision,2)
    assert.equal(h.state.serverError.value,'')
    assert.equal(h.state.serverNotice.value,notice)
  } finally {h.unmount()}
})

test('seven documents per kind reject an eighth before preparation while existing files and other kinds remain usable',async()=>{
  for(const kind of ['word','sheet','presentation','pdf']) {
    const h=shell(),opened=[]
    for(let index=0;index<7;index++){const tab=h.tab(`capacity-${index}`,{kind,dirty:true});h.active(tab);opened.push(tab)}
    const active=opened.at(-1),extension=active.document.extension
    const before=JSON.stringify(h.state.tabs.value)
    h.handle.exportFile=async()=>assert.fail('Capacity rejection must not snapshot the active document')
    try {
      await assert.rejects(h.state.addDocument({...active.document,id:'eighth',name:`Eighth.${extension}`},'eighth-file'),/最多同时打开 7 份/)
      assert.equal(h.calls.length,0,'Capacity must be checked before preflight, stash or disposal')
      assert.equal(JSON.stringify(h.state.tabs.value),before);assert.equal(h.state.activeKey.value,active.key)
      let snapshots=0
      h.handle.exportFile=async({format})=>{snapshots++;return {base64:'T0xE',extension:format,dirty:true}}
      assert.equal(await h.state.addDocument(opened[0].document,opened[0].fileId),opened[0])
      assert.equal(h.state.activeKey.value,opened[0].key);assert.equal(h.state.tabs.value.length,7)
      assert.equal(snapshots,1);assert.equal(h.calls.some(call=>call[0].endsWith('-preflight')),false)
      const otherKind=kind==='word'?'sheet':'word',otherExtension=otherKind==='word'?'docx':'xlsx'
      const other=await h.state.addDocument({id:'other',kind:otherKind,extension:otherExtension,name:`Other.${otherExtension}`,base64:'T0xE',sha256:'',sizeBytes:3})
      assert.equal(other.document.kind,otherKind);assert.equal(h.state.activeKey.value,other.key)
      assert.equal(h.state.tabs.value.length,8);assert.equal(h.state.tabs.value.filter(tab=>tab.document.kind===kind).length,7)
      assert.equal(h.calls.filter(call=>call[0].endsWith('-preflight')).length,1)
    } finally {h.unmount()}
  }
})

test('seven documents of the same kind leave an eighth model available for a validated shared replacement',async()=>{
  for(const [kind,entriesName,setterName,preparationsName] of [
    ['word','rustWordEntries','setRustWordHandle','rustPreparations'],
    ['sheet','rustSheetEntries','setRustSheetHandle','sheetPreparations'],
    ['presentation','rustPresentationEntries','setRustPresentationHandle','deckPreparations'],
    ['pdf','rustPdfEntries','setRustPdfHandle','pdfPreparations'],
  ]) {
    const h=shell(),opened=[]
    for(let index=0;index<7;index++){const tab=h.tab(`reserved-${index}`,{kind,dirty:true});h.active(tab);opened.push(tab)}
    const original=opened.at(-1),originalKeys=new Set(opened.map(tab=>tab.key)),handle=backgroundHandle(h,original)
    const entries=h.state[entriesName]
    h.state.serverStatus.value.running=true
    handle.syncRevision=async()=>({documentId:7,revision:1})
    handle.exportFile=async options=>{assert.equal(options.background,true);return {base64:'T0xE',extension:original.document.extension,revision:'7:1',dirty:true}}
    const expectedRevision=await h.state.sharedRevision(original.key)
    let release,candidateKey
    const inspection=new Promise(resolve=>{release=resolve})
    const stop=vue.watch(entries,values=>{
      const candidate=values.find(entry=>!originalKeys.has(entry.document.id))
      if(!candidate||candidate.document.id===candidateKey)return
      candidateKey=candidate.document.id
      h.state[setterName](candidateKey,{canBackgroundExport:async()=>true,inspect:async()=>{await inspection;return {documentId:8,revision:0}}})
      h.state.readyFor(candidateKey)
    },{flush:'sync'})
    try {
      const replacing=h.state.adoptShared(original.key,{...sharedWordSnapshot(),kind,extension:original.document.extension,name:`Shared.${original.document.extension}`},expectedRevision,()=>true)
      await settleWorkspaceShell()
      assert.ok(candidateKey);assert.equal(entries.value.length,8,'The old seven models must remain alive while the candidate is validated')
      assert.equal(h.state.tabs.value.length,7);assert.equal(h.state.activeKey.value,original.key)
      assert.equal(h[preparationsName].length,1);assert.equal(h[preparationsName][0].discarded,0)
      release();assert.equal(await replacing,true)
      assert.equal(entries.value.length,7);assert.equal(h.state.tabs.value.length,7)
      assert.equal(h.state.activeKey.value,candidateKey);assert.equal(h.state.active.value.document.base64,'TkVX')
      assert.equal(entries.value.some(entry=>entry.document.id===original.key),false)
      for(const retained of opened.slice(0,6))assert.equal(h.state.tabs.value.find(tab=>tab.key===retained.key),retained)
      assert.equal(h.state.syncApplying.value,false)
    } finally {release();stop();h.unmount()}
  }
})
