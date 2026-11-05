import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MAX_TIMEOUT_DELAY_MS } from '../../src/message/long-timer.js'
import { ReminderScheduler, parseWhen, readReminders, writeReminders } from '../../src/message/scheduler.js'
import { SubscriptionScheduler, parseSubscriptionWhen, readSubscriptions, writeSubscriptions } from '../../src/message/subscriptions.js'

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

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
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

test('preloaded overdue reminder survives an unavailable transport and wakes immediately', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-restart-')
  writeReminders(root, {
    seq: 1,
    items: [{
      id: 'r1',
      accountId: 'a',
      conversationId: 'c',
      text: 'restart reminder',
      fireAt: clock.now() - 1,
      createdAt: new Date(clock.now() - 60_000).toISOString(),
    }],
  })
  const calls = []
  let available = false
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async (item) => {
      calls.push(item.id)
      if (!available) throw new Error('transport not registered')
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())

  clock.advance(0)
  await settle()
  assert.deepEqual(calls, ['r1'])
  assert.equal(scheduler.list().length, 1)
  assert.equal(readReminders(root).items[0].id, 'r1')
  assert.equal(clock.active()[0].delay, 1_000)

  available = true
  scheduler.wake('a')
  assert.equal(clock.active()[0].delay, 0)
  clock.advance(0)
  await settle()
  assert.deepEqual(calls, ['r1', 'r1'])
  assert.equal(scheduler.list().length, 0)
  assert.deepEqual(readReminders(root).items, [])
})

test('unavailable reminder retries with capped exponential backoff instead of spinning', async (t) => {
  const clock = fakeClock()
  const scheduler = new ReminderScheduler({
    stateRoot: stateRoot(t, 'weixin-reminder-backoff-'),
    fire: async () => { throw new Error('offline') },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'retry', fireAt: clock.now() })
  clock.advance(0)
  await settle()

  for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
    const [timer] = clock.active()
    assert.equal(timer.delay, expected)
    clock.advance(timer.delay)
    await settle()
    assert.equal(scheduler.list().length, 1)
  }
  assert.equal(clock.active()[0].delay, 30_000)
})

test('cancelling or stopping a reminder clears retry work without consuming the durable row', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-retry-control-')
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => { throw new Error('offline') },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'keep me', fireAt: clock.now() + 100 })
  clock.advance(100)
  await settle()
  assert.equal(scheduler.list().length, 1)
  assert.equal(clock.active()[0].delay, 1_000)

  assert.equal(scheduler.cancel('r1'), true)
  assert.equal(clock.active().length, 0)
  assert.deepEqual(readReminders(root).items, [])

  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'survive stop', fireAt: clock.now() + 100 })
  clock.advance(100)
  await settle()
  await scheduler.stop()
  assert.equal(clock.active().length, 0)
  assert.equal(readReminders(root).items[0].text, 'survive stop')
})

test('stop returns while a reminder delivery is still unresolved', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-stop-unresolved-')
  const started = deferred()
  const never = deferred()
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => {
      started.resolve()
      await never.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'pending', fireAt: clock.now() })
  clock.advance(0)
  await started.promise

  assert.equal(scheduler.inFlight.size, 1)
  scheduler.stop()
  assert.equal(scheduler.inFlight.size, 0)
  assert.equal(readReminders(root).items[0].text, 'pending')
  assert.equal(clock.active().length, 0)
})

test('a delivery settling after stop neither commits nor retries', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-stop-late-settle-')
  const started = deferred()
  const finish = deferred()
  const calls = []
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => {
      calls.push('fire')
      started.resolve()
      await finish.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'keep after stop', fireAt: clock.now() })
  clock.advance(0)
  await started.promise

  scheduler.stop()
  finish.reject(new Error('late failure'))
  await settle()
  assert.deepEqual(calls, ['fire'])
  assert.equal(readReminders(root).items[0].text, 'keep after stop')
  assert.equal(clock.active().length, 0)
})

