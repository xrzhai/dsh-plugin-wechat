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
    'error.processing': { zh: '（处理失败：{reason}）', en: '(Processing failed: {reason})' },
    'error.accountPauseWrite': { zh: '无法保存账号暂停状态；连接状态未改变', en: 'Could not save the account pause state; the connection was left unchanged' },
    'error.accountResumeWrite': { zh: '无法保存账号恢复状态；连接状态未改变', en: 'Could not save the account resume state; the connection was left unchanged' },
    'error.reminderInvalidTime': { zh: '这个提醒时间不可用', en: 'That reminder time is not valid' },
    'error.reminderStorageReadOnly': {
        zh: '提醒暂时不能保存，为保护原有提醒，本次没有新增；可重启 DSH 后再试，若仍失败，请在日志中搜索“reminders.json”查看具体原因。',
        en: 'The reminder could not be saved, so it was not scheduled and existing reminders were left unchanged. Restart DSH and try again; if it persists, search the logs for “reminders.json” for details.',
    },
    'error.reminderSequenceExhausted': { zh: '提醒编号已经用完，当前版本无法再新建提醒；已有提醒不受影响。', en: 'Reminder IDs are exhausted, so this version cannot create another reminder. Existing reminders are unaffected.' },
    'error.reminderWriteFailed': { zh: '提醒没有保存成功，本次没有新增；原有提醒保持不变。请重启 DSH 后再试。', en: 'The reminder could not be saved, so it was not scheduled and existing reminders were left unchanged. Restart DSH and try again.' },
    'error.cancelUnavailable': { zh: '这次没能停止当前回复：当前 DSH 环境没有提供停止功能。请确认 DSH 与插件版本是否匹配。', en: 'The current reply could not be stopped because this DSH environment does not provide cancellation. Check that the DSH and plugin versions are compatible.' },
    'error.compactUnavailable': { zh: '当前 DSH 环境不能压缩这段会话；请使用支持“压缩会话”的 DSH 版本后再试。', en: 'This DSH environment cannot compact the conversation. Try a DSH version that supports conversation compaction.' },
    'error.featureUnavailable': { zh: '这个功能现在用不了；请确认 DSH 和插件都已完整加载，再试一次。', en: 'This feature is unavailable right now. Check that DSH and the plugin are fully loaded, then try again.' },
    'error.reminderServiceUnavailable': {
        zh: '提醒服务现在没有准备好，暂时没法{action}。可以重启 DSH 后再试；如果仍不行，请检查插件是否完整加载。',
        en: 'The reminder service is not ready, so I cannot {actionEn}. Try restarting DSH; if it still fails, check that the plugin loaded completely.',
    },
    'error.timedMessageServiceUnavailable': {
        zh: '定时消息服务现在没有准备好，暂时没法{action}。可以重启 DSH 后再试；如果仍不行，请检查插件是否完整加载。',
        en: 'The scheduled-message service is not ready, so I cannot {actionEn}. Try restarting DSH; if it still fails, check that the plugin loaded completely.',
    },
    'error.reminderChangeUnclear': {
        zh: '这次没能{action}：可能没有找到合适的提醒，也可能刚才的改动没能保存。请用 /remindlist 核对；如果提醒还在，请重启 DSH 后再试。',
        en: 'Could not {actionEn}: the reminder may no longer exist, or the change may not have been saved. Check /remindlist; if the reminder is still there, restart DSH and try again.',
    },
    'notice.longRunning': { zh: '（这条消息处理时间较长，先回复别的消息不影响它；结果出来后会直接发到这里）', en: '(This task is taking longer. You can send other messages; its result will arrive here when ready.)' },
    'onboarding.loginPanel': { zh: '打开 DSH → 左侧边栏「大肥鱼」→「微信账号」→「扫码登录微信」', en: 'Open DSH → WeChat in the sidebar → WeChat Account → Scan QR code to log in' },
    // --- command help -------------------------------------------------------
    'help.header': { zh: '微信指令（发 /help 或 /帮助 可再看一遍）：', en: 'WeChat commands (send /help to see this again):' },
    'help.new': { zh: '/new [标题] 在当前微信聊天里新建话题（当前话题会保留，之后可以切回来）', en: '/new [title] start a new topic in this WeChat chat (the current topic is kept, and you can switch back)' },
    'help.list': { zh: '/list 查看当前微信聊天里的所有话题', en: '/list list every topic in this WeChat chat' },
    'help.use': { zh: '/use <序号> 切换到当前微信聊天里的第几个话题', en: '/use <n> switch to topic n in this WeChat chat' },
    'help.clear': { zh: '/clear 从当前微信聊天的话题列表移除所有话题，并新开一个；DSH 里原来的会话历史不会被删除', en: '/clear remove every topic from this WeChat chat’s topic list and start a new one; the original DSH session history is not deleted' },
    'help.cancel': { zh: '/cancel 停止当前正在生成的回复；已经执行的操作不会撤回，排队中的消息仍会继续处理', en: '/cancel stop the reply currently being generated; actions already run are not undone, and queued messages will still be processed' },
    'help.compact': { zh: '/compact 立即压缩当前话题在 DSH 中的历史上下文', en: '/compact compact the current topic’s history in DSH immediately' },
    'help.status': { zh: '/status 查看当前账号和话题的状态（允许名单等）', en: '/status show the current account and topic status (allowlist and more)' },
    'help.remind': { zh: '/remind <时间> <内容> 定时提醒：10m / 2h / 14:30 / 2026-10-19 09:00 / 明天 9:00 / 周五 / 下周三 10点 / 3小时后 / 每天 9:00 / 工作日 8:30 / 每周一 10点', en: '/remind <when> <text> timed reminder: 10m / 2h / 14:30 / 2026-10-19 09:00 / tomorrow 9:00 / Friday / next Wednesday 10:00 / in 3 hours / daily 9:00 / weekdays 8:30 / Mondays 10:00' },
    'help.remindlist': { zh: '/remindlist 查看待发提醒（/remindlist 2 1h 把第 2 条往后推一小时）', en: '/remindlist list pending reminders (/remindlist 2 1h pushes entry 2 back an hour)' },
    'help.remindcancel': { zh: '/remindcancel <编号> 取消一条还没发出的提醒（编号来自 /remindlist）', en: '/remindcancel <n> cancel a pending reminder (number from /remindlist)' },
    'help.subscribe': { zh: '/subscribe <时间> <主题> 定时主动消息：每天/每周X HH:mm，或一次性时间；到点我会主动给你发一条', en: '/subscribe <when> <topic> scheduled message from me: daily/weekly HH:mm, or a one-off time' },
    'help.subscribelist': { zh: '/subscribelist 查看这个账号的定时主动消息', en: '/subscribelist list this account’s scheduled messages' },
    'help.subscribecancel': { zh: '/subscribecancel <编号> 取消一条定时主动消息（编号来自 /subscribelist）', en: '/subscribecancel <n> cancel a scheduled message (number from /subscribelist)' },
    'help.keyword': { zh: '/keyword stats 看群关键词规则各自的命中次数（哪些在干活、哪些没人用）', en: '/keyword stats shows how often each group keyword rule fired' },
    'help.config': { zh: '/config 看哪些设置保存即生效、哪些要重启 DSH 才生效', en: '/config explains which settings apply immediately and which need a restart' },
    'help.export': { zh: '/export [天数] 导出最近 N 天（默认 30）的聊天记录', en: '/export [days] export the last N days (default 30) of this chat' },
    'help.away': { zh: '/away <时间> [说明] 开启离开模式：这段时间不回消息（不花 token），每个会话自动回一句；回来发 /back 看汇总', en: '/away <when> [note] turn on away mode: no agent replies (no tokens), one auto-answer per chat; /back for the summary' },
    'help.back': { zh: '/back 结束离开模式，并看这段时间谁找过你', en: '/back end away mode and see who asked while you were out' },
    'help.diag': { zh: '/diag 一条不花模型的自检：连接、开关、待发提醒与订阅、静默状态、今天流水', en: '/diag a model-free self-check: connection, switches, pending reminders and subscriptions, quiet status, today\'s traffic' },
    'help.outbox': { zh: '/outbox 看待重发的消息，retry 立即重试，drop <id> 丢弃一条', en: '/outbox shows undelivered messages; retry resends now; drop <id> discards one' },
    'help.draft': { zh: '/draft 看/换/发重要日子的草稿（/draft send 发，/draft skip 丢）', en: '/draft shows, rotates, or sends the greeting drafted for an important date' },
    'help.say': { zh: '/say 一句话 用本机语音合成发一条语音（macOS）', en: '/say text synthesises a voice with the local system voice (macOS)' },
    'help.quiet': { zh: '/quiet 2h 临时静默（离开模式不自动回复，提醒与订阅顺延），/quiet off 恢复', en: '/quiet 2h pauses away auto-replies and delays reminders and subscriptions; /quiet off resumes' },
    'help.snooze': { zh: '/snooze 10m 把最近一条提醒往后推；/remind skip 跳过重复提醒的下一次', en: '/snooze 10m pushes the next reminder back; /remind skip skips one occurrence of a repeating reminder' },
    'help.habit': { zh: '/habit 看习惯与连续天数，add 新增，done 打卡，rm 删除', en: '/habit shows streaks; add, done and rm manage them' },
    'help.media': { zh: '/media 看最近收到的图片/文件/语音，resend <序号> 重新发回来', en: '/media lists recently received media; resend <n> sends one back' },
    'help.usage': { zh: '/usage 今天的用量：后台调用/预算、待重发、提醒与订阅、今天流水和粗估 token', en: '/usage: what today consumed — background calls/budget, outbox, reminders and subscriptions, journal and a rough token estimate' },
    'help.todo': { zh: '/todo [add 内容|done 序号|rm 序号] 共享清单：同一个机器人的群和私聊看到同一份', en: '/todo [add text|done n|rm n] a shared list: every chat of this bot sees the same one' },
    'help.later': { zh: '/later https://… 稍后读：存链接并取回标题，/later 随时看，/later done 2 标记读完', en: '/later https://… read-later: store a link with its title; /later to list, /later done 2 when read' },
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
