import { computed, onBeforeUnmount, ref, watch } from 'vue'

export type Appearance = 'light' | 'dark' | 'system'
export const APPEARANCE_STORAGE_KEY = 'open-office.appearance'

export function parseAppearance(value: string | null): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** Application chrome preference, independent of document content and history. */
export function useAppearance() {
  let initial: Appearance = 'system'
  try { initial = parseAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)) } catch { /* Storage may be unavailable. */ }
  const appearance = ref<Appearance>(initial)
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const systemDark = ref(media?.matches ?? false)
  const effectiveAppearance = computed(() => appearance.value === 'system'
    ? systemDark.value ? 'dark' : 'light'
    : appearance.value)
  const changed = (event: MediaQueryListEvent) => { systemDark.value = event.matches }
  const stored = (event: StorageEvent) => {
    if (event.key === APPEARANCE_STORAGE_KEY || event.key === null) appearance.value = parseAppearance(event.newValue)
  }
  media?.addEventListener('change', changed)
  window.addEventListener('storage', stored)
  watch([appearance, effectiveAppearance], ([preference, resolved]) => {
    if (document.documentElement) {
      document.documentElement.dataset.theme = resolved
      document.documentElement.dataset.themePreference = preference
    }
  }, { immediate: true, flush: 'sync' })
  watch(appearance, value => {
    try { window.localStorage.setItem(APPEARANCE_STORAGE_KEY, value) } catch { /* Keep the choice for this session. */ }
  }, { flush: 'sync' })
  onBeforeUnmount(() => {
    media?.removeEventListener('change', changed)
    window.removeEventListener('storage', stored)
  })
  return { appearance, effectiveAppearance }
}
