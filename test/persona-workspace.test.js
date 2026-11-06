import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import { configureWeixinStateDir, configFile } from '../src/state.js'
import { WeixinLoginController } from '../src/login-remote.js'

for (const source of ['profile', 'overlay', 'default']) {
  test(`persona editor uses the running workspace from ${source}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-persona-workspace-'))
    const previous = process.env.DSH_WEIXIN_STATE_DIR
    process.env.DSH_WEIXIN_STATE_DIR = root
    configureWeixinStateDir()
    const custom = path.join(root, 'custom-workspace')
    const unused = path.join(root, 'unused-workspace')
    fs.mkdirSync(custom)
    fs.mkdirSync(unused)
    fs.writeFileSync(path.join(custom, 'AGENTS.md'), 'EXISTING PERSONA')
    fs.writeFileSync(path.join(unused, 'AGENTS.md'), 'UNRELATED PERSONA')
    fs.writeFileSync(configFile(), JSON.stringify(source === 'overlay' ? { cwd: custom } : {}))
    const ctx = new Context()
    t.after(async () => {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
      else process.env.DSH_WEIXIN_STATE_DIR = previous
      configureWeixinStateDir()
      fs.rmSync(root, { recursive: true, force: true })
    })
    apply(ctx, { enabled: false, cwd: source === 'profile' ? custom : '', notifyEnabled: false })
    const controller = ctx.get('weixinLoginController')
    assert.ok(controller, 'the real apply path must wire the workspace resolver')
    const expected = path.join(source === 'default' ? path.join(root, 'sessions') : custom, 'AGENTS.md')
    const preview = await controller.promptPreview()
    assert.equal(preview.filePath, expected)
    if (source !== 'default') assert.equal(preview.content, 'EXISTING PERSONA')
    // Saving cwd does not move an already-created bridge; keep editing its
    // workspace until restart rather than silently writing another project.
    fs.writeFileSync(configFile(), JSON.stringify({ cwd: unused }))
    const result = await controller.promptPreview({ action: 'save', content: 'UPDATED PERSONA' })
    assert.equal(result.filePath, expected)
    assert.equal(fs.readFileSync(expected, 'utf8'), 'UPDATED PERSONA')
    assert.equal(fs.readFileSync(path.join(unused, 'AGENTS.md'), 'utf8'), 'UNRELATED PERSONA')
  })
}

test('an editor without a runtime workspace refuses to guess a file to overwrite', async () => {
  await assert.rejects(WeixinLoginController.prototype.promptPreview.call({}, { action: 'save', content: 'wrong' }), /Workspace directory is not available/)
})
