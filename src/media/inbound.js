/**
 * Inbound media: take a Weixin image / file / voice / video off the CDN, decrypt
 * it, and put it on disk where the agent can read it.
 *
 * The mirror of `src/media/outbound.js`: this module owns everything dsh-weixin
 * is allowed to decide (which descriptor to fetch, what to call the file, how
 * big is too big, where it lands) and delegates every protocol/crypto step to
 * `vendor/openclaw-weixin/cdn/pic-decrypt.js`.
 *
 * Three deliberate properties:
 *  - **The peer never picks a path.** A `FileItem`'s `file_name` is attacker
 *    controlled — it is whatever the sender typed into the file name — so it is
 *    reduced to a basename, stripped of separators and dot segments, and then
 *    prefixed with a random token. `../../../.ssh/authorized_keys` becomes
 *    `a1b2c3d4-authorized_keys` inside the inbox directory and cannot escape it
 *    (see {@link safeFileName}).
 *  - **Size is bounded while the bytes arrive.** An oversized
 *    `Content-Length` may reject and cancel before reading, but the streamed
 *    byte count is authoritative, so an absent or false-small header cannot
 *    make the process retain an arbitrarily large reply.
 *  - **Failure is returned, never thrown.** The caller must be able to tell the
 *    user *why* an attachment did not arrive, which the old blanket "not
 *    supported" notice could not.
 * @module dsh-weixin/media/inbound
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { ensureInboxDir } from '../state.js'
import { transcribeVoice } from './asr.js'

/**
 * Largest inbound attachment this channel will accept.
 *
 * Smaller than the outbound default (100MB) on purpose: an inbound file is
 * fetched at the request of a remote party, so it is the request path an
 * unauthorized sender would use to exhaust the host's memory.
 */
export const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024

/**
 * Hard deadline for one inbound CDN request, including its response body.
 *
 * The cap bounds memory; this bounds a peer that keeps the connection open but
 * sends little or no data. Two minutes leaves room for a 20MB attachment on a
 * slow mobile connection while still ensuring that a stalled request cannot
 * hold an inbound turn forever.
 */
export const DEFAULT_INBOUND_DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * Default Weixin CDN root, matching `CDN_BASE_URL` in upstream `accounts.ts`.
 * Configurable because a saved account may point at a different CDN.
 */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** Longest extension we will carry over from a peer-supplied file name. */
const MAX_EXTENSION_LENGTH = 12

/** Characters that are never safe in a file name on any supported platform. */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g

/** Enough of an error response to explain it, without buffering its whole body. */
const ERROR_DETAIL_MAX_BYTES = 200

/** Lazily allocated body blocks; small network chunks are copied into these. */
const BODY_BLOCK_BYTES = 64 * 1024

/** Private sibling directory used until a complete attachment is committed. */
const INBOUND_TEMP_PREFIX = '.inbound-tmp-'

/**
 * A refusal, not a transport error: the caller reports the reason in the reply
 * and never retries.
 */
