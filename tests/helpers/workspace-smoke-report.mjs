import { createHash } from 'node:crypto';
import { WORKSPACE_NATIVE_CHECKS, WORKSPACE_NATIVE_LIMITATIONS, WORKSPACE_BASELINE_TEXT, WORKSPACE_SAVED_TEXT } from '../../scripts/workspace-native-smoke.mjs';
import { wordDocx } from './office-word-smoke-fixture.mjs';

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
  return {
    schemaVersion: 2, kind: 'workspace-native', transport: 'native-webview-ipc', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...WORKSPACE_NATIVE_CHECKS], limitations: [...WORKSPACE_NATIVE_LIMITATIONS],
    autosave: { intervalMs: 30_000, elapsedMs: 30_200, targetId, initialBase64: baseline, initialSha256: initial.sha256, initialSizeBytes: initial.sizeBytes,
      finalSha256: final.sha256, finalSizeBytes: final.sizeBytes, readbackBase64: saved, beforeRevision: 3, afterRevision: 3,
      beforeDirty: true, afterDirty: false, focusRetained: true, blurEvents: 0, dialogObserved: false,
      reopenedText: WORKSPACE_SAVED_TEXT, expectedText: WORKSPACE_SAVED_TEXT,
      saves: [{ documentId: targetId, extension: 'docx', expectedSha256: initial.sha256, saveAs: false,
        status: 'saved', savedId: targetId, savedSha256: final.sha256, savedSizeBytes: final.sizeBytes }],
    },
    cleanup: { temporaryFilesRemoved: true, closedDocuments: 2 },
  };
}
