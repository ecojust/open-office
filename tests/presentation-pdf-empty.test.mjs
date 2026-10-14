import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPresentation } from '../src/presentation/core/model.ts'
import { exportPresentationPdf } from '../src/presentation/core/pdf.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

for (const kind of ['empty', 'image-only', 'cached-diagram-only']) test(`PDF export completes for ${kind} slides without an empty CID-CFF subset`, { timeout: 10000 }, async () => {
  const fontBytes = new Uint8Array(await readFile(new URL('../public/office-runtime/NotoSansCJKsc-Regular.otf', import.meta.url)))
  const model = createPresentation()
  if (kind !== 'empty') model.slides[0].objects.push({ id: 'protected-image', name: 'image', type: kind === 'image-only' ? 'image' : 'unknown', x: 10, y: 10, width: 25, height: 25, rotation: 0, text: '', fillColor: null, lineColor: null, lineWidth: 0, zIndex: 0,
    textStyle: { fontName: 'Arial', fontSize: 12, color: '#000000', align: 'left', bold: false, italic: false, underline: false }, capabilities: { text: false, fill: false, line: false, geometry: false }, locked: true,
    ...(kind === 'image-only' ? { image: { dataUrl: png, mimeType: 'image/png' } } : { diagramPreview: { dataUrl: png, drawingPart: 'ppt/diagrams/drawing1.xml', pixelWidth: 1, pixelHeight: 1 } }),
  })
  const bytes = await exportPresentationPdf(model, { fontBytes })
  assert.ok(bytes.length > 1000 && bytes.length < 30000)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = pdfjs.getDocument({ data: bytes, isEvalSupported: false })
  try {
    const doc = await loading.promise, page = await doc.getPage(1)
    assert.equal(doc.numPages, 1)
    assert.equal((await page.getTextContent()).items.length, 0, 'Subset seed must never become visible/searchable slide text')
    const operators = await page.getOperatorList()
    assert.equal(operators.fnArray.includes(pdfjs.OPS.paintImageXObject), kind !== 'empty')
  } finally { await loading.destroy() }
})
