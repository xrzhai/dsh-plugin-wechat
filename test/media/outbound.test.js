import { createSendCommands } from '../../src/message/send-file.js'
import { ILinkTransport } from '../../src/transport/ilink.js'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { deliverOutboundMedia, detectMediaReferences, mediaKindForMime, resolveAllowedPath, splitOutboundMedia } from '../../src/media/outbound.js'

test('ordinary audio and document attachments still reach the file sender', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-outbound-file-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const audio = path.join(dir, 'voice.mp3')
  const document = path.join(dir, 'document.pdf')
  await fs.writeFile(audio, 'synthetic audio')
  await fs.writeFile(document, 'synthetic document')
  const sent = []
  const result = await deliverOutboundMedia({
    text: `请查看 [语音](${audio}) 和 [文件](${document})`,
    allowedDirs: [dir],
    to: 'synthetic-recipient',
    contextToken: 'synthetic-context',
    cdnBaseUrl: 'https://cdn.invalid',
    opts: { baseUrl: 'https://example.invalid', token: 'synthetic-token' },
    send: async (params) => sent.push(params),
  })
  assert.equal(mediaKindForMime('audio/mpeg'), 'file')
  assert.deepEqual(sent.map((params) => params.filePath), [audio, document])
  assert.ok(sent.every((params) => params.to === 'synthetic-recipient'))
  assert.deepEqual(result.sent, [audio, document])
  assert.deepEqual(result.failed, [])
})

async function homeFixture(t) {
  const fixture = await fs.mkdtemp(path.join(os.homedir(), 'dsh-media-home-'))
  t.after(() => fs.rm(fixture, { recursive: true, force: true }))
  return fixture
}

test('media references inside an inline code span stay masked before a non-BMP character', () => {
  const text = '这是用法😀：`![x](a.png)` 结束'

  assert.deepEqual(detectMediaReferences(text), [])
  assert.deepEqual(splitOutboundMedia(text), { text, media: [] })
})

test('a real media reference after non-BMP characters is still detected outside code', () => {
  const text = '😀 `a😀b` ![real](real.png)'
  const media = detectMediaReferences(text)

  assert.equal(media.length, 1)
  assert.equal(media[0].path, 'real.png')
  assert.equal(media[0].index, text.indexOf('![real]'))
  assert.deepEqual(splitOutboundMedia(text), {
    text: '😀 `a😀b` real',
    media,
  })
})

test('ASCII inline-code masking keeps its existing behavior', () => {
  const text = 'plain `![x](a.png)` end and ![real](real.png)'
  const media = detectMediaReferences(text)

  assert.deepEqual(media.map((reference) => reference.path), ['real.png'])
  assert.equal(splitOutboundMedia(text).text, 'plain `![x](a.png)` end and real')
})

test('a rejected fence opener after a blank line does not turn code into an attachment', () => {
  const text = '前文段落\n\n```js`x\n![x](/tmp/a.png)\n```'
  assert.deepEqual(detectMediaReferences(text), [])
})

test('home-relative media paths expand before the allowlist containment check', async (t) => {
  const fixture = await homeFixture(t)
  const file = path.join(fixture, 'shot.png')
  await fs.writeFile(file, 'fixture image')

  const reference = `~/${path.basename(fixture)}/shot.png`
  assert.deepEqual(await resolveAllowedPath(reference, [fixture]), {
    ok: true,
    path: await fs.realpath(file),
    existed: true,
  })
})

test('expanding home does not broaden the allowlist', async (t) => {
  const fixture = await homeFixture(t)
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-media-other-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))

  const reference = `~/${path.basename(fixture)}/shot.png`
  const resolved = await resolveAllowedPath(reference, [outside])
  assert.equal(resolved.ok, false)
  assert.equal(resolved.code, 'path-not-allowed')
})

test('a contained home-relative path that does not exist keeps its missing-file result', async (t) => {
  const fixture = await homeFixture(t)
  const reference = `~/${path.basename(fixture)}/missing.png`

  assert.deepEqual(await resolveAllowedPath(reference, [fixture]), {
    ok: true,
    path: path.join(await fs.realpath(fixture), 'missing.png'),
    existed: false,
  })
})

