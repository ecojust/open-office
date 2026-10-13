export type PresentationShapeType = 'text' | 'rectangle' | 'ellipse' | 'line' | 'image' | 'table' | 'chart' | 'group' | 'custom' | 'unknown'
export interface PresentationTextStyle {
  fontName: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
  align: 'left' | 'center' | 'right' | 'justify'
}
export interface PresentationGeometry { x: number; y: number; width: number; height: number; rotation: number }
export interface PresentationShape extends PresentationGeometry {
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
  | { type: 'update-object'; id: string; text?: string; textStyle?: Partial<PresentationTextStyle>; fillColor?: string | null; lineColor?: string; lineWidth?: number } & Partial<PresentationGeometry>
  | { type: 'arrange-objects'; ids: string[]; operation: PresentationArrangeOperation }
  | { type: 'select-objects'; ids: string[] }
)
export const PRESENTATION_LAYOUTS = [
  { value: 0, label: '标题页' }, { value: 1, label: '标题与内容' }, { value: 3, label: '标题与双栏' },
  { value: 19, label: '仅标题' }, { value: 20, label: '空白' }, { value: 32, label: '居中文字' },
] as const
