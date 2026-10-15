import { REQUIRED_GRIDCRAFT_CHECKS, GRIDCRAFT_SMOKE_LIMITATIONS, GRIDCRAFT_SMOKE_TEXT } from '../../scripts/gridcraft-native-smoke.mjs';
import { gridcraftXlsx } from './gridcraft-smoke-fixture.mjs';

// Verifier contract fixture, deliberately not sufficient for installed-asset
// evidence: release checks also bind source + installed files + WebView bytes.
export function gridcraftReport() {
  const xlsxBase64 = gridcraftXlsx();
  return {
    schemaVersion: 1, kind: 'gridcraft-native', engine: 'gridcraft-wasm', transport: 'local-wasm-in-native-webview', ok: true,
    checks: [...REQUIRED_GRIDCRAFT_CHECKS], limitations: [...GRIDCRAFT_SMOKE_LIMITATIONS],
    cleanup: { attempted: 2, closed: 2, ok: true, remainingCanvas: 0, remainingInput: 0 },
    canvas: { width: 1280, height: 800, sheetCount: 1, paintCalls: 42 },
    domInput: { eventType: 'input', isTrusted: false, text: GRIDCRAFT_SMOKE_TEXT, accepted: true },
    resources: { wasmLoaded: true, sameOrigin: true, wasmPath: '/gridcraft/gridcraft_bg.wasm',
      manifestSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64), upstreamCommit: 'e6b6b349708ab4978cb3f061f6bd6ecbc25667cb',
      files: { 'gridcraft.js': { sha256: 'c'.repeat(64), bytes: 5000 }, 'gridcraft_bg.wasm': { sha256: 'd'.repeat(64), bytes: 80000000 } } },
    format: { bold: true }, formula: { input: '=SUM(B1:B2)', value: 42, inputs: [12, 30] },
    failures: { staleSaveRejected: true, invalidOpenRejected: true, preserved: true },
    text: GRIDCRAFT_SMOKE_TEXT, reopenedText: GRIDCRAFT_SMOKE_TEXT, xlsxBase64, reopenedXlsxBase64: xlsxBase64,
  };
}
