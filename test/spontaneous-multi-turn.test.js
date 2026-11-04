import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSettledTurns, readAssistantReply } from '../src/session-reader.js'
import { AgentBridge } from '../src/agent-bridge.js'

test('readSettledTurns correctly splits multiple turns in a single event stream', () => {
  const events = [
    // Turn 1: Subagent reports result
    { seq: 10, type: 'turn/start' },
    { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '搞定！PR已合并，测试全绿。' }] } } },
    { seq: 12, type: 'turn/end', data: { reason: { kind: 'completed' } } },

    // Turn 2: Subagent exits, parent session replies [SILENT]
    { seq: 13, type: 'turn/start' },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '[SILENT]' }] } } },
    { seq: 15, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]

  const turns = readSettledTurns({ events, afterSeq: 0 })
  assert.equal(turns.length, 2)

  assert.equal(turns[0].text, '搞定！PR已合并，测试全绿。')
  assert.equal(turns[0].settledSeq, 12)
  assert.equal(turns[0].turnSettled, true)
  assert.deepEqual(turns[0].pendingTools, [])

  assert.equal(turns[1].text, '[SILENT]')
  assert.equal(turns[1].settledSeq, 15)
  assert.equal(turns[1].turnSettled, true)
  assert.deepEqual(turns[1].pendingTools, [])
})

test('readSettledTurns excludes unsettled in-flight turns', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Turn 1 done' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },

    // Turn 2 still running (tool call without turn/end)
    { seq: 4, type: 'turn/start' },
    { seq: 5, type: 'tool/call', data: { callId: 'call_1', name: 'search' } },
  ]

  const turns = readSettledTurns({ events, afterSeq: 0 })
  assert.equal(turns.length, 1)
  assert.equal(turns[0].text, 'Turn 1 done')
  assert.equal(turns[0].settledSeq, 3)
})

test('readSettledTurns respects afterSeq cursor', () => {
  const events = [
    { seq: 10, type: 'turn/start' },
    { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Turn 1' }] } } },
    { seq: 12, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 13, type: 'turn/start' },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Turn 2' }] } } },
    { seq: 15, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]

  const turnsAfter12 = readSettledTurns({ events, afterSeq: 12 })
  assert.equal(turnsAfter12.length, 1)
  assert.equal(turnsAfter12[0].text, 'Turn 2')
  assert.equal(turnsAfter12[0].settledSeq, 15)
})

test('readSettledTurns supports stream text-chunks and fallback to message blocks', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        stream: [{ type: 'text-chunks', texts: ['Hello', ' ', 'world'] }],
      },
    },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]

  const turns = readSettledTurns({ events, afterSeq: 0 })
  assert.equal(turns.length, 1)
  assert.equal(turns[0].text, 'Hello world')
})

test('readSettledTurns captures turnError for failed turns', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Provider rate limited' } } } },
  ]

  const turns = readSettledTurns({ events, afterSeq: 0 })
  assert.equal(turns.length, 1)
  assert.equal(turns[0].turnSettled, false)
  assert.equal(turns[0].turnError, 'Provider rate limited')
  assert.equal(turns[0].settledSeq, 2)
})

test('AgentBridge spontaneous poll delivers Turn 1 text and suppresses Turn 2 [SILENT] without losing Turn 1', async () => {
  const delivered = []
  const bridge = new AgentBridge({
    ctx: { get: () => undefined },
    spontaneousPollMs: 60_000,
    onSpontaneousReply: async (reply) => {
      delivered.push(reply)
    },
  })

  const events = [
    // Turn 1: Subagent delivers report
    { seq: 10, type: 'turn/start' },
    { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '搞定！PR已合并，测试全绿。' }] } } },
    { seq: 12, type: 'turn/end', data: { reason: { kind: 'completed' } } },

    // Turn 2: Subagent exits, parent session replies [SILENT]
    { seq: 13, type: 'turn/start' },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '[SILENT]' }] } } },
    { seq: 15, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]

  const record = {
    agent: {
      session: {
        id: 'test-session',
        snapshotEvents: () => events,
      },
    },
    conversationId: 'test-convo',
    accountId: 'test-account',
    busy: false,
    spontaneousSending: false,
    lastDeliveredSeq: 5,
    dispose: async () => {},
  }
  bridge.sessions.set('test-session', record)

  // Trigger poll pass
  await bridge.testPollSpontaneous()

  // Assert Turn 1 was delivered
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].sessionId, 'test-session')
  assert.equal(delivered[0].conversationId, 'test-convo')
  assert.equal(delivered[0].accountId, 'test-account')
  assert.equal(delivered[0].text, '搞定！PR已合并，测试全绿。')

  // Assert cursor moved to Turn 2's settledSeq (15)
  assert.equal(record.lastDeliveredSeq, 15)

  // Subsequent poll should not deliver anything again
  await bridge.testPollSpontaneous()
  assert.equal(delivered.length, 1)

  await bridge.dispose()
})

test('AgentBridge spontaneous poll delivers multiple non-silent turns in order', async () => {
  const delivered = []
  const bridge = new AgentBridge({
    ctx: { get: () => undefined },
    spontaneousPollMs: 60_000,
    onSpontaneousReply: async (reply) => {
      delivered.push(reply.text)
    },
  })

  const events = [
    { seq: 10, type: 'turn/start' },
    { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Step 1 complete' }] } } },
    { seq: 12, type: 'turn/end', data: { reason: { kind: 'completed' } } },

    { seq: 13, type: 'turn/start' },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Step 2 complete' }] } } },
    { seq: 15, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]

  const record = {
    agent: {
      session: {
        id: 'test-session',
        snapshotEvents: () => events,
      },
    },
    conversationId: 'test-convo',
    accountId: 'test-account',
    busy: false,
    spontaneousSending: false,
    lastDeliveredSeq: 0,
    dispose: async () => {},
  }
  bridge.sessions.set('test-session', record)

  await bridge.testPollSpontaneous()

  assert.deepEqual(delivered, ['Step 1 complete', 'Step 2 complete'])
  assert.equal(record.lastDeliveredSeq, 15)

  await bridge.dispose()
})
