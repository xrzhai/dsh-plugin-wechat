import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  createInboundPendingStore,
  InboundPendingError,
  inboundPendingDir,
} from '../../src/message/inbound-pending.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-inbound-pending-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const accountId = 'synthetic-bot'
  const syncBufPath = path.join(root, 'openclaw-weixin', 'accounts', `${accountId}.sync.json`)
  const warnings = []
  const create = () => createInboundPendingStore({
    accountId,
    syncBufPath,
    now: () => 1_800_000_000_000,
    warn: (line) => warnings.push(line),
  })
  return { root, accountId, syncBufPath, warnings, create, store: create() }
}

const message = (id = 'message-1') => ({
  id,
  senderId: 'user-a',
  conversationId: 'chat-a',
  type: 'text',
  text: 'run the isolated fixture',
  contextToken: 'not-a-real-token-fixture',
  timestamp: 1_800_000_000_000,
})

test('queued records survive a restart while started records are reported and never replayed', (t) => {
  const f = fixture(t)
  const safe = message('safe-message')
  const unsafe = message('unsafe-message')

  const safeRecord = f.store.stage(safe)
  const unsafeRecord = f.store.stage(unsafe)
  assert.equal(safeRecord.status, 'queued')
  assert.equal(unsafeRecord.status, 'queued')
  assert.deepEqual(f.store.claim(unsafeRecord.key), { ok: true })

  const restarted = f.create()
  const recovery = restarted.recover()
  assert.deepEqual(recovery.queued.map((record) => record.message.id), ['safe-message'])
  assert.equal(recovery.unresolved, 1)

  const dir = inboundPendingDir(f.syncBufPath, f.accountId)
  assert.ok(fs.existsSync(dir))
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    const files = fs.readdirSync(dir).filter((name) => name !== 'completed.json')
    assert.ok(files.length > 0)
    assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600)
  }
  assert.ok(f.warnings.every((line) => !line.includes('not-a-real-token-fixture')))
})

test('completion persists a bounded restart dedupe marker before removing the queue item', (t) => {
  const f = fixture(t)
  const original = message('completed-message')
  const queued = f.store.stage(original)
  assert.equal(f.store.claim(queued.key).ok, true)
  assert.equal(f.store.complete(queued.key), true)

  const restarted = f.create()
  assert.deepEqual(restarted.recover(), { queued: [], unresolved: 0 })
  assert.equal(restarted.stage(original).status, 'completed')

  const dir = inboundPendingDir(f.syncBufPath, f.accountId)
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'completed.json'), 'utf8'))
  assert.deepEqual(ledger.ids, ['completed-message'])
  assert.equal(fs.readdirSync(dir).filter((name) => name !== 'completed.json').length, 0)
})

test('a corrupt completed ledger fails closed instead of risking blind duplicate execution', (t) => {
  const f = fixture(t)
  const dir = inboundPendingDir(f.syncBufPath, f.accountId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'completed.json'), '{not-json', { mode: 0o600 })

  const store = f.create()
  assert.throws(() => store.stage(message()), (error) => {
    assert.ok(error instanceof InboundPendingError)
    assert.doesNotMatch(error.message, /not-a-real-token-fixture/)
    return true
  })
  assert.ok(f.warnings.every((line) => !line.includes('not-a-real-token-fixture')))
})
