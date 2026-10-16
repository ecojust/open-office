import { blankBlock, noteId, validateImage, type NoteBlock, type NoteInline, type NoteMark, type NoteTextBlock } from './model.ts'
const ignored = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','TEMPLATE','LINK','META','FORM','BUTTON'])
const blockTags = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','LI','UL','OL','BLOCKQUOTE','PRE','SECTION','ARTICLE','FIGURE','TABLE','TR','TD','TH'])
const tagMarks: Record<string, NoteMark> = { B:'bold', STRONG:'bold', I:'italic', EM:'italic', U:'underline', S:'strike', STRIKE:'strike', DEL:'strike', CODE:'code' }
function marksFor(element: HTMLElement, inherited: NoteMark[]): NoteMark[] {
 const next = [...inherited]
 if (tagMarks[element.tagName]) next.push(tagMarks[element.tagName])
 // Read supported formatting only; never copy styles, URLs or event attributes.
 if (/^(bold|[6-9]00)$/.test(element.style.fontWeight)) next.push('bold')
 if (element.style.fontStyle === 'italic') next.push('italic')
 if (element.style.textDecoration.includes('underline')) next.push('underline')
 if (element.style.textDecoration.includes('line-through')) next.push('strike')
 return [...new Set(next)]
}
function inlines(nodes: Iterable<Node>, inherited: NoteMark[] = []): NoteInline[] {
 const result: NoteInline[] = []
 const append = (value: string, marks: NoteMark[]) => {
  if (!value) return
  const normalized = [...new Set(marks)].sort() as NoteMark[]
  const last = result.at(-1)
  if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(normalized)) last.text += value
  else result.push(normalized.length ? { text: value, marks: normalized } : { text: value })
 }
 const visit = (node: Node, marks: NoteMark[], depth: number) => {
  if (depth > 100) return
  if (node.nodeType === 3) { append(node.textContent ?? '', marks); return }
  if (node.nodeType !== 1) return
  const element = node as HTMLElement
  if (ignored.has(element.tagName) || element.tagName === 'INPUT' || element.tagName === 'IMG') return
  if (element.tagName === 'BR') { append('\n', marks); return }
  const next = marksFor(element, marks)
  for (const child of element.childNodes) visit(child, next, depth + 1)
 }
 for (const node of nodes) visit(node, inherited, 0)
 return result
}
/** Read only text, known marks and validated local raster images. All other attributes are discarded. */
export function blocksFromDom(root: ParentNode, preserveIds = true): NoteBlock[] {
 const result: NoteBlock[] = [], used = new Set<string>()
 const id = (element?: HTMLElement) => { const candidate = preserveIds ? element?.dataset.noteId : undefined; const value = candidate && /^[A-Za-z0-9_-]{1,100}$/.test(candidate) && !used.has(candidate) ? candidate : noteId(); used.add(value); if (preserveIds && element) element.dataset.noteId = value; return value }
 const addText = (nodes: Node[], element?: HTMLElement, parentList?: string, inherited: NoteMark[] = []) => {
  let type: NoteTextBlock['type'] = 'paragraph', level: 1|2|3 | undefined
  if (element?.dataset.noteType === 'todo') type = 'todo'
  else if (element?.tagName === 'LI') type = parentList === 'OL' ? 'numbered' : 'bullet'
  else if (element && /^H[1-6]$/.test(element.tagName)) { type = 'heading'; level = Math.min(3, Number(element.tagName[1])) as 1|2|3 }
  const content = inlines(nodes, inherited)
  if (content.length === 1 && content[0].text === '\n') content.splice(0)
  const block: NoteTextBlock = { id: id(element), type, content }
  if (level) block.level = level
  if (type === 'todo') block.checked = Boolean(element?.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked)
  result.push(block)
 }
 // Browsers may insert a block inside an active STRONG/EM/SPAN wrapper.
 // Locate structural descendants before flattening text, preserving both the
 // nested block semantics (especially checkbox state) and inherited marks.
 const structuralCache = new WeakMap<Node, boolean>()
 const structural = (node: Node, depth = 0): boolean => {
  if (depth > 100) throw Error('粘贴的内容层级过深，请分段粘贴。')
  if (node.nodeType !== 1 || ignored.has((node as Element).tagName)) return false
  if (structuralCache.has(node)) return structuralCache.get(node)!
  const value = blockTags.has((node as Element).tagName) || (node as Element).tagName === 'IMG' || [...node.childNodes].some(child => structural(child, depth + 1))
  structuralCache.set(node, value); return value
 }
 const visit = (node: Node, parentList?: string, depth = 0, inherited: NoteMark[] = []) => {
  if (depth > 100 || result.length >= 20000) throw Error('粘贴的内容过多或层级过深，请分段粘贴。')
  if (node.nodeType === 3) { if (node.textContent?.trim()) addText([node], undefined, parentList, inherited); return }
  if (node.nodeType !== 1) return
  const element = node as HTMLElement
  if (ignored.has(element.tagName) || element.tagName === 'INPUT') return
  if (element.tagName === 'IMG') {
   try { result.push({ id:id(element), type:'image', dataUrl:validateImage(element.getAttribute('src')), alt:Array.from(element.getAttribute('alt') ?? '').slice(0,200).join('') }) } catch { /* Remote, SVG and malformed images are intentionally omitted. */ }
   return
  }
  const next = marksFor(element, inherited)
  if (element.tagName === 'UL' || element.tagName === 'OL') { for (const child of element.childNodes) visit(child, element.tagName, depth + 1, next); return }
  if (element.dataset.noteType === 'todo') { addText([...element.childNodes], element, parentList, next); return }
  const children = [...element.childNodes]
  if (!children.some(child => structural(child))) { addText(children, element, parentList, next); return }
  let inline: Node[] = []
  const flush = () => { if (inline.some(child => child.textContent?.length || (child as Element).tagName === 'BR')) addText(inline, element, parentList, next); inline = [] }
  for (const child of children) {
   if (structural(child)) { flush(); visit(child, parentList, depth + 1, next) }
   else inline.push(child)
  }
  flush()
 }
 for (const child of root.childNodes) visit(child)
 return result.length ? result : [blankBlock()]
}
export function blocksFromHtml(html: string): NoteBlock[] {
 if (html.length > 2 * 1024 * 1024) throw Error('粘贴内容过大，请分段粘贴。')
 return blocksFromDom(new DOMParser().parseFromString(html, 'text/html').body, false)
}
export function renderBlocks(document: Document, blocks: NoteBlock[], editable = true): DocumentFragment {
 const fragment = document.createDocumentFragment()
 let list: HTMLElement | undefined, listType = ''
 for (const block of blocks) {
  if (block.type === 'image') {
   list = undefined
   const figure = document.createElement('figure'), image = document.createElement('img')
   figure.contentEditable = 'false'; image.src = block.dataUrl; image.alt = block.alt; image.dataset.noteId = block.id
   figure.append(image)
   if (editable) { const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除图片'; remove.dataset.deleteImage = block.id; remove.setAttribute('aria-label', `删除图片${block.alt ? `：${block.alt}` : ''}`); figure.append(remove) }
   fragment.append(figure); continue
  }
  const listed = block.type === 'bullet' || block.type === 'numbered'
  const element = document.createElement(listed ? 'li' : block.type === 'heading' ? `h${block.level ?? 1}` : 'div')
  element.dataset.noteId = block.id
  if (listed) {
   if (!list || listType !== block.type) { list = document.createElement(block.type === 'bullet' ? 'ul' : 'ol'); listType = block.type; fragment.append(list) }
   list.append(element)
  } else { list = undefined; fragment.append(element) }
  if (block.type === 'todo') {
   element.dataset.noteType = 'todo'
   const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !!block.checked; checkbox.contentEditable = 'false'; checkbox.setAttribute('aria-label','标记待办完成'); checkbox.tabIndex = editable ? 0 : -1
   element.append(checkbox)
  }
  for (const inline of block.content) {
   let node: Node = document.createTextNode(inline.text)
   for (const mark of inline.marks ?? []) { const wrapper = document.createElement(({bold:'strong',italic:'em',underline:'u',strike:'s',code:'code'} as const)[mark]); wrapper.append(node); node = wrapper }
   element.append(node)
  }
  if (!block.content.length) element.append(document.createElement('br'))
 }
 return fragment
}
