<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { CalcState, CalcAction, CalcDataQuery, CalcRangeData, CalcFormat, CalcFormatField, CalcChartData, CalcPivotData, CalcSummaryData, CalcRulesData } from '../sheet/types'
import '../office/workbench.css'
const props=withDefaults(defineProps<{state?:CalcState|null;active?:boolean;busy?:boolean;disabled?:boolean;readData?:(query:CalcDataQuery)=>Promise<unknown>}>(),{active:true,busy:false,disabled:false})
const emit=defineEmits<{action:[action:CalcAction];refresh:[];'insert-image':[];'draft-change':[pending:boolean]}>()
const tabs=['开始','插入','数据','视图'] as const
const tab=ref<(typeof tabs)[number]>('开始'),panel=ref(''),problem=ref(''),address=ref(''),formula=ref(''),formulaBase=ref('')
type GridKind='empty'|'number'|'text'|'formula'
interface GridCell {address:string;kind:GridKind;value:string}
const grid=ref<GridCell[][]>(),gridBase=ref('')
const objectItems=ref<Array<{name:string;kind:'chart'|'pivot';description:string}>>([]),objectsLoading=ref(false)
const analysisOptions=reactive({name:'图表 1',chartType:'column' as 'column'|'bar'|'line'|'pie',headerRow:true,headerColumn:true,rowField:0,dataField:1,operation:'sum' as 'sum'|'count'|'average',outputAddress:'E1'})
const summaryIncludeHidden=ref(false)
const summary=ref<CalcSummaryData>(),summaryMessage=ref(''),rules=ref<CalcRulesData>(),rulesLoading=ref(false)
let summaryToken=0,rulesToken=0,summaryTimer:ReturnType<typeof setTimeout>|undefined
const selectionSize=computed(()=>{const a=props.state?.selection;return a?(a.endColumn-a.startColumn+1)*(a.endRow-a.startRow+1):0})
const formatNumber=(value:number|null)=>value===null?'—':new Intl.NumberFormat('zh-CN',{maximumSignificantDigits:12}).format(value)
const ruleLabels:Record<string,string>={none:'任意值',whole:'整数',decimal:'小数',list:'列表',date:'日期',time:'时间',text_len:'文本长度',custom:'自定义公式',equal:'等于',not_equal:'不等于',greater:'大于',greater_equal:'大于等于',less:'小于',less_equal:'小于等于',between:'介于',not_between:'不介于',formula:'公式'}
const objectRemoval=ref<{name:string;kind:'chart'|'pivot'}>()
const formulaOrigin=ref<{documentId:string;revision:number;sheetIndex:number;address:string}>()
const draft=reactive({text:'',formulas:false}),draftBase=ref(''),dataLoading=ref(false)
const dataOrigin=ref<{documentId:string;revision:number;sheetIndex:number;range:string}>()
const options=reactive({name:'',column:0,header:true,operator:'equal' as 'equal'|'not-equal'|'contains'|'greater'|'less',value:'',rowSize:7,columnSize:24,count:1,freezeRows:1,freezeColumns:0,range:'',numberFormat:'0.00',condition:'greater' as 'greater'|'less'|'equal'|'between',threshold:0,upper:100,conditionColor:'#DCF0E3',validation:'whole' as 'none'|'whole'|'decimal'|'list',minimum:0,maximum:100,items:'',allowBlank:true,nameRange:''})
const sheet=computed(()=>{const state=props.state;return state?.sheets.find(item=>item.index===state.activeSheetIndex)})
const formulaPending=computed(()=>formula.value!==formulaBase.value)
const matrixPending=computed(()=>panel.value==='matrix'&&(grid.value?JSON.stringify(grid.value)!==gridBase.value:JSON.stringify(draft)!==draftBase.value))
const pending=computed(()=>formulaPending.value||matrixPending.value)
const ready=computed(()=>props.active&&!!props.state&&!props.busy&&!props.disabled)
const locked=computed(()=>!ready.value||pending.value)
const range=computed(()=>props.state?.selection.address||'A1')
const stale=computed(()=>{
 const origin=formulaPending.value?formulaOrigin.value:dataOrigin.value,s=props.state
 return !!origin&&(!s||origin.documentId!==s.documentId||s.revision>origin.revision||origin.sheetIndex!==s.activeSheetIndex||('address'in origin?origin.address!==s.cell.address:origin.range!==s.selection.address))
})
const singleRange=computed(()=>!!props.state&&!props.state.selection.multiple&&props.state.selection.available!==false)
const formatLocked=computed(()=>locked.value||!singleRange.value||selectionSize.value>10000)
const mixed=(key:CalcFormatField)=>props.state?.mixedFormat?.includes(key)===true
const unknown=(key:CalcFormatField)=>props.state?.unavailableFormat?.includes(key)===true
const uncertain=(key:CalcFormatField)=>mixed(key)||unknown(key)
const formatLabel=(key:CalcFormatField)=>mixed(key)?'混合格式':unknown(key)?'格式未确认':''
const formatValue=(key:CalcFormatField)=>uncertain(key)?'':props.state?.format[key]
const pressed=(key:'bold'|'italic'|'wrap')=>uncertain(key)?'mixed' as const:!!props.state?.format[key]
const toggled=(key:'bold'|'italic'|'wrap')=>uncertain(key)||!props.state?.format[key]
const titles:Record<string,string>={sheets:'工作表管理',matrix:'批量录入',sort:'排序与筛选',dimensions:'行高与列宽',conditional:'条件格式',validation:'数据有效性',names:'命名区域',freeze:'冻结窗格',charts:'图表',pivots:'数据透视表'}
let token=0,disposed=false,applying:{kind:'formula'|'matrix';documentId:string;revision:number;value:string}|undefined
function syncFormula(state:CalcState|null|undefined=props.state){formula.value=formulaBase.value=state?.cell.formula||'';formulaOrigin.value=undefined;address.value=state?.selection.address||''}
function resetMatrix(){draft.text='';draft.formulas=false;draftBase.value=JSON.stringify(draft);dataOrigin.value=undefined;grid.value=undefined;gridBase.value=''}
function editFormula(event:Event){if(!ready.value||matrixPending.value||!props.state)return;if(!formulaOrigin.value)formulaOrigin.value={documentId:props.state.documentId,revision:props.state.revision,sheetIndex:props.state.activeSheetIndex,address:props.state.cell.address};formula.value=(event.target as HTMLInputElement).value;problem.value=''}
function editMatrix(){if(!props.state)return;if(!dataOrigin.value)dataOrigin.value={documentId:props.state.documentId,revision:props.state.revision,sheetIndex:props.state.activeSheetIndex,range:range.value};problem.value=''}
function send(action:CalcAction,fromDraft=false){if(!ready.value||!props.state||(!fromDraft&&pending.value))return;if(fromDraft&&stale.value){problem.value='选区或文档已变化，请还原输入再重试。';return}problem.value='';emit('action',{...action,expectedRevision:fromDraft?(formulaPending.value?formulaOrigin.value?.revision:dataOrigin.value?.revision)??props.state.revision:props.state.revision})}
function scoped<T extends object>(value:T){return{...value,sheetIndex:props.state?.activeSheetIndex,range:range.value}}
function format(value:Partial<CalcFormat>){if(formatLocked.value)return;send(scoped({type:'format' as const,...value}))}
function selectFormat(key:'fontName'|'fontSize'|'align'|'numberFormat',event:Event){const value=(event.target as HTMLSelectElement).value;if(!value)return;if(key==='fontSize'){const size=Number(value);if(!Number.isFinite(size)||size<=0)return;format({fontSize:size})}else format({[key]:value})}
function applyFormula(){if(!formulaPending.value||!props.state||!formulaOrigin.value||stale.value)return;applying={kind:'formula',documentId:props.state.documentId,revision:props.state.revision,value:formula.value};send({type:'set-cell',sheetIndex:formulaOrigin.value.sheetIndex,address:formulaOrigin.value.address,input:formula.value},true)}
function formulaKey(event:KeyboardEvent){if(event.shiftKey)return;if(event.altKey){event.preventDefault();const field=event.target as HTMLTextAreaElement;field.setRangeText('\n',field.selectionStart,field.selectionEnd,'end');editFormula(event);return}event.preventDefault();applyFormula()}
function gotoRange(){const value=address.value.trim();if(!value||locked.value)return;send({type:'select-range',range:value,sheetIndex:props.state?.activeSheetIndex})}
function openPanel(name:string){if(pending.value){problem.value='请先应用或还原当前输入，再切换面板。';return}panel.value=panel.value===name?'':name;problem.value='';token++;dataLoading.value=false;objectsLoading.value=false;options.name=sheet.value?.name||'';options.range=range.value;options.freezeColumns=props.state?.frozen.columns||0;options.freezeRows=props.state?.frozen.rows||0;objectItems.value=[];objectRemoval.value=undefined;analysisOptions.name=name==='pivots'?'汇总表 1':'图表 1';resetMatrix()}
function discardDrafts(){applying=undefined;problem.value='';syncFormula();resetMatrix()}
function actionSucceeded(state:CalcState){
 const request=applying
 if(!request||state.documentId!==request.documentId)return
 applying=undefined
 if(request.kind==='formula')syncFormula(state)
 else{draftBase.value=JSON.stringify(draft);if(grid.value){gridBase.value=JSON.stringify(grid.value);dataOrigin.value={documentId:state.documentId,revision:state.revision,sheetIndex:state.activeSheetIndex,range:state.selection.address}}else dataOrigin.value=undefined}
}
function actionFailed(){applying=undefined}

