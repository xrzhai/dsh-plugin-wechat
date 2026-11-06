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
  'asr',
  'autoSendFiles',
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
  'messageJournal',
  'notifyEnabled',
  'notifyPort',
  'notifyToken',
  'progressAfterMs',
  'progressEveryMs',
  'progressToolAfterMs',
  'readLinks',
  'richContent',
  'sendCooldownMs',
  'sendIntervalMs',
  'senderRatePerMinute',
  'sideModel',
  'sideProvider',
  'sourceContext',
  'toolAudit',
  'typingIndicator',
  'voiceOutbound',
  'webhookSecret',
  'webhookTimeoutMs',
  'webhookUrl',
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
    'ocrTimeoutMs',
    'quietHoursStart',
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

test('workspace title and dispatcher controls are exposed to the settings card', () => {
  const paths = new Set(FIELDS.flatMap((group) => group.fields.map((field) => field.path)))
  const essentialPaths = clientEssentialPaths()
  for (const field of [
    'workspaceTitle',
    'sessionDispatcherEnabled',
    'sessionDispatcherSenders',
    'sessionDispatcherTargets',
    'protectedSessions',
    'readOnlyPaths',
  ]) {
    assert.equal(paths.has(field), true, `${field} must be present in ConfigController.FIELDS`)
    assert.equal(essentialPaths.has(field), true, `${field} must pass the card essential-path filter`)
  }
})
