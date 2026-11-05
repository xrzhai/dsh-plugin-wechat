import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { setImmediate as tick } from 'node:timers/promises'
import { FIELDS } from '../src/config-remote.js'

function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

// Load the shipped browser chunk and exercise the real account component with
// isolated hook state. No browser, account files, or live RPC is involved.
function fixture(status, { component = 'LoginSection', configRemote, weixin, timers } = {}) {
  let slots = [], cursor = 0, effects = [], mounted = false
  const cleanups = []
  const react = {
    useState(initial) {
      const key = cursor++
      if (!(key in slots)) slots[key] = initial
      return [slots[key], value => { slots[key] = typeof value === 'function' ? value(slots[key]) : value }]
    },
    useRef(initial) {
      const key = cursor++
      return slots[key] ??= { current: initial }
    },
    useCallback: fn => fn,
    useEffect(fn) { if (!mounted) effects.push(fn) },
  }
  let module
  vm.runInNewContext(fs.readFileSync(new URL('../src/client.card.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: entry => { module = entry.factory(() => react) } } },
    setTimeout: timers?.setTimeout ?? setTimeout,
    clearTimeout: timers?.clearTimeout ?? clearTimeout,
  })
  const ctx = { remote: { weixin: { status, ...weixin }, weixinConfig: configRemote } }
  const t = (_en, zh) => zh
  const created = []
  const createElement = (type, props, ...children) => {
    const node = { type, props: props ?? {}, children: children.flat(Infinity) }
    created.push(node)
    return node
  }
  const { WeixinSettingsCard } = module.createCardModule({
    ctx, t, createElement, C: {}, RADIUS: {}, callRemote: fn => fn(), buttonStyleFor: () => ({}),
    pillStyle: () => ({}), useLocaleText: () => ({ lang: 'zh' }),
  })
  const shell = WeixinSettingsCard()
  const login = component === 'WeixinSettingsCard'
    ? { type: WeixinSettingsCard, props: {} }
    : created.find(node => node.type?.name === component)
  assert.ok(login)
  slots = []; cursor = 0; effects = []
  const render = () => {
    cursor = 0
    return login.type(login.props)
  }
  const first = render()
  const mount = async () => {
    mounted = true
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    await tick()
    return render()
  }
  const unmount = async () => {
    mounted = false
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    await tick()
  }
  return { first, mount, render, unmount }
}

function nodes(tree) {
  return tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes)] : []
}
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  return typeof tree === 'object' ? (tree.children ?? []).map(text).join(' ') : String(tree)
}
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label)

test('failed status RPC is not presented as logged out; retry restores bound account', async () => {
  let fail = true
  const f = fixture(async () => {
    if (fail) throw new Error('remote not mounted')
    return { accounts: [{ accountId: 'fixture-account' }] }
  })
  assert.match(text(f.first), /正在读取账号状态/)
  assert.doesNotMatch(text(f.first), /未登录/)
  assert.equal(button(f.first, '扫码登录微信').props.disabled, true)
  const failed = await f.mount()
  assert.match(text(failed), /无法读取账号状态/)
  assert.doesNotMatch(text(failed), /未登录/)
  assert.equal(button(failed, '扫码登录微信').props.disabled, true)
  fail = false
  await button(failed, '重试').props.onClick()
  const recovered = f.render()
  assert.match(text(recovered), /已绑定/)
  assert.doesNotMatch(text(recovered), /无法读取账号状态/)
  // A bound, healthy account offers no add-account action: the single-account
  // UI hides multi-account entirely.
  assert.equal(button(recovered, '新增账号登录'), undefined)
  assert.equal(button(recovered, '扫码登录微信'), undefined)
})

test('only a successful empty account list is presented as logged out', async () => {
  const f = fixture(async () => ({ accounts: [] }))
  const tree = await f.mount()
  assert.match(text(tree), /未登录/)
  assert.equal(button(tree, '扫码登录微信').props.disabled, false)
})

