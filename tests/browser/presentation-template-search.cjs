/* Real template sidebar and bundled catalogue; no native/PPT engine claim.
 * Run: node tests/browser/presentation-template-search.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/presentation-template-search');
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], errors: [], screenshots: [], limitations: ['Sidebar interactions and real packaged catalogue only; no native WebView or presentation engine validation.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const cards = () => page.locator('.presentation-template-card');
const search = () => page.getByRole('searchbox', { name: '搜索模板名称' });
const filter = name => page.getByRole('group', { name: '筛选演示模板' }).getByRole('button', { name, exact: true });
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function check(name, action) { await action(); report.checks.push(name); persist(); }
async function screenshot(name) { await page.screenshot({ path: path.join(output, `${name}.png`) }); report.screenshots.push(`${name}.png`); persist(); }
(async () => {
  try {
    const { createServer } = await import('vite');
    const harness = `import { createApp, h, ref } from 'vue';
      import Templates from '/src/components/PresentationTemplates.vue';
      import { locale } from '/src/shared/i18n.ts';
      window.__locale = locale;
      import { listPresentationTemplates, loadPresentationTemplate, savePresentationTemplate } from '/src/presentation/templates.ts';
      import '/src/style.css';
      const templates = await listPresentationTemplates();
      const data = await loadPresentationTemplate(templates[0]);
      templates.push(await savePresentationTemplate({ name: '自定义 Quarterly Ｐｌａｎ', slideCount: 3, base64: data.base64 }));
      window.__templates = templates; window.__actions = []; window.__disabled = ref(false);
      createApp({ setup: () => () => h(Templates, { templates, loading: false, error: '', disabled: window.__disabled.value,
        onSelect: value => window.__actions.push(['select', value.id]), onSave: () => window.__actions.push(['save']),
        onDelete: value => window.__actions.push(['delete', value.id]) }) }).mount('#template-app');`;
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'),
      plugins: [{ name: 'template-search-test', resolveId(id) { if (id === '/__templates_test__.js') return '\0templates-test'; }, load(id) { if (id === '\0templates-test') return harness; }, configureServer(instance) {
        instance.middlewares.use((request, response, next) => {
          if (request.url !== '/__templates_test__') return next();
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end('<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body{margin:0;height:100%;overflow:hidden}#template-app{height:100%;display:flex;justify-content:flex-end}</style></head><body><div id="template-app"></div><script type="module" src="/__templates_test__.js"></script></body></html>');
        });
      } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] } } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 600, height: 760 }, locale: 'zh-CN' });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__templates_test__`);
    await search().waitFor();
    const catalogue = await page.evaluate(() => window.__templates);
    await check('one-hundred-builtins-and-custom-template-are-browsable', async () => {
      assert.equal(catalogue.filter(value => value.source === 'builtin').length, 100);
      assert.equal(await cards().count(), 101); await screenshot('catalogue');
    });
    await check('chinese-name-search-keeps-only-matching-template-cards', async () => {
      await search().fill('医疗'); await frame();
      const names = await cards().locator('.presentation-template-details strong').allTextContents();
      assert.ok(names.length > 0); assert.ok(names.every(name => name.includes('医疗')));
      assert.equal(await page.locator('.presentation-templates-results').textContent(), `找到 ${names.length} 个模板`);
      await cards().first().getByRole('button').click();
      const action = await page.evaluate(() => window.__actions.at(-1));
      assert.equal(action[0], 'select'); assert.ok(catalogue.find(value => value.id === action[1]).name.includes('医疗'));
      await screenshot('medical-name-search');
    });
    await check('multiple-name-keywords-narrow-industry-and-purpose', async () => {
      await search().fill('医疗  质量'); await frame();
      assert.deepEqual(await cards().locator('.presentation-template-details strong').allTextContents(), ['医疗健康·质量汇报']);
    });
    await check('search-composes-with-source-filter-and-shows-empty-result', async () => {
      await filter('我的模板').click(); await frame(); assert.equal(await cards().count(), 0);
      assert.equal(await page.getByText('没有匹配的模板', { exact: true }).isVisible(), true);
      await page.getByRole('button', { name: '清空模板搜索' }).click(); await frame();
      assert.equal(await cards().count(), 1); assert.equal(await search().inputValue(), '');
      await filter('全部').click(); await frame(); assert.equal(await cards().count(), 101);
    });
    await check('custom-name-search-ignores-case-width-and-outer-spaces', async () => {
      await search().fill('  quarterly plan  '); await frame(); assert.equal(await cards().count(), 1);
      assert.equal(await cards().locator('strong').textContent(), '自定义 Quarterly Ｐｌａｎ');
      await cards().getByRole('button', { name: /^删除模板/ }).click();
      assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), ['delete', catalogue.find(value => value.source === 'custom').id]);
      await search().press('Escape'); await frame(); assert.equal(await cards().count(), 101);
      assert.equal(await search().evaluate(node => node === document.activeElement), true);
    });
    await check('unmatched-search-does-not-change-documents-and-can-be-cleared', async () => {
      const actions = await page.evaluate(() => window.__actions);
      await search().fill('不存在的模板名称 xyz'); await frame(); assert.equal(await cards().count(), 0);
      assert.equal(await page.getByText('没有匹配的模板', { exact: true }).isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.__actions), actions);
      await page.getByRole('button', { name: '清空模板搜索' }).click(); await frame(); assert.equal(await cards().count(), 101);
    });
    await check('only-template-list-scrolls-and-new-search-starts-at-top', async () => {
      const list = page.getByLabel('模板列表', { exact: true });
      await list.evaluate(node => node.scrollTop = 3000); await frame(); assert.ok(await list.evaluate(node => node.scrollTop) > 0);
      assert.equal(await search().isVisible(), true); assert.equal(await page.evaluate(() => scrollY), 0);
      await search().fill('医疗'); await frame(); assert.equal(await list.evaluate(node => node.scrollTop), 0);
      await page.evaluate(() => { window.__disabled.value = true; document.documentElement.dataset.theme = 'dark'; }); await frame();
      assert.equal(await cards().first().getByRole('button').isDisabled(), true);
      await screenshot('dark-search');
    });
    await check('localized-builtins-search-without-translating-custom-names-or-changing-template-data', async () => {
      await page.evaluate(() => {
        window.__disabled.value = false;
        window.__templates.find(value => value.source === 'custom').name = '蓝图商务';
      });
      await search().fill('');
      const before = await page.evaluate(() => JSON.stringify(window.__templates));
      await page.evaluate(() => { window.__locale.value = 'en'; }); await frame();
      assert.equal(await page.getByRole('group', { name: 'Filter presentation templates' }).getByRole('button', { name: 'Built-in templates', exact: true }).isVisible(), true);
      assert.equal(await page.locator('[data-testid="presentation-template-blueprint"] strong').textContent(), 'Blueprint Business');
      const custom = page.locator('.presentation-template-details.has-delete');
      assert.equal(await custom.locator('strong').textContent(), '蓝图商务');
      assert.equal(await custom.locator('.presentation-template-description').textContent(), 'Saved from the current presentation');
      const englishSearch = page.getByRole('searchbox', { name: 'Search template names' });
      await englishSearch.fill('healthcare quality'); await frame();
      assert.deepEqual(await cards().locator('strong').allTextContents(), ['Healthcare · Quality report']);
      await cards().first().getByRole('button').click();
      assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), ['select', 'health-report']);
      await englishSearch.fill('医疗'); await frame(); assert.equal(await cards().count(), 5);
      assert.equal(await page.evaluate(() => JSON.stringify(window.__templates)), before);
      await page.evaluate(() => { window.__locale.value = 'zh-CN'; }); await frame();
      assert.equal(await search().inputValue(), '医疗'); assert.equal(await cards().count(), 5);
      assert.equal(await page.evaluate(() => JSON.stringify(window.__templates)), before);
    });
    assert.deepEqual(report.errors, []); report.ok = true; persist();
    console.log(`Presentation template search: ${report.checks.length} checks passed`);
  } catch (error) { report.error = error.stack; persist(); console.error(error); process.exitCode = 1; }
  finally { await browser?.close(); await server?.close(); }
})();