test('snooze during a successful reminder delivery keeps the new schedule', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-snooze-resolve-')
  const started = deferred()
  const finish = deferred()
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => {
      started.resolve()
      await finish.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'snoozed', fireAt: clock.now() + 100 })
  clock.advance(100)
  await started.promise
  assert.ok(scheduler.snoozeById('r1', 5, clock.now()))
  const snoozedAt = scheduler.list()[0].fireAt

  finish.resolve()
  await settle()
  assert.equal(scheduler.list().length, 1)
  assert.equal(scheduler.list()[0].fireAt, snoozedAt)
  assert.equal(readReminders(root).items[0].fireAt, snoozedAt)
  assert.equal(clock.active()[0].delay, snoozedAt - clock.now())
})

test('snooze during a failed reminder delivery cancels the stale retry', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-snooze-reject-')
  const started = deferred()
  const finish = deferred()
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => {
      started.resolve()
      await finish.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'snoozed', fireAt: clock.now() + 100 })
  clock.advance(100)
  await started.promise
  assert.ok(scheduler.snoozeById('r1', 5, clock.now()))
  const snoozedAt = scheduler.list()[0].fireAt

  finish.reject(new Error('stale delivery failed'))
  await settle()
  assert.equal(scheduler.list()[0].fireAt, snoozedAt)
  assert.equal(readReminders(root).items[0].fireAt, snoozedAt)
  assert.equal(clock.active()[0].delay, snoozedAt - clock.now())
  assert.notEqual(clock.active()[0].delay, 1_000)
})

for (const oldOutcome of ['resolve', 'reject']) {
  test(`a snoozed reminder fires after the old request ${oldOutcome}s first`, async (t) => {
    const clock = fakeClock()
    const root = stateRoot(t, `weixin-reminder-snooze-race-${oldOutcome}-`)
    const started = deferred()
    const oldFinish = deferred()
    let calls = 0
    const scheduler = new ReminderScheduler({
      stateRoot: root,
      fire: async () => {
        calls += 1
        if (calls !== 1) return
        started.resolve()
        await oldFinish.promise
        if (oldOutcome === 'reject') throw new Error('old request failed')
      },
      warn: () => {},
      nowRef: clock.now,
      setTimeoutRef: clock.setTimeoutRef,
      clearTimeoutRef: clock.clearTimeoutRef,
    })
    t.after(() => scheduler.stop())
    scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'race', fireAt: clock.now() + 100 })
    clock.advance(100)
    await started.promise

    assert.ok(scheduler.snoozeById('r1', 1, clock.now()))
    const rescheduledAt = scheduler.list()[0].fireAt
    clock.advance(rescheduledAt - clock.now())
    await settle()
    assert.equal(calls, 1)
    assert.equal(scheduler.pendingAttempts.has('r1'), true)
    assert.equal(clock.active().length, 0)

    if (oldOutcome === 'resolve') oldFinish.resolve()
    else oldFinish.reject(new Error('old request failed'))
    await settle()
    assert.equal(scheduler.pendingAttempts.has('r1'), false)
    assert.equal(clock.active()[0].delay, 0)
    assert.equal(readReminders(root).items[0].fireAt, rescheduledAt)

    clock.advance(0)
    await settle()
    assert.equal(calls, 2)
    assert.deepEqual(readReminders(root).items, [])
    assert.equal(clock.active().length, 0)
  })
}

test('skip during a failed recurring delivery keeps the skipped plan', async (t) => {
  const clock = fakeClock(new Date(2026, 0, 1, 8, 0, 0, 0).getTime())
  const root = stateRoot(t, 'weixin-reminder-skip-reject-')
  const started = deferred()
  const finish = deferred()
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => {
      started.resolve()
      await finish.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())
  scheduler.schedule({
    accountId: 'a',
    conversationId: 'c',
    text: 'daily',
    fireAt: clock.now() + 100,
    recurrence: { kind: 'daily' },
    hour: 9,
    minute: 0,
  })
  clock.advance(100)
  await started.promise
  assert.ok(scheduler.skipNext('a'))
  const skippedAt = scheduler.list()[0].scheduledFor

  finish.reject(new Error('stale delivery failed'))
  await settle()
  assert.equal(scheduler.list()[0].scheduledFor, skippedAt)
  assert.equal(readReminders(root).items[0].scheduledFor, skippedAt)
  assert.equal(clock.active()[0].delay, skippedAt - clock.now())
  assert.notEqual(clock.active()[0].delay, 1_000)
})

