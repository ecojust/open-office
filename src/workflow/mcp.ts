import { clone, DEFAULT_STYLE, newId, type ElementStyle, type Scene, type SceneElement, type WorkflowDocument } from './core/types.ts'
import { safeColor, validateScene } from './core/documents.ts'
import { alignElements, distributeElements, groupElements, ungroupElements, type Alignment, type DistributionAxis } from './core/board-tools.ts'
import { reorderElements, selectionScene, type ReorderOperation } from './core/selection.ts'
import { edgePoints } from './core/geometry.ts'
import { sceneDefaultStyle } from './core/appearance.ts'
import { layoutScene } from './core/layout.ts'
import { BOARD_TEMPLATES, createBoardTemplate } from './core/board-templates.ts'
import { DIAGRAM_STYLES, type DiagramStyleId } from './core/diagram-appearance.ts'
import { DIAGRAM_TEMPLATES } from './core/diagrams/catalog.ts'
import { compileCodeDiagram } from './core/code-diagram.ts'

type ElementInput = Record<string, unknown> & { type: 'shape' | 'edge' | 'stroke'; id?: string; style?: Partial<ElementStyle> }
export type CanvasEditOperation =
 | { op: 'add'; element: ElementInput }
 | { op: 'update'; id: string; patch: Record<string, unknown> & { style?: Partial<ElementStyle> } }
 | { op: 'delete' | 'group' | 'ungroup'; ids: string[] }
 | { op: 'duplicate' | 'move'; ids: string[]; dx?: number; dy?: number }
 | { op: 'reorder'; ids: string[]; order: ReorderOperation }
 | { op: 'align'; ids: string[]; alignment: Alignment }
 | { op: 'distribute'; ids: string[]; axis: DistributionAxis }
 | { op: 'layout'; direction?: 'TB' | 'LR' | 'BT' | 'RL' }
 | { op: 'settings'; title?: string; background?: string; grid?: boolean; defaultStyle?: Partial<ElementStyle> }
 | { op: 'template'; templateId: string; x?: number; y?: number }

function selectedElements(scene: Scene, ids: readonly string[], editing = false): SceneElement[] {
 if (!ids.length || new Set(ids).size !== ids.length) throw Error('请选择不重复的画布元素。')
 return ids.map(id => { const element = scene.elements.find(element => element.id === id); if (!element) throw Error(`画布元素不存在：${id}`); if (editing && element.locked) throw Error(`请先解锁画布元素：${id}`); return element })
}
function translate(element: SceneElement, dx: number, dy: number) {
 if (element.type === 'shape') { element.x += dx; element.y += dy }
 else if (element.type === 'stroke') element.points = element.points.map(point => ({ x: point.x + dx, y: point.y + dy }))
 else for (const endpoint of [element.from, element.to]) if (!endpoint.nodeId) { endpoint.x += dx; endpoint.y += dy }
}
function checkOffset(dx: number, dy: number) { if (![dx,dy].every(value => Number.isFinite(value) && Math.abs(value) <= 1000000)) throw Error('移动距离无效。') }
function mergeStyle(base: ElementStyle, patch: Partial<ElementStyle> = {}): ElementStyle {
 for (const key of ['stroke','fill'] as const) if (patch[key] !== undefined && safeColor(patch[key],'invalid') === 'invalid') throw Error('颜色格式无效。')
 const result = { ...base, ...patch }
 if (patch.dashed !== undefined && patch.strokePattern === undefined) result.strokePattern = patch.dashed ? 'dashed' : 'solid'
 return result
}
function addElement(scene: Scene, raw: ElementInput): string {
 const base = { id: raw.id ?? newId(raw.type), locked: false, style: mergeStyle(sceneDefaultStyle(scene),raw.style) }
 const defaults = raw.type === 'shape' ? { shape: 'rectangle', x: 40, y: 40, width: 200, height: 100, text: '' } : raw.type === 'edge' ? { label: '', arrow: 'end', route: 'straight' } : {}
 const element = { ...defaults, ...base, ...clone(raw), id: base.id, style: base.style }
 scene.elements.push(element as SceneElement)
 return base.id
}
/** All edits are performed on a session draft. Validation and history adoption
 * happen atomically; image data is retained during partial property updates. */
