import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/office/presentation-objects.js', import.meta.url), 'utf8');

// This is a boundary fixture, not an implementation of UNO. Every writable
// surface is observable, including creation of an embedded table/chart model.
function fixture() {
  const mutations = [];
  const caughtNative = [];
  const record = (name, ...args) => mutations.push({ name, args });
  const unwrap = value => value instanceof Any ? value.value : value;
  class Any {
    constructor(type, value) { this.type = type; this.value = value; }
  }
  class Struct {
    constructor(fields) { Object.assign(this, fields); }
  }
  function makeShape(service = 'com.sun.star.drawing.RectangleShape') {
    let position = { X: 1000, Y: 2000 }, size = { Width: 3000, Height: 4000 };
    let content = '', name = 'Existing object';
    const properties = { FillStyle: 1, FillColor: 0xffffff, LineStyle: 1, LineColor: 0, LineWidth: 50 };
    const textProperties = { CharHeight: 18, CharWeight: 100, CharColor: 0, ParaAdjust: 0 };
    const cursor = {
      gotoStart() {}, gotoEnd() {},
      getPropertySetInfo: () => ({ hasPropertyByName: key => key in textProperties }),
      getPropertyValue: key => textProperties[key],
      setPropertyValue(key, value) { record('cursor.setPropertyValue', key, value); textProperties[key] = unwrap(value); },
    };
    const text = {
      getString: () => content,
      setString(value) { record('text.setString', value); content = value; },
      createTextCursor: () => cursor,
    };
    return {
      getShapeType: () => service,
      getPosition: () => ({ ...position }),
      getSize: () => ({ ...size }),
      getName: () => name,
      getText: () => text,
      getPropertySetInfo: () => ({ hasPropertyByName: key => key in properties }),
      getPropertyValue(key) {
        if (key === 'Model') {
          record('shape.embeddedModel');
          throw new Error('Embedded models must not be created for rejected input');
        }
        return properties[key];
      },
      setPosition(value) { record('shape.setPosition', value); position = { ...value }; },
      setSize(value) { record('shape.setSize', value); size = { ...value }; },
      setName(value) { record('shape.setName', value); name = value; },
      setPropertyValue(key, value) { record('shape.setPropertyValue', key, value); properties[key] = unwrap(value); },
    };
  }
  function makePage(shapes = []) {
    return {
      shapes,
      getCount: () => shapes.length,
      getByIndex: index => shapes[index],
      getPropertySetInfo: () => ({ hasPropertyByName: key => ['Number', 'Width', 'Height'].includes(key) }),
      getPropertyValue: key => ({ Number: 1, Width: 28000, Height: 15750 })[key],
      add(shape) { record('page.add', shape); shapes.push(shape); },
      remove(shape) { record('page.remove', shape); shapes.splice(shapes.indexOf(shape), 1); },
      group() { record('page.group'); throw new Error('Grouping is outside this boundary fixture'); },
      ungroup() { record('page.ungroup'); },
    };
  }
  let activePage = makePage([makeShape()]), selection = null;
  const controller = {
    getCurrentPage: () => activePage,
    getSelection: () => selection,
    select(value) { record('controller.select', value); selection = value; },
  };
  function makeModel() {
    return {
      supportsService: service => service === 'com.sun.star.presentation.PresentationDocument',
      getCurrentController: () => controller,
      createInstance(service) { record('model.createInstance', service); return makeShape(service); },
    };
  }
  let activeModel = makeModel();
  const css = {
    awt: { Size: Struct, Point: Struct, FontSlant: { NONE: 0, ITALIC: 2 } },
    drawing: {
      FillStyle: { NONE: 0, SOLID: 1 }, LineStyle: { NONE: 0, SOLID: 1 },
      ShapeCollection: { create() {
        record('ShapeCollection.create'); const shapes = [];
        return { add(shape) { record('ShapeCollection.add', shape); shapes.push(shape); },
          getCount: () => shapes.length, getByIndex: index => shapes[index] };
      } },
    },
  };
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'presentation-objects.js' });
  const api = context.createPresentationObjects({
    css,
    zetajs: { Any, type: { float: 'float', short: 'short' }, sameUnoObject: (a, b) => a === b,
      catchUnoException: error => { caughtNative.push(error); return { Message: 'Optional UNO property unavailable' }; },
      getUnoComponentContext: () => ({}) },
    getModel: () => activeModel,
  });
  return { api, mutations, caughtNative, makeShape, makePage,
    runtimeError: () => vm.runInContext('new WebAssembly.RuntimeError("Native engine trap")', context),
    get page() { return activePage; },
    switchPage(page) { activePage = page; selection = null; },
    replaceModel() { activeModel = makeModel(); selection = null; },
  };
}

