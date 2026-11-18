import { applyDiagramStyle } from './diagram-appearance.ts'
import type { DiagramResult } from './diagrams/common.ts'
import type { Scene } from './types.ts'

/** Present freshly compiled source consistently in previews, exports and canvas copies. */
export function presentCodeDiagram(result: DiagramResult, theme: unknown): Scene {
  return applyDiagramStyle(result.scene, theme, result.sourceStyles)
}
