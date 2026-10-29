import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID, webcrypto } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { baseParse } from '@vue/compiler-dom'
import { zipSync, strToU8 } from 'fflate'
import { createId } from '../src/shared/id.ts'
import * as workflowFiles from '../src/workflow/core/files.ts'
import * as scheduleModel from '../src/schedule/model.ts'
import * as scheduleLayout from '../src/schedule/layout.ts'
import * as schedulePng from '../src/schedule/png-export.ts'

// Run the real App.vue setup logic with Vue's real reactivity. Editors and native
// file dialogs are controlled doubles: these are shell-state regressions, not
// Rust/WASM/PDF engine or native WebView compatibility tests.
const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
const app = appSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const utilities = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const dialogFocus = await readFile(new URL('../src/shared/dialog-focus.ts', import.meta.url), 'utf8')
const appearanceSource = await readFile(new URL('../src/shared/appearance.ts', import.meta.url), 'utf8')
const autosaveSource = await readFile(new URL('../src/shared/autosave.ts', import.meta.url), 'utf8')
const mcpSources = Object.fromEntries(await Promise.all(['config', 'service', 'document-tools', 'tool-schema', 'word-tools', 'sheet-tools', 'presentation-tools', 'pdf-tools', 'notes-workflow-tools', 'schedule-tools'].map(async name =>
  [`./mcp/${name}`, await readFile(new URL(`../src/mcp/${name}.ts`, import.meta.url), 'utf8')]
)))
const names = 'tabs,activeKey,active,home,tabBar,help,helpDialog,closeDialog,saveAsDraft,saveAsOptions,saveAsCopy,openSaveAs,confirmSaveAs,cancelSaveAs,rustPdfEntries,rustPdfHandles,setRustPdfHandle,rustWordEntries,rustWordHandles,setRustWordHandle,rustSheetEntries,rustSheetHandles,setRustSheetHandle,rustPresentationEntries,rustPresentationHandles,setRustPresentationHandle,busy,error,closeTarget,readyFor,dirtyFor,editorError,stash,activate,addDocument,newDocument,openFile,openRecent,browserFile,saveActive,closeTab,closeAllTabs,closeWindow,resolveClose,removeTab,removeTabs,task,editorTransaction,nativeTransactionalEditor,appearance,currentDocument,globalActionsBlocked,documentActionsDisabled,globalFileAction,globalNewDocument,keydown,rustEditorFileAction,previewSlides'
  + ',autosaveEnabled,autosave,autosaveWaiting,saveStateLabel,saveStateTitle,backgroundSaving,editorInputBlocked,noteEntries,noteHandles,setNoteHandle,activeNote'
  + ',printDisabled,status,scheduleEntries,scheduleHandles,setScheduleHandle,activeSchedule'
  + ',mcpConfig,mcpSettingsOpen,mcpSettingsBusy,mcpSettingsError,mcpState,mcpWorking,mcpMutating,mcpService,toggleMcp,saveMcpSettings,openMcpSettings,workflowEntries,workflowHandles,setWorkflowHandle,composing'


// Every shell still receives a fresh VM context and fresh Vue state. Reuse only
// the immutable transpiled source so large regression suites do not reparse the
// same App setup hundreds of times while native builds compete for memory.
const compiledSources = new Map()
function compile(source, require, extra = {}) {
  let output = compiledSources.get(source)
  if (output === undefined) {
    output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    compiledSources.set(source, output)
  }
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require, console, URL, setTimeout, clearTimeout, structuredClone,
    crypto: { randomUUID, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, btoa, atob, TextEncoder, TextDecoder, __BUILD_VERSION__: 'test', __APP_VERSION__: 'test', HTMLElement: class {}, document: { baseURI: 'http://127.0.0.1/' }, ...extra })
  return module.exports
}


