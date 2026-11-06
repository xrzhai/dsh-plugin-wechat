import './synthetic-user-message.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentBridge } from '../src/agent-bridge.js'
import { CATALOG } from '../src/i18n.js'
import { readAssistantReply, readSettledTurns } from '../src/session-reader.js'
import { dispatchedTurn } from '../src/session-dispatch-reader.js'
import { scopedLineKey } from '../src/sessions.js'

function fixture(t, options = {}) {
  const events = []
  const bridge = new AgentBridge({
    ctx: { get: () => undefined },
    lines: { title: () => undefined, active: () => 'session-1', list: () => [{ sessionId: 'session-1' }] },
    eventPollFastMs: 5,
    eventPollMs: 10,
    maxWaitMs: 1000,
    spontaneousPollMs: 60_000,
    ...options,
  })
  const push = (type, data = {}) => events.push({ seq: events.length + 1, type, data })
  const record = {
    agent: {
      session: { id: 'session-1', snapshotEvents: () => events },
      followup: input => { push('turn/start', { turn: 1 }); push('user/message', input) },
      cancel: () => {},
    },
    conversationId: 'chat', accountId: 'account', busy: false, queue: [],
    lastDeliveredSeq: 0, dispose: async () => {},
  }
  bridge.attach = async (_conversationId, _accountId, options) => {
    if (options?.sessionId) bridge.sessions.set(options.sessionId, record)
    return record
  }
  bridge.sessions.set('session-1', record)
  bridge.conversationTargets.set(scopedLineKey('account', 'chat'), 'session-1')
  t.after(() => bridge.dispose())
  return { bridge, record, push }
}

const message = text => ({ message: { content: [{ type: 'text', text }] } })

test('delivery remains busy until the tool turn ends and returns the final answer', async t => {
  const f = fixture(t)
  let finished = false
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect' })
    .then(value => { finished = true; return value })
  await delay(30)
  f.push('assistant/message', message('Checking the file'))
  await delay(30)
  assert.equal(finished, false)
  f.push('tool/call', { callId: 'c1', name: 'read' })
  await delay(50)
  assert.equal(finished, false)
  assert.equal(f.record.busy, true)
  f.push('tool/result', { message: { source: { callId: 'c1' } } })
  f.push('assistant/message', message('Final answer'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await result).text, 'Final answer')
})

test('failed attempts and incomplete tool text cannot become a successful reply', async t => {
  const errors = []
  const f = fixture(t, { errLog: line => errors.push(line) })
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect' })
  await delay(20)
  f.push('assistant/attempt', message('unfinished attempt'))
  f.push('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'synthetic failure' } } })
  const failed = await result
  assert.equal(failed.text, CATALOG['turn.error'].zh)
  assert.equal(failed.status, 'error')
  assert.ok(errors.some(line => line.includes('synthetic failure')))
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: message('Checking') },
    { seq: 3, type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'c1' } } } },
    { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  assert.equal(readAssistantReply({ events }).text, '')
})

test('late delivery waits for turn end before forwarding a final reply', async t => {
  const f = fixture(t, { maxWaitMs: 35, lateReplyMaxWaitMs: 1000 })
  const late = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  await delay(55)
  f.push('assistant/message', message('Checking'))
  f.push('tool/call', { callId: 'c1', name: 'read' })
  await delay(30)
  assert.deepEqual(late.map(item => item.kind), ['timeout-notice'])
  f.push('tool/result', { message: { source: { callId: 'c1' } } })
  f.push('assistant/message', message('Final answer'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await result
  assert.deepEqual(late.map(item => item.kind), ['timeout-notice', 'reply'])
  assert.equal(late[1].text, 'Final answer')
})

test('delivery retains its result when a later turn starts before the next poll', async t => {
  const f = fixture(t)
  const spontaneous = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  await delay(20)
  f.push('assistant/message', message('Requested answer'))
  const requestedEnd = f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.push('turn/start', { turn: 2 })
  f.push('assistant/message', message('Later notice'))
  f.push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal((await result).text, 'Requested answer')
  assert.equal(f.record.lastDeliveredSeq, requestedEnd)
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, ['Later notice'])
})

test('an earlier spontaneous turn is not lost when the submitted turn finishes first in the poll', async t => {
  const f = fixture(t)
  const spontaneous = []
  f.record.agent.followup = input => {
    f.push('turn/start', { turn: 1 })
    f.push('assistant/message', message('Earlier notice'))
    f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
    f.push('turn/start', { turn: 2 })
    f.push('user/message', input)
    f.push('assistant/message', message('Requested answer'))
    f.push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  }
  const reply = await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  assert.equal(reply.text, 'Requested answer')
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, ['Earlier notice'])
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, ['Earlier notice'])
})

