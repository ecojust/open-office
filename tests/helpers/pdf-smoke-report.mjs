import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectInstalledPdf, pdfSourceHash, PDF_SMOKE_LIMITATIONS, REQUIRED_OFFICE_PDF_CHECKS } from '../../scripts/office-pdf-native-smoke.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
export function installPdfFixture(root, resourceRoot) {
  for (const path of ['scripts/build-office-pdf.mjs', 'scripts/build-office-icons.mjs', 'vendor/office-pdf/src/lib.rs',
    'assets/fonts/open-office/license.txt', 'assets/fonts/deck/license.txt', 'src/icons/test.svg']) {
    // Shared fixture files may already be used by the other editor manifests.
    write(join(root, path), `fixture: ${path}`);
  }
  const files = { 'office_pdf.js': Buffer.from('export const fixture=true;'), 'office_pdf.d.ts': Buffer.from('export const fixture:boolean;'),
    'office_pdf_bg.wasm': Buffer.from('0061736d01000000', 'hex'), 'office_pdf_bg.wasm.d.ts': Buffer.from('export const memory:WebAssembly.Memory;') };
  for (const [name, bytes] of Object.entries(files)) write(join(resourceRoot, 'frontend/office-pdf', name), bytes);
  const manifest = { engine: 'Open Office PDF', upstreamCommit: 'f65f7330418e8121ebe59c01003da899340ceee9', sourceHash: pdfSourceHash(root),
    target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129',
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)])), sizeBytes: 8 };
  write(join(resourceRoot, 'frontend/office-pdf/manifest.json'), JSON.stringify(manifest));
  return inspectInstalledPdf(resourceRoot, { root });
}

// Independently assembled PDF contract fixture; no editor serialization code.
export function pdfBytes(english = 'NEW_NATIVE_TEXT', chinese = '新的合同') {
  const hex = [...chinese].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${chinese.length} beginbfchar ${[...chinese].map(c => { const code = c.charCodeAt(0).toString(16).padStart(4, '0'); return `<${code}> <${code}>`; }).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const stream = `BT /F1 16 Tf 50 750 Td (${english}) Tj ET\nBT /F2 16 Tf 50 720 Td <${hex}> Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 8 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n', offsets = [0];
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString('base64');
}
export function pdfReport(installed) {
  const manifest = installed ? JSON.parse(installed.manifestText) : undefined;
  return {
    schemaVersion: 1, kind: 'pdf-native', engine: 'office-pdf-wasm', transport: 'local-wasm-in-native-webview', ok: true,
    checks: [...REQUIRED_OFFICE_PDF_CHECKS], limitations: [...PDF_SMOKE_LIMITATIONS],
    cleanup: { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 },
    canvas: { width: 1280, height: 800, pageCount: 1, paintCalls: 42 },
    resources: { wasmLoaded: true, sameOrigin: true, wasmPath: '/office-pdf/office_pdf_bg.wasm',
      manifestSha256: installed?.manifestSha256 || 'a'.repeat(64), sourceHash: manifest?.sourceHash || 'b'.repeat(64),
      upstreamCommit: 'f65f7330418e8121ebe59c01003da899340ceee9', files: installed ? Object.fromEntries(['office_pdf.js', 'office_pdf_bg.wasm'].map(name => [name, { ...installed.files[name] }]))
        : { 'office_pdf.js': { sha256: 'c'.repeat(64), bytes: 5000 }, 'office_pdf_bg.wasm': { sha256: 'd'.repeat(64), bytes: 80000000 } } },
    reopened: true, removedOldText: true, newTextPresent: true, text: 'NEW_NATIVE_TEXT 新的合同', metadata: { pageCount: 1 },
    undoRedo: { undo: true, redo: true }, failures: { staleSaveRejected: true, invalidOpenRejected: true, preserved: true },
    pdfBase64: pdfBytes(), reopenedPdfBase64: pdfBytes(),
  };
}
