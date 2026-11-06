import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionDispatcher, SESSION_TOOL_SCHEMAS, assertWritable } from '../src/session-dispatcher.js'
import { dispatchedTurn, recentSessionTurns } from '../src/session-dispatch-reader.js'

const text = value => ({ content: [{ type: 'text', text: value }] })
function fixture(t, config = {}) {
  const registered = new Map(), agents = new Map(), rows = new Map(), notifications = [], calls = []
  let unmounted = 0, disposed = 0, messageNumber = 0
  const listeners = new Map()
  const controller = { id: 'controller', status: 'idle', session: { id: 'controller', header: { id: 'controller' } }, ctx: { tools: { register(tool, options) { registered.set(tool.name, { tool, options }); return () => unmounted++ } } } }
  agents.set(controller.id, controller)
  const source = { accountId: 'bot-A', senderId: 'user-A', conversationId: 'chat-A' }
  const add = (id = 'project', extra = {}) => {
    const events = []; const agent = { id, status: 'idle', session: { id, header: { id, cwd: '/fixture' }, snapshotEvents: () => events },
      followup(message) { calls.push({ id, action: 'followup', message }); this.status = 'running' },
      steer(message) { calls.push({ id, action: 'steer', message }) },
      cancel(...args) { calls.push({ id, action: 'cancel', args }) },
    }
    agents.set(id, agent); rows.set(id, { sessionId: id, title: id, cwd: '/fixture', status: 'idle', lastUpdatedMs: 1, events, agent, ...extra }); return agent
  }
  const host = { list: async () => [...rows.values()], read: async id => { if (!rows.has(id)) throw new Error('not found'); return rows.get(id) }, resume: async id => { calls.push({ id, action: 'resume' }); rows.get(id).agent = agents.get(id); return agents.get(id) }, dispose: async () => disposed++ }
  const options = { sessionDispatcherEnabled: true, sessionDispatcherSenders: ['user-A'], sessionDispatcherTargets: ['controller', 'project', 'a', 'b', 'c', ...Array.from({ length: 50 }, (_, i) => `long-${i}`)], allowedSenders: ['user-A'], ...config }
  const dispatcher = new SessionDispatcher({ ctx: { on: (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name) }, get: name => name === 'agents' ? { get: id => agents.get(id) } : undefined }, config: () => options,
    sourceFor: agent => agent === controller ? source : undefined, host, createUserMessage: value => ({ ...value, id: `message-${++messageNumber}` }), notify: async value => notifications.push(value), pollMs: 2, monitorMs: 2000 })
  const invoke = (name, args, exec = { agent: controller }) => dispatcher.execute(name, args, exec, controller)
  const complete = (id, dispatchId, reply = 'own reply') => {
    const row = rows.get(id), events = row.events
    const push = (type, data = {}) => events.push({ seq: events.length + 1, type, data })
    push('turn/start'); push('user/message', { ...text('task'), source: { dispatchId } }); push('assistant/message', { message: text(reply) }); push('turn/end', { reason: { kind: 'completed' } }); row.agent.status = 'idle'
  }
  t.after(() => dispatcher.dispose())
  return { dispatcher, controller, registered, agents, rows, listeners, notifications, calls, source, add, host, options, invoke, complete, counts: () => ({ unmounted, disposed }) }
}
const args = (more = {}) => ({ session_id: 'project', action: 'followup', instruction: 'Do this task', mode: 'async', ...more })

function completedSilentTurn(dispatchId, answer = 'actual result') {
  const step = (number, value) => [
    { type: 'step/start', data: { turn: 1, step: number } },
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: number,
      message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: value }] },
      stream: [{ type: 'text-chunks', texts: [value] }, { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    } },
    { type: 'step/end', data: { turn: 1, step: number } },
  ]
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { dispatchId } } },
    ...step(1, answer), ...step(2, '[SILENT]'),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, index) => ({ ...event, seq: index + 1 }))
}

