import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ReminderScheduler, readReminders, writeReminders } from '../../src/message/scheduler.js'

function stateRoot(t, prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function reminder(id, fireAt, overrides = {}) {
  return {
    id,
    accountId: 'account',
    conversationId: 'conversation',
    text: `reminder ${id}`,
    fireAt,
    createdAt: new Date(fireAt - 60_000).toISOString(),
    ...overrides,
  }
}

function scheduler(root, warn = () => {}) {
  return new ReminderScheduler({
    stateRoot: root,
    fire: () => {},
    warn,
    setTimeoutRef: () => ({}),
    clearTimeoutRef: () => {},
  })
}

function recoveryCopies(root) {
  return readdirSync(root).filter((name) => /^reminders\.recovery-[0-9a-f]+\.json$/.test(name))
}

test('mixed corrupt rows keep valid reminders and preserve the exact original before repair', (t) => {
  const root = stateRoot(t, 'weixin-reminder-corrupt-rows-')
  const fireAt = Date.now() + 60 * 60_000
  const original = `${JSON.stringify({
    schemaVersion: 1,
    seq: 2,
    items: [
      null,
      'not an object',
      reminder('r4', fireAt),
      { id: 'r5', accountId: 'account', conversationId: 'conversation', text: 'missing fireAt' },
      { ...reminder('r12', fireAt), fireAt: 'not-a-time', createdAt: undefined },
      reminder('r13', fireAt, { recurrence: null }),
      reminder('r4', fireAt + 1),
    ],
  }, null, 2)}\n`
  writeFileSync(path.join(root, 'reminders.json'), original)

  const warnings = []
  const loaded = readReminders(root, (message) => warnings.push(message))
  assert.equal(loaded.seq, 13)
  assert.deepEqual(loaded.items.map((item) => item.id), ['r4'])
  assert.equal(readFileSync(path.join(root, 'reminders.json'), 'utf8'), original)
  assert.match(warnings.join('\n'), /invalid or duplicate reminder row/)

  const copies = recoveryCopies(root)
  assert.equal(copies.length, 1)
  assert.equal(readFileSync(path.join(root, copies[0]), 'utf8'), original)

  const store = scheduler(root, (message) => warnings.push(message))
  t.after(() => store.stop())
  assert.deepEqual(store.list().map((item) => item.id), ['r4'])
  assert.equal(store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'next', fireAt }).id, 'r14')
  assert.equal(readReminders(root).seq, 14)
})

test('legacy stores without seq retain valid rows and allocate past their real ids across restarts', (t) => {
  const root = stateRoot(t, 'weixin-reminder-legacy-store-')
  const fireAt = Date.now() + 60 * 60_000
  const original = `${JSON.stringify({ items: [reminder('r3', fireAt), reminder('r10', fireAt + 1)] }, null, 2)}\n`
  writeFileSync(path.join(root, 'reminders.json'), original)

  const loaded = readReminders(root)
  assert.equal(loaded.seq, 10)
  assert.deepEqual(loaded.items.map((item) => item.id), ['r3', 'r10'])
  assert.equal(readFileSync(path.join(root, 'reminders.json'), 'utf8'), original)
  assert.equal(recoveryCopies(root).length, 1)

  const first = scheduler(root)
  assert.equal(first.schedule({ accountId: 'account', conversationId: 'conversation', text: 'first', fireAt }).id, 'r11')
  first.stop()

  const restarted = scheduler(root)
  t.after(() => restarted.stop())
  assert.deepEqual(restarted.list().map((item) => item.id).sort(), ['r10', 'r11', 'r3'])
  assert.equal(restarted.schedule({ accountId: 'account', conversationId: 'conversation', text: 'second', fireAt }).id, 'r12')
  assert.equal(readReminders(root).seq, 12)
})

