import { locale, t } from '../shared/i18n'
import { calculateWorkloadBudget } from './workload'

/** UI formatting never changes the ISO dates stored in a schedule. */
export function scheduleDate(value: string, compact = false): string {
 if (locale.value === 'zh-CN') return compact ? value.slice(5).replace('-', '/') : value
 return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(compact ? {} : { year: 'numeric' as const }), timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}
export function scheduleMonth(value: string, compact = false): string {
 if (locale.value === 'zh-CN') return compact ? value.slice(2).replace('-', '.') : value
 return new Intl.DateTimeFormat('en-US', { month: 'short', year: compact ? '2-digit' : 'numeric', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`))
}
export function scheduleWeekday(weekday: number): string {
 return locale.value === 'zh-CN' ? `周${['日', '一', '二', '三', '四', '五', '六'][weekday]}` : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday]!
}
export function workloadTotalTitle(days: number, dailyRate?: number): string {
 const total = calculateWorkloadBudget(days, dailyRate)
 const money = (value: number) => new Intl.NumberFormat(locale.value === 'en' ? 'en-US' : 'zh-CN', { style: 'currency', currency: 'CNY', currencyDisplay: 'narrowSymbol' }).format(value)
 return t('总工时：{days} 人天', { days }) + '\n' + (total === null ? t('尚未设置工时价格，请在「项目设置」中填写。') : t('总预算：{days} 人天 × {rate} / 人天 = {total}', { days, rate: money(dailyRate!), total: money(total) }))
}

/** Translate validation messages at the view boundary, leaving parser behavior intact. */
export function scheduleError(message: string): string {
 const invalidText = /^(项目名称|角色名称|职能|事件名称|事件备注)不能为空、包含无效文字或超过 (\d+) 字。$/.exec(message)
 if (invalidText) return t('{name}不能为空、包含无效文字或超过 {max} 字。', { name: t(invalidText[1]!), max: invalidText[2]! })
 const count = /^(自定义假日|角色|事件)数量不能超过 (\d+)。$/.exec(message)
 if (count) return t('{name}数量不能超过 {max}。', { name: t(count[1]!), max: count[2]! })
 const date = /^无效日期“(.*)”。$/.exec(message)
 if (date) return t('无效日期“{date}”。', { date: date[1]! })
 const conflicts = /^“(.*)”轨道的“(.*)”与“(.*)”日期重叠，请调整日期或角色。半高事件也占用该日期。$/.exec(message)
 if (conflicts) return t('“{track}”轨道的“{event}”与“{other}”日期重叠，请调整日期或角色。半高事件也占用该日期。', { track: conflicts[1]!, event: conflicts[2]!, other: conflicts[3]! })
 const roles = /^这名人员还有 (\d+) 个事件，请先移动或删除这些事件。$/.exec(message)
 if (roles) return t('这名人员还有 {count} 个事件，请先移动或删除这些事件。', { count: roles[1]! })
 return t(message)
}
