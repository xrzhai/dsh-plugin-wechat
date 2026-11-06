/**
 * Message catalogue (C33).
 *
 * Chat-facing text used to be Chinese literals scattered through index.js,
 * sessions.js and client.js — fine while there was one language, and an
 * obstacle to every change afterwards: no way to see the whole vocabulary, no
 * way to add a second language, and no way to notice when a notice was written
 * in only one of the two places it appears.
 *
 * This module is the vocabulary. `t(key, params)` resolves against the operator's
 * locale, falls back to Chinese (the historical default) when a translation is
 * missing, and interpolates `{name}` placeholders. Keys are namespaced by the
 * surface that speaks them: `help.*` for command help, `notice.*` for what the
 * bot says on its own, `error.*` for refusals.
 *
 * Scope is deliberately the user-visible strings, not every log line: log text is
 * for the operator reading files and stays English, which is what it already is.
 */

/** Locales we ship. Chinese is the default because the first users were. */
export const LOCALES = Object.freeze(['zh', 'en'])
export const DEFAULT_LOCALE = 'zh'

/**
 * The catalogue itself. Every entry must have both languages — a test enforces
 * it, so a key cannot be added in one language only.
 */
export const CATALOG = Object.freeze({
    'help.outbox': { zh: '/outbox 查看本聊天的待发数量；/outbox retry 手动重试', en: '/outbox show pending replies here; /outbox retry retries them' },
    'outbox.pending': { zh: '本聊天待发 {count} 条。请先检查微信是否已收到；/outbox retry 会重试，回执丢失的消息可能重复。', en: '{count} pending in this chat. Check what arrived before using /outbox retry: a lost acknowledgement can mean a duplicate.' },
    'outbox.result': { zh: '本次确认送达 {sent} 条，失败 {failed} 条，仍保留 {remaining} 条待发。', en: 'Confirmed: {sent}. Failed: {failed}. Still pending: {remaining}.' },
    'turn.aborted': { zh: '当前会话的回复已停止；任务是否完成请核查。', en: 'The current session reply stopped; check whether the task completed.' },
    'turn.blocked': { zh: '当前会话的回复受阻，任务尚未确认完成；请查看会话后再决定下一步。', en: 'The current session reply was blocked. Task completion is unconfirmed; check the session before proceeding.' },
    'turn.error': { zh: '当前会话的回复失败，任务尚未确认完成；请查看会话后再决定下一步。', en: 'The current session reply failed. Task completion is unconfirmed; check the session before proceeding.' },
    'turn.unknown': { zh: '当前会话的回复已结束，但任务状态无法确认；请查看会话后再决定下一步。', en: 'The current session reply ended, but the task status is unknown. Check the session before proceeding.' },
    'turn.unobserved': { zh: '未能等到当前会话的结束事件，任务状态无法确认；请查看会话后再决定下一步。', en: 'No terminal event was observed for the current session. Check the session before proceeding; the task status is unknown.' },
    'error.processing': { zh: '（处理失败：{reason}）', en: '(Processing failed: {reason})' },
    'error.accountPauseWrite': { zh: '无法保存账号暂停状态；连接状态未改变', en: 'Could not save the account pause state; the connection was left unchanged' },
    'error.accountResumeWrite': { zh: '无法保存账号恢复状态；连接状态未改变', en: 'Could not save the account resume state; the connection was left unchanged' },
    'error.accountRegistryRead': { zh: '账号授权表无法读取，请恢复或修复状态目录中的 accounts-registry.json；原文件未被修改。', en: 'The account authorization registry cannot be read. Restore or repair accounts-registry.json in the state directory; the original file was left unchanged.' },
    'error.accountRegistryWrite': { zh: '无法保存账号信息，请查看日志。', en: 'Unable to save the account registry; check the logs.' },
    'error.cancelUnavailable': { zh: '这次没能停止当前回复：当前 DSH 环境没有提供停止功能。请确认 DSH 与插件版本是否匹配。', en: 'The current reply could not be stopped because this DSH environment does not provide cancellation. Check that the DSH and plugin versions are compatible.' },
    'error.compactUnavailable': { zh: '当前 DSH 环境不能压缩这段会话；请使用支持“压缩会话”的 DSH 版本后再试。', en: 'This DSH environment cannot compact the conversation. Try a DSH version that supports conversation compaction.' },
    'error.featureUnavailable': { zh: '这个功能现在用不了；请确认 DSH 和插件都已完整加载，再试一次。', en: 'This feature is unavailable right now. Check that DSH and the plugin are fully loaded, then try again.' },
    'notice.longRunning': { zh: '（这条消息处理时间较长，先回复别的消息不影响它；结果出来后会直接发到这里）', en: '(This task is taking longer. You can send other messages; its result will arrive here when ready.)' },
    'notice.snippetFallback': { zh: '（附件 {name} 的发送未确认，代码如下）', en: '(Sending attachment {name} could not be confirmed; code follows)' },
    'onboarding.loginPanel': { zh: '打开 DSH → 左侧边栏「大肥鱼」→「微信账号」→「扫码登录微信」', en: 'Open DSH → WeChat in the sidebar → WeChat Account → Scan QR code to log in' },
    // --- command help -------------------------------------------------------
    'help.example': { zh: '也可以直接说：帮我整理这份文档，完成后把文件发回来。', en: 'Or just ask: organise this document and send the finished file back.' },
    'help.header': { zh: '微信指令（发 /help 或 /帮助 可再看一遍）：', en: 'WeChat commands (send /help to see this again):' },
    'help.new': { zh: '/new [标题] 在当前微信聊天里新建话题（当前话题会保留，之后可以切回来）', en: '/new [title] start a new topic in this WeChat chat (the current topic is kept, and you can switch back)' },
    'help.list': { zh: '/list 查看当前微信聊天里的所有话题', en: '/list list every topic in this WeChat chat' },
    'help.use': { zh: '/use <序号> 切换到当前微信聊天里的第几个话题', en: '/use <n> switch to topic n in this WeChat chat' },
    'help.clear': { zh: '/clear 从当前微信聊天的话题列表移除所有话题，并新开一个；DSH 里原来的会话历史不会被删除', en: '/clear remove every topic from this WeChat chat’s topic list and start a new one; the original DSH session history is not deleted' },
    'help.cancel': { zh: '/cancel 停止当前正在生成的回复；已经执行的操作不会撤回，排队中的消息仍会继续处理', en: '/cancel stop the reply currently being generated; actions already run are not undone, and queued messages will still be processed' },
    'help.compact': { zh: '/compact 立即压缩当前话题在 DSH 中的历史上下文', en: '/compact compact the current topic’s history in DSH immediately' },
    'help.status': { zh: '/status 查看当前账号和话题的状态（允许名单等）', en: '/status show the current account and topic status (allowlist and more)' },
    'help.send': { zh: '/send 路径 把本机文件发到当前会话（只允许工作目录、状态目录与 mediaDirs 里的文件）', en: '/send path send a local file here (only files under the workspace, state dir or mediaDirs)' },

    // --- notices the bot sends on its own -----------------------------------
    'notice.unsupported': { zh: '（暂不支持这条消息：{kind}）', en: '(this kind of message is not supported yet: {kind})' },
    'notice.rateLimited': { zh: '（你发得有点快，我先缓一下～{seconds} 秒后再来）', en: '(you are sending a bit fast — give me {seconds} seconds)' },
    'notice.dailyLimited': { zh: '（今天跟你聊得够多啦，{limit} 条封顶，明天再聊～）', en: '(we have talked a lot today — the {limit}-message daily limit is reached, see you tomorrow)' },
    'notice.dangerHigh': { zh: '⚠️ 这一步看着有风险', en: '⚠️ this step looks risky' },
    'notice.dangerNormal': { zh: '🔧 要用工具了', en: '🔧 about to use a tool' },
    'notice.dangerBody': { zh: '{tool}{detail}', en: '{tool}{detail}' },
    'notice.dangerFooter': {
        zh: '要停就发 /cancel —— 正在跑的这一步可能已经执行，但后面的步骤不会再继续。',
        en: 'send /cancel to stop — the step in flight may already have run, but nothing after it will.',
    },

    // --- settings card labels -----------------------------------------------
    'config.sessionDispatcherEnabled.label': { zh: '允许通过微信管理其他会话', en: 'Allow WeChat to manage other sessions' },
    'config.sessionDispatcherEnabled.hint': {
        zh: '默认关闭。开启后，下面列出的联系人可以通过微信查看并操作指定的 DSH 会话，保存后从下一条消息起生效。这个功能用于方便操作自己的会话，不是隔离不可信用户的系统沙箱。',
        en: 'Off by default. Listed contacts can view and manage the selected DSH sessions from WeChat. Changes apply from the next message. This is a convenience control, not a system sandbox for untrusted users.',
    },
    'config.workspaceTitle.label': { zh: '微信工作区显示名', en: 'Workspace title' },
    'config.workspaceTitle.hint': {
        zh: '留空沿用目录名；保存后重启 DSH 生效，且不会覆盖你在界面里手动改过的标题。',
        en: 'Empty keeps the folder name. Restart DSH to apply; a title you chose in the UI is never overwritten.',
    },
    'install.success.settings': {
        zh: '设置保存在 {path}；重装不会删除已有登录信息和设置。',
        en: 'Settings are stored in {path}; reinstalling does not remove existing sign-in data or settings.',
    },
})

