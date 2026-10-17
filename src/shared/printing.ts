import * as native from '../native'

export type PrintOutcome = { status: 'completed' | 'cancelled' | 'opened' }
export type HtmlPrintRequest = {
 title: string
 /** Scope content styles to #office-print-root. */
 css: string
 render(document: Document, container: HTMLElement): void | Promise<void>
 prepare?(container: HTMLElement): void | Promise<void>
}

let preparing = false
let disposePrevious: (() => void) | undefined
const resourceTimeout = 20_000

function timeout<T>(promise: PromiseLike<T>, message: string): Promise<T> {
 return new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(message)), resourceTimeout)
  Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer))
 })
}

async function withPrintJob(run: () => Promise<PrintOutcome>): Promise<PrintOutcome> {
 if (preparing) throw Error('正在准备另一份打印，请稍后再试。')
 preparing = true
 disposePrevious?.()
 try { return await run() }
 catch (cause) { disposePrevious?.(); throw cause }
 finally { preparing = false }
}

/** Keep an opened native/browser print dialog's source alive until it finishes. */
function retain(cleanup: () => void, target: Window = window) {
 let disposed = false
 const dispose = () => {
  if (disposed) return
  disposed = true
  target.removeEventListener('afterprint', dispose)
  window.removeEventListener('pagehide', dispose)
  cleanup()
  if (disposePrevious === dispose) disposePrevious = undefined
 }
 disposePrevious = dispose
 target.addEventListener('afterprint', dispose, { once: true })
 window.addEventListener('pagehide', dispose, { once: true })
 return dispose
}

async function imageReady(image: HTMLImageElement) {
 if (image.complete) {
  if (!image.naturalWidth) throw Error('打印图片未能加载，请重试。')
 } else {
  await new Promise<void>((resolve, reject) => {
   const timer = setTimeout(() => finish(Error('打印图片加载超时，请重试。')), resourceTimeout)
   const loaded = () => finish()
   const failed = () => finish(Error('打印图片未能加载，请重试。'))
   function finish(error?: Error) {
    clearTimeout(timer); image.removeEventListener('load', loaded); image.removeEventListener('error', failed)
    error ? reject(error) : resolve()
   }
   image.addEventListener('load', loaded, { once: true })
   image.addEventListener('error', failed, { once: true })
  })
 }
 if (typeof image.decode === 'function') await timeout(image.decode(), '打印图片解码超时，请重试。')
}

async function resourcesReady(container: HTMLElement) {
 const images: HTMLImageElement[] = [...container.querySelectorAll('img')]
 for (const image of images) image.loading = 'eager'
 for (const element of container.querySelectorAll('svg image')) {
  const source = element.getAttribute('href') || element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
  if (!source) continue
  const image = new Image(); image.src = source; images.push(image)
 }
 await Promise.all([
  ...images.map(imageReady),
  timeout(document.fonts.ready, '打印字体加载超时，请重试。'),
 ])
}

const printStyles = `
#office-print-root{position:absolute;left:-100000px;top:0;width:794px;height:auto;background:white;color:black;pointer-events:none;box-sizing:border-box;color-scheme:light}
@media print{
 html,body{height:auto!important;min-height:0!important;overflow:visible!important;margin:0!important;background:white!important}
 body>*:not(#office-print-root){display:none!important}
 #office-print-root{position:static!important;left:auto!important;top:auto!important;display:block!important;width:100%!important;height:auto!important;overflow:visible!important;visibility:visible!important;transform:none!important}
 #office-print-root,#office-print-root *{print-color-adjust:exact;-webkit-print-color-adjust:exact}
}`

/** Print HTML from the main WebView, where the desktop print bridge actually runs. */
export async function printHtml(request: HtmlPrintRequest): Promise<PrintOutcome> {
 return withPrintJob(async () => {
  const root = document.createElement('div'); root.id = 'office-print-root'
  root.setAttribute('aria-hidden', 'true'); root.inert = true
  const style = document.createElement('style'); style.textContent = printStyles + '\n' + request.css
  root.append(style); document.body.append(root)
  const dispose = retain(() => root.remove())
  await request.render(document, root)
  await resourcesReady(root)
  await request.prepare?.(root)
  // Reading layout also handles background tabs, where animation frames may pause.
  root.getBoundingClientRect()
  const previousTitle = document.title
  document.title = request.title || 'Open Office'
  try {
   if (native.isTauri()) {
    const result = await native.printHtml()
    if (result.status !== 'opened') dispose()
    return result
   }
   if (typeof window.print !== 'function') throw Error('当前浏览器无法打开打印，请使用支持打印的浏览器。')
   await window.print()
   return { status: 'opened' }
  } finally { document.title = previousTitle }
 })
}

/** Preserve exported PDF pages instead of printing a screenshot of the editor. */
export async function printPdf(bytes: Uint8Array, title: string): Promise<PrintOutcome> {
 return withPrintJob(async () => {
  if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw Error('未能生成可打印的 PDF，请重试。')
  if (native.isTauri()) return native.printPdf(native.bytesToBase64(bytes), title)
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
  const frame = document.createElement('iframe')
  frame.title = title; frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:794px;height:1123px;border:0'
  const dispose = retain(() => { frame.remove(); URL.revokeObjectURL(url) })
  try {
   await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('PDF 打印页面加载超时，请重试或导出 PDF 后打印。')), resourceTimeout)
    function finish(error?: Error) {
     clearTimeout(timer); frame.onload = null; frame.onerror = null
     error ? reject(error) : resolve()
    }
    frame.onload = () => finish()
    frame.onerror = () => finish(Error('无法打开 PDF 打印页面，请导出 PDF 后打印。'))
    frame.src = url; document.body.append(frame)
   })
   const output = frame.contentWindow
   if (!output || typeof output.print !== 'function') throw Error('当前浏览器不支持直接打印 PDF，请导出 PDF 后打印。')
   output.addEventListener('afterprint', dispose, { once: true })
   output.focus()
   await output.print()
   return { status: 'opened' }
  } catch (cause) { dispose(); throw cause }
 })
}
