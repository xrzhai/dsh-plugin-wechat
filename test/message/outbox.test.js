import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { atomicWriteJson } from '../../src/atomic.js'
import { createOutbox, outboxFile, BASE_RETRY_MS, CONTEXT_TOKEN_TTL_MS, DEFAULT_OUTBOX_MAX_MESSAGE_LENGTH, MAX_ATTEMPTS, MAX_ITEMS } from '../../src/message/outbox.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t, send = async () => {}) {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'weixin-outbox-test-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let at = 1_000_000
  let transport = { send }
  const outbox = createOutbox({ stateRoot, transportFor: () => transport, now: () => at })
  const enqueue = (text, options = {}) => outbox.enqueue({ accountId: 'a', conversationId: 'c', text, ...options })
  return { outbox, enqueue, stateRoot, advance: (ms) => { at += ms }, setTransport: (value) => { transport = value } }
}

for (const succeeds of [true, false]) {
  test(`enqueue during ${succeeds ? 'successful' : 'failed'} send survives and next flush preserves order`, async (t) => {
    const gate = deferred(), started = deferred(), calls = []
    const f = fixture(t, (message) => {
      calls.push(message.text)
      started.resolve()
      return calls.length === 1 ? gate.promise : Promise.resolve()
    })
    f.enqueue('first')
    const flush = f.outbox.flush()
    await started.promise
    f.enqueue('new')
    if (succeeds) gate.resolve()
    else gate.reject(new Error('offline'))
    assert.deepEqual(await flush, { sent: succeeds ? 1 : 0, failed: succeeds ? 0 : 1, remaining: succeeds ? 1 : 2 })
    assert.deepEqual(f.outbox.pending().map((item) => item.text), succeeds ? ['new'] : ['first', 'new'])
    if (!succeeds) {
      assert.equal(f.outbox.pending()[0].attempts, 1)
      assert.equal(f.outbox.pending()[0].lastError, 'offline')
      assert.equal(f.outbox.pending()[0].notBefore, 1_000_000 + BASE_RETRY_MS)
      assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 0, remaining: 2 })
      f.advance(BASE_RETRY_MS)
    }
    await f.outbox.flush()
    assert.deepEqual(calls, succeeds ? ['first', 'new'] : ['first', 'first', 'new'])
    assert.deepEqual(f.outbox.pending(), [])
  })

  test(`drop while send ${succeeds ? 'succeeds' : 'fails'} never resurrects current or waiting items`, async (t) => {
    const gate = deferred(), started = deferred(), calls = []
    const f = fixture(t, (message) => { calls.push(message.text); started.resolve(); return gate.promise })
    const first = f.enqueue('first')
    const second = f.enqueue('second')
    const flush = f.outbox.flush()
    await started.promise
    assert.equal(f.outbox.drop(first), true)
    assert.equal(f.outbox.drop(second), true)
    f.enqueue('new')
    if (succeeds) gate.resolve()
    else gate.reject(new Error('offline'))
    const result = await flush
    assert.equal(result.remaining, 1)
    assert.deepEqual(calls, ['first'])
    assert.deepEqual(f.outbox.pending().map((item) => item.text), ['new'])
  })
}

test('overlapping manual and timer requests count their shared send once and leave new items for later', async (t) => {
  const gate = deferred(), started = deferred(), calls = []
  const f = fixture(t, (message) => { calls.push(message.text); started.resolve(); return gate.promise })
  f.enqueue('first')
  const first = f.outbox.flush()
  const immediate = f.outbox.flush({ force: true })
  assert.notEqual(first, immediate)
  await started.promise
  f.enqueue('new')
  const overlapping = f.outbox.flush({ force: true })
  assert.equal(immediate, overlapping)
  assert.deepEqual(calls, ['first'])
  gate.resolve()
  const results = await Promise.all([first, immediate, overlapping])
  for (const result of results) assert.deepEqual(result, { sent: 1, failed: 0, remaining: 1 })
  assert.deepEqual(await f.outbox.flush(), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['first', 'new'])
})

