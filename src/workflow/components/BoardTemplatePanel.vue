<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { BOARD_TEMPLATES } from '../core/board-templates.ts'

const templates = [
  { id: 'flow', title: '流程图', description: '用节点、分支和连线表达处理步骤。', icon: 'flow' },
  { id: 'board', title: '白板', description: '用便签收集想法，自由组合与连接。', icon: 'board' },
  ...BOARD_TEMPLATES,
]
const emit = defineEmits<{ insert: [templateId: string]; close: [] }>()
const panel = ref<HTMLElement>()
let finished = false
function close() { if (!finished) { finished = true; emit('close') } }
function insert(id: string) {
  if (finished) return
  finished = true
  emit('insert', id)
  emit('close')
}
function keydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Escape') { event.preventDefault(); close() }
}
onMounted(async () => {
  await nextTick()
  panel.value?.querySelector<HTMLButtonElement>('[data-board-template]')?.focus({ preventScroll: true })
})
</script>

<template>
  <section ref="panel" class="board-template-panel" role="region" aria-label="画布模板" data-testid="board-template-panel" @keydown="keydown" @pointerdown.stop>
    <header><div><AppIcon name="templates" :size="17"/><strong>画布模板</strong></div><button type="button" class="board-template-close" title="关闭画布模板" aria-label="关闭画布模板" @click="close"><AppIcon name="close" :size="16"/></button></header>
    <p>插入一份可编辑的模板，继续在当前画布创作。</p>
    <div class="board-template-cards"><button v-for="template in templates" :key="template.id" type="button" :data-board-template="template.id" :aria-label="`插入${template.title}模板`" @click="insert(template.id)"><span class="board-template-icon"><AppIcon :name="template.icon" :size="22"/></span><span class="board-template-copy"><strong>{{ template.title }}</strong><small>{{ template.description }}</small></span><AppIcon name="plus" :size="15"/></button></div>
    <footer><AppIcon name="frame" :size="13"/><span>便签、标题和连线都可以单独修改。</span></footer>
  </section>
</template>

<style scoped>
.board-template-panel { width: 310px; max-width: min(100%, calc(100vw - 20px)); max-height: min(540px, calc(100dvh - 110px)); min-height: 0; overflow: auto; box-sizing: border-box; border: 1px solid var(--ui-line, #e5eaf2); border-radius: var(--ui-radius); background: var(--ui-surface, #fff); color: var(--ui-text, #253149); padding: 12px; box-shadow: var(--ui-shadow, 0 8px 30px #1c355714); font: 12px/1.5 var(--ui-font); scrollbar-width: thin; scrollbar-color: var(--ui-line, #cbd5e1) transparent; }
.board-template-panel > header, .board-template-panel > header > div { display: flex; align-items: center; gap: 7px; }
.board-template-panel > header { justify-content: space-between; gap: 12px; }
.board-template-panel > header strong { font-size: 13px; font-weight: 650; }
.board-template-panel > header > div > svg { color: var(--ui-accent, #2563eb); }
.board-template-panel button { color: inherit; font: inherit; cursor: pointer; }
.board-template-panel .board-template-close { display: grid; place-items: center; flex: none; width: 27px; height: 27px; padding: 0; border: 0; border-radius: 5px; background: transparent; }
.board-template-panel .board-template-close:hover { background: var(--ui-surface-muted, #f0f4fa); }
.board-template-panel > p { margin: 7px 0 11px; color: var(--ui-muted, #8490a3); font-size: 10px; line-height: 1.7; }
.board-template-cards { display: grid; gap: 7px; }
.board-template-cards > button { min-width: 0; display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 9px; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 7px; background: var(--ui-surface, #fff); text-align: left; }
.board-template-cards > button:hover { border-color: var(--ui-accent, #2563eb); background: var(--ui-surface-muted, #f0f4fa); }
.board-template-panel button:focus-visible { outline: 2px solid var(--ui-accent, #2563eb); outline-offset: 2px; }
.board-template-icon { flex: none; width: 36px; height: 38px; display: grid; place-items: center; border-radius: 7px; background: var(--ui-accent-soft, #eaf1ff); color: var(--ui-accent, #2563eb); }
.board-template-copy { min-width: 0; flex: 1; display: grid; gap: 3px; }
.board-template-copy strong { font-size: 12px; font-weight: 600; }
.board-template-copy small { color: var(--ui-muted, #8490a3); font-size: 10px; line-height: 1.6; }
.board-template-cards > button > svg { flex: none; color: var(--ui-muted, #8490a3); }
.board-template-panel > footer { display: flex; align-items: center; gap: 6px; margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--ui-line, #e5eaf2); color: var(--ui-muted, #8490a3); font-size: 9px; }
@media (max-width: 340px) { .board-template-panel { padding: 10px; }.board-template-cards > button { gap: 8px; padding: 9px 8px; }.board-template-icon { width: 31px; height: 35px; }.board-template-copy small { font-size: 9px; } }
</style>
