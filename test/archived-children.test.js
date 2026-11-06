import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { ConfigController } from '../src/config-remote.js'

const rpc = ConfigController.prototype

function isolate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-archived-children-'))
  const before = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  t.after(() => {
    if (before === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = before
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('archive RPC merges per-parent deltas, validates input before writing, and restores children', async t => {
  isolate(t)
  assert.deepEqual(await rpc.archivedChildren('__proto__'), { ids: [] })
  await rpc.updateArchivedChildren('constructor', '["one"]', '[]')
  assert.deepEqual(await rpc.updateArchivedChildren('__proto__', '["two","one","two"]', '[]'), { ids: ['one', 'two'] })
  for (const invalid of ['bad json', 'null', '["one",3]', '[" "]']) {
    await assert.rejects(rpc.updateArchivedChildren('__proto__', '["three"]', invalid))
  }
  await assert.rejects(rpc.updateArchivedChildren('', '["bad"]', '[]'))
  assert.deepEqual(await rpc.archivedChildren('__proto__'), { ids: ['one', 'two'] })
  assert.deepEqual(await rpc.updateArchivedChildren('__proto__', '["two"]', '["two","unknown"]'), { ids: ['one'] })
  await rpc.updateArchivedChildren('__proto__', '[]', '["one"]')
  assert.deepEqual(await rpc.archivedChildren('__proto__'), { ids: [] })
  assert.deepEqual(await rpc.archivedChildren('constructor'), { ids: ['one'] })
})

test('independent desktop processes can archive against the same parent without losing updates', async t => {
  isolate(t)
  const moduleURL = new URL('../src/archived-children.js', import.meta.url).href
  const code = `import { updateArchivedChildren } from ${JSON.stringify(moduleURL)};
    await updateArchivedChildren('shared', JSON.stringify([process.argv[1]]), '[]')`
  const children = ['a', 'b', 'c', 'd']
  await Promise.all(children.map(id => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, id])))
  assert.deepEqual(await rpc.archivedChildren('shared'), { ids: children })
})

test('an unreadable archive is reported and never replaced with empty state', async t => {
  const root = isolate(t)
  const file = path.join(root, 'archived-children.sqlite')
  fs.writeFileSync(file, 'not a database')
  await assert.rejects(rpc.archivedChildren('parent'))
  await assert.rejects(rpc.updateArchivedChildren('parent', '["new"]', '[]'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a database')
})
