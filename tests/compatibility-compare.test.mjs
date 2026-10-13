import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const require=createRequire(import.meta.url)
const {compareInspections,normalizeText,normalizeFormula}=require('./compatibility/compare.cjs')
const cache=new Map()
function inspect(name){
  if(!cache.has(name)){
    const tool=fileURLToPath(new URL('./compatibility/inspect-output.py',import.meta.url))
    const file=fileURLToPath(new URL('./compatibility/fixtures/generated/'+name,import.meta.url))
    const result=spawnSync(process.env.COMPAT_PYTHON||'python3',[tool,file],{encoding:'utf8',maxBuffer:24*1024*1024,timeout:30000})
    assert.equal(result.status,0,result.stderr||result.stdout)
    cache.set(name,JSON.parse(result.stdout))
  }
  return structuredClone(cache.get(name))
}
function changed(name,mutate){const source=inspect(name),output=structuredClone(source);mutate(output);return compareInspections(source,output)}
const hasFailure=(report,code)=>assert.ok(report.failures.some(f=>f.code===code),JSON.stringify(report,null,2))
const hasReview=(report,code)=>assert.ok(report.reviewItems.some(f=>f.code===code),JSON.stringify(report,null,2))

test('identical real DOCX retains detailed body, merged table, header and footer fields',()=>{
  const source=inspect('writer-rich.docx'),result=compareInspections(source,source)
  assert.equal(result.status,'pass');assert.ok(result.checks.length>40);assert.deepEqual(result.failures,[])
  assert.ok(result.checks.some(item=>item.code==='TABLE_COLUMN_SPAN'))
  assert.ok(result.checks.some(item=>item.code==='FIELD_PRESERVED'))
})

test('each cycle is compared with the original, so a loss is never normalized into the baseline',()=>{
  const source=inspect('writer-rich.docx'),damaged=structuredClone(source)
  damaged.word.headers=[]
  for(const cycle of [1,2,3]){
    const result=compareInspections(source,damaged,{cycle})
    assert.equal(result.cycle,cycle);hasFailure(result,'TEXT_OBJECT_PRESERVED')
  }
})

test('Word merged-cell topology, user footnotes, comments and deleted text remain independent obligations',()=>{
  hasFailure(changed('writer-rich.docx',out=>{
    const cell=out.word.tables.flatMap(table=>table.rows.flat()).find(cell=>Number(cell.columnSpan)>1);assert.ok(cell);cell.columnSpan='1'
  }),'TABLE_COLUMN_SPAN')
  for(const key of ['comments','footnotes','trackedChanges']){
    const source=inspect('writer-review-footnotes.docx');assert.ok(source.word[key].length,key)
    const result=changed('writer-review-footnotes.docx',out=>{out.word[key]=[]})
    hasFailure(result,key==='trackedChanges'?'TRACKED_CHANGE_PRESERVED':'TEXT_OBJECT_PRESERVED')
  }
})

test('text normalization accepts Unicode composition and CRLF, while preserving spaces and literal punctuation',()=>{
  assert.equal(normalizeText('Cafe\u0301\r\n中文'),'Café\n中文')
  assert.notEqual(normalizeText('A B'),normalizeText('AB'))
  assert.equal(normalizeFormula('=$A$1+A2'),'$A$1+A2')
  const source=inspect('writer-rich.docx'),output=structuredClone(source)
  source.word.paragraphs=[{text:'Café A B'}];output.word.paragraphs=[{text:'Cafe\u0301 AB'}]
  hasFailure(compareInspections(source,output),'TEXT_PRESERVED')
  output.word.paragraphs=[{text:'编辑前缀 Cafe\u0301 A B'}]
  assert.equal(compareInspections(source,output).failures.length,0)
})

