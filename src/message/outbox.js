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
 * so a send that succeeded but whose response was lost can be delivered twice;
 * the alternative is dropping the response.
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
   * @param {{ accountId: string, conversationId: string, text?: string, segments?: string[], contextToken?: string, maxMessageLength?: number }} entry
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
   * a parked one has nothing left to try until it ages out. This cleanup keeps the durable
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
      current.lastError = 'context token expired; retrying without it'
    })
    return freshItem(id)
  }

  /**
   * Try to deliver everything that is due. Items stay in order per conversation.
   *
   * @param {{ force?: boolean }} [options] force ignores notBefore (manual retry)
   * @returns {Promise<{ sent: number, failed: number, remaining: number }>}
   */
  let stopped = false
  const runFlush = async (options = {}) => {
    // Clear the parked dead letters first: they are the residue of the old
    // "retry an expired token until it parks" behaviour, and nothing below can
    // ever send them.
    prune()
    const store = readOutbox(stateRoot, { warn })
    if (store.items.length === 0) return { sent: 0, failed: 0, remaining: 0 }
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
        let item = freshItem(candidate.id)
        if (item === undefined) continue
        // A reply riding an expired context token can no longer be routed by it
        // — iLink answers `prepare failed` (issue #9/#21). The text is still
        // worth delivering, so drop the token and fall through to the tokenless
        // path (the account's typing ticket, or the bare conversation route).
        // Only an item that is ALSO out of retries is a genuine dead letter, and
        // `prune()` has already removed those above.
        item = withoutExpiredToken(candidate.id)
        if (item === undefined) continue
        if (item.attempts >= MAX_ATTEMPTS) {
          blocked = false
          continue
        }
        if (options.force !== true && Number(item.notBefore ?? 0) > now()) {
          blocked = true
          continue
        }
        const transport = transportFor(item.accountId)
        if (transport === undefined) {
          updateItem(item.id, (current) => {
            current.lastError = 'no live transport'
          })
          blocked = true
          continue
        }
        let completed = false
        for (let segmentIndex = item.nextSegment; segmentIndex < item.segments.length; segmentIndex += 1) {
          // Re-read before each segment. A concurrent drop must stop delivery;
          // a concurrent enqueue can update the file without being overwritten
          // by this older snapshot.
          item = withoutExpiredToken(candidate.id)
          if (item === undefined) break
          if (item.nextSegment !== segmentIndex) {
            segmentIndex = item.nextSegment - 1
            continue
          }
          // Authorization or transport availability may change while a prior
          // segment is in flight. Leave the remaining segments queued.
          if (stopped || transportFor(item.accountId) !== transport) {
            blocked = true
            break
          }
          try {
            await transport.send({
              conversationId: item.conversationId,
              type: 'text',
              text: item.segments[segmentIndex],
              contextToken: item.contextToken,
            })
          } catch (error) {
            const failedAt = now()
            updateItem(item.id, (current) => {
              current.attempts = Number(current.attempts ?? 0) + 1
              current.lastError = String(error?.message ?? error)
              current.notBefore = failedAt + retryDelayMs(current.attempts)
            })
            failed += 1
            blocked = true
            break
          }

          const finalSegment = segmentIndex === item.segments.length - 1
          const saved = updateItem(item.id, (current) => {
            if (current.nextSegment === segmentIndex) current.nextSegment = segmentIndex + 1
            current.lastError = ''
          })
          if (!saved) {
            // The item was dropped while this segment was in flight. The
            // current bubble did go out, but there is no durable row to revive;
            // never continue with the following segments.
            if (finalSegment) completed = true
            break
          }
          if (finalSegment) completed = true
        }
        if (completed) {
          drop(item.id)
          sent += 1
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

  return { enqueue, flush, pending, drop, prune, start, stop }
}

