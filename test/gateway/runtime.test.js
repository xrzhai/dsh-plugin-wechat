import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.js'
import { AgentBridge } from '../../src/agent-bridge.js'
import { readRegistry, setAccountAllowlist } from '../../src/account-registry.js'
import { ILinkTransport } from '../../src/transport/ilink.js'
import { ConfigController } from '../../src/config-remote.js'
import { configureWeixinStateDir, configFile, stateDir } from '../../src/state.js'
import { lockFile } from '../../src/instance-lock.js'
import { createOutbox, FLUSH_INTERVAL_MS } from '../../src/message/outbox.js'
import { INBOUND_NOT_ACCEPTED } from '../../src/message/inbound-pending.js'
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
function fixture(t, { enabled = false, baseEnabled = true, allowedSenders = ['test-user'], allowedChats = [], refresh, stop, beforeApply, deliver, configOverrides, captureOutboxTick = false } = {}) {
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
  const media = []
  let outboxTick
  if (captureOutboxTick) {
    const originalSetInterval = globalThis.setInterval
    t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
      // The outbox starts before the lock heartbeat, which uses the same delay.
      if (delay === FLUSH_INTERVAL_MS && outboxTick === undefined) outboxTick = callback
      return originalSetInterval(callback, delay, ...args)
    })
  }
  if (deliver !== undefined) t.mock.method(AgentBridge.prototype, 'deliver', deliver)
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
  t.mock.method(ILinkTransport.prototype, 'sendMedia', async function (message) { media.push(message) })
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
  beforeApply?.(root)
  apply(ctx, { enabled: baseEnabled, allowedSenders, allowedChats, notifyEnabled: false, mediaEnabled: false, typingIndicator: false, ...configOverrides?.(root) })
  const controller = ctx.get('configController')
  const login = ctx.get('weixinLoginController')
  assert.ok(controller instanceof ConfigController)
  assert.equal(typeof controller.onConfigChanged, 'function')
  assert.equal(typeof login.onAccountControlChange, 'function')
  const message = (id) => ({ id, type: 'text', text: 'Hello', senderId: 'test-user', conversationId: 'test-user', contextToken: 'synthetic-context', timestamp: Date.now() })
  return { root, ctx, controller, login, prepared, started, stopped, sessions, sent, media, dispose, message, runOutbox: () => outboxTick() }
}

test('a recent unrelated file is not sent, while a referenced result still is', async (t) => {
  const f = fixture(t, {
    enabled: true,
    beforeApply(root) { fs.writeFileSync(path.join(root, 'unrelated.pdf'), 'unrelated') },
    configOverrides(root) { return { cwd: root, mediaEnabled: true, autoSendFiles: true } },
    async deliver({ text, onLateReply }) {
      if (text === 'late') {
        await onLateReply({ kind: 'reply', text: '[SILENT]' })
        return { late: true }
      }
      return { text: text === 'explicit' ? path.join(f.root, 'unrelated.pdf') : '[SILENT]' }
    },
  })
  await until(() => f.started.length === 1, 'transport starts')
  for (const text of ['silent', 'late']) {
    await f.started[0].testInbound({ ...f.message(text), text })
  }
  assert.deepEqual(f.media, [])
  assert.deepEqual(f.sent, [])
  await f.started[0].testInbound({ ...f.message('explicit'), text: 'explicit' })
  assert.equal(f.media.length, 1)
  assert.equal(f.media[0].filePath, fs.realpathSync(path.join(f.root, 'unrelated.pdf')))
})

