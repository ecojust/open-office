import { Inflate, strFromU8 } from 'fflate'
import { DEFAULT_STYLE, type ElementStyle, type Endpoint, type ImportedScene, type Scene, type SceneElement, type ShapeElement } from '../core/types.ts'
import { edgePoints, isBraceShape, shapeOutline, braceTextBounds, rectangleCornerRadius } from '../core/geometry.ts'
import { resolveStrokePattern, sceneDefaultStyle } from '../core/appearance.ts'
import { validateElementStyle } from '../core/documents.ts'
import { readBrushData } from '../core/brushes.ts'

const MAX_TEXT = 20 * 1024 * 1024
const MAX_ELEMENTS = 5000
const xml = (value: unknown): string => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)
const children = (element: Element, name: string): Element[] => Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).tagName === name)
const direct = (element: Element, name: string): Element | undefined => children(element, name)[0]

function parseXml(text: string): Document {
  if (text.length > MAX_TEXT) throw new Error('图形 XML 文件过大，最多支持 20 MB。')
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('不支持包含 DOCTYPE 或实体声明的 XML 文件。')
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (!document.documentElement || document.getElementsByTagName('parsererror').length) throw new Error('图形 XML 格式不正确。')
  return document
}

function finite(value: string | null, fallback = 0): number {
  if (value === null || value === '') return fallback
  const result = Number(value)
  if (!Number.isFinite(result) || Math.abs(result) > 1e7) throw new Error('图形包含无效或过大的坐标。')
  return result
}
function cornerRadius(value: string): number {
  const result = Number(value)
  if (!value.trim() || !Number.isFinite(result) || result < 0) throw new Error('图形包含无效的圆角数值。')
  return result
}

function inflateDiagram(value: string): string {
  if (!/^[A-Za-z\d+/=\s]+$/.test(value)) throw new Error('图形 XML 压缩页面不是有效的 Base64 数据。')
  try {
    const binary = Uint8Array.from(atob(value.replace(/\s/g, '')), character => character.charCodeAt(0))
    const chunks: Uint8Array[] = []
    let length = 0
    const inflater = new Inflate(chunk => {
      length += chunk.length
      if (length > MAX_TEXT) throw new Error('页面解压后超过 20 MB。')
      chunks.push(chunk)
    })
    for (let offset = 0; offset < binary.length; offset += 4096) inflater.push(binary.subarray(offset, offset + 4096), offset + 4096 >= binary.length)
    if (!binary.length) throw new Error('页面为空。')
    const output = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
    return decodeURIComponent(strFromU8(output))
  } catch (error) {
    throw new Error(`无法解压 图形 XML 页面：${error instanceof Error ? error.message : '压缩数据无效'}`)
  }
}

