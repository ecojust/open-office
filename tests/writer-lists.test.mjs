import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Contract tests of actual Writer list actions with observable native doubles.
// They do not establish rendering, undo, or DOCX/ODT roundtrip compatibility.
const source=fs.readFileSync(new URL('../public/office/writer-tools.js',import.meta.url),'utf8')
const enumeration=items=>{let index=0;return{hasMoreElements:()=>index<items.length,nextElement:()=>items[index++]}}
const plain=value=>JSON.parse(JSON.stringify(value))
function levelProperties(rule,index,properties){
  for(const [Name,Value]of Object.entries(properties)){
    const entry=rule.levels[index].find(item=>item.Name===Name)
    if(entry)entry.Value=Value;else rule.levels[index].push({Name,Value})
  }
}
function docxSymbolRules(f,charSet=10){
  const rule=f.rules('bullet')
  // Captured native shape after exporting our ordinary dot bullet to DOCX and
  // reopening it: nine Symbol levels followed by Writer's decimal default slot.
  for(let level=0;level<9;level++)levelProperties(rule,level,{
    BulletChar:'\uF0B7',BulletFontName:'',BulletFont:{Name:'Symbol',CharSet:charSet},Suffix:'\uF0B7',ListFormat:'\uF0B7',
  })
  rule.levels[9]=plain(f.rules('number').levels[9])
  return rule
}

