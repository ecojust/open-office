import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Exercise the actual worker source and protocol with a deterministic UNO mock.
// These tests do not prove native UNO or document round-trip compatibility;
// those require the separate browser/native engine integration tests.
const source = await readFile(new URL('../public/office/office-worker.js', import.meta.url), 'utf8')
const offlinePolicy = await readFile(new URL('../public/office/offline-policy.js', import.meta.url), 'utf8')
async function engine(initial = { kind: 'word', extension: 'docx' }) {
  const messages = [], models = [], imports = [], stores = [], dispatches = []
  const controls = { failNextLoad: false, rejectNextService: false, ignoreMove: false, refusePageSwitch: false, configureNextModel: null, modifyDuringDataRead: false, acceptTableSnapshot: false, acceptCommand: false }
  const nativeExceptions = new Map(), exceptionCalls = []
  const nativeException = message => {
    // A token, not an Error: real UNO exceptions cross the boundary as tagged
    // WebAssembly exceptions and require catchUnoException to release them.
    const token = Object.freeze({ mockNativeUnoException: message })
    nativeExceptions.set(token, { message, consumed: 0 })
    return token
  }
  class Value { constructor(value) { Object.assign(this, value) } }
  const frame = { registerDispatchProviderInterceptor(value) { this.interceptor = value }, releaseDispatchProviderInterceptor() {}, activate() {}, getContainerWindow: () => ({ setFocus() {} }) }
  const desktop = { loadComponentFromURL(url, target, flags, args) {
    imports.push({ url, target, args })
    // LibreOffice may reuse a clean untitled frame for _default and dispose its
    // model while loading. A transactional tab switch must keep it alive instead.
    if (target === '_default' && models.length) models.at(-1).closed = true
    if (controls.failNextLoad) { controls.failNextLoad = false; throw Error('Document import failed') }
    const serviceAccepted = !controls.rejectNextService; controls.rejectNextService = false
    const pages = [], shapes = [], mutations = []
    let nextPage = 0
    const changed = (type, target) => { mutations.push({ type, target }); model.edit() }
    const makeShape = service => {
      let text = ''
      const shape = { service, getShapeType: () => service, supportsService: name => name === service,
        getPropertyValue(name) { return this[name] },
        setPropertyValue(name, value) { this[name] = value },
        setSize(value) { this.size = value }, setPosition(value) { this.position = value },
        setName(value) { this.name = value }, getName() { return this.name || '' },
        getText: () => ({ getString: () => text, setString(value) { text = value; changed('text', shape) } }),
      }
      return shape
    }
    const makePage = (notes = false) => {
      const pageShapes = [], notesPage = notes ? null : makePage(true)
      const page = { name: notes ? 'Notes' : `Slide ${++nextPage}`, Layout: notes ? 21 : 1,
        Width: notes ? 21000 : 28000, Height: notes ? 29700 : 15750, Visible: true, Background: null,
        pageShapes, getCount: () => pageShapes.length, getByIndex: index => pageShapes[index],
        add(shape) { pageShapes.push(shape); shapes.push(shape); changed('add-shape', page) },
        getMasterPage() { return this.master || 'master' }, setMasterPage(value) { this.master = value; changed('master', page) },
        getName() { return this.name }, setName(value) { this.name = value; changed('rename', page) },
        getNotesPage: () => notesPage,
        getPropertyValue(name) { return name === 'Number' ? pages.indexOf(this) + 1 : this[name] },
        setPropertyValue(name, value) {
          if (name === 'Number') throw Error('Readonly Number')
          if (!notes && ['Width', 'Height'].includes(name)) for (const other of pages) other[name] = value
          else this[name] = value
          changed(name, page)
        },
      }
      return page
    }
    pages.push(makePage())
    let activePage = pages[0]
    const presentation = { running: false, start() { this.running = true }, end() { this.running = false }, isRunning() { return this.running } }
    const controller = { getFrame: () => frame, getCurrentPage: () => activePage,
      setCurrentPage(value) {
        if (controls.refusePageSwitch || value === activePage) return
        activePage = value; this.selectedPages = [value]
        this.pageListener?.propertyChange({ PropertyName: 'CurrentPage', NewValue: value })
      },
      selectedPages: [activePage], getActiveSheet: () => ({ getDrawPage: () => pages[0] }),
      getSelection: () => ({ getPosition: () => ({ X: 2000, Y: 3000 }) }),
      addSelectionChangeListener(value) { this.selectionListener = value }, removeSelectionChangeListener() {},
      addPropertyChangeListener(_name, value) { this.pageListener = value }, removePropertyChangeListener() {},
    }
    const model = { modified: false, closed: false, listener: null, services: [], shapes, pages, mutations,
      supportsService(name) { this.services.push(name); return serviceAccepted }, getText: () => ({ createTextCursor: () => ({ setPropertyValue() {} }) }),
      setModified(value) { if (this.closed) throw Error('Model already disposed'); this.modified = value }, isModified() { return this.modified },
      addModifyListener(listener) { this.listener = listener }, removeModifyListener() {}, close() { this.closed = true },
      getCurrentController: () => controller,
      getDrawPages: () => ({ getCount: () => pages.length, getByIndex: index => pages[index],
        // This fixed engine inserts after the given index, clamped to the end.
        insertNewByIndex(index) { const page = makePage(); pages.splice(Math.min(index + 1, pages.length), 0, page); changed('insert-page', page); return page },
        remove(page) { if (pages.length > 1) { pages.splice(pages.indexOf(page), 1); changed('remove-page', page) } },
      }),
      duplicate(page) {
        const copy = makePage(); copy.Layout = page.Layout; copy.Visible = page.Visible; copy.Background = page.Background
        const copyShapes = (source, target) => {
          for (const item of source.pageShapes) { const duplicate = makeShape(item.service); target.add(duplicate); duplicate.getText().setString(item.getText().getString()) }
        }
        copyShapes(page, copy); copyShapes(page.getNotesPage(), copy.getNotesPage())
        pages.splice(pages.indexOf(page) + 1, 0, copy); changed('duplicate-page', copy); return copy
      },
      getPresentation: () => presentation,
      createInstance: makeShape,
      storeToURL(path, args) { stores.push({ path, args }); this.modified = false },
      edit(notify = true) { this.modified = true; if (notify) this.listener?.modified() },
    }
    models.push(model)
    const configure = controls.configureNextModel; controls.configureNextModel = null
    configure?.(model)
    return model
  } }
  const css = { frame: { Desktop: { create: () => desktop }, DispatchHelper: { create: () => ({ executeDispatch(_frame, command) {
      dispatches.push(command)
      if (!['.uno:MovePageUp', '.uno:MovePageDown'].includes(command) || controls.ignoreMove) return
      const model = models.findLast(item => !item.closed), controller = model.getCurrentController()
      assert.equal(controller.selectedPages.length, 1, 'Worker must clear stale sorter multiselection before moving')
      const page = controller.selectedPages[0], index = model.pages.indexOf(page)
      model.pages.splice(index, 1); model.pages.splice(index + (command.endsWith('Up') ? -1 : 1), 0, page)
      model.edit()
    } }) },
      XDispatchProviderInterceptor: 'interceptor', XInterceptorInfo: 'info', XDispatch: 'dispatch', FeatureStateEvent: Value },
    beans: { PropertyValue: Value, XPropertyChangeListener: 'property-listener' }, view: { XSelectionChangeListener: 'selection-listener' },
    drawing: { FillStyle: { NONE: 0, SOLID: 1 } }, task: { XInteractionHandler: 'handler', XInteractionAbort: 'abort' },
    document: { MacroExecMode: { NEVER_EXECUTE: 0 }, UpdateDocMode: { NO_UPDATE: 0 } }, util: { XModifyListener: 'listener', XModifiable: 'modifiable' },
    graphic: { GraphicProvider: { create: () => ({ queryGraphic: () => ({ getPropertyValue: () => ({ Width: 1000, Height: 3000 }) }) }) } },
    awt: { Size: Value, Point: Value } }
  const port = { postMessage: message => messages.push(message) }
  const zeta = { uno: { com: { sun: { star: css } } }, getUnoComponentContext: () => ({}),
    unoObject: (_interfaces, object) => object, sameUnoObject: (left, right) => left === right,
    type: { short: 'short', interface: value => value, sequence: value => ({ kind: 'sequence', element: value }), struct: value => ({ kind: 'struct', definition: value }) },
    Any: class { constructor(type, value) { this.type = type; this.value = value } }, mainPort: port,
    catchUnoException(error) {
      exceptionCalls.push(error)
      const native = nativeExceptions.get(error)
      if (!native) throw error
      native.consumed++
      return { Message: native.message }
    },
  }
  const toolCalls = []
  const toolFactory = kind => ({ getModel }) => ({
    state() { toolCalls.push([kind, 'state']); return { marker: kind, documentId: 'untrusted', revision: -1, dirty: false } },
    action(data) { toolCalls.push([kind, 'action', data]); if (data.type !== 'edit') throw Error('Unknown tool action'); getModel().edit() },
    data(query) { toolCalls.push([kind, 'data', query]); if (controls.modifyDuringDataRead) { controls.modifyDuringDataRead = false; getModel().edit() } return { marker: kind, value: 42, documentId: 'untrusted', revision: -1 } },
    command(data) { toolCalls.push([kind, 'command', data]); if (!controls.acceptCommand) throw Error('Current command target changed'); getModel().edit() },
    applyTableSnapshot(data) {
      toolCalls.push([kind, 'table-snapshot', data]);
      // The real Writer helper validates native identity, cells and style
      // fingerprints. Here rejection is controlled to test the worker route.
      if (!controls.acceptTableSnapshot) throw Error('Table snapshot validation failed');
      getModel().edit();
    },
  })
  vm.runInNewContext(offlinePolicy + '\n' + source, { Module: { zetajs: Promise.resolve(zeta) }, console, WebAssembly,
    createWriterTools: toolFactory('word'), createCalcTools: toolFactory('sheet') })
  await Promise.resolve()
  let seq = 0
  const request = (action, data = {}, documentId = 'A') => {
    const requestId = `request-${++seq}`
    port.onmessage({ data: { action, data, documentId, requestId } })
    const reply = messages.find(message => message.requestId === requestId)
    assert.ok(reply, 'Every accepted request should respond')
    return reply
  }
  assert.equal(request('open', { id: 'A', name: `A.${initial.extension}`, ...initial, isNew: true }).ok, true)
  return { request, imports, stores, model: models[0], models, controls, messages, frame, dispatches,
    nativeException, nativeExceptions, exceptionCalls, toolCalls }
}

