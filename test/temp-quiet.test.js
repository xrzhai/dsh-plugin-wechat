import assert from 'node:assert/strict'
import test from 'node:test'
import { describeTempQuiet } from '../src/message/temp-quiet.js'

test('temporary quiet describes only behaviour that still exists', () => {
  const now = Date.UTC(2026, 10, 5, 8, 0, 0)
  const text = describeTempQuiet({ until: now + 2 * 60 * 60_000 }, now)
  assert.match(text, /提醒与订阅顺延/)
  assert.match(text, /离开模式不自动回复/)
  assert.doesNotMatch(text, /主动开口/)
})
