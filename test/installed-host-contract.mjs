// Explicit dependency lane: run with npm run test:host-contract. Unlike the
// isolated unit fixtures, this imports the actual installed DSH peer. A missing
// peer is an error, not a skipped compatibility check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as agentModule from '@deepseek-ai/dsh-agent'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionHost } from '../src/session-host.js'

test('installed host tool results expose the call ID used by the session reader', () => {
  const message = createToolResultMessage({ callId: 'call-1', content: [{ type: 'text', text: 'done' }], isError: false })
  assert.equal(message.source?.callId, 'call-1')
})

const modern = typeof agentModule.AgentModel?.prototype?.current === 'function'
  && agentModule.modelSelectionProjectionDefinition?.key === 'modelSelection'
  && typeof agentModule.modelSelectionProjectionDefinition?.init === 'function'
  && typeof agentModule.modelSelectionProjectionDefinition?.apply === 'function'
  && !(typeof agentModule.installModelSelection === 'function' && agentModule.installModelSelection.length > 1)
const saved = { provider: 'saved-provider', model: 'saved-model', reasoningEffort: 'high' }
const fallback = { provider: 'different-default', model: 'different-model' }

function fixture(t, events = []) {
  const ctx = new Context(), live = new Map()
  const header = { id: 'installed-host-fixture', cwd: '/synthetic-project' }
  const snapshot = { session: header, events }
  let resumeCalls = 0
  const session = {
    id: header.id, header, snapshotEvents: () => events,
    requestHeader: () => events.findLast(event => event.type === 'request/header')?.data.header,
  }
  const services = {
    agents: {
      get: id => live.get(id),
      async resume(options) {
        resumeCalls++
        const projection = agentModule.modelSelectionProjectionDefinition
        const state = events.reduce((state, event) => projection.apply(state, event), projection.init())
        const agent = { id: header.id, ctx, session, model: new agentModule.AgentModel(() => state, session, options.agentOptions) }
        const setup = await options.setup(ctx, agent)
        setup.commit()
        live.set(header.id, agent)
        return { agent, dispose: async () => { live.delete(header.id); await ctx.fiber.dispose() } }
      },
    },
    sessionQuery: { readSession: () => snapshot },
    agentDefaultModel: { currentSelection: () => fallback },
  }
  const host = new SessionHost({ get: name => services[name] })
  t.after(async () => { await host.dispose(); await ctx.fiber.dispose() })
  return { host, ctx, header, session, live, resumeCalls: () => resumeCalls }
}

if (!modern) {
  test('actual installed legacy peer is refused before cold activation; reads and live borrowing remain available', async (t) => {
    const f = fixture(t)
    assert.equal((await f.host.read(f.header.id)).sessionId, f.header.id)
    await assert.rejects(f.host.resume(f.header.id), { code: 'SESSION_MODEL_RESTORE_UNAVAILABLE' })
    assert.equal(f.resumeCalls(), 0)
    const live = { id: f.header.id, session: f.session }
    f.live.set(f.header.id, live)
    assert.equal(await f.host.resume(f.header.id), live)
    await f.host.dispose()
    assert.equal(f.live.get(f.header.id), live)
    t.diagnostic('This lane verified safe legacy refusal, not successful modern cold restoration or a real Windows host.')
  })
} else {
  for (const [name, events, expected] of [
    ['pending choice overrides last request and global defaults', [
      { type: 'request/header', data: { header: { config: fallback } } },
      { type: 'model/selection', data: saved },
    ], saved],
    ['recorded explicit effort is preserved', [
      { type: 'request/header', data: { header: { config: saved } } },
    ], saved],
    ['adapter-defaulted effort is not pinned', [
      { type: 'request/header', data: { header: { config: saved, adapterDefaults: { reasoningEffort: true } } } },
    ], { provider: saved.provider, model: saved.model }],
  ]) {
    test(`actual modern AgentModel cold reconstruction: ${name}`, async (t) => {
      const f = fixture(t, events)
      const before = structuredClone(events)
      const agent = await f.host.resume(f.header.id)
      assert.deepEqual(agent.model.current(), expected)
      assert.deepEqual(events, before)
      assert.equal(f.resumeCalls(), 1)
      if (typeof agentModule.installModelSelection === 'function') {
        const input = { id: 'synthetic-input', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }
        const step = { turn: 1, step: 1, messages: [input], signal: new AbortController().signal, modelSelection: expected }
        const decision = await agentModule.agentEvents(f.ctx, agent).waterfall('agent/pre-step', step,
          async () => ({ kind: 'enter', messages: [input], startsRequestSeries: true }))
        assert.equal(decision.messages[0], input)
        assert.equal(decision.startsRequestSeries, true)
        const previous = f.session.requestHeader()?.config
        const switched = previous && (previous.provider !== expected.provider || previous.model !== expected.model)
        assert.equal(decision.messages.length, switched ? 2 : 1)
        if (switched) assert.equal(decision.messages[1].source.kind, 'model-selection')
        assert.deepEqual(agent.model.current(), expected, 'notice hook must not overwrite the restored route')
      }
    })
  }
}