function fixture(texts=['Alpha','Beta','Gamma'],options={}){
  const writes=[],ruleWrites=[],ruleReads=[],undo=[],created=[],reads=[],errors=[],selectionCalls=[],dispatchCalls=[]
  let modelReads=0,revision=0,readonly=false,selectionCount=1,selectionOverride,body,view,paragraphs,dispatchMode='normal',undoLocked=false
  class Any {constructor(type,value){this.type=type;this.value=value}}
  class Struct {constructor(value){Object.assign(this,value)}}
  const unwrap=value=>value instanceof Any?value.value:value
  function props(values,label){return{
    values:{...values},states:{},
    getPropertySetInfo(){return{hasPropertyByName:name=>Object.hasOwn(this.values,name),getProperties:()=>Object.keys(this.values).map(Name=>({Name}))}},
    getPropertyState(name){assert.ok(Object.hasOwn(this.values,name),`unknown state ${label}.${name}`);return this.states[name]??0},
    getPropertyValue(name){assert.ok(Object.hasOwn(this.values,name),`unknown read ${label}.${name}`);reads.push(`${label}.${name}`);return this.values[name]},
    setPropertyValue(name,value){assert.ok(Object.hasOwn(this.values,name),`unknown write ${label}.${name}`);writes.push({target:label,name,value:unwrap(value),type:value?.type});this.values[name]=unwrap(value)},
  }}
  function rules(kind='number',count=10){
    const levels=Array.from({length:count},(_,index)=>Object.entries({
      Adjust:3,ParentNumbering:1,Prefix:'',Suffix:kind==='number'?'.':'',
      ListFormat:kind==='number'?`%${index+1}%.`:'',CharStyleName:kind==='number'?'Numbering Symbols':'Bullet Symbols',
      StartWith:1,PositionAndSpaceMode:1,LabelFollowedBy:0,ListtabStopPosition:700*(index+1),FirstLineIndent:-700,IndentAt:1330+700*index,
      NumberingType:kind==='number'?4:6,...(kind==='bullet'?{BulletChar:'•',BulletFontName:'OpenSymbol'}:{}),
    }).map(([Name,Value])=>({Name,Value})))
    const object={...props({Name:'Simple',DefaultListId:'list-one',IsAbsoluteMargins:false,IsAutomatic:true,IsContinuousNumbering:false,NumberingIsOutline:false},'rules'),levels,
      getCount:()=>levels.length,getByIndex(index){ruleReads.push({rules:object,index});return levels[index].map(item=>({...item}))},
      replaceByIndex(index,value){ruleWrites.push({rules:object,index,value});levels[index]=unwrap(value).map(item=>({...item,Value:unwrap(item.Value)}))},
      hasElements:()=>levels.length>0,
    }
    object.setPropertyValue=function(name,value){ruleWrites.push({rules:object,name,value:unwrap(value)});this.values[name]=unwrap(value)}
    return object
  }
  const fullText=texts.join('\n')
  const positions=[];let position=0
  for(const text of texts){positions.push([position,position+text.length]);position+=text.length+1}
  const startOf=range=>range.start??range.getStart().start
  const endOf=range=>range.end??range.getEnd().end
  const point=offset=>({start:offset,end:offset,getText:()=>body,getStart(){return this},getEnd(){return this},getString:()=>''})
  const included=range=>paragraphs.filter(paragraph=>paragraph.end>=range.start&&paragraph.start<=range.end)
  function cursor(start=0,end=start){return{
    start,end,getText:()=>body,getStart(){return point(this.start)},getEnd(){return point(this.end)},
    gotoRange(range,expand){const next=endOf(range);if(expand)this.end=next;else this.start=this.end=next},
    getString(){return fullText.slice(this.start,this.end)},isCollapsed(){return this.start===this.end},
    collapseToStart(){this.end=this.start},collapseToEnd(){this.start=this.end},
    gotoStartOfParagraph(expand){const paragraph=paragraphs.findLast(item=>item.start<=this.end);if(!paragraph)return false;if(expand)this.end=paragraph.start;else this.start=this.end=paragraph.start;return true},
    gotoEndOfParagraph(expand){const paragraph=paragraphs.findLast(item=>item.start<=this.end);if(!paragraph)return false;if(expand)this.end=paragraph.end;else this.start=this.end=paragraph.end;return true},
    createEnumeration(){return enumeration(included(this))},
    getPropertySetInfo(){return{hasPropertyByName:name=>included(this).every(paragraph=>Object.hasOwn(paragraph.values,name))}},
    getPropertyValue(name){return included(this)[0].getPropertyValue(name)},
    setPropertyValue(name,value){for(const paragraph of included(this))paragraph.setPropertyValue(name,value)},
    setString(value){writes.push({target:'text-range',name:'setString',value})},
  }}
  body={createTextCursorByRange:range=>cursor(startOf(range)),createEnumeration:()=>enumeration(paragraphs),getString:()=>fullText,
    compareRegionStarts:(left,right)=>Math.sign(startOf(right)-startOf(left)),compareRegionEnds:(left,right)=>Math.sign(endOf(right)-endOf(left))}
  paragraphs=texts.map((text,index)=>Object.assign(props({
    OutlineLevel:0,TextSection:null,TextTable:null,NumberingRules:null,NumberingStyleName:'',NumberingLevel:0,
    ListId:'',NumberingIsNumber:false,ParaIsNumberingRestart:false,NumberingStartValue:-1,ParaStyleName:'Standard',
    ListLabelString:'',CharColor:0x2040c0,CharWeight:100,IsProtected:false,
  },`p${index}`),{start:positions[index][0],end:positions[index][1],
    getString:()=>text,getText:()=>body,getStart:()=>point(positions[index][0]),getEnd:()=>point(positions[index][1]),
    supportsService:name=>name==='com.sun.star.text.Paragraph',createEnumeration:()=>enumeration([]),
    setString:value=>writes.push({target:`p${index}`,name:'setString',value}),
  }))
  view=Object.assign(cursor(0,fullText.length),props({PageStyleName:'Standard',TextTable:null,Cell:null},'view'))
  const controller={getViewCursor:()=>view,getSelection:()=>selectionOverride??{getCount:()=>selectionCount,getByIndex:()=>view},
    select(range){selectionCalls.push({start:startOf(range),end:endOf(range)});view.start=startOf(range);view.end=endOf(range);return true},
  }
  const page=props({Width:21000,Height:29700,IsLandscape:false,LeftMargin:2000,RightMargin:2000,TopMargin:2000,BottomMargin:2000,HeaderIsOn:false,FooterIsOn:false},'page')
  const undoManager={
    isLocked:()=>undoLocked,
    lock(){assert.equal(undoLocked,false);undoLocked=true},
    unlock(){assert.equal(undoLocked,true);undoLocked=false},
    enterUndoContext(name){assert.equal(undoLocked,false);undo.push(['begin',name])},
    leaveUndoContext(){assert.equal(undoLocked,false);undo.push(['end'])},
  }
  const model={supportsService:name=>name==='com.sun.star.text.TextDocument',getText:()=>body,getCurrentController:()=>controller,isReadonly:()=>readonly,
    getUndoManager:()=>undoManager,
    createInstance(name){assert.equal(name,'com.sun.star.text.NumberingRules');const value=rules();created.push(value);return value},
    getStyleFamilies:()=>({getByName:name=>name==='PageStyles'?{hasByName:value=>value==='Standard',getByName:()=>page}:{getElementNames:()=>[]}}),
    getTextTables:()=>({getElementNames:()=>[]}),getTextFields:()=>({createEnumeration:()=>enumeration([])}),
    getRedlines:()=>({createEnumeration:()=>enumeration([])}),getFootnotes:()=>({getCount:()=>0}),getDocumentIndexes:()=>({getCount:()=>0}),
  }
  let activeModel=model
  const context=vm.createContext({WebAssembly,Error,URL})
  vm.runInContext(source,context)
  const api=context.createWriterTools({getModel:()=>{modelReads++;return activeModel},getRevision:()=>revision,
    css:{beans:{PropertyValue:Struct},style:{LineSpacingMode:{PROP:0},NumberingType:{ARABIC:4,CHAR_SPECIAL:6},NumberingPositionAndSpaceMode:{LABEL_ALIGNMENT:1}},text:{LabelFollow:{LISTTAB:0}},awt:{FontSlant:{ITALIC:2,NONE:0},FontDescriptor:Struct}},
    zetajs:{Any,type:{short:'short',long:'long',byte:'byte',float:'float',boolean:'boolean',struct:value=>({struct:value}),sequence:value=>({sequence:value})},sameUnoObject:(left,right)=>left===right,catchUnoException:error=>{errors.push(error);return{Message:'native error'}}},
    dispatch:options.dispatch===false?undefined:(command,args)=>{
      writes.push({target:'dispatch',name:command,value:args})
      const targets=included(view)
      dispatchCalls.push({command,args:plain(args),start:view.start,end:view.end,paragraphs:targets.map(item=>paragraphs.indexOf(item))})
      if(dispatchMode==='throw')throw Error('native dispatch failed')
      if(dispatchMode==='noop')return
      const delta=command==='.uno:DecrementLevel'?1:command==='.uno:IncrementLevel'?-1:0
      // Simulate the native command without going through a UNO property setter.
      // Real undo/redo behavior is verified independently against the engine.
      for(const paragraph of dispatchMode==='partial'?targets.slice(0,1):targets)paragraph.values.NumberingLevel+=delta
    },
  })
  return {api,model,view,body,controller,paragraphs,writes,ruleWrites,ruleReads,undo,undoManager,created,reads,rules,errors,selectionCalls,dispatchCalls,
    set activeModel(value){activeModel=value},
    get modelReads(){return modelReads},set readonly(value){readonly=value},set selectionCount(value){selectionCount=value},set selectionOverride(value){selectionOverride=value},
    set dispatchMode(value){dispatchMode=value},
    get revision(){return revision},set revision(value){revision=value},
    showList(index){for(const name of ['NumberingRules','NumberingLevel','NumberingIsNumber'])view.values[name]=paragraphs[index].values[name]},
    select(first,last=first,{throughNextStart=false,collapsed=false}={}){view.start=paragraphs[first].start;view.end=collapsed?view.start:throughNextStart?paragraphs[last+1].start:paragraphs[last].end},
    list(indexes,kind='number',options={}){const rule=options.rules??rules(kind);for(const index of indexes)Object.assign(paragraphs[index].values,{NumberingRules:rule,NumberingStyleName:'Simple',NumberingLevel:options.level??0,ListId:options.id??'list-one',NumberingIsNumber:true});return rule},
    run:operation=>api.action({type:'list',operation}),
  }
}

test('List actions accept only a bounded explicit operation and never arbitrary UNO command arguments',()=>{
  for(const input of [{type:'list'},{type:'list',operation:'toggle'},{type:'list',operation:1},{type:'list',operation:'bullet',command:'.uno:Save'},{type:'list',operation:'number',level:4}]){
    const f=fixture();assert.throws(()=>f.api.action(input));assert.equal(f.modelReads,0);assert.deepEqual(f.writes,[])
  }
})

test('Lists remain strict actions and cannot bypass version protection through immediate commands',()=>{
  const f=fixture();assert.throws(()=>f.api.command({action:{type:'list',operation:'number'},target:{}}));assert.equal(f.modelReads,0);assert.deepEqual(f.writes,[])
})

