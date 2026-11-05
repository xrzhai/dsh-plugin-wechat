import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mediaFallbackParamsAfterVoiceError,
  sendOutboundVoice,
} from '../../src/media/outbound.js'
import { SendMessageRejectedError } from '../../vendor/openclaw-weixin/api/api.js'

function voiceParams(send, overrides = {}) {
  return {
    filePath: 'synthetic.wav',
    to: 'synthetic-peer',
    contexttoken: 'synthetic-token',
    cdnBaseUrl: 'https://cdn.invalid',
    opts: { baseUrl: 'https://api.invalid', token: 'synthetic-token' },
    text: 'caption',
    transcode: async () => ({ silk: new Uint8Array([1]), durationMs: 1_000, sampleRate: 16_000 }),
    upload: async () => ({ downloadEncryptedQueryParam: 'download', aeskey: 'aes-key' }),
    buildItem: () => ({ type: 999, voice_item: { synthetic: true } }),
    send,
    ...overrides,
  }
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected the voice send to fail')
}

test('voice success sends the caption once before the voice item', async () => {
  const calls = []
  const result = await sendOutboundVoice(voiceParams(async (request) => {
    const item = request.body.msg.item_list[0]
    calls.push(item.text_item?.text ?? 'voice')
    return { message_id: `server-${calls.length}` }
  }))

  assert.deepEqual(calls, ['caption', 'voice'])
  assert.deepEqual(result, { kind: 'voice', message_id: 'server-2' })
})

test('preparation failure leaves the caption available for file fallback', async () => {
  const error = await captureError(sendOutboundVoice(voiceParams(async () => {
    assert.fail('nothing should be sent when preparation fails')
  }, {
    transcode: async () => { throw new Error('transcode failed') },
  })))

  assert.equal(error.captionState, 'not-sent')
  assert.equal(error.voiceState, 'not-attempted')
  assert.equal(mediaFallbackParamsAfterVoiceError({ text: 'caption' }, error).text, 'caption')
})

test('an explicitly rejected caption is safe to retry with the file', async () => {
  const error = await captureError(sendOutboundVoice(voiceParams(async () => {
    throw new SendMessageRejectedError(123, 'rejected')
  })))

  assert.equal(error.captionState, 'not-sent')
  assert.equal(error.voiceState, 'not-attempted')
  assert.equal(mediaFallbackParamsAfterVoiceError({ text: 'caption' }, error).text, 'caption')
})

test('an explicitly rejected voice after a sent caption falls back without repeating it', async () => {
  let sends = 0
  const error = await captureError(sendOutboundVoice(voiceParams(async (request) => {
    sends += 1
    if (request.body.msg.item_list[0].text_item) return { message_id: 'caption-id' }
    throw new SendMessageRejectedError(456, 'voice rejected')
  })))

  assert.equal(sends, 2)
  assert.equal(error.captionState, 'sent')
  assert.equal(error.voiceState, 'rejected')
  assert.equal(mediaFallbackParamsAfterVoiceError({ text: 'caption' }, error).text, '')
})

test('a rejection-shaped message without the typed upstream error stays uncertain', async () => {
  const error = await captureError(sendOutboundVoice(voiceParams(async () => {
    throw new Error('sendMessage ret=123 errmsg=rejected')
  })))

  assert.equal(error.captionState, 'unknown')
  assert.equal(error.voiceState, 'not-attempted')
  assert.equal(mediaFallbackParamsAfterVoiceError({ text: 'caption' }, error), undefined)
})

test('network ambiguity on either caption or voice disables file fallback', async (t) => {
  await t.test('caption outcome unknown', async () => {
    const error = await captureError(sendOutboundVoice(voiceParams(async () => {
      const timeout = new Error('request timed out')
      timeout.name = 'AbortError'
      throw timeout
    })))

    assert.equal(error.captionState, 'unknown')
    assert.equal(error.voiceState, 'not-attempted')
    assert.equal(mediaFallbackParamsAfterVoiceError({ text: 'caption' }, error), undefined)
  })

  await t.test('voice outcome unknown after caption was sent', async () => {
    const error = await captureError(sendOutboundVoice(voiceParams(async (request) => {
      if (request.body.msg.item_list[0].text_item) return { message_id: 'caption-id' }
      const timeout = new Error('request timed out')
      timeout.name = 'AbortError'
      throw timeout
    })))

    assert.equal(error.captionState, 'sent')
    assert.equal(error.voiceState, 'unknown')
    assert.equal(mediaFallbackParamsAfterVoiceError({ text: 'caption' }, error), undefined)
  })
})
