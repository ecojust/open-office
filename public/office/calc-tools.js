/* Bounded operations on the real local Calc UNO model. SPDX-License-Identifier: MIT */
'use strict';
(function (scope) {
  const MAX_CELLS = 10000, MAX_SHEETS = 256, MAX_COLUMN = 16383, MAX_ROW = 1048575;
  const actions = {
    'select-sheet':['sheetIndex'], 'add-sheet':['name'], 'rename-sheet':['sheetIndex','name'],
    'duplicate-sheet':['sheetIndex','name'], 'delete-sheet':['sheetIndex'], 'move-sheet':['sheetIndex','targetIndex'],
    'set-sheet-hidden':['sheetIndex','hidden'], 'select-range':['sheetIndex','range'], 'set-cell':['sheetIndex','address','input'], 'patch-cells':['sheetIndex','cells'],
    'set-matrix':['sheetIndex','range','cells','formulas'],
    'fill':['sheetIndex','range','direction'],
    format:['sheetIndex','range','fontName','fontSize','bold','italic','textColor','backgroundColor','align','verticalAlign','wrap','numberFormat'],
    merge:['sheetIndex','range','merged'], 'insert-rows':['sheetIndex','index','count'], 'delete-rows':['sheetIndex','index','count'],
    'insert-columns':['sheetIndex','index','count'], 'delete-columns':['sheetIndex','index','count'],
    'set-row-height':['sheetIndex','index','count','sizeMm'], 'set-column-width':['sheetIndex','index','count','sizeMm'],
    sort:['sheetIndex','range','column','ascending','header'], filter:['sheetIndex','range','column','operator','value','header'],
    'clear-filter':['sheetIndex','range'], freeze:['columns','rows'],
    'conditional-format':['sheetIndex','range','operator','value','secondValue','backgroundColor','textColor'],
    'clear-conditional-format':['sheetIndex','range'], validation:['sheetIndex','range','kind','minimum','maximum','items','allowBlank'],
    'define-name':['sheetIndex','range','name'], 'delete-name':['name'],
    'insert-chart':['sheetIndex','range','name','chartType','headerRow','headerColumn'],
    'insert-pivot':['sheetIndex','range','name','rowField','dataField','operation','outputSheetIndex','outputAddress'],
    'delete-chart':['sheetIndex','name'],'delete-pivot':['sheetIndex','name'],'refresh-pivot':['sheetIndex','name'],
  };
  function object(value,keys) { if(!value||typeof value!=='object'||Array.isArray(value))throw Error('操作参数必须为对象。');for(const key of Object.keys(value))if(!keys.includes(key))throw Error(`不支持的参数：${key}`);return value; }
  function num(value,min,max,label,integer=false){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value))throw Error(`${label}必须为 ${min}–${max} 内的${integer?'整数':'数值'}。`);return value}
  function str(value,max,label,empty=false){if(typeof value!=='string'||value.length>max||!empty&&!value.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw Error(`${label}内容或长度无效。`);return value}
  function bool(value,label){if(typeof value!=='boolean')throw Error(`${label}必须为布尔值。`);return value}
  function one(value,items,label){if(!items.includes(value))throw Error(`不支持的${label}。`);return value}
  function color(value,nullable=false){if(nullable&&value===null)return value;if(typeof value!=='string'||!/^#[a-f0-9]{6}$/i.test(value))throw Error('颜色必须为 #RRGGBB。');return value}
  function columnName(index){let name='';do{name=String.fromCharCode(65+index%26)+name;index=Math.floor(index/26)-1}while(index>=0);return name}
  function cellName(column,row){return columnName(column)+(row+1)}
  function address(value,single=false){str(value,40,'单元格地址');const match=/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/i.exec(value);if(!match||single&&match[3])throw Error('请输入本工作表的 A1 或 A1:B10 地址。');const col=text=>[...text.toUpperCase()].reduce((v,c)=>v*26+c.charCodeAt(0)-64,0)-1;const c=col(match[1]),r=Number(match[2])-1,e=match[3]?col(match[3]):c,b=match[4]?Number(match[4])-1:r;num(c,0,MAX_COLUMN,'列',true);num(e,c,MAX_COLUMN,'结束列',true);num(r,0,MAX_ROW,'行',true);num(b,r,MAX_ROW,'结束行',true);return {startColumn:c,startRow:r,endColumn:e,endRow:b,address:cellName(c,r)+(c===e&&r===b?'':':'+cellName(e,b))}}
  function sheetName(value){str(value,31,'工作表名称');if(/[\[\]:*?\/\\]/.test(value)||value.startsWith("'")||value.endsWith("'"))throw Error('工作表名称含 Excel 不支持的字符。');return value}
  function rangeName(value){str(value,120,'名称');if(!/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(value)||/^[a-z]{1,3}[1-9]\d*$/i.test(value)||/^[rc]$/i.test(value))throw Error('名称必须以文字或下划线开头，不能为单元格地址。');return value}
  function validateAction(data){const keys=data&&Object.hasOwn(actions,data.type)?actions[data.type]:[];object(data,['type','expectedRevision',...keys]);if(!Object.hasOwn(actions,data.type))throw Error('不支持的工作表操作。');
    if(data.sheetIndex!==undefined)num(data.sheetIndex,0,32766,'工作表编号',true);if(data.range!==undefined)address(data.range);
    switch(data.type){
      case 'select-sheet':case 'delete-sheet':num(data.sheetIndex,0,32766,'工作表编号',true);break;
      case 'add-sheet':if(data.name!==undefined)sheetName(data.name);break;
      case 'rename-sheet':case 'duplicate-sheet':num(data.sheetIndex,0,32766,'工作表编号',true);sheetName(data.name);break;
      case 'move-sheet':num(data.sheetIndex,0,32766,'工作表编号',true);num(data.targetIndex,0,32766,'目标位置',true);break;
      case 'set-sheet-hidden':num(data.sheetIndex,0,32766,'工作表编号',true);bool(data.hidden,'隐藏状态');break;
      case 'select-range':address(data.range);break;
      case 'set-cell':address(data.address,true);str(data.input,32767,'单元格内容',true);break;
      case 'patch-cells':{if(!Array.isArray(data.cells)||!data.cells.length||data.cells.length>MAX_CELLS)throw Error(`一次修改需要 1–${MAX_CELLS} 个单元格。`);const seen=new Set();let total=0;for(const cell of data.cells){object(cell,['address','kind','value']);const parsed=address(cell.address,true);if(seen.has(parsed.address))throw Error('同一单元格不能重复修改。');seen.add(parsed.address);one(cell.kind,['empty','number','text','formula'],'单元格类型');if(cell.kind==='number')num(cell.value,-1e100,1e100,'数值');else {str(cell.value,32767,'单元格内容',true);total+=cell.value.length;if(cell.kind==='formula'&&!cell.value.startsWith('='))throw Error('公式必须以 = 开头。');if(cell.kind==='empty'&&cell.value!=='')throw Error('空单元格值必须为空字符串。')}}if(total>1000000)throw Error('一次修改文字总量不能超过一百万字符。');break}
      case 'set-matrix':{if(!Array.isArray(data.cells)||!data.cells.length||!Array.isArray(data.cells[0])||!data.cells[0].length)throw Error('请输入矩形数据。');const width=data.cells[0].length;let textLength=0;if(data.cells.length*width>MAX_CELLS)throw Error(`一次最多写入 ${MAX_CELLS} 个单元格。`);for(const row of data.cells){if(!Array.isArray(row)||row.length!==width)throw Error('每行数据列数必须相同。');for(const value of row){if(typeof value==='string'){str(value,32767,'单元格内容',true);textLength+=value.length}else if(typeof value==='number')num(value,-1e100,1e100,'单元格数值');else if(value!==null&&typeof value!=='boolean')throw Error('单元格只支持文字、数字、布尔值或空值。')}}if(textLength>1000000)throw Error('一次粘贴文字总量不能超过一百万字符。');if(data.formulas!==undefined)bool(data.formulas,'公式模式');break}
      case 'format':if(data.fontName!==undefined)str(data.fontName,120,'字体');if(data.fontSize!==undefined)num(data.fontSize,5,200,'字号');for(const key of ['bold','italic','wrap'])if(data[key]!==undefined)bool(data[key],key);if(data.textColor!==undefined)color(data.textColor);if(data.backgroundColor!==undefined)color(data.backgroundColor,true);if(data.align!==undefined)one(data.align,['default','left','center','right','justify'],'水平对齐');if(data.verticalAlign!==undefined)one(data.verticalAlign,['default','top','center','bottom'],'垂直对齐');if(data.numberFormat!==undefined)str(data.numberFormat,120,'数字格式');break;
      case 'merge':bool(data.merged,'合并状态');break;
      case 'fill':one(data.direction,['down','right'],'填充方向');break;
      case 'insert-rows':case 'delete-rows':case 'insert-columns':case 'delete-columns':case 'set-row-height':case 'set-column-width':num(data.index,0,data.type.includes('column')?MAX_COLUMN:MAX_ROW,'起始位置',true);num(data.count,1,1000,'数量',true);if(data.index+data.count>(data.type.includes('column')?MAX_COLUMN:MAX_ROW)+1)throw Error('行列范围越界。');if(data.type.startsWith('set-'))num(data.sizeMm,.1,500,'尺寸（毫米）');break;
      case 'sort':num(data.column,0,MAX_COLUMN,'排序列',true);bool(data.ascending,'升序');bool(data.header,'标题行');break;
      case 'filter':num(data.column,0,MAX_COLUMN,'筛选列',true);one(data.operator,['equal','not-equal','contains','greater','less'],'筛选条件');if(typeof data.value==='number'){num(data.value,-1e100,1e100,'筛选值');if(data.operator==='contains')throw Error('包含筛选需要文字条件。')}else str(data.value,1000,'筛选值',true);bool(data.header,'标题行');break;
      case 'freeze':num(data.columns,0,256,'冻结列数',true);num(data.rows,0,1000,'冻结行数',true);break;
      case 'conditional-format':one(data.operator,['greater','less','equal','between'],'条件格式');num(data.value,-1e100,1e100,'条件值');if(data.operator==='between'){num(data.secondValue,-1e100,1e100,'第二条件值');if(data.secondValue<data.value)throw Error('第二条件值不能小于第一个。')}color(data.backgroundColor);if(data.textColor!==undefined)color(data.textColor);break;
      case 'validation':one(data.kind,['none','whole','decimal','list'],'数据验证');if(['whole','decimal'].includes(data.kind)){num(data.minimum,-1e100,1e100,'最小值',data.kind==='whole');num(data.maximum,data.minimum,1e100,'最大值',data.kind==='whole')}if(data.kind==='list'){if(!Array.isArray(data.items)||data.items.length<1||data.items.length>100)throw Error('列表需要 1–100 项。');for(const item of data.items){str(item,120,'列表项');if(/[;\n\r"]/.test(item))throw Error('列表项不能包含分号、引号或换行。')}if(data.items.join(';').length>250)throw Error('列表总长度不能超过 250 字符。')}if(data.allowBlank!==undefined)bool(data.allowBlank,'允许空白');break;
      case 'define-name':rangeName(data.name);address(data.range);break;case 'delete-name':rangeName(data.name);break;
      case 'delete-chart':case 'delete-pivot':case 'refresh-pivot':str(data.name,80,'对象名称');break;
      case 'insert-chart':str(data.name,80,'图表名称');one(data.chartType,['column','bar','line','pie'],'图表类型');bool(data.headerRow,'标题行');bool(data.headerColumn,'标题列');break;
      case 'insert-pivot':str(data.name,80,'透视表名称');num(data.rowField,0,MAX_COLUMN,'行字段',true);num(data.dataField,0,MAX_COLUMN,'数据字段',true);if(data.rowField===data.dataField)throw Error('行字段与汇总字段必须不同。');one(data.operation,['sum','count','average'],'汇总方式');if(data.outputSheetIndex!==undefined)num(data.outputSheetIndex,0,32766,'输出工作表',true);address(data.outputAddress,true);break;
    }return data}
  scope.createCalcTools=function({zetajs,css,getModel,dispatch}){
    if(!zetajs||!css||typeof getModel!=='function')throw Error('缺少电子表格环境。');
    const typed=(name,value)=>new zetajs.Any(zetajs.type[name],value), prop=(Name,Value)=>new css.beans.PropertyValue({Name,Value});
    const enumValue=value=>typeof value==='number'?value:value?.value;
    function recover(error){if(error instanceof WebAssembly.RuntimeError)throw error;if(error instanceof Error)return;try{zetajs.catchUnoException(error)}catch(caught){if(caught instanceof WebAssembly.RuntimeError)throw caught}}
    const has=(target,name)=>{try{return !!target.getPropertySetInfo()?.hasPropertyByName(name)}catch(error){recover(error);return false}};
    const read=(target,name,fallback=null)=>{if(!has(target,name))return fallback;try{return target.getPropertyValue(name)??fallback}catch(error){recover(error);return fallback}};
    function set(target,name,value){if(!has(target,name))throw Error(`当前对象不支持属性 ${name}。`);target.setPropertyValue(name,value)}
    const hex=value=>typeof value==='number'&&value>=0?'#'+(value&0xffffff).toString(16).padStart(6,'0').toUpperCase():null;
    const rgb=value=>parseInt(value.slice(1),16);
    function environment(index){const model=getModel();if(!model||!model.supportsService('com.sun.star.sheet.SpreadsheetDocument'))throw Error('请先打开电子表格。');const sheets=model.getSheets(),count=sheets.getCount();if(!count)throw Error('文档没有工作表。');const controller=model.getCurrentController(),active=controller.getActiveSheet();const activeIndex=active.getCellRangeByPosition(0,0,0,0).getRangeAddress().Sheet;if(index!==undefined&&index>=count)throw Error('工作表已删除或编号越界。');return {model,sheets,controller,index:index??activeIndex,activeIndex,sheet:index===undefined?active:sheets.getByIndex(index),count}}
    function selection(env){let selected=env.controller.getSelection(),a,multiple=false;try{a=selected.getRangeAddress()}catch(error){recover(error);try{const ranges=selected.getRangeAddresses();if(ranges.length){a=ranges[0];multiple=ranges.length>1}}catch(other){recover(other)}}const available=!!a&&a.Sheet===env.index&&['StartColumn','StartRow','EndColumn','EndRow'].every(key=>Number.isSafeInteger(a[key]))&&a.StartColumn>=0&&a.StartRow>=0&&a.EndColumn>=a.StartColumn&&a.EndRow>=a.StartRow&&a.EndColumn<=MAX_COLUMN&&a.EndRow<=MAX_ROW;if(!available)a={Sheet:env.index,StartColumn:0,StartRow:0,EndColumn:0,EndRow:0};return {sheetIndex:a.Sheet,startColumn:a.StartColumn,startRow:a.StartRow,endColumn:a.EndColumn,endRow:a.EndRow,address:cellName(a.StartColumn,a.StartRow)+(a.StartColumn===a.EndColumn&&a.StartRow===a.EndRow?'':':'+cellName(a.EndColumn,a.EndRow)),multiple,available}}
    function range(env,name,bounded=true){const a=name?address(name):selection(env);if(!name&&(a.multiple||a.available===false))throw Error('请先选择一个连续单元格区域。');if(bounded&&(a.endColumn-a.startColumn+1)*(a.endRow-a.startRow+1)>MAX_CELLS)throw Error(`一次操作最多 ${MAX_CELLS} 个单元格，请缩小选区。`);return {area:a,cells:env.sheet.getCellRangeByPosition(a.startColumn,a.startRow,a.endColumn,a.endRow)}}
    function select(env,cells){if(!read(env.sheet,'IsVisible',true))throw Error('请先取消隐藏这张工作表。');env.controller.setActiveSheet(env.sheet);env.controller.select(cells)}
    function editable(env){if(typeof env.model.isReadonly==='function'&&env.model.isReadonly())throw Error('文档为只读，不能修改。');if(typeof env.sheet.isProtected==='function'&&env.sheet.isProtected())throw Error('工作表已保护，请先在原生菜单中取消保护。')}
    function plainContentTarget(env,column,row){
      const cell=env.sheet.getCellByPosition(column,row);
      // Covered cells report getIsMerged() === false and native setters can
      // store invisible values in them. Resolve their full native merge area
      // without changing the selection; only the visible anchor is writable.
      const unknown=()=>{throw Error('无法确认目标单元格的合并状态，未修改内容。')};
      if(typeof env.sheet.createCursorByRange!=='function')unknown();
      const cursor=env.sheet.createCursorByRange(cell);
      if(!cursor||typeof cursor.collapseToMergedArea!=='function'||typeof cursor.getRangeAddress!=='function')unknown();
      cursor.collapseToMergedArea();const merged=cursor.getRangeAddress();
      if(!merged||!['Sheet','StartColumn','EndColumn','StartRow','EndRow'].every(key=>Number.isInteger(merged[key]))
        ||merged.Sheet!==env.index||merged.StartColumn<0||merged.StartRow<0||merged.EndColumn>MAX_COLUMN||merged.EndRow>MAX_ROW
        ||merged.StartColumn>column||merged.EndColumn<column||merged.StartRow>row||merged.EndRow<row)unknown();
      if(merged.StartColumn!==column||merged.StartRow!==row)throw Error(`目标 ${cellName(column,row)} 是合并区域的覆盖格。请编辑左上角 ${cellName(merged.StartColumn,merged.StartRow)}，或先取消合并；本次内容未修改。`);
      // Single-cell UNO setters can overwrite one array member without rejecting
      // it, leaving an array range whose cached value changes again on reopen.
      // These tools edit ordinary cells only; array replacement belongs to the
      // native whole-array editor. Inspect all batch targets before any setter.
      if(typeof cell.getArrayFormula!=='function')throw Error('无法确认目标单元格的数组公式状态，未修改内容。');
      const formula=cell.getArrayFormula();
      if(typeof formula!=='string')throw Error('无法确认目标单元格的数组公式状态，未修改内容。');
      if(formula)throw Error('目标包含数组公式，不能逐格改写。请在画布中选择完整数组范围后编辑；本次内容未修改。');
      // UNO content setters bypass Calc's interactive validation dialogs. Do
      // not approximate custom formulas or list/range dependencies here: STOP
      // rules must use the native cell editor. Advisory/no-alert rules retain
      // their existing behavior. These are authoritative reads, not fallbacks.
      const validation=cell.getPropertyValue('Validation');
      if(!validation||typeof validation.getPropertyValue!=='function')throw Error('无法确认目标单元格的数据验证规则，未修改内容。');
      const kind=enumValue(validation.getPropertyValue('Type'));
      if(kind===enumValue(css.sheet.ValidationType.ANY))return cell;
      if(!['WHOLE','DECIMAL','LIST','DATE','TIME','TEXT_LEN','CUSTOM'].some(name=>kind===enumValue(css.sheet.ValidationType[name])))throw Error('无法确认目标单元格的数据验证类型，未修改内容。');
      const showError=validation.getPropertyValue('ShowErrorMessage');
      if(showError===false)return cell;
      if(showError!==true)throw Error('无法确认目标单元格的数据验证提示方式，未修改内容。');
      const alert=enumValue(validation.getPropertyValue('ErrorAlertStyle'));
      if(alert===enumValue(css.sheet.ValidationAlertStyle.WARNING)||alert===enumValue(css.sheet.ValidationAlertStyle.INFO))return cell;
      throw Error('目标包含需由原生编辑器检查的数据验证规则，请在画布单元格中输入；本次内容未修改。');
    }
    function plainContentRange(env,area){
      for(let row=area.startRow;row<=area.endRow;row++)for(let column=area.startColumn;column<=area.endColumn;column++)plainContentTarget(env,column,row);
    }
    function named(model){return read(model,'NamedRanges')}
    function richText(cell,value){if(typeof value!=='string'||!value.includes('\u0001'))return value;const cursor=cell.createTextCursor();cursor.gotoStart(false);cursor.gotoEnd(true);return cursor.getString()}
    // Native Calc 24.2 view snapshot: viewdata.cxx Write/ReadUserData (fixed
    // engine commit efaf0670b4d055f838a2849becb10f08aa06a257). A sheet has
    // cursor X/Y, H/V split modes, fixed X/Y, active pane, and four pane offsets.
    // Rows beyond 8192 use '+' instead of '/'; preserve the original delimiter.
    function nativeView(env){
      if(typeof env.controller.getViewData!=='function')return null;
      const value=env.controller.getViewData();if(typeof value!=='string')return null;
      const parts=value.split(';'),start=parts[2]?.startsWith('tw:')?3:2,index=start+env.activeIndex,entry=parts[index];if(!entry)return null;
      const separator=entry.includes('+')?'+':'/',fields=entry.split(separator);if(fields.length!==11||!fields.every(item=>/^\d+$/.test(item)))return null;
      return {value,parts,index,fields,separator}
    }
    function frozenState(env){
      if(!env.controller.hasFrozenPanes())return {columns:0,rows:0};
      // getSplitRow/Column convert split pixels back to cells; variable row
      // heights may round to the next cell. XController view data instead
      // contains the actual fixed row/column persisted by this Calc engine.
      const view=nativeView(env);if(view)return {columns:Number(view.fields[2])===2?Number(view.fields[4]):0,rows:Number(view.fields[3])===2?Number(view.fields[5]):0};
      return {columns:env.controller.getSplitColumn(),rows:env.controller.getSplitRow()}
    }
    function freezeFailureDiagnostic(env,record,fields,expected,actual){
      // Smoke-host diagnostics only: fixed-size numeric view metadata, never
      // cell contents. Optional UNO reads must not prevent the existing rollback.
      const attempt=read=>{try{return read()}catch(error){recover(error);return null}};
      const numericFields=value=>value?.slice(0,11).map(item=>{const number=Number(item);return Number.isSafeInteger(number)?number:null})??null;
      const after=attempt(()=>nativeView(env)),frame=attempt(()=>env.controller.getFrame());
      const rectangle=method=>attempt(()=>{
        const window=frame?.[method]?.();if(!window||typeof window.getPosSize!=='function')return null;
        const value=window.getPosSize();if(!value)return null;
        return ['X','Y','Width','Height'].map(key=>Number.isSafeInteger(value[key])?value[key]:null);
      });
      return {expected,actual,activeSheet:env.activeIndex,before:numericFields(record.fields),target:numericFields(fields),afterCheck:numericFields(after?.fields),container:rectangle('getContainerWindow'),component:rectangle('getComponentWindow')};
    }
    function formulaInput(cell){const value=cell.getFormula();return enumValue(cell.getType())===2&&value.startsWith('=')?"'"+value:value}
    const formatProperties={fontName:['CharFontName','CharFontNameAsian','CharFontNameComplex'],fontSize:['CharHeight','CharHeightAsian','CharHeightComplex'],bold:['CharWeight','CharWeightAsian','CharWeightComplex'],italic:['CharPosture','CharPostureAsian','CharPostureComplex'],textColor:['CharColor'],backgroundColor:['IsCellBackgroundTransparent','CellBackColor'],align:['HoriJustify'],verticalAlign:['VertJustify'],wrap:['IsTextWrapped'],numberFormat:['NumberFormat']};
    const textFormatKeys=['fontName','fontSize','bold','italic','textColor'];
    // FORMATTED (512), not EDITATTR, selects Calc edit-engine cells, including
    // multi-paragraph text. Query native ranges, never scan every selected cell.
    function richRanges(env,cells,area){
      const ranges=Array.from(cells.queryContentCells(512).getRangeAddresses());
      for(const a of ranges)if(!a||a.Sheet!==env.index||!['StartColumn','EndColumn','StartRow','EndRow'].every(k=>Number.isSafeInteger(a[k]))||a.StartColumn<area.startColumn||a.EndColumn>area.endColumn||a.StartRow<area.startRow||a.EndRow>area.endRow||a.StartColumn>a.EndColumn||a.StartRow>a.EndRow)throw Error('无法确认选区中的局部文字格式。');
      return ranges;
    }
    function formatStatus(env,area){
      const mixedFormat=[],unavailableFormat=[],keys=Object.keys(formatProperties),result={mixedFormat,unavailableFormat,richTextFormat:false};
      if(!area.available||area.multiple||(area.endColumn-area.startColumn+1)*(area.endRow-area.startRow+1)>MAX_CELLS){unavailableFormat.push(...keys);return result}
      const cells=env.sheet.getCellRangeByPosition(area.startColumn,area.startRow,area.endColumn,area.endRow),names=Object.values(formatProperties).flat();let states;
      try{states=Array.from(cells.getPropertyStates(names),enumValue);if(states.length!==names.length||states.some(value=>![0,1,2].includes(value)))throw Error('Invalid property states')}catch(error){recover(error);unavailableFormat.push(...keys);return result}
      const values=new Map(names.map((name,index)=>[name,states[index]]));
      for(const key of keys){
        let props=formatProperties[key];
        if(key==='backgroundColor'&&values.get('IsCellBackgroundTransparent')!==2){try{const transparent=cells.getPropertyValue('IsCellBackgroundTransparent');if(typeof transparent!=='boolean')throw Error('Invalid fill state');if(transparent)props=['IsCellBackgroundTransparent']}catch(error){recover(error);unavailableFormat.push(key);continue}}
        if(props.some(name=>values.get(name)===2))mixedFormat.push(key);
      }
      try{result.richTextFormat=richRanges(env,cells,area).length>0}catch(error){recover(error);result.richTextFormat=true}
      // Cell format properties do not report edit-engine run attributes. Keep
      // proven mixed states, otherwise show unknown rather than an anchor value.
      if(result.richTextFormat)for(const key of textFormatKeys)if(!mixedFormat.includes(key))unavailableFormat.push(key);
      return result;
    }
    function richFormatTargets(env,cells,area,changes){
      const textChanges=changes.filter(([name])=>name.startsWith('Char'));if(!textChanges.length)return [];
      let ranges;try{ranges=richRanges(env,cells,area)}catch(error){recover(error);throw Error('无法确认局部文字格式，请在画布中修改字体；本次格式未更改。')}
      const targets=[],seen=new Set();let count=0;
      for(const a of ranges){count+=(a.EndColumn-a.StartColumn+1)*(a.EndRow-a.StartRow+1);if(count>256)throw Error('一次最多修改 256 个含局部文字格式的单元格，请缩小选区。')}
      for(const a of ranges)for(let row=a.StartRow;row<=a.EndRow;row++)for(let column=a.StartColumn;column<=a.EndColumn;column++){
        const key=column+','+row;if(seen.has(key))continue;seen.add(key);
        const cell=env.sheet.getCellByPosition(column,row);let cursor;
        try{cursor=cell.createTextCursor();cursor.gotoStart(false);cursor.gotoEnd(true)}catch(error){recover(error);throw Error('此单元格的局部文字格式不能安全修改，请在画布中编辑。')}
        for(const [name]of textChanges)if(!has(cursor,name))throw Error(`当前局部文字不支持 ${name}，本次格式未更改。`);
        targets.push({cursor,changes:textChanges});
      }
      return targets;
    }
    function state(){const env=environment(),selected=selection(env),cell=env.sheet.getCellByPosition(selected.startColumn,selected.startRow),fmt=range(env,cellName(selected.startColumn,selected.startRow),false).cells;const key=read(fmt,'NumberFormat',0);let numberFormat='';try{numberFormat=read(env.model.getNumberFormats().getByKey(key),'FormatString','')}catch(error){recover(error)}let merged=false;try{merged=fmt.getIsMerged()}catch(error){recover(error)}let frozen={columns:0,rows:0};try{frozen=frozenState(env)}catch(error){recover(error)}const names=named(env.model);const nameList=names?names.getElementNames().slice(0,256).map(name=>({name,content:names.getByName(name).getContent()})):[];
      const visibleIndexes=Array.from({length:Math.min(env.count,MAX_SHEETS)},(_,index)=>index);if(!visibleIndexes.includes(env.activeIndex))visibleIndexes.push(env.activeIndex);return {sheetCount:env.count,sheetsTruncated:env.count>MAX_SHEETS,sheets:visibleIndexes.map(index=>{const sheet=env.sheets.getByIndex(index);return {index,name:sheet.getName(),visible:read(sheet,'IsVisible',true)}}),activeSheetIndex:env.activeIndex,selection:selected,
        cell:{address:cellName(selected.startColumn,selected.startRow),column:selected.startColumn,row:selected.startRow,formula:formulaInput(cell),text:cell.getString(),value:cell.getValue(),type:({0:'empty',1:'number',2:'text',3:'formula'})[enumValue(cell.getType())]||'empty',error:cell.getError()},
        format:{fontName:read(fmt,'CharFontName',''),fontSize:Number(read(fmt,'CharHeight',11)),bold:Number(read(fmt,'CharWeight',100))>=150,italic:enumValue(read(fmt,'CharPosture'))===enumValue(css.awt.FontSlant.ITALIC),textColor:hex(read(fmt,'CharColor'))||'#000000',backgroundColor:read(fmt,'IsCellBackgroundTransparent',true)?null:hex(read(fmt,'CellBackColor')),align:({0:'default',1:'left',2:'center',3:'right',4:'justify'})[enumValue(read(fmt,'HoriJustify',0))]||'default',verticalAlign:({0:'default',1:'top',2:'center',3:'bottom'})[enumValue(read(fmt,'VertJustify',0))]||'default',wrap:!!read(fmt,'IsTextWrapped',false),numberFormat,merged},...formatStatus(env,selected),frozen,namedRanges:nameList}}
    function differentName(env,name,except){const duplicate=Array.from(env.sheets.getElementNames()).find(item=>item.toLocaleLowerCase()===name.toLocaleLowerCase()&&item!==except);if(duplicate)throw Error('工作表名称已存在。')}
    function visibleCount(env){let count=0;for(let i=0;i<env.count;i++)if(read(env.sheets.getByIndex(i),'IsVisible',true))count++;return count}
    function conditionOperator(name){return css.sheet.ConditionOperator[{greater:'GREATER',less:'LESS',equal:'EQUAL',between:'BETWEEN'}[name]]}
    function action(input){const data=validateAction(input),env=environment(data.sheetIndex),type=data.type;
      if(!['select-sheet','select-range','freeze'].includes(type))editable(env);
      if(type==='select-sheet'){select(env,env.sheet.getCellRangeByName('A1'));return}
      if(type==='add-sheet'||type==='duplicate-sheet'){if(env.count>=MAX_SHEETS)throw Error('工作表数量已达到上限。');let name=data.name;if(!name){let serial=1;do{name='工作表'+serial++}while(env.sheets.hasByName(name))}differentName(env,name);if(type==='add-sheet')env.sheets.insertNewByName(name,env.count);else env.sheets.copyByName(env.sheet.getName(),name,env.index+1);const created=env.sheets.getByName(name);set(created,'IsVisible',true);env.controller.setActiveSheet(created);return}
      if(type==='rename-sheet'){differentName(env,data.name,env.sheet.getName());env.sheet.setName(data.name);return}
      if(type==='delete-sheet'||type==='set-sheet-hidden'){if((type==='delete-sheet'||data.hidden)&&read(env.sheet,'IsVisible',true)&&visibleCount(env)<2)throw Error('至少保留一张可见工作表。');if(type==='delete-sheet'){if(env.count<2)throw Error('不能删除最后一张工作表。');env.sheets.removeByName(env.sheet.getName())}else set(env.sheet,'IsVisible',!data.hidden);return}
      if(type==='move-sheet'){if(data.targetIndex>=env.count)throw Error('目标工作表位置越界。');env.sheets.moveByName(env.sheet.getName(),data.targetIndex);return}
      if(type==='freeze'){
        const view=env.controller,current=frozenState(env);if(current.columns===data.columns&&current.rows===data.rows)return;
        const record=nativeView(env);if(!record||typeof view.restoreViewData!=='function')throw Error('当前表格视图不支持精确冻结设置。');
        const previousBody=view.getByIndex(view.getCount()-1),column=previousBody.getFirstVisibleColumn(),row=previousBody.getFirstVisibleRow(),selected=view.getSelection();
        // XController's native view snapshot records absolute fixed positions.
        // Restoring those fields avoids freezeAtPosition's pixel/cursor fallback
        // when an earlier heading has scrolled out of view. Preserve all other
        // sheets, zoom settings, cursor coordinates and the marked selection.
        const fields=record.fields.slice();fields[2]=data.columns?'2':'0';fields[3]=data.rows?'2':'0';fields[4]=String(data.columns);fields[5]=String(data.rows);
        fields[7]=String(data.columns?0:column);fields[8]=String(Math.max(column,data.columns));fields[9]=String(data.rows?0:row);fields[10]=String(Math.max(row,data.rows));
        record.parts[record.index]=fields.join(record.separator);view.restoreViewData(record.parts.join(';'));view.select(selected);
        // Scroll only the bottom/right body, never a selected frozen header.
        const body=view.getByIndex(view.getCount()-1);body.setFirstVisibleColumn(Math.max(column,data.columns));body.setFirstVisibleRow(Math.max(row,data.rows));
        const actual=frozenState(env);if(actual.columns!==data.columns||actual.rows!==data.rows){
          let diagnostic='';
          try{if(typeof globalThis.auditOfficeOfflinePolicy==='function')diagnostic=' [freeze-diagnostic '+JSON.stringify(freezeFailureDiagnostic(env,record,fields,{columns:data.columns,rows:data.rows},actual))+']'}
          finally{view.restoreViewData(record.value);view.select(selected)}
          throw Error('原生表格未能应用指定冻结位置，已恢复原视图。'+diagnostic)
        }
        if(typeof env.model.isReadonly!=='function'||!env.model.isReadonly())env.model.setModified(true);
        return
      }
      if(type==='set-cell'){const a=address(data.address,true),cell=plainContentTarget(env,a.startColumn,a.startRow);cell.setFormula(data.input);select(env,cell);return}
      if(type==='patch-cells'){const targets=data.cells.map(item=>{const a=address(item.address,true);return{item,cell:plainContentTarget(env,a.startColumn,a.startRow)}});for(const {item,cell}of targets){if(item.kind==='number')cell.setValue(item.value);else if(item.kind==='text')cell.setString(item.value);else cell.setFormula(item.value)}return}
      if(type==='set-matrix'){const base=data.range?address(data.range):selection(env),endColumn=base.startColumn+data.cells[0].length-1,endRow=base.startRow+data.cells.length-1;if(base.multiple||endColumn>MAX_COLUMN||endRow>MAX_ROW)throw Error('粘贴范围无效或越界。');if(data.range?.includes(':')&&(base.endColumn!==endColumn||base.endRow!==endRow))throw Error('数据尺寸与目标选区不一致。');plainContentRange(env,{startColumn:base.startColumn,startRow:base.startRow,endColumn,endRow});const cells=env.sheet.getCellRangeByPosition(base.startColumn,base.startRow,endColumn,endRow);if(data.formulas)cells.setFormulaArray(data.cells.map(row=>row.map(value=>value===null?'':typeof value==='boolean'?value?'1':'0':String(value))));else cells.setDataArray(data.cells.map(row=>row.map(value=>value===null?'':typeof value==='boolean'?Number(value):value)));select(env,cells);return}
      if(['insert-rows','delete-rows','insert-columns','delete-columns','set-row-height','set-column-width'].includes(type)){const columns=type.includes('column'),collection=columns?env.sheet.getColumns():env.sheet.getRows();if(type.startsWith('insert-'))collection.insertByIndex(data.index,data.count);else if(type.startsWith('delete-'))collection.removeByIndex(data.index,data.count);else {const property=columns?'Width':'Height';for(let i=data.index;i<data.index+data.count;i++)if(!has(collection.getByIndex(i),property))throw Error('当前对象不支持尺寸修改。');for(let i=data.index;i<data.index+data.count;i++)set(collection.getByIndex(i),property,typed('long',Math.round(data.sizeMm*100)))}return}
      if(type==='delete-name'){const names=named(env.model);if(!names?.hasByName(data.name))throw Error('命名范围已不存在。');names.removeByName(data.name);return}
      if(['delete-chart','delete-pivot','refresh-pivot'].includes(type)){const items=type==='delete-chart'?env.sheet.getCharts():env.sheet.getDataPilotTables();if(!items.hasByName(data.name))throw Error('对象已不存在，请刷新列表。');if(type==='refresh-pivot')items.getByName(data.name).refresh();else items.removeByName(data.name);return}
      const {area,cells}=range(env,data.range);
      if(type==='select-range'){select(env,cells);return}
      if(type==='fill'){
        if(data.direction==='down'?area.endRow===area.startRow:area.endColumn===area.startColumn)throw Error('填充需要包含来源及目标：向下至少两行，向右至少两列。');
        if(typeof cells.fillSeries!=='function')throw Error('当前表格内核不支持原生填充。');
        // Preflight every selected cell before the one native mutation. Filling
        // a partial merge/array can otherwise fail after modifying early cells.
        for(let row=area.startRow;row<=area.endRow;row++)for(let column=area.startColumn;column<=area.endColumn;column++){
          const cell=env.sheet.getCellByPosition(column,row),cursor=env.sheet.createCursorByRange(cell);
          cursor.collapseToMergedArea();const merged=cursor.getRangeAddress();
          if(merged.StartColumn!==column||merged.EndColumn!==column||merged.StartRow!==row||merged.EndRow!==row)throw Error('填充选区包含合并单元格，请先取消合并。');
          if(cell.getArrayFormula())throw Error('填充选区包含数组公式，请先选择普通单元格区域。');
        }
        // Native SIMPLE fill preserves cell types/formats and translates relative
        // references. Never rebuild formulas with textual A1 replacement.
        cells.fillSeries(data.direction==='down'?css.sheet.FillDirection.TO_BOTTOM:css.sheet.FillDirection.TO_RIGHT,css.sheet.FillMode.SIMPLE,css.sheet.FillDateMode.FILL_DATE_DAY,0,0);
        return
      }
      if(type==='define-name'){const names=named(env.model);if(!names)throw Error('文档不支持命名范围。');const content=read(cells,'AbsoluteName');if(!content)throw Error('无法读取范围的完整地址。');const base=new css.table.CellAddress({Sheet:env.index,Column:area.startColumn,Row:area.startRow});if(names.hasByName(data.name))names.getByName(data.name).setContent(content);else {if(names.getElementNames().length>=256)throw Error('命名范围数量已达到工作台上限。');names.addNewByName(data.name,content,base,0)}return}
      if(type==='format'){const changes=[];const add=(name,value)=>changes.push([name,value]);if(data.fontName!==undefined)for(const name of ['CharFontName','CharFontNameAsian','CharFontNameComplex'])add(name,data.fontName);if(data.fontSize!==undefined)for(const name of ['CharHeight','CharHeightAsian','CharHeightComplex'])add(name,typed('float',data.fontSize));if(data.bold!==undefined)for(const name of ['CharWeight','CharWeightAsian','CharWeightComplex'])add(name,typed('float',data.bold?150:100));if(data.italic!==undefined)for(const name of ['CharPosture','CharPostureAsian','CharPostureComplex'])add(name,data.italic?css.awt.FontSlant.ITALIC:css.awt.FontSlant.NONE);if(data.textColor!==undefined)add('CharColor',typed('long',rgb(data.textColor)));if(data.backgroundColor!==undefined){add('IsCellBackgroundTransparent',data.backgroundColor===null);if(data.backgroundColor!==null)add('CellBackColor',typed('long',rgb(data.backgroundColor)))}if(data.align!==undefined)add('HoriJustify',css.table.CellHoriJustify[{default:'STANDARD',left:'LEFT',center:'CENTER',right:'RIGHT',justify:'BLOCK'}[data.align]]);if(data.verticalAlign!==undefined)add('VertJustify',css.table.CellVertJustify[{default:'STANDARD',top:'TOP',center:'CENTER',bottom:'BOTTOM'}[data.verticalAlign]]);if(data.wrap!==undefined)add('IsTextWrapped',data.wrap);for(const [name]of changes)if(!has(cells,name))throw Error(`当前选区不支持 ${name}。`);const richTargets=richFormatTargets(env,cells,area,changes);let numberFormat;
        if(data.numberFormat!==undefined){if(!has(cells,'NumberFormat'))throw Error('选区不支持数字格式。');const formats=env.model.getNumberFormats(),locale=new css.lang.Locale({Language:'en',Country:'US',Variant:''});numberFormat={formats,locale,key:formats.queryKey(data.numberFormat,locale,true)}}
        const undo=typeof env.model.getUndoManager==='function'?env.model.getUndoManager():null,grouped=!!undo&&typeof undo.enterUndoContext==='function'&&typeof undo.leaveUndoContext==='function';
        if(richTargets.length&&!grouped)throw Error('无法创建完整的格式撤销记录，本次格式未更改。');
        if(grouped)undo.enterUndoContext('单元格格式');
        try{
          if(numberFormat){const {formats,locale}=numberFormat;let key=numberFormat.key;if(key<0)key=formats.addNew(data.numberFormat,locale);add('NumberFormat',typed('long',key))}
          for(const [name,value]of changes)set(cells,name,value);
          // Calc may interpret the first built-in General write on a mixed
          // locale range as language-only. Reapply after that normalization,
          // inside the same undo context, to actually reset the number format.
          if(data.numberFormat==='General')set(cells,'NumberFormat',changes.find(([name])=>name==='NumberFormat')[1]);
          for(const {cursor,changes:attributes}of richTargets)for(const [name,value]of attributes)set(cursor,name,value);
        }finally{if(grouped)undo.leaveUndoContext()}
        return}
      if(type==='merge'){if(data.merged){const values=cells.getFormulaArray();for(let r=0;r<values.length;r++)for(let c=0;c<values[r].length;c++)if((r||c)&&values[r][c]!=='')throw Error('合并会丢弃其他单元格内容，请先移走内容再合并。')}cells.merge(data.merged);return}
      if(type==='sort'){if(data.column>area.endColumn-area.startColumn)throw Error('排序列超出选区。');if(typeof dispatch!=='function')throw Error('原生排序命令不可用。');
        // The fixed WASM lacks sequence<SortField> bindings. DataSort is the
        // real Calc command with explicit headers and absolute 1-based columns.
        // Parameters: sc/sdi/scalc.sdi and cellsh2.cxx SID_SORT, LO 24.2.
        select(env,cells);dispatch('.uno:DataSort',[prop('ByRows',true),prop('HasHeader',data.header),prop('CaseSensitive',false),prop('NaturalSort',false),prop('IncludeAttribs',true),prop('IncludeComments',true),prop('IncludeImages',true),prop('Col1',typed('long',area.startColumn+data.column+1)),prop('Ascending1',data.ascending),prop('Col2',typed('long',0)),prop('Col3',typed('long',0))]);return}
      if(type==='filter'||type==='clear-filter'){
        if(type==='filter'&&data.column>area.endColumn-area.startColumn)throw Error('筛选列超出选区。');
        const databases=read(env.model,'DatabaseRanges');if(!databases)throw Error('文档不支持持久化筛选区域。');
        const target=cells.getRangeAddress();let database=null;
        for(const name of databases.getElementNames()){const candidate=databases.getByName(name),a=candidate.getDataArea();if(['Sheet','StartColumn','StartRow','EndColumn','EndRow'].every(key=>a[key]===target[key])){database=candidate;break}}
        if(!database&&type==='filter'){if(databases.getElementNames().length>=256)throw Error('筛选区域数量已达到工作台上限。');let i=1,name;do{name='OpenOffice_Filter_'+i++}while(databases.hasByName(name));databases.addNewByName(name,target);database=databases.getByName(name)}
        const filter=database?database.getFilterDescriptor():cells.createFilterDescriptor(true);set(filter,'ContainsHeader',type==='filter'&&data.header);set(filter,'UseRegularExpressions',type==='filter'&&data.operator==='contains');if(database)set(database,'AutoFilter',type==='filter');
        if(type==='clear-filter')filter.setFilterFields([]);else {const numeric=typeof data.value==='number';let text=numeric?'':data.value;if(data.operator==='contains'){text='.*'+text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'.*';set(filter,'UseRegularExpressions',true)}const op={equal:'EQUAL','not-equal':'NOT_EQUAL',contains:'EQUAL',greater:'GREATER',less:'LESS'}[data.operator];filter.setFilterFields([new css.sheet.TableFilterField({Connection:css.sheet.FilterConnection.AND,Field:data.column,Operator:css.sheet.FilterOperator[op],IsNumeric:numeric,NumericValue:numeric?data.value:0,StringValue:text})])}cells.filter(filter);return}
      if(type==='conditional-format'||type==='clear-conditional-format'){const conditions=read(cells,'ConditionalFormat');if(!conditions)throw Error('选区不支持条件格式。');if(type==='clear-conditional-format'){conditions.clear();set(cells,'ConditionalFormat',conditions);return}const styles=env.model.getStyleFamilies().getByName('CellStyles');let serial=1,name;do{name='OpenOffice_Condition_'+serial++}while(styles.hasByName(name));const style=env.model.createInstance('com.sun.star.style.CellStyle');styles.insertByName(name,style);try{set(style,'CellBackColor',typed('long',rgb(data.backgroundColor)));set(style,'IsCellBackgroundTransparent',false);if(data.textColor)set(style,'CharColor',typed('long',rgb(data.textColor)));conditions.addNew([prop('Operator',conditionOperator(data.operator)),prop('Formula1',String(data.value)),prop('Formula2',data.secondValue===undefined?'':String(data.secondValue)),prop('StyleName',name)]);set(cells,'ConditionalFormat',conditions)}catch(error){try{styles.removeByName(name)}catch(cleanup){recover(cleanup)}throw error}return}
      if(type==='validation'){const rule=read(cells,'Validation');if(!rule)throw Error('选区不支持数据验证。');set(rule,'Type',css.sheet.ValidationType[{none:'ANY',whole:'WHOLE',decimal:'DECIMAL',list:'LIST'}[data.kind]]);set(rule,'IgnoreBlankCells',data.allowBlank!==false);set(rule,'ShowErrorMessage',data.kind!=='none');set(rule,'ErrorMessage','输入内容不符合此区域的数据验证规则。');set(rule,'ErrorAlertStyle',css.sheet.ValidationAlertStyle.STOP);if(data.kind==='list'){rule.setFormula1(data.items.map(item=>'"'+item+'"').join(';'));if(has(rule,'ShowList'))set(rule,'ShowList',typed('short',1))}else if(data.kind!=='none'){rule.setOperator(css.sheet.ConditionOperator.BETWEEN);rule.setFormula1(String(data.minimum));rule.setFormula2(String(data.maximum))}set(cells,'Validation',rule);return}
      if(type==='insert-chart'){const charts=env.sheet.getCharts();if(charts.hasByName(data.name))throw Error('图表名称已存在。');if(charts.getElementNames().length>=100)throw Error('本表图表数量已达到工作台上限。');const rect=new css.awt.Rectangle({X:1000,Y:1000,Width:16000,Height:9000});charts.addNewByName(data.name,rect,[cells.getRangeAddress()],data.headerRow,data.headerColumn);try{const chart=charts.getByName(data.name).getEmbeddedObject(),service=data.chartType==='line'?'LineDiagram':data.chartType==='pie'?'PieDiagram':'BarDiagram',diagram=chart.createInstance('com.sun.star.chart.'+service);chart.setDiagram(diagram);if(['bar','column'].includes(data.chartType))set(diagram,'Vertical',data.chartType==='bar')}catch(error){try{charts.removeByName(data.name)}catch(cleanup){recover(cleanup)}throw error}return}
      if(type==='insert-pivot'){const columns=area.endColumn-area.startColumn+1;if(data.rowField>=columns||data.dataField>=columns||area.endRow===area.startRow)throw Error('透视表需要标题行、数据行以及选区内的字段。');const headers=cells.getDataArray()[0];if(headers.some(value=>typeof value!=='string'||!value.trim())||new Set(headers).size!==headers.length)throw Error('透视表每列都需要唯一非空的文字标题。');const output=environment(data.outputSheetIndex??env.index);editable(output);const a=address(data.outputAddress,true);if(a.startColumn+1>MAX_COLUMN||a.startRow+(area.endRow-area.startRow)+3>MAX_ROW)throw Error('透视表输出范围越界。');const target=output.sheet.getCellRangeByPosition(a.startColumn,a.startRow,a.startColumn+1,a.startRow+(area.endRow-area.startRow)+3);if(target.getFormulaArray().some(row=>row.some(value=>value!=='')))throw Error('透视表输出区域必须为空。');const tables=output.sheet.getDataPilotTables();if(tables.hasByName(data.name))throw Error('透视表名称已存在。');if(tables.getElementNames().length>=100)throw Error('透视表数量已达到上限。');const descriptor=tables.createDataPilotDescriptor();descriptor.setSourceRange(cells.getRangeAddress());const fields=descriptor.getDataPilotFields();for(let i=0;i<fields.getCount();i++)set(fields.getByIndex(i),'Orientation',css.sheet.DataPilotFieldOrientation.HIDDEN);set(fields.getByIndex(data.rowField),'Orientation',css.sheet.DataPilotFieldOrientation.ROW);const value=fields.getByIndex(data.dataField);set(value,'Orientation',css.sheet.DataPilotFieldOrientation.DATA);set(value,'Function',css.sheet.GeneralFunction[{sum:'SUM',count:'COUNT',average:'AVERAGE'}[data.operation]]);tables.insertNewByName(data.name,new css.table.CellAddress({Sheet:output.index,Column:a.startColumn,Row:a.startRow}),descriptor);return}
      throw Error('此操作尚未实现。')
    }
    function data(query){object(query,['type','sheetIndex','range',...(query?.type==='summary'?['includeHidden']:[])]);if(query?.includeHidden!==undefined)bool(query.includeHidden,'包含隐藏行');one(query.type,['range','charts','pivots','rules','summary'],'数据查询');if(query.sheetIndex!==undefined)num(query.sheetIndex,0,32766,'工作表编号',true);if(['range','rules','summary'].includes(query.type))address(query.range);const env=environment(query.sheetIndex);if(query.type==='summary'){
        const {area,cells}=range(env,query.range),values=cells.getDataArray(),formulas=cells.getFormulaArray(),errors=new Set(),visible=values.map((_,index)=>{if(query.includeHidden===true)return true;const shown=read(env.sheet.getRows().getByIndex(area.startRow+index),'IsVisible');if(typeof shown!=='boolean')throw Error('无法读取行可见状态，暂不能统计。');return shown});
        // FormulaResult.ERROR = 4, as defined by the native XCellRangesQuery API.
        for(const a of cells.queryFormulaCells(4).getRangeAddresses())for(let r=Math.max(a.StartRow,area.startRow);r<=Math.min(a.EndRow,area.endRow);r++)for(let c=Math.max(a.StartColumn,area.startColumn);c<=Math.min(a.EndColumn,area.endColumn);c++)if(visible[r-area.startRow])errors.add((r-area.startRow)+','+(c-area.startColumn));
        let count=0,numericCount=0,sum=0,correction=0,minimum=null,maximum=null;
        for(let r=0;r<values.length;r++)for(let c=0;c<values[r].length;c++){
          if(!visible[r])continue;
          if(formulas[r][c]!=='')count++;
          const value=values[r][c];if(errors.has(r+','+c)||typeof value!=='number'||!Number.isFinite(value))continue;
          numericCount++;minimum=minimum===null?value:Math.min(minimum,value);maximum=maximum===null?value:Math.max(maximum,value);
          const adjusted=value-correction,next=sum+adjusted;correction=(next-sum)-adjusted;sum=next;
        }
        return {range:area.address,count,numericCount,sum:Number.isFinite(sum)?sum:null,average:numericCount&&Number.isFinite(sum)?sum/numericCount:null,minimum,maximum,errorCount:errors.size,includesHidden:query.includeHidden===true}
      }
      if(query.type==='range'){const {area,cells}=range(env,query.range);const values=cells.getDataArray(),formulas=cells.getFormulaArray(),cellTypes=values.map(row=>row.map(()=> 'empty'));
        // Query content ranges in bulk, avoiding one bridge call per cell and
        // distinguishing literal '=text' from actual formulas losslessly.
        for(const [kind,flags]of [['number',3],['text',4],['formula',16]])for(const a of cells.queryContentCells(flags).getRangeAddresses())for(let r=Math.max(a.StartRow,area.startRow);r<=Math.min(a.EndRow,area.endRow);r++)for(let c=Math.max(a.StartColumn,area.startColumn);c<=Math.min(a.EndColumn,area.endColumn);c++)cellTypes[r-area.startRow][c-area.startColumn]=kind;
        // Calc's bulk array exposes EditEngine feature placeholders (U+0001)
        // for tabs. Read those rare rich-text cells through their native text
        // cursor so tabs and fields are expanded, rather than guessing what
        // each placeholder represents or changing untouched cells.
        for(let r=0;r<values.length;r++)for(let c=0;c<values[r].length;c++)if(cellTypes[r][c]==='text'&&typeof values[r][c]==='string'&&values[r][c].includes('\u0001'))values[r][c]=richText(env.sheet.getCellByPosition(area.startColumn+c,area.startRow+r),values[r][c]);
        return {range:area.address,values,formulas,cellTypes}}if(query.type==='rules'){
        const {area,cells}=range(env,query.range),validation=read(cells,'Validation'),conditions=read(cells,'ConditionalFormat');
        const operator=value=>['EQUAL','NOT_EQUAL','GREATER','GREATER_EQUAL','LESS','LESS_EQUAL','BETWEEN','NOT_BETWEEN','FORMULA'].find(key=>enumValue(css.sheet.ConditionOperator[key])===enumValue(value))?.toLowerCase()||'unknown';
        const kind=validation?['ANY','WHOLE','DECIMAL','LIST','DATE','TIME','TEXT_LEN','CUSTOM'].find(key=>enumValue(css.sheet.ValidationType[key])===enumValue(read(validation,'Type')))?.toLowerCase()||'unknown':'none';
        if(conditions&&conditions.getCount()>256)throw Error('此区域的条件格式数量超过读取上限。');
        let filter=null;const databases=read(env.model,'DatabaseRanges'),target=cells.getRangeAddress();if(databases){for(const name of databases.getElementNames()){const item=databases.getByName(name),a=item.getDataArea();if(['Sheet','StartColumn','StartRow','EndColumn','EndRow'].every(key=>a[key]===target[key])){const descriptor=item.getFilterDescriptor();filter={enabled:!!read(item,'AutoFilter',false),header:!!read(descriptor,'ContainsHeader',false),fields:descriptor.getFilterFields().map(field=>({column:field.Field,operator:['EQUAL','NOT_EQUAL','GREATER','GREATER_EQUAL','LESS','LESS_EQUAL'].find(key=>enumValue(css.sheet.FilterOperator[key])===enumValue(field.Operator))?.toLowerCase()||'unknown',value:field.IsNumeric?field.NumericValue:field.StringValue}))};break}}}
        return {range:area.address,validation:validation?{kind:kind==='any'?'none':kind,formula1:validation.getFormula1(),formula2:validation.getFormula2(),operator:operator(validation.getOperator()),allowBlank:!!read(validation,'IgnoreBlankCells',true)}:null,conditions:conditions?Array.from({length:conditions.getCount()},(_,index)=>{const item=conditions.getByIndex(index);return {operator:operator(item.getOperator()),formula1:item.getFormula1(),formula2:item.getFormula2(),styleName:item.getStyleName()}}):[],filter}
      }const items=query.type==='charts'?env.sheet.getCharts():env.sheet.getDataPilotTables();if(items.getElementNames().length>100)throw Error('对象数量超过查询上限。');const plain=a=>({sheetIndex:a.Sheet,startColumn:a.StartColumn,startRow:a.StartRow,endColumn:a.EndColumn,endRow:a.EndRow});
      return {items:items.getElementNames().map(name=>{const item=items.getByName(name);if(query.type==='charts'){const chart=item.getEmbeddedObject(),diagram=chart.getDiagram(),service=diagram.getDiagramType();return {name,ranges:item.getRanges().map(plain),headerRow:item.getHasColumnHeaders(),headerColumn:item.getHasRowHeaders(),chartType:service.includes('Line')?'line':service.includes('Pie')?'pie':service.includes('Bar')?(read(diagram,'Vertical',false)?'bar':'column'):'other'}}const fields=item.getDataPilotFields();return {name,source:plain(item.getSourceRange()),output:plain(item.getOutputRange()),fields:Array.from({length:fields.getCount()},(_,index)=>{const field=fields.getByIndex(index),orientation=enumValue(read(field,'Orientation')),fn=enumValue(read(field,'Function'));return {name:field.getName(),index,orientation:['HIDDEN','ROW','COLUMN','PAGE','DATA'].find(key=>enumValue(css.sheet.DataPilotFieldOrientation[key])===orientation)?.toLowerCase()||'unknown',operation:['SUM','COUNT','AVERAGE'].find(key=>enumValue(css.sheet.GeneralFunction[key])===fn)?.toLowerCase()||'other'}})}})}}
    return {state,action,data,allowedTypes:new Set(Object.keys(actions)),validateAction};
  };
})(globalThis);
