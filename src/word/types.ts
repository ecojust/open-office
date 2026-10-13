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

// A fresh toolbar command targets the current logical cursor/page style. User
// drafts always keep WriterAction's strict expectedRevision contract instead.
export type WriterImmediateAction = WriterAction extends infer Action ? Action extends { type:
  'insert-text'|'insert-break'|'insert-table'|'format-text'|'format-paragraph'|'apply-style'|'set-page'|'set-header-footer'|'find-replace'
} ? Omit<Action, 'expectedRevision'|'expectedSelectionId'> : never : never
export type WriterCommandTarget = Pick<WriterState, 'documentId'|'revision'|'selection'|'textStyle'|'paragraph'|'page'|'tables'>
export interface WriterCommand { action: WriterImmediateAction; target: WriterCommandTarget }
export function writerCommandTarget(state: WriterState): WriterCommandTarget {
  return { documentId: state.documentId, revision: state.revision, selection: { ...state.selection }, textStyle: { ...state.textStyle },
    paragraph: { ...state.paragraph }, page: { ...state.page }, tables: state.tables.map(table => ({ ...table })) }
}
export function canIssueWriterCommand(action: WriterAction, state: WriterState): action is WriterAction & WriterImmediateAction {
  if ('expectedRevision' in action || 'expectedSelectionId' in action || state.selection.truncated) return false
  if (action.type === 'insert-text') return state.selection.collapsed && action.replaceSelection !== true
  if (action.type === 'insert-break') return state.selection.collapsed
  if (action.type === 'insert-table') return state.selection.collapsed && state.selection.tableName === null
  if (action.type === 'set-header-footer') return action.enabled && (action.target === 'header'
    ? !state.page.headerEnabled && !state.page.headerTruncated : !state.page.footerEnabled && !state.page.footerTruncated)
  return ['format-text','format-paragraph','apply-style','set-page','find-replace'].includes(action.type)
}