test('an invalid JSON store is recovered before a new reminder replaces it', (t) => {
  const root = stateRoot(t, 'weixin-reminder-invalid-json-')
  const original = '{"seq":1,"items":['
  writeFileSync(path.join(root, 'reminders.json'), original)

  const warnings = []
  const loaded = readReminders(root, (message) => warnings.push(message))
  assert.deepEqual(loaded, { seq: 0, items: [] })
  assert.match(warnings.join('\n'), /not valid JSON/)
  const copies = recoveryCopies(root)
  assert.equal(copies.length, 1)
  assert.equal(readFileSync(path.join(root, copies[0]), 'utf8'), original)

  const store = scheduler(root)
  t.after(() => store.stop())
  assert.equal(store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'fresh', fireAt: Date.now() + 60_000 }).id, 'r1')
  assert.equal(readReminders(root).items[0].id, 'r1')
})

test('read and write errors leave the storage read-only and do not crash setup', (t) => {
  const root = stateRoot(t, 'weixin-reminder-unreadable-')
  const unreadable = path.join(root, 'reminders.json')
  mkdirSync(unreadable)

  const warnings = []
  const loaded = readReminders(root, (message) => warnings.push(message))
  assert.deepEqual(loaded, { seq: 0, items: [] })
  assert.match(warnings.join('\n'), /reminder writes are disabled/)

  const store = scheduler(root, (message) => warnings.push(message))
  t.after(() => store.stop())
  const result = store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'blocked', fireAt: Date.now() + 60_000 })
  assert.match(result.error, /当前只读/)
  assert.equal(store.list().length, 0)

  const wrote = writeReminders(root, { seq: 0, items: [] }, (message) => warnings.push(message))
  assert.equal(wrote, false)
  assert.equal(statSync(unreadable).isDirectory(), true)
})

test('a scheduler write failure rolls back the in-memory row and sequence', (t) => {
  const root = stateRoot(t, 'weixin-reminder-write-failure-')
  const fireAt = Date.now() + 60 * 60_000
  const recurring = reminder('r8', fireAt + 1, {
    recurrence: { kind: 'daily' },
    hour: 9,
    minute: 0,
    scheduledFor: fireAt + 1,
  })
  writeReminders(root, { seq: 8, items: [reminder('r7', fireAt), recurring] })

  const store = scheduler(root)
  t.after(() => store.stop())
  const file = path.join(root, 'reminders.json')
  const priorFile = path.join(root, 'reminders.before-failure.json')
  renameSync(file, priorFile)
  mkdirSync(file)

  assert.equal(store.cancel('r7'), false)
  assert.equal(store.snoozeById('r7', 10, fireAt), undefined)
  assert.equal(store.list().find((item) => item.id === 'r7').fireAt, fireAt)
  assert.equal(store.skipNext('account'), undefined)
  assert.equal(store.list().find((item) => item.id === 'r8').scheduledFor, fireAt + 1)
  const result = store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'cannot persist', fireAt })
  assert.match(result.error, /写盘失败/)
  assert.deepEqual(store.list().map((item) => item.id), ['r7', 'r8'])
  assert.equal(store.store.seq, 8)
  assert.equal(readFileSync(priorFile, 'utf8').length > 0, true)
})

test('a future schema stays readable but is never downgraded by a scheduler write', (t) => {
  const root = stateRoot(t, 'weixin-reminder-future-schema-')
  const fireAt = Date.now() + 60 * 60_000
  const original = `${JSON.stringify({ schemaVersion: 2, seq: 2, items: [reminder('r2', fireAt)] }, null, 2)}\n`
  writeFileSync(path.join(root, 'reminders.json'), original)

  const warnings = []
  const loaded = readReminders(root, (message) => warnings.push(message))
  assert.deepEqual(loaded.items.map((item) => item.id), ['r2'])
  assert.match(warnings.join('\n'), /disabled writes to avoid a downgrade/)

  const store = scheduler(root, (message) => warnings.push(message))
  t.after(() => store.stop())
  assert.match(store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'blocked', fireAt }).error, /当前只读/)
  assert.equal(readFileSync(path.join(root, 'reminders.json'), 'utf8'), original)
})
