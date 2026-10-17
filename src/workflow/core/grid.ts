type Rgb = [number, number, number]
type Rgba = [number, number, number, number]
const WHITE: Rgb = [255, 255, 255]
// The named colors accepted by documents.safeColor, including its CSS aliases.
const NAMED: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', blue: '0000ff', green: '008000', yellow: 'ffff00',
  orange: 'ffa500', purple: '800080', gray: '808080', grey: '808080', pink: 'ffc0cb', cyan: '00ffff',
  magenta: 'ff00ff', navy: '000080', teal: '008080', lime: '00ff00', maroon: '800000', olive: '808000',
  silver: 'c0c0c0', aqua: '00ffff', fuchsia: 'ff00ff', rebeccapurple: '663399',
}
const clamp = (value: number, maximum = 1) => Math.min(maximum, Math.max(0, value))
function component(token: string, maximum: number): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(token)) return undefined
  const value = parseFloat(token)
  return Number.isFinite(value) ? clamp(token.endsWith('%') ? value * maximum / 100 : value, maximum) : undefined
}
function parseColor(input: string): Rgba | undefined {
  const value = input.trim().toLowerCase()
  if (value === 'transparent' || value === 'none') return [0, 0, 0, 0]
  const hex = Object.hasOwn(NAMED, value) ? NAMED[value] : value.match(/^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/)?.[1]
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map(character => character + character).join('') : hex
    return [parseInt(expanded.slice(0, 2), 16), parseInt(expanded.slice(2, 4), 16), parseInt(expanded.slice(4, 6), 16), expanded.length === 8 ? parseInt(expanded.slice(6), 16) / 255 : 1]
  }
  const functional = value.match(/^(rgba?|hsla?)\(([^()]*)\)$/)
  if (!functional) return undefined
  const body = functional[2]!, comma = body.includes(',')
  let channels: string[], alpha = '1'
  if (comma) {
    if (body.includes('/')) return undefined
    channels = body.split(',').map(token => token.trim())
    if (channels.length === 4) alpha = channels.pop()!
  } else {
    const parts = body.split('/')
    if (parts.length > 2) return undefined
    channels = parts[0]!.trim().split(/\s+/)
    if (parts.length === 2) alpha = parts[1]!.trim()
  }
  if (channels.length !== 3) return undefined
  const opacity = component(alpha, 1)
  if (opacity === undefined) return undefined
  if (functional[1]!.startsWith('rgb')) {
    // Legacy comma syntax requires three percentages or three numbers.
    if (comma && channels.some(channel => channel.endsWith('%')) && !channels.every(channel => channel.endsWith('%'))) return undefined
    const values = channels.map(token => component(token, 255))
    return values.every(channel => channel !== undefined) ? [values[0]!, values[1]!, values[2]!, opacity] : undefined
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(channels[0]!) || (comma && (!channels[1]!.endsWith('%') || !channels[2]!.endsWith('%')))) return undefined
  const hue = Number(channels[0]) % 360 / 60, saturationValue = component(channels[1]!, 100), lightnessValue = component(channels[2]!, 100)
  if (!Number.isFinite(hue) || saturationValue === undefined || lightnessValue === undefined) return undefined
  const saturation = saturationValue / 100, lightness = lightnessValue / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, second = chroma * (1 - Math.abs(hue % 2 - 1)), offset = lightness - chroma / 2
  const base: Rgb = hue < 1 ? [chroma, second, 0] : hue < 2 ? [second, chroma, 0] : hue < 3 ? [0, chroma, second] : hue < 4 ? [0, second, chroma] : hue < 5 ? [second, 0, chroma] : [chroma, 0, second]
  return [(base[0] + offset) * 255, (base[1] + offset) * 255, (base[2] + offset) * 255, opacity]
}
function composite(color: Rgba, underlay: Rgb): Rgb {
  const alpha = color[3]
  return [color[0] * alpha + underlay[0] * (1 - alpha), color[1] * alpha + underlay[1] * (1 - alpha), color[2] * alpha + underlay[2] * (1 - alpha)]
}
function luminance(rgb: Rgb): number {
  const linear = rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4 })
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722
}
function contrast(a: number, b: number): number { return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }

/** Screen-sized dots on a world-aligned grid; transparent backgrounds blend over the actual canvas underlay. */
export function canvasGrid(zoom: number, background: string, underlay = '#ffffff') {
  const scale = Math.max(.1, Math.min(4, Number.isFinite(zoom) ? zoom : 1))
  const step = 20 * 2 ** Math.ceil(Math.log2(1 / scale))
  const base = composite(parseColor(underlay) ?? [255, 255, 255, 1], WHITE)
  const rendered = composite(parseColor(background) ?? [0, 0, 0, 0], base), backdrop = luminance(rendered)
  const candidates: Array<{ color: string; opacity: number; rgb: Rgb }> = [
    { color: '#64748b', opacity: .8, rgb: [100, 116, 139] },
    { color: '#cbd5e1', opacity: .75, rgb: [203, 213, 225] },
  ]
  const score = (candidate: typeof candidates[number]) => contrast(backdrop, luminance(composite([...candidate.rgb, candidate.opacity], rendered)))
  let selected = score(candidates[0]!) >= score(candidates[1]!) ? candidates[0]! : candidates[1]!
  // Midtone/custom backgrounds need a stronger pair; the normal palette can be
  // nearly identical to the backdrop even after selecting its better contrast.
  if (score(selected) < 3) {
    const stronger = [{ color: '#1e293b', opacity: .85, rgb: [30, 41, 59] as Rgb }, { color: '#f8fafc', opacity: .85, rgb: [248, 250, 252] as Rgb }]
    for (const candidate of stronger) if (score(candidate) > score(selected)) selected = candidate
  }
  return { step, radius: 1.25 / scale, color: selected.color, opacity: selected.opacity }
}
