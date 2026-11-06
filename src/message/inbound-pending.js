/**
 * Crash-safe boundary between an iLink poll response and its asynchronous
 * inbound handler.
 *
 * The poll cursor may only move after every accepted message has a durable
 * record. A handler may have side effects (commands, agent turns, tool calls),
 * so recovery distinguishes two states:
 *
 * - `queued`: the handler never started. It is safe to schedule after restart.
 * - `started` / `uncertain`: the old process may already have acted. It is
 *   deliberately not replayed; the record stays on disk for operator review.
 *
 * Completed message ids are kept in a small bounded ledger so an iLink
 * redelivery just after a restart is not executed twice. Records contain the
 * normalized inbound message, including its context token and media keys, so
 * both files and directories are created with owner-only permissions.
 * @module dsh-weixin/message/inbound-pending
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../atomic.js'

const SCHEMA_VERSION = 1
const COMPLETED_LIMIT = 4096

// The gateway refused a queued message before the user handler ran.
export const INBOUND_NOT_ACCEPTED = Symbol('inbound-not-accepted')

export class InboundPendingError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'InboundPendingError'
  }
}

const privateDirectory = (dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch (error) {
    // Windows may not expose POSIX modes even though open(..., 0600) still
    // asks for owner-only creation. A permissions error must not turn into a
    // message-content log line.
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'ENOSYS') throw error
  }
}

const safeAccountKey = (accountId) => crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 32)
const messageKey = (id) => crypto.createHash('sha256').update(`id\0${id}`).digest('hex')

/**
 * Directory owned by the inbound recovery ledger for one account. It sits
 * beside, rather than inside, the vendor's accounts directory so account
 * enumeration never mistakes it for a credential file.
 *
 * @param {string} syncBufPath
 * @param {string} accountId
 */
export function inboundPendingDir(syncBufPath, accountId) {
  return path.join(path.dirname(path.dirname(syncBufPath)), 'inbound-pending', safeAccountKey(accountId))
}

/**
 * @param {object} options
 * @param {string} options.accountId
 * @param {string} options.syncBufPath
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.warn]
 */
export function createInboundPendingStore({ accountId, syncBufPath, now = Date.now, warn = () => {} }) {
  return new InboundPendingStore({ accountId, syncBufPath, now, warn })
}

export class InboundPendingStore {
  constructor({ accountId, syncBufPath, now = Date.now, warn = () => {} }) {
    this.accountId = accountId
    this.dir = inboundPendingDir(syncBufPath, accountId)
    this.ledgerPath = path.join(this.dir, 'completed.json')
    this.now = now
    this.warn = warn
    this.initialized = false
    /** @type {string[]} */
    this.completed = []
    this.completedSet = new Set()
    this.nextSequence = Math.max(1, Math.floor(now()) * 1000)
  }

