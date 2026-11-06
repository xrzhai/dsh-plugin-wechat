/**
 * 配置的生效时机。
 *
 * 设置卡保存会写进 `config.json`，但「写进去了」和「什么时候算数」不是一件事。
 * 这个模块把三件事分开说清楚：
 *
 *   - `live`：**下一条消息**重新读取存档配置。
 *   - `restart`：transport/bridge 构造参数等要等插件重新加载。
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
  // —— 保存即生效：消息热路径会重读存档配置 ——
  'enabled': 'live',
  'sessionDispatcherEnabled': 'live', 'sessionDispatcherSenders': 'live', 'sessionDispatcherTargets': 'live', 'protectedSessions': 'live', 'readOnlyPaths': 'live',
  'allowedSenders': 'live', 'allowedChats': 'live',
  'groupChatEnabled': 'live', 'groupReplyWhen': 'live',
  'locale': 'live',
  'senderDailyLimit': 'live',
  'busyMessageMode': 'live',

  // —— 重启后才生效：启动时被 transport、bridge、timer 或闭包捕获 ——
  'accountId': 'restart', 'cwd': 'restart', 'workspaceTitle': 'restart',
  'maxMessageLength': 'restart', 'sendIntervalMs': 'restart', 'sendCooldownMs': 'restart',
  'groupBotNames': 'restart',
  'richContent': 'restart', 'codeFileThreshold': 'restart',
  'senderRatePerMinute': 'restart', 'maxQueuedPerConversation': 'restart',
  'markdownMode': 'restart', 'sourceContext': 'restart',
  'progressAfterMs': 'restart', 'progressToolAfterMs': 'restart', 'progressEveryMs': 'restart',
  'maxTurnWaitMs': 'restart', 'eventPollMs': 'restart',
  'typingIndicator': 'restart', 'mediaEnabled': 'restart',
  'maxMediaBytes': 'restart', 'maxInboundMediaBytes': 'restart', 'cdnBaseUrl': 'restart',
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
