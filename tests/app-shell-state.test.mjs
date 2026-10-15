import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { zipSync, strToU8 } from 'fflate'

// Run the real App.vue setup logic with Vue's real reactivity. Editors and native
// file dialogs are controlled doubles: these are shell-state regressions, not
// Rust/WASM/PDF engine or native WebView compatibility tests.
const app = (await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const utilities = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const dialogFocus = await readFile(new URL('../src/shared/dialog-focus.ts', import.meta.url), 'utf8')
const appearanceSource = await readFile(new URL('../src/shared/appearance.ts', import.meta.url), 'utf8')
const names = 'tabs,activeKey,active,home,tabBar,help,helpDialog,closeDialog,saveAsDraft,saveAsOptions,saveAsCopy,openSaveAs,confirmSaveAs,cancelSaveAs,pdfDocument,rustWordEntries,rustWordHandles,setRustWordHandle,rustSheetEntries,rustSheetHandles,setRustSheetHandle,rustPresentationEntries,rustPresentationHandles,setRustPresentationHandle,pdfEditor,busy,error,closeTarget,readyFor,dirtyFor,editorError,stash,activate,addDocument,newDocument,openFile,openRecent,browserFile,saveActive,closeTab,closeWindow,resolveClose,removeTab,task,editorTransaction,nativeTransactionalEditor,appearance,currentDocument,globalActionsBlocked,documentActionsDisabled,globalFileAction,globalNewDocument,keydown,rustEditorFileAction,previewSlides'


function compile(source, require, extra = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require, console, URL, setTimeout, clearTimeout,
    crypto: { randomUUID }, btoa, atob, TextEncoder, TextDecoder, __BUILD_VERSION__: 'test', __APP_VERSION__: 'test', HTMLElement: class {}, document: { baseURI: 'http://127.0.0.1/' }, ...extra })
  return module.exports
}


