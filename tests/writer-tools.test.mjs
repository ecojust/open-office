import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// API-boundary tests of the real helper with observable UNO doubles. Actual
// Writer rendering/editability/DOCX/ODT compatibility is tested separately by
// tests/browser/writer-workbench.cjs, not by these doubles.
const source = await readFile(new URL('../public/office/writer-tools.js', import.meta.url), 'utf8')
function fixture() {
  const writes = [], reads = [], errors = []
  class Any { constructor(type, value) { this.type = type; this.value = value } }
  class Struct { constructor(fields) { Object.assign(this, fields) } }
  const props = (initial, label) => ({
    values: { ...initial },
    getPropertySetInfo() { return { hasPropertyByName: name => name in this.values, getProperties:()=>Object.keys(this.values).map(Name=>({Name})) } },
    getPropertyValue(name) { assert.ok(name in this.values, 'Must preflight optional UNO properties'); reads.push(`${label}.${name}`); return this.values[name] },
    setPropertyValue(name, value) { writes.push([label, name, value]); this.values[name] = value instanceof Any ? value.value : value },
  })
  let selectionText=''
  const owner = { createEnumeration:()=>enumeration([]), createTextCursorByRange: () => ({ gotoRange() {}, getString:()=>selectionText }), compareRegionStarts: () => 0, compareRegionEnds: () => 0 }
  const view = Object.assign(props({ PageStyleName: 'Standard', ParaAdjust: 0, CharHeight: 12, CharHeightAsian: 12, CharHeightComplex: 12,
    CharWeight: 100, CharWeightAsian: 100, CharWeightComplex: 100, CharColor: 0, CharBackColor: -1, CharBackTransparent: true }, 'view'), {
    getText: () => owner, getStart: () => view, getEnd: () => view, getString: () => '', isCollapsed: () => true, getPropertyState:()=>0,
  })
  const page = props({ Width: 21000, Height: 29700, IsLandscape: false, LeftMargin: 2000, RightMargin: 2000,
    TopMargin: 2000, BottomMargin: 2000, HeaderIsOn: false, FooterIsOn: false }, 'page')
  const tableCells = [[{ getString:()=>'', setString(value) { writes.push(['cell',0,0,value]) } },{getString:()=>'',setString(value){writes.push(['cell',0,1,value])}}]]
  const table = { getRows:()=>({getCount:()=>1}),getColumns:()=>({getCount:()=>2}),getCellByName:name=>tableCells[0][name.charCodeAt(0)-65] }
  const controller = { getViewCursor:()=>view, getSelection:()=>({getCount:()=>1,getByIndex:()=>view}) };
  const model = { supportsService:()=>true,getText:()=>owner,getCurrentController:()=>controller,
    getStyleFamilies:()=>({getByName:()=>({getElementNames:()=>[],hasByName:name=>name==='Standard',getByName:()=>page})}),
    getTextFields:()=>({createEnumeration:()=>enumeration([])}),getRedlines:()=>({createEnumeration:()=>enumeration([])}),getFootnotes:()=>({getCount:()=>0}),getDocumentIndexes:()=>({getCount:()=>0}),
    getTextTables:()=>({getElementNames:()=>['Table1'],hasByName:name=>name==='Table1',getByName:()=>table}),
  }
  let modelReads=0, revision=0, dispatchHandler=null
  const context = vm.createContext({ WebAssembly, Error, URL })
  vm.runInContext(source,context)
  const api=context.createWriterTools({ getModel:()=>{modelReads++;return model}, getRevision:()=>revision, css:{beans:{PropertyValue:Struct},awt:{FontSlant:{ITALIC:2,NONE:0}},style:{LineSpacing:Struct,LineSpacingMode:{PROP:0}}},
    zetajs:{Any,type:{float:'float',short:'short',byte:'byte'},sameUnoObject:(a,b)=>a===b,catchUnoException:error=>{errors.push(error);return {Message:'optional'}}},
    dispatch:(command,args)=>{writes.push(['dispatch',command,args]);dispatchHandler?.(command,args)} })
  return {api,writes,reads,view,page,model,controller,errors,tableCells,set selectionText(value){selectionText=value},set revision(value){revision=value},set dispatchHandler(fn){dispatchHandler=fn},get modelReads(){return modelReads}}
}
function rejectsBeforeModel(data) {
  const h=fixture()
  assert.throws(()=>h.api.action(data))
  assert.equal(h.modelReads,0,'Invalid input must be rejected before inspecting or mutating the document')
  assert.deepEqual(h.writes,[])
}

