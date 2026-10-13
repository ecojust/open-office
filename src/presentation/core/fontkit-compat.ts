import type { Font, Subset } from '@pdf-lib/fontkit'

interface FontDictionary { FontName?: unknown; Private?: { Subrs?: unknown[]; [key: string]: unknown }; [key: string]: unknown }
interface CffGlyph { path: unknown; _usedSubrs?: Record<string, boolean> }
interface CffSubset extends Subset {
  glyphs: number[]
  cff: { isCIDFont?: boolean; length: number; offSize: number; topDict: { FDArray: FontDictionary[] }; fdForGlyph(id: number): number | null }
  font: { getGlyph(id: number): CffGlyph }
  subsetFontdict(dict: { FDArray: FontDictionary[]; FDSelect: { version: number; fds: number[] } }): void
  subsetSubrs(subrs: unknown[], used: Record<string, boolean>): unknown[]
}

/**
 * @pdf-lib/fontkit 1.1.1 has two bugs for CID CFF (including the bundled Noto):
 * subsetFontdict assigns returning glyphs to the most recently seen font dict,
 * and encode writes a private-dict length as the CFF header's offSize.
 * Correct these on this document's subset instance, without global mutations.
 */
export function cjkFontkit(fontkit: { create(data: Uint8Array): Font }) {
  return { create(data: Uint8Array) {
    const font = fontkit.create(data)
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => {
      const subset = createSubset() as CffSubset
      if (!subset.cff?.isCIDFont) return subset
      subset.subsetFontdict = function (topDict) {
        topDict.FDArray = []
        topDict.FDSelect = { version: 0, fds: [] }
        const indices = new Map<number, number>()
        const usedSubrs: Array<Record<string, boolean>> = []
        for (const gid of this.glyphs) {
          const originalIndex = this.cff.fdForGlyph(gid)
          if (originalIndex === null) throw new Error('PDF 字体子集缺少字形字体字典。')
          let index = indices.get(originalIndex)
          if (index === undefined) {
            index = topDict.FDArray.length
            indices.set(originalIndex, index)
            topDict.FDArray.push({ ...this.cff.topDict.FDArray[originalIndex] })
            usedSubrs.push({})
          }
          topDict.FDSelect.fds.push(index)
          const glyph = this.font.getGlyph(gid)
          // Fontkit populates used subroutines lazily while parsing the outline.
          void glyph.path
          Object.assign(usedSubrs[index]!, glyph._usedSubrs)
        }
        topDict.FDArray.forEach((dictionary, index) => {
          delete dictionary.FontName
          if (dictionary.Private?.Subrs) dictionary.Private = { ...dictionary.Private, Subrs: this.subsetSubrs(dictionary.Private.Subrs, usedSubrs[index]!) }
        })
        // encode reads this immediately after subsetFontdict returns.
        this.cff.length = this.cff.offSize
      }
      return subset
    }
    return font
  } }
}
