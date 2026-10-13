<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PptxPresentation, patchPptxPackage } from '../presentation/pptx-package'
type Slide = PptxPresentation['slides'][number]
type Patch = Omit<Parameters<typeof patchPptxPackage>[1]['slides'][number], 'slideIndex'>
const props = defineProps<{slide: Slide | null; pageId: string; enabled: boolean; busy: boolean}>()
const emit = defineEmits<{edit: [patch: Patch]; 'draft-change': [pending: boolean]; error: [message: string]}>()
const type = ref('none'), duration = ref(0.7), automatic = ref(false), after = ref(5), direction = ref('l')
const baseline = ref(''), mediaInput = ref<HTMLInputElement>(), start = ref<'click'|'auto'>('click'), loop = ref(false)
const signature = () => JSON.stringify([type.value, duration.value, automatic.value, after.value, direction.value])
const pending = computed(() => signature() !== baseline.value)
const scope = ref('')
let submitted = ''
const stale = computed(() => pending.value && scope.value !== props.pageId)
function reset() {
  const transition = props.slide?.transition
  type.value = transition?.type || 'none'; duration.value = (transition?.durationMs ?? 700) / 1000
  automatic.value = transition?.advanceAfterMs != null; after.value = (transition?.advanceAfterMs ?? 5000) / 1000
  direction.value = transition?.direction || 'l'; baseline.value = signature()
  scope.value = props.pageId; submitted = ''
}
watch(() => [props.pageId, props.slide] as const, () => {
  if (!baseline.value || !pending.value || props.pageId === scope.value && submitted === signature()) reset()
}, {immediate: true})
watch(pending, value => emit('draft-change', value))
function apply() {
  if (stale.value) { emit('error', '正在编辑的页面已变化，请先还原输入，再编辑当前页。'); return }
  if (!Number.isFinite(duration.value) || duration.value < 0 || duration.value > 10 || !Number.isFinite(after.value) || after.value < 0.1 || after.value > 3600) {
    emit('error', '切换时长应为 0–10 秒，自动换片等待应为 0.1–3600 秒。'); return
  }
  submitted = signature()
  const effectDirection = type.value === 'split' ? {direction:'out' as const,orientation:'vert' as const}
    : ['push','wipe','cover','uncover'].includes(type.value) ? {direction:direction.value as NonNullable<Patch['transition']>['direction']} : {}
  emit('edit', {transition: {type: type.value as NonNullable<Patch['transition']>['type'], durationMs: Math.round(duration.value * 1000), advanceAfterMs: automatic.value ? Math.round(after.value * 1000) : null, advanceOnClick: true, ...effectDirection}})
}
async function insert(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file) return
  const pageId = props.pageId
  try {
    if (file.size > 20 * 1024 * 1024) throw Error('单个音视频不能超过 20 MiB；完整文稿请保持在 40 MiB 内。')
    const mime: Record<string,string> = {mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',mp4:'video/mp4',webm:'video/webm'}
    const mimeType = mime[file.name.split('.').at(-1)?.toLowerCase() || '']
    if (!mimeType) throw Error('请选择 MP3、WAV、OGG、MP4 或 WebM 文件。')
    const kind = mimeType.startsWith('audio') ? 'audio' : 'video'
    const data = new Uint8Array(await file.arrayBuffer())
    if (pageId !== props.pageId || !props.enabled || props.busy) throw Error('读取媒体期间页面已变化，请在目标页面重新选择文件。')
    emit('edit', {addMedia:[{kind, name:file.name, mimeType, data, rect:kind === 'video' ? {x:.15,y:.15,width:.7,height:.7} : {x:.05,y:.85,width:.3,height:.1}, start:start.value, loop:loop.value}]})
  } catch(error) { emit('error', error instanceof Error ? error.message : String(error)) }
}
defineExpose({hasPendingEdits: () => pending.value, discardDrafts: reset})
</script>

