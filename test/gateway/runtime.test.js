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
import { readReminders, writeReminders } from '../../src/message/scheduler.js'
import { readSubscriptions, writeSubscriptions } from '../../src/message/subscriptions.js'
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
async function untilEventually(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick(10)
  }
  assert.ok(predicate(), label)
}

function seedSubscription(root, prompt) {
  writeSubscriptions(root, {
    seq: 1,
    items: [{
      id: 's1',
      accountId: ACCOUNT,
      conversationId: 'test-user',
      prompt,
      kind: 'once',
      fireAt: Date.now() + 200,
      createdAt: Date.now(),
    }],
  })
}

// Real Cordis services, persistence, apply(), AgentBridge and gateway wiring.
// Only the external iLink boundary and host session factory are synthetic.
function fixture(t, { enabled = false, baseEnabled = true, allowedSenders = ['test-user'], allowedChats = [], refresh, stop, beforeApply, summarize, deliver, configOverrides } = {}) {
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
  if (summarize !== undefined) t.mock.method(AgentBridge.prototype, 'summarize', summarize)
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
  return { root, ctx, controller, login, prepared, started, stopped, sessions, sent, media, dispose, message }
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
      beforeApply: (root) => fs.writeFileSync(path.join(root, 'accounts-registry.json'), contents),
    })
    const registryPath = path.join(f.root, 'accounts-registry.json')

    await until(() => f.started.length === 1, 'transport starts')
    await f.started[0].testInbound(f.message(`corrupt-${label.replaceAll(' ', '-')}`))

    assert.equal(f.sessions.length, 0)
    assert.deepEqual(f.sent, [])
    assert.equal(fs.readFileSync(registryPath, 'utf8'), contents)
  })
}

test('a non-ENOENT registry read error refuses inbound without replacing the path', async (t) => {
  const f = fixture(t, {
    enabled: true,
    beforeApply: (root) => fs.mkdirSync(path.join(root, 'accounts-registry.json')),
  })
  const registryPath = path.join(f.root, 'accounts-registry.json')

  await until(() => f.started.length === 1, 'transport starts')
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
    beforeApply: (root) => fs.writeFileSync(path.join(root, 'accounts-registry.json'), corrupt),
  })
  const registryPath = path.join(f.root, 'accounts-registry.json')

  await until(() => f.started.length === 1, 'transport starts')
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

test('a persisted due reminder survives missing startup transport and wakes when it becomes live', async (t) => {
  const fireAt = Date.now() - 1
  const f = fixture(t, {
    beforeApply: (root) => writeReminders(root, {
      seq: 1,
      items: [{
        id: 'r1',
        accountId: ACCOUNT,
        conversationId: 'test-user',
        text: 'delayed startup',
        fireAt,
        createdAt: new Date(fireAt - 60_000).toISOString(),
      }],
    }),
  })
  await tick()
  assert.equal(f.sent.length, 0)
  assert.equal(readReminders(f.root).items[0].id, 'r1')

  await saveEnabled(f.controller, true)
  await until(() => f.sent.some((message) => message.text === '（提醒：delayed startup）'), 'reminder sent after transport starts')
  await until(() => readReminders(f.root).items.length === 0, 'delivered reminder removed')
})

test('a reminder due while its account is paused is sent after resume', async (t) => {
  const f = fixture(t, { enabled: true })
  await until(() => f.started.length === 1, 'transport starts')
  await f.login.pause(ACCOUNT)
  assert.equal(f.started[0].testRunning, false)

  const scheduled = f.login.remindersProvider.schedule({
    accountId: ACCOUNT,
    conversationId: 'test-user',
    text: 'resume delivery',
    fireAt: Date.now() - 1,
  })
  assert.equal(scheduled.id, 'r1')
  await tick()
  assert.equal(f.sent.length, 0)
  assert.equal(readReminders(f.root).items[0].id, 'r1')

  await f.login.resume(ACCOUNT)
  await until(() => f.sent.some((message) => message.text === '（提醒：resume delivery）'), 'reminder sent after resume')
  await until(() => readReminders(f.root).items.length === 0, 'resumed reminder removed')
})