test('New bullet and numbered lists assign independent new rules only to selected plain paragraphs',()=>{
  for(const kind of ['bullet','number']){
    const f=fixture();f.select(0,1);const imported=f.list([2]);const snapshot=plain(imported.levels)
    f.run(kind)
    const assignments=f.writes.filter(item=>item.name==='NumberingRules')
    assert.equal(assignments.length,2);assert.deepEqual(assignments.map(item=>item.target),['p0','p1'])
    assert.equal(f.created.length,1);assert.equal(assignments[0].value,f.created[0]);assert.equal(assignments[1].value,f.created[0])
    assert.notEqual(assignments[0].value,imported);assert.deepEqual(plain(imported.levels),snapshot)
    assert.ok(f.ruleWrites.every(item=>item.rules!==imported));assert.ok(!f.writes.some(item=>item.target==='p2'||item.name==='setString'))
    assert.equal(f.undo.filter(item=>item[0]==='begin').length,1);assert.equal(f.undo.at(-1)[0],'end')
  }
})

test('New list rules initialize under the undo lock before a separate normal binding group begins',()=>{
  for(const operation of ['bullet','number']){
    const f=fixture(),events=[],create=f.model.createInstance.bind(f.model);f.select(0,1)
    f.model.getUndoManager=()=>({
      ...f.undoManager,lock(){events.push('lock');f.undoManager.lock()},unlock(){events.push('unlock');f.undoManager.unlock()},
      enterUndoContext(){assert.equal(f.undoManager.isLocked(),false);events.push('begin')},leaveUndoContext:()=>events.push('leave'),
    })
    f.model.createInstance=name=>{
      assert.equal(f.undoManager.isLocked(),true);events.push('factory');const rule=create(name),replace=rule.replaceByIndex.bind(rule)
      rule.replaceByIndex=(index,value)=>{assert.equal(f.undoManager.isLocked(),true);events.push(`initialize:${index}`);return replace(index,value)}
      return rule
    }
    for(const [index,paragraph]of f.paragraphs.entries()){
      const set=paragraph.setPropertyValue.bind(paragraph)
      paragraph.setPropertyValue=(name,value)=>{assert.equal(f.undoManager.isLocked(),false);events.push(`p${index}:${name}`);return set(name,value)}
    }
    f.run(operation)
    assert.deepEqual(events,[
      'lock','factory',...Array.from({length:10},(_,index)=>`initialize:${index}`),'unlock','begin',
      'p0:NumberingRules','p1:NumberingRules','p0:NumberingLevel','p1:NumberingLevel','leave',
    ])
    assert.equal(f.created.length,1);assert.equal(f.paragraphs[2].values.NumberingRules,null)
    assert.ok(f.ruleWrites.every(item=>item.rules===f.created[0]))
  }
})

test('Factory or new-rule initialization failures always unlock and never bind incomplete rules or enter a group',()=>{
  for(const operation of ['bullet','number'])for(const phase of ['factory','count','invalid-count','first-level','later-level']){
    const f=fixture(),events=[],create=f.model.createInstance.bind(f.model)
    f.model.getUndoManager=()=>({
      ...f.undoManager,lock(){events.push('lock');f.undoManager.lock()},unlock(){events.push('unlock');f.undoManager.unlock()},
      enterUndoContext:()=>events.push('begin'),leaveUndoContext:()=>events.push('leave'),
    })
    f.model.createInstance=name=>{
      events.push('factory');if(phase==='factory')throw Error('factory failed')
      const rule=create(name),replace=rule.replaceByIndex.bind(rule)
      if(phase==='count')rule.getCount=()=>{throw Error('count failed')}
      if(phase==='invalid-count')rule.getCount=()=>11
      rule.replaceByIndex=(index,value)=>{
        events.push(`initialize:${index}`)
        if(phase==='first-level'&&index===0||phase==='later-level'&&index===4)throw Error('initialization failed')
        return replace(index,value)
      }
      return rule
    }
    assert.throws(()=>f.run(operation),undefined,`${operation}/${phase}`)
    assert.equal(events[0],'lock');assert.equal(events[1],'factory');assert.equal(events.at(-1),'unlock')
    assert.equal(events.filter(value=>value==='lock').length,1);assert.equal(events.filter(value=>value==='unlock').length,1)
    assert.ok(!events.includes('begin'));assert.ok(!events.includes('leave'));assert.equal(f.undoManager.isLocked(),false)
    assert.deepEqual(f.writes,[]);assert.ok(f.paragraphs.every(paragraph=>paragraph.values.NumberingRules===null))
    assert.ok(f.ruleWrites.every(item=>f.created.includes(item.rules)))
    if(phase==='factory')assert.deepEqual(f.created,[])
    if(phase==='later-level')assert.equal(f.ruleWrites.length,4)
  }
})

test('A binding group entry failure leaves the initialized rule unbound and the undo manager unlocked',()=>{
  for(const operation of ['bullet','number']){
    const f=fixture(),events=[],create=f.model.createInstance.bind(f.model)
    f.model.getUndoManager=()=>({...f.undoManager,enterUndoContext(){events.push('begin');throw Error('undo enter failed')},leaveUndoContext:()=>events.push('leave')})
    f.model.createInstance=name=>{events.push('factory');return create(name)}
    assert.throws(()=>f.run(operation));assert.deepEqual(events,['factory','begin'])
    assert.equal(f.created.length,1);assert.equal(f.ruleWrites.length,10);assert.deepEqual(f.writes,[]);assert.equal(f.undoManager.isLocked(),false)
  }
})

test('Unknown undo lock methods or state refuse new rules before the factory or any write',()=>{
  for(const mode of ['missing-lock','missing-unlock','missing-isLocked','throws',true,undefined,null,0,'false']){
    const f=fixture()
    if(typeof mode==='string'&&mode.startsWith('missing-'))delete f.undoManager[mode.slice(8)]
    else if(mode==='throws')f.undoManager.isLocked=()=>{throw Error('lock state unknown')}
    else f.undoManager.isLocked=()=>mode
    assert.throws(()=>f.run('bullet'),undefined,String(mode))
    assert.deepEqual(f.created,[]);assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(f.writes,[]);assert.deepEqual(f.undo,[])
  }
})

