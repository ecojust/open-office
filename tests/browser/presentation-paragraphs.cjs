const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const fixtureDir = path.join(root, 'tests/compatibility/presentation-typography');
const pin = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'))).items[0];
const input = fs.readFileSync(path.join(fixtureDir, pin.path));
assert.equal(crypto.createHash('sha256').update(input).digest('hex'), pin.sha256);
const out = path.join(root, 'test-results/presentation-paragraphs'); fs.mkdirSync(out, {recursive:true});
const url = process.env.PRESENTATION_URL || 'http://127.0.0.1:5198/';
(async () => {
 const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const report = {checks:[], errors:[], external:[]};
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
  page.on('console', message => { if(message.type()==='info')console.log(message.text()); });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin) report.external.push(request.url()); });
  await page.goto(url);
  const result = await page.evaluate(async base64 => {
   const {importPresentation, exportPresentation} = await import('/src/presentation/core/pptx.ts');
   const {PresentationController,createPresentation} = await import('/src/presentation/core/model.ts');
   const {effectiveRichText} = await import('/src/presentation/core/rich-text.ts');
   const {slideSvg} = await import('/src/presentation/core/render.ts');
   const {unzipSync,zipSync} = await import('/node_modules/fflate/esm/browser.js');
   const A='http://schemas.openxmlformats.org/drawingml/2006/main',P='http://schemas.openxmlformats.org/presentationml/2006/main';
   const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
   const checks=[], files=[], eq=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b)), check=(condition,message)=>{if(!condition)throw Error(message); checks.push(message);};
   const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
   const encode=data=>{let s='';for(let i=0;i<data.length;i+=8192)s+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(s);};
   const xml=data=>new DOMParser().parseFromString(new TextDecoder().decode(data),'application/xml');
   const direct=(node,name)=>[...node.children].filter(child=>child.namespaceURI===A&&child.localName===name);
   const canonical=node=>!node?null:{name:node.namespaceURI+':'+node.localName,attrs:[...node.attributes].filter(attr=>attr.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(attr=>[attr.name,attr.value]).sort((a,b)=>a[0].localeCompare(b[0])),children:[...node.childNodes].filter(c=>c.nodeType===1||c.nodeType===3&&c.textContent.trim()).map(c=>c.nodeType===1?canonical(c):c.textContent)};
   const body=(parts,name='INHERITED',part='ppt/slides/slide3.xml')=>{const doc=xml(parts[part]),shape=[...doc.getElementsByTagNameNS(P,'sp')].find(s=>s.getElementsByTagNameNS(P,'cNvPr')[0].getAttribute('name')===name);return shape.getElementsByTagNameNS(P,'txBody')[0];};
   const current=editor=>editor.model.slides[editor.currentPageIndex].objects.find(o=>o.name==='INHERITED');
   const editorFor=async bytes=>{const c=new PresentationController(await importPresentation(bytes),'paragraph-test');c.action({type:'select-page',pageIndex:2});return c;};
   const action=(c,patch,indices=[1,2],extra={})=>{const o=current(c);return c.action({type:'format-paragraphs',id:o.id,paragraphIndices:indices,paragraphStyle:patch,expectedText:o.text,expectedRevision:c.revision,...extra});};
   const snapshot=c=>JSON.stringify({model:c.model,revision:c.revision,dirty:c.dirty});
   const reject=(c,operation,label)=>{const before=snapshot(c);let rejected=false;try{operation();}catch{rejected=true;}check(rejected&&snapshot(c)===before,label+' rejects atomically');};
   let c=await editorFor(bytes), previous=unzipSync(await exportPresentation(c.model));
   check(effectiveRichText(current(c)).length===4,'Real paragraphs include empty paragraph and do not split a:br');
   const plans=[{lineSpacing:{unit:'points',value:12},spaceBefore:{unit:'points',value:0},spaceAfter:{unit:'percent',value:1.5},align:'right'}, {lineSpacing:{unit:'percent',value:0},spaceBefore:{unit:'points',value:8.123},align:'center'}, {lineSpacing:{unit:'percent',value:1.234567},spaceAfter:{unit:'points',value:0}}];
   for(let cycle=0;cycle<3;cycle++) {
    const beforeBody=body(previous),beforeParagraphs=direct(beforeBody,'p'), old=JSON.stringify(current(c)), sourceBefore=[...c.model.sourceParts].map(([key,v])=>[key,encode(v)]);
    action(c,plans[cycle],[1,2],cycle===0?{spaceFirstLastParagraph:true}:{});
    check(eq([...c.model.sourceParts].map(([key,v])=>[key,encode(v)]),sourceBefore),'Cycle '+cycle+' keeps source package immutable');
    const afterState=JSON.stringify(current(c)), rich=effectiveRichText(current(c));
    c.undo();check(JSON.stringify(current(c))===old,'Cycle '+cycle+' one undo restores original object');
    c.redo();check(JSON.stringify(current(c))===afterState,'Cycle '+cycle+' one redo restores paragraph edits');
    const saved=await exportPresentation(c.model),parts=unzipSync(saved),afterBody=body(parts),afterParagraphs=direct(afterBody,'p');
    check(eq(canonical(beforeParagraphs[0]),canonical(afterParagraphs[0]))&&eq(canonical(beforeParagraphs[3]),canonical(afterParagraphs[3])),'Cycle '+cycle+' unselected paragraphs unchanged');
    for(const index of [1,2]) {
     const runs=p=>[...p.children].filter(node=>node.localName!=='pPr').map(canonical);
     check(eq(runs(beforeParagraphs[index]),runs(afterParagraphs[index])),'Cycle '+cycle+' paragraph '+index+' retains every run, break, baseline and end property');
     const oldP=direct(beforeParagraphs[index],'pPr')[0]?.cloneNode(true),newP=direct(afterParagraphs[index],'pPr')[0].cloneNode(true);
     for(const props of [oldP,newP])if(props){if(plans[cycle].align!==undefined)props.removeAttribute('algn');for(const [key,name] of [['lineSpacing','lnSpc'],['spaceBefore','spcBef'],['spaceAfter','spcAft']])if(plans[cycle][key])direct(props,name).forEach(node=>node.remove());}
     check(eq(canonical(oldP),canonical(newP)),'Cycle '+cycle+' paragraph '+index+' only requested properties change');
    }
    const changed=Object.keys(parts).filter(key=>!previous[key]||encode(parts[key])!==encode(previous[key]));
    check(eq(changed,['ppt/slides/slide3.xml']),'Cycle '+cycle+' all unrelated package parts retain exact bytes');
    const reopened=await editorFor(saved);
    check(eq(rich,effectiveRichText(current(reopened))),'Cycle '+cycle+' preview and reopened paragraph metrics/styles agree');
    check(current(reopened).richText.spaceFirstLastParagraph===true,'Cycle '+cycle+' box-level first/last spacing survives');
    files.push({name:'paragraph-cycle-'+(cycle+1)+'.pptx',data:encode(saved)});c=reopened;previous=parts;
   }
   const p=effectiveRichText(current(c));check(p[1].lineSpacing.value===1.23457&&p[1].spaceBefore.value===8.12&&p[1].spaceAfter.value===0,'Point and percentage values quantize to DrawingML precision and preserve zero');
   for(const [label,indices,patch,extra] of [
    ['empty selection',[],{align:'left'},{}],['duplicate paragraph',[1,1],{align:'left'},{}],['missing paragraph',[9],{align:'left'},{}],['fractional paragraph',[.2],{align:'left'},{}],['empty patch',[1],{},{}],['unknown property',[1],{fontSize:20},{}],['bad align',[1],{align:'bottom'},{}],['negative spacing',[1],{lineSpacing:{unit:'points',value:-1}},{}],['nonfinite spacing',[1],{lineSpacing:{unit:'points',value:NaN}},{}],['too large percent',[1],{spaceBefore:{unit:'percent',value:11}},{}],['unsupported unit',[1],{lineSpacing:{unit:'pixel',value:12}},{}],['null spacing',[1],{spaceBefore:null},{}],['stale text',[1],{align:'right'},{expectedText:'stale'}],['missing revision',[1],{align:'left'},{expectedRevision:undefined}],['wrong outer flag',[1],{}, {spaceFirstLastParagraph:'true'}],
   ])reject(c,()=>action(c,patch,indices,extra),label);
   reject(c,()=>action(c,{align:'left'},[1],{expectedRevision:c.revision-1}),'stale revision');
   current(c).locked=true;reject(c,()=>action(c,{align:'left'}),'locked object');current(c).locked=false;
   const beforeLayout=await exportPresentation(c.model), beforeRuns=effectiveRichText(current(c));
   c.action({type:'set-text-layout',id:current(c).id,layout:{verticalAlign:'bottom',wrap:false,insets:{left:0,right:4,top:0,bottom:3}},expectedRevision:c.revision});
   const layoutSaved=await exportPresentation(c.model), layoutOpen=await editorFor(layoutSaved);
   check(eq(current(c).textLayout,current(layoutOpen).textLayout),'Text layout zero margins, wrap false and bottom alignment persist');
   check(eq(beforeRuns,effectiveRichText(current(layoutOpen))),'Text layout does not replace paragraph or character formatting');
   check(new XMLSerializer().serializeToString(direct(body(unzipSync(beforeLayout)),'p')[1])===new XMLSerializer().serializeToString(direct(body(unzipSync(layoutSaved)),'p')[1]),'Text layout keeps the entire paragraph XML intact');
   files.push({name:'paragraph-layout.pptx',data:encode(layoutSaved)});
   for(const [label,layout] of [['empty layout',{}],['invalid anchor',{verticalAlign:'stretch'}],['nonboolean wrap',{wrap:0}],['negative inset',{insets:{top:-1}}],['unknown inset',{insets:{diagonal:3}}],['empty inset',{insets:{}}],['infinite rotation',{rotation:Infinity}],['unknown layout',{columns:3}]])reject(c,()=>c.action({type:'set-text-layout',id:current(c).id,layout}),label);
   // Ensure last explicit operation wins across full-box, paragraphs and ranges.
   c.action({type:'update-object',id:current(c).id,textStyle:{align:'left',bold:true}});action(c,{align:'right'},[1]);
   c.action({type:'format-text-range',id:current(c).id,start:0,end:9,textStyle:{italic:true},expectedText:current(c).text,expectedRevision:c.revision});
   check(effectiveRichText(current(c))[1].style.align==='right'&&effectiveRichText(current(c))[0].style.align==='left','Paragraph align supersedes prior full-box align without affecting other paragraphs');
   c.action({type:'update-object',id:current(c).id,textStyle:{align:'left'}});
   const chainSaved=await exportPresentation(c.model),chainOpen=await editorFor(chainSaved);
   check(effectiveRichText(current(c)).every(p=>p.style.align==='left')&&eq(effectiveRichText(current(c)),effectiveRichText(current(chainOpen))),'Later full-box align overrides paragraph align and character edits survive');
   const copied=c.duplicateObjects([current(c).id]);check(copied.selectedObjectIds.length===1,'Formatted object copies through the real controller');
   const copyOpen=await importPresentation(await exportPresentation(c.model));check(copyOpen.slides[2].objects.filter(o=>o.name==='INHERITED').length===2,'Copied formatted object exports and reopens');
   const fresh=new PresentationController(createPresentation(),'fresh-paragraph');fresh.action({type:'insert-text',text:'First\n\nLast',textStyle:{fontName:'Courier New',fontSize:17.5,color:'#117744'}});const fo=()=>fresh.model.slides[0].objects[0];
   fresh.action({type:'format-paragraphs',id:fo().id,paragraphIndices:[1,2],paragraphStyle:{spaceBefore:{unit:'points',value:0},lineSpacing:{unit:'points',value:0}},spaceFirstLastParagraph:false,expectedText:fo().text,expectedRevision:fresh.revision});
   fresh.action({type:'set-text-layout',id:fo().id,layout:{verticalAlign:'middle',insets:{left:0}}});
   const freshSaved=await exportPresentation(fresh.model),freshOpen=await importPresentation(freshSaved);
   check(eq(effectiveRichText(fo()),effectiveRichText(freshOpen.slides[0].objects[0])),'Fresh empty paragraph and explicit zero line spacing survive save/reopen');
   files.push({name:'paragraph-new.pptx',data:encode(freshSaved)});
   fresh.action({type:'format-text-range',id:fo().id,start:0,end:3,textStyle:{bold:true},expectedText:fo().text,expectedRevision:fresh.revision});
   fresh.action({type:'update-object',id:fo().id,text:'First edited\n\nLast'});
   const freshEdited=await exportPresentation(fresh.model),freshEditedOpen=await importPresentation(freshEdited);
   check(eq(effectiveRichText(fo()),effectiveRichText(freshEditedOpen.slides[0].objects[0])),'Fresh styled text, empty defaults, local formatting and later plain edits retain preview/reopen parity');
   const linkedParts=unzipSync(bytes),linkedXml=xml(linkedParts['ppt/slides/slide3.xml']),linkedShape=[...linkedXml.getElementsByTagNameNS(P,'sp')].find(s=>s.getElementsByTagNameNS(P,'cNvPr')[0].getAttribute('name')==='INHERITED'),runProps=linkedShape.getElementsByTagNameNS(A,'rPr')[0],link=linkedXml.createElementNS(A,'a:hlinkClick');
   link.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','r:id','rIdParagraphLink');runProps.appendChild(link);linkedParts['ppt/slides/slide3.xml']=new TextEncoder().encode(new XMLSerializer().serializeToString(linkedXml));
   const relationships=xml(linkedParts['ppt/slides/_rels/slide3.xml.rels']),relation=relationships.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships','Relationship');relation.setAttribute('Id','rIdParagraphLink');relation.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink');relation.setAttribute('Target','https://example.invalid/no-fetch');relation.setAttribute('TargetMode','External');relationships.documentElement.appendChild(relation);linkedParts['ppt/slides/_rels/slide3.xml.rels']=new TextEncoder().encode(new XMLSerializer().serializeToString(relationships));
   const linked=await editorFor(zipSync(linkedParts));reject(linked,()=>action(linked,{align:'right'}),'relationship-bearing paragraph');
   const linkedBefore=unzipSync(await exportPresentation(linked.model));linked.action({type:'set-text-layout',id:current(linked).id,layout:{wrap:false}});const linkedAfter=unzipSync(await exportPresentation(linked.model));
   check(eq(direct(body(linkedBefore),'p').map(canonical),direct(body(linkedAfter),'p').map(canonical))&&encode(linkedBefore['ppt/slides/_rels/slide3.xml.rels'])===encode(linkedAfter['ppt/slides/_rels/slide3.xml.rels']),'Safe box layout preserves linked paragraphs and their relationship bytes without fetching');

   check(slideSvg(c.model,c.model.slides[2]).includes('<text'),'Edited paragraph scene renders through the shared SVG path');
   return {checks,files};
  },input.toString('base64'));
  report.checks.push(...result.checks);for(const item of result.files)fs.writeFileSync(path.join(out,item.name),Buffer.from(item.data,'base64'));
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.ok=true;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,checks:report.checks.length}));
 } catch(error) {report.ok=false;report.error=error.stack;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));throw error;} finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
