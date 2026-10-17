import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCodeDiagram, lookupDiagramSource, DiagramSyntaxError } from '../src/workflow/core/code-diagram.ts'
import { DIAGRAM_TEMPLATES } from '../src/workflow/core/diagrams/catalog.ts'
import { createDocument, serializeDocument, parseDocument, contentKey, validateScene } from '../src/workflow/core/documents.ts'
import { sceneToSvg } from '../src/workflow/core/svg.ts'

function locate(source, text, delta = 0, occurrence = 0) {
  let offset = -1
  for (let i = 0; i <= occurrence; i++) offset = source.indexOf(text, offset + 1)
  assert.notEqual(offset, -1, `Missing source token: ${text}`)
  return lookupDiagramSource(compileCodeDiagram(source).sourceMap, offset + delta)
}

test('all 22 diagram families expose bounded original source locations and actual scene identities', () => {
  assert.equal(new Set(DIAGRAM_TEMPLATES.map(template => template.kind)).size, 22)
  for (const template of DIAGRAM_TEMPLATES) {
    const source = `\uFEFF%% preceding comment\r\n\r\n${template.source.replaceAll('\n', '\r\n')}\r\n  %% trailing comment\r\n  `
    const result = compileCodeDiagram(source), ids = new Set(result.scene.elements.map(element => element.id))
    assert.ok(result.sourceMap.length > 0, template.kind)
    let previous = -1
    for (const range of result.sourceMap) {
      assert.ok(range.start >= 0 && range.start >= previous && range.start < range.end && range.end <= source.length, template.kind)
      assert.ok(range.elementIds.length > 0 && range.elementIds.every(id => ids.has(id)), template.kind)
      const text = source.slice(range.start, range.end)
      assert.equal(text.trim(), text, `${template.kind}: source excludes padding`)
      assert.ok(!text.startsWith('%%'), template.kind)
      assert.deepEqual(lookupDiagramSource(result.sourceMap, range.start), range.elementIds)
      previous = range.start
    }
    assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('preceding')), [])
    assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('trailing')), [])
    assert.deepEqual(lookupDiagramSource(result.sourceMap, source.length), [])
    assert.deepEqual(compileCodeDiagram(source).scene, compileCodeDiagram(template.source).scene, template.kind)
  }
})

test('flow tokens separate equal labels, chained arrows, semicolons and repeated references', () => {
  const source = 'flowchart LR; A[同名] -->|继续| B[同名] --> C[末端]; A --> C\n%% A --> B'
  assert.deepEqual(locate(source, 'A[同名]', 3), ['m-node-A'])
  assert.deepEqual(locate(source, 'B[同名]', 3), ['m-node-B'])
  assert.deepEqual(locate(source, '继续', 1), ['m-edge-0'])
  assert.deepEqual(locate(source, '--> C'), ['m-edge-1'])
  assert.deepEqual(locate(source, 'A --> C'), ['m-node-A'])
  assert.deepEqual(locate(source, '--> C', 0, 1), ['m-edge-2'])
  const map = compileCodeDiagram(source).sourceMap
  for (const offset of [source.indexOf(';'), source.indexOf(' -->'), source.indexOf('; A') + 1, source.lastIndexOf('A --> B')]) assert.deepEqual(lookupDiagramSource(map, offset), [])
  assert.deepEqual(lookupDiagramSource(map, source.indexOf('A[同名]'), source.indexOf('B[同名]') + 6), ['m-node-A', 'm-edge-0', 'm-node-B'])
})

test('source ranges preserve quoted punctuation, escaped quotes, non-BMP labels and original CRLF offsets', () => {
  const source = '\uFEFF\r\n%% comment\r\nflowchart TB\r\n  A["一;😀 %% 二"] --> B["引号 \\"好\\""]\r  C[末端]  '
  assert.deepEqual(locate(source, '😀'), ['m-node-A'])
  assert.deepEqual(locate(source, '%% 二'), ['m-node-A'])
  assert.deepEqual(locate(source, '好'), ['m-node-B'])
  assert.deepEqual(locate(source, 'C[末端]'), ['m-node-C'])
  const map = compileCodeDiagram(source).sourceMap
  assert.deepEqual(lookupDiagramSource(map, source.indexOf('  A')), [])
  assert.deepEqual(lookupDiagramSource(map, 0), [])
  assert.deepEqual(lookupDiagramSource(map, source.indexOf('\r  C')), [])
})

