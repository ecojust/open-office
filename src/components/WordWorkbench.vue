<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { WriterState, WriterAction, WriterQuery, WriterTableData, WriterTextStyle, WriterParagraph } from '../word/types'
import '../office/workbench.css'
const props = withDefaults(defineProps<{ state?: WriterState | null; active?: boolean; busy?: boolean; disabled?: boolean; readData?: (query: WriterQuery) => Promise<unknown> }>(), { active: true, busy: false, disabled: false })
const emit = defineEmits<{ action: [action: WriterAction]; refresh: []; 'insert-image': []; 'draft-change': [pending: boolean] }>()
const tabs = ['开始','插入','布局','审阅'] as const
const tab = ref<(typeof tabs)[number]>('开始'), panel = ref(''), problem = ref(''), confirmingRemoval=ref(false)
const draft = reactive<Record<string,string>>({}), baseline = ref(''), origin = ref<{ id: string; revision: number; selection: string }>()
const pending = computed(() => !!panel.value && JSON.stringify(draft) !== baseline.value)
const ready = computed(() => props.active && !!props.state && !props.disabled && !props.busy)
const locked = computed(() => !ready.value || pending.value)
const stale = computed(() => pending.value && !!origin.value && (origin.value.id !== props.state?.documentId || (panel.value!=='table' && origin.value.revision !== props.state.revision) || (['text','paragraph','comment','footnote','insertTable','toc'].includes(panel.value) && origin.value.selection !== props.state.selection.id)))
const titles: Record<string,string> = { text:'文字输入', paragraph:'段落设置', page:'纸张与页边距', header:'页眉', footer:'页脚', insertTable:'插入表格', table:'表格数据', outline:'文档大纲', find:'查找与替换', review:'批注与修订', comment:'添加批注', footnote:'插入脚注', toc:'文档目录' }
const tableVersion=ref<{documentId:string;revision:number}>()
const table = ref<WriterTableData>(), tableLoading = ref(false), tableName = ref('')
const search = reactive({ text:'', replace:'', matchCase:false, wholeWords:false })
let token = 0, disposed = false, applying: { id: string; revision: number } | undefined
function resetValues(state:WriterState|null|undefined=props.state) {
  const s=state, values:Record<string,string>={}
  if(panel.value==='text') values.text=s?.selection.text || ''
  else if(panel.value==='paragraph') for(const key of ['leftIndent','rightIndent','firstLineIndent','spaceAbove','spaceBelow','lineSpacingPercent'] as const) values[key]=String(s?.paragraph[key] ?? 0)
  else if(panel.value==='page') for(const key of ['width','height','marginLeft','marginRight','marginTop','marginBottom'] as const) values[key]=String(s?.page[key] ?? 0)
  else if(panel.value==='header'||panel.value==='footer') { values.text=s?.page[panel.value==='header'?'headerText':'footerText'] || ''; values.enabled=String(s?.page[panel.value==='header'?'headerEnabled':'footerEnabled'] ?? false) }
  else if(panel.value==='insertTable') { values.rows='3'; values.columns='3' }
  else if(panel.value==='comment') { values.text=''; values.author='作者' }
  else if(panel.value==='footnote') { values.text=''; values.endnote='false' }
  else if(panel.value==='toc') { values.title='目录'; values.levels='3' }
  else if(panel.value==='table') values.cells=table.value ? JSON.stringify(table.value.cells) : ''
  for(const key of Object.keys(draft)) delete draft[key]
  Object.assign(draft,values); baseline.value=JSON.stringify(draft); origin.value=undefined
}
function edit(key:string,value:string) {
  if(!ready.value) return
  if(!origin.value && props.state) origin.value={id:props.state.documentId,revision:panel.value==='table'?tableVersion.value?.revision??props.state.revision:props.state.revision,selection:props.state.selection.id}
  draft[key]=value; problem.value='';confirmingRemoval.value=false
}
function styleLabel(name:string,label:string){
  const names:Record<string,string>={Standard:'正文',Title:'文档标题',Subtitle:'副标题','Text body':'正文段落','Body Text':'正文段落',Quotations:'引用',Quote:'引用','Preformatted Text':'预格式文本'}
  const heading=/^Heading\s*(\d+)$/i.exec(name)
  return names[name]||(heading?`标题 ${heading[1]}`:label)
}
function tabKey(event:KeyboardEvent,index:number){if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tab.value=tabs[next];(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()}
function input(key:string,event:Event) { edit(key,(event.target as HTMLInputElement).value) }
function openPanel(name:string) {
  if(pending.value) {problem.value='请先应用或还原当前输入，再切换面板。';return}
  panel.value=panel.value===name?'':name; problem.value=''; token++; tableLoading.value=false; resetValues()
}
function send(action:WriterAction,fromDraft=false) {
  if(!ready.value || (!fromDraft && pending.value) || !props.state) return
  if(fromDraft && stale.value) {problem.value='文档或选区已改变。请还原输入，再重新编辑。';return}
  problem.value=''
  if(fromDraft) applying={id:props.state.documentId,revision:props.state.revision}
  emit('action',{...action,expectedRevision:fromDraft?origin.value?.revision??props.state.revision:props.state.revision,...(action.type==='update-table'?{}:{expectedSelectionId:props.state.selection.id})})
}
function format(update:Partial<WriterTextStyle>) {send({type:'format-text',...update})}
function paragraph(update:Partial<WriterParagraph>) {send({type:'format-paragraph',...update})}
function apply(confirmRemoval=false) {
  if(!pending.value || !props.state) return
  if(panel.value==='text') {if(draft.text.length>20000){problem.value='单次输入不能超过 2 万字。';return} send({type:'insert-text',text:draft.text,replaceSelection:!props.state.selection.collapsed},true)}
  else if(panel.value==='paragraph') {
    const values=Object.fromEntries(Object.entries(draft).map(([key,value])=>[key,Number(value)]))
    if(Object.values(values).some(value=>!Number.isFinite(value))||['leftIndent','rightIndent','spaceAbove','spaceBelow'].some(key=>values[key]<0||values[key]>200)||values.firstLineIndent< -100||values.firstLineIndent>200||values.lineSpacingPercent<80||values.lineSpacingPercent>300){problem.value='缩进与间距为 0–200 毫米，首行缩进为 −100–200 毫米，行距为 80%–300%。';return}
    send({type:'format-paragraph',...values},true)
  } else if(panel.value==='page') {
    const values=Object.fromEntries(Object.entries(draft).map(([key,value])=>[key,Number(value)]))
    if(Object.values(values).some(value=>!Number.isFinite(value)||value<0)||values.width<50||values.height<50||values.width>1200||values.height>1200||['marginLeft','marginRight','marginTop','marginBottom'].some(key=>values[key]>500)||values.marginLeft+values.marginRight>values.width-10||values.marginTop+values.marginBottom>values.height-10){problem.value='纸张宽高需要 50–1200 毫米，页边距不超过 500 毫米，正文宽高至少留 10 毫米。';return}
    send({type:'set-page',...values,landscape:values.width>values.height},true)
  } else if(panel.value==='header'||panel.value==='footer') {
    const enabled=draft.enabled==='true',wasEnabled=panel.value==='header'?props.state.page.headerEnabled:props.state.page.footerEnabled
    if(wasEnabled&&!enabled&&confirmRemoval!==true){confirmingRemoval.value=true;return}
    confirmingRemoval.value=false
    send({type:'set-header-footer',target:panel.value,enabled,...(wasEnabled&&!enabled?{confirmRemoval:true}:{}),...((panel.value==='header'?props.state.page.headerTruncated:props.state.page.footerTruncated)?{}:{text:draft.text})},true)
  }
  else if(panel.value==='insertTable') {
    const rows=Number(draft.rows),columns=Number(draft.columns)
    if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||rows>30||columns<1||columns>20){problem.value='表格支持 1–30 行、1–20 列。';return}
    send({type:'insert-table',rows,columns},true)
  } else if(panel.value==='comment'){if(!draft.text.trim()){problem.value='请填写批注内容。';return}send({type:'insert-comment',text:draft.text,author:draft.author.trim()||'作者'},true)}
  else if(panel.value==='footnote'){if(!draft.text.trim()){problem.value='请填写脚注内容。';return}send({type:'insert-footnote',text:draft.text,endnote:draft.endnote==='true'},true)}
  else if(panel.value==='toc'){const levels=Number(draft.levels);if(!Number.isInteger(levels)||levels<1||levels>10){problem.value='目录层级需要 1–10。';return}send({type:'insert-toc',title:draft.title,levels},true)}
  else if(panel.value==='table'&&table.value) send({type:'update-table',name:table.value.name,cells:JSON.parse(draft.cells),expectedTableId:table.value.tableId,expectedCells:table.value.cells.map(row=>[...row]),expectedCellSignatures:table.value.cellSignatures.map(row=>[...row])},true)
}
function insertTable() {if(!props.state||locked.value)return; const rows=Number(draft.rows),columns=Number(draft.columns);if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||rows>30||columns<1||columns>20){problem.value='表格支持 1–30 行、1–20 列。';return}send({type:'insert-table',rows,columns})}
function discardDrafts() { applying=undefined; confirmingRemoval.value=false; problem.value=''; resetValues() }
function actionSucceeded(state:WriterState) {
  const request=applying
  if(!request||state.documentId!==request.id)return
  applying=undefined;confirmingRemoval.value=false
  const refreshName=panel.value==='table'?tableName.value:''
  if(refreshName){table.value=undefined;tableVersion.value=undefined}
  resetValues(state)
  if(refreshName)void nextTick(()=>readTable(refreshName))
}
function actionFailed(){applying=undefined;confirmingRemoval.value=false}

