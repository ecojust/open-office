import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogForKind, executeDocumentTool, summarizeMcpValue } from '../src/mcp/document-tools.ts'

const kinds = ['word','sheet','presentation','pdf','note','canvas','diagram']
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
   assert.equal(tool.annotations.destructiveHint,false)
   assert.doesNotMatch(tool.name,/delete|file|execute|command|script|url/)
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
test('scope is checked before dispatch and after async work, and missing handles never pretend success', async () => {
 const h=harness();h.stop()
 await assert.rejects(executeDocumentTool('word',h.handle,'document_inspect',{},h.guard),/stopped/)
 assert.equal(h.calls.length,0)
 await assert.rejects(executeDocumentTool('word',{},'document_inspect',{},()=>{}),/MCP/)
 const active=harness()
 active.handle.mcpExecute=async()=>{active.stop();return {text:'must not leak after scope change'}}
 await assert.rejects(executeDocumentTool('word',active.handle,'word_read',{},active.guard),/stopped/)
})
test('inspection removes binary images and local paths, bounds output and preserves literal plain text', async () => {
 const value=summarizeMcpValue({path:'/private/file',base64:'AAAA',ui:{dialog:'secret'},regions:[{text:'<img onerror=alert(1)>',dataUrl:'data:image/png;base64,AAA',imageData:'BBB',content:'a'.repeat(100001)}]})
 assert.deepEqual(Object.keys(value),['regions'])
 assert.equal(value.regions[0].text,'<img onerror=alert(1)>')
 assert.equal('dataUrl' in value.regions[0],false)
 assert.ok(value.regions[0].content.length<100100)
 assert.equal(summarizeMcpValue(Array.from({length:2000},(_,index)=>index)).length,1000)
 const h=harness();h.handle.mcpExecute=async()=>({texts:Array(20).fill('x'.repeat(100000))})
 await assert.rejects(executeDocumentTool('pdf',h.handle,'pdf_read',{},h.guard),/内容过多/)
})
