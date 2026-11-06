/**
 * Local type vocabulary for the Weixin/iLink channel.
 *
 * These are structural mirrors, not imports: DSH ships the plugin-facing
 * `@deepseek-ai/*` packages only inside the app bundle, and dsh-weixin must stay
 * loadable without them (its tests run in plain Node). Each type is documented
 * with the module it mirrors so the shapes can be re-checked after an upgrade.
 */

/**
 * A message arriving from Weixin, normalized out of an iLink `WeixinMessage`.
 * @typedef {Object} InboundMessage
 * @property {string} id             Stable message id (iLink `message_id`, kept as a
 *                                   string: the transport quotes uint64 ids before
 *                                   JSON.parse to avoid float precision loss).
 * @property {string} senderId       `from_user_id`.
 * @property {string} conversationId Peer id used to route replies — `from_user_id`
 *                                   for a direct message, `group_id` when present.
 * @property {'text'|'image'|'file'|'voice'|'video'|'unsupported'} type
 * @property {string} [text]         Decoded text for `type: 'text'`.
 * @property {string} contextToken   Echoed on the reply (iLink `context_token`);
 *                                   without it the send is rejected or misrouted.
 * @property {number} [timestamp]    `create_time_ms` when present.
 */

/**
 * A reply bound for Weixin.
 *
 * `text` is the agent's raw Markdown; conversion to WeChat-readable plain text
 * happens on the way out ({@link module:dsh-weixin/message/markdown}), so this
 * shape deliberately stays format-agnostic.
 * @typedef {Object} OutboundMessage
 * @property {string} conversationId Peer id to send to (becomes `msg.to_user_id`).
 * @property {'text'} type
 * @property {string} text
 * @property {string} [contextToken] Echo of the inbound `context_token`.
 * @property {string} [replyTo]      Inbound message id, for local correlation only.
 */

/**
 * A local file to send back to Weixin as an attachment.
 *
 * The media counterpart of {@link OutboundMessage}, and the only shape the
 * transport's `sendMedia` accepts. It carries no MIME type and no upload
 * metadata on purpose: the kind (image / video / file) is derived from the
 * file's own extension at send time, so a caller cannot claim a `.sh` is an
 * image.
 *
 * @typedef {Object} OutboundMedia
 * @property {string} filePath        Absolute path of an existing local file.
 * @property {string} conversationId  Peer id to send to (`msg.to_user_id`).
 * @property {string} [contextToken]  Echo of the inbound `context_token`; iLink
 *                                    routes the reply by it, media included.
 * @property {string} [cdnBaseUrl]    Weixin CDN root; unset uses the upstream default.
 * @property {string} [caption]       Optional text sent as its own item first.
 */

/**
 * Markdown handling for outbound replies.
 * - `strip`: filter unsupported syntax through the vendored upstream filter.
 * - `off`:   send the reply verbatim (debugging / A-B comparison).
 * @typedef {'strip'|'off'} MarkdownMode
 */

/**
 * @typedef {Object} WeixinAccount
 * @property {string} accountId
 * @property {string} baseUrl
 * @property {string} [token]
 * @property {string} [userId]
 * @property {boolean} configured
 */

/**
 * An inbound attachment after downloading, decrypting and saving it locally.
 * Mirrors successful results from {@link module:dsh-weixin/media/inbound}.
 *
 * @typedef {Object} DownloadedMedia
 * @property {true} ok
 * @property {string} path       Absolute path of the stored file.
 * @property {string} name       Saved filename.
 * @property {number} bytes      Number of bytes saved.
 * @property {string} kind       Attachment type.
 * @property {string} mime       Media type inferred from the filename.
 */

export {}