test('cancelled partial text is not emitted as a spontaneous reply', async t => {
  const f = fixture(t)
  const spontaneous = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  await delay(20)
  f.push('assistant/message', message('Unfinished answer'))
  assert.match(f.bridge.handleCommand('chat', '/cancel', 'account'), /停止请求/)
  f.push('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await result
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, [])
})

for (const finishBeforeCancel of [true, false]) {
  test(`cancelled turn is not pushed when it completes ${finishBeforeCancel ? 'before' : 'after'} cancellation`, async t => {
    const f = fixture(t)
    const spontaneous = []
    const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onSpontaneousReply: async reply => spontaneous.push(reply.text) })
    await delay(20)
    f.push('assistant/message', message('Do not send'))
    if (finishBeforeCancel) f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
    f.bridge.handleCommand('chat', '/cancel', 'account')
    if (!finishBeforeCancel) {
      await delay(20)
      assert.equal(f.record.busy, true)
      f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    await result
    await f.bridge.testPollSpontaneous()
    assert.deepEqual(spontaneous, [])
  })
}

test('reader returns the latest turn without an input id and the requested turn with one', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'first', source: { kind: 'user' } } },
    { seq: 3, type: 'assistant/message', data: message('First answer') },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'user/message', data: { id: 'second', source: { kind: 'user' } } },
    { seq: 7, type: 'assistant/message', data: message('Second answer') },
    { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  assert.equal(readAssistantReply({ events }).text, 'Second answer')
  assert.equal(readAssistantReply({ events, messageId: 'first', afterSeq: 0 }).text, 'First answer')
})

test('a later instruction invalidates an earlier direct answer', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'ours', source: { kind: 'user' } } },
    { seq: 3, type: 'assistant/message', data: message('Old answer') },
    { seq: 4, type: 'user/message', data: { id: 'later', source: { kind: 'user' } } },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(readAssistantReply({ events, messageId: 'ours', afterSeq: 0 }).text, '')
})

test('relay-form messages can contribute to the original direct or dispatched task', () => {
  const later = { id: 'later', source: { kind: 'plugin', plugin: 'other', form: 'relay' } }
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'own', source: { kind: 'weixin-dispatch', dispatchId: 'd1' } } },
    { seq: 3, type: 'user/message', data: later },
    { seq: 4, type: 'assistant/message', data: message('Answer to relay') },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(readAssistantReply({ events, messageId: 'own', afterSeq: 0 }).text, 'Answer to relay')
  assert.equal(dispatchedTurn(events, { dispatchId: 'd1', afterSeq: 0, action: 'followup' }).replyText, 'Answer to relay')
  const noLaterAnswer = events.filter(event => event.seq !== 4)
  noLaterAnswer.splice(2, 0, { seq: 2.5, type: 'assistant/message', data: message('Stale answer') })
  assert.equal(readAssistantReply({ events: noLaterAnswer, messageId: 'own', afterSeq: 0 }).text, '')
  assert.equal(dispatchedTurn(noLaterAnswer, { dispatchId: 'd1', afterSeq: 0, action: 'followup' }).replyText, '')
})

test('a later independent instruction is not returned as the original request reply', async t => {
  const f = fixture(t)
  const spontaneous = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  await delay(20)
  f.push('user/message', { id: 'later', source: { kind: 'user' } })
  f.push('assistant/message', message('Answer to later instruction'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await result).text, '')
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, ['Answer to later instruction'])
})

