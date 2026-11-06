// Account registry — the card's view of every saved account, beyond credentials.
//
// The credential files (`accounts/<id>.json`, vendored layout) hold only what
// the server needs: token, baseUrl, userId. Everything an operator needs to
// *manage* an account — which one is which (label), whether messages are still
// flowing (lastSeenAt), whether the operator paused it — used to live nowhere,
// so the card could show "已绑定" for an account that had been silent for days.
//
// This module keeps that extra state in `<state>/accounts-registry.json`, keyed
// by the same accountId the credential files use. It is a side table: deleting
// a credential must leave the registry entry harmless (paused/label of an
// account that no longer exists is simply not shown), and re-binding an account
// keeps its label and paused flag — an operator should not have to re-describe
// an account after every re-login.
//
// Writes go through tmp+rename (the convention from src/sessions.js). Missing
// files still use the first-run behavior, but an existing unreadable registry
// must not be treated as empty for authorization or read-modify-write operations.
// @module dsh-weixin/account-registry
import { readTextFileCached } from './atomic.js'
import path from 'node:path'
import { atomicWriteJson } from './atomic.js'
import { stateDir } from './state.js'

/** Absolute path of the registry file. */
export function registryFile() {
  return path.join(stateDir(), 'accounts-registry.json')
}

export class RegistryReadError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'RegistryReadError'
    this.code = 'ACCOUNT_REGISTRY_UNREADABLE'
  }
}

/**
 * Read the whole registry.
 *
 * A missing file is the first-run state and yields `{}`. Ordinary UI reads keep
 * their historical tolerant behavior. Callers making an authorization decision
 * pass `{ failClosed: true, accountId }`: an unreadable document or malformed
 * entry for that account throws instead of looking like an empty registry.
 */
export function readRegistry({ failClosed = false, accountId } = {}) {
  let parsed
  try {
    parsed = JSON.parse(readTextFileCached(registryFile()))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    const message = `dsh-weixin: cannot read account registry ${registryFile()}; restore or repair it (${String(error?.message ?? error)})`
    if (failClosed) throw new RegistryReadError(message, { cause: error })
    process.emitWarning(message)
    return {}
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // The schema stamp shares the object with the account entries; it is
    // metadata, not an account, so it must not leak into the map.
    delete parsed.schemaVersion
    if (failClosed && typeof accountId === 'string' && accountId !== '') validateAccountEntry(parsed, accountId)
    return parsed
  }
  const message = `dsh-weixin: account registry ${registryFile()} is not a JSON object; restore or repair it`
  if (failClosed) throw new RegistryReadError(message)
  process.emitWarning(message)
  return {}
}

/** Validate only the account being used; other entries must survive unchanged. */
export function validateAccountEntry(registry, accountId) {
  if (!Object.hasOwn(registry, accountId)) return
  const entry = registry[accountId]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new RegistryReadError(`dsh-weixin: invalid account entry ${accountId} in ${registryFile()}; restore or repair the account registry`)
  }
  for (const key of ['allowedSenders', 'allowedChats']) {
    if (Object.hasOwn(entry, key) && (!Array.isArray(entry[key]) || !entry[key].every((item) => typeof item === 'string'))) {
      throw new RegistryReadError(`dsh-weixin: invalid ${key} for account ${accountId} in ${registryFile()}; restore or repair the account registry`)
    }
  }
  if ((Object.hasOwn(entry, 'paused') && typeof entry.paused !== 'boolean') ||
      (Object.hasOwn(entry, 'firstContactEnrolledAt') && typeof entry.firstContactEnrolledAt !== 'string')) {
    throw new RegistryReadError(`dsh-weixin: invalid authorization state for account ${accountId} in ${registryFile()}; restore or repair the account registry`)
  }
}

/**
 * Write the whole registry atomically; failure warns but never throws.
 *
 * @param {{ durable?: boolean, writeJson?: typeof atomicWriteJson }} [options]
 * @returns {boolean} whether the registry was persisted
 */
export function writeRegistry(registry, warn = () => {}, options = {}) {
  const writeJson = options.writeJson ?? atomicWriteJson
  return writeJson(registryFile(), { schemaVersion: 1, ...registry }, {
    warn: (message) => warn(`dsh-weixin: could not persist the registry: ${message}`),
    // Settings edits and enrolments keep the default (durable). The last-seen
    // bookkeeping that runs on every message passes durable: false.
    durable: options.durable !== false,
  })
}

/**
 * One account's registry entry, creating it on first touch.
 *
 * `createdAt` is when the account was first seen by this module; `lastSeenAt`
 * is the last time inbound traffic was accepted for it. Neither is rewritten
 * on later touches.
 */
