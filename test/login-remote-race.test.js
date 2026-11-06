import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WeixinLoginController } from '../src/login-remote.js'
import { setAccountPaused } from '../src/account-registry.js'
import {
  clearWeixinAccount,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
  unregisterWeixinAccountId,
} from '../vendor/openclaw-weixin/auth/accounts.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function qrResponse(qrcode = 'qr-1') {
  return JSON.stringify({
    qrcode,
    qrcode_img_content: `https://example.test/qr/${qrcode}`,
  })
}

function confirmedResponse(accountId, token = 'late-token') {
  return JSON.stringify({
    status: 'confirmed',
    ilink_bot_id: accountId,
    ilink_user_id: 'user-1',
    bot_token: token,
    baseurl: 'https://ilink.example.test',
  })
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(message)
}

function fixture(t, options = {}) {
  const ctx = new Context()
  const controller = new WeixinLoginController(ctx, {
    apiPostFetch: options.apiPostFetch ?? (async () => qrResponse()),
    apiGetFetch: options.apiGetFetch ?? (async () => JSON.stringify({ status: 'wait' })),
    makeQrDataUrl: options.makeQrDataUrl ?? (async () => undefined),
    loadAccount: options.loadAccount,
    clearAccount: options.clearAccount,
    unregisterAccount: options.unregisterAccount,
    persistAccountPaused: options.persistAccountPaused,
    now: options.now,
  })
  const issued = []
  t.after(async () => {
    for (const sessionKey of issued) await controller.cancel(sessionKey).catch(() => {})
    await ctx.fiber.dispose()
  })
  return { controller, issued }
}

function cleanAccount(t, accountId) {
  t.after(() => {
    clearWeixinAccount(accountId)
    unregisterWeixinAccountId(accountId)
  })
}

test('pause and resume report a registry write failure before notifying the host', async t => {
  const accountId = 'write-failure@im.bot'
  const calls = []
  let persisted = false
  const { controller } = fixture(t, {
    persistAccountPaused: (id, paused, warn) => setAccountPaused(id, paused, warn, {
      writeJson: (_file, value) => {
        calls.push([id, value[id]?.paused])
        return persisted
      },
    }),
  })
  const controlChanges = []
  controller.onAccountControlChange = accountId => controlChanges.push(accountId)

  await assert.rejects(
    controller.pause(accountId),
    error => error?.code === 'registry_write_failed' && /连接状态未改变/.test(error.message),
  )
  assert.deepEqual(controlChanges, [])

  await assert.rejects(
    controller.resume(accountId),
    error => error?.code === 'registry_write_failed' && /连接状态未改变/.test(error.message),
  )
  assert.deepEqual(controlChanges, [])
  assert.deepEqual(calls, [[accountId, true], [accountId, false]])

  persisted = true
  assert.deepEqual(await controller.pause(accountId), { accountId, paused: true })
  assert.deepEqual(await controller.resume(accountId), { accountId, paused: false })
  assert.deepEqual(controlChanges, [accountId, accountId])
})

test('concurrent start requests share one QR session', async t => {
  const qr = deferred()
  let postCalls = 0
  const { controller, issued } = fixture(t, {
    apiPostFetch: () => {
      postCalls += 1
      return qr.promise
    },
  })

  const first = controller.startLogin()
  const second = controller.startLogin()
  await waitFor(() => postCalls === 1, 'startLogin never reached the QR request')
  qr.resolve(qrResponse('shared'))

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.sessionKey, secondResult.sessionKey)
  assert.equal(postCalls, 1)
  issued.push(firstResult.sessionKey)
})