function assertNoPendingEdits(){if(pending.value)throw Error('表格工作台有尚未应用的公式或数据，请先点击“应用”或“还原”。')}
function sheetName(){const name=options.name.trim();if(!name||name.length>31||/[\\/:?*\[\]]/.test(name)){problem.value='工作表名称需要 1–31 个字符，不能包含 \\ / : ? * [ ]。';return null}return name}
function changeSheet(type:'rename-sheet'|'duplicate-sheet'){const name=sheetName();if(!name||!props.state)return;send({type,sheetIndex:props.state.activeSheetIndex,name})}
function addSheet(){send({type:'add-sheet'})}
const confirming=ref<'delete-sheet'|'merge'|'delete-rows'|'delete-columns'|'fill-down'|'fill-right'|null>(null)
function confirmAction(){const s=props.state,action=confirming.value;if(!s||!action)return;confirming.value=null;if(action==='delete-sheet')send({type:action,sheetIndex:s.activeSheetIndex});else if(action==='merge')send(scoped({type:'merge',merged:true}));else if(action==='fill-down'||action==='fill-right')send(scoped({type:'fill',direction:action==='fill-down'?'down':'right'}));else structure(action)}
function structure(type:'insert-rows'|'delete-rows'|'insert-columns'|'delete-columns'){const s=props.state;if(!s)return;const count=Math.round(options.count);if(count<1||count>1000){problem.value='一次调整 1–1000 行或列。';return}send({type,sheetIndex:s.activeSheetIndex,index:type.endsWith('rows')?s.selection.startRow:s.selection.startColumn,count})}
function applySize(rows:boolean){const s=props.state;if(!s)return;const sizeMm=rows?options.rowSize:options.columnSize;if(!Number.isFinite(sizeMm)||sizeMm<=0||sizeMm>500){problem.value='尺寸需要大于 0 且不超过 500 毫米。';return}send({type:rows?'set-row-height':'set-column-width',sheetIndex:s.activeSheetIndex,index:rows?s.selection.startRow:s.selection.startColumn,count:rows?s.selection.endRow-s.selection.startRow+1:s.selection.endColumn-s.selection.startColumn+1,sizeMm})}
function columnName(index:number){let result='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result}
function editGrid(row:number,column:number,value:string,kind?:GridKind){if(!ready.value||!grid.value)return;editMatrix();const cell=grid.value[row][column];if(kind){cell.kind=kind;if(kind==='empty')cell.value=''}else{cell.value=value;if(!value)cell.kind='empty';else if(cell.kind==='empty')cell.kind='text'}}
async function loadMatrix(){
 if(!props.readData||!props.state||locked.value)return
 const documentId=props.state.documentId,revision=props.state.revision,sheetIndex=props.state.activeSheetIndex,selected=range.value,request=++token,startRow=props.state.selection.startRow,startColumn=props.state.selection.startColumn
 dataLoading.value=true;problem.value=''
 try{
  const data=await props.readData({type:'range',sheetIndex,range:selected}) as CalcRangeData
  if(disposed||request!==token)return
  if(!data||data.documentId!==documentId||!Number.isSafeInteger(data.revision)||data.revision<revision)throw Error('返回的文档版本无效，已保留原内容。')
  if(props.state?.documentId!==documentId||props.state.revision>data.revision||range.value!==selected||props.state.activeSheetIndex!==sheetIndex)throw Error('选区已变化，请重新读取。')
  if(data.range!==selected||!Array.isArray(data.values)||!Array.isArray(data.formulas)||!Array.isArray(data.cellTypes))throw Error('未能读取单元格类型，已保留原内容。')
  if(data.values.reduce((sum,row)=>sum+row.length,0)>400)throw Error('侧边编辑器一次最多编辑 400 个单元格，请缩小选区；也可直接在画布编辑。')
  const cells=data.values.map((row,r)=>row.map((value,c)=>{
   const kind=data.cellTypes[r]?.[c]
   if(!['empty','number','text','formula'].includes(kind)||typeof data.formulas[r]?.[c]!=='string')throw Error('单元格读取不完整，请重新读取。')
   return{address:columnName(startColumn+c)+(startRow+r+1),kind,value:kind==='formula'?data.formulas[r][c]:kind==='empty'?'':String(value)} as GridCell
  }))
  grid.value=cells;gridBase.value=JSON.stringify(cells);dataOrigin.value={documentId,revision:data.revision,sheetIndex,range:selected}
 }catch(error){if(request===token)problem.value=error instanceof Error?error.message:String(error)}finally{if(request===token)dataLoading.value=false}
}
function applyMatrix(){
 if(!matrixPending.value||!props.state||stale.value)return
 if(grid.value){
  const before=JSON.parse(gridBase.value) as GridCell[][],cells=[]
  for(let r=0;r<grid.value.length;r++)for(let c=0;c<grid.value[r].length;c++){
   const cell=grid.value[r][c]
   if(JSON.stringify(cell)===JSON.stringify(before[r][c]))continue
   if(cell.kind==='number'&&(!cell.value.trim()||!Number.isFinite(Number(cell.value)))){problem.value=`${cell.address} 需要有效数值。`;return}
   if(cell.kind==='formula'&&!cell.value.startsWith('=')){problem.value=`${cell.address} 的公式需要以 = 开头。`;return}
   cells.push({address:cell.address,kind:cell.kind,value:cell.kind==='number'?Number(cell.value):cell.kind==='empty'?'':cell.value})
  }
  if(!cells.length)return
  applying={kind:'matrix',documentId:props.state.documentId,revision:props.state.revision,value:JSON.stringify(grid.value)}
  send({type:'patch-cells',sheetIndex:props.state.activeSheetIndex,cells},true);return
 }
 const lines=draft.text.replace(/\r\n?/g,'\n').split('\n'),cells=lines.map(line=>line.split('\t'))
 if(cells.length>1000||cells.some(row=>row.length>100)||cells.reduce((sum,row)=>sum+row.length,0)>10000){problem.value='一次最多录入 1000 行、100 列，共 1 万个单元格。';return}
 const width=Math.max(...cells.map(row=>row.length));for(const row of cells)while(row.length<width)row.push('')
 const values=cells.map(row=>row.map(value=>!draft.formulas&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)&&Number.isFinite(Number(value))?Number(value):value))
 applying={kind:'matrix',documentId:props.state.documentId,revision:props.state.revision,value:JSON.stringify(draft)}
 send({type:'set-matrix',sheetIndex:props.state.activeSheetIndex,range:props.state.cell.address,cells:values,formulas:draft.formulas},true)
}
async function loadObjects(){
 if(!props.readData||!props.state||locked.value||!['charts','pivots'].includes(panel.value))return
 const kind=panel.value as 'charts'|'pivots',documentId=props.state.documentId,sheetIndex=props.state.activeSheetIndex,request=++token
 objectsLoading.value=true;problem.value=''
 try{const data=await props.readData({type:kind,sheetIndex}) as CalcChartData|CalcPivotData
  if(disposed||request!==token)return
  if(props.state?.documentId!==documentId||props.state.activeSheetIndex!==sheetIndex||panel.value!==kind)throw Error('工作表已切换，请重新读取列表。')
  if(!data||!Array.isArray(data.items))throw Error('未能读取对象列表。')
  objectItems.value=data.items.map(item=>({name:item.name,kind:kind==='charts'?'chart':'pivot',description:'chartType'in item?({column:'柱形图',bar:'条形图',line:'折线图',pie:'饼图',other:'其他图表'}[item.chartType]):`输出于 ${columnName(item.output.startColumn)}${item.output.startRow+1}`}))
 }catch(error){if(request===token)problem.value=error instanceof Error?error.message:String(error)}finally{if(request===token)objectsLoading.value=false}
}
function insertAnalysis(pivot:boolean){
 const name=analysisOptions.name.trim()
 if(!name||name.length>80){problem.value='请输入 1–80 个字符的名称。';return}
 if(pivot){if(analysisOptions.rowField===analysisOptions.dataField){problem.value='分类列与汇总列需要不同。';return}send(scoped({type:'insert-pivot',name,rowField:Number(analysisOptions.rowField),dataField:Number(analysisOptions.dataField),operation:analysisOptions.operation,outputAddress:analysisOptions.outputAddress.trim()}))}
 else send(scoped({type:'insert-chart',name,chartType:analysisOptions.chartType,headerRow:analysisOptions.headerRow,headerColumn:analysisOptions.headerColumn}))
}
function removeObject(){const item=objectRemoval.value;if(!item)return;send({type:item.kind==='chart'?'delete-chart':'delete-pivot',sheetIndex:props.state?.activeSheetIndex,name:item.name});objectRemoval.value=undefined;objectItems.value=[]}
function sort(ascending:boolean){send(scoped({type:'sort',column:Number(options.column),ascending,header:options.header}))}
function filter(){const value=['greater','less'].includes(options.operator)?Number(options.value):options.value;if(typeof value==='number'&&!Number.isFinite(value)){problem.value='比较条件需要有效数值。';return}send(scoped({type:'filter',column:Number(options.column),operator:options.operator,value,header:options.header}))}
function condition(){send(scoped({type:'conditional-format',operator:options.condition,value:Number(options.threshold),...(options.condition==='between'?{secondValue:Number(options.upper)}:{}),backgroundColor:options.conditionColor}))}
function validation(){send(scoped({type:'validation',kind:options.validation,...(options.validation==='list'?{items:options.items.split('\n').map(v=>v.trim()).filter(Boolean)}:options.validation==='none'?{}:{minimum:Number(options.minimum),maximum:Number(options.maximum)}),allowBlank:options.allowBlank}))}
async function loadRules(){
 const state=props.state;if(!props.readData||!state||locked.value||!singleRange.value||selectionSize.value!==1)return
 const identity={documentId:state.documentId,revision:state.revision,sheetIndex:state.activeSheetIndex,range:range.value},request=++rulesToken
 rulesLoading.value=true;rules.value=undefined;problem.value=''
 try{const result=await props.readData({type:'rules',sheetIndex:identity.sheetIndex,range:identity.range}) as CalcRulesData
  if(disposed||request!==rulesToken)return
  if(props.state?.documentId!==identity.documentId||props.state?.revision!==identity.revision||props.state?.activeSheetIndex!==identity.sheetIndex||range.value!==identity.range||result.documentId!==identity.documentId||result.revision!==identity.revision||result.range!==identity.range)throw Error('选区或文档已变化，请重新读取规则。')
  rules.value=result
 }catch(error){if(request===rulesToken)problem.value=error instanceof Error?error.message:String(error)}finally{if(request===rulesToken)rulesLoading.value=false}
}
async function loadSummary(request:number){
 const state=props.state;if(!props.readData||!state||!ready.value||pending.value||!singleRange.value||selectionSize.value<2||selectionSize.value>10000)return
 const identity={documentId:state.documentId,revision:state.revision,sheetIndex:state.activeSheetIndex,range:range.value}
 try{const result=await props.readData({type:'summary',sheetIndex:identity.sheetIndex,range:identity.range,includeHidden:summaryIncludeHidden.value}) as CalcSummaryData
  if(disposed||request!==summaryToken)return
  if(props.state?.documentId!==identity.documentId||props.state?.revision!==identity.revision||props.state?.activeSheetIndex!==identity.sheetIndex||range.value!==identity.range||result.documentId!==identity.documentId||result.revision!==identity.revision||result.range!==identity.range)return
  summary.value=result
 }catch{if(request===summaryToken)summaryMessage.value='选区统计暂不可用'}
}
watch(()=>JSON.stringify([props.active,props.busy,props.disabled,pending.value,summaryIncludeHidden.value,props.state?.documentId,props.state?.revision,props.state?.activeSheetIndex,range.value,props.state?.selection.multiple]),()=>{
 const request=++summaryToken;clearTimeout(summaryTimer);summary.value=undefined;summaryMessage.value=''
 if(!ready.value||pending.value)return
 if(!singleRange.value){summaryMessage.value='请选连续区域查看统计';return}
 if(selectionSize.value>10000){summaryMessage.value='统计最多 10,000 格';return}
 if(selectionSize.value>1)summaryTimer=setTimeout(()=>void loadSummary(request),180)
},{immediate:true})
function tabKey(event:KeyboardEvent,index:number){if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tab.value=tabs[next];(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()}
watch(()=>props.state,(state,previous)=>{
 if(previous?.documentId&&state?.documentId!==previous.documentId){applying=undefined;token++;panel.value='';objectsLoading.value=false;dataLoading.value=false;objectItems.value=[];objectRemoval.value=undefined;resetMatrix();syncFormula();return}
 if(previous?.activeSheetIndex!==state?.activeSheetIndex){objectItems.value=[];objectRemoval.value=undefined}
 if(!formulaPending.value)syncFormula()
 if(!matrixPending.value&&dataOrigin.value&&((state?.revision??0)>dataOrigin.value.revision||range.value!==dataOrigin.value.range)){resetMatrix()}
},{deep:true,immediate:true})
watch(()=>JSON.stringify([props.active,props.state?.documentId,props.state?.revision,props.state?.activeSheetIndex,props.state?.selection.address,props.state?.selection.multiple]),()=>{confirming.value=null;objectRemoval.value=undefined;rules.value=undefined;rulesToken++;rulesLoading.value=false})
watch(pending,value=>emit('draft-change',value),{immediate:true})
watch(()=>props.active,active=>{if(!active&&!pending.value){panel.value='';token++;resetMatrix()}})
onBeforeUnmount(()=>{disposed=true;token++;summaryToken++;rulesToken++;clearTimeout(summaryTimer)})
defineExpose({hasPendingEdits:()=>pending.value,assertNoPendingEdits,discardDrafts,actionSucceeded,actionFailed})
</script>
<template>
<section class="ow-workbench ow-sheet" :aria-label="active?'电子表格工作台':undefined">
 <header v-if="active" class="ow-ribbon"><div class="ow-ribbon-top"><span class="ow-mark" aria-hidden="true">X</span><div class="ow-tabs" role="tablist" aria-label="表格工具"><button v-for="(item,index) in tabs" :key="item" role="tab" :aria-selected="tab===item" :tabindex="tab===item?0:-1" @click="tab=item" @keydown="tabKey($event,index)">{{item}}</button></div><span class="ow-spacer"/><span class="ow-ribbon-meta">电子表格 · 公式实时计算</span><button class="ow-command" :disabled="!ready" @click="openPanel('sheets')"><Icon name="sheet" :size="15"/>工作表</button><button class="ow-command" :disabled="locked" aria-label="刷新表格状态" @click="emit('refresh')">↻</button></div>
 <div class="ow-toolbar" role="tabpanel" :aria-label="`${tab}工具`">
  <template v-if="tab==='开始'">
   <select aria-label="单元格字体" :value="formatValue('fontName')" :disabled="formatLocked" @change="selectFormat('fontName',$event)"><option v-if="uncertain('fontName')" value="" disabled>{{formatLabel('fontName')}}</option><option v-if="state?.format.fontName&&!uncertain('fontName')" :value="state.format.fontName">{{state.format.fontName}}</option><option>Noto Sans CJK SC</option><option>Carlito</option><option>Liberation Mono</option></select>
   <select aria-label="单元格字号" :value="formatValue('fontSize')" :disabled="formatLocked" @change="selectFormat('fontSize',$event)"><option v-if="uncertain('fontSize')" value="" disabled>{{formatLabel('fontSize')}}</option><option v-if="state&&!uncertain('fontSize')&&![9,10,11,12,14,16,18,20,24,28,32,36,48].includes(state.format.fontSize)" :value="state.format.fontSize">{{state.format.fontSize}}</option><option v-for="size in [9,10,11,12,14,16,18,20,24,28,32,36,48]" :key="size">{{size}}</option></select>
   <button class="ow-command ow-square" aria-label="单元格加粗" :title="formatLabel('bold')" :aria-pressed="pressed('bold')" :disabled="formatLocked" @click="format({bold:toggled('bold')})"><b>B</b></button><button class="ow-command ow-square" aria-label="单元格斜体" :title="formatLabel('italic')" :aria-pressed="pressed('italic')" :disabled="formatLocked" @click="format({italic:toggled('italic')})"><i>I</i></button>
   <label class="sheet-color-control" :class="{'is-uncertain':uncertain('textColor')}" :title="uncertain('textColor')?formatLabel('textColor')+'；选择颜色将统一选区文字颜色':'文字颜色'"><input aria-label="单元格文字颜色" type="color" :value="state?.format.textColor||'#000000'" :disabled="formatLocked" @change="format({textColor:($event.target as HTMLInputElement).value})"/><span v-if="uncertain('textColor')" aria-hidden="true">{{mixed('textColor')?'混合':'未确认'}}</span></label>
   <button v-if="uncertain('textColor')" class="ow-command sheet-color-apply" aria-label="统一使用当前文字颜色" :style="{borderBottomColor:state?.format.textColor||'#000000'}" :title="'将文字统一为 '+(state?.format.textColor||'#000000')" :disabled="formatLocked" @click="format({textColor:state?.format.textColor||'#000000'})">用此色</button>
   <label class="sheet-color-control" :class="{'is-uncertain':uncertain('backgroundColor'),'is-empty':!uncertain('backgroundColor')&&!state?.format.backgroundColor}" :title="uncertain('backgroundColor')?formatLabel('backgroundColor')+'；选择颜色将统一选区填充':'填充颜色'"><input aria-label="单元格填充颜色" type="color" :value="state?.format.backgroundColor||'#FFFFFF'" :disabled="formatLocked" @change="format({backgroundColor:($event.target as HTMLInputElement).value})"/><span v-if="uncertain('backgroundColor')" aria-hidden="true">{{mixed('backgroundColor')?'混合':'未确认'}}</span><span v-else-if="!state?.format.backgroundColor" aria-hidden="true">无</span></label>
   <button v-if="uncertain('backgroundColor')||!state?.format.backgroundColor" class="ow-command sheet-color-apply" aria-label="统一使用当前填充颜色" :style="{borderBottomColor:state?.format.backgroundColor||'#FFFFFF'}" :title="'将填充统一为 '+(state?.format.backgroundColor||'#FFFFFF')" :disabled="formatLocked" @click="format({backgroundColor:state?.format.backgroundColor||'#FFFFFF'})">用此色</button>
   <button class="ow-command" :disabled="formatLocked" @click="format({backgroundColor:null})">无填充</button><span class="ow-divider"/>
   <select aria-label="单元格对齐" :value="formatValue('align')" :disabled="formatLocked" @change="selectFormat('align',$event)"><option v-if="uncertain('align')" value="" disabled>{{formatLabel('align')}}</option><option value="default">默认对齐</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select>
   <button class="ow-command" :aria-pressed="pressed('wrap')" :title="formatLabel('wrap')" :disabled="formatLocked" @click="format({wrap:toggled('wrap')})">自动换行</button><button class="ow-command" :disabled="formatLocked" @click="state?.format.merged?send(scoped({type:'merge',merged:false})):confirming='merge'">{{state?.format.merged?'取消合并':'合并单元格'}}</button>
   <select aria-label="数字格式" :value="formatValue('numberFormat')" :disabled="formatLocked" @change="selectFormat('numberFormat',$event)"><option v-if="uncertain('numberFormat')" value="" disabled>{{formatLabel('numberFormat')}}</option><option v-if="state?.format.numberFormat&&!uncertain('numberFormat')&&!['General','0','0.00','#,##0.00','0.00%','YYYY-MM-DD','¥#,##0.00'].includes(state.format.numberFormat)" :value="state.format.numberFormat">当前格式</option><option value="General">常规</option><option value="0">整数</option><option value="0.00">两位小数</option><option value="#,##0.00">千分位</option><option value="0.00%">百分比</option><option value="YYYY-MM-DD">日期</option><option value="¥#,##0.00">人民币</option></select>
  </template>
  <template v-else-if="tab==='插入'"><button class="ow-command" :disabled="!ready" @click="openPanel('matrix')"><Icon name="sheet" :size="16"/>批量录入</button><button class="ow-command" :disabled="locked" @click="emit('insert-image')"><Icon name="image" :size="16"/>图片</button><button class="ow-command" :disabled="!ready" @click="openPanel('charts')">图表</button><button class="ow-command" :disabled="!ready" @click="openPanel('pivots')">数据透视表</button><span class="ow-divider"/><button class="ow-command" :disabled="locked" @click="structure('insert-rows')">插入行</button><button class="ow-command" :disabled="locked" @click="structure('insert-columns')">插入列</button><button class="ow-command" :disabled="!ready" @click="openPanel('dimensions')">行列设置</button><span class="ow-divider"/><button class="ow-command" :disabled="locked" @click="addSheet"><Icon name="plus" :size="16"/>工作表</button></template>
  <template v-else-if="tab==='数据'"><button class="ow-command" :disabled="locked||!singleRange||(state?.selection.endRow||0)===(state?.selection.startRow||0)" @click="confirming='fill-down'">向下填充</button><button class="ow-command" :disabled="locked||!singleRange||(state?.selection.endColumn||0)===(state?.selection.startColumn||0)" @click="confirming='fill-right'">向右填充</button><span class="ow-divider"/><button class="ow-command" :disabled="locked||!singleRange" @click="sort(true)">A → Z 升序</button><button class="ow-command" :disabled="locked||!singleRange" @click="sort(false)">Z → A 降序</button><button class="ow-command" :disabled="!ready" @click="openPanel('sort')">排序与筛选</button><span class="ow-divider"/><button class="ow-command" :disabled="!ready" @click="openPanel('conditional')">条件格式</button><button class="ow-command" :disabled="!ready" @click="openPanel('validation')">数据有效性</button><button class="ow-command" :disabled="!ready" @click="openPanel('names')">命名区域</button></template>
  <template v-else><button class="ow-command" :disabled="locked" @click="send({type:'freeze',rows:1,columns:0})">冻结首行</button><button class="ow-command" :disabled="locked" @click="send({type:'freeze',rows:0,columns:1})">冻结首列</button><button class="ow-command" :disabled="!ready" @click="openPanel('freeze')">冻结设置</button><button class="ow-command" :disabled="locked" @click="send({type:'freeze',rows:0,columns:0})">取消冻结</button><span class="ow-divider"/><button class="ow-command" :disabled="!ready" @click="openPanel('sheets')">工作表管理</button></template>
 </div></header>
 <div v-if="active" class="ow-cellbar"><input class="ow-address" v-model="address" aria-label="单元格地址" :disabled="locked" @keydown.enter="gotoRange" @keydown.esc="address=range" title="输入 A1 或 A1:B10，按 Enter 定位"/><span class="ow-formula-symbol" aria-hidden="true">ƒx</span><textarea class="ow-formula" rows="1" :value="formula" :disabled="!ready||matrixPending" aria-label="单元格内容或公式" placeholder="输入文字、数值，或以 = 开头的公式" @input="editFormula" @keydown.enter="formulaKey" @keydown.esc.prevent="discardDrafts" title="Enter 应用；Shift+Enter 换行"/><button class="ow-command ow-square" aria-label="应用公式" :disabled="!ready||!formulaPending||stale" @click="applyFormula"><Icon name="check" :size="17"/></button><button class="ow-command ow-square" aria-label="还原公式" :disabled="busy||!formulaPending" @click="discardDrafts"><Icon name="close" :size="15"/></button></div>
 <p v-if="active&&tab==='开始'&&(state?.mixedFormat?.length||state?.unavailableFormat?.length||!singleRange)" class="sheet-format-note" role="status" data-testid="sheet-format-status">{{!singleRange?'请选择一个连续单元格区域后设置格式。':selectionSize>10000?'选区较大，请缩小到 1 万格以内再查看或设置格式。':state?.richTextFormat?'选区含局部文字格式，未确认项不代表当前文字样式；选择新值仅修改该属性。':state?.unavailableFormat?.length?'部分格式暂无法确认；选择新值仅修改该属性。':'选区包含不同格式；选择新值仅统一该属性。'}}</p>
 <div v-if="active&&pending" class="ow-notice" data-testid="sheet-draft-notice">{{stale?'选区或文档已改变，请还原输入后重试。':formulaPending?'公式栏有未应用的输入，按 Enter 或点击 ✓ 应用。':'批量数据尚未应用。请先应用或还原后再保存或切换文档。'}}<button :disabled="busy" @click="discardDrafts">还原</button></div>
 <div v-if="active&&problem" class="ow-notice ow-error" role="alert">{{problem}}</div>
 <div v-if="active&&confirming" class="ow-notice" role="alert"><span>{{confirming==='fill-down'?'用选区首行填充下方单元格，覆盖目标内容和格式；公式引用自动调整。':confirming==='fill-right'?'用选区首列填充右方单元格，覆盖目标内容和格式；公式引用自动调整。':confirming==='merge'?'仅左上角有内容时才能合并；其他单元格有内容会保留原状并提示。':confirming==='delete-sheet'?`删除“${sheet?.name}”工作表及其中所有内容？`:'删除所选行或列会同时移除其中的内容。'}}</span><button :disabled="locked" @click="confirmAction">确认{{confirming?.startsWith('fill-')?'填充':confirming==='merge'?'合并':'删除'}}</button><button @click="confirming=null">取消</button></div>
 <div class="ow-body"><div class="ow-canvas"><slot/></div>
  <aside v-if="active&&panel" class="ow-panel" :aria-label="titles[panel]"><div class="ow-panel-heading"><h3>{{titles[panel]}}</h3><button class="ow-command ow-square" aria-label="关闭表格面板" :disabled="pending" @click="panel=''">×</button></div>
   <p v-if="!['sheets','freeze'].includes(panel)">当前选区：{{sheet?.name}} · {{range}}</p>
   <section v-if="panel==='validation'||panel==='conditional'" aria-label="已有规则" data-testid="sheet-existing-rules">
    <h4 class="ow-subheading">已有规则 · 只读查看</h4>
    <p v-if="!singleRange||selectionSize!==1">选中单个单元格后可读取已有规则，多个单元格可能使用不同规则。</p>
    <button class="ow-command" :disabled="locked||rulesLoading||!readData||!singleRange||selectionSize!==1" @click="loadRules">{{rulesLoading?'读取中…':'读取已有规则'}}</button>
    <template v-if="rules"><p>{{rules.range}}：{{ruleLabels[rules.validation?.kind||'none']||rules.validation?.kind}}</p><p v-if="rules.validation&&rules.validation.kind!=='none'">{{ruleLabels[rules.validation.operator]||rules.validation.operator}} {{rules.validation.formula1}}<template v-if="['between','not_between'].includes(rules.validation.operator)&&rules.validation.formula2"> ～ {{rules.validation.formula2}}</template> · {{rules.validation.allowBlank?'允许空白':'不允许空白'}}</p><ul class="ow-panel-list"><li v-for="(item,index) in rules.conditions" :key="index">条件 {{index+1}}：{{ruleLabels[item.operator]||item.operator}} {{item.formula1}}<template v-if="['between','not_between'].includes(item.operator)&&item.formula2"> ～ {{item.formula2}}</template></li></ul><p v-if="!rules.conditions.length">无条件格式。</p></template>
    <hr/>
   </section>
   <template v-if="panel==='sheets'"><label class="ow-field">工作表名称<input v-model="options.name" :disabled="locked" maxlength="31"/></label><div class="ow-actions"><button :disabled="locked" @click="changeSheet('rename-sheet')">重命名</button><button :disabled="locked" @click="changeSheet('duplicate-sheet')">复制为此名称</button><button :disabled="locked" @click="addSheet">新建</button></div><div class="ow-actions"><button :disabled="locked||state?.activeSheetIndex===0" @click="send({type:'move-sheet',sheetIndex:state!.activeSheetIndex,targetIndex:state!.activeSheetIndex-1})">左移</button><button :disabled="locked||state?.activeSheetIndex===(state?.sheetCount||state?.sheets.length||0)-1" @click="send({type:'move-sheet',sheetIndex:state!.activeSheetIndex,targetIndex:state!.activeSheetIndex+1})">右移</button><button :disabled="locked||(state?.sheets.filter(s=>s.visible).length||0)<=1" @click="send({type:'set-sheet-hidden',sheetIndex:state!.activeSheetIndex,hidden:true})">隐藏</button><button class="ow-danger" :disabled="locked||(state?.sheets.length||0)<=1" @click="confirming='delete-sheet'">删除</button></div><p v-if="state?.sheetsTruncated">工作表较多，此处显示部分列表。可在画布底部标签访问其余工作表。</p><h4 class="ow-subheading">隐藏的工作表</h4><ul class="ow-panel-list"><li v-for="item in state?.sheets.filter(s=>!s.visible)||[]" :key="item.index"><button :disabled="locked" @click="send({type:'set-sheet-hidden',sheetIndex:item.index,hidden:false})">显示 {{item.name}}</button></li></ul><p v-if="!state?.sheets.some(s=>!s.visible)">没有隐藏的工作表。</p></template>
   <template v-else-if="panel==='matrix'"><p>从当前单元格开始写入。每行一条记录，列之间用制表符分隔，可直接粘贴表格数据；普通数字自动识别，带前导零的编号保留为文字。</p><button class="ow-command" :disabled="locked||dataLoading||!readData" @click="loadMatrix">{{dataLoading?'读取中…':'读取当前选区'}}</button><template v-if="grid"><p>逐格保留原始类型。仅写入修改过的单元格，其余公式与样式保持原样。侧栏一次最多读取 400 格。</p><div class="ow-table-grid ow-typed-grid"><table><tbody><tr v-for="(row,r) in grid" :key="r"><td v-for="(cell,c) in row" :key="cell.address"><label :for="`calc-grid-${cell.address}`">{{cell.address}}</label><textarea :id="`calc-grid-${cell.address}`" :aria-label="`单元格 ${cell.address} 内容`" :value="cell.value" :disabled="!ready||formulaPending||dataLoading" rows="2" @input="editGrid(r,c,($event.target as HTMLTextAreaElement).value)"/><select :aria-label="`单元格 ${cell.address} 类型`" :value="cell.kind" :disabled="!ready||formulaPending||dataLoading" @change="editGrid(r,c,cell.value,($event.target as HTMLSelectElement).value as GridKind)"><option value="empty">空白</option><option value="text">文本</option><option value="number">数值</option><option value="formula">公式</option></select></td></tr></tbody></table></div><button class="ow-command" :disabled="locked" @click="resetMatrix">改为新数据录入</button></template><template v-else><label class="ow-field">批量数据<textarea :value="draft.text" rows="12" :disabled="!ready||formulaPending||dataLoading" @input="draft.text=($event.target as HTMLTextAreaElement).value;editMatrix()"/></label><label class="ow-check"><input v-model="draft.formulas" type="checkbox" :disabled="!ready||formulaPending" @change="editMatrix"/>将以 = 开头的内容作为公式</label></template><div class="ow-actions"><button class="ow-primary" :disabled="!ready||!matrixPending||stale" @click="applyMatrix">应用数据</button><button :disabled="busy||!matrixPending" @click="discardDrafts">还原</button></div></template>
   <template v-else-if="panel==='charts'||panel==='pivots'">
    <p>{{panel==='charts'?'以当前选区创建原生可编辑图表，数据变化时图表同步更新。双击画布图表可继续编辑样式与数据源。':'以当前选区作为源数据，每列需要唯一文字标题。输出区域必须为空，避免覆盖已有数据。'}}</p>
    <label class="ow-field">{{panel==='charts'?'图表名称':'透视表名称'}}<input v-model="analysisOptions.name" :disabled="locked" maxlength="80"/></label>
    <template v-if="panel==='charts'"><label class="ow-field">图表类型<select aria-label="图表类型" v-model="analysisOptions.chartType" :disabled="locked"><option value="column">柱形图</option><option value="bar">条形图</option><option value="line">折线图</option><option value="pie">饼图</option></select></label><label class="ow-check"><input v-model="analysisOptions.headerRow" type="checkbox" :disabled="locked"/>首行为系列标题</label><label class="ow-check"><input v-model="analysisOptions.headerColumn" type="checkbox" :disabled="locked"/>首列为分类名称</label></template>
    <template v-else><label class="ow-field">分类列<select aria-label="分类列" v-model.number="analysisOptions.rowField" :disabled="locked"><option v-for="column in Math.max(1,(state?.selection.endColumn||0)-(state?.selection.startColumn||0)+1)" :key="column" :value="column-1">选区第 {{column}} 列</option></select></label><label class="ow-field">汇总列<select aria-label="汇总列" v-model.number="analysisOptions.dataField" :disabled="locked"><option v-for="column in Math.max(1,(state?.selection.endColumn||0)-(state?.selection.startColumn||0)+1)" :key="column" :value="column-1">选区第 {{column}} 列</option></select></label><label class="ow-field">汇总方式<select aria-label="汇总方式" v-model="analysisOptions.operation" :disabled="locked"><option value="sum">求和</option><option value="count">计数</option><option value="average">平均值</option></select></label><label class="ow-field">输出位置<input v-model="analysisOptions.outputAddress" :disabled="locked" placeholder="当前工作表，例如 E1"/></label></template>
    <div class="ow-actions"><button class="ow-primary" :disabled="locked||!singleRange" @click="insertAnalysis(panel==='pivots')">{{panel==='charts'?'插入图表':'生成透视表'}}</button></div>
    <h4 class="ow-subheading">当前工作表中的{{panel==='charts'?'图表':'透视表'}}</h4><button class="ow-command" :disabled="locked||objectsLoading||!readData" @click="loadObjects">{{objectsLoading?'读取中…':'读取对象列表'}}</button>
    <ul class="ow-panel-list"><li v-for="item in objectItems" :key="item.name"><strong>{{item.name}}</strong><p>{{item.description}}</p><div class="ow-actions"><button v-if="item.kind==='pivot'" :disabled="locked" @click="send({type:'refresh-pivot',sheetIndex:state?.activeSheetIndex,name:item.name})">刷新汇总</button><button class="ow-danger" :disabled="locked" @click="objectRemoval=item">删除{{item.kind==='chart'?'图表':'透视表'}}</button></div></li></ul>
    <div v-if="objectRemoval" class="ow-error" role="alert"><p>确认删除“{{objectRemoval.name}}”{{objectRemoval.kind==='pivot'?'及其汇总内容':''}}？</p><div class="ow-actions"><button :disabled="locked" @click="removeObject">确认删除对象</button><button @click="objectRemoval=undefined">取消</button></div></div>
   </template>
   <template v-else-if="panel==='sort'"><label class="ow-field">排序 / 筛选列<select v-model.number="options.column" :disabled="locked"><option v-for="column in Math.max(1,(state?.selection.endColumn||0)-(state?.selection.startColumn||0)+1)" :key="column" :value="column-1">选区第 {{column}} 列</option></select></label><label class="ow-check"><input v-model="options.header" type="checkbox" :disabled="locked"/>首行为标题，不参与排序</label><div class="ow-actions"><button :disabled="locked||!singleRange" @click="sort(true)">升序</button><button :disabled="locked||!singleRange" @click="sort(false)">降序</button></div><hr/><label class="ow-field">筛选条件<select v-model="options.operator" :disabled="locked"><option value="equal">等于</option><option value="not-equal">不等于</option><option value="contains">包含</option><option value="greater">大于</option><option value="less">小于</option></select></label><label class="ow-field">条件值<input v-model="options.value" :disabled="locked"/></label><div class="ow-actions"><button class="ow-primary" :disabled="locked||!singleRange" @click="filter">应用筛选</button><button :disabled="locked" @click="send(scoped({type:'clear-filter'}))">清除筛选</button></div></template>
   <template v-else-if="panel==='dimensions'"><div class="ow-field-row"><label class="ow-field">行高 · 毫米<input v-model.number="options.rowSize" type="number" min="0.1" max="500" :disabled="locked"/></label><label class="ow-field">列宽 · 毫米<input v-model.number="options.columnSize" type="number" min="0.1" max="500" :disabled="locked"/></label></div><div class="ow-actions"><button :disabled="locked" @click="applySize(true)">应用行高</button><button :disabled="locked" @click="applySize(false)">应用列宽</button></div><hr/><label class="ow-field">插入 / 删除数量<input v-model.number="options.count" type="number" min="1" max="1000" :disabled="locked"/></label><div class="ow-actions"><button :disabled="locked" @click="structure('insert-rows')">插入行</button><button :disabled="locked" @click="structure('insert-columns')">插入列</button><button :disabled="locked" @click="confirming='delete-rows'">删除行</button><button :disabled="locked" @click="confirming='delete-columns'">删除列</button></div></template>
   <template v-else-if="panel==='conditional'"><label class="ow-field">高亮条件<select v-model="options.condition" :disabled="locked"><option value="greater">大于</option><option value="less">小于</option><option value="equal">等于</option><option value="between">介于</option></select></label><label class="ow-field">数值<input v-model.number="options.threshold" type="number" :disabled="locked"/></label><label v-if="options.condition==='between'" class="ow-field">上限<input v-model.number="options.upper" type="number" :disabled="locked"/></label><label class="ow-control">填充颜色<input v-model="options.conditionColor" type="color" :disabled="locked"/></label><div class="ow-actions"><button class="ow-primary" :disabled="locked" @click="condition">应用条件格式</button><button :disabled="locked" @click="send(scoped({type:'clear-conditional-format'}))">清除规则</button></div></template>
   <template v-else-if="panel==='validation'"><label class="ow-field">允许输入<select v-model="options.validation" :disabled="locked"><option value="whole">整数</option><option value="decimal">小数</option><option value="list">列表</option><option value="none">任意值</option></select></label><label v-if="options.validation==='list'" class="ow-field">候选值（每行一个）<textarea v-model="options.items" :disabled="locked" rows="6"/></label><div v-else-if="options.validation!=='none'" class="ow-field-row"><label class="ow-field">最小值<input v-model.number="options.minimum" type="number" :disabled="locked"/></label><label class="ow-field">最大值<input v-model.number="options.maximum" type="number" :disabled="locked"/></label></div><label class="ow-check"><input v-model="options.allowBlank" type="checkbox" :disabled="locked"/>允许空单元格</label><div class="ow-actions"><button class="ow-primary" :disabled="locked" @click="validation">应用有效性规则</button></div></template>
   <template v-else-if="panel==='names'"><label class="ow-field">区域名称<input v-model="options.nameRange" :disabled="locked" placeholder="例如 Sales_Total"/></label><label class="ow-field">区域范围<input v-model="options.range" :disabled="locked" placeholder="A1:B10"/></label><div class="ow-actions"><button class="ow-primary" :disabled="locked||!options.nameRange.trim()||!options.range.trim()" @click="send({type:'define-name',name:options.nameRange.trim(),range:options.range.trim(),sheetIndex:state?.activeSheetIndex})">定义名称</button></div><h4 class="ow-subheading">已有名称</h4><ul class="ow-panel-list"><li v-for="item in state?.namedRanges||[]" :key="item.name"><span>{{item.name}}</span><p>{{item.content}}</p><button :disabled="locked" @click="send({type:'delete-name',name:item.name})">删除名称</button></li></ul><p v-if="!state?.namedRanges.length">暂无命名区域。</p></template>
   <template v-else-if="panel==='freeze'"><p>冻结左侧列与顶部行，滚动时保持标题可见。</p><div class="ow-field-row"><label class="ow-field">顶部行数<input v-model.number="options.freezeRows" type="number" min="0" max="1000" :disabled="locked"/></label><label class="ow-field">左侧列数<input v-model.number="options.freezeColumns" type="number" min="0" max="1000" :disabled="locked"/></label></div><div class="ow-actions"><button class="ow-primary" :disabled="locked" @click="send({type:'freeze',rows:Number(options.freezeRows),columns:Number(options.freezeColumns)})">应用冻结</button><button :disabled="locked" @click="send({type:'freeze',rows:0,columns:0})">取消冻结</button></div></template>
  </aside>
 </div>
 <div v-if="active" class="ow-sheet-tabs" role="tablist" aria-label="工作表"><button v-for="item in state?.sheets.filter(s=>s.visible)||[]" :key="item.index" role="tab" :aria-selected="item.index===state?.activeSheetIndex" :disabled="locked" @click="send({type:'select-sheet',sheetIndex:item.index})">{{item.name}}</button><button aria-label="新建工作表" :disabled="locked" @click="addSheet"><Icon name="plus" :size="15"/></button></div>
 <footer v-if="active" class="ow-status"><span>{{sheet?.name||'工作表'}}</span><span>{{range}}</span><span v-if="state?.cell.error" class="ow-status-extra">公式错误：{{state.cell.error}}</span><span class="ow-spacer"/><span v-if="summary" data-testid="sheet-selection-summary" :title="`${summary.includesHidden?'包含隐藏和筛选行':'排除隐藏和筛选行'}，隐藏列仍计入；文本数字不计入数值。数值数 ${summary.numericCount}，最小 ${formatNumber(summary.minimum)}，最大 ${formatNumber(summary.maximum)}${summary.errorCount?`；已排除 ${summary.errorCount} 个公式错误`:``}`">计数 {{summary.count}} · 求和 {{formatNumber(summary.sum)}} · 平均 {{formatNumber(summary.average)}}<template v-if="summary.errorCount"> · 错误 {{summary.errorCount}}</template></span><button v-if="summary" class="ow-command" data-testid="sheet-summary-hidden" :aria-pressed="summaryIncludeHidden" title="切换是否将隐藏和筛选行计入统计" @click="summaryIncludeHidden=!summaryIncludeHidden">{{summaryIncludeHidden?'含隐藏行':'可见行'}}</button><span v-else-if="summaryMessage">{{summaryMessage}}</span><span v-if="state?.frozen.rows||state?.frozen.columns">已冻结 {{state.frozen.rows}} 行 / {{state.frozen.columns}} 列</span><span>中文工作台</span></footer>
</section>
</template>

<style scoped>
.sheet-color-control{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:28px;border-radius:4px}
.sheet-color-control.is-uncertain,.sheet-color-control.is-empty{background:repeating-linear-gradient(135deg,#edf1f4 0 4px,#fff 4px 8px);border:1px solid #bac4cd}
.sheet-color-control.is-uncertain input,.sheet-color-control.is-empty input{opacity:0;width:100%;height:100%;position:absolute;inset:0;cursor:pointer}
.sheet-color-apply{border-bottom:3px solid;min-width:42px;font-size:10px}
.sheet-color-control span{font-size:10px;pointer-events:none;padding:2px 4px;color:#435363}
.ow-toolbar [aria-pressed="mixed"]{border-style:dashed;background:#eef2f5;box-shadow:inset 0 -3px #b6c2cd}
.sheet-format-note{margin:0;padding:5px 14px;background:#f6f8fa;color:#63717f;font-size:11px;border-bottom:1px solid #e4e8ec}
</style>
