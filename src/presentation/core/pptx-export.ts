import type { PresentationModel, SlideModel, SlideObject } from './types'
import type { PptxPatch } from '../pptx-package'
import { patchPptxPackage, writePptxParts, PptxPackageError, PPTX_LIMITS } from '../pptx-package'
import { buildChartWorkbook } from '../chart-workbook'
import { ensureNotesMasters } from './pptx-notes'
import { P, A, R, C, PR, CT, readXml, writeXml, child, children, all, relPart, resolvePart, relativePart, xmlEscape as esc, objectFingerprint, emu, xmlBytes } from './pptx-common'

const NS = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:c="${C}"`
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.'
const XMLNS = 'http://www.w3.org/2000/xmlns/'
const GROUP_ROOT = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
const GROUP_TYPES = new Set(['nvGrpSpPr', 'grpSpPr', 'extLst'])

function node(xml: string): Element { return readXml(`<p:root ${NS}>${xml}</p:root>`).documentElement.firstElementChild! }
function append(parent: Element, xml: string) { const result = parent.ownerDocument.importNode(node(xml), true); parent.appendChild(result); return result }
function replace(parent: Element, local: string, xml: string) {
  const previous = child(parent, local), value = parent.ownerDocument.importNode(node(xml), true)
  if (previous) parent.replaceChild(value, previous)
  else if (local === 'xfrm') parent.insertBefore(value, parent.localName === 'graphicFrame' ? child(parent, 'nvGraphicFramePr')?.nextSibling || parent.firstChild : parent.firstChild)
  else if (local === 'ln') parent.insertBefore(value, children(parent).find(item => ['effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst'].includes(item.localName)) || null)
  else parent.insertBefore(value, child(parent, 'extLst') || null)
  return value
}
function color(value: string | null | undefined): string { return (value || '000000').replace(/^#/, '').toUpperCase() }
function solid(value: string | null, opacity = 1) {
  return value === null ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${esc(color(value))}">${opacity < 1 ? `<a:alpha val="${Math.round(Math.max(0, opacity) * 100000)}"/>` : ''}</a:srgbClr></a:solidFill>`
}
function line(object: SlideObject) { return `<a:ln w="${Math.max(0, emu(object.lineWidth))}">${solid(object.lineColor)}<a:prstDash val="solid"/></a:ln>` }
function transform(object: SlideObject, graphic = false, group = false) {
  return `<${graphic ? 'p' : 'a'}:xfrm${object.rotation ? ` rot="${Math.round(object.rotation * 60000)}"` : ''}><a:off x="${emu(object.x)}" y="${emu(object.y)}"/><a:ext cx="${Math.max(1, emu(object.width))}" cy="${Math.max(1, emu(object.height))}"/>${group ? `<a:chOff x="${emu(object.x)}" y="${emu(object.y)}"/><a:chExt cx="${Math.max(1, emu(object.width))}" cy="${Math.max(1, emu(object.height))}"/>` : ''}</${graphic ? 'p' : 'a'}:xfrm>`
}
function textParagraphs(text: string, object: SlideObject) {
  const style = object.textStyle, alignment = { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[style.align]
  const properties = `lang="zh-CN" sz="${Math.round(style.fontSize * 100)}" b="${style.bold ? 1 : 0}" i="${style.italic ? 1 : 0}" u="${style.underline ? 'sng' : 'none'}"`
  const fonts = `<a:latin typeface="${esc(style.fontName)}"/><a:ea typeface="${esc(style.fontName)}"/><a:cs typeface="${esc(style.fontName)}"/>`
  return text.split('\n').map(paragraph => `<a:p><a:pPr algn="${alignment}"/><a:r><a:rPr ${properties}>${solid(style.color)}${fonts}</a:rPr><a:t xml:space="preserve">${esc(paragraph)}</a:t></a:r><a:endParaRPr ${properties}/></a:p>`).join('')
}
function bodyProperties(object: SlideObject) {
  const layout = object.textLayout, insets = layout?.insets || { left: 1.3, right: 1.3, top: 1.3, bottom: 1.3 }
  return `<a:bodyPr wrap="${layout?.wrap === false ? 'none' : 'square'}" anchor="${({ top: 't', middle: 'ctr', bottom: 'b' } as const)[layout?.verticalAlign || 'top']}" lIns="${emu(insets.left)}" rIns="${emu(insets.right)}" tIns="${emu(insets.top)}" bIns="${emu(insets.bottom)}" rot="${Math.round((layout?.rotation || 0) * 60000)}"/>`
}
function textBody(object: SlideObject, prefix = 'p', text = object.text) { return `<${prefix}:txBody>${bodyProperties(object)}<a:lstStyle/>${textParagraphs(text, object)}</${prefix}:txBody>` }
function nonVisual(object: SlideObject, id: number, kind: 'sp' | 'pic' | 'graphicFrame' | 'grpSp') {
  const name = kind === 'graphicFrame' ? 'GraphicFrame' : kind[0]!.toUpperCase() + kind.slice(1)
  return `<p:nv${name}Pr><p:cNvPr id="${id}" name="${esc(object.name)}"/><p:cNv${name}Pr${object.type === 'text' ? ' txBox="1"' : ''}/><p:nvPr/></p:nv${name}Pr>`
}
function plainText(parent: Element | undefined) {
  return parent ? all(parent, 'p').map(paragraph => children(paragraph).map(run => run.localName === 'br' ? '\n' : all(run, 't').map(t => t.textContent || '').join('')).join('')).join('\n') : ''
}
function baseline(object: SlideObject): Partial<SlideObject> | undefined {
  try { return object.sourceFingerprint ? JSON.parse(object.sourceFingerprint) : undefined } catch { return undefined }
}
function differs(object: SlideObject, previous: Partial<SlideObject> | undefined, key: keyof SlideObject) { return !previous || JSON.stringify(object[key]) !== JSON.stringify(previous[key]) }
function mediaShape(shape: Element) { return all(shape, 'audioFile').length > 0 || all(shape, 'videoFile').length > 0 || all(shape, 'media').length > 0 }

/** Keep paragraph/run structure, links, fields and all unmodeled formatting.
 * The editor changes only the explicitly modified character attributes. */
function patchTextStyle(body: Element, object: SlideObject, previous: Partial<SlideObject> | undefined) {
  const style = object.textStyle, before = previous?.textStyle
  const changed = (key: keyof SlideObject['textStyle']) => !before || style[key] !== before[key]
  const paragraphs = children(body, 'p')
  for (const paragraph of paragraphs) {
    let properties = child(paragraph, 'pPr')
    if (!properties) { properties = paragraph.ownerDocument.createElementNS(A, 'a:pPr'); paragraph.insertBefore(properties, paragraph.firstChild) }
    if (changed('align')) properties.setAttribute('algn', { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[style.align])
    if (!child(properties, 'defRPr')) {
      const defaults = properties.ownerDocument.createElementNS(A, 'a:defRPr'); properties.insertBefore(defaults, child(properties, 'extLst') || null)
    }
    for (const run of children(paragraph).filter(element => ['r', 'fld', 'br'].includes(element.localName))) if (!child(run, 'rPr')) {
      const properties = run.ownerDocument.createElementNS(A, 'a:rPr'); run.insertBefore(properties, run.firstChild)
    }
    if (!child(paragraph, 'endParaRPr')) append(paragraph, '<a:endParaRPr/>')
  }
  const properties = [...all(body, 'rPr'), ...all(body, 'defRPr'), ...all(body, 'endParaRPr')]
  for (const property of properties) {
    if (changed('fontSize')) property.setAttribute('sz', String(Math.round(style.fontSize * 100)))
    if (changed('bold')) property.setAttribute('b', style.bold ? '1' : '0')
    if (changed('italic')) property.setAttribute('i', style.italic ? '1' : '0')
    if (changed('underline')) property.setAttribute('u', style.underline ? 'sng' : 'none')
    if (changed('color')) {
      for (const fill of children(property)) if (['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(fill.localName)) fill.remove()
      property.insertBefore(property.ownerDocument.importNode(node(solid(style.color)), true), children(property).find(element => element.localName !== 'ln') || null)
    }
    if (changed('fontName')) for (const [fontName, successors] of [['latin', ['ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']], ['ea', ['cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']], ['cs', ['sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']]] as const) {
      let font = child(property, fontName)
      if (!font) { font = property.ownerDocument.createElementNS(A, `a:${fontName}`); property.insertBefore(font, children(property).find(element => (successors as readonly string[]).includes(element.localName)) || null) }
      font.setAttribute('typeface', style.fontName)
    }
  }
}

function patchTextLayout(body: Element, object: SlideObject, previous: Partial<SlideObject> | undefined) {
  if (!differs(object, previous, 'textLayout')) return
  const generated = node(bodyProperties(object)), existing = child(body, 'bodyPr')
  if (!existing) { body.insertBefore(body.ownerDocument.importNode(generated, true), body.firstChild); return }
  // bodyPr may also contain vertical text, columns, fitting and 3D settings.
  // Updating the modeled fields never replaces those unrelated settings.
  const before = previous?.textLayout, current = object.textLayout
  const changed: Record<string, boolean> = {
    anchor: !before || current?.verticalAlign !== before.verticalAlign,
    wrap: !before || current?.wrap !== before.wrap,
    rot: !before || current?.rotation !== before.rotation,
    lIns: !before || current?.insets?.left !== before.insets?.left,
    rIns: !before || current?.insets?.right !== before.insets?.right,
    tIns: !before || current?.insets?.top !== before.insets?.top,
    bIns: !before || current?.insets?.bottom !== before.insets?.bottom,
  }
  for (const attribute of Array.from(generated.attributes)) if (!attribute.namespaceURI && changed[attribute.name]) existing.setAttribute(attribute.name, attribute.value)
}

function patchText(body: Element, object: SlideObject, previous: Partial<SlideObject> | undefined, text = object.text) {
  if (plainText(body) !== text) {
    const originals = children(body, 'p'), paragraphs = text.split('\n')
    for (const paragraph of originals) paragraph.remove()
    paragraphs.forEach((value, index) => {
      const original = originals[Math.min(index, originals.length - 1)], paragraph = original ? original.cloneNode(true) as Element : node('<a:p/>')
      // Retain every run when the paragraph's text has not changed. Edited
      // plain text uses its paragraph and first run formatting as a template.
      const oldText = original ? children(original).map(run => run.localName === 'br' ? '\n' : all(run, 't').map(element => element.textContent || '').join('')).join('') : undefined
      if (oldText !== value) {
        const runProperties = all(paragraph, 'rPr')[0]?.cloneNode(true) as Element | undefined
        for (const run of children(paragraph)) if (['r', 'fld', 'br'].includes(run.localName)) run.remove()
        const run = paragraph.ownerDocument.createElementNS(A, 'a:r')
        if (runProperties) run.appendChild(runProperties)
        const content = paragraph.ownerDocument.createElementNS(A, 'a:t'); content.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); content.textContent = value; run.appendChild(content)
        paragraph.insertBefore(run, child(paragraph, 'endParaRPr') || null)
      }
      body.appendChild(body.ownerDocument.importNode(paragraph, true))
    })
  }
  if (differs(object, previous, 'textStyle')) patchTextStyle(body, object, previous)
  patchTextLayout(body, object, previous)
}

function patchLine(properties: Element, object: SlideObject, previous: Partial<SlideObject> | undefined) {
  const existing = child(properties, 'ln')
  if (!existing) { replace(properties, 'ln', line(object)); return }
  if (differs(object, previous, 'lineWidth')) existing.setAttribute('w', String(Math.max(0, emu(object.lineWidth))))
  if (differs(object, previous, 'lineColor')) {
    for (const fill of children(existing)) if (['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(fill.localName)) fill.remove()
    existing.insertBefore(existing.ownerDocument.importNode(node(solid(object.lineColor)), true), existing.firstChild)
  }
}

class PackageWriter {
  readonly parts: Map<string, Uint8Array>
  readonly types: Document
  readonly animationTargets = new Map<string, Set<string>>()
  constructor(readonly source?: Map<string, Uint8Array>) {
    // Source byte arrays are immutable: every write creates a fresh array.
    this.parts = new Map(source)
    this.types = source?.has('[Content_Types].xml') ? readXml(source.get('[Content_Types].xml')!) : readXml(`<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`)
  }
  unique(stem: string, extension = 'xml') {
    for (let i = 1; i <= PPTX_LIMITS.entries; i++) { const part = `${stem}${i}.${extension}`; if (!this.parts.has(part)) return part }
    throw new PptxPackageError('ZIP_LIMIT', 'PPTX 文件数量超过安全限制。')
  }
  put(part: string, content: string | Uint8Array, mime?: string) {
    this.parts.set(part, typeof content === 'string' ? xmlBytes(content) : content)
    if (mime) {
      let entry = children(this.types.documentElement, 'Override').find(item => item.getAttribute('PartName') === `/${part}`)
      if (!entry) { entry = this.types.createElementNS(CT, 'Override'); this.types.documentElement.appendChild(entry) }
      entry.setAttribute('PartName', `/${part}`); entry.setAttribute('ContentType', mime)
    }
  }
  rels(part: string, sourcePart?: string) {
    const origin = sourcePart || part, source = sourcePart ? this.source?.get(relPart(origin)) || this.parts.get(relPart(origin)) : this.parts.get(relPart(origin))
    const doc = source ? readXml(source) : readXml(`<Relationships xmlns="${PR}"/>`)
    if (origin !== part) for (const relationship of children(doc.documentElement)) {
      if (relationship.getAttribute('TargetMode') !== 'External') relationship.setAttribute('Target', relativePart(part, resolvePart(origin, relationship.getAttribute('Target') || '')))
    }
    return doc
  }
  relation(doc: Document, from: string, target: string, kind: string) {
    let n = 1
    while (children(doc.documentElement).some(item => item.getAttribute('Id') === `rIdCanvas${n}`)) n++
    const id = `rIdCanvas${n}`, entry = doc.createElementNS(PR, 'Relationship')
    entry.setAttribute('Id', id); entry.setAttribute('Type', kind.includes('://') ? kind : `${R}/${kind}`); entry.setAttribute('Target', relativePart(from, target)); doc.documentElement.appendChild(entry)
    return id
  }
  saveRels(part: string, document: Document) { this.put(relPart(part), writeXml(document)) }
}

function themeXml() {
  const colors = { dk1: '000000', lt1: 'FFFFFF', dk2: '243247', lt2: 'F5F7FA', accent1: '3875CB', accent2: 'EA9361', accent3: '6AA58B', accent4: '9475B8', accent5: '54A7B6', accent6: 'D2B35D', hlink: '0563C1', folHlink: '954F72' }
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const font = '<a:latin typeface="Arial"/><a:ea typeface="Noto Sans CJK SC"/><a:cs typeface="Arial"/>'
  return `<a:theme xmlns:a="${A}" name="Open Office"><a:themeElements><a:clrScheme name="Open Office">${Object.entries(colors).map(([key, value]) => `<a:${key}><a:srgbClr val="${value}"/></a:${key}>`).join('')}</a:clrScheme><a:fontScheme name="Open Office"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="Open Office"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525, 25400, 38100].map(width => `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
}

function createMaster(writer: PackageWriter, presentation: Document, presentationRels: Document, presentationPart: string) {
  const master = writer.unique('ppt/slideMasters/canvasMaster'), theme = writer.unique('ppt/theme/canvasTheme')
  writer.put(theme, themeXml(), 'application/vnd.openxmlformats-officedocument.theme+xml')
  const masterRels = writer.rels(master), layouts = new Map<number, string>(), layoutIds: string[] = []
  for (const [value, type] of [[0, 'title'], [1, 'obj'], [3, 'twoObj'], [19, 'titleOnly'], [20, 'blank'], [32, 'secHead']] as const) {
    const layout = writer.unique('ppt/slideLayouts/canvasLayout'); layouts.set(value, layout)
    writer.put(layout, `<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${type}"><p:spTree>${GROUP_ROOT}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`, `${MIME}slideLayout+xml`)
    const layoutRels = writer.rels(layout); writer.relation(layoutRels, layout, master, 'slideMaster'); writer.saveRels(layout, layoutRels)
    layoutIds.push(`<p:sldLayoutId id="${2147483649 + layoutIds.length}" r:id="${writer.relation(masterRels, master, layout, 'slideLayout')}"/>`)
  }
  writer.relation(masterRels, master, theme, 'theme'); writer.saveRels(master, masterRels)
  writer.put(master, `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr>${solid('#FFFFFF')}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP_ROOT}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst>${layoutIds.join('')}</p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`, `${MIME}slideMaster+xml`)
  let masters = child(presentation.documentElement, 'sldMasterIdLst')
  if (!masters) { masters = presentation.createElementNS(P, 'p:sldMasterIdLst'); presentation.documentElement.insertBefore(masters, presentation.documentElement.firstChild) }
  let masterId = 2147483648
  while (children(masters).some(item => item.getAttribute('id') === String(masterId))) masterId++
  append(masters, `<p:sldMasterId id="${masterId}" r:id="${writer.relation(presentationRels, presentationPart, master, 'slideMaster')}"/>`)
  return { layouts, theme }
}

/** Changing the editor's layout must not silently replace an imported theme.
 * Keep its resolved placeholders, background and inherited artwork. */
function copyImportedLayout(writer: PackageWriter, slidePart: string, relationship: Element, layoutValue: number): string | undefined {
  if (relationship.getAttribute('TargetMode') === 'External') return
  const sourcePart = resolvePart(slidePart, relationship.getAttribute('Target') || ''), bytes = writer.parts.get(sourcePart)
  if (!bytes) return
  const doc = readXml(bytes), part = writer.unique('ppt/slideLayouts/canvasImportedLayout')
  doc.documentElement.setAttribute('type', ({ 0: 'title', 1: 'obj', 3: 'twoObj', 19: 'titleOnly', 20: 'blank', 32: 'secHead' } as Record<number, string>)[layoutValue] || 'blank')
  writer.put(part, writeXml(doc), `${MIME}slideLayout+xml`)
  const rels = writer.rels(part, sourcePart), masterRelation = children(rels.documentElement).find(item => (item.getAttribute('Type') || '').endsWith('/slideMaster') && item.getAttribute('TargetMode') !== 'External')
  writer.saveRels(part, rels)
  if (masterRelation) {
    const masterPart = resolvePart(part, masterRelation.getAttribute('Target') || ''), masterBytes = writer.parts.get(masterPart)
    if (masterBytes) {
      const master = readXml(masterBytes), masterRels = writer.rels(masterPart)
      let list = child(master.documentElement, 'sldLayoutIdLst')
      if (!list) { list = master.createElementNS(P, 'p:sldLayoutIdLst'); master.documentElement.insertBefore(list, children(master.documentElement).find(item => ['transition', 'timing', 'hf', 'txStyles', 'extLst'].includes(item.localName)) || null) }
      const layoutId = Math.max(2147483648, ...children(list).map(item => Number(item.getAttribute('id')) || 2147483648)) + 1
      append(list, `<p:sldLayoutId id="${layoutId}" r:id="${writer.relation(masterRels, masterPart, part, 'slideLayout')}"/>`)
      writer.put(masterPart, writeXml(master), `${MIME}slideMaster+xml`); writer.saveRels(masterPart, masterRels)
    }
  }
  return part
}

function column(index: number) { let result = ''; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result }
function chartXml(object: SlideObject, workbookRelationship: string) {
  const chart = object.chart!, palette = ['3875CB', 'EA9361', '6AA58B', '9475B8', '54A7B6', 'D2B35D']
  const cache = (values: (number | string)[], numeric = false) => `<c:${numeric ? 'numCache' : 'strCache'}>${numeric ? '<c:formatCode>General</c:formatCode>' : ''}<c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${esc(value)}</c:v></c:pt>`).join('')}</c:${numeric ? 'numCache' : 'strCache'}>`
  const series = chart.series.map((label, index) => {
    const col = column(index + 2), fill = solid(`#${palette[index % palette.length]}`), stroke = `<a:ln w="28575">${fill}</a:ln>`
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>Sheet1!$${col}$1</c:f>${cache([label])}</c:strRef></c:tx><c:spPr>${chart.type === 'line' ? stroke : fill}</c:spPr>${chart.type === 'line' ? '<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>' : ''}<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${chart.categories.length + 1}</c:f>${cache(chart.categories)}</c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$${col}$2:$${col}$${chart.categories.length + 1}</c:f>${cache(chart.values.map(row => row[index]!), true)}</c:numRef></c:val>${chart.type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`
  }).join('')
  const type = chart.type === 'column' || chart.type === 'bar' ? 'barChart' : chart.type === 'line' ? 'lineChart' : 'pieChart'
  const settings = type === 'barChart' ? `<c:barDir val="${chart.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/>` : type === 'lineChart' ? '<c:grouping val="standard"/>' : ''
  const axes = type === 'pieChart' ? '' : `<c:catAx><c:axId val="100001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type === 'bar' ? 'l' : 'b'}"/><c:tickLblPos val="nextTo"/><c:crossAx val="100002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="100002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type === 'bar' ? 'b' : 'l'}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="100001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  const title = chart.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>${textParagraphs(chart.title, object)}</c:rich></c:tx><c:overlay val="0"/></c:title>` : '<c:autoTitleDeleted val="1"/>'
  return `<c:chartSpace ${NS}><c:lang val="zh-CN"/><c:chart>${title}<c:plotArea><c:layout/><c:${type}>${settings}<c:varyColors val="${type === 'pieChart' ? 1 : 0}"/>${series}${type === 'barChart' ? '<c:gapWidth val="150"/>' : ''}${type === 'pieChart' ? '<c:firstSliceAng val="0"/>' : '<c:axId val="100001"/><c:axId val="100002"/>'}</c:${type}>${axes}</c:plotArea><c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:externalData r:id="${workbookRelationship}"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`
}

type ShapeIdMap = Map<string, { id: string; native: boolean; ambiguous: boolean }>
interface ShapeContext {
  writer: PackageWriter; part: string; rels: Document; usedIds: Set<number>; nativeIds: Set<number>; nextId: number
  groupMappings: ShapeIdMap[]
  connectionSources: WeakMap<Element, string>
}
function putShapeMapping(map: ShapeIdMap, key: string, id: string, native: boolean) {
  const previous = map.get(key)
  if (!previous || native && !previous.native) map.set(key, { id, native, ambiguous: false })
  else if (previous.id !== id && previous.native === native) previous.ambiguous = true
}
function rememberShapeId(context: ShapeContext, part: string | undefined, oldId: string, id: string, native: boolean) {
  if (part && oldId) for (const map of context.groupMappings) putShapeMapping(map, `${part}#${oldId}`, id, native)
}
function remapConnections(shape: Element, map: ShapeIdMap, context: ShapeContext) {
  for (const endpoint of [...all(shape, 'stCxn'), ...all(shape, 'endCxn')]) {
    const key = context.connectionSources.get(endpoint), target = key && map.get(key)
    if (!target) continue
    if (target.ambiguous) throw new PptxPackageError('CONNECTOR_COPY_AMBIGUOUS', '分组中的连接线有多个同源副本目标，无法确定正确连接。请撤销本次分组或复制后再保存；原文件未修改。')
    endpoint.setAttribute('id', target.id)
    // The nearest enclosing group owns this connection. An outer group may
    // contain another occurrence of the same source shape ID.
    context.connectionSources.delete(endpoint)
  }
}
function alternativeBranches(a: Element, b: Element): boolean {
  const branches = new Map<Element, Element>()
  for (let branch: Element | null = a; branch?.parentElement; branch = branch.parentElement) if (branch.parentElement.localName === 'AlternateContent') branches.set(branch.parentElement, branch)
  for (let branch: Element | null = b; branch?.parentElement; branch = branch.parentElement) {
    const other = branches.get(branch.parentElement)
    if (other && other !== branch) return true
  }
  return false
}
function shapeId(context: ShapeContext, source?: Element, native = false) {
  const old = Number(all(source, 'cNvPr')[0]?.getAttribute('id'))
  if (native && Number.isSafeInteger(old) && old > 1 && !context.usedIds.has(old)) { context.usedIds.add(old); return old }
  while (context.usedIds.has(context.nextId) || context.nativeIds.has(context.nextId)) context.nextId++
  const id = context.nextId++; context.usedIds.add(id); return id
}
function preserveShapeIds(source: Element, id: number, context: ShapeContext, native: boolean, sourcePart?: string) {
  const ids = all(source, 'cNvPr'), remapping = new Map<string, string>(), mappings: ShapeIdMap = new Map(), assigned = new Map<string, Array<{ node: Element; id: string }>>()
  for (let index = 0; index < ids.length; index++) {
    const element = ids[index]!, oldId = element.getAttribute('id') || ''
    const alternative = assigned.get(oldId)?.find(previous => alternativeBranches(previous.node, element))
    const newId = alternative?.id || String(index === 0 ? id : shapeId(context, element.parentElement || undefined, native))
    assigned.set(oldId, [...(assigned.get(oldId) || []), { node: element, id: newId }])
    element.setAttribute('id', newId); if (oldId !== newId) remapping.set(oldId, newId)
    rememberShapeId(context, sourcePart, oldId, newId, native)
    if (sourcePart) putShapeMapping(mappings, `${sourcePart}#${oldId}`, newId, native)
  }
  for (const element of all(source, '*')) for (const attribute of Array.from(element.attributes)) {
    if (attribute.localName === 'spid') {
      const replacement = remapping.get(attribute.value); if (replacement) element.setAttributeNS(attribute.namespaceURI, attribute.name, replacement)
    }
  }
  remapConnections(source, mappings, context)
}
function importRelationships(element: Element, object: SlideObject, context: ShapeContext) {
  if (!object.sourcePart || object.sourcePart === context.part) return
  const sourceRels = context.writer.rels(object.sourcePart, object.sourcePart), mapping = new Map<string, string>()
  for (const current of [element, ...all(element, '*')]) for (const attribute of Array.from(current.attributes)) {
    if (attribute.namespaceURI !== R || !attribute.value) continue
    const oldId = attribute.value
    let newId = mapping.get(oldId)
    if (!newId) {
      const rel = children(sourceRels.documentElement).find(item => item.getAttribute('Id') === oldId)
      if (!rel) continue
      const target = rel.getAttribute('Target') || '', external = rel.getAttribute('TargetMode') === 'External'
      const equivalent = children(context.rels.documentElement).find(item => item.getAttribute('Type') === rel.getAttribute('Type') && (item.getAttribute('TargetMode') === 'External') === external && (external ? item.getAttribute('Target') === target : resolvePart(context.part, item.getAttribute('Target') || '') === resolvePart(object.sourcePart!, target)))
      if (equivalent) newId = equivalent.getAttribute('Id')!
      else if (external) {
        newId = context.writer.relation(context.rels, context.part, context.part, rel.getAttribute('Type')!)
        const entry = children(context.rels.documentElement).find(item => item.getAttribute('Id') === newId)!
        entry.setAttribute('Target', target); entry.setAttribute('TargetMode', 'External')
      } else newId = context.writer.relation(context.rels, context.part, resolvePart(object.sourcePart, target), rel.getAttribute('Type')!)
      mapping.set(oldId, newId)
    }
    current.setAttributeNS(R, attribute.name, newId)
  }
}

function imageXml(object: SlideObject, id: number, context: ShapeContext) {
  if (!object.image) throw new PptxPackageError('IMAGE_MISSING', '图片对象缺少图像内容。')
  let part = object.image.partName
  const original = baseline(object)?.image
  if (!part || !context.writer.parts.has(part) || original && original.dataUrl !== object.image.dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(object.image.dataUrl)
    if (!match) throw new PptxPackageError('IMAGE_DATA', '图片内容不是可导出的本地图像。')
    const mime = object.image.mimeType || match[1] || 'image/png', extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tiff' }
    const bytes = match[2] ? Uint8Array.from(atob(match[3]!), c => c.charCodeAt(0)) : xmlBytes(decodeURIComponent(match[3]!))
    part = context.writer.unique('ppt/media/canvasImage', extensions[mime] || 'bin'); context.writer.put(part, bytes, mime)
  }
  const relation = context.writer.relation(context.rels, context.part, part, 'image')
  return `<p:pic>${nonVisual(object, id, 'pic')}<p:blipFill><a:blip r:embed="${relation}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(object)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${line(object)}</p:spPr></p:pic>`
}
function tableXml(object: SlideObject, id: number) {
  const cells = object.table?.cells || [['']], count = Math.max(1, ...cells.map(row => row.length)), width = Math.max(1, emu(object.width / count)), height = Math.max(1, emu(object.height / Math.max(1, cells.length)))
  const body = cells.map(row => `<a:tr h="${height}">${Array.from({ length: count }, (_, i) => `<a:tc>${textBody(object, 'a', row[i] || '')}<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720">${solid(object.fillColor)}</a:tcPr></a:tc>`).join('')}</a:tr>`).join('')
  return `<p:graphicFrame>${nonVisual(object, id, 'graphicFrame')}${transform(object, true)}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0"/><a:tblGrid>${`<a:gridCol w="${width}"/>`.repeat(count)}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}
function newChart(object: SlideObject, id: number, context: ShapeContext) {
  if (!object.chart) throw new PptxPackageError('CHART_DATA', '图表对象缺少数据。')
  const workbook = buildChartWorkbook(object.chart), workbookPart = context.writer.unique('ppt/embeddings/canvasChartData', 'xlsx')
  context.writer.put(workbookPart, workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const part = context.writer.unique('ppt/charts/canvasChart'), rels = context.writer.rels(part), relation = context.writer.relation(rels, part, workbookPart, 'package')
  context.writer.put(part, chartXml(object, relation), 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'); context.writer.saveRels(part, rels)
  const chartRelationship = context.writer.relation(context.rels, context.part, part, 'chart')
  return `<p:graphicFrame>${nonVisual(object, id, 'graphicFrame')}${transform(object, true)}<a:graphic><a:graphicData uri="${C}"><c:chart r:id="${chartRelationship}"/></a:graphicData></a:graphic></p:graphicFrame>`
}

function patchTable(source: Element, object: SlideObject, previous: Partial<SlideObject> | undefined) {
  const table = all(source, 'tbl')[0], rows = children(table, 'tr'), cells = object.table?.cells
  if (!cells || rows.length !== cells.length || rows.some((row, i) => children(row, 'tc').length !== cells[i]!.length)) return false
  replace(source, 'xfrm', transform(object, true))
  const fillChanged = differs(object, previous, 'fillColor')
  rows.forEach((row, r) => children(row, 'tc').forEach((cell, c) => {
    const value = cells[r]![c]!, body = child(cell, 'txBody')
    if (body) patchText(body, object, previous, value)
    else cell.insertBefore(cell.ownerDocument.importNode(node(textBody(object, 'a', value)), true), cell.firstChild)
    if (fillChanged) {
      const properties = child(cell, 'tcPr') || append(cell, '<a:tcPr/>')
      for (const existing of children(properties)) if (['solidFill', 'noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(existing.localName)) existing.remove()
      properties.insertBefore(properties.ownerDocument.importNode(node(solid(object.fillColor)), true), child(properties, 'extLst') || null)
    }
  }))
  return true
}

function timingShapeIds(doc: Document): Set<string> {
  const result = new Set<string>()
  for (const timing of all(doc, 'timing')) for (const element of [timing, ...all(timing, '*')]) for (const attribute of Array.from(element.attributes)) if (/^(spid|shapeid)$/i.test(attribute.localName)) result.add(attribute.value)
  return result
}
function sourceAnimationTargets(writer: PackageWriter, part: string): Set<string> {
  let targets = writer.animationTargets.get(part)
  if (!targets) {
    const bytes = writer.source?.get(part) || writer.parts.get(part)
    targets = bytes ? timingShapeIds(readXml(bytes)) : new Set<string>(); writer.animationTargets.set(part, targets)
  }
  return targets
}
function checkShapeReferences(doc: Document, sourceIds: Set<string>) {
  const ids = new Set(all(doc, 'cNvPr').map(element => element.getAttribute('id')))
  for (const target of timingShapeIds(doc)) if (sourceIds.has(target) && !ids.has(target)) throw new PptxPackageError('ANIMATION_TARGET_REMOVED', '删除的对象仍被原始动画、触发器或媒体时间轴引用，无法完整保留这些设置。请撤销此删除，或在原编辑器处理对应动画后再保存；原文件未修改。')
  for (const endpoint of [...all(doc, 'stCxn'), ...all(doc, 'endCxn')]) if (sourceIds.has(endpoint.getAttribute('id') || '') && !ids.has(endpoint.getAttribute('id'))) endpoint.remove()
}
function checkSiblingConnectorCopies(objects: SlideObject[]) {
  const copies = objects.filter(object => object.sourceCopy && object.sourceXml && object.sourcePart).map(object => ({ object, source: readXml(object.sourceXml!).documentElement }))
  const endpoints = new Set(copies.flatMap(({ object, source }) => all(source, 'cNvPr').map(element => `${object.sourcePart}#${element.getAttribute('id') || ''}`)))
  for (const { object, source } of copies) if (object.type !== 'group') {
    if ([...all(source, 'stCxn'), ...all(source, 'endCxn')].some(endpoint => endpoints.has(`${object.sourcePart}#${endpoint.getAttribute('id') || ''}`))) {
      throw new PptxPackageError('CONNECTOR_COPY_AMBIGUOUS', '复制连接线和端点需要先组合，才能确定副本之间的连接。请撤销本次复制，将这些对象组合后再复制；原文件未修改。')
    }
  }
}

function groupHasOnlyAffineChange(object: SlideObject, previous: Partial<SlideObject> | undefined): boolean {
  if (!previous || !previous.children || !object.children || !previous.width || !previous.height || previous.x === undefined || previous.y === undefined) return false
  const sx = object.width / previous.width, sy = object.height / previous.height
  const ignored = new Set(['id', 'x', 'y', 'width', 'height', 'rotation', 'children', 'sourceXml', 'sourceFingerprint', 'sourcePart', 'sourceCopy', 'hasAnimation', 'hasComplexGroupTransform', 'warning', 'locked'])
  const content = (value: Partial<SlideObject>, root = false) => JSON.stringify(value, (key, field) => ignored.has(key) || root && ['name', 'zIndex'].includes(key) ? undefined : field)
  if (content(object, true) !== content(previous, true)) return false
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
  const same = (current: SlideObject[], old: SlideObject[]): boolean => current.length === old.length && current.every((item, index) => {
    const before = old[index]!
    return content(item) === content(before) && near(item.x, object.x + (before.x - previous.x!) * sx) && near(item.y, object.y + (before.y - previous.y!) * sy)
      && near(item.width, before.width * sx) && near(item.height, before.height * sy) && near(item.rotation, before.rotation)
      && same(item.children || [], before.children || [])
  })
  return same(object.children, previous.children)
}

function groupHasOnlyContentChange(object: SlideObject, previous: Partial<SlideObject> | undefined): boolean {
  if (!previous) return false
  const geometry = ['x', 'y', 'width', 'height', 'rotation'] as const
  const same = (current: SlideObject, before: Partial<SlideObject>): boolean => {
    if (geometry.some(key => current[key] !== before[key])) return false
    const a = current.children || [], b = before.children || []
    return a.length === b.length && a.every((item, index) => {
      const original = b[index]!, sourceId = item.sourceXml && all(readXml(item.sourceXml), 'cNvPr')[0]?.getAttribute('id')
      return !!sourceId && `${item.sourcePart}#${sourceId}` === original.id && item.zIndex === original.zIndex && same(item, original)
    })
  }
  return same(object, previous)
}
function shapeTransform(shape: Element) { return child(shape, 'xfrm') || child(child(shape, shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr'), 'xfrm') }
function restoreTransform(shape: Element, original: Element) {
  const before = shapeTransform(original), current = shapeTransform(shape)
  if (!before) { current?.remove(); return }
  const replacement = shape.ownerDocument.importNode(before, true)
  if (current) current.parentNode!.replaceChild(replacement, current)
  else if (shape.localName === 'graphicFrame') shape.insertBefore(replacement, child(shape, 'nvGraphicFramePr')?.nextSibling || shape.firstChild)
  else {
    const local = shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr', properties = child(shape, local) || append(shape, `<p:${local}/>`)
    properties.insertBefore(replacement, properties.firstChild)
  }
}

function exportShape(object: SlideObject, context: ShapeContext, forceGeometry = false): Element {
  const source = object.sourceXml ? readXml(object.sourceXml).documentElement : undefined, previous = baseline(object)
  const sourceId = source && all(source, 'cNvPr')[0]?.getAttribute('id') || ''
  const native = !!source && (object.sourceCopy === false || object.sourceCopy === undefined && object.id === `${object.sourcePart}#${sourceId}`)
  const originalTransform = source && shapeTransform(source), originalOff = child(originalTransform, 'off'), originalExt = child(originalTransform, 'ext')
  const retainGroupSpace = !forceGeometry || !!previous && [
    [Number(originalOff?.getAttribute('x')), emu(previous.x || 0)], [Number(originalOff?.getAttribute('y')), emu(previous.y || 0)],
    [Number(originalExt?.getAttribute('cx')), emu(previous.width || 0)], [Number(originalExt?.getAttribute('cy')), emu(previous.height || 0)],
  ].every(([raw, absolute]) => Number.isFinite(raw) && Math.abs(raw! - absolute!) <= 1)
  if (source && object.sourceCopy && object.sourcePart) {
    const targets = sourceAnimationTargets(context.writer, object.sourcePart)
    if (all(source, 'cNvPr').some(element => targets.has(element.getAttribute('id') || ''))) throw new PptxPackageError('ANIMATION_OBJECT_COPY', '此对象关联原始动画、触发器或媒体时间轴，暂不能单独复制。请撤销对象复制，或复制整页以完整保留这些设置；原文件未修改。')
  }
  const id = shapeId(context, source, native)
  if (source) {
    rememberShapeId(context, object.sourcePart, sourceId, String(id), native)
    if (object.sourcePart) for (const endpoint of [...all(source, 'stCxn'), ...all(source, 'endCxn')]) context.connectionSources.set(endpoint, `${object.sourcePart}#${endpoint.getAttribute('id') || ''}`)
  }
  if (source) importRelationships(source, object, context)
  const unchanged = source && object.sourceFingerprint === objectFingerprint(object)
  if (source && (object.locked || unchanged && !forceGeometry)) {
    preserveShapeIds(source, id, context, native, object.sourcePart)
    if (object.locked) all(source, 'cNvPr')[0]?.setAttribute('name', object.name)
    return source
  }
  if (source?.localName === 'grpSp' && retainGroupSpace && groupHasOnlyAffineChange(object, previous)) {
    const xfrm = child(child(source, 'grpSpPr'), 'xfrm'), off = child(xfrm, 'off'), ext = child(xfrm, 'ext')
    if (xfrm && off && ext) {
      // A group transform applies scale after its children's rotations. Keep
      // that composition and the original child coordinate system intact.
      off.setAttribute('x', String(emu(object.x))); off.setAttribute('y', String(emu(object.y)))
      ext.setAttribute('cx', String(Math.max(1, emu(object.width)))); ext.setAttribute('cy', String(Math.max(1, emu(object.height))))
      if (object.rotation) xfrm.setAttribute('rot', String(Math.round(object.rotation * 60000))); else xfrm.removeAttribute('rot')
      preserveShapeIds(source, id, context, native, object.sourcePart); all(source, 'cNvPr')[0]?.setAttribute('name', object.name)
      return source
    }
  }
  const metadata = source && all(source, 'cNvPr')[0]
  if (metadata) { metadata.setAttribute('id', String(id)); metadata.setAttribute('name', object.name) }
  if (source?.localName === 'grpSp' && retainGroupSpace && groupHasOnlyContentChange(object, previous)) {
    const originals = children(source).filter(element => !GROUP_TYPES.has(element.localName)), mappings: ShapeIdMap = new Map()
    if (originals.length === object.children?.length) {
      if (object.sourcePart) putShapeMapping(mappings, `${object.sourcePart}#${sourceId}`, String(id), native)
      context.groupMappings.push(mappings)
      for (let index = 0; index < originals.length; index++) {
        const original = originals[index]!, result = exportShape(object.children[index]!, context)
        // Absolute editor coordinates are a flattened view of these children.
        // Content edits retain their exact original local transforms, including
        // nonuniform scale composed with rotations in nested groups.
        restoreTransform(result, original); source.replaceChild(result, original)
      }
      context.groupMappings.pop(); remapConnections(source, mappings, context)
      return source
    }
  }
  if (source?.localName === 'grpSp' && (object.hasComplexGroupTransform || previous?.hasComplexGroupTransform)) throw new PptxPackageError('GROUP_TRANSFORM_UNSUPPORTED', '此组合包含非等比缩放和旋转，当前修改会改变原有变形。可整体移动、缩放或调整内容；请撤销内部几何或组合结构修改后再保存，或在原编辑器处理；原文件未修改。')
  if (object.type === 'group') {
    const group = source?.localName === 'grpSp' ? source : node(`<p:grpSp>${nonVisual(object, id, 'grpSp')}<p:grpSpPr/></p:grpSp>`)
    const mappings: ShapeIdMap = new Map()
    if (source && object.sourcePart) putShapeMapping(mappings, `${object.sourcePart}#${sourceId}`, String(id), native)
    context.groupMappings.push(mappings)
    let properties = child(group, 'grpSpPr'); if (!properties) properties = append(group, '<p:grpSpPr/>')
    replace(properties, 'xfrm', transform(object, false, true))
    for (const existing of children(group)) if (!GROUP_TYPES.has(existing.localName)) existing.remove()
    for (const item of [...(object.children || [])].sort((a, b) => a.zIndex - b.zIndex)) group.insertBefore(exportShape(item, context, true), child(group, 'extLst') || null)
    context.groupMappings.pop(); remapConnections(group, mappings, context)
    return group
  }
  if (source && object.type !== 'table' && object.type !== 'chart' && object.type !== 'image') {
    let properties = child(source, 'spPr')
    if (!properties) properties = append(source, '<p:spPr/>')
    if (forceGeometry || ['x', 'y', 'width', 'height', 'rotation'].some(key => differs(object, previous, key as keyof SlideObject))) replace(properties, 'xfrm', transform(object))
    if (differs(object, previous, 'fillColor') || differs(object, previous, 'opacity')) {
      for (const existing of children(properties)) if (['solidFill', 'noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(existing.localName)) existing.remove()
      const value = properties.ownerDocument.importNode(node(solid(object.fillColor, object.opacity)), true)
      properties.insertBefore(value, children(properties).find(item => ['ln', 'effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst'].includes(item.localName)) || null)
    }
    if (differs(object, previous, 'lineColor') || differs(object, previous, 'lineWidth')) patchLine(properties, object, previous)
    if (object.capabilities.text && (differs(object, previous, 'text') || differs(object, previous, 'textStyle') || differs(object, previous, 'textLayout'))) {
      const body = child(source, 'txBody')
      if (body) patchText(body, object, previous)
      else replace(source, 'txBody', textBody(object))
    }
    return source
  }
  if (source && ((object.type === 'chart' && !differs(object, previous, 'chart')) || (object.type === 'table' && !differs(object, previous, 'table') && !differs(object, previous, 'textStyle') && !differs(object, previous, 'fillColor')) || (object.type === 'image' && !differs(object, previous, 'image')))) {
    const frame = source.localName === 'graphicFrame'
    if (frame) replace(source, 'xfrm', transform(object, true))
    else { const properties = child(source, 'spPr') || append(source, '<p:spPr/>'); replace(properties, 'xfrm', transform(object)); if (differs(object, previous, 'lineColor') || differs(object, previous, 'lineWidth')) patchLine(properties, object, previous) }
    return source
  }
  if (object.type === 'image') return node(imageXml(object, id, context))
  if (source && object.type === 'table' && patchTable(source, object, previous)) return source
  if (object.type === 'table') return node(tableXml(object, id))
  if (object.type === 'chart') return node(newChart(object, id, context))
  const preset = object.type === 'ellipse' ? 'ellipse' : object.type === 'line' ? 'line' : 'rect'
  return node(`<p:sp>${nonVisual(object, id, 'sp')}<p:spPr>${transform(object)}<a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>${solid(object.fillColor, object.opacity)}${line(object)}</p:spPr>${object.type === 'text' || object.text ? textBody(object) : ''}</p:sp>`)
}

function writeNotes(writer: PackageWriter, slide: SlideModel, slidePart: string, rels: Document) {
  const original = children(rels.documentElement).find(item => (item.getAttribute('Type') || '').endsWith('/notesSlide'))
  const sourcePart = original ? resolvePart(slidePart, original.getAttribute('Target')!) : undefined
  if (!sourcePart && !slide.notes) return
  const part = sourcePart && slidePart === slide.sourcePart ? sourcePart : writer.unique('ppt/notesSlides/canvasNotes')
  const source = sourcePart && (writer.source?.get(sourcePart) || writer.parts.get(sourcePart))
  const doc = source ? readXml(source) : readXml(`<p:notes ${NS}><p:cSld><p:spTree>${GROUP_ROOT}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`)
  let originalNotes: string | undefined
  try { originalNotes = slide.sourceFingerprint ? JSON.parse(slide.sourceFingerprint).notes : undefined } catch { /* No import baseline. */ }
  if (!source || originalNotes !== slide.notes) {
    const tree = all(doc, 'spTree')[0]!, bodies = all(tree, 'sp').filter(shape => !['sldImg', 'sldNum', 'dt', 'ftr', 'hdr'].includes(all(shape, 'ph')[0]?.getAttribute('type') || ''))
    let body = bodies.find(shape => all(shape, 'ph')[0]?.getAttribute('type') === 'body') || bodies[0]
    if (!body) { const id = Math.max(1, ...all(doc, 'cNvPr').map(node => Number(node.getAttribute('id')) || 1)) + 1; body = append(tree, `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`) }
    if (plainText(child(body, 'txBody')) !== slide.notes) {
      replace(body, 'txBody', `<p:txBody><a:bodyPr/><a:lstStyle/>${slide.notes.split('\n').map(text => `<a:p><a:r><a:t xml:space="preserve">${esc(text)}</a:t></a:r></a:p>`).join('')}</p:txBody>`)
    }
    // Import concatenates all ordinary notes text shapes. A notes edit replaces
    // that complete text, while preserving every shape's geometry/extensions.
    for (const other of bodies) if (other !== body && child(other, 'txBody')) replace(other, 'txBody', '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>')
  }
  writer.put(part, writeXml(doc), `${MIME}notesSlide+xml`)
  const notesRels = writer.rels(part, sourcePart || part)
  for (const relation of children(notesRels.documentElement)) if ((relation.getAttribute('Type') || '').endsWith('/slide')) relation.remove()
  writer.relation(notesRels, part, slidePart, 'slide'); writer.saveRels(part, notesRels)
  original?.remove(); writer.relation(rels, slidePart, part, 'notesSlide')
}

/** Export directly from the editor model. Original package parts are never mutated. */
export async function exportPresentation(model: PresentationModel): Promise<Uint8Array> {
  if (!model.slides.length || model.slides.length > PPTX_LIMITS.slides) throw new PptxPackageError('SLIDE_LIMIT', '演示文稿页数超出允许范围。')
  if (![model.width, model.height].every(value => Number.isFinite(value) && value > 0 && emu(value) < 1e9)) throw new PptxPackageError('SLIDE_SIZE', '幻灯片尺寸无效。')
  if ([...(model.sourceParts?.keys() || [])].some(part => /^_xmlsignatures\//i.test(part))) throw new PptxPackageError('SIGNED_PACKAGE', '含数字签名的演示文稿不能修改，请先另存未签名副本。')
  if ([...(model.sourceParts?.keys() || [])].some(part => /(?:vbaProject|vbaData)\.(?:bin|xml)$/i.test(part)) || /macroEnabled|vbaProject/i.test(new TextDecoder().decode(model.sourceParts?.get('[Content_Types].xml')))) throw new PptxPackageError('MACRO_PACKAGE', '含宏的演示文稿不能作为普通 PPTX 导出。')
  const writer = new PackageWriter(model.sourceParts), presentationPart = model.sourcePresentationPart || 'ppt/presentation.xml'
  const source = writer.parts.get(presentationPart), presentation = source ? readXml(source) : readXml(`<p:presentation ${NS}><p:sldIdLst/><p:sldSz cx="${emu(model.width)}" cy="${emu(model.height)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`)
  if (presentation.documentElement.namespaceURI !== P) throw new PptxPackageError('STRICT_OOXML', '严格 OOXML 演示文稿目前仅支持预览；请在原编辑器另存为标准 PPTX 后编辑。')
  const presentationRels = writer.rels(presentationPart), existingIds = child(presentation.documentElement, 'sldIdLst'), existingSlides = new Map<string, { id: string; rel: string }>()
  for (const entry of children(existingIds)) {
    const relId = entry.getAttributeNS(R, 'id') || '', relation = children(presentationRels.documentElement).find(item => item.getAttribute('Id') === relId)
    if (relation) existingSlides.set(resolvePart(presentationPart, relation.getAttribute('Target')!), { id: entry.getAttribute('id') || '', rel: relId })
  }
  let slideList = existingIds
  if (!slideList) { slideList = presentation.createElementNS(P, 'p:sldIdLst'); presentation.documentElement.insertBefore(slideList, children(presentation.documentElement).find(item => ['sldSz', 'notesSz', 'smartTags', 'embeddedFontLst', 'custShowLst', 'photoAlbum', 'custDataLst', 'kinsoku', 'defaultTextStyle', 'modifyVerifier', 'extLst'].includes(item.localName)) || null) }
  for (const entry of children(slideList)) entry.remove()
  const size = child(presentation.documentElement, 'sldSz') || append(presentation.documentElement, '<p:sldSz/>'); size.setAttribute('cx', String(emu(model.width))); size.setAttribute('cy', String(emu(model.height))); size.removeAttribute('type')
  let fallback: ReturnType<typeof createMaster> | undefined
  const usedParts = new Set<string>(), keptRelations = new Set<string>(), patches: PptxPatch['slides'] = []
  let slideId = Math.max(255, ...[...existingSlides.values()].map(item => Number(item.id) || 255)) + 1
  for (let index = 0; index < model.slides.length; index++) {
    const slide = model.slides[index]!, sourcePart = slide.sourcePart && writer.parts.has(slide.sourcePart) ? slide.sourcePart : undefined
    const part = sourcePart && slide.id === existingSlides.get(sourcePart)?.id && !usedParts.has(sourcePart) ? sourcePart : writer.unique('ppt/slides/canvasSlide')
    usedParts.add(part)
    const doc = sourcePart ? readXml((writer.source?.get(sourcePart) || writer.parts.get(sourcePart))!) : readXml(`<p:sld ${NS}><p:cSld><p:spTree>${GROUP_ROOT}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
    let originalMetadata: Partial<SlideModel> | undefined
    try { originalMetadata = slide.sourceFingerprint ? JSON.parse(slide.sourceFingerprint) : undefined } catch { /* Models constructed outside the importer have no metadata baseline. */ }
    doc.documentElement.setAttributeNS(XMLNS, 'xmlns:a', A); doc.documentElement.setAttributeNS(XMLNS, 'xmlns:r', R)
    if (slide.hidden) doc.documentElement.setAttribute('show', '0'); else doc.documentElement.removeAttribute('show')
    const content = child(doc.documentElement, 'cSld')!, tree = child(content, 'spTree')!
    content.setAttribute('name', slide.name)
    const background = child(content, 'bg')
    if (slide.background !== null && (slide.backgroundOverride || !originalMetadata || originalMetadata.background !== slide.background)) {
      const value = node(`<p:bg><p:bgPr>${solid(slide.background)}<a:effectLst/></p:bgPr></p:bg>`)
      if (background) content.replaceChild(doc.importNode(value, true), background); else content.insertBefore(doc.importNode(value, true), tree)
    } else if (slide.background === null && (slide.backgroundOverride || originalMetadata && originalMetadata.background !== null)) {
      const value = doc.importNode(node('<p:bg><p:bgPr><a:noFill/><a:effectLst/></p:bgPr></p:bg>'), true)
      if (background) content.replaceChild(value, background); else content.insertBefore(value, tree)
    }
    const rels = writer.rels(part, sourcePart || part)
    const previousLayout = children(rels.documentElement).find(item => (item.getAttribute('Type') || '').endsWith('/slideLayout'))
    if (!previousLayout || originalMetadata && originalMetadata.layout !== slide.layout) {
      let layout = previousLayout && copyImportedLayout(writer, part, previousLayout, slide.layout)
      if (!layout) { fallback ||= createMaster(writer, presentation, presentationRels, presentationPart); layout = fallback.layouts.get(slide.layout) || fallback.layouts.get(20)! }
      for (const relation of children(rels.documentElement)) if ((relation.getAttribute('Type') || '').endsWith('/slideLayout')) relation.remove()
      writer.relation(rels, part, layout, 'slideLayout')
    }
    const sourceShapeIds = new Set(all(doc, 'cNvPr').map(item => item.getAttribute('id') || ''))
    const existingMedia: Element[] = [], mediaAnchors = new Map<Element, string[]>(), existingMediaIds = new Set<string>(), highestSourceId = Math.max(1, ...[...sourceShapeIds].map(id => Number(id) || 1))
    const sourceOrder = children(tree)
    for (const [position, existing] of sourceOrder.entries()) {
      if (GROUP_TYPES.has(existing.localName)) continue
      if (existing.localName === 'pic' && mediaShape(existing)) {
        const id = all(existing, 'cNvPr')[0]?.getAttribute('id') || ''
        if (slide.media.some(media => media.shapeId === id)) {
          existingMedia.push(existing); existingMediaIds.add(id)
          mediaAnchors.set(existing, sourceOrder.slice(position + 1).map(item => all(item, 'cNvPr')[0]?.getAttribute('id') || '').filter(Boolean))
        }
      }
      existing.remove()
    }
    const usedIds = new Set<number>([1, ...existingMedia.flatMap(element => all(element, 'cNvPr').map(item => Number(item.getAttribute('id'))))])
    const nativeIds = new Set<number>()
    const reserveNativeIds = (objects: SlideObject[]) => { for (const object of objects) {
      if (object.sourceXml) {
        const source = readXml(object.sourceXml).documentElement, id = all(source, 'cNvPr')[0]?.getAttribute('id')
        if (object.sourceCopy === false || object.sourceCopy === undefined && object.id === `${object.sourcePart}#${id}`) {
          nativeIds.add(Number(id))
          if (object.locked) for (const entry of all(source, 'cNvPr')) nativeIds.add(Number(entry.getAttribute('id')))
        }
      }
      if (object.children) reserveNativeIds(object.children)
    } }
    reserveNativeIds(slide.objects)
    checkSiblingConnectorCopies(slide.objects)
    const context: ShapeContext = { writer, part, rels, usedIds, nativeIds, nextId: highestSourceId + 1, groupMappings: [], connectionSources: new WeakMap() }
    for (const object of [...slide.objects].sort((a, b) => a.zIndex - b.zIndex)) tree.insertBefore(doc.importNode(exportShape(object, context), true), child(tree, 'extLst') || null)
    for (const media of existingMedia) {
      const anchors = mediaAnchors.get(media) || [], anchor = anchors.map(id => children(tree).find(item => all(item, 'cNvPr')[0]?.getAttribute('id') === id)).find(Boolean)
      tree.insertBefore(media, anchor || child(tree, 'extLst') || null)
    }
    for (const picture of all(tree, 'pic').filter(mediaShape)) existingMediaIds.add(all(picture, 'cNvPr')[0]?.getAttribute('id') || '')
    for (const object of slide.objects) if (object.locked && object.sourceXml) for (const picture of all(readXml(object.sourceXml), 'pic').filter(mediaShape)) existingMediaIds.add(all(picture, 'cNvPr')[0]?.getAttribute('id') || '')
    checkShapeReferences(doc, sourceShapeIds)
    writeNotes(writer, slide, part, rels)
    writer.put(part, writeXml(doc), `${MIME}slide+xml`); writer.saveRels(part, rels)
    const existing = existingSlides.get(part), relation = existing?.rel || writer.relation(presentationRels, presentationPart, part, 'slide')
    keptRelations.add(relation); append(slideList, `<p:sldId id="${existing?.id || slideId++}" r:id="${relation}"/>`)
    const patch: PptxPatch['slides'][number] = { slideIndex: index }
    const transitionChanged = !originalMetadata || JSON.stringify(originalMetadata.transition) !== JSON.stringify(slide.transition)
    if (transitionChanged && slide.transition.supported && slide.transition.type !== 'unknown') patch.transition = { type: slide.transition.type, ...(slide.transition.durationMs === null ? {} : { durationMs: slide.transition.durationMs }), advanceAfterMs: slide.transition.advanceAfterMs, advanceOnClick: slide.transition.advanceOnClick, ...(slide.transition.direction ? { direction: slide.transition.direction } : {}), ...(slide.transition.orientation ? { orientation: slide.transition.orientation } : {}) }
    const newMedia = slide.media.filter(media => !existingMediaIds.has(media.shapeId) && media.data && !media.external)
    if (newMedia.length) patch.addMedia = newMedia.map(media => ({ kind: media.kind, name: media.name, mimeType: media.mimeType, data: media.data!, rect: media.rect || { x: .1, y: .1, width: .4, height: .3 }, start: media.start === 'auto' ? 'auto' : 'click', loop: media.loop }))
    if (patch.transition || patch.addMedia?.length) patches.push(patch)
  }
  for (const relation of children(presentationRels.documentElement)) if ((relation.getAttribute('Type') || '').endsWith('/slide') && !keptRelations.has(relation.getAttribute('Id') || '')) relation.remove()
  const slideIds = new Set(children(slideList).map(entry => entry.getAttribute('id')))
  for (const entry of all(presentation, 'sldId')) if (!slideIds.has(entry.getAttribute('id'))) entry.remove()
  for (const entry of all(presentation, 'sld')) if (!keptRelations.has(entry.getAttributeNS(R, 'id') || '')) entry.remove()
  ensureNotesMasters(writer, presentation, presentationRels, presentationPart, themeXml())
  writer.put(presentationPart, writeXml(presentation), `${MIME}presentation.main+xml`); writer.saveRels(presentationPart, presentationRels)
  const root = writer.parts.has('_rels/.rels') ? readXml(writer.parts.get('_rels/.rels')!) : readXml(`<Relationships xmlns="${PR}"/>`)
  const office = children(root.documentElement).find(item => (item.getAttribute('Type') || '').endsWith('/officeDocument'))
  if (office) office.setAttribute('Target', presentationPart); else writer.relation(root, '', presentationPart, 'officeDocument')
  writer.put('_rels/.rels', writeXml(root)); writer.put('[Content_Types].xml', writeXml(writer.types))
  const bytes = await writePptxParts(writer.parts)
  return patches.length ? patchPptxPackage(bytes, { slides: patches }) : bytes
}
