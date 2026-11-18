import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCodeDiagram, DiagramSyntaxError, lookupDiagramSource } from '../src/workflow/core/code-diagram.ts'
import { presentCodeDiagram } from '../src/workflow/core/diagram-presentation.ts'
import { DIAGRAM_STYLES } from '../src/workflow/core/diagram-appearance.ts'
import { sceneToSvg } from '../src/workflow/core/svg.ts'

const fixture = `erDiagram
CUSTOMER["客户"] {
 bigint id PK "编号"
 string name "名字"
}
ORDER {
 int id
}
CUSTOMER ||--o{ ORDER : places`
const element = (scene, id) => scene.elements.find(item => item.id === id)
const members = (scene, id = 'er-0') => scene.elements.filter(item => item.groupId === `${id}-card`)
const texts = (scene, id = 'er-0') => members(scene, id).filter(item => item.type === 'shape' && item.shape === 'text')

test('ER without source styles retains the previous table geometry and default text appearance', () => {
  const result = compileCodeDiagram(fixture), node = element(result.scene, 'er-0')
  assert.equal(result.sourceStyles, undefined)
  assert.deepEqual([node.x, node.y, node.width, node.height], [80, 80, 253, 146])
  assert.equal(node.style.fill, '#f0fdf4')
  assert.equal(node.style.stroke, '#64748b')
  assert.deepEqual(texts(result.scene).map(item => [item.style.fontSize, item.style.fontWeight, item.style.fontStyle, item.style.textAlign, item.style.stroke]), [
    [16, 'bold', 'normal', 'center', '#334155'],
    [13, 'normal', 'normal', 'center', '#64748b'],
    [14, 'normal', 'normal', 'left', '#334155'],
    [14, 'normal', 'normal', 'right', '#64748b'],
    [14, 'normal', 'normal', 'left', '#334155'],
    [14, 'normal', 'normal', 'right', '#64748b'],
  ])
  assert.deepEqual(compileCodeDiagram(`${fixture}\nclassDef unused fill:red`), result, 'an unused class does not change the diagram')
})

test('ER style keeps text color separate from border and sizes every text cell before layout', () => {
  const plain = compileCodeDiagram(fixture)
  const result = compileCodeDiagram(`${fixture}\nstyle CUSTOMER fill:#eff6ff,stroke:#123456,stroke-width:3px,color:#aa2255,font-size:36px,font-weight:400,font-style:italic;`)
  const node = element(result.scene, 'er-0')
  assert.equal(node.style.fill, '#eff6ff')
  assert.equal(node.style.stroke, '#123456')
  assert.equal(node.style.strokeWidth, 3)
  assert.equal(element(result.scene, 'er-0-separator').style.stroke, '#123456')
  assert.ok(node.width > element(plain.scene, 'er-0').width)
  assert.ok(node.height > element(plain.scene, 'er-0').height)
  for (const text of texts(result.scene)) {
    assert.equal(text.style.stroke, '#aa2255')
    assert.equal(text.style.fontSize, 36)
    assert.equal(text.style.fontWeight, 'normal')
    assert.equal(text.style.fontStyle, 'italic')
    assert.equal(text.style.textWrap, 'nowrap')
    assert.ok(text.x >= node.x && text.x + text.width <= node.x + node.width)
    assert.ok(text.y >= node.y && text.y + text.height <= node.y + node.height)
  }
  assert.deepEqual(texts(result.scene).map(item => item.style.textAlign), ['center', 'center', 'left', 'right', 'left', 'right'])
  assert.deepEqual(members(result.scene, 'er-1').map(item => item.style), members(plain.scene, 'er-1').map(item => item.style))
  const edge = result.scene.elements.find(item => item.type === 'edge')
  assert.equal(edge.from.nodeId, 'er-0')
  assert.equal(edge.to.nodeId, 'er-1')
  assert.ok(element(result.scene, 'er-1').x > node.x + node.width)
})

test('ER entities named style, class and classDef retain their original basic syntax', () => {
  for (const name of ['style', 'class', 'classDef']) {
    for (const body of [name, `${name} {\n string id\n}`, `${name} ||--o{ TABLE : owns`]) {
      const result = compileCodeDiagram(`erDiagram\n${body}`)
      assert.equal(result.kind, 'er')
      assert.equal(texts(result.scene)[0].text, name)
      assert.equal(result.sourceStyles, undefined)
      assert.equal(element(result.scene, 'er-0').style.fill, '#f0fdf4')
    }
  }
})

