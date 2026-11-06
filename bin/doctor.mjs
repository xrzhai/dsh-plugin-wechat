#!/usr/bin/env node
// Diagnose the plugin; --fix only creates missing core directories.
// --dry-run lists those directories without creating them.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describeHost, detectHostVersion, hostStatus } from '../src/host-compat.js'
import { statePath } from '../src/state-layout.js'
import { allowlistForAccount } from '../src/account-registry.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []

function record(level, name, detail) {
  results.push({ level, name, detail })
}

function ok(name, detail = '') { record('ok', name, detail) }
function note(name, detail = '') { record('note', name, detail) }
function bad(name, detail = '') { record('bad', name, detail) }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { return { __error: String(error) } }
}

function pkgJson() {
  return readJson(path.join(ROOT, 'package.json'))
}

function stateRoot() {
  const env = process.env.DSH_WEIXIN_STATE_DIR
  if (typeof env === 'string' && env !== '') return env
  return path.join(os.homedir(), '.dsh', 'weixin')
}

function parseMinimumNode(requirement) {
  const match = typeof requirement === 'string' ? requirement.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)/) : null
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

function checkNode(pkg) {
  const requirement = pkg?.engines?.node
  const minimum = parseMinimumNode(requirement)
  if (minimum === null) {
    return bad('node', 'package.json does not contain a usable engines.node minimum')
  }
  const actual = process.versions.node.split('.').map(Number)
  if (versionAtLeast(actual, minimum)) {
    ok(`node ${process.versions.node}`, `meets package.json engines.node ${requirement}`)
  } else {
    bad(
      `node ${process.versions.node}`,
      `package.json requires Node ${minimum.join('.')} or newer (${requirement})`,
    )
  }
}

function checkPackage(pkg = pkgJson()) {
  if (pkg.__error !== undefined) return bad('package.json', pkg.__error)
  ok(`installed version ${pkg.version}`)
  const deps = Object.keys(pkg.dependencies ?? {})
  if (deps.length <= 3) ok(`dependencies: ${deps.join(', ') || 'none'}`)
  else note(`dependencies: ${deps.join(', ')}`, 'this plugin is meant to stay near-zero-dependency')
}

function checkStateDir(root) {
  if (!fs.existsSync(root)) return note('state directory', `${root} does not exist yet`)
  try {
    fs.accessSync(root, fs.constants.W_OK)
    ok('state directory accessible', root)
  } catch (error) {
    bad('state directory accessible', `${root}: ${String(error)}`)
  }
}

function credentialAccounts(root) {
  const dir = path.join(root, 'openclaw-weixin', 'accounts')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    return { dir, accounts: [], error: error?.code === 'ENOENT' ? undefined : error }
  }
  const accounts = names
    .filter((name) => name.endsWith('.json') && name.endsWith('.sync.json') === false)
    .flatMap((name) => {
      const accountId = name.slice(0, -'.json'.length)
      if (accountId === '' || path.basename(accountId) !== accountId) return []
      const account = readJson(path.join(dir, name))
      const token = typeof account.token === 'string' ? account.token : ''
      return token === '' ? [] : [{ accountId, name, account }]
    })
  return { dir, accounts }
}

function senderCount(value) {
  return Array.isArray(value)
    ? value.filter((sender) => typeof sender === 'string' && sender.trim() !== '').length
    : 0
}

function checkEffectiveAllowlist(root, config) {
  const signedIn = credentialAccounts(root).accounts
  if (signedIn.length === 0) {
    return bad('allowed senders', 'no signed-in account — bind one before the allowlist can authorize messages')
  }

  // Reuse the runtime's account-level override resolution. In particular, a
  // blank global list is not empty for an account whose first contact has
  // already been enrolled; that enrollment lives in accounts-registry.json.
  const effective = signedIn.map(({ accountId }) =>
    senderCount(allowlistForAccount(accountId, config).allowedSenders))
  const authorized = effective.filter((count) => count > 0).length
  if (authorized === signedIn.length) {
    const globalCount = senderCount(config.allowedSenders)
    return ok(
      'allowed senders',
      `authorized for ${authorized} signed-in account(s)` +
        (globalCount > 0 ? `; global list has ${globalCount} sender(s)` : '; account-level lists are in use'),
    )
  }
  bad(
    'allowed senders',
    `${signedIn.length - authorized} of ${signedIn.length} signed-in account(s) have an empty effective allowlist`,
  )
}

function checkConfig(root) {
  const file = path.join(root, 'config.json')
  let config = {}
  if (fs.existsSync(file) !== true) {
    note('config', 'not written yet — defaults are in use until the settings card saves')
  } else {
    config = readJson(file)
    if (config.__error !== undefined) return bad('config', `${file}: ${config.__error}`)
  }
  checkEffectiveAllowlist(root, config)
  return config
}

function checkAccounts(root) {
  const { dir, accounts, error } = credentialAccounts(root)
  if (error !== undefined) return bad('weixin account', `${dir}: ${String(error)}`)
  if (fs.existsSync(dir) !== true) return bad('weixin account', 'never logged in — open the card and scan the QR code')
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name.endsWith('.sync.json') === false)
  if (files.length === 0) return bad('weixin account', `${dir} has no account file — log in again`)
  const withCredentials = new Set(accounts.map((account) => account.name))
  for (const name of files) {
    const file = path.join(dir, name)
    const account = readJson(file)
    if (account.__error !== undefined) { bad(`account ${name}`, account.__error); continue }
    const token = typeof account.token === 'string' ? account.token : ''
    if (token === '') bad(`account ${name}`, 'no token in the file — log in again')
    else if (withCredentials.has(name)) ok(`account ${name}`, `token present, saved ${account.savedAt ?? 'unknown'}`)
  }
}

