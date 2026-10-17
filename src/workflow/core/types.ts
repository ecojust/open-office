import type { DiagramStyleId } from './diagram-appearance.ts'

// These persisted kind and format values preserve compatibility with existing document files.
export type DocumentKind = 'flow' | 'board' | 'mermaid'
export interface Point { x: number; y: number }
export type BrushKind = 'pen' | 'pencil' | 'marker' | 'brush' | 'highlighter' | 'rainbow'
export interface ElementStyle {
  stroke: string
  fill: string
  strokeWidth: number
  fontSize: number
  textAlign: 'left' | 'center' | 'right'
  opacity: number
  dashed: boolean
  roughness?: 'clean' | 'sketch'
  strokePattern?: 'solid' | 'dashed' | 'dotted'
}
export interface ShapeElement {
  id: string
  type: 'shape'
  shape: 'rectangle' | 'ellipse' | 'diamond' | 'note' | 'text' | 'image' | 'triangle' | 'hexagon' | 'star' | 'parallelogram' | 'cylinder' | 'cloud' | 'frame' | 'brace-left' | 'brace-right' | 'brace-top' | 'brace-bottom'
  x: number
  y: number
  width: number
  height: number
  /** Rectangle corner radius in canvas units; omitted means square corners. */
  cornerRadius?: number
  text: string
  imageData?: string
  style: ElementStyle
  locked: boolean
  groupId?: string
}
export interface Endpoint extends Point { nodeId?: string }
export interface EdgeElement {
  id: string
  type: 'edge'
  from: Endpoint
  to: Endpoint
  label: string
  arrow: 'end' | 'both' | 'none'
  route: 'straight' | 'orthogonal'
  style: ElementStyle
  locked: boolean
  groupId?: string
}
export interface StrokeElement {
  id: string
  type: 'stroke'
  points: Point[]
  brush?: BrushKind
  pressures?: number[]
  closed?: boolean
  style: ElementStyle
  locked: boolean
  groupId?: string
}
export type SceneElement = ShapeElement | EdgeElement | StrokeElement
export interface Scene { elements: SceneElement[]; background: string; grid: boolean; defaultStyle?: ElementStyle }
export interface WorkflowDocument {
  format: 'open-workflow'
  version: 1
  id: string
  title: string
  kind: DocumentKind
  scene: Scene
  /** Source is authoritative; its generated scene is never edited in place. */
  source: string
  /** Presentation only: source remains authoritative and unchanged. */
  diagramStyle?: DiagramStyleId
  createdAt: string
  updatedAt: string
  importSource?: { name: string; format: string; text: string }
}
export interface ImportedScene { title: string; scene: Scene; warnings: string[] }
export interface EditorHandle { flush: () => void | Promise<void>; hasPendingEdits?: () => boolean }
export const DEFAULT_STYLE: ElementStyle = {
  stroke: '#334155', fill: '#ffffff', strokeWidth: 2, fontSize: 16,
  textAlign: 'center', opacity: 1, dashed: false, roughness: 'clean', strokePattern: 'solid',
}
export function newId(prefix = 'e'): string {
  if (typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`
  // Local network pages can use random bytes even when UUID helpers require HTTPS.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function emptyScene(): Scene { return { elements: [], background: '#ffffff', grid: true, defaultStyle: { ...DEFAULT_STYLE } } }
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
