import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { pdfDevPlugin } from './scripts/pdf-dev-plugin'
import packageInfo from './package.json'
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date()).map(p => [p.type, p.value]))
const buildVersion = process.env.OFFICE_BUILD_VERSION || `${parts.year}.${parts.month}${parts.day}.${parts.hour}${parts.minute}`
if (!/^\d{4}\.\d{4}\.\d{4}$/.test(buildVersion)) throw new Error('Invalid OFFICE_BUILD_VERSION')
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
export default defineConfig({
  plugins: [vue(), pdfDevPlugin(), { name: 'build-info', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version: packageInfo.version, buildVersion }) }) } }],
  base: './', define: { __BUILD_VERSION__: JSON.stringify(buildVersion) },
  server: { host: '127.0.0.1', port: 5198, strictPort: true, headers },
  preview: { host: '127.0.0.1', port: 4198, strictPort: true, headers },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
})
