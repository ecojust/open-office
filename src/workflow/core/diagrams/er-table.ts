import type { ElementStyle, SceneElement, ShapeElement } from '../types.ts'
import { measureTextWidth, textHorizontalInsets } from '../svg.ts'
import { resolveERTextStyle, type ERDiagramStyle, type ERTextRole, type ERTextStyle } from '../er-style.ts'
import { diagramNode, diagramStroke, diagramText } from './common.ts'

export interface ERField { text: string; comment: string }
interface ERTableMetrics {
  width: number; height: number; header: number; titleHeight: number; commentHeight: number; rowHeight: number; commentWidth: number
  styles: Record<ERTextRole, ERTextStyle>
}
/** Quoted source may contain escaped line breaks; a database row stays on one line. */
function singleLine(text: string): string { return text.replace(/[\r\n\t\u2028\u2029]+/g, ' ') }
function textWidth(text: string, style: ERTextStyle): number {
  const inset = textHorizontalInsets({ ...style, textWrap: 'nowrap' })
  return Math.ceil(measureTextWidth(singleLine(text), style.fontSize, style.fontWeight, style.fontStyle)) + inset.left + inset.right + 2
}
export function sizeERTable(name: string, comment: string, fields: ERField[], overrides?: ERDiagramStyle): ERTableMetrics {
  const styles = {
    title: resolveERTextStyle('title', overrides), tableComment: resolveERTextStyle('tableComment', overrides),
    field: resolveERTextStyle('field', overrides), comment: resolveERTextStyle('comment', overrides),
  }
  const fieldWidth = Math.max(0, ...fields.map(field => textWidth(field.text, styles.field)))
  const commentWidth = Math.max(0, ...fields.filter(field => field.comment).map(field => textWidth(field.comment, styles.comment)))
  const width = Math.ceil(Math.max(230, textWidth(name, styles.title) + 12, comment ? textWidth(comment, styles.tableComment) + 12 : 0, fieldWidth + (commentWidth ? commentWidth + 8 : 0) + 12))
  const titleHeight = Math.ceil(styles.title.fontSize * 1.35 + 12)
  const commentHeight = comment ? Math.ceil(styles.tableComment.fontSize * 1.35 + 12) : 0
  const header = titleHeight + commentHeight + 8
  const rowHeight = Math.ceil(Math.max(styles.field.fontSize, commentWidth ? styles.comment.fontSize : 0) * 1.35 + 12)
  return { width, height: header + Math.max(1, fields.length) * rowHeight + 12, header, titleHeight, commentHeight, rowHeight, commentWidth, styles }
}
export function erTable(id: string, name: string, comment: string, fields: ERField[], x: number, y: number, metrics: ERTableMetrics, elements: SceneElement[]): ShapeElement {
  const { width, height, header, titleHeight, commentHeight, rowHeight, commentWidth, styles } = metrics
  const start = elements.length
  const node = diagramNode(id, '', x, y, width, height, 'rectangle', { fill: '#f0fdf4', stroke: '#64748b' })
  elements.push(node)
  const styleFor = (role: ERTextRole): Partial<ElementStyle> => {
    const { color, ...style } = styles[role]
    return { ...style, textWrap: 'nowrap', stroke: color ?? (role === 'comment' || role === 'tableComment' ? '#64748b' : '#334155') }
  }
  elements.push(diagramText(`${id}-title`, singleLine(name), x + 6, y + 4, width - 12, titleHeight, styleFor('title')))
  if (comment) elements.push(diagramText(`${id}-tableComment`, singleLine(comment), x + 6, y + 4 + titleHeight, width - 12, commentHeight, styleFor('tableComment')))
  elements.push(diagramStroke(`${id}-separator`, [{ x, y: y + header }, { x: x + width, y: y + header }], { stroke: '#94a3b8', strokeWidth: 1 }))
  const fieldWidth = width - 12 - (commentWidth ? commentWidth + 8 : 0)
  fields.forEach((field, index) => {
    const rowY = y + header + 6 + index * rowHeight
    elements.push(diagramText(`${id}-field-${index}`, singleLine(field.text), x + 6, rowY, fieldWidth, rowHeight, styleFor('field')))
    if (field.comment) elements.push(diagramText(`${id}-comment-${index}`, singleLine(field.comment), x + width - 6 - commentWidth, rowY, commentWidth, rowHeight, styleFor('comment')))
  })
  for (const element of elements.slice(start)) element.groupId = `${id}-card`
  return node
}
