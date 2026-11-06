import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteJson } from '../atomic.js'
import { translate } from '../i18n.js'
import { armLongTimer } from './long-timer.js'

/**
 * Durable scheduled messages: `/remind <when> <text>` stores a reminder, a
 * timer fires it, and a restart re-arms the surviving ones.
 *
 * The store lives in the plugin state dir (`reminders.json`), not memory, for
 * the same reason the session lines do: the DSH host is reloaded far more
 * often than a reminder fires, and a reminder that dies with the process is a
 * reminder the user asked for and never received.
 *
 * Fired reminders are deleted, not marked: a reminder.json that only ever
 * grows punishes every read, and "history of what I reminded myself" is what
 * the Weixin chat transcript already is.
 */

/** Largest text a reminder may carry, mirroring the chunker's headroom. */
export const MAX_REMINDER_TEXT_CHARS = 2000

/** How many pending reminders one account may hold. */
export const MAX_PENDING_PER_ACCOUNT = 50

/** Far-future cap: a reminder more than 366 days out is almost surely a typo. */
export const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000
const MAX_DELAY_REASON = '定得太远：最多支持一年以内'
const INVALID_HHMM_REASON = '时间格式应为 HH:mm，例如 09:30'
const NOT_FUTURE_REASON = '时间必须是未来的某个时刻'
const PAST_REASON = '那个时刻已经过去了'

/** Retry an undelivered reminder without spinning or abandoning it. */
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
const REMINDER_SCHEMA_VERSION = 1
const REMINDER_ID_PATTERN = /^r([1-9]\d*)$/
const WRITE_BLOCK_REASON = Symbol('reminderStoreWriteBlockReason')

/**
 * Parse a `/remind` time spec. Supported forms, in the order they are tried:
 *
 *  - `10m` / `2h` / `1d30m` — a duration from now
 *  - `HH:mm` — today, or tomorrow when the time has already passed
 *  - `YYYY-MM-DD HH:mm` — an explicit local date and time
 *  - `明天 9:00` / `后天下午3点半` / `下周一 10点` / `3小时后` — 中文口语
 *
 * Times are wall-clock in the host's local zone: the person typing the
 * reminder reads the same clock as the host, and storing UTC instants for a
 * "9:00 tomorrow" request would survive a DST shift incorrectly.
 *
 * @param {string} spec
 * @param {Date} [now]
 * @returns {{ ok: true, fireAt: number, label: string } | { ok: false, reason: string }}
 */
export function parseWhen(spec, now = new Date()) {
  const trimmed = String(spec ?? '').trim()
  if (trimmed === '') return { ok: false, reason: '缺少时间：/remind 10m 内容 / /remind 14:30 内容 / /remind 2026-10-19 09:00 内容' }

  // 1. Pure duration: `1d30m`-style run-together units, smallest to largest.
  const duration = parseDuration(trimmed)
  if (duration !== undefined) {
    if (duration <= 0) return { ok: false, reason: NOT_FUTURE_REASON }
    if (duration > MAX_DELAY_MS) return { ok: false, reason: MAX_DELAY_REASON }
    return { ok: true, fireAt: now.getTime() + duration, label: formatLabel(new Date(now.getTime() + duration)) }
  }

  // 2. Explicit date + time: `2026-10-19 09:00`.
  const absolute = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(trimmed)
  if (absolute !== null) {
    const [y, mo, d, h, mi] = absolute.slice(1).map(Number)
    if (h > 23 || mi > 59) return { ok: false, reason: INVALID_HHMM_REASON, invalidClock: true }
    const target = new Date(y, mo - 1, d, h, mi)
    if (Number.isNaN(target.getTime()) || target.getDate() !== d || target.getMonth() !== mo - 1) {
      return { ok: false, reason: '日期或时间不存在，请检查' }
    }
    if (target.getTime() <= now.getTime()) return { ok: false, reason: PAST_REASON }
    if (target.getTime() - now.getTime() > MAX_DELAY_MS) return { ok: false, reason: MAX_DELAY_REASON }
    return { ok: true, fireAt: target.getTime(), label: formatLabel(target) }
  }

  // 3. Time of day: `09:00` or `9:05`. Today when still ahead, else tomorrow.
  const timeOfDay = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (timeOfDay !== null) {
    const h = Number(timeOfDay[1])
    const mi = Number(timeOfDay[2])
    if (h > 23 || mi > 59) return { ok: false, reason: INVALID_HHMM_REASON, invalidClock: true }
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return { ok: true, fireAt: target.getTime(), label: formatLabel(target) }
  }

  // 4. Natural Chinese: `明天 9:00`, `后天下午3点半`, `下周一 10点`, `3小时后`.
  const natural = parseNaturalWhen(trimmed, now)
  if (natural !== undefined) return natural

  return { ok: false, reason: '看不懂这个时间：支持 10m / 2h / 1d30m、14:30、2026-10-19 09:00、明天 9:00、下周一 10:00、3小时后' }
}