for (const [kind, extension] of [['word', 'docx'], ['sheet', 'xlsx']]) {
  test(`${kind} workbench routes only matching current-document requests and owns revision metadata`, async () => {
    const {request, model, toolCalls, messages} = await engine({kind, extension})
    const initial = request(`${kind}-state`)
    assert.equal(initial.ok, true)
    assert.equal(initial.data.documentId, 'A')
    assert.equal(initial.data.revision, 0)
    assert.equal(initial.data.dirty, false)
    assert.equal(initial.data.marker, kind)
    const before = toolCalls.length
    assert.equal(request(`${kind}-state`, {}, 'stale-document').ok, false)
    assert.equal(request(`${kind === 'word' ? 'sheet' : 'word'}-state`).ok, false)
    for (const action of [null, [], {type:'edit',expectedRevision:-1}, {type:'edit',expectedRevision:'0'}, {type:'edit',expectedRevision:1}]) {
      assert.equal(request(`${kind}-action`, action).ok, false)
    }
    assert.equal(toolCalls.length, before, 'Rejected requests must not reach a mutating helper')
    assert.equal(model.isModified(), false)
    const edited = request(`${kind}-action`, {type:'edit',expectedRevision:0})
    assert.equal(edited.ok, true)
    assert.equal(edited.data.revision, 1)
    assert.equal(edited.data.dirty, true)
    const data = request(`${kind}-data`, {type:'read'}).data
    assert.equal(data.value, 42)
    assert.equal(data.documentId, 'A')
    assert.equal(data.revision, 1)
    assert.equal(request(`${kind}-action`, {type:'unknown'}).ok, false)
    model.getCurrentController().selectionListener.selectionChanged()
    assert.ok(messages.some(message=>message.event==='workbench-changed' && message.documentId==='A'))
  })
  test(`${kind} data carries its own completed read revision without requiring a toolbar refresh`, async () => {
    const {request, controls} = await engine({kind, extension})
    assert.equal(request(`${kind}-state`).data.revision, 0)
    controls.modifyDuringDataRead = true
    const data = request(`${kind}-data`, {type:'read'}).data
    assert.equal(data.value, 42)
    assert.equal(data.documentId, 'A')
    assert.equal(data.revision, 1)
  })
}

test('only stale Writer table edits can reach the dedicated snapshot validator', async () => {
  const {request, model, controls, toolCalls} = await engine()
  model.edit()
  controls.acceptTableSnapshot = true
  const action = {type:'update-table',expectedRevision:0,expectedTableId:'read-token',expectedCells:[['old']],expectedCellSignatures:[['native-token']],cells:[['new']]}
  const updated = request('word-action',action)
  assert.equal(updated.ok,true)
  assert.equal(updated.data.revision,2)
  assert.equal(toolCalls.filter(call=>call[1]==='table-snapshot').length,1)
  assert.equal(toolCalls.filter(call=>call[1]==='action').length,0,'A stale table edit cannot fall through to the ordinary action path')
  const count=toolCalls.length
  for(const invalid of [{...action,type:'edit'}, {...action,expectedRevision:3}, {...action,expectedRevision:-1}, {...action,expectedRevision:0.5}]) {
    assert.equal(request('word-action',invalid).ok,false)
  }
  assert.equal(toolCalls.length,count)
  const sheet=await engine({kind:'sheet',extension:'xlsx'})
  sheet.model.edit();sheet.controls.acceptTableSnapshot=true
  assert.equal(sheet.request('sheet-action',action).ok,false)
  assert.equal(sheet.toolCalls.length,0,'Calc never uses the Writer table exception')
})

test('a rejected table snapshot never falls back to applying unvalidated cells', async () => {
  const {request, model, toolCalls}=await engine()
  model.edit()
  const result=request('word-action',{type:'update-table',expectedRevision:0,expectedCells:[['forged']]})
  assert.equal(result.ok,false)
  assert.match(result.error,/snapshot validation failed/)
  assert.equal(request('word-state').data.revision,1)
  assert.equal(toolCalls.filter(call=>call[1]==='action').length,0)
  assert.equal(toolCalls.filter(call=>call[1]==='table-snapshot').length,1)
})

test('office imports disable macros and external updates independently of profile', async () => {
  const { imports } = await engine()
  const args = Object.fromEntries(imports[0].args.map(item => [item.Name, item.Value]))
  assert.equal(args.MacroExecutionMode.type, 'short')
  assert.equal(args.MacroExecutionMode.value, 0)
  assert.equal(args.UpdateDocMode.value, 0)
  assert.ok(args.InteractionHandler.handle)
})

test('presentation chooses Impress factory, service, safe import and format-specific export filters', async () => {
  const { request, imports, stores, model } = await engine({ kind: 'presentation', extension: 'pptx' })
  assert.equal(imports[0].url, 'private:factory/simpress')
  assert.deepEqual(model.services, ['com.sun.star.presentation.PresentationDocument'])
  const args = Object.fromEntries(imports[0].args.map(item => [item.Name, item.Value]))
  assert.equal(args.MacroExecutionMode.value, 0)
  assert.equal(args.UpdateDocMode.value, 0)
  assert.ok(args.InteractionHandler)
  model.edit()
  for (const [format, filter] of [['pptx', 'Impress MS PowerPoint 2007 XML'], ['odp', 'impress8'], ['pdf', 'impress_pdf_Export']]) {
    const result = request('export', { format })
    assert.equal(result.ok, true)
    assert.equal(result.data.extension, format)
    assert.equal(result.data.dirty, true)
    assert.equal(stores.at(-1).args.find(item => item.Name === 'FilterName').Value, filter)
  }
  assert.equal(request('export', { format: 'docx' }).ok, false)
  assert.equal(request('export', { format: 'xlsx' }).ok, false)
  assert.equal(model.isModified(), true)
})

test('presentation imports ODP and refuses mismatched type before loading a file', async () => {
  const { request, imports } = await engine({ kind: 'presentation', extension: 'odp' })
  assert.equal(request('open', { id: 'B', kind: 'presentation', extension: 'odp', path: '/tmp/slides.odp', isNew: false }).ok, true)
  assert.equal(imports.at(-1).url, 'file:///tmp/slides.odp')
  const count = imports.length
  assert.equal(request('open', { id: 'C', kind: 'presentation', extension: 'docx', path: '/tmp/file.docx' }).ok, false)
  assert.equal(imports.length, count)
})

