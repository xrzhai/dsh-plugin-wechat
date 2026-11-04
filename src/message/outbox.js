/**
 * The outbox: a reply that was written but not yet delivered.
 *
 * Today a send is fire-and-forget. If the socket is down at that moment — the
 * laptop slept, the phone is on a train, the server hiccups — the reply the
 * model already produced is simply gone, and the user is left talking to a bot
 * that "ignored" them. Reminders and /subscribe messages are worse: they are
 * the whole point of the feature and nobody will ever retype them.
 *
 * So a failed text send is persisted here and retried with backoff. This is not
 * a general queue: it holds outbound text per conversation, in order, and tries
 * again until it lands or the operator drops it. Media is deliberately not
 * queued — a file that missed its moment is worse resent late than not at all,
 * and the file may be gone from disk.
 *
 * Delivery is at-least-once. WeChat's API has no idempotency key we can rely on,
 * so a send that succeeded but whose response was lost can be delivered twice;
 * the alternative (dropping it) is worse for a reminder.
 *
 * @module dsh-weixin/message/outbox
 */

import { statePath } from '../state-layout.js'
import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'
import fs from 'node:fs'

/**
 * How long an inbound `context_token` is worth echoing.
 *
 * iLink issues the token with a ten-minute window (issue #9: a message received
 * at 15:44:25 was still accepted at 15:54:21 and refused at 15:54:37). The token
 * is what routes the reply; once it is too old the server answers
 * `prepare failed`, so retrying the same item can never succeed — it would just
 * burn the eight attempts and then park a message we know cannot be delivered.
 *
 * Eight minutes leaves a two-minute margin for clock skew and the send itself.
 * An item without a token is not subject to this: it sends on the conversation
 * path (or the typing-ticket fallback), which has no such window.
 */
export const CONTEXT_TOKEN_TTL_MS = 8 * 60_000

/** Attempts before an item is parked (kept, but no longer retried by the timer). */
export const MAX_ATTEMPTS = 8
/** First retry delay, doubling per attempt, capped. */
export const BASE_RETRY_MS = 30_000
export const MAX_RETRY_MS = 30 * 60_000
/** How many undelivered items are kept before the oldest are dropped. */
export const MAX_ITEMS = 50
/** Timer period. */
export const FLUSH_INTERVAL_MS = 30_000

/** @param {string} stateRoot */
export function outboxFile(stateRoot) {
  return statePath(stateRoot, 'outbox')
}

/**
 * @param {string} stateRoot
 * @param {{ warn?: (message: string) => void }} [options]
 * @returns {{ items: any[] }}
 */
export function readOutbox(stateRoot, { warn = () => {} } = {}) {
  return readJsonFile(outboxFile(stateRoot), {
    warn,
    version: 1,
    fallback: () => ({ items: [] }),
    migrate: (parsed) => ({ items: Array.isArray(parsed.items) ? parsed.items.filter((item) => item && typeof item.text === 'string' && typeof item.conversationId === 'string') : [] }),
  })
}

/**
 * Would sending this item with its stored context token be refused outright?
 *
 * Only items that actually carry a token are affected; the age is measured from
 * when it was queued, which is a slightly conservative stand-in for when the
 * inbound message arrived (the reply is written seconds later, never earlier).
 *
 * @param {{ contextToken?: string, createdAt?: number }} item
 * @param {number} at
 */
export function tokenExpired(item, at = Date.now()) {
  if (typeof item?.contextToken !== 'string' || item.contextToken === '') return false
  const born = Number(item.createdAt ?? 0)
  if (!Number.isFinite(born) || born <= 0) return false
  return at - born >= CONTEXT_TOKEN_TTL_MS
}

/** @param {number} attempts */
export function retryDelayMs(attempts) {
  const delay = BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1)
  return Math.min(MAX_RETRY_MS, delay)
}

