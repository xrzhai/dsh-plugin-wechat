/**
 * dsh-weixin — a DSH channel plugin that turns Weixin (personal WeChat, via the
 * iLink Bot API) into a remote control surface for a DSH agent.
 *
 * Contract: a Cordis plugin module exports `name`, `inject` (required services)
 * and `apply(ctx, config)`. Everything registered through `ctx.on` / `ctx.effect`
 * is undone automatically when the plugin unloads, so `apply` only has to wire
 * the pipeline and hand back a disposer.
 *
 * The pipeline, in order, for every inbound Weixin message:
 *   allowlist → dedupe → agent session → markdown filter → chunked reply.
 *
 * Two deliberate safety properties:
 *  - The allowlist is deny-by-default. WeChat text is not an authorization
 *    credential, so a plugin with no allowlist drives nothing at all.
 *  - Credentials live only in a local file under ~/.dsh (0600). This plugin
 *    never accepts a password, and the QR login prints the code locally.
 * @module dsh-weixin
 */
import z from '@deepseek-ai/schemastery'
import { basename } from 'node:path'
import { configureWeixinStateDir, accountsDir, readSavedConfig, ensureSessionsDir, sessionsDir, withSavedConfig } from './state.js'
import { HEARTBEAT_MS, acquireInstanceLock, heartbeatInstanceLock, releaseInstanceLock } from './instance-lock.js'
import { createOutbox, CONTEXT_TOKEN_TTL_MS } from './message/outbox.js'
import { createGatewayControl } from './gateway-control.js'
import { configureOutbound, sendChunked } from './outbound.js'
import { ensureSecretModes, redactSecrets } from './credentials.js'
import { neutralizeTags } from './message/fence.js'
import { quoteBlock } from './message/quote.js'
import { DEFAULT_MAX_QUEUE, DEFAULT_PER_MINUTE, createSenderLimiter } from './message/sender-limit.js'
import { createSenderDailyLimiter } from './message/sender-daily.js'
import { isAllowedSender, denialReason } from './security/allowlist.js'
import { ILinkTransport } from './transport/ilink.js'
import { AgentBridge } from './agent-bridge.js'
import { DEFAULT_SEND_INTERVAL_MS, DEFAULT_COOLDOWN_MS } from './message/rate-limit.js'

let outbox
import { MessageDeduper } from './message/dedupe.js'
import { INBOUND_NOT_ACCEPTED } from './message/inbound-pending.js'
import { startAccounts } from './startup.js'
import { createSendCommands } from './message/send-file.js'
import { allowedMediaDirs, deliverOutboundMedia, DEFAULT_MAX_MEDIA_BYTES } from './media/outbound.js'
import { WeixinLoginController } from './login-remote.js'
import { ConfigController } from './config-remote.js'
import { isAccountPaused, touchAccount, allowlistForAccount, readRegistry, registryFile, RegistryReadError, enrolFirstContact } from './account-registry.js'
import { mapWithConcurrency } from './concurrency.js'
// `/cancel` is the one message the transport must be able to deliver while a
// turn is still running; the predicate lives beside the parser so the two
// cannot drift apart.
import { isInterruptCommand } from './sessions.js'

import { groupReplyPolicy } from './message/groups.js'
import { createTranslator } from './i18n.js'
import { statePaths } from './state-layout.js'

// The vendored logger is the only channel guaranteed to land on disk at INFO:
// ctx.logger can drop levels depending on the host's exporter config, and a
// refusal that leaves no trace turns an allowlist mismatch into "the bot just
// ignores me" with nothing to grep afterwards.
import { logger as vendorLogger } from '../vendor/openclaw-weixin/util/logger.js'
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  downloadInboundMedia,
  describeInboundMedia,
  describeMediaFailures,
} from './media/inbound.js'

export const name = 'dsh-weixin'

/**
 * 一条消息里的附件同时下载几个。
 *
 * 三张图串行是三次往返；并发到三能把它压到一次往返的量级。再高没有收益：
 * 入站消息很少带更多附件，而且每个附件都要落盘。
 */
const INBOUND_DOWNLOAD_CONCURRENCY = 3

/**
 * `agents` is required: without it there is no session to drive, so the plugin
 * would load and then silently do nothing. Everything else (settings, sessions,
 * the workspace registry) is optional and read through `ctx.get`, because a
 * missing grouping service must cost the GUI group label — not the ability to
 * reply.
 */
export const inject = ['agents']

