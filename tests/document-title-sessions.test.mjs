import test from 'node:test'
import assert from 'node:assert/strict'
import { CalendarSession } from '../src/calendar/session.ts'
import { ScheduleSession } from '../src/schedule/session.ts'
import { NotebookSession } from '../src/notes/session.ts'
import { createCalendar, encodeCalendar } from '../src/calendar/model.ts'
import { createSchedule, encodeSchedule } from '../src/schedule/model.ts'
import { createNotebook, encodeNotebook, noteTitle, notebookTitle } from '../src/notes/model.ts'
import { saveFileName } from '../src/shared/document.ts'
import { WorkflowSession } from '../src/workflow/session.ts'
import { createDocument, parseDocument, serializeDocument } from '../src/workflow/core/documents.ts'
import { editCalendar } from '../src/calendar/mcp.ts'
import { editSchedule } from '../src/schedule/mcp.ts'
import { editNotebook } from '../src/notes/mcp.ts'
import { editCanvas, updateDiagram } from '../src/workflow/mcp.ts'
import { validateToolArguments } from '../src/mcp/tool-schema.ts'
import { calendarTools } from '../src/mcp/calendar-tools.ts'
import { scheduleTools } from '../src/mcp/schedule-tools.ts'
import { noteEditingTools, canvasEditingTools, diagramEditingTools } from '../src/mcp/notes-workflow-tools.ts'

const families = [
 ['calendar', CalendarSession, createCalendar, encodeCalendar, 'oocalendar'],
 ['schedule', ScheduleSession, createSchedule, encodeSchedule, 'ooschedule'],
 ['notebook', NotebookSession, createNotebook, encodeNotebook, 'oonote'],
]
for (const [kind, Session, create, encode, extension] of families) {
 test(`${kind}: an opened filename replaces stale embedded title without changing contents or dirtying the initial session`, () => {
  const original = create('文件中旧名称'), bytes = encode(original)
  const reopened = new Session(bytes, '文件实际名称😀')
  assert.deepEqual(reopened.model, { ...original, title: '文件实际名称😀' })
  assert.equal(reopened.inspect().dirty, false)
  assert.equal(reopened.inspect().canUndo, false)
  assert.equal(new Session(bytes).model.title, '文件中旧名称', 'headless imports without a filename retain stored metadata')
  const result = reopened.export()
  assert.equal(JSON.parse(new TextDecoder().decode(result.bytes)).title, '文件实际名称😀')
  reopened.markSaved(result.bytes)
  assert.equal(reopened.inspect().dirty, false)
  assert.deepEqual(new Session(result.bytes).model, reopened.model)
 })
 test(`${kind}: every previously legal ASCII filename longer than 200 characters opens, saves and reopens intact`, () => {
  const original = create('旧文件内部名称'), bytes = encode(original), maximum = 240 - extension.length - 1
  for (let length = 201; length <= maximum; length++) {
   const title = 'a'.repeat(length), filename = saveFileName(title, extension)
   assert.ok(new TextEncoder().encode(filename).length <= 240)
   const opened = new Session(bytes, title)
   assert.equal(opened.model.title, title)
   assert.equal(opened.inspect().dirty, false)
   assert.deepEqual(opened.model, { ...original, title })
   const saved = opened.export(); opened.markSaved(saved.bytes)
   const reopened = new Session(saved.bytes)
   assert.equal(reopened.model.title, title, 'serialized title must not be truncated')
   assert.equal(reopened.inspect().dirty, false)
  }
  assert.throws(() => saveFileName('a'.repeat(maximum + 1), extension), /过长/)
  assert.throws(() => new Session(bytes, 'a'.repeat(241)), /文字|名称/)
 })
 test(`${kind}: name edits undo to the opened filename and preserve save receipts`, () => {
  const session = new Session(encode(create('旧内置标题')), '当前文件')
  const initial = session.export()
  session.change(copy => { copy.title = '改名后' })
  assert.equal(session.inspect().dirty, true)
  assert.equal(session.inspect().revision, 1)
  assert.throws(() => session.markSaved(initial.bytes), /保存/)
  session.undo()
  assert.equal(session.model.title, '当前文件')
  assert.equal(session.inspect().dirty, false)
  session.redo()
  assert.equal(session.model.title, '改名后')
  const changed = session.export()
  session.markSaved(changed.bytes)
  assert.equal(session.inspect().dirty, false)
  assert.equal(new Session(changed.bytes, '另存文件').model.title, '另存文件')
  assert.throws(() => new Session(changed.bytes, '长'.repeat(241)), /文字|名称/)
 })
}