test('a later instruction answered before cancellation settles is not lost', async t => {
  const f = fixture(t)
  const spontaneous = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  await delay(20)
  f.bridge.handleCommand('chat', '/cancel', 'account')
  f.push('user/message', { id: 'later', source: { kind: 'user' } })
  f.push('assistant/message', message('Answer to later instruction'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await result).cancelled, true)
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, ['Answer to later instruction'])
})

test('a later instruction in a cancelled turn can still receive its own answer', async t => {
  const f = fixture(t)
  const abort = new AbortController()
  const spontaneous = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', signal: abort.signal, onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  await delay(20)
  abort.abort()
  await result
  f.push('user/message', { id: 'later', source: { kind: 'user' } })
  f.push('assistant/message', message('Answer to later instruction'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, ['Answer to later instruction'])
})

test('cancellation timeout reports that the host has not confirmed stopping', async t => {
  const f = fixture(t, { maxWaitMs: 35, lateReplyMaxWaitMs: 1000 })
  const late = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  await delay(20)
  f.bridge.handleCommand('chat', '/cancel', 'account')
  await delay(35)
  assert.deepEqual(late.map(item => item.kind), ['cancel-pending'])
  f.push('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await result
})

test('a synchronous host error keeps submission uncertain and recovers an accepted turn', async t => {
  const f = fixture(t)
  f.record.agent.status = 'running'
  let calls = 0
  f.record.agent.followup = input => {
    calls++
    f.push('turn/start', { turn: 1 })
    f.push('user/message', input)
    throw new Error('synthetic error after submission')
  }
  const late = []
  const first = await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', onLateReply: async item => late.push(item) })
  assert.equal(first.uncertain, true)
  assert.notEqual(first.notSubmitted, true)
  const second = await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'second' })
  assert.equal(second.notSubmitted, true)
  assert.equal(calls, 1)
  f.push('assistant/message', message('Accepted result'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.record.agent.status = 'idle'
  await f.bridge.testPollSpontaneous()
  assert.equal(late.at(-1).text, 'Accepted result')
})

test('an aborted wait does not admit queued work into an active host turn', async t => {
  const f = fixture(t)
  f.record.agent.status = 'running'
  let calls = 0
  const followup = f.record.agent.followup
  f.record.agent.followup = input => { calls++; followup(input) }
  const abort = new AbortController()
  const first = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', signal: abort.signal })
  await delay(20)
  const second = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'second' })
  await delay(20)
  abort.abort()
  assert.equal((await first).uncertain, true)
  assert.equal((await second).uncertain, true)
  assert.equal(calls, 1)
})

test('idle status does not clear uncertainty while the submitted input remains queued', async t => {
  const f = fixture(t)
  const abort = new AbortController()
  let input
  let calls = 0
  f.record.agent.status = 'running'
  f.record.agent.followup = value => { input = value; calls++ }
  const first = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', signal: abort.signal })
  await delay(20)
  abort.abort()
  assert.equal((await first).uncertain, true)
  f.record.agent.status = 'idle'
  f.record.agent.inbox = { nextTurn: [input], nextStep: [] }
  const second = await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'second' })
  assert.equal(second.notSubmitted, true)
  assert.equal(calls, 1)
  f.record.agent.inbox.nextTurn = []
  f.push('turn/start', { turn: 1 })
  f.push('user/message', input)
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.record.agent.followup = value => {
    calls++
    f.push('turn/start', { turn: 2 })
    f.push('user/message', value)
    f.push('assistant/message', message('New answer'))
    f.push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  }
  assert.equal((await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'third' })).text, 'New answer')
  assert.equal(calls, 2)
})

