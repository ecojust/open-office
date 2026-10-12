/* Open Office same-origin host. The engine assets and documents never need a remote service. */
'use strict';
const CHANNEL = 'open-office-engine';
const session = new URLSearchParams(location.hash.slice(1)).get('session');
const canvas = document.getElementById('qtcanvas');
const runtimeBase = new URL('../office-runtime/', location.href).href;
const adapterBase = new URL('./', location.href).href;
let port, activeDocumentId = '', disposed = false, fileCounter = 0;
const pending = new Map();
const allowed = new Set(['open','export','undo','redo','search','mark-saved','discard','focus','insert-image']);
const smokeMode = new URLSearchParams(location.search).get('smoke') === '1';
if (smokeMode) allowed.add('smoke-test');
const send = (message) => { if (!disposed) parent.postMessage({ channel: CHANNEL, session, ...message }, location.origin); };
const progress = (text, percent) => send({ event: 'progress', data: { text, percent } });
const errorText = error => String(error?.message || error || '未知错误').slice(0, 1500);
let diagnosticPhase = 'host-created', diagnosticDependencies = null, diagnosticUnoReady = false;
const diagnosticWarnings = [];
function smokeDiagnostic(phase, detail = {}, failure = false) {
  if (!smokeMode || disposed) return;
  diagnosticPhase = phase;
  const body = { phase: `office-host:${phase}`, detail: JSON.stringify(detail).slice(0, 400), at: Date.now(),
    ...(failure ? { ok: false, error: String(detail.error || phase) } : {}) };
  // Test-only reporting bypasses Tauri IPC, so an IPC failure cannot hide an engine failure.
  void fetch(new URL(`../__native-smoke/${failure ? 'failure' : 'progress'}`, location.href), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
}
const fail = error => {
  const message = errorText(error);
  smokeDiagnostic('failure', { error: message, previousPhase: diagnosticPhase, warnings: diagnosticWarnings }, true);
  send({ event: 'error', error: message });
};
if (smokeMode) {
  window.addEventListener('error', event => fail(`页面脚本错误：${event.message || 'unknown'} @ ${event.filename || ''}:${event.lineno || 0}`));
  window.addEventListener('unhandledrejection', event => fail(`未处理的异步错误：${errorText(event.reason)}`));
  const heartbeat = setInterval(() => {
    const previousPhase = diagnosticPhase;
    smokeDiagnostic('heartbeat', { previousPhase, calledRun: !!window.Module?.calledRun,
      heapBytes: window.Module?.HEAPU8?.byteLength || 0, dependencies: diagnosticDependencies,
      unoReady: diagnosticUnoReady, pendingActions: [...pending.values()].map(value => value.action), warnings: diagnosticWarnings });
    diagnosticPhase = previousPhase;
  }, 10000);
  window.addEventListener('pagehide', () => clearInterval(heartbeat), { once: true });
}
async function diagnoseFeatures() {
  if (!smokeMode) return;
  const features = { secureContext: isSecureContext,
    isolated: crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer,
    offscreenCanvas: typeof OffscreenCanvas, transferCanvas: typeof HTMLCanvasElement.prototype.transferControlToOffscreen,
    wasmException: typeof WebAssembly.Exception, atomicsWaitAsync: typeof Atomics.waitAsync };
  try {
    // A single 64 KiB page, not a second copy of the engine's 1 GiB memory.
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    features.sharedWasmMemory = memory.buffer instanceof SharedArrayBuffer;
  } catch (error) { features.sharedWasmMemoryError = errorText(error); }
  features.userAgent = navigator.userAgent;
  smokeDiagnostic('features', features);
  if (typeof SharedArrayBuffer === 'undefined') return;
  await new Promise(resolve => {
    let worker, timer, url, finished = false;
    const finish = detail => {
      if (finished) return; finished = true;
      clearTimeout(timer); worker?.terminate(); if (url) URL.revokeObjectURL(url);
      smokeDiagnostic('worker-features', detail); resolve();
    };
    try {
      const source = `onmessage = event => postMessage({ isolated: crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, receivedShared: event.data instanceof SharedArrayBuffer, name: self.name, offscreenCanvas: typeof OffscreenCanvas, wasmException: typeof WebAssembly.Exception });`;
      url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
      worker = new Worker(url, { name: 'office-smoke-capabilities' });
      worker.onmessage = event => finish(event.data);
      worker.onerror = event => finish({ error: event.message || 'worker error' });
      timer = setTimeout(() => finish({ error: 'worker capability probe timed out' }), 4000);
      worker.postMessage(new SharedArrayBuffer(16));
    } catch (error) { finish({ error: errorText(error) }); }
  });
}
function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 150000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error('文档数据无效或超过编辑器大小限制。');
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function toBase64(bytes) {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(raw);
}
function reply(message, ok, data, error) { send({ requestId: message.requestId, ok, data, error }); }
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== location.origin || !session || disposed) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL || message.session !== session || typeof message.requestId !== 'string' || !allowed.has(message.action)) return;
  if (!port) { reply(message, false, undefined, '办公引擎仍在启动。'); return; }
  if (pending.has(message.requestId)) return;
  try {
    let data = message.data || {};
    if (message.action === 'open') {
      if (typeof data.id !== 'string' || !['word','sheet'].includes(data.kind)) throw Error('不支持的文档类型。');
      const extensions = data.kind === 'word' ? ['docx','odt'] : ['xlsx','ods'];
      if (!extensions.includes(data.extension)) throw Error('请使用 DOCX、ODT、XLSX 或 ODS 文档。');
      const path = `/tmp/open-office-${++fileCounter}.${data.extension}`;
      const bytes = fromBase64(data.base64);
      if (bytes.length) FS.writeFile(path, bytes);
      data = { id: data.id, name: String(data.name || '未命名'), kind: data.kind, extension: data.extension, path, isNew: !bytes.length, discard: data.discard === true };
    } else if (message.documentId !== activeDocumentId) throw Error('当前文档已经切换，旧操作已取消。');
    if (message.action === 'insert-image') {
      const extension = String(data.name || '').split('.').pop().toLowerCase();
      if (!['png','jpg','jpeg','webp','gif'].includes(extension)) throw Error('请选择 PNG、JPEG、WebP 或 GIF 图片。');
      const bytes = fromBase64(data.base64);
      if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw Error('图片为空或超过 25 MB。');
      const path = `/tmp/open-office-image-${++fileCounter}.${extension}`;
      FS.writeFile(path, bytes); data = { path };
    }
    smokeDiagnostic('request', { action: message.action, hasDocument: !!activeDocumentId });
    pending.set(message.requestId, { ...message, data });
    port.postMessage({ requestId: message.requestId, action: message.action, documentId: message.documentId, data });
  } catch (error) { reply(message, false, undefined, errorText(error)); }
});
function workerMessage(event) {
  const message = event.data;
  if (!message || disposed) return;
  if (message.event === 'engine-ready') { smokeDiagnostic('engine-ready'); progress('办公引擎已就绪', 100); send(message); return; }
  if (message.event) {
    if (!message.documentId || message.documentId === activeDocumentId) send(message);
    return;
  }
  const request = pending.get(message.requestId);
  if (!request) return;
  pending.delete(message.requestId);
  smokeDiagnostic('reply', { action: request.action, ok: message.ok, error: message.error });
  try {
    if (request.action === 'insert-image') { try { FS.unlink(request.data.path); } catch {} }
    if (!message.ok) {
      if (request.action === 'open' && !request.data.isNew) { try { FS.unlink(request.data.path); } catch {} }
      throw Error(message.error || '操作失败。');
    }
    if (request.action === 'open') { if (message.data.closedPath) { try { FS.unlink(message.data.closedPath); } catch {} } activeDocumentId = request.data.id; window.dispatchEvent(new Event('resize')); setTimeout(() => window.dispatchEvent(new Event('resize')), 200); }
    if (request.action === 'smoke-test') {
      const report = message.data;
      for (const [kind, extension] of [['writer','docx'], ['calc','xlsx']]) {
        const result = report[kind], pdf = FS.readFile(result.pdfPath);
        result[extension + 'Bytes'] = FS.stat(result[extension + 'Path']).size;
        result.pdfBytes = pdf.length; result.pdfHeader = String.fromCharCode(...pdf.subarray(0, 5));
        report.ok = report.ok && result.pdfHeader === '%PDF-' && result[extension + 'Bytes'] > 100;
        delete result.pdfPath; delete result[extension + 'Path'];
      }
      for (const asset of report.artifacts) { try { FS.unlink(asset.path); } catch {} }
      delete report.artifacts;
    }
    if (request.action === 'export') {
      const bytes = FS.readFile(message.data.path);
      const base64 = toBase64(bytes);
      FS.unlink(message.data.path);
      reply(request, true, { base64, extension: message.data.extension, name: message.data.name, revision: message.data.revision, dirty: message.data.dirty });
    } else reply(request, true, message.data);
  } catch (error) { reply(request, false, undefined, errorText(error)); }
}
canvas.addEventListener('wheel', event => event.preventDefault(), { passive: false });
window.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const type = key === 's' ? (event.shiftKey ? 'save-as' : 'save') : key === 'o' ? 'open' : key === 'p' ? 'print' : '';
  if (type) { event.preventDefault(); event.stopImmediatePropagation(); send({ event: 'native-request', documentId: activeDocumentId, data: { type } }); }
}, true);
window.addEventListener('pagehide', () => { disposed = true; pending.clear(); });
async function start() {
  await diagnoseFeatures();
  if (!session || parent === window) throw Error('请从 Open Office 应用打开编辑器。');
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw Error('当前窗口不支持共享内存。请使用完整桌面安装包，或带 COOP/COEP 响应头的本机 HTTP 服务。');
  progress('正在准备中文字体', 5);
  const fontResponse = await fetch(new URL('NotoSansCJKsc-Regular.otf', runtimeBase));
  if (!fontResponse.ok) throw Error('缺少中文字体资源，请重新下载完整办公组件。');
  const font = new Uint8Array(await fontResponse.arrayBuffer());
  smokeDiagnostic('font-ready', { bytes: font.byteLength });
  window.Module = {
    canvas,
    uno_scripts: [new URL('zeta.js', adapterBase).href, new URL('office-worker.js', adapterBase).href],
    locateFile: path => new URL(path, runtimeBase).href,
    mainScriptUrlOrBlob: new Blob([`importScripts(${JSON.stringify(new URL('soffice.js', runtimeBase).href)});`], { type: 'application/javascript' }),
    preRun: [() => {
      // This directory is explicitly listed in the runtime fontconfig.
      FS.mkdirTree('/usr/share/fonts/open-office');
      FS.writeFile('/usr/share/fonts/open-office/NotoSansCJKsc-Regular.otf', font);
    }],
    setStatus: text => {
      const match = String(text).match(/\((\d+)\/(\d+)\)/);
      progress('正在加载本地办公引擎，首次启动需要稍候', match ? Math.min(90, 10 + Number(match[1]) / Number(match[2]) * 80) : 25);
    },
    ...(smokeMode ? { onRuntimeInitialized: () => smokeDiagnostic('runtime-initialized'),
      monitorRunDependencies: count => { diagnosticDependencies = count; } } : {}),
    onAbort: reason => fail(`办公引擎已停止：${errorText(reason)}`),
    print: () => {}, printErr: value => {
      console.warn('[Office engine]', value);
      if (smokeMode && /error|failed|abort|unsupported|memory|pthread/i.test(String(value))) {
        diagnosticWarnings.push(String(value).slice(0, 1200));
        if (diagnosticWarnings.length > 8) diagnosticWarnings.shift();
        smokeDiagnostic('runtime-warning', { message: String(value).slice(0, 1200) });
      }
    },
  };
  progress('正在启动完整办公编辑器', 15);
  const script = document.createElement('script'); script.src = new URL('soffice.js', runtimeBase).href;
  script.onerror = () => fail('办公组件加载失败。请检查离线资源完整性，然后重试。');
  script.onload = () => {
    smokeDiagnostic('script-loaded', { unoPromise: typeof Module.uno_main?.then, heapBytes: Module.HEAPU8?.byteLength || 0 });
    try {
      if (!Module.uno_main?.then) throw Error('办公组件未完成初始化，缺少 UNO 通道。');
      Module.uno_main.then(value => {
        diagnosticUnoReady = true; smokeDiagnostic('uno-main-ready'); port = value; port.onmessage = workerMessage;
      }).catch(fail);
    } catch (error) { fail(error); }
  };
  document.body.append(script);
}
start().catch(fail);
