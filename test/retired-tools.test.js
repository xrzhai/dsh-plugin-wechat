import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentBridge } from '../src/agent-bridge.js'
import { Config } from '../src/index.js'
import { createTranslator } from '../src/i18n.js'
import { buildCommandsHelp, parseSessionCommand, scopedLineKey } from '../src/sessions.js'

const retired = ['draft', 'keyword', 'away', 'back', 'todo', 'habit', 'later', 'say']

test('retired plugin commands are not forwarded to the host', async (t) => {
  const received = []
  const agent = { session: { id: 'retired-command-session', snapshotEvents: () => [] } }
  const commands = {
    execute: async (target, raw) => {
      assert.equal(target, agent)
      received.push(raw)
      return { result: { text: `host accepted ${raw}` } }
    },
  }
  const bridge = new AgentBridge({
    ctx: { get: (name) => name === 'commands' ? commands : undefined },
    lines: { active: () => agent.session.id },
    log: () => {},
    errLog: () => {},
  })
  t.after(() => bridge.dispose())
  bridge.sessions.set(agent.session.id, {
    agent, conversationId: 'chat', accountId: 'account', lastDeliveredSeq: 0,
    busy: false, spontaneousSending: false, dispose: async () => {},
  })
  bridge.conversationTargets.set(scopedLineKey('account', 'chat'), agent.session.id)
  for (const name of retired) {
    const raw = `/${name} synthetic argument`
    assert.deepEqual(parseSessionCommand(raw), { command: 'unknown_slash', raw, name })
    assert.match(await bridge.handleCommand('chat', raw, 'account'), /^未知指令：/)
  }
  assert.deepEqual(received, [])
})

for (const locale of ['zh', 'en']) {
  test(`${locale} help and complete help contain only supported commands`, () => {
    const translate = createTranslator(locale).t
    const core = buildCommandsHelp(translate)
    const all = buildCommandsHelp(translate, { all: true })
    for (const command of ['new', 'list', 'use', 'clear', 'cancel', 'compact', 'status', 'send', 'outbox', 'help']) {
      assert.match(core, new RegExp(`/${command}\\b`))
      assert.match(all, new RegExp(`/${command}\\b`))
    }
    for (const command of ['remind', 'subscribe', 'diag']) {
      assert.doesNotMatch(core, new RegExp(`/${command}\\b`))
      assert.doesNotMatch(all, new RegExp(`/${command}\\b`))
    }
    for (const command of retired) {
      assert.doesNotMatch(all, new RegExp(`/${command}\\b`))
      assert.doesNotMatch(core, new RegExp(`/${command}\\b`))
    }
  })
}

test('retired voice synthesis and away reply switches are absent from the schema', () => {
  for (const key of ['ttsVoice', 'awayAutoReply']) {
    assert.equal(Object.hasOwn(Config.dict, key), false)
  }
})
