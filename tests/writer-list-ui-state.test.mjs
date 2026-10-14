import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

// Execute the actual WordWorkbench setup with real Vue reactivity and watchers.
// Only the RPC response, props and emitted event receiver are controlled here;
// native editing and file compatibility are verified separately in UI tests.
const component=await fs.readFile(new URL('../src/components/WordWorkbench.vue',import.meta.url),'utf8')
const script=component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const compiled=compile(`${script}\nexport const inspect={editList,openPanel,edit,problem,listLoading,pending,ready,draft,panel,actionFailed}`)
function loadTs(source){const module={exports:{}};vm.runInNewContext(compile(source),{module,exports:module.exports,Error});return module.exports}
const types=loadTs(await fs.readFile(new URL('../src/word/types.ts',import.meta.url),'utf8'))
const draftReview=loadTs(await fs.readFile(new URL('../src/word/draft-review.ts',import.meta.url),'utf8'))
const plain=value=>JSON.parse(JSON.stringify(value))
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function writerState(){return{
  documentId:'document-A',revision:7,dirty:false,
  selection:{id:'selection-A',text:'Alpha',truncated:false,collapsed:false,tableName:null,cellName:null},
  list:{kind:'number',level:0},
  paragraph:{styleName:'Standard',align:'left',outlineLevel:0,leftIndent:0,rightIndent:0,firstLineIndent:0,spaceAbove:0,spaceBelow:0,lineSpacingPercent:100},
  textStyle:{fontName:'Liberation Serif',fontSize:12,bold:false,italic:false,underline:false,color:'#000000',highlight:null},
  page:{styleName:'Standard',width:210,height:297,landscape:false,marginLeft:20,marginRight:20,marginTop:20,marginBottom:20,headerEnabled:false,footerEnabled:false,headerText:'',footerText:'',headerTruncated:false,footerTruncated:false},
  styles:[],tables:[],outline:[],outlineTruncated:false,review:{recordChanges:false,showChanges:true,changeCount:0,comments:[],footnoteCount:0,indexCount:0},message:'',
}}

function workbench(t,{publish=true,refresh=true,responses,manualTimers=false}={}){
  const gate=deferred(),events=[],unmountCallbacks=[],scope=vue.effectScope(),delays=[],timers=[],timerScheduled=deferred()
  let refreshCalls=0,unmounted=false,exposed
  const props=vue.reactive({state:writerState(),active:true,busy:false,disabled:false,
    ...(refresh?{refreshState:async()=>{const index=refreshCalls++;const value=await(responses?responses[index]:gate.promise);if(publish)props.state=value;return value}}:{}),
  })
  const module={exports:{}}
  scope.run(()=>vm.runInNewContext(compiled,{
    module,exports:module.exports,console,Error,
    // Keep the scheduling boundary while advancing the requested delay in
    // virtual time. Individual tests can hold it between consecutive reads.
    setTimeout(callback,delay){delays.push(delay);if(manualTimers){timers.push(callback);timerScheduled.resolve();return timers.length}return setTimeout(callback,0)},
    defineProps:()=>props,withDefaults:(value,defaults)=>{for(const [key,item]of Object.entries(defaults))if(value[key]===undefined)value[key]=item;return value},
    defineEmits:()=> (...args)=>events.push(args),defineExpose:value=>{exposed=value},
    require(name){
      if(name==='vue')return{...vue,onBeforeUnmount:callback=>unmountCallbacks.push(callback)}
      if(name==='../word/types')return types
      if(name==='../word/draft-review')return draftReview
      if(name.endsWith('.css')||name.endsWith('.vue'))return{}
      throw Error(`Unexpected setup import ${name}`)
    },
  }))
  const unmount=()=>{if(unmounted)return;unmounted=true;for(const callback of unmountCallbacks)callback();scope.stop()}
  t.after(unmount)
  return{props,events,gate,inspect:module.exports.inspect,exposed,unmount,delays,timerScheduled:timerScheduled.promise,
    advanceTimer(){assert.ok(timers.length,'expected a pending read delay');timers.shift()()},
    get refreshCalls(){return refreshCalls},get actions(){return events.filter(([name])=>name==='action')},get commands(){return events.filter(([name])=>name==='command')},
  }
}

