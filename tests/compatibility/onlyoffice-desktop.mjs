// Optional Linux desktop oracle. Uses a separately installed official binary;
// no ONLYOFFICE implementation is bundled with this project.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = process.env.ONLYOFFICE_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set ONLYOFFICE_BINARY to an absolute official DesktopEditors executable path.');
const display = process.env.ONLYOFFICE_DISPLAY || process.env.DISPLAY;
if (!display) throw new Error('Set ONLYOFFICE_DISPLAY to an existing isolated X display.');
const port = Number(process.env.ONLYOFFICE_DEBUG_PORT || 9232);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid local debugging port');
const origin = `http://127.0.0.1:${port}`;
const out = path.resolve(process.env.ONLYOFFICE_OUTPUT || path.join(root, 'test-results/onlyoffice-desktop'));
const exportsRoot = path.resolve(process.env.ONLYOFFICE_EXPORTS || path.join(root, 'test-results/standalone-presentation-complex'));
const manifestPath = path.resolve(process.env.ONLYOFFICE_MANIFEST || path.join(root, 'tests/compatibility/presentation-complex/manifest.json'));
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const selected = new Set((process.env.ONLYOFFICE_CASES || 'poi-smartart-default-list,poi-smartart-alternating-hexagons,poi-smartart-venn').split(','));
const items = manifest.items.filter(item => selected.has(item.id));
assert.equal(items.length, selected.size, 'Unknown fixture IDs');
const variants = (process.env.ONLYOFFICE_VARIANTS || 'original,noop,edited').split(',');
const captureAllSlides = process.env.ONLYOFFICE_CAPTURE_ALL_SLIDES === '1';
assert.ok(variants.length && variants.every(value => /^[a-z][a-z0-9-]*$/.test(value)), 'Invalid variant labels');
await fs.mkdir(out, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, binary,
  scope: 'Official ONLYOFFICE desktop opens original fixtures and actual Open Office exports. Slide count and loaded canvas assertions; screenshots retained for visual review.',
  limitations: ['No pixel-equality assertion or universal fidelity claim.', 'Does not test native macOS / Windows builds.', 'External application is not included in the product.'],
  cases: [], failures: [],
};
const persist = () => fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let openTimer;
  try {
    await Promise.race([once(socket, 'open'), new Promise((_, reject) => { openTimer = setTimeout(() => reject(Error('CDP connection timed out')), 10000); })]);
  } catch (error) { socket.close(); throw error; }
  finally { clearTimeout(openTimer); }
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    },
    close() { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('CDP closed')); } pending.clear(); socket.close(); },
  };
}

async function stop(child) {
  if (!child.pid) return;
  const terminate = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  terminate('SIGTERM');
  await Promise.race([child.exitCode === null ? once(child, 'exit') : Promise.resolve(), pause(1500)]);
  terminate('SIGKILL');
}

async function stableScreenshot(client) {
  const started = Date.now();
  let screenshot, hash, lastHash, repeated = 0;
  while (Date.now() - started < 20000) {
    await pause(750);
    screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    hash = digest(Buffer.from(screenshot.data, 'base64'));
    repeated = hash === lastHash ? repeated + 1 : 0;
    lastHash = hash;
    if (Date.now() - started >= 5000 && repeated >= 3) break;
  }
  assert.ok(screenshot && repeated >= 3, 'Reference screenshot did not settle');
  return { data: Buffer.from(screenshot.data, 'base64'), hash, renderWaitMs: Date.now() - started };
}

