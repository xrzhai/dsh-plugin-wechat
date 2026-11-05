import fs from 'node:fs'
import path from 'node:path'

export const PKG_NAME = 'dsh-plugin-wechat'
export const ROW_ID = 'dsh-weixin'
export const SUPERSEDED_PACKAGES = ['dsh-weixin', 'dsh-plugin-weixin']
export const KEPT_KEYS = [
  'allowedSenders',
  'allowedChats',
  'cwd',
  'accountId',
  'enabled',
  'asr',
  'maxMessageLength',
  'markdownMode',
]

function indentOf(line) {
  return line.match(/^[ \t]*/)?.[0].length ?? 0
}

function isBlank(line) {
  return line.trim() === ''
}

function isComment(line) {
  return line.trimStart().startsWith('#')
}

function isSequenceItem(line) {
  return /^\s*-\s+\S/.test(line)
}

function sectionEnd(lines, insertAt, insertIndent) {
  for (let at = insertAt + 1; at < lines.length; at += 1) {
    if (isBlank(lines[at])) continue
    const indent = indentOf(lines[at])
    if (isComment(lines[at]) && indent > insertIndent) continue
    if (indent <= insertIndent) return at
  }
  return lines.length
}

function nextContentLine(lines, start, end) {
  for (let at = start; at < end; at += 1) {
    if (isBlank(lines[at]) || isComment(lines[at])) continue
    return at
  }
  return undefined
}

function rowEnd(lines, rowAt, end, rowIndent) {
  for (let at = rowAt + 1; at < end; at += 1) {
    if (isBlank(lines[at])) continue
    const indent = indentOf(lines[at])
    if (isComment(lines[at])) {
      if (indent < rowIndent) return at
      if (indent === rowIndent) {
        const next = nextContentLine(lines, at + 1, end)
        if (next !== undefined && indentOf(lines[next]) > rowIndent) continue
        return at
      }
      continue
    }
    if (indent > rowIndent) continue
    return at
  }
  return end
}

function directSequenceIndent(lines, start, end, insertIndent) {
  let directIndent = null
  for (let at = start; at < end; at += 1) {
    if (isBlank(lines[at]) || isComment(lines[at]) || !isSequenceItem(lines[at])) continue
    const indent = indentOf(lines[at])
    if (indent <= insertIndent) continue
    if (directIndent === null || indent < directIndent) directIndent = indent
  }
  return directIndent
}

