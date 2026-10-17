<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'

const props = defineProps<{
  x: number
  y: number
  hasSelection: boolean
  canEditText: boolean
  hasUnlocked: boolean
  allLocked: boolean
  canPaste: boolean
  canGroup?: boolean
  canUngroup?: boolean
}>()
const emit = defineEmits<{ action: [action: string]; close: [] }>()

interface MenuItem { action: string; label: string; icon: string; shortcut?: string; disabled?: boolean; danger?: boolean }
const menu = ref<HTMLDivElement>()
const themeSource = ref<HTMLSpanElement>()
const position = ref({ left: 0, top: 0, maxHeight: 600, maxWidth: 260 })
const themeVariables = ref<Record<string, string>>({})
const ready = ref(false)
const activeAction = ref('')
const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
let resizeObserver: ResizeObserver | undefined
let themeObserver: MutationObserver | undefined
let layoutFrame: number | undefined
let mounted = false
let closing = false

const groups = computed<MenuItem[][]>(() => [
  [
    ...(props.canEditText ? [{ action: 'edit-text', label: '编辑文字', icon: 'text', shortcut: 'Enter', disabled: !props.hasUnlocked }] : []),
    { action: 'copy', label: '复制', icon: 'copy', shortcut: `${modifier}+C`, disabled: !props.hasSelection },
    { action: 'duplicate', label: '复制一份', icon: 'duplicate', shortcut: `${modifier}+D`, disabled: !props.hasSelection },
    { action: 'paste', label: '粘贴', icon: 'paste', shortcut: `${modifier}+V`, disabled: !props.canPaste },
    { action: 'select-all', label: '选择全部', icon: 'select', shortcut: `${modifier}+A` },
  ],
  [
    ...(props.canGroup ? [{ action: 'group', label: '组合', icon: 'group', shortcut: `${modifier}+G` }] : []),
    ...(props.canUngroup ? [{ action: 'ungroup', label: '取消组合', icon: 'ungroup', shortcut: `${modifier}+Shift+G` }] : []),
    { action: 'front', label: '置于顶层', icon: 'front', disabled: !props.hasSelection || !props.hasUnlocked },
    { action: 'forward', label: '上移一层', icon: 'forward', disabled: !props.hasSelection || !props.hasUnlocked },
    { action: 'backward', label: '下移一层', icon: 'backward', disabled: !props.hasSelection || !props.hasUnlocked },
    { action: 'back', label: '置于底层', icon: 'back', disabled: !props.hasSelection || !props.hasUnlocked },
  ],
  [
    { action: 'lock', label: props.allLocked ? '解锁' : '锁定', icon: props.allLocked ? 'unlock' : 'lock', disabled: !props.hasSelection },
    { action: 'delete', label: '删除', icon: 'delete', shortcut: 'Delete', disabled: !props.hasSelection || !props.hasUnlocked, danger: true },
  ],
  [
    { action: 'export-svg', label: '导出全图 SVG', icon: 'svg' },
    { action: 'export-png', label: '导出全图 PNG', icon: 'image' },
    ...(props.hasSelection ? [
      { action: 'export-selection-svg', label: '导出选区 SVG', icon: 'selection-svg' },
      { action: 'export-selection-png', label: '导出选区 PNG', icon: 'selection-image' },
    ] : []),
  ],
])
const menuStyle = computed<CSSProperties>(() => ({
  ...themeVariables.value,
  left: `${position.value.left}px`,
  top: `${position.value.top}px`,
  maxHeight: `${position.value.maxHeight}px`,
  maxWidth: `${position.value.maxWidth}px`,
  visibility: ready.value ? 'visible' : 'hidden',
}))


