import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPresentation, PresentationController } from '../src/presentation/core/model.ts'
import { textDecorationLines, textDecorationBounds, underlineKind } from '../src/presentation/core/text-decorations.ts'
import { effectiveRichText } from '../src/presentation/core/rich-text.ts'
import { buildSlideScene } from '../src/presentation/core/scene.ts'
import { slideSvg } from '../src/presentation/core/render.ts'
import { exportPresentationPdf } from '../src/presentation/core/pdf.ts'
import { generatedTextBody } from '../src/presentation/core/pptx-text.ts'
const make = () => { const c = new PresentationController(createPresentation(), 'decorations'); c.action({type:'insert-text',text:'ABCD',x:12,y:15,width:150,height:50,textStyle:{fontSize:36,color:'#000000'}}); return c }
const object = c => c.model.slides[0].objects[0]
const change = (c,textStyle) => c.action({type:'update-object',id:object(c).id,textStyle})
const leaves = (nodes,alpha=1) => nodes.flatMap(node=>node.kind==='group'?leaves(node.children,alpha*(node.opacity??1)):[{node,alpha}])

test('decoration actions normalize the legacy toggle, reject conflicting patches atomically, and undo both forms', () => {
 const c=make();change(c,{underlineStyle:'double',strike:'double'});assert.equal(object(c).textStyle.underline,true);assert.equal(object(c).textStyle.underlineStyle,'double');
 change(c,{bold:true});assert.equal(object(c).textStyle.underlineStyle,'double');
 change(c,{underline:true});assert.equal(object(c).textStyle.underlineStyle,'single');assert.equal(object(c).textStyle.strike,'double');
 change(c,{underline:false});assert.equal(underlineKind(object(c).textStyle),'none');c.undo();assert.equal(underlineKind(object(c).textStyle),'single');c.undo();assert.equal(underlineKind(object(c).textStyle),'double');c.redo();
 for(const textStyle of [{underlineStyle:'wavy'},{strike:'triple'},{underline:false,underlineStyle:'double'},{underline:true,underlineStyle:'none'}]) {const before=JSON.stringify(c.model);assert.throws(()=>change(c,textStyle));assert.equal(JSON.stringify(c.model),before)}
})

test('optional style additions affect mixed runs without changing their opacity or source baseline', () => {
 const c=make(),o=object(c),base={...o.textStyle};o.richText={sourceText:'ABCD',sourceStyle:base,paragraphs:[{style:base,runs:[{text:'AB',style:{...base,opacity:.2}},{text:'CD',style:{...base,opacity:.8}}]}]};
 change(c,{underlineStyle:'double',strike:'single'});const runs=effectiveRichText(object(c))[0].runs;
 assert.deepEqual(runs.map(r=>[r.style.underlineStyle,r.style.strike,r.style.opacity]),[['double','single',.2],['double','single',.8]]);assert.equal(base.strike,undefined)
 assert.match(generatedTextBody(object(c)),/u="dbl" strike="sngStrike"/)
})

test('vector geometry preserves double rails, shifted baselines, per-run alpha and zero-alpha spacing', () => {
 const c=make(),o=object(c),base={...o.textStyle};o.richText={sourceText:'ABCD',sourceStyle:base,paragraphs:[{style:base,runs:[{text:'AB',baseline:.3,style:{...base,opacity:0,underline:true,underlineStyle:'double',strike:'single'}},{text:'CD',style:{...base,opacity:.8,underline:true,underlineStyle:'single',strike:'double'}}]}]};
 const scene=buildSlideScene(c.model,c.model.slides[0]),flat=leaves(scene),text=flat.filter(x=>x.node.kind==='text'),paths=flat.filter(x=>x.node.kind==='path'&&x.node.decoration);
 assert.equal(paths.length,6);assert.deepEqual(text.map(x=>x.alpha),[0,.8]);assert.ok(text[0].node.width>0);assert.ok(text[0].node.y<text[1].node.y)
 for(const {node,alpha} of text){const lines=paths.filter(x=>x.node.points[0][0]===node.x);assert.ok(lines.every(x=>x.alpha===alpha));const strike=lines.find(x=>x.node.decoration==='strike').node;assert.ok(strike.points[0][1]<node.y);assert.equal(strike.points[1][0],node.x+node.width)}
 const svg=slideSvg(c.model,c.model.slides[0]);assert.equal((svg.match(/data-text-decoration=/g)||[]).length,6);assert.doesNotMatch(svg,/ text-decoration="underline"/)
})

