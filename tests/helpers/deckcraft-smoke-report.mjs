import { REQUIRED_DECKCRAFT_CHECKS, DECKCRAFT_SMOKE_LIMITATIONS, DECKCRAFT_SMOKE_TEXT } from '../../scripts/deckcraft-native-smoke.mjs';
import { deckcraftPptx, DECKCRAFT_PDF } from './deckcraft-smoke-fixture.mjs';

// Verifier contract fixture, deliberately not sufficient for installed-asset
// evidence: release checks also bind source + installed files + WebView bytes.
export function deckcraftReport() {
  const pptxBase64 = deckcraftPptx();
  return {
    schemaVersion: 1, kind: 'deckcraft-native', engine: 'deckcraft-wasm', transport: 'local-wasm-in-native-webview', ok: true,
    checks: [...REQUIRED_DECKCRAFT_CHECKS], limitations: [...DECKCRAFT_SMOKE_LIMITATIONS],
    cleanup: { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 },
    canvas: { width: 1280, height: 800, slideCount: 2, paintCalls: 42 },
    domInput: { eventType: 'input', isTrusted: false, text: DECKCRAFT_SMOKE_TEXT, accepted: true },
    resources: { wasmLoaded: true, sameOrigin: true, wasmPath: '/deckcraft/deckcraft_bg.wasm',
      manifestSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64), upstreamCommit: '9859da39255c0262cd592bb57101d7f2fa961f72',
      files: { 'deckcraft.js': { sha256: 'c'.repeat(64), bytes: 5000 }, 'deckcraft_bg.wasm': { sha256: 'd'.repeat(64), bytes: 80000000 } } },
    format: { bold: true }, slides: { count: 2, activeIndex: 0 },
    secondSlideText: 'Second slide 第二页', pdf: { pageCount: 2, textVerified: true }, pdfBase64: DECKCRAFT_PDF,
    failures: { staleSaveRejected: true, invalidOpenRejected: true, preserved: true },
    text: DECKCRAFT_SMOKE_TEXT, reopenedText: DECKCRAFT_SMOKE_TEXT, pptxBase64, reopenedPptxBase64: pptxBase64,
  };
}
