/**
 * Optional DSH host adapter for parallel-session discovery and restoration.
 * Contracts checked against deepseek-ai/deepseek-harness commit
 * 8bd073392eef6f54e921a093b95076248eb08cbb (core/agent, session-query,
 * session-title, workspace, and api/session-controller/src/agent.ts).
 * Read operations never activate an Agent. Resume never creates, clears an
 * inbox, changes a cwd, or unarchives a Session. Host-owned live Agents are
 * borrowed; only handles created by this adapter may be disposed by it.
 * Resumed handles belong to this plugin's Cordis fiber: plugin shutdown can
 * stop their active work. Borrowed, already-live desktop Agents are unaffected.
 */

function failure(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function latestTitle(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/title' && typeof events[i].data?.title === 'string') {
      return events[i].data.title
    }
  }
}

function savedPreset(header, events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'agent-preset/selected') {
      const value = events[i].data?.agentPreset
      if (typeof value !== 'string' || value.length === 0) {
        throw failure('SESSION_PRESET_INVALID', 'The saved session preset is invalid; resume was refused.')
      }
      return value
    }
  }
  return header?.agentPreset
}

/** Fold current durable inbox splices without reading or mutating private host state. */
export function assertNoPendingInbox(events, inbox) {
  const sizes = { 'next-turn': 0, 'next-step': 0 }
  for (const event of events) {
    if (event?.type !== 'agent/inbox/spliced') continue
    const data = event.data
    const size = sizes[data?.target]
    const removed = data?.removedCount ?? 0
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(data.start) || data.start < 0 || data.start > size
      || !Number.isSafeInteger(removed) || removed < 0 || data.start + removed > size || !Array.isArray(data.inserted)) {
      throw failure('SESSION_INBOX_INVALID', 'Cannot safely reconstruct the target inbox; resume was refused.')
    }
    sizes[data.target] = size - removed + data.inserted.length
  }
  if (sizes['next-turn'] || sizes['next-step'] || inbox?.nextTurn?.length || inbox?.nextStep?.length) {
    throw failure('SESSION_INBOX_PENDING', 'The target has pending input. Resolve it in DSH before dispatching; no queued work was cleared or started.')
  }
}

/** Metadata strings remain exact internally so security/path checks are lossless. */
export class SessionHost {
  constructor(ctx, { loadAgentModule = () => import('@deepseek-ai/dsh-agent') } = {}) {
    this.ctx = ctx
    this.loadAgentModule = loadAgentModule
    this.resumes = new Map()
    this.owned = new Map()
    this.disposed = false
  }

  service(name) {
    return this.ctx?.get?.(name)
  }

  isArchived(sessionId) {
    const archived = this.service('workspaceRegistry')?.archivedSessionIds
    return Array.isArray(archived) ? archived.includes(sessionId) : archived instanceof Set && archived.has(sessionId)
  }

  assertWritable(sessionId, header) {
    if (this.disposed) throw failure('SESSION_HOST_DISPOSED', 'The session dispatcher has stopped.')
    if (this.isArchived(sessionId)) throw failure('SESSION_ARCHIVED', 'Archived sessions are read-only; unarchive it in DSH first.')
    if (header?.origin === 'subagent') {
      throw failure('SESSION_SUBAGENT_OWNED', 'This session belongs to subagent routing; use the host subagent tools instead.')
    }
  }

