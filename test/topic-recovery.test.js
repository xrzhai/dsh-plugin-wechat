import './synthetic-user-message.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import { ILinkTransport } from '../src/transport/ilink.js'
import { saveWeixinAccount, registerWeixinAccountId } from '../vendor/openclaw-weixin/auth/accounts.js'
import { AgentBridge } from '../src/agent-bridge.js'
import { WeixinLoginController } from '../src/login-remote.js'
import { readLines, scopedLineKey, SessionLines, writeLines } from '../src/sessions.js'
import { writeRegistry } from '../src/account-registry.js'

const account = 'fixture@im.bot', chat = 'sender:group'
const key = scopedLineKey(account, chat), old = 'fixture-im-bot:' + chat
const entry = (ids, active = ids[0]) => ({ lines: ids.map(sessionId => ({ sessionId, title: sessionId })), active })

test('upgrade preserves old IDs, order and active topic across card, commands and live writes', async t => {
  writeRegistry({ [account]: { label: 'bot' } })
  const legacy = entry(['first', 'historical'], 'historical')
  writeLines({ [old]: legacy, [key]: entry(['newer']), bare: entry(['unscoped']) })
  const lines = new SessionLines()
  const card = { getTopicLines: () => lines }
  const remote = WeixinLoginController.prototype
  const { conversations: [row] } = await remote.sessions.call(card)
  assert.equal(row.accountId, account)
  assert.equal(row.conversationLabel, chat)
  assert.equal(row.active, 'historical')
  assert.deepEqual(row.lines.map(line => line.sessionId), ['first', 'historical', 'newer'])
  assert.equal(readLines()[old], undefined)
  assert.ok(readLines().bare)
  const bridge = new AgentBridge({ ctx: { get: () => undefined }, lines })
  t.after(() => bridge.dispose())
  assert.match(bridge.handleCommand(chat, '/list', account), /▶ 2. historical/)
  await remote.useSession.call(card, old, 3)
  assert.equal(lines.active(chat, account), 'newer')
  bridge.handleCommand(chat, '/use 2', account)
  await remote.removeSession.call(card, key, 1)
  lines.checkpoint(chat, account, 'historical', 81)
  assert.deepEqual((await remote.sessions.call(card)).conversations[0].lines.map(line => line.sessionId), ['historical', 'newer'])
  assert.equal(new SessionLines().active(chat, account), 'historical')
  assert.equal(readLines()[key].lines[0].lastDeliveredSeq, 81)
})

test('legacy slug or host session shared by multiple origins is left untouched', () => {
  const store = { 'same-id:chat': entry(['ambiguous']), 'a:room': entry(['shared']), 'b:room': entry(['shared']) }
  writeLines(store)
  const lines = new SessionLines()
  lines.migrateLegacy(['same-id', 'same@id', 'a', 'b'])
  assert.deepEqual(readLines(), store)
  for (const id of ['same-id', 'same@id', 'a', 'b']) assert.deepEqual(lines.conversations(id), [])
})

function turn(events, value, input) {
  const push = (type, data) => events.push({ seq: events.length + 1, type, data })
  const number = events.length + 1
  push('turn/start', { turn: number })
  if (input) push('user/message', input)
  push('assistant/message', { message: { content: [{ type: 'text', text: value }] } })
  push('turn/end', { turn: number, reason: { kind: 'completed' } })
}