test('malformed or incomplete inspector data is a failure, never a text-coerced pass',()=>{
  const source=inspect('calc-rich.xlsx')
  for(const mutate of [
    out=>{out.schemaVersion=999},out=>{out.truncated=true},
    out=>{out.spreadsheet.sheets[0].cells={A1:'not an array'}},
    out=>{out.spreadsheet.sheets[0].cells[0].value=42},
    out=>{out.spreadsheet.sheets[0].cells[0].address='XFE1'},
    out=>{out.spreadsheet.sheets[0].cells.push({...out.spreadsheet.sheets[0].cells[0]})},
    out=>{out.spreadsheet.sheets[0].name='\ud800'},
    out=>{out.spreadsheet.definedNames[0].formula=undefined},
    out=>{out.spreadsheet.sheets[0].charts[0].series={}},
    out=>{out.coreText.strings=[null]},out=>{out.features.charts=NaN},
  ]){
    const bad=structuredClone(source);mutate(bad)
    assert.doesNotThrow(()=>compareInspections(source,bad))
    hasFailure(compareInspections(source,bad),'INVALID_INSPECTION_SHAPE')
  }
  for(const value of [null,[],{},'report'])hasFailure(compareInspections(value,source),'INVALID_INSPECTION_SHAPE')
  const word=inspect('writer-rich.docx');word.word.headers={}
  hasFailure(compareInspections(inspect('writer-rich.docx'),word),'INVALID_INSPECTION_SHAPE')
})

test('unsupported OLE inspection and partial RTF semantics cannot claim full preservation',()=>{
  const unsupported={schemaVersion:1,ok:false,inspection:'unsupported',format:'ole',errors:[],warnings:[{code:'LEGACY_PARSER_UNAVAILABLE'}]}
  const result=compareInspections(unsupported,inspect('writer-rich.docx'))
  assert.equal(result.status,'review');assert.equal(result.ok,false);hasReview(result,'UNSUPPORTED_INSPECTION')
  const rtf=inspect('writer-unicode-tables.rtf'),same=compareInspections(rtf,rtf)
  assert.equal(same.status,'review');hasReview(same,'RTF_TABLE_STRUCTURE_PARTIAL');assert.equal(same.failures.length,0)
})

test('spreadsheet data types, cached values, hidden sheets and exact absolute references are tested',()=>{
  hasFailure(changed('calc-rich.xlsx',out=>{out.spreadsheet.sheets.find(sheet=>sheet.state==='hidden').state='visible'}),'SHEET_VISIBILITY')
  hasFailure(changed('calc-rich.xlsx',out=>{const c=out.spreadsheet.sheets.find(s=>s.name==='Data').cells.find(c=>c.address==='F2');c.type='number';c.value=123}),'CELL_TYPE')
  hasFailure(changed('calc-rich.xlsx',out=>{const c=out.spreadsheet.sheets[0].cells.find(c=>c.type==='formula');c.value+=1}),'FORMULA_CACHED_VALUE')
  const source=inspect('calc-rich.xlsx'),output=structuredClone(source),a=source.spreadsheet.sheets[0].cells.find(c=>c.type==='formula'),b=output.spreadsheet.sheets[0].cells.find(c=>c.address===a.address)
  a.formula='SUM($A$1:$A$2)';b.formula='SUM(A1:A2)'
  hasFailure(compareInspections(source,output),'FORMULA_EXPRESSION')
  b.formula='SUM($A$1;$A$2)';hasFailure(compareInspections(source,output),'FORMULA_EXPRESSION')
})

test('shared formula followers with absent expressions remain review even when their caches match',()=>{
  const source=inspect('calc-rich.xlsx'),cell=source.spreadsheet.sheets[0].cells.find(c=>c.type==='formula')
  cell.formula=null;cell.formulaAttributes={t:'shared',si:'0'}
  hasReview(compareInspections(source,source),'SHARED_FORMULA_UNEXPANDED')
})

test('large integer totals cannot lose a unit under a broad relative-error tolerance',()=>{
  const source=inspect('calc-rich.xlsx'),output=structuredClone(source)
  const a=source.spreadsheet.sheets[0].cells.find(c=>c.type==='formula'),b=output.spreadsheet.sheets[0].cells.find(c=>c.address===a.address)
  a.value=100_000_000_000;b.value=a.value+1
  hasFailure(compareInspections(source,output),'FORMULA_CACHED_VALUE')
  a.value=0.3;b.value=0.1+0.2
  assert.equal(compareInspections(source,output).failures.length,0)
})