export class InboundMediaError extends Error {
  /**
   * @param {string} message  Human-readable reason, safe to send to the user.
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'InboundMediaError'
    this.code = code
  }
}

/**
 * Turn an arbitrary peer-supplied file name into a safe basename.
 *
 * The result never contains a path separator, never starts with `.`, is never
 * `..`, and never carries more than one extension — so the only remaining
 * freedom is *which characters* the leaf name uses, all of which are confined
 * to a single directory. `path.basename` alone is not enough: on POSIX it
 * leaves `..` intact and does not touch backslashes, which are separators on
 * the Windows hosts this plugin also runs on.
 *
 * @param {string} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeBaseName(raw, fallback = 'file') {
  if (typeof raw !== 'string') return fallback
  // Trailing separators would make basename return '' (`"a/b/"` → `""`).
  const trimmed = raw.replace(/[\\/]+$/, '')
  const base = trimmed.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(UNSAFE_NAME_CHARS, '_').replace(/^\.+/, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback
  // Cap the length: a file name is metadata from a stranger, and a 4KB name
  // would exceed every filesystem's limit and fail the write after the download
  // has already been paid for.
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}` : cleaned
}

/**
 * The extension to keep for a peer-supplied name, lowercased, or `''`.
 *
 * Restricted to a short alphanumeric run so a name like `report.pdf.exe` keeps
 * `.exe` (honest — the agent should see what the file claims to be) while
 * `weird.${IFS}` drops the junk entirely.
 *
 * @param {string} name
 */
export function safeExtension(name) {
  const ext = path.extname(typeof name === 'string' ? name : '')
  if (ext === '' || ext.length > MAX_EXTENSION_LENGTH) return ''
  return /^\.[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : ''
}

/**
 * Build the on-disk file name for one inbound attachment.
 *
 * The random prefix is what makes this safe rather than merely tidy: two
 * senders naming a file `report.pdf` in the same second cannot overwrite each
 * other, and a name an attacker chose cannot be used to pre-place a file the
 * plugin will later overwrite (a symlink planted at a predictable path is the
 * classic version of that attack — the prefix makes the path unpredictable and
 * the write is `wx`-exclusive besides).
 *
 * @param {string} peerName  The name the sender provided (untrusted).
 * @param {() => string} [token]  Test seam for the random prefix.
 * @returns {string} a bare file name, never a path
 */
export function inboundFileName(peerName, token = randomToken) {
  const stem = safeBaseName(peerName, 'file')
  const ext = safeExtension(stem) || safeExtension(peerName)
  const body = ext !== '' && stem.toLowerCase().endsWith(ext) ? stem.slice(0, -ext.length) : stem
  const safeBody = body === '' ? 'file' : body
  return `${token()}-${safeBody}${ext}`
}

/** Hex token, unique enough that two attachments never collide. */
function randomToken() {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0')
}

/**
 * Create the destination with exclusive, atomic no-clobber semantics.
 *
 * A temporary sibling directory gives this call provable ownership of every
 * file it cleans up. Once the bytes and metadata are flushed, a hard link
 * publishes the complete inode at the requested name. `link` is atomic and
 * fails with EEXIST, unlike `rename`, which would replace a file another
 * writer already committed. The final name therefore never refers to a partial
 * write and an existing destination is never removed or overwritten.
 *
 * A killed process cannot run cleanup. If that happens before the link, only
 * its private `.inbound-tmp-*` directory remains; if it happens after the link,
 * the final file is already complete and the private link is merely redundant.
 * Later calls never sweep old temporary directories because they cannot prove
 * who owns them. `listInboundMedia` ignores non-files, so an abandoned temp
 * directory is also absent from `/media`.
 *
 * Hard links are unavailable on some filesystems (for example, some FAT/exFAT
 * or network-backed volumes). In that case `link` rejects, no destination is
 * published, and the caller receives `write-failed`. Node does not expose a
 * portable atomic "rename only if absent" operation: plain rename can replace
 * the destination, an access-then-rename check has a TOCTOU race, and
 * `COPYFILE_EXCL` is explicitly not atomic. A fallback would therefore weaken
 * either no-clobber or no-partial-file guarantees, so this path fails closed.
 *
 * @param {string} target
 * @param {Buffer} buffer
 */
async function writeInboundExclusive(target, buffer) {
  const tempDir = await fs.mkdtemp(path.join(path.dirname(target), INBOUND_TEMP_PREFIX))
  const tempFile = path.join(tempDir, 'payload')
  let ownsTempFile = false
  try {
    const handle = await fs.open(tempFile, 'wx')
    ownsTempFile = true
    try {
      await handle.writeFile(buffer)
      // Flush before publishing: a delayed ENOSPC/EIO is still a failed write,
      // so it must happen while the destination name does not exist.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.link(tempFile, target)
  } finally {
    // Remove only the file this call opened. `rmdir` then succeeds only if no
    // unknown file appeared; never recurse through a directory whose contents
    // this call can no longer prove it owns.
    if (ownsTempFile) await fs.unlink(tempFile).catch(() => {})
    await fs.rmdir(tempDir).catch(() => {})
  }
}

/**
 * Save one decrypted buffer into the inbox directory under a safe name.
 *
 * The final name appears only after a complete temporary file has been flushed
 * and atomically linked into place. If the generated name already exists, the
 * link fails instead of clobbering a file that another message just saved.
 *
 * @param {Buffer} buffer
 * @param {string} peerName  Untrusted name from the message, used for the stem.
 * @param {{ dir?: string, token?: () => string }} [options]
 * @returns {Promise<{ path: string, name: string, bytes: number }>}
 * @throws {InboundMediaError} when the directory or the file cannot be written.
 */
export async function saveInboundBuffer(buffer, peerName, options = {}) {
  let dir
  try {
    dir = options.dir ?? ensureInboxDir()
  } catch (error) {
    throw new InboundMediaError(`could not create the inbox directory: ${String(error?.message ?? error)}`, 'mkdir-failed')
  }
  const name = inboundFileName(peerName, options.token)
  const target = path.join(dir, name)
  try {
    await writeInboundExclusive(target, buffer)
  } catch (error) {
    throw new InboundMediaError(`could not save the attachment: ${String(error?.message ?? error)}`, 'write-failed')
  }
  return { path: target, name, bytes: buffer.length }
}

// ---------------------------------------------------------------------------
// Descriptor → download
// ---------------------------------------------------------------------------

/**
 * One media descriptor, as produced by `normalizeInbound` in the transport.
 * @typedef {Object} InboundMediaDescriptor
 * @property {'image'|'file'|'voice'|'video'|'media'} kind
 * @property {string} [encryptQueryParam]
 * @property {string} [aesKey]       base64, either 16 raw bytes or 32 hex chars
 * @property {string} [fullUrl]      preferred over the built CDN URL when present
 * @property {string} [fileName]     untrusted display name (FileItem)
 * @property {string} [aesKeyHex]    ImageItem's hex-encoded key
 * @property {string|number} [size]
 */

/**
 * The `aes_key` value to hand the vendored decryptor for one descriptor.
 *
 * `ImageItem` carries the key hex-encoded in `image_item.aeskey` instead of
 * base64 in `media.aes_key`, so the hex form is converted to base64 — exactly
 * what `downloadMediaFromItem` does upstream. Doing it here keeps this module's
 * contract in the one encoding `parseAesKey` documents.
 *
 * @param {InboundMediaDescriptor} descriptor
 * @returns {string|undefined}
 */
export function resolveAesKey(descriptor) {
  if (typeof descriptor?.aesKeyHex === 'string' && descriptor.aesKeyHex !== '') {
    const raw = Buffer.from(descriptor.aesKeyHex, 'hex')
    if (raw.length === 16) return raw.toString('base64')
  }
  return typeof descriptor?.aesKey === 'string' && descriptor.aesKey !== '' ? descriptor.aesKey : undefined
}

/**
 * Human-readable kind name for the user-facing notes.
 * @param {string} kind
 */
export function kindLabel(kind) {
  switch (kind) {
    case 'image':
      return '图片'
    case 'voice':
      return '语音'
    case 'video':
      return '视频'
    case 'file':
      return '文件'
    default:
      return '媒体'
  }
}

/**
 * Read the download URL out of a descriptor, or explain why there is none.
 * @param {InboundMediaDescriptor} descriptor
 * @param {string} cdnBaseUrl
 */
function downloadUrlFor(descriptor, cdnBaseUrl) {
  if (typeof descriptor.fullUrl === 'string' && descriptor.fullUrl !== '') return descriptor.fullUrl
  if (typeof descriptor.encryptQueryParam === 'string' && descriptor.encryptQueryParam !== '') {
    const base = String(cdnBaseUrl ?? '').replace(/\/+$/, '')
    return `${base}/download?encrypted_query_param=${encodeURIComponent(descriptor.encryptQueryParam)}`
  }
  return undefined
}

/**
 * Fetch one descriptor's ciphertext from the CDN and return the raw bytes.
 *
 * Split out from {@link downloadInboundMedia} so the size cap is enforceable —
 * and testable — without decryption. `Content-Length` is used only as a safe,
 * one-way fast rejection: a declared value over the cap cancels immediately,
 * while every accepted response is still counted as it streams in. An absent,
 * invalid or false-small header therefore cannot bypass the cap.
 *
 * @param {InboundMediaDescriptor} descriptor
 * @param {{ cdnBaseUrl?: string, maxBytes: number, fetchImpl?: typeof fetch, timeoutMs?: number, label?: string }} options
 * @returns {Promise<Buffer>}
 * @throws {InboundMediaError}
 */
export async function fetchInboundBytes(descriptor, options) {
  const maxBytes = normalizeMaxBytes(options.maxBytes)
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const url = downloadUrlFor(descriptor, options.cdnBaseUrl)
  if (url === undefined) {
    throw new InboundMediaError('the message carries no CDN reference', 'no-cdn-reference')
  }
  const doFetch = options.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await doFetch(url, { signal })
  } catch (error) {
    if (timedOut(signal)) throw timeoutError(timeoutMs)
    throw new InboundMediaError(`CDN request failed: ${String(error?.cause ?? error?.message ?? error)}`, 'fetch-failed')
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await readBoundedErrorBody(response, { signal, timeoutMs }))
        .toString('utf8')
        .slice(0, ERROR_DETAIL_MAX_BYTES)
    } catch {
      // A body we cannot read is not worth failing over; the status says enough.
      if (timedOut(signal)) throw timeoutError(timeoutMs)
    }
    throw new InboundMediaError(
      `CDN returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${detail === '' ? '' : ` (${detail})`}`,
      'cdn-status',
    )
  }
  const declaredBytes = declaredContentLength(response)
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    const error = new InboundMediaError(
      `the attachment is ${formatBytes(declaredBytes)}, larger than the ${formatBytes(maxBytes)} limit`,
      'too-large',
    )
    cancelResponseBody(response, error)
    throw error
  }
  try {
    return await readBoundedBody(response, maxBytes, { signal, timeoutMs })
  } catch (error) {
    if (error instanceof InboundMediaError) throw error
    if (timedOut(signal)) throw timeoutError(timeoutMs)
    throw new InboundMediaError(
      `CDN response failed: ${String(error?.cause ?? error?.message ?? error)}`,
      'body-failed',
    )
  }
}

