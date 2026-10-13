/* Fixed, read-only native-engine probe; loaded only by the smoke-test host. */
/* SPDX-License-Identifier: MIT */
'use strict';
globalThis.auditOfficeOfflinePolicy = function ({ css, zetajs, context, document }) {
  const policy = globalThis.OpenOfficeOfflinePolicy;
  const config = path => css.configuration.theDefaultProvider(context).createInstanceWithArguments(
    'com.sun.star.configuration.ConfigurationAccess', [new css.beans.PropertyValue({ Name: 'nodepath', Value: path })]);
  const disabled = config('/org.openoffice.Office.Commands/Execute/Disabled');
  const configured = disabled.getElementNames().map(name => disabled.getByName(name).getPropertyValue('Command'));
  const missingDisabled = policy.disabledCommands.filter(command => !configured.includes(command));
  const updatesDisabled = config('/org.openoffice.Office.Update/Update').getPropertyValue('Enabled') === false;
  const macrosDisabled = config('/org.openoffice.Office.Common/Security/Scripting').getPropertyValue('DisableMacrosExecution') === true;
  const moduleId = { word: 'com.sun.star.text.TextDocument', sheet: 'com.sun.star.sheet.SpreadsheetDocument',
    presentation: 'com.sun.star.presentation.PresentationDocument' }[document.kind];
  const manager = css.ui.theModuleUIConfigurationManagerSupplier(context).getUIConfigurationManager(moduleId);
  const settings = manager.getSettings('private:resource/menubar/menubar', false);
  const commands = [], walk = (container, depth = 0) => {
    if (depth > 12 || commands.length > 2000) throw Error('菜单审计超出范围。');
    for (let i = 0; i < container.getCount(); i++) {
      const item = container.getByIndex(i), command = item.find(value => value.Name === 'CommandURL')?.Value;
      if (typeof command === 'string' && command) commands.push(command);
      const children = item.find(value => value.Name === 'ItemDescriptorContainer')?.Value;
      if (children && typeof children.getCount === 'function') walk(children, depth + 1);
    }
  };
  walk(settings);
  const dispatches = [];
  // This probe has no caller-supplied command/URL, and never runs an enabled
  // dispatch. It cannot be used to access files, edit a document or make a call.
  for (const command of ['.uno:OpenRemote', '.uno:SaveAsRemote', '.uno:SendMail', '.uno:Documentation', '.uno:OpenHyperlinkOnCursor']) {
    const url = new css.util.URL({ Complete: command });
    const delegate = document.frame.queryDispatch(url, '', 0);
    let enabled = delegate ? null : false;
    if (delegate) {
      const listener = zetajs.unoObject([css.frame.XStatusListener], {
        statusChanged(event) { enabled = event.IsEnabled; }, disposing() {},
      });
      delegate.addStatusListener(listener, url);
      delegate.removeStatusListener(listener, url);
    }
    dispatches.push({ command, disabled: enabled === false });
  }
  return { kind: document.kind, menuCommandCount: commands.length,
    forbiddenMenuCommands: commands.filter(command => policy.blockedCommand(command)),
    localSavePresent: commands.includes('.uno:Save'), missingDisabled, updatesDisabled, macrosDisabled, dispatches };
};