test('sequence aliases, self messages and notes identify their own rendered event groups', () => {
  const source = 'sequenceDiagram\n actor A as 同名\n participant B as 同名\n autonumber\n A->>A: 自调用\n Note over A,B: 说明\n A->>B: 同名'
  assert.ok(locate(source, 'actor A').includes('m-seq-head-A'))
  assert.ok(locate(source, 'participant B').includes('m-seq-participant-B'))
  const self = locate(source, '自调用'), result = compileCodeDiagram(source)
  assert.equal(self.filter(id => result.scene.elements.find(element => element.id === id).type === 'edge').length, 3)
  assert.equal(locate(source, '说明').length, 1)
  assert.deepEqual(locate(source, 'autonumber'), [])
  assert.ok(!locate(source, 'A->>B: 同名').some(id => id.includes('participant')))
})

test('member declarations map to their own card while relationships map only to edges and markers', () => {
  const source = 'classDiagram\ndirection LR\nclass A["同名"] {\n +String value\n}\nclass B["同名"] {\n +String value\n}\nA "1" *-- "*" B : 关系\nA : +run()'
  const a = locate(source, '+String value'), b = locate(source, '+String value', 0, 1)
  assert.ok(a.includes('class-0') && !a.includes('class-1'))
  assert.ok(b.includes('class-1') && !b.includes('class-0'))
  assert.deepEqual(locate(source, '+run()'), a)
  assert.ok(locate(source, '关系').every(id => id.startsWith('class-edge-0')))
  assert.deepEqual(locate(source, 'direction'), [])
  assert.deepEqual(locate(source, '}'), [])
})

test('state aliases, entity attributes and requirement fields use parser identities', () => {
  const state = 'stateDiagram-v2\nstate "同名" as A\nstate "同名" as B\nA --> B : 跳转'
  assert.deepEqual(locate(state, 'as A'), ['state-0'])
  assert.deepEqual(locate(state, 'as B'), ['state-1'])
  assert.deepEqual(locate(state, '跳转'), ['state-edge-0'])
  const er = 'erDiagram\nA {\n string id PK\n}\nB {\n string id PK\n}\nA ||--o{ B : 引用'
  assert.ok(locate(er, 'string id').includes('er-0'))
  assert.ok(locate(er, 'string id', 0, 1).includes('er-1'))
  assert.ok(locate(er, '引用').every(id => id.startsWith('er-edge-0')))
  const requirement = 'requirementDiagram\nrequirement need {\n id: R1\n text: 目标\n}\nelement check {\n type: 测试\n}\ncheck - verifies -> need'
  assert.ok(locate(requirement, '目标').includes('requirement-0'))
  assert.ok(locate(requirement, 'type: 测试').includes('requirement-1'))
  assert.deepEqual(locate(requirement, 'verifies'), ['requirement-edge-0'])
})

test('nested boundaries keep closing braces and unrelated lines out of highlighted nodes', () => {
  const source = 'C4Context\nBoundary(outer, "外层") {\n Boundary(inner, "内层") {\n  System(a, "同名")\n }\n System(b, "同名")\n}\nRel(a,b,"关联")'
  assert.deepEqual(locate(source, '外层'), ['c4-group-0'])
  assert.deepEqual(locate(source, '内层'), ['c4-group-1'])
  assert.deepEqual(locate(source, 'System(a'), ['c4-0'])
  assert.deepEqual(locate(source, 'System(b'), ['c4-1'])
  assert.deepEqual(locate(source, '关联'), ['c4-edge-0'])
  assert.deepEqual(locate(source, '}'), [])
})

test('chart data maps to corresponding series or flow without including unrelated axes', () => {
  const xy = 'xychart-beta\nx-axis [一, 二]\ny-axis 0 --> 10\nbar [3,5]\nline [4,6]'
  const bars = locate(xy, 'bar ['), line = locate(xy, 'line [')
  assert.ok(bars.includes('xy-bar-0-0') && bars.includes('xy-bar-0-1'))
  assert.ok(!bars.some(id => id.includes('axis') || id.includes('tick')))
  assert.ok(line.includes('xy-line-1') && !line.includes('xy-bar-0-0'))
  const sankey = 'sankey-beta\n甲,乙,20\n甲,丙,10'
  assert.deepEqual(locate(sankey, '甲,乙'), ['sankey-flow-0'])
  assert.deepEqual(locate(sankey, '甲,丙'), ['sankey-flow-1'])
  const gantt = 'gantt\ndateFormat YYYY-MM-DD\nsection 执行\n同名 :a, 2026-01-01, 2d\n同名 :b, after a, 1d'
  assert.ok(locate(gantt, '同名 :a').includes('gantt-task-a'))
  assert.ok(locate(gantt, '同名 :b').includes('gantt-dependency-a-b'))
  assert.deepEqual(locate(gantt, 'dateFormat'), [])
})

