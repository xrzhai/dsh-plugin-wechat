/**
 * Persistent "session lines" per Weixin conversation.
 *
 * A Weixin conversation used to map to exactly one DSH session, derived
 * deterministically from the conversation id ({@link sessionIdFor}). That made
 * the binding simple and restart-proof, but it also meant a user could never
 * start a fresh topic or return to an earlier one: every message, forever, went
 * into the same context window.
 *
 * A **line** is one agent session under a conversation. Each conversation has
 * an ordered list of them plus a pointer to the active one:
 *
 * ```json
 * {
 *   "lines": [
 *     { "sessionId": "weixin-abc-im-bot",        "title": "帮我看看构建报错", "createdAt": "...", "lastUsedAt": "..." },
 *     { "sessionId": "weixin-abc-im-bot--m2k1",  "title": "翻译这段话",       "createdAt": "...", "lastUsedAt": "..." }
 *   ],
 *   "active": "weixin-abc-im-bot--m2k1"
 * }
 * ```
 *
 * Lines are **kept in parallel**: switching away from a line does not end,
 * archive or clear it. The user can switch back and the earlier context is
 * still there, which is what makes `/list` + `/use` useful rather than a
 * one-way reset.
 *
 * New conversations use a deterministic id based on both the account and the
 * original conversation id, so different sources cannot share a host session.
 *
 * @module dsh-weixin/src/sessions
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { translate } from './i18n.js'
import path from 'node:path'

import { stateDir } from './state.js'
import { listIndexedWeixinAccountIds } from '../vendor/openclaw-weixin/auth/accounts.js'
import { labelForAccount, readRegistry } from './account-registry.js'

/** Filename under the state root holding every conversation's line list. */
const LINES_FILE = 'sessions.json'

/**
 * How many lines `/list` shows at once.
 *
 * Not a cap on how many lines exist — a user who wants fifty topics gets
 * fifty — only on how many are rendered into one WeChat message. The most
 * recent ones are shown because those are what a user switches back to.
 */
export const LIST_LIMIT = 10

/**
 * Store key for one conversation under one account.
 *
 * Accounts are separated at the store level: two bots that somehow report the
 * same conversation id must never share a line list, or a message meant for
 * one account could land in the other's session. The account digest preserves
 * the distinction between IDs that differ only in punctuation.
 *
 * With no account (or a blank one) the bare key is used by the settings card.
 *
 * @param {string | undefined} accountId
 * @param {string} conversationId
 * @returns {string}
 */
export function accountScope(accountId) {
  return createHash('sha256').update(String(accountId)).digest('hex')
}

export function scopedLineKey(accountId, conversationId) {
  const account = String(accountId ?? '').trim()
  if (account === '') return conversationId
  return `${accountScope(account)}:${conversationId}`
}

// Pre-#99 keys folded punctuation. Only reverse a slug against known accounts.
function legacyScope(id) {
  return id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
}

