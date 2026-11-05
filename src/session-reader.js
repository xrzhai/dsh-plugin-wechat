/**
 * Read assistant output back out of a DSH agent session.
 *
 * Why this exists: DSH 0.1.5 removed the durable `assistant/chunk` event, so a
 * plugin cannot read a reply by watching chunk events. Text settles in
 * `assistant/message` (or `assistant/attempt` for a failed attempt), each with
 * an embedded `stream`; live deltas arrive only as process-local
 * `agent/assistant-stream` frames and are never durable.
 *
 * This reader therefore: (1) waits for the settled event, (2) reassembles text
 * from the embedded stream, and (3) optionally reports still-pending tool calls
 * so a WeChat user is not left staring at silence during a long task.
 *
 * The stream walk mirrors dsh-better-sidebar's own snapshot reader
 * (`src/sidechat-core.ts`, `streamTexts` / `messageTexts` / `liveTexts`).
 * @module dsh-weixin/session-reader
 */

/** Durable event types that carry settled assistant output. */
const SETTLED_TYPES = new Set(['assistant/message', 'assistant/attempt'])
const TURN_EVENT_TYPES = new Set(['tool/call', 'tool/result', 'turn/end', ...SETTLED_TYPES])

/**
 * Sum the text of every text content block in a settled assistant message.
 * @param {any} message
 */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Reassemble text from an embedded stream record.
 *
 * Two shapes occur in practice:
 *  - `{ type: 'text-chunks' | 'reasoning-chunks', texts: string[] }`
 *  - `{ type: 'chunk', chunk: { type: 'text-delta', text } }`
 * Only `text-*` kinds contribute: reasoning is deliberately not sent to WeChat.
 * @param {any} stream
 */
