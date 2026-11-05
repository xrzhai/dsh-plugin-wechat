import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FIELDS } from '../src/config-remote.js'

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

test('session-management copy states authorization, workspace, and sandbox boundaries', () => {
  const senders = fields.get('sessionDispatcherSenders')
  const protectedSessions = fields.get('protectedSessions')
  const readOnlyPaths = fields.get('readOnlyPaths')
  const allowedSenders = fields.get('allowedSenders')
  const allowedConversations = [...fields.values()].find((field) => field.label === '只允许哪些微信会话')

  assert.match(senders.hint, /账号可能沿用全局名单，也可能使用自己的名单/)
  assert.match(senders.hint, /仍要求此人出现在下面「允许与助手对话的人」全局名单中/)
  assert.doesNotMatch(senders.hint, /下面的「允许与助手对话的人」/)
  assert.match(protectedSessions.hint, /只限制跨会话管理工具/)
  assert.match(protectedSessions.hint, /普通微信对话不会因为这里而变成只读/)
  assert.match(readOnlyPaths.hint, /只限制“跨会话管理”功能/)
  assert.match(readOnlyPaths.hint, /不影响普通微信对话/)
  assert.match(readOnlyPaths.hint, /不是文件权限或系统沙箱/)
  assert.match(allowedSenders.hint, /读取或修改文件、执行命令/)
  assert.match(allowedSenders.hint, /账号级名单可以覆盖/)
  assert.match(allowedSenders.hint, /首位联系人/)
  assert.match(allowedSenders.hint, /不一定是扫码人/)
  assert.match(allowedConversations.hint, /任意私聊/)
  assert.match(allowedConversations.hint, /群聊不会仅凭这一项开启回复/)

  assert.match(senders.hintEn, /account's own list or the global list it inherits/)
  assert.match(senders.hintEn, /global “People who may chat with the assistant” list below/)
  assert.match(protectedSessions.hintEn, /only limits the cross-session management tools/)
  assert.match(protectedSessions.hintEn, /Ordinary WeChat chat does not become read-only/)
  assert.match(readOnlyPaths.hintEn, /cross-session management feature/)
  assert.match(readOnlyPaths.hintEn, /does not affect ordinary WeChat chat/)
  assert.match(readOnlyPaths.hintEn, /not a filesystem sandbox/)
  assert.match(allowedSenders.hintEn, /read or change files and run commands/)
  assert.match(allowedSenders.hintEn, /account-level lists can override/)
  assert.match(allowedSenders.hintEn, /not necessarily the person who scanned the code/)
  assert.match(allowedConversations.hintEn, /any private chat/)
  assert.match(allowedConversations.hintEn, /group chats are not enabled/)
})

test('automatic file copy matches the actual top-level, extension and count limits', () => {
  const field = fields.get('autoSendFiles')

  assert.match(field.hint, /工作目录第一层/)
  assert.match(field.hint, /最多发送 5 个/)
  assert.match(field.hint, /不会递归扫描子目录/)
  assert.equal(field.hint.includes('交付物'), false)
  assert.match(field.hintEn, /top level of the workspace/)
  assert.match(field.hintEn, /up to five/)
  assert.match(field.hintEn, /Subdirectories are not scanned/)
})
