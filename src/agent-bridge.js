/**
 * Bind one Weixin conversation to one DSH agent session.
 *
 * The pattern is the one dsh-better-sidebar's sidechat proves works
 * (`src/sidechat-routes.ts`): create an agent through the `agents` service with
 * a chosen session id, admit each user message with `agent.followup(...)`, and
 * read the reply out of `agent.session.snapshotEvents()`.
 *
 * Differences from sidechat, and why:
 *  - No seed and no parent session. A WeChat conversation is a top-level
 *    conversation, not a fork of a GUI thread, so it needs neither
 *    `isSeeded`/`inheritedEventCount` fork markers nor the inbox `clear()` that
 *    fences the inherited-inbox replay leak sidechat works around.
 *  - Preset composition is applied through `agentPresets.resolve/mount` when the
 *    service is present, so the conversation inherits the deployment's tools and
 *    system prompt the same way a GUI thread does.
 *  - Sessions are durable across plugin restarts: the id is derived from the
 *    Weixin conversation id, so a cold start resumes the recorded session
 *    instead of opening a fresh one.
 * @module dsh-weixin/agent-bridge
 */
import { readAssistantReply, readSettledTurns, describePending } from './session-reader.js'
import { CATALOG } from './i18n.js'
import { redactSecrets } from './credentials.js'
import { assertNoPendingInbox } from './session-host.js'
import { SessionDispatcher } from './session-dispatcher.js'
import { baseSessionIdFor, scopedLineKey, SessionLines, parseSessionCommand, runSessionCommand } from './sessions.js'

const NO_RUNNING_REPLY = '现在没有正在处理的回复，不需要停止。'

function terminalNotice(reason) {
  if (reason === 'aborted') return CATALOG['turn.aborted'].zh
  if (reason === 'blocked') return CATALOG['turn.blocked'].zh
  if (reason === 'error') return CATALOG['turn.error'].zh
  return CATALOG['turn.unknown'].zh
}

function logTurnError(errLog, sessionId, reply) {
  const code = redactSecrets(reply.turnErrorCode ?? 'unknown')
  const reason = redactSecrets(reply.turnError ?? 'unknown error')
  errLog(`turn/end error session=${sessionId} seq=${reply.settledSeq} code=${JSON.stringify(code)} reason=${JSON.stringify(reason)}`)
}

/**
 * `@deepseek-ai/dsh-llm` resolves only from inside a DSH profile, so it is
 * imported lazily: the module itself stays loadable (and testable) outside the
 * host, and a missing service surfaces as a delivery error rather than a
 * plugin-load failure.
 */
let createUserMessageRef = null
async function loadCreateUserMessage() {
  if (createUserMessageRef === null) {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage !== 'function') {
      throw new Error('@deepseek-ai/dsh-llm does not export createUserMessage')
    }
    createUserMessageRef = mod.createUserMessage
  }
  return createUserMessageRef
}

/**
 * Load `installModelSelection`, which couples a mutable provider/model choice to
 * prompt assembly and request routing.
 *
 * Without it an agent created through `agents.create` has no selected route, so
 * the persona section's `{{model}}` reference never resolves. Returns undefined
 * (instead of throwing) when the host exposes a different surface, so a version
 * skew degrades the persona rather than killing the plugin.
 */
let installModelSelectionRef
async function loadInstallModelSelection() {
  if (installModelSelectionRef === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-agent')
      installModelSelectionRef =
        typeof mod.installModelSelection === 'function' ? mod.installModelSelection : null
    } catch {
      installModelSelectionRef = null
    }
  }
  return installModelSelectionRef ?? undefined
}

/**
 * Deterministic session id for a Weixin conversation.
 *
 * Stable across restarts so the conversation survives a plugin reload, and
 * prefixed so a session can be recognized as Weixin-owned in the GUI.
 * The source account and original conversation id are hashed together so
 * the id is filesystem-safe without folding distinct conversations together.
 *
 * This is now the id of a conversation's FIRST session line; see
 * `src/sessions.js` for how a conversation can have several.
 * @param {string} conversationId
 * @param {string} [accountId]
 */
export function sessionIdFor(conversationId, accountId) {
  return baseSessionIdFor(conversationId, accountId)
}

/**
 * @typedef {Object} AgentBridgeOptions
 * @property {any} ctx            Cordis context of the plugin.
 * @property {string} [cwd]       Working directory the agent operates in.
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [errLog]
 * @property {number} [createTimeoutMs]
 * @property {number} [progressAfterMs]  Send the first progress line after this long.
 * @property {number} [progressEveryMs]  Re-send a CHANGED progress line at most
 *   this often, so a turn that moves from one tool to the next stays visible
 *   without spamming an unchanged state.
 * @property {number} [maxWaitMs]        Give up on a turn after this long.
 * @property {number} [pollMs]           Session-log polling interval.
 * @property {SessionLines} [lines]      Session-line index. Defaults to the
 *   on-disk store, so a bridge built without one still supports `/new`.
 */

export class AgentBridge {
  #spontaneousTimer

