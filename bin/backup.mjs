#!/usr/bin/env node
/**
 * Back up, list, verify and restore this machine's Weixin state directory.
 *
 *   node bin/backup.mjs create [--label before-upgrade]
 *   node bin/backup.mjs list
 *   node bin/backup.mjs verify <id>
 *   node bin/backup.mjs restore <id> [--yes]  # exit the agent harness, then confirm with --yes
 *   DSH_WEIXIN_BACKUP_PASSPHRASE=… node bin/backup.mjs seal <file.enc> [--no-media]
 *   DSH_WEIXIN_BACKUP_PASSPHRASE=… node bin/backup.mjs open <file.enc> [--dry-run] [--yes]
 *     # a write requires exiting the agent harness first, then confirming with --yes
 *
 * Written as a CLI rather than a remote method because the interesting moments
 * (upgrading, moving to another machine, "I think I deleted the wrong thing")
 * happen when the plugin is not running — or when running it is exactly what you
 * do not want to do.
 */
import path from 'node:path'
import { createBackup, listBackups, restoreBackup, verifyBackup, backupsDir } from '../src/backup.js'
import { openState, planSealedRestore, restoreSealed, sealState } from '../src/backup-crypto.js'
import { inspectInstanceLock } from '../src/instance-lock.js'
import { stateDir } from '../src/state.js'

const argv = process.argv.slice(2)
const command = argv.find((a) => !a.startsWith('--')) ?? 'help'
const rest = argv.filter((a) => !a.startsWith('--')).slice(1)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const yes = flags.has('--yes')

const root = stateDir()

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function warn(line) {
  process.stderr.write(`! ${line}\n`)
}

const EXIT_HARNESS_THEN_YES = 'Exit the DSH agent harness, then rerun with --yes to confirm.'

/**
 * A missing courtesy lock is not evidence that DSH is stopped: the plugin gets
 * the lock only after a long enabled startup and continues even if it cannot
 * write one. Only an OS-confirmed dead holder proceeds automatically; a live
 * holder or any indeterminate state requires the operator's explicit --yes.
 *
 * @returns {boolean} whether the restore may continue
 */
function restoreTargetIsSafe() {
  const inspection = inspectInstanceLock(root)
  if (inspection.state === 'running') {
    if (yes) {
      warn(`DSH instance pid ${inspection.holder.pid} appears to be running; continuing because --yes was passed`)
      return true
    }
    console.error(
      `✗ DSH instance pid ${inspection.holder.pid} appears to be running. ${EXIT_HARNESS_THEN_YES}`,
    )
    return false
  }

  if (inspection.state === 'stale') {
    warn(
      `ignoring stale instance lock for pid ${inspection.holder.pid} ` +
        '(the operating system says that process no longer exists)',
    )
    return true
  }

  const reason = inspection.state === 'missing'
    ? 'no instance lock is present (normal after a clean agent-harness exit)'
    : inspection.reason
  if (yes) {
    warn(`cannot confirm DSH is stopped (${reason}); continuing because --yes was passed`)
    return true
  }
  console.error(
    `✗ cannot confirm DSH is stopped (${reason}). ${EXIT_HARNESS_THEN_YES}`,
  )
  return false
}