function styleMap(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const entry of value.split(';')) {
    if (!entry) continue
    const separator = entry.indexOf('=')
    if (separator < 0) result[entry] = '1'
    else result[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return result
}

function color(value: string | undefined, fallback: string, warnings: Set<string>): string {
  if (!value) return fallback
  if (value === 'none' || value === 'transparent') return 'transparent'
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value
  const names: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080' }
  if (Object.hasOwn(names, value.toLowerCase())) return names[value.toLowerCase()]!
  warnings.add('部分颜色或渐变不受支持，已使用默认颜色。')
  return fallback
}

function readStyle(map: Record<string, string>, warnings: Set<string>): ElementStyle {
  const supported = new Set(['shape', 'ellipse', 'rhombus', 'text', 'group', 'strokeColor', 'fillColor', 'fontColor', 'strokeWidth', 'fontSize', 'align', 'opacity', 'dashed', 'dashPattern', 'sketch', 'rotation', 'gradientColor', 'shadow', 'rounded', 'arcSize', 'absoluteArcSize', 'fontStyle', 'image', 'movable', 'exitX', 'exitY', 'entryX', 'entryY', 'edgeStyle', 'curved', 'startArrow', 'endArrow', 'html', 'whiteSpace'])
  const unknown = Object.keys(map).filter(key => !supported.has(key))
  if (unknown.length) warnings.add(`部分样式暂不支持，已简化：${unknown.slice(0, 8).join('、')}${unknown.length > 8 ? '等' : ''}。`)
  if (Number(map.rotation || 0)) warnings.add('旋转图形已转为未旋转的图形，位置可能与原图不同。')
  if (map.gradientColor || map.shadow === '1' || Number(map.fontStyle || 0)) warnings.add('渐变、阴影及特殊字体样式已简化。')
  if (map.fontColor && map.strokeColor && map.fontColor !== map.strokeColor) warnings.add('独立的文字颜色已与图形线条颜色统一。')
  const pattern = map.dashPattern?.trim().split(/\s+/).map(Number)
  const dotted = pattern?.length === 2 && pattern.every(Number.isFinite) && pattern[0]! >= 0 && pattern[0]! <= 1 && pattern[1]! > 0
  const strokePattern = map.dashed !== '1' ? 'solid' : dotted ? 'dotted' : 'dashed'
  if (map.dashed === '1' && map.dashPattern && !['1 3', '8 5'].includes(map.dashPattern.trim())) warnings.add('自定义虚线间隔已转换为最接近的虚线或点线。')
  if (map.sketch === '1') warnings.add('手绘线条已保留，具体抖动效果可能与原图不同。')
  return {
    stroke: color(map.strokeColor, DEFAULT_STYLE.stroke, warnings),
    fill: color(map.fillColor, DEFAULT_STYLE.fill, warnings),
    strokeWidth: Math.max(0, Math.min(100, finite(map.strokeWidth ?? null, DEFAULT_STYLE.strokeWidth))),
    fontSize: Math.max(1, Math.min(500, finite(map.fontSize ?? null, DEFAULT_STYLE.fontSize))),
    textAlign: map.align === 'left' || map.align === 'right' ? map.align : 'center',
    opacity: Math.max(0, Math.min(1, finite(map.opacity ?? null, 100) / 100)),
    dashed: strokePattern !== 'solid', strokePattern, roughness: map.sketch === '1' ? 'sketch' : 'clean',
  }
}

function plainLabel(value: string, warnings: Set<string>, html: boolean): string {
  if (!html || !/<[^>]+>|&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:\d+|x[\da-f]+);/i.test(value)) return value
  warnings.add('HTML 富文本标签已转换为纯文本。')
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<br\s*\/?\s*>|<\/(?:div|p|li)>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:\d+|x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!
    const codepoint = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10)
    return codepoint > 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : ''
  }).trim()
}

function safeImage(value: string | undefined): string | undefined {
  const normalized = value?.replace(/^data:image\/(png|jpeg|webp),/i, 'data:image/$1;base64,').replace(/[\r\n]/g, '')
  if (!normalized || normalized.length > 14 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/]+={0,2}$/i.test(normalized)) return undefined
  const body = normalized.slice(normalized.indexOf(',') + 1)
  const bytes = Math.floor(body.length * 3 / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
  return body.length % 4 === 0 && bytes <= 10 * 1024 * 1024 ? normalized : undefined
}

