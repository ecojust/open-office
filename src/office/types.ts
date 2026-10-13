export type OfficeKind = 'word' | 'sheet' | 'presentation'
export type OfficeFormat = 'docx' | 'odt' | 'xlsx' | 'ods' | 'pptx' | 'odp' | 'pdf'
export interface OfficeDocument {
  id: string
  name: string
  kind: OfficeKind
  extension: string
  base64: string
  sha256: string
  sizeBytes: number
}
export interface OfficeExportRequest { format?: OfficeFormat }
export interface OfficeExportResult { base64: string; extension: OfficeFormat; name: string; revision: number; dirty: boolean }
export type OfficeNativeRequest = { type: 'save' | 'save-as' | 'open' | 'new' | 'export-pdf' | 'print' | 'insert-image' | 'close' | 'quit' | 'presentation-preview' | 'presentation-duplicate'; notice?: string; pageIndex?: number }
export interface OfficeEvent {
  channel: 'open-office-engine'
  session: string
  event?: 'engine-ready' | 'progress' | 'dirty' | 'error' | 'native-request' | 'presentation-changed'
  requestId?: string
  documentId?: string
  ok?: boolean
  data?: any
  error?: string
}
