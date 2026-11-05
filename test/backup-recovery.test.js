import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { backupsDir, createBackup, restoreBackup, stampFor } from '../src/backup.js'
import { readReminders } from '../src/message/scheduler.js'

const RECOVERY_FILE = /^reminders\.recovery-[0-9a-f]+\.json$/

function stateRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function preserveCorruptStore(root, contents) {
  fs.writeFileSync(path.join(root, 'reminders.json'), contents)
  readReminders(root, () => {})
  return recoveryFiles(root).find((name) => fs.readFileSync(path.join(root, name), 'utf8') === contents)
}

function recoveryFiles(root) {
  return fs.readdirSync(root).filter((name) => RECOVERY_FILE.test(name)).sort()
}

test('directory backups include existing reminder recovery files', (t) => {
  const root = stateRoot(t, 'weixin-backup-reminders-')
  const first = '{"seq":1,"items":['
  const second = '{"seq":2,"items":[null,'
  const firstName = preserveCorruptStore(root, first)
  const secondName = preserveCorruptStore(root, second)

  assert.ok(firstName)
  assert.ok(secondName)
  assert.notEqual(firstName, secondName)

  const saved = createBackup(root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  const backupRoot = path.join(backupsDir(root), saved.id)
  assert.equal(fs.readFileSync(path.join(backupRoot, firstName), 'utf8'), first)
  assert.equal(fs.readFileSync(path.join(backupRoot, secondName), 'utf8'), second)

  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'MANIFEST.json'), 'utf8'))
  assert.ok(manifest.roots.includes(firstName))
  assert.ok(manifest.roots.includes(secondName))
})

test('restore adds missing recovery files and keeps every different live copy', (t) => {
  const root = stateRoot(t, 'weixin-restore-reminders-')
  const first = '{"seq":1,"items":['
  const second = '{"seq":2,"items":[null,'
  const firstName = preserveCorruptStore(root, first)
  const secondName = preserveCorruptStore(root, second)
  const saved = createBackup(root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })

  const liveConflict = '{"user":"different recovery copy"}\n'
  const liveOnlyName = 'reminders.recovery-ffffffffffffffff.json'
  const liveOnly = '{"user":"only on this machine"}\n'
  fs.writeFileSync(path.join(root, firstName), liveConflict)
  fs.rmSync(path.join(root, secondName))
  fs.writeFileSync(path.join(root, liveOnlyName), liveOnly)
  fs.writeFileSync(path.join(root, 'reminders.json'), '{"seq":9,"items":[]}\n')

  const warnings = []
  const restored = restoreBackup(root, saved.id, {
    now: Date.parse('2026-11-05T02:03:04Z'),
    warn: (message) => warnings.push(message),
  })

  assert.equal(fs.readFileSync(path.join(root, firstName), 'utf8'), liveConflict)
  assert.equal(fs.readFileSync(path.join(root, secondName), 'utf8'), second)
  assert.equal(fs.readFileSync(path.join(root, liveOnlyName), 'utf8'), liveOnly)
  assert.deepEqual(restored.recoveryConflicts, [{
    name: firstName,
    livePath: path.join(root, firstName),
    backupPath: path.join(backupsDir(root), saved.id, firstName),
    preservedPath: path.join(restored.aside, firstName),
    preserved: true,
  }])
  assert.match(warnings.join('\n'), new RegExp(`kept existing reminder recovery ${firstName.replaceAll('.', '\\.')}`))
  assert.equal(
    fs.readFileSync(path.join(restored.aside, firstName), 'utf8'),
    first,
  )
  assert.equal(fs.existsSync(path.join(restored.aside, secondName)), false)
})