test('writer exposes only its documented actions and rejects arbitrary native commands',()=>{
  const h=fixture()
  assert.ok(h.api.allowedTypes.has('insert-table'))
  for(const payload of [null,[],{}, {type:'dispatch',command:'.uno:Save'}, {type:'insert-text',text:'x',path:'/tmp/out'}, {type:'update-indexes',script:'x'}]) rejectsBeforeModel(payload)
})
test('text and character formatting validate lengths, exact types, colors and finite bounds',()=>{
  for(const payload of [{type:'insert-text',text:'x'.repeat(20001)},{type:'insert-text',text:'\0'}, {type:'insert-text',text:12},
    {type:'format-text'}, {type:'format-text',fontName:''}, {type:'format-text',fontSize:0}, {type:'format-text',fontSize:301},
    {type:'format-text',fontSize:NaN}, {type:'format-text',fontSize:Infinity}, {type:'format-text',bold:'true'},
    {type:'format-text',color:'#FFF'}, {type:'format-text',highlight:'red'}]) rejectsBeforeModel(payload)
})
test('all paragraph/page fields are prevalidated rather than partially applying valid prefixes',()=>{
  for(const payload of [{type:'format-paragraph',align:'middle'},{type:'format-paragraph',outlineLevel:11}, {type:'format-paragraph',lineSpacingPercent:79},
    {type:'format-paragraph',leftIndent:4,firstLineIndent:-101},{type:'set-page',width:210,height:49},
    {type:'set-page',landscape:1},{type:'set-page',marginLeft:501}, {type:'set-page',height:'297'}]) rejectsBeforeModel(payload)
})
test('table grids reject sparse rows/cells, inconsistent dimensions and oversized content',()=>{
  for(const payload of [{type:'insert-table',rows:0,columns:2},{type:'insert-table',rows:51,columns:2}, {type:'insert-table',rows:2,columns:21},
    {type:'insert-table',rows:2,columns:2,cells:[['a','b']]},{type:'insert-table',rows:1,columns:2,cells:[['a']]},
    {type:'insert-table',rows:1,columns:2,cells:[['a',,'b']]},{type:'insert-table',rows:1,columns:1,cells:new Array(1)},
    {type:'update-table',name:'Table1',cells:[]},{type:'update-table',name:'Table1',cells:[['a','x'.repeat(2001)]]}]) rejectsBeforeModel(payload)
})
test('review/index/find/header/footer requests reject unsupported or unsafe values before writing',()=>{
  for(const payload of [{type:'insert-comment',author:'',text:'note'},{type:'insert-comment',author:'A',text:'x'.repeat(5001)},
    {type:'set-track-changes'}, {type:'set-track-changes',enabled:'true'}, {type:'insert-toc',levels:11},
    {type:'insert-footnote',text:'note',endnote:1}, {type:'find-replace',search:''}, {type:'find-replace',search:'a',all:true},
    {type:'find-replace',search:'a',regex:true}, {type:'set-header-footer',target:'document',enabled:true},
    {type:'insert-page-number',target:'footer',align:'justify'},{type:'insert-break',kind:'section'}]) rejectsBeforeModel(payload)
})
test('invalid document/selection revision guards are rejected at the schema boundary',()=>{
  for(const payload of [{type:'insert-text',text:'a',expectedRevision:-1},{type:'insert-text',text:'a',expectedRevision:1.5},
    {type:'insert-text',text:'a',expectedSelectionId:''}]) rejectsBeforeModel(payload)
  const h=fixture()
  assert.throws(()=>h.api.action({type:'format-text',fontSize:16,expectedSelectionId:'stale'}),/选区已改变/)
  assert.deepEqual(h.writes,[])
})
test('valid character formatting produces real property writes with native numeric widths',()=>{
  const h=fixture()
  h.api.action({type:'format-text',fontSize:18,bold:true,color:'#2356A0',highlight:null})
  assert.ok(h.writes.some(([,key,value])=>key==='CharHeight'&&value.type==='float'&&value.value===18))
  assert.equal(h.view.values.CharWeight,150);assert.equal(h.view.values.CharColor,0x2356A0);assert.equal(h.view.values.CharBackTransparent,true)
})
test('unsupported target property rejects the whole format operation without partial writes',()=>{
  const h=fixture();delete h.view.values.CharHeightComplex
  assert.throws(()=>h.api.action({type:'format-text',bold:true,fontSize:16}),/不支持/)
  assert.deepEqual(h.writes,[])
})
test('page margins reserve a usable text area and orientation swaps native dimensions',()=>{
  const h=fixture()
  assert.throws(()=>h.api.action({type:'set-page',marginLeft:110,marginRight:110}),/页边距过大/)
  assert.deepEqual(h.writes,[])
  h.api.action({type:'set-page',landscape:true,marginLeft:22})
  assert.equal(h.page.values.Width,29700);assert.equal(h.page.values.Height,21000);assert.equal(h.page.values.LeftMargin,2200);assert.equal(h.page.values.IsLandscape,true)
})
test('applying unchanged page geometry performs no native writes or fake modifications',()=>{
  const h=fixture()
  h.api.action({type:'set-page',width:210,height:297,landscape:false,marginLeft:20,marginRight:20,marginTop:20,marginBottom:20})
  assert.deepEqual(h.writes,[])
  h.api.action({type:'set-page',marginLeft:22})
  assert.deepEqual(h.writes,[['page','LeftMargin',2200]])
})
test('table update checks the existing table dimensions before touching any cell',()=>{
  const h=fixture()
  assert.throws(()=>h.api.action({type:'update-table',name:'Table1',cells:[['a'],['b']]}),/行数不一致|列数/)
  assert.deepEqual(h.writes,[])
  h.api.action({type:'update-table',name:'Table1',cells:[['甲','乙']]})
  assert.deepEqual(h.writes,[['cell',0,0,'甲'],['cell',0,1,'乙']])
})

