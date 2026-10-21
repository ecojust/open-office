import { tool, type McpSchema } from './tool-schema.ts'

const str = (description: string, maxLength = 200): McpSchema => ({ type: 'string', description, maxLength })
const id: McpSchema = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' }
const canvasId: McpSchema = { type: 'string', minLength: 1, maxLength: 512 }
const num = (minimum: number, maximum: number): McpSchema => ({ type: 'number', minimum, maximum })
const index: McpSchema = { type: 'integer', minimum: 0, maximum: 20000 }
const bool: McpSchema = { type: 'boolean' }
const enumeration = (...values: string[]): McpSchema => ({ type: 'string', enum: values })
const object = (properties: Record<string,McpSchema>, required: string[] = []): McpSchema => ({ type: 'object', properties, required, additionalProperties: false })
const array = (items: McpSchema, maxItems: number, minItems = 0): McpSchema => ({ type: 'array', items, minItems, maxItems })
const operation = (op: string, properties: Record<string,McpSchema> = {}, required: string[] = []): McpSchema => object({ op: enumeration(op), ...properties }, ['op',...required])
const nullable = (schema: McpSchema): McpSchema => ({ anyOf: [schema,{ type: 'null' }] })
const textContent = array(object({ text: str('文字内容',1000000), marks: array(enumeration('bold','italic','underline','strike','code'),5) }, ['text']),20000)
const block: McpSchema = { anyOf: [
 object({ id, type: enumeration('paragraph','bullet','numbered'), content: textContent }, ['id','type','content']),
 object({ id, type: enumeration('heading'), content: textContent, level: { type: 'integer', enum: [1,2,3] } }, ['id','type','content','level']),
 object({ id, type: enumeration('todo'), content: textContent, checked: bool }, ['id','type','content','checked']),
 object({ id, type: enumeration('image'), dataUrl: str('内嵌PNG/JPEG data URL，不接受网址或路径；最多4MB原图',5592432), alt: str('图片说明') }, ['id','type','dataUrl','alt']),
] }
const geometry = { x: num(0,20000), y: num(0,20000), width: num(80,20000), height: num(40,20000) }
const blocks = array(block,20000,1)
const noteOperations: McpSchema[] = [
 operation('notebook.rename',{ title: str('笔记本名称') },['title']),
 operation('section.add',{ id,title: str('分区名称'),index },['title']),
 operation('section.rename',{ sectionId:id,title:str('分区名称') },['sectionId','title']),
 operation('section.delete',{ sectionId:id },['sectionId']),
 operation('section.move',{ sectionId:id,index },['sectionId','index']),
 operation('page.add',{ sectionId:id,id,title:str('页面标题'),parentId:id,index },['sectionId','title']),
 operation('page.rename',{ pageId:id,title:str('页面标题') },['pageId','title']),
 operation('page.delete',{ pageId:id },['pageId']),
 operation('page.move',{ pageId:id,sectionId:id,parentId:nullable(id),index },['pageId','sectionId']),
 operation('region.add',{ pageId:id,region:object({ id,...geometry,blocks },['x','y','width']),index },['pageId','region']),
 operation('region.update',{ regionId:id,patch:{ ...object({ ...geometry,height:nullable(geometry.height!),blocks }),minProperties:1 } },['regionId','patch']),
 operation('region.delete',{ regionId:id },['regionId']),
 operation('region.move',{ regionId:id,pageId:id,index },['regionId','pageId']),
]
export const noteEditingTools = [
 tool('note_read_page','读取当前或指定笔记页面，包含可编辑的区域、富文本块和定位ID。图片只返回说明，更新区域时省略blocks可保留图片。',true,{ pageId:id,offset:index,limit:{ type:'integer',minimum:1,maximum:200 } }),
 tool('note_select_page','切换到指定笔记页面并在软件中显示。只改变视图，不修改内容。',true,{ pageId:id },['pageId']),
 tool('note_edit','原子编辑笔记本：分区/页面/子页的添加、重命名、删除、移动排序；区域的添加、富文本/待办/内嵌图片、位置尺寸与内容更新、删除及跨页移动。删除页面包含其子页面。page.move不传parentId表示移到根层。数组index从0开始；每次调用可撤销。变更后自动显示受影响页面，selectPageId可指定显示页面。',false,{ operations:array({anyOf:noteOperations},100,1),selectPageId:id },['operations']),
]
const point = object({ x:num(-1000000,1000000),y:num(-1000000,1000000) },['x','y'])
const endpoint = object({ x:num(-1000000,1000000),y:num(-1000000,1000000),nodeId:canvasId },['x','y'])
const style = object({ stroke:str('描边颜色',100),fill:str('填充颜色',100),strokeWidth:num(0,100),fontSize:num(1,500),textAlign:enumeration('left','center','right'),opacity:num(0,1),dashed:bool,roughness:enumeration('clean','sketch'),strokePattern:enumeration('solid','dashed','dotted') })
const common = { id:canvasId,style,locked:bool,groupId:canvasId }
const shapeFields = { shape:enumeration('rectangle','ellipse','diamond','note','text','image','triangle','hexagon','star','parallelogram','cylinder','cloud','frame','brace-left','brace-right','brace-top','brace-bottom'),x:num(-1000000,1000000),y:num(-1000000,1000000),width:num(1,100000),height:num(1,100000),cornerRadius:num(0,100000),text:str('图形文字',100000),imageData:str('内嵌PNG/JPEG/WebP data URL；不接受网址或路径',14680064) }
const edgeFields = { from:endpoint,to:endpoint,label:str('连线标签',100000),arrow:enumeration('end','both','none'),route:enumeration('straight','orthogonal') }
const strokeFields = { points:array(point,100000,1),brush:enumeration('pen','pencil','marker','brush','highlighter','rainbow'),pressures:array(num(0,1),100000),closed:bool }
const element: McpSchema = { anyOf: [object({ ...common,type:enumeration('shape'),...shapeFields },['type','shape']),object({ ...common,type:enumeration('edge'),...edgeFields },['type','from','to']),object({ ...common,type:enumeration('stroke'),...strokeFields },['type','points'])] }
const ids = array(canvasId,5000,1)
const offsets = { dx:num(-1000000,1000000),dy:num(-1000000,1000000) }
const canvasOperations = [
 operation('add',{ element },['element']),
 operation('update',{ id:canvasId,patch:{ ...object({ ...shapeFields,...edgeFields,...strokeFields,style,locked:bool,groupId:nullable(canvasId) }),minProperties:1 } },['id','patch']),
 ...['delete','group','ungroup'].map(op=>operation(op,{ids},['ids'])),
 ...['move','duplicate'].map(op=>operation(op,{ids,...offsets},['ids'])),
 operation('reorder',{ids,order:enumeration('front','back','forward','backward')},['ids','order']),
 operation('align',{ids,alignment:enumeration('left','center','right','top','middle','bottom')},['ids','alignment']),
 operation('distribute',{ids,axis:enumeration('horizontal','vertical')},['ids','axis']),
 operation('layout',{direction:enumeration('TB','LR','BT','RL')}),
 operation('settings',{title:str('文档标题'),background:str('画布颜色',100),grid:bool,defaultStyle:style}),
 operation('template',{templateId:str('模板ID',100),x:num(-1000000,1000000),y:num(-1000000,1000000)},['templateId']),
]
export const canvasEditingTools = [
 tool('canvas_read_elements','读取画布元素的完整可编辑属性与ID，支持按ID筛选和分页；图片仅返回说明，局部update会保留图片数据。',true,{ids,offset:index,limit:{type:'integer',minimum:1,maximum:200}}),
 tool('canvas_list_templates','列出可插入画布的内置模板。',true),
 tool('canvas_select_elements','选择画布元素并可适应画布显示；只改变视图。ids为空数组可清除选择。',true,{ ids:array(canvasId,5000),fit:bool },['ids']),
 tool('canvas_edit','原子编辑画布：所有图形、图片、连线和笔迹的增删改、移动、复制、样式、圆角、文字、锁定、组合、层级、对齐、分布、自动布局及模板；settings修改背景/网格/默认样式。被锁定元素需先update locked:false解锁。删除图形会移除相关未锁定连线。仅修改传入属性；图片必须内嵌。每次调用可撤销，页面实时刷新。',false,{operations:array({anyOf:canvasOperations},100,1),fit:bool},['operations']),
]
export const diagramEditingTools = [
 tool('diagram_read','读取当前图表源码、标题、样式及解析状态。',true),
 tool('diagram_list_templates','列出内置代码图表模板和可用样式。',true,{query:str('按模板名称/类型筛选',100)}),
 tool('diagram_update','修改图表源码、标题、风格，或应用templateId。source与templateId不能同时提供；新源码须能成功解析。全部变化一次撤销，源码与预览同步更新。',false,{ source:str('图表源码',500000),templateId:str('内置模板ID',100),title:str('文档标题'),style:enumeration('classic','minimal','blueprint','ink','sketch','forest','ocean','sunset','lavender','midnight') }),
]
