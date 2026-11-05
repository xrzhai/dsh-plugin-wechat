#!/usr/bin/env node
/**
 * Install this checkout into a DSH profile.
 *
 * Fresh profiles are the primary path. The installer registers the profile
 * dependency as a link to this checkout, creates the matching node_modules
 * link immediately, and registers the bundle. It never assumes that a renamed
 * package is available on npm and never depends on an earlier Weixin install.
 *
 * Usage:
 *   node bin/install.mjs [--profile <name>] [--pin] [--uninstall] [--dry-run]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  PKG_NAME,
  ROW_ID,
  SUPERSEDED_PACKAGES,
  parseYamlNode,
  readKeptValues,
  removeInstalledPackage,
  removeMountBlocks,
  samePath,
  sourceLinkSpec,
} from './lib/install-profile.mjs'
import {
  INSTALL_HELP,
  InstallArgumentError,
  parseInstallArgs,
  validateProfileName,
} from './lib/install-args.mjs'
import { pinProfileDependency, pinProfileSourceSpec } from './lib/profile-pin.mjs'

const sourceRoot = path.resolve(import.meta.dirname, '..')

function argumentFail(message) {
  process.stderr.write('dsh-weixin install: ' + message + '\n')
  process.stderr.write('Try --help for usage.\n')
  process.exit(2)
}

let cliOptions
try {
  cliOptions = parseInstallArgs(process.argv.slice(2))
} catch (error) {
  if (error instanceof InstallArgumentError) argumentFail(error.message)
  throw error
}
if (cliOptions.help) {
  process.stdout.write(INSTALL_HELP + '\n')
  process.exit(0)
}

const uninstall = cliOptions.uninstall
const pin = cliOptions.pin
const dryRun = cliOptions.dryRun
let profileName
try {
  profileName = validateProfileName(cliOptions.profile ?? process.env.DSH_PROFILE ?? 'desktop')
} catch (error) {
  if (error instanceof InstallArgumentError) argumentFail(error.message)
  throw error
}
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileName)
const profilePkgPath = path.join(profileDir, 'package.json')
const targetDir = path.join(profileDir, 'node_modules', PKG_NAME)
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const settingsPath = path.join(dshHome, 'weixin', 'config.json')

function fail(message) {
  process.stderr.write('dsh-weixin install: ' + message + '\n')
  process.exit(1)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail('cannot read JSON at ' + file + ': ' + String(error))
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function removeStalePackageCopies() {
  for (const stale of SUPERSEDED_PACKAGES) {
    const staleDir = path.join(profileDir, 'node_modules', stale)
    const result = removeInstalledPackage(staleDir, sourceRoot)
    if (result.removed) process.stdout.write('removed superseded ' + stale + ' at ' + staleDir + '\n')
  }
}

function removeProfileRegistrations(pkg) {
  let changed = false
  for (const collectionName of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const collection = pkg[collectionName]
    if (collection === undefined || typeof collection !== 'object' || Array.isArray(collection)) continue
    for (const name of [PKG_NAME, ...SUPERSEDED_PACKAGES]) {
      if (Object.hasOwn(collection, name)) {
        delete collection[name]
        changed = true
      }
    }
  }
  const bundles = pkg.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const filtered = bundles.filter((name) => name !== PKG_NAME && !SUPERSEDED_PACKAGES.includes(name))
    if (filtered.length !== bundles.length) {
      pkg.dsh.profile.bundles = filtered
      changed = true
    }
  }
  return changed
}

function validateSourceCheckout() {
  const packageFile = path.join(sourceRoot, 'package.json')
  const pkg = readJson(packageFile)
  if (pkg.name !== PKG_NAME) {
    fail('expected ' + PKG_NAME + ' at ' + sourceRoot + ', found ' + String(pkg.name))
  }
  const requiredEntries = ['src', 'bin', 'vendor', 'assets', 'locale', 'package.json', 'cordis.patch.yml']
  for (const entry of requiredEntries) {
    if (!fs.existsSync(path.join(sourceRoot, entry))) {
      fail('source checkout is incomplete: missing ' + entry)
    }
  }
  for (const locale of ['en.json', 'zh.json']) {
    const file = path.join(sourceRoot, 'locale', locale)
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      fail('source checkout is missing locale/' + locale)
    }
  }
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    const dependencyDir = path.join(sourceRoot, 'node_modules', ...dependency.split('/'))
    if (!fs.existsSync(path.join(dependencyDir, 'package.json'))) {
      fail(
        'runtime dependency ' + dependency + ' is not installed in this checkout\n' +
        '      run (cd ' + sourceRoot + ' && pnpm install) and retry',
      )
    }
  }
  return pkg
}

function ensureSourceLink() {
  if (samePath(sourceRoot, targetDir)) {
    fail('refusing to install the checkout into itself: ' + targetDir)
  }
  const removed = removeInstalledPackage(targetDir, sourceRoot)
  if (removed.removed) process.stdout.write('replaced existing package entry at ' + targetDir + '\n')
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  try {
    fs.symlinkSync(sourceRoot, targetDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fail(
      'could not link ' + targetDir + ' to ' + sourceRoot + ': ' + String(error) + '\n' +
      '      move the profile and source to paths where the current user can create a directory link',
    )
  }
  process.stdout.write('linked package ' + targetDir + ' -> ' + sourceRoot + '\n')
}

function migratePatch(patchText) {
  const removal = removeMountBlocks(patchText, ROW_ID)
  let migrated = {}
  if (removal.blocks.length > 0) {
    const lines = patchText.split('\n')
    for (const block of removal.blocks) {
      const values = readKeptValues(lines.slice(block.rowStart, block.rowEnd).join('\n'))
      for (const [key, raw] of Object.entries(values)) {
        if (!Object.hasOwn(migrated, key)) migrated[key] = raw
      }
    }
  }
  return { text: removal.text, blocks: removal.blocks, migrated }
}

if (!fs.existsSync(profileDir)) fail('profile not found: ' + profileDir)
if (!fs.existsSync(profilePkgPath)) fail('profile package.json not found: ' + profilePkgPath)

const profilePkg = readJson(profilePkgPath)

if (dryRun) {
  process.stdout.write('dry run: no files will be changed\n')
  process.stdout.write('  profile: ' + profileDir + '\n')
  if (uninstall) {
    process.stdout.write('  would remove package link and plugin registrations\n')
  } else {
    validateSourceCheckout()
    const patchBefore = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '[]\n'
    const migration = migratePatch(patchBefore)
    process.stdout.write(
      '  would link ' + targetDir + ' -> ' + sourceRoot + '\n' +
      '  would register dependency ' + sourceLinkSpec(sourceRoot) + '\n' +
      '  would register bundle ' + PKG_NAME + '\n' +
      '  old mount rows to remove: ' + migration.blocks.length + '\n' +
      '  pin lockfile: ' + (pin ? 'yes' : 'no') + '\n',
    )
  }
  process.exit(0)
}

if (uninstall) {
  const removal = removeInstalledPackage(targetDir, sourceRoot)
  if (removal.removed) process.stdout.write('removed package entry ' + targetDir + '\n')
  else if (removal.reason !== 'missing') {
    process.stdout.write('left ' + targetDir + ' untouched (' + removal.reason + ')\n')
  }
  removeStalePackageCopies()
  const changed = removeProfileRegistrations(profilePkg)
  if (changed) writeJson(profilePkgPath, profilePkg)
  process.stdout.write(
    '\n已卸载。源码目录未被删除。凭据和设置保留在 ' + path.join(dshHome, 'weixin') + '。\n',
  )
  process.exit(0)
}

validateSourceCheckout()

const patchBefore = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '[]\n'
const migration = migratePatch(patchBefore)
if (migration.blocks.length > 0) {
  fs.writeFileSync(patchPath, migration.text)
  process.stdout.write('removed duplicate ' + ROW_ID + ' mount row(s) from ' + patchPath + '\n')
}

const settings = fs.existsSync(settingsPath) ? readJson(settingsPath) : {}
for (const [key, raw] of Object.entries(migration.migrated)) {
  if (Object.hasOwn(settings, key)) continue
  const value = parseYamlNode(raw)
  if (value === undefined) continue
  if (key === 'asr' && (value === null || typeof value !== 'object')) continue
  settings[key] = value
}
fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 })
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
try {
  fs.chmodSync(settingsPath, 0o600)
} catch {
  // chmod is advisory on Windows and is already handled by the default ACL.
}

removeStalePackageCopies()
ensureSourceLink()

const profileBefore = JSON.stringify(profilePkg)
for (const collectionName of ['dependencies', 'optionalDependencies', 'devDependencies']) {
  const collection = profilePkg[collectionName]
  if (collection === undefined || typeof collection !== 'object' || Array.isArray(collection)) continue
  for (const name of [PKG_NAME, ...SUPERSEDED_PACKAGES]) delete collection[name]
}
profilePkg.dependencies = profilePkg.dependencies && typeof profilePkg.dependencies === 'object'
  ? profilePkg.dependencies
  : {}
const sourceSpecPatch = pinProfileSourceSpec(JSON.stringify(profilePkg, null, 2) + '\n', sourceRoot)
if (sourceSpecPatch !== null) profilePkg.dependencies[PKG_NAME] = sourceSpecPatch.to

profilePkg.dsh = profilePkg.dsh && typeof profilePkg.dsh === 'object' ? profilePkg.dsh : {}
profilePkg.dsh.profile = profilePkg.dsh.profile && typeof profilePkg.dsh.profile === 'object'
  ? profilePkg.dsh.profile
  : {}
const bundles = Array.isArray(profilePkg.dsh.profile.bundles) ? profilePkg.dsh.profile.bundles : []
profilePkg.dsh.profile.bundles = bundles.filter((name) => (
  name !== PKG_NAME && !SUPERSEDED_PACKAGES.includes(name)
))
profilePkg.dsh.profile.bundles.push(PKG_NAME)
if (JSON.stringify(profilePkg) !== profileBefore) writeJson(profilePkgPath, profilePkg)

const profileRequire = createRequire(profilePkgPath)
let resolvedEntry
try {
  resolvedEntry = profileRequire.resolve(PKG_NAME)
} catch (error) {
  fail('profile cannot resolve ' + PKG_NAME + ': ' + String(error))
}

if (pin) {
  const outcome = pinProfileDependency({
    profile: profileName,
    sourceRoot,
    dshHome,
    ok: (line) => process.stdout.write(line + '\n'),
    warn: (line) => process.stderr.write(line + '\n'),
    note: (line) => process.stdout.write('  ' + line + '\n'),
  })
  if (outcome.pinned === false && outcome.reason === 'source-is-target') {
    fail('refusing to persist a dependency that points at the profile copy')
  }
  if (outcome.reason === 'lock-not-refreshed') {
    fail('package link was registered, but --pin could not refresh the lockfile; run pnpm install in ' + profileDir)
  }
}

process.stdout.write(
  '\n完成。\n' +
  '  dependency: ' + sourceLinkSpec(sourceRoot) + '\n' +
  '  entry: ' + resolvedEntry + '\n' +
  '  1. 重启 DSH\n' +
  '  2. node ' + path.join(targetDir, 'bin', 'login.js') + '  # 扫码绑定微信\n' +
  '\n设置存在 ' + settingsPath + '，重装不会丢。\n',
)