test('a lone tilde expands to home and still needs an allowing root', async () => {
  const home = await fs.realpath(os.homedir())
  assert.deepEqual(await resolveAllowedPath('~', [home]), {
    ok: true,
    path: home,
    existed: true,
  })
})

test('unrestricted attachments use cwd then state for relative paths and accept other absolute paths', async (t) => {
  const root = await homeFixture(t)
  const cwd = path.join(root, 'work')
  const stateDir = path.join(root, 'state')
  await Promise.all([fs.mkdir(cwd), fs.mkdir(stateDir)])
  const files = [path.join(cwd, 'script.js'), path.join(stateDir, 'image.png'), path.join(root, 'report (final).custom')]
  await Promise.all(files.map((file) => fs.writeFile(file, 'data')))
  const sent = []
  const text = ['[code](script.js)', '![photo](image.png)', files[2], '[web](https://example.org/other.js)', '`secret.txt`'].join('\n')
  const result = await deliverOutboundMedia({ text, cwd, stateDir, send: async ({ filePath }) => sent.push(filePath) })
  assert.deepEqual(sent, await Promise.all(files.map(f => fs.realpath(f))))
  assert.deepEqual(result.failed, [])
  assert.ok(result.text.includes('[web]'))
  assert.ok(result.text.includes('secret.txt'))
  assert.ok(!result.text.includes(files[2]))
  const homePath = '~/' + path.relative(os.homedir(), files[2]).split(path.sep).join('/')
  assert.equal((await resolveAllowedPath(homePath, [], { cwd, stateDir })).path, sent[2])
})

test('an explicit directory list applies to /send and rejects symlink escapes', async (t) => {
  const root = await homeFixture(t)
  const allowed = path.join(root, 'allowed')
  await fs.mkdir(allowed)
  await fs.writeFile(path.join(root, 'secret.js'), 'secret')
  await fs.symlink(root, path.join(allowed, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const send = createSendCommands({ cwd: root, stateDir: root, allowedDirs: [allowed], sendMedia: () => assert.fail('sent outside root') }).send
  assert.match(await send('secret.js'), /outside|does not exist/)
  assert.match(await send(path.join(allowed, 'link', 'secret.js')), /outside/)
})

test('/send waits for a growing file and applies size, existence and regular-file checks', async (t) => {
  const cwd = await homeFixture(t)
  const file = path.join(cwd, 'capture.bin')
  await fs.writeFile(file, '')
  const sent = []
  const { send } = createSendCommands({ cwd, maxBytes: 4, sendMedia: async ({ filePath }) => sent.push(await fs.readFile(filePath, 'utf8')) })
  const pending = send('capture.bin')
  const timer = setTimeout(() => fs.writeFile(file, 'done'), 60)
  t.after(() => clearTimeout(timer))
  assert.match(await pending, /capture.bin/)
  assert.deepEqual(sent, ['done'])
  await fs.appendFile(file, '!')
  assert.match(await send(file), /larger/)
  await fs.truncate(file)
  assert.match(await send(file), /empty/)
  assert.match(await send(cwd), /regular/)
  assert.match(await send('missing'), /does not exist/)
  assert.equal(sent.length, 1)
})

test('actual uploader checks size after pacing, before contacting the CDN', async (t) => {
  const dir = await homeFixture(t)
  const file = path.join(dir, 'growing.txt')
  await fs.writeFile(file, 'a')
  const transport = new ILinkTransport({
    accountId: 'test', baseUrl: 'https://example.invalid', token: 'test',
    pacer: { acquire: async () => { await fs.appendFile(file, 'bc') }, noteFailure() {}, noteSuccess() {} },
  })
  await assert.rejects(transport.sendMedia({ filePath: file, conversationId: 'test', maxBytes: 2 }), /larger/)
  const handle = await fs.open(file, 'r+')
  try { await handle.truncate(100 * 1024 * 1024 + 1) } finally { await handle.close() }
  await assert.rejects(transport.sendMedia({ filePath: file, conversationId: 'test' }), /100MB/)
})
