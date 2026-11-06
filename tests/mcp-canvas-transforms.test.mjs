import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowSession } from '../src/workflow/session.ts'
import { createDocument, parseDocument } from '../src/workflow/core/documents.ts'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { edgePoints } from '../src/workflow/core/geometry.ts'
import { editCanvas } from '../src/workflow/mcp.ts'
import { canvasEditingTools } from '../src/mcp/notes-workflow-tools.ts'
import { validateToolArguments } from '../src/mcp/tool-schema.ts'

const schema = canvasEditingTools.find(tool => tool.name === 'canvas_edit').inputSchema
const shape = (id, x, extra = {}) => ({ id, type: 'shape', shape: 'rectangle', x, y: 0, width: 100, height: 50, text: id, style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const fixture = () => new WorkflowSession({
 ...createDocument('board'),
 scene: { background: '#ffffff', grid: false, elements: [
  shape('a', 0, { groupId: 'cards', cornerRadius: 10 }),
  shape('b', 200, { groupId: 'cards' }),
  { id: 'link', type: 'edge', groupId: 'cards', from: { x: 50, y: 25, nodeId: 'a' }, to: { x: 250, y: 25, nodeId: 'b' }, label: '', arrow: 'end', route: 'straight', style: { ...DEFAULT_STYLE }, locked: false },
  shape('outside', 500),
 ] },
})
const change = (session, operations) => session.change(copy => editCanvas(copy, operations))
const get = (session, id) => session.model.scene.elements.find(element => element.id === id)
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`)

test('canvas MCP focus preserves selection arguments and excludes simultaneous fit and focus', () => {
 const focusSchema = canvasEditingTools.find(tool => tool.name === 'canvas_select_elements').inputSchema
 for (const args of [
  { ids: ['a'], focus: true },
  { ids: [], focus: true },
  { ids: ['a'], fit: true },
  { ids: ['a'], fit: true, focus: false },
  { ids: ['a'], fit: false, focus: true },
  { ids: [], fit: false, focus: false },
  { ids: [] },
 ]) assert.deepEqual(validateToolArguments(focusSchema, args), args)
 for (const args of [
  { ids: ['a'], fit: true, focus: true },
  { ids: [], fit: true, focus: true },
  { ids: ['a'], focus: 'true' },
  { ids: ['a'], focus: null },
  { ids: ['a'], focus: true, zoom: 1 },
 ]) assert.throws(() => validateToolArguments(focusSchema, args))
})

test('canvas MCP advertises bounded rotation, scale anchors and editable shape rotation', () => {
 const operations = [
  { op: 'rotate', ids: ['a'] },
  { op: 'rotate', ids: ['a'], degrees: -5 },
  { op: 'scale', ids: ['a'], factor: 1.2 },
  { op: 'scale', ids: ['a'], factor: .01, anchor: { x: -10, y: 20 } },
  { op: 'update', id: 'a', patch: { rotation: -5 } },
  { op: 'add', element: { type: 'shape', shape: 'rectangle', rotation: 90 } },
 ]
 assert.deepEqual(validateToolArguments(schema, { operations }).operations, operations)
 for (const operation of [
  { op: 'rotate', ids: ['a'], degrees: 361 },
  { op: 'rotate', ids: ['a'], degrees: -361 },
  { op: 'rotate', ids: ['a'], degrees: null },
  { op: 'rotate', ids: ['a'], degrees: '5' },
  { op: 'rotate', ids: ['a'], degrees: Infinity },
  { op: 'scale', ids: ['a'], factor: 0 },
  { op: 'scale', ids: ['a'], factor: 101 },
  { op: 'scale', ids: ['a'], factor: NaN },
  { op: 'scale', ids: ['a'], factor: 2, anchor: { x: 0 } },
  { op: 'scale', ids: ['a'], factor: 2, anchor: { x: 0, y: 0, z: 1 } },
  { op: 'scale', ids: [], factor: 2 },
  { op: 'rotate', ids: ['a'], filename: '/tmp/example' },
 ]) assert.throws(() => validateToolArguments(schema, { operations: [operation] }))
})

test('MCP rotates and scales a complete group with bound connectors as one saved, undoable transaction', () => {
 const session = fixture(), before = structuredClone(session.model), outside = structuredClone(get(session, 'outside'))
 change(session, [{ op: 'rotate', ids: ['a'], degrees: 90 }, { op: 'scale', ids: ['a'], factor: 2 }])
 const a = get(session, 'a'), b = get(session, 'b'), edge = get(session, 'link')
 for (const element of [a, b]) { assert.equal(element.rotation, 90); near(element.width, 200); near(element.height, 100); assert.equal(element.groupId, 'cards') }
 near(a.x, 50); near(a.y, -225); near(b.x, 50); near(b.y, 175)
 near(a.cornerRadius, 20); near(a.style.fontSize, 32); near(a.style.strokeWidth, 4)
 assert.deepEqual(get(session, 'outside'), outside)
 assert.equal(edge.from.nodeId, 'a'); assert.equal(edge.to.nodeId, 'b')
 const endpoints = edgePoints(edge, session.model.scene)
 near(endpoints[0].x, 150); near(endpoints[0].y, -75)
 near(endpoints.at(-1).x, 150); near(endpoints.at(-1).y, 125)
 assert.equal(session.inspect().revision, 1)
 const exported = session.export()
 const reopened = new WorkflowSession(parseDocument(new TextDecoder().decode(exported.bytes)))
 assert.deepEqual(reopened.model, session.model)
 session.markSaved(exported.bytes); assert.equal(session.inspect().dirty, false)
 assert.equal(session.undo(), true); assert.deepEqual(session.model, before); assert.equal(session.inspect().dirty, true)
 assert.equal(session.redo(), true); assert.deepEqual(session.model, reopened.model); assert.equal(session.inspect().dirty, false)
})

test('MCP defaults to clockwise five degrees and supports inverse steps without losing rotation state', () => {
 const session = fixture()
 change(session, [{ op: 'rotate', ids: ['a'] }])
 assert.equal(get(session, 'a').rotation, 5); assert.equal(get(session, 'b').rotation, 5)
 change(session, [{ op: 'rotate', ids: ['b'], degrees: -5 }])
 assert.equal(get(session, 'a').rotation ?? 0, 0); assert.equal(get(session, 'b').rotation ?? 0, 0)
 near(get(session, 'a').x, 0); near(get(session, 'a').y, 0)
 near(get(session, 'b').x, 200); near(get(session, 'b').y, 0)
})

test('MCP scaling honors an explicit stationary anchor and retains existing shape rotation', () => {
 const session = new WorkflowSession({ ...createDocument('board'), scene: { background: '#ffffff', grid: false, elements: [shape('a', 10, { y: 20, rotation: 25 })] } })
 change(session, [{ op: 'scale', ids: ['a'], factor: 2, anchor: { x: 0, y: 0 } }])
 const a = get(session, 'a')
 near(a.x, 20); near(a.y, 40); near(a.width, 200); near(a.height, 100)
 assert.equal(a.rotation, 25)
})

test('MCP add and property updates persist canonical rotation while zero restores the legacy representation', () => {
 const session = new WorkflowSession(createDocument('board'))
 change(session, [{ op: 'add', element: { ...shape('a', 40), rotation: -5 } }])
 assert.equal(get(session, 'a').rotation, 355)
 change(session, [{ op: 'update', id: 'a', patch: { rotation: 360 } }])
 assert.equal(Object.hasOwn(get(session, 'a'), 'rotation'), false)
 change(session, [{ op: 'update', id: 'a', patch: { rotation: 45 } }])
 assert.equal(parseDocument(new TextDecoder().decode(session.export().bytes)).scene.elements[0].rotation, 45)
 const before = structuredClone(session.model), snapshot = session.inspect()
 assert.throws(() => change(session, [{ op: 'update', id: 'a', patch: { rotation: Infinity } }]))
 assert.deepEqual(session.model, before); assert.deepEqual(session.inspect(), snapshot)
})

test('a locked sibling prevents partial group rotation or scaling and rolls back earlier batch edits', () => {
 for (const operation of [{ op: 'rotate', ids: ['a'] }, { op: 'scale', ids: ['a'], factor: 2 }]) {
  const session = fixture()
  change(session, [{ op: 'update', id: 'b', patch: { locked: true } }])
  const output = session.export(); session.markSaved(output.bytes)
  const before = structuredClone(session.model), snapshot = session.inspect()
  assert.throws(() => change(session, [{ op: 'update', id: 'outside', patch: { text: 'must roll back' } }, operation]), /解锁/)
  assert.deepEqual(session.model, before); assert.deepEqual(session.inspect(), snapshot)
 }
})

test('MCP transform runtime rejects invalid IDs, angles, factors and anchors atomically', () => {
 for (const operation of [
  { op: 'rotate', ids: [] }, { op: 'rotate', ids: ['a', 'a'] }, { op: 'rotate', ids: ['missing'] },
  { op: 'rotate', ids: ['a'], degrees: NaN }, { op: 'rotate', ids: ['a'], degrees: 361 }, { op: 'rotate', ids: ['a'], degrees: null },
  { op: 'scale', ids: ['a'], factor: -.5 }, { op: 'scale', ids: ['a'], factor: Infinity }, { op: 'scale', ids: ['a'], factor: .001 },
  { op: 'scale', ids: ['a'], factor: 2, anchor: { x: 0, y: Infinity } }, { op: 'scale', ids: ['a'], factor: 2, anchor: null },
 ]) {
  const session = fixture(), before = structuredClone(session.model), snapshot = session.inspect()
  assert.throws(() => change(session, [{ op: 'update', id: 'outside', patch: { text: 'must roll back' } }, operation]))
  assert.deepEqual(session.model, before); assert.deepEqual(session.inspect(), snapshot)
 }
})