test('reply and /send use the actual session cwd and can deliver a local file outside it', async t => {
  const parent = fs.mkdtempSync(path.join(stateDir(), 'external-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const external = path.join(parent, 'external report.pdf')
  fs.writeFileSync(external, 'external')
  const f = fixture(t, {
    enabled: true,
    beforeApply(root) {
      fs.mkdirSync(path.join(root, 'workspace'))
      fs.writeFileSync(path.join(root, 'workspace', 'inside.pdf'), 'inside')
    },
    configOverrides: root => ({ cwd: path.join(root, 'workspace'), mediaEnabled: true }),
    async deliver() { return { text: '[report](<' + external + '>)' } },
  })
  await until(() => f.started.length === 1, 'runtime starts')
  await f.started[0].testInbound({ ...f.message('external'), text: 'report please' })
  await f.started[0].testInbound({ ...f.message('relative'), text: '/send inside.pdf' })
  assert.deepEqual(f.media.map(m => m.filePath), [external, path.join(f.root, 'workspace', 'inside.pdf')].map(p => fs.realpathSync(p)))
})

test('an explicit attachment directory applies to both reply references and /send', async t => {
  const f = fixture(t, {
    enabled: true,
    beforeApply(root) {
      fs.mkdirSync(path.join(root, 'allowed'))
      fs.writeFileSync(path.join(root, 'private.pdf'), 'private')
    },
    configOverrides: root => ({ cwd: root, mediaEnabled: true, allowedMediaDirs: [path.join(root, 'allowed')] }),
    async deliver() { return { text: '[report](private.pdf)' } },
  })
  await until(() => f.started.length === 1, 'runtime starts')
  await f.started[0].testInbound({ ...f.message('plain'), text: 'report please' })
  await f.started[0].testInbound({ ...f.message('command'), text: '/send private.pdf' })
  assert.deepEqual(f.media, [])
  assert.equal(f.sent.length, 2)
})

test('unconfirmed and discarded turns report whether an input was executed', async (t) => {
  const f = fixture(t, {
    enabled: true,
    async deliver({ text, onLateReply }) {
      if (text === 'not-submitted') return { uncertain: true, notSubmitted: true }
      await onLateReply({ kind: 'discarded' })
      return { late: true }
    },
  })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound({ ...f.message('uncertain'), text: 'not-submitted' })
  await f.started[0].testInbound({ ...f.message('discarded'), text: 'discarded' })
  assert.equal(f.sent.length, 2)
  assert.match(f.sent[0].text, /没有执行/)
  assert.match(f.sent[1].text, /处理前丢弃/)
})

test('later results use the originating account and stop if it is paused during refresh', async (t) => {
  const refreshing = deferred()
  const continueRefresh = deferred()
  let holdRefresh = false
  let bridge
  const f = fixture(t, {
    enabled: true,
    async refresh() {
      if (holdRefresh) { refreshing.resolve(); await continueRefresh.promise }
    },
    async deliver() { bridge = this; return { text: '[SILENT]' } },
  })
  t.after(() => continueRefresh.resolve())
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound(f.message('capture-bridge'))
  await assert.rejects(bridge.onSpontaneousReply({ accountId: 'another-account', conversationId: 'test-user', text: 'wrong account' }), /originating account/)
  assert.deepEqual(f.sent, [])
  await bridge.onSpontaneousReply({ accountId: ACCOUNT, conversationId: 'test-user', text: 'right account' })
  assert.deepEqual(f.sent.map((message) => message.text), ['right account'])

  holdRefresh = true
  const pending = bridge.onSpontaneousReply({ accountId: ACCOUNT, conversationId: 'test-user', text: 'too late' })
  await refreshing.promise
  await f.login.pause(ACCOUNT)
  continueRefresh.resolve()
  await assert.rejects(pending, /originating account/)
  assert.deepEqual(f.sent.map((message) => message.text), ['right account'])
})

test('retired away state cannot intercept private messages or be rewritten by the gateway', async (t) => {
  const contents = JSON.stringify({
    schemaVersion: 1,
    accounts: {
      [ACCOUNT]: { startedAt: Date.now(), until: Date.now() + 3_600_000, note: 'synthetic-away', missed: [], replied: {} },
    },
  })
  const f = fixture(t, {
    enabled: true,
    beforeApply: (root) => {
      fs.writeFileSync(path.join(root, 'away.json'), contents)
      fs.writeFileSync(configFile(), JSON.stringify({ enabled: true, awayAutoReply: true }))
    },
  })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound(f.message('retired-away'))
  assert.equal(f.sessions.length, 1, 'private message reaches host session creation')
  assert.equal(fs.readFileSync(path.join(f.root, 'away.json'), 'utf8'), contents)
  assert.ok(f.sent.every((message) => !String(message.text).includes('synthetic-away')))
  await f.dispose()
  assert.equal(fs.readFileSync(path.join(f.root, 'away.json'), 'utf8'), contents)
})

test('starting and disabling the gateway preserves inactive legacy user data', async (t) => {
  const fireAt = Date.now() + 40
  const files = new Map([
    ['reminders.json', Buffer.from(JSON.stringify({ schemaVersion: 1, seq: 1, items: [{
      id: 'r1', accountId: ACCOUNT, conversationId: 'test-user', text: 'synthetic reminder', fireAt,
    }] }))],
    ['subscriptions.json', Buffer.from(JSON.stringify({ schemaVersion: 1, seq: 1, items: [{
      id: 's1', accountId: ACCOUNT, conversationId: 'test-user', prompt: 'synthetic subscription', kind: 'once', fireAt,
    }] }))],
    ['journal/journal-2000-01-01.jsonl', Buffer.from('{"text":"synthetic historical message"}\n')],
    ['backups/2000-01-01/sessions.json', Buffer.from('{"synthetic":"backup"}\n')],
    ['backups/2000-01-01/archive.bin', Buffer.from([0, 1, 127, 255])],
  ])
  const f = fixture(t, {
    enabled: true,
    beforeApply(root) {
      for (const [relative, contents] of files) {
        const file = path.join(root, relative)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, contents)
        if (relative.startsWith('journal/')) fs.utimesSync(file, new Date('2000-01-01'), new Date('2000-01-01'))
      }
    },
  })
  const assertPreserved = () => {
    for (const [relative, contents] of files) assert.deepEqual(fs.readFileSync(path.join(f.root, relative)), contents, relative)
  }
  await until(() => f.started.length === 1, 'transport starts')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assertPreserved()
  assert.deepEqual(f.sessions, [], 'legacy subscriptions do not start host sessions')
  assert.deepEqual(f.sent, [], 'legacy schedules do not send messages')
  assert.deepEqual(f.media, [])

  await saveEnabled(f.controller, false)
  assert.equal(f.started[0].testRunning, false)
  await f.dispose()
  assertPreserved()
  assert.deepEqual(f.sessions, [])
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.media, [])
})

