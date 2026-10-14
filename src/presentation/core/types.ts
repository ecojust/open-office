import type { PresentationShape, PresentationChartData, PresentationTextLayout } from '../types'
import type { RichText } from './rich-text'
import type { SmartArtTextModel } from './smartart-text'
import type { PptxTransition, PptxMedia } from '../pptx-package'
import type { TableLayout } from './table-layout'

/** Geometry is in millimetres; text sizes are points. No office runtime objects. */
export interface SlideObject extends PresentationShape {
  /** Resolved per-run display formatting; source XML is preserved separately. */
  richText?: RichText
  /** Explicit toolbar applications, including values equal to the import baseline. */
  textStyleOverrides?: Partial<PresentationShape['textStyle']>
  /** Explicit paint replacement, including choosing the current preview color. */
  fillColorOverride?: boolean
  lineColorOverride?: boolean
  /** Durable character edits materialized into DrawingML; the import record
   * remains immutable. Current plain-text edits use this body's run templates. */
  textBodyOverride?: { xml: string; text: string; baseStyle: PresentationShape['textStyle'] }
  /** DrawingML body properties, with millimetre insets and degree rotation. */
  textLayout?: PresentationTextLayout
  /** True for a shape copy; copying a whole slide preserves this lineage. */
  sourceCopy?: boolean
  /** The object's original group coordinate space was removed by ungrouping. */
  sourceTransformDetached?: boolean
  /** Object or descendant is referenced by original animation/timing XML. */
  hasAnimation?: boolean
  /** Nonuniform group scale combined with rotated descendants cannot be flattened losslessly. */
  hasComplexGroupTransform?: boolean
  image?: { dataUrl: string; mimeType: string; partName?: string }
  /** Read-only raster of an embedded diagram drawing cache, never exported as replacement XML. */
  diagramPreview?: { dataUrl: string; drawingPart: string; pixelWidth: number; pixelHeight: number }
  /** Validated derived mappings; edits live separately and participate in persistence. */
  smartArt?: SmartArtTextModel
  smartArtEdits?: Record<string, string>
  table?: { cells: string[][]; rebuilt?: boolean; textOverrides?: Record<string, { xml: string; text: string }> }
  /** Derived cell typography; native XML overrides above are the export authority. */
  tableCellText?: Array<Array<{ richText?: RichText; textLayout?: PresentationTextLayout }>>
  /** Derived grid and explicit cell paints; original XML remains authoritative. */
  tableLayout?: TableLayout
  chart?: Omit<PresentationChartData, 'id'>
  children?: SlideObject[]
  locked?: boolean
  opacity?: number
  sourceXml?: string
  sourceFingerprint?: string
  sourcePart?: string
  warning?: string
}
export interface SlideModel {
  id: string
  name: string
  hidden: boolean
  layout: number
  background: string | null
  /** Explicit background edit, including clearing an unmodeled gradient/image. */
  backgroundOverride?: boolean
  notes: string
  objects: SlideObject[]
  inheritedObjects?: SlideObject[]
  transition: PptxTransition
  hasUnsupportedAnimations?: boolean
  media: PptxMedia[]
  sourcePart?: string
  /** Import baseline for slide metadata; preserves unedited background/effects. */
  sourceFingerprint?: string
  warnings: string[]
}
export interface PresentationModel {
  width: number
  height: number
  slides: SlideModel[]
  warnings: string[]
  /** Original package is immutable and shared by undo snapshots. */
  sourceParts?: Map<string, Uint8Array>
  sourcePresentationPart?: string
}
