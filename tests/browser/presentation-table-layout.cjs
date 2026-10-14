const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, 'test-results/presentation-table-layout'), url = process.env.PRESENTATION_URL || 'http://127.0.0.1:5199/';
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const report = { errors: [], external: [], ok: false };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin) report.external.push(request.url()); });
    await page.goto(url);
    const fixtures = Object.fromEntries(['matched', 'mismatched-frame', 'content-growth'].map(name => [name, fs.readFileSync(path.join(root, `tests/compatibility/presentation-table-layout/${name}.pptx`)).toString('base64')]));
    const result = await page.evaluate(async fixtures => {
      const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
      const { PresentationController, createPresentation } = await import('/src/presentation/core/model.ts');
      const { buildSlideScene } = await import('/src/presentation/core/scene.ts');
      const { slideSvg } = await import('/src/presentation/core/render.ts');
      const { exportPresentationPdf } = await import('/src/presentation/core/pdf.ts');
      const { zipSync, unzipSync } = await import('/node_modules/fflate/esm/browser.js');
      const A = 'http://schemas.openxmlformats.org/drawingml/2006/main', P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
      const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
      const encode = bytes => { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(value); };
      const checks = [], artifacts = [], check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b), parse = bytes => new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml'), direct = (e, name) => [...(e?.children || [])].filter(node => node.namespaceURI === A && node.localName === name);
      const bytes = decode(fixtures.matched), parts = unzipSync(bytes), part = Object.keys(parts).find(key => /^ppt\/slides\/[^/]+\.xml$/.test(key));
      const tableNode = doc => doc.getElementsByTagNameNS(A, 'tbl')[0], xml = bytes => parse(unzipSync(bytes)[part]);
      const canonical = node => [node.namespaceURI, node.localName, [...node.attributes].filter(attribute => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/').map(attribute => [attribute.namespaceURI,attribute.localName,attribute.value]).sort(), [...node.childNodes].map(child => child.nodeType === 1 ? canonical(child) : [child.nodeType,child.nodeValue])];
      const mutate = callback => { const next = unzipSync(bytes), document = parse(next[part]); callback(tableNode(document), document); next[part] = new TextEncoder().encode(new XMLSerializer().serializeToString(document)); return zipSync(next); };
      const make = async bytes => new PresentationController(await importPresentation(bytes), 'table-layout');
      const find = controller => controller.model.slides[0].objects.find(object => object.type === 'table');
      const scene = controller => buildSlideScene(controller.model, controller.model.slides[0]).find(node => node.id === find(controller).id);
      const rectangles = controller => scene(controller).children.map(node => node.kind === 'rect' ? node : node.kind === 'group' && !node.clip && node.children[0]?.kind === 'rect' ? node.children[0] : null).filter(Boolean);
      const save = controller => exportPresentation(controller.model);
      const edit = controller => { const object = find(controller), cells = object.table.cells.map(row => [...row]); cells[0][0] = 'S1 C1'; controller.action({ type: 'update-table', id: object.id, cells }); };
      const axes = document => ({ columns: direct(direct(tableNode(document), 'tblGrid')[0], 'gridCol').map(node => Number(node.getAttribute('w')) / 36000), rows: direct(tableNode(document), 'tr').map(node => Number(node.getAttribute('h')) / 36000) });
      const normalized = node => JSON.parse(JSON.stringify(node, (key, value) => key === 'id' ? undefined : typeof value === 'number' ? Math.round(value * 10000) / 10000 : value));

      const matched = await make(bytes), mismatch = await make(decode(fixtures['mismatched-frame']));
      check(eq([find(matched).width, find(matched).height], [120, 40]), 'Object bounds follow the grid and row totals');
      check(eq(normalized(scene(matched)), normalized(scene(mismatch))), 'Mismatched graphic frame extents do not stretch the table');
      check(eq(rectangles(matched).map(({ x, y, width, height }) => [x, y, width, height]), [[20,20,20,10],[40,20,60,10],[100,20,40,10],[20,30,20,30],[40,30,60,30],[100,30,40,30]]), 'All six cell positions and dimensions preserve unequal geometry');
      check(eq(rectangles(matched).map(cell => cell.fill), ['#f7c65f',null,null,'#ed8a85',null,null]), 'Explicit solid, noFill and absent paint are distinct from invented backgrounds');
      check(rectangles(matched).every(cell => cell.stroke === null), 'No synthetic border is introduced when the source has no cell border');
      const originalMismatch = await save(mismatch), sourceXml = find(mismatch).sourceXml;
      edit(mismatch);
      const edited = await save(mismatch), reopened = await make(edited);
      check(eq(normalized(scene(mismatch)), normalized(scene(reopened))), 'Text edit keeps identical geometry and cell paints after reopening');
      const oldXml = xml(originalMismatch), newXml = xml(edited), oldFrame = oldXml.getElementsByTagNameNS(P, 'xfrm')[0], newFrame = newXml.getElementsByTagNameNS(P, 'xfrm')[0];
      check(new XMLSerializer().serializeToString(oldFrame) === new XMLSerializer().serializeToString(newFrame), 'Text-only edit leaves mismatched original frame XML unchanged');
      check(eq(axes(oldXml), axes(newXml)) && find(mismatch).sourceXml === sourceXml, 'Text edit leaves source row and column grid immutable');
      mismatch.undo(); check(eq(normalized(scene(mismatch)), normalized(scene(await make(originalMismatch)))), 'Undo restores the previous grid, fill and text');
      mismatch.redo(); check(eq(normalized(scene(mismatch)), normalized(scene(reopened))), 'Redo restores the edited cell without layout drift');
      artifacts.push({ name: 'table-layout-edited.pptx', data: encode(edited) });

      let current = reopened;
      for (let cycle = 0; cycle < 3; cycle++) {
        const object = find(current), before = await save(current);
        current.action({ type: 'update-object', id: object.id, width: object.width * 1.5, height: object.height * 1.5 });
        const after = await save(current), next = await make(after), beforeAxes = axes(xml(before)), afterAxes = axes(xml(after));
        check(eq(afterAxes.columns, beforeAxes.columns.map(value => value * 1.5)) && eq(afterAxes.rows, beforeAxes.rows.map(value => value * 1.5)), `Resize cycle ${cycle + 1} writes proportional grid and row dimensions`);
        check(eq(normalized(scene(current)), normalized(scene(next))), `Resize cycle ${cycle + 1} preview matches reopen without double scale`);
        current.undo(); check(eq(axes(xml(await save(current))), beforeAxes), `Resize cycle ${cycle + 1} undo restores original dimensions`);
        current.redo(); current = next;
      }
      const moving = await make(edited), movedObject = find(moving), beforeMove = axes(xml(await save(moving)));
      moving.action({ type: 'update-object', id: movedObject.id, x: 30, y: 40 });
      check(eq(axes(xml(await save(moving))), beforeMove), 'Move alone does not rewrite grid or row sizes');

      const alpha = await make(mutate(table => { const cell = direct(direct(table, 'tr')[0], 'tc')[0], color = cell.getElementsByTagNameNS(A, 'srgbClr'); const fillColor = color[color.length - 1]; const node = table.ownerDocument.createElementNS(A, 'a:alpha'); node.setAttribute('val', '0'); fillColor.append(node); }));
      const alphaScene = scene(alpha), alphaPaint = alphaScene.children.find(node => node.kind === 'group' && node.opacity === 0);
      check(alphaPaint?.children.length === 1 && alphaPaint.children[0].kind === 'rect', 'Zero alpha is a paint-only group');
      check(alphaScene.children.some(node => node.kind === 'group' && node.clip && node.children.some(child => child.kind === 'text')), 'Cell text remains outside transparent paint group');
      const noBody = await make(mutate(table => { const body = direct(direct(direct(table, 'tr')[0], 'tc')[0], 'txBody')[0]; body.remove(); }));
      check(rectangles(noBody)[0].fill === '#f7c65f', 'A cell without text body retains its explicit paint');
      const unknown = await make(mutate(table => { const properties = direct(direct(direct(table, 'tr')[0], 'tc')[0], 'tcPr')[0]; properties.innerHTML = `<a:solidFill xmlns:a="${A}"><a:schemeClr val="unknown-theme"/></a:solidFill>`; }));
      check(rectangles(unknown)[0].fill === null && find(unknown).warning.includes('尚未完整显示'), 'Unknown theme color is warned and not guessed black');
      for (const colorXml of ['<a:srgbClr val="123456"><a:tint val="25000"/></a:srgbClr>', '<a:srgbClr val="123456"><a:shade val="75000"/></a:srgbClr>', '<a:srgbClr val="123456"><a:lumMod val="40000"/></a:srgbClr>', '<a:srgbClr val="123456"><a:lumOff val="40000"/></a:srgbClr>', '<a:sysClr val="windowText"/>']) {
        const controller = await make(mutate(table => { const properties = direct(direct(direct(table, 'tr')[0], 'tc')[0], 'tcPr')[0]; properties.innerHTML = `<a:solidFill xmlns:a="${A}">${colorXml}</a:solidFill>`; }));
        check(rectangles(controller)[0].fill === null && find(controller).warning.includes('尚未完整显示'), `Unverified color transform/cache is not approximated: ${colorXml}`);
      }
      for (const [colorXml, expected] of [['<a:schemeClr val="accent1"/>', '#3875cb'], ['<a:sysClr val="windowText" lastClr="657483"/>', '#657483']]) {
        const controller = await make(mutate(table => { const properties = direct(direct(direct(table, 'tr')[0], 'tc')[0], 'tcPr')[0]; properties.innerHTML = `<a:solidFill xmlns:a="${A}">${colorXml}</a:solidFill>`; }));
        check(rectangles(controller)[0].fill === expected, `Known scheme or system-color cache resolves explicit paint: ${colorXml}`);
      }

      for (const [label, mutateTable] of [
        ['missing grid', table => direct(table, 'tblGrid')[0].remove()],
        ['zero width', table => direct(direct(table, 'tblGrid')[0], 'gridCol')[0].setAttribute('w', '0')],
        ['negative width', table => direct(direct(table, 'tblGrid')[0], 'gridCol')[0].setAttribute('w', '-1')],
        ['NaN width', table => direct(direct(table, 'tblGrid')[0], 'gridCol')[0].setAttribute('w', 'NaN')],
        ['huge width', table => direct(direct(table, 'tblGrid')[0], 'gridCol')[0].setAttribute('w', '999999999999999999999')],
        ['row zero', table => direct(table, 'tr')[0].setAttribute('h', '0')],
        ['missing cell', table => direct(direct(table, 'tr')[0], 'tc')[0].remove()],
        ['merged cell', table => direct(direct(table, 'tr')[0], 'tc')[0].setAttribute('gridSpan', '2')],
        ['foreign grid child', table => direct(table, 'tblGrid')[0].append(table.ownerDocument.createElementNS('urn:foreign', 'x:gridCol'))],
      ]) {
        const source = mutate(mutateTable), controller = await make(source), object = find(controller);
        check(object.locked && !object.tableLayout && scene(controller).children.filter(node => node.kind === 'rect').length === 1 && scene(controller).children.some(node => node.kind === 'path'), `${label}: protected placeholder rather than an equal-grid guess`);
        check(eq(canonical(tableNode(xml(source))), canonical(tableNode(xml(await save(controller))))) && eq([...controller.model.sourceParts.get(part)], [...unzipSync(source)[part]]), `${label}: original table XML and immutable source bytes survive no-op save`);
      }
      const fresh = new PresentationController(createPresentation(), 'new-table');
      fresh.action({ type: 'insert-table', rows: 2, columns: 2, cells: [['One','Two'],['Three','Four']] });
      const freshReopened = await make(await save(fresh));
      check(eq(normalized(scene(fresh)), normalized(scene(freshReopened))), 'New basic table full scene matches first save/reopen');
      freshReopened.action({ type: 'update-table', id: find(freshReopened).id, cells: [['One','Two','Three'],['Four','Five','Six'],['Seven','Eight','Nine']] });
      check(find(freshReopened).tableLayout === undefined && eq(normalized(scene(freshReopened)), normalized(scene(await make(await save(freshReopened))))), 'Basic row/column rebuild clears stale layout and survives reopening');
      const growth = await make(decode(fixtures['content-growth']));
      check(find(growth).warning.includes('内容自动撑高'), 'Content-growth limitation is explicit instead of claiming native row fitting');
      artifacts.push({ name: 'table-layout-preview.svg', text: slideSvg(reopened.model, reopened.model.slides[0]) });
      artifacts.push({ name: 'table-layout.pdf', data: encode(await exportPresentationPdf(reopened.model)) });
      return { checks, artifacts };
    }, fixtures);
    for (const artifact of result.artifacts) fs.writeFileSync(path.join(output, artifact.name), artifact.data ? Buffer.from(artifact.data, 'base64') : artifact.text);
    delete result.artifacts;
    await page.setContent(fs.readFileSync(path.join(output, 'table-layout-preview.svg'), 'utf8'));
    await page.screenshot({ path: path.join(output, 'table-layout-preview.png') });
    Object.assign(report, result, { ok: report.errors.length === 0 && report.external.length === 0 });
    assert.equal(report.ok, true); console.log(JSON.stringify({ ok: true, checks: report.checks.length }));
  } catch (error) { report.error = error.stack; throw error; }
  finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
