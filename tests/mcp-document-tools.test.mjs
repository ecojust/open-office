import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogForKind, executeDocumentTool, summarizeMcpValue } from '../src/mcp/document-tools.ts'

const kinds = ['word','sheet','presentation','pdf','note','canvas','diagram','schedule']
function harness() {
 const calls = []
 let stopped = false
 const guard = () => { if (stopped) throw Error('stopped') }
 const handle = { async mcpExecute(name, args, check) { check(); calls.push({name,args}); return { revision: calls.length, dirty: true } } }
 return { handle, calls, guard, stop() { stopped = true } }
}
test('each editor advertises only bounded local tools, with read-only discovery and independent catalog values', () => {
 for (const kind of kinds) {
  const catalog = catalogForKind(kind)
  assert.equal(new Set(catalog.map(tool=>tool.name)).size,catalog.length)
  assert.ok(catalog.some(tool=>tool.annotations.readOnlyHint && tool.name !== 'document_inspect'))
  assert.ok(catalog.some(tool=>!tool.annotations.readOnlyHint && !tool.name.startsWith('document_')))
  for (const tool of catalog) {
   assert.equal(tool.inputSchema.additionalProperties,false)
   assert.equal(tool.annotations.openWorldHint,false)
   assert.equal(typeof tool.annotations.destructiveHint,'boolean')
   assert.doesNotMatch(tool.name,/file_open|file_save|shell|eval|javascript|fetch_url/)
  }
  catalog[0].name = 'tampered'
  assert.equal(catalogForKind(kind)[0].name,'document_inspect')
 }
})
test('dispatcher refuses other application tools, unadvertised commands and extra fields before reaching editor', async () => {
 const h=harness()
 for(const [kind,name,args] of [
  ['note','sheet_set_cell',{cell:'A1',input:'x'}], ['word','text.insert',{text:'x'}],
  ['word','word_insert_text',{text:'x',command:'file.open'}], ['canvas','canvas_add_shape',{shape:'image',text:'x'}],
  ['pdf','pdf_add_text',{text:'x',size:Infinity}], ['sheet','sheet_set_cell',{cell:'A0',input:'x'}],
  ['diagram','diagram_set_source',{source:'x'.repeat(50001)}], ['note','note_add_page',{title:''}],
  ['note','note_add_text',{text:'\u0000'}], ['word','word_insert_text',[]], ['word','word_insert_text',null],
  ['word','document_inspect',JSON.parse('{"__proto__":{"admin":true}}')],
 ]) await assert.rejects(executeDocumentTool(kind,h.handle,name,args,h.guard))
 assert.equal(h.calls.length,0)
})
test('sheet rectangle reads and cell writes stay within supported spreadsheet dimensions and bounded area', async () => {
 const h=harness()
 for(const range of ['A1:A1001','A1:ZZ10','Z1:A1','XFE1','XFD1048577']) await assert.rejects(executeDocumentTool('sheet',h.handle,'sheet_read_range',{range},h.guard))
 await executeDocumentTool('sheet',h.handle,'sheet_read_range',{range:'A1:J100',sheet:0},h.guard)
 await executeDocumentTool('sheet',h.handle,'sheet_set_cell',{cell:'XFD1048576',input:'=1+2'},h.guard)
 await assert.rejects(executeDocumentTool('sheet',h.handle,'sheet_set_cell',{cell:'ZZZ1',input:'x'},h.guard))
 assert.equal(h.calls.length,2)
})
test('complete editing entrypoints are discoverable and nested invalid edits never reach the engine', async () => {
 const h = harness()
 for (const kind of ['word', 'sheet', 'presentation', 'pdf']) {
  assert.ok(catalogForKind(kind).some(tool => tool.name === `${kind}_list_commands` && tool.annotations.readOnlyHint))
  assert.ok(catalogForKind(kind).some(tool => tool.name === `${kind}_execute_command` && !tool.annotations.readOnlyHint))
  await assert.rejects(executeDocumentTool(kind, h.handle, `${kind}_execute_command`, { command:'format.bold', params:JSON.parse('{"deep":{"__proto__":{"polluted":true}}}') },h.guard))
 }
 for (const [kind,name,args] of [
  ['note','note_edit',{operations:[{op:'page.delete',pageId:'p',unexpected:true}]}],
  ['canvas','canvas_edit',{operations:[{op:'update',id:'shape',patch:{style:{opacity:2}}}]}],
  ['diagram','diagram_update',{style:'not-a-style'}],
 ]) await assert.rejects(executeDocumentTool(kind,h.handle,name,args,h.guard))
 assert.equal(h.calls.length,0)
 await executeDocumentTool('word', h.handle, 'word_execute_command', {command:'format.set',params:{props:{bold:true,size:18}}},h.guard)
 assert.deepEqual(h.calls[0].args,{command:'format.set',params:{props:{bold:true,size:18}}})
})
test('scope is checked before dispatch and after async work, and missing handles never pretend success', async () => {
 const h=harness();h.stop()
 await assert.rejects(executeDocumentTool('word',h.handle,'document_inspect',{},h.guard),/stopped/)
 assert.equal(h.calls.length,0)
 await assert.rejects(executeDocumentTool('word',{},'document_inspect',{},()=>{}),/MCP/)
 const active=harness()
 active.handle.mcpExecute=async()=>{active.stop();return {text:'must not leak after scope change'}}
 await assert.rejects(executeDocumentTool('word',active.handle,'word_read',{},active.guard),/stopped/)
})
test('inspection removes binary images and local paths, rejects oversized output and preserves editable structures', async () => {
 const value=summarizeMcpValue({path:'/private/file',base64:'AAAA',ui:{dialog:'secret'},regions:[{text:'<img onerror=alert(1)>',dataUrl:'data:image/png;base64,AAA',imageData:'BBB',content:'a'.repeat(100001)}]})
 assert.deepEqual(Object.keys(value),['regions'])
 assert.equal(value.regions[0].text,'<img onerror=alert(1)>')
 assert.equal('dataUrl' in value.regions[0],false)
 assert.equal(value.regions[0].content.length,100001)
 assert.equal(summarizeMcpValue(Array.from({length:2000},(_,index)=>index)).length,2000)
 assert.deepEqual(summarizeMcpValue({ data: [[1, 2]], path: 'M 0 0 L 10 20', properties: { data: { type: 'string' }, path: { type: 'string' } } }), { data: [[1, 2]], path: 'M 0 0 L 10 20', properties: { data: { type: 'string' }, path: { type: 'string' } } })
 const h=harness();h.handle.mcpExecute=async()=>({texts:Array(80).fill('x'.repeat(100000))})
 await assert.rejects(executeDocumentTool('pdf',h.handle,'pdf_read',{},h.guard),/内容过多/)
})


