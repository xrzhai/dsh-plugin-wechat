// Outbound delivery: the part of the plugin that gets text and files out of the
// process and onto Weixin.
//
// These functions used to sit at the bottom of src/index.js, next to 2000 lines
// of wiring they have nothing to do with. The dependencies they used to reach
// for through module-scope `let`s (outbox and logger) are
// injected once at setup through configureOutbound.
import { channelFor } from './channel.js'
import { chunkText } from './message/chunker.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'
import { planRichContent, writeSnippets } from './message/rich-content.js'
import { createTranslator } from './i18n.js'

/** Wired in setup; every field defaults so a test can exercise one sender. */
const runtime = {
  outbox: undefined,
  // Where long code blocks are written before they are sent as attachments.
  snippetsDir: '',
  warn: () => {},
}

/** Hand the send path its outbox, snippet directory and logger. */
export function configureOutbound(deps = {}) {
  if ('outbox' in deps) runtime.outbox = deps.outbox
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
  // Check the whole raw body before splitting or retry enqueue;
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
  const chunks = chunkText(text, config.maxMessageLength)
  const sent = await sendTextChunks(transport, config, message, chunks, plan.files)
  if (sent && plan.files.length > 0) {
    const failed = await sendSnippets(transport, message, plan.files)
    if (failed.length > 0) {
      const fallback = snippetFallback(config, failed)
      await sendTextChunks(transport, config, message, chunkText(fallback, config.maxMessageLength))
    }
  }
}

/** Inline original code without applying Markdown or table conversion. */
function snippetFallback(config, files) {
  const t = createTranslator(config.locale).t
  return files.map((file) => `\n\n${t('notice.snippetFallback', { name: file.name })}\n${file.body}`).join('')
}

/** Send exact chunks and persist only the unsent suffix, including code fallback. */
async function sendTextChunks(transport, config, message, chunks, pendingFiles = []) {
  for (let index = 0; index < chunks.length; index += 1) {
    // Everything downstream of here talks to a Channel, not a transport: the
    // shape of a text send lives in one place (src/channel.js) instead of being
    // re-derived by every caller.
    const channel = channelFor(transport)
    const chunk = { conversationId: message.conversationId, text: chunks[index], contextToken: message.contextToken }
    try {
      await channel.sendText(chunk)
    } catch (error) {
      // A send that fails here used to lose the text forever: the model had
      // already written it and nothing held a copy. Queue the exact unsent
      // chunks, not their concatenation: the outbox retries them one by one and
      // records progress after each success, so neither a retry nor a restart
      // can resend the successful prefix or create one oversized message.
      const pendingChunks = chunks.slice(index)
      if (pendingFiles.length > 0) {
        pendingChunks.push(...chunkText(snippetFallback(config, pendingFiles), config.maxMessageLength))
      }
      const pending = pendingChunks.join('')
      // Ephemeral sends (progress notes, "still working" lines) must never
      // become durable dead letters: a "running: pwsh (13m)" note retried an
      // hour later is noise at best, and it rides an inbound context token that
      // iLink has long since stopped accepting (issue #21). `durable: false`
      // turns a failed ephemeral send into one logged drop instead of a row in
      // outbox.json that can never be delivered.
      if (message.durable === false) {
        runtime.warn(`ephemeral send failed (${String(error?.message ?? error)}); dropped ${pending.length} chars`)
        return false
      }
      if (runtime.outbox !== undefined) {
        runtime.outbox.enqueue({
          accountId: transport.accountId,
          conversationId: message.conversationId,
          text: pending,
          segments: pendingChunks,
          deliveryUncertain: error?.deliveryUncertain === true,
          contextToken: message.contextToken,
          maxMessageLength: config.maxMessageLength,
        })

        const action = error?.deliveryUncertain === true ? 'parked for manual review' : 'queued for retry'
        runtime.warn(`send failed (${String(error?.message ?? error)}); ${action} (${pending.length} chars)`)
        return false
      }
      throw error
    }
  }
  return true
}

/**
 * Attach the snippet files a rich reply planned.
 *
 * Return failed files so their unmodified bodies can be sent as text instead.
 */
async function sendSnippets(transport, message, files) {
  const channel = channelFor(transport)
  if (channel === undefined || channel.capabilities?.media !== true) return files
  const dir = runtime.snippetsDir
  if (dir === '') {
    runtime.warn('rich reply produced snippet files but no snippet directory is configured')
    return files
  }
  const { written } = writeSnippets(files, dir, { warn: runtime.warn })
  const byName = new Map(written.map((file) => [file.name, file]))
  const failed = []
  for (const file of files) {
    const output = byName.get(file.name)
    if (output === undefined) {
      failed.push(file)
      continue
    }
    try {
      await channel.sendMedia({
        conversationId: message.conversationId,
        filePath: output.path,
        text: '',
        contextToken: message.contextToken,
      })
    } catch (error) {
      runtime.warn(`snippet ${file.name} could not be sent: ${String(error?.message ?? error)}`)
      failed.push(file)
    }
  }
  return failed
}