switch (command) {
  case 'create': {
    const labelIndex = argv.indexOf('--label')
    const label = labelIndex === -1 ? '' : (argv[labelIndex + 1] ?? '')
    const result = createBackup(root, { label, warn, includeMedia: flags.has('--with-media') })
    console.log(`✓ backup ${result.id}`)
    console.log(`  ${result.files} file(s), ${human(result.bytes)}`)
    console.log(`  ${result.path}`)
    if (result.skipped.length > 0) console.log(`  not present: ${result.skipped.join(', ')}`)
    console.log(`\n  this copy contains config.json and the account tokens — keep it on this machine`)
    break
  }

  case 'list': {
    const backups = listBackups(root)
    if (backups.length === 0) {
      console.log(`no backups in ${backupsDir(root)}`)
      break
    }
    for (const entry of backups) {
      const state = entry.complete ? `${entry.files} file(s), ${human(entry.bytes)}` : 'incomplete (no manifest)'
      console.log(`${entry.id}  ${entry.createdAt}  ${state}`)
    }
    break
  }

  case 'verify': {
    const [id] = rest
    if (id === undefined) {
      console.error('usage: node bin/backup.mjs verify <id>')
      process.exitCode = 1
      break
    }
    const result = verifyBackup(root, id)
    if (result.ok) console.log(`✓ ${id}: ${result.files} file(s) present (manifest said ${result.expected})`)
    else console.log(`✗ ${id}: ${result.reason ?? `${result.files} of ${result.expected} file(s) present`}`)
    break
  }

  case 'restore': {
    const [id] = rest
    if (id === undefined) {
      console.error('usage: node bin/backup.mjs restore <id> [--yes]')
      console.error('       normal exits have no instance lock; exit the agent harness, then pass --yes')
      process.exitCode = 1
      break
    }
    const verified = verifyBackup(root, id)
    if (!verified.ok) {
      console.error(`✗ ${id} does not look intact (${verified.reason ?? 'missing files'}) — refusing to restore`)
      process.exitCode = 1
      break
    }
    // Restoring under a live instance is the one thing that silently undoes
    // itself: the running plugin rewrites its in-memory state over the files.
    if (!restoreTargetIsSafe()) {
      process.exitCode = 1
      break
    }
    const result = restoreBackup(root, id, { warn })
    const incomplete = result.recoveryFailures.length > 0 ||
      result.recoveryConflicts.some((conflict) => !conflict.preserved)
    console.log(`${incomplete ? '!' : '✓'} restored ${result.restoredFiles} file(s) from ${id}`)
    console.log(`  previous state moved to ${path.relative(root, result.aside)} (delete it once you are happy)`)
    for (const conflict of result.recoveryConflicts) {
      if (conflict.preserved) {
        console.log(`  kept live recovery ${conflict.name}; backup copy saved to ${conflict.preservedPath}`)
      } else {
        console.error(`✗ restore may be partial: kept live recovery ${conflict.name}, but its backup copy was not preserved outside rotation`)
        console.error(`  backup copy: ${conflict.backupPath}`)
        console.error(`  preservation error: ${conflict.error}`)
        process.exitCode = 1
      }
    }
    for (const failure of result.recoveryFailures) {
      console.error(`✗ restore may be partial: could not add reminder recovery ${failure.name}`)
      console.error(`  backup copy: ${failure.backupPath}`)
      console.error(`  error: ${failure.error}`)
      process.exitCode = 1
    }
    console.log(`  restart DSH to load the restored state`)
    break
  }

  case 'seal': {
    const file = rest[0]
    if (!file) {
      console.error('usage: DSH_WEIXIN_BACKUP_PASSPHRASE=… node bin/backup.mjs seal <file.enc> [--no-media]')
      process.exitCode = 1
      break
    }
    const passphrase = process.env.DSH_WEIXIN_BACKUP_PASSPHRASE ?? ''
    if (passphrase === '') {
      console.error('✗ set DSH_WEIXIN_BACKUP_PASSPHRASE (the archive cannot be described without it)')
      process.exitCode = 1
      break
    }
    const result = sealState(root, {
      passphrase,
      outFile: path.resolve(file),
      // Media is usually the bulk of the directory and the least important part
      // of a move; `--no-media` leaves it behind deliberately.
      includeMedia: !flags.has('--no-media'),
      warn,
    })
    console.log(`✓ sealed ${result.files} file(s) into ${result.file} (${human(result.bytes)})`)
    console.log('  this file is encrypted; without the passphrase it is unreadable, so store that separately')
    break
  }

  case 'open': {
    const file = rest[0]
    if (!file) {
      console.error('usage: DSH_WEIXIN_BACKUP_PASSPHRASE=… node bin/backup.mjs open <file.enc> [--dry-run] [--yes]')
      console.error('       a write requires exiting the agent harness first, then passing --yes')
      process.exitCode = 1
      break
    }
    const passphrase = process.env.DSH_WEIXIN_BACKUP_PASSPHRASE ?? ''
    if (passphrase === '') {
      console.error('✗ set DSH_WEIXIN_BACKUP_PASSPHRASE')
      process.exitCode = 1
      break
    }
    let opened
    try {
      opened = openState(path.resolve(file), { passphrase })
    } catch (error) {
      console.error(`✗ ${error.message}`)
      process.exitCode = 1
      break
    }
    if (flags.has('--dry-run')) {
      const plan = planSealedRestore(root, opened.files)
      const writes = plan.entries.filter((entry) => entry.action !== 'same')
      const bytes = writes.reduce((total, entry) => total + entry.buffer.length, 0)
      const replaces = writes.filter((entry) => entry.action === 'overwrite').length
      const conflicts = writes.filter((entry) => entry.action === 'conflict').length
      const created = writes.length - replaces - conflicts
      const rows = []
      for (const entry of plan.entries) {
        if (entry.action === 'conflict') {
          rows.push(`! ${entry.rel} (keep live; archive copy -> ${path.relative(root, entry.preservedPath)}; estimated path)`)
        } else if (entry.action === 'same') {
          rows.push(`= ${entry.rel} (already preserved)`)
        } else {
          rows.push(`${entry.action === 'overwrite' ? '\u21ba' : '+'} ${entry.rel}`)
        }
      }
      const conflictSummary = conflicts === 0 ? '' : `, ${conflicts} conflict-safe`
      console.log(`would write ${writes.length} file(s), ${human(bytes)}: ${replaces} overwrite, ${created} new${conflictSummary}`)
      if (conflicts > 0) console.log('  pre-restore paths are estimates; the actual restore uses a new timestamp')
      for (const row of rows.slice(0, 40)) console.log(`  ${row}`)
      if (rows.length > 40) console.log(`  …and ${rows.length - 40} more`)
      break
    }
    if (!restoreTargetIsSafe()) {
      process.exitCode = 1
      break
    }
    let result
    try {
      result = restoreSealed(root, opened.files, { warn })
    } catch (error) {
      console.error(`✗ sealed restore aborted: ${error.message}`)
      console.error(`  archive remains at ${file}`)
      process.exitCode = 1
      break
    }
    console.log(`✓ restored ${result.restored} file(s) from ${file}`)
    for (const conflict of result.recoveryConflicts) {
      console.log(`  kept live recovery ${conflict.name}; archive copy saved to ${conflict.preservedPath}`)
    }
    console.log('  restart DSH to load the restored state')
    break
  }

  default: {
    console.log(`usage:
  node bin/backup.mjs create [--label <name>] [--with-media]   take a backup (keeps the newest few)
  node bin/backup.mjs list                      what backups exist
  node bin/backup.mjs verify <id>               is this one intact
  node bin/backup.mjs restore <id> [--yes]      exit the agent harness, then pass --yes to confirm
  node bin/backup.mjs seal <file.enc> [--no-media]  encrypt the whole state into one file
  node bin/backup.mjs open <file.enc> [--dry-run] [--yes]  exit the harness, then pass --yes to write

state: ${root}
backups: ${backupsDir(root)}`)
  }
}
