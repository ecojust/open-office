import { REQUIRED_OFFICE_PRESENTATION_CHECKS, OFFICE_PRESENTATION_SMOKE_LIMITATIONS, OFFICE_PRESENTATION_SMOKE_TEXT } from '../../scripts/office-presentation-native-smoke.mjs';
import { presentationPptx, OFFICE_PRESENTATION_PDF } from './office-presentation-smoke-fixture.mjs';

// Verifier contract fixture, deliberately not sufficient for installed-asset
// evidence: release checks also bind source + installed files + WebView bytes.
export function presentationReport() {
  const pptxBase64 = presentationPptx();
  return {
    schemaVersion: 1, kind: 'office-presentation-native', engine: 'office-presentation-wasm', transport: 'local-wasm-in-native-webview', ok: true,
    checks: [...REQUIRED_OFFICE_PRESENTATION_CHECKS], limitations: [...OFFICE_PRESENTATION_SMOKE_LIMITATIONS],
    cleanup: { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 },
    canvas: { width: 1280, height: 800, slideCount: 2, paintCalls: 42 },
    domInput: { eventType: 'input', isTrusted: false, text: OFFICE_PRESENTATION_SMOKE_TEXT, accepted: true },
    resources: { wasmLoaded: true, sameOrigin: true, wasmPath: '/office-presentation/office-presentation_bg.wasm',
      manifestSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64), upstreamCommit: '9859da39255c0262cd592bb57101d7f2fa961f72',
      files: { 'office-presentation.js': { sha256: 'c'.repeat(64), bytes: 5000 }, 'office-presentation_bg.wasm': { sha256: 'd'.repeat(64), bytes: 80000000 } } },
    format: { bold: true }, slides: { count: 2, activeIndex: 0 },
    secondSlideText: 'Second slide 第二页', pdf: { pageCount: 2, textVerified: true }, pdfBase64: OFFICE_PRESENTATION_PDF,
    failures: { staleSaveRejected: true, invalidOpenRejected: true, preserved: true },
    text: OFFICE_PRESENTATION_SMOKE_TEXT, reopenedText: OFFICE_PRESENTATION_SMOKE_TEXT, pptxBase64, reopenedPptxBase64: pptxBase64,
  };
}
