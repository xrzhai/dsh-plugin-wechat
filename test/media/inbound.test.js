import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { downloadInboundMedia, fetchInboundBytes, InboundMediaError } from '../../src/media/inbound.js'
import { encryptAesEcb } from '../../vendor/openclaw-weixin/cdn/aes-ecb.js'

const DESCRIPTOR = { kind: 'file', fullUrl: 'https://cdn.invalid/synthetic.bin' }

function streamedResponse(chunks, { headers = {}, status = 200, statusText = 'OK' } = {}) {
  let index = 0
  let produced = 0
  const state = { cancelled: false, cancelReason: undefined, produced: 0 }
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      produced += 1
      state.produced = produced
      controller.enqueue(chunks[index++])
    },
    cancel(reason) {
      state.cancelled = true
      state.cancelReason = reason
    },
  })
  return {
    state,
    response: {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: new Headers(headers),
      body,
      arrayBuffer() {
        throw new Error('the streaming path must not buffer the whole response')
      },
    },
  }
}

function fetchResponse(response) {
  return async (_url, init) => {
    assert.ok(init?.signal, 'the download must receive a deadline signal')
    return response
  }
}

function oneByteResponse(count) {
  const byte = Uint8Array.of(0x61)
  const state = { remaining: count, reads: 0, cancelled: false, released: false }
  const reader = {
    read() {
      state.reads += 1
      if (state.remaining === 0) return Promise.resolve({ done: true, value: undefined })
      state.remaining -= 1
      return Promise.resolve({ done: false, value: byte })
    },
    cancel() {
      state.cancelled = true
    },
    releaseLock() {
      state.released = true
    },
  }
  return {
    state,
    response: {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: { getReader: () => reader },
    },
  }
}

test('rejects a declared oversize response without acquiring its body reader', async () => {
  let readerAcquired = false
  let cancelled = false
  let cancelReason
  const body = {
    getReader() {
      readerAcquired = true
      throw new Error('the body must not be read after a declared oversize rejection')
    },
    cancel(reason) {
      cancelled = true
      cancelReason = reason
    },
  }
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': '100' }),
    body,
  }

  await assert.rejects(
    fetchInboundBytes(DESCRIPTOR, { maxBytes: 10, fetchImpl: fetchResponse(response) }),
    (error) => {
      assert.equal(error.code, 'too-large')
      assert.equal(error.message, 'the attachment is 100B, larger than the 10B limit')
      return true
    },
  )

  assert.equal(readerAcquired, false)
  assert.equal(cancelled, true)
  assert.equal(cancelReason?.code, 'too-large')
})

test('streams a normal multi-chunk attachment when content-length is absent', async () => {
  const { response } = streamedResponse([Buffer.from('multi-'), Buffer.from('chunk')])

  const bytes = await fetchInboundBytes(DESCRIPTOR, {
    maxBytes: 32,
    fetchImpl: fetchResponse(response),
  })

  assert.equal(bytes.toString(), 'multi-chunk')
})

test('sizes the final block from the actual remaining chunk capacity', async () => {
  const firstBlock = 64 * 1024
  const tail = 10
  const chunkLength = firstBlock + tail
  const { response } = streamedResponse([Buffer.alloc(chunkLength, 0x64)])
  const originalAllocUnsafe = Buffer.allocUnsafe
  const allocations = []
  Buffer.allocUnsafe = function (size) {
    allocations.push(size)
    return originalAllocUnsafe(size)
  }

  let bytes
  try {
    bytes = await fetchInboundBytes(DESCRIPTOR, {
      maxBytes: chunkLength,
      fetchImpl: fetchResponse(response),
    })
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe
  }

  assert.equal(bytes.length, chunkLength)
  assert.deepEqual(allocations.slice(0, 2), [firstBlock, tail])
})

test('coalesces a large one-byte chunk stream without retaining a buffer per chunk', async () => {
  const count = 250_000
  const { response, state } = oneByteResponse(count)

  const bytes = await fetchInboundBytes(DESCRIPTOR, {
    maxBytes: count,
    fetchImpl: fetchResponse(response),
  })

  assert.equal(bytes.length, count)
  assert.equal(bytes[0], 0x61)
  assert.equal(bytes[count - 1], 0x61)
  assert.equal(state.reads, count + 1)
  assert.equal(state.released, true)
  assert.equal(state.cancelled, false)
})

for (const [label, headers] of [
  ['missing', {}],
  ['false-small', { 'content-length': '1' }],
]) {
  test(`cancels a multi-chunk response with a ${label} content-length at the cap`, async () => {
    const chunks = Array.from({ length: 100 }, () => Buffer.from([0x61]))
    const { response, state } = streamedResponse(chunks, { headers })

    await assert.rejects(
      fetchInboundBytes(DESCRIPTOR, { maxBytes: 10, fetchImpl: fetchResponse(response) }),
      (error) => {
        assert.ok(error instanceof InboundMediaError)
        assert.equal(error.code, 'too-large')
        assert.match(error.message, /larger than the 10B limit/)
        return true
      },
    )

    assert.equal(state.cancelled, true)
    assert.equal(state.cancelReason?.code, 'too-large')
    assert.ok(state.produced < chunks.length, 'the producer must stop before the body ends')
  })
}

