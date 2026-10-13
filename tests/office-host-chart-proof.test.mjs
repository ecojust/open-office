import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
const source=await readFile(new URL('../public/office/host.js',import.meta.url),'utf8')
const start=source.indexOf('function validateChartProof('),end=source.indexOf("canvas.addEventListener('wheel'",start)
assert.ok(start>=0&&end>start)
const validate=vm.runInNewContext(source.slice(start,end)+';validateChartProof')
test('host preserves true/false native evidence without forwarding arbitrary fields',()=>{
 const actual=validate([{pageId:'slide-1',shapeName:'中文图表',sourceEligible:true,path:'/not-forwarded'},{pageId:'slide-2',shapeName:'Chart',sourceEligible:false}])
 assert.deepEqual(JSON.parse(JSON.stringify(actual)),[{pageId:'slide-1',shapeName:'中文图表',sourceEligible:true},{pageId:'slide-2',shapeName:'Chart',sourceEligible:false}])
 assert.deepEqual(JSON.parse(JSON.stringify(validate(undefined))),[])
 assert.match(source,/chartProof:\s*validateChartProof\(message\.data\.chartProof\)/)
})
test('malformed or unbounded native evidence cannot grant source restoration',()=>{
 for(const value of [null,{},Array(20001).fill({}),[{pageId:'x',shapeName:'y',sourceEligible:1}],[{pageId:'x',shapeName:'\0',sourceEligible:true}],[{pageId:'',shapeName:'y',sourceEligible:true}],[{pageId:'x',shapeName:'y'.repeat(301),sourceEligible:true}]])assert.throws(()=>validate(value),/证据无效/)
})
test('host preserves bounded original-name identity separately from modification evidence',()=>{
 const value=validate([{pageId:'slide-1',shapeName:'Chart 1',sourceShapeName:'Chart 3',sourceEligible:false}])
 assert.equal(value[0].sourceShapeName,'Chart 3');assert.equal(value[0].sourceEligible,false)
 for(const sourceShapeName of ['',false,'x'.repeat(301),'invalid\0name'])assert.throws(()=>validate([{pageId:'slide-1',shapeName:'Chart 1',sourceShapeName,sourceEligible:true}]),/证据无效/)
})
