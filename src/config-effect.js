/**
 * 配置的生效时机。
 *
 * 设置卡保存会写进 `config.json`，但「写进去了」和「什么时候算数」不是一件事。
 * 这个模块把三件事分开说清楚：
 *
 *   - `live`：**下一条消息**或下一次周期动作就按新值走。热路径（会话命令、
 *     群聊、提醒闸门、保留策略……）重新读取存档配置，所以这些立刻生效。
 *   - `restart`：要等插件重新加载。transport/bridge 构造参数、长轮询间隔、ASR
 *     子进程、通知/webhook 监听与固定闭包里的值，改了不会自己重建。
 *   - `login`：改的是账号本身，要重新登录。
 *
 * 为什么要有这张表：改完设置发现「没反应」，最常见的原因不是没保存，而是改的
 * 那一项本来就属于重启才生效的那一类。
 *
 * 表必须覆盖 schema 的每一个字段：`test/config-effect.test.js` 拿
 * `Config.dict` 的实际字段名核对，漏项会直接失败，而不是悄悄归到「重启生效」。
 *
 * @module dsh-weixin/config-effect
 */

/** @typedef {'live' | 'restart' | 'login'} EffectKind */

/**
 * 每一项的生效时机。
 *
 * @type {Record<string, EffectKind>}
 */
export const CONFIG_EFFECTS = Object.freeze({
  // —— 保存即生效：消息热路径或周期任务会重读存档配置 ——
  // Compatibility note: `knowledgeHits`, `dryRun`, and `usageAwarenessEnabled`
  // remain `live` only because they still exist in Config and the table must be
  // schema-complete. No current runtime consumer is wired for them; this label
  // alone does not mean the feature works.
  'enabled': 'live',
  'sessionDispatcherEnabled': 'live', 'sessionDispatcherSenders': 'live', 'sessionDispatcherTargets': 'live', 'protectedSessions': 'live', 'readOnlyPaths': 'live',
  'allowedSenders': 'live', 'allowedChats': 'live',
  'chatProvider': 'live', 'chatModel': 'live', 'documentExtract': 'live',
  'ocrEnabled': 'live', 'ocrCommand': 'live', 'ocrTimeoutMs': 'live', 'ocrMaxChars': 'live', 'documentTextChars': 'live',
  'knowledgeHits': 'live',
  'ttsVoice': 'live',
  'groupChatEnabled': 'live', 'groupReplyWhen': 'live', 'groupKeywords': 'live',
  'groupSummaryEnabled': 'live', 'groupSummaryEvery': 'live',
  'pricePer1kInputYuan': 'live', 'pricePer1kOutputYuan': 'live', 'usageAwarenessEnabled': 'live',
  'videoFrames': 'live', 'locale': 'live',
  'toolNotices': 'live', 'quietHoursEnabled': 'live', 'quietHoursStart': 'live', 'quietHoursEnd': 'live',
  'senderDailyLimit': 'live',
  'retentionJournalDays': 'live', 'retentionAuditDays': 'live', 'retentionMediaDays': 'live', 'retentionExportsDays': 'live', 'retentionLogsDays': 'live',
  'dryRun': 'live', 'metricsExport': 'live', 'backupEnabled': 'live', 'backupKeep': 'live',
  'awayAutoReply': 'live', 'mediaMaxBytes': 'live', 'backgroundDailyLimit': 'live',
  'busyMessageMode': 'live',

  // —— 重启后才生效：启动时被 transport、bridge、timer 或闭包捕获 ——
  'accountId': 'restart', 'cwd': 'restart', 'workspaceTitle': 'restart',
  'maxMessageLength': 'restart', 'sendIntervalMs': 'restart', 'sendCooldownMs': 'restart', 'voiceOutbound': 'restart', 'messageJournal': 'restart',
  'sideProvider': 'restart', 'sideModel': 'restart',
  'knowledgeEnabled': 'restart', 'groupBotNames': 'restart',
  'richContent': 'restart', 'codeFileThreshold': 'restart',
  'senderRatePerMinute': 'restart', 'maxQueuedPerConversation': 'restart',
  'notifyEnabled': 'restart', 'notifyPort': 'restart', 'notifyToken': 'restart',
  'webhookUrl': 'restart', 'webhookSecret': 'restart', 'webhookTimeoutMs': 'restart',
  'toolAudit': 'restart', 'markdownMode': 'restart', 'sourceContext': 'restart', 'readLinks': 'restart',
  'progressAfterMs': 'restart', 'progressToolAfterMs': 'restart', 'progressEveryMs': 'restart',
  'maxTurnWaitMs': 'restart', 'eventPollMs': 'restart',
  'typingIndicator': 'restart', 'mediaEnabled': 'restart', 'autoSendFiles': 'restart',
  'maxMediaBytes': 'restart', 'maxInboundMediaBytes': 'restart', 'cdnBaseUrl': 'restart',
  'asr': 'restart',
})

/**
 * 人类可读的生效时机。
 *
 * @param {EffectKind} kind
 * @returns {{ label: string, labelEn: string }}
 */
export function effectLabel(kind) {
  if (kind === 'restart') return { label: '重启后生效', labelEn: 'takes effect after a restart' }
  if (kind === 'login') return { label: '重新登录后生效', labelEn: 'takes effect after signing in again' }
  return { label: '保存即生效', labelEn: 'takes effect immediately' }
}

/**
 * @param {string} field
 * @returns {EffectKind}
 */
export function effectOf(field) {
  return CONFIG_EFFECTS[field] ?? 'live'
}

/**
 * 「多久以前」的一行话。和 `/keyword stats` 用的是同一种语气。
 *
 * @param {number} at
 * @param {number} now
 */
function describeWhen(at, now) {
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

/**
 * `/config` 的回答：分三段说清楚「现在算数的」「要重启的」。
 *
 * @param {{ fields: string[], configFile?: string, savedAt?: number, now?: number }} input
 * @returns {string}
 */
export function describeConfigEffect({ fields, configFile, savedAt, now = Date.now() }) {
  const live = []
  const restart = []
  const login = []
  for (const field of fields) {
    const kind = effectOf(field)
    if (kind === 'restart') restart.push(field)
    else if (kind === 'login') login.push(field)
    else live.push(field)
  }
  const lines = []
  lines.push(`配置一共 ${fields.length} 项：${live.length} 项保存即生效，${restart.length} 项要重启。`)
  const head = live.slice(0, 8).join('、')
  lines.push(`· 保存即生效（下一条消息就按新值走）：${head}${live.length > 8 ? ` 等 ${live.length} 项` : ''}`)
  lines.push(`· 重启 DSH 后才生效：${restart.length > 0 ? restart.join('、') : '（没有）'}`)
  if (login.length > 0) lines.push(`· 重新登录后才生效：${login.join('、')}`)
  if (typeof configFile === 'string' && configFile !== '') lines.push(`· 存档：${configFile}`)
  lines.push(
    Number.isFinite(savedAt) && savedAt > 0
      ? `· 上次保存：${describeWhen(savedAt, now)}`
      : '· 还没通过设置卡保存过，用的是默认值。',
  )
  lines.push('想确认某一项到底有没有算数：改完发一条消息试试，或者用 /diag 看当前值。')
  return lines.join('\n')
}
