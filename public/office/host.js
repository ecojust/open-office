/* Open Office same-origin host. The engine assets and documents never need a remote service. */
'use strict';
const CHANNEL = 'open-office-engine';
const session = new URLSearchParams(location.hash.slice(1)).get('session');
const canvas = document.getElementById('qtcanvas');
const runtimeBase = new URL('../office-runtime/', location.href).href;
const adapterBase = new URL('./', location.href).href;
function diagnosticHeapBytes(module) {
  // Some Emscripten builds install an aborting getter for unexported HEAPU8.
  // Diagnostics must never invoke it or change whether the engine can boot.
  const heap = module && Object.getOwnPropertyDescriptor(module, 'HEAPU8')?.value;
  return ArrayBuffer.isView(heap) ? heap.byteLength : 0;
}
// Install before loading any engine code, including its pthread bootstraps.
// The native HTTP server enforces an equivalent CSP; host.html also confines
// browser-preview builds to local resources instead of relying on a firewall.
OpenOfficeOfflinePolicy.installLocalTransport(window, location.origin);
let port, activeDocumentId = '', activeDocumentKind = '', disposed = false, fileCounter = 0;
const pending = new Map();
const allowed = new Set(['open','export','undo','redo','search','mark-saved','discard','focus','insert-image',
  'new-slide','preview-presentation','presentation-state','presentation-action','presentation-object-data',
  'word-state','word-action','word-command','word-data','sheet-state','sheet-action','sheet-data']);
const smokeMode = new URLSearchParams(location.search).get('smoke') === '1';
const smokeKinds = new Set(['word','sheet','presentation']);
const smokeActionTypes = new Set(['insert-text','insert-break','insert-table','set-page','set-header-footer','find-replace','apply-style','format-text','update-table','rename-sheet','add-sheet','select-sheet','select-range','set-matrix','set-cell','patch-cells','format','sort','freeze','insert-chart','insert-pivot','filter','clear-filter']);
function smokeOperation(action, data = {}, kind = activeDocumentKind) {
  const detail = { action, ...(smokeKinds.has(kind) ? { kind } : {}) };
  if (smokeActionTypes.has(data.type)) detail.type = data.type;
  if (action === 'word-command' && smokeActionTypes.has(data.action?.type)) detail.type = data.action.type;
  for (const name of ['revision','expectedRevision']) if (Number.isSafeInteger(data[name]) && data[name] >= 0 && data[name] <= 1000000000) detail[name] = data[name];
  return detail;
}
if (smokeMode) { allowed.add('smoke-test'); allowed.add('offline-audit'); }
const send = (message, transfer = []) => { if (!disposed) parent.postMessage({ channel: CHANNEL, session, ...message }, location.origin, transfer); };
const progress = (text, percent) => send({ event: 'progress', data: { text, percent } });
const errorText = error => String(error?.message || error || '未知错误').slice(0, 1500);
let diagnosticPhase = 'host-created', diagnosticDependencies = null, diagnosticUnoReady = false, diagnosticFailure = null;
const diagnosticWarnings = [];
function smokeDiagnostic(phase, detail = {}, failure = false) {
  if (!smokeMode || disposed || diagnosticFailure) return;
  diagnosticPhase = phase;
  const body = { phase: `office-host:${phase}`, detail: JSON.stringify(detail).slice(0, 400), at: Date.now(),
    ...(failure ? { ok: false, error: String(detail.error || phase), errorName: detail.errorName || '',
      stack: String(detail.stack || '').slice(0, 8192), previousPhase: detail.previousPhase || '' } : {}) };
  if (failure) diagnosticFailure = body;
  // Test-only reporting bypasses Tauri IPC, so an IPC failure cannot hide an engine failure.
  void fetch(new URL(`../__native-smoke/${failure ? 'failure' : 'progress'}`, location.href), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
}
function diagnosticError(error) {
  return { errorName: String(error?.name || error?.constructor?.name || typeof error).slice(0, 100),
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 8192) : '' };
}
const fail = (error, prefix = '') => {
  if (smokeMode && diagnosticFailure) return;
  const message = prefix + errorText(error);
  smokeDiagnostic('failure', { error: message, previousPhase: diagnosticPhase, warnings: diagnosticWarnings,
    ...diagnosticError(error) }, true);
  send({ event: 'error', error: message });
};
const restoreClipboardPermissionQuery = installOfficeClipboardPermissionCompatibility(navigator.permissions,
  (name, error) => {
    // This is an unsupported permission-status query, not clipboard access.
    // Browser/OS permission checks for actual copy and paste remain in place.
    console.info(`Clipboard permission query ${name} is unsupported; browser access checks remain active.`);
    smokeDiagnostic('clipboard-query-unsupported', { name, ...diagnosticError(error) });
  });
