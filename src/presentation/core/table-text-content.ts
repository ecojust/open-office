import type { SlideObject } from './types'
import { A, all, child, children, readXml, snapshotXml } from './pptx-common.ts'
import { generatedTextBody, plainText } from './pptx-text.ts'
import { assertRangeTextBody, validateText } from './text-range-format.ts'
import { replaceDrawingTextContent } from './text-content-edit.ts'

function requireValue(value: unknown, message: string): asserts value { if (!value) throw Error(message) }
const XMLNS = 'http://www.w3.org/2000/xmlns/'
function signature(element: Element): string {
  const value = (node: Element): unknown => [node.namespaceURI, node.localName,
    Array.from(node.attributes).filter(attribute => attribute.namespaceURI !== XMLNS).map(attribute => [attribute.namespaceURI, attribute.localName, attribute.value]).sort(),
    Array.from(node.childNodes).map(item => item.nodeType === 1 ? value(item as Element) : [item.nodeType, item.nodeValue])]
  return JSON.stringify(value(element))
}
function sourceTable(object: SlideObject): Element {
  requireValue(object.sourceXml && object.sourceXml.length <= 2000000, '表格原始结构缺失或超过安全编辑预算。')
  const source = readXml(object.sourceXml).documentElement, tables = all(source, 'tbl')
  requireValue(tables.length === 1 && tables[0]!.namespaceURI === A, '表格结构不明确，原文档未改变。')
  const table = tables[0]!, rows = children(table, 'tr'), cells = object.table?.cells
  requireValue(cells && rows.length === cells.length && rows.every((row, index) => row.namespaceURI === A && children(row, 'tc').length === cells[index]!.length), '表格行列位置不一致，原文档未改变。')
  requireValue(!all(table, 'tc').some(cell => ['gridSpan', 'rowSpan'].some(name => Number(cell.getAttribute(name) || 1) !== 1) || ['hMerge', 'vMerge'].some(name => ['1', 'true', 'on'].includes(cell.getAttribute(name) || ''))), '合并单元格表格暂不支持安全编辑。')
  return table
}
export function materializeTableCell(object: SlideObject, row: number, column: number, table?: Element): Element {
  const override = object.table?.textOverrides?.[`${row}:${column}`]
  if (override) {
    requireValue(override.xml.length <= 1000000, '单元格文字超过安全编辑预算。')
    const body = readXml(override.xml).documentElement
    requireValue(plainText(body) === override.text && override.text === object.table?.cells[row]?.[column], '单元格文字与已保存格式不一致。')
    return body
  }
  const cell = children(children(table || sourceTable(object), 'tr')[row], 'tc')[column]
  requireValue(cell?.namespaceURI === A && children(cell, 'txBody').length === 1, '单元格文字正文缺失或重复，暂不支持编辑。')
  return child(cell, 'txBody')!.cloneNode(true) as Element
}
function cellReason(object: SlideObject, row: number, column: number, table?: Element): string | undefined {
  try {
    requireValue(object.type === 'table' && object.table && !object.locked, '此表格已受保护，暂不能编辑。')
    requireValue(!object.hasAnimation, '带原有动画的表格文字暂不支持编辑。')
    requireValue(object.table.cells.length <= 30 && object.table.cells.every(row => row.length <= 20), '此表格超过 30 行或 20 列，当前仅保留原件，暂不支持编辑。')
    const text = object.table.cells[row]?.[column]
    requireValue(typeof text === 'string', '单元格位置无效。'); validateText(text)
    if (!object.sourceXml || object.table.rebuilt) return
    const rich = object.tableCellText?.[row]?.[column]?.richText
    requireValue(rich && rich.sourceText === text, '单元格排版未完整解析，暂不支持编辑。')
    const body = materializeTableCell(object, row, column, table)
    assertRangeTextBody(body, A)
    requireValue(plainText(body) === text, '单元格原文与排版不一致。')
  } catch (error) { return (error instanceof Error ? error.message : String(error)).replaceAll('选区格式', '单元格改字') }
}
export function tableCellBlockedReasons(object: SlideObject): Array<Array<string | undefined>> {
  let table: Element | undefined
  try { if (object.sourceXml && !object.table?.rebuilt) table = sourceTable(object) } catch (error) { return object.table?.cells.map(row => row.map(() => error instanceof Error ? error.message : String(error))) || [] }
  return object.table?.cells.map((row, r) => row.map((_, c) => cellReason(object, r, c, table))) || []
}
export function tableCellBlockedReason(object: SlideObject, row: number, column: number): string | undefined { return cellReason(object, row, column) }