export function topicAccountIds(extra = [], registry = readRegistry()) {
  return [...new Set([...Object.keys(registry), ...listIndexedWeixinAccountIds(), ...extra]
    .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
}

/**
 * Session id for the FIRST line of a conversation.
 *
 * Account and conversation are encoded together before hashing: punctuation
 * folding alone cannot distinguish all valid source IDs.
 *
 * @param {string} conversationId
 * @param {string} [accountId]
 * @returns {string}
 */
export function baseSessionIdFor(conversationId, accountId) {
  const source = JSON.stringify([String(accountId ?? '').trim(), String(conversationId ?? '')])
  return `weixin-${createHash('sha256').update(source).digest('hex')}`
}

/**
 * Session id for a NEW line of a conversation.
 *
 * Distinct from {@link baseSessionIdFor} so a new line never collides with the
 * original one, and derived from a timestamp plus a random suffix so two lines
 * created in the same millisecond cannot share an id.
 *
 * @param {string} conversationId
 * @param {number} [now]
 * @param {string} [accountId]
 * @returns {string}
 */
export function newSessionIdFor(conversationId, now = Date.now(), accountId) {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${baseSessionIdFor(conversationId, accountId)}--${now.toString(36)}${suffix}`
}

/** Absolute path of the line store. */
export function linesFile() {
  return path.join(stateDir(), LINES_FILE)
}

/**
 * Read the whole line store.
 *
 * A missing, unreadable or malformed file resolves to `{}` — the same posture
 * as {@link readSavedConfig}: losing the *index* of session lines must never
 * cost the plugin its ability to load and reply. The worst case is that a
 * conversation falls back to its first line, which is where it started.
 *
 * @returns {Record<string, { lines: Array<{sessionId: string, title?: string, createdAt?: string, lastUsedAt?: string}>, active?: string }>}
 */
export function readLines() {
  let text
  try {
    text = fs.readFileSync(linesFile(), 'utf8')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    process.emitWarning(`dsh-weixin: ignoring malformed ${linesFile()}: ${String(error?.message ?? error)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.emitWarning(`dsh-weixin: ignoring ${linesFile()}: expected a JSON object`)
    return {}
  }
  return parsed
}

/**
 * Conversation most recently used by one account.
 *
 * Store keys are account-scoped, so filtering by the account prefix is part
 * of choosing the target; another account's more recent activity must never
 * steal a notification. Timestamps are compared as instants because persisted
 * ISO strings may carry different UTC offsets.
 *
 * @param {string} accountId
 * @param {ReturnType<typeof readLines>} [store]
 * @returns {string | undefined}
 */
export function mostRecentConversationId(accountId, store = readLines()) {
  const account = String(accountId ?? '').trim()
  if (account === '') return undefined
  const prefix = `${accountScope(account)}:`
  let best
  for (const [key, entry] of Object.entries(store)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) continue
    let lastUsed = Number.NEGATIVE_INFINITY
    for (const line of Array.isArray(entry?.lines) ? entry.lines : []) {
      const usedAt = Date.parse(line?.lastUsedAt ?? '')
      const createdAt = Date.parse(line?.createdAt ?? '')
      const candidate = Number.isFinite(usedAt)
        ? usedAt
        : Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY
      if (candidate > lastUsed) lastUsed = candidate
    }
    if (Number.isFinite(lastUsed) && (best === undefined || lastUsed > best.lastUsed)) {
      best = { conversationId: key.slice(prefix.length), lastUsed }
    }
  }
  return best?.conversationId
}

/**
 * Write the line store.
 *
 * Written through a temp file and renamed, so a crash mid-write cannot leave a
 * truncated index that would silently reset every conversation to its first
 * line. Failures are swallowed with a warning: the in-memory state is still
 * correct for this process, and refusing to reply because an index could not
 * be written would be a far worse trade.
 *
 * @param {ReturnType<typeof readLines>} lines
 * @returns {boolean} whether it was persisted
 */
export function writeLines(lines) {
  const file = linesFile()
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(lines, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, file)
    return true
  } catch (error) {
    process.emitWarning(`dsh-weixin: could not write ${file}: ${String(error?.message ?? error)}`)
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Best effort: the temp file is already useless.
    }
    return false
  }
}

/**
 * Derive a short, human-readable title from the first user message of a line.
 *
 * A line is usually named by the first thing the user says, while `/new` may
 * provide an explicit title. Either source is trimmed and collapsed to one
 * line because it is rendered into a WeChat message where a newline would
 * break the list layout.
 *
 * @param {string} text
 * @returns {string}
 */
export function titleFrom(text, limit = 24) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return '(无标题)'
  // Count by code point so an emoji is not cut in half.
  const points = [...flat]
  if (points.length <= limit) return flat
  return `${points.slice(0, limit).join('')}…`
}

/**
 * Title for one line, prefixed with the owning account when it has one.
 *
 * Multi-account users could not tell which WeChat account a sidebar row
 * belongs to. A separate hint element beside the row glyph was tried twice
 * and the host's row squeezed the glyph both times, so the marker now lives
 * IN the title itself (`备注名: 标题`) — text flows, nothing can be squeezed.
 * Bare-key lines (pre-multi-account history) stay unprefixed.
 *
 * Registry reads are failure-tolerant by its own rule; a missing label falls
 * back to the short form of the account id, and any problem reads as no
 * prefix at all rather than blocking the title.
 *
 * @param {string} text first user message of the line
 * @param {string | undefined} accountId owning bot account
 * @returns {string}
 */