async function openInDesktop(item, variant, source) {
  const dir = path.join(out, item.id, variant);
  await fs.mkdir(dir, { recursive: true });
  const bytes = await fs.readFile(source);
  if (variant === 'original') assert.equal(digest(bytes), item.sha256, 'Original fixture fingerprint changed');
  const copy = path.join(dir, `${item.id}-${variant}.pptx`);
  await fs.writeFile(copy, bytes);
  const child = spawn(binary, ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, '--lang=zh-CN', copy], {
    detached: true,
    env: { ...process.env, DISPLAY: display, LD_LIBRARY_PATH: [path.dirname(binary), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      XDG_CONFIG_HOME: path.join(dir, 'profile/config'), XDG_CACHE_HOME: path.join(dir, 'profile/cache'), XDG_DATA_HOME: path.join(dir, 'profile/data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', launchError, client;
  child.on('error', error => { launchError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { if (logs.length < 100000) logs += data.toString(); });
  try {
    const deadline = Date.now() + 90000;
    let state;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw Error(`DesktopEditors exited (${child.exitCode}): ${logs.slice(-1500)}`);
      if (!client) {
        let pages;
        try { pages = await (await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(2000) })).json(); } catch { await pause(250); continue; }
        const page = pages.find(page => { try { const url = new URL(page.url); return url.searchParams.get('doctype') === 'slide' && url.searchParams.get('title') === path.basename(copy); } catch { return false; } });
        if (page) client = await connect(page);
      }
      if (client) {
        state = await client.evaluate(`(() => { const w = document.querySelector('iframe')?.contentWindow; if (!w?.editor?.getCountPages) return null;
          const canvases = [...w.document.querySelectorAll('canvas')].filter(canvas => canvas.width > 100 && canvas.height > 100).map(canvas => ({ id: canvas.id, width: canvas.width, height: canvas.height }));
          return { slideCount: w.editor.getCountPages(), canvases, editorType: typeof w.editor, title: document.title }; })()`);
        if (state?.slideCount > 0 && state.canvases.length > 0) break;
      }
      await pause(250);
    }
    assert.ok(state?.canvases?.length, 'Editor did not initialize slide canvases before timeout');
    assert.equal(state.slideCount, item.expected.slides, `${item.id}/${variant}: official editor slide count`);
    // Slide count is ready before embedded images/fonts finish decoding. Wait
    // for a minimum warm-up plus repeated identical compositor screenshots.
    const screenshot = await stableScreenshot(client);
    const tableGeometry = process.env.ONLYOFFICE_CAPTURE_TABLES === '1' ? await client.evaluate(`(() => {
      const w=document.querySelector('iframe').contentWindow, logic=w.editor.WordControl?.m_oLogicDocument;
      if(!logic)return {available:false,reason:'Public runtime does not expose the source-level model path',editorKeys:Object.keys(w.editor).slice(0,160)};
      const s=logic.Slides[0];
      return s.spTree.filter(f=>f.graphicObject?.TableGrid).map(f=>{const t=f.graphicObject,x=f.spPr?.xfrm;
        return {frame:{x:f.x,y:f.y,width:f.extX,height:f.extY},sourceTransform:x?{x:x.offX,y:x.offY,width:x.extX,height:x.extY}:null,
          grid:t.TableGrid,calculatedGrid:t.TableGridCalc,pages:t.Pages?.map(p=>p.Bounds),
          rows:t.Content.map((r,i)=>({height:r.Pr?.Height,layout:t.RowsInfo?.[i]?{H:t.RowsInfo[i].H,Y:t.RowsInfo[i].Y,TopDy:t.RowsInfo[i].TopDy}:null,
            cells:r.Content.map(c=>({metrics:c.Metrics,content:{x:c.Content.X,y:c.Content.Y,right:c.Content.XLimit,bottom:c.Content.YLimit}}))}))};});
    })()`) : undefined;
    await fs.writeFile(path.join(dir, 'editor.png'), screenshot.data);
    const slideScreenshots = [{ index: 0, path: path.relative(out, path.join(dir, 'editor.png')), sha256: screenshot.hash }];
    if (captureAllSlides) for (let index = 1; index < state.slideCount; index++) {
      await client.evaluate(`document.querySelector('iframe').contentWindow.editor.goToPage(${index})`);
      const capture = await stableScreenshot(client);
      const currentPage = await client.evaluate(`document.querySelector('iframe').contentWindow.editor.getCurrentPage()`);
      assert.equal(currentPage, index, 'Reference application navigated to the requested slide');
      const target = path.join(dir, `slide-${index + 1}.png`);
      await fs.writeFile(target, capture.data);
      slideScreenshots.push({ index, path: path.relative(out, target), sha256: capture.hash });
    }
    const after = await fs.readFile(copy);
    assert.equal(digest(after), digest(bytes), 'Read-only reference opening unexpectedly changed input bytes');
    return { variant, source: path.relative(root, source), sha256: digest(bytes), ok: true, ...state,
      screenshotSettled: true, renderWaitMs: screenshot.renderWaitMs, screenshotSha256: screenshot.hash,
      screenshot: path.relative(out, path.join(dir, 'editor.png')), slideScreenshots, ...(tableGeometry ? {tableGeometry} : {}) };
  } finally {
    client?.close();
    await stop(child);
    await fs.writeFile(path.join(dir, 'desktop.log'), logs);
  }
}

try {
  // Never attach to an existing debugging instance or close an unrelated app.
  // Desktop Editors has a per-user singleton even with separate XDG profiles.
  // A running instance would accept our files and make the new process exit 0.
  if (process.platform === 'linux') {
    for (const pid of (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      let executable;
      try { executable = await fs.readlink(`/proc/${pid}/exe`); } catch { continue; }
      assert.notEqual(path.basename(executable), 'DesktopEditors', `DesktopEditors already running (PID ${pid}); use an isolated session or close that instance before this test`);
    }
  }
  let occupied = false;
  try { const response = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1500) }); occupied = response.ok; } catch {}
  assert.equal(occupied, false, `Debug port ${port} already belongs to another application`);
  for (const item of items) {
    const entry = { id: item.id, variants: [] }; report.cases.push(entry);
    for (const variant of variants) {
      const source = variant === 'original' ? path.resolve(path.dirname(manifestPath), item.path)
        : path.join(exportsRoot, item.id, variant === 'noop' ? 'noop-3.pptx' : `${variant}.pptx`);
      console.log('ONLYOFFICE', item.id, variant);
      try { entry.variants.push(await openInDesktop(item, variant, source)); }
      catch (error) { const failure = { id: item.id, variant, message: error.message }; report.failures.push(failure); entry.variants.push({ ...failure, ok: false }); }
      await persist();
    }
  }
} catch (error) { report.failures.push({ message: error.message }); }
finally {
  report.completedAt = new Date().toISOString(); report.ok = report.failures.length === 0;
  await persist(); console.log(JSON.stringify({ ok: report.ok, opened: report.cases.reduce((n, item) => n + item.variants.filter(v => v.ok).length, 0), failures: report.failures, report: path.join(out, 'report.json') }, null, 2));
  if (!report.ok) process.exitCode = 1;
}