test('spreadsheet merge ranges, names, validation and freeze semantics cannot be replaced by feature counts',()=>{
  hasFailure(changed('calc-rich.xlsx',out=>{out.spreadsheet.sheets[0].mergedRanges=[]}),'MERGED_RANGE')
  hasFailure(changed('calc-rich.xlsx',out=>{out.spreadsheet.definedNames=[]}),'DEFINED_NAME_PRESENT')
  hasFailure(changed('calc-rich.xlsx',out=>{out.spreadsheet.sheets.find(s=>s.dataValidations.length).dataValidations=[]}),'VALIDATION_LOST')
  hasFailure(changed('calc-rich.xlsx',out=>{out.spreadsheet.sheets.find(s=>s.frozenPanes.length).frozenPanes=[]}),'FROZEN_PANES')
  const source=inspect('calc-rich.xlsx'),same=compareInspections(source,source)
  hasReview(same,'CONDITIONAL_STYLE_UNINSPECTED')
  hasFailure(changed('calc-rich.xlsx',out=>{out.spreadsheet.sheets.find(s=>s.conditionalFormats.length).conditionalFormats=[]}),'CONDITIONAL_FORMAT_PRESENT')
})

test('editable chart loss is detected even when an image and the global chart count survive',()=>{
  const source=inspect('calc-rich.xlsx'),output=structuredClone(source),sheet=output.spreadsheet.sheets.find(s=>s.charts.length)
  assert.ok(sheet);sheet.charts=[];output.features.chartParts=source.features.chartParts;output.features.images+=1
  hasFailure(compareInspections(source,output),'EDITABLE_CHART_COUNT')
})

test('chart series and real cached points are compared independently of image rendering',()=>{
  const result=changed('calc-rich.xlsx',out=>{
    const chart=out.spreadsheet.sheets.find(s=>s.charts.length).charts[0]
    chart.series[0].values.values[0].value='99999'
  })
  hasFailure(result,'CHART_CACHED_POINTS')
  hasFailure(changed('calc-rich.xlsx',out=>{out.spreadsheet.sheets.find(s=>s.charts.length).charts[0].series[0].values.formula=null}),'FORMULA_LOST')
})

test('a chart literal converted to a cached expression is a representation review, not silent equality or reported loss',()=>{
  const source=inspect('calc-rich.xlsx'),output=structuredClone(source)
  const title=output.spreadsheet.sheets.find(s=>s.charts.length).charts[0].series[0].title
  assert.equal(title.literal,'Revenue')
  title.formula='"Revenue"';title.values=[{index:'0',value:'Revenue'}];title.literal=null
  const result=compareInspections(source,output)
  assert.equal(result.failures.length,0);hasReview(result,'CHART_LITERAL_REPRESENTATION')
  title.values[0].value='Wrong title'
  assert.ok(compareInspections(source,output).failures.length>0)
})

test('page-number display caches may change while field instructions and surrounding literal text must remain',()=>{
  const source=inspect('writer-rich.docx'),output=structuredClone(source)
  const footer=output.word.footers[0]
  assert.ok(footer.fields.some(value=>value.trim()==='PAGE'))
  footer.text+='99'
  assert.equal(compareInspections(source,output).failures.length,0)
  footer.fields=[]
  hasFailure(compareInspections(source,output),'FIELD_PRESERVED')
})

