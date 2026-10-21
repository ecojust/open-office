import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultMcpConfig, createMcpToken, loadMcpConfig, saveMcpConfig, validateMcpConfig,
  normalizeMcpConfig, mcpClientConfig, MCP_CONFIG_STORAGE_KEY } from '../src/mcp/config.ts'

const valid = () => ({ port: 19780, token: 'a'.repeat(64), allowEdits: false })
function storage(initial) {
  let stored = initial, writes = 0
  return {
    getItem(key) { assert.equal(key, MCP_CONFIG_STORAGE_KEY); return stored ?? null },
    setItem(key, value) { assert.equal(key, MCP_CONFIG_STORAGE_KEY); stored = value; writes++ },
    get value() { return stored }, get writes() { return writes },
  }
}
function withStorage(store, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store })
  try { callback() } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
}

test('MCP defaults are local, editable and use independently generated 256-bit keys', () => {
  const config = createDefaultMcpConfig()
  assert.equal(config.port, 19780)
  assert.equal(config.allowEdits, true)
  assert.match(config.token, /^[a-f0-9]{64}$/)
  assert.notEqual(config.token, createMcpToken())
  assert.equal(validateMcpConfig(config), null)
})

test('MCP configuration rejects invalid ports, unsafe header tokens and coerced edit permissions', () => {
  for (const port of [1023, 65536, 1.5, NaN, Infinity, '19780', null, undefined]) {
    assert.match(validateMcpConfig({ ...valid(), port }), /端口/)
  }
  for (const port of [1024, 19780, 65535]) assert.equal(validateMcpConfig({ ...valid(), port }), null)
  for (const token of ['', 'x'.repeat(31), 'x'.repeat(129), 'x'.repeat(32) + '\r\nHost: remote', ' '.repeat(64), null]) {
    assert.match(validateMcpConfig({ ...valid(), token }), /密钥/)
  }
  for (const allowEdits of [undefined, 1, 'true']) assert.match(validateMcpConfig({ ...valid(), allowEdits }), /编辑/)
  for (const malformed of [null, undefined, false, 123, [], 'config']) assert.equal(normalizeMcpConfig(malformed), null)
})

test('MCP config normalization retains only supported fields and does not mutate input', () => {
  const source = { ...valid(), host: '0.0.0.0', autoStart: true }
  assert.deepEqual(normalizeMcpConfig(source), valid())
  assert.equal(source.host, '0.0.0.0')
})

test('loading valid MCP browser settings never writes or generates a replacement token', () => {
  for (const allowEdits of [false, true]) {
    const store = storage(JSON.stringify({ ...valid(), allowEdits }))
    withStorage(store, () => assert.deepEqual(loadMcpConfig(), { ...valid(), allowEdits }))
    assert.equal(store.writes, 0)
  }
})

test('missing, damaged or unreadable MCP browser settings recover without persisting', () => {
  for (const value of [null, '{broken', 'null', JSON.stringify({ ...valid(), port: -1 })]) {
    const store = storage(value)
    withStorage(store, () => {
      const config = loadMcpConfig()
      assert.equal(config.allowEdits, true)
      assert.equal(validateMcpConfig(config), null)
    })
    assert.equal(store.writes, 0)
  }
  withStorage({ getItem() { throw Error('unavailable') } }, () => assert.equal(validateMcpConfig(loadMcpConfig()), null))
})

test('only an explicit valid MCP save persists and storage failures propagate', () => {
  const store = storage()
  withStorage(store, () => {
    assert.throws(() => saveMcpConfig({ ...valid(), token: '' }), /密钥/)
    assert.equal(store.writes, 0)
    saveMcpConfig(valid())
    assert.equal(store.writes, 1)
    assert.deepEqual(JSON.parse(store.value), valid())
  })
  withStorage({ setItem() { throw Error('quota') } }, () => assert.throws(() => saveMcpConfig(valid()), /无法保存/))
})

test('copyable MCP client JSON points only to loopback and carries the exact bearer key', () => {
  const config = { ...valid(), port: 23456 }
  assert.deepEqual(JSON.parse(mcpClientConfig(config)), {
    mcpServers: { 'open-office': { type: 'http', url: 'http://127.0.0.1:23456/mcp', headers: { Authorization: `Bearer ${config.token}` } } },
  })
  assert.throws(() => mcpClientConfig({ ...config, port: 80 }), /端口/)
})
