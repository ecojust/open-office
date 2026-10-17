import { clone, type ElementStyle, type Scene, type SceneElement, type Point } from './types.ts'
import { center, elementBounds, pointInPolygon, shapeContainsPoint } from './geometry.ts'

export type DiagramStyleId = 'classic' | 'minimal' | 'blueprint' | 'ink' | 'sketch' | 'forest' | 'ocean' | 'sunset' | 'lavender' | 'midnight'
export interface DiagramStyle {
  readonly id: DiagramStyleId
  readonly label: string
  readonly description: string
  readonly background: string
  readonly foreground: string
  readonly surface: string
  readonly palette: readonly string[]
  readonly roughness: 'clean' | 'sketch'
}
/** These are our own presentation presets; the source language remains unchanged. */
export const DIAGRAM_STYLES: readonly DiagramStyle[] = [
  { id: 'classic', label: '经典', description: '保留图表原有颜色与线条', background: '#ffffff', foreground: '#334155', surface: '#eff6ff', palette: ['#6389e7', '#61b9a0', '#f0b45b', '#ad86d6', '#e78291', '#5bafca', '#bdba5a', '#bc8e70'], roughness: 'clean' },
  { id: 'minimal', label: '极简', description: '纯白底色与清晰克制的配色', background: '#ffffff', foreground: '#20252d', surface: '#f5f6f8', palette: ['#475569', '#2563eb', '#0f766e', '#a16207', '#7e22ce', '#be123c', '#0369a1', '#4d7c0f'], roughness: 'clean' },
  { id: 'blueprint', label: '蓝图', description: '深蓝底色与明亮工程线条', background: '#102b4e', foreground: '#edf7ff', surface: '#1c4168', palette: ['#79c7ff', '#78e4d2', '#f7d77c', '#c3adff', '#ffa6b7', '#9ed6ed', '#c2e88c', '#ffc296'], roughness: 'clean' },
  { id: 'ink', label: '水墨', description: '暖纸底色与沉静的墨色层次', background: '#f5f2e9', foreground: '#292b28', surface: '#e8e5da', palette: ['#40515b', '#42615b', '#7d6340', '#67516b', '#81534f', '#3f6571', '#686b43', '#7b5c48'], roughness: 'clean' },
  { id: 'sketch', label: '手绘', description: '纸张底色与自然的双笔触轮廓', background: '#fffcf3', foreground: '#414039', surface: '#fff4d8', palette: ['#3563a7', '#3b795f', '#a36622', '#795399', '#b04e61', '#29778b', '#6e792e', '#955f3e'], roughness: 'sketch' },
  { id: 'forest', label: '森林', description: '柔和浅绿与森林植物色彩', background: '#f1f8f3', foreground: '#173f2f', surface: '#e0eee4', palette: ['#23734e', '#527b32', '#326f81', '#926523', '#73568e', '#a14f5c', '#357568', '#7c6548'], roughness: 'clean' },
  { id: 'ocean', label: '海洋', description: '浅海底色与蓝绿珊瑚配色', background: '#eef8fc', foreground: '#153b50', surface: '#deeff6', palette: ['#176c9b', '#147d80', '#3e5eaa', '#a55c36', '#6c579d', '#a34e72', '#44794e', '#8b6a24'], roughness: 'clean' },
  { id: 'sunset', label: '落日', description: '温暖底色与橙红暮光色彩', background: '#fff5ef', foreground: '#593524', surface: '#ffe7d9', palette: ['#ad512e', '#b23f58', '#975c21', '#82528f', '#3f6d88', '#47775c', '#975254', '#6d6539'], roughness: 'clean' },
  { id: 'lavender', label: '紫雾', description: '轻柔紫色底面与花园配色', background: '#f8f4ff', foreground: '#413052', surface: '#ece4f7', palette: ['#7954a3', '#a54881', '#5264aa', '#3d7b78', '#a25e34', '#65783d', '#955560', '#59628b'], roughness: 'clean' },
  { id: 'midnight', label: '夜色', description: '深色画布与清晰的彩色数据', background: '#141824', foreground: '#edf0fa', surface: '#272e42', palette: ['#91b6ff', '#7dd6b3', '#eec780', '#c2a0f2', '#f49eaf', '#7fc7e2', '#c5d98c', '#dfb292'], roughness: 'clean' },
].map(style => Object.freeze({ ...style, palette: Object.freeze(style.palette) })) as readonly DiagramStyle[]

