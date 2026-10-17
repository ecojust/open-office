import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as model from '../src/notes/model.ts'
import * as dom from '../src/notes/dom.ts'
import * as searchHelpers from '../src/notes/search.ts'
import { NotebookSession } from '../src/notes/session.ts'
import * as documentHelpers from '../src/shared/document.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKFcAAAAASUVORK5CYII='
function text(session, value) { session.change(copy => { copy.sections[0].pages[0].regions[0].blocks[0].content = [{ text: value, marks: ['bold'] }] }) }

test('notebook Unicode, rich marks, todos and local images round-trip through a versioned UTF-8 file', () => {
 const value = model.createNotebook('中文😀笔记')
 value.sections[0].pages[0].regions[0].blocks = [
  { id: model.noteId(), type:'heading', level:2, content:[{ text:'标题', marks:['bold','italic','bold'] }] },
  { id:model.noteId(), type:'todo', checked:true, content:[{text:'已完成😀'}] },
 ]
 value.sections[0].pages[0].regions.push({id:model.noteId(),x:600,y:100,width:200,height:160,blocks:[{id:model.noteId(),type:'image',dataUrl:png,alt:'测试图片'}]})
 const bytes = model.encodeNotebook(value), decoded = model.decodeNotebook(bytes)
 assert.equal(decoded.title,'中文😀笔记'); assert.deepEqual(decoded.sections[0].pages[0].regions[0].blocks[0].content[0].marks,['bold','italic'])
 assert.equal(decoded.sections[0].pages[0].regions[0].blocks[1].checked,true)
 assert.equal(decoded.sections[0].pages[0].regions[1].blocks[0].dataUrl,png)
 assert.deepEqual(model.decodeNotebook(new Uint8Array([239,187,191,...bytes])),decoded)
 assert.equal(model.noteTitle('😀'.repeat(200)).length,400)
 assert.throws(()=>model.noteTitle('😀'.repeat(201)),/过长/)
})

test('notebook rejects corrupt bytes, incompatible versions, duplicate identities and structural overflow before adoption', () => {
 for (const bytes of [new Uint8Array(),new Uint8Array([255]),new TextEncoder().encode('{bad')]) assert.throws(()=>model.decodeNotebook(bytes))
 for (const change of [v=>v.version=3,v=>v.format='other',v=>v.sections=[],v=>v.sections[0].pages=[],v=>v.sections[0].id=v.id,v=>v.sections[0].pages[0].regions[0].blocks=[],v=>v.sections[0].pages[0].regions[0].blocks[0].content=[{text:'x',marks:['onclick']}],v=>v.sections[0].title='a'.repeat(201)]) {
  const value=model.createNotebook(); change(value); assert.throws(()=>model.validateNotebook(value))
 }
 const value=model.createNotebook(); value.sections=Array.from({length:101},()=>({id:model.noteId(),title:'x',pages:[model.blankPage()]})); assert.throws(()=>model.validateNotebook(value))
})

test('notebook raster whitelist rejects remote, SVG, mislabeled, malformed and oversized payloads', () => {
 for (const image of ['https://example.com/image.png','data:image/svg+xml;base64,PHN2Zz4=',png.replace('image/png','image/jpeg'),'data:image/png;base64,YmFk','data:image/png;base64,'+'A'.repeat(6*1024*1024)]) assert.throws(()=>model.validateImage(image))
 const source=JSON.parse(JSON.stringify(model.createNotebook())); source.onclick='evil'; source.sections[0].style='url(evil)'; source.sections[0].pages[0].regions[0].blocks[0].content=[{text:'safe',onclick:'evil'}]
 const result=model.validateNotebook(source); assert.equal(result.onclick,undefined); assert.equal(result.sections[0].style,undefined); assert.deepEqual(result.sections[0].pages[0].regions[0].blocks[0].content,[{text:'safe'}])
})