test('double underline ink bounds include the full lower stroke at a bottom anchor', () => {
 const c=make();change(c,{underlineStyle:'double',strike:'double'});const o=object(c);o.textLayout={verticalAlign:'bottom',insets:{left:1,right:1,top:2,bottom:2}};
 const flat=leaves(buildSlideScene(c.model,c.model.slides[0],{measureTextMetrics:(_t,_s,size)=>({ascent:size*.7,descent:0})})),paths=flat.filter(x=>x.node.kind==='path'&&x.node.decoration==='underline').map(x=>x.node);
 assert.equal(paths.length,2);const bottom=Math.max(...paths.map(n=>n.points[0][1]+n.strokeWidth/2));assert.ok(Math.abs(bottom-(o.y+o.height-2))<1e-8)
 const rails=textDecorationLines({underline:true,underlineStyle:'double'},18);assert.ok(Math.abs(rails[1].offset-rails[0].offset-2)<1e-10);assert.ok(textDecorationBounds({underline:true,underlineStyle:'double'},18).descent>18*.2)
})

test('isolated text paint bounds reuse the existing clip for plain and rich text with negative insets', () => {
 const c=make();change(c,{underlineStyle:'double',strike:'double',opacity:.5});const o=object(c);
 o.textLayout={insets:{left:-7,right:-5,top:-3,bottom:-2},verticalAlign:'middle',wrap:false};
 for(const rich of [false,true]) {
  if(rich)o.richText={sourceText:o.text,sourceStyle:{...o.textStyle},paragraphs:[{style:{...o.textStyle},runs:[{text:o.text,style:{...o.textStyle}}]}]};
  const all=[];const visit=nodes=>{for(const node of nodes){all.push(node);if(node.kind==='group')visit(node.children)}};visit(buildSlideScene(c.model,c.model.slides[0]));
  const clip=all.find(n=>n.kind==='group'&&n.clip).clip,form=all.find(n=>n.kind==='group'&&n.isolateTextPaint);
  assert.deepEqual([form.x,form.y,form.width,form.height],[clip.x,clip.y,clip.width,clip.height]);
  assert.deepEqual([form.x,form.y,form.width,form.height],[o.x-7,o.y-3,o.width+12,o.height+5]);
 }
})

test('decorated translucent PDF text is a searchable isolated vector group with no raster fallback', async () => {
 const c=make();change(c,{underlineStyle:'double',strike:'double',opacity:.5,bold:true});object(c).rotation=17;
 const fontBytes=new Uint8Array(await readFile(new URL('../public/office-runtime/NotoSansCJKsc-Regular.otf',import.meta.url))),bytes=await exportPresentationPdf(c.model,{fontBytes});
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:bytes,isEvalSupported:false});
 try {const doc=await loading.promise,page=await doc.getPage(1),content=await page.getTextContent(),ops=await page.getOperatorList();assert.match(content.items.map(item=>item.str).join(''),/ABCD/);assert.ok(ops.fnArray.includes(pdfjs.OPS.beginGroup));assert.ok(!ops.fnArray.includes(pdfjs.OPS.paintImageXObject));const groups=ops.argsArray.filter((_,i)=>ops.fnArray[i]===pdfjs.OPS.beginGroup);assert.ok(groups.some(([group])=>group.isolated===true));} finally {await loading.destroy()}
})
