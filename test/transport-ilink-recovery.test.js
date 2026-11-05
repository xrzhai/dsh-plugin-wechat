import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'node:test'
import { ILinkTransport } from '../src/transport/ilink.js'
import { createInboundPendingStore } from '../src/message/inbound-pending.js'
import { getSyncBufFilePath } from '../vendor/openclaw-weixin/storage/sync-buf.js'

const SENSITIVE_FIXTURE_TOKEN = ['not', 'a', 'real', 'token'].join('-')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function within(promise, label = 'fixture operation') {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const idlePoll = (abortSignal) => new Promise((resolve) => {
  if (abortSignal.aborted) return resolve({ ret: 0 })
  abortSignal.addEventListener('abort', () => resolve({ ret: 0 }), { once: true })
})

const rawText = (id, text = 'synthetic task') => ({
  message_id: id,
  from_user_id: 'user-a',
  group_id: '',
  context_token: SENSITIVE_FIXTURE_TOKEN,
  message_type: 1,
  message_state: 0,
  item_list: [{ type: 1, text_item: { text } }],
  create_time_ms: 1_800_000_000_000,
})

function fixture(t, options = {}) {
  const accountId = `ledger-${crypto.randomUUID()}`
  const warnings = []
  const logs = []
  let release = () => {}
  const transport = new ILinkTransport({
    accountId,
    baseUrl: 'https://invalid.test',
    token: ['synthetic', 'access', 'token'].join('-'),
    notifyStart: async () => ({ ret: 0 }),
    notifyStop: async () => ({ ret: 0 }),
    log: (line) => logs.push(line),
    errLog: (line) => warnings.push(line),
    ...options,
  })
  t.after(async () => {
    release()
    await transport.stop()
  })
  return {
    accountId,
    transport,
    warnings,
    logs,
    setRelease: (fn) => { release = fn },
  }
}

test('the cursor advances only after the message is durable and marks the handler as started', async (t) => {
  const entered = deferred()
  const releaseHandler = deferred()
  const finished = deferred()
  let polls = 0
  const f = fixture(t, {
    getUpdates: async ({ abortSignal }) => {
      polls += 1
      return polls === 1 ? { ret: 0, get_updates_buf: 'cursor-after-message', msgs: [rawText('message-one')] } : idlePoll(abortSignal)
    },
  })
  f.setRelease(() => releaseHandler.resolve())

  await f.transport.start(async () => {
    entered.resolve()
    await releaseHandler.promise
    finished.resolve()
  })
  await within(entered.promise, 'inbound handler start')

  const sync = JSON.parse(fs.readFileSync(f.transport.syncBufPath, 'utf8'))
  assert.equal(sync.get_updates_buf, 'cursor-after-message')
  const duringRun = f.transport.pendingStore.recover()
  assert.deepEqual(duringRun.queued, [])
  assert.equal(duringRun.unresolved, 1)

  releaseHandler.resolve()
  await within(finished.promise, 'inbound handler finish')
  await tick()
  assert.deepEqual(f.transport.pendingStore.recover(), { queued: [], unresolved: 0 })
  assert.ok(f.warnings.every((line) => !line.includes(SENSITIVE_FIXTURE_TOKEN)))
})

test('startup replays only queued records and leaves an interrupted record with an explicit warning', async (t) => {
  const accountId = `ledger-${crypto.randomUUID()}`
  const syncBufPath = getSyncBufFilePath(accountId)
  const store = createInboundPendingStore({ accountId, syncBufPath })
  const safe = store.stage({ id: 'queued-before-crash', type: 'text', text: 'safe to replay', senderId: 'user-a', conversationId: 'chat-a', contextToken: SENSITIVE_FIXTURE_TOKEN })
  const unsafe = store.stage({ id: 'started-before-crash', type: 'text', text: 'unsafe to replay', senderId: 'user-a', conversationId: 'chat-a', contextToken: SENSITIVE_FIXTURE_TOKEN })
  assert.equal(safe.status, 'queued')
  assert.equal(unsafe.status, 'queued')
  assert.equal(store.claim(unsafe.key).ok, true)

  const received = []
  const handled = deferred()
  const f = fixture(t, {
    accountId,
    pendingStore: createInboundPendingStore({ accountId, syncBufPath }),
    getUpdates: ({ abortSignal }) => idlePoll(abortSignal),
  })
  await f.transport.start(async (message) => {
    received.push(message.id)
    handled.resolve()
  })
  await within(handled.promise, 'safe recovery')
  await tick()

  assert.deepEqual(received, ['queued-before-crash'])
  assert.ok(f.warnings.some((line) => line.includes('1 message(s) had started') && line.includes('not replaying')))
  assert.deepEqual(f.transport.pendingStore.recover().queued, [])
  assert.equal(f.transport.pendingStore.recover().unresolved, 1)
})

test('capacity overflow resumes in-process with per-conversation FIFO and /cancel still bypasses', async (t) => {
  const events = {
    a: deferred(),
    cancel: deferred(),
    b: deferred(),
    c: deferred(),
  }
  const gates = {
    a: deferred(),
    b: deferred(),
    c: deferred(),
  }
  const entered = []
  let polls = 0
  const f = fixture(t, {
    maxQueuePerConversation: 1,
    bypassQueue: (message) => message.type === 'text' && message.text === '/cancel',
    getUpdates: async ({ abortSignal }) => {
      polls += 1
      return polls === 1 ? {
        ret: 0,
        get_updates_buf: 'cursor-with-overflow',
        msgs: [
          rawText('overflow-a', 'A'),
          rawText('overflow-b', 'B'),
          rawText('overflow-c', 'C'),
          rawText('overflow-cancel', '/cancel'),
        ],
      } : idlePoll(abortSignal)
    },
  })
  f.setRelease(() => {
    gates.a.resolve()
    gates.b.resolve()
    gates.c.resolve()
  })
  await f.transport.start(async (message) => {
    entered.push(message.id)
    if (message.id === 'overflow-cancel') {
      events.cancel.resolve()
      return
    }
    events[message.id.at(-1)].resolve()
    await gates[message.id.at(-1)].promise
  })

  await within(events.a.promise, 'first queued message')
  await within(events.cancel.promise, 'bypassed cancel')
  assert.deepEqual(entered, ['overflow-a', 'overflow-cancel'])

  gates.a.resolve()
  await within(events.b.promise, 'second queued message')
  assert.deepEqual(entered, ['overflow-a', 'overflow-cancel', 'overflow-b'])
  gates.b.resolve()
  await within(events.c.promise, 'third queued message')
  assert.deepEqual(entered, ['overflow-a', 'overflow-cancel', 'overflow-b', 'overflow-c'])
  gates.c.resolve()
  await tick()

  assert.equal(f.warnings.filter((line) => line.includes('remains durably queued for')).length, 2)
})

test('one conversation at capacity does not block another conversation', async (t) => {
  const started = { a: deferred(), b: deferred() }
  const gates = { a: deferred(), b: deferred() }
  const entered = []
  let polls = 0
  const f = fixture(t, {
    maxQueuePerConversation: 1,
    getUpdates: async ({ abortSignal }) => {
      polls += 1
      return polls === 1 ? {
        ret: 0,
        get_updates_buf: 'cursor-multi-conversation',
        msgs: [
          { ...rawText('a-first', 'A1'), from_user_id: 'user-a' },
          { ...rawText('a-overflow', 'A2'), from_user_id: 'user-a' },
          { ...rawText('b-first', 'B1'), from_user_id: 'user-b' },
        ],
      } : idlePoll(abortSignal)
    },
  })
  f.setRelease(() => {
    gates.a.resolve()
    gates.b.resolve()
  })
  await f.transport.start(async (message) => {
    entered.push(message.id)
    const lane = message.conversationId === 'user-a' ? 'a' : 'b'
    started[lane]?.resolve()
    await gates[lane].promise
  })

  await within(started.a.promise, 'first conversation')
  await within(started.b.promise, 'independent second conversation')
  assert.deepEqual(new Set(entered), new Set(['a-first', 'b-first']))
  gates.a.resolve()
  gates.b.resolve()
})

test('a handler failure is retained as uncertain rather than made replayable', async (t) => {
  let polls = 0
  const failed = deferred()
  const f = fixture(t, {
    getUpdates: async ({ abortSignal }) => {
      polls += 1
      return polls === 1 ? { ret: 0, get_updates_buf: 'cursor-after-failure', msgs: [rawText('message-handler-fails')] } : idlePoll(abortSignal)
    },
  })

  await f.transport.start(async () => {
    failed.resolve()
    throw new Error('synthetic handler failure')
  })
  await within(failed.promise, 'failing inbound handler')
  await tick()

  assert.deepEqual(f.transport.pendingStore.recover().queued, [])
  assert.equal(f.transport.pendingStore.recover().unresolved, 1)
  assert.ok(f.warnings.some((line) => line.includes('retained') && line.includes('will not replay automatically')))
})

test('a started-marker write failure retries in-process with one visible warning', async (t) => {
  let polls = 0
  let claimCalls = 0
  let completions = 0
  const handled = []
  const completed = deferred()
  const pendingStore = {
    dir: 'synthetic-ledger-dir',
    recover: () => ({ queued: [], unresolved: 0 }),
    stage: (message) => ({ status: 'queued', key: `claim-retry-${message.id}`, message }),
    claim: (key) => {
      if (key === 'claim-retry-claim-a') {
        claimCalls += 1
        if (claimCalls < 3) throw new Error('synthetic claim write failure')
      }
      return { ok: true }
    },
    markUncertain: () => true,
    complete: () => {
      completions += 1
      if (completions === 2) completed.resolve()
      return true
    },
  }
  const f = fixture(t, {
    pendingStore,
    inboundRetryBaseMs: 10,
    getUpdates: async ({ abortSignal }) => {
      polls += 1
      return polls === 1 ? {
        ret: 0,
        get_updates_buf: 'cursor-after-claim-retry',
        msgs: [rawText('claim-a', 'A'), rawText('claim-b', 'B')],
      } : idlePoll(abortSignal)
    },
  })

  await f.transport.start(async (message) => { handled.push(message.id) })
  await within(completed.promise, 'claim retry completion')
  assert.equal(claimCalls, 3)
  assert.deepEqual(handled, ['claim-a', 'claim-b'])
  assert.equal(f.warnings.filter((line) => line.includes('started marker could not be persisted')).length, 1)
})

test('a recovery read failure blocks getUpdates and cursor advancement until it recovers', async (t) => {
  let stageCalls = 0
  let pollCalls = 0
  const pendingStore = {
    dir: 'synthetic-ledger-dir',
    recover: () => { throw new Error('synthetic unreadable ledger') },
    stage: () => { stageCalls += 1; throw new Error('stage must not run while recovery is blocked') },
  }
  const f = fixture(t, {
    pendingStore,
    getUpdates: ({ abortSignal }) => {
      pollCalls += 1
      return idlePoll(abortSignal)
    },
  })

  await f.transport.start(async () => assert.fail('no message may run while recovery is blocked'))
  await tick()
  assert.equal(fs.existsSync(f.transport.syncBufPath), false)
  assert.equal(stageCalls, 0)
  assert.equal(pollCalls, 0)
  assert.equal(f.warnings.filter((line) => line.includes('cursor advancement is blocked')).length, 1)
})

test('a persistence failure keeps the old cursor so the server can redeliver the batch', async (t) => {
  let polls = 0
  const failed = deferred()
  const pendingStore = {
    dir: 'synthetic-ledger-dir',
    recover: () => ({ queued: [], unresolved: 0 }),
    stage: () => { failed.resolve(); throw new Error('synthetic durable write failure') },
  }
  const f = fixture(t, {
    pendingStore,
    getUpdates: async ({ abortSignal }) => {
      polls += 1
      return polls === 1 ? { ret: 0, get_updates_buf: 'must-not-advance', msgs: [rawText('message-write-fails')] } : idlePoll(abortSignal)
    },
  })

  await f.transport.start(async () => assert.fail('a message without a durable record must not run'))
  await within(failed.promise, 'durable write failure')
  await tick()
  assert.equal(fs.existsSync(f.transport.syncBufPath), false)
  assert.ok(f.warnings.some((line) => line.includes('getUpdates failed')))
})