export function normalizeDiagramStyle(value: unknown): DiagramStyleId {
  return typeof value === 'string' && DIAGRAM_STYLES.some(style => style.id === value) ? value as DiagramStyleId : 'classic'
}
type RGB = [number, number, number]
interface Color { rgb: RGB; alpha: number }
const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', pink: '#ffc0cb', cyan: '#00ffff', magenta: '#ff00ff', navy: '#000080', teal: '#008080', lime: '#00ff00', maroon: '#800000', olive: '#808000', silver: '#c0c0c0', aqua: '#00ffff', fuchsia: '#ff00ff', rebeccapurple: '#663399' }
const clamp = (value: number) => Math.max(0, Math.min(1, value))
function hsl(h: number, s: number, l: number): RGB {
  const hue = ((h % 360) + 360) % 360 / 60, chroma = (1 - Math.abs(2 * l - 1)) * s, x = chroma * (1 - Math.abs(hue % 2 - 1)), m = l - chroma / 2
  const rgb: RGB = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x]
  return rgb.map(value => clamp(value + m)) as RGB
}
function parseColor(input: string): Color | undefined {
  let value = input.trim().toLowerCase()
  if (value === 'none' || value === 'transparent') return undefined
  value = named[value] ?? value
  const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (hex) {
    let body = hex[1]!
    if (body.length < 5) body = [...body].map(char => char + char).join('')
    return { rgb: [0, 2, 4].map(index => parseInt(body.slice(index, index + 2), 16) / 255) as RGB, alpha: body.length === 8 ? parseInt(body.slice(6), 16) / 255 : 1 }
  }
  const functional = value.match(/^(rgba?|hsla?)\(([^)]+)\)$/)
  if (!functional) return undefined
  const parts = functional[2]!.split(/[\s,/]+/).filter(Boolean)
  if (parts.length !== 3 && parts.length !== 4) return undefined
  if (parts.some(part => !/^[-+]?(?:\d+\.?\d*|\.\d+)%?$/.test(part))) return undefined
  const alpha = parts[3] ? clamp(parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1)) : 1
  const rgb: RGB = functional[1]!.startsWith('rgb') ? parts.slice(0, 3).map(part => clamp(parseFloat(part) / (part.endsWith('%') ? 100 : 255))) as RGB : hsl(parseFloat(parts[0]!), clamp(parseFloat(parts[1]!) / 100), clamp(parseFloat(parts[2]!) / 100))
  return { rgb, alpha }
}
function hex(rgb: RGB): string { return '#' + rgb.map(value => Math.round(clamp(value) * 255).toString(16).padStart(2, '0')).join('') }
function key(color: Color): string { return hex(color.rgb) }
function neutral(color: Color): boolean { return Math.max(...color.rgb) - Math.min(...color.rgb) < .19 }
function luminance(rgb: RGB): number {
  const channels = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722
}
function contrast(a: RGB, b: RGB): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
function mix(a: RGB, b: RGB, weight: number): RGB { return a.map((value, i) => value * (1 - weight) + b[i]! * weight) as RGB }
function encoded(rgb: RGB, alpha: number): string { return alpha < 1 ? `${hex(rgb)}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : hex(rgb) }
function readable(candidate: string, background: RGB, style: DiagramStyle): string {
  const parsed = parseColor(candidate)
  if (parsed && contrast(mix(background, parsed.rgb, parsed.alpha), background) >= 4.5) return candidate
  return [style.foreground, '#ffffff', '#10131b'].sort((a, b) => contrast(parseColor(b)!.rgb, background) - contrast(parseColor(a)!.rgb, background))[0]!
}
interface Paint { index: number; element: SceneElement; bounds: ReturnType<typeof elementBounds>; color: Color }
/** Apply to the freshly compiled scene, never to a previously styled preview. */
export function applyDiagramStyle(scene: Scene, styleId: unknown): Scene {
  const id = normalizeDiagramStyle(styleId), result = clone(scene)
  if (id === 'classic') return result
  const preset = DIAGRAM_STYLES.find(style => style.id === id)!, background = parseColor(preset.background)!.rgb
  result.background = preset.background
  // One canonical color map is shared by shapes, paths, data series and legends.
  // Sorting makes it independent of z-order, and equal colors remain equal across roles.
  const colors = new Set<string>()
  for (const element of scene.elements) for (const input of [element.style.fill, element.style.stroke]) {
    const color = parseColor(input)
    if (color && color.alpha > 0 && !neutral(color)) colors.add(key(color))
  }
  const mapped = new Map<string, RGB>(), used = new Set<string>()
  ;[...colors].sort().forEach((original, index) => {
    const base = parseColor(preset.palette[index % preset.palette.length]!)!.rgb, cycle = Math.floor(index / preset.palette.length)
    let rgb = cycle ? mix(base, cycle % 2 ? parseColor(preset.surface)!.rgb : parseColor(preset.foreground)!.rgb, Math.min(.6, Math.ceil(cycle / 2) * .12)) : base
    // Avoid accidental category collapse even for diagrams with many distinct colors.
    let attempt = 0
    while (used.has(hex(rgb))) {
      const integer = (parseInt(hex(rgb).slice(1), 16) + 257 + attempt++) % 0x1000000
      rgb = [(integer >> 16 & 255) / 255, (integer >> 8 & 255) / 255, (integer & 255) / 255]
    }
    used.add(hex(rgb)); mapped.set(original, rgb)
  })
  function recolor(input: string, role: 'fill' | 'stroke'): string {
    const color = parseColor(input)
    if (!color || !color.alpha) return input
    const rgb = mapped.get(key(color)) ?? parseColor(role === 'stroke' ? preset.foreground : luminance(color.rgb) < .16 ? preset.foreground : preset.surface)!.rgb
    return encoded(rgb, color.alpha)
  }
  function appearance(input: ElementStyle): ElementStyle {
    return { ...input, fill: recolor(input.fill, 'fill'), stroke: recolor(input.stroke, 'stroke'), roughness: preset.roughness }
  }
  result.elements = result.elements.map(element => ({ ...element, style: appearance(element.style) }))
  if (result.defaultStyle) result.defaultStyle = appearance(result.defaultStyle)
  const paints: Paint[] = []
  result.elements.forEach((element, index) => {
    const paint = parseColor(element.style.fill)
    if (!paint || paint.alpha * element.style.opacity <= 0) return
    if (element.type === 'shape' && !['text', 'image', 'frame'].includes(element.shape) || element.type === 'stroke' && element.closed) paints.push({ element, index, color: { ...paint, alpha: paint.alpha * element.style.opacity }, bounds: elementBounds(element) })
  })
  function under(point: Point, before: number): RGB {
    const layers: Color[] = []
    for (let i = paints.length - 1; i >= 0; i--) {
      const paint = paints[i]!, bounds = paint.bounds
      if (paint.index >= before || point.x < bounds.x || point.x > bounds.x + bounds.width || point.y < bounds.y || point.y > bounds.y + bounds.height) continue
      const element = paint.element
      if (!(element.type === 'shape' ? shapeContainsPoint(element, point) : element.type === 'stroke' && pointInPolygon(point, element.points))) continue
      layers.push(paint.color); if (paint.color.alpha >= 1) break
    }
    return layers.reverse().reduce((color, layer) => mix(color, layer.rgb, layer.alpha), background)
  }
  result.elements.forEach((element, index) => {
    if (element.type === 'shape' && element.shape === 'text') element.style.fill = 'none'
    if (element.type === 'shape' && element.text) {
      const behind = under(center(element), index + (element.shape === 'text' || element.shape === 'frame' ? 0 : 1))
      element.style.stroke = readable(element.style.stroke, behind, preset)
    } else if (element.type === 'edge' && element.label) element.style.stroke = readable(element.style.stroke, background, preset)
  })
  return result
}
