/** Reassemble PyMuPDF font spans without inventing breaks inside a text line. */
export function pdfReadbackText(blocks: readonly { id?: string; text: string }[]): string {
  const lines: string[] = []
  let previousLine: string | null = null
  for (const block of blocks) {
    // The backend's stable ID is page:block:line:span. Unknown IDs are kept
    // separate rather than guessing geometry, sorting text, or losing content.
    const match = typeof block.id === 'string' ? /^(\d+:\d+:\d+):\d+$/.exec(block.id) : null
    const line = match?.[1] ?? null
    if (line !== null && line === previousLine && lines.length) lines[lines.length - 1] += block.text
    else lines.push(block.text)
    previousLine = line
  }
  return lines.join('\n')
}