test('review/comment commands reject arbitrary slots, invalid indices and unbounded scopes',()=>{
  for(const payload of [{type:'review-changes',decision:'accept',scope:'document'},
    {type:'review-changes',decision:'accept',scope:'all',command:'.uno:Save'},
    {type:'review-changes',decision:'delete',scope:'all'}, {type:'navigate-comment',index:-1},
    {type:'delete-comment',index:100},{type:'delete-comment',index:0.5}]) rejectsBeforeModel(payload)
})
function enumeration(items) { let i=0;return {hasMoreElements:()=>i<items.length,nextElement:()=>items[i++] } }
test('accept/reject uses exact synchronous slots and checks the native redline result',()=>{
  for(const [decision,scope,command] of [['accept','all','.uno:AcceptAllTrackedChanges'],['reject','all','.uno:RejectAllTrackedChanges'],
    ['accept','selection','.uno:AcceptTrackedChange'],['reject','selection','.uno:RejectTrackedChange']]) {
    const h=fixture();let count=2
    h.model.getRedlines=()=>({createEnumeration:()=>enumeration(Array(count).fill({}))})
    h.dispatchHandler=()=>{count=scope==='all'?0:1}
    const result=h.api.action({type:'review-changes',decision,scope})
    assert.equal(h.writes[0][1],command)
    assert.equal(h.writes[0][2][0].Name,'SynchronMode');assert.equal(h.writes[0][2][0].Value,true)
    assert.match(result.message,/已接受|已拒绝/)
  }
  const h=fixture();h.model.getRedlines=()=>({createEnumeration:()=>enumeration([{}])})
  assert.throws(()=>h.api.action({type:'review-changes',decision:'accept',scope:'all'}),/未处理修订/)
})
test('accepting a partial change may split its redline and must have native mutation evidence',()=>{
  const h=fixture();let count=1
  h.model.getRedlines=()=>({createEnumeration:()=>enumeration(Array(count).fill({}))})
  h.dispatchHandler=()=>{count=2;h.revision=1}
  assert.match(h.api.action({type:'review-changes',decision:'accept',scope:'selection'}).message,/接受当前选区/)
})
test('deleting an annotation removes only its text field, never its body anchor text',()=>{
  const h=fixture(), anchor={getText:()=>({removeTextContent:field=>h.writes.push(['remove',field])})}
  const annotation={supportsService:()=>true,getAnchor:()=>anchor}
  h.model.getTextFields=()=>({createEnumeration:()=>enumeration([annotation])})
  h.api.action({type:'delete-comment',index:0})
  assert.equal(h.writes[0][0],'remove');assert.equal(h.writes[0][1],annotation)
  assert.throws(()=>h.api.action({type:'delete-comment',index:1}),/批注已变化/)
})
test('catalog cache is revision-bound while selection character properties stay live',()=>{
  const h=fixture();let scans=0
  h.model.getStyleFamilies=()=>({getByName:name=>name==='PageStyles'
    ? {hasByName:()=>true,getByName:()=>h.page}
    : {getElementNames:()=>['Standard'],getByName:()=>({getPropertySetInfo:()=>({hasPropertyByName:()=>false})})}})
  h.model.getText=()=>({createEnumeration:()=>{scans++;return enumeration([])}})
  h.model.getTextTables=()=>({getElementNames:()=>[]})
  h.model.getTextFields=()=>({createEnumeration:()=>enumeration([])})
  h.model.getRedlines=()=>({createEnumeration:()=>enumeration([])})
  h.model.getFootnotes=()=>({getCount:()=>0});h.model.getDocumentIndexes=()=>({getCount:()=>0})
  assert.equal(h.api.state().textStyle.fontSize,12)
  h.selectionText='table-cell range';h.view.getString=()=>''
  assert.equal(h.api.state().selection.text,'table-cell range','View cursor text is intentionally empty for Writer TableText; read the owning XText range')
  h.view.values.CharHeight=24
  assert.equal(h.api.state().textStyle.fontSize,24);assert.equal(scans,1)
  h.revision=1;h.api.state();assert.equal(scans,2)
  h.api.action({type:'format-text',fontSize:20});h.api.state();assert.equal(scans,3,'Local edits invalidate before delayed model callbacks')
})
test('editing one table cell leaves rich text and fields in unchanged cells untouched',()=>{
  const h=fixture();h.tableCells[0][0].getString=()=>'keep rich text';h.tableCells[0][1].getString=()=>'old'
  h.api.action({type:'update-table',name:'Table1',cells:[['keep rich text','new']]})
  assert.deepEqual(h.writes,[['cell',0,1,'new']])
})
test('unchanged header/footer preview never replaces native page-number fields',()=>{
  const h=fixture();h.page.values.FooterIsOn=true
  h.page.values.FooterText={getString:()=>'Page 1',setString:value=>h.writes.push(['flattened',value])}
  h.api.action({type:'set-header-footer',target:'footer',enabled:true,text:'Page 1'})
  assert.ok(!h.writes.some(([name])=>name==='flattened'))
  h.page.values.FooterText.getString=()=>'x'.repeat(5001)
  h.writes.length=0
  assert.throws(()=>h.api.action({type:'set-header-footer',target:'footer',enabled:true,text:'x'.repeat(5000)}),/截断内容/)
  assert.deepEqual(h.writes,[],'Oversized original must be rejected before the first write')
})
test('disabling a native header/footer requires explicit removal confirmation even with an empty preview',()=>{
  const h=fixture();h.page.values.FooterIsOn=true;h.page.values.FooterText={getString:()=>''}
  assert.throws(()=>h.api.action({type:'set-header-footer',target:'footer',enabled:false}),/确认删除/)
  assert.deepEqual(h.writes,[])
  h.api.action({type:'set-header-footer',target:'footer',enabled:false,confirmRemoval:true})
  assert.equal(h.page.values.FooterIsOn,false)
  rejectsBeforeModel({type:'set-header-footer',target:'footer',enabled:false,confirmRemoval:'yes'})
})
function decorationFixture(groups, target='footer') {
  const h=fixture(),runs=groups.map(group=>group.map(item=>typeof item==='string'?{text:item,type:'Text',link:''}:{link:'',...item}));
  const owner={getString:()=>runs.map(group=>group.map(run=>run.text).join('')).join('\n'),createEnumeration:()=>enumeration(runs.map(group=>({supportsService:name=>name==='com.sun.star.text.Paragraph',getString:()=>group.map(run=>run.text).join(''),createEnumeration:()=>enumeration(group.map(run=>({getString:()=>run.text,getStart:()=>run,getPropertyValue:name=>name==='TextPortionType'?run.type:run.link})))}))),
    createTextCursorByRange:run=>{let start=0,end=0;return{goRight(count,expand){const next=end+count;if(next>run.text.length)return false;end=next;if(!expand)start=end;return true},collapseToEnd(){start=end},getString:()=>run.text.slice(start,end),setString:value=>{h.writes.push(['decoration-run',run.text,start,end,value]);run.text=run.text.slice(0,start)+value+run.text.slice(end)}}},
    setString:value=>h.writes.push(['flattened-decoration',value]),
  };
  const prefix=target==='header'?'Header':'Footer';h.page.values[prefix+'IsOn']=true;h.page.values[prefix+'Text']=owner;
  return {...h,owner,runs,apply:value=>h.api.action({type:'set-header-footer',target,enabled:true,text:value})};
}
test('Header and footer edits replace only a proven plain run and never flatten field or hyperlink text',()=>{
  for(const target of ['header','footer']){
    const h=decorationFixture([['Report ','Page ',{type:'TextField',text:'1'},{type:'Text',text:' Help',link:'https://example.com'},' tail']],target);
    h.apply('Review Page 1 Help tail');assert.equal(h.owner.getString(),'Review Page 1 Help tail');assert.equal(h.writes.length,1);assert.deepEqual(h.writes[0],['decoration-run','Report ',2,6,'view']);
    assert.equal(h.runs[0][2].text,'1');assert.equal(h.runs[0][3].link,'https://example.com');
  }
});
test('Plain run insertion seeds existing formatting and unchanged paragraphs stay untouched',()=>{
  const h=decorationFixture([['Report '],['第二段']]);h.apply('Re新port \n第二段');assert.equal(h.writes.length,1);assert.deepEqual(h.writes[0],['decoration-run','Report ',2,3,'新p']);
  h.writes.length=0;h.apply('Re新port \n第二篇');assert.equal(h.writes.length,1);assert.deepEqual(h.writes[0],['decoration-run','第二段',2,3,'篇']);
  const empty=decorationFixture([['']]);empty.apply('新的页脚');assert.equal(empty.owner.getString(),'新的页脚');assert.equal(empty.writes.length,1);
});
test('Changing fields, links, formatting boundaries or paragraph structure refuses before any write',()=>{
  const original='Report Page 1 Help tail';
  for(const next of ['Report Page 2 Help tail','Report Page 1 Docs tail','New title 1 Help tail','Report Page 1X Help tail','Report\nPage 1 Help tail','']){
    const h=decorationFixture([['Report ','Page ',{type:'TextField',text:'1'},{type:'Text',text:' Help',link:'https://example.com'},' tail']]);
    assert.throws(()=>h.apply(next),/字段.*画布/);assert.equal(h.owner.getString(),original);assert.deepEqual(h.writes,[]);
  }
});
test('Zero-width decorations and ambiguous insertion boundaries cannot be absorbed into a text edit',()=>{
  for(const groups of [[['Hello',{type:'Bookmark',text:''},' world']],[['Hello',{type:'Frame',text:''},' world']],[['Hello',' world']]]){
    const h=decorationFixture(groups);assert.throws(()=>h.apply('Hello! world'),/画布/);assert.deepEqual(h.writes,[]);
  }
  const h=decorationFixture([[{type:'Bookmark',text:''},'Hello']]);assert.throws(()=>h.apply('Jello'),/画布/);assert.deepEqual(h.writes,[]);
});
test('Decoration edits cannot remove or replace soft line breaks inside one native text run',()=>{
  for(const separator of ['\n','\r','\v','\f','\u0085','\u2028','\u2029']){
    for(const next of ['Helloworld','Hello world']){
      const h=decorationFixture([['Hello'+separator+'world']]);
      assert.throws(()=>h.apply(next),/画布/);assert.deepEqual(h.writes,[]);
    }
  }
});
test('Decoration inspection limits and inconsistent expanded text fail closed',()=>{
  for(const groups of [Array.from({length:65},()=>['x']),[Array.from({length:129},()=> 'x')]]){
    const h=decorationFixture(groups);assert.throws(()=>h.apply('y'+h.owner.getString().slice(1)),/画布/);assert.deepEqual(h.writes,[]);
  }
  const h=decorationFixture([['Hello']]);h.owner.getString=()=> 'Unknown Hello';assert.throws(()=>h.apply('Unknown Jello'),/画布/);assert.deepEqual(h.writes,[]);
});
test('Decoration diffs use complete Unicode code points and verify native cursor text before writing',()=>{
  const h=decorationFixture([['甲😀乙']]);h.apply('甲😺乙');assert.deepEqual(h.writes,[['decoration-run','甲😀乙',1,3,'😺']]);
  const failed=decorationFixture([['Hello']]);failed.owner.createTextCursorByRange=()=>({goRight:()=>true,getString:()=> 'wrong',collapseToEnd(){},setString:value=>failed.writes.push(value)});
  assert.throws(()=>failed.apply('Hallo'),/画布/);assert.deepEqual(failed.writes,[]);
});
function casFixture() {
  const h=fixture()
  for(let index=0;index<2;index++) {
    const cell=h.tableCells[0][index];cell.value=index?'B':'A';cell.weight=100;cell.portionType='Text'
    cell.getString=()=>cell.value;cell.setString=value=>{h.writes.push(['cell',0,index,value]);cell.value=value}
    const properties=values=>({getPropertySetInfo:()=>({getProperties:()=>Object.keys(values()).map(Name=>({Name})),hasPropertyByName:name=>name in values()}),getPropertyValue:name=>values()[name]})
    const run={...properties(()=>({TextPortionType:cell.portionType,CharWeight:cell.weight})),getString:()=>cell.value}
    const paragraph={...properties(()=>({ParaStyleName:'Standard'})),supportsService:()=>true,createEnumeration:()=>enumeration([run])}
    cell.createEnumeration=()=>enumeration([paragraph])
  }
  const baseline=h.api.data({type:'table',name:'Table1'})
  const action=cells=>({type:'update-table',name:'Table1',cells,expectedRevision:0,expectedTableId:baseline.tableId,expectedCells:baseline.cells,expectedCellSignatures:baseline.cellSignatures})
  return {...h,baseline,action}
}
test('table compare-and-set writes only user-changed cells and preserves unrelated concurrent edits',()=>{
  const h=casFixture();assert.ok(h.baseline.cellSignatures[0][0])
  h.tableCells[0][1].value='other user edit'
  h.api.applyTableSnapshot(h.action([['new A','B']]))
  assert.deepEqual(h.writes,[['cell',0,0,'new A']]);assert.equal(h.tableCells[0][1].value,'other user edit')
})
test('table compare-and-set validates every target before any write, including same-text formatting conflicts',()=>{
  const h=casFixture();h.tableCells[0][1].weight=150
  assert.throws(()=>h.api.applyTableSnapshot(h.action([['new A','new B']])),/内容或格式已变化/)
  assert.deepEqual(h.writes,[])
  h.tableCells[0][1].weight=100;h.tableCells[0][1].value='conflict'
  assert.throws(()=>h.api.applyTableSnapshot(h.action([['new A','new B']])),/内容或格式已变化/)
  assert.deepEqual(h.writes,[])
})
test('stale table writes reject replaced tables, forged/expired tokens and field-containing cells',()=>{
  const h=casFixture()
  assert.throws(()=>h.api.applyTableSnapshot({...h.action([['new','B']]),expectedTableId:'different-table'}),/表格已替换/)
  assert.throws(()=>h.api.applyTableSnapshot({...h.action([['new','B']]),expectedCellSignatures:[['forged','']]}),/安全读取基线/)
  h.tableCells[0][0].portionType='TextField'
  const unsafe=h.api.data({type:'table',name:'Table1'});assert.equal(unsafe.cellSignatures[0][0],'')
  assert.throws(()=>h.api.applyTableSnapshot({...h.action([['new','B']]),expectedCellSignatures:unsafe.cellSignatures}),/安全读取基线/)
  assert.deepEqual(h.writes,[])
})
test('table baselines are a complete bounded contract, never an arbitrary bypass for other actions',()=>{
  rejectsBeforeModel({type:'update-table',name:'Table1',cells:[['x']],expectedCells:[['old']]})
  const h=casFixture()
  assert.throws(()=>h.api.applyTableSnapshot({type:'format-text',fontSize:18}),/仅带完整读取基线/)
  assert.deepEqual(h.writes,[])
})
test('stale table recovery never joins or creates paragraphs or line separators',()=>{
  for(const separator of ['\n','\r','\v','\f','\u0085','\u2028','\u2029']) {
    const h=casFixture()
    assert.throws(()=>h.api.applyTableSnapshot(h.action([['new'+separator+'paragraph','B']])),/跨段落或换行/)
    assert.deepEqual(h.writes,[])
    h.tableCells[0][0].value='old'+separator+'paragraph'
    assert.equal(h.api.data({type:'table',name:'Table1'}).cellSignatures[0][0],'')
  }
})

