// Independent OOXML oracle for committed plain-text editing.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),out=path.resolve(root,process.env.PRESENTATION_TEXT_CONTENT_OUTPUT||'test-results/presentation-text-content');fs.mkdirSync(out,{recursive:true});
const fixture=fs.readFileSync(path.join(root,'tests/compatibility/presentation-typography/spacing-baseline.pptx'));
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');assert.equal(sha(fixture),'59454cd1a0f02259f2828bf98a63f747116737f8019a0420dc19e05e66226034');
const url=process.env.PRESENTATION_URL||'http://127.0.0.1:5199/';
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
  const page=await browser.newPage(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(new URL(url).origin+'/')&&!/^(data:|blob:)/.test(request.url()))external.push(request.url());});
  await page.goto(url);
  const result=await page.evaluate(async base64=>{
   const {importPresentation,exportPresentation}=await import('/src/presentation/core/pptx.ts');
   const {PresentationController,createPresentation}=await import('/src/presentation/core/model.ts');
   const {effectiveRichText}=await import('/src/presentation/core/rich-text.ts');
   const {slideSvg}=await import('/src/presentation/core/render.ts');
   const {zipSync,unzipSync}=await import('/node_modules/fflate/esm/browser.js');
   const A='http://schemas.openxmlformats.org/drawingml/2006/main',P='http://schemas.openxmlformats.org/presentationml/2006/main',R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
   const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),decoder=new TextDecoder(),encoder=new TextEncoder(),checks=[],rejected=[],artifacts=[];
   const encode=bytes=>{let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);};
   const check=(condition,label)=>{if(!condition)throw Error(label);checks.push(label);};
   const parse=bytes=>new DOMParser().parseFromString(typeof bytes==='string'?bytes:decoder.decode(bytes),'application/xml');
   const serialize=node=>new XMLSerializer().serializeToString(node);
   const direct=(el,name,ns=A)=>[...(el?.children||[])].filter(child=>child.namespaceURI===ns&&child.localName===name),one=(el,name,ns=A)=>direct(el,name,ns)[0];
   const canonical=node=>node?{name:[node.namespaceURI,node.localName],attrs:[...node.attributes].filter(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(a=>[a.namespaceURI,a.localName,a.value]).sort(),children:[...node.childNodes].map(n=>n.nodeType===1?canonical(n):n.nodeType===3?n.textContent:null).filter(n=>n!==null)}:null;
   const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
   const eq=(a,b)=>JSON.stringify(sort(a))===JSON.stringify(sort(b));
   const shape=(doc,name)=>[...doc.getElementsByTagNameNS(P,'sp')].find(el=>el.getElementsByTagNameNS(P,'cNvPr')[0]?.getAttribute('name')===name);
   const body=(parts,name)=>{for(const [namePart,data]of Object.entries(parts))if(/^ppt\/slides\/slide\d+\.xml$/.test(namePart)){const found=shape(parse(data),name);if(found)return one(found,'txBody',P);}throw Error(name);};
   const find=(model,name='BASELINE_EXPLICIT')=>model.slides.flatMap(slide=>slide.objects).find(o=>o.name===name);
   const editor=async(data=bytes,name='BASELINE_EXPLICIT')=>{const c=new PresentationController(await importPresentation(data),'text-content');c.action({type:'select-page',pageIndex:c.model.slides.findIndex(slide=>slide.objects.some(o=>o.name===name))});return c;};
   const saved=async(c,name='BASELINE_EXPLICIT')=>{const value=await exportPresentation(c.model);return {bytes:value,parts:unzipSync(value),body:body(unzipSync(value),name)};};
   const action=(c,text,name='BASELINE_EXPLICIT',extra={})=>c.action({type:'update-object',id:find(c.model,name).id,text,...extra});
   const snapshot=c=>JSON.stringify({model:c.model,revision:c.revision,dirty:c.dirty});
   const reject=(c,work,label)=>{const before=snapshot(c);let reason='';try{work();}catch(error){reason=error.message;}check(Boolean(reason),label+': rejects');check(snapshot(c)===before,label+': atomic rollback');rejected.push({label,reason});};
   const runTexts=body=>direct(body,'p').map(p=>direct(p,'r').map(r=>one(r,'t').textContent));
   const structure=body=>{const copy=body.cloneNode(true);for(const t of copy.getElementsByTagNameNS(A,'t')){t.textContent='';t.removeAttributeNS('http://www.w3.org/XML/1998/namespace','space');}return canonical(copy);};
   const byteSame=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
   const unrelated=(before,after,allowed,label)=>check(Object.keys(before).length===Object.keys(after).length&&Object.keys(before).every(name=>allowed.includes(name)||byteSame(before[name],after[name])),label+': unrelated package parts unchanged');
   const sourceParts=unzipSync(bytes),decorated=parse(sourceParts['ppt/slides/slide2.xml']),target=one(shape(decorated,'BASELINE_EXPLICIT'),'txBody',P);
   const rpr=one(direct(direct(target,'p')[0],'r')[1],'rPr');for(const [name,value]of Object.entries({lang:'en-US',kern:'1200',spc:'80',strike:'sngStrike',cap:'small'}))rpr.setAttribute(name,value);
   const highlight=decorated.createElementNS(A,'a:highlight'),highlightColor=decorated.createElementNS(A,'a:srgbClr');highlightColor.setAttribute('val','FFE080');highlight.append(highlightColor);rpr.append(highlight);
   sourceParts['ppt/slides/slide2.xml']=encoder.encode(serialize(decorated));const mixedBytes=zipSync(sourceParts);
   let c=await editor(mixedBytes),original=await saved(c),initialXml=find(c.model).sourceXml,initialParts=c.model.sourceParts;
   const sourceByteSnapshot=[...initialParts].map(([name,data])=>[name,data.slice()]);
   const plans=[['Normal! ','Rdised ','Lowered ','Zéro'],['Normal! 😀 ','Rdised ','Lowéred ','Zéro'],['Normal! 🐴 ','Rdised ','Lowéred ','Zéro!']];
   for(const [index,expected]of plans.entries()){
    const previous=await saved(c);action(c,expected.join(''));
    const result=await saved(c),o=find(c.model);
    check(eq(runTexts(result.body),[expected]),`Cycle ${index+1}: independently specified run texts preserved`);
    check(eq(structure(previous.body),structure(result.body)),`Cycle ${index+1}: all original run/paragraph/body/end properties and manual structure preserved`);
    check(o.textBodyOverride?.text===o.text&&o.richText?.sourceText===o.text,`Cycle ${index+1}: XML and display rebase at commit`);
    unrelated(previous.parts,result.parts,['ppt/slides/slide2.xml'],`Cycle ${index+1}`);
    const reopened=await importPresentation(result.bytes);
    check(eq(effectiveRichText(o),effectiveRichText(find(reopened))),`Cycle ${index+1}: live mixed formatting matches export/reopen`);
    const stable=await exportPresentation(reopened);check(eq(canonical(body(unzipSync(stable),'BASELINE_EXPLICIT')),canonical(result.body)),`Cycle ${index+1}: no-op save after reopen is stable`);
    artifacts.push({name:`text-content-cycle-${index+1}.pptx`,base64:encode(result.bytes)});
    if(index===0)check(o.sourceXml===initialXml&&c.model.sourceParts===initialParts&&sourceByteSnapshot.every(([name,data])=>byteSame(initialParts.get(name),data)),'Source XML, package map and every source byte stay immutable');
    c=await editor(result.bytes);
   }
   const history=await editor(mixedBytes),beforeHistory=JSON.stringify(history.model);action(history,'Normal Rdised Lowered Zéro');const afterHistory=JSON.stringify(history.model);history.undo();check(JSON.stringify(history.model)===beforeHistory,'Undo restores complete original body');history.redo();check(JSON.stringify(history.model)===afterHistory,'Redo restores complete committed body');
   reject(history,()=>action(history,'Late','BASELINE_EXPLICIT',{expectedRevision:history.revision-1}),'Stale action');
   const initialHistory=await saved(history);reject(history,()=>action(history,find(history.model).text+'\nAdded'),'Mixed text cannot silently change paragraph structure');check(eq(canonical((await saved(history)).body),canonical(initialHistory.body)),'Rejected structural change saves original body');
   const soft=await editor(bytes,'LINE_90'),softBefore=await saved(soft,'LINE_90');action(soft,'Furst 24pt line\nSecond 24pt line\nThird 24pt line\nNext paragraph','LINE_90');const softAfter=await saved(soft,'LINE_90');
   check(direct(softAfter.body,'p').length===2&&softAfter.body.getElementsByTagNameNS(A,'br').length===2,'Editing preserves two true paragraphs and two soft breaks');check(eq(structure(softBefore.body),structure(softAfter.body)),'Soft breaks and paragraph spacings are unchanged');artifacts.push({name:'text-content-soft-breaks.pptx',base64:encode(softAfter.bytes)});
   const modified=async(xml)=>{const parts=unzipSync(bytes),doc=parse(parts['ppt/slides/slide2.xml']),old=one(shape(doc,'BASELINE_EXPLICIT'),'txBody',P);old.innerHTML=xml;parts['ppt/slides/slide2.xml']=encoder.encode(serialize(doc));return zipSync(parts);};
   const wrap=content=>`<a:bodyPr xmlns:a="${A}"/><a:lstStyle xmlns:a="${A}"/>${content}`;
   const p=content=>`<a:p xmlns:a="${A}"><a:pPr><a:defRPr sz="1800" b="1" baseline="20000"><a:solidFill><a:srgbClr val="115599"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr>${content}<a:endParaRPr sz="3000"/></a:p>`;
   const r=text=>`<a:r><a:rPr sz="2000" baseline="-10000"/><a:t xml:space="preserve">${text}</a:t></a:r>`;
   const blank=await editor(await modified(wrap(p('')+p(r('A')+'<a:br/><a:br/>'+r('B'))+p(''))));
   check(find(blank.model).text==='\nA\n\nB\n','Blank paragraph and soft-break fixture projected independently');action(blank,'Top\nA\nMiddle\nB\nBottom');const blankOut=await saved(blank),blankReopen=await importPresentation(blankOut.bytes);
   check(find(blankReopen).text==='Top\nA\nMiddle\nB\nBottom','Empty paragraphs and empty soft-break line accept content at their actual locations');check(direct(blankOut.body,'p').length===3&&blankOut.body.getElementsByTagNameNS(A,'br').length===2,'Empty-segment insertion leaves separator types unchanged');check(eq(effectiveRichText(find(blank.model)),effectiveRichText(find(blankReopen))),'New run uses paragraph defaults, including baseline, not end-paragraph size');
   for(const [before,after]of [['left\n\nright','left\nX\nright'],['\nleft','X\nleft'],['left\n','left\nX']]){const embedded=await editor(await modified(wrap(p(r(before)))));action(embedded,after);const result=await saved(embedded);check(eq(runTexts(result.body),[[after]]),'Embedded LF insertion retains its single original run: '+JSON.stringify(before));check(eq(effectiveRichText(find(embedded.model)),effectiveRichText(find(await importPresentation(result.bytes)))),'Embedded LF live/reopen agrees');}
   const deletions=await editor(mixedBytes);action(deletions,'Normal Zero');const deleted=await saved(deletions);check(eq(runTexts(deleted.body),[['Normal ','','','Zero']]),'Cross-run deletion retains both unchanged outer runs and empty original styled runs');check(eq(structure(original.body),structure(deleted.body)),'Deletion preserves unmodeled properties of every original run');
   const insertion=await editor(mixedBytes);action(insertion,'Normal XRaised Lowered Zero');check(eq(runTexts((await saved(insertion)).body),[['Normal X','Raised ','Lowered ','Zero']]),'Boundary insertion follows documented left-run affinity');
   const replacement=await editor(mixedBytes);action(replacement,'Normal XRaised Lowered Z');check(eq(runTexts((await saved(replacement)).body),[['Normal X','Raised ','Lowered ','Z']]),'Separated insertion/deletion preserves intermediate runs');
   const oneStyle=await editor(await modified(wrap(p(r('First'))+p(r('Second')))));
   action(oneStyle,'Start\nMiddle\nEnd');const simpleOut=await saved(oneStyle);check(direct(simpleOut.body,'p').length===3,'Uniform imported paragraphs may add a paragraph');check(eq(effectiveRichText(find(oneStyle.model)),effectiveRichText(find(await importPresentation(simpleOut.bytes)))),'Uniform paragraph creation preserves live/reopen style');action(oneStyle,'Only');check(direct((await saved(oneStyle)).body,'p').length===1,'Uniform imported paragraphs may delete paragraph boundaries');
   const duplicateWords=await editor(await modified(wrap(p(r('foo ')+r('foo').replace('sz="2000"','sz="3600"')))));action(duplicateWords,'foo');const duplicateOut=await saved(duplicateWords);check(eq(runTexts(duplicateOut.body),[['foo','']]),'Ambiguous repeated text uses deterministic common-prefix affinity, not a claim of native caret intent');check(eq(effectiveRichText(find(duplicateWords.model)),effectiveRichText(find(await importPresentation(duplicateOut.bytes)))),'Repeated-text affinity is stable after save/reopen');
   const chain=await editor(mixedBytes);chain.action({type:'update-object',id:find(chain.model).id,textStyle:{italic:true}});const obj=find(chain.model);chain.action({type:'format-text-range',id:obj.id,start:14,end:21,textStyle:{bold:true,fontSize:33},expectedText:obj.text,expectedRevision:chain.revision});const beforeChain=await saved(chain);action(chain,'Normal Rdised Lowered Zero');const afterChain=await saved(chain);check(eq(structure(beforeChain.body),structure(afterChain.body)),'Whole-frame and local styles survive later plain edits');chain.action({type:'format-paragraphs',id:find(chain.model).id,paragraphIndices:[0],paragraphStyle:{spaceBefore:{unit:'points',value:12}},expectedText:find(chain.model).text,expectedRevision:chain.revision});action(chain,'Normal Rdised Lowered Zéro');check(eq(effectiveRichText(find(chain.model)),effectiveRichText(find(await importPresentation((await saved(chain)).bytes)))),'Character/paragraph/content editing sequence has consistent live and saved formatting');
   action(chain,'Normal Raised Lowered Zéro','BASELINE_EXPLICIT',{textStyle:{color:'#883311',bold:false}});action(chain,'Normal Raised Lowered Zéro!');const combined=await saved(chain);check(effectiveRichText(find(chain.model)).every(p=>p.runs.every(r=>r.style.color==='#883311'&&!r.style.bold)),'Simultaneous text and whole-frame style followed by another edit retains newest explicit style');check(eq(effectiveRichText(find(chain.model)),effectiveRichText(find(await importPresentation(combined.bytes)))),'Simultaneous content/style action and later content edit agree after reopen');
   const copy=await editor(mixedBytes);action(copy,'Normal Rdised Lowered Zero');const source=find(copy.model),sourceBody=(await saved(copy)).body;copy.duplicateObjects([source.id]);const duplicate=copy.model.slides[1].objects.find(o=>o.id===copy.selectedObjectIds[0]);copy.action({type:'update-object',id:duplicate.id,text:'Normal Rdised Lowered Zéro'});check(eq(canonical((await saved(copy)).body),canonical(sourceBody)),'Editing copied content leaves original override unchanged');
   for(const [label,content]of [
    ['field',`<a:fld id="id" type="slidenum"><a:rPr/><a:t>1</a:t></a:fld>`],
    ['hyperlink',`<a:r><a:rPr><a:hlinkClick xmlns:r="${R}" r:id="rIdMissing"/></a:rPr><a:t>Text</a:t></a:r>`],
    ['extension',`<a:r><a:rPr><a:extLst><a:ext uri="unknown"/></a:extLst></a:rPr><a:t>Text</a:t></a:r>`],
    ['symbol',`<a:r><a:rPr><a:sym typeface="Wingdings"/></a:rPr><a:t>Text</a:t></a:r>`],
    ['foreign namespace',`<x:r xmlns:x="urn:unsupported"><x:t>Text</x:t></x:r>`],
    ['CR',r('A&#13;B')],
   ]){const unsafe=await editor(await modified(wrap(p(content))));reject(unsafe,()=>action(unsafe,'Changed'),label+' protected from plain flattening');}
   const locked=await editor(mixedBytes);find(locked.model).locked=true;reject(locked,()=>action(locked,'Changed'),'Locked object');
   const animated=await editor(mixedBytes);find(animated.model).hasAnimation=true;reject(animated,()=>action(animated,'Changed'),'Animated text');
   const invalid=await editor(mixedBytes);for(const text of ['broken\ud800','broken\ufffe'])reject(invalid,()=>action(invalid,text),'Invalid XML text');
   const emptyBudget=await editor(await modified(wrap(Array.from({length:1500},()=>p('')).join(''))));reject(emptyBudget,()=>action(emptyBudget,Array.from({length:1500},()=> 'X').join('\n')),'Many empty paragraph insertions hit bounded work guard');
   const fresh=new PresentationController(createPresentation(),'fresh');fresh.action({type:'insert-text',text:'Fresh'});const freshObject=fresh.model.slides[0].objects[0];fresh.action({type:'update-object',id:freshObject.id,text:'First\nSecond'});check(fresh.model.slides[0].objects[0].text==='First\nSecond','New simple text keeps paragraph creation');
   for(const preset of ['rect','ellipse']){
    const parts=unzipSync(bytes),doc=parse(parts['ppt/slides/slide2.xml']),emptyShape=shape(doc,'BASELINE_EXPLICIT');one(emptyShape,'txBody',P).remove();one(one(emptyShape,'spPr',P),'prstGeom').setAttribute('prst',preset);parts['ppt/slides/slide2.xml']=encoder.encode(serialize(doc));
    const empty=await editor(zipSync(parts)),beforeXml=find(empty.model).sourceXml;check(find(empty.model).text===''&&!one(parse(beforeXml).documentElement,'txBody',P),`${preset}: imported shape genuinely starts without a text body`);action(empty,'First\nSecond');check(Boolean(find(empty.model).textBodyOverride)&&find(empty.model).sourceXml===beforeXml,`${preset}: first input persists a new body without mutating original shape XML`);action(empty,'First edited\nSecond');const result=await saved(empty);check(find(await importPresentation(result.bytes)).text==='First edited\nSecond',`${preset}: later input exports/reopens correctly`);check(eq(effectiveRichText(find(empty.model)),effectiveRichText(find(await importPresentation(result.bytes)))),`${preset}: first generated body has matching live/reopened styles`);
    const presentation=parse(parts['ppt/presentation.xml']);let defaults=one(presentation.documentElement,'defaultTextStyle',P);if(!defaults){defaults=presentation.createElementNS(P,'p:defaultTextStyle');presentation.documentElement.append(defaults);}defaults.innerHTML=`<a:lvl1pPr xmlns:a="${A}"><a:lnSpc><a:spcPct val="200000"/></a:lnSpc><a:spcBef><a:spcPts val="900"/></a:spcBef><a:spcAft><a:spcPct val="50000"/></a:spcAft><a:defRPr baseline="30000"/></a:lvl1pPr>`;parts['ppt/presentation.xml']=encoder.encode(serialize(presentation));
    const inheritedEmpty=await editor(zipSync(parts));action(inheritedEmpty,'First\nSecond');const inheritedResult=await saved(inheritedEmpty),inheritedReopen=await importPresentation(inheritedResult.bytes),metadata=effectiveRichText(find(inheritedEmpty.model));check(metadata.every(p=>p.lineSpacing?.unit==='percent'&&p.lineSpacing.value===2&&p.spaceBefore?.value===9&&p.spaceAfter?.value===.5&&p.runs.every(r=>r.baseline===.3)),`${preset}: empty imported shape resolves presentation paragraph/baseline defaults before first input`);check(eq(metadata,effectiveRichText(find(inheritedReopen))),`${preset}: inherited empty-shape defaults agree live/export/reopen`);
    for(const [part,data]of Object.entries(parts))if(/^ppt\/slideMasters\/[^/]+\.xml$/.test(part)){const master=parse(data),other=one(one(master.documentElement,'txStyles',P),'otherStyle',P);let level=one(other,'lvl1pPr');if(!level){level=master.createElementNS(A,'a:lvl1pPr');other.append(level);}level.innerHTML=`<a:lnSpc xmlns:a="${A}"><a:spcPct val="0"/></a:lnSpc><a:spcBef xmlns:a="${A}"><a:spcPts val="0"/></a:spcBef><a:spcAft xmlns:a="${A}"><a:spcPts val="0"/></a:spcAft><a:defRPr xmlns:a="${A}" baseline="0"/>`;parts[part]=encoder.encode(serialize(master));}
    const zeroEmpty=await editor(zipSync(parts));action(zeroEmpty,'First\nSecond');const zeroResult=await saved(zeroEmpty),zeroMetadata=effectiveRichText(find(zeroEmpty.model));check(zeroMetadata.every(p=>p.lineSpacing?.value===0&&p.spaceBefore?.value===0&&p.spaceAfter?.value===0&&p.runs.every(r=>r.baseline===0)),`${preset}: master explicit zero overrides nonzero presentation defaults for a new body`);check(eq(zeroMetadata,effectiveRichText(find(await importPresentation(zeroResult.bytes)))),`${preset}: inherited explicit zero is stable after export/reopen`);
   }
   check(slideSvg(chain.model,chain.model.slides[chain.currentPageIndex]).includes('<svg'),'Edited mixed text renders through shared SVG scene');
   return {checks,rejected,artifacts};
  },fixture.toString('base64'));
  const artifacts=result.artifacts.map(file=>{const data=Buffer.from(file.base64,'base64');fs.writeFileSync(path.join(out,file.name),data);return {path:file.name,sha256:sha(data)};});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);const report={status:'passed',fixtureSha256:sha(fixture),checks:result.checks,rejected:result.rejected,artifacts,errors,external};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,rejected:report.rejected.length,errors,external}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
