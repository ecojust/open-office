import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Exercise the actual worker's protocol with a deterministic UNO model. Real
// DOCX/XLSX/PPTX/ODP/PDF round trips run in the native WebView smoke test.
const source = await readFile(new URL('../public/office/office-worker.js', import.meta.url), 'utf8')
async function engine(initial = { kind: 'word', extension: 'docx' }) {
  const messages = [], models = [], imports = [], stores = []
  const controls = { failNextLoad: false, rejectNextService: false }
  class Value { constructor(value) { Object.assign(this, value) } }
  const frame = { registerDispatchProviderInterceptor(value) { this.interceptor = value }, releaseDispatchProviderInterceptor() {}, activate() {}, getContainerWindow: () => ({ setFocus() {} }) }
  const desktop = { loadComponentFromURL(url, target, flags, args) {
    imports.push({ url, target, args })
    // LibreOffice may reuse a clean untitled frame for _default and dispose its
    // model while loading. A transactional tab switch must keep it alive instead.
    if (target === '_default' && models.length) models.at(-1).closed = true
    if (controls.failNextLoad) { controls.failNextLoad = false; throw Error('Document import failed') }
    const serviceAccepted = !controls.rejectNextService; controls.rejectNextService = false
    const pages = [], shapes = []
    const makePage = () => ({ add(shape) { shapes.push(shape) }, getMasterPage: () => 'master', setMasterPage(value) { this.master = value },
      getPropertyValue(name) { return name === 'Number' ? pages.indexOf(this) + 1 : ({ Layout: 1, Width: 28000, Height: 15750 })[name] }, setPropertyValue(name, value) { this[name] = value } })
    pages.push(makePage())
    let activePage = pages[0]
    const presentation = { running: false, start() { this.running = true }, end() { this.running = false }, isRunning() { return this.running } }
    const model = { modified: false, closed: false, listener: null, services: [], shapes, pages,
      supportsService(name) { this.services.push(name); return serviceAccepted }, getText: () => ({ createTextCursor: () => ({ setPropertyValue() {} }) }),
      setModified(value) { if (this.closed) throw Error('Model already disposed'); this.modified = value }, isModified() { return this.modified },
      addModifyListener(listener) { this.listener = listener }, removeModifyListener() {}, close() { this.closed = true },
      getCurrentController: () => ({ getFrame: () => frame, getCurrentPage: () => activePage, setCurrentPage(value) { activePage = value },
        getActiveSheet: () => ({ getDrawPage: () => pages[0] }), getSelection: () => ({ getPosition: () => ({ X: 2000, Y: 3000 }) }) }),
      getDrawPages: () => ({ getCount: () => pages.length, insertNewByIndex(index) { const page = makePage(); pages.splice(index, 0, page); model.edit(); return page } }),
      getPresentation: () => presentation,
      createInstance: service => ({ service, setPropertyValue(name, value) { this[name] = value }, setSize(value) { this.size = value }, setPosition(value) { this.position = value } }),
      storeToURL(path, args) { stores.push({ path, args }); this.modified = false },
      edit(notify = true) { this.modified = true; if (notify) this.listener.modified() },
    }
    models.push(model); return model
  } }
  const css = { frame: { Desktop: { create: () => desktop }, DispatchHelper: { create: () => ({ executeDispatch() {} }) },
      XDispatchProviderInterceptor: 'interceptor', XInterceptorInfo: 'info', XDispatch: 'dispatch', FeatureStateEvent: Value },
    beans: { PropertyValue: Value }, task: { XInteractionHandler: 'handler', XInteractionAbort: 'abort' },
    document: { MacroExecMode: { NEVER_EXECUTE: 0 }, UpdateDocMode: { NO_UPDATE: 0 } }, util: { XModifyListener: 'listener' },
    graphic: { GraphicProvider: { create: () => ({ queryGraphic: () => ({ getPropertyValue: () => ({ Width: 1000, Height: 3000 }) }) }) } },
    awt: { Size: Value, Point: Value } }
  const port = { postMessage: message => messages.push(message) }
  const zeta = { uno: { com: { sun: { star: css } } }, getUnoComponentContext: () => ({}),
    unoObject: (_interfaces, object) => object, type: { short: 'short', interface: value => value },
    Any: class { constructor(type, value) { this.type = type; this.value = value } }, mainPort: port,
    catchUnoException(error) { throw error },
  }
  vm.runInNewContext(source, { Module: { zetajs: Promise.resolve(zeta) }, console })
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
  return { request, imports, stores, model: models[0], models, controls, messages, frame }
}

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
