import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { backupsDir, createBackup, stampFor } from '../src/backup.js'
import { sealState } from '../src/backup-crypto.js'
import { lockFile } from '../src/instance-lock.js'
import { readReminders } from '../src/message/scheduler.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(REPO_ROOT, 'bin', 'backup.mjs')
const PASSPHRASE = 'instance-check-test-passphrase'

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-backup-cli-'))
  const root = path.join(base, 'state')
  const home = path.join(base, 'home')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return {
    base,
    root,
    env: {
      ...process.env,
      DSH_WEIXIN_STATE_DIR: root,
      DSH_WEIXIN_BACKUP_PASSPHRASE: PASSPHRASE,
      DSH_HOME: path.join(home, '.dsh'),
      HOME: home,
      USERPROFILE: home,
    },
  }
}

function writeState(root, marker) {
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(root, 'config.json'), '{"enabled":false}\n')
  fs.writeFileSync(path.join(root, 'memory', 'remember.txt'), `${marker}\n`)
}

function readMarker(root) {
  return fs.readFileSync(path.join(root, 'memory', 'remember.txt'), 'utf8').trim()
}

function writeLock(root, value) {
  fs.writeFileSync(lockFile(root), typeof value === 'string' ? value : JSON.stringify(value))
}

function runCli(f, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env: f.env,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function backup(f) {
  writeState(f.root, 'from-backup')
  const result = createBackup(f.root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  writeState(f.root, 'live-state')
  return result
}

function preRestoreDirs(root) {
  try {
    return fs.readdirSync(backupsDir(root)).filter((name) => name.startsWith('pre-restore-'))
  } catch {
    return []
  }
}

function assertExitHarnessThenYes(text) {
  assert.match(text, /Exit the DSH agent harness, then rerun with --yes to confirm\./)
  assert.doesNotMatch(text, /or pass --yes/)
}

test('restore refuses a live lock, preserves state, and permits an explicit --yes override', (t) => {
  const f = fixture(t)
  const saved = backup(f)
  writeLock(f.root, { pid: process.pid, startedAt: Date.now() })

  const blocked = runCli(f, ['restore', saved.id])

  assert.equal(blocked.status, 1, blocked.stderr)
  assert.match(blocked.stderr, new RegExp(`DSH instance pid ${process.pid} appears to be running`))
  assertExitHarnessThenYes(blocked.stderr)
  assert.equal(readMarker(f.root), 'live-state')
  assert.deepEqual(preRestoreDirs(f.root), [])

  const forced = runCli(f, ['restore', saved.id, '--yes'])

  assert.equal(forced.status, 0, forced.stderr)
  assert.match(forced.stderr, /continuing because --yes was passed/)
  assert.equal(readMarker(f.root), 'from-backup')
})

test('restore proceeds from an OS-confirmed stale lock and says why', (t) => {
  const f = fixture(t)
  const saved = backup(f)
  writeLock(f.root, { pid: 2_147_483_647, startedAt: 1 })

  const result = runCli(f, ['restore', saved.id])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /ignoring stale instance lock/)
  assert.equal(readMarker(f.root), 'from-backup')
})

test('restore CLI reports where it preserved a conflicting backup recovery copy', (t) => {
  const f = fixture(t)
  const original = '{"seq":1,"items":['
  fs.writeFileSync(path.join(f.root, 'reminders.json'), original)
  readReminders(f.root, () => {})
  const recoveryName = fs.readdirSync(f.root).find((name) => /^reminders\.recovery-[0-9a-f]+\.json$/.test(name))
  assert.ok(recoveryName)
  const saved = createBackup(f.root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  fs.writeFileSync(path.join(f.root, recoveryName), '{"user":"different recovery copy"}\n')

  const result = runCli(f, ['restore', saved.id, '--yes'])

  assert.equal(result.status, 0, result.stderr)
  const match = result.stdout.match(/backup copy saved to (.+)\r?\n/)
  assert.ok(match, result.stdout)
  assert.equal(fs.readFileSync(match[1].trim(), 'utf8'), original)
  assert.match(result.stdout, new RegExp(`kept live recovery ${recoveryName.replaceAll('.', '\\.')}`))
})

test('restore CLI exits nonzero when a conflict copy cannot leave backup rotation', (t) => {
  const f = fixture(t)
  const original = '{"seq":2,"items":['
  fs.writeFileSync(path.join(f.root, 'reminders.json'), original)
  readReminders(f.root, () => {})
  const recoveryName = fs.readdirSync(f.root).find((name) => /^reminders\.recovery-[0-9a-f]+\.json$/.test(name))
  assert.ok(recoveryName)
  const saved = createBackup(f.root, { now: Date.parse('2026-11-05T01:02:03Z'), warn() {} })
  fs.writeFileSync(path.join(f.root, recoveryName), '{"user":"different recovery copy"}\n')

  // The stamp has one-second precision. Pre-occupy the plausible restore
  // destinations so the no-overwrite safety copy deterministically fails.
  const now = Date.now()
  for (let offset = -1; offset <= 20; offset += 1) {
    const aside = path.join(backupsDir(f.root), `pre-restore-${stampFor(now + offset * 1_000)}`)
    fs.mkdirSync(aside, { recursive: true })
    fs.writeFileSync(path.join(aside, recoveryName), '{"occupied":true}\n')
  }

  const result = runCli(f, ['restore', saved.id, '--yes'])

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /but its backup copy was not preserved outside rotation/)
  assert.match(result.stderr, /preservation error: EEXIST|preservation error: .*exist/i)
})

test('restore does not treat a missing lock as proof that DSH is stopped', (t) => {
  const f = fixture(t)
  const saved = backup(f)

  const result = runCli(f, ['restore', saved.id])

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /no instance lock is present \(normal after a clean agent-harness exit\)/)
  assertExitHarnessThenYes(result.stderr)
  assert.equal(readMarker(f.root), 'live-state')
  assert.deepEqual(preRestoreDirs(f.root), [])
})

