import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiagramLexState, tokenizeDiagramLine, tokenizeDiagramSource, diagramFoldRanges, sourceCoordinates } from '../src/workflow/core/diagram-source-language.ts'
import { DIAGRAM_TEMPLATES } from '../src/workflow/core/diagrams/catalog.ts'

const tokenAt = (source, needle) => {
  const start = source.indexOf(needle)
  let position = 0
  for (const token of tokenizeDiagramSource(source)) {
    if (position <= start && position + token.text.length > start) return token.kind
    position += token.text.length
  }
}

test('highlighting covers every character in all template families without altering source', () => {
  for (const template of DIAGRAM_TEMPLATES) {
    for (const source of [template.source, template.source.replaceAll('\n', '\r\n')]) {
      const tokens = tokenizeDiagramSource(source)
      assert.equal(tokens.map(token => token.text).join(''), source, template.id)
      assert.ok(tokens.some(token => token.kind === 'keyword'), template.id)
    }
  }
})

test('comments, colors, literal labels and protected class members have distinct syntax roles', () => {
  const source = '# heading\nflowchart LR\n A["end # literal %% text"] --> | label # literal | B\n style A fill:#ffeeaa,stroke-width:2 # trailing'
  for (const [text, kind] of [['# heading', 'comment'], ['flowchart', 'keyword'], ['end # literal', 'string'], ['label # literal', 'string'], ['#ffeeaa', 'atom'], ['2 # trailing', 'number'], ['# trailing', 'comment'], ['-->', 'operator']]) assert.equal(tokenAt(source, text), kind, text)
  const classSource = 'classDiagram\nclass C {\n #protected\n # 注释\n}'
  assert.notEqual(tokenAt(classSource, '#protected'), 'comment')
  assert.equal(tokenAt(classSource, '# 注释'), 'comment')
  for (const label of ['A(%% literal)', 'Start{# literal %% label}', 'Root((%% literal))']) assert.equal(tokenAt(`flowchart LR\n${label}`, '%% literal') ?? tokenAt(`flowchart LR\n${label}`, '%% label'), 'string')
})

test('multiline quoted labels retain their lexical state across comment-looking lines', () => {
  const source = 'flowchart LR\n A["first\n# literal\n%% end {\nlast"] # comment'
  assert.equal(tokenAt(source, '# literal'), 'string')
  assert.equal(tokenAt(source, '%% end'), 'string')
  assert.equal(tokenAt(source, '# comment'), 'comment')
  const state = createDiagramLexState(true)
  tokenizeDiagramLine('A["first', false, state)
  const snapshot = { ...state }
  assert.equal(tokenizeDiagramLine('# literal', false, state)[0].kind, 'string')
  assert.deepEqual(state, snapshot)
  assert.equal(tokenizeDiagramLine('last"] # comment', false, state).at(-1).kind, 'comment')
  assert.equal(state.quote, '')
  assert.equal(state.labelClose, '')
})

test('folds follow nested blocks while ignoring closing words in strings and comments', () => {
  const source = 'flowchart LR\nsubgraph outer\n  A["end"]\n  subgraph inner\n    B[body]\n    # end\n  end\nend\nC[tail]'
  const folds = diagramFoldRanges(source)
  const outer = folds.find(range => range.lineStart === source.indexOf('subgraph outer'))
  const inner = folds.find(range => range.lineStart === source.indexOf('  subgraph inner'))
  assert.equal(source.slice(outer.from, outer.to), '\n  A["end"]\n  subgraph inner\n    B[body]\n    # end\n  end')
  assert.equal(source.slice(inner.from, inner.to), '\n    B[body]\n    # end')
  assert.ok(!folds.some(range => source.slice(range.lineStart, range.from).includes('# end')))
  const braces = 'classDiagram\nnamespace Outer {\n class Inner {\n  +String value\n }\n}'
  assert.equal(diagramFoldRanges(braces).filter(range => braces.slice(range.lineStart, range.from).includes('{')).length, 2)
})

test('quoted trees and planning sections fold at their own boundaries', () => {
  const tree = 'treemap-beta\n  "root"\n    "child"\n      "leaf": 2\n  "next": 1'
  const root = diagramFoldRanges(tree).find(range => range.lineStart === tree.indexOf('  "root"'))
  assert.equal(tree.slice(root.from, root.to), '\n    "child"\n      "leaf": 2')
  const plan = 'gantt\nsection First\nTask :a, 2026-01-01, 2d\nsection Second\nOther :b, after a, 1d'
  const sections = diagramFoldRanges(plan).filter(range => plan.slice(range.lineStart, range.from).startsWith('section'))
  assert.equal(sections.length, 2)
  assert.equal(plan.slice(sections[0].from, sections[0].to), '\nTask :a, 2026-01-01, 2d')
})

test('folding handles deep trees and many inline labels within editor size limits', () => {
  const source = 'mindmap\n' + Array.from({ length: 600 }, (_, index) => ' '.repeat(index + 1) + `N${index}`).join('\n')
  assert.equal(diagramFoldRanges(source).length, 600)
  const line = Array.from({ length: 4000 }, (_, index) => `N${index}["label"]`).join(';')
  assert.equal(tokenizeDiagramLine(line).at(-1).to, line.length)
})

test('editor positions round-trip original CRLF, CR, LF and surrogate-pair source offsets', () => {
  const source = 'A😀\r\nB\rC\n末', coordinates = sourceCoordinates(source)
  assert.equal(coordinates.normalized, 'A😀\nB\nC\n末')
  for (let index = 0; index <= coordinates.normalized.length; index++) assert.equal(coordinates.toEditor(coordinates.toRaw(index)), index)
  assert.equal(coordinates.toRaw(4), source.indexOf('B'))
  assert.equal(coordinates.toRaw(6), source.indexOf('C'))
  assert.equal(coordinates.toRaw(-1), 0)
  assert.equal(coordinates.toRaw(1e6), source.length)
})

test('apostrophes and compact arrows cannot consume following statements', () => {
  const source = "flowchart LR\nA[Bob's car]-->B\nB-->C # comment"
  assert.equal(tokenAt(source, 'comment'), 'comment')
  const tokens = tokenizeDiagramSource(source)
  assert.equal(tokens.filter(token => token.text === '-->' && token.kind === 'operator').length, 2)
  const sequence = 'sequenceDiagram\nA->>B: an unmatched " quotation\n# comment\nB->>A: done'
  assert.equal(tokenAt(sequence, '# comment'), 'comment')
})
