import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { setImmediate as tick } from 'node:timers/promises'
import { FIELDS } from '../src/config-remote.js'

// Load the shipped browser chunk and exercise the real account component with
// isolated hook state. No browser, account files, or live RPC is involved.
function fixture(status, { component = 'LoginSection', configRemote } = {}) {
  let slots = [], cursor = 0, effects = [], mounted = false
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
    setTimeout, clearTimeout,
  })
  const ctx = { remote: { weixin: { status }, weixinConfig: configRemote } }
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
    for (const effect of effects) effect()
    await tick()
    return render()
  }
  return { first, mount, render }
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
