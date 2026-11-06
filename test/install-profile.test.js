import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  removeInstalledPackage,
  sourceLinkSpec,
} from '../bin/lib/install-profile.mjs'
import {
  pinProfileDependency,
  pinProfileSpec,
  pnpmCommand,
} from '../bin/lib/profile-pin.mjs'

const PKG_NAME = 'dsh-plugin-wechat'
const REPO_ROOT = path.resolve(import.meta.dirname, '..')

test('Windows pnpm shims resolve to a shell-free executable or JS entry', (t) => {
  const root = tempRoot(t, 'dsh-pnpm-shim-')
  const bin = path.join(root, 'space in path', 'node_modules', 'pnpm', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const script = path.join(bin, 'pnpm.mjs')
  fs.writeFileSync(script, '')
  const env = { PATH: path.join(root, 'space in path') }
  assert.deepEqual(pnpmCommand({ env, platform: 'win32', nodePath: 'fixture-node' }), {
    command: 'fixture-node', prefix: [script],
  })
  const exe = path.join(root, 'space in path', 'node_modules', 'pnpm', 'pnpm.exe')
  fs.writeFileSync(exe, '')
  assert.deepEqual(pnpmCommand({ env, platform: 'win32' }), { command: exe, prefix: [] })
})

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

test('published pin inserts a missing dependency while preserving existing entries', () => {
  const raw = JSON.stringify({ dependencies: { left: '1.0.0' } }, null, 2) + '\n'
  const patch = pinProfileSpec(raw, '9.8.7')
  assert.ok(patch)
  const pkg = JSON.parse(patch.text)
  assert.equal(pkg.dependencies.left, '1.0.0')
  assert.equal(pkg.dependencies[PKG_NAME], '^9.8.7')

  const existing = JSON.stringify({ dependencies: { [PKG_NAME]: '^1.0.0' } }, null, 2) + '\n'
  const upgraded = pinProfileSpec(existing, '2.0.0')
  assert.ok(upgraded)
  assert.equal(JSON.parse(upgraded.text).dependencies[PKG_NAME], '^2.0.0')
})

test('source pin writes a restart-safe link and refreshes the lock offline', (t) => {
  const root = tempRoot(t, 'dsh-install-pin-')
  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'fresh')
  const sourceRoot = path.join(root, 'source checkout')
  const pkgPath = path.join(profileDir, 'package.json')
  fs.mkdirSync(sourceRoot, { recursive: true })
  writeJson(pkgPath, {
    dependencies: { untouched: '1.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: '', stderr: '' }
  }
  const outcome = pinProfileDependency({
    profile: 'fresh',
    sourceRoot,
    dshHome,
    spawn,
  })
  assert.equal(outcome.pinned, true)
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.equal(pkg.dependencies.untouched, '1.0.0')
  assert.equal(pkg.dependencies[PKG_NAME], sourceLinkSpec(sourceRoot))
  assert.deepEqual(calls[0].args.slice(-2), ['install', '--offline'])

  const profileRequire = createRequire(pkgPath)
  assert.throws(() => profileRequire.resolve(PKG_NAME), /Cannot find/)
})

test('source pin refuses a link that points at the profile package target', (t) => {
  const root = tempRoot(t, 'dsh-install-self-')
  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'fresh')
  const pkgPath = path.join(profileDir, 'package.json')
  writeJson(pkgPath, { dependencies: {} })
  const target = path.join(profileDir, 'node_modules', PKG_NAME)
  const outcome = pinProfileDependency({
    profile: 'fresh',
    sourceRoot: target,
    dshHome,
    spawn: () => {
      throw new Error('spawn must not run')
    },
  })
  assert.deepEqual(outcome, { pinned: false, reason: 'source-is-target' })
  assert.deepEqual(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies, {})
})

test('uninstall-style removal unlinks a source target and never deletes the checkout', (t) => {
  const root = tempRoot(t, 'dsh-install-unlink-')
  const sourceRoot = path.join(root, 'source')
  const target = path.join(root, 'profile', 'node_modules', PKG_NAME)
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{}\n')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.symlinkSync(sourceRoot, target, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('creating directory links requires additional privilege on this platform')
      return
    }
    throw error
  }
  const removed = removeInstalledPackage(target, sourceRoot)
  assert.equal(removed.removed, true)
  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.existsSync(path.join(sourceRoot, 'package.json')), true)

  const protectedSource = removeInstalledPackage(sourceRoot, sourceRoot)
  assert.deepEqual(protectedSource, { removed: false, reason: 'source-is-target' })
  assert.equal(fs.existsSync(path.join(sourceRoot, 'package.json')), true)
})

