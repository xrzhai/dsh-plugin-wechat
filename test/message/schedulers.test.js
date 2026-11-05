import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MAX_TIMEOUT_DELAY_MS } from '../../src/message/long-timer.js'
import { ReminderScheduler, parseWhen } from '../../src/message/scheduler.js'
import { SubscriptionScheduler, parseSubscriptionWhen } from '../../src/message/subscriptions.js'

const DAY_MS = 24 * 60 * 60 * 1000

function fakeClock(start = 1_800_000_000_000) {
  let now = start
  let nextId = 1
  const timers = []

  const setTimeoutRef = (delay, callback) => {
    assert.equal(Number.isFinite(delay), true)
    assert.equal(delay >= 0, true)
    assert.equal(delay <= MAX_TIMEOUT_DELAY_MS, true)
    const timer = { id: nextId++, dueAt: now + delay, delay, callback, cleared: false, fired: false }
    timers.push(timer)
    return timer
  }

  const clearTimeoutRef = (timer) => {
    timer.cleared = true
  }

  const active = () => timers.filter((timer) => timer.cleared === false && timer.fired === false)

  const advance = (ms) => {
    const target = now + ms
    while (true) {
      const timer = timers
        .filter((candidate) => candidate.cleared === false && candidate.fired === false && candidate.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0]
      if (timer === undefined) break
      now = timer.dueAt
      timer.fired = true
      timer.callback()
    }
    now = target
  }

  return { now: () => now, setTimeoutRef, clearTimeoutRef, active, advance }
}

function stateRoot(t, prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('absolute reminder dates enforce the one-year cap', () => {
  const now = new Date(2026, 10, 5, 18, 20)
  const withinCap = parseWhen('2027-01-01 09:00', now)
  assert.equal(withinCap.ok, true)
  assert.equal(withinCap.fireAt - now.getTime() > MAX_TIMEOUT_DELAY_MS, true)

  const beyondCap = parseWhen('2028-12-01 09:00', now)
  assert.equal(beyondCap.ok, false)
  assert.equal(beyondCap.reason, '定得太远：最多支持一年以内')
  assert.equal(parseSubscriptionWhen('2028-12-01 09:00', now).ok, false)
})

test('reminder waits longer than the Node timer limit in safe segments and fires once', async (t) => {
  const clock = fakeClock()
  const calls = []
  const scheduler = new ReminderScheduler({
    stateRoot: stateRoot(t, 'weixin-reminder-long-'),
    fire: (item) => calls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())

  const when = parseWhen('30d', new Date(clock.now()))
  assert.equal(when.ok, true)
  const item = scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'water', fireAt: when.fireAt })
  assert.equal(item.id, 'r1')

  const [first] = clock.active()
  assert.equal(first.delay, MAX_TIMEOUT_DELAY_MS)
  clock.advance(first.delay)
  const [second] = clock.active()
  assert.equal(second.delay, 30 * DAY_MS - MAX_TIMEOUT_DELAY_MS)
  assert.equal(scheduler.list().length, 1)

  clock.advance(second.delay)
  await settle()
  assert.deepEqual(calls, ['r1'])
  assert.equal(scheduler.list().length, 0)

  first.callback()
  second.callback()
  await settle()
  assert.deepEqual(calls, ['r1'])
})

