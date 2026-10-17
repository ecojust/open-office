import { BASIC_TEMPLATES } from './basic-templates.ts'
import { STRUCTURAL_TEMPLATES } from './structure.ts'
import { CHART_TEMPLATES } from './charts.ts'
import { PLANNING_TEMPLATES } from './planning.ts'
import type { DiagramKind, DiagramTemplate } from './common.ts'

export const DIAGRAM_KIND_LABELS: Record<DiagramKind, string> = {
  flowchart: '流程图', sequence: '时序图', class: '类图', state: '状态图', er: '实体关系图', gitgraph: '分支历史图',
  pie: '饼图', gantt: '甘特图', xychart: '柱线图', quadrant: '象限图', mindmap: '思维导图', timeline: '时间线', journey: '用户旅程', kanban: '看板', requirement: '需求图', c4: '系统上下文图', architecture: '架构图', sankey: '桑基图', radar: '雷达图', treemap: '矩形树图', block: '块图', packet: '数据包图',
}
function templateKind(template: DiagramTemplate): DiagramKind {
  if (template.kind) return template.kind
  const header = template.source.split('\n').find(line => line.trim() && !/^\s*%%/.test(line))?.trim() ?? ''
  const patterns: Array<[RegExp, DiagramKind]> = [[/^(flowchart|graph)\b/, 'flowchart'], [/^sequenceDiagram\b/, 'sequence'], [/^classDiagram\b/, 'class'], [/^stateDiagram(?:-v2)?\b/, 'state'], [/^erDiagram\b/, 'er'], [/^gitGraph\b/i, 'gitgraph'], [/^pie\b/, 'pie'], [/^gantt\b/, 'gantt'], [/^xychart(?:-beta)?\b/, 'xychart'], [/^quadrantChart\b/, 'quadrant'], [/^mindmap\b/, 'mindmap'], [/^timeline\b/, 'timeline'], [/^journey\b/, 'journey'], [/^kanban\b/, 'kanban'], [/^requirementDiagram\b/, 'requirement'], [/^C4(?:Context|Container|Component)\b/, 'c4'], [/^architecture(?:-beta)?\b/, 'architecture'], [/^sankey(?:-beta)?\b/, 'sankey'], [/^radar(?:-beta)?\b/, 'radar'], [/^treemap(?:-beta)?\b/, 'treemap'], [/^block(?:-beta)?\b/, 'block'], [/^packet(?:-beta)?\b/, 'packet']]
  const kind = patterns.find(([pattern]) => pattern.test(header))?.[1]
  if (!kind) throw new Error(`图表模板缺少有效类型：${template.id}`)
  return kind
}
export const DIAGRAM_TEMPLATES: Array<DiagramTemplate & { kind: DiagramKind }> = [...BASIC_TEMPLATES, ...STRUCTURAL_TEMPLATES, ...CHART_TEMPLATES, ...PLANNING_TEMPLATES].map(template => ({ ...template, kind: templateKind(template) }))
