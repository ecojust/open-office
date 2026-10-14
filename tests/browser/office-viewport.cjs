/* Test-only read-only viewport observation. Do not resize the native engine or
 * touch Module/Qt getters: this waits for its normal resize path to settle. */
async function waitForOfficeViewport(page, { timeout = 15000 } = {}) {
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) {
    throw Error('Office viewport timeout must be between 100 and 60000 ms.');
  }
  const started = Date.now();
  await page.locator('iframe.office-frame').waitFor({ state: 'visible', timeout });
  const remaining = timeout - (Date.now() - started);
  if (remaining < 100) throw Error('Office iframe did not become visible before the viewport deadline.');
  return page.evaluate(({ timeout }) => new Promise((resolve, reject) => {
    const started = performance.now(), stableRequired = 4, paintRequired = 2;
    let frameId = 0, done = false, last = null, previousKey = '', stableFrames = 0;
    let stableSince = 0, paintFrames = 0;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); cancelAnimationFrame(frameId);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error(
      'Office viewport did not settle: ' + JSON.stringify(last))), timeout);
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    function measure() {
      const frames = [...document.querySelectorAll('iframe.office-frame')];
      if (frames.length !== 1) return { ready: false, reason: 'Expected exactly one office iframe', count: frames.length };
      const frame = frames[0], url = new URL(frame.src, location.href);
      if (url.origin !== location.origin || !/\/office\/host\.html$/.test(url.pathname)) {
        return { ready: false, reason: 'Expected the same-origin office host' };
      }
      const host = frame.contentWindow, canvas = frame.contentDocument?.querySelector('#qtcanvas');
      if (!host || !canvas) return { ready: false, reason: 'Native canvas is not present yet' };
      const fs = getComputedStyle(frame), cs = host.getComputedStyle(canvas);
      const iframe = { ...rect(frame), clientWidth: frame.clientWidth, clientHeight: frame.clientHeight };
      const viewport = { width: host.innerWidth, height: host.innerHeight, dpr: host.devicePixelRatio };
      const drawing = { ...rect(canvas), width: canvas.width, height: canvas.height,
        cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height,
        clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight };
      // The native canvas can use fractional CSS pixels; framebuffer dimensions
      // are integral physical pixels. Allow two physical pixels of rounding.
      const near = (a, b, tolerance) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
      const dpr = viewport.dpr, physicalTolerance = Math.max(2, dpr);
      const ready = fs.visibility === 'visible' && fs.display !== 'none' && cs.visibility === 'visible' && cs.display !== 'none' &&
        iframe.width > 0 && iframe.height > 0 && drawing.cssWidth > 0 && drawing.cssHeight > 0 && dpr > 0 &&
        near(iframe.clientWidth, viewport.width, 1) && near(iframe.clientHeight, viewport.height, 1) &&
        near(drawing.cssWidth, viewport.width, 1) && near(drawing.cssHeight, viewport.height, 1) &&
        near(drawing.x, 0, 1) && near(drawing.y, 0, 1) &&
        near(drawing.width, drawing.cssWidth * dpr, physicalTolerance) &&
        near(drawing.height, drawing.cssHeight * dpr, physicalTolerance);
      return { ready, iframe, viewport, canvas: drawing };
    }
    function tick() {
      if (done) return;
      try {
        last = measure();
        const now = performance.now();
        const key = JSON.stringify(last);
        if (!last.ready || key !== previousKey) {
          stableFrames = last.ready ? 1 : 0; stableSince = now; paintFrames = 0;
        } else {
          stableFrames++;
          if (stableFrames >= stableRequired && now - stableSince >= 100) paintFrames++;
        }
        previousKey = key;
        if (last.ready && paintFrames >= paintRequired) {
          finish(null, { ...last, stableFrames, paintFrames, elapsedMs: Math.round(now - started) }); return;
        }
      } catch (error) {
        last = { ready: false, reason: String(error) }; previousKey = ''; stableFrames = 0; paintFrames = 0;
      }
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
  }), { timeout: remaining });
}
module.exports = { waitForOfficeViewport };