test('disabled by default, mounts opt-in tools once, visibility and execution require exact live controller', async t => {
  const f = fixture(t, { sessionDispatcherEnabled: undefined }); f.dispatcher.mount(f.controller); assert.equal(f.registered.size, 0)
  await assert.rejects(f.invoke('session_list', {}), /disabled/)
  f.options.sessionDispatcherEnabled = true; f.dispatcher.mount(f.controller); f.dispatcher.mount(f.controller); assert.equal(f.registered.size, 3)
  const { tool, options } = f.registered.get('session_list'); const child = { ...f.controller }
  assert.equal(options.when({ agent: child }), false); assert.equal(options.when({ agent: f.controller }), true)
  await assert.rejects(tool.execute({}, { agent: child }), /original live/)
  await assert.rejects(tool.execute({}, {}), /original live/)
  f.agents.set('controller', child); await assert.rejects(f.invoke('session_list', {}), /original live/)
})

test('schemas reject unknown, missing, invalid, empty and out-of-range arguments', async t => {
  const f = fixture(t)
  assert.equal(SESSION_TOOL_SCHEMAS.session_dispatch.additionalProperties, false)
  for (const [name, value] of [['session_list', { limit: 0 }], ['session_list', { status: 'running' }], ['session_list', { query: ' ' }], ['session_query', {}], ['session_query', { session_id: 'p', depth: 21 }], ['session_query', { session_id: 'p', include_tools: 'yes' }], ['session_dispatch', args({ instruction: 'x'.repeat(16001) })], ['session_dispatch', args({ unknown: true })], ['session_dispatch', args({ timeout_ms: 1.5 })], ['session_dispatch', args({ action: 'create' })]]) await assert.rejects(f.invoke(name, value))
  assert.equal(f.calls.length, 0)
})

test('list filters status, cwd and case-insensitive title/id while bounding metadata', async t => {
  const f = fixture(t); f.add('a', { title: 'Alpha', cwd: '/work/repo', lastUpdatedMs: 1 }); f.add('b', { title: 'Alpha Archive', cwd: '/work/repo', status: 'archived', lastUpdatedMs: 3 }); f.add('c', { title: 'Beta', cwd: '/else', lastUpdatedMs: 2 })
  assert.deepEqual((await f.invoke('session_list', { query: 'ALPHA', cwd_pattern: 'WORK' })).sessions.map(s => s.sessionId), ['a'])
  assert.deepEqual((await f.invoke('session_list', { status: 'all', limit: 2 })).sessions.map(s => s.sessionId), ['b', 'c'])
  for (let i = 0; i < 50; i++) f.add(`long-${i}`, { title: 't'.repeat(10000), cwd: 'p'.repeat(10000) })
  const result = await f.invoke('session_list', { status: 'all', limit: 50 }); assert.ok(JSON.stringify(result).length < 17000); assert.equal(result.truncated, true)
})

test('query archived sessions is read-only and clips output with optional tools', async t => {
  const f = fixture(t); f.add('project', { status: 'archived' }); const events = f.rows.get('project').events
  events.push({ type: 'turn/start' }); for (let i = 0; i < 200; i++) events.push({ type: 'assistant/message', data: { message: text('x'.repeat(9000)) } })
  events.push({ type: 'tool/call', data: { callId: 'call', name: 'tool' } })
  const result = await f.invoke('session_query', { session_id: 'project', include_tools: false }); assert.ok(JSON.stringify(result).length < 18000); assert.equal(result.activeTools, undefined); assert.ok(result.recentTurns.every(r => r.role !== 'tool')); assert.equal(f.calls.length, 0)
})

test('rejects self, other controller, protected, archived and busy targets without admission', async t => {
  const f = fixture(t); f.add(); await assert.rejects(f.invoke('session_dispatch', args({ session_id: 'controller' })), /Self/)
  f.options.protectedSessions = ['project']; await assert.rejects(f.invoke('session_dispatch', args()), /protected/); f.options.protectedSessions = []
  f.rows.get('project').status = 'archived'; await assert.rejects(f.invoke('session_dispatch', args()), /read-only/); f.rows.get('project').status = 'idle'
  f.agents.get('project').status = 'running'; await assert.rejects(f.invoke('session_dispatch', args()), /busy/); assert.equal(f.calls.length, 0)
  f.dispatcher.sourceFor = agent => agent === f.controller ? f.source : { userId: 'other' }; await assert.rejects(f.invoke('session_dispatch', args()), /controllers/)
})