test('synchronous send re-entry sees the in-flight guard', async (t) => {
  let reentrant, calls = 0
  const f = fixture(t, () => { calls++; reentrant = f.outbox.flush(); return Promise.resolve() })
  f.enqueue('first')
  const first = f.outbox.flush()
  await first
  assert.equal(reentrant, first)
  assert.equal(calls, 1)
})

test('scoped manual retry touches and counts only the requested account and conversation', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message.text) })
  for (const [accountId, conversationId, text] of [['a', 'c', 'mine'], ['b', 'c', 'other account'], ['a', 'd', 'other chat']]) {
    f.enqueue(text, { accountId, conversationId, deliveryUncertain: true })
  }
  for (const scope of [{ accountId: 'a' }, { conversationId: 'c' }, { accountId: undefined, conversationId: undefined }]) {
    await assert.rejects(f.outbox.flush({ force: true, ...scope }), /requires both/)
  }
  const scope = { force: true, accountId: 'a', conversationId: 'c' }
  f.setTransport(undefined)
  assert.deepEqual(await f.outbox.flush(scope), { sent: 0, failed: 0, remaining: 1, unavailable: 1 })
  f.setTransport({ send: async (message) => { calls.push(message.text) } })
  assert.deepEqual(await f.outbox.flush(scope), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['mine'])
  assert.deepEqual(f.outbox.pending().map((item) => item.text), ['other account', 'other chat'])
})

test('scoped retries queued behind a timer recover skipped rows without replaying its uncertain send', async (t) => {
  const gate = deferred(), started = deferred(), calls = []
  const f = fixture(t, async ({ text }) => {
    calls.push(text)
    if (text === 'in flight') {
      started.resolve()
      await gate.promise
      throw Object.assign(new Error('response lost'), { deliveryUncertain: true })
    }
  })
  f.enqueue('parked', { conversationId: 'd', deliveryUncertain: true })
  f.enqueue('in flight')
  const timer = f.outbox.flush()
  await started.promise
  const retry = (conversationId) => f.outbox.flush({ force: true, accountId: 'a', conversationId })
  const sameChat = retry('c'), otherChat = retry('d')
  assert.equal(otherChat, retry('d'))
  gate.resolve()
  assert.deepEqual(await timer, { sent: 0, failed: 1, remaining: 2 })
  assert.deepEqual(await sameChat, { sent: 0, failed: 1, remaining: 1 })
  assert.deepEqual(await otherChat, { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['in flight', 'parked'])
})

test('missing transport does not spend retry budget, blocks its conversation, and recovers', async (t) => {
  const calls = []
  const f = fixture(t)
  f.enqueue('first')
  f.enqueue('second')
  f.setTransport(undefined)
  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 0, remaining: 2 })
  const items = f.outbox.pending()
  assert.equal(items[0].lastError, 'no live transport')
  assert.deepEqual(items.map((item) => item.attempts), [0, 0])
  f.setTransport({ send: async (message) => { calls.push(message.text) } })
  assert.deepEqual(await f.outbox.flush(), { sent: 2, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['first', 'second'])
})

test('a failed conversation stays ordered without blocking other conversations', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message.text); if (message.text === 'first') throw new Error('offline') })
  f.enqueue('first')
  f.enqueue('second')
  f.enqueue('other', { conversationId: 'other' })
  assert.deepEqual(await f.outbox.flush(), { sent: 1, failed: 1, remaining: 2 })
  assert.deepEqual(calls, ['first', 'other'])
  assert.deepEqual(f.outbox.pending().map((item) => item.text), ['first', 'second'])
})

test('expired tokens retry tokenless and live tokens are preserved', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message) })
  f.enqueue('expired', { contextToken: 'expired-token' })
  f.advance(CONTEXT_TOKEN_TTL_MS)
  f.enqueue('live', { contextToken: 'live-token' })
  assert.deepEqual(await f.outbox.flush(), { sent: 2, failed: 0, remaining: 0 })
  assert.deepEqual(calls.map((message) => message.contextToken), [undefined, 'live-token'])
})