function rejectsWithoutMutation(state, method, payload, message) {
  assert.equal(typeof state.api[method], 'function', `${method} must exist`);
  state.mutations.length = 0;
  assert.throws(() => state.api[method](payload), message, `${method} must reject invalid input`);
  assert.deepEqual(state.mutations, [], `${method} mutated UNO before rejecting input`);
}

test('valid insertion and update exercise the observable UNO mutation boundary', () => {
  const state = fixture();
  const result = state.api.insertText({ text: '可编辑文字', x: 12.5, y: 20, width: 80, height: 15,
    textStyle: { fontSize: 24, bold: true, align: 'center', color: '#123456' } });
  assert.equal(result.objects.length, 2);
  const inserted = result.objects.find(object => object.text === '可编辑文字');
  assert.ok(inserted);
  assert.equal(inserted.x, 12.5);
  assert.equal(inserted.width, 80);
  assert.equal(inserted.textStyle.bold, true);
  assert.ok(state.mutations.some(call => call.name === 'model.createInstance'));
  assert.ok(state.mutations.some(call => call.name === 'page.add'));
  const updated = state.api.updateObject({ id: inserted.id, text: '改后的文字', x: 42 });
  assert.equal(updated.objects.find(object => object.id === inserted.id).text, '改后的文字');
  assert.equal(updated.objects.find(object => object.id === inserted.id).x, 42);
});

test('valid shape kinds and zero-height lines are accepted', () => {
  for (const type of ['rectangle', 'ellipse', 'line']) {
    const state = fixture();
    const result = state.api.insertShape({ type, width: 60, height: type === 'line' ? 0 : 40 });
    assert.equal(result.objects.at(-1).type, type);
    assert.ok(state.mutations.some(call => call.name === 'page.add'));
  }
});

test('listing OLE charts uses metadata without activating embedded models', () => {
  const state = fixture();
  const chart = state.makeShape('com.sun.star.drawing.OLE2Shape');
  const unknown = state.makeShape('com.sun.star.drawing.OLE2Shape');
  chart.setPropertyValue('CLSID', '12DCAE26-281F-416F-A234-C3086127382E');
  state.mutations.length = 0;
  state.switchPage(state.makePage([chart, unknown]));
  const result = state.api.listObjects();
  assert.equal(result.objects[0].type, 'chart');
  assert.equal(result.objects[1].type, 'unknown');
  assert.deepEqual(state.mutations, [], 'read-only object state must not start embedded OLE models');
});

test('optional property reads are preflighted and native exceptions are consumed through the SDK', () => {
  const state = fixture();
  const shape = state.page.shapes[0], read = shape.getPropertyValue;
  const nativePayload = { nativeException: true };
  shape.getPropertyValue = key => {
    assert.ok(shape.getPropertySetInfo().hasPropertyByName(key), 'unknown properties must not be queried');
    if (key === 'FillColor') throw nativePayload;
    return read(key);
  };
  const result = state.api.listObjects();
  assert.equal(result.objects[0].fillColor, null);
  assert.deepEqual(state.caughtNative, [nativePayload]);
  assert.deepEqual(state.mutations, []);
});