test('read-only path policy catches descendants and missing paths but permits sibling prefixes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-path-'))
  try {
    const protectedPath = path.join(root, 'secret'), sibling = path.join(root, 'secret-other')
    fs.mkdirSync(protectedPath); fs.mkdirSync(sibling)
    const config = { readOnlyPaths: [protectedPath] }
    for (const cwd of [protectedPath, path.join(protectedPath, 'nested')]) assert.throws(() => assertWritable({ cwd }, config), /read-only/)
    assert.doesNotThrow(() => assertWritable({ cwd: sibling }, config)); assert.throws(() => assertWritable({ cwd: path.join(root, 'absent') }, config), /resolve/)
    assert.throws(() => assertWritable({ cwd: '' }, config), /verify/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('read-only path policy resolves directory aliases without requiring Windows symlink privileges', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-alias-'))
  try {
    const protectedPath = path.join(root, 'secret'), alias = path.join(root, 'alias')
    fs.mkdirSync(protectedPath)
    // Directory junctions exercise realpath-based alias protection on Windows
    // without Developer Mode / SeCreateSymbolicLinkPrivilege. Do not skip the
    // security assertion or swallow unrelated filesystem errors.
    fs.symlinkSync(protectedPath, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(fs.realpathSync(alias), fs.realpathSync(protectedPath))
    assert.throws(() => assertWritable({ cwd: alias }, { readOnlyPaths: [protectedPath] }), /read-only/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('busy transition during asynchronous read is rejected; simultaneous dispatch admits once', async t => {
  const f = fixture(t); const agent = f.add(); const original = f.host.read; let reads = 0
  f.host.read = async id => { if (++reads === 2) agent.status = 'running'; return original(id) }
  await assert.rejects(f.invoke('session_dispatch', args()), /busy/); assert.equal(f.calls.length, 0)
  f.host.read = original; agent.status = 'idle'
  const outcomes = await Promise.allSettled([f.invoke('session_dispatch', args()), f.invoke('session_dispatch', args())])
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1); assert.equal(f.calls.length, 1)
})

test('cold followup resumes once; steer and cancel never activate cold sessions', async t => {
  const f = fixture(t); f.add(); delete f.rows.get('project').agent
  await assert.rejects(f.invoke('session_dispatch', args({ action: 'steer' })), /live running/)
  const receipt = await f.invoke('session_dispatch', args()); assert.equal(receipt.mode, 'async'); assert.deepEqual(f.calls.map(c => c.action), ['resume', 'followup'])
})

test('sync observes only matching dispatch turn, not preceding/following turns', async t => {
  const f = fixture(t); f.add()
  const promise = f.invoke('session_dispatch', args({ mode: 'sync', timeout_ms: 500 }))
  await new Promise(resolve => setTimeout(resolve, 5)); const id = f.calls[0].message.source.dispatchId
  f.complete('project', 'unrelated-before', 'secret before'); f.complete('project', id, 'correct response'); f.complete('project', 'unrelated-after', 'secret after')
  const result = await promise; assert.equal(result.replyText, 'correct response'); assert.equal(result.dispatchId, id); assert.equal(result.mode, 'sync'); assert.equal(f.notifications.length, 0)
})

test('async notification and timeout fallback deliver once to original source with correlation id', async t => {
  const f = fixture(t); f.add()
  const receipt = await f.invoke('session_dispatch', args({ mode: 'sync', timeout_ms: 1 })); assert.equal(receipt.mode, 'async'); assert.match(receipt.notice, /Do not resubmit/)
  f.source.senderId = 'changed-user'; f.complete('project', receipt.dispatchId, 'done')
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].senderId, 'user-A'); assert.equal(f.notifications[0].dispatchId, receipt.dispatchId); assert.match(f.notifications[0].text, /done/)
})

test('cancel preserves inbox and correlates the target terminal event', async t => {
  const f = fixture(t); const agent = f.add(); agent.status = 'running'; f.rows.get('project').events.push({ seq: 1, type: 'turn/start', data: { turn: 1 } })
  const receipt = await f.invoke('session_dispatch', args({ action: 'cancel' })); assert.deepEqual(f.calls[0].args, [{ kind: 'user' }, { keepInbox: true }])
  f.rows.get('project').events.push({ seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }); await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.notifications[0].dispatchId, receipt.dispatchId)
})

test('caller cancellation stops waiting but does not cancel target; dispose unregisters tools and stops notifications', async t => {
  const f = fixture(t); f.add(); f.dispatcher.mount(f.controller); const abort = new AbortController()
  const pending = f.invoke('session_dispatch', args({ mode: 'sync' }), { agent: f.controller, signal: abort.signal })
  await new Promise(resolve => setTimeout(resolve, 5)); abort.abort(); const receipt = await pending; assert.match(receipt.notice, /not cancelled/); assert.equal(f.calls.length, 1)
  await f.dispatcher.dispose(); assert.equal(f.counts().unmounted, 3); assert.equal(f.dispatcher.jobs.size, 0); assert.equal(f.notifications.length, 0)
})

test('reader recognizes claimed dispatch source and ignores old markers', () => {
  const events = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'user/message', data: { source: { dispatchId: 'id' } } }, { seq: 3, type: 'assistant/message', data: { message: text('answer') } }, { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } }]
  assert.equal(dispatchedTurn(events, { dispatchId: 'id', afterSeq: 0, action: 'followup' }).replyText, 'answer')
  assert.deepEqual(dispatchedTurn(events, { dispatchId: 'id', afterSeq: 1, action: 'followup' }), { done: false })
  assert.deepEqual(recentSessionTurns([], 1), { lastReply: '', recentTurns: [], activeTools: [] })
})

