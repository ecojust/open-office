export type RustWordPosition = { paragraph: number; offset: number }
export type RustWordSelection = { anchor: RustWordPosition; focus: RustWordPosition }
export type RustWordAlignment = 'left' | 'center' | 'right'
export type RustWordTextStyle = { bold: boolean; italic: boolean; fontSize: number; color: string; fontFamily: string }
export type RustWordDocument = {
  page: { width: number; height: number; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number }
  paragraphs: { runs: { text: string; style: RustWordTextStyle }[]; align: RustWordAlignment }[]
}
export type RustWordLayout = {
  pages: { width: number; height: number; paths: { d: string; fill: string }[] }[]
  caret: { page: number; x: number; y: number; height: number } | null
  selectionRects: { page: number; x: number; y: number; width: number; height: number }[]
}
export type RustWordSnapshot = {
  sessionId: string; revision: number; document: RustWordDocument; selection: RustWordSelection
  selectionText: string; layout: RustWordLayout; canUndo: boolean; canRedo: boolean; dirty: boolean
  format: { bold: boolean | null; italic: boolean | null; fontSize: number | null; color: string | null; fontFamily: string | null; align: RustWordAlignment | null }
}
export type RustWordCommand =
  | { type: 'replaceText'; text: string }
  | { type: 'deleteBackward' | 'deleteForward' | 'selectAll' | 'undo' | 'redo' | 'markSaved' }
  | { type: 'select'; selection: RustWordSelection }
  | { type: 'move'; direction: 'left' | 'right' | 'home' | 'end' | 'up' | 'down'; extend?: boolean }
  | { type: 'format'; bold?: boolean; italic?: boolean; fontSize?: number; color?: string }
  | { type: 'align'; alignment: RustWordAlignment }
  | { type: 'hitTest'; page: number; x: number; y: number; extend?: boolean }
export type RustWordRequest =
  | { op: 'create'; sessionId: string }
  | { op: 'open'; sessionId: string; base64: string }
  | { op: 'command'; sessionId: string; expectedRevision: number; command: RustWordCommand }
  | { op: 'export'; sessionId: string; expectedRevision: number }
  | { op: 'close'; sessionId: string }
export type RustWordResponse = { ok: boolean; snapshot?: RustWordSnapshot; base64?: string; error?: string }
