import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { zipSync, strToU8 } from 'fflate'
import { reviewOfficeImport } from '../src/office/import-review.ts'
import * as textColor from '../src/word/core/text-color.ts'

// Run the real App.vue setup logic with Vue's real reactivity. Editors and native
// file dialogs are controlled doubles: these are shell-state regressions, not
// Rust/WASM, LibreOffice/PDF engine or native WebView compatibility tests.
const app = (await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const utilities = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const dialogFocus = await readFile(new URL('../src/shared/dialog-focus.ts', import.meta.url), 'utf8')
const preparedSource = await readFile(new URL('../src/word/core/prepared.ts', import.meta.url), 'utf8')
const paperSource = await readFile(new URL('../src/word/core/paper.ts', import.meta.url), 'utf8')
const independentEditor = (await readFile(new URL('../src/components/StandaloneWordEditor.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const names = 'tabs,activeKey,active,home,tabBar,helpDialog,closeDialog,saveAsDraft,saveAsOptions,saveAsCopy,openSaveAs,confirmSaveAs,cancelSaveAs,officeDocument,pdfDocument,presentationDocument,independentWordDocument,independentWordPrepared,rustWordDocument,rustWordPrepared,rustWordEntries,rustWordHandles,setRustWordHandle,officeEditor,pdfEditor,presentationEditor,independentWordEditor,rustWordEditor,wordWorkbench,sheetWorkbench,writerState,calcState,presentationState,slidePreview,busy,error,closeTarget,readyFor,dirtyFor,editorError,stash,activate,addDocument,newDocument,openFile,openRecent,openLegacyWord,browserFile,browserLegacyWord,saveActive,closeTab,closeWindow,resolveClose,task,editorTransaction,nativeTransactionalEditor,readFreshWriterState,runWriterCommand,officeRequest'

function compile(source, require, extra = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require, console, URL, setTimeout, clearTimeout,
    crypto: { randomUUID }, btoa, atob, TextEncoder, __BUILD_VERSION__: 'test', __APP_VERSION__: 'test', HTMLElement: class {}, document: { baseURI: 'http://127.0.0.1/' }, ...extra })
  return module.exports
}

const { prepareWordDocument } = compile(preparedSource, () => { throw Error('Unexpected prepared import') })
const paper = compile(paperSource, () => { throw Error('Unexpected paper import') })

function shell({nativeEnabled = true, smoke = false, independentImportError, independentImport, rustPrepareError, rustPrepare, wordSmokeError, wordSmokeReport, wordSmokeRun, rustSmokeError, rustSmokeReport, rustSmokeRun} = {}) {
  const independentModels = [], preparations = [], rustPreparations = []
  const calls = [], mounted = [], beforeUnmount = [], observers = [], reviews = [], native = {
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
  // Share DOM identities with the real dialog helper across both VM contexts.
  // Layout notifications remain controlled because this harness has no renderer.
  const browser = {
    crossOriginIsolated: true,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { baseURI: 'http://127.0.0.1/', activeElement: null },
    HTMLElement: class {},
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
  const helpers = compile(utilities, () => { throw Error('Unexpected helper import') })
  const state = scope.run(() => compile(`${app}\nexport const state={${names}}`, name => {
    if (name === 'vue') return lifecycle
    if (name === './native') return native
    if (name === './smoke') return {smokeRequested:()=>smoke,smokeStage(){},smokeFeatures:()=>({}),smokeFailure:async(error,phase)=>{calls.push(['smoke-failure',phase,String(error)])},smokeAwait:async(_phase,action)=>action()}
    if (name === './shared/document') return helpers
    if (name === './shared/dialog-focus') return focus
    if (name === './office/import-review') return {reviewOfficeImport(document){reviews.push(document);return reviewOfficeImport(document)}}
    if (name === './word/core/prepared') return { prepareWordDocument(source, model) {
      const handoff=prepareWordDocument(source,model);preparations.push({source:{...source},model,handoff});return handoff
    } }
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
    // These tests verify the shell's preflight ordering and rejection handling;
    // the real DOCX parser has separate codec and browser round-trip coverage.
    if (name === './word/core/runtime') return {async importWordDocument(bytes){calls.push(['independent-preflight',bytes.length]);if(independentImportError)throw Error(independentImportError);const model=independentImport?await independentImport(bytes):{paragraphs:[],testImport:independentModels.length};independentModels.push(model);return model}}
    if (name === './word/core/native-package-smoke') return {async runNativeWordPackageSmoke(){calls.push(['word-native-smoke']);if(wordSmokeError)throw Error(wordSmokeError);if(wordSmokeRun)return wordSmokeRun();return wordSmokeReport??{ok:true,kind:'word-package-ipc'}}}
    if (name === './word/rust/native-smoke') return {async runNativeRustWordSmoke(){calls.push(['rust-native-smoke']);if(rustSmokeError)throw Error(rustSmokeError);if(rustSmokeRun)return rustSmokeRun();return rustSmokeReport??{schemaVersion:1,ok:true,transport:'tauri-word-engine-request'}}}
    if (name === '@tauri-apps/api/core') return { invoke: async (command,args) => { calls.push(['invoke',command,args]) } }
    if (name.endsWith('.vue')) return {}
    throw Error(`Unexpected setup import ${name}`)
  }, browser).state)
  const handle = {
    exportFile: async () => ({ base64: 'TkVX', extension: helpers.defaultSaveExtension(state.active.value?.document.extension || 'docx'), dirty: false }),
    discardChanges: async options => { calls.push(['discard', options]) },
    markSaved: async () => { calls.push(['marked']) },
  }
  state.officeEditor.value = handle
  state.pdfEditor.value = handle
  const independentWordHandle = Object.create(handle)
  state.independentWordEditor.value = independentWordHandle
  const rustWordHandle = Object.create(handle)
  state.rustWordEditor.value = rustWordHandle
  const presentationHandle = Object.assign(Object.create(handle), {
    assertNoPendingEdits() {}, discardDrafts() {}, stopPresentation() { calls.push(['stop-presentation']) },
    getPresentationState: async () => ({ documentId: state.activeKey.value, revision: 1 }),
  })
  state.presentationEditor.value = presentationHandle
  function tab(id, { ready = true, dirty = false, fileId = id, kind = 'word', wordEngine } = {}) {
    assert.ok(kind!=='word'||['legacy','independent','rust'].includes(wordEngine),'Word fixtures must select their engine explicitly')
    const extension = {word:'docx',sheet:'xlsx',presentation:'pptx',pdf:'pdf'}[kind]
    state.tabs.value.push({ key: id, ready, dirty, fileId, wordEngine:kind==='word'?wordEngine:undefined, document: { id, kind, extension,
      name: `${id}.${extension}`, base64: 'T0xE', sha256: 'old-hash', sizeBytes: 3 } })
    return state.tabs.value.at(-1)
  }
  function active(tab) {
    state.activeKey.value = tab.key
    if (tab.wordEngine === 'rust') state.rustWordDocument.value = tab.document
    else if (tab.wordEngine === 'independent') state.independentWordDocument.value = tab.document
    else if (tab.document.kind === 'pdf') state.pdfDocument.value = tab.document
    else if (tab.document.kind === 'presentation') state.presentationDocument.value = tab.document
    else state.officeDocument.value = tab.document
  }
  async function idle() {
    for (let n = 0; n < 50 && state.busy.value; n++) { await Promise.resolve(); await vue.nextTick() }
    assert.equal(state.busy.value, '', 'The shell task should finish')
  }
  return { state, native, calls, reviews, independentModels, preparations, rustPreparations, handle, presentationHandle, independentWordHandle, rustWordHandle, tab, active, idle, browser, observers,
    async mount() { for (const callback of mounted) await callback() },
    unmount() { for (const callback of beforeUnmount) callback(); scope.stop() },
  }
}

// Exercise the real component's loading/watch/disposal logic without rendering.
// The deferred importer controls races only; real OOXML import counts and editor
// rendering remain covered separately by the browser compatibility suite.
function wordLoader(document, prepared) {
  const props=vue.shallowReactive({document,prepared,active:true,disabled:false}),requests=[],events=[],beforeUnmount=[]
  const scope=vue.effectScope()
  const browser={document:{removeEventListener(){}},window:{removeEventListener(){}},
    defineProps:()=>props,withDefaults:value=>value,defineEmits:()=>((...event)=>events.push(event)),defineExpose(){}}
  const state=scope.run(()=>compile(`${independentEditor}\nexport const state={controller,loading,problem,settled:()=>opening}`,name=>{
    if(name==='vue')return {...vue,onMounted(){},onBeforeUnmount(callback){beforeUnmount.push(callback)}}
    if(name==='../shared/document')return {base64ToBytes:value=>Uint8Array.from(Buffer.from(value,'base64'))}
    if(name==='../word/core/runtime')return {importWordDocument(bytes){return new Promise((resolve,reject)=>requests.push({bytes:Array.from(bytes),resolve,reject}))}}
    if(name==='../word/core/model')return {createWordDocument:()=>({paragraphs:[],empty:true}),WordController:class {constructor(model){this.model=model;this.dirty=false}}}
    if(name==='../word/core/highlight')return {HIGHLIGHT_COLORS:[]}
    if(name==='../word/core/paper')return paper
    if(name==='../word/core/text-color')return textColor
    if(name==='../word/core/dom'||name==='../word/core/background'||name.endsWith('.css'))return {}
    throw Error(`Unexpected independent editor import ${name}`)
  },browser).state)
  return {props,state,requests,events,unmount(){for(const callback of beforeUnmount)callback();scope.stop()}}
}

test('save-as exposes supported formats, preserves cancelled drafts and saves a named converted copy', async () => {
  const h=shell(), a=h.tab('report',{wordEngine:'legacy',dirty:true});h.active(a)
  h.handle.exportFile=async({format})=>({base64:'TkVX',extension:format,dirty:true})
  h.state.openSaveAs()
  assert.deepEqual(Array.from(h.state.saveAsOptions.value,option=>option.extension),['docx','odt','pdf'])
  h.state.saveAsDraft.value.name='Renamed project.v2'
  h.state.saveAsDraft.value.format='odt'
  assert.equal(h.state.saveAsCopy.value,true)
  h.native.saveDocument=async request=>{h.calls.push(['cancelled-save',request]);return{status:'cancelled'}}
  await h.state.confirmSaveAs()
  assert.equal(h.state.saveAsDraft.value.name,'Renamed project.v2')
  assert.equal(a.dirty,true);assert.equal(a.fileId,'report');assert.equal(a.document.extension,'docx')
  assert.equal(h.calls.find(c=>c[0]==='cancelled-save')[1].name,'Renamed project.v2.odt')
  h.native.saveDocument=async request=>{h.calls.push(['copy-save',request]);return{status:'saved',document:{id:'copy',extension:'odt',name:request.name,kind:'word'}}}
  await h.state.confirmSaveAs()
  assert.equal(h.state.saveAsDraft.value,null)
  assert.equal(a.dirty,true);assert.equal(a.fileId,'report');assert.equal(a.document.extension,'docx')
  assert.ok(!h.calls.some(c=>c[0]==='marked'))
  assert.equal(h.calls.find(c=>c[0]==='copy-save')[1].documentId,undefined)
})

test('save-as rejects invalid names and stale targets before export; same-format success marks the saved document',async()=>{
  const h=shell(),a=h.tab('a',{wordEngine:'legacy',dirty:true}),b=h.tab('b',{wordEngine:'legacy'});h.active(a)
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
  const h=shell(),a=h.tab('a',{wordEngine:'legacy',dirty:true});h.active(a)
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

test('save-as format choices match the active engine and preserve legacy source-copy behavior',async()=>{
  for(const [kind,expected]of [['sheet',['xlsx','ods','pdf']],['presentation',['pptx','pdf']],['pdf',['pdf']]]){
    const h=shell(),a=h.tab(kind,{wordEngine:'legacy',kind});h.active(a);h.state.openSaveAs()
    assert.deepEqual(Array.from(h.state.saveAsOptions.value,o=>o.extension),expected)
    h.state.cancelSaveAs();assert.equal(h.state.saveAsDraft.value,null)
  }
  const h=shell(),a=h.tab('legacy',{wordEngine:'legacy',dirty:true});a.document.extension='doc';a.document.name='Original.doc';h.active(a)
  h.state.openSaveAs();assert.equal(h.state.saveAsDraft.value.name,'Original - 副本')
  assert.equal(h.state.saveAsDraft.value.format,'docx');assert.equal(h.state.saveAsCopy.value,false)
  await h.state.confirmSaveAs()
  const saved=h.calls.find(c=>c[0]==='save')[1];assert.equal(saved.documentId,undefined)
  assert.equal(saved.name,'Original - 副本.docx');assert.equal(a.document.extension,'docx')
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

function riskyWorkbook() {
  const s='http://schemas.openxmlformats.org/spreadsheetml/2006/main',r='http://schemas.openxmlformats.org/officeDocument/2006/relationships',pr='http://schemas.openxmlformats.org/package/2006/relationships'
  const entries={
    '_rels/.rels':`<Relationships xmlns="${pr}"><Relationship Id="main" Type="${r}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':`<workbook xmlns="${s}" xmlns:r="${r}"><sheets><sheet name="Source" sheetId="1" r:id="s1" state="veryHidden"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="${pr}"><Relationship Id="s1" Type="${r}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="${s}"><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  }
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name,xml])=>[name,strToU8(xml)])))
}

function attachedWordDocument(mode='legacy') {
  const w=mode==='strict'?'http://purl.oclc.org/ooxml/wordprocessingml/main':'http://schemas.openxmlformats.org/wordprocessingml/2006/main',r=mode==='strict'?'http://purl.oclc.org/ooxml/officeDocument/relationships':'http://schemas.openxmlformats.org/officeDocument/2006/relationships',pr='http://schemas.openxmlformats.org/package/2006/relationships'
  const object=mode==='legacy'?'<o:OLEObject Type="Embed" r:id="file"/>':'<w:objectEmbed r:id="file" drawAspect="icon" progId="Word.Document.12" shapeId="10" fieldCodes=""/>'
  const entries={
    '_rels/.rels':`<Relationships xmlns="${pr}"><Relationship Id="main" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml':`<w:document xmlns:w="${w}" xmlns:r="${r}" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body><w:p><w:r><w:object>${object}</w:object></w:r></w:p></w:body></w:document>`,
    'word/_rels/document.xml.rels':`<Relationships xmlns="${pr}"><Relationship Id="file" Type="${r}/oleObject" Target="embeddings/item.bin"/></Relationships>`,
    'word/embeddings/item.bin':'Original embedded attachment',
  }
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name,value])=>[name,strToU8(value)])))
}

test('native smoke URL reports failure even if Tauri injection is absent', async () => {
  const h=shell({nativeEnabled:false,smoke:true})
  await h.mount()
  assert.match(h.state.error.value,/no Tauri IPC/)
  assert.ok(h.calls.some(call=>call[0]==='smoke-failure'&&call[1]==='app-startup'))
})

test('process-authorized Word smoke reports without mounting the Office engine', async () => {
  const h=shell({smoke:true})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'word-package-ipc'})
  await h.mount()
  assert.equal(h.state.error.value,'')
  assert.equal(h.calls.filter(call=>call[0]==='word-native-smoke').length,1)
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
  assert.equal(report?.kind,'word-package-ipc');assert.equal(report?.ok,true)
  assert.equal(h.state.tabs.value.length,0);assert.equal(h.state.officeDocument.value,undefined)
  h.unmount()
})

test('process-authorized Rust Word smoke reports without mounting another editor', async () => {
  const h=shell({smoke:true})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'rust-word-engine'})
  await h.mount()
  assert.equal(h.state.error.value,'')
  assert.equal(h.calls.filter(call=>call[0]==='rust-native-smoke').length,1)
  assert.ok(!h.calls.some(call=>call[0]==='word-native-smoke'))
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
  assert.equal(report?.transport,'tauri-word-engine-request');assert.equal(report?.ok,true)
  assert.equal(h.state.tabs.value.length,0);assert.equal(h.state.officeDocument.value,undefined)
  h.unmount()
})

test('Word smoke cannot start when the process has not enabled smoke mode', async () => {
  for(const scope of ['word-package-ipc','rust-word-engine','full']) for(const requested of [false,true]) {
    const h=shell({smoke:requested})
    h.native.bootstrap=async()=>({smokeMode:false,smokeScope:scope})
    await h.mount()
    assert.ok(!h.calls.some(call=>call[0]==='word-native-smoke'||call[0]==='rust-native-smoke'||call[0]==='invoke'))
    assert.equal(h.state.tabs.value.length,0)
    if(requested)assert.match(h.state.error.value,/not enabled by the process/)
    else assert.equal(h.state.error.value,'')
    h.unmount()
  }
})

test('Word native smoke rejection reports failure and does not start another editor', async () => {
  const h=shell({smoke:true,wordSmokeError:'native package denied'})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'word-package-ipc'})
  await h.mount()
  assert.match(h.state.error.value,/native package denied/)
  assert.ok(h.calls.some(call=>call[0]==='smoke-failure'&&call[2].includes('native package denied')))
  assert.ok(!h.calls.some(call=>call[0]==='invoke'&&call[1]==='smoke_report'))
  assert.equal(h.state.tabs.value.length,0)
  h.unmount()
})

test('full native smoke awaits independent Word evidence before creating the Office document', async () => {
  let release, started
  const gate = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { started = resolve })
  const h = shell({smoke:true,wordSmokeRun:async()=>{started();return gate}})
  h.native.bootstrap = async () => ({smokeMode:true,smokeScope:'full'})
  const stop = vue.watch(h.state.officeDocument, document => {
    if(document) { h.calls.push(['office-document-created']); h.state.readyFor(document.id) }
  }, {flush:'sync'})
  h.handle.smokeTest = async () => { h.calls.push(['office-native-smoke']); throw Error('controlled Office failure after Word gate') }
  const mounting = h.mount()
  await entered
  assert.equal(h.state.tabs.value.length,0);assert.equal(h.state.officeDocument.value,undefined)
  assert.ok(!h.calls.some(call=>call[0]==='invoke'&&call[1]==='smoke_report'))
  const independent = {ok:true,kind:'word-package-ipc',checks:['controlled shell evidence']}
  release(independent)
  await mounting
  assert.ok(h.calls.findIndex(call=>call[0]==='rust-native-smoke') < h.calls.findIndex(call=>call[0]==='word-native-smoke'))
  assert.ok(h.calls.findIndex(call=>call[0]==='word-native-smoke') < h.calls.findIndex(call=>call[0]==='office-document-created'))
  assert.equal(h.calls.filter(call=>call[0]==='office-native-smoke').length,1)
  const report = h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
  assert.equal(report.independentWordPackage,independent)
  assert.equal(report.rustWordEngine.transport,'tauri-word-engine-request')
  assert.equal(report.ok,false);assert.match(report.error,/controlled Office failure after Word gate/)
  stop();h.unmount()
})

test('full native smoke awaits Rust Word evidence before starting the old package or Office gates', async () => {
  let release, started
  const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve})
  const h=shell({smoke:true,rustSmokeRun:async()=>{started();return gate},wordSmokeError:'controlled failure after Rust engine'})
  h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
  const mounting=h.mount()
  await entered
  assert.ok(!h.calls.some(call=>call[0]==='word-native-smoke'||call[0]==='invoke'))
  assert.equal(h.state.tabs.value.length,0);assert.equal(h.state.officeDocument.value,undefined)
  const rust={schemaVersion:1,ok:true,transport:'tauri-word-engine-request',checks:['controlled shell evidence']}
  release(rust)
  await mounting
  assert.equal(h.calls.filter(call=>call[0]==='rust-native-smoke').length,1)
  assert.equal(h.calls.filter(call=>call[0]==='word-native-smoke').length,1)
  const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
  assert.equal(report.rustWordEngine,rust);assert.equal(report.ok,false)
  assert.match(report.error,/controlled failure after Rust engine/)
  h.unmount()
})

test('full native smoke stops before other gates for failed Rust Word reports and thrown IPC failures', async () => {
  for(const mode of ['reported','cleanup','thrown']) {
    const rust={schemaVersion:1,ok:false,transport:'tauri-word-engine-request',...(mode==='cleanup'?{closeError:'controlled Rust engine cleanup failure'}:{error:'controlled Rust engine failure'})}
    const h=shell({smoke:true,...(mode==='thrown'?{rustSmokeError:rust.error}:{rustSmokeReport:rust})})
    h.native.bootstrap=async()=>({smokeMode:true,smokeScope:'full'})
    await h.mount()
    assert.equal(h.calls.filter(call=>call[0]==='rust-native-smoke').length,1)
    assert.ok(!h.calls.some(call=>call[0]==='word-native-smoke'))
    assert.equal(h.state.tabs.value.length,0);assert.equal(h.state.officeDocument.value,undefined)
    const report=h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
    assert.equal(report.ok,false);assert.match(report.error,/controlled Rust engine/)
    if(mode==='thrown')assert.equal(report.rustWordEngine,undefined)
    else assert.equal(report.rustWordEngine,rust)
    h.unmount()
  }
})

test('full native smoke stops before Office for failed Word reports and thrown IPC failures', async () => {
  for(const mode of ['reported','thrown']) {
    const independent = {ok:false,kind:'word-package-ipc',error:'controlled Rust package failure'}
    const h = shell({smoke:true,...(mode==='reported'?{wordSmokeReport:independent}:{wordSmokeError:independent.error})})
    h.native.bootstrap = async () => ({smokeMode:true,smokeScope:'full'})
    await h.mount()
    assert.equal(h.calls.filter(call=>call[0]==='word-native-smoke').length,1)
    assert.equal(h.state.tabs.value.length,0);assert.equal(h.state.officeDocument.value,undefined)
    const report = h.calls.find(call=>call[0]==='invoke'&&call[1]==='smoke_report')?.[2].report
    assert.equal(report.ok,false);assert.match(report.error,/controlled Rust package failure/)
    if(mode==='reported')assert.equal(report.independentWordPackage,independent)
    else assert.equal(report.independentWordPackage,undefined)
    h.unmount()
  }
})

test('draft review reads a real fresh Writer state without discarding pending inputs', async () => {
  const h=shell(),a=h.tab('A',{wordEngine:'legacy'});h.active(a);await vue.nextTick()
  let reads=0
  const fresh={documentId:'A',revision:7}
  h.handle.getWriterState=async()=>{reads++;return fresh}
  h.state.wordWorkbench.value={assertNoPendingEdits(){throw Error('Draft must remain available')},discardDrafts(){assert.fail('Do not discard drafts')}}
  assert.equal(await h.state.readFreshWriterState(),fresh)
  assert.equal(h.state.writerState.value,fresh);assert.equal(reads,1)
  h.handle.getWriterState=async()=>{throw Error('Engine state unavailable')}
  await assert.rejects(h.state.readFreshWriterState(),/Engine state unavailable/)
})

test('late draft review cannot use a different document or editor result', async () => {
  for(const changed of ['tab','editor','result']) {
    const h=shell(),a=h.tab('A',{wordEngine:'legacy'}),b=h.tab('B',{wordEngine:'legacy'});h.active(a);await vue.nextTick()
    let finish
    h.handle.getWriterState=()=>new Promise(resolve=>{finish=resolve})
    const reading=h.state.readFreshWriterState()
    if(changed==='tab'){h.active(b);await vue.nextTick()}
    if(changed==='editor')h.state.officeEditor.value={...h.handle}
    finish({documentId:changed==='result'?'B':'A',revision:7})
    await assert.rejects(reading,/文档已切换/)
    assert.equal(h.state.writerState.value,null)
  }
})

test('immediate Writer commands cannot consume drafts or retry a rejected target', async () => {
  const h=shell(),a=h.tab('A',{wordEngine:'legacy'});h.active(a);await vue.nextTick()
  const command={action:{type:'format-text',bold:true},target:{documentId:'A',revision:4}},calls=[]
  h.handle.writerCommand=async input=>{calls.push(input);throw Error('Command target changed')}
  h.state.wordWorkbench.value={assertNoPendingEdits(){throw Error('Pending draft')}}
  h.state.runWriterCommand(command);await h.idle()
  assert.equal(calls.length,0);assert.match(h.state.error.value,/Pending draft/)
  h.state.wordWorkbench.value={assertNoPendingEdits(){}}
  h.state.runWriterCommand(command);await h.idle()
  assert.equal(calls.length,1);assert.equal(calls[0],command)
  assert.match(h.state.error.value,/Command target changed/)
  assert.equal(command.target.revision,4,'A rejected target is not rebound to a later version')
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
  const h = shell(), a = h.tab('A', {wordEngine:'legacy', ready: false }); h.active(a)
  let exported = 0; h.handle.exportFile = async () => { exported++; return { base64: 'wrong', extension: 'docx' } }
  await assert.rejects(h.state.saveActive(), /仍在打开/)
  h.state.editorError('A', 'Cannot load A')
  await assert.rejects(h.state.saveActive(), /未成功打开/)
  assert.equal(exported, 0); assert.equal(h.calls.length, 0)
  const b = h.tab('B',{wordEngine:'legacy'}); await h.state.activate(b)
  assert.equal(h.state.activeKey.value, 'B', 'A failed tab must not trap the user')
})

test('switching snapshots authoritative dirty state even before a dirty event arrives', async () => {
  const h = shell(), a = h.tab('A',{wordEngine:'legacy'}), b = h.tab('B',{wordEngine:'legacy'}); h.active(a)
  h.handle.exportFile = async () => ({ base64: 'RURJVA==', extension: 'docx', dirty: true })
  await h.state.activate(b)
  assert.equal(a.document.base64, 'RURJVA=='); assert.equal(a.dirty, true)
  assert.equal(h.state.activeKey.value, 'B'); assert.equal(b.ready, false)
  assert.equal(h.calls[0][0], 'discard')
})

test('revision mismatch or pending PDF edits reject switching without replacing snapshots', async () => {
  for (const pending of [false, true]) {
    const h = shell(), a = h.tab('A',{wordEngine:'legacy'}), b = h.tab('B',{wordEngine:'legacy'}); h.active(a)
    if (pending) h.handle.exportFile = async () => { throw Error('Apply pending PDF edits') }
    else h.handle.discardChanges = async () => { throw Error('Revision changed') }
    await assert.rejects(h.state.activate(b), pending ? /pending PDF/ : /Revision/)
    assert.equal(h.state.activeKey.value, 'A'); assert.equal(a.document.base64, 'T0xE')
  }
})

test('cancelled save and external conflict preserve dirty state and original identity', async () => {
  for (const result of [{ status: 'cancelled' }, { status: 'conflict', message: 'External change' }]) {
    const h = shell(), a = h.tab('A', {wordEngine:'legacy', dirty: true }); h.active(a)
    h.native.saveDocument = async () => result
    assert.equal(await h.state.saveActive(), false)
    assert.equal(a.dirty, true); assert.equal(a.fileId, 'A'); assert.equal(a.document.sha256, 'old-hash')
    assert.ok(!h.calls.some(call => call[0] === 'marked'))
  }
})

test('legacy imports save only as modern copies without an original-file overwrite token', async () => {
  for(const [extension,modern,kind] of [['doc','docx','word'],['rtf','docx','word'],['xls','xlsx','sheet']]) {
    const h=shell(),a=h.tab('original',{wordEngine:'legacy',dirty:true,kind});h.active(a)
    a.document.extension=extension;a.document.name=`Original.${extension}`
    let requested
    h.handle.exportFile=async options=>{requested=options;return{base64:'TkVX',extension:modern,name:`Original.${extension}`}}
    assert.equal(await h.state.saveActive(),true)
    assert.equal(requested.format,modern)
    const request=h.calls.find(call=>call[0]==='save')[1]
    assert.equal(request.extension,modern);assert.equal(request.name,`Original - 副本.${modern}`)
    assert.equal(request.saveAs,true);assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined)
    assert.notEqual(a.fileId,'original');assert.equal(a.document.extension,modern)
    assert.equal(a.requiresSaveAs,false);assert.equal(a.dirty,false)
  }
})

test('legacy Save As protection survives a modern in-memory snapshot and a cancelled dialog', async () => {
  const h=shell(),a=h.tab('legacy',{wordEngine:'legacy',dirty:true});h.active(a)
  a.document.extension='doc';a.document.name='Legacy.doc'
  await h.state.stash()
  assert.equal(a.document.extension,'docx');assert.equal(a.document.name,'Legacy.docx')
  assert.equal(a.requiresSaveAs,true);assert.equal(a.fileId,'legacy')
  const requests=[],save=h.native.saveDocument
  h.native.saveDocument=async request=>{requests.push(request);return{status:'cancelled'}}
  assert.equal(await h.state.saveActive(),false)
  assert.equal(a.requiresSaveAs,true);assert.equal(a.dirty,true);assert.equal(a.fileId,'legacy')
  assert.equal(a.document.sha256,'old-hash');assert.ok(!h.calls.some(call=>call[0]==='marked'))
  h.native.saveDocument=save
  assert.equal(await h.state.saveActive(),true)
  const successful=h.calls.find(call=>call[0]==='save')[1]
  for(const request of [...requests,successful]) {
    assert.equal(request.saveAs,true);assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined)
  }
  assert.equal(a.requiresSaveAs,false)
  await h.state.saveActive()
  assert.equal(h.calls.filter(call=>call[0]==='save').at(-1)[1].documentId,a.fileId,'Later saves may update only the new modern file')
})

test('legacy source protection is set at import and unsafe legacy exports never reach the file bridge', async () => {
  const h=shell()
  await h.state.addDocument({id:'source',kind:'word',extension:'doc',name:'Source.doc',base64:'OLD',sha256:'old-hash',sizeBytes:3},'source','legacy')
  const a=h.state.tabs.value[0];a.ready=true
  assert.equal(a.requiresSaveAs,true)
  let exports=0
  h.handle.exportFile=async()=>{exports++;return{base64:'TkVX',extension:'doc'}}
  await assert.rejects(h.state.saveActive(false,'doc'),/仅支持导入/)
  assert.equal(exports,0)
  await assert.rejects(h.state.saveActive(),/未生成现代格式/)
  await assert.rejects(h.state.stash(),/仅支持导入/)
  assert.equal(h.calls.length,0);assert.equal(a.fileId,'source');assert.equal(a.document.extension,'doc')
  assert.equal(a.requiresSaveAs,true)
})

test('browser compatibility import checks document bytes before creating a tab', async () => {
  const h=shell({nativeEnabled:false})
  const open=async(name,contents)=>{
    const bytes=new TextEncoder().encode(contents)
    const input={value:name,files:[{name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}
    await h.state.browserLegacyWord({target:input});assert.equal(input.value,'')
  }
  await open('renamed.doc','This is not an OLE document')
  assert.equal(h.state.tabs.value.length,0);assert.match(h.state.error.value,/格式不符/)
  await open('valid.rtf','{\\rtf1\\ansi Hello}')
  assert.equal(h.state.tabs.value.length,1)
  assert.equal(h.state.tabs.value[0].document.extension,'rtf')
  assert.equal(h.state.tabs.value[0].requiresSaveAs,true)
})

test('risky XLSX is inspected once and requires Save As after switching or cancelling',async()=>{
  const h=shell(),bytes=riskyWorkbook()
  const original={id:'source',kind:'sheet',extension:'xlsx',name:'Source.v2.xlsx',base64:Buffer.from(bytes).toString('base64'),sha256:'source-hash',sizeBytes:bytes.length}
  await h.state.addDocument(original,'source')
  const a=h.state.tabs.value[0];a.ready=true;a.dirty=true
  assert.equal(h.reviews.length,1);assert.equal(a.requiresSaveAs,true);assert.equal(a.importWarnings.length,2)
  await h.state.addDocument(original,'source')
  assert.equal(h.reviews.length,1,'Reactivating an already-open source does not rebind its original review')
  h.handle.exportFile=async()=>({base64:'TkVX',extension:'xlsx',dirty:true})
  const b=h.tab('B',{wordEngine:'legacy'});await h.state.activate(b);b.ready=true;await h.state.activate(a);a.ready=true
  assert.equal(a.requiresSaveAs,true);assert.equal(a.importWarnings.length,2)
  assert.equal(h.reviews.length,1,'A modern snapshot must not erase the source review')
  const saved=h.native.saveDocument,requests=[]
  h.native.saveDocument=async request=>{requests.push(request);return{status:'cancelled'}}
  assert.equal(await h.state.saveActive(),false)
  assert.equal(a.requiresSaveAs,true);assert.equal(a.importWarnings.length,2)
  assert.equal(a.fileId,'source');assert.equal(a.dirty,true)
  h.native.saveDocument=saved
  assert.equal(await h.state.saveActive(),true)
  const accepted=h.calls.find(call=>call[0]==='save')[1]
  for(const request of [...requests,accepted]) {
    assert.equal(request.saveAs,true);assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined)
    assert.equal(request.name,'Source.v2 - 副本.xlsx')
  }
  assert.equal(a.requiresSaveAs,false);assert.equal(a.importWarnings.length,0);assert.notEqual(a.fileId,'source')
  assert.equal(a.document.extension,'xlsx')
})

test('the browser import path applies the same XLSX warning and source-copy safeguard',async()=>{
  const h=shell({nativeEnabled:false}),bytes=riskyWorkbook()
  await h.state.browserFile({target:{value:'Source.xlsx',files:[{name:'Source.xlsx',size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}})
  const a=h.state.tabs.value[0]
  assert.equal(h.reviews.length,1);assert.equal(a.requiresSaveAs,true)
  assert.match(a.importWarnings[0],/ISFORMULA/);assert.match(a.importWarnings[1],/veryHidden/)
})

for(const mode of ['legacy','transitional','strict'])test(`DOCX ${mode} embedded attachment warning survives snapshots and cancelled saving until a new copy succeeds`,async()=>{
  const h=shell(),bytes=attachedWordDocument(mode)
  await h.state.addDocument({id:'word-source',kind:'word',extension:'docx',name:'Attachments.docx',base64:Buffer.from(bytes).toString('base64'),sha256:'source-hash',sizeBytes:bytes.length},'word-source','legacy')
  const a=h.state.tabs.value[0];a.ready=true;a.dirty=true
  assert.equal(h.reviews.length,1);assert.equal(a.requiresSaveAs,true);assert.match(a.importWarnings[0],/嵌入附件/)
  await h.state.stash()
  assert.equal(a.requiresSaveAs,true);assert.match(a.importWarnings[0],/丢失附件内容/)
  const save=h.native.saveDocument
  h.native.saveDocument=async()=>({status:'cancelled'})
  assert.equal(await h.state.saveActive(),false);assert.equal(a.fileId,'word-source');assert.equal(a.requiresSaveAs,true)
  h.native.saveDocument=save
  assert.equal(await h.state.saveActive(),true)
  const request=h.calls.find(call=>call[0]==='save')[1]
  assert.equal(request.saveAs,true);assert.equal(request.documentId,undefined);assert.equal(request.name,'Attachments - 副本.docx')
  assert.notEqual(a.fileId,'word-source');assert.equal(a.importWarnings.length,0);assert.equal(a.requiresSaveAs,false)
  h.unmount()
})

test('reopening an already-open file retains its in-memory edits', async () => {
  const h = shell(), a = h.tab('A', {wordEngine:'legacy', dirty: true }); h.active(a)
  await h.state.addDocument({ ...a.document, base64: 'disk-version' }, 'A', 'legacy')
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

test('closing the active Office tab releases its engine even when a PDF remains open', async () => {
  const h=shell(), a=h.tab('office',{wordEngine:'legacy'}), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
  h.state.closeTab(a);await h.idle()
  assert.equal(h.state.activeKey.value,pdf.key)
  assert.equal(h.state.tabs.value.length,1)
  assert.equal(h.state.officeDocument.value,undefined,'The Office v-if must unmount its iframe')
  assert.equal(h.state.pdfDocument.value.id,pdf.key)
})

test('closing a hidden Office model releases only the closed tab and leaves the active PDF intact', async () => {
  const h=shell(), a=h.tab('office',{wordEngine:'legacy'}), other=h.tab('other',{wordEngine:'legacy'}), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
  await h.state.activate(pdf);h.state.readyFor(pdf.key)
  const pdfDocument=h.state.pdfDocument.value, discardCount=h.calls.filter(call=>call[0]==='discard').length
  h.state.closeTab(a);await h.idle()
  assert.equal(h.state.officeDocument.value,undefined)
  assert.equal(h.state.activeKey.value,pdf.key);assert.equal(pdf.ready,true)
  assert.equal(h.state.pdfDocument.value,pdfDocument)
  assert.equal(h.calls.filter(call=>call[0]==='discard').length,discardCount,'The active PDF must not be discarded')
  assert.ok(h.state.tabs.value.some(tab=>tab.key===other.key),'Other Office snapshots remain available')
})

test('closing another background Office tab keeps the loaded model and its undo history', async () => {
  const h=shell(), a=h.tab('office',{wordEngine:'legacy'}), other=h.tab('other',{wordEngine:'legacy'}), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
  await h.state.activate(pdf);h.state.readyFor(pdf.key)
  const document=h.state.officeDocument.value
  h.state.closeTab(other);await h.idle()
  assert.equal(h.state.officeDocument.value,document)
  assert.equal(a.ready,true)
})

test('Office to PDF and back reuses the same live editor after capturing unsaved content', async () => {
  const h=shell(), a=h.tab('office',{wordEngine:'legacy'}), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
  const handle=h.state.officeEditor.value
  h.handle.exportFile=async()=>({base64:'RURJVA==',extension:'docx',dirty:true})
  await h.state.activate(pdf);h.state.readyFor(pdf.key)
  assert.equal(a.document.base64,'RURJVA==');assert.equal(a.dirty,true)
  assert.equal(h.state.officeDocument.value.id,a.key);assert.equal(a.ready,true)
  h.handle.exportFile=async()=>({base64:'UERGCg==',extension:'pdf',dirty:false})
  let refreshed=0;h.handle.getWriterState=async()=>{refreshed++;return {documentId:a.key,revision:3}}
  await h.state.activate(a)
  assert.equal(a.ready,true);assert.equal(h.state.officeEditor.value,handle)
  assert.equal(refreshed,1);assert.equal(h.state.writerState.value.revision,3)
})

for(const failure of ['draft','cancelled','conflict','save-error']) test(`failed Office close retains the live engine and content after ${failure}`,async()=>{
  const h=shell(), a=h.tab('office',{wordEngine:'legacy',dirty:true});h.tab('pdf',{kind:'pdf'});h.active(a)
  const original=h.state.officeDocument.value
  if(failure==='draft')h.state.wordWorkbench.value={assertNoPendingEdits(){throw Error('Pending draft')},discardDrafts(){assert.fail('Draft must remain')}}
  else h.native.saveDocument=async()=>{
    if(failure==='save-error')throw Error('Write failed')
    return {status:failure,message:'External change'}
  }
  h.state.closeTarget.value=a;await h.state.resolveClose('save')
  assert.equal(h.state.officeDocument.value,original)
  assert.equal(h.state.activeKey.value,a.key);assert.equal(a.dirty,true)
  assert.equal(h.state.tabs.value.length,2);assert.equal(h.state.closeTarget.value.key,a.key)
  assert.ok(!h.calls.some(call=>call[0]==='discard'))
})

test('confirmed Office discard releases its model after dropping the explicitly abandoned drafts',async()=>{
  const h=shell(),a=h.tab('office',{wordEngine:'legacy',dirty:true});h.tab('pdf',{kind:'pdf'});h.active(a)
  let discarded=0;h.state.wordWorkbench.value={discardDrafts(){discarded++}}
  h.state.closeTarget.value=a;await h.state.resolveClose('discard')
  assert.equal(discarded,1);assert.equal(h.state.officeDocument.value,undefined)
  assert.equal(h.state.closeTarget.value,null)
  assert.ok(h.calls.some(call=>call[0]==='discard'&&call[1]?.force===true))
})

test('save-and-close of a background tab waits for its own editor to become ready', async () => {
  const h = shell(), a = h.tab('A',{wordEngine:'legacy'}), b = h.tab('B', {wordEngine:'legacy', dirty: true }); h.active(a)
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
  const h = shell(), a = h.tab('A', {wordEngine:'legacy', dirty: true }); h.active(a)
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
  h.handle.writerAction=function(input){called=true;assert.equal(this,h.handle);assert.equal(h.state.busy.value,'');return input}
  h.handle.exportFile=async()=>{assert.equal(h.state.busy.value.length>0,true);return {base64:'snapshot',revision:7}}
  const nativeEditor=h.state.nativeTransactionalEditor(h.handle)
  const intent={type:'apply-style',expectedRevision:3}
  assert.equal(nativeEditor.writerAction(intent),intent)
  assert.equal(called,true,'Captured edit intents must forward synchronously without a new render/focus await')
  assert.equal((await nativeEditor.exportFile()).revision,7)
  assert.equal(h.state.busy.value,'')
  const a=h.tab('A',{wordEngine:'legacy'}),b=h.tab('B',{wordEngine:'legacy'});h.active(a)
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

test('unsupported PPT and ODP imports are rejected before replacing any loaded document', async () => {
  for (const extension of ['ppt', 'odp']) {
    const h=shell(),a=h.tab('existing',{wordEngine:'legacy',dirty:true});h.active(a)
    const original=h.state.officeDocument.value;let exports=0
    h.handle.exportFile=async()=>{exports++;return {base64:'NEW',extension:'docx'}}
    await assert.rejects(h.state.addDocument({id:'legacy',kind:'presentation',extension,name:`Legacy.${extension}`,base64:'SOURCE',sha256:'source-hash',sizeBytes:6},'legacy'),/PPTX/)
    assert.equal(exports,0);assert.equal(h.state.tabs.value.length,1)
    assert.equal(h.state.activeKey.value,a.key);assert.equal(a.dirty,true)
    assert.equal(h.state.officeDocument.value,original);assert.equal(h.state.presentationDocument.value,undefined)
  }
})

test('presentation rejects unsupported ODP export before invoking an editor or file dialog', async () => {
  const h=shell(),a=h.tab('deck',{kind:'presentation',dirty:true});h.active(a)
  let exports=0;h.presentationHandle.exportFile=async()=>{exports++;return {base64:'UNSUPPORTED',extension:'odp'}}
  await assert.rejects(h.state.saveActive(true,'odp'),/PPTX|支持/)
  assert.equal(exports,0);assert.equal(a.document.extension,'pptx');assert.equal(a.dirty,true)
  assert.ok(!h.calls.some(call=>call[0]==='save'))
})

test('adding a presentation routes only to its independent editor and never mounts an Office model', async () => {
  const h=shell();let officeExports=0,presentationExports=0
  h.handle.exportFile=async()=>{officeExports++;throw Error('Wrong Office route')}
  h.presentationHandle.exportFile=async()=>{presentationExports++;return {base64:'UFBUWA==',extension:'pptx'}}
  await h.state.addDocument({id:'new',kind:'presentation',extension:'pptx',name:'Independent.pptx',base64:'',sha256:'',sizeBytes:0})
  const a=h.state.tabs.value[0];h.state.readyFor(a.key)
  assert.equal(h.state.officeDocument.value,undefined);assert.equal(h.state.presentationDocument.value.id,a.key)
  assert.equal(await h.state.saveActive(),true)
  assert.equal(officeExports,0);assert.equal(presentationExports,1)
  assert.equal(h.state.officeDocument.value,undefined)
})

test('presentation and Office/PDF switches preserve separate model identities and route each export', async () => {
  const h=shell(),deck=h.tab('deck',{kind:'presentation'}),office=h.tab('office',{wordEngine:'legacy'}),pdf=h.tab('pdf',{kind:'pdf'})
  h.active(office);await vue.nextTick();const officeDocument=h.state.officeDocument.value
  const exports=[]
  h.handle.exportFile=async()=>{exports.push(h.state.active.value.document.kind);return {base64:'T0ZGSUNF',extension:h.state.active.value.document.extension}}
  h.presentationHandle.exportFile=async()=>{exports.push('independent-presentation');return {base64:'UFBUWA==',extension:'pptx',dirty:true}}
  await h.state.activate(deck);h.state.readyFor(deck.key)
  assert.equal(h.state.officeDocument.value,officeDocument)
  assert.equal(h.state.presentationDocument.value.id,deck.key)
  await h.state.activate(pdf);h.state.readyFor(pdf.key)
  assert.equal(deck.document.base64,'UFBUWA==');assert.equal(deck.dirty,true)
  const presentationDocument=h.state.presentationDocument.value
  await h.state.activate(office)
  assert.equal(office.ready,true);assert.equal(h.state.presentationDocument.value,presentationDocument)
  await h.state.activate(deck)
  assert.equal(deck.ready,true);assert.equal(h.state.presentationDocument.value.id,deck.key)
  assert.equal(h.state.presentationDocument.value.base64,'UFBUWA==')
  assert.deepEqual(exports,['word','independent-presentation','pdf','word'])
})

test('closing the final presentation releases its model while retaining the active Office/PDF editor', async () => {
  for (const kind of ['word','pdf']) {
    const h=shell(),deck=h.tab('deck',{kind:'presentation'}),other=h.tab('other',{wordEngine:'legacy',kind});h.active(deck)
    await h.state.activate(other);h.state.readyFor(other.key)
    const field=kind==='pdf'?'pdfDocument':'officeDocument', retained=h.state[field].value
    const discards=h.calls.filter(call=>call[0]==='discard').length
    h.state.closeTab(deck);await h.idle()
    assert.equal(h.state.presentationDocument.value,undefined)
    assert.equal(h.state[field].value,retained);assert.equal(h.state.activeKey.value,other.key)
    assert.equal(other.ready,true);assert.equal(h.calls.filter(call=>call[0]==='discard').length,discards)
  }
})

for(const failure of ['draft','cancelled','conflict','save-error']) test(`failed presentation close retains its independent model and content after ${failure}`,async()=>{
  const h=shell(),a=h.tab('deck',{kind:'presentation',dirty:true});h.tab('pdf',{kind:'pdf'});h.active(a)
  const original=h.state.presentationDocument.value
  if(failure==='draft')h.presentationHandle.assertNoPendingEdits=()=>{throw Error('Pending presentation draft')}
  else h.native.saveDocument=async()=>{
    if(failure==='save-error')throw Error('Write failed')
    return {status:failure,message:'External change'}
  }
  h.state.closeTarget.value=a;await h.state.resolveClose('save')
  assert.equal(h.state.presentationDocument.value,original);assert.equal(h.state.officeDocument.value,undefined)
  assert.equal(h.state.activeKey.value,a.key);assert.equal(a.dirty,true)
  assert.equal(h.state.tabs.value.length,2);assert.equal(h.state.closeTarget.value.key,a.key)
  assert.ok(!h.calls.some(call=>call[0]==='discard'||call[0]==='marked'))
})

test('presentation save and switch retain its PPTX snapshot and presentation identity', async () => {
  const h=shell(), a=h.tab('deck',{kind:'presentation',dirty:true}), b=h.tab('other',{kind:'pdf'});h.active(a)
  h.handle.exportFile=async()=>({base64:'UFBUWA==',extension:'pptx',dirty:true})
  assert.equal(await h.state.saveActive(),true)
  assert.equal(a.document.kind,'presentation');assert.equal(a.document.extension,'pptx')
  assert.equal(a.document.base64,'UFBUWA==');assert.equal(a.dirty,false)
  await h.state.activate(b)
  h.handle.exportFile=async()=>({base64:'UERGX0VYSVNUSU5H',extension:'pdf'})
  h.state.readyFor('other')
  await h.state.activate(a)
  assert.equal(h.state.presentationDocument.value.id,'deck')
  assert.equal(h.state.presentationDocument.value.base64,'UFBUWA==')
  assert.equal(h.state.presentationDocument.value.kind,'presentation')
  assert.equal(h.state.officeDocument.value,undefined)
})

test('native window close exits presentation preview before showing unsaved confirmation', async()=>{
  const h=shell(), a=h.tab('deck',{kind:'presentation',dirty:true});h.active(a)
  h.handle.exportFile=async()=>({base64:'UFBUWA==',extension:'pptx',dirty:true})
  h.state.slidePreview.value={base64:'JVBERg==',name:'deck.pptx',startPage:0}
  await h.state.closeWindow()
  assert.equal(h.state.slidePreview.value,undefined)
  assert.equal(h.state.closeTarget.value,'window')
  assert.ok(h.calls.some(call=>call[0]==='stop-presentation'),'Independent player must close before the window confirmation')
  assert.equal(a.dirty,true)
  assert.ok(!h.calls.some(call=>call[0]==='close'))
})


test('pending presentation text or transition drafts prevent saving and tab switching', async () => {
  for (const panel of ['text', 'transition']) {
    const h = shell(), a = h.tab('A', { kind: 'presentation' }), b = h.tab('B',{wordEngine:'legacy'}); h.active(a)
    let exports = 0
    h.handle.exportFile = async () => { exports++; return {base64:'NEW',extension:'pptx'} }
    h.presentationHandle.assertNoPendingEdits = () => { throw Error(`Unapplied ${panel}`) }
    await assert.rejects(h.state.saveActive(), /Unapplied|尚未应用/)
    await assert.rejects(h.state.activate(b), /Unapplied|尚未应用/)
    assert.equal(h.state.activeKey.value, 'A')
    assert.equal(a.document.base64, 'T0xE')
    assert.equal(exports, 0)
  }
})

test('confirmed discard clears presentation drafts before replacing the loaded tab', async () => {
  const h = shell(), a = h.tab('A', { kind: 'presentation', dirty: true }); h.active(a)
  let dropped = 0, textDraft = true, transitionDraft = true
  h.presentationHandle.assertNoPendingEdits = () => { throw Error('Unapplied notes and transition') }
  h.presentationHandle.discardDrafts = () => { dropped++; textDraft = false; transitionDraft = false }
  h.state.closeTarget.value = a
  await h.state.resolveClose('discard')
  assert.equal(dropped, 1)
  assert.equal(textDraft, false); assert.equal(transitionDraft, false)
  assert.equal(h.state.presentationDocument.value,undefined)
  assert.equal(h.state.tabs.value.length, 0)
  assert.ok(h.calls.some(call=>call[0]==='discard' && call[1].force === true))
})

test('native duplicate-slide request uses the metadata-aware editor and respects unapplied drafts', async () => {
  const h = shell(), a = h.tab('deck', {kind:'presentation'}); h.active(a)
  const actions = []
  h.handle.presentationAction = async action => {
    actions.push(action)
    return {documentId:'deck',pageCount:2,currentPageIndex:1,pages:[]}
  }
  h.state.officeRequest({type:'presentation-duplicate',pageIndex:0})
  await h.idle()
  assert.equal(actions.length,1)
  assert.equal(actions[0].type,'duplicate-page')
  assert.equal(actions[0].pageIndex,0)
  assert.equal(h.state.presentationState.value.pageCount,2)
  h.presentationHandle.assertNoPendingEdits = () => { throw Error('切换设置尚未应用') }
  h.state.officeRequest({type:'presentation-duplicate',pageIndex:0})
  await h.idle()
  assert.match(h.state.error.value,/尚未应用/)
  assert.equal(actions.length,1,'Unapplied effect drafts must not be detached from their page')
})

for (const [kind,panel] of [['word','wordWorkbench'],['sheet','sheetWorkbench']]) {
  test(`${kind} pending inputs prevent export and tab switching until applied or explicitly discarded`, async () => {
    const h=shell(), a=h.tab('A',{wordEngine:'legacy',kind,dirty:true}), b=h.tab('B',{wordEngine:'legacy'});h.active(a)
    let exports=0,discarded=0
    h.handle.exportFile=async()=>{exports++;return {base64:'NEW',extension:kind==='word'?'docx':'xlsx'}}
    h.state[panel].value={assertNoPendingEdits(){throw Error('Unapplied workspace input')},discardDrafts(){discarded++}}
    await assert.rejects(h.state.saveActive(),/Unapplied/)
    await assert.rejects(h.state.activate(b),/Unapplied/)
    assert.equal(exports,0);assert.equal(h.state.activeKey.value,'A')
    h.state.closeTarget.value=a
    await h.state.resolveClose('discard')
    assert.equal(discarded,1)
    assert.ok(!h.state.tabs.value.some(tab=>tab.key==='A'))
  })
}

for(const [kind,getter,field] of [['word','getWriterState','writerState'],['sheet','getCalcState','calcState'],['presentation','getPresentationState','presentationState']]) {
 test(`${kind} toolbar refreshes when returning from PDF to its retained editor`,async()=>{
   const h=shell(),office=h.tab('office',{wordEngine:'legacy',kind}),pdf=h.tab('pdf',{kind:'pdf'});h.active(pdf)
   const documentField=kind==='presentation'?'presentationDocument':'officeDocument'
   h.state[documentField].value=office.document
   const reopened=[]
   const handle=kind==='presentation'?h.presentationHandle:h.handle
   handle[getter]=async()=>{reopened.push(office.key);return {documentId:office.key,revision:3,dirty:false}}
   await h.state.activate(office)
   assert.deepEqual(reopened,['office'])
   assert.equal(h.state[field].value.documentId,'office')
   assert.equal(h.state[documentField].value.id,'office')
   if(kind==='presentation')assert.equal(h.state.officeDocument.value,undefined)
 })
}

test('native clean notifications never clear a tab with unsaved user content', () => {
  const h = shell(), tab = h.tab('A', {wordEngine:'legacy', dirty: true })
  h.state.tabs.value = [tab]; h.state.activeKey.value = 'A'
  h.state.dirtyFor('A', false)
  assert.equal(tab.dirty, true)
  tab.dirty = false
  h.state.dirtyFor('A', true)
  assert.equal(tab.dirty, true)
})

test('independent Word new/save uses only its editor while explicit compatibility keeps its Office route', async () => {
  const original=shell();original.state.newDocument('word','legacy');await original.idle()
  assert.equal(original.state.tabs.value[0].wordEngine,'legacy')
  assert.equal(original.state.officeDocument.value.id,original.state.activeKey.value)
  assert.equal(original.state.independentWordDocument.value,undefined)
  const h=shell();let exports=0,marked=0
  h.handle.exportFile=async()=>assert.fail('Independent Word must not export through the Office/PDF handle')
  h.independentWordHandle.exportFile=async({format})=>{exports++;assert.equal(format,'docx');return {base64:'V09SRA==',extension:'docx',dirty:true}}
  h.independentWordHandle.markSaved=async()=>{marked++}
  h.state.newDocument('word','independent');await h.idle()
  const tab=h.state.active.value;h.state.readyFor(tab.key)
  assert.equal(h.state.home.value,false);assert.equal(tab.wordEngine,'independent')
  assert.equal(h.state.officeDocument.value,undefined);assert.equal(h.state.independentWordDocument.value.id,tab.key)
  assert.equal(await h.state.saveActive(),true)
  assert.equal(exports,1);assert.equal(marked,1);assert.equal(tab.dirty,false);assert.equal(tab.ready,true)
  assert.equal(tab.document.base64,'V09SRA==');assert.equal(tab.wordEngine,'independent')
  assert.equal(h.state.officeDocument.value,undefined)
})

test('independent Word exposes only DOCX and rejects unsupported export before reaching any editor or dialog', async () => {
  const h=shell(),tab=h.tab('plain',{wordEngine:'independent',dirty:true});h.active(tab)
  let exports=0;h.independentWordHandle.exportFile=async()=>{exports++;return {base64:'V09SRA==',extension:'docx'}}
  h.state.openSaveAs()
  assert.deepEqual(Array.from(h.state.saveAsOptions.value,option=>option.extension),['docx'])
  for(const format of ['odt','pdf'])await assert.rejects(h.state.saveActive(true,format),/只支持保存 DOCX/)
  h.state.saveAsDraft.value.format='odt';await h.state.confirmSaveAs()
  assert.match(h.state.saveAsDraft.value.error,/支持的格式/)
  assert.equal(exports,0);assert.ok(!h.calls.some(call=>call[0]==='save'))
  assert.equal(tab.dirty,true);assert.equal(tab.document.extension,'docx')
})

test('independent Word external import preflights before tab creation and preserves source-copy protection through cancellation and snapshots', async () => {
  const h=shell(),source={id:'source',kind:'word',extension:'docx',name:'Source.docx',base64:'T0xE',sha256:'original-hash',sizeBytes:3}
  await h.state.addDocument(source,'source','independent')
  const tab=h.state.active.value;h.state.readyFor(tab.key)
  assert.deepEqual(h.calls.filter(call=>call[0]==='independent-preflight'),[['independent-preflight',3]])
  assert.equal(tab.requiresSaveAs,true);assert.equal(tab.dirty,false)
  h.independentWordHandle.exportFile=async()=>({base64:'V09SRA==',extension:'docx',dirty:true})
  h.native.saveDocument=async request=>{h.calls.push(['cancelled-independent-save',request]);return {status:'cancelled'}}
  assert.equal(await h.state.saveActive(),false)
  const request=h.calls.find(call=>call[0]==='cancelled-independent-save')[1]
  assert.equal(request.documentId,undefined);assert.equal(request.expectedSha256,undefined);assert.equal(request.saveAs,true)
  assert.equal(request.name,'Source - 副本.docx')
  await h.state.stash()
  assert.equal(tab.requiresSaveAs,true);assert.equal(tab.fileId,'source');assert.equal(tab.document.sha256,'original-hash')
  assert.equal(tab.document.base64,'V09SRA==');assert.equal(tab.dirty,true)
  h.native.saveDocument=async request=>{h.calls.push(['saved-independent-copy',request]);return {status:'saved',document:{id:'copy',kind:'word',extension:'docx',name:request.name,sha256:'copy-hash',sizeBytes:4}}}
  assert.equal(await h.state.saveActive(),true)
  assert.equal(h.calls.find(call=>call[0]==='saved-independent-copy')[1].documentId,undefined)
  assert.equal(tab.fileId,'copy');assert.equal(tab.requiresSaveAs,false);assert.equal(tab.dirty,false)
  assert.equal(tab.wordEngine,'independent');assert.equal(tab.document.name,'Source - 副本.docx')
})

test('prepared Word models transfer once only to the exact id and source bytes, and mismatches release the delivery', () => {
  const source={id:'first',base64:'T0xE'},model={paragraphs:[{text:'validated'}]}
  const prepared=prepareWordDocument(source,model)
  assert.equal(prepared.take({...source}),model,'Ownership transfer must not clone the large validated model')
  assert.equal(prepared.take(source),undefined)
  for(const changed of [{...source,id:'second'},{...source,base64:'TkVX'}]) {
    const stale=prepareWordDocument(source,model)
    assert.equal(stale.take(changed),undefined)
    assert.equal(stale.take(source),undefined,'A mismatched attempt must also release the model')
  }
  const discarded=prepareWordDocument(source,model);discarded.discard()
  assert.equal(discarded.take(source),undefined)
})

test('independent editor consumes a prepared model without import and keeps an already loaded same-id live model', async () => {
  const source={id:'first',extension:'docx',base64:'T0xE'},model={paragraphs:[],validated:true},prepared=prepareWordDocument(source,model)
  const h=wordLoader(source,prepared);await h.state.settled()
  assert.equal(h.requests.length,0);assert.equal(h.state.controller.value.model,model)
  assert.equal(prepared.take(source),undefined)
  h.props.document={...source,base64:'TkVX'};await vue.nextTick()
  assert.equal(h.requests.length,0);assert.equal(h.state.controller.value.model,model,'Saved snapshots cannot replace the live edited controller')
  assert.equal(h.events.filter(event=>event[0]==='ready').length,1)
  h.unmount()
})

test('independent editor discards mismatched preparation and imports the captured source exactly once', async () => {
  const source={id:'current',extension:'docx',base64:'TkVX'}
  for(const original of [{...source,id:'old'},{...source,base64:'T0xE'}]) {
    const prepared=prepareWordDocument(original,{paragraphs:[],stale:true}),h=wordLoader(source,prepared)
    assert.equal(h.requests.length,1);assert.deepEqual(h.requests[0].bytes,Array.from(Buffer.from('NEW')))
    assert.equal(prepared.take(original),undefined)
    const current={paragraphs:[],current:true};h.requests[0].resolve(current);await h.state.settled()
    assert.equal(h.state.controller.value.model,current);h.unmount()
  }
})

test('independent editor source replacements reject stale async success and failure while preserving the latest load', async () => {
  const source={id:'first',extension:'docx',base64:'T0xE'},h=wordLoader(source)
  const oldOpening=h.state.settled()
  h.props.document={...source,base64:'TkVX'};await vue.nextTick()
  assert.equal(h.requests.length,2,'A source change during import must restart even with the same id')
  assert.deepEqual(h.requests.map(request=>request.bytes),[Array.from(Buffer.from('OLD')),Array.from(Buffer.from('NEW'))])
  const secondOpening=h.state.settled()
  h.props.document={...source,id:'third',base64:'VEhJUkQ='};await vue.nextTick()
  assert.equal(h.requests.length,3)
  h.requests[0].resolve({paragraphs:[],old:true});h.requests[1].reject(Error('Obsolete import failed'))
  await Promise.all([oldOpening,secondOpening])
  assert.equal(h.state.controller.value,undefined);assert.equal(h.state.loading.value,true)
  assert.ok(!h.events.some(event=>event[0]==='ready'||event[0]==='error'))
  const latest={paragraphs:[],latest:true};h.requests[2].resolve(latest);await h.state.settled()
  assert.equal(h.state.controller.value.model,latest);assert.equal(h.state.loading.value,false)
  assert.equal(h.events.filter(event=>event[0]==='ready').length,1);h.unmount()
})

test('independent editor restarts a same-id source changed before prepared render and retries corrected failed imports', async () => {
  const source={id:'same',extension:'docx',base64:'T0xE'},prepared=prepareWordDocument(source,{paragraphs:[],old:true})
  const h=wordLoader(source,prepared)
  h.props.document={...source,base64:'TkVX'};await vue.nextTick()
  assert.equal(h.requests.length,1,'A consumed prepared model is not ready until its render tick completes')
  assert.ok(!h.events.some(event=>event[0]==='ready'))
  h.requests[0].reject(Error('Invalid replacement'));await h.state.settled()
  assert.equal(h.state.controller.value,undefined);assert.match(h.state.problem.value,/Invalid replacement/)
  h.props.document={...source,base64:'RklYRUQ='};await vue.nextTick()
  assert.equal(h.requests.length,2)
  const fixed={paragraphs:[],fixed:true};h.requests[1].resolve(fixed);await h.state.settled()
  assert.equal(h.state.controller.value.model,fixed);assert.equal(h.state.problem.value,'')
  assert.equal(h.events.filter(event=>event[0]==='ready').length,1);h.unmount()
})

test('independent editor disposal suppresses pending imports and invalid extensions discard preparation', async () => {
  const source={id:'pending',extension:'docx',base64:'T0xE'},h=wordLoader(source),opening=h.state.settled()
  h.unmount();h.requests[0].resolve({paragraphs:[],late:true});await opening
  assert.equal(h.state.controller.value,undefined);assert.ok(!h.events.some(event=>event[0]==='ready'||event[0]==='error'))
  const prepared=prepareWordDocument(source,{paragraphs:[]}),invalid=wordLoader({...source,extension:'odt'},prepared)
  await invalid.state.settled()
  assert.equal(invalid.requests.length,0);assert.equal(prepared.take(source),undefined)
  assert.equal(invalid.state.controller.value,undefined);assert.match(invalid.state.problem.value,/DOCX/);invalid.unmount()
})

test('independent Word delivers its preflight model outside persistent document state and never reuses it after snapshots or reopening', async () => {
  const h=shell(),source={id:'source',kind:'word',extension:'docx',name:'Source.docx',base64:'T0xE',sha256:'original-hash',sizeBytes:3}
  await h.state.addDocument(source,'source','independent')
  const tab=h.state.active.value,delivery=h.state.independentWordPrepared.value
  assert.equal(delivery.take(h.state.independentWordDocument.value),h.independentModels[0])
  assert.ok(!JSON.stringify(tab).includes('testImport'),'Tab and NativeDocument must not store a model')
  h.state.readyFor(tab.key)
  h.independentWordHandle.exportFile=async()=>({base64:'TkVX',extension:'docx',dirty:true})
  await h.state.stash()
  assert.equal(tab.document.base64,'TkVX')
  assert.equal(delivery.take(tab.document),undefined)
  const other=h.tab('other',{wordEngine:'independent'})
  await h.state.activate(other);h.state.readyFor(other.key)
  assert.equal(h.state.independentWordPrepared.value,undefined)
  await h.state.activate(tab);h.state.readyFor(tab.key)
  assert.equal(h.state.independentWordPrepared.value,undefined,'Returning from another model must parse the current snapshot')
  h.state.closeTarget.value=tab;await h.state.resolveClose('discard')
  h.state.readyFor(h.state.activeKey.value)
  await h.state.addDocument(source,'source','independent')
  const reopened=h.state.active.value
  assert.notEqual(reopened.key,tab.key)
  assert.equal(h.state.independentWordPrepared.value.take(reopened.document),h.independentModels[1])
  assert.equal(h.calls.filter(call=>call[0]==='independent-preflight').length,2)
})

test('independent Word discards undelivered models on failed stash, replacement, close and application disposal', async () => {
  const source={id:'source',kind:'word',extension:'docx',name:'Source.docx',base64:'T0xE',sha256:'',sizeBytes:3}
  const failed=shell(),live=failed.tab('live',{wordEngine:'independent',dirty:true});failed.active(live)
  failed.independentWordHandle.exportFile=async()=>{throw Error('Pending composition')}
  await assert.rejects(failed.state.addDocument(source,'source','independent'),/Pending composition/)
  assert.equal(failed.state.tabs.value.length,1);assert.equal(failed.state.activeKey.value,'live')
  assert.equal(failed.state.independentWordPrepared.value,undefined)
  assert.equal(failed.preparations[0].handoff.take(failed.preparations[0].source),undefined)
  const h=shell();await h.state.addDocument(source,'source','independent')
  const first=h.preparations[0],tab=h.state.active.value;h.state.readyFor(tab.key)
  await h.state.addDocument({...source,id:'next'},'next','independent')
  assert.equal(first.handoff.take(first.source),undefined,'Replacing the source clears an unconsumed model')
  const second=h.preparations[1],next=h.state.active.value;h.state.readyFor(next.key)
  h.state.closeTarget.value=next;await h.state.resolveClose('discard')
  assert.equal(second.handoff.take(second.source),undefined)
  h.state.readyFor(h.state.activeKey.value)
  await h.state.addDocument(source,'third','independent')
  const third=h.preparations[2];h.unmount()
  assert.equal(third.handoff.take(third.source),undefined)
  assert.equal(h.state.independentWordPrepared.value,undefined)
})

test('independent Word preflight captures immutable source bytes and cannot publish after application disposal', async () => {
  let finish
  const h=shell({independentImport:()=>new Promise(resolve=>{finish=resolve})})
  const source={id:'source',kind:'word',extension:'docx',name:'Source.docx',base64:'T0xE',sha256:'',sizeBytes:3}
  const opening=h.state.addDocument(source,'source','independent')
  await Promise.resolve();await Promise.resolve()
  assert.equal(h.state.tabs.value.length,0)
  source.base64='TkVX';finish({paragraphs:[]});await opening
  const tab=h.state.active.value
  assert.equal(tab.document.base64,'T0xE')
  assert.equal(h.state.independentWordPrepared.value.take(tab.document),h.independentModels[0])
  h.state.readyFor(tab.key)
  const pending=h.state.addDocument({...source,id:'another'},'another','independent')
  await Promise.resolve();await Promise.resolve();h.unmount();finish({paragraphs:[]});await pending
  assert.equal(h.state.tabs.value.length,1)
  const abandoned=h.preparations.at(-1)
  assert.equal(abandoned.handoff.take(abandoned.source),undefined)
  assert.equal(h.state.independentWordPrepared.value,undefined)
})

test('independent Word rejects unsupported imports before snapshotting or replacing a live document', async () => {
  const h=shell({independentImportError:'Unsupported DOCX table'}),tab=h.tab('live',{wordEngine:'independent',dirty:true});h.active(tab)
  const live=h.state.independentWordDocument.value;let exports=0
  h.independentWordHandle.exportFile=async()=>{exports++;throw Error('Should not snapshot rejected import')}
  await assert.rejects(h.state.addDocument({id:'bad',kind:'word',extension:'docx',name:'Bad.docx',base64:'T0xE',sha256:'',sizeBytes:3},'bad','independent'),/Unsupported DOCX table/)
  await assert.rejects(h.state.addDocument({id:'odt',kind:'word',extension:'odt',name:'Other.odt',base64:'T0xE',sha256:'',sizeBytes:3},'odt','independent'),/只支持 DOCX/)
  assert.equal(exports,0);assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key)
  assert.equal(h.state.independentWordDocument.value,live);assert.equal(tab.dirty,true);assert.equal(h.state.officeDocument.value,undefined)
})

test('the same file can have separate Word engines and reopening the same engine retains its live snapshot', async () => {
  const h=shell(),original=h.tab('original',{wordEngine:'legacy',fileId:'same-file'});h.active(original)
  const source={id:'same-file',kind:'word',extension:'docx',name:'Same.docx',base64:'T0xE',sha256:'',sizeBytes:3}
  await h.state.addDocument(source,'same-file','independent')
  const independent=h.state.active.value;h.state.readyFor(independent.key)
  assert.notEqual(independent.key,original.key);assert.equal(h.state.tabs.value.length,2)
  assert.equal(h.state.officeDocument.value.id,original.key);assert.equal(h.state.independentWordDocument.value.id,independent.key)
  h.independentWordHandle.exportFile=async()=>({base64:'TElWRQ==',extension:'docx',dirty:true})
  await h.state.addDocument(source,'same-file','legacy')
  assert.equal(h.state.activeKey.value,original.key);assert.equal(independent.document.base64,'TElWRQ==')
  await h.state.addDocument(source,'same-file','independent')
  assert.equal(h.state.activeKey.value,independent.key);assert.equal(h.state.tabs.value.length,2)
  assert.equal(h.state.independentWordDocument.value.base64,'TElWRQ==');assert.equal(independent.ready,true);assert.equal(independent.dirty,true)
  assert.equal(h.calls.filter(call=>call[0]==='independent-preflight').length,1)
})

test('independent Word switches snapshot the correct editor and returning to its live model preserves readiness', async () => {
  const h=shell(),first=h.tab('first',{wordEngine:'independent'}),second=h.tab('second',{wordEngine:'independent'}),pdf=h.tab('pdf',{kind:'pdf'});h.active(first)
  const exports=[]
  h.independentWordHandle.exportFile=async()=>{const id=h.state.activeKey.value;exports.push(id);return {base64:id==='first'?'RklSU1Q=':'U0VDT05E',extension:'docx',dirty:true}}
  h.handle.exportFile=async()=>{assert.equal(h.state.active.value.document.kind,'pdf');exports.push('pdf');return {base64:'UERGOg==',extension:'pdf'}}
  await h.state.activate(pdf);h.state.readyFor(pdf.key)
  assert.equal(first.document.base64,'RklSU1Q=');assert.equal(first.dirty,true)
  await h.state.activate(first)
  assert.equal(first.ready,true);assert.equal(h.state.independentWordDocument.value.base64,'RklSU1Q=')
  await h.state.activate(second)
  assert.equal(second.ready,false);assert.equal(h.state.independentWordDocument.value.id,second.key)
  h.state.readyFor(second.key);await h.state.activate(first)
  assert.equal(second.document.base64,'U0VDT05E');assert.equal(first.ready,false)
  assert.equal(h.state.independentWordDocument.value.base64,'RklSU1Q=');assert.equal(h.state.officeDocument.value,undefined)
  assert.deepEqual(exports,['first','pdf','first','second'])
})

test('independent Word export rejection leaves the active model intact and prevents switching or closing', async () => {
  const h=shell(),tab=h.tab('typing',{wordEngine:'independent',dirty:true}),pdf=h.tab('pdf',{kind:'pdf'});h.active(tab)
  const live=h.state.independentWordDocument.value
  h.independentWordHandle.exportFile=async()=>{throw Error('Composition has not committed')}
  await assert.rejects(h.state.activate(pdf),/Composition/)
  assert.equal(h.state.activeKey.value,tab.key);assert.equal(tab.document.base64,'T0xE')
  h.state.closeTarget.value=tab;await h.state.resolveClose('save')
  assert.match(h.state.error.value,/Composition/);assert.equal(h.state.closeTarget.value.key,tab.key)
  assert.equal(h.state.independentWordDocument.value,live);assert.equal(h.state.tabs.value.length,2)
  assert.ok(!h.calls.some(call=>['save','discard','marked'].includes(call[0])))
})

test('independent Word confirmed discard releases only its editor and cancelled saving preserves it', async () => {
  const h=shell(),tab=h.tab('plain',{wordEngine:'independent',dirty:true}),pdf=h.tab('pdf',{kind:'pdf'});h.active(tab)
  const live=h.state.independentWordDocument.value;let discarded=0
  h.independentWordHandle.discardChanges=async options=>{assert.equal(options.force,true);discarded++}
  h.independentWordHandle.exportFile=async()=>({base64:'V09SRA==',extension:'docx',dirty:true})
  h.native.saveDocument=async()=>({status:'cancelled'})
  h.state.closeTab(tab);assert.equal(h.state.closeTarget.value.key,tab.key)
  await h.state.resolveClose('save')
  assert.equal(discarded,0);assert.equal(h.state.independentWordDocument.value,live);assert.equal(tab.dirty,true)
  assert.equal(h.state.tabs.value.length,2);assert.equal(h.state.activeKey.value,tab.key)
  await h.state.resolveClose('discard')
  assert.equal(discarded,1);assert.equal(h.state.independentWordDocument.value,undefined);assert.equal(h.state.officeDocument.value,undefined)
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,pdf.key);assert.equal(h.state.pdfDocument.value.id,pdf.key)
  assert.equal(h.state.closeTarget.value,null)
})

// These cases verify App's engine selection and ownership only. The preparation
// double intentionally does not decide whether an actual DOCX is supported.
function rustSource(id='source') {
  return {id,kind:'word',extension:'docx',name:`${id}.docx`,base64:'T0xE',sha256:'source-hash',sizeBytes:3}
}
function browserWordInput() {
  const bytes=zipSync({'word/document.xml':strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>')})
  return {value:'Browser.docx',files:[{name:'Browser.docx',size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}
}

test('default Word new/save routes exclusively through Rust and prepares even an empty document',async()=>{
  const h=shell();let exports=0,marked=0
  h.handle.exportFile=async()=>assert.fail('Default Word must not export through Office')
  h.independentWordHandle.exportFile=async()=>assert.fail('Default Word must not export through the old lightweight editor')
  h.rustWordHandle.exportFile=async({format})=>{exports++;assert.equal(format,'docx');return{base64:'UlVTVA==',extension:'docx',dirty:true}}
  h.rustWordHandle.markSaved=async bytes=>{marked++;assert.equal(bytes,'UlVTVA==')}
  h.state.newDocument('word');await h.idle()
  const tab=h.state.active.value,prepared=h.rustPreparations[0]
  assert.equal(tab.wordEngine,'rust');assert.equal(tab.document.extension,'docx')
  assert.equal(h.state.officeDocument.value,undefined);assert.equal(h.state.independentWordDocument.value,undefined)
  assert.equal(h.rustPreparations.length,1);assert.equal(prepared.source.base64,'');assert.equal(prepared.source.id,tab.key)
  assert.equal(h.state.rustWordDocument.value.id,tab.key)
  assert.equal(h.state.rustWordPrepared.value.take(tab.document),prepared.session)
  assert.equal(h.state.rustWordPrepared.value.take(tab.document),undefined)
  h.state.readyFor(tab.key);assert.equal(await h.state.saveActive(),true)
  assert.equal(exports,1);assert.equal(marked,1);assert.equal(tab.dirty,false)
  assert.equal(tab.document.base64,'UlVTVA==');assert.equal(tab.wordEngine,'rust')
  h.unmount()
})

for(const route of ['native','recent','browser'])test(`generic ${route} DOCX opening selects Rust with exactly one bound preparation`,async()=>{
  const h=shell({nativeEnabled:route!=='browser'}),source=rustSource(route)
  if(route==='native'){h.native.openDocument=async()=>source;h.state.openFile();await h.idle()}
  else if(route==='recent'){h.native.openRecent=async id=>{assert.equal(id,'recent');return source};h.state.openRecent({id:'recent'});await h.idle()}
  else {const input=browserWordInput();await h.state.browserFile({target:input});assert.equal(input.value,'')}
  const tab=h.state.active.value
  assert.equal(tab.wordEngine,'rust');assert.equal(h.rustPreparations.length,1)
  assert.equal(h.rustPreparations[0].source.id,tab.key);assert.equal(h.rustPreparations[0].source.base64,tab.document.base64)
  assert.equal(h.state.rustWordPrepared.value,h.rustPreparations[0].handoff)
  assert.equal(tab.requiresSaveAs,true);assert.equal(h.state.officeDocument.value,undefined)
  assert.equal(h.calls.filter(c=>c[0]==='independent-preflight').length,0)
  h.unmount()
})

for(const route of ['native','browser'])test(`explicit ${route} compatibility Word opening bypasses Rust preparation`,async()=>{
  const h=shell({nativeEnabled:route==='native'})
  if(route==='native'){h.native.openDocument=async()=>({...rustSource('Legacy'),extension:'doc',name:'Legacy.doc'});h.state.openLegacyWord();await h.idle()}
  else {const input=browserWordInput();await h.state.browserLegacyWord({target:input});assert.equal(input.value,'')}
  assert.equal(h.state.active.value.wordEngine,'legacy')
  assert.equal(h.state.officeDocument.value.id,h.state.activeKey.value)
  assert.equal(h.state.rustWordDocument.value,undefined);assert.equal(h.rustPreparations.length,0)
  h.unmount()
})

for(const engine of ['rust','legacy'])test(`failed default Rust preflight leaves the active dirty ${engine} tab untouched without fallback`,async()=>{
  const h=shell({rustPrepareError:'Unsupported DOCX table'}),tab=h.tab('live',{wordEngine:engine,dirty:true});h.active(tab)
  const before=JSON.stringify(tab),live=h.state[engine==='rust'?'rustWordDocument':'officeDocument'].value
  h.handle.exportFile=async()=>assert.fail('Rejected source must not snapshot the current editor')
  for(const extension of ['doc','rtf','odt'])await assert.rejects(h.state.addDocument({...rustSource('other'),extension}),/基础 DOCX/)
  assert.equal(h.calls.length,0,'Unsupported extensions fail before even Rust preparation')
  await assert.rejects(h.state.addDocument(rustSource('bad'),'bad'),/Unsupported DOCX table/)
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'rust-preflight')
  assert.equal(h.state.tabs.value.length,1);assert.equal(h.state.activeKey.value,tab.key)
  assert.equal(JSON.stringify(tab),before);assert.equal(h.state[engine==='rust'?'rustWordDocument':'officeDocument'].value,live)
  assert.equal(h.reviews.length,0);assert.equal(h.state.independentWordDocument.value,undefined)
  h.unmount()
})

test('successful Rust preparation precedes snapshot/discard/publication and captures immutable source bytes',async()=>{
  let finish
  const h=shell({rustPrepare:()=>new Promise(resolve=>{finish=resolve})}),tab=h.tab('live',{wordEngine:'legacy',dirty:true});h.active(tab)
  h.handle.exportFile=async()=>{h.calls.push(['export-current']);return{base64:'RURJVA==',extension:'docx',dirty:true}}
  const source=rustSource('incoming'),opening=h.state.addDocument(source,source.id)
  await Promise.resolve()
  assert.equal(h.state.activeKey.value,tab.key);assert.equal(h.state.tabs.value.length,1)
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'rust-preflight');assert.equal(tab.document.base64,'T0xE')
  source.base64='TkVX';finish({testRustSession:'incoming'});await opening
  const next=h.state.active.value
  assert.deepEqual(h.calls.map(c=>c[0]),['rust-preflight','rust-prepared','export-current','discard'])
  assert.equal(tab.document.base64,'RURJVA==');assert.equal(tab.dirty,true)
  assert.equal(next.document.base64,'T0xE');assert.equal(next.wordEngine,'rust');assert.notEqual(next.key,tab.key)
  assert.equal(h.state.rustWordEntries.value.length,1);assert.equal(h.state.rustWordEntries.value[0].prepared,h.rustPreparations[0].handoff)
  assert.equal(h.state.rustWordPrepared.value.take(next.document),h.rustPreparations[0].session)
  assert.equal(h.state.rustWordPrepared.value.take(next.document),undefined)
  h.unmount()
})

test('failed snapshot and disposal release an undelivered Rust preparation without publishing a tab',async()=>{
  const h=shell(),tab=h.tab('typing',{wordEngine:'legacy',dirty:true});h.active(tab)
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
  assert.equal(disposed.state.tabs.value.length,0);assert.equal(disposed.state.rustWordDocument.value,undefined)
  assert.equal(disposed.rustPreparations[0].discarded,1)
  assert.equal(disposed.rustPreparations[0].handoff.take(disposed.rustPreparations[0].source),undefined)
})

test('Rust supports DOCX-only saving and protects imported identity until a new copy succeeds',async()=>{
  const h=shell();await h.state.addDocument(rustSource('original'),'original')
  const tab=h.state.active.value;h.state.readyFor(tab.key);tab.dirty=true
  let exports=0
  h.rustWordHandle.exportFile=async()=>{exports++;return{base64:'UlVTVA==',extension:'docx',dirty:true}}
  h.state.openSaveAs();assert.deepEqual(Array.from(h.state.saveAsOptions.value,o=>o.extension),['docx'])
  for(const format of ['pdf','odt'])await assert.rejects(h.state.saveActive(true,format),/不支持此保存格式/)
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
  assert.equal(tab.wordEngine,'rust');assert.ok(h.calls.some(c=>c[0]==='marked'))
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

test('default reopening reuses only its Rust tab while explicit compatibility may open the same file separately',async()=>{
  const h=shell(),source=rustSource('same')
  await h.state.addDocument(source,'same');const rust=h.state.active.value;h.state.readyFor(rust.key)
  const entry=h.state.rustWordEntries.value[0]
  h.rustWordHandle.exportFile=async()=>({base64:'TElWRQ==',extension:'docx',dirty:true})
  await h.state.addDocument(source,'same','legacy');const legacy=h.state.active.value;h.state.readyFor(legacy.key)
  assert.notEqual(legacy.key,rust.key);assert.equal(legacy.wordEngine,'legacy');assert.equal(rust.document.base64,'TElWRQ==')
  await h.state.addDocument({...source,base64:'RElTSw=='},'same')
  assert.equal(h.state.tabs.value.length,2);assert.equal(h.state.activeKey.value,rust.key)
  assert.equal(rust.document.base64,'TElWRQ==');assert.equal(rust.dirty,true);assert.equal(rust.ready,true)
  assert.equal(h.state.rustWordEntries.value[0],entry);assert.equal(h.rustPreparations.length,1)
  h.unmount()
})

test('a failed Rust saved-revision acknowledgement cannot mark the shell tab clean',async()=>{
  const h=shell(),tab=h.tab('editing',{wordEngine:'rust',dirty:true});h.active(tab)
  h.rustWordHandle.exportFile=async()=>({base64:'UlVTVA==',extension:'docx',dirty:true})
  h.rustWordHandle.markSaved=async()=>{throw Error('Saved revision is stale')}
  await assert.rejects(h.state.saveActive(),/Saved revision is stale/)
  assert.equal(h.calls.filter(c=>c[0]==='save').length,1,'The disk write succeeded but its revision could not be acknowledged')
  assert.equal(tab.dirty,true,'Unacknowledged in-memory content must still prompt before closing')
  assert.equal(tab.wordEngine,'rust');assert.equal(h.state.activeKey.value,tab.key)
  h.unmount()
})