test('One explicit list click waits for two stable target reads then sends the fresh strict revision exactly once',async t=>{
  const h=workbench(t),current=writerState();current.revision=10;current.dirty=true;current.textStyle.bold=true
  const pending=h.inspect.editList('demote')
  assert.equal(h.refreshCalls,1);assert.equal(h.inspect.listLoading.value,true);assert.equal(h.actions.length,0)
  h.gate.resolve(current);await pending
  assert.equal(h.refreshCalls,2);assert.deepEqual(h.delays,[60])
  assert.deepEqual(plain(h.actions),[['action',{type:'list',operation:'demote',expectedRevision:10,expectedSelectionId:'selection-A'}]])
  assert.equal(h.commands.length,0);assert.equal(h.inspect.problem.value,'');assert.equal(h.inspect.listLoading.value,false)
})

test('Fresh guarded revision does not require the debounced parent props revision to have caught up',async t=>{
  const h=workbench(t,{publish:false}),current=writerState();current.revision=11
  const pending=h.inspect.editList('restart');h.gate.resolve(current);await pending
  assert.equal(h.props.state.revision,7);assert.equal(h.actions.length,1);assert.equal(h.actions[0][1].expectedRevision,11)
  assert.equal(h.commands.length,0)
})

const changedTargets=[
  ['document',state=>{state.documentId='document-B'}],
  ['selection ID',state=>{state.selection.id='selection-B'}],
  ['selected text with the same ID',state=>{state.selection.text='Replaced text'}],
  ['collapsed selection',state=>{state.selection.collapsed=true}],
  ['truncated selection',state=>{state.selection.truncated=true}],
  ['table identity',state=>{state.selection.tableName='Table1'}],
  ['cell identity',state=>{state.selection.cellName='A1'}],
  ['list kind',state=>{state.list.kind='bullet'}],
  ['list level',state=>{state.list.level=3}],
  ['paragraph style',state=>{state.paragraph.styleName='Heading 1'}],
  ['paragraph outline level',state=>{state.paragraph.outlineLevel=1}],
  ['paragraph indentation',state=>{state.paragraph.leftIndent=12}],
  ['paragraph line spacing',state=>{state.paragraph.lineSpacingPercent=150}],
]
for(const [name,change]of changedTargets){
  test(`A changed ${name} in the fresh response rejects without replay and explains the changed target`,async t=>{
    const h=workbench(t,{publish:false}),current=writerState();current.revision=8;change(current)
    const pending=h.inspect.editList('demote');h.gate.resolve(current);await pending
    assert.equal(h.actions.length,0);assert.equal(h.commands.length,0);assert.equal(h.refreshCalls,1)
    assert.match(h.inspect.problem.value,/改变|变化|重新/)
    assert.equal(h.inspect.listLoading.value,false)
  })
}

test('A different live props snapshot cannot be ignored merely because the returned RPC snapshot still matches',async t=>{
  const h=workbench(t,{publish:false}),current=writerState();current.revision=8
  const pending=h.inspect.editList('remove')
  h.props.state={...writerState(),paragraph:{...writerState().paragraph,rightIndent:5}}
  await vue.nextTick();h.gate.resolve(current);await pending
  assert.equal(h.actions.length,0);assert.equal(h.commands.length,0);assert.match(h.inspect.problem.value,/改变|变化|重新/)
})

test('Refresh failure leaves the document untouched, reports its error and does not retry automatically',async t=>{
  const h=workbench(t),pending=h.inspect.editList('demote')
  h.gate.reject(Error('controlled refresh failed'));await pending;await vue.nextTick()
  assert.equal(h.refreshCalls,1);assert.equal(h.actions.length,0);assert.equal(h.commands.length,0)
  assert.match(h.inspect.problem.value,/controlled refresh failed/);assert.equal(h.inspect.listLoading.value,false)
})

test('Repeated clicks while stable target reads are pending are discarded rather than queued for replay',async t=>{
  const h=workbench(t),current=writerState();current.revision=9
  const first=h.inspect.editList('demote'),second=h.inspect.editList('promote'),third=h.inspect.editList('restart')
  assert.equal(h.refreshCalls,1);h.gate.resolve(current);await Promise.all([first,second,third])
  assert.equal(h.actions.length,1);assert.equal(h.actions[0][1].operation,'demote');assert.equal(h.commands.length,0)
  h.inspect.actionFailed();await vue.nextTick()
  assert.equal(h.refreshCalls,2);assert.equal(h.actions.length,1,'A rejected native action never triggers an automatic replay')
})

test('A late revision notification can settle on the third or fourth read without replaying a write',async t=>{
  for(const revisions of [[8,9,9],[8,9,10,10]]){
    const responses=revisions.map(revision=>({...writerState(),revision})),h=workbench(t,{responses})
    await h.inspect.editList('demote')
    assert.equal(h.refreshCalls,revisions.length);assert.deepEqual(h.delays,Array(revisions.length-1).fill(60))
    assert.deepEqual(plain(h.actions),[['action',{type:'list',operation:'demote',expectedRevision:revisions.at(-1),expectedSelectionId:'selection-A'}]])
    assert.equal(h.commands.length,0);assert.equal(h.inspect.problem.value,'');assert.equal(h.inspect.listLoading.value,false)
  }
})

