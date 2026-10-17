import { createHash } from 'node:crypto';
import { WORKFLOW_NATIVE_CHECKS, WORKFLOW_NATIVE_LIMITATIONS, CANVAS_TEXT, DIAGRAM_SOURCE, INITIAL_DIAGRAM_SOURCE, EXPECTED_STYLE } from '../../scripts/workflow-native-smoke.mjs';

const bytes = model => { const data = Buffer.from(JSON.stringify(model, null, 2)); return { base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'), size: data.length }; };
// Validator fixture only; this is never installed-app or native process evidence.
export function workflowReport() {
  const documents = ['canvas', 'diagram'].map((kind, index) => {
    const model = { format: 'open-workflow', version: 1, id: `doc-${kind}`, title: `native-${kind}`, kind: kind === 'canvas' ? 'board' : 'mermaid',
      scene: { elements: [], background: '#ffffff', grid: true, defaultStyle: { ...EXPECTED_STYLE } },
      source: kind === 'canvas' ? '' : INITIAL_DIAGRAM_SOURCE, diagramStyle: 'classic', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z' };
    const initial = bytes(model), documentId = index * 2 + 1, revision = kind === 'canvas' ? 2 : 1;
    const text = kind === 'canvas' ? CANVAS_TEXT : DIAGRAM_SOURCE;
    const visibleText = kind === 'canvas' ? CANVAS_TEXT : '原生代码图表 本地保存与重开';
    model.updatedAt = '2026-10-17T00:00:01.000Z';
    if (kind === 'canvas') model.scene.elements.push({ id: 'canvas-text-node', type: 'shape', shape: 'text', x: 200, y: 160, width: 180, height: 54,
      text, style: { ...EXPECTED_STYLE, fill: 'transparent' }, locked: false });
    else model.source = text;
    const final = bytes(model), targetId = `approved-native-${kind}-file`;
    return { kind,
      editing: { text, inputEvents: 1, doubleClickEvents: kind === 'canvas' ? 1 : 0, visibleText,
        before: { documentId, revision: 0, dirty: false }, after: { documentId, revision, dirty: true } },
      persistence: { targetId, initialBase64: initial.base64, initialSha256: initial.sha256, initialSizeBytes: initial.size,
        readbackBase64: final.base64, finalSha256: final.sha256, finalSizeBytes: final.size, dialogObserved: false,
        saved: { documentId, revision, dirty: false }, saves: [{ documentId: targetId, extension: 'owflow', expectedSha256: initial.sha256, saveAs: false,
          status: 'saved', savedId: targetId, savedKind: kind, savedSha256: final.sha256, savedSizeBytes: final.size }] },
      reopened: { keyChanged: true, fileId: targetId, kind, sha256: final.sha256, snapshot: { documentId: documentId + 1, revision: 0, dirty: false },
        exportedBase64: final.base64, text, visibleText }, cleanup: { closedDocuments: 2 } };
  });
  return { schemaVersion: 1, kind: 'workflow-native', transport: 'native-webview-ipc', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...WORKFLOW_NATIVE_CHECKS], limitations: [...WORKFLOW_NATIVE_LIMITATIONS],
    documents, cleanup: { closedDocuments: 4 } };
}
