import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { wordcraftDocx } from './helpers/wordcraft-smoke-fixture.mjs'

const script = fileURLToPath(new URL('../scripts/wordcraft-smoke-docx.py', import.meta.url))
const expected = { bold: true, italic: true, underline: true, size: 16, color: '336699' }
const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const rpr = '<w:b/><w:i/><w:u w:val="single"/><w:sz w:val="32"/><w:color w:val="336699"/>'

function check(mutate = () => {}, transform = bytes => bytes) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wordcraft-smoke-docx-'))
  try {
    const filename = path.join(directory, 'specimen.docx')
    writeFileSync(filename, transform(Buffer.from(wordcraftDocx(mutate), 'base64')))
    return spawnSync(process.env.PYTHON || 'python3', [script, filename], { encoding: 'utf8', timeout: 10000 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function accepts(mutate) {
  const result = check(mutate)
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const output = JSON.parse(result.stdout)
  assert.equal(output.text, 'WordCraft Native 中文😀')
  assert.deepEqual(output.format, expected)
  assert.equal(output.paragraphs.length, 1)
  assert.equal(output.paragraphs[0].runs.map(run => run.text).join(''), output.text)
  for (const run of output.paragraphs[0].runs) assert.deepEqual(run.format, expected)
  return output
}

function rejects(label, mutate, transform) {
  const result = check(mutate, transform)
  assert.equal(result.status, 1, `${label}: ${result.stdout || result.stderr || result.error?.message}`)
  assert.equal(result.stdout, '', `${label}: no partial success output`)
  assert.match(result.stderr, /DOCX smoke validation failed:/, label)
}

test('independent DOCX smoke oracle accepts direct formats and namespace-prefix changes', () => {
  accepts()
  accepts(parts => {
    for (const name of ['word/document.xml', 'word/styles.xml']) {
      parts[name] = parts[name].replaceAll('xmlns:w=', 'xmlns:x=').replaceAll('w:', 'x:')
    }
  })
})

test('oracle resolves defaults, basedOn and named-character styles with OOXML toggles', () => {
  accepts(parts => {
    parts['word/styles.xml'] = `<w:styles xmlns:w="${namespace}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="32"/><w:color w:val="336699"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:basedOn w:val="Base"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:u w:val="single"/></w:rPr></w:style></w:styles>`
    parts['word/document.xml'] = parts['word/document.xml'].replace(/<w:rPr>.*?<\/w:rPr>/, '<w:rPr><w:rStyle w:val="Emphasis"/></w:rPr>')
  })
  accepts(parts => {
    parts['word/styles.xml'] = `<w:styles xmlns:w="${namespace}"><w:style w:type="character" w:styleId="DefaultFont" w:default="1"><w:rPr><w:vanish/><w:color w:val="FF0000"/></w:rPr></w:style></w:styles>`
  })
  rejects('explicit default character style is applied', parts => {
    parts['word/styles.xml'] = `<w:styles xmlns:w="${namespace}"><w:style w:type="character" w:styleId="DefaultFont" w:default="1"><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`
    parts['word/document.xml'] = parts['word/document.xml'].replace('<w:rPr>', '<w:rPr><w:rStyle w:val="DefaultFont"/>')
  })
  rejects('two inherited bold toggles cancel', parts => {
    parts['word/styles.xml'] = `<w:styles xmlns:w="${namespace}"><w:style w:type="paragraph" w:styleId="Base"><w:rPr>${rpr}</w:rPr></w:style><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:basedOn w:val="Base"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`
    parts['word/document.xml'] = parts['word/document.xml'].replace(/<w:rPr>.*?<\/w:rPr>/, '')
  })
})

test('oracle rejects wrong text, partial formatting, mark-only formatting and hidden content', () => {
  for (const [label, mutate] of [
    ['wrong text', xml => xml.replace('中文😀', '中文')],
    ['wrong color', xml => xml.replace('336699', '336698')],
    ['wrong size', xml => xml.replace('w:sz w:val="32"', 'w:sz w:val="31"')],
    ['false bold', xml => xml.replace('<w:b/>', '<w:b w:val="0"/>')],
    ['wrong underline', xml => xml.replace('w:val="single"', 'w:val="double"')],
    ['unformatted tail', xml => xml.replace('</w:p>', '<w:r><w:t>extra</w:t></w:r></w:p>')],
    ['paragraph mark alone', xml => xml.replace('<w:p><w:r><w:rPr>', '<w:p><w:pPr><w:rPr>').replace('</w:rPr><w:t', '</w:rPr></w:pPr><w:r><w:t')],
    ['hidden text', xml => xml.replace('<w:rPr>', '<w:rPr><w:vanish/>')],
    ['extra paragraph', xml => xml.replace('</w:p>', '</w:p><w:p/>')],
    ['table', xml => xml.replace('</w:p>', '</w:p><w:tbl/>')],
    ['image', xml => xml.replace('</w:r>', '<w:drawing/></w:r>')],
    ['fake namespace', xml => xml.replace(namespace, 'urn:counterfeit-wordprocessingml')],
  ]) rejects(label, parts => { parts['word/document.xml'] = mutate(parts['word/document.xml']) })
})

test('oracle rejects missing or cyclic effective style references and broken OPC references', () => {
  rejects('missing character style', parts => { parts['word/document.xml'] = parts['word/document.xml'].replace('<w:rPr>', '<w:rPr><w:rStyle w:val="Missing"/>') })
  rejects('cyclic style', parts => { parts['word/styles.xml'] = parts['word/styles.xml'].replace('<w:name w:val="Normal"/>', '<w:basedOn w:val="Normal"/>') })
  rejects('missing relationship target', parts => { parts['_rels/.rels'] = parts['_rels/.rels'].replace('word/document.xml', 'word/missing.xml') })
  rejects('external relationship', parts => { parts['_rels/.rels'] = parts['_rels/.rels'].replace('Target="word/document.xml"', 'Target="https://example.invalid/doc.docx" TargetMode="External"') })
  rejects('wrong main MIME', parts => { parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('wordprocessingml.document.main+xml', 'wordprocessingml.template.main+xml') })
})

test('oracle rejects unsafe ZIP entries, corrupt bytes and compressed/expanded limit violations', () => {
  rejects('traversal', parts => { parts['../escape.xml'] = '<x/>' })
  rejects('duplicate path', parts => { parts['word/duplicat.xml'] = '<x/>' }, bytes => Buffer.from(bytes.toString('latin1').replaceAll('word/duplicat.xml', 'word/document.xml'), 'latin1'))
  rejects('encrypted entry', undefined, bytes => {
    for (let offset = 0; offset < bytes.length - 10; offset++) {
      const signature = bytes.readUInt32LE(offset)
      if (signature === 0x04034b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 1, offset + 6)
      if (signature === 0x02014b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8)
    }
    return bytes
  })
  rejects('truncated ZIP', undefined, bytes => bytes.subarray(0, bytes.length - 20))
  rejects('compressed size', undefined, bytes => Buffer.concat([bytes, Buffer.alloc(1024 * 1024)]))
  rejects('expanded size', parts => { parts['oversize.xml'] = '<x>' + ' '.repeat(16 * 1024 * 1024) + '</x>' })
})

test('oracle rejects DTD, entities, excessive XML nesting and undeclared XML entities', () => {
  rejects('entity declaration', parts => { parts['word/styles.xml'] = '<!DOCTYPE x [<!ENTITY x "expanded">]>' + parts['word/styles.xml'].replace('<?xml version="1.0"?>', '') })
  rejects('UTF16 DTD', parts => { parts['word/styles.xml'] = Buffer.from('\uFEFF<!DOCTYPE x><w:styles xmlns:w="' + namespace + '"/>', 'utf16le') })
  rejects('unresolved entity', parts => { parts['word/document.xml'] = parts['word/document.xml'].replace('中文😀', '&missing;') })
  rejects('depth limit', parts => { parts['word/styles.xml'] = '<x>'.repeat(65) + '</x>'.repeat(65) })
})
