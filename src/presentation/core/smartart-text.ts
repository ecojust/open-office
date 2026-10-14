import type { PresentationModel, SlideObject } from './types'
import { A, PR, R, all, child, children, objectFingerprint, readXml, relPart, resolvePart, writeXml, xmlBytes } from './pptx-common.ts'

const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram'
export interface SmartArtTextNode {
  /** The cached shape's modelId; never cNvPr.id or an array index. */
  id: string
  contentId: string
  originalText: string
  text: string
  editable: boolean
  reason?: string
}
export interface SmartArtTextModel {
  dataPart: string
  drawingPart: string
  nodes: SmartArtTextNode[]
  blockedReason?: string
  sourceBlockedReason?: string
}
export interface SmartArtTextAction {
  type: 'update-smartart-text'
  id: string
  nodeId: string
  text: string
  expectedRevision: number
  preparationId: string
}

function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const objectsOf = (objects: SlideObject[]): SlideObject[] => objects.flatMap(object => [object, ...objectsOf(object.children || [])])
const allObjects = (model: PresentationModel) => model.slides.flatMap(slide => [...objectsOf(slide.objects), ...objectsOf(slide.inheritedObjects || [])])
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
const textBody = (point: Element) => children(point).find(node => node.localName === 't' && node.namespaceURI === DGM)
function plainText(body: Element | undefined): { text: string; supported: boolean } {
  if (!body) return { text: '', supported: false }
  const paragraphs = children(body, 'p'), runs = paragraphs.flatMap(paragraph => children(paragraph, 'r'))
  const text = paragraphs.map(paragraph => children(paragraph).map(run => run.localName === 'br' ? '\n' : ['r', 'fld'].includes(run.localName) ? all(run, 't').map(node => node.textContent || '').join('') : '').join('')).join('\n')
  const supported = paragraphs.length === 1 && runs.length <= 1 && !/[\r\n\u0000-\u001f]/.test(text)
    && all(body, '*').every(node => node.namespaceURI === A)
    && children(body).every(node => ['bodyPr', 'lstStyle', 'p'].includes(node.localName))
    && children(paragraphs[0]).every(node => ['pPr', 'r', 'endParaRPr'].includes(node.localName))
    && runs.every(run => children(run).every(node => ['rPr', 't'].includes(node.localName)) && children(run, 't').length === 1)
    && !['fld', 'hlinkClick', 'hlinkMouseOver', 'extLst'].some(name => all(body, name).length)
  return { text, supported }
}
function graph(data: Document, drawing: Document) {
  requireCondition(data.documentElement.namespaceURI === DGM && data.documentElement.localName === 'dataModel', 'SmartArt 数据部件类型不支持文字编辑。')
  requireCondition(drawing.documentElement.namespaceURI === DSP && drawing.documentElement.localName === 'drawing', 'SmartArt 缓存部件类型不支持文字编辑。')
  const points = children(child(data.documentElement, 'ptLst'), 'pt'), connections = children(child(data.documentElement, 'cxnLst'), 'cxn')
  const relations = connections.filter(node => node.getAttribute('type') === 'presOf')
  const shapes = all(drawing, 'sp').filter(shape => shape.namespaceURI === DSP)
  requireCondition(points.length <= 4000 && shapes.length <= 2000 && connections.length <= 8000, 'SmartArt 节点或映射数量超过文字编辑预算。')
  // OOXML defaults an omitted connection type to parOf. Layout ownership may
  // legitimately refer to a parent while presOf identifies the child text.
  const parents = new Map<string, Element[]>()
  for (const relation of connections) if (!relation.hasAttribute('type') || relation.getAttribute('type') === 'parOf') {
    const id = relation.getAttribute('destId') || ''
    const inbound = parents.get(id)
    if (inbound) inbound.push(relation); else parents.set(id, [relation])
  }
  const ids = points.map(point => point.getAttribute('modelId') || ''), shapeIds = shapes.map(shape => shape.getAttribute('modelId') || '')
  const valid = child(data.documentElement, 'ptLst')?.namespaceURI === DGM && child(data.documentElement, 'cxnLst')?.namespaceURI === DGM
    && points.every(node => node.namespaceURI === DGM && children(node, 'prSet').length <= 1 && children(node, 'prSet').every(properties => properties.namespaceURI === DGM))
    && connections.every(node => node.namespaceURI === DGM)
    && points.length <= 4000 && shapes.length <= 2000 && ids.every(id => id.length > 0 && id.length < 256) && new Set(ids).size === ids.length
    && shapeIds.every(id => id.length > 0 && id.length < 256) && new Set(shapeIds).size === shapeIds.length
  return { points, relations, shapes, parents, valid, byId: new Map(points.map(point => [point.getAttribute('modelId')!, point])) }
}