test('save receipts protect newer edits and never mutate history or acknowledge different bytes', () => {
 const session=new NotebookSession(); assert.equal(session.inspect().dirty,false)
 text(session,'first'); const first=session.export()
 text(session,'second'); assert.throws(()=>session.markSaved(first.bytes),/又有修改/); assert.equal(session.inspect().dirty,true)
 const second=session.export(); assert.throws(()=>session.markSaved(first.bytes),/又有修改/)
 const revision=session.revision; session.markSaved(second.bytes); assert.equal(session.revision,revision); assert.equal(session.inspect().dirty,false)
 assert.equal(session.undo(),true); assert.equal(session.inspect().dirty,true)
 assert.equal(session.redo(),true); assert.equal(session.inspect().dirty,false)
 assert.throws(()=>session.markSaved(second.bytes),/又有修改/)
 const third=session.export(); session.markSaved(third.bytes); assert.equal(session.inspect().dirty,false)
 const reopened=new NotebookSession(third.bytes); assert.equal(reopened.model.sections[0].pages[0].regions[0].blocks[0].content[0].text,'second')
})

test('failed model changes preserve document, revision, history and the previous save receipt', () => {
 const session=new NotebookSession(); text(session,'safe'); const exported=session.export(); const before=session.inspect()
 assert.throws(()=>session.change(copy=>{copy.sections=[]})); assert.deepEqual(session.inspect(),before)
 assert.equal(session.model.sections[0].pages[0].regions[0].blocks[0].content[0].text,'safe'); session.markSaved(exported.bytes)
 session.change(copy=>{copy.title='new'}); session.undo(); session.change(copy=>{copy.title='different'}); assert.equal(session.redo(),false)
})

function legacyNotebook(blocks = [{id:'text_a',type:'paragraph',content:[{text:'旧内容'}]}]) {
 return {format:'open-office-notebook',version:1,id:'book',title:'旧笔记',sections:[{id:'section',title:'分区',pages:[{id:'page',title:'页面',blocks}]}]}
}
test('v1 migration preserves text runs, image content and identities in independent stable regions', () => {
 const blocks = [
  {id:'region_page_1',type:'heading',level:1,content:[{text:'旧标题',marks:['bold']}]},
  {id:'todo_a',type:'todo',checked:true,content:[{text:'查找跨区域文字'}]},
  {id:'image_a',type:'image',dataUrl:png,alt:'原始图片'},
  {id:'text_b',type:'paragraph',content:[{text:'图片之后',marks:['italic']}]},
  {id:'image_b',type:'image',dataUrl:png,alt:'第二张图片'},
 ]
 const source=legacyNotebook(blocks), before=JSON.stringify(source)
 const migrated=model.validateNotebook(source), page=migrated.sections[0].pages[0]
 assert.equal(migrated.version,2);assert.equal(JSON.stringify(source),before,'Migration must not mutate the source')
 assert.deepEqual(page.regions.map(region=>region.blocks.length),[2,1,1,1]);assert.deepEqual(page.regions.flatMap(region=>region.blocks),blocks)
 assert.ok(page.regions.every((region,index)=>index===0||region.y>page.regions[index-1].y))
 assert.notEqual(page.regions[0].id,blocks[0].id,'Generated region IDs must not collide with existing IDs')
 assert.deepEqual(model.validateNotebook(source),migrated,'Migration must be deterministic for original file identity')
 assert.deepEqual(model.decodeNotebook(model.encodeNotebook(migrated)),migrated)
 assert.equal(model.pageText(page),'页面\n旧标题\n查找跨区域文字\n原始图片\n图片之后\n第二张图片')
})

test('large legacy pages retain every region within reachable canvas bounds', () => {
 const blocks=Array.from({length:400},(_,index)=>({id:`image_${index}`,type:'image',dataUrl:png,alt:`图片${index}`}))
 const migrated=model.validateNotebook(legacyNotebook(blocks)), regions=migrated.sections[0].pages[0].regions
 assert.equal(regions.length,blocks.length);assert.deepEqual(regions.flatMap(region=>region.blocks),blocks)
 assert.ok(regions.some(region=>region.x>24),'Large migration must use more than one canvas column')
 assert.deepEqual(model.validateNotebook(migrated),migrated)
})

test('legacy layout reserves the full height of long CJK and explicit multiline text before an image', () => {
 const source=legacyNotebook([
  {id:'long_text',type:'paragraph',content:[{text:'中文'.repeat(1000)+'\n\n'+Array.from({length:50},()=> '新一行').join('\n')}]},
  {id:'after_text',type:'image',dataUrl:png,alt:'文字下方图片'},
 ])
 const regions=model.validateNotebook(source).sections[0].pages[0].regions
 // At 15px font size, 480px minus padding fits at most 30 CJK glyphs per line.
 // Explicit line breaks add another 52 lines; do not cap this run at 1600px.
 assert.equal(regions[1].x,regions[0].x)
 assert.ok(regions[1].y-regions[0].y >= (Math.ceil(2000/30)+52)*28)
 assert.equal(regions[0].blocks[0].content[0].text,source.sections[0].pages[0].blocks[0].content[0].text)
})