/** Parse a non-negative Content-Length without treating malformed input as zero. */
function declaredContentLength(response) {
  const raw = response?.headers?.get?.('content-length')
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Start cancellation without waiting for a body or cancel promise to settle. */
function cancelResponseBody(response, reason) {
  const body = response?.body
  if (body === undefined || body === null || typeof body.cancel !== 'function') return
  try {
    void Promise.resolve(body.cancel(reason)).catch(() => {})
  } catch {
    // A broken body must not turn a definitive size refusal into a hang.
  }
}

/**
 * Read a short explanation from an error response only when it is streamable.
 *
 * A response without a body stream is reported by status alone. Calling
 * `text()` or `arrayBuffer()` there would reintroduce the whole-body allocation
 * this path is meant to avoid.
 */
async function readBoundedErrorBody(response, { signal, timeoutMs }) {
  const body = response?.body
  if (body === undefined || body === null || typeof body.getReader !== 'function') return Buffer.alloc(0)
  return readBoundedBody(response, ERROR_DETAIL_MAX_BYTES, { signal, timeoutMs })
}

/**
 * Read a response without ever retaining more than `maxBytes` of body.
 *
 * Real fetch responses expose a web `ReadableStream`, which lets us count each
 * chunk and cancel as soon as the limit is crossed. A non-streamable successful
 * response fails closed instead of calling `arrayBuffer()` on untrusted input;
 * a standard empty response (`body === null`) is the only bodyless success.
 * Stream chunks are coalesced into fixed-size blocks, so retained allocations
 * scale with accepted bytes rather than with the number of network chunks.
 */
async function readBoundedBody(response, maxBytes, { signal, timeoutMs }) {
  const body = response?.body
  if (body === null) return Buffer.alloc(0)
  if (body === undefined || typeof body.getReader !== 'function') {
    throw new InboundMediaError(
      'CDN response body is not streamable; refusing to buffer it without a size bound',
      'body-not-streamable',
    )
  }

  const reader = body.getReader()
  const blocks = []
  let block
  let blockOffset = 0
  let total = 0

  try {
    while (true) {
      const { done, value } = await readNextChunk(reader, signal, timeoutMs)
      if (done) break
      const chunk = chunkBytes(value)
      const nextTotal = total + chunk.byteLength
      if (nextTotal > maxBytes) {
        throw new InboundMediaError(
          `the attachment is at least ${formatBytes(nextTotal)}, larger than the ${formatBytes(maxBytes)} limit`,
          'too-large',
        )
      }

      let chunkOffset = 0
      while (chunkOffset < chunk.byteLength) {
        if (block === undefined || blockOffset === block.byteLength) {
          // Allocate lazily and never from the configured cap directly: a huge
          // user limit must not reserve a huge buffer before data arrives.
          const blockBytes = Math.min(BODY_BLOCK_BYTES, maxBytes - (total + chunkOffset))
          block = Buffer.allocUnsafe(blockBytes)
          blocks.push(block)
          blockOffset = 0
        }
        const copied = Math.min(block.byteLength - blockOffset, chunk.byteLength - chunkOffset)
        block.set(chunk.subarray(chunkOffset, chunkOffset + copied), blockOffset)
        blockOffset += copied
        chunkOffset += copied
      }
      total = nextTotal
    }
  } catch (error) {
    // Start cancellation without waiting for its promise: a broken source can
    // return a cancel promise that never settles, and the security decision is
    // already final. Attaching a rejection handler keeps that best-effort work
    // from surfacing as an unhandled rejection.
    try {
      void Promise.resolve(reader.cancel(error)).catch(() => {})
    } catch {
      // A mocked reader may throw synchronously from cancel().
    }
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A mocked reader may not implement releaseLock.
    }
  }

  if (blocks.length === 0) return Buffer.alloc(0)
  if (blocks.length === 1) return blocks[0].subarray(0, total)
  return Buffer.concat(blocks, total)
}