test('an unconfirmed cancellation deadline rejects queued work without starting it', async t => {
  const f = fixture(t, { maxWaitMs: 30, lateReplyMaxWaitMs: 50 })
  f.record.agent.status = 'running'
  let calls = 0
  const followup = f.record.agent.followup
  f.record.agent.followup = input => { calls++; followup(input) }
  const first = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', onLateReply: async () => {} })
  await delay(20)
  const second = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'second' })
  f.bridge.handleCommand('chat', '/cancel', 'account')
  assert.equal((await first).uncertain, true)
  const queued = await second
  assert.equal(queued.uncertain, true)
  assert.equal(queued.notSubmitted, true)
  assert.equal(calls, 1)
})

test('an unconfirmed running host turn can still be cancelled', async t => {
  const f = fixture(t)
  const abort = new AbortController()
  let calls = 0
  f.record.agent.status = 'running'
  f.record.agent.cancel = () => { calls++ }
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', signal: abort.signal })
  await delay(20)
  abort.abort()
  await result
  assert.match(f.bridge.handleCommand('chat', '/cancel', 'account'), /停止请求/)
  assert.equal(calls, 1)
})

test('an empty late answer still invokes the delivery path', async t => {
  const f = fixture(t, { maxWaitMs: 30, lateReplyMaxWaitMs: 1000 })
  const late = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  await delay(50)
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await result
  assert.deepEqual(late.map(item => item.kind), ['timeout-notice', 'reply'])
  assert.equal(late[1].text, '')
})

test('a failed late callback is retried without advancing the delivery cursor', async t => {
  const f = fixture(t, { maxWaitMs: 20, lateReplyMaxWaitMs: 500 })
  const delivered = []
  let attempts = 0
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => {
    if (item.kind !== 'reply') return
    attempts++
    if (attempts === 1) throw new Error('synthetic delivery failure')
    delivered.push(item.text)
  } })
  await delay(40)
  f.push('assistant/message', message('Final answer'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await result
  assert.equal(f.record.lastDeliveredSeq, 0)
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(delivered, ['Final answer'])
})