test('a stranger cannot enroll when the global sender allowlist is configured', async (t) => {
  const f = fixture(t, { enabled: true })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound({ ...f.message('stranger'), senderId: 'stranger', conversationId: 'stranger' })
  assert.equal(f.sessions.length, 0)
  assert.equal(readRegistry()[ACCOUNT]?.allowedSenders, undefined)
  await f.started[0].testInbound(f.message('owner'))
  assert.equal(f.sessions.length, 1)
})

test('saved sender settings prevent enrollment even when startup configuration is empty', async (t) => {
  const f = fixture(t, {
    enabled: true,
    allowedSenders: [],
    beforeApply: () => fs.writeFileSync(configFile(), JSON.stringify({ enabled: true, allowedSenders: ['test-user'] })),
  })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound({ ...f.message('stranger-saved'), senderId: 'stranger', conversationId: 'stranger' })
  assert.equal(f.sessions.length, 0)
  assert.equal(readRegistry()[ACCOUNT]?.allowedSenders, undefined)
  await f.started[0].testInbound(f.message('owner-saved'))
  assert.equal(f.sessions.length, 1)
})

test('a sender list saved at runtime prevents first-contact enrollment', async (t) => {
  const f = fixture(t, { enabled: true, allowedSenders: [] })
  await until(() => f.started.length === 1, 'transport starts')
  await f.controller.save(JSON.stringify([{ path: 'allowedSenders', value: ['test-user'] }]))
  const transport = f.started.at(-1)
  await transport.testInbound({ ...f.message('stranger-live'), senderId: 'stranger', conversationId: 'stranger' })
  assert.equal(f.sessions.length, 0)
  assert.equal(readRegistry()[ACCOUNT]?.allowedSenders, undefined)
  await transport.testInbound(f.message('owner-live'))
  assert.equal(f.sessions.length, 1)
})

