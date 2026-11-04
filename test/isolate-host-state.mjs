// Loaded before application imports in both the test runner and each worker.
// Never reuse inherited state paths: a developer's login must not become a fixture.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'

const root = mkdtempSync(path.join(os.tmpdir(), `weixin-tests-${process.pid}-`))
process.once('exit', () => rmSync(root, { recursive: true, force: true }))

const home = path.join(root, 'home')
const state = path.join(root, 'state')
for (const dir of [home, state]) mkdirSync(dir, { recursive: true })
for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home
for (const key of ['DSH_WEIXIN_STATE_DIR', 'OPENCLAW_STATE_DIR', 'CLAWDBOT_STATE_DIR']) {
  process.env[key] = state
}
for (const [key, name] of Object.entries({
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  APPDATA: 'appdata',
  LOCALAPPDATA: 'localappdata',
})) {
  const dir = path.join(home, name)
  mkdirSync(dir, { recursive: true })
  process.env[key] = dir
}

// Tests must inject synthetic transports. Fail closed if a regression reaches
// a real HTTP, TCP, TLS, or UDP transport (including Node's built-in fetch).
function denyNetwork() {
  throw new Error('Real network access is disabled in the Weixin test harness; inject a fake transport')
}
globalThis.fetch = async () => denyNetwork()
net.Socket.prototype.connect = denyNetwork
net.connect = denyNetwork
net.createConnection = denyNetwork
tls.connect = denyNetwork
dgram.Socket.prototype.connect = denyNetwork
dgram.Socket.prototype.send = denyNetwork
syncBuiltinESMExports()
