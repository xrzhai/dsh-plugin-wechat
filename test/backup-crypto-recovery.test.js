import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { backupsDir, stampFor } from '../src/backup.js'
import { openState, restoreSealed, sealState } from '../src/backup-crypto.js'

const PASSPHRASE = 'sealed-recovery-regression-passphrase'
const RECOVERY_NAME = 'reminders.recovery-0123456789abcdef.json'

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-sealed-recovery-'))
  const root = path.join(base, 'state')
  const archive = path.join(base, 'state.enc')
  fs.mkdirSync(root, { recursive: true })
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return { base, root, archive }
}

function writeArchiveState(root) {
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(root, 'config.json'), '{"source":"archive"}\n')
  fs.writeFileSync(path.join(root, 'memory', 'remember.txt'), 'archive memory\n')
  fs.writeFileSync(path.join(root, RECOVERY_NAME), '{"source":"archive","items":[null')
}

function sealFixture(f) {
  writeArchiveState(f.root)
  sealState(f.root, { passphrase: PASSPHRASE, outFile: f.archive, includeMedia: false })
  return openState(f.archive, { passphrase: PASSPHRASE }).files
}

test('sealed restore protects a different recovery while ordinary files keep overwrite semantics', (t) => {
  const f = fixture(t)
  const files = sealFixture(f)
  const liveRecovery = '{"source":"live","items":[{"id":"r1"}]}\n'
  fs.writeFileSync(path.join(f.root, 'config.json'), '{"source":"live"}\n')
  fs.writeFileSync(path.join(f.root, 'memory', 'remember.txt'), 'live memory\n')
  fs.writeFileSync(path.join(f.root, RECOVERY_NAME), liveRecovery)

  const now = Date.parse('2026-11-05T04:05:06Z')
  const warnings = []
  const result = restoreSealed(f.root, files, {
    now,
    warn: (message) => warnings.push(message),
  })

  assert.equal(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'), '{"source":"archive"}\n')
  assert.equal(fs.readFileSync(path.join(f.root, 'memory', 'remember.txt'), 'utf8'), 'archive memory\n')
  assert.equal(fs.readFileSync(path.join(f.root, RECOVERY_NAME), 'utf8'), liveRecovery)
  assert.equal(result.restored, 2)
  assert.equal(result.recoveryConflicts.length, 1)
  assert.equal(result.recoveryConflicts[0].name, RECOVERY_NAME)
  assert.equal(result.recoveryConflicts[0].livePath, path.join(f.root, RECOVERY_NAME))
  assert.equal(
    fs.readFileSync(result.recoveryConflicts[0].preservedPath, 'utf8'),
    '{"source":"archive","items":[null',
  )
  assert.match(warnings.join('\n'), /saved the archive copy to .*reminders\.recovery-/)
})

test('sealed restore aborts before ordinary writes when an archive recovery cannot be preserved', (t) => {
  const f = fixture(t)
  const files = sealFixture(f)
  const liveConfig = '{"source":"live"}\n'
  const liveRecovery = '{"source":"live recovery"}\n'
  fs.writeFileSync(path.join(f.root, 'config.json'), liveConfig)
  fs.writeFileSync(path.join(f.root, RECOVERY_NAME), liveRecovery)

  const now = Date.parse('2026-11-05T04:05:06Z')
  const aside = path.join(backupsDir(f.root), `pre-restore-${stampFor(now)}`)
  fs.mkdirSync(aside, { recursive: true })
  fs.writeFileSync(path.join(aside, RECOVERY_NAME), '{"occupied":true}\n')

  assert.throws(
    () => restoreSealed(f.root, files, { now, warn() {} }),
    (error) => {
      assert.equal(error.partial, true)
      assert.match(error.message, /sealed restore may be partial/)
      assert.match(error.message, /source archive was not changed/)
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'), liveConfig)
  assert.equal(fs.readFileSync(path.join(f.root, RECOVERY_NAME), 'utf8'), liveRecovery)
  assert.equal(fs.readFileSync(path.join(aside, RECOVERY_NAME), 'utf8'), '{"occupied":true}\n')
})

test('a temp payload collision never deletes a file the exclusive writer did not create', (t) => {
  const f = fixture(t)
  const files = sealFixture(f)
  fs.writeFileSync(path.join(f.root, RECOVERY_NAME), '{"source":"live"}\n')

  const now = Date.parse('2026-11-05T04:05:06Z')
  const originalOpen = fs.openSync.bind(fs)
  const originalWrite = fs.writeFileSync.bind(fs)
  let collidedPayload

  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    if (
      flags === 'wx' &&
      path.basename(String(file)) === 'payload' &&
      path.basename(path.dirname(String(file))).startsWith('.backup-exclusive-')
    ) {
      collidedPayload = String(file)
      originalWrite(collidedPayload, 'pre-existing unowned file\n')
      const error = new Error('temp file already exists')
      error.code = 'EEXIST'
      throw error
    }
    return originalOpen(file, flags, mode)
  })

  assert.throws(
    () => restoreSealed(f.root, files, { now, warn() {} }),
    /sealed restore may be partial/,
  )
  assert.ok(collidedPayload)
  assert.equal(fs.readFileSync(collidedPayload, 'utf8'), 'pre-existing unowned file\n')
})

test('a write failure removes only the temp file created by this attempt', (t) => {
  const f = fixture(t)
  const files = sealFixture(f)
  fs.writeFileSync(path.join(f.root, RECOVERY_NAME), '{"source":"live"}\n')

  const now = Date.parse('2026-11-05T04:05:06Z')
  const originalOpen = fs.openSync.bind(fs)
  const originalWrite = fs.writeFileSync.bind(fs)
  let ownedPayload
  let ownedFd

  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    const fd = originalOpen(file, flags, mode)
    if (
      flags === 'wx' &&
      path.basename(String(file)) === 'payload' &&
      path.basename(path.dirname(String(file))).startsWith('.backup-exclusive-')
    ) {
      ownedPayload = String(file)
      ownedFd = fd
    }
    return fd
  })
  t.mock.method(fs, 'writeFileSync', (target, buffer, options) => {
    if (target === ownedFd) {
      const error = new Error('simulated write failure')
      error.code = 'ENOSPC'
      throw error
    }
    return originalWrite(target, buffer, options)
  })

  assert.throws(
    () => restoreSealed(f.root, files, { now, warn() {} }),
    /sealed restore may be partial.*simulated write failure/,
  )
  assert.ok(ownedPayload)
  assert.equal(fs.existsSync(ownedPayload), false)
  assert.equal(fs.existsSync(path.dirname(ownedPayload)), false)
})