for (const oldOutcome of ['resolve', 'reject']) {
  test(`a skipped recurring reminder fires after the old request ${oldOutcome}s first`, async (t) => {
    const clock = fakeClock(new Date(2026, 0, 1, 8, 0, 0, 0).getTime())
    const root = stateRoot(t, `weixin-reminder-skip-race-${oldOutcome}-`)
    const started = deferred()
    const oldFinish = deferred()
    let calls = 0
    const scheduler = new ReminderScheduler({
      stateRoot: root,
      fire: async () => {
        calls += 1
        if (calls !== 1) return
        started.resolve()
        await oldFinish.promise
        if (oldOutcome === 'reject') throw new Error('old request failed')
      },
      warn: () => {},
      nowRef: clock.now,
      setTimeoutRef: clock.setTimeoutRef,
      clearTimeoutRef: clock.clearTimeoutRef,
    })
    t.after(() => scheduler.stop())
    scheduler.schedule({
      accountId: 'a',
      conversationId: 'c',
      text: 'daily',
      fireAt: clock.now() + 100,
      recurrence: { kind: 'daily' },
      hour: 9,
      minute: 0,
    })
    clock.advance(100)
    await started.promise

    assert.ok(scheduler.skipNext('a'))
    const skippedAt = scheduler.list()[0].scheduledFor
    clock.advance(skippedAt - clock.now())
    await settle()
    assert.equal(calls, 1)
    assert.equal(scheduler.pendingAttempts.has('r1'), true)
    assert.equal(clock.active().length, 0)

    if (oldOutcome === 'resolve') oldFinish.resolve()
    else oldFinish.reject(new Error('old request failed'))
    await settle()
    assert.equal(scheduler.pendingAttempts.has('r1'), false)
    assert.equal(clock.active()[0].delay, 0)
    assert.equal(readReminders(root).items[0].scheduledFor, skippedAt)

    clock.advance(0)
    await settle()
    assert.equal(calls, 2)
    assert.equal(scheduler.list().length, 1)
    assert.equal(scheduler.list()[0].scheduledFor, new Date(2026, 0, 2, 9, 0, 0, 0).getTime())
  })
}

test('cancel during a failed reminder delivery leaves no retry behind', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-cancel-reject-')
  const started = deferred()
  const finish = deferred()
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => {
      started.resolve()
      await finish.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'cancel me', fireAt: clock.now() })
  clock.advance(0)
  await started.promise
  assert.equal(scheduler.cancel('r1'), true)

  finish.reject(new Error('stale delivery failed'))
  await settle()
  assert.deepEqual(readReminders(root).items, [])
  assert.equal(clock.active().length, 0)
  scheduler.stop()
})

