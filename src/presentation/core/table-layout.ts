import type { SlideObject } from './types'
import { A, children } from './pptx-common.ts'

export interface TableCellPaint { fill: string | null; opacity: number; explicit: boolean }
export interface TableLayout {
  /** Exact source grid units. No normalization to the graphic frame extents. */
  columns: number[]
  rows: number[]
  /** Absolute model size and inherited group scale at the import baseline. */
  baseWidth: number
  baseHeight: number
  scaleX: number
  scaleY: number
  cells: TableCellPaint[][]
}
const EMU = 36000, MAX_AXIS = 5000 * EMU
const direct = (node: Element | undefined, name: string) => children(node).filter(child => child.namespaceURI === A && child.localName === name)
const validUnit = (value: string | null): number | undefined => value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= MAX_AXIS ? Number(value) : undefined

/** Untrusted grids are not silently padded or replaced with an equal grid. */
export function readTableLayout(table: Element, object: SlideObject, scaleX: number, scaleY: number, resolveColor: (node: Element) => string | null): { layout?: TableLayout; blocked?: string; simplified: boolean } {
  const invalid = (reason: string) => ({ blocked: `${reason}，使用受保护占位；原始表格保留。`, simplified: false })
  const grids = direct(table, 'tblGrid'), rows = direct(table, 'tr'), grid = grids[0]
  if (table.namespaceURI !== A || grids.length !== 1 || !grid || rows.length === 0 || rows.length > 1000 || children(table).some(child => child.namespaceURI !== A || !['tblPr', 'tblGrid', 'tr', 'extLst'].includes(child.localName)) || direct(table, 'tblPr').length > 1) return invalid('表格网格缺失或不明确')
  const columns = direct(grid, 'gridCol'), rowCells = rows.map(row => direct(row, 'tc'))
  if (!columns.length || columns.length > 100 || children(grid).some(child => child.namespaceURI !== A || child.localName !== 'gridCol') || rows.some(row => children(row).some(child => child.namespaceURI !== A || !['tc', 'extLst'].includes(child.localName))) || rowCells.some(cells => cells.length !== columns.length) || rows.length * columns.length > 20000) return invalid('表格行列数量或结构不一致')
  if (rowCells.flat().some(cell => ['gridSpan', 'rowSpan'].some(name => cell.hasAttribute(name) && cell.getAttribute(name) !== '1') || ['hMerge', 'vMerge'].some(name => cell.hasAttribute(name) && !['0', 'false'].includes(cell.getAttribute(name)!)))) return invalid('合并单元格表格暂不支持布局预览')
  const widths = columns.map(col => validUnit(col.getAttribute('w'))), heights = rows.map(row => validUnit(row.getAttribute('h')))
  if (rows.some(row => /^0+$/.test(row.getAttribute('h') || ''))) return invalid('零行高表格需要尚未实现的内容自动排版')
  if (widths.some(value => value === undefined) || heights.some(value => value === undefined)) return invalid('表格列宽或行高无效')
  const sum = (values: Array<number | undefined>) => values.reduce<number>((total, value) => total + (value || 0), 0)
  if (sum(widths) > MAX_AXIS || sum(heights) > MAX_AXIS || ![scaleX, scaleY, object.width, object.height].every(value => Number.isFinite(value) && value > 0) || sum(widths) * scaleX > MAX_AXIS || sum(heights) * scaleY > MAX_AXIS) return invalid('表格尺寸超过预览预算')
  let simplified = false
  const properties = direct(table, 'tblPr')[0]
  if (properties && children(properties).length) simplified = true
  const cells = rowCells.map(cells => cells.map(cell => {
    const empty = { fill: null, opacity: 1, explicit: false }, props = direct(cell, 'tcPr')
    if (props.length !== 1) { if (props.length > 1) simplified = true; return empty }
    const paints = children(props[0]).filter(node => /^(solidFill|noFill|gradFill|pattFill|blipFill|grpFill)$/.test(node.localName))
    if (children(props[0]).some(node => !['solidFill', 'noFill'].includes(node.localName))) simplified = true
    if (!paints.length) return empty
    if (paints.length !== 1 || paints[0]!.namespaceURI !== A) { simplified = true; return empty }
    const paint = paints[0]!
    if (paint.localName === 'noFill' && !children(paint).length) return { ...empty, explicit: true }
    const colors = children(paint), color = colors[0], modifiers = color ? children(color) : []
    // Do not reuse the legacy RGB approximation for HSL/gamma color transforms.
    // Only alpha has a verified paint-only meaning in this bounded path.
    if (paint.localName !== 'solidFill' || colors.length !== 1 || color?.namespaceURI !== A || !['srgbClr', 'schemeClr', 'sysClr'].includes(color.localName) || color.localName === 'sysClr' && !/^[0-9a-f]{6}$/i.test(color.getAttribute('lastClr') || '') || modifiers.some(node => node.namespaceURI !== A || node.localName !== 'alpha' || !/^\d+$/.test(node.getAttribute('val') || '') || Number(node.getAttribute('val')) > 100000) || modifiers.length > 1) { simplified = true; return empty }
    const fill = resolveColor(paint)
    if (!fill || !/^#[0-9a-f]{6}$/i.test(fill)) { simplified = true; return empty }
    const alpha = modifiers.find(node => node.localName === 'alpha')
    return { fill, opacity: alpha ? Number(alpha.getAttribute('val')) / 100000 : 1, explicit: true }
  }))
  return { layout: { columns: widths as number[], rows: heights as number[], baseWidth: sum(widths) / EMU * scaleX, baseHeight: sum(heights) / EMU * scaleY, scaleX, scaleY, cells }, simplified }
}

/** Integer grid used both by the preview and by OOXML geometry writes. */
export function tableGrid(object: SlideObject, absolute = true): { columns: number[]; rows: number[] } | undefined {
  const cells = object.table?.cells
  if (!cells?.length || !cells[0]?.length || cells.some(row => row.length !== cells[0]!.length)) return
  const layout = object.tableLayout
  if (!object.sourceXml || object.table?.rebuilt) return { columns: cells[0].map(() => Math.max(1, Math.round(object.width / cells[0]!.length * EMU))), rows: cells.map(() => Math.max(1, Math.round(object.height / cells.length * EMU))) }
  if (!layout || layout.columns.length !== cells[0].length || layout.rows.length !== cells.length) return
  const scaled = (values: number[], size: number, base: number, scale: number) => values.map(value => Math.max(1, Math.round(value * size / base * (absolute ? scale : 1))))
  return { columns: scaled(layout.columns, object.width, layout.baseWidth, layout.scaleX), rows: scaled(layout.rows, object.height, layout.baseHeight, layout.scaleY) }
}

export function patchTableGrid(table: Element, object: SlideObject, absolute: boolean): void {
  const layout = object.tableLayout, grid = tableGrid(object, absolute)
  if (!layout || !grid) throw Error('表格缺少安全的行列尺寸映射，原文件未改变。')
  const columns = direct(direct(table, 'tblGrid')[0], 'gridCol'), rows = direct(table, 'tr')
  if (columns.length !== grid.columns.length || rows.length !== grid.rows.length) throw Error('表格行列尺寸映射不一致，原文件未改变。')
  columns.forEach((column, index) => column.setAttribute('w', String(grid.columns[index])))
  rows.forEach((row, index) => row.setAttribute('h', String(grid.rows[index])))
}
