import type { ElementStyle, SceneElement, ShapeElement } from '../types.ts'
import { measureTextWidth, textHorizontalInsets } from '../svg.ts'
import type { EREntityStyle } from '../er-style.ts'
import { diagramNode, diagramStroke, diagramText } from './common.ts'

export interface ERField { text: string; comment: string }
type ERTextRole = 'title' | 'tableComment' | 'field' | 'comment'
type ERTextStyle = Pick<ElementStyle, 'fontSize' | 'fontWeight' | 'fontStyle' | 'textAlign'>
const defaults: Record<ERTextRole, ERTextStyle> = {
  title: { fontSize: 16, fontWeight: 'bold', fontStyle: 'normal', textAlign: 'center' },
  tableComment: { fontSize: 13, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'center' },
  field: { fontSize: 14, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left' },
  comment: { fontSize: 14, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'right' },
}
interface ERTableMetrics {
  width: number; height: number; header: number; titleHeight: number; commentHeight: number; rowHeight: number; commentWidth: number
  styles: Record<ERTextRole, ERTextStyle>
  appearance: EREntityStyle
}
/** Quoted source may contain escaped line breaks; a database row stays on one line. */
function singleLine(text: string): string { return text.replace(/[\r\n\t\u2028\u2029]+/g, ' ') }
function textWidth(text: string, style: ERTextStyle): number {
  const inset = textHorizontalInsets({ ...style, textWrap: 'nowrap' })
  return Math.ceil(measureTextWidth(singleLine(text), style.fontSize, style.fontWeight, style.fontStyle)) + inset.left + inset.right + 2
}
export function sizeERTable(name: string, comment: string, fields: ERField[], appearance: EREntityStyle = {}): ERTableMetrics {
  const textStyle = (role: ERTextRole): ERTextStyle => ({ ...defaults[role],
    ...(appearance.fontSize !== undefined ? { fontSize: appearance.fontSize } : {}),
    ...(appearance.fontWeight !== undefined ? { fontWeight: appearance.fontWeight } : {}),
    ...(appearance.fontStyle !== undefined ? { fontStyle: appearance.fontStyle } : {}),
  })
  const styles = {
    title: textStyle('title'), tableComment: textStyle('tableComment'), field: textStyle('field'), comment: textStyle('comment'),
  }
  const fieldWidth = Math.max(0, ...fields.map(field => textWidth(field.text, styles.field)))
  const commentWidth = Math.max(0, ...fields.filter(field => field.comment).map(field => textWidth(field.comment, styles.comment)))
  const width = Math.ceil(Math.max(230, textWidth(name, styles.title) + 12, comment ? textWidth(comment, styles.tableComment) + 12 : 0, fieldWidth + (commentWidth ? commentWidth + 8 : 0) + 12))
  const titleHeight = Math.ceil(styles.title.fontSize * 1.35 + 12)
  const commentHeight = comment ? Math.ceil(styles.tableComment.fontSize * 1.35 + 12) : 0
  const header = titleHeight + commentHeight + 8
  const rowHeight = Math.ceil(Math.max(styles.field.fontSize, commentWidth ? styles.comment.fontSize : 0) * 1.35 + 12)
  return { width, height: header + Math.max(1, fields.length) * rowHeight + 12, header, titleHeight, commentHeight, rowHeight, commentWidth, styles, appearance }
}
export function erTable(id: string, name: string, comment: string, fields: ERField[], x: number, y: number, metrics: ERTableMetrics, elements: SceneElement[]): ShapeElement {
  const { width, height, header, titleHeight, commentHeight, rowHeight, commentWidth, styles, appearance } = metrics
  const start = elements.length
  const border: Partial<ElementStyle> = {}
  for (const key of ['stroke', 'strokeWidth', 'opacity', 'strokePattern', 'dashed'] as const) {
    if (appearance[key] !== undefined) Object.assign(border, { [key]: appearance[key] })
  }
  const node = diagramNode(id, '', x, y, width, height, 'rectangle', { fill: appearance.fill ?? '#f0fdf4', stroke: '#64748b', ...border })
  elements.push(node)
  const styleFor = (role: ERTextRole): Partial<ElementStyle> => {
    return { ...styles[role], textWrap: 'nowrap', stroke: appearance.color ?? (role === 'comment' || role === 'tableComment' ? '#64748b' : '#334155'),
      ...(appearance.opacity !== undefined ? { opacity: appearance.opacity } : {}),
    }
  }
  elements.push(diagramText(`${id}-title`, singleLine(name), x + 6, y + 4, width - 12, titleHeight, styleFor('title')))
  if (comment) elements.push(diagramText(`${id}-tableComment`, singleLine(comment), x + 6, y + 4 + titleHeight, width - 12, commentHeight, styleFor('tableComment')))
  elements.push(diagramStroke(`${id}-separator`, [{ x, y: y + header }, { x: x + width, y: y + header }], { stroke: '#94a3b8', strokeWidth: 1, ...border }))
  const fieldWidth = width - 12 - (commentWidth ? commentWidth + 8 : 0)
  fields.forEach((field, index) => {
    const rowY = y + header + 6 + index * rowHeight
    elements.push(diagramText(`${id}-field-${index}`, singleLine(field.text), x + 6, rowY, fieldWidth, rowHeight, styleFor('field')))
    if (field.comment) elements.push(diagramText(`${id}-comment-${index}`, singleLine(field.comment), x + width - 6 - commentWidth, rowY, commentWidth, rowHeight, styleFor('comment')))
  })
  for (const element of elements.slice(start)) element.groupId = `${id}-card`
  return node
}
