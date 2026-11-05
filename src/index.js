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
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { dirname, join, basename, resolve as resolvePath } from 'node:path'
import { configureWeixinStateDir, accountsDir, configFile, readSavedConfig, ensureSessionsDir, sessionsDir, inboxDir, stateDir, withSavedConfig } from './state.js'
import { quietDelay } from './message/quiet-hours.js'
import {
  MAX_TEMP_QUIET_MS,
  clearTempQuiet,
  describeTempQuiet,
  readTempQuiet,
  setTempQuiet,
  tempQuietDelay,
} from './message/temp-quiet.js'
import { buildDiagReport } from './message/diag.js'
import { MAX_RECENT_ERRORS, buildDiagExport } from './message/diag-export.js'
import { detectHostVersion, hostStatus } from './host-compat.js'
import { buildUsageReport } from './message/usage.js'
import { readBudget } from './budget.js'
import { createRequire } from 'node:module'
import { describeConfigEffect } from './config-effect.js'

// 服务端也要知道自己的版本（`/diag` 用），但 client.js 是浏览器入口，不能 import。
const PLUGIN_VERSION = createRequire(import.meta.url)('../package.json').version
import { DEFAULT_RETENTION, SWEEP_INTERVAL_MS, describeSweep, sweepRetention } from './message/retention.js'
import { DEFAULT_KEEP, createBackup } from './backup.js'
import { HEARTBEAT_MS, acquireInstanceLock, heartbeatInstanceLock, releaseInstanceLock } from './instance-lock.js'
import { createOutbox, formatOutbox, CONTEXT_TOKEN_TTL_MS } from './message/outbox.js'
import { createGatewayControl } from './gateway-control.js'
import { configureOutbound, sendChunked, sendProducedFiles } from './outbound.js'
import { channelFor } from './channel.js'
import { HOOK_POINTS, createHooks } from './hooks.js'
import { createMetrics, writeMetricsSnapshot } from './metrics.js'
import { ensureSecretModes, redactSecrets } from './credentials.js'
import { neutralizeTags } from './message/fence.js'
import { quoteBlock } from './message/quote.js'
import { readScope, scopedConfig } from './config-scope.js'
import { DEFAULT_MAX_QUEUE, DEFAULT_PER_MINUTE, createSenderLimiter } from './message/sender-limit.js'
import { createSenderDailyLimiter } from './message/sender-daily.js'
import { recordStranger } from './message/strangers.js'
import { keywordGate, keywordStats, parseKeywordRules } from './message/keyword-reply.js'
import { isAllowedSender, denialReason } from './security/allowlist.js'
import { ILinkTransport } from './transport/ilink.js'
import { AgentBridge } from './agent-bridge.js'
import './message/chunker.js'
import { appendJournal } from './message/journal.js'
import { appendToolAudit, readToolAudit } from './message/audit.js'
import { DEFAULT_SEND_INTERVAL_MS, DEFAULT_COOLDOWN_MS } from './message/rate-limit.js'

/**
 * Module-level outbound journal sink, wired once in setup (see sendChunked).
 * `sendChunked` is a module-level function with no apply scope, so the wiring
 * has to cross scopes exactly once — null before setup means "not recording".
 */
let journalOutboundRef = null

/** The durable outbox for undelivered text; set once the plugin's setup runs. */
let hooks
/** Counters the settings card reads (src/metrics.js); process lifetime only. */
let metrics
let metricsTimer
let knowledgeRefresher
/** ④ One audit line per unfamiliar shape per conversation, not one per message. */
const unknownItemSeen = new Set()
let outbox
/** 群聊摘要：内存里攒群消息，够一批就后台压成几行。 */
let groupSummaries
import { MessageDeduper } from './message/dedupe.js'
import './message/markdown.js'
import { extractUrls, fetchLinkText, describeLinkResults } from './message/links.js'
import { ReminderScheduler, parseWhen } from './message/scheduler.js'
import { createAwayCommands, readAway, noteMissed, buildAwayReply, awaySummary, clearAway } from './message/away.js'
import { createDraftCommands, readDraft } from './message/drafts.js'
import { createWebhookSender } from './webhook.js'
import { backgroundBudget, recordBackgroundCall } from './budget.js'
import { createListCommands } from './message/lists.js'
import { createHabitCommands } from './message/habits.js'
import { createMediaCommands, humanTime } from './message/media-archive.js'
import { startAccounts } from './startup.js'
import { createReadingCommands } from './message/reading.js'
import { createSendCommands } from './message/send-file.js'
import { SubscriptionScheduler, formatStamp } from './message/subscriptions.js'
import { allowedMediaDirs, deliverOutboundMedia, DEFAULT_MAX_MEDIA_BYTES } from './media/outbound.js'
import { AsrBridge, DEFAULT_ASR_TIMEOUT_MS, resolveAsrSettings } from './media/asr.js'
import { DEFAULT_DOCUMENT_CHARS, extractDocumentTextAsync } from './media/document.js'
import { resolveOcrSettings, extractImageText } from './media/ocr.js'
import { WeixinLoginController } from './login-remote.js'
import { AsrController } from './asr-remote.js'
import { ConfigController } from './config-remote.js'
import { isAccountPaused, touchAccount, allowlistForAccount, readRegistry, enrolFirstContact } from './account-registry.js'
import { mapWithConcurrency } from './concurrency.js'
// `/cancel` is the one message the transport must be able to deliver while a
// turn is still running; the predicate lives beside the parser so the two
// cannot drift apart.
import { isInterruptCommand, readLines, mostRecentConversationId } from './sessions.js'

import { startKnowledgeRefresh } from './message/knowledge-refresh.js'
import { groupReplyPolicy, isGroupMessage } from './message/groups.js'
import { classifyToolCall, noticeText } from './message/tool-guard.js'
import { createTranslator, resolveLocale } from './i18n.js'
import { routeFor, sideRouteFor } from './model-route.js'
import { readJournalRange, renderChatMarkdown, writeChatExport } from './message/chat-export.js'
import { createNotifyServer, DEFAULT_NOTIFY_PORT, ensureNotifyToken } from './notify.js'
import './message/dry-run.js'
import { describeUnknownItems, firstSighting } from './message/unknown-items.js'
import { statePaths } from './state-layout.js'
import { createGroupSummaries, groupSummaryPrompt } from './message/group-summary.js'
import { recordPromptComposition } from './message/prompt-composition.js'
import { recordUsage } from './message/usage-ledger.js'

import { cleanSpeechText, synthesizeVoiceFile, ttsPlatformSupported } from './media/tts.js'
// The vendored logger is the only channel guaranteed to land on disk at INFO:
// ctx.logger can drop levels depending on the host's exporter config, and a
// refusal that leaves no trace turns an allowlist mismatch into "the bot just
// ignores me" with nothing to grep afterwards.
import { logger as vendorLogger } from '../vendor/openclaw-weixin/util/logger.js'
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  downloadInboundMedia,
  downloadInboundVoice,
  describeInboundMedia,
  describeMediaFailures,
} from './media/inbound.js'

export const name = 'dsh-weixin'

/**
 * Directory this file was loaded from — the plugin package root (one level
 * above `src/`), in the repository, in a profile install, and in an npm install
 * alike. The shipped ASR bridge lives at `<root>/bin/asr-bridge.py`, and the
 * operator is invited to point `asr.args` at that path; using this as the
 * child's cwd makes a *relative* bridge path work too, regardless of the
 * directory the DSH host happened to be started in.
 */
const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 一条消息里的附件同时下载几个。
 *
 * 三张图串行是三次往返；并发到三能把它压到一次往返的量级。再高没有收益：
 * 入站消息很少带更多附件，而且每个附件都要落盘。
 */
const INBOUND_DOWNLOAD_CONCURRENCY = 3

/**
 * 文档抽取与 OCR 同时跑几个。
 *
 * 这两个都可能起子进程（OCR 桥、pdftotext），比下载贵得多，所以故意低于
 * 下载的并发度：宁可慢一点，也不要一次起十个进程把机器拖住。
 */