test('fire entry rejects a committed pause before the transport removal callback', async (t) => {
  let summaries = 0
  const f = fixture(t, {
    enabled: true,
    summarize: async () => { summaries += 1; return { text: 'must not generate' } },
  })
  await until(() => f.started.length === 1 && f.login.subscriptionScheduler !== undefined, 'runtime starts')
  const releaseControl = deferred()
  const originalControl = f.login.onAccountControlChange
  f.login.onAccountControlChange = async (accountId) => {
    await releaseControl.promise
    return originalControl?.(accountId)
  }

  await f.login.pause(ACCOUNT)
  assert.equal(f.started[0].testRunning, true)
  f.login.remindersProvider.schedule({
    accountId: ACCOUNT,
    conversationId: 'test-user',
    text: 'paused entry',
    fireAt: Date.now() - 1,
  })
  f.login.subscriptionScheduler.schedule({
    accountId: ACCOUNT,
    conversationId: 'test-user',
    prompt: 'paused entry',
    when: { ok: true, kind: 'once', fireAt: Date.now() - 1 },
  })
  await tick()
  await tick()
  assert.deepEqual(f.sent, [])
  assert.equal(summaries, 0)
  assert.equal(readReminders(f.root).items.length, 1)
  assert.equal(readSubscriptions(f.root).items.length, 1)

  releaseControl.resolve()
  await until(() => f.started[0].testRunning === false, 'paused transport stops after callback release')
  f.login.onAccountControlChange = originalControl
})

test('fire entry rejects committed disablement before the transport removal callback', async (t) => {
  let summaries = 0
  const f = fixture(t, {
    enabled: true,
    summarize: async () => { summaries += 1; return { text: 'must not generate' } },
  })
  await until(() => f.started.length === 1 && f.login.subscriptionScheduler !== undefined, 'runtime starts')
  const configCommitted = deferred()
  const releaseConfig = deferred()
  const originalChanged = f.controller.onConfigChanged
  f.controller.onConfigChanged = async () => {
    configCommitted.resolve()
    await releaseConfig.promise
    return originalChanged?.()
  }

  const saving = saveEnabled(f.controller, false)
  await configCommitted.promise
  assert.equal(f.started[0].testRunning, true)
  f.login.remindersProvider.schedule({
    accountId: ACCOUNT,
    conversationId: 'test-user',
    text: 'disabled entry',
    fireAt: Date.now() - 1,
  })
  f.login.subscriptionScheduler.schedule({
    accountId: ACCOUNT,
    conversationId: 'test-user',
    prompt: 'disabled entry',
    when: { ok: true, kind: 'once', fireAt: Date.now() - 1 },
  })
  await tick()
  await tick()
  assert.deepEqual(f.sent, [])
  assert.equal(summaries, 0)
  assert.equal(readReminders(f.root).items.length, 1)
  assert.equal(readSubscriptions(f.root).items.length, 1)

  releaseConfig.resolve()
  await saving
  f.controller.onConfigChanged = originalChanged
})

test('a subscription generated while its account pauses is not sent to the stopped transport', async (t) => {
  const generated = deferred()
  const released = deferred()
  const summaries = []
  const f = fixture(t, {
    enabled: true,
    beforeApply: (root) => seedSubscription(root, 'pause during generation'),
    summarize: async () => {
      summaries.push('summarize')
      if (summaries.length === 1) {
        generated.resolve()
        await released.promise
        return { text: 'stale generation' }
      }
      return { text: 'after resume' }
    },
  })
  await until(() => f.started.length === 1, 'subscription runtime starts')
  await generated.promise

  await f.login.pause(ACCOUNT)
  released.resolve()
  await tick()
  await tick()
  assert.deepEqual(f.sent, [])
  assert.equal(readSubscriptions(f.root).items.length, 1)

  await f.login.resume(ACCOUNT)
  await untilEventually(() => f.sent.some((message) => message.text === 'after resume'), 'subscription sends after resume')
  assert.ok(f.sent.every((message) => message.text !== 'stale generation'))
  assert.deepEqual(readSubscriptions(f.root).items, [])
})