const CN_DAY_OFFSET = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2, 大后天: 3 }
const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
const CN_PERIOD_PM = new Set(['下午', '傍晚', '晚上', '夜里'])
const CN_PERIOD_AM = new Set(['凌晨', '早上', '早晨', '上午'])
const CN_PERIOD_NIGHT = new Set(['晚上', '夜里'])

/**
 * 中文口语时间：`明天 9:00`、`后天下午3点半`、`下周一 10点`、`3小时后`。
 *
 * 只认「日期词 + 时钟」这一种组合，不做模糊猜测：`明天下午`（没有钟点）
 * 会明确要求补一个时间，而不是替用户选一个。`下周一` 永远指下一个自然周，
 * `周一` 指最近一次尚未过去的该星期几（当天已过 09:00 就顺延一周）。
 *
 * @param {string} spec
 * @param {Date} now
 * @returns {{ ok: true, fireAt: number, label: string } | { ok: false, reason: string } | undefined}
 *   undefined 表示「不是这种写法」，交给调用方继续尝试其它格式。
 */
function parseNaturalWhen(spec, now) {
  const text = spec.replace(/\s+/g, ' ').trim()

  // `3小时后` / `30分钟后` / `半小时后` / `2天后`
  const relative = /^(\d+(?:\.\d+)?|半)\s*(分钟|分|小时|钟头|天)\s*后$/.exec(text)
  if (relative !== null) {
    const amount = relative[1] === '半' ? 0.5 : Number(relative[1])
    const unitMs = { 分钟: 60_000, 分: 60_000, 小时: 3_600_000, 钟头: 3_600_000, 天: 86_400_000 }
    const delay = Math.round(amount * unitMs[relative[2]])
    if (delay <= 0) return { ok: false, reason: NOT_FUTURE_REASON }
    if (delay > MAX_DELAY_MS) return { ok: false, reason: MAX_DELAY_REASON }
    return { ok: true, fireAt: now.getTime() + delay, label: formatLabel(new Date(now.getTime() + delay)) }
  }

  let rest = text
  let day = null
  const dayMatch = /^(今天|今晚|明天|明晚|后天|大后天)/.exec(rest)
  if (dayMatch !== null) {
    day = { offset: CN_DAY_OFFSET[dayMatch[1]], evening: dayMatch[1].endsWith('晚') }
    rest = rest.slice(dayMatch[1].length).trim()
  } else {
    // `下周一 10点` / `周五` / `这个周三` / `下个周日` — all the ways people say it.
    const week = /^(下个|这个|下|这|本)?(?:周|星期)([一二三四五六日天])/.exec(rest)
    if (week !== null) {
      day = { weekday: CN_WEEKDAY[week[2]], next: week[1] === '下' || week[1] === '下个' }
      rest = rest.slice(week[0].length).trim()
    }
  }

  let period = null
  const periodMatch = /^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/.exec(rest)
  if (periodMatch !== null) {
    period = periodMatch[1]
    rest = rest.slice(periodMatch[1].length).trim()
  }

  // 只说了「周五」「下个周三」而没给钟点：按早上 9 点算。这是「提醒我周五交周报」
  // 最常见的形状，拒绝它只会让人多打四个字；而「明天」这种连哪天都还没定的
  // 说法仍然要问，因为一天里的哪个时刻完全猜不出来。
  const bareWeekday = day?.weekday !== undefined && rest === ''
  const clock = bareWeekday
    ? ['', '9', undefined, undefined]
    : /^(\d{1,2})\s*(?:[:：点时])\s*(?:(\d{1,2})\s*分?|(半))?$/.exec(rest)
  if (clock === null) {
    if (day !== null || period !== null) return { ok: false, reason: '还需要一个钟点，例如 明天 9:00 / 下午 3 点半' }
    return undefined
  }

  let hour = Number(clock[1])
  const minute = clock[3] === '半' ? 30 : Number(clock[2] ?? 0)
  if (hour > 23 || minute > 59) return { ok: false, reason: '时间格式应为 9:00 或 9点半', invalidClock: true }
  // 今晚/明晚 only imply an evening time when no explicit period was written.
  // An explicit period wins, so conflicting forms are not shifted twice.
  const inferredEvening = period === null && day?.evening === true
  const lateEvening = inferredEvening || CN_PERIOD_NIGHT.has(period)
  if ((CN_PERIOD_PM.has(period) || inferredEvening) && hour < 12) hour += 12
  if (period === '中午' && hour < 11) hour += 12
  if (period === '凌晨' && hour === 12) hour = 0
  if (CN_PERIOD_AM.has(period) && hour === 12) hour = 0

  // A 12 o'clock evening time is the end of that evening, not noon. Apply
  // the date offset first, then roll over once so an evening day is not doubled.
  let midnightRollover = 0
  if (lateEvening && hour === 12) {
    hour = 0
    midnightRollover = 1
  }

  const target = new Date(now)
  if (day?.offset !== undefined) {
    target.setDate(target.getDate() + day.offset)
  } else if (day?.weekday !== undefined) {
    let delta = (day.weekday - now.getDay() + 7) % 7
    if (day.next === true) {
      // 「下周X」从下一个周一算起。先算今天到下周一的距离，再加目标星期
      // 相对周一的偏移；直接给 `% 7` 的结果加 7 会让已过去的星期多等一周。
      const daysToNextMonday = 7 - ((now.getDay() + 6) % 7)
      delta = daysToNextMonday + ((day.weekday + 6) % 7)
    }
    target.setDate(target.getDate() + delta)
  }
  target.setDate(target.getDate() + midnightRollover)
  target.setHours(hour, minute, 0, 0)

  if (day === null && target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  // 「周天」在周日当天说，指的是下一个周日 —— 今天这个已经过了（或者说，它更像是
  // 在说「下回」）。只有明确的「今天/这周X」才允许落在今天。
  if (day?.weekday !== undefined && day.next !== true && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7)
  }
  if (target.getTime() <= now.getTime()) return { ok: false, reason: PAST_REASON }
  if (target.getTime() - now.getTime() > MAX_DELAY_MS) return { ok: false, reason: MAX_DELAY_REASON }
  return { ok: true, fireAt: target.getTime(), label: formatLabel(target) }
}

