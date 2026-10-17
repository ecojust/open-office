import { DEFAULT_STYLE, type ElementStyle, type Endpoint, type ImportedScene, type Scene, type SceneElement, type ShapeElement } from '../core/types.ts'
import { edgePoints, elementBounds, isBraceShape, shapeOutline, braceTextBounds } from '../core/geometry.ts'
import { resolveStrokePattern, sceneDefaultStyle } from '../core/appearance.ts'
import { validateElementStyle } from '../core/documents.ts'
import { readBrushData } from '../core/brushes.ts'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function safeImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 14 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/\r\n]+={0,2}$/i.test(value)) return false
  const body = value.slice(value.indexOf(',') + 1).replace(/[\r\n]/g, '')
  const bytes = Math.floor(body.length * 3 / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
  return body.length % 4 === 0 && bytes <= 10 * 1024 * 1024
}
const safeText = (value: unknown): string => typeof value === 'string' ? value.slice(0, 100000) : ''

function finite(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error('白板 JSON 图形包含无效或过大的坐标。')
  return value
}

function color(value: unknown, fallback: string, warnings: Set<string>): string {
  if (value === undefined) return fallback
  if (value === 'transparent' || value === 'none') return 'transparent'
  if (typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value
  const names: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00', gray: '#808080', grey: '#808080' }
  if (typeof value === 'string' && Object.hasOwn(names, value.toLowerCase())) return names[value.toLowerCase()]!
  warnings.add('部分颜色格式不受支持，已使用默认颜色。')
  return fallback
}

function styleOf(element: Json, warnings: Set<string>): ElementStyle {
  if (finite(element.angle) !== 0) warnings.add('旋转图形已转为未旋转的图形，位置可能与原图不同。')
  if (Array.isArray(element.groupIds) && element.groupIds.length > 1) warnings.add('嵌套分组已合并为最外层组合。')
  if (element.frameId) warnings.add('框架位置得到保留；frame 裁剪关系已展开。')
  const roughness = finite(element.roughness) > 0 ? 'sketch' : 'clean'
  const strokePattern = element.strokeStyle === 'dashed' || element.strokeStyle === 'dotted' ? element.strokeStyle : 'solid'
  if (roughness === 'sketch') warnings.add('手绘线条已保留，抖动强度和具体笔迹可能与原图不同。')
  if (element.fillStyle && element.fillStyle !== 'solid') warnings.add('纹理填充已转换为纯色填充。')
  if (element.roundness || element.fontFamily) warnings.add('圆角和字体外观可能与原图不同。')
  if (element.strokeStyle && !['solid', 'dashed', 'dotted'].includes(String(element.strokeStyle))) warnings.add('不支持的线型已转换为实线。')
  return {
    stroke: color(element.strokeColor, DEFAULT_STYLE.stroke, warnings),
    fill: color(element.backgroundColor, 'transparent', warnings),
    strokeWidth: Math.max(0, Math.min(100, finite(element.strokeWidth, DEFAULT_STYLE.strokeWidth))),
    fontSize: Math.max(1, Math.min(500, finite(element.fontSize, DEFAULT_STYLE.fontSize))),
    textAlign: element.textAlign === 'left' || element.textAlign === 'right' ? element.textAlign : 'center',
    opacity: Math.max(0, Math.min(1, finite(element.opacity, 100) / 100)),
    dashed: strokePattern !== 'solid', strokePattern, roughness,
  }
}

function worldPoints(element: Json, minimum = 2, maximum = 100000): { x: number; y: number }[] {
  if (!Array.isArray(element.points) || element.points.length < minimum || element.points.length > maximum) throw new Error('白板 JSON 线条缺少有效的 points 数据。')
  const x = finite(element.x); const y = finite(element.y)
  return element.points.map(point => {
    if (!Array.isArray(point) || point.length < 2) throw new Error('白板 JSON 线条坐标格式不正确。')
    return { x: finite(point[0]) + x, y: finite(point[1]) + y }
  })
}

/** Basic structural import, without executing embedded content or loading remote assets. */
export function importBoardJson(text: string): ImportedScene {
  if (text.length > 20 * 1024 * 1024) throw new Error('白板 JSON 文件过大，最多支持 20 MB。')
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error('白板 JSON 格式不正确。') }
  if (!isObject(data) || data.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('文件不是有效的白板 JSON 场景。')
  // The interchange format stores bound text separately; merge it into its container here.
  if (data.elements.length > 10000) throw new Error('文件元素过多；单页最多支持 5000 个转换后的图形。')
  const warnings = new Set<string>()
  if (data.version !== undefined && data.version !== 1 && data.version !== 2) warnings.add('文件使用较新的白板 JSON 版本，部分特性可能无法转换。')
  const source = data.elements.filter((element): element is Json => {
    if (!isObject(element)) throw new Error('白板 JSON 元素格式不正确。')
    return element.isDeleted !== true
  })
  const sourceMap = new Map<string, Json>()
  for (const element of source) {
    if (typeof element.id !== 'string' || !element.id || sourceMap.has(element.id)) throw new Error('白板 JSON 元素缺少 ID 或存在重复 ID。')
    sourceMap.set(element.id, element)
  }
  const elements: SceneElement[] = []
  const mapped = new Map<string, SceneElement>()
  const pendingLabels: Json[] = []
  const files = isObject(data.files) ? data.files : {}
  let strokePoints = 0
  for (const element of source) {
    const id = element.id as string
    const kind = element.type
    const supported = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw', 'image', 'stickynote', 'frame']
    if (typeof kind !== 'string' || !supported.includes(kind)) { warnings.add(`元素类型“${typeof kind === 'string' ? kind.slice(0, 80) : '未知'}”暂不支持，已跳过。`); continue }
    const native = isObject(element.customData) && isObject(element.customData.openWorkflow) ? element.customData.openWorkflow : undefined
    if (kind === 'text' && typeof native?.braceLabelFor === 'string') {
      const parent = sourceMap.get(native.braceLabelFor), parentData = isObject(parent?.customData) && isObject(parent.customData.openWorkflow) ? parent.customData.openWorkflow : undefined
      if (isBraceShape(parentData?.shape) && parentData?.type === 'brace') { pendingLabels.push({ ...element, containerId: native.braceLabelFor, nativeBraceLabel: true }); continue }
    }
    if (kind === 'text' && typeof element.containerId === 'string') {
      const parent = sourceMap.get(element.containerId)
      if (parent && ['rectangle', 'ellipse', 'diamond', 'stickynote', 'image', 'arrow', 'line', 'frame'].includes(String(parent.type))) { pendingLabels.push(element); continue }
    }
    const style = styleOf(element, warnings)
    const locked = element.locked === true
    const groupIds = Array.isArray(element.groupIds) ? element.groupIds.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 512) : []
    let result: SceneElement
    if (native?.type === 'brace' && isBraceShape(native.shape)) {
      const bounds = isObject(native.bounds) ? native.bounds : element
      style.fill = 'none'
      result = { id, type: 'shape', shape: native.shape, x: finite(bounds.x), y: finite(bounds.y), width: Math.max(1, finite(bounds.width, 160)), height: Math.max(1, finite(bounds.height, 180)), text: safeText(native.text), style: { ...style, fontSize: Math.max(1, Math.min(500, finite(native.fontSize, DEFAULT_STYLE.fontSize))), textAlign: native.textAlign === 'left' || native.textAlign === 'right' ? native.textAlign : 'center' }, locked }
      warnings.add('大括弧通过本软件元数据恢复；外部软件仅显示普通笔迹与独立文字，可能无法保留括弧编辑与绑定语义。')
    } else if (kind === 'freedraw' || native?.type === 'stroke') {
      const points = worldPoints(element, native?.closed === true ? 3 : 1, native?.closed === true ? 100001 : 100000)
      if (native?.closed === true && points.length > 3 && points[0]!.x === points.at(-1)!.x && points[0]!.y === points.at(-1)!.y) points.pop()
      if ((strokePoints += points.length) > 100000) throw new Error('笔迹总点数超过 100000。')
      const importedPressures = Array.isArray(element.pressures) && element.pressures.length ? element.pressures : undefined
      const metadata = readBrushData(native?.brush, native?.pressures ?? importedPressures, points.length)
      if (native?.brush !== undefined) warnings.add('笔触通过本软件元数据恢复；外部软件可能以普通笔迹显示，纹理、扁头和彩虹效果以原生文件或图像导出为准。')
      result = { id, type: 'stroke', points, style, locked, ...metadata, ...(native?.closed === true ? { closed: true } : {}) }
    } else if (kind === 'arrow' || kind === 'line') {
      const points = worldPoints(element)
      if (points.length > 2 && element.elbowed !== true) warnings.add('折线与曲线已简化为两端点连线。')
      let from: Endpoint = points[0]!; let to: Endpoint = points.at(-1)!
      if (isObject(element.startBinding) && typeof element.startBinding.elementId === 'string') from = { ...from, nodeId: element.startBinding.elementId }
      if (isObject(element.endBinding) && typeof element.endBinding.elementId === 'string') to = { ...to, nodeId: element.endBinding.elementId }
      const start = element.startArrowhead != null
      const end = element.endArrowhead != null || (kind === 'arrow' && element.endArrowhead === undefined)
      if ((start && !['arrow', 'triangle'].includes(String(element.startArrowhead))) || (end && element.endArrowhead && !['arrow', 'triangle'].includes(String(element.endArrowhead)))) warnings.add('特殊箭头端点已简化为普通箭头。')
      if (start && !end) [from, to] = [to, from]
      result = { id, type: 'edge', from, to, label: '', arrow: start && end ? 'both' : start || end ? 'end' : 'none', route: element.elbowed === true ? 'orthogonal' : 'straight', style, locked }
    } else {
      let shape: ShapeElement['shape'] = kind === 'stickynote' ? 'note' : kind as ShapeElement['shape']
      let imageData: string | undefined
      if (kind === 'image') {
        const file = typeof element.fileId === 'string' ? files[element.fileId] : undefined
        if (isObject(file) && safeImage(file.dataURL)) imageData = file.dataURL
        else { shape = 'rectangle'; warnings.add('缺失图片、外部图片或 SVG 图片已替换为占位矩形；仅支持内嵌 PNG/JPEG/WebP。') }
        if (element.crop || (Array.isArray(element.scale) && element.scale.some(value => value !== 1))) warnings.add('图片裁剪和翻转效果不保留。')
      }
      if (shape === 'text') { style.fill = 'transparent'; style.stroke = color(element.strokeColor, DEFAULT_STYLE.stroke, warnings) }
      if (kind === 'rectangle' && typeof native?.shape === 'string' && ['note', 'triangle', 'hexagon', 'star', 'parallelogram', 'cylinder', 'cloud', 'frame'].includes(native.shape)) shape = native.shape as ShapeElement['shape']
      if (shape === 'frame') { style.fill = 'none'; warnings.add('frame 已转换为可编辑分区框架，裁剪关系不保留。') }
      result = { id, type: 'shape', shape, x: finite(element.x), y: finite(element.y), width: Math.max(1, finite(element.width, 120)), height: Math.max(1, finite(element.height, 70)), text: shape === 'text' ? safeText(element.text) : shape === 'frame' ? safeText(element.name) : '', style, locked, ...(imageData ? { imageData } : {}) }
    }
    if (groupIds.length) result.groupId = groupIds.at(-1)
    elements.push(result); mapped.set(id, result)
  }
  for (const label of pendingLabels) {
    const parent = mapped.get(label.containerId as string)
    if (!parent || parent.type === 'stroke') continue
    styleOf(label, warnings)
    const value = safeText(label.text)
    if (parent.type === 'shape') parent.text = label.nativeBraceLabel === true ? value : parent.text ? `${parent.text}\n${value}` : value
    else parent.label = parent.label ? `${parent.label}\n${value}` : value
    parent.style.fontSize = Math.max(1, Math.min(500, finite(label.fontSize, DEFAULT_STYLE.fontSize)))
    parent.style.textAlign = label.textAlign === 'left' || label.textAlign === 'right' ? label.textAlign : 'center'
  }
  for (const element of elements) {
    if (element.type !== 'edge') continue
    for (const endpoint of [element.from, element.to]) {
      if (endpoint.nodeId && mapped.get(endpoint.nodeId)?.type !== 'shape') { delete endpoint.nodeId; warnings.add('部分连线绑定的图形不存在或不受支持，已保留为自由端点。') }
    }
  }
  if (elements.length > 5000) throw new Error('单页最多支持 5000 个转换后的图形。')
  const appState = isObject(data.appState) ? data.appState : {}
  const native = isObject(data.openWorkflow) ? data.openWorkflow : undefined
  const defaultStyle = native?.defaultStyle ? validateElementStyle(native.defaultStyle) : undefined
  return { title: typeof appState.name === 'string' && appState.name ? appState.name : '导入白板', scene: { elements, background: color(appState.viewBackgroundColor, '#ffffff', warnings), grid: typeof appState.gridSize === 'number' && appState.gridSize > 0, ...(defaultStyle ? { defaultStyle } : {}) }, warnings: [...warnings] }
}