test('compact cannot advance past an undelivered late reply', async t => {
  let commands = 0
  const ctx = { get: name => name === 'commands' ? { execute: async () => { commands++; return { result: { kind: 'success' } } } } : undefined }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  const late = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  assert.equal((await result).uncertain, true)
  f.push('assistant/message', message('Final answer'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await f.bridge.handleCommand('chat', '/compact', 'account')
  await f.bridge.testPollSpontaneous()
  assert.equal(commands, 0)
  assert.equal(late.at(-1).text, 'Final answer')
})

test('an empty result after the late budget reaches its original delivery callback', async t => {
  const f = fixture(t, { maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  const late = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  assert.equal((await result).uncertain, true)
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(late.map(item => item.kind), ['timeout-notice', 'reply'])
  assert.equal(late[1].text, '')
})

for (const laterInstruction of ['none', 'user', 'relay']) test(`cancelled claimed input without a message handles later ${laterInstruction}`, async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const spontaneous = []
  const f = fixture(t, { ctx, maxWaitMs: 1000, lateReplyMaxWaitMs: 20, onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  f.record.agent.status = 'running'
  f.record.agent.followup = input => {
    f.push('turn/start', { turn: 1 })
    for (const handler of listeners.get('agent/inbox/claimed') ?? []) handler({ agent: f.record.agent, message: input, turn: 1 })
  }
  const abort = new AbortController()
  const running = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', signal: abort.signal })
  await delay(15)
  abort.abort()
  await running
  if (laterInstruction !== 'none') {
    const source = laterInstruction === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'other', form: 'relay' }
    f.push('user/message', { id: 'later', source })
    f.push('assistant/message', message('Later answer'))
  }
  f.push('turn/end', { turn: 1, reason: { kind: laterInstruction !== 'none' ? 'completed' : 'error' } })
  f.record.agent.status = 'idle'
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, laterInstruction === 'user' ? ['Later answer'] : [])
})

test('completed turn with unmatched tool result does not lose late answer before later turn', async t => {
  const late = [], spontaneous = []
  const f = fixture(t, { maxWaitMs: 10, lateReplyMaxWaitMs: 15, onSpontaneousReply: async reply => spontaneous.push(reply.text) })
  await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  f.push('tool/call', { callId: 'missing', name: 'read' })
  f.push('assistant/message', message('Final answer'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.push('turn/start', { turn: 2 })
  f.push('assistant/message', message('Later notice'))
  f.push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(late.map(item => item.text).filter(Boolean), ['Final answer'])
  assert.deepEqual(spontaneous, ['Later notice'])
  assert.equal(f.record.pendingLateReplies.size, 0)
})

test('a claimed input that fails after the late budget reports its failure', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  f.record.agent.status = 'running'
  f.record.agent.followup = input => {
    f.push('turn/start', { turn: 1 })
    for (const handler of listeners.get('agent/inbox/claimed') ?? []) handler({ agent: f.record.agent, message: input, turn: 1 })
  }
  const late = []
  const result = await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  assert.equal(result.uncertain, true)
  f.push('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  f.record.agent.status = 'idle'
  await f.bridge.testPollSpontaneous()
  assert.equal(late.at(-1).text, CATALOG['turn.blocked'].zh)
  assert.equal(f.record.pendingLateReplies.size, 0)
})

test('a late host failure remains available to the normal delivery path', async t => {
  const errors = []
  const f = fixture(t, { maxWaitMs: 30, lateReplyMaxWaitMs: 1000, errLog: line => errors.push(line) })
  const late = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => {
    late.push(item)
    if (item.kind === 'reply') throw new Error('synthetic outbound failure')
  } })
  await delay(50)
  f.push('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'late failure' } } })
  const reply = await result
  assert.equal(late[0].kind, 'timeout-notice')
  assert.notEqual(reply.late, true)
  assert.equal(reply.text, CATALOG['turn.error'].zh)
  assert.equal(reply.status, 'error')
  assert.ok(errors.some(line => line.includes('late failure')))
})

test('a cancellation after a timeout notice reports its pending state', async t => {
  const f = fixture(t, { maxWaitMs: 30, lateReplyMaxWaitMs: 1000 })
  const late = []
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', onLateReply: async item => late.push(item) })
  await delay(50)
  f.bridge.handleCommand('chat', '/cancel', 'account')
  await delay(30)
  assert.deepEqual(late.map(item => item.kind), ['timeout-notice', 'cancel-pending'])
  f.push('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await result
})

test('cancelled queued turn settles before the following queued turn starts', async t => {
  const f = fixture(t)
  let started = 0
  f.record.agent.followup = input => {
    started += 1
    f.push('turn/start', { turn: started })
    f.push('user/message', input)
  }
  const first = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first' })
  await delay(20)
  const second = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'second' })
  const third = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'third' })
  await delay(20)
  f.push('assistant/message', message('First done'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let i = 0; i < 100 && started < 2; i++) await delay(5)
  assert.equal(started, 2)
  f.bridge.handleCommand('chat', '/cancel', 'account')
  await delay(30)
  assert.equal(started, 2)
  f.push('turn/end', { turn: 2, reason: { kind: 'aborted' } })
  for (let i = 0; i < 100 && started < 3; i++) await delay(5)
  assert.equal(started, 3)
  f.push('assistant/message', message('Third done'))
  f.push('turn/end', { turn: 3, reason: { kind: 'completed' } })
  assert.equal((await third).text, 'Third done')
  assert.equal((await second).cancelled, true)
  assert.equal((await first).text, 'First done')
})

test('clearing a session releases its retained inbox listeners', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx })
  f.bridge.lines.clear = () => {}
  f.bridge.lines.render = () => 'sessions'
  const before = listeners.get('agent/inbox/claimed').size
  const abort = new AbortController()
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'inspect', signal: abort.signal })
  await delay(20)
  abort.abort()
  await result
  assert.equal(listeners.get('agent/inbox/claimed').size, before + 1)
  f.bridge.handleCommand('chat', '/list', 'account')
  f.bridge.handleCommand('chat', '/clear', 'account')
  assert.equal(listeners.get('agent/inbox/claimed').size, before)
  assert.equal(f.bridge.sessions.has('session-1'), false)
})

