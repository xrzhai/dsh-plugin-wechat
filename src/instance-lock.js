/**
 * One writer per state directory.
 *
 * Two DSH windows with the same profile both load this plugin, both poll the
 * same Weixin account (whoever polls first steals the messages) and both write
 * the same JSON files. The writes are atomic now, so nothing is torn — but
 * last-writer-wins still means one window's reminders silently disappear when
 * the other saves its in-memory copy.
 *
 * This is a courtesy lock, not a mutex with guarantees: the holder refreshes the
 * file's mtime as a heartbeat, and a lock whose holder is gone (dead pid, or a
 * heartbeat older than the stale window) is taken over. The point is to make the
 * second instance SAY it is second, not to make it impossible to run two.
 *
 * @module dsh-weixin/instance-lock
 */

import { statePath } from './state-layout.js'
import fs from 'node:fs'

/** How often the holder refreshes the lock file. */
export const HEARTBEAT_MS = 30_000
/** A lock file untouched for this long belongs to a dead process. */
export const STALE_MS = 3 * HEARTBEAT_MS

/** @param {string} stateRoot */
export function lockFile(stateRoot) {
  return statePath(stateRoot, 'instanceLock')
}

/**
 * Ask the operating system whether a pid exists. Signal 0 performs the access
 * check without sending a signal on both POSIX systems and Windows.
 *
 * @param {number} pid
 * @param {(pid: number, signal: number) => void} kill
 * @returns {{ state: 'alive' | 'dead' | 'unknown', reason?: string }}
 */
function probeProcess(pid, kill = (target, signal) => process.kill(target, signal)) {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'dead', reason: 'invalid pid' }
  try {
    kill(pid, 0)
    return { state: 'alive' }
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    if (error?.code === 'EPERM') return { state: 'alive' }
    if (error?.code === 'ESRCH') return { state: 'dead' }
    return { state: 'unknown', reason: String(error?.message ?? error) }
  }
}

/** @param {number} pid */
function alive(pid) {
  return probeProcess(pid).state === 'alive'
}

/**
 * Read the lock without throwing away *why* it could not be read. The normal
 * runtime path deliberately treats every failure as "no holder" because the
 * lock is advisory; restore is different and must distinguish a confirmed
 * stale holder from a missing, corrupt or unreadable file.
 *
 * @param {string} stateRoot
 * @param {{
 *   statSync?: typeof fs.statSync,
 *   readFileSync?: typeof fs.readFileSync,
 * }} [options]
 */
function readLockRecord(stateRoot, options = {}) {
  const statSync = options.statSync ?? fs.statSync
  const readFileSync = options.readFileSync ?? fs.readFileSync
  const file = lockFile(stateRoot)
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', file }
    return {
      state: 'unreadable',
      file,
      code: error?.code,
      reason: `could not inspect the instance lock: ${String(error?.message ?? error)}`,
    }
  }

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', file }
    return {
      state: 'unreadable',
      file,
      code: error?.code,
      reason: `could not read the instance lock: ${String(error?.message ?? error)}`,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      state: 'malformed',
      file,
      reason: `the instance lock is not valid JSON: ${String(error?.message ?? error)}`,
    }
  }
  if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) {
    return { state: 'malformed', file, reason: 'the instance lock does not contain a positive integer pid' }
  }

  const holder = {
    pid: parsed.pid,
    startedAt: Number.isFinite(Number(parsed.startedAt)) ? Number(parsed.startedAt) : 0,
    at: stat.mtimeMs,
  }
  return { state: 'holder', file, holder }
}

/**
 * Read the current holder without touching the lock.
 *
 * @param {string} stateRoot
 * @returns {{ pid: number, startedAt: number, at: number } | undefined}
 */
export function readHolder(stateRoot) {
  const record = readLockRecord(stateRoot)
  return record.state === 'holder' ? record.holder : undefined
}

/**
 * Inspect the courtesy lock for a destructive restore.
 *
 * Heartbeat age is deliberately absent from the decision: a live pid means an
 * instance may still be running even if its event loop is blocked long enough
 * for the heartbeat to become stale. Only an OS-confirmed dead pid is stale.
 * A missing, malformed, unreadable or otherwise indeterminate lock is not
 * evidence that no instance is running.
 *
 * @param {string} stateRoot
 * @param {{
 *   statSync?: typeof fs.statSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   kill?: (pid: number, signal: number) => void,
 * }} [options]
 * @returns {
 *   { state: 'running' | 'stale', file: string, holder: { pid: number, startedAt: number, at: number } } |
 *   { state: 'missing', file: string } |
 *   { state: 'malformed' | 'unreadable' | 'unknown', file: string, reason: string, code?: string, holder?: { pid: number, startedAt: number, at: number } }
 * }
 */
export function inspectInstanceLock(stateRoot, options = {}) {
  const record = readLockRecord(stateRoot, options)
  if (record.state !== 'holder') return record

  const processState = probeProcess(record.holder.pid, options.kill)
  if (processState.state === 'alive') return { state: 'running', file: record.file, holder: record.holder }
  if (processState.state === 'dead') return { state: 'stale', file: record.file, holder: record.holder }
  return {
    state: 'unknown',
    file: record.file,
    holder: record.holder,
    reason: `could not determine whether pid ${record.holder.pid} is running: ${processState.reason}`,
  }
}

/**
 * Take the lock, or report the live holder that has it.
 *
 * @param {string} stateRoot
 * @param {{ now?: number, warn?: (message: string) => void }} [options]
 * @returns {{ acquired: true } | { acquired: false, holder: { pid: number, startedAt: number } }}
 */
export function acquireInstanceLock(stateRoot, options = {}) {
  const now = options.now ?? Date.now()
  const warn = options.warn ?? (() => {})
  const file = lockFile(stateRoot)
  const holder = readHolder(stateRoot)
  if (holder !== undefined) {
    const live = alive(holder.pid) && now - holder.at < STALE_MS
    if (live && holder.pid !== process.pid) {
      return { acquired: false, holder: { pid: holder.pid, startedAt: holder.startedAt } }
    }
    // A dead pid or a stale heartbeat: the previous instance is gone.
  }
  try {
    fs.mkdirSync(stateRoot, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify({ pid: process.pid, startedAt: now })}\n`, { mode: 0o600 })
    fs.renameSync(temp, file)
    return { acquired: true }
  } catch (error) {
    warn(`could not take the instance lock: ${String(error?.message ?? error)}`)
    // Failing to write a courtesy lock is not a reason to refuse to run.
    return { acquired: true }
  }
}

/**
 * Refresh the heartbeat. Called on a timer by the plugin; a no-op when the lock
 * is gone (another instance took over after ours went stale).
 *
 * @param {string} stateRoot
 */
export function heartbeatInstanceLock(stateRoot) {
  const file = lockFile(stateRoot)
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (holder?.pid !== process.pid) return false
    const now = new Date()
    fs.utimesSync(file, now, now)
    return true
  } catch {
    return false
  }
}

/** Remove the lock, but only if this process holds it. */
export function releaseInstanceLock(stateRoot) {
  const file = lockFile(stateRoot)
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (holder?.pid !== process.pid) return false
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}
