import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { manifestVersionProblems } from '../bin/release.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const RELEASE_CLI = path.join(REPO_ROOT, 'bin', 'release.mjs')
const PKG_NAME = 'dsh-plugin-wechat'
const CURRENT_VERSION = '1.6.2'
const NEXT_VERSION = '9.9.9'
const LOCKFILE = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '  excludeLinksFromLockfile: false',
  '',
  'importers:',
  '',
  '  .: {}',
  '',
].join('\n')

function tempBase(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return base
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeExecutable(file, text) {
  fs.writeFileSync(file, text)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755)
}

function isolatedEnv(base) {
  const home = path.join(base, 'home')
  const config = path.join(base, 'config')
  const npmrc = path.join(config, 'empty.npmrc')
  const globalNpmrc = path.join(config, 'empty-global.npmrc')
  const gitconfig = path.join(config, 'empty.gitconfig')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(npmrc, '')
  fs.writeFileSync(globalNpmrc, '')
  fs.writeFileSync(gitconfig, '')

  const env = {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PNPM_HOME: path.join(home, 'pnpm'),
    COREPACK_HOME: path.join(home, 'corepack'),
    TEMP: path.join(home, 'tmp'),
    TMP: path.join(home, 'tmp'),
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalNpmrc,
    npm_config_cache: path.join(home, '.npm'),
    npm_config_store_dir: path.join(home, 'pnpm-store'),
    npm_config_state_dir: path.join(home, 'pnpm-state'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_SYSTEM: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release Fixture',
    GIT_AUTHOR_EMAIL: 'release-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Release Fixture',
    GIT_COMMITTER_EMAIL: 'release-fixture@example.invalid',
    CI: 'true',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
  fs.mkdirSync(env.TEMP, { recursive: true })
  if (process.platform === 'win32') {
    env.ComSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
    env.PATHEXT = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
    env.SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  }
  return env
}

function toolAvailable(command, env = process.env) {
  const throughCmd = process.platform === 'win32' && (command === 'npm' || command === 'pnpm')
  const file = throughCmd ? env.ComSpec ?? 'cmd.exe' : command
  const args = throughCmd ? ['/d', '/s', '/c', `${command}.cmd`, '--version'] : ['--version']
  const result = spawnSync(file, args, { env, stdio: 'ignore', windowsHide: true })
  return result.error === undefined && result.status === 0
}

function snapshotTree(root) {
  const entries = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: 'dir' })
        walk(full)
      } else if (entry.isFile()) {
        entries.push({
          path: relative,
          type: 'file',
          mode: fs.statSync(full).mode & 0o777,
          hash: createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        })
      } else {
        entries.push({ path: relative, type: 'other' })
      }
    }
  }
  walk(root)
  return entries
}

function lockFixture(t, { lock = true, dependency } = {}) {
  const base = tempBase(t, 'release-lock-fixture-')
  const root = path.join(base, 'project')
  const pkg = { name: 'release-lock-fixture', version: '1.2.3' }
  if (dependency !== undefined) pkg.dependencies = { [dependency]: '1.0.0' }
  fs.mkdirSync(root, { recursive: true })
  writeJson(path.join(root, 'package.json'), pkg)
  if (lock) fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), LOCKFILE)
  return { root, env: isolatedEnv(base) }
}

const lockCheckSkip = toolAvailable('pnpm') ? false : 'pnpm is required for a real frozen-lockfile check'

test('manifestVersionProblems accepts a current pnpm lock without changing fixture files', { skip: lockCheckSkip }, (t) => {
  const fixture = lockFixture(t)
  const before = snapshotTree(fixture.root)

  const result = manifestVersionProblems(fixture.root, { env: fixture.env })

  assert.deepEqual(result, { pkgVersion: '1.2.3', problems: [] })
  assert.deepEqual(snapshotTree(fixture.root), before)
})

