import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { extractDocumentText, MAX_DOCX_XML_BYTES } from '../../src/media/document.js'

function makeDocx(xml, { method = 0, declaredUncompressedSize = xml.length } = {}) {
  const name = Buffer.from('word/document.xml')
  const data = method === 8 ? zlib.deflateRawSync(xml) : xml
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(xml.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(declaredUncompressedSize, 24)
  central.writeUInt16LE(name.length, 28)

  const centralOffset = local.length + name.length + data.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + name.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)

  return Buffer.concat([local, name, data, central, name, eocd])
}

async function extractFixture(t, archive, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-document-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'fixture.docx')
  await fs.writeFile(file, archive)
  return extractDocumentText(file, options)
}

const SIMPLE_XML = Buffer.from('<w:document><w:p><w:r><w:t>hello</w:t></w:r></w:p><w:p><w:r><w:t>world</w:t></w:r></w:p></w:document>')

for (const method of [0, 8]) {
  test(`docx extraction supports ${method === 0 ? 'stored' : 'deflate'} zip entries`, async (t) => {
    const result = await extractFixture(t, makeDocx(SIMPLE_XML, { method }))
    assert.deepEqual(result, {
      ok: true,
      text: 'hello\nworld',
      kind: 'docx',
      truncated: false,
    })
  })
}

for (const method of [0, 8]) {
  test(`forged ${method === 0 ? 'stored' : 'deflate'} size metadata cannot bypass the output limit`, async (t) => {
    const xml = Buffer.alloc(MAX_DOCX_XML_BYTES + 1, 0x61)
    const result = await extractFixture(t, makeDocx(xml, { method, declaredUncompressedSize: 1 }))

    assert.equal(result.ok, false)
    assert.match(result.reason, /word\/document\.xml exceeds/i)
  })
}

test('docx extraction rejects an entry whose declared output size is over the limit', async (t) => {
  const result = await extractFixture(
    t,
    makeDocx(SIMPLE_XML, { method: 8, declaredUncompressedSize: MAX_DOCX_XML_BYTES + 1 }),
  )

  assert.equal(result.ok, false)
  assert.match(result.reason, /word\/document\.xml exceeds/i)
})
