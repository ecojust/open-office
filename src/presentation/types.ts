import type { SmartArtTextAction } from './core/smartart-text'
export type PresentationShapeType = 'text' | 'rectangle' | 'ellipse' | 'line' | 'image' | 'table' | 'chart' | 'group' | 'custom' | 'unknown'
export type PresentationDecoration = 'none' | 'single' | 'double'
export interface PresentationTextStyle {
  fontName: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  /** Legacy underline commands normalize to single/none. */
  underlineStyle?: PresentationDecoration
  strike?: PresentationDecoration
  color: string
  /** Ordinary text paint alpha; undefined is fully opaque. */
  opacity?: number
  /** Independent text-marker paint. Null explicitly clears inherited highlight. */
  highlightColor?: string | null
  highlightOpacity?: number
  align: 'left' | 'center' | 'right' | 'justify'
}
export interface PresentationSpacing { unit: 'percent' | 'points'; value: number }
export interface PresentationParagraphStyle {
  align?: PresentationTextStyle['align']
  lineSpacing?: PresentationSpacing
  spaceBefore?: PresentationSpacing
  spaceAfter?: PresentationSpacing
}
export interface PresentationTextLayout {
  verticalAlign?: 'top' | 'middle' | 'bottom'
  insets?: { left: number; right: number; top: number; bottom: number }
  wrap?: boolean
  rotation?: number
}
export type PresentationTextLayoutPatch = Omit<PresentationTextLayout, 'insets'> & { insets?: Partial<NonNullable<PresentationTextLayout['insets']>> }
export interface PresentationGeometry { x: number; y: number; width: number; height: number; rotation: number }
export interface PresentationShape extends PresentationGeometry {
  fillOpacity?: number
  lineOpacity?: number
  id: string
  name: string
  type: PresentationShapeType
  text: string
  textTruncated?: boolean
  fillColor: string | null
  lineColor: string | null
  lineWidth: number
  zIndex: number
  textStyle: PresentationTextStyle
  capabilities: { text: boolean; fill: boolean; line: boolean; geometry: boolean }
}
export interface PresentationPage { id: string; index: number; name: string; title: string; hidden: boolean; layout: number }
export interface PresentationState {
  documentId: string
  revision: number
  dirty: boolean
  pageCount: number
  currentPageIndex: number
  pageSize: { width: number; height: number }
  pages: PresentationPage[]
  currentPage: PresentationPage & { background: { type: 'none' | 'solid' | 'other'; color?: string }; notes: string }
  objects: PresentationShape[]
  selectedObjectIds: string[]
}
export type PresentationArrangeOperation = 'front' | 'back' | 'forward' | 'backward' | 'align-left' | 'align-center' | 'align-right' | 'align-top' | 'align-middle' | 'align-bottom' | 'distribute-horizontal' | 'distribute-vertical' | 'group' | 'ungroup'
export type PresentationChartType = 'column' | 'bar' | 'line' | 'pie'
export interface PresentationTableData { id: string; rows: number; columns: number; cells: string[][] }
export interface PresentationChartData { id: string; type: PresentationChartType; categories: string[]; series: string[]; values: number[][]; title: string }
export type PresentationObjectData = PresentationTableData | PresentationChartData
export interface PresentationObjectQuery { type: 'table' | 'chart'; id: string }
type Revision = { expectedRevision?: number }
export type PresentationAction = Revision & (
  | SmartArtTextAction
  | { type: 'select-page'; pageIndex: number }
  | { type: 'add-page'; layout?: number }
  | { type: 'duplicate-page' | 'delete-page'; pageIndex: number }
  | { type: 'move-page'; pageIndex: number; direction: 'up' | 'down' }
  | { type: 'set-hidden'; pageIndex: number; value: boolean }
  | { type: 'rename-page'; pageIndex: number; name: string }
  | { type: 'set-layout'; pageIndex: number; layout: number }
  | { type: 'set-background'; pageIndex: number; color: string | null }
  | { type: 'set-notes'; pageIndex: number; text: string }
  | { type: 'set-page-size'; width: number; height: number }
  | { type: 'insert-text'; text: string; textStyle?: Partial<PresentationTextStyle> } & Partial<PresentationGeometry>
  | { type: 'insert-shape'; shapeType: 'rectangle' | 'ellipse' | 'line'; fillColor?: string | null; lineColor?: string; lineWidth?: number } & Partial<PresentationGeometry>
  | { type: 'insert-table'; rows: number; columns: number; cells?: string[][] } & Partial<PresentationGeometry>
  | { type: 'update-table'; id: string; cells: string[][] }
  | { type: 'insert-chart'; chartType: PresentationChartType; categories: string[]; series: string[]; values: number[][]; title?: string } & Partial<PresentationGeometry>
  | { type: 'update-chart'; id: string; chartType: PresentationChartType; categories: string[]; series: string[]; values: number[][]; title?: string }
  | { type: 'delete-objects'; ids: string[] }
  | { type: 'update-object'; id: string; text?: string; textStyle?: Partial<PresentationTextStyle>; fillColor?: string | null; lineColor?: string; lineWidth?: number; fillOpacity?: number; lineOpacity?: number } & Partial<PresentationGeometry>
  | { type: 'format-paragraphs'; id: string; paragraphIndices: number[]; paragraphStyle: PresentationParagraphStyle; spaceFirstLastParagraph?: boolean; expectedText: string; expectedRevision: number }
  | { type: 'set-text-layout'; id: string; layout: PresentationTextLayoutPatch }
  | { type: 'format-text-range'; id: string; start: number; end: number; expectedText: string; expectedRevision: number; textStyle: Partial<Pick<PresentationTextStyle, 'fontName' | 'fontSize' | 'color' | 'opacity' | 'highlightColor' | 'highlightOpacity' | 'bold' | 'italic' | 'underline' | 'underlineStyle' | 'strike'>> }
  | { type: 'arrange-objects'; ids: string[]; operation: PresentationArrangeOperation }
  | { type: 'select-objects'; ids: string[] }
)
export const PRESENTATION_LAYOUTS = [
  { value: 0, label: '标题页' }, { value: 1, label: '标题与内容' }, { value: 3, label: '标题与双栏' },
  { value: 19, label: '仅标题' }, { value: 20, label: '空白' }, { value: 32, label: '居中文字' },
] as const