function checkLock(root) {
  const file = path.join(root, 'instance.lock')
  if (fs.existsSync(file) !== true) return ok('instance lock', 'no other window is writing this state')
  const lock = readJson(file)
  const pid = Number(lock.pid)
  if (!Number.isFinite(pid)) return note('instance lock', 'unreadable; the plugin will take it over')
  let alive = false
  try { process.kill(pid, 0); alive = true } catch { alive = false }
  if (alive && fs.statSync(file).mtimeMs > Date.now() - 90_000) {
    note('instance lock', `held by pid ${pid} (a second DSH window) — both will poll the same account`)
  } else {
    ok('instance lock', 'stale; will be taken over')
  }
}

function checkOutbox(root) {
  const file = path.join(root, 'outbox.json')
  if (fs.existsSync(file) !== true) return ok('outbox', 'empty')
  const store = readJson(file)
  const items = Array.isArray(store.items) ? store.items : []
  if (items.length === 0) return ok('outbox', 'empty')
  const oldest = items[0]
  note('outbox', `${items.length} message(s) waiting, oldest from ${new Date(oldest.createdAt ?? Date.now()).toISOString()}`)
}

function checkRecentErrors(root) {
  const dir = path.join(root, 'logs')
  if (fs.existsSync(dir) !== true) return ok('logs', 'none yet')
  const files = fs.readdirSync(dir).filter((name) => name.startsWith('openclaw-') && name.endsWith('.log')).sort()
  const latest = files.at(-1)
  if (latest === undefined) return ok('logs', 'none yet')
  const text = fs.readFileSync(path.join(dir, latest), 'utf8')
  const lines = text.split('\n')
  const errors = lines.filter((line) => /error|failed|refused|threw/i.test(line)).slice(-3)
  if (errors.length === 0) ok('recent log', `${latest}: no errors`)
  else note('recent log', `${latest}: ${errors.join(' | ').slice(0, 400)}`)
}

/**
 * Which host app is this running inside?
 *
 * The plugin imports the app's own packages and registers into the app's own slots,
 * so a host upgrade is the single most likely cause of "it worked yesterday". This
 * check cannot fix anything — it just makes the version visible before someone
 * spends an evening on the wrong theory.
 */
function checkHost() {
  const version = detectHostVersion()
  const status = hostStatus(version)
  if (status.status === 'unknown') return note('host app', describeHost(version))
  if (status.status === 'tested') return ok('host app', describeHost(version))
  note('host app', describeHost(version))
}

function checkRegistryVersion(offline) {
  if (offline) return note('published version', 'skipped (--offline)')
  const pkg = pkgJson()
  if (pkg.__error !== undefined) return
  try {
    const remote = execFileSync('npm', ['view', pkg.name, 'version'], { encoding: 'utf8', timeout: 8_000 }).trim()
    if (remote === pkg.version) ok('published version', `up to date (${remote})`)
    else note('published version', `installed ${pkg.version}, published ${remote} — a newer release exists`)
  } catch {
    note('published version', 'could not reach npm')
  }
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const dryRun = args.includes('--dry-run')
  return {
    repairing: args.includes('--fix') || dryRun,
    dryRun,
    offline: args.includes('--offline') || process.env.DSH_WEIXIN_DOCTOR_OFFLINE === '1',
  }
}

function applyFixes(root, { dryRun }) {
  const changes = []
  const failed = []
  const dirs = [
    [root, 'state root'],
    [path.join(root, 'sessions'), 'sessions/'],
    [statePath(root, 'mediaInboundDir'), 'media/inbound/'],
  ]
  for (const [dir, label] of dirs) {
    if (fs.existsSync(dir)) continue
    try {
      if (!dryRun) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      changes.push(`created ${label}`)
    } catch (error) {
      failed.push(`could not create ${label} — ${String(error?.message ?? error)}`)
    }
  }
  return { changes, failed }
}

function printFixes({ changes, failed }, dryRun) {
  const label = dryRun ? 'would fix' : 'fixed'
  if (changes.length === 0 && failed.length === 0) {
    process.stdout.write(`\n${label}: nothing to repair.\n`)
    return
  }
  process.stdout.write(`\n${dryRun ? 'would fix (dry run):' : 'fixed:'}\n`)
  for (const line of changes) process.stdout.write(`  + ${line}\n`)
  for (const line of failed) process.stdout.write(`  ✗ ${line}\n`)
}

function main() {
  const { repairing, dryRun, offline } = parseArgs(process.argv)
  const root = stateRoot()
  const pkg = pkgJson()
  checkNode(pkg)
  checkPackage(pkg)
  checkStateDir(root)
  checkConfig(root)
  checkAccounts(root)
  checkLock(root)
  checkOutbox(root)
  checkHost()
  checkRecentErrors(root)
  checkRegistryVersion(offline)


  const icon = { ok: '✓', note: '·', bad: '✗' }
  const width = Math.max(...results.map((entry) => entry.name.length))
  for (const entry of results) {
    process.stdout.write(`${icon[entry.level]} ${entry.name.padEnd(width)}  ${entry.detail}\n`)
  }
  const failures = results.filter((entry) => entry.level === 'bad').length
  process.stdout.write(`\n${results.length} checks, ${failures} problem(s). state: ${root}\n`)
  if (repairing) printFixes(applyFixes(root, { dryRun }), dryRun)
  process.exitCode = failures > 0 ? 1 : 0
}

main()
