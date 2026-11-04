/** CalendarNote's lunar information, loaded only when the calendar workspace is used. */
export type CalendarDayInfo = { lunar: string; festival: string; holiday?: { name: string; workday: boolean } }
export type CalendarDateDetails = CalendarDayInfo & {
 date: string; weekday: string; lunarDate: string; zodiac: string; constellation: string
 stems: string; sounds: string; suitable: string[]; avoid: string[]
}
export type CalendarAlmanac = { day(date: string): CalendarDayInfo; details(date: string): CalendarDateDetails }
let pending: Promise<CalendarAlmanac> | undefined

export function loadCalendarAlmanac(): Promise<CalendarAlmanac> {
 pending ??= import('lunar-typescript').then(({ Solar, HolidayUtil }) => {
  const cache = new Map<string, CalendarDayInfo>()
  const solar = (date: string) => {
   const [year, month, day] = date.split('-').map(Number)
   return Solar.fromYmd(year!, month!, day!)
  }
  function day(date: string): CalendarDayInfo {
   const cached = cache.get(date)
   if (cached) return cached
   try {
    const value = solar(date), lunar = value.getLunar()
    const holiday = HolidayUtil.getHoliday(value.getYear(), value.getMonth(), value.getDay())
    const result: CalendarDayInfo = {
     lunar: lunar.getDay() === 1 ? `${lunar.getMonthInChinese()}月` : lunar.getDayInChinese(),
     festival: lunar.getJieQi() || lunar.getFestivals()[0] || value.getFestivals()[0] || '',
     ...(holiday ? { holiday: { name: holiday.getName(), workday: holiday.isWork() } } : {}),
    }
    cache.set(date, result)
    while (cache.size > 256) cache.delete(cache.keys().next().value!)
    return result
   } catch { return { lunar: '', festival: '' } }
  }
  function details(date: string): CalendarDateDetails {
   const value = solar(date), lunar = value.getLunar()
   return {
    ...day(date), date, weekday: `星期${lunar.getWeekInChinese()}`,
    lunarDate: `${lunar.getYearInChinese()}年 ${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    zodiac: lunar.getYearShengXiao(), constellation: value.getXingZuo(),
    stems: `${lunar.getYearInGanZhi()}年 · ${lunar.getMonthInGanZhi()}月 · ${lunar.getDayInGanZhi()}日`,
    sounds: `${lunar.getYearNaYin()} · ${lunar.getMonthNaYin()} · ${lunar.getDayNaYin()}`,
    suitable: lunar.getDayYi(), avoid: lunar.getDayJi(),
   }
  }
  return { day, details }
 }).catch(error => { pending = undefined; throw error })
 return pending
}