test('header and footer matching respects default/first/even roles and required fields',()=>{
  const source=inspect('writer-rich.docx'),output=structuredClone(source)
  source.word.footers=[{text:'',textWithoutFieldResults:'',fields:['PAGE'],references:[{sectionIndex:0,type:'default'}]}]
  output.word.footers=[
    {text:'',textWithoutFieldResults:'',fields:[],references:[{sectionIndex:0,type:'even'}]},
    {text:'3',textWithoutFieldResults:'',fields:[' PAGE '],references:[{sectionIndex:0,type:'default'}]},
  ]
  assert.equal(compareInspections(source,output).failures.length,0)
  output.word.footers[1].references=[{sectionIndex:0,type:'first'}]
  hasFailure(compareInspections(source,output),'HEADER_FOOTER_ROLES')
  output.word.footers[1].references=[{sectionIndex:0,type:'default'}];output.word.footers[1].fields=[]
  hasFailure(compareInspections(source,output),'FIELD_PRESERVED')
})

test('single-row vMerge restart is reviewed as representation while real merge extents are strict',()=>{
  const source=inspect('writer-rich.docx'),output=structuredClone(source)
  const cell=(value,merge)=>({text:value,columnSpan:'2',verticalMerge:merge})
  source.word.tables=[{rows:[[cell('one row','restart')]],rowGridBefore:[0]}]
  output.word.tables=[{rows:[[cell('one row',null)]],rowGridBefore:[0]}]
  let result=compareInspections(source,output)
  assert.equal(result.failures.length,0);hasReview(result,'TABLE_VERTICAL_REPRESENTATION')
  source.word.tables=[{rows:[[cell('top','restart')],[cell('','continue')]],rowGridBefore:[0,0]}]
  output.word.tables=structuredClone(source.word.tables)
  assert.equal(compareInspections(source,output).failures.length,0)
  output.word.tables[0].rows[1][0].verticalMerge=null
  hasFailure(compareInspections(source,output),'TABLE_VERTICAL_MERGE')
  output.word.tables=structuredClone(source.word.tables);output.word.tables[0].rowGridBefore[1]=1
  hasFailure(compareInspections(source,output),'TABLE_VERTICAL_TOPOLOGY')
  output.word.tables=structuredClone(source.word.tables);output.word.tables[0].rows[1][0].columnSpan='1'
  hasFailure(compareInspections(source,output),'TABLE_COLUMN_SPAN')
  hasFailure(compareInspections(source,output),'TABLE_VERTICAL_TOPOLOGY')
})

test('function-name case normalizes only call tokens without changing literals references or spaces',()=>{
  assert.equal(normalizeFormula('COUNTA(_xlfn.UNIQUE(C7:C12))'),normalizeFormula('counta(_xlfn.unique(C7:C12))'))
  assert.equal(normalizeFormula('=sum(A1) + "unique(AbC)" + \'sum(\'!A1 + Table1[sum(]'),'SUM(A1) + "unique(AbC)" + \'sum(\'!A1 + Table1[sum(]')
  assert.notEqual(normalizeFormula('SUM("AbC")'),normalizeFormula('sum("abc")'))
  assert.notEqual(normalizeFormula('SUM($A$1)'),normalizeFormula('sum(A1)'))
  assert.notEqual(normalizeFormula('SUM(A1:A2)'),normalizeFormula('sum(A1: A2)'))
  assert.notEqual(normalizeFormula('SUM(\'Data\'!A1)'),normalizeFormula('sum(\'data\'!A1)'))
})

