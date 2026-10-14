<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PresentationModel } from '../presentation/core/types'
import { collectPresentationFonts, probeFontAvailability } from '../presentation/core/font-diagnostics'

const props = withDefaults(defineProps<{ model: PresentationModel; active?: boolean }>(), { active: true })
const substituted = ref<string[]>([]), unknown = ref<string[]>([]), truncated = ref(false)
let generation = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined
let context: CanvasRenderingContext2D | null | undefined
const cache = new Map<string, ReturnType<typeof probeFontAvailability>>()

function schedule(clearCache = false) {
  const token = ++generation
  if (timer) clearTimeout(timer)
  if (clearCache) cache.clear()
  if (!props.active || disposed) {
    substituted.value = []; unknown.value = []; truncated.value = false
    return
  }
  const source = props.model
  timer = setTimeout(async () => {
    timer = undefined
    const collected = collectPresentationFonts(source)
    if (context === undefined) {
      try { context = document.createElement('canvas').getContext('2d') } catch { context = null }
    }
    const missing: string[] = [], uncertain: string[] = []
    for (const [index, name] of collected.names.entries()) {
      if (disposed || token !== generation || source !== props.model || !props.active) return
      let status = cache.get(name)
      if (!status) {
        try { status = probeFontAvailability(name, context) } catch { status = 'unknown' }
        if (cache.size >= 128) cache.clear()
        cache.set(name, status)
      }
      if (status === 'possibly-substituted') missing.push(name)
      else if (status === 'unknown') uncertain.push(name)
      // Font probes run in small batches, leaving input and document switches responsive.
      if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0))
    }
    if (disposed || token !== generation || source !== props.model || !props.active) return
    substituted.value = missing; unknown.value = uncertain; truncated.value = collected.truncated
  }, 160)
}

const fontsChanged = () => schedule(true)
watch(() => [props.model, props.active] as const, () => schedule(), { immediate: true })
onMounted(() => {
  document.fonts?.addEventListener('loadingdone', fontsChanged)
  document.fonts?.addEventListener('loadingerror', fontsChanged)
})
onBeforeUnmount(() => {
  disposed = true; generation++
  if (timer) clearTimeout(timer)
  document.fonts?.removeEventListener('loadingdone', fontsChanged)
  document.fonts?.removeEventListener('loadingerror', fontsChanged)
  cache.clear(); context = null
})
</script>

<template>
  <details v-if="substituted.length || unknown.length || truncated" class="pe-notice pe-warning" data-testid="presentation-font-notice">
    <summary>字体兼容提示<span v-if="substituted.length">：{{ substituted.length }} 种字体可能被替代</span><span v-else>：部分字体尚未确认</span></summary>
    <p v-if="substituted.length" data-testid="presentation-substituted-fonts">可能使用替代字体：{{ substituted.join('、') }}</p>
    <p v-if="unknown.length">无法确认的字体：{{ unknown.join('、') }}</p>
    <p v-if="truncated">部分字体尚未核验。</p>
    <p>替代字体可能改变换行和版式。可安装原字体后重新打开，或选中文字框，在“字体”中选择本机字体。</p>
    <p>检测结果仅供显示参考，不会自动修改字体设置。PDF 使用随包字体，效果可能与编辑画布不同。</p>
  </details>
</template>