test('A failed undo lock never creates rules and a failed unlock never binds rules',()=>{
  for(const phase of ['lock','unlock']){
    const f=fixture(),events=[]
    f.undoManager[phase]=()=>{events.push(phase);throw Error(`${phase} failed`)}
    assert.throws(()=>f.run('number'));assert.deepEqual(events,[phase]);assert.deepEqual(f.writes,[]);assert.deepEqual(f.undo,[])
    assert.equal(f.created.length,phase==='lock'?0:1);assert.equal(f.ruleWrites.length,phase==='lock'?0:10)
  }
})

function preparePlainParagraph(f){
  Object.assign(f.paragraphs[0].values,{NumberingRules:null,NumberingStyleName:'',NumberingLevel:0,ListId:'',NumberingIsNumber:false,ParaIsNumberingRestart:false,NumberingStartValue:-1})
}
function fillRuleCapacity(f){
  for(let index=0;index<512;index++){preparePlainParagraph(f);f.run(index%2?'number':'bullet')}
  preparePlainParagraph(f)
}

test('The 512-owner limit refuses further creation without eviction; only matching document release frees capacity',()=>{
  const f=fixture(['Only']);fillRuleCapacity(f)
  assert.equal(f.created.length,512);const first=f.created[0],last=f.created[511],firstShape=plain(first.levels)
  const writeCount=f.writes.length,ruleWriteCount=f.ruleWrites.length,undoCount=f.undo.length
  for(const unrelated of [{},null,undefined,{...f.model}]){
    f.api.releaseDocument(unrelated)
    assert.throws(()=>f.run('bullet'),/512/)
    assert.equal(f.created.length,512);assert.equal(f.writes.length,writeCount);assert.equal(f.ruleWrites.length,ruleWriteCount);assert.equal(f.undo.length,undoCount)
  }
  assert.deepEqual(plain(first.levels),firstShape);assert.equal(f.created[511],last)
  f.api.releaseDocument(f.model);f.run('bullet')
  assert.equal(f.created.length,513);assert.notEqual(f.created[512],first)
})

test('Existing lists remain editable at owner capacity and do not evict owners to create another list',()=>{
  const f=fixture(['Only']);fillRuleCapacity(f)
  f.list([0],'number',{level:2});const before=f.created.length
  f.run('demote');assert.equal(f.paragraphs[0].values.NumberingLevel,3);assert.equal(f.created.length,before)
  preparePlainParagraph(f);assert.throws(()=>f.run('bullet'),/512/);assert.equal(f.created.length,512)
})

test('Changing the current native model starts its own owner lifetime without a debug interface',()=>{
  const f=fixture(['Only']);fillRuleCapacity(f);assert.throws(()=>f.run('number'),/512/)
  const nextModel={...f.model};f.activeModel=nextModel
  f.run('number');assert.equal(f.created.length,513);assert.equal(f.paragraphs[0].values.NumberingRules,f.created[512])
})

test('Factory instances that fail initialization remain counted until document release',()=>{
  const f=fixture(['Only']),create=f.model.createInstance.bind(f.model)
  f.model.createInstance=name=>{const rule=create(name);rule.getCount=()=>{throw Error('count failed')};return rule}
  for(let index=0;index<512;index++)assert.throws(()=>f.run('bullet'),/count failed/)
  assert.equal(f.created.length,512);assert.throws(()=>f.run('bullet'),/512/)
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[]);assert.equal(f.undoManager.isLocked(),false)
  f.api.releaseDocument(f.model);f.model.createInstance=create;f.run('number')
  assert.equal(f.created.length,513)
})

test('New list creation never overwrites an existing selected list, even a basic one',()=>{
  for(const kind of ['bullet','number']){
    const f=fixture();f.list([1]);const original=f.paragraphs[1].values.NumberingRules
    assert.throws(()=>f.run(kind));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[]);assert.equal(f.paragraphs[1].values.NumberingRules,original)
  }
})

test('Remove only detaches selected paragraph numbering and never edits a shared list rule',()=>{
  const f=fixture();const rule=f.list([0,1,2]);const before=plain(rule.levels);f.select(0,1)
  f.run('remove')
  assert.deepEqual(f.writes.map(({target,name,value})=>({target,name,value})),[{target:'p0',name:'NumberingStyleName',value:''},{target:'p1',name:'NumberingStyleName',value:''}])
  assert.equal(f.paragraphs[2].values.NumberingStyleName,'Simple');assert.deepEqual(plain(rule.levels),before);assert.deepEqual(f.ruleWrites,[])
})

test('Promote and demote dispatch exact synchronous native slots over full selected paragraphs and restore the original text selection',()=>{
  for(const [operation,expected,command]of[['promote',1,'.uno:IncrementLevel'],['demote',3,'.uno:DecrementLevel']]){
    const f=fixture();const rule=f.list([0,1,2],'number',{level:2});const snapshot=plain(rule.levels);f.select(0,1)
    f.view.start++;f.view.end--
    const original={start:f.view.start,end:f.view.end},full={start:f.paragraphs[0].start,end:f.paragraphs[1].end}
    f.run(operation)
    assert.deepEqual(f.dispatchCalls,[{command,args:[{Name:'SynchronMode',Value:true}],...full,paragraphs:[0,1]}])
    assert.deepEqual(f.selectionCalls,[full,original]);assert.deepEqual({start:f.view.start,end:f.view.end},original)
    assert.deepEqual(f.writes.map(({target,name})=>({target,name})),[{target:'dispatch',name:command}])
    assert.equal(f.paragraphs[0].values.NumberingLevel,expected);assert.equal(f.paragraphs[1].values.NumberingLevel,expected);assert.equal(f.paragraphs[2].values.NumberingLevel,2)
    assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(plain(rule.levels),snapshot)
    assert.deepEqual(f.undo,[['begin','调整列表'],['end']])
  }
})

test('Native level commands exclude an exclusive terminal paragraph and never recurse into its deeper sublevel',()=>{
  for(const operation of ['promote','demote']){
    const f=fixture();f.list([0,1,2],'number',{level:2});f.paragraphs[2].values.NumberingLevel=3
    f.select(0,1,{throughNextStart:true});const original={start:f.view.start,end:f.view.end}
    f.run(operation)
    assert.deepEqual(f.dispatchCalls[0].paragraphs,[0,1]);assert.equal(f.dispatchCalls[0].end,f.paragraphs[1].end)
    assert.ok(!f.dispatchCalls[0].command.includes('SubLevels'));assert.equal(f.paragraphs[2].values.NumberingLevel,3)
    assert.deepEqual(f.selectionCalls.at(-1),original);assert.deepEqual(f.ruleWrites,[])
    assert.ok(f.writes.every(item=>item.target==='dispatch'))
  }
})

