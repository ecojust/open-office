export interface WriterSelection {
  id: string
  text: string
  truncated: boolean
  collapsed: boolean
  tableName: string | null
  cellName: string | null
}
export interface WriterTextStyle {
  fontName: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
  highlight: string | null
}
export interface WriterParagraph {
  styleName: string
  align: 'left' | 'center' | 'right' | 'justify'
  outlineLevel: number
  leftIndent: number
  rightIndent: number
  firstLineIndent: number
  spaceAbove: number
  spaceBelow: number
  lineSpacingPercent: number
}
export interface WriterPage {
  styleName: string
  width: number
  height: number
  landscape: boolean
  marginLeft: number
  marginRight: number
  marginTop: number
  marginBottom: number
  headerEnabled: boolean
  footerEnabled: boolean
  headerText: string
  footerText: string
  headerTruncated: boolean
  footerTruncated: boolean
}
export interface WriterTable { name: string; rows: number; columns: number }
export interface WriterOutlineItem { id: string; text: string; level: number }
export interface WriterComment { index: number; author: string; text: string }
export interface WriterState {
  documentId: string
  revision: number
  dirty: boolean
  selection: WriterSelection
  textStyle: WriterTextStyle
  paragraph: WriterParagraph
  styles: { name: string; label: string }[]
  outline: WriterOutlineItem[]
  outlineTruncated: boolean
  tables: WriterTable[]
  page: WriterPage
  review: { recordChanges: boolean; showChanges: boolean; changeCount: number; comments: WriterComment[]; footnoteCount: number; indexCount: number }
  message: string
}
export interface WriterTableData { name: string; tableId: string; rows: number; columns: number; cells: string[][]; cellSignatures: string[][]; documentId?: string; revision?: number }
type Guard = { expectedRevision?: number; expectedSelectionId?: string }
export type WriterAction = Guard & (
  | { type: 'insert-text'; text: string; replaceSelection?: boolean }
  | { type: 'format-text' } & Partial<WriterTextStyle>
  | { type: 'format-paragraph' } & Partial<Omit<WriterParagraph, 'styleName'>>
  | { type: 'apply-style'; name: string }
  | { type: 'insert-table'; rows: number; columns: number; cells?: string[][] }
  | { type: 'update-table'; name: string; cells: string[][]; expectedTableId?: string; expectedCells?: string[][]; expectedCellSignatures?: string[][] }
  | { type: 'set-page' } & Partial<Omit<WriterPage, 'styleName' | 'headerEnabled' | 'footerEnabled' | 'headerText' | 'footerText' | 'headerTruncated' | 'footerTruncated'>>
  | { type: 'set-header-footer'; target: 'header' | 'footer'; enabled: boolean; text?: string; confirmRemoval?: boolean }
  | { type: 'insert-page-number'; target: 'header' | 'footer' | 'selection'; align?: 'left' | 'center' | 'right' }
  | { type: 'insert-break'; kind: 'page' | 'paragraph' | 'line' }
  | { type: 'find-replace'; search: string; replace?: string; all?: boolean; matchCase?: boolean; wholeWords?: boolean }
  | { type: 'goto-outline'; id: string }
  | { type: 'insert-comment'; text: string; author: string }
  | { type: 'navigate-comment'; index: number }
  | { type: 'delete-comment'; index: number }
  | { type: 'set-track-changes'; enabled?: boolean; show?: boolean }
  | { type: 'review-changes'; decision: 'accept' | 'reject'; scope: 'all' | 'selection' }
  | { type: 'insert-footnote'; text: string; endnote?: boolean }
  | { type: 'insert-toc'; title?: string; levels?: number }
  | { type: 'update-indexes' }
)
export type WriterQuery = { type: 'table'; name: string }
