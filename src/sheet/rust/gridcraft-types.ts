/** Host state only. Rust owns the workbook, calculation and editing model. */
export type GridcraftSnapshot = {
  sessionId: string
  revision: number
  documentId: number
  dirty: boolean
  canUndo?: boolean
  canRedo?: boolean
  name?: string
  selection?: unknown
  activeSheet?: number
  sheets: Array<{ name: string; index: number; hidden?: boolean }>
  ui?: unknown
  warnings?: string[]
}
export type GridcraftFileAction = 'new' | 'open' | 'save' | 'saveAs' | 'exportPdf' | 'print' | 'close'
export type GridcraftEvent =
  | { type: 'state'; sessionId: string; snapshot: GridcraftSnapshot }
  | { type: 'file-action'; sessionId: string; action: GridcraftFileAction }
  | { type: 'pick-file'; sessionId: string; purpose: string; documentId: number; revision: number; selection: unknown }
  | { type: 'error' | 'status'; sessionId: string; message: string }
