import type { PrintOutcome } from './printing'

export type Kind = 'word'|'sheet'|'presentation'|'pdf'|'note'|'canvas'|'diagram'
export type Extension = 'docx'|'xlsx'|'csv'|'tsv'|'pptx'|'potx'|'ppsx'|'pdf'|'oonote'|'owflow'|'mmd'|'mermaid'|'drawio'|'xml'|'excalidraw'|'json'|'svg'|'png'
export type SaveExtension = Exclude<Extension,'potx'|'ppsx'|'mermaid'|'xml'|'json'>
export type SaveFormatOption = { extension: SaveExtension; title: string; description: string }
/** Formats actually implemented by each active editor, not all import formats. */
export function saveFormats(kind: Kind): SaveFormatOption[] {
 const pdf: SaveFormatOption = { extension: 'pdf', title: 'PDF 文档', description: '用于阅读、打印与分享' }
 const graphics: SaveFormatOption[] = [{ extension: 'svg', title: 'SVG 矢量图', description: '保留清晰的线条和文字，用于展示与分享' }, { extension: 'png', title: 'PNG 图片', description: '导出当前画面，用于文档、演示和分享' }]
 const editable: SaveFormatOption = { extension: 'owflow', title: 'Open Office 画布与图表', description: '保留可编辑内容、源码与样式' }
 const formats: Record<Kind, SaveFormatOption[]> = {
  word: [{ extension: 'docx', title: 'DOCX 文档', description: '保留可编辑的文字、表格和排版' }, pdf],
  sheet: [{ extension: 'xlsx', title: 'XLSX 工作簿', description: '保留工作表、公式和单元格格式' }, { extension: 'csv', title: 'CSV 数据副本', description: '仅导出当前工作表的显示值，不包含公式、格式和其他工作表' }, { extension: 'tsv', title: 'TSV 数据副本', description: '以制表符分隔当前工作表的显示值，不包含公式、格式和其他工作表' }, pdf],
  presentation: [{ extension: 'pptx', title: 'PPTX 演示文稿', description: '保留可编辑的幻灯片与对象' }, { ...pdf, description: '静态页面，不包含放映动画与音视频' }],
  pdf: [pdf],
  note: [{ extension: 'oonote', title: 'Open Office 笔记本', description: '保留分区、页面、富文本、待办与图片' }],
  canvas: [editable, ...graphics, { extension: 'drawio', title: '图形 XML', description: '导出兼容的图形结构，部分画笔外观可能变化' }, { extension: 'excalidraw', title: '白板 JSON', description: '导出兼容的白板内容，部分样式可能变化' }],
  diagram: [editable, ...graphics, { extension: 'mmd', title: '图表源码', description: '仅保存源码，不包含预览样式' }],
 }
 return formats[kind]
}
/** Match the native file-name contract, including its UTF-8 byte limit. */
export function saveFileName(stem: string, extension: SaveExtension): string {
 if (!stem || stem !== stem.trim() || stem.startsWith('.') || stem.endsWith('.') || /[\x00-\x1f\x7f-\x9f/\\:<>"|?*]/.test(stem)) throw Error('文件名不能含路径、首尾空格、控制字符或系统保留字符。')
 if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem.split('.')[0]!.trimEnd())) throw Error('此文件名为系统保留名称，请换一个名称。')
 const name = `${stem}.${extension}`
 if (new TextEncoder().encode(name).length > 240) throw Error('文件名过长，请缩短后再保存。')
 return name
}
export type EditorExport = {base64:string; extension:Extension; name?:string; saveAs?:boolean; dirty?:boolean; revision?:string}
export type EditorHandle = {
 /** Commit queued input while retaining the live model and undo history; never export or acknowledge a save. */
 prepareDeactivate():Promise<{documentId:number;revision:number;dirty:boolean}>;
 exportFile(options?:{format?:Extension;background?:boolean}):Promise<EditorExport>;
 markSaved?(base64?:string,options?:{background?:boolean}):void|Promise<void>;
 discardChanges?(options?:{force?:boolean}):void|Promise<void>;
 inspect?():Promise<{documentId:number;revision:number;dirty:boolean}>;
 syncRevision?():Promise<{documentId:number;revision:number;dirty:boolean}>;
 canBackgroundExport?():Promise<boolean>;
 undo?():void|Promise<void>;
 redo?():void|Promise<void>;
 search?(value:string):void|Promise<void>;
 print?():Promise<PrintOutcome>;
}
const supportedExtensions = ['docx','xlsx','csv','tsv','pptx','potx','ppsx','pdf','oonote','owflow','mmd','mermaid','drawio','xml','excalidraw','json'] as const
const workflowImports = ['mmd','mermaid','drawio','xml','excalidraw','json'] as const
export function extensionOf(name:string):Extension {
 const extension=name.split('.').at(-1)?.toLowerCase()
 if(!(supportedExtensions as readonly string[]).includes(extension || ''))throw new Error('请选择受支持的办公文档、笔记本、画布或代码图表文件。其他格式请先转换；宏与加密文件暂不支持。')
 return extension as Extension
}
export function kindOf(extension:Extension):Kind {
 if(extension==='mmd'||extension==='mermaid')return 'diagram'
 if(extension==='owflow'||extension==='svg'||extension==='png'||(workflowImports as readonly string[]).includes(extension))return 'canvas'
 return extension==='oonote'?'note':extension==='pdf'?'pdf':['pptx','potx','ppsx'].includes(extension)?'presentation':['xlsx','csv','tsv'].includes(extension)?'sheet':'word'
}
/** The persisted compatibility envelope serves both visual and source-driven documents. */
export function documentKindOf(bytes:Uint8Array,extension:Extension):Kind {
 validateDocumentSignature(bytes,extension)
 if(extension==='owflow'||extension==='json') {
  const data=readJson(bytes)
  if(data?.format==='open-workflow'&&data.kind==='mermaid')return 'diagram'
 }
 return kindOf(extension)
}
export function isImportOnly(extension:Extension):boolean{return extension==='potx'||extension==='ppsx'||(workflowImports as readonly string[]).includes(extension)}
export function defaultSaveExtension(extension:Extension):SaveExtension {
 if(extension==='csv'||extension==='tsv')return 'xlsx'
 if(extension==='potx'||extension==='ppsx')return 'pptx'
 if((workflowImports as readonly string[]).includes(extension))return 'owflow'
 return extension as SaveExtension
}
function readJson(bytes:Uint8Array):Record<string,unknown>|null {
 try {
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null
 } catch {return null}
}
function validWorkflowHeader(value:Record<string,unknown>|null):boolean {
 if(!value||value.format!=='open-workflow'||value.version!==1||!['flow','board','mermaid'].includes(String(value.kind)))return false
 const scene=value.scene
 return !!scene&&typeof scene==='object'&&!Array.isArray(scene)&&'elements' in scene&&Array.isArray(scene.elements)&&scene.elements.length<=5000&&typeof value.source==='string'&&value.source.length<=500000
}
function validBoardHeader(value:Record<string,unknown>|null):boolean {
 return !!value&&value.type==='excalidraw'&&Array.isArray(value.elements)&&value.elements.length<=5000
}
function textWithoutProlog(text:string):string {
 let result=text.trimStart()
 while(result.startsWith('<?xml')||result.startsWith('<!--')) {
  const closing=result.startsWith('<?xml')?'?>':'-->',end=result.indexOf(closing)
  if(end<0)return ''
  result=result.slice(end+closing.length).trimStart()
 }
 return result
}
function validGraphHeader(text:string):boolean {
 return !/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)&&/^<(?:mxfile|mxGraphModel)(?:\s|\/?>)/.test(textWithoutProlog(text))
}
function validCodeHeader(text:string):boolean {
 const first=text.split(/\r?\n/).map(line=>line.trim()).find(line=>line&&!line.startsWith('%%'))??''
 return /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gitGraph|requirementDiagram|C4Context|architecture(?:-beta)?|pie|gantt|xychart(?:-beta)?|quadrantChart|sankey(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?|mindmap|timeline|journey|kanban|block(?:-beta)?|packet(?:-beta)?)(?:\s|:|;|$)/.test(first)
}
/** Header screening only: the active editor validates the full package
 * before an existing editing session is changed. */