test('a hard-link failure fails closed and preserves the source archive', (t) => {
  const f = fixture(t)
  const files = sealFixture(f)
  const liveRecovery = '{"source":"live"}\n'
  fs.writeFileSync(path.join(f.root, RECOVERY_NAME), liveRecovery)
  t.mock.method(fs, 'linkSync', () => {
    const error = new Error('hard links are not supported on this filesystem')
    error.code = 'ENOTSUP'
    throw error
  })

  assert.throws(
    () => restoreSealed(f.root, files, { now: Date.parse('2026-11-05T04:05:06Z'), warn() {} }),
    (error) => {
      assert.equal(error.partial, true)
      assert.match(error.message, /hard links are not supported/)
      assert.match(error.message, /source archive was not changed/)
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(f.root, RECOVERY_NAME), 'utf8'), liveRecovery)
  assert.equal(fs.existsSync(f.archive), true)
})

test('a later recovery failure reports partial writes while keeping completed earlier files', (t) => {
  const f = fixture(t)
  const secondRecovery = 'reminders.recovery-fedcba9876543210.json'
  writeArchiveState(f.root)
  fs.writeFileSync(path.join(f.root, secondRecovery), '{"source":"archive second"}\n')
  sealState(f.root, { passphrase: PASSPHRASE, outFile: f.archive, includeMedia: false })
  const opened = openState(f.archive, { passphrase: PASSPHRASE }).files
  fs.rmSync(path.join(f.root, RECOVERY_NAME))
  fs.rmSync(path.join(f.root, secondRecovery))
  const ordered = new Map([...opened.entries()].sort(([left], [right]) => (
    left === RECOVERY_NAME ? -1 : right === RECOVERY_NAME ? 1 : left.localeCompare(right)
  )))
  const originalLink = fs.linkSync.bind(fs)
  let links = 0

  t.mock.method(fs, 'linkSync', (source, target) => {
    links += 1
    if (links === 2) {
      const error = new Error('simulated hard-link failure')
      error.code = 'ENOTSUP'
      throw error
    }
    return originalLink(source, target)
  })

  assert.throws(
    () => restoreSealed(f.root, ordered, { now: Date.parse('2026-11-05T04:05:06Z'), warn() {} }),
    (error) => {
      assert.equal(error.partial, true)
      assert.equal(error.restored, 1)
      assert.match(error.message, /1 live file\(s\) restored/)
      assert.match(error.message, /source archive was not changed/)
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(f.root, RECOVERY_NAME), 'utf8'), '{"source":"archive","items":[null')
  assert.equal(fs.existsSync(path.join(f.root, secondRecovery)), false)
  assert.equal(fs.existsSync(f.archive), true)
})