function assertNoPendingEdits(){if(pending.value)throw Error('文字工作台有尚未应用的输入，请先点击“应用”或“还原”。')}
async function readTable(name:string) {
  if(!props.readData||!props.state||pending.value||!name)return
  const request=++token,documentId=props.state.documentId,revision=props.state.revision
  panel.value='table';tableLoading.value=true;problem.value=''
  try {const value=await props.readData({type:'table',name}) as WriterTableData
    if(disposed||request!==token)return
    if(pending.value)throw Error('尚有未应用的表格输入，已保留草稿。')
    if(!value||value.documentId!==documentId||typeof value.revision!=='number'||!Number.isSafeInteger(value.revision)||value.revision<revision)throw Error('返回的文档版本无效，已保留原内容。')
    if(props.state?.documentId!==documentId)throw Error('文档已切换，已忽略旧表格。')
    if(value.name!==name||typeof value.tableId!=='string'||!value.tableId||!Array.isArray(value.cells)||!Array.isArray(value.cellSignatures)||value.cellSignatures.length!==value.cells.length||value.cells.some((row,r)=>!Array.isArray(row)||!Array.isArray(value.cellSignatures[r])||value.cellSignatures[r].length!==row.length||value.cellSignatures[r].some(cell=>typeof cell!=='string')))throw Error('未能读取此表格。')
    table.value=value;tableName.value=name;tableVersion.value={documentId,revision:value.revision};resetValues()
  } catch(error){if(request===token)problem.value=error instanceof Error?error.message:String(error)}
  finally{if(request===token)tableLoading.value=false}
}
const tableCells=computed<string[][]>(()=>{try{return JSON.parse(draft.cells||'[]')}catch{return []}})
function editCell(row:number,column:number,event:Event){const cells=tableCells.value.map(row=>[...row]);cells[row][column]=(event.target as HTMLInputElement).value;edit('cells',JSON.stringify(cells))}
function find(replace=false,all=false){if(!search.text.trim())return;send({type:'find-replace',search:search.text,...(replace?{replace:search.replace,all}:{}),matchCase:search.matchCase,wholeWords:search.wholeWords})}
watch(()=>props.state,(state,previous)=>{
  if(previous?.documentId&&state?.documentId!==previous.documentId){token++;applying=undefined;panel.value='';table.value=undefined;tableVersion.value=undefined;tableName.value='';resetValues();return}
  if(!pending.value&&!applying){if(tableVersion.value&&state?.documentId!==tableVersion.value.documentId){table.value=undefined;tableVersion.value=undefined}resetValues()}
},{deep:true,immediate:true})
watch(()=>props.active,active=>{if(!active&&!pending.value){panel.value='';token++;resetValues()}})
watch(pending,value=>emit('draft-change',value),{immediate:true})
onBeforeUnmount(()=>{disposed=true;token++})
defineExpose({hasPendingEdits:()=>pending.value,assertNoPendingEdits,discardDrafts,actionSucceeded,actionFailed})
</script>
<template>
<section class="ow-workbench ow-word" :aria-label="active?'文字工作台':undefined">
 <header v-if="active" class="ow-ribbon">
  <div class="ow-ribbon-top"><span class="ow-mark" aria-hidden="true">W</span><div class="ow-tabs" role="tablist" aria-label="文字工具"><button v-for="(item,index) in tabs" :key="item" role="tab" :aria-selected="tab===item" :tabindex="tab===item?0:-1" @click="tab=item" @keydown="tabKey($event,index)">{{item}}</button></div><span class="ow-spacer"/><span class="ow-ribbon-meta">文字 · 本地编辑</span><button class="ow-command" :aria-pressed="panel==='outline'" :disabled="!ready" @click="openPanel('outline')"><Icon name="menu" :size="15"/>大纲</button><button class="ow-command" :disabled="locked" aria-label="刷新文字状态" @click="emit('refresh')">↻</button></div>
  <div class="ow-toolbar" role="tabpanel" :aria-label="`${tab}工具`">
   <template v-if="tab==='开始'">
    <select aria-label="段落样式" :value="state?.paragraph.styleName" :disabled="locked" @change="send({type:'apply-style',name:($event.target as HTMLSelectElement).value})"><option v-for="style in state?.styles||[]" :key="style.name" :value="style.name">{{styleLabel(style.name,style.label)}}</option></select>
    <select aria-label="字体" :value="state?.textStyle.fontName" :disabled="locked" @change="format({fontName:($event.target as HTMLSelectElement).value})"><option v-if="state?.textStyle.fontName" :value="state.textStyle.fontName">{{state.textStyle.fontName}}</option><option>Noto Sans CJK SC</option><option>Carlito</option><option>Liberation Serif</option><option>Liberation Mono</option></select>
    <select aria-label="字号（磅）" :value="state?.textStyle.fontSize" :disabled="locked" @change="format({fontSize:Number(($event.target as HTMLSelectElement).value)})"><option v-for="size in [9,10,10.5,11,12,14,16,18,20,24,28,32,36,48,72]" :key="size">{{size}}</option></select>
    <button class="ow-command ow-square" aria-label="加粗" :aria-pressed="state?.textStyle.bold" :disabled="locked" @click="format({bold:!state?.textStyle.bold})"><b>B</b></button><button class="ow-command ow-square" aria-label="斜体" :aria-pressed="state?.textStyle.italic" :disabled="locked" @click="format({italic:!state?.textStyle.italic})"><i>I</i></button><button class="ow-command ow-square" aria-label="下划线" :aria-pressed="state?.textStyle.underline" :disabled="locked" @click="format({underline:!state?.textStyle.underline})"><u>U</u></button>
    <input type="color" aria-label="文字颜色" :value="state?.textStyle.color||'#000000'" :disabled="locked" @change="format({color:($event.target as HTMLInputElement).value})"/><span class="ow-divider"/>
    <select aria-label="段落对齐" :value="state?.paragraph.align" :disabled="locked" @change="paragraph({align:($event.target as HTMLSelectElement).value as WriterParagraph['align']})"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select>
    <button class="ow-command" :disabled="!ready" @click="openPanel('paragraph')">段落</button><button class="ow-command" :disabled="!ready" @click="openPanel('text')">编辑选中文字</button>
   </template>
   <template v-else-if="tab==='插入'"><button class="ow-command" :disabled="!ready" @click="openPanel('text')"><Icon name="file" :size="16"/>文字</button><button class="ow-command" :disabled="locked" @click="emit('insert-image')"><Icon name="image" :size="16"/>图片</button><button class="ow-command" :disabled="!ready" @click="openPanel('insertTable')"><Icon name="sheet" :size="16"/>表格</button><span class="ow-divider"/><button class="ow-command" :disabled="!ready" @click="openPanel('toc')">目录</button><button class="ow-command" :disabled="locked" @click="send({type:'insert-break',kind:'page'})">分页符</button><button class="ow-command" :disabled="!ready" @click="openPanel('header')">页眉</button><button class="ow-command" :disabled="!ready" @click="openPanel('footer')">页脚</button><button class="ow-command" :disabled="locked" @click="send({type:'insert-page-number',target:'footer',align:'center'})">页码</button></template>
   <template v-else-if="tab==='布局'"><button class="ow-command" :disabled="locked" @click="send({type:'set-page',width:210,height:297,landscape:false})">A4 纵向</button><button class="ow-command" :disabled="locked" @click="send({type:'set-page',width:297,height:210,landscape:true})">A4 横向</button><button class="ow-command" :disabled="!ready" @click="openPanel('page')">纸张与页边距</button><span class="ow-divider"/><button class="ow-command" :disabled="!ready" @click="openPanel('paragraph')">缩进与间距</button></template>
   <template v-else><button class="ow-command" :disabled="!ready" @click="openPanel('find')"><Icon name="search" :size="16"/>查找与替换</button><button class="ow-command" :disabled="!ready" @click="openPanel('table')">表格数据</button><span class="ow-divider"/><button class="ow-command" :disabled="!ready" @click="openPanel('comment')">添加批注</button><button class="ow-command" :disabled="!ready" @click="openPanel('review')">批注与修订</button><button class="ow-command" :disabled="!ready" @click="openPanel('footnote')">脚注 / 尾注</button></template>
  </div>
 </header>
 <div v-if="active&&pending" class="ow-notice" data-testid="word-draft-notice">{{stale?'选区或文档已改变，请还原输入后重试。':'还有未应用的输入；保存或切换文档前，请先应用或还原。'}}<button :disabled="busy" @click="discardDrafts">还原</button></div>
 <div v-if="active&&problem" class="ow-notice ow-error" role="alert">{{problem}}</div>
 <div class="ow-body"><div class="ow-canvas"><slot/></div>
  <aside v-if="active&&panel" class="ow-panel" :aria-label="titles[panel]">
   <div class="ow-panel-heading"><h3>{{titles[panel]}}</h3><button class="ow-command ow-square" aria-label="关闭文字面板" :disabled="pending" @click="panel=''">×</button></div>
   <template v-if="panel==='text'"><p>{{state?.selection.collapsed?'在画布内放置光标，再输入要插入的文字。':'应用会替换画布中当前选中的文字。'}}</p><label class="ow-field">文字内容<textarea aria-label="文字内容" :value="draft.text" :disabled="!ready||state?.selection.truncated" rows="9" @input="input('text',$event)"/><small>单次最多 20,000 字；长文可直接在画布内编辑。</small></label><p v-if="state?.selection.truncated">选区过大，请在画布内缩小选区后编辑。</p></template>
   <template v-else-if="panel==='paragraph'"><div class="ow-field-row"><label v-for="item in [{key:'leftIndent',label:'左缩进'},{key:'rightIndent',label:'右缩进'},{key:'firstLineIndent',label:'首行缩进'},{key:'spaceAbove',label:'段前间距'},{key:'spaceBelow',label:'段后间距'}]" :key="item.key" class="ow-field">{{item.label}} · 毫米<input type="number" step="0.5" :value="draft[item.key]" :disabled="!ready" @input="input(item.key,$event)"/></label><label class="ow-field">行距 · %<input type="number" min="80" max="300" :value="draft.lineSpacingPercent" :disabled="!ready" @input="input('lineSpacingPercent',$event)"/></label></div></template>
   <template v-else-if="panel==='page'"><p>设置作用于当前页面样式。</p><div class="ow-field-row"><label v-for="item in [{key:'width',label:'纸张宽度'},{key:'height',label:'纸张高度'},{key:'marginTop',label:'上边距'},{key:'marginBottom',label:'下边距'},{key:'marginLeft',label:'左边距'},{key:'marginRight',label:'右边距'}]" :key="item.key" class="ow-field">{{item.label}} · 毫米<input type="number" step="1" min="0" :value="draft[item.key]" :disabled="!ready" @input="input(item.key,$event)"/></label></div></template>
   <template v-else-if="panel==='header'||panel==='footer'"><label class="ow-check"><input type="checkbox" :checked="draft.enabled==='true'" :disabled="!ready" @change="edit('enabled',String(($event.target as HTMLInputElement).checked))"/>启用{{panel==='header'?'页眉':'页脚'}}</label><label class="ow-field">{{panel==='header'?'页眉':'页脚'}}文字<textarea :value="draft.text" :disabled="!ready||draft.enabled!=='true'||(panel==='header'?state?.page.headerTruncated:state?.page.footerTruncated)" rows="5" @input="input('text',$event)"/></label><p v-if="panel==='header'?state?.page.headerTruncated:state?.page.footerTruncated">内容较长，仅显示摘要。请在画布中编辑，开关仍可单独设置。</p><p>文字内容会替换当前样式已有的{{panel==='header'?'页眉':'页脚'}}，包括其中的字段。</p></template>
   <template v-else-if="panel==='insertTable'"><div class="ow-field-row"><label class="ow-field">行数<input type="number" min="1" max="30" :value="draft.rows" :disabled="!ready" @input="input('rows',$event)"/></label><label class="ow-field">列数<input type="number" min="1" max="20" :value="draft.columns" :disabled="!ready" @input="input('columns',$event)"/></label></div><p>在当前光标处插入可编辑表格。可以直接在画布内输入单元格内容。</p><div v-if="!pending" class="ow-actions"><button class="ow-primary" :disabled="locked" @click="insertTable">插入表格</button></div></template>
   <template v-else-if="panel==='table'"><p>只写入修改的单元格，其他单元格保持原样。多段文字或复杂字段请在画布中编辑。</p><label class="ow-field">选择表格<select v-model="tableName" :disabled="!ready||pending||tableLoading" @change="readTable(tableName)"><option value="">请选择</option><option v-for="item in state?.tables||[]" :key="item.name" :value="item.name">{{item.name}} · {{item.rows}} × {{item.columns}}</option></select></label><button class="ow-command" :disabled="!ready||pending||tableLoading||!tableName" @click="readTable(tableName)">重新读取表格</button><p v-if="tableLoading" role="status">正在读取表格…</p><p v-else-if="!state?.tables.length">文档中暂无表格。</p><div v-if="table&&tableCells.length" class="ow-table-grid"><table><tbody><tr v-for="(row,r) in tableCells" :key="r"><td v-for="(cell,c) in row" :key="c"><textarea :aria-label="`第 ${r+1} 行第 ${c+1} 列`" :value="cell" :disabled="!ready||tableLoading" rows="2" @input="editCell(r,c,$event)"/></td></tr></tbody></table></div></template>
   <template v-else-if="panel==='outline'"><p>使用标题样式组织文档；点击标题跳转。</p><ul class="ow-panel-list"><li v-for="item in state?.outline||[]" :key="item.id"><button :style="{paddingLeft:`${10+Math.min(item.level,6)*9}px`}" :disabled="locked" @click="send({type:'goto-outline',id:item.id})">{{item.text||'未命名标题'}}</button></li></ul><p v-if="!state?.outline.length">文档中暂无标题。选中段落后选择“标题”样式即可生成大纲。</p><p v-if="state?.outlineTruncated">仅显示部分标题。</p></template>
   <template v-else-if="panel==='find'"><label class="ow-field">查找内容<input v-model="search.text" :disabled="!ready" @keydown.enter="find()"/></label><label class="ow-field">替换为<input v-model="search.replace" :disabled="!ready"/></label><label class="ow-check"><input v-model="search.matchCase" type="checkbox"/>区分大小写</label><label class="ow-check"><input v-model="search.wholeWords" type="checkbox"/>全字匹配</label><div class="ow-actions"><button :disabled="locked||!search.text" @click="find()">查找下一处</button><button :disabled="locked||!search.text" @click="find(true,false)">替换</button><button :disabled="locked||!search.text" @click="find(true,true)">全部替换</button></div></template>
   <template v-else-if="panel==='comment'"><p>批注关联当前选区或光标位置。</p><label class="ow-field">作者<input :value="draft.author" :disabled="!ready" maxlength="100" @input="input('author',$event)"/></label><label class="ow-field">批注内容<textarea :value="draft.text" :disabled="!ready" rows="7" @input="input('text',$event)"/></label></template>
   <template v-else-if="panel==='footnote'"><label class="ow-check"><input type="checkbox" :checked="draft.endnote==='true'" :disabled="!ready" @change="edit('endnote',String(($event.target as HTMLInputElement).checked))"/>改为文末尾注</label><label class="ow-field">注释文字<textarea :value="draft.text" :disabled="!ready" rows="7" @input="input('text',$event)"/></label></template>
   <template v-else-if="panel==='toc'"><p>根据文档标题样式生成可更新的目录。</p><label class="ow-field">目录标题<input :value="draft.title" :disabled="!ready" maxlength="100" @input="input('title',$event)"/></label><label class="ow-field">收录标题层级<input :value="draft.levels" type="number" min="1" max="10" :disabled="!ready" @input="input('levels',$event)"/></label><div v-if="!pending" class="ow-actions"><button class="ow-primary" :disabled="locked" @click="send({type:'insert-toc',title:draft.title,levels:Number(draft.levels)})">插入目录</button><button :disabled="locked||!state?.review.indexCount" @click="send({type:'update-indexes'})">更新已有目录</button></div></template>
   <template v-else-if="panel==='review'"><label class="ow-check"><input type="checkbox" :checked="state?.review.recordChanges" :disabled="locked" @change="send({type:'set-track-changes',enabled:($event.target as HTMLInputElement).checked})"/>记录修订</label><p>当前 {{state?.review.changeCount||0}} 处修订，{{state?.review.comments.length||0}} 条批注。</p><div class="ow-actions"><button :disabled="locked||!state?.review.changeCount" @click="send({type:'review-changes',decision:'accept',scope:'selection'})">接受选区修订</button><button :disabled="locked||!state?.review.changeCount" @click="send({type:'review-changes',decision:'reject',scope:'selection'})">拒绝选区修订</button></div><div class="ow-actions"><button :disabled="locked||!state?.review.changeCount" @click="send({type:'review-changes',decision:'accept',scope:'all'})">接受全部</button><button :disabled="locked||!state?.review.changeCount" @click="send({type:'review-changes',decision:'reject',scope:'all'})">拒绝全部</button></div><ul class="ow-panel-list"><li v-for="item in state?.review.comments||[]" :key="item.index"><strong>{{item.author||'作者'}}</strong><p>{{item.text}}</p><div class="ow-actions"><button :disabled="locked" @click="send({type:'navigate-comment',index:item.index})">定位批注</button><button :disabled="locked" @click="send({type:'delete-comment',index:item.index})">删除批注</button></div></li></ul></template>
   <div v-if="confirmingRemoval" class="ow-error" role="alert"><p>关闭会删除当前页样式的{{panel==='header'?'页眉':'页脚'}}内容，包括页码和图片。此操作无法在文档内撤销；取消可保留原内容。</p><div class="ow-actions"><button class="ow-danger" :disabled="!ready||stale" @click="apply(true)">确认关闭并删除内容</button><button @click="confirmingRemoval=false">取消</button></div></div>
   <div v-if="pending&&!confirmingRemoval" class="ow-actions"><button class="ow-primary" :disabled="!ready||stale" @click="apply()">{{panel==='insertTable'?'插入表格':'应用'}}</button><button :disabled="busy" @click="discardDrafts">还原</button></div>
  </aside>
 </div>
 <footer v-if="active" class="ow-status"><span>{{state?.selection.collapsed?'光标已定位':`已选中 ${state?.selection.text.length||0} 字`}}</span><span v-if="state" class="ow-status-extra">{{state.page.width}} × {{state.page.height}} 毫米</span><span class="ow-spacer"/><span>中文工作台 · 完整编辑画布</span></footer>
</section>
</template>