function importModel(model: Element, title: string): ImportedScene {
  const warnings = new Set<string>()
  const root = direct(model, 'root')
  if (!root) throw new Error('图形 XML 页面缺少 root 图形数据。')
  const cells = Array.from(root.getElementsByTagName('mxCell'))
  if (cells.length > MAX_ELEMENTS + 2) throw new Error('单页最多支持 5000 个图形。')
  const cellMap = new Map<string, Element>()
  const idMap = new Map<string, string>()
  const usedIds = new Set<string>()
  for (const cell of cells) {
    const wrapper = cell.parentNode?.nodeType === 1 ? cell.parentNode as Element : null
    const id = cell.getAttribute('id') || (wrapper?.tagName !== 'root' ? wrapper?.getAttribute('id') : null)
    if (!id || cellMap.has(id)) throw new Error('图形 XML 图形缺少 ID 或存在重复 ID。')
    const targetId = cell.getAttribute('openWorkflowId') || id
    if (cell.getAttribute('vertex') === '1' || cell.getAttribute('edge') === '1') {
      if (usedIds.has(targetId)) throw new Error('图形 XML 图形存在重复的目标 ID。')
      usedIds.add(targetId)
    }
    cellMap.set(id, cell); idMap.set(id, targetId)
  }
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>()
  const ancestors = new Set<string>()
  function position(id: string): { x: number; y: number; width: number; height: number } {
    const cached = positions.get(id)
    if (cached) return cached
    if (ancestors.has(id)) throw new Error('图形 XML 图形存在循环的父子关系。')
    ancestors.add(id)
    const cell = cellMap.get(id)
    const geometry = cell ? direct(cell, 'mxGeometry') : undefined
    const parentId = cell?.getAttribute('parent')
    const parent = parentId && cellMap.has(parentId) ? position(parentId) : { x: 0, y: 0, width: 0, height: 0 }
    let x = finite(geometry?.getAttribute('x') ?? null)
    let y = finite(geometry?.getAttribute('y') ?? null)
    if (geometry?.getAttribute('relative') === '1' && cell?.getAttribute('vertex') === '1') {
      x *= parent.width; y *= parent.height
      const offset = children(geometry, 'mxPoint').find(point => point.getAttribute('as') === 'offset')
      x += finite(offset?.getAttribute('x') ?? null); y += finite(offset?.getAttribute('y') ?? null)
      warnings.add('相对定位与端口节点已展开为普通图形。')
    }
    const result = { x: x + parent.x, y: y + parent.y, width: Math.max(1, finite(geometry?.getAttribute('width') ?? null, 120)), height: Math.max(1, finite(geometry?.getAttribute('height') ?? null, 70)) }
    positions.set(id, result); ancestors.delete(id)
    return result
  }
  const elements: SceneElement[] = []
  const nodes = new Map<string, ShapeElement>()
  for (const [id, cell] of cellMap) {
    const braceShape = cell.getAttribute('openWorkflowShape')
    if (cell.getAttribute('vertex') !== '1' && !isBraceShape(braceShape)) continue
    const map = styleMap(cell.getAttribute('style') || '')
    if (map.group === '1' || map.shape === 'group') { warnings.add('分组已展开；成员的世界坐标得到保留，分组关系不保留。'); continue }
    const style = readStyle(map, warnings)
    let shape: ShapeElement['shape'] = 'rectangle'
    const name = map.shape || (map.ellipse ? 'ellipse' : map.rhombus ? 'rhombus' : map.text ? 'text' : 'rectangle')
    if (isBraceShape(braceShape)) { shape = braceShape; style.fill = 'none'; warnings.add('大括弧通过本软件元数据恢复；外部软件仅显示普通开放线条，可能无法保留括弧编辑与绑定语义。') }
    else if (name === 'ellipse') shape = 'ellipse'
    else if (name === 'rhombus' || name === 'diamond') shape = 'diamond'
    else if (name === 'text') { shape = 'text'; style.fill = 'transparent'; style.stroke = color(map.fontColor || map.strokeColor, DEFAULT_STYLE.stroke, warnings) }
    else if (['note', 'triangle', 'hexagon', 'star', 'parallelogram', 'cylinder', 'cloud', 'frame'].includes(name)) shape = name as ShapeElement['shape']
    else if (name === 'image') shape = 'image'
    else if (name !== 'rectangle') warnings.add(`形状“${name}”暂不支持，已显示为矩形。`)
    const imageData = safeImage(cell.getAttribute('openWorkflowImage') || map.image)
    if (shape === 'image' && !imageData) { shape = 'rectangle'; warnings.add('外部图片、SVG 图片或无效图片已替换为占位矩形；仅支持内嵌 PNG/JPEG/WebP。') }
    if (cell.getAttribute('parent') && cellMap.get(cell.getAttribute('parent')!)?.getAttribute('vertex') === '1') warnings.add('分组和容器关系已展开为普通图形。')
    const wrapper = cell.parentNode?.nodeType === 1 ? cell.parentNode as Element : null
    const label = cell.getAttribute('value') || (wrapper?.tagName !== 'root' ? wrapper?.getAttribute('label') : '') || ''
    const bounds = isBraceShape(braceShape) ? { x: finite(cell.getAttribute('openWorkflowX')), y: finite(cell.getAttribute('openWorkflowY')), width: Math.max(1, finite(cell.getAttribute('openWorkflowWidth'), 160)), height: Math.max(1, finite(cell.getAttribute('openWorkflowHeight'), 180)) } : position(id)
    const node: ShapeElement = { id: idMap.get(id)!, type: 'shape', shape, ...bounds, text: plainLabel(label, warnings, map.html === '1'), style, ...(cell.getAttribute('openWorkflowGroup') ? { groupId: cell.getAttribute('openWorkflowGroup')! } : {}), locked: cell.getAttribute('openWorkflowLocked') === '1' || map.movable === '0', ...(shape === 'image' ? { imageData } : {}) }
    if (shape === 'rectangle') {
      const native = cell.getAttribute('openWorkflowCornerRadius')
      const radius = native !== null ? cornerRadius(native) : map.rounded === '1'
        ? map.absoluteArcSize === '1' ? cornerRadius(map.arcSize ?? '20') / 2 : Math.min(node.width, node.height) * Math.min(50, cornerRadius(map.arcSize ?? '15')) / 100 : 0
      if (radius) node.cornerRadius = radius
    } else if (map.rounded === '1' && !['ellipse', 'image', 'text'].includes(shape)) warnings.add('非矩形的圆角样式暂不支持，已保留原形状。')
    nodes.set(id, node); elements.push(node)
  }
  for (const [id, cell] of cellMap) {
    if (cell.getAttribute('edge') !== '1' || isBraceShape(cell.getAttribute('openWorkflowShape'))) continue
    const map = styleMap(cell.getAttribute('style') || '')
    const style = readStyle(map, warnings)
    const geometry = direct(cell, 'mxGeometry')
    const parentId = cell.getAttribute('parent')
    const parent = parentId && cellMap.has(parentId) ? position(parentId) : { x: 0, y: 0 }
    const geometryPoints = geometry ? children(geometry, 'mxPoint') : []
    function endpoint(which: 'source' | 'target'): Endpoint {
      const nodeId = cell.getAttribute(which)
      const node = nodeId ? nodes.get(nodeId) : undefined
      const point = geometryPoints.find(point => point.getAttribute('as') === `${which}Point`)
      if (node) {
        if (point) return { nodeId: node.id, x: finite(point.getAttribute('x')) + parent.x, y: finite(point.getAttribute('y')) + parent.y }
        const horizontal = finite(map[which === 'source' ? 'exitX' : 'entryX'] ?? null, 0.5)
        const vertical = finite(map[which === 'source' ? 'exitY' : 'entryY'] ?? null, 0.5)
        return { nodeId: node.id, x: node.x + node.width * horizontal, y: node.y + node.height * vertical }
      }
      if (nodeId) warnings.add('部分连线的端点引用不受支持或不存在，已保留为自由端点。')
      return { x: finite(point?.getAttribute('x') ?? null) + parent.x, y: finite(point?.getAttribute('y') ?? null) + parent.y }
    }
    let from = endpoint('source'); let to = endpoint('target')
    const pointsContainer = geometry ? children(geometry, 'Array').find(array => array.getAttribute('as') === 'points') : undefined
    const waypoints = pointsContainer ? children(pointsContainer, 'mxPoint').map(point => ({ x: finite(point.getAttribute('x')) + parent.x, y: finite(point.getAttribute('y')) + parent.y })) : []
    if (cell.getAttribute('openWorkflowType') === 'stroke') {
      const points = cell.getAttribute('openWorkflowSinglePoint') === '1' ? [from] : [from, ...waypoints, to]
      const metadata = readBrushData(cell.hasAttribute('openWorkflowBrush') ? cell.getAttribute('openWorkflowBrush') : undefined, cell.hasAttribute('openWorkflowPressures') ? JSON.parse(cell.getAttribute('openWorkflowPressures')!) : undefined, points.length)
      if (metadata.brush) warnings.add('笔触通过本软件元数据恢复；外部软件显示为普通线条，压感、纹理、扁头和彩虹效果以原生文件或图像导出为准。')
      elements.push({ id: idMap.get(id)!, type: 'stroke', ...(cell.getAttribute('openWorkflowClosed') === '1' ? { closed: true } : {}), points, ...metadata, style, ...(cell.getAttribute('openWorkflowGroup') ? { groupId: cell.getAttribute('openWorkflowGroup')! } : {}), locked: cell.getAttribute('openWorkflowLocked') === '1' }); continue
    }
    if (waypoints.length) warnings.add('手工连线折点已简化为自动直线或正交连线。')
    if (map.curved === '1' || (map.edgeStyle && !['orthogonalEdgeStyle', 'elbowEdgeStyle'].includes(map.edgeStyle))) warnings.add('曲线和特殊连线路由已简化。')
    const start = Boolean(map.startArrow && map.startArrow !== 'none')
    const end = map.endArrow !== 'none'
    if (start && !end) [from, to] = [to, from]
    elements.push({ id: idMap.get(id)!, type: 'edge', from, to, label: plainLabel(cell.getAttribute('value') || '', warnings, map.html === '1'), arrow: start && end ? 'both' : start || end ? 'end' : 'none', route: map.edgeStyle === 'orthogonalEdgeStyle' || map.edgeStyle === 'elbowEdgeStyle' ? 'orthogonal' : 'straight', style, ...(cell.getAttribute('openWorkflowGroup') ? { groupId: cell.getAttribute('openWorkflowGroup')! } : {}), locked: cell.getAttribute('openWorkflowLocked') === '1' })
  }
  // Resolve bindings after all vertices exist, then restore the file's layer order.
  // Filled ink, labels and connectors may be interleaved with ordinary shapes.
  const layerOrder = new Map([...cellMap.keys()].map((id, index) => [idMap.get(id)!, index]))
  elements.sort((a, b) => layerOrder.get(a.id)! - layerOrder.get(b.id)!)
  if (elements.reduce((sum, element) => sum + (element.type === 'stroke' ? element.points.length : 0), 0) > 100000) throw new Error('笔迹总点数超过 100000。')
  const defaultStyleText = model.getAttribute('openWorkflowDefaultStyle')
  const defaultStyle = defaultStyleText ? validateElementStyle(JSON.parse(defaultStyleText)) : undefined
  return { title, scene: { elements, background: color(model.getAttribute('background') || undefined, '#ffffff', warnings), grid: model.getAttribute('grid') !== '0', ...(defaultStyle ? { defaultStyle } : {}) }, warnings: [...warnings] }
}

