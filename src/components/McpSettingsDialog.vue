<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { useDialogFocus } from '../shared/dialog-focus'
import { createMcpToken, mcpClientConfig, validateMcpConfig, type McpConfig } from '../mcp/config'

const props = withDefaults(defineProps<{
  config: McpConfig
  running?: boolean
  nativeAvailable?: boolean
  saving?: boolean
  error?: string
}>(), { running: false, nativeAvailable: true, saving: false, error: '' })
const emit = defineEmits<{ save: [config: McpConfig]; close: [] }>()
const dialog = ref<HTMLElement>()
useDialogFocus(dialog)
const port = ref(String(props.config.port)), token = ref(props.config.token), allowEdits = ref(props.config.allowEdits)
const revealToken = ref(false), revealClientConfig = ref(false), localError = ref(''), copied = ref(false)
const draft = computed<McpConfig>(() => ({ port: Number(port.value), token: token.value, allowEdits: allowEdits.value }))
const validation = computed(() => validateMcpConfig(draft.value))
const clientConfig = computed(() => validation.value ? '' : mcpClientConfig(draft.value))
const displayConfig = computed(() => revealClientConfig.value ? clientConfig.value : clientConfig.value.replace(token.value, '••••••••'))
watch(() => props.config, config => {
  port.value = String(config.port); token.value = config.token; allowEdits.value = config.allowEdits
  copied.value = false; localError.value = ''
})
watch([port, token, allowEdits], () => { copied.value = false; localError.value = '' })
function close() { if (!props.saving) emit('close') }
function save() {
  if (props.saving) return
  if (validation.value) { localError.value = validation.value; return }
  emit('save', { ...draft.value })
}
function regenerate() {
  if (props.saving) return
  try { token.value = createMcpToken() } catch { localError.value = '无法生成访问密钥，请重新打开设置后重试。' }
}
async function copyConfig() {
  if (!clientConfig.value) { localError.value = validation.value ?? '请先填写有效的 MCP 设置。'; return }
  try {
    await navigator.clipboard.writeText(clientConfig.value)
    copied.value = true; localError.value = ''
  } catch { localError.value = '无法复制配置，请展开完整配置后手动复制。'; revealClientConfig.value = true }
}
</script>

<template>
  <div class="modal-backdrop mcp-settings-backdrop" @click.self="close" @keydown.esc.stop.prevent="close">
    <form ref="dialog" class="modal mcp-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-settings-title" aria-describedby="mcp-settings-summary" tabindex="-1" data-testid="mcp-settings-dialog" @submit.prevent="save">
      <button class="modal-close icon-button" type="button" aria-label="关闭 MCP 设置" data-testid="mcp-settings-close" :disabled="saving" @click="close"><Icon name="close"/></button>
      <div class="mcp-settings-heading"><span class="mcp-settings-symbol"><Icon name="link" :size="22"/></span><div><h2 id="mcp-settings-title">MCP 设置</h2><span>连接你的 AI 助手</span></div></div>
      <p id="mcp-settings-summary">让支持 MCP 的 AI 助手读取或编辑当前文档。保存设置后，在各软件的工作区开启服务；切换文档会自动关闭。</p>
      <p v-if="!nativeAvailable" class="mcp-settings-notice">MCP 服务需要在桌面版中开启。</p>
      <p v-if="running" class="mcp-settings-notice">服务正在运行。保存设置将停止当前服务，之后可在工作区重新开启。</p>
      <div class="mcp-settings-fields">
        <div class="mcp-endpoint-row">
          <div><span class="mcp-field-label">访问范围</span><div class="mcp-host-value">本机 · 127.0.0.1</div></div>
          <label for="mcp-port"><span class="mcp-field-label">端口</span><input id="mcp-port" v-model="port" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" :disabled="saving" data-testid="mcp-port" aria-describedby="mcp-port-hint"/></label>
        </div>
        <small id="mcp-port-hint">端口范围 1024–65535，默认 19780。</small>
        <label for="mcp-token" class="mcp-field-label mcp-token-label">访问密钥</label>
        <div class="mcp-token-row"><input id="mcp-token" v-model="token" :type="revealToken ? 'text' : 'password'" autocomplete="off" spellcheck="false" :disabled="saving" data-testid="mcp-token"/><button type="button" class="mcp-secondary" data-testid="mcp-token-visibility" :aria-pressed="revealToken" :disabled="saving" @click="revealToken=!revealToken">{{revealToken?'隐藏':'显示'}}</button><button type="button" class="mcp-secondary" data-testid="mcp-token-regenerate" :disabled="saving" @click="regenerate">重新生成</button></div>
        <label class="mcp-permission"><input v-model="allowEdits" type="checkbox" data-testid="mcp-allow-edits" :disabled="saving"/><span><strong>允许编辑当前文档</strong><small>{{allowEdits?'开放当前软件的内容与格式编辑，修改实时显示，可撤销，并按现有设置保存。':'关闭时仅提供读取工具。需要 AI 修改文档时，请开启此选项。'}}</small></span></label>
      </div>
      <section class="mcp-client-section" aria-labelledby="mcp-client-heading">
        <div class="mcp-client-heading"><h3 id="mcp-client-heading">AI 客户端配置</h3><button type="button" class="mcp-secondary" data-testid="mcp-copy-config" :disabled="!!validation||saving" @click="copyConfig"><Icon v-if="copied" name="check" :size="14"/><svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 8.5h9.5v12H9zM5.5 16.5H4V3.5h10V5"/></svg>{{copied?'已复制':'复制配置'}}</button></div>
        <p>将配置添加到支持 HTTP 连接的 MCP 客户端。修改后请先保存设置，再开启服务。</p>
        <pre data-testid="mcp-client-config" tabindex="0" aria-label="MCP 客户端 JSON 配置">{{displayConfig||'请填写有效端口和访问密钥后查看配置。'}}</pre>
        <button class="mcp-config-reveal" type="button" :disabled="!clientConfig||saving" :aria-expanded="revealClientConfig" @click="revealClientConfig=!revealClientConfig">{{revealClientConfig?'隐藏配置中的密钥':'显示完整配置'}}</button>
      </section>
      <p v-if="localError||error" class="mcp-settings-error" role="alert">{{localError||error}}</p>
      <span v-if="copied" class="visually-hidden" role="status">MCP 客户端配置已复制</span>
      <div class="modal-actions"><button type="button" data-testid="mcp-settings-cancel" :disabled="saving" @click="close">取消</button><button type="submit" class="primary" data-testid="mcp-settings-save" :disabled="saving">{{saving?'保存中…':'保存设置'}}</button></div>
    </form>
  </div>
