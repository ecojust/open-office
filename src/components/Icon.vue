<script setup lang="ts">
withDefaults(defineProps<{name:string;size?:number}>(),{size:20})
const paths:Record<string,string>={
 home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
 folder:'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z',
 file:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
 sheet:'M5 3h14v18H5z M5 9h14 M5 15h14 M11 9v12',
 presentation:'M3 4h18v12H3z M12 16v5 M8 21h8 M10 7l5 3-5 3z',
 pdf:'M6 3h8l4 4v14H6z M14 3v5h4 M9 16l3-6 3 6 M10 14h4',
 plus:'M12 5v14 M5 12h14',close:'M6 6l12 12 M18 6 6 18',
 save:'M5 3h12l4 4v14H3V3h2z M7 3v6h10V3 M7 21v-8h10v8',
 download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
 arrow:'M5 12h14 M14 7l5 5-5 5',chevron:'m8 5 7 7-7 7',
 undo:'M7 6 3 10l4 4 M3 10h11a6 6 0 0 1 0 12',
 redo:'m17 6 4 4-4 4 M21 10H10a6 6 0 0 0 0 12',
 clock:'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
 shield:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M8 12l3 3 5-6',
 info:'M12 11v6 M12 7v.1 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
 search:'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
 print:'M7 8V3h10v5 M7 17H3V8h18v9h-4 M7 13h10v8H7z M17 11h1',
 more:'M5 12h.1 M12 12h.1 M19 12h.1',
 check:'m5 12 4 4 10-10',link:'M9 15l6-6 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
 image:'M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5 M8 7h.1',
 menu:'M4 6h16 M4 12h16 M4 18h16',
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.file"/></svg></template>
