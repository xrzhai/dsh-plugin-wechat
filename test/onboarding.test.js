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
  assert.doesNotMatch(JSON.stringify(checklist), /persona|proactive|knowledge/i)
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
  assert.match(step(checklist, 'allowlist').detail, /首位联系人自动登记/)
  assert.equal(checklist.complete, true)
  assert.equal(step(checklist, 'verify').state, 'note')
  assert.match(describeOnboardingProgress(checklist), /还需实际收发验证/)
  assert.match(describeNextStep(checklist), /真实收发验证/)
})

test('an account without any effective allowlist keeps authorization required', () => {
  const checklist = buildOnboardingChecklist({
    accounts: [{ accountId: 'synthetic-account', allowedSenders: [] }],
    accountCount: 1,
  })

  assert.equal(step(checklist, 'account').state, 'done')
  assert.equal(step(checklist, 'allowlist').state, 'todo')
  assert.equal(checklist.complete, false)
  assert.match(describeNextStep(checklist), /下发工程任务/)

  const blocked = buildOnboardingChecklist()
  assert.equal(step(blocked, 'allowlist').state, 'blocked')
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
  assert.match(tested.detail, /已在测试列表/)
})

test('working-directory reminder only completes when the directory was checked successfully', () => {
  const unknown = step(buildOnboardingChecklist({ workingDirectory: 'D:\\Projects\\demo' }), 'workspace')
  assert.equal(unknown.state, 'note')
  assert.match(unknown.detail, /未能确认/)

  const missing = step(buildOnboardingChecklist({ workingDirectory: 'D:\\Projects\\missing', workingDirectoryExists: false }), 'workspace')
  assert.equal(missing.state, 'note')

  const ready = step(buildOnboardingChecklist({ workingDirectory: 'D:\\Projects\\demo', workingDirectoryExists: true }), 'workspace')
  assert.equal(ready.state, 'done')
})

test('quickstart installs this checkout without an upstream or published-package step', () => {
  const lines = quickstartLines({ loginHint: 'node bin/login.js' })
  assert.match(lines[0].command, /node bin\/install\.mjs/)
  assert.notEqual(lines[0].command, 'npm install dsh-plugin-wechat && node bin/doctor.mjs')
  assert.match(lines[2].note, /真实收发/)
})