test('opening another presentation preserves a clean untitled frame until the replacement is ready', async () => {
  const { request, model, models, imports } = await engine({ kind: 'presentation', extension: 'pptx' })
  request('new-slide')
  const snapshot = request('export', { format: 'pptx' }).data
  request('mark-saved', { revision: snapshot.revision })
  const opened = request('open', { id: 'B', name: 'existing.pptx', kind: 'presentation', extension: 'pptx', path: '/tmp/existing.pptx', isNew: false })
  assert.equal(opened.ok, true)
  assert.equal(imports.at(-1).target, '_blank')
  assert.equal(model.closed, true, 'The previous model closes only after successful replacement')
  assert.equal(models.at(-1).closed, false, 'The imported model must remain open')
  assert.equal(request('export', { format: 'pptx' }, 'B').ok, true)
})

test('failed imports and wrong services leave the original presentation available for editing and export', async () => {
  const { request, model, models, controls } = await engine({ kind: 'presentation', extension: 'pptx' })
  const imported = { id: 'B', kind: 'presentation', extension: 'pptx', path: '/tmp/bad.pptx', isNew: false }
  controls.failNextLoad = true
  assert.equal(request('open', imported).ok, false)
  assert.equal(model.closed, false)
  assert.equal(request('export', { format: 'pptx' }).ok, true)
  controls.rejectNextService = true
  assert.equal(request('open', imported).ok, false)
  assert.equal(models.at(-1).closed, true, 'Reject only the newly loaded wrong document')
  assert.equal(model.closed, false)
  model.edit()
  assert.equal(request('export', { format: 'pptx' }).data.dirty, true)
})

test('Impress image insertion targets the active slide and fits tall images without distortion', async () => {
  const { request, model } = await engine({ kind: 'presentation', extension: 'pptx' })
  assert.equal(request('insert-image', { path: '/tmp/image.png' }).ok, true)
  const image = model.shapes.at(-1)
  assert.equal(image.service, 'com.sun.star.drawing.GraphicObjectShape')
  assert.ok(image.Graphic)
  assert.ok(image.size.Height <= 13750)
  assert.ok(Math.abs(image.size.Height / image.size.Width - 3) < 0.001)
  assert.equal(image.position.X, 1000)
  assert.equal(image.position.Y, 1000)
})

test('presentation actions add a themed slide, preserve edits, and route only to safe static preview', async () => {
  const { request, model, messages, frame } = await engine({ kind: 'presentation', extension: 'pptx' })
  const slide = request('new-slide')
  assert.equal(slide.ok, true)
  assert.equal(slide.data.slideCount, 2)
  assert.equal(slide.data.dirty, true)
  assert.equal(model.pages[1].master, 'master')
  assert.equal(model.pages[1].Layout, 1)
  assert.equal(request('start-presentation').ok, false)
  assert.equal(request('end-presentation').ok, false)
  assert.equal(request('preview-presentation', { fromCurrent: true }).data.pageIndex, 1)
  for (const [command, pageIndex] of [['.uno:Presentation', 0], ['.uno:PresentationCurrentSlide', 1], ['.uno:RehearseTimings', 0]]) {
    const url = { Complete: command }
    frame.interceptor.queryDispatch(url, '', 0).dispatch(url, [])
    assert.equal(messages.at(-1).data.type, 'presentation-preview')
    assert.equal(messages.at(-1).data.pageIndex, pageIndex)
  }
  assert.equal(model.getPresentation().isRunning(), false, 'No action may enter the unsafe native slideshow path')
  const snapshot = request('export', { format: 'pptx' }).data
  model.edit()
  assert.equal(request('mark-saved', { revision: snapshot.revision }).data.dirty, true)
  assert.equal(request('discard', { revision: snapshot.revision }).ok, false)
  assert.equal(request('new-slide', {}, 'other-document').ok, false)
})

test('native duplicate-slide menus route the active slide through the shell without bypassing its media metadata', async () => {
  const { request, model, frame, messages } = await engine({ kind: 'presentation', extension: 'pptx' })
  request('new-slide')
  const snapshot = request('export', { format: 'pptx' }).data
  request('mark-saved', { revision: snapshot.revision })
  let previousDelegate
  for (const command of ['.uno:DuplicatePage', '.uno:DuplicateSlide']) {
    const url = { Complete: command }
    const delegate = frame.interceptor.queryDispatch(url, '', 0)
    assert.ok(delegate)
    delegate.dispatch(url, [])
    assert.equal(messages.at(-1).event, 'native-request')
    assert.equal(messages.at(-1).documentId, 'A')
    assert.equal(messages.at(-1).data.type, 'presentation-duplicate')
    assert.equal(messages.at(-1).data.pageIndex, 1)
    assert.equal(model.pages.length, 2, 'The shell must duplicate the page and media together')
    assert.equal(model.isModified(), false)
    previousDelegate = delegate
  }
  assert.equal(request('open', { id: 'B', name: 'B.pptx', kind: 'presentation', extension: 'pptx', isNew: true }).ok, true)
  const before = messages.length
  previousDelegate.dispatch({ Complete: '.uno:DuplicatePage' }, [])
  assert.equal(messages.length, before, 'A stale frame cannot duplicate a slide in the next document')
  const word = await engine()
  assert.equal(word.frame.interceptor.queryDispatch({ Complete: '.uno:DuplicatePage' }, '', 0), null)
})

test('Word rejects presentation-only actions without editing the current document', async () => {
  const { request, model } = await engine()
  for (const action of ['new-slide','preview-presentation','start-presentation','end-presentation']) assert.equal(request(action).ok, false)
  assert.equal(model.isModified(), false)
})

test('export preserves authoritative modified state before queued UI notification', async () => {
  const { request, model, stores } = await engine()
  model.edit(false)
  const exported = request('export', { format: 'docx' })
  assert.equal(exported.ok, true)
  assert.equal(exported.data.dirty, true)
  assert.equal(model.isModified(), true, 'Export must not mark the editor saved')
  assert.equal(stores[0].args.find(item => item.Name === 'FilterName').Value, 'Office Open XML Text')
})

test('export never sets the same modified flag but restores a genuinely changed native flag',async()=>{
  for(const initial of [false,true]) {
    const {request,model,stores}=await engine()
    if(initial)model.edit()
    const writes=[]
    model.setModified=function(value){writes.push(value);this.modified=value;this.listener?.modified()}
    model.storeToURL=function(path,args){stores.push({path,args})}
    const first=request('export',{format:'docx'})
    assert.equal(first.ok,true);assert.deepEqual(writes,[])
    assert.equal(first.data.dirty,initial);assert.equal(model.isModified(),initial)
    model.storeToURL=function(path,args){stores.push({path,args});this.modified=!initial}
    const second=request('export',{format:'docx'})
    assert.equal(second.ok,true);assert.deepEqual(writes,[initial])
    assert.equal(second.data.revision,first.data.revision,'Restoring the export flag must remain suppressed')
    assert.equal(model.isModified(),initial)
    model.edit()
    assert.equal(request('discard',{revision:second.data.revision}).ok,false,'Real later edits must still reject discard')
  }
})

test('late clean native notifications advance revision without inventing unsaved edits after discard', async () => {
  const { request, model, messages } = await engine()
  model.edit()
  const exported = request('export', { format: 'docx' }).data
  assert.equal(request('discard', { revision: exported.revision }).ok, true)
  model.listener.modified() // Real Writer emits this later with isModified() false.
  const state = request('word-state').data
  assert.equal(state.dirty, false)
  assert.equal(state.revision, exported.revision + 1, 'Even clean native notifications must remain in the revision sequence')
  assert.equal(messages.filter(message => message.event === 'dirty').at(-1).data.dirty, false)
  assert.equal(request('word-action', { type: 'edit', expectedRevision: exported.revision }).ok, false, 'A stale edit still cannot bypass revision protection')
  assert.equal(request('discard', { revision: exported.revision }).ok, false, 'A stale export still cannot clear a newer revision')
  assert.equal(request('open', { id: 'B', name: 'B.docx', kind: 'word', extension: 'docx', isNew: true }).ok, true, 'The already discarded, native-clean model may be replaced')
})

test('a genuine native edit after discard remains dirty and blocks replacement', async () => {
  const { request, model } = await engine()
  model.edit()
  const exported = request('export', { format: 'docx' }).data
  assert.equal(request('discard', { revision: exported.revision }).ok, true)
  model.edit()
  assert.equal(request('word-state').data.dirty, true)
  assert.equal(request('open', { id: 'B', name: 'B.docx', kind: 'word', extension: 'docx', isNew: true }).ok, false)
  assert.equal(model.closed, false)
  assert.equal(request('discard', { revision: exported.revision }).ok, false)
})

test('edits after export reject stale save/discard acknowledgements', async () => {
  const { request, model } = await engine()
  model.edit()
  const exported = request('export', { format: 'docx' }).data
  model.edit()
  assert.equal(request('mark-saved', { revision: exported.revision }).data.dirty, true)
  assert.equal(model.isModified(), true)
  assert.equal(request('discard', { revision: exported.revision }).ok, false)
  assert.equal(model.isModified(), true)
  const latest = request('export', { format: 'docx' }).data
  assert.equal(request('discard', { revision: latest.revision }).ok, true)
  assert.equal(model.isModified(), false)
})