function commandTarget(h) {
  const state=h.api.state()
  return {documentId:'A',revision:0,...Object.fromEntries(['selection','textStyle','paragraph','page','tables'].map(key=>[key,state[key]]))}
}
test('immediate command validates the current target and performs genuine property writes in one call',()=>{
  const h=fixture(), target=commandTarget(h)
  h.revision=7 // Delayed native notifications do not by themselves change this target.
  h.api.command({action:{type:'format-text',bold:true},target})
  assert.equal(h.view.values.CharWeight,150)
  assert.equal(h.view.values.CharWeightAsian,150)
})
test('commands reject old draft guards, unsupported writes and malformed targets before touching UNO',()=>{
  for(const action of [{type:'format-text',bold:true,expectedRevision:0},{type:'format-text',bold:true,expectedSelectionId:'x'},
    {type:'update-table',name:'Table1',cells:[['x','y']]},{type:'delete-comment',index:0}]) {
    const h=fixture();assert.throws(()=>h.api.command({action,target:{}}));assert.equal(h.modelReads,0);assert.deepEqual(h.writes,[])
  }
  const h=fixture();assert.throws(()=>h.api.command({action:{type:'format-text',bold:true},target:{documentId:'A'}}));assert.equal(h.modelReads,0)
})
test('changed relevant command selection, formatting or page properties reject before writing',()=>{
  for(const [action,change] of [
    [{type:'format-text',bold:true},h=>{h.selectionText='new text'}],
    [{type:'format-text',bold:false},h=>{h.view.values.CharWeight=150}],
    [{type:'set-page',marginLeft:22},h=>{h.page.values.Width=22000}],
  ]) {
    const h=fixture(),target=commandTarget(h);change(h)
    assert.throws(()=>h.api.command({action,target}),/目标已改变/)
    assert.deepEqual(h.writes,[])
  }
})
test('unrelated font changes and fresh UNO wrappers do not retarget a current command',()=>{
  const h=fixture(),target=commandTarget(h)
  h.view.values.CharHeight=20
  h.api.command({action:{type:'format-text',bold:true},target})
  assert.equal(h.view.values.CharWeight,150)
  const pageTarget=commandTarget(h)
  h.model.getStyleFamilies=()=>({getByName:()=>({getElementNames:()=>[],hasByName:()=>true,getByName:()=>({...h.page})})})
  h.api.command({action:{type:'set-page',marginLeft:22},target:pageTarget})
  assert.equal(h.page.values.LeftMargin,2200)
})
test('image/multiple selections and selected-text replacement cannot use immediate insertion',()=>{
  for(const selected of [()=>({getText:()=>({})}),()=>({getCount:()=>2,getByIndex:()=>null})]) {
    const h=fixture(),target=commandTarget(h);h.controller.getSelection=selected
    assert.throws(()=>h.api.command({action:{type:'insert-text',text:'x'},target}),/对象|多选/);assert.deepEqual(h.writes,[])
  }
  const h=fixture(),target=commandTarget(h)
  assert.throws(()=>h.api.command({action:{type:'insert-text',text:'x',replaceSelection:true},target}),/版本保护/);assert.deepEqual(h.writes,[])
})
test('new header command requires an authoritative disabled section and never uses optional fallback as proof',()=>{
  const h=fixture();delete h.page.values.HeaderIsOn;const target=commandTarget(h)
  assert.equal(target.page.headerEnabled,false,'Display metadata uses fallback, which is not write authority')
  assert.throws(()=>h.api.command({action:{type:'set-header-footer',target:'header',enabled:true,text:'new'},target}),/preflight/)
  assert.deepEqual(h.writes,[])
  const existing=fixture();existing.page.values.HeaderIsOn=true;existing.page.values.HeaderText={getString:()=>''}
  assert.throws(()=>existing.api.command({action:{type:'set-header-footer',target:'header',enabled:true,text:'new'},target:commandTarget(existing)}),/版本保护/)
  assert.deepEqual(existing.writes,[])
})


