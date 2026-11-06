/**
 * The outbox: a reply that was written but not yet delivered.
 *
 * Today a send is fire-and-forget. If the socket is down at that moment — the
 * laptop slept, the phone is on a train, the server hiccups — the reply the
 * model already produced is simply gone, and the user is left talking to a bot
 * that "ignored" them.
 *
 * So a failed text send is persisted here and retried with backoff. This is not
 * a general queue: it holds outbound text per conversation, in order, and tries
 * again until it lands or the operator drops it. Media is deliberately not
 * queued — a file that missed its moment is worse resent late than not at all,
 * and the file may be gone from disk.
 *
 * Delivery is at-least-once. WeChat's API has no idempotency key we can rely on,
 * so a send that succeeded but whose response was lost can be delivered twice.
 * When the transport flags that uncertainty, only a manual retry may replay it.
 *
 * @module dsh-weixin/message/outbox
 */

import { statePath } from '../state-layout.js'
import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'
import { chunkText } from './chunker.js'

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
/** Legacy queue rows predate a stored cap; match the plugin's config default. */
export const DEFAULT_OUTBOX_MAX_MESSAGE_LENGTH = 1_500

const OUTBOX_SCHEMA_VERSION = 3

function normalizeMaxMessageLength(value) {
  const limit = Math.floor(Number(value))
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_OUTBOX_MAX_MESSAGE_LENGTH
}

function splitSegments(segments, maxMessageLength) {
  return segments.flatMap((segment) => segment === '' ? [''] : chunkText(segment, maxMessageLength))
}

function persistOutboxFile(file, value, { warn }) {
  if (!atomicWriteJson(file, value, { warn })) throw new Error(`could not persist ${path.basename(file)}`)
  return true
}

/**
 * Normalise current and legacy queue rows into the segmented in-memory shape.
 * Legacy rows are split at the plugin's default cap. Current rows are
 * defensively re-split if their segments exceed their queue-time cap.
 *
 * The cap is stored with each item. Config changes therefore apply to newly
 * queued rows; already queued rows remain bounded by the cap they were created
 * under, which is the only safe value available during a restart.
 */
