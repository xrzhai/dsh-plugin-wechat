import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { atomicWriteJson } from '../../src/atomic.js'
import { createOutbox, outboxFile, BASE_RETRY_MS, CONTEXT_TOKEN_TTL_MS, MAX_ATTEMPTS, MAX_ITEMS } from '../../src/message/outbox.js'

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

test('overlapping manual and timer-style flushes share a pass; a later flush sends new items', async (t) => {
  const gate = deferred(), started = deferred(), calls = []
  const f = fixture(t, (message) => { calls.push(message.text); started.resolve(); return gate.promise })
  f.enqueue('first')
  const first = f.outbox.flush()
  const immediate = f.outbox.flush({ force: true })
  assert.equal(first, immediate)
  await started.promise
  f.enqueue('new')
  const overlapping = f.outbox.flush({ force: true })
  assert.equal(first, overlapping)
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

test('expired tokens retry tokenless; live tokens and parked-item cleanup retain their behavior', async (t) => {
  const calls = []
  const f = fixture(t, async (message) => { calls.push(message) })
  f.enqueue('expired', { contextToken: 'expired-token' })
  f.advance(CONTEXT_TOKEN_TTL_MS)
  f.enqueue('live', { contextToken: 'live-token' })
  const items = f.outbox.pending()
  atomicWriteJson(outboxFile(f.stateRoot), { schemaVersion: 1, items: [
    { ...items[0], id: 'dead', text: 'dead', attempts: MAX_ATTEMPTS },
    { ...items[1], id: 'parked', text: 'parked', contextToken: undefined, attempts: MAX_ATTEMPTS },
    ...items,
  ] })
  assert.deepEqual(await f.outbox.flush({ force: true }), { sent: 2, failed: 0, remaining: 1 })
  assert.deepEqual(calls.map((message) => message.contextToken), [undefined, 'live-token'])
  assert.deepEqual(f.outbox.pending().map((item) => item.text), ['parked'])
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
