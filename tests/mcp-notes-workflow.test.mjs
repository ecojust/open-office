import test from 'node:test'
import assert from 'node:assert/strict'
import { NotebookSession } from '../src/notes/session.ts'
import { editNotebook, findNotePage } from '../src/notes/mcp.ts'
import { WorkflowSession } from '../src/workflow/session.ts'
import { createDocument, parseDocument } from '../src/workflow/core/documents.ts'
import { editCanvas, updateDiagram } from '../src/workflow/mcp.ts'
import { decodeNotebook } from '../src/notes/model.ts'
import { DIAGRAM_TEMPLATES } from '../src/workflow/core/diagrams/catalog.ts'
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKFcAAAAASUVORK5CYII='
const noteEdit = (session, operations) => session.change(copy => editNotebook(copy,operations))
const canvasEdit = (session, operations) => session.change(copy => editCanvas(copy,operations))

 test('MCP notebook edits sections, nested pages, rich text, images and geometry as one undoable transaction', () => {
 const session = new NotebookSession(), before = structuredClone(session.model)
 noteEdit(session,[
  {op:'notebook.rename',title:'团队笔记'},
  {op:'section.add',id:'section_new',title:'项目'},
  {op:'page.add',sectionId:'section_new',id:'parent',title:'项目计划'},
  {op:'page.add',sectionId:'section_new',id:'child',parentId:'parent',title:'设计'},
  {op:'region.add',pageId:'child',region:{id:'text_region',x:100,y:140,width:320,blocks:[{id:'h',type:'heading',level:2,content:[{text:'设计要求',marks:['bold','italic']}]},{id:'todo',type:'todo',checked:true,content:[{text:'审核'}]}]}},
  {op:'region.add',pageId:'child',region:{id:'image_region',x:460,y:140,width:240,height:180,blocks:[{id:'image',type:'image',dataUrl:png,alt:'草图'}]}},
  {op:'region.update',regionId:'image_region',patch:{x:500,width:400,height:300}},
 ])
 assert.equal(session.inspect().revision,1); assert.equal(session.inspect().dirty,true)
 const child = findNotePage(session.model,'child').page
 assert.equal(child.parentId,'parent'); assert.deepEqual(child.regions[1].blocks[0].content[0].marks,['bold','italic']); assert.equal(child.regions[2].width,400); assert.equal(child.regions[2].blocks[0].dataUrl,png)
 const saved = session.export().bytes
 assert.deepEqual(decodeNotebook(saved),session.model)
 session.undo(); assert.deepEqual(session.model,before); session.redo(); assert.equal(findNotePage(session.model,'child').page.regions[2].height,300)
 })

test('MCP notebook moves subtrees across sections, reorders content and deletes with valid empty replacements', () => {
 const session = new NotebookSession(), originalSection = session.model.sections[0].id
 noteEdit(session,[{op:'section.add',id:'second',title:'第二分区'},{op:'page.add',sectionId:originalSection,id:'p',title:'父'},{op:'page.add',sectionId:originalSection,id:'c',title:'子',parentId:'p'},{op:'page.move',pageId:'p',sectionId:'second',index:0}])
 assert.equal(findNotePage(session.model,'c').section.id,'second')
 noteEdit(session,[{op:'region.add',pageId:'p',region:{id:'r',x:100,y:100,width:200}},{op:'region.move',regionId:'r',pageId:'c',index:0},{op:'section.move',sectionId:'second',index:0},{op:'page.rename',pageId:'c',title:'新的子页面'}])
 assert.equal(session.model.sections[0].id,'second'); assert.equal(findNotePage(session.model,'c').page.regions[0].id,'r')
 noteEdit(session,[{op:'page.delete',pageId:'p'},{op:'section.delete',sectionId:originalSection},{op:'section.delete',sectionId:'second'}])
 assert.equal(session.model.sections.length,1); assert.equal(session.model.sections[0].pages.length,1)
})

test('MCP notebook rejects invalid late operations atomically without dirty/history changes', () => {
 for (const bad of [
  {op:'page.move',pageId:'parent',sectionId:'s',parentId:'child'},
  {op:'region.update',regionId:'r',patch:{x:19999,width:500}},
  {op:'region.add',pageId:'parent',region:{id:'evil',x:0,y:0,width:100,height:100,blocks:[{id:'image',type:'image',dataUrl:'https://example.com/a.png',alt:'bad'}]}},
  {op:'page.add',sectionId:'s',id:'parent',title:'重复ID'},
 ]) {
  const session = new NotebookSession()
  noteEdit(session,[{op:'section.add',id:'s',title:'S'},{op:'page.add',sectionId:'s',id:'parent',title:'父'},{op:'page.add',sectionId:'s',id:'child',parentId:'parent',title:'子'},{op:'region.add',pageId:'parent',region:{id:'r',x:0,y:0,width:100}}])
  const before = structuredClone(session.model), state = session.inspect()
  assert.throws(()=>noteEdit(session,[{op:'notebook.rename',title:'不应留下'},bad]))
  assert.deepEqual(session.model,before); assert.deepEqual(session.inspect(),state)
 }
})

