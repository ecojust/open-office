import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { inspectXlsxImport, inspectDocxImport, reviewOfficeImport, IMPORT_REVIEW_LIMITS } from '../src/office/import-review.ts'

const sheetNamespace='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relationNamespace='http://schemas.openxmlformats.org/package/2006/relationships'
const documentNamespace='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const wordNamespace='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const officeNamespace='urn:schemas-microsoft-com:office:office'
function docx({body='',links='',extra={}}={}) {
  const files={
    '_rels/.rels':`<Relationships xmlns="${relationNamespace}"><Relationship Id="main" Type="${documentNamespace}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml':`<w:document xmlns:w="${wordNamespace}" xmlns:o="${officeNamespace}" xmlns:r="${documentNamespace}"><w:body>${body}</w:body></w:document>`,
    'word/_rels/document.xml.rels':`<Relationships xmlns="${relationNamespace}">${links}</Relationships>`,...extra,
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([name,value])=>[name,typeof value==='string'?strToU8(value):value])))
}
const attachment='<w:p><w:r><w:object><o:OLEObject Type="Embed" r:id="attachment"/></w:object></w:r></w:p>'
const attachmentRelation=`<Relationship Id="attachment" Type="${documentNamespace}/oleObject" Target="embeddings/item.bin"/>`
function archive({cells='',visibility='visible',workbook,worksheet,extra={},sheetTarget='worksheets/sheet1.xml',sheetType='worksheet'}={}) {
  const files={
    '_rels/.rels':`<Relationships xmlns="${relationNamespace}"><Relationship Id="main" Type="${documentNamespace}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':workbook||`<workbook xmlns="${sheetNamespace}" xmlns:r="${documentNamespace}"><sheets><sheet name="Original" sheetId="1" r:id="first" state="${visibility}"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="${relationNamespace}"><Relationship Id="first" Type="${documentNamespace}/${sheetType}" Target="${sheetTarget}"/></Relationships>`,
    'xl/worksheets/sheet1.xml':worksheet||`<worksheet xmlns="${sheetNamespace}"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,...extra,
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([key,value])=>[key,strToU8(value)])),{level:6})
}

test('only literal boolean cells and actual veryHidden sheets request protected copies',()=>{
  const bytes=archive({visibility:'veryHidden',cells:'<c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="b"><f>TRUE()</f><v>1</v></c>'})
  const before=Buffer.from(bytes),review=inspectXlsxImport(bytes)
  assert.equal(review.complete,true);assert.equal(review.requiresSaveAs,true)
  assert.equal(review.warnings.length,2)
  assert.match(review.warnings[0],/含 2 个布尔常量/);assert.match(review.warnings[0],/ISFORMULA/)
  assert.match(review.warnings[1],/含 1 张深度隐藏/)
  assert.deepEqual(Buffer.from(bytes),before,'The preflight must not patch input XML or source bytes')
})

test('ordinary hidden sheets, formula boolean caches and literal lookalike text do not warn',()=>{
  const review=inspectXlsxImport(archive({visibility:'hidden',cells:`
    <c r="A1" t="inlineStr"><is><t>&lt;c t="b"&gt;&lt;v&gt;1&lt;/v&gt;&lt;/c&gt;</t></is></c>
    <c r="B1" t="b"><f>TRUE()</f><v>1</v></c><c r="C1" t="b"/>
    <!-- <c r="D1" t="b"><v>1</v></c> -->
    <x:c xmlns:x="urn:other" t="b"><x:v>1</x:v></x:c>`,
    extra:{'xl/worksheets/orphan.xml':`<worksheet xmlns="${sheetNamespace}"><sheetData><row><c t="b"><v>1</v></c></row></sheetData></worksheet>`}}))
  assert.deepEqual(review,{complete:true,requiresSaveAs:false,warnings:[]})
})

test('prefixed and strict OOXML namespaces are handled without lexical-only matching',()=>{
  for(const namespace of [sheetNamespace,'http://purl.oclc.org/ooxml/spreadsheetml/main']) {
    const review=inspectXlsxImport(archive({worksheet:`<?xml version="1.0"?><s:worksheet xmlns:s="${namespace}"><s:sheetData><s:row><s:c r="A1" t="&#98;"><s:v><![CDATA[1]]></s:v></s:c></s:row></s:sheetData></s:worksheet>`}))
    assert.equal(review.complete,true);assert.equal(review.warnings.length,1)
    assert.match(review.warnings[0],/含 1 个布尔常量/)
  }
})

test('relationship targets determine inspected sheets rather than conventional file names',()=>{
  const worksheet=`<worksheet xmlns="${sheetNamespace}"><sheetData><row><c t="b"><v>1</v></c></row></sheetData></worksheet>`
  const review=inspectXlsxImport(archive({sheetTarget:'../custom/special.xml',extra:{'custom/special.xml':worksheet}}))
  assert.equal(review.complete,true);assert.match(review.warnings[0],/含 1 个布尔常量/)
})

test('veryHidden visibility is detected for chart sheets too, without reading them as cell grids',()=>{
  const review=inspectXlsxImport(archive({visibility:'veryHidden',sheetType:'chartsheet',worksheet:`<chartsheet xmlns="${sheetNamespace}"/>`}))
  assert.equal(review.complete,true);assert.equal(review.warnings.length,1)
  assert.match(review.warnings[0],/veryHidden/);assert.doesNotMatch(review.warnings[0],/布尔常量/)
})

test('array/spill boolean caches are not misreported as literal constants',()=>{
  const review=inspectXlsxImport(archive({worksheet:`<worksheet xmlns="${sheetNamespace}"><sheetData>
    <row r="1"><c r="A1" t="b"><f t="array" ref="A1:A2">ROW(A1:A2)&gt;0</f><v>1</v></c><c r="B1" t="b"><v>0</v></c></row>
    <row r="2"><c r="A2" t="b"><v>1</v></c></row></sheetData></worksheet>`}))
  assert.equal(review.complete,true);assert.match(review.warnings[0],/含 1 个布尔常量/)
  const ambiguous=inspectXlsxImport(archive({cells:'<c r="A1"><f t="array" ref="A1:A2">ROW(A1:A2)</f><v>1</v></c><c t="b"><v>1</v></c>'}))
  assert.equal(ambiguous.complete,false);assert.doesNotMatch(ambiguous.warnings[0],/含 \d+ 个/)
})

const xmlText=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
test('actual UNIQUE formula calls require copies with a specific recalculation warning',()=>{
  const formulas=['COUNTA(_xlfn.UNIQUE(C7:C12))','unique (A1:A4)','_xlfn._xlws.UnIqUe(A1:B2)','_xlws.UNIQUE(A1:A9)','SUM(UNIQUE(A1:A2))+COUNTA(UNIQUE(B1:B2))','IF("UNIQUE("="",0,UNIQUE(A1:A2))']
  const bytes=archive({cells:formulas.map((formula,index)=>`<c r="A${index+1}"><f>${xmlText(formula)}</f><v>3</v></c>`).join('')})
  const before=Buffer.from(bytes),result=inspectXlsxImport(bytes)
  assert.equal(result.complete,true);assert.equal(result.requiresSaveAs,true)
  assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/含 6 个使用 UNIQUE 的公式/)
  assert.match(result.warnings[0],/重算差异/);assert.doesNotMatch(result.warnings[0],/所有|布尔常量/)
  assert.deepEqual(Buffer.from(bytes),before,'Review must not modify formulas or their original cached result')
  assert.deepEqual(reviewOfficeImport({extension:'xlsx',base64:Buffer.from(bytes).toString('base64')}),result)
})

test('UNIQUE lookalikes in strings, sheet names, fields and other functions do not warn',()=>{
  const formulas=[
    '"UNIQUE(A1:A3)"','IF(A1="a""UNIQUE(""b",1,0)',"'UNIQUE(A1)'!A1","'Joe''s UNIQUE('!A1",
    'UNIQUE!A1','Sheet1!UNIQUE(A1)','[source.xlsx]UNIQUE(A1)','SUM(Table1[UNIQUE(A1)])',
    'SUM(Table1[[#Data],[UNIQUE(A1)]])',"SUM(Table1[quote'] UNIQUE(A1)])",'MYUNIQUE(A1)','UNIQUE_NAME(A1)',
    'Custom.UNIQUE(A1)','_xlfn.NOTUNIQUE(A1)','中文UNIQUE(A1)','UNIQUE＋1','UNIQUE','_xlfn.FILTER(A1:A5,A1:A5>1)',
  ]
  for(const formula of formulas) {
    const result=inspectXlsxImport(archive({cells:`<c r="A1"><f>${xmlText(formula)}</f><v>1</v></c>`}))
    assert.equal(result.complete,true,formula);assert.equal(result.requiresSaveAs,false,formula);assert.deepEqual(result.warnings,[],formula)
  }
  const result=inspectXlsxImport(archive({cells:'<c r="A1" t="inlineStr"><is><t>UNIQUE(A1)</t></is></c><!-- <c><f>UNIQUE(A1)</f></c> --><foreign:c xmlns:foreign="urn:other"><foreign:f>UNIQUE(A1)</foreign:f></foreign:c>',extra:{'xl/worksheets/orphan.xml':`<worksheet xmlns="${sheetNamespace}"><sheetData><row><c><f>UNIQUE(A1)</f></c></row></sheetData></worksheet>`}}))
  assert.equal(result.complete,true);assert.equal(result.requiresSaveAs,false)
})

test('forged uncompressed length cannot turn truncated inflated XML into a clean review',()=>{
  const prefix=`<worksheet xmlns="${sheetNamespace}"><sheetData/></worksheet>`
  const bytes=archive({worksheet:prefix+' '.repeat(1024*1024)}),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  let crc=0xffffffff
  for(const byte of strToU8(prefix)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1}
  crc=(crc^0xffffffff)>>>0
  let modified=false
  for(let offset=0;offset+46<bytes.length;offset++) {
    if(view.getUint32(offset,true)!==0x02014b50)continue
    const length=view.getUint16(offset+28,true)
    if(new TextDecoder().decode(bytes.subarray(offset+46,offset+46+length))!=='xl/worksheets/sheet1.xml')continue
    const local=view.getUint32(offset+42,true)
    for(const [position,value] of [[offset+16,crc],[offset+24,strToU8(prefix).length],[local+14,crc],[local+22,strToU8(prefix).length]])view.setUint32(position,value,true)
    modified=true;break
  }
  assert.equal(modified,true)
  const review=inspectXlsxImport(bytes)
  assert.equal(review.complete,false);assert.equal(review.requiresSaveAs,true)
  assert.doesNotMatch(review.warnings[0],/含 \d+ 个/)
})

test('corrupt, ambiguous, unsafe or over-budget inspection protects source without inventing a risk count',()=>{
  const samples=[new Uint8Array([1,2,3]),archive({worksheet:'<worksheet><bad></worksheet>'}),
    archive({worksheet:`<!DOCTYPE worksheet [<!ENTITY e SYSTEM "https://example.invalid/entity">]><worksheet xmlns="${sheetNamespace}"/>`}),
    archive({sheetTarget:'../../outside.xml'}),archive({sheetTarget:'https://example.invalid/sheet.xml'}),
    archive({worksheet:' '.repeat(IMPORT_REVIEW_LIMITS.xmlBytes+1)}),
    ...['\u0000','&#0;','&#xFFFF;','&#x1F;'].map(character=>archive({cells:`<c t="inlineStr"><is><t>${character}</t></is></c>`})),
    archive({extra:{'XL/WORKBOOK.XML':'duplicate'}})]
  for(const sample of samples) {
    const review=inspectXlsxImport(sample)
    assert.equal(review.complete,false);assert.equal(review.requiresSaveAs,true)
    assert.equal(review.warnings.length,1);assert.match(review.warnings[0],/未能完成/)
    assert.doesNotMatch(review.warnings[0],/含 \d+ 个|含 \d+ 张/)
  }
})

test('empty new documents and other file families skip XLSX review; invalid base64 protects the source',()=>{
  for(const document of [{extension:'xlsx',base64:''},{extension:'docx',base64:''},{extension:'odt',base64:'not-a-zip'},{extension:'pdf',base64:'PDF'}]) {
    assert.deepEqual(reviewOfficeImport(document),{complete:true,requiresSaveAs:false,warnings:[]})
  }
  assert.equal(reviewOfficeImport({extension:'xlsx',base64:'not valid base64'}).requiresSaveAs,true)
  const review=reviewOfficeImport({extension:'xlsx',base64:Buffer.from(archive({cells:'<c t="b"><v>0</v></c>'})).toString('base64')})
  assert.equal(review.complete,true);assert.equal(review.requiresSaveAs,true)
})

test('DOCX actual OLE attachments require a copy without parsing or patching embedded content',()=>{
  const bytes=docx({body:attachment,links:attachmentRelation,extra:{'word/embeddings/item.bin':new Uint8Array([0,255,1,2,3])}})
  const before=Buffer.from(bytes),review=inspectDocxImport(bytes)
  assert.equal(review.complete,true);assert.equal(review.requiresSaveAs,true)
  assert.match(review.warnings[0],/含嵌入附件（1 项）/);assert.match(review.warnings[0],/丢失附件内容/)
  assert.deepEqual(Buffer.from(bytes),before)
  assert.deepEqual(reviewOfficeImport({extension:'docx',base64:Buffer.from(bytes).toString('base64')}),review)
})

test('DOCX charts, orphan embeddings, comments and external linked objects are not ordinary embedded attachments',()=>{
  const bytes=docx({body:`<w:p><w:r><w:drawing><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart"/></w:drawing></w:r></w:p>
    <!-- ${attachment} --> <w:p><w:r><w:t>&lt;o:OLEObject /&gt;</w:t></w:r></w:p>
    <w:p><w:r><w:object><o:OLEObject Type="Link" r:id="remote"/></w:object></w:r></w:p>`,
    links:attachmentRelation+`<Relationship Id="chart" Type="${documentNamespace}/chart" Target="charts/chart1.xml"/>
      <Relationship Id="remote" Type="${documentNamespace}/oleObject" TargetMode="External" Target="https://example.invalid/linked.docx"/>`,
    extra:{'word/embeddings/item.bin':new Uint8Array([1]),'word/charts/chart1.xml':'<chart/>',
      'word/charts/_rels/chart1.xml.rels':`<Relationships xmlns="${relationNamespace}"><Relationship Id="data" Type="${documentNamespace}/package" Target="../embeddings/chart-data.xlsx"/></Relationships>`,
      'word/embeddings/chart-data.xlsx':new Uint8Array([1,2,3])}})
  assert.deepEqual(inspectDocxImport(bytes),{complete:true,requiresSaveAs:false,warnings:[]})
})

test('only referenced Word headers are inspected for actual OLE objects',()=>{
  const options={links:`<Relationship Id="header" Type="${documentNamespace}/header" Target="header1.xml"/>`,
    extra:{'word/header1.xml':`<w:hdr xmlns:w="${wordNamespace}" xmlns:o="${officeNamespace}" xmlns:r="${documentNamespace}">${attachment}</w:hdr>`,
      'word/_rels/header1.xml.rels':`<Relationships xmlns="${relationNamespace}">${attachmentRelation}</Relationships>`,
      'word/embeddings/item.bin':new Uint8Array([1,2,3])}}
  assert.equal(inspectDocxImport(docx(options)).requiresSaveAs,false)
  const result=inspectDocxImport(docx({...options,body:'<w:sectPr><w:headerReference r:id="header"/></w:sectPr>'}))
  assert.equal(result.complete,true);assert.match(result.warnings[0],/含嵌入附件（1 项）/)
})

test('broken or mismatched DOCX object relationships yield an incomplete review, not an invented attachment count',()=>{
  for(const input of [docx({body:attachment}),docx({body:attachment,links:attachmentRelation}),
    docx({body:attachment,links:attachmentRelation.replace('/oleObject','/chart'),extra:{'word/embeddings/item.bin':new Uint8Array([1])}})]) {
    const review=inspectDocxImport(input)
    assert.equal(review.complete,false);assert.equal(review.requiresSaveAs,true)
    assert.match(review.warnings[0],/未能完成此 DOCX/);assert.doesNotMatch(review.warnings[0],/含嵌入附件/)
  }
})
