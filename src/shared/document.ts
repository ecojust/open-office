export type Kind = 'word'|'sheet'|'presentation'|'pdf'
export type Extension = 'docx'|'odt'|'doc'|'rtf'|'xlsx'|'ods'|'xls'|'csv'|'tsv'|'pptx'|'odp'|'ppt'|'pdf'
export type SaveExtension = Exclude<Extension,'doc'|'rtf'|'xls'|'ppt'>
export type SaveFormatOption = { extension: SaveExtension; title: string; description: string }
/** Formats actually implemented by each active editor, not all import formats. */
export function saveFormats(kind: Kind): SaveFormatOption[] {
 const pdf: SaveFormatOption = { extension: 'pdf', title: 'PDF 文档', description: '用于阅读、打印与分享' }
 const formats: Record<Kind, SaveFormatOption[]> = {
  word: [{ extension: 'docx', title: 'DOCX 文档', description: '保留可编辑的文字、表格和排版' }, { extension: 'odt', title: 'ODT 文档', description: '开放文档格式，可继续编辑' }, pdf],
  sheet: [{ extension: 'xlsx', title: 'XLSX 工作簿', description: '保留工作表、公式和单元格格式' }, { extension: 'ods', title: 'ODS 工作簿', description: '开放工作簿格式，可继续编辑' }, pdf],
  presentation: [{ extension: 'pptx', title: 'PPTX 演示文稿', description: '保留可编辑的幻灯片与对象' }, { ...pdf, description: '静态页面，不包含放映动画与音视频' }],
  pdf: [pdf],
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
export type EditorExport = {base64:string; extension:Extension; name?:string; saveAs?:boolean; dirty?:boolean}
export type EditorHandle = {
 exportFile(options?:{format?:Extension}):Promise<EditorExport>;
 markSaved?(base64?:string):void|Promise<void>;
 discardChanges?(options?:{force?:boolean}):void|Promise<void>;
 undo?():void|Promise<void>;
 redo?():void|Promise<void>;
 search?(value:string):void|Promise<void>;
 print?():void|Promise<void>;
}
export function extensionOf(name:string):Extension {
 const extension=name.split('.').at(-1)?.toLowerCase()
 if(!['docx','odt','doc','rtf','xlsx','ods','xls','csv','tsv','pptx','odp','ppt','pdf'].includes(extension || ''))throw new Error('请选择 DOCX、ODT、DOC、RTF、XLSX、ODS、XLS、CSV、TSV、PPTX、ODP、PPT 或 PDF 文件。宏、加密文件及其他格式暂不支持。')
 return extension as Extension
}
export function kindOf(extension:Extension):Kind{return extension==='pdf'?'pdf':['pptx','odp','ppt'].includes(extension)?'presentation':['xlsx','ods','xls','csv','tsv'].includes(extension)?'sheet':'word'}
export function isImportOnly(extension:Extension):boolean{return ['doc','rtf','xls','ppt'].includes(extension)}
export function defaultSaveExtension(extension:Extension):SaveExtension {
 if(extension==='doc'||extension==='rtf')return 'docx'
 if(extension==='xls'||extension==='csv'||extension==='tsv')return 'xlsx'
 if(extension==='ppt')return 'pptx'
 return extension
}
/** Header screening only: the local Office engine also verifies the actual document
 * service after parsing. This does not claim an OLE or ZIP payload is well formed. */
export function validateDocumentSignature(bytes:Uint8Array,extension:Extension):void {
 if(!bytes.length)throw Error('文档为空，无法打开。')
 const starts=(signature:number[])=>signature.every((value,index)=>bytes[index]===value)
 let valid=false
 if(extension==='pdf') {
  // ISO 32000 permits readers to locate the header within the first 1024 bytes.
  valid=Array.from(bytes.subarray(0,1024),value=>String.fromCharCode(value)).join('').includes('%PDF-')
 } else if(extension==='csv'||extension==='tsv') {
  try { const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);valid=!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text) } catch { valid=false }
 } else if(extension==='rtf') {
  const prefix=Array.from(bytes.subarray(0,32),value=>String.fromCharCode(value)).join('')
  valid=/^\{\\rtf[1-9]\d*(?=[\\\s])/.test(prefix)
 } else if(['doc','xls','ppt'].includes(extension)) {
  if(bytes.length>=512&&starts([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])) {
   const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),major=view.getUint16(26,true),sector=view.getUint16(30,true)
   valid=view.getUint16(28,true)===0xfffe&&view.getUint16(32,true)===6&&((major===3&&sector===9)||(major===4&&sector===12))
  }
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
