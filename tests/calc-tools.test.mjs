import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source=fs.readFileSync(new URL('../public/office/calc-tools.js',import.meta.url),'utf8')

function fixture(){
  const changes=[],caught=[],context=vm.createContext({}),names=[];let environmentReads=0,active,selection,protectedSheet=false;
  class Any{constructor(type,value){this.type=type;this.value=value}}
  class Struct{constructor(value){Object.assign(this,value)}}
  const unwrap=value=>value instanceof Any?value.value:value;
  const initial={CharFontName:'Noto Sans',CharHeight:11,CharWeight:100,CharPosture:0,CharColor:0,IsCellBackgroundTransparent:true,CellBackColor:0xffffff,HoriJustify:0,VertJustify:0,IsTextWrapped:false,NumberFormat:0,Validation:{getPropertyValue:name=>{assert.equal(name,'Type');return 0}}};
  function props(values){return {getPropertySetInfo:()=>({hasPropertyByName:name=>name in values}),getPropertyValue(name){assert.ok(name in values,'preflight all property reads');return values[name]},setPropertyValue(name,value){assert.ok(name in values);changes.push({type:'property',name,value:unwrap(value)});values[name]=unwrap(value)}}}
  function makeSheet(name){const grid=new Map(),formats=new Map(),kinds=new Map();let sheetName=name;const sheetProps={IsVisible:true};
    function range(c,r,e=c,b=r){const key=c+','+r;const values=formats.get(key)||{...initial};formats.set(key,values);
      const read=()=>Array.from({length:b-r+1},(_,row)=>Array.from({length:e-c+1},(_,col)=>grid.get(`${c+col},${r+row}`)??''));
      const write=(rows,type)=>{changes.push({type,rows});rows.forEach((row,ri)=>row.forEach((value,ci)=>{const k=`${c+ci},${r+ri}`;grid.set(k,value);kinds.set(k,type==='formula-array'&&String(value).startsWith('=')?'formula':typeof value==='number'?'number':'text')}))};
      return {...props(values),getRangeAddress:()=>({Sheet:names.indexOf(sheet),StartColumn:c,StartRow:r,EndColumn:e,EndRow:b}),getFormulaArray:()=>read().map(row=>row.map(String)),getDataArray:read,setFormulaArray:rows=>write(rows,'formula-array'),setDataArray:rows=>write(rows,'data-array'),getFormula:()=>String(grid.get(key)??''),getString:()=>String(grid.get(key)??''),getValue:()=>typeof grid.get(key)==='number'?grid.get(key):0,getType:()=>!grid.has(key)?0:typeof grid.get(key)==='number'?1:2,getArrayFormula:()=>'',getError:()=>0,setFormula:value=>{changes.push({type:'formula',value});grid.set(key,value);kinds.set(key,value.startsWith('=')?'formula':value?'text':'empty')},setString:value=>{changes.push({type:'string',value});grid.set(key,value);kinds.set(key,'text')},setValue:value=>{changes.push({type:'number',value});grid.set(key,value);kinds.set(key,'number')},queryContentCells:flags=>({getRangeAddresses:()=>{const result=[];for(let row=r;row<=b;row++)for(let col=c;col<=e;col++){const kind=kinds.get(`${col},${row}`);if(flags==={number:3,text:4,formula:16}[kind])result.push({Sheet:names.indexOf(sheet),StartColumn:col,EndColumn:col,StartRow:row,EndRow:row})}return result}}),queryFormulaCells:()=>({getRangeAddresses:()=>[]}),fillSeries:(...args)=>changes.push({type:'fill-series',args}),getIsMerged:()=>false,merge:value=>changes.push({type:'merge',value})}
    }
    const sheet={...props(sheetProps),getName:()=>sheetName,setName:value=>{changes.push({type:'rename',value});sheetName=value},getCellByPosition:range,getCellRangeByPosition:range,getRows:()=>({getByIndex:()=>props({IsVisible:true})}),getCellRangeByName:()=>range(0,0),createCursorByRange:cell=>({collapseToMergedArea:()=>{},getRangeAddress:()=>cell.getRangeAddress()}),isProtected:()=>protectedSheet,grid,formats};return sheet
  }
  names.push(makeSheet('Sheet1'));active=names[0];selection=active.getCellByPosition(0,0);
  const sheets={getCount:()=>names.length,getElementNames:()=>names.map(sheet=>sheet.getName()),getByIndex:index=>names[index],getByName:name=>names.find(sheet=>sheet.getName()===name),hasByName:name=>names.some(sheet=>sheet.getName()===name),insertNewByName(name,index){changes.push({type:'insert-sheet',name});names.splice(index,0,makeSheet(name))},copyByName(from,name,index){changes.push({type:'copy-sheet',from,name});const copy=makeSheet(name);names.splice(index,0,copy)},removeByName(name){changes.push({type:'delete-sheet',name});names.splice(names.findIndex(sheet=>sheet.getName()===name),1);active=names[0]},moveByName(name,index){changes.push({type:'move-sheet',name,index});const old=names.findIndex(sheet=>sheet.getName()===name);names.splice(index,0,names.splice(old,1)[0])}};
  const controller={getActiveSheet:()=>active,setActiveSheet:sheet=>{active=sheet},getSelection:()=>selection,select:value=>{selection=value},hasFrozenPanes:()=>false,splitAtPosition:(x,y)=>changes.push({type:'split',x,y}),getFirstVisibleColumn:()=>0,getFirstVisibleRow:()=>0,setFirstVisibleColumn:column=>changes.push({type:'scroll-column',column}),setFirstVisibleRow:row=>changes.push({type:'scroll-row',row}),freezeAtPosition:(column,row)=>changes.push({type:'freeze',column,row})};
  controller.getCount=()=>1;controller.getByIndex=()=>controller;
  const model={...props({}),supportsService:value=>value==='com.sun.star.sheet.SpreadsheetDocument',getSheets:()=>sheets,getCurrentController:()=>controller,isReadonly:()=>false,getNumberFormats:()=>({getByKey:()=>props({FormatString:'General'})})};
  vm.runInContext(source,context);
  const api=context.createCalcTools({zetajs:{Any,type:{float:'float',long:'long',short:'short'},catchUnoException:error=>{caught.push(error);return {Message:'optional native property'}}},css:{lang:{Locale:Struct},sheet:{ValidationType:{ANY:0,WHOLE:1,DECIMAL:2,DATE:3,TIME:4,TEXT_LEN:5,LIST:6,CUSTOM:7},ValidationAlertStyle:{STOP:0,WARNING:1,INFO:2,MACRO:3},FillDirection:{TO_BOTTOM:0,TO_RIGHT:1},FillMode:{SIMPLE:0},FillDateMode:{FILL_DATE_DAY:0},DataPilotFieldOrientation:{HIDDEN:0,ROW:1,COLUMN:2,PAGE:3,DATA:4},GeneralFunction:{SUM:1,COUNT:2,AVERAGE:3}},beans:{PropertyValue:Struct},awt:{FontSlant:{NONE:0,ITALIC:2}},table:{CellHoriJustify:{STANDARD:0,LEFT:1,CENTER:2,RIGHT:3,BLOCK:4},CellVertJustify:{STANDARD:0,TOP:1,CENTER:2,BOTTOM:3}}},getModel:()=>{environmentReads++;return model},dispatch:(command,args)=>changes.push({type:'dispatch',command,args:args.map(item=>({name:item.Name,value:unwrap(item.Value)}))})});
  return {api,changes,caught,context,names,model,makeSheet,get environmentReads(){return environmentReads},get active(){return active},get selection(){return selection},protect:()=>{protectedSheet=true}};
}
const plain=value=>JSON.parse(JSON.stringify(value));

