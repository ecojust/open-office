import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WASM_COMPAT_SOURCES } from '../../scripts/wasm-webkit-compat.mjs';

export function installWasmCompatSources(root) {
  for (const path of WASM_COMPAT_SOURCES) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `fixture: ${path}`);
  }
}
