import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readAssistantReply, readSettledTurns } from '../src/session-reader.js'
import { dispatchedTurn } from '../src/session-dispatch-reader.js'

// Projected from the durable events of turn 299. Sequence numbers, boundaries,
// source forms and tool lifecycle are real; payloads and IDs are placeholders.
const events = JSON.parse(readFileSync(new URL('./fixtures/turn-299.json', import.meta.url)))
const answer = 'Sample review: keep the first item.'
const followup = 'Ready when you are.'

for (const [name, read] of [
  ['ordinary', (events, afterSeq) => readAssistantReply({ events, afterSeq })],
  ['spontaneous', (events, afterSeq) => readSettledTurns({ events, afterSeq })[0]],
]) {
  test(name + ': retain the completed relay answer through the notice and tool step', () => {
    const reply = read(events, 5867)
    assert.equal(reply.turnSettled, true)
    assert.equal(reply.settledSeq, 5885)
    assert.deepEqual(reply.text.split(/\s*\n+\s*/), [answer, followup])
  })

  test(name + ': a later human instruction retracts the earlier answer', () => {
    const input = { role: 'user', id: 'retraction', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Withdraw the earlier answer.' }] }
    const retracted = events.map(e => {
      if (e.seq === 5872) return { ...e, data: { ...e.data, inserted: [input] } }
      if (e.seq === 5877) return { ...e, data: input }
      return e
    })
    assert.equal(read(retracted, 5867).text, followup)
  })

  test(name + ': a cursor at the relay answer returns only the later reply', () => {
    assert.equal(read(events, 5873).text, followup)
  })
}

test('turn 299: claimed dispatch cannot recover an answer at its claim cursor', () => {
  const result = dispatchedTurn(events, { action: 'steer', claimedTurn: 299,
    messageId: 'relay-input', afterSeq: 5867, claimedAfterSeq: 5873 })
  assert.equal(result.ok, true)
  assert.equal(result.replyText, followup)
})

test('turn 299: dispatch matched by relay input returns the review and follow-up', () => {
  const result = dispatchedTurn(events, { action: 'followup', messageId: 'relay-input', afterSeq: 5867 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.replyText.split(/\s*\n+\s*/), [answer, followup])
})
