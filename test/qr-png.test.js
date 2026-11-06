import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { qrDataUrl } from '../src/qr-png.js'
import { WeixinLoginController } from '../src/login-remote.js'

test('a synthetic login link produces a QR PNG in memory', async () => {
  const result = await qrDataUrl('https://example.test/qr/synthetic-login')
  assert.match(result, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
  const png = Buffer.from(result.slice('data:image/png;base64,'.length), 'base64')
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const side = png.readUInt32BE(16)
  assert.equal(png.readUInt32BE(20), side)
  assert.equal(png[24], 1) // one-bit greyscale
  assert.equal(png[25], 0)
  let offset = 8
  const compressed = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const pixels = inflateSync(Buffer.concat(compressed))
  const stride = Math.ceil(side / 8)
  assert.equal(pixels.length, (stride + 1) * side)
  const isWhite = (x, y) => (pixels[y * (stride + 1) + 1 + (x >> 3)] & (0x80 >> (x & 7))) !== 0
  assert.equal(isWhite(0, 0), true)
  assert.equal(isWhite(47, 47), true) // four-module quiet zone
  assert.equal(isWhite(48, 48), false) // finder pattern starts after the border
  assert.notEqual(result, await qrDataUrl('https://example.test/qr/another-login'))
})

test('desktop login returns the generated image for a synthetic protocol response', async (t) => {
  const ctx = new Context()
  const controller = new WeixinLoginController(ctx, {
    apiPostFetch: async () => JSON.stringify({ qrcode: 'synthetic-id', qrcode_img_content: 'https://example.test/qr/synthetic-login' }),
  })
  t.after(async () => { await ctx.fiber.dispose() })
  const login = await controller.startLogin()
  t.after(async () => { await controller.cancel(login.sessionKey) })
  assert.equal(login.qrcodeUrl, 'https://example.test/qr/synthetic-login')
  assert.match(login.qrDataUrl, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
})