test('discard requires an export revision or explicit force; wrong document is always rejected', async () => {
  const { request, model } = await engine()
  model.edit()
  assert.equal(request('discard').ok, false)
  assert.equal(request('discard', { force: true }, 'wrong-tab').ok, false)
  assert.equal(request('export', { format: 'docx' }, 'wrong-tab').ok, false)
  assert.equal(model.isModified(), true)
  assert.equal(request('discard', { force: true }).ok, true)
  assert.equal(model.isModified(), false)
})

test('current export acknowledgement marks saved while unsupported formats are rejected', async () => {
  const { request, model } = await engine()
  model.edit()
  assert.equal(request('export', { format: 'xlsx' }).ok, false)
  const exported = request('export', { format: 'docx' }).data
  assert.equal(request('mark-saved', { revision: exported.revision }).data.dirty, false)
  assert.equal(model.isModified(), false)
})


test('common File commands use native save/export/print/quit flows without writing virtual files', async () => {
  const { frame, messages, model, stores } = await engine()
  model.edit()
  const interceptor = frame.interceptor
  const expected = new Map([
    ['.uno:SaveACopy', 'save-as'], ['.uno:ExportTo', 'export-pdf'],
    ['.uno:ExportDirectToPDF', 'export-pdf'], ['.uno:Print', 'print'],
    ['.uno:PrintDefault', 'print'], ['.uno:PrintPagePreview', 'print'], ['.uno:Quit', 'quit'],
  ])
  for (const [command, type] of expected) {
    assert.ok(interceptor.getInterceptedURLs().includes(command), command + ' must reach the interceptor')
    const url = { Complete: command }
    const dispatch = interceptor.queryDispatch(url, '', 0)
    assert.ok(dispatch, command + ' must have a native delegate')
    dispatch.dispatch(url, [])
    const message = messages.at(-1)
    assert.equal(message.event, 'native-request')
    assert.equal(message.documentId, 'A')
    assert.equal(message.data.type, type)
    if (command === '.uno:ExportTo') assert.match(message.data.notice, /仅支持 PDF/)
    if (command === '.uno:ExportDirectToPDF') assert.equal(message.data.notice, undefined)
  }
  assert.equal(stores.length, 0, 'File actions must not save only to the engine filesystem')
  assert.equal(model.isModified(), true, 'A file command is not a native save acknowledgement')
  assert.equal(interceptor.getInterceptedURLs().includes('.uno:PrintPreview'), false)
  assert.equal(interceptor.queryDispatch({ Complete: '.uno:PrintPreview' }, '', 0), null)
})

const plain = value => JSON.parse(JSON.stringify(value))
const presentation = () => engine({ kind: 'presentation', extension: 'pptx' })
function state(request) {
  const reply = request('presentation-state')
  assert.equal(reply.ok, true, reply.error)
  return plain(reply.data)
}
function action(request, data) {
  const reply = request('presentation-action', data)
  assert.equal(reply.ok, true, reply.error)
  return plain(reply.data)
}

test('presentation-state reads titles and metadata without dirtying, renaming, or creating notes', async () => {
  const { request, model, messages } = await presentation()
  const title = model.createInstance('com.sun.star.presentation.TitleTextShape')
  model.pages[0].add(title); title.getText().setString('季度报告 · Q4')
  const fallback = model.createInstance('com.sun.star.drawing.TextShape')
  model.pages[0].add(fallback); fallback.getText().setString('正文不是页名')
  const saved = request('export', { format: 'pptx' }).data
  request('mark-saved', { revision: saved.revision })
  const names = model.pages.map(page => page.getName()), mutations = model.mutations.length
  const dirtyEvents = messages.filter(message => message.event === 'dirty').length
  const first = state(request), second = state(request)
  assert.deepEqual(first, second, 'Repeated reads must retain identities and revision')
  assert.deepEqual(first.pageSize, { width: 280, height: 157.5 })
  assert.equal(first.currentPage.title, '季度报告 · Q4')
  assert.equal(first.currentPage.name, names[0])
  assert.equal(first.currentPage.notes, '')
  assert.deepEqual(first.currentPage.background, { type: 'none' })
  assert.equal(first.currentPage.hidden, false)
  assert.equal(first.dirty, false)
  assert.equal(first.revision, saved.revision)
  assert.deepEqual(model.pages.map(page => page.getName()), names)
  assert.equal(model.pages[0].getNotesPage().getCount(), 0, 'Reading absent notes must not add a placeholder')
  assert.equal(model.mutations.length, mutations)
  assert.equal(messages.filter(message => message.event === 'dirty').length, dirtyEvents)
  assert.equal(model.isModified(), false)
})

test('presentation slide IDs survive rename, reorder, and stale sorter multiselection', async () => {
  const { request, model, dispatches } = await presentation()
  const originalId = state(request).pages[0].id
  action(request, { type: 'add-page', layout: 20 })
  const all = action(request, { type: 'add-page', layout: 19 })
  const ids = all.pages.map(page => page.id)
  assert.equal(new Set(ids).size, 3)
  assert.equal(ids[0], originalId)
  const renamed = action(request, { type: 'rename-page', pageIndex: 0, name: '  开场总览  ' })
  assert.equal(renamed.pages[0].name, '开场总览')
  assert.deepEqual(renamed.pages.map(page => page.id), ids)
  const controller = model.getCurrentController()
  controller.setCurrentPage(model.pages[0])
  controller.selectedPages = [...model.pages]
  const moved = action(request, { type: 'move-page', pageIndex: 0, direction: 'down' })
  assert.deepEqual(moved.pages.map(page => page.id), [ids[1], ids[0], ids[2]])
  assert.equal(moved.currentPage.id, originalId)
  assert.equal(moved.currentPageIndex, 1)
  assert.equal(moved.currentPage.name, '开场总览')
  assert.equal(dispatches.at(-1), '.uno:MovePageDown')
  const restored = action(request, { type: 'move-page', pageIndex: 1, direction: 'up' })
  assert.deepEqual(restored.pages.map(page => page.id), ids)
  assert.equal(restored.currentPageIndex, 0)
  assert.equal(dispatches.at(-1), '.uno:MovePageUp')
  const mutationCount = model.mutations.length, revision = restored.revision
  const selected = action(request, { type: 'select-page', pageIndex: 2 })
  assert.equal(selected.currentPage.id, ids[2])
  assert.equal(selected.revision, revision, 'Changing selected slide is not an edit')
  assert.equal(model.mutations.length, mutationCount)
})

test('presentation actions persist notes, visibility, background, layout, and document-wide dimensions', async () => {
  const { request, model } = await presentation()
  action(request, { type: 'add-page', layout: 3 })
  const original = model.pages[1], notes = original.getNotesPage()
  const footer = model.createInstance('com.sun.star.presentation.FooterShape')
  notes.add(footer); footer.getText().setString('保留页脚')
  const withNotes = action(request, { type: 'set-notes', text: '开场提醒\n第二段中文备注' })
  assert.equal(withNotes.currentPage.notes, '开场提醒\n第二段中文备注')
  action(request, { type: 'set-notes', text: '更新后的备注' })
  assert.equal(notes.pageShapes.filter(shape => shape.service.endsWith('.NotesShape')).length, 1)
  assert.equal(footer.getText().getString(), '保留页脚')
  assert.equal(action(request, { type: 'set-hidden', value: true }).currentPage.hidden, true)
  assert.equal(original.getPropertyValue('Visible'), false)
  assert.equal(action(request, { type: 'set-hidden', value: false }).currentPage.hidden, false)
  assert.deepEqual(action(request, { type: 'set-background', color: '#12abEF' }).currentPage.background, { type: 'solid', color: '#12ABEF' })
  assert.equal(original.Background.getPropertyValue('FillColor'), 0x12abef)
  assert.deepEqual(action(request, { type: 'set-background', color: null }).currentPage.background, { type: 'none' })
  assert.equal(action(request, { type: 'set-layout', layout: 0 }).currentPage.layout, 0, 'Layout zero is a valid title slide')
  const resized = action(request, { type: 'set-page-size', width: 320.125, height: 180 })
  assert.deepEqual(resized.pageSize, { width: 320.13, height: 180 })
  for (const page of model.pages) assert.deepEqual([page.Width, page.Height], [32013, 18000])
  assert.deepEqual([notes.Width, notes.Height], [21000, 29700], 'Notes page dimensions are a separate page kind')
  const copy = action(request, { type: 'duplicate-page' })
  assert.equal(copy.pageCount, 3)
  assert.equal(copy.currentPage.notes, '更新后的备注')
  assert.equal(copy.currentPage.layout, 0)
  assert.notEqual(copy.pages[1].id, copy.pages[2].id, 'Duplicate receives its own runtime identity')
  assert.equal(copy.dirty, true)
})