</template>

<style scoped>
.mcp-settings-backdrop { background:#202b3b66; -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
:global(:root[data-theme="dark"]) .mcp-settings-backdrop { background:#090e18a6; }
.mcp-settings-dialog { width:min(580px,100%); padding:26px; box-shadow:0 24px 80px #10182838; }
.mcp-settings-heading { display:flex; align-items:center; gap:12px; margin-bottom:18px; padding-right:36px; }
.mcp-settings-symbol { display:grid; place-items:center; width:44px; height:44px; border-radius:10px; color:var(--ui-accent); background:var(--ui-accent-soft); }
.mcp-settings-heading h2 { margin:0 0 2px; }
.mcp-settings-heading span:not(.mcp-settings-symbol) { color:var(--ui-muted); font-size:12px; }
.mcp-settings-dialog p { font-size:12px; margin-bottom:16px; line-height:1.7; }
.mcp-settings-notice { padding:10px 12px; border-radius:var(--ui-radius); background:var(--ui-accent-soft); color:var(--ui-text)!important; }
.mcp-settings-fields { display:flex; flex-direction:column; }
.mcp-endpoint-row { display:grid; grid-template-columns:minmax(0,1fr) 150px; gap:16px; align-items:start; }
.mcp-field-label { display:block; font-size:12px; font-weight:600; margin-bottom:7px; }
.mcp-host-value { display:flex; align-items:center; min-height:34px; color:var(--ui-muted); font-size:12px; }
.mcp-settings-fields input:not([type="checkbox"]) { width:100%; min-height:34px; padding:7px 10px; color:var(--ui-text); background:var(--ui-surface-muted); border:1px solid var(--ui-line-strong); border-radius:var(--ui-radius); font-size:12px; }
.mcp-settings-fields small { color:var(--ui-muted); font-size:11px; line-height:1.6; }
.mcp-settings-fields>small { margin-top:6px; text-align:right; }
.mcp-token-label { margin-top:18px; }
.mcp-token-row { display:flex; align-items:center; gap:6px; }
.mcp-token-row input { flex:1; min-width:0; }
.mcp-secondary { display:inline-flex; align-items:center; justify-content:center; gap:6px; flex:none; min-height:32px; padding:6px 10px; font-size:12px; border:1px solid var(--ui-line-strong); border-radius:var(--ui-radius); background:var(--ui-surface); }
.mcp-secondary:hover:not(:disabled) { background:var(--ui-surface-muted); }
.mcp-permission { display:flex; align-items:flex-start; gap:10px; margin:20px 0; cursor:pointer; }
.mcp-permission input { width:16px; height:16px; margin:2px 0 0; flex:none; }
.mcp-permission strong,.mcp-permission small { display:block; }
.mcp-permission strong { font-size:12px; font-weight:600; margin-bottom:3px; }
.mcp-client-section { padding:16px; border:1px solid var(--ui-line); border-radius:8px; background:var(--ui-surface-muted); }
.mcp-client-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
.mcp-client-heading h3 { margin:0; font-size:13px; font-weight:600; }
.mcp-client-section p { margin:0 0 10px; font-size:11px; }
.mcp-client-section pre { max-height:168px; overflow:auto; margin:0; padding:10px; border:1px solid var(--ui-line); border-radius:var(--ui-radius); color:var(--ui-text); background:var(--ui-surface); font-size:11px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
.mcp-config-reveal { padding:8px 0 0; color:var(--ui-accent); font-size:11px; }
.mcp-settings-error { margin:14px 0 0!important; color:var(--ui-danger)!important; }
.mcp-settings-dialog .primary { color:var(--ui-on-accent); }
@media(max-width:480px) { .mcp-settings-dialog{padding:20px;} .mcp-endpoint-row{grid-template-columns:minmax(0,1fr) 110px;} .mcp-token-row{flex-wrap:wrap;} .mcp-token-row input{flex-basis:100%;} .mcp-client-section{padding:12px;} }
</style>