const shape = (id,x=40,y=40) => ({type:'shape',id,shape:'rectangle',x,y,width:200,height:100,text:id})
test('MCP canvas supports all element kinds, styles, binding, duplicate, ordering and one-step history', () => {
 const session = new WorkflowSession(createDocument('board')), before = structuredClone(session.model)
 canvasEdit(session,[
  {op:'add',element:{id:'link',type:'edge',from:{x:0,y:0,nodeId:'a'},to:{x:0,y:0,nodeId:'b'},label:'连接'}},
  {op:'add',element:shape('a')},{op:'add',element:shape('b',400)},
  {op:'add',element:{id:'ink',type:'stroke',points:[{x:0,y:0},{x:30,y:80},{x:60,y:0}],pressures:[.2,.5,.8],brush:'highlighter',style:{opacity:.35,stroke:'#ffaa00'}}},
  {op:'add',element:{...shape('image',700),shape:'image',imageData:png}},
  {op:'update',id:'a',patch:{text:'更新后的文字',cornerRadius:20,style:{fill:'#ddddff',fontSize:32}}},
  {op:'move',ids:['a','b'],dx:50,dy:100},
  {op:'settings',title:'MCP画布',background:'#ffffee',grid:false,defaultStyle:{stroke:'#112233'}},
 ])
 assert.equal(session.inspect().revision,1); assert.equal(session.model.scene.elements.find(e=>e.id==='a').x,90); assert.equal(session.model.scene.elements[0].route,'straight')
 assert.equal(session.model.scene.elements.find(e=>e.id==='a').style.fill,'#ddddff')
 assert.deepEqual(parseDocument(new TextDecoder().decode(session.export().bytes)),session.model)
 session.undo(); assert.deepEqual(session.model,before); session.redo()
 canvasEdit(session,[{op:'group',ids:['a','b']},{op:'duplicate',ids:['a','b','link']},{op:'reorder',ids:['a'],order:'front'}])
 assert.equal(session.model.scene.elements.at(-1).id,'a'); assert.equal(session.model.scene.elements.length,8)
 const duplicatedEdge = session.model.scene.elements.find(e=>e.type==='edge'&&e.id!=='link')
 assert.notEqual(duplicatedEdge.from.nodeId,'a'); assert.ok(session.model.scene.elements.some(e=>e.id===duplicatedEdge.from.nodeId))
})

test('MCP canvas preserves image payloads on updates, respects locks, detaches locked connectors on deletion', () => {
 const session = new WorkflowSession(createDocument('board'))
 canvasEdit(session,[{op:'add',element:{...shape('image'),shape:'image',imageData:png}},{op:'add',element:shape('b',400)},{op:'add',element:{id:'link',type:'edge',from:{x:0,y:0,nodeId:'image'},to:{x:0,y:0,nodeId:'b'},locked:true}}])
 canvasEdit(session,[{op:'update',id:'image',patch:{width:320,style:{opacity:.8}}}]); assert.equal(session.model.scene.elements[0].imageData,png)
 const before = structuredClone(session.model), state = session.inspect()
 assert.throws(()=>canvasEdit(session,[{op:'update',id:'image',patch:{text:'不会保存'}},{op:'update',id:'link',patch:{label:'已锁定'}}]),/解锁/)
 assert.deepEqual(session.model,before); assert.deepEqual(session.inspect(),state)
 canvasEdit(session,[{op:'delete',ids:['image']}]); const edge = session.model.scene.elements.find(e=>e.id==='link')
 assert.equal(edge.locked,true); assert.equal(edge.from.nodeId,undefined); assert.equal(edge.to.nodeId,'b')
})

test('MCP canvas validates invalid references/images/geometry as one transaction and supports layout/templates', () => {
 const session = new WorkflowSession(createDocument('board'))
 for (const element of [{...shape('image'),shape:'image',imageData:'file:///private/a.png'},{...shape('a'),width:-1},{id:'e',type:'edge',from:{x:0,y:0,nodeId:'missing'},to:{x:1,y:1}}]) {
  assert.throws(()=>canvasEdit(session,[{op:'add',element:shape('valid')},{op:'add',element}]))
  assert.equal(session.model.scene.elements.length,0); assert.equal(session.inspect().dirty,false)
 }
 canvasEdit(session,[{op:'template',templateId:'kanban',x:100,y:100},{op:'layout',direction:'LR'}])
 assert.ok(session.model.scene.elements.length>5)
 assert.throws(()=>canvasEdit(session,[{op:'template',templateId:'missing'}]))
})

