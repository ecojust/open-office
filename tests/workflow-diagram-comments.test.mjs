import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCodeDiagram, DiagramSyntaxError, lookupDiagramSource } from '../src/workflow/core/code-diagram.ts'
import { hashCommentStart, maskHashComments } from '../src/workflow/core/diagrams/comments.ts'
import { DIAGRAM_TEMPLATES } from '../src/workflow/core/diagrams/catalog.ts'
import { importText, exportDocument } from '../src/workflow/core/files.ts'
import { validateDocumentSignature } from '../src/shared/document.ts'
import { diagramFoldRanges, tokenizeDiagramSource } from '../src/workflow/core/diagram-source-language.ts'

test('hash comments compile consistently across every supported diagram family', () => {
  const kinds = new Set()
  for (const template of DIAGRAM_TEMPLATES) {
    if (kinds.has(template.kind)) continue
    kinds.add(template.kind)
    const commented = `#图表说明\n\n${template.source.replace(/^(\s*)%%(?!\{)/gm, '$1# ')}\n  # 结束`
    assert.deepEqual(compileCodeDiagram(commented).scene, compileCodeDiagram(template.source).scene, template.kind)
  }
  assert.equal(kinds.size, 22)
})

test('trailing hash comments preserve colors, quoted text, labels and protected class members', () => {
  const flow = compileCodeDiagram(`flowchart LR # 布局
A[标签 # 内容] -->|关系 # 字符| B["# 引号"] # 连线
style A fill:#fff,stroke:#123456 # 颜色`)
  assert.equal(flow.scene.elements.find(element => element.id === 'm-node-A').text, '标签 # 内容')
  assert.equal(flow.scene.elements.find(element => element.id === 'm-node-A').style.fill, '#fff')
  assert.equal(flow.scene.elements.find(element => element.id === 'm-node-A').style.stroke, '#123456')
  assert.equal(flow.scene.elements.find(element => element.id === 'm-node-B').text, '# 引号')
  assert.equal(flow.scene.elements.find(element => element.type === 'edge').label, '关系 # 字符')
  const sequence = compileCodeDiagram('sequenceDiagram # 说明\nA->>B: 订单 #123 # 备注')
  assert.ok(sequence.scene.elements.some(element => element.text === '订单 #123'))
  assert.doesNotThrow(() => compileCodeDiagram('sequenceDiagram\nA->>B: 输入一个 "\n#说明\nB->>A: 完成'))
  const plainClass = 'classDiagram\nclass A {\n#String value\n#run()\n}'
  const commentedClass = '#开头说明\nclassDiagram # 类图\nclass A { # 块\n#String value\n  # 注释\n#run() # 方法\n}'
  assert.deepEqual(compileCodeDiagram(commentedClass).scene, compileCodeDiagram(plainClass).scene)
})

test('comment scanner retains literal hashes and uses whitespace around trailing comments', () => {
  for (const line of ['style A fill: #fff', 'A : #protected', 'A[文字 # 内容]', 'A -->|值 # 内容| B', 'A["escaped \\" # literal"]', 'A[数量 #quot;值#quot;]', 'A --> B #tag']) {
    assert.equal(hashCommentStart(line), -1, line)
  }
  assert.equal(hashCommentStart('#说明'), 0)
  assert.equal(hashCommentStart('  #String name', true), -1)
  assert.equal(hashCommentStart('  # 注释', true), 2)
  assert.equal(hashCommentStart('A --> B # 注释'), 8)
  assert.equal(hashCommentStart('A --> B #'), 8)
  const multiline = 'flowchart TD\nA["首行\n# literal\n尾行"] # 备注'
  assert.ok(maskHashComments(multiline).includes('\n# literal\n'))
  assert.ok(compileCodeDiagram(multiline).scene.elements.some(element => element.text === '首行\n# literal\n尾行'))
})