function normalizeOutboxItem(item) {
  if (item === null || typeof item !== 'object') return undefined
  if (typeof item.conversationId !== 'string') return undefined
  let sourceSegments
  if (Array.isArray(item.segments) && item.segments.length > 0 && item.segments.every((segment) => typeof segment === 'string')) {
    sourceSegments = [...item.segments]
  } else if (typeof item.text === 'string') {
    sourceSegments = [item.text]
  } else {
    return undefined
  }
  const candidateIndex = Number(item.nextSegment ?? 0)
  const oldNextSegment = Number.isInteger(candidateIndex) && candidateIndex >= 0 ? candidateIndex : 0
  if (oldNextSegment >= sourceSegments.length) return undefined
  const maxMessageLength = normalizeMaxMessageLength(item.maxMessageLength)
  const segments = []
  let nextSegment = 0
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const pieces = splitSegments([sourceSegments[index]], maxMessageLength)
    if (index < oldNextSegment) nextSegment += pieces.length
    segments.push(...pieces)
  }
  // A crash after recording the final successful segment but before deleting
  // the row must not replay the whole reply on restart.
  if (nextSegment >= segments.length) return undefined
  return {
    ...item,
    text: typeof item.text === 'string' ? item.text : segments.join(''),
    segments,
    nextSegment,
    maxMessageLength,
  }
}

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
  const file = outboxFile(stateRoot)
  return readJsonFile(file, {
    warn,
    version: OUTBOX_SCHEMA_VERSION,
    fallback: () => ({ items: [] }),
    migrate: (parsed) => ({
      items: Array.isArray(parsed.items)
        ? parsed.items.map(normalizeOutboxItem).filter((item) => item !== undefined)
        : [],
    }),
    persist: (stamped) => persistOutboxFile(file, stamped, { warn }),
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
  const file = outboxFile(stateRoot)
  const save = (store) => persistOutboxFile(file, { schemaVersion: OUTBOX_SCHEMA_VERSION, ...store }, { warn })

  /**
   * Persist one undelivered text. Returns the item id.
   *
   * `segments` lets the sender preserve the exact messages that still need to
   * go out. `text` remains the human-readable full body and is also the legacy
   * one-segment input. The queue-time message cap is persisted so retries and
   * restarts keep the same boundary even if live configuration later changes.
   *
   * @param {{ accountId: string, conversationId: string, text?: string, segments?: string[], contextToken?: string, maxMessageLength?: number, deliveryUncertain?: boolean }} entry
   */
  const enqueue = (entry) => {
    let sourceSegments
    if (Array.isArray(entry.segments) && entry.segments.length > 0 && entry.segments.every((segment) => typeof segment === 'string')) {
      sourceSegments = [...entry.segments]
    } else if (typeof entry.text === 'string') {
      sourceSegments = [entry.text]
    } else {
      throw new TypeError('outbox entry needs text or non-empty string segments')
    }
    const maxMessageLength = normalizeMaxMessageLength(entry.maxMessageLength)
    const segments = splitSegments(sourceSegments, maxMessageLength)
    if (segments.length === 0) throw new TypeError('outbox entry did not contain any text')
    const store = readOutbox(stateRoot, { warn })
    const at = now()
    const item = {
      id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      accountId: entry.accountId,
      conversationId: entry.conversationId,
      text: typeof entry.text === 'string' ? entry.text : segments.join(''),
      segments,
      nextSegment: 0,
      maxMessageLength,
      ...(entry.contextToken ? { contextToken: entry.contextToken } : {}),
      createdAt: at,
      attempts: 0,
      ...(entry.deliveryUncertain === true ? { deliveryUncertain: true } : {}),
      notBefore: at,
      lastError: entry.deliveryUncertain === true ? 'delivery uncertain; manual retry required' : '',
    }
    store.items.push(item)
    // Oldest first: the newest message is the one the user is waiting on.
    while (store.items.length > MAX_ITEMS) store.items.shift()
    save(store)
    log(`outbox: queued ${store.items.length} undelivered message(s) for ${entry.conversationId}`)
    return item.id
  }

  // Merge only the attempted entry into the latest durable queue. Never put
  // back an entry dropped (or evicted by MAX_ITEMS) while its send was pending.
  const updateItem = (id, mutate) => {
    const store = readOutbox(stateRoot, { warn })
    const item = store.items.find((entry) => entry.id === id)
    if (item === undefined) return false
    mutate(item)
    save(store)
    return true
  }

  const freshItem = (id) => readOutbox(stateRoot, { warn }).items.find((entry) => entry.id === id)

  const withoutExpiredToken = (id) => {
    const item = freshItem(id)
    if (item === undefined || !tokenExpired(item, now())) return item
    updateItem(id, (current) => {
      delete current.contextToken
    })
    return freshItem(id)
  }

  let stopped = false
  // A slot is shared only by overlapping requests that saw the same queue row.
  // Record the outcome once, even if a timer pass and a scoped retry both saw it.
  const runFlush = async ({ rows, matches, force }) => {
    const blocked = new Set()
    for (const { id, chat, slot } of rows) {
      if (blocked.has(chat)) continue
      if (slot.outcome) {
        if (slot.outcome !== 'sent') blocked.add(chat)
        continue
      }
      let item = withoutExpiredToken(id)
      if (item === undefined) continue
      if (!force && (item.attempts >= MAX_ATTEMPTS || item.deliveryUncertain === true)) continue
      if (!force && Number(item.notBefore ?? 0) > now()) {
        blocked.add(chat)
        continue
      }
      const transport = transportFor(item.accountId)
      if (transport === undefined) {
        updateItem(id, (current) => { current.lastError = 'no live transport' })
        slot.outcome = 'unavailable'
        blocked.add(chat)
        continue
      }

      // Until success is durably recorded, a request already waiting behind
      // this pass must not replay a segment (even if the progress write throws).
      slot.outcome = 'interrupted'
      while (item !== undefined) {
        if (stopped || transportFor(item.accountId) !== transport) break
        const index = item.nextSegment
        try {
          await transport.send({
            conversationId: item.conversationId,
            type: 'text',
            text: item.segments[index],
            contextToken: item.contextToken,
          })
        } catch (error) {
          const failedAt = now()
          updateItem(id, (current) => {
            current.attempts = Number(current.attempts ?? 0) + 1
            if (error?.deliveryUncertain === true) current.deliveryUncertain = true
            current.lastError = String(error?.message ?? error)
            current.notBefore = failedAt + retryDelayMs(current.attempts)
          })
          slot.outcome = 'failed'
          break
        }

        const saved = updateItem(id, (current) => {
          if (current.nextSegment === index) current.nextSegment = index + 1
          delete current.deliveryUncertain
          current.lastError = ''
        })
        if (index === item.segments.length - 1) {
          if (saved) drop(id)
          slot.outcome = 'sent'
          break
        }
        // A drop during send must stop the suffix. Otherwise re-read progress,
        // token age and transport before sending another segment (#109).
        if (!saved) break
        item = withoutExpiredToken(id)
      }
      if (slot.outcome !== 'sent') blocked.add(chat)
    }

    const result = { sent: 0, failed: 0, remaining: readOutbox(stateRoot, { warn }).items.filter(matches).length }
    for (const { slot: { outcome } } of rows) {
      if (outcome === 'sent' || outcome === 'failed') result[outcome]++
      else if (outcome === 'unavailable' && force) result.unavailable = (result.unavailable ?? 0) + 1
    }
    if (result.sent > 0) log(`outbox: delivered ${result.sent} queued message(s), ${result.remaining} still waiting`)
    return result
  }

  // Identical requests coalesce. Different scopes or retry policies get their
  // own serialized pass and counts. Skipping a parked row on a timer leaves its
  // slot untouched, so an overlapping manual request can actually recover it.
  const passes = new Map()
  let tail = Promise.resolve()
  /**
   * @param {{ force?: boolean, accountId?: string, conversationId?: string }} [options]
   * Pass both IDs to limit reads for delivery, retries and counts to one chat.
   * Force includes parked rows and bypasses backoff for this pass only.
   */
  const flush = (options = {}) => {
    const { accountId, conversationId } = options
    const scoped = 'accountId' in options || 'conversationId' in options
    if (scoped && ![accountId, conversationId].every((id) => typeof id === 'string' && id.length > 0)) {
      return Promise.reject(new TypeError('scoped outbox retry requires both accountId and conversationId'))
    }
    const force = options.force === true
    const key = JSON.stringify([force, accountId, conversationId])
    if (passes.has(key)) return passes.get(key).promise
    const matches = (item) => !scoped || (item.accountId === accountId && item.conversationId === conversationId)
    let items
    try {
      items = readOutbox(stateRoot, { warn }).items.filter(matches)
    } catch (error) {
      return Promise.reject(error)
    }
    const slots = new Map()
    const rows = items.map(({ id, accountId, conversationId }) => {
      let slot
      for (const pass of passes.values()) {
        slot = pass.slots.get(id)
        if (slot) break
      }
      slot ??= {}
      slots.set(id, slot)
      return { id, chat: JSON.stringify([accountId, conversationId]), slot }
    })
    const promise = tail.then(() => runFlush({ rows, matches, force })).finally(() => passes.delete(key))
    passes.set(key, { slots, promise })
    tail = promise.catch(() => {})
    return promise
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
    stopped = false
    timer = setInterval(() => {
      void flush().catch((error) => warn(`outbox flush failed: ${String(error?.message ?? error)}`))
    }, FLUSH_INTERVAL_MS)
    timer.unref?.()
  }
  const stop = () => {
    stopped = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  return { enqueue, flush, pending, drop, start, stop }
}