/**
 * Race one stream read against the shared deadline without accumulating
 * reactions on a permanently pending abort promise. The listener belongs to
 * this read only and is removed as soon as either side settles.
 */
function readNextChunk(reader, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(timeoutError(timeoutMs))
  if (signal === undefined) return reader.read()

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(timeoutError(timeoutMs)))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    try {
      reader.read().then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      )
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

/** Coerce a web-stream value to a byte view without retaining a per-chunk Buffer. */
function chunkBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('the response stream produced a non-binary chunk')
}

function normalizeMaxBytes(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MAX_INBOUND_MEDIA_BYTES
}

function normalizeTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_INBOUND_DOWNLOAD_TIMEOUT_MS
}

function timedOut(signal) {
  return signal?.aborted === true && signal.reason?.name === 'TimeoutError'
}

function timeoutError(timeoutMs) {
  return new InboundMediaError(`CDN download timed out after ${timeoutMs}ms`, 'timeout')
}

/** `12.3MB` / `900KB` — for user-facing size notes. */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/**
 * Download, decrypt and save one inbound attachment.
 *
 * @param {object} params
 * @param {InboundMediaDescriptor} params.media
 * @param {string} params.cdnBaseUrl
 * @param {number} params.maxBytes
 * @param {string} [params.dir]         Inbox directory override (tests).
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @param {() => string} [params.token]
 * @returns {Promise<{ ok: true, path: string, name: string, bytes: number, kind: string, mime: string }
 *   | { ok: false, reason: string, code: string }>}
 */
