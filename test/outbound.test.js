import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createOutbox } from '../src/message/outbox.js'
import { configureOutbound, sendChunked } from '../src/outbound.js'

test('pure SILENT replies never reach transport, journal, hooks, or retry queue', async t => {
  const calls = []
  configureOutbound({
    journal: () => calls.push('journal'),
    hooks: { emit: () => calls.push('hook') },
    outbox: { enqueue: () => calls.push('outbox') },
  })
  t.after(() => configureOutbound({ journal: null, hooks: undefined, outbox: undefined }))
  const transport = { send: async () => { calls.push('send'); throw new Error('offline') } }
  for (const text of ['[SILENT]', ' \n[silent]\t', '[SiLeNt]']) {
    for (const richContent of [true, false]) {
      await sendChunked(transport, { maxMessageLength: 3, richContent }, {
        conversationId: 'synthetic-peer', text,
      })
    }
  }
  assert.deepEqual(calls, [])
})

test('a silent reply does not swallow the next answer or prose discussing the marker', async () => {
  const sent = []
  const transport = { send: async message => sent.push(message.text) }
  const config = { maxMessageLength: 1500, markdownMode: 'off', richContent: false }
  for (const text of ['[SILENT]', '任务已完成', '正文中的 [SILENT] 是一个标记', '[SILENT]\n这里还有正文']) {
    await sendChunked(transport, config, { conversationId: 'synthetic-peer', text })
  }
  assert.deepEqual(sent, ['任务已完成', '正文中的 [SILENT] 是一个标记', '[SILENT]\n这里还有正文'])
})

test('failed chunk is queued as exact unsent bubbles and retried without the delivered prefix', async (t) => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'weixin-outbound-test-'))
  t.after(() => {
    configureOutbound({ outbox: undefined })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  const sent = []
  const retried = []
  let retryTransport = { send: async (message) => { retried.push(message) } }
  const outbox = createOutbox({ stateRoot, transportFor: () => retryTransport })
  configureOutbound({ outbox })
  const primary = {
    accountId: 'synthetic-account',
    async send(message) {
      sent.push(message.text)
      if (sent.length === 2) throw new Error('socket closed')
    },
  }

  await sendChunked(
    primary,
    { maxMessageLength: 5, markdownMode: 'off', richContent: false },
    { conversationId: 'synthetic-peer', text: 'abcdefghijkl', contextToken: 'synthetic-token' },
  )

  assert.deepEqual(sent, ['abcde', 'fghij'])
  assert.deepEqual(outbox.pending()[0].segments, ['fghij', 'kl'])
  assert.equal(outbox.pending()[0].nextSegment, 0)
  assert.equal(outbox.pending()[0].maxMessageLength, 5)
  assert.deepEqual(await outbox.flush({ force: true }), { sent: 1, failed: 0, remaining: 0 })
  assert.deepEqual(retried.map((message) => message.text), ['fghij', 'kl'])
  assert.ok(retried.every((message) => message.text.length <= 5))
})
