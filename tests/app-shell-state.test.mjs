import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'
import { zipSync, strToU8 } from 'fflate'
import { reviewOfficeImport } from '../src/office/import-review.ts'

// Run the real App.vue setup logic with Vue's real reactivity. Editors and native
// file dialogs are controlled doubles: these are shell-state regressions, not
// LibreOffice/PDF engine or native WebView compatibility tests.
const app = (await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const utilities = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const dialogFocus = await readFile(new URL('../src/shared/dialog-focus.ts', import.meta.url), 'utf8')
const names = 'tabs,activeKey,active,home,tabBar,helpDialog,closeDialog,officeDocument,pdfDocument,presentationDocument,officeEditor,pdfEditor,presentationEditor,wordWorkbench,sheetWorkbench,writerState,calcState,presentationState,slidePreview,busy,error,closeTarget,readyFor,dirtyFor,editorError,stash,activate,addDocument,browserFile,saveActive,closeTab,closeWindow,resolveClose,task,editorTransaction,nativeTransactionalEditor,readFreshWriterState,runWriterCommand,officeRequest'

function compile(source, require, extra = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require, console, URL, setTimeout, clearTimeout,
    crypto: { randomUUID }, btoa, atob, __BUILD_VERSION__: 'test', HTMLElement: class {}, document: { baseURI: 'http://127.0.0.1/' }, ...extra })
  return module.exports
}

