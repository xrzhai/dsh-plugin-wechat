import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Exercise the actual desktop entry and both archive descriptors. The host
// transports JSON strings and wraps successful results in { ok, value }.
test('the catalog mounts after RPC registration, unwraps results and releases its cache', async () => {
  let entry, manifest, archive, cleanupCache
  const mounted = [], disposed = []
  vm.runInNewContext(fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { entry = value } } },
  })
  const require = () => ({})
  require.async = async file => {
    if (file === './client.subagent.js') return { registerSubagentMenu: (_ctx, cache) => { archive = cache } }
    assert.equal(file, './client.subagent-cache.js')
    return { createArchiveCache: r => ({ remote: r, dispose: () => disposed.push('cache') }) }
  }
  const calls = []
  const ctx = {
    remote: {
      $mount: async d => { manifest = d; return () => disposed.push('rpc') },
      weixinConfig: {
        archivedChildren: async parent => ({ ok: true, value: { ids: [parent] } }),
        updateArchivedChildren: async (...args) => { calls.push(args); return { ok: false, error: new Error('offline') } },
      },
    },
    effect(register) { cleanupCache = register() },
    inject(names, setup) {
      assert.ok(manifest)
      mounted.push([...names])
      const catalog = names.includes('sessions')
      const task = catalog ? setup(this) : Promise.resolve()
      task.dispose = async () => { if (catalog) cleanupCache(); disposed.push(catalog ? 'catalog' : 'card') }
      return task
    },
  }
  const dispose = await entry.factory(require).apply(ctx)
  assert.ok(mounted.some(names => ['sessions', 'uiWorkspace', 'sidebarRight', 'remote.weixinConfig', 'slots'].every(n => names.includes(n))))
  assert.deepEqual(await archive.remote.archivedChildren('parent'), { ids: ['parent'] })
  await assert.rejects(archive.remote.updateArchivedChildren('parent', '["child"]', '[]'), /offline/)
  assert.deepEqual(calls, [['parent', '["child"]', '[]']])
  for (const [name, params] of [['archivedChildren', ['parentSessionId']], ['updateArchivedChildren', ['parentSessionId', 'addJson', 'removeJson']]]) {
    const d = manifest.descriptors.find(d => d.namespace === 'weixinConfig' && d.method === name)
    assert.equal(d.service, 'configController')
    assert.deepEqual(Array.from(d.parameters, p => p.wire), params)
  }
  await dispose()
  assert.deepEqual(disposed.sort(), ['cache', 'card', 'catalog', 'rpc'])
})
