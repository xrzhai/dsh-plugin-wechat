import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mostRecentConversationId, runSessionCommand, SessionLines } from '../src/sessions.js'
import { WeixinLoginController } from '../src/login-remote.js'
import { ConfigController } from '../src/config-remote.js'
import { configFile } from '../src/state.js'

function sessionLines() {
  return {
    list: () => [{ sessionId: 'session-1' }],
    active: () => 'session-1',
    render: () => 'SESSION_LIST',
    use: () => undefined,
  }
}

test('legacy onboarding config does not read removed persona or proactive fields', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-onboarding-regression-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  fs.writeFileSync(configFile(), JSON.stringify({
    personaDefaultMode: 'girlfriend',
    proactiveEnabled: true,
  }), 'utf8')
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  })

  const checklist = await WeixinLoginController.prototype.onboarding.call({
    status: async () => ({ accounts: [] }),
  })
  assert.ok(Array.isArray(checklist.steps))
  assert.doesNotMatch(JSON.stringify(checklist), /persona|proactive/i)
})

test('controller RPC descriptor only exposes methods implemented on the prototype', () => {
  const marker = '@deepseek-ai/dsh-typert-protocol/remote-methods'
  const descriptor = Object.getOwnPropertyDescriptor(WeixinLoginController.prototype, marker)
  assert.ok(descriptor?.value)
  const methods = descriptor.value.methods.map((entry) => entry.method)
  for (const removed of ['memoryEventRemove', 'donateQr', 'donateQrAlipay', 'strangers']) {
    assert.ok(!methods.includes(removed), removed)
  }
  for (const retained of ['migrateSummary', 'migrateExport', 'migrateInspect', 'migrateRestore']) {
    assert.ok(methods.includes(retained), retained)
  }
  for (const method of methods) {
    assert.equal(typeof WeixinLoginController.prototype[method], 'function', method)
  }
  const clientSource = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const clientMethods = [...clientSource.matchAll(/service: "weixinLoginController",[\s\S]*?method: "([^"]+)"/g)]
    .map((match) => match[1])
  assert.deepEqual(clientMethods.sort(), methods.sort())
})

test('config RPC does not expose the removed stranger action', () => {
  const marker = '@deepseek-ai/dsh-typert-protocol/remote-methods'
  const descriptor = Object.getOwnPropertyDescriptor(ConfigController.prototype, marker)
  assert.ok(descriptor?.value)
  assert.deepEqual(descriptor.value.methods.map((entry) => entry.method), ['list', 'save', 'reset'])
})

test('/是 and /不用 stay ordinary chat after the answer handler was removed', () => {
  const context = { persona: { answer: () => { throw new Error('must not be called') } } }
  for (const text of ['/是', '/好的', '/行', '/不用 我住在上海', '/算了', '/yes explain']) {
    assert.equal(runSessionCommand(sessionLines(), 'conversation', text, 'account', context), undefined, text)
  }
})

test('/new distinguishes a bare command from an explicit title using real session storage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-new-title-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  })

  const lines = new SessionLines()
  const conversationId = 'new-title-semantics'
  runSessionCommand(lines, conversationId, '/new', undefined, {})
  const bareSessionId = lines.active(conversationId, undefined)
  const bareLine = () => lines.list(conversationId, undefined).find((line) => line.sessionId === bareSessionId)
  assert.equal(bareLine().title, undefined, 'a bare /new must wait for the first message')
  assert.equal(lines.title(conversationId, bareSessionId, '第一条消息', undefined), '第一条消息')
  assert.equal(bareLine().title, '第一条消息')

  runSessionCommand(lines, conversationId, '/new 写周报', undefined, {})
  const titledSessionId = lines.active(conversationId, undefined)
  const titledLine = () => lines.list(conversationId, undefined).find((line) => line.sessionId === titledSessionId)
  assert.equal(titledLine().title, '写周报', 'an explicit /new title must be written immediately')
  assert.equal(lines.title(conversationId, titledSessionId, '不应覆盖', undefined), undefined)
  assert.equal(titledLine().title, '写周报')
})

test('notify target is the latest same-account conversation and respects ISO offsets', () => {
  const store = {
    'account-a:old@im': {
      lines: [{ sessionId: 'old', lastUsedAt: '2026-11-05T00:00:00.000Z' }],
    },
    'account-b:newest@im': {
      lines: [{ sessionId: 'other', lastUsedAt: '2026-11-05T10:00:00.000Z' }],
    },
    'account-a:offset@im': {
      lines: [{ sessionId: 'offset', lastUsedAt: '2026-11-05T17:00:00+08:00' }],
    },
    'account-a:fallback@im': {
      lines: [
        { sessionId: 'first', lastUsedAt: 'not-a-date', createdAt: '2026-11-05T08:30:00.000Z' },
        { sessionId: 'second', createdAt: '2026-11-05T01:00:00.000Z' },
      ],
    },
  }

  assert.equal(mostRecentConversationId('account-a', store), 'offset@im')
  assert.equal(mostRecentConversationId('account-b', store), 'newest@im')
  assert.equal(mostRecentConversationId('missing-account', store), undefined)
  assert.equal(mostRecentConversationId('account-a', {}), undefined)
  assert.equal(mostRecentConversationId('account-a', { 'account-a:': { lines: [{ lastUsedAt: '2026-11-05T10:00:00Z' }] } }), undefined)
})
