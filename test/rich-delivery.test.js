import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createOutbox } from '../src/message/outbox.js'
import { configureOutbound, sendChunked } from '../src/outbound.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-delivery-test-'))
  const warnings = []
  configureOutbound({ journal: null, hooks: undefined, outbox: undefined, snippetsDir: path.join(root, 'snippets'), warn: (message) => warnings.push(message) })
  t.after(() => {
    configureOutbound({ journal: null, hooks: undefined, outbox: undefined, snippetsDir: '', warn: () => {} })
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, warnings }
}

const code = 'const synthetic = "A * B";\n  keep_indentation();\n| literal | code |\n|---|---|'
const secondCode = 'function second() {\n  return "synthetic second";\n}'
const reply = `An introductory paragraph that spans several bubbles.\n\n\`\`\`javascript\n${code}\n\`\`\`\n\n\`\`\`javascript\n${secondCode}\n\`\`\``
const config = { maxMessageLength: 35, markdownMode: 'strip', codeFileThreshold: 10 }

for (const failAt of [1, 2]) {
  test(`failed text bubble ${failAt} retains all code in the durable retry without replaying the confirmed prefix`, async (t) => {
    const { root } = setup(t)
    const attempts = [], delivered = [], retried = [], media = []
    const outbox = createOutbox({ stateRoot: root, transportFor: () => ({ send: async (m) => retried.push(m.text) }) })
    configureOutbound({ outbox })
    const transport = {
      accountId: 'synthetic-account',
      async send(m) {
        attempts.push(m.text)
        if (attempts.length === failAt) throw new Error('synthetic disconnect')
        delivered.push(m.text)
      },
      async sendMedia(m) { media.push(m) },
    }

    await sendChunked(transport, config, { conversationId: 'synthetic-chat', text: reply })
    assert.equal(media.length, 0)
    assert.equal(outbox.pending().length, 1)
    const restarted = createOutbox({ stateRoot: root, transportFor: () => ({ send: async (m) => retried.push(m.text) }) })
    await restarted.flush({ force: true })
    const received = [...delivered, ...retried].join('')
    assert.ok(received.includes(code), 'first code body survives exactly')
    assert.ok(received.includes(secondCode), 'second code body survives exactly')
    assert.doesNotMatch(received, /已作为文件.+发出/)
    assert.deepEqual(retried.slice(0, 1), attempts.slice(failAt - 1, failAt))
    assert.ok(retried.every((s) => s.length <= config.maxMessageLength))
  })
}

for (const failure of ['write', 'media']) {
  test(`${failure} failure falls back to complete code and retries failed fallback text`, async (t) => {
    const { root } = setup(t)
    if (failure === 'write') {
      const blocked = path.join(root, 'not-a-directory')
      fs.writeFileSync(blocked, 'synthetic')
      configureOutbound({ snippetsDir: blocked })
    }
    const delivered = [], retried = [], media = []
    let failingFallback = true
    const outbox = createOutbox({ stateRoot: root, transportFor: () => ({ send: async (m) => retried.push(m.text) }) })
    configureOutbound({ outbox })
    const transport = {
      accountId: 'synthetic-account',
      async send(m) {
        if (m.text.includes('synthetic') && failingFallback) {
          failingFallback = false
          throw new Error('synthetic text failure')
        }
        delivered.push(m.text)
      },
      async sendMedia(m) { media.push(m.filePath); throw new Error('synthetic media failure') },
    }
    await sendChunked(transport, config, { conversationId: 'synthetic-chat', text: reply })
    assert.equal(failingFallback, false, 'the fallback text actually reached the simulated failure')
    assert.equal(outbox.pending().length, 1, 'the unsent fallback is queued')
    await outbox.flush({ force: true })
    const received = [...delivered, ...retried].join('')
    assert.ok(received.includes(code))
    assert.ok(received.includes(secondCode))
    assert.doesNotMatch(received, /已作为文件.+发出/)
    assert.equal(media.length, failure === 'write' ? 0 : 2)
    assert.equal(outbox.pending().length, 0)
  })
}

