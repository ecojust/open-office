import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../public/office/offline-policy.js', import.meta.url), 'utf8')
const auditSource = await readFile(new URL('../public/office/offline-audit.js', import.meta.url), 'utf8')
function policy() {
  const context = vm.createContext({ URL })
  vm.runInContext(source, context)
  return context.OpenOfficeOfflinePolicy
}

test('offline command policy rejects audited remote services and query/URL argument bypasses', () => {
  const p = policy()
  for (const name of ['OpenRemote', 'SaveAsRemote', 'SendMailDocAsPDF', 'CheckIn', 'ShareDocument',
    'OpenUrl', 'OpenHyperlinkOnCursor', 'MailMergeEmailDocuments', 'DataProviderRefresh',
    'UpdateAllLinks', 'HelpIndex', 'Documentation', 'TemplateManager', 'Donation']) {
    assert.equal(p.blockedCommand(`.uno:${name}`), true, name)
    assert.equal(p.blockedCommand(`.uno:${name}?x:string=1`), true, `${name} query`)
    assert.equal(p.blockedCommand(`.uno:${name.toUpperCase()}`), true, `${name} case`)
  }
  for (const url of ['https://example.invalid/a', 'mailto:test@example.invalid',
    '//example.invalid/file', '\\\\server\\file', 'vnd.sun.star.script:remote-script']) {
    assert.equal(p.blockedDispatch(url), true, url)
    assert.equal(p.blockedDispatch('.uno:Open', [{ Name: 'URL', Value: url }]), true, url)
  }
  assert.equal(p.blockedDispatch('.uno:Open?URL:string=https%3A%2F%2Fexample.invalid%2F'), true)
  assert.equal(p.blockedDispatch('.uno:Open?URL:string=%broken'), true)
})

test('offline policy preserves local editing, link metadata and internal document bookmarks', () => {
  const p = policy()
  for (const name of ['SpellOnline', 'OnlineAutoFormat', 'AccessibilityCheckOnline', 'SendToBack',
    'SendOutlineToClipboard', 'UpdateAllIndexes', 'UpdateCurIndex', 'EditHyperlink', 'CopyHyperlinkLocation',
    'RemoveHyperlink', 'InsertTable', 'InsertChart', 'Save', 'Open', 'PrintPreview']) {
    assert.equal(p.blockedDispatch(`.uno:${name}`), false, name)
  }
  assert.equal(p.blockedDispatch('.uno:JumpToMark', [{ Name: 'URL', Value: '#chapter1' }]), false)
  assert.equal(p.blockedDispatch('.uno:EditHyperlink', [{ Name: 'URL', Value: 'https://example.invalid/metadata-only' }]), false)
  assert.equal(p.blockedDispatch('file:///tmp/open-office-local.docx'), false)
  assert.equal(p.blockedDispatch('private:factory/swriter'), false)
})

