import { parsePptxPackage, patchPptxPackage, patchPptxPageNames, transplantPresentationFeatures, repairPresentationChartData } from './pptx-package'
import type { PptxPresentation } from './pptx-package'
import type { ChartSourceProof } from './pptx-package'

type Pages = { pages: Array<{ id: string; index: number; name?: string }> }
type Patch = Parameters<typeof patchPptxPackage>[1]['slides'][number]
type Snapshot = { bytes: Uint8Array; data: PptxPresentation }
type SourcePage = { snapshot: Snapshot; index: number; copiedChartData?: boolean; chartSource?: { snapshot: Snapshot; index: number } }

// Includes retained ZIP buffers, embedded-media buffers and a conservative
// estimate of text/metadata. Deleted slides remain available to UNO undo, but
// preserving that history must not grow the session without a bound.
export const PRESENTATION_HISTORY_LIMIT = 128 * 1024 * 1024
function retainedSize(pages: Map<string, SourcePage>) {
  const buffers = new Set<ArrayBufferLike>(), snapshots = new Set([...pages.values()].flatMap(page => [page.snapshot, ...(page.chartSource ? [page.chartSource.snapshot] : [])]))
  let size = 0
  const buffer = (bytes: Uint8Array) => { if (!buffers.has(bytes.buffer)) { buffers.add(bytes.buffer); size += bytes.buffer.byteLength } }
  for (const snapshot of snapshots) {
    buffer(snapshot.bytes)
    for (const slide of snapshot.data.slides) {
      size += 512 + 2 * (slide.name.length + slide.title.length + slide.notes.length + slide.partName.length + slide.warnings.join('').length)
      for (const media of slide.media) { size += 512 + 2 * (media.name.length + media.warnings.join('').length); if (media.data) buffer(media.data) }
    }
  }
  return size
}
function checkRetainedSize(pages: Map<string, SourcePage>) {
  if (retainedSize(pages) > PRESENTATION_HISTORY_LIMIT) throw Error('为保留撤销后恢复页面的效果，当前会话数据将超过 128 MiB。本次效果修改未应用；请先保存并重新打开 PPTX，再继续编辑。')
}

// UNO owns editable slide content. The original OOXML owns features which this
// WASM build cannot round-trip. These are merged into the actual saved PPTX,
// never stored in a private sidecar. IDs are local to the loaded UNO model.
export class PresentationSession {
  private mapping = new Map<string, SourcePage>()
  private edited = new Set<string>()
  data: PptxPresentation | null = null
  revision = 0
  savedRevision = 0

