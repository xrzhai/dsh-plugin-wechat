/**
 * Backups of the state directory.
 *
 * Everything this plugin knows — which accounts are bound, what it remembers
 * about you, your personas, the journal, the subscriptions — lives as plain
 * files under the state root. Retention (see `src/message/retention.js`) deletes
 * the old ones on purpose; nothing anywhere takes a copy. So one bad `rm`, one
 * restore-from-a-stale-snapshot, or one machine replacement and all of it is
 * gone.
 *
 * A backup is a directory copy rather than an archive: node has no `tar`, and
 * an extra dependency for this is not worth it. Two consequences are worth
 * stating plainly in the code:
 *
 *   1. The copy includes `config.json` and `accounts/*.json`, because a backup
 *      that cannot restore the login is not a backup. Those files carry live
 *      tokens, so the backup directory is created 0700 and never leaves the
 *      machine without the operator deciding to move it.
 *   2. A restore never deletes the current state in place: whatever is there
 *      now is moved into `backups/pre-restore-<stamp>/` first, so "restore" is
 *      itself revertible.
 */
import fs from 'node:fs'
import path from 'node:path'

/** How many completed backups to keep. Old ones are removed, newest kept. */
export const DEFAULT_KEEP = 3

/**
 * Fixed roots every backup copies, in the order it is reported. Reminder
 * recovery files are discovered separately because their names come from the
 * contents of the damaged store.
 *
 * `asr-models/` is deliberately absent: it is a downloaded model cache (~900 MB
 * on this machine) that can be fetched again, and copying it would turn a daily
 * backup into a second copy of the biggest thing on disk. `logs/` is absent for
 * the same reason — it is diagnostics, not state. `media/` is opt-in
 * (`includeMedia`), because inbound images and files are reproducible by asking
 * again, while the journal that mentions them is not.
 */
const BACKUP_ROOTS = [
  ['config.json', 'file'],
  ['accounts-registry.json', 'file'],
  // The vendor keeps the account tokens under its own directory — a backup
  // without this one restores a plugin that is logged out.
  ['openclaw-weixin', 'dir'],
  ['asr-config.json', 'file'],
  ['memory', 'dir'],
  ['persona-modes.json', 'file'],
  ['persona-active.json', 'file'],
  ['journal', 'dir'],
  ['audit', 'dir'],
  ['sessions.json', 'file'],
  ['sessions', 'dir'],
  ['reminders.json', 'file'],
  ['subscriptions.json', 'file'],
  ['outbox.json', 'file'],
  ['config-scope.json', 'file'],
  ['exports', 'dir'],
  ['snippets', 'dir'],
]

// Reminder repairs keep exact source bytes beside the live store. These files
// may be the only remaining copy of rows that were filtered from reminders.json.
const REMINDER_RECOVERY_FILE = /^reminders\.recovery-[0-9a-f]+\.json$/

export function isReminderRecoveryFile(name) {
  return REMINDER_RECOVERY_FILE.test(name)
}

function reminderRecoveryFiles(dir, { warn } = {}) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isReminderRecoveryFile(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warn?.(`backup: cannot list reminder recovery files in ${dir}: ${error.message}`)
    }
    return []
  }
}

/** Copied only when asked for: big, and reproducible by asking again. */
const OPTIONAL_ROOTS = [['media', 'dir']]

export function backupsDir(stateRoot) {
  return path.join(stateRoot, 'backups')
}

/** `2026-10-28T02-13-07` — sorts as text, safe on every filesystem. */
export function stampFor(now = Date.now()) {
  return new Date(now).toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
}

function copyTree(from, to, { warn }) {
  let files = 0
  let bytes = 0
  const walk = (source, target) => {
    let stat
    try {
      stat = fs.statSync(source)
    } catch (error) {
      if (error.code !== 'ENOENT') warn?.(`could not read ${source}: ${error.message}`)
      return
    }
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      for (const entry of fs.readdirSync(source)) walk(path.join(source, entry), path.join(target, entry))
      return
    }
    if (!stat.isFile()) return
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.copyFileSync(source, target)
    // 0600: the copy carries live tokens for the same reason the original does.
    try {
      fs.chmodSync(target, 0o600)
    } catch {}
    files += 1
    bytes += stat.size
  }
  walk(from, to)
  return { files, bytes }
}

function sameFileContents(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right))
  } catch {
    return false
  }
}