test('extended text formats preflight and explicitly reset native baseline and highlight',()=>{
  for(const payload of [{type:'format-text',baseline:'automatic'},{type:'format-text',strikethrough:'yes'}]) rejectsBeforeModel(payload)
  const h=fixture();Object.assign(h.view.values,{CharStrikeout:0,CharEscapement:0,CharEscapementHeight:100})
  h.api.action({type:'format-text',strikethrough:true,baseline:'superscript',highlight:'#FFFF00'})
  assert.equal(h.view.values.CharStrikeout,1);assert.equal(h.view.values.CharEscapement,14000);assert.equal(h.view.values.CharEscapementHeight,58)
  h.api.action({type:'format-text',strikethrough:false,baseline:'normal',highlight:null})
  assert.equal(h.view.values.CharStrikeout,0);assert.equal(h.view.values.CharEscapement,0);assert.equal(h.view.values.CharEscapementHeight,100);assert.equal(h.view.values.CharBackTransparent,true)
  delete h.view.values.CharEscapementHeight;h.writes.length=0
  assert.throws(()=>h.api.action({type:'format-text',strikethrough:true,baseline:'subscript'}),/不支持/);assert.deepEqual(h.writes,[])
})
test('hyperlinks reject unsafe schemes, malformed URLs, collapsed and stale selections before writes',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,x','file:///tmp/a','ftp://example.com','https://','http://:bad','https://example.com/\n','mailto:not-an-email']) rejectsBeforeModel({type:'set-hyperlink',url})
  const h=fixture();h.view.values.HyperLinkURL='';h.selectionText='link';
  assert.throws(()=>h.api.action({type:'set-hyperlink',url:'https://example.com'}),/选中/)
  h.view.isCollapsed=()=>false
  assert.throws(()=>h.api.action({type:'set-hyperlink',url:'https://example.com',expectedSelectionId:'stale'}),/选区已改变/)
  assert.deepEqual(h.writes,[])
  const groups=[];h.model.getUndoManager=()=>({enterUndoContext:label=>groups.push(label),leaveUndoContext:()=>groups.push('end')})
  h.api.action({type:'set-hyperlink',url:'https://example.com/a?x=1&y=2'});assert.equal(h.view.values.HyperLinkURL,'https://example.com/a?x=1&y=2')
  h.dispatchHandler=command=>{assert.equal(command,'.uno:RemoveHyperlink');h.view.values.HyperLinkURL=''}
  h.api.action({type:'set-hyperlink',url:''});assert.equal(h.view.values.HyperLinkURL,'');assert.equal(h.writes.length,3);assert.deepEqual(groups,['设置超链接','end','移除超链接','end'])
})
test('replace-one prefers the exact native selected match without skipping to a repeated word',()=>{
  const h=fixture(), start={},end={},owner=h.view.getText(),ranges=[]
  h.view.getStart=()=>start;h.view.getEnd=()=>end;h.view.isCollapsed=()=>false
  const selected={getText:()=>owner,getString:()=> 'Alpha',getEnd:()=>end,setString:value=>ranges.push(['selected',value])},next={getText:()=>owner,getString:()=> 'Alpha',getEnd:()=>end,setString:value=>ranges.push(['next',value])}
  const descriptor={getPropertySetInfo:()=>({hasPropertyByName:()=>true}),setPropertyValue(){},setSearchString(){},setReplaceString(){}}
  h.model.createReplaceDescriptor=()=>descriptor;h.model.findNext=position=>position===start?selected:next;h.model.findFirst=()=>next;const chosen=[];h.controller.select=range=>{chosen.push(range);return true}
  h.api.action({type:'find-replace',search:'Alpha',replace:'Beta',wholeWords:true,matchCase:true})
  assert.deepEqual(ranges,[['selected','Beta']]);assert.deepEqual(chosen,[selected,next])
  ranges.length=0;chosen.length=0;h.api.action({type:'find-replace',search:'Alpha',replace:'Alpha'});assert.deepEqual(ranges,[],'Identical replacement preserves rich runs and skips mutation');assert.deepEqual(chosen,[selected,next],'Identical replacements still advance to the next match')
  chosen.length=0;h.api.action({type:'find-replace',search:'Alpha',replace:'alpha'});assert.deepEqual(ranges,[['selected','alpha']]);assert.deepEqual(chosen,[selected,next],'Case-only replacements also advance')
  ranges.length=0;owner.compareRegionEnds=range=>range===selected?1:0
  h.api.action({type:'find-replace',search:'Alpha',replace:'Beta'})
  assert.deepEqual(ranges,[['next','Beta']],'A partial or overlapping selection must not be treated as the native search hit')
  ranges.length=0;h.controller.select=()=>false
  assert.throws(()=>h.api.action({type:'find-replace',search:'Alpha',replace:'Beta'}),/无法选中/);assert.deepEqual(ranges,[],'Selection failure must precede any text replacement')
})


