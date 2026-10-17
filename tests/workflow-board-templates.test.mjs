import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_TEMPLATES, createBoardTemplate } from '../src/workflow/core/board-templates.ts'
import { frameContents, hitTestElement } from '../src/workflow/core/board-tools.ts'
import { createDocument, parseDocument, serializeDocument, validateScene } from '../src/workflow/core/documents.ts'

const shapes = scene => scene.elements.filter(element => element.type === 'shape')
const notes = scene => shapes(scene).filter(element => element.shape === 'note')
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

test('four board templates expose distinct choices and reject unknown IDs', () => {
  assert.deepEqual(BOARD_TEMPLATES.map(template => template.id), ['brainstorm', 'quadrant', 'kanban', 'retrospective'])
  assert.equal(new Set(BOARD_TEMPLATES.map(template => template.title)).size, 4)
  for (const id of ['', 'missing', '__proto__', 'toString']) assert.throws(() => createBoardTemplate(id), /未找到/)
})

for (const template of BOARD_TEMPLATES) {
  test(`${template.title}: fresh element and group identities preserve independent insertions`, () => {
    const first = createBoardTemplate(template.id), second = createBoardTemplate(template.id)
    const ids = first.elements.map(element => element.id), groups = new Set(first.elements.flatMap(element => element.groupId ? [element.groupId] : []))
    assert.equal(new Set(ids).size, first.elements.length)
    assert.ok(groups.size > 0)
    assert.ok(second.elements.every(element => !ids.includes(element.id)))
    assert.ok(second.elements.every(element => !element.groupId || !groups.has(element.groupId)))
    first.elements[0].text = 'Changed'; first.elements[0].style.stroke = '#ff0000'
    assert.notEqual(second.elements[0].text, 'Changed')
    assert.notEqual(second.elements[0].style.stroke, '#ff0000')
    assert.doesNotThrow(() => validateScene({ ...second, elements: [...first.elements, ...second.elements] }))
  })

  test(`${template.title}: native editable scene survives document save and reopen`, () => {
    const scene = createBoardTemplate(template.id)
    assert.ok(scene.elements.every(element => !element.locked))
    assert.ok(scene.elements.every(element => element.type !== 'shape' || (element.shape !== 'image' && !element.imageData)))
    const checked = validateScene(scene)
    const document = createDocument('board'); document.scene = checked
    assert.deepEqual(parseDocument(serializeDocument(document)).scene, checked)
    const nodeIds = new Set(shapes(scene).map(element => element.id))
    for (const edge of scene.elements.filter(element => element.type === 'edge')) {
      assert.ok(nodeIds.has(edge.from.nodeId)); assert.ok(nodeIds.has(edge.to.nodeId))
    }
  })

  test(`${template.title}: transparent bottom frame captures all contents without obscuring cards or titles`, () => {
    const scene = createBoardTemplate(template.id), frame = scene.elements[0]
    assert.equal(frame.type, 'shape'); assert.equal(frame.shape, 'frame'); assert.equal(frame.style.fill, 'none')
    const contents = scene.elements.slice(1)
    assert.deepEqual(new Set(frameContents(scene, frame.id)), new Set(contents.map(element => element.id)))
    const titleBottom = frame.y + Math.max(28, frame.style.fontSize * 1.5 + 12)
    for (const element of shapes(scene).filter(element => element.id !== frame.id)) {
      assert.ok(element.y > titleBottom, `${element.text} overlaps the frame title`)
    }
    const cards = notes(scene)
    assert.ok(cards.length >= 6)
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]
      assert.equal(hitTestElement(scene, { x: card.x + card.width / 2, y: card.y + card.height / 2 }, 1)?.id, card.id)
      assert.ok(!card.groupId, 'cards should remain independently movable')
      for (const other of cards.slice(i + 1)) assert.equal(overlaps(card, other), false)
      for (const label of shapes(scene).filter(element => element.shape === 'text')) assert.equal(overlaps(card, label), false, `${card.text} overlaps ${label.text}`)
    }
  })
}

test('brainstorm binds six separate idea cards to one central topic', () => {
  const scene = createBoardTemplate('brainstorm'), edges = scene.elements.filter(element => element.type === 'edge')
  assert.equal(notes(scene).length, 6); assert.equal(edges.length, 6)
  assert.equal(new Set(edges.map(edge => edge.from.nodeId)).size, 1)
  assert.deepEqual(new Set(edges.map(edge => edge.to.nodeId)), new Set(notes(scene).map(note => note.id)))
})

test('quadrant covers all four priority combinations with balanced card spaces', () => {
  const scene = createBoardTemplate('quadrant'), labels = shapes(scene).map(element => element.text)
  for (const title of ['重要且紧急', '重要但不紧急', '紧急但不重要', '不紧急也不重要']) assert.ok(labels.includes(title))
  assert.equal(notes(scene).length, 8)
  for (const left of [true, false]) for (const top of [true, false]) assert.equal(notes(scene).filter(note => (note.x < 560) === left && (note.y < 472) === top).length, 2)
})

test('kanban and retrospective retain distinct editable column workflows', () => {
  const kanban = createBoardTemplate('kanban'), retrospective = createBoardTemplate('retrospective')
  for (const title of ['待办', '进行中', '已完成']) assert.ok(shapes(kanban).some(element => element.text === title))
  for (const title of ['做得好的', '遇到的困难', '下一步行动']) assert.ok(shapes(retrospective).some(element => element.text === title))
  assert.equal(notes(kanban).length, 7); assert.equal(notes(retrospective).length, 6)
  assert.ok(notes(retrospective).some(note => note.text.includes('负责人：') && note.text.includes('完成时间：')))
})
