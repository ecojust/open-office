import test from 'node:test';
import assert from 'node:assert/strict';
import { textEditSplices } from '../src/presentation/core/text-diff.ts';
const apply = (before, edits) => { for (const edit of [...edits].reverse()) before = before.slice(0, edit.start) + edit.text + before.slice(edit.end); return before; };
test('text differences preserve unchanged middle text between separate replacements', () => {
  const edits = textEditSplices('Red middle blue', 'Bed middle glue');
  assert.deepEqual(edits,[{start:0,end:1,text:'B'},{start:11,end:12,text:'g'}]);
});
test('text differences have UTF16 offsets without dividing supplementary characters', () => {
  const before='甲😀乙丁🐈戊', after='甲🐴乙丙🐈戊！';
  const edits=textEditSplices(before,after);
  assert.equal(apply(before,edits),after);
  assert.deepEqual(edits,[{start:1,end:3,text:'🐴'},{start:4,end:5,text:'丙'},{start:8,end:8,text:'！'}]);
});
test('existing empty, trailing and manual-line projections remain structural', () => {
  const before='\nA\n\nB\n', after='Start\nAA\n\nBB\nEnd';
  const edits=textEditSplices(before,after);
  assert.equal(apply(before,edits),after);
  assert.ok(edits.every(edit=>!before.slice(edit.start,edit.end).includes('\n')&&!edit.text.includes('\n')));
  assert.throws(()=>textEditSplices('A\nB','AB'),/增删换行/);
});
test('insertion, deletion, replacement, repeated characters and multiple changes reconstruct exactly', () => {
  for(const [before,after] of [['','A'],['A',''],['abc','XYZ'],['aaaa','aabaa'],['start middle end','X start middle END Y'],['a-b-c-d-e-f','aXb-cYd-eZf'],['😀😀AB','😀XY😀AB'],['a'.repeat(10000)+'b'+'c'.repeat(10000),'a'.repeat(10000)+'X'+'c'.repeat(10000)]]) {
    const edits=textEditSplices(before,after);assert.equal(apply(before,edits),after);assert.deepEqual(textEditSplices(before,after),edits);
    assert.ok(edits.every((edit,index)=>edit.start<=edit.end && (!index || edits[index-1].end<=edit.start)));
  }
});
test('bounded matcher rejects pathological work and overlong input rather than flattening unchanged text', () => {
  assert.throws(()=>textEditSplices('a'.repeat(2000)+'b'.repeat(2000),'b'.repeat(2000)+'a'.repeat(2000)),/过于复杂/);
  assert.throws(()=>textEditSplices('a'.repeat(100001),'x'),/过于复杂/);
});
test('deterministic randomized short samples reconstruct their target', () => {
  let seed=271828;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed;};const chars=['甲','乙','😀','a','b',' '];
  for(let i=0;i<200;i++) {const text=()=>Array.from({length:random()%30},()=>chars[random()%chars.length]).join('');const before=text(),after=text();assert.equal(apply(before,textEditSplices(before,after)),after);}
});
