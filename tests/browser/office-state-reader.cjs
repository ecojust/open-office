/* Test-only, read-only observer for the public same-origin office protocol.
 * Works with production Vue without devtools, component internals or worker hooks. */
function installObserver() {
  if (window !== window.top) return;
  const channel = 'open-office-engine', records = new WeakMap(), pending = new Map();
  const allowed = new Set(['word-state', 'sheet-state']);
  function active() {
    const frames = [...document.querySelectorAll('iframe.office-frame')];
    if (frames.length !== 1) return null;
    const frame = frames[0], url = new URL(frame.src, location.href);
    const session = new URLSearchParams(url.hash.slice(1)).get('session');
    if (url.origin !== location.origin || !/\/office\/host\.html$/.test(url.pathname) || !session || !frame.contentWindow) return null;
    return { frame, source: frame.contentWindow, session, origin: url.origin };
  }
  function stateKind(data) {
    if (!data || typeof data.documentId !== 'string' || !data.documentId || !Number.isSafeInteger(data.revision) || !data.selection) return null;
    if (data.page && data.paragraph && data.textStyle) return 'word-state';
    if (Array.isArray(data.sheets) && data.cell && data.format) return 'sheet-state';
    return null;
  }
  window.addEventListener('message', event => {
    const target = active(), message = event.data;
    if (!target || event.source !== target.source || event.origin !== target.origin || !message ||
      message.channel !== channel || message.session !== target.session || typeof message.requestId !== 'string' || !message.requestId) return;
    const request = pending.get(message.requestId);
    if (request) {
      pending.delete(message.requestId); clearTimeout(request.timer);
      if (request.frame !== target.frame || request.source !== target.source || request.session !== target.session) {
        request.reject(Error('Office frame changed during read-only state request.')); return;
      }
      if (message.ok !== true) { request.reject(Error(message.error || 'Read-only office state request failed.')); return; }
      if (stateKind(message.data) !== request.action || message.data.documentId !== request.documentId) {
        request.reject(Error('Office document changed during read-only state request.')); return;
      }
      request.resolve(message.data);
    }
    // Observe only successful, typed state responses from the current iframe.
    // Opening a document already makes the application request this state.
    const action = message.ok === true ? stateKind(message.data) : null;
    if (action) records.set(target.frame, { session: target.session, documentId: message.data.documentId, action });
  });
  function current(action) {
    if (!allowed.has(action)) throw Error('Only word-state and sheet-state reads are allowed.');
    const target = active(), record = target && records.get(target.frame);
    return target && record && record.session === target.session && record.action === action ? { ...target, ...record } : null;
  }
  window.__officeReadOnlyState = Object.freeze({
    ready: action => !!current(action),
    read(action) {
      const target = current(action);
      if (!target) return Promise.reject(Error('No current office state has been observed.'));
      const requestId = 'ui-state-audit-' + crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error('Read-only office state request timed out.')); }, 30000);
        pending.set(requestId, { ...target, action, resolve, reject, timer });
        try { target.source.postMessage({ channel, session: target.session, requestId, action, documentId: target.documentId, data: {} }, target.origin); }
        catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
      });
    },
  });
}
async function installOfficeStateReader(page) { await page.addInitScript(installObserver); }
async function readOfficeState(page, action) {
  if (!['word-state', 'sheet-state'].includes(action)) throw Error('Only word-state and sheet-state reads are allowed.');
  await page.waitForFunction(action => window.__officeReadOnlyState?.ready(action), action, { timeout: 30000 });
  return page.evaluate(action => window.__officeReadOnlyState.read(action), action);
}
module.exports = { installOfficeStateReader, readOfficeState };