test('legacy open starts clean and subsequent layout edits use the same undo and exact-save receipt rules', () => {
 const session=new NotebookSession(new TextEncoder().encode(JSON.stringify(legacyNotebook())))
 assert.equal(session.model.version,2);assert.equal(session.inspect().dirty,false);assert.equal(session.revision,0)
 const migrated=JSON.stringify(session.model), first=session.export()
 session.change(copy=>{const region=copy.sections[0].pages[0].regions[0];region.x=300;region.y=240;region.width=360})
 assert.equal(session.inspect().dirty,true);assert.equal(session.revision,1);assert.throws(()=>session.markSaved(first.bytes),/又有修改/)
 const changed=JSON.stringify(session.model)
 assert.equal(session.undo(),true);assert.equal(JSON.stringify(session.model),migrated);assert.equal(session.inspect().dirty,false)
 assert.equal(session.redo(),true);assert.equal(JSON.stringify(session.model),changed)
 const saved=session.export();session.markSaved(saved.bytes);assert.equal(session.inspect().dirty,false)
 const reopened=new NotebookSession(saved.bytes);assert.equal(reopened.inspect().dirty,false);assert.deepEqual(reopened.model,session.model)
})

test('region geometry rejects non-finite, coercible, too-small and off-canvas values before mutation', () => {
 const edits = [
  region=>region.x=-1,region=>region.y=-0.01,region=>region.x=NaN,region=>region.width=Infinity,
  region=>region.width='480',region=>region.y=null,region=>region.height=false,
  region=>region.width=model.NOTE_MIN_REGION_WIDTH-1,region=>region.height=model.NOTE_MIN_REGION_HEIGHT-1,
  region=>region.x=model.NOTE_MAX_CANVAS,region=>region.y=model.NOTE_MAX_CANVAS,
  region=>region.height=model.NOTE_MAX_CANVAS,region=>region.width=model.NOTE_MAX_CANVAS,
 ]
 for (const edit of edits) {
  const session=new NotebookSession(), before=JSON.stringify(session.model), snapshot=session.inspect()
  assert.throws(()=>session.change(copy=>edit(copy.sections[0].pages[0].regions[0])),/区域/)
  assert.equal(JSON.stringify(session.model),before);assert.deepEqual(session.inspect(),snapshot)
 }
 const value=model.createNotebook(), region=value.sections[0].pages[0].regions[0]
 Object.assign(region,{x:model.NOTE_MAX_CANVAS-80,y:model.NOTE_MAX_CANVAS-40,width:80,height:40})
 assert.deepEqual(model.decodeNotebook(model.encodeNotebook(value)),value)
 const duplicate=model.blankRegion();duplicate.id=region.id;value.sections[0].pages[0].regions.push(duplicate)
 assert.throws(()=>model.validateNotebook(value),/重复/)
})

test('images are isolated regions and dimensions survive round-trip without changing image bytes', () => {
 const value=model.createNotebook(), page=value.sections[0].pages[0]
 const image={id:model.noteId(),x:220.5,y:900.25,width:240.5,height:180.25,blocks:[{id:model.noteId(),type:'image',dataUrl:png,alt:'缩放图片'}]}
 page.regions.push(image)
 assert.deepEqual(model.decodeNotebook(model.encodeNotebook(value)).sections[0].pages[0].regions[1],image)
 delete image.height;assert.throws(()=>model.validateNotebook(value),/完整尺寸/);image.height=180.25
 image.blocks.push(model.blankBlock());assert.throws(()=>model.validateNotebook(value),/独立区域/)
 image.blocks.pop();image.blocks.push({...image.blocks[0],id:model.noteId()});assert.throws(()=>model.validateNotebook(value),/独立区域/)
 page.regions=[];assert.throws(()=>model.validateNotebook(value),/数量/)
})

