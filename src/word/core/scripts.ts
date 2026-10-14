/** Declared first-stage Word font routing. Theme fonts, font hints and complex
 * shaping scripts need their own layout contract and are not silently flattened. */
const unsupportedScript = /[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Common}\p{Script=Inherited}]/u
const eastAsianScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303f\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uffef]/u
const bidiControl = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
export function wordScript(character: string): 'eastAsia' | 'western' { return eastAsianScript.test(character) ? 'eastAsia' : 'western' }
export function assertSupportedWordText(text: string): void {
  if (unsupportedScript.test(text) || bidiControl.test(text)) throw Error('独立文字编辑器暂不支持此复杂文字或双向排版，请使用完整文字编辑器。')
}
