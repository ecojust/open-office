import { createHash } from 'node:crypto';
import { WORKSPACE_NATIVE_CHECKS, WORKSPACE_NATIVE_LIMITATIONS, WORKSPACE_BASELINE_TEXT, WORKSPACE_SAVED_TEXT } from '../../scripts/workspace-native-smoke.mjs';
import { wordDocx } from './office-word-smoke-fixture.mjs';
import { sheetReport } from './office-sheet-smoke-report.mjs';
import { presentationReport } from './office-presentation-smoke-report.mjs';
import { pdfReport } from './pdf-smoke-report.mjs';

const digest = base64 => {
  const bytes = Buffer.from(base64, 'base64');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
};
export function workspaceDocx(text) {
  return wordDocx(parts => { parts['word/document.xml'] = parts['word/document.xml'].replace('OfficeWord Native 中文😀', text); });
}

// Contract fixtures only. These cannot supply the installed app, real process,
// signed artifact, native runtime asset hashes, or macOS OS-input proof.
export function workspaceReport() {
  const baseline = workspaceDocx(WORKSPACE_BASELINE_TEXT), saved = workspaceDocx(WORKSPACE_SAVED_TEXT);
  const initial = digest(baseline), final = digest(saved), targetId = 'approved-native-smoke-file';
  const formats = [['docx', 'word', baseline], ['xlsx', 'sheet', sheetReport().reopenedXlsxBase64],
    ['pptx', 'presentation', presentationReport().reopenedPptxBase64], ['pdf', 'pdf', pdfReport().reopenedPdfBase64]]
    .map(([extension, kind, base64]) => ({ id: `native-smoke-${extension}`, kind, extension, version: 1, ...digest(base64), base64 }));
  return {
    schemaVersion: 1, kind: 'workspace-native', transport: 'native-webview-ipc-and-loopback-http', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...WORKSPACE_NATIVE_CHECKS], limitations: [...WORKSPACE_NATIVE_LIMITATIONS],
    server: {
      before: { running: false, revision: 0, lanUrlsCount: 0 }, started: { running: true, revision: 0, lanUrlsCount: 1 },
      status: { running: true, revision: 0, lanUrlsCount: 1 }, formats,
      http: { schemaVersion: 1, execution: 'native-tcp', documentId: 'native-smoke-docx', initialVersion: 1, acceptedVersion: 2,
        initialSha256: initial.sha256, acceptedSha256: final.sha256,
        assetIndex: true, wasmRange: true, stateRead: true, documentRead: true, writeAccepted: true, staleWriteRejected: true, readback: true, wrongOriginRejected: true,
        indexStatus: 200, rangeStatus: 206, stateStatus: 200, documentStatus: 200, writeStatus: 200, staleWriteStatus: 409, readbackStatus: 200, wrongOriginStatus: 403,
        indexBytes: 2000, indexSha256: 'a'.repeat(64), rangeBytes: 8 },
      httpReadback: { id: 'native-smoke-docx', version: 2, ...final },
      stopped: { running: false, revision: 5, lanUrlsCount: 0 }, stoppedStatus: { running: false, revision: 5, lanUrlsCount: 0 },
    },
    autosave: { intervalMs: 30_000, elapsedMs: 30_200, targetId, initialSha256: initial.sha256, initialSizeBytes: initial.sizeBytes,
      finalSha256: final.sha256, finalSizeBytes: final.sizeBytes, readbackBase64: saved, beforeRevision: 3, afterRevision: 3,
      beforeDirty: true, afterDirty: false, focusRetained: true, blurEvents: 0, dialogObserved: false,
      reopenedText: WORKSPACE_SAVED_TEXT, expectedText: WORKSPACE_SAVED_TEXT,
      saves: [{ documentId: targetId, extension: 'docx', expectedSha256: initial.sha256, saveAs: false,
        status: 'saved', savedId: targetId, savedSha256: final.sha256, savedSizeBytes: final.sizeBytes }],
    },
    cleanup: { serverStopped: true, oldLinkRevoked: true, temporaryFilesRemoved: true, closedDocuments: 2 },
  };
}
