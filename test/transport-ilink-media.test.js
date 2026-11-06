import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChannel } from '../src/channel.js'
import { ILinkTransport } from '../src/transport/ilink.js'

function fixture(sendOutboundMedia) {
  const pacerCalls = []
  const transport = new ILinkTransport({
    accountId: 'synthetic-media-account',
    baseUrl: 'https://api.invalid',
    token: ['synthetic', 'access', 'token'].join('-'),
    cdnBaseUrl: 'https://cdn.invalid',
    pacer: {
      acquire: async () => pacerCalls.push('acquire'),
      noteSuccess: () => pacerCalls.push('success'),
      noteFailure: () => pacerCalls.push('failure'),
    },
    outbound: {
      mediaSendOptions: (params) => params,
      sendOutboundMedia,
    },
  })
  return { transport, pacerCalls }
}

test('channel sends audio as an ordinary file and preserves its caption and routing', async () => {
  const calls = []
  const f = fixture(async (params) => {
    calls.push(params)
    return { kind: 'file', ret: 0 }
  })
  const result = await createChannel(f.transport).sendMedia({
    filePath: 'synthetic.wav',
    conversationId: 'synthetic-peer',
    text: 'caption',
    contextToken: 'synthetic-context',
  })

  assert.equal(result.kind, 'file')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].filePath, 'synthetic.wav')
  assert.equal(calls[0].to, 'synthetic-peer')
  assert.equal(calls[0].text, 'caption')
  assert.equal(calls[0].contextToken, 'synthetic-context')
  assert.equal(calls[0].cdnBaseUrl, 'https://cdn.invalid')
  assert.equal(calls[0].opts.accountId, 'synthetic-media-account')
  assert.deepEqual(f.pacerCalls, ['acquire', 'success'])
})

test('a direct caption overrides text for a regular media attachment', async () => {
  const calls = []
  const f = fixture(async (params) => { calls.push(params); return { kind: 'file' } })
  await f.transport.sendMedia({
    filePath: 'synthetic.mp3',
    conversationId: 'synthetic-peer',
    text: 'older text',
    caption: 'chosen caption',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, 'chosen caption')
  assert.deepEqual(f.pacerCalls, ['acquire', 'success'])
})

test('a failed media send is reported once without an automatic duplicate retry', async () => {
  let calls = 0
  const f = fixture(async () => { calls += 1; throw new Error('synthetic upload failure') })
  await assert.rejects(f.transport.sendMedia({
    filePath: 'synthetic.wav',
    conversationId: 'synthetic-peer',
    caption: 'caption',
  }), /synthetic upload failure/)
  assert.equal(calls, 1)
  assert.deepEqual(f.pacerCalls, ['acquire', 'failure'])
})
