import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WeixinLoginController } from '../src/login-remote.js'
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
  assert.deepEqual(await errorPoll, { status: 'wait' })

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
