/* Linux physical-memory benchmark of the actual App, Office WASM and PDF editor.
 * MEMORY_TARGET_ROOT can point at an immutable git archive for before/after runs.
 * Run only one instance at a time; source assets and documents stay local.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const projectRoot = path.resolve(__dirname, '../..');
const targetRoot = path.resolve(process.env.MEMORY_TARGET_ROOT || projectRoot);
const label = process.env.MEMORY_RUN || new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(process.env.MEMORY_OUTPUT || path.join(projectRoot, 'test-results/memory', label));
const settleMs = Number(process.env.MEMORY_SETTLE_MS || 5000);
const gcSettleMs = Number(process.env.MEMORY_GC_SETTLE_MS || 2000);
// Natural samples are the default: forced collection can disturb the threaded
// runtime. Set MEMORY_GC=1 only for a separate, explicitly labelled experiment.
const collectGc = process.env.MEMORY_GC === '1';
const port = Number(process.env.MEMORY_PORT || 5296);
if (process.platform !== 'linux') throw Error('This benchmark needs Linux /proc/*/smaps_rollup.');
if (fs.existsSync(path.join(out, 'report.json'))) throw Error('Choose a fresh MEMORY_RUN/output directory.');
fs.mkdirSync(out, { recursive: true });
const report = {
  schemaVersion: 1, label, targetRoot, startedAt: new Date().toISOString(),
  scope: 'Actual Vue App with independent Office fixtures; Chromium process physical memory, not WASM reserved capacity',
  methodology: { settleMs, gcSettleMs, collectGc, viewport: { width: 1440, height: 1000 },
    finalIdleExtraMs: process.env.MEMORY_FINAL_IDLE === '1' ? 15000 + settleMs : 0,
    finalIdleMinimumSinceCloseMs: process.env.MEMORY_FINAL_IDLE === '1' ? 15000 + 2 * settleMs : null,
    graphics: 'headless Chromium, SwiftShader software WebGL; not a hardware GPU comparison',
    processes: 'SystemInfo.getProcessInfo plus descendants of its browser PID; browser renderer GPU utility and zygote included',
    physicalMetric: 'Sum of /proc/PID/smaps_rollup Pss; USS=Private_Clean+Private_Dirty+Private_Hugetlb. RSS may double-count shared pages.',
    gc: 'Natural sample after fixed settle, then optional CDP page collection plus exposed gc in frames. Pthread workers may block JS execution and are not explicitly collected. Later stages follow earlier page GC.',
    jsMetric: 'Performance/CDP JS heap counters describe the page isolate, not all pthread isolates, native WASM memory, or compiled code.',
    excludes: 'Vite/Node harness/Python PDF backend process memory; WASM byteLength is recorded separately and never added to physical totals.' },
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  stages: [], exports: [], operations: [], errors: [], processSamples: [],
};
let server, browser, page, browserCdp, pageCdp, sampler, sampling = false, phase = 'startup';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const persist = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function sourceSnapshot() {
  const files = {};
  const walk = relative => {
    const full = path.join(targetRoot, relative);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) for (const item of fs.readdirSync(full).sort()) walk(path.join(relative, item));
    else files[relative] = sha256(fs.readFileSync(full));
  };
  for (const relative of ['src', 'public/office', 'vendor/office-runtime-manifest.json', 'package.json', 'vite.config.ts']) walk(relative);
  return { sha256: sha256(JSON.stringify(files)), files };
}
function smaps(pid) {
  try {
    const values = {};
    for (const line of fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+) kB$/);
      if (match) values[match[1]] = Number(match[2]) * 1024;
    }
    return { rss: values.Rss || 0, pss: values.Pss || 0,
      uss: (values.Private_Clean || 0) + (values.Private_Dirty || 0) + (values.Private_Hugetlb || 0),
      pssAnon: values.Pss_Anon || 0, pssFile: values.Pss_File || 0, pssShmem: values.Pss_Shmem || 0,
      swap: values.Swap || 0 };
  } catch { return null; }
}
async function processMemory() {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  const rootPid = processInfo.find(item => item.type === 'browser')?.id;
  assert.ok(rootPid, 'CDP did not identify the browser process');
  const proc = new Map();
  for (const directory of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(directory)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${directory}/stat`, 'utf8').replace(/^.*\) /, '').split(' ');
      const cmd = fs.readFileSync(`/proc/${directory}/cmdline`, 'utf8').split('\0');
      proc.set(Number(directory), { parent: Number(stat[1]), type: cmd.find(arg => arg.startsWith('--type='))?.slice(7) || 'browser' });
    } catch {}
  }
  const ids = new Set(processInfo.map(item => item.id));
  let changed = true;
  while (changed) { changed = false; for (const [id, value] of proc) if (ids.has(value.parent) && !ids.has(id)) { ids.add(id); changed = true; } }
  const processes = [...ids].map(id => ({ pid: id,
    type: processInfo.find(item => item.id === id)?.type || proc.get(id)?.type || 'unknown',
    ...smaps(id) })).filter(item => item.rss !== undefined);
  const sum = items => items.reduce((total, item) => {
    for (const key of ['rss', 'pss', 'uss', 'pssAnon', 'pssFile', 'pssShmem', 'swap']) total[key] = (total[key] || 0) + item[key];
    return total;
  }, {});
  return { at: new Date().toISOString(), total: sum(processes), renderer: sum(processes.filter(item => item.type === 'renderer')), processes };
}
function memoryMappings(processes) {
  return processes.filter(process => process.type === 'renderer').map(process => {
    let text;
    try { text = fs.readFileSync(`/proc/${process.pid}/smaps`, 'utf8'); } catch { return { pid: process.pid, unavailable: true }; }
    const regions = []; let current;
    for (const line of text.split('\n')) {
      const mapping = line.match(/^([a-f\d]+-[a-f\d]+) (\S+) (\S+) (\S+) (\d+)\s*(.*)$/);
      if (mapping) { current = { address: mapping[1], permissions: mapping[2], path: mapping[6] }; regions.push(current); }
      else {
        const metric = line.match(/^(Size|Rss|Pss|Shared_Clean|Shared_Dirty|Private_Clean|Private_Dirty|Anonymous|Swap):\s+(\d+) kB$/);
        if (metric && current) current[metric[1]] = Number(metric[2]) * 1024;
      }
    }
    const groups = {};
    for (const region of regions) {
      const name = /wasm/i.test(region.path) ? region.path : region.permissions.includes('x') && !region.path.startsWith('/') ? 'anonymous-executable' : region.path || 'anonymous';
      const group = groups[name] ||= { mappings: 0, size: 0, rss: 0, pss: 0 }; group.mappings++;
      group.size += region.Size || 0; group.rss += region.Rss || 0; group.pss += region.Pss || 0;
    }
    return { pid: process.pid, topByPss: [...regions].sort((a, b) => (b.Pss || 0) - (a.Pss || 0)).slice(0, 10),
      topBySize: [...regions].sort((a, b) => (b.Size || 0) - (a.Size || 0)).slice(0, 10),
      groupedByPath: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].pss - a[1].pss)) };
  });
}
async function runtimeMemory() {
  return page.evaluate(() => {
    const state = document.querySelector('#app').__vue_app__._instance.setupState;
    const frames = [...document.querySelectorAll('.office-frame')];
    const office = frames.map(frame => {
      const w = frame.contentWindow, buffers = new Set(), directories = new Map();
      let files = 0, logicalBytes = 0, backingBytes = 0;
      const visit = (node, name) => {
        if (!node || files > 30000) return;
        if ((node.mode & 61440) === 16384) {
          for (const [key, child] of Object.entries(node.contents || {})) visit(child, `${name}/${key}`);
        } else if (node.contents && ArrayBuffer.isView(node.contents)) {
          files++; const size = node.usedBytes ?? node.contents.byteLength; logicalBytes += size;
          const category = name.startsWith('/tmp/') ? '/tmp' : name.startsWith('/usr/share/fonts/') ? '/usr/share/fonts' : name.split('/').slice(0, 2).join('/');
          directories.set(category, (directories.get(category) || 0) + size);
          if (!buffers.has(node.contents.buffer)) { buffers.add(node.contents.buffer); backingBytes += node.contents.buffer.byteLength; }
        }
      };
      visit(w.FS?.root, '');
      return { src: new URL(frame.src).pathname, wasmLinearBytes: w.Module?.HEAPU8?.byteLength || 0,
        sharedWasm: !!w.Module?.HEAPU8 && Object.prototype.toString.call(w.Module.HEAPU8.buffer) === '[object SharedArrayBuffer]',
        threads: { running: w.PThread?.runningWorkers?.length || 0, unused: w.PThread?.unusedWorkers?.length || 0,
          maximumConcurrency: w.ENV?.MAX_CONCURRENCY || null },
        fs: { files, logicalBytes, uniqueBackingBuffers: buffers.size, backingBytes, directories: Object.fromEntries(directories) },
        glContexts: Object.values(w.GL?.contexts || {}).filter(Boolean).length };
    });
    const js = performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize,
      limit: performance.memory.jsHeapSizeLimit } : null;
    return { tabs: state.tabs.map(tab => ({ name: tab.document.name, kind: tab.document.kind, ready: tab.ready,
      dirty: tab.dirty, documentBase64Chars: tab.document.base64.length })), active: state.active?.document.name || null,
      appBusy: state.busy, appError: state.error, officeFrameCount: frames.length, office,
      pdfEditorCount: document.querySelectorAll('[data-testid="pdf-editor"]').length,
      jsHeap: js, iframeCount: document.querySelectorAll('iframe').length };
  });
}
async function snapshot(kind) {
  const runtime = await runtimeMemory();
  const metrics = Object.fromEntries((await pageCdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const processes = await processMemory();
  fs.writeFileSync(path.join(out, `${phase}-${kind}-smaps.json`), JSON.stringify({ at: processes.at, phase,
    renderers: memoryMappings(processes.processes) }, null, 2));
  return { kind, runtime, cdp: { JSHeapUsedSize: metrics.JSHeapUsedSize, JSHeapTotalSize: metrics.JSHeapTotalSize,
    Nodes: metrics.Nodes, Documents: metrics.Documents }, workers: page.workers().map(worker => ({ url: worker.url() })), ...processes };
}
async function stage(name) {
  phase = name;
  console.log('SETTLE', name);
  await pause(settleMs);
  const item = { name, natural: await snapshot('natural') };
  report.stages.push(item); persist();
  if (collectGc) {
    console.log('GC', name, 'page');
    await pageCdp.send('HeapProfiler.collectGarbage');
    console.log('GC', name, 'frames');
    for (const frame of page.frames()) await frame.evaluate(() => { globalThis.gc?.(); }).catch(() => {});
    await pause(gcSettleMs);
    item.afterGc = await snapshot('after-gc');
  }
  persist();
  console.log('MEMORY', name, JSON.stringify({ pssMiB: item.natural.total.pss / 1048576,
    ussMiB: item.natural.total.uss / 1048576, rssMiB: item.natural.total.rss / 1048576,
    afterGcPssMiB: item.afterGc?.total.pss / 1048576, frames: item.natural.runtime.officeFrameCount,
    threads: item.natural.runtime.office[0]?.threads }));
}
async function ready(name) {
  await page.waitForFunction(expected => {
    const s = document.querySelector('#app')?.__vue_app__?._instance?.setupState;
    if (s?.error) throw Error(s.error);
    return !s?.busy && s?.active?.document.name === expected && s.active.ready;
  }, name, { timeout: 210000 });
  await page.getByTestId('pdf-busy').waitFor({ state: 'hidden', timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector('.pdf-render-indicator'), null, { timeout: 30000 });
}
async function openFile(file) {
  const started = Date.now();
  phase = 'open:' + path.basename(file); console.log('OPEN', path.basename(file));
  await (/\.(?:docx|odt|doc|rtf)$/i.test(file) ? page.locator('input[type="file"][accept=".docx,.odt,.doc,.rtf"]') : page.getByTestId('document-open-input')).setInputFiles(file);
  await ready(path.basename(file));
  report.operations.push({ action: 'open', name: path.basename(file), milliseconds: Date.now() - started });
}
async function exportCurrent(extension, name) {
  const started = Date.now();
  phase = 'export:' + name;
  const value = await page.evaluate(async extension => {
    const state = document.querySelector('#app').__vue_app__._instance.setupState;
    return state.editorTransaction('内存基准：验证导出', () => state.officeEditor.exportFile({ format: extension }));
  }, extension);
  const bytes = Buffer.from(value.base64, 'base64'), file = path.join(out, name);
  assert.ok(bytes.length > 100); fs.writeFileSync(file, bytes);
  if (extension === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const validation = JSON.parse(execFileSync(path.join(targetRoot, 'pdf-backend/.venv/bin/python'), ['-c', `
import sys,json,zipfile,xml.etree.ElementTree as E
file,extension=sys.argv[1:]
if extension=='pdf':
 import pymupdf
 document=pymupdf.open(file);result={'pages':len(document)};assert result['pages']==20
else:
 z=zipfile.ZipFile(file);assert z.testzip() is None;E.fromstring(z.read('[Content_Types].xml'))
 if extension=='docx':
  result={'writerMarker':'COMPAT-WORD-RICH' in ''.join(E.fromstring(z.read('word/document.xml')).itertext())};assert result['writerMarker']
 elif extension=='xlsx':
  rows=[len(E.fromstring(z.read(n)).findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row')) for n in z.namelist() if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')]
  result={'maximumSheetRows':max(rows)};assert result['maximumSheetRows']>=2001
 else:
  result={'slides':sum(n.startswith('ppt/slides/slide') and n.endswith('.xml') for n in z.namelist())};assert result['slides']==20
print(json.dumps(result))
`, file, extension], { encoding: 'utf8' }));
  report.exports.push({ name, extension, bytes: bytes.length, sha256: sha256(bytes), validation });
  report.operations.push({ action: 'export', name, milliseconds: Date.now() - started }); persist();
}
async function closeFile(name) {
  const started = Date.now();
  phase = 'close:' + name; console.log('CLOSE', name);
  const key = await page.evaluate(expected => document.querySelector('#app').__vue_app__._instance.setupState.tabs.find(tab => tab.document.name === expected)?.key, name);
  assert.ok(key, 'Missing tab ' + name);
  await page.getByRole('button', { name: '关闭 ' + name, exact: true }).click();
  await page.waitForFunction(key => {
    const s = document.querySelector('#app').__vue_app__._instance.setupState;
    return !s.tabs.some(tab => tab.key === key) || !!s.closeTarget;
  }, key);
  const dialog = page.getByRole('dialog', { name: '保存你的修改？' });
  if (await dialog.count()) await dialog.getByRole('button', { name: '不保存', exact: true }).click();
  await page.waitForFunction(key => {
    const s = document.querySelector('#app').__vue_app__._instance.setupState;
    return !s.busy && !s.tabs.some(tab => tab.key === key);
  }, key, { timeout: 60000 });
  report.operations.push({ action: 'close', name, milliseconds: Date.now() - started });
}

(async () => {
  try {
    report.implementation = sourceSnapshot();
    const commitFile = path.join(targetRoot, 'BASELINE_COMMIT');
    if (fs.existsSync(commitFile)) report.baselineCommit = fs.readFileSync(commitFile, 'utf8').trim();
    const fixtures = ['writer-rich.docx', 'calc-2000-rows.xlsx', 'presentation-20-slides.pptx'].map(name => path.join(targetRoot, 'tests/compatibility/fixtures/generated', name));
    report.fixtures = fixtures.map(file => ({ name: path.basename(file), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }));
    const pdf = path.join(out, 'memory-fixture.pdf');
    const python = path.join(targetRoot, 'pdf-backend/.venv/bin/python');
    execFileSync(python, ['-c', 'import sys,pymupdf;d=pymupdf.open();[(lambda p,i:p.insert_text((72,90),"OFFICE MEMORY PDF PAGE "+str(i)))(d.new_page(),i) for i in range(1,4)];d.save(sys.argv[1])', pdf]);
    process.chdir(targetRoot);
    const { createServer } = await import('vite');
    server = await createServer({ root: targetRoot, configFile: path.join(targetRoot, 'vite.config.ts'),
      cacheDir: path.join(out, 'vite-cache'), server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } } });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', ...(collectGc ? ['--js-flags=--expose-gc'] : [])] });
    report.environment.chromium = browser.version();
    const context = await browser.newContext({ viewport: report.methodology.viewport, serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(45000);
    page.on('pageerror', error => report.errors.push({ phase, message: error.message }));
    browserCdp = await browser.newBrowserCDPSession(); pageCdp = await context.newCDPSession(page);
    await pageCdp.send('Performance.enable');
    sampler = setInterval(async () => {
      if (sampling) return; sampling = true;
      try { const value = await processMemory(); report.processSamples.push({ at: value.at, phase, ...value.total }); }
      catch {} finally { sampling = false; }
    }, 2000);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState?.tabs);
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    await stage('home');
    await openFile(fixtures[0]); await exportCurrent('docx', 'writer-export.docx'); await stage('writer-rich');
    await openFile(fixtures[1]); await exportCurrent('xlsx', 'calc-export.xlsx'); await stage('calc-2000-rows');
    await openFile(fixtures[2]); await exportCurrent('pptx', 'presentation-export.pptx'); await exportCurrent('pdf', 'presentation-export.pdf'); await stage('presentation-20-slides');
    await openFile(pdf); await stage('pdf-office-retained');
    for (const file of fixtures) await closeFile(path.basename(file));
    await stage('pdf-only-after-last-office-close');
    await closeFile(path.basename(pdf)); await stage('all-closed');
    await openFile(fixtures[0]); await exportCurrent('docx', 'writer-reopened.docx'); await stage('office-reopened');
    await closeFile(path.basename(fixtures[0])); await stage('all-closed-again');
    if (process.env.MEMORY_FINAL_IDLE === '1') {
      phase = 'final-idle'; await pause(15000); await stage('all-closed-after-20s-idle');
    }
    report.implementationUnchanged = sourceSnapshot().sha256 === report.implementation.sha256;
    assert.equal(report.implementationUnchanged, true, 'Source changed while measuring');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.ok = false; report.failedPhase = phase; report.error = String(error.stack || error);
    console.error(error); process.exitCode = 1;
    await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  } finally {
    clearInterval(sampler);
    report.finishedAt = new Date().toISOString();
    report.peakSample = report.processSamples.reduce((peak, item) => !peak || item.pss > peak.pss ? item : peak, null);
    persist(); await browser?.close(); await server?.close();
    console.log('REPORT', path.join(out, 'report.json'));
  }
})();