test('a native WASM runtime trap is never hidden by optional-property fallbacks', () => {
  const state = fixture();
  const shape = state.page.shapes[0], read = shape.getPropertyValue, trap = state.runtimeError();
  shape.getPropertyValue = key => { if (key === 'FillStyle') throw trap; return read(key); };
  assert.throws(() => state.api.listObjects(), error => error === trap);
  assert.deepEqual(state.caughtNative, [], 'runtime traps are not optional UNO property errors');
});

test('geometry rejects non-finite values, coercible strings and negative dimensions before creation', () => {
  const state = fixture();
  for (const field of ['x', 'y', 'width', 'height', 'rotation', 'lineWidth']) {
    for (const value of [NaN, Infinity, -Infinity, '12', null]) {
      rejectsWithoutMutation(state, 'insertShape', { type: 'rectangle', [field]: value });
    }
  }
  for (const payload of [{ width: -0.01 }, { height: -1 }, { width: 5001 }, { height: 5001 },
    { x: -5001 }, { y: 5001 }, { rotation: -361 }, { rotation: 361 }, { lineWidth: -1 }, { lineWidth: 21 }]) {
    rejectsWithoutMutation(state, 'insertShape', { type: 'rectangle', ...payload });
  }
  const id = state.api.listObjects().objects[0].id;
  rejectsWithoutMutation(state, 'updateObject', { id, text: 'must not be applied', width: -1 });
  assert.equal(state.api.listObjects().objects[0].text, '');
});

test('text and style reject excessive lengths, invalid enums and untyped booleans', () => {
  const state = fixture();
  for (const text of [undefined, null, 123, 'a'.repeat(20001), 'hidden\0suffix']) {
    rejectsWithoutMutation(state, 'insertText', { text });
  }
  for (const textStyle of [null, [], { fontName: '' }, { fontName: ' '.repeat(4) },
    { fontName: 'a'.repeat(121) }, { fontSize: NaN }, { fontSize: Infinity }, { fontSize: 4 },
    { fontSize: 301 }, { fontSize: '24' }, { bold: 1 }, { italic: 'true' }, { underline: null },
    { align: 'middle' }, { align: 3 }, { align: '.uno:Open' }, { color: 'red' },
    { color: '#fff' }, { color: '#12345678' }, { color: null }, { command: '.uno:Open' }]) {
    rejectsWithoutMutation(state, 'insertText', { text: 'valid text', textStyle });
  }
  for (const property of ['fillColor', 'lineColor']) {
    for (const value of ['transparent', '#GGGGGG', '#123', '#12345678', 0, {}, 'url(file:///tmp/a)']) {
      rejectsWithoutMutation(state, 'insertShape', { type: 'rectangle', [property]: value });
    }
  }
});

test('maximum-length text and explicit transparent colors remain usable', () => {
  const state = fixture();
  const result = state.api.insertText({ text: '文'.repeat(20000), fillColor: null, lineColor: null });
  assert.equal(result.objects.at(-1).text.length, 20000);
  assert.equal(result.objects.at(-1).fillColor, null);
});

test('unknown shape kinds and arbitrary UNO command names are rejected', () => {
  const state = fixture();
  for (const type of ['triangle', 'text', 'TextShape', 'com.sun.star.drawing.OLE2Shape',
    '.uno:Open', 'constructor', '__proto__', null, 1]) {
    rejectsWithoutMutation(state, 'insertShape', { type });
  }
  const id = state.api.listObjects().objects[0].id;
  for (const operation of ['.uno:Open', 'executeDispatch', 'file:///tmp/x', 'constructor', '__proto__', '', null]) {
    rejectsWithoutMutation(state, 'arrange', { ids: [id], operation });
  }
  for (const command of ['executeDispatch', 'dispatch', 'runCommand', 'createInstance', 'eval']) {
    assert.equal(Object.hasOwn(state.api, command), false, 'the helper must not expose general UNO execution');
  }
});