/**
 * Every deploy-varying value is a config field rather than a constant, and an
 * invalid value fails load loudly instead of being clamped at runtime.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Start the Weixin long-poll loop when the plugin loads.'),
  sessionDispatcherEnabled: z.boolean().default(false).description('Opt in to explicitly authorized session read/control for dispatcher senders. Never enables itself.'),
  sessionDispatcherSenders: z.array(z.string()).default([]).description('Explicit sender IDs allowed to read and control host project sessions; empty denies everyone.'),
  sessionDispatcherTargets: z.array(z.string()).default([]).description('Exact target session IDs visible to all dispatcher senders; empty denies access. No wildcard.'),
  protectedSessions: z.array(z.string()).default([]).description('Session IDs that session_dispatch must treat as read-only.'),
  readOnlyPaths: z.array(z.string()).default([]).description('Absolute workspace roots that session_dispatch must treat as read-only, including descendants and symlink aliases.'),
  accountId: z.string().default('').description('Weixin account id to use; empty means the only saved account.'),
  cwd: z.string().default('').description('Working directory the agent operates in; empty inherits the session default.'),
  workspaceTitle: z.string().default('').description('Display title for the dedicated Weixin conversations workspace. Empty keeps the folder name. Only replaces the auto-derived name; a title the operator chose in the UI is never overwritten.'),
  allowedSenders: z.array(z.string()).default([]).description('Weixin user ids allowed to drive the agent. Empty denies everyone.'),
  allowedChats: z.array(z.string()).default([]).description('Optional conversation allowlist. Empty allows any conversation from an allowed sender.'),
  maxMessageLength: z.number().default(1500).description('Maximum characters per outbound Weixin message.'),
  sendIntervalMs: z.number().min(1).default(DEFAULT_SEND_INTERVAL_MS).description('Minimum interval between two outbound Weixin sends, in milliseconds. Raising it costs latency on a chunked reply; lowering it moves closer to the measured send-ban threshold (about twenty messages in a few minutes).'),
  sendCooldownMs: z.number().min(1).default(DEFAULT_COOLDOWN_MS).description('How long to stop sending after three consecutive send failures, in milliseconds. Hammering a rejecting server is what turns a temporary rejection into an account ban.'),
  groupChatEnabled: z.boolean().default(false).description('参加群聊：开启后才会在群里回话。默认关闭——一个对每条群消息都答的机器人，在真群里就是刷屏。私聊不受影响。'),
  groupReplyWhen: z.string().default('mention').description('群里什么时候回：mention 只答被叫到的时候，all 每条都答。iLink 不给 @ 列表，因此按首行里的机器人名字匹配。'),
  groupBotNames: z.string().default('').description('群里额外的称呼，用逗号分隔。iLink 不提供机器人的群昵称，想让「@小助手」生效就得在这里写上它。'),
  richContent: z.boolean().default(true).description('富内容：长代码块作为文件附件发出、Markdown 表格转成对齐文本。微信只有纯文本气泡，这两处是 Markdown 里最容易在纯文本里变形的东西。'),
  codeFileThreshold: z.number().min(200).max(20000).default(1200).description('代码块超过多少字就改成发文件；更短的留在气泡里（两行代码读起来比附件顺）。'),
  locale: z.string().default('zh').description('界面与微信里回复的语言：zh（中文，默认）或 en（English）。日志始终英文。'),
  senderRatePerMinute: z.number().min(0).default(DEFAULT_PER_MINUTE).description('每个发送者每分钟最多几条消息；0 表示不限。超过时回一句「慢一点」。'),
  senderDailyLimit: z.number().min(0).default(0).description('每个发送者每天最多被回复几次（按账号分开算；0 表示不限）。到量后当天不再回应，并在群里也按人算。'),
  maxQueuedPerConversation: z.number().min(0).default(DEFAULT_MAX_QUEUE).description('单个会话允许排队等回复的消息条数；0 表示不限制。超过的直接拒收，避免越堆越多。'),
  markdownMode: z
    .union([z.const('strip'), z.const('off')])
    .default('strip')
    .description('How to render the agent Markdown reply for WeChat: "strip" filters unsupported syntax, "off" sends it verbatim.'),
  busyMessageMode: z
    .union([z.const('queue'), z.const('steer')])
    .default('steer')
    .description('What happens to a message that arrives while a reply is still being written: "queue" waits and delivers it as the next turn, "steer" injects it into the running turn.'),
  sourceContext: z.boolean().default(false).description('Prepend a <weixin_source …> block to each prompt so the agent knows the message came from WeChat and who sent it.'),
  progressAfterMs: z.number().default(20_000).description('Send the first progress note to the user after this many milliseconds (a turn that is only thinking).'),
  progressToolAfterMs: z.number().min(0).default(8_000).description('Send the first progress note sooner - after this many milliseconds - when a tool is actually running. 0 disables the early note.'),
  progressEveryMs: z.number().default(60_000).description('Re-send a changed progress note at most this often, so tool changes stay visible without repeating an unchanged state.'),
  maxTurnWaitMs: z.number().default(1_200_000).description('Give up waiting for a turn after this many milliseconds.'),
  eventPollMs: z.number().min(0).max(60_000).default(1_000).description('会话事件轮询间隔（毫秒）：越小回答出现得越快，越大越省 CPU。'),
  // `z` here is a minimal schema helper (string/number/boolean), so enumerations
  // are validated where they are read, not in the declaration — same as
  // `groupReplyWhen` above.
  typingIndicator: z.boolean().default(true).description('Show a typing indicator while the agent works, when a typing ticket is available.'),
  mediaEnabled: z.boolean().default(true).description('Send local files the agent references in its reply as Weixin images/videos/file attachments.'),
  maxMediaBytes: z.number().default(DEFAULT_MAX_MEDIA_BYTES).description('Largest referenced file that will be uploaded to the Weixin CDN.'),
  maxInboundMediaBytes: z
    .number()
    .default(DEFAULT_MAX_INBOUND_MEDIA_BYTES)
    .description('Largest attachment this channel will download from the Weixin CDN.'),
  cdnBaseUrl: z
    .string()
    .default('')
    .description(
      'Weixin CDN root for inbound media downloads and outbound uploads. Empty means "not configured here", which lets a saved account record supply it before falling back to the upstream default.',
    ),
})

export function apply(ctx, config) {

  // Must precede any credential/sync-buffer path resolution in the vendored
  // transport, which reads OPENCLAW_STATE_DIR on every call.
  const stateRoot = configureWeixinStateDir()
  // The account file holds the bot token and is written by the vendored login
  // flow, so its mode is whatever the umask allowed. Fix it here, once per start.
  const secretFix = ensureSecretModes(stateRoot, { warn: (line) => ctx.logger?.warn?.(`dsh-weixin: ${line}`) })
  if (secretFix.tightened.length > 0) {
    ctx.logger?.info?.(`dsh-weixin: tightened permissions on ${secretFix.tightened.length} credential file(s)`)
  }
  // Every log line goes through the redactor: one thrown error that happens to
  // carry the bot token used to put it on disk, because `warn` is where all the
  // failure paths end up (src/credentials.js).
  const log = (line) => ctx.logger?.info?.(`dsh-weixin: ${redactSecrets(String(line))}`)
  const warn = (line) => ctx.logger?.warn?.(`dsh-weixin: ${redactSecrets(String(line))}`)
  const fileLog = vendorLogger.withAccount('dsh-weixin')

  // Settings the operator saved through the UI live beside the credentials, so
  // they survive a reinstall of the package. They fill in what the composition
  // did not set; an explicit value in the profile YAML still wins, because the
  // YAML is the live decision and an overlay must not make it lie.
  const baseConfig = config ?? {}
  config = withSavedConfig(baseConfig)
  // Keep the composition separately: resetting a saved switch must not fall
  // back to the overlay value captured when the plugin first loaded.
  const gatewayEnabled = () => withSavedConfig(baseConfig).enabled !== false
  const sessionDispatcherConfig = () => {
    const live = withSavedConfig(baseConfig)
    const saved = readSavedConfig()
    // Empty security lists revoke access. The legacy general config overlay
    // treats empty arrays as defaults, which must not resurrect these grants.
    for (const key of ['allowedSenders', 'allowedChats', 'sessionDispatcherSenders',
      'sessionDispatcherTargets', 'protectedSessions', 'readOnlyPaths']) {
      if (Object.hasOwn(saved, key)) live[key] = saved[key]
    }
    return live
  }

  const disabled = !gatewayEnabled()
  if (disabled) {
    // Deliberately NOT an early return. The settings card is the only way to
    // turn the plugin back on, and it reads its own options from the
    // ConfigController registered below -- so returning here would leave a
    // disabled plugin with a card that cannot reach the very switch that
    // re-enables it. The controllers register first; only the long-poll loop is
    // skipped.
    log('disabled by configuration; registering the settings services and starting no loop')
  }

  // Settings-page services: QR login orchestration and the options form.
  // Registered regardless of enabled so a disabled plugin can
  // still be configured and logged in from the UI before being turned on.
  //
  // Kept in a variable because the poll loop reports a refused session back to
  // it (markSessionExpired), which is what lets the card say "log in again"
  // instead of showing a healthy-looking bound account that receives nothing.
  //
  // Constructing a Cordis `Service` IS the registration: the base class calls
  // `ctx.reflect.provide(name, self, ...)` in its own constructor, so the
  // instance is reachable on the context immediately and is disposed with the
  // plugin's fiber. Do NOT also hand it to `ctx.plugin()` — a plugin must be a
  // function or an object with `apply`, and a service instance is neither, so
  // that call throws "invalid plugin, expect function or object with an "apply"
  // method, received object".
  //
  // That throw used to sit inside these try blocks, where it was recorded as
  // "settings login service unavailable" and the controller was set to
  // `undefined`. Nothing looked broken — the poll loop started, the card
  // rendered, a scan wrote a credential — but there was no controller left to
  // hear "the login finished", so the inbound loop never moved to the new
  // credential and WeChat kept reporting that it could not reach openclaw.
  // Resolve once for this plugin lifetime: the editor and AgentBridge must
  // share the effective profile/overlay directory and the same fallback.
  let workspaceDirectory
  const getWorkspaceDirectory = () => workspaceDirectory ??= resolveCwd(ctx, config, warn)
  let loginController
  try {
    loginController = new WeixinLoginController(ctx, { getWorkspaceDirectory })
  } catch (error) {
    warn(`settings login service unavailable: ${String(error)}`)
    loginController = undefined
  }
  // The settings form's view of every configurable option. It is handed the
  // *merged* config so the form can show effective values, and it reads the
  // saved overlay itself on every call — so a value written from the form, or
  // by hand while DSH is running, is reflected without a reload.
  let configController
  try {
    configController = new ConfigController(ctx, { config: baseConfig })
  } catch (error) {
    warn(`settings config service unavailable: ${String(error)}`)
    configController = undefined
  }
  // Constructing it IS the registration, so there is nothing else to do with
  // the reference here; it is kept for the effect below, which asserts the
  // service outlived the try block before anything tries to read options.
  if (configController === undefined) warn('the options form will not be available')

  ctx.effect(() => {
    let cancelled = false
    /**
     * One transport per bound account, keyed by accountId. Multi-account is
     * the steady state now: each account owns a long poll, its own deduper and
     * its own backoff, so one account's stall never blocks another's traffic.
     * The map replaces the single `transport` variable that assumed exactly
     * one account could be bound.
     * @type {Map<string, ILinkTransport>}
     */
    const transports = new Map()
    /** @type {AgentBridge | undefined} */
    let bridge
    /** @type {string} */
    let cwd
    let lockHeartbeat
    // Declared in apply() scope on purpose: bringUpLoop() builds the gate
    // closure and is a sibling of setup(), not a child of it.
    let senderLimiter
    /** Set in apply(); bringUpLoop() is a different function and grows its own closure. */
    let senderDailyLimiterFor = () => undefined
    // Serializes loop hand-offs across ALL accounts. A login can complete while
    // a previous hand-off is still tearing a transport down, and two live loops
    // on one credential deliver every inbound message twice — the server hands
    // it to whichever poll arrives first. One chain keeps the whole effect's
    // bring-up/tear-down operations strictly ordered.
    let handoff = Promise.resolve()

    // Working directory, agent bridge and voice bridge do not depend on which
    // account is bound, so they are built once and reused when a re-login swaps
    // the transport underneath them.
    //
    // Startup is async (working directory, account lookup, typing ticket, loop
    // start), but the effect disposer is synchronous-safe: it awaits the startup
    // promise, then tears down whatever got as far as existing.
    const setup = (async () => {
      cwd = await getWorkspaceDirectory()
      // A cosmetic rename, never allowed to fail bring-up.
      await ensureWorkspaceTitle(ctx, withSavedConfig(config), warn)
      bridge = new AgentBridge({
        ctx,
        cwd,
        sessionDispatcherConfig,
        onDispatchReply: async ({ accountId, conversationId, senderId, targetSessionId, text }) => {
          // Exact origin only. Never fall back to another bot or interpret
          // project output as attachments. Recheck after the async refresh.
          const allowed = (live) => live.enabled !== false && live.sessionDispatcherEnabled === true
            && Array.isArray(live.sessionDispatcherSenders) && live.sessionDispatcherSenders.includes(senderId)
            && Array.isArray(live.sessionDispatcherTargets) && live.sessionDispatcherTargets.includes(targetSessionId)
            && isAllowedSender(live, senderId, conversationId)
          if (!allowed(sessionDispatcherConfig())) return
          const transport = transports.get(accountId)
          if (!transport || !conversationId) throw new Error('Originating Weixin account is unavailable for dispatch notification.')
          if (isAccountPaused(accountId)) return
          try { await transport.refreshConfig() } catch {}
          const current = sessionDispatcherConfig()
          if (isAccountPaused(accountId) || transports.get(accountId) !== transport || !allowed(current)) return
          // #31: a parallel-session dispatch result is promised as plain text on
          // the durable text pipeline. Force rich content off here so a long
          // fenced code block stays inline instead of being swapped for a
          // snippet attachment whose upload can fail and drop the body. Ordinary
          // replies keep the user's richContent setting untouched.
          await sendChunked(transport, { ...current, richContent: false }, { conversationId, text, contextToken: '' })
        },
        progressAfterMs: config.progressAfterMs,
        progressToolAfterMs: config.progressToolAfterMs,
        progressEveryMs: config.progressEveryMs,
        maxWaitMs: config.maxTurnWaitMs,
        eventPollMs: config.eventPollMs,
        log,
        errLog: (line) => {
          warn(line)
          fileLog.warn(`dsh-weixin: ${redactSecrets(String(line))}`)
        },
        onSpontaneousReply: async ({ accountId: targetAccountId, conversationId: targetConvId, text: spontaneousText }) => {
          if (!spontaneousText || !String(spontaneousText).trim()) return
          const liveTransport = targetAccountId ? transports.get(targetAccountId) : undefined
          if (!liveTransport || cancelled || !gatewayEnabled() || isAccountPaused(targetAccountId)) {
            throw new Error('the originating account is unavailable for the reply')
          }
          const liveCfg = withSavedConfig(config)
          try {
            await liveTransport.refreshConfig()
          } catch {}
          if (cancelled || !gatewayEnabled() || isAccountPaused(targetAccountId) || transports.get(targetAccountId) !== liveTransport) {
            throw new Error('the originating account became unavailable for the reply')
          }
          const outbound = await resolveOutboundReply({
            config: liveCfg,
            transport: liveTransport,
            mediaDirs: allowedMediaDirs({ cwd, stateDir: stateRoot, allowedDirs: liveCfg.allowedMediaDirs }),
            stateRoot,
            reply: spontaneousText,
            conversationId: targetConvId,
            contextToken: '',
            warn,
            fileLog: vendorLogger,
          })
          await sendChunked(liveTransport, liveCfg, {
            conversationId: targetConvId,
            text: outbound.text,
            contextToken: '',
          })
          log(`spontaneous reply (e.g. subagent completion) delivered to ${targetConvId}`)
          vendorLogger.info(`spontaneous reply delivered to ${targetConvId}`)
        },
      })

      outbox = createOutbox({
        stateRoot,
        transportFor: (accountId) => !cancelled && gatewayEnabled() && !isAccountPaused(accountId) ? transports.get(accountId) : undefined,
        warn,
        log,
      })
      outbox.start()
      const liveLimiter = () => {
        const live = withSavedConfig(config)
        return createSenderLimiter({ perMinute: Number(live.senderRatePerMinute ?? DEFAULT_PER_MINUTE) || 1_000_000 })
      }
      senderLimiter = liveLimiter()
      // 每人每日配额：比「每分钟」更贴群的一层，按账号分开计。它读实时配置，
      // 所以设置卡改完下一次消息就生效。工厂存在模块级变量里是因为
      // bringUpLoop() 在另一个函数里，长得够不到这里的 const。
      senderDailyLimiterFor = (accountId, senderId) => createSenderDailyLimiter({
        stateRoot,
        limit: Number(withSavedConfig(config).senderDailyLimit ?? 0),
        warn,
      }).check(accountId, senderId)
      const lock = acquireInstanceLock(stateRoot, { warn })
      if (lock.acquired === false) {
        warn(
          `another DSH instance already writes this Weixin state (pid ${lock.holder.pid}). ` +
            'Both windows will poll the same account and overwrite each other\'s state; close one of them.',
        )
      } else {
        lockHeartbeat = setInterval(() => heartbeatInstanceLock(stateRoot), HEARTBEAT_MS)
        lockHeartbeat.unref?.()
      }

      configureOutbound({ outbox, warn, snippetsDir: statePaths(stateRoot).snippetsDir.absolute })

    })()
    // A disabled gateway has no startLoop awaiting setup, but setup failures
    // still need an observer and disposal must wait for its resources.
    void setup.catch((error) => warn(`gateway setup failed: ${String(error)}`))

    // Bring the loop up for one account (or every account on disk), replacing a
    // transport that is already running for it. Called for every account when
    // the plugin loads, and again for just the account whose login completed on
    // the settings card: a fresh install has no credential at load time (the
    // operator scans afterwards), and a re-bind replaces the previous token.
    // Without the second call the loop stays down until the next reload — the
    // "the phone says bound, but WeChat says it cannot reach openclaw" symptom.
    //
    // `wantedAccountId` selects the account; undefined means "every account
    // currently saved". One call touching one account must never blink another
    // account's live transport — that is why the map lookup happens per call
    // and why a per-account failure only skips that account.
    const bringUpLoop = async (wantedAccountId, { force = false } = {}) => {
      await setup
      if (!gateway.enabled()) return

      const accounts = await resolveAccounts(config, wantedAccountId, warn)
      if (accounts.length === 0) {
        // Say so rather than returning in silence. "Loaded, but nothing is
        // listening because no credential is saved yet" is the first thing an
        // operator needs when messages do not arrive, and an unlogged return
        // here is indistinguishable from a loop that started and then hung.
        if (!cancelled) log('no saved Weixin credential yet; nothing is being listened to')
        return
      }

      // Every account is an independent long poll: start them together instead
      // of making the second wait for the first handshake. `startAccounts`
      // keeps the per-account isolation — one bad credential is reported and
      // skipped, never blocking the rest.
      await startAccounts(accounts, (account) => bringUpAccount(account, { force }), warn)
    }

    /**
     * Arm (or re-arm) the long poll for exactly one account.
     *
     * `force` skips the same-credential dedup guard: the handler resolves the
     * account's allowlist once per bring-up, so a settings-card allowlist
     * change must re-arm even though the token is unchanged — otherwise the
     * override sits in the registry while the running handler keeps ruling
     * with the list it read when it came up.
     */
    const bringUpAccount = async (account, { force = false } = {}) => {
      const canStart = gateway.checkpoint(account.accountId)
      // The old transport sends notifyStop after its admitted turns finish.
      // A new notifyStart must not overtake that final stop handshake.
      await gateway.whenStopped(account.accountId)
      if (!canStart()) return
      const running = transports.get(account.accountId)
      // Nothing to do when the running loop already holds this credential: a
      // repeat call must not blink the connection, and the first call after a
      // login is the only one that has work to do.
      if (!force && running !== undefined && running.token === account.token) {
        log(`account ${account.accountId} is already being listened to; keeping the running loop`)
        return
      }

      const next = new ILinkTransport({
        accountId: account.accountId,
        // A conversation whose queue is full refuses new messages instead of
        // growing a backlog the user has already forgotten about.
        maxQueuePerConversation: Number(config.maxQueuedPerConversation ?? DEFAULT_MAX_QUEUE),
        baseUrl: account.baseUrl,
        token: account.token,
        // getConfig answers {ret:-2,"ilink_user_id required"} when the id is
        // empty, and the typing ticket it returns doubles as the fallback
        // context token for replies that arrive without one — so the bound
        // operator's id has to travel with the transport.
        userId: account.userId,
        // Explicit configuration wins over the account record, which in turn
        // wins over the upstream default. The schema default is the empty
        // string precisely so "unset" stays distinguishable here: a real
        // default would make this fallback unreachable and silently pin every
        // install to the production CDN root.
        //
        // Whitespace is normalized to "unset" first. `||` treats "   " as
        // truthy, so a YAML `cdnBaseUrl:` with trailing spaces would otherwise
        // win the whole chain, discard a perfectly good account record, and
        // fail later as `Failed to parse URL from    /upload?...`. The account
        // side already trims (vendor .../auth/accounts.js), and so do cwd and
        // accountId above; this keeps the three consistent.
        cdnBaseUrl: config.cdnBaseUrl?.trim() || account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
        // Outbound pacing. Both values are schema-validated (positive numbers),
        // so they can be handed over as-is; the transport falls back to the
        // pacer module's defaults when a caller omits them (tests, bin/ scripts).
        sendIntervalMs: config.sendIntervalMs,
        sendCooldownMs: config.sendCooldownMs,
        // Audio as voice bubbles. Default off: the server accepts a bot
        // voice_item (ret=0) without delivering it, which would swallow the
        // attachment — an operator opts in (schema description has the
        // measurements). The transport still degrades to a file send when a
        // voice upload/send is REJECTED.
        // `/cancel` must reach the bridge while the turn it targets is still
        // running. Every other message is queued in conversation order by the
        // transport; this one skips the queue for the obvious reason.
        bypassQueue: (message) => message?.type === 'text' && isInterruptCommand(message.text),
        // Transport internals (send outcomes, voice fallbacks) go to the host
        // logger AND the weixin log file the operator actually watches. Before
        // 2026-10-26 only the host logger got them, and diagnosing a "did the
        // voice even go out?" question meant finding out no transport line had
        // ever been written anywhere readable.
        log: (line) => {
          log(line)
          fileLog.info(`dsh-weixin: ${line}`)
        },
        errLog: (line) => {
          warn(line)
          fileLog.warn(`dsh-weixin: ${line}`)
        },
        // An expired session stops inbound messaging with no other symptom —
        // the plugin looks healthy and simply never replies. Record it on the
        // login controller so the settings card can say "log in again", and put
        // the same line in the log the operator watches.
        onSessionRejected: (error) => {
          try {
            loginController?.markSessionExpired?.(account.accountId)
          } catch {
            // the card is a convenience; never let it break the loop's report
          }
          warn(
            error.sessionExpired
              ? `Weixin session expired for ${account.accountId}: log in again from Settings and reload DSH`
              : `Weixin session rejected for ${account.accountId} (${error.message}): log in again, then reload`,
          )
        },
      })
      // The typing ticket doubles as the fallback context token for replies
      // that arrive without one; refreshing it once per loop start is enough.
      await next.refreshConfig()
      if (!canStart()) return

      // iLink can redeliver a message after a reconnect; the cache is bounded
      // so a long-running bot does not grow without limit.
      const seen = new MessageDeduper()
      const handler = createInboundHandler({
        config,
        accountId: account.accountId,
        transport: next,
        bridge,
        seen,
        log,
        warn,
        fileLog,
        stateRoot,
        // Resolved once: the allowlist is a property of the deployment, not of
        // the message, and re-resolving per reply would re-stat every directory.
        mediaDirs: allowedMediaDirs({ cwd, stateDir: stateRoot }),
        senderGate: (senderId) => senderLimiter.check(`${account.accountId}|${senderId}`),
        // 每日配额在账号维度上另算：同一个人在不同账号下各有自己的额度。
        senderDailyGate: (senderId) => senderDailyLimiterFor(account.accountId, senderId),
      })

      const previous = transports.get(account.accountId)
      transports.set(account.accountId, next)
      if (previous !== undefined) {
        // Stop before start, never the other way round. The server hands each
        // message to whichever poll asks first, so two live long-polls on one
        // credential split the inbound queue between them instead of
        // duplicating it — half the messages would land on a loop whose reply
        // path is already being torn down.
        await previous.stop().catch((error) => warn(`transport stop failed: ${String(error)}`))
      }
      // The transport already isolates per-message failures, so no extra catch
      // here: an error must not be reported twice or swallowed twice.
      if (!canStart()) {
        if (transports.get(account.accountId) === next) gateway.stopAccount(account.accountId)
        return
      }
      await next.start(gateway.wrapInbound(account.accountId, handler))
      if (!canStart()) {
        if (transports.get(account.accountId) === next) gateway.stopAccount(account.accountId)
        return
      }
      log(`listening as account ${account.accountId} (state: ${stateRoot})`)
    }

    // One hand-off at a time. A login can complete while the previous hand-off
    // is still tearing its transport down, and interleaving them would leave two
    // loops running or none.
    const startLoop = (wantedAccountId, { force = false } = {}) => {
      const run = handoff.then(
        () => bringUpLoop(wantedAccountId, { force }),
        () => bringUpLoop(wantedAccountId, { force }),
      )
      handoff = run.then(
        () => {},
        () => {},
      )
      return run
    }

    const gateway = createGatewayControl({
      isEnabled: gatewayEnabled,
      isPaused: isAccountPaused,
      isDisposed: () => cancelled,
      transports,
      startLoop,
      warn,
    })
    const onConfigChanged = () => gateway.sync()
    if (configController !== undefined) configController.onConfigChanged = onConfigChanged

    // A completed login writes a credential this loop has not read yet. Coming
    // up now is the whole difference between "scan, then reload DSH" and
    // "scan" — the operator has already been told the phone shows bound, and
    // WeChat is still saying it cannot reach openclaw. Only the account that
    // just bound is (re-)armed: the other accounts' live transports must not
    // blink because somebody logged into a second WeChat bot.
    const onAccountBound = (accountId) => {
      // A disabled plugin must not begin listening even if a scan completes:
      // `enabled` is the operator's switch, and a login is not a re-enabling
      // action. The credential is still saved, so turning the plugin back on
      // picks it up without a second scan.
      if (!gateway.enabled()) {
        log('a login completed while the plugin is disabled; not starting the loop')
        return
      }
      startLoop(accountId).catch((error) => warn(`restart after login failed: ${String(error)}`))
    }
    if (loginController !== undefined) loginController.onAccountBound = onAccountBound

    // Pause/resume from the settings card. Pausing must take effect now, not on
    // the next reload — an operator who pauses an account is usually stopping
    // noise *this minute* — so pause stops that account's transport here; resume
    // brings the loop straight back up. `accountId` travels with the call so one
    // card action never touches another account's live transport.
    const onAccountControlChange = (accountId) => {
      const id = typeof accountId === 'string' ? accountId.trim() : ''
      if (id === '') return
      if (isAccountPaused(id)) {
        gateway.stopAccount(id)
        log(`account ${id} paused; its inbound loop is stopped`)
      } else if (gateway.enabled()) {
        // Forced: the resume may also follow an allowlist change (the card's
        // allowlist method lands here), and the handler resolves that list once
        // per bring-up — a same-credential resume must still rebuild it.
        startLoop(id, { force: true }).catch((error) => warn(`resume after unpause failed: ${String(error)}`))
      }
    }
    if (loginController !== undefined) loginController.onAccountControlChange = onAccountControlChange

    const started = gateway.sync().catch((error) => warn(`startup failed: ${String(error)}`))

    return async () => {
      cancelled = true
      // Stop scheduling before transports. A callback already in flight may
      // finish, but its stopped scheduler will not commit or retry the result.
      await setup.catch(() => {})
      await gateway.sync()
      outbox?.stop()
      if (lockHeartbeat !== undefined) clearInterval(lockHeartbeat)
      releaseInstanceLock(stateRoot)
      if (loginController !== undefined && loginController.onAccountBound === onAccountBound) {
        // The controller outlives this effect when the card is left mounted, so
        // the hook is cleared rather than left pointing at a dead loop.
        loginController.onAccountBound = undefined
      }
      if (loginController !== undefined && loginController.onAccountControlChange === onAccountControlChange) {
        loginController.onAccountControlChange = undefined
      }
      if (configController !== undefined && configController.onConfigChanged === onConfigChanged) {
        configController.onConfigChanged = undefined
      }
      await started.catch((error) => warn(`startup failed: ${String(error)}`))
      await handoff.catch(() => {})
      // Every account gets its own stop, and one failure must not skip the
      // rest — a teardown that dies on the first account would leave every
      // later account's long poll running past the plugin unload.
      for (const [id, t] of transports) {
        transports.delete(id)
        await t.stop().catch((error) => warn(`transport stop failed for ${id}: ${String(error)}`))
      }
      await gateway.drain()
      await bridge?.dispose().catch((error) => warn(`session teardown failed: ${String(error)}`))
    }
  }, 'dsh-weixin/listen')
}

