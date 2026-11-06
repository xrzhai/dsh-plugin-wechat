// Dispatch readers deliberately do not use the gateway's latest-reply reader:
// several turns can settle between polls, and only the marked turn belongs to us.
import { isIndependentInstruction, isReplyBoundary, completedTurnReply, streamText } from './session-reader.js'

export const clip = (value, max = 2000) => {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  if (max < 14) return text.slice(0, Math.max(0, max))
  return `${text.slice(0, max - 14)}…[truncated]`
}
export function messageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('')
}
function textOf(event) {
  return streamText(event?.data?.stream) || messageText(event?.data?.message ?? event?.data)
}
export function lastSeq(events) {
  let seq = -1
  for (const event of events ?? []) if (Number.isFinite(event?.seq)) seq = Math.max(seq, event.seq)
  return seq
}
export function dispatchedTurn(events, job) {
  const { dispatchId, afterSeq, action, claimedTurn, cancelTurn } = job
  if (job.discarded) return { done: true, ok: false, replyText: '', toolsExecuted: [], notice: 'Instruction was discarded before being claimed by a target turn.' }
  let turn
  let matched = false
  let text = ''
  let superseded = false
  let turnEvents = []
  const tools = new Set()
  for (const event of events ?? []) {
    if (event.type === 'turn/start') {
      turnEvents = []
      turn = event.data?.turn
      matched = (claimedTurn !== undefined && turn === claimedTurn)
        || (action === 'cancel' && cancelTurn !== undefined && turn === cancelTurn)
      text = ''
      superseded = false
      tools.clear()
    }
    turnEvents.push(event)
    // Enqueue/splice is NOT ownership: a queued followup can be inserted while
    // a completely different turn is still running. Only claimed input counts.
    const ownInput = event.type === 'user/message'
      && ((dispatchId !== undefined && event.data?.source?.dispatchId === dispatchId) || (job.messageId !== undefined && event.data?.id === job.messageId))
    if (event.seq > afterSeq && ownInput) matched = true
    if (matched && action !== 'cancel' && event.seq > Math.max(afterSeq, job.claimedAfterSeq ?? afterSeq)
      && event.type === 'user/message' && !ownInput && isIndependentInstruction(event.data?.source)) superseded = true
    if (matched && event.seq > afterSeq && event.type === 'tool/call') tools.add(clip(event.data?.name, 120))
    if (matched && action !== 'cancel' && event.seq > Math.max(afterSeq, job.claimedAfterSeq ?? afterSeq)) {
      if (event.type === 'tool/call' || event.type === 'assistant/attempt'
        || (event.type === 'user/message' && isReplyBoundary(event.data?.source))) text = ''
      if (event.type === 'assistant/message') {
        const interrupted = event.data?.interrupted === true || event.data?.message?.content?.some?.(block => block?.type === 'tool-call')
        text = interrupted ? '' : streamText(event.data?.stream) || messageText(event.data?.message ?? event.data)
      }
    }
    if (event.type === 'turn/end' && event.seq > afterSeq && matched
      && (turn === undefined || event.data?.turn === undefined || event.data.turn === turn)) {
      const reason = event.data?.reason
      if (superseded) return { done: true, ok: false, replyText: '', toolsExecuted: [...tools].filter(Boolean).slice(0, 50), notice: 'A later instruction superseded this dispatch before its result settled.' }
      const ok = action === 'cancel' ? reason?.kind === 'aborted' && reason.reason?.kind === 'user' : reason?.kind === 'completed'
      if (ok && action !== 'cancel') {
        text = completedTurnReply(turnEvents, text, Math.max(afterSeq, job.claimedAfterSeq ?? afterSeq)).text
      }
      return { done: true, ok, replyText: clip(ok ? text : '', 8000), toolsExecuted: [...tools].filter(Boolean).slice(0, 50),
        ...(ok ? (action === 'cancel' ? { notice: 'Target turn cancelled; queued inbox was preserved.' } : {}) : { notice: `Target turn ended: ${reason?.kind ?? 'unknown'}.` }) }
    }
    if (event.type === 'turn/end') matched = false
  }
  return { done: false }
}
export function recentSessionTurns(events, depth = 5, includeTools = true) {
  const rounds = [[]]
  const pending = new Map()
  let lastReply = ''
  for (const event of events ?? []) {
    if (event.type === 'turn/start') { rounds.push([]); pending.clear() }
    const timestamp = Number.isFinite(event.time) ? event.time : Number.isFinite(event.ts) ? event.ts : Number.isFinite(event.timestamp) ? event.timestamp : 0
    let row
    if (event.type === 'user/message') row = { role: 'user', text: clip(textOf(event)), timestamp }
    if (event.type === 'assistant/message') {
      lastReply = clip(textOf(event), 4000)
      row = { role: 'assistant', text: clip(lastReply), timestamp }
    }
    if (event.type === 'tool/call') {
      const name = clip(event.data?.name, 120)
      pending.set(event.data?.callId, name)
      if (includeTools) row = { role: 'tool', text: `Running: ${name}`, timestamp, toolsUsed: [name] }
    }
    if (event.type === 'tool/result') {
      const id = event.data?.message?.source?.callId
      const name = pending.get(id)
      pending.delete(id)
      if (includeTools) row = { role: 'tool', text: clip(textOf(event)), timestamp, ...(name ? { toolsUsed: [name] } : {}) }
    }
    if (event.type === 'turn/end') pending.clear()
    if (row) rounds[rounds.length - 1].push(row)
    if (rounds.length > depth + 1) rounds.shift()
  }
  // Budget counts all rows, not only each row. Prefer the most recent data.
  const rows = rounds.slice(-depth).flat().slice(-100)
  let budget = 12000
  const recentTurns = []
  for (let i = rows.length - 1; i >= 0 && budget > 0; i--) {
    const row = { ...rows[i], text: clip(rows[i].text, Math.min(2000, budget)) }
    budget -= row.text.length + 200
    recentTurns.unshift(row)
  }
  return { lastReply, recentTurns, ...(includeTools ? { activeTools: [...pending.values()].slice(0, 30) } : {}) }
}
