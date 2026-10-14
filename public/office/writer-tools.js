/* Native Writer operations. SPDX-License-Identifier: MIT */
'use strict';
(function (scope) {
  const ACTIONS = ['insert-text', 'format-text', 'format-paragraph', 'apply-style', 'insert-table', 'update-table',
    'set-page', 'set-header-footer', 'insert-page-number', 'insert-break', 'find-replace', 'goto-outline',
    'set-hyperlink', 'list', 'insert-comment', 'navigate-comment', 'delete-comment', 'set-track-changes', 'review-changes', 'insert-footnote', 'insert-toc', 'update-indexes'];
  const TEXT_STYLE = ['fontName', 'fontSize', 'bold', 'italic', 'underline', 'color', 'highlight', 'strikethrough', 'baseline'];
  const PARAGRAPH = ['align', 'outlineLevel', 'leftIndent', 'rightIndent', 'firstLineIndent', 'spaceAbove', 'spaceBelow', 'lineSpacingPercent'];
  const PAGE = ['width', 'height', 'landscape', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom'];
  const GUARDS = ['type', 'expectedRevision', 'expectedSelectionId'];
  const ALIGN = ['left', 'center', 'right', 'justify'];
  function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('操作参数必须为对象。');
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw Error(`不支持的操作参数：${key}`);
  }
  function number(value, min, max, label, integral = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integral && !Number.isInteger(value)) throw Error(`${label}必须在 ${min}–${max} 之间${integral ? '，并且为整数' : ''}。`);
    return value;
  }
  function text(value, limit, label, empty = true) {
    if (typeof value !== 'string' || value.length > limit || value.includes('\0') || !empty && !value.trim()) throw Error(`${label}长度或内容无效。`);
    return value;
  }
  function choice(value, values, label) { if (!values.includes(value)) throw Error(`不支持的${label}。`); return value; }
  function boolean(value, label) { if (typeof value !== 'boolean') throw Error(`${label}必须为布尔值。`); return value; }
  function color(value, nullable = false) { if (nullable && value === null) return null; if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw Error('颜色必须为 #RRGGBB。'); return value; }
  const rgb = value => parseInt(value.slice(1), 16);
  const hex = (value, fallback = '#000000') => typeof value === 'number' && value >= 0 ? '#' + (value & 0xffffff).toString(16).padStart(6, '0').toUpperCase() : fallback;
  const enumValue = value => typeof value === 'number' ? value : value?.value;
  const mm = value => Math.round(value * 100);
  const columnName = index => String.fromCharCode(65 + index);
  function matrix(cells, rows, columns) {
    if (!Array.isArray(cells) || cells.length !== rows) throw Error('表格数据行数不一致。');
    return Array.from(cells, row => {
      if (!Array.isArray(row) || row.length !== columns) throw Error('表格每行列数必须一致。');
      return Array.from(row, cell => text(cell, 2000, '单元格文本'));
    });
  }
  function validateAction(input) {
    if (!input || !ACTIONS.includes(input.type)) throw Error('不支持的文字编辑操作。');
    const fields = {
      'insert-text': ['text', 'replaceSelection'], 'format-text': TEXT_STYLE, 'format-paragraph': PARAGRAPH,
      'set-hyperlink': ['url'], 'list': ['operation'], 'apply-style': ['name'], 'insert-table': ['rows', 'columns', 'cells'], 'update-table': ['name', 'cells', 'expectedTableId', 'expectedCells', 'expectedCellSignatures'],
      'set-page': PAGE, 'set-header-footer': ['target', 'enabled', 'text', 'confirmRemoval'], 'insert-page-number': ['target', 'align'],
      'insert-break': ['kind'], 'find-replace': ['search', 'replace', 'all', 'matchCase', 'wholeWords'],
      'goto-outline': ['id'], 'insert-comment': ['text', 'author'], 'set-track-changes': ['enabled', 'show'],
      'navigate-comment': ['index'], 'delete-comment': ['index'], 'review-changes': ['decision', 'scope'],
      'insert-footnote': ['text', 'endnote'], 'insert-toc': ['title', 'levels'], 'update-indexes': [],
    }[input.type];
    record(input, [...GUARDS, ...fields]);
    if (input.expectedRevision !== undefined) number(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER, '文档版本', true);
    if (input.expectedSelectionId !== undefined) text(input.expectedSelectionId, 80, '选区编号', false);
    if (['insert-text', 'insert-comment', 'insert-footnote'].includes(input.type)) text(input.text, input.type === 'insert-text' ? 20000 : 5000, '文字');
    if (input.type === 'insert-comment') text(input.author, 100, '批注作者', false);
    if (input.type === 'navigate-comment' || input.type === 'delete-comment') number(input.index, 0, 99, '批注编号', true);
    if (input.type === 'review-changes') { choice(input.decision, ['accept', 'reject'], '审阅操作'); choice(input.scope, ['all', 'selection'], '审阅范围'); }
    if (input.type === 'apply-style' || input.type === 'update-table') text(input.name, 200, '名称', false);
    if (input.type === 'list') choice(input.operation, ['bullet','number','remove','promote','demote','restart'], '列表操作');
    if (input.type === 'goto-outline') text(input.id, 80, '大纲编号', false);
    for (const key of ['replaceSelection', 'all', 'matchCase', 'wholeWords', 'enabled', 'show', 'endnote', 'landscape', 'confirmRemoval']) if (input[key] !== undefined) boolean(input[key], key);
    if (input.type === 'set-hyperlink') {
      text(input.url, 2048, '链接地址');
      if (input.url) {
        let parsed; try { parsed = new URL(input.url); } catch { throw Error('请输入有效的网页或邮件地址。'); }
        if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol) || /[\u0000-\u0020\u007f<>\\]/.test(input.url)
          || (parsed.protocol === 'mailto:' ? !/^[^\s@]+@[^\s@]+$/.test(parsed.pathname) : !parsed.hostname || !/^https?:\/\//i.test(input.url))) throw Error('链接仅支持有效的 http、https 网页地址或 mailto 邮件地址。');
      }
    }
    if (input.type === 'format-text') {
      if (!TEXT_STYLE.some(key => input[key] !== undefined)) throw Error('请选择至少一项文字格式。');
      if (input.fontName !== undefined) text(input.fontName, 120, '字体', false);
      if (input.fontSize !== undefined) number(input.fontSize, 5, 300, '字号');
      for (const key of ['bold', 'italic', 'underline', 'strikethrough']) if (input[key] !== undefined) boolean(input[key], key);
      if (input.baseline !== undefined) choice(input.baseline, ['normal', 'superscript', 'subscript'], '上下标格式');
      if (input.color !== undefined) color(input.color);
      if (input.highlight !== undefined) color(input.highlight, true);
    }
    if (input.type === 'format-paragraph') {
      if (!PARAGRAPH.some(key => input[key] !== undefined)) throw Error('请选择至少一项段落格式。');
      if (input.align !== undefined) choice(input.align, ALIGN, '段落对齐方式');
      if (input.outlineLevel !== undefined) number(input.outlineLevel, 0, 10, '大纲级别', true);
      for (const key of ['leftIndent', 'rightIndent', 'firstLineIndent', 'spaceAbove', 'spaceBelow']) if (input[key] !== undefined) number(input[key], key === 'firstLineIndent' ? -100 : 0, 200, key);
      if (input.lineSpacingPercent !== undefined) number(input.lineSpacingPercent, 80, 300, '行距百分比', true);
    }
    if (input.type === 'insert-table') {
      number(input.rows, 1, 50, '行数', true); number(input.columns, 1, 20, '列数', true);
      if (input.cells !== undefined) matrix(input.cells, input.rows, input.columns);
    }
    if (input.type === 'update-table') {
      if (!Array.isArray(input.cells) || !input.cells.length || input.cells.length > 50 || !Array.isArray(input.cells[0])) throw Error('请输入 1–50 行表格数据。');
      number(input.cells[0].length, 1, 20, '列数', true); matrix(input.cells, input.cells.length, input.cells[0].length);
      const baseline = ['expectedTableId', 'expectedCells', 'expectedCellSignatures'];
      if (baseline.some(key => input[key] !== undefined)) {
        if (!baseline.every(key => input[key] !== undefined)) throw Error('表格比较基线不完整，请重新读取表格。');
        text(input.expectedTableId, 80, '表格标识', false);
        matrix(input.expectedCells, input.cells.length, input.cells[0].length);
        matrix(input.expectedCellSignatures, input.cells.length, input.cells[0].length);
        for (const row of input.expectedCellSignatures) for (const signature of row) text(signature, 80, '单元格基线');
      }
    }
    if (input.type === 'set-page') {
      if (!PAGE.some(key => input[key] !== undefined)) throw Error('请选择至少一项页面设置。');
      for (const key of ['width', 'height']) if (input[key] !== undefined) number(input[key], 50, 1200, key);
      for (const key of ['marginLeft', 'marginRight', 'marginTop', 'marginBottom']) if (input[key] !== undefined) number(input[key], 0, 500, key);
    }
    if (input.type === 'set-header-footer') {
      choice(input.target, ['header', 'footer'], '页眉页脚位置'); boolean(input.enabled, '启用状态');
      if (input.text !== undefined) text(input.text, 5000, '页眉页脚文字');
    }
    if (input.type === 'insert-page-number') {
      choice(input.target, ['header', 'footer', 'selection'], '页码位置');
      if (input.align !== undefined) choice(input.align, ['left', 'center', 'right'], '页码对齐');
    }
    if (input.type === 'insert-break') choice(input.kind, ['page', 'paragraph', 'line'], '分隔符');
    if (input.type === 'find-replace') {
      text(input.search, 1000, '查找文字', false);
      if (input.replace !== undefined) text(input.replace, 5000, '替换文字');
      if (input.all === true && input.replace === undefined) throw Error('全部替换需要提供替换文字。');
    }
    if (input.type === 'set-track-changes' && input.enabled === undefined && input.show === undefined) throw Error('请选择修订设置。');
    if (input.type === 'insert-toc') {
      if (input.title !== undefined) text(input.title, 200, '目录标题');
      if (input.levels !== undefined) number(input.levels, 1, 10, '目录级数', true);
    }
    return input;
  }
  scope.createWriterTools = function ({ zetajs, css, getModel, getRevision, dispatch }) {
    if (!zetajs || !css || typeof getModel !== 'function') throw Error('文字编辑环境尚未初始化。');
    let currentModel = null, generation = 0, selectionSerial = 0, previousSelection = null, outlineTargets = new Map(), message = '';
    let styleCatalogKey = '', styleCatalog = [], metadata = null, metadataRevision = null;
    let tableIdentities = [], nextTableIdentity = 0, readSerial = 0, cellBaselines = new Map();
    let listDisplayCache = null;
    // Factory NumberingRules owns its native rule and may delete an unused
    // rule when its proxy is collected. Keep owners until the native document
    // closes; never evict an owner that can still participate in undo/redo.
    let listRuleOwners = [];
    function recover(error) {
      if (error instanceof WebAssembly.RuntimeError) throw error;
      if (error instanceof Error) return;
      try { zetajs.catchUnoException(error); } catch (caught) { if (caught instanceof WebAssembly.RuntimeError) throw caught; }
    }
    function optional(fn, fallback = null) { try { return fn(); } catch (error) { recover(error); return fallback; } }
    const has = (object, name) => !!optional(() => object.getPropertySetInfo()?.hasPropertyByName(name), false);
    const read = (object, name, fallback = null) => has(object, name) ? optional(() => { const value = object.getPropertyValue(name); return value === undefined ? fallback : value; }, fallback) : fallback;
    const same = (a, b) => !!a && !!b && optional(() => zetajs.sameUnoObject(a, b), false);
    const typed = (name, value) => new zetajs.Any(zetajs.type[name], value);
    function set(object, name, value) { if (!has(object, name)) throw Error(`此位置不支持属性 ${name}。`); object.setPropertyValue(name, value); }
    function env() {
      const model = getModel();
      if (!model || !model.supportsService('com.sun.star.text.TextDocument')) throw Error('请先打开文字文档。');
      if (!same(model, currentModel)) { currentModel = model; generation++; selectionSerial = 0; previousSelection = null; outlineTargets = new Map(); message = ''; styleCatalogKey = ''; styleCatalog = []; metadata = null; metadataRevision = null; tableIdentities = []; nextTableIdentity = 0; readSerial = 0; cellBaselines = new Map(); listRuleOwners = []; }
      const controller = model.getCurrentController(), view = controller.getViewCursor();
      if (!view) throw Error('请先在文档中选择编辑位置。');
      return { model, controller, view, text: view.getText() };
    }
    function selection(env) {
      const { view, text: owner } = env;
      let equal = false;
      if (previousSelection && same(owner, previousSelection.owner)) equal = optional(() => owner.compareRegionStarts(previousSelection.range, view) === 0 && owner.compareRegionEnds(previousSelection.range, view) === 0, false);
      if (!equal) {
        const range = owner.createTextCursorByRange(view.getStart()); range.gotoRange(view.getEnd(), true);
        previousSelection = { id: `w${generation}-s${++selectionSerial}`, range, owner };
      }
      // SwXTextViewCursor::getString deliberately returns an empty string in
      // TableText mode. Read the real range through its owning cell/body XText
      // cursor; view start/end still correctly identify the selection.
      const value = optional(() => previousSelection.range.getString(), ''), table = read(view, 'TextTable'), cell = read(view, 'Cell');
      return { id: previousSelection.id, text: value.slice(0, 20000), truncated: value.length > 20000,
        collapsed: !!optional(() => view.isCollapsed(), !value), tableName: table ? optional(() => table.getName(), null) : null,
        cellName: cell ? read(cell, 'CellName', null) : null };
    }
    function pageStyle(env) {
      const name = read(env.view, 'PageStyleName', 'Standard');
      const styles = env.model.getStyleFamilies().getByName('PageStyles');
      if (!styles.hasByName(name)) throw Error('无法读取当前页样式。');
      return { name, style: styles.getByName(name) };
    }
    function pageInfo(env) {
      const { name, style } = pageStyle(env), headerEnabled = !!read(style, 'HeaderIsOn', false), footerEnabled = !!read(style, 'FooterIsOn', false);
      const header = headerEnabled ? optional(() => read(style, 'HeaderText').getString(), '') : '';
      const footer = footerEnabled ? optional(() => read(style, 'FooterText').getString(), '') : '';
      return { styleName: String(name).slice(0, 200), width: Number(read(style, 'Width', 21000)) / 100, height: Number(read(style, 'Height', 29700)) / 100,
        landscape: !!read(style, 'IsLandscape', false), marginLeft: Number(read(style, 'LeftMargin', 2000)) / 100,
        marginRight: Number(read(style, 'RightMargin', 2000)) / 100, marginTop: Number(read(style, 'TopMargin', 2000)) / 100,
        marginBottom: Number(read(style, 'BottomMargin', 2000)) / 100, headerEnabled, footerEnabled,
        headerText: header.slice(0, 5000), footerText: footer.slice(0, 5000), headerTruncated: header.length > 5000, footerTruncated: footer.length > 5000 };
    }
    function tableByName(env, name) { const tables = env.model.getTextTables(); if (!tables.hasByName(name)) throw Error('表格已删除，请刷新后重试。'); return tables.getByName(name); }
    function dimensions(table) {
      const rows = table.getRows().getCount(), columns = table.getColumns().getCount();
      if (rows < 1 || rows > 50 || columns < 1 || columns > 20) throw Error('此表格超过侧栏范围，请使用内核表格编辑器。');
      return { rows, columns };
    }
    function cellGrid(table, rows, columns) {
      const grid = [];
      for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < columns; c++) row.push(table.getCellByName(`${columnName(c)}${r + 1}`)); grid.push(row); }
      return grid;
    }
    function tableIdentity(table) {
      const known = tableIdentities.find(item => same(item.table, table));
      if (known) return known.id;
      const id = `w${generation}-table${++nextTableIdentity}`;
      tableIdentities.push({ table, id });
      if (tableIdentities.length > 100) tableIdentities.shift();
      return id;
    }
    function safeFormatValue(value, depth = 0) {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') { if (value.length > 2000) throw Error('复杂格式'); return value; }
      if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('复杂格式'); return value; }
      if (typeof value === 'boolean') return value;
      if (depth > 4 || typeof value !== 'object') throw Error('复杂格式');
      if (typeof value.value === 'number' && Number.isFinite(value.value)) return { enumValue: value.value };
      // Default Writer colors expose XComplexColor even when no complex color
      // exists. ColorType::Unused is explicitly 0 in docmodel/ComplexColor.hxx;
      // populated theme/transformation objects stay ineligible for recovery.
      if (typeof value.getType === 'function' && typeof value.getThemeColorType === 'function') {
        if (value.getType() !== 0) throw Error('复杂颜色');
        return { unusedComplexColor: true };
      }
      // Writer supplies a named event container even for an unlinked plain
      // run. Capture its complete bounded data rather than treating its mere
      // presence as a hyperlink or silently omitting changed event metadata.
      if (typeof value.getElementNames === 'function' && typeof value.getByName === 'function') {
        const names = Array.from(value.getElementNames()).sort();
        if (names.length > 16 || names.some(name => typeof name !== 'string' || name.length > 200)) throw Error('复杂格式');
        return { namedValues: names.map(name => [name, safeFormatValue(value.getByName(name), depth + 1)]) };
      }
      // Empty attribute/name containers carry no inline content. Any populated
      // unknown UNO object is deliberately ineligible for stale-write recovery.
      if (typeof value.hasElements === 'function') { if (value.hasElements()) throw Error('复杂格式'); return { emptyContainer: true }; }
      if (Array.isArray(value)) { if (value.length > 32) throw Error('复杂格式'); return value.map(item => safeFormatValue(item, depth + 1)); }
      const keys = Object.keys(value).sort(); if (!keys.length || keys.length > 32) throw Error('复杂格式');
      return Object.fromEntries(keys.map(key => [key, safeFormatValue(value[key], depth + 1)]));
    }
    function formatSnapshot(object) {
      const properties = object.getPropertySetInfo().getProperties();
      const names = Array.from(properties).map(item => item.Name).filter(name => /^(Char|ParaStyleName$|TextPortionType$|HyperLink)/.test(name)).sort();
      if (names.length > 250) throw Error('复杂格式');
      let values = null;
      if (typeof object.getPropertyValues === 'function') {
        try { values = object.getPropertyValues(names); } catch (error) { recover(error); }
      }
      if (!values) values = names.map(name => object.getPropertyValue(name));
      if (values.length !== names.length) throw Error('格式读取不完整');
      return names.map((name, index) => [name, safeFormatValue(values[index])]);
    }
    function cellSignature(cell) {
      try {
        if (/[\r\n\u000b\u000c\u0085\u2028\u2029]/.test(cell.getString())) return null;
        const paragraphs = cell.createEnumeration(), output = []; let portionsCount = 0;
        while (paragraphs.hasMoreElements()) {
          if (output.length >= 1) return null;
          const paragraph = paragraphs.nextElement();
          if (!paragraph.supportsService('com.sun.star.text.Paragraph')) return null;
          const portions = paragraph.createEnumeration(), runs = [];
          while (portions.hasMoreElements()) {
            if (++portionsCount > 50) return null;
            const portion = portions.nextElement();
            if (read(portion, 'TextPortionType') !== 'Text') return null;
            runs.push([portion.getString(), formatSnapshot(portion)]);
          }
          output.push([formatSnapshot(paragraph), runs]);
        }
        const signature = JSON.stringify(output);
        return signature.length <= 48000 ? signature : null;
      } catch (error) { recover(error); return null; }
    }
    function applyTableSnapshot(input, requireSignature = true) {
      validateAction(input);
      if (input.type !== 'update-table' || input.expectedTableId === undefined) throw Error('仅带完整读取基线的表格更新可以重新核对。');
      const e = env();
      if (input.expectedSelectionId !== undefined && selection(e).id !== input.expectedSelectionId) throw Error('文档选区已改变，请刷新后重试。');
      const table = tableByName(e, input.name), id = tableIdentity(table), size = dimensions(table);
      if (id !== input.expectedTableId) throw Error('表格已替换，请保留草稿并重新读取表格。');
      matrix(input.cells, size.rows, size.columns);
      const cells = cellGrid(table, size.rows, size.columns), changes = [];
      for (let r=0;r<size.rows;r++) for(let c=0;c<size.columns;c++) {
        if (input.cells[r][c] === input.expectedCells[r][c]) continue;
        if (requireSignature && /[\r\n\u000b\u000c\u0085\u2028\u2029]/.test(input.cells[r][c])) throw Error('跨段落或换行的编辑需要重新读取后操作；当前草稿已保留，也可在画布中编辑。');
        const token = input.expectedCellSignatures[r][c], baseline = cellBaselines.get(token);
        if (read(cells[r][c], 'IsProtected', false)) throw Error('目标单元格受到保护，请先在文档中解除保护。');
        if (requireSignature && (!baseline || baseline.tableId !== id || baseline.row !== r || baseline.column !== c || baseline.value !== input.expectedCells[r][c] || !same(baseline.cell, cells[r][c]))) throw Error('此单元格的安全读取基线不可用，请保留草稿并重新读取表格；复杂字段请在画布中编辑。');
        if (cells[r][c].getString() !== input.expectedCells[r][c] || requireSignature && cellSignature(cells[r][c]) !== baseline.signature) throw Error('目标单元格的内容或格式已变化，请保留草稿并重新读取表格。');
        changes.push([cells[r][c], input.cells[r][c]]);
      }
      // Every changed target is verified before the first native write.
      // This stale-recovery path is single-paragraph only. SwXText::setString
      // (fixed core unotext.cxx:877–906) explicitly avoids creating new nodes
      // there to preserve paragraph attributes; character/range formatting is
      // exhaustively fingerprinted above. Multi-paragraph/field data is refused.
      for (const [cell, value] of changes) cell.setString(value);
      metadata = null; message = changes.length ? `已更新 ${changes.length} 个单元格。` : '没有需要更新的单元格。';
      return { message };
    }
    function scanOutline(env) {
      const enumeration = env.model.getText().createEnumeration(), outline = [], targets = new Map(); let index = 0;
      while (enumeration.hasMoreElements() && index < 2000 && outline.length < 500) {
        const block = enumeration.nextElement(), id = `w${generation}-p${index++}`;
        if (!optional(() => block.supportsService('com.sun.star.text.Paragraph'), false)) continue;
        const level = Number(read(block, 'OutlineLevel', 0));
        if (level > 0) { outline.push({ id, text: optional(() => block.getString().slice(0, 500), ''), level }); targets.set(id, block.getStart()); }
      }
      outlineTargets = targets;
      return { outline, outlineTruncated: enumeration.hasMoreElements() };
    }
    function commentFields(env) {
      const comments = [], fields = env.model.getTextFields().createEnumeration(); let scanned = 0;
      while (fields.hasMoreElements() && scanned++ < 2000 && comments.length < 100) {
        const field = fields.nextElement();
        if (optional(() => field.supportsService('com.sun.star.text.TextField.Annotation') || field.supportsService('com.sun.star.text.textfield.Annotation'), false))
          comments.push(field);
      }
      return comments;
    }
    function countChanges(env) { const changes = env.model.getRedlines().createEnumeration(); let count = 0; while (changes.hasMoreElements() && count < 5000) { changes.nextElement(); count++; } return count; }
    function reviewInfo(env) {
      const comments = commentFields(env).map((field, index) => ({ index, author: String(read(field, 'Author', '')).slice(0, 100), text: String(read(field, 'Content', '')).slice(0, 5000) }));
      const changeCount = optional(() => countChanges(env), 0);
      return { recordChanges: !!read(env.model, 'RecordChanges', false), showChanges: !!read(env.model, 'ShowChanges', true),
        changeCount, comments,
        footnoteCount: optional(() => env.model.getFootnotes().getCount(), 0), indexCount: optional(() => env.model.getDocumentIndexes().getCount(), 0) };
    }
    function documentMetadata(e) {
      const revision = typeof getRevision === 'function' ? getRevision() : null;
      if (metadata && Number.isSafeInteger(revision) && metadataRevision === revision) return metadata;
      const family = e.model.getStyleFamilies().getByName('ParagraphStyles');
      const names = Array.from(family.getElementNames()).filter(name => typeof name === 'string' && name.length <= 200).slice(0, 200), catalogKey = JSON.stringify(names);
      // Native style labels require hundreds of bridge calls. Cache the catalog
      // per model, refreshing when a style is added/removed/renamed; selection
      // changes still read current character/paragraph properties live.
      if (catalogKey !== styleCatalogKey) { styleCatalogKey = catalogKey; styleCatalog = names.map(name => ({ name, label: String(read(family.getByName(name), 'DisplayName', name)).slice(0, 200) })); }
      const styles = styleCatalog;
      const tableSet = e.model.getTextTables(), tables = Array.from(tableSet.getElementNames()).filter(name => typeof name === 'string' && name.length <= 200).slice(0, 100).map(name => {
        const table = tableSet.getByName(name);
        return { name, rows: optional(() => table.getRows().getCount(), 0), columns: optional(() => table.getColumns().getCount(), 0) };
      });
      metadata = { styles, ...scanOutline(e), tables, review: reviewInfo(e) }; metadataRevision = revision;
      return metadata;
    }
    function commandState(e = env()) {
      const view = e.view, spacing = read(view, 'ParaLineSpacing'), selected = selection(e);
      return { selection: selected, list: listDisplay(e, selected), textStyle: { fontName: String(read(view, 'CharFontNameAsian', read(view, 'CharFontName', ''))).slice(0, 120),
        fontSize: Number(read(view, 'CharHeight', 12)), bold: Number(read(view, 'CharWeight', 100)) >= 150,
        italic: enumValue(read(view, 'CharPosture')) === enumValue(css.awt.FontSlant.ITALIC), underline: Number(read(view, 'CharUnderline', 0)) !== 0,
        strikethrough: Number(read(view, 'CharStrikeout', 0)) !== 0,
        baseline: Number(read(view, 'CharEscapement', 0)) > 0 ? 'superscript' : Number(read(view, 'CharEscapement', 0)) < 0 ? 'subscript' : 'normal',
        color: hex(read(view, 'CharColor')), highlight: read(view, 'CharBackTransparent', false) ? null : hex(read(view, 'CharBackColor'), null) },
        hyperlink: { url: String(read(view, 'HyperLinkURL', '') || '').slice(0, 2048), mixed: optional(() => enumValue(view.getPropertyState('HyperLinkURL')) === 2, false) },
        paragraph: { styleName: String(read(view, 'ParaStyleName', '')).slice(0, 200), align: ({0:'left',1:'right',2:'justify',3:'center'})[enumValue(read(view, 'ParaAdjust', 0))] || 'left',
          outlineLevel: Number(read(view, 'OutlineLevel', 0)), leftIndent: Number(read(view, 'ParaLeftMargin', 0)) / 100,
          rightIndent: Number(read(view, 'ParaRightMargin', 0)) / 100, firstLineIndent: Number(read(view, 'ParaFirstLineIndent', 0)) / 100,
          spaceAbove: Number(read(view, 'ParaTopMargin', 0)) / 100, spaceBelow: Number(read(view, 'ParaBottomMargin', 0)) / 100,
          lineSpacingPercent: enumValue(spacing?.Mode) === enumValue(css.style.LineSpacingMode.PROP) ? Number(spacing.Height) : 100 },
        page: pageInfo(e) };
    }
    function state() { const e = env(); return { ...commandState(e), ...documentMetadata(e), message }; }
    function cursor(env, replace = true) {
      const range = env.text.createTextCursorByRange(env.view.getStart()); range.gotoRange(env.view.getEnd(), replace); return range;
    }
    function listDisplay(e, selected) {
      const revision = typeof getRevision === 'function' ? getRevision() : null;
      const key = generation + ':' + revision + ':' + selected.id;
      if (Number.isSafeInteger(revision) && listDisplayCache?.key === key) return listDisplayCache.value;
      // Display is deliberately cheap: one current level, never a paragraph or
      // all-level rule audit on each toolbar refresh. Writes recheck everything.
      const value = optional(() => {
        const states=['NumberingRules','NumberingLevel','NumberingIsNumber'].map(name=>enumValue(e.view.getPropertyState(name)));
        if(states.some(value=>![0,1,2].includes(value)))return {kind:'other',level:null};
        if(states.includes(2))return {kind:'mixed',level:null};
        const rules=e.view.getPropertyValue('NumberingRules'),level=e.view.getPropertyValue('NumberingLevel');
        if(rules===null||rules===undefined&&states[0]===1)return {kind:'none',level:null};
        if(!Number.isInteger(level)||level<0||level>8)return {kind:'other',level:null};
        const entry=rules.getByIndex(level).find(item=>item.Name==='NumberingType'),type=enumValue(entry?.Value);
        return {kind:type===enumValue(css.style.NumberingType.ARABIC)?'number':type===enumValue(css.style.NumberingType.CHAR_SPECIAL)?'bullet':'other',level};
      }, {kind:'other',level:null});
      if(Number.isSafeInteger(revision))listDisplayCache={key,value};
      return value;
    }
    function listProperty(object, name) {
      if(!has(object,name)||typeof object.getPropertyState!=='function')throw Error('无法确认列表属性，请在画布中编辑。');
      const state=enumValue(object.getPropertyState(name));
      if(state!==0&&state!==1)throw Error('选区包含混合或未知列表属性，请缩小选区。');
      return object.getPropertyValue(name);
    }
    function listNullableProperty(object, name) {
      const value=listProperty(object,name);
      // The bundled UNO bridge represents absent default interface properties
      // as undefined (observed TextSection, TextTable and NumberingRules).
      // Only this proven DEFAULT_VALUE case is normalized; missing properties,
      // failed reads, unknown states and direct undefined values still refuse.
      return value===undefined&&enumValue(object.getPropertyState(name))===1?null:value;
    }
    function ordinaryListRules(rules) {
      const complex=()=>{throw Error('此列表包含复杂编号、章节规则或图片符号，请在画布中编辑；原列表已保留。')};
      if(!rules||typeof rules.getCount!=='function'||typeof rules.getByIndex!=='function'||typeof rules.getPropertyValue!=='function')complex();
      if(rules.getPropertyValue('NumberingIsOutline')!==false||rules.getPropertyValue('IsContinuousNumbering')!==false)complex();
      const count=rules.getCount();if(!Number.isInteger(count)||count<1||count>10)complex();
      const allowed=['Adjust','ParentNumbering','Prefix','Suffix','ListFormat','CharStyleName','StartWith','PositionAndSpaceMode','LabelFollowedBy','ListtabStopPosition','FirstLineIndent','IndentAt','NumberingType','BulletId','BulletChar','BulletFontName','BulletFont','LeftMargin','SymbolTextDistance','FirstLineOffset','BulletRelSize'];
      let kind=null;
      for(let level=0;level<count;level++){
        const entries=rules.getByIndex(level);if(!Array.isArray(entries)||entries.length<5||entries.length>32)complex();
        const values={};
        for(const item of entries){if(!item||!allowed.includes(item.Name)||Object.prototype.hasOwnProperty.call(values,item.Name))complex();values[item.Name]=item.Value}
        const type=enumValue(values.NumberingType),next=type===enumValue(css.style.NumberingType.ARABIC)?'number':type===enumValue(css.style.NumberingType.CHAR_SPECIAL)?'bullet':null;
        // DOCX has nine levels; Writer adds its tenth default slot on import.
        // It remains fully audited and untouched, but may be another basic type.
        if(!next||kind&&kind!==next&&level<9||values.ParentNumbering!==1||values.Prefix!==''||!Number.isInteger(values.StartWith)||values.StartWith<1||values.StartWith>32767)complex();
        if(level===0)kind=next;
        if(next==='number'){
          if(!['.',')',''].includes(values.Suffix)||values.ListFormat!==undefined&&values.ListFormat!=='%'+(level+1)+'%'+values.Suffix)complex();
        }else{
          // ODT reload represents an ordinary Unicode bullet using the current
          // level placeholder (%1%, %2%, …), without a prefix or suffix.
          const plain=values.Suffix===''&&['•','●','◦','▪','–','-'].includes(values.BulletChar)&&(values.ListFormat===undefined||values.ListFormat===''||values.ListFormat==='%'+(level+1)+'%');
          // Native DOCX roundtrip of our Unicode dot: Symbol charset 10 maps
          // U+F0B7 to • and exposes that glyph as suffix/list format as well.
          const symbol=values.BulletChar==='\uF0B7'&&values.BulletFontName===''&&values.BulletFont?.Name==='Symbol'&&enumValue(values.BulletFont.CharSet)===10&&values.Suffix==='\uF0B7'&&values.ListFormat==='\uF0B7';
          if(!plain&&!symbol)complex();
        }
      }
      return {kind,count};
    }
    function listTargets(e) {
      if(typeof e.model.isReadonly!=='function'||e.model.isReadonly()!==false)throw Error('文档为只读或状态未知，不能调整列表。');
      if(!same(e.text,e.model.getText()))throw Error('列表侧栏目前只支持正文，请在画布中编辑表格、页眉或其他区域。');
      const active=e.controller.getSelection();
      if(!active||typeof active.getCount!=='function'||active.getCount()!==1||typeof active.getByIndex!=='function')throw Error('请只选择一个连续正文文字范围。');
      const actual=active.getByIndex(0);
      if(!actual||typeof actual.getText!=='function'||!same(actual.getText(),e.text)||e.text.compareRegionStarts(actual,e.view)!==0||e.text.compareRegionEnds(actual,e.view)!==0)throw Error('文字选区已改变，请重新定位后调整列表。');
      const selected=selection(e);if(selected.truncated)throw Error('选区过大，请缩小后调整列表。');
      const range=cursor(e),enumeration=range.createEnumeration(),targets=[],cache=new Map();let total=0;
      while(enumeration.hasMoreElements()){
        const paragraph=enumeration.nextElement();
        if(!paragraph.supportsService('com.sun.star.text.Paragraph'))throw Error('选区跨越表格或复杂对象，请缩小为普通正文段落。');
        // Writer enumerates the paragraph at an exclusive end boundary too.
        if(!selected.collapsed&&e.text.compareRegionStarts(paragraph,e.view.getEnd())===0)continue;
        if(targets.length>=100)throw Error('一次最多调整 100 个段落，请缩小选区。');
        const value=paragraph.getString();if(typeof value!=='string'||value.length>20000||(total+=value.length)>64000)throw Error('段落文字过多，请缩小选区。');
        if(listProperty(paragraph,'OutlineLevel')!==0||listNullableProperty(paragraph,'TextSection')!==null||listNullableProperty(paragraph,'TextTable')!==null)throw Error('标题、章节、分区或表格段落请在画布中调整列表。');
        const rules=listNullableProperty(paragraph,'NumberingRules'),style=listProperty(paragraph,'NumberingStyleName'),level=listProperty(paragraph,'NumberingLevel'),id=listProperty(paragraph,'ListId'),counted=listProperty(paragraph,'NumberingIsNumber');
        const restart=listProperty(paragraph,'ParaIsNumberingRestart'),start=listProperty(paragraph,'NumberingStartValue');
        if(typeof style!=='string'||style.length>200||typeof id!=='string'||id.length>500||!Number.isInteger(level)||level<0||level>8||typeof counted!=='boolean'||typeof restart!=='boolean'||!Number.isInteger(start)||start< -1||start>32767)throw Error('列表状态不明确，请在画布中编辑。');
        let info={kind:'none',count:0};
        if(rules!==null){
          if(!id||!counted)throw Error('此列表包含未计数条目，请在画布中编辑。');
          const key=JSON.stringify([style,id]),cached=cache.get(key);
          info=cached&&same(cached.rules,rules)?cached.info:ordinaryListRules(rules);cache.set(key,{rules,info});
          if(level>=info.count)throw Error('列表层级超出规则范围，已保留原文档。');
        }else if(style||id||counted||restart)throw Error('列表状态不明确，请在画布中编辑。');
        targets.push({paragraph,rules,style,level,id,restart,start,...info});
      }
      if(!targets.length)throw Error('请在正文段落中定位或选择文字。');
      const first=targets[0];
      if(targets.some(item=>item.kind!==first.kind||item.id!==first.id||item.style!==first.style))throw Error('选区跨越不同列表或普通段落，请分别调整。');
      const full=e.text.createTextCursorByRange(first.paragraph.getStart());full.gotoRange(targets.at(-1).paragraph.getEnd(),true);
      return {targets,full,kind:first.kind};
    }
    function newListRules(e, kind, undo) {
      // A fresh rule instance is only attached to proven unnumbered paragraphs.
      // Never replace a level on an imported/shared NumberingRules object.
      if(listRuleOwners.length>=512)throw Error('本次打开已创建 512 个列表，请保存并重新打开后继续创建；已有列表仍可编辑。');
      if(typeof undo.lock!=='function'||typeof undo.unlock!=='function'||typeof undo.isLocked!=='function'||undo.isLocked()!==false)throw Error('列表撤销环境暂不可用，未修改正文。');
      // Factory creation otherwise inserts a separate default-numbering undo
      // record. Initializing that factory does not update its saved snapshot.
      // Suppress only this internal setup; binding below remains undoable.
      undo.lock();
      try {
      const rules=e.model.createInstance('com.sun.star.text.NumberingRules');
      listRuleOwners.push(rules);
      const count=rules.getCount();
      if(!Number.isInteger(count)||count<1||count>10||typeof rules.replaceByIndex!=='function')throw Error('当前内核不支持创建普通列表。');
      const seq=zetajs.type.sequence(zetajs.type.struct(css.beans.PropertyValue));
      for(let level=0;level<count;level++){
        const values=[['NumberingType',typed('short',kind==='bullet'?css.style.NumberingType.CHAR_SPECIAL:css.style.NumberingType.ARABIC)],['ParentNumbering',typed('short',1)],['Prefix',''],['Suffix',kind==='bullet'?'':'.'],['StartWith',typed('short',1)],['PositionAndSpaceMode',typed('short',1)],['LabelFollowedBy',typed('short',0)],['ListtabStopPosition',typed('long',(level+1)*635)],['FirstLineIndent',typed('long',-317)],['IndentAt',typed('long',(level+1)*635)]];
        if(kind==='bullet')values.push(['BulletChar','•']);
        rules.replaceByIndex(level,new zetajs.Any(seq,values.map(([Name,Value])=>new css.beans.PropertyValue({Name,Value}))));
      }
      return rules;
      } finally { undo.unlock(); }
    }
    function editList(e, operation) {
      const {targets,full,kind}=listTargets(e),create=operation==='bullet'||operation==='number';
      if(create&&kind===operation||operation==='remove'&&kind==='none'){message='列表未改变。';return}
      if(create&&kind!=='none')throw Error('请先取消现有列表，再创建另一种普通列表；现有编号规则已保留。');
      if(!create&&kind==='none')throw Error('请先定位到一个普通列表条目。');
      if(operation==='restart'&&kind!=='number')throw Error('只有普通数字编号可以从 1 重新开始。');
      const delta=operation==='promote'?-1:operation==='demote'?1:0;
      if(delta&&targets.some(item=>item.level+delta<0||item.level+delta>Math.min(8,item.count-1)))throw Error('列表已到达可用层级边界，本次没有修改。');
      const property=create?'NumberingRules':operation==='remove'?'NumberingStyleName':delta?'NumberingLevel':'ParaIsNumberingRestart';
      for(const item of targets){if(!has(item.paragraph,property))throw Error('此段落不支持列表操作。')}
      if(delta&&(typeof dispatch!=='function'||typeof e.controller.select!=='function'))throw Error('当前内核不支持可撤销的层级调整。');
      if(create&&(!has(full,'NumberingRules')||!has(full,'NumberingLevel')))throw Error('此选区不支持普通列表。');
      const undo=e.model.getUndoManager();if(!undo||typeof undo.enterUndoContext!=='function'||typeof undo.leaveUndoContext!=='function')throw Error('列表撤销环境不可用，未修改内容。');
      const rules=create?newListRules(e,operation,undo):null,originalSelection=delta?cursor(e):null;
      if(delta)try{e.controller.select(full);if(e.text.compareRegionStarts(e.controller.getViewCursor(),full)!==0||e.text.compareRegionEnds(e.controller.getViewCursor(),full)!==0)throw Error('无法定位完整段落，本次没有修改。')}catch(error){e.controller.select(originalSelection);throw error}
      let grouped=false;
      try{
        undo.enterUndoContext('调整列表');grouped=true;
        if(create){full.setPropertyValue('NumberingRules',rules);full.setPropertyValue('NumberingLevel',typed('short',0))}
        else if(operation==='remove')for(const item of targets)item.paragraph.setPropertyValue('NumberingStyleName','');
        else if(delta){
          // UNO NumberingLevel setters bypass SwUndoNumUpDown. These exact
          // non-SubLevels slots use the native undoable list operation. Names
          // refer to hierarchy rank: DecrementLevel demotes, Increment promotes.
          dispatch(delta>0?'.uno:DecrementLevel':'.uno:IncrementLevel',[new css.beans.PropertyValue({Name:'SynchronMode',Value:true})]);
          if(targets.some(item=>listProperty(item.paragraph,'NumberingLevel')!==item.level+delta))throw Error('列表层级未能完整调整，请在画布中检查当前列表。');
        }
        else {targets[0].paragraph.setPropertyValue('ParaIsNumberingRestart',true);targets[0].paragraph.setPropertyValue('NumberingStartValue',typed('short',1))}
      }finally{try{if(grouped)undo.leaveUndoContext()}finally{if(originalSelection)e.controller.select(originalSelection)}}
      listDisplayCache=null;message=operation==='restart'?'已从选区首段重新编号；后续条目按原列表规则继续。':'已调整 '+targets.length+' 个段落的列表。';
    }
    function editDecorationText(owner, previous, next) {
      const refused = () => { throw Error('此改动跨越格式、字段、链接或复杂内容，已保留原页眉页脚。请在画布中编辑；侧栏只支持同一普通文字片段内的改字。'); };
      if (typeof owner.createEnumeration !== 'function' || typeof owner.createTextCursorByRange !== 'function') refused();
      const paragraphs=owner.createEnumeration(),pieces=[];let joined='',paragraphCount=0,portionCount=0;
      while(paragraphs.hasMoreElements()) {
        if(++paragraphCount>64)refused();
        const paragraph=paragraphs.nextElement();
        if(!paragraph.supportsService('com.sun.star.text.Paragraph'))refused();
        if(paragraphCount>1){pieces.push({start:joined.length,end:joined.length+1,plain:false,text:'\n'});joined+='\n'}
        const portions=paragraph.createEnumeration();let paragraphText='';
        while(portions.hasMoreElements()) {
          if(++portionCount>128)refused();
          const portion=portions.nextElement(),value=portion.getString(),type=portion.getPropertyValue('TextPortionType');
          if(typeof value!=='string'||typeof type!=='string')refused();
          const link=type==='Text'?portion.getPropertyValue('HyperLinkURL'):null;
          if(type==='Text'&&typeof link!=='string')refused();
          const start=joined.length;joined+=value;paragraphText+=value;
          if(joined.length>5000)refused();
          pieces.push({start,end:joined.length,plain:type==='Text'&&link==='',text:value,portion});
        }
        if(paragraphText!==paragraph.getString())refused();
      }
      // Expanded field text is not assumed to have the same native cursor
      // length. Only a proven plain run supplies a cursor and local offsets.
      if(joined!==previous||owner.getString()!==previous)refused();
      const before=Array.from(previous),after=Array.from(next);let left=0,tail=0;
      while(left<before.length&&left<after.length&&before[left]===after[left])left++;
      while(tail<before.length-left&&tail<after.length-left&&before[before.length-1-tail]===after[after.length-1-tail])tail++;
      let start=before.slice(0,left).join('').length,end=previous.length-before.slice(before.length-tail).join('').length;
      let replacement=after.slice(left,after.length-tail).join('');
      if(/[\r\n\u000b\u000c\u0085\u2028\u2029]/.test(replacement))refused();
      const insertion=start===end;
      // Zero-width bookmarks/objects and either edge of a field/link are not
      // guessed to belong to the neighboring plain run during insertion.
      if(pieces.some(piece=>!piece.plain&&(piece.start===piece.end?piece.start>=start&&piece.start<=end:insertion&&piece.start<=start&&start<=piece.end)))refused();
      const candidates=pieces.filter(piece=>piece.plain&&piece.start<=start&&end<=piece.end);
      if(candidates.length!==1)refused();
      const target=candidates[0];
      if(insertion&&target.text){
        // Include one existing character so native replacement inherits this
        // run's formatting instead of ambiguous insertion-point formatting.
        if(start<target.end){const seed=Array.from(previous.slice(start,target.end))[0];end+=seed.length;replacement+=seed}
        else{const seed=Array.from(target.text).at(-1);start-=seed.length;replacement=seed+replacement}
      }else if(insertion&&(pieces.length!==1||paragraphCount!==1))refused();
      if(/[\r\n\u000b\u000c\u0085\u2028\u2029]/.test(previous.slice(start,end)))refused();
      const selected=owner.createTextCursorByRange(target.portion.getStart()),offset=start-target.start;
      if(offset){if(!selected.goRight(offset,true)||selected.getString()!==target.text.slice(0,offset))refused();selected.collapseToEnd()}
      else if(selected.getString()!=='')refused();
      if(end>start&&!selected.goRight(end-start,true))refused();
      if(selected.getString()!==previous.slice(start,end))refused();
      // The only mutation: fields, neighboring runs, paragraph properties and
      // hyperlink objects are never reconstructed or assigned plain strings.
      selected.setString(replacement);
    }
    function action(input) {
      validateAction(input); const e = env();
      if (input.expectedSelectionId !== undefined && selection(e).id !== input.expectedSelectionId) throw Error('文档选区已改变，请在目标位置重新操作。');
      message = ''; metadata = null;
      switch (input.type) {
        case 'list': { editList(e,input.operation); break; }
        case 'insert-text': { const range = cursor(e, input.replaceSelection !== false); e.text.insertString(range, input.text, input.replaceSelection !== false); range.collapseToEnd(); e.view.gotoRange(range, false); break; }
        case 'format-text': {
          const fields = [];
          if (input.fontName !== undefined) for (const name of ['CharFontName','CharFontNameAsian','CharFontNameComplex']) fields.push([name, input.fontName]);
          if (input.fontSize !== undefined) for (const name of ['CharHeight','CharHeightAsian','CharHeightComplex']) fields.push([name, typed('float', input.fontSize)]);
          if (input.bold !== undefined) for (const name of ['CharWeight','CharWeightAsian','CharWeightComplex']) fields.push([name, typed('float', input.bold ? 150 : 100)]);
          if (input.italic !== undefined) for (const name of ['CharPosture','CharPostureAsian','CharPostureComplex']) fields.push([name, input.italic ? css.awt.FontSlant.ITALIC : css.awt.FontSlant.NONE]);
          if (input.underline !== undefined) fields.push(['CharUnderline', typed('short', input.underline ? 1 : 0)]);
          if (input.strikethrough !== undefined) fields.push(['CharStrikeout', typed('short', input.strikethrough ? 1 : 0)]);
          // Native SvxEscapement uses ±14000 for automatic placement, not ±101.
          if (input.baseline !== undefined) { fields.push(['CharEscapement', typed('short', input.baseline === 'superscript' ? 14000 : input.baseline === 'subscript' ? -14000 : 0)]); fields.push(['CharEscapementHeight', typed('byte', input.baseline === 'normal' ? 100 : 58)]); }
          if (input.color !== undefined) fields.push(['CharColor', rgb(input.color)]);
          if (input.highlight !== undefined) { fields.push(['CharBackColor', input.highlight === null ? -1 : rgb(input.highlight)]); if (has(e.view, 'CharBackTransparent')) fields.push(['CharBackTransparent', input.highlight === null]); }
          for (const [name] of fields) if (!has(e.view, name)) throw Error(`此选区不支持 ${name}。`);
          const undo = optional(() => e.model.getUndoManager());
          const grouped = !!undo && typeof undo.enterUndoContext === 'function' && typeof undo.leaveUndoContext === 'function';
          if (grouped) undo.enterUndoContext('文字格式');
          try { for (const [name, value] of fields) set(e.view, name, value); }
          finally { if (grouped) undo.leaveUndoContext(); }
          break;
        }
        case 'format-paragraph': {
          const fields = [];
          if (input.align !== undefined) fields.push(['ParaAdjust', typed('short', {left:0,right:1,justify:2,center:3}[input.align])]);
          if (input.outlineLevel !== undefined) fields.push(['OutlineLevel', typed('short', input.outlineLevel)]);
          for (const [name, property] of Object.entries({leftIndent:'ParaLeftMargin',rightIndent:'ParaRightMargin',firstLineIndent:'ParaFirstLineIndent',spaceAbove:'ParaTopMargin',spaceBelow:'ParaBottomMargin'})) if (input[name] !== undefined) fields.push([property, mm(input[name])]);
          if (input.lineSpacingPercent !== undefined) fields.push(['ParaLineSpacing', new css.style.LineSpacing({ Mode: css.style.LineSpacingMode.PROP, Height: input.lineSpacingPercent })]);
          for (const [name] of fields) if (!has(e.view, name)) throw Error(`此选区不支持 ${name}。`);
          for (const [name, value] of fields) set(e.view, name, value); break;
        }
        case 'set-hyperlink': {
          const selected = selection(e);
          if (selected.collapsed || selected.truncated || !selected.text) throw Error('请先在画布中选中要设置链接的文字，选区不能超过 20,000 字。');
          const active = e.controller.getSelection();
          if (!active || typeof active.getCount !== 'function' || active.getCount() !== 1 || typeof active.getByIndex !== 'function') throw Error('请选中单一文字范围，对象或多选不能设置链接。');
          const range = active.getByIndex(0);
          if (!range || typeof range.getText !== 'function' || !same(range.getText(), e.text)
            || e.text.compareRegionStarts(range, e.view) !== 0 || e.text.compareRegionEnds(range, e.view) !== 0) throw Error('文字选区已改变，请重新选中目标文字。');
          if (!has(e.view, 'HyperLinkURL')) throw Error('此选区不支持超链接。');
          if (typeof dispatch !== 'function') throw Error('链接编辑操作尚未初始化。');
          if (input.url) {
            const property = name => {
              if (!has(e.view, name) || ![0, 1].includes(enumValue(e.view.getPropertyState(name)))) throw Error('此选区的链接设置混合或无法完整读取，请在画布中分别编辑链接。');
              const value = e.view.getPropertyValue(name);
              if (value === undefined) throw Error('无法完整读取此链接，请在画布中编辑。');
              return value;
            };
            const previousUrl = property('HyperLinkURL');
            if (typeof previousUrl !== 'string') throw Error('无法确认当前链接，请在画布中编辑。');
            if (previousUrl) {
              const target = property('HyperLinkTarget'), name = property('HyperLinkName');
              const visited = property('VisitedCharStyleName'), unvisited = property('UnvisitedCharStyleName');
              const events = safeFormatValue(property('HyperLinkEvents'));
              // The native container exposes unbound events as EventType=None,
              // not just empty arrays. No Script/Macro or unknown fields pass.
              const unassignedEvent = value => Array.isArray(value) && (value.length === 0 || (value.length === 1
                && value[0]?.Name === 'EventType' && value[0]?.Value === 'None'
                && Object.keys(value[0]).every(key => ['Name', 'Value', 'Handle', 'State'].includes(key))));
              const noEvents = events === null || events?.emptyContainer === true || (Array.isArray(events?.namedValues) && events.namedValues.every(([, value]) => unassignedEvent(value)));
              const basicStyle = (value, expected) => typeof value === 'string' && (!value || value === expected);
              if (target !== '' || name !== '' || !basicStyle(visited, 'Visited Internet Link') || !basicStyle(unvisited, 'Internet link')
                || !noEvents) throw Error('此链接包含目标窗口、名称、自定义样式或事件；请在画布中编辑，工作台只修改普通链接。');
            }
          }
          const undo = optional(() => e.model.getUndoManager());
          const grouped = !!undo && typeof undo.enterUndoContext === 'function' && typeof undo.leaveUndoContext === 'function';
          if (grouped) undo.enterUndoContext(input.url ? '设置超链接' : '移除超链接');
          try {
            // Clearing or overwriting HyperLinkURL directly drops the previous
            // attribute without a restorable native undo entry. First record
            // its removal through the exact native slot, then apply the new
            // address in the same undo context. Mixed links can only be removed.
            dispatch('.uno:RemoveHyperlink', [new css.beans.PropertyValue({ Name: 'SynchronMode', Value: true })]);
            if (input.url) set(e.view, 'HyperLinkURL', input.url);
          } finally { if (grouped) undo.leaveUndoContext(); }
          message = input.url ? '已为选中文字设置链接。' : '已移除链接，保留文字及手动设置的格式。'; break;
        }
        case 'apply-style': { const styles = e.model.getStyleFamilies().getByName('ParagraphStyles'); if (!styles.hasByName(input.name)) throw Error('段落样式不存在。'); set(e.view, 'ParaStyleName', input.name); break; }
        case 'insert-table': {
          if (selection(e).tableName) throw Error('请先把光标移到表格外，再插入新表格。');
          const table = e.model.createInstance('com.sun.star.text.TextTable'); table.initialize(input.rows, input.columns);
          e.text.insertTextContent(e.view, table, false);
          if (input.cells) { const cells = cellGrid(table, input.rows, input.columns); for (let r=0;r<input.rows;r++) for(let c=0;c<input.columns;c++) cells[r][c].setString(input.cells[r][c]); }
          message = `已插入 ${input.rows} × ${input.columns} 表格。`; break;
        }
        case 'update-table': {
          if (input.expectedTableId !== undefined) return applyTableSnapshot(input, input.expectedRevision === undefined);
          const table = tableByName(e, input.name), size = dimensions(table); matrix(input.cells, size.rows, size.columns);
          const cells = cellGrid(table, size.rows, size.columns);
          // Do not replace unchanged XText: doing so flattens rich text and
          // fields in other cells while the user is editing just one cell.
          const changes = [];
          for (let r=0;r<size.rows;r++) for(let c=0;c<size.columns;c++) if (cells[r][c].getString() !== input.cells[r][c]) {
            if (read(cells[r][c], 'IsProtected', false)) throw Error('目标单元格受到保护，请先在文档中解除保护。');
            changes.push([cells[r][c], input.cells[r][c]]);
          }
          for (const [cell, value] of changes) cell.setString(value); break;
        }
        case 'set-page': {
          const before = pageInfo(e), next = { ...before, ...input };
          if (input.landscape !== undefined && next.landscape !== (next.width > next.height)) [next.width, next.height] = [next.height, next.width];
          if (next.marginLeft + next.marginRight > next.width - 10 || next.marginTop + next.marginBottom > next.height - 10) throw Error('页边距过大，正文区域至少需要 10 毫米。');
          const style = pageStyle(e).style;
          for (const [key, property] of Object.entries({width:'Width',height:'Height',marginLeft:'LeftMargin',marginRight:'RightMargin',marginTop:'TopMargin',marginBottom:'BottomMargin'})) if (mm(next[key]) !== mm(before[key])) set(style, property, mm(next[key]));
          const landscape = input.landscape === undefined ? next.width > next.height : input.landscape;
          if (landscape !== before.landscape) set(style, 'IsLandscape', landscape); break;
        }
        case 'set-header-footer': {
          const style = pageStyle(e).style, prefix = input.target === 'header' ? 'Header' : 'Footer';
          const wasEnabled = style.getPropertyValue(`${prefix}IsOn`);
          if(typeof wasEnabled!=='boolean')throw Error('无法确认当前页眉页脚状态，未修改内容。');
          const existing = wasEnabled ? style.getPropertyValue(`${prefix}Text`) : null;
          const previous = existing ? existing.getString() : '';
          // Writer removes the native content section on disable; this is not
          // a visibility toggle, and an apparently empty range can hold fields
          // or images. Require explicit confirmation even for empty previews.
          if (wasEnabled && !input.enabled && input.confirmRemoval !== true) throw Error('关闭会删除当前页样式中的页眉或页脚，包括页码、字段和图片。请确认删除后再继续。');
          if (input.enabled && input.text !== undefined && previous.length > 5000) throw Error('此页眉页脚超过侧栏的 5000 字范围，请在文档内核中编辑，避免截断内容。');
          if (input.enabled !== wasEnabled) set(style, `${prefix}IsOn`, input.enabled);
          // An unchanged preview must not turn a real PAGE field into text.
          if (input.enabled && input.text !== undefined && input.text !== previous) {
            if(wasEnabled)editDecorationText(existing,previous,input.text);
            else style.getPropertyValue(`${prefix}Text`).setString(input.text);
          }
          break;
        }
        case 'insert-page-number': {
          let owner = e.text, range = cursor(e);
          if (input.target !== 'selection') { const style = pageStyle(e).style, prefix = input.target === 'header' ? 'Header' : 'Footer'; set(style, `${prefix}IsOn`, true); owner = read(style, `${prefix}Text`); range = owner.createTextCursor(); range.gotoEnd(false); }
          const field = e.model.createInstance('com.sun.star.text.textfield.PageNumber');
          set(field, 'NumberingType', typed('short', css.style.NumberingType.ARABIC)); set(field, 'SubType', css.text.PageNumberType.CURRENT);
          owner.insertTextContent(range, field, false);
          if (input.align !== undefined) set(range, 'ParaAdjust', typed('short', {left:0,right:1,center:3}[input.align])); break;
        }
        case 'insert-break': {
          const range = cursor(e, false);
          if (input.kind === 'page' && !same(e.text, e.model.getText())) throw Error('分页符只能插入正文，请先将光标移出表格或页眉页脚。');
          e.text.insertControlCharacter(range, input.kind === 'line' ? css.text.ControlCharacter.LINE_BREAK : css.text.ControlCharacter.PARAGRAPH_BREAK, false);
          range.collapseToEnd(); if (input.kind === 'page') set(range, 'BreakType', css.style.BreakType.PAGE_BEFORE); e.view.gotoRange(range, false); break;
        }
        case 'find-replace': {
          const descriptor = input.replace === undefined ? e.model.createSearchDescriptor() : e.model.createReplaceDescriptor();
          descriptor.setSearchString(input.search);
          set(descriptor, 'SearchCaseSensitive', input.matchCase === true); set(descriptor, 'SearchWords', input.wholeWords === true); set(descriptor, 'SearchRegularExpression', false);
          if (input.replace !== undefined) descriptor.setReplaceString(input.replace);
          if (input.all) { const count = e.model.replaceAll(descriptor); message = `已替换 ${count} 处。`; }
          else {
            // Replace the active native match first. Asking the engine to search
            // from its start preserves whole-word/case semantics; comparing both
            // range ends prevents replacing a merely overlapping substring.
            let found = null;
            if (input.replace !== undefined && !e.view.isCollapsed()) {
              const candidate = e.model.findNext(e.view.getStart(), descriptor);
              if (candidate && same(candidate.getText(), e.text) && e.text.compareRegionStarts(candidate, e.view) === 0 && e.text.compareRegionEnds(candidate, e.view) === 0) found = candidate;
            }
            if (!found) found = e.model.findNext(e.view.getEnd(), descriptor) || e.model.findFirst(descriptor);
            if (!found) message = '未找到匹配内容。';
            else {
              // Verify selection before any text mutation. A selection failure
              // must not report an error after already replacing the document.
              // XSelectionSupplier also handles another table-cell XText.
              if (e.controller.select(found) !== true) throw Error('已找到内容，但无法选中此位置。请在画布中定位后再操作。');
              if (input.replace !== undefined) {
                // An identical replacement must preserve native rich formatting.
                if (found.getString() !== input.replace) found.setString(input.replace);
                // Advance even when only case changes (or text stays identical),
                // otherwise repeated Replace clicks get stuck on the same word.
                const next = optional(() => e.model.findNext(found.getEnd(), descriptor) || e.model.findFirst(descriptor));
                const selectedNext = next && optional(() => e.controller.select(next) === true, false);
                message = selectedNext ? '已替换一处，并选中下一处匹配。' : '已替换一处。';
              } else message = '已选中匹配内容。';
            }
          } break;
        }
        case 'goto-outline': { const range = outlineTargets.get(input.id); if (!range) throw Error('大纲已变化，请刷新后重试。'); e.view.gotoRange(range, false); break; }
        case 'insert-comment': {
          const field = e.model.createInstance('com.sun.star.text.textfield.Annotation'); set(field, 'Author', input.author); set(field, 'Content', input.text);
          // Writer treats annotations specially: absorb=true anchors the entire
          // selected range without deleting its text (unotext.cxx).
          e.text.insertTextContent(e.view, field, true); break;
        }
        case 'navigate-comment':
        case 'delete-comment': {
          const field = commentFields(e)[input.index];
          if (!field) throw Error('批注已变化，请刷新后重试。');
          const anchor = field.getAnchor();
          if (input.type === 'delete-comment') anchor.getText().removeTextContent(field);
          else { e.view.gotoRange(anchor.getStart(), false); e.view.gotoRange(anchor.getEnd(), true); }
          break;
        }
        case 'set-track-changes': {
          const values = [['RecordChanges', input.enabled], ['ShowChanges', input.show]].filter(([,value]) => value !== undefined);
          for (const [name] of values) if (!has(e.model, name)) throw Error('此文档不支持修订设置。');
          for (const [name, value] of values) set(e.model, name, value); break;
        }
        case 'review-changes': {
          const before = countChanges(e);
          const revisionBefore = typeof getRevision === 'function' ? getRevision() : null;
          if (!before) throw Error('文档中没有待审阅的修订。');
          if (typeof dispatch !== 'function') throw Error('审阅操作尚未初始化。');
          const command = input.scope === 'all'
            ? (input.decision === 'accept' ? '.uno:AcceptAllTrackedChanges' : '.uno:RejectAllTrackedChanges')
            : (input.decision === 'accept' ? '.uno:AcceptTrackedChange' : '.uno:RejectTrackedChange');
          // These exact Writer commands accept no document path or caller command.
          // SynchronMode makes the otherwise asynchronous slot finish before
          // checking native redlines and reporting success.
          dispatch(command, [new css.beans.PropertyValue({ Name: 'SynchronMode', Value: true })]);
          const after = countChanges(e);
          const changed = typeof getRevision === 'function' && Number.isSafeInteger(revisionBefore) && getRevision() !== revisionBefore;
          // Accepting the middle of an insertion splits one redline into two;
          // its count can increase although the selected edit was accepted.
          // XModifyListener revision is the synchronous mutation proof there.
          if (after >= before && !changed) throw Error('未处理修订：请选中修订文字，并检查文档是否受到保护。');
          if (input.scope === 'all' && after !== 0) throw Error('仍有修订未处理，请检查保护设置后重试。');
          message = input.scope === 'all' ? `已${input.decision === 'accept' ? '接受' : '拒绝'} ${before - after} 条修订。`
            : `已${input.decision === 'accept' ? '接受' : '拒绝'}当前选区内的修订。`; break;
        }
        case 'insert-footnote': {
          if (!same(e.text, e.model.getText())) throw Error('请先将光标移到正文，再插入注释。');
          const note = e.model.createInstance(input.endnote ? 'com.sun.star.text.Endnote' : 'com.sun.star.text.Footnote');
          e.text.insertTextContent(cursor(e, false), note, false); note.setString(input.text); break;
        }
        case 'insert-toc': {
          if (!same(e.text, e.model.getText())) throw Error('目录只能插入正文。');
          const index = e.model.createInstance('com.sun.star.text.ContentIndex');
          set(index, 'Title', input.title === undefined ? '目录' : input.title); set(index, 'CreateFromOutline', true); set(index, 'Level', typed('short', input.levels === undefined ? 3 : input.levels));
          e.text.insertTextContent(e.view, index, false); index.update(); break;
        }
        case 'update-indexes': { const indexes = e.model.getDocumentIndexes(), count = indexes.getCount(); if (count > 100) throw Error('目录数量超过更新上限。'); for(let i=0;i<count;i++) indexes.getByIndex(i).update(); message = `已更新 ${count} 个目录。`; break; }
      }
      return { message };
    }
    // New immediate commands are validated and executed in one worker turn.
    // This is not a replay of an old draft or a general rich-document CAS.
    function command(input) {
      record(input, ['action', 'target']);
      const proposed = input.action, target = input.target;
      const allowed = ['insert-text','insert-break','insert-table','format-text','format-paragraph','apply-style','set-page','set-header-footer','find-replace'];
      if (!proposed || !allowed.includes(proposed.type) || 'expectedRevision' in proposed || 'expectedSelectionId' in proposed) throw Error('此操作不能作为即时命令执行。');
      validateAction(proposed);
      record(target, ['documentId','revision','selection','textStyle','paragraph','page','tables']);
      for (const field of ['documentId','revision','selection','textStyle','paragraph','page','tables']) if (!Object.prototype.hasOwnProperty.call(target, field)) throw Error('即时命令目标不完整。');
      text(target.documentId, 200, '文档编号', false); number(target.revision, 0, Number.MAX_SAFE_INTEGER, '文档版本', true);
      if (JSON.stringify(target).length > 128 * 1024) throw Error('即时命令目标过大，请在画布中操作。');
      const model = getModel(), live = commandState();
      if (!same(model, getModel())) throw Error('即时命令的文档已切换。');
      function equal(a, b, depth = 0) {
        if (depth > 8) return false;
        if (a === b) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
        const keys = Object.keys(a), other = Object.keys(b);
        return keys.length === other.length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key], depth + 1));
      }
      const selectionCommand = ['insert-text','insert-break','insert-table','format-text','format-paragraph','apply-style'].includes(proposed.type);
      const requireEqual = (before, after) => { if (!equal(before, after)) throw Error('即时命令目标已改变，请在当前目标重新操作。'); };
      if (selectionCommand) requireEqual(target.selection, live.selection);
      if (proposed.type === 'format-text') for (const key of TEXT_STYLE) if (proposed[key] !== undefined) requireEqual(target.textStyle?.[key], live.textStyle[key]);
      if (proposed.type === 'format-paragraph') for (const key of PARAGRAPH) if (proposed[key] !== undefined) requireEqual(target.paragraph?.[key], live.paragraph[key]);
      if (proposed.type === 'apply-style') requireEqual(target.paragraph?.styleName, live.paragraph.styleName);
      if (proposed.type === 'set-page') for (const key of ['styleName', ...PAGE]) requireEqual(target.page?.[key], live.page[key]);
      if (proposed.type === 'set-header-footer') {
        requireEqual(target.page?.styleName, live.page.styleName);
        const enabled = proposed.target === 'header' ? 'headerEnabled' : 'footerEnabled', truncated = proposed.target === 'header' ? 'headerTruncated' : 'footerTruncated';
        if (target.page?.[enabled] !== false || target.page?.[truncated] !== false) throw Error('已有页眉页脚需要使用有版本保护的编辑操作。');
      }
      // Find/replace is an explicit new query on the current document, not a
      // replay of results captured from a prior document revision. No caller-
      // supplied paths, regex programs or dispatch commands are accepted.
      if (live.selection.truncated) throw Error('选区过大，请在画布中缩小选区后操作。');
      const e = env(), actualText = previousSelection.range.getString(), actualCollapsed = e.view.isCollapsed();
      const active = e.controller.getSelection();
      if (!active || typeof active.getCount !== 'function' || typeof active.getByIndex !== 'function' || active.getCount() !== 1) throw Error('请在画布中选择一个文字位置，对象或多选不能使用即时文字命令。');
      const range = active.getByIndex(0);
      if (!range || typeof range.getText !== 'function' || !same(range.getText(), e.text)
        || e.text.compareRegionStarts(range, e.view) !== 0 || e.text.compareRegionEnds(range, e.view) !== 0) throw Error('当前选中的是对象或另一处文字，请重新定位。');
      if (actualText !== live.selection.text || actualCollapsed !== live.selection.collapsed) throw Error('无法确认当前文字选区。');
      if (['insert-text','insert-break','insert-table'].includes(proposed.type) && !actualCollapsed) throw Error('即时插入要求折叠光标，请先在画布中定位。');
      if (proposed.type === 'insert-text' && proposed.replaceSelection === true) throw Error('替换选区必须使用有版本保护的编辑操作。');
      if (proposed.type === 'insert-table' && (live.selection.tableName !== null || !same(e.text, e.model.getText()))) throw Error('请先把光标移到表格外。');
      if (proposed.type === 'set-page' || proposed.type === 'set-header-footer') {
        const actualName = e.view.getPropertyValue('PageStyleName'), style = e.model.getStyleFamilies().getByName('PageStyles').getByName(actualName);
        if (actualName !== live.page.styleName) throw Error('当前页面样式已改变。');
        if (proposed.type === 'set-header-footer') {
          const prefix = proposed.target === 'header' ? 'Header' : 'Footer';
          // Do not treat an optional/fallback display value as proof that an
          // existing native content section is disabled.
          const enabled = style.getPropertyValue(`${prefix}IsOn`);
          if (enabled !== false || proposed.enabled !== true || (proposed.target === 'header' ? live.page.headerTruncated : live.page.footerTruncated)) throw Error('已有页眉页脚需要使用有版本保护的编辑操作。');
        }
      }
      return action({ ...proposed, expectedSelectionId: live.selection.id });
    }
    function data(query) {
      record(query, ['type', 'name']); choice(query.type, ['table'], '数据查询'); text(query.name, 200, '表格名称', false);
      const table = tableByName(env(), query.name), { rows, columns } = dimensions(table), grid = cellGrid(table, rows, columns);
      const tableId = tableIdentity(table), serial = ++readSerial;
      const cells = grid.map(row => row.map(cell => text(cell.getString(), 2000, '单元格文本')));
      const cellSignatures = grid.map((row, r) => row.map((cell, c) => {
        // Bound expensive formatting inspection to the first 64 cells in each
        // explicit data read. Other cells remain editable with a fresh revision,
        // but never receive a permissive stale-write token.
        const signature = r * columns + c < 64 ? cellSignature(cell) : null;
        if (signature === null) return '';
        const token = `${tableId}-read${serial}-${r}-${c}`;
        cellBaselines.set(token, { tableId, row: r, column: c, cell, value: cells[r][c], signature });
        return token;
      }));
      while (cellBaselines.size > 512) cellBaselines.delete(cellBaselines.keys().next().value);
      return { name: query.name, tableId, rows, columns, cells, cellSignatures };
    }
    // Called only after native close succeeds. An unrelated failed-open model
    // must not release the currently displayed document's rule owners.
    function releaseDocument(model) { if(model===currentModel||same(model,currentModel))listRuleOwners=[]; }
    return Object.freeze({ state, action, command, releaseDocument, applyTableSnapshot: input => applyTableSnapshot(input, true), data, validateAction, allowedTypes: new Set(ACTIONS) });
  };
})(globalThis);
