import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import { setImmediate as tick } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentBridge } from '../src/agent-bridge.js'
import { SessionDispatcher } from '../src/session-dispatcher.js'
import { apply } from '../src/index.js'
import { ILinkTransport } from '../src/transport/ilink.js'
import { configureWeixinStateDir, configFile, stateDir } from '../src/state.js'
import { saveWeixinAccount, registerWeixinAccountId } from '../vendor/openclaw-weixin/auth/accounts.js'

const names = ['session_list', 'session_query', 'session_dispatch']
// Real Cordis lifecycle and AgentBridge. DSH's optional tool service is not
// installed: registration/visibility/disposal below explicitly mocks its contract.
function fixture(t, { enabled = true, registry } = {}) {
  const ctx = new Context()
  const live = new Map(), registrations = new Map(), disposed = [], warnings = []
  const policy = { enabled: true, sessionDispatcherEnabled: enabled, sessionDispatcherSenders: ['owner'], sessionDispatcherTargets: ['project-fixture'], allowedSenders: ['owner'] }
  ctx.provide('agents', {
    get: (id) => live.get(id),
    create: async ({ sessionId, meta }) => {
      const entries = new Map()
      registrations.set(sessionId, entries)
      const tools = registry ? registry(entries) : { register(definition, options) {
        entries.set(definition.name, { definition, options })
        return () => entries.delete(definition.name)
      } }
      const agent = { ctx: { tools }, session: { id: sessionId, header: meta, snapshotEvents: () => [] }, inbox: { clear() {} } }
      live.set(sessionId, agent)
      return { agent, dispose: async () => { disposed.push(sessionId); live.delete(sessionId) } }
    },
  })
  const bridge = new AgentBridge({ ctx, sessionDispatcherConfig: () => policy, errLog: (value) => warnings.push(value) })
  t.after(async () => { await bridge.dispose(); await ctx.fiber.dispose() })
  return { ctx, bridge, policy, live, registrations, disposed, warnings }
}

test('attach mounts only main controllers, deduplicates tools and fences other agents', async (t) => {
  const f = fixture(t)
  const main = await f.bridge.attach('chat', 'account')
  main.turnSource = { senderId: 'owner' }
  const tools = f.registrations.get(main.agent.session.id)
  assert.deepEqual([...tools.keys()], names)
  assert.equal(await f.bridge.attach('chat', 'account'), main)
  assert.equal(tools.size, 3)
  const other = await f.bridge.attach('other-chat', 'other-account')
  const tool = tools.get('session_list')
  assert.equal(tool.options.when({ agent: main.agent }), true)
  assert.equal(tool.options.when({ agent: other.agent }), false)
  await assert.rejects(tool.definition.execute({}, { agent: other.agent }), /original live Weixin controller/)
  f.bridge.sessionDispatcher.host.list = async () => []
  assert.deepEqual(await tool.definition.execute({}, { agent: main.agent }), { sessions: [], truncated: false })
  f.policy.sessionDispatcherEnabled = false
  assert.equal(tool.options.when({ agent: main.agent }), false)
  await assert.rejects(tool.definition.execute({}, { agent: main.agent }), /disabled/)
  f.policy.sessionDispatcherEnabled = true
  f.policy.sessionDispatcherSenders = []
  await assert.rejects(tool.definition.execute({}, { agent: main.agent }), /not authorized/)
  await f.bridge.dispose()
  assert.equal(tools.size, 0)
  assert.equal(f.disposed.length, 2)
  assert.equal(f.bridge.sessionDispatcher.mounts.size, 0)
})

