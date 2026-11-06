// Neutralize plugin tag boundaries in untrusted message, quote and link text.
const TAG_START = /<\s*\/?\s*weixin_/gi
const ESCAPED = '&lt;'

/**
 * Neutralise tag syntax in untrusted text.
 *
 * Idempotent, and safe on text that has no tags (the common case: one regex test).
 *
 * @param {string} text
 * @returns {string}
 */
export function neutralizeTags(text) {
  if (typeof text !== 'string' || text === '') return text
  if (TAG_START.test(text) !== true) return text
  TAG_START.lastIndex = 0
  return text.replace(TAG_START, (match) => `${ESCAPED}${match.slice(1)}`)
}