test('Collapsed level commands temporarily select exactly the caret paragraph and restore the caret',()=>{
  const f=fixture();f.list([0,1,2],'number',{level:2});f.select(1,1,{collapsed:true});f.view.start++;f.view.end++
  const original={start:f.view.start,end:f.view.end}
  f.run('demote')
  assert.deepEqual(f.dispatchCalls[0].paragraphs,[1])
  assert.deepEqual(f.selectionCalls,[{start:f.paragraphs[1].start,end:f.paragraphs[1].end},original])
  assert.deepEqual(f.paragraphs.map(item=>item.values.NumberingLevel),[2,3,2])
})

test('Missing native level dispatch or controller selection support refuses before opening undo or writing',()=>{
  for(const mode of ['dispatch','select']){
    const f=fixture(undefined,{dispatch:mode!=='dispatch'});f.list([0,1,2],'number',{level:2})
    if(mode==='select')delete f.controller.select
    assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(f.undo,[])
    assert.deepEqual(f.selectionCalls,[])
  }
})

test('Failed full-paragraph selection refuses the native command and restores the original range',()=>{
  for(const mode of ['unmoved','partial-throw']){
    const f=fixture();f.list([0,1,2],'number',{level:2});f.select(0,1);f.view.start++;f.view.end--
    const original={start:f.view.start,end:f.view.end},select=f.controller.select.bind(f.controller);let attempts=0
    f.controller.select=range=>{
      if(++attempts===1){if(mode==='partial-throw'){select(range);throw Error('selection failed')}return false}
      return select(range)
    }
    assert.throws(()=>f.run('demote'));assert.equal(attempts,2)
    assert.deepEqual({start:f.view.start,end:f.view.end},original);assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(f.undo,[])
  }
})

test('A false selection return cannot widen the operation beyond the independently verified exact view range',()=>{
  const f=fixture();f.list([0,1,2],'number',{level:2});f.select(0,1)
  const original={start:f.view.start,end:f.view.end},select=f.controller.select.bind(f.controller);let attempts=0
  f.controller.select=range=>{select(range);return ++attempts!==1}
  // The actual controller range is authoritative. A false return with an
  // unchanged, already exact range is safe; a mismatching range is tested above.
  f.run('demote');assert.equal(f.dispatchCalls.length,1);assert.deepEqual(f.dispatchCalls[0].paragraphs,[0,1])
  assert.equal(f.dispatchCalls[0].start,original.start);assert.equal(f.dispatchCalls[0].end,original.end)
  assert.equal(f.paragraphs[2].values.NumberingLevel,2);assert.deepEqual(f.ruleWrites,[])
  assert.deepEqual({start:f.view.start,end:f.view.end},original)
})

test('Native level command failure or incomplete results close the undo group and restore selection without rewriting rules',()=>{
  for(const mode of ['throw','noop','partial']){
    const f=fixture();const rule=f.list([0,1,2],'number',{level:2});const snapshot=plain(rule.levels)
    f.select(0,1);f.view.start++;f.view.end--;const original={start:f.view.start,end:f.view.end};f.dispatchMode=mode
    assert.throws(()=>f.run('demote'),undefined,mode)
    assert.deepEqual(f.undo,[['begin','调整列表'],['end']]);assert.deepEqual({start:f.view.start,end:f.view.end},original)
    assert.equal(f.dispatchCalls.length,1);assert.ok(f.writes.every(item=>item.target==='dispatch'))
    assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(plain(rule.levels),snapshot)
  }
})

test('Undo context setup or closure failures still restore the original list selection',()=>{
  for(const phase of ['begin','end']){
    const f=fixture();f.list([0,1,2],'number',{level:2});f.select(0,1);f.view.start++;f.view.end--
    const original={start:f.view.start,end:f.view.end}
    f.model.getUndoManager=()=>({enterUndoContext(){if(phase==='begin')throw Error('undo begin failed')},leaveUndoContext(){if(phase==='end')throw Error('undo end failed')}})
    assert.throws(()=>f.run('demote'));assert.deepEqual({start:f.view.start,end:f.view.end},original)
    assert.equal(f.dispatchCalls.length,phase==='begin'?0:1);assert.deepEqual(f.ruleWrites,[])
  }
})

test('Restart numbering affects only the first selected paragraph and starts it at one',()=>{
  const f=fixture();const rule=f.list([0,1,2]);const snapshot=plain(rule.levels);f.select(1,2)
  f.run('restart')
  assert.ok(f.writes.every(item=>item.target==='p1'&&['ParaIsNumberingRestart','NumberingStartValue'].includes(item.name)))
  assert.equal(f.paragraphs[1].values.ParaIsNumberingRestart,true);assert.equal(f.paragraphs[1].values.NumberingStartValue,1)
  assert.equal(f.writes.find(item=>item.name==='NumberingStartValue').type,'short');assert.equal(f.paragraphs[2].values.ParaIsNumberingRestart,false)
  assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(plain(rule.levels),snapshot)
})

test('A selection ending at the next paragraph start excludes that paragraph from inspection and writes',()=>{
  const f=fixture();f.select(0,1,{throughNextStart:true});f.paragraphs[2].values.OutlineLevel=4
  f.run('number')
  assert.ok(f.writes.some(item=>item.target==='p0'));assert.ok(f.writes.some(item=>item.target==='p1'));assert.ok(!f.writes.some(item=>item.target==='p2'))
})

test('A collapsed caret still operates on its own paragraph, including at a paragraph start',()=>{
  const f=fixture();f.select(1,1,{collapsed:true});f.run('bullet')
  assert.ok(f.writes.length>0);assert.ok(f.writes.every(item=>item.target==='p1'))
})

test('Mixed list identities or list/plain selections reject before modifying any prefix paragraph',()=>{
  for(const operation of ['remove','promote','demote','restart'])for(const mode of ['different-ids','plain-tail']){
    const f=fixture();f.list([0,1,2],'number',{level:2})
    if(mode==='different-ids')f.paragraphs[2].values.ListId='separate-list'
    else Object.assign(f.paragraphs[2].values,{NumberingRules:null,NumberingStyleName:'',NumberingIsNumber:false,ListId:''})
    assert.throws(()=>f.run(operation));assert.deepEqual(f.writes,[],`${operation}/${mode}`);assert.deepEqual(f.ruleWrites,[])
  }
})