test('MCP diagram updates source, styles, title and templates atomically; invalid syntax never damages prior preview', () => {
 const session = new WorkflowSession(createDocument('mermaid')), source = 'sequenceDiagram\n Alice->>Bob: 实时同步'
 session.change(copy=>updateDiagram(copy,{source,style:'blueprint',title:'更新后的图表'}))
 assert.equal(session.model.source,source); assert.equal(session.model.diagramStyle,'blueprint'); assert.equal(session.model.title,'更新后的图表')
 const before = structuredClone(session.model), state = session.inspect()
 for (const bad of [{source:'invalid diagram',title:'不应保存'},{style:'unknown'},{source,templateId:DIAGRAM_TEMPLATES[0].id}]) assert.throws(()=>session.change(copy=>updateDiagram(copy,bad)))
 assert.deepEqual(session.model,before); assert.deepEqual(session.inspect(),state)
 session.change(copy=>updateDiagram(copy,{templateId:DIAGRAM_TEMPLATES[0].id,style:'forest'})); assert.equal(session.model.source,DIAGRAM_TEMPLATES[0].source)
 session.undo(); assert.deepEqual(session.model,before)
})

test('MCP structured edit schemas reject unknown nested fields, invalid geometry, unsafe mark names and oversized batches', async () => {
 const { noteEditingTools, canvasEditingTools } = await import('../src/mcp/notes-workflow-tools.ts')
 const { validateToolArguments } = await import('../src/mcp/tool-schema.ts')
 const note = noteEditingTools.find(tool=>tool.name==='note_edit').inputSchema, canvas = canvasEditingTools.find(tool=>tool.name==='canvas_edit').inputSchema
 assert.deepEqual(validateToolArguments(note,{operations:[{op:'region.update',regionId:'r',patch:{height:null,width:200}}]}).operations[0].patch,{height:null,width:200})
 for (const raw of [
  {operations:[{op:'section.add',title:'Test',file:'/tmp/secret'}]},
  {operations:[{op:'region.update',regionId:'r',patch:{width:-1}}]},
  {operations:[{op:'region.add',pageId:'p',region:{x:0,y:0,width:200,blocks:[{id:'b',type:'paragraph',content:[{text:'x',marks:['script']}]}]}}]},
  {operations:Array.from({length:101},()=>({op:'notebook.rename',title:'x'}))},
 ]) assert.throws(()=>validateToolArguments(note,raw))
 assert.equal(validateToolArguments(canvas,{operations:[{op:'update',id:'a',patch:{groupId:null,style:{opacity:.4}}}]}).operations[0].patch.style.opacity,.4)
 for (const raw of [
  {operations:[{op:'add',element:{type:'shape',shape:'iframe',x:0,y:0}}]},
  {operations:[{op:'update',id:'a',patch:{id:'b'}}]},
  {operations:[{op:'update',id:'a',patch:{style:{onclick:'bad'}}}]},
  {operations:[{op:'add',element:{type:'stroke',points:[{x:0,y:Infinity}]}}]},
 ]) assert.throws(()=>validateToolArguments(canvas,raw))
})

test('MCP canvas dashed legacy styles take effect and type-incompatible updates roll back', () => {
 const session = new WorkflowSession(createDocument('board'))
 canvasEdit(session,[{op:'add',element:{...shape('a'),style:{dashed:true}}}])
 assert.equal(session.model.scene.elements[0].style.strokePattern,'dashed')
 canvasEdit(session,[{op:'update',id:'a',patch:{style:{dashed:false}}}])
 assert.equal(session.model.scene.elements[0].style.strokePattern,'solid')
 const before = structuredClone(session.model)
 assert.throws(()=>canvasEdit(session,[{op:'update',id:'a',patch:{label:'不是连线'}}]),/类型/)
 assert.throws(()=>canvasEdit(session,[{op:'update',id:'a',patch:{style:{fill:'url(https://example.com/a)'}}}]),/颜色/)
 assert.deepEqual(session.model,before)
})

test('MCP new canvas elements inherit current document defaults while explicit properties take precedence', () => {
 const session = new WorkflowSession(createDocument('board'))
 canvasEdit(session,[{op:'settings',defaultStyle:{stroke:'#147d65',strokeWidth:6,roughness:'sketch',strokePattern:'dotted',opacity:.7}}])
 const before = structuredClone(session.model)
 canvasEdit(session,[
  {op:'add',element:shape('shape-default')},
  {op:'add',element:{type:'edge',id:'edge-default',from:{x:0,y:0},to:{x:120,y:80}}},
  {op:'add',element:{type:'stroke',id:'stroke-override',points:[{x:0,y:0},{x:20,y:30}],style:{stroke:'#ff4400',dashed:false}}},
 ])
 for (const element of session.model.scene.elements) {
  assert.equal(element.style.strokeWidth,6)
  assert.equal(element.style.roughness,'sketch')
  assert.equal(element.style.opacity,.7)
  assert.equal(element.style.stroke,element.id==='stroke-override'?'#ff4400':'#147d65')
  assert.equal(element.style.strokePattern,element.id==='stroke-override'?'solid':'dotted')
 }
 session.undo(); assert.deepEqual(session.model,before)
 session.redo(); assert.equal(session.model.scene.elements[0].style.stroke,'#147d65')
})
