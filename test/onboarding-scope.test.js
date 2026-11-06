import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('onboarding CLI uses only retained setup steps and leaves synthetic state unchanged', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-onboarding-scope-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = path.join(root, 'state')
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const accounts = path.join(state, 'openclaw-weixin', 'accounts')
  for (const dir of [home, project, accounts]) fs.mkdirSync(dir, { recursive: true })
  const files = [
    [path.join(accounts, 'synthetic-account.json'), JSON.stringify({ token: 'synthetic-token' })],
    [path.join(state, 'accounts-registry.json'), JSON.stringify({ 'synthetic-account': { allowedSenders: ['synthetic-contact'] } })],
    [path.join(state, 'config.json'), JSON.stringify({ cwd: project, backupEnabled: true, asr: { enabled: true } })],
  ]
  for (const [file, content] of files) fs.writeFileSync(file, content)

  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'onboard.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home, DSH_HOME: path.join(root, 'dsh'),
      DSH_WEIXIN_STATE_DIR: state, OPENCLAW_STATE_DIR: state, CLAWDBOT_STATE_DIR: state,
      DSH_HOST_VERSION: '9.9.9-synthetic', DSH_HOST_PLIST: path.join(root, 'missing.plist'),
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /绑定微信账号/)
  assert.match(result.stdout, /选择谁能和助理对话/)
  assert.match(result.stdout, /助理会在这里工作/)
  assert.match(result.stdout, /下一步：用手机确认能收发消息/)
  assert.match(result.stdout, /检测到 DSH 9\.9\.9-synthetic，但还没有验证过/)
  assert.doesNotMatch(result.stdout, /没有识别到 DSH 版本|备份|语音模型|ASR|定时提醒/)
  for (const [file, content] of files) assert.equal(fs.readFileSync(file, 'utf8'), content)
  assert.deepEqual(fs.readdirSync(state).sort(), ['accounts-registry.json', 'config.json', 'openclaw-weixin'])
})
