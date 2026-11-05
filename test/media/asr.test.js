import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { AsrBridge } from '../../src/media/asr.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.exitCode = null
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  return child
}

function scheduleResponse(child, text) {
  setImmediate(() => child.stdout.write(`${JSON.stringify({ ok: true, text })}\n`))
}

function bridgeWithChildren(children, timeoutMs = 600) {
  let spawnCount = 0
  const bridge = new AsrBridge(
    { command: 'asr-test', args: [], env: {}, timeoutMs },
    { spawnImpl: () => children[spawnCount++] },
  )
  return { bridge, spawnCount: () => spawnCount }
}

test('an asynchronous spawn error settles as spawn-failed and the queue recovers', async () => {
  const children = [fakeChild(), fakeChild()]
  children[0].stdin.resume()
  scheduleResponse(children[1], 'recovered')
  const { bridge, spawnCount } = bridgeWithChildren(children)
  const started = Date.now()

  const failed = bridge.transcribe('failed.wav')
  const recovered = bridge.transcribe('recovered.wav')
  await new Promise(setImmediate)
  setImmediate(() => {
    children[0].emit('error', Object.assign(new Error('spawn asr-test ENOENT'), { code: 'ENOENT' }))
    setImmediate(() => children[0].emit('close', -2, null))
  })

  const [failedResult, recoveredResult] = await Promise.all([failed, recovered])
  assert.equal(failedResult.code, 'spawn-failed')
  assert.match(failedResult.reason, /ENOENT/)
  assert.deepEqual(recoveredResult, { ok: true, text: 'recovered' })
  assert.equal(spawnCount(), 2)
  assert.ok(Date.now() - started < 500, 'spawn failure should not wait for the 600 ms timeout')
  await bridge.dispose()
})

test('a child close without exit settles the request and the next one restarts the bridge', async () => {
  const children = [fakeChild(), fakeChild()]
  children[0].stdin.resume()
  scheduleResponse(children[1], 'after-close')
  const { bridge, spawnCount } = bridgeWithChildren(children)
  const started = Date.now()

  const closed = bridge.transcribe('closed.wav')
  const recovered = bridge.transcribe('recovered.wav')
  await new Promise(setImmediate)
  setImmediate(() => children[0].emit('close', 1, null))

  const [closedResult, recoveredResult] = await Promise.all([closed, recovered])
  assert.equal(closedResult.code, 'exited')
  assert.deepEqual(recoveredResult, { ok: true, text: 'after-close' })
  assert.equal(spawnCount(), 2)
  assert.ok(Date.now() - started < 500, 'close should not wait for the 600 ms timeout')
  await bridge.dispose()
})
