import { Inflate } from 'fflate'
import { inspectPptxZip } from '../presentation/pptx-package.ts'

/** Repair only current-export OLE container labels. No source archive, object
 * activation, payload conversion or recovery of removed objects is possible. */
export const DOCX_EMBEDDED_LIMITS = Object.freeze({ inputBytes:40*1024*1024, outputBytes:64*1024*1024, xmlBytes:8*1024*1024, totalXmlBytes:24*1024*1024, expandedBytes:128*1024*1024, nodes:400000, depth:128, timeMs:4000 })
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main'])
const O = 'urn:schemas-microsoft-com:office:office'
const R = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships','http://purl.oclc.org/ooxml/officeDocument/relationships'])
const REL = new Set(['http://schemas.openxmlformats.org/package/2006/relationships','http://purl.oclc.org/ooxml/package/relationships'])
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const OLE = 'application/vnd.openxmlformats-officedocument.oleObject'
const known:Record<string,{extension:string;mime:string}> = {
  'Word.Document.12':{extension:'docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
  'Excel.Sheet.12':{extension:'xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  'PowerPoint.Show.12':{extension:'pptx',mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation'},
}
const stories:Record<string,string> = { officeDocument:'document',header:'hdr',footer:'ftr',footnotes:'footnotes',endnotes:'endnotes',comments:'comments' }
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true})
type Entry=ReturnType<typeof inspectPptxZip>['entries'][number]
type Attr={local:string;uri:string;value:string;start:number;end:number}
type Node={name:string;local:string;uri:string;attrs:Attr[];namespaces:Map<string,string>;start:number;end:number;close:number;selfClosing:boolean}
type Edit={start:number;end:number;value:string}
type Relation={id:string;type:Attr;target:Attr;part:string|null;external:boolean;source:string;file:string}
function requireValue(value:unknown,detail='包结构或引用不完整'):asserts value { if(!value)throw Error(`DOCX 附件保护：${detail}，已停止保存；原文件未修改。`) }
const attr=(node:Node,local:string,uri='')=>node.attrs.find(a=>a.local===local&&a.uri===uri)
const relKind=(type:string)=>[...R].flatMap(uri=>type.startsWith(uri+'/')?[type.slice(uri.length+1)]:[])[0]
function xmlText(value:string):string {
  requireValue(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value),'XML 实体无效')
  return value.replace(/&([^;]+);/g,(_,name:string)=>{
    const base:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(name in base)return base[name]!
    const n=name.startsWith('#x')?parseInt(name.slice(2),16):Number(name.slice(1))
    requireValue(Number.isInteger(n)&&(n===9||n===10||n===13||(n>=32&&n<=0xd7ff)||(n>=0xe000&&n<=0xfffd)||(n>=0x10000&&n<=0x10ffff)),'XML 字符无效');return String.fromCodePoint(n)
  })
}
const partUri=(value:string)=>'/'+value.split('/').map(part=>encodeURIComponent(part)).join('/')
const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')
/** Namespace-aware, bounded SAX with exact attribute spans. Unknown declarations
 * and malformed XML fail closed. No DOM serialization rewrites unrelated XML. */
