import test from 'node:test'
import assert from 'node:assert/strict'
import { createChannel } from '../src/channel.js'

test('channel forwards maxBytes to the transport without inventing an absent cap', async () => {
  const calls = []
  const channel = createChannel({ sendMedia: async (message) => calls.push(message) })
  await channel.sendMedia({ conversationId: 'peer', filePath: '/synthetic.pdf', maxBytes: 37 })
  await channel.sendMedia({ conversationId: 'peer', filePath: '/synthetic.pdf' })
  assert.equal(calls[0].maxBytes, 37)
  assert.equal(Object.hasOwn(calls[1], 'maxBytes'), false)
})
