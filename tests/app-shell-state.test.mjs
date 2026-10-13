import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as vue from 'vue'

// Run the real App.vue setup logic with Vue's real reactivity. Editors and native
// file dialogs are controlled doubles: these are shell-state regressions, not
// LibreOffice/PDF engine or native WebView compatibility tests.
const app = (await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const utilities = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const names = 'tabs,activeKey,active,officeDocument,pdfDocument,officeEditor,pdfEditor,wordWorkbench,sheetWorkbench,writerState,calcState,presentationWorkbench,presentationEffects,presentationState,slidePreview,busy,error,closeTarget,readyFor,dirtyFor,editorError,stash,activate,addDocument,saveActive,closeTab,closeWindow,resolveClose,task,editorTransaction,nativeTransactionalEditor,readFreshWriterState,runWriterCommand,officeRequest'

function compile(source, require, extra = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require, console, URL, setTimeout, clearTimeout,
    crypto: { randomUUID }, __BUILD_VERSION__: 'test', HTMLElement: class {}, document: { baseURI: 'http://127.0.0.1/' }, ...extra })
  return module.exports
}

function shell({nativeEnabled = true, smoke = false} = {}) {
  const calls = [], mounted = [], native = {
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
  const helpers = compile(utilities, () => { throw Error('Unexpected helper import') })
  const state = compile(`${app}\nexport const state={${names}}`, name => {
    if (name === 'vue') return { ...vue, onMounted(callback) {mounted.push(callback)}, onBeforeUnmount() {} }
    if (name === './native') return native
    if (name === './smoke') return {smokeRequested:()=>smoke,smokeStage(){},smokeFeatures:()=>({}),smokeFailure:async(error,phase)=>{calls.push(['smoke-failure',phase,String(error)])},smokeAwait:async(_phase,action)=>action()}
    if (name === './shared/document') return helpers
    if (name === '@tauri-apps/api/core') return { invoke: async () => {} }
    if (name.endsWith('.vue')) return {}
    throw Error(`Unexpected setup import ${name}`)
  }, {window:{addEventListener(){},removeEventListener(){}}}).state
  const handle = {
    exportFile: async () => ({ base64: 'TkVX', extension: 'docx', dirty: false }),
    discardChanges: async options => { calls.push(['discard', options]) },
    markSaved: async () => { calls.push(['marked']) },
  }
  state.officeEditor.value = handle
  state.pdfEditor.value = handle
  function tab(id, { ready = true, dirty = false, fileId = id, kind = 'word' } = {}) {
    const extension = {word:'docx',sheet:'xlsx',presentation:'pptx',pdf:'pdf'}[kind]
    state.tabs.value.push({ key: id, ready, dirty, fileId, document: { id, kind, extension,
      name: `${id}.${extension}`, base64: 'T0xE', sha256: 'old-hash', sizeBytes: 3 } })
    return state.tabs.value.at(-1)
  }
  function active(tab) {
    state.activeKey.value = tab.key
    if (tab.document.kind === 'pdf') state.pdfDocument.value = tab.document
    else state.officeDocument.value = tab.document
  }
  async function idle() {
    for (let n = 0; n < 50 && state.busy.value; n++) { await Promise.resolve(); await vue.nextTick() }
    assert.equal(state.busy.value, '', 'The shell task should finish')
  }
  return { state, native, calls, handle, tab, active, idle, async mount(){for(const callback of mounted)await callback()} }
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

test('presentation PDF and ODP exports stay copies and never replace the editable PPTX tab', async () => {
  for(const format of ['pdf','odp']){
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
  assert.equal(h.state.officeDocument.value.id,'deck')
  assert.equal(h.state.officeDocument.value.base64,'UFBUWA==')
  assert.equal(h.state.officeDocument.value.kind,'presentation')
})

test('native window close exits presentation preview before showing unsaved confirmation', async()=>{
  const h=shell(), a=h.tab('deck',{kind:'presentation',dirty:true});h.active(a)
  h.handle.exportFile=async()=>({base64:'UFBUWA==',extension:'pptx',dirty:true})
  h.state.slidePreview.value={base64:'JVBERg==',name:'deck.pptx',startPage:0}
  await h.state.closeWindow()
  assert.equal(h.state.slidePreview.value,undefined)
  assert.equal(h.state.closeTarget.value,'window')
  assert.equal(a.dirty,true)
  assert.ok(!h.calls.some(call=>call[0]==='close'))
})


test('pending presentation text or transition drafts prevent saving and tab switching', async () => {
  for (const panel of ['workbench', 'effects']) {
    const h = shell(), a = h.tab('A', { kind: 'presentation' }), b = h.tab('B'); h.active(a)
    let exports = 0
    h.handle.exportFile = async () => { exports++; return {base64:'NEW',extension:'pptx'} }
    if (panel === 'workbench') h.state.presentationWorkbench.value = {assertNoPendingEdits(){throw Error('Unapplied notes')},discardDrafts(){}}
    else h.state.presentationEffects.value = {hasPendingEdits(){return true},discardDrafts(){}}
    await assert.rejects(h.state.saveActive(), /Unapplied|尚未应用/)
    await assert.rejects(h.state.activate(b), /Unapplied|尚未应用/)
    assert.equal(h.state.activeKey.value, 'A')
    assert.equal(a.document.base64, 'T0xE')
    assert.equal(exports, 0)
  }
})

test('confirmed discard clears presentation drafts before replacing the loaded tab', async () => {
  const h = shell(), a = h.tab('A', { kind: 'presentation', dirty: true }); h.active(a)
  let dropped = 0
  h.state.presentationWorkbench.value = {assertNoPendingEdits(){throw Error('Unapplied notes')},discardDrafts(){dropped++}}
  h.state.presentationEffects.value = {hasPendingEdits(){return true},discardDrafts(){dropped++}}
  h.state.closeTarget.value = a
  await h.state.resolveClose('discard')
  assert.equal(dropped, 2)
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
  h.state.presentationEffects.value = {hasPendingEdits(){return true}}
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
 test(`${kind} toolbar refreshes when returning from PDF to a retained Office model`,async()=>{
   const h=shell(),office=h.tab('office',{kind}),pdf=h.tab('pdf',{kind:'pdf'});h.active(pdf)
   h.state.officeDocument.value=office.document
   const reopened=[]
   h.handle[getter]=async()=>{reopened.push(office.key);return {documentId:office.key,revision:3,dirty:false}}
   await h.state.activate(office)
   assert.deepEqual(reopened,['office'])
   assert.equal(h.state[field].value.documentId,'office')
   assert.equal(h.state.officeDocument.value.id,'office')
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