test('logout during QR issuance prevents a new session from appearing', async t => {
  const qr = deferred()
  let postCalls = 0
  const { controller, issued } = fixture(t, {
    apiPostFetch: () => {
      postCalls += 1
      return postCalls === 1 ? qr.promise : Promise.resolve(qrResponse('fresh'))
    },
  })

  const starting = controller.startLogin()
  await waitFor(() => postCalls === 1, 'startLogin never reached the QR request')
  assert.deepEqual(await controller.logout(''), { removed: [], reloadRequired: false })
  qr.resolve(qrResponse('stale'))

  assert.deepEqual(await starting, { status: 'cancelled' })
  const next = await controller.startLogin()
  issued.push(next.sessionKey)
  assert.deepEqual(next, {
    qrcodeUrl: 'https://example.test/qr/fresh',
    qrDataUrl: undefined,
    sessionKey: next.sessionKey,
    status: 'wait',
  })
})

test('cancel invalidates an in-flight poll before a late confirmed result can bind', async t => {
  const network = deferred()
  let getCalls = 0
  const { controller, issued } = fixture(t, {
    apiGetFetch: () => {
      getCalls += 1
      return network.promise
    },
  })
  const accountId = 'race-cancel@im.bot'
  cleanAccount(t, accountId)

  let starts = 0
  controller.onAccountBound = () => { starts += 1 }
  controller.markSessionExpired()
  const login = await controller.startLogin()
  issued.push(login.sessionKey)
  const polling = controller.poll(login.sessionKey)
  assert.equal(getCalls, 1)

  await controller.cancel(login.sessionKey)
  network.resolve(confirmedResponse(accountId))

  assert.deepEqual(await polling, { status: 'cancelled' })
  assert.equal(starts, 0)
  assert.equal(loadWeixinAccount(accountId), null)
  assert.equal(listIndexedWeixinAccountIds().includes(accountId), false)
  assert.equal(controller.sessionExpired, true)
})

test('logout does not let a late confirmed poll restore the removed account', async t => {
  const network = deferred()
  let getCalls = 0
  const { controller, issued } = fixture(t, {
    apiGetFetch: () => {
      getCalls += 1
      return network.promise
    },
  })
  const accountId = 'race-logout@im.bot'
  cleanAccount(t, accountId)
  saveWeixinAccount(accountId, { token: 'old-token', userId: 'user-1' })
  registerWeixinAccountId(accountId)

  let starts = 0
  controller.onAccountBound = () => { starts += 1 }
  const login = await controller.startLogin()
  issued.push(login.sessionKey)
  const polling = controller.poll(login.sessionKey)
  assert.equal(getCalls, 1)

  assert.deepEqual(await controller.logout(accountId), { removed: [accountId], reloadRequired: true })
  network.resolve(confirmedResponse(accountId, 'resurrected-token'))

  assert.deepEqual(await polling, { status: 'cancelled' })
  assert.equal(starts, 0)
  assert.equal(loadWeixinAccount(accountId), null)
  assert.equal(listIndexedWeixinAccountIds().includes(accountId), false)
})

test('concurrent confirmed polls bind and start the account only once', async t => {
  const networks = [deferred(), deferred()]
  let getCalls = 0
  const { controller, issued } = fixture(t, {
    apiGetFetch: () => networks[getCalls++].promise,
  })
  const accountId = 'race-duplicate@im.bot'
  cleanAccount(t, accountId)

  let starts = 0
  controller.onAccountBound = () => { starts += 1 }
  const login = await controller.startLogin()
  issued.push(login.sessionKey)
  const firstPoll = controller.poll(login.sessionKey)
  const secondPoll = controller.poll(login.sessionKey)
  assert.equal(getCalls, 2)

  networks[0].resolve(confirmedResponse(accountId, 'first-token'))
  assert.deepEqual(await firstPoll, {
    status: 'confirmed',
    accountId,
    userId: 'user-1',
  })
  networks[1].resolve(confirmedResponse(accountId, 'second-token'))

  assert.deepEqual(await secondPoll, { status: 'cancelled' })
  assert.equal(starts, 1)
  assert.equal(loadWeixinAccount(accountId)?.token, 'first-token')
  assert.equal(listIndexedWeixinAccountIds().filter(id => id === accountId).length, 1)
})

