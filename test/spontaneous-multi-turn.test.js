import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSettledTurns, readAssistantReply } from '../src/session-reader.js'
import { AgentBridge } from '../src/agent-bridge.js'
import { CATALOG } from '../src/i18n.js'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'

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

test('readAssistantReply ignores failed attempts as final text', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/attempt', data: { message: { content: [{ type: 'text', text: '失败尝试的半截文本' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]

  const reply = readAssistantReply({ events, afterSeq: 0 })
  assert.equal(reply.text, '')
  assert.equal(reply.turnSettled, true)
})

test('a message without a terminal event is not assumed complete', () => {
  const events = [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } }]
  assert.equal(readAssistantReply({ events }).turnSettled, false)
  assert.deepEqual(readSettledTurns({ events }), [])
})

test('host tool result source.callId clears pending progress for old and current message shapes', () => {
  const oldResult = createToolResultMessage({ callId: 'call-1', content: [{ type: 'text', text: 'done' }], isError: false })
  const currentResult = { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'done' }], isError: false }
  for (const message of [oldResult, currentResult]) {
    const events = [
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'tool/call', data: { callId: 'call-1', name: 'read' } },
      { seq: 3, type: 'tool/result', data: { message } },
    ]
    assert.deepEqual(readAssistantReply({ events: events.slice(0, 2) }).pendingTools, ['read'])
    assert.deepEqual(readAssistantReply({ events }).pendingTools, [])
    const ended = [...events, { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } }]
    assert.deepEqual(readSettledTurns({ events: ended })[0].pendingTools, [])
  }
})

for (const reason of ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'future-kind', undefined]) {
  for (const late of [false, true]) {
    test(`direct ${late ? 'late' : 'normal'} reply respects terminal reason ${reason ?? 'missing'}`, async t => {
      const events = []
      const logs = []
      const bridge = new AgentBridge({
        ctx: { get: () => undefined }, lines: { active: () => 'session-1', title: () => undefined },
        eventPollMs: 1, eventPollFastMs: 1, maxWaitMs: late ? 0 : 500, lateReplyMaxWaitMs: 500,
        errLog: line => logs.push(line),
      })
      t.after(() => bridge.dispose())
      const agent = {
        session: { id: 'session-1', snapshotEvents: () => events },
        followup: () => events.push(
          { seq: 1, type: 'turn/start' },
          { seq: 2, type: 'assistant/message', data: { interrupted: reason === 'aborted', message: { content: [{ type: 'text', text: 'partial or final' }] } } },
          { seq: 3, type: 'turn/end', data: { reason: reason === undefined ? undefined : { kind: reason, ...(reason === 'error' ? { error: { code: 'RATE_LIMIT', message: 'provider failed: Bearer synthetic-secret-token-123' } } : {}) } } },
        ),
      }
      bridge.sessions.set('session-1', { agent, busy: false, queue: [], cancelled: false, auditSeq: -1, auditCalls: new Map(), lastDeliveredSeq: -1, dispose: async () => {} })
      const callbacks = []
      const result = await bridge.deliver({ conversationId: 'chat', text: 'task', ...(late ? { onLateReply: async value => callbacks.push(value) } : {}) })
      const observed = readAssistantReply({ events })
      assert.equal(observed.turnReason, reason ?? 'unknown')
      assert.equal(observed.turnSettled, reason === 'completed')
      assert.equal(readSettledTurns({ events })[0].turnSettled, reason === 'completed')
      const expectedStatus = ['aborted', 'blocked', 'error'].includes(reason) ? reason : 'unknown'
      const expected = reason === 'completed' ? 'partial or final' : CATALOG[`turn.${expectedStatus}`].zh
      assert.equal(late ? callbacks.at(-1).text : result.text, expected)
      if (reason !== 'completed') assert.equal(late ? callbacks.at(-1).status : result.status, reason ?? 'unknown')
      if (reason === 'error') {
        assert.equal(logs.length, 1)
        assert.match(logs[0], /turn\/end error session=session-1 seq=3 code="RATE_LIMIT"/)
        assert.match(logs[0], /provider failed: Bearer \*\*\*/)
        assert.doesNotMatch(logs[0], /synthetic-secret-token-123/)
      }
    })
  }
}

for (const late of [false, true]) {
  test(`unobserved terminal event reports unknown after ${late ? 'late' : 'normal'} wait`, async t => {
    const events = []
    const bridge = new AgentBridge({
      ctx: { get: () => undefined }, lines: { active: () => 'session-1', title: () => undefined },
      eventPollMs: 1, maxWaitMs: 0, lateReplyMaxWaitMs: 2,
    })
    t.after(() => bridge.dispose())
    const agent = {
      session: { id: 'session-1', snapshotEvents: () => events },
      followup: () => events.push({ seq: 1, type: 'turn/start' }, { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } }),
    }
    bridge.sessions.set('session-1', { agent, busy: false, queue: [], cancelled: false, auditSeq: -1, auditCalls: new Map(), lastDeliveredSeq: -1, dispose: async () => {} })
    const callbacks = []
    const result = await bridge.deliver({ conversationId: 'chat', text: 'task', ...(late ? { onLateReply: async value => callbacks.push(value) } : {}) })
    const notice = late ? callbacks.at(-1) : result
    assert.equal(notice.text, CATALOG['turn.unobserved'].zh)
    assert.equal(notice.status, 'unknown')
  })
}

