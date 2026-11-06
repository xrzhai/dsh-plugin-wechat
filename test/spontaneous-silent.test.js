import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentBridge } from '../src/agent-bridge.js'
import { readAssistantReply } from '../src/session-reader.js'
import { CATALOG } from '../src/i18n.js'

// Durable event shapes from DSH agent-loop 0.2.2-rc.1, not a live model or network.
// Pinned upstream sources and limits: ../docs/silent-reply-recovery.md.
function step(number, text, options = {}) {
  const content = options.content ?? [{ type: 'text', text }]
  return [
    { type: 'step/start', data: { turn: 1, step: number } },
    ...(options.input ? [{ type: 'user/message', data: { role: 'user', source: options.input, content: [{ type: 'text', text: 'synthetic input' }] } }] : []),
    { type: options.type ?? 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: number, ...(options.interrupted ? { interrupted: true } : {}),
      message: { role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content },
      stream: [
        { type: 'reasoning-chunks', texts: ['PRIVATE REASONING'] },
        { type: 'text-chunks', texts: [options.streamText ?? text] },
        ...(options.finish === null ? [] : [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: options.finish ?? 'stop' } } }]),
      ],
    } },
    ...(options.tools ? [
      { type: 'tool/call', data: { turn: 1, step: number, callId: 'call-1', name: 'synthetic', arguments: 'PRIVATE ARGS' } },
      { type: 'tool/result', data: { turn: 1, step: number, message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'PRIVATE TOOL RESULT' }] } } },
    ] : []),
    { type: 'step/end', data: { turn: 1, step: number } },
  ]
}

function turn(steps, reason = 'completed') {
  return [{ type: 'turn/start', data: { turn: 1 } }, ...steps.flat(),
    { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } }]
    .map((event, i) => ({ ...event, seq: i + 1 }))
}

async function fixture(t, events, handler) {
  const delivered = [], logs = []
  const bridge = new AgentBridge({ ctx: { get: () => undefined }, spontaneousPollMs: 60_000,
    log: line => logs.push(line), errLog: line => logs.push(line),
    onSpontaneousReply: async reply => { if (handler) await handler(reply); delivered.push(reply.text) },
  })
  t.after(() => bridge.dispose())
  const record = { agent: { session: { id: 'synthetic', snapshotEvents: () => events } },
    conversationId: 'synthetic', accountId: 'synthetic', lastDeliveredSeq: 0,
    busy: false, spontaneousSending: false, dispose: async () => {},
  }
  bridge.sessions.set('synthetic', record)
  await bridge.testPollSpontaneous()
  return { bridge, record, delivered, logs }
}

test('a completed reply survives a later silent step of the same turn once', async t => {
  const events = turn([step(1, 'Important reminder'), step(2, '[SILENT]', {
    input: { kind: 'subagent-settled', form: 'notice', stopReason: 'completed', senderSessionId: 'child' },
  })])
  const f = await fixture(t, events)
  assert.deepEqual(f.delivered, ['Important reminder'])
  assert.equal(f.record.lastDeliveredSeq, events.at(-1).seq)
  await f.bridge.testPollSpontaneous()
  assert.equal(f.delivered.length, 1)
  assert.ok(f.logs.some(line => line.includes('recovered')))
  assert.ok(f.logs.every(line => !line.includes('Important reminder') && !line.includes('PRIVATE')))
})

test('readAssistantReply recovers a completed reply before a same-turn silent step', () => {
  const events = turn([step(1, 'Important reminder'), step(2, '[SILENT]')])
  const reply = readAssistantReply({ events, afterSeq: 0 })
  assert.equal(reply.text, 'Important reminder')
  assert.equal(reply.turnSettled, true)
  assert.equal(reply.settledSeq, events.at(-1).seq)
})

test('only the latest completed reply is retained, never concatenating drafts', async t => {
  const f = await fixture(t, turn([step(1, 'Old answer'), step(2, 'Revised answer'), step(3, '[SILENT]')]))
  assert.deepEqual(f.delivered, ['Revised answer'])
})

for (const marker of ['[SILENT]', ' [silent] \n', 'HEARTBEAT_OK', '（静默）', '（已取消）']) {
  test(`pure marker remains silent: ${JSON.stringify(marker)}`, async t => {
    const f = await fixture(t, turn([step(1, marker)]))
    assert.deepEqual(f.delivered, [])
  })
}