export function ensureAccountEntry(registry, accountId) {
  let entry = registry[accountId]
  if (entry === undefined || entry === null || typeof entry !== 'object') {
    entry = {}
    registry[accountId] = entry
  }
  if (typeof entry.createdAt !== 'string') entry.createdAt = new Date().toISOString()
  return entry
}

/**
 * How often a repeated touch of the same account may rewrite the registry.
 *
 * `touchAccount` runs on every accepted message. Rewriting a file with an fsync
 * each time measured ~4ms of blocked event loop per message, for a timestamp
 * the card renders as "silent since N minutes". One write a minute per account
 * is indistinguishable in the UI and free on the hot path.
 */
export const TOUCH_WRITE_INTERVAL_MS = 60_000

/** `${registry file}|${accountId}` → when we last persisted a touch. */
const lastTouchWriteAt = new Map()

/**
 * Record that the account just received or sent a message.
 *
 * Throttled: at most one write per account per {@link TOUCH_WRITE_INTERVAL_MS}.
 * Pass `throttleMs: 0` to force a write (tests, and callers that just changed
 * the registry and want lastSeenAt fresh on the same put).
 *
 * @param {string} accountId
 * @param {(message: string) => void} [warn]
 * @param {{ now?: number, throttleMs?: number }} [options]
 * @returns {boolean} whether the timestamp was persisted this time
 */
export function touchAccount(accountId, warn = () => {}, options = {}) {
  if (typeof accountId !== 'string' || accountId === '') return false
  const file = registryFile()
  const key = `${file}|${accountId}`
  const now = options.now ?? Date.now()
  const throttleMs = options.throttleMs ?? TOUCH_WRITE_INTERVAL_MS
  const previous = lastTouchWriteAt.get(key) ?? 0
  if (throttleMs > 0 && now - previous < throttleMs) return false
  const registry = readRegistry({ failClosed: true, accountId })
  const entry = ensureAccountEntry(registry, accountId)
  entry.lastSeenAt = new Date(now).toISOString()
  const persisted = writeRegistry(registry, warn, { durable: false })
  if (persisted) lastTouchWriteAt.set(key, now)
  return persisted
}

/** Forget the throttle state — used by tests that switch state directories. */
export function resetTouchThrottle() {
  lastTouchWriteAt.clear()
}

/**
 * Pause or resume an account's inbound loop.
 *
 * A paused account keeps its credentials and its session history; the host
 * simply stops polling it, the way "退出登录" would — but without deleting the
 * login, so resuming is instant and needs no re-scan.
 *
 * @returns {boolean} whether the pause state was persisted
 */
export function setAccountPaused(accountId, paused, warn = () => {}, options = {}) {
  const registry = readRegistry({ failClosed: true, accountId })
  const entry = ensureAccountEntry(registry, accountId)
  entry.paused = paused === true
  entry.pausedAt = entry.paused ? new Date().toISOString() : undefined
  return writeRegistry(registry, warn, options)
}

/** Whether an account is paused. An unreadable registry also stops delivery. */
export function isAccountPaused(accountId) {
  if (typeof accountId !== 'string' || accountId === '') return false
  try {
    return readRegistry({ failClosed: true, accountId })[accountId]?.paused === true
  } catch (error) {
    if (!(error instanceof RegistryReadError)) throw error
    process.emitWarning(error.message)
    return true
  }
}

/**
 * Set a human-facing label ("妈妈的微信" etc.) for an account.
 * The card shows the label next to the raw id, which is otherwise meaningless.
 */
export function setAccountLabel(accountId, label, warn = () => {}) {
  const registry = readRegistry({ failClosed: true, accountId })
  const entry = ensureAccountEntry(registry, accountId)
  const trimmed = typeof label === 'string' ? label.trim() : ''
  if (trimmed === '') delete entry.label
  else entry.label = trimmed
  return writeRegistry(registry, warn)
}

/**
 * Read one account's label back, for callers that render or prefix with it.
 *
 * Read-only and failure-tolerant: any problem reads as "no label" and the
 * caller falls back to the account id.
 *
 * @param {string} accountId
 * @returns {string} the stored label, or '' when there is none
 */
export function labelForAccount(accountId) {
  try {
    const entry = readRegistry()[String(accountId ?? '').trim()]
    const label = entry?.label
    return typeof label === 'string' ? label : ''
  } catch {
    return ''
  }
}