export function editCanvas(document: WorkflowDocument, operations: readonly CanvasEditOperation[]) {
 if (document.kind === 'mermaid') throw Error('代码图表请编辑源码。')
 if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw Error('一次画布编辑需要 1–100 项操作。')
 const created: string[] = []
 for (const operation of operations) {
  let scene = document.scene
  switch (operation.op) {
   case 'add': created.push(addElement(scene, operation.element)); break
   case 'update': {
    const element = selectedElements(scene, [operation.id])[0]!, patch = clone(operation.patch)
    if ('id' in patch || 'type' in patch) throw Error('不能改变元素标识或类型。')
    if (element.locked && Object.keys(patch).some(key => key !== 'locked')) throw Error(`请先解锁画布元素：${element.id}`)
    const fields = element.type === 'shape' ? ['shape','x','y','width','height','cornerRadius','text','imageData'] : element.type === 'edge' ? ['from','to','label','arrow','route'] : ['points','brush','pressures','closed']
    if (Object.keys(patch).some(key => ![...fields,'style','locked','groupId'].includes(key))) throw Error('修改属性与画布元素类型不匹配。')
    const style = mergeStyle(element.style,patch.style)
    Object.assign(element, patch, { style })
    if (patch.groupId === null) delete element.groupId
    break
   }
   case 'delete': {
    selectedElements(scene, operation.ids, true); const ids = new Set(operation.ids)
    scene.elements = scene.elements.flatMap(element => {
     if (ids.has(element.id)) return []
     if (element.type !== 'edge' || ![element.from.nodeId, element.to.nodeId].some(id => id && ids.has(id))) return [element]
     if (!element.locked) return []
     const points = edgePoints(element, scene), copy = clone(element)
     if (copy.from.nodeId && ids.has(copy.from.nodeId)) copy.from = { ...points[0]! }
     if (copy.to.nodeId && ids.has(copy.to.nodeId)) copy.to = { ...points.at(-1)! }
     return [copy]
    }); break
   }
   case 'move': {
    const dx = operation.dx ?? 0, dy = operation.dy ?? 0; checkOffset(dx,dy)
    for (const element of selectedElements(scene, operation.ids, true)) translate(element, dx, dy)
    break
   }
   case 'duplicate': {
    selectedElements(scene, operation.ids); const dx = operation.dx ?? 24, dy = operation.dy ?? 24; checkOffset(dx,dy)
    const copies = selectionScene(scene, operation.ids).elements, identities = new Map(copies.map(element => [element.id, newId(element.type)])), groups = new Map<string,string>()
    for (const element of copies) {
     element.id = identities.get(element.id)!; element.locked = false
     if (element.groupId) { if (!groups.has(element.groupId)) groups.set(element.groupId,newId('group')); element.groupId = groups.get(element.groupId)! }
     if (element.type === 'edge') for (const endpoint of [element.from,element.to]) if (endpoint.nodeId) endpoint.nodeId = identities.get(endpoint.nodeId)!
     translate(element, dx, dy); scene.elements.push(element); created.push(element.id)
    }
    break
   }
   case 'group': selectedElements(scene, operation.ids, true); scene = groupElements(scene, operation.ids); break
   case 'ungroup': selectedElements(scene, operation.ids, true); scene = ungroupElements(scene, operation.ids); break
   case 'reorder': selectedElements(scene, operation.ids, true); scene = reorderElements(scene, operation.ids, operation.order); break
   case 'align': selectedElements(scene, operation.ids); scene = alignElements(scene, operation.ids, operation.alignment); break
   case 'distribute': selectedElements(scene, operation.ids); scene = distributeElements(scene, operation.ids, operation.axis); break
   case 'layout': scene = layoutScene(scene, operation.direction); break
   case 'settings': {
    if (operation.title !== undefined) document.title = operation.title
    if (operation.background !== undefined) { if (safeColor(operation.background,'invalid') === 'invalid') throw Error('背景颜色格式无效。'); scene.background = operation.background }
    if (operation.grid !== undefined) scene.grid = operation.grid
    if (operation.defaultStyle) scene.defaultStyle = mergeStyle(scene.defaultStyle ?? DEFAULT_STYLE,operation.defaultStyle)
    break
   }
   case 'template': {
    if (!BOARD_TEMPLATES.some(item => item.id === operation.templateId)) throw Error('画布模板不存在。')
    const template = createBoardTemplate(operation.templateId), dx = operation.x ?? 0, dy = operation.y ?? 0; checkOffset(dx,dy)
    for (const element of template.elements) { translate(element,dx,dy); scene.elements.push(element); created.push(element.id) }
    break
   }
   default: throw Error('不支持的画布编辑操作。')
  }
  document.scene = scene
 }
 // Resolve all cross-element references after the entire batch, allowing a
 // connector and its two nodes to be added together in any order.
 document.scene = validateScene(document.scene)
 return { created }
}
export interface DiagramUpdate { title?: string; source?: string; templateId?: string; style?: DiagramStyleId }
export function updateDiagram(document: WorkflowDocument, update: DiagramUpdate) {
 if (document.kind !== 'mermaid') throw Error('当前文档不是代码图表。')
 if (!Object.keys(update).length) throw Error('请提供需要修改的图表内容。')
 if (update.source !== undefined && update.templateId !== undefined) throw Error('源码与模板不能同时设置。')
 let source = update.source
 if (update.templateId !== undefined) { const template = DIAGRAM_TEMPLATES.find(item => item.id === update.templateId); if (!template) throw Error('代码图表模板不存在。'); source = template.source }
 if (source !== undefined) { compileCodeDiagram(source); document.source = source }
 if (update.style !== undefined) { if (!DIAGRAM_STYLES.some(style => style.id === update.style)) throw Error('代码图表风格不存在。'); document.diagramStyle = update.style }
 if (update.title !== undefined) document.title = update.title
}