test('planning continuation events, repeated card labels and split packet fields retain exact ownership', () => {
  const timeline = 'timeline\nsection 阶段\n2026 : 同名\n : 同名\n2027 : 后续'
  assert.ok(locate(timeline, '2026').includes('timeline-event-0-0'))
  assert.deepEqual(locate(timeline, ' : 同名', 1, 1), ['timeline-event-0-1'])
  assert.deepEqual(locate(timeline, '阶段'), ['timeline-section-0'])
  const kanban = 'kanban\n todo[一列]\n  a[同名]\n  b[同名]'
  assert.deepEqual(locate(kanban, 'a[同名]'), ['kanban-card-0-0'])
  assert.deepEqual(locate(kanban, 'b[同名]'), ['kanban-card-0-1'])
  const packet = 'packet-beta\n0-47: "跨行字段"'
  assert.deepEqual(locate(packet, '跨行字段'), ['packet-field-0-0', 'packet-field-0-1'])
})

test('block tokens and inline comments have separate precise source ranges', () => {
  const source = 'block-beta\ncolumns 3\n A[同名] space B[同名] %% 注释 A\nA --> B'
  assert.deepEqual(locate(source, 'A[同名]'), ['block-A'])
  assert.deepEqual(locate(source, 'B[同名]'), ['block-B'])
  assert.deepEqual(locate(source, 'space'), [])
  assert.deepEqual(locate(source, '注释'), [])
  assert.deepEqual(locate(source, 'columns'), [])
  assert.deepEqual(locate(source, 'A --> B'), ['block-edge-0'])
  const mindmap = 'mindmap\n root[根]\n  a[内容] %% 尾注\n  b["含 %% 文本"]\n  c[\'单引号 %% 标签\']'
  assert.deepEqual(locate(mindmap, '尾注'), [])
  assert.deepEqual(locate(mindmap, '%% 文本'), ['mindmap-2'])
  assert.deepEqual(locate(mindmap, '%% 标签'), ['mindmap-3'])
})

test('source metadata remains separate from persistence, appearance, SVG output and document content keys', () => {
  const source = 'flowchart LR\nA[甲] --> B[乙]', result = compileCodeDiagram(source)
  const document = createDocument('mermaid'); document.source = source; document.scene = result.scene
  const key = contentKey(document), native = serializeDocument(document), svg = sceneToSvg(result.scene)
  assert.ok(!native.includes('sourceMap') && !svg.includes('sourceMap'))
  const restored = parseDocument(native)
  assert.deepEqual(restored.scene, validateScene(result.scene))
  const before = structuredClone(result.scene)
  for (let i = 0; i < source.length; i++) lookupDiagramSource(result.sourceMap, i)
  assert.deepEqual(result.scene, before)
  assert.equal(contentKey(document), key)
  assert.equal(sceneToSvg(result.scene), svg)
})

test('invalid compilation never returns stale locations and resolver safely rejects invalid positions', () => {
  const result = compileCodeDiagram('flowchart LR\nA --> B'), before = structuredClone(result.sourceMap)
  assert.throws(() => compileCodeDiagram('flowchart LR\nA --> B['), DiagramSyntaxError)
  assert.deepEqual(result.sourceMap, before)
  assert.deepEqual(lookupDiagramSource(result.sourceMap, -1), [])
  assert.deepEqual(lookupDiagramSource(result.sourceMap, NaN), [])
  assert.deepEqual(lookupDiagramSource(result.sourceMap, Infinity), [])
  const dense = `flowchart LR\n${Array.from({ length: 350 }, (_, index) => `N${index}[重复]`).join(';')}`
  const compiled = compileCodeDiagram(dense)
  assert.equal(compiled.sourceMap.length, 350)
  assert.deepEqual(lookupDiagramSource(compiled.sourceMap, dense.lastIndexOf('N349')), ['m-node-N349'])
})