test('account and raw conversation identity keep contexts and later replies separate', async (t) => {
  const f = fixture(t)
  const sources = [
    { account: 'bot-A', conversation: 'shared-chat' },
    { account: 'bot-B', conversation: 'shared-chat' },
    { account: 'bot-A', conversation: 'a@b' },
    { account: 'bot-A', conversation: 'a-b' },
    { account: 'bot@A', conversation: 'shared-chat' },
  ]
  const records = await Promise.all(sources.map(({ account, conversation }) => f.bridge.attach(conversation, account)))
  assert.equal(new Set(records).size, sources.length)
  assert.equal(new Set(records.map((record) => record.agent.session.id)).size, sources.length)
  const delivered = []
  for (const [index, record] of records.entries()) {
    record.onSpontaneousReply = async (reply) => delivered.push(reply)
    record.agent.session.snapshotEvents = () => [
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `result-${index}` }] } } },
      { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]
  }
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(delivered.map(({ accountId, conversationId, text }) => ({ accountId, conversationId, text })),
    sources.map(({ account, conversation }, index) => ({ accountId: account, conversationId: conversation, text: `result-${index}` })))
})

test('late opt-in mounts tools on existing controller without recreating session', async (t) => {
  const f = fixture(t, { enabled: false })
  const main = await f.bridge.attach('chat', 'account')
  const entries = f.registrations.get(main.agent.session.id)
  assert.equal(entries.size, 0)
  f.policy.sessionDispatcherEnabled = true
  assert.equal(await f.bridge.attach('chat', 'account'), main)
  assert.deepEqual([...entries.keys()], names)
  assert.equal(f.live.size, 1)
})

test('dispatcher tools and ordered spontaneous replies coexist on the same controller', async (t) => {
  const f = fixture(t)
  const main = await f.bridge.attach('chat', 'account')
  main.turnSource = { senderId: 'owner' }
  const tools = f.registrations.get(main.agent.session.id)
  assert.deepEqual([...tools.keys()], names)
  f.bridge.sessionDispatcher.host.list = async () => []
  const list = () => tools.get('session_list').definition.execute({}, { agent: main.agent })
  assert.deepEqual(await list(), { sessions: [], truncated: false })

  const delivered = []
  let retry = true
  main.onSpontaneousReply = async (reply) => {
    if (reply.text === 'Second report' && retry) {
      retry = false
      throw new Error('synthetic transient send failure')
    }
    delivered.push(reply)
  }
  main.agent.session.snapshotEvents = () => [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'First report' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 4, type: 'turn/start' },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Second report' }] } } },
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 7, type: 'turn/start' },
    { seq: 8, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '[SILENT]' }] } } },
    { seq: 9, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(delivered.map((reply) => reply.text), ['First report'])
  assert.equal(main.lastDeliveredSeq, 3, 'failed second delivery must preserve the retry cursor')
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(delivered.map((reply) => reply.text), ['First report', 'Second report'])
  assert.ok(delivered.every((reply) => reply.accountId === 'account' && reply.conversationId === 'chat' && reply.sessionId === main.agent.session.id))
  assert.equal(main.lastDeliveredSeq, 9)
  await f.bridge.testPollSpontaneous()
  assert.equal(delivered.length, 2, 'delivered turns must not be repeated')
  assert.deepEqual(await list(), { sessions: [], truncated: false })
})

test('unsupported registry preserves ordinary controller attachment', async (t) => {
  const f = fixture(t, { registry: () => undefined })
  const main = await f.bridge.attach('chat', 'account')
  assert.equal(f.live.get(main.agent.session.id), main.agent)
  assert.equal(f.bridge.sessionDispatcher.mounts.size, 0)
})

test('partial registration failure rolls back without failing attachment', async (t) => {
  const f = fixture(t, { registry: (entries) => ({ register(definition) {
    if (definition.name === 'session_query') throw new Error('synthetic incompatible registry')
    entries.set(definition.name, definition)
    return () => entries.delete(definition.name)
  } }) })
  const main = await f.bridge.attach('chat', 'account')
  assert.equal(f.registrations.get(main.agent.session.id).size, 0)
  assert.deepEqual(f.bridge.sessionDispatcher.mounts.get(main.agent), [])
  assert.ok(f.warnings.some((value) => value.includes('unavailable')))
})

test('throwing registration rollback cannot break ordinary attachment', async (t) => {
  const f = fixture(t, { registry: () => ({ register(definition) {
    if (definition.name === 'session_query') throw new Error('synthetic registration failure')
    return () => { throw new Error('synthetic cleanup failure') }
  } }) })
  await assert.doesNotReject(f.bridge.attach('chat', 'account'))
})


