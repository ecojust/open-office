import { DEFAULT_STYLE, newId, type ElementStyle, type Scene, type SceneElement, type ShapeElement } from './types.ts'

export const BOARD_TEMPLATES: ReadonlyArray<{ id: string; title: string; description: string; icon: string }> = [
  { id: 'brainstorm', title: '头脑风暴', description: '围绕一个主题，自由收集和连接想法。', icon: 'mindmap' },
  { id: 'quadrant', title: '四象限分析', description: '按重要程度与紧急程度安排优先级。', icon: 'quadrant' },
  { id: 'kanban', title: '任务看板', description: '把任务放进待办、进行中和已完成。', icon: 'kanban' },
  { id: 'retrospective', title: '会议复盘', description: '记录收获、困难和下一步行动。', icon: 'journey' },
]

const ink = '#334155'
const colors = { yellow: '#fef3b2', blue: '#dbeafe', green: '#d8f3df', pink: '#fce1e9', purple: '#e9dffc', orange: '#ffe3c4' }
function style(changes: Partial<ElementStyle> = {}): ElementStyle { return { ...DEFAULT_STYLE, stroke: ink, strokeWidth: 0, textAlign: 'left', ...changes } }
function shape(kind: ShapeElement['shape'], text: string, x: number, y: number, width: number, height: number, appearance: Partial<ElementStyle> = {}, groupId?: string): ShapeElement {
  return { id: newId('board'), type: 'shape', shape: kind, x, y, width, height, text, style: style(appearance), locked: false, ...(groupId ? { groupId } : {}) }
}
function note(text: string, x: number, y: number, width: number, height: number, fill: string): ShapeElement {
  return shape('note', text, x, y, width, height, { fill, fontSize: 17 })
}
function text(value: string, x: number, y: number, width: number, height: number, fontSize = 16, groupId?: string): ShapeElement {
  return shape('text', value, x, y, width, height, { fill: 'none', fontSize }, groupId)
}
function frame(title: string, width: number, height: number): ShapeElement {
  return shape('frame', title, 0, 0, width, height, { fill: 'none', stroke: '#94a3b8', strokeWidth: 1.5, fontSize: 22 })
}
function line(points: Array<{ x: number; y: number }>): SceneElement {
  return { id: newId('board'), type: 'stroke', points: points.map(point => ({ ...point })), style: style({ fill: 'none', stroke: '#cbd5e1', strokeWidth: 1.5 }), locked: false }
}
function heading(title: string, subtitle: string, x: number, y: number, width: number): ShapeElement[] {
  const groupId = newId('group')
  return [text(title, x, y, width, 36, 20, groupId), text(subtitle, x, y + 39, width, 30, 13, groupId)]
}
function scene(elements: SceneElement[]): Scene {
  return { elements, background: '#ffffff', grid: true, defaultStyle: { ...DEFAULT_STYLE } }
}

function brainstorm(): Scene {
  const topicGroup = newId('group')
  const topic = shape('ellipse', '讨论主题\n今天要解决什么？', 440, 325, 240, 125, { fill: colors.blue, strokeWidth: 1.5, textAlign: 'center', fontSize: 19 }, topicGroup)
  const notes = [
    note('用户需要什么？\n写下观察与真实反馈。', 50, 145, 265, 135, colors.yellow),
    note('有哪些新点子？\n先收集，不急着评判。', 427, 130, 265, 135, colors.purple),
    note('可以参考什么？\n记录案例与已有经验。', 805, 145, 265, 135, colors.green),
    note('可能遇到的阻力\n哪些假设需要验证？', 50, 530, 265, 135, colors.pink),
    note('我们拥有的资源\n人、时间、工具与支持。', 427, 545, 265, 135, colors.orange),
    note('先尝试的一小步\n选一个最容易验证的想法。', 805, 530, 265, 135, colors.blue),
  ]
  const connectors: SceneElement[] = notes.map(card => ({
    id: newId('board'), type: 'edge', from: { x: topic.x + topic.width / 2, y: topic.y + topic.height / 2, nodeId: topic.id },
    to: { x: card.x + card.width / 2, y: card.y + card.height / 2, nodeId: card.id }, label: '', arrow: 'none', route: 'straight',
    style: style({ fill: 'none', stroke: '#a5b4cc', strokeWidth: 2 }), locked: false,
  }))
  return scene([
    frame('头脑风暴', 1120, 750), ...connectors,
    text('先发散，再整理。每张便签都可以移动、改写或复制。', 30, 57, 1060, 45, 15),
    topic, text('围绕主题自由补充想法', 405, 466, 310, 35, 14, topicGroup), ...notes,
  ])
}

