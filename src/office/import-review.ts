import { Inflate } from 'fflate'
import { inspectPptxZip } from '../presentation/pptx-package.ts'
import { base64ToBytes } from '../shared/document.ts'

export interface ImportReview { complete:boolean; requiresSaveAs:boolean; warnings:string[] }
export const IMPORT_REVIEW_LIMITS = Object.freeze({ inputBytes:40*1024*1024, xmlBytes:8*1024*1024, totalXmlBytes:24*1024*1024, xmlNodes:400000, depth:128, timeMs:2000 })
const S = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'])
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
const O = 'urn:schemas-microsoft-com:office:office'
const REL = new Set(['http://schemas.openxmlformats.org/package/2006/relationships', 'http://purl.oclc.org/ooxml/package/relationships'])
const DOC_REL = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'])
const decoder = new TextDecoder('utf-8', { fatal:true })
type Attribute = { local:string; uri:string; value:string }
type XmlNode = { name:string; local:string; uri:string; attrs:Attribute[]; namespaces:Map<string,string> }
const attribute = (node:XmlNode, local:string, namespaces?:Set<string>) => node.attrs.find(value=>value.local===local&&(namespaces?namespaces.has(value.uri):value.uri===''))?.value
function fail():never { throw Error('Office import review could not finish safely') }
function requireValue(value:unknown):asserts value { if(!value)fail() }

function decodeXml(value:string):string {
  return value.replace(/&([^;\s<&]+);/g, (_, entity:string)=>{
    const predefined:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}
    if(entity in predefined)return predefined[entity]!
    const code=entity.startsWith('#x')?parseInt(entity.slice(2),16):entity.startsWith('#')?Number(entity.slice(1)):NaN
    requireValue(Number.isInteger(code)&&(code===9||code===10||code===13||(code>=0x20&&code<=0xd7ff)||(code>=0xe000&&code<=0xfffd)||(code>=0x10000&&code<=0x10ffff)))
    return String.fromCodePoint(code)
  })
}

/** Small, bounded, namespace-aware SAX reader. It never resolves declarations or
 * external entities. Unknown/malformed XML produces an incomplete review, not a
 * false claim that the targeted preservation risks are absent. */
