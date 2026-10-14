/** OOXML ST_HighlightColor uses a fixed palette, not arbitrary RGB values.
 * In particular, its green is bright green and darkBlue is CSS navy. */
export const HIGHLIGHT_COLORS = [
  { value: 'none', label: '无高亮', hex: undefined },
  { value: 'yellow', label: '黄色', hex: '#FFFF00' },
  { value: 'green', label: '绿色', hex: '#00FF00' },
  { value: 'cyan', label: '青色', hex: '#00FFFF' },
  { value: 'magenta', label: '洋红色', hex: '#FF00FF' },
  { value: 'blue', label: '蓝色', hex: '#0000FF' },
  { value: 'red', label: '红色', hex: '#FF0000' },
  { value: 'darkBlue', label: '深蓝色', hex: '#000080' },
  { value: 'darkCyan', label: '深青色', hex: '#008080' },
  { value: 'darkGreen', label: '深绿色', hex: '#008000' },
  { value: 'darkMagenta', label: '深洋红色', hex: '#800080' },
  { value: 'darkRed', label: '深红色', hex: '#800000' },
  { value: 'darkYellow', label: '深黄色', hex: '#808000' },
  { value: 'darkGray', label: '深灰色', hex: '#808080' },
  { value: 'lightGray', label: '浅灰色', hex: '#C0C0C0' },
  { value: 'black', label: '黑色', hex: '#000000' },
  { value: 'white', label: '白色', hex: '#FFFFFF' },
] as const

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]['value']
const colorValues = new Set<string>(HIGHLIGHT_COLORS.map(color => color.value))
export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === 'string' && colorValues.has(value)
}

const cssNames: Record<string, string> = {
  black: '#000000', blue: '#0000FF', aqua: '#00FFFF', cyan: '#00FFFF', lime: '#00FF00',
  fuchsia: '#FF00FF', magenta: '#FF00FF', red: '#FF0000', yellow: '#FFFF00', white: '#FFFFFF',
  navy: '#000080', teal: '#008080', green: '#008000', purple: '#800080', maroon: '#800000',
  olive: '#808000', gray: '#808080', grey: '#808080', silver: '#C0C0C0',
}

/** Read only a span's explicit background. Transparency reveals its parent
 * highlight, so it is not a semantic "none" override. Never use computed CSS
 * here: native input and regional-font spans normally have no own background. */
export function highlightFromCss(value: string): HighlightColor | undefined {
  const css = value.trim().toLowerCase()
  if (!css || css === 'transparent') return undefined
  let hex = cssNames[css]
  if (/^#[\da-f]{6}$/.test(css)) hex = css.toUpperCase()
  else if (/^#[\da-f]{3}$/.test(css)) hex = '#' + [...css.slice(1)].map(digit => digit + digit).join('').toUpperCase()
  const rgb = css.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*(\d*\.?\d+))?\s*\)$/)
  if (rgb) {
    const channels = rgb.slice(1, 4).map(Number), alpha = rgb[4] === undefined ? 1 : Number(rgb[4])
    if (channels.some(channel => channel > 255)) throw Error('文字高亮颜色超出支持范围。')
    if (alpha === 0) return undefined
    if (alpha !== 1) throw Error('暂不支持半透明文字高亮。')
    hex = '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  const color = hex ? HIGHLIGHT_COLORS.find(item => item.hex === hex) : undefined
  if (!color) throw Error('文字高亮仅支持标准的 16 种颜色。')
  return color.value
}
