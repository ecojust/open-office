import { callPdfBackend } from './backend'
export { appendHistory } from './resources'

export type PdfPoint = [number, number]
export type PdfRect = [number, number, number, number]
export type PdfColor = [number, number, number]
export interface PdfPageInfo {
  index: number
  width: number
  height: number
  rotation: number
  mediaBox?: PdfRect
  cropBox?: PdfRect
}
export interface PdfTextBlock {
  id: string
  pageIndex: number
  text: string
  bbox: PdfRect
  font: string
  fontSize: number
  color: number | PdfColor
}
export interface PdfMetadata {
  pageCount: number
  pages: PdfPageInfo[]
  encrypted?: boolean
  needsPassword?: boolean
  signed?: boolean
  hasSignatures?: boolean
  outline?: { level: number; title: string; pageIndex: number | null }[]
  permissions?: Record<string, boolean> | number
  [key: string]: unknown
}
export interface PdfResponse {
  protocolVersion: 1
  requestId: string
  ok: boolean
  base64?: string
  metadata?: PdfMetadata
  textBlocks?: PdfTextBlock[]
  warnings?: string[]
  error?: { code: string; message: string; details?: unknown }
}
export class PdfOperationError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PdfOperationError'
    this.code = code
  }
}

/** The native bridge owns the Python process. No HTTP service or remote PDF upload. */
export async function requestPdf(
  operation: string,
  documentBase64: string,
  options: Record<string, unknown> = {},
  password?: string,
): Promise<PdfResponse> {
  const requestId = crypto.randomUUID()
  const response = await callPdfBackend({ protocolVersion: 1, requestId, operation, documentBase64, password, options })
  if (!response || response.protocolVersion !== 1 || response.requestId !== requestId) {
    throw new PdfOperationError('PROTOCOL_ERROR', 'PDF 引擎返回的请求标识不一致，请重新打开文件。')
  }
  if (!response.ok) {
    throw new PdfOperationError(response.error?.code ?? 'PDF_ERROR', response.error?.message ?? 'PDF 操作未完成。')
  }
  return response
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** PDF.js's viewBox handles CropBox offsets; PyMuPDF uses an unrotated, top-left origin. */
export function pointToDocument(
  point: PdfPoint,
  viewport: { convertToPdfPoint(x: number, y: number): number[]; viewBox: number[] },
): PdfPoint {
  const [x = 0, y = 0] = viewport.convertToPdfPoint(point[0], point[1])
  return [x - (viewport.viewBox[0] ?? 0), (viewport.viewBox[3] ?? 0) - y]
}

export function rectToViewport(
  rect: PdfRect,
  viewport: { convertToViewportPoint(x: number, y: number): number[]; viewBox: number[] },
): { left: number; top: number; width: number; height: number } {
  const [x0, y0] = viewport.convertToViewportPoint(rect[0] + (viewport.viewBox[0] ?? 0), (viewport.viewBox[3] ?? 0) - rect[3])
  const [x1, y1] = viewport.convertToViewportPoint(rect[2] + (viewport.viewBox[0] ?? 0), (viewport.viewBox[3] ?? 0) - rect[1])
  return { left: Math.min(x0!, x1!), top: Math.min(y0!, y1!), width: Math.abs(x1! - x0!), height: Math.abs(y1! - y0!) }
}

export function orderedRect(start: PdfPoint, end: PdfPoint): PdfRect {
  return [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])]
}

export function colorToRgb(color: string): PdfColor {
  return [1, 3, 5].map(start => Number.parseInt(color.slice(start, start + 2), 16) / 255) as PdfColor
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '操作没有完成，请稍后重试。'
}

/** Move selected pages as a block, preserving relative order and the complete permutation. */
export function movePages(pageCount: number, selected: number[], direction: -1 | 1): number[] {
  const order = Array.from({ length: pageCount }, (_, index) => index)
  const selectedSet = new Set(selected)
  if (direction === -1) {
    for (let index = 1; index < order.length; index++) {
      if (selectedSet.has(order[index]!) && !selectedSet.has(order[index - 1]!)) {
        ;[order[index - 1], order[index]] = [order[index]!, order[index - 1]!]
      }
    }
  } else {
    for (let index = order.length - 2; index >= 0; index--) {
      if (selectedSet.has(order[index]!) && !selectedSet.has(order[index + 1]!)) {
        ;[order[index + 1], order[index]] = [order[index]!, order[index + 1]!]
      }
    }
  }
  return order
}