test('an account sender list overrides the global sender list', async (t) => {
  const f = fixture(t, {
    enabled: true,
    beforeApply: () => setAccountAllowlist(ACCOUNT, ['account-owner']),
  })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound(f.message('global-owner'))
  assert.equal(f.sessions.length, 0)
  await f.started[0].testInbound({ ...f.message('account-owner'), senderId: 'account-owner', conversationId: 'account-owner' })
  assert.equal(f.sessions.length, 1)
  assert.deepEqual(readRegistry()[ACCOUNT]?.allowedSenders, ['account-owner'])
})

for (const { label, contents } of [
  { label: 'invalid JSON', contents: '{invalid-account-registry\n' },
  { label: 'a null document', contents: 'null\n' },
  { label: 'an array document', contents: '[]\n' },
]) {
  test(`an account registry containing ${label} refuses inbound without overwriting it`, async (t) => {
    const f = fixture(t, {
      enabled: true,
      allowedSenders: [],
      beforeApply: () => setAccountAllowlist(ACCOUNT, ['synthetic-owner']),
    })
    const registryPath = path.join(f.root, 'accounts-registry.json')

    await until(() => f.started.length === 1, 'transport starts')
    fs.writeFileSync(registryPath, contents)
    await f.started[0].testInbound(f.message(`corrupt-${label.replaceAll(' ', '-')}`))

    assert.equal(f.sessions.length, 0)
    assert.deepEqual(f.sent, [])
    assert.equal(fs.readFileSync(registryPath, 'utf8'), contents)
  })
}

test('a non-ENOENT registry read error refuses inbound without replacing the path', async (t) => {
  const f = fixture(t, {
    enabled: true,
  })
  const registryPath = path.join(f.root, 'accounts-registry.json')

  await until(() => f.started.length === 1, 'transport starts')
  fs.mkdirSync(registryPath)
  await f.started[0].testInbound(f.message('registry-read-error'))

  assert.equal(f.sessions.length, 0)
  assert.deepEqual(f.sent, [])
  assert.equal(fs.statSync(registryPath).isDirectory(), true)
})

test('a restored registry resumes its original narrower account allowlist', async (t) => {
  const corrupt = '{invalid-account-registry\n'
  const restored = `${JSON.stringify({
    schemaVersion: 1,
    [ACCOUNT]: {
      allowedSenders: ['synthetic-owner'],
      firstContactEnrolledAt: '2026-11-05T00:00:00.000Z',
    },
  }, null, 2)}\n`
  const f = fixture(t, {
    enabled: true,
    allowedSenders: ['global-owner'],
    beforeApply: () => setAccountAllowlist(ACCOUNT, ['synthetic-owner']),
  })
  const registryPath = path.join(f.root, 'accounts-registry.json')

  await until(() => f.started.length === 1, 'transport starts')
  fs.writeFileSync(registryPath, corrupt)
  await f.started[0].testInbound({ ...f.message('corrupt-global-owner'), senderId: 'global-owner', conversationId: 'global-owner' })
  assert.equal(f.sessions.length, 0, 'corruption must not fall back to the broader global list')
  assert.equal(fs.readFileSync(registryPath, 'utf8'), corrupt)

  fs.writeFileSync(registryPath, restored)
  await f.started[0].testInbound({ ...f.message('restored-global-owner'), senderId: 'global-owner', conversationId: 'global-owner' })
  assert.equal(f.sessions.length, 0, 'the restored account list stays narrower than the global list')
  await f.started[0].testInbound({ ...f.message('restored-owner'), senderId: 'synthetic-owner', conversationId: 'synthetic-owner' })
  assert.equal(f.sessions.length, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8'))[ACCOUNT].allowedSenders, ['synthetic-owner'])
})

test('settings operations report a corrupt registry without changing the file or restarting the account', async (t) => {
  const f = fixture(t, { enabled: true })
  await until(() => f.started.length === 1, 'transport starts')
  const file = path.join(f.root, 'accounts-registry.json')
  const corrupt = '{synthetic-corrupt-registry\n'
  fs.writeFileSync(file, corrupt)
  for (const operation of [
    () => f.login.pause(ACCOUNT),
    () => f.login.resume(ACCOUNT),
    () => f.login.label(ACCOUNT, 'new label'),
    () => f.login.allowlist(ACCOUNT, 'stranger', ''),
    () => f.login.status(),
  ]) {
    await assert.rejects(operation(), (error) => error.code === 'registry_unreadable' && /accounts-registry\.json/.test(error.message))
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt)
  }
  assert.equal(f.started.length, 1)
  assert.equal(f.started[0].testRunning, true)
})