export function streamText(stream) {
  if (!Array.isArray(stream)) return ''
  let out = ''
  for (const entry of stream) {
    if (entry?.type === 'text-chunks' && Array.isArray(entry.texts)) {
      out += entry.texts.join('')
    } else if (entry?.type === 'chunk') {
      const chunk = entry.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
  }
  return out
}

/**
 * Read the latest settled assistant reply plus in-flight tool activity.
 *
 * @param {object} params
 * @param {readonly any[]} params.events  `agent.session.snapshotEvents()`.
 * @param {number} [params.afterSeq]      Ignore events at or below this seq, so a
 *   reply is never re-sent when the same conversation continues.
 * @returns {{ text: string, settledSeq: number, pendingTools: string[], sawTurnBoundary: boolean,
 *   turnError: (string | undefined), turnSettled: boolean }} `turnError` is set when the turn ended
 *   in an error (`turn/end` with `reason.kind === 'error'`, e.g. a model
 *   provider failure). A failed turn carries NO assistant text — the attempts
 *   hold only usage/finish chunks — so without surfacing this the caller spins
 *   for the whole wait budget while holding the conversation's busy lock, and
 *   the user's next message queues behind a turn that can never answer.
 */
export function readAssistantReply({ events, afterSeq = -1 }) {
  let text = ''
  let settledSeq = -1
  let sawTurnBoundary = false
  let turnError
  let inTurn = false
  let turnSettled = false
  /** @type {Map<string, string>} */
  const pending = new Map()

  for (const event of events ?? []) {
    if (typeof event?.seq === 'number' && event.seq <= afterSeq) continue
    switch (event?.type) {
      case 'turn/start':
        // A new turn invalidates anything collected from the previous one.
        sawTurnBoundary = true
        text = ''
        settledSeq = typeof event.seq === 'number' ? event.seq : -1
        pending.clear()
        turnError = undefined
        inTurn = true
        turnSettled = false
        break
      case 'turn/end': {
        // The terminal event of every turn. `reason.kind === 'completed'`
        // means the answer arrived as assistant/message; `error` means the
        // turn is over and NO reply is coming — surface it so the caller can
        // answer the user immediately instead of waiting out the deadline.
        inTurn = false
        const reason = event.data?.reason
        if (typeof event.seq === 'number' && event.seq > settledSeq) {
          settledSeq = event.seq
        }
        if (reason?.kind === 'error') {
          const message = reason.error?.message
          turnError = typeof message === 'string' && message !== '' ? message : 'unknown error'
          turnSettled = false
        } else {
          turnSettled = true
        }
        break
      }
      case 'tool/call': {
        const callId = event.data?.callId
        if (typeof callId === 'string') {
          pending.set(callId, typeof event.data.name === 'string' ? event.data.name : 'tool')
        }
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.source?.callId
        if (typeof callId === 'string') pending.delete(callId)
        break
      }
      default:
        if (!SETTLED_TYPES.has(event.type)) break
        // Prefer the embedded stream when present; fall back to the message body.
        const fromStream = streamText(event.data?.stream)
        const fromMessage = messageText(event.data?.message)
        const body = fromStream !== '' ? fromStream : fromMessage
        if (body !== '') {
          text = body
          settledSeq = typeof event.seq === 'number' ? event.seq : settledSeq
        }
        break
    }
  }

  if (!sawTurnBoundary && text !== '' && pending.size === 0 && turnError === undefined && !inTurn) {
    turnSettled = true
  }

  return { text, settledSeq, pendingTools: [...pending.values()], sawTurnBoundary, turnError, turnSettled }
}

/**
 * A successful model step can finish before a newly injected notice keeps the
 * SAME host turn running. Recover only its last complete reply when later steps
 * say just [SILENT]. This is not a search for arbitrary earlier nonempty text.
 *
 * DSH agent-loop 0.2.2-rc.1 records identified step boundaries, a canonical
 * assistant/message, and a compact stream ending in finish(stop). Tool-bearing
 * messages, log-only attempts and interruption prefixes are not final replies.
 * Older/unknown event shapes keep the existing behavior rather than guessing.
 */
function replyBeforeSilent(events) {
  const pureSilent = text => /^\[SILENT\]$/i.test(text.trim())
  const body = event => streamText(event.data?.stream) || messageText(event.data?.message)
  const outputIndexes = events.flatMap((event, index) =>
    SETTLED_TYPES.has(event.type) && body(event) !== '' ? [index] : [])
  const last = outputIndexes.at(-1)
  if (last === undefined || !pureSilent(body(events[last]))) return undefined

  function completeMessage(index) {
    const event = events[index], data = event.data, message = data?.message
    if (event.type !== 'assistant/message' || data?.interrupted === true
      || event.surfaceOp !== 'append'
      || !Number.isSafeInteger(event.seq)
      || !Number.isSafeInteger(data?.turn) || !Number.isSafeInteger(data?.step)
      || events[0]?.type !== 'turn/start' || events[0].data?.turn !== data.turn
      || message?.role !== 'assistant' || message.source?.kind !== 'model'
      || !Array.isArray(message.content) || message.content.some(block => block?.type === 'tool-call')) return false
    // Both representations must agree before replaying an earlier response.
    const text = messageText(message)
    const streamedText = streamText(data.stream)
    if (text === '' || (streamedText !== '' && streamedText !== text)) return false
    const stream = data.stream
    if (!Array.isArray(stream) || stream.at(-1)?.type !== 'chunk'
      || stream.at(-1)?.chunk?.type !== 'finish' || stream.at(-1).chunk.reason?.kind !== 'stop') return false
    if (stream.some(record => record?.type === 'tool-call-chunks'
      || record?.chunk?.type === 'tool-call-delta'
      || record?.chunk?.blockType === 'tool-call' || record?.chunk?.block?.type === 'tool-call')) return false
    const sameStep = item => item.data?.turn === data.turn && item.data?.step === data.step
    const start = events.findLastIndex((item, i) => i < index && item.type === 'step/start')
    const end = events.findIndex((item, i) => i > index && (item.type === 'step/start' || item.type === 'step/end' || item.type === 'turn/end'))
    if (start < 0 || !sameStep(events[start]) || end < 0
      || events[end].type !== 'step/end' || !sameStep(events[end])) return false
    const stepEvents = events.slice(start + 1, end)
    return stepEvents.filter(item => item.type === 'assistant/message').length === 1
      && !stepEvents.some(item => item.type === 'assistant/attempt' || item.type === 'tool/call' || item.type === 'tool/result')
  }

  if (!completeMessage(last)) return undefined
  const candidate = outputIndexes.findLast(index => index < last && !pureSilent(body(events[index])))
  if (candidate === undefined || !completeMessage(candidate)) return undefined
  // A later human instruction may retract the earlier answer. Do not walk past
  // tool work, failed attempts, or an unverified silent step to resurrect it.
  for (let i = candidate + 1; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'assistant/attempt' || event.type === 'tool/call' || event.type === 'tool/result'
      || (event.type === 'user/message' && event.data?.source?.kind === 'user')
      || typeof event.surfaceOp === 'object') return undefined
    if (event.type === 'assistant/message' && (!pureSilent(body(event)) || !completeMessage(i))) return undefined
  }
  return { text: messageText(events[candidate].data.message), seq: events[candidate].seq }
}

