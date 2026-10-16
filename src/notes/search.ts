export interface NoteSearchMatch { start: number; end: number }
export interface NoteSearchSegment { text: string; match: boolean }

/** Fold characters separately so expanded casing forms retain their source offsets. */
function folded(text: string): { text: string; starts: number[]; ends: number[] } {
 let value = '', offset = 0
 const starts: number[] = [], ends: number[] = []
 for (const character of text) {
  // Upper/lower folding covers ligatures and compatibility letters as well as
  // ordinary casing. Dotless i remains distinct under locale-neutral matching.
  const part = (character === 'ı' ? character : character.toUpperCase().toLowerCase()).replace(/ß/g, 'ss').replace(/ς/g, 'σ')
  value += part
  for (let i = 0; i < part.length; i++) { starts.push(offset); ends.push(offset + character.length) }
  offset += character.length
 }
 return { text:value, starts, ends }
}

/** Literal, case-insensitive matches expressed as UTF-16 DOM Range offsets. */
export function noteSearchMatches(text: string, query: string): NoteSearchMatch[] {
 const needle = folded(query.trim()).text
 if (!needle || !text) return []
 const source = folded(text), matches: NoteSearchMatch[] = []
 let offset = 0
 while (offset <= source.text.length - needle.length) {
  const found = source.text.indexOf(needle, offset)
  if (found < 0) break
  const start = source.starts[found], end = source.ends[found + needle.length - 1], previous = matches.at(-1)
  // A folded character can contain several matches (for example ß → ss).
  if (previous && start < previous.end) previous.end = Math.max(previous.end, end)
  else matches.push({ start, end })
  offset = found + needle.length
 }
 return matches
}

/** Safe title/result decoration: callers render text, never search-generated HTML. */
export function searchSegments(text: string, query: string): NoteSearchSegment[] {
 const result: NoteSearchSegment[] = []
 let offset = 0
 for (const match of noteSearchMatches(text, query)) {
  if (match.start > offset) result.push({ text:text.slice(offset, match.start), match:false })
  result.push({ text:text.slice(match.start, match.end), match:true }); offset = match.end
 }
 if (offset < text.length) result.push({ text:text.slice(offset), match:false })
 return result.length ? result : [{ text, match:false }]
}

const omitted = new Set(['SCRIPT','STYLE','BUTTON','INPUT','TEXTAREA','SELECT','IMG','SVG'])
const boundaries = new Set(['P','DIV','LI','UL','OL','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','TABLE','TR','TD','TH'])
type TextPart = { node: Text; start: number; end: number }
function textParts(root: HTMLElement): { text: string; parts: TextPart[] } {
 let text = ''
 const parts: TextPart[] = []
 const boundary = () => { if (text && !text.endsWith('\n')) text += '\n' }
 const visit = (node: Node) => {
  if (node.nodeType === 3) {
   const content = node.textContent ?? ''
   if (content) { parts.push({ node:node as Text, start:text.length, end:text.length + content.length }); text += content }
   return
  }
  if (node.nodeType !== 1) return
  const element = node as HTMLElement
  if (omitted.has(element.tagName) || element.getAttribute('aria-hidden') === 'true' || element.getAttribute('contenteditable') === 'false') return
  if (element.tagName === 'BR') { text += '\n'; return }
  const block = boundaries.has(element.tagName)
  if (block) boundary()
  for (const child of element.childNodes) visit(child)
  if (block) boundary()
 }
 for (const child of root.childNodes) visit(child)
 return { text, parts }
}

export function noteSearchRanges(document: Document, elements: HTMLElement[], query: string): Range[] {
 const ranges: Range[] = []
 for (const element of elements) {
  const { text, parts } = textParts(element)
  let partIndex = 0
  for (const match of noteSearchMatches(text, query)) {
   while (partIndex < parts.length && parts[partIndex].end <= match.start) partIndex++
   const start = parts[partIndex]
   let endIndex = partIndex
   while (endIndex < parts.length && parts[endIndex].end < match.end) endIndex++
   const end = parts[endIndex]
   if (!start || !end || match.start < start.start || match.end > end.end) continue
   const range = document.createRange()
   range.setStart(start.node, match.start - start.start); range.setEnd(end.node, match.end - end.start)
   ranges.push(range)
  }
 }
 return ranges
}

type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): boolean }
type SearchHighlight = { add(range: Range): unknown }
type HighlightWindow = Window & {
 CSS?: { highlights?: HighlightRegistry }
 Highlight?: new () => SearchHighlight
 MutationObserver: typeof MutationObserver
 ResizeObserver?: typeof ResizeObserver
}
let nextHighlighter = 0

