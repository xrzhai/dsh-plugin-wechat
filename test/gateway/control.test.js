import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createGatewayControl } from '../../src/gateway-control.js'
import { ConfigController } from '../../src/config-remote.js'
import { configFile, readSavedConfig, withSavedConfig } from '../../src/state.js'

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function fixture({ initial = true, base = true } = {}) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify({ enabled: initial }))
  const transports = new Map()
  const paused = new Set()
  let disposed = false
  let starts = 0
  const events = []
  const makeTransport = (id) => ({
    running: true,
    stop() { this.running = false; events.push(`stop:${id}`) },
  })
  const control = createGatewayControl({
    isEnabled: () => withSavedConfig({ enabled: base }).enabled !== false,
    isPaused: (id) => paused.has(id),
    isDisposed: () => disposed,
    transports,
    startLoop: async () => {
      starts += 1
      for (const id of ['a', 'b']) {
        if (control.accepting(id) && !transports.has(id)) {
          transports.set(id, makeTransport(id))
          events.push(`start:${id}`)
        }
      }
    },
    warn: (line) => events.push(line),
  })
  // Exercise the actual persistence methods without a live Cordis host.
  const config = Object.create(ConfigController.prototype)
  config.config = { enabled: base }
  config.onConfigChanged = () => control.sync()
  return { control, config, transports, paused, events, starts: () => starts, dispose: () => { disposed = true } }
}

const save = (config, enabled) => config.save(JSON.stringify([{ path: 'enabled', value: enabled }]))

test('save enabled=false stops all polls and rejects queued inbound without invoking Agent', async () => {
  const f = fixture()
  await f.control.sync()
  let agentCalls = 0
  const inbound = f.control.wrapInbound('a', async () => { agentCalls += 1 })
  const old = [...f.transports.values()]
  await inbound({ text: 'before' })
  await save(f.config, false)
  assert.equal(readSavedConfig().enabled, false)
  assert.equal(f.transports.size, 0)
  assert.ok(old.every((t) => t.running === false))
  await inbound({ text: 'queued before disable' })
  assert.equal(agentCalls, 1)
})

test('disabled startup enables without restart and respects paused accounts', async () => {
  const f = fixture({ initial: false })
  f.paused.add('b')
  await f.control.sync()
  assert.equal(f.starts(), 0)
  await save(f.config, true)
  assert.deepEqual([...f.transports.keys()], ['a'])
  let calls = 0
  await f.control.wrapInbound('a', async () => { calls += 1 })({})
  assert.equal(calls, 1)
})

test('reset uses original composition rather than saved disabled startup snapshot', async () => {
  const f = fixture({ initial: false, base: true })
  await f.control.sync()
  await f.config.reset(JSON.stringify(['enabled']))
  assert.equal(readSavedConfig().enabled, undefined)
  assert.equal(f.control.enabled(), true)
  assert.equal(f.transports.size, 2)
})

test('reset respects an explicitly disabled composition', async () => {
  const f = fixture({ initial: true, base: false })
  await f.control.sync()
  await f.config.reset(JSON.stringify(['enabled']))
  assert.equal(f.control.enabled(), false)
  assert.equal(f.transports.size, 0)
})

test('disable returns promptly, admitted turn may finish, and disposal drains it', async () => {
  const f = fixture()
  await f.control.sync()
  const done = deferred()
  const started = deferred()
  const completed = []
  const transport = f.transports.get('a')
  transport.stop = () => { transport.running = false; return done.promise }
  const inbound = f.control.wrapInbound('a', async () => {
    started.resolve()
    await done.promise
    completed.push('reply')
  })
  const turn = inbound({})
  await started.promise
  await save(f.config, false)
  assert.equal(transport.running, false)
  let drained = false
  const drain = f.control.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  done.resolve()
  await turn
  await drain
  assert.deepEqual(completed, ['reply'])
})

test('rapid off/on invalidates old startup generation and queued old transport messages', async () => {
  const f = fixture()
  await f.control.sync()
  const oldGeneration = f.control.generation()
  let calls = 0
  const oldInbound = f.control.wrapInbound('a', async () => { calls += 1 })
  await save(f.config, false)
  await save(f.config, true)
  assert.notEqual(f.control.generation(), oldGeneration)
  await oldInbound({})
  assert.equal(calls, 0)
  await f.control.wrapInbound('a', async () => { calls += 1 })({})
  assert.equal(calls, 1)
})

test('paused account cannot receive queued messages or resume while gateway is off', async () => {
  const f = fixture()
  await f.control.sync()
  let calls = 0
  const oldInbound = f.control.wrapInbound('a', async () => { calls += 1 })
  f.paused.add('a')
  f.control.stopAccount('a')
  await oldInbound({})
  await save(f.config, false)
  f.paused.delete('a')
  await f.control.sync()
  assert.equal(f.transports.size, 0)
  await save(f.config, true)
  await oldInbound({})
  assert.equal(calls, 0)
  assert.equal(f.transports.size, 2)
})

test('invalid settings do not write or notify; callbacks observe committed settings', async () => {
  const f = fixture()
  let notified = 0
  f.config.onConfigChanged = () => {
    notified += 1
    assert.equal(readSavedConfig().enabled, false)
  }
  await assert.rejects(f.config.save('[{"path":"does-not-exist","value":false}]'))
  assert.equal(notified, 0)
  assert.equal(readSavedConfig().enabled, true)
  await save(f.config, false)
  assert.equal(notified, 1)
})

test('disposed gateway cannot be started by delayed save or login work', async () => {
  const f = fixture()
  await f.control.sync()
  f.dispose()
  await f.control.sync()
  const starts = f.starts()
  await save(f.config, true)
  assert.equal(f.starts(), starts)
  assert.equal(f.transports.size, 0)
  assert.equal(f.control.accepting('a'), false)
})

test('a failed stop cannot prevent other accounts stopping or draining', async () => {
  const f = fixture()
  await f.control.sync()
  f.transports.get('a').stop = () => { throw new Error('synthetic stop failure') }
  const other = f.transports.get('b')
  await save(f.config, false)
  await f.control.drain()
  assert.equal(other.running, false)
  assert.match(f.events.join('\n'), /synthetic stop failure/)
})

test('paused preparing account is invalidated even before it has a transport', async () => {
  const f = fixture()
  const canStart = f.control.checkpoint('a')
  assert.equal(canStart(), true)
  f.paused.add('a')
  f.control.stopAccount('a')
  f.paused.delete('a')
  assert.equal(canStart(), false)
  assert.equal(f.control.checkpoint('a')(), true)
})

test('restart waits for the prior account stop handshake, without blocking another account', async () => {
  const f = fixture()
  await f.control.sync()
  const done = deferred()
  f.transports.get('a').stop = () => done.promise
  f.control.stopAccount('a')
  let restarted = false
  const restart = f.control.whenStopped('a').then(() => { restarted = true })
  await f.control.whenStopped('b')
  assert.equal(restarted, false)
  // A repeated stop must not forget the existing drain promise.
  f.control.stopAccount('a')
  let second = false
  const repeated = f.control.whenStopped('a').then(() => { second = true })
  await Promise.resolve()
  assert.equal(second, false)
  done.resolve()
  await restart
  await repeated
  assert.equal(restarted, true)
  assert.equal(second, true)
})