for (const kind of ['board', 'mermaid']) {
 test(`${kind}: long document titles survive editable workflow exports without truncating source or scene`, () => {
  const original = createDocument(kind), bytes = serializeDocument(original)
  for (let length = 201; length <= 233; length++) {
   const title = 'a'.repeat(length)
   assert.equal(saveFileName(title, 'owflow'), `${title}.owflow`)
   const opened = new WorkflowSession({ ...parseDocument(bytes), title })
   assert.deepEqual(opened.model, { ...original, title })
   const saved = opened.export(); opened.markSaved(saved.bytes)
   const reopened = new WorkflowSession(parseDocument(new TextDecoder().decode(saved.bytes)))
   assert.equal(reopened.model.title, title)
   assert.equal(reopened.inspect().dirty, false)
  }
  assert.throws(() => new WorkflowSession({ ...original, title: 'a'.repeat(241) }), /长度/)
 })
}

const schema = (tools, name) => tools.find(tool => tool.name === name).inputSchema
const longTitle = 'a'.repeat(229)
test('MCP accepts long top-level names consistently while retaining 200-character child title limits', () => {
 const cases = [
  [new CalendarSession(), calendarTools, 'calendar_edit', title => ({ operations: [{ op: 'book.title', title }] }), (model, args) => editCalendar(model, args.operations)],
  [new ScheduleSession(), scheduleTools, 'schedule_edit', title => ({ operations: [{ op: 'project.update', patch: { title } }] }), (model, args) => editSchedule(model, args.operations)],
  [new NotebookSession(), noteEditingTools, 'note_edit', title => ({ operations: [{ op: 'notebook.rename', title }] }), (model, args) => editNotebook(model, args.operations)],
  [new WorkflowSession(createDocument('board')), canvasEditingTools, 'canvas_edit', title => ({ operations: [{ op: 'settings', title }] }), (model, args) => editCanvas(model, args.operations)],
  [new WorkflowSession(createDocument('mermaid')), diagramEditingTools, 'diagram_update', title => ({ title }), updateDiagram],
 ]
 for (const [session, tools, tool, argsFor, edit] of cases) {
  const args = validateToolArguments(schema(tools, tool), argsFor(longTitle))
  session.change(model => edit(model, args))
  assert.equal(session.model.title, longTitle)
  assert.throws(() => validateToolArguments(schema(tools, tool), argsFor('a'.repeat(241))), /MCP 参数/)
 }
 const project = { ...createSchedule(), title: longTitle }
 assert.equal(validateToolArguments(schema(scheduleTools, 'schedule_import'), { project }).project.title, longTitle)
 const childTitle = 'b'.repeat(201)
 for (const [tools, tool, args] of [
  [calendarTools, 'calendar_edit', { operations: [{ op: 'note.add', note: { title: childTitle, date: '2026-11-05' } }] }],
  [scheduleTools, 'schedule_edit', { operations: [{ op: 'event.add', event: { title: childTitle, roleId: null, startDate: '2026-11-05', endDate: '2026-11-05' } }] }],
  [noteEditingTools, 'note_edit', { operations: [{ op: 'section.rename', sectionId: 'section', title: childTitle }] }],
  [noteEditingTools, 'note_edit', { operations: [{ op: 'page.rename', pageId: 'page', title: childTitle }] }],
 ]) {
  const validBoundary = JSON.parse(JSON.stringify(args).replace(childTitle, childTitle.slice(0, 200)))
  assert.doesNotThrow(() => validateToolArguments(schema(tools, tool), validBoundary))
  assert.throws(() => validateToolArguments(schema(tools, tool), args), /MCP 参数/)
 }
 assert.equal(notebookTitle(longTitle), longTitle)
 assert.throws(() => noteTitle(childTitle), /过长/)
 assert.throws(() => notebookTitle('a'.repeat(241)), /过长/)
})