/**
 * Per-account sender allowlist override.
 *
 * The global allowlist in config.json applies to every account; an entry here
 * narrows (or replaces) it for ONE account. Stored in the registry — not in
 * the credential file — because the vendored credential writer rewrites that
 * file on every re-login and would silently drop the override.
 *
 * An empty/undefined senders list means "no override": the global list rules.
 * This cannot be confused with "deny all" — deny-all is what the GLOBAL list
 * being empty does, and an account-level override that denied everything
 * would make the account unreachable with no way back except editing JSON.
 * Operators who want an account silent pause it instead.
 *
 * @param {string} accountId
 * @param {string[] | undefined} senders sender ids to allow for this account only
 * @param {string[] | undefined} [chats] optional conversation ids for this account
 */
export function setAccountAllowlist(accountId, senders, chats, warn = () => {}) {
  const registry = readRegistry({ failClosed: true, accountId })
  const entry = ensureAccountEntry(registry, accountId)
  const clean = (list) => (Array.isArray(list) ? list.map((item) => String(item).trim()).filter((item) => item !== '') : [])
  const sendersClean = clean(senders)
  const chatsClean = clean(chats)
  if (sendersClean.length === 0) delete entry.allowedSenders
  else entry.allowedSenders = sendersClean
  if (chatsClean.length === 0) delete entry.allowedChats
  else entry.allowedChats = chatsClean
  return writeRegistry(registry, warn)
}

/**
 * The effective allowlist for one account: the account's own override when it
 * has one, the global config otherwise. Returned shape matches what
 * {@link import('./security/allowlist.js').isAllowedSender} consumes.
 *
 * @param {string} accountId
 * @param {{ allowedSenders?: string[], allowedChats?: string[] }} config the global plugin config
 * @param {{ failClosed?: boolean }} [options] fail closed when authorization
 *   state exists but cannot be read
 * @returns {{ allowedSenders: string[], allowedChats: string[] }}
 */
export function allowlistForAccount(accountId, config, options = {}) {
  const registry = readRegistry({ ...options, accountId })
  const entry = typeof accountId === 'string' && accountId !== '' ? registry[accountId] : undefined
  const senders = Array.isArray(entry?.allowedSenders) && entry.allowedSenders.length > 0
    ? entry.allowedSenders
    : (config.allowedSenders ?? [])
  const chats = Array.isArray(entry?.allowedChats) && entry.allowedChats.length > 0
    ? entry.allowedChats
    : (config.allowedChats ?? [])
  return { allowedSenders: senders, allowedChats: chats }
}

/**
 * Enrol the FIRST contact of a freshly bound account into that account's own
 * allowlist — the "first contact is the scanner" rule.
 *
 * At scan time the login flow only learns the BOT id; the human's WeChat id
 * (`o9cq...@im.wechat`) first appears with the first inbound message, so the
 * allowlist cannot be pre-filled at bind. This hook runs inside the inbound
 * handler's refusal branch: when the account has never had an allowlist
 * enrolment, the first denied sender is written into the account-level
 * allowlist and the message itself is allowed through.
 *
 * Only the FIRST contact enrols: afterwards the account has an override and
 * further strangers are refused. The first contact may not be the scanner.
 * The caller must check that the effective sender list is empty and the chat
 * is permitted before calling this function.
 *
 * @param {string} accountId
 * @param {string} senderId the sender to enrol
 * @param {() => boolean} hasOverride whether the account already carries an
 *   account-level allowlist override (checked by the caller against the same
 *   registry snapshot it refused under, so the read and the write agree)
 * @param {(line: string) => void} [note] called with a human-readable line
 *   describing what was enrolled (the caller logs it)
 * @returns {boolean} true when the sender was enrolled and the caller should
 *   let the message through; false when enrolment does not apply
 */
export function enrolFirstContact(accountId, senderId, hasOverride, note = () => {}) {
  if (typeof accountId !== 'string' || accountId === '') return false
  if (typeof senderId !== 'string' || senderId === '') return false
  if (hasOverride()) return false
  const registry = readRegistry({ failClosed: true, accountId })
  // Re-check against a fresh read: the caller's snapshot may be stale if a
  // concurrent handler for the same account enrolled between the two reads.
  const entry = registry[accountId]
  if (Array.isArray(entry?.allowedSenders) && entry.allowedSenders.length > 0) return false
  if (entry?.firstContactEnrolledAt) return false
  const fresh = ensureAccountEntry(registry, accountId)
  fresh.allowedSenders = [senderId]
  fresh.firstContactEnrolledAt = new Date().toISOString()
  if (!writeRegistry(registry, () => {})) return false
  note(`first contact ${senderId} enrolled into account ${accountId}'s allowlist`)
  return true
}
