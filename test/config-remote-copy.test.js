import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configFile, readSavedConfig } from '../src/state.js'
import { ConfigController, FIELDS } from '../src/config-remote.js'

const fields = new Map(FIELDS.flatMap((group) => group.fields.map((field) => [field.path, field])))

test('busy-message copy describes supplement and queue without claiming interruption', () => {
  const field = fields.get('busyMessageMode')
  const options = new Map(field.options.map((option) => [option.value, option]))

  assert.match(options.get('steer').label, /直接把新消息补进当前任务/)
  assert.match(options.get('queue').label, /等当前任务结束后再处理/)
  assert.match(field.hint, /不会停止当前任务/)
  assert.match(field.hint, /想停止当前任务请另发 \/cancel/)
  assert.doesNotMatch(field.hint, /打断|忽略/)
  for (const option of field.options) {
    assert.doesNotMatch(option.label, /\b(?:followup|steer|queue|cancel)\b/i)
  }
  assert.match(options.get('steer').labelEn, /Add the new message to the current task/)
  assert.match(field.hintEn, /does not stop the current task/)
})

test('session-management copy explains default permissions in both languages', () => {
  const toggle = fields.get('sessionDispatcherEnabled')
  assert.equal(toggle.default, true)
  assert.match(toggle.hint, /默认开启.*当前微信账号.*获准对话.*留空.*只读/)
  assert.match(toggle.hintEn, /On by default.*allowed to chat on this WeChat account.*Empty sender and session lists.*read-only/)
  const allowedSenders = fields.get('allowedSenders')
  const allowedConversations = [...fields.values()].find((field) => field.label === '只允许哪些微信会话')

  assert.match(allowedSenders.hint, /读取或修改文件、执行命令/)
  assert.match(allowedSenders.hint, /账号级名单可以覆盖/)
  assert.match(allowedSenders.hint, /首位联系人/)
  assert.match(allowedSenders.hint, /不一定是扫码人/)
  assert.match(allowedConversations.hint, /任意私聊/)
  assert.match(allowedConversations.hint, /群聊不会仅凭这一项开启回复/)

  assert.match(allowedSenders.hintEn, /read or change files and run commands/)
  assert.match(allowedSenders.hintEn, /account-level lists can override/)
  assert.match(allowedSenders.hintEn, /not necessarily the person who scanned the code/)
  assert.match(allowedConversations.hintEn, /any private chat/)
  assert.match(allowedConversations.hintEn, /group chats are not enabled/)
})

test('saving and resetting the remote session switch preserves existing restrictions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-settings-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const restrictions = {
    sessionDispatcherSenders: ['owner'], sessionDispatcherTargets: ['project'],
    protectedSessions: ['archive'], readOnlyPaths: [dir],
  }
  fs.writeFileSync(configFile(), JSON.stringify(restrictions))
  const settings = Object.create(ConfigController.prototype)
  await settings.save([{ path: 'sessionDispatcherEnabled', value: false }])
  assert.deepEqual(readSavedConfig(), { ...restrictions, sessionDispatcherEnabled: false })
  await settings.reset(['sessionDispatcherEnabled'])
  assert.deepEqual(readSavedConfig(), restrictions)
})
