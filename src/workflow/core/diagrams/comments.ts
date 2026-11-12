/** Hash comments share these rules in the compiler and source editor.
 * Whole-line #comments are accepted; trailing comments use ` # comment`.
 * Class members such as #name retain their protected-visibility marker.
 */
interface CommentState { quote: string }

export function diagramHasBlockBraces(header: string): boolean {
  return /^\s*(?:classDiagram|stateDiagram(?:-v2)?|erDiagram|requirementDiagram|C4Context)\b/.test(header)
}

/** Flowchart arrows permit whitespace before a pipe-delimited label. */
export function isDiagramPipeLabelStart(line: string, index: number): boolean {
  let end = index
  while (end > 0 && /\s/.test(line[end - 1]!)) end--
  return /(?:<-->|<==>|<-.->|o--o|x--x|--o|--x|<--|<==|-->|---|==>|===|-\.->|-\.-|~~~)$/.test(line.slice(Math.max(0, end - 5), end))
}

function scanHashComment(line: string, preserveProtectedMembers: boolean, state: CommentState, bracesAreBlocks = false): number {
  const first = line.search(/\S/)
  if (!state.quote && first >= 0 && line[first] === '#' && (!preserveProtectedMembers || !line[first + 1] || /\s/.test(line[first + 1]!))) return first
  let escaped = false, pipeLabel = false
  const lastBrace = line.lastIndexOf('}')
  const brackets: string[] = []
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (state.quote) { if (char === state.quote) state.quote = ''; continue }
    if (char === '"' || (char === "'" && !/[\p{L}\p{N}]/u.test(line[index - 1] ?? '') && line.indexOf("'", index + 1) >= 0)) { state.quote = char; continue }
    // Existing Mermaid comments (including unsupported initialization directives)
    // belong to the existing parsers, and must not open quotes for the next line.
    if (char === '%' && line[index + 1] === '%' && !brackets.length && !pipeLabel) return -1
    if (char === '|' && (pipeLabel || isDiagramPipeLabelStart(line, index))) { pipeLabel = !pipeLabel; continue }
    if (pipeLabel) continue
    // A trailing open brace starts a block, whereas a paired brace can be a
    // flowchart label. Parentheses and brackets also contain literal label text.
    if (char === '[' || char === '(' || (char === '{' && !bracesAreBlocks && index < lastBrace)) brackets.push(char)
    else if (']})'.includes(char)) brackets.pop()
    if (char === '#' && !brackets.length && index > 0 && /\s/.test(line[index - 1]!) && (!line[index + 1] || /\s/.test(line[index + 1]!))) return index
  }
  return -1
}

export function hashCommentStart(line: string, preserveProtectedMembers = false, bracesAreBlocks = preserveProtectedMembers): number {
  return scanHashComment(line, preserveProtectedMembers, { quote: '' }, bracesAreBlocks)
}

/** Keep UTF-16 positions and line endings unchanged for diagnostics/source maps. */
export function maskHashComments(source: string): string {
  const header = source.split(/\r\n?|\n/).map(line => line.trim()).find(line => line && !line.startsWith('#') && !line.startsWith('%%')) ?? ''
  const preserveProtectedMembers = /^classDiagram(?:\s|$)/.test(header), state = { quote: '' }
  const multilineQuotes = /^(?:flowchart|graph)\s/.test(header)
  const bracesAreBlocks = diagramHasBlockBraces(header)
  let seenHeader = false
  return source.replace(/[^\r\n]+/g, line => {
    const start = scanHashComment(line, preserveProtectedMembers && seenHeader, state, bracesAreBlocks)
    if (!multilineQuotes) state.quote = ''
    if (start < 0 && line.trim() && !/^\s*%%/.test(line)) seenHeader = true
    else if (start > 0 && line.slice(0, start).trim()) seenHeader = true
    return start < 0 ? line : line.slice(0, start) + ' '.repeat(line.length - start)
  })
}