function close() {
  if (closing) return
  closing = true
  emit('close')
}
function activate(item: MenuItem) {
  if (item.disabled || closing) return
  emit('action', item.action)
  close()
}
function enabledButtons(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') || [])]
}
function focusButton(button: HTMLButtonElement | undefined, reveal = false) {
  if (!button) return
  activeAction.value = button.dataset.action || ''
  button.focus({ preventScroll: true })
  if (reveal && menu.value) {
    const bounds = button.getBoundingClientRect(), viewport = menu.value.getBoundingClientRect()
    if (bounds.top < viewport.top + 6) menu.value.scrollTop -= viewport.top + 6 - bounds.top
    else if (bounds.bottom > viewport.bottom - 6) menu.value.scrollTop += bounds.bottom - viewport.bottom + 6
  }
}
function keydown(event: KeyboardEvent) {
  // Keep canvas shortcuts from consuming menu navigation or activating twice.
  event.stopPropagation()
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return }
  const shortcut = event.ctrlKey || event.metaKey
    ? ({ c: 'copy', d: 'duplicate', v: 'paste', a: 'select-all', g: event.shiftKey ? 'ungroup' : 'group' } as Record<string, string>)[event.key.toLowerCase()]
    : event.key === 'Delete' || event.key === 'Backspace' ? 'delete' : undefined
  if (shortcut && !event.altKey && (!event.shiftKey || shortcut === 'ungroup')) {
    event.preventDefault()
    const item = groups.value.flat().find(item => item.action === shortcut)
    if (item) activate(item)
    return
  }
  const buttons = enabledButtons()
  if (!buttons.length) return
  const index = buttons.findIndex(button => button === document.activeElement)
  let next: number | undefined
  if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % buttons.length
  else if (event.key === 'ArrowUp') next = index < 0 ? buttons.length - 1 : (index + buttons.length - 1) % buttons.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  if (next !== undefined) { event.preventDefault(); focusButton(buttons[next], true) }
}
function outside(event: Event) {
  if (!menu.value || event.composedPath().includes(menu.value)) return
  close()
}
function copyTheme() {
  if (!themeSource.value) return
  const style = getComputedStyle(themeSource.value), variables: Record<string, string> = {}
  for (const name of ['--ui-bg', '--ui-surface', '--ui-line', '--ui-text', '--ui-muted', '--ui-accent', '--ui-surface-muted', '--ui-accent-soft', '--ui-shadow']) {
    const value = style.getPropertyValue(name).trim()
    if (value) variables[name] = value
  }
  variables.colorScheme = style.colorScheme
  themeVariables.value = variables
}
async function place() {
  if (!mounted || !menu.value) return
  const margin = 8
  const viewport = window.visualViewport
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0
  const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
  position.value.maxWidth = Math.max(0, width - margin * 2)
  position.value.maxHeight = Math.max(0, height - margin * 2)
  await nextTick()
  if (!mounted || !menu.value) return
  const bounds = menu.value.getBoundingClientRect()
  position.value.left = Math.max(left + margin, Math.min(props.x, left + width - bounds.width - margin))
  position.value.top = Math.max(top + margin, Math.min(props.y, top + height - bounds.height - margin))
  ready.value = true
}
function scheduleLayout() {
  if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => { layoutFrame = undefined; void place() })
}
watch(() => [props.x, props.y], async () => {
  closing = false
  await place()
  if (mounted) focusButton(enabledButtons()[0])
})
watch(() => [props.hasSelection, props.canEditText], scheduleLayout)
watch(groups, async () => {
  await nextTick()
  if (!mounted || !menu.value?.contains(document.activeElement)) return
  if (!(document.activeElement instanceof HTMLButtonElement) || document.activeElement.disabled) focusButton(enabledButtons()[0])
})
onMounted(async () => {
  mounted = true
  copyTheme()
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('contextmenu', outside, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', scheduleLayout)
  window.visualViewport?.addEventListener('resize', scheduleLayout)
  window.visualViewport?.addEventListener('scroll', scheduleLayout)
  resizeObserver = new ResizeObserver(scheduleLayout)
  if (menu.value) resizeObserver.observe(menu.value)
  const themeHost = document.documentElement
  themeObserver = new MutationObserver(copyTheme)
  themeObserver.observe(themeHost, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
  await place()
  if (mounted) focusButton(enabledButtons()[0])
})
onBeforeUnmount(() => {
  mounted = false
  if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame)
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('contextmenu', outside, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', scheduleLayout)
  window.visualViewport?.removeEventListener('resize', scheduleLayout)
  window.visualViewport?.removeEventListener('scroll', scheduleLayout)
})
</script>

<template>
  <span ref="themeSource" hidden aria-hidden="true" />
  <Teleport to="body">
    <div ref="menu" class="canvas-context-menu" :style="menuStyle" role="menu" aria-label="画布菜单" data-testid="canvas-context-menu" @keydown="keydown" @pointerdown.stop @contextmenu.prevent.stop>
      <template v-for="(group, index) in groups" :key="index">
        <div v-if="index" class="context-separator" role="separator" />
        <button v-for="item in group" :key="item.action" type="button" role="menuitem" :data-action="item.action" :disabled="item.disabled" :aria-disabled="item.disabled || undefined" :tabindex="activeAction === item.action ? 0 : -1" :class="{ 'is-danger': item.danger }" @focus="activeAction = item.action" @click="activate(item)">
          <AppIcon :name="item.icon === 'delete' ? 'trash' : item.icon" :size="16" />
          <span>{{ item.label }}</span>
          <kbd v-if="item.shortcut" aria-hidden="true">{{ item.shortcut }}</kbd>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.canvas-context-menu { position: fixed; z-index: 110; width: 242px; box-sizing: border-box; padding: 5px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--ui-line, #e5eaf2); border-radius: var(--ui-radius); background: var(--ui-surface, #fff); color: var(--ui-text, #253149); box-shadow: var(--ui-shadow, 0 10px 32px #17253d26); font: 12px/1.4 var(--ui-font); scrollbar-width: thin; scrollbar-color: var(--ui-line, #dce2ed) transparent; }
.canvas-context-menu button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 31px; padding: 6px 9px; border: 0; border-radius: 5px; background: transparent; color: inherit; font: inherit; text-align: left; white-space: nowrap; cursor: pointer; touch-action: manipulation; }
.canvas-context-menu button svg { width: 16px; height: 16px; flex: none; color: var(--ui-muted, #8490a3); }
.canvas-context-menu button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.canvas-context-menu button kbd { margin-left: auto; padding-left: 12px; color: var(--ui-muted, #8490a3); font-size: 10px; line-height: 1.4; font-family: inherit; white-space: nowrap; }
.canvas-context-menu button:hover:not(:disabled), .canvas-context-menu button:focus-visible { background: var(--ui-surface-muted, #f0f4fa); outline: none; }
.canvas-context-menu button:focus-visible { box-shadow: inset 0 0 0 1.5px var(--ui-accent, #2563eb); }
.canvas-context-menu button:disabled { color: var(--ui-muted, #8490a3); opacity: .45; cursor: default; }
.canvas-context-menu button.is-danger:not(:disabled) { color: var(--ui-danger); }
.canvas-context-menu button.is-danger:not(:disabled) svg { color: inherit; }
.context-separator { height: 1px; margin: 5px 4px; background: var(--ui-line, #e5eaf2); }
.canvas-context-menu::-webkit-scrollbar { width: 5px; }
.canvas-context-menu::-webkit-scrollbar-thumb { border-radius: 5px; background: var(--ui-line, #dce2ed); }
</style>