test('an active login keeps its normal transitions and retries after a poll error', async t => {
  const networks = Array.from({ length: 7 }, () => deferred())
  const requests = []
  const { controller, issued } = fixture(t, {
    apiGetFetch: params => {
      requests.push(params)
      return networks[requests.length - 1].promise
    },
  })
  const accountId = 'race-running@im.bot'
  cleanAccount(t, accountId)

  let starts = 0
  controller.onAccountBound = () => { starts += 1 }
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  const waitPoll = controller.poll(login.sessionKey)
  networks[0].resolve(JSON.stringify({ status: 'wait' }))
  assert.deepEqual(await waitPoll, { status: 'wait' })

  const verifyPoll = controller.poll(login.sessionKey)
  networks[1].resolve(JSON.stringify({ status: 'need_verifycode' }))
  assert.deepEqual(await verifyPoll, {
    status: 'need_verifycode',
    message: '请输入手机微信上显示的验证码数字',
  })

  assert.deepEqual(await controller.submitVerifyCode(login.sessionKey, '1234'), { accepted: true })
  const scanPoll = controller.poll(login.sessionKey)
  networks[2].resolve(JSON.stringify({ status: 'scaned' }))
  assert.deepEqual(await scanPoll, { status: 'scaned' })

  const redirectPoll = controller.poll(login.sessionKey)
  networks[3].resolve(JSON.stringify({ status: 'scaned_but_redirect', redirect_host: 'redirect.example.test' }))
  assert.deepEqual(await redirectPoll, { status: 'scaned' })

  const errorPoll = controller.poll(login.sessionKey)
  networks[4].reject(new Error('temporary network failure'))
  assert.deepEqual(await errorPoll, {
    status: 'retrying',
    reason: 'network_error',
    attempt: 1,
    maxAttempts: 3,
    message: '连接微信登录服务失败，正在重试。（1/3）',
  })

  const confirmPoll = controller.poll(login.sessionKey)
  assert.equal(requests.at(-1).baseUrl, 'https://redirect.example.test')
  networks[5].resolve(confirmedResponse(accountId))
  assert.deepEqual(await confirmPoll, {
    status: 'confirmed',
    accountId,
    userId: 'user-1',
  })
  assert.equal(starts, 1)
  assert.equal(loadWeixinAccount(accountId)?.token, 'late-token')
})

test('consecutive poll errors become an explicit retrying state and then fail', async t => {
  const { controller, issued } = fixture(t, {
    apiGetFetch: async () => { throw new Error('proxy returned 502') },
  })
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  const first = await controller.poll(login.sessionKey)
  assert.equal(first.status, 'retrying')
  assert.equal(first.attempt, 1)
  assert.match(first.message, /重试/)

  const second = await controller.poll(login.sessionKey)
  assert.equal(second.status, 'retrying')
  assert.equal(second.attempt, 2)

  const third = await controller.poll(login.sessionKey)
  assert.equal(third.status, 'failed')
  assert.equal(third.reason, 'network_error')
  assert.match(third.message, /连续 3 次/)
  assert.equal((await controller.status()).pendingLogin, false)
})

test('a normal long-poll timeout stays waiting and can be followed by confirmation', async t => {
  let getCalls = 0
  const accountId = 'race-long-poll-timeout@im.bot'
  cleanAccount(t, accountId)
  const { controller, issued } = fixture(t, {
    apiGetFetch: async () => {
      getCalls += 1
      if (getCalls === 1) {
        const timeout = new Error('The operation was aborted')
        timeout.name = 'AbortError'
        throw timeout
      }
      return confirmedResponse(accountId)
    },
  })
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  assert.deepEqual(await controller.poll(login.sessionKey), { status: 'wait' })
  assert.deepEqual(await controller.poll(login.sessionKey), {
    status: 'confirmed',
    accountId,
    userId: 'user-1',
  })
})

test('a malformed poll response is an error rather than an implicit wait', async t => {
  const { controller, issued } = fixture(t, {
    apiGetFetch: async () => '{not-json',
  })
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  const result = await controller.poll(login.sessionKey)
  assert.equal(result.status, 'retrying')
  assert.equal(result.reason, 'invalid_response')
  assert.match(result.message, /返回异常/)
})