function propertyStates(f,states={},extra={}){
  const get=f.active.getCellRangeByPosition;let calls=0;
  f.active.getCellRangeByPosition=(...args)=>{const cells=get(...args);return {...cells,...extra,getPropertyStates(names){calls++;return names.map(name=>states[name]??0)}}};
  return ()=>calls;
}
test('Native range format states expose mixed attributes without changing the anchor compatibility format',()=>{
  const f=fixture(),calls=propertyStates(f,{CharHeight:2,CharWeightAsian:2,NumberFormat:{value:2},CellBackColor:2});
  f.api.action({type:'select-range',range:'A1:C3'});const state=f.api.state();
  assert.deepEqual(plain(state.mixedFormat),['fontSize','bold','numberFormat']);assert.equal(state.format.fontSize,11);assert.equal(state.format.backgroundColor,null);assert.equal(calls(),1);assert.deepEqual(f.changes,[]);
});
test('Unknown native format states and oversized selections are bounded and never reported as uniform',()=>{
  for(const mode of ['absent','invalid','short','throws']){
    const f=fixture(),get=f.active.getCellRangeByPosition;let count=0;
    f.active.getCellRangeByPosition=(...args)=>{const cell=get(...args);if(mode!=='absent')cell.getPropertyStates=names=>{count++;if(mode==='throws')throw Error('unavailable');return mode==='short'?[0]:names.map(()=>99)};return cell};
    const state=f.api.state();assert.equal(state.unavailableFormat.length,10,mode);assert.deepEqual(plain(state.mixedFormat),[]);assert.ok(count<=1);assert.deepEqual(f.changes,[]);
  }
  const f=fixture(),calls=propertyStates(f);f.model.getCurrentController().select({getRangeAddress:()=>({Sheet:0,StartColumn:0,StartRow:0,EndColumn:16383,EndRow:1048575})});
  assert.equal(f.api.state().unavailableFormat.length,10);assert.equal(calls(),0);assert.deepEqual(f.changes,[]);
});
test('Unknown selections cannot implicitly format A1 while explicit range targets remain valid',()=>{
  const f=fixture();f.model.getCurrentController().select({});assert.equal(f.api.state().selection.available,false);
  assert.throws(()=>f.api.action({type:'format',wrap:true}),/连续/);assert.deepEqual(f.changes,[]);
  f.api.action({type:'format',range:'C2',wrap:true});assert.equal(f.changes.length,1);
});
test('Non-contiguous selection cannot silently format its first rectangle',()=>{
  const f=fixture(),ranges=[0,2].map(column=>({Sheet:0,StartColumn:column,EndColumn:column,StartRow:0,EndRow:0}));
  f.model.getCurrentController().select({getRangeAddresses:()=>ranges});const state=f.api.state();assert.equal(state.selection.multiple,true);assert.equal(state.unavailableFormat.length,10);
  assert.throws(()=>f.api.action({type:'format',wrap:true}),/连续/);assert.deepEqual(f.changes,[]);
  f.api.action({type:'format',range:'B1',wrap:true});assert.equal(f.changes.length,1,'Explicit API target remains independent of the current selection');
});
test('Mixed visible fills include transparency; unused colors under transparent fill do not',()=>{
  for(const [transparent,state,color,expected]of [[true,0,2,false],[false,0,2,true],[true,2,0,true]]){
    const f=fixture();f.active.getCellByPosition(0,0).setPropertyValue('IsCellBackgroundTransparent',transparent);f.changes.length=0;
    propertyStates(f,{IsCellBackgroundTransparent:state,CellBackColor:color});assert.equal(f.api.state().mixedFormat.includes('backgroundColor'),expected);assert.deepEqual(f.changes,[]);
  }
});
function richTargetsFixture(f,areas){
  const get=f.active.getCellRangeByPosition,getCell=f.active.getCellByPosition;let cursorWrites=0;
  f.active.getCellRangeByPosition=(...args)=>({...get(...args),queryContentCells:flag=>{assert.equal(flag,512);return {getRangeAddresses:()=>areas}}});
  f.active.getCellByPosition=(...args)=>({...getCell(...args),createTextCursor:()=>({gotoStart:()=>{},gotoEnd:()=>{},getPropertySetInfo:()=>({hasPropertyByName:()=>true}),setPropertyValue:(name,value)=>{cursorWrites++;f.changes.push({type:'cursor',name,value:value.value??value})}})});
  f.model.getUndoManager=()=>({enterUndoContext:()=>f.changes.push({type:'undo-start'}),leaveUndoContext:()=>f.changes.push({type:'undo-end'})});
  return ()=>cursorWrites;
}
test('Rich text format preflights every target, uses one undo group and only writes requested character attributes',()=>{
  const f=fixture(),writes=richTargetsFixture(f,[{Sheet:0,StartColumn:1,StartRow:0,EndColumn:2,EndRow:0}]);
  f.api.action({type:'format',range:'A1:C1',textColor:'#123456'});assert.equal(writes(),2);
  assert.deepEqual(f.changes.map(x=>x.type),['undo-start','property','cursor','cursor','undo-end']);assert.ok(f.changes.filter(x=>x.name).every(x=>x.name==='CharColor'));
});
test('Rich format count, invalid native ranges and missing undo reject before any mutation',()=>{
  for(const area of [{Sheet:1,StartColumn:0,StartRow:0,EndColumn:0,EndRow:0},{Sheet:0,StartColumn:0,StartRow:0,EndColumn:256,EndRow:0},{Sheet:0,StartColumn:-1,StartRow:0,EndColumn:0,EndRow:0}]){
    const f=fixture();richTargetsFixture(f,[area]);assert.throws(()=>f.api.action({type:'format',range:'A1:JW1',textColor:'#123456'}));assert.deepEqual(f.changes,[]);
  }
  const f=fixture();richTargetsFixture(f,[{Sheet:0,StartColumn:0,StartRow:0,EndColumn:0,EndRow:0}]);delete f.model.getUndoManager;assert.throws(()=>f.api.action({type:'format',range:'A1',textColor:'#123456'}),/撤销/);assert.deepEqual(f.changes,[]);
});
test('Number format registration cannot mutate before a missing rich-text undo context is rejected',()=>{
  const f=fixture();richTargetsFixture(f,[{Sheet:0,StartColumn:0,StartRow:0,EndColumn:0,EndRow:0}]);delete f.model.getUndoManager;
  let registered=0;f.model.getNumberFormats=()=>({queryKey:()=>-1,addNew:()=>{registered++;return 10000}});
  assert.throws(()=>f.api.action({type:'format',range:'A1',textColor:'#123456',numberFormat:'0.000'}),/撤销/);assert.equal(registered,0);assert.deepEqual(f.changes,[]);
});
test('General reapplication stays in one undo context and never clears cell contents',()=>{
  const f=fixture();f.model.getNumberFormats=()=>({queryKey:()=>0});f.model.getUndoManager=()=>({enterUndoContext:()=>f.changes.push({type:'begin'}),leaveUndoContext:()=>f.changes.push({type:'end'})});
  f.api.action({type:'format',range:'A1:C1',numberFormat:'General'});assert.deepEqual(f.changes.map(x=>x.type),['begin','property','property','end']);assert.ok(f.changes.filter(x=>x.name).every(x=>x.name==='NumberFormat'&&x.value===0));
});

