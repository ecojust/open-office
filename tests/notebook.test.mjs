import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as model from '../src/notes/model.ts'
import * as dom from '../src/notes/dom.ts'
import { NotebookSession } from '../src/notes/session.ts'
import * as documentHelpers from '../src/shared/document.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKFcAAAAASUVORK5CYII='
function text(session, value) { session.change(copy => { copy.sections[0].pages[0].blocks[0].content = [{ text: value, marks: ['bold'] }] }) }

test('notebook Unicode, rich marks, todos and local images round-trip through a versioned UTF-8 file', () => {
 const value = model.createNotebook('中文😀笔记')
 value.sections[0].pages[0].blocks = [
  { id: model.noteId(), type:'heading', level:2, content:[{ text:'标题', marks:['bold','italic','bold'] }] },
  { id:model.noteId(), type:'todo', checked:true, content:[{text:'已完成😀'}] },
  { id:model.noteId(), type:'image', dataUrl:png, alt:'测试图片' },
 ]
 const bytes = model.encodeNotebook(value), decoded = model.decodeNotebook(bytes)
 assert.equal(decoded.title,'中文😀笔记'); assert.deepEqual(decoded.sections[0].pages[0].blocks[0].content[0].marks,['bold','italic'])
 assert.equal(decoded.sections[0].pages[0].blocks[1].checked,true)
 assert.equal(decoded.sections[0].pages[0].blocks[2].dataUrl,png)
 assert.deepEqual(model.decodeNotebook(new Uint8Array([239,187,191,...bytes])),decoded)
 assert.equal(model.noteTitle('😀'.repeat(200)).length,400)
 assert.throws(()=>model.noteTitle('😀'.repeat(201)),/过长/)
})

test('notebook rejects corrupt bytes, incompatible versions, duplicate identities and structural overflow before adoption', () => {
 for (const bytes of [new Uint8Array(),new Uint8Array([255]),new TextEncoder().encode('{bad')]) assert.throws(()=>model.decodeNotebook(bytes))
 for (const change of [v=>v.version=2,v=>v.format='other',v=>v.sections=[],v=>v.sections[0].pages=[],v=>v.sections[0].id=v.id,v=>v.sections[0].pages[0].blocks=[],v=>v.sections[0].pages[0].blocks[0].content=[{text:'x',marks:['onclick']}],v=>v.sections[0].title='a'.repeat(201)]) {
  const value=model.createNotebook(); change(value); assert.throws(()=>model.validateNotebook(value))
 }
 const value=model.createNotebook(); value.sections=Array.from({length:101},()=>({id:model.noteId(),title:'x',pages:[model.blankPage()]})); assert.throws(()=>model.validateNotebook(value))
})

test('notebook raster whitelist rejects remote, SVG, mislabeled, malformed and oversized payloads', () => {
 for (const image of ['https://example.com/image.png','data:image/svg+xml;base64,PHN2Zz4=',png.replace('image/png','image/jpeg'),'data:image/png;base64,YmFk','data:image/png;base64,'+'A'.repeat(6*1024*1024)]) assert.throws(()=>model.validateImage(image))
 const source=JSON.parse(JSON.stringify(model.createNotebook())); source.onclick='evil'; source.sections[0].style='url(evil)'; source.sections[0].pages[0].blocks[0].content=[{text:'safe',onclick:'evil'}]
 const result=model.validateNotebook(source); assert.equal(result.onclick,undefined); assert.equal(result.sections[0].style,undefined); assert.deepEqual(result.sections[0].pages[0].blocks[0].content,[{text:'safe'}])
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
 const reopened=new NotebookSession(third.bytes); assert.equal(reopened.model.sections[0].pages[0].blocks[0].content[0].text,'second')
})

test('failed model changes preserve document, revision, history and the previous save receipt', () => {
 const session=new NotebookSession(); text(session,'safe'); const exported=session.export(); const before=session.inspect()
 assert.throws(()=>session.change(copy=>{copy.sections=[]})); assert.deepEqual(session.inspect(),before)
 assert.equal(session.model.sections[0].pages[0].blocks[0].content[0].text,'safe'); session.markSaved(exported.bytes)
 session.change(copy=>{copy.title='new'}); session.undo(); session.change(copy=>{copy.title='different'}); assert.equal(session.redo(),false)
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
 const source=componentSource+'\nexports.controls={composing,pending,titlePending,titleChanged,imageBusy,dialog,session:()=>session,change,confirmDialog,deletePage,deleteSection,currentSection,currentPage,model};'
 const module={exports:{}}
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 vm.runInNewContext(output,{
  module,exports:module.exports,structuredClone,TextEncoder,TextDecoder,Uint8Array,console,
  require(id){if(id==='vue')return {...vue,onBeforeUnmount:fn=>unmount.push(fn)};if(id==='./Icon.vue')return {};if(id.includes('shared/document'))return documentHelpers;if(id.includes('shared/dialog-focus'))return {useDialogFocus:()=>{}};if(id.includes('notes/model'))return model;if(id.includes('notes/session'))return {NotebookSession};if(id.includes('notes/dom'))return dom;throw Error(id)},
  defineProps:()=>props,withDefaults:value=>value,defineEmits:()=> (...args)=>emitted.push(args),defineExpose:value=>Object.assign(exposed,value),
  document:{get activeElement(){throw Error('Background operations must not inspect/move focus')},createElement(){throw Error('Background operations must not rebuild DOM')}},
 })
 await vue.nextTick(); await Promise.resolve()
 return {props,emitted,exposed,controls:module.exports.controls,dispose:()=>unmount.forEach(fn=>fn())}
}
test('actual note component background export/save stays read-only on DOM and fails closed for IME, modal, image and invalid draft',async()=>{
 const editor=await component(); const {controls,exposed}=editor
 controls.change(copy=>{copy.sections[0].pages[0].blocks[0].content=[{text:'保存中文😀'}]})
 const exported=await exposed.exportFile({background:true}); const before=await exposed.inspect()
 await exposed.markSaved(exported.base64,{background:true}); const after=await exposed.inspect()
 assert.equal(after.documentId,before.documentId);assert.equal(after.revision,before.revision);assert.equal(after.dirty,false)
 for(const key of ['composing','pending','imageBusy','dialog']){
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
 assert.equal(editor.emitted.some(event=>event[0]==='error'),false,'Recoverable title errors must not leave a shell-level load error')
 await assert.rejects(exposed.exportFile({background:true}))
 controls.pending.value=true
 controls.titleChanged({target:{value:'合法标题'}});assert.equal(controls.titlePending.value,false);assert.equal(controls.pending.value,true);assert.equal(await exposed.canBackgroundExport(),false)
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
 const notebook=model.createNotebook();notebook.sections[0].pages[0].blocks=blocks
 const reopened=model.decodeNotebook(model.encodeNotebook(notebook));assert.deepEqual(reopened.sections[0].pages[0].blocks.find(block=>block.type==='todo'),task)
 assert.deepEqual(dom.blocksFromDom({childNodes:[wrapper]}).find(block=>block.type==='todo'),task)
})
