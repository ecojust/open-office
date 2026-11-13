import shell from './en/shell.ts'
import workflow from './en/workflow.ts'
import notes from './en/notes.ts'
import schedule from './en/schedule.ts'
import calendar from './en/calendar.ts'
import native from './en/native.ts'

export type Locale = 'zh-CN' | 'en'
export type MessageParams = Record<string, string | number>
export const englishMessages: Readonly<Record<string, string>> = { ...native, ...notes, ...schedule, ...calendar, ...workflow, ...shell }

export function parseLocale(value: string | null | undefined): Locale {
  return value === 'en' || value === 'en-US' || value === 'en-GB' ? 'en' : 'zh-CN'
}

function interpolate(message: string, params: MessageParams): string {
  return message.replace(/\{([A-Za-z_]\w*)\}/g, (token, name: string) => Object.hasOwn(params, name) ? String(params[name]) : token)
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Some backends return already formatted diagnostics. Match only known UI
// messages; interpolated document names, source tokens and other values stay intact.
const patterns = Object.entries(englishMessages).flatMap(([source, translated]) => {
  const matches = [...source.matchAll(/\{([A-Za-z_]\w*)\}/g)]
  if (!matches.length) return []
  let offset = 0, expression = '^'
  for (const match of matches) {
    expression += escapeRegex(source.slice(offset, match.index)) + '([\\s\\S]+?)'
    offset = match.index! + match[0].length
  }
  expression += escapeRegex(source.slice(offset)) + '$'
  return [{ expression: new RegExp(expression), names: matches.map(match => match[1]!), translated, specificity: source.length - matches.reduce((sum, match) => sum + match[0].length, 0) }]
}).sort((a, b) => b.specificity - a.specificity)

function knownMessage(source: string, params: MessageParams): string | undefined {
  const direct = Object.hasOwn(englishMessages, source) ? englishMessages[source] : undefined
  if (direct !== undefined) return interpolate(direct, params)
  for (const pattern of patterns) {
    const match = pattern.expression.exec(source)
    if (match) return interpolate(pattern.translated, Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]!])) )
  }
  return undefined
}

function warningList(source: string, params: MessageParams): string | undefined {
  const parts = source.split('；')
  // Warning lists are short. Bound work for arbitrary unrecognized diagnostics.
  if (parts.length < 2 || parts.length > 32) return undefined
  const translated: Array<string[] | undefined> = new Array(parts.length + 1)
  translated[parts.length] = []
  for (let start = parts.length - 1; start >= 0; start--) {
    for (let end = parts.length; end > start; end--) {
      if (!translated[end]) continue
      const message = knownMessage(parts.slice(start, end).join('；'), params)
      if (message !== undefined) { translated[start] = [message, ...translated[end]!]; break }
    }
  }
  return translated[0]?.join('; ')
}

/** UI-only translation: callers never pass document content through this function. */
export function translate(locale: Locale, source: string, params: MessageParams = {}): string {
  if (locale === 'zh-CN') return interpolate(source, params)
  // Translate a joined warning list only when every complete message is known;
  // individual warnings can themselves contain semicolons.
  return knownMessage(source, params) ?? warningList(source, params) ?? interpolate(source, params)
}
