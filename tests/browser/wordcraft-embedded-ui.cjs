/* Focused real-WASM acceptance for the Open Office-owned file shell and the
 * embedded editing-only canvas. Run after npm run word:check succeeds. */
const path = require('node:path');
process.env.WORDCRAFT_OUTPUT ||= path.resolve(__dirname, '../../test-results/wordcraft-embedded-ui');
require('./wordcraft-engine.cjs').main({ scope: 'embedded' }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