test('the total login deadline fails and purges an idle login', async t => {
  let now = 1_000_000
  const { controller, issued } = fixture(t, {
    now: () => now,
  })
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  now += 480_001
  assert.deepEqual(await controller.poll(login.sessionKey), {
    status: 'failed',
    reason: 'login_timeout',
    message: '登录已超时，请重新扫码。',
  })
  assert.equal((await controller.status()).pendingLogin, false)
})

test('status alone purges an idle login after its total deadline', async t => {
  let now = 1_500_000
  const { controller, issued } = fixture(t, {
    now: () => now,
  })
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  now += 480_001
  assert.equal((await controller.status()).pendingLogin, false)
  await assert.rejects(controller.poll(login.sessionKey), error => error?.code === 'no_login')
})

test('status cleanup does not terminate a poll that can still confirm', async t => {
  let now = 2_000_000
  const network = deferred()
  const accountId = 'race-expired-deadline@im.bot'
  cleanAccount(t, accountId)
  const { controller, issued } = fixture(t, {
    now: () => now,
    apiGetFetch: () => network.promise,
  })
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  const polling = controller.poll(login.sessionKey)
  now += 480_001
  assert.equal((await controller.status()).pendingLogin, true)

  network.resolve(confirmedResponse(accountId, 'still-valid-token'))
  assert.deepEqual(await polling, {
    status: 'confirmed',
    accountId,
    userId: 'user-1',
  })
  assert.equal(loadWeixinAccount(accountId)?.token, 'still-valid-token')
  assert.equal((await controller.status()).pendingLogin, false)
})

test('session expiry is isolated per account and keeps the legacy aggregate', async t => {
  const accountA = 'expiry-account-a@im.bot'
  const accountB = 'expiry-account-b@im.bot'
  cleanAccount(t, accountA)
  cleanAccount(t, accountB)
  saveWeixinAccount(accountA, { token: 'token-a', userId: 'user-a' })
  saveWeixinAccount(accountB, { token: 'token-b', userId: 'user-b' })
  registerWeixinAccountId(accountA)
  registerWeixinAccountId(accountB)
  const { controller } = fixture(t)

  controller.markSessionExpired(accountA)
  let status = await controller.status()
  assert.equal(status.sessionExpired, true)
  assert.equal(status.accounts.find(account => account.accountId === accountA)?.sessionExpired, true)
  assert.equal(status.accounts.find(account => account.accountId === accountB)?.sessionExpired, false)

  await controller.logout(accountB)
  status = await controller.status()
  assert.equal(status.sessionExpired, true)
  assert.equal(status.accounts.find(account => account.accountId === accountA)?.sessionExpired, true)
  assert.equal(status.accounts.some(account => account.accountId === accountB), false)
  assert.equal(controller.sessionExpired, true)
})

test('status keeps expiry through transient unreadable and tokenless account reads', async t => {
  const accountId = 'expiry-transient-read@im.bot'
  cleanAccount(t, accountId)
  saveWeixinAccount(accountId, { token: 'token', userId: 'user' })
  registerWeixinAccountId(accountId)
  let readNumber = 0
  const { controller } = fixture(t, {
    loadAccount: id => {
      if (id !== accountId) return loadWeixinAccount(id)
      readNumber += 1
      if (readNumber === 1) throw new Error('temporary credential read failure')
      if (readNumber === 2) return { token: '', userId: 'user' }
      return loadWeixinAccount(id)
    },
  })
  controller.markSessionExpired(accountId)

  const unreadable = await controller.status()
  assert.equal(unreadable.sessionExpired, true)
  assert.equal(unreadable.accounts.length, 0)

  const tokenless = await controller.status()
  assert.equal(tokenless.sessionExpired, true)
  assert.equal(tokenless.accounts.length, 0)

  const recovered = await controller.status()
  assert.equal(recovered.sessionExpired, true)
  assert.equal(recovered.accounts.find(account => account.accountId === accountId)?.sessionExpired, true)
})

