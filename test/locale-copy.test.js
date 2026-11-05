import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function metadata(locale) {
  const path = new URL(`../locale/${locale}.json`, import.meta.url)
  return JSON.parse(fs.readFileSync(path, 'utf8')).meta
}

test('plugin descriptions explain the WeChat experience in both locales', () => {
  const zh = metadata('zh').description
  const en = metadata('en').description

  assert.equal(zh, '在微信里和你的 DSH 助理聊天：收发文字、图片、文件和语音，管理话题、提醒与账号。')
  assert.equal(en, 'Chat with your DSH assistant from WeChat: send text, images, files and voice notes, and manage topics, reminders and accounts.')
  assert.doesNotMatch(`${zh} ${en}`, /iLink|Bot API|Prompt|Subagent/)
})