test('Four continually changing revisions stop read stabilization and report refusal with zero writes',async t=>{
  const h=workbench(t,{responses:[8,9,10,11].map(revision=>({...writerState(),revision}))})
  await h.inspect.editList('demote')
  assert.equal(h.refreshCalls,4);assert.deepEqual(h.delays,[60,60,60])
  assert.equal(h.actions.length,0);assert.equal(h.commands.length,0)
  assert.match(h.inspect.problem.value,/仍在更新|稍后|没有修改/);assert.equal(h.inspect.listLoading.value,false)
  h.inspect.actionFailed();await vue.nextTick()
  assert.equal(h.refreshCalls,4);assert.equal(h.actions.length,0,'Exhausting reads does not trigger an automatic retry')
})

test('A target change on the second read refuses even with a stable revision',async t=>{
  for(const [name,change]of changedTargets){
    const first={...writerState(),revision:8},second=plain(first);change(second)
    const h=workbench(t,{responses:[first,second]})
    await h.inspect.editList('demote')
    assert.equal(h.refreshCalls,2,name);assert.equal(h.actions.length,0,name);assert.equal(h.commands.length,0,name)
    assert.match(h.inspect.problem.value,/改变|变化|重新/,name);assert.equal(h.inspect.listLoading.value,false,name)
  }
})

test('A second refresh failure stops stabilization without writing or retrying',async t=>{
  const second=deferred(),h=workbench(t,{responses:[{...writerState(),revision:8},second.promise],manualTimers:true})
  const pending=h.inspect.editList('demote');await h.timerScheduled;h.advanceTimer()
  await vue.nextTick();assert.equal(h.refreshCalls,2);second.reject(Error('second refresh failed'));await pending
  assert.equal(h.actions.length,0);assert.equal(h.commands.length,0);assert.equal(h.refreshCalls,2)
  assert.match(h.inspect.problem.value,/second refresh failed/);assert.equal(h.inspect.listLoading.value,false)
})

test('Repeated clicks during the stabilization delay never start another read sequence or queue another action',async t=>{
  const current={...writerState(),revision:9},h=workbench(t,{responses:[current,plain(current)],manualTimers:true})
  const first=h.inspect.editList('demote');await h.timerScheduled
  assert.equal(h.refreshCalls,1);assert.equal(h.actions.length,0);assert.equal(h.inspect.listLoading.value,true)
  await h.inspect.editList('promote');await h.inspect.editList('remove')
  assert.equal(h.refreshCalls,1);h.advanceTimer();await first
  assert.equal(h.refreshCalls,2);assert.equal(h.actions.length,1);assert.equal(h.actions[0][1].operation,'demote')
  assert.equal(h.commands.length,0)
})

test('Unmount during the stabilization delay prevents the next read and late action',async t=>{
  const h=workbench(t,{responses:[{...writerState(),revision:8}],manualTimers:true})
  const pending=h.inspect.editList('demote');await h.timerScheduled;h.unmount()
  const before=h.events.length;h.advanceTimer();await pending
  assert.equal(h.refreshCalls,1);assert.equal(h.events.length,before);assert.equal(h.actions.length,0);assert.equal(h.commands.length,0)
})

test('Unmount during the second refresh prevents a stable late result from emitting',async t=>{
  const second=deferred(),h=workbench(t,{responses:[{...writerState(),revision:8},second.promise],manualTimers:true})
  const pending=h.inspect.editList('demote');await h.timerScheduled;h.advanceTimer();await vue.nextTick()
  assert.equal(h.refreshCalls,2);h.unmount();const before=h.events.length
  second.resolve({...writerState(),revision:8});await pending
  assert.equal(h.events.length,before);assert.equal(h.actions.length,0);assert.equal(h.commands.length,0)
})

test('Availability or panel changes between stable reads are checked again before the unique action',async t=>{
  for(const mode of ['active','disabled','busy','panel','pending']){
    const first={...writerState(),revision:8},second=deferred(),h=workbench(t,{responses:[first,second.promise],manualTimers:true})
    h.inspect.openPanel(mode==='pending'?'text':'list')
    const pending=h.inspect.editList('demote');await h.timerScheduled;h.advanceTimer();await vue.nextTick()
    if(mode==='active')h.props.active=false
    else if(mode==='disabled'||mode==='busy')h.props[mode]=true
    else if(mode==='panel')h.inspect.openPanel('paragraph')
    else h.inspect.draft.text='unapplied input during stable reads'
    await vue.nextTick();second.resolve(plain(first));await pending
    assert.equal(h.refreshCalls,2,mode);assert.equal(h.actions.length,0,mode);assert.equal(h.commands.length,0,mode)
    assert.match(h.inspect.problem.value,/改变|变化|重新/,mode);assert.equal(h.inspect.listLoading.value,false,mode)
  }
})

