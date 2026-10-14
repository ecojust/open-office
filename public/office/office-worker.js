/* Runs in the LibreOffice worker, not in the Vue window. SPDX-License-Identifier: MIT */
'use strict';
Module.zetajs.then(zetajs => {
  const css = zetajs.uno.com.sun.star, context = zetajs.getUnoComponentContext();
  const desktop = css.frame.Desktop.create(context);
  const helper = css.frame.DispatchHelper.create(context);
  const prop = (Name, Value) => new css.beans.PropertyValue({ Name, Value });
  const short = value => new zetajs.Any(zetajs.type.short, value);
  const send = message => zetajs.mainPort.postMessage(message);
  const offline = globalThis.OpenOfficeOfflinePolicy;
  if (!offline) throw Error('缺少本地办公安全策略，请重新加载应用。');
  const filters = { docx: 'Office Open XML Text', odt: 'writer8', xlsx: 'Calc MS Excel 2007 XML', ods: 'calc8',
    pptx: 'Impress MS PowerPoint 2007 XML', odp: 'impress8' };
  const documentTypes = {
    word: { factory: 'swriter', service: 'com.sun.star.text.TextDocument', imports: ['docx','odt','doc','rtf'], formats: ['docx','odt'], pdf: 'writer_pdf_Export' },
    sheet: { factory: 'scalc', service: 'com.sun.star.sheet.SpreadsheetDocument', imports: ['xlsx','ods','xls'], formats: ['xlsx','ods'], pdf: 'calc_pdf_Export' },
    presentation: { factory: 'simpress', service: 'com.sun.star.presentation.PresentationDocument', imports: ['pptx','odp','ppt'], formats: ['pptx','odp'], pdf: 'impress_pdf_Export' },
  };
  let current = null, outputCounter = 0;
  const presentationObjects = typeof createPresentationObjects === 'function'
    ? createPresentationObjects({ zetajs, css, getModel: () => current?.model }) : null;
  const toolContext = { zetajs, css, getModel: () => current?.model, getRevision: () => current?.revision ?? 0,
    dispatch: (command, args = []) => helper.executeDispatch(current.frame, command, '', 0, args) };
  const writerTools = typeof createWriterTools === 'function' ? createWriterTools(toolContext) : null;
  const calcTools = typeof createCalcTools === 'function' ? createCalcTools(toolContext) : null;
  const presentationLayouts = new Set([0, 1, 3, 12, 14, 15, 16, 18, 19, 20, 32, 34]);

  function describe(error) {
    try { const exception = zetajs.catchUnoException(error); return exception.Message || String(exception); }
    catch { return String(error?.message || error); }
  }
  function recoverOptional(error) {
    // Catching a raw UNO WASM exception without the SDK helper leaves its native
    // exception reference alive. Consume only exceptions we intentionally ignore;
    // errors rethrown to the RPC boundary are consumed once by describe().
    if (error instanceof WebAssembly.RuntimeError) throw error;
    if (error instanceof Error) return;
    try { zetajs.catchUnoException(error); }
    catch (caught) { if (caught instanceof WebAssembly.RuntimeError) throw caught; }
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
    nativeRequest('presentation-preview', '使用内置放映器播放已支持的转场与本地媒体。', { pageIndex });
    return { pageIndex };
  }
  function installInterception(document) {
    let master = null, slave = null;
    const commands = {
      '.uno:Save': 'save', '.uno:SaveAs': 'save-as', '.uno:SaveACopy': 'save-as', '.uno:SaveAll': 'save',
      '.uno:Open': 'open', '.uno:OpenFromWriter': 'open', '.uno:OpenFromCalc': 'open',
      '.uno:OpenFromDraw': 'open', '.uno:OpenFromImpress': 'open', '.uno:OpenLocalURL': 'open',
      '.uno:NewDoc': 'new', '.uno:CloseDoc': 'close', '.uno:CloseWin': 'close',
      '.uno:ExportTo': 'export-pdf', '.uno:ExportToPDF': 'export-pdf', '.uno:ExportDirectToPDF': 'export-pdf',
      '.uno:Print': 'print', '.uno:PrintDefault': 'print', '.uno:PrintPagePreview': 'print',
      '.uno:InsertGraphic': 'insert-image', '.uno:Quit': 'quit',
      '.uno:Presentation': 'presentation-preview', '.uno:PresentationCurrentSlide': 'presentation-preview',
      '.uno:RehearseTimings': 'presentation-preview',
      ...(document.kind === 'presentation' ? {
        '.uno:DuplicatePage': 'presentation-duplicate', '.uno:DuplicateSlide': 'presentation-duplicate',
      } : {}),
    };
    const notices = { '.uno:ExportTo': '通用导出当前仅支持 PDF；原格式副本请使用“另存为”。' };
    // PrintPreview is a local preview view, not a print job. Keep that view native,
    // but route its PrintPagePreview button through the desktop print notice.
    const delegates = new Map();
    function dispatchFor(url) {
      if (offline.blockedDispatch(url.Complete)) {
        if (!delegates.has('offline-blocked')) delegates.set('offline-blocked', zetajs.unoObject([css.frame.XDispatch], {
          dispatch() {},
          addStatusListener(listener, featureURL) {
            listener.statusChanged(new css.frame.FeatureStateEvent({ FeatureURL: featureURL, IsEnabled: false, Requery: false }));
          },
          removeStatusListener() {},
        }));
        return delegates.get('offline-blocked');
      }
      const normalized = offline.commandName(url.Complete), complete = normalized ? `.uno:${normalized}` : url.Complete;
      const type = commands[complete] || (complete.startsWith('private:factory/') ? 'new' : undefined);
      if (!type) return null;
      const notice = notices[complete], fromCurrent = complete === '.uno:PresentationCurrentSlide', key = `${type}:${notice || ''}:${fromCurrent}`;
      if (!delegates.has(key)) delegates.set(key, zetajs.unoObject([css.frame.XDispatch], {
        dispatch(featureURL, args = []) {
          if (current !== document || offline.blockedDispatch(featureURL?.Complete || complete, args)) return;
          if (type === 'presentation-preview') requestPresentationPreview(fromCurrent);
          else if (type === 'presentation-duplicate') {
            // The shell duplicates both the real UNO page and its preserved
            // PPTX media/transition metadata as one operation.
            if (current === document) nativeRequest(type, undefined, { pageIndex: activeSlideIndex() });
          } else nativeRequest(type, notice);
        },
        addStatusListener(listener, featureURL) {
          listener.statusChanged(new css.frame.FeatureStateEvent({ FeatureURL: featureURL, IsEnabled: true, Requery: false }));
        },
        removeStatusListener() {},
      }));
      return delegates.get(key);
    }
    function resolveDispatch(url, frameName, flags) {
      const own = dispatchFor(url);
      if (own) return own;
      const delegate = slave?.queryDispatch(url, frameName, flags);
      if (!delegate) return null;
      if (!offline.needsArgumentGuard(url.Complete)) return delegate;
      // A previously unblocked command can still carry a remote URL argument
      // only at dispatch time. Guard that path without changing local actions.
      const key = `guarded:${url.Complete}:${frameName}:${flags}`;
      if (delegates.has(key)) return delegates.get(key);
      const guarded = zetajs.unoObject([css.frame.XDispatch], {
        dispatch(featureURL, args = []) {
          if (current === document && !offline.blockedDispatch(featureURL?.Complete || url.Complete, args)) delegate.dispatch(featureURL, args);
        },
        addStatusListener(listener, featureURL) { delegate.addStatusListener(listener, featureURL); },
        removeStatusListener(listener, featureURL) { delegate.removeStatusListener(listener, featureURL); },
      });
      delegates.set(key, guarded); return guarded;
    }
    const interceptor = zetajs.unoObject([css.frame.XDispatchProviderInterceptor, css.frame.XInterceptorInfo], {
      getInterceptedURLs() { return offline.interceptedURLs(Object.keys(commands)); },
      queryDispatch(url, frameName, flags) { return resolveDispatch(url, frameName, flags); },
      queryDispatches(requests) { return requests.map(request => resolveDispatch(request.FeatureURL, request.FrameName, request.SearchFlags)); },
      getMasterDispatchProvider() { return master; }, setMasterDispatchProvider(value) { master = value; },
      getSlaveDispatchProvider() { return slave; }, setSlaveDispatchProvider(value) { slave = value; },
    });
    const frame = document.model.getCurrentController().getFrame();
    frame.registerDispatchProviderInterceptor(interceptor);
    document.interceptor = interceptor; document.frame = frame; document.delegates = delegates;
  }
  function reportDirty(document) { send({ event: 'dirty', documentId: document.id, data: { dirty: document.dirty, revision: document.revision } }); }
  function reportWorkbenchChanged(document) {
    if (current === document) send({ event: document.kind === 'presentation' ? 'presentation-changed' : 'workbench-changed', documentId: document.id });
  }
  function listenWorkbench(document) {
    const controller = document.model.getCurrentController();
    document.controller = controller;
    try {
      document.selectionListener = zetajs.unoObject([css.view.XSelectionChangeListener], {
        selectionChanged() { reportWorkbenchChanged(document); }, disposing() {},
      });
      controller.addSelectionChangeListener(document.selectionListener);
    } catch (error) { recoverOptional(error); document.selectionListener = null; }
    if (document.kind === 'presentation') try {
      document.pageListener = zetajs.unoObject([css.beans.XPropertyChangeListener], {
        propertyChange() { reportWorkbenchChanged(document); }, disposing() {},
      });
      controller.addPropertyChangeListener('CurrentPage', document.pageListener);
    } catch (error) { recoverOptional(error); document.pageListener = null; }
  }
  const CHART_CLSID = '12DCAE26-281F-416F-A234-C3086127382E';
  function sameChartObject(left, right) {
    try { return !!left && !!right && zetajs.sameUnoObject(left, right); }
    catch (error) { recoverOptional(error); return false; }
  }
  // Inspect embedded Model only after positively identifying the chart CLSID.
  // Model starts an embedded client; ordinary OLE objects must never be opened
  // as a side effect of collecting evidence for a chart repair.
  function chartProperty(shape, name) {
    const info = shape.getPropertySetInfo();
    return info?.hasPropertyByName(name) ? shape.getPropertyValue(name) : undefined;
  }
  function chartShapeName(shape) {
    const info = shape.getPropertySetInfo?.();
    const name = info?.hasPropertyByName('Name') ? shape.getPropertyValue('Name')
      : typeof shape.getName === 'function' ? shape.getName() : undefined;
    return typeof name === 'string' && name.length > 0 && name.length <= 300 && !/[\x00-\x1f\x7f]/.test(name) ? name : null;
  }
  function scanCharts(document) {
    const result = { complete: true, items: [], names: new Map() };
    let visited = 0;
    try {
      const pages = document.model.getDrawPages(), count = pages.getCount();
      if (!Number.isInteger(count) || count < 0 || count > 500) { result.complete = false; return result; }
      for (let index = 0; index < count; index++) {
        const page = pages.getByIndex(index), names = new Map(); result.names.set(page, names);
        const walk = (container, depth) => {
          if (depth > 16) { result.complete = false; return; }
          const length = container.getCount();
          if (!Number.isInteger(length) || length < 0 || length > 2000 || visited + length > 20000) { result.complete = false; return; }
          visited += length;
          for (let shapeIndex = 0; shapeIndex < length; shapeIndex++) {
            try {
              const shape = container.getByIndex(shapeIndex), name = chartShapeName(shape), type = shape.getShapeType();
              if (name) names.set(name, (names.get(name) || 0) + 1);
              if (type === 'com.sun.star.drawing.GroupShape') { walk(shape, depth + 1); continue; }
              if (typeof type !== 'string' || !/OLE2Shape$/.test(type)) continue;
              const clsid = chartProperty(shape, 'CLSID');
              if (typeof clsid !== 'string' || clsid.replace(/[{}]/g, '').toUpperCase() !== CHART_CLSID) continue;
              if (!name) { result.complete = false; continue; }
              result.items.push({ page, shape, name });
            } catch (error) { recoverOptional(error); result.complete = false; }
          }
        };
        walk(page, 0);
      }
    } catch (error) { recoverOptional(error); result.complete = false; }
    return result;
  }
  function removeChartMonitor(document) {
    for (const record of document.chartMonitor?.records || []) {
      if (record.attached) try { record.modifiable.removeModifyListener(record.listener); }
      catch (error) { recoverOptional(error); }
      record.attached = false;
    }
  }
  function installChartMonitor(document) {
    if (document.kind !== 'presentation') return;
    const monitor = document.chartMonitor = { complete: false, records: [] };
    try {
      const scan = scanCharts(document); monitor.complete = scan.complete;
      for (const item of scan.items) {
        const record = { ...item, model: null, modifiable: null, listener: null, attached: false,
          initialNameUnique: scan.names.get(item.page)?.get(item.name) === 1, initiallyClean: false, touched: false, disposed: false };
        monitor.records.push(record);
        try {
          record.model = chartProperty(item.shape, 'Model');
          if (!record.model || typeof record.model.queryInterface !== 'function') continue;
          record.modifiable = record.model.queryInterface(zetajs.type.interface(css.util.XModifiable));
          if (!record.modifiable) continue;
          record.listener = zetajs.unoObject([css.util.XModifyListener], {
            // Never reset this on Save/Undo or suppress it during an export.
            // Identical caches cannot prove that bindings were not edited.
            modified() { record.touched = true; },
            disposing() { record.disposed = true; },
          });
          record.modifiable.addModifyListener(record.listener); record.attached = true;
          record.initiallyClean = record.modifiable.isModified() === false && record.initialNameUnique;
        } catch (error) { recoverOptional(error); }
      }
    } catch (error) { removeChartMonitor(document); throw error; }
  }
  function chartModificationProof(document) {
    const monitor = document.chartMonitor, scan = scanCharts(document), proof = [];
    for (const item of scan.items) {
      let sourceEligible = false, sourceShapeName;
      const record = monitor?.records.find(record => sameChartObject(record.page, item.page) && sameChartObject(record.shape, item.shape));
      if (monitor?.complete && scan.complete && record?.attached && record.initialNameUnique && !record.disposed
        && scan.names.get(item.page)?.get(item.name) === 1) {
        try {
          const model = chartProperty(item.shape, 'Model');
          if (sameChartObject(record.model, model)) {
            // Impress can renumber autogenerated names after slide reordering.
            // Native identities prove the source association even after edits;
            // only the separate modification evidence authorizes data reuse.
            sourceShapeName = record.name;
            sourceEligible = record.initiallyClean && record.modifiable.isModified() === false && !record.touched && !record.disposed;
          }
        } catch (error) { recoverOptional(error); }
      }
      const pageId = slideIdentity(item.page);
      if (typeof pageId === 'string' && pageId.length <= 500 && !/[\x00-\x1f\x7f]/.test(pageId)) {
        proof.push({ pageId, shapeName: item.name, sourceEligible, ...(sourceShapeName ? { sourceShapeName } : {}) });
      }
    }
    return proof;
  }
  function beginChartNavigation(document) {
    const scan = scanCharts(document), monitor = document.chartMonitor, candidates = [];
    if (!monitor?.complete || !scan.complete) return candidates;
    for (const record of monitor.records) {
      if (!record.attached || !record.initiallyClean || record.touched || record.disposed) continue;
      const item = scan.items.find(item => sameChartObject(item.page, record.page) && sameChartObject(item.shape, record.shape));
      if (!item || scan.names.get(item.page)?.get(item.name) !== 1) continue;
      try {
        if (sameChartObject(record.model, chartProperty(item.shape, 'Model')) && record.modifiable.isModified() === false
          && !record.touched && !record.disposed) candidates.push({ record, model: record.model });
      } catch (error) { recoverOptional(error); }
    }
    return candidates;
  }
  function finishChartNavigation(document, candidates) {
    if (!candidates?.length) return;
    const scan = scanCharts(document);
    if (!scan.complete) return;
    for (const candidate of candidates) {
      const record = candidate.record;
      // Renewal is confined to a verified synchronous page-navigation command.
      // A prior edit, an unrelated replacement, or a disposal observed before
      // that command can never regain source-data authorization here.
      if (record.model !== candidate.model || !record.disposed || record.touched) continue;
      const item = scan.items.find(item => sameChartObject(item.page, record.page) && sameChartObject(item.shape, record.shape));
      if (!item || scan.names.get(item.page)?.get(item.name) !== 1) continue;
      let modifiable, listener, attached = false, disposed = false, accepted = false;
      try {
        const model = chartProperty(item.shape, 'Model');
        if (!model || sameChartObject(record.model, model) || typeof model.queryInterface !== 'function') continue;
        modifiable = model.queryInterface(zetajs.type.interface(css.util.XModifiable));
        if (!modifiable || modifiable.isModified() !== false) continue;
        listener = zetajs.unoObject([css.util.XModifyListener], {
          modified() { record.touched = true; },
          disposing() { disposed = true; record.disposed = true; },
        });
        modifiable.addModifyListener(listener); attached = true;
        if (modifiable.isModified() !== false || disposed || record.touched) continue;
        try { record.modifiable.removeModifyListener(record.listener); } catch (error) { recoverOptional(error); }
        if (disposed || record.touched) continue;
        record.model = model; record.modifiable = modifiable; record.listener = listener;
        record.attached = true; record.disposed = false; accepted = true;
      } catch (error) { recoverOptional(error); }
      finally {
        if (attached && !accepted) try { modifiable.removeModifyListener(listener); } catch (error) { recoverOptional(error); }
      }
    }
  }
  function closeDocument(document) {
    if (!document) return;
    removeChartMonitor(document);
    try { document.model.removeModifyListener(document.listener); } catch (error) { recoverOptional(error); }
    try { if (document.selectionListener) document.controller.removeSelectionChangeListener(document.selectionListener); } catch (error) { recoverOptional(error); }
    try { if (document.pageListener) document.controller.removePropertyChangeListener('CurrentPage', document.pageListener); } catch (error) { recoverOptional(error); }
    try { document.frame.releaseDispatchProviderInterceptor(document.interceptor); } catch (error) { recoverOptional(error); }
    document.model.setModified(false); document.model.close(true);
    // Release temporary numbering owners only after the native document closed.
    // A vetoed close must keep the live document and its redo resources intact.
    if (document.kind === 'word') writerTools?.releaseDocument?.(document.model);
  }
  function open(data) {
    const type = documentTypes[data.kind];
    if (!type || !type.imports.includes(data.extension)) throw Error('不支持的文档类型或格式。');
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
    let openingDocument = null;
    try {
      if (data.isNew && data.kind === 'word') {
        const cursor = model.getText().createTextCursor();
        cursor.setPropertyValue('CharFontNameAsian', 'Noto Sans CJK SC');
        cursor.setPropertyValue('CharFontName', 'Carlito');
      }
      model.setModified(false);
      const document = openingDocument = { id: data.id, name: data.name, kind: data.kind, extension: data.extension, model,
        dirty: false, revision: 0, suppressed: false, path: data.isNew ? null : data.path,
        pageIdentities: [], nextPageIdentity: 0 };
      document.listener = zetajs.unoObject([css.util.XModifyListener], {
        modified() {
          if (current !== document || document.suppressed) return;
          // DocChanged is also emitted after clearing Writer's modified flag.
          // Keep every notification in the revision sequence, but derive dirty
          // from the model so a late clean notification cannot invent edits.
          document.dirty = document.model.isModified(); document.revision++; reportDirty(document);
        },
        disposing() {},
      });
      model.addModifyListener(document.listener);
      installInterception(document);
      listenWorkbench(document);
      installChartMonitor(document);
      const previous = current;
      // Closing the old frame can activate and resize Calc. Prepare its loaded
      // window first so that activation does not use the default small size.
      // If window setup fails, the old document is still available for saving.
      const preparedWindow = data.kind === 'sheet' ? document.frame.getContainerWindow() : null;
      if (data.kind === 'sheet' && !preparedWindow) throw Error('无法准备新表格窗口。');
      if (preparedWindow) preparedWindow.FullScreen = true;
      closeDocument(previous);
      current = document;
      const closedPath = previous?.path || null;
      const window = preparedWindow || document.frame.getContainerWindow();
      if (!preparedWindow) window.FullScreen = true;
      document.frame.activate(); window.setFocus();
      return { closedPath, id: document.id, dirty: false, revision: 0, language: 'en-US', security: { macros: 'never', externalUpdates: 'never' } };
    } catch (error) { if (openingDocument) removeChartMonitor(openingDocument); try { model.setModified(false); model.close(true); } catch (error) { recoverOptional(error); } throw error; }
  }
  function exportFile(data) {
    const format = data.format || ({ doc: 'docx', rtf: 'docx', xls: 'xlsx', ppt: 'pptx' }[current.extension] || current.extension);
    const type = documentTypes[current.kind], supported = [...type.formats, 'pdf'];
    if (!supported.includes(format)) throw Error('当前文档不能导出为此格式。');
    const filter = format === 'pdf' ? type.pdf : filters[format];
    const path = `/tmp/open-office-export-${++outputCounter}.${format}`;
    const revision = current.revision;
    const proofBefore = current.kind === 'presentation' && format === 'pptx' ? chartModificationProof(current) : null;
    // UNO isModified is authoritative even if the UI dirty notification is still queued.
    current.dirty = current.model.isModified();
    const dirty = current.dirty;
    current.suppressed = true;
    try {
      const args = [prop('FilterName', filter), prop('Overwrite', true), prop('InteractionHandler', rejectInteraction)];
      if (format === 'pdf' && current.kind === 'presentation') {
        // Keep PDF page indices aligned with the complete slide list. The player
        // decides which hidden slides to skip, rather than losing their mapping.
        args.push(prop('FilterData', new zetajs.Any(zetajs.type.sequence(zetajs.type.struct(css.beans.PropertyValue)), [prop('ExportHiddenSlides', true)])));
      }
      current.model.storeToURL(`file://${path}`, args);
      // Writer broadcasts DocChanged even for true -> true. A native export
      // normally leaves this flag intact; avoid creating another modification
      // notification when there is no flag to restore.
      if (current.model.isModified() !== dirty) current.model.setModified(dirty);
    } finally { current.suppressed = false; }
    const chartProof = proofBefore && chartModificationProof(current).map(proof => {
      const before = proofBefore.find(before => before.pageId === proof.pageId && before.sourceShapeName
        && before.sourceShapeName === proof.sourceShapeName);
      // An association must exist on both sides of export; never forward a new
      // identity claim first observed after native serialization.
      const sourceShapeName = before?.sourceShapeName && before.sourceShapeName === proof.sourceShapeName ? proof.sourceShapeName : undefined;
      return { pageId: proof.pageId, shapeName: proof.shapeName, sourceEligible: !!sourceShapeName && proof.sourceEligible && before.sourceEligible,
        ...(sourceShapeName ? { sourceShapeName } : {}) };
    });
    return { path, extension: format, name: current.name.replace(/\.[^.]+$/, '') + '.' + format, revision, dirty,
      ...(chartProof ? { chartProof } : {}) };
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
    } catch (error) { recoverOptional(error); }
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
      if (current.kind === 'sheet') { try { point = controller.getSelection().getPosition(); } catch (error) { recoverOptional(error); } }
      object.setPosition(point);
    }
    return { dirty: current.dirty, revision: current.revision };
  }
  function requirePresentation() {
    if (current?.kind !== 'presentation') throw Error('此操作仅适用于演示文稿。');
    return current.model;
  }
  function slideAt(index) {
    const pages = requirePresentation().getDrawPages();
    if (!Number.isInteger(index) || index < 0 || index >= pages.getCount()) throw Error('幻灯片索引无效，请刷新页面列表。');
    return pages.getByIndex(index);
  }
  function activeSlideIndex() {
    const model = requirePresentation(), page = model.getCurrentController().getCurrentPage();
    const index = page.getPropertyValue('Number') - 1;
    if (!Number.isInteger(index) || index < 0 || index >= model.getDrawPages().getCount()) throw Error('未能读取当前幻灯片，请切换到普通视图。');
    return index;
  }
  function slideText(shape) {
    try { return typeof shape.getText === 'function' ? String(shape.getText().getString() || '') : ''; }
    catch (error) { recoverOptional(error); return ''; }
  }
  function slideTitle(page) {
    let fallback = '';
    for (let index = 0; index < page.getCount(); index++) {
      const shape = page.getByIndex(index), text = slideText(shape).trim();
      if (!text) continue;
      if (!fallback) fallback = text;
      try { if (shape.getShapeType() === 'com.sun.star.presentation.TitleTextShape') return text.slice(0, 160); } catch (error) { recoverOptional(error); }
      try { if (shape.supportsService('com.sun.star.presentation.TitleTextShape')) return text.slice(0, 160); } catch (error) { recoverOptional(error); }
    }
    return fallback.slice(0, 160);
  }
  function slideIdentity(page) {
    for (const item of current.pageIdentities) {
      try { if (zetajs.sameUnoObject(item.page, page)) return item.id; } catch (error) { recoverOptional(error); }
    }
    const id = `${current.id}:slide:${++current.nextPageIdentity}`;
    current.pageIdentities.push({ page, id }); return id;
  }
  function slideSummary(page, index) {
    return { id: slideIdentity(page), index, name: page.getName(), title: slideTitle(page),
      hidden: page.getPropertyValue('Visible') === false, layout: page.getPropertyValue('Layout') };
  }
  function notesShape(page, create = false) {
    const notes = page.getNotesPage();
    let empty = null;
    for (let index = 0; index < notes.getCount(); index++) {
      const shape = notes.getByIndex(index);
      // Impress exposes NotesShape as its shape type but lists only the generic
      // TextShape service after OOXML import. Checking supportsService alone
      // misses real notes and creates duplicate body placeholders on every edit.
      let isNotes = false;
      try { isNotes = shape.getShapeType() === 'com.sun.star.presentation.NotesShape'; } catch (error) { recoverOptional(error); }
      if (!isNotes) { try { isNotes = shape.supportsService('com.sun.star.presentation.NotesShape'); } catch (error) { recoverOptional(error); } }
      if (isNotes) { if (slideText(shape)) return shape; if (!empty) empty = shape; }
    }
    if (empty) return empty;
    if (!create) return null;
    const shape = current.model.createInstance('com.sun.star.presentation.NotesShape');
    notes.add(shape);
    shape.setPosition(new css.awt.Point({ X: 1500, Y: Math.round(notes.getPropertyValue('Height') * .5) }));
    shape.setSize(new css.awt.Size({ Width: Math.max(1000, notes.getPropertyValue('Width') - 3000), Height: Math.max(1000, Math.round(notes.getPropertyValue('Height') * .4)) }));
    return shape;
  }
  function slideBackground(page) {
    const background = page.getPropertyValue('Background');
    if (!background) return { type: 'none' };
    const style = background.getPropertyValue('FillStyle');
    if (style === css.drawing.FillStyle.NONE) return { type: 'none' };
    if (style === css.drawing.FillStyle.SOLID) return { type: 'solid', color: '#' + (background.getPropertyValue('FillColor') >>> 0).toString(16).padStart(6, '0').slice(-6).toUpperCase() };
    return { type: 'other' };
  }
  function presentationState() {
    const model = requirePresentation(), pages = model.getDrawPages(), currentPageIndex = activeSlideIndex();
    const page = pages.getByIndex(currentPageIndex), summaries = [];
    for (let index = 0; index < pages.getCount(); index++) summaries.push(slideSummary(pages.getByIndex(index), index));
    const shape = notesShape(page), objectState = presentationObjects?.listObjects();
    current.dirty = model.isModified();
    return { documentId: current.id, revision: current.revision, dirty: current.dirty,
      pageCount: pages.getCount(), currentPageIndex,
      pageSize: { width: page.getPropertyValue('Width') / 100, height: page.getPropertyValue('Height') / 100 },
      pages: summaries,
      currentPage: { ...summaries[currentPageIndex], background: slideBackground(page), notes: shape ? slideText(shape) : '' },
      objects: objectState?.objects || [], selectedObjectIds: objectState?.selectedIds || [] };
  }
  function checkedLayout(value) {
    if (!Number.isInteger(value) || !presentationLayouts.has(value)) throw Error('请选择受支持的普通幻灯片布局。');
    return value;
  }
  function presentationAction(data) {
    const model = requirePresentation(), pages = model.getDrawPages(), controller = model.getCurrentController();
    if (!data || typeof data !== 'object') throw Error('演示文稿操作无效。');
    if (data.expectedRevision !== undefined && data.expectedRevision !== current.revision) throw Error('演示文稿已更新，请刷新后再操作，未应用过期更改。');
    const pageIndex = data.pageIndex === undefined ? activeSlideIndex() : data.pageIndex;
    const page = slideAt(pageIndex);
    const chartNavigation = ['select-page', 'move-page'].includes(data.type) ? beginChartNavigation(current) : null;
    switch (data.type) {
      case 'select-page': controller.setCurrentPage(page); break;
      case 'add-page': {
        const layout = checkedLayout(data.layout === undefined ? page.getPropertyValue('Layout') : data.layout);
        const added = pages.insertNewByIndex(pages.getCount());
        added.setMasterPage(page.getMasterPage()); added.setPropertyValue('Layout', layout);
        controller.setCurrentPage(added); break;
      }
      case 'duplicate-page': {
        const copy = model.duplicate(page); controller.setCurrentPage(copy); break;
      }
      case 'delete-page': {
        if (pages.getCount() <= 1) throw Error('演示文稿至少需要保留一张幻灯片。');
        pages.remove(page); controller.setCurrentPage(pages.getByIndex(Math.min(pageIndex, pages.getCount() - 1))); break;
      }
      case 'move-page': {
        if (!['up', 'down'].includes(data.direction)) throw Error('页面移动方向无效。');
        const targetIndex = pageIndex + (data.direction === 'up' ? -1 : 1);
        if (targetIndex < 0 || targetIndex >= pages.getCount()) throw Error('幻灯片已在此方向的边界。');
        // A real page change clears the embedded sorter's previous multi-page
        // selection. Selecting the already-current page is a no-op in Impress,
        // so visit a different slide first and verify both actual view changes.
        controller.setCurrentPage(pages.getByIndex(pageIndex === 0 ? 1 : 0));
        if (activeSlideIndex() === pageIndex) throw Error('当前视图未能切换幻灯片，未执行移动。');
        controller.setCurrentPage(page);
        if (activeSlideIndex() !== pageIndex) throw Error('当前视图未能选择目标幻灯片，未执行移动。');
        const before = [];
        for (let index = 0; index < pages.getCount(); index++) before.push(slideIdentity(pages.getByIndex(index)));
        const expected = [...before], [moved] = expected.splice(pageIndex, 1); expected.splice(targetIndex, 0, moved);
        helper.executeDispatch(current.frame, data.direction === 'up' ? '.uno:MovePageUp' : '.uno:MovePageDown', '', 0, []);
        for (let index = 0; index < pages.getCount(); index++) if (slideIdentity(pages.getByIndex(index)) !== expected[index]) throw Error('当前视图未能按预期移动幻灯片，请刷新后检查页面顺序。');
        controller.setCurrentPage(pages.getByIndex(targetIndex)); break;
      }
      case 'set-hidden':
        if (typeof data.value !== 'boolean') throw Error('隐藏状态必须为布尔值。');
        page.setPropertyValue('Visible', !data.value); break;
      case 'rename-page': {
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 150) throw Error('幻灯片名称需要为 1–150 个字符。');
        const name = data.name.trim();
        for (let index = 0; index < pages.getCount(); index++) if (index !== pageIndex && pages.getByIndex(index).getName() === name) throw Error('已有同名幻灯片，请使用不同名称。');
        page.setName(name); break;
      }
      case 'set-layout': page.setPropertyValue('Layout', checkedLayout(data.layout)); break;
      case 'set-background': {
        if (data.color !== null && (typeof data.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.color))) throw Error('背景颜色需要为 #RRGGBB 或空值。');
        const background = model.createInstance('com.sun.star.drawing.Background');
        background.setPropertyValue('FillStyle', data.color === null ? css.drawing.FillStyle.NONE : css.drawing.FillStyle.SOLID);
        if (data.color !== null) background.setPropertyValue('FillColor', parseInt(data.color.slice(1), 16));
        page.setPropertyValue('Background', background); break;
      }
      case 'set-notes':
        if (typeof data.text !== 'string' || data.text.length > 50000) throw Error('备注最多支持 50000 个字符。');
        notesShape(page, true).getText().setString(data.text); break;
      case 'set-page-size': {
        if (![data.width, data.height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 50 && value <= 1000)) throw Error('幻灯片宽高需要在 50–1000 毫米之间。');
        // Impress applies standard-page Width/Height to every slide and master.
        page.setPropertyValue('Width', Math.round(data.width * 100)); page.setPropertyValue('Height', Math.round(data.height * 100)); break;
      }
      case 'insert-text': case 'insert-shape': case 'insert-table': case 'update-object':
      case 'insert-chart': case 'update-chart': case 'update-table':
      case 'delete-objects': case 'arrange-objects': case 'select-objects': {
        if (!presentationObjects) throw Error('演示文稿对象工具未载入，请重新启动编辑器。');
        const { type, pageIndex: ignoredPage, expectedRevision: ignoredRevision, ...input } = data;
        const method = { 'insert-text': 'insertText', 'insert-shape': 'insertShape', 'insert-table': 'insertTable',
          'update-object': 'updateObject', 'delete-objects': 'deleteObjects', 'arrange-objects': 'arrange', 'select-objects': 'select',
          'insert-chart': 'insertChart', 'update-chart': 'updateChart', 'update-table': 'updateTable' }[type];
        if (type === 'insert-shape') { input.type = input.shapeType; delete input.shapeType; }
        if (type === 'insert-chart' || type === 'update-chart') { input.type = input.chartType; delete input.chartType; }
        controller.setCurrentPage(page); presentationObjects[method](input); break;
      }
      default: throw Error('不支持的演示文稿操作。');
    }
    reportWorkbenchChanged(current);
    const state = presentationState();
    finishChartNavigation(current, chartNavigation);
    return state;
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
          try { if (shape.getText().getString() === expected) return shape; } catch (error) { recoverOptional(error); }
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
      for (const model of models) { try { close(model); } catch (error) { recoverOptional(error); } }
      current?.frame.activate(); current?.frame.getContainerWindow().setFocus();
    }
  }
  function execute(message) {
    if (message.action === 'open') return open(message.data);
    if (!current || message.documentId !== current.id) throw Error('当前文档已经切换，旧操作已取消。');
    if (message.action === 'smoke-test') return smokeTest();
    if (message.action === 'offline-audit') {
      if (typeof globalThis.auditOfficeOfflinePolicy !== 'function') throw Error('本地策略审计仅供测试模式使用。');
      return globalThis.auditOfficeOfflinePolicy({ css, zetajs, context, document: current });
    }
    if (/^(word|sheet)-(state|action|data|command)$/.test(message.action)) {
      const [kind, operation] = message.action.split('-');
      if (current.kind !== kind) throw Error('此操作与当前文档类型不匹配。');
      const tools = kind === 'word' ? writerTools : calcTools;
      if (!tools) throw Error('中文文档工具未载入，请重新启动编辑器。');
      if (operation === 'data') {
        const data = tools.data(message.data);
        // The data and its revision belong to this one worker request. A
        // debounced toolbar refresh may still show an older document version.
        return { ...data, documentId: current.id, revision: current.revision };
      }
      if (operation === 'command') {
        const input = message.data, target = input?.target;
        if (kind !== 'word' || typeof tools.command !== 'function' || !target || target.documentId !== current.id
          || !Number.isSafeInteger(target.revision) || target.revision < 0 || target.revision > current.revision) throw Error('即时命令的文档目标或版本无效。');
        // The tool validates its bounded current target and applies the command
        // synchronously in this same request. Draft actions below stay strict.
        tools.command(input);
      }
      if (operation === 'action') {
        const action = message.data;
        if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') throw Error('编辑请求无效。');
        if ('expectedRevision' in action && (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 0)) throw Error('文档版本无效，请重新读取后再操作。');
        if ('expectedRevision' in action && action.expectedRevision !== current.revision) {
          // A named table read can outlive a delayed native Modify event. Only
          // Writer's dedicated compare-and-swap preflight may apply that edit;
          // a caller-supplied expectedCells key alone never bypasses the guard.
          if (action.expectedRevision > current.revision || kind !== 'word' || action.type !== 'update-table' || typeof tools.applyTableSnapshot !== 'function') throw Error('文档已变化，请刷新工作台后再操作。');
          tools.applyTableSnapshot(action);
        } else tools.action(action);
      }
      return { ...tools.state(), documentId: current.id, revision: current.revision, dirty: current.model.isModified() };
    }
    if (message.action === 'presentation-state') return presentationState();
    if (message.action === 'presentation-action') return presentationAction(message.data);
    if (message.action === 'presentation-object-data') {
      requirePresentation();
      if (!presentationObjects) throw Error('演示文稿对象工具未载入，请重新启动编辑器。');
      const data = message.data;
      if (!data || !['table', 'chart'].includes(data.type) || typeof data.id !== 'string'
        || Object.keys(data).some(key => !['type', 'id'].includes(key))) throw Error('不支持的演示对象读取操作。');
      return data.type === 'table' ? presentationObjects.getTable({ id: data.id }) : presentationObjects.getChart({ id: data.id });
    }
    if (message.action === 'preview-presentation') return requestPresentationPreview(message.data.fromCurrent === true);
    if (['start-presentation','end-presentation'].includes(message.action)) throw Error('请使用应用中的内置放映。');
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
    if (!['undo', 'redo', 'search', 'focus'].includes(message.action)) throw Error('不支持的编辑器操作。');
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
