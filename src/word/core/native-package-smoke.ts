import { isTauri, readWordPackage, writeWordPackage } from '../../native'
import { bytesToBase64 } from '../../shared/document'
import { exportWordDocument as exportBrowserDocument } from './docx'
import { createWordDocument, documentText, type TextStyle, type WordDocument } from './model'
import { exportWordDocument, importWordDocument } from './runtime'

/** Runs only after the process-enabled bootstrap scope has been checked by App.
 * No invoke replacement, file dialogs, Office engine, PDF process or UI edits.
 */
export interface NativeWordPackageSmokeReport {
  schemaVersion: 1
  kind: 'word-package-ipc'
  ok: boolean
  userAgent: string
  elapsedMs: number
  checks: string[]
  roundTrips: Array<{ docxBytes: number; text: string }>
  rejections: Array<{ check: string; error: string }>
  resources: { observed: number; forbidden: string[]; observation: string }
  formats?: Array<{ text: string; style: TextStyle; directStyle?: TextStyle }>
  error?: string
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(`Independent Word native IPC: ${message}`)
}

const firstText = '原文中文😀'
const secondText = '第二次保存中文😀 SECOND_SAVE_TOKEN'
const semanticKeys = ['fontSize', 'underline', 'strike', 'verticalAlign', 'highlight', 'backgroundColor'] as const
function selectedStyle(style: TextStyle): TextStyle {
  return Object.fromEntries(semanticKeys.flatMap(key => style[key] === undefined ? [] : [[key, style[key]]])) as TextStyle
}

function fixture(): WordDocument {
  const model = createWordDocument()
  model.paragraphs = [
    { id: 'ipc-body', style: {}, runs: [{ text: firstText, style: { fontSize: 12 } }] },
    { id: 'ipc-scripts', style: {}, runs: [
      { text: '上标中文😀', style: { fontSize: 18, underline: true, strike: 'double', verticalAlign: 'superscript', highlight: 'yellow', backgroundColor: '#13579B' } },
      { text: '下标中文😀', style: { fontSize: 14, strike: 'single', verticalAlign: 'subscript', highlight: 'cyan', backgroundColor: '#ABCDEF' } },
    ] },
    {
      id: 'ipc-clears', style: {},
      sourceRun: { fontSize: 18, strike: 'double', verticalAlign: 'superscript', highlight: 'yellow', backgroundColor: '#123456' },
      runs: [
        { text: '明确取消中文😀', style: { fontSize: 18, strike: 'none', verticalAlign: 'baseline', highlight: 'none', backgroundColor: 'none' },
          directStyle: { strike: 'none', verticalAlign: 'baseline', highlight: 'none', backgroundColor: 'none' } },
        { text: '取消高亮保留背景', style: { fontSize: 18, strike: 'double', verticalAlign: 'superscript', highlight: 'none', backgroundColor: '#FEDCBA' },
          directStyle: { highlight: 'none', backgroundColor: '#FEDCBA' } },
      ],
    },
  ]
  return model
}

function verifyModel(model: WordDocument, expected: WordDocument): void {
  assert(documentText(model) === documentText(expected), 'text changed during package round trip')
  assert(model.paragraphs.length === expected.paragraphs.length, 'paragraph count changed')
  for (const [index, paragraph] of expected.paragraphs.entries()) {
    const actual = model.paragraphs[index]!
    assert(actual.runs.length === paragraph.runs.length, `paragraph ${index} run count changed`)
    for (const [runIndex, run] of paragraph.runs.entries()) {
      const actualRun = actual.runs[runIndex]!
      assert(actualRun.text === run.text, `paragraph ${index} run ${runIndex} text changed`)
      for (const key of semanticKeys) if (run.style[key] !== undefined) {
        assert(actualRun.style[key] === run.style[key], `paragraph ${index} run ${runIndex} lost ${key}`)
      }
    }
  }
}

