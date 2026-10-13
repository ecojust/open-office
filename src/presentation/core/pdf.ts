import type { PresentationModel } from './types'
import { buildSlideScene, finite, PT_TO_MM, safeImageDataUrl } from './scene.ts'
import type { SceneNode, ScenePaint } from './scene.ts'
import type { PDFDocument, PDFImage, PDFPage, PDFOperator, PDFName } from 'pdf-lib'
import { cjkFontkit } from './fontkit-compat.ts'

export interface PresentationPdfOptions {
  /** Enables local unit tests and packaged applications to supply the same CJK font. */
  fontBytes?: Uint8Array
}

let fontBytesPromise: Promise<Uint8Array> | undefined
const MAX_IMAGE_PIXELS = 64_000_000

/** Check the PNG header before pdf-lib's decoder allocates full RGBA buffers. */
export function assertPdfPngDimensions(header: Uint8Array): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (header.length < 33 || signature.some((value, index) => header[index] !== value)) throw new Error('PDF PNG 图片头无效。')
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('PDF PNG 图片缺少有效 IHDR 尺寸信息。')
  const width = view.getUint32(16), height = view.getUint32(20)
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('PDF 图片尺寸无效或超过 6400 万像素。')
}

function localFontBytes(): Promise<Uint8Array> {
  if (!fontBytesPromise) {
    const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
    fontBytesPromise = fetch(`${base}office-runtime/NotoSansCJKsc-Regular.otf`).then(async response => {
      if (!response.ok) throw new Error(`PDF 中文字体加载失败（${response.status}）。请确认本地字体资源可用。`)
      return new Uint8Array(await response.arrayBuffer())
    }).catch(error => { fontBytesPromise = undefined; throw error })
  }
  return fontBytesPromise
}

async function imageBytes(url: string): Promise<{ bytes: Uint8Array; kind: 'png' | 'jpeg' }> {
  if (!safeImageDataUrl(url)) throw new Error('PDF 仅支持本地内嵌的 PNG、JPEG、GIF、WebP 或 BMP 图片。')
  const comma = url.indexOf(','), mime = url.slice(5, url.indexOf(';')).toLowerCase()
  const decode = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  if (mime === 'image/png') {
    assertPdfPngDimensions(decode(url.slice(comma + 1, comma + 45)))
    return { bytes: decode(url.slice(comma + 1)), kind: 'png' }
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') return { bytes: decode(url.slice(comma + 1)), kind: 'jpeg' }
  if (typeof document === 'undefined') throw new Error(`PDF 导出 ${mime} 图片需要浏览器的本地图片解码器。`)
  const image = new Image()
  image.src = url
  await image.decode().catch(() => { throw new Error(`无法读取 PDF 中的 ${mime} 图片。`) })
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) throw new Error('PDF 图片尺寸无效或超过 6400 万像素。')
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法转换 PDF 图片。')
  context.drawImage(image, 0, 0)
  const result = canvas.toDataURL('image/png')
  canvas.width = canvas.height = 0
  return { bytes: decode(result.slice(result.indexOf(',') + 1)), kind: 'png' }
}

