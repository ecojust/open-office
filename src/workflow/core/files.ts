import { createDocument, MAX_FILE_BYTES, parseDocument, serializeDocument, validateScene } from './documents.ts'
import { compileCodeDiagram } from './code-diagram.ts'
import { applyDiagramStyle } from './diagram-appearance.ts'
import { sceneToSvg } from './svg.ts'
import { importGraphXml, exportGraphXml } from '../formats/graph-xml.ts'
import { importBoardJson, exportBoardJson } from '../formats/board-json.ts'
import type { Scene, WorkflowDocument } from './types.ts'

export interface ImportResult { documents: WorkflowDocument[]; warnings: string[]; nativeFormat: boolean }
export type ExportFormat = 'svg' | 'png' | 'drawio' | 'excalidraw' | 'mmd' | 'original'
export const fileAccept = '.owflow,.json,.drawio,.xml,.excalidraw,.mmd,.mermaid,text/plain,application/json,text/xml,application/xml'
export function fileStem(name: string): string { return name.replace(/\.(owflow|json|drawio|xml|excalidraw|mmd|mermaid)$/i, '').slice(0, 200) || '未命名' }
export function safeFilename(name: string): string { return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').slice(0, 160) || '未命名' }
function saveableImport(result: ImportResult): ImportResult {
  // Conversion plus preserved source can exceed the input size. Reject atomically
  // before callers add tabs or replace an existing document.
  for (const document of result.documents) serializeDocument(document)
  return result
}
export function importText(name: string, text: string): ImportResult {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error('文件超过 50 MB。')
  const clean = text.replace(/^\uFEFF/, '').trim()
  if (/\.(mmd|mermaid)$/i.test(name) || /^(?:%%[^\n]*\n\s*)*(?:flowchart|graph|sequenceDiagram)\b/.test(clean)) {
    const doc = createDocument('mermaid')
    doc.title = fileStem(name); doc.source = text
    if (text.length > 500000) throw new Error('图表源码超过 500000 字符。')
    doc.importSource = { name, format: 'mermaid', text }
    return saveableImport({ documents: [doc], warnings: [], nativeFormat: false })
  }
  if (clean.startsWith('<')) {
    const pages = importGraphXml(clean)
    return saveableImport({ documents: pages.map(page => {
      const doc = createDocument('flow')
      doc.title = pages.length > 1 ? `${fileStem(name)} · ${page.title}`.slice(0, 200) : fileStem(name)
      doc.scene = validateScene(page.scene)
      doc.importSource = { name, format: 'drawio', text }
      return doc
    }), warnings: [...new Set(pages.flatMap(page => page.warnings))], nativeFormat: false })
  }
  let json: Record<string, unknown>
  try { json = JSON.parse(clean) } catch { throw new Error('无法识别此文件。请选择工作流文件、图形 XML、白板 JSON 或图表源码。') }
  if (json?.format === 'open-workflow') return saveableImport({ documents: [parseDocument(clean)], warnings: [], nativeFormat: true })
  if (json?.type === 'excalidraw') {
    const imported = importBoardJson(clean)
    const doc = createDocument('board')
    doc.title = fileStem(name); doc.scene = validateScene(imported.scene)
    doc.importSource = { name, format: 'excalidraw', text }
    return saveableImport({ documents: [doc], warnings: imported.warnings, nativeFormat: false })
  }
  throw new Error('JSON 文件格式不受支持。')
}
export function documentScene(doc: WorkflowDocument): Scene {
  return doc.kind === 'mermaid' ? applyDiagramStyle(compileCodeDiagram(doc.source).scene, doc.diagramStyle) : doc.scene
}
export function documentBytes(doc: WorkflowDocument): Uint8Array { return new TextEncoder().encode(serializeDocument(doc)) }
export async function exportDocument(doc: WorkflowDocument, format: ExportFormat): Promise<{ name: string; bytes: Uint8Array; mime: string }> {
  const name = safeFilename(doc.title)
  const encode = (text: string, extension: string, mime: string) => ({ name: `${name}.${extension}`, bytes: new TextEncoder().encode(text), mime })
  if (format === 'original') {
    if (!doc.importSource) throw new Error('此文档没有保留的导入来源。')
    return { name: safeFilename(doc.importSource.name), bytes: new TextEncoder().encode(doc.importSource.text), mime: 'application/octet-stream' }
  }
  if (format === 'mmd') {
    if (doc.kind !== 'mermaid') throw new Error('仅代码图表文档可以导出为 .mmd 源码。')
    return encode(doc.source, 'mmd', 'text/plain;charset=utf-8')
  }
  const scene = documentScene(doc)
  if (format === 'drawio') return encode(exportGraphXml(scene, doc.title), 'drawio', 'application/xml')
  if (format === 'excalidraw') return encode(exportBoardJson(scene), 'excalidraw', 'application/json')
  const svg = sceneToSvg(scene, { background: true })
  if (format === 'svg') return encode(svg, 'svg', 'image/svg+xml')
  const source = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const width = Math.ceil(Number(source.getAttribute('width')) || 800)
  const height = Math.ceil(Number(source.getAttribute('height')) || 600)
  const scale = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(20000000 / (width * height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建图片画布。')
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const item = new Image(); item.onload = () => resolve(item); item.onerror = () => reject(new Error('无法生成图片，请尝试 SVG 导出。')); item.src = url
    })
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片编码失败。')), 'image/png'))
    return { name: `${name}.png`, bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' }
  } finally { URL.revokeObjectURL(url) }
}
export function downloadBytes(name: string, bytes: Uint8Array, mime = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
