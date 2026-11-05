import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Config } from '../src/index.js'
import {
  SCOPABLE_KEYS,
  readScope,
  scopeFilePath,
  scopedConfig,
  writeScope,
} from '../src/config-scope.js'

const LEGACY_SCOPE_KEYS = [
  'humanPacing',
  'replyDelayMaxMs',
  'bubbleSplitMax',
  'bubbleGapMs',
  'lifeState',
  'stickerEnabled',
  'memoryEnabled',
  'memoryRecentTurns',
  'memoryRecall',
  'memoryRecallDays',
  'memoryRecallHits',
  'personaDefaultMode',
]

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-config-scope-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function writeLegacyStore(root) {
  const file = scopeFilePath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    note: 'keep user-owned metadata',
    scopes: {
      'account|chat': {
        maxMessageLength: 700,
        personaDefaultMode: 'girlfriend',
        memoryRecall: true,
      },
      'other|chat': {
        markdownMode: 'off',
        memoryRecentTurns: 12,
      },
    },
  }, null, 2)}\n`)
  return file
}

test('scope allowlist contains current schema keys only and drops deleted feature keys', () => {
  const schemaFields = new Set(Object.keys(Config.dict))
  assert.ok(SCOPABLE_KEYS.every((field) => schemaFields.has(field)))
  assert.deepEqual(SCOPABLE_KEYS.filter((field) => LEGACY_SCOPE_KEYS.includes(field)), [])
})

test('reading an old scope file ignores legacy runtime keys without rewriting the file', (t) => {
  const root = fixture(t)
  const file = writeLegacyStore(root)
  const before = fs.readFileSync(file, 'utf8')

  const scope = readScope(root, 'account', 'chat')
  assert.deepEqual(scope, { maxMessageLength: 700 })
  assert.deepEqual(
    scopedConfig({ maxMessageLength: 1500, personaDefaultMode: 'default' }, scope),
    { maxMessageLength: 700, personaDefaultMode: 'default' },
  )
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('writing one scope preserves legacy keys, other conversations and top-level metadata', (t) => {
  const root = fixture(t)
  const file = writeLegacyStore(root)

  writeScope(root, 'account', 'chat', { markdownMode: 'off' })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.scopes['account|chat'], {
    maxMessageLength: 700,
    personaDefaultMode: 'girlfriend',
    memoryRecall: true,
    markdownMode: 'off',
  })
  assert.deepEqual(saved.scopes['other|chat'], { markdownMode: 'off', memoryRecentTurns: 12 })
  assert.equal(saved.note, 'keep user-owned metadata')
})

test('a write containing only removed keys is a no-op on an existing old scope', (t) => {
  const root = fixture(t)
  const file = writeLegacyStore(root)
  const before = fs.readFileSync(file, 'utf8')

  const effective = writeScope(root, 'account', 'chat', { personaDefaultMode: 'replacement' })
  assert.deepEqual(effective, { maxMessageLength: 700 })
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('an explicit empty patch clears only that conversation', (t) => {
  const root = fixture(t)
  const file = writeLegacyStore(root)

  writeScope(root, 'account', 'chat', {})
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(Object.hasOwn(saved.scopes, 'account|chat'), false)
  assert.deepEqual(saved.scopes['other|chat'], { markdownMode: 'off', memoryRecentTurns: 12 })
  assert.equal(saved.note, 'keep user-owned metadata')
})