/**
 * Decide the working directory the agent runs in.
 *
 * The session header's `cwd` is not cosmetic: the prompt assembly reads it back
 * through the `{{cwd}}` variable, so a session created without one fails its
 * first turn outright ("prompt variable {{cwd}} has no value").
 *
 * An empty config therefore means "the Weixin group", not "no cwd": DSH groups
 * sessions by working directory, so defaulting to the deployment's own cwd would
 * mix these conversations into the profile's group. {@link ensureSessionsDir}
 * gives every Weixin conversation one shared home instead.
 *
 * A directory that cannot be created falls back to the process directory, since
 * a usable agent beats a dead turn.
 *
 * @param {any} ctx
 * @param {{ cwd?: string }} config
 * @param {(line: string) => void} warn
 * @returns {Promise<string>}
 */
async function resolveCwd(ctx, config, warn) {
  const configured = config.cwd?.trim()
  if (configured !== undefined && configured !== '') return configured
  try {
    return ensureSessionsDir()
  } catch (error) {
    warn(`could not create the Weixin sessions directory: ${String(error)}`)
  }
  try {
    const fs = ctx.get('fs')
    if (fs?.resolve !== undefined && fs?.processPath !== undefined) {
      return fs.processPath(await fs.resolve('.'))
    }
  } catch (error) {
    warn(`could not resolve the default working directory: ${String(error)}`)
  }
  return process.cwd()
}

