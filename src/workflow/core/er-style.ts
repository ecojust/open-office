import { clone, type Scene } from './types.ts'

export const ER_TEXT_ROLES = ['title', 'tableComment', 'field', 'comment'] as const
export type ERTextRole = typeof ER_TEXT_ROLES[number]
export interface ERTextStyle {
  fontSize: number
  fontWeight: 'normal' | 'bold'
  fontStyle: 'normal' | 'italic'
  textAlign: 'left' | 'center' | 'right'
  /** Omitted means follow the selected diagram theme. */
  color?: string
}
export type ERDiagramStyle = Partial<Record<ERTextRole, Partial<ERTextStyle>>>
const defaults: Record<ERTextRole, ERTextStyle> = {
  title: { fontSize: 16, fontWeight: 'bold', fontStyle: 'normal', textAlign: 'center' },
  tableComment: { fontSize: 13, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'center' },
  field: { fontSize: 14, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left' },
  comment: { fontSize: 14, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'right' },
}
/** Canonical overrides keep defaults compatible with existing saved documents. */
export function normalizeERDiagramStyle(value: unknown): ERDiagramStyle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: ERDiagramStyle = {}
  for (const role of ER_TEXT_ROLES) {
    const input = (value as Record<string, unknown>)[role]
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue
    const raw = input as Record<string, unknown>, style: Partial<ERTextStyle> = {}, base = defaults[role]
    if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)) {
      const size = Math.round(Math.max(10, Math.min(48, raw.fontSize)))
      if (size !== base.fontSize) style.fontSize = size
    }
    if ((raw.fontWeight === 'normal' || raw.fontWeight === 'bold') && raw.fontWeight !== base.fontWeight) style.fontWeight = raw.fontWeight
    if (raw.fontStyle === 'italic') style.fontStyle = 'italic'
    if ((raw.textAlign === 'left' || raw.textAlign === 'center' || raw.textAlign === 'right') && raw.textAlign !== base.textAlign) style.textAlign = raw.textAlign
    if (typeof raw.color === 'string' && /^#[\da-f]{6}$/i.test(raw.color)) style.color = raw.color.toLowerCase()
    if (Object.keys(style).length) result[role] = style
  }
  return result
}
export function resolveERTextStyle(role: ERTextRole, style?: ERDiagramStyle): ERTextStyle {
  return { ...defaults[role], ...normalizeERDiagramStyle(style)[role] }
}
/** Explicit role colors take precedence over the selected theme in every output. */
export function applyERColors(scene: Scene, style?: ERDiagramStyle): Scene {
  const normalized = normalizeERDiagramStyle(style)
  if (!ER_TEXT_ROLES.some(role => normalized[role]?.color)) return scene
  const result = clone(scene)
  for (const element of result.elements) {
    if (element.type !== 'shape' || element.shape !== 'text' || !/^er-\d+-card$/.test(element.groupId ?? '')) continue
    const role = /^er-\d+-(title|tableComment|field|comment)(?:-\d+)?$/.exec(element.id)?.[1] as ERTextRole | undefined
    if (role && normalized[role]?.color) element.style.stroke = normalized[role]!.color!
  }
  return result
}