test('a subscription generated while the gateway is disabled waits for re-enable', async (t) => {
  const generated = deferred()
  const released = deferred()
  const summaries = []
  const f = fixture(t, {
    enabled: true,
    beforeApply: (root) => seedSubscription(root, 'disable during generation'),
    summarize: async () => {
      summaries.push('summarize')
      if (summaries.length === 1) {
        generated.resolve()
        await released.promise
        return { text: 'disabled generation' }
      }
      return { text: 'after enable' }
    },
  })
  await until(() => f.started.length === 1, 'subscription runtime starts')
  await generated.promise

  await saveEnabled(f.controller, false)
  released.resolve()
  await tick()
  await tick()
  assert.deepEqual(f.sent, [])
  assert.equal(readSubscriptions(f.root).items.length, 1)

  await saveEnabled(f.controller, true)
  await untilEventually(() => f.sent.some((message) => message.text === 'after enable'), 'subscription sends after enable')
  assert.ok(f.sent.every((message) => message.text !== 'disabled generation'))
  assert.deepEqual(readSubscriptions(f.root).items, [])
})

test('a subscription generation cannot cross an account transport replacement', async (t) => {
  const generated = deferred()
  const released = deferred()
  const summaries = []
  const f = fixture(t, {
    enabled: true,
    beforeApply: (root) => seedSubscription(root, 'restart during generation'),
    summarize: async () => {
      summaries.push('summarize')
      if (summaries.length === 1) {
        generated.resolve()
        await released.promise
        return { text: 'stale generation' }
      }
      return { text: 'new transport' }
    },
  })
  await until(() => f.started.length === 1, 'subscription runtime starts')
  const oldTransport = f.started[0]
  await generated.promise

  await f.login.pause(ACCOUNT)
  await f.login.resume(ACCOUNT)
  await until(() => f.started.length === 2, 'replacement transport starts')
  released.resolve()
  await untilEventually(() => f.sent.some((message) => message.text === 'new transport'), 'subscription sends through replacement transport')
  assert.equal(oldTransport.testRunning, false)
  assert.ok(f.sent.every((message) => message.text !== 'stale generation'))
  assert.deepEqual(readSubscriptions(f.root).items, [])
})

test('a subscription generation settling after plugin stop cannot send', async (t) => {
  const generated = deferred()
  const released = deferred()
  const f = fixture(t, {
    enabled: true,
    beforeApply: (root) => seedSubscription(root, 'stop during generation'),
    summarize: async () => {
      generated.resolve()
      await released.promise
      return { text: 'late after stop' }
    },
  })
  await until(() => f.started.length === 1, 'subscription runtime starts')
  await generated.promise

  await f.dispose()
  released.resolve()
  await tick()
  await tick()
  assert.deepEqual(f.sent, [])
  assert.equal(readSubscriptions(f.root).items.length, 1)
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
  test(scenario.name + ' cannot revive retired summaries or keyword replies', async t => {
    const summaries = []
    const f = fixture(t, {
      enabled: true,
      allowedChats: ['allowed-group', 'test-user'],
      summarize: async (...args) => { summaries.push(args); return { text: 'retired summary' } },
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
    assert.deepEqual(summaries, [])
    assert.equal(f.sessions.length, 0)
    assert.deepEqual(f.sent, [])
    await f.started[0].testInbound(f.message('retained-private-message'))
    assert.equal(f.sessions.length, 1, 'private messages still reach the host')
    assert.deepEqual(summaries, [])
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
