import { backgroundFromCss, normalizeBackgroundColor } from './background.ts'
import { normalizeTextColor, type TextColor, type TextStyle } from './model.ts'

/** Match Writer's automatic foreground on the supported white page and
 * opaque character shading. Highlight is a separate paint layer and does
 * not participate in Writer's foreground decision. */
export function textColorPaint(style: Pick<TextStyle, 'color' | 'highlight' | 'backgroundColor'>): string | undefined {
  if (style.color === undefined) return
  const color = normalizeTextColor(style.color)
  if (color !== 'auto') return color
  const background = style.backgroundColor === undefined || style.backgroundColor === 'none'
    ? '#FFFFFF' : normalizeBackgroundColor(style.backgroundColor)
  const [red, green, blue] = [1, 3, 5].map(index => Number.parseInt(background.slice(index, index + 2), 16))
  // LibreOffice keeps a historical IsDark exception for its Tango sky-blue
  // color. The general calculation truncates linear luminance to one byte.
  const dark = background === '#729FCF'
    ? Math.floor((29 * blue! + 151 * green! + 76 * red!) / 256) <= 62
    : Math.floor(255 * (.2126 * linear(red!) + .7152 * linear(green!) + .0722 * linear(blue!))) <= 87
  return dark ? '#FFFFFF' : '#000000'
}

function linear(channel: number): number {
  const normalized = channel / 255
  return normalized < .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4
}

/** CSS inheritance can retain an existing semantic color, but cannot create
 * OOXML auto. Reject alpha/dynamic/system colors rather than flattening them
 * into an opaque RGB or silently converting their intent to auto. */
export function textColorFromCss(value: string): Exclude<TextColor, 'auto'> | undefined {
  const css = value.trim().toLowerCase()
  if (!css || ['inherit', 'unset', 'currentcolor'].includes(css)) return
  try {
    const color = backgroundFromCss(css)
    if (color !== undefined && color !== 'none') return normalizeTextColor(color) as Exclude<TextColor, 'auto'>
  } catch { /* Give foreground-specific guidance for unsupported CSS paint. */ }
  throw Error('文字颜色仅支持不透明 RGB 颜色，请使用文字颜色设置。')
}