function shell({nativeEnabled = true, smoke = false, rustPrepareError, rustPrepare, wordcraftSmokeError, wordcraftSmokeReport, wordcraftSmokeRun, sheetPrepareError, sheetPrepare, sheetWarnings = [], deckPrepareError, deckPrepare, deckWarnings = [], deckcraftSmokeError, deckcraftSmokeReport, deckcraftSmokeRun, gridcraftSmokeError, gridcraftSmokeReport, gridcraftSmokeRun, storedAppearance, systemDark = false, storageUnavailable = false} = {}) {
  const rustPreparations = [], sheetPreparations = [], deckPreparations = []
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
  const windowListeners = new Map(), mediaListeners = new Set()
  const media = { matches: systemDark, addEventListener(_type, callback) { mediaListeners.add(callback) }, removeEventListener(_type, callback) { mediaListeners.delete(callback) } }
  class Element {}
  // Share DOM identities with the real dialog helper across both VM contexts.
  // Layout notifications remain controlled because this harness has no renderer.
  const browser = {
    crossOriginIsolated: true,
    Blob,
    URL: class extends URL { static createObjectURL(){return 'blob:shell-test'} static revokeObjectURL(){} },
    setTimeout(callback, milliseconds, ...args) { const timer=setTimeout(callback,milliseconds,...args);if(milliseconds===30000)timer.unref();return timer },
    window: {
      addEventListener(type, callback) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(callback) },
      removeEventListener(type, callback) { windowListeners.get(type)?.delete(callback) },
      matchMedia: () => media,
      localStorage: {
        getItem(key) { if (storageUnavailable) throw Error('Storage unavailable'); return storage.get(key) ?? null },
        setItem(key, value) { if (storageUnavailable) throw Error('Storage unavailable'); storage.set(key, value) },
      },
    },
    document: { baseURI: 'http://127.0.0.1/', activeElement: null, documentElement: { dataset: {} }, createElement(tag) { assert.equal(tag,'a');return {click(){calls.push(['download',this.download,this.href])}} } },
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
  const state = scope.run(() => compile(`${app}\nexport const state={${names}}`, name => {
    if (name === 'vue') return lifecycle
    if (name === './native') return native
    if (name === './smoke') return {smokeRequested:()=>smoke,smokeStage(){},smokeFeatures:()=>({}),smokeFailure:async(error,phase)=>{calls.push(['smoke-failure',phase,String(error)])},smokeAwait:async(_phase,action)=>action()}
    if (name === './shared/document') return helpers
    if (name === './shared/dialog-focus') return focus
    if (name === './shared/appearance') return appearance
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
    if (name === './presentation/rust/deckcraft-native-smoke') return {async runDeckcraftNativeSmoke(adapter){calls.push(['deckcraft-native-smoke']);if(deckcraftSmokeError)throw Error(deckcraftSmokeError);if(deckcraftSmokeRun)return deckcraftSmokeRun(adapter);return deckcraftSmokeReport??{schemaVersion:1,ok:true,engine:'deckcraft-wasm'}}}
    if (name === './pdf/protocol') return {async requestPdf(action) {
      calls.push(['pdf-request',action]);return {base64:'JVBERg==',metadata:{pageCount:1},textBlocks:[{text:'NEW_NATIVE_TEXT 新的合同'}]}
    }}
    if (name === './word/rust/wordcraft-native-smoke') return {async runWordcraftNativeSmoke(adapter){calls.push(['wordcraft-native-smoke']);if(wordcraftSmokeError)throw Error(wordcraftSmokeError);if(wordcraftSmokeRun)return wordcraftSmokeRun(adapter);return wordcraftSmokeReport??{schemaVersion:1,ok:true,engine:'wordcraft-wasm'}}}
    if (name === './sheet/rust/gridcraft-native-smoke') return {async runGridcraftNativeSmoke(adapter){calls.push(['gridcraft-native-smoke']);if(gridcraftSmokeError)throw Error(gridcraftSmokeError);if(gridcraftSmokeRun)return gridcraftSmokeRun(adapter);return gridcraftSmokeReport??{schemaVersion:1,ok:true,engine:'gridcraft-wasm'}}}
    if (name === '@tauri-apps/api/core') return { invoke: async (command,args) => { calls.push(['invoke',command,args]) } }
    if (name.endsWith('.vue')) return {}
    throw Error(`Unexpected setup import ${name}`)
  }, browser).state)
  const handle = {
    exportFile: async () => ({ base64: 'TkVX', extension: helpers.defaultSaveExtension(state.active.value?.document.extension || 'docx'), dirty: false }),
    discardChanges: async options => { calls.push(['discard', options]) },
    markSaved: async () => { calls.push(['marked']) },
  }
  state.pdfEditor.value = handle
  const rustWordHandle = Object.create(handle)
  const presentationHandle = Object.assign(Object.create(handle), {
    present: async startPage => { calls.push(['present',state.activeKey.value,startPage]) },
    stopPresentation: async () => { calls.push(['stop-presentation']) },
  })
  function attachHandles() {
    for(const entry of state.rustWordEntries.value)if(!state.rustWordHandles.has(entry.document.id))state.setRustWordHandle(entry.document.id,rustWordHandle)
    for(const entry of state.rustSheetEntries.value)if(!state.rustSheetHandles.has(entry.document.id))state.setRustSheetHandle(entry.document.id,Object.create(handle))
    for(const entry of state.rustPresentationEntries.value)if(!state.rustPresentationHandles.has(entry.document.id))state.setRustPresentationHandle(entry.document.id,presentationHandle)
  }
  scope.run(()=>vue.watch([state.rustWordEntries,state.rustSheetEntries,state.rustPresentationEntries],attachHandles,{flush:'sync'}))
  function tab(id, { ready = true, dirty = false, fileId = id, kind = 'word' } = {}) {
    const extension = {word:'docx',sheet:'xlsx',presentation:'pptx',pdf:'pdf'}[kind]
    state.tabs.value.push({ key: id, ready, dirty, fileId, document: { id, kind, extension,
      name: `${id}.${extension}`, base64: 'T0xE', sha256: 'old-hash', sizeBytes: 3 } })
    return state.tabs.value.at(-1)
  }
  function active(tab) {
    state.activeKey.value = tab.key
    const entries={word:state.rustWordEntries,sheet:state.rustSheetEntries,presentation:state.rustPresentationEntries}[tab.document.kind]
    if(entries&&!entries.value.some(entry=>entry.document.id===tab.key))entries.value=[...entries.value,{document:tab.document}]
    if(tab.document.kind==='pdf')state.pdfDocument.value=tab.document
  }
  async function idle() {
    for (let n = 0; n < 50 && state.busy.value; n++) { await Promise.resolve(); await vue.nextTick() }
    assert.equal(state.busy.value, '', 'The shell task should finish')
  }
  return { state, native, calls, rustPreparations, sheetPreparations, deckPreparations, handle, presentationHandle, rustWordHandle, tab, active, idle, browser, observers, storage, windowListeners, mediaListeners,
    setSystemDark(value) { media.matches = value; for (const listener of mediaListeners) listener({ matches: value }) },
    dispatchWindow(type, event) { for (const listener of windowListeners.get(type) ?? []) listener(event) },
    async mount() { for (const callback of mounted) await callback() },
    unmount() { for (const callback of beforeUnmount) callback(); scope.stop() },
  }
}

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
    assert.ok(!h.calls.some(call=>call[0]==='wordcraft-native-smoke'||call[0]==='gridcraft-native-smoke'||call[0]==='deckcraft-native-smoke'||call[0]==='invoke'))
    assert.equal(h.state.tabs.value.length,0)
    if(requested)assert.match(h.state.error.value,/not enabled by the process/)
    else assert.equal(h.state.error.value,'')
    h.unmount()
  }
})

