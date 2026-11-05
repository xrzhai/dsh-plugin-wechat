import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWhen } from '../../src/message/scheduler.js'
import { parseSubscriptionWhen } from '../../src/message/subscriptions.js'

const WEEKDAYS = [
  ['一', 9],
  ['二', 10],
  ['三', 11],
  ['四', 12],
  ['五', 13],
  ['六', 14],
  ['日', 15],
]

test('下周星期几始终落在下一个自然周，覆盖周一与周日边界及有无钟点', () => {
  const boundaries = [
    ['周一', new Date(2026, 10, 2, 18, 20)],
    ['周日', new Date(2026, 10, 8, 18, 20)],
  ]
  for (const [boundaryName, now] of boundaries) {
    for (const [weekday, day] of WEEKDAYS) {
      for (const [clock, hour] of [['', 9], [' 10点', 10]]) {
        const parsed = parseWhen(`下周${weekday}${clock}`, now)
        assert.equal(parsed.ok, true, `${boundaryName}的下周${weekday}${clock}应能解析`)
        assert.equal(parsed.fireAt, new Date(2026, 10, day, hour, 0, 0, 0).getTime())
      }
    }
  }
})

test('裸星期几始终取最近未来时刻，覆盖整周与有无钟点', () => {
  const now = new Date(2026, 10, 5, 18, 20)
  const expectedDays = new Map([
    ['一', 9],
    ['二', 10],
    ['三', 11],
    ['四', 12],
    ['五', 6],
    ['六', 7],
    ['日', 8],
  ])
  for (const [weekday, day] of expectedDays) {
    for (const [clock, hour] of [['', 9], [' 10点', 10]]) {
      const parsed = parseWhen(`周${weekday}${clock}`, now)
      assert.equal(parsed.ok, true, `周${weekday}${clock}应能解析`)
      assert.equal(parsed.fireAt, new Date(2026, 10, day, hour, 0, 0, 0).getTime())
    }
  }
})

test('绝对日期会先拒绝非法小时和分钟，不让 Date 自动进位', () => {
  const now = new Date(2026, 10, 5, 18, 20)
  for (const spec of ['2026-11-06 25:00', '2026-11-06 10:99']) {
    const parsed = parseWhen(spec, now)
    assert.equal(parsed.ok, false, spec)
    assert.match(parsed.reason, /^时间格式应为 HH:mm/, spec)
  }
})

test('晚间 12 点跨到当晚结束的零点，并覆盖午夜、日间和星期边界', () => {
  const now = new Date(2026, 10, 5, 18, 20)
  const cases = [
    ['今晚12点', new Date(2026, 10, 6, 0, 0)],
    ['明晚12点', new Date(2026, 10, 7, 0, 0)],
    ['今晚11点', new Date(2026, 10, 5, 23, 0)],
    ['明晚11点', new Date(2026, 10, 6, 23, 0)],
    ['晚上12点', new Date(2026, 10, 6, 0, 0)],
    ['明天凌晨12点', new Date(2026, 10, 6, 0, 0)],
    ['明天中午12点', new Date(2026, 10, 6, 12, 0)],
    ['周五晚上12点', new Date(2026, 10, 7, 0, 0)],
    ['周一凌晨12点', new Date(2026, 10, 9, 0, 0)],
    ['周日中午12点', new Date(2026, 10, 8, 12, 0)],
  ]

  for (const [spec, expected] of cases) {
    const parsed = parseWhen(spec, now)
    assert.equal(parsed.ok, true, spec)
    assert.equal(parsed.fireAt, expected.getTime(), spec)
  }
})

test('显式时段优先于今晚明晚的推测，冲突写法不会重复改小时', () => {
  const now = new Date(2026, 10, 5, 18, 20)
  const cases = [
    ['明晚上午10点', new Date(2026, 10, 6, 10, 0)],
    ['明晚中午12点', new Date(2026, 10, 6, 12, 0)],
    ['明晚凌晨12点', new Date(2026, 10, 6, 0, 0)],
  ]

  for (const [spec, expected] of cases) {
    const parsed = parseWhen(spec, now)
    assert.equal(parsed.ok, true, spec)
    assert.equal(parsed.fireAt, expected.getTime(), spec)
  }
})

test('一次性订阅沿用修正后的提醒时间解析器', () => {
  const now = new Date(2026, 10, 5, 18, 20)
  const cases = [
    ['今晚12点', new Date(2026, 10, 6, 0, 0)],
    ['明晚12点', new Date(2026, 10, 7, 0, 0)],
    ['明晚11点', new Date(2026, 10, 6, 23, 0)],
  ]

  for (const [spec, expected] of cases) {
    const parsed = parseSubscriptionWhen(spec, now)
    assert.equal(parsed.ok, true, spec)
    assert.equal(parsed.kind, 'once', spec)
    assert.equal(parsed.fireAt, expected.getTime(), spec)
  }
})
