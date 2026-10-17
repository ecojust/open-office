<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { BRUSH_PRESETS } from '../core/brushes'
import { DEFAULT_STYLE, type BrushKind, type StrokeElement } from '../core/types'
import { elementToSvg } from '../core/svg'

export interface BrushSettings { kind: BrushKind; color: string; width: number; opacity: number; smoothing: number; pressure: boolean }
const props = defineProps<{ settings: BrushSettings }>()
const emit = defineEmits<{ choose: [kind: BrushKind]; change: [patch: Partial<BrushSettings>]; close: []; start: [] }>()
const colors = ['#334155', '#e05263', '#ed923b', '#f4cb45', '#3fa475', '#3988db', '#8d66d8', '#ffffff']
function preview(kind: BrushKind, width: number) {
  const points = Array.from({ length: 25 }, (_, index) => ({ x: 8 + index * 2, y: 14 + Math.sin(index / 24 * Math.PI * 2) * 5 }))
  const stroke: StrokeElement = { id: `brush-preview-${kind}`, type: 'stroke', brush: kind, points, pressures: points.map((_, index) => .25 + Math.sin(index / 24 * Math.PI) * .6), style: { ...DEFAULT_STYLE, stroke: kind === 'highlighter' ? '#e1b528' : props.settings.color === '#ffffff' ? '#8c96a7' : props.settings.color, fill: 'none', strokeWidth: Math.min(width, 12) }, locked: false }
  return elementToSvg(stroke, { elements: [stroke], background: '#ffffff', grid: false })
}
function numeric(event: Event, key: 'width' | 'opacity' | 'smoothing', min: number, max: number) {
  const input = event.target as HTMLInputElement, value = input.value.trim() ? Number(input.value) : NaN
  if (!Number.isFinite(value)) { input.value = String(props.settings[key]); return }
  emit('change', { [key]: Math.max(min, Math.min(max, value)) })
}
</script>

<template>
  <section class="brush-panel" role="region" aria-label="笔触设置" data-testid="brush-settings-panel" @keydown.escape.stop="emit('close')">
    <div class="brush-heading"><strong>自定义笔触</strong><span>用于接下来绘制的笔迹</span><button aria-label="关闭笔触设置" @click="emit('close')"><AppIcon name="close" :size="16" /></button></div>
    <div class="brush-presets" role="group" aria-label="笔触类型">
      <button v-for="preset in BRUSH_PRESETS" :key="preset.id" :aria-pressed="settings.kind === preset.id" :data-testid="`brush-${preset.id}`" @click="emit('choose', preset.id)"><svg viewBox="0 0 64 28" aria-hidden="true" v-html="preview(preset.id, preset.width)" /><span>{{ preset.label }}</span></button>
    </div>
    <div class="brush-colors" role="group" aria-label="画笔颜色"><button v-for="color in colors" :key="color" :style="{ background: color }" :aria-label="`画笔颜色 ${color}`" :aria-pressed="settings.color === color" :disabled="settings.kind === 'rainbow'" :data-testid="`brush-color-${color.slice(1)}`" @click="emit('change', { color })"><AppIcon v-if="settings.color === color" name="check" :size="14" :style="{ color: ['#ffffff', '#f4cb45'].includes(color) ? '#334155' : '#ffffff' }" /></button><input :disabled="settings.kind === 'rainbow'" aria-label="自定义画笔颜色" data-testid="brush-color" type="color" :value="settings.color" @input="emit('change', { color: ($event.target as HTMLInputElement).value })" /></div>
    <div class="brush-setting"><label for="brush-width">粗细</label><input id="brush-width" data-testid="brush-width" type="number" min="1" max="100" step="0.5" :value="settings.width" @change="numeric($event, 'width', 1, 100)" /><span>px</span></div>
    <div class="brush-setting"><label for="brush-opacity">不透明度</label><input id="brush-opacity" data-testid="brush-opacity" type="range" min="0.05" max="1" step="0.05" :value="settings.opacity" @input="numeric($event, 'opacity', .05, 1)" /><output for="brush-opacity">{{ Math.round(settings.opacity * 100) }}%</output></div>
    <div class="brush-setting"><label for="brush-smoothing">平滑</label><input id="brush-smoothing" data-testid="brush-smoothing" type="range" min="0" max="1" step="0.1" :value="settings.smoothing" @input="numeric($event, 'smoothing', 0, 1)" /><output for="brush-smoothing">{{ settings.smoothing ? `${Math.round(settings.smoothing * 100)}%` : '关闭' }}</output></div>
    <div class="brush-setting"><span id="brush-pressure-label">触笔压感</span><button class="brush-switch" role="switch" aria-labelledby="brush-pressure-label" :aria-checked="settings.pressure" data-testid="brush-pressure" @click="emit('change', { pressure: !settings.pressure })"><svg viewBox="0 0 32 18" width="32" height="18" aria-hidden="true"><rect x="1" y="1" width="30" height="16" rx="8" fill="currentColor" /><circle :cx="settings.pressure ? 23 : 9" cy="9" r="6" fill="white" /></svg></button></div>
    <p>{{ settings.kind === 'rainbow' ? '彩虹笔沿轨迹变换颜色，支持触笔压感，不使用单色设置。' : '鼠标按稳定力度绘制；支持压感的触笔可随力度变化。' }}</p>
    <button class="brush-start" data-testid="brush-start" @click="emit('start')"><AppIcon name="pen" :size="16" />开始绘制</button>
  </section>