export function titledWithAccount(text, accountId) {
  const title = titleFrom(text)
  const who = String(accountId ?? '').trim()
  if (who === '') return title
  let label = ''
  try {
    label = labelForAccount(who)
  } catch {
    label = ''
  }
  const name = label !== '' ? label : who.split('@')[0]
  if (name === '') return title
  return `${name}: ${title}`
}

/**
 * In-memory session-line index for one plugin instance.
 *
 * Holds the persisted store in memory so a turn does not re-read the file, and
 * writes back after every mutation. Every method is synchronous: the decisions
 * it drives (which session id to attach) happen before any await, and making
 * them async would open a window where two concurrent inbound messages could
 * both decide to create a line.
 */
export class SessionLines {
  /**
   * @param {object} [options]
   * @param {(message: string) => void} [options.warn] diagnostics sink
   */
  constructor(options = {}) {
    this.warn = options.warn ?? (() => {})
    /** @type {ReturnType<typeof readLines>} */
    this.store = readLines()
  }

  // Resolve all owners together: a slug can name multiple accounts, and the
  // old host session IDs themselves could collide across chats. Never attach
  // an ambiguous transcript to whichever account happens to start first.
  migrateLegacy(accountIds) {
    const owners = new Map()
    const digests = new Set(accountIds.map(accountScope))
    for (const id of accountIds) {
      const slug = legacyScope(id)
      owners.set(slug, owners.has(slug) ? null : id)
    }
    const targets = new Map()
    const references = new Map()
    for (const [key, entry] of Object.entries(this.store)) {
      const sep = key.indexOf(':')
      const scope = key.slice(0, sep)
      const id = sep > 0 && !digests.has(scope) && owners.get(scope)
      const target = id && key.length > sep + 1 ? scopedLineKey(id, key.slice(sep + 1)) : key
      if (target !== key) targets.set(key, target)
      for (const line of Array.isArray(entry?.lines) ? entry.lines : []) {
        if (!references.has(line?.sessionId)) references.set(line?.sessionId, new Set())
        references.get(line?.sessionId).add(target)
      }
    }
    let changed = false
    for (const [key, target] of targets) {
      const old = this.store[key]
      if (!Array.isArray(old?.lines) || !old.lines.length || old.lines.some(line =>
        !line?.sessionId || references.get(line.sessionId).size !== 1)) continue
      const current = this.store[target]
      const lines = new Map(old.lines.map(line => [line.sessionId, line]))
      for (const line of current?.lines ?? []) lines.set(line.sessionId, { ...lines.get(line.sessionId), ...line })
      this.store[target] = { ...current, ...old, lines: [...lines.values()], active: old.active ?? current?.active }
      delete this.store[key]
      changed = true
    }
    if (changed) this.#write()
  }