test('manual retry recovers an exhausted item after token expiry without reopening its timer budget', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message); throw new Error('offline') })
  f.enqueue('only copy', { contextToken: 'live' })
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    assert.deepEqual(await f.outbox.flush({ force: true }), { sent: 0, failed: 1, remaining: 1 })
  }
  f.advance(24 * 60 * 60_000)
  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 0, remaining: 1 })
  assert.equal(calls.length, MAX_ATTEMPTS)
  assert.equal(f.outbox.pending()[0].text, 'only copy')

  f.setTransport(undefined)
  const offline = await f.outbox.flush({ force: true })
  assert.deepEqual(offline, { sent: 0, failed: 0, remaining: 1, unavailable: 1 })
  assert.equal(f.outbox.pending()[0].lastError, 'no live transport')
  assert.equal(f.outbox.pending()[0].attempts, MAX_ATTEMPTS)

  f.setTransport({ send: async () => { throw new Error('still offline') } })
  assert.deepEqual(await f.outbox.flush({ force: true }), { sent: 0, failed: 1, remaining: 1 })
  f.advance(24 * 60 * 60_000)
  f.setTransport({ send: async (message) => { calls.push(message) } })
  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 0, remaining: 1 })
  assert.deepEqual(await f.outbox.flush({ force: true }), { sent: 1, failed: 0, remaining: 0 })
  assert.equal(calls.length, MAX_ATTEMPTS + 1)
  assert.equal(calls.at(-1).text, 'only copy')
  assert.equal(calls.at(-1).contextToken, undefined)
})

test('uncertain direct sends enter the durable queue for manual retry only', async (t) => {
  const calls = []
  const f = fixture(t)
  f.enqueue('unknown', { deliveryUncertain: true, contextToken: 'live' })
  const transport = { send: async (message) => { calls.push(message.contextToken) } }
  const restarted = createOutbox({ stateRoot: f.stateRoot, transportFor: () => transport, now: () => 1_000_001 })
  assert.deepEqual(await restarted.flush(), { sent: 0, failed: 0, remaining: 1 })
  assert.deepEqual(calls, [])
  assert.deepEqual(await restarted.flush({ force: true }), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['live'])
})

test('uncertain segment stays parked across expiry and failed manual retry; confirmed prefix is never replayed', async (t) => {
  const calls = []
  const f = fixture(t, async ({ text }) => {
    calls.push(text)
    if (text === 'middle') throw Object.assign(new Error('response lost'), { deliveryUncertain: true })
  })
  f.enqueue('firstmiddletail', { segments: ['first', 'middle', 'tail'], contextToken: 'token' })
  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 1, remaining: 1 })
  assert.equal(f.outbox.pending()[0].nextSegment, 1)
  f.advance(CONTEXT_TOKEN_TTL_MS)
  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 0, remaining: 1 })
  f.setTransport({ send: async ({ text }) => { calls.push(text); throw new Error('offline') } })
  assert.deepEqual(await f.outbox.flush({ force: true }), { sent: 0, failed: 1, remaining: 1 })
  f.advance(CONTEXT_TOKEN_TTL_MS)
  f.setTransport({ send: async ({ text, contextToken }) => { assert.equal(contextToken, undefined); calls.push(text) } })
  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 0, remaining: 1 })
  assert.deepEqual(await f.outbox.flush({ force: true }), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['first', 'middle', 'middle', 'middle', 'tail'])
})

test('queue-cap eviction during a failed send is not undone', async (t) => {
  const gate = deferred(), started = deferred()
  const f = fixture(t, () => { started.resolve(); return gate.promise })
  f.enqueue('old')
  const flush = f.outbox.flush()
  await started.promise
  for (let i = 0; i < MAX_ITEMS; i++) f.enqueue(`new-${i}`)
  gate.reject(new Error('offline'))
  assert.equal((await flush).remaining, MAX_ITEMS)
  assert.equal(f.outbox.pending()[0].text, 'new-0')
  assert.equal(f.outbox.pending().some((item) => item.text === 'old'), false)
})

test('unexpected flush rejection releases single-flight guard for retry', async (t) => {
  const f = fixture(t)
  f.enqueue('first')
  const outbox = createOutbox({ stateRoot: f.stateRoot, transportFor: () => { throw new Error('lookup failed') } })
  await assert.rejects(outbox.flush(), /lookup failed/)
  await assert.rejects(outbox.flush(), /lookup failed/)
  assert.equal(outbox.pending().length, 1)
})

