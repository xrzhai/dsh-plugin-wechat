import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionCommand, commandIds } from '../src/sessions.js'

test('控制命令能被正确解析', () => {
  assert.deepEqual(parseSessionCommand('/new'), { command: 'new' })
  assert.deepEqual(parseSessionCommand('/NEW'), { command: 'new' })
  assert.deepEqual(parseSessionCommand('/list'), { command: 'list' })
  assert.deepEqual(parseSessionCommand('/sessions'), { command: 'list' })
  assert.deepEqual(parseSessionCommand('/use 2'), { command: 'use', index: 2 })
  assert.deepEqual(parseSessionCommand('/use'), { command: 'use', index: undefined })
  assert.deepEqual(parseSessionCommand('/clear'), { command: 'clear' })
  assert.deepEqual(parseSessionCommand('/compact'), { command: 'compact', arg: '' })
  assert.deepEqual(parseSessionCommand('/压缩 继续'), { command: 'compact', arg: '继续' })
})

test('/new 必须是单独一条命令', () => {
  const parsed = parseSessionCommand('/new 帮我')
  assert.equal(parsed?.command, 'unknown_slash')
  assert.equal(parsed?.name, 'new')
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

test('commandIds 覆盖会话管理命令', () => {
  const ids = commandIds()
  for (const id of ['new', 'list', 'use', 'clear', 'cancel', 'compact']) {
    assert.ok(ids.includes(id), `commandIds 缺少 ${id}`)
  }
})
