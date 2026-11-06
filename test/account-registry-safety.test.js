import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  enrolFirstContact, isAccountPaused, readRegistry, registryFile, resetTouchThrottle,
  setAccountAllowlist, setAccountLabel, setAccountPaused, touchAccount,
} from '../src/account-registry.js'

function fixture(t) {
  const old = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-safety-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  resetTouchThrottle()
  t.after(() => {
    if (old === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = old
    resetTouchThrottle()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return registryFile()
}

const mutations = [
  ['pause', () => setAccountPaused('synthetic-account', true)],
  ['label', () => setAccountLabel('synthetic-account', 'new label')],
  ['allowlist', () => setAccountAllowlist('synthetic-account', ['stranger'])],
  ['enrollment', () => enrolFirstContact('synthetic-account', 'stranger', () => false)],
  ['last seen', () => touchAccount('synthetic-account', () => {}, { throttleMs: 0 })],
]

for (const contents of [
  '{invalid JSON\n', 'null\n', '[]\n', '{"synthetic-account":null}\n',
  '{"synthetic-account":{"allowedSenders":"synthetic-owner"}}\n',
  '{"synthetic-account":{"allowedChats":[null]}}\n',
  '{"synthetic-account":{"paused":"yes"}}\n',
  '{"synthetic-account":{"firstContactEnrolledAt":false}}\n',
]) {
  test(`all registry mutations preserve unreadable data: ${contents.trim()}`, (t) => {
    const file = fixture(t)
    fs.writeFileSync(file, contents)
    for (const [name, mutate] of mutations) {
      assert.throws(mutate, (error) => error.code === 'ACCOUNT_REGISTRY_UNREADABLE' && /restore or repair/.test(error.message), name)
      assert.equal(fs.readFileSync(file, 'utf8'), contents, name)
    }
    assert.equal(isAccountPaused('synthetic-account'), true)
  })
}

test('non-ENOENT read failures block every mutation and delivery', (t) => {
  const file = fixture(t)
  fs.mkdirSync(file)
  for (const [name, mutate] of mutations) {
    assert.throws(mutate, (error) => error.code === 'ACCOUNT_REGISTRY_UNREADABLE', name)
    assert.equal(fs.statSync(file).isDirectory(), true, name)
  }
  assert.equal(isAccountPaused('synthetic-account'), true)
})

test('a missing registry retains first-run behavior and a restored registry can be changed', (t) => {
  const file = fixture(t)
  assert.equal(isAccountPaused('synthetic-account'), false)
  assert.equal(enrolFirstContact('synthetic-account', 'synthetic-owner', () => false), true)
  assert.deepEqual(readRegistry()['synthetic-account'].allowedSenders, ['synthetic-owner'])
  fs.writeFileSync(file, '{broken')
  assert.throws(() => setAccountLabel('synthetic-account', 'new'), /restore or repair/)
  fs.writeFileSync(file, JSON.stringify({ 'synthetic-account': { allowedSenders: ['synthetic-owner'], paused: true } }))
  assert.equal(isAccountPaused('synthetic-account'), true)
  assert.equal(setAccountPaused('synthetic-account', false), true)
  assert.equal(setAccountLabel('synthetic-account', 'restored'), true)
  assert.equal(touchAccount('synthetic-account', () => {}, { throttleMs: 0 }), true)
  assert.equal(isAccountPaused('synthetic-account'), false)
  assert.equal(readRegistry()['synthetic-account'].label, 'restored')
  assert.deepEqual(readRegistry()['synthetic-account'].allowedSenders, ['synthetic-owner'])
})
