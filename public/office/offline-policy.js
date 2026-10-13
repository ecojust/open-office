/* Local-only LibreOffice UI/dispatch/transport policy. SPDX-License-Identifier: MIT */
(function (root) {
  'use strict';
  if (root.OpenOfficeOfflinePolicy) return;

  // Exact commands audited in the pinned runtime's registry and UI resources.
  // Do not match substrings: SpellOnline, OnlineAutoFormat, SendToBack and
  // UpdateAllIndexes are useful, entirely local editing commands.
  const disabledCommands = Object.freeze([
    'OpenRemote', 'SaveAsRemote', 'CheckOut', 'CheckIn', 'CancelCheckOut',
    'SendMail', 'SendMailDocAsOOo', 'SendMailDocAsMS', 'SendMailDocAsPDF',
    'SendViaBluetooth', 'MailMergeEmailDocuments', 'DBSendReportAsMail',
    'ShareDocument', 'Remote', 'OpenUrl', 'OpenURL', 'OpenHyperlink',
    'OpenHyperlinkOnCursor', 'ExecHyperlinks', 'WebHtml', 'InternetDialog',
    'EditLinks', 'ManageLinks', 'LinkDialog', 'InsertExternalDataSource',
    'DataAreaRefresh', 'DataStreams', 'DataStreamsPlay', 'DataProvider',
    'DataProviderRefresh', 'UpdateAllLinks', 'UpdateAll',
    'HelpIndex', 'Documentation', 'SendFeedback', 'Donation',
    'AdditionsDialog', 'ExtensionManager', 'PackageManager',
    'TemplateManager', 'OnlineTemplates', 'OnlineUpdate', 'CheckForUpdates',
  ]);
  const disabled = new Set(disabledCommands.map(name => name.toLowerCase()));
  const fileCommands = new Set(['open', 'openfromwriter', 'openfromcalc', 'openfromdraw', 'openfromimpress',
    'openlocalurl', 'save', 'saveas', 'saveacopy', 'saveall', 'insertdoc', 'insertsheetfromfile',
    'insertgraphic', 'insertavmedia', 'insertobject', 'insertplugin', 'insertframe']);
  const denied = () => new Error('此应用仅在本机处理文档，已禁用联网、远程文件和在线服务操作。');
  function commandName(value) {
    if (typeof value !== 'string') return '';
    const match = /^\.uno:([^?#\s]+)(?:[?#]|$)/i.exec(value);
    return match ? match[1] : '';
  }
  function blockedCommand(value) { return disabled.has(commandName(value).toLowerCase()); }
  function externalUri(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    // These are engine-local URI protocols, not OS files or remote services.
    if (/^(?:\.uno:|private:|vnd\.sun\.star\.(?:expand|tdoc):|file:\/\/\/|#)/i.test(text)) return false;
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(text);
  }
  function blockedDispatch(value, args = []) {
    if (blockedCommand(value) || externalUri(value)) return true;
    // A URL parameter on Open/Save/etc must not bypass the local picker route.
    const query = typeof value === 'string' ? value.split('?').slice(1).join('?') : '';
    if (query && fileCommands.has(commandName(value).toLowerCase())) {
      let decoded;
      try { decoded = decodeURIComponent(query.replace(/\+/g, ' ')); } catch { return true; }
      if (/(?:^|[&;])(?:url|filename|referer|hyperlink)(?::[^=]*)?=/i.test(decoded) &&
          /(?:https?|ftp|ftps|sftp|smb|webdav|webdavs|cmis|mailto|vnd\.sun\.star\.script):|(?:^|=)\/\//i.test(decoded)) return true;
    }
    return fileCommands.has(commandName(value).toLowerCase()) && Array.isArray(args) && args.some(item => item &&
      /^(?:URL|FileName|Referer|Hyperlink|BaseURL)$/i.test(item.Name || '') && externalUri(item.Value));
  }
  const guardedFileCommands = Object.freeze(['InsertDoc', 'InsertSheetFromFile', 'InsertAVMedia', 'InsertObject', 'InsertPlugin', 'InsertFrame']);
  function needsArgumentGuard(value) { return fileCommands.has(commandName(value).toLowerCase()); }
  function interceptedURLs(localCommands) {
    const commands = new Set([...localCommands, ...disabledCommands.map(name => `.uno:${name}`),
      ...guardedFileCommands.map(name => `.uno:${name}`)]);
    // Never use '*': native toolbar status queries number in the thousands;
    // bridging every ordinary edit/paint query into JS severely slows the UI.
    return [...commands].flatMap(command => [command, `${command}?*`]).concat([
      'private:factory/*', 'http:*', 'https:*', 'ftp:*', 'ftps:*', 'sftp:*', 'mailto:*',
      'smb:*', 'webdav:*', 'webdavs:*', 'cmis:*', 'vnd.libreoffice.cmis:*',
      'vnd.sun.star.script:*', '///*',
    ]);
  }

  function profileXml() {
    const items = disabledCommands.map(name => `<node oor:name="local_only_${name}" oor:op="replace"><prop oor:name="Command" oor:type="xs:string"><value>${name}</value></prop></node>`).join('');
    // These paths and property types are present in the pinned main.xcd. The
    // command configuration also hides commands in native menus/toolbars.
    return `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema"><item oor:path="/org.openoffice.Office.Commands/Execute/Disabled">${items}</item><item oor:path="/org.openoffice.Office.Update/Update"><prop oor:name="Enabled" oor:type="xs:boolean"><value>false</value></prop></item><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:type="xs:boolean"><value>true</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:type="xs:boolean"><value>true</value></prop></item></oor:items>`;
  }

  // The input is trusted, bundled UI XML, never document XML. Preserve every
  // byte outside removed elements (including namespace/schema declarations).
  function filterUiXml(source) {
    let output = '', previous = 0, skipped = 0, removed = 0;
    const stack = [];
    const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_][\w:.-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    for (const match of source.matchAll(tokens)) {
      if (!skipped) output += source.slice(previous, match.index);
      const token = match[0]; previous = match.index + token.length;
      if (/^<(?:!|\?)/.test(token)) { if (!skipped) output += token; continue; }
      const name = /^<\/?([\w:.-]+)/.exec(token)[1];
      if (token.startsWith('</')) {
        const node = stack.pop();
        if (!node || node.name !== name) throw Error('本地办公菜单资源不完整。');
        if (node.hidden) skipped--;
        else if (!skipped) output += token;
        continue;
      }
      const command = /\b(?:menu:id|xlink:href)\s*=\s*(["'])(.*?)\1/.exec(token)?.[2] || '';
      const hidden = skipped > 0 || blockedCommand(command);
      if (hidden && skipped === 0) removed++;
      if (!hidden) output += token;
      if (!/\/\s*>$/.test(token)) { stack.push({ name, hidden }); if (hidden) skipped++; }
    }
    if (stack.length) throw Error('本地办公菜单资源不完整。');
    if (!skipped) output += source.slice(previous);
    return { xml: output, removed };
  }

  function prepareFileSystem(FS) {
    const bootstrapPath = '/instdir/program/bootstraprc';
    const before = FS.readFile(bootstrapPath, { encoding: 'utf8' });
    if (!/^UserInstallation=.*$/m.test(before)) throw Error('缺少本地办公配置入口。');
    const profile = '/tmp/open-office-offline-profile';
    FS.mkdirTree(`${profile}/user`);
    FS.writeFile(`${profile}/user/registrymodifications.xcu`, profileXml());
    FS.writeFile(bootstrapPath, before.replace(/^UserInstallation=.*$/m, `UserInstallation=file://${profile}`));
    let files = 0, removed = 0;
    const walk = path => {
      for (const name of FS.readdir(path)) {
        if (name === '.' || name === '..') continue;
        const entry = `${path}/${name}`, stat = FS.stat(entry);
        if (FS.isDir(stat.mode)) walk(entry);
        else if (/\/(?:menubar|toolbar|popupmenu)\/[^/]+\.xml$/.test(entry)) {
          const result = filterUiXml(FS.readFile(entry, { encoding: 'utf8' }));
          files++; removed += result.removed;
          if (result.removed) FS.writeFile(entry, result.xml);
        }
      }
    };
    walk('/instdir/share/config/soffice.cfg/modules');
    if (!files || !removed) throw Error('未找到本地办公菜单配置，已停止加载。');
    return { files, removed, disabledCommands: disabledCommands.length };
  }

  function installLocalTransport(scope, origin) {
    if (scope.__openOfficeLocalTransport) {
      if (scope.__openOfficeLocalTransport !== origin) throw denied();
      return;
    }
    const base = new URL(origin);
    if (!/^https?:$/.test(base.protocol) || base.origin !== origin) throw denied();
    const allowedUrl = value => {
      try {
        const url = new URL(typeof value === 'string' ? value : value?.url || String(value), `${origin}/`);
        return (url.origin === origin && ['http:', 'https:', 'blob:'].includes(url.protocol)) || url.protocol === 'data:';
      } catch { return false; }
    };
    const check = value => { if (!allowedUrl(value)) throw denied(); };
    if (typeof scope.fetch === 'function') {
      const fetch = scope.fetch;
      scope.fetch = function (input, options) {
        try { check(input); } catch (error) { return Promise.reject(error); }
        // No engine resource endpoint redirects. An external redirect is never
        // followed, even outside the native server's restrictive CSP.
        return fetch.call(this, input, { ...options, redirect: 'error' });
      };
    }
    if (scope.XMLHttpRequest?.prototype?.open) {
      const open = scope.XMLHttpRequest.prototype.open;
      scope.XMLHttpRequest.prototype.open = function (method, url, ...args) { check(url); return open.call(this, method, url, ...args); };
    }
    if (typeof scope.importScripts === 'function') {
      const load = scope.importScripts;
      scope.importScripts = function (...urls) { urls.forEach(check); return load.apply(this, urls); };
    }
    for (const name of ['WebSocket', 'EventSource']) {
      if (typeof scope[name] !== 'function') continue;
      const Original = scope[name];
      const Wrapped = function (url, ...args) {
        // This offline engine has no socket service. HTTP EventSource, if used
        // by future local components, is still confined to the loopback origin.
        if (name === 'WebSocket') throw denied();
        check(url); return Reflect.construct(Original, [url, ...args], new.target || Original);
      };
      Object.setPrototypeOf(Wrapped, Original); Wrapped.prototype = Original.prototype; scope[name] = Wrapped;
    }
    if (typeof scope.navigator?.sendBeacon === 'function') {
      const sendBeacon = scope.navigator.sendBeacon.bind(scope.navigator);
      scope.navigator.sendBeacon = (url, data) => { check(url); return sendBeacon(url, data); };
    }
    if (typeof scope.open === 'function' && scope.document) scope.open = () => null;
    Object.defineProperty(scope, '__openOfficeLocalTransport', { value: origin, configurable: false });
  }

  root.OpenOfficeOfflinePolicy = Object.freeze({ disabledCommands, commandName, blockedCommand,
    blockedDispatch, needsArgumentGuard, interceptedURLs, filterUiXml, profileXml, prepareFileSystem, installLocalTransport });
})(globalThis);