test('a discarded unclaimed input settles once the existing host turn stops', async t => {
  const listeners = new Map()
  const ctx = {
    get: () => undefined,
    on: (name, fn) => {
      const handlers = listeners.get(name) ?? new Set()
      handlers.add(fn); listeners.set(name, handlers)
      return () => handlers.delete(fn)
    },
  }
  const f = fixture(t, { ctx, maxWaitMs: 500 })
  let input
  f.record.agent.status = 'running'
  f.record.agent.followup = value => { input = value }
  f.record.agent.cancel = () => {
    for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  }
  const result = f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'queued in host' })
  await delay(20)
  f.bridge.handleCommand('chat', '/cancel', 'account')
  await delay(30)
  assert.equal(f.record.busy, true)
  f.record.agent.status = 'idle'
  const outcome = await Promise.race([result, delay(150).then(() => 'timed out')])
  assert.notEqual(outcome, 'timed out')
  assert.equal(outcome.cancelled, true)
  assert.equal(f.record.busy, false)
})

test('a failing discarded notification does not block an earlier spontaneous reply', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  f.push('turn/start', { turn: 1 })
  f.push('assistant/message', message('Earlier reply'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.record.agent.status = 'running'
  let input
  f.record.agent.followup = value => { input = value }
  const spontaneous = []
  await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'queued',
    onSpontaneousReply: async item => spontaneous.push(item.text),
    onLateReply: async item => { if (item.kind === 'discarded') throw new Error('notification unavailable') },
  })
  for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, ['Earlier reply'])
  assert.equal(f.record.pendingLateReplies.size, 1)
})

test('a failing later spontaneous reply does not block an earlier discarded notice', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  f.record.agent.status = 'running'
  let input
  f.record.agent.followup = value => { input = value }
  const late = []
  await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'queued',
    onSpontaneousReply: async () => { throw new Error('spontaneous unavailable') },
    onLateReply: async item => late.push(item),
  })
  for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  f.push('turn/start', { turn: 2 })
  f.push('assistant/message', message('Later reply'))
  f.push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await f.bridge.testPollSpontaneous()
  assert.equal(late.at(-1).kind, 'discarded')
  assert.equal(f.record.pendingLateReplies.size, 0)
})

test('an input discarded after the late deadline reports failure and releases its pending state', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  const listenerCount = listeners.get('agent/inbox/discarded').size
  f.record.agent.status = 'running'
  let input
  f.record.agent.followup = value => { input = value }
  const late = []
  let attempts = 0
  const result = await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'queued', onLateReply: async item => {
    if (item.kind === 'discarded' && ++attempts === 1) throw new Error('temporary failure')
    late.push(item)
  } })
  assert.equal(result.uncertain, true)
  for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  f.record.agent.status = 'idle'
  await f.bridge.testPollSpontaneous()
  assert.equal(f.record.pendingLateReplies.size, 1)
  await f.bridge.testPollSpontaneous()
  assert.equal(late.at(-1).kind, 'discarded')
  assert.equal(f.record.pendingLateReplies.size, 0)
  assert.equal(listeners.get('agent/inbox/discarded').size, listenerCount)
})

test('discarded input listeners are released after the host and inbox become idle', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  const baseline = listeners.get('agent/inbox/discarded').size
  f.record.agent.status = 'running'
  let input
  f.record.agent.followup = value => { input = value }
  await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'queued', onLateReply: async () => {} })
  for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  await f.bridge.testPollSpontaneous()
  assert.equal(f.record.pendingLateReplies.size, 0)
  assert.equal(listeners.get('agent/inbox/discarded').size, baseline + 1)
  f.record.agent.status = 'idle'
  f.record.agent.inbox = { nextTurn: [input] }
  await f.bridge.testPollSpontaneous()
  assert.equal(listeners.get('agent/inbox/discarded').size, baseline + 1)
  f.record.agent.inbox.nextTurn = []
  await f.bridge.testPollSpontaneous()
  assert.equal(listeners.get('agent/inbox/discarded').size, baseline)
  assert.equal(f.record.unconfirmed, undefined)
})