/**
 * Give the Weixin conversations' dedicated workspace a human display title.
 *
 * DSH derives a Workspace's default title from its directory basename, so the
 * plugin's own workspace shows up as `sessions`. This renames that record at
 * bring-up. It is a silent no-op unless all of these hold:
 *
 *  - `workspaceTitle` is configured (empty keeps the folder name);
 *  - the plugin's own workspace ({@link sessionsDir}) exists and its current
 *    title is still the auto-derived folder name — a title the operator chose in
 *    the UI is never overwritten.
 *
 * No path is hardcoded: the directory comes from the state-dir accessor, so the
 * same code is correct under any profile or DSH_WEIXIN_STATE_DIR. A user who
 * points `cwd` at their own project keeps that project's workspace untouched;
 * the README tells the Agent how to configure `cwd` / `workspaceTitle`.
 *
 * @param {any} ctx
 * @param {{ workspaceTitle?: string }} config
 * @param {(line: string) => void} warn
 */
async function ensureWorkspaceTitle(ctx, config, warn) {
  const title = typeof config.workspaceTitle === 'string' ? config.workspaceTitle.trim() : ''
  if (title === '') return
  const dir = sessionsDir()
  const folderName = basename(dir)
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry?.resolveByPath === undefined) return
    const workspace = await registry.resolveByPath(dir)
    if (workspace === undefined) return
    if (folderName === '' || workspace.title !== folderName) return
    if (typeof workspace.setTitle !== 'function') return
    await workspace.setTitle(title)
  } catch (error) {
    warn(`could not set the Weixin workspace title: ${String(error)}`)
  }
}