/**
 * Decorations live outside editable DOM and never modify text, caret or saved data.
 * Each editor owns its registry entry. Older WebViews receive clipped range rectangles.
 */
export function createNoteSearchHighlighter(document: Document): {
 refresh(elements: HTMLElement[], query: string): void
 clear(): void
 destroy(): void
} {
 const name = `open-office-note-search-${++nextHighlighter}`
 const view = document.defaultView as HighlightWindow | null
 const registry = view?.CSS?.highlights, Highlight = view?.Highlight
 let elements: HTMLElement[] = [], query = '', destroyed = false, frame: number | undefined
 let style: HTMLStyleElement | undefined, overlay: HTMLDivElement | undefined
 let mutation: MutationObserver | undefined, resize: ResizeObserver | undefined, listening = false

 const paint = () => {
  frame = undefined
  if (destroyed || !query || !elements.length) return
  const ranges = noteSearchRanges(document, elements.filter(element => element.isConnected), query)
  if (registry && Highlight) {
   if (!style) {
    style = document.createElement('style'); style.dataset.noteSearchStyle = name
    style.textContent = `::highlight(${name}) { background-color: #ffd761; color: #312408; }`
    document.head.append(style)
   }
   const highlight = new Highlight()
   for (const range of ranges) highlight.add(range)
   registry.set(name, highlight)
   return
  }
  if (!view) return
  if (!overlay) {
   overlay = document.createElement('div'); overlay.dataset.noteSearchOverlay = name; overlay.setAttribute('aria-hidden','true')
   Object.assign(overlay.style, { position:'fixed', inset:'0', pointerEvents:'none', zIndex:'3', overflow:'hidden' })
   document.body.append(overlay)
  }
  const fragment = document.createDocumentFragment()
  for (const range of ranges) {
   // Fixed decorations must follow the same clipping as the editable region.
   let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight
   let ancestor = range.startContainer.parentElement
   while (ancestor) {
    const computed = view.getComputedStyle(ancestor)
    const clipX = /^(auto|scroll|hidden|clip)$/.test(computed.overflowX), clipY = /^(auto|scroll|hidden|clip)$/.test(computed.overflowY)
    if (clipX || clipY) {
     const box = ancestor.getBoundingClientRect()
     if (clipX) { left = Math.max(left, box.left + ancestor.clientLeft); right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth) }
     if (clipY) { top = Math.max(top, box.top + ancestor.clientTop); bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight) }
    }
    ancestor = ancestor.parentElement
   }
   for (const rect of range.getClientRects()) {
    const x = Math.max(left, rect.left), y = Math.max(top, rect.top), width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y
    if (width <= 0 || height <= 0) continue
    const mark = document.createElement('span')
    Object.assign(mark.style, { position:'absolute', left:`${x}px`, top:`${y}px`, width:`${width}px`, height:`${height}px`, background:'rgba(255, 211, 77, .55)', borderRadius:'2px' })
    fragment.append(mark)
   }
  }
  overlay.replaceChildren(fragment)
 }
 const schedule = () => { if (!destroyed && query && frame === undefined && view) frame = view.requestAnimationFrame(paint) }
 const stop = () => {
  mutation?.disconnect(); resize?.disconnect()
  if (frame !== undefined) view?.cancelAnimationFrame(frame)
  frame = undefined
  if (listening) { document.removeEventListener('scroll', schedule, true); view?.removeEventListener('resize', schedule); listening = false }
 }
 const clear = () => {
  stop(); elements = []; query = ''; registry?.delete(name); overlay?.remove(); overlay = undefined
 }
 return {
  refresh(roots, value) {
   if (destroyed) return
   clear(); query = value.trim(); elements = [...new Set(roots)].filter(element => element.ownerDocument === document)
   if (!query || !elements.length) { elements = []; return }
   if (view?.MutationObserver) {
    mutation ??= new view.MutationObserver(schedule)
    for (const element of elements) mutation.observe(element, { subtree:true, childList:true, characterData:true })
   }
   if (!registry || !Highlight) {
    if (view?.ResizeObserver) { resize ??= new view.ResizeObserver(schedule); for (const element of elements) resize.observe(element) }
    document.addEventListener('scroll', schedule, true); view?.addEventListener('resize', schedule); listening = true
   }
   paint()
  },
  clear,
  destroy() { clear(); destroyed = true; style?.remove(); style = undefined },
 }
}