test('pipe labels retain literal hashes after every supported arrow, with optional whitespace', () => {
  for (const arrow of ['<-->', '<==>', '<-.->', 'o--o', 'x--x', '--o', '--x', '<--', '<==', '-->', '---', '==>', '===', '-.->', '-.-', '~~~']) {
    for (const space of ['', ' ', '\t']) {
      const statement = `A ${arrow}${space}| label # literal | B`
      const commented = `${statement} # comment`
      assert.equal(hashCommentStart(commented), statement.length + 1, commented)
      assert.deepEqual(compileCodeDiagram(`flowchart LR\n${commented}`).scene, compileCodeDiagram(`flowchart LR\n${statement}`).scene, commented)
    }
  }
  const statement = "A[Bob 's car] --> B"
  assert.deepEqual(compileCodeDiagram(`flowchart LR\n${statement} # comment`).scene, compileCodeDiagram(`flowchart LR\n${statement}`).scene)
})

test('braces inside trailing comments do not close structural blocks or hide folding', () => {
  for (const source of [
    'classDiagram\nclass A {\n+name\n}',
    'classDiagram\nnamespace Group {\nclass A\n}',
    'stateDiagram-v2\nstate Group {\nstate A\n}',
    'erDiagram\nA {\nstring name\n}',
    'requirementDiagram\nrequirement need {\nid: R1\ntext: goal\n}',
    'C4Context\nBoundary(group, "Group") {\nSystem(a, "A")\n}',
  ]) {
    const commented = source.replace('{\n', '{ # ends with }\n')
    assert.deepEqual(compileCodeDiagram(commented).scene, compileCodeDiagram(source).scene, source)
    assert.ok(tokenizeDiagramSource(commented).some(token => token.kind === 'comment' && token.text === '# ends with }'), source)
    assert.ok(diagramFoldRanges(commented).some(range => range.lineStart === source.indexOf('\n') + 1 && range.to === commented.lastIndexOf('\n')), source)
  }
  const label = 'flowchart LR\nA { # literal } --> B # comment'
  assert.equal(compileCodeDiagram(label).scene.elements.find(element => element.id === 'm-node-A').text, '# literal')
})

test('hash comments preserve original UTF-16 locations, CRLF endings and diagnostic lines', () => {
  const source = '\uFEFF#前言😀\r\nflowchart TD # 布局\r\n  A[开始😀] --> B # 说明\r\n # 尾注'
  const masked = maskHashComments(source)
  assert.equal(masked.length, source.length)
  assert.deepEqual([...masked.matchAll(/[\r\n]/g)].map(match => match.index), [...source.matchAll(/[\r\n]/g)].map(match => match.index))
  const result = compileCodeDiagram(source)
  assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('开始')), ['m-node-A'])
  assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('说明')), [])
  assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('尾注')), [])
  assert.throws(() => compileCodeDiagram('#前言\r\nflowchart TD\r\n# 注释\r\nA -->'), error => error instanceof DiagramSyntaxError && error.line === 4)
  const sequence = 'sequenceDiagram # 声明\nA->>B: 内容 # 消息说明'
  const sequenceMap = compileCodeDiagram(sequence).sourceMap
  assert.ok(lookupDiagramSource(sequenceMap, sequence.indexOf('内容')).length)
  assert.deepEqual(lookupDiagramSource(sequenceMap, sequence.indexOf('消息说明')), [])
})

test('import screening accepts leading hash comments and source export retains comments verbatim', async () => {
  const source = '\uFEFF#开头\r\n%% 兼容注释\r\nflowchart LR # 布局\r\nA --> B # 连线'
  for (const extension of ['mmd', 'mermaid']) {
    assert.doesNotThrow(() => validateDocumentSignature(new TextEncoder().encode(source), extension))
    assert.throws(() => validateDocumentSignature(new TextEncoder().encode('# only comment'), extension))
    const document = importText(`diagram.${extension}`, source).documents[0]
    assert.equal(document.source, source)
    assert.deepEqual((await exportDocument(document, 'mmd')).bytes, new TextEncoder().encode(source))
  }
  assert.equal(importText('diagram.txt', source).documents[0].source, source)
  assert.doesNotThrow(() => validateDocumentSignature(new TextEncoder().encode('# 注释\rflowchart TD\rA --> B'), 'mmd'))
})
