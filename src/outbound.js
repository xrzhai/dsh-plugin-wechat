// Outbound delivery: the part of the plugin that gets text and files out of the
// process and onto Weixin.
//
// These functions used to sit at the bottom of src/index.js, next to 2000 lines
// of wiring they have nothing to do with. The dependencies they used to reach
// for through module-scope `let`s (journal sink, outbox, hook bus, logger) are
// injected once at setup through configureOutbound.
import { channelFor } from './channel.js'
import { HOOK_POINTS } from './hooks.js'
import { chunkText } from './message/chunker.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'
import { planRichContent, writeSnippets } from './message/rich-content.js'

/** Wired in setup; every field defaults so a test can exercise one sender. */
const runtime = {
  journal: null,
  outbox: undefined,
  hooks: undefined,
  // Where long code blocks are written before they are sent as attachments.
  snippetsDir: '',
  warn: () => {},
}

/** Hand the send path its collaborators (journal sink, outbox, hook bus, logger). */
export function configureOutbound(deps = {}) {
  if ('journal' in deps) runtime.journal = deps.journal
  if ('outbox' in deps) runtime.outbox = deps.outbox
  if ('hooks' in deps) runtime.hooks = deps.hooks
  if ('snippetsDir' in deps) runtime.snippetsDir = deps.snippetsDir
  if (typeof deps.warn === 'function') runtime.warn = deps.warn
}

/**
 * Send one outbound text body, filtered and then split to fit Weixin.
 *
 * Order matters: the reply is converted to plain text *before* it is chunked,
 * because the filter changes the length (stripping `**`/`#####`/image markup)
 * and every chunk must be measured against the converted text. Chunking first
 * would both ship markdown markers and risk an over-length message.
 *
 * @param {ILinkTransport} transport
 * @param {{ maxMessageLength: number, markdownMode?: 'strip'|'off', richContent?: boolean, codeFileThreshold?: number }} config
 * @param {{ conversationId: string, text: string, contextToken?: string, durable?: boolean }} message
 *   `durable: false` marks a transient note (progress, timeout notice): if it
 *   fails it is dropped, never queued. Everything else defaults to durable.
 */
export async function sendChunked(transport, config, message) {
  // SILENT is a host control reply, not a user-facing message. Ordinary and
  // late replies share this boundary but bypass the spontaneous-turn filter.
  // Check the whole raw body before splitting, journaling, or retry enqueue;
  // prose that merely mentions the marker must remain intact.
  if (/^\[SILENT\]$/i.test((message.text ?? '').trim())) return

  // Rich replies (C17). Weixin has one body kind — plain text — so the useful
  // move is not to "support Markdown" but to stop losing what Markdown carried:
  // a long code block becomes a real file attachment (indentation, language and
  // line count intact) and a table becomes column-aligned text. Short snippets
  // stay inline; a two-line example reads better in the bubble.
  const plan = config.richContent === false
    ? { text: message.text ?? '', files: [] }
    : planRichContent(message.text ?? '', { codeFileChars: config.codeFileThreshold })
  const text = markdownToPlainText(plan.text, resolveMarkdownMode(config))
  runtime.journal?.({
    accountId: transport.accountId,
    conversationId: message.conversationId,
    text,
  })
  const chunks = chunkText(text, config.maxMessageLength)
  for (let index = 0; index < chunks.length; index += 1) {
    // Everything downstream of here talks to a Channel, not a transport: the
    // shape of a text send lives in one place (src/channel.js) instead of being
    // re-derived by every caller.
    const channel = channelFor(transport)
    const chunk = { conversationId: message.conversationId, text: chunks[index], contextToken: message.contextToken }
    runtime.hooks?.emit(HOOK_POINTS.outboundReady, { accountId: transport.accountId, conversationId: message.conversationId, text: chunk.text })
    try {
      await channel.sendText(chunk)
      runtime.hooks?.emit(HOOK_POINTS.outboundSettled, { accountId: transport.accountId, conversationId: message.conversationId, sent: true })
    } catch (error) {
      // A send that fails here used to lose the text forever: the model had
      // already written it and nothing held a copy. Queue the exact unsent
      // chunks, not their concatenation: the outbox retries them one by one and
      // records progress after each success, so neither a retry nor a restart
      // can resend the successful prefix or create one oversized message.
      const pendingChunks = chunks.slice(index)
      const pending = pendingChunks.join('')
      // Ephemeral sends (progress notes, "still working" lines) must never
      // become durable dead letters: a "running: pwsh (13m)" note retried an
      // hour later is noise at best, and it rides an inbound context token that
      // iLink has long since stopped accepting (issue #21). `durable: false`
      // turns a failed ephemeral send into one logged drop instead of a row in
      // outbox.json that can never be delivered.
      if (message.durable === false) {
        runtime.hooks?.emit(HOOK_POINTS.outboundSettled, {
          accountId: transport.accountId,
          conversationId: message.conversationId,
          sent: false,
          dropped: pending.length,
        })
        runtime.warn(`ephemeral send failed (${String(error?.message ?? error)}); dropped ${pending.length} chars`)
        return
      }
      if (runtime.outbox !== undefined) {
        runtime.outbox.enqueue({
          accountId: transport.accountId,
          conversationId: message.conversationId,
          text: pending,
          segments: pendingChunks,
          contextToken: message.contextToken,
          maxMessageLength: config.maxMessageLength,
        })
        runtime.hooks?.emit(HOOK_POINTS.outboundSettled, { accountId: transport.accountId, conversationId: message.conversationId, sent: false, queued: pending.length })
        runtime.warn(`send failed (${String(error?.message ?? error)}); queued ${pending.length} chars for retry`)
        return
      }
      throw error
    }
  }
  if (plan.files.length > 0) await sendSnippets(transport, message, plan.files)
}

/**
 * Attach the snippet files a rich reply planned.
 *
 * A file that cannot be written or sent costs one log line: the note in the
 * text already told the reader a file was sent, but losing the whole reply over
 * a pretty-printed code block would be worse.
 */
async function sendSnippets(transport, message, files) {
  const dir = runtime.snippetsDir
  if (dir === '') {
    runtime.warn('rich reply produced snippet files but no snippet directory is configured; sending them inline is not possible at this point')
    return
  }
  const { written } = writeSnippets(files, dir, { warn: runtime.warn })
  const channel = channelFor(transport)
  if (channel === undefined || channel.capabilities?.media !== true) return
  for (const file of written) {
    try {
      await channel.sendMedia({
        conversationId: message.conversationId,
        filePath: file.path,
        text: '',
        contextToken: message.contextToken,
      })
    } catch (error) {
      runtime.warn(`snippet ${file.name} could not be sent: ${String(error?.message ?? error)}`)
    }
  }
}

