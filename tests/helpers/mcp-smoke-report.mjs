import { createHash } from 'node:crypto';
import { MCP_NATIVE_CHECKS, MCP_NATIVE_LIMITATIONS, MCP_NATIVE_TEXT } from '../../scripts/mcp-native-smoke.mjs';
import { workspaceDocx } from './workspace-smoke-report.mjs';
import { wordDocx } from './office-word-smoke-fixture.mjs';
import { sheetXlsx } from './office-sheet-smoke-fixture.mjs';
import { presentationPptx } from './office-presentation-smoke-fixture.mjs';
import { pdfBytes } from './pdf-smoke-report.mjs';
const exportReceipt = (base64, extension) => {
  const bytes = Buffer.from(base64, 'base64');
  return { base64, extension, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const jsonBase64 = value => Buffer.from(JSON.stringify(value)).toString('base64');

// Validator contract fixture only, never installed-app or native HTTP evidence.
export function mcpReport() {
  const base64 = workspaceDocx(MCP_NATIVE_TEXT), bytes = Buffer.from(base64, 'base64');
  const key = 'native-mcp-document', sessionId = '1'.repeat(64), port = 19780;
  const snapshot = { documentId: 17, revision: 1, dirty: true, text: MCP_NATIVE_TEXT };
  const probe = (name, value, httpSessionId = 'f'.repeat(64), service = { sessionId, port }) => ({
    ...service, httpSessionId,
    initialized: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } },
    catalog: { jsonrpc: '2.0', id: 2, result: { tools: [{ name }] } },
    response: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } },
  });
  const beforeBlocks = [{ index: 0, type: 'paragraph', text: MCP_NATIVE_TEXT, runs: [{ start: 0, end: 27, props: {} }] }];
  const afterBlocks = [{ index: 0, type: 'paragraph', text: MCP_NATIVE_TEXT, runs: [{ start: 0, end: 27, props: { bold: true, size: 22, color: { Rgb: [213,43,63] } } }] }];
  const note = { format: 'open-office-notebook', version: 2, id: 'native_mcp_notebook', title: 'MCP', sections: [{ id: 'native_mcp_section', title: 'MCP', pages: [{ id: 'native_mcp_page', title: 'MCP', regions: [{ id: 'native_mcp_region', x:40, y:50, width:480, blocks: [{ id: 'native_mcp_block', type: 'heading', level:2, content: [{ text: 'NATIVE_MCP_NOTE' }] }] }] }] }] };
  const canvas = { format: 'open-workflow', version: 1, id: 'native_mcp_canvas', kind: 'flow', title: 'MCP', scene: { elements: [{ id: 'native_mcp_shape', type: 'shape', shape: 'rectangle', x:40, y:40, width:280, height:100, text:'NATIVE_MCP_CANVAS' }] } };
  const diagram = { format: 'open-workflow', version:1, id:'native_mcp_diagram', kind:'mermaid', title:'MCP', source:'sequenceDiagram\n  Alice->>Bob: NATIVE_MCP_DIAGRAM', diagramStyle:'blueprint' };
  const wordExport = wordDocx(parts => { parts['word/document.xml'] = parts['word/document.xml'].replace('OfficeWord Native 中文😀', MCP_NATIVE_TEXT).replaceAll('val="32"', 'val="44"').replace('336699', 'D52B3F'); });
  const sheetExport = sheetXlsx(parts => { parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('Open Office 表格😀', 'NATIVE_MCP_SHEET').replace('<v>30</v>', '<v>29</v>'); });
  const presentationExport = presentationPptx(parts => { parts['ppt/slides/slide1.xml'] = parts['ppt/slides/slide1.xml'].replace('Open Office 演示😀', 'NATIVE_MCP_PRESENTATION'); });
  const specs = [
    ['word','word_execute_command','format.set','word_query','document.inspect',wordExport,'docx',{ blocks: afterBlocks }],
    ['sheet','sheet_execute_command','range.setValues','sheet_query','cell.get',sheetExport,'xlsx',{ cell:'A1', value:'NATIVE_MCP_SHEET' }],
    ['presentation','presentation_execute_command','shape.insert','presentation_query','slide.inspect',presentationExport,'pptx',{ shapes:[{ id:279,text:'NATIVE_MCP_PRESENTATION' }] }],
    ['pdf','pdf_execute_command','page_add_text','pdf_query','content_list',pdfBytes('NATIVE_MCP_PDF'),'pdf',{ result:{ items:[{ type:'text',text:'NATIVE_MCP_PDF' }] } }],
    ['note','note_edit',undefined,'note_read',undefined,jsonBase64(note),'oonote',note],
    ['canvas','canvas_edit',undefined,'canvas_read',undefined,jsonBase64(canvas),'owflow',canvas],
    ['diagram','diagram_update',undefined,'diagram_read',undefined,jsonBase64(diagram),'owflow',diagram],
  ];
  const editors = specs.map(([kind,editTool,command,queryTool,queryCommand,base64,extension,queried], index) => {
    const service = { sessionId: String(index + 1).repeat(64), port };
    const before = { documentId:17 + index, revision:index === 0 ? 1 : 0,dirty:index === 0 };
    const after = { ...before,revision:index === 0 ? 4 : 1,dirty:true };
    const actual = kind === 'word' ? { ...after,text:MCP_NATIVE_TEXT,format:{ bold:true,size:22,color:'D52B3F' } } : queried;
    const call = (tool,value) => probe(tool,value,'f'.repeat(64),service);
    return { kind,key:index === 0 ? key : 'native-mcp-' + kind,service,before,after,shellDirty:true,actual,
      ...(['note','canvas','diagram'].includes(kind) ? { visibleText:'NATIVE_MCP_' + kind.toUpperCase() } : {}),
      edit:{ tool:editTool,arguments:command ? { command } : {},probe:call(editTool,{ snapshot:{ ...after,revision:index === 0 ? 2 : 1 } }) },
      query:{ tool:queryTool,arguments:queryCommand ? { command:queryCommand } : {},probe:call(queryTool,queried) },
      exported:exportReceipt(base64,extension),
      ...(kind === 'word' ? { history:{
        select:call('word_select_text',{ ...before }),before:call('word_query',{ blocks:beforeBlocks }),
        undo:call('document_undo',{ ...after,revision:3 }),undone:call('word_query',{ blocks:beforeBlocks }),
        redo:call('document_redo',after),redone:call('word_query',queried),
      } } : {}),
    };
  });
  return {
    schemaVersion: 2, kind: 'mcp-native', transport: 'native-webview-ipc-http', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...MCP_NATIVE_CHECKS], limitations: [...MCP_NATIVE_LIMITATIONS],
    http: {
      write: probe('word_insert_text', snapshot, '2'.repeat(64)),
      read: probe('word_read', { text: MCP_NATIVE_TEXT, totalCharacters: MCP_NATIVE_TEXT.length, truncated: false }, '3'.repeat(64)),
    },
    document: { key, beforeDocumentId: 17, afterDocumentId: 17, beforeRevision: 0, afterRevision: 1,
      beforeText: '', afterText: MCP_NATIVE_TEXT, dirty: true, base64, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length },
    service: { sessionId, documentId: key, port, runningBefore: true, runningButton: true,
      switchedDocumentId: 'native-mcp-next-document', stoppedAfter: true, closedProbe: { port, closed: true } },
    editors,
    cleanup: { closedDocuments: 8, serviceStopped: true },
  };
}
