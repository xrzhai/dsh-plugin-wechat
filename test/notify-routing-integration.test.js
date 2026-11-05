import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { setImmediate as tick } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import { configureWeixinStateDir, configFile, stateDir } from '../src/state.js'
import { readLines, scopedLineKey, writeLines, SessionLines } from '../src/sessions.js'
import { AgentBridge } from '../src/agent-bridge.js'
import { ILinkTransport } from '../src/transport/ilink.js'
import { registerWeixinAccountId, saveWeixinAccount } from '../vendor/openclaw-weixin/auth/accounts.js'

const TOKEN = 'synthetic-notify-token'
const ACCOUNT = 'notify-account-a'
const OTHER_ACCOUNT = 'notify-account-b'
const OLD_CONVERSATION = 'old@im.wechat'
const NEW_CONVERSATION = 'new@im.wechat:thread-2026'
const OTHER_CONVERSATION = 'other@im.wechat'

async function until(predicate, label) {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return
    await tick()
  }
  assert.ok(predicate(), label)
}

function fakeServer() {
  const listeners = new Map()
  return {
    host: undefined,
    port: undefined,
    unrefCalled: false,
    closed: false,
    once(event, listener) {
      listeners.set(event, listener)
      return this
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event)
      return this
    },
    listen(port, host) {
      this.port = port
      this.host = host
      const listening = listeners.get('listening')
      listeners.delete('listening')
      listening?.()
      return this
    },
    address() {
      return { address: this.host, family: 'IPv4', port: this.port }
    },
    unref() {
      this.unrefCalled = true
      return this
    },
    close(callback) {
      this.closed = true
      callback?.()
      return this
    },
  }
}

function postNotify(handler, text) {
  let resolveResponse
  const response = new Promise((resolve) => { resolveResponse = resolve })
  const req = {
    method: 'POST',
    url: '/notify',
    headers: { 'x-notify-token': TOKEN },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ text }))
    },
    destroy() {},
  }
  const res = {
    statusCode: undefined,
    headers: undefined,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(body) {
      resolveResponse({ status: this.statusCode, body: JSON.parse(body) })
    },
  }
  handler(req, res)
  return response
}

test('apply routes notify HTTP requests to the latest conversation and returns 502 after state is empty', async (t) => {
  const env = Object.fromEntries(['DSH_WEIXIN_STATE_DIR', 'OPENCLAW_STATE_DIR', 'CLAWDBOT_STATE_DIR']
    .map((key) => [key, process.env[key]]))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-notify-routing-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  configureWeixinStateDir()

  fs.writeFileSync(configFile(), JSON.stringify({
    enabled: true,
    allowedSenders: ['owner'],
    notifyEnabled: true,
    notifyPort: 47832,
    notifyToken: TOKEN,
    knowledgeEnabled: false,
    mediaEnabled: false,
    typingIndicator: false,
    metricsExport: false,
    backupEnabled: false,
  }))

  saveWeixinAccount(ACCOUNT, {
    token: 'synthetic-account-token',
    userId: 'owner',
    baseUrl: 'https://example.invalid',
  })
  registerWeixinAccountId(ACCOUNT)

  const oldKey = scopedLineKey(ACCOUNT, OLD_CONVERSATION)
  const newKey = scopedLineKey(ACCOUNT, NEW_CONVERSATION)
  const otherKey = scopedLineKey(OTHER_ACCOUNT, OTHER_CONVERSATION)
  writeLines({
    [oldKey]: {
      lines: [{ sessionId: 'old', title: 'old', createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: '2026-11-01T00:00:00.000Z' }],
      active: 'old',
    },
    [newKey]: {
      lines: [{ sessionId: 'new', title: 'new', createdAt: '2026-11-02T00:00:00.000Z', lastUsedAt: '2026-11-02T00:00:00.000Z' }],
      active: 'new',
    },
    [otherKey]: {
      lines: [{ sessionId: 'other', title: 'other', createdAt: '2027-01-01T00:00:00.000Z', lastUsedAt: '2027-01-01T00:00:00.000Z' }],
      active: 'other',
    },
  })

  let notifyHandler
  const server = fakeServer()
  t.mock.method(http, 'createServer', (handler) => {
    notifyHandler = handler
    return server
  })

  const started = []
  const sent = []
  t.mock.method(ILinkTransport.prototype, 'refreshConfig', async function () {})
  t.mock.method(ILinkTransport.prototype, 'start', async function () {
    this.testRunning = true
    started.push(this)
  })
  t.mock.method(ILinkTransport.prototype, 'stop', async function () {
    this.testRunning = false
  })
  t.mock.method(ILinkTransport.prototype, 'send', async function (message) {
    sent.push({ accountId: this.accountId, ...message })
  })

  const ctx = new Context()
  ctx.provide('agents', {
    create: async ({ sessionId }) => ({
      agent: { session: { id: sessionId, snapshotEvents: () => [] } },
      dispose: async () => {},
    }),
  })
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  }
  t.after(async () => {
    await dispose()
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  apply(ctx, {
    enabled: true,
    allowedSenders: ['owner'],
    knowledgeEnabled: false,
    notifyEnabled: true,
    notifyToken: TOKEN,
    notifyPort: 47832,
    metricsExport: false,
    backupEnabled: false,
    mediaEnabled: false,
    typingIndicator: false,
  })

  await until(() => started.length === 1 && typeof notifyHandler === 'function', 'apply starts the synthetic transport and notify server')
  assert.equal(server.host, '127.0.0.1')
  assert.equal(server.unrefCalled, true)

  assert.deepEqual(await postNotify(notifyHandler, 'first notification'), { status: 200, body: { ok: true } })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].accountId, ACCOUNT)
  assert.equal(sent[0].conversationId, NEW_CONVERSATION)
  assert.equal(sent[0].text, 'first notification')

  // Revisit A after B through the real delivery path, rather than manually
  // repairing lastUsedAt in the fixture. Existing titles must stay stable.
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: 'data:text/javascript,export const createUserMessage = value => value', shortCircuit: true }
    return next(specifier, context)
  }`)}`, import.meta.url)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-03T00:00:00.000Z') })
  const bridge = new AgentBridge({ ctx, lines: new SessionLines() })
  bridge.conversationTargets.set(oldKey, 'old')
  let steered = false
  t.mock.method(bridge, 'attach', async () => ({
    busy: true, auditMeta: { senderId: 'owner' },
    agent: { session: { id: 'old' }, steer() { steered = true } },
  }))
  await bridge.deliver({ conversationId: OLD_CONVERSATION, accountId: ACCOUNT, text: 'back to A', senderId: 'owner', busyMessageMode: 'steer' })
  assert.equal(steered, true)
  assert.equal(readLines()[oldKey].lines[0].title, 'old')
  assert.equal(readLines()[oldKey].lines[0].lastUsedAt, '2026-11-03T00:00:00.000Z')
  await bridge.dispose()

  assert.deepEqual(await postNotify(notifyHandler, 'second notification'), { status: 200, body: { ok: true } })
  assert.equal(sent.length, 2)
  assert.equal(sent[1].accountId, ACCOUNT)
  assert.equal(sent[1].conversationId, OLD_CONVERSATION)
  assert.equal(sent[1].text, 'second notification')

  writeLines({})
  const sentBeforeEmpty = sent.length
  assert.deepEqual(await postNotify(notifyHandler, 'must not send'), {
    status: 502,
    body: { ok: false, error: 'send failed' },
  })
  assert.equal(sent.length, sentBeforeEmpty)

  await dispose()
  assert.equal(server.closed, true)
  assert.equal(started.every((transport) => transport.testRunning === false), true)
})
