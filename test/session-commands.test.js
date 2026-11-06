import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCommandsHelp, commandIds, isInterruptCommand, parseSessionCommand, runSessionCommand } from '../src/sessions.js'
import { createTranslator } from '../src/i18n.js'

const core = ['new', 'list', 'use', 'clear', 'cancel', 'compact', 'status', 'send', 'help']
const removed = ['diag', 'outbox', 'quiet', 'snooze', 'media', 'usage', 'remind', 'remindlist', 'remindcancel', 'subscribe', 'subscribelist', 'subscribecancel', 'export', 'backup', 'config', 'steer']

test('only the nine core command types are registered', () => {
  assert.deepEqual(commandIds().sort(), [...core].sort())
  for (const input of removed) {
    assert.equal(parseSessionCommand(`/${input}`)?.command, 'unknown_slash', input)
    assert.equal(parseSessionCommand(`/${input} argument`)?.command, 'unknown_slash', input)
  }
  for (const input of ['/订阅 每天 09:00', '/导出 3']) {
    assert.equal(parseSessionCommand(input)?.command, 'unknown_slash')
  }
})

test('core commands parse arguments and established aliases', () => {
  const cases = [
    ['/new', { command: 'new' }],
    ['/NEW 写周报', { command: 'new', arg: '写周报' }],
    ['/list', { command: 'list' }],
    ['/sessions', { command: 'list' }],
    ['/use 2', { command: 'use', index: 2 }],
    ['/use', { command: 'use', index: undefined }],
    ['/clear', { command: 'clear' }],
    ['/cancel', { command: 'cancel' }],
    ['/取消', { command: 'cancel' }],
    ['/compact', { command: 'compact', arg: '' }],
    ['/压缩 继续', { command: 'compact', arg: '继续' }],
    ['/status', { command: 'status' }],
    ['/send report.pdf', { command: 'send', arg: 'report.pdf' }],
    ['/send', { command: 'send', arg: '' }],
    ['/help', { command: 'help', all: false }],
    ['/help all', { command: 'help', all: true }],
    ['/帮助', { command: 'help', all: false }],
  ]
  for (const [input, expected] of cases) assert.deepEqual(parseSessionCommand(input), expected, input)
  assert.equal(isInterruptCommand('/取消'), true)
  assert.equal(isInterruptCommand('/cancel now'), false)
  assert.equal(parseSessionCommand('帮我看下这段代码'), undefined)
  assert.equal(parseSessionCommand('/newer')?.command, 'unknown_slash')
})

test('help lists the core commands without removed features', () => {
  for (const locale of ['zh', 'en']) {
    const t = createTranslator(locale).t
    for (const all of [false, true]) {
      const text = buildCommandsHelp(t, { all })
      for (const name of core) assert.match(text, new RegExp(`/${name}\\b`), `${locale} /${name}`)
      for (const name of removed) assert.doesNotMatch(text, new RegExp(`/${name}\\b`), `${locale} /${name}`)
    }
  }
})

test('removed and unknown commands return unknown without calling the host', () => {
  let called = false
  for (const input of ['/diag', '/remind 10m test', '/subscribe 每天', '/usage', '/export', '/unknown']) {
    const reply = runSessionCommand(undefined, 'chat', input, 'account', {
      executeHostCommand: () => { called = true },
      persona: { diag: () => { called = true } },
    })
    assert.match(reply, /^未知指令：/)
  }
  assert.equal(called, false)
})

test('/new, /list, /use and /clear act on the selected account and conversation', () => {
  const calls = []
  const lines = {
    create: (...args) => { calls.push(['create', ...args]); return 'new-id' },
    title: (...args) => calls.push(['title', ...args]),
    list: (...args) => { calls.push(['list', ...args]); return [{ sessionId: 'new-id', title: '周报' }] },
    render: (...args) => { calls.push(['render', ...args]); return 'TOPICS' },
    use: (...args) => { calls.push(['use', ...args]); return args[1] === 1 ? 'new-id' : undefined },
    clear: (...args) => calls.push(['clear', ...args]),
  }
  assert.match(runSessionCommand(lines, 'chat', '/new 周报', 'account'), /已开启第 1 个话题/)
  assert.deepEqual(calls[0], ['create', 'chat', 'account'])
  assert.deepEqual(calls[1], ['title', 'chat', 'new-id', '周报', 'account'])
  assert.equal(runSessionCommand(lines, 'chat', '/list', 'account'), 'TOPICS')
  assert.match(runSessionCommand(lines, 'chat', '/use 1', 'account'), /第 1 个话题：周报/)
  assert.match(runSessionCommand(lines, 'chat', '/use 2', 'account'), /没有第 2 个话题/)
  assert.match(runSessionCommand(lines, 'chat', '/use', 'account'), /用法：\/use/)
  assert.match(runSessionCommand(lines, 'chat', '/clear', 'account'), /DSH 里原来的会话历史仍会保留/)
  assert.deepEqual(calls.at(-1), ['clear', 'chat', 'account'])
})

test('/status shows current topic and effective account information', () => {
  const lines = { list: () => [{ sessionId: 'session-1', title: '整理周报' }], active: () => 'session-1' }
  const reply = runSessionCommand(lines, 'chat', '/status', 'account', {
    accountId: 'account', allowlist: { source: 'account', senders: ['owner'] },
  })
  assert.match(reply, /可对话联系人：1 人（本账号专属名单）/)
  assert.match(reply, /1 个话题/)
})

test('/cancel and /compact use the bridge hooks or report unavailable', async () => {
  assert.equal(runSessionCommand(undefined, 'chat', '/cancel', 'account', { cancelRunningTurn: () => 'requested' }), 'requested')
  assert.equal(await runSessionCommand(undefined, 'chat', '/compact now', 'account', { compactSession: arg => `compact: ${arg}` }), 'compact: now')
  assert.match(runSessionCommand(undefined, 'chat', '/cancel', 'account', {}), /没有提供停止功能/)
  assert.match(runSessionCommand(undefined, 'chat', '/compact', 'account', {}), /支持“压缩会话”的 DSH 版本/)
})

test('/send delegates only to the supplied authorized handler', async () => {
  const calls = []
  const reply = await runSessionCommand(undefined, 'chat', '/send report.pdf', 'account', {
    persona: { send: async arg => { calls.push(arg); return 'sent' } },
  })
  assert.equal(reply, 'sent')
  assert.deepEqual(calls, ['report.pdf'])
  assert.match(runSessionCommand(undefined, 'chat', '/send report.pdf', 'account', {}), /用不了/)
})
