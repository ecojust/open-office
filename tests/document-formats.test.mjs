import test from 'node:test'
import assert from 'node:assert/strict'
import { extensionOf, kindOf, defaultSaveExtension, isImportOnly, validateDocumentSignature, saveFileName } from '../src/shared/document.ts'

function ole(major=3) {
  const bytes=new Uint8Array(512),view=new DataView(bytes.buffer)
  bytes.set([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])
  for(const [offset,value] of [[26,major],[28,0xfffe],[30,major===3?9:12],[32,6]])view.setUint16(offset,value,true)
  return bytes
}
function zip(){const bytes=new Uint8Array(32);bytes.set([0x50,0x4b,0x03,0x04]);return bytes}
const encode=value=>new TextEncoder().encode(value)

test('chosen save names preserve meaningful dots and follow cross-platform native file limits',()=>{
  assert.equal(saveFileName('季度报告.v2','docx'),'季度报告.v2.docx')
  for(const value of ['', '../report', 'a/b', 'a\\b', 'a:b', 'a\x00b', 'a\x7fb', '.hidden', 'report.', 'report ', ' report', 'CON','nul.part','COM1','LPT9'])assert.throws(()=>saveFileName(value,'pdf'),undefined,value)
  assert.equal(saveFileName('字'.repeat(78),'docx').length,83)
  assert.throws(()=>saveFileName('字'.repeat(79),'docx'),/过长/)
})

test('old Office imports keep their family while the default save is a modern copy',()=>{
  for(const [source,kind,target] of [['doc','word','docx'],['rtf','word','docx'],['xls','sheet','xlsx'],['ppt','presentation','pptx']]){
    const extension=extensionOf('中文 report.'+source.toUpperCase())
    assert.equal(extension,source);assert.equal(kindOf(extension),kind)
    assert.equal(defaultSaveExtension(extension),target);assert.equal(isImportOnly(extension),true)
  }
  for(const extension of ['docx','odt','xlsx','ods','pptx','odp','pdf']){
    assert.equal(defaultSaveExtension(extension),extension);assert.equal(isImportOnly(extension),false)
  }
  for(const name of ['macro.docm','macro.xlsm','macro.pptm','data.xlsb','web.html','no-extension','report.docx.exe'])assert.throws(()=>extensionOf(name))
})

test('OLE screening rejects truncated, byte-swapped and mislabeled legacy containers',()=>{
  for(const extension of ['doc','xls','ppt']){
    assert.doesNotThrow(()=>validateDocumentSignature(ole(),extension))
    assert.doesNotThrow(()=>validateDocumentSignature(ole(4),extension))
    assert.throws(()=>validateDocumentSignature(ole().subarray(0,100),extension))
    const swapped=ole();swapped[28]=0
    assert.throws(()=>validateDocumentSignature(swapped,extension))
    assert.throws(()=>validateDocumentSignature(zip(),extension))
    assert.throws(()=>validateDocumentSignature(encode('<html>Renamed document</html>'),extension))
  }
})

test('text spreadsheets default to a workbook copy and reject invalid UTF-8 or binary controls',()=>{
  for(const extension of ['csv','tsv']) {
    assert.equal(extensionOf(`季度数据.${extension.toUpperCase()}`),extension)
    assert.equal(kindOf(extension),'sheet')
    assert.equal(defaultSaveExtension(extension),'xlsx')
    assert.equal(saveFileName('当前工作表',extension),`当前工作表.${extension}`)
    for(const text of ['名称,数量\r\n中文,12\r\n','\ufeff名称\t数量\n中文\t12\n'])assert.doesNotThrow(()=>validateDocumentSignature(encode(text),extension))
    for(const text of ['A\u0000B','A\u000bB','A\u007fB','A\u0085B'])assert.throws(()=>validateDocumentSignature(encode(text),extension))
    assert.throws(()=>validateDocumentSignature(new Uint8Array([0xc3,0x28]),extension))
    assert.throws(()=>validateDocumentSignature(new Uint8Array([0xff,0xfe,0x41,0]),extension))
    assert.throws(()=>validateDocumentSignature(new Uint8Array(),extension),/文档为空/)
  }
})

test('modern ZIP and RTF signatures fail closed before the engine parses content',()=>{
  for(const extension of ['docx','odt','xlsx','ods','pptx','odp']){
    assert.doesNotThrow(()=>validateDocumentSignature(zip(),extension))
    assert.throws(()=>validateDocumentSignature(ole(),extension),/加密文件/, 'Encrypted OOXML is OLE, not a readable ZIP package')
    assert.throws(()=>validateDocumentSignature(zip().subarray(0,4),extension))
  }
  assert.doesNotThrow(()=>validateDocumentSignature(encode('{\\rtf1\\ansi text}'),'rtf'))
  assert.doesNotThrow(()=>validateDocumentSignature(encode('{\\rtf1 text}'),'rtf'))
  for(const value of ['{\\rtf0 text}','{\\rtf1invalid}','plain text','{\\rtf1'])assert.throws(()=>validateDocumentSignature(encode(value),'rtf'))
})

test('PDF may have a short header prefix; empty or far-off fake headers are refused',()=>{
  assert.doesNotThrow(()=>validateDocumentSignature(encode('\n%PDF-1.7\n'),'pdf'))
  assert.throws(()=>validateDocumentSignature(encode(' '.repeat(1024)+'%PDF-1.7'),'pdf'))
  for(const extension of ['docx','odt','doc','rtf','xlsx','ods','xls','pptx','odp','ppt','pdf'])assert.throws(()=>validateDocumentSignature(new Uint8Array(),extension),/文档为空/)
})