test('Unmount during the refresh prevents late results from emitting a list operation',async t=>{
  const h=workbench(t),pending=h.inspect.editList('demote')
  h.unmount();const before=h.events.length;h.gate.resolve({...writerState(),revision:9});await pending;await vue.nextTick()
  assert.equal(h.actions.length,0);assert.equal(h.commands.length,0);assert.equal(h.events.length,before);assert.equal(h.refreshCalls,1)
})

test('Unmount also suppresses a late refresh rejection instead of installing an error on a disposed view',async t=>{
  const h=workbench(t),pending=h.inspect.editList('demote')
  h.unmount();const problem=h.inspect.problem.value;h.gate.reject(Error('late refresh error'));await pending
  assert.equal(h.actions.length,0);assert.equal(h.inspect.problem.value,problem)
})

test('A pending text draft blocks list refreshes and preserves the unapplied input',async t=>{
  const h=workbench(t);h.inspect.openPanel('text');h.inspect.edit('text','unapplied draft');await vue.nextTick()
  assert.equal(h.inspect.pending.value,true);await h.inspect.editList('demote')
  assert.equal(h.refreshCalls,0);assert.equal(h.actions.length,0);assert.equal(h.inspect.draft.text,'unapplied draft')
})

test('Inactive, disabled and busy workbenches do not start a list refresh',async t=>{
  for(const [key,value]of[['active',false],['disabled',true],['busy',true]]){
    const h=workbench(t);h.props[key]=value;await vue.nextTick();await h.inspect.editList('demote')
    assert.equal(h.refreshCalls,0,key);assert.equal(h.actions.length,0,key);assert.equal(h.commands.length,0,key)
  }
})

test('Publishing a changed fresh target runs the real props watcher but still reports refusal without emitting',async t=>{
  for(const name of ['document','selected text with the same ID','list level','paragraph indentation']){
    const change=changedTargets.find(([label])=>label===name)[1],h=workbench(t),current=writerState()
    const pending=h.inspect.editList('demote');current.revision=8;change(current);h.gate.resolve(current);await pending
    assert.equal(h.actions.length,0,name);assert.equal(h.commands.length,0,name);assert.match(h.inspect.problem.value,/改变|变化|重新/,name)
    assert.equal(h.inspect.listLoading.value,false,name)
  }
})

test('Becoming inactive, disabled or busy while awaiting a matching refresh cancels the click without replay',async t=>{
  for(const [key,value]of[['active',false],['disabled',true],['busy',true]]){
    const h=workbench(t),pending=h.inspect.editList('demote')
    h.props[key]=value;await vue.nextTick();h.gate.resolve({...writerState(),revision:8});await pending
    assert.equal(h.actions.length,0,key);assert.equal(h.commands.length,0,key);assert.equal(h.refreshCalls,1,key)
    assert.match(h.inspect.problem.value,/改变|变化|重新/,key);assert.equal(h.inspect.listLoading.value,false,key)
  }
})

test('A changed panel or newly pending draft while refreshing prevents the old list operation from being sent',async t=>{
  for(const mode of ['panel','pending']){
    const h=workbench(t);h.inspect.openPanel(mode==='pending'?'text':'list')
    const pending=h.inspect.editList('demote')
    if(mode==='panel')h.inspect.openPanel('paragraph')
    else h.inspect.draft.text='late unapplied input'
    await vue.nextTick();h.gate.resolve({...writerState(),revision:8});await pending
    assert.equal(h.actions.length,0,mode);assert.equal(h.commands.length,0,mode);assert.equal(h.refreshCalls,1,mode)
    assert.match(h.inspect.problem.value,/改变|变化|重新/,mode)
    if(mode==='pending')assert.equal(h.inspect.draft.text,'late unapplied input')
  }
})

test('Without a refresh callback the ordinary action path still carries strict guards and never becomes an immediate command',async t=>{
  const h=workbench(t,{refresh:false});await h.inspect.editList('demote')
  assert.deepEqual(plain(h.actions),[['action',{type:'list',operation:'demote',expectedRevision:7,expectedSelectionId:'selection-A'}]])
  assert.equal(h.commands.length,0)
})
