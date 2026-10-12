export type OfficeKind = 'word' | 'sheet'
export type OfficeFormat = 'docx' | 'odt' | 'xlsx' | 'ods' | 'pdf'
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
export interface OfficeExportResult { base64: string; extension: OfficeFormat; name: string; revision: number }
export type OfficeNativeRequest = { type: 'save' | 'save-as' | 'open' | 'new' | 'export-pdf' | 'print' | 'insert-image' | 'close' }
export interface OfficeEvent {
  channel: 'open-office-engine'
  session: string
  event?: 'engine-ready' | 'progress' | 'dirty' | 'error' | 'native-request'
  requestId?: string
  documentId?: string
  ok?: boolean
  data?: any
  error?: string
}
