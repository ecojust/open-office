const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname,'../..'), dir = path.join(root,'tests/compatibility/presentation-color-transforms'), out = path.join(root,'test-results/presentation-colors'), url = process.env.PRESENTATION_URL || 'http://127.0.0.1:5199/';
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const report={ok:false,errors:[],external:[]};
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}}); page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==new URL(url).origin)report.external.push(r.url())});await page.goto(url);
  const bytes=fs.readFileSync(path.join(dir,'swatches.pptx')),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),oracle=JSON.parse(fs.readFileSync(path.join(dir,'native-observations.json'),'utf8'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),manifest.items[0].sha256);
  const result=await page.evaluate(async({base64,oracle})=>{
   const {importPresentation,exportPresentation}=await import('/src/presentation/core/pptx.ts'),{PresentationController}=await import('/src/presentation/core/model.ts'),{slideSvg}=await import('/src/presentation/core/render.ts'),{exportPresentationPdf}=await import('/src/presentation/core/pdf.ts'),{smartArtCacheSvg}=await import('/src/presentation/core/smartart-preview.ts'),{applyDrawingColorTransforms}=await import('/src/presentation/core/color-transforms.ts'),{zipSync,unzipSync}=await import('/node_modules/fflate/esm/browser.js');
   const A='http://schemas.openxmlformats.org/drawingml/2006/main',P='http://schemas.openxmlformats.org/presentationml/2006/main',DSP='http://schemas.microsoft.com/office/drawing/2008/diagram';
   const source=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),checks=[],artifacts=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label)},eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
   const parse=b=>new DOMParser().parseFromString(typeof b==='string'?b:new TextDecoder().decode(b),'application/xml'),serialize=e=>new XMLSerializer().serializeToString(e),encode=b=>{let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s)};
   const sourceParts=unzipSync(source),part=Object.keys(sourceParts).find(name=>/^ppt\/slides\/[^/]+\.xml$/.test(name)),canon=n=>[n.namespaceURI,n.localName,[...n.attributes].filter(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(a=>[a.namespaceURI,a.localName,a.value]).sort(),[...n.childNodes].map(c=>c.nodeType===1?canon(c):[c.nodeType,c.nodeValue])];
   const paintSignature=bytes=>[...parse(unzipSync(bytes)[part]).getElementsByTagNameNS(P,'spPr')].map(pr=>[...pr.children].filter(child=>['solidFill','ln'].includes(child.localName)).map(canon));
   const make=async bytes=>new PresentationController(await importPresentation(bytes),'colors'),save=controller=>exportPresentation(controller.model),c=await make(source),objects=c.model.slides[0].objects;
   const pixel=color=>[1,3,5].map(index=>parseInt(color.slice(index,index+2),16)),excluded=new Set(['scrgb-percent','tint-percent','system-tint','alpha-chain']);
   for(const sample of oracle.samples)if(!excluded.has(sample.id)){
    const object=objects.find(object=>object.name===sample.id),actual=pixel(object.fillColor),difference=actual.map((v,i)=>Math.abs(v-sample.rgb[i]));
    check(Math.max(...difference)<=1,`${sample.id}: model RGB matches independent native center pixel within one channel level`);
   }
   check(objects.find(object=>object.name==='scrgb-percent').fillColor==='#BCBCBC','Strict scRGB 50% follows the documented standard rather than the reference lexical bug');
   check(objects.find(object=>object.name==='tint-percent').fillColor==='#BEC6D4','Strict tint 50% follows the same transform as integer 50000');
   check(objects.find(object=>object.name==='system-tint').fillColor==='#BEC6D4','System color uses document lastClr cache without consulting a different OS palette');
   check(objects.find(object=>object.name==='alpha-chain').fillOpacity===.5&&objects.find(object=>object.name==='alpha-chain').opacity===undefined,'Ordinary shape fill alpha is resolved independently from the object');
   const noOp=await save(c);check(eq(paintSignature(source),paintSignature(noOp)),'No-op saving retains every source fill transform and line XML');
   const sourceXml=objects[2].sourceXml,originalFill=objects[2].fillColor,originalWidth=objects[2].width;
   c.action({type:'update-object',id:objects[2].id,width:50});c.action({type:'update-object',id:objects[2].id,text:'Preserve transformed color'});
   const edited=await save(c),again=await make(edited);
   check(eq(paintSignature(source),paintSignature(edited)),'Geometry and text edits never bake preview RGB into original color XML');
   check(c.model.slides[0].objects[2].sourceXml===sourceXml&&Object.entries(sourceParts).every(([name,bytes])=>eq([...bytes],[...c.model.sourceParts.get(name)])),'Original package and shape XML remain immutable');
   check(again.model.slides[0].objects[2].fillColor===originalFill&&again.model.slides[0].objects[2].text==='Preserve transformed color','Reopened edits retain text and the transformed source color');
   c.undo();c.undo();check(c.model.slides[0].objects[2].width===originalWidth&&c.model.slides[0].objects[2].fillColor===originalFill,'Undo restores the geometry without color drift');c.redo();c.redo();check(eq(paintSignature(await save(c)),paintSignature(edited)),'Redo preserves the ordered source transform XML');
   const mutate=fn=>{const parts=unzipSync(source),document=parse(parts[part]);fn(document,parts);parts[part]=new TextEncoder().encode(serialize(document));return zipSync(parts)},firstColor=d=>d.getElementsByTagNameNS(P,'spPr')[0].getElementsByTagNameNS(A,'srgbClr')[0];
   for(const[label,mutateColor]of[
    ['unknown transform',(node,d)=>{const m=d.createElementNS(A,'a:mystery');m.setAttribute('val','1');node.append(m)}],
    ['foreign transform',(node,d)=>{const m=d.createElementNS('urn:foreign','x:tint');m.setAttribute('val','50000');node.append(m)}],
    ['missing value',(node,d)=>node.append(d.createElementNS(A,'a:tint'))],
    ['invalid value',(node,d)=>{const m=d.createElementNS(A,'a:tint');m.setAttribute('val','NaN');node.append(m)}],
    ['excessive chain',(node,d)=>{for(let i=0;i<33;i++){const m=d.createElementNS(A,'a:alpha');m.setAttribute('val','50000');node.append(m)}}],
    ['unsupported base type',(node,d)=>{const color=d.createElementNS(A,'a:hslClr');color.setAttribute('hue','0');color.setAttribute('sat','100000');color.setAttribute('lum','50000');node.replaceWith(color)}],
    ['duplicate color',(node)=>node.parentElement.append(node.cloneNode(true))],
   ]){
    const bytes=mutate(d=>mutateColor(firstColor(d),d)),controller=await make(bytes);check(controller.model.slides[0].objects[0].fillColor===null&&controller.model.slides[0].warnings.some(message=>message.includes('颜色预览已简化')),`${label}: rejected color chain is visible as a warning`);check(eq(paintSignature(bytes),paintSignature(await save(controller))),`${label}: source color XML remains intact`);
   }
   const themeBytes=mutate((document,parts)=>{const themePart=Object.keys(parts).find(name=>/^ppt\/theme\/.*\.xml$/.test(name)),theme=parse(parts[themePart]),accent=theme.getElementsByTagNameNS(A,'accent1')[0];accent.innerHTML=`<a:scrgbClr xmlns:a="${A}" r="10" g="10" b="10"><a:alpha val="50000"/></a:scrgbClr>`;parts[themePart]=new TextEncoder().encode(serialize(theme));const old=firstColor(document),color=document.createElementNS(A,'a:schemeClr');color.setAttribute('val','accent1');const modifier=document.createElementNS(A,'a:lumMod');modifier.setAttribute('val','10000000');color.append(modifier);old.replaceWith(color)});
   const theme=await make(themeBytes);check(theme.model.slides[0].objects[0].fillColor==='#212121','Theme resolution keeps floating scRGB precision until the referencing transform finishes');
   check(eq(paintSignature(themeBytes),paintSignature(await save(theme))),'Theme-derived transform editability does not normalize source XML');
   const drawing=color=>parse(`<dsp:drawing xmlns:dsp="${DSP}" xmlns:a="${A}"><dsp:spTree><dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3600000" cy="1800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill>${color}</a:solidFill><a:ln><a:noFill/></a:ln></dsp:spPr></dsp:sp></dsp:spTree></dsp:drawing>`);
   const style={fontName:'Arial',fontSize:18,bold:false,italic:false,underline:false,color:'#000000',align:'left'};let baseCalls=0;
   const reader={color:node=>{baseCalls++;check(!node.children.length,'SmartArt base reader receives no duplicate transform chain');return '#336699'},textStyle:()=>style,image:()=>undefined};
   const art=smartArtCacheSvg(drawing('<a:srgbClr val="336699"><a:tint val="50000"/><a:alpha val="80000"/><a:alphaMod val="50000"/><a:alphaOff val="10000"/></a:srgbClr>'),100,50,reader);
   check(art.includes('fill="#BEC6D4" fill-opacity="0.5"')&&baseCalls===1,'SmartArt applies tint once and its independent alpha chain in order');
   const low=smartArtCacheSvg(drawing('<a:scrgbClr r="200" g="500" b="1000"><a:shade val="50000"/></a:scrgbClr>'),100,50,reader);check(low.includes('fill="#030810"'),'SmartArt scRGB avoids premature 8-bit rounding');
   const resolved=applyDrawingColorTransforms({space:'scRgb',components:['10','10','10']},[{name:'alpha',value:'50000'}]);
   const themedArt=smartArtCacheSvg(drawing('<a:schemeClr val="accent1"><a:lumMod val="10000000"/><a:alphaMod val="50000"/></a:schemeClr>'),100,50,{...reader,resolvedColor:()=>resolved});check(themedArt.includes('fill="#212121" fill-opacity="0.25"'),'SmartArt theme base preserves floating color and inherited alpha');
   let rejected=false;try{smartArtCacheSvg(drawing('<a:srgbClr val="336699"><a:mystery val="1"/></a:srgbClr>'),100,50,reader)}catch{rejected=true}check(rejected,'SmartArt rejects unknown transform rather than displaying an invented cache color');
   for(const[label,document,customReader]of[
    ['duplicate cached colors',drawing('<a:srgbClr val="336699"/><a:srgbClr val="FF0000"/>'),reader],
    ['unrecognized sibling',drawing('<a:srgbClr val="336699"/><a:unknown/>'),reader],
    ['resolved reader failure',drawing('<a:schemeClr val="accent1"/>'),{...reader,resolvedColor:()=>null}],
   ]){let failed=false;try{smartArtCacheSvg(document,100,50,customReader)}catch{failed=true}check(failed,`${label}: SmartArt does not fall back to an arbitrary color`)}
   artifacts.push({name:'colors-noop.pptx',base64:encode(noOp)},{name:'colors-edited.pptx',base64:encode(edited)},{name:'colors-preview.svg',text:slideSvg(c.model,c.model.slides[0])},{name:'colors.pdf',base64:encode(await exportPresentationPdf(c.model))});
   return{checks,artifacts};
  },{base64:bytes.toString('base64'),oracle});
  for(const artifact of result.artifacts)fs.writeFileSync(path.join(out,artifact.name),artifact.base64?Buffer.from(artifact.base64,'base64'):artifact.text);delete result.artifacts;await page.setContent(fs.readFileSync(path.join(out,'colors-preview.svg'),'utf8'));await page.screenshot({path:path.join(out,'colors-preview.png')});Object.assign(report,result,{ok:!report.errors.length&&!report.external.length});assert.equal(report.ok,true);console.log(JSON.stringify({ok:true,checks:report.checks.length}));
 }catch(error){report.error=error.stack;throw error}finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