test('unknown top-level fields are rejected on every public mutation operation', () => {
  const state = fixture(), id = state.api.listObjects().objects[0].id;
  const cases = [
    ['insertText', { text: 'Text' }], ['insertShape', { type: 'ellipse' }],
    ['insertTable', { rows: 1, columns: 1, cells: [['Cell']] }],
    ['insertChart', { type: 'column', categories: ['A'], series: ['S'], values: [[1]] }],
    ['updateTable', { id, cells: [['Cell']] }],
    ['updateChart', { id, type: 'column', categories: ['A'], series: ['S'], values: [[1]] }],
    ['updateObject', { id, x: 10 }], ['deleteObjects', { ids: [id] }],
    ['select', { ids: [id] }], ['arrange', { ids: [id], operation: 'front' }],
  ];
  for (const [method, payload] of cases) {
    for (const field of ['command', 'url', 'serviceName', 'unexpected']) {
      rejectsWithoutMutation(state, method, { ...payload, [field]: '.uno:Open' });
    }
    rejectsWithoutMutation(state, method, Object.assign(JSON.parse('{"__proto__":"injected"}'), payload));
    for (const input of [null, undefined, [], 'arbitrary command', 1]) {
      rejectsWithoutMutation(state, method, input);
    }
  }
});

test('invalid table dimensions and matrices never create a table or embedded model', () => {
  const state = fixture();
  for (const field of ['rows', 'columns']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '2', null, 1000000]) {
      rejectsWithoutMutation(state, 'insertTable', { rows: 2, columns: 2, [field]: value });
    }
  }
  for (const cells of [null, {}, 'not a matrix', [], [['a', 'b']], [['a'], ['b']],
    [['a', 'b'], ['c', 'd', 'e']], [['a', 'b'], null], [['a', 'b'], [3, 'd']],
    [['a', 'b'], ['c', ['nested']]], [['a', 'b'], ['c', 'x'.repeat(2001)]],
    [['a', 'b'], ['c', 'bad\0text']], [['a', 'b'], ['c', undefined]]]) {
    rejectsWithoutMutation(state, 'insertTable', { rows: 2, columns: 2, cells });
  }
  rejectsWithoutMutation(state, 'insertTable', { rows: 2, columns: 2, width: -1 });
  rejectsWithoutMutation(state, 'insertTable', { rows: 2, columns: 2, height: Infinity });
});

test('invalid chart kinds, labels, matrices and geometry are rejected before creating OLE content', () => {
  const state = fixture();
  const valid = { type: 'column', categories: ['Q1', 'Q2'], series: ['Sales'], values: [[12], [18]] };
  for (const type of ['scatter', 'ColumnDiagram', '.uno:InsertObject', 'constructor', null]) {
    rejectsWithoutMutation(state, 'insertChart', { ...valid, type });
  }
  for (const field of ['categories', 'series']) {
    for (const value of [null, 'not an array', [], [42], [null], ['bad\0text']]) {
      rejectsWithoutMutation(state, 'insertChart', { ...valid, [field]: value });
    }
  }
  for (const values of [null, {}, [], [[12]], [[12, 13], [18]], [[12], [18, 19]],
    [12, 18], [[12], null], [[12], ['18']], [[NaN], [18]], [[12], [Infinity]],
    [[12], [-Infinity]], [[12], [null]], [[12], [undefined]]]) {
    rejectsWithoutMutation(state, 'insertChart', { ...valid, values });
  }
  for (const payload of [{ width: -1 }, { height: -1 }, { x: NaN }, { y: Infinity }, { rotation: 361 }]) {
    rejectsWithoutMutation(state, 'insertChart', { ...valid, ...payload });
  }
  for (const payload of [{ title: 'x'.repeat(301) }, { categories: ['x'.repeat(121), 'Q2'] },
    { series: [''] }, { type: 'pie', values: [[0], [0]] }, { type: 'pie', values: [[-1], [18]] },
    { type: 'pie', series: ['A', 'B'], values: [[1, 2], [3, 4]] }]) {
    rejectsWithoutMutation(state, 'insertChart', { ...valid, ...payload });
  }
});

