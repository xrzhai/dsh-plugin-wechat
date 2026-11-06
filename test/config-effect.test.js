import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { Config } from '../src/index.js'
import { CONFIG_EFFECTS, effectOf } from '../src/config-effect.js'
import { FIELDS } from '../src/config-remote.js'

const clientSource = fs.readFileSync(new URL('../src/client.card.js', import.meta.url), 'utf8')

function clientEffects() {
  const match = /const CONFIG_EFFECTS = (\{[\s\S]*?\n\t\t\t\});/.exec(clientSource)
  assert.ok(match, 'client.card.js must contain the browser copy of CONFIG_EFFECTS')
  return Function(`"use strict"; return (${match[1]});`)()
}

function clientEssentialPaths() {
  const match = /const ESSENTIAL_PATHS = new Set\(\[([\s\S]*?)\n\t\t\t\]\);/.exec(clientSource)
  assert.ok(match, 'client.card.js must contain the settings-card field filter')
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]))
}

const EXPECTED_RESTART = [
  'accountId',
  'allowedMediaDirs',
  'cdnBaseUrl',
  'codeFileThreshold',
  'cwd',
  'eventPollMs',
  'groupBotNames',
  'markdownMode',
  'maxInboundMediaBytes',
  'maxMediaBytes',
  'maxMessageLength',
  'maxQueuedPerConversation',
  'maxTurnWaitMs',
  'mediaEnabled',
  'progressAfterMs',
  'progressEveryMs',
  'progressToolAfterMs',
  'richContent',
  'sendCooldownMs',
  'sendIntervalMs',
  'senderRatePerMinute',
  'sourceContext',
  'typingIndicator',
  'workspaceTitle',
]

test('effect inventory exactly matches the current Config schema', () => {
  const schemaFields = Object.keys(Config.dict).sort()
  assert.deepEqual(Object.keys(CONFIG_EFFECTS).sort(), schemaFields)
})

test('browser effect table stays byte-for-value identical to the backend table', () => {
  assert.deepEqual(clientEffects(), CONFIG_EFFECTS)
})

test('startup-captured fields are restart-only and hot-path fields are live', () => {
  const restart = Object.entries(CONFIG_EFFECTS)
    .filter(([, effect]) => effect === 'restart')
    .map(([field]) => field)
    .sort()
  assert.deepEqual(restart, EXPECTED_RESTART)

  for (const field of [
    'enabled',
    'sessionDispatcherEnabled',
    'sessionDispatcherSenders',
    'sessionDispatcherTargets',
    'protectedSessions',
    'readOnlyPaths',
    'groupChatEnabled',
    'groupReplyWhen',
    'senderDailyLimit',
    'busyMessageMode',
  ]) {
    assert.equal(effectOf(field), 'live', `${field} is re-read by its live consumer`)
  }
})

test('retired configuration has no schema or effect mapping', () => {
  for (const field of ['knowledgeHits', 'dryRun', 'usageAwarenessEnabled']) {
    assert.equal(CONFIG_EFFECTS[field], undefined)
    assert.equal(Config.dict[field], undefined)
  }
})

test('settings show the remote session switch last and keep advanced restrictions in the schema', () => {
  assert.deepEqual(FIELDS.map(group => group.group), ['基本设置', '消息与回复', '谁可以使用', '远程查看与管理 DSH 会话'])
  assert.deepEqual(FIELDS.at(-1).fields.map(field => field.path), ['sessionDispatcherEnabled'])
  const essential = clientEssentialPaths()
  for (const field of ['sessionDispatcherEnabled', 'senderRatePerMinute', 'workspaceTitle']) assert.ok(essential.has(field))
  assert.equal(FIELDS.flatMap(group => group.fields).find(field => field.path === 'senderRatePerMinute').default, 0)
  for (const field of ['sessionDispatcherSenders', 'sessionDispatcherTargets', 'protectedSessions', 'readOnlyPaths']) {
    assert.ok(Config.dict[field])
    assert.ok(!essential.has(field))
  }
})
