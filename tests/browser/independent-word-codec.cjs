/* Real Chromium DOMParser and TS codec; fixtures and saved ZIP inspection use
 * Node fflate independently. No Office runtime or mocked document engine. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { chromium } = require('playwright')
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate')
const root = path.resolve(__dirname, '../..')
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const mainType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const rel = (type, target, id = 'r1', attrs = '') => `<Relationship Id="${id}" Type="${type}" Target="${target}" ${attrs}/>`
const rels = rows => `<Relationships xmlns="${PR}">${rows}</Relationships>`
const section = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
function fixture(body = '<w:p><w:r><w:t xml:space="preserve"> 中文 😀 &amp; text </w:t></w:r></w:p>', styles = '') {
  const parts = {
    '[Content_Types].xml': strToU8(`<Types xmlns="${CT}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="${mainType}"/>${styles ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : ''}</Types>`),
    '_rels/.rels': strToU8(rels(rel(`${R}/officeDocument`, 'word/document.xml'))),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body>${body}${section}</w:body></w:document>`),
  }
  if (styles) {
    parts['word/styles.xml'] = strToU8(`<w:styles xmlns:w="${W}">${styles}</w:styles>`)
    parts['word/_rels/document.xml.rels'] = strToU8(rels(rel(`${R}/styles`, 'styles.xml')))
  }
  return parts
}
function changed(parts, name, change) { return { ...parts, [name]: strToU8(change(strFromU8(parts[name]))) } }
function withPart(parts, name, xml, type, mime, rootRelationship = false) {
  const path = rootRelationship ? '_rels/.rels' : 'word/_rels/document.xml.rels'
  const target = rootRelationship ? name : name.replace(/^word\//, '')
  return {
    ...parts,
    '[Content_Types].xml': strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', `<Override PartName="/${name}" ContentType="${mime}"/></Types>`)),
    [path]: strToU8((parts[path] ? strFromU8(parts[path]) : rels('')).replace('</Relationships>', `${rel(type, target, 'added')}</Relationships>`)),
    [name]: strToU8(xml),
  }
}
const pack = parts => Array.from(zipSync(parts))
async function main() {
  const sources = ['src/word/core/model.ts', 'src/word/core/docx.ts', 'src/word/core/paper.ts', 'src/word/core/scripts.ts', 'src/word/core/highlight.ts', 'src/word/core/background.ts']
  const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
  const productBefore = hashes()
  const { createServer } = await import('vite')
  const server = await createServer({ configFile: false, root, cacheDir: 'node_modules/.vite-independent-word-codec-test', optimizeDeps: { include: ['fflate'], noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/src-tauri/target/**', '**/test-results/**'] } }, plugins: [{ name: 'word-codec-page', configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>Word codec test</title>') } else next() }) } }] })
  let browser
  const output = path.resolve(process.env.WORD_CODEC_OUTPUT || path.join(root, 'test-results/independent-word-codec')); fs.mkdirSync(output, { recursive: true })
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const page = await browser.newPage(); const officeRequests = [], pageErrors = []
    page.on('request', request => { if (/office-runtime|office\/host|soffice|zetajs/.test(request.url())) officeRequests.push(request.url()) })
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    const roundTrip = await page.evaluate(async () => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { createWordDocument, normalizeDocument } = await import('/src/word/core/model.ts')
      const model = createWordDocument()
      model.paragraphs = [
        { id: 'heading', style: { heading: 1, align: 'center', spaceBefore: 6.5, spaceAfter: 10 }, runs: [{ text: '标题中文 😀', style: { bold: true, fontName: 'Noto Sans CJK SC', fontSize: 18, color: '#123abc', fontNameEastAsia: 'DejaVu Sans', fontNameCs: 'Noto Sans', language: 'en-US', languageEastAsia: 'zh-CN', languageBidi: 'hi-IN', fontSizeCs: 12, kerning: 10 } }] },
        { id: 'body', style: { heading: 0, align: 'justify', spaceBefore: 0, spaceAfter: 3, lineHeight: 1.5, lineHeightRule: 'auto', keepLines: true }, runs: [
          { text: '  first & <second>  ', style: { bold: false, italic: true, underline: false, fontSize: 12.5 } },
          { text: '\t中文😀\nsoft line  ', style: { bold: true, italic: false, underline: true, color: '#FF0000', fontName: 'Arial' } },
          { text: ' double 中文😀 ', style: { underline: 'double', strike: 'single', highlight: 'yellow', backgroundColor: '#13579B' } },
          { text: ' plain ', style: {} },
        ] },
        { id: 'empty', style: {}, runs: [{ text: '', style: { bold: false } }] },
      ]
      const clean = model => ({ ...model, paragraphs: model.paragraphs.map(({ id, sourceRun, sourceParagraph, directStyle, marker, ...paragraph }) => ({
        ...paragraph, runs: paragraph.runs.map(({ directStyle, ...run }) => run),
        // A legacy empty insertion run now saves as a real paragraph mark.
        marker: marker ? { style: marker.style, sourceVerticalAlign: marker.sourceVerticalAlign }
          : paragraph.runs.every(run => !run.text) ? { style: paragraph.runs[0].style, sourceVerticalAlign: paragraph.runs[0].sourceVerticalAlign } : undefined,
      })) })
      const effective = normalizeDocument({ ...model, defaultTabStop: 36, autoHyphenation: false, paragraphs: model.paragraphs.map(paragraph => ({ ...paragraph, style: { spaceBefore: 0, spaceAfter: 8, lineHeight: 1, lineHeightRule: 'auto', widowControl: true, ...paragraph.style }, runs: paragraph.runs.map(run => ({ ...run, style: { fontName: 'Times New Roman', fontNameEastAsia: run.style.fontName || 'Times New Roman', fontNameCs: run.style.fontName || 'Times New Roman', fontSize: 12, color: '#20242B', ...run.style } })) })) })
      // Legacy in-memory pages infer portrait for this tall A4 sheet; DOCX
      // import now retains the independent orientation explicitly.
      effective.page.orientation = 'portrait'
      const expected = clean(effective), bytes = exportWordDocument(model), imported = importWordDocument(bytes)
      const again = importWordDocument(exportWordDocument(imported))
      const require = (value, message) => { if (!value) throw Error(message) }
      require(JSON.stringify(clean(imported)) === JSON.stringify(expected), 'Rich text / paragraph / page round trip differs')
      require(JSON.stringify(clean(again)) === JSON.stringify(expected), 'Second save differs')
      const blank = importWordDocument(exportWordDocument(createWordDocument()))
      require(blank.paragraphs.length === 1 && blank.paragraphs[0].runs[0].text === '', 'Blank document must round trip')
      const maximumFont = createWordDocument(); maximumFont.paragraphs[0].runs[0] = { text: 'large', style: { fontSize: 400 } }
      require(importWordDocument(exportWordDocument(maximumFont)).paragraphs[0].runs[0].style.fontSize === 400, 'Maximum supported font must round trip')
      const tooWide = createWordDocument(); tooWide.page.width = 2000
      let rejected = false; try { exportWordDocument(tooWide) } catch { rejected = true }
      require(rejected, 'Export must reject pages its own importer cannot read')
      const oversized = createWordDocument()
      oversized.paragraphs[0].runs = Array.from({ length: 22000 }, (_, i) => ({ text: 'abc', style: { bold: i % 2 === 0, italic: true, underline: true, fontName: 'Noto Sans CJK SC', fontSize: 12, color: '#123456' } }))
      rejected = false; try { exportWordDocument(oversized) } catch (error) { rejected = /XML 过大/.test(error.message) }
      require(rejected, 'Oversized generated XML must refuse export before saving an unreadable document')
      return { bytes: Array.from(bytes), checks: ['Unicode, spaces, tabs, soft breaks and single/double underline with separate strike and paint survive two OOXML saves', 'Explicit false formatting survives alongside inherited / unspecified values', 'Heading, justification, paragraph spacing, paper dimensions and margins survive', 'Blank paragraphs and 400pt font survive; unsupported paper size refuses export'] }
    })
    const saved = Uint8Array.from(roundTrip.bytes), savedParts = unzipSync(saved), document = strFromU8(savedParts['word/document.xml'])
    assert.match(document, /<w:spacing w:before="130" w:after="200"\/><w:jc w:val="center"\/><w:outlineLvl w:val="0"\/>/)
    assert.match(document, /<w:b w:val="0"\/>/)
    assert.match(document, /<w:tab\/>/); assert.match(document, /<w:br\/>/); assert.match(document, /xml:space="preserve">  first &amp; &lt;second&gt;  /)
    assert.equal(Object.keys(savedParts).some(name => /\.json$/.test(name)), false)
    fs.writeFileSync(path.join(output, 'round-trip.docx'), saved)
    // Writer treats every nonzero value as an enabled switch, including raw
    // kern=1. Preserve the original half-point value through our own saves.
    const kerningValues = [0, 1, 2, 24, 800]
    const kerningControls = await page.evaluate(async ({ bytes, values }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        model.paragraphs.forEach((paragraph, i) => {
          if (paragraph.runs[0].style.kerning !== values[i] / 2 || paragraph.runs[0].text !== 'AV') throw Error(`Raw kerning value changed at ${i}, save ${save}`)
        })
        model = importWordDocument(exportWordDocument(model))
      }
      return values
    }, { values: kerningValues, bytes: pack(fixture(kerningValues.map(value => `<w:p><w:r><w:rPr><w:sz w:val="16"/><w:kern w:val="${value}"/></w:rPr><w:t>AV</w:t></w:r></w:p>`).join(''))) })
    const underlineColorValues = ['FF0000', '00aAff', '000000', 'FFFFFF'].flatMap(color => ['single', 'double', 'none'].map(mode => ({ color, mode })))
    const underlineColorControls = await page.evaluate(async ({ bytes, values }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        model.paragraphs.forEach((p, i) => {
          const s = p.runs[0].style, expected = values[i]
          if (s.underlineColor !== '#' + expected.color.toUpperCase() || s.underline !== (expected.mode === 'double' ? 'double' : expected.mode === 'single')) throw Error(`Underline color/mode changed at ${i}, save ${save}`)
          if (s.color !== '#123456' || s.strike !== 'single' || p.runs[0].text !== 'Color 中文😀') throw Error(`Underline color polluted other properties at ${i}`)
        })
        model = importWordDocument(exportWordDocument(model))
      }
      return values
    }, { values: underlineColorValues, bytes: pack(fixture(underlineColorValues.map(({ color, mode }) => `<w:p><w:r><w:rPr><w:color w:val="123456"/><w:strike/><w:u w:val="${mode}" w:color="${color}"/></w:rPr><w:t>Color 中文😀</w:t></w:r></w:p>`).join(''))) })
    // Independent expected percentages come from the pinned Writer controls,
    // including negative half ties (C++ round is not JavaScript Math.round).
    const baselineValues = [
      { halfPoints: 1, fontSize: 12, percent: 4 }, { halfPoints: -1, fontSize: 12, percent: -4 },
      { halfPoints: 3, fontSize: 12, percent: 13 }, { halfPoints: -3, fontSize: 12, percent: -13 },
      { halfPoints: 6, fontSize: 12, percent: 25 }, { halfPoints: -6, fontSize: 12, percent: -25 },
      { halfPoints: 1, fontSize: 8, percent: 6 }, { halfPoints: 1, fontSize: 20, percent: 3 },
      { halfPoints: 1, fontSize: 24, percent: 2 },
      ...['superscript', 'subscript', 'baseline'].flatMap(script => [false, true].map(scriptFirst => ({ halfPoints: 6, fontSize: 12, percent: 25, script, scriptFirst }))),
    ]
    const baselineControls = await page.evaluate(async ({ bytes, values }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        model.paragraphs.forEach((p, i) => {
          const run = p.runs[0], expected = values[i]
          if (run.style.verticalAlign !== expected.percent || run.directStyle.verticalAlign !== expected.percent || run.style.fontSize !== expected.fontSize) throw Error(`Native baseline percentage changed at ${i}, save ${save}`)
          if (run.text !== 'Offset 中文😀' || run.style.underlineColor !== '#FF0000' || run.style.strike !== 'single') throw Error(`Baseline offset changed text or independent decoration at ${i}`)
        })
        model = importWordDocument(exportWordDocument(model))
      }
      return values
    }, { values: baselineValues, bytes: pack(fixture(baselineValues.map(({ halfPoints, fontSize, script, scriptFirst }) => {
      const position = `<w:position w:val="${halfPoints}"/>`, alignment = script ? `<w:vertAlign w:val="${script}"/>` : ''
      return `<w:p><w:r><w:rPr><w:sz w:val="${fontSize * 2}"/><w:strike/><w:u w:val="double" w:color="FF0000"/>${scriptFirst ? alignment + position : position + alignment}</w:rPr><w:t>Offset 中文😀</w:t></w:r></w:p>`
    }).join(''))) })
    const emptyOffsetControls = await page.evaluate(async () => {
      const { importWordDocument, exportWordDocument, exportWordParts } = await import('/src/word/core/docx.ts')
      const { createWordDocument, WordController } = await import('/src/word/core/model.ts')
      const results = [], range = (a, b = a) => ({ anchor: { paragraph: 0, offset: a }, focus: { paragraph: 0, offset: b } })
      for (const scenario of ['partial-delete', 'empty-named-marker']) {
        const model = createWordDocument(), sourceRun = { fontSize: 12, fontName: 'DejaVu Sans' }
        const format = { style: { ...sourceRun, verticalAlign: 'superscript' }, directStyle: {}, sourceVerticalAlign: 'superscript' }
        model.paragraphs = [{ id: scenario, style: {}, sourceRun, ...(scenario === 'empty-named-marker' ? { marker: structuredClone(format) } : {}), runs: [{ text: scenario === 'partial-delete' ? 'AB' : '', ...structuredClone(format) }] }]
        const c = new WordController(model)
        c.formatText(range(0, scenario === 'partial-delete' ? 1 : 0), { verticalAlign: 25 })
        if (scenario === 'partial-delete') c.replaceText(range(0, 2), '')
        if (c.model.paragraphs[0].runs[0].style.verticalAlign !== 25) throw Error(`${scenario}: lost live insertion offset`)
        const bytes = exportWordDocument(c.model), parts = exportWordParts(c.model)
        const xml = new DOMParser().parseFromString(new TextDecoder().decode(parts.get('word/document.xml')), 'application/xml')
        const runs = Array.from(xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'r'))
        if (runs.some(run => run.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'position').length)) throw Error(`${scenario}: empty run emitted ineffective custom position`)
        const marker = xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'pPr')[0]
        if (!marker?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'position').length) throw Error(`${scenario}: real paragraph marker was lost`)
        let reopened = importWordDocument(bytes)
        for (let save = 0; save < 3; save++) {
          if (reopened.paragraphs[0].runs[0].style.verticalAlign !== 'superscript' || reopened.paragraphs[0].runs[0].sourceVerticalAlign !== 'superscript') throw Error(`${scenario}: empty save did not restore named script`)
          reopened = importWordDocument(exportWordDocument(reopened))
        }
        results.push({ scenario, current: 25, reopened: 'superscript', bytes: Array.from(bytes) })
      }
      return results
    })
    for (const control of emptyOffsetControls) { fs.writeFileSync(path.join(output, `empty-offset-${control.scenario}.docx`), Uint8Array.from(control.bytes)); delete control.bytes }
    const markerStyles = '<w:style w:type="paragraph" w:styleId="Rich"><w:rPr><w:b/><w:u w:val="double"/><w:sz w:val="48"/><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="MarkerScript"><w:rPr><w:sz w:val="36"/><w:vertAlign w:val="subscript"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Plain12"><w:rPr><w:sz w:val="24"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Marker12"><w:rPr><w:sz w:val="24"/></w:rPr></w:style>'
    const markerBody = '<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="96"/><w:u w:val="double"/><w:shd w:val="clear" w:fill="13579B"/></w:rPr></w:pPr><w:r><w:rPr><w:b w:val="0"/><w:sz w:val="24"/></w:rPr><w:t>BODY</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="72"/><w:u w:val="double"/></w:rPr></w:pPr><w:r><w:rPr><w:b w:val="0"/><w:u w:val="none"/></w:rPr><w:t/></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Rich"/><w:rPr><w:b w:val="0"/><w:u w:val="none"/><w:vertAlign w:val="baseline"/></w:rPr></w:pPr></w:p>' +
      '<w:p><w:pPr><w:rPr><w:rStyle w:val="MarkerScript"/><w:vertAlign w:val="baseline"/></w:rPr></w:pPr></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Plain12"/><w:rPr><w:rStyle w:val="Marker12"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="48"/><w:i/><w:color w:val="0044AA"/></w:rPr><w:t>BODY</w:t></w:r></w:p>'
    const markerRoundTrip = await page.evaluate(async bytes => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        const [body, empty, cleared, named, equalBase] = model.paragraphs
        if (body.marker.style.fontSize !== 48 || body.marker.style.underline !== 'double' || body.marker.style.backgroundColor !== '#13579B') throw Error('Independent marker format lost')
        if (body.runs[0].style.fontSize !== 12 || body.runs[0].style.bold !== false || body.runs[0].style.underline !== undefined || body.sourceRun.fontSize === 48) throw Error('Marker polluted body or paragraph source')
        if (empty.runs[0].style.bold !== true || empty.runs[0].style.fontSize !== 36 || empty.runs[0].style.underline !== 'double') throw Error('Empty run overrode authoritative marker')
        if (cleared.marker.directStyle.bold !== false || cleared.marker.directStyle.underline !== false || cleared.marker.directStyle.verticalAlign !== 'baseline' || cleared.runs[0].style.fontSize !== 24) throw Error('Explicit marker reset lost inheritance provenance')
        if (named.marker.style.fontSize !== 18 || named.marker.directStyle.fontSize !== 18 || named.marker.sourceVerticalAlign !== 'subscript' || named.marker.directStyle.verticalAlign !== 'baseline' || named.runs[0].sourceVerticalAlign !== 'subscript') throw Error('Named marker script flattened into direct escapement')
        if (equalBase.marker.directStyle.fontSize !== 12 || equalBase.runs[0].style.fontSize !== 24) throw Error('Named marker size equal to paragraph base lost its explicit override')
        const controller = new WordController(model)
        controller.replaceText({ anchor: { paragraph: 1, offset: 0 }, focus: { paragraph: 1, offset: 0 } }, 'typed')
        if (controller.model.paragraphs[1].runs[0].style.fontSize !== 36 || controller.model.paragraphs[1].marker.style.underline !== 'double') throw Error('Empty marker did not survive actual model insertion')
        controller.replaceText({ anchor: { paragraph: 4, offset: 4 }, focus: { paragraph: 4, offset: 4 } }, 'X')
        const inserted = controller.model.paragraphs[4].runs.at(-1)
        if (inserted.style.fontSize !== 12 || inserted.style.italic !== true || inserted.style.color !== '#0044AA') throw Error('Sparse named marker failed to override size while preserving neighboring body properties')
        model = importWordDocument(exportWordDocument(model))
      }
      return Array.from(exportWordDocument(model))
    }, pack(fixture(markerBody, markerStyles)))
    const markerXML = strFromU8(unzipSync(Uint8Array.from(markerRoundTrip))['word/document.xml'])
    assert.match(markerXML, /<w:pPr>[^]*?<w:rPr>[^]*?<w:sz w:val="96"\/>[^]*?<w:u w:val="double"\/>[^]*?<\/w:rPr><\/w:pPr>/)
    assert.match(markerXML, /<w:rStyle w:val="IndependentScriptsubscript"\/><w:sz w:val="36"\/><w:vertAlign w:val="baseline"\/>/)
    fs.writeFileSync(path.join(output, 'paragraph-markers.docx'), Uint8Array.from(markerRoundTrip))
    const styles = `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/><w:b/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:styleId="Base" w:default="1"><w:name w:val="Base"/><w:pPr><w:jc w:val="right"/></w:pPr><w:rPr><w:b/><w:i/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Base"/><w:rPr><w:b/><w:color w:val="123ABC"/></w:rPr></w:style>
      <w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:i/></w:rPr></w:style>`
    const styleFixture = pack(fixture('<w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:b w:val="0"/></w:rPr><w:t>inherited</w:t></w:r><w:r><w:t>baseline</w:t></w:r></w:p><w:p><w:r><w:t>default paragraph style</w:t></w:r></w:p>', styles))
    const inherited = await page.evaluate(async bytes => (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)), styleFixture)
    assert.deepEqual(inherited.paragraphs[0].style, { align: 'right', spaceBefore: 0, spaceAfter: 4, widowControl: true, lineHeight: 1, lineHeightRule: 'auto' })
    assert.deepEqual(inherited.paragraphs[0].runs[0].style, { bold: false, italic: false, fontSize: 12, color: '#123ABC' })
    assert.equal(inherited.paragraphs[0].runs[1].style.bold, true)
    assert.equal(inherited.paragraphs[1].runs[0].style.bold, false)
    // Native Writer ignores underline on an unreferenced default character
    // style. An explicit rStyle or a basedOn reference still applies it.
    const underlineStyles = '<w:style w:type="character" w:styleId="DefaultCharacter" w:default="1"><w:rPr><w:u w:val="double"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="DerivedCharacter"><w:basedOn w:val="DefaultCharacter"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Single"><w:rPr><w:u w:val="single"/></w:rPr></w:style>'
    const underlineBody = '<w:p><w:r><w:t>implicit</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Single"/></w:pPr><w:r><w:t>paragraph single</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:rStyle w:val="DefaultCharacter"/></w:rPr><w:t>explicit double</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:rStyle w:val="DefaultCharacter"/><w:u w:val="none"/></w:rPr><w:t>explicit clear</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:rStyle w:val="DerivedCharacter"/></w:rPr><w:t>basedOn double</w:t></w:r></w:p>'
    await page.evaluate(async bytes => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        const expected = [undefined, true, 'double', false, 'double']
        model.paragraphs.forEach((paragraph, index) => {
          if (paragraph.runs[0].style.underline !== expected[index]) throw Error(`Underline inheritance changed at ${index}, save ${save}`)
        })
        if (model.paragraphs[0].sourceRun?.underline !== undefined) throw Error('Implicit default character underline leaked into paragraph base')
        if (model.paragraphs[3].runs[0].directStyle.underline !== false) throw Error('Explicit underline reset became inheritance')
        model = importWordDocument(exportWordDocument(model))
      }
    }, pack(fixture(underlineBody, underlineStyles)))
    const provenance = await page.evaluate(async bytes => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      const original = importWordDocument(Uint8Array.from(bytes)), reopened = importWordDocument(exportWordDocument(original))
      for (const model of [original, reopened]) {
        if (model.paragraphs[0].directStyle.align !== 'center') throw Error('Paragraph direct alignment provenance lost')
        if (model.paragraphs[0].sourceRun.bold !== true || model.paragraphs[0].runs[0].directStyle.bold !== undefined || model.paragraphs[0].runs[1].directStyle.italic !== true) throw Error('Inherited and direct styles lost their provenance')
        const next = model.paragraphs[0].nextParagraphStyle
        if (!next || next.run.fontSize !== 12 || next.run.bold === true) throw Error('Next paragraph style lost')
        if (model.paragraphs[1].runs[0].directStyle.fontSize !== undefined || model.paragraphs[1].sourceRun.fontSize !== 12) throw Error('Ordinary inherited size incorrectly became direct formatting')
      }
      const controller = new WordController(reopened)
      const end = reopened.paragraphs[0].runs.reduce((sum, run) => sum + run.text.length, 0)
      controller.replaceText({ anchor: { paragraph: 0, offset: end }, focus: { paragraph: 1, offset: 0 } }, '')
      const merged = importWordDocument(exportWordDocument(controller.model)), body = merged.paragraphs[0].runs.at(-1)
      if (merged.paragraphs.length !== 1 || body.text !== 'body' || body.style.fontSize !== 12 || body.style.bold !== false) throw Error('Merging paragraphs lost the moved run format after DOCX save')
      return true
    }, pack(fixture('<w:p><w:pPr><w:pStyle w:val="Heading"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Heading</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>emphasis</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>body</w:t></w:r></w:p>', '<w:style w:type="paragraph" w:styleId="Normal"><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading"><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="48"/><w:b/></w:rPr></w:style>')))
    assert.equal(provenance, true)
    const characterStyles = '<w:style w:type="paragraph" w:styleId="Super"><w:rPr><w:strike/><w:sz w:val="40"/><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Repeated"><w:basedOn w:val="Super"/><w:rPr><w:strike/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="SubDouble"><w:rPr><w:dstrike/><w:vertAlign w:val="subscript"/></w:rPr></w:style>'
    const characterBody = '<w:p><w:pPr><w:pStyle w:val="Repeated"/></w:pPr>' +
      '<w:r><w:t>inherited</w:t></w:r>' +
      '<w:r><w:rPr><w:i/><w:position w:val="0"/></w:rPr><w:t>zero position is no-op</w:t></w:r>' +
      '<w:r><w:rPr><w:strike w:val="false"/><w:dstrike w:val="false"/><w:position w:val="0"/><w:vertAlign w:val="baseline"/></w:rPr><w:t>reset</w:t></w:r>' +
      '<w:r><w:rPr><w:rStyle w:val="SubDouble"/></w:rPr><w:t>character style</w:t></w:r>' +
      '<w:r><w:rPr><w:dstrike w:val="false"/><w:strike/></w:rPr><w:t>single wins</w:t></w:r>' +
      '<w:r><w:rPr><w:dstrike/><w:strike w:val="false"/></w:rPr><w:t>double wins</w:t></w:r></w:p>'
    const characterRoundTrip = await page.evaluate(async bytes => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const models = [importWordDocument(Uint8Array.from(bytes))]
      for (let i = 0; i < 2; i++) models.push(importWordDocument(exportWordDocument(models.at(-1))))
      const byText = model => Object.fromEntries(model.paragraphs[0].runs.map(run => [run.text, { style: run.style, directStyle: run.directStyle, sourceVerticalAlign: run.sourceVerticalAlign }]))
      return { models: models.map(byText), bytes: Array.from(exportWordDocument(models[0])) }
    }, pack(fixture(characterBody, characterStyles)))
    for (const model of characterRoundTrip.models) {
      for (const name of ['inherited', 'zero position is no-op', 'single wins']) {
        assert.equal(model[name].style.strike, 'single')
        assert.equal(model[name].style.verticalAlign, 'superscript')
        assert.equal(model[name].style.fontSize, 20, 'Script does not rewrite the logical font size')
      }
      assert.equal(model.inherited.directStyle.strike, undefined)
      assert.equal(model['zero position is no-op'].directStyle.verticalAlign, undefined)
      assert.equal(model.reset.style.strike, 'none'); assert.equal(model.reset.directStyle.strike, 'none')
      assert.equal(model.reset.style.verticalAlign, 'baseline'); assert.equal(model.reset.directStyle.verticalAlign, 'baseline')
      assert.equal(model['character style'].style.strike, 'double'); assert.equal(model['character style'].directStyle.strike, 'double')
      assert.equal(model['character style'].style.verticalAlign, 'subscript'); assert.equal(model['character style'].directStyle.verticalAlign, undefined)
      assert.equal(model['character style'].sourceVerticalAlign, 'subscript')
      assert.equal(model['double wins'].style.strike, 'double')
    }
    const characterParts = unzipSync(Uint8Array.from(characterRoundTrip.bytes)), characterXML = strFromU8(characterParts['word/document.xml'])
    assert.match(characterXML, /<w:strike w:val="0"\/><w:dstrike w:val="0"\/><w:vertAlign w:val="baseline"\/>/)
    assert.match(characterXML, /<w:rStyle w:val="IndependentScriptsubscript"\/><w:strike w:val="0"\/><w:dstrike w:val="1"\/>/)
    assert.match(strFromU8(characterParts['word/styles.xml']), /w:type="character" w:styleId="IndependentScriptsubscript"[^]*?<w:vertAlign w:val="subscript"\/>/)
    fs.writeFileSync(path.join(output, 'character-format-round-trip.docx'), Uint8Array.from(characterRoundTrip.bytes))
    // Native Writer probe: paragraph chains, character chains and a character
    // style over a paragraph style all use the same strikeout enum semantics.
    const strikeInheritance = []
    for (const mode of ['paragraph', 'character', 'cross']) for (const [baseStrike, layer, expected] of [
      ['<w:strike/>', '<w:strike/>', 'single'],
      ['<w:dstrike/>', '<w:dstrike/>', 'double'],
      ['<w:strike/>', '<w:strike w:val="0"/>', 'none'],
      ['<w:dstrike/>', '<w:strike w:val="0"/>', 'none'],
      ['<w:strike/>', '<w:dstrike w:val="0"/>', 'none'],
      ['<w:dstrike/>', '<w:strike/>', 'single'],
      ['<w:strike/>', '<w:dstrike/>', 'double'],
    ]) {
      const baseType = mode === 'character' ? 'character' : 'paragraph', layerType = mode === 'paragraph' ? 'paragraph' : 'character'
      const definitions = `<w:style w:type="${baseType}" w:styleId="Base"><w:rPr>${baseStrike}</w:rPr></w:style>` +
        `<w:style w:type="${layerType}" w:styleId="Layer">${mode !== 'cross' ? '<w:basedOn w:val="Base"/>' : ''}<w:rPr>${layer}</w:rPr></w:style>`
      const body = `<w:p>${mode === 'paragraph' ? '<w:pPr><w:pStyle w:val="Layer"/></w:pPr>' : mode === 'cross' ? '<w:pPr><w:pStyle w:val="Base"/></w:pPr>' : ''}<w:r>${mode !== 'paragraph' ? '<w:rPr><w:rStyle w:val="Layer"/></w:rPr>' : ''}<w:t>strike style case</w:t></w:r></w:p>`
      strikeInheritance.push([`${mode} ${baseStrike} ${layer}`, pack(fixture(body, definitions)), expected])
    }
    await page.evaluate(async cases => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      for (const [name, bytes, expected] of cases) {
        const imported = importWordDocument(Uint8Array.from(bytes))
        for (const model of [imported, importWordDocument(exportWordDocument(imported))]) {
          if (model.paragraphs[0].runs[0].style.strike !== expected) throw Error(`Native strike inheritance differs: ${name}`)
        }
      }
    }, strikeInheritance)
    const scriptStyleDefinitions = '<w:style w:type="paragraph" w:styleId="Plain"><w:rPr><w:sz w:val="40"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="ParaSuper"><w:basedOn w:val="Plain"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading"><w:next w:val="Plain"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Super"><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Sub"><w:rPr><w:vertAlign w:val="subscript"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Baseline"><w:rPr><w:vertAlign w:val="baseline"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="DerivedSuper"><w:basedOn w:val="Super"/></w:style>'
    const scriptProvenanceCases = [
      ['Plain', 'Super', '', 'superscript', undefined],
      ['Plain', 'Super', '<w:vertAlign w:val="baseline"/>', 'superscript', 'baseline'],
      ['Plain', 'Super', '<w:vertAlign w:val="subscript"/>', 'superscript', 'subscript'],
      ['ParaSuper', 'Baseline', '', 'baseline', undefined],
      ['ParaSuper', 'Sub', '', 'subscript', undefined],
      ['Plain', 'DerivedSuper', '', 'superscript', undefined],
      ['Heading', 'Sub', '', 'subscript', undefined],
    ]
    const scriptProvenanceBody = scriptProvenanceCases.map(([paragraph, character, direct], i) => `<w:p><w:pPr><w:pStyle w:val="${paragraph}"/></w:pPr><w:r><w:rPr><w:rStyle w:val="${character}"/>${direct}</w:rPr><w:t>script${i}</w:t></w:r></w:p>`).join('')
    await page.evaluate(async ({ bytes, expected }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        for (let i = 0; i < expected.length; i++) {
          const source = expected[i][3], direct = expected[i][4], run = model.paragraphs[i].runs[0]
          if (run.sourceVerticalAlign !== source || run.directStyle.verticalAlign !== direct || run.style.verticalAlign !== (direct ?? source)) throw Error(`Character script provenance changed at save ${save}, paragraph ${i}`)
          const controller = new WordController(model), offset = model.paragraphs[i].runs.reduce((sum, run) => sum + run.text.length, 0)
          controller.replaceText({ anchor: { paragraph: i, offset }, focus: { paragraph: i, offset } }, '\n')
          const successor = controller.model.paragraphs[i + 1].runs[0]
          if (successor.sourceVerticalAlign !== source || successor.style.verticalAlign !== source || successor.directStyle.verticalAlign !== undefined) throw Error(`End Enter failed to restore named character script at save ${save}, paragraph ${i}`)
          const reopened = importWordDocument(exportWordDocument(controller.model)).paragraphs[i + 1].runs[0]
          if (reopened.sourceVerticalAlign !== source || reopened.style.verticalAlign !== source || reopened.directStyle.verticalAlign !== undefined) throw Error('Empty successor script provenance changed after saving')
        }
        model = importWordDocument(exportWordDocument(model))
      }
    }, { bytes: pack(fixture(scriptProvenanceBody, scriptStyleDefinitions)), expected: scriptProvenanceCases })
    const defaultScriptStyles = '<w:style w:type="character" w:styleId="DefaultScript" w:default="1"><w:rPr><w:b/><w:i/><w:sz w:val="36"/><w:color w:val="FF0000"/><w:dstrike/><w:u w:val="double"/><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="NoScript"/>'
    const defaultScriptBody = '<w:p><w:r><w:t>unreferenced default stays plain</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:rStyle w:val="NoScript"/></w:rPr><w:t>explicit style without script</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:vertAlign w:val="baseline"/></w:rPr><w:t>direct baseline</w:t></w:r></w:p><w:p/>' +
      '<w:p><w:r><w:rPr><w:rStyle w:val="DefaultScript"/></w:rPr><w:t>explicit default reference applies</w:t></w:r></w:p>'
    await page.evaluate(async bytes => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        for (let i = 0; i < model.paragraphs.length; i++) {
          const source = i === 4 ? 'superscript' : undefined, paragraph = model.paragraphs[i], run = paragraph.runs[0]
          if (run.sourceVerticalAlign !== source || paragraph.sourceRun.verticalAlign !== undefined) throw Error('Default character script leaked into the paragraph base')
          if (i < 4 && (run.style.bold === true || run.style.italic === true || run.style.fontSize === 18 || run.style.color === '#FF0000' || run.style.strike === 'double' || run.style.underline === 'double')) throw Error('Unreferenced default character attributes leaked into text')
          if (i === 4 && (run.style.fontSize !== 18 || run.style.bold !== true || run.style.strike !== 'double' || run.style.underline !== 'double')) throw Error('Explicit default character reference stopped applying')
          const controller = new WordController(model), offset = paragraph.runs.reduce((sum, run) => sum + run.text.length, 0)
          controller.replaceText({ anchor: { paragraph: i, offset }, focus: { paragraph: i, offset } }, '\n')
          const successor = controller.model.paragraphs[i + 1].runs[0]
          if ((successor.style.verticalAlign ?? 'baseline') !== (source ?? 'baseline') || successor.sourceVerticalAlign !== source) throw Error('Default character script inheritance changed after Enter')
        }
        model = importWordDocument(exportWordDocument(model))
      }
    }, pack(fixture(defaultScriptBody, defaultScriptStyles)))
    const highlightNames = ['none', 'black', 'blue', 'cyan', 'green', 'magenta', 'red', 'yellow', 'white', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray']
    const highlightPaletteBody = highlightNames.map(name => `<w:p><w:r><w:rPr><w:sz w:val="40"/><w:szCs w:val="24"/><w:highlight w:val="${name}"/><w:u w:val="single"/></w:rPr><w:t>${name} 中文 😀</w:t></w:r></w:p>`).join('') +
      '<w:p><w:r><w:rPr><w:highlight w:val="darkMagenta"/></w:rPr><w:t/></w:r></w:p>'
    const highlightPalette = await page.evaluate(async ({ bytes, colors }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      let model = importWordDocument(Uint8Array.from(bytes)), saved
      for (let save = 0; save < 3; save++) {
        colors.forEach((color, index) => {
          const run = model.paragraphs[index].runs[0]
          if (run.style.highlight !== color || run.directStyle.highlight !== color || run.style.fontSize !== 20 || run.style.fontSizeCs !== 12 || run.style.underline !== true) throw Error(`Highlight palette changed at save ${save}: ${color}`)
        })
        const empty = model.paragraphs.at(-1).runs[0]
        if (empty.text !== '' || empty.style.highlight !== 'darkMagenta' || empty.directStyle.highlight !== 'darkMagenta') throw Error('Empty highlighted run changed after saving')
        saved = exportWordDocument(model); model = importWordDocument(saved)
      }
      return Array.from(saved)
    }, { bytes: pack(fixture(highlightPaletteBody)), colors: highlightNames })
    const highlightXML = strFromU8(unzipSync(Uint8Array.from(highlightPalette))['word/document.xml'])
    assert.match(highlightXML, /<w:sz w:val="40"\/><w:szCs w:val="24"\/><w:highlight w:val="yellow"\/><w:u w:val="single"\/>/)
    assert.match(highlightXML, /<w:highlight w:val="none"\/>/)
    fs.writeFileSync(path.join(output, 'highlight-palette-round-trip.docx'), Uint8Array.from(highlightPalette))
    const highlightStyles = '<w:docDefaults><w:rPrDefault><w:rPr><w:highlight w:val="yellow"/></w:rPr></w:rPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:styleId="Green"><w:rPr><w:highlight w:val="green"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="InheritedGreen"><w:basedOn w:val="Green"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="NoHighlight"><w:basedOn w:val="Green"/><w:rPr><w:highlight w:val="none"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="DefaultBlue" w:default="1"><w:rPr><w:highlight w:val="blue"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="CharRed"><w:rPr><w:highlight w:val="red"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="CharNone"><w:basedOn w:val="CharRed"/><w:rPr><w:highlight w:val="none"/></w:rPr></w:style>'
    const highlightCases = [
      ['', '', '', 'yellow', undefined],
      ['InheritedGreen', '', '', 'green', undefined],
      ['NoHighlight', '', '', 'none', undefined],
      ['InheritedGreen', '', '<w:highlight w:val="none"/>', 'none', 'none'],
      ['InheritedGreen', '', '<w:highlight w:val="cyan"/>', 'cyan', 'cyan'],
      ['InheritedGreen', 'CharRed', '', 'green', undefined],
      ['InheritedGreen', 'CharNone', '', 'green', undefined],
      ['', 'CharRed', '', 'yellow', undefined],
    ]
    const highlightInheritanceBody = highlightCases.map(([paragraph, character, direct], i) => `<w:p>${paragraph ? `<w:pPr><w:pStyle w:val="${paragraph}"/></w:pPr>` : ''}<w:r><w:rPr>${character ? `<w:rStyle w:val="${character}"/>` : ''}${direct}</w:rPr><w:t>highlight${i}</w:t></w:r></w:p>`).join('') +
      '<w:p><w:pPr><w:pStyle w:val="InheritedGreen"/></w:pPr></w:p>'
    await page.evaluate(async ({ bytes, expected }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        expected.forEach(([, , , color, direct], index) => {
          const run = model.paragraphs[index].runs[0]
          if (run.style.highlight !== color || run.directStyle.highlight !== direct) throw Error(`Highlight inheritance changed at save ${save}, case ${index}`)
        })
        const empty = model.paragraphs.at(-1).runs[0]
        if (empty.text !== '' || empty.style.highlight !== 'green' || empty.directStyle.highlight !== undefined) throw Error('Empty paragraph lost its inherited highlight')
        const controller = new WordController(model), end = model.paragraphs[0].runs[0].text.length
        controller.replaceText({ anchor: { paragraph: 0, offset: end }, focus: { paragraph: 1, offset: 0 } }, '')
        const moved = importWordDocument(exportWordDocument(controller.model)).paragraphs[0].runs.at(-1)
        if (moved.text !== 'highlight1' || moved.style.highlight !== 'green' || moved.directStyle.highlight !== 'green') throw Error('Moving a green run under a yellow paragraph changed its appearance')
        model = importWordDocument(exportWordDocument(model))
      }
    }, { bytes: pack(fixture(highlightInheritanceBody, highlightStyles)), expected: highlightCases })
    await page.evaluate(async bytes => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      const controller = new WordController(importWordDocument(Uint8Array.from(bytes)))
      controller.replaceText({ anchor: { paragraph: 0, offset: 5 }, focus: { paragraph: 1, offset: 0 } }, '')
      let model = controller.model
      for (let save = 0; save < 3; save++) {
        const run = model.paragraphs[0].runs.at(-1)
        if (run.text !== 'plain' || run.style.highlight !== 'none' || run.directStyle.highlight !== 'none') throw Error('Moving plain text into a highlighted paragraph must emit an explicit none reset')
        model = importWordDocument(exportWordDocument(model))
      }
    }, pack(fixture('<w:p><w:pPr><w:pStyle w:val="Green"/></w:pPr><w:r><w:t>green</w:t></w:r></w:p><w:p><w:r><w:t>plain</w:t></w:r></w:p>', '<w:style w:type="paragraph" w:styleId="Green"><w:rPr><w:highlight w:val="green"/></w:rPr></w:style>')))
    const backgroundValues = [['000000', '#000000'], ['FFFFFF', '#FFFFFF'], ['aBc123', '#ABC123'], ['FF0000', '#FF0000'], ['auto', 'none']]
    const backgroundBody = backgroundValues.map(([fill], index) => `<w:p><w:r><w:rPr><w:sz w:val="40"/><w:highlight w:val="yellow"/><w:u w:val="single"/><w:shd w:val="clear" w:fill="${fill}"${index % 2 ? ' w:color="auto"' : ' w:color="00aAff"'}/><w:vertAlign w:val="superscript"/></w:rPr><w:t>background${index} 中文 😀</w:t></w:r></w:p>`).join('') +
      '<w:p><w:r><w:rPr><w:shd w:val="clear" w:fill="123456"/></w:rPr><w:t/></w:r></w:p>'
    const backgroundRoundTrip = await page.evaluate(async ({ bytes, values }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        values.forEach(([, color], index) => {
          const run = model.paragraphs[index].runs[0]
          if (run.style.backgroundColor !== color || run.directStyle.backgroundColor !== color || run.style.highlight !== 'yellow' || run.style.underline !== true || run.style.verticalAlign !== 'superscript' || run.style.fontSize !== 20) throw Error(`Background value or coexisting format changed at save ${save}: ${color}`)
        })
        const empty = model.paragraphs.at(-1).runs[0]
        if (empty.text !== '' || empty.style.backgroundColor !== '#123456' || empty.directStyle.backgroundColor !== '#123456') throw Error('Empty direct background changed after saving')
        const controller = new WordController(model)
        controller.formatText({ anchor: { paragraph: 2, offset: 0 }, focus: { paragraph: 2, offset: model.paragraphs[2].runs[0].text.length } }, { highlight: 'none' })
        const revealed = importWordDocument(exportWordDocument(controller.model)).paragraphs[2].runs[0]
        if (revealed.style.highlight !== 'none' || revealed.style.backgroundColor !== '#ABC123') throw Error('Clearing highlight destroyed the independent background')
        model = importWordDocument(exportWordDocument(model))
      }
      return Array.from(exportWordDocument(model))
    }, { bytes: pack(fixture(backgroundBody)), values: backgroundValues })
    const backgroundXML = strFromU8(unzipSync(Uint8Array.from(backgroundRoundTrip))['word/document.xml'])
    assert.match(backgroundXML, /<w:highlight w:val="yellow"\/><w:u w:val="single"\/><w:shd w:val="clear" w:fill="ABC123"\/><w:vertAlign w:val="superscript"\/>/)
    assert.match(backgroundXML, /<w:shd w:val="clear" w:fill="auto"\/>/)
    assert.doesNotMatch(backgroundXML, /<w:shd[^>]*w:color=/)
    fs.writeFileSync(path.join(output, 'background-round-trip.docx'), Uint8Array.from(backgroundRoundTrip))
    const backgroundStyles = '<w:style w:type="paragraph" w:styleId="Red"><w:rPr><w:shd w:val="clear" w:fill="FF0000"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="InheritedRed"><w:basedOn w:val="Red"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="NoBackground"><w:basedOn w:val="Red"/><w:rPr><w:shd w:val="clear" w:fill="auto"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="DefaultBlue" w:default="1"><w:rPr><w:shd w:val="clear" w:fill="0000FF"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="CharGreen"><w:rPr><w:shd w:val="clear" w:fill="00FF00"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="InheritedGreen"><w:basedOn w:val="CharGreen"/></w:style>' +
      '<w:style w:type="character" w:styleId="CharNone"><w:basedOn w:val="CharGreen"/><w:rPr><w:shd w:val="clear" w:fill="auto"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="CharPlain"/>' +
      '<w:style w:type="character" w:styleId="DerivedDefault"><w:basedOn w:val="DefaultBlue"/></w:style>'
    const backgroundCases = [
      ['', '', '', undefined, undefined],
      ['Red', '', '', '#FF0000', undefined],
      ['InheritedRed', '', '', '#FF0000', undefined],
      ['NoBackground', '', '', 'none', undefined],
      ['Red', '', '<w:shd w:val="clear" w:fill="auto"/>', 'none', 'none'],
      ['Red', '', '<w:shd w:val="clear" w:fill="ABC123"/>', '#ABC123', '#ABC123'],
      ['Red', 'CharGreen', '', '#00FF00', '#00FF00'],
      ['Red', 'InheritedGreen', '', '#00FF00', '#00FF00'],
      ['Red', 'CharNone', '', 'none', 'none'],
      ['Red', 'CharPlain', '', '#FF0000', undefined],
      ['', 'DefaultBlue', '', '#0000FF', '#0000FF'],
      ['Red', 'DefaultBlue', '', '#0000FF', '#0000FF'],
      ['Red', 'CharGreen', '<w:shd w:val="clear" w:fill="auto"/>', 'none', 'none'],
      ['', 'CharGreen', '', '#00FF00', '#00FF00'],
      ['Red', 'CharNone', '<w:shd w:val="clear" w:fill="FFFFFF"/>', '#FFFFFF', '#FFFFFF'],
      ['Red', 'DerivedDefault', '', '#0000FF', '#0000FF'],
    ]
    const backgroundInheritanceBody = backgroundCases.map(([paragraph, character, direct], index) => `<w:p>${paragraph ? `<w:pPr><w:pStyle w:val="${paragraph}"/></w:pPr>` : ''}<w:r><w:rPr>${character ? `<w:rStyle w:val="${character}"/>` : ''}${direct}</w:rPr><w:t>background${index}</w:t></w:r></w:p>`).join('') +
      '<w:p><w:pPr><w:pStyle w:val="InheritedRed"/></w:pPr></w:p><w:p/>'
    await page.evaluate(async ({ bytes, expected }) => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      for (let save = 0; save < 3; save++) {
        expected.forEach(([, , , color, direct], index) => {
          const run = model.paragraphs[index].runs[0]
          if (run.style.backgroundColor !== color || run.directStyle.backgroundColor !== direct) throw Error(`Background inheritance changed at save ${save}, case ${index}: ${JSON.stringify(run)}`)
        })
        const inheritedEmpty = model.paragraphs.at(-2).runs[0], plainEmpty = model.paragraphs.at(-1).runs[0]
        if (inheritedEmpty.text !== '' || inheritedEmpty.style.backgroundColor !== '#FF0000' || inheritedEmpty.directStyle.backgroundColor !== undefined) throw Error('Empty paragraph lost its inherited background')
        if (plainEmpty.text !== '' || plainEmpty.style.backgroundColor !== undefined) throw Error('Implicit default character background appeared on an empty paragraph')
        model = importWordDocument(exportWordDocument(model))
      }
    }, { bytes: pack(fixture(backgroundInheritanceBody, backgroundStyles)), expected: backgroundCases })
    const backgroundMergeCases = [
      ['plain', '', 'none'],
      ['green', '<w:pPr><w:pStyle w:val="Green"/></w:pPr>', '#00FF00'],
    ]
    await page.evaluate(async cases => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const { WordController } = await import('/src/word/core/model.ts')
      for (const [bytes, text, color] of cases) {
        const controller = new WordController(importWordDocument(Uint8Array.from(bytes)))
        controller.replaceText({ anchor: { paragraph: 0, offset: 3 }, focus: { paragraph: 1, offset: 0 } }, '')
        let model = controller.model
        for (let save = 0; save < 3; save++) {
          const run = model.paragraphs[0].runs.at(-1)
          if (run.text !== text || run.style.backgroundColor !== color || run.directStyle.backgroundColor !== color) throw Error(`Merged text changed background at save ${save}: ${text}`)
          model = importWordDocument(exportWordDocument(model))
        }
      }
    }, backgroundMergeCases.map(([text, properties, color]) => [pack(fixture(`<w:p><w:pPr><w:pStyle w:val="Red"/></w:pPr><w:r><w:t>red</w:t></w:r></w:p><w:p>${properties}<w:r><w:t>${text}</w:t></w:r></w:p>`, '<w:style w:type="paragraph" w:styleId="Red"><w:rPr><w:shd w:val="clear" w:fill="FF0000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Green"><w:rPr><w:shd w:val="clear" w:fill="00FF00"/></w:rPr></w:style>')), text, color]))
    const nativeBackground = await page.evaluate(async bytes => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      let model = importWordDocument(Uint8Array.from(bytes))
      const snapshot = document => document.paragraphs.map(paragraph => paragraph.runs.map(run => [run.text, run.style.backgroundColor, run.style.highlight]))
      const original = JSON.stringify(snapshot(model)), colored = model.paragraphs.flatMap(paragraph => paragraph.runs).filter(run => run.style.backgroundColor && run.style.backgroundColor !== 'none').length
      const expected = [['#123456', 'yellow'], ['#ABCDEF', 'none'], ['none', 'cyan'], ['none', 'none'], ['#13579B', 'magenta']]
      if (model.paragraphs.length !== expected.length) throw Error('Native combined layers fixture changed its paragraphs')
      expected.forEach(([backgroundColor, highlight], index) => {
        if (model.paragraphs[index].runs.some(run => (run.style.backgroundColor ?? 'none') !== backgroundColor || (run.style.highlight ?? 'none') !== highlight)) throw Error(`Native combined layers changed at paragraph ${index}`)
      })
      for (let save = 0; save < 2; save++) {
        model = importWordDocument(exportWordDocument(model))
        if (JSON.stringify(snapshot(model)) !== original) throw Error('Original native character background changed after saving')
      }
      return { name: 'unmodified native combined-layers.docx', coloredRuns: colored, paragraphs: model.paragraphs.length }
    }, Array.from(fs.readFileSync(path.join(root, 'tests/compatibility/independent-word-background/libreoffice/combined-layers.docx'))))
    const emptyNumberingXML = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="none"/><w:suff w:val="nothing"/><w:lvlText w:val=""/><w:lvlJc w:val="start"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="0"/></w:tabs><w:ind w:start="0" w:hanging="0"/></w:pPr><w:rPr/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`
    const numberingFixture = (xml, referenced) => withPart(
      fixture(`<w:p>${referenced ? '<w:pPr><w:pStyle w:val="NoNumbering"/></w:pPr>' : ''}<w:r><w:t>neutral numbering container</w:t></w:r></w:p>`, referenced ? '<w:style w:type="paragraph" w:styleId="NoNumbering"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>' : ''),
      'word/numbering.xml', xml, `${R}/numbering`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml')
    const nativeHighlightBytes = Array.from(fs.readFileSync(path.join(root, 'tests/compatibility/independent-word-highlight/libreoffice/highlight.docx')))
    const neutralNumbering = await page.evaluate(async cases => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts'), results = []
      const text = model => model.paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n')
      for (const [name, bytes] of cases) {
        let model = importWordDocument(Uint8Array.from(bytes)); const original = text(model)
        for (let save = 0; save < 2; save++) {
          model = importWordDocument(exportWordDocument(model))
          if (text(model) !== original) throw Error(`Neutral numbering container changed document text: ${name}`)
        }
        results.push({ name, paragraphs: model.paragraphs.length })
      }
      return results
    }, [['unused empty numbering rPr', pack(numberingFixture(emptyNumberingXML, false))], ['style-referenced empty numbering rPr', pack(numberingFixture(emptyNumberingXML, true))], ['unmodified native highlight DOCX with empty numbering rPr', nativeHighlightBytes]])
    const base = fixture(), negative = [
      ['table', fixture('<w:tbl/>')], ['image', fixture('<w:p><w:r><w:drawing/></w:r></w:p>')],
      ['revision', fixture('<w:p><w:ins><w:r><w:t>x</w:t></w:r></w:ins></w:p>')],
      ['RTL paragraph', fixture('<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:t>text</w:t></w:r></w:p>')],
      ['complex script', fixture('<w:p><w:r><w:t>مرحبا</w:t></w:r></w:p>')],
      ['character-count paragraph indent', fixture('<w:p><w:pPr><w:ind w:startChars="20"/></w:pPr></w:p>')],
      ['numbering', fixture('<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:p>')],
      ['field', fixture('<w:p><w:r><w:instrText>DATE</w:instrText></w:r></w:p>')],
      ['paragraph marker wave underline', fixture('<w:p><w:pPr><w:rPr><w:u w:val="wave"/></w:rPr></w:pPr></w:p>')],
      ['paragraph marker missing style', fixture('<w:p><w:pPr><w:rPr><w:rStyle w:val="Missing"/></w:rPr></w:pPr></w:p>')],
      ['paragraph marker duplicate property', fixture('<w:p><w:pPr><w:rPr><w:b/><w:b/></w:rPr></w:pPr></w:p>')],
      ['paragraph marker unknown attribute', fixture('<w:p><w:pPr><w:rPr w:val="0"><w:b/></w:rPr></w:pPr></w:p>')],
      ['paragraph marker theme color', fixture('<w:p><w:pPr><w:rPr><w:color w:val="000000" w:themeColor="accent1"/></w:rPr></w:pPr></w:p>')],
      ['paragraph marker in used paragraph style', fixture('<w:p><w:pPr><w:pStyle w:val="Marker"/></w:pPr></w:p>', '<w:style w:type="paragraph" w:styleId="Marker"><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:style>')],
      ['paragraph marker in document defaults', fixture('<w:p/>', '<w:docDefaults><w:pPrDefault><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:pPrDefault></w:docDefaults>')],
      ['theme font', fixture('<w:p><w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr><w:t>x</w:t></w:r></w:p>')],
      ['partial font regions', fixture('<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>中文x</w:t></w:r></w:p>')],
      ['unknown spacing', fixture('<w:p><w:pPr><w:spacing w:beforeAutospacing="1"/></w:pPr></w:p>')],
      ['fractional kerning half-points', fixture('<w:p><w:r><w:rPr><w:kern w:val="1.5"/></w:rPr><w:t>x</w:t></w:r></w:p>')],
      ['unknown text decoration', fixture('<w:p><w:r><w:rPr><w:outline/></w:rPr><w:t>x</w:t></w:r></w:p>')],
      ...[
        ['missing underline style', '<w:u/>'],
        ['unknown underline style', '<w:u w:val="unknown"/>'],
        ['case-sensitive underline style', '<w:u w:val="Double"/>'],
        ['word-only underline', '<w:u w:val="words"/>'],
        ['wavy underline', '<w:u w:val="wave"/>'],
        ['dotted underline', '<w:u w:val="dotted"/>'],
        ['malformed RGB underline color', '<w:u w:val="double" w:color="FF000"/>'],
        ['automatic underline color', '<w:u w:val="double" w:color="auto"/>'],
        ['theme underline color', '<w:u w:val="double" w:themeColor="accent1"/>'],
        ['theme underline tint', '<w:u w:val="double" w:themeTint="80"/>'],
        ['duplicate underline style', '<w:u w:val="double"/><w:u w:val="none"/>'],
        ['nested underline format', '<w:u w:val="double"><w:b/></w:u>'],
        ['unknown highlight color', '<w:highlight w:val="orange"/>'],
        ['case-sensitive highlight color', '<w:highlight w:val="Yellow"/>'],
        ['RGB highlight color', '<w:highlight w:val="FFFF00"/>'],
        ['missing highlight color', '<w:highlight/>'],
        ['duplicate highlight', '<w:highlight w:val="yellow"/><w:highlight w:val="none"/>'],
        ['highlight theme attribute', '<w:highlight w:val="yellow" w:themeColor="accent1"/>'],
        ['nested highlight content', '<w:highlight w:val="yellow"><w:b/></w:highlight>'],
        ['patterned run shading', '<w:shd w:val="pct15" w:fill="FFFF00"/>'],
        ['solid patterned run shading', '<w:shd w:val="solid" w:fill="FFFF00"/>'],
        ['nil run shading with fill', '<w:shd w:val="nil" w:fill="FFFF00"/>'],
        ['nil run shading without fill', '<w:shd w:val="nil"/>'],
        ['missing shading pattern', '<w:shd w:fill="FFFF00"/>'],
        ['missing shading fill', '<w:shd w:val="clear"/>'],
        ['short shading color', '<w:shd w:val="clear" w:fill="FFF"/>'],
        ['alpha shading color', '<w:shd w:val="clear" w:fill="FFFFFF80"/>'],
        ['named shading color', '<w:shd w:val="clear" w:fill="yellow"/>'],
        ['hash-prefixed shading color', '<w:shd w:val="clear" w:fill="#FFFF00"/>'],
        ['case-sensitive auto shading', '<w:shd w:val="clear" w:fill="Auto"/>'],
        ['malformed shading foreground', '<w:shd w:val="clear" w:fill="FFFF00" w:color="blue"/>'],
        ['theme shading fill', '<w:shd w:val="clear" w:fill="FFFF00" w:themeFill="accent1"/>'],
        ['theme shading foreground', '<w:shd w:val="clear" w:fill="FFFF00" w:themeColor="accent1"/>'],
        ['theme shading tint', '<w:shd w:val="clear" w:fill="FFFF00" w:themeFillTint="80"/>'],
        ['duplicate shading', '<w:shd w:val="clear" w:fill="FFFF00"/><w:shd w:val="clear" w:fill="auto"/>'],
        ['nested shading content', '<w:shd w:val="clear" w:fill="FFFF00"><w:b/></w:shd>'],
        ['conflicting strikes', '<w:strike/><w:dstrike/>'],
        ['reverse conflicting strikes', '<w:dstrike/><w:strike/>'],
        ['invalid strike boolean', '<w:strike w:val="yes"/>'],
        ['invalid double strike boolean', '<w:dstrike w:val="2"/>'],
        ['duplicate vertical alignment', '<w:vertAlign w:val="superscript"/><w:vertAlign w:val="baseline"/>'],
        ['unknown vertical alignment', '<w:vertAlign w:val="super"/>'],
        ['missing vertical alignment', '<w:vertAlign/>'],
        ['foreign vertical alignment attribute', '<w:vertAlign w:val="baseline" extra="0"/>'],
        ['positive baseline offset without resolved font size', '<w:position w:val="2"/>'],
        ['negative baseline offset without resolved font size', '<w:position w:val="-2"/>'],
        ['positive baseline offset outside supported percent range', '<w:sz w:val="24"/><w:position w:val="25"/>'],
        ['negative baseline offset outside supported percent range', '<w:sz w:val="24"/><w:position w:val="-25"/>'],
        ['fractional baseline offset', '<w:position w:val="0.0"/>'],
        ['custom text scaling', '<w:w w:val="58"/>'],
        ['script with baseline offset without resolved font size', '<w:vertAlign w:val="superscript"/><w:position w:val="1"/>'],
      ].map(([name, properties]) => [name, fixture(`<w:p><w:r><w:rPr>${properties}</w:rPr><w:t>x</w:t></w:r></w:p>`)]),
      ['page break', fixture('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')],
      ['duplicate property', fixture('<w:p><w:r><w:rPr><w:b/><w:b w:val="0"/></w:rPr></w:r></w:p>')],
      ['body namespace spoof', changed(base, 'word/document.xml', source => source.replace(W, 'urn:fake-word'))],
      ['child namespace spoof', fixture('<w:p><w:r><fake:t xmlns:fake="urn:fake-word">hidden</fake:t></w:r></w:p>')],
      ['attribute namespace spoof', fixture('<w:p><w:r><w:rPr><w:b fake:val="0" xmlns:fake="urn:fake-word"/></w:rPr></w:r></w:p>')],
      ['relationship namespace spoof', changed(base, '_rels/.rels', source => source.replace(PR, 'urn:fake-package'))],
      ['content type namespace spoof', changed(base, '[Content_Types].xml', source => source.replace(CT, 'urn:fake-types'))],
      ['missing main relationship', changed(base, '_rels/.rels', () => rels(''))],
      ['duplicate main relationship', changed(base, '_rels/.rels', () => rels(rel(`${R}/officeDocument`, 'word/document.xml') + rel(`${R}/officeDocument`, 'word/document.xml', 'r2')))],
      ['macro type', changed(base, '[Content_Types].xml', source => source.replace(mainType, 'application/vnd.ms-word.document.macroEnabled.main+xml'))],
      ['external relationship', changed(base, '_rels/.rels', () => rels(rel(`${R}/officeDocument`, 'https://example.com/document.xml', 'r1', 'TargetMode="External"')))],
      ['traversal relationship', changed(base, '_rels/.rels', () => rels(rel(`${R}/officeDocument`, '../../outside.xml')))],
      ['header relationship', { ...base, 'word/_rels/document.xml.rels': strToU8(rels(rel(`${R}/header`, 'header1.xml'))) }],
      ['unrecognized extra part', { ...base, 'word/settings.xml': strToU8(`<w:settings xmlns:w="${W}"><w:evenAndOddHeaders/></w:settings>`) }],
      ['DTD in unknown part', { ...base, 'custom.xml': strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>') }],
      ['malformed XML', changed(base, 'word/document.xml', source => source.slice(0, -5))],
      ['next style chain', fixture('<w:p><w:pPr><w:pStyle w:val="A"/></w:pPr></w:p>', '<w:style w:type="paragraph" w:styleId="A"><w:next w:val="B"/></w:style><w:style w:type="paragraph" w:styleId="B"><w:next w:val="C"/></w:style><w:style w:type="paragraph" w:styleId="C"/>')],
      ['style cycle', fixture('<w:p><w:pPr><w:pStyle w:val="Loop"/></w:pPr></w:p>', '<w:style w:type="paragraph" w:styleId="Loop"><w:basedOn w:val="Loop"/></w:style>')],
      ['unsupported used style', fixture('<w:p><w:pPr><w:pStyle w:val="Fancy"/></w:pPr></w:p>', '<w:style w:type="paragraph" w:styleId="Fancy"><w:rPr><w:shadow/></w:rPr></w:style>')],
      ['malformed ignored character highlight', fixture('<w:p><w:r><w:rPr><w:rStyle w:val="Fancy"/></w:rPr><w:t>x</w:t></w:r></w:p>', '<w:style w:type="character" w:styleId="Fancy"><w:rPr><w:highlight w:val="orange"/></w:rPr></w:style>')],
      ['unknown default', fixture('<w:p/>', '<w:docDefaults><w:rPrDefault><w:rPr><w:rtl/></w:rPr></w:rPrDefault></w:docDefaults>')],
      ['paragraph shading', fixture('<w:p><w:pPr><w:shd w:val="clear" w:fill="FFFF00"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>')],
      ['document default shading', fixture('<w:p/>', '<w:docDefaults><w:rPrDefault><w:rPr><w:shd w:val="clear" w:fill="FFFF00"/></w:rPr></w:rPrDefault></w:docDefaults>')],
      ['document default shading reset', fixture('<w:p/>', '<w:docDefaults><w:rPrDefault><w:rPr><w:shd w:val="clear" w:fill="auto"/></w:rPr></w:rPrDefault></w:docDefaults>')],
      ['malformed implicit default character shading', fixture('<w:p/>', '<w:style w:type="character" w:styleId="InvalidDefault" w:default="1"><w:rPr><w:shd w:val="nil"/></w:rPr></w:style>')],
    ].map(([name, parts]) => [name, pack(parts)])
    for (const [name, xml, referenced] of [
      ['visible decimal numbering with empty rPr', emptyNumberingXML.replace('w:numFmt w:val="none"', 'w:numFmt w:val="decimal"'), true],
      ['unused visible bullet numbering with empty rPr', emptyNumberingXML.replace('w:numFmt w:val="none"', 'w:numFmt w:val="bullet"'), false],
      ['numbering label with empty rPr', emptyNumberingXML.replace('w:lvlText w:val=""', 'w:lvlText w:val="%1"'), true],
      ['numbering suffix with empty rPr', emptyNumberingXML.replace('w:suff w:val="nothing"', 'w:suff w:val="space"'), true],
      ['nonempty numbering rPr', emptyNumberingXML.replace('<w:rPr/>', '<w:rPr><w:highlight w:val="yellow"/></w:rPr>'), true],
      ['numbering rPr with unknown attribute', emptyNumberingXML.replace('<w:rPr/>', '<w:rPr w:val="none"/>'), true],
      ['indented numbering with empty rPr', emptyNumberingXML.replace('w:start="0"', 'w:start="360"'), true],
    ]) negative.push([name, pack(numberingFixture(xml, referenced))])
    const customNS = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
    const customMime = 'application/vnd.openxmlformats-officedocument.custom-properties+xml'
    const settingsMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'
    const emptyCustom = withPart(fixture(), 'docProps/custom.xml', `<Properties xmlns="${customNS}"/>`, `${R}/custom-properties`, customMime, true)
    await page.evaluate(async bytes => (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)), pack(emptyCustom))
    negative.push(['nonempty custom properties', pack(withPart(fixture(), 'docProps/custom.xml', `<Properties xmlns="${customNS}"><property/></Properties>`, `${R}/custom-properties`, customMime, true))])
    negative.push(['unsupported setting', pack(withPart(fixture(), 'word/settings.xml', `<w:settings xmlns:w="${W}"><w:mirrorMargins/></w:settings>`, `${R}/settings`, settingsMime))])
    negative.push(['enabled auto hyphenation', pack(withPart(fixture(), 'word/settings.xml', `<w:settings xmlns:w="${W}"><w:autoHyphenation/></w:settings>`, `${R}/settings`, settingsMime))])
    negative.push(['embedded font', pack(withPart(fixture(), 'word/fontTable.xml', `<w:fonts xmlns:w="${W}"><w:font w:name="Arial"><w:embedRegular/></w:font></w:fonts>`, `${R}/fontTable`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'))])
    negative.push(['theme resource reference', pack(withPart(fixture(), 'word/theme/theme1.xml', '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + R + '"><a:blip r:embed="r1"/></a:theme>', `${R}/theme`, 'application/vnd.openxmlformats-officedocument.theme+xml'))])
    const corrupted = zipSync(base, { level: 0 }); const documentText = strToU8('中文')
    const offset = Buffer.from(corrupted).indexOf(Buffer.from(documentText)); assert.ok(offset > 0); corrupted[offset] ^= 1
    negative.push(['CRC mismatch', Array.from(corrupted)])
    const forged = zipSync(fixture(`<w:p><w:r><w:t>${'x'.repeat(50000)}</w:t></w:r></w:p>`))
    const forgedView = new DataView(forged.buffer, forged.byteOffset, forged.byteLength)
    for (let cursor = 0; cursor + 46 < forged.length; cursor++) {
      if (forgedView.getUint32(cursor, true) === 0x02014b50) {
        const length = forgedView.getUint16(cursor + 28, true), name = strFromU8(forged.subarray(cursor + 46, cursor + 46 + length))
        if (name === 'word/document.xml') { const local = forgedView.getUint32(cursor + 42, true); forgedView.setUint32(cursor + 24, 10, true); forgedView.setUint32(local + 22, 10, true) }
      }
    }
    negative.push(['forged expanded ZIP size', Array.from(forged)])
    const rejections = await page.evaluate(async cases => {
      const { importWordDocument } = await import('/src/word/core/docx.ts'), results = []
      for (const [name, bytes] of cases) {
        let message; try { importWordDocument(Uint8Array.from(bytes)) } catch (error) { message = error.message }
        if (!message || !message.includes('完整文字编辑器')) throw Error(`Expected explicit safe rejection: ${name}: ${message}`)
        results.push(name)
      }
      return results
    }, negative)
    const corpus = ['plain-text', 'explicit-styles', 'headings', 'unicode-breaks'].map(name => [name, Array.from(fs.readFileSync(path.join(root, 'tests/compatibility/independent-word/libreoffice', `${name}.docx`)))])
    const nativeChecks = await page.evaluate(async corpus => {
      const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts')
      const results = []
      for (const [name, bytes] of corpus) {
        try {
          const imported = importWordDocument(Uint8Array.from(bytes))
          imported.paragraphs[0].runs.push({ ...structuredClone(imported.paragraphs[0].runs.at(-1)), text: ' edited 中文 😀' })
          const saved = exportWordDocument(imported), reopened = importWordDocument(saved)
          if (imported.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n') !== reopened.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n')) throw Error('text changed')
          results.push({ name, ok: true, paragraphs: imported.paragraphs.length, bytes: Array.from(saved) })
        } catch (error) { throw Error(`${name}: ${error.message}`) }
      }
      return results
    }, corpus)
    for (const result of nativeChecks) { fs.writeFileSync(path.join(output, `libreoffice-${result.name}-edited.docx`), Uint8Array.from(result.bytes)); delete result.bytes }
    assert.deepEqual(officeRequests, []); assert.deepEqual(pageErrors, [])
    const report = { ok: true, checks: [...roundTrip.checks, 'Empty numeric offsets with named scripts export reopenable empty runs and independent real markers', 'Fifteen native baseline offset controls preserve signed percentage, explicit size and compound precedence through three saves', 'Twelve RGB underline mode/color controls survive three saves with independent text and strike color semantics', 'Raw kerning half-points including 1 survive three saves without changing text', 'Independent ZIP/XML readback validates actual OOXML, no private JSON format', 'Paragraph markers remain independent of body runs; empty insertion, explicit resets and named script provenance survive three saves', 'Defaults, basedOn, b/i style toggles and direct false overrides resolve correctly', 'Regional fonts, languages, kerning, line spacing and paragraph pagination properties survive', 'Paragraph and run direct formatting provenance plus next paragraph style survive saving', 'Merged paragraphs preserve moved runs against the new style base after DOCX save', 'Superscript, subscript, single/double strike and explicit resets survive inheritance and two saves with the logical size intact', 'All 17 highlight values, eight inheritance cases, explicit none resets, empty runs and paragraph merges survive two saves; character-style highlights stay ignored', 'Standard RGB/auto character backgrounds, explicit resets, 16 inheritance cases and paragraph merges survive two saves; implicit default-character shading stays ignored and document-default shading is rejected', 'Empty numbering rPr in explicit no-numbering levels is accepted, including unmodified native highlight DOCX; visible numbering and nonempty properties stay rejected', 'Four unmodified native LibreOffice DOCX fixtures import, edit and reopen independently', `${rejections.length} malformed / unsupported / spoofed / corrupted packages explicitly refused`, 'Zero Office runtime requests'], rejections, kerningControls, underlineColorControls, baselineControls, emptyOffsetControls, highlightChecks: { paletteValues: highlightNames.length, inheritanceCases: highlightCases.length, additionalMergeCases: 1, additionalNegativeCases: 8 }, backgroundChecks: { directValues: backgroundValues.length, inheritanceCases: backgroundCases.length, mergeCases: backgroundMergeCases.length, negativeCases: 22, native: nativeBackground }, neutralNumbering, nativeChecks, officeRequests, pageErrors }
    report.productBefore = productBefore; report.productAfter = hashes()
    assert.deepEqual(report.productBefore, report.productAfter, 'Codec sources changed during validation')
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2))
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
