import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ONBOARDING_STEPS,
  buildOnboardingChecklist,
  describeNextStep,
  describeOnboardingProgress,
  quickstartLines,
} from '../src/onboarding.js'

function step(checklist, id) {
  return checklist.steps.find((entry) => entry.id === id)
}

test('first-run checklist covers binding, authorization and operational reminders only', () => {
  assert.deepEqual(ONBOARDING_STEPS, ['account', 'allowlist', 'workspace', 'verify', 'host', 'backup'])

  const checklist = buildOnboardingChecklist()
  assert.deepEqual(checklist.steps.map((entry) => entry.id), ONBOARDING_STEPS)
  assert.doesNotMatch(JSON.stringify(checklist), /personaDefaultMode|proactiveEnabled|knowledgeEnabled/i)
  assert.equal(step(checklist, 'backup').id, 'backup')
  assert.equal(step(checklist, 'verify').state, 'note')
})

test('credential-backed account plus automatic first-contact allowlist completes local prerequisites', () => {
  const checklist = buildOnboardingChecklist({
    accounts: [{ accountId: 'synthetic-account', allowedSenders: ['synthetic-owner'] }],
    accountCount: 1,
  })

  assert.equal(step(checklist, 'account').state, 'done')
  assert.equal(step(checklist, 'allowlist').state, 'done')
  assert.match(step(checklist, 'allowlist').detail, /单独的联系人名单/)
  assert.match(step(checklist, 'allowlist').detailEn, /overrides the global list/)
  assert.equal(checklist.complete, true)
  assert.equal(step(checklist, 'verify').state, 'note')
  assert.match(describeOnboardingProgress(checklist), /还需实际收发验证/)
  assert.match(describeNextStep(checklist), /用手机确认能收发消息/)
})

test('an account without any effective allowlist keeps authorization required', () => {
  const checklist = buildOnboardingChecklist({
    accounts: [{ accountId: 'synthetic-account', allowedSenders: [] }],
    accountCount: 1,
  })

  assert.equal(step(checklist, 'account').state, 'done')
  assert.equal(step(checklist, 'allowlist').state, 'todo')
  assert.equal(checklist.complete, false)
  assert.match(describeNextStep(checklist), /选择谁能和助理对话/)
  assert.match(step(checklist, 'allowlist').detail, /首位联系人/)
  assert.match(step(checklist, 'allowlist').detail, /不能证明发送者就是扫码人/)
  assert.match(step(checklist, 'allowlist').why, /助理在这台电脑上读取或修改文件、执行命令/)
  assert.doesNotMatch(step(checklist, 'allowlist').why, /DSH Agent/)

  const blocked = buildOnboardingChecklist()
  assert.equal(step(blocked, 'allowlist').state, 'blocked')
})

test('a global allowlist does not imply every account uses it', () => {
  const checklist = buildOnboardingChecklist({
    accountCount: 1,
    allowedSenders: ['synthetic-owner'],
  })
  const allowlist = step(checklist, 'allowlist')

  assert.match(allowlist.detail, /账号级名单可能覆盖全局名单/)
  assert.match(allowlist.detail, /以每个账号的实际设置为准/)
  assert.match(allowlist.detailEn, /Account-level lists may override it/)
  assert.doesNotMatch(allowlist.detail, /所有联系人.*获准/)
})

test('saved credentials are reported as saved sign-in data rather than verified accounts', () => {
  const account = step(buildOnboardingChecklist({ accountCount: 2 }), 'account')
  assert.match(account.detail, /保存了微信登录信息/)
  assert.doesNotMatch(account.detail, /可用/)
})

test('unknown or untested host stays a note and is never reported as verified', () => {
  for (const input of [
    { hostVersion: undefined, hostTested: true },
    { hostVersion: '0.0.0-unknown', hostTested: false },
    { hostVersion: '0.0.0-unknown', hostTested: undefined },
  ]) {
    const host = step(buildOnboardingChecklist(input), 'host')
    assert.equal(host.state, 'note')
    assert.doesNotMatch(host.detail, /已在测试列表|已验证|compatibility\.md/)
  }

  const tested = step(buildOnboardingChecklist({ hostVersion: '0.2.1-rc.5', hostTested: true }), 'host')
  assert.equal(tested.state, 'done')
  assert.match(tested.detail, /在已验证范围内/)
})

test('working-directory reminder only completes when the directory was checked successfully', () => {
  const unknown = step(buildOnboardingChecklist({ workingDirectory: 'D:\\Projects\\demo' }), 'workspace')
  assert.equal(unknown.state, 'note')
  assert.match(unknown.detail, /这次没有确认/)

  const missing = step(buildOnboardingChecklist({ workingDirectory: 'D:\\Projects\\missing', workingDirectoryExists: false }), 'workspace')
  assert.equal(missing.state, 'note')

  const ready = step(buildOnboardingChecklist({ workingDirectory: 'D:\\Projects\\demo', workingDirectoryExists: true }), 'workspace')
  assert.equal(ready.state, 'done')
})

test('quickstart installs this checkout without an upstream or published-package step', () => {
  const lines = quickstartLines({ loginHint: 'node bin/login.js' })
  assert.match(lines[0].command, /node bin\/install\.mjs/)
  assert.notEqual(lines[0].command, 'npm install dsh-plugin-wechat && node bin/doctor.mjs')
  assert.match(lines[2].note, /实际收发/)
})

test('the default login step points to the DSH WeChat panel instead of the CLI', () => {
  const lines = quickstartLines()
  assert.match(lines[1].command, /大肥鱼/)
  assert.doesNotMatch(lines[1].command, /bin\/login\.js/)
})

test('quickstart prose follows the requested locale', () => {
  const english = quickstartLines({ locale: 'en' })
  assert.match(english[0].note, /Install this checkout/)
  assert.match(english[1].note, /Whichever contact arrives first is enrolled/)
  assert.match(english[1].note, /does not prove that sender is the person who scanned the code/)
  assert.match(english[2].note, /send a real message from your phone/)
  const chinese = quickstartLines()
  assert.match(chinese[1].note, /实际收到的首位联系人/)
  assert.match(chinese[1].note, /不能证明发送者就是扫码人/)
})

test('backup copy states scope and does not claim verification from the enabled switch', () => {
  const enabled = step(buildOnboardingChecklist({ backupEnabled: true }), 'backup')
  assert.match(enabled.detail, /只确认开关状态/)
  assert.match(enabled.detail, /不代表最近一份备份已经验证/)
  assert.match(enabled.why, /媒体、日志|备份范围和完整性/)

  const unknown = step(buildOnboardingChecklist(), 'backup')
  assert.match(unknown.detail, /还没有确认自动备份已经开启/)
  assert.match(unknown.detail, /不包含媒体、日志和下载的语音模型/)
  assert.match(unknown.whyEn, /coverage and integrity/)
})
