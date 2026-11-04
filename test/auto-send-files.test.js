import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sendProducedFiles } from '../src/outbound.js'
import { createChannel } from '../src/channel.js'
import { DEFAULT_MAX_MEDIA_BYTES } from '../src/media/outbound.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-auto-send-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'cwd')
  const outside = path.join(root, 'outside')
  await fs.mkdir(cwd)
  await fs.mkdir(outside)
  const uploads = []
  const warnings = []
  const logs = []
  const transport = {
    cdnBaseUrl: 'https://cdn.invalid',
    async sendMedia(message) { uploads.push(message) },
  }
  return {
    cwd, outside, uploads, warnings, logs,
    params: {
      config: { autoSendFiles: true, maxMediaBytes: 16 },
      transport,
      agentCwd: cwd,
      mediaDirs: [cwd],
      sinceMs: 0,
      alreadySent: [],
      conversationId: 'synthetic-peer',
      contextToken: 'synthetic-token',
      warn: (line) => warnings.push(line),
      fileLog: { info: (line) => logs.push(line) },
    },
  }
}

async function symlink(t, target, alias) {
  try {
    await fs.symlink(target, alias, 'file')
    return true
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
    t.skip('Creating symlinks requires permission on this platform')
    return false
  }
}

test('automatic files reject an out-of-root symlink before transport', async (t) => {
  const f = await fixture(t)
  const target = path.join(f.outside, 'secret.pdf')
  await fs.writeFile(target, 'private')
  if (!await symlink(t, target, path.join(f.cwd, 'report.pdf'))) return
  await sendProducedFiles(f.params)
  assert.deepEqual(f.uploads, [])
  assert.match(f.warnings.join('\n'), /outside the allowed directories/)
  assert.match(f.logs.join('\n'), /refusing produced file/)
})

test('automatic files reject oversized and empty files but send a normal file', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.cwd, 'large.pdf'), Buffer.alloc(17))
  await fs.writeFile(path.join(f.cwd, 'empty.pdf'), '')
  const normal = path.join(f.cwd, 'normal.pdf')
  await fs.writeFile(normal, Buffer.alloc(16))
  await sendProducedFiles(f.params)
  assert.deepEqual(f.uploads, [{
    filePath: await fs.realpath(normal),
    conversationId: 'synthetic-peer',
    contextToken: 'synthetic-token',
    cdnBaseUrl: 'https://cdn.invalid',
    text: '',
    maxBytes: 16,
  }])
  assert.match(f.warnings.join('\n'), /upload limit/)
  assert.match(f.warnings.join('\n'), /file is empty/)
})

test('automatic files enforce the default size limit when no cap is configured', async (t) => {
  const f = await fixture(t)
  delete f.params.config.maxMediaBytes
  const large = path.join(f.cwd, 'large.pdf')
  await fs.writeFile(large, '')
  // Sparse file: exercises the gate without allocating or uploading 100MB.
  await fs.truncate(large, DEFAULT_MAX_MEDIA_BYTES + 1)
  await sendProducedFiles(f.params)
  assert.deepEqual(f.uploads, [])
  assert.match(f.warnings.join('\n'), /upload limit/)
})

test('permitted symlink is sent using its canonical path', async (t) => {
  const f = await fixture(t)
  const target = path.join(f.outside, 'report.pdf')
  await fs.writeFile(target, 'report')
  if (!await symlink(t, target, path.join(f.cwd, 'alias.pdf'))) return
  f.params.mediaDirs.push(f.outside)
  await sendProducedFiles(f.params)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.uploads[0].filePath, await fs.realpath(target))
})

test('automatic sender uses configured allowed directories when roots are omitted', async (t) => {
  const f = await fixture(t)
  const target = path.join(f.outside, 'report.pdf')
  await fs.writeFile(target, 'report')
  if (!await symlink(t, target, path.join(f.cwd, 'alias.pdf'))) return
  delete f.params.mediaDirs
  f.params.config.allowedMediaDirs = [f.outside]
  await sendProducedFiles(f.params)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.uploads[0].filePath, await fs.realpath(target))
})

test('canonical paths already sent explicitly are not sent again through aliases', async (t) => {
  const f = await fixture(t)
  const target = path.join(f.cwd, 'report.pdf')
  await fs.writeFile(target, 'report')
  if (!await symlink(t, target, path.join(f.cwd, 'alias.pdf'))) return
  f.params.alreadySent.push(await fs.realpath(target))
  await sendProducedFiles(f.params)
  assert.deepEqual(f.uploads, [])
})

test('multiple permitted aliases upload the same canonical file only once', async (t) => {
  const f = await fixture(t)
  const target = path.join(f.cwd, 'report.pdf')
  await fs.writeFile(target, 'report')
  if (!await symlink(t, target, path.join(f.cwd, 'alias.pdf'))) return
  await sendProducedFiles(f.params)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.uploads[0].filePath, await fs.realpath(target))
})

test('automatic file sends remain opt-in', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'report')
  delete f.params.config.autoSendFiles
  await sendProducedFiles(f.params)
  assert.deepEqual(f.uploads, [])
})

test('channel forwards maxBytes to the transport without inventing an absent cap', async () => {
  const calls = []
  const channel = createChannel({ sendMedia: async (message) => calls.push(message) })
  await channel.sendMedia({ conversationId: 'peer', filePath: '/synthetic.pdf', maxBytes: 37 })
  await channel.sendMedia({ conversationId: 'peer', filePath: '/synthetic.pdf' })
  assert.equal(calls[0].maxBytes, 37)
  assert.equal(Object.hasOwn(calls[1], 'maxBytes'), false)
})
