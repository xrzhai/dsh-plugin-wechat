# Third-party notices

## QR matrix encoder (vendored)

The desktop login QR uses the `vendor/QRCode` encoder from
[`qrcode-terminal@0.12.0`](https://github.com/gtanner/qrcode-terminal/tree/v0.12.0/vendor/QRCode),
included under `vendor/qrcode-terminal/`. The package's Apache-2.0 license and
the original encoder's MIT license and copyright notice are preserved there;
see [ORIGIN.md](vendor/qrcode-terminal/ORIGIN.md).

## @tencent-weixin/openclaw-weixin (vendored)

This project vendors a trimmed copy of the WeChat iLink transport from
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin), npm package
`@tencent-weixin/openclaw-weixin@2.4.10`, under `vendor/openclaw-weixin/`.

**License: MIT.** Upstream license text is kept verbatim at
[vendor/openclaw-weixin/LICENSE](vendor/openclaw-weixin/LICENSE):

> Tencent is pleased to support the open source community by making openclaw-weixin available.
> Copyright (C) 2026 Tencent. All rights reserved.
> openclaw-weixin is licensed under the MIT.

### What was vendored

Compiled ESM JavaScript from the published tarball's `dist/src/`, with `.map` files and
`sourceMappingURL` comments removed:

- `api/api.js`, `api/types.js` — the iLink HTTP transport (`getUpdates`, `sendMessage`,
  `getConfig`, `sendTyping`, `getUploadUrl`, `notifyStart`/`notifyStop`) and uint64-safe JSON parsing.
- `auth/accounts.js` — local 0600 account store.
- `storage/state-dir.js`, `storage/sync-buf.js` — state dir resolution and the long-poll sync buffer.
- `util/logger.js`, `util/redact.js` — logging and secret redaction.
- `util/random.js` — `generateId` / `tempFileName` (used for client ids and temp media names).
- `cdn/aes-ecb.js` — AES-128-ECB encrypt/decrypt and PKCS7-padded ciphertext size.
- `cdn/cdn-url.js` — CDN upload/download URL construction and the `full_url` fallback switch.
- `cdn/pic-decrypt.js` — downloads CDN bytes and AES-128-ECB decrypts them (both `aes_key`
  encodings: base64 of 16 raw bytes for images, base64 of a 32-char hex string for
  file/voice/video).
- `cdn/cdn-upload.js` — `uploadBufferToCdn`: POSTs ciphertext to the CDN, retries server errors
  (3 attempts), aborts immediately on 4xx, returns `x-encrypted-param`.
- `cdn/upload.js` — the high-level upload pipeline (`uploadFileToWeixin` for images,
  `uploadVideoToWeixin`, `uploadFileAttachmentToWeixin`) plus `downloadRemoteImageToTemp`.
- `media/mime.js` — filename → MIME and MIME/URL → extension mapping.
- `messaging/markdown-filter.js` — `StreamingMarkdownFilter`, the character-level state machine
  that turns streamed Markdown into WeChat-readable plain text.
- `messaging/send-media.js` — `sendWeixinMediaFile`, which routes a local file by MIME to
  video / image / file upload + send.
- `messaging/send.js` — `sendMessageWeixin`, `sendMessageItemWeixin` and the media senders
  (`sendImageMessageWeixin`, `sendVideoMessageWeixin`, `sendFileMessageWeixin`). Vendored
  because `messaging/send-media.js` imports it.
- `messaging/quote-store.js` — the outbound/inbound quote cache, kept because
  `auth/accounts.js` imports `deleteQuoteCacheForAccount` and `messaging/send.js` imports
  `getQuoteStore`.

Slash commands, the progress/notice senders, the OpenClaw channel plugin wrapper and the
monitor/dispatch layer are NOT vendored. `messaging/inbound.js` is also NOT vendored — the one
helper `messaging/send.js` needs from it is reproduced in the shim (see "What was changed",
item 4).

### What was changed

The vendored code is decoupled from the OpenClaw host so it can run under DSH:

1. Three imports from `openclaw/plugin-sdk/*` were rewritten to
   `vendor/openclaw-weixin/openclaw-shim.js`:
   - `normalizeAccountId` (from `account-id`) → trim + lowercase.
   - `mutateConfigFile` (from `config-mutation`) → async no-op. DSH configuration lives in
     `cordis.patch.yml`, not in an OpenClaw config file, so there is nothing to write back.
   - `resolvePreferredOpenClawTmpDir` (from `temp-path`) → `process.env.DSH_WEIXIN_LOG_DIR`
     or `~/.dsh/weixin/logs`, so logs land under DSH's state dir.
2. A minimal `vendor/openclaw-weixin/package.json` was added. It is load-bearing, not
   cosmetic: `api.js` reads `pkg.ilink_appid` for the `iLink-App-Id` header and
   `pkg.version` for `iLink-App-ClientVersion` via `buildClientVersion()`.
3. Credential location is redirected at runtime by `src/state.js` (sets
   `OPENCLAW_STATE_DIR`), so accounts are stored under `~/.dsh/weixin/` instead of
   `~/.openclaw/`.
4. One *package-internal* import was rewritten to the same shim:
   `messaging/send.js` imported `getMediaLabel` from `messaging/inbound.js`, and
   `inbound.js` is not vendored. It is not vendorable in isolation — its transitive
   closure is `util/logger.js`, `util/random.js`, `api/types.js`, `storage/state-dir.js`,
   `messaging/partial-quote.js`, `messaging/quote-store.js`, plus it exports the whole
   inbound `MsgContext` / quote-resolution layer that nothing vendored uses. So
   `messaging/send.js` now imports `getMediaLabel` from
   `vendor/openclaw-weixin/openclaw-shim.js`, which reproduces the function verbatim.
   This is a change of *import site only* for one four-case label function; it
   touches no protocol, crypto or authorization logic.
5. `api/api.js` now throws `SendMessageRejectedError` when a parsed
   `sendmessage` response contains a nonzero `ret`. The typed error retains
   `ret`, `errmsg`, and `sendOutcome: "rejected"`, allowing callers to
   distinguish an explicit server rejection from fetch, HTTP, or parse failures
   whose delivery outcome is unknown. The wire request and response handling
   are otherwise unchanged.