/** Export editable board JSON with embedded image files. */
export function exportBoardJson(scene: Scene): string {
  const elements: Json[] = []
  const files: Record<string, Json> = Object.create(null)
  const updated = Date.now()
  const takenIds = new Set(scene.elements.map(element => element.id))
  function labelId(id: string): string { let result = `${id}__label`; while (takenIds.has(result)) result += '_'; takenIds.add(result); return result }
  function base(element: SceneElement): Json {
    return { id: element.id, angle: 0, strokeColor: element.style.stroke, backgroundColor: element.style.fill, fillStyle: 'solid', strokeWidth: element.style.strokeWidth, strokeStyle: resolveStrokePattern(element.style), roughness: element.style.roughness === 'sketch' ? 1 : 0, opacity: element.style.opacity * 100, groupIds: element.groupId ? [element.groupId] : [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 0, isDeleted: false, boundElements: [], updated, link: null, locked: element.locked }
  }
  function textElement(id: string, value: string, x: number, y: number, width: number, height: number, element: SceneElement, containerId: string | null): Json {
    return { ...base(element), id, type: 'text', x, y, width, height, text: value, originalText: value, fontSize: element.style.fontSize, fontFamily: 2, textAlign: element.style.textAlign, verticalAlign: containerId ? 'middle' : 'top', containerId, autoResize: false, lineHeight: 1.25, backgroundColor: 'transparent' }
  }
  const bindings = new Map<string, { id: string; type: string }[]>()
  for (const element of scene.elements) if (element.type === 'edge') for (const endpoint of [element.from, element.to]) if (endpoint.nodeId) { const list = bindings.get(endpoint.nodeId) || []; if (!list.some(item => item.id === element.id)) list.push({ id: element.id, type: 'arrow' }); bindings.set(endpoint.nodeId, list) }
  for (const element of scene.elements) {
    const result = base(element)
    if (element.type === 'shape') {
      if (isBraceShape(element.shape)) {
        const points = shapeOutline(element), bounds = elementBounds({ ...element, type: 'stroke', points })
        Object.assign(result, { type: 'freedraw', x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, points: points.map(point => [point.x - bounds.x, point.y - bounds.y]), backgroundColor: 'transparent', pressures: [], simulatePressure: true, lastCommittedPoint: null, customData: { openWorkflow: { type: 'brace', shape: element.shape, bounds: { x: element.x, y: element.y, width: element.width, height: element.height }, text: element.text, fontSize: element.style.fontSize, textAlign: element.style.textAlign, compatibility: '外部软件显示为普通笔迹与独立文字；括弧编辑与绑定语义依赖本软件元数据' } } })
        elements.push(result)
        if (element.text) {
          const label = braceTextBounds(element), id = labelId(element.id)
          elements.push({ ...textElement(id, element.text, label.x, label.y, label.width, label.height, element, null), verticalAlign: 'middle', customData: { openWorkflow: { braceLabelFor: element.id } } })
        }
        continue
      }
      if (element.shape === 'text') { elements.push(textElement(element.id, element.text, element.x, element.y, element.width, element.height, element, null)); continue }
      Object.assign(result, { type: ['rectangle', 'ellipse', 'diamond', 'image', 'frame'].includes(element.shape) ? element.shape : 'rectangle', x: element.x, y: element.y, width: element.width, height: element.height, boundElements: [...(bindings.get(element.id) || [])] })
      if (!['rectangle', 'ellipse', 'diamond', 'image', 'frame'].includes(element.shape)) result.customData = { openWorkflow: { shape: element.shape } }
      if (element.shape === 'frame') Object.assign(result, { name: element.text })
      if (element.shape === 'image') {
        if (!safeImage(element.imageData)) throw new Error('导出图片必须为内嵌 PNG/JPEG/WebP。')
        const fileId = `image-${element.id}`
        files[fileId] = { id: fileId, mimeType: element.imageData.slice(5, element.imageData.indexOf(';')), dataURL: element.imageData, created: updated, lastRetrieved: updated }
        Object.assign(result, { fileId, status: 'saved', scale: [1, 1], crop: null })
      }
      elements.push(result)
      if (element.text && element.shape !== 'frame') {
        const id = labelId(element.id)
        ;(result.boundElements as Json[]).push({ id, type: 'text' })
        elements.push(textElement(id, element.text, element.x + 8, element.y + 8, Math.max(1, element.width - 16), Math.max(1, element.height - 16), element, element.id))
      }
    } else if (element.type === 'stroke') {
      if (!element.points.length) throw new Error('笔迹没有坐标，无法导出。')
      const { x, y, width, height } = elementBounds(element)
      const metadata = readBrushData(element.brush, element.pressures, element.points.length)
      Object.assign(result, { type: element.closed ? 'line' : 'freedraw', customData: { openWorkflow: { type: 'stroke', ...metadata, ...(element.closed ? { closed: true } : {}), ...(element.brush ? { compatibility: '外部软件可能显示为普通笔迹；纹理、扁头和彩虹效果依赖本软件元数据，完整外观请使用原生文件或图像导出' } : {}) } }, x, y, width, height, points: [...element.points, ...(element.closed ? [element.points[0]!] : [])].map(point => [point.x - x, point.y - y]), startArrowhead: null, endArrowhead: null, pressures: element.pressures ? [...element.pressures, ...(element.closed ? [element.pressures[0]!] : [])] : [], simulatePressure: !element.pressures, lastCommittedPoint: null })
      elements.push(result)
    } else {
      const world = edgePoints(element, scene)
      const x = world[0]!.x; const y = world[0]!.y
      const last = world.at(-1)!
      const points = world.map(point => [point.x - x, point.y - y])
      const binding = (endpoint: Endpoint): Json | null => endpoint.nodeId ? { elementId: endpoint.nodeId, focus: 0, gap: 0, fixedPoint: null } : null
      Object.assign(result, { type: 'arrow', x, y, width: Math.max(...world.map(point => point.x)) - Math.min(...world.map(point => point.x)), height: Math.max(...world.map(point => point.y)) - Math.min(...world.map(point => point.y)), points, startBinding: binding(element.from), endBinding: binding(element.to), startArrowhead: element.arrow === 'both' ? 'arrow' : null, endArrowhead: element.arrow === 'none' ? null : 'arrow', elbowed: element.route === 'orthogonal', lastCommittedPoint: null })
      elements.push(result)
      if (element.label) {
        const id = labelId(element.id)
        ;(result.boundElements as Json[]).push({ id, type: 'text' })
        elements.push(textElement(id, element.label, (x + last.x) / 2 - 60, (y + last.y) / 2 - 12, 120, Math.max(24, element.style.fontSize * 1.25), element, element.id))
      }
    }
  }
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'https://github.com/ecojust/open-office', elements, appState: { viewBackgroundColor: scene.background, gridSize: scene.grid ? 20 : null }, files, ...(scene.defaultStyle ? { openWorkflow: { defaultStyle: sceneDefaultStyle(scene) } } : {}) }, null, 2)
}