/**
 * Coerce whatever the config says into a locale we have. Unknown values mean
 * Chinese: every existing deployment was Chinese before this existed.
 *
 * @param {unknown} value
 * @returns {'zh' | 'en'}
 */
export function resolveLocale(value) {
    const raw = String(value ?? '').trim().toLowerCase()
    return raw === 'en' ? 'en' : DEFAULT_LOCALE
}

/**
 * Look one message up, falling back to Chinese and then to the key itself, so a
 * missing translation shows something recognisable instead of `undefined`.
 *
 * @param {string} key
 * @param {'zh' | 'en'} locale
 */
function lookup(key, locale) {
    const entry = CATALOG[key]
    if (entry === undefined) return key
    const wanted = entry[locale]
    if (typeof wanted === 'string' && wanted !== '') return wanted
    return entry[DEFAULT_LOCALE] ?? key
}

/**
 * Fill `{name}` placeholders. An absent parameter is left as `{name}` rather
 * than replaced with 'undefined' — a visible placeholder is a bug report, a
 * silent 'undefined' is a mystery.
 *
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 */
export function interpolate(template, params = {}) {
    return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
}

/**
 * A translator bound to a locale or a getter (the plugin's config is live, so a
 * getter keeps the card's change effective for the very next message).
 *
 * @param {'zh' | 'en' | (() => unknown)} locale
 */
export function createTranslator(locale) {
    const read = () => resolveLocale(typeof locale === 'function' ? locale() : locale)
    return {
        locale: read,
        t(key, params) {
            return interpolate(lookup(key, read()), params)
        },
    }
}

/** Convenience for module-level strings that are not live-configurable. */
export function translate(key, params, locale = DEFAULT_LOCALE) {
    return interpolate(lookup(key, resolveLocale(locale)), params)
}

/** Every key in the catalogue, sorted — for the coverage test and the report. */
export function catalogKeys() {
    return Object.keys(CATALOG).sort()
}