test('a failed discarded notice does not starve a later discarded notice', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  let input
  f.record.agent.followup = value => { input = value; f.record.agent.status = 'running' }
  await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'first', onLateReply: async item => {
    if (item.kind === 'discarded') throw new Error('first notification unavailable')
  } })
  for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  f.record.agent.status = 'idle'
  const second = []
  await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'second', onLateReply: async item => second.push(item) })
  for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  f.record.agent.status = 'idle'
  await f.bridge.testPollSpontaneous()
  assert.equal(second.at(-1).kind, 'discarded')
  assert.equal(f.record.pendingLateReplies.size, 1)
})

test('a user-cancelled input discarded after the late deadline stays silent', async t => {
  const listeners = new Map()
  const ctx = { get: () => undefined, on: (name, fn) => {
    const handlers = listeners.get(name) ?? new Set()
    handlers.add(fn); listeners.set(name, handlers)
    return () => handlers.delete(fn)
  } }
  const f = fixture(t, { ctx, maxWaitMs: 20, lateReplyMaxWaitMs: 30 })
  f.record.agent.status = 'running'
  let input
  f.record.agent.followup = value => { input = value }
  const late = []
  await f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'queued', onLateReply: async item => late.push(item) })
  f.bridge.handleCommand('chat', '/cancel', 'account')
  for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message: input })
  f.record.agent.status = 'idle'
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(late.map(item => item.kind), ['timeout-notice'])
  assert.equal(f.record.pendingLateReplies.size, 0)
})

for (const hostStatus of ['idle', 'running']) test(`an unexpectedly discarded input reports failure while host is ${hostStatus}`, async t => {
  const listeners = new Map()
  const ctx = {
    get: () => undefined,
    on: (name, fn) => {
      const handlers = listeners.get(name) ?? new Set()
      handlers.add(fn); listeners.set(name, handlers)
      return () => handlers.delete(fn)
    },
  }
  const f = fixture(t, { ctx, maxWaitMs: 500 })
  f.record.agent.status = hostStatus
  f.record.agent.followup = message => {
    for (const listener of listeners.get('agent/inbox/discarded') ?? []) listener({ agent: f.record.agent, message })
  }
  await assert.rejects(f.bridge.deliver({ conversationId: 'chat', accountId: 'account', text: 'discarded' }), /discarded/)
  assert.equal(f.record.busy, false)
})

test('spontaneous polling does not send text invalidated by tool work or a failed attempt', async t => {
  const f = fixture(t)
  const spontaneous = []
  f.record.onSpontaneousReply = async reply => spontaneous.push(reply.text)
  f.push('turn/start', { turn: 1 })
  f.push('assistant/message', message('Checking'))
  f.push('tool/call', { callId: 'c1', name: 'read' })
  f.push('tool/result', { message: { source: { callId: 'c1' } } })
  f.push('assistant/attempt', message('Failed attempt'))
  f.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(spontaneous, [])
})

test('spontaneous reader waits for an end when the cursor is inside a turn', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'ours' } },
    { seq: 3, type: 'assistant/message', data: message('Partial') },
  ]
  assert.deepEqual(readSettledTurns({ events, afterSeq: 2 }), [])
  events.push({ seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(readSettledTurns({ events, afterSeq: 2 })[0].inputIds, ['ours'])
})

test('reader correlates input by message id and reports pre-step failures only for the claimed turn', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'other' } },
    { seq: 3, type: 'assistant/message', data: message('Unrelated') },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'user/message', data: { id: 'ours' } },
    { seq: 7, type: 'assistant/message', data: message('Our answer') },
    { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  assert.equal(readAssistantReply({ events, messageId: 'ours', afterSeq: 0 }).text, 'Our answer')
  assert.equal(readAssistantReply({ events, messageId: 'missing', afterSeq: 0 }).turnSettled, false)
  const failed = [{ seq: 9, type: 'turn/start', data: { turn: 3 } }, { seq: 10, type: 'turn/end', data: { turn: 3, reason: { kind: 'blocked' } } }]
  assert.equal(readAssistantReply({ events: [...events, ...failed], messageId: 'missing', claimedTurn: 3 }).turnReason, 'blocked')
})

