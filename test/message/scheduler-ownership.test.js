import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ReminderScheduler, readReminders } from '../../src/message/scheduler.js'
import { SubscriptionScheduler, readSubscriptions } from '../../src/message/subscriptions.js'
import { runSessionCommand } from '../../src/sessions.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-scheduler-ownership-'))
  const timers = []
  const options = {
    stateRoot: root,
    fire: () => {},
    setTimeoutRef: (delay, callback) => {
      const timer = { delay, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutRef: (timer) => { timer.cleared = true },
  }
  const reminders = new ReminderScheduler(options)
  const subscription = new SubscriptionScheduler(options)
  t.after(() => { reminders.stop(); subscription.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  const command = (account, text) => runSessionCommand(undefined, 'chat', text, account, { reminders, subscription })
  return { root, timers, reminders, subscription, command }
}

test('WeChat cancellation is account-scoped for reminders and subscriptions', (t) => {
  const f = fixture(t)
  for (const accountId of ['account-a', 'account-b']) {
    f.reminders.schedule({ accountId, conversationId: 'chat', text: accountId, fireAt: Date.now() + 600_000 })
    f.subscription.schedule({ accountId, conversationId: 'chat', prompt: accountId, when: { ok: true, kind: 'once', fireAt: Date.now() + 600_000 } })
  }
  assert.doesNotMatch(f.command('account-a', '/remindcancel r2'), /^已取消/)
  assert.doesNotMatch(f.command('account-a', '/subscribecancel s2'), /^已取消/)
  assert.deepEqual(readReminders(f.root).items.map(item => item.id), ['r1', 'r2'])
  assert.deepEqual(readSubscriptions(f.root).items.map(item => item.id), ['s1', 's2'])
  assert.match(f.command('account-a', '/remindcancel r1'), /^已取消/)
  assert.match(f.command('account-a', '/subscribecancel s1'), /^已取消/)
  assert.match(f.command('account-b', '/remindcancel r2'), /^已取消/)
  assert.match(f.command('account-b', '/subscribecancel s2'), /^已取消/)
})

test('failed subscription creation or cancellation preserves the saved records and live timers', (t) => {
  const f = fixture(t)
  assert.match(f.command('account-a', '/subscribe 10m original'), /^好的/)
  const file = path.join(f.root, 'subscriptions.json')
  const original = fs.readFileSync(file, 'utf8')
  const [timer] = f.timers
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('synthetic write failure') })

  assert.match(f.command('account-a', '/subscribe 10m new'), /^没有安排：/)
  assert.match(f.command('account-a', '/subscribecancel s1'), /^没能取消/)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  assert.deepEqual(f.subscription.list('account-a').map(item => item.id), ['s1'])
  assert.equal(f.timers.length, 1)
  assert.equal(timer.cleared, false)
  const afterFailure = new SubscriptionScheduler({ stateRoot: f.root, fire: () => {} })
  assert.deepEqual(afterFailure.list('account-a').map(item => item.id), ['s1'])
  afterFailure.stop()

  rename.mock.restore()
  assert.match(f.command('account-a', '/subscribe 10m new'), /编号 s2/)
  assert.deepEqual(readSubscriptions(f.root).items.map(item => item.id), ['s1', 's2'])
  assert.match(f.command('account-a', '/subscribecancel s1'), /^已取消/)
  assert.equal(timer.cleared, true)
  assert.deepEqual(readSubscriptions(f.root).items.map(item => item.id), ['s2'])
  const restarted = new SubscriptionScheduler({ stateRoot: f.root, fire: () => {} })
  t.after(() => restarted.stop())
  assert.deepEqual(restarted.list('account-a').map(item => item.id), ['s2'])
})

test('unscoped reminder cancellation remains available to desktop management', (t) => {
  const f = fixture(t)
  f.reminders.schedule({ accountId: 'account-b', conversationId: 'chat', text: 'original', fireAt: Date.now() + 600_000 })
  assert.equal(f.reminders.cancel('r1'), true)
  assert.deepEqual(readReminders(f.root).items, [])
})

test('unreadable subscription data is not overwritten by a new arrangement', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-subscription-corrupt-'))
  const file = path.join(root, 'subscriptions.json')
  const original = '{"items":[{"id":"existing"}'
  fs.writeFileSync(file, original)
  const subscription = new SubscriptionScheduler({ stateRoot: root, fire: () => {} })
  t.after(() => { subscription.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  const reply = runSessionCommand(undefined, 'chat', '/subscribe 10m new', 'account-a', { subscription })
  assert.match(reply, /^没有安排：/)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})

test('a partially unreadable subscription store is preserved on wake and cancellation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-subscription-partial-'))
  const file = path.join(root, 'subscriptions.json')
  const original = JSON.stringify({ seq: 2, items: [
    { id: 's1', accountId: 'account-a', conversationId: 'chat', prompt: 'original', kind: 'once', fireAt: Date.now() - 1000 },
    { id: 's2', kind: 'future-format' },
  ] })
  fs.writeFileSync(file, original)
  let armed = 0
  const subscription = new SubscriptionScheduler({ stateRoot: root, fire: () => {}, setTimeoutRef: () => { armed++; return {} } })
  t.after(() => { subscription.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  subscription.wake('account-a')
  assert.equal(subscription.cancel('s1', 'account-a'), false)
  assert.equal(armed, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})