test('numeric chart caches allow at most eight IEEE-754 ULPs and keep integer and text points exact',()=>{
  const source=inspect('calc-rich.xlsx'),output=structuredClone(source)
  const values=report=>report.spreadsheet.sheets.find(sheet=>sheet.charts.length).charts[0].series[0].values.values
  const step=(value,distance)=>{const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value);view.setBigUint64(0,view.getBigUint64(0)+BigInt(distance));return view.getFloat64(0)}
  values(source)[0].value='0.30855018587360594';values(output)[0].value='0.308550185873606'
  assert.equal(compareInspections(source,output).failures.length,0)
  values(output)[0].value=String(step(Number(values(source)[0].value),8))
  assert.equal(compareInspections(source,output).failures.length,0)
  values(output)[0].value=String(step(Number(values(source)[0].value),9))
  hasFailure(compareInspections(source,output),'CHART_CACHED_POINTS')
  values(source)[0].value='0.1970260223048327';values(output)[0].value='0.197026022304833'
  const serialized=compareInspections(source,output)
  assert.equal(serialized.failures.length,0);hasReview(serialized,'NUMERIC_SERIALIZATION_REPRESENTATION')
  values(output)[0].value='0.19702602231'
  hasFailure(compareInspections(source,output),'CHART_CACHED_POINTS')
  values(source)[0].value='42';values(output)[0].value=String(step(42,1))
  hasFailure(compareInspections(source,output),'CHART_CACHED_POINTS')
  values(source)[0].value='-0.5';values(output)[0].value=String(step(-0.5,8))
  assert.equal(compareInspections(source,output).failures.length,0)
  values(output)[0].index='999'
  hasFailure(compareInspections(source,output),'CHART_CACHED_POINTS')
})

test('opaque embedded attachments never become a full semantic pass just because a count survives',()=>{
  const source=inspect('writer-rich.docx'),output=structuredClone(source)
  source.features.embeddedObjects=2;output.features.embeddedObjects=2
  let result=compareInspections(source,output)
  assert.equal(result.failures.length,0);hasReview(result,'EMBEDDED_OBJECT_CONTENT_UNINSPECTED')
  output.features.embeddedObjects=1
  hasFailure(compareInspections(source,output),'EMBEDDED_OBJECT_COUNT')
})

test('presentation page count, hidden slides, speaker notes, editable tables and charts survive independently',()=>{
  const source=inspect('presentation-rich.pptx')
  hasFailure(changed('presentation-rich.pptx',out=>{out.presentation.slides.pop();out.presentation.slideCount--}),'SLIDE_COUNT')
  hasFailure(changed('presentation-rich.pptx',out=>{out.presentation.slides[0].hidden=!out.presentation.slides[0].hidden}),'HIDDEN_SLIDE')
  hasFailure(changed('presentation-rich.pptx',out=>{for(const s of out.presentation.slides)s.notes=[]}),'TEXT_PRESERVED')
  hasFailure(changed('presentation-rich.pptx',out=>{for(const s of out.presentation.slides)s.tables=[]}),'EDITABLE_TABLE_COUNT')
  hasFailure(changed('presentation-rich.pptx',out=>{for(const s of out.presentation.slides)s.charts=[]}),'EDITABLE_CHART_COUNT')
  const result=compareInspections(source,source)
  assert.equal(result.failures.length,0);hasReview(result,'EMBEDDED_CHART_WORKBOOK_UNINSPECTED')
})

test('media identity uses independently hashed bytes, never merely the same length',()=>{
  const source=inspect('presentation-effects-media.pptx'),output=structuredClone(source)
  const media=output.presentation.slides.flatMap(slide=>slide.media).find(media=>!media.external)
  assert.ok(media?.sha256);const originalLength=media.bytes;media.sha256='0'.repeat(64)
  assert.equal(media.bytes,originalLength)
  hasFailure(compareInspections(source,output),'EMBEDDED_MEDIA_BYTES')
})

test('cross-format formula syntax is reviewed instead of erasing dollars or separators',()=>{
  const source=inspect('calc-original-odf.ods'),result=compareInspections(source,source)
  assert.equal(result.failures.length,0);assert.equal(result.status,'review')
  hasReview(result,'CROSS_FORMAT_REPRESENTATION');hasReview(result,'FORMULA_REPRESENTATION')
})

test('export/reopen edit markers must appear in independently read output text',()=>{
  const source=inspect('writer-rich.docx')
  hasFailure(compareInspections(source,source,{expectedEditMarker:'COMPAT-EDIT-UNIQUE'}),'EDIT_MARKER')
  const output=structuredClone(source);output.coreText.strings.push('COMPAT-EDIT-UNIQUE')
  assert.equal(compareInspections(source,output,{expectedEditMarker:'COMPAT-EDIT-UNIQUE'}).failures.length,0)
})