window.addEventListener('pagehide', restoreClipboardPermissionQuery, { once: true });
if (smokeMode) {
  window.addEventListener('error', event => fail(event.error ?? event.message ?? 'unknown', '页面脚本错误：'));
  window.addEventListener('unhandledrejection', event => fail(event.reason, '未处理的异步错误：'));
  // Preserve native Worker objects and the original call/throw behavior. Only
  // Emscripten control-message metadata is observed; document data is never logged.
  const originalWorkerPostMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...args) {
    const message = args[0], tracked = message && ['load', 'run', 'LOWA-channel'].includes(message.cmd);
    if (tracked) smokeDiagnostic('worker-post', { cmd: message.cmd,
      wasmModule: message.wasmModule instanceof WebAssembly.Module,
      wasmMemory: message.wasmMemory instanceof WebAssembly.Memory,
      memoryBytes: message.wasmMemory?.buffer?.byteLength || 0,
      sharedMemory: message.wasmMemory?.buffer instanceof SharedArrayBuffer,
      transferCount: Array.isArray(args[1]) ? args[1].length : 0 });
    try { return originalWorkerPostMessage.apply(this, args); }
    catch (error) { if (tracked) fail(error, `Worker ${message.cmd} 消息失败：`); throw error; }
  };
  window.addEventListener('pagehide', () => { Worker.prototype.postMessage = originalWorkerPostMessage; }, { once: true });
  const heartbeat = setInterval(() => {
    const previousPhase = diagnosticPhase;
    smokeDiagnostic('heartbeat', { previousPhase, calledRun: !!window.Module?.calledRun,
      heapBytes: diagnosticHeapBytes(window.Module), dependencies: diagnosticDependencies,
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
  let sharedMemory;
  try {
    // A single 64 KiB page, not a second copy of the engine's 1 GiB memory.
    sharedMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    features.sharedWasmMemory = sharedMemory.buffer instanceof SharedArrayBuffer;
  } catch (error) { features.sharedWasmMemoryError = errorText(error); }
  features.userAgent = navigator.userAgent;
  smokeDiagnostic('features', features);
  for (const type of ['webgl', 'webgl2']) {
    const probe = document.createElement('canvas'); probe.width = probe.height = 1;
    let context;
    try {
      context = probe.getContext(type);
      const renderer = context?.getParameter(context.RENDERER);
      smokeDiagnostic('webgl-feature', { type, available: !!context, renderer: String(renderer || '') });
    } catch (error) { smokeDiagnostic('webgl-feature', { type, error: errorText(error), ...diagnosticError(error) }); }
    finally { context?.getExtension('WEBGL_lose_context')?.loseContext(); }
  }
  if (typeof SharedArrayBuffer === 'undefined') return;
  await new Promise(resolve => {
    let worker, timer, url, finished = false;
    const finish = detail => {
      if (finished) return; finished = true;
      clearTimeout(timer); worker?.terminate(); if (url) URL.revokeObjectURL(url);
      smokeDiagnostic('worker-features', detail); resolve();
    };
    try {
      const source = `onmessage = event => {
        const data = event.data;
        const result = { isolated: crossOriginIsolated, receivedShared: data.buffer instanceof SharedArrayBuffer,
          receivedMemory: data.memory instanceof WebAssembly.Memory, receivedModule: data.module instanceof WebAssembly.Module,
          name: self.name, offscreenCanvas: typeof OffscreenCanvas };
        try { if (typeof OffscreenCanvas === 'function') {
          const gl = new OffscreenCanvas(1, 1).getContext('webgl');
          result.workerWebgl = !!gl; result.renderer = gl ? gl.getParameter(gl.RENDERER) : '';
          gl?.getExtension('WEBGL_lose_context')?.loseContext();
        } } catch (error) { result.webglError = String(error); }
        postMessage(result);
      };`;
      url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
      worker = new Worker(url, { name: 'office-smoke-capabilities' });
      worker.onmessage = event => finish(event.data);
      worker.onerror = event => finish({ error: event.message || 'worker error' });
      timer = setTimeout(() => finish({ error: 'worker capability probe timed out' }), 4000);
      worker.postMessage({ buffer: new SharedArrayBuffer(16), memory: sharedMemory,
        module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) });
    } catch (error) { finish({ error: errorText(error), ...diagnosticError(error) }); }
  });
}
function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 150000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error('文档数据无效或超过编辑器大小限制。');
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const parts = [];
  for (let i = 0; i < bytes.length; i += 24576) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24576))));
  return parts.join('');
}
function inputBytes(data) {
  if (data.buffer instanceof ArrayBuffer) {
    if (data.buffer.byteLength > 112500000) throw Error('文档超过编辑器大小限制。');
    return new Uint8Array(data.buffer);
  }
  return fromBase64(data.base64);
}
function reply(message, ok, data, error, transfer = []) { send({ requestId: message.requestId, ok, data, error }, transfer); }
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== location.origin || !session || disposed) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL || message.session !== session || typeof message.requestId !== 'string' || !allowed.has(message.action)) return;
  if (!port) { reply(message, false, undefined, '办公引擎仍在启动。'); return; }
  if (pending.has(message.requestId)) return;
  try {
    let data = message.data || {};
    if (message.action === 'open') {
      if (typeof data.id !== 'string' || !['word','sheet','presentation'].includes(data.kind)) throw Error('不支持的文档类型。');
      const extensions = { word: ['docx','odt','doc','rtf'], sheet: ['xlsx','ods','xls'], presentation: ['pptx','odp','ppt'] }[data.kind];
      if (!extensions.includes(data.extension)) throw Error('请选择支持的本地 Word、Excel 或 PowerPoint 文档。');
      const path = `/tmp/open-office-${++fileCounter}.${data.extension}`;
      const bytes = inputBytes(data);
      // Ownership moves into MEMFS; neither caller nor host mutates this input.
      if (bytes.length) FS.writeFile(path, bytes, { canOwn: true });
      data = { id: data.id, name: String(data.name || '未命名'), kind: data.kind, extension: data.extension, path, isNew: !bytes.length, discard: data.discard === true };
    } else if (message.documentId !== activeDocumentId) throw Error('当前文档已经切换，旧操作已取消。');
    if (message.action === 'insert-image') {
      const extension = String(data.name || '').split('.').pop().toLowerCase();
      if (!['png','jpg','jpeg','webp','gif'].includes(extension)) throw Error('请选择 PNG、JPEG、WebP 或 GIF 图片。');
      const bytes = inputBytes(data);
      if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw Error('图片为空或超过 25 MB。');
      const path = `/tmp/open-office-image-${++fileCounter}.${extension}`;
      FS.writeFile(path, bytes, { canOwn: true }); data = { path };
    }
    if (smokeMode) smokeDiagnostic('request', { ...smokeOperation(message.action, data, message.action === 'open' ? data.kind : activeDocumentKind), hasDocument: !!activeDocumentId });
    pending.set(message.requestId, { ...message, data });
    port.postMessage({ requestId: message.requestId, action: message.action, documentId: message.documentId, data });
  } catch (error) { reply(message, false, undefined, errorText(error)); }
});
function workerMessage(event) {
  const message = event.data;
  if (!message || disposed) return;
  if (message.event === 'engine-ready') { smokeDiagnostic('engine-ready'); progress('办公引擎已就绪', 100); send(message); return; }
  if (message.event) {
    if (smokeMode && message.event === 'dirty' && message.documentId === activeDocumentId) smokeDiagnostic('dirty', { ...smokeOperation('dirty', message.data), dirty: message.data?.dirty === true });
    if (!message.documentId || message.documentId === activeDocumentId) send(message);
    return;
  }
  const request = pending.get(message.requestId);
  if (!request) return;
  pending.delete(message.requestId);
  if (smokeMode) smokeDiagnostic('reply', { ...smokeOperation(request.action, { ...request.data, ...message.data }, request.action === 'open' ? request.data.kind : activeDocumentKind), ok: message.ok, error: message.error });
  try {
    if (request.action === 'insert-image') { try { FS.unlink(request.data.path); } catch {} }
    if (!message.ok) {
      if (request.action === 'open' && !request.data.isNew) { try { FS.unlink(request.data.path); } catch {} }
      throw Error(message.error || '操作失败。');
    }
    if (request.action === 'open') { if (message.data.closedPath) { try { FS.unlink(message.data.closedPath); } catch {} } activeDocumentId = request.data.id; activeDocumentKind = request.data.kind; window.dispatchEvent(new Event('resize')); setTimeout(() => window.dispatchEvent(new Event('resize')), 200); }
    if (request.action === 'smoke-test') {
      const report = message.data;
      for (const [kind, extension] of [['writer','docx'], ['calc','xlsx'], ['impress','pptx']]) {
        const result = report[kind], pdf = FS.readFile(result.pdfPath);
        result[extension + 'Bytes'] = FS.stat(result[extension + 'Path']).size;
        result.pdfBytes = pdf.length; result.pdfHeader = String.fromCharCode(...pdf.subarray(0, 5));
        if (kind === 'impress') result.pdfBase64 = toBase64(pdf);
        report.ok = report.ok && result.pdfHeader === '%PDF-' && result[extension + 'Bytes'] > 100;
        delete result.pdfPath; delete result[extension + 'Path'];
      }
      report.impress.odpBytes = FS.stat(report.impress.odpPath).size;
      report.ok = report.ok && report.impress.odpBytes > 100;
      delete report.impress.odpPath;
      for (const asset of report.artifacts) { try { FS.unlink(asset.path); } catch {} }
      delete report.artifacts;
    }
    if (request.action === 'export') {
      const bytes = FS.readFile(message.data.path);
      FS.unlink(message.data.path);
      const result = { extension: message.data.extension, name: message.data.name, revision: message.data.revision, dirty: message.data.dirty,
        ...(message.data.extension === 'pptx' ? { chartProof: validateChartProof(message.data.chartProof) } : {}) };
      // FS.readFile returns an owned buffer. Transfer it without a second
      // document-sized base64 string crossing and remaining in the host realm.
      if (request.data.binary === true) reply(request, true, { ...result, buffer: bytes.buffer }, undefined, [bytes.buffer]);
      else reply(request, true, { ...result, base64: toBase64(bytes) });
    } else reply(request, true, message.data);
  } catch (error) { reply(request, false, undefined, errorText(error)); }
}
// Native evidence is forwarded only as bounded primitive fields. The outer
// editor still binds the response to the same document/session and revision.
function validateChartProof(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20000) throw Error('图表修改证据无效，已停止保存。');
  return value.map(item => {
    if (!item || typeof item.pageId !== 'string' || !item.pageId.length || item.pageId.length > 500
      || typeof item.shapeName !== 'string' || !item.shapeName.length || item.shapeName.length > 300
      || /[\x00-\x1f\x7f]/.test(item.pageId + item.shapeName) || typeof item.sourceEligible !== 'boolean'
      || (item.sourceShapeName !== undefined && (typeof item.sourceShapeName !== 'string' || !item.sourceShapeName.length || item.sourceShapeName.length > 300 || /[\x00-\x1f\x7f]/.test(item.sourceShapeName)))) throw Error('图表修改证据无效，已停止保存。');
    return { pageId: item.pageId, shapeName: item.shapeName, sourceEligible: item.sourceEligible,
      ...(item.sourceShapeName !== undefined ? { sourceShapeName: item.sourceShapeName } : {}) };
  });
}
canvas.addEventListener('wheel', event => event.preventDefault(), { passive: false });
window.addEventListener('keydown', event => {
  if (event.key === 'F5' && !event.ctrlKey && !event.metaKey && !event.altKey && activeDocumentKind === 'presentation') {
    // Qt's native slideshow path crashes this pinned WASM runtime. Capture both
    // F5 variants before Qt sees them and use the app's explicitly static preview.
    event.preventDefault(); event.stopImmediatePropagation();
    port?.postMessage({ requestId: `preview-key-${++fileCounter}`, action: 'preview-presentation',
      documentId: activeDocumentId, data: { fromCurrent: event.shiftKey } });
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const type = key === 's' ? (event.shiftKey ? 'save-as' : 'save') : key === 'o' ? 'open' : key === 'p' ? 'print' : '';
  if (type) { event.preventDefault(); event.stopImmediatePropagation(); send({ event: 'native-request', documentId: activeDocumentId, data: { type } }); }
}, true);
window.addEventListener('pagehide', () => {
  disposed = true; pending.clear();
  // The app has already resolved unsaved edits before removing this iframe.
  // Stop both active and pooled workers now instead of waiting for GC to reap
  // their WebAssembly instances and shared memory references.
  port?.close(); port = null;
  window.PThread?.terminateAllThreads();
}, { once: true });
async function start() {
  await diagnoseFeatures();
  if (!session || parent === window) throw Error('请从 Open Office 应用打开编辑器。');
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw Error('当前窗口不支持共享内存。请使用完整桌面安装包，或带 COOP/COEP 响应头的本机 HTTP 服务。');
  progress('正在准备中文字体', 5);
  const fontResponse = await fetch(new URL('NotoSansCJKsc-Regular.otf', runtimeBase));
  if (!fontResponse.ok) throw Error('缺少中文字体资源，请重新下载完整办公组件。');
  let font = new Uint8Array(await fontResponse.arrayBuffer());
  smokeDiagnostic('font-ready', { bytes: font.byteLength });
  window.Module = {
    canvas,
    uno_scripts: ['offline-policy.js', ...(smokeMode ? ['offline-audit.js'] : []), 'zeta.js', 'presentation-objects.js', 'writer-tools.js', 'calc-tools.js', 'office-worker.js'].map(name => new URL(name, adapterBase).href),
    locateFile: path => new URL(path, runtimeBase).href,
    mainScriptUrlOrBlob: new Blob([`importScripts(${JSON.stringify(new URL('offline-policy.js', adapterBase).href)});OpenOfficeOfflinePolicy.installLocalTransport(globalThis,${JSON.stringify(location.origin)});importScripts(${JSON.stringify(new URL('soffice.js', runtimeBase).href)});`], { type: 'application/javascript' }),
    preRun: [() => {
      // This pinned runtime executes its own preRun first (which sets 4).
      // A two-worker computation limit avoids idle instances on small machines.
      ENV.MAX_CONCURRENCY = '2';
      // This directory is explicitly listed in the runtime fontconfig.
      FS.mkdirTree('/usr/share/fonts/open-office');
      FS.writeFile('/usr/share/fonts/open-office/NotoSansCJKsc-Regular.otf', font, { canOwn: true });
      font = null;
    }],
    setStatus: text => {
      const match = String(text).match(/\((\d+)\/(\d+)\)/);
      progress('正在加载本地办公引擎，首次启动需要稍候', match ? Math.min(90, 10 + Number(match[1]) / Number(match[2]) * 80) : 25);
    },
    onRuntimeInitialized: () => {
      // preRun downloads soffice.data asynchronously. At this hook the complete
      // virtual FS exists, and application main/configuration have not run yet.
      try {
        const offline = OpenOfficeOfflinePolicy.prepareFileSystem(FS);
        smokeDiagnostic('offline-policy', offline);
        smokeDiagnostic('runtime-initialized');
      } catch (error) { fail(error); throw error; }
    },
    ...(smokeMode ? { monitorRunDependencies: count => { diagnosticDependencies = count; } } : {}),
    onAbort: reason => fail(reason, '办公引擎已停止：'),
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
    smokeDiagnostic('script-loaded', { unoPromise: typeof Module.uno_main?.then, heapBytes: diagnosticHeapBytes(Module) });
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