export async function downloadInboundMedia(params) {
  const { media, cdnBaseUrl, maxBytes } = params
  const kind = media?.kind ?? 'media'
  if (media === undefined || media === null) {
    return { ok: false, reason: 'the message carries no media', code: 'no-media' }
  }
  try {
    const ciphertext = await fetchInboundBytes(media, {
      cdnBaseUrl,
      maxBytes,
      ...(params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl }),
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    })
    const aesKey = resolveAesKey(media)
    let plaintext = ciphertext
    if (aesKey !== undefined) {
      const { decryptAesEcb } = await import('../../vendor/openclaw-weixin/cdn/aes-ecb.js')
      const key = parseAesKey(aesKey)
      try {
        plaintext = decryptAesEcb(ciphertext, key)
      } catch (error) {
        return {
          ok: false,
          reason: `decryption failed (${String(error?.message ?? error)})`,
          code: 'decrypt-failed',
        }
      }
    }
    const peerName = typeof media.fileName === 'string' && media.fileName !== '' ? media.fileName : defaultNameFor(kind)
    const saved = await saveInboundBuffer(plaintext, peerName, {
      ...(params.dir === undefined ? {} : { dir: params.dir }),
      ...(params.token === undefined ? {} : { token: params.token }),
    })
    const result = { ok: true, ...saved, kind, mime: mimeForName(saved.name, kind) }
    // A video is the one attachment the model cannot open by itself (C22). It
    // CAN read images, and ffmpeg already ships in the voice path, so a few
    // stills turn "an mp4 you cannot read" into "three frames you can look at".
    // Best effort: no ffmpeg, an unreadable codec or a zero-length clip leaves
    // the file exactly as it was delivered before.
    if (kind === 'video' && params.extractFrames !== false) {
      try {
        const { extractVideoFrames } = await import('./video-frames.js')
        const stills = extractVideoFrames(saved.path, {
          ...(params.ffmpegPath === undefined ? {} : { ffmpegPath: params.ffmpegPath }),
          ...(params.warn === undefined ? {} : { warn: params.warn }),
        })
        if (stills.frames.length > 0) {
          result.frames = stills.frames
          if (typeof stills.durationSeconds === 'number') result.durationSeconds = stills.durationSeconds
        } else if (typeof stills.error === 'string') {
          result.framesError = stills.error
        }
      } catch (error) {
        result.framesError = String(error?.message ?? error)
      }
    }
    return result
  } catch (error) {
    if (error instanceof InboundMediaError) return { ok: false, reason: error.message, code: error.code }
    return { ok: false, reason: String(error?.message ?? error), code: 'unexpected' }
  }
}

