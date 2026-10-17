import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSaveExtension, documentKindOf, extensionOf, isImportOnly, saveFileName, saveFormats, validateDocumentSignature } from '../src/shared/document.ts'

const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const envelope = kind => ({ format: 'open-workflow', version: 1, kind, scene: { elements: [] }, source: kind === 'mermaid' ? 'flowchart TD\n A-->B' : '' })

test('shared editable files restore their correct subapp from content, including JSON imports', () => {
  for (const [kind, expected] of [['flow', 'canvas'], ['board', 'canvas'], ['mermaid', 'diagram']]) {
    for (const extension of ['owflow', 'json']) {
      assert.equal(extensionOf(`项目方案.${extension.toUpperCase()}`), extension)
      assert.equal(documentKindOf(encode(envelope(kind)), extension), expected)
      assert.equal(documentKindOf(encode('\ufeff' + JSON.stringify(envelope(kind))), extension), expected)
    }
  }
  assert.equal(defaultSaveExtension('owflow'), 'owflow')
  assert.equal(isImportOnly('owflow'), false)
  assert.equal(saveFileName('中文架构.v2', 'owflow'), '中文架构.v2.owflow')
})

test('workflow imports preserve the original file by choosing a native-format copy', () => {
  const inputs = {
    mmd: '%% 中文说明\nflowchart LR\n A-->B',
    mermaid: 'sequenceDiagram\n A->>B: 内容',
    drawio: '<?xml version="1.0"?>\n<!-- 导出 -->\n<mxfile><diagram/></mxfile>',
    xml: '<mxGraphModel><root/></mxGraphModel>',
    excalidraw: { type: 'excalidraw', elements: [] },
    json: { type: 'excalidraw', elements: [] },
  }
  for (const [extension, contents] of Object.entries(inputs)) {
    assert.equal(extensionOf(`原文件.${extension}`), extension)
    assert.equal(isImportOnly(extension), true)
    assert.equal(defaultSaveExtension(extension), 'owflow')
    assert.doesNotThrow(() => validateDocumentSignature(encode(contents), extension))
  }
})

test('renamed files and unrelated JSON/XML fail before replacing the editing session', () => {
  for (const value of [null, [], {}, { ...envelope('flow'), version: 2 }, { ...envelope('flow'), kind: 'word' }, { ...envelope('flow'), scene: [] }, { ...envelope('flow'), source: 123 }]) {
    assert.throws(() => documentKindOf(encode(value), 'owflow'))
    assert.throws(() => validateDocumentSignature(encode(value), 'json'))
  }
  for (const extension of ['drawio', 'xml']) {
    for (const contents of ['<html/>', '<mxfileFake/>', '<!-- <mxfile/> -->', '<!DOCTYPE mxfile><mxfile/>']) assert.throws(() => validateDocumentSignature(encode(contents), extension))
  }
  for (const extension of ['mmd', 'mermaid']) {
    for (const contents of ['<html/>', 'flowchartFake TD', 'A\u0000B', '%% only comment']) assert.throws(() => validateDocumentSignature(encode(contents), extension))
    assert.throws(() => validateDocumentSignature(new Uint8Array([0xc3, 0x28]), extension))
  }
  for (const extension of ['owflow', 'json', 'excalidraw']) assert.throws(() => validateDocumentSignature(encode('not JSON'), extension))
})

test('all supported code families pass the text gate without hiding subsequent syntax diagnostics', () => {
  for (const header of ['flowchart TD', 'graph LR', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram', 'gitGraph', 'requirementDiagram', 'C4Context', 'architecture-beta', 'pie', 'gantt', 'xychart-beta', 'quadrantChart', 'sankey-beta', 'radar-beta', 'treemap-beta', 'mindmap', 'timeline', 'journey', 'kanban', 'block-beta', 'packet-beta']) {
    assert.doesNotThrow(() => validateDocumentSignature(encode('\ufeff%% 示例\n' + header + '\n incomplete draft'), 'mmd'), header)
  }
})

test('image exports are accepted for saving but never offered as editable documents', () => {
  const svg = encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=', 'base64'))
  assert.doesNotThrow(() => validateDocumentSignature(svg, 'svg'))
  assert.doesNotThrow(() => validateDocumentSignature(png, 'png'))
  assert.throws(() => validateDocumentSignature(svg, 'png'))
  assert.throws(() => validateDocumentSignature(png, 'svg'))
  for (const extension of ['svg', 'png']) assert.throws(() => extensionOf(`image.${extension}`))
  assert.deepEqual(saveFormats('canvas').map(value => value.extension), ['owflow', 'svg', 'png', 'drawio', 'excalidraw'])
  assert.deepEqual(saveFormats('diagram').map(value => value.extension), ['owflow', 'svg', 'png', 'mmd'])
})
