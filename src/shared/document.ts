export type Kind = 'word'|'sheet'|'presentation'|'pdf'
export type Extension = 'docx'|'odt'|'doc'|'rtf'|'xlsx'|'ods'|'xls'|'pptx'|'odp'|'ppt'|'pdf'
export type SaveExtension = Exclude<Extension,'doc'|'rtf'|'xls'|'ppt'>
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
 if(!['docx','odt','doc','rtf','xlsx','ods','xls','pptx','odp','ppt','pdf'].includes(extension || ''))throw new Error('请选择 DOCX、ODT、DOC、RTF、XLSX、ODS、XLS、PPTX、ODP、PPT 或 PDF 文件。宏、加密文件及其他格式暂不支持。')
 return extension as Extension
}
export function kindOf(extension:Extension):Kind{return extension==='pdf'?'pdf':['pptx','odp','ppt'].includes(extension)?'presentation':['xlsx','ods','xls'].includes(extension)?'sheet':'word'}
export function isImportOnly(extension:Extension):boolean{return ['doc','rtf','xls','ppt'].includes(extension)}
export function defaultSaveExtension(extension:Extension):SaveExtension {
 if(extension==='doc'||extension==='rtf')return 'docx'
 if(extension==='xls')return 'xlsx'
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
export function bytesToBase64(bytes:Uint8Array):string{let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value)}
export function base64ToBytes(base64:string):Uint8Array{const value=atob(base64);return Uint8Array.from(value,c=>c.charCodeAt(0))}
export function sizeLabel(bytes:number):string{return bytes<1024?'不到 1 KB':bytes<1024*1024?`${Math.round(bytes/1024)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`}
export function withExtension(name:string,extension:Extension):string{return `${name.replace(/\.[^.]+$/,'')}.${extension}`}
