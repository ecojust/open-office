import { onBeforeUnmount, ref, watch } from 'vue'
import { parseLocale, translate, type Locale, type MessageParams } from '../i18n/catalog.ts'

export type { Locale, MessageParams } from '../i18n/catalog.ts'
export { parseLocale, translate } from '../i18n/catalog.ts'
export const LOCALE_STORAGE_KEY = 'open-office.locale'
export const locale = ref<Locale>('zh-CN')

export function t(source: string, params?: MessageParams): string {
  return translate(locale.value, source, params)
}

export function setLocale(value: Locale): void { locale.value = parseLocale(value) }
export function useI18n() { return { locale, t } }

/** Install once in the shell; changing language never touches editor sessions. */
export function useLocalePreference() {
  try { locale.value = parseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY)) } catch { /* Keep Chinese when storage is unavailable. */ }
  const stored = (event: StorageEvent) => {
    // sessionStorage uses the same event type, but is a separate preference store.
    try { if (event.storageArea && event.storageArea !== window.localStorage) return } catch { return }
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) setLocale(parseLocale(event.newValue))
  }
  window.addEventListener('storage', stored)
  const stop = watch(locale, value => {
    document.documentElement.lang = value
    document.title = t('Open Office · 本地办公工作空间')
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, value) } catch { /* The choice still works for this session. */ }
  }, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => { stop(); window.removeEventListener('storage', stored) })
  return { locale, t, setLocale }
}
