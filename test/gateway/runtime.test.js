import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.js'
import { ILinkTransport } from '../../src/transport/ilink.js'
import { ConfigController } from '../../src/config-remote.js'
import { configureWeixinStateDir, configFile, stateDir } from '../../src/state.js'
import { lockFile } from '../../src/instance-lock.js'
import { saveWeixinAccount, registerWeixinAccountId } from '../../vendor/openclaw-weixin/auth/accounts.js'

const ACCOUNT = 'runtime-fixture'
const saveEnabled = (controller, enabled) => controller.save(JSON.stringify([{ path: 'enabled', value: enabled }]))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
async function until(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await tick()
  }
  assert.ok(predicate(), label)
}

// Real Cordis services, persistence, apply(), AgentBridge and gateway wiring.
// Only the external iLink boundary and host session factory are synthetic.
function fixture(t, { enabled = false, baseEnabled = true, refresh, stop } = {}) {
  const env = Object.fromEntries(['DSH_WEIXIN_STATE_DIR', 'OPENCLAW_STATE_DIR', 'CLAWDBOT_STATE_DIR'].map((key) => [key, process.env[key]]))
  const root = fs.mkdtempSync(path.join(stateDir(), 'runtime-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  configureWeixinStateDir()
  fs.writeFileSync(configFile(), JSON.stringify({ enabled }))
  saveWeixinAccount(ACCOUNT, { token: 'synthetic-test-token', userId: 'test-user', baseUrl: 'https://example.invalid' })
  registerWeixinAccountId(ACCOUNT)
  const prepared = []
  const started = []
  const stopped = []
  const sessions = []
  const sent = []
  t.mock.method(ILinkTransport.prototype, 'refreshConfig', async function () {
    prepared.push(this)
    await refresh?.(this, prepared.length)
  })
  t.mock.method(ILinkTransport.prototype, 'start', async function (inbound) {
    this.testInbound = inbound
    this.testRunning = true
    started.push(this)
  })
  t.mock.method(ILinkTransport.prototype, 'stop', function () {
    this.testRunning = false
    stopped.push(this)
    return Promise.resolve(stop?.(this))
  })
  t.mock.method(ILinkTransport.prototype, 'send', async function (message) { sent.push(message) })
  const ctx = new Context()
  ctx.provide('agents', {
    create: async (options) => {
      sessions.push(options)
      throw new Error('Synthetic host session boundary reached')
    },
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
  apply(ctx, { enabled: baseEnabled, allowedSenders: ['test-user'], knowledgeEnabled: false, notifyEnabled: false, mediaEnabled: false, typingIndicator: false })
  const controller = ctx.get('configController')
  const login = ctx.get('weixinLoginController')
  assert.ok(controller instanceof ConfigController)
  assert.equal(typeof controller.onConfigChanged, 'function')
  assert.equal(typeof login.onAccountControlChange, 'function')
  const message = (id) => ({ id, type: 'text', text: 'Hello', senderId: 'test-user', conversationId: 'test-user', contextToken: 'synthetic-context', timestamp: Date.now() })
  return { root, ctx, controller, login, prepared, started, stopped, sessions, sent, dispose, message }
}

test('apply starts from saved disabled state; real save enables, disables and fences queued inbound', async (t) => {
  const f = fixture(t)
  await tick()
  assert.equal(f.prepared.length, 0)
  await saveEnabled(f.controller, true)
  assert.equal(f.started.length, 1)
  const old = f.started[0]
  // Positive control: this exact inbound callback can reach the real bridge's
  // session factory before the switch is disabled.
  await old.testInbound(f.message('admitted'))
  assert.equal(f.sessions.length, 1)
  await saveEnabled(f.controller, false)
  assert.equal(old.testRunning, false)
  assert.deepEqual(f.stopped, [old])
  await old.testInbound(f.message('queued-before-disable'))
  assert.equal(f.sessions.length, 1)
  await saveEnabled(f.controller, true)
  assert.equal(f.started.length, 2)
  await old.testInbound(f.message('stale-after-enable'))
  assert.equal(f.sessions.length, 1)
  await f.started[1].testInbound(f.message('new-generation'))
  assert.equal(f.sessions.length, 2)
  await f.dispose()
  assert.ok(f.started.every((transport) => !transport.testRunning))
  assert.equal(f.controller.onConfigChanged, undefined)
  assert.equal(f.login.onAccountControlChange, undefined)
  assert.equal(f.login.onAccountBound, undefined)
  assert.equal(fs.existsSync(lockFile(f.root)), false)
})

test('real reset restores composition instead of saved disabled startup overlay', async (t) => {
  const f = fixture(t)
  await f.controller.reset(JSON.stringify(['enabled']))
  assert.equal(f.started.length, 1)
})

test('real reset preserves an explicitly disabled composition', async (t) => {
  const f = fixture(t, { enabled: true, baseEnabled: false })
  await until(() => f.started.length === 1, 'initial saved enable starts')
  await f.controller.reset(JSON.stringify(['enabled']))
  assert.equal(f.started[0].testRunning, false)
})

test('off/on waits for previous transport stop handshake before starting replacement', async (t) => {
  const drained = deferred()
  t.after(() => drained.resolve())
  const f = fixture(t, { stop: () => drained.promise })
  await saveEnabled(f.controller, true)
  await saveEnabled(f.controller, false)
  const enabling = saveEnabled(f.controller, true)
  await tick()
  assert.equal(f.started.length, 1)
  assert.equal(f.prepared.length, 1)
  drained.resolve()
  await enabling
  assert.equal(f.started.length, 2)
})

test('disable while refreshConfig is pending prevents startup', async (t) => {
  const refreshed = deferred()
  t.after(() => refreshed.resolve())
  const f = fixture(t, { refresh: () => refreshed.promise })
  const enabling = saveEnabled(f.controller, true)
  await until(() => f.prepared.length === 1, 'refresh entered')
  await saveEnabled(f.controller, false)
  refreshed.resolve()
  await enabling
  assert.equal(f.started.length, 0)
})

test('pause/resume during refresh invalidates old preparation and starts only its replacement', async (t) => {
  const refreshed = deferred()
  t.after(() => refreshed.resolve())
  const f = fixture(t, { refresh: (_transport, count) => count === 1 ? refreshed.promise : undefined })
  const enabling = saveEnabled(f.controller, true)
  await until(() => f.prepared.length === 1, 'first preparation entered')
  const stale = f.prepared[0]
  await f.login.pause(ACCOUNT)
  await f.login.resume(ACCOUNT)
  refreshed.resolve()
  await enabling
  await until(() => f.started.length === 1, 'resumed account starts')
  assert.notEqual(f.started[0], stale)
  assert.equal(stale.testInbound, undefined)
  await f.login.pause(ACCOUNT)
  assert.equal(f.started[0].testRunning, false)
  await saveEnabled(f.controller, false)
  await f.login.resume(ACCOUNT)
  await tick()
  assert.equal(f.started.length, 1)
  await saveEnabled(f.controller, true)
  assert.equal(f.started.length, 2)
})

test('disabled startup can be disposed immediately without leaking setup resources or callbacks', async (t) => {
  const f = fixture(t)
  await f.dispose()
  assert.equal(f.started.length, 0)
  assert.equal(f.controller.onConfigChanged, undefined)
  assert.equal(f.login.onAccountBound, undefined)
  assert.equal(fs.existsSync(lockFile(f.root)), false)
  await saveEnabled(f.controller, true)
  await tick()
  assert.equal(f.started.length, 0)
})

test('disposal waits for startup refresh and prevents that preparation from starting', async (t) => {
  const refreshed = deferred()
  t.after(() => refreshed.resolve())
  const f = fixture(t, { refresh: () => refreshed.promise })
  const enabling = saveEnabled(f.controller, true)
  await until(() => f.prepared.length === 1, 'refresh entered')
  let finished = false
  const disposing = f.dispose().then(() => { finished = true })
  await tick()
  assert.equal(finished, false)
  refreshed.resolve()
  await enabling
  await disposing
  assert.equal(f.started.length, 0)
  assert.equal(fs.existsSync(lockFile(f.root)), false)
})

test('disposal drains a stop already initiated by disabling the gateway', async (t) => {
  const drained = deferred()
  t.after(() => drained.resolve())
  const f = fixture(t, { stop: () => drained.promise })
  await saveEnabled(f.controller, true)
  await saveEnabled(f.controller, false)
  let finished = false
  const disposing = f.dispose().then(() => { finished = true })
  await tick()
  assert.equal(finished, false)
  assert.equal(f.stopped.length, 1)
  drained.resolve()
  await disposing
  assert.equal(finished, true)
  assert.equal(f.controller.onConfigChanged, undefined)
})