/**
 * Parse `CDNMedia.aes_key` into a raw 16-byte AES key.
 *
 * Deliberately a local copy of the vendored `parseAesKey` rather than an import:
 * the vendored one is module-private, and re-exporting it would mean patching a
 * file that is otherwise byte-identical to upstream (THIRD-PARTY-NOTICES.md
 * tracks every such change). The two encodings are protocol facts, not policy:
 * base64 of 16 raw bytes (images), and base64 of the 32-character hex string
 * (file / voice / video).
 *
 * @param {string} aesKeyBase64
 * @returns {Buffer}
 * @throws {InboundMediaError} on any other shape
 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64), 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new InboundMediaError(
    `aes_key must decode to 16 raw bytes or 32 hex characters, got ${decoded.length} bytes`,
    'bad-aes-key',
  )
}

/**
 * Download, decrypt and save one inbound voice message, transcode the SILK
 * payload to WAV, and — when an ASR bridge is configured — transcribe it.
 *
 * WeChat voice is SILK, which neither DSH nor any common player can read, so the
 * transcode is attempted first and its absence is not an error. `silk-wasm` is
 * an optional dependency (`optionalDependencies`): the vendored
 * `silk-transcode.js` resolves it with a dynamic `import()` and returns null when
 * it is missing, exactly as upstream ships it, and this module then falls back to
 * the file it already saved.
 *
 * Transcription is a further, independent step: it needs both a WAV and a bridge
 * process, and either can be absent. Every outcome is reported through
 * `transcript` / `transcriptError` rather than being thrown, because a voice note
 * the host cannot understand is still a voice note the user sent.
 *
 * @param {Parameters<typeof downloadInboundMedia>[0] & {
 *   bridge?: import('./asr.js').AsrBridge,
 *   transcribe?: typeof transcribeVoice,
 *   silkToWav?: (silk: Buffer) => Promise<Uint8Array>,
 * }} params
 * @returns {Promise<Awaited<ReturnType<typeof downloadInboundMedia>> & {
 *   transcoded?: boolean, transcodeError?: string, transcodeCode?: string,
 *   transcript?: string, transcriptError?: string, transcriptCode?: string }>}
 */