test('subscription waits longer than the Node timer limit in safe segments and fires once', async (t) => {
  const clock = fakeClock()
  const calls = []
  const scheduler = new SubscriptionScheduler({
    stateRoot: stateRoot(t, 'weixin-subscription-long-'),
    fire: (item) => calls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())

  const when = parseSubscriptionWhen('30d', new Date(clock.now()))
  assert.equal(when.ok, true)
  scheduler.schedule({ accountId: 'a', conversationId: 'c', prompt: 'topic', when })

  const [first] = clock.active()
  assert.equal(first.delay, MAX_TIMEOUT_DELAY_MS)
  clock.advance(first.delay)
  const [second] = clock.active()
  assert.equal(second.delay, 30 * DAY_MS - MAX_TIMEOUT_DELAY_MS)
  assert.equal(scheduler.list().length, 1)

  clock.advance(second.delay)
  await settle()
  assert.deepEqual(calls, ['s1'])
  assert.equal(scheduler.list().length, 0)

  first.callback()
  second.callback()
  await settle()
  assert.deepEqual(calls, ['s1'])
})

test('cancelling either scheduler prevents stale segmented callbacks from firing', async (t) => {
  const clock = fakeClock()
  const reminderCalls = []
  const reminder = new ReminderScheduler({
    stateRoot: stateRoot(t, 'weixin-reminder-cancel-'),
    fire: (item) => reminderCalls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => reminder.stop())
  reminder.schedule({ accountId: 'a', conversationId: 'c', text: 'water', fireAt: clock.now() + 30 * DAY_MS })
  const [reminderTimer] = clock.active()
  assert.equal(reminder.cancel('r1'), true)
  assert.equal(reminderTimer.cleared, true)
  reminderTimer.callback()
  await settle()
  assert.deepEqual(reminderCalls, [])
  assert.equal(reminder.list().length, 0)

  const subscriptionCalls = []
  const subscription = new SubscriptionScheduler({
    stateRoot: stateRoot(t, 'weixin-subscription-cancel-'),
    fire: (item) => subscriptionCalls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => subscription.stop())
  subscription.schedule({
    accountId: 'a',
    conversationId: 'c',
    prompt: 'topic',
    when: { ok: true, kind: 'once', fireAt: clock.now() + 30 * DAY_MS },
  })
  const [subscriptionTimer] = clock.active()
  assert.equal(subscription.cancel('s1'), true)
  assert.equal(subscriptionTimer.cleared, true)
  subscriptionTimer.callback()
  await settle()
  assert.deepEqual(subscriptionCalls, [])
  assert.equal(subscription.list().length, 0)
})

test('resetting a reminder clears every old segment and leaves one live timer', async (t) => {
  const clock = fakeClock()
  const calls = []
  const scheduler = new ReminderScheduler({
    stateRoot: stateRoot(t, 'weixin-reminder-reset-'),
    fire: (item) => calls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())

  const start = clock.now()
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'water', fireAt: start + 30 * DAY_MS })
  const [first] = clock.active()

  scheduler.snoozeById('r1', 1, start)
  const [second] = clock.active()
  assert.equal(first.cleared, true)
  assert.notEqual(second, first)
  assert.equal(scheduler.list()[0].fireAt, start + 30 * DAY_MS + 60_000)
  first.callback()
  await settle()
  assert.deepEqual(calls, [])
  assert.equal(clock.active().length, 1)

  scheduler.snoozeById('r1', 1, start)
  const [third] = clock.active()
  assert.equal(second.cleared, true)
  assert.notEqual(third, second)
  second.callback()
  await settle()
  assert.deepEqual(calls, [])
  assert.equal(clock.active().length, 1)

  scheduler.stop()
  assert.equal(third.cleared, true)
  assert.equal(clock.active().length, 0)
})

test('recurring reminders and subscriptions re-arm with one live timer', async (t) => {
  const clock = fakeClock(new Date(2026, 0, 1, 8, 0, 0, 0).getTime())
  const reminderCalls = []
  const reminder = new ReminderScheduler({
    stateRoot: stateRoot(t, 'weixin-reminder-recurring-'),
    fire: (item) => reminderCalls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => reminder.stop())
  reminder.schedule({
    accountId: 'a',
    conversationId: 'c',
    text: 'daily',
    fireAt: clock.now() + 1_000,
    recurrence: { kind: 'daily' },
    hour: 9,
    minute: 0,
  })
  const [reminderTimer] = clock.active()
  clock.advance(1_000)
  await settle()
  assert.deepEqual(reminderCalls, ['r1'])
  assert.equal(reminder.list().length, 1)
  assert.equal(clock.active().length, 1)
  reminderTimer.callback()
  await settle()
  assert.deepEqual(reminderCalls, ['r1'])
  assert.equal(clock.active().length, 1)
  reminder.stop()

  const subscriptionCalls = []
  const subscription = new SubscriptionScheduler({
    stateRoot: stateRoot(t, 'weixin-subscription-recurring-'),
    fire: (item) => subscriptionCalls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => subscription.stop())
  subscription.schedule({
    accountId: 'a',
    conversationId: 'c',
    prompt: 'daily',
    when: { ok: true, kind: 'daily', time: '09:00' },
  })
  const [subscriptionTimer] = clock.active()
  clock.advance(subscriptionTimer.delay)
  await settle()
  assert.deepEqual(subscriptionCalls, ['s1'])
  assert.equal(subscription.list().length, 1)
  assert.equal(clock.active().length, 1)
  subscriptionTimer.callback()
  await settle()
  assert.deepEqual(subscriptionCalls, ['s1'])
  assert.equal(clock.active().length, 1)
})

test('overdue one-shot reminders and subscriptions fire once instead of being lost', async (t) => {
  const clock = fakeClock()
  const reminderCalls = []
  const reminder = new ReminderScheduler({
    stateRoot: stateRoot(t, 'weixin-reminder-overdue-'),
    fire: (item) => reminderCalls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => reminder.stop())
  reminder.schedule({ accountId: 'a', conversationId: 'c', text: 'late', fireAt: clock.now() - 1 })
  const [reminderTimer] = clock.active()
  assert.equal(reminderTimer.delay, 0)
  clock.advance(0)
  await settle()
  reminderTimer.callback()
  await settle()
  assert.deepEqual(reminderCalls, ['r1'])
  assert.equal(reminder.list().length, 0)

  const subscriptionCalls = []
  const subscription = new SubscriptionScheduler({
    stateRoot: stateRoot(t, 'weixin-subscription-overdue-'),
    fire: (item) => subscriptionCalls.push(item.id),
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => subscription.stop())
  subscription.schedule({
    accountId: 'a',
    conversationId: 'c',
    prompt: 'late',
    when: { ok: true, kind: 'once', fireAt: clock.now() - 1 },
  })
  const [subscriptionTimer] = clock.active()
  assert.equal(subscriptionTimer.delay, 0)
  clock.advance(0)
  await settle()
  subscriptionTimer.callback()
  await settle()
  assert.deepEqual(subscriptionCalls, ['s1'])
  assert.equal(subscription.list().length, 0)
})
