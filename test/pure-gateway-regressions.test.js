import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mostRecentConversationId, runSessionCommand } from '../src/sessions.js'
import { WeixinLoginController } from '../src/login-remote.js'
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
  assert.ok(!methods.includes('memoryEventRemove'))
  for (const method of methods) {
    assert.equal(typeof WeixinLoginController.prototype[method], 'function', method)
  }
})

test('/是 and /不用 stay ordinary chat without an answer handler', () => {
  assert.equal(runSessionCommand(sessionLines(), 'conversation', '/是', 'account', {}), undefined)
  assert.equal(runSessionCommand(sessionLines(), 'conversation', '/不用', 'account', {}), undefined)
})

test('an answer handler result is preserved', async () => {
  let seen
  const reply = runSessionCommand(sessionLines(), 'conversation', '/不用', 'account', {
    persona: {
      answer: (arg) => {
        seen = arg
        return '好，什么都不改。'
      },
    },
  })
  assert.equal(seen, '不用')
  assert.equal(reply, '好，什么都不改。')
  assert.equal(runSessionCommand(sessionLines(), 'conversation', '/是', 'account', {
    persona: { answer: () => undefined },
  }), undefined)
  assert.equal(await runSessionCommand(sessionLines(), 'conversation', '/是', 'account', {
    persona: { answer: async () => 'confirmed' },
  }), 'confirmed')
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
