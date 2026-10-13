export type Kind = 'word'|'sheet'|'presentation'|'pdf'
export type Extension = 'docx'|'odt'|'xlsx'|'ods'|'pptx'|'odp'|'pdf'
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
 if(!['docx','odt','xlsx','ods','pptx','odp','pdf'].includes(extension || ''))throw new Error('请选择 DOCX、ODT、XLSX、ODS、PPTX、ODP 或 PDF 文件。旧版 DOC/XLS/PPT 请先转换格式。')
 return extension as Extension
}
export function kindOf(extension:Extension):Kind{return extension==='pdf'?'pdf':extension==='pptx'||extension==='odp'?'presentation':extension==='xlsx'||extension==='ods'?'sheet':'word'}
export function bytesToBase64(bytes:Uint8Array):string{let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value)}
export function base64ToBytes(base64:string):Uint8Array{const value=atob(base64);return Uint8Array.from(value,c=>c.charCodeAt(0))}
export function sizeLabel(bytes:number):string{return bytes<1024?'不到 1 KB':bytes<1024*1024?`${Math.round(bytes/1024)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`}
export function withExtension(name:string,extension:Extension):string{return `${name.replace(/\.[^.]+$/,'')}.${extension}`}