function walkXml(source:string, visit:{start?(node:XmlNode,parents:XmlNode[]):void;end?(node:XmlNode,parents:XmlNode[]):void;text?(value:string,parents:XmlNode[]):void}, checkBudget:()=>void=()=>{}) {
  requireValue(!/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(source))
  checkBudget()
  const stack:XmlNode[]=[], name=/^[A-Za-z_][\w.:-]*/
  let index=0,nodes=0,roots=0
  while(index<source.length) {
    if(source[index]!=='<') {
      const stop=source.indexOf('<',index),text=source.slice(index,stop<0?source.length:stop)
      requireValue(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text))
      if(!stack.length)requireValue(!text.trim().replace(/^\uFEFF/,''))
      else visit.text?.(decodeXml(text),stack)
      index=stop<0?source.length:stop;continue
    }
    if(source.startsWith('<!--',index)) {const stop=source.indexOf('-->',index+4);requireValue(stop>=0);index=stop+3;continue}
    if(source.startsWith('<![CDATA[',index)) {const stop=source.indexOf(']]>',index+9);requireValue(stop>=0&&stack.length);visit.text?.(source.slice(index+9,stop),stack);index=stop+3;continue}
    if(source.startsWith('<?',index)) {const stop=source.indexOf('?>',index+2);requireValue(stop>=0);index=stop+2;continue}
    requireValue(!source.startsWith('<!',index))
    let stop=index+1,quote=''
    for(;stop<source.length;stop++) {
      const char=source[stop]!
      if(quote) {if(char===quote)quote=''}
      else if(char==='"'||char==="'")quote=char
      else if(char==='>')break
    }
    requireValue(stop<source.length)
    const token=source.slice(index+1,stop);index=stop+1
    if(token.startsWith('/')) {
      const closing=token.slice(1).trim(),node=stack.pop()
      requireValue(node&&closing===node.name);visit.end?.(node,stack);continue
    }
    const match=name.exec(token);requireValue(match)
    const rawName=match[0],attrs:Array<[string,string]>=[],seen=new Set<string>(),selfClosing=/\/\s*$/.test(token)
    const body=token.slice(rawName.length).replace(/\/\s*$/,'')
    let cursor=0
    while(cursor<body.length) {
      const space=/^\s+/.exec(body.slice(cursor));requireValue(space);cursor+=space[0].length
      if(cursor===body.length)break
      const entry=/^([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(body.slice(cursor));requireValue(entry&&!seen.has(entry[1]!))
      requireValue(!entry[3]!.includes('<')&&!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(entry[3]!))
      seen.add(entry[1]!);attrs.push([entry[1]!,decodeXml(entry[3]!)]);cursor+=entry[0].length
    }
    const namespaces=new Map(stack.at(-1)?.namespaces||[['xml','http://www.w3.org/XML/1998/namespace']])
    for(const [key,value] of attrs)if(key==='xmlns')namespaces.set('',value);else if(key.startsWith('xmlns:'))namespaces.set(key.slice(6),value)
    const resolve=(key:string,isAttribute=false)=>{const parts=key.split(':');requireValue(parts.length<=2);const prefix=parts.length===2?parts[0]!:'',local=parts.at(-1)!;if(prefix)requireValue(namespaces.has(prefix));return{local,uri:prefix||!isAttribute?namespaces.get(prefix)||'':''}}
    const node:XmlNode={name:rawName,...resolve(rawName),namespaces,attrs:attrs.filter(([key])=>key!=='xmlns'&&!key.startsWith('xmlns:')).map(([key,value])=>({...resolve(key,true),value}))}
    requireValue(++nodes<=IMPORT_REVIEW_LIMITS.xmlNodes&&stack.length<IMPORT_REVIEW_LIMITS.depth)
    if(nodes%256===0)checkBudget()
    if(!stack.length)requireValue(++roots===1)
    visit.start?.(node,stack)
    if(selfClosing)visit.end?.(node,stack);else stack.push(node)
  }
  requireValue(roots===1&&stack.length===0)
}

function resolvePart(base:string,target:string) {
  requireValue(target&&!/[\\\x00-\x20:#?]/.test(target))
  const parts=target.startsWith('/')?[]:base.split('/').slice(0,-1)
  for(const part of target.replace(/^\//,'').split('/')) {
    if(part==='..'){requireValue(parts.length);parts.pop()}
    else if(part!=='.'){requireValue(part);parts.push(part)}
  }
  return parts.join('/')
}
const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0})
function crc32(bytes:Uint8Array){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]!^(value>>>8);return(value^0xffffffff)>>>0}
function cellPosition(address:string) {
  const match=/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/.exec(address);requireValue(match)
  let column=0;for(const character of match[1]!)column=column*26+character.charCodeAt(0)-64
  const row=Number(match[2]);requireValue(column<=16384&&row<=1048576)
  return{column,row}
}

/** Inspect formula tokens, never cached values or displayed text. Quoted text,
 * sheet names and structured-reference fields may all contain `UNIQUE(`. */
function callsUnique(formula:string,checkBudget:()=>void):boolean {
  const identifier=/[\p{L}\p{N}\p{M}_.\\]/u
  let index=0,previous=''
  while(index<formula.length) {
    if(index%4096===0)checkBudget()
    const char=formula[index]!
    if(char==='"'||char==="'") {
      const quote=char;index++
      while(index<formula.length) {
        if(index%4096===0)checkBudget()
        if(formula[index++]!==quote)continue
        if(formula[index]===quote){index++;continue}
        break
      }
      previous=quote;continue
    }
    if(char==='[') {
      let depth=1;index++
      while(index<formula.length&&depth) {
        if(index%4096===0)checkBudget()
        const next=formula[index++]!
        // Excel escapes special structured-reference header characters with '.
        if(next==="'"&&index<formula.length)index++
        else if(next==='[')depth++
        else if(next===']')depth--
      }
      previous=']';continue
    }
    if(identifier.test(char)) {
      const start=index++
      while(index<formula.length&&identifier.test(formula[index]!)){if(index%4096===0)checkBudget();index++}
      const token=formula.slice(start,index)
      let after=index;while(after<formula.length&&/\s/.test(formula[after]!))after++
      if(previous!=='!'&&previous!==']'&&/^(?:(?:_xlfn|_xlws)\.)*UNIQUE$/i.test(token)&&formula[after]==='(')return true
      previous=token;continue
    }
    if(!/\s/.test(char))previous=char
    index++
  }
  return false
}

function reviewArchive(bytes:Uint8Array) {
  const deadline=Date.now()+IMPORT_REVIEW_LIMITS.timeMs
  const checkBudget=()=>requireValue(Date.now()<=deadline)
  requireValue(bytes.length<=IMPORT_REVIEW_LIMITS.inputBytes)
  // This hardened ZIP directory validator is format-neutral despite its
  // historical PPTX name. It validates paths, duplication, offsets and bounds.
  const archive=new Map(inspectPptxZip(bytes).entries.map(entry=>[entry.name,entry]))
  let expanded=0
  const read=(name:string)=>{
    const entry=archive.get(name);requireValue(entry&&entry.size<=IMPORT_REVIEW_LIMITS.xmlBytes)
    expanded+=entry.size;requireValue(expanded<=IMPORT_REVIEW_LIMITS.totalXmlBytes)
    let data:Uint8Array
    if(entry.method===0)data=entry.compressed
    else {
      // A fixed `out` buffer silently truncates oversized fflate output. Count
      // actual streamed bytes before copying instead. Tiny compressed chunks
      // also bound work between length/time checks, even with forged ZIP sizes.
      data=new Uint8Array(entry.size)
      let actual=0
      const inflater=new Inflate(chunk=>{
        actual+=chunk.length;requireValue(actual<=entry.size&&actual<=IMPORT_REVIEW_LIMITS.xmlBytes)
        data.set(chunk,actual-chunk.length)
      })
      for(let offset=0;offset<entry.compressed.length;offset+=256) {
        checkBudget()
        inflater.push(entry.compressed.subarray(offset,offset+256),offset+256>=entry.compressed.length)
      }
      requireValue(actual===entry.size)
    }
    requireValue(data.length===entry.size&&crc32(data)===entry.crc)
    checkBudget()
    return decoder.decode(data)
  }
  const relationships=(name:string,base:string)=>{
    const result=new Map<string,{type:string;part:string}>()
    walkXml(read(name),{start(node,parents){
      if(!parents.length)requireValue(node.local==='Relationships'&&REL.has(node.uri))
      if(node.local!=='Relationship'||!REL.has(node.uri)||parents.length!==1)return
      const id=attribute(node,'Id'),type=attribute(node,'Type'),target=attribute(node,'Target')
      requireValue(id&&type&&target&&!result.has(id))
      if(attribute(node,'TargetMode')==='External')return
      result.set(id,{type,part:resolvePart(base,target)})
    }},checkBudget)
    return result
  }
  return{archive,read,relationships,checkBudget}
}

export function inspectXlsxImport(bytes:Uint8Array):ImportReview {
  try {
    const {read,relationships,checkBudget}=reviewArchive(bytes)
    const rootLinks=relationships('_rels/.rels','')
    const officeParts=[...rootLinks.values()].filter(link=>[...DOC_REL].some(uri=>link.type===uri+'/officeDocument'))
    requireValue(officeParts.length===1)
    const workbook=officeParts[0]!.part,split=workbook.lastIndexOf('/'),workbookRels=`${workbook.slice(0,split+1)}_rels/${workbook.slice(split+1)}.rels`
    const links=relationships(workbookRels,workbook),sheets:Array<{name:string;part:string;worksheet:boolean;veryHidden:boolean}>=[]
    walkXml(read(workbook),{start(node,parents){
      if(!parents.length)requireValue(node.local==='workbook'&&S.has(node.uri))
      if(node.local!=='sheet'||!S.has(node.uri)||parents.length!==2||parents[1]!.local!=='sheets'||!S.has(parents[1]!.uri))return
      const name=attribute(node,'name'),id=attribute(node,'id',DOC_REL),link=id?links.get(id):null
      requireValue(name&&link)
      sheets.push({name,part:link.part,worksheet:[...DOC_REL].some(uri=>link.type===uri+'/worksheet'),veryHidden:attribute(node,'state')==='veryHidden'})
    }},checkBudget)
    requireValue(sheets.length>0&&sheets.length<=4096)
    let booleans=0,uniqueFormulas=0
    for(const sheet of sheets) {
      if(!sheet.worksheet)continue
      let cell:{formula:boolean;value:string;address?:string}|null=null
      let formula:string|null=null
      const candidates:Array<string|undefined>=[],arrayRanges:Array<{column:number;row:number;endColumn:number;endRow:number}>=[]
      walkXml(read(sheet.part),{start(node,parents){
        if(!parents.length)requireValue(node.local==='worksheet'&&S.has(node.uri))
        if(node.local==='c'&&S.has(node.uri)&&parents.length===3&&parents[1]!.local==='sheetData'&&S.has(parents[1]!.uri)&&parents[2]!.local==='row'&&S.has(parents[2]!.uri)&&attribute(node,'t')==='b')cell={formula:false,value:'',address:attribute(node,'r')}
        else if(node.local==='f'&&S.has(node.uri)&&parents.length===4&&parents[1]!.local==='sheetData'&&S.has(parents[1]!.uri)&&parents[2]!.local==='row'&&S.has(parents[2]!.uri)&&parents[3]!.local==='c'&&S.has(parents[3]!.uri)) {
          formula=''
          if(cell)cell.formula=true
          if(attribute(node,'t')==='array') {
            const ref=attribute(node,'ref');requireValue(ref)
            const addresses=ref.split(':');requireValue(addresses.length<=2)
            const start=cellPosition(addresses[0]!),end=cellPosition(addresses.at(-1)!)
            requireValue(start.column<=end.column&&start.row<=end.row&&arrayRanges.length<128)
            arrayRanges.push({...start,endColumn:end.column,endRow:end.row})
          }
        }
      },text(value,parents){
        if(cell&&parents.length===5&&parents[4]!.local==='v'&&S.has(parents[4]!.uri))cell.value+=value
        if(formula!==null&&parents.length===5&&parents[4]!.local==='f'&&S.has(parents[4]!.uri))formula+=value
      },end(node,parents){
        if(formula!==null&&node.local==='f'&&S.has(node.uri)&&parents.length===4){if(callsUnique(formula,checkBudget))uniqueFormulas++;formula=null}
        if(cell&&node.local==='c'&&S.has(node.uri)&&parents.length===3){if(!cell.formula&&['0','1','true','false'].includes(cell.value.trim()))candidates.push(cell.address);cell=null}
      }},checkBudget)
      if(!arrayRanges.length)booleans+=candidates.length
      else for(const [index,address] of candidates.entries()) {
        if(index%256===0)checkBudget()
        // Array/spill followers often carry t=b caches without their own <f>.
        // Do not call them literal booleans. Ambiguous implicit addresses fail
        // this targeted review rather than guessing a conversion risk count.
        requireValue(address);const position=cellPosition(address)
        if(!arrayRanges.some(range=>position.column>=range.column&&position.column<=range.endColumn&&position.row>=range.row&&position.row<=range.endRow))booleans++
      }
    }
    const veryHidden=sheets.filter(sheet=>sheet.veryHidden).length,warnings:string[]=[]
    if(booleans)warnings.push(`含 ${booleans} 个布尔常量单元格：当前内核保存后可能变为 TRUE()/FALSE() 公式，ISFORMULA 等判断会改变。`)
    if(veryHidden)warnings.push(`含 ${veryHidden} 张深度隐藏（veryHidden）工作表：当前内核保存后会变为普通隐藏。`)
    if(uniqueFormulas)warnings.push(`含 ${uniqueFormulas} 个使用 UNIQUE 的公式：当前内核存在动态数组重算差异，保存或重开后结果可能改变，请核对副本。`)
    return{complete:true,requiresSaveAs:warnings.length>0,warnings}
  } catch {
    return{complete:false,requiresSaveAs:true,warnings:['未能完成此 XLSX 的公式、布尔常量与深度隐藏检查；保存时使用副本保留原件。']}
  }
}

export function inspectDocxImport(bytes:Uint8Array):ImportReview {
  try {
    const {archive,read,relationships,checkBudget}=reviewArchive(bytes)
    const isType=(type:string,local:string)=>[...DOC_REL].some(uri=>type===uri+'/'+local)
    const roots=[...relationships('_rels/.rels','').values()].filter(link=>isType(link.type,'officeDocument'))
    requireValue(roots.length===1)
    const queue=[{part:roots[0]!.part,root:'document'}],visited=new Set<string>(),attachments=new Set<string>()
    while(queue.length) {
      const {part,root}=queue.shift()!;if(visited.has(part))continue
      visited.add(part);requireValue(visited.size<=256);checkBudget()
      const split=part.lastIndexOf('/'),rels=`${part.slice(0,split+1)}_rels/${part.slice(split+1)}.rels`
      const links=archive.has(rels)?relationships(rels,part):new Map<string,{type:string;part:string}>()
      const implicitParts=new Set<string>()
      walkXml(read(part),{start(node,parents){
        if(!parents.length)requireValue(node.local===root&&W.has(node.uri))
        // A chart's backing workbook is not a user attachment. Require an
        // actual Word object plus its own internal OLE/package relationship.
        // OOXML also represents attachments with w:objectEmbed (including
        // Strict documents), rather than the legacy Office o:OLEObject.
        // The attachment is only checked for existence; never parse or run it.
        const parent=parents.at(-1)
        const objectEmbed=W.has(node.uri)&&node.local==='objectEmbed'&&parent?.local==='object'&&parent.uri===node.uri
        const legacyObject=node.uri===O&&node.local==='OLEObject'&&parents.some(parent=>parent.local==='object'&&W.has(parent.uri))
        if(objectEmbed||legacyObject) {
          if(legacyObject) {
            const type=attribute(node,'Type')
            if(type==='Link')return
            requireValue(!type||type==='Embed')
          }
          const id=attribute(node,'id',DOC_REL),link=id?links.get(id):null
          requireValue(link&&(isType(link.type,'oleObject')||isType(link.type,'package')))
          requireValue(archive.has(link.part)&&archive.get(link.part)!.size>0)
          attachments.add(link.part)
        }
        if(!W.has(node.uri))return
        if(node.local==='headerReference'||node.local==='footerReference') {
          const kind=node.local==='headerReference'?'header':'footer',id=attribute(node,'id',DOC_REL),link=id?links.get(id):null
          requireValue(link&&isType(link.type,kind))
          queue.push({part:link.part,root:kind==='header'?'hdr':'ftr'})
        }
        if(node.local==='footnoteReference')implicitParts.add('footnotes')
        if(node.local==='endnoteReference')implicitParts.add('endnotes')
        if(['commentReference','commentRangeStart','commentRangeEnd'].includes(node.local))implicitParts.add('comments')
      }},checkBudget)
      for(const kind of implicitParts) {
        const matches=[...links.values()].filter(link=>isType(link.type,kind));requireValue(matches.length===1)
        queue.push({part:matches[0]!.part,root:kind})
      }
    }
    return{complete:true,requiresSaveAs:attachments.size>0,warnings:attachments.size?[`含嵌入附件（${attachments.size} 项）：当前内核可能在转换时丢失附件内容，保存需另存副本，请保留原件。`]:[]}
  } catch {
    return{complete:false,requiresSaveAs:true,warnings:['未能完成此 DOCX 的嵌入附件检查；保存时使用副本保留原件。']}
  }
}

export function reviewOfficeImport(document:{extension:string;base64:string}):ImportReview {
  if(!['xlsx','docx'].includes(document.extension)||!document.base64)return{complete:true,requiresSaveAs:false,warnings:[]}
  const label=document.extension.toUpperCase()
  if(document.base64.length>Math.ceil(IMPORT_REVIEW_LIMITS.inputBytes/3)*4)return{complete:false,requiresSaveAs:true,warnings:[`此 ${label} 超出导入预检上限；保存时使用副本保留原件。`]}
  try{return document.extension==='docx'?inspectDocxImport(base64ToBytes(document.base64)):inspectXlsxImport(base64ToBytes(document.base64))}
  catch{return{complete:false,requiresSaveAs:true,warnings:[`未能读取此 ${label} 的导入预检数据；保存时使用副本保留原件。`]}}
}