test('dispatch silent recovery stays within the matching turn and claimed cursor', () => {
  const events = completedSilentTurn('id')
  const job = { dispatchId: 'id', afterSeq: 0, action: 'followup' }
  assert.deepEqual(dispatchedTurn(events.slice(0, -1), job), { done: false })
  assert.equal(dispatchedTurn(events, job).replyText, 'actual result')
  assert.equal(dispatchedTurn(events, { ...job, claimedTurn: 1, claimedAfterSeq: 4 }).replyText, '[SILENT]')
  assert.deepEqual(dispatchedTurn(events, { ...job, dispatchId: 'other' }), { done: false })
  const unsafe = structuredClone(events)
  unsafe.find(e => e.type === 'assistant/message').data.message.content.push({ type: 'tool-call', name: 'read' })
  assert.equal(dispatchedTurn(unsafe, job).replyText, '[SILENT]')
  const correction = structuredClone(events)
  correction.splice(5, 0, { seq: 5.5, type: 'user/message', data: { source: { kind: 'relay' } } })
  assert.equal(dispatchedTurn(correction, job).replyText, '[SILENT]')
  const failure = structuredClone(events)
  failure.at(-1).data.reason.kind = 'blocked'
  assert.equal(dispatchedTurn(failure, job).replyText, '')
})

for (const mode of ['sync', 'async']) {
  test(`dispatch ${mode} returns recovered same-turn result to the originating source`, async t => {
    const f = fixture(t); f.add()
    const pending = f.invoke('session_dispatch', args({ mode, timeout_ms: 500 }))
    while (f.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const id = f.calls[0].message.source.dispatchId
    f.rows.get('project').events.push(...completedSilentTurn(id))
    const result = await pending
    if (mode === 'sync') {
      assert.equal(result.replyText, 'actual result')
      assert.equal(result.dispatchId, id)
      assert.equal(f.notifications.length, 0)
    } else {
      assert.equal(result.dispatchId, id)
      for (let i = 0; i < 100 && f.notifications.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 2))
      assert.equal(f.notifications.length, 1)
      assert.equal(f.notifications[0].accountId, 'bot-A')
      assert.equal(f.notifications[0].conversationId, 'chat-A')
      assert.equal(f.notifications[0].dispatchId, id)
      assert.match(f.notifications[0].text, /actual result/)
    }
  })
}

test('sender must be both allowed for Weixin and explicitly allowed for dispatch; side/cycle callers denied', async t => {
  const f = fixture(t)
  f.options.sessionDispatcherSenders = []; await assert.rejects(f.invoke('session_list', {}), /not authorized/)
  f.options.sessionDispatcherSenders = ['user-A']; f.options.allowedSenders = ['different']; await assert.rejects(f.invoke('session_list', {}), /not authorized/)
  f.options.allowedSenders = ['user-A']; f.source.isSideSession = true; await assert.rejects(f.invoke('session_list', {}), /Recursive/)
  f.source.isSideSession = false; f.dispatcher.locks.set('controller', 1); await assert.rejects(f.invoke('session_list', {}), /Recursive/)
})