  metadata(header, agent, events, title, eventCount) {
    const sessionId = header?.id ?? agent?.id ?? agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw failure('SESSION_HOST_INCOMPATIBLE', 'The host returned a session without an identity.')
    }
    let lastUpdatedMs = timestamp(header?.createdAt)
    if (events) for (const event of events) lastUpdatedMs = Math.max(lastUpdatedMs, timestamp(event?.time))
    return {
      sessionId,
      title: title || (events && latestTitle(events)) || sessionId,
      cwd: typeof header?.cwd === 'string' ? header.cwd : '',
      status: this.isArchived(sessionId) ? 'archived' : agent?.status === 'running' ? 'busy' : 'idle',
      lastUpdatedMs,
      ...(events ? { totalEvents: events.length } : Number.isSafeInteger(eventCount) ? { totalEvents: eventCount } : {}),
      live: Boolean(agent),
      header: header ?? { id: sessionId },
    }
  }

  /**
   * List live and discoverable persisted identities. Cold event counts are
   * optional; cold lastUpdatedMs is creation time unless a title snapshot is
   * available. Missing query/persistence capability means live-only results.
   */
  async list(signal) {
    signal?.throwIfAborted()
    const agents = this.service('agents')
    const query = this.service('sessionQuery')
    const persistence = this.service('sessionPersistence')
    const live = typeof agents?.list === 'function' ? await agents.list() : []
    let persisted = []
    if (typeof query?.listSessions === 'function') persisted = await query.listSessions(signal)
    else if (typeof persistence?.list === 'function') persisted = await persistence.list(signal ? { signal } : undefined)
    else if (typeof agents?.list !== 'function') {
      throw failure('SESSION_DISCOVERY_UNAVAILABLE', 'This DSH host cannot enumerate sessions; update or enable its agents/sessionQuery services.')
    }
    if (!Array.isArray(live) || !Array.isArray(persisted)) {
      throw failure('SESSION_HOST_INCOMPATIBLE', 'The host session listing has an unsupported shape.')
    }
    signal?.throwIfAborted()
    const rows = new Map()
    for (const item of persisted) {
      if (typeof item?.header?.id === 'string') rows.set(item.header.id, { header: item.header, eventCount: item.eventCount })
    }
    for (const agent of live) {
      const header = agent?.session?.header ?? { id: agent?.id ?? agent?.session?.id }
      if (typeof header.id === 'string') rows.set(header.id, { ...rows.get(header.id), header, agent })
    }
    const result = []
    // Do not read cold transcripts merely to list metadata. readTitle is the
    // host's read-only title projection API; unavailable titles fall back to id.
    for (const row of rows.values()) {
      signal?.throwIfAborted()
      const events = row.agent?.session?.snapshotEvents?.()
      let title
      try {
        title = row.agent
          ? this.service('sessionTitle')?.get?.(row.agent.session)
          : await query?.readTitle?.(row.header.id, signal)
      } catch {
        signal?.throwIfAborted()
        // A single unavailable title must not conceal the discoverable session.
      }
      signal?.throwIfAborted()
      const meta = this.metadata(row.header, row.agent, Array.isArray(events) ? events : undefined, title?.title, row.eventCount)
      meta.lastUpdatedMs = Math.max(meta.lastUpdatedMs, timestamp(title?.updatedAt))
      result.push(meta)
    }
    return result.sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs || a.sessionId.localeCompare(b.sessionId))
  }

  /** Read the full event snapshot internally; callers must bound tool output. */
  async read(sessionId, signal) {
    signal?.throwIfAborted()
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw failure('SESSION_ID_INVALID', 'A session id is required.')
    const agent = this.service('agents')?.get?.(sessionId)
    const session = agent?.session ?? this.service('sessions')?.get?.(sessionId)
    let header, events
    if (typeof session?.snapshotEvents === 'function') {
      header = session.header ?? { id: session.id ?? sessionId }
      events = session.snapshotEvents()
    } else {
      const query = this.service('sessionQuery')
      if (typeof query?.readSession !== 'function') {
        throw failure('SESSION_READ_UNAVAILABLE', 'This session is not live and the host has no sessionQuery.readSession service.')
      }
      const snapshot = await query.readSession(sessionId)
      // readSession has no cancellation parameter on this supported host.
      // Observe cancellation immediately after its owned read settles.
      signal?.throwIfAborted()
      header = snapshot?.session
      events = snapshot?.events
    }
    if (header?.id !== sessionId || !Array.isArray(events)) {
      throw failure('SESSION_HOST_INCOMPATIBLE', 'The host returned an invalid session snapshot.')
    }
    return { ...this.metadata(header, agent, events), events, ...(agent ? { agent } : {}) }
  }

  /**
   * Restore only the recorded identity and preset; failures never create a replacement.
   * assertPolicy, when supplied, is a synchronous throwing authorization check
   * receiving current metadata. It is also run at the host's setup commit.
   */
  async resume(sessionId, signal, assertPolicy) {
    signal?.throwIfAborted()
    this.assertWritable(sessionId)
    const agents = this.service('agents')
    const live = agents?.get?.(sessionId)
    if (live) {
      this.assertWritable(sessionId, live.session?.header)
      assertPolicy?.(this.metadata(live.session?.header, live))
      return live
    }
    if (typeof agents?.resume !== 'function') throw failure('SESSION_RESUME_UNAVAILABLE', 'This DSH host cannot resume persisted sessions.')
    if (this.resumes.has(sessionId)) {
      const agent = await this.resumes.get(sessionId)
      signal?.throwIfAborted()
      assertPolicy?.(this.metadata(agent.session?.header, agent))
      return agent
    }
    const pending = this.restore(sessionId, agents, signal, assertPolicy)
    this.resumes.set(sessionId, pending)
    try { return await pending } finally { this.resumes.delete(sessionId) }
  }

  async restore(sessionId, agents, signal, assertPolicy) {
    const observed = await this.read(sessionId, signal)
    this.assertWritable(sessionId, observed.header)
    assertPolicy?.(observed)
    assertNoPendingInbox(observed.events)
    const presets = this.service('agentPresets')
    const presetId = savedPreset(observed.header, observed.events)
    if (presetId !== undefined && typeof presets?.mount !== 'function') {
      throw failure('SESSION_PRESET_UNAVAILABLE', `The saved preset "${presetId}" cannot be restored by this host.`)
    }
    // Cold resume needs the modern durable-model contract, not merely a
    // same-named installer: rc.6's two-argument helper controls routing through
    // an entry-point-owned mutable ref and cannot restore saved choices here.
    let agentModule
    try { agentModule = await this.loadAgentModule() } catch (error) {
      // Package absence leaves reads/live borrowing available, not cold resume. A
      // broken installed package (including a missing transitive dependency)
      // must not masquerade as an older host without the notice hook.
      const missingOptionalPackage = (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND')
        && /Cannot find (?:package|module) ['"]@deepseek-ai\/dsh-agent['"]/.test(error.message)
      if (!missingOptionalPackage) throw error
      throw failure('SESSION_MODEL_RESTORE_UNAVAILABLE', 'Cold session restore requires a DSH host with durable model selection. Update the host or open this session in DSH first; live sessions can still be used.', error)
    }
    const { AgentModel, modelSelectionProjectionDefinition, installModelSelection } = agentModule ?? {}
    if (typeof AgentModel?.prototype?.current !== 'function'
      || modelSelectionProjectionDefinition?.key !== 'modelSelection'
      || typeof modelSelectionProjectionDefinition?.init !== 'function'
      || typeof modelSelectionProjectionDefinition?.apply !== 'function'
      || (typeof installModelSelection === 'function' && installModelSelection.length > 1)) {
      throw failure('SESSION_MODEL_RESTORE_UNAVAILABLE', 'This DSH host lacks the supported durable model-selection API. Cold restore was refused to preserve the saved model; update the host or open this session in DSH first.')
    }
    signal?.throwIfAborted()
    assertPolicy?.(observed)
    const defaults = this.service('agentDefaultModel')
    const route = defaults?.currentSelection?.()
    const setup = async (agentCtx, agent) => {
      signal?.throwIfAborted()
      this.assertWritable(sessionId, agent?.session?.header ?? observed.header)
      // Inspect under acquired writer ownership too, avoiding a stale preset
      // if the desktop changed the session between read and resume.
      const actualHeader = agent?.session?.header ?? observed.header
      const actualEvents = agent?.session?.snapshotEvents?.() ?? observed.events
      assertPolicy?.(this.metadata(actualHeader, agent, actualEvents))
      assertNoPendingInbox(actualEvents, agent?.inbox)
      if (actualHeader.cwd !== observed.header.cwd) throw failure('SESSION_CWD_CHANGED', 'The target session cwd changed during resume.')
      const actualPreset = savedPreset(actualHeader, actualEvents)
      if (actualPreset !== undefined && typeof presets?.mount !== 'function') {
        throw failure('SESSION_PRESET_UNAVAILABLE', 'The target session preset cannot be restored.')
      }
      if (typeof agent?.model?.current !== 'function') {
        throw failure('SESSION_HOST_INCOMPATIBLE', 'The resumed agent has no durable model-selection reader; restore was refused.')
      }
      // On the supported host this optional hook adds model-switch notices;
      // the loop's AgentModel restores the saved route independently. A lean
      // context without event hooks can omit the notice, not replace the route.
      if (typeof installModelSelection === 'function' && typeof agentCtx?.on === 'function') {
        installModelSelection(agentCtx)
      }
      if (actualPreset !== undefined) await presets.mount(agentCtx, actualPreset)
      signal?.throwIfAborted()
      assertPolicy?.(this.metadata(actualHeader, agent, actualEvents))
      return { commit: () => {
        signal?.throwIfAborted()
        this.assertWritable(sessionId, actualHeader)
        const committedEvents = agent?.session?.snapshotEvents?.() ?? actualEvents
        assertPolicy?.(this.metadata(actualHeader, agent, committedEvents))
        assertNoPendingInbox(committedEvents, agent?.inbox)
      } }
    }
    signal?.throwIfAborted()
    this.assertWritable(sessionId, observed.header)
    assertPolicy?.(observed)
    let handle
    try {
      handle = await agents.resume({ resumeSessionId: sessionId, setup, ...(signal ? { signal } : {}), ...(route?.provider && route?.model ? { agentOptions: { ...route } } : {}) })
    } catch (error) {
      signal?.throwIfAborted()
      // A competing desktop resume may have won. Borrow only its exact identity.
      const raced = agents.get?.(sessionId)
      if (!raced) throw failure('SESSION_RESUME_FAILED', `Unable to resume session "${sessionId}": ${error?.message ?? error}`, error)
      this.assertWritable(sessionId, raced.session?.header)
      assertPolicy?.(this.metadata(raced.session?.header, raced))
      return raced
    }
    if (!handle?.agent || (handle.agent.id ?? handle.agent.session?.id) !== sessionId) {
      await handle?.dispose?.()
      throw failure('SESSION_HOST_INCOMPATIBLE', 'The host resumed a different session identity.')
    }
    if (this.disposed || this.isArchived(sessionId)) {
      await handle.dispose?.()
      this.assertWritable(sessionId)
    }
    this.owned.set(sessionId, handle)
    // A successful factory publication has detached the creation signal; keep
    // ownership for shutdown even if the caller stopped waiting at this point.
    signal?.throwIfAborted()
    assertPolicy?.(this.metadata(handle.agent.session?.header, handle.agent))
    return handle.agent
  }

  /** Release only adapters' own resumed handles on plugin shutdown. */
  async dispose() {
    this.disposed = true
    await Promise.allSettled([...this.resumes.values()])
    const handles = [...this.owned.values()]
    this.owned.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose?.()))
  }
}