/**
 * Publish complete bytes at an absent path with same-filesystem atomic no-clobber semantics.
 * The sibling temp directory proves ownership of cleanup. The payload is fully
 * written and fsynced before `link` publishes the complete inode. `link` is the
 * portable atomic no-clobber primitive here; `COPYFILE_EXCL` is explicitly not
 * atomic, and a plain rename could replace an existing target.
 */
export function writeFileExclusive(file, buffer) {
  const parent = path.dirname(file)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const tempDir = fs.mkdtempSync(path.join(parent, '.backup-exclusive-'))
  const tempFile = path.join(tempDir, 'payload')
  let ownsTempFile = false
  let fd
  try {
    fd = fs.openSync(tempFile, 'wx', 0o600)
    ownsTempFile = true
    try {
      fs.writeFileSync(fd, buffer)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
      fd = undefined
    }
    fs.linkSync(tempFile, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {}
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    if (ownsTempFile) {
      try {
        fs.unlinkSync(tempFile)
      } catch {}
    }
    // Non-recursive cleanup preserves any file another actor placed here.
    try {
      fs.rmdirSync(tempDir)
    } catch {}
  }
}

/**
 * Take a backup of everything worth keeping.
 *
 * @returns {{ id: string, path: string, files: number, bytes: number, skipped: string[] }}
 */
export function createBackup(stateRoot, { now = Date.now(), label = '', warn, keep = DEFAULT_KEEP, includeMedia = false } = {}) {
  const dir = backupsDir(stateRoot)
  const id = `${stampFor(now)}${label === '' ? '' : `-${label.replace(/[^A-Za-z0-9_-]/g, '_')}`}`
  const target = path.join(dir, id)
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })

  const skipped = []
  let files = 0
  let bytes = 0
  const recoveryRoots = reminderRecoveryFiles(stateRoot, { warn }).map((name) => [name, 'file'])
  const roots = [
    ...BACKUP_ROOTS,
    ...recoveryRoots,
    ...(includeMedia ? OPTIONAL_ROOTS : []),
  ]
  for (const [name, kind] of roots) {
    const source = path.join(stateRoot, name)
    try {
      fs.statSync(source)
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Not every installation has every directory; an absent one is not an error.
        skipped.push(name)
        continue
      }
      warn?.(`backup: cannot read ${name}: ${error.message}`)
      skipped.push(name)
      continue
    }
    if (kind === 'dir' && !fs.statSync(source).isDirectory()) {
      skipped.push(name)
      continue
    }
    const copied = copyTree(source, path.join(target, name), { warn })
    files += copied.files
    bytes += copied.bytes
  }

  fs.writeFileSync(
    path.join(target, 'MANIFEST.json'),
    `${JSON.stringify({ id, createdAt: new Date(now).toISOString(), files, bytes, skipped, includeMedia, roots: roots.map(([n]) => n) }, null, 2)}\n`,
    { mode: 0o600 },
  )

  pruneBackups(stateRoot, { keep, warn })
  return { id, path: target, files, bytes, skipped }
}

function manifestOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Newest first. Directories without a manifest are still listed, marked incomplete. */
export function listBackups(stateRoot) {
  const dir = backupsDir(stateRoot)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const backups = []
  for (const id of entries) {
    const full = path.join(dir, id)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const manifest = manifestOf(full)
    backups.push({
      id,
      path: full,
      createdAt: manifest?.createdAt ?? stat.mtime.toISOString(),
      files: manifest?.files ?? 0,
      bytes: manifest?.bytes ?? 0,
      complete: manifest !== undefined,
    })
  }
  return backups.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * Keep the newest `keep` completed backups. An incomplete one (no manifest) is
 * left alone rather than deleted: it is either being written right now or it is
 * a `pre-restore` copy, and both are worth keeping until someone looks.
 */
export function pruneBackups(stateRoot, { keep = DEFAULT_KEEP, warn } = {}) {
  const completed = listBackups(stateRoot).filter((entry) => entry.complete && !entry.id.startsWith('pre-restore-'))
  const doomed = completed.slice(Math.max(0, keep))
  const removed = []
  for (const entry of doomed) {
    try {
      fs.rmSync(entry.path, { recursive: true, force: true })
      removed.push(entry.id)
    } catch (error) {
      warn?.(`backup: could not remove old backup ${entry.id}: ${error.message}`)
    }
  }
  return removed
}

/**
 * Copy a backup over the live state.
 *
 * The caller is expected to have stopped the plugin (or at least checked the
 * instance lock): restoring under a running instance means the running instance
 * writes its in-memory state back over the files within seconds.
 */
export function restoreBackup(stateRoot, id, { now = Date.now(), warn } = {}) {
  const dir = backupsDir(stateRoot)
  const source = path.join(dir, id)
  if (!fs.existsSync(path.join(source, 'MANIFEST.json'))) {
    throw new Error(`no backup named ${id} (or it is incomplete)`)
  }
  const recoveryFiles = reminderRecoveryFiles(source, { warn })

  // Move the current state aside first, so this operation is itself revertible.
  const aside = path.join(dir, `pre-restore-${stampFor(now)}`)
  fs.mkdirSync(aside, { recursive: true, mode: 0o700 })
  const moved = []
  for (const [name] of [...BACKUP_ROOTS, ...OPTIONAL_ROOTS]) {
    const current = path.join(stateRoot, name)
    if (!fs.existsSync(current)) continue
    fs.renameSync(current, path.join(aside, name))
    moved.push(name)
  }

  let files = 0
  for (const [name] of [...BACKUP_ROOTS, ...OPTIONAL_ROOTS]) {
    const from = path.join(source, name)
    if (!fs.existsSync(from)) continue
    const copied = copyTree(from, path.join(stateRoot, name), { warn })
    files += copied.files
  }

  // Recovery files are content-addressed immutable evidence, so merge them
  // separately. In particular, never move or overwrite a live copy that differs
  // from the backup: it may be the only copy of another damaged reminder store.
  const recoveryConflicts = []
  const recoveryFailures = []
  for (const name of recoveryFiles) {
    const from = path.join(source, name)
    const target = path.join(stateRoot, name)
    let backupBytes
    try {
      backupBytes = fs.readFileSync(from)
      writeFileExclusive(target, backupBytes)
      files += 1
    } catch (error) {
      let same = false
      if (error.code === 'EEXIST') {
        same = sameFileContents(from, target)
      }
      if (same) continue
      if (error.code === 'EEXIST') {
        const conflict = {
          name,
          livePath: target,
          backupPath: from,
          preservedPath: null,
          preserved: false,
        }
        const preservedPath = path.join(aside, name)
        try {
          writeFileExclusive(preservedPath, backupBytes)
          conflict.preservedPath = preservedPath
          conflict.preserved = true
          warn?.(`kept existing reminder recovery ${name}; saved the backup copy to ${preservedPath}`)
        } catch (copyError) {
          if (copyError.code === 'EEXIST' && sameFileContents(from, preservedPath)) {
            conflict.preservedPath = preservedPath
            conflict.preserved = true
            warn?.(`kept existing reminder recovery ${name}; the backup copy is already preserved at ${preservedPath}`)
            recoveryConflicts.push(conflict)
            continue
          }
          conflict.error = String(copyError?.message ?? copyError)
          conflict.errorCode = copyError?.code ?? null
          warn?.(
            `kept existing reminder recovery ${name}; could not preserve the backup copy in ${aside}: ` +
              `${conflict.error}; restore may be partial and the backup copy remains at ${from} until rotation`,
          )
        }
        recoveryConflicts.push(conflict)
      } else {
        const failure = {
          name,
          livePath: target,
          backupPath: from,
          error: String(error?.message ?? error),
          code: error?.code ?? null,
        }
        recoveryFailures.push(failure)
        warn?.(
          `backup: cannot restore reminder recovery ${name}: ${failure.error}; ` +
            `restore may be partial and the backup copy remains at ${from}`,
        )
      }
    }
  }
  return { id, movedAside: moved, restoredFiles: files, aside, recoveryConflicts, recoveryFailures }
}

/** Count what is in a backup, for the "did this actually copy anything" question. */
export function verifyBackup(stateRoot, id) {
  const dir = path.join(backupsDir(stateRoot), id)
  const manifest = manifestOf(dir)
  if (manifest === undefined) return { id, ok: false, reason: 'no manifest' }
  let files = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'MANIFEST.json') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files += 1
    }
  }
  walk(dir)
  return { id, ok: files > 0 && files >= manifest.files, files, expected: manifest.files, createdAt: manifest.createdAt }
}