/** Support a direct parent layout owner only when the content tree proves it.
 * Text always comes from presOf; this test never substitutes the parent's text.
 * Check the ancestor chain as well so duplicate parents and cycles stay read-only.
 */
function supportedLayoutOwner(association: string | null | undefined, contentId: string, byId: Map<string, Element>, parents: Map<string, Element[]>): boolean {
  if (!association || association === contentId) return true
  const owner = byId.get(association), direct = parents.get(contentId) || []
  if (!owner || !['', 'node'].includes(owner.getAttribute('type') || '') || direct.length !== 1 || direct[0]!.getAttribute('srcId') !== association) return false
  const seen = new Set<string>()
  let id = contentId
  while (true) {
    if (seen.has(id)) return false
    seen.add(id)
    const point = byId.get(id)
    if (!point || !['', 'node', 'doc'].includes(point.getAttribute('type') || '')) return false
    const inbound = parents.get(id) || []
    if (!inbound.length) return true
    if (inbound.length !== 1) return false
    id = inbound[0]!.getAttribute('srcId') || ''
  }
}

/** Only complete, unambiguous text mirrors are offered for this first editing pass. */
export function readSmartArtTextModel(data: Document, drawing: Document, dataPart: string, drawingPart: string): SmartArtTextModel {
  const { points, relations, shapes, parents, valid, byId } = graph(data, drawing)
  const nodes = shapes.map(shape => {
    const id = shape.getAttribute('modelId') || '', presentation = byId.get(id), incoming = relations.filter(relation => relation.getAttribute('destId') === id)
    const contentId = incoming.length === 1 ? incoming[0]!.getAttribute('srcId') || '' : '', content = byId.get(contentId)
    const cache = plainText(child(shape, 'txBody')), source = content ? plainText(textBody(content)) : { text: '', supported: false }
    let reason: string | undefined
    if (!valid) reason = '节点 ID 重复、缺失或数量超过限制。'
    else if (!presentation || presentation.getAttribute('type') !== 'pres' || incoming.length !== 1 || !content) reason = '缺少唯一的正文与展现节点映射。'
    else if (!['', 'node'].includes(content.getAttribute('type') || '')) reason = '这是装饰或过渡节点，不是可编辑正文节点。'
    else if (!supportedLayoutOwner(child(presentation, 'prSet')?.getAttribute('presAssocID'), contentId, byId, parents)) reason = '无法确认该节点的布局归属与文字来源关系，本轮保持只读。'
    else if (all(child(shape, 'spPr'), 'blipFill').length || all(child(content, 'spPr'), 'blipFill').length || all(shape, 'blip').length) reason = '图片填充节点本轮不开放文字编辑。'
    else if (!cache.supported || !source.supported) reason = '仅支持单段普通文字；字段、超链接、多段或多个文字样式保持只读。'
    else if (source.text !== cache.text) reason = '正文与绘图缓存文字不一致，无法安全回写。'
    const targets = relations.filter(relation => relation.getAttribute('srcId') === contentId).map(relation => relation.getAttribute('destId') || '')
    const cachedTargets = shapes.filter(candidate => targets.includes(candidate.getAttribute('modelId') || ''))
    if (!reason && (new Set(targets).size !== targets.length || cachedTargets.length !== 1)) reason = '同一正文存在多个可见缓存或重复映射，本轮保持只读。'
    if (!reason) for (const target of targets) {
      const point = byId.get(target), inbound = relations.filter(relation => relation.getAttribute('destId') === target)
      if (!point || point.getAttribute('type') !== 'pres' || inbound.length !== 1 || inbound[0]!.getAttribute('srcId') !== contentId) { reason = '展现节点存在聚合或无效映射。'; break }
      const body = textBody(point), mirror = plainText(body)
      if (body && (!mirror.supported || mirror.text !== source.text)) { reason = '展现节点不是完整的正文文字镜像。'; break }
    }
    // A further text-bearing presAssoc alias with no presOf link cannot be safely updated.
    if (!reason && points.some(point => point.getAttribute('type') === 'pres' && child(point, 'prSet')?.getAttribute('presAssocID') === contentId && textBody(point) && !targets.includes(point.getAttribute('modelId') || ''))) reason = '存在无法证明归属的文字镜像。'
    return { id, contentId, originalText: source.text, text: source.text, editable: !reason, ...(reason ? { reason } : {}) }
  })
  return { dataPart, drawingPart, nodes }
}

