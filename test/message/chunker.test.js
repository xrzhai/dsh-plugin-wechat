import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText } from '../../src/message/chunker.js'

function assertNoSplitSurrogates(chunks) {
  for (const chunk of chunks) {
    assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false, 'chunk must not end with a high surrogate')
    assert.equal(/^[\uDC00-\uDFFF]/.test(chunk), false, 'chunk must not start with a low surrogate')
  }
}

test('fallback cut keeps a surrogate pair in one chunk', () => {
  const text = `${'a'.repeat(1499)}😀${'b'.repeat(10)}`
  const chunks = chunkText(text, 1500)

  assert.equal(chunks.join(''), text)
  assert.deepEqual(chunks.map((chunk) => chunk.length), [1499, 12])
  assertNoSplitSurrogates(chunks)
})

test('cuts move back to grapheme boundaries when the cluster fits the cap', () => {
  const family = '👨‍👩‍👧‍👦'

  assert.deepEqual(
    chunkText(`${'a'.repeat(11)}${family}z`, 12),
    ['a'.repeat(11), `${family}z`],
  )
  assert.deepEqual(
    chunkText(`${'a'.repeat(4)}e\u0301z`, 5),
    ['a'.repeat(4), 'e\u0301z'],
  )
})

test('preserves the existing exact-limit and delimiter preferences', () => {
  assert.deepEqual(chunkText('x'.repeat(11), 5), ['xxxxx', 'xxxxx', 'x'])
  assert.deepEqual(chunkText('abcd\nefgh', 6), ['abcd\n', 'efgh'])
  assert.deepEqual(chunkText('abcd efgh', 6), ['abcd ', 'efgh'])
})

test('keeps an astral scalar intact when the cap cannot contain it', () => {
  const chunks = chunkText('😀a', 1)

  assert.deepEqual(chunks, ['😀', 'a'])
  assertNoSplitSurrogates(chunks)
})