/**
 * Load credentials for the accounts this bring-up pass should serve.
 *
 * `wantedAccountId` names one account (a completed login on the card); the
 * wildcard undefined means "every account on disk". The old single-account
 * rule — refuse to serve when several accounts exist but none is configured —
 * is gone: multi-account is the steady state, so every saved credential gets
 * its own loop unless a specific account was asked for.
 *
 * Returns [] (and logs) when nothing usable is saved; never throws for a
 * missing file, so a fresh install logs one actionable line instead of failing
 * plugin load.
 *
 * @param {{ accountId?: string }} config
 * @param {string | undefined} wantedAccountId
 * @param {(line: string) => void} warn
 * @returns {Promise<Array<{accountId: string, baseUrl: string, cdnBaseUrl: string | undefined, token: string, userId: string | undefined}>>}
 */
async function resolveAccounts(config, wantedAccountId, warn) {
  const { DEFAULT_BASE_URL, listWeixinAccountIds, loadWeixinAccount, resolveWeixinAccount } =
    await import('../vendor/openclaw-weixin/auth/accounts.js')

  // A configured account id still wins: the operator asked for exactly that
  // one. wantedAccountId (a just-completed login) narrows the pass to that
  // account too — other accounts' transports must not blink.
  const configured = config.accountId?.trim() || wantedAccountId?.trim() || ''
  const ids = configured !== '' ? [configured] : listWeixinAccountIds({})
  if (ids.length === 0) {
    warn(`no Weixin account is saved (expected under ${accountsDir()}); run the login command first`)
    return []
  }

  const accounts = []
  for (const accountId of ids) {
    const data = loadWeixinAccount(accountId)
    if (data === null || !data.token) {
      warn(`account "${accountId}" has no saved token (expected ${accountsDir()}/${accountId}.json); run the login command`)
      continue
    }

    // A paused account keeps its credentials but gets no loop: pausing is
    // "stop listening on purpose", not "log out". Logged, so an operator who
    // paused an account yesterday can tell deliberate silence from breakage.
    // `warn` because `log` only exists inside apply's closure — this module
    // function has never had it, and a ReferenceError here would be swallowed
    // by the caller's per-account catch as "could not start the loop",
    // disguising a deliberate pause as a broken credential.
    if (isAccountPaused(accountId)) {
      warn(`account "${accountId}" is paused; not starting its loop`)
      continue
    }

    // resolveWeixinAccount applies the upstream defaults and config overrides
    // (baseUrl, cdnBaseUrl, enabled) that the transport expects.
    let resolved
    try {
      resolved = resolveWeixinAccount({ channels: { 'openclaw-weixin': { accounts: { [accountId]: {} } } } }, accountId)
    } catch {
      resolved = undefined
    }
    accounts.push({
      accountId,
      baseUrl: data.baseUrl ?? resolved?.baseUrl ?? DEFAULT_BASE_URL,
      // The record's OWN CDN root, not a default. Deliberately only the saved
      // value: `resolveWeixinAccount` always fills in the upstream production
      // root, so consulting it here would make the caller's chain unable to tell
      // "the account chose this" from "nobody chose anything" — and would make
      // the caller's final fallback unreachable. Empty and whitespace-only values
      // mean "not set", hence `trim() ||` rather than `??`.
      cdnBaseUrl: data.cdnBaseUrl?.trim() || undefined,
      token: data.token,
      userId: data.userId,
    })
  }
  return accounts
}