test('same-second concurrent uploads and multiple snippets retain their own contents', async (t) => {
  setup(t)
  t.mock.method(Date, 'now', () => 1_800_000_000_000)
  const firstStarted = deferred(), releaseFirst = deferred(), reads = []
  const transport = {
    accountId: 'synthetic-account',
    async send() {},
    async sendMedia(m) {
      if (m.conversationId === 'chat-A' && reads.length === 0) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      reads.push({ chat: m.conversationId, file: m.filePath, body: fs.readFileSync(m.filePath, 'utf8') })
    },
  }
  const make = (body) => `\`\`\`javascript\n${body}\n\`\`\``
  const a = sendChunked(transport, config, { conversationId: 'chat-A', text: `${make('const alpha = 111111111;')}\n${make('const alphaTwo = 333333333;')}` })
  await firstStarted.promise
  await sendChunked(transport, config, { conversationId: 'chat-B', text: make('const beta = 222222222;') })
  releaseFirst.resolve()
  await a
  const bodies = (chat) => reads.filter((r) => r.chat === chat).map((r) => r.body)
  assert.deepEqual(bodies('chat-A'), ['const alpha = 111111111;\n', 'const alphaTwo = 333333333;\n'])
  assert.deepEqual(bodies('chat-B'), ['const beta = 222222222;\n'])
  assert.equal(new Set(reads.map((r) => r.file)).size, 3)
})

test('one failed attachment falls back without repeating a successful attachment', async (t) => {
  setup(t)
  const messages = [], uploads = []
  const transport = {
    accountId: 'synthetic-account',
    async send(m) { messages.push(m.text) },
    async sendMedia(m) {
      uploads.push(fs.readFileSync(m.filePath, 'utf8'))
      if (uploads.length === 2) throw new Error('synthetic media failure')
    },
  }
  await sendChunked(transport, { ...config, locale: 'en' }, { conversationId: 'synthetic-chat', text: reply })
  assert.equal(uploads.length, 2)
  const text = messages.join('')
  assert.ok(text.includes(secondCode))
  assert.ok(!text.includes(code))
  assert.match(text, /Sending attachment snippet-2\.js could not be confirmed/)
})

test('missing media support and missing snippet directory retain code as text', async (t) => {
  setup(t)
  const sent = []
  const transport = { accountId: 'synthetic-account', capabilities: { media: false }, send: async (m) => sent.push(m.text) }
  await sendChunked(transport, config, { conversationId: 'synthetic-chat', text: reply })
  assert.ok(sent.join('').includes(code))
  assert.ok(sent.join('').includes(secondCode))
  sent.length = 0
  configureOutbound({ snippetsDir: '' })
  await sendChunked(transport, config, { conversationId: 'synthetic-chat', text: reply })
  assert.ok(sent.join('').includes(code))
  assert.ok(sent.join('').includes(secondCode))
})

test('without an outbox, text failure is reported rather than pretending code can be retried', async (t) => {
  setup(t)
  const transport = { send: async () => { throw new Error('synthetic offline') } }
  await assert.rejects(sendChunked(transport, config, { conversationId: 'synthetic-chat', text: reply }), /synthetic offline/)
})

test('outbox persistence failure propagates and does not start an attachment', async (t) => {
  setup(t)
  const media = []
  configureOutbound({ outbox: { enqueue: () => { throw new Error('synthetic queue write failure') } } })
  const transport = {
    send: async () => { throw new Error('synthetic offline') },
    sendMedia: async (m) => media.push(m),
  }
  await assert.rejects(sendChunked(transport, config, { conversationId: 'synthetic-chat', text: reply }), /synthetic queue write failure/)
  assert.deepEqual(media, [])
})

test('failed transient messages remain unqueued even when they contain a code block', async (t) => {
  setup(t)
  const queue = [], media = []
  configureOutbound({ outbox: { enqueue: (entry) => queue.push(entry) } })
  const transport = {
    send: async () => { throw new Error('synthetic offline') },
    sendMedia: async (m) => media.push(m),
  }
  await sendChunked(transport, config, { conversationId: 'synthetic-chat', text: reply, durable: false })
  assert.deepEqual(queue, [])
  assert.deepEqual(media, [])
})