test('subpages use stable preorder and descendant deletion can be undone as one edit', () => {
 const session=new NotebookSession(), parent=session.model.sections[0].pages[0]
 const child=model.blankPage('子页面'), grandchild=model.blankPage('孙页面'), sibling=model.blankPage('另一个页面')
 child.parentId=parent.id;grandchild.parentId=child.id
 session.change(copy=>{copy.sections[0].pages=[grandchild,parent,sibling,child]})
 const pages=session.model.sections[0].pages
 assert.deepEqual(model.pageHierarchy(pages).map(({page,depth})=>[page.title,depth]),[['无标题页面',0],['子页面',1],['孙页面',2],['另一个页面',0]])
 assert.deepEqual([...model.descendantPageIds(pages,parent.id)].sort(),[parent.id,child.id,grandchild.id].sort())
 const bytes=session.export().bytes
 assert.deepEqual(model.decodeNotebook(bytes).sections[0].pages,pages)
 session.change(copy=>{const section=copy.sections[0], removed=model.descendantPageIds(section.pages,parent.id);section.pages=section.pages.filter(page=>!removed.has(page.id))})
 assert.deepEqual(session.model.sections[0].pages,[sibling]);session.undo();assert.deepEqual(session.model.sections[0].pages,pages)
})

test('subpage validation rejects missing or cross-section parents, cycles and excessive nesting', () => {
 const value=model.createNotebook(), pages=value.sections[0].pages, root=pages[0]
 root.parentId='missing';assert.throws(()=>model.validateNotebook(value),/同一分区/)
 root.parentId=root.id;assert.throws(()=>model.validateNotebook(value),/循环/)
 delete root.parentId
 const other=model.blankPage('另一区页面');value.sections.push({id:model.noteId(),title:'另一区',pages:[other]})
 root.parentId=other.id;assert.throws(()=>model.validateNotebook(value),/同一分区/);delete root.parentId
 for(let depth=1;depth<model.NOTE_MAX_PAGE_DEPTH;depth++){const page=model.blankPage(`第${depth}层`);page.parentId=pages.at(-1).id;pages.push(page)}
 assert.equal(model.pageHierarchy(model.validateNotebook(value).sections[0].pages).at(-1).depth,model.NOTE_MAX_PAGE_DEPTH-1)
 const tooDeep=model.blankPage('超深');tooDeep.parentId=pages.at(-1).id;pages.push(tooDeep);assert.throws(()=>model.validateNotebook(value),/8 层/);pages.pop()
 root.parentId=pages.at(-1).id;assert.throws(()=>model.validateNotebook(value),/循环/)
 delete root.parentId;pages[1].parentId=42;assert.throws(()=>model.validateNotebook(value),/标识/)
})

function element(tag, children=[], attributes={}) {
 return {nodeType:1,tagName:tag,childNodes:children,dataset:attributes.dataset??{},style:{fontWeight:'',fontStyle:'',textDecoration:'',...attributes.style},getAttribute:key=>attributes[key]??null,querySelector:()=>attributes.checkbox??null,
  get textContent(){return children.map(child=>child.textContent??'').join('')}}
}
const node=value=>({nodeType:3,textContent:value})
test('rich paste reader keeps readable formatting and drops executable markup, attributes and remote images', () => {
 const root={childNodes:[element('P',[node('Hello '),element('STRONG',[node('中文')],{onclick:'bad'})],{style:{backgroundImage:'url(bad)'}}),element('SCRIPT',[node('run()')]),element('IFRAME',[node('hidden')]),element('IMG',[],{src:'https://example.com/x'}),element('IMG',[],{src:'data:image/svg+xml;base64,PHN2Zz4='}),element('OL',[element('LI',[node('First')])]),element('IMG',[],{src:png,alt:'local',onerror:'bad'})]}
 const blocks=dom.blocksFromDom(root,false)
 assert.equal(blocks.length,3); assert.equal(blocks[0].type,'paragraph'); assert.deepEqual(blocks[0].content,[{text:'Hello '},{text:'中文',marks:['bold']}]); assert.equal(blocks[1].type,'numbered'); assert.equal(blocks[2].type,'image')
})