test('mixed-sender steering fences controller tools for the entire running turn', async (t) => {
  const f = fixture(t)
  f.policy.allowedSenders.push('other-owner')
  f.policy.sessionDispatcherSenders.push('other-owner')
  const main = await f.bridge.attach('group', 'account')
  main.busy = true
  main.turnSource = { senderId: 'owner' }
  f.bridge.sessionDispatcher.host.list = async () => []
  const tool = f.registrations.get(main.agent.session.id).get('session_list').definition
  const steer = async (senderId) => {
    try {
      await f.bridge.deliver({ conversationId: 'group', accountId: 'account', text: 'synthetic direction', busyMessageMode: 'steer', senderId })
    } catch (error) {
      // The optional LLM package is absent in this fixture. The trust fence
      // must already be set before that lazy dependency is loaded.
      assert.equal(error.code, 'ERR_MODULE_NOT_FOUND')
    }
  }
  await steer('owner')
  assert.notEqual(main.dispatchSenderMixed, true)
  await assert.doesNotReject(tool.execute({}, { agent: main.agent }))
  await steer('other-owner')
  assert.equal(main.dispatchSenderMixed, true)
  await assert.rejects(tool.execute({}, { agent: main.agent }), /non-controller/)
  await steer('owner')
  assert.equal(main.dispatchSenderMixed, true, 'original sender cannot restore authority within mixed turn')
  await assert.rejects(tool.execute({}, { agent: main.agent }), /non-controller/)
})

