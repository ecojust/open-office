/** Bounded, deterministic text differences. Offsets use UTF-16, while matching
 * uses Unicode code points so a replacement never divides a surrogate pair.
 * Existing LF boundaries are structural: callers must handle adding/removing
 * paragraphs separately, rather than guessing whether LF meant a:p or a:br. */
export interface TextSplice { start: number; end: number; text: string }
type Step = { kind: 'equal' | 'delete' | 'insert'; text: string }
const LIMIT = 100000, WORK = 2000000, TRACE = 250000
function fail(): never { throw Error('本次文字变更过于复杂，请分几次修改；原文档未改变。') }

function difference(before: string, after: string, budget: { work: number; trace: number }): TextSplice[] {
  if (before === after) return []
  const a = Array.from(before), b = Array.from(after)
  let first = 0, lastA = a.length, lastB = b.length
  while (first < lastA && first < lastB && a[first] === b[first]) first++
  while (lastA > first && lastB > first && a[lastA - 1] === b[lastB - 1]) { lastA--; lastB-- }
  const offset = a.slice(0, first).join('').length, left = a.slice(first, lastA), right = b.slice(first, lastB)
  const characters = new Set(left)
  if (!left.length || !right.length || !right.some(character => characters.has(character))) return [{ start: offset, end: offset + left.join('').length, text: right.join('') }]
  const trace: Map<number, number>[] = [], frontier = new Map<number, number>([[1, 0]])
  let found = false
  for (let distance = 0; distance <= left.length + right.length; distance++) {
    budget.trace += frontier.size; if (budget.trace > TRACE) fail()
    trace.push(new Map(frontier))
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++budget.work > WORK) fail()
      const down = frontier.get(diagonal + 1) ?? -Infinity, across = frontier.get(diagonal - 1) ?? -Infinity
      let x = diagonal === -distance || diagonal !== distance && across < down ? down : across + 1
      let y = x - diagonal
      while (x < left.length && y < right.length && left[x] === right[y]) {
        if (++budget.work > WORK) fail()
        x++; y++
      }
      frontier.set(diagonal, x)
      if (x >= left.length && y >= right.length) { found = true; break }
    }
    if (found) break
  }
  if (!found) fail()
  let x = left.length, y = right.length
  const steps: Step[] = []
  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const previous = trace[distance]!, diagonal = x - y
    const down = previous.get(diagonal + 1) ?? -Infinity, across = previous.get(diagonal - 1) ?? -Infinity
    const previousDiagonal = diagonal === -distance || diagonal !== distance && across < down ? diagonal + 1 : diagonal - 1
    const previousX = previous.get(previousDiagonal) ?? 0, previousY = previousX - previousDiagonal
    while (x > previousX && y > previousY) { steps.push({ kind: 'equal', text: left[--x]! }); y-- }
    if (distance === 0) break
    if (x === previousX) steps.push({ kind: 'insert', text: right[--y]! })
    else steps.push({ kind: 'delete', text: left[--x]! })
  }
  const edits: TextSplice[] = []; let cursor = offset, pending: TextSplice | undefined
  for (const step of steps.reverse()) {
    if (step.kind === 'equal') { if (pending) edits.push(pending); pending = undefined; cursor += step.text.length; continue }
    pending ||= { start: cursor, end: cursor, text: '' }
    if (step.kind === 'delete') { cursor += step.text.length; pending.end = cursor }
    else pending.text += step.text
  }
  if (pending) edits.push(pending)
  return edits
}

export function textEditSplices(before: string, after: string): TextSplice[] {
  if (before.length > LIMIT || after.length > LIMIT) fail()
  const oldLines = before.split('\n'), newLines = after.split('\n')
  if (oldLines.length !== newLines.length) throw Error('这段文字包含独立格式或手动换行，暂不能增删换行；可在原有行内修改，原文档未改变。')
  const budget = { work: 0, trace: 0 }, output: TextSplice[] = []; let offset = 0
  oldLines.forEach((line, index) => {
    for (const edit of difference(line, newLines[index]!, budget)) output.push({ ...edit, start: edit.start + offset, end: edit.end + offset })
    offset += line.length + 1
  })
  return output
}