</template>

<style scoped>
.brush-panel{width:288px;max-width:calc(100vw - 40px);max-height:calc(100dvh - 240px);overflow:auto;box-sizing:border-box;padding:14px;border:1px solid var(--ui-line);border-radius:var(--ui-radius);background:var(--ui-surface);box-shadow:0 10px 32px #18203922;color:var(--ui-text);font-size:11px}.brush-panel button,.brush-panel input{font:inherit;color:inherit}.brush-panel button{cursor:pointer}.brush-heading{display:flex;align-items:center;gap:8px;margin-bottom:12px}.brush-heading strong{font-size:12px}.brush-heading span{flex:1;color:var(--ui-muted);font-size:10px}.brush-heading button{display:grid;place-items:center;width:24px;height:24px;border:0;background:transparent;border-radius:5px}.brush-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.brush-presets button{display:flex;flex-direction:column;align-items:center;gap:2px;border:1px solid var(--ui-line);border-radius:7px;background:var(--ui-bg);padding:6px 3px;font-size:10px}.brush-presets button[aria-pressed=true]{border-color:var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent)}.brush-presets svg{display:block;width:64px;max-width:100%;height:28px}.brush-colors{display:flex;gap:4px;align-items:center;margin:13px 0}.brush-colors button{display:grid;place-items:center;padding:0;width:23px;height:23px;flex-shrink:0;border:1px solid #64748b44;border-radius:50%}.brush-colors button[aria-pressed=true]{outline:2px solid var(--ui-accent);outline-offset:2px}.brush-colors input{width:28px;height:25px;min-width:0;flex:1;border:1px solid var(--ui-line);border-radius:5px;padding:2px;background:var(--ui-bg)}.brush-setting{display:flex;align-items:center;gap:8px;min-height:30px;margin:7px 0}.brush-setting>label,.brush-setting>span:first-child{flex:1;min-width:64px;color:var(--ui-muted)}.brush-setting input[type=number]{box-sizing:border-box;width:64px;height:27px;padding:3px 6px;border:1px solid var(--ui-line);border-radius:5px;background:var(--ui-bg)}.brush-setting input[type=range]{width:112px;min-width:0;accent-color:var(--ui-accent)}.brush-setting output{width:32px;text-align:right;font-size:10px}.brush-setting>span:last-child{font-size:10px;color:var(--ui-muted)}.brush-switch{display:grid;place-items:center;border:0;background:none;padding:3px;color:var(--ui-muted)!important}.brush-switch[aria-checked=true]{color:var(--ui-accent)!important}.brush-panel p{line-height:1.7;color:var(--ui-muted);font-size:10px;margin:10px 0}.brush-start{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:8px;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-bg)}.brush-panel button:disabled,.brush-panel input:disabled{opacity:.4;cursor:default}.brush-panel :focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
</style>
