import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionHost } from '../src/session-host.js'

// Unit fixtures declare the supported modern contract explicitly. Their
// outcome must not change when an unrelated optional peer is installed.
// test/installed-host-contract.mjs separately checks the actual installed peer.
const modernModule = (extra = {}) => ({
  AgentModel: class { current() {} },
  modelSelectionProjectionDefinition: { key: 'modelSelection', init: () => ({}), apply: state => state },
  installModelSelection: agentCtx => agentCtx.on('fixture/model-notice', () => {}),
  ...extra,
})
function fixture(t, { loadAgentModule = async () => modernModule(), createContext = () => new Context() } = {}) {
  const live = new Map(), snapshots = new Map(), calls = [], disposed = []
  const contexts = []
  const services = {
    agents: {
      get: id => live.get(id), list: () => [...live.values()],
      async resume(options) {
        calls.push(options)
        const snapshot = snapshots.get(options.resumeSessionId)
        const agentCtx = createContext()
        contexts.push(agentCtx)
        const agent = { id: snapshot.session.id, ctx: agentCtx, model: { current: () => undefined }, status: 'idle', session: { id: snapshot.session.id, header: snapshot.session, snapshotEvents: () => snapshot.events } }
        const setup = await options.setup(agentCtx, agent)
        setup?.commit?.()
        live.set(agent.id, agent)
        return { agent, dispose: async () => { disposed.push(agent.id); live.delete(agent.id); await agentCtx.fiber?.dispose() } }
      },
    },
    sessionQuery: { listSessions: () => [...snapshots.values()].map(s => ({ header: s.session, eventCount: s.events.length })), readSession: id => snapshots.get(id) },
    workspaceRegistry: { archivedSessionIds: [] },
    agentPresets: { mount: async (_ctx, preset) => calls.push({ preset }) },
  }
  const add = (id, extra = {}, events = []) => snapshots.set(id, { session: { id, cwd: '/fixture', createdAt: '2026-01-01T00:00:00Z', ...extra }, events })
  const host = new SessionHost({ get: name => services[name] }, { loadAgentModule })
  t.after(async () => { await host.dispose(); await Promise.all(contexts.map(ctx => ctx.fiber?.dispose())) })
  return { live, snapshots, calls, disposed, services, add, contexts, host }
}

test('host lists live and cold metadata without reading or activating cold sessions', async (t) => {
  const f = fixture(t); f.add('cold'); f.add('archived'); f.services.workspaceRegistry.archivedSessionIds.push('archived')
  const header = { id: 'hot', cwd: '/hot' }
  f.live.set('hot', { id: 'hot', status: 'running', session: { header, snapshotEvents: () => [{ type: 'session/title', time: '2026-02-01', data: { title: 'Project' } }] } })
  f.services.sessionQuery.readSession = () => { throw new Error('listing read cold events') }
  const rows = await f.host.list()
  assert.equal(rows.length, 3); assert.equal(rows[0].title, 'Project'); assert.equal(rows[0].status, 'busy')
  assert.equal(rows.find(r => r.sessionId === 'archived').status, 'archived'); assert.equal(f.calls.length, 0)
})

test('host reads archived snapshots but refuses to resume them or subagent sessions', async (t) => {
  const f = fixture(t); f.add('archive'); f.add('child', { origin: 'subagent' }); f.services.workspaceRegistry.archivedSessionIds = new Set(['archive'])
  assert.equal((await f.host.read('archive')).status, 'archived')
  await assert.rejects(f.host.resume('archive'), { code: 'SESSION_ARCHIVED' })
  await assert.rejects(f.host.resume('child'), { code: 'SESSION_SUBAGENT_OWNED' })
  assert.equal(f.calls.length, 0)
})

test('cold resume restores exact identity and latest selected preset, deduplicates concurrent restores, owns only new handles', async (t) => {
  const f = fixture(t); f.add('cold', { agentPreset: 'old' }, [{ type: 'agent-preset/selected', data: { agentPreset: 'saved' } }])
  const [a, b] = await Promise.all([f.host.resume('cold'), f.host.resume('cold')])
  assert.equal(a, b); assert.equal(a.id, 'cold'); assert.equal(f.calls.filter(c => c.resumeSessionId).length, 1)
  assert.deepEqual(f.calls.filter(c => c.preset), [{ preset: 'saved' }]); assert.equal(f.calls[0].resumeSessionId, 'cold')
  assert.equal('cwd' in f.calls[0], false); assert.equal('sessionId' in f.calls[0], false)
  f.live.set('borrowed', { id: 'borrowed', session: { header: { id: 'borrowed' } } }); await f.host.resume('borrowed')
  await f.host.dispose(); assert.deepEqual(f.disposed, ['cold']); assert.ok(f.live.has('borrowed'))
  await assert.rejects(f.host.resume('borrowed'), { code: 'SESSION_HOST_DISPOSED' })
})