const INBOUND_EXTRACT_CONCURRENCY = 2

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
  voiceOutbound: z.boolean().default(false).description(
    'Send audio attachments (wav, mp3, m4a, ogg, flac, silk, ...) as Weixin voice messages instead of file attachments. wav and silk are transcoded in-process; the rest need ffmpeg on PATH. A voice send that FAILS falls back to the plain file path — but the iLink server currently ACCEPTS a bot voice_item (ret=0) without ever delivering it (measured 2026-06 and again 2026-10-26 with a fresh token; upload and send both succeed), so with this on an audio attachment can silently vanish. Off by default until the server actually delivers bot voice.',
  ),
  messageJournal: z.boolean().default(true).description('Record recent inbound and outbound messages (message journal, shown on the settings card).'),
  // C20: the conversation gets the good model; background work (summaries,
  // proactive lines, subscription fires) can be pointed at a cheaper route
  // without touching the chat. Empty means "whatever the session uses".
  chatProvider: z.string().default('').description('主对话模型 provider：留空沿用 DSH 当前会话模型。只填 provider 或只填 model 都不生效。'),
  chatModel: z.string().default('').description('主对话模型 model：和 chatProvider 一起填才生效。'),
  sideProvider: z.string().default('').description('后台任务模型 provider：/summary、/subscribe 到点、主动开口这类侧会话用它；留空则回落到记忆模型，再回落到会话模型。'),
  sideModel: z.string().default('').description('后台任务模型 model：和 sideProvider 一起填才生效。'),
  documentExtract: z.boolean().default(true).description('Extract the text of an inbound document (docx/txt/md/csv/json) into the turn, instead of only telling the model where it was saved. PDF needs the optional pdfjs-dist package; without it a PDF is only described by its path.'),
  ocrEnabled: z.boolean().default(false).description('Run an external OCR command on inbound images and put the text into the turn. Off by default: the plugin ships no OCR engine.'),
  ocrCommand: z.string().default('').description('Absolute path to an OCR executable. It is called with the image path as its only argument; stdout must be the text. A small wrapper script is the intended way to adapt tesseract or a cloud CLI.'),
  ocrTimeoutMs: z.number().default(20000).description('Kill the OCR command after this many milliseconds.'),
  ocrMaxChars: z.number().default(2000).description('Keep at most this many characters of OCR text per image.'),
  documentTextChars: z.number().min(200).max(20000).default(4000).description('How many characters of an inbound document to put into the prompt; the rest is cut with a note.'),
  knowledgeEnabled: z.boolean().default(false).description(
    '知识库：把文件放进 <state>/knowledge/<账号>/ 目录，聊天里问到相关内容时自动检索，并说清答案出自哪份文件。不需要任何命令。',
  ),
  knowledgeHits: z.number().min(1).max(8).default(3).description('一次最多注入几段知识库原文。'),
  ttsVoice: z.string().default('').description(
    '本地语音合成用的系统音色：macOS `say -v` 的名字（例如 Tingting、Meijia；`say -v ?` 可以列出来）。留空用系统默认音色。',
  ),
  groupChatEnabled: z.boolean().default(false).description('参加群聊：开启后才会在群里回话。默认关闭——一个对每条群消息都答的机器人，在真群里就是刷屏。私聊不受影响。'),
  groupSummaryEnabled: z.boolean().default(false).description('群聊上下文摘要：群里攒够 groupSummaryEvery 条消息后，用一次后台调用把最近聊的压成几行，下次被叫到时折进提示词。默认关闭——它每次都要花一次调用。'),
  groupSummaryEvery: z.number().min(4).max(100).default(12).description('攒多少条群消息做一次摘要（默认 12）。'),
  pricePer1kInputYuan: z.number().min(0).default(0).description('估算花费用：每千输入 token 多少元（0 表示不算钱，只显示 token）。'),
  pricePer1kOutputYuan: z.number().min(0).default(0).description('估算花费用：每千输出 token 多少元。'),
  usageAwarenessEnabled: z.boolean().default(false).description('把人设自己这个会话的消耗（估算 token / 元）写进提示词，让它有「我在花钱」的意识。'),
  groupReplyWhen: z.string().default('mention').description('群里什么时候回：mention 只答被叫到的时候，all 每条都答。iLink 不给 @ 列表，因此按首行里的机器人名字匹配。'),
  groupBotNames: z.string().default('').description('群里额外的称呼，用逗号分隔。iLink 不提供机器人的群昵称，想让「@小助手」生效就得在这里写上它。'),
  groupKeywords: z.string().default('').description('群关键词自动回复，每行一条：正则 => 回复。例如「^打卡$ => 打卡成功」。只在群里、只对白名单内的人生效；同一群同一条规则 60 秒内最多应一次；免打扰时段沉默。回复是模板，不走模型。'),
  videoFrames: z.boolean().default(true).description('收到视频时用本机 ffmpeg 抽几帧静图交给模型（模型读不了视频，但能看图）。需要的机器上装了 ffmpeg；抽帧失败只影响那一条视频的内容理解，文件照常保存。'),
  richContent: z.boolean().default(true).description('富内容：长代码块作为文件附件发出、Markdown 表格转成对齐文本。微信只有纯文本气泡，这两处是 Markdown 里最容易在纯文本里变形的东西。'),
  codeFileThreshold: z.number().min(200).max(20000).default(1200).description('代码块超过多少字就改成发文件；更短的留在气泡里（两行代码读起来比附件顺）。'),
  // C15: the plugin cannot veto a tool call (DSH exposes no approval hook to
  // plugins), so it does the honest half: tell the owner when a turn reaches
  // for something that writes, deletes or runs a command, while /cancel can
  // still stop whatever comes next.
  // C33: the catalogue covers user-visible chatter (command help, notices);
  // logs stay English because they are read in files by one operator.
  locale: z.string().default('zh').description('界面与微信里回复的语言：zh（中文，默认）或 en（English）。日志始终英文。'),
  toolNotices: z.boolean().default(true).description('危险工具提醒：Agent 要执行写文件、删文件、跑命令之类的工具时，先在微信里告诉你一声（/cancel 可中止后续步骤）。插件无法在工具执行前拦截，这一步可能已经跑了。'),
  quietHoursEnabled: z.boolean().default(false).description('免打扰时段：到点的定时发送（/remind 提醒和 /subscribe 订阅）若落在时段内，推迟到时段结束时发出。回复消息不受影响。'),
  quietHoursStart: z.string().default('23:00').description('免打扰开始时间，HH:mm（24 小时制）。'),
  quietHoursEnd: z.string().default('07:00').description('免打扰结束时间，HH:mm（24 小时制）；与开始时间相同视为未配置。'),
  senderRatePerMinute: z.number().min(0).default(DEFAULT_PER_MINUTE).description('每个发送者每分钟最多几条消息；0 表示不限。超过时回一句「慢一点」，并写审计。'),
  senderDailyLimit: z.number().min(0).default(0).description('每个发送者每天最多被回复几次（按账号分开算；0 表示不限）。到量后当天不再回应，并在群里也按人算。'),
  maxQueuedPerConversation: z.number().min(0).default(DEFAULT_MAX_QUEUE).description('单个会话允许排队等回复的消息条数；0 表示不限制。超过的直接拒收，避免越堆越多。'),
  retentionJournalDays: z.number().min(0).default(180).description('消息流水保留天数；0 表示不清理。设置卡「统计」页签显示磁盘占用。'),
  retentionAuditDays: z.number().min(0).default(90).description('工具审计保留天数；0 表示不清理。'),
  retentionMediaDays: z.number().min(0).default(30).description('收到的图片/文件/语音保留天数；0 表示不清理。'),
  retentionExportsDays: z.number().min(0).default(60).description('/export 导出的 Markdown 保留天数；0 表示不清理。'),
  retentionLogsDays: z.number().min(0).default(30).description('vendor 每日日志保留天数；0 表示不清理。'),
  dryRun: z.boolean().default(false).description('预演模式：让模型先给计划再动手，你回「执行」才真正执行。这不是强制拦截——插件拦不住工具调用，它只是让模型先说后做，所以危险工具提醒仍然同时生效。'),
  metricsExport: z.boolean().default(true).description('每 30 秒把指标写到状态目录的 metrics.json / metrics.prom，方便外部抓取（npm run metrics 读取）。'),
  backupEnabled: z.boolean().default(true).description('每天自动备份一次状态目录（记忆、人设、订阅、流水、账号）；备份在 <状态目录>/backups，含账号 token，别外传。'),
  backupKeep: z.number().min(1).max(60).default(DEFAULT_KEEP).description('保留最近几份自动备份；更旧的会被删掉。'),
  notifyEnabled: z.boolean().default(false).description('本地通知桥：开启后向 http://127.0.0.1:47832/notify POST 一句话就能推到你的微信（构建、备份、cron 用）。只绑回环地址、必须带 token、不经过模型。'),
  notifyPort: z.number().min(1).max(65535).default(DEFAULT_NOTIFY_PORT).description('通知桥监听端口；脚本里的 URL 要跟着改。'),
  notifyToken: z.string().default('').description('通知桥的 token；留空则首次启动自动生成，存在 <状态目录>/notify.json（0600），不要外传。'),
  webhookUrl: z.string().default('').description('出站 webhook：收到消息/回复发出时向这个 http(s) URL POST 一条 JSON。留空关闭。'),
  webhookSecret: z.string().default('').description('出站 webhook 的 HMAC 密钥；填了就带 X-Weixin-Signature: sha256=<hex>，对原始 body 签名。'),
  webhookTimeoutMs: z.number().default(5000).description('出站 webhook 的超时毫秒数；失败只记日志，不影响回复。'),
  awayAutoReply: z.string().default('').description('离开模式的自动回复；留空用「我现在不在，看到会回你～（大概 HH:mm 回来）」。'),
  mediaMaxBytes: z.number().min(0).default(0).description('入站媒体的总容量上限（字节）；超过就从最旧的开始删。0 表示不限。'),
  backgroundDailyLimit: z.number().default(0).description('每天允许的后台模型调用次数上限（订阅等后台任务都算）；0 表示不限。主对话不受影响。'),
  toolAudit: z.boolean().default(true).description(
    'Append one JSONL line per tool the agent runs (tool name, truncated arguments, which Weixin account/conversation/sender caused it, and whether the result carried an error) under <state>/audit/. Off by default nothing would ever answer "who ran that destructive tool yesterday"; a missing directory or a full disk only warns, it never fails a turn.',
  ),
  markdownMode: z
    .union([z.const('strip'), z.const('off')])
    .default('strip')
    .description('How to render the agent Markdown reply for WeChat: "strip" filters unsupported syntax, "off" sends it verbatim.'),
  busyMessageMode: z
    .union([z.const('queue'), z.const('steer')])
    .default('steer')
    .description('What happens to a message that arrives while a reply is still being written: "queue" waits and delivers it as the next turn, "steer" injects it into the running turn. "/steer <instruction>" always injects.'),
  sourceContext: z.boolean().default(false).description('Prepend a <weixin_source …> block to each prompt so the agent knows the message came from WeChat and who sent it.'),
  readLinks: z.boolean().default(true).description('When an inbound message contains http(s) links, fetch each one and fold the readable text into the prompt, so the agent can answer questions about the page. A link that fails to fetch is reported to the agent as one line, never as a failed message.'),
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
  autoSendFiles: z.boolean().default(false).description('Also deliver files the agent wrote into its working directory during a turn, even when the reply text never references them.'),
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
  asr: z
    .object({
      enabled: z.boolean().default(true).description('Transcribe inbound voice messages; false keeps them as SILK/WAV files only.'),
      command: z
        .string()
        .default('')
        .description(
          'Executable of a line-oriented ASR bridge (one JSON request per line on stdin, one JSON response per line on stdout). Empty disables transcription.',
        ),
      args: z.array(z.string()).default([]).description('Arguments passed to the ASR bridge executable.'),
      timeoutMs: z.number().default(DEFAULT_ASR_TIMEOUT_MS).description('Give up on one transcription after this many milliseconds.'),
      env: z
        .dict(z.string())
        .default({})
        .description('Extra environment for the ASR bridge, e.g. HF_HOME, DSH_WEIXIN_ASR_MODEL or DSH_WEIXIN_ASR_LANGUAGE.'),
      model: z
        .string()
        .default('')
        .description(
          'Whisper model location for transcription. A Hugging Face repo id (mlx-community/whisper-small-mlx) or an absolute path to a local model directory. Empty lets the ASR bridge default apply.',
        ),
      modelDir: z
        .string()
        .default('')
        .description(
          'Directory where downloadable voice models are stored and looked up. Empty defaults to ~/.dsh/weixin/asr-models.',
        ),
      hfProxy: z
        .string()
        .default('')
        .description(
          'Proxy for the model downloader (e.g. http://127.0.0.1:7897). HTTPS destinations are tunnelled with CONNECT. Leave empty to connect directly, which is what the default mirror needs. Set this only on a network that cannot reach the mirror at all: the download is then exactly as fast as the proxy, and no faster.',
        ),
      hfEndpoint: z
        .string()
        .default('https://hf-mirror.com')
        .description(
          'Endpoint the model downloader fetches from. Defaults to https://hf-mirror.com, which is reachable from mainland China without a proxy and serves weights at high speed. Set it to https://huggingface.co to use the official site, or to a corporate mirror. The download is a plain HTTP transfer: it is exactly as fast as the route to this host, and no faster.',
        ),
    })
    .default({})
    .description('Voice transcription through an external bridge process. Absent or empty command means voice notes are delivered as files.'),
})

