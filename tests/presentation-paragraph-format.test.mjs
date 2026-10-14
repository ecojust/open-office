import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedParagraphStyle } from '../src/presentation/core/paragraph-format.ts';
import { createPresentation, PresentationController } from '../src/presentation/core/model.ts';

test('paragraph normalization retains explicit zero and writes precise DrawingML units without mutating input', () => {
  const patch = { align:'right', lineSpacing:{unit:'percent',value:1.234567}, spaceBefore:{unit:'points',value:8.123}, spaceAfter:{unit:'points',value:0} };
  const before = structuredClone(patch);
  assert.deepEqual(normalizedParagraphStyle(patch), {align:'right',lineSpacing:{unit:'percent',value:1.23457},spaceBefore:{unit:'points',value:8.12},spaceAfter:{unit:'points',value:0}});
  assert.deepEqual(patch,before);
});
test('paragraph normalization rejects ambiguous resets, unknown values and invalid units', () => {
  for (const input of [null,[],{bold:true},{align:'top'},{lineSpacing:null},{lineSpacing:{unit:'px',value:12}},{spaceBefore:{unit:'points',value:Infinity}},{spaceAfter:{unit:'percent',value:-1}},{lineSpacing:{unit:'percent',value:11}},{spaceBefore:{unit:'points',value:1,extra:1}}]) assert.throws(()=>normalizedParagraphStyle(input));
});
const fresh = () => {const c=new PresentationController(createPresentation(),'layout');c.action({type:'insert-text',text:'A\nB'});return c;};
test('text-box layout supports explicit zero/false and preserves unspecified inset values', () => {
  const c=fresh(), id=c.model.slides[0].objects[0].id;
  c.action({type:'set-text-layout',id,layout:{insets:{right:7},verticalAlign:'middle',wrap:false}});
  c.action({type:'set-text-layout',id,layout:{insets:{left:0,top:2.123456},rotation:15.123456}});
  assert.deepEqual(c.model.slides[0].objects[0].textLayout,{verticalAlign:'middle',wrap:false,insets:{left:0,right:7,top:Math.round(2.123456*36000)/36000,bottom:1.3},rotation:Math.round(15.123456*60000)/60000});
  c.undo();assert.equal(c.model.slides[0].objects[0].textLayout.insets.left,1.3);
  c.redo();assert.equal(c.model.slides[0].objects[0].textLayout.insets.left,0);
});
test('invalid second text-layout action rolls back the complete batch and revision', () => {
  const c=fresh(),id=c.model.slides[0].objects[0].id,before=structuredClone(c.model),revision=c.revision;
  assert.throws(()=>c.batch([{type:'set-text-layout',id,layout:{wrap:false}},{type:'set-text-layout',id,layout:{insets:{left:-1}}}]));
  assert.deepEqual(c.model,before);assert.equal(c.revision,revision);
});
test('text-box layout rejects empty/unknown fields, invalid booleans, stale revisions and locked objects', () => {
  const c=fresh(),id=c.model.slides[0].objects[0].id;
  for(const layout of [{},{wrap:0},{verticalAlign:'stretch'},{insets:{}},{insets:{top:undefined}},{insets:{diagonal:2}},{rotation:NaN},{columns:2}]) assert.throws(()=>c.action({type:'set-text-layout',id,layout}));
  assert.throws(()=>c.action({type:'set-text-layout',id,layout:{wrap:false},expectedRevision:c.revision-1}));
  c.model.slides[0].objects[0].locked=true;assert.throws(()=>c.action({type:'set-text-layout',id,layout:{wrap:false}}));
});
