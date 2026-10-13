/* Real browser DOM + bounded asynchronous ZIP workers; no mocked XML implementation. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const {zipSync, unzipSync, strToU8, strFromU8} = require('fflate')
const root = path.resolve(__dirname, '../..')
const P='http://schemas.openxmlformats.org/presentationml/2006/main', A='http://schemas.openxmlformats.org/drawingml/2006/main', R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const namespace=`xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"`
const rels = rows => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.map(([Id,Type,Target,extra=''])=>`<Relationship Id="${Id}" Type="${Type}" Target="${Target}" ${extra}/>`).join('')}</Relationships>`
const slide = (id,name,text,features='',show='') => `<p:sld ${namespace} ${show}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>${features}</p:sld>`
const animation = id => `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"><p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="2" dur="500"/><p:tgtEl><p:spTgt spid="${id}"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`
function fixture({id=2,name='Title 1',features='',reverse=false,external=false}={}) {
 const data={
 '[Content_Types].xml':strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="wav" ContentType="audio/wav"/></Types>`),
 '_rels/.rels':strToU8(rels([['office',`${R}/officeDocument`,'ppt/presentation.xml']])),
 'ppt/presentation.xml':strToU8(`<p:presentation ${namespace}><p:sldIdLst>${(reverse?[2,1]:[1,2]).map(n=>`<p:sldId id="${255+n}" r:id="rId${n}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`),
 'ppt/_rels/presentation.xml.rels':strToU8(rels([["rId1",`${R}/slide`,'slides/slide1.xml'],['rId2',`${R}/slide`,'slides/slide2.xml']])),
 'ppt/slides/slide1.xml':strToU8(slide(id,name,'第一张 · source',features)),
 'ppt/slides/slide2.xml':strToU8(slide(3,'Title 2','第二张','', 'show="0"')),
 'ppt/slides/_rels/slide1.xml.rels':strToU8(rels([['note',`${R}/notesSlide`,'../notesSlides/notesSlide1.xml']])),
 'ppt/notesSlides/notesSlide1.xml':strToU8(`<p:notes ${namespace}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>讲稿备注 · offline</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`),
 'custom/preserved.bin':new Uint8Array([0,255,42,13,0,7]),
 }
 return zipSync(data)
}
function wav(){const bytes=new Uint8Array(44+1600),v=new DataView(bytes.buffer);bytes.set(strToU8('RIFF'));v.setUint32(4,bytes.length-8,true);bytes.set(strToU8('WAVEfmt '),8);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);bytes.set(strToU8('data'),36);v.setUint32(40,1600,true);return bytes}
async function main(){
 const {createServer}=await import('vite')
 const server=await createServer({configFile:false,root,cacheDir:'node_modules/.vite-pptx-package-test',optimizeDeps:{include:['fflate'],noDiscovery:true,entries:[]},server:{host:'127.0.0.1',port:0},plugins:[{name:'package-test-page',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>PPTX package test</title>')}else next()})}}]})
 await server.listen();let browser
 const output=path.join(root,'test-results/pptx-package');fs.mkdirSync(output,{recursive:true})
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']})
  const page=await browser.newPage();let externalRequests=0
  page.on('request',req=>{if(!req.url().startsWith('http://127.0.0.1:')&&!req.url().startsWith('blob:'))externalRequests++})
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  await page.evaluate(async()=>{window.pkg=await import('/src/presentation/pptx-package.ts')})
  const call=(method,...args)=>{ console.log('PPTX check:',method); return page.evaluate(async({method,args})=>{
   const bytes=x=>Uint8Array.from(x)
   if(method==='parse')return pkg.parsePptxPackage(bytes(args[0]))
   if(method==='patch') { const change=args[1];for(const item of change.slides)for(const media of item.addMedia||[])media.data=bytes(media.data);return Array.from(await pkg.patchPptxPackage(bytes(args[0]),change)) }
   if(method==='transplant')return Array.from(await pkg.transplantPresentationFeatures(bytes(args[0]),bytes(args[1]),args[2]))
  },{method,args:args.map(value=>value instanceof Uint8Array?Array.from(value):value)}) }
  const original=fixture({reverse:true});const metadata=await call('parse',original)
  assert.equal(metadata.slides[0].title,'第二张');assert.equal(metadata.slides[0].hidden,true)
  assert.equal(metadata.slides[1].notes,'讲稿备注 · offline');assert.equal(metadata.widthEmu,9144000)
  const source=fixture({features:animation(2)})
  const updated=Uint8Array.from(await call('patch',source,{slides:[{slideIndex:0,transition:{type:'push',direction:'l',durationMs:750,advanceAfterMs:3000,advanceOnClick:false},addMedia:[{kind:'audio',name:'中文音乐.wav',mimeType:'audio/wav',data:Array.from(wav()),rect:{x:0.1,y:0.2,width:0.25,height:0.3},start:'auto',loop:true}]}]}))
  const read=await call('parse',updated)
  assert.equal(read.slides[0].transition.type,'push');assert.equal(read.slides[0].transition.durationMs,750);assert.equal(read.slides[0].transition.advanceAfterMs,3000)
  assert.equal(read.slides[0].transition.advanceOnClick,false);assert.equal(read.slides[0].media.length,1)
  assert.equal(read.slides[0].media[0].start,'auto');assert.equal(read.slides[0].media[0].loop,true);assert.equal(read.slides[0].hasUnsupportedAnimations,true)
  assert.deepEqual(unzipSync(updated)['custom/preserved.bin'],unzipSync(source)['custom/preserved.bin'])
  assert.deepEqual(unzipSync(updated)[read.slides[0].media[0].partName],wav())
  fs.writeFileSync(path.join(output,'patched.pptx'),updated)
  const targetParts=unzipSync(fixture({id:99}));targetParts['ppt/slides/slide1.xml']=strToU8(strFromU8(targetParts['ppt/slides/slide1.xml']).replace('<p:sld ', '<p:sld show="0" '));const target=zipSync(targetParts)
  const transplanted=Uint8Array.from(await call('transplant',updated,target,[{sourceIndex:0,targetIndex:0},{sourceIndex:1,targetIndex:1}]))
  const final=await call('parse',transplanted);assert.equal(final.slides[0].media.length,1);assert.equal(final.slides[0].transition.type,'push');assert.equal(final.slides[0].hidden,true)
  const targetXml=strFromU8(unzipSync(transplanted)['ppt/slides/slide1.xml'])
  assert.ok(targetXml.includes('spid="99"'));assert.ok(!targetXml.includes('spid="2"'))
  const twice=Uint8Array.from(await call('transplant',updated,transplanted));assert.equal((await call('parse',twice)).slides[0].media.length,1);assert.equal(Object.keys(unzipSync(twice)).length,Object.keys(unzipSync(transplanted)).length)
  const noMedia=Uint8Array.from(await call('patch',updated,{slides:[{slideIndex:0,transition:{type:'none'},removeMediaIds:[read.slides[0].media[0].id]}]}))
  const removed=Uint8Array.from(await call('transplant',noMedia,transplanted));const cleared=await call('parse',removed)
  assert.equal(cleared.slides[0].media.length,0);assert.equal(cleared.slides[0].transition.type,'none')
  await assert.rejects(call('transplant',updated,fixture({id:99,name:'Renamed target'})),/动画引用的形状/)
  const unknown=fixture({features:'<p:transition><p:morph/></p:transition>'+animation(2)})
  assert.equal((await call('parse',unknown)).slides[0].transition.type,'unknown')
  const kept=Uint8Array.from(await call('transplant',unknown,target));assert.ok(strFromU8(unzipSync(kept)['ppt/slides/slide1.xml']).includes('morph'))
  const alternateParts=unzipSync(unknown);alternateParts['ppt/slides/slide1.xml']=strToU8(strFromU8(alternateParts['ppt/slides/slide1.xml']).replace('<p:sld ', '<p:sld xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p159="urn:unknown-transition" mc:Ignorable="p159" ').replace('<p:transition><p:morph/></p:transition>', '<mc:AlternateContent><mc:Choice Requires="p159"><p:transition><p159:morph/></p:transition></mc:Choice><mc:Fallback><p:transition><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>'))
  const alternate=Uint8Array.from(await call('transplant',zipSync(alternateParts),target));const altXml=strFromU8(unzipSync(alternate)['ppt/slides/slide1.xml']);assert.ok(altXml.includes('xmlns:p159="urn:unknown-transition"'));assert.ok(altXml.includes('Requires="p159"'));assert.equal((await call('parse',alternate)).slides[0].transition.type,'unknown')
  const signed=unzipSync(source);signed['_xmlsignatures/sig1.xml']=strToU8('<signature/>');await assert.rejects(call('patch',zipSync(signed),{slides:[{slideIndex:0,name:'changed'}]}),/数字签名/)
  await assert.rejects(call('patch',source,{slides:[{slideIndex:0,transition:{type:'fade',direction:'l'}}]}),/不支持指定方向/)
  const linkedParts=unzipSync(updated),relPath='ppt/slides/_rels/slide1.xml.rels'
  linkedParts[relPath]=strToU8(strFromU8(linkedParts[relPath]).replace(/Target="\.\.\/media\/openoffice-media-1.wav"/g,'Target="https://invalid.example/offline.wav" TargetMode="External"'))
  const linked=await call('parse',zipSync(linkedParts));assert.equal(linked.slides[0].media[0].external,true);assert.equal(linked.slides[0].media[0].data,null)
  const badXml=unzipSync(source);badXml['ppt/slides/slide1.xml']=strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+strFromU8(badXml['ppt/slides/slide1.xml']))
  await assert.rejects(call('parse',zipSync(badXml)),/DTD/)
  const real=fs.readFileSync(path.join(__dirname,'fixtures/presentation.pptx'));const actual=await call('parse',real)
  assert.ok(actual.slides.length>=2)
  const realPatched=Uint8Array.from(await call('patch',real,{slides:[{slideIndex:0,name:'保存在PPTX里的新名字',transition:{type:'fade',durationMs:600},addMedia:[{kind:'audio',name:'Real fixture audio.wav',mimeType:'audio/wav',data:Array.from(wav()),rect:{x:0.1,y:0.2,width:0.25,height:0.3},start:'auto',loop:true}]}]}))
  fs.writeFileSync(path.join(output,'real-patched.pptx'),realPatched)
  assert.equal((await call('parse',realPatched)).slides[0].name,'保存在PPTX里的新名字')
  if(process.env.PPTX_UNO_EXPORT){
   const exported=fs.readFileSync(process.env.PPTX_UNO_EXPORT),restored=Uint8Array.from(await call('transplant',realPatched,exported))
   const roundTrip=await call('parse',restored);assert.equal(roundTrip.slides[0].media.length,1);assert.equal(roundTrip.slides[0].transition.type,'fade');assert.equal(roundTrip.slides[0].media[0].start,'auto');assert.equal(roundTrip.slides[0].media[0].loop,true)
   fs.writeFileSync(path.join(output,'uno-restored.pptx'),restored)
  }
  for(const type of ['none','fade','push','wipe','cover','uncover','split']){
   const edited=Uint8Array.from(await call('patch',real,{slides:[{slideIndex:0,transition:{type,durationMs:550,...(type==='split'?{direction:'out',orientation:'vert'}:{})}}]}))
   assert.equal((await call('parse',edited)).slides[0].transition.type,type)
  }
  assert.equal(externalRequests,0)
  const report={ok:true,checks:['realPptx','slideOrder','notes','hidden','sevenTransitions','timing','embeddedMediaBytes','unrelatedBytesPreserved','transplantShapeIdRemap','noDuplicateMedia','authoritativeRemoval','ambiguousAnimationRefused','unknownEffectsPreserved','noExternalFetch','xmlEntitiesRejected','pageNamesPersisted','targetHiddenStatePreserved','noRepeatedMediaGrowth','namespaceChoicePreserved','signedPackageRefused'],originalFixtureSlides:actual.slides.length,realUnoExportRestored:!!process.env.PPTX_UNO_EXPORT}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
 }finally{await browser?.close();await server.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