/**
 * A durable outbox bound to one state root.
 *
 * @param {object} options
 * @param {string} options.stateRoot
 * @param {(accountId: string) => { send: (message: any) => Promise<void> } | undefined} options.transportFor
 * @param {(message: string) => void} [options.warn]
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createOutbox({ stateRoot, transportFor, warn = () => {}, log = () => {}, now = () => Date.now() }) {
  /** @param {{ items: any[] }} store */
  const save = (store) => atomicWriteJson(outboxFile(stateRoot), { schemaVersion: 1, ...store }, { warn })

  /**
   * Persist one undelivered text. Returns the item id.
   *
   * @param {{ accountId: string, conversationId: string, text: string, contextToken?: string }} entry
   */
  const enqueue = (entry) => {
    const store = readOutbox(stateRoot, { warn })
    const at = now()
    const item = {
      id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      accountId: entry.accountId,
      conversationId: entry.conversationId,
      text: entry.text,
      ...(entry.contextToken ? { contextToken: entry.contextToken } : {}),
      createdAt: at,
      attempts: 0,
      notBefore: at,
      lastError: '',
    }
    store.items.push(item)
    // Oldest first: the newest message is the one the user is waiting on.
    while (store.items.length > MAX_ITEMS) store.items.shift()
    save(store)
    log(`outbox: queued ${store.items.length} undelivered message(s) for ${entry.conversationId}`)
    return item.id
  }

  /**
   * Drop dead letters that can never be delivered: an item whose context token
   * expired *after* it had already burned its retry budget. A still-retryable
   * item whose token expired is NOT dropped — `flush` retries it tokenless — but
   * a parked one has nothing left to try, so it only fills `/outbox` and the
   * pending gauge until it ages out. This is the cleanup that keeps the durable
   * outbox from slowly becoming a graveyard (issue #21).
   *
   * @returns {number} how many items were dropped
   */
  const prune = () => {
    const store = readOutbox(stateRoot, { warn })
    const before = store.items.length
    const at = now()
    store.items = store.items.filter((item) => !(Number(item.attempts ?? 0) >= MAX_ATTEMPTS && tokenExpired(item, at)))
    if (store.items.length !== before) {
      save(store)
      log(`outbox: pruned ${before - store.items.length} undeliverable dead letter(s)`)
    }
    return before - store.items.length
  }

  // Merge only the attempted entry into the latest durable queue. Never put
  // back an entry dropped (or evicted by MAX_ITEMS) while its send was pending.
  const updateItem = (item) => {
    const store = readOutbox(stateRoot, { warn })
    const index = store.items.findIndex((entry) => entry.id === item.id)
    if (index === -1) return
    store.items[index] = item
    save(store)
  }

  /**
   * Try to deliver everything that is due. Items stay in order per conversation.
   *
   * @param {{ force?: boolean }} [options] force ignores notBefore (manual retry)
   * @returns {Promise<{ sent: number, failed: number, remaining: number }>}
   */
  const runFlush = async (options = {}) => {
    // Clear the parked dead letters first: they are the residue of the old
    // "retry an expired token until it parks" behaviour, and nothing below can
    // ever send them.
    prune()
    const store = readOutbox(stateRoot, { warn })
    if (store.items.length === 0) return { sent: 0, failed: 0, remaining: 0 }
    const at = now()
    let sent = 0
    let failed = 0
    // Grouped by conversation so one conversation's stuck item does not let the
    // next one overtake it.
    const byConversation = new Map()
    for (const item of store.items) {
      const key = `${item.accountId}|${item.conversationId}`
      if (!byConversation.has(key)) byConversation.set(key, [])
      byConversation.get(key).push(item)
    }
    for (const queue of byConversation.values()) {
      let blocked = false
      for (const candidate of queue) {
        if (blocked) continue
        // A previous send yielded to enqueue/drop/prune. Only send entries that
        // still exist; the snapshot determines this pass's order, not its state.
        const item = readOutbox(stateRoot, { warn }).items.find((entry) => entry.id === candidate.id)
        if (item === undefined) continue
        // A reply riding an expired context token can no longer be routed by it
        // — iLink answers `prepare failed` (issue #9/#21). The text is still
        // worth delivering, so drop the token and fall through to the tokenless
        // path (the account's typing ticket, or the bare conversation route).
        // Only an item that is ALSO out of retries is a genuine dead letter, and
        // `prune()` has already removed those above.
        if (tokenExpired(item, at)) {
          delete item.contextToken
          item.lastError = 'context token expired; retrying without it'
        }
        if (item.attempts >= MAX_ATTEMPTS) {
          updateItem(item)
          blocked = false
          continue
        }
        if (options.force !== true && Number(item.notBefore ?? 0) > at) {
          updateItem(item)
          blocked = true
          continue
        }
        const transport = transportFor(item.accountId)
        if (transport === undefined) {
          item.lastError = 'no live transport'
          updateItem(item)
          blocked = true
          continue
        }
        try {
          await transport.send({ conversationId: item.conversationId, type: 'text', text: item.text, contextToken: item.contextToken })
          drop(item.id)
          sent += 1
        } catch (error) {
          item.attempts = Number(item.attempts ?? 0) + 1
          item.lastError = String(error?.message ?? error)
          item.notBefore = at + retryDelayMs(item.attempts)
          updateItem(item)
          failed += 1
          blocked = true
        }
      }
    }
    const remaining = readOutbox(stateRoot, { warn }).items.length
    if (sent > 0) log(`outbox: delivered ${sent} queued message(s), ${remaining} still waiting`)
    return { sent, failed, remaining }
  }

  // Timer and manual retries join the same pass, rather than sending its
  // snapshot twice. The first caller's force option applies; new entries are
  // left for the next pass. Defer execution until the guard is installed, even
  // when transportFor/send synchronously re-enters flush.
  let inFlight
  const flush = (options = {}) => {
    if (inFlight !== undefined) return inFlight
    inFlight = Promise.resolve().then(() => runFlush(options)).finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  /** @returns {any[]} the parked items, oldest first */
  const pending = () => readOutbox(stateRoot, { warn }).items

  /** Drop one item (the card's 「丢弃」). */
  const drop = (id) => {
    const store = readOutbox(stateRoot, { warn })
    const before = store.items.length
    store.items = store.items.filter((item) => item.id !== id)
    if (store.items.length !== before) save(store)
    return store.items.length !== before
  }

  let timer
  const start = () => {
    timer = setInterval(() => {
      void flush().catch((error) => warn(`outbox flush failed: ${String(error?.message ?? error)}`))
    }, FLUSH_INTERVAL_MS)
    timer.unref?.()
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  return { enqueue, flush, pending, drop, prune, start, stop }
}

/**
 * Whether a file the outbox points at still exists (used by media suggestions
 * in the card; text items do not need it).
 *
 * @param {string} file
 */
/**
 * 待重发队列的人话版（`/outbox`）。只读，不触发发送。
 *
 * @param {Array<{id:string,createdAt:number,attempts?:number,lastError?:string,text?:string}>} items
 * @param {{ now?: number, limit?: number }} [options]
 */
export function formatOutbox(items, { now = Date.now(), limit = 5 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return '重发队列是空的。'
  const shown = items.slice(0, limit)
  const lines = shown.map((item, index) => {
    const minutes = Math.max(0, Math.round((now - Number(item.createdAt ?? now)) / 60_000))
    const preview = String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
    const failure = item.lastError ? ` · 上次失败：${String(item.lastError).slice(0, 60)}` : ''
    return `${index + 1}. ${item.id} · ${minutes} 分钟前 · 尝试 ${item.attempts ?? 0} 次${failure}\n   ${preview}${String(item.text ?? '').length > 40 ? '…' : ''}`
  })
  const more = items.length > limit ? `\n…还有 ${items.length - limit} 条。` : ''
  return `待重发 ${items.length} 条：\n${lines.join('\n')}${more}\n\n/outbox retry 立即重试；/outbox drop <id> 丢弃一条。`
}

export function stillOnDisk(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

