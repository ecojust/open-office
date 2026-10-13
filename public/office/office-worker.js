/* Runs in the LibreOffice worker, not in the Vue window. SPDX-License-Identifier: MIT */
'use strict';
Module.zetajs.then(zetajs => {
  const css = zetajs.uno.com.sun.star, context = zetajs.getUnoComponentContext();
  const desktop = css.frame.Desktop.create(context);
  const helper = css.frame.DispatchHelper.create(context);
  const prop = (Name, Value) => new css.beans.PropertyValue({ Name, Value });
  const short = value => new zetajs.Any(zetajs.type.short, value);
  const send = message => zetajs.mainPort.postMessage(message);
  const filters = { docx: 'Office Open XML Text', odt: 'writer8', xlsx: 'Calc MS Excel 2007 XML', ods: 'calc8',
    pptx: 'Impress MS PowerPoint 2007 XML', odp: 'impress8' };
  const documentTypes = {
    word: { factory: 'swriter', service: 'com.sun.star.text.TextDocument', formats: ['docx','odt'], pdf: 'writer_pdf_Export' },
    sheet: { factory: 'scalc', service: 'com.sun.star.sheet.SpreadsheetDocument', formats: ['xlsx','ods'], pdf: 'calc_pdf_Export' },
    presentation: { factory: 'simpress', service: 'com.sun.star.presentation.PresentationDocument', formats: ['pptx','odp'], pdf: 'impress_pdf_Export' },
  };
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
  function nativeRequest(type, notice, detail = {}) {
    if (current) send({ event: 'native-request', documentId: current.id, data: { type, ...(notice ? { notice } : {}), ...detail } });
  }
  function requestPresentationPreview(fromCurrent = false) {
    if (current?.kind !== 'presentation') throw Error('此操作仅适用于演示文稿。');
    let pageIndex = 0;
    if (fromCurrent) {
      const number = current.model.getCurrentController().getCurrentPage().getPropertyValue('Number');
      if (Number.isInteger(number)) pageIndex = Math.max(0, Math.min(current.model.getDrawPages().getCount() - 1, number - 1));
    }
    nativeRequest('presentation-preview', '静态放映预览不播放动画、音频或视频。', { pageIndex });
    return { pageIndex };
  }
  function installInterception(document) {
    let master = null, slave = null;
    const commands = {
      '.uno:Save': 'save', '.uno:SaveAs': 'save-as', '.uno:SaveACopy': 'save-as', '.uno:SaveAll': 'save',
      '.uno:Open': 'open', '.uno:NewDoc': 'new', '.uno:CloseDoc': 'close', '.uno:CloseWin': 'close',
      '.uno:ExportTo': 'export-pdf', '.uno:ExportToPDF': 'export-pdf', '.uno:ExportDirectToPDF': 'export-pdf',
      '.uno:Print': 'print', '.uno:PrintDefault': 'print', '.uno:PrintPagePreview': 'print',
      '.uno:InsertGraphic': 'insert-image', '.uno:Quit': 'quit',
      '.uno:Presentation': 'presentation-preview', '.uno:PresentationCurrentSlide': 'presentation-preview',
      '.uno:RehearseTimings': 'presentation-preview',
    };
    const notices = { '.uno:ExportTo': '通用导出当前仅支持 PDF；原格式副本请使用“另存为”。' };
    // PrintPreview is a local preview view, not a print job. Keep that view native,
    // but route its PrintPagePreview button through the desktop print notice.
    const delegates = new Map();
    function dispatchFor(url) {
      const type = commands[url.Complete] || (url.Complete.startsWith('private:factory/') ? 'new' : undefined);
      if (!type) return null;
      const notice = notices[url.Complete], fromCurrent = url.Complete === '.uno:PresentationCurrentSlide', key = `${type}:${notice || ''}:${fromCurrent}`;
      if (!delegates.has(key)) delegates.set(key, zetajs.unoObject([css.frame.XDispatch], {
        dispatch() { if (type === 'presentation-preview') requestPresentationPreview(fromCurrent); else nativeRequest(type, notice); },
        addStatusListener(listener, featureURL) {
          listener.statusChanged(new css.frame.FeatureStateEvent({ FeatureURL: featureURL, IsEnabled: true, Requery: false }));
        },
        removeStatusListener() {},
      }));
      return delegates.get(key);
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
    const type = documentTypes[data.kind];
    if (!type || !type.formats.includes(data.extension)) throw Error('不支持的文档类型或格式。');
    if (current?.dirty && !data.discard) throw Error('当前文档有未保存修改。请先保存，或明确放弃修改后再切换。');
    const args = [prop('MacroExecutionMode', short(css.document.MacroExecMode.NEVER_EXECUTE)),
      prop('UpdateDocMode', short(css.document.UpdateDocMode.NO_UPDATE)), prop('InteractionHandler', rejectInteraction),
      prop('ReadOnly', false), prop('Hidden', false)];
    const url = data.isNew ? `private:factory/${type.factory}` : `file://${data.path}`;
    // _default can reuse a clean untitled window and dispose its previous model
    // during load (notably Impress after saving a new presentation). Load into
    // an independent frame, validate it, then explicitly close the old model.
    // A failed import must leave the previous tab's model available for saving.
    const model = desktop.loadComponentFromURL(url, '_blank', 0, args);
    if (!model) throw Error('无法打开此文档。请确认文件格式；加密文档请先在原应用解密。');
    if (!model.supportsService(type.service)) { model.close(true); throw Error('文件内容与所选文档类型不一致。'); }
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
    const type = documentTypes[current.kind], supported = [...type.formats, 'pdf'];
    if (!supported.includes(format)) throw Error('当前文档不能导出为此格式。');
    const filter = format === 'pdf' ? type.pdf : filters[format];
    const path = `/tmp/open-office-export-${++outputCounter}.${format}`;
    const revision = current.revision;
    // UNO isModified is authoritative even if the UI dirty notification is still queued.
    current.dirty = current.model.isModified();
    const dirty = current.dirty;
    current.suppressed = true;
    try {
      current.model.storeToURL(`file://${path}`, [prop('FilterName', filter), prop('Overwrite', true),
        prop('InteractionHandler', rejectInteraction)]);
      current.model.setModified(current.dirty);
    } finally { current.suppressed = false; }
    return { path, extension: format, name: current.name.replace(/\.[^.]+$/, '') + '.' + format, revision, dirty };
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
      const page = current.kind === 'presentation' ? controller.getCurrentPage() : controller.getActiveSheet().getDrawPage();
      if (!page) throw Error('请先选中要插入图片的幻灯片。');
      if (current.kind === 'presentation') {
        // Preserve aspect ratio and keep large images inside the current slide.
        const scale = Math.min(1, Math.max(500, page.getPropertyValue('Width') - 2000) / width,
          Math.max(500, page.getPropertyValue('Height') - 2000) / height);
        width = Math.round(width * scale); height = Math.round(height * scale);
      }
      page.add(object);
      object.setPropertyValue('Graphic', graphic);
      object.setSize(new css.awt.Size({ Width: width, Height: height }));
      let point = new css.awt.Point({ X: 1000, Y: 1000 });
      if (current.kind === 'sheet') { try { point = controller.getSelection().getPosition(); } catch {} }
      object.setPosition(point);
    }
    return { dirty: current.dirty, revision: current.revision };
  }
  function smokeTest() {
    const report = { ok: false, engine: 'ZetaOffice / LibreOffice 24.2.8.0', writer: {}, calc: {}, impress: {}, artifacts: [] };
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
      let impress = load('private:factory/simpress');
      if (!impress.supportsService(documentTypes.presentation.service)) throw Error('Impress document service is unavailable');
      let pages = impress.getDrawPages();
      while (pages.getCount() < 2) pages.insertNewByIndex(pages.getCount());
      while (pages.getCount() > 2) pages.remove(pages.getByIndex(pages.getCount() - 1));
      const addText = (model, page, text) => {
        const shape = model.createInstance('com.sun.star.drawing.TextShape');
        page.add(shape); shape.setPosition(new css.awt.Point({ X: 1500, Y: 1500 }));
        shape.setSize(new css.awt.Size({ Width: 20000, Height: 3000 }));
        shape.getText().setString(text);
        const cursor = shape.getText().createTextCursor();
        cursor.gotoStart(false); cursor.gotoEnd(true);
        cursor.setPropertyValue('CharFontNameAsian', 'Noto Sans CJK SC');
        return shape;
      };
      // Use named real drawing text objects so import verification does not rely
      // on a particular template's placeholder order or language.
      addText(impress, pages.getByIndex(0), 'Open Office original slide · 离线演示').setName('OpenOfficeSmokeTitle');
      addText(impress, pages.getByIndex(1), 'Second slide · 第二页内容').setName('OpenOfficeSmokeSecond');
      const initialPptx = save(impress, 'pptx', filters.pptx); close(impress);
      const findText = (page, expected) => {
        for (let i = 0; i < page.getCount(); i++) {
          const shape = page.getByIndex(i);
          try { if (shape.getText().getString() === expected) return shape; } catch {}
        }
        throw Error('Presentation slide text did not round-trip: ' + expected);
      };
      impress = load(`file://${initialPptx.path}`); pages = impress.getDrawPages();
      if (pages.getCount() !== 2) throw Error('PPTX slide count did not round-trip');
      findText(pages.getByIndex(0), 'Open Office original slide · 离线演示').getText().setString('Open Office edited slide · 中文演示测试');
      findText(pages.getByIndex(1), 'Second slide · 第二页内容');
      const pptx = save(impress, 'pptx', filters.pptx); close(impress);
      impress = load(`file://${pptx.path}`); pages = impress.getDrawPages();
      const texts = [findText(pages.getByIndex(0), 'Open Office edited slide · 中文演示测试').getText().getString(),
        findText(pages.getByIndex(1), 'Second slide · 第二页内容').getText().getString()];
      const pptxReopened = pages.getCount() === 2;
      const odp = save(impress, 'odp', filters.odp); close(impress);
      impress = load(`file://${odp.path}`); pages = impress.getDrawPages();
      const odpRoundTrip = pages.getCount() === 2 && texts.every((text, index) => !!findText(pages.getByIndex(index), text));
      const impressPdf = save(impress, 'pdf', 'impress_pdf_Export');
      report.impress = { slideCount: pages.getCount(), texts, originalTextEdited: texts[0] === 'Open Office edited slide · 中文演示测试',
        pptxReopened, odpReopened: odpRoundTrip, odpRoundTrip, pptxPath: pptx.path, odpPath: odp.path, pdfPath: impressPdf.path, macrosDisabled: true, linkUpdatesDisabled: true };
      close(impress);
      report.ok = report.writer.originalTextEdited && report.calc.value === 42 && report.calc.formula === '=SUM(A1:A2)'
        && report.impress.slideCount === 2 && report.impress.originalTextEdited && report.impress.pptxReopened && report.impress.odpReopened;
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
    if (message.action === 'preview-presentation') return requestPresentationPreview(message.data.fromCurrent === true);
    if (['start-presentation','end-presentation'].includes(message.action)) throw Error('请使用应用中的静态放映预览。');
    if (message.action === 'new-slide') {
      if (current.kind !== 'presentation') throw Error('此操作仅适用于演示文稿。');
      const controller = current.model.getCurrentController();
      const pages = current.model.getDrawPages(), sourcePage = controller.getCurrentPage();
      const page = pages.insertNewByIndex(pages.getCount());
      if (sourcePage) {
        page.setMasterPage(sourcePage.getMasterPage());
        page.setPropertyValue('Layout', sourcePage.getPropertyValue('Layout'));
      }
      controller.setCurrentPage(page);
      return { slideCount: pages.getCount(), dirty: current.model.isModified(), revision: current.revision };
    }
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
      if (!message.data.force && (!Number.isInteger(message.data.revision) || message.data.revision !== current.revision)) {
        throw Error('文档在导出后又有修改，已保留内容。请重新保存或明确放弃修改。');
      }
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
