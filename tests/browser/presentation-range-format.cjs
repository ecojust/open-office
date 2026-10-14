/* Independent OOXML character-range oracle. Fixture bytes are pinned, package
 * reads/writes use fflate directly, and all mutations run in the real browser. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(root, 'tests/compatibility/presentation-typography');
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'))).items[0];
const input = fs.readFileSync(path.join(fixtureRoot, fixture.path));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
assert.equal(sha(input), fixture.sha256);
const output = path.resolve(root, process.env.PRESENTATION_RANGE_OUTPUT || 'test-results/presentation-range-format');
fs.mkdirSync(output, { recursive: true });
const url = process.env.PRESENTATION_URL || 'http://127.0.0.1:5198/';
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
 try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.text().startsWith('RANGE:'))console.log(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(new URL(url).origin + '/') && !/^(data:|blob:)/.test(request.url())) external.push(request.url()); });
  await page.goto(url);
  const result = await page.evaluate(async base64 => {
   const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
   const { PresentationController, createPresentation } = await import('/src/presentation/core/model.ts');
   const { effectiveRichText } = await import('/src/presentation/core/rich-text.ts');
   const { objectFingerprint } = await import('/src/presentation/core/pptx-common.ts');
   const { collectPresentationFonts } = await import('/src/presentation/core/font-diagnostics.ts');
   const { slideSvg } = await import('/src/presentation/core/render.ts');
   const { zipSync, unzipSync } = await import('/node_modules/fflate/esm/browser.js');
   const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
   const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
   const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
   const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
   const XML = 'http://www.w3.org/XML/1998/namespace';
   const decoder = new TextDecoder(), encoder = new TextEncoder();
   const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
   const source = unzipSync(bytes), checks = [], rejected = [], artifacts = [];
   const check = (condition, message) => { if (!condition) throw Error(message); checks.push(message); };
   // Optional style keys can be inserted in a different order by live edits
   // and XML import. Compare object values; retain exact array/run ordering.
   const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
   const eq = (a,b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
   const byteEq = (a,b) => a?.length === b?.length && a.every((value,index) => value === b[index]);
   const encode = data => { let value='';for(let i=0;i<data.length;i+=8192)value+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(value); };
   const parse = data => { const doc = new DOMParser().parseFromString(typeof data === 'string' ? data : decoder.decode(data),'application/xml');if(doc.querySelector('parsererror'))throw Error('Independent oracle: malformed XML');return doc; };
   const serialize = node => new XMLSerializer().serializeToString(node);
   const direct = (element,name,ns=A) => [...(element?.children || [])].filter(child => child.namespaceURI === ns && child.localName === name);
   const one = (element,name,ns=A) => direct(element,name,ns)[0];
   const canonical = node => !node ? null : ({name:`${node.namespaceURI}:${node.localName}`,attributes:[...node.attributes].filter(attr=>attr.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(attr=>[`${attr.namespaceURI || ''}:${attr.localName}`,attr.value]).sort((a,b)=>a[0].localeCompare(b[0])),children:[...node.childNodes].map(child=>child.nodeType===1?canonical(child):child.nodeType===3?child.textContent:null).filter(value=>value!==null)});
   const shapeNamed = (doc,name) => [...doc.getElementsByTagNameNS(P,'sp')].find(shape=>shape.getElementsByTagNameNS(P,'cNvPr')[0]?.getAttribute('name')===name);
   const bodyFromParts = (parts,part,name) => one(shapeNamed(parse(parts[part]),name),'txBody',P);
   const find = (model,name) => model.slides.flatMap(slide=>slide.objects).find(object=>object.name===name);
   const controller = async (data,name='BASELINE_EXPLICIT') => { const editor=new PresentationController(await importPresentation(data),'range-test');const index=editor.model.slides.findIndex(slide=>slide.objects.some(object=>object.name===name));editor.action({type:'select-page',pageIndex:index});return editor; };
   const current = (editor,name='BASELINE_EXPLICIT') => find(editor.model,name);
   const range = (editor,start,end,textStyle,name='BASELINE_EXPLICIT',extra={}) => { const object=current(editor,name);return editor.action({type:'format-text-range',id:object.id,start,end,textStyle,expectedText:object.text,expectedRevision:editor.revision,...extra}); };
   const snapshotSource = model => [...model.sourceParts].map(([name,data])=>[name,encode(data)]);
   const snapshotModel = editor => JSON.stringify({model:editor.model,page:editor.currentPageIndex,revision:editor.revision,dirty:editor.dirty});
   const expectRejected = (editor,operation,label) => { const before=snapshotModel(editor),packageBefore=editor.model.sourceParts?snapshotSource(editor.model):[];let message='';try{operation();}catch(error){message=error.message;}check(Boolean(message),`${label}: action rejects`);check(snapshotModel(editor)===before && eq(editor.model.sourceParts?snapshotSource(editor.model):[],packageBefore),`${label}: rejection leaves model/revision/package state unchanged`);rejected.push({label,message}); };
   const tokens = body => {
    const values=[];
    for(const [paragraphIndex,paragraph] of direct(body,'p').entries()) {
     if(paragraphIndex)values.push({text:'\n',kind:'paragraph'});
     for(const child of paragraph.children) {
      if(child.namespaceURI!==A)continue;
      if(child.localName==='r') { const props=one(child,'rPr'),text=one(child,'t')?.textContent || '';for(let index=0;index<text.length;index++)values.push({text:text[index],kind:'run',props}); }
      if(child.localName==='br')values.push({text:'\n',kind:'break',props:one(child,'rPr')});
     }
    }
    return values;
   };
   const invariantBody = body => ({body:canonical(one(body,'bodyPr')),list:canonical(one(body,'lstStyle')),paragraphs:direct(body,'p').map(paragraph=>({props:canonical(one(paragraph,'pPr')),end:canonical(one(paragraph,'endParaRPr'))}))});
   const scrubProperties = (props,style) => {
    const copy=props?.cloneNode(true);if(!copy)return null;
    for(const [key,attr] of [['bold','b'],['italic','i'],['underline','u'],['fontSize','sz']])if(Object.hasOwn(style,key))copy.removeAttribute(attr);
    if(Object.hasOwn(style,'color'))for(const child of [...copy.children])if(['solidFill','noFill','gradFill','blipFill','pattFill','grpFill'].includes(child.localName))child.remove();
    if(Object.hasOwn(style,'fontName'))for(const child of [...copy.children])if(['latin','ea','cs'].includes(child.localName))child.remove();
    if(![...copy.attributes].some(attribute=>attribute.namespaceURI!=='http://www.w3.org/2000/xmlns/') && !copy.childNodes.length)return null;
    return canonical(copy);
   };
   const directStyle = (props,key) => {
    if(key==='fontSize')return Number(props?.getAttribute('sz'))/100;
    if(key==='fontName')return one(props,'latin')?.getAttribute('typeface');
    if(key==='color')return '#'+one(one(props,'solidFill'),'srgbClr')?.getAttribute('val').toUpperCase();
    if(key==='underline')return props?.getAttribute('u')==='sng';
    return ['1','true'].includes(props?.getAttribute(key==='bold'?'b':'i'));
   };
   const assertMutation = (beforeBody,afterBody,start,end,style,label) => {
    const before=tokens(beforeBody),after=tokens(afterBody);
    check(before.map(t=>t.text).join('')===after.map(t=>t.text).join(''),`${label}: full UTF16 text and paragraph/break separators unchanged`);
    check(eq(invariantBody(beforeBody),invariantBody(afterBody)),`${label}: paragraph spacing, list defaults, end properties and body properties preserved`);
    for(let index=0;index<before.length;index++) {
     check(before[index].kind===after[index].kind,`${label}: token ${index} keeps its original structural kind`);
     if(before[index].kind!=='run')continue;
     if(index>=start && index<end) {
      if(!eq(scrubProperties(before[index].props,style),scrubProperties(after[index].props,style)))throw Error(`${label}: unrelated run property changed at UTF16 ${index}`);
      for(const [key,value] of Object.entries(style))if(directStyle(after[index].props,key)!==(key==='color'?value.toUpperCase():value))throw Error(`${label}: selected ${key} mismatch at UTF16 ${index}`);
     } else if(!eq(canonical(before[index].props),canonical(after[index].props)))throw Error(`${label}: unselected run properties changed at UTF16 ${index}`);
    }
    checks.push(`${label}: every selected character has only requested formatting changes; all unselected run properties remain identical`);
   };
   const bodyBytes = async (model,part='ppt/slides/slide2.xml',name='BASELINE_EXPLICIT') => {const saved=await exportPresentation(model),parts=unzipSync(saved);const actualPart=parts[part]?part:Object.keys(parts).find(path=>/^ppt\/slides\/[^/]+\.xml$/.test(path) && shapeNamed(parse(parts[path]),name));return {saved,parts,part:actualPart,body:bodyFromParts(parts,actualPart,name)};};
   const comparePackages = (before,after,allowed,label) => {check(eq(Object.keys(before).sort(),Object.keys(after).sort()),`${label}: package parts unchanged`);const changes=Object.keys(before).filter(name=>!byteEq(before[name],after[name]));check(changes.every(name=>allowed.includes(name)),`${label}: only expected slide XML changed (${changes.join(', ')})`);};
   const derived = {...source};
   const decorated=parse(derived['ppt/slides/slide2.xml']),originalBody=one(shapeNamed(decorated,'BASELINE_EXPLICIT'),'txBody',P),paragraph=direct(originalBody,'p')[0];
   const pPr=one(paragraph,'pPr');pPr.innerHTML='<a:lnSpc xmlns:a="'+A+'"><a:spcPts val="1777"/></a:lnSpc><a:spcBef xmlns:a="'+A+'"><a:spcPts val="650"/></a:spcBef><a:spcAft xmlns:a="'+A+'"><a:spcPct val="80000"/></a:spcAft>';
   const special=one(direct(paragraph,'r')[1],'rPr');for(const [name,value]of Object.entries({lang:'en-US',kern:'1200',spc:'80',strike:'sngStrike',cap:'small'}))special.setAttribute(name,value);
   const highlight=decorated.createElementNS(A,'a:highlight'),highlightColor=decorated.createElementNS(A,'a:srgbClr');highlightColor.setAttribute('val','FFE080');highlight.append(highlightColor);special.append(highlight);
   derived['ppt/slides/slide2.xml']=encoder.encode(serialize(decorated));
   const fixtureBytes=zipSync(derived),initial=await controller(fixtureBytes),initialObject=current(initial),immutableParts=initial.model.sourceParts,immutable=snapshotSource(initial.model),sourceXml=initialObject.sourceXml;
   console.info('RANGE: source imported');
   artifacts.push({name:'range-source.pptx',data:encode(fixtureBytes)});
   check(initialObject.text==='Normal Raised Lowered Zero','Independent fixture has exact mixed-run source text');
   const noop=await bodyBytes(initial.model),beforeFingerprint=objectFingerprint(initialObject);
   const plans=[{start:3,end:17,style:{bold:true,color:'#A523D1',fontSize:31.25}},{start:7,end:13,style:{italic:true,underline:true}},{start:16,end:21,style:{fontName:'Arial',bold:false}}];
   let editor=initial,prior=noop;
   for(const [index,plan]of plans.entries()) {
    const beforeEditor=current(editor),beforeXml=beforeEditor.sourceXml,beforeParts=editor.model.sourceParts,beforeMap=snapshotSource(editor.model);
    range(editor,plan.start,plan.end,plan.style);
    const editedObject=current(editor);
    check(editedObject.textBodyOverride?.xml && editedObject.textBodyOverride.text===editedObject.text,`Cycle ${index+1}: persistent override tracks current committed text`);
    check(editedObject.sourceXml===beforeXml && editor.model.sourceParts===beforeParts && eq(snapshotSource(editor.model),beforeMap),`Cycle ${index+1}: original source XML and package bytes stay immutable`);
    const saved=await bodyBytes(editor.model);
    assertMutation(prior.body,saved.body,plan.start,plan.end,plan.style,`Cycle ${index+1}`);
    comparePackages(prior.parts,saved.parts,['ppt/slides/slide2.xml'],`Cycle ${index+1}`);
    const displayed=effectiveRichText(editedObject),reopened=await importPresentation(saved.saved);
    check(eq(effectiveRichText(find(reopened,'BASELINE_EXPLICIT')),displayed),`Cycle ${index+1}: exported native runs match live displayed formatting`);
    const stable=await bodyBytes(reopened);
    check(eq(canonical(stable.body),canonical(saved.body)),`Cycle ${index+1}: no-op save after reopening retains exact run XML structure`);
    artifacts.push({name:`range-cycle-${index+1}.pptx`,data:encode(saved.saved)});
    console.info(`RANGE: cycle ${index+1} passed`);
    editor=new PresentationController(reopened,`range-cycle-${index+1}`);editor.action({type:'select-page',pageIndex:1});prior=stable;
   }
   check(objectFingerprint(current(initial))!==beforeFingerprint,'Semantic range override participates in the edit fingerprint');
   check(initial.model.sourceParts===immutableParts && eq(snapshotSource(initial.model),immutable) && current(initial).sourceXml===sourceXml,'Original fixture bytes remain immutable after export and other documents');
   const history=await controller(fixtureBytes),oldBody=await bodyBytes(history.model),oldModel=JSON.stringify(history.model);
   range(history,2,12,{bold:true});const changed=JSON.stringify(history.model),changedBody=await bodyBytes(history.model);
   history.undo();check(JSON.stringify(history.model)===oldModel,'Undo restores original model and clears range override');
   check(eq(canonical((await bodyBytes(history.model)).body),canonical(oldBody.body)),'Undo exports original text body without residual split runs');
   history.redo();check(JSON.stringify(history.model)===changed,'Redo restores exact range override and derived rich display');
   check(eq(canonical((await bodyBytes(history.model)).body),canonical(changedBody.body)),'Redo exports the original edited run structure');
   const stale={type:'format-text-range',id:current(history).id,start:1,end:2,textStyle:{bold:false},expectedText:current(history).text,expectedRevision:history.revision};
   range(history,3,5,{italic:true});expectRejected(history,()=>history.action(stale),'Stale document revision');
   for(const [label,start,end,style,extra]of [
    ['negative range',-1,3,{bold:true},{}],['reversed range',4,2,{bold:true},{}],['empty range',2,2,{bold:true},{}],['overflow range',0,1000,{bold:true},{}],['fractional range',.5,2,{bold:true},{}],['nonfinite range',0,Infinity,{bold:true},{}],['empty style',0,2,{},{}],['paragraph alignment through range',0,2,{align:'center'},{}],['bad color',0,2,{color:'red'},{}],['bad size',0,2,{fontSize:NaN},{}],['font lone surrogate',0,2,{fontName:'Broken\ud800'},{}],['font forbidden XML character',0,2,{fontName:'Broken\ufffe'},{}],['nonboolean style',0,2,{bold:'true'},{}],['mismatched expected text',0,2,{bold:true},{expectedText:'stale'}],['missing expected text',0,2,{bold:true},{expectedText:undefined}],['missing expected revision',0,2,{bold:true},{expectedRevision:undefined}]
   ])expectRejected(history,()=>range(history,start,end,style,'BASELINE_EXPLICIT',extra),label);
   console.info('RANGE: history and invalid actions passed');
   // Whole-frame/range/plain editing must operate on the current XML, never on
   // stale import offsets or original mixed-run styles.
   const chain=await controller(fixtureBytes);
   chain.action({type:'update-object',id:current(chain).id,textStyle:{italic:true,fontSize:22}});
   let baseline=await bodyBytes(chain.model);range(chain,7,13,{bold:true,color:'#167D59'});let next=await bodyBytes(chain.model);
   assertMutation(baseline.body,next.body,7,13,{bold:true,color:'#167D59'},'Whole frame then range');
   chain.action({type:'update-object',id:current(chain).id,textStyle:{bold:false,color:'#283A61'}});
   next=await bodyBytes(chain.model);
   check(tokens(next.body).filter(token=>token.kind==='run').every(token=>directStyle(token.props,'bold')===false && directStyle(token.props,'color')==='#283A61'),'Whole-frame style overrides previously formatted ranges');
   baseline=next;range(chain,1,4,{underline:true});next=await bodyBytes(chain.model);assertMutation(baseline.body,next.body,1,4,{underline:true},'Whole frame then second range');
   expectRejected(chain,()=>chain.action({type:'update-object',id:current(chain).id,text:'Plain replacement\nSecond line'}),'Mixed-run content cannot silently add a paragraph');
   chain.action({type:'update-object',id:current(chain).id,text:'Plain replacement Second line'});
   const plain=await bodyBytes(chain.model),plainModel=await importPresentation(plain.saved);
   check(current(chain).text==='Plain replacement Second line' && find(plainModel,'BASELINE_EXPLICIT').text===current(chain).text,'Plain replacement preserves committed text without stale selection offsets');
   check(eq(effectiveRichText(current(chain)),effectiveRichText(find(plainModel,'BASELINE_EXPLICIT'))),'Plain replacement preview matches its exported preserved-run formatting');
   baseline=plain;range(chain,1,6,{bold:true});next=await bodyBytes(chain.model);assertMutation(baseline.body,next.body,1,6,{bold:true},'Range after plain replacement');
   artifacts.push({name:'range-format-chain.pptx',data:encode(next.saved)});
   // Selection spanning native soft breaks, paragraph boundaries and blanks.
   const breaks=await controller(bytes,'LINE_90'),breakBefore=await bodyBytes(breaks.model,'ppt/slides/slide1.xml','LINE_90');
   const firstSeparator=current(breaks,'LINE_90').text.indexOf('\n');expectRejected(breaks,()=>range(breaks,firstSeparator,firstSeparator+1,{bold:true},'LINE_90'),'Selection contains only soft break');
   const breakText=current(breaks,'LINE_90').text;range(breaks,3,breakText.length-3,{italic:true},'LINE_90');
   const breakAfter=await bodyBytes(breaks.model,'ppt/slides/slide1.xml','LINE_90');assertMutation(breakBefore.body,breakAfter.body,3,breakText.length-3,{italic:true},'Selection spans soft breaks and paragraphs');
   artifacts.push({name:'range-breaks.pptx',data:encode(breakAfter.saved)});
   // Surrogate pair boundaries are independently positioned in source OOXML.
   const unicodeParts={...derived},unicodeDoc=parse(unicodeParts['ppt/slides/slide2.xml']);one(direct(one(shapeNamed(unicodeDoc,'BASELINE_EXPLICIT'),'txBody',P),'p')[0],'r').getElementsByTagNameNS(A,'t')[0].textContent='A😀BCDE';unicodeParts['ppt/slides/slide2.xml']=encoder.encode(serialize(unicodeDoc));
   const unicode=await controller(zipSync(unicodeParts));check(current(unicode).text.startsWith('A😀BCDE'),'Unicode fixture preserves UTF16 surrogate pair');
   expectRejected(unicode,()=>range(unicode,2,4,{bold:true}),'Split surrogate at selection start');
   expectRejected(unicode,()=>range(unicode,1,2,{bold:true}),'Split surrogate at selection end');
   const unicodeBefore=await bodyBytes(unicode.model);range(unicode,1,3,{bold:true});const unicodeAfter=await bodyBytes(unicode.model);assertMutation(unicodeBefore.body,unicodeAfter.body,1,3,{bold:true},'Whole surrogate pair selection');
   artifacts.push({name:'range-unicode.pptx',data:encode(unicodeAfter.saved)});
   const sparseParts={...derived},sparseDoc=parse(sparseParts['ppt/slides/slide2.xml']),sparseBody=one(shapeNamed(sparseDoc,'BASELINE_EXPLICIT'),'txBody',P),sparseParagraph=direct(sparseBody,'p')[0];
   for(const run of direct(sparseParagraph,'r'))run.remove();
   const defaults=sparseDoc.createElementNS(A,'a:defRPr');for(const [key,value]of Object.entries({b:'1',i:'1',u:'sng',sz:'2800',baseline:'18000'}))defaults.setAttribute(key,value);one(sparseParagraph,'pPr').append(defaults);
   const sparseRun=sparseDoc.createElementNS(A,'a:r'),sparseText=sparseDoc.createElementNS(A,'a:t');sparseText.textContent='Inherited Alpha beta';sparseRun.append(sparseText);sparseParagraph.insertBefore(sparseRun,one(sparseParagraph,'endParaRPr'));
   sparseParts['ppt/slides/slide2.xml']=encoder.encode(serialize(sparseDoc));const sparse=await controller(zipSync(sparseParts)),sparseBefore=await bodyBytes(sparse.model);range(sparse,2,10,{bold:false,underline:false});const sparseAfter=await bodyBytes(sparse.model);
   assertMutation(sparseBefore.body,sparseAfter.body,2,10,{bold:false,underline:false},'Sparse run inherits paragraph defaults');
   const sparseRuns=effectiveRichText(current(sparse))[0].runs;
   check(sparseRuns.length===3 && sparseRuns[0].style.bold && sparseRuns[0].style.underline && !sparseRuns[1].style.bold && !sparseRuns[1].style.underline && sparseRuns[2].style.bold && sparseRuns[2].style.underline && sparseRuns.every(run=>run.style.fontSize===28 && run.style.italic && run.baseline===.18),'Explicit b=0/u=none overrides only the selected inherited style while size, italic and baseline remain inherited');
   check(eq(effectiveRichText(current(sparse)),effectiveRichText(find(await importPresentation(sparseAfter.saved),'BASELINE_EXPLICIT'))),'Sparse inherited style formatting agrees after export/reopen');
   artifacts.push({name:'range-inherited.pptx',data:encode(sparseAfter.saved)});
   const precision=await controller(fixtureBytes),precisionBefore=await bodyBytes(precision.model);range(precision,2,9,{fontSize:12.345,fontName:'Courier New'});const precisionAfter=await bodyBytes(precision.model);
   assertMutation(precisionBefore.body,precisionAfter.body,2,9,{fontSize:12.35,fontName:'Courier New'},'Hundredth-point precision');
   check(eq(effectiveRichText(current(precision)),effectiveRichText(find(await importPresentation(precisionAfter.saved),'BASELINE_EXPLICIT'))),'Sub-hundredth font size is quantized identically in live preview and native XML');
   const isolatedFonts=editor=>collectPresentationFonts({...editor.model,slides:[{...editor.model.slides[1],inheritedObjects:[],objects:[current(editor)]}]}).names.sort();
   check(eq(isolatedFonts(precision),['Arial','Courier New']),'Font diagnostics include both partially replaced and remaining original fonts');
   range(precision,0,current(precision).text.length,{fontName:'Georgia'});check(eq(isolatedFonts(precision),['Georgia']),'Replacing the entire text range removes stale original fonts from diagnostics');
   artifacts.push({name:'range-font-precision.pptx',data:encode((await bodyBytes(precision.model)).saved)});
   const copy=await controller(fixtureBytes);range(copy,2,13,{color:'#C24135',bold:true});const originalCopy=current(copy),originalCopyBody=(await bodyBytes(copy.model)).body;
   copy.duplicateObjects([originalCopy.id]);const duplicateId=copy.selectedObjectIds[0],duplicate=copy.model.slides[1].objects.find(object=>object.id===duplicateId);
   check(duplicate.id!==originalCopy.id && eq(duplicate.textBodyOverride,originalCopy.textBodyOverride),'Object duplication retains range XML with independent object identity');
   copy.action({type:'format-text-range',id:duplicate.id,start:0,end:2,textStyle:{italic:true},expectedText:duplicate.text,expectedRevision:copy.revision});
   check(eq(canonical((await bodyBytes(copy.model)).body),canonical(originalCopyBody)),'Editing duplicate range never changes original object text body');
   const copiedBytes=await exportPresentation(copy.model),copiedModel=await importPresentation(copiedBytes);
   const copiedObjects=copiedModel.slides[1].objects.filter(object=>object.name==='BASELINE_EXPLICIT');check(copiedObjects.length===2 && !eq(effectiveRichText(copiedObjects[0]),effectiveRichText(copiedObjects[1])),'Independent duplicate styles survive native package export/reopen');
   artifacts.push({name:'range-object-copy.pptx',data:encode(copiedBytes)});
   const pageCopy=await controller(fixtureBytes);range(pageCopy,1,5,{italic:true});pageCopy.action({type:'duplicate-page',pageIndex:1});const pageCopyBytes=await exportPresentation(pageCopy.model),pageCopyModel=await importPresentation(pageCopyBytes);
   check(pageCopyModel.slides.length===5 && eq(effectiveRichText(pageCopyModel.slides[1].objects.find(object=>object.name==='BASELINE_EXPLICIT')),effectiveRichText(pageCopyModel.slides[2].objects.find(object=>object.name==='BASELINE_EXPLICIT'))),'Whole-page copy retains range formatting and valid remapped source identity');
   artifacts.push({name:'range-page-copy.pptx',data:encode(pageCopyBytes)});
   // Unsafe source constructs are never flattened or silently rewritten.
   const badCases=[
    ['cached field',(doc,body)=>{const run=direct(direct(body,'p')[0],'r')[0],field=doc.createElementNS(A,'a:fld');field.setAttribute('id','{00000000-0000-0000-0000-000000000001}');field.setAttribute('type','slidenum');for(const child of [...run.childNodes])field.append(child);run.replaceWith(field);}],
    ['hyperlink',(doc,body)=>{const link=doc.createElementNS(A,'a:hlinkClick');link.setAttributeNS(R,'r:id','rIdUnsafe');one(direct(direct(body,'p')[0],'r')[0],'rPr').append(link);}],
    ['relationship-bearing run',(doc,body)=>{one(direct(direct(body,'p')[0],'r')[0],'rPr').setAttributeNS(R,'r:embed','rIdUnsafe');}],
    ['picture bullet',(doc,body)=>{const picture=doc.createElementNS(A,'a:buBlip'),blip=doc.createElementNS(A,'a:blip');blip.setAttributeNS(R,'r:embed','rIdUnsafe');picture.append(blip);one(direct(body,'p')[0],'pPr').append(picture);}],
    ['extension payload',(doc,body)=>{const ext=doc.createElementNS(A,'a:extLst');one(direct(direct(body,'p')[0],'r')[0],'rPr').append(ext);}],
    ['foreign namespace run',(doc,body)=>{const run=direct(direct(body,'p')[0],'r')[0],foreign=doc.createElementNS('urn:foreign','x:r');for(const child of [...run.childNodes])foreign.append(child);run.replaceWith(foreign);}],
    ['foreign namespace attribute',(doc,body)=>{one(direct(direct(body,'p')[0],'r')[0],'rPr').setAttributeNS('urn:foreign','x:tracking','5');}],
    ['nested text element',(doc,body)=>{const text=one(direct(direct(body,'p')[0],'r')[0],'t'),nested=doc.createElementNS(A,'a:t');nested.textContent='Nested';text.append(nested);}],
    ['symbol font',(doc,body)=>{const symbol=doc.createElementNS(A,'a:sym');symbol.setAttribute('typeface','Wingdings');one(direct(direct(body,'p')[0],'r')[0],'rPr').append(symbol);}],
    ['existing text animation',(doc)=>{const shape=shapeNamed(doc,'BASELINE_EXPLICIT'),shapeId=shape.getElementsByTagNameNS(P,'cNvPr')[0].getAttribute('id'),timing=doc.createElementNS(P,'p:timing'),list=doc.createElementNS(P,'p:tnLst'),behavior=doc.createElementNS(P,'p:anim'),common=doc.createElementNS(P,'p:cBhvr'),target=doc.createElementNS(P,'p:tgtEl'),shapeTarget=doc.createElementNS(P,'p:spTgt');shapeTarget.setAttribute('spid',shapeId);target.append(shapeTarget);common.append(target);behavior.append(common);list.append(behavior);timing.append(list);doc.documentElement.append(timing);}],
    ['carriage return',(doc,body)=>{one(direct(direct(body,'p')[0],'r')[0],'t').textContent='A\rB';}]
   ];
   for(const [label,mutate]of badCases) {
    const parts={...derived},doc=parse(parts['ppt/slides/slide2.xml']),body=one(shapeNamed(doc,'BASELINE_EXPLICIT'),'txBody',P);mutate(doc,body);parts['ppt/slides/slide2.xml']=encoder.encode(serialize(doc).replace(/\r/g,'&#13;'));
    const bad=await controller(zipSync(parts));if(label==='carriage return')check(current(bad).text.includes('\r'),'CR fixture uses a numeric XML character reference, not a normalized literal line ending');expectRejected(bad,()=>range(bad,0,1,{bold:true}),label);
    console.info(`RANGE: rejected ${label}`);
   }
   // Test new action budgets directly; large-package import performance is a
   // separate existing subsystem and is intentionally not timed in this suite.
   for(const [label,count]of [['action text character budget',100001],['action run/element budget',10001]]) {
    const budget=await controller(fixtureBytes),object=current(budget),doc=parse(object.sourceXml),body=one(doc.documentElement,'txBody',P),paragraph=direct(body,'p')[0];
    for(const run of direct(paragraph,'r'))run.remove();
    const run=doc.createElementNS(A,'a:r'),text=doc.createElementNS(A,'a:t');text.textContent=label.includes('character')?'x'.repeat(count):'x';run.append(text);
    const fragment=doc.createDocumentFragment();for(let index=0;index<(label.includes('character')?1:count);index++)fragment.append(run.cloneNode(true));paragraph.insertBefore(fragment,one(paragraph,'endParaRPr'));
    object.sourceXml=serialize(doc);object.text='x'.repeat(count);
    expectRejected(budget,()=>range(budget,0,1,{bold:true}),label);console.info(`RANGE: rejected ${label}`);
   }
   // Locally created text objects use the same range path without source XML.
   const fresh=new PresentationController(createPresentation(),'new-range');fresh.action({type:'insert-text',text:'Fresh ABC text'});const freshObject=fresh.model.slides[0].objects[0],freshBefore=await bodyBytes(fresh.model,'ppt/slides/slide1.xml',freshObject.name);fresh.action({type:'format-text-range',id:freshObject.id,start:6,end:9,textStyle:{bold:true,color:'#145DA0'},expectedText:freshObject.text,expectedRevision:fresh.revision});
   // New text may omit the optional opaque default; an imported explicit
   // solid records it as one. Keep semantic comparison sensitive to zero.
   const visibleRuns=object=>effectiveRichText(object).map(paragraph=>paragraph.runs.map(run=>({text:run.text,style:{...run.style,opacity:run.style.opacity??1,underlineStyle:run.style.underlineStyle??(run.style.underline?'single':'none'),strike:run.style.strike??'none'},baseline:run.baseline||0,kind:run.kind||'run'})));
   const freshBytes=await exportPresentation(fresh.model),freshOpened=await importPresentation(freshBytes);check(eq(visibleRuns(fresh.model.slides[0].objects[0]),visibleRuns(freshOpened.slides[0].objects[0])),'Fresh text without imported XML supports persistent selected formatting');
   assertMutation(freshBefore.body,bodyFromParts(unzipSync(freshBytes),freshBefore.part,freshObject.name),6,9,{bold:true,color:'#145DA0'},'Fresh local text range');
   artifacts.push({name:'range-new-text.pptx',data:encode(freshBytes)});
   return {checks,rejected,artifacts,svg:slideSvg(editor.model,editor.model.slides[1]),source:fixtureBytes.length};
  },input.toString('base64'));
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  for(const artifact of result.artifacts)fs.writeFileSync(path.join(output,artifact.name),Buffer.from(artifact.data,'base64'));
  fs.writeFileSync(path.join(output,'range-preview.svg'),result.svg);
  await page.setContent(`<main style="margin:0;padding:12px;background:#e5e9ef">${result.svg}</main>`);await page.screenshot({path:path.join(output,'range-preview.png')});
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,source:{path:path.relative(root,path.join(fixtureRoot,fixture.path)),sha256:sha(input)},checks:result.checks,rejected:result.rejected,artifacts:result.artifacts.map(item=>item.name),externalRequests:external,pageErrors:errors,limits:['Character/run budget cases exercise the new action layer directly; large-document import performance is outside this suite.','Reference-editor open/re-save is a separate acceptance step.','Fields, links, relationship-bearing text, symbol fonts and unsafe XML remain rejected.','This test proves bounded character-format edits, not universal typography or text-layout fidelity.']},null,2));
  console.log(JSON.stringify({ok:true,checks:result.checks.length,rejected:result.rejected.length,output}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
