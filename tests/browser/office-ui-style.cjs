/* Visual acceptance of the shared interface fonts and SVG icons.
 * Build all four WASM engines first. Each surface owns a fresh Chromium process
 * so the four large document engines are never resident at the same time.
 * Run: node tests/browser/office-ui-style.cjs
 * Screenshots still require visual review; DOM font checks cannot inspect glyphs
 * painted inside a WebGL canvas or prove native OS font rasterization.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_UI_STYLE_OUTPUT || path.join(root, 'test-results/office-ui-style'));
const fontFamily = 'Office UI';
const cjkFontFamily = 'Office UI CJK';
const surfaces = ['home', 'word', 'sheet', 'presentation', 'pdf', 'note'];
const canvasIds = { word: 'office-word-canvas', sheet: 'office-sheet-canvas', presentation: 'office-presentation-canvas', pdf: 'pdf-canvas' };
const handleNames = { word: 'rustWordHandles', sheet: 'rustSheetHandles', presentation: 'rustPresentationHandles', pdf: 'rustPdfHandles', note: 'noteHandles' };
const report = { ok: false, startedAt: new Date().toISOString(), expectedUiFontFamily: fontFamily,
  runtime: 'Real Vue UI and local packaged Rust/WASM in sequential Chromium processes',
  checks: [], screenshots: [], surfaces: [], pageErrors: [], consoleErrors: [], failedRequests: [], externalRequests: [], fontRequests: [],
  limitations: ['WebGL UI glyph and icon appearance requires manual review of the screenshots.',
    'Read-only renderer geometry checks cover exposed controls; presentation ribbon geometry requires screenshot review.',
    'Browser rendering does not verify installed Tauri WebViews, native dialogs or OS-specific font rasterization.',
    'Only interface typography is checked; document content font selection and file compatibility have separate suites.'] };
let server, browser, page, origin, surface;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const phase = label => { report.phase = label; console.log('PHASE', label); persist(); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const sourceFiles = ['src/App.vue', 'src/style.css', 'src/components/Icon.vue', 'src/components/NotebookEditor.vue',
  'src/icons/drawing.ts', 'src/icons/shell-aliases.ts', 'assets/fonts/deck/Inter-Regular.ttf',
  'assets/fonts/deck/Inter-SemiBold.ttf', 'assets/fonts/ui/WenQuanYiMicroHei-Regular.ttf',
  ...fs.readdirSync(path.join(root, 'src/icons/svg/shell')).filter(file => file.endsWith('.svg')).sort().map(file => 'src/icons/svg/shell/' + file),
  ...['word', 'sheet', 'presentation', 'pdf'].map(kind => `public/office-${kind}/manifest.json`)];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha(file)]));
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function state() {
  if (surface === 'home') return null;
  return page.evaluate(async ({ name, surface }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const handle = app[name]?.get(app.activeKey);
    if (!handle) return null;
    const inspection = await handle.inspect();
    return { inspection, ui: surface === 'pdf' ? await handle.query('ui.state') : inspection.ui };
  }, { name: handleNames[surface], surface });
}
async function until(read, accept, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    let timer;
    try {
      last = await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(description + ' timed out')), deadline - Date.now()); })]);
      if (accept(last)) return last;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  fs.writeFileSync(path.join(output, 'last-state.json'), JSON.stringify({ description, last }, null, 2));
  throw Error(description + ' timed out; see last-state.json');
}
async function ready() {
  await page.getByTestId('global-toolbar').waitFor();
  if (surface === 'home') return;
  await until(() => page.evaluate(() => {
    const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
    if (app?.active?.loadError) throw Error(app.active.loadError);
    return !!app?.active?.ready && !app.busy && !document.querySelector('.busy-overlay');
  }), Boolean, surface + ' editor readiness');
  if (canvasIds[surface]) await page.getByTestId(canvasIds[surface]).waitFor();
  await until(state, value => !!value && (surface === 'note' || !!value.ui), surface + ' rendered state');
  await frames();
}
function documentIdentity(value) {
  const doc = value?.inspection;
  if (!doc) return null;
  return { revision: doc.revision, dirty: doc.dirty, canUndo: doc.canUndo, canRedo: doc.canRedo };
}
async function setTheme(theme) {
  await page.getByTestId('theme-' + theme).click();
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
  if (['word', 'sheet'].includes(surface)) await until(state, value => value?.ui?.theme?.resolved === theme, surface + ' canvas theme ' + theme, 30000);
  if (surface === 'presentation') await until(state, value => value?.ui?.ui?.brightness === theme, 'presentation canvas theme ' + theme, 30000);
  if (surface === 'pdf') await until(state, value => value?.ui?.theme?.toLowerCase() === theme, 'PDF canvas theme ' + theme, 30000);
  if (surface === 'note') await page.waitForFunction(theme => document.querySelector('[data-testid="notebook-editor"]')?.getAttribute('data-theme') === theme, theme);
  await frames();
}
async function inspectDom() {
  return page.evaluate(async expectedFamily => {
    await document.fonts.ready;
    const visible = node => {
      // Closed details can retain layout boxes for descendants in Chromium.
      const closed = node.closest('details:not([open])');
      if (closed && !closed.querySelector(':scope > summary')?.contains(node)) return false;
      const box = node.getBoundingClientRect();
      return node.checkVisibility({ visibilityProperty: true }) && box.width > 0 && box.height > 0;
    };
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const controlSelectors = '[data-testid="global-toolbar"] button, [data-testid="global-toolbar"] summary, [data-testid="global-appearance"] button, .create-card, .sidebar button, .note-toolbar button, .note-toolbar select, .note-sidebar button, .note-sidebar input';
    const controlContainers = '[data-testid="global-toolbar"], [data-testid="global-appearance"], .note-toolbar';
    const controls = [...document.querySelectorAll(controlSelectors)].filter(visible).map(node => ({
      label: node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent.trim(),
      fontFamily: getComputedStyle(node).fontFamily, fontSize: getComputedStyle(node).fontSize, fontSynthesis: getComputedStyle(node).fontSynthesis, rect: rect(node),
      parent: node.closest(controlContainers) ? rect(node.closest(controlContainers)) : null,
    }));
    const icons = [...document.querySelectorAll('[data-testid="global-toolbar"] svg, [data-testid="global-appearance"] svg, .create-card svg, .note-toolbar svg, .note-sidebar svg')].filter(visible).map(node => ({
      viewBox: node.getAttribute('viewBox'), strokeWidth: node.getAttribute('stroke-width'),
      linecap: node.getAttribute('stroke-linecap'), linejoin: node.getAttribute('stroke-linejoin'),
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
      paths: node.querySelectorAll('path').length,
    }));
    const cards = [...document.querySelectorAll('.create-card')].filter(visible).map(node => ({
      label: node.querySelector('strong').textContent, rect: rect(node),
      icon: rect(node.querySelector('.document-art')), title: rect(node.querySelector('strong')),
    }));
    const appearanceNodes = [...document.querySelectorAll('[data-testid="global-appearance"]')];
    const appearance = appearanceNodes[0];
    const globalChrome = {
      appearanceCount: appearanceNodes.length,
      appearanceVisible: !!appearance && visible(appearance),
      appearance: appearance ? rect(appearance) : null,
      toolbar: rect(document.querySelector('[data-testid="global-toolbar"]')),
      brands: document.querySelectorAll('button[aria-label="返回工作台"]').length,
      toolbarBrands: document.querySelectorAll('[data-testid="global-toolbar"] button[aria-label="返回工作台"]').length,
      themes: ['light', 'dark', 'system'].map(theme => ({
        theme,
        count: document.querySelectorAll(`[data-testid="theme-${theme}"]`).length,
        visibleInAppearance: !!appearance && [...appearance.querySelectorAll(`[data-testid="theme-${theme}"]`)].some(visible),
      })),
      informationCount: document.querySelectorAll('button[aria-label="使用说明"]').length,
      informationVisibleInAppearance: !!appearance && [...appearance.querySelectorAll('button[aria-label="使用说明"]')].some(visible),
    };
    return { bodyFontFamily: getComputedStyle(document.body).fontFamily, bodyFontSynthesis: getComputedStyle(document.body).fontSynthesis, controls, icons, cards, globalChrome,
      fonts: [...document.fonts].map(font => ({ family: font.family, weight: font.weight, status: font.status })),
      fontReady: document.fonts.check(`13px "${expectedFamily}"`, '打开 保存 字体 ABC 123'),
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      iframes: document.querySelectorAll('iframe').length };
  }, fontFamily);
}
async function verifyLayout(theme, width) {
  await page.setViewportSize({ width, height: 1000 }); await frames(); await frames();
  const dom = await inspectDom();
  assert.equal(dom.iframes, 0, 'No iframe-based editor');
  const chrome = dom.globalChrome;
  assert.equal(chrome.appearanceCount, 1, 'One global appearance area');
  assert.ok(chrome.appearanceVisible, 'Global appearance controls remain visible at every tested viewport');
  assert.equal(chrome.brands, 1, 'One application brand');
  assert.equal(chrome.toolbarBrands, 0, 'The file toolbar does not repeat the application brand');
  assert.equal(chrome.informationCount, 1, 'One global information control');
  assert.ok(chrome.informationVisibleInAppearance, 'Information is available beside the bottom-left theme controls');
  assert.ok(chrome.appearance.x >= -1 && chrome.appearance.x + chrome.appearance.width <= chrome.toolbar.x + 1,
    'Appearance controls occupy the left sidebar, outside the file toolbar');
  assert.ok(chrome.appearance.y >= dom.viewport.height / 2 && chrome.appearance.y + chrome.appearance.height <= dom.viewport.height + 1,
    'Appearance controls remain at the bottom left without escaping the viewport');
  for (const themeControl of chrome.themes) {
    assert.equal(themeControl.count, 1, 'One theme control ' + themeControl.theme);
    assert.ok(themeControl.visibleInAppearance, 'Theme control remains visible in the global appearance area: ' + themeControl.theme);
  }
  assert.ok(dom.controls.length > 8, 'Actual interface controls are visible');
  assert.ok(dom.fontReady, 'Shared UI font has loaded');
  assert.ok(dom.fonts.some(font => font.family.replaceAll('"', '') === fontFamily && font.status === 'loaded'), 'Bundled font face is actually loaded, not an implicit system fallback');
  assert.ok(dom.fonts.some(font => font.family.replaceAll('"', '') === cjkFontFamily && font.status === 'loaded'), 'Bundled Chinese UI font is actually loaded');
  assert.equal(dom.bodyFontSynthesis, 'none', 'UI uses real supplied font weights');
  for (const control of dom.controls) {
    assert.equal(control.fontFamily.split(',')[0].replaceAll('"', '').trim(), fontFamily, surface + ' control uses shared font: ' + control.label);
    assert.ok(control.fontFamily.includes(cjkFontFamily), surface + ' control includes shared Chinese font: ' + control.label);
    assert.equal(control.fontSynthesis, 'none', surface + ' control disables synthetic fonts: ' + control.label);
    if (control.parent) {
      const { rect: box, parent } = control;
      assert.ok(box.x >= parent.x - 1 && box.y >= parent.y - 1 && box.x + box.width <= parent.x + parent.width + 1 && box.y + box.height <= parent.y + parent.height + 1,
        `${surface} ${width}: toolbar control is within its toolbar: ${control.label}`);
    }
  }
  assert.ok(dom.horizontalOverflow <= 1, `${surface} ${width}: app must not horizontally overflow the viewport`);
  assert.ok(dom.icons.length > 8, 'Interface exposes real SVG icons');
  for (const icon of dom.icons) {
    assert.equal(icon.viewBox, '0 0 24 24');
    assert.equal(Number(icon.strokeWidth), 1.65);
    assert.equal(icon.linecap, 'round'); assert.equal(icon.linejoin, 'round');
    assert.ok(icon.paths > 0); assert.ok(Math.abs(icon.width - icon.height) < .1, 'Icons keep their square aspect ratio');
  }
  for (const card of dom.cards) {
    const sameRow = dom.cards.filter(other => Math.abs(other.rect.y - card.rect.y) < 1);
    for (const other of sameRow) {
      assert.ok(Math.abs(other.icon.y - card.icon.y) < 1 && Math.abs(other.title.y - card.title.y) < 1,
        `Home cards align their icons and titles when descriptions wrap: ${card.label}, ${other.label}`);
    }
  }
  const engineState = await state();
  let geometry = null;
  if (canvasIds[surface]) {
    const box = await page.getByTestId(canvasIds[surface]).boundingBox();
    assert.ok(box && box.width > 100 && box.height > 100, 'Visible nonempty rendering canvas');
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1, 'Canvas fits the viewport');
    const controls = surface === 'pdf' ? engineState.ui.toolbar : engineState.ui?.drawnChrome;
    if (controls) for (const item of controls) {
      const [x, y, w, h] = item.rect;
      assert.ok(x >= -1 && y >= -1 && x + w <= box.width + 1 && y + h <= box.height + 1,
        `${surface} ${width}: exposed canvas control ${item.id} stays in bounds: ${JSON.stringify(item.rect)}`);
    }
    geometry = { canvas: box, controls: controls || null };
  }
  const file = `${surface}-${theme}-${width}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true });
  report.screenshots.push(file);
  report.surfaces.push({ surface, theme, width, dom, geometry, documentIdentity: documentIdentity(engineState) });
  persist();
}
async function checkSurface(kind) {
  surface = kind; phase(kind);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light', deviceScaleFactor: 1 });
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push({ surface, url });
    if (request.resourceType() === 'font' || /\.(?:woff2?|[ot]tf)(?:\?|$)/.test(url)) report.fontRequests.push({ surface, url });
  });
  context.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.failedRequests.push({ surface, url: request.url(), error: request.failure()?.errorText }); });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push({ surface, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ surface, message: message.text() }); });
  await page.goto(origin); await page.getByTestId('global-toolbar').waitFor();
  if (kind !== 'home') {
    await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-' + kind).click(); await ready();
  }
  const before = documentIdentity(await state());
  await setTheme('light'); await verifyLayout('light', 1440);
  await setTheme('dark'); await verifyLayout('dark', 1440);
  await verifyLayout('dark', 800);
  if (kind === 'home') await verifyLayout('dark', 480);
  assert.deepEqual(documentIdentity(await state()), before, 'Appearance and viewport changes preserve document edits/history');
  report.checks.push(kind + ': light/dark, shared fonts and SVG style, desktop/compact layout, unchanged document history');
  await browser.close(); browser = undefined; page = undefined; persist();
}
(async () => {
  try {
    phase('artifact-check'); report.artifactChecks = {};
    for (const kind of ['word', 'sheet', 'presentation', 'pdf']) report.artifactChecks[kind] = execFileSync(process.execPath, [path.join(root, `scripts/build-office-${kind}.mjs`), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.sourcesBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: Number(process.env.OFFICE_UI_STYLE_PORT || 5316), strictPort: true, hmr: false,
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
    } });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const kind of surfaces) await checkSurface(kind);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.failedRequests, []); assert.deepEqual(report.externalRequests, []);
    assert.ok(report.fontRequests.length > 0, 'Local web font delivery was observed');
    report.sourcesAfter = hashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Sources and runtime manifests stayed frozen during verification');
    fs.rmSync(path.join(output, 'failure.png'), { force: true });
    fs.rmSync(path.join(output, 'last-state.json'), { force: true });
    report.ok = true;
  } catch (error) {
    report.failure = { phase: report.phase, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
      report.lastState = await state().catch(() => null);
    }
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); persist(); await browser?.close(); await server?.close();
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failure: report.failure?.message, report: path.join(output, 'report.json') }));
  }
})();
