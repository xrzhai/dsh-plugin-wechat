import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChannel } from '../src/channel.js'
import {
  OutboundMediaError,
  mediaFallbackParamsAfterVoiceError,
} from '../src/media/outbound.js'
import { ILinkTransport } from '../src/transport/ilink.js'

function fixture({ voice, media }) {
  const logs = []
  const transport = new ILinkTransport({
    accountId: 'synthetic-media-account',
    baseUrl: 'https://api.invalid',
    token: ['synthetic', 'access', 'token'].join('-'),
    log: (line) => logs.push(line),
    pacer: {
      acquire: async () => {},
      noteSuccess: () => {},
      noteFailure: () => {},
    },
    outbound: {
      mediaSendOptions: () => ({}),
      mediaFallbackParamsAfterVoiceError,
      sendOutboundVoice: voice,
      sendOutboundMedia: media,
    },
  })
  return { logs, transport }
}

test('channel text reaches the real transport as the voice caption', async () => {
  const voiceCalls = []
  const mediaCalls = []
  const f = fixture({
    voice: async (params) => {
      voiceCalls.push(params)
      return { kind: 'voice', ret: 0 }
    },
    media: async (params) => { mediaCalls.push(params) },
  })

  const result = await createChannel(f.transport).sendMedia({
    filePath: 'synthetic.wav',
    conversationId: 'synthetic-peer',
    text: 'caption',
  })

  assert.equal(voiceCalls.length, 1)
  assert.equal(voiceCalls[0].text, 'caption')
  assert.equal(mediaCalls.length, 0)
  assert.equal(result.kind, 'voice')
})

test('failure before the caption is sent falls back with the caption preserved', async () => {
  const mediaCalls = []
  const f = fixture({
    voice: async () => {
      throw new OutboundMediaError('transcode failed', 'send-failed', {
        captionState: 'not-sent',
        voiceState: 'not-attempted',
      })
    },
    media: async (params) => {
      mediaCalls.push(params)
      return { kind: 'file', ret: 0 }
    },
  })

  await f.transport.sendMedia({
    filePath: 'synthetic.wav',
    conversationId: 'synthetic-peer',
    caption: 'caption',
  })

  assert.equal(mediaCalls.length, 1)
  assert.equal(mediaCalls[0].text, 'caption')
})

test('failure after the caption was sent falls back without repeating it', async () => {
  const mediaCalls = []
  const f = fixture({
    voice: async () => {
      throw new OutboundMediaError('voice rejected', 'send-failed', {
        captionState: 'sent',
        voiceState: 'rejected',
      })
    },
    media: async (params) => {
      mediaCalls.push(params)
      return { kind: 'file', ret: 0 }
    },
  })

  await f.transport.sendMedia({
    filePath: 'synthetic.wav',
    conversationId: 'synthetic-peer',
    caption: 'caption',
  })

  assert.equal(mediaCalls.length, 1)
  assert.equal(mediaCalls[0].text, '')
})

test('an uncertain network outcome does not trigger a duplicate-prone file fallback', async () => {
  const mediaCalls = []
  const f = fixture({
    voice: async () => {
      throw new OutboundMediaError('request timed out', 'send-failed', {
        captionState: 'sent',
        voiceState: 'unknown',
      })
    },
    media: async (params) => { mediaCalls.push(params) },
  })

  await assert.rejects(
    f.transport.sendMedia({
      filePath: 'synthetic.wav',
      conversationId: 'synthetic-peer',
      caption: 'caption',
    }),
    /request timed out/,
  )
  assert.equal(mediaCalls.length, 0)
  assert.match(f.logs.join('\n'), /outcome is uncertain.*avoid duplicate delivery/)
})