test('a failed pause shows the error and leaves the account row unpaused', async () => {
  const f = fixture(async () => ({ accounts: [{ accountId: 'pause-write-failure', paused: false }] }), {
    weixin: { pause: async () => { throw new Error('无法保存账号暂停状态；连接状态未改变') } },
  })
  const mounted = await f.mount()
  await button(mounted, '暂停').props.onClick()
  const failed = f.render()
  assert.match(text(failed), /无法保存账号暂停状态；连接状态未改变/)
  assert.ok(button(failed, '暂停'))
  assert.equal(button(failed, '恢复'), undefined)
  assert.doesNotMatch(text(failed), /已暂停/)
})

test('a failed resume shows the error and leaves the account row paused', async () => {
  const f = fixture(async () => ({ accounts: [{ accountId: 'resume-write-failure', paused: true }] }), {
    weixin: { resume: async () => { throw new Error('无法保存账号恢复状态；连接状态未改变') } },
  })
  const mounted = await f.mount()
  await button(mounted, '恢复').props.onClick()
  const failed = f.render()
  assert.match(text(failed), /无法保存账号恢复状态；连接状态未改变/)
  assert.ok(button(failed, '恢复'))
  assert.equal(button(failed, '暂停'), undefined)
  assert.match(text(failed), /已暂停/)
})

test('expired sessions are identified on their own account rows', async () => {
  const f = fixture(async () => ({
    sessionExpired: true,
    accounts: [
      { accountId: 'healthy-account', label: '工作号', sessionExpired: false },
      { accountId: 'expired-account', label: '个人号', sessionExpired: true },
    ],
  }))
  const tree = await f.mount()
  const rendered = text(tree)
  assert.match(rendered, /2 个账号中有 1 个登录已过期/)
  assert.match(rendered, /个人号/)
  assert.match(rendered, /个人号 登录已过期/)
  assert.equal(button(tree, '重新扫码登录')?.props.disabled, false)
})

test('the legacy aggregate expiry field still produces an actionable warning', async () => {
  const f = fixture(async () => ({
    sessionExpired: true,
    accounts: [{ accountId: 'legacy-expired-account' }],
  }))
  const tree = await f.mount()
  const rendered = text(tree)
  assert.match(rendered, /登录已过期/)
  assert.match(rendered, /请重新扫码登录/)
  assert.equal(button(tree, '重新扫码登录')?.props.disabled, false)
})

test('unmount cancels the live QR session instead of the initial null state', async () => {
  const polling = new Promise(() => {})
  const cancelled = []
  const f = fixture(async () => ({ accounts: [] }), {
    weixin: {
      startLogin: async () => ({
        sessionKey: 'session-live',
        qrcodeUrl: 'https://example.test/qr',
        qrDataUrl: null,
      }),
      poll: () => polling,
      cancel: async sessionKey => { cancelled.push(sessionKey) },
    },
  })
  const mounted = await f.mount()
  await button(mounted, '扫码登录微信').props.onClick()
  await tick()
  await f.unmount()
  assert.deepEqual(cancelled, ['session-live'])
})

test('a queued poll callback after stopPolling cannot poll a null key', async () => {
  const queued = []
  let timerId = 0
  const polls = []
  const f = fixture(async () => ({ accounts: [] }), {
    timers: {
      setTimeout: callback => {
        queued.push(callback)
        return ++timerId
      },
      // Simulate a callback the runtime has already queued past cancellation.
      clearTimeout: () => {},
    },
    weixin: {
      startLogin: async () => ({ sessionKey: 'session-queued', qrcodeUrl: null, qrDataUrl: null }),
      poll: async sessionKey => { polls.push(sessionKey); return { status: 'wait' } },
      cancel: async () => {},
    },
  })
  const mounted = await f.mount()
  await button(mounted, '扫码登录微信').props.onClick()
  await button(f.render(), '取消').props.onClick()

  for (const callback of queued.splice(0)) callback()
  await tick()
  assert.deepEqual(polls, [])
})

test('a late start result is cancelled when its component has unmounted', async () => {
  const start = deferred()
  let startCalls = 0
  let polls = 0
  const cancelled = []
  const f = fixture(async () => ({ accounts: [] }), {
    weixin: {
      startLogin: () => {
        startCalls += 1
        return start.promise
      },
      poll: async () => {
        polls += 1
        return { status: 'wait' }
      },
      cancel: async sessionKey => { cancelled.push(sessionKey) },
    },
  })
  const mounted = await f.mount()
  const starting = button(mounted, '扫码登录微信').props.onClick()
  await waitFor(() => startCalls === 1, 'startLogin was not requested')
  await f.unmount()

  start.resolve({ sessionKey: 'late-start', qrcodeUrl: null, qrDataUrl: null })
  await starting
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.deepEqual(cancelled, ['late-start'])
  assert.equal(polls, 0)
})

