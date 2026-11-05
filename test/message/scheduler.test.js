import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWhen } from '../../src/message/scheduler.js'

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
