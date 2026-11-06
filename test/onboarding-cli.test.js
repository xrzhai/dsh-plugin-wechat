import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')

function tempState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-onboarding-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = path.join(root, 'state')
  const home = path.join(root, 'home')
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  return { root, state, home }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeCredential(state, accountId, token = 'synthetic-token') {
  writeJson(path.join(state, 'openclaw-weixin', 'accounts', `${accountId}.json`), {
    token,
    savedAt: '2026-11-05T00:00:00.000Z',
  })
}

function run(script, fixture, args = []) {
  const isolatedHome = fixture.home
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      DSH_HOME: path.join(fixture.root, '.dsh'),
      DSH_PROFILE: 'onboarding-test',
      DSH_WEIXIN_STATE_DIR: fixture.state,
      OPENCLAW_STATE_DIR: fixture.state,
      CLAWDBOT_STATE_DIR: fixture.state,
      DSH_HOST_VERSION: '',
      DSH_HOST_PLIST: path.join(fixture.root, 'missing-Info.plist'),
    },
  })
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('onboard does not treat a registry-only record as a signed-in account', (t) => {
  const fixture = tempState(t)
  writeJson(path.join(fixture.state, 'accounts-registry.json'), {
    schemaVersion: 1,
    'registry-only': {
      allowedSenders: ['stale-owner'],
      firstContactEnrolledAt: '2026-11-05T00:00:00.000Z',
    },
  })

  const result = run('bin/onboard.mjs', fixture)
  assert.equal(result.status, 1)
  assert.match(result.output, /尚未登录微信/)
  assert.match(result.output, /绑定微信账号/)
  assert.doesNotMatch(result.output, /已找到 1 个带凭据文件的账号/)
})

test('onboard uses a credential file and account-level first-contact allowlist without optional product setup', (t) => {
  const fixture = tempState(t)
  const workspace = path.join(fixture.root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  writeCredential(fixture.state, 'synthetic-account')
  writeJson(path.join(fixture.state, 'accounts-registry.json'), {
    schemaVersion: 1,
    'synthetic-account': {
      allowedSenders: ['synthetic-owner'],
      firstContactEnrolledAt: '2026-11-05T00:00:00.000Z',
    },
  })
  writeJson(path.join(fixture.state, 'config.json'), {
    cwd: workspace,
    backupEnabled: true,
  })

  const result = run('bin/onboard.mjs', fixture)
  assert.equal(result.status, 0)
  assert.match(result.output, /已检测到 1 个保存了微信登录信息的账号/)
  assert.match(result.output, /单独的联系人名单/)
  assert.match(result.output, /助理会在这里工作/)
  assert.match(result.output, /下一步：用手机确认能收发消息/)
  assert.match(result.output, /没有识别到 DSH 版本/)
  assert.doesNotMatch(result.output, /选一个说话的样子|主动开口|知识库|compatibility\.md/)
  assert.doesNotMatch(result.output, /已在测试列表|已验证过/)
})

test('doctor derives the Node minimum from package.json and counts first-contact account authorization offline', (t) => {
  const fixture = tempState(t)
  writeCredential(fixture.state, 'synthetic-account')
  writeJson(path.join(fixture.state, 'accounts-registry.json'), {
    schemaVersion: 1,
    'synthetic-account': {
      allowedSenders: ['synthetic-owner'],
      firstContactEnrolledAt: '2026-11-05T00:00:00.000Z',
    },
  })

  const result = run('bin/doctor.mjs', fixture, ['--offline'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /node .*meets package\.json engines\.node >=22\.13\.0/)
  assert.match(result.output, /allowed senders\s+authorized for 1 signed-in account\(s\); account-level lists are in use/)
  assert.doesNotMatch(result.output, /allowed senders\s+.*empty/)
  assert.match(result.output, /published version\s+skipped \(--offline\)/)
})

test('doctor does not let a registry-only allowlist authorize a missing credential', (t) => {
  const fixture = tempState(t)
  writeJson(path.join(fixture.state, 'accounts-registry.json'), {
    schemaVersion: 1,
    'registry-only': {
      allowedSenders: ['stale-owner'],
      firstContactEnrolledAt: '2026-11-05T00:00:00.000Z',
    },
  })

  const result = run('bin/doctor.mjs', fixture, ['--offline'])
  assert.equal(result.status, 1)
  assert.match(result.output, /allowed senders\s+no signed-in account/)
  assert.doesNotMatch(result.output, /allowed senders\s+authorized/)
})

test('doctor dry-run and fix create active directories without creating or replacing legacy data', (t) => {
  const fixture = tempState(t)
  writeCredential(fixture.state, 'synthetic-account')
  writeJson(path.join(fixture.state, 'accounts-registry.json'), {
    schemaVersion: 1,
    'synthetic-account': { allowedSenders: ['synthetic-owner'] },
  })

  const dryRun = run('bin/doctor.mjs', fixture, ['--offline', '--dry-run'])
  assert.equal(dryRun.status, 0, dryRun.output)
  assert.match(dryRun.output, /created sessions\//)
  assert.doesNotMatch(dryRun.output, /created knowledge\//)
  assert.equal(fs.existsSync(path.join(fixture.state, 'sessions')), false)
  assert.equal(fs.existsSync(path.join(fixture.state, 'knowledge')), false)
  assert.equal(fs.existsSync(path.join(fixture.state, 'memory')), false)

  const fixed = run('bin/doctor.mjs', fixture, ['--offline', '--fix'])
  assert.equal(fixed.status, 0, fixed.output)
  assert.equal(fs.statSync(path.join(fixture.state, 'sessions')).isDirectory(), true)
  assert.equal(fs.existsSync(path.join(fixture.state, 'knowledge')), false)
  assert.equal(fs.existsSync(path.join(fixture.state, 'memory')), false)
  assert.equal(fs.existsSync(path.join(fixture.state, 'backups')), false)
  assert.equal(fs.existsSync(path.join(fixture.state, 'journal')), false)
  assert.equal(fs.existsSync(path.join(fixture.state, 'audit')), false)

  const persona = path.join(fixture.state, 'sessions', 'AGENTS.md')
  const memory = path.join(fixture.state, 'sessions', 'memory.md')
  const legacy = path.join(fixture.state, 'memory', 'legacy.json')
  fs.writeFileSync(persona, 'CUSTOM PERSONA')
  fs.writeFileSync(memory, 'CUSTOM MEMORY')
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  fs.writeFileSync(legacy, '{"keep":true}\n')
  const oldTemp = path.join(fixture.state, 'old.tmp')
  const malformed = path.join(fixture.state, 'historical.json')
  fs.writeFileSync(oldTemp, 'HISTORICAL TEMP')
  fs.utimesSync(oldTemp, new Date(0), new Date(0))
  fs.writeFileSync(malformed, '{broken')

  const repeated = run('bin/doctor.mjs', fixture, ['--offline', '--fix'])
  assert.equal(repeated.status, 0, repeated.output)
  assert.equal(fs.readFileSync(persona, 'utf8'), 'CUSTOM PERSONA')
  assert.equal(fs.readFileSync(memory, 'utf8'), 'CUSTOM MEMORY')
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{"keep":true}\n')
  assert.equal(fs.readFileSync(oldTemp, 'utf8'), 'HISTORICAL TEMP')
  assert.equal(fs.readFileSync(malformed, 'utf8'), '{broken')
  assert.deepEqual(fs.readdirSync(fixture.state).filter((name) => name.startsWith('historical.json')), ['historical.json'])
  assert.doesNotMatch(repeated.output, /voice transcription|audit chain|backups/)
})