/** Import editable graph XML; unsupported features produce warnings. */
export function importGraphXml(text: string): ImportedScene[] {
  const root = parseXml(text).documentElement
  if (root.tagName === 'mxGraphModel') return [importModel(root, '导入流程图')]
  if (root.tagName !== 'mxfile') throw new Error('文件不符合图形 XML 的 mxfile 或 mxGraphModel 格式。')
  const diagrams = children(root, 'diagram')
  if (!diagrams.length) throw new Error('图形 XML 文件没有可导入的页面。')
  if (diagrams.length > 100) throw new Error('一次最多导入 100 个页面。')
  return diagrams.map((diagram, index) => {
    let model = direct(diagram, 'mxGraphModel')
    if (!model) {
      const value = diagram.textContent?.trim() || ''
      if (!value) throw new Error(`第 ${index + 1} 页为空。`)
      model = parseXml(value.startsWith('<') ? value : inflateDiagram(value)).documentElement
    }
    if (model.tagName !== 'mxGraphModel') throw new Error(`第 ${index + 1} 页不是有效的 mxGraphModel。`)
    return importModel(model, diagram.getAttribute('name') || `页面 ${index + 1}`)
  })
}

function writeStyle(style: ElementStyle): string {
  const pattern = resolveStrokePattern(style)
  return `strokeColor=${style.stroke === 'transparent' ? 'none' : style.stroke};fontColor=${style.stroke === 'transparent' ? 'none' : style.stroke};fillColor=${style.fill === 'transparent' ? 'none' : style.fill};strokeWidth=${style.strokeWidth};fontSize=${style.fontSize};align=${style.textAlign};opacity=${style.opacity * 100};dashed=${pattern === 'solid' ? 0 : 1};${pattern === 'solid' ? '' : `dashPattern=${pattern === 'dotted' ? '1 3' : '8 5'};`}sketch=${style.roughness === 'sketch' ? 1 : 0};html=0;`
}