/**
 * One inbound Weixin message through the whole pipeline.
 *
 * @param {object} params
 * @param {any} params.config
 * @param {ILinkTransport} params.transport
 * @param {AgentBridge} params.bridge
 * @param {import('./message/dedupe.js').MessageDeduper} params.seen
 * @param {(line: string) => void} params.log
 * @param {(line: string) => void} params.warn
 * @param {string} params.stateRoot  Weixin state root, for the media allowlist.
 * @param {string[]} params.mediaDirs  Directories a reply may reference.
 */
/**
 * Build the opt-in source block prepended to a turn's prompt when
 * `sourceContext` is enabled. Kept on one self-closing tag line so it is
 * cheap to strip by either the model or the operator.
 *
 * @param {{ senderId?: string, conversationId?: string, timestamp?: number, type?: string }} message
 * @returns {string}
 */
export function weixinSourceBlock(message) {
  const fields = [
    'channel="weixin"',
    `senderId="${String(message.senderId ?? '')}"`,
    `conversationId="${String(message.conversationId ?? '')}"`,
    `kind="${String(message.type ?? 'text')}"`,
  ]
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    fields.push(`timestamp="${new Date(message.timestamp).toISOString()}"`)
  }
  return `<weixin_source ${fields.join(' ')} />`
}