function observedResources(): NativeWordPackageSmokeReport['resources'] {
  const entries = performance.getEntriesByType('resource')
  const forbidden = entries.flatMap(entry => {
    const url = new URL(entry.name, location.href)
    if (!/\.wasm$/i.test(url.pathname) && !url.pathname.includes('/office-runtime/') && !url.pathname.endsWith('/office/host.html')) return []
    // Omit the random loopback secret prefix and query strings from diagnostics.
    return [url.pathname.replace(/^\/[a-f0-9]{64}\//, '/')]
  })
  return {
    observed: entries.length, forbidden: [...new Set(forbidden)],
    observation: 'Resource Timing entries since navigation; no Office host/runtime or .wasm request observed. This is not a network sandbox claim.',
  }
}

export async function runNativeWordPackageSmoke(): Promise<NativeWordPackageSmokeReport> {
  const started = performance.now()
  const report: NativeWordPackageSmokeReport = {
    schemaVersion: 1, kind: 'word-package-ipc', ok: false, userAgent: navigator.userAgent,
    elapsedMs: 0, checks: [], roundTrips: [], rejections: [],
    resources: { observed: 0, forbidden: [], observation: 'Not checked yet.' },
  }
  const passed = (name: string) => { report.checks.push(name) }
  async function rejects(name: string, action: () => Promise<unknown>, expected: string) {
    let rejection: unknown
    try { await action() } catch (error) { rejection = error }
    const error = rejection instanceof Error ? rejection.message : String(rejection ?? '')
    // A missing command or denied ACL must never count as a successful negative.
    assert(error === expected, `${name}: expected Rust validation error, received ${error.slice(0, 300) || 'success'}`)
    report.rejections.push({ check: name, error })
    passed(name)
  }
  try {
    assert(isTauri(), 'real Tauri IPC is required')
    passed('tauri-ipc-present')
    const expected = fixture()
    // Browser-written seed independently exercises Rust reading a ZIP from the
    // existing browser writer; all subsequent writes use the desktop runtime.
    let model = await importWordDocument(exportBrowserDocument(expected))
    verifyModel(model, expected)
    passed('browser-seed-rust-read')
    for (let cycle = 1; cycle <= 2; cycle++) {
      if (cycle === 2) {
        model.paragraphs[0]!.runs[0]!.text = secondText
        expected.paragraphs[0]!.runs[0]!.text = secondText
      }
      const bytes = await exportWordDocument(model)
      assert(bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b, 'native writer returned no DOCX ZIP')
      model = await importWordDocument(bytes)
      verifyModel(model, expected)
      report.roundTrips.push({ docxBytes: bytes.length, text: documentText(model) })
      passed(`native-roundtrip-${cycle}`)
    }
    assert(documentText(model).startsWith(secondText), 'the second edit did not persist')
    passed('second-edit-text')
    assert(model.paragraphs.every(paragraph => paragraph.runs.some(run => run.text.includes('中文😀'))), 'Chinese/emoji fixture was lost')
    passed('chinese-emoji-retained')
    // verifyModel already checked each property independently on both reopenings.
    passed('script-and-strike-retained')
    passed('highlight-background-retained')
    const cleared = model.paragraphs[2]!.runs[0]!
    assert(cleared.directStyle?.highlight === 'none' && cleared.directStyle.backgroundColor === 'none'
      && cleared.directStyle.strike === 'none' && cleared.directStyle.verticalAlign === 'baseline', 'explicit clearing overrides became inheritance')
    passed('explicit-clears-retained')
    report.formats = model.paragraphs.slice(1).flatMap(paragraph => paragraph.runs.map(run => ({
      text: run.text, style: selectedStyle(run.style),
      ...(run.directStyle !== undefined ? { directStyle: selectedStyle(run.directStyle) } : {}),
    })))
    await rejects('native-read-invalid-base64-rejected', () => readWordPackage('%%%'), 'DOCX ZIP Base64 编码无效。')
    await rejects('native-read-invalid-zip-rejected', () => readWordPackage(bytesToBase64(new TextEncoder().encode('not a zip'))), 'DOCX 文件为空、损坏或超过 16 MiB。')
    await rejects('native-write-invalid-base64-rejected', () => writeWordPackage([{ name: 'word/document.xml', dataBase64: '%%%' }]), 'DOCX ZIP 内容 Base64 编码无效。')
    await rejects('native-write-unsafe-name-rejected', () => writeWordPackage([{ name: '../escape.xml', dataBase64: 'eA==' }]), 'DOCX 包含越界或保留的 ZIP 路径。')
    await rejects('native-write-duplicate-name-rejected', () => writeWordPackage([
      { name: 'word/document.xml', dataBase64: 'eA==' }, { name: 'WORD/document.xml', dataBase64: 'eA==' },
    ]), 'DOCX ZIP 包含重复或大小写歧义的文件。')
    report.resources = observedResources()
    assert(report.resources.forbidden.length === 0, 'Office/WASM resources were requested')
    passed('no-office-wasm-resources')
    report.ok = true
  } catch (error) {
    report.error = String(error instanceof Error ? error.message : error).slice(0, 4000)
    report.resources = observedResources()
  } finally {
    report.elapsedMs = Math.round(performance.now() - started)
  }
  return report
}