/** Exports ordinary editable mxCells; own stroke metadata preserves freehand round trips. */
export function exportGraphXml(scene: Scene, title: string): string {
  const cellId = (id: string): string => `wf-${id}`
  const point = (as: string, value: Endpoint): string => `<mxPoint x="${value.x}" y="${value.y}" as="${as}"/>`
  const elements = scene.elements.map(element => {
    const attributes = `id="${xml(cellId(element.id))}" openWorkflowId="${xml(element.id)}" openWorkflowLocked="${element.locked ? 1 : 0}"${element.groupId ? ` openWorkflowGroup="${xml(element.groupId)}"` : ''} parent="1"`
    if (element.type === 'shape') {
      if (isBraceShape(element.shape)) {
        const points = shapeOutline(element), text = braceTextBounds(element), midpoint = points[Math.floor(points.length / 2)]!
        const metadata = `openWorkflowShape="${element.shape}" openWorkflowX="${element.x}" openWorkflowY="${element.y}" openWorkflowWidth="${element.width}" openWorkflowHeight="${element.height}" openWorkflowCompatibility="外部软件显示为开放线条；括弧编辑与绑定语义依赖本软件元数据"`
        return `<mxCell ${attributes} ${metadata} edge="1" value="${xml(element.text)}" style="${xml(`${writeStyle({ ...element.style, fill: 'none' })}endArrow=none;startArrow=none;`)}"><mxGeometry relative="1" as="geometry">${point('sourcePoint', points[0]!)}${point('targetPoint', points.at(-1)!)}<Array as="points">${points.slice(1, -1).map(value => `<mxPoint x="${value.x}" y="${value.y}"/>`).join('')}</Array><mxPoint x="${text.x + text.width / 2 - midpoint.x}" y="${text.y + text.height / 2 - midpoint.y}" as="offset"/></mxGeometry></mxCell>`
      }
      const shape = element.shape === 'diamond' ? 'rhombus' : element.shape === 'text' ? 'text' : element.shape
      const imageData = element.shape === 'image' ? safeImage(element.imageData) : undefined
      if (element.shape === 'image' && !imageData) throw new Error('导出图片必须为不超过 10 MB 的内嵌 PNG/JPEG/WebP。')
      const image = imageData ? `image=${imageData.replace(';base64,', ',')};` : ''
      const radius = rectangleCornerRadius(element), rounded = radius ? `rounded=1;absoluteArcSize=1;arcSize=${radius * 2};` : ''
      const radiusMetadata = element.shape === 'rectangle' && element.cornerRadius ? ` openWorkflowCornerRadius="${cornerRadius(String(element.cornerRadius))}"` : ''
      return `<mxCell ${attributes}${radiusMetadata} vertex="1" value="${xml(element.text)}" style="${xml(`shape=${shape};${writeStyle(element.style)}${image}${rounded}`)}"><mxGeometry x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" as="geometry"/></mxCell>`
    }
    if (element.type === 'stroke') {
      if (!element.points.length) throw new Error('笔迹没有坐标，无法导出。')
      const metadata = readBrushData(element.brush, element.pressures, element.points.length)
      const brush = metadata.brush ? ` openWorkflowBrush="${metadata.brush}" openWorkflowCompatibility="外部软件显示为普通线条；完整笔触与压感依赖本软件元数据，完整外观请使用原生文件或图像导出"` : ''
      const pressures = metadata.pressures ? ` openWorkflowPressures="${xml(JSON.stringify(metadata.pressures))}"` : ''
      return `<mxCell ${attributes} openWorkflowType="stroke"${brush}${pressures}${element.closed ? ' openWorkflowClosed="1"' : ''}${element.points.length === 1 ? ' openWorkflowSinglePoint="1"' : ''} edge="1" style="${xml(`${writeStyle(element.style)}endArrow=none;startArrow=none;`)}"><mxGeometry relative="1" as="geometry">${point('sourcePoint', element.points[0]!)}${point('targetPoint', element.points.at(-1)!)}<Array as="points">${element.points.slice(1, -1).map(value => `<mxPoint x="${value.x}" y="${value.y}"/>`).join('')}</Array></mxGeometry></mxCell>`
    }
    const bindings = `${element.from.nodeId ? ` source="${xml(cellId(element.from.nodeId))}"` : ''}${element.to.nodeId ? ` target="${xml(cellId(element.to.nodeId))}"` : ''}`
    const route = element.route === 'orthogonal' ? 'edgeStyle=orthogonalEdgeStyle;' : ''
    const points = edgePoints(element, scene)
    return `<mxCell ${attributes} edge="1"${bindings} value="${xml(element.label)}" style="${xml(`${writeStyle(element.style)}${route}startArrow=${element.arrow === 'both' ? 'block' : 'none'};endArrow=${element.arrow === 'none' ? 'none' : 'block'};`)}"><mxGeometry relative="1" as="geometry">${point('sourcePoint', points[0]!)}${point('targetPoint', points.at(-1)!)}</mxGeometry></mxCell>`
  }).join('')
  const defaults = scene.defaultStyle ? ` openWorkflowDefaultStyle="${xml(JSON.stringify(sceneDefaultStyle(scene)))}"` : ''
  return `<?xml version="1.0" encoding="UTF-8"?><mxfile host="open-office" version="1"><diagram id="page-1" name="${xml(title)}"><mxGraphModel grid="${scene.grid ? 1 : 0}" background="${xml(scene.background)}"${defaults}><root><mxCell id="0"/><mxCell id="1" parent="0"/>${elements}</root></mxGraphModel></diagram></mxfile>`
}