  #key(conversationId, accountId) {
    if (accountId && Object.hasOwn(this.store, legacyScope(accountId) + ':' + conversationId)) {
      this.migrateLegacy(topicAccountIds([accountId]))
    }
    return scopedLineKey(accountId, conversationId)
  }

  // Accept a key held by an already-open settings card across an upgrade.
  cardKey(key, accountIds) {
    if (typeof key !== 'string' || !key.includes(':')) return undefined
    const sep = key.indexOf(':'), scope = key.slice(0, sep)
    const owners = accountIds.filter(id => accountScope(id) === scope || legacyScope(id) === scope)
    if (owners.length !== 1) return undefined
    this.migrateLegacy(accountIds)
    const canonical = scopedLineKey(owners[0], key.slice(sep + 1))
    if (key !== canonical && Object.hasOwn(this.store, key)) return undefined
    return this.store[canonical]?.lines?.length ? canonical : undefined
  }

  conversations(accountId) {
    const prefix = accountScope(accountId) + ':'
    return Object.keys(this.store).filter(key => key.startsWith(prefix) && key.length > prefix.length
      && this.store[key]?.lines?.length).map(key => key.slice(prefix.length))
  }

  checkpoint(conversationId, accountId, sessionId, seq, deliveredTurns) {
    const entry = this.store[scopedLineKey(accountId, conversationId)]
    const line = entry?.lines?.find(line => line.sessionId === sessionId)
    // A pending send must not recreate a topic deleted from the settings card.
    if (!line) return
    const ahead = [...(deliveredTurns ?? [])].filter(end => end > seq)
    if (line.lastDeliveredSeq === seq && !ahead.length && !line.deliveredTurns) return
    line.lastDeliveredSeq = seq
    if (ahead.length) line.deliveredTurns = ahead
    else delete line.deliveredTurns
    this.#write()
  }

  /**
   * Lines recorded for a conversation, oldest first.
   *
   * A conversation that has never been seen reports its first line as
   * existing-but-unrecorded, so the caller attaches a stable id without
   * writing anything to disk. Persisting on read would create an entry for
   * every conversation that ever merely sent a message, including ones whose
   * allowlist check later refused them.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {Array<{sessionId: string, title?: string, createdAt?: string, lastUsedAt?: string}>}
   */
  list(conversationId, accountId) {
    const key = this.#key(conversationId, accountId)
    const entry = this.store[key]
    if (entry === undefined || !Array.isArray(entry.lines) || entry.lines.length === 0) {
      return [{ sessionId: baseSessionIdFor(conversationId, accountId), title: undefined }]
    }
    return entry.lines
  }

  /**
   * The line the next message should go to.
   *
   * Falls back to the first line when the recorded active id is not in the
   * list — which happens if the index was hand-edited, or if a `--` suffix
   * survived a partial write. Returning a line that no longer exists would make
   * `attach` create a brand-new empty session under a stale name.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string} session id
   */
  active(conversationId, accountId) {
    const key = this.#key(conversationId, accountId)
    const lines = this.list(conversationId, accountId)
    const active = this.store[key]?.active
    if (typeof active === 'string' && lines.some((line) => line.sessionId === active)) return active
    return lines[0].sessionId
  }

  /**
   * Drop every recorded line for a conversation and start a fresh one.
   *
   * `/clear` semantics: the current conversation's context is gone and the
   * next message opens a brand-new line. The recorded line entries are removed
   * from `sessions.json` so `/list` no longer shows them (a list that keeps
   * growing through `/new` was the reason /clear was asked for); the host-side
   * transcript files are NOT touched — they are the host's data, and an
   * orphaned transcript is harmless.
   *
   * The new line gets a fresh id (a `--`-stamped suffix), so a stale in-memory
   * record for an old id can never answer again, and `/use` cannot switch back
   * into cleared context.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string} the fresh line's session id
   */
  clear(conversationId, accountId) {
    // Write the fresh line directly rather than going through create(): the
    // empty list would make list() synthesize the default base id and
    // create() would push onto it, silently resurrecting the line /clear was
    // asked to remove.
    const now = new Date().toISOString()
    const sessionId = newSessionIdFor(conversationId, Date.now(), accountId)
    this.#set(this.#key(conversationId, accountId), { lines: [{ sessionId, createdAt: now, lastUsedAt: now }], active: sessionId })
    return sessionId
  }

  /**
   * Create a new line and make it active. Lines already present are untouched,
   * so switching away and back preserves the earlier context.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string} the new line's session id
   */
  create(conversationId, accountId) {
    const now = new Date().toISOString()
    const sessionId = newSessionIdFor(conversationId, Date.now(), accountId)
    const lines = this.list(conversationId, accountId).slice()
    lines.push({ sessionId, createdAt: now, lastUsedAt: now })
    this.#set(this.#key(conversationId, accountId), { lines, active: sessionId })
    return sessionId
  }

  /**
   * Remove one line from a conversation's list.
   *
   * The card's answer to "this line is dead weight" — distinct from `/clear`,
   * which resets the CURRENT line: remove takes an index and never moves the
   * conversation off the line it is on, so deleting an old line cannot throw
   * away live context. Removing the active line falls back to the first
   * remaining one, because `active()` would otherwise return a deleted id and
   * `attach` would open a brand-new empty session under it.
   *
   * Refusing to remove the last line was tried and reverted: a conversation
   * that only ever had one line then had no Delete button at all. Removing the
   * LAST line now removes the whole conversation entry — the next inbound
   * message re-creates a fresh line under the same key, so nothing becomes
   * unreachable.
   *
   * @param {string} conversationId
   * @param {number} index 1-based position as shown by `/list`
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string | '' | undefined} the session id still active after the
   *   removal, '' when the whole entry was removed, undefined on a bad index
   */
  remove(conversationId, index, accountId) {
    const key = this.#key(conversationId, accountId)
    const existing = this.store[key]
    const lines = Array.isArray(existing?.lines) ? existing.lines.slice() : this.list(conversationId, accountId).slice()
    if (!Number.isInteger(index) || index < 1 || index > lines.length) return undefined
    if (lines.length === 1) {
      // Last line: the entry goes with it. The distinct '' return (not
      // undefined, which means "bad index") lets the caller report success.
      delete this.store[key]
      this.#write()
      return ''
    }
    const [removed] = lines.splice(index - 1, 1)
    const active = existing?.active === removed.sessionId ? lines[0].sessionId : existing.active
    this.#set(key, { lines, active })
    return active
  }

  /**
   * Point a conversation at an existing line.
   *
   * The index is 1-based because `/use 2` is what a user reads off `/list`;
   * an out-of-range index returns undefined rather than clamping, so the reply
   * can tell the user the number was wrong instead of silently switching to
   * some other line.
   *
   * @param {string} conversationId
   * @param {number} index 1-based position as shown by `/list`
   * @returns {string | undefined} the session id, or undefined when out of range
   */
  use(conversationId, index, accountId) {
    const lines = this.list(conversationId, accountId).slice()
    if (!Number.isInteger(index) || index < 1 || index > lines.length) return undefined
    const target = lines[index - 1]
    target.lastUsedAt = new Date().toISOString()
    this.#set(this.#key(conversationId, accountId), { lines, active: target.sessionId })
    return target.sessionId
  }

  /**
   * Give a line its title, derived from the first message that ran in it.
   *
   * Only the first message sets the title: later edits would make `/list` show
   * whatever was said most recently rather than what the topic is, and a title
   * that changes under the user is worse than an imperfect stable one.
   *
   * @param {string} conversationId
   * @param {string} sessionId
   * @param {string} text
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string | undefined} the title this call SET (first message
   *   only), or undefined when the line was already named / not found — the
   *   caller mirrors a fresh title into the host session so the GUI sidebar
   *   shows the same text (`titleHostSync` in agent-bridge.js)
   */
  title(conversationId, sessionId, text, accountId) {
    // A conversation whose first message has just arrived has no entry on disk
    // yet — `list()` synthesizes its first line rather than persisting one, so
    // that merely receiving a message does not write state. Materialize the
    // entry here instead of dropping the title.
    const key = this.#key(conversationId, accountId)
    const existing = this.store[key]
    const lines = Array.isArray(existing?.lines) && existing.lines.length > 0
      ? existing.lines
      : this.list(conversationId, accountId).slice()
    const line = lines.find((candidate) => candidate.sessionId === sessionId)
    if (line === undefined) return undefined
    // Only the first message names a line: re-titling on every message would
    // make `/list` show whatever was said most recently.
    // deliver() calls this for every message. Keep the first title, but record
    // every visit so notifications can follow a conversation resumed later.
    const alreadyNamed = typeof line.title === 'string' && line.title !== ''
    const now = new Date().toISOString()
    if (line.createdAt === undefined) line.createdAt = now
    line.lastUsedAt = now
    if (!alreadyNamed) line.title = titledWithAccount(text, accountId)
    this.#set(key, { lines, active: existing?.active ?? sessionId })
    return alreadyNamed ? undefined : line.title
  }

  /**
   * Render the line list as the text `/list` replies with.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string}
   */
  render(conversationId, accountId) {
    const all = this.list(conversationId, accountId)
    const activeId = this.active(conversationId, accountId)
    // Newest first: the lines a user wants to switch back to are the recent
    // ones, and the list is capped.
    const numbered = all.map((line, index) => ({ line, index: index + 1 }))
    const shown = numbered.slice(-LIST_LIMIT)
    const rows = shown.map(({ line, index }) => {
      const marker = line.sessionId === activeId ? '▶' : ' '
      const title = line.title ?? '(尚无对话)'
      return `${marker} ${index}. ${title}`
    })
    const hidden = numbered.length - shown.length
    const header = `共 ${all.length} 个话题，当前使用第 ${numbered.find(({ line }) => line.sessionId === activeId)?.index ?? 1} 个：`
    const footer = hidden > 0 ? `\n（只显示最近 ${LIST_LIMIT} 条，更早的 ${hidden} 条仍在，可用 /use <序号> 切换）` : ''
    const usage = '\n\n/new 新建话题 ｜ /use <序号> 切换'
    return `${header}\n${rows.join('\n')}${footer}${usage}`
  }

  /**
   * Record a line list and persist.
   * @param {string} conversationId
   * @param {{lines: Array<any>, active: string}} entry
   */
  #set(conversationId, entry) {
    this.store[conversationId] = entry
    this.#write()
  }

  #write() {
    if (!writeLines(this.store)) {
      this.warn(`could not persist ${linesFile()}; session lines are correct for this process only`)
    }
  }
}

