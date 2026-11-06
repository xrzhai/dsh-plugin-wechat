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
 * who owns them.
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
    return { ok: true, ...saved, kind, mime: mimeForName(saved.name, kind) }
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

/** Format the media type and local path for the agent. */
export function describeInboundMedia(saved) {
  return saved.map((item) => `[用户发送的${kindLabel(item.kind)}已保存到本地：${item.path}]`).join('\n\n')
}