for (const lateStatus of ['cancelled', 'confirmed']) {
  test(`a late ${lateStatus} poll cannot stop a newer session`, async () => {
    const firstPoll = deferred()
    const secondPoll = deferred()
    let startCalls = 0
    let pollCalls = 0
    const cancelled = []
    const f = fixture(async () => ({ accounts: [] }), {
      weixin: {
        startLogin: async () => {
          startCalls += 1
          const sessionKey = `session-${startCalls}`
          return { sessionKey, qrcodeUrl: `https://example.test/${sessionKey}`, qrDataUrl: null }
        },
        poll: () => {
          pollCalls += 1
          return pollCalls === 1 ? firstPoll.promise : secondPoll.promise
        },
        cancel: async sessionKey => { cancelled.push(sessionKey) },
      },
    })
    const mounted = await f.mount()

    await button(mounted, '扫码登录微信').props.onClick()
    await waitFor(() => pollCalls === 1, 'first session never started polling')
    await button(f.render(), '取消').props.onClick()
    await button(f.render(), '扫码登录微信').props.onClick()
    await waitFor(() => pollCalls === 2, 'replacement session never started polling')

    firstPoll.resolve(lateStatus === 'confirmed'
      ? { status: 'confirmed', accountId: 'stale-account' }
      : { status: 'cancelled' })
    await tick()

    const current = f.render()
    assert.ok(button(current, '取消'), 'the replacement session must still be displayed')
    await button(current, '取消').props.onClick()
    assert.deepEqual(cancelled, ['session-1', 'session-2'])
    secondPoll.resolve({ status: 'cancelled' })
    await tick()
  })
}

test('a cancelled poll returns the QR login to idle without scheduling a retry', async () => {
  let polls = 0
  const f = fixture(async () => ({ accounts: [] }), {
    weixin: {
      startLogin: async () => ({ sessionKey: 'session-cancelled', qrcodeUrl: null, qrDataUrl: null }),
      poll: async () => {
        polls += 1
        return { status: 'cancelled' }
      },
      cancel: async () => {},
    },
  })
  const mounted = await f.mount()
  await button(mounted, '扫码登录微信').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 5))
  await tick()
  assert.equal(polls, 1)
  assert.equal(button(f.render(), '扫码登录微信')?.props.disabled, false)
})

test('a start cancelled by a concurrent logout does not enter the QR state', async () => {
  let polls = 0
  const f = fixture(async () => ({ accounts: [] }), {
    weixin: {
      startLogin: async () => ({ status: 'cancelled' }),
      poll: async () => {
        polls += 1
        return { status: 'wait' }
      },
      cancel: async () => {},
    },
  })
  const mounted = await f.mount()
  await button(mounted, '扫码登录微信').props.onClick()
  await tick()
  assert.equal(polls, 0)
  assert.equal(button(f.render(), '扫码登录微信')?.props.disabled, false)
})

test('malformed status is an unavailable service, not an empty account list', async () => {
  const f = fixture(async () => undefined)
  assert.match(text(await f.mount()), /无法读取账号状态/)
})

test('an older failed request cannot overwrite a successful retry', async () => {
  let next = async () => { throw new Error('offline') }
  const f = fixture(() => next())
  const failed = await f.mount()
  let rejectOld
  next = () => new Promise((_resolve, reject) => { rejectOld = reject })
  const older = button(failed, '重试').props.onClick()
  next = async () => ({ accounts: [] })
  await button(failed, '重试').props.onClick()
  rejectOld(new Error('stale failure'))
  await older
  assert.match(text(f.render()), /未登录/)
  assert.doesNotMatch(text(f.render()), /无法读取账号状态/)
})