test('schedule advertises its operations and dispatches only validated tools for the active document',async()=>{
 const h=harness()
 const catalog = catalogForKind('schedule')
 for (const name of ['document_inspect', 'document_undo', 'document_redo', 'schedule_read', 'schedule_edit', 'schedule_read_calendar', 'schedule_read_workload', 'schedule_set_view', 'schedule_import', 'schedule_export']) assert.ok(catalog.some(tool => tool.name === name), name)
 await executeDocumentTool('schedule',h.handle,'document_inspect',{},h.guard)
 await executeDocumentTool('schedule',h.handle,'schedule_read',{},h.guard)
 assert.deepEqual(h.calls.map(call => call.name), ['document_inspect', 'schedule_read'])
 await assert.rejects(executeDocumentTool('schedule',h.handle,'word_read',{},h.guard))
 await assert.rejects(executeDocumentTool('schedule',h.handle,'schedule_edit',{operations:[]},h.guard))
 await assert.rejects(executeDocumentTool('schedule',h.handle,'schedule_read',{path:'/private/project.ooschedule'},h.guard))
 assert.equal(h.calls.length,2)
 h.stop()
 await assert.rejects(executeDocumentTool('schedule',h.handle,'schedule_read',{},h.guard), /stopped/)
})

test('explicit schedule PNG export preserves only a bounded generated PNG; ordinary inspection still strips binary data', async () => {
 const h = harness()
 const png = { format:'png', mimeType:'image/png', encoding:'base64', base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhS8AAAAASUVORK5CYII=', width:1, height:1, scale:2 }
 h.handle.mcpExecute = async () => ({ ...png, path:'/private/project.png', ui:{secret:true}, additional:'not part of the export' })
 assert.deepEqual(await executeDocumentTool('schedule', h.handle, 'schedule_export', {format:'png'}, h.guard), png)
 const inspected = await executeDocumentTool('schedule', h.handle, 'schedule_read', {}, h.guard)
 assert.equal('base64' in inspected, false); assert.equal('path' in inspected, false); assert.equal('ui' in inspected, false)
 for (const invalid of [
  {...png,mimeType:'text/html'}, {...png,encoding:'url'}, {...png,base64:'https://example.com/image.png'},
  {...png,width:2}, {...png,height:0}, {...png,width:16385}, {...png,width:16000,height:16000},
  {...png,scale:Infinity}, {...png,scale:0}, {...png,scale:3},
  {...png,base64:'not-a-png'.repeat(100)}, {...png,base64:png.base64.replace('iVBOR', 'aVBOR')},
  {...png,base64:png.base64.slice(0,-2)+'J='},
 ]) {
  h.handle.mcpExecute = async () => invalid
  await assert.rejects(executeDocumentTool('schedule',h.handle,'schedule_export',{format:'png'},h.guard), /PNG/)
 }
 h.handle.mcpExecute = async () => ({...png,base64:'A'.repeat(7 * 1024 * 1024 + 1)})
 await assert.rejects(executeDocumentTool('schedule',h.handle,'schedule_export',{format:'png'},h.guard), /7 MiB/)
 h.handle.mcpExecute = async () => { h.stop(); return png }
 await assert.rejects(executeDocumentTool('schedule',h.handle,'schedule_export',{format:'png'},h.guard), /stopped/)
})