test('legacy text rows migrate and send within the default cap', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message.text) })
  const longText = 'a'.repeat(DEFAULT_OUTBOX_MAX_MESSAGE_LENGTH + 7)
  atomicWriteJson(outboxFile(f.stateRoot), {
    schemaVersion: 1,
    items: [{
      id: 'legacy',
      accountId: 'a',
      conversationId: 'c',
      text: longText,
      createdAt: 1_000_000,
      attempts: 0,
      notBefore: 1_000_000,
      lastError: '',
    }],
  })

  const [item] = f.outbox.pending()
  assert.equal(item.maxMessageLength, DEFAULT_OUTBOX_MAX_MESSAGE_LENGTH)
  assert.deepEqual(item.segments.map((segment) => segment.length), [DEFAULT_OUTBOX_MAX_MESSAGE_LENGTH, 7])
  assert.equal(f.outbox.pending()[0].nextSegment, 0)
  assert.deepEqual(await f.outbox.flush(), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['a'.repeat(DEFAULT_OUTBOX_MAX_MESSAGE_LENGTH), 'a'.repeat(7)])
})

test('stored segments over a lower queue-time cap are split and progress is remapped', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message.text) })
  atomicWriteJson(outboxFile(f.stateRoot), {
    schemaVersion: 2,
    items: [{
      id: 'segmented-legacy',
      accountId: 'a',
      conversationId: 'c',
      text: `${'x'.repeat(10)}${'y'.repeat(10)}`,
      segments: ['x'.repeat(10), 'y'.repeat(10)],
      nextSegment: 1,
      maxMessageLength: 5,
      createdAt: 1_000_000,
      attempts: 0,
      notBefore: 1_000_000,
      lastError: '',
    }],
  })

  const [item] = f.outbox.pending()
  assert.equal(item.maxMessageLength, 5)
  assert.deepEqual(item.segments.map((segment) => segment.length), [5, 5, 5, 5])
  assert.equal(item.nextSegment, 2)
  assert.deepEqual(await f.outbox.flush(), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['y'.repeat(5), 'y'.repeat(5)])
})

test('segmented send persists progress across a failed bubble and a restart', async (t) => {
  const calls = []
  let offline = true
  const f = fixture(t, async (message) => {
    calls.push(message.text)
    if (message.text === 'middle' && offline) {
      offline = false
      throw new Error('offline')
    }
  })
  f.outbox.enqueue({ accountId: 'a', conversationId: 'c', text: 'firstmiddletail', segments: ['first', 'middle', 'tail'] })

  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 1, remaining: 1 })
  assert.deepEqual(f.outbox.pending()[0].segments, ['first', 'middle', 'tail'])
  assert.equal(f.outbox.pending()[0].nextSegment, 1)

  const transport = { send: async (message) => { calls.push(message.text) } }
  const afterRestart = createOutbox({ stateRoot: f.stateRoot, transportFor: () => transport })
  assert.deepEqual(await afterRestart.flush({ force: true }), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, ['first', 'middle', 'middle', 'tail'])
})

test('drop and enqueue during a segmented send keep the new row without releasing old suffixes', async (t) => {
  const gate = deferred(), started = deferred(), calls = []
  const f = fixture(t, async (message) => {
    calls.push(message.text)
    started.resolve()
    await gate.promise
  })
  const old = f.outbox.enqueue({ accountId: 'a', conversationId: 'c', text: 'onetwothree', segments: ['one', 'two', 'three'] })
  const flush = f.outbox.flush()
  await started.promise
  assert.equal(f.outbox.drop(old), true)
  f.enqueue('new')
  gate.resolve()

  assert.deepEqual(await flush, { sent: 0, failed: 0, remaining: 1 })
  assert.deepEqual(calls, ['one'])
  await f.outbox.flush()
  assert.deepEqual(calls, ['one', 'new'])
  assert.deepEqual(f.outbox.pending(), [])
})

