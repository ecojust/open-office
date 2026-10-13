import type { PresentationShape, PresentationChartData } from '../types'
import type { PptxTransition, PptxMedia } from '../pptx-package'

/** Geometry is in millimetres; text sizes are points. No office runtime objects. */
export interface SlideObject extends PresentationShape {
  /** DrawingML body properties, with millimetre insets and degree rotation. */
  textLayout?: {
    verticalAlign?: 'top' | 'middle' | 'bottom'
    insets?: { left: number; right: number; top: number; bottom: number }
    wrap?: boolean
    rotation?: number
  }
  /** True for a shape copy; copying a whole slide preserves this lineage. */
  sourceCopy?: boolean
  /** Object or descendant is referenced by original animation/timing XML. */
  hasAnimation?: boolean
  /** Nonuniform group scale combined with rotated descendants cannot be flattened losslessly. */
  hasComplexGroupTransform?: boolean
  image?: { dataUrl: string; mimeType: string; partName?: string }
  table?: { cells: string[][] }
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