test('presentation refuses deleting the final slide and selects a surviving slide after deletion', async () => {
  const { request, model } = await presentation()
  const first = state(request), refused = request('presentation-action', { type: 'delete-page' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /至少.*一张/)
  assert.deepEqual(state(request), first)
  assert.equal(model.mutations.length, 0)
  const added = action(request, { type: 'add-page', layout: 20 })
  const deleted = action(request, { type: 'delete-page', pageIndex: 1 })
  assert.equal(deleted.pageCount, 1)
  assert.equal(deleted.currentPageIndex, 0)
  assert.equal(deleted.currentPage.id, first.currentPage.id)
  assert.notEqual(deleted.currentPage.id, added.currentPage.id)
  assert.equal(request('presentation-action', { type: 'delete-page' }).ok, false)
  assert.equal(model.pages.length, 1)
})

test('invalid presentation operations reject before altering content or revision', async () => {
  const { request, model } = await presentation()
  const before = state(request)
  const invalid = [
    ...[-1, 2, 21, 31, 35, 1.5, '1', null].map(layout => ({ type: 'set-layout', layout })),
    { type: 'add-page', layout: 21 },
    ...['red', '#fff', '#12345678', '#GG0000', '', 12, undefined].map(color => ({ type: 'set-background', color })),
    ...[49, 1001, Infinity, NaN, '280', null].map(width => ({ type: 'set-page-size', width, height: 180 })),
    { type: 'set-page-size', width: 280, height: 0 },
    { type: 'set-page-size', width: 280, height: Infinity },
    ...[null, 12, {}, 'x'.repeat(50001)].map(text => ({ type: 'set-notes', text })),
    ...[-1, 0.5, 1, '0', null].map(pageIndex => ({ type: 'select-page', pageIndex })),
    ...[-1, 1, '0', null, NaN].map(expectedRevision => ({ type: 'rename-page', name: '不能应用', expectedRevision })),
    ...['', '   ', 7, 'x'.repeat(151)].map(name => ({ type: 'rename-page', name })),
    { type: 'set-hidden', value: 'false' },
    { type: 'set-hidden', value: 0 },
    { type: 'move-page', direction: 'left' },
    { type: 'move-page', direction: 'up' },
    { type: 'move-page', direction: 'down' },
    { type: 'unsupported-action' }, {}, null,
  ]
  for (const data of invalid) {
    const result = request('presentation-action', data)
    assert.equal(result.ok, false, `Invalid input accepted: ${JSON.stringify(data)?.slice(0, 160)}`)
    assert.ok(result.error)
    assert.deepEqual(state(request), before, 'Rejected input must preserve page state and revision')
  }
  assert.equal(model.mutations.length, 0)
  assert.equal(model.isModified(), false)
})

test('presentation stale revisions and cross-document requests cannot edit the active document', async () => {
  const { request, model } = await presentation()
  const initial = state(request)
  const changed = action(request, { type: 'rename-page', name: '已更新', expectedRevision: initial.revision })
  assert.ok(changed.revision > initial.revision)
  assert.equal(request('presentation-action', { type: 'set-notes', text: '过期覆盖', expectedRevision: initial.revision }).ok, false)
  assert.equal(request('presentation-state', {}, 'another-document').ok, false)
  for (const type of ['rename-page', 'delete-page', 'duplicate-page', 'set-notes', 'move-page']) {
    assert.equal(request('presentation-action', { type, name: '其它文档', text: '其它文档', direction: 'down' }, 'another-document').ok, false)
  }
  assert.deepEqual(state(request), changed)
  const mutations = model.mutations.length
  const current = action(request, { type: 'set-notes', text: '当前修订允许编辑', expectedRevision: changed.revision })
  assert.equal(current.currentPage.notes, '当前修订允许编辑')
  assert.ok(model.mutations.length > mutations)
  const added = action(request, { type: 'add-page', layout: 20 })
  assert.equal(request('presentation-action', { type: 'rename-page', name: '已更新', pageIndex: 1 }).ok, false)
  assert.deepEqual(state(request), added, 'Duplicate names must not change identities or content')
})

test('presentation move verifies actual order and refuses a controller that cannot switch pages', async () => {
  const { request, controls, dispatches } = await presentation()
  const before = action(request, { type: 'add-page', layout: 20 })
  controls.refusePageSwitch = true
  const cannotSwitch = request('presentation-action', { type: 'move-page', pageIndex: 1, direction: 'up' })
  assert.equal(cannotSwitch.ok, false)
  assert.match(cannotSwitch.error, /未能切换/)
  assert.equal(dispatches.length, 0)
  controls.refusePageSwitch = false; controls.ignoreMove = true
  const unchangedOrder = request('presentation-action', { type: 'move-page', pageIndex: 1, direction: 'up' })
  assert.equal(unchangedOrder.ok, false)
  assert.match(unchangedOrder.error, /未能按预期移动/)
  assert.deepEqual(state(request).pages, before.pages)
  assert.equal(state(request).revision, before.revision)
})

test('Word and Calc reject all presentation metadata requests without dirtying', async () => {
  for (const initial of [{ kind: 'word', extension: 'docx' }, { kind: 'sheet', extension: 'xlsx' }]) {
    const { request, model } = await engine(initial)
    assert.equal(request('presentation-state').ok, false)
    for (const type of ['select-page', 'rename-page', 'add-page', 'duplicate-page', 'delete-page', 'set-background', 'set-notes', 'set-page-size', 'set-hidden', 'set-layout']) {
      assert.equal(request('presentation-action', { type }).ok, false, `${initial.kind}: ${type}`)
    }
    assert.equal(model.isModified(), false)
    assert.equal(model.mutations.length, 0)
  }
})

test('only presentation PDF exports include typed PropertyValue sequence preserving hidden slides', async () => {
  for (const initial of [{ kind: 'word', extension: 'docx' }, { kind: 'sheet', extension: 'xlsx' }, { kind: 'presentation', extension: 'pptx' }]) {
    const { request, stores } = await engine(initial)
    for (const format of [initial.extension, 'pdf']) {
      const result = request('export', { format })
      assert.equal(result.ok, true, result.error)
      const option = stores.at(-1).args.find(item => item.Name === 'FilterData')
      if (initial.kind === 'presentation' && format === 'pdf') {
        assert.ok(option, 'Impress PDF needs FilterData to keep preview indexes aligned')
        assert.equal(option.Value.type.kind, 'sequence')
        assert.equal(option.Value.type.element.kind, 'struct')
        assert.equal(option.Value.type.element.definition, stores.at(-1).args[0].constructor, 'Sequence element is beans.PropertyValue, not Any')
        assert.equal(option.Value.value.length, 1)
        assert.equal(option.Value.value[0].Name, 'ExportHiddenSlides')
        assert.equal(option.Value.value[0].Value, true)
        assert.equal(option.Value.value[0].constructor, option.Value.type.element.definition)
      } else assert.equal(option, undefined, `${initial.kind}/${format} must not receive Impress-only PDF options`)
    }
  }
})

test('unknown top-level worker actions reject without dispatching or changing document state', async () => {
  const { request, model, stores, dispatches, messages } = await presentation()
  const before = state(request), eventCount = messages.filter(message => message.event).length
  for (const command of ['unsupported-rpc', 'presentation-acton', '', null, 123]) {
    const result = request(command, { type: 'delete-page' })
    assert.equal(result.ok, false, `Unknown worker action accepted: ${JSON.stringify(command)}`)
    assert.ok(result.error)
  }
  assert.deepEqual(state(request), before)
  assert.equal(model.mutations.length, 0)
  assert.equal(model.isModified(), false)
  assert.equal(stores.length, 0)
  assert.equal(dispatches.length, 0)
  assert.equal(messages.filter(message => message.event).length, eventCount)
})

test('audited offline dispatches are disabled and cannot reach shell or native delegate', async () => {
  const { frame, messages, model } = await engine()
  const forwarded = []
  frame.interceptor.setSlaveDispatchProvider({ queryDispatch(url) {
    forwarded.push(url.Complete)
    return { dispatch() { forwarded.push('executed') }, addStatusListener() {}, removeStatusListener() {} }
  } })
  for (const command of ['.uno:OpenRemote', '.uno:SaveAsRemote?URL:string=https://example.invalid',
    '.uno:OpenHyperlinkOnCursor', '.uno:MailMergeEmailDocuments', '.uno:Documentation',
    '.uno:DataStreamsPlay', 'https://example.invalid/document']) {
    const url = { Complete: command }, dispatch = frame.interceptor.queryDispatch(url, '', 0)
    let enabled
    dispatch.addStatusListener({ statusChanged: event => { enabled = event.IsEnabled } }, url)
    assert.equal(enabled, false, command)
    dispatch.dispatch(url, [])
  }
  assert.deepEqual(forwarded, [])
  assert.equal(messages.filter(message => message.event === 'native-request').length, 0)
  assert.equal(model.isModified(), false)
  for (const command of ['.uno:SpellOnline', '.uno:SendToBack', '.uno:UpdateAllIndexes', '.uno:EditHyperlink']) {
    const url = { Complete: command }
    frame.interceptor.queryDispatch(url, '', 0).dispatch(url, [])
  }
  assert.equal(forwarded.filter(item => item === 'executed').length, 4)
  const url = { Complete: '.uno:InsertDoc' }
  frame.interceptor.queryDispatch(url, '', 0).dispatch(url, [{ Name: 'FileName', Value: 'https://example.invalid/file' }])
  assert.equal(forwarded.filter(item => item === 'executed').length, 4, 'A late remote file argument does not reach the native command')
})

test('local open aliases route to native picker and late remote arguments cannot bypass it', async () => {
  const { frame, messages } = await engine()
  for (const command of ['.uno:OpenFromWriter', '.uno:OpenFromCalc', '.uno:Open?ReadOnly:boolean=true']) {
    const url = { Complete: command }
    frame.interceptor.queryDispatch(url, '', 0).dispatch(url, [])
  }
  const before = messages.filter(message => message.event === 'native-request').length
  assert.equal(before, 3)
  const url = { Complete: '.uno:Open' }
  frame.interceptor.queryDispatch(url, '', 0).dispatch(url, [{ Name: 'URL', Value: 'https://example.invalid/file' }])
  assert.equal(messages.filter(message => message.event === 'native-request').length, before)
})

for (const [kind, extension, modern] of [['word','doc','docx'], ['word','rtf','docx'], ['sheet','xls','xlsx'], ['presentation','ppt','pptx']]) {
  test(`${extension} imports use protected local pipeline and export a modern copy by default`, async () => {
    const { request, imports, stores } = await engine({ kind, extension })
    const args = imports[0].args
    for (const name of ['MacroExecutionMode','UpdateDocMode']) assert.equal(args.find(item => item.Name === name)?.Value.value, 0)
    const result = request('export')
    assert.equal(result.ok, true)
    assert.equal(result.data.extension, modern)
    const count = stores.length
    assert.equal(request('export', { format: extension }).ok, false)
    assert.equal(stores.length, count, 'Legacy source must not be rewritten through an unverified legacy exporter')
  })
}

test('imported notes placeholder is reused when its shape type is specific but services are generic', async () => {
  const { request, model } = await presentation()
  const notes = model.pages[0].getNotesPage()
  // Match the observed OOXML import: NotesShape type, drawing.TextShape service.
  const placeholder = model.createInstance('com.sun.star.drawing.TextShape')
  placeholder.getShapeType = () => 'com.sun.star.presentation.NotesShape'
  assert.equal(placeholder.supportsService('com.sun.star.presentation.NotesShape'), false)
  notes.add(placeholder)
  const saved = request('export', { format: 'pptx' }).data
  request('mark-saved', { revision: saved.revision })
  const before = model.mutations.length
  assert.equal(state(request).currentPage.notes, '')
  assert.equal(model.mutations.length, before)
  assert.equal(model.isModified(), false)
  for (const text of ['第一份备注', '修改原有备注\n第二段', '', '清空后继续填写']) {
    const updated = action(request, { type: 'set-notes', text })
    assert.equal(updated.currentPage.notes, text)
    assert.equal(placeholder.getText().getString(), text)
    assert.equal(notes.getCount(), 1, 'Editing imported notes must never append duplicate body placeholders')
    assert.equal(notes.getByIndex(0), placeholder)
  }
  assert.ok(model.mutations.slice(before).every(mutation => mutation.type === 'text'))
})

test('imported nonempty NotesShape wins over blank placeholder and TitleTextShape wins over body text', async () => {
  const { request, model } = await presentation()
  const page = model.pages[0], notes = page.getNotesPage()
  const importedText = (container, type, text) => {
    const shape = model.createInstance('com.sun.star.drawing.TextShape')
    shape.getShapeType = () => type
    container.add(shape); shape.getText().setString(text)
    return shape
  }
  const body = importedText(page, 'com.sun.star.drawing.TextShape', '正文排在标题前面')
  const title = importedText(page, 'com.sun.star.presentation.TitleTextShape', '真实导入标题')
  const empty = importedText(notes, 'com.sun.star.presentation.NotesShape', '')
  const footer = importedText(notes, 'com.sun.star.presentation.FooterShape', '保留原页脚')
  const populated = importedText(notes, 'com.sun.star.presentation.NotesShape', '空占位符后面的真实备注')
  assert.equal(title.supportsService('com.sun.star.presentation.TitleTextShape'), false)
  assert.equal(populated.supportsService('com.sun.star.presentation.NotesShape'), false)
  const saved = request('export', { format: 'pptx' }).data
  request('mark-saved', { revision: saved.revision })
  const mutations = model.mutations.length, initial = state(request)
  assert.equal(initial.currentPage.title, '真实导入标题')
  assert.equal(initial.currentPage.notes, '空占位符后面的真实备注')
  assert.equal(initial.dirty, false)
  assert.equal(model.mutations.length, mutations)
  for (const text of ['更新真实备注', '再次更新，不新增占位符']) {
    const updated = action(request, { type: 'set-notes', text })
    assert.equal(updated.currentPage.notes, text)
    assert.equal(populated.getText().getString(), text)
    assert.equal(empty.getText().getString(), '')
    assert.equal(footer.getText().getString(), '保留原页脚')
    assert.equal(notes.getCount(), 3)
  }
  assert.equal(body.getText().getString(), '正文排在标题前面')
  assert.equal(title.getText().getString(), '真实导入标题')
  assert.ok(model.mutations.slice(mutations).every(mutation => mutation.type === 'text' && mutation.target === populated))
})

test('optional presentation reads consume each ignored native UNO exception once and return fallback metadata', async () => {
  const { request, model, nativeException, nativeExceptions, exceptionCalls } = await presentation()
  const unreadable = model.createInstance('com.sun.star.drawing.TextShape')
  unreadable.getText = () => { throw nativeException('getText native UNO failure') }
  model.pages[0].add(unreadable)
  const fallback = model.createInstance('com.sun.star.drawing.TextShape')
  fallback.getText().setString('可读取的备用标题')
  fallback.getShapeType = () => { throw nativeException('getShapeType native UNO failure') }
  model.pages[0].add(fallback)
  const saved = request('export', { format: 'pdf' }).data
  request('mark-saved', { revision: saved.revision })
  const mutations = model.mutations.length
  for (let read = 1; read <= 2; read++) {
    const metadata = state(request)
    assert.equal(metadata.currentPage.title, '可读取的备用标题')
    assert.equal(metadata.currentPage.notes, '')
    assert.equal(metadata.dirty, false)
    assert.equal(metadata.revision, saved.revision)
    assert.equal(nativeExceptions.size, read * 2, 'Each throw represents a distinct native exception')
  }
  assert.equal(exceptionCalls.length, 4)
  for (const native of nativeExceptions.values()) assert.equal(native.consumed, 1, native.message)
  assert.equal(model.mutations.length, mutations)
  assert.equal(model.isModified(), false)
})

test('failed open consumes secondary cleanup exception and primary RPC exception exactly once each', async () => {
  const { request, model, models, controls, nativeException, nativeExceptions, exceptionCalls } = await presentation()
  const primary = nativeException('primary: native listener registration failed')
  const secondary = nativeException('secondary: native cleanup close failed')
  controls.configureNextModel = replacement => {
    replacement.addModifyListener = () => { throw primary }
    replacement.close = () => { replacement.closed = true; throw secondary }
  }
  const result = request('open', { id: 'B', name: 'B.pptx', kind: 'presentation', extension: 'pptx', path: '/tmp/b.pptx', isNew: false })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'primary: native listener registration failed', 'Cleanup must not replace the original RPC error')
  assert.deepEqual(exceptionCalls, [secondary, primary], 'Cleanup consumes its error; RPC describe consumes the rethrown original')
  assert.equal(nativeExceptions.get(primary).consumed, 1)
  assert.equal(nativeExceptions.get(secondary).consumed, 1)
  assert.equal(models.at(-1).closed, true)
  assert.equal(model.closed, false, 'The previous document remains usable after replacement fails')
  assert.equal(request('export', { format: 'pptx' }).ok, true)
})

