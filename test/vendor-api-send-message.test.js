import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SendMessageRejectedError,
  sendMessage,
} from '../vendor/openclaw-weixin/api/api.js'

function request() {
  return {
    baseUrl: 'https://api.invalid',
    token: ['synthetic', 'access', 'token'].join('-'),
    body: { synthetic: true },
  }
}

test('a parsed nonzero ret becomes a typed definite rejection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ ret: 42, errmsg: 'synthetic rejection' }),
    { status: 200 },
  ))

  await assert.rejects(sendMessage(request()), (error) => {
    assert.ok(error instanceof SendMessageRejectedError)
    assert.equal(error.ret, 42)
    assert.equal(error.errmsg, 'synthetic rejection')
    assert.equal(error.sendOutcome, 'rejected')
    return true
  })
})

test('HTTP and network failures remain unclassified instead of claiming rejection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }))
  const httpError = await sendMessage(request()).catch((error) => error)
  assert.ok(httpError instanceof Error)
  assert.equal(httpError instanceof SendMessageRejectedError, false)
  assert.equal(httpError.sendOutcome, undefined)

  const network = new Error('socket closed')
  t.mock.method(globalThis, 'fetch', async () => { throw network })
  const networkError = await sendMessage(request()).catch((error) => error)
  assert.equal(networkError, network)
  assert.equal(networkError.sendOutcome, undefined)
})
