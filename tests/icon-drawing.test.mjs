import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { iconDrawing } from '../src/icons/drawing.ts'

test('shared filled artwork does not acquire an unintended outline in the shell', async () => {
  const drawing = iconDrawing(await readFile(new URL('../src/icons/svg/sheet/checkbox.svg', import.meta.url), 'utf8'))
  assert.equal(drawing.paint.stroke, 'none')
  assert.equal(drawing.paths[0].stroke, 'currentColor')
  assert.equal(drawing.paths[1].stroke, undefined)
  assert.equal(drawing.paths[1].fill, 'var(--ui-accent, #5b73e8)')
  assert.equal(drawing.paths[1].opacity, '.14')
})

test('SVG root and path paint opacities retain their separate inheritance levels', () => {
  const drawing = iconDrawing('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity=".5" stroke-opacity=".8"><path d="M2 2L4 4" stroke-opacity=".4" onload="alert(1)"/></svg>')
  assert.deepEqual(drawing.paint, { fill: 'none', stroke: 'currentColor', opacity: '.5', 'stroke-opacity': '.8' })
  assert.deepEqual(drawing.paths[0], { d: 'M2 2L4 4', 'stroke-opacity': '.4' })
})
