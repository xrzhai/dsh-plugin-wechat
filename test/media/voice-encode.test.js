import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { transcodeToSilk } from '../../src/media/voice-encode.js'

function wavBuffer({ format = 1, bitsPerSample = 16, frames = 2_400, sampleRate = 24_000 } = {}) {
  const channels = 1
  const bytesPerSample = Math.ceil(bitsPerSample / 8)
  const blockAlign = channels * bytesPerSample
  const dataBytes = frames * blockAlign
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(format, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let offset = 44; bitsPerSample === 16 && offset < buffer.length; offset += 2) {
    buffer.writeInt16LE(Math.round(1_000 * Math.sin((offset - 44) / 8)), offset)
  }
  return buffer
}

async function tempWav(t, name, buffer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-voice-encode-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, name)
  await fs.writeFile(file, buffer)
  return file
}

function successfulFfmpeg(pcm, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setImmediate(() => {
      child.stdout.write(pcm, () => {
        child.stdout.end()
        child.emit('close', 0, null)
      })
    })
    return child
  }
}

const decodedPcm = Buffer.alloc(2_400 * 2)

test('a valid 16-bit WAV is encoded directly without invoking ffmpeg', async (t) => {
  const file = await tempWav(t, 'valid.wav', wavBuffer())
  let calls = 0

  const result = await transcodeToSilk(file, {
    spawnImpl: () => {
      calls++
      throw new Error('ffmpeg must not run for valid PCM WAV input')
    },
  })

  assert.equal(calls, 0)
  assert.equal(result.sampleRate, 24_000)
  assert.ok(result.silk.length > 0)
})

test('a corrupt file with a WAV extension is rejected instead of being treated as an unsupported format', async (t) => {
  const file = await tempWav(t, 'corrupt.wav', Buffer.from('this is not a RIFF/WAVE file'))
  let calls = 0

  await assert.rejects(
    transcodeToSilk(file, {
      spawnImpl: () => {
        calls++
        throw new Error('ffmpeg must not run for a corrupt WAV container')
      },
    }),
    /not a RIFF\/WAVE file/,
  )
  assert.equal(calls, 0)
})

test('unsupported 24-bit PCM and 32-bit float WAVs fall back to successful ffmpeg decoding', async (t) => {
  const cases = [
    ['pcm24.wav', wavBuffer({ bitsPerSample: 24 })],
    ['float32.wav', wavBuffer({ format: 3, bitsPerSample: 32 })],
  ]
  const calls = []
  const files = []

  for (const [name, buffer] of cases) {
    const file = await tempWav(t, name, buffer)
    files.push(file)
    const result = await transcodeToSilk(file, {
      ffmpegPath: 'fixture-ffmpeg',
      spawnImpl: successfulFfmpeg(decodedPcm, calls),
    })
    assert.equal(result.sampleRate, 24_000)
    assert.ok(result.silk.length > 0)
  }

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(({ command }) => command), ['fixture-ffmpeg', 'fixture-ffmpeg'])
  assert.deepEqual(calls.map(({ args }) => args[3]), files)
})

test('an unsupported WAV keeps a clear ffmpeg-unavailable error when no fallback executable exists', async (t) => {
  const file = await tempWav(t, 'pcm24.wav', wavBuffer({ bitsPerSample: 24 }))
  const missingFfmpeg = path.join(path.dirname(file), 'ffmpeg-does-not-exist')

  await assert.rejects(transcodeToSilk(file, { ffmpegPath: missingFfmpeg }), /ffmpeg unavailable/)
})
