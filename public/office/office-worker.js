/* Runs in the LibreOffice worker, not in the Vue window. SPDX-License-Identifier: MIT */
'use strict';
Module.zetajs.then(zetajs => {
  const css = zetajs.uno.com.sun.star, context = zetajs.getUnoComponentContext();
  const desktop = css.frame.Desktop.create(context);
  const helper = css.frame.DispatchHelper.create(context);
  const prop = (Name, Value) => new css.beans.PropertyValue({ Name, Value });
  const short = value => new zetajs.Any(zetajs.type.short, value);
  const send = message => zetajs.mainPort.postMessage(message);
  const filters = { docx: 'Office Open XML Text', odt: 'writer8', xlsx: 'Calc MS Excel 2007 XML', ods: 'calc8' };
  let current = null, outputCounter = 0;

  function describe(error) {
    try { const exception = zetajs.catchUnoException(error); return exception.Message || String(exception); }
    catch { return String(error?.message || error); }
  }
  // Reject macro confirmations, link updates and password prompts in imported files.
  // Import always uses NEVER_EXECUTE = 0 and NO_UPDATE = 0, even if the user profile changes.
  const rejectInteraction = zetajs.unoObject([css.task.XInteractionHandler], {
    handle(request) {
      for (const continuation of request.getContinuations()) {
        if (continuation.queryInterface(zetajs.type.interface(css.task.XInteractionAbort))) { continuation.select(); return; }
      }
    },
  });
  function nativeRequest(type) {
    if (current) send({ event: 'native-request', documentId: current.id, data: { type } });
  }
  function installInterception(document) {
    let master = null, slave = null;
    const commands = {
      '.uno:Save': 'save', '.uno:SaveAs': 'save-as', '.uno:SaveAll': 'save',
      '.uno:Open': 'open', '.uno:NewDoc': 'new', '.uno:CloseDoc': 'close', '.uno:CloseWin': 'close',
      '.uno:ExportToPDF': 'export-pdf', '.uno:ExportDirectToPDF': 'export-pdf',
      '.uno:Print': 'print', '.uno:PrintDefault': 'print', '.uno:InsertGraphic': 'insert-image',
    };
    const delegates = new Map();
    function dispatchFor(url) {
      const type = commands[url.Complete] || (url.Complete.startsWith('private:factory/') ? 'new' : undefined);
      if (!type) return null;
      if (!delegates.has(type)) delegates.set(type, zetajs.unoObject([css.frame.XDispatch], {
        dispatch() { nativeRequest(type); },
        addStatusListener(listener, featureURL) {
          listener.statusChanged(new css.frame.FeatureStateEvent({ FeatureURL: featureURL, IsEnabled: true, Requery: false }));
        },
        removeStatusListener() {},
      }));
      return delegates.get(type);
    }
    const interceptor = zetajs.unoObject([css.frame.XDispatchProviderInterceptor, css.frame.XInterceptorInfo], {
      getInterceptedURLs() { return [...Object.keys(commands), 'private:factory/*']; },
      queryDispatch(url, frameName, flags) { return dispatchFor(url) || slave?.queryDispatch(url, frameName, flags) || null; },
      queryDispatches(requests) { return requests.map(request => dispatchFor(request.FeatureURL) || slave?.queryDispatch(request.FeatureURL, request.FrameName, request.SearchFlags) || null); },
      getMasterDispatchProvider() { return master; }, setMasterDispatchProvider(value) { master = value; },
      getSlaveDispatchProvider() { return slave; }, setSlaveDispatchProvider(value) { slave = value; },
    });
    const frame = document.model.getCurrentController().getFrame();
    frame.registerDispatchProviderInterceptor(interceptor);
    document.interceptor = interceptor; document.frame = frame; document.delegates = delegates;
  }
  function reportDirty(document) { send({ event: 'dirty', documentId: document.id, data: { dirty: document.dirty, revision: document.revision } }); }
  function closeDocument(document) {
    if (!document) return;
    try { document.model.removeModifyListener(document.listener); } catch {}
    try { document.frame.releaseDispatchProviderInterceptor(document.interceptor); } catch {}
    document.model.setModified(false); document.model.close(true);
  }
  function open(data) {
    if (current?.dirty && !data.discard) throw Error('当前文档有未保存修改。请先保存，或明确放弃修改后再切换。');
    const args = [prop('MacroExecutionMode', short(css.document.MacroExecMode.NEVER_EXECUTE)),
      prop('UpdateDocMode', short(css.document.UpdateDocMode.NO_UPDATE)), prop('InteractionHandler', rejectInteraction),
      prop('ReadOnly', false), prop('Hidden', false)];
    const url = data.isNew ? `private:factory/${data.kind === 'word' ? 'swriter' : 'scalc'}` : `file://${data.path}`;
    const model = desktop.loadComponentFromURL(url, '_default', 0, args);
    if (!model) throw Error('无法打开此文档。请确认文件格式；加密文档请先在原应用解密。');
    const service = data.kind === 'word' ? 'com.sun.star.text.TextDocument' : 'com.sun.star.sheet.SpreadsheetDocument';
    if (!model.supportsService(service)) { model.close(true); throw Error('文件内容与所选文档类型不一致。'); }
    try {
      if (data.isNew && data.kind === 'word') {
        const cursor = model.getText().createTextCursor();
        cursor.setPropertyValue('CharFontNameAsian', 'Noto Sans CJK SC');
        cursor.setPropertyValue('CharFontName', 'Carlito');
      }
      model.setModified(false);
      const document = { id: data.id, name: data.name, kind: data.kind, extension: data.extension, model,
        dirty: false, revision: 0, suppressed: false, path: data.isNew ? null : data.path };
      document.listener = zetajs.unoObject([css.util.XModifyListener], {
        modified() {
          if (current !== document || document.suppressed) return;
          document.dirty = true; document.revision++; reportDirty(document);
        },
        disposing() {},
      });
      model.addModifyListener(document.listener);
      installInterception(document);
      const previous = current;
      closeDocument(previous);
      current = document;
      const closedPath = previous?.path || null;
      const window = document.frame.getContainerWindow(); window.FullScreen = true;
      document.frame.activate(); window.setFocus();
      return { closedPath, id: document.id, dirty: false, revision: 0, language: 'en-US', security: { macros: 'never', externalUpdates: 'never' } };
    } catch (error) { try { model.setModified(false); model.close(true); } catch {} throw error; }
  }
  function exportFile(data) {
    const format = data.format || current.extension;
    const supported = current.kind === 'word' ? ['docx','odt','pdf'] : ['xlsx','ods','pdf'];
    if (!supported.includes(format)) throw Error('当前文档不能导出为此格式。');
    const filter = format === 'pdf' ? (current.kind === 'word' ? 'writer_pdf_Export' : 'calc_pdf_Export') : filters[format];
    const path = `/tmp/open-office-export-${++outputCounter}.${format}`;
    const revision = current.revision;
    current.suppressed = true;
    try {
      current.model.storeToURL(`file://${path}`, [prop('FilterName', filter), prop('Overwrite', true),
        prop('InteractionHandler', rejectInteraction)]);
      current.model.setModified(current.dirty);
    } finally { current.suppressed = false; }
    return { path, extension: format, name: current.name.replace(/\.[^.]+$/, '') + '.' + format, revision };
  }
  function insertImage(path) {
    const provider = css.graphic.GraphicProvider.create(context);
    const graphic = provider.queryGraphic([prop('URL', `file://${path}`)]);
    if (!graphic) throw Error('无法读取这张图片。请尝试 PNG 或 JPEG 格式。');
    let width = 6000, height = 4000;
    try {
      const size = graphic.getPropertyValue('SizePixel');
      if (size.Width > 0 && size.Height > 0) {
        width = Math.min(12000, Math.max(1000, Math.round(size.Width * 26.4583)));
        height = Math.max(500, Math.round(width * size.Height / size.Width));
      }
    } catch {}
    const controller = current.model.getCurrentController();
    if (current.kind === 'word') {
      const object = current.model.createInstance('com.sun.star.text.TextGraphicObject');
      object.setPropertyValue('Graphic', graphic);
      object.setPropertyValue('AnchorType', css.text.TextContentAnchorType.AS_CHARACTER);
      object.setPropertyValue('Width', width); object.setPropertyValue('Height', height);
      const cursor = controller.getViewCursor();
      cursor.getText().insertTextContent(cursor, object, false);
    } else {
      const object = current.model.createInstance('com.sun.star.drawing.GraphicObjectShape');
      controller.getActiveSheet().getDrawPage().add(object);
      object.setPropertyValue('Graphic', graphic);
      object.setSize(new css.awt.Size({ Width: width, Height: height }));
      let point = new css.awt.Point({ X: 1000, Y: 1000 });
      try { point = controller.getSelection().getPosition(); } catch {}
      object.setPosition(point);
    }
    return { dirty: current.dirty, revision: current.revision };
  }
  function smokeTest() {
    const report = { ok: false, engine: 'ZetaOffice / LibreOffice 24.2.8.0', writer: {}, calc: {}, artifacts: [] };
    const models = new Set();
    const args = [prop('Hidden', true), prop('MacroExecutionMode', short(css.document.MacroExecMode.NEVER_EXECUTE)),
      prop('UpdateDocMode', short(css.document.UpdateDocMode.NO_UPDATE)), prop('InteractionHandler', rejectInteraction)];
    const load = url => { const model = desktop.loadComponentFromURL(url, '_blank', 0, args); if (!model) throw Error('Smoke document could not open'); models.add(model); return model; };
    const close = model => { model.setModified(false); model.close(true); models.delete(model); };
    const save = (model, extension, filter) => {
      const path = `/tmp/open-office-smoke-${++outputCounter}.${extension}`; report.artifacts.push({ path, extension });
      model.storeToURL(`file://${path}`, [prop('FilterName', filter), prop('Overwrite', true)]);
      return { path }; 
    };
    try {
      let writer = load('private:factory/swriter');
      writer.getText().setString('Open Office original text · 离线文档');
      const initial = save(writer, 'docx', filters.docx); close(writer);
      writer = load(`file://${initial.path}`);
      if (writer.getText().getString() !== 'Open Office original text · 离线文档') throw Error('DOCX original text did not round-trip');
      writer.getText().setString('Open Office edited original text · 中文测试');
      const edited = save(writer, 'docx', filters.docx); close(writer);
      writer = load(`file://${edited.path}`);
      const text = writer.getText().getString(), pdf = save(writer, 'pdf', 'writer_pdf_Export');
      report.writer = { text, originalTextEdited: text === 'Open Office edited original text · 中文测试', docxPath: edited.path, pdfPath: pdf.path, macrosDisabled: true, linkUpdatesDisabled: true };
      close(writer);
      let calc = load('private:factory/scalc'), sheet = calc.getSheets().getByIndex(0);
      sheet.getCellRangeByName('A1').setValue(40); sheet.getCellRangeByName('A2').setValue(2);
      sheet.getCellRangeByName('A3').setFormula('=SUM(A1:A2)');
      const xlsx = save(calc, 'xlsx', filters.xlsx); close(calc);
      calc = load(`file://${xlsx.path}`); sheet = calc.getSheets().getByIndex(0);
      const calcPdf = save(calc, 'pdf', 'calc_pdf_Export');
      report.calc = { a1: sheet.getCellRangeByName('A1').getValue(), a2: sheet.getCellRangeByName('A2').getValue(),
        formula: sheet.getCellRangeByName('A3').getFormula(), value: sheet.getCellRangeByName('A3').getValue(),
        xlsxPath: xlsx.path, pdfPath: calcPdf.path };
      close(calc);
      report.ok = report.writer.originalTextEdited && report.calc.value === 42 && report.calc.formula === '=SUM(A1:A2)';
      return report;
    } finally {
      for (const model of models) { try { close(model); } catch {} }
      current?.frame.activate(); current?.frame.getContainerWindow().setFocus();
    }
  }
  function execute(message) {
    if (message.action === 'open') return open(message.data);
    if (!current || message.documentId !== current.id) throw Error('当前文档已经切换，旧操作已取消。');
    if (message.action === 'smoke-test') return smokeTest();
    if (message.action === 'insert-image') {
      return insertImage(message.data.path);
    }
    if (message.action === 'export') return exportFile(message.data);
    if (message.action === 'mark-saved') {
      if (message.data.revision === current.revision) {
        current.suppressed = true; current.model.setModified(false); current.suppressed = false;
        current.dirty = false; reportDirty(current);
      }
      return { dirty: current.dirty, revision: current.revision };
    }
    if (message.action === 'discard') {
      current.suppressed = true; current.model.setModified(false); current.suppressed = false;
      current.dirty = false; reportDirty(current); return { dirty: false };
    }
    if (message.action === 'undo' || message.action === 'redo') helper.executeDispatch(current.frame, message.action === 'undo' ? '.uno:Undo' : '.uno:Redo', '', 0, []);
    if (message.action === 'search') {
      const query = String(message.data.query || '').slice(0, 5000);
      helper.executeDispatch(current.frame, query ? '.uno:ExecuteSearch' : '.uno:SearchDialog', '', 0,
        query ? [prop('SearchItem.SearchString', query), prop('SearchItem.Command', short(0)), prop('SearchItem.Backward', false)] : []);
    }
    if (message.action === 'focus') current.frame.getContainerWindow().setFocus();
    return { dirty: current.dirty, revision: current.revision };
  }
  zetajs.mainPort.onmessage = event => {
    const message = event.data;
    if (!message || typeof message.requestId !== 'string') return;
    try { send({ requestId: message.requestId, ok: true, data: execute(message) }); }
    catch (error) { send({ requestId: message.requestId, ok: false, error: describe(error) }); }
  };
  send({ event: 'engine-ready' });
}).catch(error => { console.error('Office worker initialization failed', error); });
