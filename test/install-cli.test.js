import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.mjs')

function tempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-install-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const home = path.join(root, 'home')
  const dshHome = path.join(home, '.dsh')
  fs.mkdirSync(home, { recursive: true })

  return {
    root,
    home,
    dshHome,
    env: isolatedEnv(home, dshHome),
  }
}

function isolatedEnv(home, dshHome) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome }
  delete env.DSH_PROFILE
  return env
}

function runInstaller(fixture, args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: REPO_ROOT,
    env: fixture.env,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function snapshotTree(root) {
  const entries = []
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const relative = path.relative(root, file).replaceAll('\\', '/')
      const stat = fs.lstatSync(file)
      if (stat.isDirectory()) {
        entries.push([relative, 'directory'])
        visit(file)
      } else if (stat.isSymbolicLink()) {
        entries.push([relative, 'link', fs.readlinkSync(file)])
      } else {
        entries.push([relative, 'file', fs.readFileSync(file).toString('base64')])
      }
    }
  }
  visit(root)
  return entries
}

for (const helpFlag of ['-h', '--help']) {
  test(`${helpFlag} prints usage without creating or reading a profile`, (t) => {
    const fixture = tempFixture(t)
    const result = runInstaller(fixture, [helpFlag])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^Usage: node bin\/install\.mjs \[options\]/m)
    assert.match(result.stdout, /-h, --help/)
    assert.equal(result.stderr, '')
    assert.equal(fs.existsSync(fixture.dshHome), false)
  })
}

const invalidInvocations = [
  { name: 'unknown long option', args: ['--bogus'], error: /unknown option --bogus/ },
  { name: 'unknown short option', args: ['-x'], error: /unknown option -x/ },
  { name: 'unknown option beside help', args: ['--help', '--bogus'], error: /unknown option --bogus/ },
  { name: 'missing profile value', args: ['--profile'], error: /--profile requires a value/ },
  { name: 'profile value that is another option', args: ['--profile', '--pin'], error: /--profile requires a value/ },
  { name: 'empty profile value', args: ['--profile='], error: /invalid profile name/ },
  { name: 'path-like profile value', args: ['--profile=../outside'], error: /invalid profile name/ },
  { name: 'duplicate profile values', args: ['--profile=desktop', '--profile=fresh'], error: /--profile may only be specified once/ },
  { name: 'positional argument', args: ['desktop'], error: /unexpected argument "desktop"/ },
]

for (const invocation of invalidInvocations) {
  test(`${invocation.name} fails before touching the profile`, (t) => {
    const fixture = tempFixture(t)
    const result = runInstaller(fixture, invocation.args)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, invocation.error)
    assert.match(result.stderr, /Try --help for usage/)
    assert.equal(result.stdout, '')
    assert.equal(fs.existsSync(fixture.dshHome), false)
  })
}

test('invalid DSH_PROFILE fails before touching the profile', (t) => {
  const fixture = tempFixture(t)
  fixture.env.DSH_PROFILE = 'bad/name'
  const result = runInstaller(fixture, [])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /invalid profile name/)
  assert.equal(result.stdout, '')
  assert.equal(fs.existsSync(fixture.dshHome), false)
})

for (const mode of ['install', 'uninstall']) {
  test(`${mode} dry-run prints a plan and leaves every fixture byte unchanged`, (t) => {
    const fixture = tempFixture(t)
    const profileDir = path.join(fixture.dshHome, 'profiles', 'safe')
    writeJson(path.join(profileDir, 'package.json'), {
      name: 'safe-profile',
      private: true,
      dependencies: { untouched: '1.0.0' },
      dsh: { profile: { bundles: ['base', 'dsh-weixin', 'other-plugin'] } },
    })
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: dsh-weixin',
      '      enabled: true',
      '',
    ].join('\n'))
    writeJson(path.join(fixture.dshHome, 'weixin', 'config.json'), {
      allowedSenders: ['owner'],
    })

    const args = ['--profile', 'safe', '--dry-run']
    if (mode === 'uninstall') args.push('--uninstall')
    const before = snapshotTree(fixture.dshHome)
    const result = runInstaller(fixture, args)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /dry run: no files will be changed/)
    assert.match(result.stdout, /profile: .*profiles[\\/]safe/)
    if (mode === 'install') {
      assert.match(result.stdout, /would link /)
      assert.match(result.stdout, /would register dependency /)
      assert.match(result.stdout, /old mount rows to remove: 1/)
    } else {
      assert.match(result.stdout, /would remove package link and plugin registrations/)
    }
    assert.deepEqual(snapshotTree(fixture.dshHome), before)
  })
}