test('interception patterns leave frequent local status queries entirely native', () => {
  const p = policy(), patterns = p.interceptedURLs(['.uno:Save', '.uno:Open'])
  assert.equal(patterns.includes('*'), false)
  assert.equal(patterns.includes('.uno:*'), false)
  for (const command of ['.uno:Bold','.uno:SpellOnline','.uno:EditHyperlink','.uno:Undo']) {
    assert.equal(patterns.some(pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$').test(command)), false)
  }
  for (const command of ['.uno:OpenRemote','.uno:SaveAsRemote','.uno:InsertDoc','.uno:Save?FilterName:string=test','https://example.invalid']) {
    assert.equal(patterns.some(pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$').test(command)), true, command)
  }
})

test('UI filtering removes nested remote menu/toolbar/popup entries without touching local XML', () => {
  const p = policy()
  const prefix = '<?xml version="1.0"?><!DOCTYPE menu:menubar PUBLIC "ui" "menubar.dtd"><menu:menubar xmlns:menu="http://openoffice.org/2001/menu" xmlns:xlink="http://www.w3.org/1999/xlink">'
  const local = '<menu:menuitem menu:id=".uno:SpellOnline"/><menu:menuitem menu:id=".uno:EditHyperlink"/><menu:menuitem menu:id=".uno:UpdateAllIndexes"/>'
  const end = '</menu:menubar>'
  const result = p.filterUiXml(prefix + '<menu:menu menu:id=".uno:TemplateManager"><menu:menupopup><menu:menuitem menu:id=".uno:OpenRemote"/></menu:menupopup></menu:menu>' + local + '<toolbar:toolbaritem xlink:href=".uno:OpenUrl"/>' + end)
  assert.equal(result.removed, 2)
  assert.equal(result.xml, prefix + local + end)
  assert.throws(() => p.filterUiXml('<menu:menubar><menu:menuitem></wrong>'), /菜单资源/)
})

test('pinned profile uses supported paths and protocol-free command values', () => {
  const xml = policy().profileXml()
  assert.match(xml, /\/org\.openoffice\.Office\.Commands\/Execute\/Disabled/)
  assert.match(xml, /<value>OpenRemote<\/value>/)
  assert.doesNotMatch(xml, /<value>\.uno:|AutoCheckEnabled|DisableActiveContent/)
  assert.match(xml, /Office\.Update\/Update.*?name="Enabled".*?<value>false<\/value>/)
  assert.match(xml, /name="DisableMacrosExecution".*?<value>true<\/value>/)
})

test('preparation touches only bundled UI/bootstrap and its own private local profile', () => {
  const p = policy(), files = new Map([
    ['/instdir/program/bootstraprc', '[Bootstrap]\nUserInstallation=$SYSUSERCONFIG/zetaoffice/4\nProductKey=ZetaOffice\n'],
    ['/instdir/share/config/soffice.cfg/modules/swriter/menubar/menubar.xml', '<menu:menubar><menu:menuitem menu:id=".uno:OpenRemote"/><menu:menuitem menu:id=".uno:Save"/></menu:menubar>'],
    ['/tmp/user-document.xml', '<a xmlns="https://schemas.example.invalid/document">https://example.invalid/link</a>'],
  ])
  const writes = [], dirs = new Set(['/'])
  for (const file of files.keys()) for (let path = file.slice(0, file.lastIndexOf('/')); path; path = path.slice(0, path.lastIndexOf('/'))) dirs.add(path)
  const fs = {
    readFile: path => { if (!files.has(path)) throw Error('Missing file'); return files.get(path) },
    writeFile: (path, text) => { writes.push(path); files.set(path, text) },
    mkdirTree: path => dirs.add(path), isDir: mode => mode === 1,
    stat: path => ({ mode: dirs.has(path) ? 1 : 0 }),
    readdir: path => ['.', '..', ...new Set([...dirs, ...files.keys()].filter(x => x.startsWith(`${path}/`)).map(x => x.slice(path.length + 1).split('/')[0]))],
  }
  const document = files.get('/tmp/user-document.xml'), result = p.prepareFileSystem(fs)
  assert.equal(result.files, 1); assert.equal(result.removed, 1)
  assert.equal(files.get('/tmp/user-document.xml'), document)
  assert.equal(writes.length, 3)
  assert.match(files.get('/instdir/program/bootstraprc'), /UserInstallation=file:\/\/\/tmp\/open-office-offline-profile/)
  assert.doesNotMatch(files.get('/instdir/share/config/soffice.cfg/modules/swriter/menubar/menubar.xml'), /OpenRemote/)
})

test('transport rejects remote calls before invoking APIs while local assets and smoke diagnostics work', async () => {
  const p = policy(), calls = [], origin = 'http://127.0.0.1:12345'
  class XHR { open(...args) { calls.push(['xhr', ...args]) } }
  class Socket { constructor(...args) { calls.push(['socket', ...args]) } }
  const scope = { fetch: async (...args) => { calls.push(['fetch', ...args]); return { ok: true } },
    XMLHttpRequest: XHR, WebSocket: Socket, EventSource: Socket,
    importScripts: (...args) => calls.push(['import', ...args]),
    navigator: { sendBeacon: (...args) => { calls.push(['beacon', ...args]); return true } },
  }
  p.installLocalTransport(scope, origin)
  await scope.fetch(`${origin}/secret/office-runtime/soffice.wasm`)
  await scope.fetch({ url: `${origin}/secret/__native-smoke/progress` }, { method: 'POST' })
  new scope.XMLHttpRequest().open('GET', `${origin}/secret/office-runtime/soffice.data`)
  scope.importScripts(`${origin}/secret/office/office-worker.js`)
  assert.equal(calls.length, 4)
  assert.equal(calls[0][2].redirect, 'error')
  for (const url of ['https://example.invalid/document', '//example.invalid/resource',
    'http://127.0.0.1:9999/other-app', 'file:///etc/passwd', 'blob:https://example.invalid/token']) {
    await assert.rejects(scope.fetch(url), /本机/)
    assert.throws(() => new scope.XMLHttpRequest().open('GET', url), /本机/)
    assert.throws(() => scope.importScripts(url), /本机/)
    assert.throws(() => new scope.EventSource(url), /本机/)
    assert.throws(() => scope.navigator.sendBeacon(url, 'data'), /本机/)
  }
  assert.throws(() => new scope.WebSocket('ws://127.0.0.1:12345'), /本机/)
  assert.equal(calls.length, 4, 'Rejected calls never reached the original transport')
  p.installLocalTransport(scope, origin)
  assert.throws(() => p.installLocalTransport(scope, 'http://127.0.0.1:23456'), /本机/)
})

test('fixed native audit reads the actual config/menu and never executes a dispatch', () => {
  const context = vm.createContext({ URL })
  vm.runInContext(source + '\n' + auditSource, context)
  const p = context.OpenOfficeOfflinePolicy, accessed = [], dispatches = []
  class Value { constructor(value) { Object.assign(this, value) } }
  const menu = items => ({ getCount: () => items.length, getByIndex: index => items[index] })
  const cfg = {
    '/org.openoffice.Office.Commands/Execute/Disabled': { getElementNames: () => [...p.disabledCommands], getByName: name => ({ getPropertyValue: () => name }) },
    '/org.openoffice.Office.Update/Update': { getPropertyValue: () => false },
    '/org.openoffice.Office.Common/Security/Scripting': { getPropertyValue: () => true },
  }
  const settings = menu([[{ Name:'CommandURL',Value:'.uno:FileMenu' },{ Name:'ItemDescriptorContainer',Value:menu([
    [{Name:'CommandURL',Value:'.uno:Save'}], [{Name:'CommandURL',Value:'.uno:OpenRemote'}],
  ]) }]])
  const css = { beans:{PropertyValue:Value}, util:{URL:Value}, frame:{XStatusListener:'listener'},
    configuration:{theDefaultProvider:()=>({createInstanceWithArguments:(_service,args)=>{accessed.push(args[0].Value);return cfg[args[0].Value]}})},
    ui:{theModuleUIConfigurationManagerSupplier:()=>({getUIConfigurationManager:()=>({getSettings:()=>settings})})} }
  const document = { kind:'word',frame:{queryDispatch:url=>({
    dispatch:()=>{throw Error('Audit must not execute any command')},
    addStatusListener(listener){dispatches.push(url.Complete);listener.statusChanged({IsEnabled:false})},
    removeStatusListener(){},
  })} }
  const report = context.auditOfficeOfflinePolicy({css,zetajs:{unoObject:(_ifaces,object)=>object},context:{},document})
  assert.equal(accessed.length,3)
  assert.equal(report.missingDisabled.length,0)
  assert.equal(report.updatesDisabled,true)
  assert.equal(report.localSavePresent,true)
  assert.deepEqual([...report.forbiddenMenuCommands],['.uno:OpenRemote'],'Audit must report surviving native menu entries, not merely policy intention')
  assert.equal(dispatches.length,5)
  assert.equal(report.dispatches.every(result=>result.disabled),true)
})