test('does not wait forever when an adversarial stream cancel stalls', async () => {
  let index = 0
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      if (index >= 32) {
        controller.close()
        return
      }
      index += 1
      controller.enqueue(Buffer.alloc(4, 0x63))
    },
    cancel() {
      cancelled = true
      return new Promise(() => {})
    },
  })
  const response = { ok: true, status: 200, statusText: 'OK', body }
  let timer

  try {
    await Promise.race([
      assert.rejects(
        fetchInboundBytes(DESCRIPTOR, { maxBytes: 10, fetchImpl: fetchResponse(response) }),
        (error) => error.code === 'too-large',
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the downloader waited for stream cancellation')), 500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  assert.equal(cancelled, true)
})

test('an oversize result keeps the existing failure reason for callers', async () => {
  const chunks = Array.from({ length: 4 }, () => Buffer.alloc(4, 0x62))
  const { response } = streamedResponse(chunks)

  const result = await downloadInboundMedia({
    media: DESCRIPTOR,
    cdnBaseUrl: 'https://cdn.invalid',
    maxBytes: 8,
    fetchImpl: fetchResponse(response),
  })

  assert.deepEqual(result, {
    ok: false,
    reason: 'the attachment is at least 12B, larger than the 8B limit',
    code: 'too-large',
  })
})

test('accepts a standard empty body and fails closed for a non-streamable success', async () => {
  let emptyArrayBufferCalled = false
  const empty = await fetchInboundBytes(DESCRIPTOR, {
    maxBytes: 8,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
      arrayBuffer: async () => {
        emptyArrayBufferCalled = true
        return new Uint8Array()
      },
    }),
  })
  let unsafeArrayBufferCalled = false
  await assert.rejects(
    fetchInboundBytes(DESCRIPTOR, {
      maxBytes: 8,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {},
        arrayBuffer: async () => {
          unsafeArrayBufferCalled = true
          return new Uint8Array([0x6f, 0x6b])
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, 'body-not-streamable')
      assert.match(error.message, /refusing to buffer it without a size bound/)
      return true
    },
  )

  assert.equal(empty.length, 0)
  assert.equal(emptyArrayBufferCalled, false)
  assert.equal(unsafeArrayBufferCalled, false)
})

test('bounds an error response body and cancels it instead of calling text()', async () => {
  const chunks = Array.from({ length: 20 }, () => Buffer.from('error:'.repeat(10)))
  const { response, state } = streamedResponse(chunks, { status: 503, statusText: 'Unavailable' })

  await assert.rejects(
    fetchInboundBytes(DESCRIPTOR, { maxBytes: 1024, fetchImpl: fetchResponse(response) }),
    (error) => {
      assert.equal(error.code, 'cdn-status')
      assert.match(error.message, /CDN returned 503 Unavailable/)
      return true
    },
  )

  assert.equal(state.cancelled, true)
  assert.ok(state.produced < chunks.length)
})

test('a non-2xx response without a stream reports only its status', async () => {
  let readBody = false
  const response = {
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    body: null,
    arrayBuffer: async () => {
      readBody = true
      return new Uint8Array(1024)
    },
    text: async () => {
      readBody = true
      return 'must not be read'
    },
  }

  await assert.rejects(
    fetchInboundBytes(DESCRIPTOR, { maxBytes: 1024, fetchImpl: fetchResponse(response) }),
    (error) => {
      assert.equal(error.code, 'cdn-status')
      assert.equal(error.message, 'CDN returned 502 Bad Gateway')
      return true
    },
  )
  assert.equal(readBody, false)
})

test('the deadline cancels a stalled stream and returns a timeout reason', async () => {
  const state = { cancelled: false }
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {})
    },
    cancel() {
      state.cancelled = true
    },
  })
  const response = { ok: true, status: 200, statusText: 'OK', body }

  await assert.rejects(
    fetchInboundBytes(DESCRIPTOR, {
      maxBytes: 1024,
      timeoutMs: 20,
      fetchImpl: fetchResponse(response),
    }),
    (error) => {
      assert.equal(error.code, 'timeout')
      assert.match(error.message, /timed out after 20ms/)
      return true
    },
  )
  assert.equal(state.cancelled, true)
})

test('decrypts and saves an encrypted attachment after applying the streamed cap', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-inbound-bounded-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const key = Buffer.from('0123456789abcdef')
  const plaintext = Buffer.from('encrypted attachment body')
  const ciphertext = encryptAesEcb(plaintext, key)
  const { response } = streamedResponse([
    ciphertext.subarray(0, 7),
    ciphertext.subarray(7, 19),
    ciphertext.subarray(19),
  ])

  const result = await downloadInboundMedia({
    media: {
      ...DESCRIPTOR,
      fileName: 'note.txt',
      aesKey: key.toString('base64'),
    },
    cdnBaseUrl: 'https://cdn.invalid',
    maxBytes: ciphertext.length,
    dir,
    token: () => 'fixed',
    fetchImpl: fetchResponse(response),
  })

  assert.equal(result.ok, true)
  assert.equal(result.name, 'fixed-note.txt')
  assert.deepEqual(await fs.readFile(result.path), plaintext)
})