test('a failed logout preserves its credential and expiry until a successful retry', async t => {
  const accountA = 'expiry-logout-a@im.bot'
  const accountB = 'expiry-logout-b@im.bot'
  cleanAccount(t, accountA)
  cleanAccount(t, accountB)
  saveWeixinAccount(accountA, { token: 'token-a', userId: 'user-a' })
  saveWeixinAccount(accountB, { token: 'token-b', userId: 'user-b' })
  registerWeixinAccountId(accountA)
  registerWeixinAccountId(accountB)
  let failB = true
  const { controller } = fixture(t, {
    clearAccount: id => {
      if (id === accountB && failB) throw new Error('credential is busy')
      return clearWeixinAccount(id)
    },
  })
  controller.markSessionExpired(accountA)
  controller.markSessionExpired(accountB)

  await assert.rejects(controller.logout(accountB), /credential is busy/)
  let status = await controller.status()
  assert.equal(loadWeixinAccount(accountB)?.token, 'token-b')
  assert.equal(status.accounts.find(account => account.accountId === accountA)?.sessionExpired, true)
  assert.equal(status.accounts.find(account => account.accountId === accountB)?.sessionExpired, true)

  failB = false
  assert.deepEqual(await controller.logout(accountB), { removed: [accountB], reloadRequired: true })
  status = await controller.status()
  assert.equal(loadWeixinAccount(accountB), null)
  assert.equal(status.accounts.find(account => account.accountId === accountA)?.sessionExpired, true)
  assert.equal(status.accounts.some(account => account.accountId === accountB), false)
})

test('logout does not clear expiry for an account that does not exist', async t => {
  const accountId = 'expiry-logout-missing@im.bot'
  cleanAccount(t, accountId)
  const { controller } = fixture(t)
  controller.markSessionExpired(accountId)

  assert.deepEqual(await controller.logout(accountId), { removed: [], reloadRequired: false })
  saveWeixinAccount(accountId, { token: 'recovered-token', userId: 'user' })
  registerWeixinAccountId(accountId)

  const status = await controller.status()
  assert.equal(status.accounts.find(account => account.accountId === accountId)?.sessionExpired, true)
})

test('logout-all clears only accounts whose credentials were removed', async t => {
  const accountA = 'expiry-logout-all-a@im.bot'
  const accountB = 'expiry-logout-all-b@im.bot'
  cleanAccount(t, accountA)
  cleanAccount(t, accountB)
  saveWeixinAccount(accountA, { token: 'token-a', userId: 'user-a' })
  saveWeixinAccount(accountB, { token: 'token-b', userId: 'user-b' })
  registerWeixinAccountId(accountA)
  registerWeixinAccountId(accountB)
  const { controller } = fixture(t, {
    clearAccount: id => {
      if (id === accountB) throw new Error('credential is busy')
      return clearWeixinAccount(id)
    },
  })
  controller.markSessionExpired(accountA)
  controller.markSessionExpired(accountB)

  await assert.rejects(controller.logout(''), /credential is busy/)
  assert.equal(loadWeixinAccount(accountA), null)
  assert.equal(loadWeixinAccount(accountB)?.token, 'token-b')

  saveWeixinAccount(accountA, { token: 'new-token-a', userId: 'user-a' })
  registerWeixinAccountId(accountA)
  const status = await controller.status()
  assert.equal(status.accounts.find(account => account.accountId === accountA)?.sessionExpired, false)
  assert.equal(status.accounts.find(account => account.accountId === accountB)?.sessionExpired, true)
})