export async function downloadInboundVoice(params) {
  const result = await downloadInboundMedia(params)
  if (!result.ok) return result
  const withWav = await transcodeVoiceToWav(result, params)
  if (withWav.transcoded !== true) return withWav
  const run = params.transcribe ?? transcribeVoice
  const outcome = await run({
    bridge: params.bridge,
    wavPath: withWav.path,
  })
  if (outcome.ok === true) {
    return { ...withWav, transcript: outcome.text }
  }
  return { ...withWav, transcriptError: outcome.reason, transcriptCode: outcome.code }
}

/**
 * The SILK → WAV half of {@link downloadInboundVoice}, split out so the transcode
 * and the transcription can be reasoned about (and tested) separately.
 *
 * @param {Exclude<Awaited<ReturnType<typeof downloadInboundMedia>>, { ok: false }>} result
 * @param {Parameters<typeof downloadInboundVoice>[0]} params
 */
async function transcodeVoiceToWav(result, params) {
  let silkToWav = params.silkToWav
  if (silkToWav === undefined) {
    try {
      ;({ silkToWav } = await import('../../vendor/openclaw-weixin/media/silk-transcode.js'))
    } catch (error) {
      return voiceTranscodeFailure(
        result,
        `could not load the SILK transcoder: ${String(error?.message ?? error)}`,
        'transcode-unavailable',
      )
    }
  }
  if (typeof silkToWav !== 'function') {
    return voiceTranscodeFailure(result, 'the SILK transcoder is unavailable', 'transcode-unavailable')
  }
  try {
    const silk = await fs.readFile(result.path)
    const wav = await silkToWav(silk)
    if (!(wav instanceof Uint8Array)) {
      return voiceTranscodeFailure(
        result,
        'the SILK transcoder did not return a byte array',
        'transcode-failed',
      )
    }
    // Keep the SILK original and save the playable WAV beside it: the original
    // is the only lossless copy, and a failed transcode must not destroy it.
    const wavSaved = await saveInboundBuffer(Buffer.from(wav), `${result.name}.wav`, {
      ...(params.dir === undefined ? {} : { dir: params.dir }),
      ...(params.token === undefined ? {} : { token: params.token }),
    })
    return {
      ...result,
      path: wavSaved.path,
      name: wavSaved.name,
      bytes: wavSaved.bytes,
      mime: 'audio/wav',
      silkPath: result.path,
      transcoded: true,
    }
  } catch (error) {
    // Any transcode failure degrades to the SILK file we already saved.
    return voiceTranscodeFailure(
      result,
      String(error?.message ?? error),
      error instanceof InboundMediaError ? error.code : 'transcode-failed',
    )
  }
}

/** Degrade to the saved SILK original while retaining why WAV was unavailable. */
function voiceTranscodeFailure(result, reason, code) {
  return { ...result, transcoded: false, transcodeError: reason, transcodeCode: code }
}

/** Fallback stem when the message named nothing ("file.bin" upstream). */
function defaultNameFor(kind) {
  switch (kind) {
    case 'image':
      return 'image.jpg'
    case 'voice':
      return 'voice.silk'
    case 'video':
      return 'video.mp4'
    default:
      return 'file.bin'
  }
}

/** MIME for a saved attachment, from its extension and, failing that, its kind. */
function mimeForName(name, kind) {
  const byKind = {
    image: 'image/jpeg',
    voice: 'audio/silk',
    video: 'video/mp4',
    file: 'application/octet-stream',
  }
  const ext = path.extname(name).toLowerCase()
  const byExt = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.silk': 'audio/silk',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
  }
  return byExt[ext] ?? byKind[kind] ?? 'application/octet-stream'
}

