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

function scheduler(root, warn = () => {}, overrides = {}) {
  return new ReminderScheduler({
    stateRoot: root,
    fire: () => {},
    warn,
    setTimeoutRef: () => ({}),
    clearTimeoutRef: () => {},
    ...overrides,
  })
}

function recoveryCopies(root) {
  return readdirSync(root).filter((name) => /^reminders\.recovery-[0-9a-f]+\.json$/.test(name))
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
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
  assert.match(result.error, /提醒暂时不能保存/)
  assert.match(result.error, /日志中搜索“reminders\.json”/)
  assert.doesNotMatch(result.error, /could not read|schemaVersion|原文|source/)
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
  assert.equal(store.timers.size, 2)
  const file = path.join(root, 'reminders.json')
  const priorFile = path.join(root, 'reminders.before-failure.json')
  renameSync(file, priorFile)
  mkdirSync(file)

  const result = store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'cannot persist', fireAt })
  assert.match(result.error, /提醒没有保存成功/)
  assert.match(result.error, /原有提醒保持不变/)
  assert.equal(store.timers.size, 0)
  store.wake('account')
  assert.equal(store.timers.size, 0)
  assert.equal(store.cancel('r7'), false)
  assert.equal(store.snoozeById('r7', 10, fireAt), undefined)
  assert.equal(store.list().find((item) => item.id === 'r7').fireAt, fireAt)
  assert.equal(store.skipNext('account'), undefined)
  assert.equal(store.list().find((item) => item.id === 'r8').scheduledFor, fireAt + 1)
  assert.deepEqual(store.list().map((item) => item.id), ['r7', 'r8'])
  assert.equal(store.store.seq, 8)
  assert.equal(readFileSync(priorFile, 'utf8').length > 0, true)
})

test('a completed automatic delivery with an unpersisted completion stops all further sends', async (t) => {
  const root = stateRoot(t, 'weixin-reminder-delivery-write-failure-')
  const fireAt = Date.now() - 1
  writeReminders(root, { seq: 1, items: [reminder('r1', fireAt)] })
  const file = path.join(root, 'reminders.json')
  const priorFile = path.join(root, 'reminders.before-delivery-failure.json')
  const callbacks = []
  const warnings = []
  let fires = 0
  const store = scheduler(root, (message) => warnings.push(message), {
    fire: () => {
      fires += 1
      // The preflight succeeded; make the completion write fail after send.
      renameSync(file, priorFile)
      mkdirSync(file)
    },
    setTimeoutRef: (delay, callback) => { callbacks.push(callback); return { delay } },
  })
  t.after(() => store.stop())
  assert.equal(callbacks.length, 1)

  callbacks[0]()
  await settle()

  assert.equal(fires, 1)
  assert.equal(store.timers.size, 0)
  assert.deepEqual(store.list().map((item) => item.id), ['r1'])
  assert.match(warnings.join('\n'), /automatic reminder delivery is disabled after a persistence failure/)
  store.wake('account')
  assert.equal(callbacks.length, 1)
  assert.equal(fires, 1)
  assert.equal(readFileSync(priorFile, 'utf8').length > 0, true)
})

test('a failed write preflight prevents an automatic delivery from starting', async (t) => {
  const root = stateRoot(t, 'weixin-reminder-delivery-preflight-failure-')
  const fireAt = Date.now() - 1
  writeReminders(root, { seq: 1, items: [reminder('r1', fireAt)] })
  const callbacks = []
  const warnings = []
  let fires = 0
  const store = scheduler(root, (message) => warnings.push(message), {
    fire: () => { fires += 1 },
    setTimeoutRef: (delay, callback) => { callbacks.push(callback); return { delay } },
  })
  t.after(() => store.stop())
  assert.equal(callbacks.length, 1)

  const file = path.join(root, 'reminders.json')
  const priorFile = path.join(root, 'reminders.before-preflight-failure.json')
  renameSync(file, priorFile)
  mkdirSync(file)
  callbacks[0]()
  await settle()

  assert.equal(fires, 0)
  assert.equal(store.timers.size, 0)
  assert.deepEqual(store.list().map((item) => item.id), ['r1'])
  assert.match(warnings.join('\n'), /automatic reminder delivery is disabled after a persistence failure/)
  store.wake('account')
  assert.equal(fires, 0)
  assert.equal(readFileSync(priorFile, 'utf8').length > 0, true)
})

test('a future schema stays readable but never writes, arms, or automatically delivers', (t) => {
  const root = stateRoot(t, 'weixin-reminder-future-schema-')
  const fireAt = Date.now() - 1
  const original = `${JSON.stringify({ schemaVersion: 2, seq: 2, items: [reminder('r2', fireAt)] }, null, 2)}\n`
  writeFileSync(path.join(root, 'reminders.json'), original)

  const warnings = []
  const loaded = readReminders(root, (message) => warnings.push(message))
  assert.deepEqual(loaded.items.map((item) => item.id), ['r2'])
  assert.match(warnings.join('\n'), /writes and automatic delivery are disabled/)
  assert.equal(recoveryCopies(root).length, 1)

  let timerArms = 0
  let fires = 0
  const store = scheduler(root, (message) => warnings.push(message), {
    fire: () => { fires += 1 },
    setTimeoutRef: () => { timerArms += 1; return {} },
  })
  t.after(() => store.stop())
  assert.equal(store.timers.size, 0)
  store.wake('account')
  assert.equal(timerArms, 0)
  assert.equal(fires, 0)
  assert.match(warnings.join('\n'), /automatic delivery is disabled/)
  assert.match(store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'blocked', fireAt }).error, /提醒暂时不能保存/)
  assert.equal(readFileSync(path.join(root, 'reminders.json'), 'utf8'), original)
})

test('an exhausted safe sequence returns before probing an unsafe rN id', (t) => {
  const root = stateRoot(t, 'weixin-reminder-sequence-boundary-')
  const fireAt = Date.now() + 60 * 60_000
  const original = `${JSON.stringify({
    schemaVersion: 1,
    seq: Number.MAX_SAFE_INTEGER,
    items: [reminder('r9007199254740992', fireAt)],
  }, null, 2)}\n`
  writeFileSync(path.join(root, 'reminders.json'), original)

  const store = scheduler(root)
  t.after(() => store.stop())
  const result = store.schedule({ accountId: 'account', conversationId: 'conversation', text: 'no id left', fireAt })
  assert.match(result.error, /提醒编号已经用完/)
  assert.equal(store.store.seq, Number.MAX_SAFE_INTEGER)
  assert.equal(readFileSync(path.join(root, 'reminders.json'), 'utf8'), original)
})
