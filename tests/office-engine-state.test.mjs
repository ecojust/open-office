import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Exercise the actual worker's protocol with a deterministic UNO model. Real
// DOCX/XLSX/PDF round trips run in the native WebView smoke test.
const source = await readFile(new URL('../public/office/office-worker.js', import.meta.url), 'utf8')
async function engine() {
  const messages = [], models = [], imports = [], stores = []
  class Value { constructor(value) { Object.assign(this, value) } }
  const frame = { registerDispatchProviderInterceptor(value) { this.interceptor = value }, releaseDispatchProviderInterceptor() {}, activate() {}, getContainerWindow: () => ({ setFocus() {} }) }
  const desktop = { loadComponentFromURL(url, target, flags, args) {
    imports.push({ url, args })
    const model = { modified: false, listener: null,
      supportsService: () => true, getText: () => ({ createTextCursor: () => ({ setPropertyValue() {} }) }),
      setModified(value) { this.modified = value }, isModified() { return this.modified },
      addModifyListener(listener) { this.listener = listener }, removeModifyListener() {}, close() {},
      getCurrentController: () => ({ getFrame: () => frame }),
      storeToURL(path, args) { stores.push({ path, args }); this.modified = false },
      edit(notify = true) { this.modified = true; if (notify) this.listener.modified() },
    }
    models.push(model); return model
  } }
  const css = { frame: { Desktop: { create: () => desktop }, DispatchHelper: { create: () => ({ executeDispatch() {} }) },
      XDispatchProviderInterceptor: 'interceptor', XInterceptorInfo: 'info', XDispatch: 'dispatch', FeatureStateEvent: Value },
    beans: { PropertyValue: Value }, task: { XInteractionHandler: 'handler', XInteractionAbort: 'abort' },
    document: { MacroExecMode: { NEVER_EXECUTE: 0 }, UpdateDocMode: { NO_UPDATE: 0 } }, util: { XModifyListener: 'listener' } }
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
  assert.equal(request('open', { id: 'A', name: 'A.docx', kind: 'word', extension: 'docx', isNew: true }).ok, true)
  return { request, imports, stores, model: models[0], messages, frame }
}

test('office imports disable macros and external updates independently of profile', async () => {
  const { imports } = await engine()
  const args = Object.fromEntries(imports[0].args.map(item => [item.Name, item.Value]))
  assert.equal(args.MacroExecutionMode.type, 'short')
  assert.equal(args.MacroExecutionMode.value, 0)
  assert.equal(args.UpdateDocMode.value, 0)
  assert.ok(args.InteractionHandler.handle)
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