function walk(source:string,visit:(node:Node,parents:Node[])=>void,check:()=>void):Node {
  requireValue(!/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(source),'XML 字符无效')
  const stack:Node[]=[],qname=/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/
  let i=0,count=0,root:Node|undefined
  while(i<source.length) {
    if(++count%256===0)check();requireValue(count<=DOCX_EMBEDDED_LIMITS.nodes,'XML 节点过多')
    if(source[i]!=='<') {let end=source.indexOf('<',i);if(end<0)end=source.length;const value=source.slice(i,end);xmlText(value);requireValue(stack.length||!value.trim().replace(/^\uFEFF/,''),'XML 根节点外有内容');i=end;continue}
    if(source.startsWith('<!--',i)){const end=source.indexOf('-->',i+4);requireValue(end>=0&&!source.slice(i+4,end).includes('--'));i=end+3;continue}
    if(source.startsWith('<![CDATA[',i)){const end=source.indexOf(']]>',i+9);requireValue(end>=0&&stack.length);i=end+3;continue}
    if(source.startsWith('<?',i)){const end=source.indexOf('?>',i+2);requireValue(end>=0);i=end+2;continue}
    requireValue(!source.startsWith('<!',i),'不允许 XML 声明或外部实体')
    const start=i;let end=i+1,quote=''
    for(;end<source.length;end++){const c=source[end]!;if(quote){if(c===quote)quote=''}else if(c==='"'||c==="'")quote=c;else if(c==='>')break}
    requireValue(end<source.length);const token=source.slice(i+1,end);i=end+1
    if(token.startsWith('/')){const node=stack.pop();requireValue(node&&token.slice(1).trim()===node.name);node.close=start;continue}
    const match=qname.exec(token);requireValue(match);const name=match[0],selfClosing=/\/\s*$/.test(token),body=token.slice(name.length).replace(/\/\s*$/,'')
    const raw:Array<{name:string;value:string;start:number;end:number}>=[],seen=new Set<string>();let cursor=0
    while(cursor<body.length){if(++count%256===0)check();requireValue(count<=DOCX_EMBEDDED_LIMITS.nodes,'XML 属性过多');const space=/^\s+/.exec(body.slice(cursor));requireValue(space);cursor+=space[0].length;if(cursor===body.length)break
      const entry=/^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*(["'])([\s\S]*?)\2/.exec(body.slice(cursor));requireValue(entry&&!seen.has(entry[1]!));requireValue(!entry[3]!.includes('<'))
      const offset=start+1+name.length+cursor+entry[0].indexOf(entry[2]!)+1;seen.add(entry[1]!);raw.push({name:entry[1]!,value:xmlText(entry[3]!),start:offset,end:offset+entry[3]!.length});cursor+=entry[0].length
    }
    const namespaces=new Map(stack.at(-1)?.namespaces||[['xml','http://www.w3.org/XML/1998/namespace']])
    for(const a of raw)if(a.name==='xmlns')namespaces.set('',a.value);else if(a.name.startsWith('xmlns:')){const prefix=a.name.slice(6);requireValue(prefix!=='xmlns'&&(prefix!=='xml'||a.value==='http://www.w3.org/XML/1998/namespace'));namespaces.set(prefix,a.value)}
    const resolve=(n:string,isAttr=false)=>{const pieces=n.split(':'),prefix=pieces.length===2?pieces[0]!:'';if(prefix)requireValue(namespaces.get(prefix),'XML 前缀未绑定');return{local:pieces.at(-1)!,uri:prefix||!isAttr?namespaces.get(prefix)||'':''}}
    const attrs=raw.filter(a=>a.name!=='xmlns'&&!a.name.startsWith('xmlns:')).map(a=>({...resolve(a.name,true),value:a.value,start:a.start,end:a.end}));const expanded=new Set<string>();for(const a of attrs){const key=a.uri+'\0'+a.local;requireValue(!expanded.has(key),'XML 属性重复');expanded.add(key)}
    const node:Node={name,...resolve(name),attrs,namespaces,start,end:i,close:selfClosing?start:-1,selfClosing};requireValue(stack.length<DOCX_EMBEDDED_LIMITS.depth,'XML 嵌套过深')
    if(!stack.length){requireValue(!root);root=node}visit(node,stack);if(!selfClosing)stack.push(node)
  }
  requireValue(root&&stack.length===0);check();return root
}
function resolvePart(base:string,target:string):string {
  requireValue(target&&!/[\\\x00-\x20:#?]/.test(target),'附件路径无效')
  // OPC target escaping is decoded once. Encoded separators/dots/percent are
  // ambiguous between literal ZIP names and URI resolution, so reject them.
  requireValue(!/%(?:2f|5c|2e|25)/i.test(target),'附件路径编码不明确')
  let decoded:string;try{decoded=decodeURIComponent(target)}catch{throw Error('DOCX 附件保护：附件路径编码无效，已停止保存。')}
  requireValue(!/[\\\x00-\x20:#?%]/.test(decoded),'附件路径无效')
  const parts=decoded.startsWith('/')?[]:base.split('/').slice(0,-1)
  for(const part of decoded.replace(/^\//,'').split('/')){if(part==='..'){requireValue(parts.length);parts.pop()}else if(part!=='.'){requireValue(part);parts.push(part)}}return parts.join('/')
}
const sourceFor=(name:string)=>name==='_rels/.rels'?'':name.replace(/(^|\/)\_rels\/([^/]+)\.rels$/,'$1$2')
const crcTable=Uint32Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0})
function crc(bytes:Uint8Array){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]!^(n>>>8);return(n^0xffffffff)>>>0}
function packageBytes(entries:Entry[]):Uint8Array {
  const names=entries.map(e=>encoder.encode(e.name)),total=entries.reduce((n,e,i)=>n+76+names[i]!.length*2+e.compressed.length,22)
  requireValue(total<=DOCX_EMBEDDED_LIMITS.outputBytes,'输出包过大');const bytes=new Uint8Array(total),v=new DataView(bytes.buffer),positions:number[]=[];let cursor=0
  for(const [i,e]of entries.entries()){const n=names[i]!;positions.push(cursor);v.setUint32(cursor,0x04034b50,true);v.setUint16(cursor+4,20,true);v.setUint16(cursor+6,0x800,true);v.setUint16(cursor+8,e.method,true);v.setUint16(cursor+10,e.time,true);v.setUint16(cursor+12,e.date,true);v.setUint32(cursor+14,e.crc,true);v.setUint32(cursor+18,e.compressed.length,true);v.setUint32(cursor+22,e.size,true);v.setUint16(cursor+26,n.length,true);bytes.set(n,cursor+30);bytes.set(e.compressed,cursor+30+n.length);cursor+=30+n.length+e.compressed.length}
  const directory=cursor
  for(const [i,e]of entries.entries()){const n=names[i]!;v.setUint32(cursor,0x02014b50,true);v.setUint16(cursor+4,0x314,true);v.setUint16(cursor+6,20,true);v.setUint16(cursor+8,0x800,true);v.setUint16(cursor+10,e.method,true);v.setUint16(cursor+12,e.time,true);v.setUint16(cursor+14,e.date,true);v.setUint32(cursor+16,e.crc,true);v.setUint32(cursor+20,e.compressed.length,true);v.setUint32(cursor+24,e.size,true);v.setUint16(cursor+28,n.length,true);v.setUint32(cursor+38,e.attrs,true);v.setUint32(cursor+42,positions[i]!,true);bytes.set(n,cursor+46);cursor+=46+n.length}
  v.setUint32(cursor,0x06054b50,true);v.setUint16(cursor+8,entries.length,true);v.setUint16(cursor+10,entries.length,true);v.setUint32(cursor+12,cursor-directory,true);v.setUint32(cursor+16,directory,true);return bytes
}
function applyEdits(source:string,edits:Edit[]):string {let end=source.length,result='';for(const edit of edits.sort((a,b)=>b.start-a.start)){requireValue(edit.end<=end&&edit.start<=edit.end,'XML 修改范围冲突');result=edit.value+source.slice(edit.end,end)+result;end=edit.start}return source.slice(0,end)+result}

export function normalizeDocxEmbeddedContainers(input:Uint8Array):{bytes:Uint8Array;normalized:number} {
  const deadline=Date.now()+DOCX_EMBEDDED_LIMITS.timeMs,check=()=>requireValue(Date.now()<=deadline,'检查超时')
  requireValue(input.length<=DOCX_EMBEDDED_LIMITS.inputBytes,'文档超过附件检查大小限制')
  const inspected=inspectPptxZip(input);requireValue(inspected.expandedBytes<=DOCX_EMBEDDED_LIMITS.expandedBytes,'文档展开后过大')
  const entries=new Map(inspected.entries.map(e=>[e.name,e])),texts=new Map<string,string>(),relations:Relation[]=[],bySource=new Map<string,Map<string,Relation>>()
  let totalXml=0
  const read=(name:string,xml=false)=>{
    const e=entries.get(name);requireValue(e,'附件引用的文件不存在');if(xml){requireValue(e.size<=DOCX_EMBEDDED_LIMITS.xmlBytes,'XML 过大');totalXml+=e.size;requireValue(totalXml<=DOCX_EMBEDDED_LIMITS.totalXmlBytes,'XML 总量过大')}
    let bytes:Uint8Array
    if(e.method===0)bytes=e.compressed;else{bytes=new Uint8Array(e.size);let size=0;const inflate=new Inflate(chunk=>{size+=chunk.length;requireValue(size<=e.size,'ZIP 实际展开大小不符');bytes.set(chunk,size-chunk.length)});for(let i=0;i<e.compressed.length;i+=256){check();inflate.push(e.compressed.subarray(i,i+256),i+256>=e.compressed.length)}requireValue(size===e.size)}
    requireValue(bytes.length===e.size&&crc(bytes)===e.crc,'ZIP 校验失败');check();return bytes
  }
  const xml=(name:string)=>{if(!texts.has(name))texts.set(name,decoder.decode(read(name,true)));return texts.get(name)!}
  for(const name of entries.keys())if(name.endsWith('.rels')){
    requireValue(name==='_rels/.rels'||/(^|\/)\_rels\/[^/]+\.rels$/.test(name),'关系文件位置不明确');const source=sourceFor(name);requireValue(!source||entries.has(source),'关系来源不存在');const map=new Map<string,Relation>();bySource.set(source,map)
    walk(xml(name),(node,parents)=>{
      if(!parents.length)requireValue(node.local==='Relationships'&&REL.has(node.uri),'关系根节点无效')
      if(parents.length!==1||node.local!=='Relationship'||!REL.has(node.uri))return
      const id=attr(node,'Id')?.value,type=attr(node,'Type'),target=attr(node,'Target'),mode=attr(node,'TargetMode')?.value
      requireValue(id&&type?.value&&target?.value&&!map.has(id),'关系 ID 重复或缺失');requireValue(!mode||mode==='Internal'||mode==='External','关系模式不明确')
      const external=mode==='External',link:Relation={id,type,target,external,source,file:name,part:external?null:resolvePart(source,target.value)};map.set(id,link);relations.push(link)
    },check)
  }
  const rootLinks=[...(bySource.get('')?.values()||[])].filter(r=>relKind(r.type.value)==='officeDocument'&&!r.external);requireValue(rootLinks.length===1&&rootLinks[0]!.part,'Word 主文档引用不明确')
  const queue=[{part:rootLinks[0]!.part!,kind:'officeDocument'}],seen=new Set<string>(),uses=new Map<Relation,{all:number;eligible:number;progs:Set<string>}>()
  for(let index=0;index<queue.length;index++){
    const {part,kind}=queue[index]!;if(seen.has(part))continue;seen.add(part);const links=bySource.get(part)||new Map<string,Relation>()
    walk(xml(part),(node,parents)=>{
      if(!parents.length)requireValue(W.has(node.uri)&&node.local===stories[kind],'Word 故事节点类型不符')
      for(const a of node.attrs)if(R.has(a.uri)){const rel=links.get(a.value);if(rel){const value=uses.get(rel)||{all:0,eligible:0,progs:new Set<string>()};value.all++;uses.set(rel,value)}}
      const parent=parents.at(-1),modern=W.has(node.uri)&&node.local==='objectEmbed'&&parent?.uri===node.uri&&parent.local==='object',legacy=node.uri===O&&node.local==='OLEObject'&&parent&&W.has(parent.uri)&&parent.local==='object'
      if(!modern&&!legacy)return
      if(legacy&&attr(node,'Type')?.value==='Link')return
      const qualified=modern?attr(node,'progId',node.uri):undefined,plain=attr(node,modern?'progId':'ProgID');requireValue(!qualified||!plain||qualified.value===plain.value,'对象类型属性冲突')
      const prog=(qualified||plain)?.value;if(!prog||!known[prog])return
      if(legacy)requireValue(!attr(node,'Type')||attr(node,'Type')!.value==='Embed','OLE 对象类型不明确')
      const ids=node.attrs.filter(a=>a.local==='id'&&R.has(a.uri));requireValue(ids.length===1,'对象关系缺失或冲突');const rel=links.get(ids[0]!.value);requireValue(rel,'对象关系不存在');if(rel.external)return
      requireValue(rel.part&&entries.has(rel.part),'对象负载不存在');requireValue(['package','oleObject'].includes(relKind(rel.type.value)||''),'对象关系类型不明确')
      const value=uses.get(rel)!;value.eligible++;value.progs.add(prog)
    },check)
    for(const rel of links.values()){const next=relKind(rel.type.value);if(next&&next!=='officeDocument'&&stories[next]&&!rel.external){requireValue(rel.part);queue.push({part:rel.part,kind:next})}}
  }
  // Parse content types before planning; individual overrides are changed, never
  // the global docx/xlsx/pptx defaults used by unrelated parts.
  const overrides=new Map<string,{part:Attr;type:Attr}>(),defaults=new Map<string,string>();const typeSource=xml('[Content_Types].xml')
  const typeRoot=walk(typeSource,(node,parents)=>{
    if(!parents.length)requireValue(node.local==='Types'&&node.uri===CT,'内容类型根节点无效')
    if(parents.length!==1||node.uri!==CT)return
    if(node.local==='Override'){const part=attr(node,'PartName'),type=attr(node,'ContentType');requireValue(part&&part.value.startsWith('/')&&type?.value);const name=resolvePart('',part.value);requireValue(!overrides.has(name),'内容类型重复');overrides.set(name,{part,type})}
    if(node.local==='Default'){const extension=attr(node,'Extension')?.value.toLowerCase(),type=attr(node,'ContentType')?.value;requireValue(extension&&type&&!defaults.has(extension),'默认内容类型重复');defaults.set(extension,type)}
  },check)
  const candidates=new Map<string,{destination:string;progs:Set<string>}>()
  for(const [rel,use]of uses){if(!use.eligible||rel.external)continue;const part=rel.part!;if(candidates.has(part))continue
    const payload=read(part),magic=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];if(!magic.every((b,i)=>payload[i]===b))continue
    const view=new DataView(payload.buffer,payload.byteOffset,payload.byteLength)
    requireValue(payload.length>=512&&view.getUint16(28,true)===0xfffe&&[3,4].includes(view.getUint16(26,true))&&view.getUint16(30,true)===(view.getUint16(26,true)===3?9:12)&&payload.length%(2**view.getUint16(30,true))===0,'CFB 容器头不完整')
    if(relKind(rel.type.value)==='oleObject'&&part.toLowerCase().endsWith('.bin'))continue
    requireValue(use.progs.size===1,'共享附件的对象类型不一致');const spec=known[[...use.progs][0]!]!
    requireValue(relKind(rel.type.value)==='package'&&part.endsWith('.'+spec.extension),'CFB 负载的对象类型与扩展名不匹配')
    requireValue((overrides.get(part)?.type.value||defaults.get(spec.extension))===spec.mime,'CFB 负载的现有类型不明确')
    const destination=part.slice(0,-spec.extension.length)+'bin';requireValue(![...entries.keys(),...overrides.keys(),...[...candidates.values()].map(c=>c.destination)].some(name=>name.toLowerCase()===destination.toLowerCase()),'附件改名与已有文件或类型记录冲突')
    candidates.set(part,{destination,progs:use.progs})
  }
  if(!candidates.size)return{bytes:input,normalized:0}
  requireValue(![...entries.keys()].some(name=>/^_xmlsignatures\//i.test(name))&&!relations.some(r=>r.type.value.includes('/digital-signature/')),'带数字签名的包不能修改附件标注')
  const edits=new Map<string,Edit[]>(),add=(name:string,edit:Edit)=>{const values=edits.get(name)||[];values.push(edit);edits.set(name,values)}
  for(const [part,plan]of candidates){
    requireValue(!bySource.has(part),'附件包含自身关系，不能安全改名');const shared=relations.filter(r=>r.part===part);requireValue(shared.length,'附件没有有效引用')
    for(const rel of shared){const use=uses.get(rel);requireValue(use&&use.all===use.eligible&&use.eligible>0&&use.progs.size===1&&[...use.progs][0]===[...plan.progs][0]&&relKind(rel.type.value)==='package','附件由不明确的关系或对象共享')
      const target=rel.target.value;requireValue(/\.(docx|xlsx|pptx)$/.test(target),'附件目标扩展名不明确');add(rel.file,{...rel.target,value:escape(target.replace(/\.[^.]+$/,'.bin'))});add(rel.file,{...rel.type,value:escape(rel.type.value.replace(/\/package$/,'/oleObject'))})
    }
    // A relative External link sharing the literal local destination is not
    // guessed to be internal. Stop rather than quietly changing its meaning.
    for(const rel of relations.filter(r=>r.external&&!/^[a-z][a-z\d+.-]*:/i.test(r.target.value))){let target:string;try{target=resolvePart(rel.source,rel.target.value)}catch{continue}requireValue(target!==part,'附件同时被外部关系引用')}
    const current=overrides.get(part)
    if(current){add('[Content_Types].xml',{...current.part,value:escape(partUri(plan.destination))});add('[Content_Types].xml',{...current.type,value:OLE})}
    else{requireValue(!typeRoot.selfClosing&&typeRoot.close>=0);const prefix=typeRoot.name.includes(':')?typeRoot.name.split(':')[0]+':':'';add('[Content_Types].xml',{start:typeRoot.close,end:typeRoot.close,value:`<${prefix}Override PartName="${escape(partUri(plan.destination))}" ContentType="${OLE}"/>`})}
  }
  // Nothing observable is mutated before all relationships, payloads and edits
  // pass. Entries retain original compressed bytes unless their XML is changed.
  const output=inspected.entries.map(entry=>{
    const name=candidates.get(entry.name)?.destination||entry.name,changes=edits.get(entry.name);if(!changes)return{...entry,name}
    const bytes=encoder.encode(applyEdits(xml(entry.name),changes));return{...entry,name,method:0 as const,compressed:bytes,size:bytes.length,crc:crc(bytes)}
  });check();return{bytes:packageBytes(output),normalized:candidates.size}
}