/** The one command whose purpose is to interrupt a turn that is already running. */
const CANCEL_COMMAND = /^\/(?:cancel|取消)$/i

/**
 * Whether a message is a cancel request.
 *
 * The transport asks this before it queues a message, because `/cancel` is the
 * one command that must run *ahead* of a turn still in flight: it exists to
 * stop that turn. Everything else is delivered in per-conversation order.
 *
 * @param {unknown} text
 */
export const USE_USAGE = '用法：/use <序号>，序号来自 /list'

export function isInterruptCommand(text) {
  return typeof text === 'string' && CANCEL_COMMAND.test(text.trim())
}

// ---------------------------------------------------------------------------
// The command table
//
// Every command the bot answers is one entry below: how it is recognised, what
// it says in /help, and what it does. Adding a command used to mean editing
// three places (a regex chain, a dispatch if-chain, and the help array).
// ---------------------------------------------------------------------------

/** @typedef {{ id: string, pattern: RegExp, build: (match: RegExpExecArray) => object, help?: string, helpRank?: number, run?: (state: CommandState) => string | Promise<string> | undefined }} CommandRule */

/**
 * @typedef {object} CommandState
 * @property {SessionLines} lines
 * @property {string} conversationId
 * @property {string | undefined} accountId
 * @property {{ command: string } & Record<string, unknown>} command
 * @property {object | undefined} context
 */

