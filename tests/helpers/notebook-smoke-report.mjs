import { createHash } from 'node:crypto';
import { NOTEBOOK_NATIVE_CHECKS, NOTEBOOK_NATIVE_LIMITATIONS, NOTEBOOK_PAGE_TITLE, NOTEBOOK_PAGE_TEXT } from '../../scripts/notebook-native-smoke.mjs';

const bytes = model => { const data = Buffer.from(JSON.stringify(model)); return { base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'), size: data.length }; };
// Validator fixture only; it is never installed-app or native process evidence.
export function notebookReport() {
  const model = { format: 'open-office-notebook', version: 1, id: 'notebook', title: 'native-notebook', sections: [{ id: 'section', title: '日常笔记',
    pages: [{ id: 'page', title: '无标题页面', blocks: [{ id: 'block', type: 'paragraph', content: [] }] }] }] };
  const initial = bytes(model);
  model.sections[0].pages[0].title = NOTEBOOK_PAGE_TITLE;
  model.sections[0].pages[0].blocks[0].content = [{ text: NOTEBOOK_PAGE_TEXT }];
  const final = bytes(model), targetId = 'approved-native-notebook-file';
  return { schemaVersion: 1, kind: 'notebook-native', transport: 'native-webview-ipc', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...NOTEBOOK_NATIVE_CHECKS], limitations: [...NOTEBOOK_NATIVE_LIMITATIONS],
    editing: { title: NOTEBOOK_PAGE_TITLE, text: NOTEBOOK_PAGE_TEXT, titleInputEvents: 1, bodyInputEvents: 1,
      before: { documentId: 1, revision: 0, dirty: false }, after: { documentId: 1, revision: 2, dirty: true } },
    persistence: { targetId, initialBase64: initial.base64, initialSha256: initial.sha256, initialSizeBytes: initial.size,
      readbackBase64: final.base64, finalSha256: final.sha256, finalSizeBytes: final.size, dialogObserved: false,
      saved: { documentId: 1, revision: 2, dirty: false }, saves: [{ documentId: targetId, extension: 'oonote', expectedSha256: initial.sha256, saveAs: false,
        status: 'saved', savedId: targetId, savedSha256: final.sha256, savedSizeBytes: final.size }] },
    reopened: { keyChanged: true, fileId: targetId, sha256: final.sha256, snapshot: { documentId: 2, revision: 0, dirty: false }, exportedBase64: final.base64, title: NOTEBOOK_PAGE_TITLE, text: NOTEBOOK_PAGE_TEXT },
    cleanup: { closedDocuments: 2 } };
}