/**
 * Parse a run-together duration like `10m`, `2h`, `1d30m`, `90s`.
 * @param {string} spec
 * @returns {number | undefined} milliseconds, or undefined when the spec is not a duration
 */
function parseDuration(spec) {
  if (!/^\d+(?:[dhms]\d+)*[dhms]$/.test(spec)) return undefined
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  let total = 0
  for (const [, value, unit] of spec.matchAll(/(\d+)([dhms])/g)) total += Number(value) * unitMs[unit]
  return total
}

/** The human label attached to the confirmation line, in local time. */
function formatLabel(date) {
  const sameDay = new Date().toDateString() === date.toDateString()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${time}`
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
}

/**
 * 重复提醒：`每天 9:00`、`工作日 8:30`、`每周一 10点`。
 *
 * 重复与一次性分开解析：`parseWhen` 说的是「哪一刻」，这里说的是「每个周期
 * 的同一刻」。分开之后 `明天 9:00` 这种相对写法不会和重复混在一起，`/remind`
 * 只需要在候选前缀上先试重复、再试一次性，不需要在正则里穷举组合。
 *
 * @param {string} spec
 * @param {Date} [now]
 * @returns {{ ok: true, recurrence: { kind: 'daily' | 'weekdays' | 'weekly', weekday?: number }, hour: number, minute: number, fireAt: number, label: string } | { ok: false, reason: string }}
 */
export function parseRecurrence(spec, now = new Date()) {
  const text = String(spec ?? '').replace(/\s+/g, ' ').trim()
  const head = /^(每天|天天|每日|工作日|每个工作日|每周([一二三四五六日天]))\s*(.+)$/.exec(text)
  if (head === null) return { ok: false, reason: `「${text}」不是重复写法（每天 9:00 / 工作日 8:30 / 每周一 10点）` }
  const clock = /^(\d{1,2})\s*(?:[:：点时])\s*(?:(\d{1,2})\s*分?|(半))?$/.exec(head[3].trim())
  if (clock === null) return { ok: false, reason: `「${head[3].trim()}」不是钟点（例如 9:00、9点、9点半）` }
  const hour = Number(clock[1])
  const minute = clock[3] === '半' ? 30 : Number(clock[2] ?? 0)
  if (hour > 23 || minute > 59) return { ok: false, reason: '钟点超出范围（0–23 点，0–59 分）', invalidClock: true }
  const kind = head[1].startsWith('每周') ? 'weekly' : (head[1].includes('工作日') ? 'weekdays' : 'daily')
  const recurrence = kind === 'weekly' ? { kind, weekday: CN_WEEKDAY[head[2]] } : { kind }
  return {
    ok: true,
    recurrence,
    hour,
    minute,
    fireAt: nextRecurrenceAt(recurrence, hour, minute, now.getTime()),
    label: recurrenceLabel(recurrence, hour, minute),
  }
}

/**
 * The first occurrence strictly after `afterMs` (the current slot, so a repeat
 * never re-fires the same minute).
 *
 * @param {{ kind: 'daily' | 'weekdays' | 'weekly', weekday?: number }} recurrence
 * @param {number} hour
 * @param {number} minute
 * @param {number} afterMs
 * @returns {number}
 */
export function nextRecurrenceAt(recurrence, hour, minute, afterMs) {
  const from = new Date(afterMs)
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hour, minute, 0, 0)
    if (candidate.getTime() <= afterMs) continue
    const day = candidate.getDay()
    if (recurrence.kind === 'weekly' && day !== recurrence.weekday) continue
    if (recurrence.kind === 'weekdays' && (day === 0 || day === 6)) continue
    return candidate.getTime()
  }
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7, hour, minute, 0, 0).getTime()
}

function recurrenceLabel(recurrence, hour, minute) {
  const at = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (recurrence.kind === 'weekly') return `每周${CN_WEEKDAY_NAME[recurrence.weekday]} ${at}`
  if (recurrence.kind === 'weekdays') return `工作日 ${at}`
  return `每天 ${at}`
}

const CN_WEEKDAY_NAME = { 0: '日', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' }

function makeReminderStore(seq, items, writeBlockReason) {
  const store = { seq, items }
  if (writeBlockReason !== undefined) {
    Object.defineProperty(store, WRITE_BLOCK_REASON, { value: writeBlockReason })
  }
  return store
}

function sequenceFromId(value) {
  if (typeof value !== 'string') return 0
  const match = REMINDER_ID_PATTERN.exec(value)
  if (match === null) return 0
  const sequence = Number(match[1])
  return Number.isSafeInteger(sequence) ? sequence : 0
}

/** Highest rN id, including ids on otherwise-invalid rows, so repairs cannot reuse one. */
function sequenceFromItems(items) {
  let sequence = 0
  for (const item of items) sequence = Math.max(sequence, sequenceFromId(item?.id))
  return sequence
}

/** Next free safe rN id, checking the bound before and after every increment. */
function nextReminderSequence(current, ids) {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) return undefined
  let next = current
  while (next < Number.MAX_SAFE_INTEGER) {
    next += 1
    if (!Number.isSafeInteger(next)) return undefined
    if (!ids.has(`r${next}`)) return next
  }
  return undefined
}

function isRecurrence(value) {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.kind !== 'daily' && value.kind !== 'weekdays' && value.kind !== 'weekly') return false
  return value.kind !== 'weekly' || (Number.isInteger(value.weekday) && value.weekday >= 0 && value.weekday <= 6)
}

function isReminder(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.id !== 'string' || REMINDER_ID_PATTERN.exec(value.id) === null) return false
  if (typeof value.accountId !== 'string' || value.accountId.trim() === '') return false
  if (typeof value.conversationId !== 'string' || value.conversationId.trim() === '') return false
  if (typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > MAX_REMINDER_TEXT_CHARS) return false
  if (!Number.isFinite(value.fireAt)) return false
  if (value.createdAt !== undefined && typeof value.createdAt !== 'string' && !Number.isFinite(value.createdAt)) return false
  if (!isRecurrence(value.recurrence)) return false
  if (value.recurrence !== undefined && value.recurrence !== null && !Number.isInteger(value.hour)) return false
  if (value.recurrence !== undefined && value.recurrence !== null && (value.hour < 0 || value.hour > 23)) return false
  if (value.recurrence !== undefined && value.recurrence !== null && !Number.isInteger(value.minute)) return false
  if (value.recurrence !== undefined && value.recurrence !== null && (value.minute < 0 || value.minute > 59)) return false
  return value.scheduledFor === undefined || Number.isFinite(value.scheduledFor)
}

/** Keep the exact original bytes before a repaired in-memory view can replace them. */
function preserveReminderStore(file, bytes, warn) {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const recovery = path.join(path.dirname(file), `reminders.recovery-${digest}.json`)
  const temp = `${recovery}.${process.pid}.${Date.now().toString(36)}.tmp`
  const recoveryMatches = () => {
    try {
      return fs.statSync(recovery).isFile() && fs.readFileSync(recovery).equals(bytes)
    } catch {
      return false
    }
  }
  try {
    if (fs.existsSync(recovery)) {
      if (recoveryMatches()) return recovery
      warn(`a recovery file already exists at ${recovery} but does not match the reminder store`)
      return undefined
    }
    const handle = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(handle, bytes)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temp, recovery)
    return recovery
  } catch (error) {
    if (recoveryMatches()) return recovery
    warn(`could not preserve the original reminders.json before repair: ${String(error?.message ?? error)}`)
    return undefined
  } finally {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // The temp file has no value after the durable recovery copy either exists or failed.
    }
  }
}

/**
 * Read the persisted reminder list without allowing a malformed row to reach
 * the timer machinery. Any repair is staged only after the original bytes have
 * a durable recovery copy; if that copy cannot be made, writes stay disabled.
 *
 * @param {string} stateRoot plugin state directory
 * @param {(message: string) => void} [warn]
 * @returns {{ seq: number, items: Reminder[] }}
 */
export function readReminders(stateRoot, warn = () => {}) {
  const file = path.join(stateRoot, 'reminders.json')
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return makeReminderStore(0, [])
    const reason = `could not read reminders.json: ${String(error?.message ?? error)}`
    warn(`${reason}; reminder writes are disabled until the file is readable`)
    return makeReminderStore(0, [], reason)
  }

  let raw
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    const recovery = preserveReminderStore(file, bytes, warn)
    warn(`reminders.json is not valid JSON (${String(error?.message ?? error)}); kept 0 reminders`)
    if (recovery === undefined) return makeReminderStore(0, [], 'the corrupt original could not be preserved')
    warn(`kept a recoverable copy of the corrupt reminder store at ${recovery}`)
    return makeReminderStore(0, [])
  }

  // Treat a legacy bare array as an items-only store as well as the versioned
  // `{seq, items}` shape. Both are read through the same row validator.
  const legacyItems = Array.isArray(raw)
  const container = legacyItems ? { items: raw } : raw
  if (container === null || typeof container !== 'object' || !Array.isArray(container.items)) {
    const recovery = preserveReminderStore(file, bytes, warn)
    warn('reminders.json does not contain a reminder items array; kept 0 reminders')
    if (recovery === undefined) return makeReminderStore(0, [], 'the malformed original could not be preserved')
    warn(`kept a recoverable copy of the malformed reminder store at ${recovery}`)
    return makeReminderStore(0, [])
  }

  const version = container.schemaVersion
  const futureSchema = Number.isSafeInteger(version) && version > REMINDER_SCHEMA_VERSION
  const seen = new Set()
  const items = []
  let rejected = 0
  for (const item of container.items) {
    if (!isReminder(item) || seen.has(item.id)) {
      rejected += 1
      continue
    }
    seen.add(item.id)
    items.push(item)
  }

  const rawSeqValid = Number.isSafeInteger(container.seq) && container.seq >= 0
  const derivedSeq = sequenceFromItems(container.items)
  const seq = Math.max(rawSeqValid ? container.seq : 0, derivedSeq)
  const versionIsLegacy = version === undefined || version === 0
  const versionIsCurrent = version === REMINDER_SCHEMA_VERSION
  const needsRepair = legacyItems || !versionIsCurrent || !rawSeqValid || seq !== container.seq || rejected > 0 || version === undefined
  let recovery
  if (needsRepair) recovery = preserveReminderStore(file, bytes, warn)

  if (rejected > 0) warn(`reminders.json contained ${rejected} invalid or duplicate reminder row(s); kept ${items.length} valid row(s)`)
  if (!rawSeqValid) warn(`reminders.json had no valid seq; recovered seq ${seq} from its reminder ids`)
  if (recovery !== undefined) warn(`kept a recoverable copy of the reminder store at ${recovery}`)
  if (futureSchema) {
    const reason = `reminders.json uses unsupported schemaVersion ${version}`
    warn(`${reason}; kept ${items.length} readable row(s), but writes and automatic delivery are disabled until the schema is understood`)
    return makeReminderStore(seq, items, reason)
  }
  if (needsRepair && recovery === undefined) {
    return makeReminderStore(seq, items, 'the original reminder store could not be preserved')
  }
  if (!versionIsLegacy && !versionIsCurrent && version !== undefined) {
    warn(`reminders.json has an invalid schemaVersion ${JSON.stringify(version)}; it will be repaired on the next write`)
  }
  return makeReminderStore(seq, items)
}

/**
 * Persist the reminder list atomically (tmp file + rename, the same shape the
 * registry uses), so a crash mid-write cannot lose every reminder.
 *
 * @param {string} stateRoot
 * @param {{ seq: number, items: Reminder[] }} store
 */
export function writeReminders(stateRoot, store, warn = () => {}) {
  if (store[WRITE_BLOCK_REASON] !== undefined) {
    warn(`refusing to write reminders.json: ${store[WRITE_BLOCK_REASON]}`)
    return false
  }
  return atomicWriteJson(path.join(stateRoot, 'reminders.json'), { schemaVersion: REMINDER_SCHEMA_VERSION, seq: store.seq, items: store.items }, {
    warn: (message) => warn(`writing reminders.json failed: ${message}`),
  })
}

/**
 * @typedef {{ id: string, accountId: string, conversationId: string,
 *   text: string, fireAt: number, createdAt: string,
 *   recurrence?: { kind: 'daily' | 'weekdays' | 'weekly', weekday?: number },
 *   recurrenceLabel?: string, hour?: number, minute?: number, scheduledFor?: number }} Reminder
 */

/**
 * The live scheduler: owns timers for one process, persists every change, and
 * re-arms from disk on construction (a restart re-arms pending reminders;
 * ones whose moment passed while the host was down fire immediately — a late
 * reminder is strictly better than a silently dropped one).
 */
export class ReminderScheduler {
  /**
   * @param {object} options
   * @param {string} options.stateRoot
   * @param {(reminder: Reminder) => Promise<void> | void} options.fire sends the text; rejection keeps the reminder pending
   * @param {(message: string) => void} [options.warn]
   * @param {(ms: number, callback: () => void) => unknown} [options.setTimeoutRef] injectable for tests
   * @param {(timer: unknown) => void} [options.clearTimeoutRef] injectable for tests
   * @param {() => number} [options.nowRef] injectable clock for tests
   */
  constructor({ stateRoot, fire, warn = () => {}, setTimeoutRef = ((ms, cb) => setTimeout(cb, ms)), clearTimeoutRef = ((t) => clearTimeout(t)), quiet = null, nowRef = (() => Date.now()) }) {
    this.stateRoot = stateRoot
    this.fire = fire
    // Optional quiet-hours gate: (nowMs) => ms until the window ends, 0 when
    // the moment is not quiet. A slot landing inside the window is pushed to
    // the window's end — kept in the store, so a restart re-arms it.
    this.quiet = quiet
    this.warn = warn
    this.setTimeoutRef = setTimeoutRef
    this.clearTimeoutRef = clearTimeoutRef
    this.nowRef = nowRef
    /** @type {Map<string, { cancel: () => void }>} reminder id -> timer controller */
    this.timers = new Map()
    /** @type {Map<string, Promise<void>>} reminder id -> in-flight delivery */
    this.inFlight = new Map()
    /** @type {Map<string, number>} reminder id -> consecutive failed attempts */
    this.retryAttempts = new Map()
    /** @type {Set<string>} due callbacks that arrived while an attempt was in flight */
    this.pendingAttempts = new Set()
    this.store = readReminders(stateRoot, warn)
    this.stopped = false
    const writeBlock = this.store[WRITE_BLOCK_REASON]
    if (writeBlock !== undefined) {
      if (this.store.items.length > 0) {
        warn(`kept ${this.store.items.length} readable reminder(s), but automatic delivery is disabled: ${writeBlock}`)
      }
    } else {
      for (const reminder of this.store.items) this.#arm(reminder)
    }
  }

  /**
   * Store and arm a reminder.
   *
   * @param {{ accountId: string, conversationId: string, text: string, fireAt: number,
   *   recurrence?: { kind: 'daily' | 'weekdays' | 'weekly', weekday?: number },
   *   recurrenceLabel?: string, hour?: number, minute?: number }} plan
   * @returns {Reminder | { error: string }}
   */
  schedule(plan) {
    const text = String(plan.text ?? '').trim()
    if (text === '') return { error: '提醒内容不能为空' }
    if (text.length > MAX_REMINDER_TEXT_CHARS) return { error: `提醒内容太长（最多 ${MAX_REMINDER_TEXT_CHARS} 字）` }
    if (!Number.isFinite(plan.fireAt)) return { error: translate('error.reminderInvalidTime') }
    if (this.store[WRITE_BLOCK_REASON] !== undefined) return { error: translate('error.reminderStorageReadOnly', { reason: this.store[WRITE_BLOCK_REASON] }) }
    const pending = this.store.items.filter((item) => item.accountId === plan.accountId)
    if (pending.length >= MAX_PENDING_PER_ACCOUNT) return { error: `这个账号的待发提醒太多了（最多 ${MAX_PENDING_PER_ACCOUNT} 条），先用 /remindlist 看，/remindcancel 删掉一些` }
    const previousSeq = this.store.seq
    const ids = new Set(this.store.items.map((item) => item.id))
    const nextSeq = nextReminderSequence(previousSeq, ids)
    if (nextSeq === undefined) return { error: translate('error.reminderSequenceExhausted') }
    this.store.seq = nextSeq
    const id = `r${nextSeq}`
    const reminder = {
      id,
      accountId: plan.accountId,
      conversationId: plan.conversationId,
      text,
      fireAt: plan.fireAt,
      createdAt: new Date(this.nowRef()).toISOString(),
      ...(plan.recurrence === undefined
        ? {}
        : {
            recurrence: plan.recurrence,
            recurrenceLabel: plan.recurrenceLabel ?? '',
            hour: plan.hour,
            minute: plan.minute,
            scheduledFor: plan.fireAt,
          }),
    }
    this.store.items.push(reminder)
    if (!this.#persist()) {
      this.store.items.pop()
      this.store.seq = previousSeq
      return { error: translate('error.reminderWriteFailed') }
    }
    this.#arm(reminder)
    return reminder
  }

  /**
   * Remove one pending reminder by id (as shown by /remindlist).
   * Pass accountId for WeChat commands; omit it for desktop management.
   * @returns {boolean} whether an item was actually removed
   */
  cancel(id, accountId) {
    const index = this.store.items.findIndex((item) => item.id === id && (accountId === undefined || item.accountId === accountId))
    if (index === -1) return false
    const [item] = this.store.items.splice(index, 1)
    if (!this.#persist()) {
      this.store.items.splice(index, 0, item)
      return false
    }
    this.#clearTimer(id)
    this.retryAttempts.delete(id)
    this.pendingAttempts.delete(id)
    return true
  }

  /**
   * Push the soonest pending reminder later by `minutes` (the `/snooze` command).
   * A recurring reminder shifts its `scheduledFor` too, so the next cycle is
   * counted from the snoozed moment instead of re-firing the skipped slot.
   *
   * @param {string} accountId
   * @param {number} minutes
   * @param {number} [now]
   * @returns {Reminder | undefined} the item, or undefined when nothing is pending
   */
  snooze(accountId, minutes, now = this.nowRef()) {
    return this.snoozeById(this.list(accountId)[0]?.id, minutes, now)
  }

  /**
   * Same shift, addressed by id: `/remindlist` numbers each pending reminder so
   * 「第 3 条往后推一小时」 does not need the user to first work out which one is
   * soonest. Returns undefined when the id is unknown.
   *
   * @param {string | undefined} id
   * @param {number} minutes
   * @param {number} [now]
   * @returns {Reminder | undefined}
   */
  snoozeById(id, minutes, now = this.nowRef()) {
    const item = this.store.items.find((entry) => entry.id === id)
    if (item === undefined) return undefined
    const span = Math.max(1, Math.round(minutes)) * 60_000
    const previousFireAt = item.fireAt
    const previousScheduledFor = item.scheduledFor
    const base = Math.max(item.fireAt, now)
    item.fireAt = base + span
    if (item.recurrence !== undefined) item.scheduledFor = item.fireAt
    if (!this.#persist()) {
      item.fireAt = previousFireAt
      if (previousScheduledFor === undefined) delete item.scheduledFor
      else item.scheduledFor = previousScheduledFor
      return undefined
    }
    this.#clearTimer(item.id)
    this.retryAttempts.delete(item.id)
    this.#arm(item)
    return item
  }

  /**
   * Skip the next occurrence of the soonest recurring reminder (`/remind skip`).
   * One-off reminders are not skipped: dropping one is `cancel`.
   *
   * @param {string} accountId
   * @returns {Reminder | undefined} the item now pointing at the following slot
   */
  skipNext(accountId) {
    const item = this.list(accountId).find((entry) => entry.recurrence !== undefined)
    if (item === undefined) return undefined
    const base = item.scheduledFor ?? item.fireAt
    const next = nextRecurrenceAt(item.recurrence, Number(item.hour ?? 0), Number(item.minute ?? 0), base)
    const previousFireAt = item.fireAt
    const previousScheduledFor = item.scheduledFor
    item.scheduledFor = next
    item.fireAt = next
    if (!this.#persist()) {
      item.fireAt = previousFireAt
      if (previousScheduledFor === undefined) delete item.scheduledFor
      else item.scheduledFor = previousScheduledFor
      return undefined
    }
    this.#clearTimer(item.id)
    this.retryAttempts.delete(item.id)
    this.#arm(item)
    return item
  }

  /**
   * Pending reminders, soonest first. Optionally narrowed to one account.
   * @returns {Reminder[]}
   */
  list(accountId) {
    const items = accountId === undefined ? [...this.store.items] : this.store.items.filter((item) => item.accountId === accountId)
    return items.sort((a, b) => a.fireAt - b.fireAt)
  }

  /**
   * Retry every due item for an account immediately. Called after a transport
   * becomes live so a startup or reconnect does not wait for the next backoff.
   */
  wake(accountId) {
    if (this.stopped || this.store[WRITE_BLOCK_REASON] !== undefined) return
    const now = this.nowRef()
    for (const item of this.store.items) {
      if (item.accountId !== accountId || item.fireAt > now) continue
      if (this.inFlight.has(item.id)) {
        this.pendingAttempts.add(item.id)
        continue
      }
      this.retryAttempts.delete(item.id)
      this.#arm(item, now)
    }
  }

  /** Stop every timer without waiting for an in-flight network/model call. */
  stop() {
    this.stopped = true
    for (const timer of this.timers.values()) timer.cancel()
    this.timers.clear()
    this.retryAttempts.clear()
    this.pendingAttempts.clear()
    this.inFlight.clear()
  }

  #clearTimer(id) {
    const timer = this.timers.get(id)
    if (timer === undefined) return
    timer.cancel()
    this.timers.delete(id)
  }

  /**
   * Persist a state transition. Once a write fails, stop every automatic timer
   * for this process rather than sending more work whose completion cannot be
   * durably committed.
   */
  #persist() {
    if (this.store[WRITE_BLOCK_REASON] !== undefined) {
      this.warn(`refusing to write reminders.json: ${this.store[WRITE_BLOCK_REASON]}`)
      return false
    }
    if (writeReminders(this.stateRoot, this.store, this.warn)) return true
    const reason = 'the last reminders.json write failed'
    Object.defineProperty(this.store, WRITE_BLOCK_REASON, { value: reason })
    for (const timer of this.timers.values()) timer.cancel()
    this.timers.clear()
    this.retryAttempts.clear()
    this.pendingAttempts.clear()
    this.warn(`automatic reminder delivery is disabled after a persistence failure: ${reason}`)
    return false
  }

  /**
   * Arm one reminder's timer. Overdue ones fire right away rather than being
   * dropped: the host was probably down or reloading when their moment
   * passed, and the user asked for the message, not for its punctuality.
   */
  #arm(reminder, dueAt = reminder.fireAt) {
    if (this.stopped || this.store[WRITE_BLOCK_REASON] !== undefined) return
    this.#clearTimer(reminder.id)
    let timer
    timer = armLongTimer({
      dueAt,
      nowRef: this.nowRef,
      setTimeoutRef: this.setTimeoutRef,
      clearTimeoutRef: this.clearTimeoutRef,
      callback: () => {
        if (this.timers.get(reminder.id) !== timer) return
        this.timers.delete(reminder.id)
        const now = this.nowRef()
        const quietMs = this.quiet === null ? 0 : this.quiet(now, reminder.accountId)
        if (quietMs > 0) {
          // 免打扰时段: the item was not removed yet — keep it in the store with
          // a pushed fireAt so it survives a restart, then re-arm for the end.
          const previousFireAt = reminder.fireAt
          reminder.fireAt = now + quietMs
          if (!this.#persist()) {
            reminder.fireAt = previousFireAt
            return
          }
          this.warn(`免打扰时段，提醒 ${reminder.id} 推迟到 ${new Date(reminder.fireAt).toLocaleString('zh-CN', { hour12: false })} 发送`)
          this.#arm(reminder)
          return
        }
        void this.#attempt(reminder)
      },
    })
    this.timers.set(reminder.id, timer)
  }

  async #attempt(reminder) {
    if (this.stopped || this.store[WRITE_BLOCK_REASON] !== undefined) return
    if (this.inFlight.has(reminder.id)) {
      this.pendingAttempts.add(reminder.id)
      return
    }
    // Prove the completion can be committed before sending. A persistently
    // read-only store must not deliver once per restart merely because the row
    // it cannot clear remains on disk.
    if (!this.#persist()) return
    const attemptedFireAt = reminder.fireAt
    const slot = reminder.scheduledFor ?? reminder.fireAt
    const task = (async () => {
      try {
        await this.fire(reminder)
      } catch (error) {
        if (this.stopped || this.store[WRITE_BLOCK_REASON] !== undefined) return
        const current = this.store.items.find((item) => item.id === reminder.id)
        if (current === undefined || current.fireAt !== attemptedFireAt) return
        if (current.recurrence !== undefined && (current.scheduledFor ?? current.fireAt) !== slot) return
        const attempts = (this.retryAttempts.get(reminder.id) ?? 0) + 1
        this.retryAttempts.set(reminder.id, attempts)
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 5))
        this.warn(`reminder ${reminder.id} send failed; retrying in ${delay}ms: ${String(error?.message ?? error)}`)
        this.#arm(current, this.nowRef() + delay)
        return
      }
      if (this.stopped || this.store[WRITE_BLOCK_REASON] !== undefined) return
      this.retryAttempts.delete(reminder.id)
      const current = this.store.items.find((item) => item.id === reminder.id)
      if (current === undefined) return
      if (current.fireAt !== attemptedFireAt) return
      if (current.recurrence === undefined) {
        // A snooze or skip during delivery changes fireAt; cancellation removes
        // the row. In either case the user's newer state wins over this ack.
        const index = this.store.items.findIndex((item) => item.id === reminder.id)
        const [delivered] = this.store.items.splice(index, 1)
        if (!this.#persist()) this.store.items.splice(index, 0, delivered)
        return
      }
      if ((current.scheduledFor ?? current.fireAt) !== slot) return
      const next = nextRecurrenceAt(current.recurrence, Number(current.hour ?? 0), Number(current.minute ?? 0), slot)
      const previousScheduledFor = current.scheduledFor
      current.scheduledFor = next
      current.fireAt = next
      if (!this.#persist()) {
        if (previousScheduledFor === undefined) delete current.scheduledFor
        else current.scheduledFor = previousScheduledFor
        current.fireAt = attemptedFireAt
        return
      }
      this.#arm(current)
    })().finally(() => {
      if (this.inFlight.get(reminder.id) === task) this.inFlight.delete(reminder.id)
      if (!this.pendingAttempts.delete(reminder.id) || this.stopped) return
      const current = this.store.items.find((item) => item.id === reminder.id)
      if (current !== undefined) this.#arm(current)
    })
    this.inFlight.set(reminder.id, task)
    await task
  }
}