test('cancelling during delivery prevents a late acknowledgement from resurrecting the reminder', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-reminder-cancel-inflight-')
  const started = deferred()
  const finish = deferred()
  const scheduler = new ReminderScheduler({
    stateRoot: root,
    fire: async () => {
      started.resolve()
      await finish.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  scheduler.schedule({ accountId: 'a', conversationId: 'c', text: 'cancelled', fireAt: clock.now() })
  clock.advance(0)
  await started.promise

  assert.equal(scheduler.cancel('r1'), true)
  finish.resolve()
  await settle()
  assert.deepEqual(readReminders(root).items, [])
  assert.equal(clock.active().length, 0)
  await scheduler.stop()
})

test('recurring subscription keeps its grace-window catch-up until transport recovery', async (t) => {
  const clock = fakeClock(new Date(2026, 0, 1, 9, 5, 0, 0).getTime())
  const root = stateRoot(t, 'weixin-subscription-restart-')
  writeSubscriptions(root, {
    seq: 1,
    items: [{
      id: 's1',
      accountId: 'a',
      conversationId: 'c',
      prompt: 'daily check-in',
      kind: 'daily',
      time: '09:00',
      fireAt: clock.now() - 5 * 60_000,
      createdAt: clock.now() - 24 * 60 * 60_000,
    }],
  })
  const calls = []
  let available = false
  const scheduler = new SubscriptionScheduler({
    stateRoot: root,
    fire: async (item) => {
      calls.push(item.id)
      if (!available) throw new Error('transport not registered')
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())

  clock.advance(0)
  await settle()
  assert.deepEqual(calls, ['s1'])
  assert.equal(scheduler.list().length, 1)
  assert.equal(readSubscriptions(root).items[0].fireAt, clock.now() - 5 * 60_000)

  available = true
  scheduler.wake('a')
  clock.advance(0)
  await settle()
  assert.deepEqual(calls, ['s1', 's1'])
  assert.equal(scheduler.list().length, 1)
  assert.equal(scheduler.list()[0].fireAt, new Date(2026, 0, 2, 9, 0, 0, 0).getTime())
})

test('subscription stop does not wait for an unresolved generation call', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-subscription-stop-unresolved-')
  const started = deferred()
  const never = deferred()
  const scheduler = new SubscriptionScheduler({
    stateRoot: root,
    fire: async () => {
      started.resolve()
      await never.promise
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  scheduler.schedule({
    accountId: 'a',
    conversationId: 'c',
    prompt: 'slow generation',
    when: { ok: true, kind: 'once', fireAt: clock.now() },
  })
  clock.advance(0)
  await started.promise

  assert.equal(scheduler.inFlight.size, 1)
  scheduler.stop()
  assert.equal(scheduler.inFlight.size, 0)
  assert.equal(readSubscriptions(root).items[0].id, 's1')
  assert.equal(clock.active().length, 0)
})

test('subscription wake during an in-flight failure retains one immediate retry', async (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-subscription-wake-inflight-')
  const started = deferred()
  const oldFinish = deferred()
  let calls = 0
  const scheduler = new SubscriptionScheduler({
    stateRoot: root,
    fire: async () => {
      calls += 1
      if (calls !== 1) return
      started.resolve()
      await oldFinish.promise
      throw new Error('old generation failed')
    },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())
  scheduler.schedule({
    accountId: 'a',
    conversationId: 'c',
    prompt: 'retry once',
    when: { ok: true, kind: 'once', fireAt: clock.now() },
  })
  clock.advance(0)
  await started.promise

  const rescheduledAt = clock.now() + 500
  scheduler.store.items[0].fireAt = rescheduledAt
  writeSubscriptions(root, scheduler.store)
  clock.advance(500)
  scheduler.wake('a')
  assert.equal(scheduler.pendingAttempts.has('s1'), true)
  oldFinish.reject(new Error('transport temporarily unavailable'))
  await settle()
  assert.equal(scheduler.pendingAttempts.has('s1'), false)
  assert.equal(clock.active().length, 1)
  assert.equal(clock.active()[0].delay, 0)
  assert.equal(readSubscriptions(root).items[0].fireAt, rescheduledAt)

  clock.advance(0)
  await settle()
  assert.equal(calls, 2)
  assert.deepEqual(readSubscriptions(root).items, [])
  assert.equal(clock.active().length, 0)
})

test('stale one-shot subscription remains dropped when loaded after restart', (t) => {
  const clock = fakeClock()
  const root = stateRoot(t, 'weixin-subscription-stale-once-')
  writeSubscriptions(root, {
    seq: 1,
    items: [{
      id: 's1',
      accountId: 'a',
      conversationId: 'c',
      prompt: 'stale',
      kind: 'once',
      fireAt: clock.now() - 1,
      createdAt: clock.now() - 60_000,
    }],
  })
  const scheduler = new SubscriptionScheduler({
    stateRoot: root,
    fire: () => { throw new Error('must not fire') },
    warn: () => {},
    nowRef: clock.now,
    setTimeoutRef: clock.setTimeoutRef,
    clearTimeoutRef: clock.clearTimeoutRef,
  })
  t.after(() => scheduler.stop())
  assert.equal(scheduler.list().length, 0)
  assert.deepEqual(readSubscriptions(root).items, [])
})