test('cold restore skips other accounts, retries unsent reports, and preserves gaps across restarts', async t => {
  const events = []
  turn(events, 'old report')
  writeLines({ [key]: entry(['inactive', 'active'], 'active'), [scopedLineKey('other', chat)]: entry(['other']) })
  const sends = [], resumed = []
  let fail = true
  const createBridge = () => {
    const agents = { resume: async ({ resumeSessionId: id }) => {
      resumed.push(id)
      assert.equal(id, 'active')
      return { agent: { session: { id, snapshotEvents: () => events },
        followup: msg => turn(events, 'direct answer', msg) }, dispose: async () => {} }
    } }
    return new AgentBridge({ ctx: { get: name => name === 'agents' ? agents : undefined }, spontaneousPollMs: 60_000,
      onSpontaneousReply: async reply => {
        if (fail) throw new Error('offline')
        assert.equal(reply.accountId, account)
        assert.equal(reply.conversationId, chat)
        sends.push(reply.text)
      } })
  }
  let bridge = createBridge()
  t.after(() => bridge.dispose())
  await bridge.restoreAccount(account)
  assert.equal(readLines()[key].lines[1].lastDeliveredSeq, 3, 'old record baselines once')
  await bridge.dispose()
  turn(events, 'offline report')
  bridge = createBridge()
  await bridge.restoreAccount(account)
  await bridge.testPollSpontaneous()
  assert.equal(readLines()[key].lines[1].lastDeliveredSeq, 3, 'failed send keeps cursor')
  assert.equal((await bridge.deliver({ conversationId: chat, accountId: account, text: 'question' })).text, 'direct answer')
  assert.equal(readLines()[key].lines[1].lastDeliveredSeq, 3, 'direct answer must not skip older report')
  await bridge.dispose()
  bridge = createBridge()
  await bridge.restoreAccount(account)
  fail = false
  await bridge.testPollSpontaneous()
  assert.deepEqual(sends, ['offline report'])
  assert.equal(readLines()[key].lines[1].lastDeliveredSeq, events.length)
  await bridge.dispose()
  bridge = createBridge()
  await bridge.restoreAccount(account)
  await bridge.testPollSpontaneous()
  assert.deepEqual(sends, ['offline report'])
  assert.deepEqual(resumed, ['active', 'active', 'active', 'active'])
})

test('failed restore of historical topic never creates a replacement and other chats still attach', async t => {
  writeLines({ [key]: entry(['historical']), [scopedLineKey(account, 'healthy')]: entry(['healthy']) })
  let creates = 0
  const agents = { get: id => id === 'healthy' ? { session: { id, snapshotEvents: () => [] } } : undefined,
    resume: async () => { throw new Error('temporarily unavailable') }, create: async () => { creates++ } }
  const bridge = new AgentBridge({ ctx: { get: name => name === 'agents' ? agents : undefined } })
  t.after(() => bridge.dispose())
  await bridge.restoreAccount(account)
  assert.deepEqual([...bridge.sessions.keys()], ['healthy'])
  await assert.rejects(bridge.attach(chat, account), /temporarily unavailable/)
  assert.equal(creates, 0)
  assert.deepEqual(readLines()[key], entry(['historical']))
})

test('channel startup forwards a pending host report before any inbound WeChat message', { timeout: 8000 }, async t => {
  const id = 'startup-bot', conversation = 'startup-chat', sessionId = 'existing-topic'
  saveWeixinAccount(id, { token: 'synthetic', baseUrl: 'https://example.invalid', userId: conversation })
  registerWeixinAccountId(id)
  writeLines({ [id + ':' + conversation]: { lines: [{ sessionId, lastDeliveredSeq: 0 }], active: sessionId } })
  const events = []
  turn(events, 'report while offline')
  const ctx = new Context()
  ctx.provide('agents', { resume: async ({ resumeSessionId }) => {
    assert.equal(resumeSessionId, sessionId)
    return { agent: { session: { id: sessionId, snapshotEvents: () => events } }, dispose: async () => {} }
  } })
  const sent = Promise.withResolvers()
  const timer = setTimeout(() => sent.reject(new Error('startup did not deliver the report')), 6500)
  t.after(async () => { clearTimeout(timer); await ctx.fiber.dispose() })
  t.mock.method(ILinkTransport.prototype, 'refreshConfig', async () => {})
  t.mock.method(ILinkTransport.prototype, 'start', async () => {})
  t.mock.method(ILinkTransport.prototype, 'stop', async () => {})
  t.mock.method(ILinkTransport.prototype, 'send', async function (message) {
    sent.resolve({ accountId: this.accountId, conversationId: message.conversationId, text: message.text })
  })
  apply(ctx, { enabled: true, allowedSenders: [conversation], accountId: id, typingIndicator: false, mediaEnabled: false })
  assert.deepEqual(await sent.promise, { accountId: id, conversationId: conversation, text: 'report while offline' })
})