test('character format groups native multi-property undo only after complete preflight',()=>{
 const h=fixture(),groups=[];h.model.getUndoManager=()=>({enterUndoContext:name=>groups.push(['enter',name]),leaveUndoContext:()=>groups.push(['leave'])})
 h.api.action({type:'format-text',bold:true,fontSize:18});assert.deepEqual(groups,[['enter','文字格式'],['leave']])
 groups.length=0;delete h.view.values.CharHeightComplex
 assert.throws(()=>h.api.action({type:'format-text',bold:false,fontSize:12}),/不支持/);assert.deepEqual(groups,[])
})


test('changing an existing advanced or ambiguous hyperlink rejects before removing any metadata',()=>{
 for(const patch of [{HyperLinkTarget:'_blank'},{HyperLinkName:'KeepName'},{HyperLinkEvents:undefined},{VisitedCharStyleName:'CustomVisited'},{UnvisitedCharStyleName:'Emphasis'},{UnvisitedCharStyleName:'Internetlink'},{UnvisitedCharStyleName:'Inter net link'},{HyperLinkEvents:{getElementNames:()=>['OnClick'],getByName:()=>[{Name:'Script',Value:'macro'}]}},{HyperLinkEvents:{getElementNames:()=>['OnClick'],getByName:()=>[{Name:'EventType',Value:'None'},{Name:'Script',Value:'macro'}]}}]) {
  const h=fixture();h.selectionText='Link';h.view.isCollapsed=()=>false
  Object.assign(h.view.values,{HyperLinkURL:'https://example.com/old',HyperLinkTarget:'',HyperLinkName:'',VisitedCharStyleName:'Visited Internet Link',UnvisitedCharStyleName:'Internet link',HyperLinkEvents:null},patch)
  assert.throws(()=>h.api.action({type:'set-hyperlink',url:'https://example.com/new'}),/普通链接|无法完整读取/);assert.deepEqual(h.writes,[])
 }
 const h=fixture();h.selectionText='Mixed';h.view.isCollapsed=()=>false;h.view.values.HyperLinkURL='';h.view.getPropertyState=()=>2
 assert.throws(()=>h.api.action({type:'set-hyperlink',url:'https://example.com/new'}),/混合/);assert.deepEqual(h.writes,[])
})


test('ordinary links allow the native named event container when every event is unassigned',()=>{
 for(const values of [[],[{Handle:0,Name:'EventType',State:{enumValue:0},Value:'None'}]]) {
 const h=fixture();h.selectionText='Link';h.view.isCollapsed=()=>false
 Object.assign(h.view.values,{HyperLinkURL:'https://example.com/old',HyperLinkTarget:'',HyperLinkName:'',VisitedCharStyleName:'Visited Internet Link',UnvisitedCharStyleName:'Internet link',HyperLinkEvents:{getElementNames:()=>['OnClick','OnMouseOut','OnMouseOver'],getByName:()=>values}})
 h.api.action({type:'set-hyperlink',url:'https://example.com/new'});assert.equal(h.view.values.HyperLinkURL,'https://example.com/new')
 assert.equal(h.writes[0][0],'dispatch');assert.equal(h.writes[0][1],'.uno:RemoveHyperlink')
 }
})
