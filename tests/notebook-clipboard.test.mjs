import test from 'node:test'
import assert from 'node:assert/strict'
import { clipboardImageFiles, imageFilesToBlocks } from '../src/notes/clipboard.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
test('copied image files with missing MIME retain names and validated bytes as separate regions', async () => {
 const files = [new File([png], '相册.PNG'), new File([png], 'second.png', { type: 'application/octet-stream' }), new File([png], 'screenshot', { type: 'image/png' })]
 const blocks = await imageFilesToBlocks(clipboardImageFiles({ files }))
 assert.deepEqual(blocks.map(block => block.alt), files.map(file => file.name))
 for (const block of blocks) assert.equal(block.dataUrl, `data:image/png;base64,${png.toString('base64')}`)
 assert.equal(new Set(blocks.map(block => block.id)).size, 3)
})
test('clipboard item fallback reads images once and does not interpret pasted paths as file grants', () => {
 const image = new File([png], 'photo.png'), textFile = new File(['text'], 'notes.txt')
 const items = [{ kind: 'file', getAsFile: () => image }]
 assert.deepEqual(clipboardImageFiles({ files: [image], items }), [image])
 assert.deepEqual(clipboardImageFiles({ files: [], items }), [image])
 assert.deepEqual(clipboardImageFiles({ files: [textFile], getData: () => 'file:///private/photo.png' }), [])
 assert.deepEqual(clipboardImageFiles(null), [])
})
test('copied images reject forged formats, unsupported types and oversized batches before insertion', async () => {
 for (const file of [new File([png], 'wrong.jpg'), new File(['not png'], 'fake.png'), new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' }), new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'large.png')]) await assert.rejects(imageFilesToBlocks([file]))
 await assert.rejects(imageFilesToBlocks(Array.from({ length: 17 }, () => new File([png], 'pixel.png'))), /16/)
 await assert.rejects(imageFilesToBlocks(Array.from({ length: 5 }, () => new File([new Uint8Array(4 * 1024 * 1024)], 'large.png'))), /16 MB/)
})