function quadrant(): Scene {
  const elements: SceneElement[] = [
    frame('四象限分析', 1120, 870),
    text('从重要程度与紧急程度出发，为当前事项找到合适的位置。', 30, 57, 1060, 45, 15),
    line([{ x: 560, y: 120 }, { x: 560, y: 835 }]), line([{ x: 30, y: 472 }, { x: 1090, y: 472 }]),
  ]
  const quadrants = [
    { x: 40, y: 130, title: '重要且紧急', subtitle: '立即处理', fill: colors.pink, notes: ['今天必须解决的事项', '影响当前交付的阻塞'] },
    { x: 590, y: 130, title: '重要但不紧急', subtitle: '安排时间，持续推进', fill: colors.blue, notes: ['长期目标与能力建设', '提前准备的重要工作'] },
    { x: 40, y: 500, title: '紧急但不重要', subtitle: '协作、委托或简化', fill: colors.yellow, notes: ['需要快速响应的协作', '可以交给他人处理的事'] },
    { x: 590, y: 500, title: '不紧急也不重要', subtitle: '减少投入，适时放下', fill: colors.green, notes: ['可以暂缓的事项', '减少干扰与重复工作'] },
  ]
  for (const area of quadrants) {
    elements.push(...heading(area.title, area.subtitle, area.x, area.y, 480))
    area.notes.forEach((value, index) => elements.push(note(value, area.x + index * 245, area.y + 95, 225, 175, area.fill)))
  }
  return scene(elements)
}

function kanban(): Scene {
  const elements: SceneElement[] = [
    frame('任务看板', 1120, 785), text('把工作拆成可完成的小任务。拖动便签更新进展，写下负责人和下一步。', 30, 57, 1060, 45, 15),
    line([{ x: 375, y: 118 }, { x: 375, y: 750 }]), line([{ x: 745, y: 118 }, { x: 745, y: 750 }]),
  ]
  const columns = [
    { x: 40, title: '待办', subtitle: '接下来准备做的事', fill: colors.blue, cards: ['明确任务目标\n负责人：\n完成标准：', '整理所需资料\n负责人：\n完成标准：', '准备下一次讨论\n负责人：\n完成标准：'] },
    { x: 410, title: '进行中', subtitle: '关注正在推进的任务', fill: colors.yellow, cards: ['正在推进的任务\n负责人：\n下一步：', '等待协作的事项\n需要的支持：\n下一步：'] },
    { x: 780, title: '已完成', subtitle: '记录交付与获得的经验', fill: colors.green, cards: ['已交付的成果\n完成时间：\n相关记录：', '值得分享的经验\n带来的变化：'] },
  ]
  for (const column of columns) {
    elements.push(...heading(column.title, column.subtitle, column.x, 130, 295))
    column.cards.forEach((value, index) => elements.push(note(value, column.x, 222 + index * 171, 295, 150, column.fill)))
  }
  return scene(elements)
}

function retrospective(): Scene {
  const elements: SceneElement[] = [
    frame('会议复盘', 1120, 760), text('围绕具体事实分享观察，把讨论落到可执行的下一步。', 30, 57, 1060, 45, 15),
    line([{ x: 375, y: 118 }, { x: 375, y: 720 }]), line([{ x: 745, y: 118 }, { x: 745, y: 720 }]),
  ]
  const columns = [
    { x: 40, title: '做得好的', subtitle: '哪些做法值得继续？', fill: colors.green, cards: ['一个有效的做法\n具体发生了什么？\n带来了什么帮助？', '想感谢的人或协作\n我们可以怎样延续？'] },
    { x: 410, title: '遇到的困难', subtitle: '哪些问题需要改变？', fill: colors.pink, cards: ['一个真实的阻碍\n造成了什么影响？\n原因可能是什么？', '希望获得的支持\n谁可以一起解决？'] },
    { x: 780, title: '下一步行动', subtitle: '谁在什么时候完成什么？', fill: colors.yellow, cards: ['行动：\n负责人：\n完成时间：\n如何确认有效：', '下一次跟进\n检查时间：\n要观察的变化：'] },
  ]
  for (const column of columns) {
    elements.push(...heading(column.title, column.subtitle, column.x, 130, 295))
    column.cards.forEach((value, index) => elements.push(note(value, column.x, 225 + index * 240, 295, 205, column.fill)))
  }
  return scene(elements)
}

/** Fresh editable elements are returned for insertion; the existing document is untouched. */
export function createBoardTemplate(id: string): Scene {
  const factories: Record<string, () => Scene> = { brainstorm, quadrant, kanban, retrospective }
  const create = Object.hasOwn(factories, id) ? factories[id] : undefined
  if (!create) throw new Error('未找到此白板模板。')
  return create()
}
