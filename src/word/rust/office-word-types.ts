/** Host state only. OfficeWord owns the document model, layout and editing. */
export type OfficeWordSnapshot = {
  sessionId: string
  revision: number
  documentId: number
  dirty: boolean
  pages: number
  canUndo?: boolean
  canRedo?: boolean
  name?: string
  selection?: unknown
  format?: unknown
  text?: string
  ui?: unknown
}
export type OfficeWordFileAction = 'new' | 'open' | 'save' | 'saveAs' | 'exportPdf' | 'print' | 'close'
export type OfficeWordEvent =
  | { type: 'state'; sessionId: string; snapshot: OfficeWordSnapshot }
  | { type: 'file-action'; sessionId: string; action: OfficeWordFileAction }
  | { type: 'pick-file'; sessionId: string; purpose: string; documentId: number; revision: number; selection: unknown }
  | { type: 'error' | 'status'; sessionId: string; message: string }