test('Calc invalid requests reject before acquiring or mutating the UNO model',()=>{
  for(const input of [null,{type:'constructor'},{type:'dispatch',command:'.uno:RunMacro'},{type:'set-cell',address:'A0',input:'x'},{type:'set-cell',address:'XFE1',input:'x'},{type:'select-range',range:'Sheet2.A1'},{type:'set-matrix',cells:[[1],[2,3]]},{type:'set-matrix',cells:[[Infinity]]},{type:'set-matrix',cells:[Array(10001).fill('x')]},{type:'format',fontSize:NaN},{type:'format',textColor:'red'},{type:'rename-sheet',sheetIndex:0,name:'bad/name'},{type:'freeze',columns:-1,rows:1},{type:'filter',column:0,operator:'contains',value:5,header:true},{type:'validation',kind:'whole',minimum:4,maximum:3},{type:'insert-pivot',name:'p',rowField:0,dataField:0,operation:'sum',outputAddress:'E1'},{type:'delete-name',name:'A1'}]){
    const f=fixture();assert.throws(()=>f.api.action(input));assert.equal(f.environmentReads,0,JSON.stringify(input));assert.deepEqual(f.changes,[]);
  }
});
test('Calc matrix writes preserve literals while formula entry is explicit',()=>{
  const f=fixture();f.api.action({type:'set-matrix',range:'A1:B2',cells:[['=SUM(1;2)',7],[null,true]]});
  assert.deepEqual(plain(f.api.data({type:'range',range:'A1:B2'}).values),[['=SUM(1;2)',7],['',1]]);assert.equal(f.changes[0].type,'data-array');
  f.api.action({type:'set-matrix',range:'D1',cells:[['=SUM(B1:B2)',4]],formulas:true});assert.equal(f.changes.at(-1).type,'formula-array');assert.deepEqual(plain(f.changes.at(-1).rows),[['=SUM(B1:B2)','4']]);
});
test('Calc refuses merge content loss and writes outside sheet dimensions',()=>{
  const f=fixture();f.api.action({type:'set-matrix',range:'A1:B1',cells:[['keep','do not lose']]});f.changes.length=0;
  assert.throws(()=>f.api.action({type:'merge',range:'A1:B1',merged:true}),/丢弃/);assert.throws(()=>f.api.action({type:'set-matrix',range:'XFD1048576',cells:[[1,2]]}),/越界/);assert.throws(()=>f.api.action({type:'set-matrix',range:'A1:B2',cells:[[1]]}),/尺寸/);assert.deepEqual(f.changes,[]);
});
test('Calc preserves a visible sheet and enforces unique Excel-compatible names',()=>{
  const f=fixture();assert.throws(()=>f.api.action({type:'delete-sheet',sheetIndex:0}),/可见/);assert.throws(()=>f.api.action({type:'set-sheet-hidden',sheetIndex:0,hidden:true}),/可见/);assert.deepEqual(f.changes,[]);
  f.api.action({type:'add-sheet',name:'数据'});f.api.action({type:'set-sheet-hidden',sheetIndex:0,hidden:true});f.changes.length=0;
  assert.throws(()=>f.api.action({type:'set-sheet-hidden',sheetIndex:1,hidden:true}),/可见/);assert.throws(()=>f.api.action({type:'rename-sheet',sheetIndex:1,name:'sheet1'}),/已存在/);assert.throws(()=>f.api.action({type:'select-sheet',sheetIndex:0}),/隐藏/);assert.deepEqual(f.changes,[]);
});
test('Calc protected sheets reject edits while navigation and state remain available',()=>{
  const f=fixture();f.protect();assert.throws(()=>f.api.action({type:'set-cell',address:'A1',input:'changed'}),/保护/);assert.deepEqual(f.changes,[]);f.api.action({type:'select-range',range:'B2'});assert.equal(f.api.state().cell.address,'B2');assert.deepEqual(f.changes,[]);
});
test('Calc optional property reads preflight and consume native exception payloads',()=>{
  const f=fixture(),get=f.active.getCellRangeByPosition,native={unoException:true};f.active.getCellRangeByPosition=(...args)=>{const range=get(...args),read=range.getPropertyValue;range.getPropertyValue=name=>{if(name==='CharHeight')throw native;return read(name)};return range};
  assert.equal(f.api.state().format.fontSize,11);assert.deepEqual(f.caught,[native]);assert.deepEqual(f.changes,[]);
});
test('Calc does not swallow native runtime traps as optional properties',()=>{
  const f=fixture(),get=f.active.getCellRangeByPosition,trap=vm.runInContext('new WebAssembly.RuntimeError("native trap")',f.context);f.active.getCellRangeByPosition=(...args)=>{const range=get(...args);range.getPropertyValue=()=>{throw trap};return range};assert.throws(()=>f.api.state(),error=>error===trap);assert.deepEqual(f.caught,[]);
});
test('Calc format validation preflights unsupported properties before changing supported fields',()=>{
  const f=fixture();assert.throws(()=>f.api.action({type:'format',range:'A1',fontName:'New font',bold:true}),/不支持/);assert.deepEqual(f.changes,[]);
});
test('Calc range queries are bounded and cannot invoke arbitrary methods',()=>{
  const f=fixture();assert.throws(()=>f.api.data({type:'range',range:'A1:XFD1048576'}),/最多/);assert.throws(()=>f.api.data({type:'getModel',range:'A1'}));assert.throws(()=>f.api.data({type:'range',range:'A1',command:'delete'}));assert.deepEqual(f.changes,[]);
});
test('Large imported workbooks retain their native model and active sheet beyond the navigation limit',()=>{
  const f=fixture();for(let i=1;i<300;i++)f.names.push(f.makeSheet('Sheet'+(i+1)));f.api.action({type:'select-sheet',sheetIndex:299});const result=f.api.state();
  assert.equal(result.sheetCount,300);assert.equal(result.sheetsTruncated,true);assert.equal(result.sheets.length,257);assert.equal(result.activeSheetIndex,299);assert.equal(result.sheets.at(-1).name,'Sheet300');assert.deepEqual(f.changes,[]);
});
test('Native sort command uses a bounded selection and absolute one-based key without arbitrary dispatch',()=>{
  const f=fixture();assert.throws(()=>f.api.action({type:'sort',range:'C2:E8',column:3,ascending:false,header:true}),/超出/);assert.deepEqual(f.changes,[]);
  f.api.action({type:'sort',range:'C2:E8',column:1,ascending:false,header:true});const dispatched=f.changes.at(-1);assert.equal(dispatched.command,'.uno:DataSort');assert.equal(dispatched.args.find(item=>item.name==='Col1').value,4);assert.equal(dispatched.args.find(item=>item.name==='HasHeader').value,true);assert.equal(dispatched.args.find(item=>item.name==='Ascending1').value,false);assert.equal(f.selection.getRangeAddress().StartColumn,2);
});
test('Typed sparse editing preserves literal formulas, tabs and line breaks while changing only requested cells',()=>{
  const f=fixture();f.api.action({type:'patch-cells',cells:[{address:'A1',kind:'text',value:'=literal\nline\ttab'},{address:'B1',kind:'formula',value:'=SUM(1;2)'},{address:'C1',kind:'number',value:42}]});
  const read=plain(f.api.data({type:'range',range:'A1:C1'}));assert.deepEqual(read.cellTypes,[['text','formula','number']]);assert.equal(read.values[0][0],'=literal\nline\ttab');f.changes.length=0;
  assert.throws(()=>f.api.action({type:'patch-cells',cells:[{address:'A1',kind:'text',value:'x'},{address:'a1',kind:'text',value:'y'}]}),/重复/);assert.throws(()=>f.api.action({type:'patch-cells',cells:[{address:'B1',kind:'formula',value:'not a formula'}]}),/开头/);assert.deepEqual(f.changes,[]);
});
test('All content entry paths reject array anchors and members before changing an earlier ordinary target',()=>{
  const actions=[
    {type:'set-cell',address:'B2',input:'99'},
    {type:'set-cell',address:'B3',input:'99'},
    {type:'patch-cells',cells:[{address:'A1',kind:'text',value:'must not change'},{address:'B3',kind:'number',value:99}]},
    {type:'set-matrix',range:'A1:B3',cells:[[1,2],[3,4],[5,6]]},
    {type:'set-matrix',range:'B2:B3',cells:[['=1'],['=2']],formulas:true},
  ];
  for(const action of actions){
    const f=fixture(),get=f.active.getCellByPosition;f.active.grid.set('0,0','keep');
    f.active.getCellByPosition=(c,r)=>({...get(c,r),getArrayFormula:()=>c===1&&(r===1||r===2)?'{=ROW(B2:B3)}':''});
    assert.throws(()=>f.api.action(action),/数组公式/,JSON.stringify(action));assert.deepEqual(f.changes,[]);assert.equal(f.active.grid.get('0,0'),'keep');
  }
});
test('Unknown or failed array checks reject the entire sparse batch before its first write',()=>{
  for(const mode of ['missing','invalid','throws']){
    const f=fixture(),get=f.active.getCellByPosition,nativeError={native:'array inspection failed'};
    f.active.getCellByPosition=(c,r)=>{const cell=get(c,r);if(c===1){if(mode==='missing')delete cell.getArrayFormula;else cell.getArrayFormula=()=>{if(mode==='throws')throw nativeError;return undefined}}return cell};
    const action={type:'patch-cells',cells:[{address:'A1',kind:'text',value:'must not change'},{address:'B1',kind:'number',value:99}]};
    assert.throws(()=>f.api.action(action),mode==='throws'?error=>error===nativeError:/无法确认/);assert.deepEqual(f.changes,[]);
  }
});
test('Array formulas elsewhere do not block ordinary formula, sparse and rectangular writes',()=>{
  const f=fixture(),get=f.active.getCellByPosition;
  f.active.getCellByPosition=(c,r)=>({...get(c,r),getArrayFormula:()=>c===0&&r<2?'{=ROW(A1:A2)}':''});
  f.api.action({type:'set-cell',address:'B1',input:'=SUM(1;2)'});
  f.api.action({type:'patch-cells',cells:[{address:'B2',kind:'number',value:7},{address:'C2',kind:'text',value:'001'}]});
  f.api.action({type:'set-matrix',range:'B3:C3',cells:[[8,'text']]});
  assert.equal(f.active.grid.get('1,0'),'=SUM(1;2)');assert.equal(f.active.grid.get('1,1'),7);assert.equal(f.active.grid.get('2,1'),'001');assert.equal(f.active.grid.get('1,2'),8);assert.equal(f.active.grid.get('2,2'),'text');
});
function cellValidation(f,properties){
  const get=f.active.getCellByPosition;
  f.active.getCellByPosition=(c,r)=>{const cell=get(c,r),read=cell.getPropertyValue;if(c===1&&r===1)cell.getPropertyValue=name=>name==='Validation'?{getPropertyValue:key=>properties[key]}:read(name);return cell};
}
function mergedCells(sheet,areas=[[1,1,2,2],[4,1,4,2],[6,1,7,1]]){
  sheet.createCursorByRange=cell=>{let current=cell.getRangeAddress();return{
    collapseToMergedArea(){const match=areas.find(([c,r,e,b])=>c<=current.StartColumn&&current.StartColumn<=e&&r<=current.StartRow&&current.StartRow<=b);if(match){const [StartColumn,StartRow,EndColumn,EndRow]=match;current={...current,StartColumn,StartRow,EndColumn,EndRow}}},
    getRangeAddress:()=>current,
  }};
}
test('Content writes reject covered cells in two-dimensional, horizontal and vertical merges before any prefix changes',()=>{
  for(const action of [
    ...['C2','B3','C3','E3','H2'].map(address=>({type:'set-cell',address,input:'99'})),
    {type:'patch-cells',cells:[{address:'A1',kind:'text',value:'bad prefix'},{address:'C3',kind:'number',value:99}]},
    {type:'set-matrix',range:'A1:C3',cells:[[1,2,3],[4,5,6],[7,8,9]]},
    {type:'set-matrix',range:'B2:C3',cells:[['=1','=2'],['=3','=4']],formulas:true},
    {type:'set-matrix',range:'B2:C3',cells:[['anchor',null],[null,'']]},
  ]){
    const f=fixture();mergedCells(f.active);f.active.grid.set('0,0','keep');const selection=f.selection;
    assert.throws(()=>f.api.action(action),/覆盖格.*左上角/);assert.deepEqual(f.changes,[]);assert.equal(f.active.grid.get('0,0'),'keep');assert.equal(f.selection,selection);
  }
});
test('Merge anchors and ordinary neighbors remain writable through all three content entry paths',()=>{
  const f=fixture();mergedCells(f.active);
  f.api.action({type:'set-cell',address:'B2',input:'anchor'});
  f.api.action({type:'patch-cells',cells:[{address:'E2',kind:'number',value:7},{address:'A1',kind:'text',value:'keep'}]});
  f.api.action({type:'set-matrix',range:'G2',cells:[['=SUM(1;2)']],formulas:true});
  f.api.action({type:'set-matrix',range:'A2:B2',cells:[[10,'updated-anchor']]});
  assert.equal(f.active.grid.get('1,1'),'updated-anchor');assert.equal(f.active.grid.get('4,1'),7);assert.equal(f.active.grid.get('6,1'),'=SUM(1;2)');assert.equal(f.active.grid.get('0,1'),10);assert.equal(f.active.grid.has('2,1'),false);
});
test('Unknown, inconsistent and failed merge inspection refuses an entire batch without fallback',()=>{
  for(const mode of ['missing-factory','missing-cursor','missing-collapse','missing-address','throws','undefined','not-integer','wrong-sheet','reversed','outside','negative','too-large']){
    const f=fixture(),original=f.active.createCursorByRange;
    if(mode==='missing-factory')delete f.active.createCursorByRange;
    else f.active.createCursorByRange=cell=>{
      const a=cell.getRangeAddress();if(a.StartColumn===0)return original(cell);
      if(mode==='missing-cursor')return null;
      if(mode==='missing-collapse')return {getRangeAddress:()=>a};
      if(mode==='missing-address')return {collapseToMergedArea(){}};
      return {collapseToMergedArea(){if(mode==='throws')throw Error('native merge read failed')},getRangeAddress:()=>{
        if(mode==='undefined')return undefined;
        const patch={'not-integer':{EndColumn:NaN},'wrong-sheet':{Sheet:1},reversed:{StartColumn:2,EndColumn:1},outside:{StartColumn:0,EndColumn:0},negative:{StartRow:-1},'too-large':{EndRow:1048576}}[mode];return {...a,...patch};
      }};
    };
    assert.throws(()=>f.api.action({type:'patch-cells',cells:[{address:'A1',kind:'text',value:'bad prefix'},{address:'B1',kind:'text',value:'bad target'}]}));assert.deepEqual(f.changes,[],mode);
  }
});
test('Merge preflight uses the addressed sheet and never expands a huge merge into a cell scan',()=>{
  const f=fixture();f.api.action({type:'add-sheet',name:'Other'});const other=f.active;mergedCells(other);f.api.action({type:'select-sheet',sheetIndex:0});f.changes.length=0;
  assert.throws(()=>f.api.action({type:'patch-cells',sheetIndex:1,cells:[{address:'A1',kind:'number',value:4},{address:'C3',kind:'number',value:8}]}),/覆盖格/);assert.deepEqual(f.changes,[]);
  f.api.action({type:'set-cell',sheetIndex:1,address:'B2',input:'anchor'});assert.equal(other.grid.get('1,1'),'anchor');
  mergedCells(other,[[0,0,16383,1048575]]);const factory=other.createCursorByRange;let inspected=0;other.createCursorByRange=cell=>{inspected++;return factory(cell)};
  f.api.action({type:'set-cell',sheetIndex:1,address:'A1',input:'large anchor'});assert.equal(inspected,1);
});
test('STOP validation refuses all sidebar content writes before any earlier ordinary batch target changes',()=>{
  for(const kind of [1,6,7])for(const action of [
    {type:'set-cell',address:'B2',input:'5'},
    {type:'patch-cells',cells:[{address:'A1',kind:'text',value:'must not change'},{address:'B2',kind:'number',value:99}]},
    {type:'set-matrix',range:'A1:B2',cells:[[1,2],[3,99]]},
    {type:'set-matrix',range:'A1:B2',cells:[['=1','=2'],['=3','=99']],formulas:true},
  ]){
    const f=fixture();cellValidation(f,{Type:kind,ShowErrorMessage:true,ErrorAlertStyle:0});
    assert.throws(()=>f.api.action(action),/数据验证规则.*画布/);assert.deepEqual(f.changes,[]);
  }
});
test('Warning, information and disabled validation alerts retain ordinary sidebar editing behavior',()=>{
  for(const properties of [{Type:1,ShowErrorMessage:true,ErrorAlertStyle:1},{Type:7,ShowErrorMessage:true,ErrorAlertStyle:2},{Type:6,ShowErrorMessage:false}]){
    const f=fixture();cellValidation(f,properties);
    f.api.action({type:'set-cell',address:'B2',input:'99'});
    f.api.action({type:'patch-cells',cells:[{address:'A1',kind:'number',value:7},{address:'B2',kind:'number',value:42}]});
    f.api.action({type:'set-matrix',range:'A1:B2',cells:[[1,2],[3,88]]});
    assert.equal(f.active.grid.get('1,1'),88);
  }
});
test('Unknown validation metadata never grants permission to partially write a batch',()=>{
  for(const properties of [{Type:undefined},{Type:99},{Type:1,ShowErrorMessage:undefined},{Type:1,ShowErrorMessage:true,ErrorAlertStyle:undefined},{Type:7,ShowErrorMessage:true,ErrorAlertStyle:3}]){
    const f=fixture();cellValidation(f,properties);
    assert.throws(()=>f.api.action({type:'patch-cells',cells:[{address:'A1',kind:'number',value:7},{address:'B2',kind:'number',value:42}]}),/数据验证/);assert.deepEqual(f.changes,[]);
  }
});
test('Calc rich text reads native cursor expansion instead of treating every feature marker as a tab',()=>{
  const f=fixture();f.api.action({type:'patch-cells',cells:[{address:'A1',kind:'text',value:'before\tafter'}]});f.active.grid.set('0,0','before\u0001after');
  const get=f.active.getCellByPosition;let cursors=0;
  f.active.getCellByPosition=(...args)=>{const cell=get(...args);cell.createTextCursor=()=>{cursors++;return {gotoStart:()=>{},gotoEnd:()=>{},getString:()=> 'before\tafter'}};return cell};
  assert.equal(f.api.data({type:'range',range:'A1:B1'}).values[0][0],'before\tafter');assert.equal(cursors,1);
});
test('Frozen panes use actual native fixed positions rather than pixel-rounded split rows',()=>{
  const f=fixture(),controller=f.model.getCurrentController();controller.hasFrozenPanes=()=>true;controller.getSplitColumn=()=>1;controller.getSplitRow=()=>2;controller.getViewData=()=> '100/60/0;0;tw:1024;0/0/2/2/1/1/3/0/1/0/1';
  assert.deepEqual(plain(f.api.state().frozen),{columns:1,rows:1});
  f.api.action({type:'add-sheet',name:'Second'});controller.getViewData=()=> '100/60/0;1;tw:1024;0/0/2/2/1/1/3/0/1/0/1;0+9000+0+2+0+9000+3+0+0+0+9000';
  assert.deepEqual(plain(f.api.state().frozen),{columns:0,rows:9000});controller.getViewData=()=> 'invalid';assert.deepEqual(plain(f.api.state().frozen),{columns:1,rows:2});
});
test('Formula bar preserves literal leading equals text with explicit native input quoting',()=>{
  const f=fixture();f.api.action({type:'patch-cells',cells:[{address:'A1',kind:'text',value:'=literal'}]});assert.equal(f.api.state().cell.formula,"'=literal");
});

