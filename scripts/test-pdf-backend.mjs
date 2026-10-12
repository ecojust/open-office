import { existsSync } from 'node:fs';
import { backendRoot, venvPython, run, main } from './pdf-backend-tools.mjs';
import { join } from 'node:path';

main(() => {
  if (!existsSync(venvPython)) throw new Error('Prepare the PDF development environment with node scripts/ensure-pdf-backend.mjs --dev first.');
  run(venvPython, ['-m', 'unittest', 'discover', '-s', join(backendRoot, 'tests'), '-v']);
});