test('optional presentation metadata reads propagate WASM traps instead of reporting fallback success', async () => {
  for (const failingMethod of ['getText', 'getShapeType']) {
    const { request, model, exceptionCalls, nativeExceptions } = await presentation()
    const shape = model.createInstance('com.sun.star.drawing.TextShape')
    shape.getText().setString('必须保持的内容')
    const trap = new WebAssembly.RuntimeError(`unaligned memory access in ${failingMethod}`)
    shape[failingMethod] = () => { throw trap }
    model.pages[0].add(shape)
    const saved = request('export', { format: 'pdf' }).data
    request('mark-saved', { revision: saved.revision })
    const mutations = model.mutations.length
    const result = request('presentation-state')
    assert.equal(result.ok, false, `${failingMethod} trap must not become successful empty metadata`)
    assert.match(result.error, /unaligned memory access/)
    assert.equal(result.data, undefined)
    assert.deepEqual(exceptionCalls, [trap], 'Only RPC describe sees a WASM trap; optional recovery must immediately rethrow it')
    assert.equal(nativeExceptions.size, 0, 'A WASM trap is not a recoverable UNO exception')
    assert.equal(model.mutations.length, mutations)
    assert.equal(model.isModified(), false)
  }
})

test('Writer immediate commands use one bounded production route while drafts keep strict revisions', async () => {
  const h=await engine(), command={action:{type:'format-text',bold:true},target:{documentId:'A',revision:0}}
  h.model.edit()
  assert.equal(h.request('word-action',{type:'edit',expectedRevision:0}).ok,false)
  assert.equal(h.request('word-command',command).ok,false,'Tool target rejection must reach the caller')
  assert.equal(h.model.isModified(),true)
  h.controls.acceptCommand=true
  const result=h.request('word-command',command)
  assert.equal(result.ok,true);assert.equal(result.data.documentId,'A');assert.equal(result.data.revision,2)
  assert.equal(h.toolCalls.filter(call=>call[1]==='command').length,2,'No retry or extra read/write RPC')
  const before=h.toolCalls.length
  for(const target of [{documentId:'B',revision:0},{documentId:'A',revision:999},{documentId:'A',revision:-1},{documentId:'A',revision:'0'},null]) assert.equal(h.request('word-command',{action:command.action,target}).ok,false)
  assert.equal(h.toolCalls.length,before)
  assert.equal(h.request('word-command',command,'B').ok,false)
  const sheet=await engine({kind:'sheet',extension:'xlsx'});sheet.controls.acceptCommand=true
  assert.equal(sheet.request('sheet-command',command).ok,false)
})

