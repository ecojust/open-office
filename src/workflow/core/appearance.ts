import { clone, DEFAULT_STYLE, type ElementStyle, type Scene } from './types.ts'

export function resolveStrokePattern(style: Pick<ElementStyle, 'dashed' | 'strokePattern'>): NonNullable<ElementStyle['strokePattern']> {
  return style.strokePattern ?? (style.dashed ? 'dashed' : 'solid')
}

function normalizedStyle(style: ElementStyle): ElementStyle {
  const strokePattern = resolveStrokePattern(style)
  return { ...style, roughness: style.roughness ?? 'clean', strokePattern, dashed: strokePattern !== 'solid' }
}

/** Returns a detached, normalized default without changing a legacy document. */
export function sceneDefaultStyle(scene: Scene): ElementStyle {
  const input = scene.defaultStyle
  return normalizedStyle({ ...DEFAULT_STYLE, ...input, strokePattern: input ? resolveStrokePattern(input) : 'solid' })
}

/** Explicit canvas-wide appearance changes include locked elements and future elements. */
export function applyGlobalLineStyle(scene: Scene, patch: Partial<Pick<ElementStyle, 'roughness' | 'strokePattern' | 'strokeWidth' | 'stroke'>>): Scene {
  const change: typeof patch = {}
  if (patch.roughness !== undefined) {
    if (patch.roughness !== 'clean' && patch.roughness !== 'sketch') throw new Error('不支持此线条外观。')
    change.roughness = patch.roughness
  }
  if (patch.strokePattern !== undefined) {
    if (!['solid', 'dashed', 'dotted'].includes(patch.strokePattern)) throw new Error('不支持此线型。')
    change.strokePattern = patch.strokePattern
  }
  if (patch.strokeWidth !== undefined) {
    if (!Number.isFinite(patch.strokeWidth) || patch.strokeWidth < 0 || patch.strokeWidth > 100) throw new Error('线宽必须在 0 到 100 之间。')
    change.strokeWidth = patch.strokeWidth
  }
  if (patch.stroke !== undefined) {
    if (typeof patch.stroke !== 'string') throw new Error('线条颜色必须是文本。')
    change.stroke = patch.stroke
  }
  const result = clone(scene)
  result.defaultStyle = normalizedStyle({ ...sceneDefaultStyle(scene), ...change })
  result.elements = result.elements.map(element => ({ ...element, style: normalizedStyle({ ...normalizedStyle(element.style), ...change }) }))
  return result
}