function localRelations(parts: Map<string, Uint8Array>, owner: string): Element[] {
  const bytes = parts.get(relPart(owner)); if (!bytes) return []
  const doc = readXml(bytes)
  requireCondition(doc.documentElement.namespaceURI === PR && children(doc.documentElement, 'Relationship').every(node => node.namespaceURI === PR), 'SmartArt 关系部件命名空间无效。')
  return children(doc.documentElement, 'Relationship')
}
function linkedParts(parts: Map<string, Uint8Array>, object: SlideObject): { dataPart: string; drawingPart: string } {
  requireCondition(object.sourceXml && object.sourcePart, 'SmartArt 缺少原始关系信息。')
  const source = readXml(object.sourceXml), refs = all(source, 'relIds')
  requireCondition(refs.length === 1 && refs[0]!.namespaceURI === DGM, 'SmartArt 数据引用命名空间或数量不支持编辑。')
  const dataId = Array.from(refs[0]!.attributes).find(attribute => attribute.localName === 'dm' && attribute.namespaceURI === R)?.value
  const candidates = localRelations(parts, object.sourcePart).filter(rel => rel.getAttribute('Id') === dataId && (rel.getAttribute('Type') || '').endsWith('/diagramData'))
  requireCondition(candidates.length === 1 && candidates[0]!.getAttribute('TargetMode') !== 'External', 'SmartArt 数据关系必须唯一且指向本地。')
  const dataPart = resolvePart(object.sourcePart, candidates[0]!.getAttribute('Target') || ''), bytes = parts.get(dataPart)
  requireCondition(bytes, 'SmartArt 数据部件缺失。')
  const extensions = all(readXml(bytes), 'dataModelExt').filter(node => node.namespaceURI === DSP)
  requireCondition(extensions.length === 1, 'SmartArt 缓存关系不唯一。')
  const drawingId = extensions[0]!.getAttribute('relId')
  let owner = object.sourcePart, matches = localRelations(parts, owner).filter(rel => rel.getAttribute('Id') === drawingId && (rel.getAttribute('Type') || '').endsWith('/diagramDrawing'))
  if (!matches.length) { owner = dataPart; matches = localRelations(parts, owner).filter(rel => rel.getAttribute('Id') === drawingId && (rel.getAttribute('Type') || '').endsWith('/diagramDrawing')) }
  requireCondition(matches.length === 1 && matches[0]!.getAttribute('TargetMode') !== 'External', 'SmartArt 绘图关系必须唯一且指向本地。')
  const drawingPart = resolvePart(owner, matches[0]!.getAttribute('Target') || '')
  requireCondition(parts.has(drawingPart), 'SmartArt 绘图缓存缺失。')
  return { dataPart, drawingPart }
}