test('Level zero promotion and level eight demotion reject atomically when a later paragraph hits the boundary',()=>{
  for(const [operation,boundary]of[['promote',0],['demote',8]]){
    const f=fixture();f.list([0,1,2],'number',{level:2});f.paragraphs[2].values.NumberingLevel=boundary
    assert.throws(()=>f.run(operation));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
  }
})

test('A shorter imported rule container bounds demotion even below the application level limit',()=>{
  const f=fixture();const rules=f.rules('number',2);f.list([0,1,2],'number',{rules,level:1})
  assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
})

test('Bullet lists cannot restart numbered counting',()=>{
  const f=fixture();f.list([0,1,2],'bullet');assert.throws(()=>f.run('restart'));assert.deepEqual(f.writes,[])
})

test('Read-only documents, multiple selections, objects and foreign text ranges cannot receive list writes',()=>{
  for(const mode of ['readonly','unknown-readonly','missing-readonly','multiple','object','foreign','mismatched-range']){
    const f=fixture()
    if(mode==='readonly')f.readonly=true
    if(mode==='unknown-readonly')f.readonly=undefined
    if(mode==='missing-readonly')delete f.model.isReadonly
    if(mode==='multiple')f.selectionCount=2
    if(mode==='object')f.selectionOverride={getCount:()=>1,getByIndex:()=>({})}
    if(mode==='foreign')f.selectionOverride={getCount:()=>1,getByIndex:()=>({...f.view,getText:()=>({})})}
    if(mode==='mismatched-range')f.selectionOverride={getCount:()=>1,getByIndex:()=>({...f.view,start:1})}
    assert.throws(()=>f.run('number'),undefined,mode);assert.deepEqual(f.writes,[],mode);assert.deepEqual(f.ruleWrites,[],mode)
  }
})