/** Only the app's demonstrably basic table template can be rebuilt on resize.
 * Custom cells, theme table styles, unequal geometry, borders and rich text stay
 * editable in place, but are never silently discarded by a structure change. */
export function tableResizeBlockedReason(object: SlideObject): string | undefined {
  try {
    requireValue(object.type === 'table' && object.table && !object.locked && !object.hasAnimation, '此表格不支持调整行列。')
    if (!object.sourceXml || object.table.rebuilt) return
    const table = sourceTable(object), rows = children(table, 'tr'), properties = child(table, 'tblPr'), grid = child(table, 'tblGrid')
    const generated = (xml: string) => readXml(`<a:root xmlns:a="${A}">${xml}</a:root>`).documentElement.firstElementChild!
    requireValue(properties && signature(properties) === signature(generated('<a:tblPr firstRow="0" bandRow="0"/>')) && grid && children(table).every(node => ['tblPr', 'tblGrid', 'tr'].includes(node.localName)), '此表格含自定义结构或样式；可改单元格文字，暂不能增减行列。')
    requireValue(children(grid).every(node => node.namespaceURI === A && node.localName === 'gridCol' && node.attributes.length === 1 && node.getAttribute('w') === children(grid)[0]?.getAttribute('w')), '此表格有自定义列宽，暂不能增减行列。')
    const sharedStyle = object.tableCellText?.[0]?.[0]?.richText?.sourceStyle
    const sharedProperties = child(children(rows[0], 'tc')[0], 'tcPr')
    for (const [r, row] of rows.entries()) {
      requireValue(row.attributes.length === 1 && row.hasAttribute('h') && row.getAttribute('h') === rows[0]!.getAttribute('h') && children(row).every(node => node.localName === 'tc' && node.namespaceURI === A), '此表格有自定义行结构，暂不能增减行列。')
      for (const [c, cell] of children(row, 'tc').entries()) {
        requireValue(!Array.from(cell.attributes).some(attribute => attribute.namespaceURI !== XMLNS) && children(cell).length === 2 && children(cell).every(node => ['txBody', 'tcPr'].includes(node.localName)), '此表格含自定义单元格，暂不能增减行列。')
        const style = object.tableCellText?.[r]?.[c]?.richText?.sourceStyle
        requireValue(style && JSON.stringify(style) === JSON.stringify(sharedStyle), '此表格有独立单元格字体，暂不能增减行列。')
        const body = materializeTableCell(object, r, c, table)
        const expected = generated(generatedTextBody({ ...object, textStyle: style, textLayout: undefined }, 'a', object.table.cells[r]![c]!))
        requireValue(signature(body) === signature(expected), '此表格含独立文字格式；可改单元格文字，暂不能增减行列。')
        const tcPr = child(cell, 'tcPr')!, fill = child(tcPr, 'solidFill')
        requireValue(tcPr && sharedProperties && signature(tcPr) === signature(sharedProperties), '此表格有独立单元格样式，暂不能增减行列。')
        requireValue(tcPr && ['marL', 'marR', 'marT', 'marB'].every(name => tcPr.getAttribute(name) === (name === 'marL' || name === 'marR' ? '91440' : '45720')) && Array.from(tcPr.attributes).filter(a => a.namespaceURI !== XMLNS).length === 4
          && children(tcPr).length === 1 && (child(tcPr, 'noFill') && children(child(tcPr, 'noFill')).length === 0 || fill && children(fill).length === 1 && child(fill, 'srgbClr') && children(child(fill, 'srgbClr')).length === 0), '此表格含自定义边框或单元格样式，暂不能增减行列。')
      }
    }
    // Compare the entire table against the concrete rebuild template, not just
    // selected attributes: unknown table/grid/cell/fill XML must not disappear.
    const working = table.cloneNode(true) as Element
    children(working, 'tr').forEach((row, r) => children(row, 'tc').forEach((cell, c) => cell.replaceChild(cell.ownerDocument.importNode(materializeTableCell(object, r, c, table), true), child(cell, 'txBody')!)))
    const fill = child(child(sharedProperties, 'solidFill'), 'srgbClr'), value = fill?.getAttribute('val')
    requireValue(!fill || value && /^[0-9a-fA-F]{6}$/.test(value), '表格填充无法安全重建。')
    const fillXml = fill ? `<a:solidFill><a:srgbClr val="${value}"/></a:solidFill>` : '<a:noFill/>'
    const width = Number(children(grid)[0]?.getAttribute('w')), height = Number(rows[0]?.getAttribute('h'))
    requireValue(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0, '表格尺寸无效。')
    const expected = generated(`<a:tbl><a:tblPr firstRow="0" bandRow="0"/><a:tblGrid>${object.table.cells[0]!.map(() => `<a:gridCol w="${width}"/>`).join('')}</a:tblGrid>${object.table.cells.map(row => `<a:tr h="${height}">${row.map(text => `<a:tc>${generatedTextBody({ ...object, textStyle: sharedStyle!, textLayout: undefined }, 'a', text)}<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720">${fillXml}</a:tcPr></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl>`)
    requireValue(signature(working) === signature(expected), '此表格含自定义 XML，暂不能增减行列。')
  } catch (error) { return error instanceof Error ? error.message : '此表格暂不能增减行列。' }
}

/** Atomically called by the controller transaction. Source package/XML never
 * mutate; only changed cells receive a bounded durable body override. */
export function replaceTableText(object: SlideObject, cells: string[][]): void {
  requireValue(object.table && object.type === 'table' && !object.locked, '此对象不支持表格编辑。')
  const original = object.table.cells
  if (JSON.stringify(original) === JSON.stringify(cells)) return
  for (const row of cells) for (const value of row) validateText(value)
  const resized = original.length !== cells.length || original.some((row, index) => row.length !== cells[index]?.length)
  if (resized) {
    const reason = tableResizeBlockedReason(object); requireValue(!reason, reason || '')
    // A basic table rebuild has no nonlocal cell XML to retain. Remove all old
    // coordinate-indexed metadata so it cannot drift to another cell.
    if (object.sourceXml && !object.table.rebuilt) {
      const table = sourceTable(object), first = children(children(table, 'tr')[0], 'tc')[0]
      object.textStyle = { ...object.tableCellText![0]![0]!.richText!.sourceStyle }
      const fill = child(child(child(first, 'tcPr'), 'solidFill'), 'srgbClr')
      object.fillColor = fill ? `#${fill.getAttribute('val')}` : null
    }
    object.table = { cells, rebuilt: true }; object.tableCellText = undefined; object.tableLayout = undefined
    object.text = cells.map(row => row.join('\t')).join('\n'); return
  }
  if (!object.sourceXml || object.table.rebuilt) { object.table = { cells, ...(object.table.rebuilt ? { rebuilt: true } : {}) }; object.text = cells.map(row => row.join('\t')).join('\n'); return }
  requireValue(object.tableCellText, '单元格排版未完整解析，暂不支持编辑。')
  const table = sourceTable(object), overrides = { ...object.table.textOverrides }, metadata = object.tableCellText!.map(row => row.map(cell => ({ ...cell })))
  for (const [r, row] of cells.entries()) for (const [c, value] of row.entries()) if (value !== original[r]![c]) {
    const reason = cellReason(object, r, c, table); requireValue(!reason, reason || '')
    const body = materializeTableCell(object, r, c, table), rich = metadata[r]![c]!.richText!
    const paragraphs = replaceDrawingTextContent(body, rich.paragraphs, original[r]![c]!, value)
    assertRangeTextBody(body, A)
    overrides[`${r}:${c}`] = { xml: snapshotXml(body), text: value }
    metadata[r]![c] = { ...metadata[r]![c], richText: { ...rich, sourceText: value, paragraphs } }
  }
  object.table = { cells, textOverrides: overrides }; object.tableCellText = metadata
  object.text = cells.map(row => row.join('\t')).join('\n')
}
