/* Real Vue/Rust PDF canvas regression for unfinished annotation text.
 * Run after pdf:check: node tests/browser/pdf-comment-drafts.cjs
 * --baseline records the old packaged WASM's known failures; it is not a passing release check.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '../..');
const baseline = process.argv.includes('--baseline');
const output = process.env.OFFICE_PDF_DRAFT_OUTPUT
  ? path.resolve(process.env.OFFICE_PDF_DRAFT_OUTPUT)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'open-office-pdf-drafts-'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, baseline, runtime: 'Real Vue PDF editor and packaged Rust WASM in Chromium', checks: [], knownFailures: [], screenshots: [], exports: [], errors: [], externalRequests: [],
  limitations: ['Native WebView, operating-system IME and native file dialogs are not exercised.', 'Annotation entry, highlighting and undo use real browser mouse/keyboard input.'] };
const files = ['src/components/RustPdfEditor.vue', 'src/pdf/rust/client.ts', 'public/office-pdf/manifest.json', 'public/office-pdf/office_pdf_bg.wasm'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
let server, browser, page;
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
async function frames(count = 4) {
  await page.evaluate(count => new Promise(resolve => {
    const frame = () => --count <= 0 ? resolve() : requestAnimationFrame(frame);
    requestAnimationFrame(frame);
  }), count);
}
async function wait(predicate, arg) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const result = await page.evaluate(predicate, arg); if (result) return result; await frames(2); }
  throw Error('Timed out waiting for PDF annotation state');
}
const state = () => page.evaluate(async () => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  const handle = app.rustPdfHandles.get(app.activeKey);
  return { ui: await handle.query('ui.state'), snapshot: await handle.inspect() };
});
const command = (id, params = {}) => page.evaluate(async ({ id, params }) => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  await app.rustPdfHandles.get(app.activeKey).command(id, params);
}, { id, params });
async function shot(name) { const file = `${name}.png`; await page.screenshot({ path: path.join(output, file) }); report.screenshots.push(file); persist(); }
async function check(name, action) { report.stage = name; persist(); await action(); report.checks.push(name); persist(); }
async function toolbar(id) {
  const { ui } = await state(), item = ui.toolbar.find(item => item.id === id);
  assert.ok(item?.enabled, `${id} is available`);
  const box = await page.getByTestId('pdf-canvas').boundingBox();
  const [x, y, width, height] = item.rect;
  await page.mouse.click(box.x + x + width / 2, box.y + y + height / 2); await frames();
}
async function freshPdf() {
  await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    for (const tab of [...app.tabs]) await app.removeTab(tab, true);
  });
  await page.locator('.create-card.pdf').click();
  await wait(async () => {
    const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
    return !!app?.active?.ready && (await app.rustPdfHandles.get(app.activeKey).query('ui.state')).toolbar?.length > 0;
  });
  await command('ui.set', { key: 'panel', value: 'comments' }); await frames(6);
}
async function addBox(text) {
  const { ui } = await state(), box = await page.getByTestId('pdf-canvas').boundingBox();
  assert.equal(ui.right_panel, 'Comments');
  // Inspector tab + comment header: the entry's actual observed center is 92pt
  // below the viewport top. X follows the actual viewport/panel split.
  const x = box.x + (ui.active.viewport[2] + box.width) / 2;
  const y = box.y + ui.active.viewport[1] + 92;
  await page.mouse.click(x, y); await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  if (text) await page.keyboard.insertText(text);
  await frames();
}
async function closeCommentPanel() {
  const { ui } = await state(), box = await page.getByTestId('pdf-canvas').boundingBox();
  assert.equal(ui.right_panel, 'Comments');
  await page.mouse.click(box.x + box.width - 26, box.y + ui.active.viewport[1] + 51); await frames();
  assert.equal((await state()).ui.right_panel, null);
}
async function highlight(verticalOffset = 0) {
  await toolbar('comment.highlight');
  const { ui } = await state(), box = await page.getByTestId('pdf-canvas').boundingBox();
  const [x0, y0, x1] = ui.active.pages_on_screen[0].rect;
  const x = box.x + x0 + (x1 - x0) * .18, y = box.y + y0 + 150 + verticalOffset;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 180, y + 70, { steps: 10 }); await page.mouse.up(); await frames(6);
  assert.ok((await state()).ui.active.selected_comment, 'The real highlight gesture creates and selects an annotation');
  return { xFraction: (x + 30 - box.x - x0) / (x1 - x0), yFraction: (y + 25 - box.y - y0) / (x1 - x0) };
}
async function annotationPoint(point, options = {}) {
  const { ui } = await state(), box = await page.getByTestId('pdf-canvas').boundingBox();
  const [left, top, right] = ui.active.pages_on_screen[0].rect;
  const x = box.x + left + point.xFraction * (right - left), y = box.y + top + point.yFraction * (right - left);
  if (options.double) await page.mouse.dblclick(x, y);
  else await page.mouse.click(x, y);
  await frames();
}
async function twoHighlights() {
  await freshPdf();
  const first = await highlight(); await page.keyboard.insertText('首条批注的原文'); await frames(); await page.keyboard.press('ControlOrMeta+Enter'); await frames();
  const second = await highlight(180); await page.keyboard.insertText('第二条批注的原文'); await frames(); await page.keyboard.press('ControlOrMeta+Enter'); await frames();
  await toolbar('select'); return { first, second };
}
async function editAnnotation(point, text) {
  await annotationPoint(point, { double: true }); assert.equal((await state()).ui.active.comment_composer_open, true);
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text); await frames();
  assert.equal((await state()).ui.commentDraft.text, text);
}
async function deleteAnnotation(point) {
  await annotationPoint(point); await page.keyboard.press('Delete'); await frames();
  assert.ok((await state()).ui.deletePrompt); await confirmDeletion();
}
async function confirmDeletion() {
  const box = await page.getByTestId('pdf-canvas').boundingBox(), png = PNG.sync.read(await page.screenshot());
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  let best;
  for (let y = Math.floor(center.y); y < Math.min(png.height, center.y + 180); y++) {
    let start = -1;
    for (let x = Math.floor(center.x - 250); x < Math.min(png.width, center.x + 250); x++) {
      const offset = (y * png.width + x) * 4;
      const blue = png.data[offset] < 90 && png.data[offset + 1] >= 60 && png.data[offset + 1] < 165 && png.data[offset + 2] > 180;
      if (blue && start < 0) start = x;
      if (!blue && start >= 0) {
        const width = x - start;
        if (width >= 25 && (!best || width > best.width)) best = { x: start + width / 2, y, width };
        start = -1;
      }
    }
  }
  assert.ok(best, 'The visible confirmation dialog has an enabled blue delete button');
  await page.mouse.click(best.x, best.y + 3); await frames();
}
async function exportAttempt() {
  return page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    try { const value = await app.rustPdfHandles.get(app.activeKey).exportFile({ format: 'pdf' }); return { ok: true, base64: value.base64 }; }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });
}
function readAnnotations(filename) {
  return JSON.parse(execFileSync('python3', ['-c', 'import fitz,json,sys\nwith fitz.open(sys.argv[1]) as doc:\n print(json.dumps([{"type":a.type[1],"contents":a.info.get("content", "")} for p in doc for a in (p.annots() or [])]))', filename], { encoding: 'utf8' }));
}
async function expectExport(name, count, oldFailure = false) {
  const result = await exportAttempt();
  if (baseline && oldFailure) {
    assert.equal(result.ok, false, `${name} reproduces the old save barrier`);
    assert.match(result.error, /正在编辑的批注/);
    report.knownFailures.push({ name, error: result.error, state: await state() }); await shot(name); return;
  }
  assert.equal(result.ok, true, `${name}: ${result.error || ''}`);
  const filename = path.join(output, `${name}.pdf`); fs.writeFileSync(filename, Buffer.from(result.base64, 'base64'));
  const annotations = readAnnotations(filename); assert.equal(annotations.length, count, name);
  report.exports.push({ name, annotations }); await shot(name);
  return annotations;
}

(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.productsBefore = hashes();
    if (!baseline) report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-office-pdf.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: crypto.randomInt(22000, 50000), strictPort: false, hmr: false,
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
    } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(origin); await page.getByTestId('theme-light').click();
    await check('untouched-empty-add-box-does-not-block-manual-save', async () => {
      await freshPdf(); await addBox(''); await expectExport('empty-add-box', 0);
    });
    await check('whitespace-only-add-box-does-not-block-manual-save', async () => {
      await freshPdf(); await addBox('   '); await expectExport('whitespace-add-box', 0, true);
    });
    await check('typing-then-clearing-add-box-does-not-create-a-comment-or-save-barrier', async () => {
      await freshPdf(); await addBox('暂时输入，随后清空'); await addBox(''); await expectExport('cleared-add-box', 0);
    });
    await check('undoing-highlight-with-empty-editor-restores-zero-comments-and-save', async () => {
      await freshPdf(); await highlight(); await toolbar('edit.undo');
      await expectExport('undo-highlight-zero-comments', 0, true);
    });
    await check('new-highlight-with-untouched-empty-note-saves-the-highlight', async () => {
      await freshPdf(); await highlight(); await expectExport('highlight-empty-note', 1, true);
    });
    if (!baseline) {
      await check('confirmed-annotation-deletion-reconciles-its-hidden-empty-editor', async () => {
        await freshPdf(); const point = await highlight(); await closeCommentPanel(); await toolbar('select');
        await annotationPoint(point); await page.keyboard.press('Delete'); await frames();
        assert.ok((await state()).ui.deletePrompt, 'Deleting the selected annotation first asks for confirmation');
        await shot('delete-highlight-confirmation'); await confirmDeletion();
        assert.equal((await state()).ui.deletePrompt, null); assert.equal((await state()).ui.commentDraft, null);
        await command('ui.set', { key: 'panel', value: 'comments' }); await frames();
        await expectExport('deleted-highlight-zero-comments', 0);
      });
      await check('new-highlight-note-containing-only-spaces-does-not-block-save', async () => {
        await freshPdf(); await highlight(); await page.keyboard.insertText('   '); await frames();
        assert.equal((await state()).ui.commentDraft, null); await expectExport('highlight-whitespace-note', 1);
      });
      await check('hidden-nonempty-draft-survives-tool-switch-and-save-and-can-return-and-submit', async () => {
        await freshPdf(); const text = '批注草稿必须完整保留，确认提交后才写入 PDF。'; await addBox(text);
        assert.equal((await state()).ui.commentDraft.text, text);
        await closeCommentPanel(); await toolbar('hand');
        assert.equal((await state()).ui.commentDraft.text, text, 'Tool switching keeps the hidden text');
        const blocked = await exportAttempt(); assert.equal(blocked.ok, false); assert.match(blocked.error, /未提交的批注/);
        await frames(); let ui = (await state()).ui;
        assert.equal(ui.commentDraft.text, text); assert.equal(ui.commentDraftDialog.confirmDiscard, false);
        await shot('hidden-draft-recovered');
        await toolbar('comment-draft-edit'); ui = (await state()).ui;
        assert.equal(ui.commentDraftDialog, null); assert.equal(ui.right_panel, 'Comments'); assert.equal(ui.commentDraft.text, text);
        await toolbar('comment-draft'); await toolbar('comment-draft-submit');
        assert.equal((await state()).ui.commentDraft, null);
        const annotations = await expectExport('submitted-draft', 1); assert.equal(annotations[0].contents, text);
      });
      await check('discard-requires-explicit-confirmation-and-keep-retains-the-draft', async () => {
        await freshPdf(); const text = '取消确认时保留这段文字。'; await addBox(text); await toolbar('comment-draft');
        await toolbar('comment-draft-discard'); let ui = (await state()).ui;
        assert.equal(ui.commentDraftDialog.confirmDiscard, true); assert.equal(ui.commentDraft.text, text);
        await shot('discard-confirmation'); await toolbar('comment-draft-keep'); ui = (await state()).ui;
        assert.equal(ui.commentDraftDialog.confirmDiscard, false); assert.equal(ui.commentDraft.text, text);
        await toolbar('comment-draft-discard'); await toolbar('comment-draft-confirm-discard');
        assert.equal((await state()).ui.commentDraft, null); await expectExport('discarded-draft', 0);
      });
      await check('undo-removes-highlight-but-keeps-typed-note-for-explicit-recovery', async () => {
        await freshPdf(); await highlight(); const text = '原来的高亮撤销后，这段文字仍然可恢复。';
        await page.keyboard.insertText(text); await frames();
        assert.equal((await state()).ui.commentDraft.text, text);
        await toolbar('edit.undo'); const ui = (await state()).ui;
        assert.equal(ui.commentDraft.orphaned, true); assert.equal(ui.commentDraft.text, text);
        const blocked = await exportAttempt(); assert.equal(blocked.ok, false); await frames(); await shot('orphaned-typed-note');
        await toolbar('comment-draft-submit');
        const annotations = await expectExport('recovered-orphaned-note', 1);
        assert.equal(annotations[0].type, 'Text'); assert.equal(annotations[0].contents, text);
      });
      await check('clearing-existing-comment-text-is-a-real-draft-and-commits-only-on-confirmation', async () => {
        await freshPdf(); await highlight(); await page.keyboard.insertText('原有批注正文'); await frames();
        await page.keyboard.press('ControlOrMeta+Enter'); await frames();
        assert.equal((await state()).ui.commentDraft, null);
        const original = await expectExport('existing-comment-before-clearing', 1); assert.equal(original[0].contents, '原有批注正文');
        const { ui } = await state(), box = await page.getByTestId('pdf-canvas').boundingBox();
        // Double-click the selected card's author header to reopen its inline editor.
        await page.mouse.dblclick(box.x + ui.active.viewport[2] + 140, box.y + ui.active.viewport[1] + 190); await frames();
        await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); await frames();
        const cleared = (await state()).ui.commentDraft;
        assert.equal(cleared?.kind, 'Editing'); assert.equal(cleared.text, '');
        assert.equal((await exportAttempt()).ok, false); await frames(); await toolbar('comment-draft-submit');
        const annotations = await expectExport('existing-comment-cleared', 1); assert.equal(annotations[0].contents, '');
      });
      await check('deleting-the-edited-annotation-never-writes-its-draft-into-the-next-annotation', async () => {
        const { first } = await twoHighlights(), text = '删除首条目标后恢复的草稿';
        await editAnnotation(first, text); await deleteAnnotation(first);
        assert.equal((await state()).ui.commentDraft.orphaned, true); assert.equal((await state()).ui.commentDraft.text, text);
        await toolbar('comment-draft'); await toolbar('comment-draft-submit');
        const annotations = await expectExport('deleted-target-preserves-next-annotation', 2);
        assert.deepEqual(annotations.map(item => item.contents).sort(), ['第二条批注的原文', text].sort());
      });
      await check('draft-follows-its-original-annotation-through-prior-deletion-and-undo-redo', async () => {
        const { first, second } = await twoHighlights(), text = '第二条批注的新正文';
        await editAnnotation(second, text); await deleteAnnotation(first);
        for (const action of [null, 'edit.undo', 'edit.redo']) {
          if (action) await toolbar(action);
          const draft = (await state()).ui.commentDraft;
          assert.equal(draft.orphaned, false); assert.equal(draft.text, text);
        }
        await toolbar('comment-draft'); await toolbar('comment-draft-submit');
        const annotations = await expectExport('draft-follows-original-target', 1); assert.equal(annotations[0].contents, text);
      });
      await check('unchanged-editors-never-become-drafts-after-another-editor-submits-or-the-target-is-deleted', async () => {
        await freshPdf(); const point = await highlight(), text = '浮动编辑器提交的批注正文';
        // Creating the highlight also opens its empty inline editor. Editing the
        // same target through the floating editor must not turn that empty field
        // into a spurious request to erase the newly committed contents.
        await toolbar('select'); await editAnnotation(point, text);
        await page.keyboard.press('ControlOrMeta+Enter'); await frames();
        assert.equal((await state()).ui.commentDraft, null);
        const annotations = await expectExport('composer-submit-closes-unchanged-inline-editor', 1);
        assert.equal(annotations[0].contents, text);
        await annotationPoint(point, { double: true });
        assert.equal((await state()).ui.active.comment_composer_open, true);
        assert.equal((await state()).ui.commentDraft, null);
        await deleteAnnotation(point);
        assert.equal((await state()).ui.commentDraft, null, 'Deleting an unchanged editor target does not invent an orphaned draft');
        await expectExport('deleted-unchanged-editor-does-not-create-draft', 0);
      });
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
    report.productsAfter = hashes();
    if (baseline) {
      // Source fixes may be prepared concurrently with the old-binary reproduction.
      // The baseline still requires that the exact packaged binary never changes.
      for (const file of files.filter(file => file.startsWith('public/'))) assert.equal(report.productsAfter[file], report.productsBefore[file]);
    } else assert.deepEqual(report.productsAfter, report.productsBefore);
    report.ok = !baseline; report.baselineReproduced = baseline && report.knownFailures.length === 3;
  } catch (error) {
    report.error = error.stack || String(error); process.exitCode = 1;
    if (page) { report.lastState = await state().catch(() => null); await shot('failure').catch(() => {}); }
  } finally {
    report.finishedAt = new Date().toISOString(); persist(); await browser?.close(); await server?.close();
  }
  console.log(JSON.stringify({ ok: report.ok, baselineReproduced: report.baselineReproduced, checks: report.checks.length, error: report.error, report: path.join(output, 'report.json') }));
})();