for (const [label, options] of [
  ['tool-bearing message', { content: [{ type: 'text', text: 'I will check' }, { type: 'tool-call', id: 'call-1', name: 'synthetic', arguments: '{}' }], tools: true }],
  ['tool events even if message metadata is inconsistent', { tools: true }],
  ['failed attempt', { type: 'assistant/attempt' }],
  ['interrupted prefix', { interrupted: true }],
  ['truncated output', { finish: 'max-tokens' }],
  ['aborted output', { finish: 'aborted' }],
  ['error output', { finish: 'error' }],
  ['unknown finish', { finish: 'new-unknown-reason' }],
  ['unverifiable legacy finish', { finish: null }],
]) {
  test(`does not revive ${label} before silence`, async t => {
    const f = await fixture(t, turn([step(1, 'Do not publish this', options), step(2, '[SILENT]')]))
    assert.deepEqual(f.delivered, [])
  })
}

test('a newer human instruction invalidates the earlier answer', async t => {
  const f = await fixture(t, turn([step(1, 'Old answer'), step(2, '[SILENT]', { input: { kind: 'user' } })]))
  assert.deepEqual(f.delivered, [])
})

test('cancellation marker never resurrects a previous reply', async t => {
  const f = await fixture(t, turn([step(1, 'Old answer'), step(2, '（已取消）')]))
  assert.deepEqual(f.delivered, [])
})

for (const reason of ['aborted', 'blocked', 'interrupted', 'forked', 'max-tokens', 'error']) {
  test(`non-completed turn reports its status instead of publishing a partial reply: ${reason}`, async t => {
    const f = await fixture(t, turn([step(1, 'Partial reply')], reason))
    const expected = ['aborted', 'blocked', 'error'].includes(reason) ? reason : 'unknown'
    assert.deepEqual(f.delivered, [CATALOG[`turn.${expected}`].zh])
    await f.bridge.testPollSpontaneous()
    assert.equal(f.delivered.length, 1)
  })
}

test('unknown terminal reason and completed turn with unresolved tool report uncertainty', async t => {
  const missingReason = turn([step(1, 'Partial')])
  missingReason.at(-1).data.reason = undefined
  const first = await fixture(t, missingReason)
  assert.deepEqual(first.delivered, [CATALOG['turn.unknown'].zh])
  const unresolved = turn([step(1, 'Partial', { tools: true })]).filter(event => event.type !== 'tool/result')
  const second = await fixture(t, unresolved)
  assert.deepEqual(second.delivered, [CATALOG['turn.unknown'].zh])
})

test('a delivery error retains the cursor and retries the recovered reply', async t => {
  let calls = 0
  const events = turn([step(1, 'Important reminder'), step(2, '[SILENT]')])
  const f = await fixture(t, events, () => { if (++calls === 1) throw new Error('synthetic delivery failure') })
  assert.deepEqual(f.delivered, [])
  assert.equal(f.record.lastDeliveredSeq, 0)
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(f.delivered, ['Important reminder'])
  assert.equal(f.record.lastDeliveredSeq, events.at(-1).seq)
})

test('an in-flight turn cannot publish the earlier complete step', async t => {
  const events = turn([step(1, 'Important reminder'), step(2, '[SILENT]')]).slice(0, -1)
  const f = await fixture(t, events)
  assert.deepEqual(f.delivered, [])
  assert.equal(f.record.lastDeliveredSeq, 0)
})

test('unstructured multiple-message history stays silent rather than guessing a completed step', async t => {
  const events = turn([step(1, 'Unknown draft'), step(2, '[SILENT]')])
    .filter(event => !event.type.startsWith('step/'))
  const f = await fixture(t, events)
  assert.deepEqual(f.delivered, [])
})

test('a later substantive reply remains authoritative', async t => {
  const f = await fixture(t, turn([step(1, 'Old answer'), step(2, '[SILENT]'), step(3, 'Final answer')]))
  assert.deepEqual(f.delivered, ['Final answer'])
})