test('Pivot metadata uses native field display names even when the unfiltered collection exposes blank labels',()=>{
 const f=fixture(),address={Sheet:0,StartColumn:0,StartRow:0,EndColumn:1,EndRow:2};
 const fields=[{name:'地区',orientation:1,operation:0},{name:'Sum - 销售',orientation:4,operation:1}];
 f.active.getDataPilotTables=()=>({getElementNames:()=>['Pivot'],getByName:()=>({getSourceRange:()=>address,getOutputRange:()=>({...address,StartColumn:5,EndColumn:6}),getDataPilotFields:()=>({getCount:()=>fields.length,getElementNames:()=>['',''],getByIndex:index=>({getName:()=>fields[index].name,getPropertySetInfo:()=>({hasPropertyByName:name=>['Orientation','Function'].includes(name)}),getPropertyValue:name=>name==='Orientation'?fields[index].orientation:fields[index].operation})})})});
 const result=plain(f.api.data({type:'pivots'}));assert.equal(result.items[0].fields[0].name,'地区');assert.equal(result.items[0].fields[1].name,'Sum - 销售');assert.equal(result.items[0].fields[1].operation,'sum');
});

test('Freezing a scrolled viewport restores native fixed positions while retaining selection, zoom and other sheets',()=>{
 const f=fixture(),view=f.model.getCurrentController();let row=99,column=25,frozen={columns:0,rows:0};
 view.getFirstVisibleRow=()=>row;view.getFirstVisibleColumn=()=>column;view.setFirstVisibleRow=value=>{row=value};view.setFirstVisibleColumn=value=>{column=value};
 let record='125/60/0;0;tw:1024;25/99/0/0/0/0/2/25/0/0/99;2/3/0/0/0/0/2/0/0/0/0';view.getViewData=()=>record;view.restoreViewData=value=>{record=value;const fields=record.split(';')[3].split('/');frozen={columns:Number(fields[2])===2?Number(fields[4]):0,rows:Number(fields[3])===2?Number(fields[5]):0};assert.equal(record.split(';')[0],'125/60/0');assert.equal(record.split(';')[4],'2/3/0/0/0/0/2/0/0/0/0');assert.deepEqual(fields.slice(0,2),['25','99'])};view.hasFrozenPanes=()=>!!(frozen.columns||frozen.rows);view.getSplitColumn=()=>frozen.columns;view.getSplitRow=()=>frozen.rows;f.model.setModified=value=>{f.changes.push({type:'modified',value})};
 f.api.action({type:'select-range',range:'Z100'});const selected=f.selection;
 f.api.action({type:'freeze',columns:0,rows:1});assert.deepEqual(frozen,{columns:0,rows:1});assert.equal(row,99);assert.equal(column,25);assert.equal(f.selection,selected);
 f.api.action({type:'freeze',columns:1,rows:0});assert.deepEqual(frozen,{columns:1,rows:0});assert.equal(row,99);assert.equal(column,25);
 f.api.action({type:'freeze',columns:2,rows:3});assert.deepEqual(frozen,{columns:2,rows:3});assert.equal(row,99);assert.equal(column,25);
 f.api.action({type:'freeze',columns:0,rows:0});assert.deepEqual(frozen,{columns:0,rows:0});assert.equal(row,99);assert.equal(column,25);
});

