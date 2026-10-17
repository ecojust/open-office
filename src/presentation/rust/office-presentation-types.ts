/** The host receives receipts and UI state; Rust owns slides, objects and layout. */
export type OfficePresentationSnapshot = {
  sessionId: string
  revision: number
  documentId: number
  dirty: boolean
  canUndo?: boolean
  canRedo?: boolean
  name?: string
  selection?: unknown
  activeSlide?: number
  slides: Array<{ id: number; index: number; name: string; hidden?: boolean }>
  ui?: unknown
  warnings?: string[]
}
export type OfficePresentationFileAction = 'new' | 'open' | 'save' | 'saveAs' | 'exportPdf' | 'print' | 'close'
export type OfficePresentationEvent =
  | { type: 'state'; sessionId: string; snapshot: OfficePresentationSnapshot }
  | { type: 'file-action'; sessionId: string; action: OfficePresentationFileAction }
  | { type: 'toggle-templates'; sessionId: string }
  | { type: 'pick-file'; sessionId: string; purpose: string; requestId?: string | number; documentId: number; revision: number; selection: unknown }
  | { type: 'error' | 'status'; sessionId: string; message: string }
