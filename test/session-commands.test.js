import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionCommand, commandIds, runSessionCommand } from '../src/sessions.js'
import { createTranslator } from '../src/i18n.js'

function captureReminder(arg) {
  let plan
  const reminders = {
    schedule(value) {
      plan = value
      return { id: 'r1' }
    },
  }
  const reply = runSessionCommand(undefined, 'conversation', `/remind ${arg}`, 'account', { reminders })
  return { plan, reply }
}

function captureSubscription(text) {
  let plan
  const subscription = {
    schedule(value) {
      plan = value
      return { id: 's1', ...value.when }
    },
  }
  const reply = runSessionCommand(undefined, 'conversation', text, 'account', { subscription })
  return { plan, reply }
}

function localStamp(daysFromNow, hour, minute) {
  const date = new Date()
  date.setDate(date.getDate() + daysFromNow)
  date.setHours(hour, minute, 0, 0)
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date,
    text: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(minute)}`,
  }
}

test('控制命令能被正确解析', () => {
  assert.deepEqual(parseSessionCommand('/new'), { command: 'new' })
  assert.deepEqual(parseSessionCommand('/new 写周报'), { command: 'new', arg: '写周报' })
  assert.deepEqual(parseSessionCommand('/NEW'), { command: 'new' })
  assert.deepEqual(parseSessionCommand('/list'), { command: 'list' })
  assert.deepEqual(parseSessionCommand('/sessions'), { command: 'list' })
  assert.deepEqual(parseSessionCommand('/use 2'), { command: 'use', index: 2 })
  assert.deepEqual(parseSessionCommand('/use'), { command: 'use', index: undefined })
  assert.deepEqual(parseSessionCommand('/clear'), { command: 'clear' })
  assert.deepEqual(parseSessionCommand('/compact'), { command: 'compact', arg: '' })
  assert.deepEqual(parseSessionCommand('/压缩 继续'), { command: 'compact', arg: '继续' })
})

test('/new 的标题参数可选，且不会吞掉其他 new 前缀指令', () => {
  assert.deepEqual(parseSessionCommand('/new 写周报'), { command: 'new', arg: '写周报' })
  const parsed = parseSessionCommand('/newer')
  assert.equal(parsed?.command, 'unknown_slash')
  assert.equal(parsed?.name, 'newer')
})

test('未知斜杠指令会被拦截而不是当普通消息', () => {
  const parsed = parseSessionCommand('/不存在的指令')
  assert.equal(parsed?.command, 'unknown_slash')
  assert.equal(parsed?.name, '不存在的指令')
})

test('普通文本不是命令', () => {
  assert.equal(parseSessionCommand('你好呀'), undefined)
  assert.equal(parseSessionCommand('帮我看下这段代码'), undefined)
})

test('/subscribe 保留完整命令参数，且不会吞掉订阅管理命令', () => {
  assert.deepEqual(parseSessionCommand('/subscribe 2026-11-01 09:00 主题'), {
    command: 'subscribe',
    arg: '2026-11-01 09:00 主题',
  })
  assert.deepEqual(parseSessionCommand('/subscribe'), { command: 'subscribe', arg: '' })
  assert.deepEqual(parseSessionCommand('/subscribelist'), { command: 'subscribelist' })
  assert.deepEqual(parseSessionCommand('/subscribecancel s1'), { command: 'subscribecancel', id: 's1' })
})

test('commandIds 覆盖会话管理命令', () => {
  const ids = commandIds()
  for (const id of ['new', 'list', 'use', 'clear', 'cancel', 'compact']) {
    assert.ok(ids.includes(id), `commandIds 缺少 ${id}`)
  }
})

test('/clear explains that the WeChat topic list resets while DSH history remains', () => {
  let cleared = false
  const reply = runSessionCommand({
    clear() { cleared = true },
  }, 'conversation', '/clear', 'account', {})

  assert.equal(cleared, true)
  assert.match(reply, /^已从当前微信聊天的话题列表移除所有话题，并新开一个。/)
  assert.match(reply, /DSH 里原来的会话历史仍会保留/)
  assert.doesNotMatch(reply, /当前会话/)
})

test('/status names the effective contact list without internal allowlist jargon', () => {
  const reply = runSessionCommand({
    list: () => [{ sessionId: 'session-1', title: '整理周报' }],
    active: () => 'session-1',
  }, 'conversation', '/status', 'account', {
    accountId: 'account',
    allowlist: { source: 'account', senders: ['owner'] },
  })

  assert.match(reply, /可对话联系人：1 人（本账号专属名单）/)
  assert.match(reply, /1 个话题/)
  assert.doesNotMatch(reply, /发信人白名单|会话线/)
})

test('/remind 优先采用最长可解析时间，星期和钟点不会被吞进正文', () => {
  for (const arg of ['周五 10点 开会', '下周一 10点 开会']) {
    const { plan } = captureReminder(arg)
    const fireAt = new Date(plan.fireAt)
    assert.equal(fireAt.getDay(), arg.startsWith('下周一') ? 1 : 5)
    assert.equal(fireAt.getHours(), 10)
    assert.equal(fireAt.getMinutes(), 0)
    assert.equal(plan.text, '开会')
  }
})

test('/remind 裸星期几仍使用 09:00，正文中的时间词完整保留', () => {
  const bare = captureReminder('周五 开会 10点')
  assert.equal(new Date(bare.plan.fireAt).getDay(), 5)
  assert.equal(new Date(bare.plan.fireAt).getHours(), 9)
  assert.equal(bare.plan.text, '开会 10点')

  const duration = captureReminder('10m 9点 开会')
  assert.equal(duration.plan.text, '9点 开会')
})

test('/remind 和 /subscribe 不会把日期后的非法钟点静默回退', () => {
  const tomorrow = localStamp(1, 9, 0).text.slice(0, 10)
  const cases = [
    ['/remind 周五 25点 周报', () => captureReminder('周五 25点 周报')],
    ['/remind 周五 10:99 周报', () => captureReminder('周五 10:99 周报')],
    ['/remind 2099-01-01 25:00 周报', () => captureReminder('2099-01-01 25:00 周报')],
    [`/remind ${tomorrow} 10:99 周报`, () => captureReminder(`${tomorrow} 10:99 周报`)],
    ['/subscribe 周五 25点 周报', () => captureSubscription('/subscribe 周五 25点 周报')],
    ['/subscribe 周五 10:99 周报', () => captureSubscription('/subscribe 周五 10:99 周报')],
    ['/subscribe 2099-01-01 25:00 周报', () => captureSubscription('/subscribe 2099-01-01 25:00 周报')],
    [`/subscribe ${tomorrow} 10:99 周报`, () => captureSubscription(`/subscribe ${tomorrow} 10:99 周报`)],
  ]
  for (const [text, capture] of cases) {
    const { plan, reply } = capture()
    assert.equal(plan, undefined, text)
    assert.match(reply, /^没有安排：时间格式应为/, text)
  }
})

test('/remind 和 /subscribe 的裸星期五仍保留非时间正文', () => {
  const reminder = captureReminder('周五 25号交周报')
  assert.equal(new Date(reminder.plan.fireAt).getDay(), 5)
  assert.equal(new Date(reminder.plan.fireAt).getHours(), 9)
  assert.equal(reminder.plan.text, '25号交周报')

  const subscription = captureSubscription('/subscribe 周五 25号交周报')
  assert.equal(new Date(subscription.plan.when.fireAt).getDay(), 5)
  assert.equal(new Date(subscription.plan.when.fireAt).getHours(), 9)
  assert.equal(subscription.plan.prompt, '25号交周报')

  const withClockInTopic = captureSubscription('/subscribe 周五 周报 10点发出')
  assert.equal(new Date(withClockInTopic.plan.when.fireAt).getHours(), 9)
  assert.equal(withClockInTopic.plan.prompt, '周报 10点发出')
})

test('/subscribe 把完整的每天/每周时间交给调度器，主题保持完整', () => {
  const daily = captureSubscription('/subscribe 每天 08:00 早安，问问我睡得怎么样')
  assert.equal(daily.plan.when.kind, 'daily')
  assert.equal(daily.plan.when.time, '08:00')
  assert.equal(daily.plan.prompt, '早安，问问我睡得怎么样')

  const weekly = captureSubscription('/subscribe 每周日 21:30 复盘本周')
  assert.equal(weekly.plan.when.kind, 'weekly')
  assert.equal(weekly.plan.when.weekday, 7)
  assert.equal(weekly.plan.when.time, '21:30')
  assert.equal(weekly.plan.prompt, '复盘本周')
})

test('/subscribe 接受绝对日期和中文多 token 时间，正文时间词不会丢', () => {
  const expected = localStamp(1, 9, 0)
  const absolute = captureSubscription(`/subscribe ${expected.text} 主题 10:00 再提醒`)
  assert.equal(absolute.plan.when.kind, 'once')
  assert.equal(absolute.plan.when.fireAt, expected.date.getTime())
  assert.equal(absolute.plan.prompt, '主题 10:00 再提醒')

  const relative = captureSubscription('/subscribe 明天 9:00 主题')
  assert.equal(relative.plan.when.kind, 'once')
  assert.equal(relative.plan.when.fireAt, expected.date.getTime())
  assert.equal(relative.plan.prompt, '主题')

  const chinese = captureSubscription('/subscribe 周五 10点 周报 9点前发出')
  const fireAt = new Date(chinese.plan.when.fireAt)
  assert.equal(chinese.plan.when.kind, 'once')
  assert.equal(fireAt.getDay(), 5)
  assert.equal(fireAt.getHours(), 10)
  assert.equal(fireAt.getMinutes(), 0)
  assert.equal(chinese.plan.prompt, '周报 9点前发出')
})

test('/subscribe 接受单 token 时间和时长', () => {
  const clock = captureSubscription('/subscribe 09:00 早安')
  assert.equal(clock.plan.when.kind, 'daily')
  assert.equal(clock.plan.when.time, '09:00')
  assert.equal(clock.plan.prompt, '早安')

  const duration = captureSubscription('/subscribe 10m 主题')
  assert.equal(duration.plan.when.kind, 'once')
  assert.equal(duration.plan.prompt, '主题')
})

test('/subscribe 缺少主题或时间无效时不会创建订阅', () => {
  for (const text of ['/subscribe', '/subscribe 每天 08:00', '/subscribe 周五 10点', '/subscribe 10m']) {
    const missing = captureSubscription(text)
    assert.equal(missing.plan, undefined)
    assert.match(missing.reply, /用法：\/subscribe/)
  }

  for (const text of ['/subscribe 不是时间 主题', '/subscribe 2026-02-30 09:00 主题']) {
    const invalid = captureSubscription(text)
    assert.equal(invalid.plan, undefined)
    assert.match(invalid.reply, /^没有安排：/)
  }
})

test('reminder mutation replies do not confuse missing rows with failed persistence', () => {
  const now = Date.now()
  const cases = [
    ['/remind skip', { skipNext: () => undefined }],
    ['/snooze 10m', { snooze: () => undefined }],
    ['/remindcancel r1', { cancel: () => false }],
    ['/remindlist 2 1h', {
      list: () => [
        { id: 'r1', fireAt: now + 60_000 },
        { id: 'r2', fireAt: now + 120_000 },
      ],
      snoozeById: () => undefined,
    }],
  ]

  for (const [text, reminders] of cases) {
    const reply = runSessionCommand(undefined, 'conversation', text, 'account', { reminders })
    assert.match(reply, /可能没有找到合适的提醒，也可能刚才的改动没能保存/, text)
    assert.match(reply, /\/remindlist/, text)
    assert.doesNotMatch(reply, /没有找到编号|没有待发的提醒/, text)
  }

  const english = runSessionCommand(undefined, 'conversation', '/remindcancel r1', 'account', {
    reminders: { cancel: () => false },
    t: createTranslator('en').t,
  })
  assert.match(english, /^Could not cancel reminder r1/)
  assert.match(english, /may no longer exist/)
  assert.match(english, /\/remindlist/)
})

test('unavailable service copy makes no unsupported recovery promises', () => {
  const reminder = runSessionCommand(undefined, 'conversation', '/remind 10m test', 'account', {})
  assert.match(reminder, /提醒服务现在没有准备好/)
  assert.doesNotMatch(reminder, /调度器|写盘/)

  const cancel = runSessionCommand(undefined, 'conversation', '/cancel', 'account', {})
  assert.match(cancel, /当前 DSH 环境没有提供停止功能/)
  assert.doesNotMatch(cancel, /重启/)
  assert.doesNotMatch(cancel, /排队.*继续/)

  const compact = runSessionCommand(undefined, 'conversation', '/compact', 'account', {})
  assert.match(compact, /支持“压缩会话”的 DSH 版本/)
  assert.doesNotMatch(compact, /重启/)

  const english = runSessionCommand(undefined, 'conversation', '/remind 10m test', 'account', {
    t: createTranslator('en').t,
  })
  assert.match(english, /^The reminder service is not ready/)

  const cancelEnglish = runSessionCommand(undefined, 'conversation', '/cancel', 'account', {
    t: createTranslator('en').t,
  })
  assert.match(cancelEnglish, /DSH environment does not provide cancellation/)
  assert.doesNotMatch(cancelEnglish, /restart/i)
  assert.doesNotMatch(cancelEnglish, /queued messages will still be processed/i)
})
