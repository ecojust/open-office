import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDrawingColorTransforms as transform, drawingPercentage, scRgbColor } from '../src/presentation/core/color-transforms.ts'

const mod = (name, value) => ({ name, value: String(value) })

test('DrawingML percentages accept both standard integer and strict percent lexical values', () => {
  assert.equal(drawingPercentage('50000'), .5)
  assert.equal(drawingPercentage('50%'), .5)
  assert.equal(drawingPercentage('+12.5%'), .125)
  assert.equal(drawingPercentage('-25000'), -.25)
  for (const raw of ['', '1e5', 'NaN', 'Infinity', '12.5', '12.%', '0x20', '2147483648']) assert.throws(() => drawingPercentage(raw), /颜色变换暂不支持/)
})

test('scRGB uses the standard linear-to-sRGB transfer, including the documented 50% gray example', () => {
  assert.equal(scRgbColor('50%', '50%', '50%'), '#BCBCBC')
  assert.equal(scRgbColor('50000', '50000', '50000'), '#BCBCBC')
  assert.equal(scRgbColor('0', '0', '0'), '#000000')
  assert.equal(scRgbColor('100000', '100000', '100000'), '#FFFFFF')
  assert.equal(scRgbColor('100000', '0', '0'), '#FF0000')
  assert.throws(() => scRgbColor('', '0', '0'), /颜色变换暂不支持/)
})

test('tint endpoints preserve zero as white and full scale as the original color', () => {
  assert.equal(transform('#336699', [mod('tint', 0)]).hex, '#FFFFFF')
  assert.equal(transform('#336699', [mod('tint', 100000)]).hex, '#336699')
  assert.equal(transform('#000000', [mod('tint', 50000)]).hex, '#BCBCBC')
  assert.equal(transform('#000000', [mod('tint', '50%')]).hex, '#BCBCBC')
})

test('shade uses linear-light multiplication and validates its fixed positive range', () => {
  assert.equal(transform('#FFFFFF', [mod('shade', 50000)]).hex, '#BCBCBC')
  assert.equal(transform('#336699', [mod('shade', 100000)]).hex, '#336699')
  assert.equal(transform('#336699', [mod('shade', 0)]).hex, '#000000')
  assert.throws(() => transform('#336699', [mod('shade', -1)]), /定义范围/)
  assert.throws(() => transform('#336699', [mod('tint', 100001)]), /定义范围/)
})

test('scRGB and resolved theme bases retain floating precision through subsequent transforms', () => {
  for (const [components, modifiers, expected] of [
    [['200','500','1000'], [mod('shade',50000)], '#030810'],
    [['552','668','1132'], [mod('tint',99000),mod('shade',50000)], '#15171A'],
    [['523','784','1335'], [mod('shade',25000),mod('tint',99000)], '#1C1C1E'],
  ]) assert.equal(transform({ space:'scRgb', components }, modifiers).hex, expected)
  const theme = transform({ space:'scRgb', components:['10','10','10'] }, [mod('alpha',50000)])
  assert.equal(theme.hex, '#000000')
  const reference = transform({ space:'sRgb', components:theme.rgb, alpha:theme.alpha }, [mod('lumMod',10000000),mod('alphaMod',50000)])
  assert.equal(reference.hex, '#212121')
  assert.equal(reference.alpha, .25)
})

test('luminance modifies HSL lightness rather than scaling RGB channels', () => {
  assert.equal(transform('#FF0000', [mod('lum', 25000)]).hex, '#800000')
  assert.equal(transform('#00FF00', [mod('lumOff', 25000)]).hex, '#80FF80')
  assert.equal(transform('#0000FF', [mod('lumMod', 150000)]).hex, '#8080FF')
  assert.equal(transform('#336699', [mod('lum', 0)]).hex, '#000000')
  assert.equal(transform('#336699', [mod('lum', 100000)]).hex, '#FFFFFF')
})

test('hue and saturation capabilities remain supported with their distinct angle/percentage units', () => {
  assert.equal(transform('#FF0000', [mod('hue', 7200000)]).hex, '#00FF00')
  assert.equal(transform('#FF0000', [mod('hueOff', 14400000)]).hex, '#0000FF')
  assert.equal(transform('#FF0000', [mod('hueOff', -7200000)]).hex, '#0000FF')
  assert.equal(transform('#FF0000', [mod('sat', 0)]).hex, '#808080')
  assert.throws(() => transform('#FF0000', [mod('hue', '50%')]), /角度/)
})

test('transforms execute in document order, including duplicates and intermediate clamping', () => {
  assert.equal(transform('#FF0000', [mod('lum', 75000), mod('lumMod', 50000)]).hex, '#BF0000')
  assert.equal(transform('#FF0000', [mod('lumMod', 50000), mod('lum', 75000)]).hex, '#FF8080')
  assert.equal(transform('#336699', [mod('alpha', 80000), mod('alphaMod', 200000), mod('alphaOff', -20000)]).alpha, .8)
  assert.equal(transform('#336699', [mod('alpha', 50000), mod('alpha', 25000)]).alpha, .25)
  assert.equal(transform('#336699', [mod('alphaOff', -50000), mod('alphaMod', 50000)]).alpha, .25)
})

test('unknown or excessive transforms reject the whole chain rather than silently ignoring data', () => {
  assert.throws(() => transform('#336699', [mod('tint', 50000), mod('mystery', 1)]), /未知变换/)
  assert.throws(() => transform('#336699', Array.from({ length: 33 }, () => mod('alpha', 50000))), /32 项预算/)
  assert.throws(() => transform('#GGGGGG', []), /基色/)
  assert.throws(() => transform('#336699', [mod('lumMod', -1)]), /定义范围/)
  assert.throws(() => transform('#336699', [mod('alphaOff', 100001)]), /定义范围/)
})