const identity = () => ({})

/** @type {CommandRule[]} */
const COMMANDS = [
  {
    id: 'new',
    pattern: /^\/new(?:\s+([\S\s]+))?$/i,
    build: (match) => match[1] === undefined ? {} : { arg: match[1].trim() },
    helpRank: 1,
    helpKey: 'help.new',
  },
  { id: 'list', pattern: /^\/(?:list|sessions)$/i, build: identity, helpRank: 2, helpKey: 'help.list' },
  { id: 'outbox', pattern: /^\/outbox(?:\s+(retry))?$/i, build: m => ({ retry: Boolean(m[1]) }), helpRank: 14, helpKey: 'help.outbox' },
  {
    id: 'use',
    pattern: /^\/use(?:\s+(\d+))?$/i,
    build: (match) => ({ index: match[1] === undefined ? undefined : Number(match[1]) }),
    helpRank: 3,
    helpKey: 'help.use',
  },
  { id: 'clear', pattern: /^\/clear$/i, build: identity, helpRank: 4, helpKey: 'help.clear' },
  // `/cancel`（或 `/取消`）interrupts the turn that is running right now. It is
  // a command rather than a busy-mode action on purpose: it has to be answerable
  // WHILE the conversation is busy, which is exactly when a plain message would
  // be queued behind the turn the user wants to stop.
  //
  // Being a command is necessary but NOT sufficient: the transport used to
  // await the whole turn inside its poll loop, so a cancel sent mid-turn was
  // only read after that turn ended. `isInterruptCommand` (above) is what lets
  // the transport recognise this one command and handle it out of order.
  { id: 'cancel', pattern: CANCEL_COMMAND, build: identity, helpRank: 5, helpKey: 'help.cancel' },
  {
    id: 'compact',
    pattern: /^\/(?:compact|压缩)(?:\s+([\s\S]+))?$/i,
    build: (m) => ({ arg: m[1]?.trim() ?? '' }),
    helpRank: 5,
    helpKey: 'help.compact',
    helpText: '/compact 手动压缩当前会话上下文（长对话省 token）',
  },
  {
    id: 'status',
    pattern: /^\/status$/i,
    build: identity,
    helpRank: 15,
    helpKey: 'help.status',
    run: (state) => runStatus(state),
  },
  { id: 'help', pattern: /^\/(?:help|帮助|指令)(?:\s+(all))?$/i, build: (m) => ({ all: Boolean(m[1]) }), run: ({ context, command }) => buildCommandsHelp(context?.t, { all: command.all }) },
  { id: 'send', pattern: /^\/send(?:\s+([\S\s]+))?$/i, build: (match) => ({ arg: match[1]?.trim() ?? '' }), helpRank: 13, helpKey: 'help.send' },
]