test('the settings page exposes and saves dispatcher permissions on a fresh profile', async () => {
  let saved
  const groups = FIELDS.map(group => ({ ...group, fields: group.fields.map(field => ({ ...field, value: field.default })) }))
  const f = fixture(undefined, {
    component: 'ConfigSection',
    configRemote: {
      list: async () => ({ groups }),
      save: async value => { saved = JSON.parse(value); return {} },
    },
  })
  const tree = await f.mount()
  const dispatcher = nodes(tree).find(node => node.type === 'button' && text(node).includes('平行会话调度'))
  assert.ok(dispatcher, 'core dispatcher settings must not be filtered out')
  dispatcher.props.onClick()
  const open = f.render()
  for (const label of ['启用平行会话调度', '调度者发送者 ID', '允许访问的目标会话 ID', '只读会话 ID', '只读工作区根目录']) {
    assert.ok(text(open).includes(label), label)
  }
  const checkbox = nodes(open).find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false && node.props.onChange)
  // Pick the field control by its surrounding label, rather than the toolbar filter.
  const field = nodes(open).find(node => node.type === 'div' && text(node).includes('启用平行会话调度') && nodes(node).filter(n => n.type === 'input' && n.props.type === 'checkbox').length === 1)
  const toggle = nodes(field).find(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.ok(checkbox && toggle)
  toggle.props.onChange({ target: { checked: true } })
  await button(f.render(), '保存').props.onClick()
  assert.ok(saved.some(entry => entry.path === 'sessionDispatcherEnabled' && entry.value === true))
})

test('a settings RPC failure is visible instead of rendering an empty settings page', async () => {
  const f = fixture(undefined, { component: 'ConfigSection', configRemote: { list: async () => { throw new Error('service offline') } } })
  assert.match(text(await f.mount()), /service offline/)
})


test('primary tabs are account + persona; advanced reveals sessions + gateway', () => {
  const f = fixture(async () => ({ accounts: [] }), { component: 'WeixinSettingsCard' })
  const tabs = tree => nodes(tree).filter(node => node.props?.role === 'tab')
  const fnNames = tree => nodes(tree).filter(node => typeof node.type === 'function').map(node => node.type.name)

  // Beginner surface: 微信账号 + 人设 only.
  assert.equal(tabs(f.first).length, 2)
  assert.deepEqual(tabs(f.first).map(node => node.props['aria-selected']), [true, false])
  assert.deepEqual(fnNames(f.first), ['TabIcon', 'TabIcon', 'LoginSection'])

  // Switching to 人设 renders the AGENTS.md editor.
  tabs(f.render())[1].props.onClick()
  assert.deepEqual(fnNames(f.render()), ['TabIcon', 'TabIcon', 'PromptSection'])

  // 高级 reveals the two ops sections.
  const toggle = nodes(f.render()).find(node => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
  assert.ok(toggle, 'advanced toggle exists')
  toggle.props.onClick()
  const expanded = f.render()
  assert.equal(tabs(expanded).length, 4)
  assert.deepEqual(tabs(expanded).map(node => node.props['aria-selected']), [false, true, false, false])
  assert.deepEqual(fnNames(expanded).slice(0, 4), ['TabIcon', 'TabIcon', 'TabIcon', 'TabIcon'])

  // Each advanced tab renders its own section.
  tabs(expanded)[2].props.onClick()
  assert.ok(fnNames(f.render()).includes('SessionsSection'))
  tabs(f.render())[3].props.onClick()
  assert.ok(fnNames(f.render()).includes('ConfigSection'))

  // Collapsing 高级 while on an ops tab returns to 微信账号.
  const collapse = nodes(f.render()).find(node => node.type === 'button' && node.props?.['aria-expanded'] === true)
  assert.ok(collapse, 'collapse toggle exists')
  collapse.props.onClick()
  assert.equal(tabs(f.render()).length, 2)
  assert.deepEqual(tabs(f.render()).map(node => node.props['aria-selected']), [true, false])

  // Arrow keys wrap across the visible tabs.
  let prevented = 0
  const key = (name) => nodes(f.render()).find(node => node.props?.role === 'tablist')
    .props.onKeyDown({ key: name, preventDefault: () => prevented++ })
  key('ArrowRight')
  assert.deepEqual(tabs(f.render()).map(node => node.props['aria-selected']), [false, true])
  key('ArrowLeft')
  assert.deepEqual(tabs(f.render()).map(node => node.props['aria-selected']), [true, false])
  assert.equal(prevented, 2)
})