test('a malformed account is isolated from another account in runtime and settings', async (t) => {
  const badId = 'synthetic-bad-account'
  const badEntry = { allowedSenders: 'invalid', extra: { keep: true } }
  const f = fixture(t, {
    enabled: true,
    beforeApply: (root) => {
      saveWeixinAccount(badId, { token: 'synthetic-token', userId: 'other', baseUrl: 'https://example.invalid' })
      registerWeixinAccountId(badId)
      fs.writeFileSync(path.join(root, 'accounts-registry.json'), JSON.stringify({
        [ACCOUNT]: { allowedSenders: ['test-user'], paused: false },
        [badId]: badEntry,
      }))
    },
  })
  await until(() => f.started.length === 1, 'healthy transport starts')
  assert.equal(f.started[0].accountId, ACCOUNT)
  const status = await f.login.status()
  assert.equal(status.accounts.length, 2)
  const healthy = status.accounts.find((entry) => entry.accountId === ACCOUNT)
  const bad = status.accounts.find((entry) => entry.accountId === badId)
  assert.deepEqual(healthy.allowedSenders, ['test-user'])
  assert.equal(healthy.paused, false)
  assert.equal(healthy.registryError, undefined)
  assert.equal(bad.paused, null)
  assert.match(bad.registryError, /accounts-registry\.json/)
  await f.login.label(ACCOUNT, 'healthy updated')
  await assert.rejects(f.login.label(badId, 'blocked'), { code: 'registry_unreadable' })
  await f.started[0].testInbound(f.message('healthy-despite-other-account'))
  assert.equal(f.sessions.length, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'accounts-registry.json'), 'utf8'))[badId], badEntry)
})

test('a registry failure before message processing releases the durable claim', async (t) => {
  const f = fixture(t, { enabled: true, beforeApply: () => setAccountAllowlist(ACCOUNT, ['test-user']) })
  await until(() => f.started.length === 1, 'transport starts')
  const file = path.join(f.root, 'accounts-registry.json')
  let reads = 0
  const originalStat = fs.statSync
  const mock = t.mock.method(fs, 'statSync', function (target, ...args) {
    if (String(target) === file && ++reads === 2) throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' })
    return originalStat.call(this, target, ...args)
  })
  const message = f.message('registry-early-read-failure')
  const result = await f.started[0].testInbound(message)
  assert.equal(result, INBOUND_NOT_ACCEPTED)
  assert.equal(f.sessions.length, 0)
  assert.deepEqual(f.sent, [])
  mock.mock.restore()
  await f.started[0].testInbound(message)
  assert.equal(f.sessions.length, 1, 'the refused message was not marked as a duplicate')
})

test('a registry failure after dedupe is reported as uncertain, not completed', async (t) => {
  const f = fixture(t, { enabled: true, beforeApply: () => setAccountAllowlist(ACCOUNT, ['test-user']) })
  await until(() => f.started.length === 1, 'transport starts')
  const file = path.join(f.root, 'accounts-registry.json')
  let reads = 0
  const originalStat = fs.statSync
  t.mock.method(fs, 'statSync', function (target, ...args) {
    if (String(target) === file && ++reads === 3) throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' })
    return originalStat.call(this, target, ...args)
  })
  await assert.rejects(f.started[0].testInbound(f.message('registry-late-read-failure')), { name: 'RegistryReadError' })
  assert.equal(f.sessions.length, 0)
  assert.deepEqual(f.sent, [])
})