test('a dangling source junction is detected with lstat and can be replaced safely', (t) => {
  const root = tempRoot(t, 'dsh-install-dangling-')
  const sourceRoot = path.join(root, 'source')
  const movedSource = path.join(root, 'source-moved')
  const target = path.join(root, 'profile', 'node_modules', PKG_NAME)
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{}\n')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.symlinkSync(sourceRoot, target, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('creating directory links requires additional privilege on this platform')
      return
    }
    throw error
  }
  fs.renameSync(sourceRoot, movedSource)
  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true)
  const removed = removeInstalledPackage(target, sourceRoot)
  assert.deepEqual(removed, { removed: true, reason: 'link' })
  assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' })
  assert.equal(fs.existsSync(path.join(movedSource, 'package.json')), true)
  fs.symlinkSync(movedSource, target, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(fs.existsSync(path.join(target, 'package.json')), true)
})

test('a truly fresh profile installs and a new process imports the package entry', (t) => {
  const root = tempRoot(t, 'dsh-install-truly-fresh-')
  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'fresh')
  const pkgPath = path.join(profileDir, 'package.json')
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  writeJson(pkgPath, {
    name: 'fresh-profile',
    private: true,
    dsh: { profile: { bundles: ['base', 'other-plugin'] } },
  })

  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'bin', 'install.mjs'),
    '--profile',
    'fresh',
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: dshHome, DSH_PROFILE: 'fresh' },
    encoding: 'utf8',
    stdio: 'pipe',
  })

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const oldNames = ['dsh-weixin', 'dsh-plugin-weixin']
  assert.deepEqual(Object.keys(pkg.dependencies), [PKG_NAME])
  assert.equal(pkg.dependencies[PKG_NAME], sourceLinkSpec(REPO_ROOT))
  assert.equal(pkg.dsh.profile.bundles.includes(PKG_NAME), true)
  for (const oldName of oldNames) {
    assert.equal(pkg.dsh.profile.bundles.includes(oldName), false)
    assert.equal(Object.hasOwn(pkg.dependencies, oldName), false)
  }
  assert.equal(fs.existsSync(patchPath), false)

  const importedEntry = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "const entry = await import('dsh-plugin-wechat'); " +
      "if (entry.name !== 'dsh-weixin' || typeof entry.apply !== 'function') process.exit(3); " +
      "console.log(import.meta.resolve('dsh-plugin-wechat'))",
  ], {
    cwd: profileDir,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()
  assert.match(importedEntry, /src[\\/]index\.js$/)
})

