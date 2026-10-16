/** Rust owns PDF objects, edits and layout; the shell keeps revision receipts. */
export type OfficePdfSnapshot = {
  sessionId: string
  revision: number
  documentId: number
  dirty: boolean
  backgroundExportReady?: boolean
  canUndo?: boolean
  canRedo?: boolean
  name?: string
  activePage?: number
  pages: Array<{ index: number; width?: number; height?: number; label?: string }>
  pageCount: number
  readOnly?: boolean
  ui?: unknown
  warnings?: string[]
}
export type OfficePdfFileAction = 'new' | 'open' | 'save' | 'saveAs' | 'print' | 'close'
export type OfficePdfEvent =
  | { type: 'state'; sessionId: string; snapshot: OfficePdfSnapshot }
  | { type: 'file-action'; sessionId: string; action: OfficePdfFileAction }
  | { type: 'error' | 'status'; sessionId: string; message: string }