test('Falsy direct NumberingRules values never count as a confirmed absence of a list',()=>{
  for(const value of [undefined,false,0,'']){
    const f=fixture();f.paragraphs[2].values.NumberingRules=value
    assert.throws(()=>f.run('number'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
  }
})

test('Native DEFAULT_VALUE undefined interface properties allow ordinary list creation',()=>{
  // Observed in the bundled native bridge for an unnumbered plain paragraph:
  // TextSection, TextTable and NumberingRules are void + DEFAULT_VALUE, while
  // style/id are empty and NumberingIsNumber is false. This is not a fallback
  // for failed reads or for directly assigned undefined values.
  for(const operation of ['number','bullet'])for(const defaultState of [1,{value:1}]){
    const f=fixture()
    for(const paragraph of f.paragraphs)for(const name of ['TextSection','TextTable','NumberingRules']){
      paragraph.values[name]=undefined;paragraph.states[name]=defaultState
    }
    f.run(operation)
    assert.equal(f.created.length,1)
    assert.deepEqual(f.writes.filter(item=>item.name==='NumberingRules').map(item=>item.target),['p0','p1','p2'])
    assert.ok(f.writes.every(item=>['NumberingRules','NumberingLevel'].includes(item.name)))
    assert.ok(f.ruleWrites.every(item=>item.rules===f.created[0]))
  }
})

test('Nullable interface normalization rejects direct void, unknown states and non-void false values atomically',()=>{
  for(const name of ['TextSection','TextTable','NumberingRules']){
    for(const state of [0,2,99,undefined]){
      const f=fixture(),target=f.paragraphs[2],getState=target.getPropertyState.bind(target)
      target.values[name]=undefined
      target.getPropertyState=key=>key===name?state:getState(key)
      assert.throws(()=>f.run('number'),undefined,`${name} / ${String(state)}`)
      assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
    }
    for(const value of [false,0,'']){
      const f=fixture();f.paragraphs[2].values[name]=value;f.paragraphs[2].states[name]=1
      assert.throws(()=>f.run('number'),undefined,`${name} / ${String(value)}`)
      assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
    }
  }
})

test('Matching list identity text does not authorize skipping a distinct later rules object',()=>{
  const f=fixture();f.list([0,1],'number',{level:2});const tail=f.list([2],'number',{level:2})
  tail.levels[1].find(item=>item.Name==='Prefix').Value='Chapter '
  assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
})

test('Headings, sections and tables in a later paragraph refuse the full batch without writes',()=>{
  for(const [property,value]of[['OutlineLevel',1],['TextSection',{}],['TextTable',{}]]){
    const f=fixture();f.paragraphs[2].values[property]=value
    assert.throws(()=>f.run('bullet'));assert.deepEqual(f.writes,[],property);assert.deepEqual(f.ruleWrites,[])
  }
})

test('Paragraph count and selected text inspection have hard limits before any mutation',()=>{
  for(const texts of [Array.from({length:101},()=> 'a'),['a'.repeat(65537)]]){
    const f=fixture(texts);assert.throws(()=>f.run('number'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
  }
})

test('Missing, ambiguous and invalid authoritative paragraph metadata never becomes a permissive fallback',()=>{
  const fields=['OutlineLevel','TextSection','TextTable','NumberingRules','NumberingStyleName','NumberingLevel','ListId','NumberingIsNumber','ParaIsNumberingRestart','NumberingStartValue']
  for(const property of fields)for(const mode of ['missing','ambiguous']){
    const f=fixture();f.list([0,1,2],'number',{level:2})
    if(mode==='missing')delete f.paragraphs[2].values[property];else f.paragraphs[2].states[property]=2
    assert.throws(()=>f.run('demote'),undefined,`${property}/${mode}`);assert.deepEqual(f.writes,[],`${property}/${mode}`)
  }
  for(const [property,value]of[['NumberingLevel',-1],['NumberingLevel',9],['NumberingLevel',NaN],['NumberingLevel',1.5],['NumberingStyleName',undefined],['ListId',''],['NumberingIsNumber',false],['ParaIsNumberingRestart','false'],['NumberingStartValue','1']]){
    const f=fixture();f.list([0,1,2],'number',{level:2});f.paragraphs[2].values[property]=value
    assert.throws(()=>f.run('demote'),undefined,property);assert.deepEqual(f.writes,[],property)
  }
})

test('Complex or unknown level definitions are refused without rewriting shared imported rules',()=>{
  const mutations=[
    rule=>rule.levels[1].push({Name:'GraphicBitmap',Value:{}}),
    rule=>rule.levels[1].push({Name:'GraphicURL',Value:'file:///external.png'}),
    rule=>rule.levels[1].push({Name:'UnknownImportedProperty',Value:1}),
    rule=>rule.levels[1].push({Name:'NumberingType',Value:4}),
    ...[['ParentNumbering',2],['Prefix','Chapter '],['ListFormat','%1%.%2%.'],['NumberingType',1],['NumberingType',undefined]].map(([name,value])=>rule=>{rule.levels[1].find(item=>item.Name===name).Value=value}),
    rule=>{rule.values.NumberingIsOutline=true},
  ]
  for(const mutate of mutations){
    const f=fixture();const rule=f.list([0,1,2],'number',{level:2});mutate(rule);const before=plain(rule.levels)
    assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(plain(rule.levels),before)
  }
})

test('An unused tenth rule slot still cannot hide image, parent-linked or unknown numbering definitions',()=>{
  for(const properties of [
    {GraphicBitmap:{}},{GraphicURL:'file:///external.png'},{UnknownImportedProperty:1},
    {ParentNumbering:2},{Prefix:'Chapter '},{ListFormat:'%1%.%10%.'},{NumberingType:1},
  ]){
    const f=fixture(),rule=f.list([0,1,2],'number',{level:2});levelProperties(rule,9,properties)
    const before=plain(rule.levels)
    assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
    assert.deepEqual(f.selectionCalls,[]);assert.deepEqual(plain(rule.levels),before)
  }
})

test('The exact native DOCX Symbol dot mapping stays editable while preserving all imported rule levels',()=>{
  for(const charSet of [10,{value:10}])for(const operation of ['promote','demote','remove']){
    const f=fixture(),rule=docxSymbolRules(f,charSet);f.list([0,1,2],'bullet',{rules:rule,level:2});f.select(0,1)
    const before=plain(rule.levels)
    f.run(operation)
    assert.deepEqual(plain(rule.levels),before);assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(f.created,[])
    assert.ok(!f.writes.some(item=>item.name==='NumberingRules'||item.name==='NumberingLevel'))
    if(operation==='remove')assert.deepEqual(f.writes.map(item=>item.target),['p0','p1'])
    else assert.deepEqual(f.dispatchCalls[0].paragraphs,[0,1])
    assert.equal(f.paragraphs[2].values.NumberingLevel,2);assert.equal(f.paragraphs[2].values.NumberingStyleName,'Simple')
  }
})

test('Native ODT ordinary bullets accept only their own level placeholder without rewriting shared rules',()=>{
  for(const glyph of ['•','●','◦','▪','–','-']){
    const f=fixture(),rule=f.rules('bullet')
    for(let index=0;index<10;index++)levelProperties(rule,index,{BulletChar:glyph,BulletFontName:'',ListFormat:`%${index+1}%`})
    f.list([0,1,2],'bullet',{rules:rule,level:2});f.select(0,1);const before=plain(rule.levels)
    f.run('demote')
    assert.deepEqual(f.dispatchCalls[0].paragraphs,[0,1]);assert.deepEqual(f.paragraphs.map(item=>item.values.NumberingLevel),[3,3,2])
    assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(f.created,[]);assert.deepEqual(plain(rule.levels),before)
    assert.ok(f.writes.every(item=>item.target==='dispatch'))
  }
})

test('ODT bullet placeholder compatibility never allows other-level references, linked formats or decorated symbols',()=>{
  for(const properties of [
    {ListFormat:'%1%'},{ListFormat:'%8%%8%'},{ListFormat:'%7%%8%'},{ListFormat:'%8%.'},
    {ListFormat:'label %8%'},{ListFormat:'%8% tail'},{Prefix:'Chapter '},{Suffix:'.'},
    {BulletChar:'☆'},{BulletChar:'\uF123'},{ParentNumbering:2},
  ]){
    const f=fixture(),rule=f.rules('bullet')
    for(let index=0;index<10;index++)levelProperties(rule,index,{BulletFontName:'',ListFormat:`%${index+1}%`})
    levelProperties(rule,7,properties);f.list([0,1,2],'bullet',{rules:rule,level:2});const before=plain(rule.levels)
    assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
    assert.deepEqual(f.selectionCalls,[]);assert.deepEqual(plain(rule.levels),before)
  }
})

test('Every component of the native Symbol mapping is required; unknown glyphs or fonts refuse the entire selection',()=>{
  const mutations=[
    ...['BulletChar','BulletFontName','BulletFont','Suffix','ListFormat'].map(name=>rule=>{rule.levels[7]=rule.levels[7].filter(item=>item.Name!==name)}),
    ...[
      {BulletChar:'\uF0B8'},{BulletChar:'\uF123'},{BulletChar:'•'},
      {BulletFontName:'Symbol'},{BulletFontName:'Wingdings'},{BulletFontName:undefined},
      {BulletFont:null},{BulletFont:{Name:'Symbol'}},{BulletFont:{CharSet:10}},
      {BulletFont:{Name:'Wingdings',CharSet:10}},{BulletFont:{Name:'Unknown',CharSet:10}},
      {BulletFont:{Name:'Symbol',CharSet:0}},{BulletFont:{Name:'Symbol',CharSet:'10'}},
      {Suffix:''},{Suffix:'\uF0B8'},{ListFormat:''},{ListFormat:'%8%.'},
    ].map(properties=>rule=>levelProperties(rule,7,properties)),
  ]
  for(const mutate of mutations){
    const f=fixture(),rule=docxSymbolRules(f);f.list([0,1,2],'bullet',{rules:rule,level:2});mutate(rule)
    const before=plain(rule.levels)
    assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
    assert.deepEqual(f.selectionCalls,[]);assert.deepEqual(plain(rule.levels),before)
  }
})

test('An ordinary bullet may have a decimal tenth default slot without becoming a numbered list',()=>{
  const f=fixture(),rule=f.rules('bullet');rule.levels[9]=plain(f.rules('number').levels[9])
  f.list([0,1,2],'bullet',{rules:rule,level:2});const before=plain(rule.levels)
  f.run('bullet');assert.deepEqual(f.writes,[]);assert.deepEqual(f.created,[])
  assert.throws(()=>f.run('restart'));assert.deepEqual(f.writes,[])
  f.run('demote');assert.deepEqual(f.paragraphs.map(item=>item.values.NumberingLevel),[3,3,3])
  assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(plain(rule.levels),before)
})

test('Only the unused tenth slot may differ; mixed basic kinds among levels zero through eight still refuse',()=>{
  for(const index of [1,4,8]){
    const f=fixture(),rule=docxSymbolRules(f);rule.levels[index]=plain(f.rules('number').levels[index])
    f.list([0,1,2],'bullet',{rules:rule,level:2})
    assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[]);assert.deepEqual(f.selectionCalls,[])
  }
})

test('The DOCX tenth default slot remains outside the editable paragraph level range',()=>{
  for(const [level,operation]of[[9,'remove'],[9,'promote'],[8,'demote']]){
    const f=fixture(),rule=docxSymbolRules(f);f.list([0,1,2],'bullet',{rules:rule,level})
    const before=plain(rule.levels)
    assert.throws(()=>f.run(operation));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
    assert.deepEqual(f.selectionCalls,[]);assert.deepEqual(plain(rule.levels),before)
  }
})

test('Allowing the DOCX decimal default slot never allows images or parent-linked metadata in that slot',()=>{
  for(const properties of [{GraphicBitmap:{}},{GraphicURL:'file:///dot.png'},{ParentNumbering:2},{ListFormat:'%1%.%10%.'},{NumberingType:1}]){
    const f=fixture(),rule=docxSymbolRules(f);levelProperties(rule,9,properties);f.list([0,1,2],'bullet',{rules:rule,level:2})
    assert.throws(()=>f.run('demote'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
  }
})

test('Unknown, excessive or failing rule containers abort before the first paragraph write',()=>{
  for(const mode of ['missing-count','missing-index','zero-count','too-many','undefined-count','throws','invalid-level']){
    const f=fixture();const rule=f.list([0,1,2],'number',{level:2})
    if(mode==='missing-count')delete rule.getCount
    if(mode==='missing-index')delete rule.getByIndex
    if(mode==='zero-count')rule.getCount=()=>0
    if(mode==='too-many')rule.getCount=()=>11
    if(mode==='undefined-count')rule.getCount=()=>undefined
    if(mode==='throws')rule.getByIndex=()=>{throw Error('native rules read failed')}
    if(mode==='invalid-level')rule.getByIndex=()=>null
    assert.throws(()=>f.run('demote'),undefined,mode);assert.deepEqual(f.writes,[],mode);assert.deepEqual(f.ruleWrites,[],mode)
  }
})

test('A stale selection identifier rejects even an otherwise valid basic list operation',()=>{
  const f=fixture();f.list([0,1,2],'number',{level:2})
  assert.throws(()=>f.api.action({type:'list',operation:'demote',expectedSelectionId:'outdated'}));assert.deepEqual(f.writes,[])
})

test('List display caches only one current rule level until the document revision changes',()=>{
  const f=fixture();f.list([0,1,2]);f.select(0,0,{collapsed:true});f.showList(0)
  assert.deepEqual(plain(f.api.state().list),{kind:'number',level:0})
  assert.equal(f.ruleReads.length,1);assert.equal(f.ruleReads[0].index,0)
  f.api.state();f.api.state();assert.equal(f.ruleReads.length,1,'Unchanged toolbar refreshes reuse the summary')
  f.paragraphs[0].values.NumberingLevel=2;f.showList(0);f.revision++
  assert.deepEqual(plain(f.api.state().list),{kind:'number',level:2})
  assert.equal(f.ruleReads.length,2);assert.equal(f.ruleReads[1].index,2)
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.ruleWrites,[])
})

test('Moving the selection invalidates the cheap list summary without requiring a revision change',()=>{
  const f=fixture();f.list([0],'number');f.list([1],'bullet',{id:'second-list',level:3})
  f.select(0,0,{collapsed:true});f.showList(0);const first=f.api.state()
  f.select(1,1,{collapsed:true});f.showList(1);const second=f.api.state()
  assert.notEqual(first.selection.id,second.selection.id)
  assert.deepEqual(plain(first.list),{kind:'number',level:0});assert.deepEqual(plain(second.list),{kind:'bullet',level:3})
  assert.equal(f.ruleReads.length,2);assert.deepEqual(f.writes,[])
})

test('A local list edit clears cached display before delayed notifications and native undo revision refreshes it',()=>{
  const f=fixture();f.list([0,1,2]);f.select(0,0,{collapsed:true});f.showList(0)
  assert.equal(f.api.state().list.level,0)
  f.run('demote');f.showList(0)
  assert.equal(f.revision,0,'The mock has not delivered a native modify notification')
  assert.equal(f.api.state().list.level,1,'Local edits invalidate their cached summary immediately')
  const beforeUndo=f.ruleReads.length
  // Native undo itself is covered by real UI tests; here simulate its restored
  // authoritative state and monotonic modify revision, not a sidebar replay.
  f.paragraphs[0].values.NumberingLevel=0;f.showList(0);f.revision++
  assert.equal(f.api.state().list.level,0);assert.equal(f.ruleReads.length,beforeUndo+1)
  f.paragraphs[0].values.NumberingLevel=1;f.showList(0);f.revision++
  assert.equal(f.api.state().list.level,1)
})

test('Unknown or mixed display metadata is reported explicitly and never used as mutation authorization',()=>{
  for(const [state,kind]of[[2,'mixed'],[99,'other']]){
    const f=fixture();f.list([0,1,2]);f.select(0,0,{collapsed:true});f.showList(0);f.view.states.NumberingRules=state
    assert.deepEqual(plain(f.api.state().list),{kind,level:null});assert.equal(f.ruleReads.length,0);assert.deepEqual(f.writes,[])
  }
})

test('List display recognizes native default void rules but keeps direct void and unknown metadata distinct',()=>{
  for(const [state,kind]of[[1,'none'],[{value:1},'none'],[0,'other'],[2,'mixed'],[99,'other'],[undefined,'other']]){
    const f=fixture();f.select(0,0,{collapsed:true});f.showList(0)
    f.view.values.NumberingRules=undefined
    const getState=f.view.getPropertyState.bind(f.view)
    f.view.getPropertyState=name=>name==='NumberingRules'?state:getState(name)
    assert.deepEqual(plain(f.api.state().list),{kind,level:null})
    assert.equal(f.ruleReads.length,0);assert.deepEqual(f.writes,[])
  }
  for(const value of [false,0,'']){
    const f=fixture();f.select(0,0,{collapsed:true});f.showList(0)
    f.view.values.NumberingRules=value;f.view.states.NumberingRules=1
    assert.deepEqual(plain(f.api.state().list),{kind:'other',level:null});assert.deepEqual(f.writes,[])
  }
})
