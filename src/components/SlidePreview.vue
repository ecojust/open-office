<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PptxPresentation } from '../presentation/pptx-package'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{ base64: string; name: string; startPage?: number; presentation?: PptxPresentation }>()
const emit = defineEmits<{ close: []; error: [message: string] }>()
const MAX_BYTES = 100 * 1024 * 1024
const MAX_PAGES = 500
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
const root = ref<HTMLElement>(), stage = ref<HTMLElement>(), canvas = ref<HTMLCanvasElement>()
const surface = ref<HTMLElement>(), previousCanvas = ref<HTMLCanvasElement>()
const notesOpen = ref(false), blank = ref<''|'black'|'white'>(''), laser = ref(false), pointer = ref({x:0,y:0}), elapsed = ref(0)
const mediaNotice = ref(''), mediaItems = ref<Array<{id:string;kind:'audio'|'video';name:string;url:string;style:Record<string,string>;start:string;loop:boolean}>>([])
const currentSlide = computed(() => props.presentation?.slides[renderedPageIndex.value])
const clock = computed(() => `${String(Math.floor(elapsed.value/60)).padStart(2,'0')}:${String(elapsed.value%60).padStart(2,'0')}`)
let autoTimer: ReturnType<typeof setTimeout> | undefined, clockTimer: ReturnType<typeof setInterval> | undefined
let animations: Animation[] = [], mediaUrls: string[] = [], mediaTimers: Array<ReturnType<typeof setTimeout>> = []
let playbackPageIndex = -1
const previousVisible = computed(() => props.presentation ? props.presentation.slides.slice(0,pageNumber.value-1).some(slide=>!slide.hidden) : pageNumber.value>1)
const nextVisible = computed(() => props.presentation ? props.presentation.slides.slice(pageNumber.value).find(slide=>!slide.hidden) : null)
const hasNext = computed(() => props.presentation ? !!nextVisible.value : pageNumber.value<pageCount.value)
const pageNumber = ref(1), pageCount = ref(0), loading = ref(true), rendering = ref(false)
const renderedPageIndex = ref(-1)
const problem = ref(''), fullscreen = ref(false), fullscreenNotice = ref('')
const ready = computed(() => pageCount.value > 0 && !loading.value && !problem.value)
let pdf: pdfjs.PDFDocumentProxy | undefined
let documentTask: pdfjs.PDFDocumentLoadingTask | undefined
let renderTask: pdfjs.RenderTask | undefined
let observer: ResizeObserver | undefined
let loadEpoch = 0, renderEpoch = 0, resizeFrame = 0
let mounted = false, disposed = false, closing = false, intentionalFullscreenExit = false
let previousFocus: HTMLElement | null = null

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
function fail(error: unknown) {
  problem.value = `无法放映：${errorMessage(error)}`
  emit('error', problem.value)
}
function decode(base64: string): Uint8Array {
  if (!base64 || base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw Error('放映文件必须为非空 PDF，且不超过 100 MiB。')
  let binary: string
  try { binary = atob(base64) } catch { throw Error('放映文件的 Base64 数据无效。') }
  if (!binary.length || binary.length > MAX_BYTES) throw Error('放映文件必须为非空 PDF，且不超过 100 MiB。')
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
function cancelRender() {
  renderEpoch++
  renderTask?.cancel()
}
async function loadDocument() {
  if (!mounted || disposed) return
  const epoch = ++loadEpoch
  cancelRender()
  for (const animation of animations) animation.cancel(); animations=[]
  for (const url of mediaUrls) URL.revokeObjectURL(url); mediaUrls=[]; mediaItems.value=[]
  if(previousCanvas.value){previousCanvas.value.width=1;previousCanvas.value.height=1;previousCanvas.value.style.visibility='hidden'}
  const oldTask = documentTask
  documentTask = undefined; pdf = undefined
  clearTimeout(autoTimer);stopMedia();playbackPageIndex=-1
  loading.value = true; rendering.value = false; pageCount.value = 0; renderedPageIndex.value = -1; problem.value = ''
  if (canvas.value) { canvas.value.width = 1; canvas.value.height = 1 }
  try {
    if (oldTask) await oldTask.destroy().catch(() => {})
    if (disposed || epoch !== loadEpoch) return
    const data = decode(props.base64)
    const assets = new URL('./pdfjs/', document.baseURI).href
    const task = pdfjs.getDocument({
      data, cMapUrl: `${assets}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`,
    })
    documentTask = task
    const source = await task.promise
    if (disposed || epoch !== loadEpoch) { await task.destroy().catch(() => {}); return }
    if (source.numPages < 1 || source.numPages > MAX_PAGES) {
      await task.destroy().catch(() => {})
      if (documentTask === task) documentTask = undefined
      throw Error(`内置放映支持 1–${MAX_PAGES} 页，请缩小演示范围。`)
    }
    if (props.presentation && props.presentation.slides.length !== source.numPages) throw Error('放映页数与演示文稿不一致，已阻止错误的媒体或转场映射。')
    pdf = source; pageCount.value = source.numPages
    // Public startPage is a zero-based page index, matching the Office engine.
    const initial = (Number.isFinite(props.startPage) ? Math.trunc(props.startPage!) : 0) + 1
    pageNumber.value = visiblePage(Math.max(1, Math.min(source.numPages, initial)), 1)
    loading.value = false
    await nextTick()
    if (!disposed && epoch === loadEpoch) await renderPage()
  } catch (error) {
    if (!disposed && epoch === loadEpoch) { loading.value = false; fail(error) }
  }
}
async function renderPage() {
  const source = pdf, container = stage.value
  if (!source || !container || disposed || loading.value) return
  const epoch = ++renderEpoch, page = pageNumber.value
  const prior = renderTask
  prior?.cancel()
  rendering.value = true; problem.value = ''
  try {
    if (prior) await prior.promise.catch(() => {})
    if (disposed || epoch !== renderEpoch || source !== pdf) return
    const slide = await source.getPage(page)
    if (disposed || epoch !== renderEpoch || source !== pdf) return
    const original = slide.getViewport({ scale: 1 })
    if (![original.width, original.height].every(value => Number.isFinite(value) && value > 0)) throw Error('幻灯片尺寸无效。')
    const width = Math.max(1, container.clientWidth - 24), height = Math.max(1, container.clientHeight - 24)
    const scale = Math.min(width / original.width, height / original.height)
    const viewport = slide.getViewport({ scale })
    const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)))
    // Render into a private canvas. A cancelled or late page must never paint
    // over the currently selected slide while navigation/resizing is pending.
    const buffer = document.createElement('canvas')
    buffer.width = Math.max(1, Math.round(viewport.width * density))
    buffer.height = Math.max(1, Math.round(viewport.height * density))
    const context = buffer.getContext('2d', { alpha: false })
    if (!context) throw Error('无法创建放映画布。')
    const task = slide.render({ canvas: buffer, canvasContext: context, viewport, transform: [density, 0, 0, density, 0, 0] })
    renderTask = task
    try {
      await task.promise
      const target = canvas.value
      if (!target || disposed || epoch !== renderEpoch || source !== pdf || page !== pageNumber.value) return
      const changed = renderedPageIndex.value !== page - 1
      const previous = previousCanvas.value
      for (const animation of animations) animation.cancel(); animations = [];if(previous){previous.style.visibility='hidden';previous.style.zIndex='1'}
      if (previous && target.width > 1 && changed) {previous.width=target.width;previous.height=target.height;previous.getContext('2d')?.drawImage(target,0,0)}
      target.width = buffer.width; target.height = buffer.height
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`
      const visibleContext = target.getContext('2d', { alpha: false })
      if (!visibleContext) throw Error('无法显示幻灯片。')
      visibleContext.drawImage(buffer, 0, 0)
      if (surface.value) {surface.value.style.width=`${viewport.width}px`;surface.value.style.height=`${viewport.height}px`}
      if(previous){previous.style.width=`${viewport.width}px`;previous.style.height=`${viewport.height}px`}
      renderedPageIndex.value = page - 1
      if(changed) {clearTimeout(autoTimer);resetMedia();playbackPageIndex=-1}
      if(changed || playbackPageIndex!==page-1) {
        await nextTick();if(changed)await transitionPage(page-1,epoch)
        if(!disposed && epoch===renderEpoch) {playbackPageIndex=page-1;startMedia();scheduleAdvance()}
      }
    } finally {
      if (renderTask === task) renderTask = undefined
      buffer.width = 1; buffer.height = 1
    }
  } catch (error) {
    if (!disposed && epoch === renderEpoch && source === pdf && !(error instanceof Error && error.name === 'RenderingCancelledException')) fail(error)
  } finally { if (!disposed && epoch === renderEpoch) rendering.value = false }
}
function visiblePage(page:number, direction:number) {
  if (!props.presentation) return page
  while(page>=1 && page<=pageCount.value && props.presentation.slides[page-1]?.hidden)page+=direction
  if(page<1 || page>pageCount.value) {
    const first=props.presentation.slides.findIndex(item=>!item.hidden)
    if(first<0)throw Error('所有幻灯片均已隐藏。请先取消至少一页的隐藏。')
    return direction<0 ? first+1 : props.presentation.slides.length - [...props.presentation.slides].reverse().findIndex(item=>!item.hidden)
  }
  return page
}
function goTo(page: number) {
  if (!ready.value || closing) return
  const next = visiblePage(Math.max(1, Math.min(pageCount.value, page)), page < pageNumber.value ? -1 : 1)
  if (next === pageNumber.value) return
  clearTimeout(autoTimer);blank.value='';stopMedia();playbackPageIndex=-1;pageNumber.value = next
  void renderPage()
}
function resize() {
  cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => { if (!disposed) void renderPage() })
}
async function close() {
  if (closing) return
  closing = true
  clearTimeout(autoTimer);stopMedia();for(const animation of animations)animation.cancel()
  cancelRender()
  if (root.value && document.fullscreenElement === root.value) await document.exitFullscreen().catch(() => {})
  emit('close')
}
async function toggleFullscreen() {
  const element = root.value
  if (!element) return
  fullscreenNotice.value = ''
  try {
    if (document.fullscreenElement === element) {
      intentionalFullscreenExit = true
      await document.exitFullscreen()
    } else if (element.requestFullscreen) await element.requestFullscreen()
    else fullscreenNotice.value = '当前使用应用内全屏。'
  } catch {
    intentionalFullscreenExit = false
    fullscreenNotice.value = '系统全屏不可用，仍可使用应用内全屏放映。'
  }
}
function fullscreenChanged() {
  const wasFullscreen = fullscreen.value
  fullscreen.value = document.fullscreenElement === root.value
  if (wasFullscreen && !fullscreen.value) {
    if (!intentionalFullscreenExit && !closing) void close()
    intentionalFullscreenExit = false
  }
  resize()
}
function keydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const target=event.target as HTMLElement
  if(['VIDEO','AUDIO','INPUT','TEXTAREA','SELECT'].includes(target?.tagName) && event.key!=='Escape')return
  if(['b','w'].includes(event.key.toLowerCase())){event.preventDefault();event.stopImmediatePropagation();const value=event.key.toLowerCase()==='b'?'black':'white';blank.value=blank.value===value?'':value;return}
  if(event.key==='F5'){event.preventDefault();event.stopImmediatePropagation();if(!event.shiftKey)goTo(1);return}
  const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)
  const previous = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)
  if (next || previous || ['Home', 'End', 'Escape'].includes(event.key)) {
    event.preventDefault(); event.stopImmediatePropagation()
    if (event.key === 'Escape') void close()
    else if (event.key === 'Home') goTo(1)
    else if (event.key === 'End') goTo(pageCount.value)
    else goTo(pageNumber.value + (previous || event.shiftKey && event.key === ' ' ? -1 : 1))
  } else if (event.key === 'Tab') {
    const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
    const first = buttons[0], last = buttons.at(-1)
    if (!first || !last) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root.value)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
}

function stopMedia() {for(const timer of mediaTimers)clearTimeout(timer);mediaTimers=[]; for(const element of surface.value?.querySelectorAll<HTMLMediaElement>('audio,video') || [])element.pause() }
function resetMedia() {
  stopMedia();for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls=[];mediaNotice.value=''
  mediaItems.value=(currentSlide.value?.media || []).flatMap(item=>{
    if(!item.data || !item.rect || item.external){mediaNotice.value='部分媒体无法在此播放；外部链接不会自动加载。';return []}
    const url=URL.createObjectURL(new Blob([item.data.slice().buffer as ArrayBuffer],{type:item.mimeType}));mediaUrls.push(url)
    return [{id:item.id,kind:item.kind,name:item.name,url,start:item.start,loop:item.loop,style:{left:`${item.rect.x*100}%`,top:`${item.rect.y*100}%`,width:`${item.rect.width*100}%`,height:`${item.rect.height*100}%`,transform:`rotate(${item.rotation || 0}deg)`}}]
  })
}
function startMedia() {
  for(const element of surface.value?.querySelectorAll<HTMLMediaElement>('[data-autoplay="true"]') || []) {
    const index=mediaItems.value.findIndex(item=>item.url===element.src)
    const delay=currentSlide.value?.media.find(item=>item.id===mediaItems.value[index]?.id)?.startDelayMs || 0
    const play=()=>{void element.play().catch(()=>{mediaNotice.value='自动播放被系统阻止，请点击媒体的播放按钮。'})}
    if(delay>0)mediaTimers.push(setTimeout(play,Math.min(delay,3600000)));else play()
  }
}
function scheduleAdvance() {
  clearTimeout(autoTimer)
  const ms=currentSlide.value?.transition.advanceAfterMs
  if(typeof ms==='number' && ms>=0 && hasNext.value)autoTimer=setTimeout(()=>goTo(pageNumber.value+1),Math.max(100,ms))
}
async function transitionPage(index:number, epoch:number) {
  const next=surface.value, prior=previousCanvas.value, effect=props.presentation?.slides[index]?.transition
  if(!next || !prior || !effect || !effect.supported || effect.type==='none' || prior.width<2 || matchMedia('(prefers-reduced-motion: reduce)').matches)return
  const duration=Math.min(10000,Math.max(0,effect.durationMs ?? ({fast:400,med:700,slow:1000}[effect.speed || 'med'])))
  if(!duration)return
  const direction=effect.direction || 'l'
  const offsets:Record<string,[number,number]>={l:[100,0],r:[-100,0],u:[0,100],d:[0,-100],lu:[100,100],ru:[-100,100],ld:[100,-100],rd:[-100,-100]}
  const [x,y]=offsets[direction] || offsets.l!
  const from=`translate(${x}%,${y}%)`, to=`translate(${-x}%,${-y}%)`
  const collapsed=direction==='r'?'inset(0 100% 0 0)':direction==='u'?'inset(100% 0 0 0)':direction==='d'?'inset(0 0 100% 0)':'inset(0 0 0 100%)'
  const full='inset(0 0 0 0)', split=effect.orientation==='horz'?'inset(50% 0 50% 0)':'inset(0 50% 0 50%)'
  let incoming:Keyframe[]=[{opacity:0},{opacity:1}], outgoing:Keyframe[]|null=null
  if(effect.type==='push'){incoming=[{transform:from},{transform:'translate(0,0)'}];outgoing=[{transform:'translate(0,0)'},{transform:to}]}
  else if(effect.type==='cover')incoming=[{transform:from},{transform:'translate(0,0)'}]
  else if(effect.type==='uncover'){incoming=[{opacity:1},{opacity:1}];outgoing=[{transform:'translate(0,0)'},{transform:to}];prior.style.zIndex='3'}
  else if(effect.type==='wipe')incoming=[{clipPath:collapsed},{clipPath:full}]
  else if(effect.type==='split'){incoming=[{clipPath:split},{clipPath:full}];if(direction==='in'){incoming=[{opacity:1},{opacity:1}];outgoing=[{clipPath:full},{clipPath:split}];prior.style.zIndex='3'}}
  prior.style.visibility='visible'
  const options:KeyframeAnimationOptions={duration,easing:'ease-in-out',fill:'both'}
  animations=[next.animate(incoming,options),...(outgoing?[prior.animate(outgoing,options)]:[])]
  await Promise.allSettled(animations.map(animation=>animation.finished))
  if(disposed || epoch!==renderEpoch)return
  for(const animation of animations)animation.cancel();animations=[];prior.style.visibility='hidden';prior.style.zIndex='1'
}
function movePointer(event:PointerEvent) {const box=stage.value?.getBoundingClientRect();if(box)pointer.value={x:event.clientX-box.left,y:event.clientY-box.top}}

watch(() => props.base64, () => { void loadDocument() })
watch(() => props.startPage, page => { if (ready.value) goTo((Number.isFinite(page) ? Math.trunc(page!) : 0) + 1) })
onMounted(() => {
  mounted = true
  clockTimer=setInterval(()=>elapsed.value++,1000)
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  root.value?.focus()
  window.addEventListener('keydown', keydown, true)
  window.addEventListener('resize', resize)
  document.addEventListener('fullscreenchange', fullscreenChanged)
  observer = new ResizeObserver(resize)
  if (stage.value) observer.observe(stage.value)
  void loadDocument()
})
onBeforeUnmount(() => {
  disposed = true; clearTimeout(autoTimer);clearInterval(clockTimer);stopMedia();for(const url of mediaUrls)URL.revokeObjectURL(url);for(const animation of animations)animation.cancel();loadEpoch++; cancelRender(); cancelAnimationFrame(resizeFrame)
  observer?.disconnect()
  window.removeEventListener('keydown', keydown, true)
  window.removeEventListener('resize', resize)
  document.removeEventListener('fullscreenchange', fullscreenChanged)
  if (root.value && document.fullscreenElement === root.value) void document.exitFullscreen().catch(() => {})
  void documentTask?.destroy().catch(() => {})
  documentTask = undefined; pdf = undefined
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <section ref="root" class="slide-preview" data-testid="slide-preview" :data-rendering="loading || rendering" role="dialog" aria-modal="true" aria-label="演示放映" tabindex="-1">
      <header class="slide-preview-toolbar">
        <div class="slide-preview-heading"><strong>{{ name }}</strong><small>{{currentSlide?.hasUnsupportedAnimations ? '本页对象动画显示为静态内容' : '内置放映 · 切换与本地媒体'}}</small></div>
        <button type="button" @click="notesOpen=!notesOpen" :aria-pressed="notesOpen">演讲备注</button><button type="button" @click="laser=!laser" :aria-pressed="laser">激光笔</button><button type="button" @click="toggleFullscreen" :aria-label="fullscreen ? '退出系统全屏' : '进入系统全屏'">{{ fullscreen ? '还原窗口' : '全屏' }}</button>
        <button type="button" data-testid="slide-preview-close" class="slide-preview-close" @click="close" aria-label="退出放映">退出 <kbd>Esc</kbd></button>
      </header>
      <div class="slide-preview-body"><div ref="stage" class="slide-preview-stage" :aria-busy="loading || rendering" @pointermove="movePointer">
        <canvas ref="previousCanvas" class="slide-previous-canvas" aria-hidden="true"/>
        <div ref="surface" class="slide-surface" :style="{visibility:loading || problem ? 'hidden':'visible'}">
        <canvas ref="canvas" data-testid="slide-preview-canvas" :data-page-index="renderedPageIndex" :style="{ visibility: loading || problem ? 'hidden' : 'visible' }" :aria-label="`第 ${pageNumber} 页幻灯片`" />
        <component v-for="media in mediaItems" :key="media.id" :is="media.kind==='video'?'video':'audio'" class="slide-media" :style="media.style" :src="media.url" :data-autoplay="media.start==='auto'" :loop="media.loop" controls playsinline preload="metadata" :aria-label="media.name" @error="mediaNotice='媒体编码无法在此系统播放，请尝试 MP4（H.264）或 MP3。'"/>
        </div>
        <div v-if="blank" class="slide-blank" :class="blank" @click="blank=''"/>
        <i v-if="laser && !blank" class="slide-laser" :style="{left:`${pointer.x}px`,top:`${pointer.y}px`}"/>
        <div v-if="loading || rendering && renderedPageIndex<0" class="slide-preview-message" role="status"><i />{{ loading ? '正在准备放映…' : '正在绘制幻灯片…' }}</div>
        <div v-else-if="problem" class="slide-preview-message slide-preview-error" role="alert"><strong>{{ problem }}</strong><span>可以退出放映，继续编辑原文档。</span></div>
      </div>
      <aside v-if="notesOpen" class="slide-speaker-notes"><span>演讲备注 · {{clock}}</span><h2>{{currentSlide?.title || `幻灯片 ${pageNumber}`}}</h2><p>{{currentSlide?.notes || '本页暂无备注。'}}</p><small v-if="nextVisible">下一页：{{nextVisible.title || `幻灯片 ${nextVisible.index+1}`}}</small></aside></div>
      <div v-if="mediaNotice || currentSlide?.transition.type==='unknown'" class="slide-media-notice" role="status">{{mediaNotice || '本页转场暂不支持，按无转场显示；原效果保留在 PPTX 中。'}}</div>
      <details v-if="currentSlide?.warnings.length" class="slide-media-notice"><summary>本页兼容说明 · {{currentSlide.warnings.length}}</summary><p v-for="warning in currentSlide.warnings" :key="warning">{{warning}}</p></details>
      <footer class="slide-preview-controls">
        <span class="slide-preview-shortcut">← → 翻页 · B 黑屏 / W 白屏</span>
        <nav aria-label="幻灯片翻页">
          <button type="button" data-testid="slide-preview-previous" :disabled="!ready || !previousVisible" @click="goTo(pageNumber - 1)" aria-label="上一页">‹ <span>上一页</span></button>
          <output data-testid="slide-preview-page" aria-live="polite" aria-atomic="true">{{ pageCount ? pageNumber : '—' }} <span>/ {{ pageCount || '—' }}</span></output>
          <button type="button" data-testid="slide-preview-next" :disabled="!ready || !hasNext" @click="goTo(pageNumber + 1)" aria-label="下一页"><span>下一页</span> ›</button>
        </nav>
        <span class="slide-preview-fullscreen-note" role="status">{{ fullscreenNotice }}</span>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
.slide-preview { position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; background: #10151f; color: #eef2f9; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; outline: none; overscroll-behavior: contain; }
.slide-preview-toolbar { display: flex; align-items: center; gap: 10px; flex-shrink: 0; padding: max(12px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) 12px max(20px, env(safe-area-inset-left)); border-bottom: 1px solid #ffffff12; background: #151c28; }
.slide-preview-heading { flex: 1; min-width: 0; }
.slide-preview-heading strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.slide-preview-heading small { display: block; color: #99a8bf; font-size: 11px; margin-top: 2px; }
.slide-preview button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; flex-shrink: 0; min-height: 42px; border: 1px solid #ffffff22; border-radius: 8px; padding: 8px 15px; background: #ffffff09; color: inherit; font: inherit; cursor: pointer; touch-action: manipulation; }
.slide-preview button:hover:not(:disabled) { background: #ffffff18; border-color: #ffffff40; }
.slide-preview button:focus-visible { outline: 2px solid #a5c7ff; outline-offset: 3px; }
.slide-preview button:disabled { opacity: .32; cursor: default; }
.slide-preview kbd { border: 1px solid #ffffff28; border-radius: 4px; padding: 0 4px; font-size: 10px; line-height: 1.6; color: #b1bdd1; }
.slide-preview-body{display:flex;flex:1;min-height:0;overflow:hidden}.slide-surface{position:relative;flex:none;z-index:2;overflow:hidden}.slide-previous-canvas{position:absolute!important;z-index:1;visibility:hidden;pointer-events:none}.slide-media{position:absolute;z-index:2;object-fit:contain;background:#10151f}.slide-media:is(audio){min-height:36px}.slide-speaker-notes{width:300px;flex:none;overflow:auto;padding:24px;background:#1b2433;border-left:1px solid #ffffff20;white-space:pre-wrap;overflow-wrap:anywhere}.slide-speaker-notes>span{color:#a8bcdb;font-size:12px;font-variant-numeric:tabular-nums}.slide-speaker-notes h2{font-size:19px}.slide-speaker-notes p{line-height:1.8}.slide-speaker-notes small{display:block;border-top:1px solid #ffffff20;padding-top:20px;color:#92a7c8}.slide-media-notice{padding:7px 20px;background:#433921;color:#f4d493;font-size:12px}.slide-blank{position:absolute;inset:0;z-index:5}.slide-blank.black{background:black}.slide-blank.white{background:white}.slide-laser{position:absolute;z-index:6;width:10px;height:10px;border-radius:50%;background:#ff4848;box-shadow:0 0 12px 3px #ff525299;pointer-events:none;transform:translate(-50%,-50%)}
.slide-preview-stage { position: relative; display: flex; align-items: center; justify-content: center; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.slide-preview-stage canvas { display: block; flex-shrink: 0; max-width: 100%; max-height: 100%; background: white; box-shadow: 0 8px 50px #0007; }
.slide-preview-message { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 28px; text-align: center; color: #b7c3d7; }
.slide-preview-message i { width: 25px; height: 25px; border: 2px solid #ffffff20; border-top-color: #b3d0ff; border-radius: 50%; animation: slide-preview-spin .8s linear infinite; }
.slide-preview-error strong { max-width: 650px; color: #ffd2cd; font-size: 15px; font-weight: 500; overflow-wrap: anywhere; }
.slide-preview-error span { font-size: 12px; }
.slide-preview-controls { display: flex; align-items: center; justify-content: center; gap: 14px; flex-shrink: 0; min-height: 68px; padding: 8px 20px max(10px, env(safe-area-inset-bottom)); border-top: 1px solid #ffffff12; }
.slide-preview-controls nav { display: flex; align-items: center; gap: 12px; }
.slide-preview-controls output { min-width: 76px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
.slide-preview-controls output span { color: #91a1b9; font-weight: 400; }
.slide-preview-shortcut, .slide-preview-fullscreen-note { flex: 1; width: 0; color: #8797b1; font-size: 11px; }
.slide-preview-fullscreen-note { text-align: right; }
@keyframes slide-preview-spin { to { transform: rotate(360deg); } }
@media (max-width: 660px) {
  .slide-preview-toolbar { gap: 6px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: max(10px, env(safe-area-inset-right)); }
  .slide-preview-toolbar button { padding: 8px 11px; }
  .slide-preview-heading strong { font-size: 13px; }
  .slide-preview-heading small { font-size: 10px; max-width: 180px; }
  .slide-preview kbd, .slide-preview-shortcut { display: none; }
  .slide-preview-controls { flex-wrap: wrap; gap: 4px; padding-left: 10px; padding-right: 10px; }
  .slide-preview-controls nav { gap: 8px; }
  .slide-preview-fullscreen-note { flex: 0 0 100%; width: auto; text-align: center; }
  .slide-preview-fullscreen-note:empty { display: none; }
}
@media (prefers-reduced-motion: reduce) { .slide-preview-message i { animation: none; } }
</style>
