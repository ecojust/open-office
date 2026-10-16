/* Focused real-WASM acceptance for the Open Office-owned file shell and the
 * embedded editing-only canvas. Run after npm run word:check succeeds. */
const path = require('node:path');
process.env.OFFICE_WORD_OUTPUT ||= path.resolve(__dirname, '../../test-results/office-word-embedded-ui');
require('./office-word-engine.cjs').main({ scope: 'embedded' }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
