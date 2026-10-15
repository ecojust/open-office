export type DocumentKind = 'word' | 'sheet' | 'presentation' | 'pdf'
export type DocumentExtension = 'docx' | 'xlsx' | 'csv' | 'tsv' | 'pptx' | 'potx' | 'ppsx' | 'pdf'
/** Kept only to display previous recent-file records; opening still validates supported formats. */
export type HistoricalDocumentExtension = 'odt' | 'doc' | 'rtf' | 'ods' | 'xls' | 'odp' | 'ppt'

export interface DocumentReceipt {
  id: string
  name: string
  extension: DocumentExtension
  kind: DocumentKind
  sha256: string
  sizeBytes: number
}

export interface NativeDocument extends DocumentReceipt { base64: string }
export interface RecentDocument {
  id: string
  name: string
  extension: DocumentExtension | HistoricalDocumentExtension
  kind: DocumentKind
  lastOpenedAt: number
}

export interface SaveDocumentRequest {
  documentId?: string
  name: string
  extension: DocumentExtension
  base64: string
  expectedSha256?: string
  saveAs?: boolean
}

export type SaveResult =
  | { status: 'saved'; document: DocumentReceipt }
  | { status: 'cancelled' }
  | { status: 'conflict'; message: string }

export interface AppBootstrap {
  origin: string
  basePath: string
  platform: string
  smokeMode: boolean
  smokeScope?: 'full'
}

export interface NativeImage { name: string; base64: string; mimeType: 'image/png' | 'image/jpeg' }
