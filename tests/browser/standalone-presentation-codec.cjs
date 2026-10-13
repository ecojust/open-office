/* Executed by the full-app harness in its existing Chromium page. No server,
 * browser, Office runtime, or editor state is created or mocked here. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');

async function runCodecChecks(page, fixtures, report) {
  const rich = fs.readFileSync(path.join(fixtures, 'presentation-rich.pptx'));
  const mutate = work => { const parts = unzipSync(rich); work(parts); return Buffer.from(zipSync(parts)).toString('base64'); };
  const inputs = {
    rich: rich.toString('base64'),
    deck20: fs.readFileSync(path.join(fixtures, 'presentation-20-slides.pptx')).toString('base64'),
    effects: fs.readFileSync(path.join(fixtures, 'presentation-effects-media.pptx')).toString('base64'),
    smartart: fs.readFileSync(path.join(fixtures, '../upstream/apache-poi/smartart-simple.pptx')).toString('base64'),
    dtd: mutate(parts => { parts['ppt/preserved-extension.xml'] = strToU8('<!DOCTYPE x [<!ENTITY e SYSTEM "https://example.invalid/leak">]><x>&e;</x>'); }),
    macro: mutate(parts => { parts['ppt/vbaProject.bin'] = Uint8Array.from([1, 2, 3]); }),
    signed: mutate(parts => { parts['_xmlsignatures/sig1.xml'] = strToU8('<Signature/>'); }),
    brandedLayout: mutate(parts => {
      const layout = 'ppt/slideLayouts/slideLayout1.xml', master = 'ppt/slideMasters/slideMaster1.xml';
      parts[layout] = strToU8(strFromU8(parts[layout]).replace(/(<p:cSld[^>]*>)/, '$1<p:bg><p:bgPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'));
      parts[master] = strToU8(strFromU8(parts[master]).replace('</p:spTree>', '<p:sp><p:nvSpPr><p:cNvPr id="900" name="Codec master mark"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="360000" y="360000"/><a:ext cx="3600000" cy="720000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>MASTER-LOGO-KEPT</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>'));
    }),
    ordinaryNotes: mutate(parts => { const name = 'ppt/notesSlides/notesSlide1.xml'; parts[name] = strToU8(strFromU8(parts[name]).replace(/<p:ph type="body"[^>]*\/>/, '').replace('</p:spTree>', '<p:sp><p:nvSpPr><p:cNvPr id="900" name="Extra ordinary notes"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>SECOND-ORDINARY-NOTE</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>')); }),
    traversal: mutate(parts => { parts['ppt/_rels/presentation.xml.rels'] = strToU8(strFromU8(parts['ppt/_rels/presentation.xml.rels']).replace('Target="slides/slide1.xml"', 'Target="../../../outside.xml"')); }),
  };
  const result = await page.evaluate(async input => {
    const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
    const { createPresentation, PresentationController } = await import('/src/presentation/core/model.ts');
    const { readPptxParts, parsePptxPackage } = await import('/src/presentation/pptx-package.ts');
    const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const encode = bytes => { let text = ''; for (let offset = 0; offset < bytes.length; offset += 16384) text += String.fromCharCode(...bytes.subarray(offset, offset + 16384)); return btoa(text); };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const require = (value, message) => { if (!value) throw Error(`Codec contract: ${message}`); };
    const checks = [], pass = message => checks.push(message);
    const flatten = objects => objects.flatMap(object => [object, ...flatten(object.children || [])]);
    const parser = new DOMParser(), xml = bytes => parser.parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    const sameBytes = (a, b) => a && b && a.length === b.length && a.every((byte, index) => byte === b[index]);

    const blank = createPresentation(), blankBytes = await exportPresentation(blank), blankAgain = await importPresentation(blankBytes);
    require(blankAgain.slides.length === 1 && Math.abs(blankAgain.width - blank.width) < .001, 'blank OOXML size/slide');
    const blankParts = await readPptxParts(blankBytes);
    require([...blankParts.keys()].some(name => name.startsWith('ppt/slideMasters/')) && [...blankParts.keys()].some(name => name.startsWith('ppt/slideLayouts/')) && [...blankParts.keys()].some(name => name.startsWith('ppt/theme/')), 'blank master/layout/theme');
    require(![...blankParts.keys()].some(name => /\.json$/i.test(name)), 'document content must be OOXML');
    pass('Codec creates a standard OOXML package with master, layout and theme');

    const original = await importPresentation(decode(input.rich));
    const sourceCopies = new Map([...original.sourceParts].map(([name, bytes]) => [name, bytes.slice()]));
    const originalObjects = original.slides.flatMap(slide => flatten(slide.objects));
    const title = originalObjects.find(object => object.text.includes('COMPAT-PRESENTATION-RICH'));
    const table = originalObjects.find(object => object.table), chart = originalObjects.find(object => object.chart);
    require(title && title.x > 0 && title.width > 0 && title.textStyle.fontSize > 0, 'layout placeholder geometry');
    require(table?.table.cells[1][0] === '江南' && chart?.chart.values[0][0] === 24, 'real table/chart import');
    const unchanged = await exportPresentation(original), unchangedParts = await readPptxParts(unchanged);
    for (const [name, bytes] of sourceCopies) {
      require(sameBytes(original.sourceParts.get(name), bytes), `immutable original part ${name}`);
      if (/^ppt\/(?:charts|embeddings|media)\//.test(name)) require(sameBytes(unchangedParts.get(name), bytes), `preserved dependency ${name}`);
    }
    const reopened = await importPresentation(unchanged), twice = await importPresentation(await exportPresentation(reopened));
    require(equal(twice.slides.map(slide => slide.objects.map(object => object.text)), original.slides.map(slide => slide.objects.map(object => object.text))), 'repeat save content');
    require(twice.slides.length === original.slides.length, 'repeat save slide count');
    pass('Rich sample imports inherited geometry, tables and chart data; unchanged dependencies and original buffers survive two saves');

    const deck20 = await importPresentation(decode(input.deck20)), fifth = deck20.slides[4];
    const fifthTitle = fifth.objects.find(object => object.text === 'DECK-PAGE-05');
    const fifthText = fifth.objects.find(object => object.text === '江南计划 / Editable original briefing');
    require(fifthTitle && Math.abs(fifthTitle.x - 19.05) < .001 && Math.abs(fifthTitle.y - 2130425 / 36000) < .001, '20-page fixture title uses its actual title-slide layout geometry');
    require(fifthText && Math.abs(fifthText.y - 35.56) < .001 && Math.abs(fifth.objects.find(object => object.table).y - 63.5) < .001, 'fixture textbox/table coordinates match independent source OOXML inspection');
    pass('The 20-page fixture preserves its original centered-title geometry, including source-authored overlap on slide five');

    const branded = await importPresentation(decode(input.brandedLayout)), brandedTitle = branded.slides[0].objects.find(object => object.text === 'COMPAT-PRESENTATION-RICH');
    require(branded.slides[0].background === '#123456' && branded.slides[0].inheritedObjects.some(object => object.text === 'MASTER-LOGO-KEPT'), 'branded layout fixture imported');
    const brandedController = new PresentationController(branded, 'codec-layout-inheritance');
    brandedController.action({ type: 'set-layout', pageIndex: 0, layout: 19 });
    const brandedAgain = await importPresentation(await exportPresentation(brandedController.model)), brandedTitleAgain = brandedAgain.slides[0].objects.find(object => object.text === 'COMPAT-PRESENTATION-RICH');
    require(brandedAgain.slides[0].layout === 19 && brandedAgain.slides[0].background === '#123456' && brandedAgain.slides[0].inheritedObjects.some(object => object.text === 'MASTER-LOGO-KEPT'), 'layout edit retains inherited artwork and background');
    for (const key of ['x', 'y', 'width', 'height']) require(Math.abs(brandedTitleAgain[key] - brandedTitle[key]) < .001, `layout edit retains inherited title ${key}`);
    require(equal(brandedTitleAgain.textStyle, brandedTitle.textStyle), 'layout edit retains inherited title style');
    pass('Changing an imported layout preserves inherited master artwork, background, placeholder geometry and theme text style');

    const controller = new PresentationController(original, 'codec-regression');
    const titlePage = controller.model.slides.findIndex(slide => slide.objects.some(object => object.id === title.id));
    controller.action({ type: 'select-page', pageIndex: titlePage });
    controller.action({ type: 'update-object', id: title.id, text: 'Codec中文 text & <escaped>' });
    const dataPage = controller.model.slides.findIndex(slide => slide.objects.some(object => object.id === table.id));
    controller.action({ type: 'select-page', pageIndex: dataPage });
    const cells = table.table.cells.map(row => [...row]); cells[1][1] = '73';
    controller.action({ type: 'update-table', id: table.id, cells });
    const values = chart.chart.values.map(row => [...row]); values[0][0] = 99;
    controller.action({ type: 'update-chart', id: chart.id, chartType: chart.chart.type, categories: chart.chart.categories, series: chart.chart.series, values, title: 'Changed chart 数据' });
    controller.action({ type: 'set-notes', pageIndex: dataPage, text: 'Codec notes 中文\nSecond line' });
    controller.action({ type: 'set-hidden', pageIndex: dataPage, value: true });
    controller.action({ type: 'duplicate-page', pageIndex: dataPage });
    const duplicateId = controller.model.slides[dataPage + 1].id;
    controller.action({ type: 'move-page', pageIndex: dataPage + 1, direction: 'up' });
    require(controller.model.slides[dataPage].id === duplicateId, 'controller reorder setup');
    const changedBytes = await exportPresentation(controller.model), changed = await importPresentation(changedBytes), changedPackage = await parsePptxPackage(changedBytes);
    const changedObjects = changed.slides.flatMap(slide => flatten(slide.objects));
    require(changedObjects.some(object => object.text === 'Codec中文 text & <escaped>'), 'edited unicode text');
    require(changedObjects.filter(object => object.table?.cells[1]?.[1] === '73').length >= 2, 'edited table duplicated');
    require(changedObjects.filter(object => object.chart?.values[0]?.[0] === 99).length >= 2, 'edited chart duplicated');
    require(changed.slides.filter(slide => slide.notes === 'Codec notes 中文\nSecond line' && slide.hidden).length >= 2, 'notes and hidden duplicate');
    require(new Set(changedPackage.slides.map(slide => slide.partName)).size === changed.slides.length, 'distinct slide parts');
    require(new Set(changedPackage.slides.map(slide => slide.id)).size === changed.slides.length, 'distinct slide IDs');
    const changedParts = await readPptxParts(changedBytes);
    for (const slide of changedPackage.slides) {
      const document = xml(changedParts.get(slide.partName)), ids = [...document.getElementsByTagNameNS('*', 'cNvPr')].map(node => node.getAttribute('id'));
      require(ids.length === new Set(ids).size, 'unique slide shape IDs');
    }
    for (const [name, bytes] of sourceCopies) require(sameBytes(original.sourceParts.get(name), bytes), `immutable edited source ${name}`);
    const changedAgain = await importPresentation(await exportPresentation(changed));
    require(changedAgain.slides.flatMap(slide => flatten(slide.objects)).some(object => object.chart?.values[0]?.[0] === 99), 'edited data survives repeated save');
    pass('Text, table, chart, notes, hidden slides, duplicate and reorder survive independent import/export with unique IDs');

    const groupController = new PresentationController(createPresentation(), 'codec-groups');
    groupController.action({ type: 'insert-shape', shapeType: 'rectangle', x: 20, y: 25, width: 30, height: 15 });
    groupController.action({ type: 'insert-shape', shapeType: 'ellipse', x: 70, y: 40, width: 20, height: 30 });
    groupController.action({ type: 'arrange-objects', ids: groupController.model.slides[0].objects.map(object => object.id), operation: 'group' });
    const group = groupController.model.slides[0].objects[0];
    groupController.action({ type: 'update-object', id: group.id, x: 40, y: 35, width: 90, rotation: 30 });
    const groupReopened = await importPresentation(await exportPresentation(groupController.model)), savedGroup = groupReopened.slides[0].objects[0];
    require(savedGroup.type === 'group' && savedGroup.rotation === 30 && savedGroup.children.length === 2, 'group structure and rotation');
    for (let index = 0; index < 2; index++) for (const key of ['x', 'y', 'width', 'height']) require(Math.abs(savedGroup.children[index][key] - groupController.model.slides[0].objects[0].children[index][key]) < .001, `group absolute coordinates ${key}`);
    pass('Group move, resize, rotation and absolute child geometry survive real OOXML export/import');
    groupController.action({ type: 'insert-table', rows: 2, columns: 2, cells: [['Editable', 'Table'], ['Namespace', 'Correct']] });
    const generatedBytes = await exportPresentation(groupController.model), generatedParts = await readPptxParts(generatedBytes), generatedInfo = await parsePptxPackage(generatedBytes);
    const generatedSlide = xml(generatedParts.get(generatedInfo.slides[0].partName));
    const tableData = [...generatedSlide.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'graphicData')].find(element => element.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'tbl').length);
    require(tableData?.getAttribute('uri') === 'http://schemas.openxmlformats.org/drawingml/2006/table', 'new tables use the standard graphicData type URI, not the DrawingML main namespace');
    pass('New editable tables declare the standard OOXML table graphicData URI for independent office readers');

    const effects = await importPresentation(decode(input.effects)), effectsOut = await exportPresentation(effects), effectAgain = await importPresentation(effectsOut), effectsParts = await readPptxParts(effectsOut);
    require(equal(effectAgain.slides.map(slide => slide.transition), effects.slides.map(slide => slide.transition)), 'unchanged transitions');
    require(equal(effectAgain.slides.map(slide => slide.media.map(media => ({ kind: media.kind, start: media.start, loop: media.loop, bytes: media.data?.length }))), effects.slides.map(slide => slide.media.map(media => ({ kind: media.kind, start: media.start, loop: media.loop, bytes: media.data?.length })))), 'unchanged media');
    for (const slide of effects.slides) {
      const before = xml(effects.sourceParts.get(slide.sourcePart)), after = xml(effectsParts.get(slide.sourcePart));
      const serialize = document => [...document.getElementsByTagNameNS('*', 'transition')].map(node => new XMLSerializer().serializeToString(node));
      require(equal(serialize(before), serialize(after)), 'transition XML metadata remains intact');
    }
    pass('Effects and media retain original transition XML, timing metadata and embedded bytes');

    const ordinaryNotes = await importPresentation(decode(input.ordinaryNotes));
    require(ordinaryNotes.slides[0].notes.includes('SECOND-ORDINARY-NOTE'), 'ordinary note shapes imported');
    ordinaryNotes.slides[0].notes = 'Replacement notes 中文';
    const ordinaryNotesAgain = await importPresentation(await exportPresentation(ordinaryNotes));
    require(ordinaryNotesAgain.slides[0].notes === 'Replacement notes 中文', 'ordinary note shapes do not duplicate old text after an edit');
    pass('Editing notes replaces multiple ordinary text shapes without duplicating their old text');

    const smartart = await importPresentation(decode(input.smartart));
    require(smartart.slides.some(slide => flatten(slide.objects).some(object => object.locked && object.warning && object.sourceXml)), 'unsupported SmartArt locked placeholder');
    const smartartParts = await readPptxParts(await exportPresentation(smartart));
    for (const [name, bytes] of smartart.sourceParts) if (/^ppt\/diagrams\//.test(name)) require(sameBytes(bytes, smartartParts.get(name)), `SmartArt dependency ${name}`);
    pass('Unsupported SmartArt is explicitly locked and its original diagram parts remain intact');

    for (const [name, pattern] of [['dtd', /DTD|实体/], ['macro', /宏/], ['signed', /数字签名/], ['traversal', /越界|关系/]]) {
      let error; try { await importPresentation(decode(input[name])); } catch (caught) { error = caught; }
      require(error && pattern.test(String(error.message)), `security rejection ${name}`);
    }
    pass('DTD in unrecognized extensions, macro packages, signed packages and relationship traversal are rejected');
    return { checks, blankBytes: blankBytes.length, richBytes: unchanged.length, editedBytes: changedBytes.length, edited: encode(changedBytes), generated: encode(generatedBytes) };
  }, inputs);

  // Independent ZIP/workbook inspection uses Node fflate, not the importer.
  const parts = unzipSync(Buffer.from(result.edited, 'base64'));
  const changedWorkbooks = Object.entries(parts).filter(([name]) => /^ppt\/embeddings\/canvasChartData\d+\.xlsx$/.test(name));
  assert.ok(changedWorkbooks.length >= 2, 'Duplicated edited charts have standalone data workbooks');
  for (const [, bytes] of changedWorkbooks) {
    const workbook = unzipSync(bytes);
    assert.match(strFromU8(workbook['xl/worksheets/sheet1.xml']), /<c r="B2"[^>]*><v>99<\/v><\/c>/);
    assert.match(strFromU8(workbook['xl/workbook.xml']), /name="Sheet1"/);
  }
  delete result.edited;
  const generatedParts = unzipSync(Buffer.from(result.generated, 'base64'));
  assert.ok(Object.entries(generatedParts).some(([name, bytes]) => /^ppt\/slides\/[^/]+\.xml$/.test(name) && /<a:graphicData uri="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/table"/.test(strFromU8(bytes))), 'Independent ZIP inspection confirms a standard editable table type');
  delete result.generated;
  result.checks.push('Independent ZIP inspection confirms edited chart values live in real embedded XLSX workbooks');
  report.codec = result;
  report.checks.push(...result.checks);
  return result;
}

module.exports = { runCodecChecks };
