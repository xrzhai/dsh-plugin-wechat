/**
 * Split an outbound reply into Weixin-sized chunks.
 *
 * iLink accepts a single text item per message and WeChat clients render very
 * long bodies badly, so a long assistant reply is sent as several messages.
 * Splits prefer line boundaries and then spaces, so a chunk never breaks a
 * table row or a URL mid-token when avoidable.
 * @module dsh-weixin/message/chunker
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Move `cut` back to the start of a grapheme if it landed inside one. */
function graphemeBoundaryAtOrBefore(text, cut) {
  let boundary = 0
  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    if (index >= cut) break
    const end = index + segment.length
    if (end > cut) break
    boundary = end
  }
  return boundary
}

/**
 * A grapheme wider than the cap still needs a safe split. Walk code points so
 * surrogate pairs stay intact; an astral scalar is the only unavoidable
 * over-cap unit when `limit` is one.
 */
function codePointBoundary(text, limit) {
  let boundary = 0
  for (const codePoint of text) {
    const next = boundary + codePoint.length
    if (next > limit) break
    boundary = next
  }
  return boundary === 0 ? String.fromCodePoint(text.codePointAt(0)).length : boundary
}

/**
 * @param {string} text
 * @param {number} maxLength  Must be a positive integer.
 * @returns {string[]}  At least one chunk; never empty unless `text` is empty.
 * Chunks stay within `maxLength` UTF-16 code units whenever the text can be cut
 * there without splitting a Unicode scalar or grapheme, and always do so when
 * `maxLength` can contain at least two code units.
 */
export function chunkText(text, maxLength) {
  const limit = Math.max(1, Math.floor(maxLength))
  if (text === '') return []
  if (text.length <= limit) return [text]

  /** @type {string[]} */
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = -1
    const window = rest.slice(0, limit)
    const newline = window.lastIndexOf('\n')
    if (newline > limit * 0.5) {
      cut = newline + 1 // keep the newline on the previous chunk
    } else {
      const space = window.lastIndexOf(' ')
      if (space > limit * 0.5) cut = space + 1
    }
    if (cut <= 0) cut = limit
    cut = graphemeBoundaryAtOrBefore(rest, cut)
    if (cut === 0) cut = codePointBoundary(rest, limit)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}
