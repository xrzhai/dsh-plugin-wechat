/**
 * Read assistant output back out of a DSH agent session.
 *
 * Why this exists: DSH 0.1.5 removed the durable `assistant/chunk` event, so a
 * plugin cannot read a reply by watching chunk events. Text settles in
 * `assistant/message`, with an embedded `stream`; live deltas arrive only as
 * process-local `agent/assistant-stream` frames and are never durable.
 * `assistant/attempt` records a failed or retried attempt and is never final.
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
const SETTLED_TYPES = new Set(['assistant/message'])
const TURN_EVENT_TYPES = new Set(['tool/call', 'tool/result', 'turn/end', 'assistant/attempt', ...SETTLED_TYPES])

const isPureSilent = text => /^\[SILENT\]$/i.test(text.trim())

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

export function isIndependentInstruction(source) {
  return ['user', 'weixin-dispatch'].includes(source?.kind)
}

export function isReplyBoundary(source) {
  return isIndependentInstruction(source) || source?.kind === 'relay' || source?.form === 'relay'
}

/**
 * Read the latest settled assistant reply plus in-flight tool activity.
 *
 * @param {object} params
 * @param {readonly any[]} params.events  `agent.session.snapshotEvents()`.
 * @param {number} [params.afterSeq]      Ignore events at or below this seq, so a
 *   reply is never re-sent when the same conversation continues.
 * @returns {{ text: string, settledSeq: number, pendingTools: string[], sawTurnBoundary: boolean,
 *   turnError: (string | undefined), turnErrorCode: (string | undefined), turnReason: (string | undefined), turnSettled: boolean }}
 * `turnReason` is undefined until a terminal event is observed; a missing
 * reason on that event becomes `unknown`. Text from a non-completed turn may
 * be a partial assistant message and must not be presented as a final answer.
 */
