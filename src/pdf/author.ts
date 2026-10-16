/** A local preference for future PDF annotations; it is never inferred from a file's author. */
export const PDF_AUTHOR_STORAGE_KEY = 'open-office.pdf-author'
export const PDF_AUTHOR_MAX_CHARS = 200

export function normalizePdfAuthor(value: string): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw Error('署名不能包含换行或控制字符。')
  const author = value.trim()
  if ([...author].length > PDF_AUTHOR_MAX_CHARS) throw Error(`署名最多 ${PDF_AUTHOR_MAX_CHARS} 个字符。`)
  return author
}

type AuthorStorage = Pick<Storage, 'getItem' | 'setItem'>
export function createPdfAuthorPreference(storage: () => AuthorStorage | undefined) {
  let author: string | undefined
  const listeners = new Set<(value: string) => void>()
  function read(): string {
    if (author !== undefined) return author
    try { author = normalizePdfAuthor(storage()?.getItem(PDF_AUTHOR_STORAGE_KEY) ?? '') }
    catch { author = '' }
    return author
  }
  function save(value: string): boolean {
    const next = normalizePdfAuthor(value)
    let persisted = false
    try { const target = storage(); if (target) { target.setItem(PDF_AUTHOR_STORAGE_KEY, next); persisted = true } }
    catch { /* Retain the explicit choice in this session if local storage is unavailable. */ }
    author = next
    for (const listener of listeners) listener(next)
    return persisted
  }
  return { read, save, subscribe(listener: (value: string) => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}

export const pdfAuthorPreference = createPdfAuthorPreference(() => typeof window === 'undefined' ? undefined : window.localStorage)
