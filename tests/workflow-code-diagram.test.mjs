import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCodeDiagram, DiagramSyntaxError } from '../src/workflow/core/code-diagram.ts'
import { sceneToSvg } from '../src/workflow/core/svg.ts'

const nodes = result => result.scene.elements.filter(element => element.type === 'shape')
const edges = result => result.scene.elements.filter(element => element.type === 'edge')

test('flowchart labels, binding, branches and chains compile into our editable scene', () => {
  const result = compileCodeDiagram(`flowchart TD
    A[开始] --> B{通过?}
    B -->|是| C((完成))
    B -- 否 --> D[修改] --> B`)
  assert.equal(result.kind, 'flowchart')
  assert.equal(nodes(result).length, 4)
  assert.equal(edges(result).length, 4)
  assert.equal(nodes(result).find(node => node.text === '通过?').shape, 'diamond')
  assert.equal(nodes(result).find(node => node.text === '完成').shape, 'ellipse')
  assert.deepEqual(edges(result).map(edge => edge.label), ['', '是', '否', ''])
})

test('all directions change geometric ordering without losing ids or bindings', () => {
  for (const direction of ['TD', 'TB', 'BT', 'LR', 'RL']) {
    const result = compileCodeDiagram(`graph ${direction}; A[One] --> B[Two]`)
    const [a, b] = nodes(result)
    assert.equal(edges(result)[0].from.nodeId, a.id)
    assert.equal(edges(result)[0].to.nodeId, b.id)
    if (direction === 'TD' || direction === 'TB') assert.ok(a.y < b.y)
    if (direction === 'BT') assert.ok(a.y > b.y)
    if (direction === 'LR') assert.ok(a.x < b.x)
    if (direction === 'RL') assert.ok(a.x > b.x)
  }
})

test('line types, bidirectional edges, quoted labels and semicolon handling', () => {
  const result = compileCodeDiagram('flowchart LR; A["A; (one)"]-.->|"no | wait"|B; B==>C; C<-->D; D---A')
  assert.equal(nodes(result)[0].text, 'A; (one)')
  assert.equal(edges(result)[0].style.dashed, true)
  assert.equal(edges(result)[0].label, 'no | wait')
  assert.equal(edges(result)[1].style.strokeWidth, 4)
  assert.equal(edges(result)[2].arrow, 'both')
  assert.equal(edges(result)[3].arrow, 'none')
})

test('late declarations update existing nodes and source compilation is deterministic', () => {
  const source = 'flowchart TB\nA --> B\nB["New label<br/>Second line"]'
  const result = compileCodeDiagram(source)
  assert.equal(nodes(result).length, 2)
  assert.equal(nodes(result)[1].text, 'New label\nSecond line')
  assert.deepEqual(compileCodeDiagram(source), result)
})

test('comments and CRLF preserve diagnostic source line numbers', () => {
  assert.throws(() => compileCodeDiagram('%% comment\r\nflowchart TD\r\n A --> B %% safe\r\n subgraph Example'), error => {
    assert.ok(error instanceof DiagramSyntaxError)
    assert.equal(error.line, 4)
    return true
  })
})

test('unsupported syntax, malformed input and unsupported types fail visibly', () => {
  for (const source of ['', 'unknownDiagram\nA --> B', 'flowchart TD\nA -->', 'flowchart TD\nA[Oops', 'flowchart TD\nA["Oops]', 'flowchart TD\nA & --> C', 'flowchart TD\nA:::red', 'flowchart TD\nclick A "https://example.com"']) {
    assert.throws(() => compileCodeDiagram(source), error => error instanceof DiagramSyntaxError && error.line > 0, source)
  }
})

test('flowchart approximation is disclosed and unsafe HTML remains inert SVG text', () => {
  const result = compileCodeDiagram('flowchart TD\nA([Start]) --> B["<script>alert(1)</script>"]')
  assert.ok(result.warnings.some(warning => warning.includes('椭圆')))
  assert.ok(result.warnings.some(warning => warning.includes('纯文本')))
  const svg = sceneToSvg(result.scene)
  assert.ok(!svg.includes('<script>'))
  assert.ok(svg.includes('&lt;script&gt;'))
  assert.throws(() => compileCodeDiagram('%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA --> B'), DiagramSyntaxError)
})

test('sequence actors, aliases, messages, numbering, self calls and notes render with real geometry', () => {
  const result = compileCodeDiagram(`sequenceDiagram
actor User as 用户
participant API as 服务
autonumber 2 2
User->>API: 创建请求
Note over User,API: 正在处理<br/>请稍候
API->>API: 本地验证
API-->>User: 结果`)
  assert.equal(result.kind, 'sequence')
  assert.ok(nodes(result).some(node => node.text === '用户'))
  assert.ok(nodes(result).some(node => node.text === '2. 创建请求'))
  assert.ok(nodes(result).some(node => node.text === '4. 本地验证'))
  assert.ok(nodes(result).some(node => node.text === '6. 结果'))
  assert.ok(nodes(result).some(node => node.shape === 'note' && node.text === '正在处理\n请稍候'))
  assert.ok(result.scene.elements.some(element => element.type === 'stroke'))
  assert.ok(edges(result).some(edge => edge.style.dashed && edge.arrow === 'end'))
  const svg = sceneToSvg(result.scene)
  assert.ok(svg.includes('<path'))
  assert.ok(svg.includes('创建请求'))
})

test('sequence text punctuation is retained and participants may be implicit', () => {
  const result = compileCodeDiagram('sequenceDiagram\nA->>B: data[ok]; a(b) {x}\nNote right of B: 100%\nB<<-->>A: ack')
  assert.ok(nodes(result).some(node => node.text === 'data[ok]; a(b) {x}'))
  assert.ok(nodes(result).some(node => node.text === '100%'))
  assert.ok(edges(result).some(edge => edge.arrow === 'both'))
})

test('unclosed sequence fragments and activation markers have exact line errors', () => {
  for (const line of ['loop Repeat', 'A->>+B: work', 'activate B', 'Note left of A,B: invalid', 'autonumber 1 0']) {
    assert.throws(() => compileCodeDiagram(`sequenceDiagram\nparticipant A\n${line}`), error => error instanceof DiagramSyntaxError && error.line === 3, line)
  }
})

test('bounded parser rejects oversized input and excessive scene complexity', () => {
  assert.throws(() => compileCodeDiagram('flowchart TD\n' + 'A'.repeat(200_000)), DiagramSyntaxError)
  assert.throws(() => compileCodeDiagram('flowchart TD\n' + Array.from({ length: 401 }, (_, i) => `A${i}`).join('\n')), /400/)
})
