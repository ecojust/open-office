import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

// Execute the actual OfficeEditor.vue setup with real Vue refs. RPCs and PPTX
// sessions are controlled doubles; this verifies async ownership/revision gates,
// not LibreOffice, package fidelity, browser rendering or native WebView behavior.
const component = await readFile(new URL('../src/components/OfficeEditor.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replaceAll('import.meta.env.DEV', 'false')
const utilities = await readFile(new URL('../src/shared/document.ts', import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const compiled = compile(`${script}\nexport const inspect = {frame, startBridge, queueLoad,
  set openingPromise(value){opening=value},
  get source(){return presentation}, get savedExport(){return savedExport}, get loaded(){return loaded},
  get bridge(){return bridge}, get presentationState(){return presentationState}}`)
const utilityModule = { exports: {} }
vm.runInNewContext(compile(utilities), { module: utilityModule, exports: utilityModule.exports, atob, btoa, Uint8Array })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function document(id = 'A') { return { id, kind: 'presentation', extension: 'pptx', name: `${id}.pptx`, base64: 'U09VUkNF' } }
function pageState(documentId = 'A', revision = 7, pageIndex = 0) {
  const pages = [0, 1].map(index => ({ id: `${documentId}-page-${index}`, index, name: `Slide ${index + 1}`, title: '', hidden: false, layout: 20 }))
  return { documentId, revision, dirty: true, pageCount: pages.length, currentPageIndex: pageIndex,
    pageSize: { width: 280, height: 157.5 }, pages,
    currentPage: { ...pages[pageIndex], background: { type: 'none' }, notes: '' }, objects: [], selectedObjectIds: [] }
}
function exportResult(revision = 7) { return { name: 'A.pptx', extension: 'pptx', base64: 'RVhQT1JU', dirty: true, revision } }
async function until(predicate) {
  for (let i = 0; i < 60; i++) { if (predicate()) return; await Promise.resolve() }
  assert.fail('Controlled RPC did not reach its expected await boundary')
}
async function editor(t, kind = 'presentation') {
  const workDocument = id => kind === 'presentation' ? document(id) : {...document(id),kind,extension:kind==='word'?'docx':'xlsx'}
  const props = { document: workDocument('A') }, events = [], clients = [], sessions = [], unmount = []
  const queued = new Map(), calls = []
  let exposed
  class BridgeDouble {
    constructor() { this.hostUrl = 'http://127.0.0.1/test/office/host.html'; clients.push(this) }
    request(action, data, id) {
      calls.push({ client: this, action, data, id })
      const queue = queued.get(action)
      if (queue?.length) return Promise.resolve(queue.shift())
      if (action === 'presentation-state') return Promise.resolve(pageState(id))
      if (/^(word|sheet)-(state|action|command)$/.test(action)) return Promise.resolve({documentId:id,revision:7,dirty:false})
      if (action === 'export') return Promise.resolve(exportResult())
      if (action === 'mark-saved') return Promise.resolve({ dirty: false })
      return Promise.resolve({ id: data?.id })
    }
    dispose() { this.disposed = true }
  }
  class SessionDouble {
    constructor() { this.revision = 0; this.dirty = false; this.merges = []; this.edits = []; this.saved = []; this.discards = 0; sessions.push(this) }
    async open(bytes, state) { this.opened = { bytes, state }; const queue=queued.get('session-open'); if(queue?.length)await queue.shift() }
    slide(id) { return { id } }
    hasLiveFeatures() { return false }
    requiresPptx() { return false }
    async merge(bytes, state) {
      this.merges.push({ bytes, state })
      return this.mergePending ? await this.mergePending : Uint8Array.from([77, 69, 82, 71, 69, 68])
    }
    async edit(bytes, state, pageId, patch) { this.edits.push({ bytes, state, pageId, patch }); if (this.editPending) await this.editPending; this.dirty = true; this.revision++ }
    markSaved(revision) { this.saved.push(revision); if (revision === this.revision) this.dirty = false }
    discard() { this.discards++; this.dirty = false }
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console, Error, Uint8Array, setTimeout, clearTimeout,
    defineProps: () => props, defineEmits: () => (...args) => events.push(args), defineExpose: value => { exposed = value },
    require(name) {
      if (name === 'vue') return { ...vue, onMounted() {}, onBeforeUnmount: callback => unmount.push(callback), watch() {} }
      if (name === '../office/bridge') return { OfficeBridge: BridgeDouble }
      if (name === '../presentation/session') return { PresentationSession: SessionDouble }
      if (name === '../shared/document') return utilityModule.exports
      throw Error(`Unexpected setup import: ${name}`)
    },
  })
  const state = module.exports.inspect
  state.frame.value = { src: '' }; state.startBridge()
  await exposed.loadDocument(props.document)
  t.after(() => { for (const callback of unmount) callback() })
  return {
    state, exposed, props, sessions, events, calls, clients,
    unmount(){for(const callback of unmount)callback()},
    enqueue(action, value) { if (!queued.has(action)) queued.set(action, []); queued.get(action).push(value) },
    count(action) { return calls.filter(call => call.action === action).length },
    async switchTo(id) { props.document = workDocument(id); await exposed.loadDocument(props.document, { discard: true }) },
  }
}

test('consistent presentation export merges only its captured session and records the exported revision', async t => {
  const h = await editor(t), source = h.state.source
  const result = await h.exposed.exportFile({ format: 'pptx' })
  assert.equal(result.base64, 'TUVSR0VE')
  assert.equal(source.merges.length, 1)
  assert.equal(source.merges[0].state.documentId, 'A')
  assert.equal(source.merges[0].state.revision, result.revision)
  assert.equal(h.state.savedExport.id, 'A')
  assert.equal(h.state.savedExport.revision, 7)
})

test('loaded model metadata does not pin the tab source bytes',async t=>{
  const h=await editor(t)
  assert.equal(h.state.loaded.id,'A');assert.equal(h.state.loaded.extension,'pptx')
  assert.equal('base64' in h.state.loaded,false)
  assert.equal(h.props.document.base64,'U09VUkNF','The tab still owns its recovery source')
})

test('unmount releases the bridge, export revision and presentation source even with a retained editor handle',async t=>{
  const h=await editor(t),source=h.state.source,client=h.state.bridge
  await h.exposed.exportFile()
  h.unmount()
  assert.equal(client.disposed,true);assert.equal(h.state.bridge,null)
  assert.equal(h.state.loaded,null);assert.equal(h.state.savedExport,null)
  assert.equal(h.state.presentationState,null);assert.notEqual(h.state.source,source)
  assert.equal(h.state.source.opened,undefined)
  assert.deepEqual(h.events.at(-1),['presentation-features',null])
})

test('an open queued before unmount never starts a replacement model',async t=>{
  const h=await editor(t),gate=deferred(),opens=h.count('open')
  h.state.openingPromise=gate.promise;h.state.queueLoad(document('B'))
  h.unmount();gate.resolve()
  for(let i=0;i<20;i++)await Promise.resolve()
  assert.equal(h.count('open'),opens);assert.equal(h.state.loaded,null)
})

test('unmount during asynchronous presentation parsing cannot restore state or emit ready',async t=>{
  const h=await editor(t),gate=deferred()
  h.enqueue('session-open',gate.promise)
  const opening=h.switchTo('B')
  await until(()=>h.state.source.opened?.state.documentId==='B')
  h.unmount();const events=h.events.length
  gate.resolve();await opening
  assert.equal(h.state.loaded,null);assert.equal(h.state.presentationState,null)
  assert.equal(h.events.length,events,'Parsing may finish, but the closed document must stay detached')
})

test('retry retains dirty presentation sources until discard is explicitly confirmed',async t=>{
  const h=await editor(t),source=h.state.source,client=h.state.bridge
  await h.exposed.presentationEdit({transition:{type:'fade'}})
  h.exposed.retry()
  assert.equal(h.state.source,source);assert.equal(h.state.bridge,client)
  assert.equal(client.disposed,undefined)
  const gate=deferred();h.enqueue('open',gate.promise)
  h.exposed.retry(true)
  assert.equal(client.disposed,true);assert.notEqual(h.state.source,source)
  assert.equal(h.state.loaded,null);assert.equal(h.state.presentationState,null)
  h.unmount();gate.resolve()
})

test('export rejects a different model revision before merging effects or recording a save', async t => {
  const h = await editor(t), source = h.state.source
  h.enqueue('export', exportResult(8))
  await assert.rejects(h.exposed.exportFile({ format: 'pptx' }), /导出期间幻灯片发生变化/)
  assert.equal(source.merges.length, 0)
  assert.equal(h.state.savedExport, null)
})

test('a document switch while the state RPC is pending rejects the stale state before export', async t => {
  const h = await editor(t), source = h.state.source, pending = deferred(), initialStates = h.count('presentation-state')
  h.enqueue('presentation-state', pending.promise)
  const failed = assert.rejects(h.exposed.exportFile(), /文档已切换/)
  await until(() => h.count('presentation-state') > initialStates)
  await h.switchTo('B')
  pending.resolve(pageState('A'))
  await failed
  assert.equal(h.count('export'), 0)
  assert.equal(source.merges.length, 0)
  assert.equal(h.state.source.merges.length, 0)
})

for (const returnToSameId of [false, true]) {
  test(`a pending export cannot merge into a replacement session${returnToSameId ? ' even after returning to the same document ID' : ''}`, async t => {
    const h = await editor(t), source = h.state.source, pending = deferred()
    h.enqueue('export', pending.promise)
    const failed = assert.rejects(h.exposed.exportFile(), /导出期间文档已切换/)
    await until(() => h.count('export') === 1)
    await h.switchTo('B')
    if (returnToSameId) await h.switchTo('A')
    assert.notEqual(h.state.source, source)
    pending.resolve(exportResult())
    await failed
    assert.equal(source.merges.length, 0)
    assert.ok(h.sessions.every(session => session.merges.length === 0))
    assert.equal(h.state.savedExport, null)
    assert.equal(h.state.loaded.id, returnToSameId ? 'A' : 'B')
  })
}

test('switching documents during asynchronous package merge discards its eventual result', async t => {
  const h = await editor(t), source = h.state.source, pending = deferred()
  source.mergePending = pending.promise
  const failed = assert.rejects(h.exposed.exportFile(), /导出期间文档已切换/)
  await until(() => source.merges.length === 1)
  await h.switchTo('B')
  pending.resolve(Uint8Array.from([1, 2, 3]))
  await failed
  assert.equal(h.state.source.merges.length, 0)
  assert.equal(h.state.savedExport, null)
})

test('an effects edit applies only when the document, target page and exported revision still agree', async t => {
  const h = await editor(t), source = h.state.source, patch = { transition: { type: 'fade' } }
  await h.exposed.presentationEdit(patch)
  assert.equal(source.edits.length, 1)
  assert.equal(source.edits[0].pageId, 'A-page-0')
  assert.equal(source.edits[0].state.revision, 7)
  assert.equal(source.edits[0].patch, patch)
  assert.equal(h.state.savedExport, null)
  assert.ok(h.events.some(event => event[0] === 'dirty' && event[1] === true))
})

for (const change of ['page', 'revision']) {
  test(`an effects edit rejects a changed ${change} before patching the PPTX package`, async t => {
    const h = await editor(t), source = h.state.source
    h.enqueue('presentation-state', pageState('A', 7, 0)) // initial edit target
    h.enqueue('presentation-state', pageState('A', 7, 0)) // export snapshot
    h.enqueue('presentation-state', pageState('A', change === 'revision' ? 8 : 7, change === 'page' ? 1 : 0))
    await assert.rejects(h.exposed.presentationEdit({ transition: { type: 'fade' } }), /更新效果期间幻灯片发生变化/)
    assert.equal(source.merges.length, 1, 'Export may merge the matching snapshot before the target changes')
    assert.equal(source.edits.length, 0, 'The patch must never be applied to the new page or revision')
    assert.equal(source.dirty, false)
    assert.ok(!h.events.some(event => event[0] === 'dirty' && event[1] === true))
  })
}

for (const [kind, getter, mutate] of [['word','getWriterState','writerAction'],['sheet','getCalcState','calcAction']]) {
  test(`${kind} ignores a pending metadata response after switching away and back to the same document`, async t => {
    const h = await editor(t,kind), pending = deferred(), before = h.count(`${kind}-state`)
    h.enqueue(`${kind}-state`,pending.promise)
    const failed = assert.rejects(h.exposed[getter](),/文档已切换/)
    await until(()=>h.count(`${kind}-state`)>before)
    await h.switchTo('B'); await h.switchTo('A')
    const events = h.events.length
    pending.resolve({documentId:'A',revision:7,dirty:false})
    await failed
    assert.equal(h.events.length,events,'Old results must not populate the replacement model workspace')
  })
  test(`${kind} refuses an invalid document identity in workbench metadata`, async t => {
    const h = await editor(t,kind)
    for(const bad of [{documentId:'B',revision:7,dirty:false},{documentId:'A',revision:-1,dirty:false},{documentId:'A',revision:7}]) {
      h.enqueue(`${kind}-state`,bad)
      await assert.rejects(h.exposed[getter](),/文档版本无效/)
    }
  })
  test(`${kind} drops the result of an edit once another document is opened`, async t => {
    const h = await editor(t,kind), pending = deferred()
    h.enqueue(`${kind}-action`,pending.promise)
    const failed = assert.rejects(h.exposed[mutate]({type:'edit'}),/文档已切换/)
    await until(()=>h.count(`${kind}-action`)===1)
    await h.switchTo('B')
    const events = h.events.length
    pending.resolve({documentId:'A',revision:8,dirty:true})
    await failed
    assert.equal(h.events.length,events)
  })
}

test('an old save acknowledgement cannot clean a reloaded model with the same ID', async t => {
  const h = await editor(t), oldSource = h.state.source, pending = deferred()
  await h.exposed.exportFile()
  h.enqueue('mark-saved', pending.promise)
  const saving = h.exposed.markSaved()
  await until(() => h.count('mark-saved') === 1)
  await h.switchTo('B'); await h.switchTo('A')
  const replacement = h.state.source, eventCount = h.events.length
  replacement.dirty = true
  pending.resolve({ dirty: false })
  await saving
  assert.equal(replacement.dirty, true)
  assert.equal(oldSource.saved.length, 0)
  assert.equal(replacement.saved.length, 0)
  assert.equal(h.events.length, eventCount)
})

test('save acknowledgement uses its captured export, not a newer unsaved effects export', async t => {
  const h = await editor(t), source = h.state.source, pending = deferred()
  await h.exposed.exportFile()
  h.enqueue('mark-saved', pending.promise)
  const saving = h.exposed.markSaved()
  await until(() => h.count('mark-saved') === 1)
  source.revision = 1; source.dirty = true
  await h.exposed.exportFile()
  assert.equal(h.state.savedExport.featureRevision, 1)
  pending.resolve({ dirty: false })
  await saving
  assert.deepEqual(source.saved, [0])
  assert.equal(source.dirty, true)
  assert.deepEqual(h.events.at(-1), ['dirty', true])
})

test('an old discard acknowledgement cannot clean a replacement model after A to B to A', async t => {
  const h = await editor(t), oldSource = h.state.source, pending = deferred()
  await h.exposed.exportFile()
  h.enqueue('discard', pending.promise)
  const failed = assert.rejects(h.exposed.discardChanges(), /文档已切换/)
  await until(() => h.count('discard') === 1)
  await h.switchTo('B'); await h.switchTo('A')
  const replacement = h.state.source, eventCount = h.events.length
  replacement.dirty = true
  pending.resolve({ dirty: false })
  await failed
  assert.equal(replacement.dirty, true)
  assert.equal(oldSource.discards, 0)
  assert.equal(replacement.discards, 0)
  assert.equal(h.events.length, eventCount)
})

test('effects changed during discard remain dirty instead of being silently acknowledged', async t => {
  const h = await editor(t), source = h.state.source, pending = deferred()
  await h.exposed.exportFile()
  h.enqueue('discard', pending.promise)
  const failed = assert.rejects(h.exposed.discardChanges(), /已保留新修改/)
  await until(() => h.count('discard') === 1)
  source.revision++; source.dirty = true
  pending.resolve({ dirty: false })
  await failed
  assert.equal(source.dirty, true)
  assert.equal(source.discards, 0)
})

test('commands awaiting an open retain the initiating document identity', async t => {
  const h = await editor(t, 'word'), pending = deferred()
  h.state.openingPromise = pending.promise
  const failed = assert.rejects(h.exposed.undo(), /文档已切换/)
  await h.switchTo('B')
  pending.resolve()
  await failed
  assert.equal(h.count('undo'), 0, 'Undo from A must never be sent to B after the opening wait')
})

for (const rejected of [false, true]) test(`stale command ${rejected ? 'errors' : 'responses'} never reach a replacement document`, async t => {
  const h = await editor(t, 'sheet'), pending = deferred()
  h.enqueue('undo', pending.promise)
  const failed = assert.rejects(h.exposed.undo(), rejected ? /old failure/ : /文档已切换/)
  await until(() => h.count('undo') === 1)
  await h.switchTo('B'); await h.switchTo('A')
  const eventCount = h.events.length
  if (rejected) pending.reject(Error('old failure'))
  else pending.resolve({ dirty: false })
  await failed
  assert.equal(h.events.length, eventCount)
})

test('presentation state rejects an old result after switching away and back to A', async t => {
  const h = await editor(t), pending = deferred(), before = h.count('presentation-state')
  h.enqueue('presentation-state', pending.promise)
  const failed = assert.rejects(h.exposed.getPresentationState(), /文档已切换/)
  await until(() => h.count('presentation-state') > before)
  await h.switchTo('B'); await h.switchTo('A')
  const eventCount = h.events.length
  pending.resolve(pageState('A', 1))
  await failed
  assert.equal(h.events.length, eventCount)
})

test('presentation mutations drop their late result without publishing stale state', async t => {
  const h = await editor(t), pending = deferred()
  h.enqueue('presentation-action', pending.promise)
  const failed = assert.rejects(h.exposed.presentationAction({ type: 'set-notes', text: 'old' }), /文档已切换/)
  await until(() => h.count('presentation-action') === 1)
  await h.switchTo('B'); await h.switchTo('A')
  const eventCount = h.events.length
  pending.resolve(pageState('A', 8))
  await failed
  assert.equal(h.events.length, eventCount)
})

test('an asynchronous PPTX effects patch never publishes into a reloaded document', async t => {
  const h = await editor(t), source = h.state.source, pending = deferred()
  source.editPending = pending.promise
  const failed = assert.rejects(h.exposed.presentationEdit({ transition: { type: 'fade' } }), /文档已切换/)
  await until(() => source.edits.length === 1)
  await h.switchTo('B'); await h.switchTo('A')
  const eventCount = h.events.length
  pending.resolve()
  await failed
  assert.equal(h.state.source.dirty, false)
  assert.equal(h.state.source.edits.length, 0)
  assert.equal(h.events.length, eventCount)
})

test('matching save and discard acknowledgements still complete in the same model', async t => {
  const h = await editor(t), source = h.state.source
  source.dirty = true
  await h.exposed.exportFile(); await h.exposed.markSaved()
  assert.deepEqual(source.saved, [0]); assert.equal(source.dirty, false)
  source.dirty = true
  await h.exposed.exportFile(); await h.exposed.discardChanges()
  assert.equal(source.discards, 1); assert.equal(source.dirty, false)
  assert.deepEqual(h.events.at(-1), ['dirty', false])
})

for (const [kind, method] of [['word','writerData'], ['sheet','calcData']]) {
  test(`${kind} reads retain flat payload and validate the data snapshot identity and revision`, async t => {
    const h = await editor(t,kind)
    const snapshot = { documentId:'A', revision:9, cells:[['latest value']] }
    h.enqueue(`${kind}-data`,snapshot)
    assert.deepEqual(await h.exposed[method]({type:'read'}),snapshot)
    for (const invalid of [null, {cells:[]}, {documentId:'B',revision:9}, {documentId:'A',revision:-1}, {documentId:'A',revision:9.5}]) {
      h.enqueue(`${kind}-data`,invalid)
      await assert.rejects(h.exposed[method]({type:'read'}),/文档版本无效/)
    }
  })
  test(`${kind} data read is discarded after an A to B to A model replacement`, async t => {
    const h = await editor(t,kind), pending = deferred()
    h.enqueue(`${kind}-data`,pending.promise)
    const failed = assert.rejects(h.exposed[method]({type:'read'}),/文档已切换/)
    await until(() => h.count(`${kind}-data`) === 1)
    await h.switchTo('B'); await h.switchTo('A')
    pending.resolve({documentId:'A',revision:9,cells:[['old']]})
    await failed
  })
}

test('import-only sources explicitly request a modern format on their first save', async t => {
  for(const [extension,kind,format] of [['doc','word','docx'],['rtf','word','docx'],['xls','sheet','xlsx'],['ppt','presentation','pptx']]) {
    const h=await editor(t,kind)
    h.state.loaded.extension=extension;h.props.document.extension=extension
    h.enqueue('export',{...exportResult(),extension:format,name:'Converted.'+format})
    const result=await h.exposed.exportFile()
    assert.equal(h.calls.findLast(call=>call.action==='export').data.format,format)
    assert.equal(result.extension,format)
    assert.equal(h.state.loaded.extension,extension,'Exporting does not relabel or overwrite the import source')
  }
})

test('Writer command uses one RPC and rejects a response after the document changes', async t => {
  const h=await editor(t,'word'), pending=deferred(), command={action:{type:'format-text',bold:true},target:{documentId:'A',revision:7}}
  h.enqueue('word-command',pending.promise)
  const failed=assert.rejects(h.exposed.writerCommand(command),/文档已切换/)
  await until(()=>h.count('word-command')===1)
  await h.switchTo('B')
  const events=h.events.length
  pending.resolve({documentId:'A',revision:8,dirty:true})
  await failed
  assert.equal(h.count('word-command'),1);assert.equal(h.events.length,events)
})