/** Pure browser PDF export. Text and charts remain vectors and text has a Unicode map. */
export async function exportPresentationPdf(model: PresentationModel, options: PresentationPdfOptions = {}): Promise<Uint8Array> {
  if (!model.slides.length) throw new Error('演示文稿没有可导出的幻灯片。')
  // Both libraries and the 16 MB font are loaded only on PDF export, never slide open/edit.
  const [pdf, fontkit, fontBytes] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit'), options.fontBytes ? Promise.resolve(options.fontBytes) : localFontBytes()])
  const document: PDFDocument = await pdf.PDFDocument.create()
  const adaptedFontkit = cjkFontkit(fontkit.default)
  let measuredFont: ReturnType<typeof adaptedFontkit.create> | undefined
  document.registerFontkit({ create(data: Uint8Array) { measuredFont = adaptedFontkit.create(data); return measuredFont } })
  const font = await document.embedFont(fontBytes, { subset: true })
  document.setTitle('演示文稿')
  document.setCreator('Open Office independent presentation editor')
  document.setProducer('Open Office / pdf-lib')
  const k = 1 / PT_TO_MM
  const width = Math.max(1, finite(model.width, 254)), height = Math.max(1, finite(model.height, 142.875))
  const images = new Map<string, PDFImage>()
  const color = (value: string) => [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255] as const
  const measureText = (text: string, _style: unknown, size: number) => font.widthOfTextAtSize(text, size)
  const measureTextMetrics = (text: string, style: { bold: boolean }, size: number) => {
    const glyphs = measuredFont!.layout(text.replace(/\n/g, '')).glyphs
    if (glyphs.length) {
      const k = size / measuredFont!.unitsPerEm, extra = style.bold ? size * .0125 : 0
      const ascent = Math.max(0, ...glyphs.map(glyph => glyph.bbox.maxY)) * k + extra
      const descent = -Math.min(0, ...glyphs.map(glyph => glyph.bbox.minY)) * k + extra
      if (ascent + descent > 0) return { ascent, descent }
    }
    const ascent = font.heightAtSize(size, { descender: false })
    return { ascent, descent: font.heightAtSize(size) - ascent }
  }

  for (const slide of model.slides) {
    // Include hidden slides to preserve player page indices and the exported page count.
    const page: PDFPage = document.addPage([width * k, height * k])
    const fontName = page.node.newFontDictionary(font.name, font.ref)
    const opacities = new Map<number, PDFName>()
    const opacityState = (alpha: number) => {
      let ref = opacities.get(alpha)
      if (!ref) { ref = page.node.newExtGState('Opacity', document.context.obj({ Type: 'ExtGState', ca: alpha, CA: alpha })); opacities.set(alpha, ref) }
      return ref
    }
    // Work in the same top-left millimetre coordinates as the SVG renderer.
    page.pushOperators(pdf.pushGraphicsState(), pdf.concatTransformationMatrix(k, 0, 0, -k, 0, height * k))
    function paint(node: ScenePaint): PDFOperator[] {
      const result: PDFOperator[] = []
      if (node.fill) result.push(pdf.setFillingRgbColor(...color(node.fill)))
      if (node.stroke) result.push(pdf.setStrokingRgbColor(...color(node.stroke)), pdf.setLineWidth(node.strokeWidth))
      return result
    }
    const finish = (node: ScenePaint) => node.fill && node.stroke && node.strokeWidth > 0 ? pdf.fillAndStroke() : node.fill ? pdf.fill() : node.stroke && node.strokeWidth > 0 ? pdf.stroke() : pdf.endPath()
    async function render(node: SceneNode, inheritedOpacity = 1): Promise<void> {
      if (node.kind === 'group') {
        page.pushOperators(pdf.pushGraphicsState())
        const alpha = inheritedOpacity * (node.opacity ?? 1)
        if (alpha !== inheritedOpacity) page.pushOperators(pdf.setGraphicsState(opacityState(alpha)))
        if (node.rotation) {
          const radians = node.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians), cx = node.x + node.width / 2, cy = node.y + node.height / 2
          page.pushOperators(pdf.concatTransformationMatrix(cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy))
        }
        if (node.clip) { const b = node.clip; page.pushOperators(pdf.rectangle(b.x, b.y, b.width, b.height), pdf.clip(), pdf.endPath()) }
        for (const child of node.children) await render(child, alpha)
        page.pushOperators(pdf.popGraphicsState())
      } else if (node.kind === 'text') {
        if (!node.text) return
        page.pushOperators(pdf.pushGraphicsState(), pdf.setFillingRgbColor(...color(node.color)), pdf.setStrokingRgbColor(...color(node.color)), pdf.setLineWidth(node.size * .025), pdf.beginText(), pdf.setFontAndSize(fontName, node.size), pdf.setTextRenderingMode(node.bold ? pdf.TextRenderingMode.FillAndOutline : pdf.TextRenderingMode.Fill), pdf.setTextMatrix(1, 0, node.italic ? .2 : 0, -1, node.x, node.y), pdf.showText(font.encodeText(node.text)), pdf.endText())
        if (node.underline) page.pushOperators(pdf.setLineWidth(Math.max(.1, node.size * .055)), pdf.moveTo(node.x, node.y + node.size * .1), pdf.lineTo(node.x + node.width, node.y + node.size * .1), pdf.stroke())
        page.pushOperators(pdf.popGraphicsState())
      } else if (node.kind === 'image') {
        let image = images.get(node.dataUrl)
        if (!image) { const source = await imageBytes(node.dataUrl); image = source.kind === 'png' ? await document.embedPng(source.bytes) : await document.embedJpg(source.bytes); images.set(node.dataUrl, image) }
        const key = page.node.newXObject('Image', image.ref)
        page.pushOperators(pdf.pushGraphicsState(), pdf.concatTransformationMatrix(node.width, 0, 0, -node.height, node.x, node.y + node.height), pdf.drawObject(key), pdf.popGraphicsState())
      } else {
        page.pushOperators(pdf.pushGraphicsState(), ...paint(node))
        if (node.kind === 'rect') page.pushOperators(pdf.rectangle(node.x, node.y, node.width, node.height))
        else if (node.kind === 'ellipse') {
          const rx = node.width / 2, ry = node.height / 2, cx = node.x + rx, cy = node.y + ry, b = .552284749831
          page.pushOperators(pdf.moveTo(cx + rx, cy), pdf.appendBezierCurve(cx + rx, cy + b * ry, cx + b * rx, cy + ry, cx, cy + ry), pdf.appendBezierCurve(cx - b * rx, cy + ry, cx - rx, cy + b * ry, cx - rx, cy), pdf.appendBezierCurve(cx - rx, cy - b * ry, cx - b * rx, cy - ry, cx, cy - ry), pdf.appendBezierCurve(cx + b * rx, cy - ry, cx + rx, cy - b * ry, cx + rx, cy), pdf.closePath())
        } else {
          node.points.forEach(([x, y], index) => page.pushOperators(index ? pdf.lineTo(x, y) : pdf.moveTo(x, y)))
          if (node.closed) page.pushOperators(pdf.closePath())
        }
        page.pushOperators(finish(node), pdf.popGraphicsState())
      }
    }
    for (const node of buildSlideScene(model, slide, { measureText, measureTextMetrics })) await render(node)
    page.pushOperators(pdf.popGraphicsState())
  }
  return document.save()
}