test('restoring a legacy-compatible backup preserves live recovery files it does not contain', (t) => {
  const root = stateRoot(t, 'weixin-restore-legacy-backup-')
  const original = '{"seq":0,"items":[]}\n'
  fs.writeFileSync(path.join(root, 'reminders.json'), original)
  const saved = createBackup(root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  assert.deepEqual(recoveryFiles(path.join(backupsDir(root), saved.id)), [])

  const liveRecovery = preserveCorruptStore(root, '{"seq":4,"items":[')
  assert.ok(liveRecovery)
  const restored = restoreBackup(root, saved.id, {
    now: Date.parse('2026-11-05T02:03:04Z'),
    warn() {},
  })

  assert.equal(fs.readFileSync(path.join(root, 'reminders.json'), 'utf8'), original)
  assert.equal(fs.readFileSync(path.join(root, liveRecovery), 'utf8'), '{"seq":4,"items":[')
  assert.equal(fs.existsSync(path.join(restored.aside, liveRecovery)), false)
})

test('conflicting backup recovery survives later backup pruning in pre-restore', (t) => {
  const root = stateRoot(t, 'weixin-restore-conflict-retention-')
  const original = '{"seq":7,"items":['
  const recoveryName = preserveCorruptStore(root, original)
  const saved = createBackup(root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  const savedPath = path.join(backupsDir(root), saved.id)

  fs.writeFileSync(path.join(root, recoveryName), '{"user":"different recovery copy"}\n')
  const restored = restoreBackup(root, saved.id, {
    now: Date.parse('2026-11-05T02:03:04Z'),
    warn() {},
  })
  const conflict = restored.recoveryConflicts[0]
  assert.equal(conflict.preserved, true)
  assert.equal(fs.readFileSync(conflict.preservedPath, 'utf8'), original)

  // Later state changes no longer contain this recovery. A one-backup rotation
  // removes the source backup, but the pre-restore safety copy must remain.
  fs.rmSync(path.join(root, recoveryName))
  createBackup(root, { now: Date.parse('2026-11-05T03:04:05Z'), warn() {}, keep: 1 })

  assert.equal(fs.existsSync(savedPath), false)
  assert.equal(fs.readFileSync(conflict.preservedPath, 'utf8'), original)
})

test('a failed conflict preservation is reported without claiming both copies survived', (t) => {
  const root = stateRoot(t, 'weixin-restore-conflict-failure-')
  const original = '{"seq":8,"items":['
  const recoveryName = preserveCorruptStore(root, original)
  const saved = createBackup(root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  fs.writeFileSync(path.join(root, recoveryName), '{"user":"different recovery copy"}\n')

  const now = Date.parse('2026-11-05T02:03:04Z')
  const aside = path.join(backupsDir(root), `pre-restore-${stampFor(now)}`)
  fs.mkdirSync(aside, { recursive: true })
  fs.writeFileSync(path.join(aside, recoveryName), '{"occupied":true}\n')

  const warnings = []
  const restored = restoreBackup(root, saved.id, {
    now,
    warn: (message) => warnings.push(message),
  })
  const conflict = restored.recoveryConflicts[0]

  assert.equal(conflict.preserved, false)
  assert.equal(conflict.preservedPath, null)
  assert.match(conflict.error, /EEXIST|exist/i)
  assert.equal(fs.readFileSync(path.join(aside, recoveryName), 'utf8'), '{"occupied":true}\n')
  assert.match(warnings.join('\n'), /could not preserve the backup copy .*restore may be partial.*until rotation/)
})

test('directory restore reports a missing recovery when atomic hard-link publication is unavailable', (t) => {
  const root = stateRoot(t, 'weixin-restore-hard-link-failure-')
  const original = '{"seq":9,"items":['
  const recoveryName = preserveCorruptStore(root, original)
  const saved = createBackup(root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  const backupRecovery = path.join(backupsDir(root), saved.id, recoveryName)
  fs.rmSync(path.join(root, recoveryName))
  t.mock.method(fs, 'linkSync', () => {
    const error = new Error('hard links are not supported on this filesystem')
    error.code = 'ENOTSUP'
    throw error
  })

  const warnings = []
  const restored = restoreBackup(root, saved.id, {
    now: Date.parse('2026-11-05T02:03:04Z'),
    warn: (message) => warnings.push(message),
  })

  assert.deepEqual(restored.recoveryFailures, [{
    name: recoveryName,
    livePath: path.join(root, recoveryName),
    backupPath: backupRecovery,
    error: 'hard links are not supported on this filesystem',
    code: 'ENOTSUP',
  }])
  assert.equal(fs.existsSync(path.join(root, recoveryName)), false)
  assert.equal(fs.readFileSync(backupRecovery, 'utf8'), original)
  assert.match(warnings.join('\n'), /restore may be partial.*backup copy remains/)
})