test('fresh temp profile installs, resolves, survives a second install, and uninstalls safely', (t) => {
  const root = tempRoot(t, 'dsh-install-profile-')
  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'fresh')
  const pkgPath = path.join(profileDir, 'package.json')
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const settingsPath = path.join(dshHome, 'weixin', 'config.json')
  writeJson(pkgPath, {
    name: 'fresh-profile',
    private: true,
    dependencies: {
      untouched: '1.0.0',
    },
    devDependencies: { [PKG_NAME]: '^0.0.1' },
    dsh: { profile: { bundles: ['base', 'other-plugin'] } },
  })
  fs.writeFileSync(patchPath, [
    '- insert:',
    '    - id: other-before',
    '      enabled: true',
    '- insert:',
    '    - id: other-after',
    '      options:',
    '        keep: true',
    '',
  ].join('\n'))

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, '{invalid-settings-preserved')

  const run = (extraArgs = [], extraEnv = {}) => execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'bin', 'install.mjs'),
    '--profile',
    'fresh',
    ...extraArgs,
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: dshHome, DSH_PROFILE: 'fresh', ...extraEnv },
    encoding: 'utf8',
    stdio: 'pipe',
  })

  const originalPatchText = fs.readFileSync(patchPath, 'utf8')
  const firstOutput = run()
  assert.match(firstOutput, /linked package/)
  assert.match(firstOutput, /完整退出并重新打开 DSH/)
  assert.match(firstOutput, /「大肥鱼」→「微信账号」→「扫码登录微信」/)
  assert.match(firstOutput, /English: Fully quit and reopen DSH/)
  assert.match(firstOutput, /wechat account → Scan QR code to log in/i)
  assert.doesNotMatch(firstOutput, /bin[\\/]login\.js/)
  assert.match(firstOutput, /设置保存在 .*weixin[\\/]config\.json；重装不会删除已有登录信息和设置/)
  assert.match(firstOutput, /English: Settings are stored in .*weixin[\\/]config\.json; reinstalling does not remove existing sign-in data or settings/)
  assert.doesNotMatch(firstOutput, /登录信息和设置保存在/)
  const target = path.join(profileDir, 'node_modules', PKG_NAME)
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true)
  assert.equal(fs.existsSync(path.join(target, 'locale', 'en.json')), true)
  assert.equal(fs.existsSync(path.join(target, 'locale', 'zh.json')), true)
  assert.equal(fs.existsSync(path.join(target, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json')), true)
  assert.equal(fs.existsSync(path.join(target, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'package.json')), true)

  const firstPkgText = fs.readFileSync(pkgPath, 'utf8')
  const firstPatchText = fs.readFileSync(patchPath, 'utf8')
  assert.equal(firstPatchText, originalPatchText)
  const firstSettingsText = fs.readFileSync(settingsPath, 'utf8')
  const firstPkg = JSON.parse(firstPkgText)
  assert.equal(firstPkg.dependencies[PKG_NAME], sourceLinkSpec(REPO_ROOT))
  assert.equal(firstPkg.dependencies.untouched, '1.0.0')
  assert.equal(Object.hasOwn(firstPkg.devDependencies, PKG_NAME), false)
  assert.equal(firstPkg.dsh.profile.bundles.filter((name) => name === PKG_NAME).length, 1)
  assert.match(firstPatchText, /other-before/)
  assert.match(firstPatchText, /other-after/)
  assert.doesNotMatch(firstPatchText, /dsh-weixin/)
  assert.equal(firstSettingsText, '{invalid-settings-preserved')
  assert.match(createRequire(pkgPath).resolve(PKG_NAME), /src[\\/]index\.js$/)

  // Simulate the profile's next start: node_modules may be recreated, but the
  // persisted link spec must resolve the same checkout without npm or network.
  fs.unlinkSync(target)
  assert.throws(() => createRequire(pkgPath).resolve(PKG_NAME), /Cannot find/)
  const persistedSource = firstPkg.dependencies[PKG_NAME].slice('link:'.length)
  fs.symlinkSync(persistedSource, target, process.platform === 'win32' ? 'junction' : 'dir')
  assert.match(createRequire(pkgPath).resolve(PKG_NAME), /src[\\/]index\.js$/)

  run()
  assert.equal(fs.readFileSync(pkgPath, 'utf8'), firstPkgText)
  assert.equal(fs.readFileSync(patchPath, 'utf8'), firstPatchText)
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), firstSettingsText)
  assert.match(createRequire(pkgPath).resolve(PKG_NAME), /src[\\/]index\.js$/)

  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'bin', 'install.mjs'),
    '--profile',
    'fresh',
    '--uninstall',
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    stdio: 'pipe',
  })
  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'package.json')), true)
  const finalPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.equal(Object.hasOwn(finalPkg.dependencies ?? {}, PKG_NAME), false)
  assert.equal(finalPkg.dsh.profile.bundles.includes(PKG_NAME), false)
  assert.match(fs.readFileSync(patchPath, 'utf8'), /other-before[\s\S]*other-after/)
})