test('An already matching native frozen pane is not rebuilt or marked modified',()=>{
 const f=fixture(),view=f.model.getCurrentController();view.hasFrozenPanes=()=>true;view.getSplitColumn=()=>1;view.getSplitRow=()=>2;
 f.api.action({type:'freeze',columns:1,rows:2});assert.deepEqual(f.changes,[]);
});

test('Unknown native view formats reject freezing before any mutation',()=>{
 const f=fixture(),view=f.model.getCurrentController();view.getViewData=()=> 'unknown format';assert.throws(()=>f.api.action({type:'freeze',columns:0,rows:1}),/不支持精确冻结/);assert.deepEqual(f.changes,[]);
});

function failedFreezeFixture({smoke=false,fail=true}={}){
 const f=fixture(),view=f.model.getCurrentController(),original='100/60/0;0;tw:1024;0/0/0/0/0/0/2/0/0/0/0',calls=[];let record=original;
 if(smoke)f.context.auditOfficeOfflinePolicy=()=>{};
 view.getViewData=()=>{calls.push('getViewData');return record};
 view.hasFrozenPanes=()=>{const fields=record.split(';')[3].split('/');return fields[2]==='2'||fields[3]==='2'};
 view.restoreViewData=value=>{calls.push(value===original?'rollback':'restore');record=value};
 view.setFirstVisibleColumn=()=>calls.push('scroll-column');
 view.setFirstVisibleRow=()=>{calls.push('scroll-row');if(fail){const parts=record.split(';'),fields=parts[3].split('/');fields[3]='0';fields[5]='0';parts[3]=fields.join('/');record=parts.join(';')}};
 const select=view.select;view.select=value=>{calls.push('select');select(value)};
 const rect=(name,value)=>({getPosSize:()=>{calls.push(name);return value}});
 view.getFrame=()=>{calls.push('frame');return {getContainerWindow:()=>rect('container',{X:0,Y:0,Width:1280,Height:800}),getComponentWindow:()=>rect('component',{X:0,Y:115,Width:1280,Height:52})}};
 f.model.setModified=()=>calls.push('modified');
 return {...f,view,calls,original,get record(){return record}};
}
test('Freeze mismatch details are smoke-only, numeric, bounded and captured before the original rollback',()=>{
 const f=failedFreezeFixture({smoke:true}),selected=f.selection;let failure;
 try{f.api.action({type:'freeze',columns:1,rows:1})}catch(error){failure=error}
 assert.match(failure.message,/原生表格未能应用指定冻结位置，已恢复原视图。 \[freeze-diagnostic /);
 const detail=JSON.parse(failure.message.match(/\[freeze-diagnostic (.*)\]$/)[1]);
 assert.deepEqual(detail.expected,{columns:1,rows:1});assert.deepEqual(detail.actual,{columns:1,rows:0});
 assert.deepEqual(detail.before,[0,0,0,0,0,0,2,0,0,0,0]);assert.deepEqual(detail.target,[0,0,2,2,1,1,2,0,1,0,1]);
 assert.deepEqual(detail.afterCheck,[0,0,2,0,1,0,2,0,1,0,1]);
 assert.deepEqual(detail.container,[0,0,1280,800]);assert.deepEqual(detail.component,[0,115,1280,52]);
 assert.ok(failure.message.length<1500);assert.equal(f.record,f.original);assert.equal(f.selection,selected);
 assert.deepEqual(f.calls.slice(-6),['getViewData','frame','container','component','rollback','select']);assert.ok(!f.calls.includes('modified'));
});
test('Ordinary freeze failures retain the original message and successful smoke actions perform no extra native reads',()=>{
 const user=failedFreezeFixture();assert.throws(()=>user.api.action({type:'freeze',columns:1,rows:1}),error=>error.message==='原生表格未能应用指定冻结位置，已恢复原视图。');
 assert.equal(user.calls.filter(x=>x==='getViewData').length,2);assert.ok(!user.calls.includes('frame'));assert.equal(user.record,user.original);
 const normal=failedFreezeFixture({fail:false}),smoke=failedFreezeFixture({smoke:true,fail:false});
 for(const f of [normal,smoke])f.api.action({type:'freeze',columns:1,rows:1});
 assert.deepEqual(smoke.calls,normal.calls);assert.ok(!smoke.calls.includes('frame'));assert.ok(smoke.calls.includes('modified'));
});
test('Optional freeze diagnostics consume UNO errors without replacing the mismatch or preventing rollback',()=>{
 const f=failedFreezeFixture({smoke:true}),native={uno:'diagnostic window unavailable'};
 f.view.getFrame=()=>{throw native};
 assert.throws(()=>f.api.action({type:'freeze',columns:1,rows:1}),error=>{
   assert.match(error.message,/原生表格未能应用指定冻结位置/);const detail=JSON.parse(error.message.match(/\[freeze-diagnostic (.*)\]$/)[1]);assert.equal(detail.container,null);assert.equal(detail.component,null);return true;
 });
 assert.deepEqual(f.caught,[native]);assert.equal(f.record,f.original);assert.deepEqual(f.calls.slice(-2),['rollback','select']);
});
test('Failed diagnostic view and window reads stay bounded and never include native text payloads',()=>{
 for(const failure of ['view','container','component']){
   const f=failedFreezeFixture({smoke:true}),native={uno:'private text must not enter logs'},read=f.view.getViewData;let reads=0;
   f.view.getViewData=()=>{if(++reads===3&&failure==='view')throw native;return read()};
   const rectangle=name=>({getPosSize:()=>{if(failure===name)throw native;return {X:'private cell text',Y:Infinity,Width:1280,Height:52}}});
   f.view.getFrame=()=>({getContainerWindow:()=>rectangle('container'),getComponentWindow:()=>rectangle('component')});
   assert.throws(()=>f.api.action({type:'freeze',columns:1,rows:1}),error=>{
     const detail=JSON.parse(error.message.match(/\[freeze-diagnostic (.*)\]$/)[1]);
     assert.equal(detail[failure==='view'?'afterCheck':failure],null);
     if(failure!=='container')assert.deepEqual(detail.container,[null,null,1280,52]);
     if(failure!=='component')assert.deepEqual(detail.component,[null,null,1280,52]);
     assert.doesNotMatch(error.message,/private/);assert.ok(error.message.length<1500);return true;
   });
   assert.equal(reads,3);assert.deepEqual(f.caught,[native]);assert.equal(f.record,f.original);assert.deepEqual(f.calls.slice(-2),['rollback','select']);
 }
});
test('Freeze diagnostic WASM traps remain fatal after the original view is restored',()=>{
 const f=failedFreezeFixture({smoke:true}),trap=vm.runInContext('new WebAssembly.RuntimeError("diagnostic memory trap")',f.context);
 f.view.getFrame=()=>{throw trap};assert.throws(()=>f.api.action({type:'freeze',columns:1,rows:1}),error=>error===trap);
 assert.deepEqual(f.caught,[]);assert.equal(f.record,f.original);assert.deepEqual(f.calls.slice(-2),['rollback','select']);
});


test('Native range fill validates direction and target extent before invoking the engine',()=>{
 const f=fixture();for(const input of [{type:'fill',range:'A1',direction:'down'},{type:'fill',range:'A1:A5',direction:'right'},{type:'fill',range:'A1:B2',direction:'diagonal'},{type:'fill',range:'A1:XFD1048576',direction:'down'}])assert.throws(()=>f.api.action(input));assert.deepEqual(f.changes,[]);
 f.api.action({type:'fill',range:'B2:D5',direction:'down'});assert.deepEqual(plain(f.changes.at(-1)),{type:'fill-series',args:[0,0,0,0,0]});
 f.api.action({type:'fill',range:'B2:D5',direction:'right'});assert.deepEqual(plain(f.changes.at(-1)),{type:'fill-series',args:[1,0,0,0,0]});
 f.protect();assert.throws(()=>f.api.action({type:'fill',range:'A1:A2',direction:'down'}),/保护/);
});
test('Selection summary counts literal numeric text separately and never changes workbook contents',()=>{
 const f=fixture();f.api.action({type:'set-matrix',range:'A1:C2',cells:[[1,2,'003'],[null,-3,'text']]});f.changes.length=0;
 assert.deepEqual(plain(f.api.data({type:'summary',range:'A1:C2'})),{range:'A1:C2',count:5,numericCount:3,sum:0,average:0,minimum:-3,maximum:2,errorCount:0,includesHidden:false});
 assert.deepEqual(f.changes,[]);assert.throws(()=>f.api.data({type:'summary',range:'A1:XFD1048576'}),/最多/);
 const empty=f.api.data({type:'summary',range:'D1:D2'});assert.equal(empty.numericCount,0);assert.equal(empty.average,null);assert.equal(empty.minimum,null);assert.equal(empty.maximum,null);
});

test('Selection summary excludes hidden or filtered rows by default with an explicit include option',()=>{
 const f=fixture();f.api.action({type:'set-matrix',range:'A1:A3',cells:[[10],[20],[30]]});f.active.getRows=()=>({getByIndex:index=>({getPropertySetInfo:()=>({hasPropertyByName:name=>name==='IsVisible'}),getPropertyValue:()=>index!==1})});
 assert.equal(f.api.data({type:'summary',range:'A1:A3'}).sum,40);const all=f.api.data({type:'summary',range:'A1:A3',includeHidden:true});assert.equal(all.sum,60);assert.equal(all.includesHidden,true);assert.throws(()=>f.api.data({type:'summary',range:'A1:A3',includeHidden:'yes'}));assert.throws(()=>f.api.data({type:'range',range:'A1:A3',includeHidden:true}));
});

test('Fill preflight rejects merged cells, arrays and a discontinuous selection before writing',()=>{
 const f=fixture(),original=f.active.createCursorByRange;f.active.createCursorByRange=cell=>({collapseToMergedArea:()=>{},getRangeAddress:()=>({...cell.getRangeAddress(),EndColumn:1})});assert.throws(()=>f.api.action({type:'fill',range:'A1:A2',direction:'down'}),/合并/);assert.deepEqual(f.changes,[]);f.active.createCursorByRange=original;
 const get=f.active.getCellByPosition;f.active.getCellByPosition=(...args)=>({...get(...args),getArrayFormula:()=>'{=ROW(A1:A2)}'});assert.throws(()=>f.api.action({type:'fill',range:'A1:A2',direction:'down'}),/数组/);assert.deepEqual(f.changes,[]);f.active.getCellByPosition=get;
 const a=f.active.getCellByPosition(0,0).getRangeAddress();f.model.getCurrentController().select({getRangeAddresses:()=>[a,{...a,StartColumn:2,EndColumn:2}]});assert.throws(()=>f.api.action({type:'fill',direction:'down'}),/连续/);assert.deepEqual(f.changes,[]);
});
