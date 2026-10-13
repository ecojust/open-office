import type { PresentationTextStyle } from '../types'
import type { PresentationModel, SlideModel, SlideObject } from './types'
import { parsePptxPackage, readPptxParts, PptxPackageError, PPTX_LIMITS } from '../pptx-package'
import { P, all, child, children, objectFingerprint, readXml, relPart, resolvePart, snapshotXml, writeXml } from './pptx-common'

interface Relation { id: string; type: string; target: string; external: boolean }
interface Theme { colors: Record<string, string>; major: string; minor: string; colorMap: Record<string, string>; document?: Document }
interface Context { parts: Map<string, Uint8Array>; documents: Map<string, Document>; theme: Theme; warnings: string[]; defaultText?: Element; masterText?: Element; inherited?: Element[]; animationTargets?: Set<string>; count: number }
interface Transform { x: number; y: number; sx: number; sy: number }
const IDENTITY: Transform = { x: 0, y: 0, sx: 1, sy: 1 }
const DEFAULT_COLORS = { dk1: '#000000', lt1: '#FFFFFF', dk2: '#1F2937', lt2: '#F3F4F6', accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72' }
const DEFAULT_MAP = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }
const BOOL_TRUE = ['1', 'true']
const BASE_STYLE: PresentationTextStyle = { fontName: 'Arial', fontSize: 18, bold: false, italic: false, underline: false, color: '#000000', align: 'left' }
function docAt(context: Pick<Context, 'parts' | 'documents'>, part: string): Document | undefined {
  if (!context.documents.has(part)) { const bytes = context.parts.get(part); if (!bytes) return; context.documents.set(part, readXml(bytes)) }
  return context.documents.get(part)
}
function relationships(context: Pick<Context, 'parts' | 'documents'>, part: string): Relation[] {
  const doc = docAt(context, part ? relPart(part) : '_rels/.rels')
  return children(doc?.documentElement, 'Relationship').map(node => ({ id: node.getAttribute('Id') || '', type: node.getAttribute('Type') || '', target: node.getAttribute('Target') || '', external: node.getAttribute('TargetMode') === 'External' }))
}
function relationship(context: Pick<Context, 'parts' | 'documents'>, part: string, kind: string): string | undefined {
  const rel = relationships(context, part).find(rel => rel.type.endsWith(`/${kind}`) && !rel.external)
  return rel ? resolvePart(part, rel.target) : undefined
}
function attribute(node: Element | undefined, name: string): string {
  return Array.from(node?.attributes || []).find(attr => attr.localName === name && /\/relationships$/.test(attr.namespaceURI || ''))?.value || ''
}
const number = (node: Element | undefined, attr: string, fallback = 0): number => { const raw = node?.getAttribute(attr); const value = raw == null ? fallback : Number(raw); return Number.isFinite(value) ? value : fallback }
function warn(context: Context, message: string) { if (!context.warnings.includes(message)) context.warnings.push(message) }
function mark(object: SlideObject, context: Context, message: string, locked = false) {
  object.warning = [object.warning, message].filter(Boolean).join(' '); object.locked ||= locked
  if (locked) object.capabilities = { text: false, fill: false, line: false, geometry: false }
  warn(context, `${object.name}: ${message}`)
}
function color(node: Element | undefined, theme: Theme): string | null {
  if (!node) return null
  const valueNode = ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr'].includes(node.localName) ? node : children(node).find(n => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr'].includes(n.localName))
  if (!valueNode) return null
  const value = valueNode.getAttribute('val') || ''
  let hex: string | undefined
  if (valueNode.localName === 'srgbClr') hex = value
  else if (valueNode.localName === 'sysClr') hex = valueNode.getAttribute('lastClr') || '000000'
  else if (valueNode.localName === 'schemeClr') hex = (theme.colors[theme.colorMap[value] || value] || theme.colors[value] || '#000000').replace('#', '')
  else if (valueNode.localName === 'prstClr') hex = ({ black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', ltGray: 'D3D3D3', dkGray: 'A9A9A9' } as Record<string, string>)[value]
  else if (valueNode.localName === 'scrgbClr') hex = ['r', 'g', 'b'].map(key => Math.round(Math.max(0, Math.min(100000, number(valueNode, key))) * 255 / 100000).toString(16).padStart(2, '0')).join('')
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null
  let rgb = [0, 2, 4].map(offset => parseInt(hex!.slice(offset, offset + 2), 16))
  for (const modifier of children(valueNode)) {
    const amount = number(modifier, 'val') / 100000
    if (modifier.localName === 'tint') rgb = rgb.map(n => n + (255 - n) * amount)
    if (modifier.localName === 'shade' || modifier.localName === 'lumMod') rgb = rgb.map(n => n * amount)
    if (modifier.localName === 'lumOff') rgb = rgb.map(n => n + 255 * amount)
  }
  return '#' + rgb.map(n => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')).join('').toUpperCase()
}
function themeFor(context: Pick<Context, 'parts' | 'documents'>, masterPart?: string, slide?: Document): Theme {
  const theme: Theme = { colors: { ...DEFAULT_COLORS }, major: 'Arial', minor: 'Arial', colorMap: { ...DEFAULT_MAP } }
  if (masterPart) {
    const master = docAt(context, masterPart), themePart = relationship(context, masterPart, 'theme'), themeDoc = themePart ? docAt(context, themePart) : undefined
    theme.document = themeDoc
    for (const key of children(all(themeDoc, 'clrScheme')[0])) { const hex = color(children(key)[0], theme); if (hex) theme.colors[key.localName] = hex }
    theme.major = child(all(themeDoc, 'majorFont')[0], 'latin')?.getAttribute('typeface') || 'Arial'
    theme.minor = child(all(themeDoc, 'minorFont')[0], 'latin')?.getAttribute('typeface') || 'Arial'
    for (const attr of Array.from(child(master?.documentElement, 'clrMap')?.attributes || [])) theme.colorMap[attr.name] = attr.value
  }
  const mapping = all(slide, 'overrideClrMapping')[0]
  for (const attr of Array.from(mapping?.attributes || [])) theme.colorMap[attr.name] = attr.value
  return theme
}
function textOf(body: Element | undefined): string {
  return children(body, 'p').map(p => children(p).map(run => run.localName === 'br' ? '\n' : ['r', 'fld'].includes(run.localName) ? all(run, 't').map(t => t.textContent || '').join('') : '').join('')).join('\n')
}
const placeholder = (shape: Element | undefined) => child(child(children(shape).find(node => /^nv(?:Sp|Pic|GraphicFrame|CxnSp|GrpSp)Pr$/.test(node.localName)), 'nvPr'), 'ph')
function matchPlaceholder(shape: Element, candidates: Element[]): Element | undefined {
  const ph = placeholder(shape); if (!ph) return
  const type = ph.getAttribute('type') || 'body', idx = ph.getAttribute('idx') || '0'
  return candidates.find(other => { const own = placeholder(other); return own && (own.getAttribute('idx') || '0') === idx && (own.getAttribute('type') || 'body') === type })
    || candidates.find(other => { const own = placeholder(other); return own && (own.getAttribute('idx') || '0') === idx })
    || candidates.find(other => { const own = placeholder(other); return own && (own.getAttribute('type') || 'body') === type })
}
function textStyle(shape: Element, inherited: Element[], context: Context): PresentationTextStyle {
  const style = { ...BASE_STYLE, fontName: context.theme.minor }, body = child(shape, 'txBody'), para = child(body, 'p'), pPr = child(para, 'pPr'), level = Math.max(0, Math.min(8, number(pPr, 'lvl')))
  const phType = placeholder(shape)?.getAttribute('type'), family = ['title', 'ctrTitle'].includes(phType || '') ? 'titleStyle' : phType ? 'bodyStyle' : 'otherStyle'
  const defaults = child(context.defaultText, `lvl${level + 1}pPr`), master = child(child(context.masterText, family), `lvl${level + 1}pPr`)
  const paragraphs: Array<Element | undefined> = [defaults, master]
  for (const source of inherited.slice().reverse()) { const tx = child(source, 'txBody'); paragraphs.push(child(child(tx, 'lstStyle'), `lvl${level + 1}pPr`), child(child(tx, 'p'), 'pPr')) }
  paragraphs.push(child(child(body, 'lstStyle'), `lvl${level + 1}pPr`), pPr)
  const runProps: Array<Element | undefined> = paragraphs.map(p => child(p, 'defRPr'))
  for (const source of inherited.slice().reverse()) runProps.push(all(child(source, 'txBody'), 'rPr')[0])
  runProps.push(all(body, 'rPr')[0], !all(body, 'rPr').length ? all(body, 'endParaRPr')[0] : undefined)
  for (const pr of paragraphs) {
    const align = pr?.getAttribute('algn'); if (align) style.align = ({ l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' } as const)[align as 'l'] || 'left'
  }
  for (const pr of runProps) {
    if (!pr) continue
    if (pr.hasAttribute('sz')) style.fontSize = Math.max(1, Math.min(400, number(pr, 'sz', 1800) / 100))
    if (pr.hasAttribute('b')) style.bold = BOOL_TRUE.includes(pr.getAttribute('b') || '')
    if (pr.hasAttribute('i')) style.italic = BOOL_TRUE.includes(pr.getAttribute('i') || '')
    if (pr.hasAttribute('u')) style.underline = pr.getAttribute('u') !== 'none'
    const font = child(pr, 'latin')?.getAttribute('typeface') || child(pr, 'ea')?.getAttribute('typeface')
    if (font) style.fontName = font.startsWith('+mj') ? context.theme.major : font.startsWith('+mn') ? context.theme.minor : font
    style.color = color(child(pr, 'solidFill'), context.theme) || style.color
  }
  const fontRef = child(child(shape, 'style'), 'fontRef'); if (fontRef && !runProps.some(pr => child(pr, 'solidFill'))) style.color = color(fontRef, context.theme) || style.color
  return style
}
function transform(shape: Element): Element | undefined { return child(shape, 'xfrm') || child(child(shape, shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr'), 'xfrm') }
function geometry(shape: Element, inherited: Element[], parent: Transform) {
  const transforms = [transform(shape), ...inherited.map(transform)].filter((node): node is Element => !!node)
  const off = transforms.map(xfrm => child(xfrm, 'off')).find(Boolean), ext = transforms.map(xfrm => child(xfrm, 'ext')).find(Boolean)
  const rotation = transforms.find(xfrm => xfrm.hasAttribute('rot'))
  return { x: parent.x + number(off, 'x') / 36000 * parent.sx, y: parent.y + number(off, 'y') / 36000 * parent.sy,
    width: Math.abs(number(ext, 'cx', 3600000) / 36000 * parent.sx), height: Math.abs(number(ext, 'cy', 1440000) / 36000 * parent.sy), rotation: number(rotation, 'rot') / 60000 }
}
function textLayout(shape: Element, inherited: Element[]): { layout: NonNullable<SlideObject['textLayout']>; properties: Record<string, string>; sources: Element[] } {
  const sources = [...inherited.slice().reverse(), shape].map(node => child(child(node, 'txBody'), 'bodyPr')).filter((node): node is Element => !!node)
  const properties: Record<string, string> = {}
  for (const source of sources) for (const attr of Array.from(source.attributes)) properties[attr.localName] = attr.value
  const mm = (name: string, fallback: number) => { const value = properties[name] === undefined ? fallback : Number(properties[name]); return Number.isFinite(value) ? value / 36000 : fallback / 36000 }
  const anchor = properties.anchor || 't'
  return { layout: { verticalAlign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
    insets: { left: mm('lIns', 91440), right: mm('rIns', 91440), top: mm('tIns', 45720), bottom: mm('bIns', 45720) },
    wrap: properties.wrap !== 'none', rotation: properties.rot === undefined || !Number.isFinite(Number(properties.rot)) ? 0 : Number(properties.rot) / 60000 }, properties, sources }
}
function mimeFor(context: Context, part: string): string {
  const types = docAt(context, '[Content_Types].xml'), override = children(types?.documentElement, 'Override').find(n => n.getAttribute('PartName') === '/' + part)
  const extension = part.split('.').pop()?.toLowerCase(), entry = children(types?.documentElement, 'Default').find(n => n.getAttribute('Extension')?.toLowerCase() === extension)
  return override?.getAttribute('ContentType') || entry?.getAttribute('ContentType') || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' } as Record<string, string>)[extension || ''] || 'application/octet-stream'
}
function dataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''; for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384))
  return `data:${mime};base64,${btoa(binary)}`
}
function chartData(doc: Document): SlideObject['chart'] | undefined {
  const plot = all(doc, 'plotArea')[0], chartTypes = children(plot).filter(n => /Chart$/.test(n.localName)), chart = chartTypes[0]
  if (chartTypes.length !== 1 || !chart || !['barChart', 'lineChart', 'pieChart'].includes(chart.localName)) return
  if (child(chart, 'grouping') && !['clustered', 'standard'].includes(child(chart, 'grouping')!.getAttribute('val') || '')) return
  const series = children(chart, 'ser'); if (!series.length || series.length > 100 || (chart.localName === 'pieChart' && series.length !== 1)) return
  function cache(field: Element | undefined): string[] | undefined {
    if (!field || all(field, 'multiLvlStrRef').length) return
    const holder = all(field, 'strCache')[0] || all(field, 'numCache')[0] || child(field, 'strLit') || child(field, 'numLit')
    if (!holder) { const literal = child(field, 'v'); return literal ? [literal.textContent || ''] : undefined }
    const points = children(holder, 'pt'), count = number(child(holder, 'ptCount'), 'val', points.length)
    if (!Number.isInteger(count) || count < 1 || count > 1000 || points.length !== count) return
    const values: string[] = new Array(count)
    for (const point of points) { const index = number(point, 'idx', -1); if (!Number.isInteger(index) || index < 0 || index >= count || values[index] !== undefined) return; values[index] = child(point, 'v')?.textContent || '' }
    return values.every(v => v !== undefined) ? values : undefined
  }
  const categories = cache(child(series[0], 'cat')); if (!categories || categories.length * series.length > 20000) return
  const names: string[] = [], columns: number[][] = []
  for (const [index, ser] of series.entries()) {
    const cats = cache(child(ser, 'cat')), values = cache(child(ser, 'val')), name = cache(child(ser, 'tx'))
    if (JSON.stringify(cats) !== JSON.stringify(categories) || !values || values.length !== categories.length || values.some(v => !v.trim() || !Number.isFinite(Number(v)))) return
    names.push(name?.[0] || `系列 ${index + 1}`); columns.push(values.map(Number))
  }
  const title = all(doc, 'title')[0]
  return { type: chart.localName === 'barChart' ? child(chart, 'barDir')?.getAttribute('val') === 'bar' ? 'bar' : 'column' : chart.localName === 'lineChart' ? 'line' : 'pie', categories, series: names, values: categories.map((_, index) => columns.map(column => column[index]!)), title: all(title, 't').map(n => n.textContent || '').join('') }
}
function parseShape(shape: Element, part: string, context: Context, parent = IDENTITY, depth = 0, inheritedMode = false): SlideObject | undefined {
  if (++context.count > 20000 || depth > 40) throw new PptxPackageError('SHAPE_LIMIT', 'PPTX 对象数量或分组深度超过安全限制。')
  if (shape.localName === 'pic' && (all(shape, 'audioFile').length || all(shape, 'videoFile').length || all(shape, 'media').length)) return
  const inherited = context.inherited?.map(candidate => matchPlaceholder(shape, [candidate])).filter((node): node is Element => !!node) || []
  const meta = all(shape, 'cNvPr')[0], body = child(shape, 'txBody'), props = child(shape, 'spPr'), preset = child(props, 'prstGeom')?.getAttribute('prst')
  const graphicData = child(child(shape, 'graphic'), 'graphicData'), graphicUri = graphicData?.getAttribute('uri')
  const type: SlideObject['type'] = shape.localName === 'grpSp' ? 'group' : shape.localName === 'pic' ? 'image'
    : shape.localName === 'cxnSp' || preset === 'line' ? 'line' : shape.localName === 'sp' ? child(props, 'custGeom') ? 'custom' : preset === 'ellipse' ? 'ellipse' : preset && preset !== 'rect' ? 'custom' : body ? 'text' : 'rectangle'
    : shape.localName === 'graphicFrame' && graphicUri === 'http://schemas.openxmlformats.org/drawingml/2006/table' && child(graphicData, 'tbl') ? 'table'
      : shape.localName === 'graphicFrame' && graphicUri === 'http://schemas.openxmlformats.org/drawingml/2006/chart' && child(graphicData, 'chart') ? 'chart' : 'unknown'
  const object: SlideObject = { id: `${part}#${meta?.getAttribute('id') || context.count}`, name: meta?.getAttribute('name') || `对象 ${context.count}`, type, ...geometry(shape, inherited, parent),
    text: textOf(body), fillColor: null, lineColor: null, lineWidth: 0, zIndex: 0, textStyle: textStyle(shape, inherited, context),
    capabilities: { text: ['text', 'rectangle', 'ellipse'].includes(type), fill: ['text', 'rectangle', 'ellipse'].includes(type), line: ['text', 'rectangle', 'ellipse', 'line'].includes(type), geometry: true }, sourcePart: part, sourceXml: snapshotXml(shape), sourceCopy: false }
  if (!inheritedMode && all(shape, 'cNvPr').some(node => context.animationTargets?.has(node.getAttribute('id') || ''))) object.hasAnimation = true
  if (body) {
    const layout = textLayout(shape, inherited); object.textLayout = layout.layout
    if (layout.properties.vert && layout.properties.vert !== 'horz') mark(object, context, '竖排或艺术字文字方向尚未在预览中实现；原始方向和文字 XML 会保留。')
    if (layout.properties.anchor && !['t', 'ctr', 'b'].includes(layout.properties.anchor)) mark(object, context, '分散或两端垂直对齐在预览中使用顶部对齐；原始设置保留。')
    if (Number(layout.properties.numCol || 1) > 1) mark(object, context, '多栏文字在预览中使用单栏；原始栏数和栏间距保留。')
    if (layout.sources.some(source => child(source, 'normAutofit') || child(source, 'spAutoFit'))) mark(object, context, '自动适应字号或文字框尺寸在预览中简化；原始自动适应设置保留。')
    if ([shape, ...inherited].some(node => ['lnSpc', 'spcBef', 'spcAft', 'tabLst'].some(local => all(child(node, 'txBody'), local).length))) mark(object, context, '自定义行距、段距或制表位在预览中简化；原始段落 XML 保留。')
  }
  const propertyChain = [props, ...inherited.map(node => child(node, 'spPr'))].filter((node): node is Element => !!node)
  const fill = propertyChain.map(pr => children(pr).find(n => /^(solidFill|noFill|gradFill|pattFill|blipFill|grpFill)$/.test(n.localName))).find(Boolean)
  object.fillColor = fill?.localName === 'noFill' ? null : color(fill, context.theme)
  const fillRef = child(child(shape, 'style'), 'fillRef')
  if (!fill && fillRef && number(fillRef, 'idx') > 0) object.fillColor = color(fillRef, context.theme)
  const line = propertyChain.map(pr => child(pr, 'ln')).find(Boolean)
  object.lineColor = child(line, 'noFill') ? null : color(child(line, 'solidFill'), context.theme)
  // A noFill line can still retain its width for a later color edit. Dropping
  // the explicit width here makes saving/reopening change that edit's result.
  object.lineWidth = object.lineColor || line?.hasAttribute('w') ? number(line, 'w', 12700) / 36000 : 0
  const lineRef = child(child(shape, 'style'), 'lnRef')
  if (!line && lineRef && number(lineRef, 'idx') > 0) { object.lineColor = color(lineRef, context.theme); object.lineWidth = 12700 / 36000 }
  const alpha = all(fill, 'alpha')[0]; if (alpha) object.opacity = number(alpha, 'val', 100000) / 100000
  if (fill && ['gradFill', 'pattFill', 'blipFill', 'grpFill'].includes(fill.localName)) mark(object, context, '高级填充在预览中简化；原始填充随文件保留。')
  if (all(props, 'effectLst').some(node => children(node).length) || all(props, 'effectDag').length || all(props, 'scene3d').length || all(props, 'sp3d').length) mark(object, context, '阴影、三维或其他高级效果在预览中简化；原始效果保留。')
  if (body && (all(body, 'rPr').length > 1 || all(body, 'buChar').length || all(body, 'buAutoNum').length)) mark(object, context, '文字预览使用统一样式；原有文字段落格式在未编辑时保留。')
  if (body && all(body, 'fld').length) mark(object, context, '自动字段在预览中使用缓存文字；修改所在段落的文字会将字段改为普通文本，未改动的字段 XML 保留。')
  if (all(shape, 'extLst').some(node => children(node).length)) mark(object, context, '对象包含扩展设置；未编辑的扩展 XML 会保留。')
  const xfrm = transform(shape)
  if (BOOL_TRUE.includes(xfrm?.getAttribute('flipH') || '') || BOOL_TRUE.includes(xfrm?.getAttribute('flipV') || '')) mark(object, context, '翻转对象以受保护占位显示并保留原件。', true)
  if (type === 'custom' || type === 'unknown') mark(object, context, '不支持的自定义形状、SmartArt、OLE 或扩展对象以受保护占位显示，原始内容完整保留。', true)
  if (type === 'group') {
    const off = child(xfrm, 'off'), ext = child(xfrm, 'ext'), chOff = child(xfrm, 'chOff'), chExt = child(xfrm, 'chExt')
    const sx = number(ext, 'cx', 1) / (number(chExt, 'cx', 1) || 1), sy = number(ext, 'cy', 1) / (number(chExt, 'cy', 1) || 1)
    if (Math.abs(sx - sy) > 1e-9 && all(shape, 'xfrm').some(node => node !== xfrm && number(node, 'rot') % 10800000 !== 0)) {
      object.hasComplexGroupTransform = true
      mark(object, context, '非等比缩放分组中的旋转内容在预览中简化；原始组合变换保留，暂不支持安全解组。')
    }
    const groupTransform = { sx: parent.sx * sx, sy: parent.sy * sy, x: parent.x + (number(off, 'x') - number(chOff, 'x') * sx) / 36000 * parent.sx, y: parent.y + (number(off, 'y') - number(chOff, 'y') * sy) / 36000 * parent.sy }
    object.children = children(shape).filter(n => !['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(n.localName)).map(n => parseShape(n, part, context, groupTransform, depth + 1, inheritedMode)).filter((node): node is SlideObject => !!node)
    object.children.forEach((node, index) => { node.zIndex = index; node.sourceFingerprint = objectFingerprint(node) })
    if (object.children.some(n => n.locked)) mark(object, context, '此分组包含受保护内容，分组整体编辑已锁定以保留原件。', true)
    if (all(shape, 'audioFile').length || all(shape, 'videoFile').length || all(shape, 'media').length) mark(object, context, '包含媒体的分组保留原始结构；分组整体编辑已锁定。', true)
  }
  if (type === 'image') {
    const blip = all(shape, 'blip')[0], embed = attribute(blip, 'embed'), rel = relationships(context, part).find(rel => rel.id === embed)
    if (!embed || !rel || rel.external) mark(object, context, '外部链接或缺失图片不会联网加载；原关系保留。', true)
    else {
      const imagePart = resolvePart(part, rel.target), bytes = context.parts.get(imagePart), mime = mimeFor(context, imagePart)
      if (!bytes || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(mime)) mark(object, context, '此图片编码暂不支持预览，原图片保留。', true)
      else object.image = { dataUrl: dataUrl(bytes, mime), mimeType: mime, partName: imagePart }
    }
    if (all(shape, 'srcRect').some(node => Array.from(node.attributes).some(attr => Number(attr.value)))) mark(object, context, '图片裁剪在预览中简化，原裁剪参数保留。')
  }
  if (type === 'table') {
    const table = all(shape, 'tbl')[0]!, rows = children(table, 'tr'), cells = rows.map(row => children(row, 'tc').map(cell => textOf(child(cell, 'txBody'))))
    if (cells.length > 1000 || cells.some(row => row.length > 100) || cells.reduce((total, row) => total + row.length, 0) > 20000) throw new PptxPackageError('TABLE_LIMIT', 'PPTX 表格超过安全限制。')
    object.table = { cells }; object.text = cells.map(row => row.join('\t')).join('\n')
    if (all(table, 'tc').some(cell => ['gridSpan', 'rowSpan'].some(attr => number(cell, attr, 1) > 1) || ['hMerge', 'vMerge'].some(attr => BOOL_TRUE.includes(cell.getAttribute(attr) || '')))) mark(object, context, '合并单元格表格以受保护占位显示，原表格保留。', true)
    else mark(object, context, '表格样式在预览中简化；未编辑的表格保留原有样式，调整表格结构时会使用基本样式。')
  }
  if (type === 'chart') {
    const ref = all(shape, 'chart')[0], rel = relationships(context, part).find(rel => rel.id === attribute(ref, 'id'))
    const chartPart = rel && !rel.external ? resolvePart(part, rel.target) : undefined, chartDoc = chartPart ? docAt(context, chartPart) : undefined
    const parsed = chartDoc ? chartData(chartDoc) : undefined
    if (!parsed) mark(object, context, '此图表类型、数据缓存或组合图暂不支持编辑；原图表和工作簿完整保留。', true)
    else { object.chart = parsed; object.text = parsed.title; mark(object, context, '图表预览采用基本样式；未编辑的图表及原工作簿完整保留，编辑数据时会使用基本样式重建。') }
    if (chartPart && relationships(context, chartPart).some(rel => rel.external)) mark(object, context, '图表的外部数据关系已禁用；使用现有缓存预览。')
  }
  if (inheritedMode) { object.locked = true; object.capabilities = { text: false, fill: false, line: false, geometry: false } }
  object.sourceFingerprint = objectFingerprint(object)
  return object
}
function shapeTree(doc?: Document): Element[] { return children(all(doc, 'spTree')[0]).filter(node => !['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(node.localName)) }
function background(docs: Array<Document | undefined>, theme: Theme): string | null {
  for (const doc of docs) {
    const bg = child(child(doc?.documentElement, 'cSld'), 'bg')
    if (bg) return color(child(child(bg, 'bgPr'), 'solidFill'), theme) || color(child(bg, 'bgRef'), theme)
  }
  return '#FFFFFF'
}

/** Import OOXML directly; no office runtime or network resource loading. */
export async function importPresentation(bytes: Uint8Array): Promise<PresentationModel> {
  const parts = await readPptxParts(bytes), documents = new Map<string, Document>(), base = { parts, documents }
  const contentTypes = docAt(base, '[Content_Types].xml'), contentTypeXml = contentTypes ? writeXml(contentTypes) : ''
  if ([...parts.keys()].some(name => /(?:vbaProject|vbaData)\.(?:bin|xml)$/i.test(name)) || /macroEnabled|vbaProject/i.test(contentTypeXml)) throw new PptxPackageError('MACRO_PACKAGE', '含宏的演示文稿不支持导入；请另存为不含宏的 PPTX。')
  if ([...parts.keys()].some(name => /^_xmlsignatures\//i.test(name)) || /digital-signature/i.test(contentTypeXml)) throw new PptxPackageError('SIGNED_PACKAGE', '含数字签名的演示文稿不能安全编辑；请另存为未签名副本。')
  const presentationPart = relationship(base, '', 'officeDocument') || 'ppt/presentation.xml', presentationDoc = docAt(base, presentationPart)
  if (!presentationDoc || presentationDoc.documentElement.localName !== 'presentation') throw new PptxPackageError('PRESENTATION_PART', '文件不包含有效的演示文稿。')
  if (presentationDoc.documentElement.namespaceURI !== P) throw new PptxPackageError('STRICT_OOXML', '暂不支持严格 OOXML 演示文稿的安全编辑；请先在原编辑器另存为标准 PPTX。')
  const packageInfo = await parsePptxPackage(bytes), warnings = [...packageInfo.warnings]
  if (packageInfo.slides.length > PPTX_LIMITS.slides) throw new PptxPackageError('SLIDE_LIMIT', 'PPTX 页数超过限制。')
  for (const [name] of parts) if (/\.rels$/i.test(name)) {
    const rels = children(docAt(base, name)?.documentElement, 'Relationship')
    for (const rel of rels) {
      if (rel.getAttribute('TargetMode') === 'External') { if (!warnings.includes('外部链接已保留但禁用，不会联网获取图片、媒体或数据。')) warnings.push('外部链接已保留但禁用，不会联网获取图片、媒体或数据。') }
      else { const slash = name.lastIndexOf('/_rels/'), owner = name === '_rels/.rels' ? '' : slash >= 0 ? name.slice(0, slash + 1) + name.slice(slash + 7, -5) : name.replace(/^_rels\//, '').replace(/\.rels$/, ''); resolvePart(owner, rel.getAttribute('Target') || '') }
    }
  }
  const slides: SlideModel[] = []
  for (const info of packageInfo.slides) {
    const slideDoc = docAt(base, info.partName)!, layoutPart = relationship(base, info.partName, 'slideLayout'), layoutDoc = layoutPart ? docAt(base, layoutPart) : undefined
    const masterPart = layoutPart ? relationship(base, layoutPart, 'slideMaster') : undefined, masterDoc = masterPart ? docAt(base, masterPart) : undefined
    const ownWarnings = [...info.warnings], theme = themeFor(base, masterPart, slideDoc), layoutShapes = shapeTree(layoutDoc), masterShapes = shapeTree(masterDoc)
    const animationTargets = new Set(all(slideDoc, 'timing').flatMap(timing => all(timing, '*')).flatMap(node => node.hasAttribute('spid') ? [node.getAttribute('spid')!] : []))
    const context: Context = { ...base, theme, warnings: ownWarnings, defaultText: child(presentationDoc.documentElement, 'defaultTextStyle'), masterText: child(masterDoc?.documentElement, 'txStyles'), animationTargets, count: 0 }
    const objects: SlideObject[] = []
    for (const shape of shapeTree(slideDoc)) {
      const layout = matchPlaceholder(shape, layoutShapes), master = matchPlaceholder(layout || shape, masterShapes)
      context.inherited = [layout, master].filter((node): node is Element => !!node)
      const object = parseShape(shape, info.partName, context)
      if (object) { object.zIndex = objects.length; object.sourceFingerprint = objectFingerprint(object); objects.push(object) }
    }
    context.inherited = undefined
    const inheritedObjects: SlideObject[] = []
    if (!['0', 'false'].includes(slideDoc.documentElement.getAttribute('showMasterSp') || '')) {
      for (const [doc, part] of [[masterDoc, masterPart], [layoutDoc, layoutPart]] as const) if (doc && part) for (const shape of shapeTree(doc).filter(shape => !placeholder(shape))) {
        const object = parseShape(shape, part, context, IDENTITY, 0, true); if (object) { object.zIndex = inheritedObjects.length; inheritedObjects.push(object) }
      }
    }
    if (all(slideDoc, 'AlternateContent').length) warn(context, '兼容扩展内容以受保护占位保留，部分内容可能不显示。')
    const bgNode = [slideDoc, layoutDoc, masterDoc].map(doc => child(child(doc?.documentElement, 'cSld'), 'bg')).find(Boolean)
    if (bgNode && !child(child(bgNode, 'bgPr'), 'solidFill') && !child(child(bgNode, 'bgPr'), 'noFill') && !child(bgNode, 'bgRef')) warn(context, '高级背景在预览中简化，原始背景保留。')
    const layoutType = layoutDoc?.documentElement.getAttribute('type') || ''
    const slide: SlideModel = { id: info.id, sourcePart: info.partName, name: info.name || info.title || `幻灯片 ${slides.length + 1}`, hidden: info.hidden,
      layout: ({ title: 0, obj: 1, tx: 1, twoObj: 3, twoTxTwoObj: 3, titleOnly: 19, blank: 20, secHead: 32 } as Record<string, number>)[layoutType] ?? 20,
      background: background([slideDoc, layoutDoc, masterDoc], theme), notes: info.notes, objects, inheritedObjects, transition: info.transition, hasUnsupportedAnimations: info.hasUnsupportedAnimations, media: info.media, warnings: ownWarnings }
    slide.sourceFingerprint = JSON.stringify({ background: slide.background, transition: slide.transition, layout: slide.layout, hidden: slide.hidden, name: slide.name, notes: slide.notes })
    slides.push(slide)
  }
  return { width: packageInfo.widthEmu / 36000, height: packageInfo.heightEmu / 36000, slides, warnings, sourceParts: parts, sourcePresentationPart: presentationPart }
}
