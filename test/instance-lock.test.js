import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { inspectInstanceLock, lockFile } from '../src/instance-lock.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-instance-lock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function writeLock(root, value) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(lockFile(root), typeof value === 'string' ? value : JSON.stringify(value))
}

function killError(code) {
  const error = new Error(`kill failed: ${code}`)
  error.code = code
  return error
}

test('a live pid is running even when the heartbeat is older than the takeover window', (t) => {
  const root = fixture(t)
  writeLock(root, { pid: 4242, startedAt: 1 })
  fs.utimesSync(lockFile(root), new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'))

  const result = inspectInstanceLock(root, {
    kill(pid, signal) {
      assert.equal(pid, 4242)
      assert.equal(signal, 0)
    },
  })

  assert.equal(result.state, 'running')
  assert.equal(result.holder.pid, 4242)
})

test('EPERM means the holder exists and is still treated as running', (t) => {
  const root = fixture(t)
  writeLock(root, { pid: 4242, startedAt: 1 })

  const result = inspectInstanceLock(root, {
    kill() {
      throw killError('EPERM')
    },
  })

  assert.equal(result.state, 'running')
})

test('only an OS-confirmed missing process makes a lock stale', (t) => {
  const root = fixture(t)
  writeLock(root, { pid: 4242, startedAt: 1 })

  const result = inspectInstanceLock(root, {
    kill() {
      throw killError('ESRCH')
    },
  })

  assert.equal(result.state, 'stale')
  assert.equal(result.holder.pid, 4242)
})

test('a missing lock is reported as unknown evidence instead of a clean stop', (t) => {
  const root = fixture(t)

  const result = inspectInstanceLock(root)

  assert.equal(result.state, 'missing')
  assert.equal(result.file, lockFile(root))
})

test('malformed JSON and invalid pids are distinct from a missing lock', (t) => {
  const root = fixture(t)
  writeLock(root, '{not json')
  assert.equal(inspectInstanceLock(root).state, 'malformed')

  writeLock(root, { pid: '4242', startedAt: 1 })
  const invalidPid = inspectInstanceLock(root)
  assert.equal(invalidPid.state, 'malformed')
  assert.match(invalidPid.reason, /positive integer pid/)
})

test('a permission failure while inspecting the lock is reported, not hidden', (t) => {
  const root = fixture(t)

  const result = inspectInstanceLock(root, {
    statSync() {
      throw killError('EACCES')
    },
  })

  assert.equal(result.state, 'unreadable')
  assert.equal(result.code, 'EACCES')
  assert.match(result.reason, /could not inspect the instance lock/)
})

test('an indeterminate process probe is unknown', (t) => {
  const root = fixture(t)
  writeLock(root, { pid: 4242, startedAt: 1 })

  const result = inspectInstanceLock(root, {
    kill() {
      throw killError('EIO')
    },
  })

  assert.equal(result.state, 'unknown')
  assert.match(result.reason, /could not determine whether pid 4242 is running/)
})