function createInboundHandler({ config, accountId, transport, bridge, seen, log, warn, fileLog, stateRoot, mediaDirs, senderGate, senderDailyGate }) {
  // The effective allowlist is per account: an account-level override in the
  // registry narrows (or replaces) the global list.
  // `accountId` is always set here (bringUpAccount passes it), but the
  // fallback keeps the helper's contract honest.
  //
  // Resolved per message, not captured once: `enrolFirstContact` writes the
  // registry, so a snapshot taken when the handler was built still says "no
  // allowlist" — which reset the effective config on the message AFTER the one
  // that enrolled, refusing the very sender who had just been let in until the
  // channel reconnected. The settings card edits the same registry, so a
  // capture would also make its changes wait for a restart.
  const resolveAccountConfig = ({ failClosed = false } = {}) => {
    const live = withSavedConfig(config)
    return { ...live, ...allowlistForAccount(accountId, live, { failClosed }) }
  }
  // The handler reads the config for THIS message through this cell so a
  // first-contact enrolment takes effect on the very message that triggered it.
  const effectiveConfig = { current: resolveAccountConfig() }
  const personaCommands = (conversationId) => createSendCommands({
    conversationId, mediaDirs,
    ...(effectiveConfig.current.maxMediaBytes === undefined ? {} : { maxBytes: effectiveConfig.current.maxMediaBytes }),
    warn, sendMedia: (params) => transport.sendMedia(params),
  })
  return async (message) => {
    const receivedAt = Date.now()
    // iLink only honours an inbound `context_token` for about ten minutes after
    // the message arrives (issue #9); reusing it past that is answered with
    // `prepare failed`. A long turn, its progress notes and its final reply can
    // all outlive the window, which is exactly how they used to fall into the
    // durable outbox and die there (issue #21). `sendToken()` hands back the
    // inbound token while it is still safe and, once it is past the TTL, asks
    // the transport to refresh its typing ticket and returns `undefined` so the
    // send rides the no-token fallback path instead of a dead token.
    let tokenRefreshed = false
    const sendToken = async () => {
      const token = message.contextToken
      if (typeof token !== 'string' || token === '') return token
      if (Date.now() - receivedAt < CONTEXT_TOKEN_TTL_MS) return token
      if (!tokenRefreshed) {
        tokenRefreshed = true
        try {
          await transport.refreshConfig()
        } catch {}
      }
      return undefined
    }
    // Before anything reads the config for this message, resolve the account
    // authorization. The registry holds the
    // account-level authorization boundary, so an unreadable existing file is a
    // refusal, not an empty registry that falls back to the global allowlist.
    try {
      effectiveConfig.current = resolveAccountConfig({ failClosed: true })
    } catch (error) {
      if (!(error instanceof RegistryReadError)) throw error
      const detail = String(error?.message ?? error)

      warn(`refused message from ${message.senderId}: account authorization registry is unreadable at ${registryFile()}; restore or repair it before retrying (${detail})`)
      fileLog.info(`refused message from ${message.senderId}: account authorization registry is unreadable at ${registryFile()}; restore or repair it before retrying (${detail})`)
      // Nothing has been processed yet. The transport can release its claim
      // back to the durable queue under the gateway's existing contract.
      return INBOUND_NOT_ACCEPTED
    }
    // 1. Truly unknown item kinds (TOOL_CALL_*, anything the protocol adds
    //    later) still get one short notice rather than silence. Media kinds are
    //    NOT unsupported — they are normalized into descriptors by the transport
    //    and downloaded below, after authorization.
    if (message.unsupported !== undefined) {
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: createTranslator(effectiveConfig.current.locale).t('notice.unsupported', { kind: message.unsupported }),
        contextToken: message.contextToken,
      })
      return
    }

    // 1a-bis. Group policy (C14). The transport already turns a non-blank
    //        group_id into the conversation id; what was missing is that nothing
    //        downstream knew the difference, so the bot answered every message
    //        in a group chat. Ignored messages never reach the sender gate.
    const groupDecision = groupReplyPolicy(message, effectiveConfig.current, {
      botNames: [
        accountId,
        config.accountLabel ?? '',
        config.botName ?? '',
        ...String(config.groupBotNames ?? '').split(',').map((name) => name.trim()),
      ],
    })

    if (groupDecision.reply === false) {


      log(`group message ignored (${groupDecision.reason}) from ${message.senderId} in ${message.conversationId}`)
      return
    }

    // 1b. Per-sender pacing. The account-wide limiter protects the Weixin
    //     account from a ban; this protects the bot (and the token bill) from
    //     one person sending thirty messages into a running turn. A refused
    //     message is answered once per window — silence would read as a bug.
    const gate = typeof senderGate === 'function' ? senderGate(message.senderId) : undefined;
    if (gate !== undefined && gate.allowed === false) {

      if (gate.shouldWarn === true) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: createTranslator(effectiveConfig.current.locale).t('notice.rateLimited', {
            seconds: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)),
          }),
          contextToken: message.contextToken,
        }).catch(() => {})

      }
      return
    }

    // Daily limits are scoped to each account.
    const dailyGate = typeof senderDailyGate === 'function' ? senderDailyGate(message.senderId) : undefined
    if (dailyGate !== undefined && dailyGate.allowed === false) {

      if (dailyGate.shouldWarn === true) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: createTranslator(effectiveConfig.current.locale).t('notice.dailyLimited', {
            limit: dailyGate.limit,
          }),
          contextToken: message.contextToken,
        }).catch(() => {})

      }
      return
    }

    // 2. Authorization first: before dedupe, before a session exists, and —
    //    critically — before any download. An unauthorized sender must not be
    //    able to make this host issue requests to Tencent's CDN, so nothing
    //    below this point may run for a denied message.
    if (!isAllowedSender(effectiveConfig.current, message.senderId, message.conversationId)) {
      // Enrol only when no effective sender list is configured and this chat
      // is permitted. The first contact is not necessarily the scanner.
      const { allowedSenders = [], allowedChats = [] } = effectiveConfig.current
      let enrolled = false
      if (accountId && allowedSenders.length === 0 && (allowedChats.length === 0 || allowedChats.includes(message.conversationId))) {
        try {
          enrolled = enrolFirstContact(accountId, message.senderId, (line) => {
            log(`${line}`)
            fileLog.info(`dsh-weixin: ${line} (add more senders on the card or in the registry)`)
          })
        } catch (error) {
          if (!(error instanceof RegistryReadError)) throw error
          warn(error.message)
          fileLog.info(error.message)
          // Preserve the message as uncertain rather than replay possible side effects.
          throw error
        }
        if (enrolled) {
          // Re-resolve the effective config so the rest of this message runs
          // under the list that now contains the sender.
          const enrolledConfig = resolveAccountConfig({ failClosed: true })
          if (isAllowedSender(enrolledConfig, message.senderId, message.conversationId)) {
            effectiveConfig.current = enrolledConfig
          } else {
            // The enrolment did not actually authorize the sender (chat
            // allowlist still denies, say): refuse after all, do not pretend.
            enrolled = false
          }
        }
      }
      if (!enrolled) {
        // Log the refusal to the file logger too, with the full allowlist: the
        // rebind flow generates a fresh sender id per bot, so the most common
        // refusal is a stale allowedSenders entry, and this line is both the
        // diagnosis and the exact value the operator needs to paste into config.
        // Read through `effectiveConfig`, not the raw config: the line must
        // report the list the decision was actually made against.
        fileLog.info(
          `refused message from ${message.senderId} (conversation ${message.conversationId}): ` +
            `${denialReason(effectiveConfig.current, message.senderId, message.conversationId)}; ` +
            `allowedSenders=${JSON.stringify(effectiveConfig.current.allowedSenders ?? [])}`,
        )
        warn(`refused message from ${message.senderId}: ${denialReason(effectiveConfig.current, message.senderId, message.conversationId)}`)
        return
      }
    }

    // 3. Dedupe: iLink can redeliver a message after a reconnect.
    if (!seen.accept(message.id)) {
      log(`skipping duplicate message ${message.id}`)
      fileLog.info(`skipping duplicate message ${message.id} from ${message.senderId}`)
      return
    }

    // 3.5. Last-seen bookkeeping: the card shows "silent since" from this
    // timestamp, so it is written once a message is actually accepted — not on
    // every poll, which would make a busy loop mask a dead inbound path. A
    // registry write failure is a warning, never a dropped message.
    try {
      touchAccount(accountId, warn)
    } catch (error) {
      if (!(error instanceof RegistryReadError)) throw error
      warn(error.message)
      fileLog.info(error.message)
      // Dedupe has already run, so this cannot be
      // safely released for automatic replay.
      throw error
    }

    // 4. Session-control commands (`/new`, `/list`, `/use`) are answered by the
    //    plugin itself, before any media download or agent turn. A command must
    //    not cost a model turn: `/list` would otherwise burn context to print a
    //    list the plugin already knows, and `/new` would run in the very session
    //    it is meant to leave. Placed after the allowlist and dedupe so a
    //    refused or replayed message still cannot steer a conversation.
    //    `/status` additionally gets account-level facts read fresh here (the
    //    registry entry may have changed since this handler was built).
    const registryEntry = accountId ? readRegistry()[accountId] : undefined
    let durableCommandReply = true
    const commandReply = await bridge.handleCommand(message.conversationId, message.text, accountId, {
      handleOutbox: async retry => {
        // A receipt for a queue operation must not itself become a queued reply.
        durableCommandReply = false
        const t = createTranslator(effectiveConfig.current.locale).t
        const conversationId = message.conversationId
        if (!accountId || !conversationId || !outbox) return t('error.featureUnavailable')
        if (retry) {
          const result = await outbox.flush({ force: true, accountId, conversationId })
          return t('outbox.result', { unavailable: 0, ...result })
        }
        const count = outbox.pending().filter(item => item.accountId === accountId && item.conversationId === conversationId).length
        return t('outbox.pending', { count })
      },
      accountId,
      accountLabel: registryEntry?.label ?? null,
      paused: accountId ? isAccountPaused(accountId) : false,
      lastSeenAt: typeof registryEntry?.lastSeenAt === 'string' ? registryEntry.lastSeenAt : undefined,
      allowlist: {
        source: Array.isArray(registryEntry?.allowedSenders) && registryEntry.allowedSenders.length > 0 ? 'account' : 'global',
        senders: effectiveConfig.current.allowedSenders ?? [],
      },
      // 会话控制命令由 persona bundle 提供（状态目录只有这里知道）。
      persona: personaCommands(message.conversationId),
      t: createTranslator(effectiveConfig.current.locale).t,
    })
    if (commandReply !== undefined) {
      const replyText = commandReply
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: replyText,
        durable: durableCommandReply,
        contextToken: message.contextToken,
      })
      fileLog.info(`answered session command ${JSON.stringify(message.text.trim())} for ${message.conversationId}`)
      return
    }

    // Untrusted text first, and only it: any `weixin_` tag a user types is
    // neutralised here, before the plugin starts prepending blocks of its own
    // (src/message/fence.js). Later prepends are trusted and never touched.
    // 引用回复：被引用的那句话是别人写的，和用户消息一样先转义再拼进来。
    // 只引用不配文的消息（text 为空）也要能走到模型，否则「引用 + 表情」
    // 这类消息会被当成空消息回一句「没看懂」。
    const quoted = message.quote === undefined ? '' : neutralizeTags(quoteBlock(message.quote))
    const userText = neutralizeTags(message.text)
    const promptParts = () => [quoted, userText].filter((part) => part !== '')
    let prompt = promptParts().join('\n\n')
    if (Array.isArray(message.media) && message.media.length > 0) {
      // `transport.cdnBaseUrl` is already normalized at construction, so only
      // the config value needs trimming here (see the transport options above).
      const cdnBaseUrl = config.cdnBaseUrl?.trim() || transport.cdnBaseUrl || DEFAULT_CDN_BASE_URL
      const maxInboundMediaBytes = config.maxInboundMediaBytes ?? DEFAULT_MAX_INBOUND_MEDIA_BYTES
      /** @type {Array<Record<string, any>>} */
      const saved = []
      /** @type {Array<{ kind: string, reason: string, code: string }>} */
      const failures = []
      // The attachments in one message have nothing to do with each other, so
      // they download at the same time — three photos used to cost three round
      // trips back to back. The concurrency limit bounds network requests.
      const downloads = await mapWithConcurrency(message.media, INBOUND_DOWNLOAD_CONCURRENCY, (media) =>
        downloadInboundMedia({
          media,
          cdnBaseUrl,
          maxBytes: maxInboundMediaBytes,
          warn,
        }),
      )
      for (const [index, result] of downloads.entries()) {
        const media = message.media[index]
        if (result.ok) {
          log(`saved inbound ${result.kind} to ${result.path} (${result.bytes} bytes)`)
          saved.push(result)
        } else {
          warn(`inbound ${media.kind} download failed: ${result.reason}`)
          failures.push({ kind: media.kind, reason: result.reason, code: result.code })
        }
      }
      // `prompt` already contains the neutralized quote and caption. Keep
      // media-derived blocks separate so they are
      // appended to that context instead of replacing it. The caption is not
      // passed to describeInboundMedia: that would add the same user text a
      // second time, after the earlier neutralization step.
      const parts = []
      if (saved.length > 0) parts.push(describeInboundMedia(saved))
      // A failure with no caption and nothing saved is answered here rather
      // than by the agent: there is no content to reason about, only an error
      // to relay, and waking a full turn (with its model call) to repeat one
      // line back to the user would be a pointless expense and a slow reply.
      // With a caption — or with some attachments saved — the failure is folded
      // into the prompt instead, so the agent can answer the question the user
      // actually asked while mentioning what did not arrive.
      const nothingToReasonAbout = saved.length === 0 && (message.text ?? '') === '' && message.quote === undefined
      if (failures.length > 0 && !nothingToReasonAbout) parts.push(describeMediaFailures(failures))
      if (nothingToReasonAbout) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: `（${describeMediaFailures(failures)}）`,
          contextToken: message.contextToken,
        })
        return
      }
      prompt = [prompt, ...parts].filter((part) => part !== '').join('\n\n')
    }

    // Source context: the agent has no other way to know where a message came
    // from. Opt-in, because the block spends tokens on every turn and a
    // single-user deployment rarely needs it.
    if (config.sourceContext === true) {
      prompt = weixinSourceBlock(message) + (prompt === '' ? '' : `\n\n${prompt}`)
    }

    // 5. Drive the agent, then send the reply back in chunks.
    if (config.typingIndicator) await transport.setTyping(true, message.conversationId)
    try {
      const startedAt = Date.now()

      const reply = await bridge.deliver({
        conversationId: message.conversationId,
        accountId,
        text: prompt,
        // Keep the original sender for authorization of session dispatch.
        senderId: message.senderId,
        busyMessageMode: effectiveConfig.current.busyMessageMode,
        onProgress: async (note) => {
          // Ephemeral: a "still working" line is meaningful only right now, so
          // a failed send is dropped rather than queued (issue #21). `sendToken`
          // keeps even a late note deliverable on the tokenless path.
          await sendChunked(transport, config, {
            conversationId: message.conversationId,
            text: `（${note}）`,
            contextToken: await sendToken(),
            durable: false,
          })
        },
        // A turn that outlives the wait still owes the user its answer: the
        // notice goes out through the caller's context token, and the late
        // reply is delivered later with a freshly fetched typing ticket (the
        // original one is one-shot and long expired by then).
        onLateReply: async (late) => {
          if (late.kind === 'timeout-notice') {
            await sendChunked(transport, config, {
              conversationId: message.conversationId,
              text: createTranslator(effectiveConfig.current.locale).t('notice.longRunning'),
              contextToken: await sendToken(),
              durable: false,
            })
            return
          }
          await transport.refreshConfig()
          const outbound = await resolveOutboundReply({
            config,
            transport,
            mediaDirs,
            stateRoot,
            reply: late.text,
            conversationId: message.conversationId,
            contextToken: '',
            warn,
            fileLog,
          })
          await sendChunked(transport, config, {
            conversationId: message.conversationId,
            text: outbound.text,
            contextToken: '',
          })
          log(`late reply delivered for ${message.conversationId}`)
          fileLog.info(`late reply delivered to ${message.conversationId} after the wait gave up`)
        },
      })
      log(`turn settled in ${Date.now() - startedAt}ms for ${message.conversationId}`)

      fileLog.info(`accepted message ${message.id} from ${message.senderId} (conversation ${message.conversationId}); agent turn settled in ${Date.now() - startedAt}ms`)
      // A late reply already went out through onLateReply; sending the empty
      // text here would be a stray message.
      if (reply.late === true) return
      // A cancelled turn has nothing to say: `/cancel` already sent its own
      // receipt, and an empty chunk would be a blank bubble in the chat.
      if (reply.cancelled === true) {
        fileLog.info(`turn cancelled by user for ${message.conversationId}`)
        return
      }
      // Media first, text second: the send already degrades to text when an
      // upload fails, and everything the user is about to see is decided here.
      // A turn can settle minutes after it began; if its inbound token is past
      // the safe window, `sendToken()` refreshes the typing ticket and this
      // reply rides the tokenless path instead of failing into the outbox.
      const replyToken = await sendToken()
      const outbound = await resolveOutboundReply({
        config,
        transport,
        mediaDirs,
        stateRoot,
        reply: reply.text,
        conversationId: message.conversationId,
        contextToken: replyToken,
        warn,
        fileLog,
      })
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: outbound.text,
        contextToken: replyToken,
      })
    } catch (error) {
      warn(`turn failed: ${String(error)}`)
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: createTranslator(effectiveConfig.current.locale).t('error.processing', { reason: String(error) }),
        contextToken: await sendToken(),
      })
    } finally {
      if (config.typingIndicator) await transport.setTyping(false, message.conversationId)
    }
  }
}

