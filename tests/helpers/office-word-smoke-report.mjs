import { REQUIRED_OFFICE_WORD_CHECKS, OFFICE_WORD_SMOKE_LIMITATIONS, OFFICE_WORD_SMOKE_TEXT } from '../../scripts/office-word-native-smoke.mjs';
import { wordDocx } from './office-word-smoke-fixture.mjs';

// Contract fixtures only: actual packaged acceptance must supply installed-file
// hashes and actual canvas exports; these are never accepted as release evidence.
export function wordReport() {
  const docxBase64 = wordDocx();
  return {
    schemaVersion: 1, kind: 'office-word-native', engine: 'office-word-wasm', transport: 'local-wasm-in-native-webview', ok: true,
    checks: [...REQUIRED_OFFICE_WORD_CHECKS], limitations: [...OFFICE_WORD_SMOKE_LIMITATIONS],
    cleanup: { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 },
    canvas: { width: 1280, height: 800, pageCount: 1, paintCalls: 42 },
    domInput: { eventType: 'input', isTrusted: false, text: OFFICE_WORD_SMOKE_TEXT, accepted: true },
    resources: { wasmLoaded: true, sameOrigin: true, wasmPath: '/office-word/office-word_bg.wasm',
      manifestSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64), upstreamCommit: '3292ba05d3c15c003823be6849e87a1c6e205242',
      files: { 'office-word.js': { sha256: 'c'.repeat(64), bytes: 5000 }, 'office-word_bg.wasm': { sha256: 'd'.repeat(64), bytes: 80000000 } } },
    format: { bold: true, italic: true, underline: true, size: 16, color: '336699' },
    failures: { staleSaveRejected: true, invalidOpenRejected: true, preserved: true },
    text: OFFICE_WORD_SMOKE_TEXT, reopenedText: OFFICE_WORD_SMOKE_TEXT, docxBase64, reopenedDocxBase64: docxBase64,
  };
}
