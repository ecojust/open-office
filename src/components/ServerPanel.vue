<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { useDialogFocus } from '../shared/dialog-focus'

const props = defineProps<{
  desktop: boolean
  running: boolean
  pending: boolean
  localUrl?: string | null
  lanUrls: string[]
  documents: { id: string; name: string; version: number }[]
  notice: string
  error: string
}>()
const emit = defineEmits<{
  close: []
  start: []
  stop: []
  copy: [url: string]
  'open-document': [id: string]
}>()
const dialog = ref<HTMLElement>()
useDialogFocus(dialog)

function webUrl(value?: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? value : null
  } catch { return null }
}

const localLink = computed(() => webUrl(props.localUrl))
const networkLinks = computed(() => [...new Set(props.lanUrls)].filter(url => webUrl(url)))
const status = computed(() => {
  if (props.pending) return '正在处理…'
  if (props.desktop) return props.running ? '运行中' : '未启动'
  return props.running ? '已连接' : '已断开'
})
</script>

<template>
  <div class="server-backdrop" @click.self="emit('close')" @keydown.esc.stop.prevent="emit('close')">
    <section ref="dialog" class="server-panel" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="server-panel-title" aria-describedby="server-panel-description" data-testid="server-panel">
      <header class="server-heading">
        <span class="server-emblem"><Icon name="monitor" :size="25" /></span>
        <div class="server-heading-copy">
          <h2 id="server-panel-title">{{ desktop ? 'Server · 工作区共享' : 'Server · 连接工作区' }}</h2>
          <p id="server-panel-description">{{ desktop ? '在浏览器中继续编辑这台电脑的文档。' : '通过浏览器编辑客户端的共享文档。' }}</p>
        </div>
        <button type="button" class="server-close" aria-label="关闭 Server 面板" data-testid="server-close" @click="emit('close')"><Icon name="close" :size="20" /></button>
      </header>

      <div class="server-body">
        <div class="server-status-row">
          <span class="server-status" :class="{ connected: running, pending }" role="status" data-testid="server-status"><i aria-hidden="true" />{{ status }}</span>
          <span class="server-status-caption">{{ desktop ? '由本机提供服务' : '连接到桌面客户端' }}</span>
        </div>

        <div v-if="notice" class="server-message" role="status" data-testid="server-notice"><Icon name="check" :size="17" /><span>{{ notice }}</span></div>
        <div v-if="error" class="server-message error" role="alert" data-testid="server-error"><Icon name="info" :size="17" /><span>{{ error }}</span></div>

        <div v-if="desktop && !running" class="server-start-state">
          <h3>一个链接，直接进入工作区</h3>
          <p>启动 Server 后，可以在本机或同一局域网的浏览器中打开链接，无需配对码。</p>
          <button type="button" class="server-button primary" :disabled="pending" data-testid="server-start" @click="emit('start')"><Icon name="link" :size="17" />{{ pending ? '正在启动…' : '启动 Server' }}</button>
        </div>

        <section v-if="desktop && running" class="server-section" aria-labelledby="server-links-heading">
          <div class="server-section-heading"><h3 id="server-links-heading">访问链接</h3><span>点击打开或复制分享</span></div>
          <div class="server-links">
            <div v-if="localLink" class="server-link-row">
              <Icon name="monitor" :size="19" />
              <div class="server-link-copy"><span class="server-link-label">本机访问</span><a :href="localLink" target="_blank" rel="noopener noreferrer" data-testid="server-local-url">{{ localLink }}</a></div>
              <button type="button" class="server-copy" aria-label="复制本机访问链接" data-testid="server-copy-local" @click="emit('copy', localLink!)">复制链接</button>
            </div>
            <div v-for="(url, index) in networkLinks" :key="url" class="server-link-row">
              <Icon name="link" :size="19" />
              <div class="server-link-copy"><span class="server-link-label">局域网访问{{ networkLinks.length > 1 ? ` · ${index + 1}` : '' }}</span><a :href="url" target="_blank" rel="noopener noreferrer" data-testid="server-lan-url">{{ url }}</a></div>
              <button type="button" class="server-copy" :aria-label="`复制局域网访问链接 ${index + 1}`" data-testid="server-copy-lan" @click="emit('copy', url)">复制链接</button>
            </div>
          </div>
          <p v-if="!localLink && !networkLinks.length" class="server-empty-text">服务已启动，正在获取访问链接。</p>
          <p v-else-if="!networkLinks.length" class="server-empty-text">暂未获取到局域网地址，可以先使用本机链接。</p>
        </section>

        <section v-if="running || !desktop" class="server-section" aria-labelledby="server-documents-heading">
          <div class="server-section-heading"><h3 id="server-documents-heading">已同步文档 <span class="server-count">{{ documents.length }}</span></h3><span v-if="running && documents.length">点击打开</span></div>
          <ul v-if="documents.length" class="server-documents" data-testid="server-documents">
            <li v-for="document in documents" :key="document.id">
              <button type="button" :disabled="pending || !running" :aria-label="`打开文档 ${document.name}`" data-testid="server-document" @click="emit('open-document', document.id)">
                <span class="server-file-icon"><Icon name="file" :size="19" /></span>
                <span class="server-document-copy"><strong :title="document.name">{{ document.name }}</strong><span>同步版本 {{ document.version }}</span></span>
                <Icon name="chevron" :size="17" />
              </button>
            </li>
          </ul>
          <div v-else class="server-empty"><Icon name="folder" :size="25" /><p>暂无已同步文档</p><span>{{ desktop ? '在客户端打开或新建文档后，会显示在这里。' : running ? '在客户端打开文档后，即可在这里继续编辑。' : '连接恢复后，可以查看工作区中的文档。' }}</span></div>
          <p v-if="!desktop && !running" class="server-empty-text">连接已断开，请确认桌面应用和 Server 仍在运行，并检查网络连接。</p>
        </section>

        <div class="server-notes">
          <Icon name="info" :size="17" />
          <div><p>浏览器中的编辑会自动同步到客户端工作区；写入原文件由客户端的保存操作控制。</p><p>持有访问链接的人可访问此工作区。桌面应用需保持运行；HTTP 链接适用于可信的局域网。</p></div>
        </div>
      </div>

      <footer class="server-footer">
        <span>{{ desktop && running ? '停止服务后，浏览器将断开连接。' : desktop ? '启动后可随时停止共享。' : '原文件由桌面客户端管理。' }}</span>
        <button v-if="desktop && running" type="button" class="server-button stop" :disabled="pending" data-testid="server-stop" @click="emit('stop')">{{ pending ? '正在停止…' : '停止 Server' }}</button>
        <button v-else type="button" class="server-button" @click="emit('close')">完成</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.server-backdrop { position: fixed; inset: 0; z-index: 110; display: grid; place-items: center; padding: 24px; background: #17233366; }
.server-panel { display: flex; flex-direction: column; width: min(660px, 100%); max-height: calc(100dvh - 48px); overflow: hidden; border: 1px solid var(--ui-line-strong); border-radius: 12px; background: var(--ui-surface); color: var(--ui-text); box-shadow: 0 24px 80px #0003; }
.server-heading { display: flex; align-items: flex-start; gap: 14px; padding: 25px 25px 22px; border-bottom: 1px solid var(--ui-line); }
.server-emblem { display: grid; place-items: center; width: 46px; height: 46px; flex: none; border: 1px solid var(--ui-line); border-radius: 10px; background: var(--ui-accent-soft); color: var(--ui-accent); }
.server-heading-copy { min-width: 0; flex: 1; padding-top: 1px; }
.server-heading h2 { margin: 0 0 5px; font-size: 19px; font-weight: 650; letter-spacing: -.3px; }
.server-heading p { margin: 0; color: var(--ui-muted); font-size: 12px; line-height: 1.7; }
.server-close { display: grid; place-items: center; flex: none; width: 30px; height: 30px; padding: 0; border-radius: 5px; color: var(--ui-muted); }
.server-close:hover { color: var(--ui-text); background: var(--ui-surface-muted); }
.server-body { min-height: 0; overflow: auto; padding: 22px 25px; }
.server-status-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
.server-status { display: inline-flex; align-items: center; gap: 7px; padding: 4px 9px; border-radius: 5px; background: var(--ui-surface-muted); color: var(--ui-muted); font-size: 12px; font-weight: 600; }
.server-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.server-status.connected { color: var(--ui-success); background: var(--ui-success-soft); }
.server-status.pending { color: var(--ui-warning); background: var(--ui-warning-soft); }
.server-status-caption, .server-section-heading > span { font-size: 11px; color: var(--ui-subtle); }
.server-message { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; margin-bottom: 14px; border-radius: var(--ui-radius); background: var(--ui-success-soft); color: var(--ui-success); font-size: 12px; overflow-wrap: anywhere; }
.server-message svg { flex: none; margin-top: 1px; }
.server-message.error { color: var(--ui-danger); background: var(--ui-danger-soft); }
.server-start-state { padding: 24px; margin-bottom: 20px; border: 1px solid var(--ui-line); border-radius: 9px; background: var(--ui-surface-muted); }
.server-start-state h3 { margin: 0 0 9px; font-size: 17px; font-weight: 600; }
.server-start-state p { margin: 0 0 18px; max-width: 440px; color: var(--ui-muted); font-size: 13px; line-height: 1.85; }
.server-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 8px 14px; border: 1px solid var(--ui-line-strong); border-radius: var(--ui-radius); background: var(--ui-surface); font-size: 12px; font-weight: 600; }
.server-button:hover:not(:disabled) { background: var(--ui-surface-muted); }
.server-button.primary { border-color: var(--ui-accent); background: var(--ui-accent); color: var(--ui-on-accent); }
.server-button.primary:hover:not(:disabled) { background: var(--ui-accent); }
.server-button.stop { color: var(--ui-danger); }
.server-button.stop:hover:not(:disabled) { background: var(--ui-danger-soft); }
.server-section { margin-bottom: 22px; }
.server-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.server-section-heading h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 650; }
.server-count { min-width: 22px; padding: 1px 6px; border-radius: 4px; background: var(--ui-surface-muted); color: var(--ui-muted); font-size: 10px; text-align: center; font-variant-numeric: tabular-nums; }
.server-links { border: 1px solid var(--ui-line); border-radius: 8px; overflow: hidden; }
.server-links:empty { display: none; }
.server-link-row { display: flex; align-items: center; gap: 12px; padding: 13px 14px; }
.server-link-row + .server-link-row { border-top: 1px solid var(--ui-line); }
.server-link-row > svg { flex: none; color: var(--ui-muted); }
.server-link-copy { min-width: 0; flex: 1; }
.server-link-label { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 600; color: var(--ui-muted); }
.server-link-copy a { display: block; width: fit-content; max-width: 100%; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; text-decoration: none; line-height: 1.7; }
.server-link-copy a:hover { text-decoration: underline; }
.server-copy { flex: none; padding: 6px 9px; border: 1px solid var(--ui-line); border-radius: 5px; background: var(--ui-surface-muted); color: var(--ui-text); font-size: 11px; }
.server-copy:hover { color: var(--ui-accent); border-color: var(--ui-line-strong); }
.server-documents { padding: 0; margin: 0; list-style: none; border: 1px solid var(--ui-line); border-radius: 8px; overflow: hidden; }
.server-documents li + li { border-top: 1px solid var(--ui-line); }
.server-documents button { display: flex; align-items: center; gap: 11px; width: 100%; padding: 12px 14px; text-align: left; }
.server-documents button:hover:not(:disabled) { background: var(--ui-surface-muted); }
.server-file-icon { display: grid; place-items: center; width: 34px; height: 36px; flex: none; border-radius: 6px; background: var(--ui-accent-soft); color: var(--ui-accent); }
.server-document-copy { display: grid; gap: 3px; flex: 1; min-width: 0; }
.server-document-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 550; }
.server-document-copy > span { color: var(--ui-subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
.server-documents button > svg { flex: none; color: var(--ui-subtle); }
.server-empty { padding: 23px 14px; text-align: center; border: 1px dashed var(--ui-line-strong); border-radius: 8px; color: var(--ui-subtle); }
.server-empty > svg { display: block; margin: 0 auto 9px; }
.server-empty p { margin: 0 0 4px; color: var(--ui-muted); font-size: 12px; }
.server-empty > span { font-size: 11px; line-height: 1.7; }
.server-empty-text { margin: 10px 0 0; color: var(--ui-muted); font-size: 11px; line-height: 1.8; }
.server-notes { display: flex; align-items: flex-start; gap: 9px; padding-top: 17px; border-top: 1px solid var(--ui-line); color: var(--ui-muted); }
.server-notes > svg { flex: none; margin-top: 2px; color: var(--ui-subtle); }
.server-notes p { margin: 0; font-size: 11px; line-height: 1.85; }
.server-notes p + p { margin-top: 5px; }
.server-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 25px; border-top: 1px solid var(--ui-line); background: var(--ui-surface-muted); }
.server-footer > span { color: var(--ui-muted); font-size: 11px; line-height: 1.7; }
.server-footer > button { flex: none; }
@media (max-width: 540px) {
  .server-backdrop { padding: 12px; }
  .server-panel { max-height: calc(100dvh - 24px); }
  .server-heading { padding: 20px 17px; gap: 10px; }
  .server-heading h2 { font-size: 16px; }
  .server-emblem { width: 39px; height: 39px; }
  .server-body { padding: 18px 17px; }
  .server-link-row { display: grid; grid-template-columns: 19px minmax(0, 1fr); gap: 9px; padding: 12px; }
  .server-copy { grid-column: 2; justify-self: start; }
  .server-start-state { padding: 19px; }
  .server-footer { padding: 14px 17px; }
  .server-status-caption { font-size: 10px; }
}
</style>