test('logout-all clears account and legacy expiry after every credential is removed', async t => {
  const accountId = 'expiry-logout-all-complete@im.bot'
  cleanAccount(t, accountId)
  saveWeixinAccount(accountId, { token: 'token', userId: 'user' })
  registerWeixinAccountId(accountId)
  const { controller } = fixture(t)
  controller.markSessionExpired(accountId)
  controller.markSessionExpired()

  assert.deepEqual(await controller.logout(''), { removed: [accountId], reloadRequired: true })
  const status = await controller.status()
  assert.deepEqual(status.accounts, [])
  assert.equal(status.sessionExpired, false)
})

test('logout-all does not clear a legacy expiry when no account is removed', async t => {
  const { controller } = fixture(t)
  controller.markSessionExpired()

  assert.deepEqual(await controller.logout(''), { removed: [], reloadRequired: false })
  assert.equal(controller.sessionExpired, true)
})

test('a successful login clears only its own expiry flag', async t => {
  const accountA = 'expiry-login-account-a@im.bot'
  const accountB = 'expiry-login-account-b@im.bot'
  cleanAccount(t, accountA)
  cleanAccount(t, accountB)
  saveWeixinAccount(accountA, { token: 'token-a', userId: 'user-a' })
  registerWeixinAccountId(accountA)
  const { controller, issued } = fixture(t, {
    apiGetFetch: async () => confirmedResponse(accountB, 'fresh-token-b'),
  })
  controller.markSessionExpired(accountA)
  controller.markSessionExpired(accountB)
  const login = await controller.startLogin()
  issued.push(login.sessionKey)

  assert.equal((await controller.poll(login.sessionKey)).status, 'confirmed')
  const status = await controller.status()
  assert.equal(status.accounts.find(account => account.accountId === accountA)?.sessionExpired, true)
  assert.equal(status.accounts.find(account => account.accountId === accountB)?.sessionExpired, false)
})

test('legacy no-argument expiry calls remain supported', async t => {
  const accountId = 'expiry-legacy-account@im.bot'
  cleanAccount(t, accountId)
  saveWeixinAccount(accountId, { token: 'token', userId: 'user' })
  registerWeixinAccountId(accountId)
  const { controller } = fixture(t)

  controller.markSessionExpired()
  assert.equal(controller.sessionExpired, true)
  assert.equal((await controller.status()).sessionExpired, true)
  controller.clearSessionExpired()
  assert.equal(controller.sessionExpired, false)
  assert.equal((await controller.status()).sessionExpired, false)
})

test('cancel during a QR refresh prevents stale QR work from finishing', async t => {
  const refreshedQr = deferred()
  const refreshedQrData = deferred()
  let postCalls = 0
  let qrDataCalls = 0
  const { controller, issued } = fixture(t, {
    apiPostFetch: () => {
      postCalls += 1
      return postCalls === 1 ? Promise.resolve(qrResponse('initial')) : refreshedQr.promise
    },
    apiGetFetch: async () => JSON.stringify({ status: 'expired' }),
    makeQrDataUrl: () => {
      qrDataCalls += 1
      return qrDataCalls === 1 ? Promise.resolve(undefined) : refreshedQrData.promise
    },
  })

  const login = await controller.startLogin()
  issued.push(login.sessionKey)
  const polling = controller.poll(login.sessionKey)
  await waitFor(() => postCalls === 2, 'expired poll never reached QR refresh')

  refreshedQr.resolve(qrResponse('refreshed'))
  await waitFor(() => qrDataCalls === 2, 'QR refresh never reached image rendering')

  await controller.cancel(login.sessionKey)
  refreshedQrData.resolve(undefined)
  assert.deepEqual(await polling, { status: 'cancelled' })
  await assert.rejects(controller.poll(login.sessionKey), error => error?.code === 'no_login')
})


test('stats retains operational health without retired prompt composition', async () => {
  const result = await WeixinLoginController.prototype.stats.call({
    status: async () => ({ accounts: [{ accountId: 'synthetic-stats-account' }] }),
  }, { days: 1, accountId: 'synthetic-stats-account' })
  assert.equal(result.days, 1)
  assert.equal(result.health.parts.find(part => part.key === 'connected').score, 25)
  assert.equal(Object.hasOwn(result, 'composition'), false)
})