  #initialize() {
    if (this.initialized) return
    try {
      privateDirectory(this.dir)
      this.#loadCompleted()
      this.initialized = true
    } catch (error) {
      throw new InboundPendingError('inbound pending storage is unavailable or its dedupe ledger is unreadable')
    }
  }

  #loadCompleted() {
    let text
    try {
      text = fs.readFileSync(this.ledgerPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new InboundPendingError('inbound completed-message ledger is not valid JSON')
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(parsed.ids) ||
      parsed.ids.some((id) => typeof id !== 'string')
    ) {
      throw new InboundPendingError('inbound completed-message ledger has an invalid shape')
    }
    this.completed = parsed.ids.slice(-COMPLETED_LIMIT)
    this.completedSet = new Set(this.completed)
  }

  #recordPath(key) {
    return path.join(this.dir, `${key}.json`)
  }

  #readRecord(key) {
    let text
    try {
      text = fs.readFileSync(this.#recordPath(key), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing' }
      throw new InboundPendingError('an inbound pending record could not be read')
    }
    try {
      const parsed = JSON.parse(text)
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        parsed.schemaVersion !== SCHEMA_VERSION ||
        parsed.key !== key ||
        typeof parsed.id !== 'string' ||
        !['queued', 'started', 'uncertain'].includes(parsed.state) ||
        parsed.message === null ||
        typeof parsed.message !== 'object' ||
        !Number.isFinite(parsed.sequence)
      ) {
        return { status: 'corrupt' }
      }
      return { status: 'ok', record: parsed }
    } catch {
      return { status: 'corrupt' }
    }
  }

  #writeRecord(record) {
    const written = atomicWriteJson(this.#recordPath(record.key), record, {
      mode: 0o600,
      durable: true,
      warn: this.warn,
    })
    if (!written) throw new InboundPendingError('inbound pending record could not be written durably')
    try {
      fs.chmodSync(this.#recordPath(record.key), 0o600)
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'ENOSYS') throw error
    }
    return written
  }

  #writeCompleted(ids) {
    const written = atomicWriteJson(this.ledgerPath, { schemaVersion: SCHEMA_VERSION, ids }, {
      mode: 0o600,
      durable: true,
      warn: this.warn,
    })
    if (!written) throw new InboundPendingError('inbound completed-message ledger could not be written durably')
    try {
      fs.chmodSync(this.ledgerPath, 0o600)
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'ENOSYS') throw error
    }
  }

  /**
   * Persist one normalized inbound message, reusing an existing record for the
   * same stable iLink id. No cursor may move until this returns.
   *
   * @param {any} message
   * @returns {{ status: 'queued'|'started'|'uncertain'|'completed'|'corrupt', key?: string, message?: any }}
   */
  stage(message) {
    this.#initialize()
    const id = typeof message?.id === 'string' ? message.id.trim() : ''
    if (id !== '' && this.completedSet.has(id)) return { status: 'completed' }

    const key = id === '' ? crypto.randomUUID().replaceAll('-', '') : messageKey(id)
    const existing = this.#readRecord(key)
    if (existing.status === 'ok') return { status: existing.record.state, key, message: existing.record.message }
    if (existing.status === 'corrupt') return { status: 'corrupt', key }

    const record = {
      schemaVersion: SCHEMA_VERSION,
      key,
      id,
      state: 'queued',
      sequence: this.nextSequence++,
      stagedAt: this.now(),
      message,
    }
    this.#writeRecord(record)
    return { status: 'queued', key, message }
  }

  /**
   * Mark the irreversible boundary immediately before invoking user code.
   */
  claim(key) {
    this.#initialize()
    const current = this.#readRecord(key)
    if (current.status !== 'ok') return { ok: false, state: current.status }
    if (current.record.state !== 'queued') return { ok: false, state: current.record.state }
    this.#writeRecord({ ...current.record, state: 'started', startedAt: this.now() })
    return { ok: true }
  }

  /** Undo a claim only when the gateway confirms the handler never ran. */
  release(key) {
    this.#initialize()
    const current = this.#readRecord(key)
    if (current.status !== 'ok' || current.record.state !== 'started') return false
    const { startedAt, ...record } = current.record
    this.#writeRecord({ ...record, state: 'queued' })
    return true
  }

  /** Preserve a failed/ambiguous handler run without making it replayable. */
  markUncertain(key) {
    this.#initialize()
    const current = this.#readRecord(key)
    if (current.status !== 'ok') return false
    if (current.record.state === 'uncertain') return true
    this.#writeRecord({ ...current.record, state: 'uncertain', uncertainAt: this.now() })
    return true
  }

  /** Persist completion before removing the pending record. */
  complete(key) {
    this.#initialize()
    const current = this.#readRecord(key)
    if (current.status !== 'ok') return false
    const id = current.record.id
    if (id !== '') {
      const ids = [...this.completed.filter((value) => value !== id), id].slice(-COMPLETED_LIMIT)
      this.#writeCompleted(ids)
      this.completed = ids
      this.completedSet = new Set(ids)
    }
    try {
      fs.unlinkSync(this.#recordPath(key))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warn('an inbound completion marker was saved but its pending record could not be cleaned up')
      }
    }
    return true
  }

  /**
   * Return only messages that never entered the handler. Every other durable
   * record is reported as unresolved and left untouched for operator review.
   */
  recover() {
    this.#initialize()
    const queued = []
    let unresolved = 0
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json') || name === 'completed.json') continue
      const key = name.slice(0, -5)
      const current = this.#readRecord(key)
      if (current.status !== 'ok') {
        unresolved += 1
        continue
      }
      if (current.record.id !== '' && this.completedSet.has(current.record.id)) {
        try {
          fs.unlinkSync(this.#recordPath(key))
        } catch {
          unresolved += 1
        }
        continue
      }
      if (current.record.state === 'queued') {
        queued.push({ key, message: current.record.message, sequence: current.record.sequence })
      } else {
        unresolved += 1
      }
    }
    queued.sort((left, right) => left.sequence - right.sequence)
    return { queued, unresolved }
  }
}
