<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
type IconPath = { d: string; fill?: string; stroke?: string; opacity?: string; 'fill-opacity'?: string }

// These bundled, original SVG assets contain paths only. Render their allowed
// attributes through Vue so no SVG markup or event attributes become raw HTML.
const sources = import.meta.glob<string>('../icons/svg/shell/*.svg', { query: '?raw', import: 'default', eager: true })
const icons: Record<string, IconPath[]> = Object.fromEntries(Object.entries(sources).map(([file, source]) => {
  const paths = [...source.matchAll(/<path\s+([^>]+)\/?\s*>/g)].map(([, attributes]) => {
    const values = Object.fromEntries([...attributes!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]))
    const path: IconPath = { d: values.d ?? '' }
    for (const key of ['fill', 'stroke', 'opacity', 'fill-opacity'] as const) {
      if (values[key] !== undefined) path[key] = values[key] === '#5b73e8' ? 'var(--ui-accent, #5b73e8)' : values[key]
    }
    return path
  })
  return [file.split('/').at(-1)!.replace(/\.svg$/, ''), paths]
}))
const paths = computed(() => icons[props.name] ?? icons.file ?? [])
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-for="(path, index) in paths" :key="index" v-bind="path" />
  </svg>
</template>
