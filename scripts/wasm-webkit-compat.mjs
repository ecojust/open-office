import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const WASM_COMPAT_SOURCES = [
  'scripts/wasm-webkit-compat.mjs',
  'scripts/wasm-webkit-compat/Cargo.toml',
  'scripts/wasm-webkit-compat/Cargo.lock',
  'scripts/wasm-webkit-compat/src/main.rs',
]

/** Preserve comparison results while avoiding WebKit bug 317022 on older macOS. */
export function patchWasmForWebKit(path) {
  const manifest = fileURLToPath(new URL('./wasm-webkit-compat/Cargo.toml', import.meta.url))
  const result = spawnSync(process.env.CARGO || 'cargo', ['run', '--quiet', '--locked', '--release', '--manifest-path', manifest, '--', path], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error('WebKit WASM compatibility transformation failed')
}