  /** @param {AgentBridgeOptions} options */
  constructor(options) {
    this.ctx = options.ctx
    this.shutdown = new AbortController()
    this.cwd = options.cwd
    this.log = options.log ?? (() => {})
    this.errLog = options.errLog ?? options.log ?? (() => {})
    this.createTimeoutMs = options.createTimeoutMs ?? 30_000
    this.progressAfterMs = options.progressAfterMs ?? 45_000
    this.progressEveryMs = options.progressEveryMs ?? 60_000
    // C16: a turn that is visibly running a tool is worth reporting sooner than
    // one that is only thinking - the user can see the difference in what they
    // asked for, and 45s of silence during `npm test` reads as a dead bot.
    this.progressToolAfterMs = options.progressToolAfterMs ?? 8_000
    this.maxWaitMs = options.maxWaitMs ?? 20 * 60_000
    this.pollMs = options.pollMs ?? 1_000
    // The session event log is an in-memory snapshot; polling it is how a turn
    // becomes visible. 1000ms is the observable-for-humans cadence, but a
    // caller that only wants the answer (the tests, and any host callback that
    // re-reads events) can ask for a tighter loop.
    this.eventPollMs = Number.isFinite(options.eventPollMs) && options.eventPollMs > 0 ? options.eventPollMs : this.pollMs
    // The host never pushes: the only way to learn a turn produced an answer is
    // to look at its event snapshot. At the steady 1000ms cadence that means a
    // reply that landed 5ms after a poll waits almost a second — on every single
    // message. So the first moments of a turn are polled tightly and the loop
    // relaxes to `eventPollMs` after that: an answer typically arrives in a few
    // hundred ms, while a long tool run costs the same few snapshots as before.
    this.eventPollFastMs = Number.isFinite(options.eventPollFastMs) && options.eventPollFastMs > 0
      ? Math.min(options.eventPollFastMs, this.eventPollMs)
      : Math.min(50, this.eventPollMs)
    this.eventPollFastWindowMs = Number.isFinite(options.eventPollFastWindowMs) && options.eventPollFastWindowMs >= 0
      ? options.eventPollFastWindowMs
      : 400
    // Session lines: which of a conversation's sessions the next message goes
    // to. Injectable so tests do not touch the operator's real state root.
    this.lines = options.lines ?? new SessionLines({ warn: (message) => this.errLog(message) })
    this.onSpontaneousReply = options.onSpontaneousReply
    this.spontaneousPollMs =
      Number.isFinite(options.spontaneousPollMs) && options.spontaneousPollMs > 0
        ? options.spontaneousPollMs
        : 1_500
    // Conversation id -> the session id its next message must reach. Needed
    // because `deliver` is handed a session id but must still be able to route
    // a late reply and, for a brand-new line, share one in-flight creation.
    /** @type {Map<string, string>} */
    this.conversationTargets = new Map()
    // How long the post-timeout listener keeps waiting for an answer to hand
    // to onLateReply. Configurable so tests do not have to wait an hour.
    this.lateReplyMaxWaitMs = options.lateReplyMaxWaitMs ?? 60 * 60_000
    /** @type {Map<string, { agent: any, dispose: () => Promise<void>, busy: boolean, queue: any[], cancelled: boolean }>} */
    this.sessions = new Map()
    this.sessionDispatcher = new SessionDispatcher({
      ctx: this.ctx,
      config: options.sessionDispatcherConfig,
      sourceFor: (agent) => {
        const record = this.sessions.get(agent?.session?.id)
        if (!record || record.agent !== agent) return undefined
        return { accountId: record.accountId, conversationId: record.conversationId,
          senderId: record.turnSource?.senderId, isSideSession: record.dispatchSenderMixed === true }
      },
      notify: options.onDispatchReply,
      warn: this.errLog,
    })
    /**
     * In-flight attach() creations, so two messages for the same conversation
     * never build two sessions.
     * @type {Map<string, Promise<{ agent: any, dispose: () => Promise<void>, busy: boolean, queue: any[], cancelled: boolean }>>}
     */
    this.attachPromises = new Map()
    /**
     * Memoized Workspace lookup, so the registry is consulted once per plugin
     * generation rather than on every message.
     * @type {Promise<any> | undefined}
     */
    this.workspacePromise = undefined
    this.#spontaneousTimer = setInterval(() => {
      void this.#pollSpontaneous()
    }, this.spontaneousPollMs)
    this.#spontaneousTimer.unref?.()
  }

  #agents() {
    return this.ctx.get('agents')
  }

  /**
   * The session id a conversation's next message must reach.
   *
   * Remembers the target so {@link deliver} — which receives a session id, not
   * a conversation id — can still map back to the conversation for a late reply
   * and for the first-message title.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string}
   */
  #activeSessionId(conversationId, accountId) {
    const key = scopedLineKey(accountId, conversationId)
    const sessionId = this.lines.active(conversationId, accountId)
    this.conversationTargets.set(key, sessionId)
    return sessionId
  }

  /**
   * Handle a session-control command (`/new`, `/list`, `/use`).
   *
   * Returns the reply text when the message was a command, or undefined when it
   * was an ordinary message that must go to the agent. The caller sends the
   * returned text directly, so a control command costs no model turn and no
   * context: it is answered by the plugin itself.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @param {string} text
   * @param {{ accountId?: string, accountLabel?: string | null, paused?: boolean,
   *   lastSeenAt?: string, allowlist?: { source: 'account' | 'global', senders: string[] } }} [statusContext]
   *   account-level facts for `/status`, threaded from the inbound handler
   * @returns {string | undefined}
   */
  handleCommand(conversationId, text, accountId, statusContext) {
    // 命令回复以前是一条字符串，调用方 await 之后就能发出去。现在有了一条会
    // 回 undefined 的命令（待答问题不在了，`/是` 应当当作普通聊天），此时
    // bridge 仍然会执行完清理，只是必须让调用方知道「没有回复」而不是把
    // undefined 当作命令结果吞掉（那会让这句本该进会话的话彻底消失）。
    // Capture the target BEFORE the command runs: `/clear` replaces the line,
    // and the id to orphan is the one that was active up to now.
    const key = scopedLineKey(accountId, conversationId)
    const clearedSessions = parseSessionCommand(text)?.command === 'clear'
      ? this.lines.list(conversationId, accountId).map(line => line.sessionId) : []
    // `/cancel` needs the live agent handle, which only this class holds; the
    // command module stays transport-free and just relays the sentence.
    const reply = runSessionCommand(this.lines, conversationId, text, accountId, {
      ...statusContext,
      cancelRunningTurn: () => this.#cancelRunningTurn(key, conversationId, accountId),
      compactSession: (arg) => this.#compactSession(conversationId, accountId, arg),
    })
    // `undefined` means the command existed but had nothing to say (`/是` with no
    // pending question): the caller must treat the message as ordinary chat.
    if (reply === undefined) return undefined
    // Some command handlers return a promise.
    if (reply instanceof Promise) return reply
    // `/clear` orphans the line that was active: its session id is no longer
    // in the list and the fresh line has a different id, so the old in-memory
    // record must not keep answering (a queued message would otherwise reach a
    // session the user believes is gone). Disposal is best-effort; the host
    // transcript stays on disk as an orphan, untouched.
    for (const sessionId of clearedSessions) {
      const record = this.sessions.get(sessionId)
      if (record !== undefined) {
        this.sessions.delete(sessionId)
        record.unconfirmed?.offClaim?.()
        record.unconfirmed?.offDiscard?.()
        void Promise.resolve()
          .then(() => record.dispose())
          .catch((error) => this.errLog(`cleared session dispose failed: ${String(error)}`))
      }
    }
    // A command can change which line is active, so the next message must not
    // reuse a mapping taken before it ran.
    this.conversationTargets.delete(key)
    this.log?.(`session command handled for ${conversationId}: ${String(text).trim()}`)
    return reply
  }

  /**
   * Interrupt the turn running on a conversation's active line.
   *
   * `/cancel` is answered as a command precisely because it has to work WHILE
   * the conversation is busy — an ordinary message would be queued behind the
   * turn the user wants to stop. The host owns the actual abort
   * (`agent.cancel({ kind: 'user' })`), so this method only decides whether
   * there is something to interrupt and translates the outcome into one
   * sentence the user can act on.
   *
   * @param {string} key scoped conversation key (account + conversation)
   * @param {string} conversationId
   * @param {string} [accountId]
   * @returns {string} the reply text sent back to WeChat
   */
  #cancelRunningTurn(key, conversationId, accountId) {
    const sessionId = this.conversationTargets.get(key) ?? this.lines.active(conversationId, accountId)
    const record = sessionId === undefined ? undefined : this.sessions.get(sessionId)
    if (record === undefined) return NO_RUNNING_REPLY
    const agent = record.agent
    if (record.busy !== true && !(record.unconfirmed && agent?.status === 'running')) return NO_RUNNING_REPLY
    if (typeof agent?.cancel !== 'function') {
      // An older host without cancel() would otherwise look like success while
      // the turn keeps running — say so instead of lying.
      return '当前 DSH 版本不支持停止正在处理的回复；这次只能等它完成。'
    }
    try {
      // Marked BEFORE the call: the turn's own wait loop polls this flag and
      // must not race the abort into reporting a model failure.
      if (record.busy) record.cancelled = true
      agent.cancel({ kind: 'user' })
      if (!record.busy && record.unconfirmed?.messageId) {
        record.suppressedInputs ??= new Map()
        record.suppressedInputs.set(record.unconfirmed.messageId, record.unconfirmed)
      }
    } catch (error) {
      record.cancelled = false
      this.errLog(`cancel failed for ${sessionId}: ${String(error)}`)
      return '没能发出停止请求；当前回复可能仍在继续。详细信息已写入日志。'
    }
    this.log?.(`requested cancellation of the running turn on ${sessionId} for ${conversationId}`)
    return '已发出停止请求；已经开始的操作不会回滚。'
  }

  async #compactSession(conversationId, accountId, arg) {
    if (String(arg ?? '').trim() !== '') return '用法：/compact（不带参数）'
    const record = await this.attach(conversationId, accountId)
    if (record.busy || record.pendingLateReplies?.size > 0 || this.#hostUnconfirmed(record)) {
      return '当前话题还在处理或交付上一条消息，完成后再试 /compact。'
    }
    let attempted = false
    try {
      const commands = this.ctx.get('commands')
      if (commands && typeof commands.execute === 'function') {
        attempted = true
        const out = await commands.execute(record.agent, '/compact', [], AbortSignal.timeout(120_000))
        if (out?.result) {
          this.#checkpoint(record, this.#lastSeq(record.agent))
          if (out.result.text !== null && out.result.text !== undefined) return out.result.text
          if (out.result.kind === 'success') return '已整理当前话题的前文。'
          this.errLog(`compact command failed for ${conversationId}: compact result kind=${String(out.result.kind ?? 'unknown')}`)
          return '这次没能整理当前话题的前文；对话仍可继续。详细信息已写入日志。'
        }
      }
    } catch (error) {
      this.errLog(`compact command failed for ${conversationId}: ${String(error)}`)
      return '这次没能整理当前话题的前文；对话仍可继续。详细信息已写入日志。'
    }
    if (attempted) {
      this.errLog(`compact command failed for ${conversationId}: no result`)
      return '这次没能整理当前话题的前文；对话仍可继续。详细信息已写入日志。'
    }
    this.errLog(`compact command unavailable for ${conversationId}: commands service is not mounted`)
    return '当前环境暂时不能手动整理前文，请稍后再试。'
  }

  /**
   * Session lines recorded for a conversation, for the settings card.
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   */
  sessionLines(conversationId, accountId) {
    return this.lines.list(conversationId, accountId)
  }

  /**
   * Resolve (creating if needed) the Workspace that owns our conversations.
   *
   * A session only appears under a named group in the GUI when some Workspace
   * lists it in `sessionIds`; otherwise the client files it under "Ungrouped".
   * Registering the directory is therefore not cosmetic — it is what makes these
   * conversations findable again.
   *
   * Returns undefined when the registry is unavailable, in which case the agent
   * still runs and the conversation simply shows as ungrouped. Losing the GUI
   * grouping is a far smaller failure than losing the ability to reply.
   */
  async #workspace() {
    if (this.workspacePromise === undefined) {
      this.workspacePromise = this.#resolveWorkspace()
    }
    return await this.workspacePromise
  }

  async #resolveWorkspace() {
    if (this.cwd === undefined) return undefined
    const registry = this.ctx.get('workspaceRegistry')
    if (registry?.resolveByPath === undefined) return undefined
    try {
      const existing = await registry.resolveByPath(this.cwd)
      if (existing !== undefined) return existing
      if (typeof registry.create !== 'function') return undefined
      return await registry.create(this.cwd)
    } catch (error) {
      this.errLog(`could not register the workspace at ${this.cwd}: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Resolve the route this conversation runs on and the setup that binds it.
   *
   * A prompt assembly needs a provider/model pair, and the agent only learns it
   * from either `agentOptions` or a model-selection listener on the agent context.
   * Supplying neither leaves `{{model}}` empty and the deployment persona section
   * throws at the first step — so both are always supplied here.
   *
   * `installModelSelection` comes from `@deepseek-ai/dsh-agent`, which resolves
   * only inside a DSH profile; a profile showing a different shape degrades to
   * running without the listener rather than failing to load.
   *
   */
  async #setup() {
    const route = await this.#route()
    const agentOptions =
      route === undefined
        ? undefined
        : {
            provider: route.provider,
            model: route.model,
          }
    const presets = this.ctx.get('agentPresets')
    const presetId = await this.#presetId(presets)

    const setup = async (agentCtx) => {
      if (presetId !== undefined) await presets.mount(agentCtx, presetId)
      if (route !== undefined) {
        const install = await loadInstallModelSelection()
        if (install !== undefined) {
          install(agentCtx, { current: route, assembled: undefined })
        }
      }
    }
    const hasSetup = presetId !== undefined || route !== undefined
    return { agentOptions, setup: hasSetup ? setup : undefined }
  }

  /**
   * The deployment's default provider/model route, or undefined when the
   * service is absent (a host that routes some other way).
   */
  async #route() {
    const defaults = this.ctx.get('agentDefaultModel')
    try {
      const selection = defaults?.currentSelection?.()
      if (selection?.provider && selection?.model) return selection
    } catch (error) {
      this.errLog(`agentDefaultModel.currentSelection failed: ${String(error)}`)
    }
    return undefined
  }

  /** The preset id this conversation should compose, when presets exist. */
  async #presetId(presets) {
    if (!presets?.resolve) return undefined
    try {
      const resolved = await presets.resolve(undefined)
      return resolved?.id
    } catch (error) {
      this.errLog(`agentPresets.resolve failed (continuing without a preset): ${String(error)}`)
      return undefined
    }
  }

  async restoreAccount(accountId, canStart = () => true) {
    for (const conversationId of this.lines.conversations(accountId)) {
      if (!canStart() || this.shutdown.signal.aborted) break
      try {
        await this.attach(conversationId, accountId, { restoreOnly: true })
      } catch (error) {
        this.errLog(`could not restore topic for ${accountId}: ${redactSecrets(String(error))}`)
      }
    }
  }

  /**
   * Attach (or resume) the agent session backing a Weixin conversation.
   *
   * Resolves the conversation's ACTIVE session line, not a fixed id: after
   * `/new` or `/use`, the next message must reach a different session than the
   * previous one. The session id is read synchronously before any await, so two
   * concurrent messages for the same conversation cannot disagree about which
   * line is active.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   */
  async attach(conversationId, accountId, { restoreOnly = false } = {}) {
    const sessionId = this.#activeSessionId(conversationId, accountId)
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      if (conversationId) {
        existing.conversationId = conversationId
        if (accountId !== undefined) existing.accountId = accountId
      }
      this.sessionDispatcher.mount(existing.agent)
      return existing
    }

    // Two messages for the same conversation can race here: the first
    // deliver() is still inside the awaits below (its record is not in the
    // map yet), so a second attach() would create a second session for the
    // same id and both would run unserialized. Memoize the in-flight
    // creation so concurrent attaches share one record.
    const inflight = this.attachPromises.get(sessionId)
    if (inflight !== undefined) return inflight

    const creation = this.#attachNew(sessionId, conversationId, accountId, restoreOnly)
    this.attachPromises.set(sessionId, creation)
    try {
      const record = await creation
      if (conversationId) {
        record.conversationId = conversationId
        if (accountId !== undefined) record.accountId = accountId
      }
      this.sessionDispatcher.mount(record.agent)
      return record
    } finally {
      this.attachPromises.delete(sessionId)
    }
  }

  async #attachNew(sessionId, conversationId, accountId, restoreOnly) {
    const line = this.lines.list(conversationId, accountId).find(line => line.sessionId === sessionId)
    const hasCheckpoint = Number.isSafeInteger(line?.lastDeliveredSeq) && line.lastDeliveredSeq >= -1
    const preserve = restoreOnly || hasCheckpoint || !sessionId.startsWith(baseSessionIdFor(conversationId, accountId))
    const agents = this.#agents()
    if (agents === undefined) throw new Error('the agents service is unavailable')

    const { agentOptions, setup } = await this.#setup()
    /** @type {{ agent: any, dispose: () => Promise<void> }} */
    let handle
    /** Created here rather than adopted, so {@link #create} already filed it. */
    let created = false
    const live = agents.get?.(sessionId)
    if (live !== undefined) {
      handle = { agent: live, dispose: async () => {} }
    } else if (typeof agents.resume === 'function') {
      // Cold start: the session was persisted by a previous run.
      try {
        handle = await agents.resume({
          resumeSessionId: sessionId,
          setup,
          ...(agentOptions === undefined ? {} : { agentOptions }),
        })
      } catch (error) {
        if (preserve) throw error
        handle = await this.#create(sessionId, setup, agentOptions)
        created = true
      }
    } else {
      if (preserve) throw new Error('the agents service cannot restore a recorded topic')
      handle = await this.#create(sessionId, setup, agentOptions)
      created = true
    }

    // A stale record from a previous plugin generation can leave its inbox
    // holding unclaimed input; clearing it fences the same replay leak
    // sidechat documents (queued input claimed before our first prompt).
    try {
      if (!preserve) handle.agent.inbox?.clear?.()
    } catch {
      // Not fatal: the worst case is one stale message in the first turn.
    }

    // An archived session cannot run a single step: the host's
    // ArchivedSessionGate rejects every pre-step, so a turn ends `blocked`
    // 25ms after it starts — the message was received, typing was shown, and
    // no reply ever came (observed 2026-10-15). The archive set is GUI state
    // (workspace.json), not anything this plugin writes, so an archive made
    // from the GUI would otherwise silently kill the WeChat bot forever.
    // Lifting it here keeps the conversation reachable; a user who truly wants
    // it gone can log the bot out instead.
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const archived = registry?.archivedSessionIds
      if (Array.isArray(archived) && archived.includes(sessionId) && typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(sessionId)
        this.log?.(`session ${sessionId} was archived; unarchived it so the conversation can reply again`)
      }
    } catch {
      // Best effort only: if unarchiving is refused the turn will end blocked
      // and the refusal is visible in the host log, not lost silently here.
    }

    // `cancelled` is set by `/cancel` for the duration of one turn: it tells
    // the reply wait that the abort it will observe is wanted, so it must not
    // be reported as a model failure. Cleared when the turn settles.
    const record = {
      agent: handle.agent,
      dispose: handle.dispose,
      busy: false,
      queue: [],
      cancelled: false,
      sessionId, conversationId, accountId,
      lastDeliveredSeq: hasCheckpoint ? line.lastDeliveredSeq : this.#lastSeq(handle.agent),
      deliveredTurns: new Set(Array.isArray(line?.deliveredTurns) ? line.deliveredTurns : []),
      spontaneousSending: false,
    }
    this.#checkpoint(record)
    this.sessions.set(sessionId, record)
    // Resume can resurrect a session this plugin never filed (created by an
    // earlier generation, before grouping existed), so those paths register
    // here. A session created above is already filed; attaching twice would be
    // harmless but would mean two registry writes per first message.
    if (!created) await this.#register(sessionId, await this.#workspace())
    return record
  }

  async #create(sessionId, setup, agentOptions) {
    const agents = this.#agents()
    if (typeof agents.create !== 'function') throw new Error('the agents service cannot create sessions')
    // The session's cwd must equal the Workspace path byte for byte, because
    // `attachSession` re-resolves the stored header's cwd and refuses anything
    // that differs. Adopting the registry's own path removes the chance of a
    // mismatch (a trailing slash, a symlinked /tmp, a relative config value)
    // that would file the conversation under "Ungrouped" forever.
    const workspace = await this.#workspace()
    const cwd = workspace?.path ?? this.cwd
    const handle = await agents.create({
      sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      // Meta is validated against the session header schema: only cwd,
      // parentSession, isSeeded, origin ('subagent'), delegationDepth and
      // agentPreset are admitted. A Weixin conversation is a top-level
      // conversation, so it needs no origin marker at all — writing a custom
      // one would fail validation ("header origin must be \"subagent\"").
      meta: {
        ...(cwd === undefined ? {} : { cwd }),
      },
      setup,
      signal: AbortSignal.timeout(this.createTimeoutMs),
    })
    await this.#register(sessionId, workspace)
    return handle
  }

  /**
   * File a freshly created session under its Workspace for GUI grouping.
   *
   * `attachSession` re-validates the stored header's cwd against the workspace
   * path and throws on a mismatch, so this must run after the session exists and
   * only ever against the workspace whose path the session was created with. A
   * failure is logged and swallowed: the conversation works, it just shows as
   * ungrouped.
   */
  async #register(sessionId, workspace) {
    if (workspace === undefined || typeof workspace.attachSession !== 'function') return
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      this.errLog(`could not file session ${sessionId} under ${workspace.path}: ${String(error)}`)
    }
  }

  /**
   * Deliver one Weixin message and wait for the agent's settled reply.
   *
   * @param {object} params
   * @param {string} params.conversationId
   * @param {string} [params.accountId] owning bot account; bare key when absent
   * @param {string} params.text
   * @param {(note: string) => Promise<void>|void} [params.onProgress]
   * @param {AbortSignal} [params.signal]
   * @param {string} [params.senderId] the Weixin user whose message started the
   *   turn; carried into the tool audit so a line answers "who caused this".
   * @returns {Promise<{ text: string, sessionId: string, cancelled?: boolean,
   *   uncertain?: boolean, notSubmitted?: boolean, late?: boolean, superseded?: boolean, status?: string }>}
   * `uncertain` means host settlement is unconfirmed. `notSubmitted` means this
   * message was not submitted because an earlier turn is still unconfirmed.
   * `onLateReply` also receives `cancel-pending` and `discarded` events.
   */
  async deliver({ conversationId, accountId, text, onProgress, signal, busyMessageMode, onLateReply, onSpontaneousReply, senderId }) {
    const record = await this.attach(conversationId, accountId)
    record.conversationId = conversationId
    if (accountId !== undefined) record.accountId = accountId
    if (onSpontaneousReply !== undefined) record.onSpontaneousReply = onSpontaneousReply
    const sessionId = this.conversationTargets.get(scopedLineKey(accountId, conversationId))
    // Name the line after the first message that runs in it. Done before the
    // turn so `/list` shows what the topic is even while the first reply is
    // still being written; a later message never renames it.
    // A freshly set title is ALSO mirrored into the host session
    // (sessionTitle.rename): the GUI sidebar renders the HOST's title, not
    // this store's, so without the mirror the sidebar shows its own
    // AI-generated name while /list and the card show `label: message`.
    // Best-effort: the store title is the source of truth; a failed host
    // rename (service absent, session not live, title rejected) only costs
    // the sidebar echo, never the message.
    if (sessionId !== undefined) {
      const storeTitle = this.lines.title(conversationId, sessionId, text, accountId)
      this.#checkpoint(record)
      if (storeTitle !== undefined) void this.#mirrorTitle(record.agent, storeTitle)
    }
    const mode = busyMessageMode === 'steer' ? 'steer' : 'queue'

    if (record.busy) {
      if (record.cancelled !== true && mode === 'steer') {
        // A second group sender must not inherit the first sender's dispatcher
        // permission by steering their still-running controller turn.
        if (senderId !== record.turnSource?.senderId) record.dispatchSenderMixed = true
        const createUserMessage = await loadCreateUserMessage()
        record.agent.steer?.(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        )
        // The steered turn keeps running; the caller's awaitReply is for a
        // turn this delivery did not start, so return immediately with a
        // receipt. The steered turn's eventual reply belongs to the turn's
        // own delivery wait.
        return { text: '（已把补充指令插入正在进行的回复中）', sessionId: record.agent.session?.id ?? sessionId ?? baseSessionIdFor(conversationId, accountId) }
      }
      // queue (default): FIFO tail drained when the running turn settles.
      return await this.#enqueue({ record, conversationId, accountId, text, onProgress, signal, onLateReply, onSpontaneousReply, senderId })
    }
    if (this.#hostUnconfirmed(record)) return { text: '', sessionId: record.agent.session?.id ?? '', uncertain: true, notSubmitted: true }
    record.busy = true
    try {
      const createUserMessage = await loadCreateUserMessage()
      const before = this.#lastSeq(record.agent)
      this.#beginTurn(record, { accountId, conversationId, senderId })
      // followup() wakes the driver for a turn; inject() would only queue
      // context, and steer() would wait for the next step boundary.
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      const settled = await this.#submitTurn({ record, before, message, onProgress, signal, onLateReply })
      return settled
    } finally {
      record.busy = false
      // The turn is over, so a stale cancel flag would suppress the NEXT
      // turn's reply entirely.
      record.cancelled = false
      await this.#drainQueue({ record, conversationId, onProgress, signal })
    }
  }

  /**
   * Park one message on the conversation's FIFO tail and wait until it has
   * been delivered as its own turn (possibly by an earlier drain).
   *
   * The receipt goes out through `onProgress` immediately — that is the only
   * send channel this layer has — and the resolved value is the queued turn's
   * own reply, so the caller delivers the real answer through its normal
   * reply path once the turn runs.
   */
  async #enqueue({ record, conversationId, accountId, text, onProgress, signal, onLateReply, onSpontaneousReply, senderId }) {
    const sessionId = record.agent.session?.id ?? this.conversationTargets.get(scopedLineKey(accountId, conversationId)) ?? baseSessionIdFor(conversationId, accountId)
    const entry = { text, onProgress, signal, onLateReply, onSpontaneousReply, senderId, accountId, conversationId }
    entry.done = new Promise((resolve) => { entry.resolveDone = resolve })
    record.queue.push(entry)
    // The receipt must reach WeChat even when the caller ignores onProgress:
    // a plain-notification wrapper is safe either way.
    const notify = onProgress ?? (() => {})
    void Promise.resolve(notify('已排队，等当前回复完成后自动发送')).catch(() => {})
    // If the turn already settled between the busy check and this push, the
    // drain ran without our entry; run it now.
    if (!record.busy && record.queue[record.queue.length - 1] === entry) {
      record.queue.pop()
      record.busy = true
      try {
        const result = await this.#runQueuedTurn({ record, conversationId, entry })
        entry.resolveDone(result)
        return result
      } finally {
        record.busy = false
        record.cancelled = false
      }
    }
    return entry.done
  }
  /**
   * Run one queued text as a full turn, serially after whatever is running.
   * Resolves with that turn's reply; the queue notification happens in
   * {@link #drainQueue}.
   */
  async #runQueuedTurn({ record, conversationId, entry }) {
    if (this.#hostUnconfirmed(record)) return { text: '', sessionId: record.agent.session?.id ?? '', uncertain: true, notSubmitted: true }
    const createUserMessage = await loadCreateUserMessage()
    record.conversationId = entry.conversationId ?? conversationId
    if (entry.accountId !== undefined) record.accountId = entry.accountId
    if (entry.onSpontaneousReply !== undefined) record.onSpontaneousReply = entry.onSpontaneousReply
    const before = this.#lastSeq(record.agent)
    this.#beginTurn(record, {
      accountId: entry.accountId,
      conversationId: entry.conversationId ?? conversationId,
      senderId: entry.senderId,
    })
    const message = createUserMessage({ content: [{ type: 'text', text: entry.text }], source: { kind: 'user' } })
    return this.#submitTurn({ record, before, message, onProgress: entry.onProgress, signal: entry.signal, onLateReply: entry.onLateReply })
  }

  /**
   * Drain the FIFO tail after a turn settles, one entry at a time.
   * Called from the deliver() finally block; owns record.busy while draining.
   */
  async #drainQueue({ record, conversationId, onProgress, signal }) {
    while (record.queue.length > 0) {
      const entry = record.queue.shift()
      if (entry === undefined) return
      record.busy = true
      try {
        const result = await this.#runQueuedTurn({ record, conversationId, entry })
        entry.resolveDone(result)
      } catch (error) {
        this.errLog(`queued turn failed: ${String(error)}`)
        entry.resolveDone({ text: '（排队消息处理失败，请重发）', sessionId: record.agent.session?.id ?? '' })
      } finally {
        record.busy = false
        record.cancelled = false
      }
    }
  }

  #beginTurn(record, meta) {
    record.turnSource = meta
    record.dispatchSenderMixed = record.agent?.status === 'running' || !meta.senderId
  }

  // Out-of-order direct replies can settle ahead of an older unsent turn.
  // Persist their receipts with the contiguous cursor so restart neither
  // skips the gap nor replays an answer when that gap eventually closes.
  #checkpoint(record, seq = record.lastDeliveredSeq) {
    record.lastDeliveredSeq = Math.max(record.lastDeliveredSeq ?? -1, seq ?? -1)
    this.lines.checkpoint?.(record.conversationId, record.accountId, record.sessionId ?? record.agent.session?.id,
      record.lastDeliveredSeq, record.deliveredTurns)
  }

  #lastSeq(agent) {
    const events = agent.session?.snapshotEvents?.() ?? []
    let seq = -1
    for (const event of events) {
      if (typeof event?.seq === 'number' && event.seq > seq) seq = event.seq
    }
    return seq
  }

  /**
   * Mirror a freshly set line title into the host session, so the GUI
   * sidebar (which renders the HOST's title, not this store's) shows the
   * same `label: message` text /list does.
   *
   * The host renames through its `sessionTitle` service: rename(session,
   * title) appends a `session/title` event with source `user`, which pins the
   * title — the host's own automatic title generation is superseded and later
   * messages schedule none. That pinning is exactly what we want: the first
   * WeChat message names the sidebar row and nothing overwrites it.
   *
   * Never throws: the store title already stands; this only echoes it to the
   * sidebar. A missing service (bare CLI), a session not live in the host
   * store, or a title the host rejects are all logged and dropped.
   *
   * @param {any} agent live agent handle from attach()
   * @param {string} title the title the store just set
   */
  #mirrorTitle(agent, title) {
    try {
      const session = agent?.session
      if (session === undefined || typeof session.id !== 'string' || session.id === '') return
      const titles = this.ctx.get('sessionTitle')
      if (titles === undefined || typeof titles.rename !== 'function') return
      titles.rename(session, title)
      this.log?.(`session title mirrored: ${title}`)
    } catch (error) {
      // The host rejects a rename when the session is not live in its store
      // (cold-start races) or the title normalizes to empty — both leave the
      // sidebar with its own title, which is cosmetic, so warn and move on.
      this.errLog?.(`sessionTitle.rename failed (sidebar keeps its own title): ${String(error)}`)
    }
  }

  #hostUnconfirmed(record) {
    const pending = record.unconfirmed
    if (!pending) return false
    if (record.agent.status !== 'idle') return true
    const events = record.agent.session?.snapshotEvents?.() ?? []
    if (!pending.claim.discarded) {
      const reply = readAssistantReply({ events, afterSeq: pending.before, messageId: pending.messageId, claimedTurn: pending.claim.turn })
      if (reply.turnReason === undefined) return true
    }
    try {
      assertNoPendingInbox(events, record.agent.inbox)
    } catch (error) {
      if (error?.code === 'SESSION_INBOX_PENDING' || error?.code === 'SESSION_INBOX_INVALID') return true
      throw error
    }
    pending.offClaim?.()
    pending.offDiscard?.()
    record.unconfirmed = undefined
    return false
  }

  async #submitTurn({ record, before, message, onProgress, signal, onLateReply }) {
    if (typeof message.id !== 'string' || message.id === '') throw new Error('Host did not assign an id to the submitted message')
    const claim = {}
    const offClaim = this.ctx.on?.('agent/inbox/claimed', event => {
      if (event.agent === record.agent && event.message?.id === message.id) claim.turn = event.turn
    })
    const offDiscard = this.ctx.on?.('agent/inbox/discarded', event => {
      if (event.agent === record.agent && event.message?.id === message.id) claim.discarded = true
    })
    let retained = false
    try {
      record.agent.followup(message)
      const { settledSeq, discarded, deliveryFailed, ...result } = await this.#awaitReply({ record, before, messageId: message.id, claim, onProgress, signal, onLateReply })
      if (!result.cancelled && onLateReply && (result.uncertain || deliveryFailed)) {
        record.pendingLateReplies ??= new Map()
        record.pendingLateReplies.set(message.id, { callback: onLateReply, before, claim })
      }
      if (result.uncertain === true) {
        record.unconfirmed = { messageId: message.id, before, claim, offClaim, offDiscard }
        retained = true
      }
      if (result.cancelled === true && !discarded && !Number.isFinite(settledSeq)) {
        record.suppressedInputs ??= new Map()
        record.suppressedInputs.set(message.id, { before, claim })
      }
      if (Number.isFinite(settledSeq)) {
        const earlier = readSettledTurns({
          events: record.agent.session?.snapshotEvents?.() ?? [], afterSeq: record.lastDeliveredSeq ?? -1,
        }).some(turn => turn.settledSeq < settledSeq)
        if (earlier) {
          record.deliveredTurns ??= new Set()
          record.deliveredTurns.add(settledSeq)
          this.#checkpoint(record)
        } else {
          this.#checkpoint(record, settledSeq)
        }
      }
      return result
    } catch (error) {
      // The host may have accepted the input before throwing. Preserve its
      // identity and tell the caller it is unsafe to assume non-submission.
      if (claim.discarded) {
        if (record.agent.status !== 'idle') {
          record.unconfirmed = { messageId: message.id, before, claim, offClaim, offDiscard }
          retained = true
        }
        throw error
      }
      record.unconfirmed = { messageId: message.id, before, claim, offClaim, offDiscard }
      retained = true
      if (onLateReply) {
        record.pendingLateReplies ??= new Map()
        record.pendingLateReplies.set(message.id, { callback: onLateReply, before, claim })
      }
      this.errLog(`turn submission or wait failed for ${record.agent.session?.id ?? ''}: ${redactSecrets(String(error))}`)
      return { text: '', sessionId: record.agent.session?.id ?? '', uncertain: true }
    } finally {
      if (!retained) {
        if (typeof offClaim === 'function') offClaim()
        if (typeof offDiscard === 'function') offDiscard()
      }
    }
  }

  async #awaitReply({ record, before, messageId, claim, onProgress, signal, onLateReply }) {
    const sessionId = record.agent.session?.id ?? ''
    const startedAt = Date.now()
    const deadline = startedAt + this.maxWaitMs
    let lastProgressAt = 0
    // Compared as a SET, not as the rendered line: the line now carries the
    // elapsed clock, so every render differs and "unchanged state is never
    // repeated" would stop holding if the text were the key.
    let lastProgressTools = null
    let lateAnnounced = false
    let cancelNoticeSent = false

    while (Date.now() < deadline) {
      if (signal?.aborted === true) return { text: '', sessionId, cancelled: true, uncertain: true }
      const events = record.agent.session?.snapshotEvents?.() ?? []

      const reply = readAssistantReply({ events, afterSeq: before, messageId, claimedTurn: claim.turn })
      if (claim.discarded) {
        if (record.cancelled !== true) {
          if (record.agent.status !== 'idle') record.unconfirmed = { messageId, before, claim }
          throw new Error('Host discarded the message before processing')
        }
        if (record.agent.status === 'idle') return { text: '', sessionId, cancelled: true, discarded: true }
      }
      // A cancellation request is not a terminal event. Keep the busy lock
      // until this specific turn ends so queued work cannot overlap it.
      if (record.cancelled === true && reply.turnReason !== undefined) {
        return { text: '', sessionId, cancelled: true, ...(reply.turnReason !== 'completed' ? { settledSeq: reply.settledSeq } : {}) }
      }
      // A failed turn is OVER: no assistant message will ever arrive, and the
      // turn/end(error) event is already durable. Waiting out the deadline
      // here holds record.busy for the whole budget, so the user's NEXT
      // message queues behind a turn that can never answer — the "one model
      // failure and everything after is stuck" report. Answer immediately.
      if (reply.superseded && (reply.turnReason !== undefined)) return { text: '', sessionId, superseded: true }
      if (reply.turnReason !== undefined && reply.turnReason !== 'completed') {
        if (reply.turnReason === 'error') logTurnError(this.errLog, sessionId, reply)
        return { text: terminalNotice(reply.turnReason), sessionId, settledSeq: reply.settledSeq, status: reply.turnReason }
      }
      if (reply.turnSettled) return { text: reply.text, sessionId, settledSeq: reply.settledSeq }

      // A long tool run is invisible in WeChat. The first note goes out after
      // progressAfterMs; after that a CHANGED tool set is re-announced at most
      // every progressEveryMs, so "running: bash" becoming "running: read"
      // reaches the user while one long unchanged tool never spams.
      if (onProgress && record.cancelled !== true) {
        const elapsed = Date.now() - startedAt
        const note = describePending(reply.pendingTools, elapsed)
        // Two thresholds, whichever comes first: a turn that is only thinking
        // waits for progressAfterMs, one that is visibly running a tool is
        // reported at progressToolAfterMs so `npm test` does not look like a
        // dead bot for 20 seconds.
        const toolRunning = reply.pendingTools.length > 0
        const firstAfterMs = toolRunning && this.progressToolAfterMs > 0
          ? Math.min(this.progressAfterMs, this.progressToolAfterMs)
          : this.progressAfterMs
        const toolKey = reply.pendingTools.join(',')
        const due = lastProgressAt === 0
          ? elapsed >= firstAfterMs
          : toolKey !== lastProgressTools && Date.now() - lastProgressAt >= this.progressEveryMs
        if (due) {
          lastProgressAt = Date.now()
          lastProgressTools = toolKey
          await onProgress(note)
        }
      }
      const sinceStart = Date.now() - startedAt
      const interval = sinceStart < this.eventPollFastWindowMs ? this.eventPollFastMs : this.eventPollMs
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    // The user was told the wait gave up — but the turn is still running and
    // its answer would be lost if we simply returned. Keep listening at a
    // slow cadence until the turn settles, then hand the final text to the
    // late-reply callback so the caller can deliver it out of band.
    if (onLateReply === undefined) return { text: '', sessionId, uncertain: true, ...(record.cancelled === true ? { cancelled: true } : {}) }
    if (!lateAnnounced) {
      lateAnnounced = true
      try {
        cancelNoticeSent = record.cancelled === true
        await onLateReply({ kind: cancelNoticeSent ? 'cancel-pending' : 'timeout-notice' })
      } catch {
        // The notice is best effort; the late answer still gets delivered.
      }
    }
    // Keep the normal cadence: the loop is cheap (an in-memory event
    // snapshot), and a slower tick risks missing a short late window.
    const latePollMs = this.eventPollMs
    const lateDeadline = Date.now() + (this.lateReplyMaxWaitMs ?? 60 * 60_000)
    while (Date.now() < lateDeadline) {
      if (signal?.aborted === true) return { text: '', sessionId, late: true, cancelled: true, uncertain: true }
      const events = record.agent.session?.snapshotEvents?.() ?? []

      const reply = readAssistantReply({ events, afterSeq: before, messageId, claimedTurn: claim.turn })
      if (claim.discarded) {
        if (record.cancelled !== true) {
          if (record.agent.status !== 'idle') record.unconfirmed = { messageId, before, claim }
          throw new Error('Host discarded the message before processing')
        }
        if (record.agent.status === 'idle') return { text: '', sessionId, late: true, cancelled: true, discarded: true }
      }
      if (record.cancelled === true && reply.turnReason !== undefined) {
        return { text: '', sessionId, late: true, cancelled: true, ...(reply.turnReason !== 'completed' ? { settledSeq: reply.settledSeq } : {}) }
      }
      if (reply.superseded && (reply.turnReason !== undefined)) return { text: '', sessionId, superseded: true }
      if (reply.turnReason !== undefined && reply.turnReason !== 'completed') {
        if (reply.turnReason === 'error') logTurnError(this.errLog, sessionId, reply)
        return { text: terminalNotice(reply.turnReason), sessionId, settledSeq: reply.settledSeq, status: reply.turnReason }
      }
      if (record.cancelled === true && !cancelNoticeSent) {
        cancelNoticeSent = true
        try {
          await onLateReply({ kind: 'cancel-pending' })
        } catch (error) {
          this.errLog(`cancellation notice failed: ${String(error)}`)
        }
      }
      if (reply.turnSettled) {
        try {
          await onLateReply({ kind: 'reply', text: reply.text })
        } catch (error) {
          this.errLog(`late reply delivery failed: ${String(error)}`)
          return { text: '', sessionId, late: true, deliveryFailed: true }
        }
        return { text: '', sessionId, late: true, settledSeq: reply.settledSeq }
      }
      await new Promise((resolve) => setTimeout(resolve, latePollMs))
    }
    this.errLog(`late reply wait gave up for ${sessionId}`)
    return { text: '', sessionId, late: true, uncertain: true, ...(record.cancelled === true ? { cancelled: true } : {}) }
  }

  /**
   * Poll idle conversation sessions for spontaneous turns (e.g. a delegated
   * subagent finishes and calls send_message back into the parent session).
   */
  async #pollSpontaneous() {
    for (const [sessionId, record] of this.sessions) {
      if (record.busy === true || record.spontaneousSending === true) continue
      if (record.isSideSession === true || sessionId.startsWith('wx-mem-')) continue
      if (!record.conversationId) continue

      const events = record.agent?.session?.snapshotEvents?.() ?? []
      const afterSeq = record.lastDeliveredSeq ?? -1

      const turns = readSettledTurns({ events, afterSeq })
      for (const turn of turns) {
        const pendingInputs = turn.inputs?.filter(input => record.pendingLateReplies?.has(input.id)) ?? []
        let pendingInput = pendingInputs.find(input => input.seq === turn.latestInstructionSeq)
        if (!pendingInput && turn.turnReason !== 'completed' && turn.turn !== undefined) {
          const claimed = [...(record.pendingLateReplies ?? [])].find(([, pending]) => pending.claim.turn === turn.turn
            && turn.settledSeq > pending.before && !turn.inputs.some(input => input.seq > pending.before))
          if (claimed) pendingInput = { id: claimed[0], seq: -1 }
        }
        for (const input of pendingInputs) {
          if (input !== pendingInput) record.pendingLateReplies.delete(input.id)
        }
        const suppressed = turn.inputIds?.filter(id => record.suppressedInputs?.has(id)) ?? []
        const claimedSuppression = [...(record.suppressedInputs ?? [])].find(([id, pending]) =>
          !suppressed.includes(id) && turn.turn !== undefined && pending.claim.turn === turn.turn
          && turn.settledSeq > pending.before && !turn.inputs.some(input => input.id === id))
        if (claimedSuppression) suppressed.push(claimedSuppression[0])
        if (suppressed.length > 0) {
          const suppressedSeq = Math.max(
            ...turn.inputs.filter(input => suppressed.includes(input.id)).map(input => input.seq),
            ...(claimedSuppression ? [claimedSuppression[1].before] : []),
          )
          for (const id of suppressed) {
            record.suppressedInputs.delete(id)
            record.pendingLateReplies?.delete(id)
          }
          if (!(turn.latestInstructionSeq > suppressedSeq)) {
            record.deliveredTurns?.delete(turn.settledSeq)
            this.#checkpoint(record, turn.settledSeq)
            continue
          }
        }
        if (record.deliveredTurns?.delete(turn.settledSeq)) {
          this.#checkpoint(record, turn.settledSeq)
          continue
        }
        const pendingReply = pendingInput && record.pendingLateReplies?.get(pendingInput.id)?.callback
        if (pendingReply) {
          record.spontaneousSending = true
          try {
            await pendingReply({ kind: 'reply', text: turn.turnReason === 'completed' ? turn.text : terminalNotice(turn.turnReason), ...(turn.turnReason === 'completed' ? {} : { status: turn.turnReason }) })
            record.pendingLateReplies.delete(pendingInput.id)
            this.#checkpoint(record, turn.settledSeq)
          } catch (error) {
            this.errLog(`late reply delivery failed for ${sessionId}: ${String(error)}`)
            break
          } finally {
            record.spontaneousSending = false
          }
          continue
        }
        if (turn.turnReason === 'error') logTurnError(this.errLog, sessionId, turn)
        const replyText = turn.turnReason === 'completed' ? turn.text : terminalNotice(turn.turnReason)
        const trimmedReply = replyText.trim()
        if (trimmedReply === '') {
          this.#checkpoint(record, turn.settledSeq)
          continue
        }
        if (/^(?:\[SILENT\]|HEARTBEAT_OK|（已取消）|（静默）)/i.test(trimmedReply)) {
          this.log?.(`spontaneous reply suppressed as silent heartbeat for ${sessionId}`)
          this.#checkpoint(record, turn.settledSeq)
          continue
        }
        const handler = record.onSpontaneousReply ?? this.onSpontaneousReply
        if (typeof handler === 'function') {
          if (turn.silentRecoveredFromSeq !== undefined) {
            this.log?.(`spontaneous reply recovered before trailing silent step for ${sessionId}: replySeq=${turn.silentRecoveredFromSeq} settledSeq=${turn.settledSeq}`)
          }
          record.spontaneousSending = true
          try {
            await handler({
              accountId: record.accountId,
              conversationId: record.conversationId,
              sessionId,
              text: replyText,
            })
            this.#checkpoint(record, turn.settledSeq)
          } catch (error) {
            this.errLog(`spontaneous reply delivery failed for ${sessionId}: ${String(error)}`)
            break
          } finally {
            record.spontaneousSending = false
          }
        } else break // No recipient yet: leave this and later turns pending.
      }
      for (const [messageId, pending] of record.pendingLateReplies ?? []) {
        if (!pending.claim.discarded) continue
        if (record.suppressedInputs?.delete(messageId)) {
          record.pendingLateReplies.delete(messageId)
        } else {
          record.spontaneousSending = true
          try {
            await pending.callback({ kind: 'discarded' })
            record.pendingLateReplies.delete(messageId)
          } catch (error) {
            this.errLog(`discarded input notification failed for ${sessionId}: ${String(error)}`)
            continue
          } finally {
            record.spontaneousSending = false
          }
        }
      }
      const pending = record.unconfirmed
      if (pending?.claim.discarded && !record.pendingLateReplies?.has(pending.messageId) && record.agent.status === 'idle') {
        try {
          this.#hostUnconfirmed(record)
        } catch (error) {
          this.errLog(`discarded input cleanup failed for ${sessionId}: ${String(error)}`)
        }
      }
    }
  }

  /** Test hook to invoke a spontaneous poll pass directly. */
  async testPollSpontaneous() {
    await this.#pollSpontaneous()
  }

  /** Tear down every session this bridge created. */
  async dispose() {
    this.shutdown.abort()
    await this.sessionDispatcher.dispose()
    if (this.#spontaneousTimer !== undefined) {
      clearInterval(this.#spontaneousTimer)
      this.#spontaneousTimer = undefined
    }
    const records = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(
      records.map(async (record) => {
        try {
          record.unconfirmed?.offClaim?.()
          record.unconfirmed?.offDiscard?.()
          await record.dispose()
        } catch (error) {
          this.errLog(`session dispose failed: ${String(error)}`)
        }
      }),
    )
  }
}
