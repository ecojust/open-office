// Injected only into the opt-in native smoke page. Passing still requires the
// complete mounted-editor/document checks and their normal IPC report.
(() => {
  const base = __OPEN_OFFICE_SMOKE_BASE_URL__;
  if (!location.href.startsWith(base) || new URL(location.href).searchParams.get('nativeSmoke') !== '1') return;
  const send = (path, body) => fetch(base + '__native-smoke/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
  send('progress', { phase: 'document-start', detail: 'native initialization script' });
  let failed = false;
  const failure = value => {
    if (failed) return;
    failed = true;
    send('failure', { ok: false, phase: 'renderer-uncaught', error: String(value).slice(0, 4000),
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined', userAgent: navigator.userAgent });
  };
  let resizeCount = 0, windowStart = performance.now(), windowCount = 0, busyWindows = 0;
  addEventListener('error', event => {
    // The browser reports deferred ResizeObserver delivery as an ErrorEvent
    // without an exception or source location. A callback throwing is distinct.
    if (event instanceof ErrorEvent && event.isTrusted && event.target === window
      && event.message === 'ResizeObserver loop completed with undelivered notifications.'
      && event.error == null && (event.filename === '' || event.filename === location.href)
      && event.lineno === 0 && event.colno === 0) {
      const now = performance.now(), elapsed = now - windowStart;
      resizeCount++;
      if (elapsed >= 1000) {
        busyWindows = elapsed < 2000 && windowCount >= 30 ? busyWindows + 1 : 0;
        windowStart = now; windowCount = 0;
      }
      windowCount++;
      if (resizeCount === 1 || windowCount === 1) send('progress', {
        phase: 'renderer-resize-observer-notification', detail: `count=${resizeCount}; consecutiveBusyWindows=${busyWindows}`,
      });
      // A brief mount/resize burst is recoverable; sustained feedback is not.
      if (busyWindows >= 3) failure('Persistent ResizeObserver notification loop across three successive observation windows.');
      return;
    }
    if (event.message) failure(event.message);
    else if (event.target?.tagName === 'SCRIPT') failure('Entry script failed to load');
  }, true);
  addEventListener('unhandledrejection', event => failure(event.reason?.message || event.reason));
})();
