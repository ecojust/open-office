import test from 'node:test'
import assert from 'node:assert/strict'
import { createPresentation, PresentationController } from '../src/presentation/core/model.ts'
import { buildSlideScene } from '../src/presentation/core/scene.ts'
import { slideSvg } from '../src/presentation/core/render.ts'
import { textHighlightPaint, textHighlightXml } from '../src/presentation/core/text-highlight.ts'
import { effectiveRichText } from '../src/presentation/core/rich-text.ts'
const make=()=>{const c=new PresentationController(createPresentation(),'highlight');c.action({type:'insert-text',text:'H H',x:10,y:10,width:90,height:35,textStyle:{fontSize:36,color:'#000000'}});return c}
const object=c=>c.model.slides[0].objects[0]
const change=(c,textStyle)=>c.action({type:'update-object',id:object(c).id,textStyle})
const flat=(nodes,alpha=1)=>nodes.flatMap(node=>node.kind==='group'?flat(node.children,alpha*(node.opacity??1)):[{node,alpha}])

test('highlight colors are explicit replacements and clear is a transparent override',()=>{
 const c=make();change(c,{highlightColor:'#ffee00'});assert.equal(object(c).textStyle.highlightColor,'#FFEE00');assert.equal(object(c).textStyle.highlightOpacity,1)
 change(c,{highlightColor:'#FFEE00',highlightOpacity:.333333});assert.equal(object(c).textStyle.highlightOpacity,.33333)
 change(c,{highlightColor:null});assert.equal(object(c).textStyle.highlightColor,null);assert.equal(object(c).textStyle.highlightOpacity,0)
 assert.match(textHighlightXml(object(c).textStyle),/<a:highlight><a:srgbClr val="000000"><a:alpha val="0"\/>/);assert.equal(textHighlightPaint(object(c).textStyle),undefined)
 c.undo();assert.equal(object(c).textStyle.highlightOpacity,.33333);c.redo();assert.equal(object(c).textStyle.highlightColor,null)
 for(const textStyle of [{highlightColor:'#123'},{highlightColor:'url(x)'},{highlightOpacity:.5},{highlightColor:null,highlightOpacity:1},{highlightColor:'#FFFFFF',highlightOpacity:Infinity},{highlightColor:'#FFFFFF',highlightOpacity:-.1}]){const before=JSON.stringify(c.model);assert.throws(()=>change(c,textStyle));assert.equal(JSON.stringify(c.model),before)}
})

test('glyph alpha and its decorations do not fade the independent highlight',()=>{
 for(const opacity of [0,.5,1]){const c=make();change(c,{highlightColor:'#FFFF00',highlightOpacity:.7,opacity,underlineStyle:'double',strike:'double'});object(c).opacity=.8;const nodes=flat(buildSlideScene(c.model,c.model.slides[0])),marker=nodes.find(x=>x.node.textHighlight),glyph=nodes.find(x=>x.node.kind==='text');assert.equal(marker.alpha,.8*.7);assert.equal(glyph.alpha,.8*opacity);assert.ok(marker.node.width>0);assert.ok(nodes.filter(x=>x.node.kind==='path').every(x=>x.alpha===glyph.alpha));assert.ok(nodes.indexOf(marker)<nodes.indexOf(glyph))}
})

test('mixed baselines share a line highlight band while glyphs keep their own baselines',()=>{
 const c=make(),o=object(c),style={...o.textStyle,highlightColor:'#FFEE88',highlightOpacity:1};o.textStyle=style;o.richText={sourceText:'H H',sourceStyle:style,paragraphs:[{style,runs:[{text:'H',style,baseline:.4},{text:' ',style},{text:'H',style,baseline:-.25}]}]};
 const nodes=flat(buildSlideScene(c.model,c.model.slides[0])),markers=nodes.filter(x=>x.node.textHighlight).map(x=>x.node),text=nodes.filter(x=>x.node.kind==='text').map(x=>x.node);assert.equal(markers.length,3);assert.equal(new Set(markers.map(n=>n.y)).size,1);assert.equal(new Set(markers.map(n=>n.height)).size,1);assert.ok(text[0].y<text[1].y&&text[1].y<text[2].y)
 assert.ok(nodes.findIndex(x=>x.node.kind==='text')>nodes.findLastIndex(x=>x.node.textHighlight));change(c,{highlightColor:null});assert.ok(effectiveRichText(object(c))[0].runs.every(r=>r.style.highlightColor===null))
})

test('justified highlight covers expanded spaces in plain and rich text and does not draw break blocks',()=>{
 const measure=(text,_style,size)=>text.length*size*.5,metrics=(_t,_s,size)=>({ascent:size*.8,descent:size*.2});
 for(const rich of [false,true]){const c=make(),o=object(c);o.text='A B C D\nX';o.width=26;change(c,{fontSize:24,align:'justify',highlightColor:'#FFFF00'});if(rich)o.richText={sourceText:o.text,sourceStyle:o.textStyle,paragraphs:[{style:o.textStyle,runs:[{text:o.text,style:o.textStyle}]}]};
  const nodes=flat(buildSlideScene(c.model,c.model.slides[0],{measureText:measure,measureTextMetrics:metrics})),markers=nodes.filter(x=>x.node.textHighlight).map(x=>x.node);assert.ok(markers.length>=2);const first=markers.filter(n=>n.y===markers[0].y).sort((a,b)=>a.x-b.x);assert.ok(Math.abs(first.at(-1).x+first.at(-1).width-first[0].x-(o.width-2.6))<1e-8);for(let i=1;i<first.length;i++)assert.ok(Math.abs(first[i-1].x+first[i-1].width-first[i].x)<1e-8);assert.ok(markers.every(n=>n.width>0));assert.match(slideSvg(c.model,c.model.slides[0]),/data-text-highlight="1"/)
 }
})

test('untrusted highlight values cannot become SVG paint or generated XML',()=>{
 for(const value of ['red','url(https://example.invalid)', '#fff\" onload=\"bad', '<script>']){assert.equal(textHighlightPaint({highlightColor:value}),undefined);assert.doesNotMatch(textHighlightXml({highlightColor:value}),/script|onload|url/)}
})

test('highlight uses full font metrics independently from ink layout and skips unused measurements',()=>{
 const c=make(),o=object(c);o.text='H';o.textLayout={verticalAlign:'middle',insets:{left:2,right:2,top:2,bottom:2}};
 let calls=0;const options={measureTextMetrics:(_t,_s,size)=>({ascent:size*.6,descent:0}),measureFontMetrics:(_s,size)=>{calls++;return {ascent:size*.9,descent:size*.3}}};
 const before=flat(buildSlideScene(c.model,c.model.slides[0],options)).find(x=>x.node.kind==='text').node;assert.equal(calls,0)
 change(c,{highlightColor:'#FFFF00'});const nodes=flat(buildSlideScene(c.model,c.model.slides[0],options)),marker=nodes.find(x=>x.node.textHighlight).node,after=nodes.find(x=>x.node.kind==='text').node;
 assert.equal(calls,1);assert.equal(after.y,before.y);assert.ok(Math.abs(marker.height-after.size*1.2)<1e-8);assert.ok(Math.abs(marker.y-(after.y-after.size*.9))<1e-8)
})
