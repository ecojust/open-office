/* Chromium counterpart of the installed-app pdf helper. This must
 * report browser transport and reject the native entry point; it cannot stand
 * in for an installed WebKit/WebView2 run. Uses the real Vue shell lifecycle. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_PDF_SMOKE_OUTPUT || path.join(root, 'test-results/office-pdf-native-helper'));
const sourceFiles = ['src/App.vue', 'src/components/RustPdfEditor.vue', 'src/pdf/rust/client.ts', 'src/pdf/rust/native-smoke.ts', 'public/office-pdf/manifest.json', 'public/office-pdf/office_pdf.js', 'public/office-pdf/office_pdf_bg.wasm'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, startedAt: new Date().toISOString(), errors: [], consoleErrors: [], externalRequests: [], forbiddenRequests: [],
  runtime: 'Real default pdf shell in Chromium; native helper browser counterpart only',
  limitations: ['Native WebView, operating-system IME, file dialogs and filesystem persistence are not covered.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
// Async editor predicates must be awaited explicitly: this Playwright build's
// waitForFunction treats the predicate's Promise itself as truthy.
const waitForAsync = async (predicate, arg) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(predicate, arg);
    if (result) return result;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  throw Error('Timed out waiting for the PDF editor state');
};
(async () => {
  try {
    report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-office-pdf.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.productsBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: Number(process.env.OFFICE_PDF_SMOKE_PORT || 5305), strictPort: true, hmr: false,
      // Worktrees may share dependencies through a symlink; Vite must transform the worker's ?url import.
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
    } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
    context.on('request', request => {
      const url = request.url();
      if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
      if (/\/office\/host\.html|\/office-runtime\/|soffice\.(?:js|wasm)/.test(url)) report.forbiddenRequests.push(url);
    });
    page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.exposeFunction('capturePdfSmoke', async () => {
      const inspect = () => page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return app.rustPdfHandles.get(app.activeKey).inspect();
      });
      const before = await inspect();
      report.fileWorkflowAvailability = await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const editor = app.rustPdfHandles.get(app.activeKey);
        const before = await editor.inspect();
        const commands = (await editor.query('ui.commands')).commands;
        const blocked = [
          'sign.digital', 'sign.certify', 'sign.certify_invisible',
          'edit.image', 'comment.attach', 'comment.import', 'comment.export',
          'form.import_data', 'form.export_data', 'measure.export',
          'page.extract', 'page.split', 'doc.compare',
          'actions.wizard', 'actions.distribution', 'actions.optimize_scans',
          'export.image', 'export.all_images', 'export.text', 'export.docx', 'export.pptx', 'export.html', 'export.rtf',
        ];
        for (const command of blocked) {
          if (commands.find(item => item.id === command)?.enabled !== false) throw Error(`${command} remains enabled`);
          let refused = false;
          try { await editor.command(command); } catch { refused = true; }
          if (!refused) throw Error(`${command} reached an unavailable file workflow`);
        }
        for (const command of ['sign.validate', 'sign.fill.signature', 'comment.stamp']) {
          if (commands.find(item => item.id === command)?.enabled !== true) throw Error(`${command} was disabled with certificate signing`);
        }
        await editor.command('sign.validate');
        const after = await editor.inspect();
        const ui = await editor.query('ui.state');
        if (ui.dialog !== null || before.documentId !== after.documentId || before.revision !== after.revision || before.dirty !== after.dirty) throw Error('Checking unavailable file workflows changed the document or opened a dialog');
        await editor.command('ui.set', { key: 'panel', value: 'none' });
        return { blocked, signatureVerificationAvailable: true, drawnSignatureAvailable: true, standardStampsAvailable: true, documentUnchanged: true };
      });
      assert.equal(await page.locator('iframe').count(), 0);
      for (const id of ['shell-open', 'shell-save', 'shell-save-as', 'shell-print']) {
        assert.equal(await page.getByTestId(id).isVisible(), true, `${id} is in the global toolbar`);
      }
      for (const theme of ['dark', 'light']) {
        await page.getByTestId('theme-' + theme).click();
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
        await waitForAsync(async theme => {
          const app = document.querySelector('#app').__vue_app__._instance.setupState;
          const ui = await app.rustPdfHandles.get(app.activeKey).query('ui.state');
          return ui.theme.toLowerCase() === theme && ui.language === 'zh-hans';
        }, theme);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const state = await inspect();
        assert.equal(state.documentId, before.documentId); assert.equal(state.revision, before.revision); assert.equal(state.dirty, before.dirty);
        await page.screenshot({ path: path.join(output, `pdf-${theme}.png`), fullPage: true });
      }
      // Use the real canvas and its browser input listener for an editable text box.
      // Commands select the tool; the new text itself is typed through DOM input.
      const target = await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const editor = app.rustPdfHandles.get(app.activeKey);
        await editor.command('edit.text');
        const beforeFrame = await editor.query('ui.state');
        // Tool commands may open their settings sidebar. Page rectangles describe the
        // last rendered frame, so wait for the actual layout before clicking the page.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const ui = await editor.query('ui.state');
        const rect = ui.active.pages_on_screen.find(page => page.page === 1)?.rect;
        const canvas = document.querySelector('[data-testid="pdf-canvas"]');
        if (!rect || !canvas) throw Error('Visible PDF page geometry unavailable');
        const box = canvas.getBoundingClientRect();
        return { x: box.x + rect[0] + (rect[2] - rect[0]) * 0.2, y: box.y + rect[1] + (rect[3] - rect[1]) * 0.35,
          layoutBeforeFrame: beforeFrame.active.pages_on_screen, layoutAfterFrame: ui.active.pages_on_screen };
      });
      report.inputTarget = target;
      persist();
      await page.mouse.click(target.x, target.y);
      try {
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pdf-input');
      } catch (error) {
        report.inputFocusFailure = await page.evaluate(async () => {
          const app = document.querySelector('#app').__vue_app__._instance.setupState;
          return { state: await app.rustPdfHandles.get(app.activeKey).query('ui.state'), focused: document.activeElement?.outerHTML?.slice(0, 800) };
        });
        persist();
        throw error;
      }
      await page.keyboard.type('CANVAS_INPUT_PROOF');
      await page.keyboard.insertText(' 中文输入');
      const typed = await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const editor = app.rustPdfHandles.get(app.activeKey);
        await app.nativeTransactionalEditor(editor).exportFile({ format: 'pdf' });
        return { model: await editor.query('document.inspect'), tabs: app.tabs.length, key: app.activeKey };
      });
      assert.ok(typed.model.texts.join('').includes('CANVAS_INPUT_PROOF'), 'Canvas typing reaches the Rust PDF model');
      assert.ok(typed.model.texts.join('').includes('中文输入'), 'Canvas accepts committed Chinese input');
      assert.equal(typed.tabs, 2, 'Canvas editing preserves both global document tabs');
      await page.screenshot({ path: path.join(output, 'pdf-canvas-edit.png'), fullPage: true });
      const savedText = await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const editor = app.nativeTransactionalEditor(app.rustPdfHandles.get(app.activeKey));
        const exported = await editor.exportFile({ format: 'pdf' });
        await editor.markSaved(exported.base64);
        await editor.command('edit.edit_text');
        return exported.base64;
      });
      await page.mouse.dblclick(target.x + 14, target.y + 8);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal((await inspect()).dirty, false, 'Opening unchanged existing text is not an unsaved edit');
      const backgroundOpenEditor = await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const editor = app.rustPdfHandles.get(app.activeKey), focus = document.activeElement;
        const before = await editor.inspect(), ready = await editor.canBackgroundExport();
        let blocked = false;
        try { await editor.exportFile({ format: 'pdf', background: true }); } catch { blocked = true; }
        const after = await editor.syncRevision();
        return { ready, blocked, sameRevision: after.revision === before.revision, sameFocus: document.activeElement === focus };
      });
      assert.deepEqual(backgroundOpenEditor, { ready: false, blocked: true, sameRevision: true, sameFocus: true }, 'Background polling/export leaves unchanged text editing open');
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      const observedDirty = await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const snapshot = await app.rustPdfHandles.get(app.activeKey).inspect();
        return snapshot.dirty ? snapshot : null;
      });
      report.deletionObservedDirty = { revision: observedDirty.revision, dirty: observedDirty.dirty };
      const pendingDeletion = await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return (await app.rustPdfHandles.get(app.activeKey).query('document.inspect')).texts.join('');
      });
      assert.ok(pendingDeletion.includes('CANVAS_INPUT_PROOF'), 'Empty text draft marks dirty before changing the saved PDF model');
      const backgroundDeletion = await page.evaluate(async base64 => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const editor = app.rustPdfHandles.get(app.activeKey), focus = document.activeElement;
        const stages = [];
        const capture = async label => {
          const { revision, dirty, backgroundExportReady } = await editor.inspect();
          stages.push({ label, revision, dirty, backgroundExportReady, focus: document.activeElement?.getAttribute('data-testid') });
        };
        await capture('before-query');
        const before = await editor.query('document.inspect');
        await capture('before-export');
        let exportBlocked = false, receiptBlocked = false;
        try { await editor.exportFile({ format: 'pdf', background: true }); } catch { exportBlocked = true; }
        await capture('after-export');
        try { await editor.markSaved(base64, { background: true }); } catch { receiptBlocked = true; }
        await capture('after-receipt');
        return { result: { exportBlocked, receiptBlocked, sameModel: JSON.stringify(await editor.query('document.inspect')) === JSON.stringify(before), sameFocus: document.activeElement === focus, dirty: (await editor.syncRevision()).dirty }, stages };
      }, savedText);
      report.backgroundDraftStages = backgroundDeletion.stages;
      persist();
      if (!backgroundDeletion.result.dirty) await page.screenshot({ path: path.join(output, 'pdf-pending-deletion.png'), fullPage: true });
      assert.deepEqual(backgroundDeletion.result, { exportBlocked: true, receiptBlocked: true, sameModel: true, sameFocus: true, dirty: true }, 'Background save and acknowledgement retain the unfinished deletion');
      await page.mouse.click(target.x + 320, target.y + 110);
      await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return !(await app.rustPdfHandles.get(app.activeKey).query('document.inspect')).texts.join('').includes('CANVAS_INPUT_PROOF');
      });
      assert.equal(await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return app.rustPdfHandles.get(app.activeKey).canBackgroundExport();
      }), true, 'Background export becomes available after the user commits');
      report.backgroundDrafts = { unchangedEditorPreserved: backgroundOpenEditor, pendingDeletionPreserved: backgroundDeletion.result, userCommitResumesBackgroundExport: true };
      assert.equal(await page.evaluate(async base64 => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        try { await app.nativeTransactionalEditor(app.rustPdfHandles.get(app.activeKey)).markSaved(base64); return false; }
        catch { return (await app.rustPdfHandles.get(app.activeKey).inspect()).dirty; }
      }, savedText), true, 'An old save receipt cannot clear an existing-text deletion');
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return (await app.rustPdfHandles.get(app.activeKey).query('document.inspect')).texts.join('').includes('CANVAS_INPUT_PROOF');
      });
      report.savedTextDeletion = { unchangedEditorStaysClean: true, emptyDraftIsDirty: true, blurCommitsDeletion: true, staleReceiptRejected: true, undoRestores: true };
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return !(await app.rustPdfHandles.get(app.activeKey).query('document.inspect')).texts.join('').includes('CANVAS_INPUT_PROOF');
      });
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return (await app.rustPdfHandles.get(app.activeKey).query('document.inspect')).texts.join('').includes('CANVAS_INPUT_PROOF');
      });
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return !(await app.rustPdfHandles.get(app.activeKey).query('document.inspect')).texts.join('').includes('CANVAS_INPUT_PROOF');
      });
      await page.getByTestId('shell-save-as').click();
      await page.getByTestId('save-format-pdf').check();
      await page.getByTestId('save-format-name').fill('Global PDF 保存');
      const download = page.waitForEvent('download');
      await page.getByTestId('save-format-confirm').click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(), 'Global PDF 保存.pdf');
      await saved.saveAs(path.join(output, 'global-toolbar.pdf'));
      await page.waitForFunction(() => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return !app.busy && !app.saveAsDraft && !app.active.dirty;
      });
      assert.equal((await inspect()).dirty, false, 'Global Save As acknowledges the exact PDF receipt');
      report.globalDownload = path.join(output, 'global-toolbar.pdf');
      report.globalControls = { toolbarVisible: true, themePreservesRevision: true, lightAndDark: true, chineseEditorLanguage: true, canvasTyping: true, chineseCommittedInput: true, tabsPreservedDuringEditing: true, globalUndoRedo: true, saveAsDownloadAcknowledgesReceipt: true };
      // A confirmed discard must release unfinished IME input before selecting
      // the surviving PDF. Otherwise its attach tries to flush the closed tab.
      await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        await app.rustPdfHandles.get(app.activeKey).command('edit.text');
      });
      await page.mouse.click(target.x, target.y);
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pdf-input');
      await page.evaluate(() => {
        const input = document.querySelector('[data-testid="pdf-input"]');
        if (!input) throw Error('PDF input agent missing before discard regression');
        input.focus(); input.value = '未确认输入';
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '未确认输入' }));
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: input.value, isComposing: true }));
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => {
        const input = document.querySelector('[data-testid="pdf-input"]');
        input.addEventListener('blur', () => {
          // Queue a nonempty final composition after the shell cleared the
          // DOM value. Close must drain it before the survivor gets a frame.
          input.value = '不应进入其他文档';
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: input.value }));
        }, { once: true });
      });
    });
    await page.goto(origin); await page.locator('.create-card.pdf').waitFor();
    report.helper = await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      const vueUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/deps\/vue\.js(?:\?|$)/.test(name));
      if (!vueUrl) throw Error('Actual Vue module URL was not observed');
      const { nextTick } = await import(vueUrl);
      const { inspectOfficePdfSession } = await import('/src/pdf/rust/client.ts');
      const { runOfficePdfNativeSmoke, verifyMountedOfficePdfEditor } = await import('/src/pdf/rust/native-smoke.ts');
      let captured = false, discardedCompositionPreservesSurvivor = false, survivorBefore;
      const operationTrace = [];
      const adapter = {
        async open(base64, name) {
          await app.editorTransaction('Browser pdf smoke', () => app.addDocument({ id: '', kind: 'pdf', extension: 'pdf', name, base64, sha256: '', sizeBytes: Math.floor(base64.length * .75) }));
          await nextTick(); const tab = app.active;
          if (!tab || tab.document.kind !== 'pdf') throw Error('Default Rust pdf tab missing');
          await app.awaitReady(tab);
          const handle = app.rustPdfHandles.get(tab.key), snapshot = await handle.inspect();
          const element = [...document.querySelectorAll('[data-testid="rust-pdf-editor"]')].find(node => node.dataset.sessionId === snapshot.sessionId);
          if (!element) throw Error('Actual pdf component missing');
          const editor = app.nativeTransactionalEditor(handle);
          const tracedEditor = new Proxy(editor, { get(target, key) {
            const value = target[key];
            if (!['command', 'exportFile', 'markSaved'].includes(key) || typeof value !== 'function') return value;
            return async (...args) => {
              const trace = { operation: key, command: key === 'command' ? args[0] : undefined, startedAt: performance.now() };
              operationTrace.push(trace);
              try { const result = await value.apply(target, args); trace.ok = true; return result; }
              catch (error) { trace.error = String(error); trace.state = await handle.query('ui.state').catch(() => null); throw error; }
              finally { trace.elapsedMs = performance.now() - trace.startedAt; }
            };
          } });
          return { key: tab.key, element, editor: tracedEditor };
        },
        activeKey: () => app.activeKey,
        async verifyMounted() {
          const survivor = app.tabs.find(tab => tab.key !== app.activeKey);
          const editor = survivor && app.rustPdfHandles.get(survivor.key);
          if (!editor) throw Error('Surviving PDF missing before the interaction proof');
          survivorBefore = { key: survivor.key, snapshot: await editor.inspect(), model: await editor.query('document.inspect') };
          await window.capturePdfSmoke();
          captured = true;
        },
        async close(key) {
          const tab = app.tabs.find(tab => tab.key === key);
          if (!tab) throw Error('Smoke cleanup tab missing');
          const id = (await app.rustPdfHandles.get(key).inspect()).sessionId;
          await app.removeTab(tab, true); await nextTick();
          let closed = false;
          try { await inspectOfficePdfSession(id); } catch { closed = true; }
          if (!closed) throw Error('Rust session survived actual Vue unmount');
          if (captured && app.tabs.length === 1) {
            const survivor = app.active, handle = app.rustPdfHandles.get(survivor.key);
            await app.awaitReady(survivor);
            let attached = false;
            for (let frame = 0; frame < 120; frame++) {
              const snapshot = await handle.inspect();
              const element = [...document.querySelectorAll('[data-testid="rust-pdf-editor"]')].find(node => node.dataset.sessionId === snapshot.sessionId);
              const input = element?.querySelector('[data-testid="pdf-input"]');
              if (element?.querySelector('[data-testid="pdf-canvas"]') && input && input.value === '') { attached = true; break; }
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
            if (!attached) throw Error('Confirmed PDF discard blocked the surviving canvas');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const unchanged = await handle.inspect();
            if (survivor.key !== survivorBefore.key || unchanged.documentId !== survivorBefore.snapshot.documentId || unchanged.revision !== survivorBefore.snapshot.revision || JSON.stringify(await handle.query('document.inspect')) !== JSON.stringify(survivorBefore.model)) throw Error('Discarded PDF input changed the surviving document');
            await app.nativeTransactionalEditor(handle).undo();
            await app.nativeTransactionalEditor(handle).redo();
            if (!(await handle.query('document.inspect')).texts.join('').includes('NEW_NATIVE_TEXT')) throw Error('Surviving PDF lost its text or undo history');
            discardedCompositionPreservesSurvivor = true;
          }
        },
      };
      let nativeGuardRejected = false;
      try { await runOfficePdfNativeSmoke(adapter); }
      catch (error) { nativeGuardRejected = String(error).includes('real native WebView is required'); }
      if (!nativeGuardRejected) throw Error('Native entry point accepted browser evidence');
      const result = await verifyMountedOfficePdfEditor(adapter);
      return { ...result, nativeGuardRejected, discardedCompositionPreservesSurvivor, operationTrace };
    });
    persist();
    assert.equal(report.helper.ok, true, report.helper.error || report.helper.closeError);
    assert.equal(report.helper.transport, 'local-wasm-in-browser');
    assert.equal(report.helper.nativeGuardRejected, true);
    assert.equal(report.helper.discardedCompositionPreservesSurvivor, true);
    assert.equal(report.helper.cleanup.closed, 2);
    assert.equal(report.helper.cleanup.remainingCanvas, 0); assert.equal(report.helper.cleanup.remainingInput, 0);
    const { inspectOfficePdfExports, REQUIRED_OFFICE_PDF_CHECKS } = await import('../../scripts/office-pdf-native-smoke.mjs');
    assert.deepEqual(report.helper.checks, [...REQUIRED_OFFICE_PDF_CHECKS]);
    report.independentExports = inspectOfficePdfExports(report.helper);
    assert.ok(report.globalDownload, 'Global toolbar PDF download was not exercised');
    report.independentGlobalDownload = inspectOfficePdfExports({
      ...report.helper,
      reopenedPdfBase64: fs.readFileSync(report.globalDownload).toString('base64'),
    });
    for (const key of ['pdfBase64', 'reopenedPdfBase64']) {
      fs.writeFileSync(path.join(output, key + '.pdf'), Buffer.from(report.helper[key], 'base64'));
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
    report.productsAfter = hashes(); assert.deepEqual(report.productsAfter, report.productsBefore);
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); persist(); await browser?.close(); await server?.close();
  }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