test('full native smoke awaits the default WordCraft gate before starting the presentation gate', async () => {
  let release, started
  const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve})
  const h=shell({smoke:true,wordcraftSmokeRun:async()=>{started();return gate}})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  const mounting=h.mount()
  await entered
  assert.ok(!h.calls.some(call=>call[0]==='gridcraft-native-smoke'))

  assert.ok(!h.calls.some(call=>call[0]==='invoke'&&call[1]==='smoke_report'))
  const wordcraft={schemaVersion:1,ok:false,engine:'wordcraft-wasm',error:'controlled default WordCraft failure'}
  release(wordcraft)
  await mounting
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
  assert.equal(report.wordcraft,wordcraft);assert.equal(report.ok,false)
  assert.match(report.error,/controlled default WordCraft failure/)
  assert.equal(h.state.tabs.value.length,0)
  h.unmount()
})

test('full native smoke reports WordCraft cleanup and thrown failures without starting the next editor', async () => {
  for(const mode of ['cleanup','thrown']) {
    const wordcraft={schemaVersion:1,ok:false,engine:'wordcraft-wasm',closeError:'controlled WordCraft cleanup failure'}
    const h=shell({smoke:true,...(mode==='thrown'?{wordcraftSmokeError:'controlled WordCraft thrown failure'}:{wordcraftSmokeReport:wordcraft})})
    h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
    await h.mount()
    const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
    assert.equal(report.ok,false);assert.match(report.error,/controlled WordCraft/)
    assert.equal(h.state.tabs.value.length,0)
    if(mode==='cleanup')assert.equal(report.wordcraft,wordcraft)
    else assert.equal(report.wordcraft,undefined)
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

test('WordCraft offers DOCX and PDF and protects imported identity until a DOCX copy succeeds',async()=>{
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

test('WordCraft PDF export routes through its editor and never saves or replaces the imported DOCX',async()=>{
  const h=shell();await h.state.addDocument(rustSource('original'),'original')
  const tab=h.state.active.value;h.state.readyFor(tab.key);tab.dirty=true
  const before=JSON.stringify(tab),entry=h.state.rustWordEntries.value[0],formats=[]
  h.handle.exportFile=async()=>assert.fail('WordCraft PDF must not export through the PDF editor')
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
    const handle={exportFile:async()=>{exported.push(tab.key);return{base64:Buffer.from(tab.key).toString('base64'),extension:'docx',dirty:true}},discardChanges:async()=>{discarded.push(tab.key)}}
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
  const handle={exportFile:async({format})=>({base64:'U0hFRVQ=',extension:format,dirty:true}),
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
  const h=shell({smoke:true,gridcraftSmokeRun:async()=>{started();return gate}})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  const mounting=h.mount();await entered
  assert.ok(h.calls.some(c=>c[0]==='wordcraft-native-smoke'))
  assert.ok(!h.calls.some(c=>c[0]==='invoke'&&c[1]==='smoke_report'))
  const gridcraft={schemaVersion:1,ok:false,engine:'gridcraft-wasm',error:'controlled GridCraft failure'}
  release(gridcraft);await mounting
  const report=h.calls.find(c=>c[0]==='invoke'&&c[1]==='smoke_report')[2].report
  assert.equal(report.gridcraft,gridcraft);assert.equal(report.ok,false);assert.match(report.error,/controlled GridCraft/)
  assert.equal(h.state.tabs.value.length,0)
  h.unmount()
})

test('full native smoke propagates spreadsheet cleanup and thrown failures without starting the next editor',async()=>{
  for(const mode of ['cleanup','thrown']) {
    const gridcraft={schemaVersion:1,ok:false,engine:'gridcraft-wasm',closeError:'controlled GridCraft cleanup failure'}
    const h=shell({smoke:true,...(mode==='thrown'?{gridcraftSmokeError:'controlled GridCraft thrown failure'}:{gridcraftSmokeReport:gridcraft})})
    h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
    const report=h.calls.find(c=>c[0]==='invoke'&&c[1]==='smoke_report')[2].report
    assert.equal(report.ok,false);assert.match(report.error,/controlled GridCraft/)
    assert.equal(h.state.tabs.value.length,0)
    if(mode==='cleanup')assert.equal(report.gridcraft,gridcraft)
    else assert.equal(report.gridcraft,undefined)
    h.unmount()
  }
})

function deckSource(id='deck',extension='pptx') {
  return {id,kind:'presentation',extension,name:`${id}.${extension}`,base64:'T0xE',sha256:'source-hash',sizeBytes:3}
}
function mountDeckHandle(h,tab,overrides={}) {
  const handle={
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
  const before=h.state.pdfDocument.value
  await h.state.removeTab(deck,true)
  assert.equal(h.state.activeKey.value,pdf.key);assert.equal(h.state.pdfDocument.value,before)
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

test('full native smoke requires all three current canvases and retains actual PDF replacement steps',async()=>{
  const h=shell({smoke:true});h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,true);assert.equal(report.wordcraft.ok,true);assert.equal(report.gridcraft.ok,true);assert.equal(report.deckcraft.ok,true)
  assert.equal(report.pdf.reopened,true);assert.equal(report.pdf.removedOldText,true);assert.equal(report.pdf.newTextPresent,true)
  assert.deepEqual(h.calls.filter(call=>call[0].endsWith('-native-smoke')).map(call=>call[0]),['wordcraft-native-smoke','gridcraft-native-smoke','deckcraft-native-smoke'])
  assert.deepEqual(h.calls.filter(call=>call[0]==='pdf-request').map(call=>call[1]),['new','add_text','replace_text','inspect'])
  for(const old of ['office','independentWordPackage','rustWordEngine','wordWorkbench','sheetWorkbench','presentationWorkbench'])assert.equal(Object.hasOwn(report,old),false)
  h.unmount()
})

for(const mode of ['report','throw'])test(`failed presentation ${mode} fails native release evidence before PDF verification`,async()=>{
  const h=shell({smoke:true,...(mode==='report'?{deckcraftSmokeReport:{ok:false,error:'Controlled deck failure'}}:{deckcraftSmokeError:'Controlled deck failure'})})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'});await h.mount()
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')[2].report
  assert.equal(report.ok,false);assert.match(report.error,/Controlled deck failure/)
  assert.ok(!h.calls.some(call=>call[0]==='pdf-request'));h.unmount()
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