test('open rejects a malformed lock before writing and honors --yes explicitly', (t) => {
  const f = fixture(t)
  writeState(f.root, 'from-archive')
  const archive = path.join(f.base, 'state.enc')
  sealState(f.root, { passphrase: PASSPHRASE, outFile: archive, includeMedia: false })
  writeState(f.root, 'live-state')
  writeLock(f.root, '{broken')

  const blocked = runCli(f, ['open', archive])

  assert.equal(blocked.status, 1, blocked.stderr)
  assert.match(blocked.stderr, /instance lock is not valid JSON/)
  assertExitHarnessThenYes(blocked.stderr)
  assert.equal(readMarker(f.root), 'live-state')

  const forced = runCli(f, ['open', archive, '--yes'])

  assert.equal(forced.status, 0, forced.stderr)
  assert.match(forced.stderr, /continuing because --yes was passed/)
  assert.equal(readMarker(f.root), 'from-archive')
})

test('open --dry-run does not require instance evidence because it writes nothing', (t) => {
  const f = fixture(t)
  writeState(f.root, 'from-archive')
  const archive = path.join(f.base, 'state.enc')
  sealState(f.root, { passphrase: PASSPHRASE, outFile: archive, includeMedia: false })
  writeState(f.root, 'live-state')

  const result = runCli(f, ['open', archive, '--dry-run'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /would write 2 file\(s\)/)
  assert.equal(readMarker(f.root), 'live-state')
})

test('usage says to exit the agent harness before confirming restore with --yes', (t) => {
  const f = fixture(t)

  const result = runCli(f, ['help'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /restore <id> \[--yes\].*exit the agent harness, then pass --yes to confirm/)
  assert.match(result.stdout, /open <file\.enc>.*exit the harness, then pass --yes to write/)
})