function sectionHasRows(lines, start, end, directIndent) {
  return lines.slice(start, end).some((line) => (
    !isBlank(line) && !isComment(line) && indentOf(line) === directIndent && isSequenceItem(line)
  ))
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * Find every old manually mounted dsh-weixin row, regardless of whether it is
 * in the first insert block. A row ends when indentation returns to the row
 * level, never merely when the next insert starts.
 *
 * @param {string} text
 * @param {string} [rowId]
 * @returns {Array<{start:number,end:number,rowStart:number,rowEnd:number,insertStart:number,insertEnd:number}>}
 */
export function findMountBlocks(text, rowId = ROW_ID) {
  const lines = text.split('\n')
  const blocks = []
  for (let insertAt = 0; insertAt < lines.length; insertAt += 1) {
    if (!/^\s*-\s*insert:\s*$/.test(lines[insertAt])) continue
    const insertIndent = indentOf(lines[insertAt])
    const insertEnd = sectionEnd(lines, insertAt, insertIndent)
    const directIndent = directSequenceIndent(lines, insertAt + 1, insertEnd, insertIndent)
    if (directIndent === null) continue
    for (let rowAt = insertAt + 1; rowAt < insertEnd; rowAt += 1) {
      const rowIndent = indentOf(lines[rowAt])
      if (rowIndent !== directIndent || !isSequenceItem(lines[rowAt])) continue
      const idPattern = new RegExp('^\\s*-\\s*id:\\s*' + escapeRegExp(rowId) + '\\s*$')
      if (!idPattern.test(lines[rowAt])) continue
      let rowStart = rowAt
      while (rowStart > insertAt + 1 && isComment(lines[rowStart - 1]) &&
             indentOf(lines[rowStart - 1]) >= rowIndent) {
        rowStart -= 1
      }
      const rowStop = rowEnd(lines, rowAt, insertEnd, rowIndent)
      blocks.push({
        start: rowStart,
        end: rowStop,
        rowStart,
        rowEnd: rowStop,
        insertStart: insertAt,
        insertEnd,
      })
      rowAt = rowStop - 1
    }
  }
  return blocks
}

/** Backwards-compatible singular helper for callers that only need the first row. */
export function findMountBlock(text, rowId = ROW_ID) {
  return findMountBlocks(text, rowId)[0]
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Remove only the old plugin rows. Other rows in the same insert block and
 * all rows in other insert blocks are preserved byte-for-byte.
 *
 * @param {string} text
 * @param {string} [rowId]
 * @returns {{text:string,blocks:Array<object>}}
 */
export function removeMountBlocks(text, rowId = ROW_ID) {
  const blocks = findMountBlocks(text, rowId)
  if (blocks.length === 0) return { text, blocks: [] }
  const lines = text.split('\n')
  const ranges = []
  const bySection = new Map()
  for (const block of blocks) {
    const key = block.insertStart
    if (!bySection.has(key)) bySection.set(key, [])
    bySection.get(key).push(block)
  }
  for (const sectionBlocks of bySection.values()) {
    const first = sectionBlocks[0]
    const localRanges = mergeRanges(sectionBlocks.map((block) => ({ start: block.start, end: block.end })))
    const remaining = []
    let cursor = first.insertStart + 1
    for (const range of localRanges) {
      remaining.push(...lines.slice(cursor, range.start))
      cursor = range.end
    }
    remaining.push(...lines.slice(cursor, first.insertEnd))
    const insertIndent = indentOf(lines[first.insertStart])
    const directIndent = directSequenceIndent(remaining, 0, remaining.length, insertIndent)
    if (directIndent !== null && sectionHasRows(remaining, 0, remaining.length, directIndent)) {
      ranges.push(...localRanges)
      continue
    }
    let sectionStart = first.insertStart
    while (sectionStart > 0 && isComment(lines[sectionStart - 1])) sectionStart -= 1
    ranges.push({ start: sectionStart, end: first.insertEnd })
  }
  const nextLines = [...lines]
  for (const range of mergeRanges(ranges).reverse()) {
    nextLines.splice(range.start, range.end - range.start)
  }
  let next = nextLines.join('\n')
  next = next.replace(/\n{3,}/g, '\n\n').trimEnd()
  return { text: next === '' ? '[]\n' : next + '\n', blocks }
}

/** Read operator-owned values out of one old mounted row. */
export function readKeptValues(block) {
  const lines = block.split('\n')
  const keep = {}
  for (const key of KEPT_KEYS) {
    const startAt = lines.findIndex((line) => new RegExp('^[ \\t]*' + key + ':[ \\t]*(.*)$').test(line))
    if (startAt === -1) continue
    const indent = indentOf(lines[startAt])
    const collected = []
    let childIndent = null
    for (let at = startAt + 1; at < lines.length; at += 1) {
      const line = lines[at]
      if (isBlank(line)) {
        const nextReal = lines.slice(at + 1).find((candidate) => !isBlank(candidate))
        if (nextReal === undefined) break
        if (indentOf(nextReal) <= indent) break
        collected.push('')
        continue
      }
      const lineIndent = indentOf(line)
      if (lineIndent <= indent) break
      if (isComment(line)) continue
      if (childIndent === null) childIndent = lineIndent
      collected.push(lineIndent <= childIndent ? line.trimStart() : line.slice(childIndent))
    }
    const inline = lines[startAt].slice(indent).replace(new RegExp('^' + key + ':[ \\t]*'), '').trim()
    keep[key] = [inline, ...collected].filter((line, index) => index === 0 || line !== '').join('\n')
  }
  return keep
}

/** Convert the small YAML subset written by the old installer into JSON. */
export function parseYamlNode(raw) {
  const text = raw.trim()
  if (text === '') return undefined
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length > 0 && lines.every((line) => line.startsWith('-'))) {
    return lines.map((line) => line.replace(/^-[ \t]*/, '').replace(/^['"]|['"]$/g, ''))
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const body = text.slice(1, -1).trim()
    return body === '' ? [] : body.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
  }
  if (lines.length > 0 && lines.every((line) => /^[A-Za-z_][\w]*:([ \t]|$)/.test(line))) {
    const nested = {}
    for (const line of lines) {
      const at = line.indexOf(':')
      const key = line.slice(0, at).trim()
      const value = parseYamlNode(line.slice(at + 1))
      if (value !== undefined) nested[key] = value
    }
    return nested
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  return text.replace(/^['"]|['"]$/g, '')
}

/** Turn an absolute source checkout into a portable pnpm link spec. */
export function sourceLinkSpec(sourceRoot) {
  return 'link:' + path.resolve(sourceRoot).replaceAll('\\', '/')
}

/** Same lexical path, using the platform's case rules on Windows. */
export function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Remove a profile's package entry without following a link back to the source
 * checkout. A symlink or junction is unlinked; only a real copied directory is
 * recursively removed.
 */
export function removeInstalledPackage(targetDir, sourceRoot, { allowSelf = false } = {}) {
  const stat = fs.lstatSync(targetDir, { throwIfNoEntry: false })
  if (stat === undefined) return { removed: false, reason: 'missing' }
  if (!allowSelf && samePath(targetDir, sourceRoot)) {
    return { removed: false, reason: 'source-is-target' }
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(targetDir)
    return { removed: true, reason: 'link' }
  }
  const realTarget = fs.realpathSync.native ? fs.realpathSync.native(targetDir) : fs.realpathSync(targetDir)
  const realSource = fs.existsSync(sourceRoot)
    ? (fs.realpathSync.native ? fs.realpathSync.native(sourceRoot) : fs.realpathSync(sourceRoot))
    : path.resolve(sourceRoot)
  if (samePath(realTarget, realSource) || (!allowSelf && isInside(realTarget, realSource))) {
    return { removed: false, reason: 'contains-source' }
  }
  fs.rmSync(targetDir, { recursive: true, force: true })
  return { removed: true, reason: 'copy' }
}
