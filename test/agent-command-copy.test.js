import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentBridge } from '../src/agent-bridge.js'
import { scopedLineKey } from '../src/sessions.js'

function fixture(t, { commands, cancel } = {}) {
  const logs = []
  const lines = { active: () => 'session-1' }
  const bridge = new AgentBridge({
    ctx: { get: (name) => name === 'commands' ? commands : undefined },
    lines,
    log: (line) => logs.push(line),
    errLog: (line) => logs.push(line),
  })
  t.after(async () => { await bridge.dispose() })

  const record = {
    agent: {
      session: { id: 'session-1', snapshotEvents: () => [] },
      cancel,
    },
    conversationId: 'chat',
    accountId: 'account',
    lastDeliveredSeq: 0,
    busy: true,
    spontaneousSending: false,
    dispose: async () => {},
  }
  bridge.sessions.set('session-1', record)
  bridge.conversationTargets.set(scopedLineKey('account', 'chat'), 'session-1')
  return { bridge, record, logs }
}

test('cancel reports a request without claiming the running reply already stopped', async (t) => {
  let cancelled = 0
  const f = fixture(t, { cancel: () => { cancelled += 1 } })

  const reply = f.bridge.handleCommand('chat', '/cancel', 'account')

  assert.equal(reply, '已发出停止请求；已经开始的操作不会回滚。')
  assert.equal(cancelled, 1)
  assert.equal(f.record.cancelled, true)
  assert.doesNotMatch(reply, /已停止|停止失败/)
})

test('cancel explains host limits and keeps thrown diagnostics in the log', async (t) => {
  const limited = fixture(t, { cancel: undefined })
  assert.equal(
    limited.bridge.handleCommand('chat', '/cancel', 'account'),
    '当前 DSH 版本不支持停止正在处理的回复；这次只能等它完成。',
  )

  const failed = fixture(t, {
    cancel: () => { throw new Error('synthetic cancel diagnostic') },
  })
  const reply = failed.bridge.handleCommand('chat', '/cancel', 'account')
  assert.equal(reply, '没能发出停止请求；当前回复可能仍在继续。详细信息已写入日志。')
  assert.doesNotMatch(reply, /synthetic cancel diagnostic/)
  assert.ok(failed.logs.some((line) => line.includes('synthetic cancel diagnostic')))
})

test('compact preserves legacy host text without requiring a result kind', async (t) => {
  const legacy = fixture(t, {
    commands: {
      execute: async () => ({ result: { text: 'host wording' } }),
    },
    cancel: undefined,
  })
  legacy.record.busy = false

  assert.equal(
    await legacy.bridge.handleCommand('chat', '/compact', 'account'),
    'host wording',
  )
})

test('compact uses safe fallbacks only when host text is absent and logs failures', async (t) => {
  let compacted = 0
  const success = fixture(t, {
    commands: {
      execute: async (agent, command) => {
        compacted += 1
        assert.equal(agent.session.id, 'session-1')
        assert.equal(command, '/compact')
        return { result: { kind: 'success' } }
      },
    },
    cancel: undefined,
  })
  success.record.busy = false

  assert.equal(await success.bridge.handleCommand('chat', '/compact', 'account'), '已整理当前话题的前文。')
  assert.equal(compacted, 1)

  const failed = fixture(t, {
    commands: {
      execute: async () => ({ result: { kind: 'failed' } }),
    },
    cancel: undefined,
  })
  failed.record.busy = false
  const reply = await failed.bridge.handleCommand('chat', '/compact', 'account')
  assert.equal(reply, '这次没能整理当前话题的前文；对话仍可继续。详细信息已写入日志。')
  assert.ok(failed.logs.some((line) => line.includes('compact result kind=failed')))

  const thrown = fixture(t, {
    commands: {
      execute: async () => { throw new Error('synthetic compact diagnostic') },
    },
    cancel: undefined,
  })
  thrown.record.busy = false
  const thrownReply = await thrown.bridge.handleCommand('chat', '/compact', 'account')
  assert.equal(thrownReply, '这次没能整理当前话题的前文；对话仍可继续。详细信息已写入日志。')
  assert.doesNotMatch(thrownReply, /synthetic compact diagnostic/)
  assert.ok(thrown.logs.some((line) => line.includes('synthetic compact diagnostic')))
})

test('compact distinguishes a missing command service from a failed attempt', async (t) => {
  const unavailable = fixture(t, { cancel: undefined })
  unavailable.record.busy = false

  assert.equal(
    await unavailable.bridge.handleCommand('chat', '/compact', 'account'),
    '当前环境暂时不能手动整理前文，请稍后再试。',
  )
  assert.ok(unavailable.logs.some((line) => line.includes('commands service is not mounted')))
})
