import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectMediaReferences, splitOutboundMedia } from '../../src/media/outbound.js'

test('media references inside an inline code span stay masked before a non-BMP character', () => {
  const text = '这是用法😀：`![x](a.png)` 结束'

  assert.deepEqual(detectMediaReferences(text), [])
  assert.deepEqual(splitOutboundMedia(text), { text, media: [] })
})

test('a real media reference after non-BMP characters is still detected outside code', () => {
  const text = '😀 `a😀b` ![real](real.png)'
  const media = detectMediaReferences(text)

  assert.equal(media.length, 1)
  assert.equal(media[0].path, 'real.png')
  assert.equal(media[0].index, text.indexOf('![real]'))
  assert.deepEqual(splitOutboundMedia(text), {
    text: '😀 `a😀b` real',
    media,
  })
})

test('ASCII inline-code masking keeps its existing behavior', () => {
  const text = 'plain `![x](a.png)` end and ![real](real.png)'
  const media = detectMediaReferences(text)

  assert.deepEqual(media.map((reference) => reference.path), ['real.png'])
  assert.equal(splitOutboundMedia(text).text, 'plain `![x](a.png)` end and real')
})
