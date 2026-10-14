// Independently authored OOXML fixture -> production importer/scene/exporter.
// Numeric assertions are distinct from optional native reference screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(root, 'tests/compatibility/presentation-typography');
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'))).items[0];
const input = fs.readFileSync(path.join(fixtureRoot, fixture.path));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
assert.equal(digest(input), fixture.sha256);
const out = path.join(root, 'test-results/presentation-typography');
const caseOut = path.join(out, fixture.id);
fs.mkdirSync(caseOut, { recursive: true });

(async () => {
 const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!/^(http:\/\/127\.0\.0\.1:5198\/|data:|blob:http:\/\/127\.0\.0\.1:5198\/)/.test(request.url())) external.push(request.url()); });
  await page.goto('http://127.0.0.1:5198/');
  const result = await page.evaluate(async base64 => {
   const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
   const { PresentationController } = await import('/src/presentation/core/model.ts');
   const { buildSlideScene } = await import('/src/presentation/core/scene.ts');
   const { slideSvg } = await import('/src/presentation/core/render.ts');
   const { effectiveRichText } = await import('/src/presentation/core/rich-text.ts');
   const { exportPresentationPdf } = await import('/src/presentation/core/pdf.ts');
   const { readPptxParts } = await import('/src/presentation/pptx-package.ts');
   const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
   const encode = bytes => { let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(binary); };
   const checks=[], check=(condition,message)=>{ if(!condition) throw Error(message); checks.push(message); };
   const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b), near=(a,b)=>Math.abs(a-b)<1e-6;
   const find=(model,name)=>model.slides.flatMap(slide=>slide.objects).find(object=>object.name===name);
   const flat=nodes=>nodes.flatMap(node=>node.kind==='group'?flat(node.children):[node]);
   const textNodes=(model,name)=>{
    const object=find(model,name);
    return flat(buildSlideScene(model,{...model.slides[0],objects:[object]})).filter(node=>node.kind==='text');
   };
   const model=await importPresentation(bytes);
   check(model.slides.length===4,'Four independently authored slides import');
   for (const [name,unit,value] of [['LINE_90','percent',.9],['LINE_150','percent',1.5],['LINE_FIXED','points',12]]) {
    const p=find(model,name).richText.paragraphs;
    check(p.length===2 && p[0].lineSpacing.unit===unit && p[0].lineSpacing.value===value, `${name}: point and percentage line spacing remain distinct`);
    check(equal(p[0].spaceBefore,{unit:'points',value:6}) && equal(p[0].spaceAfter,{unit:'points',value:8}),`${name}: independent before/after spacing retained`);
   }
   const fixed=textNodes(model,'LINE_FIXED');
   check(fixed.length===4 && near(fixed[1].y-fixed[0].y,12*25.4/72) && near(fixed[2].y-fixed[1].y,12*25.4/72),'24pt glyphs keep exact 12pt baseline advances without forced expansion');
   const compact=textNodes(model,'LINE_90'),expanded=textNodes(model,'LINE_150');
   check(near((expanded[1].y-expanded[0].y)/(compact[1].y-compact[0].y),1.5/.9),'90% and 150% spacing produce the requested relative baseline distances');
   check(near((compact[3].y-compact[2].y)-(compact[1].y-compact[0].y),8*25.4/72),'Adjacent 8pt after and 6pt before collapse to an 8pt gap, not 14pt');
   const base=find(model,'BASELINE_EXPLICIT'),runs=base.richText.paragraphs[0].runs;
   check(equal(runs.map(run=>run.baseline),[0,.3,-.25,0]),'Positive, negative and explicit-zero baseline are numeric metadata');
   const script=textNodes(model,'BASELINE_EXPLICIT');
   check(near(script[0].y-script[1].y,26*.3*25.4/72) && near(script[2].y-script[0].y,26*.25*25.4/72) && near(script[3].y,script[0].y),'Shared scene positions raised, lowered and baseline-zero runs at exact requested offsets');
   check(script.every(run=>near(run.size,26*25.4/72)),'Explicit stored font sizes are not rewritten or silently shrunk');
   const fractional=find(model,'BASELINE_FRACTIONAL').richText.paragraphs[0].runs;
   check(fractional[1].baseline===.18 && fractional[2].baseline===-.1 && fractional[3].style.fontSize===12.34,'Arbitrary baseline fractions and fractional font sizes retain precision');
   const inherited=find(model,'INHERITED').richText.paragraphs;
   check(inherited[0].runs[0].baseline===.3 && inherited[0].runs[1].baseline===0,'Explicit zero clears an inherited raised baseline');
   check(inherited[0].lineSpacing.value===1.5 && inherited[1].lineSpacing.value===1 && inherited[1].spaceBefore.value===0 && inherited[1].spaceAfter.value===0,'Local paragraph defaults override inherited spacing including zeros');
   check(inherited[2].runs.length===0 && inherited[2].style.fontSize===37.2 && inherited[2].baseline===0,'Empty paragraph uses its own end properties');
   const mixedFixed=textNodes(model,'MIXED_FIXED');
   check(mixedFixed.length===3 && near(mixedFixed[1].y-mixedFixed[0].y,12*25.4/72) && near(mixedFixed[2].y-mixedFixed[1].y,12*25.4/72),'12pt, 42pt and 18pt glyphs use the same requested fixed baseline advance');
   const outerOff=textNodes(model,'OUTER_0'),outerOn=textNodes(model,'OUTER_1');
   check(find(model,'OUTER_0').richText.spaceFirstLastParagraph===false && find(model,'OUTER_1').richText.spaceFirstLastParagraph===true && near(outerOn[0].y-outerOff[0].y,12*25.4/72),'bodyPr first/last paragraph switch applies the explicit 12pt leading space');
   const xmlTree=element=>({name:element.namespaceURI+':'+element.localName,attributes:[...element.attributes].filter(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(a=>[a.namespaceURI+':'+a.localName,a.value]).sort((a,b)=>a[0].localeCompare(b[0])),children:[...element.childNodes].map(n=>n.nodeType===1?xmlTree(n):n.nodeType===3?n.textContent:null).filter(n=>n!==null)});
   const textBodies=data=>[...new DOMParser().parseFromString(new TextDecoder().decode(data),'application/xml').getElementsByTagNameNS('*','txBody')].map(xmlTree);
   const snapshot=m=>m.slides.map(s=>s.objects.filter(o=>o.richText).map(o=>[o.name,effectiveRichText(o),o.richText.spaceFirstLastParagraph]));
   const artifacts=[];
   let cycle=model;
   for(let n=1;n<=3;n++) {
    const saved=await exportPresentation(cycle),reopened=await importPresentation(saved);
    check(equal(snapshot(reopened),snapshot(model)),`Save/reopen cycle ${n} preserves all spacing and baseline metadata`);
    const parts=await readPptxParts(saved),source=await readPptxParts(bytes);
    check([1,2,3,4].every(i=>equal(textBodies(parts.get(`ppt/slides/slide${i}.xml`)),textBodies(source.get(`ppt/slides/slide${i}.xml`)))),`Save/reopen cycle ${n} preserves every original text-body XML attribute and child`);
    artifacts.push({name:`noop-${n}.pptx`,data:encode(saved)});cycle=reopened;
   }
   const controller=new PresentationController(model,'typography-spacing');
   controller.action({type:'select-page',pageIndex:1});
   controller.action({type:'update-object',id:base.id,textStyle:{bold:true}});
   const styled=await exportPresentation(controller.model),styledModel=await importPresentation(styled);
   check(equal(effectiveRichText(find(styledModel,'BASELINE_EXPLICIT')),effectiveRichText(find(controller.model,'BASELINE_EXPLICIT'))),'Toolbar style edit keeps baseline and matches the reopened file');
   artifacts.push({name:'styled.pptx',data:encode(styled)});
   controller.action({type:'update-object',id:base.id,text:'Edited normal paragraph'});
   const edited=await exportPresentation(controller.model),editedModel=await importPresentation(edited);
   check(equal(effectiveRichText(find(editedModel,'BASELINE_EXPLICIT')),effectiveRichText(find(controller.model,'BASELINE_EXPLICIT'))),'Plain-text edit uses matching paragraph style and baseline when reopened');
   artifacts.push({name:'edited.pptx',data:encode(edited)});
   const svg=model.slides.map(slide=>slideSvg(model,slide));
   return {checks,artifacts,svg,pdf:encode(await exportPresentationPdf(model)),scene:{fixed,compact,expanded,script}};
  },input.toString('base64'));
  assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
  for(const artifact of result.artifacts) fs.writeFileSync(path.join(caseOut,artifact.name),Buffer.from(artifact.data,'base64'));
  fs.writeFileSync(path.join(caseOut,'preview.pdf'),Buffer.from(result.pdf,'base64'));
  for(const [index,svg] of result.svg.entries()) {
   fs.writeFileSync(path.join(caseOut,`slide-${index+1}.svg`),svg);
   await page.setContent(`<main style="margin:0;background:#e8edf1;padding:15px">${svg}</main>`);
   await page.screenshot({path:path.join(caseOut,`slide-${index+1}.png`)});
  }
  const report={ok:true,source:{path:path.relative(root,path.join(fixtureRoot,fixture.path)),sha256:digest(input)},checks:result.checks,scene:result.scene,externalRequests:external,errors,limitations:['Native reference screenshots evaluated separately, no pixel-equality assertion.','The reference application collapses baseline values to fixed script styles; this implementation preserves numeric DrawingML offsets and explicit font sizes.','Font fallback and advanced typography still prevent a universal fidelity claim.']};
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:true,checks:result.checks.length,output:out}));
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
