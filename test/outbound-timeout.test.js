import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { ILinkTransport } from '../src/transport/ilink.js'
import { createOutbox } from '../src/message/outbox.js'
import { getUpdates, getUploadUrl, sendMessage } from '../vendor/openclaw-weixin/api/api.js'
import { uploadBufferToCdn } from '../vendor/openclaw-weixin/cdn/cdn-upload.js'

const baseUrl = 'https://weixin.invalid'
const timeoutMs = 20
const never = () => new Promise(() => {})

// The fake deliberately ignores abort. Check the caller's deadline as well as
// the cancellation sent to the underlying connection, without any wall-clock sleeps.
function stall(t, stage, status = 200) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const signals = []
  let bodyReads = 0
  const fetch = t.mock.method(globalThis, 'fetch', async (_, { signal }) => {
    signals.push(signal)
    if (stage === 'headers') return never()
    return {
      status, ok: status === 200, headers: new Headers(),
      text() { bodyReads++; return never() },
    }
  })
  return { fetch, signals, get bodyReads() { return bodyReads } }
}

for (const [label, call, stage] of [
  ['sendMessage', sendMessage, 'headers'],
  ['sendMessage', sendMessage, 'body'],
  ['getUploadUrl', getUploadUrl, 'body'],
]) {
  test(`${label} bounds a stalled ${stage} and leaves subsequent requests usable`, { timeout: 3000 }, async t => {
    const f = stall(t, stage)
    const request = () => call({ baseUrl, body: {}, timeoutMs })
    const result = assert.rejects(request(), err => {
      assert.equal(err.name, 'TimeoutError')
      assert.match(err.message, new RegExp(label + '.*20ms'))
      assert.equal(err.deliveryUncertain, call === sendMessage ? true : undefined)
      assert.notEqual(err.sendOutcome, 'rejected')
      return true
    })
    await nextTurn()
    assert.equal(f.bodyReads, stage === 'body' ? 1 : 0)
    t.mock.timers.tick(timeoutMs)
    await result
    assert.equal(f.signals.length, 1)
    assert.equal(f.signals[0].aborted, true)
    f.fetch.mock.mockImplementation(async () => Response.json({ ret: 0 }))
    assert.deepEqual(await request(), { ret: 0 })
  })
}

test('a fetch connection timeout before the request deadline also leaves delivery uncertain', async t => {
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
  }) })
  t.mock.method(globalThis, 'fetch', async () => { throw error })
  await assert.rejects(sendMessage({ baseUrl, body: {} }), err => err === error && err.deliveryUncertain === true)
})

for (const stage of ['headers', 'body']) {
  test(`CDN upload aborts stalled ${stage} without another POST`, { timeout: 3000 }, async t => {
    const f = stall(t, stage, 400)
    const upload = () => uploadBufferToCdn({
      buf: Buffer.from('sample'), aeskey: Buffer.alloc(16),
      uploadFullUrl: baseUrl, label: 'test', timeoutMs,
    })
    const result = assert.rejects(upload(), { name: 'TimeoutError', message: /CDN upload.*20ms/ })
    await nextTurn()
    assert.equal(f.bodyReads, stage === 'body' ? 1 : 0)
    t.mock.timers.tick(timeoutMs)
    await result
    assert.equal(f.signals.length, 1)
    assert.equal(f.signals[0].aborted, true)
    f.fetch.mock.mockImplementation(async () => new Response(null, { headers: { 'x-encrypted-param': 'ok' } }))
    assert.deepEqual(await upload(), { downloadParam: 'ok' })
  })
}

for (const external of [true, false]) {
  test(`long-poll ${external ? 'stop' : 'timeout'} during body read preserves cursor`, { timeout: 3000 }, async t => {
    const f = stall(t, 'body')
    const controller = new AbortController()
    const result = getUpdates({ baseUrl, get_updates_buf: 'cursor', abortSignal: controller.signal, timeoutMs })
    await nextTurn()
    assert.equal(f.bodyReads, 1)
    if (external) controller.abort()
    else t.mock.timers.tick(timeoutMs)
    assert.deepEqual(await result, { ret: 0, msgs: [], get_updates_buf: 'cursor' })
    assert.equal(f.signals[0].aborted, true)
  })
}

test('a timed-out transport frees the shared flush without acknowledging the segment', { timeout: 3000 }, async t => {
  const f = stall(t, 'body')
  const transport = new ILinkTransport({ accountId: 'test', baseUrl })
  let sendError
  const observed = { async send(message) {
    try { await transport.send(message) } catch (err) { sendError = err; throw err }
  } }
  const outbox = createOutbox({
    stateRoot: path.join(process.env.DSH_WEIXIN_STATE_DIR, 'outbox-timeout'),
    transportFor: () => observed,
  })
  const enqueue = conversationId => outbox.enqueue({ accountId: 'test', conversationId, text: 'sample' })
  const id = enqueue('one')
  const first = outbox.flush()
  assert.equal(first, outbox.flush({ force: true }))
  await nextTurn()
  assert.equal(f.bodyReads, 1)
  t.mock.timers.tick(15_000) // sendMessage's production deadline
  assert.deepEqual(await first, { sent: 0, failed: 1, remaining: 1 })
  assert.equal(sendError.deliveryUncertain, true)
  assert.equal(outbox.pending()[0].nextSegment, 0)
  assert.equal(outbox.pending()[0].id, id)
  enqueue('two')
  f.fetch.mock.mockImplementation(async () => Response.json({ ret: 0 }))
  assert.deepEqual(await outbox.flush(), { sent: 1, failed: 0, remaining: 1 })
  assert.equal(outbox.pending()[0].id, id)
})
