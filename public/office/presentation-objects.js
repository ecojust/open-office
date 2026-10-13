/* Validated Impress object operations. Runs only inside the local UNO worker. SPDX-License-Identifier: MIT */
'use strict';
(function (scope) {
  const MAX_OBJECTS = 2000, MAX_TEXT = 20000;
  const CHART_CLSID = '12DCAE26-281F-416F-A234-C3086127382E';
  const SHAPES = { rectangle: 'RectangleShape', ellipse: 'EllipseShape', line: 'LineShape', text: 'TextShape' };
  const GEOMETRY = ['x', 'y', 'width', 'height', 'rotation'];
  const STYLE = ['fontName', 'fontSize', 'bold', 'italic', 'underline', 'color', 'align'];
  function record(value, keys, label = '参数') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label}必须为对象。`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw Error(`不支持的${label}：${key}`);
    return value;
  }
  function number(value, min, max, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`${label}必须在 ${min}–${max} 之间。`);
    return value;
  }
  function integer(value, min, max, label) {
    number(value, min, max, label); if (!Number.isInteger(value)) throw Error(`${label}必须为整数。`); return value;
  }
  function string(value, max, label, allowEmpty = true) {
    if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /\u0000/.test(value)) throw Error(`${label}长度或内容无效。`);
    return value;
  }
  function choice(value, choices, label) { if (!choices.includes(value)) throw Error(`不支持的${label}。`); return value; }
  function color(value, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw Error('颜色必须为 #RRGGBB。');
    return value.toUpperCase();
  }
  const mm = value => Math.round(value * 100);
  const hex = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? '#' + (Math.trunc(value) & 0xffffff).toString(16).padStart(6, '0').toUpperCase() : null;
  const rgb = value => parseInt(value.slice(1), 16);
  const enumValue = value => typeof value === 'number' ? value : value?.value;
  function validateStyle(value) {
    if (value === undefined) return undefined;
    record(value, STYLE, '文字样式'); const output = {};
    for (const key of Object.keys(value)) {
      if (key === 'fontName') output[key] = string(value[key], 120, '字体名称', false);
      else if (key === 'fontSize') output[key] = number(value[key], 5, 300, '字号');
      else if (key === 'color') output[key] = color(value[key]);
      else if (key === 'align') output[key] = choice(value[key], ['left', 'center', 'right', 'justify'], '文字对齐');
      else { if (typeof value[key] !== 'boolean') throw Error(`${key}必须为布尔值。`); output[key] = value[key]; }
    }
    return output;
  }
  function validateFields(input) {
    const result = {};
    for (const key of GEOMETRY) if (input[key] !== undefined) result[key] = number(input[key], key === 'width' || key === 'height' ? 0 : -5000, key === 'rotation' ? 360 : 5000, key);
    if ('rotation' in result) number(result.rotation, -360, 360, '旋转角度');
    if (input.text !== undefined) result.text = string(input.text, MAX_TEXT, '文本');
    if (input.textStyle !== undefined) result.textStyle = validateStyle(input.textStyle);
    if (input.fillColor !== undefined) result.fillColor = color(input.fillColor, true);
    if (input.lineColor !== undefined) result.lineColor = color(input.lineColor, true);
    if (input.lineWidth !== undefined) result.lineWidth = number(input.lineWidth, 0, 20, '线宽');
    return result;
  }
  scope.createPresentationObjects = function ({ zetajs, css, getModel }) {
    if (!zetajs || !css || typeof getModel !== 'function') throw Error('缺少演示文稿对象环境。');
    let currentModel = null, generation = 0, serial = 0, entries = [];
    function recoverOptional(error) {
      // A native UNO exception must be caught through the bridge, even when a
      // missing optional property is ignored. Swallowing its raw WASM payload
      // leaks the native exception state and eventually corrupts later calls.
      if (error instanceof WebAssembly.RuntimeError) throw error;
      if (error instanceof Error) return;
      try { zetajs.catchUnoException(error); }
      catch (caught) { if (caught instanceof WebAssembly.RuntimeError) throw caught; }
    }
    const same = (a, b) => { try { return !!a && !!b && zetajs.sameUnoObject(a, b); } catch (error) { recoverOptional(error); return false; } };
    const has = (object, name) => { try { return !!object.getPropertySetInfo()?.hasPropertyByName(name); } catch (error) { recoverOptional(error); return false; } };
    const read = (object, name, fallback = null) => {
      if (!has(object, name)) return fallback;
      try { const value = object.getPropertyValue(name); return value === undefined ? fallback : value; }
      catch (error) { recoverOptional(error); return fallback; }
    };
    const typed = (type, value) => new zetajs.Any(zetajs.type[type], value);
    function environment() {
      const model = getModel();
      if (!model || !model.supportsService('com.sun.star.presentation.PresentationDocument')) throw Error('请先打开演示文稿。');
      if (!same(currentModel, model)) { currentModel = model; generation++; serial = 0; entries = []; }
      const controller = model.getCurrentController(), page = controller?.getCurrentPage();
      if (!page) throw Error('请先选中一页幻灯片。');
      const pageIndex = Number(read(page, 'Number', 1)) - 1;
      const count = page.getCount(); if (count > MAX_OBJECTS) throw Error(`当前页对象超过 ${MAX_OBJECTS} 个，请先精简。`);
      const old = entries, next = [];
      for (let index = 0; index < count; index++) {
        const shape = page.getByIndex(index);
        let entry = old[index];
        if (!entry || !same(entry.shape, shape)) entry = old.find(item => same(item.shape, shape));
        next.push({ id: entry?.id || `m${generation}-o${++serial}`, shape, index });
      }
      entries = next;
      return { model, controller, page, pageIndex, entries: next };
    }
    function textOf(shape) { try { return shape.getText(); } catch (error) { recoverOptional(error); return null; } }
    function typeOf(shape) {
      let type = ''; try { type = shape.getShapeType(); } catch (error) { recoverOptional(error); }
      const kind = { TextShape: 'text', RectangleShape: 'rectangle', EllipseShape: 'ellipse', LineShape: 'line',
        GraphicObjectShape: 'image', TableShape: 'table', GroupShape: 'group', CustomShape: 'custom' }[type.split('.').at(-1)];
      if (kind) return kind;
      if (/OLE2Shape$/.test(type)) {
        // OLE Model is not a passive getter: LibreOffice starts the embedded
        // object and installs a light client. A state/list request must not
        // activate editors merely to classify the object.
        const clsid = read(shape, 'CLSID', '');
        if (typeof clsid === 'string' && clsid.replace(/[{}]/g, '').toUpperCase() === CHART_CLSID) return 'chart';
      }
      if (/TextShape$/.test(type)) return 'text';
      return 'unknown';
    }
    function describe(entry) {
      const shape = entry.shape, position = shape.getPosition(), size = shape.getSize(), text = textOf(shape);
      const cursor = text?.createTextCursor();
      if (cursor) { cursor.gotoStart(false); cursor.gotoEnd(true); }
      const posture = cursor && read(cursor, 'CharPosture');
      const para = cursor && enumValue(read(cursor, 'ParaAdjust'));
      const fill = read(shape, 'FillStyle'), line = read(shape, 'LineStyle');
      let content = ''; try { content = text?.getString() || ''; } catch (error) { recoverOptional(error); }
      let name = ''; try { name = shape.getName() || ''; } catch (error) { recoverOptional(error); }
      return {
        id: entry.id, name: name.slice(0, 300), type: typeOf(shape), text: content.slice(0, MAX_TEXT), textTruncated: content.length > MAX_TEXT,
        x: position.X / 100, y: position.Y / 100, width: size.Width / 100, height: size.Height / 100,
        rotation: Number(read(shape, 'RotateAngle', 0)) / 100, zIndex: Number(read(shape, 'ZOrder', entry.index)),
        fillColor: enumValue(fill) === enumValue(css.drawing.FillStyle.NONE) ? null : hex(read(shape, 'FillColor')),
        lineColor: enumValue(line) === enumValue(css.drawing.LineStyle.NONE) ? null : hex(read(shape, 'LineColor')),
        lineWidth: Number(read(shape, 'LineWidth', 0)) / 100,
        textStyle: { fontName: cursor ? read(cursor, 'CharFontName', '') : '', fontSize: cursor ? Number(read(cursor, 'CharHeight', 18)) : 18,
          bold: !!cursor && Number(read(cursor, 'CharWeight', 100)) >= 150,
          italic: !!cursor && enumValue(posture) === enumValue(css.awt.FontSlant.ITALIC),
          underline: !!cursor && Number(read(cursor, 'CharUnderline', 0)) !== 0,
          color: cursor ? hex(read(cursor, 'CharColor')) || '#000000' : '#000000',
          align: ({ 0: 'left', 1: 'right', 2: 'justify', 3: 'center' })[para] || 'left' },
        capabilities: { text: !!text && content.length <= MAX_TEXT, fill: has(shape, 'FillStyle') && typeOf(shape) !== 'line',
          line: has(shape, 'LineStyle'), geometry: true },
      };
    }
    function selectedIds(env) {
      let selected; try { selected = env.controller.getSelection(); } catch (error) { recoverOptional(error); return []; }
      if (!selected) return [];
      const shapes = [];
      try { for (let i = 0; i < Math.min(selected.getCount(), MAX_OBJECTS); i++) shapes.push(selected.getByIndex(i)); }
      catch (error) { recoverOptional(error); shapes.push(selected); }
      return env.entries.filter(item => shapes.some(shape => same(shape, item.shape))).map(item => item.id);
    }
    function listObjects() {
      const env = environment();
      return { objects: env.entries.map(describe), selectedIds: selectedIds(env), pageIndex: env.pageIndex,
        pageWidth: Number(read(env.page, 'Width', 28000)) / 100, pageHeight: Number(read(env.page, 'Height', 15750)) / 100 };
    }
    function resolve(ids, env, min = 1) {
      if (!Array.isArray(ids) || ids.length < min || ids.length > 200 || new Set(ids).size !== ids.length) throw Error('请选择有效且不重复的对象。');
      return Array.from(ids, id => {
        string(id, 80, '对象编号', false); const entry = env.entries.find(item => item.id === id);
        if (!entry) throw Error('对象已删除或不在当前幻灯片，请重新选择。'); return entry;
      });
    }
    function collection(shapes) {
      const value = css.drawing.ShapeCollection.create(zetajs.getUnoComponentContext());
      for (const shape of shapes) value.add(shape); return value;
    }
    function selectShapes(env, shapes) { env.controller.select(shapes.length === 1 ? shapes[0] : shapes.length ? collection(shapes) : null); }
    function select(input) {
      record(input, ['ids']); const env = environment(), found = resolve(input.ids, env, 0);
      selectShapes(env, found.map(item => item.shape)); return listObjects();
    }
    function setTextStyle(shape, style) {
      if (!style) return;
      const text = textOf(shape); if (!text) throw Error('此对象不支持文字属性。');
      const cursor = text.createTextCursor(); cursor.gotoStart(false); cursor.gotoEnd(true);
      const set = (key, value) => cursor.setPropertyValue(key, value);
      if (style.fontName !== undefined) { set('CharFontName', style.fontName); set('CharFontNameAsian', style.fontName); set('CharFontNameComplex', style.fontName); }
      if (style.fontSize !== undefined) for (const name of ['CharHeight', 'CharHeightAsian', 'CharHeightComplex']) set(name, typed('float', style.fontSize));
      if (style.bold !== undefined) for (const name of ['CharWeight', 'CharWeightAsian', 'CharWeightComplex']) set(name, typed('float', style.bold ? 150 : 100));
      if (style.italic !== undefined) for (const name of ['CharPosture', 'CharPostureAsian', 'CharPostureComplex']) set(name, style.italic ? css.awt.FontSlant.ITALIC : css.awt.FontSlant.NONE);
      if (style.underline !== undefined) set('CharUnderline', typed('short', style.underline ? 1 : 0));
      if (style.color !== undefined) set('CharColor', rgb(style.color));
      if (style.align !== undefined) set('ParaAdjust', typed('short', { left: 0, right: 1, justify: 2, center: 3 }[style.align]));
    }
    function apply(shape, data) {
      if (data.text !== undefined) {
        const text = textOf(shape); if (!text) throw Error('此对象不支持修改文字。'); text.setString(data.text);
      }
      setTextStyle(shape, data.textStyle);
      if (data.width !== undefined || data.height !== undefined) {
        const old = shape.getSize(); shape.setSize(new css.awt.Size({ Width: data.width === undefined ? old.Width : mm(data.width), Height: data.height === undefined ? old.Height : mm(data.height) }));
      }
      if (data.rotation !== undefined) shape.setPropertyValue('RotateAngle', Math.round(data.rotation * 100));
      if (data.x !== undefined || data.y !== undefined) {
        const old = shape.getPosition(); shape.setPosition(new css.awt.Point({ X: data.x === undefined ? old.X : mm(data.x), Y: data.y === undefined ? old.Y : mm(data.y) }));
      }
      if (data.fillColor !== undefined) {
        if (!has(shape, 'FillStyle')) throw Error('此对象不支持填充。');
        shape.setPropertyValue('FillStyle', data.fillColor === null ? css.drawing.FillStyle.NONE : css.drawing.FillStyle.SOLID);
        if (data.fillColor !== null) shape.setPropertyValue('FillColor', rgb(data.fillColor));
      }
      if (data.lineColor !== undefined) {
        if (!has(shape, 'LineStyle')) throw Error('此对象不支持边线。');
        shape.setPropertyValue('LineStyle', data.lineColor === null ? css.drawing.LineStyle.NONE : css.drawing.LineStyle.SOLID);
        if (data.lineColor !== null) shape.setPropertyValue('LineColor', rgb(data.lineColor));
      }
      if (data.lineWidth !== undefined) shape.setPropertyValue('LineWidth', mm(data.lineWidth));
    }
    function create(type, data) {
      const env = environment(); if (env.entries.length >= MAX_OBJECTS) throw Error('当前页对象数量已达到上限。');
      const shape = env.model.createInstance(`com.sun.star.drawing.${SHAPES[type]}`);
      env.page.add(shape);
      try {
        shape.setName(`OpenOffice_${type}_${generation}_${++serial}`);
        const fields = { x: 20, y: 20, width: type === 'text' ? 120 : 60, height: type === 'text' ? 25 : type === 'line' ? 0 : 40,
          ...(type === 'text' ? { text: '', textStyle: { fontName: 'Noto Sans CJK SC', fontSize: 24, color: '#24334A' }, fillColor: null, lineColor: null }
            : { fillColor: type === 'line' ? null : '#DCE8F8', lineColor: '#3263A8', lineWidth: 0.5 }), ...data };
        if (type === 'text') fields.textStyle = { fontName: 'Noto Sans CJK SC', fontSize: 24, color: '#24334A', ...data.textStyle };
        apply(shape, fields);
        selectShapes(env, [shape]); return listObjects();
      } catch (error) { try { env.page.remove(shape); } catch (cleanupError) { recoverOptional(cleanupError); } throw error; }
    }
    function insertText(input) {
      record(input, ['text', 'textStyle', ...GEOMETRY, 'fillColor', 'lineColor', 'lineWidth']);
      if (input.text === undefined) throw Error('请输入文本。'); return create('text', validateFields(input));
    }
    function insertShape(input) {
      record(input, ['type', 'text', 'textStyle', ...GEOMETRY, 'fillColor', 'lineColor', 'lineWidth']);
      const type = choice(input.type, ['rectangle', 'ellipse', 'line'], '形状'); return create(type, validateFields(input));
    }
    function updateObject(input) {
      record(input, ['id', 'text', 'textStyle', ...GEOMETRY, 'fillColor', 'lineColor', 'lineWidth']);
      const data = validateFields(input), env = environment(), entry = resolve([input.id], env)[0], before = describe(entry);
      if ((data.text !== undefined || data.textStyle !== undefined) && !before.capabilities.text) throw Error('此对象不支持文字属性。');
      if (data.fillColor !== undefined && !before.capabilities.fill) throw Error('此对象不支持填充。');
      if ((data.lineColor !== undefined || data.lineWidth !== undefined) && !before.capabilities.line) throw Error('此对象不支持边线。');
      apply(entry.shape, data); return listObjects();
    }
    function deleteObjects(input) {
      record(input, ['ids']); const env = environment(), found = resolve(input.ids, env);
      selectShapes(env, []); for (const entry of found) env.page.remove(entry.shape); return listObjects();
    }
    function arrange(input) {
      record(input, ['ids', 'operation']);
      const operation = choice(input.operation, ['front', 'back', 'forward', 'backward', 'align-left', 'align-center', 'align-right',
        'align-top', 'align-middle', 'align-bottom', 'distribute-horizontal', 'distribute-vertical', 'group', 'ungroup'], '对象排列');
      const env = environment(), found = resolve(input.ids, env), shapes = found.map(item => item.shape);
      if (operation === 'group') {
        if (shapes.length < 2) throw Error('组合至少需要两个对象。');
        const group = env.page.group(collection(shapes)); selectShapes(env, [group]); return listObjects();
      }
      if (operation === 'ungroup') {
        if (shapes.some(shape => typeOf(shape) !== 'group')) throw Error('请选择组合对象后再取消组合。');
        selectShapes(env, []); for (const shape of shapes) env.page.ungroup(shape); return listObjects();
      }
      const ordered = [...found].sort((a, b) => a.index - b.index);
      if (['front', 'back', 'forward', 'backward'].includes(operation)) {
        if (operation === 'back' || operation === 'forward') ordered.reverse();
        for (const entry of ordered) {
          const z = Number(read(entry.shape, 'ZOrder', entry.index));
          if (operation === 'forward' || operation === 'backward') {
            const next = z + (operation === 'forward' ? 1 : -1);
            const adjacent = environment().entries[next];
            // A selected block at the stack boundary cannot move further. Do
            // not reverse its internal order by moving through its own peers.
            if (!adjacent || found.some(item => item.id === adjacent.id)) continue;
          }
          entry.shape.setPropertyValue('ZOrder', operation === 'front' ? env.entries.length - 1 : operation === 'back' ? 0
            : Math.min(env.entries.length - 1, Math.max(0, z + (operation === 'forward' ? 1 : -1))));
        }
      } else {
        const bounds = found.map(entry => ({ shape: entry.shape, p: entry.shape.getPosition(), s: entry.shape.getSize() }));
        if (operation.startsWith('distribute-')) {
          if (bounds.length < 3) throw Error('均匀分布至少需要三个对象。');
          const horizontal = operation === 'distribute-horizontal', axis = horizontal ? 'X' : 'Y', dimension = horizontal ? 'Width' : 'Height';
          bounds.sort((a, b) => a.p[axis] - b.p[axis]);
          const first = bounds[0], last = bounds.at(-1), span = last.p[axis] + last.s[dimension] - first.p[axis];
          const gap = (span - bounds.reduce((sum, item) => sum + item.s[dimension], 0)) / (bounds.length - 1);
          let position = first.p[axis];
          for (const item of bounds) { item.p[axis] = Math.round(position); item.shape.setPosition(new css.awt.Point(item.p)); position += item.s[dimension] + gap; }
        } else {
          const page = { left: 0, top: 0, right: read(env.page, 'Width', 28000), bottom: read(env.page, 'Height', 15750) };
          const box = bounds.length === 1 ? page : { left: Math.min(...bounds.map(b => b.p.X)), top: Math.min(...bounds.map(b => b.p.Y)),
            right: Math.max(...bounds.map(b => b.p.X + b.s.Width)), bottom: Math.max(...bounds.map(b => b.p.Y + b.s.Height)) };
          for (const item of bounds) {
            const point = { X: item.p.X, Y: item.p.Y };
            if (operation === 'align-left') point.X = box.left;
            if (operation === 'align-right') point.X = box.right - item.s.Width;
            if (operation === 'align-center') point.X = Math.round((box.left + box.right - item.s.Width) / 2);
            if (operation === 'align-top') point.Y = box.top;
            if (operation === 'align-bottom') point.Y = box.bottom - item.s.Height;
            if (operation === 'align-middle') point.Y = Math.round((box.top + box.bottom - item.s.Height) / 2);
            item.shape.setPosition(new css.awt.Point(point));
          }
        }
      }
      return listObjects();
    }
    function insertTable(input) {
      record(input, ['rows', 'columns', 'cells', ...GEOMETRY]);
      const rows = integer(input.rows, 1, 30, '表格行数'), columns = integer(input.columns, 1, 20, '表格列数');
      const data = validateFields(input), cells = input.cells;
      if (cells !== undefined && (!Array.isArray(cells) || cells.length !== rows || cells.some(row => !Array.isArray(row) || row.length !== columns))) throw Error('表格数据必须与行列数量一致。');
      if (cells) for (const row of cells) for (const cell of row) string(cell, 2000, '单元格文本');
      const env = environment(); if (env.entries.length >= MAX_OBJECTS) throw Error('当前页对象数量已达到上限。');
      const shape = env.model.createInstance('com.sun.star.drawing.TableShape');
      env.page.add(shape);
      try {
        shape.setName(`OpenOffice_table_${generation}_${++serial}`);
        const table = shape.getPropertyValue('Model'), rr = table.getRows(), cc = table.getColumns();
        if (rr.getCount() < rows) rr.insertByIndex(rr.getCount(), rows - rr.getCount());
        if (rr.getCount() > rows) rr.removeByIndex(rows, rr.getCount() - rows);
        if (cc.getCount() < columns) cc.insertByIndex(cc.getCount(), columns - cc.getCount());
        if (cc.getCount() > columns) cc.removeByIndex(columns, cc.getCount() - columns);
        for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
          const cell = table.getCellByPosition(c, r); cell.setString(cells?.[r]?.[c] || '');
          const cursor = cell.createTextCursor(); cursor.setPropertyValue('CharFontNameAsian', 'Noto Sans CJK SC');
          cursor.setPropertyValue('CharHeight', typed('float', 18));
        }
        apply(shape, { x: 20, y: 30, width: 200, height: rows * 12, ...data });
        selectShapes(env, [shape]); return listObjects();
      } catch (error) { try { env.page.remove(shape); } catch (cleanupError) { recoverOptional(cleanupError); } throw error; }
    }
    function tableEntry(input) {
      const env = environment(), entry = resolve([input.id], env)[0];
      if (typeOf(entry.shape) !== 'table') throw Error('请选择表格对象。');
      return { env, entry, table: entry.shape.getPropertyValue('Model') };
    }
    function getTable(input) {
      record(input, ['id']); const { table } = tableEntry(input), rows = table.getRows().getCount(), columns = table.getColumns().getCount();
      if (rows > 30 || columns > 20) throw Error('此表格超过侧栏编辑范围，请使用内置表格编辑器。');
      const cells = [];
      for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < columns; c++) row.push(string(table.getCellByPosition(c, r).getString(), 2000, '单元格文本')); cells.push(row); }
      return { id: input.id, rows, columns, cells };
    }
    function updateTable(input) {
      record(input, ['id', 'cells']); const cells = input.cells;
      if (!Array.isArray(cells) || !cells.length || cells.length > 30 || !Array.isArray(cells[0]) || !cells[0].length || cells[0].length > 20) throw Error('请输入 1–30 行、1–20 列表格数据。');
      const columns = cells[0].length;
      for (const row of cells) { if (!Array.isArray(row) || row.length !== columns) throw Error('表格数据的每行列数必须一致。'); for (const cell of row) string(cell, 2000, '单元格文本'); }
      const { table } = tableEntry(input);
      if (table.getRows().getCount() !== cells.length || table.getColumns().getCount() !== columns) throw Error('更新数据必须与现有表格行列数一致。');
      for (let r = 0; r < cells.length; r++) for (let c = 0; c < columns; c++) table.getCellByPosition(c, r).setString(cells[r][c]);
      return listObjects();
    }
    function validateChart(input) {
      const type = choice(input.type, ['column', 'bar', 'line', 'pie'], '图表类型');
      if (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 100) throw Error('图表需要 1–100 个类别。');
      if (!Array.isArray(input.series) || input.series.length < 1 || input.series.length > 20) throw Error('图表需要 1–20 个系列。');
      if (type === 'pie' && input.series.length !== 1) throw Error('饼图只支持一个数据系列。');
      const categories = Array.from(input.categories, value => string(value, 120, '类别名称', false));
      const series = Array.from(input.series, value => string(value, 120, '系列名称', false));
      if (!Array.isArray(input.values) || input.values.length !== categories.length) throw Error('图表数据必须与类别数量一致。');
      const values = Array.from(input.values, row => {
        if (!Array.isArray(row) || row.length !== series.length) throw Error('图表每行数据必须与系列数量一致。');
        return Array.from(row, value => number(value, type === 'pie' ? 0 : -1e12, 1e12, '图表数值'));
      });
      if (type === 'pie' && !values.some(row => row[0] > 0)) throw Error('饼图至少需要一个正数。');
      return { type, categories, series, values, title: input.title === undefined ? '' : string(input.title, 300, '图表标题') };
    }
    function chartModel(shape) {
      if (typeOf(shape) !== 'chart') throw Error('请选择可编辑图表对象。');
      return shape.getPropertyValue('Model').queryInterface(zetajs.type.interface(css.chart.XChartDocument));
    }
    function applyChart(chart, data) {
      const service = { column: 'BarDiagram', bar: 'BarDiagram', line: 'LineDiagram', pie: 'PieDiagram' }[data.type];
      const diagram = chart.createInstance(`com.sun.star.chart.${service}`); chart.setDiagram(diagram);
      diagram.setPropertyValue('DataRowSource', css.chart.ChartDataRowSource.COLUMNS);
      if (data.type === 'bar' || data.type === 'column') diagram.setPropertyValue('Vertical', data.type === 'bar');
      const source = chart.getData().queryInterface(zetajs.type.interface(css.chart.XChartDataArray));
      source.setData(data.values); source.setRowDescriptions(data.categories); source.setColumnDescriptions(data.series);
      chart.setPropertyValue('HasMainTitle', !!data.title);
      if (data.title) chart.getTitle().setPropertyValue('String', data.title);
    }
    function insertChart(input) {
      record(input, ['type', 'categories', 'series', 'values', 'title', ...GEOMETRY]);
      const data = validateChart(input), geometry = validateFields(input), env = environment();
      if (env.entries.length >= MAX_OBJECTS) throw Error('当前页对象数量已达到上限。');
      const shape = env.model.createInstance('com.sun.star.drawing.OLE2Shape'); env.page.add(shape);
      try {
        shape.setName(`OpenOffice_chart_${generation}_${++serial}`);
        apply(shape, { x: 20, y: 25, width: 200, height: 110, ...geometry });
        shape.setPropertyValue('CLSID', CHART_CLSID);
        const embedded = shape.getPropertyValue('Model');
        embedded.queryInterface(zetajs.type.interface(css.chart2.XChartDocument)).createDefaultChart();
        applyChart(chartModel(shape), data); selectShapes(env, [shape]); return listObjects();
      } catch (error) { try { env.page.remove(shape); } catch (cleanupError) { recoverOptional(cleanupError); } throw error; }
    }
    function getChart(input) {
      record(input, ['id']); const env = environment(), entry = resolve([input.id], env)[0], chart = chartModel(entry.shape);
      const source = chart.getData().queryInterface(zetajs.type.interface(css.chart.XChartDataArray));
      const diagram = chart.getDiagram(), name = diagram.getDiagramType();
      const type = name.endsWith('PieDiagram') ? 'pie' : name.endsWith('LineDiagram') ? 'line'
        : name.endsWith('BarDiagram') ? (read(diagram, 'Vertical', false) ? 'bar' : 'column') : null;
      if (!type) throw Error('此图表类型不支持侧栏数据编辑，请使用内置图表编辑器。');
      const categories = source.getRowDescriptions(), series = source.getColumnDescriptions();
      if (categories.length > 100 || series.length > 20) throw Error('此图表的数据量超过侧栏编辑范围。');
      const values = source.getData();
      if (values.length > 100 || values.some(row => row.length > 20)) throw Error('此图表的数据量超过侧栏编辑范围。');
      const title = read(chart, 'HasMainTitle', false) ? read(chart.getTitle(), 'String', '') : '';
      return { id: input.id, type, categories, series, values, title };
    }
    function updateChart(input) {
      record(input, ['id', 'type', 'categories', 'series', 'values', 'title']); const data = validateChart(input);
      const env = environment(), entry = resolve([input.id], env)[0]; applyChart(chartModel(entry.shape), data); return listObjects();
    }
    return Object.freeze({ listObjects, getSelection: listObjects, select, insertText, insertShape, insertTable, getTable, updateTable,
      insertChart, getChart, updateChart, updateObject, deleteObjects, arrange });
  };
})(globalThis);