test('an unreadable registry at startup does not start an account transport', async (t) => {
  const corrupt = '{startup-corrupt\n'
  const f = fixture(t, { enabled: true, beforeApply: (root) => fs.writeFileSync(path.join(root, 'accounts-registry.json'), corrupt) })
  await f.dispose()
  assert.equal(f.started.length, 0)
  assert.equal(f.prepared.length, 0)
  assert.equal(fs.readFileSync(path.join(f.root, 'accounts-registry.json'), 'utf8'), corrupt)
})

test('manual outbox recovery is authorized and limited to the originating chat', async t => {
  const f = fixture(t, { enabled: true })
  await until(() => f.started.length === 1, 'runtime starts')
  const queue = createOutbox({ stateRoot: f.root, transportFor: () => undefined })
  for (const conversationId of ['test-user', 'another']) {
    queue.enqueue({ accountId: ACCOUNT, conversationId, text: 'kept for ' + conversationId, deliveryUncertain: true })
  }
  const inbound = f.started[0].testInbound
  await inbound({ ...f.message('denied'), senderId: 'stranger', text: '/outbox retry' })
  assert.deepEqual(f.sent, [])
  await inbound({ ...f.message('inspect'), text: '/outbox' })
  assert.match(f.sent[0].text, /1/)
  await inbound({ ...f.message('recover'), text: '/outbox retry' })
  assert.equal(f.sent[1].text, 'kept for test-user')
  assert.equal(f.sent.length, 3)
  assert.deepEqual(queue.pending().map(item => item.conversationId), ['another'])
  assert.equal(f.sessions.length, 0)
})

test('outbox retry waits while the authorization registry is corrupt', async (t) => {
  const f = fixture(t, { enabled: true, captureOutboxTick: true })
  await until(() => f.started.length === 1, 'runtime starts')
  const queue = createOutbox({ stateRoot: f.root, transportFor: () => undefined })
  queue.enqueue({ accountId: ACCOUNT, conversationId: 'test-user', text: 'synthetic queued reply' })
  const file = path.join(f.root, 'accounts-registry.json')
  fs.writeFileSync(file, '{broken')
  f.runOutbox()
  await tick()
  await tick()
  assert.equal(queue.pending().length, 1)
  assert.deepEqual(f.sent, [])
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
  fs.writeFileSync(file, '{}')
  f.runOutbox()
  await until(() => f.sent.length === 1 && queue.pending().length === 0, 'queued reply sent after registry recovery')
  assert.equal(f.sent[0].text, 'synthetic queued reply')
})

