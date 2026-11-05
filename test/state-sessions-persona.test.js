import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureSessionsDir } from '../src/state.js'

test('a fresh workspace gets a starter persona + memory note, and neither overwrites an existing file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-state-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    const dir = ensureSessionsDir()
    const persona = path.join(dir, 'AGENTS.md')
    const memory = path.join(dir, 'memory.md')
    assert.ok(fs.existsSync(persona), 'AGENTS.md should be seeded on first run')
    assert.ok(fs.existsSync(memory), 'memory.md should be seeded on first run')
    assert.match(fs.readFileSync(persona, 'utf8'), /大肥鱼/)
    assert.match(fs.readFileSync(memory, 'utf8'), /关于你/)

    fs.writeFileSync(persona, 'CUSTOM PERSONA', 'utf8')
    fs.writeFileSync(memory, 'CUSTOM MEMORY', 'utf8')
    ensureSessionsDir()
    assert.equal(fs.readFileSync(persona, 'utf8'), 'CUSTOM PERSONA', 'an existing persona must never be overwritten')
    assert.equal(fs.readFileSync(memory, 'utf8'), 'CUSTOM MEMORY', 'an existing memory must never be overwritten')
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