for (const change of ['pause', 'replace', 'stop']) {
  test(`segmented delivery preserves its unsent suffix after ${change}`, async (t) => {
    const gate = deferred(), started = deferred(), calls = []
    const f = fixture(t, async (message) => {
      calls.push(`old:${message.text}`)
      started.resolve()
      await gate.promise
    })
    const replacement = { send: async (message) => calls.push(`new:${message.text}`) }
    f.outbox.enqueue({ accountId: 'a', conversationId: 'c', segments: ['first', 'second'] })
    const flush = f.outbox.flush()
    await started.promise
    if (change === 'stop') f.outbox.stop()
    else f.setTransport(change === 'pause' ? undefined : replacement)
    gate.resolve()
    assert.deepEqual(await flush, { sent: 0, failed: 0, remaining: 1 })
    assert.deepEqual(calls, ['old:first'])
    assert.equal(f.outbox.pending()[0].nextSegment, 1)
    f.setTransport(replacement)
    if (change === 'stop') f.outbox.start()
    assert.deepEqual(await f.outbox.flush(), { sent: 1, failed: 0, remaining: 0 })
    f.outbox.stop()
    assert.deepEqual(calls, ['old:first', 'new:second'])
  })
}

test('pausing one account does not block another account in the same flush', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'weixin-outbox-accounts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gate = deferred(), started = deferred(), calls = []
  const transports = new Map([
    ['a', { send: async (message) => { calls.push(`a:${message.text}`); started.resolve(); await gate.promise } }],
    ['b', { send: async (message) => { calls.push(`b:${message.text}`) } }],
  ])
  const outbox = createOutbox({ stateRoot: root, transportFor: (account) => transports.get(account) })
  outbox.enqueue({ accountId: 'a', conversationId: 'chat-a', segments: ['first', 'second'] })
  outbox.enqueue({ accountId: 'b', conversationId: 'chat-b', text: 'independent' })
  const flush = outbox.flush()
  await started.promise
  transports.delete('a')
  gate.resolve()
  assert.deepEqual(await flush, { sent: 1, failed: 0, remaining: 1 })
  assert.deepEqual(calls, ['a:first', 'b:independent'])
  assert.equal(outbox.pending()[0].nextSegment, 1)
})

test('token expiry during a segmented retry strips the token without replaying the prefix', async (t) => {
  const calls = []
  let offline = true
  const f = fixture(t, async (message) => {
    calls.push({ text: message.text, contextToken: message.contextToken })
    if (message.text === 'second' && offline) {
      offline = false
      throw new Error('token route failed')
    }
  })
  f.outbox.enqueue({
    accountId: 'a',
    conversationId: 'c',
    text: 'firstsecond',
    segments: ['first', 'second'],
    contextToken: 'synthetic-token',
  })

  assert.deepEqual(await f.outbox.flush(), { sent: 0, failed: 1, remaining: 1 })
  f.advance(CONTEXT_TOKEN_TTL_MS)
  assert.deepEqual(await f.outbox.flush({ force: true }), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(calls, [
    { text: 'first', contextToken: 'synthetic-token' },
    { text: 'second', contextToken: 'synthetic-token' },
    { text: 'second', contextToken: undefined },
  ])
})

test('enqueue throws and does not report success when the queue cannot be persisted', (t) => {
  const f = fixture(t)
  const originalRename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === outboxFile(f.stateRoot)) throw new Error('simulated rename failure')
    return originalRename(from, to)
  })

  assert.throws(() => f.enqueue('must persist'), /could not persist outbox\.json/)
  assert.deepEqual(f.outbox.pending(), [])
})

test('queue persistence failure after a sent segment stops the flush before the next segment', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message.text) })
  f.outbox.enqueue({ accountId: 'a', conversationId: 'c', text: 'onetwothree', segments: ['one', 'two', 'three'], maxMessageLength: 5 })
  const originalRename = fs.renameSync
  let renameAttempts = 0
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === outboxFile(f.stateRoot)) {
      renameAttempts += 1
      throw new Error('simulated rename failure')
    }
    return originalRename(from, to)
  })

  await assert.rejects(f.outbox.flush(), /could not persist outbox\.json/)
  assert.deepEqual(calls, ['one'])
  assert.equal(renameAttempts, 1)
})