test('missing preset capability and malformed saved preset fail before resume', async (t) => {
  const f = fixture(t); f.add('cold', { agentPreset: 'saved' }); delete f.services.agentPresets
  await assert.rejects(f.host.resume('cold'), { code: 'SESSION_PRESET_UNAVAILABLE' }); assert.equal(f.calls.length, 0)
  f.add('bad', {}, [{ type: 'agent-preset/selected', data: { agentPreset: null } }])
  await assert.rejects(f.host.resume('bad'), { code: 'SESSION_PRESET_INVALID' })
})

test('host rejects wrong snapshot identity and wrong resumed identity', async (t) => {
  const f = fixture(t); f.add('cold'); f.snapshots.set('wrong', f.snapshots.get('cold'))
  await assert.rejects(f.host.read('wrong'), { code: 'SESSION_HOST_INCOMPATIBLE' })
  let released = false
  f.services.agents.resume = async () => ({ agent: { id: 'different' }, dispose: () => { released = true } })
  await assert.rejects(f.host.resume('cold'), { code: 'SESSION_HOST_INCOMPATIBLE' }); assert.ok(released)
})

test('host fails closed when discovery/read/resume capabilities are absent', async () => {
  const host = new SessionHost({ get: () => undefined })
  await assert.rejects(host.list(), { code: 'SESSION_DISCOVERY_UNAVAILABLE' })
  await assert.rejects(host.read('cold'), { code: 'SESSION_READ_UNAVAILABLE' })
  await assert.rejects(host.resume('cold'), { code: 'SESSION_RESUME_UNAVAILABLE' })
})

test('a competing host resume is borrowed, never disposed by adapter', async (t) => {
  const f = fixture(t); f.add('cold'); const raced = { id: 'cold', session: { header: { id: 'cold' } } }
  f.services.agents.resume = async () => { f.live.set('cold', raced); throw new Error('already resumed') }
  assert.equal(await f.host.resume('cold'), raced); await f.host.dispose(); assert.deepEqual(f.disposed, [])
})

test('preset/cwd changes during restore are checked under acquired writer ownership', async (t) => {
  const f = fixture(t); f.add('cold', { agentPreset: 'initial' })
  f.services.agents.resume = async options => {
    const agent = { id: 'cold', session: { header: { id: 'cold', cwd: '/changed' }, snapshotEvents: () => [] } }
    await options.setup({}, agent)
    throw new Error('must not reach commit')
  }
  await assert.rejects(f.host.resume('cold'), /cwd changed/); assert.equal(f.calls.length, 0)
})

test('archive change during resume disposes returned handle instead of exposing a writable agent', async (t) => {
  const f = fixture(t); f.add('cold'); let disposed = false
  f.services.agents.resume = async () => {
    f.services.workspaceRegistry.archivedSessionIds.push('cold')
    return { agent: { id: 'cold' }, dispose: () => { disposed = true } }
  }
  await assert.rejects(f.host.resume('cold'), { code: 'SESSION_ARCHIVED' }); assert.ok(disposed)
})

test('shutdown racing an outstanding resume releases the newly created handle', async (t) => {
  const f = fixture(t); f.add('cold'); let release, entered
  const started = new Promise(resolve => { entered = resolve })
  f.services.agents.resume = async () => {
    entered(); await new Promise(resolve => { release = resolve })
    return { agent: { id: 'cold' }, dispose: () => f.disposed.push('cold') }
  }
  const restoring = f.host.resume('cold'); const rejected = assert.rejects(restoring, { code: 'SESSION_HOST_DISPOSED' })
  await started; const shutdown = f.host.dispose(); release(); await Promise.all([rejected, shutdown]); assert.deepEqual(f.disposed, ['cold'])
})

test('cold restore refuses durable queued work without activating or clearing it', async (t) => {
  for (const target of ['next-turn', 'next-step']) {
    const f = fixture(t); const events = [{ type: 'agent/inbox/spliced', data: { target, start: 0, removedCount: 0, inserted: [{ id: 'queued' }] } }]
    f.add('cold', {}, events)
    await assert.rejects(f.host.resume('cold'), { code: 'SESSION_INBOX_PENDING' })
    assert.equal(f.calls.length, 0); assert.equal(events[0].data.inserted.length, 1)
  }
})

