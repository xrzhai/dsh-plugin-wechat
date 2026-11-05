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
  assert.match(result.output, /还没有可用的账号凭据/)
  assert.match(result.output, /只有账号登记记录不算已登录/)
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
  assert.match(result.output, /已找到 1 个带凭据文件的账号/)
  assert.match(result.output, /账号级白名单已包含首位联系人自动登记/)
  assert.match(result.output, /工作目录可用/)
  assert.match(result.output, /下一步：完成一次真实收发验证/)
  assert.match(result.output, /未检测到明确的宿主版本/)
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