test('queued inbox insertion cannot claim another running turn; missing ids never correlate', () => {
  const events = [{ seq: 1, type: 'turn/start', data: { turn: 3 } }, { seq: 2, type: 'agent/inbox/splice', data: { inserted: [{ source: { dispatchId: 'id' } }] } }, { seq: 3, type: 'user/message', data: text('unrelated') }, { seq: 4, type: 'assistant/message', data: text('unrelated answer') }, { seq: 5, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }]
  assert.deepEqual(dispatchedTurn(events, { dispatchId: 'id', afterSeq: 1, action: 'followup' }), { done: false })
})

test('claimed hook correlates failures before user/message, discarded hook releases admitted work', async t => {
  const f = fixture(t); const agent = f.add(); const first = await f.invoke('session_dispatch', args())
  const message = f.calls[0].message
  f.listeners.get('agent/inbox/claimed')({ agent, message, turn: 42 })
  f.rows.get('project').events.push({ seq: 1, type: 'turn/start', data: { turn: 42 } }, { seq: 2, type: 'turn/end', data: { turn: 42, reason: { kind: 'error' } } })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.notifications[0].dispatchId, first.dispatchId); assert.match(f.notifications[0].text, /error/)
  agent.status = 'idle'; const second = await f.invoke('session_dispatch', args())
  f.listeners.get('agent/inbox/discarded')({ agent, message: f.calls[1].message })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.notifications[1].dispatchId, second.dispatchId); assert.match(f.notifications[1].text, /discarded/)
})

test('intentional steer and cancel remain available while a dispatched followup is running', async t => {
  const f = fixture(t); f.add(); await f.invoke('session_dispatch', args())
  f.rows.get('project').events.push({ seq: 1, type: 'turn/start', data: { turn: 5 } })
  const steered = await f.invoke('session_dispatch', args({ action: 'steer' }))
  const cancelled = await f.invoke('session_dispatch', args({ action: 'cancel' }))
  assert.notEqual(steered.dispatchId, cancelled.dispatchId); assert.deepEqual(f.calls.map(c => c.action), ['followup', 'steer', 'cancel'])
})

test('query reports host event time and only current active tools', () => {
  const result = recentSessionTurns([{ type: 'turn/start' }, { type: 'user/message', time: 1234, data: text('question') }, { type: 'tool/call', data: { callId: 'one', name: 'read' } }, { type: 'tool/result', data: { message: { ...text('result'), source: { callId: 'one' } } } }, { type: 'tool/call', data: { callId: 'two', name: 'write' } }])
  assert.equal(result.recentTurns[0].timestamp, 1234); assert.deepEqual(result.activeTools, ['write'])
})

test('synchronous admission exceptions release locks and permit retry', async t => {
  const f = fixture(t); const agent = f.add(); const original = agent.followup
  agent.followup = () => { throw new Error('admission failed') }
  await assert.rejects(f.invoke('session_dispatch', args()), /admission failed/); assert.equal(f.dispatcher.locks.has('project'), false); assert.equal(f.dispatcher.jobs.size, 0)
  agent.followup = original; assert.equal((await f.invoke('session_dispatch', args())).ok, true)
})

test('synchronous host claimed events are captured before admission returns', async t => {
  const f = fixture(t); const agent = f.add()
  agent.followup = message => {
    f.listeners.get('agent/inbox/claimed')({ agent, message, turn: 9 })
    f.rows.get('project').events.push({ seq: 1, type: 'turn/start', data: { turn: 9 } }, { seq: 2, type: 'turn/end', data: { turn: 9, reason: { kind: 'error' } } })
  }
  const result = await f.invoke('session_dispatch', args({ mode: 'sync', timeout_ms: 100 }))
  assert.equal(result.mode, 'sync'); assert.equal(result.ok, false); assert.match(result.notice, /error/)
})

test('monitor deadline reports uncertainty without cancelling or resubmitting target', async t => {
  const f = fixture(t); f.add(); f.dispatcher.monitorMs = 5
  const result = await f.invoke('session_dispatch', args({ mode: 'sync', timeout_ms: 100 }))
  assert.equal(result.ok, false); assert.match(result.notice, /may still run/); assert.equal(f.calls.length, 1); assert.equal(f.dispatcher.jobs.size, 0)
})

