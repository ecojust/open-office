import { HIGHLIGHT_COLORS, type HighlightColor } from './highlight.ts'

export type BackgroundColor = `#${string}` | 'none'

/** DOCX character shading supports opaque RGB or an explicit clear. */
export function normalizeBackgroundColor(value: unknown): BackgroundColor {
  if (value === 'none') return value
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw Error('文字背景颜色必须是六位 RGB 颜色或无背景。')
  return value.toUpperCase() as BackgroundColor
}

/** Highlight is painted above shading; neither property's stored value is
 * replaced by this combined display color. */
export function textBackgroundColor(style: { highlight?: HighlightColor; backgroundColor?: BackgroundColor }): string | undefined {
  if (style.highlight !== undefined && style.highlight !== 'none') return HIGHLIGHT_COLORS.find(color => color.value === style.highlight)?.hex
  return style.backgroundColor === 'none' ? undefined : style.backgroundColor
}

const cssNames: Record<string, string> = {
  black: '#000000', blue: '#0000FF', aqua: '#00FFFF', cyan: '#00FFFF', lime: '#00FF00',
  fuchsia: '#FF00FF', magenta: '#FF00FF', red: '#FF0000', yellow: '#FFFF00', white: '#FFFFFF',
  navy: '#000080', teal: '#008080', green: '#008000', purple: '#800080', maroon: '#800000',
  olive: '#808000', gray: '#808080', grey: '#808080', silver: '#C0C0C0',
}

/** Read an explicit native CSS paint without guessing whether it originally
 * came from OOXML highlight. Transparent child spans reveal their ancestors. */
export function backgroundFromCss(value: string): BackgroundColor | undefined {
  const css = value.trim().toLowerCase()
  if (!css || css === 'transparent') return undefined
  let hex = cssNames[css]
  if (/^#[\da-f]{6}$/.test(css)) hex = css
  else if (/^#[\da-f]{3}$/.test(css)) hex = '#' + [...css.slice(1)].map(digit => digit + digit).join('')
  const rgb = css.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*(\d*\.?\d+))?\s*\)$/)
  if (rgb) {
    const channels = rgb.slice(1, 4).map(Number), alpha = rgb[4] === undefined ? 1 : Number(rgb[4])
    if (channels.some(channel => channel > 255)) throw Error('文字背景颜色超出 RGB 范围。')
    if (alpha === 0) return undefined
    if (alpha !== 1) throw Error('暂不支持半透明文字背景。')
    hex = '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('')
  }
  if (!hex) throw Error('文字背景颜色格式不受支持。')
  return normalizeBackgroundColor(hex)
}