test('outbox stops between segments if registry becomes corrupt during delivery', async (t) => {
  const f = fixture(t, { enabled: true, captureOutboxTick: true })
  await until(() => f.started.length === 1, 'runtime starts')
  const queue = createOutbox({ stateRoot: f.root, transportFor: () => undefined })
  queue.enqueue({ accountId: ACCOUNT, conversationId: 'test-user', segments: ['first', 'second'] })
  const file = path.join(f.root, 'accounts-registry.json')
  const delivered = []
  f.started[0].send = async (message) => {
    delivered.push(message.text)
    fs.writeFileSync(file, '{broken after first segment')
  }
  f.runOutbox()
  await until(() => queue.pending()[0]?.nextSegment === 1, 'first segment persisted')
  await tick()
  assert.deepEqual(delivered, ['first'])
  assert.equal(queue.pending().length, 1)
  assert.equal(queue.pending()[0].nextSegment, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken after first segment')
})

test('the default minute limit lets an authorized owner send a burst of commands', async t => {
  const f = fixture(t, { enabled: true })
  await until(() => f.started.length === 1, 'runtime starts')
  for (let i = 0; i < 25; i++) await f.started[0].testInbound({ ...f.message('burst-' + i), text: '/list' })
  assert.equal(f.sent.length, 25)
  assert.ok(f.sent.every(m => m.text.includes('/use')))
})

test('strangers receive no quota or unsupported notices; an explicit minute limit applies to the owner', async t => {
  const f = fixture(t, { enabled: true, configOverrides: () => ({ senderRatePerMinute: 1, senderDailyLimit: 3 }) })
  await until(() => f.started.length === 1, 'runtime starts')
  const inbound = f.started[0].testInbound
  for (let i = 0; i < 4; i++) await inbound({ ...f.message('denied-' + i), senderId: 'stranger', conversationId: 'stranger', text: '/list' })
  await inbound({ ...f.message('denied-kind'), senderId: 'stranger', unsupported: 'future kind' })
  assert.deepEqual(f.sent, [])
  await inbound({ ...f.message('owner-1'), text: '/list' })
  await inbound({ ...f.message('owner-2'), text: '/list' })
  assert.equal(f.sent.length, 2)
  assert.match(f.sent[0].text, /\/use/)
  assert.match(f.sent[1].text, /发得有点快|too fast/i)
})

test('an empty sender list enrolls only the first contact in a permitted chat', async (t) => {
  const f = fixture(t, { enabled: true, allowedSenders: [], allowedChats: ['test-user'] })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound({ ...f.message('wrong-chat'), senderId: 'stranger', conversationId: 'stranger' })
  assert.equal(f.sessions.length, 0)
  assert.equal(readRegistry()[ACCOUNT]?.allowedSenders, undefined)
  await f.started[0].testInbound(f.message('first'))
  assert.equal(f.sessions.length, 1)
  assert.deepEqual(readRegistry()[ACCOUNT]?.allowedSenders, ['test-user'])
  await f.started[0].testInbound({ ...f.message('second'), senderId: 'stranger', conversationId: 'stranger' })
  assert.equal(f.sessions.length, 1)
  assert.deepEqual(readRegistry()[ACCOUNT]?.allowedSenders, ['test-user'])
})

test('automatic enrollment admits just one sender when chats are unrestricted', async (t) => {
  const f = fixture(t, { enabled: true, allowedSenders: [] })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound(f.message('first-unrestricted'))
  await f.started[0].testInbound({ ...f.message('second-unrestricted'), senderId: 'stranger', conversationId: 'stranger' })
  assert.equal(f.sessions.length, 1)
  assert.deepEqual(readRegistry()[ACCOUNT]?.allowedSenders, ['test-user'])
})

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


for (const scenario of [
  { name: 'disabled groups', groupChatEnabled: false, senderId: 'test-user', conversationId: 'allowed-group' },
  { name: 'unmentioned groups', groupChatEnabled: true, groupReplyWhen: 'mention', senderId: 'test-user', conversationId: 'allowed-group' },
  { name: 'unauthorized group sender', groupChatEnabled: true, senderId: 'stranger', conversationId: 'allowed-group' },
  { name: 'unauthorized group chat', groupChatEnabled: true, senderId: 'test-user', conversationId: 'denied-group' },
]) {
  test(scenario.name + ' cannot reach the host or receive a reply', async t => {
    const f = fixture(t, {
      enabled: true,
      allowedChats: ['allowed-group', 'test-user'],
      beforeApply: () => fs.writeFileSync(configFile(), JSON.stringify({
        enabled: true,
        groupChatEnabled: scenario.groupChatEnabled,
        groupReplyWhen: scenario.groupReplyWhen ?? 'all',
        groupSummaryEnabled: true,
        groupSummaryEvery: 4,
        groupKeywords: '^Hello$ => retired keyword reply',
      })),
    })
    await until(() => f.started.length === 1, 'transport starts')
    for (let i = 0; i < 4; i += 1) {
      await f.started[0].testInbound({ ...f.message('retired-group-' + i), senderId: scenario.senderId, conversationId: scenario.conversationId })
    }
    await tick()
    assert.equal(f.sessions.length, 0)
    assert.deepEqual(f.sent, [])
    await f.started[0].testInbound(f.message('retained-private-message'))
    assert.equal(f.sessions.length, 1, 'private messages still reach the host')
  })
}

test('explicitly enabled and authorized basic group messages still reach the host', async t => {
  const f = fixture(t, {
    enabled: true,
    allowedChats: ['allowed-group'],
    beforeApply: () => fs.writeFileSync(configFile(), JSON.stringify({ enabled: true, groupChatEnabled: true, groupReplyWhen: 'all' })),
  })
  await until(() => f.started.length === 1, 'transport starts')
  await f.started[0].testInbound({ ...f.message('retained-basic-group'), conversationId: 'allowed-group' })
  assert.equal(f.sessions.length, 1)
})