/**
 * Turn one agent reply into what actually goes out: the referenced local files
 * uploaded and sent as attachments, plus the text that is left.
 *
 * This is the only place outbound media is triggered, and it is triggered by the
 * reply's own content — there is no tool the agent can call to send a file. The
 * rule, and its two gates, live in `src/media/outbound.js`:
 *
 *  1. the reply references a file (`![alt](path)` or a line that is just a path);
 *  2. that path resolves inside {@link mediaDirs} and is an existing regular file.
 *
 * A refusal or a failed upload never loses the answer: the reference stays in the
 * text and `deliverOutboundMedia` appends one line naming the file and why it did
 * not arrive. That ordering is deliberate — a caption the user can act on beats a
 * silently missing attachment.
 *
 * @param {object} params
 * @param {{ mediaEnabled?: boolean, maxMediaBytes?: number }} params.config
 * @param {ILinkTransport} params.transport
 * @param {string[]} params.mediaDirs
 * @param {string} params.stateRoot
 * @param {string} params.reply
 * @param {string} params.conversationId
 * @param {string} [params.contextToken]
 * @param {(line: string) => void} params.warn
 * @param {{ info: (line: string) => void }} [params.fileLog]  Durable record.
 * @returns {Promise<string>} text to send, with a failure note when applicable
 */
export async function resolveOutboundReply(params) {
  const text = params.reply ?? ''
  const fileLog = params.fileLog ?? { info: () => {} }
  if (params.config.mediaEnabled === false) return { text, sent: [] }
  try {
    const result = await deliverOutboundMedia({
      text,
      to: params.conversationId,
      contextToken: params.contextToken,
      allowedDirs: params.mediaDirs,
      cdnBaseUrl: params.transport.cdnBaseUrl,
      opts: {
        baseUrl: params.transport.baseUrl,
        token: params.transport.token,
        accountId: params.transport.accountId,
      },
      ...(params.config.maxMediaBytes === undefined ? {} : { maxBytes: params.config.maxMediaBytes }),
      // Every delivery decision is recorded durably, not only on the host
      // logger: `ctx.logger` drops levels depending on the host's exporter
      // config, and a refusal that leaves no trace is indistinguishable from a
      // detector that never matched — which is exactly how a relative-path
      // refusal stayed invisible.
      warn: (line) => {
        params.warn(line)
        fileLog.info(`outbound media: ${line}`)
      },
      // deliverOutboundMedia's send seam passes `to` (the peer id; see
      // OutboundMedia and deliverOutboundMedia in src/media/outbound.js), while
      // `sendMedia` names the same value `conversationId`. Forwarding
      // mediaParams verbatim dropped the peer id on the floor: every
      // plugin-driven attachment went out as `to=undefined`, the getUploadUrl
      // request lost `to_user_id`, and the server answered `{ret:-2}` — the
      // file never reached the upload path at all. Adapt the differing key.
      send: ({ filePath, to, contextToken, cdnBaseUrl }) =>
        params.transport.sendMedia({ filePath, conversationId: to, contextToken, cdnBaseUrl }),
    })
    if (result.sent.length > 0) {
      const names = result.sent.map((filePath) => filePath.split('/').pop()).join(', ')
      params.warn(`sent ${result.sent.length} outbound media file(s)`)
      fileLog.info(`sent ${result.sent.length} outbound media file(s): ${names}`)
    }
    return { text: result.text, sent: result.sent }
  } catch (error) {
    // deliverOutboundMedia is written not to throw; if a future edit breaks
    // that, the reply must still go out rather than the turn dying here.
    params.warn(`outbound media step failed, sending text only: ${String(error)}`)
    fileLog.info(`outbound media step failed: ${String(error)}`)
    return { text, sent: [] }
  }
}