function shell({nativeEnabled = true, smoke = false} = {}) {
  const calls = [], mounted = [], beforeUnmount = [], observers = [], reviews = [], native = {
    isTauri: () => nativeEnabled,
    onCloseRequested: async () => () => {},
    bootstrap: async () => ({smokeMode:false}),
    listRecentDocuments: async () => [],
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
    if (name === '@tauri-apps/api/core') return { invoke: async () => {} }
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
  const presentationHandle = Object.assign(Object.create(handle), {
    assertNoPendingEdits() {}, discardDrafts() {}, stopPresentation() { calls.push(['stop-presentation']) },
    getPresentationState: async () => ({ documentId: state.activeKey.value, revision: 1 }),
  })
  state.presentationEditor.value = presentationHandle
  function tab(id, { ready = true, dirty = false, fileId = id, kind = 'word' } = {}) {
    const extension = {word:'docx',sheet:'xlsx',presentation:'pptx',pdf:'pdf'}[kind]
    state.tabs.value.push({ key: id, ready, dirty, fileId, document: { id, kind, extension,
      name: `${id}.${extension}`, base64: 'T0xE', sha256: 'old-hash', sizeBytes: 3 } })
    return state.tabs.value.at(-1)
  }
  function active(tab) {
    state.activeKey.value = tab.key
    if (tab.document.kind === 'pdf') state.pdfDocument.value = tab.document
    else if (tab.document.kind === 'presentation') state.presentationDocument.value = tab.document
    else state.officeDocument.value = tab.document
  }
  async function idle() {
    for (let n = 0; n < 50 && state.busy.value; n++) { await Promise.resolve(); await vue.nextTick() }
    assert.equal(state.busy.value, '', 'The shell task should finish')
  }
  return { state, native, calls, reviews, handle, presentationHandle, tab, active, idle, browser, observers,
    async mount() { for (const callback of mounted) await callback() },
    unmount() { for (const callback of beforeUnmount) callback(); scope.stop() },
  }
}

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

function attachedWordDocument() {
  const w='http://schemas.openxmlformats.org/wordprocessingml/2006/main',r='http://schemas.openxmlformats.org/officeDocument/2006/relationships',pr='http://schemas.openxmlformats.org/package/2006/relationships'
  const entries={
    '_rels/.rels':`<Relationships xmlns="${pr}"><Relationship Id="main" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml':`<w:document xmlns:w="${w}" xmlns:r="${r}" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body><w:p><w:r><w:object><o:OLEObject Type="Embed" r:id="file"/></w:object></w:r></w:p></w:body></w:document>`,
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

test('draft review reads a real fresh Writer state without discarding pending inputs', async () => {
  const h=shell(),a=h.tab('A');h.active(a);await vue.nextTick()
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
    const h=shell(),a=h.tab('A'),b=h.tab('B');h.active(a);await vue.nextTick()
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
  const h=shell(),a=h.tab('A');h.active(a);await vue.nextTick()
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
  const h = shell(), a = h.tab('A', { ready: false }); h.active(a)
  let exported = 0; h.handle.exportFile = async () => { exported++; return { base64: 'wrong', extension: 'docx' } }
  await assert.rejects(h.state.saveActive(), /仍在打开/)
  h.state.editorError('A', 'Cannot load A')
  await assert.rejects(h.state.saveActive(), /未成功打开/)
  assert.equal(exported, 0); assert.equal(h.calls.length, 0)
  const b = h.tab('B'); await h.state.activate(b)
  assert.equal(h.state.activeKey.value, 'B', 'A failed tab must not trap the user')
})

test('switching snapshots authoritative dirty state even before a dirty event arrives', async () => {
  const h = shell(), a = h.tab('A'), b = h.tab('B'); h.active(a)
  h.handle.exportFile = async () => ({ base64: 'RURJVA==', extension: 'docx', dirty: true })
  await h.state.activate(b)
  assert.equal(a.document.base64, 'RURJVA=='); assert.equal(a.dirty, true)
  assert.equal(h.state.activeKey.value, 'B'); assert.equal(b.ready, false)
  assert.equal(h.calls[0][0], 'discard')
})

test('revision mismatch or pending PDF edits reject switching without replacing snapshots', async () => {
  for (const pending of [false, true]) {
    const h = shell(), a = h.tab('A'), b = h.tab('B'); h.active(a)
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

test('legacy imports save only as modern copies without an original-file overwrite token', async () => {
  for(const [extension,modern,kind] of [['doc','docx','word'],['rtf','docx','word'],['xls','xlsx','sheet']]) {
    const h=shell(),a=h.tab('original',{dirty:true,kind});h.active(a)
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
  const h=shell(),a=h.tab('legacy',{dirty:true});h.active(a)
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
  await h.state.addDocument({id:'source',kind:'word',extension:'doc',name:'Source.doc',base64:'OLD',sha256:'old-hash',sizeBytes:3},'source')
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

test('browser import checks document bytes before creating a tab', async () => {
  const h=shell({nativeEnabled:false})
  const open=async(name,contents)=>{
    const bytes=new TextEncoder().encode(contents)
    const input={value:name,files:[{name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}
    await h.state.browserFile({target:input});assert.equal(input.value,'')
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
  const b=h.tab('B');await h.state.activate(b);b.ready=true;await h.state.activate(a);a.ready=true
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

test('DOCX embedded attachment warning survives snapshots and cancelled saving until a new copy succeeds',async()=>{
  const h=shell(),bytes=attachedWordDocument()
  await h.state.addDocument({id:'word-source',kind:'word',extension:'docx',name:'Attachments.docx',base64:Buffer.from(bytes).toString('base64'),sha256:'source-hash',sizeBytes:bytes.length},'word-source')
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

test('closing the active Office tab releases its engine even when a PDF remains open', async () => {
  const h=shell(), a=h.tab('office'), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
  h.state.closeTab(a);await h.idle()
  assert.equal(h.state.activeKey.value,pdf.key)
  assert.equal(h.state.tabs.value.length,1)
  assert.equal(h.state.officeDocument.value,undefined,'The Office v-if must unmount its iframe')
  assert.equal(h.state.pdfDocument.value.id,pdf.key)
})

test('closing a hidden Office model releases only the closed tab and leaves the active PDF intact', async () => {
  const h=shell(), a=h.tab('office'), other=h.tab('other'), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
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
  const h=shell(), a=h.tab('office'), other=h.tab('other'), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
  await h.state.activate(pdf);h.state.readyFor(pdf.key)
  const document=h.state.officeDocument.value
  h.state.closeTab(other);await h.idle()
  assert.equal(h.state.officeDocument.value,document)
  assert.equal(a.ready,true)
})

test('Office to PDF and back reuses the same live editor after capturing unsaved content', async () => {
  const h=shell(), a=h.tab('office'), pdf=h.tab('pdf',{kind:'pdf'});h.active(a)
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
  const h=shell(), a=h.tab('office',{dirty:true});h.tab('pdf',{kind:'pdf'});h.active(a)
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
  const h=shell(),a=h.tab('office',{dirty:true});h.tab('pdf',{kind:'pdf'});h.active(a)
  let discarded=0;h.state.wordWorkbench.value={discardDrafts(){discarded++}}
  h.state.closeTarget.value=a;await h.state.resolveClose('discard')
  assert.equal(discarded,1);assert.equal(h.state.officeDocument.value,undefined)
  assert.equal(h.state.closeTarget.value,null)
  assert.ok(h.calls.some(call=>call[0]==='discard'&&call[1]?.force===true))
})

test('save-and-close of a background tab waits for its own editor to become ready', async () => {
  const h = shell(), a = h.tab('A'), b = h.tab('B', { dirty: true }); h.active(a)
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
  h.handle.writerAction=function(input){called=true;assert.equal(this,h.handle);assert.equal(h.state.busy.value,'');return input}
  h.handle.exportFile=async()=>{assert.equal(h.state.busy.value.length>0,true);return {base64:'snapshot',revision:7}}
  const nativeEditor=h.state.nativeTransactionalEditor(h.handle)
  const intent={type:'apply-style',expectedRevision:3}
  assert.equal(nativeEditor.writerAction(intent),intent)
  assert.equal(called,true,'Captured edit intents must forward synchronously without a new render/focus await')
  assert.equal((await nativeEditor.exportFile()).revision,7)
  assert.equal(h.state.busy.value,'')
  const a=h.tab('A'),b=h.tab('B');h.active(a)
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
    const h=shell(),a=h.tab('existing',{dirty:true});h.active(a)
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
  const h=shell(),deck=h.tab('deck',{kind:'presentation'}),office=h.tab('office'),pdf=h.tab('pdf',{kind:'pdf'})
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
    const h=shell(),deck=h.tab('deck',{kind:'presentation'}),other=h.tab('other',{kind});h.active(deck)
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
    const h = shell(), a = h.tab('A', { kind: 'presentation' }), b = h.tab('B'); h.active(a)
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
    const h=shell(), a=h.tab('A',{kind,dirty:true}), b=h.tab('B');h.active(a)
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
   const h=shell(),office=h.tab('office',{kind}),pdf=h.tab('pdf',{kind:'pdf'});h.active(pdf)
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
  const h = shell(), tab = h.tab('A', { dirty: true })
  h.state.tabs.value = [tab]; h.state.activeKey.value = 'A'
  h.state.dirtyFor('A', false)
  assert.equal(tab.dirty, true)
  tab.dirty = false
  h.state.dirtyFor('A', true)
  assert.equal(tab.dirty, true)
})