interface SourceRelation { id: string; type: string; target: string; external: boolean }
interface SourceOwnership { dataUses: Map<string, number>; drawingUses: Map<string, number>; drawingOwners: Map<string, Set<string>>; externalOwners: Set<string> }
const ownershipCache = new WeakMap<Map<string, Uint8Array>, SourceOwnership>()
/** Package parts are immutable. Index source bindings once, while model clones are checked live. */
function sourceOwnership(parts: Map<string, Uint8Array>): SourceOwnership {
  const cached = ownershipCache.get(parts); if (cached) return cached
  const result: SourceOwnership = { dataUses: new Map(), drawingUses: new Map(), drawingOwners: new Map(), externalOwners: new Set() }, owners = new Map<string, SourceRelation[]>()
  const documents = new Map<string, Document>()
  const doc = (part: string) => { if (!documents.has(part) && parts.has(part)) documents.set(part, readXml(parts.get(part)!)); return documents.get(part) }
  for (const [name, bytes] of parts) if (name.endsWith('.rels')) {
    const slash = name.lastIndexOf('/_rels/'), owner = name === '_rels/.rels' ? '' : slash >= 0 ? name.slice(0, slash + 1) + name.slice(slash + 7, -5) : name.replace(/^_rels\//, '').replace(/\.rels$/, '')
    const relations = children(readXml(bytes).documentElement, 'Relationship').map(node => ({ id: node.getAttribute('Id') || '', type: node.getAttribute('Type') || '', target: node.getAttribute('Target') || '', external: node.getAttribute('TargetMode') === 'External' }))
    owners.set(owner, relations)
    for (const relation of relations) {
      if (relation.external) { result.externalOwners.add(owner); continue }
      if (relation.type.endsWith('/diagramDrawing')) {
        const target = resolvePart(owner, relation.target), set = result.drawingOwners.get(target) || new Set<string>(); set.add(owner); result.drawingOwners.set(target, set)
      }
    }
  }
  for (const [owner, relations] of owners) for (const relation of relations) if (!relation.external && relation.type.endsWith('/diagramData')) {
    const dataPart = resolvePart(owner, relation.target), uses = Math.max(1, all(doc(owner), 'relIds').filter(ref => Array.from(ref.attributes).some(attribute => attribute.localName === 'dm' && attribute.value === relation.id)).length)
    result.dataUses.set(dataPart, (result.dataUses.get(dataPart) || 0) + uses)
    // Even an unsupported data root or missing preview must count as cache ownership.
    for (const extension of all(doc(dataPart), 'dataModelExt').filter(node => node.namespaceURI === DSP)) {
      const id = extension.getAttribute('relId')
      let drawingOwner = owner, matches = relations.filter(item => item.id === id && item.type.endsWith('/diagramDrawing'))
      if (!matches.length) { drawingOwner = dataPart; matches = (owners.get(dataPart) || []).filter(item => item.id === id && item.type.endsWith('/diagramDrawing')) }
      for (const match of matches) if (!match.external) {
        const target = resolvePart(drawingOwner, match.target); result.drawingUses.set(target, (result.drawingUses.get(target) || 0) + uses)
      }
    }
  }
  ownershipCache.set(parts, result)
  return result
}

export function smartArtEditBlockReason(model: PresentationModel, object: SlideObject): string | undefined {
  if (!model.sourceParts || !object.smartArt || !object.diagramPreview) return 'SmartArt 没有完整的本地数据和可用预览。'
  const metadata = object.smartArt
  if (metadata.sourceBlockedReason) return metadata.sourceBlockedReason
  if (!model.slides.some(slide => slide.objects.includes(object))) return '嵌套分组或母版 SmartArt 本轮保持只读。'
  if (allObjects(model).filter(candidate => candidate.smartArt && (candidate.smartArt.dataPart === metadata.dataPart || candidate.smartArt.drawingPart === metadata.drawingPart)).length !== 1) return '此 SmartArt 数据被多个对象或复制页面共用；本轮禁止编辑以免改动其他页面。'
  try {
    const actual = linkedParts(model.sourceParts, object)
    if (actual.dataPart !== metadata.dataPart || actual.drawingPart !== metadata.drawingPart) return 'SmartArt 源关系与当前节点信息不一致。'
    const index = sourceOwnership(model.sourceParts)
    if ([metadata.dataPart, metadata.drawingPart, object.sourcePart].some(owner => !!owner && index.externalOwners.has(owner))) return '图表相关部件含外部关系，本轮保持只读。'
    if (index.dataUses.get(metadata.dataPart) !== 1) return 'SmartArt 数据被其他源页面或对象共用，本轮保持只读。'
    if (index.drawingUses.get(metadata.drawingPart) !== 1 || [...index.drawingOwners.get(metadata.drawingPart) || []].some(owner => owner !== object.sourcePart && owner !== metadata.dataPart)) return 'SmartArt 绘图缓存被其他部件共用，本轮保持只读。'
  } catch (error) { return error instanceof Error ? error.message : 'SmartArt 关系无法安全校验。' }
}

export function refreshSmartArtEditability(model: PresentationModel): void {
  for (const object of allObjects(model)) if (object.smartArt) {
    const blockedReason = smartArtEditBlockReason(model, object)
    if (blockedReason) object.smartArt = { ...object.smartArt, blockedReason }
    else if (object.smartArt.blockedReason) { const { blockedReason: _reason, ...metadata } = object.smartArt; object.smartArt = metadata }
  }
}

export function hasSmartArtBinding(object: SlideObject): boolean {
  return !!object.smartArt || /<(?:[\w.-]+:)?graphicData\b[^>]*\buri\s*=\s*(["'])http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/diagram\1/.test(object.sourceXml || '')
}

function changeBody(body: Element, text: string) {
  const paragraph = child(body, 'p')!
  let run = child(paragraph, 'r')
  if (!run) {
    run = body.ownerDocument.createElementNS(A, 'a:r')
    const ending = child(paragraph, 'endParaRPr')
    if (ending) {
      const properties = body.ownerDocument.createElementNS(A, 'a:rPr')
      for (const attribute of Array.from(ending.attributes)) properties.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
      for (const item of Array.from(ending.childNodes)) properties.appendChild(item.cloneNode(true))
      run.appendChild(properties)
    }
    run.appendChild(body.ownerDocument.createElementNS(A, 'a:t')); paragraph.insertBefore(run, ending || null)
  }
  child(run, 't')!.textContent = text
  child(run, 't')!.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
}
function cleanInput(text: string) {
  requireCondition(typeof text === 'string' && text.length <= 1000 && !/[\u0000-\u001f\u007f\r\n\u2028\u2029]/.test(text), 'SmartArt 节点文字限 1000 字单行普通文字。')
  return text
}

/** Return fresh bytes for exactly the two owned parts. Never mutate source buffers. */
export function smartArtTextParts(model: PresentationModel, object: SlideObject, edits: Record<string, string>): Map<string, Uint8Array> {
  const blocked = smartArtEditBlockReason(model, object); requireCondition(!blocked, blocked || '')
  const source = model.sourceParts!, metadata = object.smartArt!, data = readXml(source.get(metadata.dataPart)!), drawing = readXml(source.get(metadata.drawingPart)!)
  const fresh = readSmartArtTextModel(data, drawing, metadata.dataPart, metadata.drawingPart), { points, relations, shapes, byId } = graph(data, drawing)
  const modified = new Map<string, Uint8Array>()
  for (const [id, raw] of Object.entries(edits)) {
    const text = cleanInput(raw), node = fresh.nodes.find(candidate => candidate.id === id)
    requireCondition(node?.editable, node?.reason || 'SmartArt 节点无法安全编辑。')
    if (text === node.originalText) continue
    const point = byId.get(node.contentId)!, targets = relations.filter(relation => relation.getAttribute('srcId') === node.contentId).map(relation => relation.getAttribute('destId') || '')
    changeBody(textBody(point)!, text)
    for (const related of points.filter(candidate => targets.includes(candidate.getAttribute('modelId') || ''))) {
      const body = textBody(related); if (body) changeBody(body, text)
      if (child(related, 'prSet')?.hasAttribute('phldr')) child(related, 'prSet')!.setAttribute('phldr', '0')
    }
    if (child(point, 'prSet')?.hasAttribute('phldr')) child(point, 'prSet')!.setAttribute('phldr', '0')
    changeBody(child(shapes.find(shape => shape.getAttribute('modelId') === id)!, 'txBody')!, text)
    modified.set(metadata.dataPart, xmlBytes(writeXml(data))); modified.set(metadata.drawingPart, xmlBytes(writeXml(drawing)))
  }
  return modified
}

type Prepared = { id: string; nodeId: string; text: string; revision: number; sourceParts: WeakRef<Map<string, Uint8Array>>; fingerprint: string; edits: Record<string, string>; preview: NonNullable<SlideObject['diagramPreview']>; metadata: SmartArtTextModel; expiry: ReturnType<typeof setTimeout> }
const preparations = new Map<string, Prepared>()

/** Safe to call after success, cancellation, stale completion or any failed transaction. */
export function discardPreparedSmartArtTextEdit(action: Pick<SmartArtTextAction, 'preparationId'>): void {
  const prepared = preparations.get(action.preparationId)
  if (prepared) { clearTimeout(prepared.expiry); preparations.delete(action.preparationId) }
}

/** Async raster preparation finishes before the controller's atomic synchronous action. */
export async function prepareSmartArtTextEdit(model: PresentationModel, objectId: string, nodeId: string, raw: string, expectedRevision: number): Promise<SmartArtTextAction> {
  requireCondition(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'SmartArt 编辑必须绑定有效文档版本。')
  const object = allObjects(model).find(candidate => candidate.id === objectId); requireCondition(object?.smartArt, '请选择包含可编辑节点的 SmartArt。')
  const node = object.smartArt.nodes.find(candidate => candidate.id === nodeId); requireCondition(node?.editable, node?.reason || object.smartArt.blockedReason || '此 SmartArt 节点只读。')
  const text = cleanInput(raw), fingerprint = objectFingerprint(object), edits = { ...object.smartArtEdits, [nodeId]: text }
  if (text === node.originalText) delete edits[nodeId]
  const updated = smartArtTextParts(model, object, edits), parts = new Map(model.sourceParts)
  for (const [part, bytes] of updated) parts.set(part, bytes)
  const { prepareSmartArtPreview } = await import('./pptx-import')
  const preview = await prepareSmartArtPreview(model, object, parts)
  requireCondition(preview, 'SmartArt 新文字预览生成失败，原文档未改变。')
  const metadata = { ...object.smartArt, nodes: object.smartArt.nodes.map(candidate => ({ ...candidate, text: own(edits, candidate.id) ? edits[candidate.id]! : candidate.originalText })) }
  const preparationId = crypto.randomUUID()
  requireCondition(preview.dataUrl.length * 2 <= 12_000_000, 'SmartArt 编辑预览超出内存预算。')
  while (preparations.size && (preparations.size >= 4 || [...preparations.values()].reduce((total, prepared) => total + prepared.preview.dataUrl.length * 2, preview.dataUrl.length * 2) > 12_000_000)) discardPreparedSmartArtTextEdit({ preparationId: preparations.keys().next().value! })
  const expiry = setTimeout(() => discardPreparedSmartArtTextEdit({ preparationId }), 30000)
  preparations.set(preparationId, { id: objectId, nodeId, text, revision: expectedRevision, sourceParts: new WeakRef(model.sourceParts!), fingerprint, edits, preview, metadata, expiry })
  return { type: 'update-smartart-text', id: objectId, nodeId, text, expectedRevision, preparationId }
}

export function commitSmartArtTextEdit(model: PresentationModel, object: SlideObject, action: SmartArtTextAction): void {
  const prepared = preparations.get(action.preparationId)
  requireCondition(prepared && prepared.id === action.id && prepared.nodeId === action.nodeId && prepared.text === action.text && prepared.revision === action.expectedRevision, 'SmartArt 更改尚未准备完成或准备信息已过期。')
  requireCondition(model.sourceParts === prepared.sourceParts.deref() && objectFingerprint(object) === prepared.fingerprint, 'SmartArt 已更新，未应用过期节点更改。')
  smartArtTextParts(model, object, prepared.edits)
  object.smartArt = structuredClone(prepared.metadata); object.diagramPreview = { ...prepared.preview }
  if (Object.keys(prepared.edits).length) object.smartArtEdits = { ...prepared.edits }; else delete object.smartArtEdits
  discardPreparedSmartArtTextEdit(action)
}

export function applySmartArtTextParts(model: PresentationModel, parts: Map<string, Uint8Array>): void {
  const written = new Set<string>()
  for (const object of allObjects(model)) if (object.smartArtEdits && Object.keys(object.smartArtEdits).length) {
    for (const [part, bytes] of smartArtTextParts(model, object, object.smartArtEdits)) {
      requireCondition(!written.has(part), '多个 SmartArt 更改指向同一部件，不能安全保存。')
      written.add(part); parts.set(part, bytes)
    }
  }
}