const componentSource=(await readFile(new URL('../src/components/NotebookEditor.vue',import.meta.url),'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
async function component() {
 const emitted=[], unmount=[], exposed={}
 const props=vue.reactive({document:{id:'test-note',name:'测试.oonote',base64:'',extension:'oonote',kind:'note'},active:true,disabled:false,theme:'light'})
 const source=componentSource+'\nexports.controls={bodyComposing,titleComposing,pending,titlePending,titleDraft,titleChanged,canvasBusy,dialog,session:()=>session,change,confirmDialog,deletePage,deleteSection,currentSection,currentPage,model};'
 const module={exports:{}}
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 vm.runInNewContext(output,{
  module,exports:module.exports,structuredClone,TextEncoder,TextDecoder,Uint8Array,console,
  require(id){if(id==='vue')return {...vue,onBeforeUnmount:fn=>unmount.push(fn)};if(id==='./Icon.vue'||id==='./NotebookCanvas.vue')return {};if(id.includes('shared/document'))return documentHelpers;if(id==='../shared/printing')return {printHtml:()=>assert.fail('Unexpected printing in a non-printing notebook component test')};if(id.includes('shared/dialog-focus'))return {useDialogFocus:()=>{}};if(id.includes('notes/model'))return model;if(id.includes('notes/session'))return {NotebookSession};if(id.includes('notes/dom'))return dom;if(id.includes('notes/search'))return searchHelpers;throw Error(id)},
  defineProps:()=>props,withDefaults:value=>value,defineEmits:()=> (...args)=>emitted.push(args),defineExpose:value=>Object.assign(exposed,value),
  document:{get activeElement(){throw Error('Background operations must not inspect/move focus')},createElement(){throw Error('Background operations must not rebuild DOM')}},
 })
 await vue.nextTick(); await Promise.resolve()
 return {props,emitted,exposed,controls:module.exports.controls,dispose:()=>unmount.forEach(fn=>fn())}
}
test('actual note component background export/save stays read-only on DOM and fails closed for IME, modal, image and invalid draft',async()=>{
 const editor=await component(); const {controls,exposed}=editor
 controls.change(copy=>{copy.sections[0].pages[0].regions[0].blocks[0].content=[{text:'保存中文😀'}]})
 const exported=await exposed.exportFile({background:true}); const before=await exposed.inspect()
 await exposed.markSaved(exported.base64,{background:true}); const after=await exposed.inspect()
 assert.equal(after.documentId,before.documentId);assert.equal(after.revision,before.revision);assert.equal(after.dirty,false)
 for(const key of ['bodyComposing','titleComposing','pending','canvasBusy','dialog']){
  controls[key].value=key==='dialog'?{}:true
  assert.equal(await exposed.canBackgroundExport(),false)
  await assert.rejects(exposed.exportFile({background:true}));await assert.rejects(exposed.markSaved(exported.base64,{background:true}))
  controls[key].value=key==='dialog'?undefined:false
 }
 assert.equal(await exposed.canBackgroundExport(),true)
 controls.change(copy=>{copy.title='new revision'})
 await assert.rejects(exposed.markSaved(exported.base64,{background:true}),/又有修改/)
 assert.equal((await exposed.inspect()).dirty,true)
 editor.dispose();assert.equal(await exposed.canBackgroundExport(),false)
})
test('actual note component deletion leaves document untouched until confirmation and supports undo',async()=>{
 const editor=await component();const {controls,exposed}=editor
 controls.change(copy=>{copy.sections[0].pages.push(model.blankPage('保留页面'))})
 const original=JSON.stringify(controls.model.value)
 controls.deletePage();assert.equal(JSON.stringify(controls.model.value),original);assert.equal(controls.dialog.value.destructive,true)
 controls.dialog.value=undefined;assert.equal(JSON.stringify(controls.model.value),original)
 controls.deletePage();controls.confirmDialog();assert.equal(controls.model.value.sections[0].pages.length,1)
 await exposed.undo();assert.equal(JSON.stringify(controls.model.value),original)
 controls.deleteSection();assert.equal(JSON.stringify(controls.model.value),original)
 controls.confirmDialog();assert.equal(controls.model.value.sections.length,1);assert.notEqual(JSON.stringify(controls.model.value),original)
 await exposed.undo();assert.equal(JSON.stringify(controls.model.value),original);editor.dispose()
})

test('invalid title can be corrected without discarding a separate invalid body draft',async()=>{
 const editor=await component();const {controls,exposed}=editor
 controls.titleChanged({target:{value:'x'.repeat(201)}});assert.equal(controls.titlePending.value,true);assert.equal(await exposed.canBackgroundExport(),false)
 assert.equal(controls.titleDraft.value,'x'.repeat(201),'Rejected text remains an editable draft rather than being replaced by the prior model title')
 editor.props.disabled=true;await vue.nextTick();editor.props.disabled=false;await vue.nextTick()
 await assert.rejects(exposed.prepareDeactivate());assert.equal(controls.titleDraft.value,'x'.repeat(201))
 assert.equal(editor.emitted.some(event=>event[0]==='error'),false,'Recoverable title errors must not leave a shell-level load error')
 await assert.rejects(exposed.exportFile({background:true}))
 controls.pending.value=true
 controls.titleChanged({target:{value:'合法标题'}});assert.equal(controls.titlePending.value,false);assert.equal(controls.pending.value,true);assert.equal(await exposed.canBackgroundExport(),false)
 assert.equal(controls.titleDraft.value,undefined,'Only a valid title commit clears the editable draft')
 controls.pending.value=false;assert.equal(await exposed.canBackgroundExport(),true)
 const result=await exposed.exportFile({background:true});assert.equal(model.decodeNotebook(documentHelpers.base64ToBytes(result.base64)).sections[0].pages[0].title,'合法标题')
 editor.dispose()
})

test('contenteditable block insertion inside active bold keeps todo structure, completion and inherited marks',()=>{
 const checkbox=element('INPUT');checkbox.checked=true
 const todo=element('DIV',[checkbox,node('待办事项')],{dataset:{noteType:'todo',noteId:'todo_1'},checkbox})
 const wrapper=element('DIV',[element('STRONG',[todo,element('BR')])])
 const blocks=dom.blocksFromDom({childNodes:[wrapper]})
 const task=blocks.find(block=>block.type==='todo')
 assert.ok(task);assert.equal(task.checked,true);assert.equal(task.id,'todo_1');assert.deepEqual(task.content,[{text:'待办事项',marks:['bold']}])
 const notebook=model.createNotebook();notebook.sections[0].pages[0].regions[0].blocks=blocks
 const reopened=model.decodeNotebook(model.encodeNotebook(notebook));assert.deepEqual(reopened.sections[0].pages[0].regions[0].blocks.find(block=>block.type==='todo'),task)
 assert.deepEqual(dom.blocksFromDom({childNodes:[wrapper]}).find(block=>block.type==='todo'),task)
})

test('note switching preserves live content and undo while only an exact save receipt allows clean close', async () => {
 const mounted=await component(), {controls,exposed}=mounted
 try {
  const original=await exposed.inspect(), session=controls.session()
  const exportFile=session.export.bind(session);let exports=0
  session.export=(...args)=>{exports++;return exportFile(...args)}
  await exposed.discardChanges()
  assert.equal(exports,0,'An initially clean notebook does not need an export receipt to close')
  controls.titleChanged({target:{value:'保留的笔记标题'}})
  const settled=await exposed.prepareDeactivate()
  assert.equal(settled.documentId,original.documentId);assert.equal(settled.revision,original.revision+1);assert.equal(settled.dirty,true)
  assert.equal(exports,0,'Switching preserves the live notebook without encoding its file')
  await assert.rejects(exposed.discardChanges(),/未保存/)
  const receipt=await exposed.exportFile()
  await assert.rejects(exposed.discardChanges(),/未保存/,'Exporting into memory is not a save')
  await exposed.markSaved(receipt.base64);await exposed.discardChanges()
  await exposed.undo();assert.notEqual(controls.model.value.sections[0].pages[0].title,'保留的笔记标题')
  await exposed.redo();assert.equal(controls.model.value.sections[0].pages[0].title,'保留的笔记标题')
  await assert.rejects(exposed.markSaved(receipt.base64),/又有修改/,'Undo/redo must not revive a stale save receipt')
  for(const key of ['bodyComposing','titleComposing','pending','titlePending','canvasBusy','dialog']){
   controls[key].value=key==='dialog'?{}:true
   await assert.rejects(exposed.prepareDeactivate())
   await assert.rejects(exposed.discardChanges())
   assert.equal(controls.model.value.sections[0].pages[0].title,'保留的笔记标题')
   controls[key].value=key==='dialog'?undefined:false
  }
 } finally {mounted.dispose()}
})