for (const late of [false, true]) test(`completed remains authoritative with incomplete tool tracking during ${late ? 'late' : 'normal'} delivery`, async t => {
  const events = []
  const bridge = new AgentBridge({ ctx: { get: () => undefined }, lines: { active: () => 'session-1', title: () => undefined }, eventPollMs: 1, maxWaitMs: late ? 0 : 500, lateReplyMaxWaitMs: 500 })
  t.after(() => bridge.dispose())
  const agent = {
    session: { id: 'session-1', snapshotEvents: () => events },
    followup: () => events.push(
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
      { seq: 3, type: 'tool/call', data: { callId: 'tool', name: 'read' } },
      { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ),
  }
  bridge.sessions.set('session-1', { agent, busy: false, queue: [], cancelled: false, auditSeq: -1, auditCalls: new Map(), lastDeliveredSeq: -1, dispose: async () => {} })
  const callbacks = []
  const result = await bridge.deliver({ conversationId: 'chat', text: 'task', ...(late ? { onLateReply: async value => callbacks.push(value) } : {}) })
  const delivered = late ? callbacks.at(-1) : result
  assert.equal(delivered.text, 'final answer')
  assert.equal(delivered.status, undefined)
})

test('AgentBridge deliver waits for turn/end after a tool-call transition step', async (t) => {
  const transition = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我先看一下文件。' }] } } },
    { seq: 3, type: 'tool/call', data: { callId: 'read-1', name: 'read' } },
  ]
  const complete = [
    ...transition,
    { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'read-1' }, content: [{ type: 'text', text: 'file body' }] } } },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '文件的实际结论。' }] } } },
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  let phase = 0
  const agent = {
    session: {
      id: 'session-1',
      snapshotEvents: () => {
        if (phase === 0) return []
        if (phase === 1) {
          phase = 2
          return transition
        }
        return complete
      },
    },
    followup: () => { phase = 1 },
  }
  const bridge = new AgentBridge({
    ctx: { get: () => undefined },
    lines: { active: () => 'session-1', title: () => undefined },
    eventPollFastMs: 1,
    eventPollMs: 1,
    maxWaitMs: 500,
  })
  t.after(() => bridge.dispose())
  bridge.sessions.set('session-1', {
    agent,
    conversationId: 'chat',
    lastDeliveredSeq: -1,
    busy: false,
    queue: [],
    cancelled: false,
    auditSeq: -1,
    auditCalls: new Map(),
    spontaneousSending: false,
    dispose: async () => {},
  })

  const result = await bridge.deliver({ conversationId: 'chat', text: '读取文件' })
  assert.equal(result.text, '文件的实际结论。')
})

test('AgentBridge late-reply wait still ignores a transition before turn/end', async (t) => {
  const transition = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正在运行测试。' }] } } },
    { seq: 3, type: 'tool/call', data: { callId: 'test-1', name: 'bash' } },
  ]
  const complete = [
    ...transition,
    { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'test-1' }, content: [{ type: 'text', text: 'ok' }] } } },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '测试已全部通过。' }] } } },
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  let phase = 0
  const agent = {
    session: {
      id: 'session-1',
      snapshotEvents: () => {
        if (phase === 0) return []
        if (phase === 1) {
          phase = 2
          return transition
        }
        return complete
      },
    },
    followup: () => { phase = 1 },
  }
  const late = []
  const bridge = new AgentBridge({
    ctx: { get: () => undefined },
    lines: { active: () => 'session-1', title: () => undefined },
    eventPollFastMs: 1,
    eventPollMs: 1,
    maxWaitMs: 0,
    lateReplyMaxWaitMs: 500,
  })
  t.after(() => bridge.dispose())
  bridge.sessions.set('session-1', {
    agent,
    conversationId: 'chat',
    lastDeliveredSeq: -1,
    busy: false,
    queue: [],
    cancelled: false,
    auditSeq: -1,
    auditCalls: new Map(),
    spontaneousSending: false,
    dispose: async () => {},
  })

  await bridge.deliver({
    conversationId: 'chat',
    text: '运行测试',
    onLateReply: async value => { late.push(value) },
  })
  assert.deepEqual(late, [
    { kind: 'timeout-notice' },
    { kind: 'reply', text: '测试已全部通过。' },
  ])
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
