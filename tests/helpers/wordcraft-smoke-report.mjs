import { REQUIRED_WORDCRAFT_CHECKS, WORDCRAFT_SMOKE_LIMITATIONS, WORDCRAFT_SMOKE_TEXT } from '../../scripts/wordcraft-native-smoke.mjs';
import { wordcraftDocx } from './wordcraft-smoke-fixture.mjs';

// Contract fixtures only: actual packaged acceptance must supply installed-file
// hashes and actual canvas exports; these are never accepted as release evidence.
export function wordcraftReport() {
  const docxBase64 = wordcraftDocx();
  return {
    schemaVersion: 1, kind: 'wordcraft-native', engine: 'wordcraft-wasm', transport: 'local-wasm-in-native-webview', ok: true,
    checks: [...REQUIRED_WORDCRAFT_CHECKS], limitations: [...WORDCRAFT_SMOKE_LIMITATIONS],
    cleanup: { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 },
    canvas: { width: 1280, height: 800, pageCount: 1, paintCalls: 42 },
    domInput: { eventType: 'input', isTrusted: false, text: WORDCRAFT_SMOKE_TEXT, accepted: true },
    resources: { wasmLoaded: true, sameOrigin: true, wasmPath: '/wordcraft/wordcraft_bg.wasm',
      manifestSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64), upstreamCommit: '3292ba05d3c15c003823be6849e87a1c6e205242',
      files: { 'wordcraft.js': { sha256: 'c'.repeat(64), bytes: 5000 }, 'wordcraft_bg.wasm': { sha256: 'd'.repeat(64), bytes: 80000000 } } },
    format: { bold: true, italic: true, underline: true, size: 16, color: '336699' },
    failures: { staleSaveRejected: true, invalidOpenRejected: true, preserved: true },
    text: WORDCRAFT_SMOKE_TEXT, reopenedText: WORDCRAFT_SMOKE_TEXT, docxBase64, reopenedDocxBase64: docxBase64,
  };
}