test('recovery is limited to pure SILENT, not other markers or mixed text', async t => {
  for (const text of ['HEARTBEAT_OK', '（静默）', '[SILENT]\nLegacy prefix behavior']) {
    const f = await fixture(t, turn([step(1, 'Old answer'), step(2, text)]))
    assert.deepEqual(f.delivered, [])
  }
  const f = await fixture(t, turn([step(1, 'Old answer'), step(2, 'New answer\n[SILENT]')]))
  assert.deepEqual(f.delivered, ['New answer\n[SILENT]'])
})

test('repeated whitespace/case variants of SILENT do not overwrite the answer', async t => {
  const f = await fixture(t, turn([step(1, 'Answer'), step(2, ' [silent] \n'), step(3, '[SILENT]')]))
  assert.deepEqual(f.delivered, ['Answer'])
})

for (const [label, alter] of [
  ['missing completed step', events => events.filter(event => !(event.type === 'step/end' && event.data.step === 1))],
  ['wrong turn identity', events => events.map(event => event.data?.step === 1 ? { ...event, data: { ...event.data, turn: 9 } } : event)],
  ['interrupted final marker', events => events.map(event => event.type === 'assistant/message' && event.data.step === 2 ? { ...event, data: { ...event.data, interrupted: true } } : event)],
  ['inconsistent stream/body', events => events.map(event => event.type === 'assistant/message' && event.data.step === 1 ? { ...event, data: { ...event.data, stream: [{ type: 'text-chunks', texts: ['Different stream'] }, { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }] } } : event)],
  ['replaced surface', events => events.map(event => event.type === 'user/message' ? { ...event, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } } : event)],
]) {
  test(`unverifiable event history is not replayed: ${label}`, async t => {
    const events = alter(turn([step(1, 'Answer'), step(2, '[SILENT]', { input: { kind: 'subagent-settled' } })]))
    const f = await fixture(t, events)
    assert.deepEqual(f.delivered, [])
  })
}

test('later non-text tool work cannot hide behind an earlier silent message', async t => {
  const f = await fixture(t, turn([step(1, 'Old answer'), step(2, '[SILENT]'), step(3, '', {
    content: [{ type: 'tool-call', id: 'call-1', name: 'synthetic', arguments: '{}' }], tools: true,
  })]))
  assert.deepEqual(f.delivered, [])
})

test('failed attempt between answer and silence prevents fallback', async t => {
  const f = await fixture(t, turn([step(1, 'Old answer'), step(2, '', { type: 'assistant/attempt' }), step(3, '[SILENT]')]))
  assert.deepEqual(f.delivered, [])
})

test('a consumed reply before the cursor is not recovered a second time', async t => {
  const events = turn([step(1, 'Answer'), step(2, '[SILENT]')])
  const f = await fixture(t, [])
  f.record.agent.session.snapshotEvents = () => events
  f.record.lastDeliveredSeq = events.find(event => event.type === 'step/end' && event.data.step === 1).seq
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(f.delivered, [])
})

test('failure on the second recovered turn does not duplicate the first turn', async t => {
  const first = turn([step(1, 'First'), step(2, '[SILENT]')])
  const second = turn([step(1, 'Second'), step(2, '[SILENT]')]).map(event => ({ ...event,
    seq: event.seq + first.length, data: { ...event.data, ...(event.data?.turn !== undefined ? { turn: 2 } : {}) },
  }))
  let fail = true
  const f = await fixture(t, [...first, ...second], reply => {
    if (reply.text === 'Second' && fail) { fail = false; throw new Error('synthetic failure') }
  })
  assert.deepEqual(f.delivered, ['First'])
  assert.equal(f.record.lastDeliveredSeq, first.at(-1).seq)
  await f.bridge.testPollSpontaneous()
  assert.deepEqual(f.delivered, ['First', 'Second'])
  assert.equal(f.record.lastDeliveredSeq, second.at(-1).seq)
})

test('canonical text with block-end-only stream is also a completed reply', async t => {
  const events = turn([step(1, 'Answer'), step(2, '[SILENT]')])
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    event.data.stream = [
      { type: 'chunk', chunk: { type: 'block-end', index: 0, block: event.data.message.content[0] } },
      { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
  }
  const f = await fixture(t, events)
  assert.deepEqual(f.delivered, ['Answer'])
})