export function validateDocumentSignature(bytes:Uint8Array,extension:Extension):void {
 if(!bytes.length)throw Error('文档为空，无法打开。')
 if(!(supportedExtensions as readonly string[]).includes(extension)&&extension!=='svg'&&extension!=='png')throw Error('此文件格式不受支持，请先转换为 DOCX、XLSX、PPTX 或 PDF。')
 const starts=(signature:number[])=>signature.every((value,index)=>bytes[index]===value)
 let valid=false
 if(extension==='pdf') {
  // ISO 32000 permits readers to locate the header within the first 1024 bytes.
  valid=Array.from(bytes.subarray(0,1024),value=>String.fromCharCode(value)).join('').includes('%PDF-')
 } else if(extension==='oonote') {
  try {
   const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
   valid=!!data&&typeof data==='object'&&'format' in data&&data.format==='open-office-notebook'&&'version' in data&&(data.version===1||data.version===2)&&'sections' in data&&Array.isArray(data.sections)
  } catch {valid=false}
 } else if(extension==='owflow'||extension==='json'||extension==='excalidraw') {
  const data=readJson(bytes)
  valid=bytes.length<=50*1024*1024&&(extension==='owflow'?validWorkflowHeader(data):extension==='excalidraw'?validBoardHeader(data):validWorkflowHeader(data)||validBoardHeader(data))
 } else if(extension==='mmd'||extension==='mermaid'||extension==='drawio'||extension==='xml'||extension==='svg') {
  try {
   const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
   valid=!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)&&(extension==='mmd'||extension==='mermaid'?validCodeHeader(text):extension==='svg'?/^<svg(?:\s|\/?>)/.test(textWithoutProlog(text)):validGraphHeader(text))
  } catch {valid=false}
 } else if(extension==='png') {
  valid=bytes.length>=33&&starts([137,80,78,71,13,10,26,10])&&bytes[12]===73&&bytes[13]===72&&bytes[14]===68&&bytes[15]===82
 } else if(extension==='csv'||extension==='tsv') {
  try { const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);valid=!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text) } catch { valid=false }
 } else valid=bytes.length>=30&&starts([0x50,0x4b,0x03,0x04])
 if(!valid)throw Error(`文件内容与 .${extension} 格式不符，或文件已损坏。请使用原始文档；加密文件请先在原应用解密。`)
}
export function bytesToBase64(bytes:Uint8Array):string {
 const native=bytes as Uint8Array & {toBase64?:()=>string}
 if(typeof native.toBase64==='function')return native.toBase64()
 // Encode whole groups of three bytes. No full-size binary string is retained
 // alongside the document and its base64 copy, including on older WebKit.
 const parts:string[]=[]
 for(let i=0;i<bytes.length;i+=24576)parts.push(btoa(String.fromCharCode(...bytes.subarray(i,i+24576))))
 return parts.join('')
}
export function base64ToBytes(base64:string):Uint8Array {
 // Keep atob's whitespace / unpadded-input contract, but decode in bounded
 // chunks instead of allocating another document-sized binary string.
 const input=base64.replace(/[\t\n\f\r ]/g,'')
 if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input)||input.length%4===1||(input.includes('=')&&input.length%4!==0))throw Error('文档编码无效。')
 const native=Uint8Array as typeof Uint8Array & {fromBase64?:(value:string)=>Uint8Array}
 if(typeof native.fromBase64==='function')return native.fromBase64(input)
 const padding=input.endsWith('==')?2:input.endsWith('=')?1:0
 const bytes=new Uint8Array(Math.floor(input.length*3/4)-padding)
 let offset=0
 for(let i=0;i<input.length;i+=32768){const chunk=atob(input.slice(i,i+32768));for(let j=0;j<chunk.length;j++)bytes[offset++]=chunk.charCodeAt(j)}
 return bytes
}
export function sizeLabel(bytes:number):string{return bytes<1024?'不到 1 KB':bytes<1024*1024?`${Math.round(bytes/1024)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`}
export function withExtension(name:string,extension:Extension):string{return `${name.replace(/\.[^.]+$/,'')}.${extension}`}