<template>
  <div class="presentation-effects">
    <details open>
      <summary>切换与计时</summary>
      <p v-if="stale" class="note warning">页面已变化，输入尚未应用。请先还原。</p>
      <p v-if="!enabled" class="note">另存并打开 PPTX 后，可设置内置放映效果。</p>
      <fieldset :disabled="!enabled || busy">
        <label>效果<select v-model="type" data-testid="transition-type"><option value="none">无</option><option value="fade">淡化</option><option value="push">推进</option><option value="wipe">擦除</option><option value="cover">覆盖</option><option value="uncover">揭开</option><option value="split">拆分</option><option v-if="type==='unknown'" value="unknown" disabled>原文件效果（保留）</option></select></label>
        <div class="pair"><label>时长（秒）<input v-model.number="duration" type="number" min="0" max="10" step="0.1"/></label><label>方向<select v-model="direction"><option value="l">向左</option><option value="r">向右</option><option value="u">向上</option><option value="d">向下</option></select></label></div>
        <label class="check"><input v-model="automatic" type="checkbox"/>自动换片</label>
        <label v-if="automatic">停留（秒）<input v-model.number="after" type="number" min="0.1" max="3600" step="0.5"/></label>
        <div class="actions"><button :disabled="!pending || type==='unknown' || stale" data-testid="transition-apply" @click="apply">应用切换</button><button :disabled="!pending" @click="reset">还原</button></div>
      </fieldset>
    </details>
    <details>
      <summary>本页音视频 <span>{{slide?.media.length || 0}}</span></summary>
      <p class="note">媒体嵌入 PPTX，在内置放映中播放。编辑画布不播放音视频。</p>
      <ul v-if="slide?.media.length"><li v-for="media in slide.media" :key="media.id"><strong>{{media.kind==='audio'?'音频':'视频'}} · {{media.name}}</strong><small>{{media.external?'外部链接不加载':media.start==='auto'?'进入本页播放':'点击播放'}}{{media.loop?' · 循环':''}}</small><button :disabled="busy || pending" @click="emit('edit',{removeMediaIds:[media.id]})">移除媒体</button></li></ul>
      <fieldset :disabled="!enabled || busy || pending">
        <label>播放方式<select v-model="start"><option value="click">点击播放</option><option value="auto">进入本页播放</option></select></label>
        <label class="check"><input v-model="loop" type="checkbox"/>循环播放</label>
        <input ref="mediaInput" class="file-input" type="file" accept=".mp3,.wav,.ogg,.mp4,.webm" data-testid="presentation-media-input" @change="insert"/>
        <button @click="mediaInput?.click()">嵌入本地音频 / 视频</button>
      </fieldset>
    </details>
    <p v-if="slide?.hasUnsupportedAnimations" class="note warning">本页有暂未支持的对象动画。保存时保留原动画，内置放映显示静态对象。</p>
    <p v-for="warning in slide?.warnings || []" :key="warning" class="note warning">{{warning}}</p>
  </div>
</template>

<style scoped>
.presentation-effects{font:12px/1.5 system-ui;color:#46536a;border-top:1px solid #e5e9ef;padding-top:8px}.presentation-effects details{padding:8px 0;border-bottom:1px solid #e9edf2}.presentation-effects summary{font-weight:650;cursor:pointer;color:#26364e;min-height:24px}.presentation-effects fieldset{border:0;margin:8px 0 0;padding:0;display:grid;gap:9px;min-width:0}.presentation-effects label{display:grid;gap:4px}.presentation-effects input,.presentation-effects select,.presentation-effects button{font:inherit;border:1px solid #d2d9e4;border-radius:6px;background:#fff;padding:6px;min-width:0;width:100%;color:inherit;box-sizing:border-box}.presentation-effects button{cursor:pointer;background:#f2f5fb}.presentation-effects button:disabled,.presentation-effects fieldset:disabled{opacity:.5}.pair,.actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.presentation-effects .check{display:flex;align-items:center;gap:7px}.check input{width:auto}.note{font-size:11px;color:#8190a3;line-height:1.7;margin:7px 0}.warning{color:#9a7135}.presentation-effects ul{padding:0;list-style:none}.presentation-effects li{padding:7px;background:#f1f4f8;border-radius:6px;margin:5px 0;overflow-wrap:anywhere}.presentation-effects strong,.presentation-effects small{display:block;font-size:11px}.presentation-effects .file-input{display:none}
</style>