/**
 * @param {any} ctx
 * @param {z.infer<typeof Config>} config
 */
/**
 * 记一次模型回合的消耗（估算）。
 *
 * token 由提示词与回复的字符数折算 —— 插件不在模型请求链路上，宿主的 usage
 * 分片不会经过我们，所以这是估不完的估算，只会小于账单；卡片的「账单」页签也
 * 必须这么写。模型名是「我们请求的那条路由」，不是宿主最终选用的那个。
 *
 * @param {string} stateRoot
 * @param {object} live  运行时配置（单价、路由都由使用者填写）
 * @param {(line: string) => void} warn
 * @param {{ kind: string, accountId: string, conversationId: string, prompt?: string,
 *   reply?: string, route?: { provider?: string, model?: string } }} usage
 */
function recordModelUsage(stateRoot, live, warn, { kind, accountId, conversationId, prompt, reply, route }) {
  // 一条路由只有 provider 与 model 都填了才真的生效（同 schema 的说明），
  // 所以账本也按同样的规则写名字：只填一半等于没填，记成「默认」。
  const pair = (provider, model) =>
    typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
      ? `${provider}/${model}`
      : ''
  const requested = typeof route?.model === 'string' && route.model !== ''
    ? pair(route.provider ?? live.sideProvider, route.model)
    : kind === 'chat'
      ? pair(live.chatProvider, live.chatModel)
      : pair(live.sideProvider, live.sideModel)
  try {
    recordUsage(stateRoot, {
      accountId,
      conversationId,
      route: kind,
      model: requested === '' ? '默认' : requested,
      prompt: typeof prompt === 'string' ? prompt : '',
      reply: typeof reply === 'string' ? reply : '',
      warn,
    })
  } catch (error) {
    warn(`usage ledger write failed: ${String(error)}`)
  }
}

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

  // Settings-page services: QR login orchestration, ASR model management, and
  // the options form. Registered regardless of enabled so a disabled plugin can
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
  // Kept in a variable because the settings UI can change the model directory
  // at runtime (setModelDir); the ASR bridge must use the current value, not
  // the one the process started with.
  let asrController
  try {
    // Same as the login controller above: the Service constructor registers
    // itself, and passing the instance to `ctx.plugin()` throws. That throw used
    // to be swallowed here too, which silently disabled the whole ASR service.
    asrController = new AsrController(ctx, {
      modelDir: config.asr?.modelDir?.trim() || undefined,
      hfEndpoint: config.asr?.hfEndpoint?.trim() || undefined,
      hfProxy: config.asr?.hfProxy?.trim() || undefined,
    })
  } catch (error) {
    warn(`settings ASR service unavailable: ${String(error)}`)
    asrController = undefined
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
    // C15: one notice per tool per conversation per window. A turn that runs
    // ten bash commands is still one turn, and a stuck loop must not become a
    // stream of warnings.
    const noticedTools = new Map()
    /** Same tool, same conversation: stay quiet for ten minutes. */
    const TOOL_NOTICE_WINDOW_MS = 10 * 60_000
    /** @type {AgentBridge | undefined} */
    let bridge
    /** @type {AsrBridge | undefined} */
    let asrBridge
    /** @type {string} */
    let cwd
    let reminderScheduler
    let subscriptionScheduler
    let retentionTimer
    let notifyBridge
    let awayTimer
    /** @type {Array<() => void>} */
    const offWebhook = []
    const backupTimers = []
    let lockHeartbeat
    // Declared in apply() scope on purpose: bringUpLoop() builds the gate
    // closure and is a sibling of setup(), not a child of it.
    let senderLimiter
    /** Set in apply(); bringUpLoop() is a different function and grows its own closure. */
    let senderDailyLimiterFor = () => undefined
    // Same reachability trick: the inbound handler lives where the setup
    // scope's quietGate is out of reach, so the gate travels through a cell.
    let quietGateFor = (now, _accountId) => 0
    // C20: declared here (not inside setup) because bringUpAccount, which is a
    // sibling of setup(), hands it to createInboundHandler.
    let sideRoute = () => undefined
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
          try { await transport.refreshConfig() } catch {}
          const current = sessionDispatcherConfig()
          if (transports.get(accountId) !== transport || !allowed(current)) return
          // #31: a parallel-session dispatch result is promised as plain text on
          // the durable text pipeline. Force rich content off here so a long
          // fenced code block stays inline instead of being swapped for a
          // snippet attachment whose upload can fail and drop the body. Ordinary
          // replies keep the user's richContent setting untouched.
          await sendChunked(transport, { ...current, richContent: false }, { conversationId, text, contextToken: '' })
        },
        // 账本：桥每完成一个真正跑完的回合就报一次（谁会调用由它决定，写去哪
        // 由这里决定 —— 桥不认识 stateRoot）。
        onUsage: (usage) => recordModelUsage(stateRoot, withSavedConfig(config), warn, usage),
        progressAfterMs: config.progressAfterMs,
        progressToolAfterMs: config.progressToolAfterMs,
        progressEveryMs: config.progressEveryMs,
        maxWaitMs: config.maxTurnWaitMs,
        eventPollMs: config.eventPollMs,
        log,
        errLog: warn,
        // Tool audit lands on disk, not in the log: the log rotates away, and
        // the question this answers ("who triggered that tool, with what
        // arguments") is asked after the fact. Wired here rather than inside
        // the bridge so the bridge stays testable without a state root.
        ...(config.toolAudit === false
          ? {}
          : { onToolAudit: (entry) => appendToolAudit(stateRoot, entry, { warn }) }),
        // C15: the honest half of "approve tools in WeChat". The plugin cannot
        // veto a call, but it can say so while the turn is still running, and
        // /cancel stops everything after the call in flight. One notice per
        // tool per turn: a turn that runs ten bash commands is still one turn.
        // C20: the conversation's route, re-read per turn so a card edit lands
        // without restarting the plugin.
        chatRoute: () => routeFor('chat', withSavedConfig(config)),
        // ⑥ 后台预算：0 = 不限；读实时配置，卡片改完下一次调用就生效。
        allowBackground: () => {
          const live = withSavedConfig(config)
          const limit = Number(live.backgroundDailyLimit) || 0
          if (limit <= 0) return { allowed: true, used: 0, limit: 0 }
          return backgroundBudget(stateRoot, { limit, warn })
        },
        onBackgroundCall: () => recordBackgroundCall(stateRoot, { warn }),
        onToolCall: (entry) => {
          if (withSavedConfig(config).toolNotices === false) return
          const verdict = classifyToolCall({ tool: entry.tool, args: entry.args })
          if (verdict.dangerous === false) return
          const key = `${entry.conversationId}|${entry.sessionId}|${verdict.tool}`
          const seen = noticedTools.get(key)
          const bucket = seen === undefined || Date.now() - seen > TOOL_NOTICE_WINDOW_MS ? 0 : seen
          if (bucket !== 0) return
          noticedTools.set(key, Date.now())
          const liveTransport = transports.get(entry.accountId)
          if (liveTransport === undefined) return
          // Fire and forget: this runs inside the turn's event scan, so a slow
          // send must never hold the turn. The transport falls back to the
          // typing ticket when no context token is at hand.
          void sendChunked(liveTransport, withSavedConfig(config), {
            conversationId: entry.conversationId,
            text: noticeText(verdict, resolveLocale(withSavedConfig(config).locale)),
          }).catch((failure) => warn(`tool notice failed: ${String(failure)}`))
        },
        onSpontaneousReply: async ({ accountId: targetAccountId, conversationId: targetConvId, text: spontaneousText }) => {
          if (!spontaneousText || !String(spontaneousText).trim()) return
          const liveTransport = (targetAccountId ? transports.get(targetAccountId) : undefined) ?? [...transports.values()][0]
          if (!liveTransport) return
          const liveCfg = withSavedConfig(config)
          try {
            await liveTransport.refreshConfig()
          } catch {}
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

      // C20: background side sessions (subscriptions, proactive) get their own
      // route; without one they fall back to the host default, so a single cheap
      // model covers everything that is not the conversation.
      sideRoute = (purpose = 'side') => routeFor(purpose, config) ?? sideRouteFor(config)

      // Voice transcription is opt-in and out of tree: with no bridge configured
      // this stays undefined and voice notes are delivered as files, exactly as
      // they were before ASR existed. The process is started lazily by the first
      // voice message (model load costs seconds), so an unused install pays
      // nothing for it.
      const asrSettings = resolveAsrSettings(config, asrController?.modelDir, PLUGIN_ROOT)
      asrBridge =
        asrSettings === undefined ? undefined : new AsrBridge(asrSettings, { log: (line) => log(line), warn: (line) => warn(line) })
      if (asrBridge !== undefined) log(`voice transcription enabled via ${asrSettings.command}`)

      // 免打扰时段: the gate reads the LIVE config at fire time (the card can
      // flip the window mid-flight), reusing withSavedConfig so the saved
      // settings outrank the composition exactly like everywhere else.
      // One writer per state directory. A second DSH window used to overwrite
      // this one's files silently; now it says so once and carries on (the
      // writes are atomic, so the damage is bounded to last-writer-wins).
      // The outbox: a reply that could not be delivered is written to disk and
      // retried, because a reminder nobody receives is worse than one sent late.
      groupSummaries = createGroupSummaries({ stateRoot, warn })
    outbox = createOutbox({
        stateRoot,
        transportFor: (accountId) => transports.get(accountId),
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
      // The bus is built once per plugin start. Its first subscriber exists to
      // fix a real gap: refusals used to reach only the host logger, never the
      // log file the operator actually reads.
      hooks = createHooks({ warn })
      hooks.on(HOOK_POINTS.inboundRefused, (event) => {
        fileLog.info(`refused ${event.reason} message from ${event.senderId} in ${event.conversationId}`)
      })
      // Numbers, not log lines: every question about behaviour used to need a
      // grep. These four counters answer most of them, and the card reads the
      // snapshot (src/metrics.js keeps it in memory only).
      metrics = createMetrics()
      metrics.observe(hooks, {
        inboundAccepted: 'inbound.accepted',
        inboundRefused: 'inbound.refused',
        outboundSettled: 'outbound.settled',
        turnSettled: 'turn.settled',
      })
      if (loginController !== undefined) {
        loginController.metricsSnapshot = () => ({
          ...metrics.snapshot(),
          pendingOutbox: typeof outbox?.pending === 'function' ? outbox.pending().length : 0,
        })
      }
      if (loginController !== undefined) {
        loginController.outboxFlush = (options) => outbox.flush(options)
        loginController.outboxDropItem = (id) => outbox.drop(id)
      }
      // The registry lives in memory; this timer is the only thing that makes it
      // readable from outside the process. 30s matches what a local scraper
      // expects, and the two files are tiny. `npm run metrics` is the read side.
      metricsTimer = setInterval(() => {
        if (withSavedConfig(config).metricsExport === false) return
        void writeMetricsSnapshot(stateRoot, {
          ...metrics.snapshot(),
          gauges: { ...metrics.snapshot().gauges, 'outbox.pending': typeof outbox?.pending === 'function' ? outbox.pending().length : 0 },
        }).catch((error) => errLog(`metrics snapshot failed: ${String(error?.message ?? error)}`))
      }, 30_000)
      metricsTimer.unref?.()

      // 知识库：索引只在后台建，检索走热路径只读 index.json。启动先建一次，
      // 之后每 6 小时一次；nudge 让刚放进目录的文件不必等到下一个周期。
      if (withSavedConfig(config).knowledgeEnabled !== false) {
        knowledgeRefresher = startKnowledgeRefresh({
          stateRoot,
          accountIds: () => [...transports.keys()],
          warn,
          log,
        })
      }

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

      // 固定免打扰与临时静默是同一道闸：取两者中更晚的结束时刻。
      // accountId 由调度器在触发时传入；老调用点不传时只按固定时段判。
      const quietGate = (now, accountId) => Math.max(
        quietDelay(now, withSavedConfig(config)),
        tempQuietDelay(now, stateRoot, accountId, { warn }),
      )
      quietGateFor = quietGate

      // Retention: state grows all day; a nightly sweep keeps it bounded. It
      // runs once shortly after start (a laptop is not up at 03:00) and then
      // daily, unref'd so it never holds the host open.
      const retentionConfig = () => {
        const live = withSavedConfig(config)
        return {
          journalDays: Number(live.retentionJournalDays ?? DEFAULT_RETENTION.journalDays),
          auditDays: Number(live.retentionAuditDays ?? DEFAULT_RETENTION.auditDays),
          mediaDays: Number(live.retentionMediaDays ?? DEFAULT_RETENTION.mediaDays),
          exportsDays: Number(live.retentionExportsDays ?? DEFAULT_RETENTION.exportsDays),
          logsDays: Number(live.retentionLogsDays ?? DEFAULT_RETENTION.logsDays),
        }
      }
      const sweep = () => {
        try {
          const result = sweepRetention(stateRoot, { retention: retentionConfig(), warn })
          log(describeSweep(result))
        } catch (error) {
          warn(`retention sweep failed: ${String(error?.message ?? error)}`)
        }
      }
      // Backups: retention deletes old files on purpose, and nothing else keeps
      // a copy. One a day, a few minutes after the sweep so the two never fight
      // over the same files, and never blocking startup.
      const takeBackup = () => {
        try {
          const live = withSavedConfig(config)
          if (live.backupEnabled === false) return
          const result = createBackup(stateRoot, { keep: Number(live.backupKeep ?? DEFAULT_KEEP), warn })
          log(`backup ${result.id}: ${result.files} file(s)`)
        } catch (error) {
          warn(`backup failed: ${String(error?.message ?? error)}`)
        }
      }
      const firstBackup = setTimeout(takeBackup, 5 * 60_000)
      firstBackup.unref?.()
      backupTimers.push(firstBackup)
      backupTimers.push(setInterval(takeBackup, 24 * 60 * 60_000))
      for (const timer of backupTimers) timer.unref?.()

      const firstSweep = setTimeout(sweep, 60_000)
      firstSweep.unref?.()
      retentionTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
      retentionTimer.unref?.()

      reminderScheduler = new ReminderScheduler({
        stateRoot,
        warn,
        quiet: quietGate,
        fire: async (reminder) => {
          const transport = transports.get(reminder.accountId)
          if (transport === undefined) {
            warn(`reminder ${reminder.id} has no live transport for ${reminder.accountId}; dropped`)
            return
          }
          await sendChunked(transport, config, {
            conversationId: reminder.conversationId,
            text: `（提醒：${reminder.text}）`,
          })
          log(`reminder ${reminder.id} delivered to ${reminder.conversationId}`)
        },
      })
      if (loginController !== undefined) loginController.remindersProvider = reminderScheduler
      if (config.messageJournal === true) {
        journalOutboundRef = (entry) => appendJournal(stateRoot, { dir: 'out', ...entry }, { warn })
      }
      // Hand the send path its collaborators once, after both exist: the
      // journal sink above (null when journalling is off) and the outbox.
      configureOutbound({ journal: journalOutboundRef, outbox, hooks, warn, snippetsDir: statePaths(stateRoot).snippetsDir.absolute })

      // Scheduled proactive messages (/subscribe): the bot speaks first
      // through its own side session. The prompt re-uses the exact injection
      // blocks the reply path builds — persona mode, memory, the recent
      // window — so a proactive bubble sounds like the same entity the user
      // has been talking to, not a different bot.
      const subscriptionBusy = new Set()
      subscriptionScheduler = new SubscriptionScheduler({
        stateRoot,
        warn,
        quiet: quietGate,
        fire: async (item) => {
          const transport = transports.get(item.accountId)
          if (transport === undefined) {
            warn(`subscription ${item.id} has no live transport for ${item.accountId}; skipped`)
            return
          }
          if (subscriptionBusy.has(item.conversationId)) {
            warn(`subscription ${item.id} skipped: another fire is running for ${item.conversationId}`)
            return
          }
          subscriptionBusy.add(item.conversationId)
          try {
            const now = Date.now()
            const prompt = [
              `<weixin_subscription>`,
              `现在是 ${formatStamp(now)}。你之前和对方约定：到这个时间点，就由你主动给对方发一条消息，主题是「${item.prompt}」。`,
              `直接输出这条消息的正文，就像你在微信里自己发起的一条消息。不要复述或解释这个约定本身。`,
              `</weixin_subscription>`,
            ].join('\n')
            const result = await bridge.summarize({ conversationId: item.conversationId, accountId: item.accountId, prompt, sessionPrefix: 'wx-sub-', route: sideRoute('report') })
            const text = typeof result?.text === 'string' ? result.text.trim() : ''
            if (text === '' || text === '（已取消）') {
              log(`subscription ${item.id} produced nothing to send`)
              return
            }
            await sendChunked(transport, config, { conversationId: item.conversationId, text })
            log(`subscription ${item.id} delivered to ${item.conversationId}`)
          } finally {
            subscriptionBusy.delete(item.conversationId)
          }
        },
      })

      // 本地通知桥: a loopback endpoint so a build, backup or cron job can push
      // one sentence to WeChat without a model turn. Off by default; the token
      // is generated once, stored 0600 under the state root, never logged.
      if (withSavedConfig(config).notifyEnabled === true) {
        const notifyTokenValue = ensureNotifyToken(stateRoot, { configured: String(withSavedConfig(config).notifyToken ?? ''), warn })
        if (notifyTokenValue !== '') {
          notifyBridge = createNotifyServer({
            token: notifyTokenValue,
            port: Number(withSavedConfig(config).notifyPort ?? DEFAULT_NOTIFY_PORT),
            warn,
            send: async (text) => {
              const store = readLines()
              const accountId = [...transports.keys()].find((id) => mostRecentConversationId(id, store) !== undefined)
              if (accountId === undefined) throw new Error('no conversation has ever been spoken in')
              const conversationId = mostRecentConversationId(accountId, store)
              const transport = transports.get(accountId)
              if (transport === undefined || conversationId === undefined) throw new Error('the Weixin transport is not up yet')
              await sendChunked(transport, withSavedConfig(config), { conversationId, text })
            },
          })
          const boundPort = await notifyBridge.listen()
          if (boundPort !== undefined) log(`notify bridge listening on http://127.0.0.1:${boundPort}/notify (token in notify.json under the state root)`)
        }
      }

      // ⑤ 出站 webhook：订阅两个已经存在的 hook 点，把事件推给外部系统。
      //    失败只 warn；没有配置就完全不创建 sender。
      const webhookConfig = withSavedConfig(config)
      if (String(webhookConfig.webhookUrl ?? '').trim() !== '') {
        const sender = createWebhookSender({
          url: webhookConfig.webhookUrl,
          secret: typeof webhookConfig.webhookSecret === 'string' ? webhookConfig.webhookSecret : '',
          timeoutMs: webhookConfig.webhookTimeoutMs,
          warn,
        })
        if (sender === undefined) {
          warn(`webhook URL is not a usable http(s) URL: ${webhookConfig.webhookUrl}`)
        } else {
          offWebhook.push(hooks.on(HOOK_POINTS.inboundAccepted, (event) => void sender.send('message.received', event)))
          offWebhook.push(hooks.on(HOOK_POINTS.outboundSettled, (event) => void sender.send('reply.settled', event)))
          log('outbound webhook enabled')
        }
      }

      // 离开模式到点：把最后一个找过你的会话当收件箱，发一条汇总后关窗。
      // 一分钟的粒度对「离开两小时」足够；到点时不会顺带跑一轮模型。
      awayTimer = setInterval(() => {
        for (const [id, t] of transports) {
          const away = readAway(stateRoot, id, { warn })
          if (away === undefined || away.active) continue
          const last = away.missed[away.missed.length - 1]
          if (last !== undefined) {
            sendChunked(t, withSavedConfig(config), { conversationId: last.conversationId, text: awaySummary(away) })
              .catch((error) => warn(`away summary failed: ${String(error)}`))
          }
          clearAway(stateRoot, id, { warn })
        }
      }, 60_000)
      awayTimer.unref?.()

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
        ...(config.voiceOutbound === true ? { voiceOutbound: true } : {}),
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
            loginController?.markSessionExpired?.()
          } catch {
            // the card is a convenience; never let it break the loop's report
          }
          warn(
            error.sessionExpired
              ? `Weixin session expired for ${account.accountId}: log in again from Settings (or run bin/login.js), then reload`
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
        asrBridge,
        seen,
        log,
        warn,
        fileLog,
        stateRoot,
        // Resolved once: the allowlist is a property of the deployment, not of
        // the message, and re-resolving per reply would re-stat every directory.
        mediaDirs: allowedMediaDirs({ cwd, stateDir: stateRoot }),
        // The directory produced-file delivery scans after a turn (see
        // sendProducedFiles). The same value the agent bridge registers as the
        // workspace, so "what the agent wrote" is well defined.
        agentCwd: cwd,
        reminderScheduler,
        subscriptionScheduler,
        journalInbound: (entry) => appendJournal(stateRoot, { dir: 'in', ...entry }, { warn }),
        senderGate: (senderId) => senderLimiter.check(`${account.accountId}|${senderId}`),
        // 每日配额在账号维度上另算：同一个人在不同账号下各有自己的额度。
        senderDailyGate: (senderId) => senderDailyLimiterFor(account.accountId, senderId),
        // C20: side sessions (/\summary, subscriptions, proactive) use the
        // background route; the conversation keeps the chat route.
        sideRoute,
        quietGate: quietGateFor,
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
      await gateway.sync()
      await setup.catch(() => {})
      reminderScheduler?.stop()
      subscriptionScheduler?.stop()
      await notifyBridge?.stop()
      if (awayTimer !== undefined) clearInterval(awayTimer)
      for (const off of offWebhook.splice(0)) off()
      if (retentionTimer !== undefined) clearInterval(retentionTimer)
      for (const timer of backupTimers) clearTimeout(timer)
      outbox?.stop()
      if (metricsTimer !== undefined) clearInterval(metricsTimer)
      knowledgeRefresher?.stop()
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
      // Before the agent bridge: a transcription in flight is failed through the
      // ASR disposer, so the inbound handler stops waiting on it promptly.
      await asrBridge?.dispose().catch((error) => warn(`asr teardown failed: ${String(error)}`))
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
 * @param {AsrBridge} [params.asrBridge]
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

function createInboundHandler({ config, accountId, transport, bridge, asrBridge, seen, log, warn, fileLog, stateRoot, mediaDirs, agentCwd, reminderScheduler, subscriptionScheduler, journalInbound, senderGate, senderDailyGate, sideRoute, quietGate }) {
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
  const resolveAccountConfig = () => {
    const live = withSavedConfig(config)
    return { ...live, ...allowlistForAccount(accountId, live) }
  }
  // The handler reads the config for THIS message through this cell so a
  // first-contact enrolment takes effect on the very message that triggered it.
  const effectiveConfig = { current: resolveAccountConfig() }
  // Per-conversation overrides (config-scope.json) sit on top of the account
  // config for exactly one message. Re-read on every message so the card can
  // change a scope without a restart, and rebuilt from the account config so an
  // override never leaks into the next conversation.
  const applyScope = (conversationId) => {
    effectiveConfig.current = scopedConfig(resolveAccountConfig(), readScope(stateRoot, accountId, conversationId, { warn }))
  }
  // ⑦ `/diag export`：体检包要能发出去。所有 id 换别名、地址与凭据整段抹掉，
  // 然后写成 stateRoot 下的一个文件 —— 命令回复会走一遍出站附件管线，文件
  // 跟着文字一起发到当前会话，用户手边就有一份能直接转发的。
  const exportDiag = () => {
    const live = effectiveConfig.current
    // 只带失败的审计行：成功的那些对「为什么出问题」没有解释力，只会占篇幅。
    let recentErrors = []
    try {
      recentErrors = readToolAudit(stateRoot, { limit: 200 })
        .filter((entry) => entry.ok !== true)
        .slice(0, MAX_RECENT_ERRORS)
    } catch {
      recentErrors = []
    }
    const bundle = buildDiagExport({
      version: PLUGIN_VERSION,
      nodeVersion: process.version,
      hostVersion: detectHostVersion(),
      hostTested: hostStatus(detectHostVersion()).status === 'tested',
      accountId,
      accountLabel: effectiveConfig.current.accountLabel ?? undefined,
      transportUp: transport !== undefined,
      config: live,
      reminders: reminderScheduler?.list(accountId)?.length ?? 0,
      subscriptions: subscriptionScheduler?.list?.(accountId)?.length ?? 0,
      journalToday: readJournalRange(stateRoot, { accountId, days: 1 }).length,
      allowlist: Array.isArray(live.allowedSenders) ? live.allowedSenders.length : 0,
      quietDelayMs: quietDelay(Date.now(), live),
      recentErrors,
    })
    const dir = join(stateDir(), 'diag')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `diag-${stamp}.md`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, bundle.text, 'utf8')
    } catch (error) {
      warn(`diag export failed: ${String(error)}`)
      return `体检包写入失败：${String(error)}`
    }
    return `已导出体检包（${bundle.sections.length} 节，id 已换成短哈希、地址与凭据已抹掉）：\n${file}\n转发出去之前建议自己扫一眼。`
  }

  const personaCommands = (conversationId) => {
    return {
      // `/usage`：今天花了什么。不调模型，数字全部来自已有状态文件。
      usage: () => {
        const live = effectiveConfig.current
        const today = readJournalRange(stateRoot, { accountId, days: 1 })
        const chars = today.reduce((sum, entry) => sum + String(entry?.text ?? '').length, 0)
        let backgroundUsed = 0
        try {
          backgroundUsed = readBudget(stateRoot, { warn }).used
        } catch {
          backgroundUsed = 0
        }
        return buildUsageReport({
          backgroundUsed,
          backgroundLimit: Number(live.backgroundDailyLimit ?? 0),
          outboxPending: typeof outbox?.pending === 'function' ? outbox.pending().length : 0,
          reminders: reminderScheduler?.list(accountId)?.length ?? 0,
          subscriptions: subscriptionScheduler?.list?.(accountId)?.length ?? 0,
          journalEntries: today.length,
          journalChars: chars,
        })
      },
      // `/quiet`：有尽头的一段「别出声」。固定免打扰管每天同一时段，
      // 这里管开会/看电影这种临时两小时；到点自动恢复，不用记得关。
      quiet: (arg) => {
        const raw = String(arg ?? '').trim()
        if (raw === '') return describeTempQuiet(readTempQuiet(stateRoot, accountId, { warn }))
        if (/^(?:off|取消|关|恢复)$/i.test(raw)) {
          return clearTempQuiet(stateRoot, accountId, { warn }) ? '已恢复：自动回复和提醒都回来了。' : '本来就没有临时静默。'
        }
        const plan = parseWhen(raw)
        if (plan.ok !== true) return `没听懂「${raw}」。用法：/quiet 2h、/quiet 30m、/quiet off。`
        const span = plan.fireAt - Date.now()
        if (span < 60_000 || span > MAX_TEMP_QUIET_MS) return '静默时长要在 1 分钟到 24 小时之间。'
        const quiet = setTempQuiet(stateRoot, accountId, { until: plan.fireAt, warn })
        return `好，${describeTempQuiet({ ...quiet, setAt: Date.now() })}`
      },
      // `/outbox`：出站失败的那条消息去哪了、现在能不能补发。只读队列，不重排。
      outbox: async (arg) => {
        if (outbox === undefined) return '重发队列还没准备好（插件还在启动）。'
        const raw = String(arg ?? '').trim()
        if (raw === '') return formatOutbox(outbox.pending())
        if (/^(?:retry|重试)$/i.test(raw)) {
          const result = await outbox.flush({ force: true })
          return `已重试：发出 ${result.sent} 条，失败 ${result.failed} 条，还剩 ${result.remaining} 条。`
        }
        const drop = /^(?:drop|丢弃|删除)\s+(\S+)$/i.exec(raw)
        if (drop !== null) {
          return outbox.drop(drop[1]) ? `已丢弃 ${drop[1]}。` : `队列里没有 ${drop[1]}。`
        }
        return '用法：/outbox 查看 · /outbox retry 立即重试 · /outbox drop <id> 丢弃。'
      },
      // `/diag`：不调模型的一条自检。用户问「怎么没反应」时，先看闸门。
      diag: (arg) => {
        const action = String(arg ?? '').trim()
        if (/^(export|导出|打包)$/i.test(action)) return exportDiag()
        const live = effectiveConfig.current
        return buildDiagReport({
          version: PLUGIN_VERSION,
          accountId,
          transportUp: transport !== undefined,
          config: live,
          reminders: reminderScheduler?.list(accountId)?.length ?? 0,
          subscriptions: subscriptionScheduler?.list?.(accountId)?.length ?? 0,
          journalToday: readJournalRange(stateRoot, { accountId, days: 1 }).length,
          allowlist: Array.isArray(live.allowedSenders) ? live.allowedSenders.length : 0,
          quietDelayMs: quietDelay(Date.now(), live),
        })
      },
      // /export: render this conversation's journal as Markdown. Short
      // exports ride the normal reply; long ones land in
      // `<stateRoot>/exports/` and the reply carries the path (the settings
      // card's 消息流水 tab also has a one-click export).
      export: (rawDays) => {
        const days = Math.min(365, Math.max(1, Number(rawDays) || 30))
        const entries = readJournalRange(stateRoot, { accountId, conversationId, days })
        if (entries.length === 0) return `这个会话在最近 ${days} 天没有消息流水。`
        const markdown = renderChatMarkdown(entries, { title: `聊天记录 · ${conversationId} · 最近 ${days} 天` })
        if (markdown.length <= 3000) return markdown
        const file = writeChatExport(stateRoot, accountId, conversationId, markdown)
        return `聊天记录比较长（${entries.length} 条，${markdown.length} 字），已导出成文件：\n${file}\n完整内容也可以在设置卡「消息流水」页签里一键导出。`
      },
      // ⑥ 群关键词规则配在设置卡里，命中是静默的模板回复 —— 用户看不出哪条
      //    规则在干活、哪条写错了正则永远不响。这个命令把规则和计数一起摊开。
      config: () => {
        // 只描述规则：哪一项保存即生效、哪一项要重启。不读文件、不改任何东西。
        let savedAt
        try {
          savedAt = fs.statSync(configFile()).mtimeMs
        } catch {
          savedAt = undefined
        }
        return describeConfigEffect({
          fields: Object.keys(Config.dict ?? {}),
          configFile: configFile(),
          savedAt,
        })
      },
      keyword: (arg) => {
        const action = String(arg ?? '').trim()
        if (action !== '' && /^(stats|统计|命中)$/i.test(action) === false) {
          return '用法：/keyword stats（看每条群关键词规则的命中次数）'
        }
        const rules = parseKeywordRules(String(withSavedConfig(config).groupKeywords ?? ''), { warn })
        if (rules.length === 0) {
          return '还没有配置群关键词规则。设置卡的「群聊」页签里，每行一条：正则 => 回复。'
        }
        const stats = keywordStats(String(withSavedConfig(config).groupKeywords ?? ''), { warn })
        const lines = [`群关键词规则 ${stats.length} 条（命中次数是插件启动以来的累计）：`]
        for (const [index, entry] of stats.entries()) {
          // media-archive 的 humanTime 已经在别处用「今天 14:03 / 昨天」这套说法，
          // 同一个产品里不该有两种「多久以前」。
          const when = entry.lastAt === 0 ? '还没响过' : `最近一次 ${humanTime(entry.lastAt, { now: Date.now() })}`
          const cooled = entry.cooled > 0 ? `，另有 ${entry.cooled} 次因为冷却被吞` : ''
          lines.push(`${index + 1}. ${entry.source} → ${entry.reply.slice(0, 20)}${entry.reply.length > 20 ? '…' : ''}\n   命中 ${entry.triggered} 次${cooled} · ${when}`)
        }
        if (stats.every((entry) => entry.triggered === 0)) lines.push('（这些规则一次都没命中过：检查正则大小写、^$ 锚点，以及是不是只在群里生效）')
        return lines.join('\n')
      },
      ...createAwayCommands({ stateRoot, accountId, warn, parseWhen }),
      ...createListCommands({ stateRoot, accountId, warn }),
      ...createHabitCommands({ stateRoot, accountId, warn }),
      ...createDraftCommands({
        stateRoot,
        accountId,
        item: () => {
          const held = readDraft(stateRoot, accountId, { warn })
          return held === undefined ? undefined : { kind: held.kind, label: held.forLabel }
        },
        who: () => undefined,
        send: (text) => sendChunked(transport, effectiveConfig.current, { conversationId, text }),
        warn,
      }),
      say: async (arg) => {
        const spoken = String(arg ?? '').trim()
        if (spoken === '') return '用法：/say 要说的话 —— 用本机语音合成，发成音频（macOS 才带 `say`）。'
        if (!ttsPlatformSupported()) return `这台机器（${process.platform}）没有系统语音合成，/say 只在 macOS 上能用。`
        const liveConfig = effectiveConfig.current
        const speech = cleanSpeechText(spoken, { max: 300 })
        if (speech.text === '') return '这句话里没有可读的文字。'
        const made = await synthesizeVoiceFile(speech.text, { voice: liveConfig.ttsVoice })
        if (made.ok !== true) return `语音没合成出来：${made.reason}`
        try {
          await channelFor(transport).sendMedia({
            filePath: made.file,
            text: '',
            conversationId,
            cdnBaseUrl: transport.cdnBaseUrl,
          })
        } catch (error) {
          return `语音发送失败：${String(error?.message ?? error)}`
        } finally {
          try {
            fs.rmSync(made.file, { force: true })
          } catch {
            // 临时文件删不掉不是错误。
          }
        }
        const how = liveConfig.voiceOutbound === true ? '语音条' : '音频文件'
        fileLog.info(`sent /say voice (${speech.chars} chars) to ${conversationId}`)
        return `用本机音色合成好了，作为${how}发了出去（${speech.chars} 字${speech.truncated ? '，只念了前一段' : ''}）。`
      },
      ...createMediaCommands({
        dir: inboxDir(),
        conversationId,
        sendMedia: (params) => transport.sendMedia(params),
        maxBytes: Number(withSavedConfig(config).mediaMaxBytes ?? 0),
        clean: (days) => {
          const live = withSavedConfig(config)
          const window = days ?? Number(live.retentionMediaDays ?? DEFAULT_RETENTION.mediaDays)
          const result = sweepRetention(stateRoot, {
            retention: { journalDays: 0, auditDays: 0, mediaDays: window, exportsDays: 0, logsDays: 0 },
            warn,
          })
          return { removed: result.removed.length, bytes: result.bytes }
        },
        warn,
      }),
      ...createReadingCommands({ stateRoot, accountId, warn }),
      ...createSendCommands({
        conversationId,
        mediaDirs,
        ...(effectiveConfig.current.maxMediaBytes === undefined ? {} : { maxBytes: effectiveConfig.current.maxMediaBytes }),
        warn,
        sendMedia: (params) => transport.sendMedia(params),
      }),
    }
  }
  return async (message) => {
    // One timestamp for both the journal line and the recall exclusion, so the
    // message being answered can be recognised in the index without matching
    // on text alone.
    // ④ A passive listener for shapes the vendored client does not know: it cannot
    // render a link card, it can only tell us whether the server sends them.
    for (const line of describeUnknownItems(message)) {
      if (firstSighting(unknownItemSeen, line, `${message.conversationId}|${line}`)) {
        fileLog.info(`unfamiliar inbound shape: ${line}`)
        appendToolAudit(stateRoot, { tool: 'weixin/unknown-item', ok: true, summary: line })
      }
    }
    const journaledAt = Date.now()
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
      if (Date.now() - journaledAt < CONTEXT_TOKEN_TTL_MS) return token
      if (!tokenRefreshed) {
        tokenRefreshed = true
        try {
          await transport.refreshConfig()
        } catch {}
      }
      return undefined
    }
    // Before anything reads the config for this message: layer the
    // conversation's overrides (if any) onto the account config.
    applyScope(message.conversationId)
    if (config.messageJournal === true && message.type === 'text') {
      journalInbound?.({
        at: journaledAt,
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        text: message.text,
      })
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
    //        in a group chat. Ignored messages are journaled (the turn never
    //        happens) and counted, and they never reach the sender gate.
    const groupDecision = groupReplyPolicy(message, effectiveConfig.current, {
      botNames: [
        accountId,
        config.accountLabel ?? '',
        config.botName ?? '',
        ...String(config.groupBotNames ?? '').split(',').map((name) => name.trim()),
      ],
    })

    // 群聊上下文（C14-bis）：记下每一条群消息（不管有没有被点到），够一批就在
    // 后台压成几行；下次被叫到时那几行会折进提示词。默认关闭，因为一次后台调用
    // 就是一次钱。
    if (isGroupMessage(message) && effectiveConfig.current.groupSummaryEnabled === true && groupSummaries !== undefined) {
      groupSummaries.note(accountId, message.conversationId, { sender: message.senderId, text: message.text, at: Date.now() })
      const batch = groupSummaries.due(accountId, message.conversationId, Number(effectiveConfig.current.groupSummaryEvery ?? 12))
      if (batch.due && bridge !== undefined && batch.lines.length > 0) {
        const lines = batch.lines
        void bridge
          .summarize({
            conversationId: message.conversationId,
            accountId,
            prompt: groupSummaryPrompt(lines),
            sessionPrefix: 'wx-grp-',
            route: sideRoute?.(),
          })
          .then((result) => {
            if (result?.ok !== true || typeof result.text !== 'string' || result.text.trim() === '') return
            groupSummaries?.save(accountId, message.conversationId, { summary: result.text, covered: lines.length })
            fileLog.info(`group summary for ${message.conversationId} covers ${lines.length} messages`)
          })
          .catch((error) => warn(`group summary failed: ${error?.message ?? error}`))
      }
    }
    if (groupDecision.reply === false) {
      // 1a-ter. Group keyword auto-reply: the third group policy. It lives in
      // the declined branch (mention/all did not fire), still inside the group
      // gate, only for allowlisted senders, and it sends a template — no model
      // turn, no memory, no tools. Quiet hours silence it like proactive.
      const keywordRules = parseKeywordRules(String(effectiveConfig.current.groupKeywords ?? ''), { warn })
      const quietMs = typeof quietGate === 'function' ? quietGate(Date.now(), accountId) : 0
      const keyword = isAllowedSender(effectiveConfig.current, message.senderId, message.conversationId) && quietMs === 0
        ? keywordGate(keywordRules, message.text ?? '', message.conversationId)
        : null
      if (keyword !== null) {
        metrics?.inc('group.keyword', 1)
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: keyword.reply,
          contextToken: message.contextToken,
        })
        return
      }
      hooks?.emit(HOOK_POINTS.inboundRefused, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        reason: groupDecision.reason,
      })
      metrics?.inc('group.ignored', 1, groupDecision.reason)
      log(`group message ignored (${groupDecision.reason}) from ${message.senderId} in ${message.conversationId}`)
      return
    }

    // 1b. Per-sender pacing. The account-wide limiter protects the Weixin
    //     account from a ban; this protects the bot (and the token bill) from
    //     one person sending thirty messages into a running turn. A refused
    //     message is answered once per window — silence would read as a bug.
    const gate = typeof senderGate === 'function' ? senderGate(message.senderId) : undefined;
    if (gate !== undefined && gate.allowed === false) {
      // Observers (file log today, counters later) hear about refusals through
      // the bus instead of every call site growing its own logging.
      hooks?.emit(HOOK_POINTS.inboundRefused, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        reason: 'rate-limit',
      })
      if (gate.shouldWarn === true) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: createTranslator(effectiveConfig.current.locale).t('notice.rateLimited', {
            seconds: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)),
          }),
          contextToken: message.contextToken,
        }).catch(() => {})
        appendToolAudit(stateRoot, {
          at: new Date().toISOString(),
          tool: 'weixin/rate-limit',
          ok: false,
          summary: `sender ${message.senderId} is over the per-minute message limit (${gate.recent} in the last minute)`,
        }, { warn })
      }
      return
    }

    // 1b. 每人每日配额：比「每分钟」长一档，且按账号分开。它故意放在白名单
    //     之后、链接抓取与媒体下载之前 —— 被拒绝的人不该让这台机器再去请求
    //     任何外部地址。提示按窗口只发一次，拒绝写审计。
    const dailyGate = typeof senderDailyGate === 'function' ? senderDailyGate(message.senderId) : undefined
    if (dailyGate !== undefined && dailyGate.allowed === false) {
      hooks?.emit(HOOK_POINTS.inboundRefused, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        reason: 'daily-limit',
      })
      if (dailyGate.shouldWarn === true) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: createTranslator(effectiveConfig.current.locale).t('notice.dailyLimited', {
            limit: dailyGate.limit,
          }),
          contextToken: message.contextToken,
        }).catch(() => {})
        appendToolAudit(stateRoot, {
          at: new Date().toISOString(),
          tool: 'weixin/daily-limit',
          ok: false,
          summary: `sender ${message.senderId} reached the daily reply limit (${dailyGate.used}/${dailyGate.limit} on ${dailyGate.day})`,
        }, { warn })
      }
      return
    }

    // 2. Authorization first: before dedupe, before a session exists, and —
    //    critically — before any download. An unauthorized sender must not be
    //    able to make this host issue requests to Tencent's CDN, so nothing
    //    below this point may run for a denied message.
    if (!isAllowedSender(effectiveConfig.current, message.senderId, message.conversationId)) {
      // First contact enrolment: at scan time only the bot id is known — the
      // human's WeChat id first appears HERE, on the first inbound message.
      // So the very first sender an account without an allowlist override
      // hears is treated as the person who scanned (whoever scans owns the
      // account), enrolled into that account's own allowlist, and let
      // through. Every later stranger is refused exactly as before.
      let enrolled = false
      if (accountId) {
        const hasOverride = () => {
          const entry = readRegistry()[accountId]
          return (Array.isArray(entry?.allowedSenders) && entry.allowedSenders.length > 0) || Boolean(entry?.firstContactEnrolledAt)
        }
        enrolled = enrolFirstContact(accountId, message.senderId, hasOverride, (line) => {
          log(`${line}`)
          fileLog.info(`dsh-weixin: ${line} (the scanner's first message; add more senders on the card or in the registry)`)
        }, config.allowedSenders)
        if (enrolled) {
          // Re-resolve the effective config so the rest of this message runs
          // under the list that now contains the sender.
          const enrolledConfig = resolveAccountConfig()
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
        // Persist a bounded stranger audit trail for diagnostics even though
        // the simplified settings card no longer exposes a one-click allow.
        recordStranger(stateRoot, accountId, {
          senderId: message.senderId,
          conversationId: message.conversationId,
          text: message.text,
          warn,
        })
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
    touchAccount(accountId, warn)

    // 4. Session-control commands (`/new`, `/list`, `/use`) are answered by the
    //    plugin itself, before any media download or agent turn. A command must
    //    not cost a model turn: `/list` would otherwise burn context to print a
    //    list the plugin already knows, and `/new` would run in the very session
    //    it is meant to leave. Placed after the allowlist and dedupe so a
    //    refused or replayed message still cannot steer a conversation.
    //    `/status` additionally gets account-level facts read fresh here (the
    //    registry entry may have changed since this handler was built).
    const registryEntry = accountId ? readRegistry()[accountId] : undefined
    // /summary answers asynchronously (a side session); awaiting a plain
    // string is a no-op, so one call site covers both command shapes.
    const commandReply = await bridge.handleCommand(message.conversationId, message.text, accountId, {
      accountId,
      accountLabel: registryEntry?.label ?? null,
      paused: accountId ? isAccountPaused(accountId) : false,
      lastSeenAt: typeof registryEntry?.lastSeenAt === 'string' ? registryEntry.lastSeenAt : undefined,
      allowlist: {
        source: Array.isArray(registryEntry?.allowedSenders) && registryEntry.allowedSenders.length > 0 ? 'account' : 'global',
        senders: effectiveConfig.current.allowedSenders ?? [],
      },
      reminders: reminderScheduler,
      subscription: subscriptionScheduler,
      // 会话控制命令由 persona bundle 提供（状态目录只有这里知道）。
      persona: personaCommands(message.conversationId),
      t: createTranslator(effectiveConfig.current.locale).t,
    })
    if (commandReply !== undefined) {
      // ⑨ `/export` 的长记录会写成一个文件；命令回复以前只发正文，文件留在
      //    磁盘上，用户还得去设置卡里找。让命令回复也走一遍出站附件管线：
      //    路径必须落在 mediaDirs 内（exports 就在 stateRoot 下），由同一套
      //    resolveAllowedPath 判定，不是命令自带的特权。
      let replyText = commandReply
      if (/^\/export(?:\s|$)/i.test(message.text.trim())) {
        const withFile = await resolveOutboundReply({
          config: effectiveConfig.current,
          transport,
          mediaDirs,
          conversationId: message.conversationId,
          contextToken: message.contextToken,
          reply: commandReply,
          warn,
          fileLog,
        })
        replyText = withFile.text
      }
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: replyText,
        contextToken: message.contextToken,
      })
      fileLog.info(`answered session command ${JSON.stringify(message.text.trim())} for ${message.conversationId}`)
      return
    }

    // 4.2 离开模式：窗口内的消息在这里就被拦下，不进 agent —— 「不回消息」
    //     如果还走一遍模型，二十句「在吗」就是二十次调用。同一个会话每 30
    //     分钟回一句，免得对方以为被无视；其余记下来等 /back 一次交代。
    const awayNow = readAway(stateRoot, accountId, { warn })
    if (awayNow !== undefined && awayNow.active) {
      const missed = noteMissed(stateRoot, accountId, {
        senderId: message.senderId,
        conversationId: message.conversationId,
        text: message.text,
        at: Date.now(),
        warn,
      })
      const awayQuiet = tempQuietDelay(Date.now(), stateRoot, accountId, { warn }) > 0
      if (missed.shouldReply && !awayQuiet) {
        await sendChunked(transport, effectiveConfig.current, {
          conversationId: message.conversationId,
          text: buildAwayReply(awayNow, { reply: effectiveConfig.current.awayAutoReply }),
          contextToken: message.contextToken,
        })
        fileLog.info(`away auto-reply sent to ${message.conversationId}`)
      }
      return
    }

    // 4.5 Link enrichment: if the message carries URLs, fetch each one and
    //    fold the readable text into the prompt. A failed link NEVER fails the
    //    message — the agent gets a one-line reason instead, and the user's
    //    question still reaches the model. Best-effort by design: a dead host
    //    costs a bounded fetch, not the turn.
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
    const linkUrls = config.readLinks === true ? extractUrls(message.text) : []
    if (linkUrls.length > 0) {
      log(`fetching ${linkUrls.length} link(s) from inbound message ${message.id}`)
      // Concurrent, not serial: three dead hosts used to cost three deadlines
      // in a row before the user got an answer. Each fetch has its own 8s
      // deadline, and the batch has a budget on top so one slow host cannot
      // hold the turn open past it.
      const linkResults = await Promise.all(
        linkUrls.slice(0, 3).map((url) =>
          fetchLinkText(url).catch((error) => ({ ok: false, url, reason: `抓取失败：${String(error?.message ?? error)}` })),
        ),
      )
      const linkBlock = describeLinkResults(linkResults)
      // Fetched page text is as untrusted as the message itself: a page can
      // contain our tag syntax just as easily as a user can.
      if (linkBlock !== undefined) prompt = [...promptParts(), neutralizeTags(linkBlock)].join('\n\n')
    }
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
      // trips back to back. Bounded, because each one is a network request and
      // (for voice) possibly an ASR process.
      const downloads = await mapWithConcurrency(message.media, INBOUND_DOWNLOAD_CONCURRENCY, (media) =>
        (media.kind === 'voice' ? downloadInboundVoice : downloadInboundMedia)({
          media,
          cdnBaseUrl,
          maxBytes: maxInboundMediaBytes,
          bridge: asrBridge,
          extractFrames: effectiveConfig.current.videoFrames !== false,
          warn,
        }),
      )
      for (const [index, result] of downloads.entries()) {
        const media = message.media[index]
        if (result.ok) {
          log(
            `saved inbound ${result.kind} to ${result.path} (${result.bytes} bytes)` +
              (result.kind === 'voice' ? ` transcoded=${result.transcoded === true} transcribed=${typeof result.transcript === 'string'}` : ''),
          )
          saved.push(result)
        } else {
          warn(`inbound ${media.kind} download failed: ${result.reason}`)
          failures.push({ kind: media.kind, reason: result.reason, code: result.code })
        }
      }
      // `prompt` already contains the neutralized quote, caption and optional
      // link enrichment. Keep media-derived blocks separate so they are
      // appended to that context instead of replacing it. The caption is not
      // passed to describeInboundMedia: that would add the same user text a
      // second time, after the earlier neutralization step.
      const parts = []
      if (saved.length > 0) parts.push(describeInboundMedia(saved))
      // ② A document's text, not only its path: the model can answer "这份合同
      //    第三条写了什么" in the same turn. Anything unrecognised (pdf, images)
      //    falls back to the path-only description above.
      if (effectiveConfig.current.documentExtract !== false) {
        const docFiles = saved.filter((file) => file.kind === 'file' || file.kind === 'voice')
        const extractedDocs = await mapWithConcurrency(docFiles, INBOUND_EXTRACT_CONCURRENCY, async (file) => ({
          file,
          extracted: await extractDocumentTextAsync(file.path, {
            maxChars: effectiveConfig.current.documentTextChars ?? DEFAULT_DOCUMENT_CHARS,
          }),
        }))
        const docs = []
        for (const { file, extracted } of extractedDocs) {
          if (extracted.ok) {
            docs.push(`<weixin_document path="${file.path}">
${neutralizeTags(extracted.text)}
</weixin_document>`)
            log(`extracted ${extracted.kind} text from ${file.path} (${extracted.text.length} chars, truncated=${extracted.truncated})`)
          } else if (extracted.reason !== 'unsupported') {
            warn(`document extraction skipped for ${file.path}: ${extracted.reason}`)
          }
        }
        if (docs.length > 0) parts.push(docs.join('\n\n'))
      }
      // ④ 图片里的字：可选的外部 OCR 桥。没配置就完全跳过，图片仍按路径描述；
      //    识别失败只降级成「没有文字」，不让整个回合失败。
      if (effectiveConfig.current.ocrEnabled === true) {
        const ocrSettings = resolveOcrSettings(effectiveConfig.current)
        if (ocrSettings !== undefined) {
          // OCR spawns a process per image, so the width here is lower than the
          // download width on purpose.
          const images = saved.filter((file) => file.kind === 'image')
          const ocrResults = await mapWithConcurrency(images, INBOUND_EXTRACT_CONCURRENCY, async (file) => ({
            file,
            ocr: await extractImageText(file.path, ocrSettings),
          }))
          for (const { file, ocr } of ocrResults) {
            if (ocr.ok) {
              parts.push(`<weixin_ocr path="${file.path}">
${neutralizeTags(ocr.text)}
</weixin_ocr>`)
              log(`ocr read ${ocr.text.length} chars from ${file.path} (truncated=${ocr.truncated})`)
            } else if (ocr.code !== 'empty') {
              warn(`ocr skipped for ${file.path}: ${ocr.reason}`)
            }
          }
        }
      }
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

    recordPromptComposition(accountId, [
      { key: 'message', chars: prompt.length },
    ], { total: prompt.length, at: journaledAt })

    // 5. Drive the agent, then send the reply back in chunks.
    if (config.typingIndicator) await transport.setTyping(true, message.conversationId)
    try {
      const startedAt = Date.now()
      hooks?.emit(HOOK_POINTS.inboundAccepted, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
      })
      const reply = await bridge.deliver({
        conversationId: message.conversationId,
        accountId,
        text: prompt,
        // Who caused the turn, for the tool audit: the sender is the only party
        // an operator can hold responsible for a destructive tool call.
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
        onSpontaneousReply: async ({ conversationId: targetConvId, text: spontaneousText }) => {
          if (!spontaneousText || !String(spontaneousText).trim()) return
          try {
            await transport.refreshConfig()
          } catch {}
          const outbound = await resolveOutboundReply({
            config: effectiveConfig.current,
            transport,
            mediaDirs,
            stateRoot,
            reply: spontaneousText,
            conversationId: targetConvId,
            contextToken: '',
            warn,
            fileLog,
          })
          await sendChunked(transport, effectiveConfig.current, {
            conversationId: targetConvId,
            text: outbound.text,
            contextToken: '',
          })
          log(`spontaneous reply (e.g. subagent completion) delivered to ${targetConvId}`)
          fileLog.info(`spontaneous reply delivered to ${targetConvId}`)
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
          await sendProducedFiles({
            config,
            transport,
            mediaDirs,
            agentCwd,
            sinceMs: startedAt,
            alreadySent: outbound.sent,
            conversationId: message.conversationId,
            contextToken: '',
            warn,
            fileLog,
          })
          log(`late reply delivered for ${message.conversationId}`)
          fileLog.info(`late reply delivered to ${message.conversationId} after the wait gave up`)
        },
      })
      log(`turn settled in ${Date.now() - startedAt}ms for ${message.conversationId}`)
      hooks?.emit(HOOK_POINTS.turnSettled, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        ms: Date.now() - startedAt,
      })
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
      await sendProducedFiles({
        config,
        transport,
        mediaDirs,
        agentCwd,
        sinceMs: startedAt,
        alreadySent: outbound.sent,
        conversationId: message.conversationId,
        contextToken: replyToken,
        warn,
        fileLog,
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