// Controlled native chart identities/listeners exercise proof generation only.
// Actual Impress import flags and notifications still require WASM integration.
function monitoredChart(name = 'Sales chart') {
  const listeners = new Set()
  const model = { modified: false, attached: 0, removed: 0, cleared: 0,
    queryInterface(type) { assert.equal(type, 'modifiable'); return this },
    isModified() { return this.modified },
    setModified(value) { this.cleared++; this.modified = value },
    addModifyListener(listener) { this.attached++; listeners.add(listener) },
    removeModifyListener(listener) { this.removed++; listeners.delete(listener) },
    edit() { this.modified = true; for (const listener of listeners) listener.modified() },
    dispose() { for (const listener of listeners) listener.disposing() },
  }
  const shape = { name, model, modelReads: 0,
    getShapeType: () => 'com.sun.star.drawing.OLE2Shape',
    getName() { return this.name },
    getPropertySetInfo: () => ({ hasPropertyByName: name => ['Name', 'CLSID', 'Model'].includes(name) }),
    getPropertyValue(key) {
      if (key === 'Name') return this.name
      if (key === 'CLSID') return '{12dcae26-281f-416f-a234-c3086127382e}'
      if (key === 'Model') { this.modelReads++; return this.model }
      throw Error(`Unknown property ${key}`)
    },
  }
  return { shape, model, listeners }
}
async function importedCharts(configure) {
  const h = await engine({ kind: 'presentation', extension: 'pptx' })
  h.controls.configureNextModel = configure
  const opened = h.request('open', { id: 'B', name: 'charts.pptx', kind: 'presentation', extension: 'pptx', path: '/tmp/charts.pptx', isNew: false })
  return { ...h, opened, imported: h.models.at(-1), exportChart: (data = {}) => h.request('export', { format: 'pptx', ...data }, 'B') }
}

test('imported nested charts obtain worker-owned bounded proof; ordinary OLE objects stay unopened', async () => {
  const chart = monitoredChart()
  const foreign = monitoredChart('Spreadsheet object')
  const original = foreign.shape.getPropertyValue
  foreign.shape.getPropertyValue = function (name) { return name === 'CLSID' ? '00020820-0000-0000-C000-000000000046' : original.call(this, name) }
  const group = { getShapeType: () => 'com.sun.star.drawing.GroupShape', getName: () => 'Group', getCount: () => 1, getByIndex: () => chart.shape }
  const h = await importedCharts(model => { model.pages[0].add(group); model.pages[0].add(foreign.shape) })
  assert.equal(h.opened.ok, true)
  const first = h.exportChart({ chartProof: [{ pageId: 'forged', shapeName: 'forged', sourceEligible: true }] })
  assert.equal(first.ok, true)
  assert.equal(first.data.chartProof.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(first.data.chartProof)), [{ pageId: 'B:slide:1', shapeName: 'Sales chart', sourceShapeName: 'Sales chart', sourceEligible: true }])
  assert.equal(chart.model.attached, 1)
  assert.equal(chart.model.cleared, 0, 'Collecting evidence must not clear the native modification flag')
  assert.equal(foreign.shape.modelReads, 0, 'Never activate arbitrary embedded OLE objects')
  for (const format of ['pdf', 'odp']) assert.equal('chartProof' in h.exportChart({ format }).data, false)
  assert.equal(h.exportChart().data.chartProof[0].sourceEligible, true)
})

test('chart modification evidence is sticky through clearing native state, save, undo-like changes and export', async () => {
  const chart = monitoredChart(), h = await importedCharts(model => model.pages[0].add(chart.shape))
  assert.equal(h.exportChart().data.chartProof[0].sourceEligible, true)
  chart.model.edit()
  chart.model.modified = false // Native save/undo can clear the flag but not our event history.
  const saved = h.exportChart()
  assert.equal(saved.data.chartProof[0].sourceEligible, false)
  assert.equal(saved.data.chartProof[0].sourceShapeName, 'Sales chart', 'An edit revokes data reuse, not the established native source identity')
  assert.equal(h.request('mark-saved', { revision: saved.data.revision }, 'B').ok, true)
  assert.equal(h.exportChart().data.chartProof[0].sourceEligible, false)
  assert.equal(chart.model.cleared, 0)
})

test('chart edits emitted inside an otherwise suppressed export invalidate the returned proof', async () => {
  const chart = monitoredChart(), h = await importedCharts(model => model.pages[0].add(chart.shape))
  const store = h.imported.storeToURL
  h.imported.storeToURL = function (...args) { chart.model.edit(); chart.model.modified = false; return store.apply(this, args) }
  const exported = h.exportChart()
  assert.equal(exported.ok, true)
  assert.equal(exported.data.chartProof[0].sourceEligible, false)
  assert.equal(h.exportChart().data.chartProof[0].sourceEligible, false)
})

for (const change of ['new-shape', 'replaced-model', 'duplicate-name', 'moved-page', 'initially-dirty', 'unnotified-dirty', 'disposed']) {
  test(`chart source proof rejects ${change}`, async () => {
    const chart = monitoredChart()
    if (change === 'initially-dirty') chart.model.modified = true
    const h = await importedCharts(model => model.pages[0].add(chart.shape))
    if (change === 'new-shape') h.imported.pages[0].pageShapes[0] = monitoredChart().shape
    if (change === 'replaced-model') chart.shape.model = monitoredChart().model
    if (change === 'duplicate-name') h.imported.pages[0].add(monitoredChart().shape)
    if (change === 'moved-page') {
      const destination = h.imported.getDrawPages().insertNewByIndex(0)
      h.imported.pages[0].pageShapes.length = 0; destination.add(chart.shape)
    }
    if (change === 'unnotified-dirty') chart.model.modified = true
    if (change === 'disposed') chart.model.dispose()
    const exported = h.exportChart({ chartProof: [{ pageId: 'B:slide:1', shapeName: chart.shape.name, sourceEligible: true }] })
    assert.equal(exported.ok, true)
    assert.ok(exported.data.chartProof.length >= 1)
    assert.ok(exported.data.chartProof.every(item => item.sourceEligible === false))
    if (!['initially-dirty', 'unnotified-dirty'].includes(change)) assert.ok(exported.data.chartProof.every(item => item.sourceShapeName === undefined))
    assert.equal(chart.model.cleared, 0)
  })
}

