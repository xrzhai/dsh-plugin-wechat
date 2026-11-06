import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/client.subagent-cache.js', import.meta.url), 'utf8')
function tab(remote, disk = new Map()) {
  let listener, cache
  const window = {
    localStorage: { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, v) },
    addEventListener: (_, fn) => { listener = fn },
    removeEventListener: (_, fn) => { if (listener === fn) listener = null },
    __ModuleLoader__: { load({ id, chunk, factory }) {
      assert.equal(id, 'dsh-plugin-wechat')
      assert.equal(chunk, 'client.subagent-cache.js')
      cache = factory().createArchiveCache(remote)
    } },
  }
  vm.runInNewContext(source, { window })
  return { cache, disk, sync: () => listener?.({ key: disk.keys().next().value ?? null }) }
}
function deferred() {
  let resolve
  const promise = new Promise(ok => { resolve = ok })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const ids = (cache, parent = 'p') => [...cache.getSnapshot(parent)]

test('deferred load cannot erase newer writes; same-parent writes serialize, other parents progress', async () => {
  const read = deferred(), first = deferred(), calls = []
  const { cache } = tab({
    archivedChildren: () => read.promise,
    updateArchivedChildren(p, a, r) {
      calls.push([p, JSON.parse(a), JSON.parse(r)])
      return calls.length === 1 ? first.promise : { ids: p === 'p' ? ['b', 'server'] : ['x'] }
    },
  })
  const loading = cache.load('p')
  assert.equal(loading, cache.load('p'))
  const one = cache.update('p', ['a'], [])
  await tick()
  const two = cache.update('p', ['b'], ['a'])
  await cache.update('other', ['x'], [])
  assert.deepEqual(ids(cache), ['b'])
  first.resolve({ ids: ['a', 'server'] })
  await Promise.all([one, two])
  read.resolve({ ids: ['stale'] })
  await loading
  assert.deepEqual(ids(cache), ['b', 'server'])
  assert.deepEqual(ids(cache, 'other'), ['x'])
  assert.deepEqual(calls, [['p', ['a'], []], ['other', ['x'], []], ['p', ['b'], ['a']]])
})

test('failed RPC persists only pending child changes for replay over a fresh server baseline', async () => {
  const { cache, disk } = tab({
    archivedChildren: () => ({ ids: ['old', 'gone'] }),
    updateArchivedChildren: () => { throw Error('offline') },
  })
  await cache.load('p')
  await assert.rejects(cache.update('p', ['new'], ['gone']), /offline/)
  const next = tab({
    archivedChildren: () => ({ ids: ['remote', 'gone'] }),
    updateArchivedChildren(p, a, r) {
      assert.deepEqual([p, JSON.parse(a), JSON.parse(r)], ['p', ['new'], ['gone']])
      return { ids: ['new', 'remote'] }
    },
  }, disk).cache
  assert.deepEqual(ids(next), ['new', 'old'])
  await next.load('p')
  assert.deepEqual(ids(next), ['new', 'remote'])
})

test('storage sync uses stable immutable snapshots and releases listeners', async () => {
  const writer = tab({ archivedChildren: () => ({ ids: ['b', 'a'] }) })
  const reader = tab({}, writer.disk)
  const { cache } = reader
  let notifications = 0
  const off = cache.subscribe('p', () => notifications++)
  await writer.cache.load('p')
  reader.sync()
  const snapshot = cache.getSnapshot('p')
  assert.deepEqual([...snapshot], ['a', 'b'])
  assert.ok(Object.isFrozen(snapshot))
  reader.sync()
  assert.equal(cache.getSnapshot('p'), snapshot)
  assert.equal(notifications, 1)
  off()
  writer.disk.clear()
  reader.sync()
  assert.deepEqual(ids(cache), [])
  assert.equal(notifications, 1)
  cache.dispose()
  await writer.cache.load('p')
  reader.sync()
  assert.deepEqual(ids(cache), [])
})

test('storage failures do not prevent optimistic changes or authoritative server reconciliation', async () => {
  const disk = { get() { throw Error('blocked') }, set() { throw Error('quota') } }
  const { cache } = tab({ updateArchivedChildren: () => ({ ids: ['extra', 'own'] }) }, disk)
  const pending = cache.update('p', ['own'], [])
  assert.deepEqual(ids(cache), ['own'])
  await pending
  assert.deepEqual(ids(cache), ['extra', 'own'])
})

test('disposal ignores a deferred RPC result after a replacement cache has persisted', async () => {
  const response = deferred()
  const { cache, disk } = tab({ archivedChildren: () => response.promise })
  const load = cache.load('p')
  await tick()
  cache.dispose()
  const replacement = tab({ archivedChildren: () => ({ ids: ['new'] }) }, disk)
  await replacement.cache.load('p')
  response.resolve({ ids: ['old'] })
  await load
  assert.deepEqual(ids(tab({}, disk).cache), ['new'])
})

test('a deferred write acknowledgement preserves a newer storage baseline and local intent', async () => {
  const response = deferred()
  const { cache, disk, sync } = tab({ updateArchivedChildren: () => response.promise })
  const writing = cache.update('p', ['mine'], [])
  await tick()
  const key = [...disk.keys()][0]
  disk.set(key, JSON.stringify({ ids: ['other'], add: [], remove: [] }))
  sync()
  assert.deepEqual(ids(cache), ['mine', 'other'])
  response.resolve({ ids: ['mine', 'outdated'] })
  await writing
  assert.deepEqual(ids(cache), ['mine', 'other'])
  assert.deepEqual(ids(tab({}, disk).cache), ['mine', 'other'])
})