test('ER class definitions and assignments accept lists and forward references with explicit styles taking priority', () => {
  const result = compileCodeDiagram(`erDiagram
style A color:#abcdef
class A,B primary,large;
class B accent
A
B
C
classDef default fill:#eeeeee,stroke:#111111,color:#222222,font-size:12
classDef primary,secondary fill:#ddffff,color:#445566
classDef large font-size:18pt,font-weight:700
classDef accent fill:#ffdddd,color:#778899`)
  const a = element(result.scene, 'er-0'), b = element(result.scene, 'er-1'), c = element(result.scene, 'er-2')
  assert.equal(a.style.fill, '#ddffff')
  assert.equal(a.style.stroke, '#111111')
  assert.equal(b.style.fill, '#ffdddd')
  assert.equal(c.style.fill, '#eeeeee')
  assert.equal(texts(result.scene)[0].style.stroke, '#abcdef')
  assert.equal(texts(result.scene, 'er-1')[0].style.stroke, '#778899')
  assert.equal(texts(result.scene)[0].style.fontSize, 24)
  assert.equal(texts(result.scene, 'er-1')[0].style.fontSize, 24)
  assert.equal(texts(result.scene, 'er-2')[0].style.fontSize, 12)
  assert.equal(result.scene.elements.filter(item => /^er-\d+$/.test(item.id)).length, 3)
})

test('ER inline classes apply to declarations, bare entities, aliases and both relationship endpoints', () => {
  const result = compileCodeDiagram(`erDiagram
A["说明"]:::blue,large {
 int id PK "注释"
}
B:::large
A:::bold||--o{B:::blue : links
classDef blue color:#1122aa
classDef large font-size:20
classDef bold font-weight:bold`)
  assert.equal(result.scene.elements.filter(item => /^er-\d+$/.test(item.id)).length, 2)
  for (const text of [...texts(result.scene), ...texts(result.scene, 'er-1')]) {
    assert.equal(text.style.stroke, '#1122aa')
    assert.equal(text.style.fontSize, 20)
  }
  for (const text of texts(result.scene)) assert.equal(text.style.fontWeight, 'bold')
  const edge = result.scene.elements.find(item => item.type === 'edge')
  assert.equal(edge.from.nodeId, 'er-0')
  assert.equal(edge.to.nodeId, 'er-1')
  assert.equal(edge.label, 'links')
})

test('ER colors, typography and opacity survive every theme without recoloring the relationships', () => {
  const source = `${fixture}\nstyle CUSTOMER fill:#123456,stroke:#abcdef,color:#fe1234,font-size:24,font-weight:bold,font-style:italic,opacity:.75`
  const result = compileCodeDiagram(source), untouched = structuredClone(result)
  for (const { id: theme } of DIAGRAM_STYLES) {
    const scene = presentCodeDiagram(result, theme)
    assert.equal(element(scene, 'er-0').style.fill, '#123456')
    assert.equal(element(scene, 'er-0').style.stroke, '#abcdef')
    for (const item of members(scene)) assert.equal(item.style.opacity, .75)
    for (const text of texts(scene)) {
      assert.equal(text.style.stroke, '#fe1234')
      assert.equal(text.style.fontSize, 24)
      assert.equal(text.style.fontWeight, 'bold')
      assert.equal(text.style.fontStyle, 'italic')
    }
    const svg = sceneToSvg(scene)
    assert.match(svg, /fill="#fe1234"/)
    assert.match(svg, /font-size="24"/)
    assert.match(svg, /stroke="#abcdef"/)
    assert.ok(result.sourceStyles.every(item => !item.id.startsWith('er-edge-')))
    assert.ok(result.sourceStyles.every(item => Object.keys(item.style).every(key => ['fill', 'stroke'].includes(key))))
  }
  assert.deepEqual(result, untouched, 'presentation does not mutate the compiled result')
})

test('ER transparent text remains transparent in SVG while invalid color none fails visibly', () => {
  const result = compileCodeDiagram(`${fixture}\nstyle CUSTOMER color:transparent`)
  const scene = presentCodeDiagram(result, 'midnight')
  for (const text of texts(scene)) assert.equal(text.style.stroke, 'rgba(0,0,0,0)')
  assert.match(sceneToSvg(scene), /fill="rgba\(0,0,0,0\)"/)
  assert.throws(() => compileCodeDiagram('erDiagram\nA\nstyle A color:none'), error => error instanceof DiagramSyntaxError && error.line === 3 && error.message.includes('transparent'))
})

