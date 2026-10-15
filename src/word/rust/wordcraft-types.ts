/** Host state only. WordCraft owns the document model, layout and editing. */
export type WordcraftSnapshot = {
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
export type WordcraftFileAction = 'new' | 'open' | 'save' | 'saveAs' | 'exportPdf' | 'print' | 'close'
export type WordcraftEvent =
  | { type: 'state'; sessionId: string; snapshot: WordcraftSnapshot }
  | { type: 'file-action'; sessionId: string; action: WordcraftFileAction }
  | { type: 'pick-file'; sessionId: string; purpose: string; documentId: number; revision: number; selection: unknown }
  | { type: 'error' | 'status'; sessionId: string; message: string }