function completeStep(step, text) {
  return [
    { type: 'step/start', data: { turn: 1, step } },
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step,
      message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] },
      stream: [{ type: 'text-chunks', texts: [text] }, { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    } },
    { type: 'step/end', data: { turn: 1, step } },
  ]
}

test('project dispatch does not return text invalidated by tool work or a failed attempt', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'dispatch-input', source: { dispatchId: 'd1' } } },
    { seq: 3, type: 'assistant/message', data: message('Checking') },
    { seq: 4, type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    { seq: 5, type: 'tool/result', data: { message: { source: { callId: 'c1' } } } },
    { seq: 6, type: 'assistant/attempt', data: message('Failed attempt') },
    { seq: 7, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const result = dispatchedTurn(events, { dispatchId: 'd1', afterSeq: 0, action: 'followup' })
  assert.equal(result.done, true)
  assert.equal(result.replyText, '')
})

for (const kind of ['user', 'weixin-dispatch']) test(`project dispatch rejects the answer to a later ${kind} instruction`, () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'own', source: { kind: 'weixin-dispatch', dispatchId: 'd1' } } },
    { seq: 3, type: 'user/message', data: { id: 'later', source: { kind, dispatchId: 'other' } } },
    { seq: 4, type: 'assistant/message', data: message('Answer to later instruction') },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const result = dispatchedTurn(events, { dispatchId: 'd1', messageId: 'own', afterSeq: 0, action: 'followup' })
  assert.equal(result.done, true)
  assert.equal(result.ok, false)
  assert.equal(result.replyText, '')
})

test('ordinary and dispatched replies recover a verified answer before a silent step', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { dispatchId: 'id' } } },
    ...completeStep(1, 'Final answer'), ...completeStep(2, '[SILENT]'),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, index) => ({ ...event, seq: index + 1 }))
  assert.equal(readAssistantReply({ events }).text, 'Final answer')
  const hostOrder = [events[0], completeStep(1, 'Final answer')[0], { type: 'user/message', data: { id: 'ours', source: { kind: 'user' } } }, ...completeStep(1, 'Final answer').slice(1), ...completeStep(2, '[SILENT]'), events.at(-1)].map((event, index) => ({ ...event, seq: index + 1 }))
  assert.equal(readAssistantReply({ events: hostOrder, messageId: 'ours', afterSeq: 0 }).text, 'Final answer')
  assert.equal(dispatchedTurn(events, { dispatchId: 'id', afterSeq: 0, action: 'followup' }).replyText, 'Final answer')
  const claimedAfterAnswer = events.find(event => event.type === 'step/end' && event.data.step === 1).seq
  assert.equal(dispatchedTurn(events, { dispatchId: 'id', afterSeq: 0, claimedTurn: 1, claimedAfterSeq: claimedAfterAnswer, action: 'steer' }).replyText, '[SILENT]')
  const unsafe = events.map(event => event.type === 'assistant/message' && event.data.step === 1 ? { ...event, data: { ...event.data, interrupted: true } } : event)
  assert.equal(readAssistantReply({ events: unsafe }).text, '[SILENT]')
  assert.equal(dispatchedTurn(unsafe, { dispatchId: 'id', afterSeq: 0, action: 'followup' }).replyText, '[SILENT]')
  const silentStart = events.findIndex(event => event.type === 'step/start' && event.data.step === 2)
  const retracted = [...events.slice(0, silentStart), { type: 'user/message', data: { source: { kind: 'weixin-dispatch' } } }, ...events.slice(silentStart)].map((event, index) => ({ ...event, seq: index + 1 }))
  const retractedReply = dispatchedTurn(retracted, { dispatchId: 'id', afterSeq: 0, action: 'followup' })
  assert.equal(retractedReply.ok, false)
  assert.equal(retractedReply.replyText, '')
})
