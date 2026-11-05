import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { detectMediaReferences, resolveAllowedPath, splitOutboundMedia } from '../../src/media/outbound.js'

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
