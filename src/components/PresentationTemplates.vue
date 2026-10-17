<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { PresentationTemplate } from '../presentation/templates'

const props = defineProps<{
  templates: PresentationTemplate[]
  loading: boolean
  error: string
  disabled: boolean
}>()

const emit = defineEmits<{
  select: [template: PresentationTemplate]
  save: []
  delete: [template: PresentationTemplate]
  retry: []
  close: []
}>()

type TemplateFilter = 'all' | 'builtin' | 'custom'
const filter = ref<TemplateFilter>('all')
const query = ref(''), searchInput = ref<HTMLInputElement>(), templateList = ref<HTMLElement>()
const searchTerm = computed(() => query.value.normalize('NFKC').trim().toLocaleLowerCase())
const matchingTemplates = computed(() => {
  const terms = searchTerm.value.split(/\s+/)
  return props.templates.filter(template => {
    const name = template.name.normalize('NFKC').toLocaleLowerCase()
    return terms.every(term => name.includes(term))
  })
})
const filters: { value: TemplateFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'builtin', label: '内置模板' },
  { value: 'custom', label: '我的模板' },
]
const groups = computed(() => [
  { source: 'builtin' as const, label: '内置模板', items: matchingTemplates.value.filter(template => template.source === 'builtin') },
  { source: 'custom' as const, label: '我的模板', items: matchingTemplates.value.filter(template => template.source === 'custom') },
].filter(group => (filter.value === 'all' || filter.value === group.source) && (!searchTerm.value || group.items.length)))
const resultCount = computed(() => groups.value.reduce((count, group) => count + group.items.length, 0))
const unavailable = computed(() => props.disabled || props.loading)
function clearSearch() { query.value = ''; searchInput.value?.focus() }
watch([query, filter], () => { void nextTick(() => { if (templateList.value) templateList.value.scrollTop = 0 }) })
</script>

<template>
  <aside class="presentation-templates" aria-label="演示模板" :aria-busy="loading">
    <header class="presentation-templates-header">
      <div class="presentation-templates-heading">
        <span class="presentation-templates-symbol"><Icon name="presentation" :size="18" /></span>
        <h2>演示模板</h2>
      </div>
      <button type="button" class="presentation-templates-icon-button" aria-label="关闭模板栏" title="关闭模板栏" @click="emit('close')"><Icon name="close" :size="17" /></button>
    </header>

    <div class="presentation-templates-actions">
      <button type="button" class="presentation-templates-save" data-testid="presentation-template-save" :disabled="unavailable" @click="emit('save')">
        <Icon name="save-as" :size="17" />
        <span>将当前演示存为模板</span>
        <Icon name="plus" :size="15" />
      </button>
      <p>保留喜欢的设计，下次直接使用。</p>
      <div class="presentation-templates-search">
        <Icon name="search" :size="15" />
        <input ref="searchInput" v-model="query" type="search" aria-label="搜索模板名称" placeholder="搜索模板名称" @keydown.esc.stop.prevent="clearSearch" />
        <button v-if="query" type="button" class="presentation-templates-icon-button" aria-label="清空模板搜索" title="清空搜索" @click="clearSearch"><Icon name="close" :size="14" /></button>
      </div>
      <div class="presentation-templates-filters" role="group" aria-label="筛选演示模板">
        <button v-for="item in filters" :key="item.value" type="button" :aria-pressed="filter === item.value" @click="filter = item.value">{{ item.label }}</button>
      </div>
    </div>

    <div ref="templateList" class="presentation-templates-list" tabindex="0" aria-label="模板列表">
      <div v-if="error" class="presentation-templates-error" role="alert">
        <p>{{ error }}</p>
        <button type="button" :disabled="unavailable" @click="emit('retry')">重新加载</button>
      </div>
      <div v-if="loading" class="presentation-templates-loading" role="status">
        <span class="presentation-templates-spinner" aria-hidden="true" />正在加载模板…
      </div>
      <template v-if="searchTerm && !loading && !error">
        <p class="presentation-templates-results" role="status">找到 {{ resultCount }} 个模板</p>
        <div v-if="!resultCount" class="presentation-templates-empty">
          <Icon name="search" :size="24" />
          <strong>没有匹配的模板</strong>
          <p>试试其他名称，或清空搜索查看全部模板。</p>
        </div>
      </template>

      <section v-for="group in groups" :key="group.source" class="presentation-template-group" :aria-label="group.label">
        <div class="presentation-template-group-heading"><h3>{{ group.label }}</h3><span>{{ group.items.length }}</span></div>
        <div v-if="!group.items.length && !loading && !error" class="presentation-templates-empty">
          <Icon :name="group.source === 'custom' ? 'save-as' : 'presentation'" :size="24" />
          <strong>{{ group.source === 'custom' ? '收藏自己的演示风格' : '暂无内置模板' }}</strong>
          <p>{{ group.source === 'custom' ? '点击上方“存为模板”，保存当前演示的完整内容与设计。' : '重新加载模板后再试一次。' }}</p>
        </div>
        <article v-for="template in group.items" :key="template.id" class="presentation-template-card" :style="{ '--template-accent': template.accent }">
          <button type="button" class="presentation-template-select" :data-testid="`presentation-template-${template.id}`" :disabled="unavailable" :aria-label="`使用模板：${template.name}，${template.slideCount} 页`" @click="emit('select', template)">
            <span class="presentation-template-preview">
              <img v-if="template.preview" :src="template.preview" alt="" loading="lazy" draggable="false" />
              <svg v-else class="presentation-template-placeholder" viewBox="0 0 320 180" fill="none" aria-hidden="true" focusable="false">
                <path d="M192 0h128v180H192z" fill="currentColor" opacity=".06" />
                <path d="M320 24 204 140M320 74 254 140" stroke="currentColor" stroke-width="1.65" opacity=".13" />
                <rect x="31" y="37" width="29" height="5" rx="2.5" fill="currentColor" opacity=".8" />
                <rect x="31" y="65" width="147" height="12" rx="3" fill="currentColor" opacity=".8" />
                <rect x="31" y="86" width="112" height="12" rx="3" fill="currentColor" opacity=".45" />
                <path d="M32 118h99M32 126h73" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" opacity=".35" />
                <rect x="225" y="43" width="55" height="55" rx="11" stroke="currentColor" stroke-width="1.65" opacity=".5" />
                <rect x="244" y="70" width="43" height="43" rx="9" fill="currentColor" opacity=".18" />
                <path d="M31 152h258" stroke="currentColor" stroke-width="1.65" opacity=".12" />
              </svg>
              <span class="presentation-template-page-count">{{ template.slideCount }} 页</span>
              <span class="presentation-template-use" aria-hidden="true"><Icon name="arrow" :size="15" /></span>
            </span>
            <span class="presentation-template-details" :class="{ 'has-delete': template.source === 'custom' }">
              <strong :title="template.name">{{ template.name }}</strong>
              <span v-if="template.description" class="presentation-template-description" :title="template.description">{{ template.description }}</span>
            </span>
          </button>
          <button v-if="template.source === 'custom'" type="button" class="presentation-template-delete presentation-templates-icon-button" :disabled="unavailable" :aria-label="`删除模板：${template.name}`" :title="`删除模板：${template.name}`" @click="emit('delete', template)"><Icon name="trash" :size="16" /></button>
        </article>
      </section>
    </div>
    <footer class="presentation-templates-footer"><Icon name="info" :size="14" /><span>选择模板后，确认即可切换。</span></footer>
  </aside>