export function readAssistantReply({ events, afterSeq = -1, messageId, claimedTurn }) {
  if (messageId !== undefined) {
    const all = events ?? []
    const input = all.findIndex(event => event?.seq > afterSeq && event.type === 'user/message' && event.data?.id === messageId)
    if (input >= 0) {
      const start = all.findLastIndex((event, index) => index < input && event.type === 'turn/start')
      if (start < 0) return readAssistantReply({ events: [] })
      const boundary = all.findLastIndex((event, index) => index < input && index > start && (event.type === 'step/start' || event.type === 'step/end'))
      const stepStart = boundary > start && all[boundary].type === 'step/start' ? [all[boundary]] : []
      const remaining = all.slice(input)
      const end = remaining.findIndex((event, index) => index > 0 && (event.type === 'turn/end' || event.type === 'turn/start'))
      const turnEvents = end < 0 ? remaining : remaining.slice(0, end + (remaining[end].type === 'turn/end' ? 1 : 0))
      const superseded = turnEvents.slice(1).some(event => event.type === 'user/message'
        && isIndependentInstruction(event.data?.source) && event.data?.id !== messageId)
      const result = readAssistantReply({ events: [all[start], ...stepStart, ...turnEvents] })
      return superseded ? { ...result, text: '', superseded: true } : result
    }
    // A claimed turn may fail before its input reaches the message surface.
    // Only its terminal failure is safe to report without that input event.
    const start = all.findLastIndex(event => event.type === 'turn/start' && event.data?.turn === claimedTurn)
    const following = start < 0 ? [] : all.slice(start + 1)
    const boundary = following.findIndex(event => event.type === 'turn/end' || event.type === 'turn/start')
    const end = boundary < 0 ? undefined : following[boundary]
    if (claimedTurn !== undefined && end?.type === 'turn/end' && end.seq > afterSeq && end.data?.turn === claimedTurn && end.data?.reason?.kind !== 'completed') {
      return readAssistantReply({ events: [all[start], end] })
    }
    return readAssistantReply({ events: [] })
  }

  let text = ''
  let settledSeq = -1
  let sawTurnBoundary = false
  let turnError
  let turnErrorCode
  let turnReason
  let turnSettled = false
  let turnEvents = []
  /** @type {Map<string, string>} */
  const pending = new Map()

  for (const event of events ?? []) {
    if (typeof event?.seq === 'number' && event.seq <= afterSeq) continue
    if (event?.type === 'turn/start') turnEvents = [event]
    else turnEvents.push(event)
    switch (event?.type) {
      case 'turn/start':
        // A new turn invalidates anything collected from the previous one.
        sawTurnBoundary = true
        text = ''
        settledSeq = typeof event.seq === 'number' ? event.seq : -1
        pending.clear()
        turnError = undefined
        turnErrorCode = undefined
        turnReason = undefined
        turnSettled = false
        break
      case 'turn/end': {
        // Preserve the reason: an ended turn is not necessarily successful.
        const reason = event.data?.reason
        turnReason = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
        if (typeof event.seq === 'number' && event.seq > settledSeq) {
          settledSeq = event.seq
        }
        if (reason?.kind === 'error') {
          const message = reason.error?.message
          turnError = typeof message === 'string' && message !== '' ? message : 'unknown error'
          turnErrorCode = typeof reason.error?.code === 'string' ? reason.error.code : undefined
        }
        turnSettled = reason?.kind === 'completed'
        if (turnSettled) text = completedTurnReply(turnEvents, text).text
        break
      }
      case 'user/message':
        if (isReplyBoundary(event.data?.source)) text = ''
        break
      case 'assistant/attempt':
        text = ''
        break
      case 'tool/call': {
        text = ''
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
        if (event.data?.interrupted === true || event.data?.message?.content?.some?.(block => block?.type === 'tool-call')) { text = ''; break }
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

  return { text, settledSeq, pendingTools: [...pending.values()], sawTurnBoundary, turnError, turnErrorCode, turnSettled, turnReason }
}

function completeMessage(events, index, before = events.length) {
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
  if (start < 0 || !sameStep(events[start]) || end < 0 || end >= before
    || events[end].type !== 'step/end' || !sameStep(events[end])) return false
  const stepEvents = events.slice(start + 1, end)
  return stepEvents.filter(item => item.type === 'assistant/message').length === 1
    && !stepEvents.some(item => item.type === 'assistant/attempt' || item.type === 'tool/call' || item.type === 'tool/result')
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
export function replyBeforeSilent(events, afterSeq = -1) {
  const body = event => streamText(event.data?.stream) || messageText(event.data?.message)
  const outputIndexes = events.flatMap((event, index) =>
    SETTLED_TYPES.has(event.type) && body(event) !== '' ? [index] : [])
  const last = outputIndexes.at(-1)
  if (last === undefined || !isPureSilent(body(events[last]))) return undefined

  if (!completeMessage(events, last)) return undefined
  const candidate = outputIndexes.findLast(index => index < last && !isPureSilent(body(events[index])))
  if (candidate === undefined || events[candidate].seq <= afterSeq || !completeMessage(events, candidate)) return undefined
  // A later human instruction may retract the earlier answer. Do not walk past
  // tool work, failed attempts, or an unverified silent step to resurrect it.
  for (let i = candidate + 1; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'assistant/attempt' || event.type === 'tool/call' || event.type === 'tool/result'
      || (event.type === 'user/message' && isReplyBoundary(event.data?.source))
      || (event.type !== 'system/message' && event.surfaceOp !== null && typeof event.surfaceOp === 'object')) return undefined
    if (event.type === 'assistant/message' && (!isPureSilent(body(event)) || !completeMessage(events, i))) return undefined
  }
  return { text: messageText(events[candidate].data.message), seq: events[candidate].seq }
}

// A notice starts another piece of work within the same host turn. Save the
// preceding completed step there, before the notice's tools can clear it.
export function completedTurnReply(events, text, afterSeq = -1) {
  const silent = isPureSilent(text) ? replyBeforeSilent(events, afterSeq) : undefined
  const saved = []
  let candidate = -1
  for (const [i, event] of events.entries()) {
    if (event.seq <= afterSeq) continue
    const source = event.data?.source
    if ((event.type === 'user/message' && isReplyBoundary(source))
      || (event.type !== 'system/message' && event.surfaceOp && typeof event.surfaceOp === 'object')) {
      candidate = -1
      saved.length = 0
    } else if (event.type === 'user/message' && (source?.form === 'notice' || source?.kind === 'subagent-settled')) {
      if (candidate >= 0 && completeMessage(events, candidate, i)) {
        const body = messageText(events[candidate].data.message)
        if (!isControlReply(body)) saved.push({ text: body, seq: events[candidate].seq })
      }
      candidate = -1
    } else if (event.type === 'assistant/message') candidate = i
    else if (['tool/call', 'tool/result', 'assistant/attempt'].includes(event.type)) candidate = -1
  }
  if (!saved.length || (candidate >= 0 && !completeMessage(events, candidate))) {
    return { text: silent?.text ?? text, silentRecoveredFromSeq: silent?.seq }
  }
  const tail = silent?.text ?? text
  const tailSeq = silent?.seq ?? events[candidate]?.seq
  if (tailSeq > saved.at(-1).seq && !isControlReply(tail) && tail.trim()) saved.push({ text: tail, seq: tailSeq })
  return { text: saved.map(part => part.text).join('\n\n'), silentRecoveredFromSeq: isPureSilent(text) ? saved[0].seq : undefined }
}

function isControlReply(text) {
  return /^(?:\[SILENT\]|HEARTBEAT_OK|（已取消）|（静默）)/i.test(text.trim())
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
 *   turnError: (string | undefined), turnErrorCode: (string | undefined), turnReason: string, turnSettled: boolean, silentRecoveredFromSeq?: number }>}
 */
export function readSettledTurns({ events, afterSeq = -1 }) {
  /** @type {Array<{ text: string, settledSeq: number, pendingTools: string[], turnError: (string | undefined), turnErrorCode: (string | undefined), turnReason: string, turnSettled: boolean, silentRecoveredFromSeq?: number }>} */
  const turns = []
  let current = null
  let inputs = []
  let latestInstructionSeq = -1
  function initTurn(seq) {
    return {
      text: '',
      settledSeq: typeof seq === 'number' ? seq : -1,
      /** @type {Map<string, string>} */
      pending: new Map(),
      turnError: undefined,
      turnErrorCode: undefined,
      turnReason: undefined,
      turnSettled: false,
      events: [],
    }
  }

  for (const event of events ?? []) {
    if (event?.type === 'turn/start') { inputs = []; latestInstructionSeq = -1 }
    if (event?.type === 'user/message') {
      if (typeof event.data?.id === 'string') inputs.push({ id: event.data.id, seq: event.seq })
      if (isIndependentInstruction(event.data?.source) && Number.isFinite(event.seq)) latestInstructionSeq = event.seq
    }
    if (typeof event?.seq === 'number' && event.seq <= afterSeq) continue

    if (event?.type === 'turn/start') {
      current = initTurn(event.seq)
      current.events.push(event)
      continue
    }

    if (current === null) {
      if (!TURN_EVENT_TYPES.has(event?.type)) continue
      current = initTurn(event?.seq)
    }
    current.events.push(event)

    if (typeof event?.seq === 'number' && event.seq > current.settledSeq) {
      current.settledSeq = event.seq
    }

    switch (event?.type) {
      case 'turn/end': {
        const reason = event.data?.reason
        current.turnReason = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
        if (reason?.kind === 'error') {
          const message = reason.error?.message
          current.turnError = typeof message === 'string' && message !== '' ? message : 'unknown error'
          current.turnErrorCode = typeof reason.error?.code === 'string' ? reason.error.code : undefined
        }
        current.turnSettled = reason?.kind === 'completed'
        if (typeof event.seq === 'number' && event.seq > current.settledSeq) {
          current.settledSeq = event.seq
        }
        const reply = current.turnSettled ? completedTurnReply(current.events, current.text) : { text: current.text }
        turns.push({
          text: reply.text,
          ...(reply.silentRecoveredFromSeq !== undefined ? { silentRecoveredFromSeq: reply.silentRecoveredFromSeq } : {}),
          settledSeq: current.settledSeq,
          turn: event.data?.turn,
          inputIds: inputs.map(input => input.id),
          inputs: [...inputs],
          latestInstructionSeq,
          pendingTools: [...current.pending.values()],
          turnError: current.turnError,
          turnErrorCode: current.turnErrorCode,
          turnReason: current.turnReason,
          turnSettled: current.turnSettled,
        })
        current = null
        break
      }
      case 'user/message':
        if (isReplyBoundary(event.data?.source)) current.text = ''
        break
      case 'assistant/attempt':
        current.text = ''
        break
      case 'tool/call': {
        current.text = ''
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
        if (event.data?.interrupted === true || event.data?.message?.content?.some?.(block => block?.type === 'tool-call')) { current.text = ''; break }
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