test('ER explicit fills receive legible themed text unless an explicit text color was authored', () => {
  const source = `${fixture}\nstyle CUSTOMER fill:#ffffff`
  const scene = presentCodeDiagram(compileCodeDiagram(source), 'midnight')
  assert.equal(element(scene, 'er-0').style.fill, '#ffffff')
  for (const text of texts(scene)) {
    assert.match(text.style.stroke, /^#[\da-f]{6}$/i)
    const rgb = text.style.stroke.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    const [r, g, b] = rgb.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    assert.ok(1.05 / (.2126 * r + .7152 * g + .0722 * b + .05) >= 4.5, `${text.id} contrasts with its white table`)
  }
  const explicit = presentCodeDiagram(compileCodeDiagram(`${source}\nstyle CUSTOMER color:#ffffff`), 'midnight')
  for (const text of texts(explicit)) assert.equal(text.style.stroke, '#ffffff', 'authored text color retains priority')
})

test('ER style and class source locations target owning tables while definitions retain their declaration', () => {
  const source = '\uFEFFerDiagram\r\nclass A,B emphasis\r\nstyle A color:#112233;\r\nA["客户😀"] {\r\n int id "编号"\r\n}\r\nB\r\nclassDef emphasis font-size:24\r\nA:::emphasis ||--o{ B : links'
  const result = compileCodeDiagram(source)
  const a = members(result.scene).map(item => item.id), b = members(result.scene, 'er-1').map(item => item.id)
  assert.deepEqual(new Set(lookupDiagramSource(result.sourceMap, source.indexOf('class A'))), new Set([...a, ...b]))
  assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('style A')), a)
  assert.deepEqual(new Set(lookupDiagramSource(result.sourceMap, source.indexOf('classDef'))), new Set([...a, ...b]))
  const declaration = result.sourceDefinitions.find(range => range.elementIds.includes('er-0'))
  assert.equal(declaration.start, source.indexOf('A['))
  assert.deepEqual(declaration.elementIds, a)
  assert.ok(lookupDiagramSource(result.sourceMap, source.indexOf('A:::')).includes('er-0-title'))
  assert.ok(lookupDiagramSource(result.sourceMap, source.indexOf('A:::')).includes('er-edge-0'))
})

test('ER safe colors preserve rgb commas and only exact supported dash patterns are rendered', () => {
  const result = compileCodeDiagram(`erDiagram
A
B
style A,B fill:rgba(1,2,3,0.5),stroke:rgb(25,50,75),color:navy,stroke-dasharray:8\\,5;
style B stroke-dasharray:none,font-size:54pt`)
  assert.equal(element(result.scene, 'er-0').style.fill, 'rgba(1,2,3,0.5)')
  assert.equal(element(result.scene, 'er-0').style.stroke, 'rgb(25,50,75)')
  assert.equal(element(result.scene, 'er-0').style.strokePattern, 'dashed')
  assert.equal(element(result.scene, 'er-1').style.strokePattern, 'solid')
  assert.equal(texts(result.scene, 'er-1')[0].style.fontSize, 72)
  assert.match(sceneToSvg(result.scene), /stroke-dasharray="8 5"/)
})

test('ER malformed styles and unknown targets fail with the authored line instead of creating entities', () => {
  const invalid = [
    'style MISSING fill:red', 'class MISSING known', 'class A missing', 'A:::missing',
    'style A font-size:7px', 'style A font-size:55pt', 'style A font-size:2em',
    'style A stroke-width:17', 'style A stroke-width:1pt', 'style A opacity:1.1', 'style A opacity:1px',
    'style A font-weight:500', 'style A font-style:oblique', 'style A text-align:left',
    'style A title.font-size:20', 'style A fill:url(https://example.com)', 'style A color:expression(alert(1))',
    'style A color:#123;stroke:red', 'style A color:red,color:blue', 'style A fill:red,',
    'style A fill:rgb(256,0,0)', 'style A fill:rgba(1,2,3,2)', 'style A fill:rgb(1,2,3',
    'style A stroke-dasharray:5 5', 'class A', 'classDef known fill:blue', 'style A', 'A::known',
  ]
  for (const line of invalid) {
    assert.throws(() => compileCodeDiagram(`erDiagram\nA\nclassDef known fill:red\n${line}`), error => {
      assert.ok(error instanceof DiagramSyntaxError, line)
      assert.equal(error.line, 4, line)
      return true
    }, line)
  }
})