/**
 * Build the text handed to the agent for a message that (partly) failed.
 *
 * Kept next to the downloader so the reason a media item did not arrive is
 * always phrased the same way, and never as the old blanket "not supported"
 * notice: the user asked to send a file and deserves to know the CDN refused it.
 *
 * @param {Array<{ kind: string, reason: string, code: string }>} failures
 * @returns {string}
 */
export function describeMediaFailures(failures) {
  const lines = failures.map((f) => `${kindLabel(f.kind)}下载失败：${f.reason}`)
  return lines.join('\n')
}

/**
 * Build the text handed to the agent for a successfully saved attachment.
 *
 * The agent gets an absolute path and an explicit instruction, because a bare
 * path in a prompt is easy to read as a question about the path rather than as
 * a file to open. The tool suggestion is per-kind so a voice note does not get
 * proposed to `read_image`.
 *
 * A transcribed voice note is a special case worth the extra care: the user's
 * actual words are prompt content, while everything this plugin says about the
 * file is commentary. They are therefore fenced and labelled differently —
 * `【语音转写】` for the words, `[语音已保存到本地…]` for the bookkeeping — so the
 * agent cannot mistake a transcript for the channel's own description, or quote
 * the description back to the user as what they said. An empty transcript is
 * stated as empty: a silent or unintelligible recording must not be answered as
 * if it had said something.
 *
 * @param {Array<{ ok: true, kind: string, path: string, name: string, bytes: number, transcoded?: boolean, transcript?: string, transcriptError?: string }>} saved
 * @param {string} [caption]
 * @returns {string}
 */
export function describeInboundMedia(saved, caption) {
  const blocks = saved.map((item) => {
    const size = formatBytes(item.bytes)
    const head = `[用户发送的${kindLabel(item.kind)}已保存到本地：${item.path}（${item.name}, ${size}）]`
    if (item.kind === 'image') {
      return `${head}\n请用 read_image 工具查看这个文件的内容。`
    }
    if (item.kind === 'voice') {
      if (typeof item.transcript === 'string') {
        if (item.transcript === '') {
          return `${head}\n【语音转写】本机语音识别未能识别出任何内容（可能是静音、音乐或环境噪音），请据此说明你没有听清，不要臆测内容。`
        }
        return `${head}\n【语音转写】以下为语音识别结果，均按用户原话处理：\n${item.transcript}`
      }
      const reason = typeof item.transcriptError === 'string' ? `（转写失败：${item.transcriptError}）` : ''
      if (item.transcoded === true) {
        return `${head}\n这是一段已转码为 WAV 的语音${reason}，请用 read 工具处理（如无法直接读取音频，请说明）。`
      }
      // `transcodeError` contains diagnostic text and is logged by the caller.
      // It may include arbitrary decoder/filesystem text, so the prompt gets
      // only this fixed description and never the original error.
      return `${head}\n这是微信 SILK 格式的语音，本机未能解码为可播放音频${reason}；如需内容请告知用户。`
    }
    if (item.kind === 'video') {
      const length = typeof item.durationSeconds === 'number' ? `，时长 ${item.durationSeconds.toFixed(1)} 秒` : ''
      if (Array.isArray(item.frames) && item.frames.length > 0) {
        const lines = item.frames.map((frame) => `- ${frame.atSeconds}s：${frame.path}`).join('\n')
        const extra = typeof item.framesError === 'string' ? `（部分帧未能抽取：${item.framesError}）` : ''
        return `${head}\n这是一个视频文件${length}。已从中抽取 ${item.frames.length} 帧静图${extra}：\n${lines}\n请用 read_image 工具查看这些帧来了解视频内容；视频本身无法直接读取，需要更精确的画面时请告知用户。`
      }
      const why = typeof item.framesError === 'string' ? `（抽帧失败：${item.framesError}）` : ''
      return `${head}\n这是一个视频文件${length}${why}，视频帧未能提取，无法直接读取内容；如需了解视频内容，请让用户描述或发送截图。`
    }
    return `${head}\n请用 read 工具读取这个文件的内容。`
  })
  if (typeof caption === 'string' && caption !== '') blocks.push(caption)
  return blocks.join('\n\n')
}
