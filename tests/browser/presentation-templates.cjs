/* Real Vue controls + Rust/WASM. Browser validation, not native package acceptance. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_TEMPLATE_TEST_OUTPUT || path.join(root, 'test-results/presentation-templates'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Chromium + actual Rust/WASM', checks: [], templates: [], errors: [] };
const check = message => { report.checks.push(message); console.log(message); };
let server, browser, page;
const state = () => page.evaluate(async () => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  const editor = app.rustPresentationHandles.get(app.activeKey);
  return { key: app.activeKey, name: app.active.document.name, fileId: app.active.fileId, tabCount: app.tabs.length,
    dirty: app.active.dirty, snapshot: await editor.inspect(),
    slides: await Promise.all([0, 1, 2].map(index => editor.query('slide.inspect', { index }))) };
});
const ready = () => page.waitForFunction(() => {
  const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
  if (app?.active?.loadError) throw Error(app.active.loadError);
  return app?.active?.ready && !app.busy;
}, null, { timeout: 120000 });
async function confirm() {
  await page.getByTestId('presentation-template-confirm').click();
  await page.getByTestId('presentation-template-dialog').waitFor({ state: 'hidden' });
  await ready();
}
async function createPresentation() {
  await page.getByTestId('shell-new').click();
  await page.getByTestId('shell-new-presentation').click();
  await ready();
}
const ribbonState = () => page.evaluate(async () => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  return app.rustPresentationHandles.get(app.activeKey).query('ui.inspect');
});
async function waitForEditor(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Evaluate and await the query before checking its result. Passing an async
    // predicate to the page poller would make the Promise itself truthy.
    const value = await page.evaluate(predicate);
    if (value) return value;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  throw Error('Timed out waiting for the presentation renderer state');
}
async function toggleTemplates() {
  const { ui, canvas } = await waitForEditor(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const ui = await app.rustPresentationHandles.get(app.activeKey).query('ui.inspect');
    const canvas = document.querySelector('[data-testid="office-presentation-canvas"]').getBoundingClientRect();
    // Vue changes the canvas width when the gallery opens. Wait for the actual
    // Rust frame, and capture both coordinate systems together: another await
    // between them could combine an old frame with a freshly resized DOM box.
    if (ui.ribbonTabs.some(tab => tab.name === 'Templates') &&
      Math.abs(ui.window[0] - canvas.width) < 1 && Math.abs(ui.window[1] - canvas.height) < 1) return { ui, canvas: canvas.toJSON() };
    return false;
  });
  const tabs = ui.ribbonTabs;
  const index = tabs.findIndex(tab => tab.name === 'Templates'), button = tabs[index], view = tabs[index - 1];
  assert.equal(view.name, 'View'); assert.equal(button.label, '模板');
  assert.ok(button.rect[0] >= view.rect[0] + view.rect[2]);
  assert.equal(button.rect[1], view.rect[1]);
  const [x, y, width, height] = button.rect;
  await page.mouse.click(canvas.x + (x + width / 2) * canvas.width / ui.window[0], canvas.y + (y + height / 2) * canvas.height / ui.window[1]);
}
async function exportDeck(format) {
  return page.evaluate(async format => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return app.rustPresentationHandles.get(app.activeKey).exportFile({ format });
  }, format);
}
(async () => {
  try {
    execFileSync(process.execPath, ['scripts/build-office-presentation.mjs', '--check'], { cwd: root, stdio: 'pipe' });
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
    } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN', colorScheme: 'light' });
    page = await context.newPage(); page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await createPresentation();
    page.setDefaultTimeout(20000);
    console.log('Presentation ready for ribbon pointer checks');
    const baseline = await state();
    assert.equal(await page.getByTestId('global-toolbar').getByRole('button', { name: '演示模板' }).count(), 0);
    const beforeRibbon = await ribbonState();
    await toggleTemplates();
    await page.getByRole('complementary', { name: '演示模板' }).waitFor({ timeout: 15000 });
    await page.locator('.presentation-template-card').nth(9).waitFor({ state: 'attached' });
    const openedRibbon = await ribbonState();
    assert.equal(openedRibbon.templatePanelOpen, true);
    assert.equal(openedRibbon.ui.tab, beforeRibbon.ui.tab);
    assert.equal((await state()).snapshot.revision, baseline.snapshot.revision);
    assert.equal((await state()).dirty, baseline.dirty);
    await toggleTemplates();
    await page.getByRole('complementary', { name: '演示模板' }).waitFor({ state: 'hidden' });
    assert.equal((await ribbonState()).templatePanelOpen, false);
    await toggleTemplates();
    await page.locator('.presentation-template-card').nth(9).waitFor();
    check('Templates is immediately after View in the PPT ribbon; toggling preserves active ribbon, content and dirty state');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/presentation-templates/manifest.json')));
    assert.equal(manifest.length, 10); assert.equal(await page.locator('.presentation-template-card').count(), 10);
    check('10 built-in templates are reachable in the gallery');
    await page.getByTestId('presentation-template-blueprint').click();
    assert.equal(await page.getByTestId('global-toolbar').evaluate(el => el.inert), true);
    assert.equal(await page.locator('.editor-workspace').evaluate(el => el.inert), true);
    await page.keyboard.press('Control+s');
    assert.equal(await page.getByTestId('save-format-dialog').count(), 0);
    await page.getByTestId('presentation-template-cancel').click();
    const cancelled = await state();
    assert.deepEqual(cancelled.slides, baseline.slides); assert.equal(cancelled.snapshot.revision, baseline.snapshot.revision);
    check('Template confirmation blocks background controls; cancellation leaves content and revision intact');
    for (const template of manifest) {
      await page.getByTestId(`presentation-template-${template.id}`).click(); await confirm();
      const current = await state();
      assert.equal(current.key, baseline.key); assert.equal(current.name, baseline.name);
      assert.equal(current.fileId, baseline.fileId); assert.equal(current.tabCount, baseline.tabCount);
      assert.equal(current.snapshot.documentId, baseline.snapshot.documentId);
      assert.equal(current.snapshot.slides.length, 3); assert.equal(current.dirty, true);
      for (const slide of current.slides) assert.ok(slide.shapes.filter(shape => typeof shape.text === 'string' && shape.text.trim()).length >= 2);
      const pptx = await exportDeck('pptx'), pdf = await exportDeck('pdf');
      fs.writeFileSync(path.join(output, template.file), Buffer.from(pptx.base64, 'base64'));
      fs.writeFileSync(path.join(output, `${template.id}.pdf`), Buffer.from(pdf.base64, 'base64'));
      const reopened = await page.evaluate(async ({ base64, name }) => {
        const { prepareRustPresentationDocument } = await import('/src/presentation/rust/client.ts');
        const document = { id: `reopen-${name}`, name, kind: 'presentation', extension: 'pptx', base64, sizeBytes: 0, sha256: '' };
        const prepared = await prepareRustPresentationDocument(document), session = prepared.take(document);
        try { return { snapshot: await session.inspect(), slides: await Promise.all([0, 1, 2].map(index => session.query('slide.inspect', { index }))) }; }
        finally { await session.close(true); }
      }, { base64: pptx.base64, name: template.file });
      assert.equal(reopened.snapshot.slides.length, 3);
      const texts = slides => slides.map(slide => slide.shapes.map(shape => shape.text).filter(Boolean));
      assert.deepEqual(texts(reopened.slides), texts(current.slides));
      report.templates.push({ id: template.id, name: template.name, slideCount: 3, texts: texts(current.slides), warnings: current.snapshot.warnings });
      if (template.id === 'blueprint') {
        await page.getByRole('button', { name: '撤销', exact: true }).click(); await ready();
        assert.deepEqual((await state()).slides, baseline.slides);
        await page.getByRole('button', { name: '重做', exact: true }).click(); await ready();
        assert.deepEqual((await state()).slides, current.slides);
        check('One undo restores the entire prior deck; redo reapplies the template');
      }
      console.log(`Rendered and reopened ${template.id}`);
    }
    check('All 10 templates apply, export PPTX/PDF, and reopen with 30 editable slides; document identity is retained');
    const beforeSave = await state();
    await page.getByTestId('presentation-template-save').click();
    await page.getByTestId('presentation-template-name').fill('  ');
    await page.getByTestId('presentation-template-confirm').click();
    await page.getByRole('alert').filter({ hasText: '请输入模板名称' }).waitFor();
    await page.getByTestId('presentation-template-name').fill('我的三页演示'); await confirm();
    const saved = await state();
    assert.equal(saved.snapshot.revision, beforeSave.snapshot.revision); assert.equal(saved.dirty, beforeSave.dirty);
    assert.deepEqual(saved.slides, beforeSave.slides);
    const customId = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.presentationTemplates.find(item => item.source === 'custom').id);
    await page.getByTestId(`presentation-template-${customId}`).waitFor();
    check('Save as template validates names and preserves the current document and dirty state');
    const broken = await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      try { await app.rustPresentationHandles.get(app.activeKey).applyTemplate('YnJva2Vu'); return false; } catch { return true; }
    });
    assert.equal(broken, true); assert.deepEqual((await state()).slides, saved.slides);
    check('A damaged template is rejected without replacing current slides');
    await page.getByTestId('theme-dark').click();
    await page.screenshot({ path: path.join(output, 'gallery-dark.png') });
    await page.getByTestId('theme-light').click();
    await page.getByTestId('presentation-template-blueprint').click();
    await page.screenshot({ path: path.join(output, 'confirmation.png') });
    await page.getByTestId('presentation-template-cancel').click();
    await page.locator('.presentation-templates-list').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, 'gallery-light.png') });
    await page.setViewportSize({ width: 850, height: 780 });
    const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, panel: document.querySelector('.template-panel').getBoundingClientRect().toJSON(), stage: document.querySelector('.editor-stage').getBoundingClientRect().toJSON() }));
    assert.ok(viewport.scrollWidth <= viewport.width + 1); assert.ok(viewport.panel.right <= viewport.width + 1);
    assert.ok(viewport.panel.bottom <= viewport.stage.bottom + 1);
    await page.screenshot({ path: path.join(output, 'gallery-narrow.png') });
    await toggleTemplates();
    await page.getByRole('complementary', { name: '演示模板' }).waitFor({ state: 'hidden' });
    await toggleTemplates();
    await page.getByRole('complementary', { name: '演示模板' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '关闭模板栏', exact: true }).click();
    assert.equal((await ribbonState()).templatePanelOpen, false);
    await toggleTemplates();
    await page.setViewportSize({ width: 1600, height: 1000 });
    check('Gallery and confirmation render in light/dark themes; narrow window keeps ribbon toggle accessible and panel close clears its indicator');
    await page.getByTestId('shell-new').click();
    await page.getByTestId('shell-new-note').click(); await ready();
    assert.equal(await page.getByRole('complementary', { name: '演示模板' }).count(), 0);
    assert.equal(await page.getByTestId('global-toolbar').getByRole('button', { name: '演示模板' }).count(), 0);
    await page.locator('.tab-name').filter({ hasText: baseline.name }).click(); await ready();
    await page.getByRole('complementary', { name: '演示模板' }).waitFor({ state: 'visible' });
    assert.equal((await ribbonState()).templatePanelOpen, true);
    assert.deepEqual((await state()).slides, saved.slides);
    check('Switching to Note hides PPT templates; returning restores the panel and presentation contents');
    page.once('dialog', dialog => dialog.accept());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await createPresentation(); await toggleTemplates();
    await page.getByTestId(`presentation-template-${customId}`).click(); await confirm();
    const restored = await state();
    assert.deepEqual(restored.slides.map(slide => slide.shapes.map(shape => shape.text).filter(Boolean)), saved.slides.map(slide => slide.shapes.map(shape => shape.text).filter(Boolean)));
    check('Custom templates survive a page reload and restore the saved deck');
    await page.getByRole('button', { name: '删除模板：我的三页演示', exact: true }).click();
    await page.getByTestId('presentation-template-cancel').click();
    assert.equal(await page.getByTestId(`presentation-template-${customId}`).count(), 1);
    await page.getByRole('button', { name: '删除模板：我的三页演示', exact: true }).click(); await confirm();
    assert.equal(await page.getByTestId(`presentation-template-${customId}`).count(), 0);
    assert.deepEqual((await state()).slides, restored.slides);
    check('Deleting a custom template requires confirmation and does not alter the open presentation');
    await page.getByRole('button', { name: '关闭模板栏', exact: true }).click();
    const beforeDuplicate = await state(), thumbnailUi = await ribbonState();
    const thumbWidth = thumbnailUi.ui.thumbsWidth ?? thumbnailUi.ui.thumbs_width ?? thumbnailUi.canvasRect[0];
    const thumbHeight = (thumbWidth - 40) * 540 / 960;
    const canvas = await page.getByTestId('office-presentation-canvas').boundingBox();
    const thumbY = thumbnailUi.canvasRect[1] + 8 + (thumbHeight + 20) + (thumbHeight + 16) / 2;
    await page.mouse.click(canvas.x + thumbWidth / 2 * canvas.width / thumbnailUi.window[0], canvas.y + thumbY * canvas.height / thumbnailUi.window[1]);
    await waitForEditor(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      return (await app.rustPresentationHandles.get(app.activeKey).inspect()).activeSlide === 1;
    });
    await page.keyboard.press('Enter');
    await waitForEditor(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      return (await app.rustPresentationHandles.get(app.activeKey).inspect()).slides.length === 4;
    });
    const duplicated = await state();
    assert.equal(duplicated.snapshot.activeSlide, 2);
    assert.notEqual(duplicated.slides[1].id, duplicated.slides[2].id);
    const content = slide => slide.shapes.map(({ id, ...shape }) => shape);
    assert.deepEqual(content(duplicated.slides[2]), content(beforeDuplicate.slides[1]));
    assert.equal(duplicated.snapshot.slides[3].id, beforeDuplicate.snapshot.slides[2].id);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await ready();
    assert.deepEqual((await state()).slides, beforeDuplicate.slides);
    check('Selecting the content thumbnail and pressing Enter duplicates its editable content immediately after it; one undo restores the deck');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1; console.error(error);
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      report.failureState = await page.evaluate(async () => {
        const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
        return { panel: app?.templatePanelOpen, error: app?.error, status: app?.status,
          canvas: document.querySelector('[data-testid="office-presentation-canvas"]')?.getBoundingClientRect().toJSON(),
          ui: await app?.rustPresentationHandles.get(app.activeKey)?.query('ui.inspect') };
      }).catch(() => null);
    }
  }
  finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await server?.close();
  }
})();
