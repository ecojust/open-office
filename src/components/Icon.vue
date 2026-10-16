<script setup lang="ts">
import { computed } from 'vue'
import aliases from '../icons/shell-aliases'
import { iconDrawing } from '../icons/drawing'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 })

// These bundled, original SVG assets contain paths only. Render their allowed
// attributes through Vue so no SVG markup or event attributes become raw HTML.
const sources = import.meta.glob<string>('../icons/svg/shell/*.svg', { query: '?raw', import: 'default', eager: true })
const drawings = { ...Object.fromEntries(Object.entries(sources).map(([file, source]) => [file.split('/').at(-1)!.replace(/\.svg$/, ''), source])), ...aliases }
const icons = Object.fromEntries(Object.entries(drawings).map(([name, source]) => [name, iconDrawing(source)]))
const drawing = computed(() => icons[props.name] ?? icons.file!)
</script>

<template>
  <svg class="ui-icon" :data-icon="name" :width="size" :height="size" viewBox="0 0 24 24" v-bind="drawing.paint" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-for="(path, index) in drawing.paths" :key="index" v-bind="path" />
  </svg>
</template>
