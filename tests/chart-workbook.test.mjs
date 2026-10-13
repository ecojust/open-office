import test from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { buildChartWorkbook } from '../src/presentation/chart-workbook.ts'

const input = () => ({ categories: ['一月', '二月'], series: ['收入', '成本'], values: [[120, 30.5], [-5, null]] })
const unpack = data => Object.fromEntries(Object.entries(unzipSync(buildChartWorkbook(data))).map(([name, bytes]) => [name, strFromU8(bytes)]))
const attributes = source => Object.fromEntries([...source.matchAll(/([\w:]+)="([^"]*)"/g)].map(match => [match[1], match[2]]))
const relations = xml => [...xml.matchAll(/<Relationship\s+([^>]+)\/>/g)].map(match => attributes(match[1]))
function cells(xml) {
  const result = new Map()
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = attributes(match[1])
    result.set(attrs.r, { ...attrs, xml: match[2] ?? '' })
  }
  return result
}
const text = cell => cell.xml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1]
  .replace(/&#13;/g, '\r').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/_x([0-9a-f]{4})_/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))

test('XLSX package has a complete local relationship graph and spreadsheet content types', () => {
  const bytes = buildChartWorkbook(input())
  assert.ok(bytes instanceof Uint8Array)
  const files = Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, value]) => [name, strFromU8(value)]))
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort())
  const root = relations(files['_rels/.rels'])
  assert.equal(root.length, 1)
  assert.equal(root[0].Type, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument')
  assert.ok(files[root[0].Target])
  const sheet = attributes(files[root[0].Target].match(/<sheet\s+([^>]+)\/>/)[1])
  assert.equal(sheet.name, 'Sheet1')
  const workbookRelations = relations(files['xl/_rels/workbook.xml.rels'])
  assert.equal(new Set(workbookRelations.map(relation => relation.Id)).size, workbookRelations.length)
  assert.equal(workbookRelations.find(relation => relation.Id === sheet['r:id']).Target, 'worksheets/sheet1.xml')
  for (const relation of workbookRelations) {
    assert.equal(relation.TargetMode, undefined)
    assert.ok(!relation.Target.includes(':'))
    assert.ok(files[posix.normalize(posix.join('xl', relation.Target))], `Missing relationship target ${relation.Target}`)
  }
  const overrides = [...files['[Content_Types].xml'].matchAll(/<Override\s+([^>]+)\/>/g)].map(match => attributes(match[1]))
  assert.equal(overrides.length, 3)
  for (const override of overrides) assert.ok(files[override.PartName.slice(1)])
  assert.equal(overrides.find(part => part.PartName === '/xl/workbook.xml').ContentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
  assert.equal(overrides.find(part => part.PartName === '/xl/worksheets/sheet1.xml').ContentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
  assert.match(files['xl/styles.xml'], /<cellStyle name="Normal" xfId="0" builtinId="0"\/>/)
  for (const xml of Object.values(files)) {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"'))
    assert.doesNotMatch(xml, /<(?:f|externalLink|externalReference|oleObject)\b/)
  }
})

test('category rows and series columns remain editable text/numbers, with null distinct from zero', () => {
  const files = unpack(input()), xml = files['xl/worksheets/sheet1.xml'], data = cells(xml)
  assert.match(xml, /<dimension ref="A1:C3"\/>/)
  assert.equal(data.size, 9)
  assert.equal(data.get('A1').xml, '')
  assert.equal(text(data.get('B1')), '收入')
  assert.equal(text(data.get('C1')), '成本')
  assert.equal(text(data.get('A2')), '一月')
  assert.equal(text(data.get('A3')), '二月')
  for (const [address, expected] of [['B2', 120], ['C2', 30.5], ['B3', -5]]) {
    assert.equal(data.get(address).t, 'n')
    assert.equal(Number(data.get(address).xml.match(/<v>([^<]+)<\/v>/)[1]), expected)
  }
  assert.equal(data.get('C3').xml, '', 'Missing data must remain blank, not numeric zero or the text null')
  assert.equal(data.get('C3').t, undefined)
  const zero = cells(unpack({ categories: ['零'], series: ['值'], values: [[0]] })['xl/worksheets/sheet1.xml']).get('B2')
  assert.equal(zero.xml, '<v>0</v>')
})

test('labels preserve Chinese, emoji, XML metacharacters, whitespace and literal OOXML escape sequences', () => {
  const category = '  中文🍵 & < > " \' \t\r\n_x0041_ _x005F_  '
  const header = '=HYPERLINK("https://example.invalid/", "文字")'
  const data = cells(unpack({ categories: [category], series: [header], values: [[42]] })['xl/worksheets/sheet1.xml'])
  assert.equal(text(data.get('A2')), category)
  assert.equal(text(data.get('B1')), header)
  assert.equal(data.get('B1').t, 'inlineStr')
  assert.match(data.get('A2').xml, /xml:space="preserve"/)
  assert.match(data.get('A2').xml, /&amp; &lt; &gt; &quot; &apos;/)
  assert.match(data.get('A2').xml, /_x005F_x0041_/)
  assert.doesNotMatch(data.get('B1').xml, /<f\b/)
})

test('series beyond Z use valid AA/AB references without shifting their values', () => {
  const series = Array.from({ length: 27 }, (_, index) => `系列${index}`)
  const xml = unpack({ categories: ['分类'], series, values: [series.map((_, index) => index + 0.25)] })['xl/worksheets/sheet1.xml']
  const data = cells(xml)
  assert.equal(text(data.get('Z1')), '系列24')
  assert.equal(text(data.get('AA1')), '系列25')
  assert.equal(data.get('AA2').xml, '<v>25.25</v>')
  assert.equal(text(data.get('AB1')), '系列26')
  assert.match(xml, /<dimension ref="A1:AB2"\/>/)
})

test('exact category, series, label and 20000-data-cell boundaries are accepted', () => {
  const make = (rowCount, columnCount) => ({ categories: Array.from({ length: rowCount }, (_, index) => `分类${index}`), series: Array.from({ length: columnCount }, (_, index) => `系列${index}`), values: Array.from({ length: rowCount }, () => Array(columnCount).fill(null)) })
  for (const [rows, columns, range] of [[1000, 20, 'U1001'], [200, 100, 'CW201']]) {
    const xml = unpack(make(rows, columns))['xl/worksheets/sheet1.xml']
    assert.ok(xml.includes(`<dimension ref="A1:${range}"/>`))
    assert.equal(cells(xml).size, (rows + 1) * (columns + 1))
  }
  const long = '中'.repeat(10_000)
  const data = cells(unpack({ categories: [long], series: [long], values: [[1]] })['xl/worksheets/sheet1.xml'])
  assert.equal(text(data.get('A2')), long)
  assert.equal(text(data.get('B1')), long)
})

test('invalid shapes and over-budget matrices are rejected before a ZIP is returned', () => {
  const invalid = [null, undefined, [], {}, { ...input(), categories: [] }, { ...input(), series: [] },
    { ...input(), categories: 'one' }, { ...input(), series: 'two' }, { ...input(), values: {} },
    { ...input(), values: [[1, 2]] }, { ...input(), values: [[1, 2], [3]] },
    { ...input(), values: [[1, 2], [3, 4, 5]] }, { ...input(), values: [[1, 2], null] },
    { categories: Array(1001).fill('x'), series: ['s'], values: Array.from({ length: 1001 }, () => [1]) },
    { categories: ['c'], series: Array(101).fill('s'), values: [Array(101).fill(1)] },
    { categories: Array(201).fill('c'), series: Array(100).fill('s'), values: Array.from({ length: 201 }, () => Array(100).fill(1)) },
    { categories: Array(1), series: ['s'], values: [[1]] },
    { categories: ['c'], series: Array(1), values: [[1]] },
    { categories: ['c'], series: ['s'], values: Array(1) },
    { categories: ['c'], series: ['s'], values: [Array(1)] },
  ]
  for (const value of invalid) assert.throws(() => buildChartWorkbook(value), /Chart workbook/)
})

test('invalid XML characters, overlong strings and non-string labels are rejected in both axes', () => {
  for (const value of ['x'.repeat(10_001), '\0', '\u000b', '\u001f', '\ud800', '\udc00', '\ufffe', '\uffff', 1, null, {}]) {
    assert.throws(() => buildChartWorkbook({ categories: [value], series: ['s'], values: [[1]] }), /labels/)
    assert.throws(() => buildChartWorkbook({ categories: ['c'], series: [value], values: [[1]] }), /labels/)
  }
})

test('values only accept finite numbers or null, never formulas or coercible numeric strings', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, '1', '=SUM(A1:A2)', false, {}, [], 1n]) {
    assert.throws(() => buildChartWorkbook({ categories: ['c'], series: ['s'], values: [[value]] }), /finite numbers/)
  }
  const xml = unpack({ categories: ['c'], series: ['small', 'large', 'negative'], values: [[Number.MIN_VALUE, Number.MAX_VALUE, -12.75]] })['xl/worksheets/sheet1.xml']
  const data = cells(xml)
  assert.equal(Number(data.get('B2').xml.match(/<v>([^<]+)<\/v>/)[1]), Number.MIN_VALUE)
  assert.equal(Number(data.get('C2').xml.match(/<v>([^<]+)<\/v>/)[1]), Number.MAX_VALUE)
})

test('building a workbook leaves the original chart cache unchanged and accepts frozen inputs', () => {
  const source = input(), original = structuredClone(source)
  Object.freeze(source.categories); Object.freeze(source.series)
  source.values.forEach(Object.freeze); Object.freeze(source.values); Object.freeze(source)
  assert.ok(buildChartWorkbook(source).length > 0)
  assert.deepEqual(source, original)
})
