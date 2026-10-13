import { strToU8, zipSync } from 'fflate'

export interface ChartWorkbookData {
  categories: string[]
  series: string[]
  /** One row per category, with one value per series. */
  values: (number | null)[][]
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const DOCUMENT_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
// XML 1.0 permits TAB, LF and CR, but not other C0 controls, lone UTF-16
// surrogates or U+FFFE/U+FFFF. Supplementary characters remain valid.
const INVALID_XML = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u

function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > 10_000 || INVALID_XML.test(value)) {
    throw new Error('Chart workbook labels must be valid XML text of at most 10000 characters.')
  }
  return value
}

function validate(input: ChartWorkbookData): ChartWorkbookData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Chart workbook data must be an object.')
  }
  const { categories, series, values } = input
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > 1_000
    || !Array.isArray(series) || series.length < 1 || series.length > 100
    || categories.length * series.length > 20_000) {
    throw new Error('Chart workbook requires 1–1000 categories, 1–100 series and at most 20000 data cells.')
  }
  if (!Array.isArray(values) || values.length !== categories.length) {
    throw new Error('Chart workbook values must have one row per category.')
  }
  // Capture validated values once; never mutate the original chart cache.
  const cleanCategories = Array.from(categories, label)
  const cleanSeries = Array.from(series, label)
  const cleanValues: (number | null)[][] = []
  for (let row = 0; row < categories.length; row++) {
    const source = values[row]
    if (!Array.isArray(source) || source.length !== series.length) {
      throw new Error('Chart workbook values must form a rectangular category × series matrix.')
    }
    const cells: (number | null)[] = []
    for (let column = 0; column < series.length; column++) {
      const value = source[column]
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Chart workbook values must be finite numbers or null.')
      }
      cells.push(value)
    }
    cleanValues.push(cells)
  }
  return { categories: cleanCategories, series: cleanSeries, values: cleanValues }
}

function columnName(index: number): string {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name
  }
  return name
}

function textCell(address: string, text: string): string {
  // OOXML interprets _xNNNN_ inside ST_Xstring as an escaped code point.
  // Escape its initial underscore so literal labels survive Excel/LO import.
  const escaped = text.replace(/_x[0-9a-fA-F]{4}_/g, match => `_x005F_${match.slice(1)}`)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;')
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`
}

/** Build an offline, editable Sheet1 for a presentation chart's cached data.
 * Labels occupy column A; series occupy columns B onward. No formulas, links,
 * macros, shared strings or remote relationships are generated.
 */
export function buildChartWorkbook(input: ChartWorkbookData): Uint8Array {
  const { categories, series, values } = validate(input)
  const columns = series.map((_, index) => columnName(index + 1))
  const rows = [`<row r="1"><c r="A1"/>${series.map((name, index) => textCell(`${columns[index]}1`, name)).join('')}</row>`]
  for (let index = 0; index < categories.length; index++) {
    const rowNumber = index + 2
    const cells = [textCell(`A${rowNumber}`, categories[index])]
    for (let column = 0; column < series.length; column++) {
      const address = `${columns[column]}${rowNumber}`, value = values[index][column]
      cells.push(value === null ? `<c r="${address}"/>` : `<c r="${address}" t="n"><v>${value}</v></c>`)
    }
    rows.push(`<row r="${rowNumber}">${cells.join('')}</row>`)
  }
  const parts: Record<string, string> = {
    '[Content_Types].xml': `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${DOCUMENT_REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML_HEADER}<workbook xmlns="${SHEET_NS}" xmlns:r="${DOCUMENT_REL_NS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${DOCUMENT_REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${DOCUMENT_REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML_HEADER}<styleSheet xmlns="${SHEET_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': `${XML_HEADER}<worksheet xmlns="${SHEET_NS}"><dimension ref="A1:${columns[columns.length - 1]}${categories.length + 1}"/><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows.join('')}</sheetData></worksheet>`,
  }
  return zipSync(Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)])), { level: 6 })
}
