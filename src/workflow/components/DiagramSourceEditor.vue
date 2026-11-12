<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorSelection, EditorState, StateField } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { codeFolding, foldGutter, foldKeymap, foldService, foldedRanges, HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting, unfoldEffect } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { createDiagramLexState, diagramFoldRanges, sourceCoordinates, tokenizeDiagramLine, type DiagramToken } from '../core/diagram-source-language.ts'

const props = withDefaults(defineProps<{ modelValue: string; theme: 'light' | 'dark'; disabled?: boolean; error?: string; errorId?: string }>(), { disabled: false, error: '' })
const emit = defineEmits<{
  'update:modelValue': [value: string]; input: []; blur: []; selection: [selection: { start: number; end: number; head: number }]; compositionstart: []; compositionend: []
}>()
const container = ref<HTMLDivElement>()
let editor: EditorView | undefined, rawSource = props.modelValue, coordinates = sourceCoordinates(rawSource), applyingSource = false
let compositionTimer: ReturnType<typeof setTimeout> | undefined
const appearance = new Compartment(), editable = new Compartment(), attributes = new Compartment()
const syntax = StreamLanguage.define({
  startState: () => ({ protectedMembers: false, tokens: [] as DiagramToken[], tokenIndex: 0, lexical: createDiagramLexState() }),
  copyState: state => ({ ...state, lexical: { ...state.lexical } }),
  token(stream, state) {
    if (stream.sol()) {
      if (!state.lexical.quote && !state.lexical.labelClose && /^\s*(flowchart|graph)\b/.test(stream.string)) state.lexical.multiline = true
      if (!state.lexical.quote && !state.lexical.labelClose && /^\s*classDiagram\b/.test(stream.string)) state.protectedMembers = true
      state.tokens = tokenizeDiagramLine(stream.string, state.protectedMembers, state.lexical); state.tokenIndex = 0
    }
    while (state.tokens[state.tokenIndex] && state.tokens[state.tokenIndex]!.to <= stream.pos) state.tokenIndex++
    const token = state.tokens[state.tokenIndex]
    if (!token) { stream.skipToEnd(); return null }
    stream.pos = token.to
    return token.kind
  },
  languageData: { commentTokens: { line: '#' } },
})
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, class: 'cm-keyword' }, { tag: tags.string, class: 'cm-string' },
  { tag: tags.number, class: 'cm-number' }, { tag: tags.comment, class: 'cm-comment' },
  { tag: tags.operator, class: 'cm-operator' }, { tag: tags.punctuation, class: 'cm-punctuation' },
  { tag: tags.variableName, class: 'cm-variableName' }, { tag: tags.typeName, class: 'cm-typeName' },
  { tag: tags.attributeName, class: 'cm-attributeName' }, { tag: tags.atom, class: 'cm-atom' },
])
const folding = StateField.define({
  create: state => new Map(diagramFoldRanges(state.doc.toString()).map(range => [range.lineStart, range])),
  update: (ranges, transaction) => transaction.docChanged ? new Map(diagramFoldRanges(transaction.newDoc.toString()).map(range => [range.lineStart, range])) : ranges,
})
function editorTheme() {
  const dark = props.theme === 'dark'
  return EditorView.theme({
    '&': { height: '100%', color: 'var(--ui-text, #273449)', backgroundColor: 'var(--ui-surface, #fff)', fontSize: '12px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '22px', overflow: 'auto' },
    '.cm-content': { padding: '12px 0', caretColor: dark ? '#e2e8f0' : '#172b4d', minHeight: '100%' },
    '.cm-line': { padding: '0 12px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: dark ? '#e2e8f0' : '#172b4d' },
    '.cm-gutters': { backgroundColor: 'var(--ui-bg, #f4f6fa)', color: 'var(--ui-muted, #64748b)', borderRight: '1px solid var(--ui-line, #e2e8f0)' },
    '.cm-gutterElement': { lineHeight: '22px' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 5px 0 8px', minWidth: '28px' },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: dark ? '#93c5fd10' : '#3577e509' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: dark ? '#315280' : '#dbeafe' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--ui-bg, #f4f6fa)', color: 'var(--ui-accent, #3577e5)', border: '1px solid var(--ui-line, #e2e8f0)', borderRadius: '3px', padding: '0 5px', margin: '0 3px', font: 'inherit', lineHeight: '16px', cursor: 'pointer' },
    '.cm-keyword': { color: dark ? '#c4b5fd' : '#7c3aed' },
    '.cm-string': { color: dark ? '#86efac' : '#15803d' },
    '.cm-number, .cm-atom': { color: dark ? '#fdba74' : '#b45309' },
    '.cm-comment': { color: dark ? '#94a3b8' : '#64748b', fontStyle: 'italic' },
    '.cm-operator': { color: dark ? '#fda4af' : '#be123c' },
    '.cm-punctuation': { color: dark ? '#cbd5e1' : '#475569' },
    '.cm-variableName': { color: dark ? '#93c5fd' : '#1d4ed8' },
    '.cm-typeName, .cm-attributeName': { color: dark ? '#67e8f9' : '#0e7490' },
  }, { dark })
}
function contentAttributes() {
  return EditorView.contentAttributes.of({ 'aria-label': '代码图表源码', 'data-testid': 'diagram-source', 'aria-invalid': String(Boolean(props.error)), ...(props.error && props.errorId ? { 'aria-describedby': props.errorId } : {}), spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' })
}
function syncSelection() {
  if (!editor) return
  const range = editor.state.selection.main
  emit('selection', { start: coordinates.toRaw(range.from), end: coordinates.toRaw(range.to), head: coordinates.toRaw(range.head) })
}
function focus(_options?: FocusOptions) { editor?.focus(); syncSelection() }
function setSelectionRange(start: number, end: number, direction: 'forward' | 'backward' | 'none' = 'none') {
  if (!editor) return
  const from = coordinates.toEditor(start), to = coordinates.toEditor(end), effects = []
  const folds = foldedRanges(editor.state).iter()
  while (folds.value) {
    if (folds.from <= to && folds.to >= from) effects.push(unfoldEffect.of({ from: folds.from, to: folds.to }))
    folds.next()
  }
  editor.dispatch({ selection: EditorSelection.single(direction === 'backward' ? to : from, direction === 'backward' ? from : to), effects, scrollIntoView: true })
  syncSelection()
}
function scrollToStart() { if (editor) { editor.scrollDOM.scrollTop = 0; editor.scrollDOM.scrollLeft = 0 } }
onMounted(() => {
  editor = new EditorView({ parent: container.value!, state: EditorState.create({
    doc: coordinates.normalized,
    extensions: [
      appearance.of(editorTheme()), editable.of([EditorView.editable.of(!props.disabled), EditorState.readOnly.of(props.disabled)]), attributes.of(contentAttributes()),
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), indentUnit.of('  '),
      syntax, syntaxHighlighting(highlighting), folding, foldService.of((state, from) => state.field(folding).get(from) ?? null),
      codeFolding({ placeholderDOM: (_view, onclick) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'cm-foldPlaceholder'; button.textContent = '…'; button.setAttribute('aria-label', '展开代码块'); button.title = '展开代码块'; button.onclick = onclick; return button
      } }),
      foldGutter({ openText: '⌄', closedText: '›' }),
      // History belongs to WorkflowSession, so source edits, styles and templates share undo.
      keymap.of([indentWithTab, ...foldKeymap, ...defaultKeymap]),
      EditorState.changeFilter.of(transaction => transaction.newDoc.length <= 500_000),
      EditorView.domEventHandlers({
        blur: () => { emit('blur') }, focus: () => { syncSelection() },
        compositionstart: () => { clearTimeout(compositionTimer); emit('compositionstart') },
        compositionend: () => { compositionTimer = setTimeout(() => { emit('compositionend') }, 0) },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !applyingSource) {
          const edits: Array<{ from: number; to: number; insert: string }> = []
          const newline = rawSource.match(/\r\n|\r|\n/)?.[0] ?? '\n'
          update.changes.iterChanges((from, to, _newFrom, _newTo, insert) => edits.push({ from: coordinates.toRaw(from), to: coordinates.toRaw(to), insert: insert.sliceString(0, insert.length, newline) }))
          for (const edit of edits.reverse()) rawSource = rawSource.slice(0, edit.from) + edit.insert + rawSource.slice(edit.to)
          coordinates = sourceCoordinates(rawSource)
          emit('update:modelValue', rawSource); emit('input')
        }
        if (update.selectionSet || update.docChanged || update.focusChanged) syncSelection()
      }),
    ],
  }) })
  syncSelection()
})
watch(() => props.modelValue, value => {
  if (value === rawSource) return
  rawSource = value; coordinates = sourceCoordinates(value)
  if (!editor || editor.state.doc.toString() === coordinates.normalized) { syncSelection(); return }
  applyingSource = true
  try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: coordinates.normalized } }) }
  finally { applyingSource = false }
})
watch(() => props.theme, () => editor?.dispatch({ effects: appearance.reconfigure(editorTheme()) }))
watch(() => props.disabled, disabled => editor?.dispatch({ effects: editable.reconfigure([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]) }))
watch(() => [props.error, props.errorId], () => editor?.dispatch({ effects: attributes.reconfigure(contentAttributes()) }))
onBeforeUnmount(() => { clearTimeout(compositionTimer); editor?.destroy(); editor = undefined })
defineExpose({ focus, setSelectionRange, scrollToStart, syncSelection, get value() { return rawSource }, get selectionStart() { return coordinates.toRaw(editor?.state.selection.main.from ?? 0) }, get selectionEnd() { return coordinates.toRaw(editor?.state.selection.main.to ?? 0) }, get selectionDirection() { const selection = editor?.state.selection.main; return selection && selection.head < selection.anchor ? 'backward' : 'forward' } })
</script>

<template><div ref="container" class="diagram-source-editor" /></template>

<style scoped>
.diagram-source-editor { flex: 1; width: 100%; min-width: 0; min-height: 0; overflow: hidden; }
</style>
