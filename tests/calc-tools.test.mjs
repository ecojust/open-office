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
  const initial={CharFontName:'Noto Sans',CharHeight:11,CharWeight:100,CharPosture:0,CharColor:0,IsCellBackgroundTransparent:true,CellBackColor:0xffffff,HoriJustify:0,VertJustify:0,IsTextWrapped:false,NumberFormat:0};
  function props(values){return {getPropertySetInfo:()=>({hasPropertyByName:name=>name in values}),getPropertyValue(name){assert.ok(name in values,'preflight all property reads');return values[name]},setPropertyValue(name,value){assert.ok(name in values);changes.push({type:'property',name,value:unwrap(value)});values[name]=unwrap(value)}}}
  function makeSheet(name){const grid=new Map(),formats=new Map(),kinds=new Map();let sheetName=name;const sheetProps={IsVisible:true};
    function range(c,r,e=c,b=r){const key=c+','+r;const values=formats.get(key)||{...initial};formats.set(key,values);
      const read=()=>Array.from({length:b-r+1},(_,row)=>Array.from({length:e-c+1},(_,col)=>grid.get(`${c+col},${r+row}`)??''));
      const write=(rows,type)=>{changes.push({type,rows});rows.forEach((row,ri)=>row.forEach((value,ci)=>{const k=`${c+ci},${r+ri}`;grid.set(k,value);kinds.set(k,type==='formula-array'&&String(value).startsWith('=')?'formula':typeof value==='number'?'number':'text')}))};
      return {...props(values),getRangeAddress:()=>({Sheet:names.indexOf(sheet),StartColumn:c,StartRow:r,EndColumn:e,EndRow:b}),getFormulaArray:()=>read().map(row=>row.map(String)),getDataArray:read,setFormulaArray:rows=>write(rows,'formula-array'),setDataArray:rows=>write(rows,'data-array'),getFormula:()=>String(grid.get(key)??''),getString:()=>String(grid.get(key)??''),getValue:()=>typeof grid.get(key)==='number'?grid.get(key):0,getType:()=>!grid.has(key)?0:typeof grid.get(key)==='number'?1:2,getError:()=>0,setFormula:value=>{changes.push({type:'formula',value});grid.set(key,value);kinds.set(key,value.startsWith('=')?'formula':value?'text':'empty')},setString:value=>{changes.push({type:'string',value});grid.set(key,value);kinds.set(key,'text')},setValue:value=>{changes.push({type:'number',value});grid.set(key,value);kinds.set(key,'number')},queryContentCells:flags=>({getRangeAddresses:()=>{const result=[];for(let row=r;row<=b;row++)for(let col=c;col<=e;col++){const kind=kinds.get(`${col},${row}`);if(flags==={number:3,text:4,formula:16}[kind])result.push({Sheet:names.indexOf(sheet),StartColumn:col,EndColumn:col,StartRow:row,EndRow:row})}return result}}),getIsMerged:()=>false,merge:value=>changes.push({type:'merge',value})}
    }
    const sheet={...props(sheetProps),getName:()=>sheetName,setName:value=>{changes.push({type:'rename',value});sheetName=value},getCellByPosition:range,getCellRangeByPosition:range,getCellRangeByName:()=>range(0,0),isProtected:()=>protectedSheet,grid,formats};return sheet
  }
  names.push(makeSheet('Sheet1'));active=names[0];selection=active.getCellByPosition(0,0);
  const sheets={getCount:()=>names.length,getElementNames:()=>names.map(sheet=>sheet.getName()),getByIndex:index=>names[index],getByName:name=>names.find(sheet=>sheet.getName()===name),hasByName:name=>names.some(sheet=>sheet.getName()===name),insertNewByName(name,index){changes.push({type:'insert-sheet',name});names.splice(index,0,makeSheet(name))},copyByName(from,name,index){changes.push({type:'copy-sheet',from,name});const copy=makeSheet(name);names.splice(index,0,copy)},removeByName(name){changes.push({type:'delete-sheet',name});names.splice(names.findIndex(sheet=>sheet.getName()===name),1);active=names[0]},moveByName(name,index){changes.push({type:'move-sheet',name,index});const old=names.findIndex(sheet=>sheet.getName()===name);names.splice(index,0,names.splice(old,1)[0])}};
  const controller={getActiveSheet:()=>active,setActiveSheet:sheet=>{active=sheet},getSelection:()=>selection,select:value=>{selection=value},hasFrozenPanes:()=>false,splitAtPosition:(x,y)=>changes.push({type:'split',x,y}),getFirstVisibleColumn:()=>0,getFirstVisibleRow:()=>0,setFirstVisibleColumn:column=>changes.push({type:'scroll-column',column}),setFirstVisibleRow:row=>changes.push({type:'scroll-row',row}),freezeAtPosition:(column,row)=>changes.push({type:'freeze',column,row})};
  controller.getCount=()=>1;controller.getByIndex=()=>controller;
  const model={...props({}),supportsService:value=>value==='com.sun.star.sheet.SpreadsheetDocument',getSheets:()=>sheets,getCurrentController:()=>controller,isReadonly:()=>false,getNumberFormats:()=>({getByKey:()=>props({FormatString:'General'})})};
  vm.runInContext(source,context);
  const api=context.createCalcTools({zetajs:{Any,type:{float:'float',long:'long',short:'short'},catchUnoException:error=>{caught.push(error);return {Message:'optional native property'}}},css:{sheet:{DataPilotFieldOrientation:{HIDDEN:0,ROW:1,COLUMN:2,PAGE:3,DATA:4},GeneralFunction:{SUM:1,COUNT:2,AVERAGE:3}},beans:{PropertyValue:Struct},awt:{FontSlant:{NONE:0,ITALIC:2}},table:{CellHoriJustify:{STANDARD:0,LEFT:1,CENTER:2,RIGHT:3,BLOCK:4},CellVertJustify:{STANDARD:0,TOP:1,CENTER:2,BOTTOM:3}}},getModel:()=>{environmentReads++;return model},dispatch:(command,args)=>changes.push({type:'dispatch',command,args:args.map(item=>({name:item.Name,value:unwrap(item.Value)}))})});
  return {api,changes,caught,context,names,model,makeSheet,get environmentReads(){return environmentReads},get active(){return active},get selection(){return selection},protect:()=>{protectedSheet=true}};
}
const plain=value=>JSON.parse(JSON.stringify(value));

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