</template>

<style scoped>
.presentation-templates {
  display: flex;
  flex-direction: column;
  width: 300px;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  background: var(--ui-surface);
  color: var(--ui-text);
  font: 12px/1.5 var(--ui-font);
}
.presentation-templates button { font: inherit; cursor: pointer; }
.presentation-templates button:disabled { opacity: .45; cursor: default; }
.presentation-templates button:focus-visible, .presentation-templates-list:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.presentation-templates-header { display: flex; flex: none; align-items: center; justify-content: space-between; padding: 13px 13px 10px 16px; }
.presentation-templates-heading { display: flex; align-items: center; gap: 8px; }
.presentation-templates-symbol { display: inline-flex; align-items: center; color: var(--ui-accent); }
.presentation-templates-heading h2 { margin: 0; font-size: 14px; font-weight: 650; }
.presentation-templates-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ui-muted); }
.presentation-templates-icon-button:hover:not(:disabled) { color: var(--ui-text); background: var(--ui-surface-muted); }
.presentation-templates-actions { flex: none; padding: 0 14px 12px; border-bottom: 1px solid var(--ui-line); }
.presentation-templates-save { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px; border: 1px solid color-mix(in srgb, var(--ui-accent) 23%, var(--ui-line)); border-radius: 8px; background: color-mix(in srgb, var(--ui-accent) 7%, var(--ui-surface)); color: var(--ui-accent); font-weight: 550 !important; }
.presentation-templates-save > span { flex: 1; text-align: left; }
.presentation-templates-save:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-accent) 12%, var(--ui-surface)); border-color: color-mix(in srgb, var(--ui-accent) 50%, var(--ui-line)); }
.presentation-templates-actions > p { margin: 7px 1px 12px; font-size: 11px; color: var(--ui-muted); }
.presentation-templates-search { display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 8px; margin-bottom: 10px; border: 1px solid var(--ui-line); border-radius: 7px; color: var(--ui-muted); background: var(--ui-surface); }
.presentation-templates-search:focus-within { border-color: var(--ui-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent) 12%, transparent); }
.presentation-templates-search input { flex: 1; min-width: 0; width: 100%; padding: 7px 0; border: 0; outline: none; background: transparent; color: var(--ui-text); font: inherit; }
.presentation-templates-search input::placeholder { color: var(--ui-muted); }
.presentation-templates-search input::-webkit-search-cancel-button { display: none; }
.presentation-templates-search .presentation-templates-icon-button { flex: none; width: 24px; height: 24px; }
.presentation-templates-results { margin: 0 0 12px; color: var(--ui-muted); font-size: 11px; }
.presentation-templates-filters { display: flex; padding: 3px; gap: 2px; border-radius: 7px; background: var(--ui-surface-muted); }
.presentation-templates-filters button { flex: 1; padding: 5px 2px; border: 0; border-radius: 5px; background: transparent; color: var(--ui-muted); }
.presentation-templates-filters button[aria-pressed="true"] { background: var(--ui-surface); color: var(--ui-text); font-weight: 550; box-shadow: 0 1px 3px #10182810; }
.presentation-templates-filters button:hover { color: var(--ui-accent); }
.presentation-templates-list { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 13px 14px 5px; }
.presentation-template-group + .presentation-template-group { margin-top: 20px; }
.presentation-template-group-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; color: var(--ui-muted); }
.presentation-template-group-heading h3 { font-size: 11px; font-weight: 550; margin: 0; }
.presentation-template-group-heading > span { padding: 0 6px; min-width: 10px; border-radius: 4px; background: var(--ui-surface-muted); text-align: center; font-size: 10px; font-variant-numeric: tabular-nums; }
.presentation-template-card { position: relative; margin-bottom: 12px; }
.presentation-template-select { display: block; width: 100%; padding: 0; border: 1px solid var(--ui-line); border-radius: 8px; background: var(--ui-surface); color: var(--ui-text); overflow: hidden; text-align: left; }
.presentation-template-select:hover:not(:disabled) { border-color: color-mix(in srgb, var(--ui-accent) 50%, var(--ui-line)); box-shadow: 0 3px 10px #1821360a; }
.presentation-template-preview { position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; border-bottom: 1px solid var(--ui-line); background: var(--ui-surface-muted); color: var(--template-accent, var(--ui-accent)); }
.presentation-template-preview > img, .presentation-template-placeholder { display: block; width: 100%; height: 100%; object-fit: contain; }
.presentation-template-page-count { position: absolute; bottom: 7px; left: 8px; border: 1px solid #dfe4ed99; padding: 1px 5px; border-radius: 4px; background: #fffffff2; color: #414c60; font-size: 10px; font-weight: 500; }
.presentation-template-use { position: absolute; right: 8px; bottom: 7px; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; background: var(--ui-surface); color: var(--ui-accent); opacity: 0; }
.presentation-template-select:hover:not(:disabled) .presentation-template-use, .presentation-template-select:focus-visible .presentation-template-use { opacity: 1; }
.presentation-template-details { display: block; padding: 9px 10px 10px; }
.presentation-template-details.has-delete { padding-right: 40px; }
.presentation-template-details > strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.presentation-template-description { display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--ui-muted); }
.presentation-template-delete { position: absolute; bottom: 16px; right: 7px; }
.presentation-template-delete:hover:not(:disabled) { color: var(--ui-danger); background: var(--ui-danger-soft); }
.presentation-templates-empty { display: flex; align-items: center; flex-direction: column; padding: 21px 14px; border: 1px dashed var(--ui-line); border-radius: 8px; color: var(--ui-muted); text-align: center; }
.presentation-templates-empty strong { margin-top: 9px; font-size: 12px; font-weight: 500; color: var(--ui-text); }
.presentation-templates-empty p { margin: 6px 0 0; max-width: 205px; font-size: 11px; line-height: 1.7; }
.presentation-templates-error { margin-bottom: 12px; padding: 10px; border: 1px solid color-mix(in srgb, var(--ui-danger) 25%, var(--ui-line)); border-radius: 7px; background: var(--ui-danger-soft); color: var(--ui-danger); overflow-wrap: anywhere; }
.presentation-templates-error p { margin: 0 0 7px; }
.presentation-templates-error button { padding: 3px 7px; border: 1px solid currentColor; border-radius: 5px; color: inherit; background: transparent; }
.presentation-templates-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 0 20px; color: var(--ui-muted); }
.presentation-templates-spinner { width: 14px; height: 14px; border: 2px solid var(--ui-line); border-top-color: var(--ui-accent); border-radius: 50%; animation: presentation-template-spin .8s linear infinite; }
.presentation-templates-footer { display: flex; flex: none; align-items: center; gap: 6px; padding: 9px 14px; border-top: 1px solid var(--ui-line); color: var(--ui-muted); font-size: 10px; }
@keyframes presentation-template-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .presentation-templates-spinner { animation: none; } }
</style>
