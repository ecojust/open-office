import test from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../src/i18n/catalog.ts'
import workflowMessages from '../src/i18n/en/workflow.ts'
import { DIAGRAM_KIND_LABELS, DIAGRAM_TEMPLATES } from '../src/workflow/core/diagrams/catalog.ts'
import { DIAGRAM_STYLES } from '../src/workflow/core/diagram-appearance.ts'
import { BOARD_TEMPLATES } from '../src/workflow/core/board-templates.ts'
import { BRUSH_PRESETS } from '../src/workflow/core/brushes.ts'

test('all workflow catalog choices have English display metadata', () => {
  const labels = [
    ...Object.values(DIAGRAM_KIND_LABELS),
    ...DIAGRAM_TEMPLATES.flatMap(template => [template.title, template.description, template.category]),
    ...DIAGRAM_STYLES.flatMap(style => [style.label, style.description]),
    ...BOARD_TEMPLATES.flatMap(template => [template.title, template.description]),
    ...BRUSH_PRESETS.map(brush => brush.label),
  ]
  for (const label of labels) {
    assert.ok(Object.hasOwn(workflowMessages, label), `Missing workflow translation: ${label}`)
    assert.doesNotMatch(translate('en', label), /[\p{Script=Han}]/u)
    assert.equal(translate('zh-CN', label), label)
  }
})

test('workflow diagnostics translate framing and preserve source tokens', () => {
  assert.equal(translate('en', '饼图分类“删除”重复。'), 'Duplicate pie chart category “删除”.')
  assert.equal(translate('en', '服务 保留中文 的分组 未命名 未定义。'), 'Group 未命名 for service 保留中文 is not defined.')
  assert.equal(translate('en', '第 {line} 行，第 {column} 列：{message}', { line: 3, column: 5, message: translate('en', '节点标签缺少“]”。') }), 'Line 3, column 5: The node label is missing “]”.')
})

test('brush disabled state does not override close controls elsewhere', () => {
  assert.equal(translate('en', '关闭'), 'Close')
  assert.equal(translate('en', '已关闭'), 'Off')
})

test('stored workflow status messages localize known metadata without changing source data', () => {
  assert.equal(translate('en', '已应用“蓝图”风格，可撤销恢复'), 'Applied “Blueprint” style. Undo to restore.')
  assert.equal(translate('en', '流程图 · 12 个图元'), 'Flowchart · 12 elements')
  assert.equal(DIAGRAM_STYLES.find(style => style.id === 'blueprint').label, '蓝图')
})