/**
 * The help text in one locale (C33). Command rules carry a `helpKey` into the
 * catalogue rather than a sentence, so the same list can be spoken in any
 * language we ship; Chinese is the default and what `/help` produced before.
 *
 * @param {(key: string) => string} [t]
 */
export function buildCommandsHelp(t = (key) => translate(key, undefined), { all = false } = {}) {
  return [
    t('help.header'),
    ...COMMANDS
      .filter((rule) => rule.helpKey !== undefined)
      .sort((left, right) => (left.helpRank ?? 99) - (right.helpRank ?? 99))
      .map((rule) => {
        const line = t(rule.helpKey)
        return line === rule.helpKey && rule.helpText ? rule.helpText : line
      }),
    ...(!all ? [t('help.example')] : []),
  ].join('\n')
}

/** Chinese help, for callers that never configure a locale (tests, tooling). */
export const SESSION_COMMANDS_HELP = buildCommandsHelp()

/**
 * Recognise a control command, or return undefined so the caller can treat the
 * text as an ordinary message. Pure: it touches no store and no transport.
 */
export function parseSessionCommand(text) {
  const trimmed = String(text ?? '').trim()
  for (const rule of COMMANDS) {
    const match = rule.pattern.exec(trimmed)
    if (match !== null) return { command: rule.id, ...rule.build(match) }
  }
  const unknownMatch = /^\/([a-zA-Z][a-zA-Z0-9_-]*|[\u4e00-\u9fa5]{1,12})(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (unknownMatch !== null) {
    return { command: 'unknown_slash', raw: trimmed, name: unknownMatch[1] }
  }
  return undefined
}

/** Every command id the table knows, for tests and for the card. */
export function commandIds() {
  return [...new Set(COMMANDS.map((rule) => rule.id))]
}

function runStatus({ lines, conversationId, accountId, context }) {
  // Session-line facts are always available (the store owns them); the
  // account-level facts ride in `context` — undefined when a caller without
  // an inbound handler (some tests, some tools) runs a bare command, in
  // which case /status still works but says only what the lines know.
  const statusLines = lines.list(conversationId, accountId)
  const active = lines.active(conversationId, accountId)
  const activeLine = statusLines.find((candidate) => candidate.sessionId === active)
  const parts = []
  if (context?.accountId !== undefined) {
    parts.push(`账号：${context.accountLabel ? `${context.accountLabel}（${context.accountId}）` : context.accountId}`)
    if (typeof context.paused === 'boolean') parts.push(`状态：${context.paused ? '已暂停（不收发消息）' : '正常收发'}`)
    if (context.lastSeenAt) parts.push(`最近收发：${context.lastSeenAt}`)
    if (context.allowlist) {
      const source = context.allowlist.source === 'account' ? '本账号专属名单' : '全局名单'
      parts.push(`可对话联系人：${context.allowlist.senders.length} 人（${source}）`)
    }
  }
  parts.push(`当前微信聊天共 ${statusLines.length} 个话题，正在使用第 ${statusLines.findIndex((candidate) => candidate.sessionId === active) + 1 || '?'} 个：${activeLine?.title ?? '(尚无对话)'}`)
  return parts.join('\n')
}

/**
 * Execute a control command against a conversation's lines.
 *
 * Returns the reply text, or undefined when the message is not a command, so
 * the caller can continue down the normal agent path. Kept free of transport
 * concerns: the caller sends the returned text.
 *
 * @param {SessionLines} lines
 * @param {string} conversationId
 * @param {string} text
 * @param {string} [accountId] owning bot account; bare key when absent
 * @param {{ accountId?: string, accountLabel?: string | null, paused?: boolean,
 *   lastSeenAt?: string, allowlist?: { source: 'account' | 'global', senders: string[] },
 *   cancelRunningTurn?: () => string,
 *   compactSession?: (arg: string) => string | Promise<string>,
 *   t?: (key: string, params?: Record<string, unknown>) => string,
 *   persona?: Record<string, (arg?: string) => string | Promise<string>> }} [context]
 *   Account facts are used by `/status`; the bridge supplies cancellation and
 *   compaction. The inbound handler supplies the authorized `/send` handler.
 * @returns {string | Promise<string> | undefined}
 */
export function runSessionCommand(lines, conversationId, text, accountId, context) {
  const command = parseSessionCommand(text)
  if (command === undefined) return undefined
  const t = typeof context?.t === 'function'
    ? context.t
    : (key, params) => translate(key, params)

  const rule = COMMANDS.find((candidate) => candidate.id === command.command)
  if (rule?.run !== undefined) return rule.run({ lines, conversationId, accountId, command, context })

  if (command.command === 'new') {
    const sessionId = lines.create(conversationId, accountId)
    const title = typeof command.arg === 'string' ? command.arg.trim() : ''
    if (title !== '') lines.title(conversationId, sessionId, title, accountId)
    const ordinal = lines.list(conversationId, accountId).length
    // A bare `/new` is named by its first real message. An optional argument
    // names it immediately through the same title path, so later messages do
    // not overwrite it.
    return `已开启第 ${ordinal} 个话题，接下来的消息进入这里。\n（之前的话题仍然保留，/list 可以切回去）`
  }
  if (command.command === 'list') {
    return lines.render(conversationId, accountId)
  }
  if (command.command === 'outbox') {
    return context?.handleOutbox?.(command.retry) ?? t('error.featureUnavailable')
  }
  if (command.command === 'clear') {
    // Deliberately refuses an argument: `/clear 3` would read like `/use 3`
    // with a reset bolted on, and picking one line out of the list to wipe is
    // a rarer need than "start over" — misfiring it destroys context, so the
    // safer surface is the one that cannot be aimed at the wrong line.
    lines.clear(conversationId, accountId)
    return `已从当前微信聊天的话题列表移除所有话题，并新开一个。\nDSH 里原来的会话历史仍会保留，不会因为这一步被删除。`
  }
  if (command.command === 'cancel') {
    // The bridge owns the live agent handles; a bare caller (tests, tooling)
    // has no turn to interrupt and says so instead of pretending.
    const cancel = context?.cancelRunningTurn
    if (cancel === undefined) return t('error.cancelUnavailable')
    return cancel()
  }
  if (command.command === 'compact') {
    return typeof context?.compactSession === 'function'
      ? context.compactSession(command.arg)
      : t('error.compactUnavailable')
  }
  if (command.command === 'unknown_slash') {
    return `未知指令：/${command.name}（发送 /help 查看可用指令）`
  }
  if (command.command === 'send') {
    const handler = context?.persona?.send
    if (typeof handler !== 'function') return t('error.featureUnavailable')
    return handler(command.arg)
  }
  if (command.index === undefined) {
    return `${USE_USAGE}\n\n${lines.render(conversationId, accountId)}`
  }
  const sessionId = lines.use(conversationId, command.index, accountId)
  if (sessionId === undefined) {
    return `没有第 ${command.index} 个话题。\n\n${lines.render(conversationId, accountId)}`
  }
  const line = lines.list(conversationId, accountId).find((candidate) => candidate.sessionId === sessionId)
  const title = line?.title ?? '(尚无对话)'
  return `已切换到第 ${command.index} 个话题：${title}\n接下来的消息进入这里，这个 DSH 会话之前的上下文还在。`
}
