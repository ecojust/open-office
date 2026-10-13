// Compact, versionable index of actual run evidence. Original detailed reports
// and saved documents remain separate; this never upgrades review to pass.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const inputs = process.argv.slice(2);
if (!inputs.length) throw Error('Usage: node tests/compatibility/summarize.cjs <report.json> [...]');
const unique = values => [...new Set(values)];
const runs = inputs.map(input => {
  const bytes = fs.readFileSync(input), report = JSON.parse(bytes);
  if (!report.finishedAt || report.interruptedReason || report.error) throw Error('Incomplete run: ' + input);
  return {
    report: path.relative(path.resolve(__dirname, '../..'), path.resolve(input)).split(path.sep).join('/'),
    reportSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    startedAt: report.startedAt, finishedAt: report.finishedAt,
    semanticRecheck: report.recheck || null,
    supplementalAttachmentAudit: report.supplementalAttachmentAudit || null,
    implementationSha256: report.implementation?.sha256 || null,
    implementationUnchanged: report.implementationUnchanged ?? null,
    environment: report.environment || null,
    summary: report.summary,
    externalRequests: report.externalRequests,
    pageErrors: report.pageErrors,
    cases: report.cases.map(item => ({
      id: item.id, sourceFormat: item.format,
      sourceSha256: item.sourceInspection?.file?.sha256,
      sourceInspection: item.sourceInspection?.inspection,
      status: item.status,
      failures: item.failures,
      offlineAudit: item.offlineAudit ? {
        missingDisabled: item.offlineAudit.missingDisabled,
        forbiddenMenuCommands: item.offlineAudit.forbiddenMenuCommands,
        localSavePresent: item.offlineAudit.localSavePresent,
        updatesDisabled: item.offlineAudit.updatesDisabled,
        macrosDisabled: item.offlineAudit.macrosDisabled,
        dispatches: item.offlineAudit.dispatches,
      } : null,
      branches: item.branches.map(branch => ({
        format: branch.format, status: branch.status,
        attemptedCycles: branch.cycles.length,
        savedCycles: branch.cycles.filter(cycle => cycle.inspection).length,
        finalReopened: !!branch.finalState,
        pdfPages: branch.pdfInspection?.pdf?.pageCount || null,
        operationFailures: branch.failures.map(error => error.split('\n')[0]),
        failedAssertions: unique(branch.cycles.flatMap(cycle => (cycle.checks || []).filter(check => !check.ok).map(check => check.name))),
        preservationFailures: unique(branch.cycles.flatMap(cycle => (cycle.preservation?.failures || []).map(check => check.code + ': ' + check.path))),
        reviewCodes: unique(branch.cycles.flatMap(cycle => (cycle.preservation?.reviewItems || []).map(check => check.code))),
      })),
    })),
  };
});
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  scope: 'Pinned source fixtures in the bundled editor. This index is not a claim of Microsoft/WPS/ONLYOFFICE interoperability or full feature parity. Review, observed losses and protected unsupported conversions remain explicit.',
  runs,
}, null, 2) + '\n');