function shell({nativeEnabled = true, smoke = false, rustPrepareError, rustPrepare, wordSmokeError, wordSmokeReport, wordSmokeRun, sheetPrepareError, sheetPrepare, sheetWarnings = [], deckPrepareError, deckPrepare, deckWarnings = [], presentationSmokeError, presentationSmokeReport, presentationSmokeRun, sheetSmokeError, sheetSmokeReport, sheetSmokeRun, pdfPrepareError, pdfPrepare, pdfWarnings = [], pdfSmokeError, pdfSmokeReport, notebookSmokeError, notebookSmokeReport, notebookSmokeRun, workflowSmokeError, workflowSmokeReport, workflowSmokeRun, workspaceSmokeError, workspaceSmokeReport, storedAppearance, storedAutosave, systemDark = false, storageUnavailable = false, browserUrl = 'http://127.0.0.1/', browserFetch, notebookDecodeError, mcpSmokeError, mcpSmokeReport, mcpSmokeRun} = {}) {
  const rustPreparations = [], sheetPreparations = [], deckPreparations = [], pdfPreparations = []
  const calls = [], mounted = [], beforeUnmount = [], observers = [], native = {
    isTauri: () => nativeEnabled,
    onCloseRequested: async () => () => {},
    bootstrap: async () => ({smokeMode:false}),
    listRecentDocuments: async () => [],
    openDocument: async () => null,
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
  let now = Date.now()
  const media = { matches: systemDark, addEventListener(_type, callback) { mediaListeners.add(callback) }, removeEventListener(_type, callback) { mediaListeners.delete(callback) } }
  class Element {}
  // Share DOM identities with the real dialog helper across both VM contexts.
  // Layout notifications remain controlled because this harness has no renderer.
  const browser = {
    Date: class extends Date { static now() { return now } },
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
    // The autosave scheduler is real. Their clock/DOM hosts are
    // controlled so a mounted shell cannot start background work in another test.
    setInterval(callback, milliseconds) { const timer={callback,milliseconds};intervals.set(timer,timer);return timer },
    clearInterval(timer) { intervals.delete(timer) },
    window: {
      dispatchEvent() {},
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
    Event,
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
  const mcpCalls = [], mcpResults = []
  let mcpListener, mcpSession, mcpSerial = 0, mcpStoredConfig
  const mcpStopped = () => ({ running: false, sessionId: null, documentId: null, endpoint: null, port: null })
  // Native MCP transport is controlled; the App and service lifecycle remain real.
  const mcpNative = {
    async getMcpConfig() { mcpCalls.push(['get-config']); return mcpStoredConfig ?? mcpModule('./mcp/config').createDefaultMcpConfig() },
    async saveMcpConfig(config) { mcpCalls.push(['save-config', config]); mcpStoredConfig = { ...config }; return mcpStoredConfig },
    mcpTransport: {
      async start(config, document, tools) {
        mcpCalls.push(['start', config, document, tools])
        mcpSession = { running: true, sessionId: `controlled-mcp-${++mcpSerial}`, documentId: document.id, endpoint: `http://127.0.0.1:${config.port}/mcp`, port: config.port }
        return mcpSession
      },
      async stop(sessionId) { mcpCalls.push(['stop', sessionId]); mcpSession = undefined; return mcpStopped() },
      async heartbeat(sessionId) { mcpCalls.push(['heartbeat', sessionId]); return mcpSession ?? mcpStopped() },
      async claim(sessionId, requestId) { mcpCalls.push(['claim', sessionId, requestId]); return true },
      async complete(sessionId, requestId, result) { mcpResults.push({ sessionId, requestId, result }) },
      async listen(callback) { mcpCalls.push(['listen']); mcpListener = callback; return () => { mcpCalls.push(['unlisten']); mcpListener = undefined } },
    },
  }
  function mcpModule(name) {
    name = name.replace(/\.ts$/, '')
    if (modules.has(name)) return modules.get(name)
    const source = mcpSources[name]
    if (!source) throw Error(`Unexpected MCP module import ${name}`)
    const result = compile(source, dependency => {
      if (dependency === '../shared/document') return helpers
      // Keep the real schedule schemas and shared constraints in this shell
      // harness; these modules do not require a rendered canvas at import time.
      if (dependency === '../schedule/model.ts') return scheduleModel
      if (dependency === '../schedule/layout.ts') return scheduleLayout
      if (dependency === '../schedule/png-export.ts') return schedulePng
      if (dependency.startsWith('./')) return mcpModule(dependency.replace(/^\.\//, './mcp/'))
      throw Error(`Unexpected MCP dependency ${dependency}`)
    }, browser)
    modules.set(name, result)
    return result
  }
  function sharedModule(name) {
    if (modules.has(name)) return modules.get(name)
    const source = {'./shared/autosave':autosaveSource}[name]
    if (!source) throw Error(`Unexpected shared module import ${name}`)
    const result=compile(source, dependency => sharedModule(dependency.replace(/^\.\//,'./shared/')), browser)
    modules.set(name,result);return result
  }
  const state = scope.run(() => compile(`${app}\nexport const state={${names}}`, name => {
    if (name === 'vue') return lifecycle
    if (name === './native') return native
    if (name === './mcp/native') return mcpNative
    if (name === './mcp/native-smoke') return { async runMcpNativeSmoke(adapter) {
      calls.push(['mcp-native-smoke'])
      for (const method of ['open', 'start', 'documentState', 'state', 'stop', 'close']) assert.equal(typeof adapter[method], 'function')
      if (mcpSmokeError) throw Error(mcpSmokeError)
      if (mcpSmokeRun) return mcpSmokeRun(adapter)
      return mcpSmokeReport ?? { schemaVersion: 2, kind: 'mcp-native', ok: true }
    } }
    if (name.startsWith('./mcp/')) return mcpModule(name)
    if (name === './smoke') return {smokeRequested:()=>smoke,smokeStage(){},smokeFeatures:()=>({}),smokeFailure:async(error,phase)=>{calls.push(['smoke-failure',phase,String(error)])},smokeAwait:async(_phase,action)=>action()}
    if (name === './shared/document') return helpers
    if (name === './workflow/core/files') return workflowFiles
    if (name === './schedule/model') return scheduleModel
    if (name === './shared/id') return { createId }
    if (name === './shared/dialog-focus') return focus
    if (name === './shared/appearance') return appearance
    if (name === './shared/autosave') return sharedModule(name)
    if (name === './presentation/templates') return {
      listPresentationTemplates: async () => [],
      loadPresentationTemplate: async () => assert.fail('Template loading is outside this shell-state harness'),
      savePresentationTemplate: async () => assert.fail('Template persistence is outside this shell-state harness'),
      deletePresentationTemplate: async () => assert.fail('Template removal is outside this shell-state harness'),
      normalizePresentationTemplateName: value => value.trim(),
    }
    if (name === './notes/model') return { decodeNotebook(bytes) { calls.push(['note-decode',Array.from(bytes)]);if(notebookDecodeError)throw Error(notebookDecodeError);return {testNotebook:true} } }
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
    if (name === './notes/native-smoke') return {async runNotebookNativeSmoke(...args){assert.equal(args.length,1);const [adapter]=args;calls.push(['notebook-native-smoke']);for(const method of ['open','bindTemporaryFile','state','autosaveEnabled','setAutosave','observeNativeSaves','close'])assert.equal(typeof adapter[method],'function');if(notebookSmokeError)throw Error(notebookSmokeError);if(notebookSmokeRun)return notebookSmokeRun(adapter);return notebookSmokeReport??{schemaVersion:1,kind:'notebook-native',ok:true}}}
    if (name === './workflow/native-smoke') return {async runWorkflowNativeSmoke(...args){assert.equal(args.length,1);const [adapter]=args;calls.push(['workflow-native-smoke']);for(const method of ['open','bindTemporaryFile','state','autosaveEnabled','setAutosave','observeNativeSaves','close'])assert.equal(typeof adapter[method],'function');if(workflowSmokeError)throw Error(workflowSmokeError);if(workflowSmokeRun)return workflowSmokeRun(adapter);return workflowSmokeReport??{schemaVersion:1,kind:'workflow-native',ok:true}}}
    if (name === './shared/workspace-native-smoke') return {async runWorkspaceNativeSmoke(...args){assert.equal(args.length,1);const [adapter]=args;calls.push(['workspace-native-smoke']);assert.equal(typeof adapter.observeNativeSaves,'function');if(workspaceSmokeError)throw Error(workspaceSmokeError);return workspaceSmokeReport??{schemaVersion:1,kind:'workspace-native',ok:true}}}
    if (name === '@tauri-apps/api/core') return { invoke: async (command,args) => { calls.push(['invoke',command,args]) } }
    if (name.endsWith('.vue')) return {}
    throw Error(`Unexpected setup import ${name}`)
  }, browser).state)
  const handle = {
    canBackgroundExport: async () => true,
    prepareDeactivate: async () => ({ documentId: 1, revision: 0, dirty: !!state.active.value?.dirty }),
    exportFile: async () => ({ base64: 'TkVX', extension: helpers.defaultSaveExtension(state.active.value?.document.extension || 'docx',state.active.value?.document.kind), dirty: false }),
    discardChanges: async options => { calls.push(['discard', options]) },
    markSaved: async () => { calls.push(['marked']) },
  }
  const rustWordHandle = Object.create(handle)
  const presentationHandle = Object.assign(Object.create(handle), {
    present: async startPage => { calls.push(['present',state.activeKey.value,startPage]) },
    stopPresentation: async () => { calls.push(['stop-presentation']) },
  })
  function attachHandles() {
    for(const entry of state.scheduleEntries.value)if(!state.scheduleHandles.has(entry.document.id))state.setScheduleHandle(entry.document.id,Object.create(handle))
    for(const entry of state.noteEntries.value)if(!state.noteHandles.has(entry.document.id))state.setNoteHandle(entry.document.id,Object.create(handle))
    for(const entry of state.rustPdfEntries.value)if(!state.rustPdfHandles.has(entry.document.id))state.setRustPdfHandle(entry.document.id,Object.create(handle))
    for(const entry of state.rustWordEntries.value)if(!state.rustWordHandles.has(entry.document.id))state.setRustWordHandle(entry.document.id,rustWordHandle)
    for(const entry of state.rustSheetEntries.value)if(!state.rustSheetHandles.has(entry.document.id))state.setRustSheetHandle(entry.document.id,Object.create(handle))
    for(const entry of state.rustPresentationEntries.value)if(!state.rustPresentationHandles.has(entry.document.id))state.setRustPresentationHandle(entry.document.id,presentationHandle)
    for(const entry of state.workflowEntries.value)if(!state.workflowHandles.has(entry.document.id))state.setWorkflowHandle(entry.document.id,Object.create(handle))
  }
  scope.run(()=>vue.watch([state.rustWordEntries,state.rustSheetEntries,state.rustPresentationEntries,state.rustPdfEntries,state.noteEntries,state.workflowEntries,state.scheduleEntries],attachHandles,{flush:'sync'}))
  function tab(id, { ready = true, dirty = false, fileId = id, kind = 'word' } = {}) {
    const extension = {word:'docx',sheet:'xlsx',presentation:'pptx',pdf:'pdf',note:'oonote',canvas:'owflow',diagram:'owflow',schedule:'ooschedule'}[kind]
    state.tabs.value.push({ key: id, ready, dirty, fileId, document: { id, kind, extension,
      name: `${id}.${extension}`, base64: 'T0xE', sha256: 'old-hash', sizeBytes: 3 } })
    return state.tabs.value.at(-1)
  }
  function active(tab) {
    state.activeKey.value = tab.key
    const entries={word:state.rustWordEntries,sheet:state.rustSheetEntries,presentation:state.rustPresentationEntries,pdf:state.rustPdfEntries,note:state.noteEntries,canvas:state.workflowEntries,diagram:state.workflowEntries,schedule:state.scheduleEntries}[tab.document.kind]
    if(entries&&!entries.value.some(entry=>entry.document.id===tab.key))entries.value=[...entries.value,{document:tab.document}]
  }
  async function idle() {
    for (let n = 0; n < 50 && state.busy.value; n++) { await Promise.resolve(); await vue.nextTick() }
    assert.equal(state.busy.value, '', 'The shell task should finish')
  }
  return { state, native, calls, rustPreparations, sheetPreparations, deckPreparations, pdfPreparations, handle, presentationHandle, rustWordHandle, tab, active, idle, browser, observers, storage, windowListeners, documentListeners, mediaListeners, timers, intervals, mcpNative, mcpCalls, mcpResults,
    emitMcp(fields = {}) {
      assert.ok(mcpListener, 'MCP event transport should be registered')
      mcpListener({ sessionId: state.mcpState.value.sessionId, requestId: `controlled-request-${++mcpSerial}`, documentId: state.activeKey.value,
        toolName: 'document_read', arguments: {}, deadlineAt: now + 1000, ...fields })
    },
    setSystemDark(value) { media.matches = value; for (const listener of mediaListeners) listener({ matches: value }) },
    dispatchWindow(type, event) { for (const listener of windowListeners.get(type) ?? []) listener(event) },
    dispatchDocument(type, event) { for (const listener of documentListeners.get(type) ?? []) listener({...event,type}) },
    async fireTimeout(milliseconds) {
      const entry=[...timers].find(([,value])=>value.milliseconds===milliseconds)
      assert.ok(entry,`Expected a scheduled ${milliseconds}ms timer`)
      now += milliseconds
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
    await settleShell()
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
  await h.fireTimeout(10000)
  assert.equal(h.calls.filter(call=>call[0]==='save').length,1)
  assert.equal(h.calls.find(call=>call[0]==='save')[1].documentId,'selected-local-file')
  assert.equal(tab.dirty,false)
  h.state.autosaveEnabled.value=false;await vue.nextTick()
  assert.equal(h.storage.get('open-office-autosave'),'false')
  assert.equal([...h.timers.values()].filter(timer=>timer.milliseconds===10000).length,0)
  h.unmount()
  assert.equal(h.intervals.size,0)
  assert.equal([...h.documentListeners.values()].reduce((count,listeners)=>count+listeners.size,0),0)
})

test('autosave resumes after IME confirmation without waiting for another full interval or faking a save',async()=>{
  const h=shell({storedAutosave:'true'}),tab=h.tab('ime-resume',{dirty:false});h.active(tab);h.state.home.value=false
  const target=Object.assign(new h.browser.HTMLElement(),{closest:()=>({})})
  try {
    await h.mount()
    assert.equal(h.state.saveStateLabel.value,'已保存','Opening a file is not an automatic save')
    h.state.dirtyFor(tab.key,true)
    assert.equal(h.state.saveStateLabel.value,'等待自动保存')
    h.dispatchDocument('compositionstart',{target})
    await h.fireTimeout(10000)
    assert.equal(h.calls.filter(call=>call[0]==='save').length,0)
    assert.equal(h.state.saveStateLabel.value,'等待输入完成')
    assert.equal(tab.autoSavedAt,undefined)
    h.dispatchDocument('compositionend',{target})
    await h.fireTimeout(1200);await h.idle()
    assert.equal(h.calls.filter(call=>call[0]==='save').length,1)
    assert.equal(tab.dirty,false)
    assert.equal(h.state.saveStateLabel.value,'已自动保存')
    assert.match(h.state.saveStateTitle.value,/已自动保存到本机/)
  } finally {h.unmount()}
})

test('autosave explains missing save destinations and never reports a failed native write as saved',async()=>{
  const h=shell({storedAutosave:'true'}),tab=h.tab('status-reasons',{dirty:true});h.active(tab);h.state.home.value=false
  try {
    tab.fileId=undefined
    assert.equal(h.state.saveStateLabel.value,'请先保存')
    assert.match(h.state.saveStateTitle.value,/选择保存位置/)
    tab.fileId='selected-original'
    h.native.saveDocument=async()=>{throw Error('Original file is read-only')}
    await h.mount();await h.fireTimeout(10000);await h.idle();await settleShell()
    assert.equal(tab.dirty,true)
    assert.equal(tab.autoSavedAt,undefined)
    assert.equal(h.state.saveStateLabel.value,'自动保存待重试')
    h.state.autosaveEnabled.value=false;await vue.nextTick()
    assert.equal(h.state.saveStateLabel.value,'尚未保存')
  } finally {h.unmount()}
})

test('autosave rechecks shell interruptions after awaiting engine readiness',async()=>{
  for(const interrupted of ['disabled','dialog','busy','composition']) {
    const h=shell({storedAutosave:'true'}),tab=h.tab(`queued-${interrupted}`,{dirty:true});h.active(tab)
    let resume
    const ready=new Promise(resolve=>{resume=resolve})
    h.rustWordHandle.canBackgroundExport=()=>ready
    try {
      await h.mount();await h.fireTimeout(10000)
      if(interrupted==='disabled')h.state.autosaveEnabled.value=false
      if(interrupted==='dialog')h.state.help.value=true
      if(interrupted==='busy')h.state.busy.value='正在处理另一份文件'
      if(interrupted==='composition')h.dispatchDocument('compositionstart',{target:Object.assign(new h.browser.HTMLElement(),{closest:()=>({})})})
      resume(true);await settleShell()
      assert.equal(h.calls.filter(call=>call[0]==='save').length,0,interrupted)
      assert.equal(tab.dirty,true)
      assert.equal(tab.autoSavedAt,undefined)
    } finally {resume(true);h.state.busy.value='';h.unmount()}
  }
})

function backgroundHandle(h,tab) {
  const handles={word:h.state.rustWordHandles,sheet:h.state.rustSheetHandles,
    presentation:h.state.rustPresentationHandles,pdf:h.state.rustPdfHandles,note:h.state.noteHandles}
  return handles[tab.document.kind].get(tab.key)
}

test('background operations fail closed for pending input and editors without a readiness method',async()=>{
  for(const kind of ['word','sheet','presentation','pdf'])for(const mode of ['pending','missing']) {
    const h=shell(),tab=h.tab(`background-${kind}`,{kind,dirty:true});h.active(tab)
    const handle=backgroundHandle(h,tab)
    handle.canBackgroundExport=mode==='pending'?async()=>false:undefined
    let revisions=0,exports=0
    handle.syncRevision=async()=>{revisions++;throw Error('Pending input must not be flushed by a revision probe')}
    handle.exportFile=async()=>{exports++;throw Error('Pending input must not be committed by a snapshot')}
    try {
      assert.equal(await h.state.saveActive(false,undefined,undefined,{key:tab.key,fileId:tab.fileId}),false)
      assert.equal(revisions,0);assert.equal(exports,0)
      assert.equal(h.calls.length,0,'No parse, file write, receipt, download or editor operation may start')
      assert.equal(h.state.tabs.value[0],tab);assert.equal(tab.dirty,true)
    } finally {h.unmount()}
  }
})


test('autosave leaves unfinished input focused and promptly retries only after explicit editor readiness',async()=>{
  for(const kind of ['word','sheet','presentation','pdf','note']) {
    const h=shell({storedAutosave:'true'}),tab=h.tab(`autosave-draft-${kind}`,{kind,dirty:true});h.active(tab);h.state.home.value=false
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
      await h.mount();await h.fireTimeout(10000)
      assert.equal(blurCount,0);assert.equal(pending,true);assert.equal(exports,0);assert.equal(receipts,0)
      assert.equal(h.calls.filter(call=>call[0]==='save').length,0);assert.equal(tab.dirty,true)
      assert.equal(h.browser.document.activeElement,focused)
      assert.equal(h.state.saveStateLabel.value,'等待完成编辑')
      assert.match(h.state.saveStateTitle.value,/不会被打断/)
      pending=false;await h.fireTimeout(1200);await h.idle()
      assert.equal(blurCount,0);assert.equal(exports,1);assert.equal(receipts,1)
      assert.equal(h.calls.filter(call=>call[0]==='save').length,1);assert.equal(tab.dirty,false)
      assert.equal(h.state.saveStateLabel.value,'已自动保存')
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
      await h.mount();await h.fireTimeout(10000);await h.idle();await settleShell()
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
    await h.mount();await h.fireTimeout(10000)
    assert.equal(writeStarted,true);assert.equal(h.state.backgroundSaving.value,true)
    assert.ok(h.state.busy.value);assert.equal(h.state.globalActionsBlocked.value,true)
    assert.equal(h.state.documentActionsDisabled.value,true);assert.equal(h.state.editorInputBlocked.value,false)
    assert.equal(h.browser.document.activeElement,focused);assert.equal(blurCount,0)
    for(const [name,value] of [['help',true],['closeTarget',tab],['saveAsDraft',{key:tab.key}]]) {
      const previous=h.state[name].value
      h.state[name].value=value;assert.equal(h.state.editorInputBlocked.value,true,`${name} must still block editor input`)
      h.state[name].value=previous;assert.equal(h.state.editorInputBlocked.value,false)
    }
    revision++;h.state.dirtyFor(tab.key,true)
    release();await settleShell();await h.idle();await settleShell()
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
  assert.equal(binding(byClass('tab-strip'),'inert'),'globalActionsBlocked')
  assert.equal(parents.get(byClass('tab-bar')),byClass('tab-strip'),'The scrolling list inherits the global file-control barrier')
  assert.equal(binding(elements.find(node=>attribute(node,'data-testid')==='global-toolbar'),'inert'),'globalActionsBlocked')
  for(const tag of ['RustWordEditor','RustSheetEditor','RustPresentationEditor','RustPdfEditor','NotebookEditor','ScheduleEditor']) {
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
      return { getBoundingClientRect: () => ({...bounds,width:bounds.right-bounds.left}) }
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

test('switching records authoritative dirty state without replacing file bytes or save identity', async () => {
  const h = shell(), a = h.tab('A',{}), b = h.tab('B',{}); h.active(a)
  const original = JSON.stringify(a.document), fileId = a.fileId
  h.handle.prepareDeactivate = async () => ({ documentId: 1, revision: 3, dirty: true })
  h.handle.exportFile = async () => assert.fail('Retained sessions must not serialize on tab switches')
  h.handle.discardChanges = async () => assert.fail('Switching is not permission to discard or acknowledge a save')
  await h.state.activate(b)
  assert.equal(JSON.stringify(a.document), original); assert.equal(a.fileId, fileId); assert.equal(a.dirty, true)
  assert.equal(h.state.activeKey.value, 'B'); assert.equal(b.ready, false)
  assert.equal(h.calls.length, 0)
})

test('failed lifecycle checks or pending PDF edits reject switching without replacing snapshots', async () => {
  for (const pending of [false, true]) {
    const h = shell(), a = h.tab('A',{}), b = h.tab('B',{}); h.active(a)
    h.handle.prepareDeactivate = async () => { throw Error(pending ? 'Apply pending PDF edits' : 'Revision changed') }
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

test('saving or exporting passes every other open file capability to the native overwrite guard',async()=>{
  const h=shell(),current=h.tab('current-view',{dirty:true,fileId:'current-file'}),other=h.tab('other-view',{kind:'pdf',fileId:'other-file'}),unsaved=h.tab('new-view',{fileId:undefined})
  unsaved.fileId=undefined
  h.active(current)
  h.rustWordHandle.exportFile=async({format})=>({base64:'RURJVA==',extension:format,dirty:true})
  try {
    assert.equal(await h.state.saveActive(),true)
    assert.equal(await h.state.saveActive(true,'pdf'),true)
    const requests=h.calls.filter(call=>call[0]==='save').map(call=>call[1])
    assert.equal(requests.length,2)
    assert.deepEqual(Array.from(requests[0].protectedDocumentIds),[other.fileId])
    // An exported copy must also protect its editable source from overwrite.
    assert.deepEqual(Array.from(requests[1].protectedDocumentIds),[current.fileId,other.fileId])
    assert.equal(requests[0].documentId,'current-file');assert.equal(requests[1].documentId,undefined)
    assert.equal(h.state.tabs.value.length,3);assert.equal(other.fileId,'other-file')
  } finally {h.unmount()}
})

test('reopening an already-open file retains its in-memory edits', async () => {
  const h = shell(), a = h.tab('A', { dirty: true }); h.active(a)
  await h.state.addDocument({ ...a.document, base64: 'disk-version' }, 'A')
  assert.equal(h.state.tabs.value.length, 1); assert.equal(a.document.base64, 'T0xE'); assert.equal(a.dirty, true)
})

for(const [kind,extension] of [['word','docx'],['sheet','xlsx'],['presentation','pptx'],['pdf','pdf']])test(`${extension} opens once and subsequent saves update the original file without a copy`,async()=>{
  const h=shell(),source={id:`local-${kind}`,kind,extension,name:`Existing.${extension}`,base64:'T0xE',sha256:'source-hash',sizeBytes:3}
  h.native.openDocument=async()=>source
  h.native.openRecent=async id=>{assert.equal(id,source.id);return {...source,base64:'RElTSw=='}}
  try {
    h.state.openFile();await h.idle()
    const tab=h.state.active.value,handle=backgroundHandle(h,tab)
    h.state.readyFor(tab.key);tab.dirty=true
    handle.exportFile=async options=>{assert.equal(options.format,extension);return {base64:'RURJVA==',extension,dirty:true}}
    const key=tab.key,entryCount=h.state.tabs.value.length,preflights=h.calls.filter(call=>call[0].endsWith('-preflight')).length
    h.state.openRecent({id:source.id});await h.idle()
    assert.equal(h.state.tabs.value.length,entryCount);assert.equal(h.state.activeKey.value,key)
    assert.equal(h.state.active.value,tab);assert.equal(tab.dirty,true);assert.equal(backgroundHandle(h,tab),handle)
    assert.equal(h.calls.filter(call=>call[0].endsWith('-preflight')).length,preflights,'Reopening the same file must retain its live model and undo history')
    assert.equal(await h.state.saveActive(),true)
    const first=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(first.documentId,source.id);assert.equal(first.expectedSha256,'source-hash')
    assert.equal(first.name,source.name);assert.equal(first.saveAs,false);assert.equal(first.base64,'RURJVA==')
    assert.equal(tab.fileId,source.id);assert.equal(tab.document.id,key);assert.equal(tab.requiresSaveAs,false)
    tab.dirty=true;assert.equal(await h.state.saveActive(),true)
    const second=h.calls.filter(call=>call[0]==='save')[1][1]
    assert.equal(second.documentId,source.id);assert.equal(second.expectedSha256,'new-hash');assert.equal(second.saveAs,false)
  } finally {h.unmount()}
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

for(const target of ['all','window'])test(`${target} closes unsaved documents with one confirmation and without exporting invalid drafts`,async()=>{
  const h=shell(),opened=[]
  for(const kind of ['word','sheet','presentation','pdf','note']) {
    const tab=h.tab(`discard-${kind}`,{kind,dirty:true});h.active(tab);opened.push(tab)
    const handle=backgroundHandle(h,tab)
    handle.exportFile=async()=>{throw Error(`Invalid unfinished ${kind} draft`)}
    handle.discardChanges=async options=>{assert.equal(options.force,true);h.calls.push(['forced-discard',kind])}
    handle.markSaved=async()=>assert.fail('Discard must not acknowledge unsaved bytes')
  }
  const last=opened.at(-1),activated=[]
  h.state.home.value=false
  const stop=vue.watch(h.state.activeKey,key=>{activated.push(key)},{flush:'sync'})
  try {
    if(target==='all')h.state.closeAllTabs()
    else await h.state.closeWindow()
    await h.idle()
    assert.equal(h.state.closeTarget.value,target);assert.equal(h.state.tabs.value.length,5)
    assert.equal(h.state.activeKey.value,last.key)
    h.calls.length=0
    h.handle.exportFile=async()=>assert.fail('Confirmed batch discard must never export or commit editor drafts')
    for(const tab of opened)backgroundHandle(h,tab).exportFile=h.handle.exportFile
    await h.state.resolveClose('discard')
    assert.equal(h.state.closeTarget.value,null)
    if(target==='all') {
      assert.equal(h.state.tabs.value.length,0);assert.equal(h.state.activeKey.value,'');assert.equal(h.state.home.value,true)
      assert.deepEqual(h.calls.filter(call=>call[0]==='forced-discard').map(call=>call[1]).sort(),['note','pdf','presentation','sheet','word'])
      for(const entries of [h.state.rustWordEntries,h.state.rustSheetEntries,h.state.rustPresentationEntries,h.state.rustPdfEntries,h.state.noteEntries])assert.equal(entries.value.length,0)
      for(const handles of [h.state.rustWordHandles,h.state.rustSheetHandles,h.state.rustPresentationHandles,h.state.rustPdfHandles,h.state.noteHandles])assert.equal(handles.size,0)
    } else {
      // The native host destroys the window. Keep its models intact until that
      // operation succeeds rather than serializing drafts to close them.
      assert.equal(h.state.tabs.value.length,5);assert.equal(h.state.activeKey.value,last.key)
    }
    assert.ok(activated.every(key=>key===''),'Batch close must not activate intervening documents')
    assert.ok(!h.calls.some(call=>['save','download','marked'].includes(call[0])))
    assert.equal(h.calls.filter(call=>call[0]==='close').length,target==='window'?1:0)
  } finally {stop();h.unmount()}
})

test('close-all discovers an unreported active draft and cancellation preserves every editor',async()=>{
  const h=shell(),first=h.tab('clean-word'),pending=h.tab('pending-pdf',{kind:'pdf'})
  h.active(first);h.active(pending)
  h.handle.exportFile=async()=>{throw Error('Unapplied text draft')}
  try {
    h.state.closeAllTabs();await h.idle()
    assert.equal(h.state.closeTarget.value,'all');assert.equal(pending.dirty,true)
    assert.equal(h.state.tabs.value.length,2);assert.equal(h.state.activeKey.value,pending.key)
    h.state.closeTarget.value=null
    assert.equal(h.state.rustWordEntries.value.length,1);assert.equal(h.state.rustPdfEntries.value.length,1)
    assert.ok(!h.calls.some(call=>['discard','save','close'].includes(call[0])))
  } finally {h.unmount()}
})

for(const target of ['all','window'])test(`cancelled ${target} save keeps all tabs after earlier documents were saved`,async()=>{
  const h=shell(),first=h.tab('save-first',{dirty:true}),second=h.tab('cancel-second',{kind:'sheet',dirty:true})
  h.active(first);h.active(second);h.active(first)
  for(const tab of [first,second]) {
    let engineDirty=true
    const handle=backgroundHandle(h,tab)
    handle.exportFile=async()=>({base64:'RURJVA==',extension:tab.document.extension,dirty:engineDirty})
    handle.markSaved=async()=>{engineDirty=false}
  }
  const save=h.native.saveDocument
  h.native.saveDocument=async request=>request.documentId===second.fileId?{status:'cancelled'}:save(request)
  try {
    h.state.closeTarget.value=target;await h.state.resolveClose('save')
    assert.equal(h.state.closeTarget.value,target);assert.equal(h.state.tabs.value.length,2)
    assert.equal(first.dirty,false);assert.equal(second.dirty,true)
    assert.equal(h.state.rustWordEntries.value.length,1);assert.equal(h.state.rustSheetEntries.value.length,1)
    assert.equal(h.calls.filter(call=>call[0]==='save').length,1)
    assert.ok(!h.calls.some(call=>call[0]==='close'))
  } finally {h.unmount()}
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
  h.handle.prepareDeactivate=async()=>{assert.equal(h.state.busy.value.length>0,true);throw Error('Revision changed')}
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

test('successful Rust preparation precedes input settlement and publication and captures immutable source bytes',async()=>{
  let finish
  const h=shell({rustPrepare:()=>new Promise(resolve=>{finish=resolve})}),tab=h.tab('live',{dirty:true});h.active(tab)
  h.handle.prepareDeactivate=async()=>{h.calls.push(['settle-current']);return{documentId:1,revision:3,dirty:true}}
  h.handle.exportFile=async()=>assert.fail('Opening a new tab must retain live content without exporting')
  const source=rustSource('incoming'),opening=h.state.addDocument(source,source.id)
  await Promise.resolve()
  assert.equal(h.state.activeKey.value,tab.key);assert.equal(h.state.tabs.value.length,1)
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'rust-preflight');assert.equal(tab.document.base64,'T0xE')
  source.base64='TkVX';finish({testRustSession:'incoming'});await opening
  const next=h.state.active.value
  assert.deepEqual(h.calls.map(c=>c[0]),['rust-preflight','rust-prepared','settle-current'])
  assert.equal(tab.document.base64,'T0xE');assert.equal(tab.dirty,true)
  assert.equal(next.document.base64,'T0xE');assert.notEqual(next.key,tab.key)
  assert.equal(h.state.rustWordEntries.value.length,2);assert.equal(h.state.rustWordEntries.value[1].prepared,h.rustPreparations[0].handoff)
  assert.equal(h.state.rustWordEntries.value.at(-1).prepared.take(next.document),h.rustPreparations[0].session)
  assert.equal(h.state.rustWordEntries.value.at(-1).prepared.take(next.document),undefined)
  h.unmount()
})

test('failed input settlement and disposal release an undelivered Rust preparation without publishing a tab',async()=>{
  const h=shell(),tab=h.tab('typing',{dirty:true});h.active(tab)
  h.handle.prepareDeactivate=async()=>{throw Error('Composition pending')}
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

test('Word retains its original DOCX destination and hash through cancelled and successful saves',async()=>{
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
  assert.equal(tab.dirty,true);assert.equal(tab.requiresSaveAs,false);assert.equal(tab.fileId,'original');assert.equal(tab.document.sha256,'source-hash')
  assert.ok(!h.calls.some(c=>c[0]==='marked'))
  h.native.saveDocument=save;assert.equal(await h.state.saveActive(),true)
  for(const request of h.calls.filter(c=>['save','cancelled-rust-save'].includes(c[0])).map(c=>c[1])){
    assert.equal(request.documentId,'original');assert.equal(request.expectedSha256,'source-hash');assert.equal(request.saveAs,false)
    assert.equal(request.name,'original.docx')
  }
  assert.equal(tab.fileId,'original');assert.equal(tab.requiresSaveAs,false);assert.equal(tab.dirty,false)
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
    assert.equal(request.extension,'pdf');assert.equal(request.name,'original.pdf');assert.equal(request.base64,'JVBERi0xLjc=')
  }
  assert.ok(!h.calls.some(c=>c[0]==='marked'))
  h.unmount()
})

test('Rust tab switches preserve each mounted entry and use the matching editor handle',async()=>{
  const h=shell(),settled=[],exported=[],discarded=[]
  const mountHandle=tab=>{
    const handle={canBackgroundExport:async()=>true,prepareDeactivate:async()=>{settled.push(tab.key);return{documentId:1,revision:3,dirty:true}},exportFile:async()=>{exported.push(tab.key);return{base64:Buffer.from(tab.key).toString('base64'),extension:'docx',dirty:true}},discardChanges:async()=>{discarded.push(tab.key)}}
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
  assert.deepEqual(settled,[first.key,second.key,first.key]);assert.deepEqual(exported,[]);assert.deepEqual(discarded,[])
  assert.equal(first.document.base64,'T0xE')
  assert.equal(second.document.base64,'T0xE')
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

test('printing availability follows the visible editor and pending print blocks repeated requests', async () => {
  const h=shell(), tab=h.tab('print-document',{dirty:true})
  let finish, prints=0
  h.rustWordHandle.print=()=>{prints++;return new Promise(resolve=>{finish=resolve})}
  h.active(tab)
  assert.equal(h.state.printDisabled.value,true,'Retained home document cannot print')
  h.state.home.value=false
  assert.equal(h.state.printDisabled.value,false)
  h.state.globalFileAction('print')
  for (let i=0;i<10&&!prints;i++) {await Promise.resolve();await vue.nextTick()}
  assert.equal(prints,1)
  assert.equal(h.state.printDisabled.value,true)
  h.state.globalFileAction('print')
  h.state.rustEditorFileAction('print')
  assert.equal(prints,1)
  finish({status:'cancelled'});await h.idle()
  assert.equal(h.state.status.value,'已取消打印')
  assert.equal(h.state.printDisabled.value,false)
  assert.equal(tab.dirty,true,'Printing must not acknowledge an on-disk save')
  assert.equal(h.calls.filter(call=>call[0]==='save').length,0)
  h.unmount()
})

test('printing failures surface to the shell and never silently export or mark a document saved', async () => {
  const h=shell(), tab=h.tab('failed-print',{dirty:true})
  h.rustWordHandle.print=async()=>{throw Error('系统打印窗口未能启动')}
  h.active(tab);h.state.home.value=false
  h.state.globalFileAction('print');await h.idle()
  assert.match(h.state.error.value,/系统打印窗口未能启动/)
  assert.equal(tab.dirty,true)
  assert.equal(h.calls.filter(call=>['save','download','marked'].includes(call[0])).length,0)
  h.unmount()
})

test('a ready editor without printing disables the button and explains keyboard requests', async () => {
  const h=shell(), tab=h.tab('unsupported-print')
  h.active(tab);h.state.home.value=false
  assert.equal(h.state.documentActionsDisabled.value,false)
  assert.equal(h.state.printDisabled.value,true)
  h.state.rustEditorFileAction('print');await h.idle()
  assert.match(h.state.error.value,/当前文档尚不能打印/)
  assert.equal(h.calls.filter(call=>['save','download'].includes(call[0])).length,0)
  h.unmount()
})

function mountSheetHandle(h,tab,overrides={}) {
  const handle={canBackgroundExport:async()=>true,prepareDeactivate:async()=>({documentId:1,revision:0,dirty:tab.dirty}),exportFile:async({format})=>({base64:'U0hFRVQ=',extension:format,dirty:true}),
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

for(const route of ['native','recent','browser'])test(`generic ${route} XLSX opening retains parser warnings without forcing a copy`,async()=>{
  const warning='Controlled parser warning: unsupported chart detail'
  const h=shell({nativeEnabled:route!=='browser',sheetWarnings:[warning]}),source=sheetSource(route)
  if(route==='native'){h.native.openDocument=async()=>source;h.state.openFile();await h.idle()}
  else if(route==='recent'){h.native.openRecent=async id=>{assert.equal(id,'recent');return source};h.state.openRecent({id:'recent'});await h.idle()}
  else {
    const bytes=zipSync({"xl/workbook.xml":strToU8("<workbook/>")}),input={value:'Source.xlsx',files:[{name:'Source.xlsx',size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}
    await h.state.browserFile({target:input});assert.equal(input.value,'')
  }
  const tab=h.state.active.value
  assert.equal(tab.requiresSaveAs,false)
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
  h.handle.prepareDeactivate=async()=>{throw Error('Composition pending')}
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

test('spreadsheet saves update the original XLSX destination with conflict protection',async()=>{
  const h=shell();await h.state.addDocument(sheetSource('original'),'original')
  const tab=h.state.active.value;mountSheetHandle(h,tab);tab.dirty=true
  const save=h.native.saveDocument
  h.native.saveDocument=async request=>{h.calls.push(['cancelled-sheet-save',request]);return{status:'cancelled'}}
  assert.equal(await h.state.saveActive(),false)
  assert.equal(tab.dirty,true);assert.equal(tab.requiresSaveAs,false);assert.equal(tab.fileId,'original')
  assert.ok(!h.calls.some(c=>c[0]==='sheet-marked'))
  h.native.saveDocument=save;assert.equal(await h.state.saveActive(),true)
  for(const [,request] of h.calls.filter(c=>['save','cancelled-sheet-save'].includes(c[0]))) {
    assert.equal(request.saveAs,false);assert.equal(request.documentId,'original');assert.equal(request.expectedSha256,'source-hash')
    assert.equal(request.name,'original.xlsx')
  }
  assert.equal(tab.fileId,'original');assert.equal(tab.requiresSaveAs,false);assert.equal(tab.dirty,false)
  assert.equal(h.calls.filter(c=>c[0]==='sheet-marked').length,1)
  h.unmount()
})

for(const extension of ['csv','tsv'])test(`${extension} conversion retains its separate-save requirement after switching documents`,async()=>{
  const h=shell();await h.state.addDocument(sheetSource('source-data',extension),'source-data')
  const source=h.state.active.value;mountSheetHandle(h,source)
  const other=h.tab('other-document')
  try {
    assert.equal(source.requiresSaveAs,true)
    await h.state.activate(other);h.state.readyFor(other.key)
    await h.state.activate(source)
    assert.equal(source.document.extension,extension);assert.equal(source.requiresSaveAs,true)
    assert.equal(source.document.base64,'T0xE');assert.equal(source.document.sha256,'source-hash');assert.equal(source.fileId,'source-data')
    assert.equal(await h.state.saveActive(),true)
    const request=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(request.extension,'xlsx');assert.equal(request.saveAs,true)
    assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined)
    assert.notEqual(source.fileId,'source-data');assert.equal(source.requiresSaveAs,false)
  } finally {h.unmount()}
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
  const h=shell(),settled=[],exports=[]
  await h.state.addDocument(sheetSource('first'),'first');const first=h.state.active.value
  mountSheetHandle(h,first,{prepareDeactivate:async()=>{settled.push(first.key);return{documentId:1,revision:3,dirty:true}},exportFile:async()=>{exports.push(first.key);return{base64:'RklSU1Q=',extension:'xlsx',dirty:true}}})
  const firstEntry=h.state.rustSheetEntries.value[0]
  await h.state.addDocument(sheetSource('second'),'second');const second=h.state.active.value
  mountSheetHandle(h,second,{prepareDeactivate:async()=>{settled.push(second.key);return{documentId:1,revision:3,dirty:true}},exportFile:async()=>{exports.push(second.key);return{base64:'U0VDT05E',extension:'xlsx',dirty:true}}})
  const secondEntry=h.state.rustSheetEntries.value[1]
  await h.state.activate(first);await h.state.activate(second)
  assert.deepEqual(settled,[first.key,second.key,first.key]);assert.deepEqual(exports,[])
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
    prepareDeactivate:async()=>({documentId:1,revision:0,dirty:tab.dirty}),
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

for(const extension of ['pptx','potx','ppsx'])for(const route of ['native','recent','browser'])test(`${route} ${extension} uses direct saving except when template conversion is required`,async()=>{
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
  const conversion=extension!=='pptx'
  assert.equal(tab.requiresSaveAs,conversion);assert.equal(h.deckPreparations.length,1)
  assert.equal(entry.prepared,h.deckPreparations[0].handoff)
  assert.equal(h.deckPreparations[0].source.id,tab.key);assert.equal(h.deckPreparations[0].source.base64,tab.document.base64)
  assert.equal(h.rustPreparations.length,0);assert.equal(h.sheetPreparations.length,0)
  mountDeckHandle(h,tab);h.state.openSaveAs()
  assert.deepEqual(Array.from(h.state.saveAsOptions.value,option=>option.extension),['pptx','pdf'])
  assert.equal(h.state.saveAsDraft.value.format,'pptx')
  h.state.cancelSaveAs();assert.equal(await h.state.saveActive(),true)
  const expectedName=conversion?'Original - 副本.pptx':'Original.pptx'
  if(route==='browser')assert.equal(h.calls.find(call=>call[0]==='download')[1],expectedName)
  else {
    const request=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(request.name,expectedName);assert.equal(request.extension,'pptx')
    assert.equal(request.documentId,conversion?undefined:source.id);assert.equal(request.expectedSha256,conversion?undefined:source.sha256);assert.equal(request.saveAs,conversion)
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

test('presentation preparations capture source bytes and are discarded if input settlement or disposal prevents publication',async()=>{
  const h=shell(),tab=h.tab('live',{dirty:true});h.active(tab)
  h.rustWordHandle.prepareDeactivate=async()=>{throw Error('Composition pending')}
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
  const h=shell(),settled=[],exports=[],undo=[]
  await h.state.addDocument(deckSource('first'),'first');const first=h.state.active.value
  mountDeckHandle(h,first,{prepareDeactivate:async()=>{settled.push(first.key);return{documentId:1,revision:3,dirty:true}},exportFile:async()=>{exports.push(first.key);return{base64:'RklSU1Q=',extension:'pptx',dirty:true}},undo:async()=>{undo.push(first.key)}})
  const firstEntry=h.state.rustPresentationEntries.value[0]
  await h.state.addDocument(deckSource('second'),'second');const second=h.state.active.value
  mountDeckHandle(h,second,{prepareDeactivate:async()=>{settled.push(second.key);return{documentId:1,revision:3,dirty:true}},exportFile:async()=>{exports.push(second.key);return{base64:'U0VDT05E',extension:'pptx',dirty:true}},undo:async()=>{undo.push(second.key)}})
  const secondEntry=h.state.rustPresentationEntries.value[1]
  await h.state.activate(first);await h.state.activate(second)
  h.state.globalFileAction('undo');await h.idle()
  assert.deepEqual(undo,[second.key]);assert.deepEqual(settled,[first.key,second.key,first.key]);assert.deepEqual(exports,[])
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
  handle.prepareDeactivate=async()=>{throw Error('Apply the pending slide text')}
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

test('full native smoke requires four Rust editors, notebook, workflows, MCP and actual workspace persistence gates',async()=>{
  const h=shell({smoke:true});h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,true);assert.equal(report.word.ok,true);assert.equal(report.sheet.ok,true);assert.equal(report.presentation.ok,true)
  assert.equal(report.pdf.reopened,true);assert.equal(report.pdf.removedOldText,true);assert.equal(report.pdf.newTextPresent,true);assert.equal(report.notebook.ok,true);assert.equal(report.workflow.ok,true);assert.equal(report.workspace.ok,true)
  assert.equal(report.mcp.ok,true)
  assert.deepEqual(h.calls.filter(call=>call[0].endsWith('-native-smoke')).map(call=>call[0]),['office-word-native-smoke','office-sheet-native-smoke','office-presentation-native-smoke','pdf-native-smoke','notebook-native-smoke','workflow-native-smoke','mcp-native-smoke','workspace-native-smoke'])
  assert.equal(h.calls.filter(call=>call[0]==='notebook-native-smoke').length,1)
  assert.equal(h.calls.filter(call=>call[0]==='workflow-native-smoke').length,1)
  assert.equal(h.calls.filter(call=>call[0]==='workspace-native-smoke').length,1)
  assert.equal(report.pdf.engine,'office-pdf-wasm')
  for(const old of ['office','independentWordPackage','rustWordEngine','wordWorkbench','sheetWorkbench','presentationWorkbench'])assert.equal(Object.hasOwn(report,old),false)
  h.unmount()
})

test('full native smoke waits for notebook verification before shared workspace cleanup',async()=>{
  let finishNotebook,started
  const waiting=new Promise(resolve=>{finishNotebook=resolve}),entered=new Promise(resolve=>{started=resolve})
  const h=shell({smoke:true,notebookSmokeRun:()=>{started();return waiting}});h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  const mounted=h.mount()
  await entered
  assert.equal(h.calls.some(call=>call[0]==='notebook-native-smoke'),true)
  assert.equal(h.calls.some(call=>call[0]==='workflow-native-smoke'),false)
  assert.equal(h.calls.some(call=>call[0]==='workspace-native-smoke'),false)
  assert.equal(h.calls.some(call=>call[0]==='invoke'&&call[1]==='smoke_report'),false)
  finishNotebook({ok:true,kind:'notebook-native'});await mounted
  assert.equal(h.calls.filter(call=>call[0]==='workspace-native-smoke').length,1)
  assert.equal(h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report.ok,true)
  h.unmount()
})

for(const mode of ['report','throw','cleanup','missing'])test(`failed notebook ${mode} prevents native success and subsequent workspace verification`,async()=>{
  const failure='Controlled notebook failure'
  const options=mode==='throw'?{notebookSmokeError:failure}:mode==='cleanup'?{notebookSmokeReport:{ok:false,cleanupError:failure}}:
    mode==='missing'?{notebookSmokeReport:{}}:{notebookSmokeReport:{ok:false,error:failure}}
  const h=shell({smoke:true,...options});h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,mode==='missing'?/Native notebook verification failed/:/Controlled notebook failure/)
  for(const engine of ['word','sheet','presentation','pdf'])assert.equal(report[engine].ok,true)
  assert.equal(h.calls.filter(call=>call[0]==='notebook-native-smoke').length,1)
  assert.equal(h.calls.some(call=>call[0]==='workflow-native-smoke'),false)
  assert.equal(Object.hasOwn(report,'workflow'),false)
  assert.equal(h.calls.some(call=>call[0]==='workspace-native-smoke'),false)
  assert.equal(Object.hasOwn(report,'workspace'),false)
  h.unmount()
})

test('full native smoke waits for both workflow editors before shared workspace cleanup',async()=>{
  let finishWorkflow,started
  const waiting=new Promise(resolve=>{finishWorkflow=resolve}),entered=new Promise(resolve=>{started=resolve})
  const h=shell({smoke:true,workflowSmokeRun:()=>{started();return waiting}});h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  const mounted=h.mount()
  await entered
  assert.equal(h.calls.some(call=>call[0]==='notebook-native-smoke'),true)
  assert.equal(h.calls.some(call=>call[0]==='workflow-native-smoke'),true)
  assert.equal(h.calls.some(call=>call[0]==='workspace-native-smoke'),false)
  assert.equal(h.calls.some(call=>call[0]==='invoke'&&call[1]==='smoke_report'),false)
  finishWorkflow({ok:true,kind:'workflow-native'});await mounted
  assert.equal(h.calls.filter(call=>call[0]==='workspace-native-smoke').length,1)
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,true);assert.equal(report.workflow.ok,true)
  h.unmount()
})

for(const mode of ['report','throw','cleanup','missing'])test(`failed workflow ${mode} prevents native success and subsequent workspace verification`,async()=>{
  const failure='Controlled workflow failure'
  const options=mode==='throw'?{workflowSmokeError:failure}:mode==='cleanup'?{workflowSmokeReport:{ok:false,cleanupError:failure}}:
    mode==='missing'?{workflowSmokeReport:{}}:{workflowSmokeReport:{ok:false,error:failure}}
  const h=shell({smoke:true,...options});h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,mode==='missing'?/Native workflow verification failed/:/Controlled workflow failure/)
  for(const engine of ['word','sheet','presentation','pdf','notebook'])assert.equal(report[engine].ok,true)
  assert.equal(h.calls.filter(call=>call[0]==='workflow-native-smoke').length,1)
  assert.equal(h.calls.some(call=>call[0]==='workspace-native-smoke'),false)
  assert.equal(Object.hasOwn(report,'workspace'),false)
  h.unmount()
})

for (const mode of ['report', 'throw']) test(`failed native MCP ${mode} prevents a successful full native acceptance report`, async () => {
  const options = mode === 'report' ? { mcpSmokeReport: { ok: false, error: 'Controlled MCP verification failure' } } : { mcpSmokeError: 'Controlled MCP verification failure' }
  const h = shell({ smoke: true, ...options })
  try {
    h.native.bootstrap = async () => ({ smokeMode: true, smokeScope: 'full' })
    await h.mount()
    const report = h.calls.find(call => call[0] === 'invoke' && call[1] === 'smoke_report')[2].report
    assert.equal(report.ok, false)
    assert.match(report.error, /Controlled MCP verification failure/)
    assert.equal(h.calls.filter(call => call[0] === 'mcp-native-smoke').length, 1)
    assert.equal(h.calls.some(call => call[0] === 'workspace-native-smoke'), false)
  } finally { h.unmount() }
})

for(const mode of ['report','throw'])test(`failed workspace ${mode} prevents a full native release pass after editor verification`,async()=>{
  const h=shell({smoke:true,...(mode==='report'?{workspaceSmokeReport:{ok:false,error:'Controlled workspace failure'}}:{workspaceSmokeError:'Controlled workspace failure'})})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,/Controlled workspace failure/)
  assert.equal(report.word.ok,true);assert.equal(report.sheet.ok,true);assert.equal(report.presentation.ok,true);assert.equal(report.pdf.ok,true);assert.equal(report.notebook.ok,true);assert.equal(report.workflow.ok,true)
  assert.equal(h.calls.filter(call=>call[0]==='workspace-native-smoke').length,1)
  if(mode==='report')assert.equal(report.workspace.ok,false)
  h.unmount()
})

test('native file persistence verification does not depend on removed browser workspace fixtures',async()=>{
  const h=shell({smoke:true,sheetSmokeReport:{ok:true,engine:'office-sheet-wasm'}})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,true);assert.equal(report.notebook.ok,true);assert.equal(report.workspace.ok,true)
  assert.equal(h.calls.filter(call=>call[0]==='workspace-native-smoke').length,1)
  h.unmount()
})

for(const mode of ['report','throw'])test(`failed presentation ${mode} fails native release evidence before PDF verification`,async()=>{
  const h=shell({smoke:true,...(mode==='report'?{presentationSmokeReport:{ok:false,error:'Controlled deck failure'}}:{presentationSmokeError:'Controlled deck failure'})})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,/Controlled deck failure/)
  assert.ok(!h.calls.some(call=>call[0]==='pdf-native-smoke'));h.unmount()
})


test('switching cannot adopt an export of another format and close validation rejects that export',async()=>{
  const h=shell(),first=h.tab('first'),second=h.tab('second');h.active(first)
  let exports=0
  h.rustWordHandle.exportFile=async()=>{exports++;return {base64:'JVBERg==',extension:'pdf',dirty:true}}
  await h.state.activate(second);h.state.readyFor(second.key);await h.state.activate(first)
  assert.equal(exports,0,'Switching keeps the live model without requesting export bytes')
  assert.equal(first.document.extension,'docx');assert.equal(first.document.base64,'T0xE')
  h.state.closeTab(first);await h.idle()
  assert.equal(exports,1);assert.match(h.state.error.value,/快照格式/)
  assert.equal(first.document.extension,'docx');assert.equal(first.document.base64,'T0xE');assert.equal(h.state.activeKey.value,first.key)
  assert.equal(first.dirty,true);assert.equal(h.state.closeTarget.value,first,'Failed close validation still requires a user decision')
  assert.ok(!h.calls.some(call=>call[0]==='discard'||call[0]==='save'||call[0]==='marked'));h.unmount()
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
test('PDF tab switches retain each live model, handle and original save destination',async()=>{
  const h=shell(),settled=[],exported=[],undone=[]
  async function opened(id){
    await h.state.addDocument(pdfSource(id),id)
    const tab=h.state.active.value
    h.state.setRustPdfHandle(tab.key,{prepareDeactivate:async()=>{settled.push(id);return{documentId:1,revision:3,dirty:true}},exportFile:async()=>{exported.push(id);return{base64:btoa(id),extension:'pdf',dirty:true}},discardChanges:async()=>{},undo:async()=>undone.push(id)})
    h.state.readyFor(tab.key)
    return tab
  }
  const first=await opened('first'),firstEntry=h.state.rustPdfEntries.value[0]
  const second=await opened('second'),secondEntry=h.state.rustPdfEntries.value[1]
  await h.state.activate(first);await h.state.activate(second)
  h.state.globalFileAction('undo');await h.idle()
  assert.deepEqual(settled,['first','second','first']);assert.deepEqual(exported,[]);assert.deepEqual(undone,['second'])
  assert.equal(first.ready,true);assert.equal(second.ready,true)
  assert.equal(first.requiresSaveAs,false);assert.equal(second.requiresSaveAs,false)
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

async function settleShell() {
  for(let n=0;n<20;n++){await Promise.resolve();await vue.nextTick()}
}


test('manual save cannot overlap autosave and later acknowledges its own exact exported bytes',async()=>{
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
    assert.equal(bytes,savedReceipt)
    h.calls.push(['marked',bytes])
  }
  try {
    const background=h.state.editorTransaction('Autosave',()=>h.state.saveActive(false,undefined,undefined,{key:original.key,fileId:original.fileId}),true)
    await settleShell()
    await assert.rejects(h.state.editorTransaction('Manual save',()=>h.state.saveActive()),/另一项/)
    assert.equal(exports,1)
    assert.equal(h.calls.some(call=>call[0]==='save'),false)
    release();await background
    original.dirty=true
    assert.equal(await h.state.editorTransaction('Manual save',()=>h.state.saveActive()),true)
    assert.equal(exports,2)
    assert.deepEqual(h.calls.filter(call=>call[0]==='save').map(call=>call[1].base64),['QkdST1VORA==','U0FWRUQ='])
    assert.equal(original.dirty,false)
    assert.deepEqual(h.calls.filter(call=>call[0]==='marked').map(call=>call[1]),['QkdST1VORA==','U0FWRUQ='])
  } finally {release();h.unmount()}
})


test('eight documents per kind reject a ninth before preparation while existing files and other kinds remain usable',async()=>{
  for(const kind of ['word','sheet','presentation','pdf']) {
    const h=shell(),opened=[]
    for(let index=0;index<8;index++){const tab=h.tab(`capacity-${index}`,{kind,dirty:true});h.active(tab);opened.push(tab)}
    const active=opened.at(-1),extension=active.document.extension
    const before=JSON.stringify(h.state.tabs.value)
    h.handle.prepareDeactivate=async()=>assert.fail('Capacity rejection must not settle the active document')
    h.handle.exportFile=async()=>assert.fail('Neither rejected capacity nor ordinary switching should serialize the active document')
    try {
      await assert.rejects(h.state.addDocument({...active.document,id:'ninth',name:`Ninth.${extension}`},'ninth-file'),/最多同时打开 8 份/)
      assert.equal(h.calls.length,0,'Capacity must be checked before preflight, stash or disposal')
      assert.equal(JSON.stringify(h.state.tabs.value),before);assert.equal(h.state.activeKey.value,active.key)
      let settlements=0
      h.handle.prepareDeactivate=async()=>{settlements++;return {documentId:1,revision:3,dirty:true}}
      assert.equal(await h.state.addDocument(opened[0].document,opened[0].fileId),opened[0])
      assert.equal(h.state.activeKey.value,opened[0].key);assert.equal(h.state.tabs.value.length,8)
      assert.equal(settlements,1);assert.equal(h.calls.some(call=>call[0].endsWith('-preflight')),false)
      const otherKind=kind==='word'?'sheet':'word',otherExtension=otherKind==='word'?'docx':'xlsx'
      const other=await h.state.addDocument({id:'other',kind:otherKind,extension:otherExtension,name:`Other.${otherExtension}`,base64:'T0xE',sha256:'',sizeBytes:3})
      assert.equal(other.document.kind,otherKind);assert.equal(h.state.activeKey.value,other.key)
      assert.equal(h.state.tabs.value.length,9);assert.equal(h.state.tabs.value.filter(tab=>tab.document.kind===kind).length,8)
      assert.equal(h.calls.filter(call=>call[0].endsWith('-preflight')).length,1)
    } finally {h.unmount()}
  }
})

test('new notebook uses its own editor and the shared save and undo controls',async()=>{
  const h=shell()
  try {
    h.state.globalNewDocument('note');await h.idle()
    const tab=h.state.active.value,handle=backgroundHandle(h,tab)
    assert.equal(tab.document.kind,'note');assert.equal(tab.document.extension,'oonote')
    assert.equal(h.state.activeNote.value,true);assert.equal(h.state.noteEntries.value.length,1)
    assert.equal(tab.dirty,true);assert.equal(tab.ready,false);assert.equal(tab.fileId,undefined)
    assert.ok(!h.calls.some(call=>call[0].endsWith('-preflight')||call[0]==='note-decode'),'Blank notebooks require neither a Rust model nor imported bytes')
    h.state.readyFor(tab.key)
    handle.exportFile=async({format})=>{assert.equal(format,'oonote');return {base64:'Tk9URQ==',extension:'oonote',dirty:true}}
    handle.undo=async()=>h.calls.push(['note-undo',tab.key])
    handle.markSaved=async bytes=>{assert.equal(bytes,'Tk9URQ==');h.calls.push(['note-marked',bytes])}
    h.state.globalFileAction('undo');await h.idle()
    h.state.openSaveAs()
    assert.deepEqual(Array.from(h.state.saveAsOptions.value,option=>option.extension),['oonote'])
    h.state.cancelSaveAs()
    let prevented=0;h.state.keydown({key:'s',ctrlKey:true,preventDefault(){prevented++}});await h.idle()
    assert.equal(prevented,1);assert.deepEqual(h.calls.filter(call=>call[0]==='note-undo'),[['note-undo',tab.key]])
    const request=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(request.extension,'oonote');assert.equal(request.saveAs,true);assert.equal(request.documentId,undefined)
    assert.equal(tab.document.kind,'note');assert.equal(tab.dirty,false)
    assert.equal(h.calls.filter(call=>call[0]==='note-marked').length,1)
    assert.equal(h.state.rustWordEntries.value.length,0);assert.equal(h.state.rustSheetEntries.value.length,0)
  } finally {h.unmount()}
  assert.equal(h.state.noteEntries.value.length,0);assert.equal(h.state.noteHandles.size,0)
})

for(const route of ['native','recent','browser'])test(`${route} notebook opening validates before mounting and saves through the notebook editor`,async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({format:'open-office-notebook',version:1,sections:[]}))
  const source={id:'local-notebook',kind:'note',extension:'oonote',name:'Research.oonote',base64:Buffer.from(bytes).toString('base64'),sha256:'note-hash',sizeBytes:bytes.length}
  const h=shell({nativeEnabled:route!=='browser'})
  try {
    if(route==='native') {h.native.openDocument=async()=>source;h.state.openFile();await h.idle()}
    else if(route==='recent') {h.native.openRecent=async()=>source;h.state.openRecent({id:source.id});await h.idle()}
    else await h.state.browserFile({target:{value:source.name,files:[{name:source.name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}})
    const tab=h.state.active.value,handle=backgroundHandle(h,tab)
    assert.equal(tab.document.kind,'note');assert.equal(tab.requiresSaveAs,false)
    assert.equal(h.state.noteEntries.value[0].document.id,tab.key)
    assert.equal(h.calls.filter(call=>call[0]==='note-decode').length,1)
    assert.ok(!h.calls.some(call=>call[0].endsWith('-preflight')))
    h.state.readyFor(tab.key);tab.dirty=true
    handle.exportFile=async({format})=>{assert.equal(format,'oonote');return {base64:source.base64,extension:'oonote',dirty:true}}
    assert.equal(await h.state.saveActive(),true)
    if(route==='browser')assert.equal(h.calls.find(call=>call[0]==='download')[1],source.name)
    else {
      const request=h.calls.find(call=>call[0]==='save')[1]
      assert.equal(request.documentId,source.id);assert.equal(request.expectedSha256,source.sha256)
      assert.equal(request.name,source.name);assert.equal(request.saveAs,false)
    }
    assert.equal(tab.dirty,false)
  } finally {h.unmount()}
})

test('invalid notebook input cannot replace the active document or publish a new tab',async()=>{
  const h=shell({notebookDecodeError:'Invalid notebook structure'}),original=h.tab('unsaved-word',{dirty:true})
  h.active(original);h.rustWordHandle.exportFile=async()=>assert.fail('Rejected notebook must not touch the active draft')
  try {
    await assert.rejects(h.state.addDocument({id:'broken-note',kind:'note',extension:'oonote',name:'Broken.oonote',base64:'e30=',sha256:'',sizeBytes:2},'broken-note'),/Invalid notebook structure/)
    assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,original.key)
    assert.equal(original.dirty,true);assert.equal(h.state.noteEntries.value.length,0)
    assert.equal(h.state.rustWordHandles.get(original.key),h.rustWordHandle)
  } finally {h.unmount()}
})

test('switching keeps a new unsaved document dirty even when its untouched live engine is clean', async () => {
  const h=shell(), first=h.tab('new',{dirty:true}), next=h.tab('next')
  first.fileId=undefined;h.active(first)
  h.handle.prepareDeactivate=async()=>({documentId:1,revision:0,dirty:false})
  h.handle.exportFile=async()=>assert.fail('Switching must not generate a save receipt')
  try {
    await h.state.activate(next)
    assert.equal(first.dirty,true)
    h.state.closeTab(first)
    assert.equal(h.state.closeTarget.value,first,'An unsaved new file still requires a close decision')
    assert.equal(h.state.tabs.value.length,2)
  } finally {h.unmount()}
})

for (const replaceHandle of [false,true]) test(`switching rejects a ${replaceHandle?'replaced editor handle':'changed active tab'} during input settlement`, async () => {
  const h=shell(), first=h.tab('first'), next=h.tab('next');h.active(first)
  let finish
  h.handle.prepareDeactivate=()=>new Promise(resolve=>{finish=resolve})
  const switching=h.state.activate(next)
  if(replaceHandle)h.state.setRustWordHandle(first.key,{prepareDeactivate:async()=>({documentId:2,revision:0,dirty:false})})
  else h.state.activeKey.value=next.key
  finish({documentId:1,revision:1,dirty:true})
  try {
    await assert.rejects(switching,/文档已切换/)
    assert.equal(first.dirty,false,'A late result from a retired lifecycle cannot be applied to the old tab')
    assert.equal(first.document.base64,'T0xE');assert.equal(first.document.sha256,'old-hash')
  } finally {h.unmount()}
})

for (const kind of ['word', 'sheet', 'presentation', 'pdf', 'note', 'canvas', 'diagram', 'schedule']) test(`${kind} shell starts MCP only for its ready active document and advertises its own tools`, async () => {
  const h = shell(), tab = h.tab(`mcp-${kind}`, { kind })
  try {
    h.active(tab)
    await h.state.toggleMcp()
    assert.equal(h.mcpCalls.some(call => call[0] === 'start'), false, 'The workbench must not expose a background document')
    h.state.home.value = false
    await h.state.toggleMcp()
    assert.equal(h.state.mcpState.value.phase, 'running')
    const start = h.mcpCalls.find(call => call[0] === 'start')
    assert.equal(start[2].id, tab.key)
    assert.equal(start[2].kind, kind)
    assert.equal(start[2].title, tab.document.name)
    assert.ok(start[3].length > 0, 'Every editor must provide usable tools')
    assert.ok(start[3].some(tool => tool.annotations?.readOnlyHint === true))
    await h.state.toggleMcp()
    assert.equal(h.state.mcpState.value.phase, 'stopped')
  } finally { h.unmount() }
})

test('MCP shell automatically stops when switching tabs or returning to the workbench', async () => {
  const h = shell(), first = h.tab('mcp-first'), second = h.tab('mcp-second', { kind: 'sheet' })
  try {
    h.active(first); h.state.home.value = false
    await h.state.toggleMcp()
    await h.state.activate(second)
    await settleShell()
    assert.equal(h.state.mcpState.value.phase, 'stopped')
    assert.equal(h.mcpCalls.filter(call => call[0] === 'start').length, 1)
    h.state.readyFor(second.key)
    await h.state.toggleMcp()
    assert.equal(h.state.mcpState.value.documentId, second.key)
    h.state.home.value = true
    assert.equal(h.state.mcpState.value.phase, 'stopping', 'The synchronous watcher must revoke before the next UI tick')
    await settleShell()
    assert.equal(h.state.mcpState.value.phase, 'stopped')
    h.state.home.value = false
    await settleShell()
    assert.equal(h.mcpCalls.filter(call => call[0] === 'start').length, 2, 'Reopening the editor never starts MCP automatically')
  } finally { h.unmount() }
})

test('MCP shell switching during pending start cannot publish a stale Running state', async () => {
  const h = shell(), first = h.tab('pending-start'), second = h.tab('next-document')
  let finish, entered = false
  h.mcpNative.mcpTransport.start = async () => {
    entered = true
    return new Promise(resolve => { finish = resolve })
  }
  try {
    h.active(first); h.state.home.value = false
    const startup = h.state.toggleMcp()
    for (let turn = 0; turn < 30 && !entered; turn++) await Promise.resolve()
    assert.equal(entered, true)
    h.state.activeKey.value = second.key
    finish({ running: true, sessionId: 'late-session', documentId: first.key, endpoint: 'http://127.0.0.1:38487/mcp', port: 38487 })
    await startup; await settleShell()
    assert.equal(h.state.mcpState.value.phase, 'stopped')
    assert.ok(h.mcpCalls.some(call => call[0] === 'stop' && call[1] === 'late-session'))
  } finally { h.unmount() }
})

test('MCP settings use the global modal barrier and stop the previous session before persisting', async () => {
  const h = shell(), tab = h.tab('mcp-settings')
  try {
    h.active(tab); h.state.home.value = false
    await h.state.toggleMcp()
    h.state.openMcpSettings()
    assert.equal(h.state.globalActionsBlocked.value, true)
    assert.equal(h.state.editorInputBlocked.value, true)
    const configuration = { ...h.state.mcpConfig.value, port: 38489, allowEdits: false }
    await h.state.saveMcpSettings(configuration)
    const stoppedIndex = h.mcpCalls.findIndex(call => call[0] === 'stop')
    const savedIndex = h.mcpCalls.findIndex(call => call[0] === 'save-config')
    assert.ok(stoppedIndex >= 0 && savedIndex > stoppedIndex, 'A running listener must not survive a configuration change')
    assert.equal(h.state.mcpState.value.phase, 'stopped')
    assert.equal(h.state.mcpSettingsOpen.value, false)
    assert.equal(h.state.globalActionsBlocked.value, false)
    assert.equal(h.state.mcpConfig.value.port, 38489)
    await h.state.toggleMcp()
    const restart = h.mcpCalls.filter(call => call[0] === 'start').at(-1)
    assert.equal(restart[1].port, 38489)
    assert.ok(restart[3].every(tool => tool.annotations?.readOnlyHint === true))
  } finally { h.unmount() }
})

test('MCP configuration read and startup failures never expose Running', async () => {
  for (const failingOperation of ['get-config', 'start']) {
    const h = shell(), tab = h.tab('mcp-error')
    try {
      h.active(tab); h.state.home.value = false
      if (failingOperation === 'get-config') h.mcpNative.getMcpConfig = async () => { throw Error('Unable to read settings') }
      else h.mcpNative.mcpTransport.start = async () => { throw Error('Port unavailable') }
      await h.state.toggleMcp()
      assert.notEqual(h.state.mcpState.value.phase, 'running')
      if (failingOperation === 'get-config') {
        assert.equal(h.state.mcpSettingsOpen.value, true)
        assert.match(h.state.mcpSettingsError.value, /Unable to read settings/)
        assert.equal(h.mcpCalls.some(call => call[0] === 'start'), false)
      } else {
        assert.equal(h.state.mcpState.value.phase, 'error')
        assert.match(h.state.error.value, /Port unavailable/)
      }
    } finally { h.unmount() }
  }
})

test('MCP is unavailable in the browser preview and never claims a native running service', async () => {
  const h = shell({ nativeEnabled: false }), tab = h.tab('browser-mcp')
  try {
    h.active(tab); h.state.home.value = false
    await h.state.toggleMcp()
    assert.equal(h.state.mcpSettingsOpen.value, true)
    assert.equal(h.state.mcpState.value.phase, 'stopped')
    assert.equal(h.mcpCalls.length, 0)
  } finally { h.unmount() }
})

test('MCP requests cannot execute while the settings dialog or another file transaction owns the editor', async () => {
  for (const blockedBy of ['settings', 'busy']) {
    const h = shell(), tab = h.tab(`mcp-blocked-${blockedBy}`)
    try {
      h.active(tab); h.state.home.value = false
      await h.state.toggleMcp()
      if (blockedBy === 'settings') h.state.openMcpSettings()
      else h.state.busy.value = 'Controlled file transaction'
      const catalog = h.mcpCalls.find(call => call[0] === 'start')[3]
      h.emitMcp({ toolName: catalog.find(tool => tool.annotations?.readOnlyHint === true).name })
      await settleShell()
      assert.equal(h.mcpResults.length, 1)
      assert.equal(h.mcpResults[0].result.isError, true)
      assert.match(h.mcpResults[0].result.content[0].text, /正在编辑或处理其他操作/)
      assert.equal(h.state.mcpWorking.value, false)
    } finally { h.state.busy.value = ''; h.unmount() }
  }
})

test('MCP mutation ownership blocks local editing and postpones automatic saving', async () => {
  const h = shell({ storedAutosave: 'true' }), tab = h.tab('mcp-autosave', { dirty: true })
  try {
    h.active(tab); h.state.home.value = false
    await h.mount()
    h.state.mcpWorking.value = true
    h.state.mcpMutating.value = true
    assert.equal(h.state.globalActionsBlocked.value, true)
    assert.equal(h.state.editorInputBlocked.value, true)
    await h.fireTimeout(10000)
    assert.equal(h.calls.some(call => call[0] === 'save'), false, 'Autosave must not capture a half-applied remote change')
    h.state.mcpWorking.value = false
    h.state.mcpMutating.value = false
    assert.equal(h.state.globalActionsBlocked.value, false)
    await h.fireTimeout(10000)
    assert.ok(h.calls.some(call => call[0] === 'save'))
  } finally { h.unmount() }
})

for (const readOnly of [true, false]) test(`MCP actual dispatcher ${readOnly ? 'preserves read focus and input' : 'locks input during mutations'} while holding global file actions`, async () => {
  const h = shell(), tab = h.tab('mcp-dispatch')
  const toolName = readOnly ? 'document_inspect' : 'document_undo'
  let release, entered = false, blurred = 0
  const waiting = new Promise(resolve => { release = resolve })
  const focused = new h.browser.HTMLElement()
  focused.blur = () => { blurred++; h.browser.document.activeElement = null }
  h.browser.document.activeElement = focused
  h.rustWordHandle.mcpExecute = async (name, arguments_, assertCurrent) => {
    assert.equal(name, toolName)
    assert.equal(Object.keys(arguments_).length, 0)
    entered = true
    await waiting
    assertCurrent()
    return { documentId: 17, revision: 2, dirty: true }
  }
  try {
    h.active(tab); h.state.home.value = false
    await h.state.saveMcpSettings({ ...h.state.mcpConfig.value, allowEdits: true })
    await h.state.toggleMcp()
    h.emitMcp({ toolName })
    await settleShell()
    assert.equal(entered, true)
    assert.equal(h.state.mcpWorking.value, true)
    assert.equal(h.state.mcpMutating.value, !readOnly)
    assert.equal(h.state.globalActionsBlocked.value, true)
    assert.equal(h.state.editorInputBlocked.value, !readOnly)
    assert.equal(blurred, readOnly ? 0 : 1)
    if (readOnly) assert.equal(h.browser.document.activeElement, focused)
    release(); await settleShell()
    assert.equal(h.state.mcpWorking.value, false)
    assert.equal(h.state.mcpMutating.value, false)
    assert.equal(h.state.globalActionsBlocked.value, false)
    assert.equal(h.mcpResults.length, 1)
    assert.equal(h.mcpResults[0].result.isError, undefined)
    assert.deepEqual(JSON.parse(h.mcpResults[0].result.content[0].text), { documentId: 17, revision: 2, dirty: true })
  } finally { release(); h.unmount() }
})

for (const readOnly of [true, false]) test(`MCP ${readOnly ? 'read' : 'write'} refuses unsettled local input without blurring or acquiring the edit barrier`, async () => {
  const h = shell(), tab = h.tab('mcp-unsettled')
  let blurred = 0, probes = 0, executions = 0
  const focused = new h.browser.HTMLElement(), transitions = []
  focused.blur = () => { blurred++ }
  h.browser.document.activeElement = focused
  h.rustWordHandle.canBackgroundExport = async () => { probes++; return false }
  h.rustWordHandle.mcpExecute = async () => { executions++; assert.fail('A pending gesture, paste or dialog must retain editor ownership') }
  const unwatch = vue.watch(h.state.mcpMutating, value => transitions.push(value), { flush: 'sync' })
  try {
    h.active(tab); h.state.home.value = false
    await h.state.saveMcpSettings({ ...h.state.mcpConfig.value, allowEdits: true })
    await h.state.toggleMcp()
    h.emitMcp({ toolName: readOnly ? 'document_inspect' : 'document_undo' })
    await settleShell()
    assert.equal(probes, 1)
    assert.equal(executions, 0)
    assert.equal(blurred, 0)
    assert.equal(h.browser.document.activeElement, focused)
    assert.deepEqual(transitions, [])
    assert.equal(h.state.mcpWorking.value, false)
    assert.equal(h.state.mcpMutating.value, false)
    assert.equal(h.state.editorInputBlocked.value, false)
    assert.equal(h.mcpResults.length, 1)
    assert.equal(h.mcpResults[0].result.isError, true)
    assert.match(h.mcpResults[0].result.content[0].text, /请先完成当前输入、拖动或弹窗操作/)
  } finally { unwatch(); h.unmount() }
})

for (const interruption of ['file transaction', 'composition', 'document switch']) test(`MCP rechecks ${interruption} after asynchronous editor readiness checks`, async () => {
  const h = shell(), tab = h.tab('mcp-readiness'), next = h.tab('mcp-next')
  let release, probing = false, executions = 0, blurred = 0
  const ready = new Promise(resolve => { release = resolve })
  const focused = new h.browser.HTMLElement()
  focused.blur = () => { blurred++ }
  h.browser.document.activeElement = focused
  h.rustWordHandle.canBackgroundExport = async () => { probing = true; return ready }
  h.rustWordHandle.mcpExecute = async () => { executions++; assert.fail('Readiness must be rechecked after awaiting the editor') }
  try {
    h.active(tab); h.state.home.value = false
    await h.state.saveMcpSettings({ ...h.state.mcpConfig.value, allowEdits: true })
    await h.state.toggleMcp()
    h.emitMcp({ toolName: 'document_undo' })
    await settleShell()
    assert.equal(probing, true)
    assert.equal(h.state.mcpWorking.value, false)
    assert.equal(h.state.editorInputBlocked.value, false)
    if (interruption === 'file transaction') h.state.busy.value = 'Saving the current document'
    else if (interruption === 'composition') h.state.composing.value = true
    else h.state.activeKey.value = next.key
    release(true); await settleShell()
    assert.equal(executions, 0)
    assert.equal(blurred, 0)
    assert.equal(h.browser.document.activeElement, focused)
    assert.equal(h.state.mcpWorking.value, false)
    assert.equal(h.state.mcpMutating.value, false)
    if (interruption === 'document switch') {
      assert.equal(h.state.mcpState.value.phase, 'stopped')
      assert.equal(h.mcpResults.length, 0, 'The stopped native session owns request cancellation')
    } else {
      assert.equal(h.mcpResults.length, 1)
      assert.equal(h.mcpResults[0].result.isError, true)
      assert.match(h.mcpResults[0].result.content[0].text, /正在处理其他操作/)
    }
  } finally { release(true); h.state.busy.value = ''; h.state.composing.value = false; h.unmount() }
})

test('MCP editor capability errors release the shell barrier without marking content as saved', async () => {
  const h = shell(), tab = h.tab('mcp-dispatch-failure', { dirty: true })
  h.rustWordHandle.mcpExecute = async () => { throw Error('Controlled editor failure') }
  try {
    h.active(tab); h.state.home.value = false
    await h.state.toggleMcp()
    h.emitMcp({ toolName: 'document_inspect' })
    await settleShell()
    assert.equal(h.state.mcpWorking.value, false)
    assert.equal(h.state.editorInputBlocked.value, false)
    assert.equal(h.mcpResults.length, 1)
    assert.equal(h.mcpResults[0].result.isError, true)
    assert.match(h.mcpResults[0].result.content[0].text, /Controlled editor failure/)
    assert.equal(tab.dirty, true)
    assert.equal(h.calls.some(call => call[0] === 'marked' || call[0] === 'save'), false)
  } finally { h.unmount() }
})

test('MCP active document closure stops the service and does not transfer it to a remaining tab', async () => {
  const h = shell(), first = h.tab('mcp-close'), second = h.tab('remaining')
  try {
    h.active(first); h.state.home.value = false
    await h.state.toggleMcp()
    await h.state.removeTab(first)
    await settleShell()
    assert.equal(h.state.activeKey.value, second.key)
    assert.equal(h.state.mcpState.value.phase, 'stopped')
    assert.equal(h.mcpCalls.filter(call => call[0] === 'start').length, 1)
  } finally { h.unmount() }
})

test('MCP shell unmount removes its heartbeat timer and detaches the request bridge', async () => {
  const h = shell(), tab = h.tab('mcp-unmount')
  h.active(tab); h.state.home.value = false
  await h.mount(); await h.state.toggleMcp()
  assert.ok([...h.intervals.values()].some(timer => timer.milliseconds === 5000))
  h.unmount(); await settleShell()
  assert.equal(h.intervals.size, 0)
  assert.equal(h.state.mcpState.value.phase, 'stopped')
  assert.ok(h.mcpCalls.some(call => call[0] === 'unlisten'))
})


test('schedule creation uses its own live tab and shared undo, redo, save, close and cleanup controls',async()=>{
  const h=shell()
  try {
    h.state.globalNewDocument('schedule');await h.idle()
    const tab=h.state.active.value,handle=h.state.scheduleHandles.get(tab.key)
    assert.equal(tab.document.kind,'schedule');assert.equal(tab.document.extension,'ooschedule')
    assert.equal(h.state.activeSchedule.value,true);assert.equal(h.state.scheduleEntries.value.length,1)
    assert.equal(tab.dirty,true);assert.equal(tab.ready,false);assert.equal(tab.fileId,undefined)
    h.state.readyFor(tab.key)
    handle.undo=async()=>h.calls.push(['schedule-undo'])
    handle.redo=async()=>h.calls.push(['schedule-redo'])
    h.state.globalFileAction('undo');await h.idle()
    h.state.globalFileAction('redo');await h.idle()
    assert.equal(h.calls.filter(call=>call[0]==='schedule-undo').length,1)
    assert.equal(h.calls.filter(call=>call[0]==='schedule-redo').length,1)
    h.state.openSaveAs()
    assert.deepEqual(Array.from(h.state.saveAsOptions.value,option=>option.extension),['ooschedule'])
    h.state.cancelSaveAs()
    const other=h.tab('other')
    await h.state.activate(other);h.state.readyFor(other.key);await h.state.activate(tab)
    assert.equal(h.state.scheduleHandles.get(tab.key),handle,'Switching retains the same editor and history')
    h.state.closeTab(tab)
    assert.equal(h.state.closeTarget.value.key,tab.key,'Unsaved plans require a close decision')
    h.state.closeTarget.value=null
    assert.equal(await h.state.saveActive(),true)
    const request=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(request.extension,'ooschedule');assert.equal(request.saveAs,true)
    assert.equal(tab.document.kind,'schedule');assert.equal(tab.dirty,false)
    await h.state.removeTab(tab)
    assert.equal(h.state.scheduleEntries.value.length,0);assert.equal(h.state.scheduleHandles.size,0)
  } finally {h.unmount()}
})

for(const route of ['native','recent','browser'])for(const extension of ['ooschedule','json'])test(`${route} ${extension} schedules open in the schedule editor and protect imported JSON`,async()=>{
  const bytes=scheduleModel.encodeSchedule(scheduleModel.createSchedule('Launch plan'))
  const source={id:'local-schedule',kind:'schedule',extension,name:`Launch.${extension}`,base64:Buffer.from(bytes).toString('base64'),sha256:'schedule-hash',sizeBytes:bytes.length}
  const h=shell({nativeEnabled:route!=='browser'})
  try {
    if(route==='native'){h.native.openDocument=async()=>source;h.state.openFile();await h.idle()}
    else if(route==='recent'){h.native.openRecent=async()=>source;h.state.openRecent({id:source.id});await h.idle()}
    else await h.state.browserFile({target:{value:source.name,files:[{name:source.name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}})
    assert.equal(h.state.error.value,'')
    const tab=h.state.active.value,handle=h.state.scheduleHandles.get(tab.key)
    assert.equal(tab.document.kind,'schedule');assert.equal(tab.requiresSaveAs,extension==='json')
    assert.equal(h.state.scheduleEntries.value[0].document.id,tab.key)
    assert.equal(h.state.workflowEntries.value.length,0)
    h.state.readyFor(tab.key);tab.dirty=true
    handle.exportFile=async({format})=>{assert.equal(format,'ooschedule');return {base64:source.base64,extension:'ooschedule',dirty:true}}
    h.state.openSaveAs();assert.equal(h.state.saveAsDraft.value.format,'ooschedule');assert.equal(h.state.saveAsCopy.value,false);h.state.cancelSaveAs()
    assert.equal(await h.state.saveActive(),true)
    if(route==='browser')assert.match(h.calls.find(call=>call[0]==='download')[1],/\.ooschedule$/)
    else {
      const request=h.calls.find(call=>call[0]==='save')[1]
      assert.equal(request.documentId,extension==='json'?undefined:source.id)
      assert.equal(request.expectedSha256,extension==='json'?undefined:source.sha256)
      assert.equal(request.saveAs,extension==='json')
      if(extension==='json')assert.deepEqual(Array.from(request.protectedDocumentIds),[source.id])
    }
    assert.equal(tab.document.extension,'ooschedule');assert.equal(tab.dirty,false)
  } finally {h.unmount()}
})

test('invalid schedule details are rejected before settling or replacing the active draft',async()=>{
  const h=shell(),original=h.tab('unsaved-word',{dirty:true});h.active(original)
  h.rustWordHandle.prepareDeactivate=async()=>assert.fail('Invalid imports must not settle the active draft')
  try {
    const model=scheduleModel.createSchedule('Invalid plan');model.events=[{id:'invalid'}]
    const bytes=new TextEncoder().encode(JSON.stringify(model))
    for(const extension of ['ooschedule','json'])await assert.rejects(h.state.addDocument({id:'broken',kind:'schedule',extension,name:`Broken.${extension}`,base64:Buffer.from(bytes).toString('base64'),sha256:'',sizeBytes:bytes.length},'broken'))
    assert.equal(h.state.activeKey.value,original.key);assert.equal(h.state.tabs.value.length,1)
    assert.equal(h.state.scheduleEntries.value.length,0);assert.equal(original.dirty,true)
  } finally {h.unmount()}
})

test('schedule autosave uses the selected file and retains changes made after the exported revision',async()=>{
  const h=shell({storedAutosave:'true'}),tab=h.tab('automatic-plan',{kind:'schedule',dirty:true,fileId:'selected-plan'});h.active(tab);h.state.home.value=false
  const handle=h.state.scheduleHandles.get(tab.key)
  handle.inspect=async()=>({documentId:1,revision:2,dirty:true})
  try {
    await h.mount();await h.fireTimeout(10000);await h.idle()
    const request=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(request.documentId,'selected-plan');assert.equal(request.extension,'ooschedule');assert.equal(request.saveAs,false)
    assert.equal(tab.dirty,true,'Acknowledging the earlier snapshot leaves subsequent changes dirty')
    await h.state.toggleMcp()
    const start=h.mcpCalls.find(call=>call[0]==='start')
    assert.equal(start[2].kind,'schedule');assert.equal(start[2].id,tab.key)
    assert.ok(start[3].some(tool=>tool.name==='schedule_read'))
    assert.ok(start[3].some(tool=>tool.name==='schedule_edit'))
    assert.equal(h.state.mcpState.value.documentId,tab.key)
    assert.equal(tab.dirty,true,'Starting MCP does not acknowledge or discard pending schedule edits')
    await h.state.removeTabs([tab],true)
    await settleShell();assert.equal(h.state.mcpState.value.phase,'stopped')
    assert.equal(h.state.scheduleHandles.size,0);assert.equal(h.state.scheduleEntries.value.length,0)
  } finally {h.unmount()}
})
