import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { pdfDevPlugin } from '../scripts/pdf-dev-plugin.ts'

test('PDF development bridge binds requests to the actual loopback listener and same origin', async () => {
  let middleware
  const server = createServer((req, res) => middleware(req, res))
  const plugin = pdfDevPlugin()
  plugin.configureServer({ httpServer: server, middlewares: { use(path, callback) { assert.equal(path, '/__pdf-dev'); middleware = callback } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port, host = `127.0.0.1:${port}`
  const call = (headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/__pdf-dev', method, agent: false,
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'Content-Length': '2', Connection: 'close', ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode, body }))
    }); req.on('error', reject); req.end('{}')
  })
  try {
    for (const headers of [{ Host: '127.0.0.1:1' }, { Host: 'untrusted.invalid' }, { Origin: 'https://untrusted.invalid' }, { Origin: `http://localhost:${port}` }, { Origin: '' }, { 'Content-Type': 'text/plain' }]) {
      assert.equal((await call(headers)).status, 403)
    }
    assert.equal((await call({}, 'GET')).status, 403)
    // Invalid PDF input may be rejected by the real backend (or the backend may
    // be unprepared), but a matching ephemeral listener must pass origin checks.
    const local = await call()
    assert.ok([200, 502, 503].includes(local.status), local.body)
    assert.doesNotThrow(() => JSON.parse(local.body))
  } finally { server.close(); await once(server, 'close') }
})

test('PDF development bridge never opens on a non-loopback listener', () => {
  let middleware, status, body
  pdfDevPlugin().configureServer({ httpServer: { address: () => ({ address: '0.0.0.0', port: 5198 }) }, middlewares: { use(_path, callback) { middleware = callback } } })
  middleware({ method: 'POST', headers: { host: '127.0.0.1:5198', origin: 'http://127.0.0.1:5198', 'content-type': 'application/json' } },
    { writeHead(value) { status = value }, end(value) { body = value } })
  assert.equal(status, 403); assert.equal(body, 'Local development requests only')
})