test('renaming or slide reordering keeps a verified chart source association without confusing it with data reuse', async () => {
  const chart = monitoredChart('Chart 3'), h = await importedCharts(model => {
    const page = model.getDrawPages().insertNewByIndex(0); page.add(chart.shape)
  })
  const before = h.exportChart().data.chartProof[0]
  h.imported.pages.reverse()
  chart.shape.name = 'Chart 1' // Impress renumbers its default name after moving the page.
  const moved = h.exportChart().data.chartProof[0]
  assert.equal(moved.pageId, before.pageId)
  assert.equal(moved.shapeName, 'Chart 1')
  assert.equal(moved.sourceShapeName, 'Chart 3')
  assert.equal(moved.sourceEligible, true)
  chart.model.edit(); chart.model.modified = false
  const edited = h.exportChart().data.chartProof[0]
  assert.equal(edited.sourceShapeName, 'Chart 3')
  assert.equal(edited.shapeName, 'Chart 1')
  assert.equal(edited.sourceEligible, false, 'Identity mapping must never become authorization to restore edited data')
})

test('initially ambiguous chart names cannot gain source identity by renaming later', async () => {
  const first = monitoredChart('Same'), second = monitoredChart('Same')
  const h = await importedCharts(model => { model.pages[0].add(first.shape); model.pages[0].add(second.shape) })
  second.shape.name = 'Unique'
  const result = h.exportChart().data.chartProof
  assert.equal(result.length, 2)
  assert.ok(result.every(proof => !proof.sourceEligible && proof.sourceShapeName === undefined))
})

test('native renaming during serialization retains only the same tracked chart identity across export', async () => {
  const chart = monitoredChart('Chart 3'), h = await importedCharts(model => model.pages[0].add(chart.shape))
  const store = h.imported.storeToURL
  h.imported.storeToURL = function (...args) { chart.shape.name = 'Chart 1'; return store.apply(this, args) }
  const proof = h.exportChart().data.chartProof[0]
  assert.equal(proof.sourceShapeName, 'Chart 3')
  assert.equal(proof.shapeName, 'Chart 1')
  assert.equal(proof.sourceEligible, true)
  h.imported.storeToURL = function (...args) { h.imported.pages[0].pageShapes[0] = monitoredChart('Chart 1').shape; return store.apply(this, args) }
  const replaced = h.exportChart().data.chartProof[0]
  assert.equal(replaced.sourceShapeName, undefined)
  assert.equal(replaced.sourceEligible, false, 'A replacement with the same label cannot inherit the former object identity')
})

for (const operation of ['select-page', 'move-page']) test(`only verified ${operation} can renew an unedited disposed native chart model`, async () => {
  const chart = monitoredChart('Chart 3'), h = await importedCharts(model => { model.pages[0].add(chart.shape); model.getDrawPages().insertNewByIndex(0) })
  const fresh = monitoredChart('Chart 1'), controller = h.imported.getCurrentController(), select = controller.setCurrentPage
  let replaced = false
  controller.setCurrentPage = function (page) {
    if (!replaced) { chart.model.dispose(); chart.shape.model = fresh.model; chart.shape.name = 'Chart 1'; replaced = true }
    return select.call(this, page)
  }
  const result = h.request('presentation-action', operation === 'select-page' ? { type: operation, pageIndex: 1 } : { type: operation, pageIndex: 0, direction: 'down' }, 'B')
  assert.equal(result.ok, true, result.error)
  const proof = h.exportChart().data.chartProof[0]
  assert.equal(proof.sourceEligible, true)
  assert.equal(proof.sourceShapeName, 'Chart 3')
  assert.equal(proof.shapeName, 'Chart 1')
  assert.equal(chart.listeners.size, 0)
  assert.equal(fresh.listeners.size, 1)
  fresh.model.edit(); fresh.model.modified = false
  assert.equal(h.exportChart().data.chartProof[0].sourceEligible, false, 'The replacement remains actively monitored')
})

for (const unsafe of ['previous-edit', 'outside-navigation', 'during-navigation-edit', 'replacement-without-dispose', 'dirty-replacement']) {
  test(`controlled navigation cannot renew chart proof after ${unsafe}`, async () => {
    const chart = monitoredChart(), h = await importedCharts(model => { model.pages[0].add(chart.shape); model.getDrawPages().insertNewByIndex(0) })
    const fresh = monitoredChart(), controller = h.imported.getCurrentController(), select = controller.setCurrentPage
    if (unsafe === 'previous-edit') { chart.model.edit(); chart.model.modified = false }
    if (unsafe === 'outside-navigation') { chart.model.dispose(); chart.shape.model = fresh.model }
    if (unsafe === 'dirty-replacement') fresh.model.modified = true
    controller.setCurrentPage = function (page) {
      if (unsafe === 'during-navigation-edit') { chart.model.edit(); chart.model.modified = false }
      if (unsafe !== 'replacement-without-dispose') chart.model.dispose()
      chart.shape.model = fresh.model
      return select.call(this, page)
    }
    const result = h.request('presentation-action', { type: 'select-page', pageIndex: 1 }, 'B')
    assert.equal(result.ok, true, result.error)
    const proof = h.exportChart().data.chartProof[0]
    assert.equal(proof.sourceEligible, false)
    assert.equal(proof.sourceShapeName, undefined)
    assert.equal(fresh.listeners.size, 0, 'No ineligible baseline is registered for future trust')
  })
}

test('chart listener installation failures consume native exceptions and cannot yield trusted evidence', async () => {
  const h = await engine({ kind: 'presentation', extension: 'pptx' }), chart = monitoredChart()
  const error = h.nativeException('chart listener unavailable')
  chart.model.addModifyListener = () => { throw error }
  h.controls.configureNextModel = model => model.pages[0].add(chart.shape)
  assert.equal(h.request('open', { id: 'B', name: 'B.pptx', kind: 'presentation', extension: 'pptx', path: '/tmp/b.pptx', isNew: false }).ok, true)
  assert.equal(h.request('export', { format: 'pptx' }, 'B').data.chartProof[0].sourceEligible, false)
  assert.equal(h.nativeExceptions.get(error).consumed, 1)
})

test('native chart Model errors are consumed; WASM traps fail exports rather than produce trusted output', async () => {
  for (const trapped of [false, true]) {
    const chart = monitoredChart(), h = await importedCharts(model => model.pages[0].add(chart.shape))
    const thrown = []
    const original = chart.shape.getPropertyValue
    chart.shape.getPropertyValue = function (name) {
      if (name !== 'Model') return original.call(this, name)
      const error = trapped ? new WebAssembly.RuntimeError('chart Model memory trap') : h.nativeException('chart Model unavailable')
      thrown.push(error); throw error
    }
    const exported = h.exportChart()
    assert.equal(exported.ok, !trapped)
    if (trapped) { assert.match(exported.error, /chart Model memory trap/); assert.equal(h.stores.length, 0); assert.equal(thrown.length, 1) }
    else {
      assert.equal(exported.data.chartProof[0].sourceEligible, false)
      for (const error of thrown) assert.equal(h.nativeExceptions.get(error).consumed, 1)
    }
  }
})

test('chart listeners are released when a presentation is replaced and on failed import setup', async () => {
  const chart = monitoredChart(), h = await importedCharts(model => model.pages[0].add(chart.shape))
  assert.equal(chart.listeners.size, 1)
  assert.equal(h.request('open', { id: 'C', name: 'C.docx', kind: 'word', extension: 'docx', isNew: true }, 'B').ok, true)
  assert.equal(chart.listeners.size, 0)
  assert.equal(chart.model.removed, 1)
  const first = monitoredChart('First'), second = monitoredChart('Second')
  second.model.addModifyListener = () => { throw new WebAssembly.RuntimeError('chart setup memory trap') }
  h.controls.configureNextModel = model => { model.pages[0].add(first.shape); model.pages[0].add(second.shape) }
  const failed = h.request('open', { id: 'D', name: 'D.pptx', kind: 'presentation', extension: 'pptx', path: '/tmp/d.pptx', isNew: false }, 'C')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /chart setup memory trap/)
  assert.equal(first.listeners.size, 0)
  assert.equal(first.model.removed, 1, 'Earlier chart listeners are removed exactly once if later setup traps')
  assert.equal(h.models.at(-1).closed, true)
  assert.equal(h.request('export', { format: 'docx' }, 'C').ok, true, 'The prior document survives failed setup')
})