  get dirty() { return this.revision !== this.savedRevision }
  async open(bytes: Uint8Array | null, state: Pages) {
    const data = bytes ? await parsePptxPackage(bytes) : null
    const snapshot = bytes && data ? { bytes, data } : null
    const mapping = new Map<string, SourcePage>(snapshot ? state.pages.map(page => [page.id, { snapshot, index: page.index, chartSource: { snapshot, index: page.index } }]) : [])
    checkRetainedSize(mapping)
    this.data = data; this.mapping = mapping
    this.edited.clear()
    this.revision = this.savedRevision = 0
  }
  slide(id: string) {
    const source = this.mapping.get(id)
    return source?.snapshot.data.slides[source.index] || null
  }
  hasFeatures(id: string) {
    const slide = this.slide(id)
    return !!slide && (slide.transition.type !== 'none' || slide.transition.advanceAfterMs != null || slide.transition.advanceOnClick === false || slide.hasTransitionMetadata || slide.media.length > 0 || slide.hasUnsupportedAnimations)
  }
  hasLiveFeatures(state: Pages) { return state.pages.some(page => this.hasFeatures(page.id)) }
  // An explicit deletion also lives outside UNO until reopening the patched
  // PPTX. Raw ODP export would otherwise resurrect the old engine-side effect.
  requiresPptx(state: Pages) { return this.hasLiveFeatures(state) || state.pages.some(page => this.edited.has(page.id)) }
  duplicate(from: string, to: string) {
    const source = this.mapping.get(from)
    // A known duplicate is a new editable chart, not evidence that its native
    // object is the source object. Preserve effects, rebuild current chart data.
    if (source) this.mapping.set(to, { ...source, copiedChartData: true })
    if (this.edited.has(from)) this.edited.add(to)
  }
  async merge(bytes: Uint8Array, state: Pages, chartProof: ChartSourceProof[] = []) {
    // Impress currently omits user slide names on PPTX export. Put the real
    // cSld name back so the same names are read when the file opens again.
    if (state.pages.every(page => typeof page.name === 'string')) bytes = await patchPptxPageNames(bytes, state.pages.map(page => page.name!))
    const groups = new Map<Snapshot, Array<{sourceIndex: number; targetIndex: number}>>()
    for (const page of state.pages) {
      if (!this.hasFeatures(page.id) && !this.edited.has(page.id)) continue
      const source = this.mapping.get(page.id)
      if (!source) throw Error('恢复页面的原始效果快照已不可用，已停止保存以免丢失效果。')
      const group = groups.get(source.snapshot) || []
      group.push({sourceIndex: source.index, targetIndex: page.index}); groups.set(source.snapshot, group)
    }
    for (const [snapshot, mapping] of groups) bytes = await transplantPresentationFeatures(snapshot.bytes, bytes, mapping)
    // Restore source bindings only with both matching current caches and native
    // untouched-chart evidence. Cache equality alone cannot identify a changed
    // range with the same values. Page mappings prevent cross-slide reuse.
    const chartGroups = new Map<Snapshot, Array<{ sourceIndex: number; targetIndex: number }>>()
    const freshPages: Array<{ sourceIndex: number; targetIndex: number }> = []
    for (const page of state.pages) {
      const pageSource = this.mapping.get(page.id), source = pageSource?.chartSource
      if (source && !pageSource?.copiedChartData) {
        const group = chartGroups.get(source.snapshot) || []
        group.push({ sourceIndex: source.index, targetIndex: page.index }); chartGroups.set(source.snapshot, group)
      } else freshPages.push({ sourceIndex: -1, targetIndex: page.index })
    }
    const sourceEligibleCharts = chartProof.filter(proof => proof.sourceEligible === true).flatMap(proof => {
      const page = state.pages.find(item => item.id === proof.pageId)
      return page ? [{ targetIndex: page.index, name: proof.shapeName }] : []
    })
    const chartMappings = chartProof.flatMap(proof => {
      const page = state.pages.find(item => item.id === proof.pageId)
      return page && proof.sourceShapeName ? [{ targetIndex: page.index, name: proof.shapeName, sourceName: proof.sourceShapeName }] : []
    })
    for (const [snapshot, mapping] of chartGroups) bytes = await repairPresentationChartData(snapshot.bytes, bytes, mapping, { sourceEligibleCharts, chartMappings })
    if (freshPages.length) bytes = await repairPresentationChartData(null, bytes, freshPages)
    return bytes
  }
  async edit(bytes: Uint8Array, state: Pages, pageId: string, patch: Omit<Patch, 'slideIndex'>) {
    const page = state.pages.find(item => item.id === pageId)
    if (!page) throw Error('当前幻灯片已删除，请重新选择。')
    // bytes is an already merged snapshot. Commit the new source only after
    // both ZIP patching and reparsing succeed, retaining the old state on error.
    const next = await patchPptxPackage(bytes, {slides: [{...patch, slideIndex: page.index}]})
    if (next.length > 40 * 1024 * 1024) throw Error('加入媒体后的文稿超过 40 MiB，请缩小媒体后重试。')
    const parsed = await parsePptxPackage(next)
    const snapshot = { bytes: next, data: parsed }, mapping = new Map(this.mapping)
    for (const item of state.pages) {
      const previous = this.mapping.get(item.id)
      // Chart proof is anchored to the native import, independently of later
      // OOXML effects snapshots or names changed by page reordering.
      mapping.set(item.id, { snapshot, index: item.index, copiedChartData: previous?.copiedChartData, chartSource: previous?.chartSource })
    }
    checkRetainedSize(mapping)
    this.data = parsed; this.mapping = mapping
    this.edited.add(pageId)
    this.revision++
  }
  markSaved(revision: number) { if (revision === this.revision) this.savedRevision = revision }
  discard() { this.savedRevision = this.revision }
}