test('cold resume rechecks policy after reading and before setup commit', async (t) => {
  const f = fixture(t); f.add('cold'); let authorized = true
  const policy = () => { if (!authorized) throw new Error('grant revoked') }
  const read = f.services.sessionQuery.readSession
  f.services.sessionQuery.readSession = async id => { authorized = false; return read(id) }
  await assert.rejects(f.host.resume('cold', undefined, policy), /grant revoked/); assert.equal(f.calls.length, 0)
  f.services.sessionQuery.readSession = read; authorized = true
  f.services.agents.resume = async options => {
    const snapshot = f.snapshots.get('cold'), agent = { id: 'cold', model: { current: () => undefined }, session: { header: snapshot.session, snapshotEvents: () => snapshot.events } }
    const setup = await options.setup({}, agent); authorized = false; setup.commit()
    throw new Error('must not publish')
  }
  await assert.rejects(f.host.resume('cold', undefined, policy), /grant revoked/); assert.equal(f.live.size, 0)
})

test('modern installer uses a real scoped event context and is cleaned up with the owned agent', async (t) => {
  let installed = 0, notified = 0
  const f = fixture(t, { loadAgentModule: async () => modernModule({ installModelSelection(agentCtx) {
    installed++
    return agentCtx.on('fixture/model-notice', () => notified++)
  } }) })
  f.add('cold')
  const agent = await f.host.resume('cold')
  assert.ok(agent.ctx instanceof Context)
  assert.equal(installed, 1)
  agent.ctx.emit('fixture/model-notice')
  assert.equal(notified, 1)
  await f.host.dispose()
  agent.ctx.emit('fixture/model-notice')
  assert.equal(notified, 1, 'owned scope disposal must remove the hook')
})

test('modern lean context can omit the notice hook without changing saved model events', async (t) => {
  let installed = 0
  const f = fixture(t, { createContext: () => ({}), loadAgentModule: async () => modernModule({
    installModelSelection(_ctx) { installed++ },
  }) })
  const events = [{ type: 'model/selection', data: { provider: 'saved', model: 'model', reasoningEffort: 'high' } }]
  f.add('cold', {}, events)
  const before = structuredClone(events)
  await f.host.resume('cold')
  assert.equal(installed, 0)
  assert.deepEqual(events, before)
})

test('missing, legacy and unknown model contracts refuse cold restore before activation but permit read/live borrowing', async (t) => {
  const missing = Object.assign(new Error("Cannot find package '@deepseek-ai/dsh-agent' imported from fixture"), { code: 'ERR_MODULE_NOT_FOUND' })
  for (const loadAgentModule of [
    async () => { throw missing },
    async () => ({ installModelSelection(_ctx, _selection) { throw new Error('must not install legacy hook') } }),
    async () => modernModule({ installModelSelection(_ctx, _selection) { throw new Error('must not install legacy hook') } }),
    async () => ({}),
  ]) {
    const f = fixture(t, { loadAgentModule }); f.add('cold')
    await assert.rejects(f.host.resume('cold'), { code: 'SESSION_MODEL_RESTORE_UNAVAILABLE' })
    assert.equal(f.calls.length, 0)
    assert.equal(f.host.owned.size, 0)
    assert.equal((await f.host.read('cold')).sessionId, 'cold')
    const live = { id: 'cold', session: { header: f.snapshots.get('cold').session } }
    f.live.set('cold', live)
    assert.equal(await f.host.resume('cold'), live)
  }
})

test('a broken installed package is not treated as an absent optional dependency', async (t) => {
  const failure = Object.assign(new Error("Cannot find package '@deepseek-ai/dsh-llm' imported from installed dsh-agent"), { code: 'ERR_MODULE_NOT_FOUND' })
  const f = fixture(t, { loadAgentModule: async () => { throw failure } }); f.add('cold')
  await assert.rejects(f.host.resume('cold'), error => error === failure)
  assert.equal(f.calls.length, 0)
})

test('installer failures abort unpublished restore instead of being swallowed', async (t) => {
  const failure = new Error('synthetic installer failure')
  const f = fixture(t, { loadAgentModule: async () => modernModule({ installModelSelection(_ctx) { throw failure } }) }); f.add('cold')
  await assert.rejects(f.host.resume('cold'), error => error.code === 'SESSION_RESUME_FAILED' && error.cause === failure)
  assert.equal(f.live.size, 0)
  assert.equal(f.host.owned.size, 0)
})

test('cold setup rejects a resumed agent without the advertised durable model reader', async (t) => {
  const f = fixture(t); f.add('cold')
  f.services.agents.resume = async options => {
    const snapshot = f.snapshots.get('cold')
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await options.setup(ctx, { session: { header: snapshot.session, snapshotEvents: () => snapshot.events } })
    throw new Error('must not publish')
  }
  await assert.rejects(f.host.resume('cold'), /no durable model-selection reader/)
  assert.equal(f.live.size, 0)
})