test('target grant defaults deny, hides ungranted metadata and refuses reads/writes before host access', async t => {
  const f = fixture(t, { sessionDispatcherTargets: undefined }); f.add(); f.add('a')
  assert.deepEqual((await f.invoke('session_list', { status: 'all' })).sessions, [])
  let reads = 0; const original = f.host.read; f.host.read = async id => { reads++; return original(id) }
  await assert.rejects(f.invoke('session_query', { session_id: 'project' }), /not authorized/)
  await assert.rejects(f.invoke('session_dispatch', args()), /not authorized/)
  assert.equal(reads, 0); assert.equal(f.calls.length, 0)
  f.options.sessionDispatcherTargets = ['*']
  assert.deepEqual((await f.invoke('session_list', {})).sessions, [])
  await assert.rejects(f.invoke('session_query', { session_id: 'project' }), /not authorized/)
  f.options.sessionDispatcherTargets = ['a']
  assert.deepEqual((await f.invoke('session_list', {})).sessions.map(s => s.sessionId), ['a'])
  assert.equal((await f.invoke('session_query', { session_id: 'a' })).sessionId, 'a')
})

test('revoking target grant during cold restore or final read prevents instruction admission', async t => {
  const f = fixture(t); f.add(); delete f.rows.get('project').agent
  const resume = f.host.resume
  f.host.resume = async id => { const agent = await resume(id); f.options.sessionDispatcherTargets = []; return agent }
  await assert.rejects(f.invoke('session_dispatch', args()), /revoked/)
  assert.deepEqual(f.calls.map(c => c.action), ['resume']); assert.equal(f.dispatcher.locks.has('project'), false)
  f.options.sessionDispatcherTargets = ['project']; const read = f.host.read; let reads = 0
  f.host.read = async id => { const row = await read(id); if (++reads === 2) f.options.sessionDispatcherTargets = []; return row }
  await assert.rejects(f.invoke('session_dispatch', args()), /revoked/); assert.deepEqual(f.calls.map(c => c.action), ['resume'])
})

test('revoked target grant suppresses asynchronous completion notification', async t => {
  const f = fixture(t); f.add(); const receipt = await f.invoke('session_dispatch', args())
  f.options.sessionDispatcherTargets = []; f.complete('project', receipt.dispatchId, 'private target result')
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.notifications.length, 0); assert.equal(f.dispatcher.jobs.size, 0)
})

test('live idle followup refuses pending durable or live inbox work without clearing it', async t => {
  const f = fixture(t); const agent = f.add(); const events = f.rows.get('project').events
  for (const target of ['next-turn', 'next-step']) {
    events.push({ seq: 1, type: 'agent/inbox/spliced', data: { target, start: 0, removedCount: 0, inserted: [{ id: 'queued' }] } })
    await assert.rejects(f.invoke('session_dispatch', args()), /pending input/); assert.equal(events[0].data.inserted.length, 1); events.length = 0
  }
  for (const key of ['nextTurn', 'nextStep']) {
    agent.inbox = { [key]: [{ id: 'queued' }] }
    await assert.rejects(f.invoke('session_dispatch', args()), /pending input/); assert.equal(agent.inbox[key].length, 1)
  }
  assert.equal(f.calls.length, 0)
})

test('steer/cancel never return pre-dispatch or pre-claim assistant text and preserve failure notice', () => {
  const events = [{ seq: 1, type: 'turn/start', data: { turn: 8 } }, { seq: 2, type: 'assistant/message', data: text('old private response') }, { seq: 4, type: 'assistant/message', data: text('before claim') }, { seq: 6, type: 'assistant/message', data: text('partial new response') }, { seq: 7, type: 'turn/end', data: { turn: 8, reason: { kind: 'error' } } }]
  const result = dispatchedTurn(events, { action: 'steer', dispatchId: 'id', afterSeq: 3, claimedTurn: 8, claimedAfterSeq: 5 })
  assert.equal(result.replyText, ''); assert.equal(result.ok, false); assert.match(result.notice, /error/)
  const beforeOnly = events.filter(e => e.seq !== 6)
  assert.equal(dispatchedTurn(beforeOnly, { action: 'steer', afterSeq: 3, claimedTurn: 8, claimedAfterSeq: 5 }).replyText, '')
  assert.equal(dispatchedTurn(events, { action: 'cancel', afterSeq: 3, cancelTurn: 8 }).replyText, '')
})
