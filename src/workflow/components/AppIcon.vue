<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/Icon.vue'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 })
const paths: Record<string, string> = {
  select: 'M8 3H3v5m0 8v5h5m8 0h5v-5m0-8V3h-5M8 8h8v8H8z',
  svg: 'M8 3h8v5H8zM3 16h5v5H3zM16 16h5v5h-5zM12 8v4M5.5 16v-4h13v4',
  'selection-svg': 'M7 3H3v4m0 10v4h4m10 0h4v-4m0-10V3h-4M8 9l-3 3 3 3m8-6 3 3-3 3m-3-7-2 10',
  'selection-image': 'M7 3H3v4m0 10v4h4m10 0h4v-4m0-10V3h-4M7 15l4-4 6 6H7zM15 7h.01',
  brushes: 'M5 20V10h4v10M5 10l2-7 2 7M14 20V9h5v11M14 9V4h5v5M5 16h4m5-2h5',
  laser: 'm4 16 4 4 7-7-4-4zM13 5l1-3m4 6 3-1m-4 6 3 1M6 17l6-6',
  canvas: 'M4 7V4h3m10 0h3v3m0 10v3h-3M7 20H4v-3M8 8h8v8H8z',
  'brace-left': 'M16 3h-2c-3 0-3 2-3 4v1c0 2-1 3-4 4 3 1 4 2 4 4v1c0 2 0 4 3 4h2',
  'brace-right': 'M8 3h2c3 0 3 2 3 4v1c0 2 1 3 4 4-3 1-4 2-4 4v1c0 2 0 4-3 4H8',
  'brace-top': 'M3 16v-2c0-3 2-3 4-3h1c2 0 3-1 4-4 1 3 2 4 4 4h1c2 0 4 0 4 3v2',
  'brace-bottom': 'M3 8v2c0 3 2 3 4 3h1c2 0 3 1 4 4 1-3 2-4 4-4h1c2 0 4 0 4-3V8',
  'edge-straight': 'M4 18 20 6', 'edge-orthogonal': 'M4 18h7V6h9',
  'arrow-none': 'M4 12h16', 'arrow-end': 'M4 12h16m-5-5 5 5-5 5', 'arrow-both': 'M4 12h16M9 7l-5 5 5 5m6-10 5 5-5 5',
  'auto-layout': 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4M3 2v4M1 4h4',
  'grid-dots': 'M5 5h.01M12 5h.01M19 5h.01M5 12h.01M12 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01',
  triangle: 'm12 3 10 18H2z', hexagon: 'm7 3 10 0 5 9-5 9H7l-5-9z', star: 'm12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z', parallelogram: 'M7 4h15l-5 16H2z',
  cylinder: 'M3 6c0-4 18-4 18 0s-18 4-18 0v12c0 4 18 4 18 0V6', cloud: 'M6 18a4 4 0 1 1-.5-8A6 6 0 0 1 17 7a5.5 5.5 0 0 1 1 11z',
  palette: 'M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2a4 4 0 0 0 3-4 9 9 0 0 0-9-7M7 8h.01M12 6h.01M17 9h.01M6 13h.01',
  'rotate-left': 'M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2', 'rotate-right': 'M21 10a9 9 0 1 0-1 7M21 4v6h-6M12 7v5l-3 2',
  requirement: 'M5 3h14v18H5zM8 7h8m-8 5 2 2 3-4m1 4h2m-8 4h8', c4: 'M2 3h20v18H2zM5 7h14v11H5zM8 11h8v4H8z', architecture: 'M8 3h8v5H8zM2 16h6v5H2zM16 16h6v5h-6zM12 8v4M5 16v-4h14v4M9 19h6',
  sankey: 'M2 4h4v16H2zM18 2h4v6h-4zM18 16h4v6h-4zM6 7c6 0 6-3 12-3M6 11c6 0 6-5 12-5M6 13c6 0 6 5 12 5M6 17c6 0 6 3 12 3',
  radar: 'm12 2 10 7-4 12H6L2 9zm0 0v10m10-3-10 3m6 9-6-9M6 21l6-9M2 9l10 3m0-6 6 5-3 6H8l-2-6z', treemap: 'M3 3h18v18H3zM12 3v18M3 13h9M12 9h9m-9 6h9m-5-6v6',
  block: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h18v7H3zM10 6h4M7 10v4m10-4v4', packet: 'M2 5h20v14H2zM2 10h20M2 15h20M7 5v5m5-5v5m5-5v5M10 10v5m6-5v5M7 15v4m10-4v4',
  highlighter: 'm15 3 6 6-9 9-6-6zM6 12l-3 6 3 3 6-3M2 22h12M12 6l6 6', eraser: 'm14 3 7 7-11 11H6L2 17zM7 12l7 7M10 21h12',
  layers: 'm12 3 10 5-10 5L2 8zm-9 9 9 5 9-5M3 17l9 5 9-5', group: 'M3 3h6v6H3zM15 15h6v6h-6zM15 3h6v6h-6zM3 15h6v6H3zM9 6h6M6 9v6m12-6v6m-9 3h6', ungroup: 'M2 2h7v7H2zM15 15h7v7h-7zM16 2h6v6h-6zM2 16h6v6H2zM10 14l4-4m-4 0 4 4', frame: 'M7 2v20M17 2v20M2 7h20M2 17h20',
  'align-left': 'M3 3v18M7 6h14v4H7zM7 14h9v4H7z', 'align-center': 'M12 2v3m0 5v4m0 5v3M3 6h18v4H3zM7 14h10v4H7z', 'align-right': 'M21 3v18M3 6h14v4H3zM8 14h9v4H8z',
  'align-top': 'M3 3h18M6 7h4v14H6zM14 7h4v9h-4z', 'align-middle': 'M2 12h3m5 0h4m5 0h3M6 3h4v18H6zM14 7h4v10h-4z', 'align-bottom': 'M3 21h18M6 3h4v14H6zM14 8h4v9h-4z',
  'distribute-horizontal': 'M3 3v18M21 3v18M6 8h4v8H6zM14 8h4v8h-4z', 'distribute-vertical': 'M3 3h18M3 21h18M8 6h8v4H8zM8 14h8v4H8z',
  minus: 'M5 12h14', fit: 'M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5M8 8h8v8H8z', expand: 'M3 9V3h6m6 0h6v6m0 6v6h-6M9 21H3v-6M3 3l6 6m6 6 6 6M21 3l-6 6m-6 6-6 6',
  lock: 'M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3M12 14v3', unlock: 'M5 10h14v11H5zM8 10V7a4 4 0 0 1 7.5-2M12 14v3',
  copy: 'M8 8h12v13H8zM16 8V3H3v13h5', duplicate: 'M7 7h14v14H7zM17 7V3H3v14h4M11 14h6m-3-3v6', paste: 'M8 5H5v16h14V5h-3M8 3h8v4H8zM9 12h6m-6 4h6',
  front: 'M4 3h16M12 17V7m-4 4 4-4 4 4M5 17v4h14v-4', forward: 'M12 20V4m-5 5 5-5 5 5M5 16h4m6 0h4', backward: 'M12 4v16m-5-5 5 5 5-5M5 8h4m6 0h4', back: 'M4 21h16M12 7v10m-4-4 4 4 4-4M5 7V3h14v4',
  grid: 'M3 3h18v18H3zM9 3v18m6-18v18M3 9h18M3 15h18', snap: 'M4 3v10a8 8 0 0 0 16 0V3h-5v10a3 3 0 0 1-6 0V3zM4 8h5m6 0h5',
  'save-as': 'M11 21H3V3h14l4 4v4M7 3v6h10V3M7 21v-8h6m2 3 4-4 3 3-4 4-4 1z', templates: 'M4 4h7v7H4zM15 4h5v7h-5zM4 15h7v5H4zM15 15h5v5h-5z',
  flowchart: 'M8 2h8v5H8zM12 7v4m-8 0h16M4 11v5m16-5v5M1 16h6v5H1zM17 16h6v5h-6z', sequence: 'M3 3h6v4H3zM15 3h6v4h-6zM6 7v15m12-15v15M6 11h12m-3-2 3 2-3 2M18 17H6m3-2-3 2 3 2',
  class: 'M3 3h18v18H3zM3 9h18M3 15h18M7 6h10m-10 6h7m-7 6h8', state: 'M4 4h4v4H4zM16 16h4v4h-4zM6 8v4h12v4m-3-3 3 3 3-3M8 6h8a4 4 0 0 1 4 4v2', er: 'M2 7h6v10H2zM16 7h6v10h-6zM8 12h8m-6-3 2 3-2 3m4-6-2 3 2 3',
  gitgraph: 'M6 3v18M18 3v9c0 4-12 2-12 6M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0m12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0', pie: 'M12 3v9h9A9 9 0 0 0 12 3zM8 4a9 9 0 1 0 12 12h-12z',
  gantt: 'M3 3v18h18M7 5h9v3H7zM10 11h10v3H10zM14 17h7v3h-7z', xychart: 'M3 3v18h18M6 15l4-5 4 3 6-8M7 18v-3m4 3v-5m4 5v-3m4 3v-9', quadrant: 'M3 3h18v18H3zM12 3v18M3 12h18M7 7h.01M17 8h.01M8 16h.01M17 16h.01',
  mindmap: 'M9 9h6v6H9zM3 3h5v4H3zM16 3h5v4h-5zM3 17h5v4H3zM16 17h5v4h-5zM8 7l2 2m4 0 2-2M8 17l2-2m4 0 2 2', timeline: 'M3 12h18M6 9v6m6-6v6m6-6v6M4 3h4v4H4zM10 17h4v4h-4zM16 3h4v4h-4z',
  journey: 'M3 18h4v-6h5V6h9M3 6a2 2 0 1 0 4 0 2 2 0 0 0-4 0M17 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0M17 3l4 3-4 3', kanban: 'M3 3h18v18H3zM9 3v18M15 3v18M5 7h2m-2 4h2m4-4h2m4 0h2m-2 4h2m-2 4h2',
  'chevron-right': 'm9 6 6 6-6 6', 'chevron-up': 'm6 15 6-6 6 6', refresh: 'M3 10a9 9 0 0 1 15-6l3 3m0-5v5h-5M21 14A9 9 0 0 1 6 20l-3-3m0 5v-5h5',
  cursor: 'm5 3 4.5 16 3.2-6.3L19 9.5zM14 14l4 5', hand: 'M8 13V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 4-3 7-7 7h-1c-2 0-4-1-5-3l-4-6a2 2 0 0 1 3-2l2 2z',
  rectangle: 'M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', ellipse: 'M21 12a9 7 0 1 1-18 0 9 7 0 0 1 18 0', diamond: 'm12 3 9 9-9 9-9-9zM9 12h6', connector: 'M4 19h5V5h11m-4-4 4 4-4 4', text: 'M4 5h16M12 5v15M8 20h8M4 5v3m16-3v3', note: 'M6 3h12a2 2 0 0 1 2 2v10l-5 6H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM15 21v-6h5M8 8h8m-8 4h5', pen: 'm14 4 5 5M3 21l5-1L21 7a2 2 0 0 0-4-4L4 16zM4 16l4 4', image: 'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M17 8h.01', style: 'M4 7c3-5 5 5 8 0s5 5 8 0M4 16h16M4 20h10', sliders: 'M3 6h5m4 0h9M3 12h11m4 0h3M3 18h3m4 0h11M8 3v6m6 0v6M6 15v6', shapes: 'M4 4h7v7H4zM17 3l5 8H12zM17 15a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7M4 16l3-3 4 4-4 4z',
  plus: 'M12 5v14M5 12h14', folder: 'M3 7h7l2-3h9v15H3zM3 7V4h6l3 3', save: 'M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8',
  export: 'M12 3v12m-4-8 4-4 4 4M4 14v7h16v-7', undo: 'M9 4 3 10l6 6M3 10h10a7 7 0 0 1 7 7v3', redo: 'm15 4 6 6-6 6m6-6H11a7 7 0 0 0-7 7v3',
  home: 'm3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7', close: 'm6 6 12 12M6 18 18 6', chevron: 'm6 9 6 6 6-6',
  flow: 'M8 3h8v5H8zM8 16h8v5H8zM12 8v8M3 10h5v5H3zM16 10h5v5h-5zM5.5 10V5H8M16 5h2.5v5',
  board: 'M3 4h18v14H3zM8 22l4-4 4 4M7 8h4v5H7zM14 9h3m-3 4h3', code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 15a8 8 0 0 1-11-11 9 9 0 1 0 11 11z', monitor: 'M3 3h18v14H3zM12 17v4M8 21h8', help: 'M9 8a3 3 0 1 1 4 3c-1 1-1 2-1 3m0 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', panel: 'M3 3h18v18H3zM9 3v18m6-13-3 4 3 4',
  check: 'm5 12 4 4L19 6', alert: 'm12 3 10 18H2zM12 9v5m0 3h.01', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  rename: 'm15 3 6 6L8 22H2v-6zM12 6l6 6', arrow: 'M4 12h16m-6-6 6 6-6 6', download: 'M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4',
}
const commonIcons: Record<string, string> = { plus: 'plus', folder: 'folder', save: 'save', 'save-as': 'save-as', export: 'download', download: 'download', undo: 'undo', redo: 'redo', home: 'home', close: 'close', chevron: 'chevron-down', image: 'image', check: 'check', trash: 'trash', search: 'search', clock: 'clock', sun: 'sun', moon: 'moon', monitor: 'monitor', help: 'info' }
const commonIcon = computed(() => commonIcons[props.name])
</script>
<template>
  <Icon v-if="commonIcon" :name="commonIcon" :size="size" />
  <svg v-else class="ui-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path :d="paths[name]" /></svg>
</template>