test('new delivery cannot lend newer sender authority to an already-running or unattributed turn', async (t) => {
  // Synthetic user-message constructor only; no DSH driver, model or network.
  const loader = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: 'data:text/javascript,export const createUserMessage = (value) => ({ ...value, id: "synthetic-input" })', shortCircuit: true }
    return nextResolve(specifier, context)
  }`
  register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)
  for (const [status, senderId, mixed] of [['running', 'owner', true], ['idle', undefined, true], ['idle', 'owner', false]]) {
    const f = fixture(t)
    const main = await f.bridge.attach('chat', 'account')
    main.agent.followup = () => { throw new Error('synthetic stop before model') }
    const tool = f.registrations.get(main.agent.session.id).get('session_list').definition
    f.bridge.sessionDispatcher.host.list = async () => []
    main.agent.status = status
    const outcome = await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'synthetic message', senderId })
    assert.equal(outcome.uncertain, true)
    assert.equal(main.dispatchSenderMixed, mixed)
    if (mixed) await assert.rejects(tool.execute({}, { agent: main.agent }), /non-controller/)
    else await assert.doesNotReject(tool.execute({}, { agent: main.agent }))
  }
})

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await tick()
  assert.ok(predicate(), 'synthetic runtime started')
}

test('apply wires saved policy and exact account/chat dispatch notification routing', async (t) => {
  const env = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(path.join(stateDir(), 'dispatch-runtime-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  configureWeixinStateDir()
  fs.writeFileSync(configFile(), JSON.stringify({ enabled: true, sessionDispatcherEnabled: true,
    sessionDispatcherSenders: ['owner'], sessionDispatcherTargets: ['project-fixture'], allowedSenders: ['owner'], allowedChats: ['owner', 'chat-b'] }))
  const accounts = ['dispatch-account-a', 'dispatch-account-b']
  for (const account of accounts) {
    saveWeixinAccount(account, { token: 'synthetic-test-token', userId: 'owner', baseUrl: 'https://example.invalid' })
    registerWeixinAccountId(account)
  }
  const started = [], sent = []
  let dispatcher
  const mount = SessionDispatcher.prototype.mount
  t.mock.method(SessionDispatcher.prototype, 'mount', function (...args) { dispatcher = this; return mount.apply(this, args) })
  t.mock.method(ILinkTransport.prototype, 'refreshConfig', async function () {})
  t.mock.method(ILinkTransport.prototype, 'start', async function (inbound) { this.testInbound = inbound; started.push(this) })
  t.mock.method(ILinkTransport.prototype, 'stop', async function () {})
  t.mock.method(ILinkTransport.prototype, 'send', async function (message) { sent.push({ accountId: this.accountId, ...message }) })
  const ctx = new Context()
  ctx.provide('agents', { create: async ({ sessionId }) => ({ agent: { session: { id: sessionId, snapshotEvents: () => [] } }, dispose: async () => {} }) })
  let disposed = false
  const dispose = async () => { if (!disposed) { disposed = true; await ctx.fiber.dispose() } }
  t.after(async () => { await dispose(); if (env === undefined) delete process.env.DSH_WEIXIN_STATE_DIR; else process.env.DSH_WEIXIN_STATE_DIR = env; fs.rmSync(root, { recursive: true, force: true }) })
  apply(ctx, { enabled: true, allowedSenders: ['owner'], notifyEnabled: false, mediaEnabled: false, typingIndicator: false })
  await until(() => started.length === 2)
  await tick()
  const origin = started.find((transport) => transport.accountId === accounts[0])
  await origin.testInbound({ id: 'synthetic-command', type: 'text', text: '/compact', senderId: 'owner', conversationId: 'owner', contextToken: 'synthetic-context', timestamp: Date.now() })
  assert.ok(dispatcher, JSON.stringify(sent))
  sent.length = 0
  const notify = (extra = {}) => dispatcher.notify({ accountId: accounts[0], conversationId: 'owner', senderId: 'owner', targetSessionId: 'project-fixture', text: 'synthetic project answer', ...extra })
  await notify()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].accountId, accounts[0])
  assert.equal(sent[0].conversationId, 'owner')
  await assert.rejects(notify({ accountId: 'missing-account' }), /Originating Weixin account/)
  await notify({ targetSessionId: 'unapproved-target' })
  await notify({ senderId: 'intruder' })
  await notify({ conversationId: 'unapproved-chat' })
  assert.equal(sent.length, 1)
  const controller = ctx.get('configController')
  const save = (path, value) => controller.save(JSON.stringify([{ path, value }]))
  for (const [field, restored] of [['sessionDispatcherTargets', ['project-fixture']], ['sessionDispatcherSenders', ['owner']]]) {
    let release, entered = false
    const pending = new Promise((resolve) => { release = resolve })
    const refresh = t.mock.method(origin, 'refreshConfig', async () => { entered = true; await pending })
    const sending = notify()
    await until(() => entered)
    await save(field, [])
    release()
    await sending
    refresh.mock.restore()
    assert.equal(sent.length, 1, `${field} revocation during refresh must prevent delivery`)
    await save(field, restored)
  }
  {
    let release, entered = false
    const pending = new Promise((resolve) => { release = resolve })
    const refresh = t.mock.method(origin, 'refreshConfig', async () => { entered = true; await pending })
    const sending = notify()
    await until(() => entered)
    const file = path.join(root, 'accounts-registry.json')
    const healthy = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, '{corrupt while refreshing')
    release()
    await sending
    assert.equal(sent.length, 1, 'registry corruption during refresh must prevent delivery')
    assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt while refreshing')
    fs.writeFileSync(file, healthy)
    refresh.mock.restore()
  }
  let release, entered = false
  const pending = new Promise((resolve) => { release = resolve })
  t.mock.method(origin, 'refreshConfig', async () => { entered = true; await pending })
  const sending = notify()
  await until(() => entered)
  await ctx.get('weixinLoginController').pause(accounts[0])
  release()
  await sending
  assert.equal(sent.length, 1, 'origin paused during refresh must prevent delivery')
  await assert.rejects(notify(), /Originating Weixin account/)
  assert.equal(sent.length, 1, 'paused origin must not fall back to other active account')
  await controller.save(JSON.stringify([{ path: 'sessionDispatcherEnabled', value: false }]))
  assert.equal(dispatcher.enabled(), false)
  await notify()
  assert.equal(sent.length, 1)
  await dispose()
  assert.equal(dispatcher.stopped.signal.aborted, true)
})

// #31: a parallel-session dispatch result is promised as plain text. When the
// project reply carries a fenced code block over `codeFileThreshold`, rich
// content would normally swap it for a snippet attachment — and a failed upload
// silently drops the body. The real onDispatchReply callback must force rich
// content off for this path so the full code stays inline.
test('dispatch notifications keep long code inline as text, never as a lossy attachment (#31)', async (t) => {
  const env = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(path.join(stateDir(), 'dispatch-rich-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  configureWeixinStateDir()
  fs.writeFileSync(configFile(), JSON.stringify({
    enabled: true,
    sessionDispatcherEnabled: true,
    sessionDispatcherSenders: ['owner'],
    sessionDispatcherTargets: ['project-fixture'],
    allowedSenders: ['owner'],
    allowedChats: ['owner'],
  }))
  const account = 'dispatch-rich-account'
  saveWeixinAccount(account, { token: 'synthetic-test-token', userId: 'owner', baseUrl: 'https://example.invalid' })
  registerWeixinAccountId(account)
  const started = [], sent = [], mediaCalls = []
  let dispatcher
  const mount = SessionDispatcher.prototype.mount
  t.mock.method(SessionDispatcher.prototype, 'mount', function (...args) { dispatcher = this; return mount.apply(this, args) })
  t.mock.method(ILinkTransport.prototype, 'refreshConfig', async function () {})
  t.mock.method(ILinkTransport.prototype, 'start', async function (inbound) { this.testInbound = inbound; started.push(this) })
  t.mock.method(ILinkTransport.prototype, 'stop', async function () {})
  t.mock.method(ILinkTransport.prototype, 'send', async function (message) { sent.push({ accountId: this.accountId, ...message }) })
  t.mock.method(ILinkTransport.prototype, 'sendMedia', async function (message) { mediaCalls.push(message) })
  const ctx = new Context()
  ctx.provide('agents', { create: async ({ sessionId }) => ({ agent: { session: { id: sessionId, snapshotEvents: () => [] } }, dispose: async () => {} }) })
  let disposed = false
  const dispose = async () => { if (!disposed) { disposed = true; await ctx.fiber.dispose() } }
  t.after(async () => { await dispose(); if (env === undefined) delete process.env.DSH_WEIXIN_STATE_DIR; else process.env.DSH_WEIXIN_STATE_DIR = env; fs.rmSync(root, { recursive: true, force: true }) })
  apply(ctx, { enabled: true, allowedSenders: ['owner'], notifyEnabled: false, mediaEnabled: false, typingIndicator: false })
  await until(() => started.length === 1)
  await tick()
  // Attaching a live controller is what creates the SessionDispatcher; drive one
  // inbound command so the real bridge/dispatcher wiring exists before notifying.
  const origin = started[0]
  await origin.testInbound({ id: 'synthetic-command', type: 'text', text: '/compact', senderId: 'owner', conversationId: 'owner', contextToken: 'synthetic-context', timestamp: Date.now() })
  assert.ok(dispatcher, 'apply must have mounted the session dispatcher')
  sent.length = 0
  const longBody = Array.from({ length: 120 }, (_, i) => `const value${i} = ${i}; KEEPMEINLINE`).join('\n')
  assert.ok(longBody.length > 1200, 'fixture must exceed the default codeFileThreshold')
  await dispatcher.notify({ accountId: account, conversationId: 'owner', senderId: 'owner', targetSessionId: 'project-fixture',
    text: '实现如下：\n```js\n' + longBody + '\n```\n以上。' })
  const deliveredText = sent.filter((m) => typeof m.text === 'string').map((m) => m.text).join('\n')
  assert.ok(deliveredText.includes('const value119 = 119; KEEPMEINLINE'), 'long code body must stay inline in dispatch notifications')
  assert.ok(!deliveredText.includes('已作为文件'), 'dispatch notification must not swap code for a file note')
  assert.equal(mediaCalls.length, 0, 'dispatch notification must not attempt a media upload')
  await dispose()
})
