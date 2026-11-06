import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const expectedWeixinMethods = [
  'startLogin', 'poll', 'submitVerifyCode', 'cancel', 'status', 'logout', 'sessions', 'useSession',
  'removeSession', 'pause', 'resume', 'label', 'allowlist', 'onboarding', 'promptPreview',
].sort()

test('desktop mounts only live Weixin RPCs without waiting for the removed ASR namespace', async () => {
  let entry
  vm.runInNewContext(fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value) => { entry = value } } },
  })
  const client = entry.factory(() => ({ createElement: () => {} }))
  let manifest, dependencies
  let unmounted = false, disposed = false
  const ui = Promise.resolve()
  ui.dispose = async () => { disposed = true }
  const cleanup = await client.apply({
    remote: { $mount: async (value) => { manifest = value; return async () => { unmounted = true } } },
    inject: (names) => { dependencies = [...names]; return ui },
  })
  const descriptors = [...manifest.descriptors]
  const weixin = descriptors.filter((d) => d.namespace === 'weixin')
  assert.deepEqual(weixin.map((d) => d.method).sort(), expectedWeixinMethods)
  assert.deepEqual(Array.from(weixin.find((d) => d.method === 'allowlist').parameters, (p) => p.name), ['accountId', 'senders'])
  const card = fs.readFileSync(new URL('../src/client.card.js', import.meta.url), 'utf8')
  const calls = [...card.matchAll(/ctx\.remote\.(weixin|weixinConfig)\.([A-Za-z]+)\(/g)]
  assert.ok(calls.length > 0)
  for (const [, namespace, method] of calls) {
    assert.ok(descriptors.some((descriptor) => descriptor.namespace === namespace && descriptor.method === method),
      `settings card calls an unmounted RPC: ${namespace}.${method}`)
  }
  assert.ok(descriptors.every((d) => d.namespace !== 'weixinAsr' && d.service !== 'asrController'))
  assert.ok(!dependencies.includes('remote.weixinAsr'))
  assert.ok(dependencies.includes('remote.weixin'))
  assert.ok(dependencies.includes('remote.weixinConfig'))
  assert.ok(dependencies.includes('remote.directoryPicker'))
  await cleanup()
  assert.equal(disposed, true)
  assert.equal(unmounted, true)
})

test('backend registers precisely the same retained Weixin methods', async () => {
  const { WeixinLoginController } = await import('../src/login-remote.js')
  const registered = Object.getOwnPropertyDescriptor(
    WeixinLoginController.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods',
  ).value.methods.map((d) => d.method).sort()
  assert.deepEqual(registered, expectedWeixinMethods)
  for (const method of registered) assert.equal(typeof WeixinLoginController.prototype[method], 'function')
  const { ConfigController } = await import('../src/config-remote.js')
  const configMethods = Object.getOwnPropertyDescriptor(
    ConfigController.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods',
  ).value.methods.map((d) => d.method).sort()
  assert.deepEqual(configMethods, ['archivedChildren', 'list', 'reset', 'save', 'updateArchivedChildren'])
  for (const method of configMethods) assert.equal(typeof ConfigController.prototype[method], 'function')
})

test('retained allowlist RPC saves synthetic account permissions and notifies the gateway', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-rpc-allowlist-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { WeixinLoginController } = await import('../src/login-remote.js')
  const { readRegistry, setAccountAllowlist } = await import('../src/account-registry.js')
  const changes = []
  assert.equal(setAccountAllowlist('synthetic-account', ['first-contact'], ['synthetic-chat']), true)
  const result = await WeixinLoginController.prototype.allowlist.call({ onAccountControlChange: (id) => changes.push(id) },
    'synthetic-account', 'synthetic-person')
  assert.deepEqual(result, { accountId: 'synthetic-account' })
  assert.deepEqual(readRegistry()['synthetic-account'].allowedSenders, ['synthetic-person'])
  assert.deepEqual(readRegistry()['synthetic-account'].allowedChats, ['synthetic-chat'])
  assert.deepEqual(changes, ['synthetic-account'])
  await WeixinLoginController.prototype.allowlist.call({}, 'inheriting-account', 'another-person')
  assert.equal('allowedChats' in readRegistry()['inheriting-account'], false)
  await WeixinLoginController.prototype.allowlist.call({}, 'synthetic-account', '')
  assert.equal('allowedSenders' in readRegistry()['synthetic-account'], false)
  assert.deepEqual(readRegistry()['synthetic-account'].allowedChats, ['synthetic-chat'])
})

test('account status reports the account override and then the inherited composition contacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-rpc-status-'))
  const keys = ['DSH_WEIXIN_STATE_DIR', 'OPENCLAW_STATE_DIR', 'CLAWDBOT_STATE_DIR']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.DSH_WEIXIN_STATE_DIR = root
  const { configureWeixinStateDir } = await import('../src/state.js')
  configureWeixinStateDir()
  const { Context } = await import('@deepseek-ai/cordis')
  const { ConfigController } = await import('../src/config-remote.js')
  const { WeixinLoginController } = await import('../src/login-remote.js')
  const { readRegistry, setAccountAllowlist } = await import('../src/account-registry.js')
  const { saveWeixinAccount, registerWeixinAccountId } = await import('../vendor/openclaw-weixin/auth/accounts.js')
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const login = new WeixinLoginController(ctx)
  new ConfigController(ctx, { config: { allowedSenders: ['global-person'] } })
  saveWeixinAccount('synthetic-status', { token: 'synthetic-token', userId: 'synthetic-user' })
  registerWeixinAccountId('synthetic-status')
  assert.equal(setAccountAllowlist('synthetic-status', ['first-contact'], ['restricted-chat']), true)
  let account = (await login.status()).accounts.find((item) => item.accountId === 'synthetic-status')
  assert.deepEqual(account.allowedSenders, ['first-contact'])
  assert.deepEqual(account.accountAllowedSenders, ['first-contact'])
  await login.allowlist('synthetic-status', '')
  account = (await login.status()).accounts.find((item) => item.accountId === 'synthetic-status')
  assert.deepEqual(account.allowedSenders, ['global-person'])
  assert.deepEqual(account.accountAllowedSenders, [])
  assert.deepEqual(readRegistry()['synthetic-status'].allowedChats, ['restricted-chat'])
})