/**
 * Read all settled turns after `afterSeq`.
 *
 * Splitting by turn boundaries ensures multi-turn streams (e.g. Subagent
 * completion reporting followed by a silent exit turn) do not overwrite earlier
 * un-delivered replies before they reach the user.
 *
 * @param {object} params
 * @param {readonly any[]} params.events  `agent.session.snapshotEvents()`.
 * @param {number} [params.afterSeq]      Ignore events at or below this seq.
 * @returns {Array<{ text: string, settledSeq: number, pendingTools: string[],
 *   turnError: (string | undefined), turnSettled: boolean, silentRecoveredFromSeq?: number }>}
 */
export function readSettledTurns({ events, afterSeq = -1 }) {
  /** @type {Array<{ text: string, settledSeq: number, pendingTools: string[], turnError: (string | undefined), turnSettled: boolean }>} */
  const turns = []
  let current = null
  let sawTurnBoundary = false

  function initTurn(seq, inTurn = false) {
    return {
      text: '',
      settledSeq: typeof seq === 'number' ? seq : -1,
      /** @type {Map<string, string>} */
      pending: new Map(),
      turnError: undefined,
      inTurn,
      turnSettled: false,
      events: [],
    }
  }

  for (const event of events ?? []) {
    if (typeof event?.seq === 'number' && event.seq <= afterSeq) continue

    if (event?.type === 'turn/start') {
      sawTurnBoundary = true
      current = initTurn(event.seq, true)
      current.events.push(event)
      continue
    }

    if (current === null) {
      if (!TURN_EVENT_TYPES.has(event?.type)) continue
      current = initTurn(event?.seq, false)
    }
    current.events.push(event)

    if (typeof event?.seq === 'number' && event.seq > current.settledSeq) {
      current.settledSeq = event.seq
    }

    switch (event?.type) {
      case 'turn/end': {
        current.inTurn = false
        const reason = event.data?.reason
        if (reason?.kind === 'error') {
          const message = reason.error?.message
          current.turnError = typeof message === 'string' && message !== '' ? message : 'unknown error'
          current.turnSettled = false
        } else {
          current.turnSettled = true
        }
        if (typeof event.seq === 'number' && event.seq > current.settledSeq) {
          current.settledSeq = event.seq
        }
        const recovered = reason?.kind === 'completed' && /^\[SILENT\]$/i.test(current.text.trim())
          ? replyBeforeSilent(current.events) : undefined
        turns.push({
          text: recovered?.text ?? current.text,
          ...(recovered ? { silentRecoveredFromSeq: recovered.seq } : {}),
          settledSeq: current.settledSeq,
          pendingTools: [...current.pending.values()],
          turnError: current.turnError,
          turnSettled: current.turnSettled,
        })
        current = null
        break
      }
      case 'tool/call': {
        const callId = event.data?.callId
        if (typeof callId === 'string') {
          current.pending.set(callId, typeof event.data.name === 'string' ? event.data.name : 'tool')
        }
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.source?.callId
        if (typeof callId === 'string') current.pending.delete(callId)
        break
      }
      default:
        if (!SETTLED_TYPES.has(event.type)) break
        const fromStream = streamText(event.data?.stream)
        const fromMessage = messageText(event.data?.message)
        const body = fromStream !== '' ? fromStream : fromMessage
        if (body !== '') {
          current.text = body
          if (typeof event.seq === 'number' && event.seq > current.settledSeq) {
            current.settledSeq = event.seq
          }
        }
        break
    }
  }

  if (
    !sawTurnBoundary &&
    current !== null &&
    current.text !== '' &&
    current.pending.size === 0 &&
    current.turnError === undefined &&
    !current.inTurn
  ) {
    turns.push({
      text: current.text,
      settledSeq: current.settledSeq,
      pendingTools: [],
      turnError: undefined,
      turnSettled: true,
    })
  }

  return turns
}

/**
 * Build a short progress line for a turn that has not settled yet.
 *
 * The elapsed time is part of the line because "still thinking" says nothing
 * about whether the turn is stuck; "已 42 秒" does. It is also what makes a
 * changed-tool re-announcement distinguishable from a repeat (C16).
 *
 * @param {readonly string[]} pendingTools
 * @param {number} [elapsedMs] how long the turn has been running
 */
export function describePending(pendingTools, elapsedMs = 0) {
  const seconds = Math.max(0, Math.round(Number(elapsedMs) / 1000))
  const clock = seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
  if (pendingTools.length === 0) return `thinking… (${clock})`
  const shown = pendingTools.slice(0, 3).join(', ')
  const more = pendingTools.length > 3 ? ` +${pendingTools.length - 3}` : ''
  return `running: ${shown}${more} (${clock})`
}
