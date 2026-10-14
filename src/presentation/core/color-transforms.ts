/** Independently implemented DrawingML color math. Components stay floating
 * point through the ordered transform chain and are rounded only at output. */
export interface DrawingColorModifier { name: string; value: string }
export interface ResolvedDrawingColor { hex: string; alpha: number; rgb: [number, number, number] }
export type DrawingColorBase = string | { space: 'scRgb'; components: [string, string, string] } | { space: 'sRgb'; components: [number, number, number]; alpha?: number }
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const MAX_MODIFIERS = 32, MAX_VALUE = 2147483647
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const fail = (message: string): never => { throw new Error(`颜色变换暂不支持：${message}；原始颜色 XML 保留。`) }

export function drawingPercentage(value: string): number {
  const raw = value.trim()
  const amount = /^[+-]?\d+$/.test(raw) ? Number(raw) : /^[+-]?\d+(?:\.\d+)?%$/.test(raw) ? Number(raw.slice(0, -1)) * 1000 : NaN
  if (!Number.isFinite(amount) || Math.abs(amount) > MAX_VALUE) return fail('百分比数值无效或超出范围')
  return amount / 100000
}
function angle(value: string): number {
  const raw = value.trim(), amount = /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > MAX_VALUE) return fail('色相角度无效或超出范围')
  return amount / 21600000
}
const decodeSrgb = (value: number) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
const encodeSrgb = (value: number) => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055
const hex = (rgb: number[]) => '#' + rgb.map(value => Math.round(clamp(value) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()

export function scRgbColor(red: string, green: string, blue: string): string {
  return applyDrawingColorTransforms({ space: 'scRgb', components: [red, green, blue] }, []).hex
}

function toHsl(rgb: number[]): [number, number, number] {
  const [r, g, b] = rgb as [number, number, number], high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low, light = (high + low) / 2
  if (!delta) return [0, 0, light]
  const sector = high === r ? ((g - b) / delta + 6) % 6 : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return [sector / 6, delta / (1 - Math.abs(2 * light - 1)), light]
}
function fromHsl([h, s, l]: [number, number, number]): number[] {
  h = ((h % 1) + 1) % 1; s = clamp(s); l = clamp(l)
  const chroma = (1 - Math.abs(2 * l - 1)) * s, secondary = chroma * (1 - Math.abs(h * 6 % 2 - 1)), offset = l - chroma / 2
  const rgb = h < 1 / 6 ? [chroma, secondary, 0] : h < 2 / 6 ? [secondary, chroma, 0] : h < 3 / 6 ? [0, chroma, secondary] : h < 4 / 6 ? [0, secondary, chroma] : h < 5 / 6 ? [secondary, 0, chroma] : [chroma, 0, secondary]
  return rgb.map(value => value + offset)
}

/** Unknown transforms reject the entire chain instead of being ignored. */
export function applyDrawingColorTransforms(base: DrawingColorBase, modifiers: DrawingColorModifier[]): ResolvedDrawingColor {
  if (typeof base === 'string' ? !/^#[0-9a-f]{6}$/i.test(base) : !base || !['scRgb', 'sRgb'].includes(base.space) || base.components.length !== 3) return fail('基色缺失或无效')
  if (modifiers.length > MAX_MODIFIERS) return fail('变换数量超过 32 项预算')
  let rgb = typeof base === 'string' ? [1, 3, 5].map(index => parseInt(base.slice(index, index + 2), 16) / 255) : base.space === 'scRgb' ? base.components.map(component => encodeSrgb(clamp(drawingPercentage(component)))) : [...base.components], alpha = typeof base !== 'string' && base.space === 'sRgb' ? base.alpha ?? 1 : 1
  if (![...rgb, alpha].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return fail('浮点基色或透明度无效')
  for (const modifier of modifiers) {
    const name = modifier.name
    if (!/^(?:tint|shade|(?:alpha|lum|sat|hue)(?:Mod|Off)?)$/.test(name)) return fail(`未知变换 ${name.slice(0, 64)}`)
    const fraction = name === 'hue' || name === 'hueOff' ? angle(modifier.value) : drawingPercentage(modifier.value)
    if (['tint', 'shade', 'alpha', 'lum', 'sat', 'hue'].includes(name) && (fraction < 0 || fraction > 1) || name.endsWith('Mod') && fraction < 0 || name === 'alphaOff' && Math.abs(fraction) > 1) return fail(`${name} 数值超出定义范围`)
    if (name === 'alpha') alpha = fraction
    else if (name === 'alphaMod') alpha *= fraction
    else if (name === 'alphaOff') alpha += fraction
    else if (name === 'tint') rgb = rgb.map(value => encodeSrgb(1 - (1 - decodeSrgb(value)) * fraction))
    else if (name === 'shade') rgb = rgb.map(value => encodeSrgb(decodeSrgb(value) * fraction))
    else {
      const hsl = toHsl(rgb), index = name.startsWith('hue') ? 0 : name.startsWith('sat') ? 1 : 2
      hsl[index] = name.endsWith('Mod') ? hsl[index] * fraction : name.endsWith('Off') ? hsl[index] + fraction : fraction
      rgb = fromHsl(hsl)
    }
    rgb = rgb.map(clamp); alpha = clamp(alpha)
  }
  return { hex: hex(rgb), alpha, rgb: rgb as [number, number, number] }
}

/** Keep XML validation separate from the pure math so it can be checked without
 * a DOM or native editor. Strict OOXML percentage lexical values are accepted. */
export function drawingColorModifiers(source: Element): DrawingColorModifier[] {
  const children = Array.from(source.children)
  if (children.length > MAX_MODIFIERS) return fail('变换数量超过 32 项预算')
  return children.map(node => {
    if (node.namespaceURI !== A || !node.hasAttribute('val') || node.children.length || Array.from(node.attributes).some(attribute => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attribute.name !== 'val' || attribute.namespaceURI))) return fail('变换属性或命名空间无效')
    return { name: node.localName, value: node.getAttribute('val')! }
  })
}