test('manifestVersionProblems reports a stale pnpm lock without changing fixture files', { skip: lockCheckSkip }, (t) => {
  const fixture = lockFixture(t, { dependency: 'fixture-only-dependency' })
  const before = snapshotTree(fixture.root)

  const result = manifestVersionProblems(fixture.root, { env: fixture.env })

  assert.equal(result.pkgVersion, '1.2.3')
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0], /pnpm-lock\.yaml is stale or invalid/)
  assert.match(result.problems[0], /fixture-only-dependency/)
  assert.deepEqual(snapshotTree(fixture.root), before)
})

test('manifestVersionProblems reports a missing pnpm lock without changing fixture files', (t) => {
  const fixture = lockFixture(t, { lock: false })
  const before = snapshotTree(fixture.root)

  const result = manifestVersionProblems(fixture.root, { env: fixture.env })

  assert.deepEqual(result, { pkgVersion: '1.2.3', problems: ['pnpm-lock.yaml is missing'] })
  assert.deepEqual(snapshotTree(fixture.root), before)
})

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((candidate) => candidate !== undefined && candidate.endsWith('.js') && fs.existsSync(candidate))
}

function installNpmAndGhFixtures(binDir, env, npmCli) {
  const npmWrapper = path.join(binDir, 'fixture-npm.mjs')
  fs.writeFileSync(npmWrapper, `
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'whoami') {
  process.stdout.write('fixture-user\\n')
  process.exit(0)
}
if (args[0] === 'view' && args[1] === '${PKG_NAME}' && args[2] === 'versions') {
  process.stdout.write('[\\"${CURRENT_VERSION}\\"]\\n')
  process.exit(0)
}
const result = spawnSync(process.execPath, [process.env.FIXTURE_NPM_CLI, ...args], {
  env: process.env,
  stdio: 'inherit',
})
if (result.error) process.stderr.write(String(result.error) + '\\n')
process.exit(result.status ?? 1)
`)
  env.FIXTURE_NODE = process.execPath
  env.FIXTURE_NPM_WRAPPER = npmWrapper
  env.FIXTURE_NPM_CLI = npmCli

  if (process.platform === 'win32') {
    writeExecutable(path.join(binDir, 'npm.cmd'), '@echo off\r\n"%FIXTURE_NODE%" "%FIXTURE_NPM_WRAPPER%" %*\r\n')
    writeExecutable(path.join(binDir, 'gh.cmd'), '@echo off\r\nexit /b 1\r\n')
  } else {
    writeExecutable(path.join(binDir, 'npm'), '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_NPM_WRAPPER" "$@"\n')
    writeExecutable(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n')
  }
}

function git(cwd, env, args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`)
  return result.stdout
}

function releaseFixture(t, { omitIndex = false } = {}) {
  const npmCli = findNpmCli()
  const base = tempBase(t, 'release-dry-run-fixture-')
  const root = path.join(base, 'project')
  const binDir = path.join(base, 'bin')
  const sourceBin = path.join(REPO_ROOT, 'bin')
  fs.mkdirSync(path.join(root, 'bin', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  writeJson(path.join(root, 'package.json'), {
    name: PKG_NAME,
    version: CURRENT_VERSION,
    description: 'release dry-run fixture',
    type: 'module',
    license: 'MIT',
    scripts: { test: 'node -e "process.exit(0)"' },
    files: ['src', 'bin', 'cordis.patch.yml'],
  })
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), LOCKFILE)
  fs.writeFileSync(path.join(root, 'src', 'client.js'), `const PLUGIN_VERSION = "${CURRENT_VERSION}";\nexport {}\n`)
  if (!omitIndex) fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export {}\n')
  fs.writeFileSync(path.join(root, 'cordis.patch.yml'), '- insert:\n    - id: release-fixture\n')
  fs.writeFileSync(
    path.join(root, 'README.md'),
    `# Fixture\n\n当前已发布版本：[\`dsh-plugin-weixin@${CURRENT_VERSION}\`](https://www.npmjs.com/package/dsh-plugin-weixin)\n`,
  )
  fs.writeFileSync(
    path.join(root, 'README.en.md'),
    `# Fixture\n\nCurrently published version: [\`${PKG_NAME}@${CURRENT_VERSION}\`](https://www.npmjs.com/package/${PKG_NAME})\n`,
  )
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n- **${CURRENT_VERSION}** —— Fixture release.\n`)
  fs.copyFileSync(RELEASE_CLI, path.join(root, 'bin', 'release.mjs'))
  fs.copyFileSync(path.join(sourceBin, 'lib', 'profile-pin.mjs'), path.join(root, 'bin', 'lib', 'profile-pin.mjs'))
  fs.copyFileSync(path.join(sourceBin, 'lib', 'install-profile.mjs'), path.join(root, 'bin', 'lib', 'install-profile.mjs'))
  fs.writeFileSync(path.join(root, 'bin', 'install.mjs'), 'export {}\n')

  const env = isolatedEnv(base)
  if (npmCli !== undefined) installNpmAndGhFixtures(binDir, env, npmCli)
  env.PATH = `${binDir}${path.delimiter}${env.PATH}`

  git(root, env, ['init', '-q', '-b', 'main'])
  git(root, env, ['config', 'user.name', 'Release Fixture'])
  git(root, env, ['config', 'user.email', 'release-fixture@example.invalid'])
  git(root, env, ['add', '-A'])
  git(root, env, ['commit', '-q', '-m', 'fixture baseline'])
  git(root, env, ['tag', `v${CURRENT_VERSION}`])
  git(root, env, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return { root, env, npmCli }
}

const dryRunMissing = []
if (findNpmCli() === undefined) dryRunMissing.push('npm CLI')
for (const tool of ['pnpm', 'git', 'tar']) {
  if (!toolAvailable(tool)) dryRunMissing.push(tool)
}
const dryRunSkip = dryRunMissing.length > 0 ? `missing ${dryRunMissing.join(', ')}` : false

test('release dry-run checks the package without ASR and restores the fixture', { skip: dryRunSkip, timeout: 30_000 }, (t) => {
  const fixture = releaseFixture(t)
  const before = snapshotTree(fixture.root)
  const npmProbe = spawnSync(
    process.platform === 'win32' ? fixture.env.ComSpec : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', '--version'] : ['--version'],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8', windowsHide: true },
  )
  assert.equal(npmProbe.status, 0, `${npmProbe.stdout ?? ''}${npmProbe.stderr ?? ''}`)

  const result = spawnSync(process.execPath, [path.join(fixture.root, 'bin', 'release.mjs'), NEXT_VERSION, '--dry-run'], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 25_000,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  assert.equal(result.status, 0, output)
  assert.match(output, /Dry run for dsh-plugin-wechat@9\.9\.9 finished — tree unchanged\./)
  assert.match(output, /pnpm-lock\.yaml is current with package\.json 1\.6\.2/)
  assert.match(output, /package\.json 1\.6\.2 → 9\.9\.9/)
  assert.match(output, /client\.js PLUGIN_VERSION 1\.6\.2 → 9\.9\.9/)
  assert.match(output, /files, no dev artifacts/)
  assert.match(output, /every packaged file is world-readable/)
  assert.match(output, /tarball ready: dsh-plugin-wechat-9\.9\.9\.tgz/)
  assert.deepEqual(snapshotTree(fixture.root), before)
  assert.equal(git(fixture.root, fixture.env, ['status', '--porcelain']), '')
  assert.deepEqual(
    fs.readdirSync(fixture.root).filter((name) => name.endsWith('.tgz')),
    [],
  )
})

test('release dry-run rejects a package missing the entry point and restores the fixture', { skip: dryRunSkip, timeout: 30_000 }, (t) => {
  const fixture = releaseFixture(t, { omitIndex: true })
  const before = snapshotTree(fixture.root)
  const result = spawnSync(process.execPath, [path.join(fixture.root, 'bin', 'release.mjs'), NEXT_VERSION, '--dry-run'], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 25_000,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  assert.equal(result.status, 1, output)
  assert.match(output, /the tarball is missing package\/src\/index\.js/)
  assert.deepEqual(snapshotTree(fixture.root), before)
})
