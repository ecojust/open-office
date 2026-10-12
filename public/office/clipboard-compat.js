/* Qt's WASM clipboard setup queries both clipboard permission descriptors but
 * discards the returned promises. WebKit implements Clipboard.readText while
 * rejecting these unsupported Permissions API descriptors with TypeError.
 * Handle that advisory-query rejection without granting access or changing the
 * original promise. Actual clipboard reads/writes still use browser permissions.
 * Upstream: qtbase/src/plugins/platforms/wasm/qwasmclipboard.cpp, setUp(). */
'use strict';
function installOfficeClipboardPermissionCompatibility(permissions, onUnsupported) {
  if (!permissions || typeof permissions.query !== 'function') return () => {};
  const originalQuery = permissions.query;
  function query(...args) {
    const result = Reflect.apply(originalQuery, this, args);
    const name = args[0]?.name;
    if ((name === 'clipboard-read' || name === 'clipboard-write') && typeof result?.catch === 'function') {
      // Keep the rejected original promise available to any caller that awaits
      // it. Only Qt's otherwise unobserved unsupported-descriptor rejection is
      // nonfatal; permission denial and unexpected failures are never granted.
      void result.catch(error => {
        if (error?.name === 'TypeError') onUnsupported(name, error);
        else throw error;
      });
    }
    return result;
  }
  permissions.query = query;
  return () => { if (permissions.query === query) permissions.query = originalQuery; };
}
