/** Host state only. Rust owns the workbook, calculation and editing model. */
export type OfficeSheetSnapshot = {
  sessionId: string
  revision: number
  documentId: number
  dirty: boolean
  backgroundExportReady?: boolean
  canUndo?: boolean
  canRedo?: boolean
  name?: string
  selection?: unknown
  activeSheet?: number
  sheets: Array<{ name: string; index: number; hidden?: boolean }>
  ui?: unknown
  warnings?: string[]
}
export type OfficeSheetFileAction = 'new' | 'open' | 'save' | 'saveAs' | 'exportPdf' | 'print' | 'close'
export type OfficeSheetEvent =
  | { type: 'state'; sessionId: string; snapshot: OfficeSheetSnapshot }
  | { type: 'file-action'; sessionId: string; action: OfficeSheetFileAction }
  | { type: 'pick-file'; sessionId: string; purpose: string; documentId: number; revision: number; selection: unknown }
  | { type: 'error' | 'status'; sessionId: string; message: string }