test('table and chart data updates validate their full payload before accessing an embedded model', () => {
  const state = fixture();
  state.switchPage(state.makePage([state.makeShape('com.sun.star.drawing.TableShape')]));
  const tableId = state.api.listObjects().objects[0].id;
  for (const cells of [null, [], [[1]], [['a'], ['b', 'c']], [['x'.repeat(2001)]], [['bad\0text']],
    [['a'], [undefined]], Array.from({ length: 31 }, () => ['a'])]) {
    rejectsWithoutMutation(state, 'updateTable', { id: tableId, cells });
  }
  state.switchPage(state.makePage([state.makeShape('com.sun.star.drawing.OLE2Shape')]));
  const chartId = state.api.listObjects().objects[0].id;
  const valid = { id: chartId, type: 'column', categories: ['A'], series: ['S'], values: [[1]] };
  for (const payload of [{ type: 'unknown' }, { categories: [] }, { series: [] }, { values: [[NaN]] },
    { values: [[Infinity]] }, { values: [['1']] }, { values: [[1, 2]] }, { title: 'x'.repeat(301) }]) {
    rejectsWithoutMutation(state, 'updateChart', { ...valid, ...payload });
  }
});

test('sparse arrays carried by structured clone cannot bypass chart or selection validation', () => {
  const state = fixture(), id = state.api.listObjects().objects[0].id;
  const chart = { type: 'column', categories: ['A'], series: ['S'], values: [[1]] };
  for (const payload of [{ categories: new Array(1) }, { series: new Array(1) },
    { values: new Array(1) }, { values: [new Array(1)] }]) {
    rejectsWithoutMutation(state, 'insertChart', { ...chart, ...payload });
    rejectsWithoutMutation(state, 'updateChart', { id, ...chart, ...payload });
  }
  rejectsWithoutMutation(state, 'select', { ids: new Array(1) });
  rejectsWithoutMutation(state, 'deleteObjects', { ids: new Array(1) });
});

test('malformed selections and mixed valid/stale IDs are resolved before any partial mutation', () => {
  const state = fixture(), id = state.api.listObjects().objects[0].id;
  for (const ids of [undefined, null, id, [], [id, id], [id, 'deleted-id'], [id, null],
    [id, 'a'.repeat(81)], [id, 'bad\0id'], Array.from({ length: 201 }, (_, i) => `object-${i}`)]) {
    rejectsWithoutMutation(state, 'deleteObjects', { ids });
    rejectsWithoutMutation(state, 'arrange', { ids, operation: 'front' });
    if (Array.isArray(ids) && ids.length === 0) continue; // Empty selection is legitimate.
    rejectsWithoutMutation(state, 'select', { ids });
  }
  assert.equal(state.page.shapes.length, 1);
  rejectsWithoutMutation(state, 'updateObject', { id: 'deleted-id', text: 'must not write' });
  for (const operation of ['group', 'ungroup', 'distribute-horizontal', 'distribute-vertical']) {
    rejectsWithoutMutation(state, 'arrange', { ids: [id], operation });
  }
});

test('IDs from deleted objects, other slides and replaced documents cannot mutate the current document', () => {
  for (const transition of ['deleted', 'page', 'document']) {
    const state = fixture(), id = state.api.listObjects().objects[0].id;
    if (transition === 'deleted') state.page.shapes.splice(0, 1);
    if (transition === 'page') state.switchPage(state.makePage([state.makeShape()]));
    if (transition === 'document') state.replaceModel();
    rejectsWithoutMutation(state, 'updateObject', { id, x: 500 });
    rejectsWithoutMutation(state, 'deleteObjects', { ids: [id] });
    rejectsWithoutMutation(state, 'select', { ids: [id] });
  }
});
